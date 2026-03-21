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
    pub unchanged_album_ids: Vec<i64>,
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
///
/// Resolution strategy (in order):
/// 1. Exact track_path match in cover_cache (fastest)
/// 2. Fuzzy match: find any cover_cache entry for the same album name
///    (handles UUID changes, NAS reorganization, path changes after rescan)
/// 3. Internet cover: internet_{md5(artist|||album)}.jpg
/// 4. Scan covers directory for any file whose embedded cover matches the album
fn resolve_cover_for_album(
    track_path: &str,
    artist: &str,
    album: &str,
    cover_cache: &HashMap<String, String>,
    covers_dir: &Path,
) -> Option<(String, u64)> {
    // 1. Check COVER_CACHE: exact track_path → absolute cover file on disk
    if let Some(cover_path) = cover_cache.get(track_path) {
        let p = Path::new(cover_path);
        if p.exists() {
            if let Ok(meta) = std::fs::metadata(p) {
                return Some((cover_path.clone(), meta.len()));
            }
        }
    }

    // 2. Fuzzy match: find any cover_cache entry whose track_path ends with
    //    a filename from the same album. This handles:
    //    - UUID changes (NAS got a new ID after reset)
    //    - Path changes (NAS files reorganized, different base path)
    //    - Mount point changes (different /Volumes/xxx)
    //
    //    We match on album name appearing in the key path, then verify
    //    the cover file still exists on disk.
    let album_lower = album.to_lowercase();
    if !album_lower.is_empty() && album_lower != "unknown album" {
        // Find the first cover_cache entry whose path contains this album name
        for (cached_path, cover_path) in cover_cache.iter() {
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

    // 3. Check for internet cover: internet_{md5(artist|||album)}.jpg
    //    Try multiple artist variants (the artist used at download time
    //    may differ from the current canonical album_artist).
    let artists_to_try = [
        format!("{}|||{}", artist.to_lowercase(), album.to_lowercase()),
        format!("{}|||{}", "various artists", album.to_lowercase()),
    ];
    for album_key in &artists_to_try {
        let hash = format!("{:x}", md5_hash(album_key));
        let internet_cover = covers_dir.join(format!("internet_{}.jpg", hash));
        if internet_cover.exists() {
            if let Ok(meta) = std::fs::metadata(&internet_cover) {
                return Some((internet_cover.to_string_lossy().to_string(), meta.len()));
            }
        }
    }

    None
}

/// Compute the sync plan by comparing selected tracks against the existing manifest.
/// Falls back to filesystem check when manifest is missing or incomplete:
/// if a file is not in the manifest but physically exists on the DAP, it's "unchanged".
pub fn compute_sync_plan(
    tracks: &[TrackForSync],
    manifest: &Option<SyncManifest>,
    folder_structure: &str,
    mirror_mode: bool,
    dest_free_bytes: u64,
    dest_total_bytes: u64,
    cover_cache: &HashMap<String, String>,
    covers_dir: &Path,
    dest_path: &str,
) -> SyncPlan {
    let total_start = std::time::Instant::now();
    let dest_root = Path::new(dest_path);

    // Build a lookup from dest_relative_path -> SyncedFile for the existing manifest.
    // We compare by destination path (derived from metadata: artist/album/track) instead of
    // source_path, because source paths are fragile (SMB UUIDs, mount paths change between
    // sessions). The dest_relative_path is deterministic from metadata and stable across sessions.
    let t0 = std::time::Instant::now();
    let manifest_lookup: HashMap<String, &SyncedFile> = manifest
        .as_ref()
        .map(|m| m.files.iter().map(|f| (f.dest_relative_path.clone(), f)).collect())
        .unwrap_or_default();
    #[cfg(debug_assertions)]
    eprintln!("[PERF-RS] manifest_lookup build: {:?} ({} entries)", t0.elapsed(), manifest_lookup.len());

    // Scan the DAP filesystem once upfront: collect all existing files AND album folders.
    // This is more robust than per-file exists() checks because it lets us detect albums
    // even when individual filenames don't match exactly (e.g. metadata changed since last sync).
    let t_scan = std::time::Instant::now();
    let mut dap_existing_files: std::collections::HashSet<String> = std::collections::HashSet::new();
    // folders_with_files: set of folder paths that contain at least one audio file
    let mut dap_folders_with_files: std::collections::HashSet<String> = std::collections::HashSet::new();
    if dest_root.exists() {
        fn walk_dap(dir: &Path, prefix: &str, files: &mut std::collections::HashSet<String>, folders_with_files: &mut std::collections::HashSet<String>) {
            if let Ok(entries) = std::fs::read_dir(dir) {
                let mut has_audio_files = false;
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    // Skip hidden files/dirs (like .hean-sync.json, .Spotlight, .Trashes)
                    if name.starts_with('.') { continue; }
                    let rel = if prefix.is_empty() { name.clone() } else { format!("{}/{}", prefix, name) };
                    if entry.path().is_dir() {
                        walk_dap(&entry.path(), &rel, files, folders_with_files);
                    } else {
                        files.insert(rel.clone());
                        // Only count actual audio files for folder-match detection,
                        // not cover.jpg, Thumbs.db, desktop.ini, etc.
                        let lower = name.to_lowercase();
                        if lower.ends_with(".flac") || lower.ends_with(".mp3")
                            || lower.ends_with(".wav") || lower.ends_with(".m4a")
                            || lower.ends_with(".aac") || lower.ends_with(".ogg")
                            || lower.ends_with(".opus") || lower.ends_with(".alac")
                            || lower.ends_with(".aiff") || lower.ends_with(".wma")
                        {
                            has_audio_files = true;
                        }
                    }
                }
                if has_audio_files && !prefix.is_empty() {
                    folders_with_files.insert(prefix.to_string());
                }
            }
        }
        walk_dap(dest_root, "", &mut dap_existing_files, &mut dap_folders_with_files);
    }
    // Build a lowercased version for case-insensitive fallback matching
    let dap_folders_lower: std::collections::HashSet<String> = dap_folders_with_files
        .iter()
        .map(|f| f.to_lowercase())
        .collect();
    #[cfg(debug_assertions)]
    {
        eprintln!("[PERF-RS] DAP filesystem scan: {:?} ({} files, {} folders with files)",
            t_scan.elapsed(), dap_existing_files.len(), dap_folders_with_files.len());
        if !dap_folders_with_files.is_empty() {
            let mut sample: Vec<&String> = dap_folders_with_files.iter().collect();
            sample.sort();
            sample.truncate(15);
            eprintln!("[DEBUG-RS] Sample DAP folders with files: {:?}", sample);
        }
    }

    let mut files_to_copy = Vec::new();
    let mut files_unchanged: usize = 0;
    let mut files_found_on_disk: usize = 0;
    let mut total_copy_bytes: u64 = 0;
    let mut unchanged_album_id_set: std::collections::HashSet<i64> = std::collections::HashSet::new();

    // Track which dest_relative_paths are selected (for mirror mode delete detection)
    let mut selected_dest_paths: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Log first few mismatches for debugging
    let mut mismatch_log_count: usize = 0;

    let t2 = std::time::Instant::now();

    // ── Pre-compute canonical album_artist per album folder ──────────────
    // Compilations and multi-artist albums (OSTs, etc.) have different artist
    // tags per track. We group by ALBUM NAME (not album_id) to catch albums
    // that were imported multiple times or from different sources (e.g. Zelda
    // OST with tracks from different NAS folders → different album_ids).
    //
    // Strategy: vote on album_artist per sanitized album name. The most common
    // album_artist wins and is used for ALL tracks with that album name.
    let mut album_artist_votes: HashMap<String, HashMap<String, usize>> = HashMap::new();
    for track in tracks {
        let album_key = sanitize_filename(track.album.as_deref().unwrap_or("Unknown Album"));
        let aa = track.album_artist.as_deref()
            .filter(|s| !s.is_empty())
            .or(track.artist.as_deref())
            .unwrap_or("Unknown Artist");
        *album_artist_votes
            .entry(album_key)
            .or_default()
            .entry(aa.to_string())
            .or_insert(0) += 1;
    }
    let canonical_album_artist: HashMap<String, String> = album_artist_votes
        .into_iter()
        .map(|(album_key, votes)| {
            let unique_artists = votes.len();
            // If 4+ different artists contribute to the same album name,
            // it's a compilation → use "Various Artists" as the folder name.
            // This handles Larry Levan, DJ mixes, soundtrack compilations, etc.
            if unique_artists >= 4 {
                (album_key, "Various Artists".to_string())
            } else {
                let best = votes.into_iter()
                    .max_by_key(|(_, count)| *count)
                    .map(|(name, _)| name)
                    .unwrap_or_else(|| "Unknown Artist".to_string());
                (album_key, best)
            }
        })
        .collect();

    // ── Pre-compute track count per destination album folder ──────────────
    // Count by (canonical_artist, sanitized_album) — not album_id — so that
    // tracks from the same real album but different DB album_ids (e.g. Zelda
    // imported from multiple sources) are counted together for the disc split.
    let mut folder_track_counts: HashMap<String, usize> = HashMap::new();
    for track in tracks {
        let album_key = sanitize_filename(track.album.as_deref().unwrap_or("Unknown Album"));
        let canonical_aa = canonical_album_artist.get(&album_key).map(|s| s.as_str());
        let artist_folder = if let Some(canonical) = canonical_aa {
            sanitize_filename(canonical)
        } else {
            sanitize_filename(track.artist.as_deref().unwrap_or("Unknown Artist"))
        };
        let folder_key = format!("{}/{}", artist_folder, album_key);
        *folder_track_counts.entry(folder_key).or_insert(0) += 1;
    }

    for track in tracks {
        let album_key = sanitize_filename(track.album.as_deref().unwrap_or("Unknown Album"));
        let canonical_aa = canonical_album_artist.get(&album_key).map(|s| s.as_str());
        let artist_folder = if let Some(canonical) = canonical_aa {
            sanitize_filename(canonical)
        } else {
            sanitize_filename(track.artist.as_deref().unwrap_or("Unknown Artist"))
        };
        let folder_key = format!("{}/{}", artist_folder, album_key);
        let atc = folder_track_counts.get(&folder_key).copied().unwrap_or(0);
        let dest_rel = build_dest_path(track, folder_structure, atc, canonical_aa);
        selected_dest_paths.insert(dest_rel.clone());

        if manifest_lookup.contains_key(&dest_rel) {
            // File already on DAP — found in manifest
            files_unchanged += 1;
            unchanged_album_id_set.insert(track.album_id);
        } else if dap_existing_files.contains(&dest_rel) {
            // Not in manifest, but found in DAP filesystem scan (exact match).
            files_unchanged += 1;
            files_found_on_disk += 1;
            unchanged_album_id_set.insert(track.album_id);
        } else {
            // File not in manifest AND not on disk → needs to be copied.
            // NOTE: We no longer use album folder matching for copy decisions.
            // Previous folder match caused false "on DAP" status after partial syncs
            // (e.g., 1 file of 20 copied → entire album marked as "unchanged").
            // The manifest is the only reliable source for unchanged-file detection.
            {
                // Log first few mismatches for debugging
                #[cfg(debug_assertions)]
                if mismatch_log_count < 5 {
                    eprintln!("[DEBUG-RS] Track NOT on DAP: dest_rel={:?}, artist={:?}, album={:?}",
                        dest_rel, track.artist, track.album);
                    mismatch_log_count += 1;
                }
                // New file — use size_bytes from frontend (estimated from metadata).
                // We skip fs::metadata() on SOURCE files because it's extremely slow on SMB mounts
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
    }
    eprintln!("[PERF-RS] track loop: {:?} ({} tracks, {} unchanged ({} via disk), {} to copy)",
        t2.elapsed(), tracks.len(), files_unchanged, files_found_on_disk, files_to_copy.len());

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
            let album_key = sanitize_filename(track.album.as_deref().unwrap_or("Unknown Album"));
            let canonical_aa = canonical_album_artist.get(&album_key).map(|s| s.as_str());
            let artist_folder = if let Some(canonical) = canonical_aa {
                sanitize_filename(canonical)
            } else {
                sanitize_filename(track.artist.as_deref().unwrap_or("Unknown Artist"))
            };
            let folder_key = format!("{}/{}", artist_folder, album_key);
            let atc = folder_track_counts.get(&folder_key).copied().unwrap_or(0);
            let dest_rel = build_dest_path(track, folder_structure, atc, canonical_aa);
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

        let mut covers_resolved = 0usize;
        let mut covers_not_found = 0usize;

        // ALWAYS re-copy ALL covers on every sync.
        // The macOS exFAT driver corrupts existing file clusters when new files
        // are written to the same volume. Covers written in a previous sync will
        // have their data silently overwritten. Re-copying is cheap (~50-150KB
        // per cover) and guarantees covers are always intact.
        for (folder, (track_path, artist, album)) in &album_folders {
            let cover_dest = format!("{}/cover.jpg", folder);

            if let Some((source, size)) = resolve_cover_for_album(track_path, artist, album, cover_cache, covers_dir) {
                total_cover_bytes += size;
                covers_to_copy.push(CoverSyncAction {
                    source_cover_path: source,
                    dest_relative_path: cover_dest,
                    size_bytes: size,
                });
                covers_resolved += 1;
            } else {
                covers_not_found += 1;
                #[cfg(debug_assertions)]
                if covers_not_found <= 3 {
                    eprintln!("[DEBUG-RS] Cover not found for: folder={:?}, track={:?}, artist={:?}, album={:?}",
                        folder, track_path, artist, album);
                }
            }
        }
        eprintln!("[PERF-RS] Cover resolution: {} albums, {} to copy, {} not found",
            album_folders.len(), covers_resolved, covers_not_found);
    }

    let net_bytes = (total_copy_bytes + total_cover_bytes) as i64 - total_delete_bytes as i64;
    let enough_space = net_bytes <= 0 || (net_bytes as u64) <= dest_free_bytes;

    #[cfg(debug_assertions)]
    eprintln!("[PERF-RS] compute_sync_plan TOTAL: {:?} | {} to copy, {} covers, {} to delete, {} unchanged",
        total_start.elapsed(), files_to_copy.len(), covers_to_copy.len(), files_to_delete.len(), files_unchanged);

    SyncPlan {
        files_to_copy,
        files_to_delete,
        files_unchanged,
        unchanged_album_ids: unchanged_album_id_set.into_iter().collect(),
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

/// Maximum files per directory to avoid macOS exFAT driver corruption.
/// The macOS kernel exFAT driver has a bug that corrupts directory cluster
/// allocation tables when too many files (~55-60) are written to a single
/// directory. This limit keeps us safely below that threshold.
const MAX_FILES_PER_DIR: usize = 45;

/// Build the destination relative path for a track based on folder structure.
///
/// When `album_track_count` exceeds MAX_FILES_PER_DIR, tracks are split into
/// disc subdirectories (e.g. "Artist/Album/Disc 1/01 - Track.flac") to avoid
/// macOS exFAT driver corruption. The DAP reads metadata tags, not folder
/// structure, so this is invisible to the user during playback.
pub fn build_dest_path(track: &TrackForSync, structure: &str, album_track_count: usize, canonical_album_artist: Option<&str>) -> String {
    let artist = sanitize_filename(track.artist.as_deref().unwrap_or("Unknown Artist"));

    // Use canonical_album_artist (pre-computed from the most common album_artist
    // across all tracks of this album). This ensures compilations and multi-artist
    // albums (OSTs, etc.) group ALL tracks under one folder instead of scattering
    // them across one folder per track artist.
    let album_artist = if let Some(canonical) = canonical_album_artist {
        sanitize_filename(canonical)
    } else {
        let album_artist_raw = track.album_artist.as_deref().unwrap_or("");
        if !album_artist_raw.is_empty() {
            sanitize_filename(album_artist_raw)
        } else {
            artist.clone()
        }
    };

    let album = sanitize_filename(track.album.as_deref().unwrap_or("Unknown Album"));
    let genre = sanitize_filename(track.genre.as_deref().unwrap_or("Unknown Genre"));

    let track_num = track.track_number.unwrap_or(0);
    let title = sanitize_filename(&track.title);

    let extension = Path::new(&track.path)
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_else(|| "flac".into());

    let disc_num = track.disc_number.unwrap_or(0);

    // Filename: always use track number only (disc is in the subfolder)
    let filename = if track_num > 0 {
        format!("{:02} - {}.{}", track_num, title, extension)
    } else {
        format!("{}.{}", title, extension)
    };

    // Decide if we need disc subdirectories:
    // 1. Album has more tracks than MAX_FILES_PER_DIR → MUST split to avoid exFAT corruption
    // 2. Album is multi-disc (disc_num > 1 exists) → split for organization
    let needs_disc_split = album_track_count > MAX_FILES_PER_DIR || disc_num > 1;

    let album_path = if needs_disc_split && disc_num > 0 {
        format!("{}/Disc {}", album, disc_num)
    } else {
        album.clone()
    };

    match structure {
        "artist_album_track" | "albumartist_album_track" | _ if structure != "flat" && structure != "genre_artist_album_track" => {
            format!("{}/{}/{}", album_artist, album_path, filename)
        }
        "genre_artist_album_track" => format!("{}/{}/{}/{}", genre, album_artist, album_path, filename),
        "flat" => filename,
        _ => format!("{}/{}/{}", album_artist, album_path, filename),
    }
}

/// Sanitize a string for use as a filename on FAT32/exFAT/NTFS.
/// CRITICAL: Normalizes to NFC (composed Unicode) — exFAT requires NFC,
/// but macOS metadata and HFS+/APFS paths often use NFD (decomposed).
/// Without NFC normalization, directories with accented characters (ô, é, ñ, etc.)
/// are created on exFAT but become unusable (EINVAL on any child operation).
///
/// Additionally, the macOS exFAT driver has a known bug that corrupts directory entries
/// when folder names contain certain Unicode accented characters (ô, ã, é). The only
/// reliable fix is ASCII transliteration via `deunicode`. Metadata in the audio files
/// retains the original characters — only filesystem paths are transliterated.
pub fn sanitize_filename(name: &str) -> String {
    use deunicode::deunicode;
    use unicode_normalization::UnicodeNormalization;

    // Step 1: Normalize to NFC (composed form)
    let nfc: String = name.nfc().collect();

    // Step 2: ASCII transliteration — prevents macOS exFAT driver corruption
    // ô → o, ã → a, é → e, … → ..., — → -, etc.
    let ascii = deunicode(&nfc);

    // Step 3: Strip zero-width and invisible characters that deunicode may leave
    let cleaned: String = ascii
        .chars()
        .filter(|c| !matches!(*c, '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{FEFF}' | '\u{00AD}'))
        .collect();

    // Step 4: Replace filesystem-illegal characters
    let sanitized: String = cleaned
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            _ => c,
        })
        .collect();

    // Step 5: Collapse consecutive dots (... → ., .. → .) — macOS exFAT driver
    // returns EINVAL on create_dir_all when directory names contain consecutive dots.
    // Also collapse consecutive spaces — exFAT/FAT32 rejects double spaces with EINVAL.
    // Also collapse leading dots to prevent hidden files on Unix.
    let mut collapsed = String::with_capacity(sanitized.len());
    let mut prev_dot = false;
    let mut prev_space = false;
    for c in sanitized.chars() {
        if c == '.' {
            if !prev_dot {
                collapsed.push(c);
            }
            prev_dot = true;
            prev_space = false;
        } else if c == ' ' {
            if !prev_space {
                collapsed.push(c);
            }
            prev_space = true;
            prev_dot = false;
        } else {
            prev_dot = false;
            prev_space = false;
            collapsed.push(c);
        }
    }

    // Step 6: Trim leading/trailing whitespace, dots, and underscores
    // Trailing underscores appear when ':' is replaced (e.g. "Zelda:" → "Zelda_")
    // Some exFAT implementations reject trailing underscores on directory names.
    let trimmed = collapsed.trim().trim_end_matches('.').trim_end_matches('_').trim();

    // Step 6: Protect Windows reserved names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
    let upper = trimmed.to_uppercase();
    let base = upper.split('.').next().unwrap_or("");
    if matches!(
        base,
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        return format!("_{}", trimmed);
    }

    // Step 7: Truncate to 200 chars for FAT32 safety
    if trimmed.len() > 200 {
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
        compute_sync_plan(tracks, manifest, structure, mirror, free, total, &empty_cache, &dummy_dir, "/nonexistent")
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
        let path = build_dest_path(&track, "artist_album_track", 10, None);
        assert_eq!(path, "Miles Davis/Kind of Blue/01 - Track 1.flac");
    }

    #[test]
    fn test_build_dest_path_flat() {
        let track = make_track("/music/test.flac", "Kind of Blue", "Miles Davis", 50_000_000, 1);
        let path = build_dest_path(&track, "flat", 10, None);
        assert_eq!(path, "01 - Track 1.flac");
    }

    #[test]
    fn test_build_dest_path_genre() {
        let track = make_track("/music/test.flac", "Kind of Blue", "Miles Davis", 50_000_000, 1);
        let path = build_dest_path(&track, "genre_artist_album_track", 10, None);
        assert_eq!(path, "Jazz/Miles Davis/Kind of Blue/01 - Track 1.flac");
    }

    #[test]
    fn test_build_dest_path_disc_split_large_album() {
        // Album with >45 tracks should get disc subdirectories
        let mut track = make_track("/music/a.flac", "Big Album", "Artist", 10_000_000, 1);
        track.disc_number = Some(1);
        let path = build_dest_path(&track, "artist_album_track", 60, None);
        assert!(path.contains("/Disc 1/"), "Large album disc 1 should have Disc 1 subfolder: {}", path);

        track.disc_number = Some(3);
        let path3 = build_dest_path(&track, "artist_album_track", 60, None);
        assert!(path3.contains("/Disc 3/"), "Large album disc 3 should have Disc 3 subfolder: {}", path3);
    }

    #[test]
    fn test_build_dest_path_no_disc_split_small_album() {
        // Album with <45 tracks, disc 1 — no subdirectory
        let mut track = make_track("/music/a.flac", "Small Album", "Artist", 10_000_000, 1);
        track.disc_number = Some(1);
        let path = build_dest_path(&track, "artist_album_track", 10, None);
        assert!(!path.contains("/Disc "), "Small album should not have disc subfolder: {}", path);
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
    fn test_sanitize_filename_ascii_transliteration() {
        // macOS exFAT driver corrupts dirs with accented chars — must be transliterated
        assert_eq!(sanitize_filename("Antônio Carlos Jobim"), "Antonio Carlos Jobim");
        assert_eq!(sanitize_filename("Nara Leão"), "Nara Leao");
        assert_eq!(sanitize_filename("João Gilberto"), "Joao Gilberto");
        assert_eq!(sanitize_filename("L'École du Micro d'Argent"), "L'Ecole du Micro d'Argent");
        assert_eq!(sanitize_filename("Søn Of Dad"), "Son Of Dad");
    }

    #[test]
    fn test_sanitize_filename_unicode_special_chars() {
        // Ellipsis, em-dash, en-dash must be transliterated to ASCII equivalents
        let result = sanitize_filename("One Nite Alone\u{2026} Live!");
        assert!(!result.contains('\u{2026}'), "Ellipsis should be transliterated");
        // Consecutive dots are collapsed: ... → .
        assert!(!result.contains(".."), "Consecutive dots should be collapsed: {}", result);

        let result2 = sanitize_filename("Track \u{2014} Version");
        assert!(!result2.contains('\u{2014}'), "Em-dash should be transliterated");
    }

    #[test]
    fn test_sanitize_filename_consecutive_dots() {
        // macOS exFAT returns EINVAL on directories with consecutive dots
        assert_eq!(sanitize_filename("One Nite Alone... Live!"), "One Nite Alone. Live!");
        assert_eq!(sanitize_filename("The Vault... Old Friends 4 Sale"), "The Vault. Old Friends 4 Sale");
        assert_eq!(sanitize_filename("N.E.W.S"), "N.E.W.S"); // single dots OK
        assert_eq!(sanitize_filename("SEPT. 5TH"), "SEPT. 5TH"); // single dot OK
        assert_eq!(sanitize_filename("test..name"), "test.name"); // double dot collapsed
    }

    #[test]
    fn test_sanitize_filename_windows_reserved() {
        assert_eq!(sanitize_filename("CON"), "_CON");
        assert_eq!(sanitize_filename("PRN"), "_PRN");
        assert_eq!(sanitize_filename("AUX"), "_AUX");
        assert_eq!(sanitize_filename("NUL"), "_NUL");
        assert_eq!(sanitize_filename("COM1"), "_COM1");
        assert_eq!(sanitize_filename("LPT3"), "_LPT3");
        // Normal names should not be affected
        assert_eq!(sanitize_filename("Concert"), "Concert");
        assert_eq!(sanitize_filename("Connections"), "Connections");
    }

    #[test]
    fn test_sanitize_filename_pure_ascii_passthrough() {
        // Pure ASCII should pass through unchanged
        assert_eq!(sanitize_filename("Daft Punk"), "Daft Punk");
        assert_eq!(sanitize_filename("Random Access Memories"), "Random Access Memories");
    }

    #[test]
    fn test_build_dest_path_disc_number() {
        let mut track = make_track("/music/a.flac", "Album A", "Artist A", 10_000_000, 1);
        // Disc 1, small album — no disc subfolder
        track.disc_number = Some(1);
        let path = build_dest_path(&track, "artist_album_track", 10, None);
        assert!(path.contains("/01 - "), "Disc 1 small album should have track num: {}", path);
        assert!(!path.contains("/Disc "), "Disc 1 small album should not have disc subfolder: {}", path);

        // Disc 2 — disc subfolder because multi-disc
        track.disc_number = Some(2);
        let path2 = build_dest_path(&track, "artist_album_track", 10, None);
        assert!(path2.contains("/Disc 2/"), "Disc 2 should have disc subfolder: {}", path2);
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

        let dest_dir = tempfile::tempdir().unwrap();
        let plan = compute_sync_plan(
            &tracks, &None, "artist_album_track", true,
            1_000_000_000, 2_000_000_000, &cache, dir.path(),
            &dest_dir.path().to_string_lossy(),
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
        let dest_dir = tempfile::tempdir().unwrap();
        let plan = compute_sync_plan(
            &tracks, &None, "artist_album_track", true,
            1_000_000_000, 2_000_000_000, &empty_cache, dir.path(),
            &dest_dir.path().to_string_lossy(),
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

        let dest_dir = tempfile::tempdir().unwrap();
        let plan = compute_sync_plan(
            &tracks, &manifest, "artist_album_track", true,
            1_000_000_000, 2_000_000_000, &cache, dir.path(),
            &dest_dir.path().to_string_lossy(),
        );
        // Covers are ALWAYS re-copied on every sync to protect against exFAT
        // cluster corruption that silently destroys cover data between syncs.
        assert_eq!(plan.covers_to_copy.len(), 1, "Cover should always be re-copied");
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

        let dest_dir = tempfile::tempdir().unwrap();
        let plan = compute_sync_plan(
            &tracks, &None, "flat", true,
            1_000_000_000, 2_000_000_000, &cache, dir.path(),
            &dest_dir.path().to_string_lossy(),
        );
        assert_eq!(plan.covers_to_copy.len(), 0, "Flat mode → no covers");
    }

    fn make_track_with_album_id(path: &str, album: &str, artist: &str, size: u64, track_num: u32, album_id: i64) -> TrackForSync {
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
            album_id,
        }
    }

    #[test]
    fn test_sync_plan_mixed_scenario() {
        // Manifest has 2 files: album 1 track + album 2 track
        // Selected: album 1 track (unchanged) + album 3 track (new)
        // Mirror on → album 2 track should be deleted
        let track_a1 = make_track("/music/a1.flac", "Album A", "Artist A", 10_000_000, 1);
        let track_b3 = make_track_with_album_id("/music/b3.flac", "Album C", "Artist C", 15_000_000, 1, 3);

        let manifest = Some(SyncManifest {
            hean_version: "0.1.0".into(),
            last_sync: "2026-01-01T00:00:00Z".into(),
            destination_path: "/Volumes/DAP".into(),
            folder_structure: "artist_album_track".into(),
            files: vec![
                SyncedFile {
                    source_path: "/music/a1.flac".into(),
                    dest_relative_path: "Artist A/Album A/01 - Track 1.flac".into(),
                    size_bytes: 10_000_000,
                    modified_at: "2026-01-01T00:00:00Z".into(),
                    quick_hash: "abc123".into(),
                },
                SyncedFile {
                    source_path: "/music/b2.flac".into(),
                    dest_relative_path: "Artist B/Album B/01 - Track 1.flac".into(),
                    size_bytes: 12_000_000,
                    modified_at: "2026-01-01T00:00:00Z".into(),
                    quick_hash: "def456".into(),
                },
            ],
        });

        let plan = plan_no_covers(
            &[track_a1, track_b3],
            &manifest,
            "artist_album_track",
            true,
            1_000_000_000,
            2_000_000_000,
        );

        assert_eq!(plan.files_unchanged, 1, "album A track is unchanged");
        assert_eq!(plan.files_to_copy.len(), 1, "album C track is new");
        assert_eq!(plan.files_to_delete.len(), 1, "album B track should be deleted (mirror)");
    }

    #[test]
    fn test_sync_plan_space_calculation() {
        // 2 tracks to copy (10MB + 20MB = 30MB), 1 to delete (5MB)
        // net = 30MB - 5MB = 25MB
        let tracks = vec![
            make_track("/music/new1.flac", "New Album", "Artist", 10_000_000, 1),
            make_track_with_album_id("/music/new2.flac", "New Album 2", "Artist 2", 20_000_000, 1, 2),
        ];

        let manifest = Some(SyncManifest {
            hean_version: "0.1.0".into(),
            last_sync: "2026-01-01T00:00:00Z".into(),
            destination_path: "/Volumes/DAP".into(),
            folder_structure: "artist_album_track".into(),
            files: vec![
                SyncedFile {
                    source_path: "/music/old.flac".into(),
                    dest_relative_path: "Old/Old Album/01 - Old.flac".into(),
                    size_bytes: 5_000_000,
                    modified_at: "2026-01-01T00:00:00Z".into(),
                    quick_hash: "hash1".into(),
                },
            ],
        });

        let plan = plan_no_covers(&tracks, &manifest, "artist_album_track", true, 100_000_000, 200_000_000);

        let expected_net = (10_000_000i64 + 20_000_000) - 5_000_000;
        assert_eq!(plan.net_bytes, expected_net);
        assert!(plan.enough_space, "100MB free should be enough for 25MB net");

        // Now test with tight space
        let plan_tight = plan_no_covers(&tracks, &manifest, "artist_album_track", true, 20_000_000, 200_000_000);
        assert!(!plan_tight.enough_space, "20MB free is not enough for 25MB net");
    }

    #[test]
    fn test_sync_plan_empty_selection_mirror() {
        // Manifest has 2 files, selected tracks is empty, mirror on
        // All manifest files should be in files_to_delete
        let manifest = Some(SyncManifest {
            hean_version: "0.1.0".into(),
            last_sync: "2026-01-01T00:00:00Z".into(),
            destination_path: "/Volumes/DAP".into(),
            folder_structure: "artist_album_track".into(),
            files: vec![
                SyncedFile {
                    source_path: "/music/a.flac".into(),
                    dest_relative_path: "Artist A/Album A/01 - Track 1.flac".into(),
                    size_bytes: 10_000_000,
                    modified_at: "2026-01-01T00:00:00Z".into(),
                    quick_hash: "hash1".into(),
                },
                SyncedFile {
                    source_path: "/music/b.flac".into(),
                    dest_relative_path: "Artist B/Album B/01 - Track 1.flac".into(),
                    size_bytes: 15_000_000,
                    modified_at: "2026-01-01T00:00:00Z".into(),
                    quick_hash: "hash2".into(),
                },
            ],
        });

        let plan = plan_no_covers(&[], &manifest, "artist_album_track", true, 1_000_000_000, 2_000_000_000);

        assert_eq!(plan.files_to_copy.len(), 0, "no tracks selected = nothing to copy");
        assert_eq!(plan.files_to_delete.len(), 2, "mirror mode = all manifest files deleted");
        assert_eq!(plan.files_unchanged, 0);
    }
}
