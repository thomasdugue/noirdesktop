// =============================================================================
// Audio Seek Tests (Spec 2.1 - 2.9)
// Tests start_streaming_at and session.seek() on FLAC files.
// =============================================================================

use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;

use noir_tauri_lib::audio_decoder::{probe_audio_file, start_streaming, start_streaming_at};

/// Helper: absolute path to a fixture file.
fn fixture_path(name: &str) -> String {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    format!("{}/tests/fixtures/{}", manifest_dir, name)
}

/// Wait for the decoder thread to advance a bit after a seek.
/// The decoder needs time to process packets and update the streaming state.
fn wait_for_decoder(ms: u64) {
    thread::sleep(Duration::from_millis(ms));
}

// ---------------------------------------------------------------------------
// 2.1  Start streaming at position 0 — position should be near 0
// ---------------------------------------------------------------------------

#[test]
fn test_2_1_start_at_zero() {
    let path = fixture_path("test_44100_16.flac");
    let mut session = start_streaming(&path)
        .expect("start_streaming should succeed");

    let _consumer = session.take_consumer();

    // Position at start should be 0 (or very close)
    let pos = session.state.position_seconds();
    assert!(pos < 0.5,
        "initial position should be near 0, got {:.3}s", pos);

    session.stop();
}

// ---------------------------------------------------------------------------
// 2.2  Start streaming at a specific time (1.0s)
// ---------------------------------------------------------------------------

#[test]
fn test_2_2_start_at_specific_time() {
    let path = fixture_path("test_44100_16.flac");
    let mut session = start_streaming_at(&path, 1.0)
        .expect("start_streaming_at should succeed");

    let _consumer = session.take_consumer();

    // After starting at 1.0s, the stored position should reflect that.
    // The playback_position atomic is set during the initial seek in start_streaming_with_config.
    let pos = session.state.position_seconds();
    assert!(pos >= 0.5 && pos <= 2.0,
        "position after start_at(1.0) should be ~1.0s, got {:.3}s", pos);

    session.stop();
}

// ---------------------------------------------------------------------------
// 2.3  Seek to 50% (~1.5s on a 3s file)
// ---------------------------------------------------------------------------

#[test]
fn test_2_3_seek_to_50_percent() {
    let path = fixture_path("test_44100_16.flac");
    let info = probe_audio_file(&path).expect("probe should succeed");
    let midpoint = info.duration_seconds / 2.0;

    let mut session = start_streaming(&path)
        .expect("start_streaming should succeed");

    let _consumer = session.take_consumer();

    // Seek to midpoint
    session.seek(midpoint).expect("seek should succeed");

    // Give the decoder time to process the seek
    wait_for_decoder(500);

    // The seek_position atomic should be set to the target
    let seek_pos = session.state.seek_position.load(Ordering::Relaxed);
    assert!(seek_pos > 0, "seek_position should be set after seek");

    session.stop();
}

// ---------------------------------------------------------------------------
// 2.4  Seek to the very beginning (0.0s)
// ---------------------------------------------------------------------------

#[test]
fn test_2_4_seek_to_beginning() {
    let path = fixture_path("test_44100_16.flac");
    let mut session = start_streaming_at(&path, 1.0)
        .expect("start_streaming_at should succeed");

    let _consumer = session.take_consumer();

    // Seek back to 0
    session.seek(0.0).expect("seek to 0 should succeed");

    wait_for_decoder(500);

    // After seeking to 0, the seek_position should be 0
    let seek_pos = session.state.seek_position.load(Ordering::Relaxed);
    assert_eq!(seek_pos, 0, "seek_position should be 0 after seeking to start");

    session.stop();
}

// ---------------------------------------------------------------------------
// 2.5  Seek to end of file — should not panic
// ---------------------------------------------------------------------------

#[test]
fn test_2_5_seek_to_end_no_panic() {
    let path = fixture_path("test_44100_16.flac");
    let info = probe_audio_file(&path).expect("probe should succeed");

    let mut session = start_streaming(&path)
        .expect("start_streaming should succeed");

    let _consumer = session.take_consumer();

    // Seek to the very end (or slightly beyond)
    let result = session.seek(info.duration_seconds);
    // Should not panic; the seek itself may succeed or fail gracefully
    match result {
        Ok(()) => {
            wait_for_decoder(500);
            // Decoder should mark as complete soon after
        }
        Err(e) => {
            eprintln!("seek to end returned Err (acceptable): {}", e);
        }
    }

    session.stop();
}

// ---------------------------------------------------------------------------
// 2.6  Seek beyond file duration — should not panic
// ---------------------------------------------------------------------------

