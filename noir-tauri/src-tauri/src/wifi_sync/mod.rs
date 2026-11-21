// wifi_sync/mod.rs — WiFi Sync POC: types + logique metier

pub mod db;
pub mod server;
pub mod tls;
pub mod webui;
pub mod zip_stream;

use crate::{TRACKS_CACHE, dap_sync};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::net::UdpSocket;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;
use once_cell::sync::Lazy;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use mdns_sd::ServiceDaemon;
use unicode_normalization::UnicodeNormalization;

/// State stored in the global WIFI_SYNC_STATE static
pub struct WifiSyncState {
    pub token: String,
    pub allowed_files: HashMap<String, AllowedFile>,
    pub album_count: usize,
    pub total_size_bytes: u64,
    pub file_count: usize,
    pub shutdown_tx: watch::Sender<()>,
    pub server_handle: JoinHandle<()>,
    pub mdns_daemon: Option<ServiceDaemon>,
    pub dest_id: i64,
    pub ip: String,
    pub port: u16,
    /// Path to the persisted self-signed certificate (cert.pem)
    pub cert_path: PathBuf,
    /// Path to the persisted private key (key.pem)
    pub key_path: PathBuf,
    /// User-configurable root folder embedded in every album ZIP
    /// (e.g. `"HEAN"` → `Downloads/HEAN/Artist/Album/track.flac`).
    pub root_prefix: String,
    /// axum_server graceful-shutdown handle. Held so `stop_wifi_sync_server`
    /// can ask the rustls listener to drain its connections cleanly.
    pub axum_handle: axum_server::Handle,
}

/// A file allowed to be served by the HTTP server
#[derive(Clone, Debug)]
pub struct AllowedFile {
    pub abs_path: String,
    pub size_bytes: u64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub filename: String,
}

/// Info returned to frontend when server starts
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WifiSyncInfo {
    pub url: String,
    pub ip: String,
    pub token: String,
    pub port: u16,
}

/// Status returned via Tauri command (avoids CSP issues)
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WifiSyncStatus {
    pub running: bool,
    pub album_count: usize,
    pub total_size_bytes: u64,
    pub file_count: usize,
    pub files: Vec<WifiSyncFileInfo>,
    /// v2: PNG-encoded QR code of the server URL, base64 (no data: prefix).
    /// Empty string when the server is not running.
    #[serde(default)]
    pub qr_code_png_base64: String,
    /// v2: configurable folder name embedded in every album ZIP.
    #[serde(default)]
    pub root_prefix: String,
    /// v2: live download speed in bytes/sec across all open ZIP streams.
    /// Zero when no transfer is active.
    #[serde(default)]
    pub current_throughput_bps: u64,
}

/// One album entry returned by GET /status (v2 album-based response).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WifiSyncAlbum {
    pub id: i64,
    pub artist: String,
    pub album: String,
    pub track_count: usize,
    pub total_bytes: u64,
    pub already_synced: bool,
}

/// Top-level body returned by GET /status (v2).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WifiSyncStatusV2 {
    pub running: bool,
    pub device_uuid: String,
    pub root_prefix: String,
    pub albums: Vec<WifiSyncAlbum>,
    pub total_bytes: u64,
    pub remaining_bytes: u64,
}

/// File info exposed in /status endpoint and Tauri command
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WifiSyncFileInfo {
    pub encoded_path: String,
    pub size_bytes: u64,
    pub filename: String,
    pub title: String,
    pub artist: String,
    pub album: String,
}

/// Replicate JS albumKeyToId() — djb2 hash with i32 wrapping
/// JS: hash = ((hash << 5) - hash + charCode) | 0; return Math.abs(hash)
pub fn album_key_to_id(album_key: &str) -> i64 {
    let mut hash: i32 = 0;
    for ch in album_key.chars() {
        hash = hash.wrapping_shl(5).wrapping_sub(hash).wrapping_add(ch as i32);
    }
    hash.unsigned_abs() as i64
}

/// Normalize album name the same way JS does: trim + NFC
pub fn normalize_album_key(album: &str) -> String {
    album.trim().nfc().collect::<String>()
}

/// Build the set of allowed files from TRACKS_CACHE + dap_sync_selection DB
pub fn build_allowed_files(dest_id: i64) -> Result<(HashMap<String, AllowedFile>, usize, u64), String> {
    // Get selections from DB
    let selections = dap_sync::db::get_selections(dest_id)
        .map_err(|e| format!("Failed to get selections: {}", e))?;

    // Build set of selected album_ids (only those with selected=true)
    let selected_ids: HashSet<i64> = selections
        .into_iter()
        .filter(|(_, selected)| *selected)
        .map(|(album_id, _)| album_id)
        .collect();

    if selected_ids.is_empty() {
        return Ok((HashMap::new(), 0, 0));
    }

    // Lock TRACKS_CACHE and find matching tracks
    let cache = TRACKS_CACHE.lock().map_err(|e| format!("Cache lock failed: {}", e))?;

    let mut allowed_files: HashMap<String, AllowedFile> = HashMap::new();
    let mut seen_albums: HashSet<i64> = HashSet::new();
    let mut total_size: u64 = 0;

    for track in &cache.tracks {
        let album_key = normalize_album_key(&track.metadata.album);
        let album_id = album_key_to_id(&album_key);

        if !selected_ids.contains(&album_id) {
            continue;
        }

        seen_albums.insert(album_id);

        let size = track.metadata.file_size.unwrap_or_else(|| {
            // Estimate from duration + bitrate (same logic as JS estimateFileSize)
            let bitrate = track.metadata.bitrate.unwrap_or(320) as f64;
            let duration = track.metadata.duration;
            ((bitrate * 1000.0 * duration) / 8.0 * 0.65) as u64
        });

        // Encode path as base64url for safe URL usage
        let encoded = base64_url_encode(&track.path);

        let filename = std::path::Path::new(&track.path)
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_else(|| track.name.clone());

        allowed_files.insert(encoded, AllowedFile {
            abs_path: track.path.clone(),
            size_bytes: size,
            title: track.metadata.title.clone(),
            artist: track.metadata.artist.clone(),
            album: track.metadata.album.clone(),
            filename,
        });

        total_size += size;
    }

    let album_count = seen_albums.len();
    Ok((allowed_files, album_count, total_size))
}

