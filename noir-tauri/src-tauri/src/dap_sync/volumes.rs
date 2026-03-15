use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExternalVolume {
    pub name: String,
    pub path: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub is_removable: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VolumeInfo {
    pub name: String,
    pub path: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub is_mounted: bool,
}

/// Liste les volumes externes (cartes SD, clés USB, DAPs en USB mass storage).
/// Filtre les volumes réseau (SMB, NFS, AFP) et les volumes système.
pub fn list_external_volumes() -> Result<Vec<ExternalVolume>, String> {
    let volumes_dir = Path::new("/Volumes");
    if !volumes_dir.exists() {
        return Ok(vec![]);
    }

    let entries = std::fs::read_dir(volumes_dir).map_err(|e| e.to_string())?;
    let mut volumes = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip system volume
        if name == "Macintosh HD" || name == "Recovery" || name.starts_with('.') {
            continue;
        }

        let path_str = path.to_string_lossy().to_string();

        // Use diskutil to check if it's external/removable
        if !is_external_device(&path_str) {
            continue;
        }

        // Skip network mounts
        if is_network_mount(&path_str) {
            continue;
        }

        // Get space info via statvfs
        if let Some((total, free)) = get_volume_space(&path_str) {
            volumes.push(ExternalVolume {
                name: name.clone(),
                path: path_str,
                total_bytes: total,
                free_bytes: free,
                is_removable: true,
            });
        }
    }

    Ok(volumes)
}

/// Vérifie si un volume est mounted et retourne ses infos.
pub fn get_volume_info(path: &str) -> Result<VolumeInfo, String> {
    let p = Path::new(path);
    let is_mounted = p.exists() && p.is_dir();
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());

    let (total, free) = if is_mounted {
        get_volume_space(path).unwrap_or((0, 0))
    } else {
        (0, 0)
    };

    Ok(VolumeInfo {
        name,
        path: path.to_string(),
        total_bytes: total,
        free_bytes: free,
        is_mounted,
    })
}

/// Vérifie qu'un chemin est un volume externe via diskutil info.
/// Rejette les volumes internes et les montages réseau.
fn is_external_device(volume_path: &str) -> bool {
    let output = Command::new("diskutil")
        .args(["info", volume_path])
        .output();

    let output = match output {
        Ok(o) => o,
        Err(_) => return false,
    };

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Parse diskutil output for key indicators
    let mut is_internal = false;
    let mut is_removable = false;
    let mut protocol = String::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.starts_with("Internal:") {
            is_internal = line.contains("Yes");
        }
        if line.starts_with("Removable Media:") || line.starts_with("Removable:") {
            is_removable = line.contains("Removable") || line.contains("Yes");
        }
        if line.starts_with("Protocol:") {
            protocol = line.split(':').nth(1).unwrap_or("").trim().to_lowercase();
        }
    }

    // Accept if: external OR removable, AND not a disk image
    // USB, SD card, Thunderbolt external drives qualify
    if is_internal && !is_removable {
        return false;
    }

    // Reject disk images
    if protocol == "disk image" {
        return false;
    }

    true
}

/// Vérifie si un mount point est un filesystem réseau (SMB, NFS, AFP).
fn is_network_mount(volume_path: &str) -> bool {
    let output = Command::new("mount").output();
    let output = match output {
        Ok(o) => o,
        Err(_) => return false,
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if line.contains(volume_path) || line.contains(&format!(" on {} ", volume_path)) {
            let lower = line.to_lowercase();
            // Reject network filesystems
            if lower.contains("smbfs")
                || lower.contains("nfs")
                || lower.contains("afpfs")
                || lower.contains("cifs")
                || lower.contains("webdav")
                || lower.contains("ftp")
            {
                return true;
            }
        }
    }

    false
}

/// Obtient l'espace total et libre d'un volume via df.
fn get_volume_space(path: &str) -> Option<(u64, u64)> {
    let output = Command::new("df")
        .args(["-k", path])
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Skip header line, parse second line
    let data_line = stdout.lines().nth(1)?;
    let parts: Vec<&str> = data_line.split_whitespace().collect();

    // df -k output: Filesystem 1024-blocks Used Available Capacity ...
    if parts.len() >= 4 {
        let total_kb: u64 = parts[1].parse().ok()?;
        let available_kb: u64 = parts[3].parse().ok()?;
        Some((total_kb * 1024, available_kb * 1024))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_list_external_volumes_no_crash() {
        // Should not crash even if no external volumes
        let result = list_external_volumes();
        assert!(result.is_ok());
    }

    #[test]
    fn test_is_network_mount_local() {
        // /Volumes/Macintosh HD should not be a network mount
        assert!(!is_network_mount("/Volumes/Macintosh HD"));
    }

    #[test]
    fn test_get_volume_info_nonexistent() {
        let info = get_volume_info("/Volumes/NONEXISTENT_VOLUME_XYZ").unwrap();
        assert!(!info.is_mounted);
        assert_eq!(info.total_bytes, 0);
    }
}
