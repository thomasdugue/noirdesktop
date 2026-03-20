use serde::Serialize;
use sha2::{Sha256, Digest};
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::Emitter;

use super::manifest::{SyncManifest, SyncedFile, write_manifest};
use super::smb_utils::{build_smb_mount_map, resolve_smb_path};
use super::sync_plan::{SyncPlan, SyncAction};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub phase: String,          // "copy" | "delete" | "manifest"
    pub current: usize,
    pub total: usize,
    pub current_file: String,
    pub bytes_copied: u64,
    pub total_bytes: u64,
    pub action: String,         // "copy" | "overwrite" | "delete"
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncComplete {
    pub success: bool,
    pub files_copied: usize,
    pub files_deleted: usize,
    pub total_bytes_copied: u64,
    pub duration_ms: u64,
    pub errors: Vec<String>,
}


/// Prevent macOS from sleeping during long sync operations.
/// Uses `caffeinate -s` (same mechanism as IOKit power assertions).
/// Returns the child process handle — drop/kill it to release the assertion.
fn prevent_sleep() -> Option<std::process::Child> {
    // -s prevents system sleep (keeps disk + network alive)
    // -i prevents idle sleep
    std::process::Command::new("caffeinate")
        .args(["-s", "-i"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()
}

/// RAII guard — kills caffeinate when dropped (on any return path).
struct SleepGuard(Option<std::process::Child>);
impl Drop for SleepGuard {
    fn drop(&mut self) {
        if let Some(ref mut child) = self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Execute the sync plan: copy files, delete files, update manifest.
/// Runs in a spawned thread. Emits progress events via app_handle.
pub fn execute_sync(
    app_handle: &tauri::AppHandle,
    dest_path: &str,
    plan: &SyncPlan,
    old_manifest: &Option<SyncManifest>,
    folder_structure: &str,
    cancel_flag: Arc<AtomicBool>,
    network_sources: Vec<(String, String)>, // (source_id, hostname) for UUID SMB resolution
) -> Result<SyncComplete, String> {
    let start = Instant::now();
    let mut errors = Vec::new();

    // === DIAGNOSTIC: Log sync plan details ===
    eprintln!("[DAP-SYNC] === SYNC START ===");
    eprintln!("[DAP-SYNC] Destination: {}", dest_path);
    eprintln!("[DAP-SYNC] Plan: {} audio files to copy, {} covers to copy, {} to delete, {} unchanged",
        plan.files_to_copy.len(), plan.covers_to_copy.len(), plan.files_to_delete.len(), plan.files_unchanged);
    eprintln!("[DAP-SYNC] Total copy bytes: {} ({:.1} GB), total cover bytes: {} ({:.1} MB)",
        plan.total_copy_bytes, plan.total_copy_bytes as f64 / 1_073_741_824.0,
        plan.total_cover_bytes, plan.total_cover_bytes as f64 / 1_048_576.0);
    if let Some(first) = plan.files_to_copy.first() {
        eprintln!("[DAP-SYNC] First audio file: {} -> {}", first.source_path, first.dest_relative_path);
    }

    // Prevent macOS from sleeping during sync (keeps disk + network alive).
    // SleepGuard is RAII — caffeinate is killed on any return/drop path.
    let _sleep_guard = SleepGuard(prevent_sleep());
    eprintln!("[DAP-SYNC] Sleep prevention: caffeinate started");
    let mut files_copied: usize = 0;
    let mut files_deleted: usize = 0;
    let mut total_bytes_copied: u64 = 0;
    let mut synced_files: Vec<SyncedFile> = Vec::new();

    // Pre-flight: verify destination is writable before starting
    let preflight_path = Path::new(dest_path).join(".hean-sync-preflight");
    if let Err(e) = std::fs::write(&preflight_path, b"ok") {
        return Ok(SyncComplete {
            success: false,
            files_copied: 0,
            files_deleted: 0,
            total_bytes_copied: 0,
            duration_ms: start.elapsed().as_millis() as u64,
            errors: vec![format!(
                "Destination not writable — check that your device is connected and not read-only: {}",
                e
            )],
        });
    }
    let _ = std::fs::remove_file(&preflight_path);
    eprintln!("[DAP-SYNC] Pre-flight write test: OK — destination is writable");

    // Suppress macOS Apple Double (._*) resource fork files on exFAT/FAT32.
    std::env::set_var("COPYFILE_DISABLE", "1");

    // Disable Spotlight indexing on the destination volume.
    // Spotlight creates ._* files asynchronously when it indexes new files,
    // which corrupts exFAT directory entries during bulk writes.
    let _ = std::process::Command::new("mdutil")
        .args(["-i", "off", dest_path])
        .output();
    eprintln!("[DAP-SYNC] Spotlight indexing disabled on {}", dest_path);

    // --- Phase 0: Clean up existing ._* Apple Double files ---
    let (ad_count, ad_bytes) = cleanup_apple_double(dest_path);
    if ad_count > 0 {
        eprintln!(
            "[DAP-SYNC] Phase 0: Cleaned up {} Apple Double (._*) files ({:.1} KB)",
            ad_count,
            ad_bytes as f64 / 1024.0
        );
    }

    // Build SMB mount map once for the entire sync operation,
    // extended with UUID mappings from NetworkSources
    let mut smb_map = build_smb_mount_map();
    if !network_sources.is_empty() {
        use super::smb_utils::extend_mount_map_with_sources;
        extend_mount_map_with_sources(&mut smb_map, &network_sources);
    }
    eprintln!("[DAP-SYNC] SMB mount map: {} entries {:?}", smb_map.len(),
        smb_map.keys().collect::<Vec<_>>());

    let total_copy = plan.files_to_copy.len();
    let total_delete = plan.files_to_delete.len();

    // --- Phase 1: Delete files ---
    eprintln!("[DAP-SYNC] Phase 1: Deleting {} files", total_delete);
    for (i, action) in plan.files_to_delete.iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            return Ok(SyncComplete {
                success: false,
                files_copied,
                files_deleted,
                total_bytes_copied,
                duration_ms: start.elapsed().as_millis() as u64,
                errors: vec!["Sync cancelled by user".into()],
            });
        }

        let full_dest = format!("{}/{}", dest_path, action.dest_relative_path);

        let _ = app_handle.emit("dap_sync_progress", SyncProgress {
            phase: "delete".into(),
            current: i + 1,
            total: total_delete,
            current_file: action.dest_relative_path.clone(),
            bytes_copied: 0,
            total_bytes: plan.total_delete_bytes,
            action: "delete".into(),
        });

        match delete_file_safely(&full_dest) {
            Ok(()) => files_deleted += 1,
            Err(e) => errors.push(format!("Delete failed: {} — {}", action.dest_relative_path, e)),
        }
    }

    // --- Pre-Phase 2: Aggressive Apple Double cleanup ---
    // macOS Finder/Spotlight creates ._* files asynchronously for every dir/file operation.
    // On exFAT, these fill up directory entry tables and cause EINVAL on subsequent mkdir.
    // Clean them ALL before we start creating directories.
    let (pre_ad, _) = cleanup_apple_double(dest_path);
    if pre_ad > 0 {
        eprintln!("[DAP-SYNC] Pre-copy cleanup: removed {} ._* files", pre_ad);
    }

    // --- Phase 2: Copy audio files ---
    eprintln!("[DAP-SYNC] Phase 2: Copying {} audio files ({:.1} GB)", total_copy, plan.total_copy_bytes as f64 / 1_073_741_824.0);
    let mut bytes_so_far: u64 = 0;
    let mut consecutive_io_errors: u32 = 0;
    const MAX_CONSECUTIVE_IO_ERRORS: u32 = 10;
    let phase2_start = Instant::now();

    // Track corrupted directories — skip all remaining files in a corrupted dir
    // to prevent cascade corruption of the entire exFAT volume.
    let mut corrupted_dirs: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (i, action) in plan.files_to_copy.iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            let _ = write_partial_manifest(dest_path, old_manifest, &synced_files, &plan.files_to_delete, folder_structure);
            return Ok(SyncComplete {
                success: false,
                files_copied,
                files_deleted,
                total_bytes_copied,
                duration_ms: start.elapsed().as_millis() as u64,
                errors: vec!["Sync cancelled by user".into()],
            });
        }

        let full_dest = format!("{}/{}", dest_path, action.dest_relative_path);

        // Skip files in corrupted directories — writing more files would
        // make the corruption worse and potentially destroy the entire volume.
        if let Some(pos) = action.dest_relative_path.rfind('/') {
            let dir = &action.dest_relative_path[..pos];
            if corrupted_dirs.contains(dir) {
                errors.push(format!("{} — Skipped (directory corrupted by previous write failure)", action.dest_relative_path));
                continue;
            }
        }

        let _ = app_handle.emit("dap_sync_progress", SyncProgress {
            phase: "copy".into(),
            current: i + 1,
            total: total_copy,
            current_file: action.dest_relative_path.clone(),
            bytes_copied: bytes_so_far,
            total_bytes: plan.total_copy_bytes,
            action: action.action.clone(),
        });

        // Resolve SMB URLs to local filesystem paths
        let resolved_source = resolve_smb_path(&action.source_path, &smb_map);

        // Pre-check: verify source file exists before attempting copy
        if !Path::new(&resolved_source).exists() {
            let msg = if action.source_path.starts_with("smb://") {
                format!("{} — Source file not found — SMB path could not be resolved ({})",
                    action.dest_relative_path, resolved_source)
            } else {
                format!("{} — Source file not found — file may have been moved or deleted",
                    action.dest_relative_path)
            };
            errors.push(msg.clone());
            eprintln!("[DAP-SYNC] PRE-CHECK FAIL: {} (original: {})", msg, action.source_path);
            continue;
        }

        match copy_file_verified(&resolved_source, &full_dest) {
            Ok(bytes) => {
                files_copied += 1;
                total_bytes_copied += bytes;
                bytes_so_far += bytes;
                consecutive_io_errors = 0;

                // Progress log every 50 files
                if files_copied % 50 == 0 {
                    let elapsed = phase2_start.elapsed().as_secs();
                    let rate_mb = if elapsed > 0 { total_bytes_copied / 1_048_576 / elapsed } else { 0 };
                    eprintln!("[DAP-SYNC] Progress: {}/{} files copied ({:.1} GB, {}s, ~{} MB/s)",
                        files_copied, total_copy, total_bytes_copied as f64 / 1_073_741_824.0, elapsed, rate_mb);
                }

                // Clean ._* Apple Double files every 10 files.
                // macOS Spotlight/Finder creates these asynchronously during bulk writes,
                // and they fill up exFAT directory entries causing EINVAL on subsequent writes.
                if files_copied % 10 == 0 {
                    let (ad, _) = cleanup_apple_double(dest_path);
                    if ad > 0 {
                        eprintln!("[DAP-SYNC] Mid-sync cleanup: removed {} ._* files", ad);
                    }
                }

                // Compute quick hash for manifest
                let hash = compute_quick_hash(&full_dest).unwrap_or_else(|_| "error".into());
                synced_files.push(SyncedFile {
                    source_path: action.source_path.clone(),
                    dest_relative_path: action.dest_relative_path.clone(),
                    size_bytes: bytes,
                    modified_at: get_file_modified_at(&resolved_source),
                    quick_hash: hash,
                });
            }
            Err(e) => {
                eprintln!("[DAP-SYNC] Copy failed (attempt 1): {} — {}", action.dest_relative_path, e);
                eprintln!("[DAP-SYNC]   source: {} → {}", action.source_path, resolved_source);

                // Classify the PRIMARY error to decide retry strategy
                let is_dest_error = e.contains("Failed to create dest")
                    || e.contains("Failed to create dirs");
                let is_io_error = e.contains("os error 5")    // EIO — hardware I/O
                    || e.contains("os error 30")   // EROFS — read-only
                    || e.contains("os error 28");  // ENOSPC — no space

                if is_dest_error && !is_io_error {
                    // Destination-specific error (EINVAL, etc.)
                    // Clean Apple Double files that may have caused the EINVAL, then retry ONCE
                    let (ad, _) = cleanup_apple_double(dest_path);
                    if ad > 0 {
                        eprintln!("[DAP-SYNC] Post-error cleanup: removed {} ._* files, retrying", ad);
                        // Retry after cleanup
                        match copy_file_verified(&resolved_source, &full_dest) {
                            Ok(bytes) => {
                                files_copied += 1;
                                total_bytes_copied += bytes;
                                bytes_so_far += bytes;
                                consecutive_io_errors = 0;
                                let hash = compute_quick_hash(&full_dest).unwrap_or_else(|_| "error".into());
                                synced_files.push(SyncedFile {
                                    source_path: action.source_path.clone(),
                                    dest_relative_path: action.dest_relative_path.clone(),
                                    size_bytes: bytes,
                                    modified_at: get_file_modified_at(&resolved_source),
                                    quick_hash: hash,
                                });
                                continue;
                            }
                            Err(_) => {} // Fall through to error reporting below
                        }
                    }
                    let cause = classify_copy_error(&e);
                    errors.push(format!("{} — {}", action.dest_relative_path, cause));
                    eprintln!("[DAP-SYNC] DEST ERROR (no retry): {}", cause);

                    // Mark this directory as corrupted — skip all remaining files
                    // in this directory to prevent cascade corruption.
                    if e.contains("os error 22") {
                        if let Some(pos) = action.dest_relative_path.rfind('/') {
                            let dir = action.dest_relative_path[..pos].to_string();
                            eprintln!("[DAP-SYNC] DIRECTORY CORRUPTED — skipping remaining files in: {}", dir);
                            corrupted_dirs.insert(dir);
                        }
                    }
                } else {
                    // Transient error — retry once after short delay
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    match copy_file_verified(&resolved_source, &full_dest) {
                        Ok(bytes) => {
                            files_copied += 1;
                            total_bytes_copied += bytes;
                            bytes_so_far += bytes;
                            consecutive_io_errors = 0;
                            let hash = compute_quick_hash(&full_dest).unwrap_or_else(|_| "error".into());
                            synced_files.push(SyncedFile {
                                source_path: action.source_path.clone(),
                                dest_relative_path: action.dest_relative_path.clone(),
                                size_bytes: bytes,
                                modified_at: get_file_modified_at(&resolved_source),
                                quick_hash: hash,
                            });
                        }
                        Err(e2) => {
                            // Use PRIMARY error for classification (more accurate)
                            let cause = classify_copy_error(&e);
                            errors.push(format!("{} — {}", action.dest_relative_path, cause));
                            eprintln!("[DAP-SYNC] Retry failed: {} — {} (retry: {})",
                                action.dest_relative_path, cause, e2);
                        }
                    }
                }

                if is_io_error {
                    consecutive_io_errors += 1;
                    if consecutive_io_errors >= MAX_CONSECUTIVE_IO_ERRORS {
                        errors.push(format!(
                            "Aborting: {} consecutive I/O errors — destination may be disconnected or read-only",
                            MAX_CONSECUTIVE_IO_ERRORS
                        ));
                        let _ = write_partial_manifest(dest_path, old_manifest, &synced_files, &plan.files_to_delete, folder_structure);
                        break;
                    }
                } else {
                    consecutive_io_errors = 0;
                }
            }
        }
    }

    eprintln!("[DAP-SYNC] Phase 2 complete: {}/{} audio files copied ({:.1} GB) in {:.1}s, {} errors",
        files_copied, total_copy, total_bytes_copied as f64 / 1_073_741_824.0,
        phase2_start.elapsed().as_secs_f64(), errors.len());

    // --- Phase 2b: Copy cover art ---
    // CRITICAL: Covers are copied LAST in each directory because the macOS
    // exFAT driver corrupts cluster allocations of earlier files when many
    // files are written to the same directory. By writing covers last, they
    // are the most recent allocation and least likely to be corrupted.
    // We also verify content with MD5 hash and retry if corrupted.
    let total_covers = plan.covers_to_copy.len();
    eprintln!("[DAP-SYNC] Phase 2b: Copying {} cover files (with hash verification)", total_covers);
    let mut covers_copied: usize = 0;
    let mut covers_corrupted: usize = 0;

    // Clean Apple Double files before cover phase — reduce directory entry pressure
    let (pre_cover_ad, _) = cleanup_apple_double(dest_path);
    if pre_cover_ad > 0 {
        eprintln!("[DAP-SYNC] Pre-cover cleanup: removed {} ._* files", pre_cover_ad);
    }

    for (i, cover) in plan.covers_to_copy.iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            let _ = write_partial_manifest(dest_path, old_manifest, &synced_files, &plan.files_to_delete, folder_structure);
            return Ok(SyncComplete {
                success: false,
                files_copied,
                files_deleted,
                total_bytes_copied,
                duration_ms: start.elapsed().as_millis() as u64,
                errors: vec!["Sync cancelled by user".into()],
            });
        }

        let full_dest = format!("{}/{}", dest_path, cover.dest_relative_path);

        let _ = app_handle.emit("dap_sync_progress", SyncProgress {
            phase: "covers".into(),
            current: i + 1,
            total: total_covers,
            current_file: cover.dest_relative_path.clone(),
            bytes_copied: total_bytes_copied,
            total_bytes: plan.total_copy_bytes + plan.total_cover_bytes,
            action: "copy".into(),
        });

        // Compute source hash BEFORE copy for verification
        let source_md5 = compute_md5_hash(&cover.source_cover_path);

        match copy_file_verified(&cover.source_cover_path, &full_dest) {
            Ok(bytes) => {
                // Verify content integrity with MD5 hash (not just size)
                // The macOS exFAT driver can corrupt file data while reporting
                // correct sizes — only a content hash catches this.
                let dest_md5 = compute_md5_hash(&full_dest);

                if source_md5 == dest_md5 && source_md5 != "error" {
                    covers_copied += 1;
                    total_bytes_copied += bytes;
                    let hash = compute_quick_hash(&full_dest).unwrap_or_else(|_| "error".into());
                    synced_files.push(SyncedFile {
                        source_path: cover.source_cover_path.clone(),
                        dest_relative_path: cover.dest_relative_path.clone(),
                        size_bytes: bytes,
                        modified_at: get_file_modified_at(&cover.source_cover_path),
                        quick_hash: hash,
                    });
                } else {
                    // Content corrupted — retry once
                    eprintln!("[DAP-SYNC] Cover hash mismatch, retrying: {} (src={} dst={})",
                        cover.dest_relative_path, source_md5, dest_md5);
                    // Delete corrupted file and Apple Double, then retry
                    let _ = std::fs::remove_file(&full_dest);
                    let (ad, _) = cleanup_apple_double(dest_path);
                    if ad > 0 {
                        eprintln!("[DAP-SYNC] Cover retry cleanup: removed {} ._* files", ad);
                    }
                    match copy_file_verified(&cover.source_cover_path, &full_dest) {
                        Ok(bytes2) => {
                            let retry_md5 = compute_md5_hash(&full_dest);
                            if source_md5 == retry_md5 {
                                covers_copied += 1;
                                total_bytes_copied += bytes2;
                                let hash = compute_quick_hash(&full_dest).unwrap_or_else(|_| "error".into());
                                synced_files.push(SyncedFile {
                                    source_path: cover.source_cover_path.clone(),
                                    dest_relative_path: cover.dest_relative_path.clone(),
                                    size_bytes: bytes2,
                                    modified_at: get_file_modified_at(&cover.source_cover_path),
                                    quick_hash: hash,
                                });
                                eprintln!("[DAP-SYNC] Cover retry succeeded: {}", cover.dest_relative_path);
                            } else {
                                covers_corrupted += 1;
                                eprintln!("[DAP-SYNC] Cover STILL corrupted after retry: {} — exFAT driver issue",
                                    cover.dest_relative_path);
                            }
                        }
                        Err(e2) => {
                            covers_corrupted += 1;
                            eprintln!("[DAP-SYNC] Cover retry failed: {} — {}", cover.dest_relative_path, e2);
                        }
                    }
                }
            }
            Err(e) => {
                // Non-fatal: cover copy failure shouldn't abort sync
                eprintln!("[DAP-SYNC] Cover copy failed (non-fatal): {} — {}", cover.dest_relative_path, e);
            }
        }
    }

    if covers_copied > 0 || covers_corrupted > 0 {
        eprintln!("[DAP-SYNC] Covers: {} copied OK, {} corrupted (exFAT driver issue)", covers_copied, covers_corrupted);
    }

    // --- Phase 3: Write manifest ---
    let _ = app_handle.emit("dap_sync_progress", SyncProgress {
        phase: "manifest".into(),
        current: 1,
        total: 1,
        current_file: ".hean-sync.json".into(),
        bytes_copied: total_bytes_copied,
        total_bytes: plan.total_copy_bytes,
        action: "manifest".into(),
    });

    let new_manifest = build_updated_manifest(dest_path, old_manifest, &synced_files, &plan.files_to_delete, folder_structure);
    eprintln!("[DAP-SYNC] Writing manifest: {} files total in manifest", new_manifest.files.len());
    write_manifest(dest_path, &new_manifest)?;

    // --- Phase final: Clean up ._* files created during sync by macOS ---
    let (ad_final, _) = cleanup_apple_double(dest_path);
    if ad_final > 0 {
        eprintln!(
            "[DAP-SYNC] Final cleanup: removed {} Apple Double (._*) files",
            ad_final
        );
    }

    let duration_ms = start.elapsed().as_millis() as u64;
    let success = errors.is_empty();
    eprintln!("[DAP-SYNC] === SYNC {} === {}/{} files copied, {}/{} covers, {} deleted, {:.1} GB in {:.1}s, {} errors",
        if success { "COMPLETE" } else { "FINISHED WITH ERRORS" },
        files_copied, total_copy, covers_copied, total_covers, files_deleted,
        total_bytes_copied as f64 / 1_073_741_824.0, duration_ms as f64 / 1000.0, errors.len());

    let complete = SyncComplete {
        success,
        files_copied,
        files_deleted,
        total_bytes_copied,
        duration_ms,
        errors,
    };

    let _ = app_handle.emit("dap_sync_complete", complete.clone());

    Ok(complete)
}

