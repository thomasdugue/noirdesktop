//! Shared audio types used by all backends
//!
//! This module contains platform-agnostic types for audio device management.
//! NO platform-specific imports allowed here.

use serde::{Deserialize, Serialize};

/// Information about an audio output device
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    /// Unique device identifier (platform-specific format)
    pub id: String,
    /// Human-readable device name
    pub name: String,
    /// Manufacturer name (if available)
    pub manufacturer: Option<String>,
    /// Whether this is the system default device
    pub is_default: bool,
    /// Supported sample rates (e.g., [44100, 48000, 96000, 192000])
    pub supported_sample_rates: Vec<u32>,
    /// Current device sample rate
    pub current_sample_rate: u32,
    /// Maximum number of channels
    pub max_channels: u16,
    /// Whether exclusive mode is supported
    pub supports_exclusive: bool,
}

impl DeviceInfo {
    /// Check if a sample rate is supported by this device
    pub fn supports_sample_rate(&self, rate: u32) -> bool {
        self.supported_sample_rates.contains(&rate)
    }
}

/// Standard audiophile sample rates
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SampleRate(pub u32);

impl SampleRate {
    pub const CD_QUALITY: Self = Self(44100);
    pub const DAT_QUALITY: Self = Self(48000);
    pub const HI_RES_88: Self = Self(88200);
    pub const HI_RES_96: Self = Self(96000);
    pub const HI_RES_176: Self = Self(176400);
    pub const HI_RES_192: Self = Self(192000);
    pub const HI_RES_352: Self = Self(352800);
    pub const HI_RES_384: Self = Self(384000);

    /// All standard audiophile sample rates
    pub const STANDARD_RATES: [u32; 8] = [
        44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000,
    ];

    /// Check if a rate is a standard audiophile rate
    pub fn is_standard(rate: u32) -> bool {
        Self::STANDARD_RATES.contains(&rate)
    }
}

/// Exclusive/Hog mode configuration
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExclusiveMode {
    /// Shared mode (default, allows other apps to use device)
    Shared,
    /// Exclusive mode (hog the device for bit-perfect output)
    Exclusive,
}

impl Default for ExclusiveMode {
    fn default() -> Self {
        Self::Shared
    }
}

/// Device change event types
#[derive(Debug, Clone)]
pub enum DeviceEvent {
    /// A new device was connected
    DeviceAdded(DeviceInfo),
    /// A device was disconnected
    DeviceRemoved(String), // device ID
    /// Default device changed
    DefaultDeviceChanged(DeviceInfo),
    /// Device sample rate changed externally
    SampleRateChanged { device_id: String, new_rate: u32 },
}

/// Callback type for device change events
pub type DeviceEventCallback = Box<dyn Fn(DeviceEvent) + Send + Sync>;

/// Audio stream configuration
#[derive(Debug, Clone)]
pub struct StreamConfig {
    /// Target sample rate
    pub sample_rate: u32,
    /// Number of channels
    pub channels: u16,
    /// Buffer size hint (None = let backend decide)
    pub buffer_size: Option<u32>,
}

impl StreamConfig {
    /// Create a new stereo stream config
    pub fn stereo(sample_rate: u32) -> Self {
        Self {
            sample_rate,
            channels: 2,
            buffer_size: None,
        }
    }
}

/// Current audio output configuration (for UI display)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioOutputConfig {
    /// Current device info
    pub device: DeviceInfo,
    /// Current sample rate
    pub sample_rate: u32,
    /// Whether exclusive mode is active
    pub exclusive_mode: ExclusiveMode,
    /// Whether bit-perfect playback is possible
    pub bit_perfect_capable: bool,
}
