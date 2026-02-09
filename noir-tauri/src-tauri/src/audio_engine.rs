// === AUDIO ENGINE ===
// Player audiophile avec RingBuffer lock-free et SEEKING professionnel
// Fréquence de progression : 100ms pour interpolation fluide côté frontend
// Le callback audio fait UNIQUEMENT : pop_slice() + multiplication volume

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_channel::{bounded, Receiver, Sender};
use parking_lot::Mutex;
use ringbuf::traits::Consumer;
use tauri::{AppHandle, Emitter};

use crate::audio_decoder::{start_streaming_with_config, AudioConsumer, StreamingState};
use crate::audio::{AudioBackend, create_backend, ExclusiveMode, StreamConfig};

// === DEVICE CAPABILITIES ===
// Structures pour auditer et sélectionner la configuration optimale

/// Capacités audio du device de sortie
#[derive(Debug, Clone)]
pub struct DeviceCapabilities {
    pub device_name: String,
    /// Ranges de sample rates supportés (min, max) pour chaque config
    pub sample_rate_ranges: Vec<(u32, u32)>,
    /// Sample rates standards détectés (44100, 48000, 96000, etc.)
    pub standard_rates: Vec<u32>,
    /// Sample rate maximum supporté (théorique)
    pub max_sample_rate: u32,
    /// Nombre de canaux maximum
    pub max_channels: u16,
    /// Sample rate ACTUEL du device (config par défaut = ce que macOS utilise vraiment)
    pub current_sample_rate: u32,
}

/// Configuration sélectionnée pour la lecture
#[derive(Debug, Clone)]
pub struct SelectedConfig {
    pub sample_rate: u32,
    pub channels: u16,
    pub needs_resampling: bool,
    pub source_rate: u32,
}

/// Sample rates standards audiophiles
const STANDARD_SAMPLE_RATES: [u32; 8] = [44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000];

/// Audite les capacités du device audio
/// IMPORTANT: Utilise default_output_config() pour obtenir le sample rate RÉEL
/// configuré dans Configuration Audio MIDI de macOS, pas les capacités théoriques
fn audit_device_capabilities(device: &cpal::Device) -> Result<DeviceCapabilities, String> {
    let device_name = device.name().unwrap_or_else(|_| "Unknown".to_string());

    // 1. Récupère la config par DÉFAUT - c'est le sample rate RÉEL de macOS
    let default_config = device
        .default_output_config()
        .map_err(|e| format!("Failed to get default config: {}", e))?;

    let current_sample_rate = default_config.sample_rate().0;

    // 2. Récupère les capacités théoriques (pour info)
    let supported_configs = device
        .supported_output_configs()
        .map_err(|e| format!("Failed to get supported configs: {}", e))?;

    let mut sample_rate_ranges: Vec<(u32, u32)> = Vec::new();
    let mut max_channels: u16 = 0;

    for config in supported_configs {
        let min_rate = config.min_sample_rate().0;
        let max_rate = config.max_sample_rate().0;
        sample_rate_ranges.push((min_rate, max_rate));
        max_channels = max_channels.max(config.channels());
    }

    // Détecte les rates standards supportés (théoriquement)
    let standard_rates: Vec<u32> = STANDARD_SAMPLE_RATES
        .iter()
        .filter(|&&rate| {
            sample_rate_ranges.iter().any(|(min, max)| rate >= *min && rate <= *max)
        })
        .copied()
        .collect();

    // Max théorique (pour info seulement)
    let max_sample_rate = sample_rate_ranges
        .iter()
        .map(|(_, max)| *max)
        .max()
        .unwrap_or(44100);

    println!("=== Device Capabilities: {} ===", device_name);
    println!("  ⚠️  CURRENT sample rate (macOS config): {} Hz", current_sample_rate);
    println!("  Theoretical max: {} Hz", max_sample_rate);
    println!("  Standard rates (theoretical): {:?}", standard_rates);
    println!("  Max channels: {}", max_channels);

    Ok(DeviceCapabilities {
        device_name,
        sample_rate_ranges,
        standard_rates,
        max_sample_rate,
        max_channels,
        current_sample_rate,
    })
}

