use std::collections::HashMap;

/// Build a map of SMB URL prefixes → local mount paths by parsing `mount` output.
/// On macOS, SMB mounts appear as: //user@host/share on /Volumes/share (smbfs, ...)
pub fn build_smb_mount_map() -> HashMap<String, String> {
    let mut map = HashMap::new();
    let output = match std::process::Command::new("mount").output() {
        Ok(o) => o,
        Err(_) => return map,
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if !line.contains("smbfs") {
            continue;
        }
        // Format: //user@host/share on /mount/point (smbfs, ...)
        let on_pos = match line.find(" on ") {
            Some(p) => p,
            None => continue,
        };
        let mount_spec = &line[..on_pos]; // //user@host/share
        let after_on = &line[on_pos + 4..];
        let paren_pos = match after_on.find(" (") {
            Some(p) => p,
            None => continue,
        };
        let mount_point = &after_on[..paren_pos];

        // Extract host/share from mount_spec (strip leading // and optional user@)
        let spec = mount_spec.trim_start_matches("//");
        let host_share = if let Some(at_pos) = spec.find('@') {
            &spec[at_pos + 1..]
        } else {
            spec
        };
        // host_share = "host/share" → smb_prefix = "smb://host/share"
        let smb_prefix = format!("smb://{}", host_share);
        map.insert(smb_prefix, mount_point.to_string());
    }
    map
}

/// Extend the SMB mount map with UUID-based keys from NetworkSources.
///
/// Track paths use `smb://UUID/share/path` where UUID is the NetworkSource ID,
/// but `mount` output uses hostnames/IPs. This function creates additional
/// entries mapping `smb://UUID/share` → mount_point so resolve_smb_path
/// can find the correct mount for UUID-based paths.
pub fn extend_mount_map_with_sources(
    map: &mut HashMap<String, String>,
    sources: &[(String, String)], // Vec of (source_id, hostname)
) {
    // Collect existing hostname → mount entries
    let existing: Vec<(String, String)> = map.iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    for (source_id, hostname) in sources {
        for (smb_prefix, mount_point) in &existing {
            // Match by hostname: smb://192.168.1.100/share contains "192.168.1.100"
            // Also match by .local hostname variants
            let host_lower = hostname.to_lowercase();
            let prefix_lower = smb_prefix.to_lowercase();
            if prefix_lower.contains(&host_lower) {
                // Extract share name from the existing prefix
                // smb://192.168.1.100/music → share = "music"
                if let Some(share_start) = smb_prefix.rfind('/') {
                    let share = &smb_prefix[share_start + 1..];
                    let uuid_key = format!("smb://{}/{}", source_id, share);
                    if !map.contains_key(&uuid_key) {
                        eprintln!("[SMB] mount map: {} → {} (UUID alias for {})",
                            uuid_key, mount_point, smb_prefix);
                        map.insert(uuid_key, mount_point.clone());
                    }
                }
            }
        }
    }
}

/// Resolve an SMB URL to a local filesystem path using a pre-built mount map.
/// Non-SMB paths are returned unchanged.
pub fn resolve_smb_path(path: &str, mount_map: &HashMap<String, String>) -> String {
    if !path.starts_with("smb://") {
        return path.to_string();
    }

    // Try each known SMB mount prefix
    for (smb_prefix, mount_point) in mount_map {
        if path.starts_with(smb_prefix.as_str()) {
            let remaining = &path[smb_prefix.len()..];
            return if remaining.is_empty() || remaining == "/" {
                mount_point.clone()
            } else {
                let trimmed = remaining.trim_start_matches('/');
                format!("{}/{}", mount_point, trimmed)
            };
        }
    }

    // Fallback: parse URL and try /Volumes/share/path
    let without_scheme = &path[6..]; // strip "smb://"
    let parts: Vec<&str> = without_scheme.splitn(3, '/').collect();
    if parts.len() >= 2 {
        let share = parts[1];
        let remaining = if parts.len() == 3 { parts[2] } else { "" };
        let resolved = if remaining.is_empty() {
            format!("/Volumes/{}", share)
        } else {
            format!("/Volumes/{}/{}", share, remaining)
        };
        // Log once per session to aid debugging — only log if path doesn't exist
        if !std::path::Path::new(&resolved).exists() {
            eprintln!("[SMB] FALLBACK resolution failed: {} → {} (file not found)", path, resolved);
            // Try alternate mount points: /Volumes/{share} 1, /Volumes/{share} 2, etc.
            for suffix in 1..=5 {
                let alt = if remaining.is_empty() {
                    format!("/Volumes/{} {}", share, suffix)
                } else {
                    format!("/Volumes/{} {}/{}", share, suffix, remaining)
                };
                if std::path::Path::new(&alt).exists() {
                    eprintln!("[SMB] FALLBACK found alternate: {}", alt);
                    return alt;
                }
            }
        }
        resolved
    } else {
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_non_smb_passthrough() {
        let map = HashMap::new();
        assert_eq!(
            resolve_smb_path("/local/path/file.flac", &map),
            "/local/path/file.flac"
        );
    }

    #[test]
    fn test_resolve_smb_with_map() {
        let mut map = HashMap::new();
        map.insert("smb://nas/music".into(), "/Volumes/music".into());
        assert_eq!(
            resolve_smb_path("smb://nas/music/album/track.flac", &map),
            "/Volumes/music/album/track.flac"
        );
    }

    #[test]
    fn test_resolve_smb_fallback_volumes() {
        let map = HashMap::new();
        assert_eq!(
            resolve_smb_path("smb://nas/music/album/track.flac", &map),
            "/Volumes/music/album/track.flac"
        );
    }

    #[test]
    fn test_extend_mount_map_with_sources_uuid() {
        let mut map = HashMap::new();
        map.insert("smb://192.168.1.100/music".to_string(), "/Volumes/music".to_string());

        let sources = vec![
            ("4215ec2a-b5d2-4e93-8bbf-1f697590c73d".to_string(), "192.168.1.100".to_string()),
        ];
        extend_mount_map_with_sources(&mut map, &sources);

        assert_eq!(
            resolve_smb_path(
                "smb://4215ec2a-b5d2-4e93-8bbf-1f697590c73d/music/LOSSLESS/track.flac",
                &map
            ),
            "/Volumes/music/LOSSLESS/track.flac"
        );
    }

    #[test]
    fn test_extend_mount_map_no_duplicate() {
        let mut map = HashMap::new();
        map.insert("smb://nas.local/music".to_string(), "/Volumes/music".to_string());

        let sources = vec![
            ("uuid-1".to_string(), "nas.local".to_string()),
        ];
        extend_mount_map_with_sources(&mut map, &sources);

        // UUID key should be added
        assert!(map.contains_key("smb://uuid-1/music"));
        // Original should still exist
        assert!(map.contains_key("smb://nas.local/music"));
    }
}