/// Base64url encode (no padding) — safe for URL path segments
pub fn base64_url_encode(input: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(input.as_bytes())
}

/// Base64url decode
pub fn base64_url_decode(encoded: &str) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|e| format!("Base64 decode error: {}", e))?;
    String::from_utf8(bytes).map_err(|e| format!("UTF-8 decode error: {}", e))
}

/// Get local IP address via UDP socket trick
pub fn get_local_ip() -> Result<String, String> {
    let socket = UdpSocket::bind("0.0.0.0:0")
        .map_err(|e| format!("Failed to bind UDP socket: {}", e))?;
    socket.connect("8.8.8.8:80")
        .map_err(|e| format!("Failed to connect UDP socket: {}", e))?;
    let addr = socket.local_addr()
        .map_err(|e| format!("Failed to get local address: {}", e))?;
    Ok(addr.ip().to_string())
}

/// Generate a random alphanumeric token
pub fn generate_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..16).map(|_| {
        let idx = rng.gen_range(0..36);
        if idx < 10 { (b'0' + idx) as char } else { (b'a' + idx - 10) as char }
    }).collect()
}

/// Path of the persisted access token (next to `dap_sync.db`).
fn token_path() -> PathBuf {
    crate::get_data_dir().join("wifi_sync_token.txt")
}

/// Read the persisted token if it exists, otherwise generate a fresh one and
/// persist it (perms 0600 via `save_file_secure`).
///
/// Stable across server restarts so that an open WebUI tab keeps working
/// after the user stops/starts WiFi Sync from the desktop. Without this,
/// every restart invalidates every loaded tab → 403 → "Failed to fetch".
pub fn load_or_create_token() -> Result<String, String> {
    let p = token_path();
    if p.exists() {
        match std::fs::read_to_string(&p) {
            Ok(s) => {
                let trimmed = s.trim().to_string();
                if !trimmed.is_empty() && trimmed.chars().all(|c| c.is_ascii_alphanumeric()) {
                    return Ok(trimmed);
                }
                // Corrupt — fall through and regenerate.
            }
            Err(e) => {
                eprintln!("[WiFi Sync] token read failed: {} — regenerating", e);
            }
        }
    }
    let fresh = generate_token();
    crate::save_file_secure(&p, &fresh);
    Ok(fresh)
}

/// Force-rotate the persisted token. Returns the new value.
pub fn rotate_token() -> Result<String, String> {
    let fresh = generate_token();
    crate::save_file_secure(&token_path(), &fresh);
    Ok(fresh)
}

