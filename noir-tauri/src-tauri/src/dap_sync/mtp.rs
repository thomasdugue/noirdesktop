// === MTP (Media Transfer Protocol) sync module ===
// Bypasses macOS exFAT driver entirely — the DAP's firmware writes to its own storage.
// No ghost directories, no data corruption.

use serde::Serialize;

/// Info about a detected MTP device (DAP connected via USB)
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MtpDeviceInfo {
    pub manufacturer: String,
    pub model: String,
    pub serial: String,
    pub storages: Vec<MtpStorageInfo>,
}

/// Info about a storage unit on the MTP device (internal memory or SD card)
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MtpStorageInfo {
    pub id: String,
    pub description: String,
    pub capacity_bytes: u64,
    pub free_bytes: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MtpFileEntry {
    pub name: String,
    pub is_folder: bool,
    pub size_bytes: u64,
}

/// Kill processes that claim MTP devices on macOS.
/// Uses -9 (SIGKILL) because ptpcamerad respawns immediately after SIGTERM.
/// Called before every MTP operation.
fn kill_mtp_claimers() {
    // SIGKILL ptpcamerad — macOS daemon that claims MTP/PTP devices
    let _ = std::process::Command::new("pkill")
        .args(["-9", "-f", "ptpcamerad"])
        .output();
    // Also kill Android File Transfer if running
    let _ = std::process::Command::new("pkill")
        .args(["-9", "-f", "Android File Transfer"])
        .output();
}

/// Detect connected MTP devices (DAPs via USB).
/// Opens a connection, reads info, then DROPS the connection immediately.
pub async fn detect_mtp_devices() -> Result<Vec<MtpDeviceInfo>, String> {
    kill_mtp_claimers();
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    // Kill again in case launchd respawned ptpcamerad during the wait
    kill_mtp_claimers();
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    eprintln!("[MTP] Scanning for MTP devices...");

    let device = match mtp_rs::MtpDevice::open_first().await {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[MTP] No MTP device found: {}", e);
            return Ok(vec![]);
        }
    };

    // Clone all data we need BEFORE dropping device
    let manufacturer = device.device_info().manufacturer.clone();
    let model = device.device_info().model.clone();
    let serial = device.device_info().serial_number.clone();

    eprintln!("[MTP] Device found: {} {} (serial: {})", manufacturer, model, serial);

    let storages = device.storages().await
        .map_err(|e| format!("Failed to list storages: {}", e))?;

    let mut storage_infos = Vec::new();
    for storage in &storages {
        let si = storage.info();
        eprintln!("[MTP]   Storage: {} ({} free / {} total)",
            si.description,
            format_bytes(si.free_space_bytes),
            format_bytes(si.max_capacity));
        storage_infos.push(MtpStorageInfo {
            id: format!("{:?}", storage.id()),
            description: si.description.clone(),
            capacity_bytes: si.max_capacity,
            free_bytes: si.free_space_bytes,
        });
    }

    // Explicitly drop storages and device to release the USB connection
    drop(storages);
    drop(device);
    eprintln!("[MTP] Device connection released");

    Ok(vec![MtpDeviceInfo {
        manufacturer,
        model,
        serial,
        storages: storage_infos,
    }])
}

