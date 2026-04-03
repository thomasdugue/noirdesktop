// === MTP (Media Transfer Protocol) sync module ===
// Bypasses macOS exFAT driver entirely — the DAP's firmware writes to its own storage.
// No ghost directories, no data corruption.
//
// KEY DESIGN DECISIONS:
// 1. NO tokio::time::timeout around storage.upload() — mtp-rs v0.4.0+ has a built-in
//    30s bulk transfer timeout (NusbTransport::DEFAULT_TIMEOUT) that keeps USB transfers
//    PENDING on timeout (cancel-safe). Wrapping with tokio timeout DROPS the Future,
//    cancels the USB transfer, and corrupts the MTP Transaction ID.
// 2. ptpcamerad suppressor — macOS respawns ptpcamerad within ~100ms after SIGKILL.
//    A single kill is never enough. We run a background kill loop during MTP operations.
// 3. Automatic session reconnection with exponential backoff after timeouts.

use serde::Serialize;
use once_cell::sync::Lazy;
use tokio::sync::Mutex as TokioMutex;

/// Global MTP lock — only one MTP operation at a time (USB exclusive access).
/// Prevents detect/scan/sync from running concurrently and corrupting the USB session.
/// NOTE: mtp_sync_batch holds this lock for the ENTIRE sync duration, including wave breaks
/// (up to 5 min waiting for USB replug). detect_mtp_devices will block during this time.
/// This is intentional — the JS frontend guards against false disconnection:
///   (1) volume_change listener skips when isSyncing
///   (2) openSyncPanel goes to syncing view without mount check when isSyncing
///   (3) computeAndRenderSummary skips MTP plan recompute during sync
static MTP_LOCK: Lazy<TokioMutex<()>> = Lazy::new(|| TokioMutex::new(()));

/// Properly close an MTP device by sending PTP CloseSession before dropping.
/// Without this, the DAP firmware may not flush its write cache or trigger
/// a media library rescan — files uploaded successfully won't appear.
async fn close_mtp_device(device: mtp_rs::MtpDevice) {
    match device.close().await {
        Ok(()) => eprintln!("[MTP] Session closed (CloseSession sent)"),
        Err(e) => eprintln!("[MTP] CloseSession failed (device dropped anyway): {}", e),
    }
}

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

