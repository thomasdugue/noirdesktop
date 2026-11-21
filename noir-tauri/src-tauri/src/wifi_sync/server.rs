// wifi_sync/server.rs — HTTPS server (axum + rustls) + mDNS discovery (v2)
//
// What changed vs. v1:
//
//   * HTTPS via axum-server + rustls (self-signed cert from `tls.rs`).
//     Eliminates Chrome's "Insecure Download Blocking" — the deal-breaker
//     for the previous HTTP build.
//
//   * Routes are now album-based (`GET /album/:id.zip`) instead of
//     per-file. The DAP browser fires *one* download per album which
//     produces *one* OS save prompt — survivable for 500 GB libraries.
//
//   * Per-device incremental tracking (`GET /status?device=UUID` returns
//     `alreadySynced: true` for albums whose files are all present in the
//     `wifi_sync_synced` SQLite table).
//
//   * `GET /throughput` exposes a live MB/s figure for the WebUI to poll.
//
//   * `DELETE /sync-state` lets the user reset the per-device manifest.
//
//   * mDNS service type changed to `_https._tcp.local.` so DAPs that
//     filter discovery by protocol see the right thing.
//
//   * After every SMB resolution we call `ensure_smb_buffer_under()` so
//     500 GB syncs don't fill the disk with cached temp files.

use super::{
    build_album_list, compute_album_tracks, current_bps, db, ensure_smb_buffer_under,
    token_hash_prefix, webui, zip_stream, WifiSyncStatusV2,
};
use crate::{network, parse_smb_uri, NETWORK_SOURCES};
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Json, Response},
    Router,
};
use axum_extra::{headers::Range, TypedHeader};
use axum_range::{KnownSize, RangeBody, Ranged};
use serde::Deserialize;
use tokio_util::io::ReaderStream;
use axum_server::{tls_rustls::RustlsConfig, Handle};
use mdns_sd::{ServiceDaemon, ServiceInfo};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

/// Shared state for the axum server. Held in an `Arc` so all the handler
/// closures can read from it without contention.
pub struct ServerState {
    pub token: String,
    pub dest_id: i64,
    pub root_prefix: String,
}