/// Copy a file with data-only transfer (no xattrs), fsync, and size verification.
///
/// CRITICAL DESIGN DECISIONS:
/// 1. Manual io::copy instead of std::fs::copy — macOS's copyfile(3) tries to copy
///    extended attributes (xattrs) from source. SMB-mounted NAS files have xattrs that
///    exFAT doesn't support → ENOATTR (os error 93). Data-only copy avoids this.
/// 2. fsync after write — flushes data from OS page cache to physical device.
///    Without this, macOS keeps data in RAM and sleep/disconnect/eject causes
///    exFAT filesystem corruption.
/// 3. Size verification — catches partial writes from USB controller issues.
pub fn copy_file_verified(source: &str, dest: &str) -> Result<u64, String> {
    let source_path = Path::new(source);
    let dest_path = Path::new(dest);

    // Create parent directories
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create dirs for {}: {}", dest, e))?;
    }

    // Data-only copy: open source, create dest, stream bytes (no xattrs/metadata).
    let mut src_file = std::fs::File::open(source_path)
        .map_err(|e| format!("Failed to open source {}: {}", source, e))?;
    let mut dst_file = std::fs::File::create(dest_path)
        .map_err(|e| format!("Failed to create dest {}: {}", dest, e))?;

    let bytes = std::io::copy(&mut src_file, &mut dst_file)
        .map_err(|e| format!("Failed to copy {} -> {}: {}", source, dest, e))?;

    // fsync: flush data to physical device before proceeding
    dst_file.sync_all()
        .map_err(|e| format!("Failed to fsync {}: {}", dest, e))?;

    // Immediately remove Apple Double file that macOS creates for each written file.
    // On exFAT, these ._* files fill up directory entry tables and cause EINVAL
    // when ~60+ entries accumulate in a single directory.
    if let Some(parent) = dest_path.parent() {
        if let Some(filename) = dest_path.file_name() {
            let ad_file = parent.join(format!("._{}", filename.to_string_lossy()));
            let _ = std::fs::remove_file(&ad_file);
        }
    }

    // Verify size
    let source_size = src_file.metadata().map(|m| m.len()).unwrap_or(0);

    if bytes != source_size {
        return Err(format!(
            "Size mismatch after copy: source={} dest={} ({} vs {} bytes)",
            source, dest, source_size, bytes
        ));
    }

    Ok(bytes)
}

