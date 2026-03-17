use notify::{Watcher, RecursiveMode, Event, EventKind};
use serde::Serialize;
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;
use tauri::Emitter;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VolumeChangeEvent {
    pub event_type: String, // "mounted" | "unmounted"
    pub volume_name: String,
    pub path: String,
}

/// Lance un watcher sur /Volumes/ qui émet des events Tauri quand un volume
/// est monté ou démonté. Tourne dans un thread dédié.
pub fn start_volume_watcher(app_handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        let (tx, rx) = mpsc::channel();

        let mut watcher = match notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        }) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[DAP Watcher] Failed to create watcher: {}", e);
                return;
            }
        };

        let volumes_path = Path::new("/Volumes");
        if let Err(e) = watcher.watch(volumes_path, RecursiveMode::NonRecursive) {
            eprintln!("[DAP Watcher] Failed to watch /Volumes: {}", e);
            return;
        }

        #[cfg(debug_assertions)]
        println!("[DAP Watcher] Watching /Volumes for mount/unmount events");

        // Track known volumes
        let mut known_volumes: std::collections::HashSet<String> = std::collections::HashSet::new();
        if let Ok(entries) = std::fs::read_dir(volumes_path) {
            for entry in entries.flatten() {
                known_volumes.insert(entry.file_name().to_string_lossy().to_string());
            }
        }

        loop {
            match rx.recv_timeout(Duration::from_secs(2)) {
                Ok(event) => {
                    match event.kind {
                        EventKind::Create(_) => {
                            for path in &event.paths {
                                if let Some(name) = path.file_name() {
                                    let name_str = name.to_string_lossy().to_string();
                                    if !known_volumes.contains(&name_str) && !name_str.starts_with('.') {
                                        known_volumes.insert(name_str.clone());
                                        // Small delay to let the volume fully mount
                                        std::thread::sleep(Duration::from_millis(500));
                                        let evt = VolumeChangeEvent {
                                            event_type: "mounted".to_string(),
                                            volume_name: name_str,
                                            path: path.to_string_lossy().to_string(),
                                        };
                                        #[cfg(debug_assertions)]
                                        println!("[DAP Watcher] Volume mounted: {}", evt.path);
                                        let _ = app_handle.emit("volume_change", evt);
                                    }
                                }
                            }
                        }
                        EventKind::Remove(_) => {
                            for path in &event.paths {
                                if let Some(name) = path.file_name() {
                                    let name_str = name.to_string_lossy().to_string();
                                    if known_volumes.remove(&name_str) {
                                        let evt = VolumeChangeEvent {
                                            event_type: "unmounted".to_string(),
                                            volume_name: name_str,
                                            path: path.to_string_lossy().to_string(),
                                        };
                                        #[cfg(debug_assertions)]
                                        println!("[DAP Watcher] Volume unmounted: {}", evt.path);
                                        let _ = app_handle.emit("volume_change", evt);
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    // Periodic check: detect volumes that appeared/disappeared without events
                    let mut current: std::collections::HashSet<String> = std::collections::HashSet::new();
                    if let Ok(entries) = std::fs::read_dir(volumes_path) {
                        for entry in entries.flatten() {
                            let name = entry.file_name().to_string_lossy().to_string();
                            if !name.starts_with('.') {
                                current.insert(name);
                            }
                        }
                    }

                    // New volumes
                    for name in current.difference(&known_volumes) {
                        let path = format!("/Volumes/{}", name);
                        let evt = VolumeChangeEvent {
                            event_type: "mounted".to_string(),
                            volume_name: name.clone(),
                            path,
                        };
                        let _ = app_handle.emit("volume_change", evt);
                    }

                    // Removed volumes
                    for name in known_volumes.difference(&current) {
                        let path = format!("/Volumes/{}", name);
                        let evt = VolumeChangeEvent {
                            event_type: "unmounted".to_string(),
                            volume_name: name.clone(),
                            path,
                        };
                        let _ = app_handle.emit("volume_change", evt);
                    }

                    known_volumes = current;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    eprintln!("[DAP Watcher] Channel disconnected, stopping");
                    break;
                }
            }
        }
    });
}
