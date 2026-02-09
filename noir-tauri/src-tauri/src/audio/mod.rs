//! Audio backend abstraction layer for Noir
//!
//! This module provides a cross-platform abstraction for audio device management,
//! sample rate control, and exclusive mode. The actual audio streaming is handled
//! by CPAL for cross-platform compatibility.
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────┐
//! │              Noir (AudioEngine)              │
//! │  Uses trait AudioBackend, doesn't know      │
//! │  which platform implementation is used      │
//! └─────────────┬───────────────────────────────┘
//!               │
//!               ▼
//! ┌─────────────────────────────────────────────┐
//! │         trait AudioBackend                   │
//! │  list_devices(), set_sample_rate()           │
//! │  set_exclusive_mode(), get_cpal_device()     │
//! └──────┬──────────────────────┬───────────────┘
//!        ▼                      ▼
//! ┌──────────────┐    ┌──────────────┐
//! │ CoreAudio    │    │ WASAPI       │
//! │ Backend      │    │ Backend      │
//! │ (macOS)      │    │ (Windows)    │
//! └──────────────┘    └──────────────┘
//! ```

pub mod backend;
pub mod error;
pub mod types;

#[cfg(target_os = "macos")]
pub mod coreaudio_backend;

// Future: Windows WASAPI backend
// #[cfg(target_os = "windows")]
// pub mod wasapi_backend;

// Re-exports for convenience
pub use backend::{create_backend, AudioBackend};
pub use error::{AudioBackendError, Result};
pub use types::*;
