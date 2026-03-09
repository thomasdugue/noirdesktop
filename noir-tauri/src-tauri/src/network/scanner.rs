// network/scanner.rs — Scan différentiel SMB → TrackWithMetadata + download-to-temp

use super::{NetworkSource, NetworkScanCache, NetworkFileEntry};
use crate::network::smb;
use std::path::{Path, PathBuf};
use std::io::Cursor;
use std::sync::{Arc, Mutex, atomic::{AtomicU64, AtomicBool, Ordering}};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use lofty::{Probe, TaggedFileExt, Accessor, AudioFile, MimeType, TagExt};
use tauri::Emitter;
use once_cell::sync::Lazy;

/// Flag d'annulation du téléchargement SMB en cours.
/// Mis à `true` quand un nouveau download démarre → le précédent sort de son loop au chunk suivant
/// (~2ms à 36 MB/s) et relâche le CONNECTION mutex. Évite d'attendre la fin du download précédent.
static CURRENT_DOWNLOAD_CANCEL: Lazy<Mutex<Option<Arc<AtomicBool>>>> =
    Lazy::new(|| Mutex::new(None));

/// Extensions audio reconnues
const AUDIO_EXTENSIONS: &[&str] = &["flac", "mp3", "m4a", "aac", "wav", "aiff", "aif", "opus"];

/// Dossier de buffering SMB (download-to-temp pour playback)
fn smb_buffer_dir() -> PathBuf {
    crate::get_data_dir().join("smb_buffer")
}

