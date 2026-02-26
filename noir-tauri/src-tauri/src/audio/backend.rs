//! Audio backend abstraction layer
//!
//! This trait defines the interface for platform-specific audio backends.
//! Implementations handle device management, sample rate control, and exclusive mode.
//!
//! # PURE NATIVE - NO CPAL
//!
//! Audio streaming is handled directly by platform-specific code:
//! - macOS: CoreAudioStream using AudioUnit API
//! - Windows: (future) WASAPI direct
//!
//! # Important
//!
//! This file must NOT contain any platform-specific imports (coreaudio-sys, windows, etc.).
//! All platform-specific code goes in the implementation files.

use crate::audio::error::Result;
use crate::audio::types::*;

/// Core audio backend trait
///
/// Implementations provide platform-specific audio device control:
/// - Device enumeration and selection
/// - Sample rate control (changing the hardware sample rate)
/// - Exclusive/Hog mode for bit-perfect playback
/// - Device change notifications
///
/// Audio streaming is handled by platform-specific stream implementations
/// (CoreAudioStream on macOS, WasapiStream on Windows in the future).
///
/// # Example
///
/// ```ignore
/// let mut backend = create_backend()?;
///
/// // List available devices
/// let devices = backend.list_devices()?;
///
/// // Configure for 96kHz playback
/// if backend.is_sample_rate_supported(96000) {
///     backend.set_sample_rate(96000)?;
/// }
///
/// // Enable exclusive mode for bit-perfect
/// backend.set_exclusive_mode(ExclusiveMode::Exclusive)?;
///
/// // Get device ID for stream creation
/// let device_id = backend.get_device_id();
/// ```
pub trait AudioBackend: Send + Sync {
    // === Device Management ===

    /// List all available output devices (from cache, may be stale)
    fn list_devices(&self) -> Result<Vec<DeviceInfo>>;

    /// Refresh device cache from OS and return updated list
    fn refresh_devices(&mut self) -> Result<Vec<DeviceInfo>>;

    /// Get the current output device
    fn current_device(&self) -> Result<DeviceInfo>;

    /// Set the output device by ID
    ///
    /// This does NOT change the system default - it changes which device
    /// Noir uses for output. The stream must be recreated after this call.
    fn set_output_device(&mut self, device_id: &str) -> Result<()>;

    /// Get device info by ID
    fn get_device_info(&self, device_id: &str) -> Result<DeviceInfo>;

    // === Sample Rate Control ===

    /// Get the current hardware sample rate of the selected device
    fn current_sample_rate(&self) -> Result<u32>;

    /// Set the hardware sample rate
    ///
    /// This changes the actual DAC sample rate on macOS via CoreAudio HAL.
    /// Returns an error if the rate is not supported.
    ///
    /// **Important**: This should be called BEFORE creating the audio stream.
    fn set_sample_rate(&mut self, rate: u32) -> Result<()>;

    /// Check if a sample rate is supported by the current device
    fn is_sample_rate_supported(&self, rate: u32) -> bool;

    /// Get all supported sample rates for the current device
    fn supported_sample_rates(&self) -> Result<Vec<u32>>;

    // === Exclusive Mode ===

    /// Get current exclusive mode state
    fn exclusive_mode(&self) -> ExclusiveMode;

    /// Enable or disable exclusive mode (Hog Mode on macOS)
    ///
    /// When enabled, Noir takes exclusive control of the audio device,
    /// preventing other applications from using it. This is required
    /// for true bit-perfect playback on some configurations.
    ///
    /// **Important**: Must be called BEFORE creating the audio stream.
    fn set_exclusive_mode(&mut self, mode: ExclusiveMode) -> Result<()>;

    /// Get detailed Hog Mode status (device, PID owner, conflict info)
    fn hog_mode_status(&self) -> Result<HogModeStatus>;

    // === Device Events ===

    /// Register a callback for device change events
    ///
    /// The callback will be invoked when:
    /// - A device is added or removed
    /// - The default device changes
    /// - A device's sample rate changes
    fn set_device_event_callback(&mut self, callback: Option<DeviceEventCallback>);

    // === Device ID for Streaming ===

    /// Get the device ID for stream creation
    ///
    /// Returns the platform-specific device ID:
    /// - macOS: AudioObjectID (u32)
    /// - Windows: (future) device string ID
    ///
    /// Returns None to use the system default device.
    fn get_device_id(&self) -> Option<u32>;

    /// Prepare the device for streaming
    ///
    /// Called before creating a CPAL stream. This ensures:
    /// - Sample rate is set correctly
    /// - Exclusive mode is engaged (if enabled)
    /// - Device is ready to accept audio
    ///
    /// Returns the actual sample rate that will be used (may differ from requested
    /// if the device doesn't support it).
    fn prepare_for_streaming(&mut self, config: &StreamConfig) -> Result<u32>;

    // === Cleanup ===

    /// Release exclusive mode and restore original sample rate
    ///
    /// Called when switching tracks, changing devices, or shutting down.
    /// This is also called automatically in the Drop implementation.
    fn release(&mut self) -> Result<()>;

    // === Info ===

    /// Get the backend name (e.g., "CoreAudio", "WASAPI")
    fn name(&self) -> &'static str;
}

/// Factory function to create the appropriate backend for the current platform
pub fn create_backend() -> Result<Box<dyn AudioBackend>> {
    #[cfg(target_os = "macos")]
    {
        use crate::audio::coreaudio_backend::CoreAudioBackend;
        Ok(Box::new(CoreAudioBackend::new()?))
    }

    #[cfg(target_os = "windows")]
    {
        // Future: WASAPI backend
        // use crate::audio::wasapi_backend::WasapiBackend;
        // Ok(Box::new(WasapiBackend::new()?))
        Err(crate::audio::error::AudioBackendError::NotSupported(
            "Windows WASAPI backend not yet implemented".to_string(),
        ))
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err(crate::audio::error::AudioBackendError::NotSupported(
            "No native audio backend for this platform".to_string(),
        ))
    }
}
