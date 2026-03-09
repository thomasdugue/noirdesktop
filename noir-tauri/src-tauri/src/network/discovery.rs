// network/discovery.rs — Découverte NAS via mDNS/Bonjour

use mdns_sd::{ServiceDaemon, ServiceEvent};
use super::DiscoveredNas;
use std::time::Duration;
use tauri::Emitter;

/// Service type pour SMB sur le réseau local
const SMB_SERVICE_TYPE: &str = "_smb._tcp.local.";

/// Durée de la découverte (secondes)
const DISCOVERY_TIMEOUT_SECS: u64 = 5;

/// Lance une découverte mDNS/Bonjour des NAS sur le réseau local.
/// Retourne la liste des NAS découverts après le timeout.
/// Émet des événements `nas_device_found` en temps réel via app_handle.
pub fn discover_nas_devices(
    app_handle: Option<&tauri::AppHandle>,
) -> Result<Vec<DiscoveredNas>, String> {
    let mdns = ServiceDaemon::new()
        .map_err(|e| format!("Failed to create mDNS daemon: {}", e))?;

    let receiver = mdns.browse(SMB_SERVICE_TYPE)
        .map_err(|e| format!("Failed to browse for SMB services: {}", e))?;

    let mut discovered: Vec<DiscoveredNas> = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(DISCOVERY_TIMEOUT_SECS);

    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            break;
        }

        match receiver.recv_timeout(remaining) {
            Ok(event) => {
                if let ServiceEvent::ServiceResolved(info) = event {
                    let hostname = info.get_hostname().trim_end_matches('.').to_string();

                    // Préférer IPv4 sur IPv6 (libsmbclient gère mieux l'IPv4)
                    let addresses: Vec<_> = info.get_addresses().iter().cloned().collect();
                    let ip = addresses.iter()
                        .find(|a| a.is_ipv4())
                        .or_else(|| addresses.iter().next())
                        .map(|addr| addr.to_string())
                        .unwrap_or_else(|| hostname.clone());

                    let display_name = info.get_fullname()
                        .split('.')
                        .next()
                        .unwrap_or(&hostname)
                        .trim_start_matches('_')
                        .to_string();

                    let nas = DiscoveredNas {
                        hostname: hostname.clone(),
                        ip,
                        port: info.get_port(),
                        display_name,
                    };

                    // Éviter les doublons
                    if !discovered.iter().any(|d| d.hostname == nas.hostname) {
                        #[cfg(debug_assertions)]
                        println!("[mDNS] Discovered NAS: {} ({})", nas.display_name, nas.ip);

                        // Émettre l'événement en temps réel
                        if let Some(handle) = app_handle {
                            let _ = handle.emit("nas_device_found", nas.clone());
                        }

                        discovered.push(nas);
                    }
                }
            }
            Err(_) => break, // Timeout ou déconnexion du channel
        }
    }

    // Arrêter le browsing
    let _ = mdns.stop_browse(SMB_SERVICE_TYPE);
    let _ = mdns.shutdown();

    Ok(discovered)
}