/// Classify a copy error into a human-readable cause for the sync report.
fn classify_copy_error(err: &str) -> String {
    // IMPORTANT: Check multi-digit error codes BEFORE single-digit ones to avoid
    // substring false matches (e.g. "os error 22" contains "os error 2",
    // "os error 28" contains "os error 2", "os error 30" contains "os error 3").
    if err.contains("os error 93") {
        "Extended attributes not supported on destination filesystem".into()
    } else if err.contains("os error 30") {
        "Destination is read-only".into()
    } else if err.contains("os error 28") {
        "No space left on destination".into()
    } else if err.contains("os error 22") {
        "Invalid filename or directory on destination (exFAT/FAT32 limitation)".into()
    } else if err.contains("os error 5") {
        "I/O error — possible hardware issue with destination".into()
    } else if err.contains("os error 2") {
        "Source file not found — file may have been moved or NAS disconnected".into()
    } else if err.contains("os error 1") {
        "Permission denied — file or directory is protected".into()
    } else if err.contains("Size mismatch") {
        "Partial write — file was not fully copied (possible USB disconnect)".into()
    } else {
        format!("Unexpected error: {}", err)
    }
}

/// Delete a file and clean up empty parent directories.
pub fn delete_file_safely(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if p.exists() {
        std::fs::remove_file(p).map_err(|e| format!("Failed to delete {}: {}", path, e))?;

        // Clean up empty parent directories
        let mut parent = p.parent();
        while let Some(dir) = parent {
            // Stop at /Volumes/XXX level (don't delete the volume root)
            if dir.components().count() <= 3 {
                break;
            }
            if dir.read_dir().map(|mut d| d.next().is_none()).unwrap_or(false) {
                let _ = std::fs::remove_dir(dir);
                parent = dir.parent();
            } else {
                break;
            }
        }
    }
    Ok(())
}

