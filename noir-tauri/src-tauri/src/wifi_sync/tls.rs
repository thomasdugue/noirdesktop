// wifi_sync/tls.rs — Self-signed certificate generation/persistence for HTTPS server
//
// Generates a self-signed cert via rcgen on first launch and stores it in
// ~/.local/share/noir/wifi_sync_cert/{cert.pem,key.pem}. Subsequent launches
// reuse the same cert so the user doesn't have to "trust" a new cert each
// time the app starts.
//
// SAN list: hean.local, localhost, 127.0.0.1, ::1, and the current LAN IP
// (best-effort — if detection fails we still ship the static names).

use std::fs;
use std::path::PathBuf;

use crate::{get_data_dir, save_file_secure};

/// Directory holding the persisted cert + private key.
fn cert_dir() -> PathBuf {
    get_data_dir().join("wifi_sync_cert")
}

fn cert_path() -> PathBuf {
    cert_dir().join("cert.pem")
}

fn key_path() -> PathBuf {
    cert_dir().join("key.pem")
}

/// Ensure a self-signed cert + key exist on disk and return their paths.
///
/// On first run: generate via `rcgen::generate_simple_self_signed` with all
/// likely SANs and persist to disk (cert world-readable, key 0600).
///
/// On subsequent runs: reuse the existing files so the OS-level trust prompt
/// (or scary browser warning) only happens once per install.
pub fn ensure_cert() -> Result<(PathBuf, PathBuf), String> {
    let cp = cert_path();
    let kp = key_path();

    if cp.exists() && kp.exists() {
        #[cfg(debug_assertions)]
        println!("[WiFi Sync TLS] Reusing existing cert at {:?}", cp);
        return Ok((cp, kp));
    }

    // First run — generate.
    let dir = cert_dir();
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create cert dir: {}", e))?;

    let mut sans: Vec<String> = vec![
        "hean.local".to_string(),
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
    ];

    // Best-effort: append the current LAN IP so DAP browsers that
    // resolve hean.local to the IP don't get a SAN mismatch.
    if let Ok(ip) = super::get_local_ip() {
        if !sans.iter().any(|s| s == &ip) {
            sans.push(ip);
        }
    }

    #[cfg(debug_assertions)]
    println!("[WiFi Sync TLS] Generating new self-signed cert with SANs: {:?}", sans);

    let certified = rcgen::generate_simple_self_signed(sans)
        .map_err(|e| format!("rcgen failed: {}", e))?;

    let cert_pem = certified.cert.pem();
    let key_pem = certified.key_pair.serialize_pem();

    // Cert is public material — plain write is fine.
    fs::write(&cp, cert_pem.as_bytes())
        .map_err(|e| format!("Failed to write cert.pem: {}", e))?;

    // Private key — 0600 via the existing helper.
    save_file_secure(&kp, &key_pem);

    #[cfg(debug_assertions)]
    println!("[WiFi Sync TLS] Cert persisted to {:?}", cp);

    Ok((cp, kp))
}
