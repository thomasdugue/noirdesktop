// wifi_sync/zip_stream.rs — Streaming ZIP-per-album body for the HTTPS server
//
// One ZIP per album = one OS download prompt on the DAP browser. The ZIP is
// streamed (transfer-encoding: chunked, no Content-Length) so we don't need
// to scan all files upfront — entries are appended as soon as each track
// is read from disk (or fetched from SMB).
//
// Pipeline:
//
//   ┌──────────────┐  duplex pipe  ┌─────────────┐  ReaderStream  ┌──────────┐
//   │  ZIP writer  │──────────────▶│ axum::Body  │───────────────▶│  client  │
//   │ (background  │               │ from_stream │                │ (DAP)    │
//   │   task)      │               └─────────────┘                └──────────┘
//   └──────────────┘
//
// At end-of-stream the background task records the synced files in
// `wifi_sync_synced` so the next /status call marks the album as
// `alreadySynced`.

use crate::dap_sync::sync_plan::{build_dest_path, sanitize_filename, TrackForSync};
use crate::wifi_sync::{album_key_to_id, db, normalize_album_key};
use crate::{network, parse_smb_uri, NETWORK_SOURCES, TRACKS_CACHE};

use async_zip::base::write::ZipFileWriter;
use async_zip::{Compression, ZipEntryBuilder};
use axum::body::Body;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tokio::io::AsyncReadExt;
use tokio_util::compat::TokioAsyncWriteCompatExt;
use tokio_util::io::ReaderStream;

/// One track resolved out of TRACKS_CACHE, ready for ZIP packing.
struct ResolvedTrack {
    /// Source: either an absolute local path or an `smb://...` URL.
    source: String,
    /// Bare destination relative path (e.g. `Artist/Album/01 - Song.flac`).
    /// This is the **identity** of the file across syncs, regardless of
    /// what `root_prefix` happens to be configured to. Stored verbatim in
    /// `wifi_sync_synced` so that changing the prefix doesn't invalidate
    /// the entire sync history.
    dest_rel: String,
    /// Path *inside* the ZIP, including the configurable `root_prefix`
    /// (e.g. `HEAN/Artist/Album/01 - Song.flac`). Cosmetic — only affects
    /// where the file lands when the user extracts the archive.
    zip_path: String,
    /// Best-effort byte size for stat tracking (may be 0 if unknown).
    size_bytes: u64,
}

/// Build a streaming ZIP body for one album.
///
/// Returns `(body, suggested_filename)` — the caller wires the body into the
/// HTTP response and uses the filename for the `Content-Disposition` header.
///
/// `device_uuid` is used at end-of-stream to mark the album as synced for
/// that device. `root_prefix` is the user-configurable root folder name
/// (e.g. `"HEAN"`) — embedded in the ZIP so the post-extract layout is
/// `Downloads/HEAN/Artist/Album/track.flac` rather than a flat dump.
pub fn build_album_zip_body(
    album_id: i64,
    device_uuid: String,
    root_prefix: String,
) -> Result<(Body, String), String> {
    // 1. Locate the album in TRACKS_CACHE and collect every matching track.
    //    We do this synchronously up front because TRACKS_CACHE uses a
    //    std::sync::Mutex which we can't hold across await points anyway.
    let (resolved, album_label, album_track_count) = collect_album(album_id, &root_prefix)?;

    if resolved.is_empty() {
        return Err(format!("Album {} not found or empty", album_id));
    }

    let zip_filename = sanitize_filename(&format!("{}.zip", album_label));

    // 2. Set up an in-memory pipe between the ZIP writer and the HTTP body.
    //    64 KiB matches the chunk size used elsewhere in the audio pipeline
    //    and is large enough to keep the writer fed without burning memory.
    let (writer_half, reader_half) = tokio::io::duplex(64 * 1024);

    // 3. Spawn the ZIP writer task. It owns the writer half of the pipe and
    //    drops it when done — that EOFs the reader half, which terminates
    //    the HTTP body cleanly.
    let _ = album_track_count; // (kept for future per-disc subfolder logic)
    tokio::spawn(async move {
        if let Err(e) = run_zip_writer(writer_half, resolved, device_uuid).await {
            eprintln!("[WiFi Sync ZIP] writer task failed: {}", e);
            // Dropping `writer_half` happens automatically on return → the
            // client gets a truncated ZIP, which curl/browsers detect as a
            // CRC error. Retrying re-issues the same request.
        }
    });

    // 4. Wrap the reader half as a Stream and feed it to axum.
    let stream = ReaderStream::new(reader_half);
    let body = Body::from_stream(stream);

    Ok((body, zip_filename))
}