/// Start a background thread that continuously kills ptpcamerad every 200ms.
/// macOS respawns ptpcamerad within ~100ms after SIGKILL, so a single kill
/// is never enough — the daemon reclaims the USB device before we can open it.
/// Returns a stop flag: set it to true to stop the kill loop.
fn start_ptpcamerad_suppressor() -> std::sync::Arc<std::sync::atomic::AtomicBool> {
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_clone = stop.clone();
    std::thread::spawn(move || {
        while !stop_clone.load(std::sync::atomic::Ordering::SeqCst) {
            let _ = std::process::Command::new("pkill")
                .args(["-9", "-f", "ptpcamerad"])
                .output();
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    });
    stop
}

/// RAII guard that stops the ptpcamerad suppressor when dropped.
/// Used for the global suppressor in mtp_sync_batch — ensures the kill loop
/// stops on every exit path (early returns, errors, cancellation, normal completion).
struct SuppressorGuard(std::sync::Arc<std::sync::atomic::AtomicBool>);
impl Drop for SuppressorGuard {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Track last detection result to suppress duplicate log messages.
static LAST_DETECT_STATE: Lazy<TokioMutex<Option<String>>> = Lazy::new(|| TokioMutex::new(None));

/// Detect connected MTP devices (DAPs via USB).
/// Opens a connection, reads info, then DROPS the connection immediately.
/// Logs are suppressed when the result hasn't changed since last call.
pub async fn detect_mtp_devices() -> Result<Vec<MtpDeviceInfo>, String> {
    let _lock = MTP_LOCK.lock().await;

    // Start background kill loop that keeps ptpcamerad dead
    let suppressor_stop = start_ptpcamerad_suppressor();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let mut device_opt = None;
    for attempt in 0..3 {
        match tokio::time::timeout(
            std::time::Duration::from_secs(5),
            mtp_rs::MtpDevice::open_first()
        ).await {
            Ok(Ok(d)) => {
                if attempt > 0 {
                    eprintln!("[MTP] Device found on attempt {}", attempt + 1);
                }
                device_opt = Some(d);
                break;
            }
            Ok(Err(e)) => {
                if attempt == 2 {
                    eprintln!("[MTP] Detect attempt {}: {}", attempt + 1, e);
                }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
            Err(_) => {
                eprintln!("[MTP] Detect attempt {}: timed out", attempt + 1);
            }
        }
    }

    suppressor_stop.store(true, std::sync::atomic::Ordering::SeqCst);

    let device = match device_opt {
        Some(d) => d,
        None => {
            let mut last = LAST_DETECT_STATE.lock().await;
            if last.is_some() {
                eprintln!("[MTP] Device disconnected (3 attempts with suppressor failed)");
                *last = None;
            }
            return Ok(vec![]);
        }
    };

    // Clone all data we need BEFORE dropping device
    let manufacturer = device.device_info().manufacturer.clone();
    let model = device.device_info().model.clone();
    let serial = device.device_info().serial_number.clone();

    let storages = device.storages().await
        .map_err(|e| format!("Failed to list storages: {}", e))?;

    let mut storage_infos = Vec::new();
    for storage in &storages {
        let si = storage.info();
        storage_infos.push(MtpStorageInfo {
            id: format!("{:?}", storage.id()),
            description: si.description.clone(),
            capacity_bytes: si.max_capacity,
            free_bytes: si.free_space_bytes,
        });
    }

    // Build state string for change detection
    let state_str = format!("{}:{}:{}", manufacturer, model, serial);
    let mut last = LAST_DETECT_STATE.lock().await;
    let changed = last.as_ref() != Some(&state_str);
    if changed {
        eprintln!("[MTP] Device found: {} {} (serial: {})", manufacturer, model, serial);
        for si in &storage_infos {
            eprintln!("[MTP]   Storage: {} ({} free / {} total)",
                si.description, format_bytes(si.free_bytes), format_bytes(si.capacity_bytes));
        }
        *last = Some(state_str);
    }

    drop(storages);
    close_mtp_device(device).await;

    Ok(vec![MtpDeviceInfo {
        manufacturer,
        model,
        serial,
        storages: storage_infos,
    }])
}

/// All-in-one test: connect, list storages, list root files, try to upload a test file.
pub async fn mtp_test_all(source_path: &str) -> Result<String, String> {
    let _lock = MTP_LOCK.lock().await;

    let suppressor_stop = start_ptpcamerad_suppressor();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let mut report = String::new();

    let device = mtp_rs::MtpDevice::open_first().await
        .map_err(|e| { suppressor_stop.store(true, std::sync::atomic::Ordering::SeqCst); format!("MTP device not found: {}", e) })?;
    suppressor_stop.store(true, std::sync::atomic::Ordering::SeqCst);

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

        if std::path::Path::new(source_path).exists() {
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

                    match storage.upload(Some(music.handle), file_info, Box::pin(data_stream)).await {
                        Ok(handle) => {
                            report.push_str(&format!("  UPLOAD OK! Handle: {:?}\n", handle));
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
    close_mtp_device(device).await;
    eprintln!("[MTP TEST]\n{}", report);
    Ok(report)
}

/// Send a single file to the MTP device.
pub async fn mtp_send_file(source_path: &str, dest_folder: &str, dest_filename: &str, storage_index: usize) -> Result<u64, String> {
    let _lock = MTP_LOCK.lock().await;

    let suppressor_stop = start_ptpcamerad_suppressor();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let device = mtp_rs::MtpDevice::open_first().await
        .map_err(|e| { suppressor_stop.store(true, std::sync::atomic::Ordering::SeqCst); format!("MTP device not found: {}", e) })?;
    suppressor_stop.store(true, std::sync::atomic::Ordering::SeqCst);

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
    let _lock = MTP_LOCK.lock().await;

    let suppressor_stop = start_ptpcamerad_suppressor();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let device = mtp_rs::MtpDevice::open_first().await
        .map_err(|e| { suppressor_stop.store(true, std::sync::atomic::Ordering::SeqCst); format!("MTP device not found: {}", e) })?;
    suppressor_stop.store(true, std::sync::atomic::Ordering::SeqCst);

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

// ============================================================================
// BATCH SYNC — with automatic session reconnection
// ============================================================================

/// Maximum number of CONSECUTIVE reconnection failures before aborting.
/// (Resets to 0 after each successful copy — a recovery proves the session works.)
const MAX_CONSECUTIVE_RECONNECT_FAILURES: usize = 5;

/// Base delay after closing a corrupted session before reopening.
/// After a failed upload, the JM21 firmware needs substantial time to flush its
/// write buffer and recover. 8s base with backoff: 8s, 16s, 24s, 32s, 40s.
const RECONNECT_BASE_DELAY_SECS: u64 = 8;

/// Preventive firmware breathing pause: after every FLUSH_INTERVAL_FILES copies,
/// pause for FLUSH_PAUSE_SECS to let the device flush its write buffer.
/// Without this, the FiiO JM21 firmware saturates after ~30 consecutive writes
/// and enters an unrecoverable stall (device completely unresponsive, 5+ reconnect
/// attempts fail). At 10 files / 8s, we stay well under the crash threshold.
const FLUSH_INTERVAL_FILES: usize = 10;
const FLUSH_PAUSE_SECS: u64 = 8;
/// Micro-delay between each file upload (milliseconds).
/// Gives the JM21 flash controller time to flush each write before the next one.
/// Without this, back-to-back uploads overwhelm the controller after ~30 writes.
const INTER_FILE_DELAY_MS: u64 = 1500;

/// Wave-based sync: after WAVE_SIZE files, close the MTP session and require a
/// physical USB disconnect/reconnect before continuing. This is the ONLY reliable
/// way to fully reset DAP firmware state — timing heuristics can't guarantee it.
///
/// The FiiO JM21 firmware crashes after ~470 consecutive MTP uploads even with
/// session cycling. A physical USB replug is the only operation that guarantees
/// a full firmware reset. With WAVE_SIZE=250, we stay well under the crash threshold.
///
/// For small syncs (< WAVE_SIZE), no wave break needed — session cycling handles it.
const WAVE_SIZE: usize = 200;

/// Check if an error string indicates a timeout / corrupted MTP session.
fn is_timeout_error(err_str: &str) -> bool {
    err_str.contains("Transaction ID mismatch")
        || err_str.contains("timed out")
        || err_str.contains("Timeout")
        || err_str.contains("Operation timed out")
        || err_str.contains("Broken pipe")
}

/// Helper: open MTP device, get storage, find Music folder, populate folder cache.
/// Returns (device, storages, music_handle, folder_cache).
/// Caller must drop storages before device.
async fn open_mtp_connection(storage_index: usize) -> Result<(
    mtp_rs::MtpDevice,
    Vec<mtp_rs::mtp::Storage>,
    mtp_rs::ptp::ObjectHandle,
    std::collections::HashMap<String, mtp_rs::ptp::ObjectHandle>,
), String> {
    let suppressor_stop = start_ptpcamerad_suppressor();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let mut device_opt = None;
    let mut last_err = String::new();
    // 4 attempts with increasing timeouts: 5s, 10s, 15s, 20s
    // After a failed upload, the JM21 firmware needs time to flush its write buffer.
    // The bulk transfer timeout is set to 60s (was 30s default, then 120s).
    // 120s was too long — keeping the USB blocked that long crashes the JM21 firmware
    // after 2 consecutive timeouts (device becomes completely unresponsive).
    // 60s gives enough margin for JM21 flash write stalls (typically 30-40s)
    // while limiting damage if the transfer truly hangs.
    let bulk_timeout = std::time::Duration::from_secs(60);
    let timeouts_secs: &[u64] = &[5, 10, 15, 20];
    for (attempt, &timeout_s) in timeouts_secs.iter().enumerate() {
        match tokio::time::timeout(
            std::time::Duration::from_secs(timeout_s),
            mtp_rs::MtpDevice::builder().timeout(bulk_timeout).open_first()
        ).await {
            Ok(Ok(d)) => {
                if attempt > 0 {
                    eprintln!("[MTP] open_connection succeeded on attempt {} (timeout={}s)", attempt + 1, timeout_s);
                }
                device_opt = Some(d);
                break;
            }
            Ok(Err(e)) => {
                last_err = format!("{}", e);
                eprintln!("[MTP] open_connection attempt {} (timeout={}s): {}", attempt + 1, timeout_s, last_err);
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            Err(_) => {
                last_err = "timed out".into();
                eprintln!("[MTP] open_connection attempt {} (timeout={}s): timed out", attempt + 1, timeout_s);
            }
        }
    }

    suppressor_stop.store(true, std::sync::atomic::Ordering::SeqCst);
    let device = device_opt.ok_or_else(|| format!("MTP device not found: {}", last_err))?;

    let storages = device.storages().await
        .map_err(|e| format!("Failed to list storages: {}", e))?;

    let storage = storages.get(storage_index)
        .ok_or_else(|| format!("Storage index {} not found (have {})", storage_index, storages.len()))?;

    let root_objects = storage.list_objects(None).await
        .map_err(|e| format!("Failed to list root objects: {}", e))?;

    let music_handle = root_objects.iter()
        .find(|o| o.is_folder() && o.filename == "Music")
        .map(|o| o.handle)
        .ok_or_else(|| "No 'Music' folder found on device. Please create a 'Music' folder on the SD card.".to_string())?;

    let mut folder_cache = std::collections::HashMap::new();
    if let Ok(music_contents) = storage.list_objects(Some(music_handle)).await {
        for obj in &music_contents {
            if obj.is_folder() {
                folder_cache.insert(obj.filename.clone(), obj.handle);
            }
        }
    }

    Ok((device, storages, music_handle, folder_cache))
}

/// Sync a batch of files via MTP — with automatic session recovery.
/// When a timeout corrupts the USB session, the connection is closed and reopened.
/// Each file has a source_path (local or SMB-resolved) and a dest_relative_path.
/// Files are uploaded into the "Music" folder on the target storage.
/// Returns (files_copied, total_bytes, errors).
pub async fn mtp_sync_batch(
    files: Vec<(String, String)>, // (source_path, dest_relative_path)
    storage_index: usize,
    progress_callback: impl Fn(usize, usize, &str), // (current, total, current_file)
    cancel_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
    app_handle: Option<tauri::AppHandle>, // For emitting mtp_needs_replug events
) -> Result<(usize, u64, Vec<String>), String> {
    let _lock = MTP_LOCK.lock().await;

    // Global ptpcamerad suppressor — runs for the ENTIRE sync duration.
    // Without this, macOS ptpcamerad grabs exclusive USB access during pauses
    // (post-timeout recovery, session cycling, wave breaks) and blocks reconnection.
    // SuppressorGuard auto-stops on drop (every return path, including errors).
    // open_mtp_connection also starts its own short-lived suppressor — having two
    // running is harmless (both just pkill -9 ptpcamerad every 200ms).
    let _global_suppressor = SuppressorGuard(start_ptpcamerad_suppressor());
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    // --- Phase 1: Initial connection + scan existing files ---
    let (device, storages, music_handle, _) = open_mtp_connection(storage_index).await?;
    let storage = storages.get(storage_index).unwrap();

    eprintln!("[MTP] Scanning existing files on device...");
    let t_scan = std::time::Instant::now();
    let mut existing_files: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
    scan_mtp_folder_recursive(storage, music_handle, "", &mut existing_files).await;
    eprintln!("[MTP] Found {} existing files on device (scan took {:?})", existing_files.len(), t_scan.elapsed());
    // Log all existing files for debugging
    for (f, size) in existing_files.iter().take(50) {
        eprintln!("[MTP]   existing: {} ({:.1} MB)", f, *size as f64 / 1_048_576.0);
    }
    if existing_files.len() > 50 {
        eprintln!("[MTP]   ... and {} more", existing_files.len() - 50);
    }

    // Build owned list of files to copy (not references — we need to survive reconnections).
    // A file is skipped ONLY if it exists on device AND its size is non-zero.
    // Files with size 0 on device are corrupt (uploaded without CloseSession) → re-upload.
    let mut corrupt_count = 0usize;
    let mut files_to_copy: Vec<(String, String)> = files.iter()
        .filter(|(_, dest_rel)| {
            if let Some(&device_size) = existing_files.get(dest_rel.as_str()) {
                if device_size == 0 {
                    // File exists but is empty → corrupt, needs re-upload
                    corrupt_count += 1;
                    eprintln!("[MTP]   CORRUPT (0 bytes on device, will re-upload): {}", dest_rel);
                    true // keep in files_to_copy
                } else {
                    false // genuinely exists
                }
            } else {
                true // not on device at all
            }
        })
        .cloned()
        .collect();
    if corrupt_count > 0 {
        eprintln!("[MTP] ⚠️ {} corrupt files detected (0 bytes) — will be re-uploaded", corrupt_count);
    }
    let already_on_device = files.len() - files_to_copy.len();

    if already_on_device > 0 {
        eprintln!("[MTP] {} files already on device (skipping), {} files to copy",
            already_on_device, files_to_copy.len());
    }

    // Release initial connection (scan complete)
    drop(storages);
    close_mtp_device(device).await;

    if files_to_copy.is_empty() {
        eprintln!("[MTP] Nothing to copy — all files already on device");
        return Ok((0, 0, vec![]));
    }

    // Sort files by album folder, then by filename within each album.
    // This ensures albums are uploaded sequentially — if the sync crashes at file N,
    // the first K albums are COMPLETE and playable on the DAP.
    // Previous approach (sort by size globally) maximized total bytes copied but left
    // ALL albums incomplete (3 tracks from each of 20 albums = 0 playable albums).
    files_to_copy.sort_by(|(_, dest_a), (_, dest_b)| {
        let folder_a = dest_a.rfind('/').map(|p| &dest_a[..p]).unwrap_or("");
        let folder_b = dest_b.rfind('/').map(|p| &dest_b[..p]).unwrap_or("");
        folder_a.cmp(folder_b).then_with(|| dest_a.cmp(dest_b))
    });

    eprintln!("[MTP] Starting batch sync: {} files to copy into Music/ on storage {} (sorted by album, then track)",
        files_to_copy.len(), storage_index);
    if let Some((smallest, _)) = files_to_copy.first() {
        let s_size = std::fs::metadata(smallest).map(|m| m.len()).unwrap_or(0);
        if let Some((largest, _)) = files_to_copy.last() {
            let l_size = std::fs::metadata(largest).map(|m| m.len()).unwrap_or(0);
            eprintln!("[MTP]   Size range: {:.1} MB → {:.1} MB",
                s_size as f64 / 1_048_576.0, l_size as f64 / 1_048_576.0);
        }
    }

    // --- Phase 2: Copy files with automatic reconnection ---
    let total = files.len();
    let mut copied = 0usize;
    let mut skipped = already_on_device;
    let mut total_bytes = 0u64;
    let mut errors = Vec::new();
    let mut timeout_attempts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut poisoned_folders: std::collections::HashSet<String> = std::collections::HashSet::new();
    const MAX_FILE_ATTEMPTS: usize = 2;
    let mut consecutive_reconnect_failures = 0usize;
    let mut total_reconnect_count = 0usize;
    let mut copies_since_last_reconnect = 0usize;
    let mut file_index = 0usize;
    let mut last_was_proactive_cycle = false; // tracks whether last reconnect was proactive
    let mut is_wave_break_pending = false; // tracks whether we need a USB replug before continuing

    'connection: while file_index < files_to_copy.len() {
        if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
            eprintln!("[MTP] Sync cancelled by user after {} files", copied);
            return Ok((copied, total_bytes, vec!["Sync cancelled by user".into()]));
        }

        // Open (or reopen) connection
        let connection = if total_reconnect_count == 0 {
            eprintln!("[MTP] Opening connection for copy phase...");
            open_mtp_connection(storage_index).await
        } else if last_was_proactive_cycle {
            // Proactive cycle — the pause was already done before continue 'connection.
            // No additional delay needed, just reopen immediately.
            eprintln!("[MTP] 🔄 Reopening MTP session after proactive cycle...");
            last_was_proactive_cycle = false;
            open_mtp_connection(storage_index).await
        } else {
            let delay = RECONNECT_BASE_DELAY_SECS * (1 + consecutive_reconnect_failures as u64);
            eprintln!("[MTP] ⚡ Reconnecting MTP session (consecutive failures: {}/{}, waiting {}s)...",
                consecutive_reconnect_failures, MAX_CONSECUTIVE_RECONNECT_FAILURES, delay);
            tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
            open_mtp_connection(storage_index).await
        };

        let (device, storages, music_handle, mut folder_cache) = match connection {
            Ok(c) => {
                if total_reconnect_count > 0 {
                    eprintln!("[MTP] Reconnection successful (was {} consecutive failures)", consecutive_reconnect_failures);
                }
                consecutive_reconnect_failures = 0;
                copies_since_last_reconnect = 0;
                c
            }
            Err(e) => {
                consecutive_reconnect_failures += 1;
                total_reconnect_count += 1;
                if consecutive_reconnect_failures >= MAX_CONSECUTIVE_RECONNECT_FAILURES {
                    eprintln!("[MTP] Failed to reconnect after {} consecutive attempts", MAX_CONSECUTIVE_RECONNECT_FAILURES);
                    let remaining = files_to_copy.len() - file_index;
                    eprintln!("[MTP] 🔌 {} files remaining — emitting replug request to frontend", remaining);

                    // Emit event to frontend: "Please unplug and replug your DAP"
                    if let Some(ref ah) = app_handle {
                        use tauri::Emitter;
                        let _ = ah.emit("mtp_needs_replug", serde_json::json!({
                            "filesCopied": copied,
                            "filesRemaining": remaining,
                            "totalBytes": total_bytes,
                        }));

                        // Wait for the user to replug (poll every 2s for up to 5 minutes)
                        eprintln!("[MTP] ⏳ Waiting for USB replug (up to 5 minutes)...");
                        let replug_start = std::time::Instant::now();
                        let replug_timeout = std::time::Duration::from_secs(300); // 5 min
                        let mut replugged = false;

                        while replug_start.elapsed() < replug_timeout {
                            if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
                                eprintln!("[MTP] Sync cancelled during replug wait");
                                return Ok((copied, total_bytes, vec!["Sync cancelled by user".into()]));
                            }
                            tokio::time::sleep(std::time::Duration::from_secs(2)).await;

                            // Try to open a connection — if it works, the device is back
                            let suppressor_stop = start_ptpcamerad_suppressor();
                            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                            let probe = tokio::time::timeout(
                                std::time::Duration::from_secs(5),
                                mtp_rs::MtpDevice::open_first()
                            ).await;
                            suppressor_stop.store(true, std::sync::atomic::Ordering::SeqCst);

                            match probe {
                                Ok(Ok(dev)) => {
                                    // Device is back! Close probe connection and let the loop reopen properly.
                                    close_mtp_device(dev).await;
                                    eprintln!("[MTP] ✅ Device detected after replug! Waiting 5s for firmware init...");
                                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                                    replugged = true;

                                    let _ = ah.emit("mtp_replug_detected", serde_json::json!({
                                        "filesRemaining": remaining,
                                    }));
                                    break;
                                }
                                _ => {
                                    // Not back yet — keep waiting
                                }
                            }
                        }

                        if replugged {
                            // Reset failure counters and continue the sync
                            consecutive_reconnect_failures = 0;
                            last_was_proactive_cycle = false;
                            total_reconnect_count += 1;
                            eprintln!("[MTP] 🔄 Resuming sync after replug ({} files remaining)", remaining);
                            continue 'connection;
                        }

                        // Timeout expired — nobody replugged
                        eprintln!("[MTP] ⏰ Replug timeout expired — aborting remaining {} files", remaining);
                        let _ = ah.emit("mtp_wave_timeout", serde_json::json!({
                            "filesCopied": copied,
                            "filesRemaining": remaining,
                        }));
                    }

                    // Fallthrough: no app_handle or replug timeout — abort remaining files
                    for j in file_index..files_to_copy.len() {
                        let dest_rel = &files_to_copy[j].1;
                        if timeout_attempts.get(dest_rel.as_str()).copied().unwrap_or(0) < MAX_FILE_ATTEMPTS {
                            errors.push(format!("{} — MTP connection lost", dest_rel));
                        }
                    }
                    break 'connection;
                }
                eprintln!("[MTP] Reconnection failed: {} — will retry...", e);
                continue 'connection;
            }
        };

        let storage = storages.get(storage_index).unwrap();
        eprintln!("[MTP] Connection ready (folder cache: {} entries)", folder_cache.len());

        let mut needs_reconnect = false;
        let mut is_proactive_cycle = false; // true = session cycling, false = error recovery

        while file_index < files_to_copy.len() {
            let (source_path, dest_rel) = &files_to_copy[file_index];

            if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
                eprintln!("[MTP] Sync cancelled by user after {} files", copied);
                drop(storages);
                close_mtp_device(device).await;
                return Ok((copied, total_bytes, vec!["Sync cancelled by user".into()]));
            }

            progress_callback(already_on_device + file_index + 1, total, dest_rel);

            // Skip files that have exceeded max timeout attempts
            let attempts = timeout_attempts.get(dest_rel.as_str()).copied().unwrap_or(0);
            if attempts >= MAX_FILE_ATTEMPTS {
                file_index += 1;
                continue;
            }

            // Skip files in poisoned folders — when one file in an album times out,
            // all remaining files in that album are skipped. The JM21 firmware has
            // issues with specific content and trying each file individually wastes
            // 60s per timeout × N tracks = minutes of apparent "blocking".
            let file_folder = dest_rel.rfind('/').map(|p| &dest_rel[..p]).unwrap_or("");
            if !file_folder.is_empty() && poisoned_folders.contains(file_folder) {
                eprintln!("[MTP] ⏭️ Skipping {} (folder poisoned by previous timeout)", dest_rel);
                errors.push(format!("{} — Skipped (album had timeout)", dest_rel));
                file_index += 1;
                continue;
            }

            // Parse dest_rel: "Artist - Album/01 - Track.flac" → folder + filename
            let parts: Vec<&str> = dest_rel.split('/').collect();
            let (folder_path, filename) = if parts.len() >= 2 {
                let fname = parts[parts.len() - 1];
                let fpath = parts[..parts.len() - 1].join("/");
                (fpath, fname.to_string())
            } else {
                ("".to_string(), dest_rel.clone())
            };

            // Find or create target folder — NO tokio timeout wrapper.
            let t_folder = std::time::Instant::now();
            let target_handle = if folder_path.is_empty() {
                music_handle
            } else {
                eprintln!("[MTP] 📂 Finding/creating folder: {} (from cache: {})",
                    folder_path, folder_cache.contains_key(&folder_path));
                match get_or_create_nested_folder(storage, music_handle, &folder_path, &mut folder_cache).await {
                    Ok(h) => {
                        eprintln!("[MTP] 📂 Folder ready: {} → handle {:?} in {:?}",
                            folder_path, h, t_folder.elapsed());
                        h
                    }
                    Err(e) => {
                        let err_str = format!("{}", e);
                        if is_timeout_error(&err_str) {
                            let count = timeout_attempts.entry(dest_rel.to_string()).or_insert(0);
                            *count += 1;
                            if *count >= MAX_FILE_ATTEMPTS {
                                errors.push(format!("{} — Folder creation timed out ({} attempts)", dest_rel, count));
                            }
                            // Poison the folder — skip remaining files in this album
                            if !folder_path.is_empty() {
                                eprintln!("[MTP] ☠️ Poisoning folder '{}' — all remaining tracks will be skipped", folder_path);
                                poisoned_folders.insert(folder_path.clone());
                            }
                            eprintln!("[MTP] TIMEOUT creating folder for {} (attempt {}/{}) — will reconnect",
                                dest_rel, count, MAX_FILE_ATTEMPTS);
                            needs_reconnect = true;
                            file_index += 1;
                            break;
                        }
                        errors.push(format!("{} — Failed to create folder: {}", dest_rel, e));
                        eprintln!("[MTP] Folder creation failed for {}: {}", dest_rel, e);
                        file_index += 1;
                        continue;
                    }
                }
            };

            // Read source file
            let t_read = std::time::Instant::now();
            let file_bytes = match tokio::fs::read(source_path).await {
                Ok(b) => b,
                Err(e) => {
                    errors.push(format!("{} — Source file not found: {}", dest_rel, e));
                    eprintln!("[MTP] Source read failed: {} — {}", source_path, e);
                    file_index += 1;
                    continue;
                }
            };
            let file_size = file_bytes.len() as u64;
            eprintln!("[MTP] 📖 Read source {:.1} MB in {:?}: {}",
                file_size as f64 / 1_048_576.0, t_read.elapsed(), filename);

            // Upload — NO tokio timeout wrapper.
            // mtp-rs has a built-in bulk transfer timeout (120s, set via builder in
            // open_mtp_connection) that keeps USB transfers pending on timeout (cancel-safe).
            // Our old tokio::time::timeout wrapper was DROPPING the upload Future on
            // timeout, which cancelled the USB transfer and corrupted the MTP Transaction
            // ID — root cause of "Transaction ID mismatch" errors and session corruption.
            let file_info = mtp_rs::mtp::NewObjectInfo::file(&filename, file_size);
            let data_stream = futures::stream::iter(vec![
                Ok::<_, std::io::Error>(bytes::Bytes::from(file_bytes))
            ]);

            eprintln!("[MTP] ⬆️ Uploading {} ({:.1} MB) to handle {:?}...",
                filename, file_size as f64 / 1_048_576.0, target_handle);
            let t_upload = std::time::Instant::now();
            let upload_result = storage.upload(Some(target_handle), file_info, Box::pin(data_stream)).await;
            eprintln!("[MTP] ⬆️ Upload result for {} in {:?}: {}",
                filename, t_upload.elapsed(),
                if upload_result.is_ok() { "OK".to_string() } else { format!("ERR: {}", upload_result.as_ref().unwrap_err()) });

            match upload_result {
                Ok(uploaded_handle) => {
                    // Post-upload verification: check that the file on device has the correct size.
                    // Files can appear "OK" via MTP but contain corrupted data — the JM21 media
                    // scanner then can't read them. Verifying the size catches truncated uploads.
                    let mut verified = true;
                    match storage.get_object_info(uploaded_handle).await {
                        Ok(obj_info) => {
                            if obj_info.size != file_size {
                                eprintln!("[MTP] ⚠️ SIZE MISMATCH after upload: {} — source={} bytes, device={} bytes",
                                    dest_rel, file_size, obj_info.size);
                                // Delete the corrupt file and mark for retry
                                let _ = storage.delete(uploaded_handle).await;
                                let count = timeout_attempts.entry(dest_rel.to_string()).or_insert(0);
                                *count += 1;
                                if *count >= MAX_FILE_ATTEMPTS {
                                    errors.push(format!("{} — Size mismatch after upload (source={}, device={})",
                                        dest_rel, file_size, obj_info.size));
                                }
                                verified = false;
                            }
                        }
                        Err(e) => {
                            // Can't verify — log but don't fail (some MTP devices don't support get_object_info)
                            eprintln!("[MTP] ⚠️ Post-upload verification failed for {}: {} (continuing anyway)", dest_rel, e);
                        }
                    }

                    if verified {
                        copied += 1;
                        total_bytes += file_size;
                        copies_since_last_reconnect += 1;
                    }

                    // === PROACTIVE SESSION CYCLING + WAVE BREAKS ===
                    // The JM21 firmware crashes after ~30 consecutive MTP writes.
                    // Session cycling (every 10 files) prevents short-term saturation.
                    // Wave breaks (every 250 files) prevent cumulative firmware fatigue
                    // by requiring a physical USB replug that fully resets the firmware.
                    let is_wave_break = copied % WAVE_SIZE == 0 && copied > 0;
                    if (copied % FLUSH_INTERVAL_FILES == 0 || is_wave_break) && file_index + 1 < files_to_copy.len() {
                        if is_wave_break {
                            let wave_num = copied / WAVE_SIZE;
                            let total_waves = (files_to_copy.len() + WAVE_SIZE - 1) / WAVE_SIZE;
                            eprintln!("[MTP] 🌊 WAVE {} COMPLETE ({} files, {:.1} MB) — USB replug required before wave {}/{}",
                                wave_num, copied, total_bytes as f64 / 1_048_576.0, wave_num + 1, total_waves);
                        } else {
                            eprintln!("[MTP] 🔄 Session cycling ({} files copied, {:.1} MB) — closing session, waiting {}s, reopening...",
                                copied, total_bytes as f64 / 1_048_576.0, FLUSH_PAUSE_SECS);
                        }
                        needs_reconnect = true;
                        is_proactive_cycle = !is_wave_break; // wave breaks are NOT proactive cycles
                        is_wave_break_pending = is_wave_break;
                        file_index += 1;
                        break; // exit inner while → outer loop will close session + handle wave/cycle
                    } else if file_index + 1 < files_to_copy.len() {
                        // Micro-delay between every file — prevents flash controller saturation.
                        tokio::time::sleep(std::time::Duration::from_millis(INTER_FILE_DELAY_MS)).await;
                    }
                    if copied % 5 == 0 || copied == 1 {
                        eprintln!("[MTP] Progress: {}/{} files copied ({:.1} MB)",
                            copied, files_to_copy.len(),
                            total_bytes as f64 / 1_048_576.0);
                    }
                }
                Err(e) => {
                    let err_str = format!("{}", e);
                    if err_str.contains("GeneralError") {
                        skipped += 1;
                        if skipped - already_on_device <= 3 {
                            eprintln!("[MTP] Already on device (skipped): {}", dest_rel);
                        }
                    } else if is_timeout_error(&err_str) {
                        // mtp-rs returned a timeout — the USB transfer is still pending
                        // (cancel-safe in mtp-rs v0.4.0+). We reconnect to get a fresh session.
                        let count = timeout_attempts.entry(dest_rel.to_string()).or_insert(0);
                        *count += 1;
                        if *count >= MAX_FILE_ATTEMPTS {
                            errors.push(format!("{} — MTP upload timed out ({} attempts)", dest_rel, count));
                        }
                        // Poison the folder — skip remaining files in this album
                        let timeout_folder = dest_rel.rfind('/').map(|p| &dest_rel[..p]).unwrap_or("");
                        if !timeout_folder.is_empty() {
                            eprintln!("[MTP] ☠️ Poisoning folder '{}' — all remaining tracks will be skipped", timeout_folder);
                            poisoned_folders.insert(timeout_folder.to_string());
                        }
                        eprintln!("[MTP] TIMEOUT: {} (attempt {}/{}) — will reconnect on fresh session",
                            dest_rel, count, MAX_FILE_ATTEMPTS);
                        needs_reconnect = true;
                        file_index += 1;
                        break;
                    } else {
                        // Other error — retry once on this same connection
                        eprintln!("[MTP] Upload error for {}: {} — retrying...", filename, e);
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

                        if let Ok(retry_bytes) = tokio::fs::read(source_path).await {
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
                                    let e2_str = format!("{}", e2);
                                    if is_timeout_error(&e2_str) {
                                        let count = timeout_attempts.entry(dest_rel.to_string()).or_insert(0);
                                        *count += 1;
                                        if *count >= MAX_FILE_ATTEMPTS {
                                            errors.push(format!("{} — MTP upload timed out ({} attempts)", dest_rel, count));
                                        }
                                        // Poison the folder on retry timeout too
                                        let retry_folder = dest_rel.rfind('/').map(|p| &dest_rel[..p]).unwrap_or("");
                                        if !retry_folder.is_empty() {
                                            eprintln!("[MTP] ☠️ Poisoning folder '{}' — all remaining tracks will be skipped", retry_folder);
                                            poisoned_folders.insert(retry_folder.to_string());
                                        }
                                        eprintln!("[MTP] TIMEOUT on retry: {} — will reconnect", dest_rel);
                                        needs_reconnect = true;
                                        file_index += 1;
                                        break;
                                    } else {
                                        errors.push(format!("{} — MTP upload failed: {}", dest_rel, e2));
                                        eprintln!("[MTP] Upload FAILED: {} — {}", dest_rel, e2);
                                    }
                                }
                            }
                        } else {
                            errors.push(format!("{} — Failed to re-read source for retry", dest_rel));
                        }
                    }
                }
            }

            file_index += 1;
        }

        // Release connection before potential reconnect
        drop(storages);
        close_mtp_device(device).await;

        if needs_reconnect && file_index < files_to_copy.len() {
            if is_wave_break_pending {
                // === WAVE BREAK: USB replug required ===
                // The only guaranteed way to fully reset DAP firmware state.
                // Session cycling extends the limit from ~31 to ~470 files, but
                // cumulative firmware fatigue eventually causes an unrecoverable crash.
                // A physical USB replug is deterministic — it always works.
                is_wave_break_pending = false;
                total_reconnect_count += 1;
                consecutive_reconnect_failures = 0;

                let remaining = files_to_copy.len() - file_index;
                let wave_num = copied / WAVE_SIZE;
                let total_waves = (files_to_copy.len() + WAVE_SIZE - 1) / WAVE_SIZE;

                if let Some(ref ah) = app_handle {
                    use tauri::Emitter;
                    let _ = ah.emit("mtp_wave_complete", serde_json::json!({
                        "waveNum": wave_num,
                        "totalWaves": total_waves,
                        "filesCopied": copied,
                        "filesRemaining": remaining,
                        "totalBytes": total_bytes,
                    }));

                    // Wait for user to unplug, wait, and replug the DAP
                    eprintln!("[MTP] 🌊 Wave {} complete — waiting for USB replug (up to 5 min)...", wave_num);
                    let replug_start = std::time::Instant::now();
                    let replug_timeout = std::time::Duration::from_secs(300);

                    // Phase 1: Wait for device to DISAPPEAR (user unplugged)
                    // Give user 10s to start unplugging
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    let mut device_gone = false;
                    while replug_start.elapsed() < replug_timeout {
                        if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
                            return Ok((copied, total_bytes, vec!["Sync cancelled by user".into()]));
                        }
                        let suppressor_stop = start_ptpcamerad_suppressor();
                        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                        let probe = tokio::time::timeout(
                            std::time::Duration::from_secs(3),
                            mtp_rs::MtpDevice::open_first()
                        ).await;
                        suppressor_stop.store(true, std::sync::atomic::Ordering::SeqCst);
                        match probe {
                            Ok(Ok(dev)) => {
                                // Still connected — close probe and keep waiting
                                let _ = dev.close().await;
                                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                            }
                            _ => {
                                // Device gone!
                                device_gone = true;
                                eprintln!("[MTP] 🔌 Device disconnected — waiting for replug...");
                                let _ = ah.emit("mtp_wave_unplugged", serde_json::json!({}));
                                break;
                            }
                        }
                    }

                    if !device_gone {
                        // The user never unplugged within the timeout.
                        // A physical USB replug is REQUIRED — continuing without one
                        // will crash the DAP firmware. Abort remaining files.
                        eprintln!("[MTP] ❌ Wave break timeout — user never unplugged. Aborting remaining {} files.", remaining);
                        let _ = ah.emit("mtp_wave_timeout", serde_json::json!({
                            "filesCopied": copied,
                            "filesRemaining": remaining,
                        }));
                        for j in file_index..files_to_copy.len() {
                            let dest_rel = &files_to_copy[j].1;
                            errors.push(format!("{} — wave break: USB replug required but not performed", dest_rel));
                        }
                        return Ok((copied, total_bytes, errors));
                    }

                    // Phase 2: Wait for device to REAPPEAR (user replugged)
                    let mut replugged = false;
                    while replug_start.elapsed() < replug_timeout {
                        if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
                            return Ok((copied, total_bytes, vec!["Sync cancelled by user".into()]));
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;

                        let suppressor_stop = start_ptpcamerad_suppressor();
                        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                        let probe = tokio::time::timeout(
                            std::time::Duration::from_secs(5),
                            mtp_rs::MtpDevice::open_first()
                        ).await;
                        suppressor_stop.store(true, std::sync::atomic::Ordering::SeqCst);

                        match probe {
                            Ok(Ok(dev)) => {
                                let _ = dev.close().await;
                                replugged = true;
                                eprintln!("[MTP] ✅ Device replugged! Waiting 5s for firmware init...");
                                tokio::time::sleep(std::time::Duration::from_secs(5)).await;

                                let _ = ah.emit("mtp_wave_resuming", serde_json::json!({
                                    "waveNum": wave_num + 1,
                                    "totalWaves": total_waves,
                                    "filesRemaining": remaining,
                                }));
                                break;
                            }
                            _ => {
                                // Not back yet
                            }
                        }
                    }

                    if replugged {
                        last_was_proactive_cycle = true; // skip extra delay on reopen
                        continue 'connection;
                    }

                    // Timeout — abort remaining files
                    eprintln!("[MTP] ⏰ Replug timeout (5 min) — aborting remaining {} files", remaining);
                    for j in file_index..files_to_copy.len() {
                        let dest_rel = &files_to_copy[j].1;
                        errors.push(format!("{} — USB replug timeout", dest_rel));
                    }
                    break 'connection;
                } else {
                    // No app_handle — can't communicate with frontend to request replug.
                    // Continuing without a replug WILL crash the firmware. Abort.
                    eprintln!("[MTP] ❌ Wave break (no frontend) — cannot request USB replug. Aborting {} remaining files.", remaining);
                    for j in file_index..files_to_copy.len() {
                        let dest_rel = &files_to_copy[j].1;
                        errors.push(format!("{} — wave break: no frontend to request USB replug", dest_rel));
                    }
                    return Ok((copied, total_bytes, errors));
                }
            } else if is_proactive_cycle {
                // Normal session cycling — short pause, no USB replug needed.
                total_reconnect_count += 1;
                consecutive_reconnect_failures = 0;
                last_was_proactive_cycle = true;
                eprintln!("[MTP] 🔄 Proactive session cycle pause ({}s) — firmware flush before reopening...",
                    FLUSH_PAUSE_SECS);
                tokio::time::sleep(std::time::Duration::from_secs(FLUSH_PAUSE_SECS)).await;
            } else {
                // Error recovery — timeout or MTP error triggered this reconnect.
                total_reconnect_count += 1;
                if copies_since_last_reconnect > 0 {
                    eprintln!("[MTP] Session was healthy ({} copies since last reconnect) — resetting failure counter",
                        copies_since_last_reconnect);
                    consecutive_reconnect_failures = 0;
                }
                // Post-timeout firmware recovery pause.
                // The JM21 firmware crashes if we reconnect too quickly after a timeout —
                // the USB controller needs time to flush its pending transfer and recover.
                // 15s gives the firmware enough breathing room before we open a new session.
                eprintln!("[MTP] ⏸ Post-timeout recovery pause (15s) — letting JM21 firmware recover...");
                tokio::time::sleep(std::time::Duration::from_secs(15)).await;
            }
            continue 'connection;
        }

        break 'connection;
    }

    // Phase 3 retry pass REMOVED: retrying timed-out files on an already-stressed
    // firmware risks pushing past the ~470 MTP operation crash threshold.
    // Timed-out files are left as errors — the manifest tracks what was copied,
    // so the next incremental sync run will retry them with a fresh firmware state.
    let retryable_count = (0..files_to_copy.len())
        .filter(|i| {
            let dest_rel = &files_to_copy[*i].1;
            let attempts = timeout_attempts.get(dest_rel.as_str()).copied().unwrap_or(0);
            attempts > 0 && attempts < MAX_FILE_ATTEMPTS
        })
        .count();
    if retryable_count > 0 {
        eprintln!("[MTP] {} files had timeouts — will be retried on next incremental sync", retryable_count);
    }

    if !poisoned_folders.is_empty() {
        eprintln!("[MTP] ☠️ {} album folders were poisoned (timeout) and had remaining tracks skipped: {:?}",
            poisoned_folders.len(), poisoned_folders);
    }
    eprintln!("[MTP] Batch sync complete: {}/{} copied, {} already on device, {:.1} MB, {} errors, {} reconnections",
        copied, files_to_copy.len(), skipped, total_bytes as f64 / 1_048_576.0, errors.len(), total_reconnect_count);

    Ok((copied, total_bytes, errors))
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
            // Folder not found in listing — try to create it.
            // GeneralError means the folder already exists (MTP ghost entry, exFAT phantom,
            // or the list_objects didn't return it). In that case, re-list and find it.
            match storage.create_folder(Some(current_handle), part).await {
                Ok(_create_handle) => {
                    // Created successfully — re-list to get a valid handle
                    // (some MTP devices reject uploads using the handle from create_folder)
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                }
                Err(e) => {
                    let err_str = format!("{}", e);
                    if err_str.contains("GeneralError") {
                        // Folder already exists (ghost or not returned by list_objects)
                        eprintln!("[MTP] Folder '{}' already exists (GeneralError) — looking up handle", built_path);
                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    } else {
                        return Err(format!("Failed to create folder '{}': {}", built_path, e));
                    }
                }
            }

            // Re-list parent to get the handle (works for both fresh create and GeneralError)
            let refreshed = storage.list_objects(Some(current_handle)).await
                .map_err(|e| format!("Failed to re-list after creating {}: {}", built_path, e))?;
            let new_handle = refreshed.iter()
                .find(|o| o.is_folder() && o.filename == *part)
                .map(|o| o.handle)
                .ok_or_else(|| format!("Folder '{}' not found in re-list (create returned GeneralError but folder invisible)", built_path))?;
            cache.insert(built_path.clone(), new_handle);
            current_handle = new_handle;
            eprintln!("[MTP] Resolved folder: Music/{}", built_path);
        }
    }

    Ok(current_handle)
}

