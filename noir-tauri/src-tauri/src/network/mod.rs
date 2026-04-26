// network/mod.rs — Types partagés et exports pour le module NAS/SMB

pub mod credentials;
pub mod smb;
pub mod smb_utils;
pub mod discovery;
pub mod scanner;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// === TYPES PARTAGÉS ===

/// Source réseau configurée par l'utilisateur (NAS/SMB share)
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NetworkSource {
    pub id: String,
    pub name: String,
    pub host: String,
    pub share: String,
    pub remote_path: String,
    pub credentials: SmbCredentials,
    pub enabled: bool,
    pub last_connected: Option<u64>,
    pub last_scan: Option<u64>,
}

/// Credentials SMB (le mot de passe est dans le Keychain, pas ici)
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SmbCredentials {
    pub username: String,
    pub domain: Option<String>,
    pub is_guest: bool,
}

/// État de connexion d'une source réseau
#[derive(Serialize, Clone, Debug)]
pub enum ConnectionStatus {
    Connected,
    Disconnected { since: u64, reason: String },
    Reconnecting { attempt: u8 },
}

/// NAS découvert via mDNS/Bonjour
#[derive(Serialize, Clone, Debug)]
pub struct DiscoveredNas {
    pub hostname: String,
    pub ip: String,
    pub port: u16,
    pub display_name: String,
}

/// Share SMB listé sur un host
#[derive(Serialize, Clone, Debug)]
pub struct SmbShare {
    pub name: String,
    pub share_type: String,
}

/// Entrée dans un dossier SMB (fichier ou sous-dossier)
#[derive(Serialize, Clone, Debug)]
pub struct SmbEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
}

/// Cache de scan réseau pour le scan différentiel
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct NetworkScanCache {
    pub entries: HashMap<String, HashMap<String, NetworkFileEntry>>,
}

/// Entrée de fichier réseau dans le cache de scan
#[derive(Serialize, Deserialize, Clone)]
pub struct NetworkFileEntry {
    pub remote_path: String,
    pub size: u64,
    pub modified: u64,
    pub metadata: Option<crate::Metadata>,
}

// === PERSISTENCE ===

use std::path::PathBuf;

fn get_network_sources_path() -> PathBuf {
    crate::get_data_dir().join("network_sources.json")
}

fn get_network_scan_cache_path() -> PathBuf {
    crate::get_data_dir().join("network_scan_cache.json")
}

pub fn load_network_sources() -> Vec<NetworkSource> {
    let path = get_network_sources_path();
    if path.exists() {
        match std::fs::read_to_string(&path) {
            Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
            Err(_) => Vec::new(),
        }
    } else {
        Vec::new()
    }
}

pub fn save_network_sources(sources: &[NetworkSource]) -> Result<(), String> {
    let path = get_network_sources_path();
    let data = serde_json::to_string_pretty(sources)
        .map_err(|e| format!("Failed to serialize network sources: {}", e))?;
    crate::save_file_secure(&path, &data);
    Ok(())
}

pub fn load_network_scan_cache() -> NetworkScanCache {
    let path = get_network_scan_cache_path();
    if path.exists() {
        match std::fs::read_to_string(&path) {
            Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
            Err(_) => NetworkScanCache::default(),
        }
    } else {
        NetworkScanCache::default()
    }
}

pub fn save_network_scan_cache(cache: &NetworkScanCache) -> Result<(), String> {
    let path = get_network_scan_cache_path();
    let data = serde_json::to_string_pretty(cache)
        .map_err(|e| format!("Failed to serialize network scan cache: {}", e))?;
    crate::save_file_secure(&path, &data);
    Ok(())
}

// === HELPERS ===

/// Vérifie si un chemin est un chemin réseau SMB (smb://source_id/path)
pub fn is_network_path(path: &str) -> bool {
    path.starts_with("smb://")
}

/// Parse un chemin SMB en (source_id, remote_path)
pub fn parse_network_path(path: &str) -> Option<(String, String)> {
    if !path.starts_with("smb://") {
        return None;
    }
    let rest = &path[6..]; // après "smb://"
    if let Some(slash_pos) = rest.find('/') {
        let source_id = rest[..slash_pos].to_string();
        let remote_path = rest[slash_pos..].to_string();
        Some((source_id, remote_path))
    } else {
        Some((rest.to_string(), "/".to_string()))
    }
}
