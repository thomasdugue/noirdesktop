// =============================================================================
// Ring Buffer Tests (Spec 3.1 - 3.6)
// Direct tests on ringbuf::HeapRb<f32> — the same lock-free ring buffer used
// by the audio engine for streaming decoded samples to the playback callback.
// =============================================================================

use std::thread;

use ringbuf::HeapRb;
use ringbuf::traits::{Consumer, Producer, Split, Observer};

// ---------------------------------------------------------------------------
// 3.1  Write N samples, read N samples — verify identity
// ---------------------------------------------------------------------------

#[test]
fn test_3_1_write_read_identity() {
    let capacity = 1024;
    let ring = HeapRb::<f32>::new(capacity);
    let (mut producer, mut consumer) = ring.split();

    // Write a known pattern
    let input: Vec<f32> = (0..512).map(|i| i as f32 / 512.0).collect();
    let written = producer.push_slice(&input);
    assert_eq!(written, 512, "should write all 512 samples");

    // Read back
    let mut output = vec![0.0f32; 512];
    let read = consumer.pop_slice(&mut output);
    assert_eq!(read, 512, "should read all 512 samples");

    // Verify identity
    for i in 0..512 {
        assert!((output[i] - input[i]).abs() < f32::EPSILON,
            "sample {} mismatch: expected {}, got {}", i, input[i], output[i]);
    }
}

// ---------------------------------------------------------------------------
// 3.2  Write more than capacity — should not panic, partial write
// ---------------------------------------------------------------------------

#[test]
fn test_3_2_overflow_no_panic() {
    let capacity = 256;
    let ring = HeapRb::<f32>::new(capacity);
    let (mut producer, _consumer) = ring.split();

    // Try to write more than capacity
    let input: Vec<f32> = vec![1.0; capacity + 100];
    let written = producer.push_slice(&input);

    // push_slice should write only up to capacity (ring may have capacity-1 or capacity usable slots)
    assert!(written <= capacity,
        "written ({}) should not exceed capacity ({})", written, capacity);
    assert!(written > 0, "should write at least some samples");

    // No panic — that's the main assertion
}

// ---------------------------------------------------------------------------
// 3.3  Read from empty buffer — should not panic, return 0
// ---------------------------------------------------------------------------

#[test]
fn test_3_3_read_empty_no_panic() {
    let capacity = 256;
    let ring = HeapRb::<f32>::new(capacity);
    let (_producer, mut consumer) = ring.split();

    let mut output = vec![0.0f32; 100];
    let read = consumer.pop_slice(&mut output);

    assert_eq!(read, 0, "reading from empty ring should return 0 samples");
}

// ---------------------------------------------------------------------------
// 3.4  Concurrent read/write from 2 threads — no data corruption
// ---------------------------------------------------------------------------

#[test]
fn test_3_4_concurrent_read_write() {
    let capacity = 4096;
    let total_samples = 100_000usize;
    let ring = HeapRb::<f32>::new(capacity);
    let (mut producer, mut consumer) = ring.split();

    // Writer thread: writes sequential values 0, 1, 2, ... as f32
    let writer = thread::spawn(move || {
        let mut written = 0usize;
        while written < total_samples {
            let batch_size = std::cmp::min(256, total_samples - written);
            let batch: Vec<f32> = (written..written + batch_size)
                .map(|i| i as f32)
                .collect();
            let n = producer.push_slice(&batch);
            written += n;
            if n == 0 {
                // Ring full, yield
                thread::yield_now();
            }
        }
        written
    });

    // Reader thread: reads and verifies sequential values
    let reader = thread::spawn(move || {
        let mut read_total = 0usize;
        let mut expected = 0usize;
        let mut buf = vec![0.0f32; 256];

        while read_total < total_samples {
            let n = consumer.pop_slice(&mut buf);
            for i in 0..n {
                let val = buf[i] as usize;
                assert_eq!(val, expected,
                    "data corruption at position {}: expected {}, got {}", read_total + i, expected, val);
                expected += 1;
            }
            read_total += n;
            if n == 0 {
                thread::yield_now();
            }
        }
        read_total
    });

    let total_written = writer.join().expect("writer thread panicked");
    let total_read = reader.join().expect("reader thread panicked");

    assert_eq!(total_written, total_samples, "writer should have written all samples");
    assert_eq!(total_read, total_samples, "reader should have read all samples");
}

// ---------------------------------------------------------------------------
// 3.5  Ring buffer capacity calculation matches audio engine expectations
// ---------------------------------------------------------------------------