#[derive(serde::Deserialize)]
pub struct TokenQuery {
    token: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct StatusQuery {
    token: Option<String>,
    device: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct AlbumQuery {
    token: Option<String>,
    device: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct FileQuery {
    token: Option<String>,
    #[serde(default)]
    album: Option<i64>,
    #[serde(default)]
    path: Option<String>,
}

/// Body of `POST /sync-mark` — the DAP browser confirms a single file has
/// been written to disk via the File System Access API.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncMarkBody {
    pub album_id: i64,
    pub dest_rel: String,
    pub size_bytes: i64,
    #[serde(default)]
    pub quick_hash: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestTrack {
    dest_rel: String,
    title: String,
    track_number: u32,
    size_bytes: u64,
    already_synced: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestResponse {
    album_id: i64,
    artist: String,
    album: String,
    root_prefix: String,
    tracks: Vec<ManifestTrack>,
    /// Filename of the cover available on disk (e.g. "cover.jpg"), or
    /// empty string if no cover is available locally.
    has_cover: bool,
    cover_size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ThroughputResponse {
    bytes_per_sec: u64,
    total_bytes: u64,
}

/// Build the axum `Router` for the WiFi Sync server. Extracted from
/// `start_server` so the integration tests in `mod tests` can hit every
/// route directly via `tower::ServiceExt::oneshot()` — no TLS, no socket,
/// no port allocation, no parallel-test cross-talk on port 8443. The
/// production `start_server` calls this then wraps the result in
/// `axum_server::from_tcp_rustls`. Any new route must be added here so
/// the test surface stays in sync with the live router.
pub fn build_router(state: Arc<ServerState>) -> Router {
    // Token-protected routes.
    let protected = Router::new()
        .route("/status", axum::routing::get(handle_status))
        // Legacy v2.0 ZIP-per-album route — kept as a fallback for browsers
        // without File System Access API support (older Chromium, Safari).
        .route("/album/:album_id", axum::routing::get(handle_album_zip))
        // v2.1 per-file streaming + manifest — used by the FSA-API client.
        .route(
            "/album/:album_id/manifest",
            axum::routing::get(handle_album_manifest),
        )
        .route(
            "/album/:album_id/cover",
            axum::routing::get(handle_album_cover),
        )
        .route("/file", axum::routing::get(handle_file_stream))
        .route("/sync-mark", axum::routing::post(handle_sync_mark))
        .route("/throughput", axum::routing::get(handle_throughput))
        .route("/sync-state", axum::routing::delete(handle_reset_state))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            token_middleware,
        ));

    // The root WebUI is public — the HTML embeds the token in JS so the
    // user only types the bare URL on the DAP, no query string. The font
    // file is also public so PWA installs can fetch it without auth.
    Router::new()
        .route("/", axum::routing::get(handle_root))
        .route("/font/geist-mono.woff2", axum::routing::get(handle_font))
        .route("/ping", axum::routing::get(handle_ping))
        // Public debug log sink — the WebUI posts JS errors here so they
        // surface in the Rust terminal (the DAP Chromium has no reachable
        // devtools on some models). No token: we want errors from the
        // earliest load phase before the WebUI has authenticated.
        .route("/debug/log", axum::routing::post(handle_debug_log))
        .merge(protected)
        .with_state(state)
}

/// Start the HTTPS server + mDNS. Returns the join handle (so the caller
/// can abort it on stop) and the axum-server `Handle` (so the caller can
/// gracefully drain in-flight ZIP streams before shutting the listener).
pub async fn start_server(
    state: Arc<ServerState>,
    port: u16,
    cert_path: std::path::PathBuf,
    key_path: std::path::PathBuf,
) -> Result<(tokio::task::JoinHandle<()>, Handle), String> {
    // Load the self-signed cert + key into a rustls config.
    let tls_config = RustlsConfig::from_pem_file(&cert_path, &key_path)
        .await
        .map_err(|e| format!("Failed to load TLS config: {}", e))?;

    let app = build_router(state);

    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));

    // Pre-bind a std::net::TcpListener so we surface "Address already in use"
    // (or any other socket-level error) synchronously instead of swallowing
    // it inside the spawned task. axum-server can take over an existing
    // listener via `from_tcp_rustls`, which is exactly what we want here.
    let std_listener = std::net::TcpListener::bind(addr)
        .map_err(|e| format!("Failed to bind {}: {} (port already in use? firewall?)", addr, e))?;
    std_listener
        .set_nonblocking(true)
        .map_err(|e| format!("Failed to set listener non-blocking: {}", e))?;

    #[cfg(debug_assertions)]
    println!("[WiFi Sync] HTTPS server bound on {}", addr);

    let handle = Handle::new();
    let handle_clone = handle.clone();

    let join = tokio::spawn(async move {
        if let Err(e) = axum_server::from_tcp_rustls(std_listener, tls_config)
            .handle(handle_clone)
            .serve(app.into_make_service())
            .await
        {
            eprintln!("[WiFi Sync] Server error: {}", e);
        }
    });

    Ok((join, handle))
}

/// Middleware: every protected route requires `?token=<server token>`.
async fn token_middleware(
    State(state): State<Arc<ServerState>>,
    Query(q): Query<TokenQuery>,
    req: axum::extract::Request,
    next: Next,
) -> Response {
    match q.token {
        Some(ref t) if t == &state.token => next.run(req).await,
        _ => (StatusCode::FORBIDDEN, "Invalid or missing token").into_response(),
    }
}

/// `GET /` — serve the WebUI HTML with the token injected.
async fn handle_root(State(state): State<Arc<ServerState>>) -> Html<String> {
    let html = webui::WEBUI_HTML.replace("{{TOKEN}}", &state.token);
    Html(html)
}

/// `GET /status?device=UUID&token=...` — album-based status.
///
/// Returns:
///   * `albums`: every selected album with its size + already-synced flag
///   * `totalBytes` / `remainingBytes`: aggregate counters for the WebUI
///
/// `device` is optional — if absent we return the full list with every
/// album marked as not-synced (effectively a "fresh device" view).
async fn handle_status(
    State(state): State<Arc<ServerState>>,
    Query(q): Query<StatusQuery>,
) -> Response {
    let device_uuid = q.device.unwrap_or_default();
    match build_album_list(state.dest_id, &device_uuid) {
        Ok((albums, total, remaining)) => {
            let body = WifiSyncStatusV2 {
                running: true,
                device_uuid,
                root_prefix: state.root_prefix.clone(),
                albums,
                total_bytes: total,
                remaining_bytes: remaining,
            };
            Json(body).into_response()
        }
        Err(e) => {
            eprintln!("[WiFi Sync] /status build failed: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Status error: {}", e),
            )
                .into_response()
        }
    }
}