/// Look up the album in TRACKS_CACHE and translate every track into a
/// `ResolvedTrack` with the destination path already prefixed.
fn collect_album(
    album_id: i64,
    root_prefix: &str,
) -> Result<(Vec<ResolvedTrack>, String, usize), String> {
    let cache = TRACKS_CACHE
        .lock()
        .map_err(|e| format!("TRACKS_CACHE lock failed: {}", e))?;

    // First pass: count tracks per album_id (needed for the disc-split
    // logic inside build_dest_path).
    let mut album_count: HashMap<i64, usize> = HashMap::new();
    for t in &cache.tracks {
        let key = normalize_album_key(&t.metadata.album);
        *album_count.entry(album_key_to_id(&key)).or_insert(0) += 1;
    }
    let track_count = *album_count.get(&album_id).unwrap_or(&0);

    let mut resolved: Vec<ResolvedTrack> = Vec::new();
    let mut album_label: Option<String> = None;
    let prefix = root_prefix.trim().trim_matches('/');

    for t in &cache.tracks {
        let key = normalize_album_key(&t.metadata.album);
        if album_key_to_id(&key) != album_id {
            continue;
        }

        // Capture a friendly "Artist - Album" string the first time we see
        // a matching track. Used as the ZIP filename.
        if album_label.is_none() {
            let artist = if t.metadata.artist.is_empty() {
                "Unknown Artist"
            } else {
                t.metadata.artist.as_str()
            };
            let album = if t.metadata.album.is_empty() {
                "Unknown Album"
            } else {
                t.metadata.album.as_str()
            };
            album_label = Some(format!("{} - {}", artist, album));
        }

        // Reuse build_dest_path to get the same Artist/Album/NN - Title.ext
        // layout as the DAP sync subsystem.
        let track_for_sync = TrackForSync {
            path: t.path.clone(),
            title: t.metadata.title.clone(),
            artist: Some(t.metadata.artist.clone()),
            album: Some(t.metadata.album.clone()),
            // Metadata struct has no album_artist field — fall back to
            // the track artist via build_dest_path's default branch.
            album_artist: None,
            genre: t.metadata.genre.clone(),
            track_number: Some(t.metadata.track),
            disc_number: t.metadata.disc,
            size_bytes: t.metadata.file_size.unwrap_or(0),
            modified_at: String::new(),
            album_id,
        };

        let rel = build_dest_path(&track_for_sync, "artist_album_track", track_count, None);

        // Prefix with root folder so the user-configurable target lands in
        // Downloads/<prefix>/Artist/Album/... — cosmetic, only affects the
        // ZIP entry path, NOT what we record in `wifi_sync_synced`.
        let zip_path = if prefix.is_empty() {
            rel.clone()
        } else {
            format!("{}/{}", prefix, rel)
        };

        resolved.push(ResolvedTrack {
            source: t.path.clone(),
            dest_rel: rel,
            zip_path,
            size_bytes: t.metadata.file_size.unwrap_or(0),
        });
    }

    let label = album_label.unwrap_or_else(|| format!("album-{}", album_id));
    Ok((resolved, label, track_count))
}

