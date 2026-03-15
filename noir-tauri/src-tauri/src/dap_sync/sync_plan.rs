use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use super::manifest::{SyncManifest, SyncedFile};

/// Helper: compute the same hash as lib.rs md5_hash() for cover cache lookups.
/// Uses DefaultHasher (SipHash) — NOT cryptographic, just for filename generation.
pub fn md5_hash(input: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    input.hash(&mut hasher);
    hasher.finish()
}

/// Track info passed from frontend for sync plan computation.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrackForSync {
    pub path: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub genre: Option<String>,
    pub track_number: Option<u32>,
    pub disc_number: Option<u32>,
    pub size_bytes: u64,
    pub modified_at: String,
    pub album_id: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncPlan {
    pub files_to_copy: Vec<SyncAction>,
    pub files_to_delete: Vec<SyncAction>,
    pub files_unchanged: usize,
    pub total_copy_bytes: u64,
    pub total_delete_bytes: u64,
    pub net_bytes: i64,
    pub destination_free_bytes: u64,
    pub destination_total_bytes: u64,
    pub enough_space: bool,
    pub covers_to_copy: Vec<CoverSyncAction>,
    pub total_cover_bytes: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncAction {
    pub source_path: String,
    pub dest_relative_path: String,
    pub size_bytes: u64,
    pub action: String, // "copy" | "overwrite" | "delete"
    pub album_name: String,
    pub artist_name: String,
    pub album_id: i64,
}

/// A cover file to copy to the DAP (one per album folder).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CoverSyncAction {
    pub source_cover_path: String,   // absolute path in covers/ dir
    pub dest_relative_path: String,  // e.g. "Artist/Album/cover.jpg"
    pub size_bytes: u64,
}

/// Normalize a source path for consistent comparison (handles double slashes, trailing slashes).
fn normalize_path(path: &str) -> String {
    // For smb:// URIs, preserve the protocol prefix and normalize the rest
    if let Some(rest) = path.strip_prefix("smb://") {
        let normalized_rest = rest.replace("//", "/");
        return format!("smb://{}", normalized_rest.trim_end_matches('/'));
    }
    path.replace("//", "/").trim_end_matches('/').to_string()
}

/// Resolve the cover file path for an album from local cache.
/// Returns Some((absolute_cover_path, size_bytes)) or None.
/// NO network I/O, NO SMB access — local disk only.
fn resolve_cover_for_album(
    track_path: &str,
    artist: &str,
    album: &str,
    cover_cache: &HashMap<String, String>,
    covers_dir: &Path,
) -> Option<(String, u64)> {
    // 1. Check COVER_CACHE: track_path → absolute cover file on disk
    if let Some(cover_path) = cover_cache.get(track_path) {
        let p = Path::new(cover_path);
        if p.exists() {
            if let Ok(meta) = std::fs::metadata(p) {
                return Some((cover_path.clone(), meta.len()));
            }
        }
    }

    // 2. Check for internet cover: internet_{md5(artist|||album)}.jpg
    let album_key = format!("{}|||{}", artist.to_lowercase(), album.to_lowercase());
    let hash = format!("{:x}", md5_hash(&album_key));
    let internet_cover = covers_dir.join(format!("internet_{}.jpg", hash));
    if internet_cover.exists() {
        if let Ok(meta) = std::fs::metadata(&internet_cover) {
            return Some((internet_cover.to_string_lossy().to_string(), meta.len()));
        }
    }

    None
}