/// All-in-one test: connect, list storages, list root files, try to upload a test file.
/// Single connection — avoids exclusive access issues from multiple open_first() calls.
pub async fn mtp_test_all(source_path: &str) -> Result<String, String> {
    kill_mtp_claimers();
    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;

    let mut report = String::new();

    let device = mtp_rs::MtpDevice::open_first().await
        .map_err(|e| format!("MTP device not found: {}", e))?;
    let info = device.device_info();
    report.push_str(&format!("Device: {} {}\n", info.manufacturer, info.model));

    let storages = device.storages().await
        .map_err(|e| format!("Failed to list storages: {}", e))?;
    report.push_str(&format!("Storages: {}\n", storages.len()));

    for (i, storage) in storages.iter().enumerate() {
        let si = storage.info();
        report.push_str(&format!("  [{}] {} — {:.1} GB free / {:.1} GB total\n",
            i, si.description,
            si.free_space_bytes as f64 / 1e9,
            si.max_capacity as f64 / 1e9));

        // List root objects
        match storage.list_objects(None).await {
            Ok(objects) => {
                report.push_str(&format!("  Root objects: {}\n", objects.len()));
                for obj in objects.iter().take(15) {
                    let kind = if obj.is_folder() { "DIR " } else { "FILE" };
                    report.push_str(&format!("    {} {} ({})\n", kind, obj.filename, obj.size));
                }
                if objects.len() > 15 {
                    report.push_str(&format!("    ... and {} more\n", objects.len() - 15));
                }
            }
            Err(e) => {
                report.push_str(&format!("  List objects failed: {}\n", e));
            }
        }

        // Try upload inside the "Music" folder (upload to root fails on many Android MTP devices)
        if std::path::Path::new(source_path).exists() {
            // Find the "Music" folder handle
            if let Ok(ref objects) = storage.list_objects(None).await {
                let music_folder = objects.iter().find(|o| o.is_folder() && o.filename == "Music");

                if let Some(music) = music_folder {
                    let file_bytes = tokio::fs::read(source_path).await
                        .map_err(|e| format!("Failed to read source: {}", e))?;
                    let file_size = file_bytes.len() as u64;
                    let filename = std::path::Path::new(source_path)
                        .file_name()
                        .map(|f| f.to_string_lossy().to_string())
                        .unwrap_or_else(|| "test.flac".into());

                    report.push_str(&format!("  Upload test (into Music/): {} ({} bytes)...\n", filename, file_size));

                    let file_info = mtp_rs::mtp::NewObjectInfo::file(&filename, file_size);
                    let data_stream = futures::stream::iter(vec![
                        Ok::<_, std::io::Error>(bytes::Bytes::from(file_bytes))
                    ]);

                    // Upload INTO Music folder (not root)
                    match storage.upload(Some(music.handle), file_info, Box::pin(data_stream)).await {
                        Ok(handle) => {
                            report.push_str(&format!("  UPLOAD OK! Handle: {:?}\n", handle));
                            // Clean up
                            match storage.delete(handle).await {
                                Ok(()) => report.push_str("  Cleanup OK (test file deleted)\n"),
                                Err(e) => report.push_str(&format!("  Cleanup failed: {}\n", e)),
                            }
                        }
                        Err(e) => {
                            report.push_str(&format!("  UPLOAD FAILED (in Music/): {}\n", e));
                        }
                    }
                } else {
                    report.push_str("  No 'Music' folder found — skipping upload test\n");
                }
            }
        }
    }

    drop(storages);
    drop(device);

    eprintln!("[MTP TEST]\n{}", report);
    Ok(report)
}

/// Send a single file to the MTP device.
pub async fn mtp_send_file(source_path: &str, dest_folder: &str, dest_filename: &str, storage_index: usize) -> Result<u64, String> {
    kill_mtp_claimers();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    let device = mtp_rs::MtpDevice::open_first().await
        .map_err(|e| format!("MTP device not found: {}", e))?;

    let storages = device.storages().await
        .map_err(|e| format!("Failed to list storages: {}", e))?;

    let storage = storages.get(storage_index)
        .ok_or_else(|| format!("Storage index {} not found", storage_index))?;

    eprintln!("[MTP] Sending file: {} → {}/{}", source_path, dest_folder, dest_filename);

    let folder_handle = find_or_create_folder(storage, dest_folder).await?;

    let file_bytes = tokio::fs::read(source_path).await
        .map_err(|e| format!("Failed to read source file: {}", e))?;
    let file_size = file_bytes.len() as u64;

    let file_info = mtp_rs::mtp::NewObjectInfo::file(dest_filename, file_size);
    let data_stream = futures::stream::iter(vec![
        Ok::<_, std::io::Error>(bytes::Bytes::from(file_bytes))
    ]);

    let _handle = storage.upload(Some(folder_handle), file_info, Box::pin(data_stream)).await
        .map_err(|e| format!("MTP upload failed: {}", e))?;

    eprintln!("[MTP] File sent: {}/{} ({} bytes)", dest_folder, dest_filename, file_size);
    Ok(file_size)
}

