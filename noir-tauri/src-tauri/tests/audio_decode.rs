// =============================================================================
// Audio Decode Tests (Spec 1.1 - 1.11)
// Tests probe_audio_file and start_streaming for every supported format.
// =============================================================================

use noir_tauri_lib::audio_decoder::{probe_audio_file, start_streaming};

/// Helper: absolute path to a fixture file.
fn fixture_path(name: &str) -> String {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    format!("{}/tests/fixtures/{}", manifest_dir, name)
}

// ---------------------------------------------------------------------------
// 1.1  FLAC 16-bit / 44.1 kHz
// ---------------------------------------------------------------------------

#[test]
fn test_1_1_probe_flac_44100_16() {
    let path = fixture_path("test_44100_16.flac");
    let info = probe_audio_file(&path).expect("probe_audio_file should succeed for FLAC 44.1/16");

    assert_eq!(info.sample_rate, 44100, "sample rate should be 44100");
    assert_eq!(info.bit_depth, 16, "bit depth should be 16");
    assert_eq!(info.channels, 1, "mono sine fixture has 1 channel");
    assert!(info.duration_seconds > 2.9 && info.duration_seconds < 3.1,
        "duration should be ~3s, got {}", info.duration_seconds);
    assert!(info.total_frames > 0, "total_frames should be > 0");
}

#[test]
fn test_1_1_stream_flac_44100_16() {
    let path = fixture_path("test_44100_16.flac");
    let mut session = start_streaming(&path)
        .expect("start_streaming should succeed for FLAC 44.1/16");

    let consumer = session.take_consumer();
    assert!(consumer.is_some(), "take_consumer should return Some on first call");

    let consumer_again = session.take_consumer();
    assert!(consumer_again.is_none(), "take_consumer should return None on second call");

    session.stop();
}

// ---------------------------------------------------------------------------
// 1.2  FLAC 24-bit / 96 kHz
// ---------------------------------------------------------------------------

#[test]
fn test_1_2_probe_flac_96000_24() {
    let path = fixture_path("test_96000_24.flac");
    let info = probe_audio_file(&path).expect("probe_audio_file should succeed for FLAC 96/24");

    assert_eq!(info.sample_rate, 96000, "sample rate should be 96000");
    // Note: ffmpeg generates s32 FLAC even when we ask for 24-bit — Symphonia may
    // report 24 or 32 depending on the container.  We accept either.
    assert!(info.bit_depth == 24 || info.bit_depth == 32,
        "bit depth should be 24 or 32, got {}", info.bit_depth);
    assert!(info.duration_seconds > 2.9, "duration should be ~3s");
}

#[test]
fn test_1_2_stream_flac_96000_24() {
    let path = fixture_path("test_96000_24.flac");
    let mut session = start_streaming(&path)
        .expect("start_streaming should succeed for FLAC 96/24");

    assert!(session.take_consumer().is_some(), "consumer should be available");
    session.stop();
}

// ---------------------------------------------------------------------------
// 1.3  FLAC 24-bit / 192 kHz
// ---------------------------------------------------------------------------

#[test]
fn test_1_3_probe_flac_192000_24() {
    let path = fixture_path("test_192000_24.flac");
    let info = probe_audio_file(&path).expect("probe_audio_file should succeed for FLAC 192/24");

    assert_eq!(info.sample_rate, 192000, "sample rate should be 192000");
    assert!(info.bit_depth == 24 || info.bit_depth == 32,
        "bit depth should be 24 or 32, got {}", info.bit_depth);
    assert!(info.duration_seconds > 2.9, "duration should be ~3s");
}

#[test]
fn test_1_3_stream_flac_192000_24() {
    let path = fixture_path("test_192000_24.flac");
    let mut session = start_streaming(&path)
        .expect("start_streaming should succeed for FLAC 192/24");

    assert!(session.take_consumer().is_some(), "consumer should be available");
    session.stop();
}

// ---------------------------------------------------------------------------
// 1.4  WAV 16-bit / 44.1 kHz
// ---------------------------------------------------------------------------

