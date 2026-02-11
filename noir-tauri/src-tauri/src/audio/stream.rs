//! Audio output stream abstraction trait
//!
//! This trait abstracts the audio output stream, allowing different backends
//! (CoreAudio on macOS, WASAPI on Windows) to be used interchangeably.
//!
//! Key feature: `reset()` method allows flushing internal buffers for instant seek.

use std::sync::Arc;
use crate::audio_decoder::StreamingState;
use ringbuf::HeapCons;

/// Trait for audio output streams
///
/// Implementations provide platform-specific audio output with full control
/// over buffering, sample rate, and exclusive mode.
pub trait AudioOutputStream: Send {
    /// Starts the audio stream (begins pulling samples from the RingBuffer)
    fn start(&mut self) -> Result<(), String>;

    /// Pauses playback (outputs silence but stream remains active)
    fn pause(&mut self) -> Result<(), String>;

    /// Resumes playback after pause
    fn resume(&mut self) -> Result<(), String>;

    /// Stops the stream completely
    fn stop(&mut self) -> Result<(), String>;

    /// Resets internal buffers - THIS IS THE KEY FOR INSTANT SEEK
    ///
    /// On macOS, this calls AudioUnitReset() which flushes CoreAudio's
    /// internal ~50ms buffer. Without this, seek has a 2-5 second delay.
    fn reset(&mut self) -> Result<(), String>;

    /// Returns true if the stream is currently playing
    fn is_playing(&self) -> bool;

    /// Returns the current sample rate
    fn sample_rate(&self) -> u32;

    /// Returns the number of channels
    fn channels(&self) -> u16;
}

/// Configuration for creating an audio stream
#[derive(Debug, Clone)]
pub struct AudioStreamConfig {
    pub sample_rate: u32,
    pub channels: u16,
}

impl AudioStreamConfig {
    pub fn new(sample_rate: u32, channels: u16) -> Self {
        Self { sample_rate, channels }
    }

    pub fn stereo(sample_rate: u32) -> Self {
        Self::new(sample_rate, 2)
    }
}

/// Factory function to create the platform-appropriate audio stream
///
/// # Arguments
/// * `device_id` - Optional device ID. On macOS, this is an AudioObjectID.
///                 If None, the system default device will be used.
#[cfg(target_os = "macos")]
pub fn create_audio_stream(
    device_id: Option<u32>,
    config: AudioStreamConfig,
    consumer: HeapCons<f32>,
    streaming_state: Arc<StreamingState>,
    volume: Arc<std::sync::atomic::AtomicU64>,
    position_state: Arc<std::sync::atomic::AtomicU64>,
    is_playing: Arc<std::sync::atomic::AtomicBool>,
    app_handle: Option<tauri::AppHandle>,
    duration_seconds: f64,
) -> Result<Box<dyn AudioOutputStream>, String> {
    use super::coreaudio_stream::CoreAudioStream;
    CoreAudioStream::new(
        device_id,
        config,
        consumer,
        streaming_state,
        volume,
        position_state,
        is_playing,
        app_handle,
        duration_seconds,
    ).map(|s| Box::new(s) as Box<dyn AudioOutputStream>)
}

// Future: Windows WASAPI implementation
// #[cfg(target_os = "windows")]
// pub fn create_audio_stream(...) -> Result<Box<dyn AudioOutputStream>, String> {
//     use super::wasapi_stream::WasapiStream;
//     WasapiStream::new(...).map(|s| Box::new(s) as Box<dyn AudioOutputStream>)
// }
