// === AUDIO DECODER ===
// Décode les fichiers audio en streaming avec RingBuffer lock-free
// Supporte le SEEKING : le thread décodeur peut recevoir des commandes de seek
// Supporte le RESAMPLING : conversion de sample rate via rubato
// Architecture : [Thread Décodeur] ←→ [Resampler?] → [RingBuffer] → [Callback cpal]

use std::fs::File;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;

use crossbeam_channel::{bounded, Receiver, Sender};
use ringbuf::{HeapRb, HeapCons, HeapProd};
use ringbuf::traits::{Consumer, Producer, Split};
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::formats::{FormatOptions, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;

use crate::resampler::AudioResampler;

/// Taille du RingBuffer en secondes
/// 5s = ~3.5MB en mémoire (44100Hz × 2ch × 4bytes × 5s) pour CD quality
/// En Hi-Res 192kHz = ~7.7MB, acceptable
const RING_BUFFER_SECONDS: f64 = 5.0;

/// Pourcentage de remplissage minimum avant de démarrer la lecture
/// Avec 5s de buffer, 10% = 500ms de préchargement avant lecture
const PRE_ROLL_PERCENT: f64 = 0.10; // 10% = 500ms pour un buffer de 5s

/// Nombre minimum de samples à pré-remplir après un seek (environ 300ms)
/// Cela permet de reprendre la lecture rapidement sans attendre le pre-roll complet
const SEEK_PREFILL_MS: u64 = 300;

/// Informations sur le fichier audio
#[derive(Debug, Clone)]
pub struct AudioInfo {
    /// Sample rate du fichier source
    pub sample_rate: u32,
    /// Sample rate de sortie (après resampling éventuel)
    pub output_sample_rate: u32,
    pub channels: usize,
    pub duration_seconds: f64,
    pub total_frames: u64,
    pub bit_depth: u8,
    /// True si resampling actif
    pub is_resampled: bool,
}

/// Consumer du RingBuffer (utilisé par le callback audio)
pub type AudioConsumer = HeapCons<f32>;

/// Commandes envoyées au thread de décodage
#[derive(Debug)]
pub enum DecoderCommand {
    /// Seek à une position (en secondes)
    Seek(f64),
    /// Arrête le décodage
    Stop,
}

/// État partagé du streaming
pub struct StreamingState {
    /// Indique si le décodage est terminé
    pub decoding_complete: AtomicBool,
    /// Nombre total de samples décodés depuis le début du fichier
    pub total_decoded: AtomicUsize,
    /// Position de lecture actuelle (samples depuis le début du FICHIER, pas du buffer)
    pub playback_position: AtomicU64,
    /// Position cible après un seek (pour synchronisation)
    pub seek_position: AtomicU64,
    /// Flag indiquant qu'un seek est en cours (décodeur en train de se repositionner)
    pub seeking: AtomicBool,
    /// Flag pour demander au consumer de vider le buffer (activé lors d'un seek)
    pub flush_buffer: AtomicBool,
    /// Flag indiquant que le flush est terminé (activé par le callback audio)
    pub flush_complete: AtomicBool,
    /// Nombre de samples décodés depuis le dernier seek (pour le pre-fill)
    pub samples_since_seek: AtomicUsize,
    /// Infos audio
    pub info: AudioInfo,
    /// Taille du ring buffer
    pub ring_capacity: usize,
}

impl StreamingState {
    pub fn new(info: AudioInfo, ring_capacity: usize) -> Self {
        Self {
            decoding_complete: AtomicBool::new(false),
            total_decoded: AtomicUsize::new(0),
            playback_position: AtomicU64::new(0),
            seek_position: AtomicU64::new(0),
            seeking: AtomicBool::new(false),
            flush_buffer: AtomicBool::new(false),
            flush_complete: AtomicBool::new(false),
            samples_since_seek: AtomicUsize::new(0),
            info,
            ring_capacity,
        }
    }

    /// Durée réelle basée sur les métadonnées (précision au sample)
    pub fn duration_seconds(&self) -> f64 {
        self.info.duration_seconds
    }

    /// Position de lecture en secondes (précision au sample)
    pub fn position_seconds(&self) -> f64 {
        let pos = self.playback_position.load(Ordering::Relaxed);
        pos as f64 / self.info.channels as f64 / self.info.sample_rate as f64
    }

    /// Définit la position de lecture (appelé par le callback audio)
    pub fn set_position_samples(&self, samples: u64) {
        self.playback_position.store(samples, Ordering::Relaxed);
    }

    /// Récupère la position en samples
    pub fn position_samples(&self) -> u64 {
        self.playback_position.load(Ordering::Relaxed)
    }
}

/// Résultat du démarrage du streaming
pub struct StreamingSession {
    /// Consumer pour le callback audio (lock-free) - Option pour permettre take()
    consumer: Option<AudioConsumer>,
    /// État partagé
    pub state: Arc<StreamingState>,
    /// Canal pour envoyer des commandes au décodeur
    pub command_tx: Sender<DecoderCommand>,
}

impl StreamingSession {
    /// Prend le consumer (transfert de propriété) - ne peut être appelé qu'une fois
    pub fn take_consumer(&mut self) -> Option<AudioConsumer> {
        self.consumer.take()
    }
}

impl StreamingSession {
    /// Effectue un seek à la position donnée (en secondes)
    pub fn seek(&self, time_seconds: f64) -> Result<(), String> {
        // Calcule la position en samples
        let target_samples = (time_seconds * self.state.info.sample_rate as f64
            * self.state.info.channels as f64) as u64;

        // Marque qu'un seek est en cours
        self.state.seeking.store(true, Ordering::Release);
        self.state.seek_position.store(target_samples, Ordering::Release);

        // Envoie la commande au décodeur
        self.command_tx.send(DecoderCommand::Seek(time_seconds))
            .map_err(|e| format!("Failed to send seek command: {}", e))
    }

    /// Arrête le décodage
    pub fn stop(&self) {
        let _ = self.command_tx.send(DecoderCommand::Stop);
    }
}

/// Probe un fichier audio pour obtenir ses métadonnées sans décoder
/// Utilise Symphonia d'abord, puis lofty en fallback pour les M4A/AAC
pub fn probe_audio_file(path: &str) -> Result<AudioInfo, String> {
    // 1. Essaie avec Symphonia (rapide, fonctionne bien pour WAV/FLAC/MP3)
    if let Some(info) = try_probe_with_symphonia(path) {
        // Vérifie que le sample_rate est plausible (pas un fallback)
        if info.sample_rate > 8000 && info.sample_rate <= 384000 {
            #[cfg(debug_assertions)]
            println!("DEBUG PROBE (Symphonia): {}Hz, {}bit, {}ch",
                info.sample_rate, info.bit_depth, info.channels);
            return Ok(info);
        }
        #[cfg(debug_assertions)]
        println!("DEBUG PROBE: Symphonia returned suspicious rate {}Hz, trying lofty...",
            info.sample_rate);
    }

    // 2. Fallback lofty pour M4A/AAC et autres formats problématiques
    probe_with_lofty(path)
}

/// Tente de probe avec Symphonia (peut échouer sur certains M4A)
fn try_probe_with_symphonia(path: &str) -> Option<AudioInfo> {
    let path_buf = Path::new(path).to_path_buf();
    let file = File::open(&path_buf).ok()?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path_buf.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .ok()?;

    let track = probed.format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)?;

    // IMPORTANT: On vérifie si sample_rate est réellement présent
    // Si c'est None, on retourne None pour déclencher le fallback lofty
    let sample_rate = track.codec_params.sample_rate?;

    let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2);
    let total_frames = track.codec_params.n_frames.unwrap_or(0);
    // Pour AAC, bits_per_sample est souvent None - on laisse lofty gérer
    let bit_depth = track.codec_params.bits_per_sample.unwrap_or(0) as u8;

    // Si bit_depth est 0, on préfère lofty
    if bit_depth == 0 {
        return None;
    }

    let duration_seconds = if total_frames > 0 {
        total_frames as f64 / sample_rate as f64
    } else {
        0.0
    };

    Some(AudioInfo {
        sample_rate,
        output_sample_rate: sample_rate,
        channels,
        duration_seconds,
        total_frames,
        bit_depth,
        is_resampled: false,
    })
}