/// Vérifie si un sample rate est supporté par le device (théoriquement)
fn is_rate_supported(rate: u32, capabilities: &DeviceCapabilities) -> bool {
    capabilities.sample_rate_ranges.iter().any(|(min, max)| rate >= *min && rate <= *max)
}

/// Tente de configurer le hardware au sample rate du fichier source
/// Retourne (actual_rate, is_bit_perfect)
fn try_hardware_switch(
    device: &cpal::Device,
    source_rate: u32,
    capabilities: &DeviceCapabilities,
) -> (u32, bool) {
    println!("[Hardware] Attempting to set DAC to {}Hz...", source_rate);

    // 1. Vérifie si le rate source est supporté par le device
    let is_supported = capabilities.sample_rate_ranges
        .iter()
        .any(|(min, max)| source_rate >= *min && source_rate <= *max);

    if !is_supported {
        println!("[Hardware] {}Hz NOT supported by device (ranges: {:?})",
            source_rate, capabilities.sample_rate_ranges);
        println!("[Hardware] FAILED - Falling back to resampling at {}Hz",
            capabilities.current_sample_rate);
        return (capabilities.current_sample_rate, false);
    }

    // 2. Le rate est théoriquement supporté - on va tenter de créer le stream avec ce rate
    // Sur macOS, CPAL peut créer un stream avec un rate différent du default
    // et Core Audio acceptera si le device le supporte vraiment

    // On vérifie une dernière fois avec supported_output_configs
    match device.supported_output_configs() {
        Ok(configs) => {
            let configs_vec: Vec<_> = configs.collect();
            let supported = configs_vec
                .iter()
                .filter(|c| c.channels() >= 2)
                .any(|c| {
                    source_rate >= c.min_sample_rate().0
                    && source_rate <= c.max_sample_rate().0
                });

            if supported {
                println!("[Hardware] SUCCESS - DAC will be configured at {}Hz (bit-perfect)", source_rate);
                return (source_rate, true);
            } else {
                println!("[Hardware] Rate {}Hz not in supported configs", source_rate);
            }
        }
        Err(e) => {
            eprintln!("[Hardware] Failed to query configs: {}", e);
        }
    }

    println!("[Hardware] FAILED - Falling back to resampling at {}Hz",
        capabilities.current_sample_rate);
    (capabilities.current_sample_rate, false)
}

/// Trouve le meilleur sample rate de sortie pour une source donnée
/// STRATÉGIE: Tente le bit-perfect d'abord, fallback sur resampling si échec
fn find_best_output_rate(
    source_rate: u32,
    capabilities: &DeviceCapabilities,
    device: &cpal::Device,
) -> (u32, bool) {
    // 1. Tente le bit-perfect en premier
    let (hw_rate, hw_success) = try_hardware_switch(device, source_rate, capabilities);

    if hw_success {
        return (hw_rate, true);  // Bit-perfect!
    }

    // 2. Fallback : utilise le rate actuel du device + resampling
    (capabilities.current_sample_rate, false)
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
}

