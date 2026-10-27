---
name: hean-audio
description: Moteur audio Hean — pipeline CoreAudio, bit-perfect, hog mode, sample rate switching, gapless, resampler, EQ, AirPlay/Bluetooth device switching, media keys souvlaki. Charger avant de toucher src-tauri/src/audio/, audio_engine.rs, audio_decoder.rs, coreaudio_*.rs, eq.rs, resampler.rs, media_controls.rs, ou la partie device/gapless de playback.js.
---

# hean-audio — moteur audio & devices

Règle de zone : quand tu travailles ici, ne touche pas à l'UI/library (et inversement). Les invariants transverses sont dans `hean-invariants`.

## Audio pipeline (end-to-end)

```
File / SmbProgressiveFile → [Symphonia decoder] → f32 interleaved
  → [Resampler FFT] (only if DAC doesn't support source rate)
  → [RingBuffer lock-free] (5s capacity, HeapRb<f32>)
  → (real-time callback thread)
  → [EQ 8-band biquad] (bypassed if all gains ≈ 0 dB)
  → [Volume] (sample × volume f32)
  → [CoreAudio HAL] (kAudioUnitSubType_HALOutput, direct to device)
  → DAC
```

- **Bit-perfect** when: no resampling + EQ off + volume 100% + hog mode on
- **Sample rate auto-switch**: `coreaudio_backend.rs` negotiates with the DAC via `kAudioDevicePropertyNominalSampleRate`
- **Hog Mode**: `kAudioDevicePropertyHogMode` in `coreaudio_backend.rs` — exclusive device access
- **Supported formats**: FLAC, WAV, AIFF, ALAC, MP3, AAC/M4A, OGG Vorbis
- **Not supported**: WMA, DSD, Opus, MQA — extensions removed from scanner

## AirPlay / Bluetooth — décisions actées

- **AirPlay / Bluetooth device handling** :
  - `kAudioDevicePropertyTransportType` identifie les devices : AirPlay (`0x61697270`), Bluetooth (`0x626C7565`), Built-in (`0x626C746E`), USB (`0x75736220`).
  - `DeviceInfo` porte `transport_type: u32` + `is_airplay: bool`. Le champ `is_airplay` est utilisé côté JS pour le badge UI, toast dédié, et blocage automatique du hog mode (incompatible AirPlay).
  - AirPlay et Bluetooth peuvent disparaître de `kAudioHardwarePropertyDevices` quand inactifs. Fix : `airplay_session_devices` (cache en session dans `CoreAudioBackend`) + réinjection dans `device_cache` même si CoreAudio les retire. `stale_airplay_ids` identifie les devices cachés non-actifs.
  - **Stratégie system default (critique pour AirPlay)** : un device AirPlay n'existe dans CoreAudio QUE tant qu'il est le défaut système macOS. Dès qu'il perd ce statut, macOS tue la session et le device disparaît du HAL — impossible de le réactiver via `set_system_default_device` (l'API accepte silencieusement mais ne fait rien). Stratégie dans `set_output_device` :
    - **→ AirPlay** : `set_system_default_device(airplay_id)` + 800ms d'attente pour activation réseau
    - **AirPlay →** non-AirPlay : **NE PAS changer le défaut système** (garde AirPlay vivant). Audio route vers le nouveau device via assignement AudioUnit explicite (`get_device_id()` retourne `Some(id)` pour les non-AirPlay)
    - **non-AirPlay → non-AirPlay** : `set_system_default_device` normalement (sync volume macOS)
  - **Routing AudioUnit AirPlay** : `get_device_id()` retourne `None` pour les devices AirPlay → l'AudioUnit utilise le défaut système (qui est AirPlay). `AudioUnitSetProperty(kAudioOutputUnitProperty_CurrentDevice)` échoue systématiquement pour AirPlay.
  - **`prepare_for_streaming` skip AirPlay** : ne change PAS le sample rate d'un device AirPlay (casse la session réseau). Retourne le rate natif (44100Hz). macOS gère le resampling AirPlay en interne.
  - **Hog mode guard Rust** : `set_exclusive_mode(Exclusive)` refuse si le device actif est AirPlay. Auto-désactivé dans `set_output_device` quand on switch vers AirPlay.
  - **Erreur AudioUnit stricte** : `coreaudio_stream.rs` retourne une erreur si `AudioUnitSetProperty(kAudioOutputUnitProperty_CurrentDevice)` échoue pour un device non-AirPlay (pas de fallback silencieux sur le mauvais device).
  - **Retry JS AirPlay** : si `audio_play` échoue sur un device AirPlay, retry automatique après 1.5s (le receiver peut être en cours d'activation).
  - **Sync polling JS** : après `set_audio_device`, lit le défaut système RÉEL via `get_system_default_device_id()` (qui peut différer du device sélectionné si AirPlay est préservé). `_lastKnownSystemDefault = actualDefault` empêche le polling de confondre la préservation AirPlay avec un changement externe.
  - **Limitation connue** : quand le défaut système est préservé sur AirPlay et l'audio joue sur built-in, la notification volume macOS affiche "AirPlay" (cosmétique — le volume fonctionne sur le bon device).
  - `_lastGoodPosition` (JS) : dernière position de lecture confirmée par `playback_progress`. Non réinitialisée par `playback_started` → survit aux restarts de stream pendant les device switches. `_seekCancelToken` empêche les seeks périmés.