/// Probe avec lofty (plus robuste pour M4A/AAC)
fn probe_with_lofty(path: &str) -> Result<AudioInfo, String> {
    use lofty::{AudioFile, Probe};

    let tagged_file = Probe::open(path)
        .map_err(|e| format!("Lofty open failed: {}", e))?
        .read()
        .map_err(|e| format!("Lofty read failed: {}", e))?;

    let props = tagged_file.properties();

    let sample_rate = props.sample_rate()
        .ok_or("Could not determine sample rate from file")?;

    // Pour AAC compressé, bit_depth n'a pas de sens - on met 24 par défaut pour hi-res
    let bit_depth = props.bit_depth().unwrap_or(24) as u8;
    let channels = props.channels().unwrap_or(2) as usize;
    let duration_seconds = props.duration().as_secs_f64();
    let total_frames = (duration_seconds * sample_rate as f64) as u64;

    #[cfg(debug_assertions)]
    println!("DEBUG PROBE (lofty): {}Hz, {}bit, {}ch, {:.2}s",
        sample_rate, bit_depth, channels, duration_seconds);

    Ok(AudioInfo {
        sample_rate,
        output_sample_rate: sample_rate,
        channels,
        duration_seconds,
        total_frames,
        bit_depth,
        is_resampled: false,
    })
}