#[test]
fn test_1_4_probe_wav_44100_16() {
    let path = fixture_path("test_44100_16.wav");
    let info = probe_audio_file(&path).expect("probe_audio_file should succeed for WAV");

    assert_eq!(info.sample_rate, 44100, "sample rate should be 44100");
    assert_eq!(info.bit_depth, 16, "bit depth should be 16");
    assert!(info.duration_seconds > 2.9, "duration should be ~3s");
}

#[test]
fn test_1_4_stream_wav_44100_16() {
    let path = fixture_path("test_44100_16.wav");
    let mut session = start_streaming(&path)
        .expect("start_streaming should succeed for WAV");

    assert!(session.take_consumer().is_some(), "consumer should be available");
    session.stop();
}

// ---------------------------------------------------------------------------
// 1.5  AIFF 16-bit / 44.1 kHz
// ---------------------------------------------------------------------------

#[test]
fn test_1_5_probe_aiff_44100_16() {
    let path = fixture_path("test_44100_16.aiff");
    let info = probe_audio_file(&path).expect("probe_audio_file should succeed for AIFF");

    assert_eq!(info.sample_rate, 44100, "sample rate should be 44100");
    assert_eq!(info.bit_depth, 16, "bit depth should be 16");
    assert!(info.duration_seconds > 2.9, "duration should be ~3s");
}

#[test]
fn test_1_5_stream_aiff_44100_16() {
    let path = fixture_path("test_44100_16.aiff");
    let mut session = start_streaming(&path)
        .expect("start_streaming should succeed for AIFF");

    assert!(session.take_consumer().is_some(), "consumer should be available");
    session.stop();
}

// ---------------------------------------------------------------------------
// 1.6  MP3 320 kbps CBR
// ---------------------------------------------------------------------------

#[test]
fn test_1_6_probe_mp3_320() {
    let path = fixture_path("test_320.mp3");
    let info = probe_audio_file(&path).expect("probe_audio_file should succeed for MP3 320");

    assert_eq!(info.sample_rate, 44100, "sample rate should be 44100");
    // MP3 is lossy — Symphonia reports the decoded sample depth, typically 32 or
    // the container might report 16/24.  We just verify it's non-zero.
    assert!(info.bit_depth > 0, "bit depth should be > 0, got {}", info.bit_depth);
    assert!(info.duration_seconds > 2.5, "duration should be ~3s, got {}", info.duration_seconds);
}

#[test]
fn test_1_6_stream_mp3_320() {
    let path = fixture_path("test_320.mp3");
    let mut session = start_streaming(&path)
        .expect("start_streaming should succeed for MP3 320");

    assert!(session.take_consumer().is_some(), "consumer should be available");
    session.stop();
}

// ---------------------------------------------------------------------------
// 1.7  MP3 VBR
// ---------------------------------------------------------------------------

#[test]
fn test_1_7_probe_mp3_vbr() {
    let path = fixture_path("test_vbr.mp3");
    let info = probe_audio_file(&path).expect("probe_audio_file should succeed for MP3 VBR");

    assert_eq!(info.sample_rate, 44100, "sample rate should be 44100");
    assert!(info.bit_depth > 0, "bit depth should be > 0");
    assert!(info.duration_seconds > 2.0, "duration should be > 2s, got {}", info.duration_seconds);
}

#[test]
fn test_1_7_stream_mp3_vbr() {
    let path = fixture_path("test_vbr.mp3");
    let mut session = start_streaming(&path)
        .expect("start_streaming should succeed for MP3 VBR");

    assert!(session.take_consumer().is_some(), "consumer should be available");
    session.stop();
}

// ---------------------------------------------------------------------------
// 1.8  ALAC (M4A container)
// ---------------------------------------------------------------------------

#[test]
fn test_1_8_probe_alac_m4a() {
    let path = fixture_path("test_alac.m4a");
    let info = probe_audio_file(&path).expect("probe_audio_file should succeed for ALAC/M4A");

    assert_eq!(info.sample_rate, 44100, "sample rate should be 44100");
    // ALAC typically reports 16 or 24 bit depth via lofty
    assert!(info.bit_depth > 0, "bit depth should be > 0, got {}", info.bit_depth);
    assert!(info.duration_seconds > 2.5, "duration should be ~3s, got {}", info.duration_seconds);
}