/// `GET /album/:album_id?device=UUID&token=...` — stream a ZIP of one album.
///
/// The ZIP is constructed lazily by `zip_stream::build_album_zip_body`,
/// which spawns a writer task feeding a duplex pipe → axum body. The
/// response uses chunked transfer-encoding because the final size is
/// unknown until every track has been read.
async fn handle_album_zip(
    State(state): State<Arc<ServerState>>,
    Path(album_id_str): Path<String>,
    Query(q): Query<AlbumQuery>,
) -> Response {
    // Strip the optional `.zip` suffix the WebUI tacks on for friendlier
    // download filenames in some browsers.
    let id_only = album_id_str.trim_end_matches(".zip");
    let album_id: i64 = match id_only.parse() {
        Ok(n) => n,
        Err(_) => {
            return (StatusCode::BAD_REQUEST, "Invalid album id").into_response();
        }
    };

    let device_uuid = q.device.unwrap_or_default();
    if device_uuid.is_empty() {
        return (StatusCode::BAD_REQUEST, "Missing device parameter").into_response();
    }

    // Best-effort cache cleanup before we start pulling SMB files. The
    // limits below match the plan: keep smb_buffer/ at <= 5 GiB, purge
    // down to 3 GiB when triggered.
    tokio::task::spawn_blocking(|| {
        ensure_smb_buffer_under(5 * 1024 * 1024 * 1024, 3 * 1024 * 1024 * 1024);
    });

    match zip_stream::build_album_zip_body(album_id, device_uuid, state.root_prefix.clone()) {
        Ok((body, filename)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/zip")
            .header(
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{}\"", filename),
            )
            // No Content-Length: we're streaming, the size is unknown.
            // Tell intermediaries to not cache the response.
            .header(header::CACHE_CONTROL, "no-store")
            .body(body)
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        Err(e) => {
            eprintln!("[WiFi Sync] album zip build failed: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("ZIP error: {}", e),
            )
                .into_response()
        }
    }
}

/// `GET /throughput?token=...` — current download speed for the WebUI.
async fn handle_throughput() -> Json<ThroughputResponse> {
    let bps = current_bps();
    let total = super::WIFI_SYNC_STATS
        .lock()
        .map(|s| s.total_bytes)
        .unwrap_or(0);
    Json(ThroughputResponse {
        bytes_per_sec: bps,
        total_bytes: total,
    })
}

/// `DELETE /sync-state?device=UUID&token=...` — wipe one device's history.
async fn handle_reset_state(Query(q): Query<HashMap<String, String>>) -> Response {
    let device = match q.get("device") {
        Some(d) if !d.is_empty() => d,
        _ => {
            return (StatusCode::BAD_REQUEST, "Missing device parameter").into_response();
        }
    };
    match db::clear_device(device) {
        Ok(n) => (StatusCode::OK, format!("Cleared {} entries", n)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Reset failed: {}", e),
        )
            .into_response(),
    }
}

/// Register the mDNS service so `hean.local` resolves on the LAN and the
/// HTTPS port is advertised under `_https._tcp.local.`.
pub fn register_mdns(ip: &str, port: u16) -> Result<ServiceDaemon, String> {
    let mdns = ServiceDaemon::new()
        .map_err(|e| format!("Failed to create mDNS daemon: {}", e))?;

    let service_type = "_https._tcp.local.";
    let instance_name = "HEAN WiFi Sync";
    let host = "hean.local.";

    let properties = [("path", "/")];

    let service_info = ServiceInfo::new(
        service_type,
        instance_name,
        host,
        ip,
        port,
        &properties[..],
    )
    .map_err(|e| format!("Failed to create ServiceInfo: {}", e))?;

    mdns.register(service_info)
        .map_err(|e| format!("Failed to register mDNS service: {}", e))?;

    #[cfg(debug_assertions)]
    println!(
        "[WiFi Sync] mDNS registered: {} -> {}:{}",
        host, ip, port
    );

    Ok(mdns)
}