/// Démarre le décodage en streaming avec support du seeking
/// Note: préférer utiliser start_streaming_with_config() avec le source_sample_rate explicite
pub fn start_streaming(path: &str) -> Result<StreamingSession, String> {
    let source_info = probe_audio_file(path)?;
    start_streaming_with_config(path, 0.0, source_info.sample_rate, None)
}

/// Démarre le décodage à une position spécifique (en secondes)
/// Note: préférer utiliser start_streaming_with_config() avec le source_sample_rate explicite
pub fn start_streaming_at(path: &str, start_time: f64) -> Result<StreamingSession, String> {
    let source_info = probe_audio_file(path)?;
    start_streaming_with_config(path, start_time, source_info.sample_rate, None)
}

/// Démarre le décodage avec configuration de resampling optionnelle
///
/// # Arguments
/// * `path` - Chemin du fichier audio
/// * `start_time` - Position de départ en secondes
/// * `source_sample_rate` - Sample rate du fichier source (déterminé par probe_audio_file)
/// * `target_sample_rate` - Sample rate cible de sortie (None = bit-perfect, utiliser le source)
pub fn start_streaming_with_config(
    path: &str,
    start_time: f64,
    source_sample_rate: u32,  // NOUVEAU: passé depuis probe_audio_file()
    target_sample_rate: Option<u32>,
) -> Result<StreamingSession, String> {
    let path_buf = Path::new(path).to_path_buf();

    // Ouvre le fichier
    let file = File::open(&path_buf).map_err(|e| format!("Cannot open file: {}", e))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    // Hint pour aider symphonia
    let mut hint = Hint::new();
    if let Some(ext) = path_buf.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    // Probe le format
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions {
                enable_gapless: true,
                ..Default::default()
            },
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("Failed to probe format: {}", e))?;

    let mut format = probed.format;

    // Trouve la piste audio
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or("No audio track found")?;

    let track_id = track.id;

    // Symphonia peut retourner des valeurs incorrectes pour M4A/AAC
    // On utilise le source_sample_rate passé depuis probe_audio_file() qui est fiable
    let symphonia_sample_rate = track.codec_params.sample_rate;
    let symphonia_bit_depth = track.codec_params.bits_per_sample;

    // Log si Symphonia et lofty divergent (utile pour debug)
    #[cfg(debug_assertions)]
    if let Some(sym_rate) = symphonia_sample_rate {
        if sym_rate != source_sample_rate {
            println!("⚠️  Symphonia reports {}Hz but probe_audio_file found {}Hz - using {}Hz",
                sym_rate, source_sample_rate, source_sample_rate);
        }
    }

    let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2);
    let total_frames = track.codec_params.n_frames.unwrap_or(0);

    // Pour AAC, bit_depth est souvent None - on met 24 pour hi-res
    let bit_depth = symphonia_bit_depth.unwrap_or(24) as u8;

    // Détermine le sample rate de sortie (bit-perfect si target_sample_rate est None)
    let output_sample_rate = target_sample_rate.unwrap_or(source_sample_rate);
    let needs_resampling = output_sample_rate != source_sample_rate;

    #[cfg(debug_assertions)]
    {
        println!("DEBUG STREAM: Source: {}Hz → Output: {}Hz, Resampling: {}",
            source_sample_rate, output_sample_rate, needs_resampling);
        if needs_resampling {
            println!("  → Resampler will convert {}Hz → {}Hz", source_sample_rate, output_sample_rate);
        }
    }

    // IMPORTANT: n_frames est le nombre de FRAMES (pas samples)
    let duration_seconds = if total_frames > 0 {
        total_frames as f64 / source_sample_rate as f64
    } else {
        0.0
    };

    let info = AudioInfo {
        sample_rate: source_sample_rate,
        output_sample_rate,
        channels,
        duration_seconds,
        total_frames,
        bit_depth,
        is_resampled: needs_resampling,
    };

    // Calcule la taille du RingBuffer basée sur le OUTPUT rate
    // (le RingBuffer contiendra des samples au sample rate de sortie)
    let ring_capacity = (RING_BUFFER_SECONDS * output_sample_rate as f64 * channels as f64) as usize;
    let pre_roll_samples = (ring_capacity as f64 * PRE_ROLL_PERCENT) as usize;

    #[cfg(debug_assertions)]
    println!(
        "=== Audio File Info ===\n  source_rate: {}Hz\n  output_rate: {}Hz (resampling: {})\n  bit_depth: {}bit\n  channels: {}\n  total_frames: {}\n  duration: {:.3}s\n  RingBuffer: {} samples ({:.1}s)\n  pre-roll: {:.0}ms",
        source_sample_rate, output_sample_rate, needs_resampling,
        bit_depth, channels, total_frames, duration_seconds,
        ring_capacity, RING_BUFFER_SECONDS,
        (pre_roll_samples / channels) as f64 / output_sample_rate as f64 * 1000.0
    );

    // Crée le RingBuffer lock-free
    let ring = HeapRb::<f32>::new(ring_capacity);
    let (producer, consumer) = ring.split();

    // Canal de commandes
    let (command_tx, command_rx) = bounded::<DecoderCommand>(16);

    // État partagé
    let state = Arc::new(StreamingState::new(info.clone(), ring_capacity));
    let state_clone = Arc::clone(&state);

    // Crée le décodeur
    let decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Failed to create decoder: {}", e))?;

    // Crée le resampler si nécessaire
    let resampler = if needs_resampling {
        match AudioResampler::new(source_sample_rate, output_sample_rate, channels) {
            Ok(r) => Some(r),
            Err(e) => {
                eprintln!("Failed to create resampler: {}, falling back to native rate", e);
                None
            }
        }
    } else {
        None
    };

    // Si on démarre à une position non-zero, effectue un seek initial
    if start_time > 0.0 {
        let seek_to = SeekTo::Time {
            time: Time::from(start_time),
            track_id: Some(track_id),
        };
        if let Err(e) = format.seek(SeekMode::Coarse, seek_to) {
            eprintln!("Initial seek failed: {}", e);
        } else {
            // Position calculée au OUTPUT sample rate
            let start_samples = (start_time * output_sample_rate as f64 * channels as f64) as u64;
            state.playback_position.store(start_samples, Ordering::Relaxed);
            state.seek_position.store(start_samples, Ordering::Relaxed);
        }
    }

    // Flag pour signaler que le pre-roll est atteint
    let pre_roll_ready = Arc::new(AtomicBool::new(false));
    let pre_roll_ready_clone = Arc::clone(&pre_roll_ready);

    // Lance le thread de décodage
    thread::spawn(move || {
        decoder_thread(
            format,
            decoder,
            track_id,
            producer,
            command_rx,
            state_clone,
            pre_roll_ready_clone,
            pre_roll_samples,
            source_sample_rate,
            output_sample_rate,
            channels,
            resampler,
        );
    });

    // Attend le pre-roll (max 5 secondes)
    let start = std::time::Instant::now();
    while !pre_roll_ready.load(Ordering::Acquire) {
        if start.elapsed().as_secs() > 5 {
            return Err("Timeout waiting for pre-roll".to_string());
        }
        thread::sleep(std::time::Duration::from_micros(100));
    }

    #[cfg(debug_assertions)]
    println!("Streaming ready in {:?}", start.elapsed());

    Ok(StreamingSession {
        consumer: Some(consumer),
        state,
        command_tx,
    })
}