/// Hash simple d'une chaîne → hex string (pour noms de fichiers cache)
fn path_hash(input: &str) -> String {
    let mut hasher = DefaultHasher::new();
    input.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

/// Vérifie si un nom de fichier est un fichier audio connu
fn is_audio_file(name: &str) -> bool {
    if let Some(ext) = Path::new(name).extension().and_then(|e| e.to_str()) {
        AUDIO_EXTENSIONS.contains(&ext.to_lowercase().as_str())
    } else {
        false
    }
}

/// Cherche une pochette déjà extraite sur disque (sans lecture SMB, via hash déterministe)
fn find_cached_cover(source: &NetworkSource, share: &str, remote_path: &str) -> Option<String> {
    let clean_path = remote_path.trim_start_matches('/');
    let smb_uri = format!("smb://{}/{}/{}", source.id, share, clean_path);
    let hash = path_hash(&smb_uri);
    let cover_dir = crate::get_data_dir().join("covers");
    for ext in &["jpg", "png"] {
        let candidate = cover_dir.join(format!("{}.{}", hash, ext));
        if candidate.exists() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

/// Sauvegarde la pochette depuis un tagged_file déjà parsé → chemin absolu
/// (utilisé par extract_smb_metadata_and_cover pour éviter une 2ème lecture SMB)
fn save_cover_from_tagged(
    tagged_file: &lofty::TaggedFile,
    source: &NetworkSource,
    share: &str,
    remote_path: &str,
) -> Option<String> {
    let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag())?;
    let picture = tag.pictures().first()?;

    let ext = if matches!(picture.mime_type(), Some(MimeType::Png)) { "png" } else { "jpg" };

    let clean_path = remote_path.trim_start_matches('/');
    let smb_uri = format!("smb://{}/{}/{}", source.id, share, clean_path);
    let hash = path_hash(&smb_uri);

    let cover_dir = crate::get_data_dir().join("covers");
    std::fs::create_dir_all(&cover_dir).ok()?;
    let cache_file = cover_dir.join(format!("{}.{}", hash, ext));

    // Ne pas réécrire si déjà sur disque (persist entre scans)
    if !cache_file.exists() {
        std::fs::write(&cache_file, picture.data()).ok()?;
    }

    Some(cache_file.to_string_lossy().to_string())
}

/// Scan récursif d'une source réseau →
/// (Vec<TrackWithMetadata>, Vec<(smb_uri, cover_abs_path)>)
/// Le second vecteur sert à pré-peupler COVER_CACHE dans lib.rs
pub fn scan_network_source(
    source: &NetworkSource,
    cache: &mut NetworkScanCache,
    app_handle: &tauri::AppHandle,
) -> Result<(Vec<crate::TrackWithMetadata>, Vec<(String, String)>), String> {
    let share = &source.share;
    let root_path = source.remote_path.clone();

    // Collecte tous les chemins audio + taille + date de modif
    let mut audio_files: Vec<(String, u64, u64)> = Vec::new(); // (path, size, modified)
    walk_smb_audio_files(source, share, &root_path, &mut audio_files);

    println!(
        "[Network Scan] Found {} audio files in {} (share: {})",
        audio_files.len(),
        source.name,
        share
    );

    let total = audio_files.len();
    let source_cache = cache.entries.entry(source.id.clone()).or_default();
    let mut tracks: Vec<crate::TrackWithMetadata> = Vec::new();
    let mut cover_mappings: Vec<(String, String)> = Vec::new();

    for (idx, (file_path, size, modified)) in audio_files.into_iter().enumerate() {
        // Émet la progression toutes les 10 tracks (ou en début/fin)
        if idx % 10 == 0 || idx + 1 == total {
            let _ = app_handle.emit("scan_progress", crate::ScanProgress {
                phase: "scanning_network".to_string(),
                current: idx + 1,
                total,
                folder: source.name.clone(),
            });
        }

        // URI SMB unique pour ce fichier : smb://{source_id}/{share}/{path_sans_slash}
        let clean_path = file_path.trim_start_matches('/');
        let smb_uri = format!("smb://{}/{}/{}", source.id, share, clean_path);

        // Scan différentiel : réutilise le cache si taille + date inchangées
        // Note : size=0 && modified=0 signifie que browse() n'a pas renvoyé de stats réelles
        // → on ne peut pas se fier au cache → toujours ré-extraire dans ce cas
        let cached_entry = source_cache.get(&file_path);
        let has_real_stats = size > 0 || modified > 0;
        let (metadata, cover_abs) = if has_real_stats {
            if let Some(entry) = cached_entry {
                if entry.size == size && entry.modified == modified {
                    // Cache valide (stats réelles correspondent) → réutiliser metadata
                    let meta = entry.metadata.clone().unwrap_or_else(|| {
                        let (m, _) = extract_smb_metadata_and_cover(source, share, &file_path);
                        m
                    });
                    // Cover : chercher sur disque via hash (0 lecture SMB)
                    let cover = find_cached_cover(source, share, &file_path);
                    (meta, cover)
                } else {
                    // Fichier modifié → ré-extraire metadata + cover en une seule lecture
                    extract_smb_metadata_and_cover(source, share, &file_path)
                }
            } else {
                // Nouveau fichier → extraire metadata + cover en une seule lecture
                extract_smb_metadata_and_cover(source, share, &file_path)
            }
        } else {
            // Pas de stats réelles (size=0, modified=0 — pavao 0.2 ne retourne pas les stats)
            // → réutiliser la metadata déjà en cache si disponible (évite lecture SMB inutile)
            // → n'extraire que si c'est la première fois qu'on voit ce fichier
            if let Some(entry) = cached_entry {
                if let Some(ref cached_meta) = entry.metadata {
                    // Metadata déjà extraite lors d'un scan précédent → réutiliser
                    let cover = find_cached_cover(source, share, &file_path);
                    (cached_meta.clone(), cover)
                } else {
                    // Entrée en cache sans metadata → ré-extraire
                    extract_smb_metadata_and_cover(source, share, &file_path)
                }
            } else {
                // Nouveau fichier → extraire (première fois)
                extract_smb_metadata_and_cover(source, share, &file_path)
            }
        };

        // Met à jour le cache différentiel
        source_cache.insert(file_path.clone(), NetworkFileEntry {
            remote_path: file_path.clone(),
            size,
            modified,
            metadata: Some(metadata.clone()),
        });

        // Collecte les cover mappings pour pré-peupler COVER_CACHE dans lib.rs
        if let Some(ref abs_path) = cover_abs {
            cover_mappings.push((smb_uri.clone(), abs_path.clone()));
        }

        // folder = nom du dossier parent du fichier
        let folder_name = Path::new(&file_path)
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or(&source.name)
            .to_string();

        let file_name = Path::new(&file_path)
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("Unknown")
            .to_string();

        tracks.push(crate::TrackWithMetadata {
            path: smb_uri,
            name: file_name,
            folder: folder_name,
            metadata,
        });
    }

    println!("[Network Scan] Extracted metadata for {} tracks from {}", tracks.len(), source.name);
    Ok((tracks, cover_mappings))
}

/// Walk récursif SMB → collecte (path, size, modified) pour chaque fichier audio
fn walk_smb_audio_files(
    source: &NetworkSource,
    share: &str,
    path: &str,
    results: &mut Vec<(String, u64, u64)>,
) {
    let entries = match smb::browse(&source.host, share, path) {
        Ok(e) => e,
        Err(e) => {
            println!("[Network Scan] Browse error at {}/{}{}: {}", source.host, share, path, e);
            return;
        }
    };

    for entry in entries {
        // Ignore les entrées spéciales "." et ".."
        if entry.name == "." || entry.name == ".." {
            continue;
        }

        // Construit le chemin complet de l'entrée (relatif à la racine du share)
        let entry_path = if path.is_empty() || path == "/" {
            format!("/{}", entry.name)
        } else {
            format!("{}/{}", path.trim_end_matches('/'), entry.name)
        };

        if entry.is_dir {
            // Récursion dans les sous-dossiers
            walk_smb_audio_files(source, share, &entry_path, results);
        } else if is_audio_file(&entry.name) {
            results.push((entry_path, entry.size, entry.modified));
        }
    }
}

/// Parser FLAC natif — lit les metadata blocks séquentiellement sans jamais seeker.
/// Fallback pour lofty 0.18 qui échoue sur les fichiers avec SEEKTABLE quand le
/// Cursor ne couvre que les premiers 512KB (les offsets SEEKTABLE pointent au-delà).
/// Extrait : STREAMINFO (sample_rate, bit_depth, duration) + VORBIS_COMMENT + PICTURE.
fn parse_flac_blocks(
    data: &[u8],
    source: &NetworkSource,
    share: &str,
    remote_path: &str,
    default_meta: &crate::Metadata,
) -> (crate::Metadata, Option<String>) {
    // Vérifie le marqueur "fLaC"
    if data.get(0..4) != Some(b"fLaC") {
        return (default_meta.clone(), None);
    }

    let mut meta = default_meta.clone();
    meta.codec = Some("FLAC".to_string());
    let mut cover_data: Option<(Vec<u8>, bool)> = None; // (image_bytes, is_png)
    let mut offset = 4usize;

    loop {
        if offset + 4 > data.len() { break; }

        let header_byte = data[offset];
        let is_last = (header_byte & 0x80) != 0;
        let block_type = header_byte & 0x7F;
        let block_len = ((data[offset + 1] as usize) << 16)
            | ((data[offset + 2] as usize) << 8)
            |  (data[offset + 3] as usize);
        offset += 4;

        // Block tronqué (dépasse les 512KB) → stop propre, on garde ce qu'on a déjà
        if block_len > 0 && offset + block_len > data.len() {
            break;
        }

        if block_len > 0 {
            let block = &data[offset..offset + block_len];

            match block_type {
                // STREAMINFO (type 0) — 34 bytes
                0 if block_len >= 18 => {
                    // Bytes 10-17 (64 bits) :
                    // [20 bits sample_rate][3 bits channels-1][5 bits bps-1][36 bits total_samples]
                    let sample_rate = ((block[10] as u32) << 12)
                        | ((block[11] as u32) << 4)
                        | ((block[12] as u32) >> 4);
                    let bits_per_sample = (((block[12] & 0x01) << 4) | (block[13] >> 4)) + 1;
                    let total_samples = (((block[13] & 0x0F) as u64) << 32)
                        | ((block[14] as u64) << 24)
                        | ((block[15] as u64) << 16)
                        | ((block[16] as u64) << 8)
                        |  (block[17] as u64);
                    if sample_rate > 0 {
                        meta.sample_rate = Some(sample_rate);
                        meta.duration = total_samples as f64 / sample_rate as f64;
                    }
                    if bits_per_sample > 0 {
                        meta.bit_depth = Some(bits_per_sample as u8);
                    }
                }

                // VORBIS_COMMENT (type 4) — paires KEY=VALUE en little-endian UTF-8
                4 if block_len >= 8 => {
                    let mut pos = 0usize;
                    // Skip vendor string
                    if pos + 4 <= block.len() {
                        let vendor_len = u32::from_le_bytes([
                            block[pos], block[pos+1], block[pos+2], block[pos+3],
                        ]) as usize;
                        pos += 4;
                        pos = pos.saturating_add(vendor_len).min(block.len());
                    }
                    // Lire les commentaires
                    if pos + 4 <= block.len() {
                        let comment_count = u32::from_le_bytes([
                            block[pos], block[pos+1], block[pos+2], block[pos+3],
                        ]) as usize;
                        pos += 4;
                        let mut found_artist = false;
                        for _ in 0..comment_count {
                            if pos + 4 > block.len() { break; }
                            let comment_len = u32::from_le_bytes([
                                block[pos], block[pos+1], block[pos+2], block[pos+3],
                            ]) as usize;
                            pos += 4;
                            if pos + comment_len > block.len() { break; }
                            if let Ok(comment) = std::str::from_utf8(&block[pos..pos + comment_len]) {
                                if let Some(eq_idx) = comment.find('=') {
                                    let key = comment[..eq_idx].to_uppercase();
                                    let value = &comment[eq_idx + 1..];
                                    if !value.is_empty() {
                                        match key.as_str() {
                                            "TITLE" => meta.title = value.to_string(),
                                            "ARTIST" => {
                                                meta.artist = value.to_string();
                                                found_artist = true;
                                            }
                                            "ALBUMARTIST" if !found_artist => {
                                                meta.artist = value.to_string();
                                            }
                                            "ALBUM" => meta.album = value.to_string(),
                                            "TRACKNUMBER" => {
                                                // Format: "5" ou "5/12"
                                                let n_str = value.split('/').next().unwrap_or(value);
                                                if let Ok(n) = n_str.trim().parse::<u32>() {
                                                    meta.track = n;
                                                }
                                            }
                                            "DISCNUMBER" => {
                                                let n_str = value.split('/').next().unwrap_or(value);
                                                if let Ok(n) = n_str.trim().parse::<u32>() {
                                                    meta.disc = Some(n);
                                                }
                                            }
                                            "DATE" | "YEAR" => {
                                                // "2023", "2023-01-15", "2023-01" → extraire l'année
                                                let year_part = value.split('-').next().unwrap_or(value).trim();
                                                if let Ok(y) = year_part.parse::<u32>() {
                                                    if y > 1000 && y < 9999 {
                                                        meta.year = Some(y);
                                                    }
                                                }
                                            }
                                            "GENRE" => meta.genre = Some(value.to_string()),
                                            _ => {}
                                        }
                                    }
                                }
                            }
                            pos += comment_len;
                        }
                    }
                }

                // PICTURE (type 6) — pochette embarquée
                6 if block_len >= 32 => {
                    let mut pos = 0usize;
                    pos += 4; // skip picture type (4 bytes)
                    if pos + 4 <= block.len() {
                        let mime_len = u32::from_be_bytes([
                            block[pos], block[pos+1], block[pos+2], block[pos+3],
                        ]) as usize;
                        pos += 4;
                        if pos + mime_len <= block.len() {
                            let mime = std::str::from_utf8(&block[pos..pos + mime_len]).unwrap_or("");
                            let is_png = mime.contains("png");
                            pos += mime_len;
                            // Skip description
                            if pos + 4 <= block.len() {
                                let desc_len = u32::from_be_bytes([
                                    block[pos], block[pos+1], block[pos+2], block[pos+3],
                                ]) as usize;
                                pos += 4;
                                if pos + desc_len <= block.len() {
                                    pos += desc_len;
                                    pos += 16; // skip width(4) + height(4) + depth(4) + colors(4)
                                    if pos + 4 <= block.len() {
                                        let img_len = u32::from_be_bytes([
                                            block[pos], block[pos+1], block[pos+2], block[pos+3],
                                        ]) as usize;
                                        pos += 4;
                                        // Image tient dans le buffer → extraire (première seulement)
                                        if pos + img_len <= block.len() && cover_data.is_none() {
                                            cover_data = Some((
                                                block[pos..pos + img_len].to_vec(),
                                                is_png,
                                            ));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                _ => {}
            }
        }

        offset += block_len;
        if is_last || block_type == 127 { break; }
    }

    // Sauvegarde la pochette sur disque si trouvée
    let cover_abs = cover_data.and_then(|(img_bytes, is_png)| {
        let clean_path = remote_path.trim_start_matches('/');
        let smb_uri = format!("smb://{}/{}/{}", source.id, share, clean_path);
        let hash = path_hash(&smb_uri);
        let ext = if is_png { "png" } else { "jpg" };
        let cover_dir = crate::get_data_dir().join("covers");
        std::fs::create_dir_all(&cover_dir).ok()?;
        let cache_file = cover_dir.join(format!("{}.{}", hash, ext));
        if !cache_file.exists() {
            std::fs::write(&cache_file, &img_bytes).ok()?;
        }
        Some(cache_file.to_string_lossy().to_string())
    });

    (meta, cover_abs)
}

/// Lit 512KB une fois → extrait metadata ET cover en un seul passage lofty
/// Retourne (metadata, cover_abs_path) — élimine la double lecture 512KB
pub fn extract_smb_metadata_and_cover(
    source: &NetworkSource,
    share: &str,
    remote_path: &str,
) -> (crate::Metadata, Option<String>) {
    let file_name = Path::new(remote_path)
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or("Unknown")
        .to_string();

    let default_meta = crate::Metadata {
        title: file_name.clone(),
        artist: "Unknown Artist".to_string(),
        album: "Unknown Album".to_string(),
        track: 0,
        disc: None,
        year: None,
        genre: None,
        genre_enriched: false,
        duration: 0.0,
        bit_depth: None,
        sample_rate: None,
        bitrate: None,
        codec: None,
    };

    // Lecture unique de 512KB
    let data = match smb::read_file_head(&source.host, share, remote_path, 512_000) {
        Ok(d) => d,
        Err(e) => {
            println!("[Network Scan] read_file_head failed for {}: {}", remote_path, e);
            return (default_meta, None);
        }
    };

    // Déterminer si c'est un FLAC (pour le fallback parser natif sans seek)
    let is_flac = Path::new(remote_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase() == "flac")
        .unwrap_or(false);

    let file_type = Path::new(remote_path)
        .extension()
        .and_then(|e| e.to_str())
        .and_then(|e| match e.to_lowercase().as_str() {
            "flac" => Some(lofty::FileType::Flac),
            "mp3" => Some(lofty::FileType::Mpeg),
            "m4a" | "mp4" | "aac" => Some(lofty::FileType::Mp4),
            "wav" => Some(lofty::FileType::Wav),
            "aiff" | "aif" => Some(lofty::FileType::Aiff),
            _ => None,
        });

    // Emprunter data (pas move) → disponible pour parse_flac_blocks si lofty échoue
    let cursor = Cursor::new(&data[..]);
    let tagged_file = if let Some(ft) = file_type {
        match Probe::with_file_type(cursor, ft).read() {
            Ok(tf) => tf,
            Err(e) => {
                if is_flac {
                    // Fallback : parser natif FLAC (lit les blocks sans jamais seeker)
                    println!("[Network Scan] lofty FLAC fallback for {}: {}", remote_path, e);
                    return parse_flac_blocks(&data, source, share, remote_path, &default_meta);
                }
                println!("[Network Scan] lofty parse failed for {}: {}", remote_path, e);
                return (default_meta, None);
            }
        }
    } else {
        match Probe::new(cursor).guess_file_type() {
            Ok(p) => match p.read() {
                Ok(tf) => tf,
                Err(e) => {
                    if is_flac {
                        println!("[Network Scan] lofty FLAC fallback for {}: {}", remote_path, e);
                        return parse_flac_blocks(&data, source, share, remote_path, &default_meta);
                    }
                    println!("[Network Scan] lofty read failed for {}: {}", remote_path, e);
                    return (default_meta, None);
                }
            },
            Err(e) => {
                if is_flac {
                    println!("[Network Scan] lofty FLAC fallback for {}: {}", remote_path, e);
                    return parse_flac_blocks(&data, source, share, remote_path, &default_meta);
                }
                println!("[Network Scan] Could not guess file type for {}: {}", remote_path, e);
                return (default_meta, None);
            }
        }
    };

    // Extraction metadata depuis les propriétés audio
    let properties = tagged_file.properties();
    let mut metadata = default_meta;
    metadata.duration = properties.duration().as_secs_f64();
    metadata.sample_rate = properties.sample_rate();
    metadata.bit_depth = properties.bit_depth();
    metadata.bitrate = properties.audio_bitrate();

    metadata.codec = Some(match tagged_file.file_type() {
        lofty::FileType::Flac => "FLAC".to_string(),
        lofty::FileType::Mpeg => "MP3".to_string(),
        lofty::FileType::Mp4 => {
            if metadata.bit_depth.is_some() { "ALAC".to_string() }
            else { "AAC".to_string() }
        }
        lofty::FileType::Wav => "WAV".to_string(),
        lofty::FileType::Aiff => "AIFF".to_string(),
        _ => "Other".to_string(),
    });

    if let Some(tag) = tagged_file.primary_tag().or_else(|| tagged_file.first_tag()) {
        if let Some(title) = tag.title() {
            metadata.title = title.to_string();
        }
        if let Some(artist) = tag.artist() {
            metadata.artist = artist.to_string();
        }
        if let Some(album) = tag.album() {
            metadata.album = album.to_string();
        }
        if let Some(track) = tag.track() {
            metadata.track = track;
        }
        if let Some(disc) = tag.disk() {
            metadata.disc = Some(disc);
        }
        if let Some(year) = tag.year() {
            metadata.year = Some(year);
        }
        if let Some(genre) = tag.genre() {
            metadata.genre = Some(genre.to_string());
        }
    }

    // Extraction cover depuis le même tagged_file (0 lecture SMB supplémentaire)
    let cover_abs = save_cover_from_tagged(&tagged_file, source, share, remote_path);

    (metadata, cover_abs)
}

/// Extraction metadata depuis les premiers 512KB du fichier SMB (via lofty)
/// Conservé pour compatibilité (utilisé en fallback)
pub fn extract_smb_metadata(
    source: &NetworkSource,
    share: &str,
    remote_path: &str,
) -> crate::Metadata {
    let (metadata, _) = extract_smb_metadata_and_cover(source, share, remote_path);
    metadata
}

/// Extraction de la pochette → sauvegarde dans covers/ → retourne le nom du fichier
pub fn extract_smb_cover(
    source: &NetworkSource,
    share: &str,
    remote_path: &str,
) -> Option<String> {
    let (_, cover_abs) = extract_smb_metadata_and_cover(source, share, remote_path);
    let abs = cover_abs?;
    Path::new(&abs).file_name()?.to_str().map(|s| s.to_string())
}

/// Extraction de la pochette → retourne le chemin absolu (pour COVER_CACHE)
pub fn extract_smb_cover_abs(
    source: &NetworkSource,
    share: &str,
    remote_path: &str,
) -> Option<String> {
    let (_, cover_abs) = extract_smb_metadata_and_cover(source, share, remote_path);
    cover_abs
}

/// Download complet d'un fichier SMB vers un fichier temporaire local
/// (nécessaire pour Symphonia qui requiert Read + Seek)
pub fn download_smb_to_temp(
    source: &NetworkSource,
    share: &str,
    remote_path: &str,
) -> Result<PathBuf, String> {
    // ── [TIMING DL-0] Entrée download_smb_to_temp ─────────────────────────
    let t_dl = std::time::Instant::now();
    println!("[SMB TIMING] DL+0ms    — download_smb_to_temp start: {}", remote_path);

    let clean_path = remote_path.trim_start_matches('/');
    let smb_uri = format!("smb://{}/{}/{}", source.id, share, clean_path);
    let hash = path_hash(&smb_uri);

    let buffer_dir = smb_buffer_dir();
    std::fs::create_dir_all(&buffer_dir)
        .map_err(|e| format!("Failed to create smb_buffer dir: {}", e))?;

    let ext = Path::new(remote_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("tmp");

    let temp_file = buffer_dir.join(format!("{}.{}", hash, ext));

    // ── [TIMING DL-1] Vérification cache temp ─────────────────────────────
    if temp_file.exists() {
        println!("[SMB TIMING] DL+{}ms — TEMP CACHE HIT → lecture locale immédiate: {:?}",
            t_dl.elapsed().as_millis(), temp_file);
        return Ok(temp_file);
    }
    println!("[SMB TIMING] DL+{}ms — TEMP CACHE MISS → téléchargement requis",
        t_dl.elapsed().as_millis());

    // ── [TIMING DL-2] Début read_file (connexion + transfert SMB) ─────────
    println!("[SMB TIMING] DL+{}ms — smb::read_file START (host={}, share={})",
        t_dl.elapsed().as_millis(), source.host, share);
    let t_read = std::time::Instant::now();

    let data = smb::read_file(&source.host, share, remote_path)?;

    // ── [TIMING DL-3] Transfert terminé ───────────────────────────────────
    let bytes = data.len();
    let read_ms = t_read.elapsed().as_millis();
    let speed_kbps = if read_ms > 0 { bytes as u128 / read_ms } else { 0 };
    println!("[SMB TIMING] DL+{}ms — smb::read_file DONE: {} bytes in {}ms (~{} KB/s)",
        t_dl.elapsed().as_millis(), bytes, read_ms, speed_kbps);

    // ── [TIMING DL-4] Écriture disque temp ────────────────────────────────
    let t_write = std::time::Instant::now();
    std::fs::write(&temp_file, &data)
        .map_err(|e| format!("Failed to write temp file: {}", e))?;
    println!("[SMB TIMING] DL+{}ms — write to temp: {}ms → {:?}",
        t_dl.elapsed().as_millis(), t_write.elapsed().as_millis(), temp_file);

    println!("[SMB TIMING] DL TOTAL: {}ms", t_dl.elapsed().as_millis());
    Ok(temp_file)
}

/// Démarre le téléchargement progressif d'un fichier SMB en arrière-plan.
/// Retourne immédiatement avec (temp_path, bytes_written, download_done).
/// Le moteur audio peut ouvrir temp_path dès que bytes_written >= seuil.
///
/// Cache: si le fichier existe et fait > 1MB, le download est sauté (cache hit).
/// Partial: si le fichier existe mais est ≤ 1MB (crash précédent), il est supprimé et re-téléchargé.
pub fn start_progressive_download(
    source: &NetworkSource,
    share: &str,
    remote_path: &str,
    cancel_previous: bool,
) -> Result<(PathBuf, Arc<AtomicU64>, Arc<AtomicBool>), String> {
    let clean_path = remote_path.trim_start_matches('/');
    let smb_uri = format!("smb://{}/{}/{}", source.id, share, clean_path);
    let hash = path_hash(&smb_uri);

    let buffer_dir = smb_buffer_dir();
    std::fs::create_dir_all(&buffer_dir)
        .map_err(|e| format!("Failed to create smb_buffer dir: {}", e))?;

    let ext = Path::new(remote_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("tmp");

    let temp_file = buffer_dir.join(format!("{}.{}", hash, ext));

    let bytes_written = Arc::new(AtomicU64::new(0));
    let download_done = Arc::new(AtomicBool::new(false));

    // Cache hit : fichier complet présent sur disque (> 1MB = probablement complet)
    if temp_file.exists() {
        let file_size = std::fs::metadata(&temp_file).map(|m| m.len()).unwrap_or(0);
        if file_size > 1024 * 1024 {
            println!("[SMB Progressive] CACHE HIT: {} MB → {:?}",
                file_size / (1024 * 1024), temp_file);
            bytes_written.store(file_size, Ordering::Release);
            download_done.store(true, Ordering::Release);
            return Ok((temp_file, bytes_written, download_done));
        } else {
            // Fichier partiel (crash précédent) → supprimer et recommencer
            println!("[SMB Progressive] Partial cache ({} bytes), deleting and re-downloading", file_size);
            let _ = std::fs::remove_file(&temp_file);
        }
    }

    // Réutilisation download en cours : si ce fichier est déjà en cours de téléchargement
    // (ex: preload déclenché puis l'utilisateur clique sur le même track), retourner les
    // Arcs existants sans démarrer un second thread ni annuler le travail déjà effectué.
    if let Ok(registry) = crate::PROGRESSIVE_DOWNLOADS.lock() {
        if let Some((bw, dd)) = registry.get(&temp_file) {
            println!("[SMB Progressive] REUSE in-progress download: {}", remote_path);
            return Ok((temp_file, bw.clone(), dd.clone()));
        }
    }

    // Cache miss → démarrer le téléchargement progressif dans un thread OS dédié
    println!("[SMB Progressive] CACHE MISS → background download (cancel_previous={}): {}",
        cancel_previous, remote_path);

    // ── Annulation du download précédent ──────────────────────────────────────────
    // cancel_previous = true  → audio_play pour un nouveau track : annuler l'ancien download
    //                           et libérer CONNECTION mutex en ~2ms.
    // cancel_previous = false → preload gapless : ne pas annuler le download du track courant ;
    //                           ce download attendra que CONNECTION soit libre.
    // Dans les deux cas, on enregistre ce nouveau cancel dans CURRENT_DOWNLOAD_CANCEL pour
    // permettre à un futur audio_play d'annuler ce preload si un autre track est demandé.
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut current) = CURRENT_DOWNLOAD_CANCEL.lock() {
        if cancel_previous {
            if let Some(old_cancel) = current.as_ref() {
                old_cancel.store(true, Ordering::Release);
                println!("[SMB Progressive] Download précédent annulé → libération CONNECTION mutex");
            }
        }
        *current = Some(cancel.clone());
    }

    // ── Registry PROGRESSIVE_DOWNLOADS ───────────────────────────────────────────
    // Enregistrer AVANT de spawner le thread.
    // audio_decoder::open_media_source utilisera cette entrée pour créer un SmbProgressiveFile
    // qui bloque sur read/seek jusqu'à la disponibilité des données (fix seek failures).
    if let Ok(mut registry) = crate::PROGRESSIVE_DOWNLOADS.lock() {
        registry.insert(temp_file.clone(), (bytes_written.clone(), download_done.clone()));
    }

    let bw = bytes_written.clone();
    let dd = download_done.clone();
    let host = source.host.clone();
    let share_s = share.to_string();
    let remote_s = remote_path.to_string();
    let temp_clone = temp_file.clone();
    let temp_for_registry = temp_file.clone();
    let cancel_thread = cancel;

    std::thread::spawn(move || {
        // read_file_to_temp_progressive utilise le CONNECTION mutex partagé (un seul SmbClient actif).
        // cancel_thread permet d'interrompre ce download si un nouveau track est demandé.
        match smb::read_file_to_temp_progressive(
            &host, &share_s, &remote_s, &temp_clone, &bw, &cancel_thread,
        ) {
            Ok(()) => {
                println!("[SMB Progressive] Thread: download OK ({} bytes)",
                    bw.load(Ordering::Relaxed));
            }
            Err(e) => {
                eprintln!("[SMB Progressive] Thread: download FAILED: {}", e);
                // Supprimer le fichier partiel pour ne pas polluer le cache
                let _ = std::fs::remove_file(&temp_clone);
            }
        }
        // Signaler la fin (succès OU erreur OU annulation) → SmbProgressiveFile::wait_for_bytes() se débloque
        dd.store(true, Ordering::Release);
        // Nettoyer le registry : les instances SmbProgressiveFile existantes tiennent leurs propres Arcs
        if let Ok(mut registry) = crate::PROGRESSIVE_DOWNLOADS.lock() {
            registry.remove(&temp_for_registry);
        }
    });

    Ok((temp_file, bytes_written, download_done))
}