async fn find_or_create_folder(storage: &mtp_rs::mtp::Storage, folder_name: &str) -> Result<mtp_rs::ptp::ObjectHandle, String> {
    let objects = storage.list_objects(None).await
        .map_err(|e| format!("Failed to list objects: {}", e))?;

    for obj in &objects {
        if obj.is_folder() && obj.filename == folder_name {
            return Ok(obj.handle);
        }
    }

    storage.create_folder(None, folder_name).await
        .map_err(|e| format!("Failed to create folder '{}': {}", folder_name, e))
}

/// List files on the MTP device storage root.
pub async fn mtp_list_files(storage_index: usize) -> Result<Vec<MtpFileEntry>, String> {
    kill_mtp_claimers();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    let device = mtp_rs::MtpDevice::open_first().await
        .map_err(|e| format!("MTP device not found: {}", e))?;

    let storages = device.storages().await
        .map_err(|e| format!("Failed to list storages: {}", e))?;

    let storage = storages.get(storage_index)
        .ok_or_else(|| format!("Storage index {} not found", storage_index))?;

    let objects = storage.list_objects(None).await
        .map_err(|e| format!("Failed to list objects: {}", e))?;

    Ok(objects.iter().map(|obj| MtpFileEntry {
        name: obj.filename.clone(),
        is_folder: obj.is_folder(),
        size_bytes: obj.size as u64,
    }).collect())
}