#[test]
fn test_3_5_capacity_calculation() {
    // The audio engine uses: capacity = 5.0 * sample_rate * channels
    // For CD quality: 5.0 * 44100 * 2 = 441000
    let sample_rate = 44100u32;
    let channels = 2usize;
    let buffer_seconds = 5.0f64;

    let expected_capacity = (buffer_seconds * sample_rate as f64 * channels as f64) as usize;
    assert_eq!(expected_capacity, 441000, "CD quality ring should be 441000 samples");

    // Verify we can actually create a ring this large
    let ring = HeapRb::<f32>::new(expected_capacity);
    let (producer, consumer) = ring.split();

    // Memory footprint: 441000 * 4 bytes = ~1.7MB — very reasonable
    assert!(producer.vacant_len() > 0, "ring should have capacity");
    assert_eq!(consumer.occupied_len(), 0, "ring should start empty");

    // Hi-res 192kHz: 5.0 * 192000 * 2 = 1920000 (~7.7MB)
    let hires_capacity = (buffer_seconds * 192000.0 * channels as f64) as usize;
    let ring_hires = HeapRb::<f32>::new(hires_capacity);
    let (prod_hires, _cons_hires) = ring_hires.split();
    assert!(prod_hires.vacant_len() > 0, "hi-res ring should have capacity");
}

// ---------------------------------------------------------------------------
// 3.6  Wrap-around: write, read, write again past the internal boundary
// ---------------------------------------------------------------------------

#[test]
fn test_3_6_wrap_around_integrity() {
    let capacity = 64;
    let ring = HeapRb::<f32>::new(capacity);
    let (mut producer, mut consumer) = ring.split();

    // Fill 3/4 of the buffer
    let batch1: Vec<f32> = (0..48).map(|i| i as f32).collect();
    let w1 = producer.push_slice(&batch1);
    assert!(w1 > 0, "first write should succeed");

    // Read most of it back (consume 40 samples)
    let mut buf = vec![0.0f32; 40];
    let r1 = consumer.pop_slice(&mut buf);
    assert_eq!(r1, 40, "should read 40 samples");

    // Now the internal read pointer has advanced — write again, which will wrap around
    let batch2: Vec<f32> = (100..150).map(|i| i as f32).collect();
    let w2 = producer.push_slice(&batch2);
    assert!(w2 > 0, "wrap-around write should succeed");

    // Read remaining from batch1 + all of batch2
    let total_remaining = (w1 - 40) + w2;
    let mut result = vec![0.0f32; total_remaining];
    let mut read_so_far = 0;
    while read_so_far < total_remaining {
        let n = consumer.pop_slice(&mut result[read_so_far..]);
        read_so_far += n;
        if n == 0 {
            break;
        }
    }

    assert_eq!(read_so_far, total_remaining,
        "should read all remaining samples after wrap-around");

    // Verify the first part (remaining from batch1: indices 40..w1)
    for i in 0..(w1 - 40) {
        let expected = (40 + i) as f32;
        assert!((result[i] - expected).abs() < f32::EPSILON,
            "wrap-around batch1 remainder at {}: expected {}, got {}", i, expected, result[i]);
    }

    // Verify batch2 follows
    let offset = w1 - 40;
    for i in 0..w2 {
        let expected = (100 + i) as f32;
        assert!((result[offset + i] - expected).abs() < f32::EPSILON,
            "wrap-around batch2 at {}: expected {}, got {}", i, expected, result[offset + i]);
    }
}

// ---------------------------------------------------------------------------
// Additional: try_push / try_pop single element
// ---------------------------------------------------------------------------

#[test]
fn test_single_element_push_pop() {
    let ring = HeapRb::<f32>::new(4);
    let (mut producer, mut consumer) = ring.split();

    // Push one at a time
    assert!(producer.try_push(42.0).is_ok(), "push single should succeed");
    assert!(producer.try_push(43.0).is_ok(), "push single should succeed");

    // Pop one at a time
    assert_eq!(consumer.try_pop(), Some(42.0), "first pop should be 42.0");
    assert_eq!(consumer.try_pop(), Some(43.0), "second pop should be 43.0");
    assert_eq!(consumer.try_pop(), None, "empty pop should be None");
}

// ---------------------------------------------------------------------------
// Additional: stress test — many threads reading/writing to shared Arc
// ---------------------------------------------------------------------------

#[test]
fn test_stress_arc_shared() {
    // This simulates the pattern used in the audio engine where the producer
    // and consumer are on different threads communicating through the ring.
    let capacity = 8192;
    let ring = HeapRb::<f32>::new(capacity);
    let (producer, consumer) = ring.split();

    let iterations = 50_000usize;

    // We cannot clone producer/consumer (they're unique owners), but we can
    // move them into threads (same as audio engine pattern).
    let writer = thread::spawn(move || {
        let mut prod = producer;
        let mut written = 0usize;
        while written < iterations {
            match prod.try_push(written as f32) {
                Ok(()) => { written += 1; }
                Err(_) => { thread::yield_now(); }
            }
        }
        written
    });

    let reader = thread::spawn(move || {
        let mut cons = consumer;
        let mut read = 0usize;
        while read < iterations {
            match cons.try_pop() {
                Some(val) => {
                    assert_eq!(val as usize, read,
                        "mismatch at position {}: got {}", read, val as usize);
                    read += 1;
                }
                None => { thread::yield_now(); }
            }
        }
        read
    });

    let w = writer.join().expect("writer panicked");
    let r = reader.join().expect("reader panicked");

    assert_eq!(w, iterations);
    assert_eq!(r, iterations);
}