/// Background task: write every resolved track into the ZIP, then mark
/// them all as synced for `device_uuid`.
async fn run_zip_writer(
    writer: tokio::io::DuplexStream,
    resolved: Vec<ResolvedTrack>,
    device_uuid: String,
) -> Result<(), String> {
    let mut zip = ZipFileWriter::new(writer.compat_write());
    let mut synced: Vec<db::SyncedEntry> = Vec::new();

    for track in resolved {
        // Resolve SMB URLs to a local cached temp file. Local paths pass
        // through unchanged. The blocking SMB code is run on a dedicated
        // tokio blocking thread.
        let local_path = if track.source.starts_with("smb://") {
            match resolve_smb_to_local(track.source.clone()).await {
                Ok(p) => p,
                Err(e) => {
                    eprintln!(
                        "[WiFi Sync ZIP] SMB resolve failed for {}: {} — skipping",
                        track.source, e
                    );
                    continue;
                }
            }
        } else {
            track.source.clone()
        };

        // Read the whole file into memory. For audio files this is
        // typically 5-30 MB; ZIP entries need a final size+CRC anyway.
        let bytes = match tokio::fs::read(&local_path).await {
            Ok(b) => b,
            Err(e) => {
                eprintln!(
                    "[WiFi Sync ZIP] read failed for {}: {} — skipping",
                    local_path, e
                );
                continue;
            }
        };

        // Stored compression — FLAC/AAC/MP3 are already compressed.
        let entry =
            ZipEntryBuilder::new(track.zip_path.clone().into(), Compression::Stored).build();

        if let Err(e) = zip.write_entry_whole(entry, &bytes).await {
            eprintln!(
                "[WiFi Sync ZIP] write_entry_whole failed for {}: {}",
                track.zip_path, e
            );
            continue;
        }

        // Update the global throughput counter so /throughput and the
        // desktop status command can show a live MB/s figure.
        crate::wifi_sync::record_bytes(bytes.len() as u64);

        // Build a quick hash (SHA-256 of the first 4KB + last 4KB) so the
        // sync table can later detect "same dest path but different file".
        let hash = quick_hash(&bytes);
        let size = if track.size_bytes > 0 {
            track.size_bytes as i64
        } else {
            bytes.len() as i64
        };
        // Record the BARE relative path (no root_prefix) — that's the
        // identity. The same identity must be reproduced verbatim by
        // `build_album_list` for incremental sync to work.
        synced.push(db::SyncedEntry {
            dest_relative_path: track.dest_rel,
            quick_hash: hash,
            size_bytes: size,
        });
    }

    // Finalize the ZIP — without this the file is corrupt (no central
    // directory). The compat writer is dropped here, which flushes and
    // closes the duplex pipe → client sees the end of the body.
    zip.close()
        .await
        .map_err(|e| format!("zip close failed: {}", e))?;

    // Mark everything we managed to pack as synced. If the connection died
    // mid-stream the spawn would have errored before reaching this point,
    // so partial syncs don't pollute the table.
    if !synced.is_empty() {
        if let Err(e) = db::mark_synced(&device_uuid, &synced) {
            eprintln!("[WiFi Sync ZIP] mark_synced failed: {}", e);
        }
    }

    Ok(())
}

/// SHA-256 of (first 4 KiB || last 4 KiB) — same construction as
/// `dap_sync::sync_engine::compute_quick_hash` so a future migration can
/// share state with the DAP sync table without re-hashing.
fn quick_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    let head_len = bytes.len().min(4096);
    hasher.update(&bytes[..head_len]);
    if bytes.len() > 4096 {
        let tail_start = bytes.len().saturating_sub(4096);
        hasher.update(&bytes[tail_start..]);
    }
    let digest = hasher.finalize();
    let mut s = String::with_capacity(64);
    for b in digest.iter() {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// Resolve an `smb://uuid/share/remote/path` URL to a local cached temp
/// file by reusing the existing SMB scanner cache. Identical to the helper
/// in `server.rs` — duplicated here so the streaming task is self-contained
/// and we don't have to plumb a function reference through.
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

#[cfg(test)]
mod tests {
    use super::quick_hash;

    #[test]
    fn quick_hash_short_buffer() {
        // Buffer smaller than 4 KiB → only the head is hashed once.
        let h = quick_hash(b"hello world");
        assert_eq!(h.len(), 64);
    }

    #[test]
    fn quick_hash_long_buffer_distinguishes() {
        let mut a = vec![0u8; 9000];
        let mut b = vec![0u8; 9000];
        a[8999] = 1;
        b[8999] = 2;
        assert_ne!(quick_hash(&a), quick_hash(&b));
    }
}