/// Thread de décodage avec support du seeking et resampling
fn decoder_thread(
    mut format: Box<dyn symphonia::core::formats::FormatReader>,
    mut decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    mut producer: HeapProd<f32>,
    command_rx: Receiver<DecoderCommand>,
    state: Arc<StreamingState>,
    pre_roll_ready: Arc<AtomicBool>,
    pre_roll_samples: usize,
    source_sample_rate: u32,
    output_sample_rate: u32,
    channels: usize,
    mut resampler: Option<AudioResampler>,
) {
    let mut temp_buffer: Vec<f32> = Vec::with_capacity(8192);
    let mut samples_since_start = 0usize; // Pour le pre-roll (en samples OUTPUT)
    let mut current_file_position = state.playback_position.load(Ordering::Relaxed) as usize;

    // Le sample rate utilisé pour calculer les positions dépend du resampling
    let position_sample_rate = output_sample_rate;

    // Variables pour tracer le seek (debug only)
    let mut last_seek_target: f64 = 0.0;
    let mut first_packet_after_seek = false;
    #[allow(unused_variables)]
    let mut prefill_start_logged = false;

    #[cfg(debug_assertions)]
    println!("[DEBUG-D] No intermediate queue found — decoder writes directly to RingBuffer");

    loop {
        // Vérifie les commandes (non-bloquant)
        match command_rx.try_recv() {
            Ok(DecoderCommand::Seek(time_seconds)) => {
                #[cfg(debug_assertions)]
                println!("[DEBUG-A] Seek requested to: {:.3}s", time_seconds);
                last_seek_target = time_seconds;
                first_packet_after_seek = true;
                prefill_start_logged = false;

                // ÉTAPE 1: Demander le flush du buffer
                // Note: seeking est déjà true (mis par l'engine avant d'envoyer la commande)
                state.flush_buffer.store(true, Ordering::Release);

                // ÉTAPE 2: Attendre que le callback audio ait vidé le buffer
                // Timeout de 500ms max pour éviter un blocage infini
                let flush_start = std::time::Instant::now();
                while !state.flush_complete.load(Ordering::Acquire) {
                    if flush_start.elapsed().as_millis() > 500 {
                        #[cfg(debug_assertions)]
                        println!("Decoder: Flush timeout after 500ms, continuing anyway");
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_micros(500));
                }
                #[cfg(debug_assertions)]
                println!("Decoder: Buffer flush complete, proceeding with seek");

                // ÉTAPE 3: Effectue le seek dans symphonia
                let seek_to = SeekTo::Time {
                    time: Time::from(time_seconds),
                    track_id: Some(track_id),
                };

                match format.seek(SeekMode::Coarse, seek_to) {
                    Ok(seeked_to) => {
                        // Reset le décodeur après le seek
                        decoder.reset();

                        #[cfg(debug_assertions)]
                        {
                            let decoder_position_ts = seeked_to.actual_ts as f64 / source_sample_rate as f64;
                            println!("[DEBUG-A] Decoder reports position after seek: frame={}, estimated_time={:.3}s",
                                seeked_to.actual_ts, decoder_position_ts);
                        }

                        // Calcule la nouvelle position (en OUTPUT samples)
                        let new_position = (time_seconds * position_sample_rate as f64 * channels as f64) as usize;
                        current_file_position = new_position;

                        state.seek_position.store(new_position as u64, Ordering::Release);
                        samples_since_start = 0;

                        #[cfg(debug_assertions)]
                        println!("Decoder: Seeked to frame {}, position {:.2}s",
                            seeked_to.actual_ts, time_seconds);

                        // ÉTAPE 4: Le pre-fill se fait dans la boucle principale
                        // Le flag 'seeking' reste à true jusqu'à ce que le pre-fill soit atteint
                    }
                    Err(e) => {
                        eprintln!("Seek failed: {}", e);
                        state.seeking.store(false, Ordering::Release);
                        state.flush_buffer.store(false, Ordering::Release);
                    }
                }
            }
            Ok(DecoderCommand::Stop) => {
                #[cfg(debug_assertions)]
                println!("Decoder: Stopping");
                break;
            }
            Err(_) => {} // Pas de commande, continue le décodage
        }

        // Récupère le prochain packet
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(symphonia::core::errors::Error::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                // Fin du fichier - flush le resampler s'il y a des samples en attente
                if let Some(ref mut r) = resampler {
                    let flushed = r.flush();
                    if !flushed.is_empty() {
                        push_to_ring(&mut producer, &flushed, &command_rx);
                    }
                }
                break;
            }
            Err(symphonia::core::errors::Error::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(e) => {
                eprintln!("Decode warning: {}", e);
                continue;
            }
        };

        if packet.track_id() != track_id {
            continue;
        }

        if first_packet_after_seek {
            #[cfg(debug_assertions)]
            {
                let packet_ts = packet.ts();
                let packet_time = packet_ts as f64 / source_sample_rate as f64;
                println!("[DEBUG-A] First decoded packet after seek: ts={}, time={:.3}s (target was {:.3}s)",
                    packet_ts, packet_time, last_seek_target);
            }
            first_packet_after_seek = false;
        }

        // Décode le packet
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(e) => {
                eprintln!("Decode error: {}", e);
                continue;
            }
        };

        // Convertit en f32 interleaved
        temp_buffer.clear();
        convert_to_f32_interleaved(&decoded, &mut temp_buffer);

        // Applique le resampling si nécessaire
        let output_samples = if let Some(ref mut r) = resampler {
            r.process(&temp_buffer)
        } else {
            temp_buffer.clone()
        };

        #[cfg(debug_assertions)]
        if state.seeking.load(Ordering::Relaxed) && !prefill_start_logged {
            let write_position_samples = current_file_position;
            let write_position_time = write_position_samples as f64 / channels as f64 / output_sample_rate as f64;
            println!("[DEBUG-B] Pre-fill start: writing samples at position {:.3}s ({} samples, target was {:.3}s)",
                write_position_time, write_position_samples, last_seek_target);
            prefill_start_logged = true;
        }

        // Push dans le RingBuffer
        let written = push_to_ring(&mut producer, &output_samples, &command_rx);

        samples_since_start += written;
        current_file_position += written;
        state.total_decoded.store(current_file_position, Ordering::Relaxed);

        // Track samples since last seek (pour le pre-fill court après seek)
        let prev_samples_since_seek = state.samples_since_seek.load(Ordering::Relaxed);
        state.samples_since_seek.store(prev_samples_since_seek + written, Ordering::Relaxed);

        // Signal pre-roll ready (démarrage initial)
        if !pre_roll_ready.load(Ordering::Relaxed) && samples_since_start >= pre_roll_samples {
            pre_roll_ready.store(true, Ordering::Release);
            state.seeking.store(false, Ordering::Release);
            #[cfg(debug_assertions)]
            println!(
                "Pre-roll ready: {} samples ({:.0}ms)",
                samples_since_start,
                (samples_since_start / channels) as f64 / output_sample_rate as f64 * 1000.0
            );
        }

        // Si on est en seek, vérifier si le pre-fill court est atteint
        // Pre-fill après seek = SEEK_PREFILL_MS (300ms par défaut)
        if state.seeking.load(Ordering::Relaxed) {
            let prefill_samples = (SEEK_PREFILL_MS as f64 / 1000.0 * output_sample_rate as f64 * channels as f64) as usize;
            let current_prefill = state.samples_since_seek.load(Ordering::Relaxed);

            if current_prefill >= prefill_samples {
                #[cfg(debug_assertions)]
                {
                    let end_position_time = current_file_position as f64 / channels as f64 / output_sample_rate as f64;
                    println!("[DEBUG-B] Pre-fill end: last sample at position {:.3}s ({} samples written since seek)",
                        end_position_time, current_prefill);
                    println!(
                        "Seek complete: pre-fill {} samples ({:.0}ms)",
                        current_prefill,
                        (current_prefill / channels) as f64 / output_sample_rate as f64 * 1000.0
                    );
                }

                state.seeking.store(false, Ordering::Release);
            }
        }
    }

    state.decoding_complete.store(true, Ordering::Release);
    #[cfg(debug_assertions)]
    println!("Decoding complete");
}