/// Compute full SHA-256 hash of a file for content integrity verification.
/// Used for cover art verification — covers are small (~50-100KB) so full hash is fast.
/// Returns "error" on any I/O failure (non-fatal, caller decides retry strategy).
pub fn compute_md5_hash(path: &str) -> String {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return "error".into(),
    };
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 65536];
    loop {
        match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => hasher.update(&buf[..n]),
            Err(_) => return "error".into(),
        }
    }
    format!("{:x}", hasher.finalize())
}

/// Compute SHA-256 of first 4KB + last 4KB of a file (quick hash for change detection).
pub fn compute_quick_hash(path: &str) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let file_size = file.metadata().map_err(|e| e.to_string())?.len();

    let mut hasher = Sha256::new();

    // Read first 4KB
    let mut buf = vec![0u8; 4096.min(file_size as usize)];
    file.read_exact(&mut buf).map_err(|e| e.to_string())?;
    hasher.update(&buf);

    // Read last 4KB (if file is large enough)
    if file_size > 4096 {
        use std::io::Seek;
        let last_offset = if file_size > 8192 { file_size - 4096 } else { 4096 };
        file.seek(std::io::SeekFrom::Start(last_offset)).map_err(|e| e.to_string())?;
        let mut buf2 = vec![0u8; (file_size - last_offset) as usize];
        file.read_exact(&mut buf2).map_err(|e| e.to_string())?;
        hasher.update(&buf2);
    }

    let hash = hasher.finalize();
    Ok(format!("{:x}", hash))
}