/// Compute the sync plan by comparing selected tracks against the existing manifest.
pub fn compute_sync_plan(
    tracks: &[TrackForSync],
    manifest: &Option<SyncManifest>,
    folder_structure: &str,
    mirror_mode: bool,
    dest_free_bytes: u64,
    dest_total_bytes: u64,
    cover_cache: &HashMap<String, String>,
    covers_dir: &Path,
) -> SyncPlan {
    let total_start = std::time::Instant::now();

    // Build a lookup from dest_relative_path -> SyncedFile for the existing manifest.
    // We compare by destination path (derived from metadata: artist/album/track) instead of
    // source_path, because source paths are fragile (SMB UUIDs, mount paths change between
    // sessions). The dest_relative_path is deterministic from metadata and stable across sessions.
    let t0 = std::time::Instant::now();
    let manifest_lookup: HashMap<String, &SyncedFile> = manifest
        .as_ref()
        .map(|m| m.files.iter().map(|f| (f.dest_relative_path.clone(), f)).collect())
        .unwrap_or_default();
    eprintln!("[PERF-RS] manifest_lookup build: {:?} ({} entries)", t0.elapsed(), manifest_lookup.len());

    let mut files_to_copy = Vec::new();
    let mut files_unchanged: usize = 0;
    let mut total_copy_bytes: u64 = 0;

    // Track which dest_relative_paths are selected (for mirror mode delete detection)
    let mut selected_dest_paths: std::collections::HashSet<String> = std::collections::HashSet::new();

    let t2 = std::time::Instant::now();

    for track in tracks {
        let dest_rel = build_dest_path(track, folder_structure);
        selected_dest_paths.insert(dest_rel.clone());

        if manifest_lookup.contains_key(&dest_rel) {
            // File already on DAP — same destination path means same content (artist/album/track match)
            files_unchanged += 1;
        } else {
            // New file — use size_bytes from frontend (estimated from metadata).
            // We skip fs::metadata() here because it's extremely slow on SMB mounts
            // (~12ms per file × 800 files = 10 seconds). The real file size will be
            // determined during the actual sync copy operation.
            total_copy_bytes += track.size_bytes;
            files_to_copy.push(SyncAction {
                source_path: track.path.clone(),
                dest_relative_path: dest_rel,
                size_bytes: track.size_bytes,
                action: "copy".into(),
                album_name: track.album.clone().unwrap_or_else(|| "Unknown Album".into()),
                artist_name: track.artist.clone().unwrap_or_else(|| "Unknown Artist".into()),
                album_id: track.album_id,
            });
        }
    }
    eprintln!("[PERF-RS] track loop: {:?} ({} tracks, {} unchanged, {} to copy)",
        t2.elapsed(), tracks.len(), files_unchanged, files_to_copy.len());

    // Mirror mode: find files in manifest that are no longer selected → delete
    let mut files_to_delete = Vec::new();
    let mut total_delete_bytes: u64 = 0;

    if mirror_mode {
        if let Some(m) = manifest {
            for file in &m.files {
                if !selected_dest_paths.contains(&file.dest_relative_path) {
                    total_delete_bytes += file.size_bytes;
                    files_to_delete.push(SyncAction {
                        source_path: file.source_path.clone(),
                        dest_relative_path: file.dest_relative_path.clone(),
                        size_bytes: file.size_bytes,
                        action: "delete".into(),
                        album_name: String::new(),
                        artist_name: String::new(),
                        album_id: 0, // album_id not tracked for deleted files (mirror mode)
                    });
                }
            }
        }
    }

    // --- Cover resolution: one cover.jpg per album folder ---
    let mut covers_to_copy: Vec<CoverSyncAction> = Vec::new();
    let mut total_cover_bytes: u64 = 0;

    if folder_structure != "flat" {
        // Collect unique album folders with a representative track for cover resolution.
        // We need covers for ALL albums on DAP (both new and unchanged).
        let mut album_folders: HashMap<String, (&str, &str, &str)> = HashMap::new(); // folder → (track_path, artist, album)

        for track in tracks {
            let dest_rel = build_dest_path(track, folder_structure);
            // Extract album folder = everything before the last '/'
            if let Some(pos) = dest_rel.rfind('/') {
                let folder = &dest_rel[..pos];
                album_folders.entry(folder.to_string()).or_insert((
                    &track.path,
                    track.artist.as_deref().unwrap_or("Unknown Artist"),
                    track.album.as_deref().unwrap_or("Unknown Album"),
                ));
            }
        }

        for (folder, (track_path, artist, album)) in &album_folders {
            let cover_dest = format!("{}/cover.jpg", folder);

            // Check if cover already in manifest (same size → skip)
            if let Some(existing) = manifest_lookup.get(&cover_dest) {
                // Cover already on DAP — check if local cover changed
                if let Some((source, size)) = resolve_cover_for_album(track_path, artist, album, cover_cache, covers_dir) {
                    if size != existing.size_bytes {
                        // Cover updated locally → overwrite
                        total_cover_bytes += size;
                        covers_to_copy.push(CoverSyncAction {
                            source_cover_path: source,
                            dest_relative_path: cover_dest,
                            size_bytes: size,
                        });
                    }
                    // else: same size → unchanged, skip
                }
                // else: no local cover but one on DAP → keep DAP version
                continue;
            }

            // No cover in manifest → resolve and add
            if let Some((source, size)) = resolve_cover_for_album(track_path, artist, album, cover_cache, covers_dir) {
                total_cover_bytes += size;
                covers_to_copy.push(CoverSyncAction {
                    source_cover_path: source,
                    dest_relative_path: cover_dest,
                    size_bytes: size,
                });
            }
        }
    }

    let net_bytes = (total_copy_bytes + total_cover_bytes) as i64 - total_delete_bytes as i64;
    let enough_space = net_bytes <= 0 || (net_bytes as u64) <= dest_free_bytes;

    eprintln!("[PERF-RS] compute_sync_plan TOTAL: {:?} | {} to copy, {} covers, {} to delete, {} unchanged",
        total_start.elapsed(), files_to_copy.len(), covers_to_copy.len(), files_to_delete.len(), files_unchanged);

    SyncPlan {
        files_to_copy,
        files_to_delete,
        files_unchanged,
        total_copy_bytes,
        total_delete_bytes,
        net_bytes,
        destination_free_bytes: dest_free_bytes,
        destination_total_bytes: dest_total_bytes,
        enough_space,
        covers_to_copy,
        total_cover_bytes,
    }
}