/// Short hex prefix of the SHA-256 of `token` — used by the public `/ping`
/// endpoint so a stale-token client can detect "the server still runs but
/// my token is no longer valid" without ever hitting a 403.
pub fn token_hash_prefix(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    let digest = h.finalize();
    let mut s = String::with_capacity(16);
    for b in digest.iter().take(4) {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// Build WifiSyncStatus from current state
pub fn build_status(state: &WifiSyncState) -> WifiSyncStatus {
    let files: Vec<WifiSyncFileInfo> = state.allowed_files.iter().map(|(encoded, f)| {
        WifiSyncFileInfo {
            encoded_path: encoded.clone(),
            size_bytes: f.size_bytes,
            filename: f.filename.clone(),
            title: f.title.clone(),
            artist: f.artist.clone(),
            album: f.album.clone(),
        }
    }).collect();

    // QR code (base64-encoded PNG) — friction-free DAP onboarding.
    let url = format!("https://{}:{}/", state.ip, state.port);
    let qr_b64 = match build_qr_payload(&url) {
        Ok(bytes) => {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode(bytes)
        }
        Err(e) => {
            eprintln!("[WiFi Sync] QR generation failed: {}", e);
            String::new()
        }
    };

    WifiSyncStatus {
        running: true,
        album_count: state.album_count,
        total_size_bytes: state.total_size_bytes,
        file_count: state.file_count,
        files,
        qr_code_png_base64: qr_b64,
        root_prefix: state.root_prefix.clone(),
        current_throughput_bps: current_bps(),
    }
}

// =====================================================================
//  Throughput tracking
// =====================================================================

/// Live throughput stats shared across all open ZIP streams.
///
/// Updated by `zip_stream::run_zip_writer` after each successful entry,
/// read by the `/throughput` endpoint and by `get_wifi_sync_status` so
/// the desktop UI can show "↓ 18 MB/s" while a transfer is in flight.
pub struct ThroughputStats {
    /// Bytes counted in the current measurement window.
    bytes_window: u64,
    /// Window start time — reset whenever a new transfer begins or the
    /// existing window is older than `WINDOW_DURATION`.
    window_start: Instant,
    /// Cumulative bytes since the server started (informational).
    pub total_bytes: u64,
    /// Last time `record_bytes` was called — used to consider the stream
    /// idle after `IDLE_GRACE`.
    last_emit: Option<Instant>,
}

const WINDOW_DURATION_MS: u64 = 1500;
const IDLE_GRACE_MS: u64 = 2000;

pub static WIFI_SYNC_STATS: Lazy<Mutex<ThroughputStats>> = Lazy::new(|| {
    Mutex::new(ThroughputStats {
        bytes_window: 0,
        window_start: Instant::now(),
        total_bytes: 0,
        last_emit: None,
    })
});

/// Record `n` bytes emitted by a ZIP stream task.
pub fn record_bytes(n: u64) {
    if n == 0 {
        return;
    }
    if let Ok(mut s) = WIFI_SYNC_STATS.lock() {
        let now = Instant::now();

        // If the previous emit was long ago, this counts as a fresh
        // transfer — reset the window so we don't average an old burst
        // with a new one.
        let stale = match s.last_emit {
            Some(t) => now.duration_since(t).as_millis() as u64 > IDLE_GRACE_MS,
            None => true,
        };
        if stale || now.duration_since(s.window_start).as_millis() as u64 > WINDOW_DURATION_MS * 2 {
            s.bytes_window = 0;
            s.window_start = now;
        }

        s.bytes_window = s.bytes_window.saturating_add(n);
        s.total_bytes = s.total_bytes.saturating_add(n);
        s.last_emit = Some(now);
    }
}

/// Current throughput in bytes/sec, or 0 if no transfer is active.
pub fn current_bps() -> u64 {
    let s = match WIFI_SYNC_STATS.lock() {
        Ok(s) => s,
        Err(_) => return 0,
    };
    let last = match s.last_emit {
        Some(t) => t,
        None => return 0,
    };
    let now = Instant::now();
    if now.duration_since(last).as_millis() as u64 > IDLE_GRACE_MS {
        return 0;
    }
    let elapsed_ms = now.duration_since(s.window_start).as_millis() as u64;
    if elapsed_ms == 0 {
        return 0;
    }
    // bytes/sec = bytes_window * 1000 / elapsed_ms
    s.bytes_window.saturating_mul(1000) / elapsed_ms.max(1)
}

/// Reset throughput counters — called when the server starts/stops.
pub fn reset_throughput() {
    if let Ok(mut s) = WIFI_SYNC_STATS.lock() {
        s.bytes_window = 0;
        s.total_bytes = 0;
        s.window_start = Instant::now();
        s.last_emit = None;
    }
}

// =====================================================================
//  Single-source-of-truth album track resolver
// =====================================================================

/// One track in an album, ready for streaming or sync planning.
#[derive(Clone, Debug)]
pub struct AlbumTrack {
    /// Local absolute path or `smb://...` URL — what the server reads from.
    pub source: String,
    /// Canonical destination relative path (without `root_prefix`).
    /// This is the **identity** key used everywhere in WiFi Sync v2:
    /// /status, /album/:id/manifest, /file lookup, and the
    /// `wifi_sync_synced` SQLite table.
    pub dest_rel: String,
    /// Best-effort byte size (estimated from bitrate × duration when the
    /// file size isn't in TRACKS_CACHE).
    pub size_bytes: u64,
    /// Track title (for the manifest UI).
    pub title: String,
    /// Track number (for the manifest UI).
    pub track_number: u32,
}

/// Full track list of one album, plus metadata for the WebUI.
#[derive(Clone, Debug)]
pub struct AlbumDetails {
    pub album_id: i64,
    pub artist: String,
    pub album: String,
    pub tracks: Vec<AlbumTrack>,
}

/// THE single source of truth for `dest_rel` across the WiFi Sync v2
/// surface. `/status`, `/album/:id/manifest`, and `/file` lookups all go
/// through this function so the path string is byte-identical between
/// "is it synced?" checks and "where do I write it?" decisions.
///
/// Previously /status (`build_album_list`) and the ZIP writer
/// (`zip_stream::collect_album`) each computed `dest_rel` independently;
/// any divergence (different `track_count`, different sanitization input)
/// caused already-synced albums to be flagged as un-synced. Centralizing
/// the computation here makes that class of bug structurally impossible.
pub fn compute_album_tracks(album_id: i64) -> Result<AlbumDetails, String> {
    let cache = TRACKS_CACHE
        .lock()
        .map_err(|e| format!("Cache lock failed: {}", e))?;
    compute_album_tracks_inner(&cache.tracks, album_id)
}

/// Pure version of `compute_album_tracks` that takes the track list as a
/// parameter instead of locking the global `TRACKS_CACHE`. Exists so
/// unit tests can exercise the full pipeline (filter → vote artist →
/// build dest_rel → sort → case-fold dedup) on synthetic fixtures
/// without touching global state. The wrapper above is a one-liner
/// that locks the cache and forwards the slice — preserve that.
pub(crate) fn compute_album_tracks_inner(
    all_tracks: &[crate::TrackWithMetadata],
    album_id: i64,
) -> Result<AlbumDetails, String> {
    use crate::dap_sync::sync_plan::{build_dest_path, TrackForSync};

    // Pre-count tracks per album for the disc-split heuristic in
    // `build_dest_path`. MUST be computed over the full slice, not just
    // the matching album, because the count drives which branch
    // (disc-split vs flat) is taken.
    let mut album_track_counts: HashMap<i64, usize> = HashMap::new();
    for t in all_tracks {
        let key = normalize_album_key(&t.metadata.album);
        *album_track_counts.entry(album_key_to_id(&key)).or_insert(0) += 1;
    }
    let track_count = *album_track_counts.get(&album_id).unwrap_or(&0);

    let mut tracks: Vec<AlbumTrack> = Vec::new();
    let mut artist_label = String::new();
    let mut album_label = String::new();

    // ── Pass 1: collect every matching track + vote on the canonical
    // album artist. We MUST have a single folder name for the whole
    // album, otherwise "Artist feat. X" vs "Artist feat. Y" explodes a
    // single album into N sibling folders on the DAP (regression
    // observed 2026-04: Kendrick Lamar — GNX split across 5 folders).
    //
    // Voting strategy: strip any "feat."/"ft."/"featuring" suffix from
    // each track.artist and tally the stripped form. The most common
    // wins. Ties are broken by insertion order (first track wins).
    let mut pending: Vec<&crate::TrackWithMetadata> = Vec::new();
    let mut aa_votes: HashMap<String, usize> = HashMap::new();
    let mut aa_order: Vec<String> = Vec::new();

    fn strip_featuring(artist: &str) -> String {
        // Case-insensitive split on " feat", " ft.", " featuring",
        // " (feat", " (ft". Take the left side and trim.
        let lower = artist.to_lowercase();
        let markers = [" feat", " ft.", " ft ", " featuring", " (feat", " (ft", " with "];
        let mut cut = artist.len();
        for m in &markers {
            if let Some(idx) = lower.find(m) {
                if idx < cut {
                    cut = idx;
                }
            }
        }
        artist[..cut].trim().to_string()
    }

    for t in all_tracks {
        let key = normalize_album_key(&t.metadata.album);
        if album_key_to_id(&key) != album_id {
            continue;
        }
        if album_label.is_empty() && !t.metadata.album.is_empty() {
            album_label = t.metadata.album.clone();
        }
        let stripped = strip_featuring(&t.metadata.artist);
        if !stripped.is_empty() {
            if !aa_votes.contains_key(&stripped) {
                aa_order.push(stripped.clone());
            }
            *aa_votes.entry(stripped).or_insert(0) += 1;
        }
        pending.push(t);
    }

    // Pick the winning canonical album artist (most votes, insertion
    // order tiebreak — the FIRST inserted candidate wins on ties).
    //
    // We can't use `aa_order.iter().max_by_key(...)` here: Rust's
    // `Iterator::max_by_key` returns the LAST element with the max key
    // when ties exist, which would silently flip canonicalization to the
    // last-seen candidate. For a real album that's usually fine; for a
    // tied compilation it would surface as a different folder name on
    // every restart depending on track read order. Walk the list once
    // and only replace on a strictly greater vote count.
    let canonical_album_artist: Option<String> = {
        let mut best: Option<&String> = None;
        let mut best_votes: usize = 0;
        for name in &aa_order {
            let v = aa_votes.get(name).copied().unwrap_or(0);
            if best.is_none() || v > best_votes {
                best = Some(name);
                best_votes = v;
            }
        }
        best.cloned()
    };
    if let Some(ref aa) = canonical_album_artist {
        artist_label = aa.clone();
    }

    // ── Pass 2: build dest_rel using the canonical album artist.
    for t in &pending {
        let t = *t;

        let track_for_sync = TrackForSync {
            path: t.path.clone(),
            title: t.metadata.title.clone(),
            artist: Some(t.metadata.artist.clone()),
            album: Some(t.metadata.album.clone()),
            album_artist: canonical_album_artist.clone(),
            genre: t.metadata.genre.clone(),
            track_number: Some(t.metadata.track),
            disc_number: t.metadata.disc,
            size_bytes: t.metadata.file_size.unwrap_or(0),
            modified_at: String::new(),
            album_id,
        };
        let dest_rel = build_dest_path(
            &track_for_sync,
            "artist_album_track",
            track_count,
            canonical_album_artist.as_deref(),
        );

        let size = t.metadata.file_size.unwrap_or_else(|| {
            let bitrate = t.metadata.bitrate.unwrap_or(320) as f64;
            ((bitrate * 1000.0 * t.metadata.duration) / 8.0 * 0.65) as u64
        });

        tracks.push(AlbumTrack {
            source: t.path.clone(),
            dest_rel,
            size_bytes: size,
            title: t.metadata.title.clone(),
            track_number: t.metadata.track,
        });
    }

    if artist_label.is_empty() {
        artist_label = "Unknown Artist".to_string();
    }
    if album_label.is_empty() {
        album_label = "Unknown Album".to_string();
    }

    // Stable order: by (disc, track_number, dest_rel) — same order the user
    // sees in HEAN's track view.
    tracks.sort_by(|a, b| {
        a.track_number
            .cmp(&b.track_number)
            .then_with(|| a.dest_rel.cmp(&b.dest_rel))
    });

    // Dedupe by dest_rel: if the user's library has multiple copies of the
    // same album (FLAC + MP3, local + NAS, re-scan after move…), the loop
    // above pulls every copy. Two tracks producing the same destination path
    // are functionally identical for sync — only one can land on the DAP
    // anyway. Keep the first occurrence (sorted by track number).
    //
    // CRITICAL: the dedup key is LOWERCASED. exFAT (the DAP filesystem) is
    // case-insensitive — "Time To Get Away.flac" and "Time to Get Away.flac"
    // collide on the same inode. A case-sensitive HashSet would keep both,
    // and Chromium's File System Access API would observe a divergence
    // between its cached handle and the real filesystem mid-write, throwing
    // InvalidStateError and leaving a 0-byte ghost file on disk. Root cause
    // of the "(1), (2), ..., (32)" ghost chains observed on the FiiO JM21
    // (see SD card forensics 2026-04).
    let mut seen_dest: HashSet<String> = HashSet::new();
    tracks.retain(|t| seen_dest.insert(t.dest_rel.to_lowercase()));

    Ok(AlbumDetails {
        album_id,
        artist: artist_label,
        album: album_label,
        tracks,
    })
}

/// Resolve the cover file (absolute path on disk + size) for an album.
/// Returns None if no cover is available locally. Uses the same lookup
/// strategy as the DAP sync engine but is restricted to local-disk hits
/// (no network IO) so the WebUI cover endpoint can stream synchronously.
pub fn resolve_album_cover(album_id: i64) -> Option<(String, u64)> {
    use crate::COVER_CACHE;
    use std::path::Path;

    // 1. Find the album label + a representative track path from TRACKS_CACHE
    let (artist_label, album_label, sample_track_path) = {
        let cache = TRACKS_CACHE.lock().ok()?;
        let mut artist = String::new();
        let mut album = String::new();
        let mut sample = String::new();
        for t in &cache.tracks {
            let key = normalize_album_key(&t.metadata.album);
            if album_key_to_id(&key) == album_id {
                if artist.is_empty() { artist = t.metadata.artist.clone(); }
                if album.is_empty()  { album  = t.metadata.album.clone();  }
                if sample.is_empty() { sample = t.path.clone();             }
                if !artist.is_empty() && !album.is_empty() && !sample.is_empty() {
                    break;
                }
            }
        }
        if sample.is_empty() { return None; }
        (artist, album, sample)
    };

    // 2. Snapshot the cover cache map under the lock so we can release it
    //    quickly before doing filesystem checks.
    let cover_map: HashMap<String, String> = {
        let cache = COVER_CACHE.lock().ok()?;
        cache.entries.clone()
    };

    // 3a. Exact track-path hit
    if let Some(p) = cover_map.get(&sample_track_path) {
        let path = Path::new(p);
        if path.exists() {
            if let Ok(meta) = std::fs::metadata(path) {
                return Some((p.clone(), meta.len()));
            }
        }
    }

    // 3b. Fuzzy: any cached cover for a track path that contains the album name
    let album_lower = album_label.to_lowercase();
    if !album_lower.is_empty() && album_lower != "unknown album" {
        for (cached_path, cover_path) in cover_map.iter() {
            if cached_path.to_lowercase().contains(&album_lower) {
                let p = Path::new(cover_path);
                if p.exists() {
                    if let Ok(meta) = std::fs::metadata(p) {
                        return Some((cover_path.clone(), meta.len()));
                    }
                }
            }
        }
    }

    // 3c. Internet-fetched cover at ~/.local/share/noir/covers/internet_<hash>.jpg
    let covers_dir = crate::get_data_dir().join("covers");
    let key = format!("{}|||{}", artist_label.to_lowercase(), album_label.to_lowercase());
    let hash = format!("{:x}", crate::dap_sync::sync_plan::md5_hash(&key));
    let internet = covers_dir.join(format!("internet_{}.jpg", hash));
    if internet.exists() {
        if let Ok(meta) = std::fs::metadata(&internet) {
            return Some((internet.to_string_lossy().to_string(), meta.len()));
        }
    }
    None
}

// =====================================================================
//  Album listing for the v2 /status endpoint
// =====================================================================

/// Build the album-based status response. Looks at the same selection
/// table as `build_allowed_files` so what shows up in the WebUI matches
/// what the user picked in the desktop sidebar, but groups by album and
/// flags `already_synced` per device.
pub fn build_album_list(
    dest_id: i64,
    device_uuid: &str,
) -> Result<(Vec<WifiSyncAlbum>, u64, u64), String> {
    let synced = db::get_synced_paths(device_uuid).unwrap_or_default();

    let selections = dap_sync::db::get_selections(dest_id)
        .map_err(|e| format!("Failed to get selections: {}", e))?;
    let selected_ids: HashSet<i64> = selections
        .into_iter()
        .filter(|(_, s)| *s)
        .map(|(id, _)| id)
        .collect();

    if selected_ids.is_empty() {
        return Ok((Vec::new(), 0, 0));
    }

    // Single source of truth: compute_album_tracks. Loop over selected
    // album ids and ask it for the canonical track list — exactly the
    // same `dest_rel` strings the /file endpoint will resolve at download
    // time, so set membership lookups can never disagree.
    let mut albums: Vec<WifiSyncAlbum> = Vec::new();
    let mut total_bytes: u64 = 0;
    let mut remaining_bytes: u64 = 0;

    for id in selected_ids {
        let details = match compute_album_tracks(id) {
            Ok(d) => d,
            Err(_) => continue, // album_id no longer in TRACKS_CACHE — skip
        };
        if details.tracks.is_empty() {
            continue;
        }
        let mut album_total: u64 = 0;
        let mut synced_count: usize = 0;
        for tr in &details.tracks {
            album_total = album_total.saturating_add(tr.size_bytes);
            if synced.contains(&tr.dest_rel) {
                synced_count += 1;
            }
        }
        let already_synced = synced_count == details.tracks.len();
        total_bytes = total_bytes.saturating_add(album_total);
        if !already_synced {
            remaining_bytes = remaining_bytes.saturating_add(album_total);
        }
        albums.push(WifiSyncAlbum {
            id: details.album_id,
            artist: details.artist,
            album: details.album,
            track_count: details.tracks.len(),
            total_bytes: album_total,
            already_synced,
        });
    }

    // Stable order: artist then album, alphabetical.
    albums.sort_by(|a, b| {
        a.artist
            .to_lowercase()
            .cmp(&b.artist.to_lowercase())
            .then_with(|| a.album.to_lowercase().cmp(&b.album.to_lowercase()))
    });

    Ok((albums, total_bytes, remaining_bytes))
}

// =====================================================================
//  QR code generation
// =====================================================================

/// Encode `text` as a QR code and render it to a PNG byte buffer.
///
/// Uses the `qrcode` crate to compute the boolean module matrix, then
/// hand-rasterizes it via the `image` 0.24 crate that ships with the
/// rest of the desktop. We deliberately avoid the `qrcode/image`
/// feature so we don't pull a second copy of the `image` crate (the
/// `qrcode` crate would otherwise require image 0.25).
pub fn build_qr_payload(text: &str) -> Result<Vec<u8>, String> {
    use image::{ImageBuffer, Luma};
    use qrcode::QrCode;

    let code = QrCode::new(text.as_bytes()).map_err(|e| format!("QR encode failed: {}", e))?;
    let modules = code.to_vec(); // row-major Vec<bool>
    let width = code.width();

    // Pixel scale + quiet zone (in modules).
    const SCALE: u32 = 8;
    const QUIET: u32 = 4;
    let img_w = (width as u32 + QUIET * 2) * SCALE;
    let img_h = img_w; // QR is square

    // Start with a fully-white image (light modules + quiet zone).
    let mut img: ImageBuffer<Luma<u8>, Vec<u8>> = ImageBuffer::from_pixel(img_w, img_h, Luma([255]));

    for y in 0..width {
        for x in 0..width {
            if modules[y * width + x] {
                let px = (x as u32 + QUIET) * SCALE;
                let py = (y as u32 + QUIET) * SCALE;
                for dy in 0..SCALE {
                    for dx in 0..SCALE {
                        img.put_pixel(px + dx, py + dy, Luma([0]));
                    }
                }
            }
        }
    }

    // Encode to PNG into an in-memory buffer.
    let mut out: Vec<u8> = Vec::new();
    {
        use image::codecs::png::PngEncoder;
        use image::ImageEncoder;
        let encoder = PngEncoder::new(&mut out);
        encoder
            .write_image(img.as_raw(), img_w, img_h, image::ColorType::L8)
            .map_err(|e| format!("PNG encode failed: {}", e))?;
    }

    Ok(out)
}

// =====================================================================
//  smb_buffer LRU cleanup
// =====================================================================

/// If `~/.local/share/noir/smb_buffer/` is larger than `limit_bytes`,
/// delete the oldest files (by mtime) until the directory is at or
/// below `target_bytes`.
///
/// Critical for the 500 GB sync use-case: each SMB resolution caches a
/// temp copy of the resolved track, so without periodic cleanup the
/// disk fills up.
pub fn ensure_smb_buffer_under(limit_bytes: u64, target_bytes: u64) {
    use std::fs;
    use std::time::SystemTime;

    let dir = crate::get_data_dir().join("smb_buffer");
    if !dir.exists() {
        return;
    }

    // First pass: total size + (path, size, mtime) tuples.
    let mut entries: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    let mut total: u64 = 0;
    let read_dir = match fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for ent in read_dir.flatten() {
        let path = ent.path();
        if let Ok(meta) = ent.metadata() {
            if meta.is_file() {
                let size = meta.len();
                let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                total = total.saturating_add(size);
                entries.push((path, size, mtime));
            }
        }
    }

    if total <= limit_bytes {
        return;
    }

    // Sort oldest first.
    entries.sort_by(|a, b| a.2.cmp(&b.2));

    let mut current = total;
    for (path, size, _) in entries {
        if current <= target_bytes {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            current = current.saturating_sub(size);
        }
    }

    #[cfg(debug_assertions)]
    println!(
        "[WiFi Sync] smb_buffer cleanup: {} → {} bytes",
        total, current
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_album_key_to_id_basic() {
        // Verify the hash function produces consistent results
        let id1 = album_key_to_id("Some Album");
        let id2 = album_key_to_id("Some Album");
        assert_eq!(id1, id2);
        assert!(id1 > 0);
    }

    #[test]
    fn test_album_key_to_id_different_albums() {
        let id1 = album_key_to_id("Album A");
        let id2 = album_key_to_id("Album B");
        assert_ne!(id1, id2);
    }

    #[test]
    fn test_base64_url_roundtrip() {
        let path = "/Users/test/Music/Artist/Album/track.flac";
        let encoded = base64_url_encode(path);
        let decoded = base64_url_decode(&encoded).unwrap();
        assert_eq!(path, decoded);
    }

    #[test]
    fn test_generate_token() {
        let token = generate_token();
        assert_eq!(token.len(), 16);
        assert!(token.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn test_normalize_album_key() {
        let key = normalize_album_key("  Some Album  ");
        assert_eq!(key, "Some Album");
    }

    // ────────────────────────────────────────────────────────────────
    //  compute_album_tracks_inner — pure version, tested without
    //  touching the global TRACKS_CACHE.
    //
    //  These tests cover the two server-side fixes for the FSA cascade
    //  cause #1 (case-fold dedup) and cause #2 (canonical album_artist
    //  voting). Both fixes were added 2026-04 after the FiiO JM21
    //  forensics revealed exFAT-driven ghost files. Any regression here
    //  would silently bring back the InvalidStateError cascade — these
    //  tests are the only line of defense.
    // ────────────────────────────────────────────────────────────────

    /// Build a fake `TrackWithMetadata` for unit tests. Defaults are
    /// realistic enough that `build_dest_path` produces the expected
    /// `Artist/Album/NN - Title.flac` shape.
    fn make_track(
        artist: &str,
        album: &str,
        title: &str,
        track_no: u32,
    ) -> crate::TrackWithMetadata {
        crate::TrackWithMetadata {
            path: format!("/test/{}/{}/{}.flac", artist, album, title),
            name: format!("{}.flac", title),
            folder: format!("/test/{}/{}", artist, album),
            metadata: crate::Metadata {
                title: title.to_string(),
                artist: artist.to_string(),
                album: album.to_string(),
                track: track_no,
                disc: None,
                year: Some(2024),
                genre: None,
                genre_enriched: false,
                duration: 180.0,
                bit_depth: Some(16),
                sample_rate: Some(44100),
                bitrate: Some(1411),
                codec: Some("flac".to_string()),
                file_size: Some(10_000_000),
            },
        }
    }

    #[test]
    fn compute_inner_happy_path_single_album() {
        // Two simple tracks of the same album under one artist.
        let tracks = vec![
            make_track("Daft Punk", "Discovery", "One More Time", 1),
            make_track("Daft Punk", "Discovery", "Aerodynamic", 2),
        ];
        let album_id = album_key_to_id(&normalize_album_key("Discovery"));
        let result = compute_album_tracks_inner(&tracks, album_id).expect("compute ok");

        assert_eq!(result.album, "Discovery");
        assert_eq!(result.artist, "Daft Punk");
        assert_eq!(result.tracks.len(), 2);
        // Tracks must be sorted by track_number
        assert_eq!(result.tracks[0].track_number, 1);
        assert_eq!(result.tracks[1].track_number, 2);
        // dest_rel must follow "{Artist} - {Album}/NN - Title" pattern
        // (single-level layout — see build_dest_path notes about exFAT
        // ghost-dir prevention).
        assert!(
            result.tracks[0]
                .dest_rel
                .starts_with("Daft Punk - Discovery/"),
            "got dest_rel = {}",
            result.tracks[0].dest_rel
        );
    }

    #[test]
    fn compute_inner_dedup_case_collisions_on_exfat() {
        // CRITICAL — cause #1 of the FSA cascade.
        // exFAT (the FAT-family filesystem on every microSD card) is
        // case-insensitive: "Time To Get Away.flac" and "Time to Get
        // Away.flac" collide on the same inode. A case-sensitive dedup
        // (HashSet<String>) would keep both, and Chromium's FSA would
        // observe a divergence between its cached handle and the real
        // filesystem mid-write, throwing InvalidStateError and leaving
        // a 0-byte ghost file. This test verifies the .to_lowercase()
        // dedup key.
        // Both colliding tracks must carry the SAME track_number, otherwise
        // the "NN - " prefix in the filename keeps their dest_rels distinct
        // and dedup never fires. Real-world trigger: a library that contains
        // both a FLAC and a re-tagged duplicate of the same track at the
        // same position.
        let tracks = vec![
            make_track("David Joseph", "Conversations", "In A Diner", 1),
            make_track("David Joseph", "Conversations", "in a Diner", 1),
            make_track("David Joseph", "Conversations", "Track Three", 2),
        ];
        let album_id = album_key_to_id(&normalize_album_key("Conversations"));
        let result = compute_album_tracks_inner(&tracks, album_id).expect("compute ok");

        // 3 tracks in → 2 unique destinations out (the case-collision
        // pair collapses).
        assert_eq!(
            result.tracks.len(),
            2,
            "expected case-fold dedup to collapse 'In A Diner' and 'in a Diner' \
             onto a single dest_rel; got {} tracks: {:?}",
            result.tracks.len(),
            result
                .tracks
                .iter()
                .map(|t| &t.dest_rel)
                .collect::<Vec<_>>()
        );

        // The two surviving dest_rels must differ when lowercased
        // (otherwise the dedup didn't actually run).
        let lowered: Vec<String> = result
            .tracks
            .iter()
            .map(|t| t.dest_rel.to_lowercase())
            .collect();
        assert_eq!(
            lowered.iter().collect::<std::collections::HashSet<_>>().len(),
            2,
            "surviving dest_rels collide after lowercasing: {:?}",
            lowered
        );
    }

    #[test]
    fn compute_inner_canonical_artist_strips_featuring_kendrick_gnx() {
        // CRITICAL — cause #2 of the FSA cascade.
        // Reproduces the Kendrick Lamar GNX regression: 5 tracks where
        // every track.artist carries a different "feat. X" suffix
        // ("Kendrick Lamar feat. SZA", "feat. Dody6", etc.). Without
        // canonical voting, build_dest_path uses each track's raw
        // artist as the folder name → 5 sibling folders on the DAP →
        // album exploded → exFAT cache corruption → cascade.
        //
        // The fix votes on a stripped form (everything before the
        // first " feat" / " ft." / " featuring" marker) and uses the
        // most common one for ALL tracks of the album.
        let tracks = vec![
            make_track("Kendrick Lamar feat. SZA", "GNX", "luther", 1),
            make_track("Kendrick Lamar feat. Dody6", "GNX", "hey now", 2),
            make_track("Kendrick Lamar", "GNX", "wacced out murals", 3),
            make_track("Kendrick Lamar feat. AzChike", "GNX", "peekaboo", 4),
            make_track("Kendrick Lamar feat. SZA", "GNX", "gloria", 5),
        ];
        let album_id = album_key_to_id(&normalize_album_key("GNX"));
        let result = compute_album_tracks_inner(&tracks, album_id).expect("compute ok");

        // All 5 tracks must survive (no dedup expected — distinct titles).
        assert_eq!(result.tracks.len(), 5);

        // The canonical artist must be "Kendrick Lamar" (most votes
        // after stripping feat.).
        assert_eq!(result.artist, "Kendrick Lamar");

        // CRITICAL: every dest_rel must live under the SAME artist
        // folder. If even one starts with "Kendrick Lamar feat. SZA/"
        // then the album is exploded and the cascade returns.
        for t in &result.tracks {
            assert!(
                t.dest_rel.starts_with("Kendrick Lamar - "),
                "track exploded into a feat. folder: dest_rel = {}",
                t.dest_rel
            );
            // Make sure no leftover " feat" sneaked into the path
            assert!(
                !t.dest_rel.to_lowercase().contains(" feat"),
                "dest_rel still carries a 'feat' marker: {}",
                t.dest_rel
            );
        }
    }

    #[test]
    fn compute_inner_canonical_artist_handles_ft_and_with_variants() {
        // The strip_featuring helper recognises several markers. This
        // exercises the less common ones to lock the contract.
        let tracks = vec![
            make_track("Artist Name ft. X", "Album", "T1", 1),
            make_track("Artist Name (feat. Y)", "Album", "T2", 2),
            make_track("Artist Name", "Album", "T3", 3),
            make_track("Artist Name with Z", "Album", "T4", 4),
            make_track("Artist Name featuring W", "Album", "T5", 5),
        ];
        let album_id = album_key_to_id(&normalize_album_key("Album"));
        let result = compute_album_tracks_inner(&tracks, album_id).expect("compute ok");

        assert_eq!(result.tracks.len(), 5);
        assert_eq!(result.artist, "Artist Name");
        for t in &result.tracks {
            assert!(
                t.dest_rel.starts_with("Artist Name - "),
                "variant exploded: {}",
                t.dest_rel
            );
        }
    }

    #[test]
    fn compute_inner_canonical_artist_majority_wins_with_tiebreak() {
        // Two candidates after stripping: "A" (3 votes) and "B" (2
        // votes). "A" must win. Then we flip the order to verify
        // insertion-order tiebreak when votes are equal.
        let tracks_a_majority = vec![
            make_track("A feat. X", "Compilation", "T1", 1),
            make_track("B", "Compilation", "T2", 2),
            make_track("A", "Compilation", "T3", 3),
            make_track("A feat. Y", "Compilation", "T4", 4),
            make_track("B feat. Z", "Compilation", "T5", 5),
        ];
        let album_id = album_key_to_id(&normalize_album_key("Compilation"));
        let result = compute_album_tracks_inner(&tracks_a_majority, album_id).unwrap();
        assert_eq!(result.artist, "A");

        // Tie case: 2 vs 2 — the FIRST inserted candidate must win.
        // The voting loop intentionally uses a manual fold (not
        // `max_by_key`) so insertion order is preserved on ties; the
        // first track's stripped artist is the canonical form, which
        // gives the user a stable folder name across restarts. This
        // test was the smoking gun that surfaced the original
        // `max_by_key` regression — locking it.
        let tracks_tied = vec![
            make_track("Beta", "Tied", "T1", 1),
            make_track("Alpha", "Tied", "T2", 2),
            make_track("Beta feat. X", "Tied", "T3", 3),
            make_track("Alpha", "Tied", "T4", 4),
        ];
        let album_id = album_key_to_id(&normalize_album_key("Tied"));
        let result = compute_album_tracks_inner(&tracks_tied, album_id).unwrap();
        assert_eq!(
            result.artist, "Beta",
            "tie must resolve to FIRST inserted candidate (stable folder name across restarts)"
        );
    }

    #[test]
    fn compute_inner_filters_other_albums() {
        // The slice can carry the entire library — only the matching
        // album_id should make it into the result.
        let tracks = vec![
            make_track("Artist", "Album One", "Song 1", 1),
            make_track("Artist", "Album One", "Song 2", 2),
            make_track("Artist", "Album Two", "Song A", 1),
            make_track("Artist", "Album Two", "Song B", 2),
            make_track("Artist", "Album Two", "Song C", 3),
        ];
        let album_one = album_key_to_id(&normalize_album_key("Album One"));
        let result = compute_album_tracks_inner(&tracks, album_one).unwrap();
        assert_eq!(result.album, "Album One");
        assert_eq!(result.tracks.len(), 2);
    }

    #[test]
    fn compute_inner_unknown_album_id_returns_empty() {
        // A bogus album_id should yield an empty (but Ok) result —
        // the WebUI relies on this to render an empty manifest rather
        // than crashing.
        let tracks = vec![make_track("Artist", "Real Album", "Song", 1)];
        let bogus_id: i64 = 999_999_999;
        let result = compute_album_tracks_inner(&tracks, bogus_id).unwrap();
        assert_eq!(result.tracks.len(), 0);
        // Labels fall back to "Unknown ..." when nothing matched.
        assert_eq!(result.artist, "Unknown Artist");
        assert_eq!(result.album, "Unknown Album");
    }

    #[test]
    fn compute_inner_dedup_collapses_duplicate_library_entries() {
        // Real-world case: the same album is scanned twice (e.g. once
        // from a local rip and once from a NAS re-import). Two distinct
        // source paths produce identical (artist, album, track_no, title)
        // tuples → identical dest_rel → dedup must collapse them so we
        // don't try to write the same file twice and trigger the FSA
        // cascade.
        let mut local = make_track("Artist", "Album", "Song", 1);
        local.path = "/library/local/Artist/Album/01 Song.flac".to_string();
        let mut nas = make_track("Artist", "Album", "Song", 1);
        nas.path = "smb://nas-uuid/share/Artist/Album/01 Song.flac".to_string();

        let album_id = album_key_to_id(&normalize_album_key("Album"));
        let result =
            compute_album_tracks_inner(&[local, nas], album_id).expect("compute ok");

        // Two source rows in, one survivor out.
        assert_eq!(
            result.tracks.len(),
            1,
            "duplicate-source dedup failed: {:?}",
            result.tracks.iter().map(|t| &t.dest_rel).collect::<Vec<_>>()
        );
    }
}
