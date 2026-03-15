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
        if remaining.is_empty() {
            format!("/Volumes/{}", share)
        } else {
            format!("/Volumes/{}/{}", share, remaining)
        }
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
}
