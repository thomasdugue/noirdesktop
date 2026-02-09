//! Audio backend abstraction layer for Noir
//!
//! This module provides:
//! 1. AudioBackend trait - device control (sample rate, hog mode, device selection)
//! 2. AudioOutputStream trait - audio streaming with instant seek via reset()
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────┐
//! │              Noir (AudioEngine)              │
//! │  Uses AudioBackend for device control        │
//! │  Uses AudioOutputStream for streaming        │
//! └─────────────┬───────────────────────────────┘
//!               │
//!       ┌───────┴───────┐
//!       ▼               ▼
//! ┌───────────┐  ┌───────────────┐
//! │ Backend   │  │ OutputStream  │
//! │ (device)  │  │ (streaming)   │
//! └─────┬─────┘  └───────┬───────┘
//!       │                │
//!       ▼                ▼
//! ┌──────────────────────────────┐
//! │  CoreAudio (macOS)           │
//! │  - coreaudio_backend.rs      │
//! │  - coreaudio_stream.rs       │
//! └──────────────────────────────┘
//! ```

pub mod backend;
pub mod error;
pub mod types;
pub mod stream;

#[cfg(target_os = "macos")]
pub mod coreaudio_backend;

#[cfg(target_os = "macos")]
pub mod coreaudio_stream;

// Future: Windows WASAPI backend
// #[cfg(target_os = "windows")]
// pub mod wasapi_backend;
// pub mod wasapi_stream;

// Re-exports for convenience
pub use backend::{create_backend, AudioBackend};
pub use error::{AudioBackendError, Result};
pub use types::*;
pub use stream::{AudioOutputStream, AudioStreamConfig, create_audio_stream};