#[test]
fn test_2_6_seek_beyond_duration_no_panic() {
    let path = fixture_path("test_44100_16.flac");
    let info = probe_audio_file(&path).expect("probe should succeed");

    let mut session = start_streaming(&path)
        .expect("start_streaming should succeed");

    let _consumer = session.take_consumer();

    // Seek way past the end
    let result = session.seek(info.duration_seconds + 100.0);
    match result {
        Ok(()) => {
            wait_for_decoder(500);
            // Should not crash, decoder should handle gracefully
        }
        Err(e) => {
            eprintln!("seek beyond duration returned Err (acceptable): {}", e);
        }
    }

    session.stop();
}

// ---------------------------------------------------------------------------
// 2.7  Multiple rapid seeks — should not panic or deadlock
// ---------------------------------------------------------------------------

#[test]
fn test_2_7_multiple_rapid_seeks_no_panic() {
    let path = fixture_path("test_44100_16.flac");
    let info = probe_audio_file(&path).expect("probe should succeed");

    let mut session = start_streaming(&path)
        .expect("start_streaming should succeed");

    let _consumer = session.take_consumer();

    // Fire 10 rapid seeks to different positions
    let duration = info.duration_seconds;
    for i in 0..10 {
        let target = (i as f64 / 10.0) * duration;
        let _ = session.seek(target);
        // Minimal delay to simulate rapid seeking
        thread::sleep(Duration::from_millis(20));
    }

    // Give decoder time to settle
    wait_for_decoder(300);

    // Main assertion: we got here without panicking or deadlocking
    session.stop();
}

// ---------------------------------------------------------------------------
// 2.8  Seek negative time — should not panic
// ---------------------------------------------------------------------------

#[test]
fn test_2_8_seek_negative_time_no_panic() {
    let path = fixture_path("test_44100_16.flac");
    let mut session = start_streaming(&path)
        .expect("start_streaming should succeed");

    let _consumer = session.take_consumer();

    // Seek to a negative time — should not panic
    let result = session.seek(-1.0);
    match result {
        Ok(()) => {
            wait_for_decoder(300);
        }
        Err(e) => {
            eprintln!("seek to negative time returned Err (acceptable): {}", e);
        }
    }

    session.stop();
}

// ---------------------------------------------------------------------------
// 2.9  Streaming state atomics are consistent after seek
// ---------------------------------------------------------------------------

#[test]
fn test_2_9_streaming_state_atomics_after_seek() {
    let path = fixture_path("test_44100_16.flac");
    let info = probe_audio_file(&path).expect("probe should succeed");

    let mut session = start_streaming(&path)
        .expect("start_streaming should succeed");

    let _consumer = session.take_consumer();

    // Verify initial state
    assert!(!session.state.decoding_complete.load(Ordering::Relaxed),
        "decoding should not be complete immediately");
    assert_eq!(session.state.info.sample_rate, 44100,
        "info.sample_rate should match the file");
    assert_eq!(session.state.info.channels, 1,
        "info.channels should be 1 for mono fixture");

    // Seek to 1.0s
    session.seek(1.0).expect("seek should succeed");

    // Immediately after sending seek command, the seeking flag should be set
    // (it's set by seek() before sending the command)
    let seeking = session.state.seeking.load(Ordering::Relaxed);
    // Note: this could already be false if the decoder thread processed it very fast
    // So we just log rather than assert
    eprintln!("seeking flag immediately after seek(): {}", seeking);

    wait_for_decoder(500);

    // After the decoder has had time to process, seeking should be false
    let seeking_after = session.state.seeking.load(Ordering::Relaxed);
    assert!(!seeking_after,
        "seeking should be false after decoder processes the seek");

    // The ring_capacity should match expectations (5s * sample_rate * channels)
    let expected_capacity = (5.0 * info.sample_rate as f64 * info.channels as f64) as usize;
    assert_eq!(session.state.ring_capacity, expected_capacity,
        "ring_capacity should be 5s worth of samples");

    session.stop();
}

// ---------------------------------------------------------------------------
// Additional: start_streaming_at with hi-res file (96kHz)
// ---------------------------------------------------------------------------

#[test]
fn test_seek_hires_96k() {
    let path = fixture_path("test_96000_24.flac");
    let mut session = start_streaming_at(&path, 1.5)
        .expect("start_streaming_at should succeed for 96kHz file");

    let _consumer = session.take_consumer();

    let pos = session.state.position_seconds();
    assert!(pos >= 0.5 && pos <= 2.5,
        "position after start_at(1.5) on 96kHz file should be ~1.5s, got {:.3}s", pos);

    // Seek back to 0.5s
    session.seek(0.5).expect("seek should succeed");
    wait_for_decoder(500);

    session.stop();
}

// ---------------------------------------------------------------------------
// Additional: stop after seek does not panic
// ---------------------------------------------------------------------------

#[test]
fn test_stop_immediately_after_seek() {
    let path = fixture_path("test_44100_16.flac");
    let mut session = start_streaming(&path)
        .expect("start_streaming should succeed");

    let _consumer = session.take_consumer();

    // Seek and immediately stop — should not deadlock
    let _ = session.seek(1.0);
    session.stop();
    // If we reach here without deadlock or panic, test passes
}