/// Convenience helper for callers that want to ask the server to drain
/// in-flight requests with a small grace period.
#[allow(dead_code)]
pub fn graceful_shutdown(handle: &Handle) {
    handle.graceful_shutdown(Some(Duration::from_secs(2)));
}

// =====================================================================
//  v2.1: per-file streaming for File System Access API clients
// =====================================================================

/// `GET /album/:album_id/manifest?device=...&token=...` — return the
/// canonical track list for one album, with `alreadySynced` per track.
///
/// The DAP-side JS iterates this list and fetches each track via
/// `GET /file?album=...&path=<destRel>`, writing the bytes to a directory
/// the user picked once via `showDirectoryPicker()`. No ZIP, no per-file
/// download prompts, no extraction.
async fn handle_album_manifest(
    State(state): State<Arc<ServerState>>,
    Path(album_id_str): Path<String>,
    Query(q): Query<AlbumQuery>,
) -> Response {
    let album_id: i64 = match album_id_str.parse() {
        Ok(n) => n,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid album id").into_response(),
    };
    let device_uuid = q.device.unwrap_or_default();

    let details = match compute_album_tracks(album_id) {
        Ok(d) => d,
        Err(e) => {
            return (StatusCode::NOT_FOUND, format!("Album not found: {}", e)).into_response();
        }
    };

    // Per-track already_synced lookup, identical to /status semantics.
    let synced = if device_uuid.is_empty() {
        std::collections::HashSet::new()
    } else {
        db::get_synced_paths(&device_uuid).unwrap_or_default()
    };

    let tracks: Vec<ManifestTrack> = details
        .tracks
        .into_iter()
        .map(|t| {
            let already = synced.contains(&t.dest_rel);
            ManifestTrack {
                already_synced: already,
                dest_rel: t.dest_rel,
                title: t.title,
                track_number: t.track_number,
                size_bytes: t.size_bytes,
            }
        })
        .collect();

    let cover = super::resolve_album_cover(album_id);
    let (has_cover, cover_size) = match &cover {
        Some((_, sz)) => (true, *sz),
        None => (false, 0),
    };

    Json(ManifestResponse {
        album_id: details.album_id,
        artist: details.artist,
        album: details.album,
        root_prefix: state.root_prefix.clone(),
        tracks,
        has_cover,
        cover_size,
    })
    .into_response()
}

