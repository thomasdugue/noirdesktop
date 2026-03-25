use serde::Serialize;
use sha2::{Sha256, Digest};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::Emitter;

use super::manifest::{SyncManifest, SyncedFile, write_manifest};
use super::smb_utils::{build_smb_mount_map, resolve_smb_path};
use super::sync_plan::{SyncPlan, SyncAction};

/// Quick integrity hash: SHA-256 of first 64KB + last 64KB of a file.
/// Detects cluster misallocation (exFAT driver bug) without reading the entire file.
/// Returns hex string or "error".
fn quick_integrity_hash(path: &Path) -> String {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return "open_error".into(),
    };
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let chunk = 64 * 1024u64;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; chunk as usize];

    // Read first 64KB
    match file.read(&mut buf) {
        Ok(n) => hasher.update(&buf[..n]),
        Err(_) => return "read_error".into(),
    }

    // Read last 64KB (if file is large enough)
    if size > chunk * 2 {
        use std::io::Seek;
        if file.seek(std::io::SeekFrom::End(-(chunk as i64))).is_ok() {
            match file.read(&mut buf) {
                Ok(n) => hasher.update(&buf[..n]),
                Err(_) => return "read_error".into(),
            }
        }
    }

    format!("{:x}", hasher.finalize())
}

/// Check if a file starts with valid audio magic bytes.
/// FLAC = "fLaC" (664c6143), MP3 = "ID3" (494433) or sync (fff).
fn check_audio_magic(path: &Path) -> (bool, String) {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => return (false, format!("open_error: {}", e)),
    };
    let mut magic = [0u8; 4];
    match file.read_exact(&mut magic) {
        Ok(()) => {},
        Err(e) => return (false, format!("read_error: {}", e)),
    }
    let hex = format!("{:02x}{:02x}{:02x}{:02x}", magic[0], magic[1], magic[2], magic[3]);
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let valid = match ext {
        "flac" => &magic == b"fLaC",
        "mp3" => (magic[0] == 0x49 && magic[1] == 0x44 && magic[2] == 0x33) || (magic[0] == 0xff && magic[1] >= 0xe0),
        "wav" => &magic == b"RIFF",
        "aiff" | "aif" => &magic == b"FORM",
        "m4a" => magic[4..8] == *b"ftyp" || true, // M4A has various headers
        _ => true, // Unknown format, assume OK
    };
    (valid, hex)
}

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

    // --- Phase 0b: Clean up leftover .hean-tmp files from interrupted syncs ---
    let (tmp_count, tmp_bytes) = cleanup_hean_tmp(dest_path);
    if tmp_count > 0 {
        eprintln!(
            "[DAP-SYNC] Phase 0b: Cleaned up {} leftover .hean-tmp files ({:.1} KB) from interrupted sync",
            tmp_count, tmp_bytes as f64 / 1024.0
        );
    }

    // --- Phase 0b2: Clean up old ghost trash dirs from previous syncs ---
    // Previous syncs create .hean_trash_{pid} dirs for ghost recovery.
    // Clean them up if they're not from this process.
    let my_trash_name = format!(".hean_trash_{}", std::process::id());
    if let Ok(entries) = std::fs::read_dir(dest_path) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(".hean_trash_") && name != my_trash_name {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    // Also try to clean old .Trashes/hean_cleanup if it exists
    let old_trash = Path::new(dest_path).join(".Trashes").join("hean_cleanup");
    if old_trash.exists() {
        let _ = std::fs::remove_dir_all(&old_trash);
    }

    // --- Phase 0c: Detect and RECOVER ghost directories from previous syncs ---
    // Ghost dirs = stat() succeeds but read_dir() returns EINVAL. They block all
    // future create_dir_all attempts through that path.
    // Recovery: rename ghost → .Trashes/hean_cleanup/ (rename works on ghosts!),
    // then recreate fresh. Same mechanism Finder uses for "Move to Trash".
    let mut ghosts_found = 0usize;
    let mut ghosts_recovered = 0usize;
    fn scan_and_recover_ghosts(dir: &Path, ghosts_found: &mut usize, ghosts_recovered: &mut usize) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.starts_with('.') { continue; }
                    // Write test: the ONLY reliable ghost detection.
                    // Some ghosts pass stat() AND read_dir() but fail on File::create.
                    let test_file = entry.path().join(".hean_write_test");
                    let is_writable = match std::fs::File::create(&test_file) {
                        Ok(_) => { let _ = std::fs::remove_file(&test_file); true }
                        Err(_) => false,
                    };
                    if !is_writable {
                        *ghosts_found += 1;
                        eprintln!("[DAP-SYNC] Phase 0c: GHOST DIRECTORY (write test failed): {}", entry.path().display());
                        if recover_ghost_dir(&entry.path()) {
                            *ghosts_recovered += 1;
                        }
                    } else {
                        // Recurse into healthy directories to find nested ghosts
                        scan_and_recover_ghosts(&entry.path(), ghosts_found, ghosts_recovered);
                    }
                }
            }
        }
    }
    scan_and_recover_ghosts(Path::new(dest_path), &mut ghosts_found, &mut ghosts_recovered);
    if ghosts_found > 0 {
        eprintln!("[DAP-SYNC] Ghost recovery: {}/{} recovered", ghosts_recovered, ghosts_found);
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

    let total_copy = plan.files_to_copy.len(); // original count (before validation)
    let total_delete = plan.files_to_delete.len();

    // --- Phase 1: Delete files ---
    eprintln!("[DAP-SYNC] Phase 1: Deleting {} files", total_delete);
    for (i, action) in plan.files_to_delete.iter().enumerate() {
        if cancel_flag.load(Ordering::SeqCst) {
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

    // After deleting audio files, clean up orphaned covers and empty directories.
    // Mirror mode deletes audio but not covers — covers become orphaned when the
    // entire album is removed. Clean them up so the DAP doesn't have stale folders.
    if files_deleted > 0 {
        let dest_root = Path::new(dest_path);
        let empty_cleaned = cleanup_empty_dirs(dest_path);
        if empty_cleaned > 0 {
            eprintln!("[DAP-SYNC] Post-delete cleanup: removed {} empty directories", empty_cleaned);
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

    // --- Pre-Phase 2c: Validate all destination paths ---
    // Discover ALL invalid paths upfront instead of one-at-a-time during the copy.
    // NO pre-validation of directories — directories are created on-demand during copy.
    // Previous approach created all dirs upfront to "test" them, but empty dirs left behind
    // by failed/cancelled syncs become corrupted ghost entries on exFAT/FAT32, blocking
    // all future syncs. The copy loop already has rejected_dirs tracking for skip-on-EINVAL.
    let valid_files = plan.files_to_copy.clone();
    let actual_copy_count = valid_files.len();

    // --- Phase 2: Copy audio files + covers (inline per album) ---
    eprintln!("[DAP-SYNC] Phase 2: Copying {} audio files ({:.1} GB) + {} covers",
        actual_copy_count, plan.total_copy_bytes as f64 / 1_073_741_824.0, plan.covers_to_copy.len());
    let mut bytes_so_far: u64 = 0;
    let mut consecutive_io_errors: u32 = 0;
    const MAX_CONSECUTIVE_IO_ERRORS: u32 = 10;
    let phase2_start = Instant::now();

    // Track rejected directories — skip all remaining files in a dir where EINVAL
    // was returned (filename/dirname rejected by destination filesystem, not actual corruption).
    let mut rejected_dirs: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Build cover lookup: album folder → CoverSyncAction
    // Covers are written inline (right after the last audio file of each album)
    // instead of in a separate phase. This prevents exFAT cluster corruption that
    // occurs when covers are written long after the audio files in the same directory.
    let cover_lookup: HashMap<String, &super::sync_plan::CoverSyncAction> = plan.covers_to_copy.iter()
        .filter_map(|c| {
            // Extract album folder from "Artist/Album/cover.jpg" → "Artist/Album"
            c.dest_relative_path.rfind('/').map(|pos| (c.dest_relative_path[..pos].to_string(), c))
        })
        .collect();
    let mut covers_copied: usize = 0;
    let mut covers_done: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut current_album_folder: Option<String> = None;

    for (i, action) in valid_files.iter().enumerate() {
        if cancel_flag.load(Ordering::SeqCst) {
            let _ = cleanup_hean_tmp(dest_path);
            cleanup_empty_dirs(dest_path);
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

        // Detect album folder change — copy the PREVIOUS album's cover before moving on.
        // This ensures covers are written right after their album's audio files,
        // when the directory is "hot" in the exFAT driver's allocation table.
        let this_folder = action.dest_relative_path.rfind('/')
            .map(|pos| action.dest_relative_path[..pos].to_string());
        if let Some(ref folder) = this_folder {
            if current_album_folder.as_ref() != Some(folder) {
                // Album changed — copy cover for the previous album (if any)
                if let Some(ref prev_folder) = current_album_folder {
                    if !covers_done.contains(prev_folder) {
                        if let Some(cover) = cover_lookup.get(prev_folder) {
                            let cover_dest = format!("{}/{}", dest_path, cover.dest_relative_path);
                            match copy_file_via_cp(&cover.source_cover_path, &cover_dest, None) {
                                Ok(bytes) => {
                                    covers_copied += 1;
                                    total_bytes_copied += bytes;
                                    let hash = compute_quick_hash(&cover_dest).unwrap_or_else(|_| "error".into());
                                    synced_files.push(SyncedFile {
                                        source_path: cover.source_cover_path.clone(),
                                        dest_relative_path: cover.dest_relative_path.clone(),
                                        size_bytes: bytes,
                                        modified_at: get_file_modified_at(&cover.source_cover_path),
                                        quick_hash: hash,
                                    });
                                }
                                Err(e) => {
                                    eprintln!("[DAP-SYNC] Cover copy failed (non-fatal): {} — {}", cover.dest_relative_path, e);
                                }
                            }
                        }
                        covers_done.insert(prev_folder.clone());
                    }
                }
                current_album_folder = Some(folder.clone());
            }
        }

        // Skip files in rejected directories — the directory name was rejected
        // by the destination filesystem (EINVAL), no point trying more files in it.
        if let Some(pos) = action.dest_relative_path.rfind('/') {
            let dir = &action.dest_relative_path[..pos];
            if rejected_dirs.contains(dir) {
                errors.push(format!("{} — Skipped (directory rejected by destination filesystem)", action.dest_relative_path));
                continue;
            }
        }

        let _ = app_handle.emit("dap_sync_progress", SyncProgress {
            phase: "copy".into(),
            current: i + 1,
            total: actual_copy_count,
            current_file: action.dest_relative_path.clone(),
            bytes_copied: bytes_so_far,
            total_bytes: plan.total_copy_bytes,
            action: action.action.clone(),
        });

        // Check cancel before potentially-blocking SMB operations
        if cancel_flag.load(Ordering::SeqCst) {
            let _ = cleanup_hean_tmp(dest_path);
            cleanup_empty_dirs(dest_path);
            let _ = write_partial_manifest(dest_path, old_manifest, &synced_files, &plan.files_to_delete, folder_structure);
            eprintln!("[DAP-SYNC] Cancel detected before file {}", action.dest_relative_path);
            return Ok(SyncComplete {
                success: false,
                files_copied,
                files_deleted,
                total_bytes_copied,
                duration_ms: start.elapsed().as_millis() as u64,
                errors: vec!["Sync cancelled by user".into()],
            });
        }

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

        match copy_file_via_cp(&resolved_source, &full_dest, Some(&cancel_flag)) {
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
                        files_copied, actual_copy_count, total_bytes_copied as f64 / 1_073_741_824.0, elapsed, rate_mb);

                    // Batch pause: flush exFAT metadata and let the driver settle.
                    // The macOS userspace exFAT driver corrupts directory entries under
                    // sustained I/O (>300 files / 20+ minutes). A 2-second pause every
                    // 50 files forces a metadata flush and prevents ghost creation.
                    // Cost: ~24s on a 600-file sync (invisible on a 45-minute transfer).
                    eprintln!("[DAP-SYNC] Batch pause — flushing filesystem metadata");
                    if let Ok(f) = std::fs::File::open(dest_path) { let _ = f.sync_all(); }
                    std::thread::sleep(std::time::Duration::from_secs(2));

                    // === CHECKPOINT 4: Spot-check 3 random previously-copied files ===
                    // Detects retroactive corruption (driver reallocates clusters after write).
                    if synced_files.len() >= 3 {
                        use std::collections::hash_map::DefaultHasher;
                        use std::hash::{Hash, Hasher};
                        let mut h = DefaultHasher::new();
                        files_copied.hash(&mut h);
                        let seed = h.finish() as usize;
                        let check_count = 3.min(synced_files.len());
                        let mut retroactive_corrupt = 0;
                        for ci in 0..check_count {
                            let idx = (seed + ci * 37) % synced_files.len();
                            let sf = &synced_files[idx];
                            let full = format!("{}/{}", dest_path, sf.dest_relative_path);
                            let (magic_ok, magic_hex) = check_audio_magic(Path::new(&full));
                            if !magic_ok {
                                retroactive_corrupt += 1;
                                eprintln!("[INTEGRITY] CP4 RETROACTIVE CORRUPTION: {} — magic={} (file #{}, checked at copy #{})",
                                    sf.dest_relative_path, magic_hex, idx, files_copied);
                            }
                        }
                        if retroactive_corrupt > 0 {
                            eprintln!("[INTEGRITY] CP4: {}/{} spot-checked files CORRUPT — exFAT driver is reallocating clusters!",
                                retroactive_corrupt, check_count);
                        }
                    }
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
            Err(e) if e == "cancelled" => {
                // Cancel was triggered mid-copy — exit the loop immediately
                eprintln!("[DAP-SYNC] Copy cancelled mid-file: {}", action.dest_relative_path);
                break;
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
                        match copy_file_via_cp(&resolved_source, &full_dest, Some(&cancel_flag)) {
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

                    // Mark this directory as rejected — skip all remaining files
                    // in this directory (the dirname is invalid on this filesystem).
                    if e.contains("os error 22") {
                        if let Some(pos) = action.dest_relative_path.rfind('/') {
                            let dir = action.dest_relative_path[..pos].to_string();
                            eprintln!("[DAP-SYNC] DIRECTORY REJECTED — skipping remaining files in: {}", dir);
                            rejected_dirs.insert(dir);
                        }
                    }
                } else {
                    // Transient error — retry once after short delay
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    match copy_file_via_cp(&resolved_source, &full_dest, Some(&cancel_flag)) {
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

    // Copy cover for the LAST album in the loop (not caught by the album-change detection)
    if let Some(ref last_folder) = current_album_folder {
        if !covers_done.contains(last_folder) {
            if let Some(cover) = cover_lookup.get(last_folder) {
                let cover_dest = format!("{}/{}", dest_path, cover.dest_relative_path);
                match copy_file_via_cp(&cover.source_cover_path, &cover_dest, None) {
                    Ok(bytes) => {
                        covers_copied += 1;
                        total_bytes_copied += bytes;
                        let hash = compute_quick_hash(&cover_dest).unwrap_or_else(|_| "error".into());
                        synced_files.push(SyncedFile {
                            source_path: cover.source_cover_path.clone(),
                            dest_relative_path: cover.dest_relative_path.clone(),
                            size_bytes: bytes,
                            modified_at: get_file_modified_at(&cover.source_cover_path),
                            quick_hash: hash,
                        });
                    }
                    Err(e) => {
                        eprintln!("[DAP-SYNC] Cover copy failed (non-fatal): {} — {}", cover.dest_relative_path, e);
                    }
                }
            }
            covers_done.insert(last_folder.clone());
        }
    }

    let total_covers = plan.covers_to_copy.len();
    eprintln!("[DAP-SYNC] Phase 2 complete: {}/{} audio files copied, {}/{} covers, ({:.1} GB) in {:.1}s, {} errors",
        files_copied, total_copy, covers_copied, total_covers,
        total_bytes_copied as f64 / 1_073_741_824.0,
        phase2_start.elapsed().as_secs_f64(), errors.len());

    // Check cancel after Phase 2
    if cancel_flag.load(Ordering::SeqCst) {
        let _ = cleanup_hean_tmp(dest_path);
        cleanup_empty_dirs(dest_path);
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

    // Clean up empty directories left by failed copies (e.g., EINVAL on first file of an album).
    // This runs after EVERY sync, not just cancel — prevents empty ghost dirs on the card.
    let empty_cleaned = cleanup_empty_dirs(dest_path);
    if empty_cleaned > 0 {
        eprintln!("[DAP-SYNC] Cleaned up {} empty directories", empty_cleaned);
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

/// Pre-validate all destination paths by attempting to create parent directories.
/// Discovers ALL invalid paths upfront (EINVAL, permission issues) instead of
/// one-at-a-time during the copy phase which can take hours.
/// Returns (valid_actions, error_messages).
// validate_dest_paths was REMOVED intentionally.
// It pre-created directories on the destination to "test" if names were valid.
// Problem: empty directories left behind by failed/cancelled syncs became corrupted
// ghost entries on exFAT, blocking ALL future syncs (EINVAL on create_dir_all).
// Directories are now created on-demand by copy_file_verified() only when a file
// is actually ready to be written. The copy loop's rejected_dirs tracking handles
// the skip-on-EINVAL logic that pre-validation used to provide.

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
    copy_file_verified_cancellable(source, dest, None)
}

/// Copy with optional cancel flag. When provided, the copy checks the flag every 256KB chunk.
/// If cancelled mid-copy, the .hean-tmp is cleaned up and Err("cancelled") is returned.
pub fn copy_file_verified_cancellable(
    source: &str,
    dest: &str,
    cancel_flag: Option<&AtomicBool>,
) -> Result<u64, String> {
    let source_path = Path::new(source);
    let dest_path = Path::new(dest);

    // CRITICAL: Open source FIRST, BEFORE creating any directory on the destination.
    // If the source is unreachable (SMB disconnected, file moved), we fail immediately
    // without ever creating a directory on the DAP. Empty dirs on exFAT become
    // corrupted ghost entries that are non-removable and block all future syncs.
    let mut src_file = std::fs::File::open(source_path)
        .map_err(|e| format!("Failed to open source {}: {}", source, e))?;

    // Source exists and is readable — NOW create the destination directory.
    if let Some(parent) = dest_path.parent() {
        // Clean Apple Double files in the target directory BEFORE creating new content.
        // macOS creates ._* for every file on exFAT. At ~30 files, the directory
        // entry table overflows → EINVAL on File::create or rename.
        if parent.exists() {
            cleanup_apple_double_in_dir(parent);
        }

        match std::fs::create_dir_all(parent) {
            Ok(()) => {
                // CRITICAL: fsync + throttle after directory creation.
                // macOS's userspace exFAT driver (Sonoma+) has a known bug where
                // F_FULLFSYNC silently fails under heavy I/O, leaving directory entries
                // uncommitted → ghost dirs (stat OK, read_dir EINVAL, rmdir EINVAL).
                // Documented by Bitcoin project (GitHub #31454) and Bombich (CCC).
                // Two mitigations:
                // 1. fsync the parent to flush directory entry metadata
                // 2. 200ms throttle to give the userspace driver time to commit
                //    15ms tested → reduced ghosts from 30% to 11% failure rate
                //    200ms escalation per plan d'escalade (cost: 200ms × ~50 dirs = +10s)
                if let Some(grandparent) = parent.parent() {
                    if let Ok(gp_file) = std::fs::File::open(grandparent) {
                        let _ = gp_file.sync_all();
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(200));

                // Verify the directory is actually WRITABLE (not a ghost).
                // Some ghosts pass both stat() AND read_dir() but fail on File::create.
                // The ONLY reliable test is to actually write a file and delete it.
                let test_file = parent.join(".hean_write_test");
                let dir_is_writable = match std::fs::File::create(&test_file) {
                    Ok(_) => {
                        let _ = std::fs::remove_file(&test_file);
                        true
                    }
                    Err(_) => false,
                };
                if !dir_is_writable {
                    eprintln!("[DAP-SYNC] GHOST DIR DETECTED (write test failed): {}", parent.display());
                    if recover_ghost_dir(parent) {
                        // Verify the recovered dir is writable
                        let test_file2 = parent.join(".hean_write_test");
                        let recovered_writable = match std::fs::File::create(&test_file2) {
                            Ok(_) => { let _ = std::fs::remove_file(&test_file2); true }
                            Err(_) => false,
                        };
                        if recovered_writable {
                            eprintln!("[DAP-SYNC] Ghost recovered and verified writable: {}", parent.display());
                        } else {
                            eprintln!("[DAP-SYNC] Ghost recovered but STILL not writable: {}", parent.display());
                            return Err(format!("Failed to create dirs for {}: ghost directory unrecoverable", dest));
                        }
                    } else {
                        return Err(format!("Failed to create dirs for {}: ghost directory unrecoverable", dest));
                    }
                }
            }
            Err(e) => {
                // create_dir_all failed — could be trying to traverse an existing ghost parent.
                // Walk from dest root down, checking each component for ghosts.
                let components: Vec<_> = parent.components().collect();
                let mut built = std::path::PathBuf::new();
                let mut recovered = false;
                for comp in &components {
                    built.push(comp);
                    if built.exists() && std::fs::read_dir(&built).is_err() {
                        eprintln!("[DAP-SYNC] GHOST ANCESTOR DETECTED: {} — blocking path to {}", built.display(), dest);
                        if recover_ghost_dir(&built) {
                            eprintln!("[DAP-SYNC] Ghost ancestor recovered: {}", built.display());
                            recovered = true;
                            break;
                        } else {
                            return Err(format!("Failed to create dirs for {}: ghost directory unrecoverable at {}", dest, built.display()));
                        }
                    }
                }
                if recovered {
                    // Ghost parent was recovered — retry create_dir_all for the full path
                    match std::fs::create_dir_all(parent) {
                        Ok(()) => {
                            if let Some(gp) = parent.parent() {
                                if let Ok(f) = std::fs::File::open(gp) { let _ = f.sync_all(); }
                            }
                            std::thread::sleep(std::time::Duration::from_millis(200));
                        }
                        Err(e2) => {
                            return Err(format!("Failed to create dirs for {} after ghost recovery: {}", dest, e2));
                        }
                    }
                } else {
                    return Err(format!("Failed to create dirs for {}: {}", dest, e));
                }
            }
        }
    }

    // Write to a temporary file first, then rename to final path.
    let tmp_dest = format!("{}.hean-tmp", dest);
    let tmp_path = Path::new(&tmp_dest);

    let mut dst_file = std::fs::File::create(tmp_path)
        .map_err(|e| {
            cleanup_empty_parent_dirs(dest);
            format!("Failed to create dest {}: {}", dest, e)
        })?;

    // Chunked copy with cancel check — 256KB chunks let us respond to cancel
    // within ~30ms even on slow USB/SMB transfers (256KB / ~8MB/s ≈ 30ms).
    let mut buf = vec![0u8; 256 * 1024];
    let mut bytes: u64 = 0;
    let copy_result: Result<(), std::io::Error> = loop {
        // Check cancel flag every chunk
        if let Some(flag) = cancel_flag {
            if flag.load(Ordering::SeqCst) {
                eprintln!("[DAP-SYNC] Cancel detected mid-copy at {} bytes, cleaning up tmp", bytes);
                let _ = std::fs::remove_file(tmp_path);
                return Err("cancelled".into());
            }
        }
        match src_file.read(&mut buf) {
            Ok(0) => break Ok(()), // EOF
            Ok(n) => {
                use std::io::Write;
                if let Err(e) = dst_file.write_all(&buf[..n]) {
                    break Err(e);
                }
                bytes += n as u64;
            }
            Err(e) => break Err(e),
        }
    };

    if let Err(e) = copy_result {
        let _ = std::fs::remove_file(tmp_path); // cleanup partial tmp
        // Clean up empty parent directory to prevent exFAT ghost entries.
        // An empty dir left on exFAT can become corrupted and non-removable,
        // blocking all future syncs to that artist/album.
        cleanup_empty_parent_dirs(dest);
        return Err(format!("Failed to copy {} -> {}: {}", source, dest, e));
    }

    // === CHECKPOINT 1: After io::copy, before fsync ===
    // Hash the .hean-tmp to verify the write itself was correct.
    let src_hash = quick_integrity_hash(source_path);
    let cp1_hash = quick_integrity_hash(tmp_path);
    let (cp1_magic_ok, cp1_magic) = check_audio_magic(tmp_path);
    if src_hash != cp1_hash {
        eprintln!("[INTEGRITY] CP1 FAIL (after write, before fsync): {}", dest);
        eprintln!("[INTEGRITY]   src_hash={}, tmp_hash={}, magic={}, magic_ok={}",
            &src_hash[..16], &cp1_hash[..16], cp1_magic, cp1_magic_ok);
        let _ = std::fs::remove_file(tmp_path);
        cleanup_empty_parent_dirs(dest);
        return Err(format!("Integrity check failed after write (before fsync): {}", dest));
    }

    // fsync: flush data to physical device before renaming
    if let Err(e) = dst_file.sync_all() {
        let _ = std::fs::remove_file(tmp_path); // cleanup partial tmp
        cleanup_empty_parent_dirs(dest);
        return Err(format!("Failed to fsync {}: {}", dest, e));
    }

    // Drop the file handle before rename (required on some filesystems)
    drop(dst_file);

    // === CHECKPOINT 2: After fsync, before rename ===
    // Re-hash to check if fsync corrupted the data.
    let cp2_hash = quick_integrity_hash(tmp_path);
    let (cp2_magic_ok, cp2_magic) = check_audio_magic(tmp_path);
    if src_hash != cp2_hash {
        eprintln!("[INTEGRITY] CP2 FAIL (after fsync, before rename): {}", dest);
        eprintln!("[INTEGRITY]   src_hash={}, post_fsync_hash={}, magic={}, magic_ok={}",
            &src_hash[..16], &cp2_hash[..16], cp2_magic, cp2_magic_ok);
        let _ = std::fs::remove_file(tmp_path);
        cleanup_empty_parent_dirs(dest);
        return Err(format!("Integrity check failed after fsync: {}", dest));
    }

    // Verify size before rename — catch partial writes
    let source_size = src_file.metadata().map(|m| m.len()).unwrap_or(0);
    if bytes != source_size {
        let _ = std::fs::remove_file(tmp_path); // cleanup bad tmp
        cleanup_empty_parent_dirs(dest);
        return Err(format!(
            "Size mismatch after copy: source={} dest={} ({} vs {} bytes)",
            source, dest, source_size, bytes
        ));
    }

    // Clean ._* again before rename — macOS may have created new Apple Double
    // files during the write, and the rename needs a free directory entry slot.
    if let Some(parent) = dest_path.parent() {
        cleanup_apple_double_in_dir(parent);
    }

    // Atomic rename: tmp → final. This is the commit point.
    std::fs::rename(tmp_path, dest_path)
        .map_err(|e| {
            let _ = std::fs::remove_file(tmp_path); // cleanup on rename failure
            cleanup_empty_parent_dirs(dest);
            format!("Failed to rename tmp to final {}: {}", dest, e)
        })?;

    // === CHECKPOINT 3: After rename — verify final file ===
    let cp3_hash = quick_integrity_hash(dest_path);
    let (cp3_magic_ok, cp3_magic) = check_audio_magic(dest_path);
    if src_hash != cp3_hash {
        eprintln!("[INTEGRITY] CP3 FAIL (after rename): {}", dest);
        eprintln!("[INTEGRITY]   src_hash={}, final_hash={}, magic={}, magic_ok={}",
            &src_hash[..16], &cp3_hash[..16], cp3_magic, cp3_magic_ok);
        eprintln!("[INTEGRITY]   CP1={}, CP2={} (were these OK? both should match src)",
            if src_hash == cp1_hash { "OK" } else { "FAIL" },
            if src_hash == cp2_hash { "OK" } else { "FAIL" });
        // Don't delete — leave for analysis. But flag the error.
        return Err(format!("Integrity check failed after rename (data corrupted on disk): {}", dest));
    }
    if !cp3_magic_ok {
        eprintln!("[INTEGRITY] CP3 MAGIC WARN: {} — magic={} (unexpected for extension)", dest, cp3_magic);
    }

    // Immediately remove Apple Double file that macOS creates for each written file.
    if let Some(parent) = dest_path.parent() {
        if let Some(filename) = dest_path.file_name() {
            let ad_file = parent.join(format!("._{}", filename.to_string_lossy()));
            let _ = std::fs::remove_file(&ad_file);
        }
        let tmp_filename = format!("._{}.hean-tmp", dest_path.file_name().unwrap().to_string_lossy());
        let ad_tmp = parent.join(&tmp_filename);
        let _ = std::fs::remove_file(&ad_tmp);
    }

    Ok(bytes)
}

/// Copy a file using macOS `cp` command instead of Rust I/O.
///
/// WHY: The macOS Sonoma userspace exFAT driver has a bug where Rust's write_all() → fsync()
/// silently corrupts data (wrong clusters allocated to files). But macOS's `cp` command uses
/// `copyfile()` internally which follows a different, working code path through the driver.
/// Proven: `cp` produces valid FLAC headers while our Rust I/O produces garbage.
///
/// This function:
/// 1. Creates the parent directory (with ghost detection + recovery)
/// 2. Calls `cp` to copy the file
/// 3. Verifies the copy (size match + audio magic bytes)
/// 4. Cleans up Apple Double files created by macOS during copy
pub fn copy_file_via_cp(
    source: &str,
    dest: &str,
    cancel_flag: Option<&AtomicBool>,
) -> Result<u64, String> {
    let source_path = Path::new(source);
    let dest_path = Path::new(dest);

    // Check cancel before starting
    if let Some(flag) = cancel_flag {
        if flag.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
    }

    // Verify source exists
    if !source_path.exists() {
        return Err(format!("Source file not found: {}", source));
    }

    let source_size = source_path.metadata()
        .map(|m| m.len())
        .map_err(|e| format!("Cannot read source metadata {}: {}", source, e))?;

    // Create parent directory with ghost detection (same logic as before)
    if let Some(parent) = dest_path.parent() {
        if parent.exists() {
            cleanup_apple_double_in_dir(parent);
        }

        match std::fs::create_dir_all(parent) {
            Ok(()) => {
                // Throttle + fsync parent for exFAT ghost prevention
                if let Some(grandparent) = parent.parent() {
                    if let Ok(gp_file) = std::fs::File::open(grandparent) {
                        let _ = gp_file.sync_all();
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(200));

                // Write test to detect ghost directories
                let test_file = parent.join(".hean_write_test");
                let dir_is_writable = match std::fs::File::create(&test_file) {
                    Ok(_) => { let _ = std::fs::remove_file(&test_file); true }
                    Err(_) => false,
                };
                if !dir_is_writable {
                    eprintln!("[DAP-SYNC] GHOST DIR DETECTED (write test failed): {}", parent.display());
                    if recover_ghost_dir(parent) {
                        let test2 = parent.join(".hean_write_test");
                        let ok = match std::fs::File::create(&test2) {
                            Ok(_) => { let _ = std::fs::remove_file(&test2); true }
                            Err(_) => false,
                        };
                        if !ok {
                            return Err(format!("Failed to create dirs for {}: ghost directory unrecoverable", dest));
                        }
                    } else {
                        return Err(format!("Failed to create dirs for {}: ghost directory unrecoverable", dest));
                    }
                }
            }
            Err(e) => {
                // Try ghost recovery on parent components
                let dest_root = dest_path.components().take(3).collect::<std::path::PathBuf>();
                let rel = parent.strip_prefix(&dest_root).unwrap_or(parent);
                let mut built = dest_root.clone();
                for component in rel.components() {
                    built.push(component);
                    if built.exists() {
                        let test = built.join(".hean_write_test");
                        if std::fs::File::create(&test).is_err() {
                            if recover_ghost_dir(&built) {
                                eprintln!("[DAP-SYNC] Ghost recovered at: {}", built.display());
                            } else {
                                return Err(format!("Failed to create dirs for {}: ghost at {}", dest, built.display()));
                            }
                        } else {
                            let _ = std::fs::remove_file(&test);
                        }
                    }
                }
                // Retry create_dir_all after ghost recovery
                if let Err(e2) = std::fs::create_dir_all(parent) {
                    cleanup_empty_parent_dirs(dest);
                    return Err(format!("Failed to create dirs for {} after ghost recovery: {}", dest, e2));
                }
            }
        }
    }

    // Remove destination if it exists (overwrite scenario)
    if dest_path.exists() {
        let _ = std::fs::remove_file(dest_path);
    }

    // === THE KEY CHANGE: Use macOS `cp` instead of Rust I/O ===
    // cp uses copyfile() which follows a working code path through the exFAT driver.
    // Our Rust write_all() → fsync() corrupts data under sustained I/O (Sonoma bug).
    let output = std::process::Command::new("cp")
        .arg(source)
        .arg(dest)
        .env("COPYFILE_DISABLE", "1")  // Don't copy Apple resource forks
        .output()
        .map_err(|e| format!("Failed to execute cp: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        cleanup_empty_parent_dirs(dest);
        return Err(format!("cp failed for {}: {}", dest, stderr.trim()));
    }

    // Verify: size must match
    let dest_size = dest_path.metadata()
        .map(|m| m.len())
        .unwrap_or(0);

    if dest_size != source_size {
        let _ = std::fs::remove_file(dest_path);
        cleanup_empty_parent_dirs(dest);
        return Err(format!(
            "Size mismatch after cp: {} ({} vs {} bytes)",
            dest, source_size, dest_size
        ));
    }

    // Verify: audio magic bytes must be correct
    let (src_magic_ok, src_magic) = check_audio_magic(source_path);
    let (dst_magic_ok, dst_magic) = check_audio_magic(dest_path);
    if src_magic_ok && !dst_magic_ok {
        eprintln!("[INTEGRITY] CP VERIFY FAIL: {} — src_magic={}, dst_magic={}",
            dest, src_magic, dst_magic);
        let _ = std::fs::remove_file(dest_path);
        cleanup_empty_parent_dirs(dest);
        return Err(format!("Integrity check failed after cp: {} (magic mismatch)", dest));
    }

    // Clean Apple Double files
    if let Some(parent) = dest_path.parent() {
        if let Some(filename) = dest_path.file_name() {
            let ad_file = parent.join(format!("._{}", filename.to_string_lossy()));
            let _ = std::fs::remove_file(&ad_file);
        }
    }

    Ok(dest_size)
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

/// Recover a ghost directory by renaming it to .Trashes, then recreating it fresh.
///
/// Ghost dirs on exFAT: stat() works but read_dir()/rmdir() return EINVAL.
/// Key insight: rename() WORKS on ghosts (same mechanism as Finder's "Move to Trash").
/// rmdir() fails because it needs to read the dir to verify it's empty.
/// rename() only modifies the parent directory entry — doesn't read the ghost itself.
///
/// Strategy: rename ghost → .Trashes/hean_ghost_XXX, then create_dir_all fresh.
fn recover_ghost_dir(ghost_path: &Path) -> bool {
    // Find the volume root (e.g., /Volumes/Fiio SD) for .Trashes location
    let components: Vec<_> = ghost_path.components().collect();
    if components.len() < 3 {
        return false; // Can't determine volume root
    }
    let volume_root: std::path::PathBuf = components[..3].iter().collect();

    // Use a FRESH trash directory name each time. The old approach used a fixed
    // ".Trashes/hean_cleanup" — but that dir itself became a ghost after receiving
    // too many ghosts, breaking ALL subsequent recovery attempts.
    // Now: ".hean_trash_{pid}" at volume root (not inside .Trashes which may also be corrupt).
    let trash_dir = volume_root.join(format!(".hean_trash_{}", std::process::id()));

    // Ensure trash dir exists (create if fresh, no-op if already created this session)
    if let Err(e) = std::fs::create_dir_all(&trash_dir) {
        eprintln!("[DAP-SYNC] Ghost recovery: cannot create trash dir {}: {}", trash_dir.display(), e);
        return false;
    }

    // Generate a unique name for the ghost in trash
    let ghost_name = ghost_path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".into());
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let trash_dest = trash_dir.join(format!("{}_{}", ghost_name, timestamp));

    // rename() works on ghost dirs even when rmdir() doesn't!
    // It only modifies the parent directory entry, doesn't read the ghost itself.
    // For freshly-created ghosts (during this sync), the first rename may fail because
    // the exFAT driver hasn't flushed the directory entry yet. Retry after 500ms.
    eprintln!("[DAP-SYNC] Ghost recovery: attempting rename {} → {}", ghost_path.display(), trash_dest.display());
    let rename_ok = match std::fs::rename(ghost_path, &trash_dest) {
        Ok(()) => {
            eprintln!("[DAP-SYNC] Ghost renamed to trash (1st try): {}", ghost_path.display());
            true
        }
        Err(e) => {
            eprintln!("[DAP-SYNC] Ghost rename failed (1st try): {} — {} — retrying in 500ms", ghost_path.display(), e);
            // Retry: fresh ghosts may need time for the exFAT driver to stabilize
            std::thread::sleep(std::time::Duration::from_millis(500));
            // Regenerate trash dest with new timestamp to avoid collision
            let ts2 = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let trash_dest2 = trash_dir.join(format!("{}_{}", ghost_name, ts2));
            match std::fs::rename(ghost_path, &trash_dest2) {
                Ok(()) => {
                    eprintln!("[DAP-SYNC] Ghost renamed to trash (2nd try): {}", ghost_path.display());
                    true
                }
                Err(e2) => {
                    eprintln!("[DAP-SYNC] Ghost rename FAILED (2nd try): {} — {}", ghost_path.display(), e2);
                    false
                }
            }
        }
    };
    if !rename_ok {
        // Album-level ghosts can't be renamed directly (EINVAL).
        // Escalation: rename the PARENT artist directory instead,
        // then recreate the full path from scratch.
        if let Some(parent) = ghost_path.parent() {
            // Don't try to rename the volume root itself
            if parent.components().count() > 3 {
                let parent_name = parent.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "unknown_parent".into());
                let ts_esc = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                let parent_trash = trash_dir.join(format!("{}_{}", parent_name, ts_esc));
                eprintln!("[DAP-SYNC] Ghost escalation: renaming PARENT {} → {}", parent.display(), parent_trash.display());
                match std::fs::rename(parent, &parent_trash) {
                    Ok(()) => {
                        eprintln!("[DAP-SYNC] Parent renamed to trash: {}", parent.display());
                        // Recreate the full ghost path (artist + album)
                        match std::fs::create_dir_all(ghost_path) {
                            Ok(()) => {
                                if let Some(gp) = ghost_path.parent() {
                                    if let Ok(f) = std::fs::File::open(gp) { let _ = f.sync_all(); }
                                }
                                std::thread::sleep(std::time::Duration::from_millis(200));
                                let test = ghost_path.join(".hean_write_test");
                                if let Ok(_) = std::fs::File::create(&test) {
                                    let _ = std::fs::remove_file(&test);
                                    eprintln!("[DAP-SYNC] Ghost escalation COMPLETE: {} is now usable", ghost_path.display());
                                    return true;
                                }
                            }
                            Err(e) => {
                                eprintln!("[DAP-SYNC] Ghost escalation FAILED: could not recreate {}: {}", ghost_path.display(), e);
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[DAP-SYNC] Ghost escalation FAILED: parent rename failed: {} — {}", parent.display(), e);
                    }
                }
            }
        }
        return false;
    }

    // Ghost is out of the way — recreate the directory fresh
    match std::fs::create_dir_all(ghost_path) {
        Ok(()) => {
            // fsync + throttle for the new directory
            if let Some(gp) = ghost_path.parent() {
                if let Ok(f) = std::fs::File::open(gp) { let _ = f.sync_all(); }
            }
            std::thread::sleep(std::time::Duration::from_millis(200));

            // Verify the new directory is healthy
            if std::fs::read_dir(ghost_path).is_ok() {
                eprintln!("[DAP-SYNC] Ghost recovery COMPLETE: {} is now usable", ghost_path.display());
                true
            } else {
                eprintln!("[DAP-SYNC] Ghost recovery FAILED: recreated dir is also a ghost!");
                false
            }
        }
        Err(e) => {
            eprintln!("[DAP-SYNC] Ghost recovery FAILED: could not recreate {}: {}", ghost_path.display(), e);
            false
        }
    }
}

/// Walk the entire destination tree bottom-up, removing directories that contain
/// only hidden files (._*, .DS_Store) or are truly empty. Returns the count removed.
/// This prevents exFAT ghost entries which become corrupted and non-removable.
fn cleanup_empty_dirs(dest_path: &str) -> usize {
    let root = Path::new(dest_path);
    let mut removed = 0;

    fn walk_and_clean(dir: &Path, root: &Path, removed: &mut usize) {
        let entries: Vec<_> = match std::fs::read_dir(dir) {
            Ok(rd) => rd.flatten().collect(),
            Err(_) => return,
        };

        // Recurse into subdirectories first (bottom-up)
        for entry in &entries {
            if entry.path().is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.starts_with('.') {
                    walk_and_clean(&entry.path(), root, removed);
                }
            }
        }

        // Don't remove the root
        if dir == root { return; }

        // Re-read after child cleanup.
        // A directory is "orphaned" if it has no audio files (and no subdirs with audio).
        // Orphaned covers (cover.jpg alone) should be cleaned up too.
        let has_audio_or_subdirs = match std::fs::read_dir(dir) {
            Ok(rd) => rd.flatten().any(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                if e.path().is_dir() && !name.starts_with('.') {
                    return true; // has real subdirectory
                }
                let lower = name.to_lowercase();
                lower.ends_with(".flac") || lower.ends_with(".mp3") || lower.ends_with(".wav")
                    || lower.ends_with(".aiff") || lower.ends_with(".aif") || lower.ends_with(".m4a")
                    || lower.ends_with(".ogg") || lower.ends_with(".alac")
            }),
            Err(_) => true, // can't read → don't touch
        };

        if !has_audio_or_subdirs {
            // Remove ALL files (covers, hidden files, etc.)
            if let Ok(rd) = std::fs::read_dir(dir) {
                for entry in rd.flatten() {
                    if entry.path().is_file() {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
            if std::fs::remove_dir(dir).is_ok() {
                eprintln!("[DAP-SYNC] Removed orphaned dir: {}", dir.display());
                *removed += 1;
            }
        }
    }

    walk_and_clean(root, root, &mut removed);
    removed
}

/// Clean up empty parent directories after a failed copy.
/// Walks up from the file's parent toward the volume root, removing empty directories.
/// Stops at /Volumes/XXX level (3 path components) to never delete the volume itself.
/// This prevents exFAT ghost entries — empty dirs on exFAT can become corrupted
/// and non-removable, blocking all future syncs to that path.
fn cleanup_empty_parent_dirs(file_dest: &str) {
    let file_path = Path::new(file_dest);
    let mut current = file_path.parent();

    while let Some(dir) = current {
        // Stop at volume root level (/Volumes/XXX = 3 components)
        if dir.components().count() <= 3 {
            break;
        }

        // Clean ._* files first — they don't count as "real" content
        cleanup_apple_double_in_dir(dir);

        // Check if directory has any real (non-hidden) files or subdirectories
        let has_real_content = match std::fs::read_dir(dir) {
            Ok(entries) => entries.flatten().any(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                !name.starts_with('.')
            }),
            Err(_) => true, // can't read → don't touch
        };

        if !has_real_content {
            // Remove remaining hidden files (._*, .DS_Store)
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    if entry.file_name().to_string_lossy().starts_with('.') {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
            match std::fs::remove_dir(dir) {
                Ok(()) => {
                    eprintln!("[DAP-SYNC] Cleaned up empty dir after error: {}", dir.display());
                    current = dir.parent();
                    continue;
                }
                Err(_) => break,
            }
        } else {
            break;
        }
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
/// Uses F_NOCACHE on macOS to bypass the kernel buffer cache and read directly
/// from the physical device. This is CRITICAL for exFAT integrity verification:
/// the macOS exFAT driver can corrupt file data while the kernel cache still
/// holds the correct pre-corruption data. Without F_NOCACHE, read-back verification
/// always passes even when the on-disk data is corrupted.
///
/// Returns "error" on any I/O failure (non-fatal, caller decides retry strategy).
pub fn compute_md5_hash(path: &str) -> String {
    use std::os::unix::io::AsRawFd;

    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return "error".into(),
    };

    // Disable kernel buffer cache for this file descriptor.
    // F_NOCACHE = 48 on macOS — reads go directly to the device.
    #[cfg(target_os = "macos")]
    {
        extern "C" { fn fcntl(fd: i32, cmd: i32, ...) -> i32; }
        unsafe { fcntl(file.as_raw_fd(), 48 /* F_NOCACHE */, 1i32); }
    }

    let mut reader = std::io::BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 65536];
    loop {
        match reader.read(&mut buf) {
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

/// Recursively scan and delete all *.hean-tmp files left by interrupted syncs.
/// Returns (files_deleted, bytes_freed).
fn cleanup_hean_tmp(dest_path: &str) -> (usize, u64) {
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
                if name.ends_with(".hean-tmp") {
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

/// Recursively scan and delete all ._* Apple Double resource fork files.
/// Returns (files_deleted, bytes_freed).
/// Clean Apple Double (._*) files in a SINGLE directory.
/// Called before each file write to prevent exFAT directory entry overflow.
/// macOS creates ._* files for every file written to exFAT — at ~30 files per dir,
/// the 60+ entries (files + Apple Doubles) can exceed the driver's per-cluster limit,
/// causing EINVAL on File::create or rename.
fn cleanup_apple_double_in_dir(dir: &Path) -> usize {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    let mut count = 0;
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("._") {
                let _ = std::fs::remove_file(entry.path());
                count += 1;
            }
        }
    }
    count
}

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

    #[test]
    fn test_cleanup_hean_tmp() {
        let dir = tempfile::tempdir().unwrap();

        // Create normal files that should NOT be deleted
        let normal = dir.path().join("Artist/Album/01 - Track.flac");
        std::fs::create_dir_all(normal.parent().unwrap()).unwrap();
        std::fs::write(&normal, "audio data").unwrap();

        // Create .hean-tmp files that SHOULD be deleted
        let tmp1 = dir.path().join("Artist/Album/02 - Track.flac.hean-tmp");
        std::fs::write(&tmp1, "partial data").unwrap();

        let nested_dir = dir.path().join("Other/SubDir");
        std::fs::create_dir_all(&nested_dir).unwrap();
        let tmp2 = nested_dir.join("file.flac.hean-tmp");
        std::fs::write(&tmp2, "more partial data").unwrap();

        let (count, bytes) = cleanup_hean_tmp(dir.path().to_str().unwrap());

        assert_eq!(count, 2);
        assert!(bytes > 0);
        assert!(!tmp1.exists(), ".hean-tmp should be deleted");
        assert!(!tmp2.exists(), "nested .hean-tmp should be deleted");
        assert!(normal.exists(), "normal files should remain");
    }

    #[test]
    fn test_copy_file_verified_no_leftover_tmp() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.flac");
        let dest = dir.path().join("subdir/dest.flac");
        let tmp = dir.path().join("subdir/dest.flac.hean-tmp");

        std::fs::write(&source, "audio content for tmp test").unwrap();

        copy_file_verified(source.to_str().unwrap(), dest.to_str().unwrap()).unwrap();

        assert!(dest.exists(), "final file should exist");
        assert!(!tmp.exists(), "no .hean-tmp should remain after successful copy");
    }

    // =========================================================================
    // Corruption protection test suite
    // Simulates crash, cancel, partial write, and filesystem error scenarios
    // =========================================================================

    #[test]
    fn test_copy_source_missing_no_leftover_tmp() {
        // Scenario: source file doesn't exist → error, no tmp left on volume
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("Artist/Album/01 - Track.flac");
        let tmp = dir.path().join("Artist/Album/01 - Track.flac.hean-tmp");

        let result = copy_file_verified("/nonexistent/source.flac", dest.to_str().unwrap());

        assert!(result.is_err(), "should fail on missing source");
        assert!(!tmp.exists(), "no .hean-tmp should be left when source is missing");
        assert!(!dest.exists(), "no final file should be left when source is missing");
    }

    #[test]
    fn test_copy_content_integrity_after_rename() {
        // Scenario: verify that the content written via tmp+rename is byte-identical
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.flac");
        let dest = dir.path().join("output/dest.flac");

        // Create a large-ish file with known pattern
        let data: Vec<u8> = (0..65536).map(|i| (i % 251) as u8).collect();
        std::fs::write(&source, &data).unwrap();

        let bytes = copy_file_verified(source.to_str().unwrap(), dest.to_str().unwrap()).unwrap();

        assert_eq!(bytes, 65536);
        let read_back = std::fs::read(&dest).unwrap();
        assert_eq!(read_back.len(), data.len(), "size must match");
        assert_eq!(read_back, data, "content must be byte-identical");
    }

    #[test]
    fn test_copy_creates_parent_dirs() {
        // Scenario: deeply nested destination — parent dirs are created automatically
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("src.flac");
        let dest = dir.path().join("Artist/Album Name/Disc 1/01 - Track.flac");

        std::fs::write(&source, "nested dir test").unwrap();

        copy_file_verified(source.to_str().unwrap(), dest.to_str().unwrap()).unwrap();

        assert!(dest.exists());
        assert!(dest.parent().unwrap().exists()); // Disc 1/
        assert!(dest.parent().unwrap().parent().unwrap().exists()); // Album Name/
    }

    #[test]
    fn test_copy_overwrite_existing_file() {
        // Scenario: re-sync overwrites an existing file cleanly
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("new_version.flac");
        let dest = dir.path().join("Artist/Album/01 - Track.flac");
        let tmp = dir.path().join("Artist/Album/01 - Track.flac.hean-tmp");

        // Create existing file (from previous sync)
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::write(&dest, "old content from previous sync").unwrap();

        // New version
        std::fs::write(&source, "new content updated version").unwrap();

        copy_file_verified(source.to_str().unwrap(), dest.to_str().unwrap()).unwrap();

        assert_eq!(
            std::fs::read_to_string(&dest).unwrap(),
            "new content updated version"
        );
        assert!(!tmp.exists(), "no .hean-tmp should remain after overwrite");
    }

    #[test]
    fn test_copy_large_file_integrity() {
        // Scenario: copy a multi-MB file and verify content integrity
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("large.flac");
        let dest = dir.path().join("out/large.flac");

        // 2 MB file with deterministic content
        let data: Vec<u8> = (0..2_097_152u64).map(|i| ((i * 7 + 13) % 256) as u8).collect();
        std::fs::write(&source, &data).unwrap();

        let bytes = copy_file_verified(source.to_str().unwrap(), dest.to_str().unwrap()).unwrap();

        assert_eq!(bytes, 2_097_152);
        let read_back = std::fs::read(&dest).unwrap();
        assert_eq!(read_back.len(), data.len());
        // Spot-check content at multiple offsets
        assert_eq!(read_back[0], data[0]);
        assert_eq!(read_back[1000], data[1000]);
        assert_eq!(read_back[500_000], data[500_000]);
        assert_eq!(read_back[2_097_151], data[2_097_151]);
    }

    #[test]
    fn test_cleanup_hean_tmp_deeply_nested() {
        // Scenario: .hean-tmp files scattered across many levels of nesting
        let dir = tempfile::tempdir().unwrap();

        // Create deep directory structure with tmp files at various levels
        let paths = [
            "Artist1/Album1/track.flac.hean-tmp",
            "Artist1/Album2/Disc 1/track.flac.hean-tmp",
            "Artist2/Album1/track.flac.hean-tmp",
            "Various Artists/OST/Disc 3/track.flac.hean-tmp",
        ];

        for path in &paths {
            let full = dir.path().join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(&full, "partial data").unwrap();
        }

        // Also create legitimate files that should NOT be touched
        let legit = dir.path().join("Artist1/Album1/01 - Real Track.flac");
        std::fs::write(&legit, "real audio").unwrap();
        let cover = dir.path().join("Artist1/Album1/cover.jpg");
        std::fs::write(&cover, "cover data").unwrap();
        let manifest = dir.path().join(".hean-sync.json");
        std::fs::write(&manifest, "{}").unwrap();

        let (count, _) = cleanup_hean_tmp(dir.path().to_str().unwrap());

        assert_eq!(count, 4, "should remove exactly 4 .hean-tmp files");
        assert!(legit.exists(), "real audio file must survive");
        assert!(cover.exists(), "cover must survive");
        assert!(manifest.exists(), "manifest must survive");
    }

    #[test]
    fn test_cleanup_hean_tmp_empty_dir() {
        // Scenario: cleanup on a volume with no .hean-tmp files
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("track.flac"), "audio").unwrap();

        let (count, bytes) = cleanup_hean_tmp(dir.path().to_str().unwrap());

        assert_eq!(count, 0);
        assert_eq!(bytes, 0);
    }

    #[test]
    fn test_cleanup_hean_tmp_nonexistent_dir() {
        // Scenario: cleanup on a path that doesn't exist (e.g. volume ejected)
        let (count, bytes) = cleanup_hean_tmp("/nonexistent/volume/path");

        assert_eq!(count, 0);
        assert_eq!(bytes, 0);
    }

    #[test]
    fn test_copy_creates_dirs_on_demand_not_upfront() {
        // Directories must only be created when a file is actually written into them.
        // Pre-creating dirs upfront leaves ghost entries on exFAT if the sync fails/cancels.
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.flac");
        std::fs::write(&source, "audio data").unwrap();

        // Copy a file — directory should be created on-demand
        let dest = dir.path().join("Artist/Album/01 - Track.flac");
        assert!(!dir.path().join("Artist").exists(), "dir should NOT exist before copy");

        copy_file_verified(source.to_str().unwrap(), dest.to_str().unwrap()).unwrap();

        assert!(dest.exists(), "file should be copied");
        assert!(dir.path().join("Artist/Album").exists(), "dir created by copy_file_verified");
    }

    #[test]
    fn test_copy_then_cleanup_simulates_crash_recovery() {
        // Scenario: simulate a crash mid-sync by manually creating .hean-tmp files,
        // then verify cleanup_hean_tmp removes them while preserving good files.
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.flac");
        std::fs::write(&source, "good audio data").unwrap();

        // Step 1: Successful copy of first file
        let dest1 = dir.path().join("Artist/Album/01 - Track.flac");
        copy_file_verified(source.to_str().unwrap(), dest1.to_str().unwrap()).unwrap();

        // Step 2: Simulate crash — manually create a .hean-tmp as if io::copy was interrupted
        let orphan_tmp = dir.path().join("Artist/Album/02 - Track.flac.hean-tmp");
        std::fs::write(&orphan_tmp, "partial wri").unwrap(); // truncated data

        // Step 3: Also simulate a .hean-tmp in another album dir
        let orphan_tmp2 = dir.path().join("Other Artist/Other Album/01 - Song.flac.hean-tmp");
        std::fs::create_dir_all(orphan_tmp2.parent().unwrap()).unwrap();
        std::fs::write(&orphan_tmp2, "").unwrap(); // zero-byte tmp

        // Verify crash state: both tmps exist, good file exists
        assert!(orphan_tmp.exists());
        assert!(orphan_tmp2.exists());
        assert!(dest1.exists());

        // Step 4: Simulate "next sync start" — cleanup runs
        let (count, _) = cleanup_hean_tmp(dir.path().to_str().unwrap());

        assert_eq!(count, 2, "both orphan .hean-tmp should be removed");
        assert!(!orphan_tmp.exists(), "orphan tmp should be gone");
        assert!(!orphan_tmp2.exists(), "zero-byte orphan tmp should be gone");
        assert!(dest1.exists(), "successfully copied file must survive cleanup");
        assert_eq!(
            std::fs::read_to_string(&dest1).unwrap(),
            "good audio data",
            "good file content must be intact"
        );
    }

    #[test]
    fn test_copy_sequential_files_no_tmp_accumulation() {
        // Scenario: copy multiple files sequentially — no .hean-tmp accumulates
        let dir = tempfile::tempdir().unwrap();

        for i in 1..=10 {
            let source = dir.path().join(format!("src_{}.flac", i));
            let dest = dir.path().join(format!("Artist/Album/{:02} - Track {}.flac", i, i));
            std::fs::write(&source, format!("audio content {}", i)).unwrap();
            copy_file_verified(source.to_str().unwrap(), dest.to_str().unwrap()).unwrap();
        }

        // Verify: all final files exist, no .hean-tmp files anywhere
        let (tmp_count, _) = cleanup_hean_tmp(dir.path().to_str().unwrap());
        assert_eq!(tmp_count, 0, "no .hean-tmp should remain after 10 successful copies");

        for i in 1..=10 {
            let dest = dir.path().join(format!("Artist/Album/{:02} - Track {}.flac", i, i));
            assert!(dest.exists(), "file {} should exist", i);
        }
    }

    #[test]
    fn test_copy_preserves_other_files_in_directory() {
        // Scenario: copying a file doesn't affect other files in the same directory
        let dir = tempfile::tempdir().unwrap();
        let album_dir = dir.path().join("Artist/Album");
        std::fs::create_dir_all(&album_dir).unwrap();

        // Pre-existing files from previous sync
        std::fs::write(album_dir.join("01 - Existing.flac"), "old track").unwrap();
        std::fs::write(album_dir.join("cover.jpg"), "cover art").unwrap();

        // Copy a new file into the same directory
        let source = dir.path().join("new_track.flac");
        std::fs::write(&source, "new track audio").unwrap();
        let dest = album_dir.join("02 - New Track.flac");
        copy_file_verified(source.to_str().unwrap(), dest.to_str().unwrap()).unwrap();

        // All files should be intact
        assert_eq!(
            std::fs::read_to_string(album_dir.join("01 - Existing.flac")).unwrap(),
            "old track"
        );
        assert_eq!(
            std::fs::read_to_string(album_dir.join("cover.jpg")).unwrap(),
            "cover art"
        );
        assert_eq!(
            std::fs::read_to_string(&dest).unwrap(),
            "new track audio"
        );
    }

    #[test]
    fn test_copy_dest_path_with_special_ascii_chars() {
        // Scenario: destination path with apostrophes and dashes — valid ASCII on all filesystems
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("src.flac");
        std::fs::write(&source, "test data").unwrap();

        let dest = dir.path().join("Rick James/Kickin' Deluxe/01 - Kickin'.flac");
        copy_file_verified(source.to_str().unwrap(), dest.to_str().unwrap()).unwrap();

        assert!(dest.exists(), "path with apostrophes should work");
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "test data");
    }

    #[test]
    fn test_copy_handles_blocked_dir_gracefully() {
        // Scenario: copy_file_verified returns an error when dir creation is blocked,
        // but does NOT leave ghost directories behind.
        let dir = tempfile::tempdir().unwrap();

        // Create a file where a directory should be → create_dir_all will fail
        let blocker = dir.path().join("BadDir");
        std::fs::write(&blocker, "file blocking dir creation").unwrap();

        let source = dir.path().join("real_source.flac");
        std::fs::write(&source, "valid audio data").unwrap();

        // This should fail (BadDir is a file, not a directory)
        let bad_dest = format!("{}/BadDir/Album/01 - Track.flac", dir.path().to_str().unwrap());
        let result = copy_file_verified(source.to_str().unwrap(), &bad_dest);
        assert!(result.is_err(), "should fail when parent dir can't be created");

        // Good copy should work independently
        let good_dest = format!("{}/GoodArtist/GoodAlbum/01 - Track.flac", dir.path().to_str().unwrap());
        copy_file_verified(source.to_str().unwrap(), &good_dest).unwrap();
        assert!(dir.path().join("GoodArtist/GoodAlbum/01 - Track.flac").exists());

        // No .hean-tmp should remain
        let (tmp_count, _) = cleanup_hean_tmp(dir.path().to_str().unwrap());
        assert_eq!(tmp_count, 0);
    }

    #[test]
    fn test_copy_zero_byte_file() {
        // Scenario: source is 0 bytes — should copy successfully without error
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("empty.flac");
        let dest = dir.path().join("out/empty.flac");
        std::fs::write(&source, "").unwrap();

        let bytes = copy_file_verified(source.to_str().unwrap(), dest.to_str().unwrap()).unwrap();

        assert_eq!(bytes, 0);
        assert!(dest.exists());
        assert_eq!(std::fs::read(&dest).unwrap().len(), 0);
    }

    #[test]
    fn test_copy_idempotent_same_content() {
        // Scenario: copying the same file twice produces the same result
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("src.flac");
        let dest = dir.path().join("out/track.flac");
        std::fs::write(&source, "deterministic content").unwrap();

        copy_file_verified(source.to_str().unwrap(), dest.to_str().unwrap()).unwrap();
        let content1 = std::fs::read_to_string(&dest).unwrap();

        copy_file_verified(source.to_str().unwrap(), dest.to_str().unwrap()).unwrap();
        let content2 = std::fs::read_to_string(&dest).unwrap();

        assert_eq!(content1, content2, "re-copy must produce identical content");
    }
}
