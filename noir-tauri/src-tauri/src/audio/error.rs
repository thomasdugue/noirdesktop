//! Audio backend error types
//!
//! This module defines unified error types for all audio backend operations.
//! Platform-specific errors are mapped to these generic error variants.

use std::fmt;

/// Unified error type for audio backend operations
#[derive(Debug, Clone)]
pub enum AudioBackendError {
    /// Device not found or unavailable
    DeviceNotFound(String),
    /// Failed to enumerate devices
    DeviceEnumerationFailed(String),
    /// Sample rate not supported by device
    UnsupportedSampleRate(u32),
    /// Failed to set sample rate
    SampleRateChangeFailed { requested: u32, reason: String },
    /// Exclusive mode not available or failed
    ExclusiveModeFailed(String),
    /// Stream creation failed
    StreamCreationFailed(String),
    /// HAL/System API error
    SystemError { code: i32, message: String },
    /// Operation not supported on this platform
    NotSupported(String),
    /// Generic error
    Other(String),
}

impl fmt::Display for AudioBackendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DeviceNotFound(name) => write!(f, "Device not found: {}", name),
            Self::DeviceEnumerationFailed(e) => write!(f, "Device enumeration failed: {}", e),
            Self::UnsupportedSampleRate(rate) => write!(f, "Unsupported sample rate: {} Hz", rate),
            Self::SampleRateChangeFailed { requested, reason } => {
                write!(f, "Failed to set sample rate to {} Hz: {}", requested, reason)
            }
            Self::ExclusiveModeFailed(e) => write!(f, "Exclusive mode failed: {}", e),
            Self::StreamCreationFailed(e) => write!(f, "Stream creation failed: {}", e),
            Self::SystemError { code, message } => write!(f, "System error {}: {}", code, message),
            Self::NotSupported(op) => write!(f, "Not supported: {}", op),
            Self::Other(e) => write!(f, "{}", e),
        }
    }
}

impl std::error::Error for AudioBackendError {}

/// Result type alias for audio backend operations
pub type Result<T> = std::result::Result<T, AudioBackendError>;