// ============================================================================
// DELETE
// ============================================================================

/// Delete files from MTP device by dest_relative_path, then remove empty folders.
pub async fn mtp_delete_files(
    files_to_delete: &[String],
    storage_index: usize,
    progress_callback: impl Fn(usize, usize, &str),
    cancel_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<(usize, Vec<String>), String> {
    let _lock = MTP_LOCK.lock().await;

    let suppressor_stop = start_ptpcamerad_suppressor();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let device = mtp_rs::MtpDevice::open_first().await
        .map_err(|e| { suppressor_stop.store(true, std::sync::atomic::Ordering::SeqCst); format!("MTP device not found: {}", e) })?;
    suppressor_stop.store(true, std::sync::atomic::Ordering::SeqCst);

    let storages = device.storages().await
        .map_err(|e| format!("Failed to list storages: {}", e))?;

    let storage = storages.get(storage_index)
        .ok_or_else(|| format!("Storage index {} not found", storage_index))?;

    let root_objects = storage.list_objects(None).await
        .map_err(|e| format!("Failed to list root: {}", e))?;

    let music_handle = match root_objects.iter().find(|o| o.is_folder() && o.filename == "Music") {
        Some(o) => o.handle,
        None => {
            eprintln!("[MTP] No Music/ folder — nothing to delete");
            drop(storages);
            close_mtp_device(device).await;
            return Ok((0, vec![]));
        }
    };

    let mut path_to_handle: std::collections::HashMap<String, mtp_rs::ptp::ObjectHandle> = std::collections::HashMap::new();
    scan_mtp_handles_recursive(storage, music_handle, "", &mut path_to_handle).await;

    let total = files_to_delete.len();
    let mut deleted = 0usize;
    let mut errors = Vec::new();
    let mut affected_folders: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut stale_folders: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (i, dest_rel) in files_to_delete.iter().enumerate() {
        if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
            errors.push("Delete cancelled by user".into());
            break;
        }

        progress_callback(i + 1, total, dest_rel);

        let parent_folder = dest_rel.rfind('/').map(|pos| &dest_rel[..pos]);
        if let Some(folder) = parent_folder {
            if stale_folders.contains(folder) {
                stale_folders.remove(folder);
                if let Some(folder_handle) = find_folder_handle(storage, music_handle, folder).await {
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
                    if let Some(pos) = dest_rel.rfind('/') {
                        affected_folders.insert(dest_rel[..pos].to_string());
                    }
                }
                Err(e) => {
                    let err_str = format!("{}", e);
                    if err_str.contains("InvalidObjectHandle") {
                        if let Some(folder) = parent_folder {
                            if let Some(folder_handle) = find_folder_handle(storage, music_handle, folder).await {
                                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                                if let Ok(objects) = storage.list_objects(Some(folder_handle)).await {
                                    let filename = dest_rel.rsplit('/').next().unwrap_or(dest_rel);
                                    if let Some(fresh_obj) = objects.iter().find(|o| !o.is_folder() && o.filename == filename) {
                                        match storage.delete(fresh_obj.handle).await {
                                            Ok(()) => {
                                                deleted += 1;
                                                affected_folders.insert(folder.to_string());
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
            eprintln!("[MTP] Delete skip (not found): {}", dest_rel);
        }
    }

    eprintln!("[MTP] Deleted {}/{} files, {} errors", deleted, total, errors.len());

    if !affected_folders.is_empty() {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let empty_deleted = cleanup_empty_mtp_folders(storage, music_handle).await;
        if empty_deleted > 0 {
            eprintln!("[MTP] Cleaned up {} empty folders", empty_deleted);
        }
    }

    drop(storages);
    close_mtp_device(device).await;
    eprintln!("[MTP] Device connection released");

    Ok((deleted, errors))
}

// ============================================================================
// SCAN + HELPERS
// ============================================================================

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

async fn scan_mtp_handles_recursive(
    storage: &mtp_rs::mtp::Storage,
    folder_handle: mtp_rs::ptp::ObjectHandle,
    prefix: &str,
    map: &mut std::collections::HashMap<String, mtp_rs::ptp::ObjectHandle>,
) {
    let objects = match storage.list_objects(Some(folder_handle)).await {
        Ok(objs) => objs,
        Err(e) => {
            eprintln!("[MTP] WARNING: scan failed for '{}': {} — retrying once",
                if prefix.is_empty() { "Music/" } else { prefix }, e);
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            match storage.list_objects(Some(folder_handle)).await {
                Ok(objs) => objs,
                Err(e2) => {
                    eprintln!("[MTP] WARNING: retry FAILED for '{}': {}", prefix, e2);
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

async fn cleanup_empty_mtp_folders(
    storage: &mtp_rs::mtp::Storage,
    music_handle: mtp_rs::ptp::ObjectHandle,
) -> usize {
    let mut deleted = 0;
    let children = match storage.list_objects(Some(music_handle)).await {
        Ok(c) => c,
        Err(_) => return 0,
    };
    for child in &children {
        if child.is_folder() {
            deleted += Box::pin(cleanup_empty_mtp_folders(storage, child.handle)).await;
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

/// Recursively scan an MTP folder and collect all file paths + sizes relative to the scan root.
/// Returns a HashMap<path, size_bytes> — the size is used to detect corrupt files
/// (uploaded without CloseSession → truncated/empty on the device).
async fn scan_mtp_folder_recursive(
    storage: &mtp_rs::mtp::Storage,
    folder_handle: mtp_rs::ptp::ObjectHandle,
    prefix: &str,
    files: &mut std::collections::HashMap<String, u64>,
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
            Box::pin(scan_mtp_folder_recursive(storage, obj.handle, &path, files)).await;
        } else {
            files.insert(path, obj.size);
        }
    }
}

/// Scan the Music/ folder on an MTP device and return all file paths.
pub async fn scan_mtp_device_files(storage_index: usize) -> Result<std::collections::HashSet<String>, String> {
    let _lock = MTP_LOCK.lock().await;

    let suppressor_stop = start_ptpcamerad_suppressor();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let mut device_opt = None;
    let mut last_err = String::new();
    for attempt in 0..3 {
        match tokio::time::timeout(
            std::time::Duration::from_secs(5),
            mtp_rs::MtpDevice::open_first()
        ).await {
            Ok(Ok(d)) => { device_opt = Some(d); break; }
            Ok(Err(e)) => {
                last_err = format!("{}", e);
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
            Err(_) => { last_err = "timed out".into(); }
        }
        if attempt < 2 {
            eprintln!("[MTP] scan attempt {} failed: {} — retrying", attempt + 1, last_err);
        }
    }

    suppressor_stop.store(true, std::sync::atomic::Ordering::SeqCst);
    let device = device_opt.ok_or_else(|| format!("MTP scan: device not found: {}", last_err))?;

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
            eprintln!("[MTP] No Music folder on device — treating as empty");
            return Ok(std::collections::HashSet::new());
        }
    };

    let mut files_with_sizes: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
    scan_mtp_folder_recursive(storage, music_handle, "", &mut files_with_sizes).await;

    // Filter out corrupt files (0 bytes = uploaded without CloseSession)
    let mut corrupt = 0usize;
    let files: std::collections::HashSet<String> = files_with_sizes.into_iter()
        .filter(|(path, size)| {
            if *size == 0 {
                corrupt += 1;
                eprintln!("[MTP] ⚠️ Corrupt file (0 bytes), will be re-synced: {}", path);
                false
            } else {
                true
            }
        })
        .map(|(path, _)| path)
        .collect();

    drop(storages);
    close_mtp_device(device).await;

    if corrupt > 0 {
        eprintln!("[MTP] Device scan for plan: {} valid files, {} corrupt (0 bytes) excluded", files.len(), corrupt);
    } else {
        eprintln!("[MTP] Device scan for plan: {} files found on device", files.len());
    }
    Ok(files)
}

/// Purge specific album folders from the MTP device's Music/ directory.
/// Deletes the folder and all its contents recursively.
/// Used to remove corrupted albums that the DAP media scanner can't read.
pub async fn mtp_purge_album_folders(
    folder_names: Vec<String>,
    storage_index: usize,
) -> Result<(usize, Vec<String>), String> {
    let _lock = MTP_LOCK.lock().await;

    let suppressor_stop = start_ptpcamerad_suppressor();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let device = mtp_rs::MtpDevice::open_first().await
        .map_err(|e| { suppressor_stop.store(true, std::sync::atomic::Ordering::SeqCst); format!("MTP device not found: {}", e) })?;
    suppressor_stop.store(true, std::sync::atomic::Ordering::SeqCst);

    let storages = device.storages().await
        .map_err(|e| format!("Failed to list storages: {}", e))?;

    let storage = storages.get(storage_index)
        .ok_or_else(|| format!("Storage index {} not found", storage_index))?;

    let root_objects = storage.list_objects(None).await
        .map_err(|e| format!("Failed to list root: {}", e))?;

    let music_handle = match root_objects.iter().find(|o| o.is_folder() && o.filename == "Music") {
        Some(o) => o.handle,
        None => {
            drop(storages);
            close_mtp_device(device).await;
            return Err("No Music/ folder on device".into());
        }
    };

    let music_contents = storage.list_objects(Some(music_handle)).await
        .map_err(|e| format!("Failed to list Music/: {}", e))?;

    let mut deleted = 0usize;
    let mut errors = Vec::new();

    for folder_name in &folder_names {
        if let Some(folder_obj) = music_contents.iter().find(|o| o.is_folder() && o.filename == *folder_name) {
            eprintln!("[MTP] Purging corrupted album folder: Music/{}", folder_name);

            // Delete all files inside the folder first
            match storage.list_objects(Some(folder_obj.handle)).await {
                Ok(contents) => {
                    for obj in &contents {
                        if let Err(e) = storage.delete(obj.handle).await {
                            eprintln!("[MTP]   Failed to delete {}: {}", obj.filename, e);
                        } else {
                            eprintln!("[MTP]   Deleted: {}", obj.filename);
                        }
                    }
                }
                Err(e) => {
                    errors.push(format!("{} — failed to list contents: {}", folder_name, e));
                    continue;
                }
            }

            // Delete the folder itself
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            match storage.delete(folder_obj.handle).await {
                Ok(()) => {
                    deleted += 1;
                    eprintln!("[MTP] ✅ Purged: Music/{}", folder_name);
                }
                Err(e) => {
                    errors.push(format!("{} — folder delete failed: {}", folder_name, e));
                    eprintln!("[MTP] ❌ Failed to delete folder Music/{}: {}", folder_name, e);
                }
            }
        } else {
            eprintln!("[MTP] Folder not found: Music/{} — skipping", folder_name);
            errors.push(format!("{} — not found on device", folder_name));
        }
    }

    drop(storages);
    close_mtp_device(device).await;
    eprintln!("[MTP] Purge complete: {}/{} folders deleted, {} errors", deleted, folder_names.len(), errors.len());
    Ok((deleted, errors))
}

/// Purge all empty (ghost) folders from the MTP device's Music/ directory.
/// Ghost folders are created when MTP uploads fail mid-way: the folder is created
/// but no files are written. The JM21 media scanner ignores them but they confuse
/// the sync plan (folder exists but scan returns 0 files).
/// Returns the number of deleted ghost folders.
pub async fn mtp_purge_empty_folders(storage_index: usize) -> Result<usize, String> {
    let _lock = MTP_LOCK.lock().await;

    let suppressor_stop = start_ptpcamerad_suppressor();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let device = mtp_rs::MtpDevice::open_first().await
        .map_err(|e| { suppressor_stop.store(true, std::sync::atomic::Ordering::SeqCst); format!("MTP device not found: {}", e) })?;
    suppressor_stop.store(true, std::sync::atomic::Ordering::SeqCst);

    let storages = device.storages().await
        .map_err(|e| format!("Failed to list storages: {}", e))?;

    let storage = storages.get(storage_index)
        .ok_or_else(|| format!("Storage index {} not found", storage_index))?;

    let root_objects = storage.list_objects(None).await
        .map_err(|e| format!("Failed to list root: {}", e))?;

    let music_handle = match root_objects.iter().find(|o| o.is_folder() && o.filename == "Music") {
        Some(o) => o.handle,
        None => {
            drop(storages);
            close_mtp_device(device).await;
            return Ok(0); // No Music/ folder, nothing to purge
        }
    };

    let music_contents = storage.list_objects(Some(music_handle)).await
        .map_err(|e| format!("Failed to list Music/: {}", e))?;

    let mut deleted = 0usize;

    for folder_obj in music_contents.iter().filter(|o| o.is_folder()) {
        // Check if folder is empty (no files inside)
        match storage.list_objects(Some(folder_obj.handle)).await {
            Ok(contents) => {
                // A folder is "ghost" if it has no files at all, or only contains
                // empty subfolders (e.g. "Disc 1/" with no files inside)
                let has_real_files = has_real_files_recursive(storage, &contents).await;
                if !has_real_files {
                    eprintln!("[MTP] Ghost folder detected: Music/{} — purging", folder_obj.filename);
                    // Delete contents first (sub-folders like "Disc 1/")
                    for obj in &contents {
                        if obj.is_folder() {
                            // Delete sub-folder contents first
                            if let Ok(sub_contents) = storage.list_objects(Some(obj.handle)).await {
                                for sub_obj in &sub_contents {
                                    let _ = storage.delete(sub_obj.handle).await;
                                }
                            }
                        }
                        let _ = storage.delete(obj.handle).await;
                    }
                    // Delete the folder itself
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    match storage.delete(folder_obj.handle).await {
                        Ok(()) => {
                            deleted += 1;
                            eprintln!("[MTP] ✅ Purged ghost: Music/{}", folder_obj.filename);
                        }
                        Err(e) => eprintln!("[MTP] ❌ Failed to delete ghost Music/{}: {}", folder_obj.filename, e),
                    }
                }
            }
            Err(e) => eprintln!("[MTP] Failed to list Music/{}: {}", folder_obj.filename, e),
        }
    }

    drop(storages);
    close_mtp_device(device).await;
    if deleted > 0 {
        eprintln!("[MTP] Ghost purge complete: {} empty folders deleted", deleted);
    }
    Ok(deleted)
}

/// Check recursively if a list of objects contains at least one real file (non-zero size).
async fn has_real_files_recursive(storage: &mtp_rs::mtp::Storage, objects: &[mtp_rs::ptp::ObjectInfo]) -> bool {
    for obj in objects {
        if obj.is_folder() {
            if let Ok(sub_contents) = storage.list_objects(Some(obj.handle)).await {
                if Box::pin(has_real_files_recursive(storage, &sub_contents)).await {
                    return true;
                }
            }
        } else if obj.size > 0 {
            return true;
        }
    }
    false
}

/// Clean the local MTP manifest by removing entries for files that don't exist on the device.
/// This is called after a ghost purge to keep the manifest in sync with reality.
pub fn clean_mtp_manifest(dest_path: &str, valid_device_files: &std::collections::HashSet<String>) -> Result<usize, String> {
    let mtp_path = super::manifest::mtp_manifest_path(dest_path);
    let manifest = match super::manifest::read_manifest_file(&mtp_path)? {
        Some(m) => m,
        None => return Ok(0),
    };

    let before = manifest.files.len();
    let cleaned_files: Vec<super::manifest::SyncedFile> = manifest.files.into_iter()
        .filter(|f| valid_device_files.contains(&f.dest_relative_path))
        .collect();
    let removed = before - cleaned_files.len();

    if removed > 0 {
        let cleaned_manifest = super::manifest::SyncManifest {
            hean_version: manifest.hean_version,
            last_sync: manifest.last_sync,
            destination_path: manifest.destination_path,
            folder_structure: manifest.folder_structure,
            files: cleaned_files,
        };
        super::manifest::write_manifest_file(&mtp_path, &cleaned_manifest)?;
        eprintln!("[MTP] Manifest cleaned: {} ghost entries removed ({} → {} files)", removed, before, before - removed);
    }

    Ok(removed)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_timeout_error_transaction_id_mismatch() {
        assert!(is_timeout_error("Transaction ID mismatch (expected 42, got 41)"));
    }

    #[test]
    fn test_is_timeout_error_timed_out() {
        assert!(is_timeout_error("Operation timed out after 60s"));
        assert!(is_timeout_error("timed out"));
        assert!(is_timeout_error("Timeout waiting for response"));
    }

    #[test]
    fn test_is_timeout_error_broken_pipe() {
        assert!(is_timeout_error("Broken pipe"));
    }

    #[test]
    fn test_is_timeout_error_normal_errors() {
        assert!(!is_timeout_error("GeneralError"));
        assert!(!is_timeout_error("File not found"));
        assert!(!is_timeout_error("Permission denied"));
        assert!(!is_timeout_error("InvalidObjectHandle"));
    }
}