/// Build the updated manifest after sync.
/// Uses dest_relative_path as the key for deduplication (not source_path),
/// matching the sync plan comparison strategy.
fn build_updated_manifest(
    dest_path: &str,
    old_manifest: &Option<SyncManifest>,
    new_files: &[SyncedFile],
    deleted_actions: &[SyncAction],
    folder_structure: &str,
) -> SyncManifest {
    let deleted_dest_paths: std::collections::HashSet<String> =
        deleted_actions.iter().map(|a| a.dest_relative_path.clone()).collect();
    let new_dest_paths: std::collections::HashSet<String> =
        new_files.iter().map(|f| f.dest_relative_path.clone()).collect();

    let mut files: Vec<SyncedFile> = Vec::new();

    // Keep unchanged files from old manifest (not deleted, not replaced by new copy)
    if let Some(old) = old_manifest {
        for f in &old.files {
            if !deleted_dest_paths.contains(&f.dest_relative_path) && !new_dest_paths.contains(&f.dest_relative_path) {
                files.push(f.clone());
            }
        }
    }

    // Add newly synced files
    files.extend(new_files.iter().cloned());

    let now = chrono_now_iso();

    SyncManifest {
        hean_version: "1.0.0".into(),
        last_sync: now,
        destination_path: dest_path.into(),
        folder_structure: folder_structure.into(),
        files,
    }
}

