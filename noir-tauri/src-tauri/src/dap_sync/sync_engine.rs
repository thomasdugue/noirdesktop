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


/// Execute the sync plan: copy files, delete files, update manifest.
/// Runs in a spawned thread. Emits progress events via app_handle.
pub fn execute_sync(
    app_handle: &tauri::AppHandle,
    dest_path: &str,
    plan: &SyncPlan,
    old_manifest: &Option<SyncManifest>,
    folder_structure: &str,
    cancel_flag: Arc<AtomicBool>,
) -> Result<SyncComplete, String> {
    let start = Instant::now();
    let mut errors = Vec::new();
    let mut files_copied: usize = 0;
    let mut files_deleted: usize = 0;
    let mut total_bytes_copied: u64 = 0;
    let mut synced_files: Vec<SyncedFile> = Vec::new();

    // Build SMB mount map once for the entire sync operation
    let smb_map = build_smb_mount_map();

    let total_copy = plan.files_to_copy.len();
    let total_delete = plan.files_to_delete.len();

    // --- Phase 1: Delete files ---
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

    // --- Phase 2: Copy files ---
    let mut bytes_so_far: u64 = 0;

    for (i, action) in plan.files_to_copy.iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            // Write partial manifest before returning
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

        match copy_file_verified(&resolved_source, &full_dest) {
            Ok(bytes) => {
                files_copied += 1;
                total_bytes_copied += bytes;
                bytes_so_far += bytes;

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
                // Retry once
                match copy_file_verified(&resolved_source, &full_dest) {
                    Ok(bytes) => {
                        files_copied += 1;
                        total_bytes_copied += bytes;
                        bytes_so_far += bytes;
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
                        errors.push(format!("Copy failed: {} — {} (retry: {})", action.dest_relative_path, e, e2));
                    }
                }
            }
        }
    }

    // --- Phase 2b: Copy cover art ---
    let total_covers = plan.covers_to_copy.len();
    let mut covers_copied: usize = 0;

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

        match copy_file_verified(&cover.source_cover_path, &full_dest) {
            Ok(bytes) => {
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
            }
            Err(e) => {
                // Non-fatal: cover copy failure shouldn't abort sync
                eprintln!("[DAP-SYNC] Cover copy failed (non-fatal): {} — {}", cover.dest_relative_path, e);
            }
        }
    }

    #[cfg(debug_assertions)]
    if covers_copied > 0 {
        eprintln!("[DAP-SYNC] Copied {} cover files", covers_copied);
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
    write_manifest(dest_path, &new_manifest)?;

    let duration_ms = start.elapsed().as_millis() as u64;
    let success = errors.is_empty();

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

/// Copy a file with size verification and permission setting.
pub fn copy_file_verified(source: &str, dest: &str) -> Result<u64, String> {
    let source_path = Path::new(source);
    let dest_path = Path::new(dest);

    // Create parent directories
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create dirs for {}: {}", dest, e))?;
    }

    // Copy file
    let bytes = std::fs::copy(source_path, dest_path)
        .map_err(|e| format!("Failed to copy {} -> {}: {}", source, dest, e))?;

    // Verify size
    let source_size = std::fs::metadata(source_path)
        .map(|m| m.len())
        .unwrap_or(0);

    let dest_size = std::fs::metadata(dest_path)
        .map(|m| m.len())
        .unwrap_or(0);

    if dest_size != source_size {
        return Err(format!(
            "Size mismatch after copy: source={} dest={} ({} vs {} bytes)",
            source, dest, source_size, dest_size
        ));
    }

    // Set permissions to readable (644)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o644);
        let _ = std::fs::set_permissions(dest_path, perms);
    }

    Ok(bytes)
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
