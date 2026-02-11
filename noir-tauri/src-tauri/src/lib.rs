use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::sync::Mutex;
use std::io::Cursor;
use once_cell::sync::Lazy;
use walkdir::WalkDir;
use lofty::{Accessor, AudioFile, Probe, TaggedFileExt, MimeType};
use base64::{Engine as _, engine::general_purpose};
use tauri_plugin_dialog::DialogExt;
use reqwest::Client;
use rayon::prelude::*;
use image::imageops::FilterType;
use image::ImageFormat;

// === AUDIO ENGINE MODULES ===
mod audio;
mod audio_decoder;
mod audio_engine;
mod resampler;
use audio_engine::AudioEngine;

// Structure pour un fichier audio
#[derive(Serialize, Deserialize, Clone)]
struct AudioTrack {
    path: String,
    name: String,
    folder: String,
}

// Structure pour un fichier audio avec métadonnées (scan rapide)
#[derive(Serialize, Deserialize, Clone)]
struct TrackWithMetadata {
    path: String,
    name: String,
    folder: String,
    metadata: Metadata,
}

// Structure pour les métadonnées
#[derive(Serialize, Deserialize, Clone)]
struct Metadata {
    title: String,
    artist: String,
    album: String,
    track: u32,
    disc: Option<u32>,
    year: Option<u32>,
    duration: f64,
    #[serde(rename = "bitDepth")]
    bit_depth: Option<u8>,
    #[serde(rename = "sampleRate")]
    sample_rate: Option<u32>,
    bitrate: Option<u32>,
    codec: Option<String>,
}

// Configuration de la bibliothèque
#[derive(Serialize, Deserialize, Default)]
struct Config {
    library_paths: Vec<String>,
}

// Cache des métadonnées
#[derive(Serialize, Deserialize, Default, Clone)]
struct MetadataCache {
    entries: HashMap<String, Metadata>,
}

// Cache des pochettes
#[derive(Serialize, Deserialize, Default, Clone)]
struct CoverCache {
    entries: HashMap<String, String>,
}

// Structure pour une playlist
#[derive(Serialize, Deserialize, Clone)]
struct Playlist {
    id: String,
    name: String,
    #[serde(rename = "trackPaths")]
    track_paths: Vec<String>,
    #[serde(rename = "createdAt")]
    created_at: u64,
    #[serde(rename = "isSystem", default)]
    is_system: bool,  // True pour les playlists système (ex: favoris) - non supprimables
}

// Structure pour le fichier de playlists
#[derive(Serialize, Deserialize, Default, Clone)]
struct PlaylistsData {
    playlists: Vec<Playlist>,
}

// Cache pour les pochettes "not found" sur Internet (évite les requêtes répétées)
#[derive(Serialize, Deserialize, Default, Clone)]
struct InternetCoverNotFoundCache {
    entries: HashMap<String, bool>, // album_key -> true si déjà cherché sans succès
}

// === HISTORIQUE D'ÉCOUTE ===
// Structure pour une entrée d'écoute
#[derive(Serialize, Deserialize, Clone)]
struct ListeningEntry {
    path: String,
    artist: String,
    album: String,
    title: String,
    timestamp: u64, // Unix timestamp en secondes
}

// Structure pour l'historique complet
#[derive(Serialize, Deserialize, Default, Clone)]
struct ListeningHistory {
    entries: Vec<ListeningEntry>,           // Historique ordonné par timestamp décroissant
    last_played: Option<ListeningEntry>,    // Dernière track jouée
}

// === DATE D'AJOUT DES TRACKS ===
// Structure pour stocker la date d'ajout de chaque track (timestamp Unix en secondes)
#[derive(Serialize, Deserialize, Default, Clone)]
struct AddedDatesCache {
    entries: HashMap<String, u64>, // path -> timestamp d'ajout
}

// === CACHE DES TRACKS (pour démarrage instantané) ===
#[derive(Serialize, Deserialize, Default, Clone)]
struct TracksCache {
    tracks: Vec<TrackWithMetadata>,
    last_scan_timestamp: u64,
}

// === STATISTIQUES DE LA BIBLIOTHÈQUE ===
#[derive(Serialize, Clone, Default)]
struct LibraryStats {
    artists_count: usize,
    albums_count: usize,
    total_tracks: usize,
    mp3_count: usize,
    flac_16bit_count: usize,
    flac_24bit_count: usize,
    other_count: usize,
}

// === ÉVÉNEMENTS DE SCAN ===
#[derive(Serialize, Clone)]
struct ScanProgress {
    phase: String,           // "scanning" | "loading_metadata" | "complete"
    current: usize,
    total: usize,
    folder: String,
}

#[derive(Serialize, Clone)]
struct ScanComplete {
    stats: LibraryStats,
    new_tracks: usize,
    removed_tracks: usize,
}

// Structures pour l'API MusicBrainz
#[derive(Deserialize)]
struct MusicBrainzSearchResponse {
    releases: Option<Vec<MusicBrainzRelease>>,
}

#[derive(Deserialize)]
struct MusicBrainzRelease {
    id: String,
    score: Option<u32>,
}

// Structures pour la recherche d'artistes
#[derive(Deserialize)]
struct MusicBrainzArtistSearchResponse {
    artists: Option<Vec<MusicBrainzArtist>>,
}

#[derive(Deserialize)]
struct MusicBrainzArtist {
    id: String,
    score: Option<u32>,
}

// Structure pour les relations d'artiste (images, etc.)
#[derive(Deserialize)]
struct MusicBrainzArtistDetails {
    relations: Option<Vec<MusicBrainzRelation>>,
}

#[derive(Deserialize)]
struct MusicBrainzRelation {
    #[serde(rename = "type")]
    relation_type: Option<String>,
    url: Option<MusicBrainzUrl>,
}

#[derive(Deserialize)]
struct MusicBrainzUrl {
    resource: Option<String>,
}

// === CACHE GLOBAL EN MÉMOIRE ===
static METADATA_CACHE: Lazy<Mutex<MetadataCache>> = Lazy::new(|| {
    Mutex::new(load_metadata_cache_from_file())
});

static COVER_CACHE: Lazy<Mutex<CoverCache>> = Lazy::new(|| {
    Mutex::new(load_cover_cache_from_file())
});

// Flag pour savoir si le cache a été modifié
static CACHE_DIRTY: Lazy<Mutex<bool>> = Lazy::new(|| Mutex::new(false));

// Cache des pochettes non trouvées sur Internet
static INTERNET_NOT_FOUND_CACHE: Lazy<Mutex<InternetCoverNotFoundCache>> = Lazy::new(|| {
    Mutex::new(load_internet_not_found_cache())
});

// Cache de l'historique d'écoute
static LISTENING_HISTORY: Lazy<Mutex<ListeningHistory>> = Lazy::new(|| {
    Mutex::new(load_listening_history())
});

// Cache des dates d'ajout des tracks
static ADDED_DATES_CACHE: Lazy<Mutex<AddedDatesCache>> = Lazy::new(|| {
    Mutex::new(load_added_dates_cache())
});

// Cache des tracks (pour démarrage instantané)
static TRACKS_CACHE: Lazy<Mutex<TracksCache>> = Lazy::new(|| {
    Mutex::new(load_tracks_cache())
});

// === AUDIO ENGINE GLOBAL ===
// Note: sera initialisé avec AppHandle dans run()
static AUDIO_ENGINE: Lazy<Mutex<Option<AudioEngine>>> = Lazy::new(|| {
    Mutex::new(None)
});

// Client HTTP global (réutilisé pour toutes les requêtes)
// Timeout réduit à 5s pour éviter les blocages UI
static HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .user_agent("Noir/0.1.0 (Audio Player)")
        .timeout(std::time::Duration::from_secs(5))
        .connect_timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap_or_else(|_| Client::new())
});

// === CHEMINS DES FICHIERS ===
fn get_data_dir() -> PathBuf {
    let home = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join("noir")
}

fn get_config_path() -> PathBuf {
    get_data_dir().join("config.json")
}

fn get_metadata_cache_path() -> PathBuf {
    get_data_dir().join("metadata_cache.json")
}

fn get_cover_cache_dir() -> PathBuf {
    get_data_dir().join("covers")
}

fn get_thumbnail_cache_dir() -> PathBuf {
    get_data_dir().join("thumbnails")
}

fn get_playlists_path() -> PathBuf {
    get_data_dir().join("playlists.json")
}