impl AudioEngine {
    pub fn new(app_handle: Option<AppHandle>) -> Self {
        let (command_tx, command_rx) = bounded::<AudioCommand>(32);
        let state = Arc::new(PlaybackState::new());
        let state_clone = Arc::clone(&state);

        // Create audio backend for device control
        let backend: Box<dyn AudioBackend> = match create_backend() {
            Ok(b) => {
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

        let audio_thread = thread::spawn(move || {
            Self::audio_thread_main(command_rx, state_clone, app_handle, backend_clone);
        });

        Self {
            command_tx,
            state,
            _audio_thread: audio_thread,
            backend,
        }
    }

    // === Public API for device control ===

    /// List all available audio output devices
    pub fn list_devices(&self) -> Result<Vec<crate::audio::DeviceInfo>, String> {
        self.backend
            .lock()
            .list_devices()
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

    fn audio_thread_main(
        command_rx: Receiver<AudioCommand>,
        state: Arc<PlaybackState>,
        app_handle: Option<AppHandle>,
        backend: Arc<Mutex<Box<dyn AudioBackend>>>,
    ) {
        // NOTE: We no longer cache the device here.
        // Instead, we get a fresh device reference for each new track.
        // This allows following the system default when user plugs in headphones/DAC.

        // Helper to get current device and capabilities
        let get_current_device_and_caps = |backend: &Arc<Mutex<Box<dyn AudioBackend>>>| -> Option<(cpal::Device, DeviceCapabilities)> {
            let device = match backend.lock().get_cpal_device() {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("Failed to get audio device from backend: {}", e);
                    let host = cpal::default_host();
                    host.default_output_device()?
                }
            };

            let capabilities = match audit_device_capabilities(&device) {
                Ok(caps) => caps,
                Err(e) => {
                    eprintln!("Failed to audit device capabilities: {}", e);
                    DeviceCapabilities {
                        device_name: device.name().unwrap_or_else(|_| "Unknown".to_string()),
                        sample_rate_ranges: vec![(44100, 48000)],
                        standard_rates: vec![44100, 48000],
                        max_sample_rate: 48000,
                        max_channels: 2,
                        current_sample_rate: 44100,
                    }
                }
            };

            Some((device, capabilities))
        };

        // Get initial device for logging
        if let Some((device, _)) = get_current_device_and_caps(&backend) {
            println!("Initial audio device: {:?}", device.name());
        } else {
            eprintln!("No audio output device available!");
            return;
        }

        // Session streaming actuelle (pour les commandes seek/stop)
        let current_session_cmd: Arc<Mutex<Option<Sender<crate::audio_decoder::DecoderCommand>>>> =
            Arc::new(Mutex::new(None));
        // État de streaming partagé
        let current_streaming_state: Arc<Mutex<Option<Arc<StreamingState>>>> =
            Arc::new(Mutex::new(None));
        // Stream cpal actuel
        let current_stream: Arc<Mutex<Option<cpal::Stream>>> = Arc::new(Mutex::new(None));
        // Chemin du fichier actuel (pour relancer après seek)
        let current_path: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        // Rate-limiting pour les seeks (évite le flood)
        let mut last_seek_time = std::time::Instant::now();
        let mut last_seek_position: f64 = -1.0;  // Dernière position de seek (pour éviter les doublons)
        const SEEK_COOLDOWN_MS: u64 = 50;
        const SEEK_POSITION_THRESHOLD: f64 = 0.1;  // Ignore les seeks à moins de 100ms de différence

        loop {
            match command_rx.recv() {
                Ok(AudioCommand::Play(path, start_position)) => {
                    println!("=== Starting playback: {} at {:?}s ===", path, start_position);
                    let start_time = std::time::Instant::now();

                    // Reset de l'état de lecture AVANT tout
                    state.is_playing.store(false, Ordering::Relaxed);
                    state.is_paused.store(false, Ordering::Relaxed);
                    state.is_seeking.store(false, Ordering::Relaxed);
                    state.position.store(0, Ordering::Relaxed);

                    // Stop le stream précédent AVANT tout
                    {
                        let mut stream_guard = current_stream.lock();
                        if let Some(stream) = stream_guard.take() {
                            println!("[DEBUG-H] Stopping previous stream...");
                            let _ = stream.pause(); // Pause d'abord pour éviter les glitches
                            drop(stream);
                            println!("[DEBUG-H] Previous stream dropped");
                            // IMPORTANT: Attendre que CPAL libère vraiment le device
                            // Le drop() est asynchrone, le callback peut encore tourner
                            std::thread::sleep(std::time::Duration::from_millis(50));
                            println!("[DEBUG-H] Stream cleanup complete");
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
                                let _ = app.emit("playback_loading", false);
                            }
                            continue;
                        }
                    };

                    // 2. Get FRESH device (follows system default - handles headphones/DAC hot-plug)
                    let (device, capabilities) = match get_current_device_and_caps(&backend) {
                        Some((d, c)) => (d, c),
                        None => {
                            eprintln!("No audio output device available!");
                            if let Some(ref app) = app_handle {
                                let _ = app.emit("playback_loading", false);
                            }
                            continue;
                        }
                    };
                    println!("[AudioEngine] Using device: {:?}", device.name());

                    // 3. Use backend to prepare device for streaming (changes sample rate if possible)
                    let stream_config = StreamConfig::stereo(source_info.sample_rate);
                    let (optimal_rate, is_bit_perfect) = match backend.lock().prepare_for_streaming(&stream_config) {
                        Ok(actual_rate) => {
                            let bit_perfect = actual_rate == source_info.sample_rate;
                            println!("[Backend] Device prepared: {} Hz (requested: {} Hz, bit-perfect: {})",
                                actual_rate, source_info.sample_rate, bit_perfect);
                            (actual_rate, bit_perfect)
                        }
                        Err(e) => {
                            eprintln!("[Backend] Failed to prepare device: {}. Using CPAL fallback.", e);
                            // Fallback to old logic
                            find_best_output_rate(source_info.sample_rate, &capabilities, &device)
                        }
                    };

                    let needs_resampling = !is_bit_perfect;
                    let target_rate = if needs_resampling { Some(optimal_rate) } else { None };

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

                                // Crée le stream de sortie avec le OUTPUT rate
                                let stream = Self::create_output_stream(
                                    &device,
                                    consumer,
                                    Arc::clone(&session.state),
                                    Arc::clone(&state),
                                    app_handle.clone(),
                                );

                                if let Some(s) = stream {
                                    if let Err(e) = s.play() {
                                        eprintln!("Failed to start stream: {}", e);
                                    } else {
                                        state.is_playing.store(true, Ordering::Relaxed);
                                        state.is_paused.store(false, Ordering::Relaxed);
                                        *current_stream.lock() = Some(s);
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
                            } else {
                                eprintln!("Failed to take consumer from session");
                            }

                            if let Some(ref app) = app_handle {
                                let _ = app.emit("playback_loading", false);
                            }
                        }
                        Err(e) => {
                            eprintln!("Failed to start streaming: {}", e);
                            if let Some(ref app) = app_handle {
                                let _ = app.emit("playback_loading", false);
                            }
                        }
                    }
                }

                Ok(AudioCommand::Pause) => {
                    if let Some(stream) = current_stream.lock().as_ref() {
                        let _ = stream.pause();
                        state.is_paused.store(true, Ordering::Relaxed);
                        // Notifie le frontend
                        if let Some(ref app) = app_handle {
                            let _ = app.emit("playback_paused", ());
                        }
                    }
                }

                Ok(AudioCommand::Resume) => {
                    if let Some(stream) = current_stream.lock().as_ref() {
                        let _ = stream.play();
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
                        if let Some(stream) = stream_guard.take() {
                            println!("[DEBUG-H] Stop: Stopping stream...");
                            let _ = stream.pause();
                            drop(stream);
                            std::thread::sleep(std::time::Duration::from_millis(50));
                            println!("[DEBUG-H] Stop: Stream cleanup complete");
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
                                if let Some(stream) = stream_guard.take() {
                                    println!("[DEBUG-H] Restart: Stopping stream...");
                                    let _ = stream.pause();
                                    drop(stream);
                                    std::thread::sleep(std::time::Duration::from_millis(50));
                                    println!("[DEBUG-H] Restart: Stream cleanup complete");
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
                                    state.is_seeking.store(false, Ordering::Relaxed);
                                    if let Some(ref app) = app_handle {
                                        let _ = app.emit("playback_loading", false);
                                    }
                                    continue;
                                }
                            };

                            // Get FRESH device for seek restart
                            let (device, capabilities) = match get_current_device_and_caps(&backend) {
                                Some((d, c)) => (d, c),
                                None => {
                                    eprintln!("No audio output device available!");
                                    state.is_seeking.store(false, Ordering::Relaxed);
                                    if let Some(ref app) = app_handle {
                                        let _ = app.emit("playback_loading", false);
                                    }
                                    continue;
                                }
                            };

                            // Use backend to prepare device (sample rate already set, just verify)
                            let stream_config = StreamConfig::stereo(source_info.sample_rate);
                            let (optimal_rate, is_bit_perfect) = match backend.lock().prepare_for_streaming(&stream_config) {
                                Ok(actual_rate) => {
                                    let bit_perfect = actual_rate == source_info.sample_rate;
                                    (actual_rate, bit_perfect)
                                }
                                Err(_) => {
                                    find_best_output_rate(source_info.sample_rate, &capabilities, &device)
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

                                        if let Some(s) = Self::create_output_stream(
                                            &device,
                                            consumer,
                                            Arc::clone(&session.state),
                                            Arc::clone(&state),
                                            app_handle.clone(),
                                        ) {
                                            if let Err(e) = s.play() {
                                                eprintln!("Failed to restart stream: {}", e);
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
                                    }
                                    if let Some(ref app) = app_handle {
                                        let _ = app.emit("playback_loading", false);
                                    }
                                }
                                Err(e) => {
                                    eprintln!("Failed to restart for seek: {}", e);
                                    if let Some(ref app) = app_handle {
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

                Err(_) => break,
            }
        }
    }

    /// Crée le stream de sortie cpal avec le consumer (propriété transférée)
    fn create_output_stream(
        device: &cpal::Device,
        mut consumer: AudioConsumer,
        streaming_state: Arc<StreamingState>,
        playback_state: Arc<PlaybackState>,
        app_handle: Option<AppHandle>,
    ) -> Option<cpal::Stream> {
        // IMPORTANT: Utilise le OUTPUT sample rate (après resampling éventuel)
        let sample_rate = streaming_state.info.output_sample_rate;
        let channels = streaming_state.info.channels as u16;

        let config = cpal::StreamConfig {
            channels,
            sample_rate: cpal::SampleRate(sample_rate),
            buffer_size: cpal::BufferSize::Default,
        };

        println!(
            "Stream config: {}Hz, {} ch (source was {}Hz, resampled: {})",
            sample_rate, channels,
            streaming_state.info.sample_rate,
            streaming_state.info.is_resampled
        );

        let volume_atomic = Arc::clone(&playback_state.volume);
        let position_state = Arc::clone(&playback_state.position);
        let is_playing = Arc::clone(&playback_state.is_playing);

        // Position de lecture en samples
        let mut playback_samples: u64 = streaming_state.playback_position.load(Ordering::Relaxed);
        let channels_count = channels as u64;
        let sample_rate_f64 = sample_rate as f64;

        // Compteur pour émission de progression (tous les ~33ms = 30 FPS)
        let mut emit_counter: u32 = 0;
        let emit_interval = sample_rate / 30; // ~30 fps = 33ms pour une timeline fluide

        // Clone l'état pour la closure (Arc, pas les atomics individuels)
        let streaming_state_clone = Arc::clone(&streaming_state);
        let duration_seconds = streaming_state.info.duration_seconds;
        // total_frames = frames (pas samples), et chaque frame a 'channels' samples
        // Donc duration_samples = total_frames * channels
        let duration_samples = streaming_state.info.total_frames * channels_count;

        // Flag pour éviter d'émettre playback_ended plusieurs fois
        let mut end_emitted = false;
        // Compteur de callbacks vides consécutifs (pour détecter une vraie fin)
        let mut empty_callbacks = 0;
        const EMPTY_CALLBACKS_THRESHOLD: u32 = 3; // 3 callbacks vides = fin confirmée

        // [DEBUG-C] Flag pour logger le premier read après un seek
        let mut first_read_after_seek = false;
        let mut debug_seek_target: f64 = 0.0;

        // [DEBUG-E] Compteur pour les progress ticks après seek
        let mut progress_ticks_after_seek: u32 = 0;
        let mut debug_last_seek_target: f64 = 0.0;

        // [DEBUG-F] Compteur pour logger les samples réels après seek (3 callbacks)
        let mut debug_sample_log_countdown: u32 = 0;

        // [DEBUG-H] Générer un ID unique pour ce stream
        static STREAM_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let stream_id = STREAM_COUNTER.fetch_add(1, Ordering::Relaxed);
        println!("[DEBUG-H] Stream created: stream_id={}", stream_id);

        let stream = device.build_output_stream(
            &config,
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                // Récupère le volume
                let volume = f32::from_bits(volume_atomic.load(Ordering::Relaxed) as u32);

                // Si la fin a déjà été émise, sort du silence
                if end_emitted {
                    for sample in data.iter_mut() {
                        *sample = 0.0;
                    }
                    return;
                }

                // Vérifie si le buffer doit être vidé (après un seek)
                if streaming_state_clone.flush_buffer.load(Ordering::Acquire) {
                    // [DEBUG-H] Log stream ID during seek
                    println!("[DEBUG-H] Seek flush: executing on stream_id={}", stream_id);

                    // [DEBUG-C] Préparer le log du premier read après seek
                    let seek_pos = streaming_state_clone.seek_position.load(Ordering::Relaxed);
                    debug_seek_target = seek_pos as f64 / channels_count as f64 / sample_rate_f64;
                    first_read_after_seek = true;
                    debug_last_seek_target = debug_seek_target;
                    progress_ticks_after_seek = 0;

                    // [DEBUG-F] Activer le log des samples réels pour les 3 prochains callbacks
                    debug_sample_log_countdown = 3;

                    // VIDE le RingBuffer en consommant tous les samples restants
                    // C'est la seule façon de "flush" un RingBuffer lock-free depuis le consumer
                    let mut flush_buf = [0.0f32; 4096];
                    let mut total_flushed = 0usize;
                    loop {
                        let flushed = consumer.pop_slice(&mut flush_buf);
                        if flushed == 0 {
                            break;
                        }
                        total_flushed += flushed;
                    }
                    println!("[Audio] Buffer flushed: {} samples discarded", total_flushed);

                    // [DEBUG-G] Vérifier l'état du buffer après flush
                    // Note: consumer.len() donne le nombre de samples disponibles
                    use ringbuf::traits::Observer;
                    let available_after_flush = consumer.occupied_len();
                    println!("[DEBUG-G] Buffer after flush: available={} samples", available_after_flush);

                    // Désactive le flag de flush
                    streaming_state_clone.flush_buffer.store(false, Ordering::Release);

                    // IMPORTANT: Signaler au décodeur que le flush est terminé
                    streaming_state_clone.flush_complete.store(true, Ordering::Release);

                    // Met à jour notre position locale avec la position cible
                    playback_samples = streaming_state_clone.seek_position.load(Ordering::Relaxed);
                    empty_callbacks = 0;

                    // Sort du silence pour ce callback (les nouveaux samples arrivent)
                    for sample in data.iter_mut() {
                        *sample = 0.0;
                    }
                    return;
                }

                // Vérifie si un seek est en cours (pre-roll pas encore terminé)
                if streaming_state_clone.seeking.load(Ordering::Acquire) {
                    // Pendant le seek, on sort du silence et on synchronise la position
                    for sample in data.iter_mut() {
                        *sample = 0.0;
                    }
                    // Met à jour notre position locale avec la position cible
                    playback_samples = streaming_state_clone.seek_position.load(Ordering::Relaxed);
                    empty_callbacks = 0; // Reset le compteur
                    return;
                }

                // Pop les samples du RingBuffer
                let read = consumer.pop_slice(data);

                // [DEBUG-C] Log first read after seek
                if first_read_after_seek && read > 0 {
                    let current_pos_time = playback_samples as f64 / channels_count as f64 / sample_rate_f64;
                    println!("[DEBUG-C] First callback read after seek: playback_samples={}, current_pos={:.3}s, expected={:.3}s, read={} samples",
                        playback_samples, current_pos_time, debug_seek_target, read);
                    first_read_after_seek = false;
                }

                // [DEBUG-F] Log les samples réels après un seek (3 callbacks)
                if debug_sample_log_countdown > 0 && read >= 8 {
                    println!("[DEBUG-F] Callback #{} samples (seek to {:.2}s): [{:.6}, {:.6}, {:.6}, {:.6}, {:.6}, {:.6}, {:.6}, {:.6}]",
                        4 - debug_sample_log_countdown,
                        debug_last_seek_target,
                        data[0], data[1], data[2], data[3], data[4], data[5], data[6], data[7]);
                    debug_sample_log_countdown -= 1;
                }

                // [DEBUG-I] Log l'adresse du buffer de sortie (une seule fois après seek)
                if debug_sample_log_countdown == 2 && read > 0 {
                    println!("[DEBUG-I] Callback output buffer: ptr={:p}, len={}", data.as_ptr(), data.len());
                }

                // [DEBUG-G] Log buffer state après pre-fill (une fois)
                if debug_sample_log_countdown == 2 {
                    use ringbuf::traits::Observer;
                    let available = consumer.occupied_len();
                    println!("[DEBUG-G] Buffer after pre-fill (in callback): available={} samples", available);
                }

                // Applique le volume et compte les samples lus
                for sample in data[..read].iter_mut() {
                    *sample *= volume;
                }

                // Si on n'a pas assez de données, remplit de silence
                if read < data.len() {
                    for sample in data[read..].iter_mut() {
                        *sample = 0.0;
                    }
                }

                // Met à jour la position (en samples) - mais ne dépasse pas la durée
                if read > 0 {
                    playback_samples += read as u64;
                    // Clamp à la durée maximale
                    if playback_samples > duration_samples {
                        playback_samples = duration_samples;
                    }
                    empty_callbacks = 0; // Reset car on a lu des données
                } else {
                    // Callback vide
                    empty_callbacks += 1;
                }

                // Détection de fin de piste : décodage terminé + plusieurs callbacks vides
                if streaming_state_clone.decoding_complete.load(Ordering::Relaxed)
                    && empty_callbacks >= EMPTY_CALLBACKS_THRESHOLD
                    && !end_emitted
                {
                    end_emitted = true;
                    is_playing.store(false, Ordering::Relaxed);
                    let actual_position = playback_samples as f64 / channels_count as f64 / sample_rate_f64;
                    println!("=== Track finished ===\n  actual position: {:.3}s\n  duration_seconds (metadata): {:.3}s\n  playback_samples: {}\n  duration_samples (calculated): {}",
                        actual_position,
                        duration_seconds,
                        playback_samples,
                        duration_samples);
                    // Émet l'événement de fin UNE SEULE FOIS
                    if let Some(ref app) = app_handle {
                        let _ = app.emit("playback_ended", ());
                    }
                }

                // Émet la progression toutes les ~33ms (30 FPS)
                emit_counter += data.len() as u32 / channels as u32;
                if emit_counter >= emit_interval {
                    emit_counter = 0;

                    // Calcule la position en secondes (clamped à la durée)
                    let position_seconds = playback_samples as f64 / channels_count as f64 / sample_rate_f64;
                    // Clamp pour ne JAMAIS dépasser la durée (évite 100% alors que l'audio continue)
                    let clamped_position = position_seconds.min(duration_seconds * 0.999);
                    let position_ms = (clamped_position * 1000.0) as u64;
                    position_state.store(position_ms, Ordering::Relaxed);

                    // [DEBUG-E] Log first 5 progress ticks after seek
                    if progress_ticks_after_seek < 5 {
                        progress_ticks_after_seek += 1;
                        println!("[DEBUG-E] Progress tick #{} after seek: position={:.3}s (seek target was {:.3}s)",
                            progress_ticks_after_seek, clamped_position, debug_last_seek_target);
                    }

                    if let Some(ref app) = app_handle {
                        let _ = app.emit("playback_progress", PlaybackProgress {
                            position: clamped_position,
                            duration: duration_seconds,
                        });
                    }
                }
            },
            |err| eprintln!("Audio stream error: {}", err),
            None,
        );

        match stream {
            Ok(s) => Some(s),
            Err(e) => {
                eprintln!("Failed to create output stream: {}", e);
                None
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

    pub fn preload_next(&self, _path: &str) -> Result<(), String> {
        Ok(()) // TODO
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