/// Sync a batch of files via MTP — single connection for all files.
/// Each file has a source_path (local or SMB-resolved) and a dest_relative_path (e.g. "Artist - Album/01 - Track.flac").
/// Files are uploaded into the "Music" folder on the target storage.
/// Returns (files_copied, total_bytes, errors).
pub async fn mtp_sync_batch(
    files: Vec<(String, String)>, // (source_path, dest_relative_path)
    storage_index: usize,
    progress_callback: impl Fn(usize, usize, &str), // (current, total, current_file)
    cancel_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<(usize, u64, Vec<String>), String> {
    kill_mtp_claimers();
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let device = mtp_rs::MtpDevice::open_first().await
        .map_err(|e| format!("MTP device not found: {}", e))?;

    let storages = device.storages().await
        .map_err(|e| format!("Failed to list storages: {}", e))?;

    let storage = storages.get(storage_index)
        .ok_or_else(|| format!("Storage index {} not found (have {})", storage_index, storages.len()))?;

    // Find the "Music" folder — required as root-level uploads fail on Android MTP
    let root_objects = storage.list_objects(None).await
        .map_err(|e| format!("Failed to list root objects: {}", e))?;

    let music_handle = root_objects.iter()
        .find(|o| o.is_folder() && o.filename == "Music")
        .map(|o| o.handle)
        .ok_or_else(|| "No 'Music' folder found on device. Please create a 'Music' folder on the SD card.".to_string())?;

    // --- PRE-SYNC SCAN: list existing files on device to skip duplicates ---
    eprintln!("[MTP] Scanning existing files on device...");
    let mut existing_files: std::collections::HashSet<String> = std::collections::HashSet::new();
    scan_mtp_folder_recursive(storage, music_handle, "", &mut existing_files).await;
    eprintln!("[MTP] Found {} existing files on device", existing_files.len());

    // Filter: only copy files that don't already exist on the device
    let files_to_copy: Vec<&(String, String)> = files.iter()
        .filter(|(_, dest_rel)| !existing_files.contains(dest_rel))
        .collect();
    let already_on_device = files.len() - files_to_copy.len();

    if already_on_device > 0 {
        eprintln!("[MTP] {} files already on device (skipping), {} files to copy",
            already_on_device, files_to_copy.len());
    }

    eprintln!("[MTP] Starting batch sync: {} files to copy into Music/ on storage {}",
        files_to_copy.len(), storage_index);

    let total = files.len();
    let total_to_copy = files_to_copy.len();
    let mut copied = 0usize;
    let mut skipped = already_on_device;
    let mut total_bytes = 0u64;
    let mut errors = Vec::new();
    // Folders to skip after a session error (timeout/Transaction ID mismatch)
    let mut poisoned_folders: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Cache of created folder handles (folder_name → handle)
    let mut folder_cache: std::collections::HashMap<String, mtp_rs::ptp::ObjectHandle> = std::collections::HashMap::new();

    // Pre-populate with existing folders inside Music/
    if let Ok(music_contents) = storage.list_objects(Some(music_handle)).await {
        for obj in &music_contents {
            if obj.is_folder() {
                folder_cache.insert(obj.filename.clone(), obj.handle);
            }
        }
    }

    for (i, (source_path, dest_rel)) in files_to_copy.iter().enumerate() {
        // Check cancel flag before each file
        if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
            eprintln!("[MTP] Sync cancelled by user after {} files", copied);
            drop(storages);
            drop(device);
            return Ok((copied + skipped, total_bytes, vec!["Sync cancelled by user".into()]));
        }

        // Parse dest_rel: "Artist - Album/01 - Track.flac" → folder="Artist - Album", file="01 - Track.flac"
        // Or "Artist - Album/Disc 1/01 - Track.flac" → we need nested folders
        let parts: Vec<&str> = dest_rel.split('/').collect();
        let (folder_path, filename) = if parts.len() >= 2 {
            let fname = parts[parts.len() - 1];
            let fpath = parts[..parts.len() - 1].join("/");
            (fpath, fname.to_string())
        } else {
            ("".to_string(), dest_rel.clone())
        };

        // Skip files in folders where a previous upload caused a session error
        if poisoned_folders.contains(&folder_path) {
            errors.push(format!("{} — Skipped (MTP session error on previous file in this folder)", dest_rel));
            continue;
        }

        progress_callback(already_on_device + i + 1, total, dest_rel);

        // Find or create the target folder hierarchy inside Music/
        let target_handle = if folder_path.is_empty() {
            music_handle
        } else {
            match get_or_create_nested_folder(storage, music_handle, &folder_path, &mut folder_cache).await {
                Ok(h) => h,
                Err(e) => {
                    errors.push(format!("{} — Failed to create folder: {}", dest_rel, e));
                    eprintln!("[MTP] Folder creation failed for {}: {}", dest_rel, e);
                    continue;
                }
            }
        };

        // Read source file
        let file_bytes = match tokio::fs::read(&source_path).await {
            Ok(b) => b,
            Err(e) => {
                errors.push(format!("{} — Source file not found: {}", dest_rel, e));
                eprintln!("[MTP] Source read failed: {} — {}", source_path, e);
                continue;
            }
        };
        let file_size = file_bytes.len() as u64;

        // Upload with retry. GeneralError during SendObjectInfo usually means
        // the file already exists on the device (MTP doesn't overwrite).
        let file_info = mtp_rs::mtp::NewObjectInfo::file(&filename, file_size);
        let data_stream = futures::stream::iter(vec![
            Ok::<_, std::io::Error>(bytes::Bytes::from(file_bytes))
        ]);

        match storage.upload(Some(target_handle), file_info, Box::pin(data_stream)).await {
            Ok(_handle) => {
                copied += 1;
                total_bytes += file_size;
                if copied % 10 == 0 {
                    eprintln!("[MTP] Progress: {}/{} files ({:.1} GB)", copied, total,
                        total_bytes as f64 / 1_073_741_824.0);
                }
            }
            Err(e) => {
                let err_str = format!("{}", e);
                if err_str.contains("GeneralError") {
                    // GeneralError = file already exists on device → treat as "already synced"
                    skipped += 1;
                    if skipped <= 3 {
                        eprintln!("[MTP] Already on device (skipped): {}", dest_rel);
                    } else if skipped == 4 {
                        eprintln!("[MTP] ... (suppressing further 'already on device' messages)");
                    }
                } else if err_str.contains("Transaction ID mismatch") || err_str.contains("timed out") {
                    // Timeout or Transaction ID mismatch = MTP session may be corrupted.
                    // Poison this folder so remaining files in it are skipped.
                    // Files in OTHER folders will still be attempted (the session
                    // often recovers after a short pause between albums).
                    errors.push(format!("{} — MTP upload timed out", dest_rel));
                    eprintln!("[MTP] TIMEOUT: {} — poisoning folder '{}' (remaining files will be skipped)", dest_rel, folder_path);
                    poisoned_folders.insert(folder_path.clone());

                    // Brief pause to let the MTP device recover before next album
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                } else {
                    // Real error — retry once with fresh file read
                    eprintln!("[MTP] Upload error for {}: {} — retrying...", filename, e);
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

                    if let Ok(retry_bytes) = tokio::fs::read(&source_path).await {
                        let file_info2 = mtp_rs::mtp::NewObjectInfo::file(&filename, retry_bytes.len() as u64);
                        let data_stream2 = futures::stream::iter(vec![
                            Ok::<_, std::io::Error>(bytes::Bytes::from(retry_bytes))
                        ]);
                        match storage.upload(Some(target_handle), file_info2, Box::pin(data_stream2)).await {
                            Ok(_) => {
                                copied += 1;
                                total_bytes += file_size;
                            }
                            Err(e2) => {
                                errors.push(format!("{} — MTP upload failed: {}", dest_rel, e2));
                                eprintln!("[MTP] Upload FAILED: {} — {}", dest_rel, e2);
                            }
                        }
                    } else {
                        errors.push(format!("{} — Failed to re-read source for retry", dest_rel));
                    }
                }
            }
        }
    }

    drop(storages);
    drop(device);

    eprintln!("[MTP] Batch sync complete: {}/{} files copied, {} already on device, ({:.1} GB), {} errors",
        copied, total, skipped, total_bytes as f64 / 1_073_741_824.0, errors.len());

    // Include skipped count in copied (they're already on device = success)
    Ok((copied + skipped, total_bytes, errors))
}