/// `GET /album/:album_id/cover?token=...&device=...` — stream the album
/// cover JPEG/PNG (if available locally). Mirrors the resolution logic the
/// DAP sync engine uses, but never touches the network.
async fn handle_album_cover(
    State(_state): State<Arc<ServerState>>,
    Path(album_id_str): Path<String>,
    Query(_q): Query<AlbumQuery>,
) -> Response {
    let album_id: i64 = match album_id_str.parse() {
        Ok(n) => n,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid album id").into_response(),
    };
    let (cover_path, size) = match super::resolve_album_cover(album_id) {
        Some(p) => p,
        None => return (StatusCode::NOT_FOUND, "No cover").into_response(),
    };
    let file = match tokio::fs::File::open(&cover_path).await {
        Ok(f) => f,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Open failed: {}", e),
            )
                .into_response();
        }
    };
    let mime = if cover_path.to_lowercase().ends_with(".png") {
        "image/png"
    } else {
        "image/jpeg"
    };
    let stream = ReaderStream::with_capacity(file, 64 * 1024);
    let body = Body::from_stream(stream);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, size)
        .header(header::CACHE_CONTROL, "no-store")
        .body(body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// `GET /file?album=ID&path=<destRel>&token=...` — stream a single audio
/// file. Uses `compute_album_tracks` to map (album_id, dest_rel) → source
/// path so the lookup is byte-identical to what the manifest endpoint
/// returned (no string normalization drift possible).
async fn handle_file_stream(
    State(_state): State<Arc<ServerState>>,
    Query(q): Query<FileQuery>,
    range: Option<TypedHeader<Range>>,
) -> Response {
    let album_id = match q.album {
        Some(id) => id,
        None => return (StatusCode::BAD_REQUEST, "Missing album parameter").into_response(),
    };
    let dest_rel = match q.path {
        Some(p) if !p.is_empty() => p,
        _ => return (StatusCode::BAD_REQUEST, "Missing path parameter").into_response(),
    };

    // Best-effort SMB cache cleanup before pulling new bytes.
    tokio::task::spawn_blocking(|| {
        ensure_smb_buffer_under(5 * 1024 * 1024 * 1024, 3 * 1024 * 1024 * 1024);
    });

    let details = match compute_album_tracks(album_id) {
        Ok(d) => d,
        Err(e) => {
            return (StatusCode::NOT_FOUND, format!("Album not found: {}", e)).into_response();
        }
    };

    let track = match details.tracks.iter().find(|t| t.dest_rel == dest_rel) {
        Some(t) => t.clone(),
        None => {
            return (
                StatusCode::NOT_FOUND,
                format!("Track not found in album: {}", dest_rel),
            )
                .into_response();
        }
    };

    // Resolve SMB sources to a local cached file. Local paths pass through.
    let local_path = if track.source.starts_with("smb://") {
        match resolve_smb_to_local(track.source.clone()).await {
            Ok(p) => p,
            Err(e) => {
                eprintln!(
                    "[WiFi Sync] SMB resolve failed for {}: {}",
                    track.source, e
                );
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("SMB resolve failed: {}", e),
                )
                    .into_response();
            }
        }
    } else {
        track.source.clone()
    };

    // Open with tokio for async streaming. `KnownSize::file` stat's the
    // file so `Ranged` can serve byte offsets and emit `Accept-Ranges` /
    // `Content-Range` for self-healing resume on the client side.
    let file = match tokio::fs::File::open(&local_path).await {
        Ok(f) => f,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Open failed: {}", e),
            )
                .into_response();
        }
    };
    let body = match KnownSize::file(file).await {
        Ok(b) => b,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Stat failed: {}", e),
            )
                .into_response();
        }
    };
    let total_len = body.byte_size();

    // Suggest a filename in case the browser falls back to a save dialog
    // (only happens when the FSA write path errors out).
    let filename = std::path::Path::new(&dest_rel)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| "track.flac".to_string());

    // Let `Ranged` build the core response (200 / 206 / 416 + Content-Range
    // + Accept-Ranges handled for us), then layer our custom headers on top.
    let ranged_range = range.map(|TypedHeader(r)| r);
    let mut resp = Ranged::new(ranged_range, body).into_response();
    let headers = resp.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{}\"", filename)) {
        headers.insert(header::CONTENT_DISPOSITION, v);
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    // Custom header so the FSA client can echo it back in /sync-mark
    // without having to recompute the hash on a write-only stream.
    if let Ok(v) = HeaderValue::from_str(&total_len.to_string()) {
        headers.insert("X-Track-Size", v);
    }
    resp
}

/// `POST /sync-mark?device=...&token=...` body: SyncMarkBody — record one
/// track as synced for the given device. The DAP browser POSTs this after
/// successfully writing the file via the FSA API.
async fn handle_sync_mark(
    Query(q): Query<HashMap<String, String>>,
    Json(body): Json<SyncMarkBody>,
) -> Response {
    let device = match q.get("device") {
        Some(d) if !d.is_empty() => d.clone(),
        _ => return (StatusCode::BAD_REQUEST, "Missing device parameter").into_response(),
    };

    if body.dest_rel.is_empty() {
        return (StatusCode::BAD_REQUEST, "Missing destRel").into_response();
    }

    // Sanity check: confirm the dest_rel is actually one we'd produce for
    // this album. Prevents a malicious client from polluting the DB with
    // arbitrary strings (limited blast radius — they could only mark
    // tracks they own — but cheap to verify).
    if let Ok(details) = compute_album_tracks(body.album_id) {
        let valid = details.tracks.iter().any(|t| t.dest_rel == body.dest_rel);
        if !valid {
            return (
                StatusCode::BAD_REQUEST,
                "destRel does not belong to albumId",
            )
                .into_response();
        }
    } else {
        return (StatusCode::NOT_FOUND, "Album not found").into_response();
    }

    let entry = db::SyncedEntry {
        dest_relative_path: body.dest_rel,
        // Hash is informational for now (used by future drift detection).
        // The client may pass an empty string when it can't compute one
        // from a write-only FSA stream.
        quick_hash: if body.quick_hash.is_empty() {
            "client-confirmed".to_string()
        } else {
            body.quick_hash
        },
        size_bytes: body.size_bytes,
    };

    match db::mark_synced(&device, &[entry]) {
        Ok(()) => (StatusCode::OK, "marked").into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("mark_synced failed: {}", e),
        )
            .into_response(),
    }
}