fn write_partial_manifest(
    dest_path: &str,
    old_manifest: &Option<SyncManifest>,
    new_files: &[SyncedFile],
    deleted_actions: &[SyncAction],
    folder_structure: &str,
) -> Result<(), String> {
    let manifest = build_updated_manifest(dest_path, old_manifest, new_files, deleted_actions, folder_structure);
    write_manifest(dest_path, &manifest)
}

fn chrono_now_iso() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Simple ISO 8601 without chrono crate
    let secs_per_day = 86400u64;
    let days = now / secs_per_day;
    let time_of_day = now % secs_per_day;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Approximate date calculation (good enough for manifest)
    let mut y = 1970i64;
    let mut remaining_days = days as i64;
    loop {
        let days_in_year = if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) { 366 } else { 365 };
        if remaining_days < days_in_year { break; }
        remaining_days -= days_in_year;
        y += 1;
    }
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let month_days = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut m = 0usize;
    for (i, &md) in month_days.iter().enumerate() {
        if remaining_days < md as i64 { m = i; break; }
        remaining_days -= md as i64;
    }
    let d = remaining_days + 1;

    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m + 1, d, hours, minutes, seconds)
}

fn get_file_modified_at(path: &str) -> String {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| {
            let secs = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
            // Reuse the same simple formatter
            let secs_per_day = 86400u64;
            let days = secs / secs_per_day;
            let time_of_day = secs % secs_per_day;
            let hours = time_of_day / 3600;
            let minutes = (time_of_day % 3600) / 60;
            let seconds_val = time_of_day % 60;
            let mut y = 1970i64;
            let mut remaining_days = days as i64;
            loop {
                let days_in_year = if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) { 366 } else { 365 };
                if remaining_days < days_in_year { break; }
                remaining_days -= days_in_year;
                y += 1;
            }
            let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
            let month_days = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
            let mut m = 0usize;
            for (i, &md) in month_days.iter().enumerate() {
                if remaining_days < md as i64 { m = i; break; }
                remaining_days -= md as i64;
            }
            let d = remaining_days + 1;
            format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m + 1, d, hours, minutes, seconds_val)
        })
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