/// Navigate/create a nested folder path inside a parent (e.g. "Artist - Album/Disc 1").
async fn get_or_create_nested_folder(
    storage: &mtp_rs::mtp::Storage,
    parent_handle: mtp_rs::ptp::ObjectHandle,
    folder_path: &str,
    cache: &mut std::collections::HashMap<String, mtp_rs::ptp::ObjectHandle>,
) -> Result<mtp_rs::ptp::ObjectHandle, String> {
    let parts: Vec<&str> = folder_path.split('/').collect();
    let mut current_handle = parent_handle;
    let mut built_path = String::new();

    for part in &parts {
        if !built_path.is_empty() { built_path.push('/'); }
        built_path.push_str(part);

        if let Some(&handle) = cache.get(&built_path) {
            current_handle = handle;
            continue;
        }

        // Check if folder exists
        let objects = storage.list_objects(Some(current_handle)).await
            .map_err(|e| format!("Failed to list {}: {}", built_path, e))?;

        if let Some(existing) = objects.iter().find(|o| o.is_folder() && o.filename == *part) {
            cache.insert(built_path.clone(), existing.handle);
            current_handle = existing.handle;
        } else {
            // Create folder, then re-list parent to get a valid handle.
            // Some Android MTP devices reject uploads using the handle returned by create_folder
            // (GeneralError on SendObjectInfo). Re-listing gives a handle that works.
            let _create_handle = storage.create_folder(Some(current_handle), part).await
                .map_err(|e| format!("Failed to create folder '{}': {}", built_path, e))?;
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;

            // Re-list parent to get the "real" handle for the new folder
            let refreshed = storage.list_objects(Some(current_handle)).await
                .map_err(|e| format!("Failed to re-list after creating {}: {}", built_path, e))?;
            let new_handle = refreshed.iter()
                .find(|o| o.is_folder() && o.filename == *part)
                .map(|o| o.handle)
                .ok_or_else(|| format!("Folder '{}' created but not found in re-list", built_path))?;
            cache.insert(built_path.clone(), new_handle);
            current_handle = new_handle;
            eprintln!("[MTP] Created folder: Music/{}", built_path);
        }
    }

    Ok(current_handle)
}