/// `GET /ping` — public liveness probe used by the WebUI to detect a stale
/// token without ever triggering a 403. Returns the short SHA-256 prefix of
/// the active token; the client compares it against the one embedded in its
/// loaded HTML. Mismatch → "HEAN was restarted, please refresh".
async fn handle_ping(State(state): State<Arc<ServerState>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true,
        "version": "wifi-sync-v2.2",
        "tokenHash": token_hash_prefix(&state.token),
    }))
}

/// `POST /debug/log` — public log sink for WebUI-side errors.
///
/// Body: `{ level: "error"|"warn"|"log", msg: string, device: string }`.
/// We intentionally accept this unauthenticated so early-boot JS errors
/// (before a token is loaded) still land in the terminal, and so field
/// debugging on a DAP that has no reachable devtools is possible.
#[derive(Deserialize)]
struct DebugLogBody {
    #[serde(default)]
    level: Option<String>,
    #[serde(default)]
    msg: Option<String>,
    #[serde(default)]
    device: Option<String>,
}

async fn handle_debug_log(Json(body): Json<DebugLogBody>) -> Response {
    let level = body.level.unwrap_or_else(|| "log".to_string());
    let msg = body.msg.unwrap_or_default();
    let device = body.device.unwrap_or_else(|| "?".to_string());
    // Truncate the device UUID to the first 12 chars so the log stays readable.
    let short_dev: String = device.chars().take(12).collect();
    // Clamp the message length so a rogue client can't flood the terminal.
    let clamped: String = if msg.len() > 2000 {
        format!("{}...<truncated {} bytes>", &msg[..2000], msg.len() - 2000)
    } else {
        msg
    };
    eprintln!(
        "[WebUI {} {}] {}",
        level.to_uppercase(),
        short_dev,
        clamped
    );
    StatusCode::NO_CONTENT.into_response()
}

