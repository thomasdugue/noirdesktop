// media_controls.rs — Intégration MPRemoteCommandCenter (macOS)
//
// Sur macOS, les media keys (F7/F8/F9 ou touches multimédia clavier) sont routées
// vers l'application qui "possède" MPRemoteCommandCenter (la dernière à s'être
// enregistrée). Apple Music se déclare propriétaire au démarrage, ce qui fait que
// les media keys lui sont envoyées même quand Noir est au premier plan.
//
// Ce module utilise la crate `souvlaki` pour enregistrer Noir comme propriétaire
// de MPRemoteCommandCenter. Quand Noir s'enregistre, il reçoit les évènements
// Play/Pause/Next/Previous via GCD callback → émission d'un event Tauri `media-control`
// → module shortcuts.js gère l'action côté JS.
//
// SAFETY : MediaControls sur macOS est implémenté via MPRemoteCommandCenter qui
// utilise GCD dispatch queue en interne. Bien que Rust marque la struct comme !Send
// (car elle contient des raw pointers ObjC), les callbacks sont dispatchés par GCD
// sur la main queue — thread-safe par design macOS. Le unsafe Send wrapper est
// justifié dans ce contexte natif macOS.

use once_cell::sync::Lazy;
use std::sync::Mutex;
use tauri::AppHandle;
use tauri::Emitter;

#[cfg(target_os = "macos")]
use souvlaki::{MediaControls, MediaControlEvent, MediaMetadata, MediaPlayback, PlatformConfig};

// Wrapper pour contourner !Send (justifié — voir commentaire en haut de fichier)
#[cfg(target_os = "macos")]
struct MediaControlsWrapper(MediaControls);

#[cfg(target_os = "macos")]
// SAFETY : MPRemoteCommandCenter utilise GCD (thread-safe par design macOS)
unsafe impl Send for MediaControlsWrapper {}

#[cfg(target_os = "macos")]
static MEDIA_CONTROLS: Lazy<Mutex<Option<MediaControlsWrapper>>> = Lazy::new(|| Mutex::new(None));

/// Initialise MPRemoteCommandCenter et enregistre Noir comme lecteur multimédia actif.
/// À appeler depuis le setup Tauri (une seule fois au démarrage).
#[cfg(target_os = "macos")]
pub fn init_media_controls(app_handle: AppHandle) {
    let config = PlatformConfig {
        display_name: "Noir",
        dbus_name: "noir_desktop",
        hwnd: None,
    };

    match MediaControls::new(config) {
        Ok(mut controls) => {
            let handle = app_handle.clone();
            if let Err(e) = controls.attach(move |event| {
                let action = match event {
                    MediaControlEvent::Play     => "play",
                    MediaControlEvent::Pause    => "pause",
                    MediaControlEvent::Toggle   => "toggle",
                    MediaControlEvent::Next     => "next",
                    MediaControlEvent::Previous => "previous",
                    MediaControlEvent::Stop     => "stop",
                    _                           => return,
                };
                let _ = handle.emit("media-control", action);
            }) {
                eprintln!("[MediaControls] attach() failed: {:?}", e);
                return;
            }

            // Déclarer comme arrêté au démarrage
            let _ = controls.set_playback(MediaPlayback::Stopped);

            match MEDIA_CONTROLS.lock() {
                Ok(mut guard) => {
                    *guard = Some(MediaControlsWrapper(controls));
                    println!("[MediaControls] MPRemoteCommandCenter registered — media keys will route to Noir");
                }
                Err(e) => eprintln!("[MediaControls] Mutex poisoned: {:?}", e),
            }
        }
        Err(e) => {
            eprintln!("[MediaControls] Failed to create MediaControls: {:?}", e);
        }
    }
}

/// Met à jour les métadonnées affichées dans le Centre de contrôle / lock screen.
/// Appeler à chaque changement de track.
#[cfg(target_os = "macos")]
pub fn update_metadata(title: &str, artist: &str, album: &str) {
    if let Ok(mut guard) = MEDIA_CONTROLS.lock() {
        if let Some(ref mut wrapper) = *guard {
            let _ = wrapper.0.set_metadata(MediaMetadata {
                title: Some(title),
                artist: Some(artist),
                album: Some(album),
                ..Default::default()
            });
        }
    }
}

/// Met à jour l'état play/pause dans MPNowPlayingInfoCenter.
#[cfg(target_os = "macos")]
pub fn update_playback_state(is_playing: bool) {
    if let Ok(mut guard) = MEDIA_CONTROLS.lock() {
        if let Some(ref mut wrapper) = *guard {
            let playback = if is_playing {
                MediaPlayback::Playing { progress: None }
            } else {
                MediaPlayback::Paused { progress: None }
            };
            let _ = wrapper.0.set_playback(playback);
        }
    }
}

/// Réinitialise l'état (stopped) quand aucune track n'est active.
#[cfg(target_os = "macos")]
pub fn clear_playback_state() {
    if let Ok(mut guard) = MEDIA_CONTROLS.lock() {
        if let Some(ref mut wrapper) = *guard {
            let _ = wrapper.0.set_playback(MediaPlayback::Stopped);
        }
    }
}

// Stubs no-op pour les plateformes non-macOS (permet la compilation cross-platform)
#[cfg(not(target_os = "macos"))]
pub fn init_media_controls(_app_handle: AppHandle) {}

#[cfg(not(target_os = "macos"))]
pub fn update_metadata(_title: &str, _artist: &str, _album: &str) {}

#[cfg(not(target_os = "macos"))]
pub fn update_playback_state(_is_playing: bool) {}

#[cfg(not(target_os = "macos"))]
pub fn clear_playback_state() {}