/// Build the destination relative path for a track based on folder structure.
pub fn build_dest_path(track: &TrackForSync, structure: &str) -> String {
    let artist = sanitize_filename(track.artist.as_deref().unwrap_or("Unknown Artist"));
    let album_artist = sanitize_filename(track.album_artist.as_deref().unwrap_or(&artist));
    let album = sanitize_filename(track.album.as_deref().unwrap_or("Unknown Album"));
    let genre = sanitize_filename(track.genre.as_deref().unwrap_or("Unknown Genre"));

    let track_num = track.track_number.unwrap_or(0);
    let title = sanitize_filename(&track.title);

    let extension = Path::new(&track.path)
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_else(|| "flac".into());

    let filename = if track_num > 0 {
        format!("{:02} - {}.{}", track_num, title, extension)
    } else {
        format!("{}.{}", title, extension)
    };

    match structure {
        "artist_album_track" => format!("{}/{}/{}", artist, album, filename),
        "albumartist_album_track" => format!("{}/{}/{}", album_artist, album, filename),
        "genre_artist_album_track" => format!("{}/{}/{}/{}", genre, artist, album, filename),
        "flat" => filename,
        _ => format!("{}/{}/{}", artist, album, filename),
    }
}

/// Sanitize a string for use as a filename on FAT32/exFAT/NTFS.
pub fn sanitize_filename(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect();

    // Trim leading/trailing whitespace and dots
    let trimmed = sanitized.trim().trim_end_matches('.');

    // Truncate to 200 chars for FAT32 safety
    if trimmed.len() > 200 {
        // Find a word boundary near 200
        let truncated = &trimmed[..200];
        if let Some(pos) = truncated.rfind(' ') {
            truncated[..pos].to_string()
        } else {
            truncated.to_string()
        }
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Helper: call compute_sync_plan with empty cover cache (no covers to resolve)
    fn plan_no_covers(
        tracks: &[TrackForSync],
        manifest: &Option<SyncManifest>,
        structure: &str,
        mirror: bool,
        free: u64,
        total: u64,
    ) -> SyncPlan {
        let empty_cache = HashMap::new();
        let dummy_dir = PathBuf::from("/nonexistent");
        compute_sync_plan(tracks, manifest, structure, mirror, free, total, &empty_cache, &dummy_dir)
    }

    fn make_track(path: &str, album: &str, artist: &str, size: u64, track_num: u32) -> TrackForSync {
        TrackForSync {
            path: path.into(),
            title: format!("Track {}", track_num),
            artist: Some(artist.into()),
            album: Some(album.into()),
            album_artist: None,
            genre: Some("Jazz".into()),
            track_number: Some(track_num),
            disc_number: Some(1),
            size_bytes: size,
            modified_at: "2026-01-01T00:00:00Z".into(),
            album_id: 1,
        }
    }

    #[test]
    fn test_build_dest_path_artist_album_track() {
        let track = make_track("/music/test.flac", "Kind of Blue", "Miles Davis", 50_000_000, 1);
        let path = build_dest_path(&track, "artist_album_track");
        assert_eq!(path, "Miles Davis/Kind of Blue/01 - Track 1.flac");
    }

    #[test]
    fn test_build_dest_path_flat() {
        let track = make_track("/music/test.flac", "Kind of Blue", "Miles Davis", 50_000_000, 1);
        let path = build_dest_path(&track, "flat");
        assert_eq!(path, "01 - Track 1.flac");
    }

    #[test]
    fn test_build_dest_path_genre() {
        let track = make_track("/music/test.flac", "Kind of Blue", "Miles Davis", 50_000_000, 1);
        let path = build_dest_path(&track, "genre_artist_album_track");
        assert_eq!(path, "Jazz/Miles Davis/Kind of Blue/01 - Track 1.flac");
    }

    #[test]
    fn test_sanitize_filename_special_chars() {
        assert_eq!(sanitize_filename("AC/DC: Back?In*Black"), "AC_DC_ Back_In_Black");
    }

    #[test]
    fn test_sanitize_filename_too_long() {
        let long_name = "A".repeat(250);
        let result = sanitize_filename(&long_name);
        assert!(result.len() <= 200);
    }

    #[test]
    fn test_sync_plan_new_files_only() {
        let tracks = vec![
            make_track("/music/a.flac", "Album A", "Artist A", 10_000_000, 1),
            make_track("/music/b.flac", "Album A", "Artist A", 20_000_000, 2),
        ];
        let plan = plan_no_covers(&tracks, &None, "artist_album_track", true, 1_000_000_000, 2_000_000_000);
        assert_eq!(plan.files_to_copy.len(), 2);
        assert_eq!(plan.files_to_delete.len(), 0);
        assert_eq!(plan.files_unchanged, 0);
        assert_eq!(plan.total_copy_bytes, 30_000_000);
        assert!(plan.enough_space);
    }

    #[test]
    fn test_sync_plan_with_deletions() {
        // Track produces dest_relative_path "Artist A/Album A/01 - Track 1.flac"
        // which matches the first manifest entry → unchanged.
        // Second manifest entry has no matching selected track → deleted.
        let tracks = vec![
            make_track("/music/a.flac", "Album A", "Artist A", 10_000_000, 1),
        ];
        let manifest = Some(SyncManifest {
            hean_version: "1.0.0".into(),
            last_sync: "2026-01-01T00:00:00Z".into(),
            destination_path: "/dest".into(),
            folder_structure: "artist_album_track".into(),
            files: vec![
                SyncedFile {
                    source_path: "/music/a.flac".into(),
                    dest_relative_path: "Artist A/Album A/01 - Track 1.flac".into(),
                    size_bytes: 10_000_000,
                    modified_at: "2026-01-01T00:00:00Z".into(),
                    quick_hash: "abc".into(),
                },
                SyncedFile {
                    source_path: "/music/old.flac".into(),
                    dest_relative_path: "Artist B/Album B/01 - Old.flac".into(),
                    size_bytes: 15_000_000,
                    modified_at: "2025-01-01T00:00:00Z".into(),
                    quick_hash: "def".into(),
                },
            ],
        });
        let plan = plan_no_covers(&tracks, &manifest, "artist_album_track", true, 1_000_000_000, 2_000_000_000);
        assert_eq!(plan.files_to_copy.len(), 0);
        assert_eq!(plan.files_to_delete.len(), 1);
        assert_eq!(plan.files_unchanged, 1);
        assert_eq!(plan.total_delete_bytes, 15_000_000);
    }

    #[test]
    fn test_sync_plan_modified_files() {
        // dest_relative_path comparison: track produces the same dest path as manifest entry
        // → unchanged, even if source path or size differs.
        let tracks = vec![
            make_track("/music/a.flac", "Album A", "Artist A", 12_000_000, 1), // size changed
        ];
        let manifest = Some(SyncManifest {
            hean_version: "1.0.0".into(),
            last_sync: "2026-01-01T00:00:00Z".into(),
            destination_path: "/dest".into(),
            folder_structure: "artist_album_track".into(),
            files: vec![SyncedFile {
                source_path: "/music/a.flac".into(),
                dest_relative_path: "Artist A/Album A/01 - Track 1.flac".into(),
                size_bytes: 10_000_000, // different from track, but ignored
                modified_at: "2026-01-01T00:00:00Z".into(),
                quick_hash: "abc".into(),
            }],
        });
        let plan = plan_no_covers(&tracks, &manifest, "artist_album_track", true, 1_000_000_000, 2_000_000_000);
        assert_eq!(plan.files_to_copy.len(), 0, "Same dest path → unchanged, no overwrite");
        assert_eq!(plan.files_unchanged, 1, "Same dest path → counted as unchanged");
    }

    #[test]
    fn test_sync_plan_no_changes() {
        let tracks = vec![
            make_track("/music/a.flac", "Album A", "Artist A", 10_000_000, 1),
        ];
        let manifest = Some(SyncManifest {
            hean_version: "1.0.0".into(),
            last_sync: "2026-01-01T00:00:00Z".into(),
            destination_path: "/dest".into(),
            folder_structure: "artist_album_track".into(),
            files: vec![SyncedFile {
                source_path: "/music/a.flac".into(),
                dest_relative_path: "Artist A/Album A/01 - Track 1.flac".into(),
                size_bytes: 10_000_000,
                modified_at: "2026-01-01T00:00:00Z".into(),
                quick_hash: "abc".into(),
            }],
        });
        let plan = plan_no_covers(&tracks, &manifest, "artist_album_track", true, 1_000_000_000, 2_000_000_000);
        assert_eq!(plan.files_to_copy.len(), 0);
        assert_eq!(plan.files_to_delete.len(), 0);
        assert_eq!(plan.files_unchanged, 1);
    }

    #[test]
    fn test_sync_plan_different_modified_at_same_size() {
        // modified_at differs but dest path matches → should be unchanged
        let tracks = vec![
            make_track("/music/a.flac", "Album A", "Artist A", 10_000_000, 1),
        ];
        let manifest = Some(SyncManifest {
            hean_version: "1.0.0".into(),
            last_sync: "2026-01-01T00:00:00Z".into(),
            destination_path: "/dest".into(),
            folder_structure: "artist_album_track".into(),
            files: vec![SyncedFile {
                source_path: "/music/a.flac".into(),
                dest_relative_path: "Artist A/Album A/01 - Track 1.flac".into(),
                size_bytes: 10_000_000,
                modified_at: "2025-06-15T08:00:00Z".into(), // different modified_at
                quick_hash: "abc".into(),
            }],
        });
        let plan = plan_no_covers(&tracks, &manifest, "artist_album_track", true, 1_000_000_000, 2_000_000_000);
        assert_eq!(plan.files_to_copy.len(), 0, "Same dest path → unchanged");
        assert_eq!(plan.files_unchanged, 1, "Should count as unchanged");
    }

    #[test]
    fn test_sync_plan_different_source_same_dest() {
        // Source path changed (e.g. SMB remounted with different UUID) but same artist/album/track
        // → dest_relative_path matches → file is unchanged (not re-copied).
        // This is the key scenario: NAS reconnects with different mount path.
        let tracks = vec![
            make_track("smb://NEW-UUID/music/Album A/01.flac", "Album A", "Artist A", 10_000_000, 1),
        ];
        let manifest = Some(SyncManifest {
            hean_version: "1.0.0".into(),
            last_sync: "2026-01-01T00:00:00Z".into(),
            destination_path: "/dest".into(),
            folder_structure: "artist_album_track".into(),
            files: vec![SyncedFile {
                source_path: "smb://OLD-UUID/music/Album A/01.flac".into(), // different source!
                dest_relative_path: "Artist A/Album A/01 - Track 1.flac".into(),
                size_bytes: 10_000_000,
                modified_at: "2026-01-01T00:00:00Z".into(),
                quick_hash: "abc".into(),
            }],
        });
        let plan = plan_no_covers(&tracks, &manifest, "artist_album_track", true, 1_000_000_000, 2_000_000_000);
        assert_eq!(plan.files_to_copy.len(), 0, "Different source but same dest → unchanged");
        assert_eq!(plan.files_to_delete.len(), 0, "Should not delete");
        assert_eq!(plan.files_unchanged, 1, "Should count as unchanged");
    }

    #[test]
    fn test_normalize_path() {
        assert_eq!(normalize_path("/music//a.flac"), "/music/a.flac");
        assert_eq!(normalize_path("/music/a.flac/"), "/music/a.flac");
        assert_eq!(normalize_path("smb://host/share/file.flac"), "smb://host/share/file.flac");
        assert_eq!(normalize_path("smb://host//share//file.flac"), "smb://host/share/file.flac");
    }

    #[test]
    fn test_sync_plan_insufficient_space() {
        let tracks = vec![
            make_track("/music/a.flac", "Album A", "Artist A", 500_000_000, 1),
            make_track("/music/b.flac", "Album A", "Artist A", 500_000_000, 2),
        ];
        let plan = plan_no_covers(&tracks, &None, "artist_album_track", true, 100_000_000, 200_000_000);
        assert!(!plan.enough_space);
    }

    #[test]
    fn test_cover_no_cover_available() {
        // No cover in cache, no internet cover file → covers_to_copy empty
        let tracks = vec![
            make_track("/music/a.flac", "Album A", "Artist A", 10_000_000, 1),
        ];
        let plan = plan_no_covers(&tracks, &None, "artist_album_track", true, 1_000_000_000, 2_000_000_000);
        assert_eq!(plan.covers_to_copy.len(), 0);
        assert_eq!(plan.total_cover_bytes, 0);
    }

    #[test]
    fn test_cover_found_in_cache() {
        // Cover exists in cover_cache → should be in covers_to_copy
        let tracks = vec![
            make_track("/music/a.flac", "Album A", "Artist A", 10_000_000, 1),
        ];
        let dir = tempfile::tempdir().unwrap();
        let cover_file = dir.path().join("test_cover.jpg");
        std::fs::write(&cover_file, vec![0u8; 5000]).unwrap();

        let mut cache = HashMap::new();
        cache.insert("/music/a.flac".to_string(), cover_file.to_string_lossy().to_string());

        let plan = compute_sync_plan(
            &tracks, &None, "artist_album_track", true,
            1_000_000_000, 2_000_000_000, &cache, dir.path(),
        );
        assert_eq!(plan.covers_to_copy.len(), 1);
        assert_eq!(plan.covers_to_copy[0].dest_relative_path, "Artist A/Album A/cover.jpg");
        assert_eq!(plan.covers_to_copy[0].size_bytes, 5000);
        assert_eq!(plan.total_cover_bytes, 5000);
    }

    #[test]
    fn test_cover_found_as_internet() {
        // Cover not in cache but exists as internet_{hash}.jpg → should be found
        let tracks = vec![
            make_track("/music/a.flac", "Album A", "Artist A", 10_000_000, 1),
        ];
        let dir = tempfile::tempdir().unwrap();
        let album_key = "artist a|||album a";
        let hash = format!("{:x}", md5_hash(album_key));
        let internet_cover = dir.path().join(format!("internet_{}.jpg", hash));
        std::fs::write(&internet_cover, vec![0u8; 8000]).unwrap();

        let empty_cache = HashMap::new();
        let plan = compute_sync_plan(
            &tracks, &None, "artist_album_track", true,
            1_000_000_000, 2_000_000_000, &empty_cache, dir.path(),
        );
        assert_eq!(plan.covers_to_copy.len(), 1);
        assert_eq!(plan.covers_to_copy[0].size_bytes, 8000);
    }

    #[test]
    fn test_cover_already_synced_same_size() {
        // Cover in manifest with same size → skip (unchanged)
        let tracks = vec![
            make_track("/music/a.flac", "Album A", "Artist A", 10_000_000, 1),
        ];
        let dir = tempfile::tempdir().unwrap();
        let cover_file = dir.path().join("test_cover.jpg");
        std::fs::write(&cover_file, vec![0u8; 5000]).unwrap();

        let mut cache = HashMap::new();
        cache.insert("/music/a.flac".to_string(), cover_file.to_string_lossy().to_string());

        let manifest = Some(SyncManifest {
            hean_version: "1.0.0".into(),
            last_sync: "2026-01-01T00:00:00Z".into(),
            destination_path: "/dest".into(),
            folder_structure: "artist_album_track".into(),
            files: vec![
                SyncedFile {
                    source_path: "/music/a.flac".into(),
                    dest_relative_path: "Artist A/Album A/01 - Track 1.flac".into(),
                    size_bytes: 10_000_000,
                    modified_at: "2026-01-01T00:00:00Z".into(),
                    quick_hash: "abc".into(),
                },
                SyncedFile {
                    source_path: "cover".into(),
                    dest_relative_path: "Artist A/Album A/cover.jpg".into(),
                    size_bytes: 5000, // same size as local cover
                    modified_at: "2026-01-01T00:00:00Z".into(),
                    quick_hash: "coverabc".into(),
                },
            ],
        });

        let plan = compute_sync_plan(
            &tracks, &manifest, "artist_album_track", true,
            1_000_000_000, 2_000_000_000, &cache, dir.path(),
        );
        assert_eq!(plan.covers_to_copy.len(), 0, "Same size → cover unchanged, skip");
    }

    #[test]
    fn test_cover_flat_mode_skipped() {
        // Flat mode → no album folders → no covers
        let tracks = vec![
            make_track("/music/a.flac", "Album A", "Artist A", 10_000_000, 1),
        ];
        let dir = tempfile::tempdir().unwrap();
        let cover_file = dir.path().join("test_cover.jpg");
        std::fs::write(&cover_file, vec![0u8; 5000]).unwrap();

        let mut cache = HashMap::new();
        cache.insert("/music/a.flac".to_string(), cover_file.to_string_lossy().to_string());

        let plan = compute_sync_plan(
            &tracks, &None, "flat", true,
            1_000_000_000, 2_000_000_000, &cache, dir.path(),
        );
        assert_eq!(plan.covers_to_copy.len(), 0, "Flat mode → no covers");
    }
}