/// `GET /font/geist-mono.woff2` — serve the embedded font so the WebUI
/// can match HEAN's typography exactly without depending on a CDN.
async fn handle_font() -> Response {
    const FONT_BYTES: &[u8] =
        include_bytes!("../../../src/fonts/GeistMono-Variable.woff2");
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "font/woff2")
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .body(Body::from(FONT_BYTES))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// SMB resolver — duplicated from `zip_stream.rs` so the streaming
/// handler is self-contained. Same construction (spawn_blocking +
/// `download_smb_to_temp`).
async fn resolve_smb_to_local(smb_uri: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let (source_id, share, remote_path) =
            parse_smb_uri(&smb_uri).ok_or_else(|| format!("Invalid SMB URI: {}", smb_uri))?;

        let source = {
            let sources = NETWORK_SOURCES.lock().map_err(|e| e.to_string())?;
            sources
                .iter()
                .find(|s| s.id == source_id)
                .cloned()
                .ok_or_else(|| format!("Network source not found: {}", source_id))?
        };

        let password = network::credentials::retrieve_password(&source.id)
            .map_err(|e| format!("Cannot retrieve NAS password: {}", e))?;
        network::smb::store_credentials(
            &source.credentials.username,
            &password,
            source.credentials.domain.as_deref(),
            source.credentials.is_guest,
        );

        let temp = network::scanner::download_smb_to_temp(&source, &share, &remote_path)?;
        Ok(temp.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {}", e))?
}

// =====================================================================
//  Niveau 2 — HTTP integration tests
//
//  These exercise `build_router()` directly via `tower::ServiceExt::oneshot`.
//  No TLS, no socket bind, no port allocation — every test runs in-process
//  against the same Router production wires up. The point is to lock the
//  invariants the v2.2 plan calls out as bug surface:
//
//    * `/ping` is public (no token), returns the live tokenHash so the
//      WebUI can detect a stale token without ever tripping a 403.
//    * Every protected route returns 403 on missing/wrong token.
//    * Public routes (`/font/...`, `/debug/log`) stay public so PWA
//      installs and earliest-boot JS errors keep working.
//    * Bad input on protected routes still returns the right 4xx (not 500).
//
//  We deliberately do NOT cover routes that depend on `TRACKS_CACHE` or
//  the `dap_sync` SQLite DB being populated (e.g. /status with selections,
//  /file streaming a real audio file). Those need fixture plumbing that's
//  out of scope for this sprint — niveau 1 already covers the resolver
//  with synthetic fixtures, and the routes themselves are thin wrappers
//  whose failure modes (token, parsing, missing parameters) are what
//  these tests pin down.
// =====================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    /// Build a Router seeded with a known token + dummy dest_id. The
    /// `dest_id` is intentionally garbage (-1) — none of the routes we
    /// hit in these tests should reach the `dap_sync` DB layer with it.
    fn make_router(token: &str) -> Router {
        let state = Arc::new(ServerState {
            token: token.to_string(),
            dest_id: -1,
            root_prefix: "HEAN".to_string(),
        });
        build_router(state)
    }

    async fn body_to_string(resp: Response) -> String {
        let bytes = resp
            .into_body()
            .collect()
            .await
            .expect("collect body")
            .to_bytes();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    /// `GET /ping` — public, returns ok=true and a tokenHash that
    /// matches `token_hash_prefix(token)`. This is the route the WebUI
    /// polls before every reload to detect a stale token.
    #[tokio::test]
    async fn ping_is_public_and_returns_token_hash() {
        let token = "secret-token-1234";
        let router = make_router(token);

        let resp = router
            .oneshot(
                Request::builder()
                    .uri("/ping")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_to_string(resp).await;
        let v: serde_json::Value = serde_json::from_str(&body).expect("ping returns JSON");
        assert_eq!(v["ok"], true);
        assert_eq!(v["version"], "wifi-sync-v2.2");
        assert_eq!(
            v["tokenHash"].as_str().unwrap(),
            super::super::token_hash_prefix(token),
            "/ping must echo the live token hash so the WebUI can detect restarts"
        );
    }

    /// Whenever HEAN restarts the token may rotate. The WebUI compares
    /// the embedded token hash against `/ping` and refreshes when they
    /// diverge. If two routers built with different tokens returned the
    /// same hash, the stale-token UX would silently break.
    #[tokio::test]
    async fn ping_token_hash_differs_per_token() {
        let h1 = body_to_string(
            make_router("alpha")
                .oneshot(Request::builder().uri("/ping").body(Body::empty()).unwrap())
                .await
                .unwrap(),
        )
        .await;
        let h2 = body_to_string(
            make_router("bravo")
                .oneshot(Request::builder().uri("/ping").body(Body::empty()).unwrap())
                .await
                .unwrap(),
        )
        .await;
        assert_ne!(h1, h2, "different tokens must yield different /ping bodies");
    }

    /// Protected routes return 403 when no `?token=` query param is
    /// present. Locks the middleware contract — without this, a missing
    /// query string could land on a handler with `q.token == None`.
    #[tokio::test]
    async fn protected_route_without_token_is_forbidden() {
        let router = make_router("real-token");

        let resp = router
            .oneshot(
                Request::builder()
                    .uri("/status?device=abc")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    /// Protected routes return 403 when the `?token=` query param is
    /// present but does not match the server token. This is the exact
    /// stale-token symptom from the bug report — pinning it ensures
    /// any future change to `token_middleware` keeps emitting 403, not
    /// e.g. 401 (which the WebUI doesn't special-case).
    #[tokio::test]
    async fn protected_route_with_wrong_token_is_forbidden() {
        let router = make_router("real-token");

        let resp = router
            .oneshot(
                Request::builder()
                    .uri("/status?device=abc&token=wrong-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    /// `/throughput` is protected. With a valid token + empty
    /// throughput state it must return 200 + a JSON object with the
    /// expected snake_case fields renamed to camelCase. Locks the
    /// /throughput contract the WebUI polls every 500ms.
    #[tokio::test]
    async fn throughput_with_valid_token_returns_camelcase_json() {
        let router = make_router("good-token");

        let resp = router
            .oneshot(
                Request::builder()
                    .uri("/throughput?token=good-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_to_string(resp).await;
        let v: serde_json::Value = serde_json::from_str(&body).expect("throughput returns JSON");
        assert!(v.get("bytesPerSec").is_some(), "missing bytesPerSec field");
        assert!(v.get("totalBytes").is_some(), "missing totalBytes field");
    }

    /// `/album/<garbage>/manifest` returns 400 — the route extractor
    /// itself succeeds (Path<String>) so this is the handler's
    /// `i64::parse` branch that catches non-numeric ids. Pins the
    /// contract the WebUI relies on to surface "Invalid album id"
    /// rather than a 5xx.
    #[tokio::test]
    async fn album_manifest_with_non_numeric_id_returns_400() {
        let router = make_router("good-token");

        let resp = router
            .oneshot(
                Request::builder()
                    .uri("/album/not-a-number/manifest?token=good-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    /// `/file` without an `album` query param returns 400 — same
    /// reasoning as the manifest test, but for the per-file streaming
    /// endpoint that the FSA-API client hits per-track.
    #[tokio::test]
    async fn file_stream_without_album_param_returns_400() {
        let router = make_router("good-token");

        let resp = router
            .oneshot(
                Request::builder()
                    .uri("/file?token=good-token&path=foo")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    /// `/file?album=1` (no `path`) returns 400 — covers the second
    /// branch of the parameter validator. Without this test the
    /// branch could regress to "missing path" returning 500 because
    /// `compute_album_tracks` would be called with an empty dest_rel.
    #[tokio::test]
    async fn file_stream_without_path_param_returns_400() {
        let router = make_router("good-token");

        let resp = router
            .oneshot(
                Request::builder()
                    .uri("/file?token=good-token&album=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    /// `/sync-mark` requires `?device=...`. Body alone is not enough.
    /// Locks the device-tied contract so we never accidentally start
    /// marking files for an empty device key (which would silently
    /// fail to surface as "synced" on any DAP).
    #[tokio::test]
    async fn sync_mark_without_device_returns_400() {
        let router = make_router("good-token");

        let body_json = serde_json::json!({
            "albumId": 1,
            "destRel": "Foo - Bar/01 - Baz.flac",
            "sizeBytes": 1024,
        })
        .to_string();

        let resp = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/sync-mark?token=good-token")
                    .header("content-type", "application/json")
                    .body(Body::from(body_json))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    /// `/debug/log` is public (no token). The WebUI POSTs early-boot JS
    /// errors here before it even has a token loaded. Returns 204 No
    /// Content on a well-formed body.
    #[tokio::test]
    async fn debug_log_is_public_and_returns_204() {
        let router = make_router("any-token");

        let body_json = serde_json::json!({
            "level": "error",
            "msg": "test message",
            "device": "test-device-uuid",
        })
        .to_string();

        let resp = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/debug/log")
                    .header("content-type", "application/json")
                    .body(Body::from(body_json))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    }

    /// `/font/geist-mono.woff2` is public so the WebUI can match HEAN's
    /// typography on the DAP without needing a token query param in the
    /// CSS @font-face. Locks the public-asset contract.
    #[tokio::test]
    async fn font_endpoint_is_public_and_serves_woff2() {
        let router = make_router("any-token");

        let resp = router
            .oneshot(
                Request::builder()
                    .uri("/font/geist-mono.woff2")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let ct = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        assert_eq!(ct, "font/woff2");
    }

    /// `GET /` serves the WebUI HTML with `{{TOKEN}}` substituted. This
    /// is the substitution that broke v2.2 in the wild — if it ever
    /// stops happening, the page loads with the literal placeholder and
    /// every protected fetch immediately 403s.
    #[tokio::test]
    async fn root_html_substitutes_token_placeholder() {
        let token = "uniq-test-token-9876";
        let router = make_router(token);

        let resp = router
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_to_string(resp).await;
        assert!(
            body.contains(token),
            "WebUI HTML must contain the live token after substitution"
        );
        assert!(
            !body.contains("{{TOKEN}}"),
            "WebUI HTML must not still carry the {{TOKEN}} placeholder"
        );
    }
}

