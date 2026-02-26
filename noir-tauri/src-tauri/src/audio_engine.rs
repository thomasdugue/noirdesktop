// === AUDIO ENGINE ===
// Player audiophile avec RingBuffer lock-free et SEEKING professionnel
// Fréquence de progression : 100ms pour interpolation fluide côté frontend
// Le callback audio fait UNIQUEMENT : pop_slice() + multiplication volume
//
// PURE COREAUDIO - No CPAL dependency!
// Device management and streaming handled entirely via CoreAudio HAL.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;

use crossbeam_channel::{bounded, Receiver, Sender};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use crate::audio_decoder::{start_streaming_with_config, StreamingState};
use crate::audio::{AudioBackend, create_backend, ExclusiveMode, StreamConfig};
use crate::audio::{AudioOutputStream, AudioStreamConfig, create_audio_stream};
use crate::eq::EqSharedState;

// NOTE: Device capabilities are now obtained directly from the backend
// via backend.current_device() which returns DeviceInfo with all necessary info.

/// Sample rates standards audiophiles (for reference)
#[allow(dead_code)]
const STANDARD_SAMPLE_RATES: [u32; 8] = [44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000];

/// Trouve le meilleur sample rate de sortie pour une source donnée
/// Utilise le backend CoreAudio directement (pas CPAL)
fn find_best_output_rate_from_backend(
    source_rate: u32,
    backend: &mut Box<dyn AudioBackend>,
) -> (u32, bool) {
    #[cfg(debug_assertions)]
    println!("[Hardware] Attempting to set DAC to {}Hz...", source_rate);

    // Récupère les infos du device courant
    let current_device = match backend.current_device() {
        Ok(dev) => dev,
        Err(e) => {
            eprintln!("[Hardware] Failed to get current device: {}", e);
            return (44100, false);
        }
    };

    let supported_rates = &current_device.supported_sample_rates;
    let current_rate = current_device.current_sample_rate;

    // Vérifie si le rate source est supporté
    if supported_rates.contains(&source_rate) {
        // Tente de configurer le hardware
        let config = StreamConfig::stereo(source_rate);
        match backend.prepare_for_streaming(&config) {
            Ok(actual_rate) => {
                if actual_rate == source_rate {
                    #[cfg(debug_assertions)]
                    println!("[Hardware] SUCCESS - DAC configured at {}Hz (bit-perfect)", source_rate);
                    return (source_rate, true);
                } else {
                    #[cfg(debug_assertions)]
                    println!("[Hardware] Rate changed to {}Hz by backend", actual_rate);
                    return (actual_rate, actual_rate == source_rate);
                }
            }
            Err(e) => {
                eprintln!("[Hardware] Failed to prepare device: {}. Using fallback.", e);
            }
        }
    } else {
        #[cfg(debug_assertions)]
        println!("[Hardware] {}Hz NOT supported by device (supported: {:?})",
            source_rate, supported_rates);
    }

    #[cfg(debug_assertions)]
    println!("[Hardware] FAILED - Falling back to resampling at {}Hz", current_rate);
    (current_rate, false)
}

// Note: select_optimal_config() removed - use find_best_output_rate() directly

/// Commandes envoyées au thread audio
#[derive(Debug)]
pub enum AudioCommand {
    /// Joue un fichier (chemin, position de départ optionnelle)
    Play(String, Option<f64>),
    Pause,
    Resume,
    Stop,
    /// Seek à une position (en secondes)
    Seek(f64),
    SetVolume(f32),
    /// Précharge le prochain fichier pour gapless playback
    PreloadNext(String),
    /// Active/désactive le gapless
    SetGapless(bool),
}

/// État de lecture partagé avec le frontend
pub struct PlaybackState {
    pub is_playing: Arc<AtomicBool>,
    pub is_paused: Arc<AtomicBool>,
    pub sample_rate: Arc<AtomicU64>,
    pub channels: Arc<AtomicU64>,
    pub duration: Arc<AtomicU64>,  // Durée en millisecondes (précision)
    pub position: Arc<AtomicU64>,  // Position en millisecondes (précision)
    pub volume: Arc<AtomicU64>,    // f32 as bits
    pub is_seeking: Arc<AtomicBool>,
}