/// Delete files from MTP device by dest_relative_path, then remove empty folders.
/// Returns (files_deleted, errors).
pub async fn mtp_delete_files(
    files_to_delete: &[String],  // dest_relative_paths e.g. "Artist - Album/01 - Track.flac"
    storage_index: usize,
    progress_callback: impl Fn(usize, usize, &str),
    cancel_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<(usize, Vec<String>), String> {
    kill_mtp_claimers();
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let device = mtp_rs::MtpDevice::open_first().await
        .map_err(|e| format!("MTP device not found: {}", e))?;

    let storages = device.storages().await
        .map_err(|e| format!("Failed to list storages: {}", e))?;

    let storage = storages.get(storage_index)
        .ok_or_else(|| format!("Storage index {} not found", storage_index))?;

    // Find Music/ folder
    let root_objects = storage.list_objects(None).await
        .map_err(|e| format!("Failed to list root: {}", e))?;

    let music_handle = match root_objects.iter().find(|o| o.is_folder() && o.filename == "Music") {
        Some(o) => o.handle,
        None => {
            eprintln!("[MTP] No Music/ folder — nothing to delete");
            drop(storages);
            drop(device);
            return Ok((0, vec![]));
        }
    };

    // Build a map of dest_relative_path → ObjectHandle by scanning Music/ recursively
    let mut path_to_handle: std::collections::HashMap<String, mtp_rs::ptp::ObjectHandle> = std::collections::HashMap::new();
    scan_mtp_handles_recursive(storage, music_handle, "", &mut path_to_handle).await;

    let total = files_to_delete.len();
    let mut deleted = 0usize;
    let mut errors = Vec::new();
    // Track parent folders of deleted files for empty-folder cleanup
    let mut affected_folders: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Track folders that need handle refresh after InvalidObjectHandle errors
    let mut stale_folders: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (i, dest_rel) in files_to_delete.iter().enumerate() {
        if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
            errors.push("Delete cancelled by user".into());
            break;
        }

        progress_callback(i + 1, total, dest_rel);

        // If this file's parent folder had stale handles, re-scan it
        let parent_folder = dest_rel.rfind('/').map(|pos| &dest_rel[..pos]);
        if let Some(folder) = parent_folder {
            if stale_folders.contains(folder) {
                // Re-scan this folder to get fresh handles
                stale_folders.remove(folder);
                // Find the folder handle — walk from Music/ down
                if let Some(folder_handle) = find_folder_handle(storage, music_handle, folder).await {
                    // Re-scan just this folder's contents
                    if let Ok(objects) = storage.list_objects(Some(folder_handle)).await {
                        for obj in &objects {
                            if !obj.is_folder() {
                                let full_path = format!("{}/{}", folder, obj.filename);
                                path_to_handle.insert(full_path, obj.handle);
                            }
                        }
                    }
                }
            }
        }

        if let Some(&handle) = path_to_handle.get(dest_rel.as_str()) {
            match storage.delete(handle).await {
                Ok(()) => {
                    deleted += 1;
                    // Track parent folder
                    if let Some(pos) = dest_rel.rfind('/') {
                        affected_folders.insert(dest_rel[..pos].to_string());
                    }
                }
                Err(e) => {
                    let err_str = format!("{}", e);
                    if err_str.contains("InvalidObjectHandle") {
                        // Handle went stale after other deletes — mark folder for re-scan
                        // and retry this file with a fresh handle
                        if let Some(folder) = parent_folder {
                            if let Some(folder_handle) = find_folder_handle(storage, music_handle, folder).await {
                                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                                if let Ok(objects) = storage.list_objects(Some(folder_handle)).await {
                                    let filename = dest_rel.rsplit('/').next().unwrap_or(dest_rel);
                                    if let Some(fresh_obj) = objects.iter().find(|o| !o.is_folder() && o.filename == filename) {
                                        // Retry delete with fresh handle
                                        match storage.delete(fresh_obj.handle).await {
                                            Ok(()) => {
                                                deleted += 1;
                                                affected_folders.insert(folder.to_string());
                                                // Update remaining handles from this folder
                                                for obj in &objects {
                                                    if !obj.is_folder() {
                                                        let full_path = format!("{}/{}", folder, obj.filename);
                                                        path_to_handle.insert(full_path, obj.handle);
                                                    }
                                                }
                                                continue;
                                            }
                                            Err(e2) => {
                                                let msg = format!("{} — delete retry failed: {}", dest_rel, e2);
                                                eprintln!("[MTP] {}", msg);
                                                errors.push(msg);
                                            }
                                        }
                                    } else {
                                        // File not found after re-scan — likely already deleted by device
                                        eprintln!("[MTP] {} — gone after re-scan (already deleted)", dest_rel);
                                        deleted += 1;
                                        affected_folders.insert(folder.to_string());
                                    }
                                }
                            }
                            stale_folders.insert(folder.to_string());
                        }
                    } else {
                        let msg = format!("{} — delete failed: {}", dest_rel, e);
                        eprintln!("[MTP] {}", msg);
                        errors.push(msg);
                    }
                }
            }
        } else {
            // File not found on device — already deleted or never uploaded
            eprintln!("[MTP] Delete skip (not found): {}", dest_rel);
        }
    }

    eprintln!("[MTP] Deleted {}/{} files, {} errors", deleted, total, errors.len());

    // --- Cleanup empty folders ---
    // Re-scan to find empty folders and delete them bottom-up.
    // Wait for MTP device to update its directory index after deletions.
    if !affected_folders.is_empty() {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let empty_deleted = cleanup_empty_mtp_folders(storage, music_handle).await;
        if empty_deleted > 0 {
            eprintln!("[MTP] Cleaned up {} empty folders", empty_deleted);
        }
    }

    drop(storages);
    drop(device);
    eprintln!("[MTP] Device connection released");

    Ok((deleted, errors))
}

