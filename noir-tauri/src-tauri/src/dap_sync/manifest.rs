use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncManifest {
    pub hean_version: String,
    pub last_sync: String,
    pub destination_path: String,
    pub folder_structure: String,
    pub files: Vec<SyncedFile>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncedFile {
    pub source_path: String,
    pub dest_relative_path: String,
    pub size_bytes: u64,
    pub modified_at: String,
    pub quick_hash: String,
}

const MANIFEST_FILENAME: &str = ".hean-sync.json";

/// Lit le manifest depuis le dossier destination. Retourne None si absent.
pub fn read_manifest(dest_path: &str) -> Result<Option<SyncManifest>, String> {
    let path = Path::new(dest_path).join(MANIFEST_FILENAME);
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&path).map_err(|e| format!("Failed to read manifest: {}", e))?;
    let manifest: SyncManifest =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse manifest: {}", e))?;
    Ok(Some(manifest))
}

/// Écrit le manifest dans le dossier destination.
pub fn write_manifest(dest_path: &str, manifest: &SyncManifest) -> Result<(), String> {
    let path = Path::new(dest_path).join(MANIFEST_FILENAME);
    let content =
        serde_json::to_string_pretty(manifest).map_err(|e| format!("Failed to serialize manifest: {}", e))?;
    std::fs::write(&path, content).map_err(|e| format!("Failed to write manifest: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_read_manifest_missing() {
        let result = read_manifest("/tmp/nonexistent-dir-xyz").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_manifest_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().to_string_lossy().to_string();

        let manifest = SyncManifest {
            hean_version: "1.0.0".into(),
            last_sync: "2026-03-11T12:00:00Z".into(),
            destination_path: dest.clone(),
            folder_structure: "artist_album_track".into(),
            files: vec![
                SyncedFile {
                    source_path: "/music/test.flac".into(),
                    dest_relative_path: "Artist/Album/01 - Track.flac".into(),
                    size_bytes: 50_000_000,
                    modified_at: "2026-01-01T00:00:00Z".into(),
                    quick_hash: "abc123".into(),
                },
            ],
        };

        write_manifest(&dest, &manifest).unwrap();
        let loaded = read_manifest(&dest).unwrap().unwrap();
        assert_eq!(loaded.files.len(), 1);
        assert_eq!(loaded.files[0].source_path, "/music/test.flac");
        assert_eq!(loaded.hean_version, "1.0.0");
    }

    #[test]
    fn test_manifest_empty_files() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().to_string_lossy().to_string();

        let manifest = SyncManifest {
            hean_version: "1.0.0".into(),
            last_sync: "2026-03-11T12:00:00Z".into(),
            destination_path: dest.clone(),
            folder_structure: "flat".into(),
            files: vec![],
        };

        write_manifest(&dest, &manifest).unwrap();
        let loaded = read_manifest(&dest).unwrap().unwrap();
        assert!(loaded.files.is_empty());
    }

    #[test]
    fn test_manifest_multiple_files() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().to_string_lossy().to_string();

        let files: Vec<SyncedFile> = (0..5)
            .map(|i| SyncedFile {
                source_path: format!("/music/track{}.flac", i),
                dest_relative_path: format!("Artist/Album/{:02} - Track.flac", i),
                size_bytes: 10_000_000 + i * 1_000_000,
                modified_at: format!("2026-01-0{}T00:00:00Z", i + 1),
                quick_hash: format!("hash{}", i),
            })
            .collect();

        let manifest = SyncManifest {
            hean_version: "1.0.0".into(),
            last_sync: "2026-03-11T12:00:00Z".into(),
            destination_path: dest.clone(),
            folder_structure: "artist_album_track".into(),
            files,
        };

        write_manifest(&dest, &manifest).unwrap();
        let loaded = read_manifest(&dest).unwrap().unwrap();
        assert_eq!(loaded.files.len(), 5);
    }
}