impl PlaybackState {
    pub fn new() -> Self {
        Self {
            is_playing: Arc::new(AtomicBool::new(false)),
            is_paused: Arc::new(AtomicBool::new(false)),
            sample_rate: Arc::new(AtomicU64::new(44100)),
            channels: Arc::new(AtomicU64::new(2)),
            duration: Arc::new(AtomicU64::new(0)),
            position: Arc::new(AtomicU64::new(0)),
            volume: Arc::new(AtomicU64::new(f32::to_bits(1.0) as u64)),
            is_seeking: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn set_volume(&self, vol: f32) {
        self.volume.store(f32::to_bits(vol.clamp(0.0, 1.0)) as u64, Ordering::Relaxed);
    }

    pub fn get_volume(&self) -> f32 {
        f32::from_bits(self.volume.load(Ordering::Relaxed) as u32)
    }

    pub fn get_duration_seconds(&self) -> f64 {
        self.duration.load(Ordering::Relaxed) as f64 / 1000.0
    }

    pub fn get_position_seconds(&self) -> f64 {
        self.position.load(Ordering::Relaxed) as f64 / 1000.0
    }

    pub fn set_position_ms(&self, ms: u64) {
        self.position.store(ms, Ordering::Relaxed);
    }

    pub fn set_duration_ms(&self, ms: u64) {
        self.duration.store(ms, Ordering::Relaxed);
    }
}

/// Moteur audio principal
pub struct AudioEngine {
    command_tx: Sender<AudioCommand>,
    pub state: Arc<PlaybackState>,
    _audio_thread: thread::JoinHandle<()>,
    /// Audio backend for device control (sample rate, exclusive mode)
    backend: Arc<Mutex<Box<dyn AudioBackend>>>,
    /// EQ shared state (gains atomiques partagés avec le callback audio)
    pub eq_state: EqSharedState,
}

impl AudioEngine {
    pub fn new(app_handle: Option<AppHandle>) -> Self {
        let (command_tx, command_rx) = bounded::<AudioCommand>(32);
        let state = Arc::new(PlaybackState::new());
        let state_clone = Arc::clone(&state);

        // Create audio backend for device control
        let backend: Box<dyn AudioBackend> = match create_backend() {
            Ok(b) => {
                #[cfg(debug_assertions)]
                println!("Audio backend created: {}", b.name());
                b
            }
            Err(e) => {
                eprintln!("Failed to create audio backend: {}. Using fallback.", e);
                // Fallback: create a dummy backend that does nothing
                // For now we panic since macOS should always work
                panic!("Audio backend required: {}", e);
            }
        };
        let backend = Arc::new(Mutex::new(backend));
        let backend_clone = Arc::clone(&backend);

        // EQ shared state (partagé entre le thread audio et les commandes Tauri)
        let eq_state = EqSharedState::new();
        let eq_state_clone = eq_state.clone();

        let audio_thread = thread::spawn(move || {
            Self::audio_thread_main(command_rx, state_clone, app_handle, backend_clone, eq_state_clone);
        });

        Self {
            command_tx,
            state,
            _audio_thread: audio_thread,
            backend,
            eq_state,
        }
    }

    // === Public API for device control ===

    /// List all available audio output devices (from cache)
    pub fn list_devices(&self) -> Result<Vec<crate::audio::DeviceInfo>, String> {
        self.backend
            .lock()
            .list_devices()
            .map_err(|e| e.to_string())
    }

    /// Refresh device cache from OS and return updated list
    pub fn refresh_devices(&self) -> Result<Vec<crate::audio::DeviceInfo>, String> {
        self.backend
            .lock()
            .refresh_devices()
            .map_err(|e| e.to_string())
    }

    /// Get the current output device
    pub fn current_device(&self) -> Result<crate::audio::DeviceInfo, String> {
        self.backend
            .lock()
            .current_device()
            .map_err(|e| e.to_string())
    }

    /// Set the output device by ID
    pub fn set_output_device(&self, device_id: &str) -> Result<(), String> {
        self.backend
            .lock()
            .set_output_device(device_id)
            .map_err(|e| e.to_string())
    }

    /// Set the sample rate manually
    pub fn set_sample_rate(&self, rate: u32) -> Result<(), String> {
        self.backend
            .lock()
            .set_sample_rate(rate)
            .map_err(|e| e.to_string())
    }

    /// Get current sample rate
    pub fn current_sample_rate(&self) -> Result<u32, String> {
        self.backend
            .lock()
            .current_sample_rate()
            .map_err(|e| e.to_string())
    }

    /// Enable/disable exclusive mode (Hog Mode on macOS)
    pub fn set_exclusive_mode(&self, enabled: bool) -> Result<(), String> {
        let mode = if enabled {
            ExclusiveMode::Exclusive
        } else {
            ExclusiveMode::Shared
        };
        self.backend
            .lock()
            .set_exclusive_mode(mode)
            .map_err(|e| e.to_string())
    }

    /// Check if exclusive mode is enabled
    pub fn is_exclusive_mode(&self) -> bool {
        self.backend.lock().exclusive_mode() == ExclusiveMode::Exclusive
    }

    /// Get detailed Hog Mode status
    pub fn hog_mode_status(&self) -> Result<crate::audio::HogModeStatus, String> {
        self.backend
            .lock()
            .hog_mode_status()
            .map_err(|e| e.to_string())
    }

    fn audio_thread_main(
        command_rx: Receiver<AudioCommand>,
        state: Arc<PlaybackState>,
        app_handle: Option<AppHandle>,
        backend: Arc<Mutex<Box<dyn AudioBackend>>>,
        eq_state: EqSharedState,
    ) {
        // PURE COREAUDIO - no CPAL!
        // Get device info from backend directly.

        // Get initial device info for logging
        {
            let backend_guard = backend.lock();
            match backend_guard.current_device() {
                Ok(dev) => {
                    #[cfg(debug_assertions)]
                    println!("Initial audio device: {} (ID: {})", dev.name, dev.id);
                }
                Err(e) => {
                    eprintln!("No audio output device available: {}", e);
                    return;
                }
            }
        }

        // Session streaming actuelle (pour les commandes seek/stop)
        let current_session_cmd: Arc<Mutex<Option<Sender<crate::audio_decoder::DecoderCommand>>>> =
            Arc::new(Mutex::new(None));
        // État de streaming partagé
        let current_streaming_state: Arc<Mutex<Option<Arc<StreamingState>>>> =
            Arc::new(Mutex::new(None));
        // Stream audio actuel (CoreAudio sur macOS, WASAPI sur Windows)
        let current_stream: Arc<Mutex<Option<Box<dyn AudioOutputStream>>>> = Arc::new(Mutex::new(None));
        // Chemin du fichier actuel (pour relancer après seek)
        let current_path: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        // === GAPLESS PLAYBACK ===
        // Consumer/state préchargés pour le prochain track
        use ringbuf::HeapCons;
        let next_consumer: Arc<Mutex<Option<HeapCons<f32>>>> = Arc::new(Mutex::new(None));
        let next_streaming_state: Arc<Mutex<Option<Arc<StreamingState>>>> = Arc::new(Mutex::new(None));
        let next_session_cmd: Arc<Mutex<Option<Sender<crate::audio_decoder::DecoderCommand>>>> = Arc::new(Mutex::new(None));
        let next_path: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let gapless_enabled = Arc::new(AtomicBool::new(true));

        // Rate-limiting pour les seeks (évite le flood)
        let mut last_seek_time = std::time::Instant::now();
        let mut last_seek_position: f64 = -1.0;  // Dernière position de seek (pour éviter les doublons)
        const SEEK_COOLDOWN_MS: u64 = 50;
        const SEEK_POSITION_THRESHOLD: f64 = 0.1;  // Ignore les seeks à moins de 100ms de différence

        loop {
            match command_rx.recv() {
                Ok(AudioCommand::Play(path, start_position)) => {
                    #[cfg(debug_assertions)]
                    println!("=== Starting playback: {} at {:?}s ===", path, start_position);
                    let start_time = std::time::Instant::now();

                    // Clear gapless preload (manual play cancels it)
                    *next_consumer.lock() = None;
                    *next_streaming_state.lock() = None;
                    *next_session_cmd.lock() = None;
                    *next_path.lock() = None;

                    // Reset de l'état de lecture AVANT tout
                    state.is_playing.store(false, Ordering::Relaxed);
                    state.is_paused.store(false, Ordering::Relaxed);
                    state.is_seeking.store(false, Ordering::Relaxed);
                    state.position.store(0, Ordering::Relaxed);

                    // Stop le stream précédent AVANT tout
                    {
                        let mut stream_guard = current_stream.lock();
                        if let Some(mut stream) = stream_guard.take() {
                            #[cfg(debug_assertions)]
                            println!("[AudioEngine] Stopping previous stream...");
                            let _ = stream.stop();
                            drop(stream);
                            #[cfg(debug_assertions)]
                            println!("[AudioEngine] Previous stream stopped and dropped");
                        }
                    }
                    // Stop la session précédente (décodeur)
                    {
                        let mut session_guard = current_session_cmd.lock();
                        if let Some(ref tx) = *session_guard {
                            let _ = tx.send(crate::audio_decoder::DecoderCommand::Stop);
                        }
                        *session_guard = None;
                    }
                    *current_streaming_state.lock() = None;

                    // Sauvegarde le chemin
                    *current_path.lock() = Some(path.clone());

                    // Émet loading
                    if let Some(ref app) = app_handle {
                        let _ = app.emit("playback_loading", true);
                    }

                    // 1. Probe le fichier pour obtenir le sample rate source
                    let source_info = match crate::audio_decoder::probe_audio_file(&path) {
                        Ok(info) => info,
                        Err(e) => {
                            eprintln!("Failed to probe file: {}", e);
                            if let Some(ref app) = app_handle {
                                emit_error(app, "file_probe_failed", "Fichier audio illisible ou corrompu", &e);
                                let _ = app.emit("playback_loading", false);
                            }
                            continue;
                        }
                    };

                    // 2. Get device ID from backend (PURE COREAUDIO - no CPAL)
                    let device_id = backend.lock().get_device_id();
                    {
                        let backend_guard = backend.lock();
                        match backend_guard.current_device() {
                            Ok(dev) => {
                                #[cfg(debug_assertions)]
                                println!("[AudioEngine] Using device: {} (ID: {})", dev.name, dev.id);
                            }
                            Err(e) => eprintln!("[AudioEngine] Device info unavailable: {}", e),
                        }
                    }

                    // 3. Use backend to prepare device for streaming (changes sample rate if possible)
                    let stream_config = StreamConfig::stereo(source_info.sample_rate);
                    let (optimal_rate, is_bit_perfect) = {
                        let mut backend_guard = backend.lock();
                        match backend_guard.prepare_for_streaming(&stream_config) {
                            Ok(actual_rate) => {
                                let bit_perfect = actual_rate == source_info.sample_rate;
                                #[cfg(debug_assertions)]
                                println!("[Backend] Device prepared: {} Hz (requested: {} Hz, bit-perfect: {})",
                                    actual_rate, source_info.sample_rate, bit_perfect);
                                (actual_rate, bit_perfect)
                            }
                            Err(e) => {
                                eprintln!("[Backend] Failed to prepare device: {}. Using fallback.", e);
                                // Fallback: use backend's info
                                find_best_output_rate_from_backend(source_info.sample_rate, &mut *backend_guard)
                            }
                        }
                    };

                    let needs_resampling = !is_bit_perfect;
                    let target_rate = if needs_resampling { Some(optimal_rate) } else { None };

                    #[cfg(debug_assertions)]
                    println!("Source: {}Hz, Output: {}Hz, Bit-Perfect: {}, Resampling: {}",
                        source_info.sample_rate, optimal_rate, is_bit_perfect, needs_resampling);

                    // 3. Démarre le streaming avec le source rate ET le target rate
                    let session_result = start_streaming_with_config(
                        &path,
                        start_position.unwrap_or(0.0),
                        source_info.sample_rate,  // sample rate source (de probe_audio_file)
                        target_rate,               // sample rate cible (None = bit-perfect)
                    );

                    match session_result {
                        Ok(mut session) => {
                            let init_time = start_time.elapsed();
                            #[cfg(debug_assertions)]
                            println!("Streaming session ready in {:?}", init_time);

                            // Utilise le OUTPUT sample rate (après resampling éventuel)
                            let output_sample_rate = session.state.info.output_sample_rate;
                            let source_sample_rate = session.state.info.sample_rate;
                            let channels = session.state.info.channels;
                            let duration_ms = (session.state.info.duration_seconds * 1000.0) as u64;

                            state.sample_rate.store(output_sample_rate as u64, Ordering::Relaxed);
                            state.channels.store(channels as u64, Ordering::Relaxed);
                            state.duration.store(duration_ms, Ordering::Relaxed);

                            // Position initiale
                            let initial_pos_ms = start_position.map(|p| (p * 1000.0) as u64).unwrap_or(0);
                            state.position.store(initial_pos_ms, Ordering::Relaxed);

                            // Prend le consumer (transfert de propriété)
                            let consumer = session.take_consumer();

                            if let Some(consumer) = consumer {
                                // Sauvegarde le canal de commandes et l'état
                                *current_session_cmd.lock() = Some(session.command_tx.clone());
                                *current_streaming_state.lock() = Some(Arc::clone(&session.state));

                                // Crée le stream de sortie CoreAudio (PURE COREAUDIO - no CPAL!)
                                let stream_config = AudioStreamConfig::new(output_sample_rate, channels as u16);
                                let stream_result = create_audio_stream(
                                    device_id,  // Pass device ID for direct CoreAudio routing
                                    stream_config,
                                    consumer,
                                    Arc::clone(&session.state),
                                    Arc::clone(&state.volume),
                                    Arc::clone(&state.position),
                                    Arc::clone(&state.is_playing),
                                    app_handle.clone(),
                                    session.state.info.duration_seconds,
                                    eq_state.clone(),
                                    Arc::clone(&next_consumer),
                                    Arc::clone(&next_streaming_state),
                                    Arc::clone(&gapless_enabled),
                                );

                                match stream_result {
                                    Ok(mut s) => {
                                        if let Err(e) = s.start() {
                                            eprintln!("Failed to start stream: {}", e);
                                            if let Some(ref app) = app_handle {
                                                emit_error(app, "stream_start_failed", "Erreur de lecture audio", &e);
                                            }
                                        } else {
                                            state.is_playing.store(true, Ordering::Relaxed);
                                            state.is_paused.store(false, Ordering::Relaxed);
                                            *current_stream.lock() = Some(s);
                                        #[cfg(debug_assertions)]
                                        println!("=== Playback started in {:?} ===", start_time.elapsed());

                                        // Émet les specs audio SOURCE vs OUTPUT (vraies valeurs!)
                                        if let Some(ref app) = app_handle {
                                            let source_sr = source_sample_rate;
                                            let output_sr = output_sample_rate;
                                            let specs = AudioSpecs {
                                                source_sample_rate: source_sr,
                                                source_bit_depth: session.state.info.bit_depth,
                                                source_channels: session.state.info.channels as u16,
                                                output_sample_rate: output_sr,
                                                output_channels: channels as u16,
                                                is_mismatch: source_sr != output_sr,
                                            };
                                            let _ = app.emit("playback_audio_specs", specs);
                                            println!("AudioSpecs emitted: SRC {}Hz/{}bit → OUT {}Hz (mismatch: {})",
                                                source_sr, session.state.info.bit_depth, output_sr, source_sr != output_sr);
                                        }
                                        }
                                    }
                                    Err(e) => {
                                        eprintln!("Failed to create audio stream: {}", e);
                                        if let Some(ref app) = app_handle {
                                            emit_error(app, "stream_create_failed", "Impossible de créer le flux audio", &e);
                                        }
                                    }
                                }
                            } else {
                                eprintln!("Failed to take consumer from session");
                                if let Some(ref app) = app_handle {
                                    emit_error(app, "decode_failed", "Erreur de décodage du fichier", "Consumer unavailable");
                                }
                            }

                            if let Some(ref app) = app_handle {
                                let _ = app.emit("playback_loading", false);
                            }
                        }
                        Err(e) => {
                            eprintln!("Failed to start streaming: {}", e);
                            if let Some(ref app) = app_handle {
                                emit_error(app, "decode_failed", "Erreur de décodage du fichier", &e);
                                let _ = app.emit("playback_loading", false);
                            }
                        }
                    }
                }

                Ok(AudioCommand::Pause) => {
                    if let Some(ref mut stream) = *current_stream.lock() {
                        let _ = stream.pause();
                        state.is_paused.store(true, Ordering::Relaxed);
                        // Notifie le frontend
                        if let Some(ref app) = app_handle {
                            let _ = app.emit("playback_paused", ());
                        }
                    }
                }

                Ok(AudioCommand::Resume) => {
                    if let Some(ref mut stream) = *current_stream.lock() {
                        let _ = stream.resume();
                        state.is_paused.store(false, Ordering::Relaxed);
                        // Notifie le frontend
                        if let Some(ref app) = app_handle {
                            let _ = app.emit("playback_resumed", ());
                        }
                    }
                }

                Ok(AudioCommand::Stop) => {
                    {
                        let mut stream_guard = current_stream.lock();
                        if let Some(mut stream) = stream_guard.take() {
                            println!("[AudioEngine] Stop: Stopping stream...");
                            let _ = stream.stop();
                            drop(stream);
                            println!("[AudioEngine] Stop: Stream cleanup complete");
                        }
                    }
                    {
                        let mut session_guard = current_session_cmd.lock();
                        if let Some(ref tx) = *session_guard {
                            let _ = tx.send(crate::audio_decoder::DecoderCommand::Stop);
                        }
                        *session_guard = None;
                    }
                    *current_streaming_state.lock() = None;
                    *current_path.lock() = None;
                    state.is_playing.store(false, Ordering::Relaxed);
                    state.is_paused.store(false, Ordering::Relaxed);
                    state.position.store(0, Ordering::Relaxed);
                }

                Ok(AudioCommand::Seek(time_seconds)) => {
                    // Rate-limiting : ignore les seeks trop rapprochés (< 50ms)
                    let elapsed = last_seek_time.elapsed().as_millis() as u64;
                    if elapsed < SEEK_COOLDOWN_MS {
                        println!("Engine: Seek rate-limited ({} ms since last, ignoring)", elapsed);
                        continue;
                    }

                    // Ignore les seeks à la même position (évite les doublons)
                    if (time_seconds - last_seek_position).abs() < SEEK_POSITION_THRESHOLD {
                        println!("Engine: Seek ignored (same position {:.2}s)", time_seconds);
                        continue;
                    }

                    last_seek_time = std::time::Instant::now();
                    last_seek_position = time_seconds;

                    println!("Engine: Seek request to {:.2}s", time_seconds);

                    // Vérifie si le décodage est terminé - si oui, on doit relancer la lecture
                    let decoding_complete = current_streaming_state.lock()
                        .as_ref()
                        .map(|s| s.decoding_complete.load(Ordering::Relaxed))
                        .unwrap_or(true);

                    if decoding_complete {
                        // Le décodeur est terminé, on doit relancer la lecture à cette position
                        if let Some(path) = current_path.lock().clone() {
                            println!("Engine: Decoder finished, restarting at {:.2}s", time_seconds);
                            // Relance avec Play qui gère tout le cycle de vie
                            let _ = command_rx; // Pour éviter de bloquer dans le match
                            // On va simuler un Play avec position
                            // Pour cela, on stocke la position et on continue
                            state.is_seeking.store(true, Ordering::Relaxed);
                            let target_ms = (time_seconds * 1000.0) as u64;
                            state.position.store(target_ms, Ordering::Relaxed);

                            // Stop le stream actuel
                            {
                                let mut stream_guard = current_stream.lock();
                                if let Some(mut stream) = stream_guard.take() {
                                    println!("[AudioEngine] Restart: Stopping stream...");
                                    let _ = stream.stop();
                                    drop(stream);
                                    println!("[AudioEngine] Restart: Stream cleanup complete");
                                }
                            }
                            *current_session_cmd.lock() = None;
                            *current_streaming_state.lock() = None;

                            // Redémarre à la position
                            if let Some(ref app) = app_handle {
                                let _ = app.emit("playback_loading", true);
                            }

                            // Probe pour obtenir le source rate
                            let source_info = match crate::audio_decoder::probe_audio_file(&path) {
                                Ok(info) => info,
                                Err(e) => {
                                    eprintln!("Failed to probe file: {}", e);
                                    if let Some(ref app) = app_handle {
                                        emit_error(app, "seek_failed", "Erreur lors du repositionnement", &e);
                                        let _ = app.emit("playback_loading", false);
                                    }
                                    state.is_seeking.store(false, Ordering::Relaxed);
                                    continue;
                                }
                            };

                            // Get device ID for seek restart (PURE COREAUDIO - no CPAL)
                            let device_id = backend.lock().get_device_id();

                            // Use backend to prepare device (sample rate already set, just verify)
                            let stream_config = StreamConfig::stereo(source_info.sample_rate);
                            let (optimal_rate, is_bit_perfect) = {
                                let mut backend_guard = backend.lock();
                                match backend_guard.prepare_for_streaming(&stream_config) {
                                    Ok(actual_rate) => {
                                        let bit_perfect = actual_rate == source_info.sample_rate;
                                        (actual_rate, bit_perfect)
                                    }
                                    Err(_) => {
                                        find_best_output_rate_from_backend(source_info.sample_rate, &mut *backend_guard)
                                    }
                                }
                            };
                            let target_rate = if !is_bit_perfect { Some(optimal_rate) } else { None };

                            match start_streaming_with_config(&path, time_seconds, source_info.sample_rate, target_rate) {
                                Ok(mut session) => {
                                    let output_sample_rate = session.state.info.output_sample_rate;
                                    let source_sample_rate = session.state.info.sample_rate;
                                    let channels = session.state.info.channels;
                                    let duration_ms = (session.state.info.duration_seconds * 1000.0) as u64;

                                    state.sample_rate.store(output_sample_rate as u64, Ordering::Relaxed);
                                    state.channels.store(channels as u64, Ordering::Relaxed);
                                    state.duration.store(duration_ms, Ordering::Relaxed);
                                    state.position.store(target_ms, Ordering::Relaxed);

                                    if let Some(consumer) = session.take_consumer() {
                                        *current_session_cmd.lock() = Some(session.command_tx.clone());
                                        *current_streaming_state.lock() = Some(Arc::clone(&session.state));

                                        // Crée le stream CoreAudio (PURE COREAUDIO - no CPAL)
                                        let stream_config = AudioStreamConfig::new(output_sample_rate, channels as u16);
                                        match create_audio_stream(
                                            device_id,  // Pass device ID for direct CoreAudio routing
                                            stream_config,
                                            consumer,
                                            Arc::clone(&session.state),
                                            Arc::clone(&state.volume),
                                            Arc::clone(&state.position),
                                            Arc::clone(&state.is_playing),
                                            app_handle.clone(),
                                            session.state.info.duration_seconds,
                                            eq_state.clone(),
                                            Arc::clone(&next_consumer),
                                            Arc::clone(&next_streaming_state),
                                            Arc::clone(&gapless_enabled),
                                        ) {
                                            Ok(mut s) => {
                                                if let Err(e) = s.start() {
                                                    eprintln!("Failed to restart stream: {}", e);
                                                    if let Some(ref app) = app_handle {
                                                        emit_error(app, "stream_start_failed", "Erreur de lecture audio", &e);
                                                    }
                                                } else {
                                                    state.is_playing.store(true, Ordering::Relaxed);
                                                    state.is_paused.store(false, Ordering::Relaxed);
                                                    *current_stream.lock() = Some(s);

                                                    // Émet les specs audio après seek/restart
                                                    if let Some(ref app) = app_handle {
                                                        let specs = AudioSpecs {
                                                            source_sample_rate,
                                                            source_bit_depth: session.state.info.bit_depth,
                                                            source_channels: session.state.info.channels as u16,
                                                            output_sample_rate,
                                                            output_channels: channels as u16,
                                                            is_mismatch: source_sample_rate != output_sample_rate,
                                                        };
                                                        let _ = app.emit("playback_audio_specs", specs);
                                                    }
                                                }
                                            }
                                            Err(e) => {
                                                eprintln!("Failed to create restart stream: {}", e);
                                                if let Some(ref app) = app_handle {
                                                    emit_error(app, "stream_create_failed", "Impossible de créer le flux audio", &e);
                                                }
                                            }
                                        }
                                    }
                                    if let Some(ref app) = app_handle {
                                        let _ = app.emit("playback_loading", false);
                                    }
                                }
                                Err(e) => {
                                    eprintln!("Failed to restart for seek: {}", e);
                                    if let Some(ref app) = app_handle {
                                        emit_error(app, "seek_failed", "Erreur lors du repositionnement", &e);
                                        let _ = app.emit("playback_loading", false);
                                    }
                                }
                            }
                            state.is_seeking.store(false, Ordering::Relaxed);
                            continue; // Passe à la prochaine commande
                        }
                    }

                    // Cas normal : le décodeur tourne encore
                    state.is_seeking.store(true, Ordering::Relaxed);

                    // Met à jour la position immédiatement pour le frontend
                    let target_ms = (time_seconds * 1000.0) as u64;
                    state.position.store(target_ms, Ordering::Relaxed);

                    // === CRUCIAL: Reset CoreAudio buffers for instant seek ===
                    // This flushes ~50ms of internal CoreAudio buffers that CPAL couldn't access
                    {
                        if let Some(ref mut stream) = *current_stream.lock() {
                            println!("[AudioEngine] Calling stream.reset() to flush CoreAudio buffers...");
                            if let Err(e) = stream.reset() {
                                eprintln!("[AudioEngine] stream.reset() failed: {}", e);
                            }
                        }
                    }

                    // IMPORTANT: Mettre seeking=true AVANT d'envoyer la commande pour éviter la race condition
                    // où on attend seeking mais le décodeur n'a pas encore traité la commande
                    let streaming_state_for_seek = current_streaming_state.lock().clone();
                    if let Some(ref streaming_state) = streaming_state_for_seek {
                        let target_samples = (time_seconds * streaming_state.info.sample_rate as f64
                            * streaming_state.info.channels as f64) as u64;
                        streaming_state.seek_position.store(target_samples, Ordering::Release);
                        // Marquer seeking=true ICI, pas dans le décodeur
                        streaming_state.seeking.store(true, Ordering::Release);
                        // Reset les flags de flush
                        streaming_state.flush_buffer.store(false, Ordering::Release);
                        streaming_state.flush_complete.store(false, Ordering::Release);
                        streaming_state.samples_since_seek.store(0, Ordering::Release);
                    }

                    // Émet un événement de seek pour le frontend (AVANT d'envoyer au décodeur)
                    if let Some(ref app) = app_handle {
                        let _ = app.emit("playback_seeking", time_seconds);
                    }

                    // Envoie la commande de seek au décodeur
                    // Le décodeur va: 1. demander le flush, 2. attendre le flush, 3. seek, 4. pre-fill
                    if let Some(ref tx) = *current_session_cmd.lock() {
                        if let Err(e) = tx.send(crate::audio_decoder::DecoderCommand::Seek(time_seconds)) {
                            eprintln!("Seek command failed (channel closed): {}", e);
                            state.is_seeking.store(false, Ordering::Relaxed);
                            if let Some(ref streaming_state) = streaming_state_for_seek {
                                streaming_state.seeking.store(false, Ordering::Release);
                            }
                            continue;
                        }
                    }

                    // Attend que le décodeur confirme que le seek est terminé (pre-fill atteint)
                    // Le décodeur mettra seeking=false quand le pre-fill sera atteint
                    // Timeout de 2 secondes max
                    let seek_start = std::time::Instant::now();

                    if let Some(ref streaming_state) = streaming_state_for_seek {
                        println!("Engine: Waiting for seek to complete (seeking={})...",
                            streaming_state.seeking.load(Ordering::Acquire));

                        while streaming_state.seeking.load(Ordering::Acquire) {
                            if seek_start.elapsed().as_millis() > 2000 {
                                println!("Engine: Seek timeout after 2s");
                                break;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(5));
                        }

                        println!("Engine: Seek wait complete after {:?}", seek_start.elapsed());
                    }

                    // Maintenant le seek est vraiment terminé
                    let duration_seconds = state.get_duration_seconds();
                    if let Some(ref app) = app_handle {
                        let _ = app.emit("playback_progress", PlaybackProgress {
                            position: time_seconds,
                            duration: duration_seconds,
                        });
                        println!("Engine: Seek complete, emitted progress: pos={:.2}s", time_seconds);
                    }

                    state.is_seeking.store(false, Ordering::Relaxed);
                }

                Ok(AudioCommand::SetVolume(vol)) => {
                    state.set_volume(vol);
                }

                Ok(AudioCommand::PreloadNext(path)) => {
                    if !gapless_enabled.load(Ordering::Relaxed) {
                        continue;
                    }
                    println!("[Gapless] Preloading next: {}", path);

                    // Clear previous preload
                    *next_consumer.lock() = None;
                    *next_streaming_state.lock() = None;
                    *next_session_cmd.lock() = None;

                    // Probe the file
                    let source_info = match crate::audio_decoder::probe_audio_file(&path) {
                        Ok(info) => info,
                        Err(e) => {
                            eprintln!("[Gapless] Failed to probe next file: {}", e);
                            continue;
                        }
                    };

                    // Use the CURRENT stream's output rate for the next track
                    // to avoid sample rate mismatch during gapless transition
                    let current_output_rate = state.sample_rate.load(Ordering::Relaxed) as u32;
                    let target_rate = if source_info.sample_rate != current_output_rate {
                        Some(current_output_rate)
                    } else {
                        None
                    };

                    match start_streaming_with_config(&path, 0.0, source_info.sample_rate, target_rate) {
                        Ok(mut session) => {
                            if let Some(consumer) = session.take_consumer() {
                                *next_consumer.lock() = Some(consumer);
                                *next_streaming_state.lock() = Some(Arc::clone(&session.state));
                                *next_session_cmd.lock() = Some(session.command_tx.clone());
                                *next_path.lock() = Some(path.clone());
                                println!("[Gapless] Next track preloaded: {} ({}Hz → {}Hz)",
                                    path, source_info.sample_rate, session.state.info.output_sample_rate);
                            }
                        }
                        Err(e) => {
                            eprintln!("[Gapless] Failed to preload: {}", e);
                        }
                    }
                }

                Ok(AudioCommand::SetGapless(enabled)) => {
                    gapless_enabled.store(enabled, Ordering::Relaxed);
                    if !enabled {
                        // Clear preloaded data
                        *next_consumer.lock() = None;
                        *next_streaming_state.lock() = None;
                        *next_session_cmd.lock() = None;
                        *next_path.lock() = None;
                    }
                    println!("[Gapless] {}", if enabled { "Enabled" } else { "Disabled" });
                }

                Err(_) => break,
            }
        }
    }

    // === API Publique ===

    pub fn play(&self, path: &str) -> Result<(), String> {
        self.command_tx.send(AudioCommand::Play(path.to_string(), None))
            .map_err(|e| e.to_string())
    }

    pub fn play_at(&self, path: &str, position: f64) -> Result<(), String> {
        self.command_tx.send(AudioCommand::Play(path.to_string(), Some(position)))
            .map_err(|e| e.to_string())
    }

    pub fn pause(&self) -> Result<(), String> {
        self.command_tx.send(AudioCommand::Pause)
            .map_err(|e| e.to_string())
    }

    pub fn resume(&self) -> Result<(), String> {
        self.command_tx.send(AudioCommand::Resume)
            .map_err(|e| e.to_string())
    }

    pub fn stop(&self) -> Result<(), String> {
        self.command_tx.send(AudioCommand::Stop)
            .map_err(|e| e.to_string())
    }

    pub fn seek(&self, time: f64) -> Result<(), String> {
        self.command_tx.send(AudioCommand::Seek(time))
            .map_err(|e| e.to_string())
    }

    pub fn set_volume(&self, vol: f32) -> Result<(), String> {
        self.command_tx.send(AudioCommand::SetVolume(vol))
            .map_err(|e| e.to_string())
    }

    pub fn preload_next(&self, path: &str) -> Result<(), String> {
        self.command_tx.send(AudioCommand::PreloadNext(path.to_string()))
            .map_err(|e| e.to_string())
    }

    pub fn set_gapless(&self, enabled: bool) -> Result<(), String> {
        self.command_tx.send(AudioCommand::SetGapless(enabled))
            .map_err(|e| e.to_string())
    }

    pub fn is_playing(&self) -> bool {
        self.state.is_playing.load(Ordering::Relaxed)
            && !self.state.is_paused.load(Ordering::Relaxed)
    }

    pub fn get_position(&self) -> f64 {
        self.state.get_position_seconds()
    }

    pub fn get_duration(&self) -> f64 {
        self.state.get_duration_seconds()
    }
}

#[derive(Clone, serde::Serialize)]
pub struct PlaybackProgress {
    pub position: f64,
    pub duration: f64,
}

/// Erreur de lecture structurée, envoyée au frontend via l'événement `playback_error`
#[derive(Clone, serde::Serialize)]
pub struct PlaybackError {
    pub code: String,
    pub message: String,
    pub details: String,
}

/// Émet une erreur structurée vers le frontend
pub fn emit_error(app: &AppHandle, code: &str, message: &str, details: &str) {
    let error = PlaybackError {
        code: code.to_string(),
        message: message.to_string(),
        details: details.to_string(),
    };
    eprintln!("[ERROR:{}] {} — {}", code, message, details);
    let _ = app.emit("playback_error", error);
}

/// Spécifications audio SOURCE vs OUTPUT pour le moniteur de debug
#[derive(Clone, serde::Serialize)]
pub struct AudioSpecs {
    pub source_sample_rate: u32,
    pub source_bit_depth: u8,
    pub source_channels: u16,
    pub output_sample_rate: u32,
    pub output_channels: u16,
    pub is_mismatch: bool,
}