/// Walk from a parent folder down a path like "Artist - Album/Disc 1" to find the leaf folder handle.
async fn find_folder_handle(
    storage: &mtp_rs::mtp::Storage,
    parent_handle: mtp_rs::ptp::ObjectHandle,
    folder_path: &str,
) -> Option<mtp_rs::ptp::ObjectHandle> {
    let parts: Vec<&str> = folder_path.split('/').collect();
    let mut current = parent_handle;

    for part in &parts {
        let objects = storage.list_objects(Some(current)).await.ok()?;
        current = objects.iter()
            .find(|o| o.is_folder() && o.filename == *part)?
            .handle;
    }

    Some(current)
}

/// Recursively scan MTP folder and build path → ObjectHandle map.
/// Also stores folder handles (prefixed with "/" sentinel) for folder cleanup.
async fn scan_mtp_handles_recursive(
    storage: &mtp_rs::mtp::Storage,
    folder_handle: mtp_rs::ptp::ObjectHandle,
    prefix: &str,
    map: &mut std::collections::HashMap<String, mtp_rs::ptp::ObjectHandle>,
) {
    let objects = match storage.list_objects(Some(folder_handle)).await {
        Ok(objs) => objs,
        Err(e) => {
            // Log error — don't silently skip (causes files to be "not found" during delete)
            eprintln!("[MTP] WARNING: scan failed for folder '{}': {} — retrying once",
                if prefix.is_empty() { "Music/" } else { prefix }, e);
            // Retry once after short delay (MTP device may be busy)
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            match storage.list_objects(Some(folder_handle)).await {
                Ok(objs) => objs,
                Err(e2) => {
                    eprintln!("[MTP] WARNING: scan retry FAILED for '{}': {} — files in this folder will not be deletable",
                        prefix, e2);
                    return;
                }
            }
        }
    };

    for obj in &objects {
        let path = if prefix.is_empty() {
            obj.filename.clone()
        } else {
            format!("{}/{}", prefix, obj.filename)
        };

        if obj.is_folder() {
            Box::pin(scan_mtp_handles_recursive(storage, obj.handle, &path, map)).await;
        } else {
            map.insert(path, obj.handle);
        }
    }
}