fn get_listening_history_path() -> PathBuf {
    get_data_dir().join("listening_history.json")
}

fn get_added_dates_cache_path() -> PathBuf {
    get_data_dir().join("added_dates_cache.json")
}

fn get_tracks_cache_path() -> PathBuf {
    get_data_dir().join("tracks_cache.json")
}

// === FONCTIONS DE LECTURE/ÉCRITURE FICHIER ===
fn load_config() -> Config {
    let config_path = get_config_path();
    if config_path.exists() {
        let content = fs::read_to_string(&config_path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        Config::default()
    }
}

fn save_config(config: &Config) {
    let config_path = get_config_path();
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let content = serde_json::to_string_pretty(config).unwrap_or_default();
    fs::write(config_path, content).ok();
}

fn load_metadata_cache_from_file() -> MetadataCache {
    let cache_path = get_metadata_cache_path();
    if cache_path.exists() {
        let content = fs::read_to_string(&cache_path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        MetadataCache::default()
    }
}

fn save_metadata_cache_to_file(cache: &MetadataCache) {
    let cache_path = get_metadata_cache_path();
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let content = serde_json::to_string(cache).unwrap_or_default();
    fs::write(cache_path, content).ok();
}

fn load_cover_cache_from_file() -> CoverCache {
    let cache_path = get_data_dir().join("cover_cache.json");
    if cache_path.exists() {
        let content = fs::read_to_string(&cache_path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        CoverCache::default()
    }
}

fn save_cover_cache_to_file(cache: &CoverCache) {
    let cache_path = get_data_dir().join("cover_cache.json");
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let content = serde_json::to_string(cache).unwrap_or_default();
    fs::write(cache_path, content).ok();
}

fn load_internet_not_found_cache() -> InternetCoverNotFoundCache {
    let cache_path = get_data_dir().join("internet_not_found_cache.json");
    if cache_path.exists() {
        let content = fs::read_to_string(&cache_path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        InternetCoverNotFoundCache::default()
    }
}

fn save_internet_not_found_cache(cache: &InternetCoverNotFoundCache) {
    let cache_path = get_data_dir().join("internet_not_found_cache.json");
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let content = serde_json::to_string(cache).unwrap_or_default();
    fs::write(cache_path, content).ok();
}

// === FONCTIONS HISTORIQUE D'ÉCOUTE ===
fn load_listening_history() -> ListeningHistory {
    let path = get_listening_history_path();
    if path.exists() {
        let content = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        ListeningHistory::default()
    }
}

fn save_listening_history(history: &ListeningHistory) {
    let path = get_listening_history_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let content = serde_json::to_string_pretty(history).unwrap_or_default();
    fs::write(path, content).ok();
}

// === DATES D'AJOUT DES TRACKS ===
fn load_added_dates_cache() -> AddedDatesCache {
    let path = get_added_dates_cache_path();
    if path.exists() {
        let content = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        AddedDatesCache::default()
    }
}

fn save_added_dates_cache(cache: &AddedDatesCache) {
    let path = get_added_dates_cache_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let content = serde_json::to_string(cache).unwrap_or_default();
    fs::write(path, content).ok();
}

// === TRACKS CACHE (pour démarrage instantané) ===
fn load_tracks_cache() -> TracksCache {
    let path = get_tracks_cache_path();
    if path.exists() {
        let content = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        TracksCache::default()
    }
}

fn save_tracks_cache(cache: &TracksCache) {
    let path = get_tracks_cache_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let content = serde_json::to_string(cache).unwrap_or_default();
    fs::write(path, content).ok();
}

// Calcule les statistiques de la bibliothèque
fn calculate_library_stats(tracks: &[TrackWithMetadata]) -> LibraryStats {
    use std::collections::HashSet;

    let mut artists: HashSet<String> = HashSet::new();
    let mut albums: HashSet<String> = HashSet::new();
    let mut mp3_count = 0;
    let mut flac_16bit_count = 0;
    let mut flac_24bit_count = 0;
    let mut other_count = 0;

    for track in tracks {
        artists.insert(track.metadata.artist.clone());
        albums.insert(format!("{} - {}", track.metadata.artist, track.metadata.album));

        // Détermine le format par extension et bit_depth
        let ext = Path::new(&track.path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        match ext.as_str() {
            "mp3" => mp3_count += 1,
            "flac" => {
                if let Some(bit_depth) = track.metadata.bit_depth {
                    if bit_depth > 16 {
                        flac_24bit_count += 1;
                    } else {
                        flac_16bit_count += 1;
                    }
                } else {
                    flac_16bit_count += 1; // Par défaut 16-bit si inconnu
                }
            }
            _ => other_count += 1,
        }
    }

    LibraryStats {
        artists_count: artists.len(),
        albums_count: albums.len(),
        total_tracks: tracks.len(),
        mp3_count,
        flac_16bit_count,
        flac_24bit_count,
        other_count,
    }
}

// === PLAYLISTS ===
fn load_playlists() -> PlaylistsData {
    let path = get_playlists_path();
    if path.exists() {
        let content = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        PlaylistsData::default()
    }
}

fn save_playlists(data: &PlaylistsData) {
    let path = get_playlists_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let content = serde_json::to_string_pretty(data).unwrap_or_default();
    fs::write(path, content).ok();
}

fn generate_playlist_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("pl_{}", timestamp)
}

/// ID constant pour la playlist favoris
const FAVORITES_PLAYLIST_ID: &str = "favorites";

/// Assure que la playlist "mes favoris" existe et est en première position
fn ensure_favorites_playlist(data: &mut PlaylistsData) {
    // Vérifie si la playlist favoris existe déjà
    let has_favorites = data.playlists.iter().any(|p| p.id == FAVORITES_PLAYLIST_ID);

    if !has_favorites {
        // Crée la playlist favoris
        let favorites = Playlist {
            id: FAVORITES_PLAYLIST_ID.to_string(),
            name: "mes favoris".to_string(),
            track_paths: vec![],
            created_at: 0,  // Timestamp 0 pour toujours être en premier si trié par date
            is_system: true,
        };
        // Insère en première position
        data.playlists.insert(0, favorites);
    } else {
        // S'assure que la playlist favoris est en première position
        if let Some(pos) = data.playlists.iter().position(|p| p.id == FAVORITES_PLAYLIST_ID) {
            if pos != 0 {
                let favorites = data.playlists.remove(pos);
                data.playlists.insert(0, favorites);
            }
        }
    }
}

// === UTILITAIRES ===
fn is_audio_file(path: &Path) -> bool {
    let extensions = ["mp3", "flac", "wav", "m4a", "aac", "ogg", "wma", "aiff", "alac", "dsd", "dsf", "dff"];
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| extensions.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn md5_hash(input: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    input.hash(&mut hasher);
    hasher.finish()
}

// Recherche une pochette sur MusicBrainz + Cover Art Archive (async)
async fn fetch_cover_from_musicbrainz(artist: &str, album: &str) -> Option<Vec<u8>> {
    // Nettoie et encode les paramètres
    let artist_clean = artist.replace("Artistes Variés", "").trim().to_string();
    let album_clean = album.trim();

    if album_clean.is_empty() || album_clean == "Album inconnu" {
        return None;
    }

    // Construit la requête MusicBrainz
    let query = if artist_clean.is_empty() || artist_clean == "Artiste inconnu" {
        format!("release:{}", urlencoding_simple(album_clean))
    } else {
        format!("release:{} AND artist:{}",
            urlencoding_simple(album_clean),
            urlencoding_simple(&artist_clean))
    };

    let search_url = format!(
        "https://musicbrainz.org/ws/2/release/?query={}&fmt=json&limit=5",
        query
    );

    // Recherche sur MusicBrainz (async)
    let response = HTTP_CLIENT.get(&search_url).send().await.ok()?;
    let search_result: MusicBrainzSearchResponse = response.json().await.ok()?;

    // Prend le meilleur résultat
    let releases = search_result.releases?;
    let best_release = releases.into_iter()
        .filter(|r| r.score.unwrap_or(0) > 50)
        .next()?;

    // Récupère la pochette depuis Cover Art Archive
    let cover_url = format!(
        "https://coverartarchive.org/release/{}/front-500",
        best_release.id
    );

    let cover_response = HTTP_CLIENT.get(&cover_url).send().await.ok()?;

    if cover_response.status().is_success() {
        cover_response.bytes().await.ok().map(|b| b.to_vec())
    } else {
        None
    }
}

// Recherche une photo d'artiste via Deezer API (prioritaire car plus de photos) - async
async fn fetch_artist_image_from_deezer(artist_name: &str) -> Option<Vec<u8>> {
    let artist_clean = artist_name.trim();

    if artist_clean.is_empty() || artist_clean == "Artiste inconnu" || artist_clean == "Artistes Variés" {
        return None;
    }

    // Recherche sur Deezer (API gratuite, pas de clé requise)
    let search_url = format!(
        "https://api.deezer.com/search/artist?q={}",
        urlencoding_simple(artist_clean)
    );

    let response = HTTP_CLIENT.get(&search_url).send().await.ok()?;
    let json: serde_json::Value = response.json().await.ok()?;

    // Récupère le premier artiste
    let data = json.get("data")?.as_array()?;

    // Deezer peut retourner un tableau vide
    if data.is_empty() {
        return None;
    }

    let first_artist = data.first()?;

    // Deezer fournit plusieurs tailles : picture_small, picture_medium, picture_big, picture_xl
    // On prend picture_big (500x500) ou picture_xl (1000x1000)
    let image_url = first_artist.get("picture_big")
        .or_else(|| first_artist.get("picture_xl"))
        .or_else(|| first_artist.get("picture_medium"))
        .and_then(|v| v.as_str())
        // Filtre les URLs vides et les placeholders Deezer
        .filter(|s| !s.is_empty() && !s.contains("/artist//") && s.starts_with("http"))?;

    // Télécharge l'image
    let image_response = HTTP_CLIENT.get(image_url).send().await.ok()?;
    if image_response.status().is_success() {
        let bytes = image_response.bytes().await.ok()?;
        // Vérifie que l'image n'est pas vide (placeholder)
        if bytes.len() > 1000 {
            return Some(bytes.to_vec());
        }
    }

    None
}

// Recherche une photo d'artiste via MusicBrainz + Wikimedia Commons (fallback) - async
async fn fetch_artist_image_from_musicbrainz(artist_name: &str) -> Option<Vec<u8>> {
    let artist_clean = artist_name.trim();

    if artist_clean.is_empty() || artist_clean == "Artiste inconnu" || artist_clean == "Artistes Variés" {
        return None;
    }

    // 1. Recherche l'artiste sur MusicBrainz
    let search_url = format!(
        "https://musicbrainz.org/ws/2/artist/?query=artist:{}&fmt=json&limit=5",
        urlencoding_simple(artist_clean)
    );

    let response = HTTP_CLIENT.get(&search_url).send().await.ok()?;
    let search_result: MusicBrainzArtistSearchResponse = response.json().await.ok()?;

    // Prend le meilleur résultat (score réduit à 50 pour plus de résultats)
    let artists = search_result.artists?;
    let best_artist = artists.into_iter()
        .filter(|a| a.score.unwrap_or(0) > 50)
        .next()?;

    // 2. Récupère les détails de l'artiste avec les relations (url-rels)
    let details_url = format!(
        "https://musicbrainz.org/ws/2/artist/{}?inc=url-rels&fmt=json",
        best_artist.id
    );

    // Petit délai pour respecter le rate limit de MusicBrainz (async sleep)
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let details_response = HTTP_CLIENT.get(&details_url).send().await.ok()?;
    let details: MusicBrainzArtistDetails = details_response.json().await.ok()?;

    // 3. Cherche une URL d'image dans les relations
    if let Some(relations) = details.relations {
        for relation in relations {
            if let Some(rel_type) = &relation.relation_type {
                // Cherche les relations de type "image" ou "picture"
                if rel_type == "image" || rel_type == "picture" {
                    if let Some(url) = relation.url.and_then(|u| u.resource) {
                        // Wikimedia Commons - convertit l'URL en URL d'image directe
                        if url.contains("commons.wikimedia.org") {
                            if let Some(image_data) = fetch_wikimedia_image(&url).await {
                                return Some(image_data);
                            }
                        }
                    }
                }
            }
        }
    }

    None
}

// Télécharge une image depuis Wikimedia Commons - async
async fn fetch_wikimedia_image(wikimedia_url: &str) -> Option<Vec<u8>> {
    // Extrait le nom du fichier de l'URL Wikimedia
    // Format: https://commons.wikimedia.org/wiki/File:Nom_du_fichier.jpg
    let file_name = wikimedia_url
        .split("File:")
        .nth(1)?
        .split('?')
        .next()?;

    // Utilise l'API Wikimedia pour obtenir l'URL directe de l'image (taille 500px)
    let api_url = format!(
        "https://commons.wikimedia.org/w/api.php?action=query&titles=File:{}&prop=imageinfo&iiprop=url&iiurlwidth=500&format=json",
        file_name
    );

    let response = HTTP_CLIENT.get(&api_url).send().await.ok()?;
    let json: serde_json::Value = response.json().await.ok()?;

    // Navigue dans la réponse JSON pour trouver l'URL de l'image
    let pages = json.get("query")?.get("pages")?;

    // L'ID de page est dynamique, donc on itère
    for (_page_id, page_data) in pages.as_object()? {
        if let Some(imageinfo) = page_data.get("imageinfo") {
            if let Some(first_info) = imageinfo.as_array()?.first() {
                // Préfère thumburl (redimensionné) sinon url (original)
                let image_url = first_info.get("thumburl")
                    .or_else(|| first_info.get("url"))?
                    .as_str()?;

                // Télécharge l'image
                let image_response = HTTP_CLIENT.get(image_url).send().await.ok()?;
                if image_response.status().is_success() {
                    return image_response.bytes().await.ok().map(|b| b.to_vec());
                }
            }
        }
    }

    None
}

// Encodage URL simple (évite d'ajouter une dépendance)
fn urlencoding_simple(input: &str) -> String {
    let mut result = String::new();
    for c in input.chars() {
        match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '~' => {
                result.push(c);
            }
            ' ' => result.push_str("%20"),
            _ => {
                for byte in c.to_string().as_bytes() {
                    result.push_str(&format!("%{:02X}", byte));
                }
            }
        }
    }
    result
}

// === COMMANDES TAURI ===

// Initialise les caches au démarrage (force le chargement en mémoire)
#[tauri::command]
fn init_cache() -> bool {
    // Force le chargement lazy des caches en mémoire
    drop(METADATA_CACHE.lock());
    drop(COVER_CACHE.lock());

    // IMPORTANT: Recharge le tracks cache depuis le fichier disque
    // Car il peut avoir été modifié depuis le dernier chargement (redémarrage, etc.)
    if let Ok(mut cache) = TRACKS_CACHE.lock() {
        let fresh_cache = load_tracks_cache();
        println!("[init_cache] Reloading tracks cache from disk: {} tracks found", fresh_cache.tracks.len());
        *cache = fresh_cache;
    }

    true
}

// Sauvegarde tous les caches sur disque
#[tauri::command]
fn save_all_caches() {
    // Sauvegarde toujours (plus fiable)
    if let Ok(cache) = METADATA_CACHE.lock() {
        save_metadata_cache_to_file(&cache);
    }
    if let Ok(cache) = COVER_CACHE.lock() {
        save_cover_cache_to_file(&cache);
    }
    if let Ok(cache) = INTERNET_NOT_FOUND_CACHE.lock() {
        save_internet_not_found_cache(&cache);
    }
    // Réinitialise le flag dirty
    if let Ok(mut dirty) = CACHE_DIRTY.lock() {
        *dirty = false;
    }
}

// Scanner un dossier
#[tauri::command]
fn scan_folder(path: &str) -> Vec<AudioTrack> {
    let mut files = Vec::new();

    for entry in WalkDir::new(path).follow_links(true).into_iter().filter_map(|e| e.ok()) {
        let file_path = entry.path();
        if file_path.is_file() && is_audio_file(file_path) {
            let name = file_path.file_stem()
                .and_then(|n| n.to_str())
                .unwrap_or("Unknown")
                .to_string();
            let folder = file_path.parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            files.push(AudioTrack {
                path: file_path.to_string_lossy().to_string(),
                name,
                folder,
            });
        }
    }

    files
}

// Fonction interne pour obtenir les métadonnées (utilisée par le scan parallèle)
fn get_metadata_internal(path: &str) -> Metadata {
    // Vérifie le cache mémoire d'abord
    if let Ok(cache) = METADATA_CACHE.lock() {
        if let Some(cached) = cache.entries.get(path) {
            return cached.clone();
        }
    }

    // Pas en cache, lecture depuis le fichier audio
    let file_path = Path::new(path);
    let file_name = file_path.file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or("Unknown")
        .to_string();

    let mut metadata = Metadata {
        title: file_name.clone(),
        artist: "Artiste inconnu".to_string(),
        album: "Album inconnu".to_string(),
        track: 0,
        disc: None,
        year: None,
        duration: 0.0,
        bit_depth: None,
        sample_rate: None,
        bitrate: None,
        codec: None,
    };

    if let Ok(tagged_file) = Probe::open(path).and_then(|p| p.read()) {
        let properties = tagged_file.properties();
        metadata.duration = properties.duration().as_secs_f64();
        metadata.sample_rate = properties.sample_rate();
        metadata.bit_depth = properties.bit_depth();
        metadata.bitrate = properties.audio_bitrate();

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
        }
    }

    metadata
}

// Scanner un dossier AVEC métadonnées - Version optimisée parallèle
// Retourne les tracks avec leurs métadonnées en UN SEUL appel IPC
#[tauri::command]
fn scan_folder_with_metadata(path: &str) -> Vec<TrackWithMetadata> {
    let start = std::time::Instant::now();
    println!("=== Scan starting for: {} ===", path);

    // Vérifie si le chemin existe
    let path_obj = Path::new(path);
    if !path_obj.exists() {
        println!("ERROR: Path does not exist: {}", path);
        return Vec::new();
    }
    if !path_obj.is_dir() {
        println!("ERROR: Path is not a directory: {}", path);
        return Vec::new();
    }
    println!("Path exists and is directory: {}", path);

    // 1. Collecte tous les chemins de fichiers audio (rapide, séquentiel)
    let paths: Vec<PathBuf> = WalkDir::new(path)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| {
            match e {
                Ok(entry) => Some(entry),
                Err(err) => {
                    println!("WalkDir error: {}", err);
                    None
                }
            }
        })
        .filter(|e| e.path().is_file() && is_audio_file(e.path()))
        .map(|e| e.path().to_path_buf())
        .collect();

    let file_count = paths.len();
    println!("Found {} audio files in {:?}", file_count, start.elapsed());

    // 2. Charge les métadonnées EN PARALLÈLE avec Rayon
    let parallel_start = std::time::Instant::now();
    let results: Vec<TrackWithMetadata> = paths.par_iter()
        .map(|file_path| {
            let path_str = file_path.to_string_lossy().to_string();
            let metadata = get_metadata_internal(&path_str);

            TrackWithMetadata {
                path: path_str,
                name: file_path.file_stem()
                    .and_then(|n| n.to_str())
                    .unwrap_or("Unknown")
                    .to_string(),
                folder: file_path.parent()
                    .and_then(|p| p.file_name())
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string(),
                metadata,
            }
        })
        .collect();

    println!("Metadata loaded in {:?} ({} files)", parallel_start.elapsed(), file_count);

    // 3. Met à jour le cache avec les nouvelles métadonnées
    if let Ok(mut cache) = METADATA_CACHE.lock() {
        for track in &results {
            if !cache.entries.contains_key(&track.path) {
                cache.entries.insert(track.path.clone(), track.metadata.clone());
            }
        }
    }
    if let Ok(mut dirty) = CACHE_DIRTY.lock() {
        *dirty = true;
    }

    // 4. Enregistre les dates d'ajout pour les nouvelles tracks
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    if let Ok(mut dates_cache) = ADDED_DATES_CACHE.lock() {
        let mut new_tracks = false;
        for track in &results {
            if !dates_cache.entries.contains_key(&track.path) {
                dates_cache.entries.insert(track.path.clone(), now);
                new_tracks = true;
            }
        }
        if new_tracks {
            save_added_dates_cache(&dates_cache);
        }
    }

    println!("Total scan time: {:?}", start.elapsed());
    results
}

// === COMMANDES POUR DÉMARRAGE INSTANTANÉ ===

// Charge les tracks depuis le cache (instantané)
#[tauri::command]
fn load_tracks_from_cache() -> (Vec<TrackWithMetadata>, LibraryStats) {
    if let Ok(cache) = TRACKS_CACHE.lock() {
        let stats = calculate_library_stats(&cache.tracks);
        (cache.tracks.clone(), stats)
    } else {
        (Vec::new(), LibraryStats::default())
    }
}

// Lance le scan en arrière-plan et émet des événements de progression
#[tauri::command]
fn start_background_scan(app_handle: tauri::AppHandle) {
    use tauri::Emitter;

    std::thread::spawn(move || {
        let start = std::time::Instant::now();

        // Récupère les chemins de la bibliothèque
        let config = load_config();
        let library_paths = config.library_paths;

        if library_paths.is_empty() {
            // Pas de bibliothèque configurée
            let _ = app_handle.emit("scan_complete", ScanComplete {
                stats: LibraryStats::default(),
                new_tracks: 0,
                removed_tracks: 0,
            });
            return;
        }

        // Vérifie les chemins inaccessibles AVANT le scan
        let inaccessible_paths: Vec<String> = library_paths
            .iter()
            .filter(|p| !Path::new(p).exists())
            .cloned()
            .collect();

        if !inaccessible_paths.is_empty() {
            println!("[Scan] WARNING: {} inaccessible paths detected", inaccessible_paths.len());
            for path in &inaccessible_paths {
                println!("[Scan]   - {}", path);
            }
            // Émet un événement pour notifier le frontend
            let _ = app_handle.emit("library_paths_inaccessible", inaccessible_paths.clone());
        }

        // Charge l'ancien cache pour comparaison
        let old_tracks: std::collections::HashSet<String> = {
            if let Ok(cache) = TRACKS_CACHE.lock() {
                cache.tracks.iter().map(|t| t.path.clone()).collect()
            } else {
                std::collections::HashSet::new()
            }
        };

        let mut all_tracks: Vec<TrackWithMetadata> = Vec::new();
        let mut seen_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
        let total_folders = library_paths.len();

        for (folder_idx, folder_path) in library_paths.iter().enumerate() {
            let folder_name = Path::new(folder_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(folder_path)
                .to_string();

            // Émet la progression du scan
            let _ = app_handle.emit("scan_progress", ScanProgress {
                phase: "scanning".to_string(),
                current: folder_idx + 1,
                total: total_folders,
                folder: folder_name.clone(),
            });

            // Scanne le dossier avec métadonnées
            let tracks = scan_folder_with_metadata(folder_path);
            // Déduplique par chemin de fichier
            for track in tracks {
                if seen_paths.insert(track.path.clone()) {
                    all_tracks.push(track);
                }
            }
        }

        // Calcule les différences
        let new_tracks: std::collections::HashSet<String> =
            all_tracks.iter().map(|t| t.path.clone()).collect();

        let added_count = new_tracks.difference(&old_tracks).count();
        let removed_count = old_tracks.difference(&new_tracks).count();

        // Calcule les statistiques
        let stats = calculate_library_stats(&all_tracks);

        // Sauvegarde le nouveau cache
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        if let Ok(mut cache) = TRACKS_CACHE.lock() {
            cache.tracks = all_tracks;
            cache.last_scan_timestamp = now;
            save_tracks_cache(&cache);
        }

        // Sauvegarde les autres caches
        if let Ok(cache) = METADATA_CACHE.lock() {
            save_metadata_cache_to_file(&cache);
        }

        println!("Background scan complete in {:?}: {} tracks, {} new, {} removed",
            start.elapsed(), stats.total_tracks, added_count, removed_count);

        // Émet la fin du scan
        let _ = app_handle.emit("scan_complete", ScanComplete {
            stats,
            new_tracks: added_count,
            removed_tracks: removed_count,
        });
    });
}

// Obtenir les statistiques de la bibliothèque actuelle
#[tauri::command]
fn get_library_stats() -> LibraryStats {
    if let Ok(cache) = TRACKS_CACHE.lock() {
        calculate_library_stats(&cache.tracks)
    } else {
        LibraryStats::default()
    }
}

// Obtenir les métadonnées (depuis le cache mémoire ou lecture fichier)
#[tauri::command]
fn get_metadata(path: &str) -> Metadata {
    // Vérifie le cache mémoire d'abord
    if let Ok(cache) = METADATA_CACHE.lock() {
        if let Some(cached) = cache.entries.get(path) {
            return cached.clone();
        }
    }

    // Pas en cache, lecture depuis le fichier audio
    let file_path = Path::new(path);
    let file_name = file_path.file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or("Unknown")
        .to_string();

    let mut metadata = Metadata {
        title: file_name.clone(),
        artist: "Artiste inconnu".to_string(),
        album: "Album inconnu".to_string(),
        track: 0,
        disc: None,
        year: None,
        duration: 0.0,
        bit_depth: None,
        sample_rate: None,
        bitrate: None,
        codec: None,
    };

    if let Ok(tagged_file) = Probe::open(path).and_then(|p| p.read()) {
        let properties = tagged_file.properties();
        metadata.duration = properties.duration().as_secs_f64();
        metadata.sample_rate = properties.sample_rate();
        metadata.bit_depth = properties.bit_depth();
        metadata.bitrate = properties.audio_bitrate();

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
            if let Some(year) = tag.year() {
                metadata.year = Some(year);
            }
        }
    }

    // Ajoute au cache mémoire
    if let Ok(mut cache) = METADATA_CACHE.lock() {
        cache.entries.insert(path.to_string(), metadata.clone());
    }
    if let Ok(mut dirty) = CACHE_DIRTY.lock() {
        *dirty = true;
    }

    // Enregistre la date d'ajout si c'est une nouvelle track
    if let Ok(mut dates_cache) = ADDED_DATES_CACHE.lock() {
        if !dates_cache.entries.contains_key(path) {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            dates_cache.entries.insert(path.to_string(), now);
            // Sauvegarde immédiate
            save_added_dates_cache(&dates_cache);
        }
    }

    metadata
}

// Charger tout le cache de métadonnées (pour le frontend)
#[tauri::command]
fn load_all_metadata_cache() -> HashMap<String, Metadata> {
    if let Ok(cache) = METADATA_CACHE.lock() {
        cache.entries.clone()
    } else {
        HashMap::new()
    }
}

// Charger toutes les dates d'ajout (pour le frontend)
#[tauri::command]
fn get_added_dates() -> HashMap<String, u64> {
    if let Ok(cache) = ADDED_DATES_CACHE.lock() {
        cache.entries.clone()
    } else {
        HashMap::new()
    }
}

// Obtenir la pochette (depuis le cache ou lecture fichier)
#[tauri::command]
fn get_cover(path: &str) -> Option<String> {
    let start = std::time::Instant::now();

    // Vérifie le cache mémoire des pochettes
    let cached_file = {
        if let Ok(cache) = COVER_CACHE.lock() {
            cache.entries.get(path).cloned()
        } else {
            None
        }
    };

    if let Some(cache_file) = cached_file {
        // Lit depuis le fichier cache sur disque
        if let Ok(data) = fs::read(&cache_file) {
            let mime = if cache_file.ends_with(".png") { "image/png" } else { "image/jpeg" };
            let base64 = general_purpose::STANDARD.encode(&data);
            let elapsed = start.elapsed().as_millis();
            if elapsed > 50 {
                println!("[RUST-PERF] get_cover (CACHE HIT): {}ms ({} KB) for {}",
                         elapsed, data.len()/1024, path.split('/').last().unwrap_or(path));
            }
            return Some(format!("data:{};base64,{}", mime, base64));
        }
    }

    // Pas en cache, lit depuis le fichier audio
    let probe_start = std::time::Instant::now();
    if let Ok(tagged_file) = Probe::open(path).and_then(|p| p.read()) {
        if let Some(tag) = tagged_file.primary_tag().or_else(|| tagged_file.first_tag()) {
            if let Some(picture) = tag.pictures().first() {
                let mime = match picture.mime_type() {
                    Some(MimeType::Png) => "image/png",
                    Some(MimeType::Jpeg) => "image/jpeg",
                    Some(MimeType::Gif) => "image/gif",
                    Some(MimeType::Bmp) => "image/bmp",
                    _ => "image/jpeg",
                };

                // Sauvegarde dans le dossier covers
                let cover_dir = get_cover_cache_dir();
                fs::create_dir_all(&cover_dir).ok();

                let hash = format!("{:x}", md5_hash(path));
                let ext = if mime == "image/png" { "png" } else { "jpg" };
                let cache_file = cover_dir.join(format!("{}.{}", hash, ext));

                if fs::write(&cache_file, picture.data()).is_ok() {
                    // Met à jour le cache mémoire
                    if let Ok(mut cache) = COVER_CACHE.lock() {
                        cache.entries.insert(path.to_string(), cache_file.to_string_lossy().to_string());
                    }
                    if let Ok(mut dirty) = CACHE_DIRTY.lock() {
                        *dirty = true;
                    }
                }

                let elapsed = start.elapsed().as_millis();
                let probe_time = probe_start.elapsed().as_millis();
                let size_kb = picture.data().len() / 1024;
                if elapsed > 100 {
                    println!("[RUST-PERF] get_cover (EXTRACTED): {}ms (probe: {}ms, {} KB cover) for {}",
                             elapsed, probe_time, size_kb, path.split('/').last().unwrap_or(path));
                }

                let base64 = general_purpose::STANDARD.encode(picture.data());
                return Some(format!("data:{};base64,{}", mime, base64));
            }
        }
    }

    let elapsed = start.elapsed().as_millis();
    if elapsed > 50 {
        println!("[RUST-PERF] get_cover (NO COVER): {}ms for {}", elapsed, path.split('/').last().unwrap_or(path));
    }
    None
}

// Obtenir les bytes bruts de la pochette (pour génération thumbnail)
fn get_cover_bytes_internal(path: &str) -> Option<Vec<u8>> {
    // Vérifie le cache mémoire des pochettes
    let cached_file = {
        if let Ok(cache) = COVER_CACHE.lock() {
            cache.entries.get(path).cloned()
        } else {
            None
        }
    };

    if let Some(cache_file) = cached_file {
        // Lit depuis le fichier cache sur disque
        if let Ok(data) = fs::read(&cache_file) {
            return Some(data);
        }
    }

    // Pas en cache, lit depuis le fichier audio
    if let Ok(tagged_file) = Probe::open(path).and_then(|p| p.read()) {
        if let Some(tag) = tagged_file.primary_tag().or_else(|| tagged_file.first_tag()) {
            if let Some(picture) = tag.pictures().first() {
                return Some(picture.data().to_vec());
            }
        }
    }
    None
}

// Génère un thumbnail 150x150 en JPEG (plus rapide que WebP)
fn generate_thumbnail(source_data: &[u8], thumb_path: &Path) -> Result<(), String> {
    // 1. Décoder l'image source
    let img = image::load_from_memory(source_data)
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    // 2. Redimensionner à 150x150 - Triangle est 10x plus rapide que Lanczos3
    let thumbnail = img.resize_to_fill(150, 150, FilterType::Triangle);

    // 3. Encoder en JPEG qualité 80% (beaucoup plus rapide que WebP)
    let mut buffer = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, 80);
    thumbnail.write_with_encoder(encoder)
        .map_err(|e| format!("Failed to encode JPEG: {}", e))?;

    // 4. Sauvegarder
    if let Some(parent) = thumb_path.parent() {
        fs::create_dir_all(parent).ok();
    }
    fs::write(thumb_path, buffer)
        .map_err(|e| format!("Failed to write thumbnail: {}", e))?;

    Ok(())
}

// Obtenir le thumbnail d'une pochette - VERSION NON-BLOQUANTE
// Retourne immédiatement le cache, ou None si pas en cache
// La génération se fait en arrière-plan via generate_thumbnails_batch
#[tauri::command]
fn get_cover_thumbnail(path: &str) -> Option<String> {
    let start = std::time::Instant::now();
    let hash = format!("{:x}", md5_hash(path));
    let thumb_dir = get_thumbnail_cache_dir();
    // Support ancien format .webp et nouveau format .jpg
    let thumb_path_jpg = thumb_dir.join(format!("{}_thumb.jpg", hash));
    let thumb_path_webp = thumb_dir.join(format!("{}_thumb.webp", hash));

    // Check si thumbnail existe déjà (FAST PATH - lecture seule)
    if thumb_path_jpg.exists() {
        if let Ok(data) = fs::read(&thumb_path_jpg) {
            let base64 = general_purpose::STANDARD.encode(&data);
            let elapsed = start.elapsed().as_millis();
            if elapsed > 50 {
                println!("[RUST-PERF] get_cover_thumbnail (JPG cache): {}ms for {}", elapsed, path.split('/').last().unwrap_or(path));
            }
            return Some(format!("data:image/jpeg;base64,{}", base64));
        }
    }
    // Fallback ancien format webp
    if thumb_path_webp.exists() {
        if let Ok(data) = fs::read(&thumb_path_webp) {
            let base64 = general_purpose::STANDARD.encode(&data);
            let elapsed = start.elapsed().as_millis();
            if elapsed > 50 {
                println!("[RUST-PERF] get_cover_thumbnail (WebP cache): {}ms for {}", elapsed, path.split('/').last().unwrap_or(path));
            }
            return Some(format!("data:image/webp;base64,{}", base64));
        }
    }

    // PAS EN CACHE -> retourne None immédiatement (ne bloque pas!)
    // Le frontend utilisera get_cover comme fallback
    let elapsed = start.elapsed().as_millis();
    if elapsed > 10 {
        println!("[RUST-PERF] get_cover_thumbnail (MISS): {}ms for {}", elapsed, path.split('/').last().unwrap_or(path));
    }
    None
}

// Génère les thumbnails manquants en batch (appelé après scan ou manuellement)
#[tauri::command]
fn generate_thumbnails_batch(paths: Vec<String>) -> u32 {
    let batch_start = std::time::Instant::now();
    let count = paths.len();
    println!("[RUST-PERF] generate_thumbnails_batch: starting batch of {} images", count);

    let thumb_dir = get_thumbnail_cache_dir();
    fs::create_dir_all(&thumb_dir).ok();

    let mut generated = 0u32;
    let mut skipped = 0u32;
    let mut failed = 0u32;

    for (i, path) in paths.iter().enumerate() {
        let img_start = std::time::Instant::now();
        let hash = format!("{:x}", md5_hash(path));
        let thumb_path = thumb_dir.join(format!("{}_thumb.jpg", hash));

        // Skip si déjà généré
        if thumb_path.exists() {
            skipped += 1;
            continue;
        }

        // Génère le thumbnail
        if let Some(cover_bytes) = get_cover_bytes_internal(path) {
            let bytes_len = cover_bytes.len();
            if generate_thumbnail(&cover_bytes, &thumb_path).is_ok() {
                generated += 1;
                let img_elapsed = img_start.elapsed().as_millis();
                if img_elapsed > 200 {
                    println!("[RUST-PERF]   [{}/{}] Generated in {}ms ({} KB source): {}",
                             i+1, count, img_elapsed, bytes_len/1024, path.split('/').last().unwrap_or(path));
                }
            } else {
                failed += 1;
            }
        } else {
            failed += 1;
        }
    }

    let batch_elapsed = batch_start.elapsed().as_millis();
    let avg = if generated > 0 { batch_elapsed / generated as u128 } else { 0 };
    println!("[RUST-PERF] generate_thumbnails_batch: DONE in {}ms - {} generated, {} skipped, {} failed ({}ms/image avg)",
             batch_elapsed, generated, skipped, failed, avg);

    generated
}

// Recherche une pochette sur Internet (MusicBrainz + Cover Art Archive) - async
#[tauri::command]
async fn fetch_internet_cover(artist: String, album: String) -> Option<String> {
    // Clé unique pour cet album
    let album_key = format!("{}|||{}", artist.to_lowercase(), album.to_lowercase());

    // Vérifie si déjà marqué comme "not found"
    if let Ok(cache) = INTERNET_NOT_FOUND_CACHE.lock() {
        if cache.entries.contains_key(&album_key) {
            return None;
        }
    }

    // Vérifie si déjà en cache local (pochette téléchargée)
    let cover_dir = get_cover_cache_dir();
    let hash = format!("{:x}", md5_hash(&album_key));
    let cache_file = cover_dir.join(format!("internet_{}.jpg", hash));

    if cache_file.exists() {
        if let Ok(data) = fs::read(&cache_file) {
            let base64 = general_purpose::STANDARD.encode(&data);
            return Some(format!("data:image/jpeg;base64,{}", base64));
        }
    }

    // Recherche sur Internet (async)
    if let Some(image_data) = fetch_cover_from_musicbrainz(&artist, &album).await {
        // Sauvegarde dans le cache local
        fs::create_dir_all(&cover_dir).ok();
        if fs::write(&cache_file, &image_data).is_ok() {
            let base64 = general_purpose::STANDARD.encode(&image_data);
            return Some(format!("data:image/jpeg;base64,{}", base64));
        }
    }

    // Marque comme "not found" pour ne pas refaire la recherche
    if let Ok(mut cache) = INTERNET_NOT_FOUND_CACHE.lock() {
        cache.entries.insert(album_key, true);
    }

    None
}

// Recherche une image d'artiste sur Internet (Deezer + MusicBrainz) - async
// Fallback: utilise une pochette d'album Internet, puis pochette locale
#[tauri::command]
async fn fetch_artist_image(artist: String, fallback_album: Option<String>, fallback_cover_path: Option<String>) -> Option<String> {
    // Clé unique pour cet artiste
    let artist_key = format!("artist|||{}", artist.to_lowercase());

    // PAS DE CACHE "NOT FOUND" - on réessaie toujours car Deezer est rapide

    // Vérifie si déjà en cache local (photo d'artiste téléchargée)
    let cover_dir = get_cover_cache_dir();
    let hash = format!("{:x}", md5_hash(&artist_key));
    let cache_file = cover_dir.join(format!("artist_{}.jpg", hash));

    if cache_file.exists() {
        if let Ok(data) = fs::read(&cache_file) {
            // Vérifie que le fichier n'est pas vide/corrompu
            if data.len() > 1000 {
                let base64 = general_purpose::STANDARD.encode(&data);
                return Some(format!("data:image/jpeg;base64,{}", base64));
            }
        }
    }

    // 1. Priorité: Deezer (a beaucoup de photos d'artistes) - async
    if let Some(image_data) = fetch_artist_image_from_deezer(&artist).await {
        // Sauvegarde dans le cache local
        fs::create_dir_all(&cover_dir).ok();
        if fs::write(&cache_file, &image_data).is_ok() {
            let base64 = general_purpose::STANDARD.encode(&image_data);
            return Some(format!("data:image/jpeg;base64,{}", base64));
        }
    }

    // 2. Fallback: MusicBrainz + Wikimedia (moins de photos mais plus précis) - async
    if let Some(image_data) = fetch_artist_image_from_musicbrainz(&artist).await {
        // Sauvegarde dans le cache local
        fs::create_dir_all(&cover_dir).ok();
        if fs::write(&cache_file, &image_data).is_ok() {
            let base64 = general_purpose::STANDARD.encode(&image_data);
            return Some(format!("data:image/jpeg;base64,{}", base64));
        }
    }

    // 3. Fallback: pochette d'album depuis Internet (MusicBrainz) - async
    if let Some(album) = &fallback_album {
        if let Some(image_data) = fetch_cover_from_musicbrainz(&artist, album).await {
            // Sauvegarde comme image artiste (fallback)
            fs::create_dir_all(&cover_dir).ok();
            if fs::write(&cache_file, &image_data).is_ok() {
                let base64 = general_purpose::STANDARD.encode(&image_data);
                return Some(format!("data:image/jpeg;base64,{}", base64));
            }
        }
    }

    // 4. Dernier fallback: pochette locale (déjà en cache depuis le fichier audio)
    if let Some(cover_path) = fallback_cover_path {
        // Essaie de récupérer la pochette depuis le cache local ou le fichier audio
        if let Some(cover) = get_cover(&cover_path) {
            return Some(cover);
        }
    }

    // PAS DE MARQUAGE "NOT FOUND" - permet de réessayer à chaque ouverture
    None
}

// Vider le cache
#[tauri::command]
fn clear_cache() {
    // Vide les caches mémoire
    if let Ok(mut cache) = METADATA_CACHE.lock() {
        cache.entries.clear();
    }
    if let Ok(mut cache) = COVER_CACHE.lock() {
        cache.entries.clear();
    }
    if let Ok(mut cache) = INTERNET_NOT_FOUND_CACHE.lock() {
        cache.entries.clear();
    }

    // Supprime les fichiers sur disque
    let metadata_path = get_metadata_cache_path();
    let cover_cache_path = get_data_dir().join("cover_cache.json");
    let internet_not_found_path = get_data_dir().join("internet_not_found_cache.json");
    let cover_dir = get_cover_cache_dir();

    fs::remove_file(metadata_path).ok();
    fs::remove_file(cover_cache_path).ok();
    fs::remove_file(internet_not_found_path).ok();
    fs::remove_dir_all(cover_dir).ok();
}

// Ajouter un chemin à la bibliothèque
#[tauri::command]
fn add_library_path(path: &str) {
    let mut config = load_config();
    if !config.library_paths.contains(&path.to_string()) {
        config.library_paths.push(path.to_string());
        save_config(&config);
    }
}

// Obtenir les chemins de la bibliothèque
#[tauri::command]
fn get_library_paths() -> Vec<String> {
    load_config().library_paths
}

// Dialog de sélection de dossier
#[tauri::command]
async fn select_folder(app: tauri::AppHandle) -> Option<String> {
    use std::sync::mpsc::channel;

    let (tx, rx) = channel();

    app.dialog()
        .file()
        .set_title("Choisir un dossier de musique")
        .pick_folder(move |folder_path| {
            let _ = tx.send(folder_path.map(|p| p.to_string()));
        });

    rx.recv().ok().flatten()
}

// === COMMANDES PLAYLISTS ===

// Obtenir toutes les playlists (crée "mes favoris" si nécessaire)
#[tauri::command]
fn get_playlists() -> Vec<Playlist> {
    let mut data = load_playlists();
    ensure_favorites_playlist(&mut data);
    save_playlists(&data);  // Sauvegarde si favoris a été créé
    data.playlists
}

// Créer une nouvelle playlist
#[tauri::command]
fn create_playlist(name: String) -> Playlist {
    use std::time::{SystemTime, UNIX_EPOCH};

    let mut data = load_playlists();

    let playlist = Playlist {
        id: generate_playlist_id(),
        name,
        track_paths: Vec::new(),
        created_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        is_system: false,  // Playlist utilisateur, peut être supprimée
    };

    data.playlists.push(playlist.clone());
    save_playlists(&data);

    playlist
}

// Renommer une playlist
#[tauri::command]
fn rename_playlist(id: String, new_name: String) -> bool {
    let mut data = load_playlists();

    if let Some(playlist) = data.playlists.iter_mut().find(|p| p.id == id) {
        playlist.name = new_name;
        save_playlists(&data);
        return true;
    }

    false
}

// Supprimer une playlist (impossible pour les playlists système)
#[tauri::command]
fn delete_playlist(id: String) -> bool {
    let mut data = load_playlists();

    // Empêcher la suppression des playlists système (favoris, etc.)
    if let Some(playlist) = data.playlists.iter().find(|p| p.id == id) {
        if playlist.is_system {
            return false;  // Refus de supprimer une playlist système
        }
    }

    let initial_len = data.playlists.len();
    data.playlists.retain(|p| p.id != id);

    if data.playlists.len() < initial_len {
        save_playlists(&data);
        return true;
    }

    false
}

// Ajouter un track à une playlist
#[tauri::command]
fn add_track_to_playlist(playlist_id: String, track_path: String) -> bool {
    let mut data = load_playlists();

    if let Some(playlist) = data.playlists.iter_mut().find(|p| p.id == playlist_id) {
        // Évite les doublons
        if !playlist.track_paths.contains(&track_path) {
            playlist.track_paths.push(track_path);
            save_playlists(&data);
            return true;
        }
    }

    false
}

// Retirer un track d'une playlist
#[tauri::command]
fn remove_track_from_playlist(playlist_id: String, track_path: String) -> bool {
    let mut data = load_playlists();

    if let Some(playlist) = data.playlists.iter_mut().find(|p| p.id == playlist_id) {
        let initial_len = playlist.track_paths.len();
        playlist.track_paths.retain(|p| p != &track_path);

        if playlist.track_paths.len() < initial_len {
            save_playlists(&data);
            return true;
        }
    }

    false
}

// Réordonner les tracks d'une playlist
#[tauri::command]
fn reorder_playlist_tracks(playlist_id: String, track_paths: Vec<String>) -> bool {
    let mut data = load_playlists();

    if let Some(playlist) = data.playlists.iter_mut().find(|p| p.id == playlist_id) {
        playlist.track_paths = track_paths;
        save_playlists(&data);
        return true;
    }

    false
}

// === COMMANDES FAVORIS ===

// Toggle favori : ajoute ou retire une track des favoris
// Retourne true si la track est maintenant dans les favoris, false sinon
#[tauri::command]
fn toggle_favorite(track_path: String) -> bool {
    let mut data = load_playlists();
    ensure_favorites_playlist(&mut data);

    if let Some(favorites) = data.playlists.iter_mut().find(|p| p.id == FAVORITES_PLAYLIST_ID) {
        if let Some(pos) = favorites.track_paths.iter().position(|p| p == &track_path) {
            // Retirer des favoris
            favorites.track_paths.remove(pos);
            save_playlists(&data);
            return false;
        } else {
            // Ajouter aux favoris
            favorites.track_paths.push(track_path);
            save_playlists(&data);
            return true;
        }
    }

    false
}

// Vérifie si une track est dans les favoris
#[tauri::command]
fn is_favorite(track_path: String) -> bool {
    let data = load_playlists();
    if let Some(favorites) = data.playlists.iter().find(|p| p.id == FAVORITES_PLAYLIST_ID) {
        return favorites.track_paths.contains(&track_path);
    }
    false
}

// Retourne tous les chemins des tracks favorites
#[tauri::command]
fn get_favorites() -> Vec<String> {
    let data = load_playlists();
    if let Some(favorites) = data.playlists.iter().find(|p| p.id == FAVORITES_PLAYLIST_ID) {
        return favorites.track_paths.clone();
    }
    vec![]
}

// === COMMANDES AUDIO ENGINE (Player Audiophile) ===

/// Structure pour l'état de lecture retourné au frontend
#[derive(Serialize)]
struct AudioPlaybackState {
    is_playing: bool,
    position: f64,
    duration: f64,
}

/// Joue un fichier audio (non-bloquant)
/// La durée sera envoyée via l'événement playback_progress
#[tauri::command]
fn audio_play(path: String) -> Result<(), String> {
    if let Ok(engine_guard) = AUDIO_ENGINE.lock() {
        if let Some(ref engine) = *engine_guard {
            // Envoie la commande au thread audio (non-bloquant)
            return engine.play(&path);
        }
    }
    Err("Audio engine not initialized".to_string())
}

/// Met en pause la lecture
#[tauri::command]
fn audio_pause() -> Result<(), String> {
    if let Ok(engine_guard) = AUDIO_ENGINE.lock() {
        if let Some(ref engine) = *engine_guard {
            return engine.pause();
        }
    }
    Err("Audio engine not initialized".to_string())
}

/// Reprend la lecture
#[tauri::command]
fn audio_resume() -> Result<(), String> {
    if let Ok(engine_guard) = AUDIO_ENGINE.lock() {
        if let Some(ref engine) = *engine_guard {
            return engine.resume();
        }
    }
    Err("Audio engine not initialized".to_string())
}

/// Arrête la lecture
#[tauri::command]
fn audio_stop() -> Result<(), String> {
    if let Ok(engine_guard) = AUDIO_ENGINE.lock() {
        if let Some(ref engine) = *engine_guard {
            return engine.stop();
        }
    }
    Err("Audio engine not initialized".to_string())
}

/// Seek à une position (en secondes)
#[tauri::command]
fn audio_seek(time: f64) -> Result<(), String> {
    if let Ok(engine_guard) = AUDIO_ENGINE.lock() {
        if let Some(ref engine) = *engine_guard {
            return engine.seek(time);
        }
    }
    Err("Audio engine not initialized".to_string())
}

/// Définit le volume (0.0 - 1.0)
#[tauri::command]
fn audio_set_volume(volume: f32) -> Result<(), String> {
    if let Ok(engine_guard) = AUDIO_ENGINE.lock() {
        if let Some(ref engine) = *engine_guard {
            return engine.set_volume(volume);
        }
    }
    Err("Audio engine not initialized".to_string())
}

/// Récupère l'état de lecture actuel
#[tauri::command]
fn audio_get_state() -> Result<AudioPlaybackState, String> {
    if let Ok(engine_guard) = AUDIO_ENGINE.lock() {
        if let Some(ref engine) = *engine_guard {
            return Ok(AudioPlaybackState {
                is_playing: engine.is_playing(),
                position: engine.get_position(),
                duration: engine.get_duration(),
            });
        }
    }
    Err("Audio engine not initialized".to_string())
}

/// Précharge le prochain track pour gapless playback
#[tauri::command]
fn audio_preload_next(path: String) -> Result<(), String> {
    if let Ok(engine_guard) = AUDIO_ENGINE.lock() {
        if let Some(ref engine) = *engine_guard {
            return engine.preload_next(&path);
        }
    }
    Err("Audio engine not initialized".to_string())
}

// === COMMANDES AUDIO BACKEND (Bit-Perfect, Device Control) ===

/// Liste tous les devices audio de sortie disponibles
#[tauri::command]
fn get_audio_devices() -> Result<Vec<audio::DeviceInfo>, String> {
    if let Ok(engine_guard) = AUDIO_ENGINE.lock() {
        if let Some(ref engine) = *engine_guard {
            return engine.list_devices();
        }
    }
    Err("Audio engine not initialized".to_string())
}

/// Récupère le device audio de sortie actuel
#[tauri::command]
fn get_current_audio_device() -> Result<audio::DeviceInfo, String> {
    if let Ok(engine_guard) = AUDIO_ENGINE.lock() {
        if let Some(ref engine) = *engine_guard {
            return engine.current_device();
        }
    }
    Err("Audio engine not initialized".to_string())
}

/// Change le device audio de sortie
#[tauri::command]
fn set_audio_device(device_id: String) -> Result<(), String> {
    if let Ok(engine_guard) = AUDIO_ENGINE.lock() {
        if let Some(ref engine) = *engine_guard {
            return engine.set_output_device(&device_id);
        }
    }
    Err("Audio engine not initialized".to_string())
}

/// Récupère le sample rate actuel du device
#[tauri::command]
fn get_audio_sample_rate() -> Result<u32, String> {
    if let Ok(engine_guard) = AUDIO_ENGINE.lock() {
        if let Some(ref engine) = *engine_guard {
            return engine.current_sample_rate();
        }
    }
    Err("Audio engine not initialized".to_string())
}

/// Active/désactive le mode exclusif (Hog Mode sur macOS)
/// En mode exclusif, Noir prend le contrôle total du DAC pour un playback bit-perfect
#[tauri::command]
fn set_exclusive_mode(enabled: bool) -> Result<(), String> {
    if let Ok(engine_guard) = AUDIO_ENGINE.lock() {
        if let Some(ref engine) = *engine_guard {
            return engine.set_exclusive_mode(enabled);
        }
    }
    Err("Audio engine not initialized".to_string())
}

/// Vérifie si le mode exclusif est actif
#[tauri::command]
fn is_exclusive_mode() -> Result<bool, String> {
    if let Ok(engine_guard) = AUDIO_ENGINE.lock() {
        if let Some(ref engine) = *engine_guard {
            return Ok(engine.is_exclusive_mode());
        }
    }
    Err("Audio engine not initialized".to_string())
}

// === COMMANDES HISTORIQUE D'ÉCOUTE ===

// Enregistre une lecture
#[tauri::command]
fn record_play(path: String, artist: String, album: String, title: String) {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let entry = ListeningEntry {
        path,
        artist,
        album,
        title,
        timestamp,
    };

    if let Ok(mut history) = LISTENING_HISTORY.lock() {
        // Met à jour last_played
        history.last_played = Some(entry.clone());

        // Ajoute en début de liste (plus récent en premier)
        history.entries.insert(0, entry);

        // Limite l'historique à 1000 entrées pour éviter un fichier trop gros
        if history.entries.len() > 1000 {
            history.entries.truncate(1000);
        }

        // Sauvegarde immédiatement
        save_listening_history(&history);
    }
}

// Récupère l'historique complet
#[tauri::command]
fn get_listening_history() -> ListeningHistory {
    if let Ok(history) = LISTENING_HISTORY.lock() {
        history.clone()
    } else {
        ListeningHistory::default()
    }
}

// Récupère la dernière track jouée
#[tauri::command]
fn get_last_played() -> Option<ListeningEntry> {
    if let Ok(history) = LISTENING_HISTORY.lock() {
        history.last_played.clone()
    } else {
        None
    }
}

// Récupère les tracks écoutées récemment (avec toutes les infos)
#[tauri::command]
fn get_recent_albums(days: u64) -> Vec<ListeningEntry> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let cutoff = now.saturating_sub(days * 24 * 60 * 60);

    if let Ok(history) = LISTENING_HISTORY.lock() {
        history.entries
            .iter()
            .filter(|entry| entry.timestamp >= cutoff)
            .cloned()
            .collect()
    } else {
        Vec::new()
    }
}