/// Recursively scan and delete all ._* Apple Double resource fork files.
/// Returns (files_deleted, bytes_freed).
fn cleanup_apple_double(dest_path: &str) -> (usize, u64) {
    let mut count = 0usize;
    let mut bytes = 0u64;
    fn walk(dir: &Path, count: &mut usize, bytes: &mut u64) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, count, bytes);
            } else {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("._") {
                    if let Ok(meta) = entry.metadata() {
                        *bytes += meta.len();
                    }
                    let _ = std::fs::remove_file(&path);
                    *count += 1;
                }
            }
        }
    }
    walk(Path::new(dest_path), &mut count, &mut bytes);
    (count, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn test_resolve_smb_path_passthrough() {
        let map = HashMap::new();
        assert_eq!(
            resolve_smb_path("/Volumes/music/file.flac", &map),
            "/Volumes/music/file.flac"
        );
    }

    #[test]
    fn test_resolve_smb_path_with_map() {
        let mut map = HashMap::new();
        map.insert(
            "smb://4215ec2a-b5d2-4e93-8bbf-1f697590c73d/music".to_string(),
            "/Volumes/music".to_string(),
        );
        assert_eq!(
            resolve_smb_path(
                "smb://4215ec2a-b5d2-4e93-8bbf-1f697590c73d/music/LOSSLESS/Prince/track.flac",
                &map
            ),
            "/Volumes/music/LOSSLESS/Prince/track.flac"
        );
    }

    #[test]
    fn test_resolve_smb_path_fallback() {
        let map = HashMap::new(); // empty map, no matching mount
        assert_eq!(
            resolve_smb_path(
                "smb://unknown-host/myshare/path/to/file.flac",
                &map
            ),
            "/Volumes/myshare/path/to/file.flac"
        );
    }

    #[test]
    fn test_copy_file_verified() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.txt");
        let dest = dir.path().join("subdir/dest.txt");

        std::fs::write(&source, "hello world test content for copy verification").unwrap();

        let bytes = copy_file_verified(
            source.to_str().unwrap(),
            dest.to_str().unwrap(),
        ).unwrap();

        assert!(bytes > 0);
        assert!(dest.exists());
        assert_eq!(
            std::fs::read_to_string(&dest).unwrap(),
            "hello world test content for copy verification"
        );
    }

    #[test]
    fn test_quick_hash_consistency() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("test.bin");

        // Create a file > 8KB
        let data: Vec<u8> = (0..16384).map(|i| (i % 256) as u8).collect();
        std::fs::write(&file, &data).unwrap();

        let hash1 = compute_quick_hash(file.to_str().unwrap()).unwrap();
        let hash2 = compute_quick_hash(file.to_str().unwrap()).unwrap();
        assert_eq!(hash1, hash2);
        assert!(!hash1.is_empty());
    }

    #[test]
    fn test_delete_file_safely() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a/b/c");
        std::fs::create_dir_all(&nested).unwrap();
        let file = nested.join("test.txt");
        std::fs::write(&file, "test").unwrap();

        delete_file_safely(file.to_str().unwrap()).unwrap();
        assert!(!file.exists());
        // Parent dirs should be cleaned up
        assert!(!nested.exists());
    }

    #[test]
    fn test_chrono_now_iso() {
        let now = chrono_now_iso();
        assert!(now.contains("T"));
        assert!(now.ends_with("Z"));
        // Should be in 2026 range
        assert!(now.starts_with("202"));
    }
}