/// Delete empty folders inside Music/ recursively (bottom-up).
/// Returns count of deleted folders.
async fn cleanup_empty_mtp_folders(
    storage: &mtp_rs::mtp::Storage,
    music_handle: mtp_rs::ptp::ObjectHandle,
) -> usize {
    let mut deleted = 0;

    // List all children of Music/
    let children = match storage.list_objects(Some(music_handle)).await {
        Ok(c) => c,
        Err(_) => return 0,
    };

    for child in &children {
        if child.is_folder() {
            // Recursively clean subfolder first
            deleted += Box::pin(cleanup_empty_mtp_folders(storage, child.handle)).await;

            // Re-list to check if now empty (after recursive cleanup)
            if let Ok(contents) = storage.list_objects(Some(child.handle)).await {
                if contents.is_empty() {
                    if let Ok(()) = storage.delete(child.handle).await {
                        eprintln!("[MTP] Removed empty folder: {}", child.filename);
                        deleted += 1;
                    }
                }
            }
        }
    }

    deleted
}

/// Recursively scan an MTP folder and collect all file paths relative to the scan root.
/// E.g., scanning Music/ with subfolders "Artist - Album/01 - Track.flac"
/// adds "Artist - Album/01 - Track.flac" to the set.
async fn scan_mtp_folder_recursive(
    storage: &mtp_rs::mtp::Storage,
    folder_handle: mtp_rs::ptp::ObjectHandle,
    prefix: &str,
    files: &mut std::collections::HashSet<String>,
) {
    let objects = match storage.list_objects(Some(folder_handle)).await {
        Ok(objs) => objs,
        Err(e) => {
            eprintln!("[MTP] Scan error listing {}: {}", if prefix.is_empty() { "root" } else { prefix }, e);
            return;
        }
    };

    for obj in &objects {
        let path = if prefix.is_empty() {
            obj.filename.clone()
        } else {
            format!("{}/{}", prefix, obj.filename)
        };

        if obj.is_folder() {
            // Recurse into subdirectory
            Box::pin(scan_mtp_folder_recursive(storage, obj.handle, &path, files)).await;
        } else {
            files.insert(path);
        }
    }
}

/// Scan the Music/ folder on an MTP device and return all file paths (relative to Music/).
/// Used by sync plan computation to verify manifest against actual device contents.
pub async fn scan_mtp_device_files(storage_index: usize) -> Result<std::collections::HashSet<String>, String> {
    kill_mtp_claimers();
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let device = mtp_rs::MtpDevice::open_first().await
        .map_err(|e| format!("MTP device not found: {}", e))?;

    let storages = device.storages().await
        .map_err(|e| format!("Failed to list storages: {}", e))?;

    let storage = storages.get(storage_index)
        .ok_or_else(|| format!("Storage index {} not found (have {})", storage_index, storages.len()))?;

    let root_objects = storage.list_objects(None).await
        .map_err(|e| format!("Failed to list root objects: {}", e))?;

    let music_handle = match root_objects.iter()
        .find(|o| o.is_folder() && o.filename == "Music")
        .map(|o| o.handle)
    {
        Some(h) => h,
        None => {
            // No Music folder → device is empty (e.g. after format)
            eprintln!("[MTP] No Music folder on device — treating as empty");
            return Ok(std::collections::HashSet::new());
        }
    };

    let mut files = std::collections::HashSet::new();
    scan_mtp_folder_recursive(storage, music_handle, "", &mut files).await;
    eprintln!("[MTP] Device scan for plan: {} files found on device", files.len());
    Ok(files)
}

fn format_bytes(bytes: u64) -> String {
    if bytes >= 1_073_741_824 {
        format!("{:.1} GB", bytes as f64 / 1_073_741_824.0)
    } else if bytes >= 1_048_576 {
        format!("{:.1} MB", bytes as f64 / 1_048_576.0)
    } else {
        format!("{} KB", bytes / 1024)
    }
}