// Récupère tous les albums jamais écoutés (pour "À découvrir")
#[tauri::command]
fn get_all_played_albums() -> Vec<ListeningEntry> {
    if let Ok(history) = LISTENING_HISTORY.lock() {
        let mut seen_albums = std::collections::HashSet::new();
        let mut result = Vec::new();

        for entry in &history.entries {
            let album_key = format!("{} - {}", entry.artist, entry.album);
            if !entry.album.is_empty() && seen_albums.insert(album_key) {
                result.push(entry.clone());
            }
        }

        result
    } else {
        Vec::new()
    }
}

// Structure pour un artiste avec son nombre d'écoutes
#[derive(serde::Serialize, Clone)]
struct TopArtist {
    name: String,
    play_count: u32,
    // Un album de cet artiste (pour la pochette)
    sample_album: String,
    sample_path: String,
}

// Récupère les artistes les plus écoutés
#[tauri::command]
fn get_top_artists(limit: usize) -> Vec<TopArtist> {
    if let Ok(history) = LISTENING_HISTORY.lock() {
        let mut artist_counts: std::collections::HashMap<String, (u32, String, String)> = std::collections::HashMap::new();

        for entry in &history.entries {
            if !entry.artist.is_empty() && entry.artist != "Artiste inconnu" {
                let counter = artist_counts.entry(entry.artist.clone()).or_insert((0, entry.album.clone(), entry.path.clone()));
                counter.0 += 1;
            }
        }

        let mut artists: Vec<TopArtist> = artist_counts
            .into_iter()
            .map(|(name, (play_count, sample_album, sample_path))| TopArtist {
                name,
                play_count,
                sample_album,
                sample_path,
            })
            .collect();

        // Trie par nombre d'écoutes décroissant
        artists.sort_by(|a, b| b.play_count.cmp(&a.play_count));

        // Limite le nombre de résultats
        artists.truncate(limit);

        artists
    } else {
        Vec::new()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // Initialise l'Audio Engine avec l'AppHandle pour les événements
            let app_handle = app.handle().clone();
            let engine = AudioEngine::new(Some(app_handle));

            if let Ok(mut engine_guard) = AUDIO_ENGINE.lock() {
                *engine_guard = Some(engine);
            }

            println!("Audio Engine initialized!");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Cache & Metadata
            init_cache,
            save_all_caches,
            scan_folder,
            scan_folder_with_metadata,
            get_metadata,
            load_all_metadata_cache,
            get_added_dates,
            get_cover,
            get_cover_thumbnail,
            generate_thumbnails_batch,
            fetch_internet_cover,
            fetch_artist_image,
            clear_cache,
            add_library_path,
            get_library_paths,
            select_folder,
            // Playlists
            get_playlists,
            create_playlist,
            rename_playlist,
            delete_playlist,
            add_track_to_playlist,
            remove_track_from_playlist,
            reorder_playlist_tracks,
            // Favoris
            toggle_favorite,
            is_favorite,
            get_favorites,
            // Audio Engine (Player Audiophile)
            audio_play,
            audio_pause,
            audio_resume,
            audio_stop,
            audio_seek,
            audio_set_volume,
            audio_get_state,
            audio_preload_next,
            // Audio Backend (Bit-Perfect, Device Control)
            get_audio_devices,
            get_current_audio_device,
            set_audio_device,
            get_audio_sample_rate,
            set_exclusive_mode,
            is_exclusive_mode,
            // Listening History
            record_play,
            get_listening_history,
            get_last_played,
            get_recent_albums,
            get_all_played_albums,
            get_top_artists,
            // Instant Startup & Background Scan
            load_tracks_from_cache,
            start_background_scan,
            get_library_stats
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