#[test]
fn test_1_8_stream_alac_m4a() {
    let path = fixture_path("test_alac.m4a");
    let mut session = start_streaming(&path)
        .expect("start_streaming should succeed for ALAC/M4A");

    assert!(session.take_consumer().is_some(), "consumer should be available");
    session.stop();
}

// ---------------------------------------------------------------------------
// 1.9  Corrupted file — probe should return Err
// ---------------------------------------------------------------------------

#[test]
fn test_1_9_probe_corrupted_returns_error() {
    let path = fixture_path("test_corrupted.flac");
    let result = probe_audio_file(&path);

    assert!(result.is_err(),
        "probe_audio_file should return Err for corrupted file, got: {:?}", result);
}

#[test]
fn test_1_9_stream_corrupted_returns_error() {
    let path = fixture_path("test_corrupted.flac");
    let result = start_streaming(&path);

    assert!(result.is_err(),
        "start_streaming should return Err for corrupted file, got Ok");
}

// ---------------------------------------------------------------------------
// 1.10  Non-audio file — probe should return Err
// ---------------------------------------------------------------------------

#[test]
fn test_1_10_probe_non_audio_returns_error() {
    let path = fixture_path("test_notaudio.txt");
    let result = probe_audio_file(&path);

    assert!(result.is_err(),
        "probe_audio_file should return Err for non-audio file, got: {:?}", result);
}

#[test]
fn test_1_10_stream_non_audio_returns_error() {
    let path = fixture_path("test_notaudio.txt");
    let result = start_streaming(&path);

    assert!(result.is_err(),
        "start_streaming should return Err for non-audio file, got Ok");
}

// ---------------------------------------------------------------------------
// 1.11  Empty FLAC (near-zero samples) — should not panic
// ---------------------------------------------------------------------------

#[test]
fn test_1_11_probe_empty_flac_no_panic() {
    let path = fixture_path("test_empty.flac");
    // Should not panic — may return Ok with very small duration, or Err.
    let result = probe_audio_file(&path);
    match &result {
        Ok(info) => {
            // If it succeeds, duration should be very short
            assert!(info.duration_seconds < 1.0,
                "empty file duration should be < 1s, got {}", info.duration_seconds);
        }
        Err(e) => {
            // Acceptable: an error is fine for an effectively empty file
            eprintln!("probe_audio_file returned Err for empty file (acceptable): {}", e);
        }
    }
}

#[test]
fn test_1_11_stream_empty_flac_no_panic() {
    let path = fixture_path("test_empty.flac");
    // Should not panic. May succeed (with a very short decode) or fail gracefully.
    let result = start_streaming(&path);
    match result {
        Ok(mut session) => {
            // If it succeeds, the consumer should be available
            let _consumer: Option<noir_tauri_lib::audio_decoder::AudioConsumer> = session.take_consumer();
            session.stop();
        }
        Err(e) => {
            eprintln!("start_streaming returned Err for empty file (acceptable): {}", e);
        }
    }
}

// ---------------------------------------------------------------------------
// Additional: non-existent file
// ---------------------------------------------------------------------------

#[test]
fn test_probe_nonexistent_file_returns_error() {
    let result = probe_audio_file("/nonexistent/path/fake.flac");
    assert!(result.is_err(), "probe_audio_file should return Err for nonexistent file");
}

#[test]
fn test_stream_nonexistent_file_returns_error() {
    let result = start_streaming("/nonexistent/path/fake.flac");
    assert!(result.is_err(), "start_streaming should return Err for nonexistent file");
}

// ---------------------------------------------------------------------------
// Additional: AudioInfo fields consistency
// ---------------------------------------------------------------------------

#[test]
fn test_audio_info_output_sample_rate_equals_source_when_no_resampling() {
    let path = fixture_path("test_44100_16.flac");
    let info = probe_audio_file(&path).expect("probe should succeed");

    assert_eq!(info.sample_rate, info.output_sample_rate,
        "output_sample_rate should equal sample_rate when not resampling");
    assert!(!info.is_resampled, "is_resampled should be false for probe");
}