/// Pousse des samples dans le RingBuffer, retourne le nombre de samples écrits
fn push_to_ring(
    producer: &mut HeapProd<f32>,
    samples: &[f32],
    command_rx: &Receiver<DecoderCommand>,
) -> usize {
    let mut written = 0;
    while written < samples.len() {
        // Vérifie si on doit interrompre pour une commande
        if !command_rx.is_empty() {
            break;
        }

        let to_write = &samples[written..];
        let n = producer.push_slice(to_write);
        written += n;

        if n == 0 {
            // Ring plein, attend un peu
            thread::sleep(std::time::Duration::from_micros(500));
        }
    }
    written
}

/// Convertit un AudioBufferRef en samples f32 interleaved
fn convert_to_f32_interleaved(decoded: &AudioBufferRef, output: &mut Vec<f32>) {
    match decoded {
        AudioBufferRef::F32(buf) => {
            let channels = buf.spec().channels.count();
            let frames = buf.frames();
            output.reserve(frames * channels);
            for frame in 0..frames {
                for ch in 0..channels {
                    output.push(buf.chan(ch)[frame]);
                }
            }
        }
        AudioBufferRef::S16(buf) => {
            let channels = buf.spec().channels.count();
            let frames = buf.frames();
            output.reserve(frames * channels);
            for frame in 0..frames {
                for ch in 0..channels {
                    output.push(buf.chan(ch)[frame] as f32 / 32768.0);
                }
            }
        }
        AudioBufferRef::S24(buf) => {
            let channels = buf.spec().channels.count();
            let frames = buf.frames();
            output.reserve(frames * channels);
            for frame in 0..frames {
                for ch in 0..channels {
                    output.push(buf.chan(ch)[frame].0 as f32 / 8388608.0);
                }
            }
        }
        AudioBufferRef::S32(buf) => {
            let channels = buf.spec().channels.count();
            let frames = buf.frames();
            output.reserve(frames * channels);
            for frame in 0..frames {
                for ch in 0..channels {
                    output.push(buf.chan(ch)[frame] as f32 / 2147483648.0);
                }
            }
        }
        AudioBufferRef::U8(buf) => {
            let channels = buf.spec().channels.count();
            let frames = buf.frames();
            output.reserve(frames * channels);
            for frame in 0..frames {
                for ch in 0..channels {
                    output.push((buf.chan(ch)[frame] as f32 - 128.0) / 128.0);
                }
            }
        }
        _ => {
            eprintln!("Unsupported audio format");
        }
    }
}
