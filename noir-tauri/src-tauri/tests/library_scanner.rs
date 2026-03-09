// =============================================================================
// Module 5 — Library Scanner Integration Tests
// =============================================================================
//
// Since `scan_folder_with_metadata` is a private `#[tauri::command]` and
// `TrackWithMetadata` / `Metadata` are `pub(crate)`, integration tests cannot
// import them directly. Instead, we test the UNDERLYING scanning logic using
// the same crates (`walkdir`, `lofty`) that the real scanner uses.
//
// This validates:
//   - Directory walking finds audio files and excludes non-audio files
//   - Metadata extraction via lofty returns correct tag values
//   - Sorting by disc_number then track_number
//   - Edge cases: empty dir, nonexistent dir, corrupted files, no-tag files

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Supported audio extensions — mirrors `is_audio_file()` in lib.rs
const AUDIO_EXTENSIONS: &[&str] = &["mp3", "flac", "wav", "m4a", "aac", "ogg", "aiff", "alac"];

/// Returns the absolute path to a test fixture file.
fn fixture_path(name: &str) -> String {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    format!("{}/tests/fixtures/{}", manifest_dir, name)
}

/// Returns the fixtures directory path.
fn fixtures_dir() -> String {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    format!("{}/tests/fixtures", manifest_dir)
}

/// Check if a file path has an audio extension (mirrors lib.rs logic).
fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Walk a directory and collect all audio file paths (mirrors scan_folder logic).
fn scan_audio_files(dir: &str) -> Vec<PathBuf> {
    let path = Path::new(dir);
    if !path.exists() || !path.is_dir() {
        return Vec::new();
    }

    WalkDir::new(dir)
        .follow_links(true)
        .max_depth(20)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file() && is_audio_file(e.path()))
        .map(|e| e.path().to_path_buf())
        .collect()
}

/// Simple struct to hold extracted metadata for sorting tests.
#[derive(Debug, Clone)]
#[allow(dead_code)]
struct TrackMeta {
    path: String,
    title: String,
    artist: String,
    album: String,
    track_number: u32,
    disc_number: Option<u32>,
}

/// Extract metadata from an audio file using lofty (mirrors get_metadata_internal logic).
fn extract_metadata(path: &str) -> Option<TrackMeta> {
    use lofty::{Accessor, Probe, TaggedFileExt};

    let tagged_file = Probe::open(path).ok()?.read().ok()?;
    let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag());

    let (title, artist, album, track_number, disc_number) = if let Some(t) = tag {
        (
            t.title().map(|s| s.to_string()).unwrap_or_default(),
            t.artist().map(|s| s.to_string()).unwrap_or_default(),
            t.album().map(|s| s.to_string()).unwrap_or_default(),
            t.track().unwrap_or(0),
            t.disk(),
        )
    } else {
        (String::new(), String::new(), String::new(), 0, None)
    };

    Some(TrackMeta {
        path: path.to_string(),
        title,
        artist,
        album,
        track_number,
        disc_number,
    })
}

// =========================================================================
// Test 5.1 — Scan fixtures directory finds all audio files
// =========================================================================
#[test]
fn test_5_1_scan_finds_audio_files() {
    let files = scan_audio_files(&fixtures_dir());
    // Fixtures should contain: FLAC (x8+), WAV (x1), AIFF (x1), MP3 (x2), M4A (x1)
    // Excludes: .txt, .generated
    assert!(
        files.len() >= 10,
        "Expected at least 10 audio files in fixtures, found {}",
        files.len()
    );

    // All returned files must have audio extensions
    for f in &files {
        assert!(
            is_audio_file(f),
            "Non-audio file found in scan results: {:?}",
            f
        );
    }
}

// =========================================================================
// Test 5.2 — Non-audio files are excluded
// =========================================================================
#[test]
fn test_5_2_non_audio_files_excluded() {
    let files = scan_audio_files(&fixtures_dir());

    let extensions: HashSet<String> = files
        .iter()
        .filter_map(|f| f.extension().and_then(|e| e.to_str()).map(|s| s.to_lowercase()))
        .collect();

    // .txt must not be in results
    assert!(
        !extensions.contains("txt"),
        "Scanner should exclude .txt files"
    );

    // Verify the .txt fixture file actually exists (sanity check)
    let txt_path = fixture_path("test_notaudio.txt");
    assert!(
        Path::new(&txt_path).exists(),
        "test_notaudio.txt fixture should exist"
    );
}

// =========================================================================
// Test 5.3 — Scan empty directory returns empty vec
// =========================================================================
#[test]
fn test_5_3_scan_empty_directory() {
    let temp_dir = std::env::temp_dir().join("noir_test_empty_dir_5_3");
    let _ = std::fs::create_dir_all(&temp_dir);

    let files = scan_audio_files(temp_dir.to_str().unwrap());
    assert!(files.is_empty(), "Scanning empty dir should return no files");

    let _ = std::fs::remove_dir_all(&temp_dir);
}

// =========================================================================
// Test 5.4 — Scan nonexistent directory returns empty vec
// =========================================================================
#[test]
fn test_5_4_scan_nonexistent_directory() {
    let files = scan_audio_files("/nonexistent/path/that/does/not/exist");
    assert!(
        files.is_empty(),
        "Scanning nonexistent dir should return no files"
    );
}

// =========================================================================
// Test 5.5 — Deduplication: same path scanned twice yields no duplicates
// =========================================================================
#[test]
fn test_5_5_deduplication_same_path() {
    let files_a = scan_audio_files(&fixtures_dir());
    let files_b = scan_audio_files(&fixtures_dir());

    // Merge both scans (simulating scanning the same folder twice)
    let mut all_paths: Vec<String> = files_a
        .iter()
        .chain(files_b.iter())
        .map(|p| p.to_string_lossy().to_string())
        .collect();

    let count_before = all_paths.len();

    // Deduplicate by path (mirrors lib.rs dedup logic)
    let mut seen = HashSet::new();
    all_paths.retain(|p| seen.insert(p.clone()));

    let count_after = all_paths.len();
    assert_eq!(
        count_before,
        count_after * 2,
        "Two identical scans should produce exact duplicates that dedup removes"
    );
    assert_eq!(
        count_after,
        files_a.len(),
        "After dedup, count should match a single scan"
    );
}

// =========================================================================
// Test 5.6 — Metadata extraction: FLAC with tags
// =========================================================================
#[test]
fn test_5_6_metadata_extraction_flac_with_tags() {
    let path = fixture_path("test_44100_16.flac");
    let meta = extract_metadata(&path).expect("Should extract metadata from FLAC");

    assert_eq!(meta.title, "Test 44.1", "Title should match fixture tag");
    assert_eq!(meta.artist, "Noir Test", "Artist should match fixture tag");
    assert_eq!(meta.album, "Test Album", "Album should match fixture tag");
    assert_eq!(meta.track_number, 1, "Track number should be 1");
}

// =========================================================================
// Test 5.7 — Metadata extraction: MP3 with ID3 tags
// =========================================================================
#[test]
fn test_5_7_metadata_extraction_mp3_with_tags() {
    let path = fixture_path("test_320.mp3");
    let meta = extract_metadata(&path).expect("Should extract metadata from MP3");

    assert_eq!(meta.title, "Test MP3 320", "Title should match fixture tag");
    assert_eq!(meta.artist, "Noir Test", "Artist should match fixture tag");
    assert_eq!(meta.album, "Test Album", "Album should match fixture tag");
    assert_eq!(meta.track_number, 4, "Track number should be 4");
}

// =========================================================================
// Test 5.8 — Metadata extraction: file without tags returns empty strings
// =========================================================================
#[test]
fn test_5_8_metadata_extraction_no_tags() {
    let path = fixture_path("test_no_tags.flac");
    let meta = extract_metadata(&path).expect("Should parse file even without tags");

    // No tags means empty or default values
    assert!(
        meta.title.is_empty(),
        "Title should be empty when no tags: got '{}'",
        meta.title
    );
    assert!(
        meta.artist.is_empty(),
        "Artist should be empty when no tags: got '{}'",
        meta.artist
    );
}

// =========================================================================
// Test 5.9 — Sort by disc_number then track_number (multi-disc)
// =========================================================================
#[test]
fn test_5_9_sort_by_disc_then_track() {
    let multidisc_files = [
        fixture_path("test_multidisc_d2t1.flac"), // disc 2, track 1
        fixture_path("test_multidisc_d1t2.flac"), // disc 1, track 2
        fixture_path("test_multidisc_d1t1.flac"), // disc 1, track 1
    ];

    let mut tracks: Vec<TrackMeta> = multidisc_files
        .iter()
        .filter_map(|p| extract_metadata(p))
        .collect();

    assert_eq!(
        tracks.len(),
        3,
        "Should extract metadata from all 3 multi-disc files"
    );

    // Sort by disc_number ASC, then track_number ASC (mirrors Noir's sorting)
    tracks.sort_by(|a, b| {
        let disc_a = a.disc_number.unwrap_or(1);
        let disc_b = b.disc_number.unwrap_or(1);
        disc_a.cmp(&disc_b).then(a.track_number.cmp(&b.track_number))
    });

    // Expected order: D1T1, D1T2, D2T1
    assert_eq!(tracks[0].title, "Disc 1 Track 1");
    assert_eq!(tracks[1].title, "Disc 1 Track 2");
    assert_eq!(tracks[2].title, "Disc 2 Track 1");

    assert_eq!(tracks[0].disc_number, Some(1));
    assert_eq!(tracks[1].disc_number, Some(1));
    assert_eq!(tracks[2].disc_number, Some(2));

    assert_eq!(tracks[0].track_number, 1);
    assert_eq!(tracks[1].track_number, 2);
    assert_eq!(tracks[2].track_number, 1);
}

// =========================================================================
// Test 5.10 — All supported audio extensions are recognized
// =========================================================================
#[test]
fn test_5_10_all_audio_extensions_recognized() {
    // These are the extensions from the real is_audio_file() in lib.rs
    let expected: &[&str] = &["mp3", "flac", "wav", "m4a", "aac", "ogg", "aiff", "alac"];

    for ext in expected {
        let fake_path = PathBuf::from(format!("/tmp/test.{}", ext));
        assert!(
            is_audio_file(&fake_path),
            "Extension '{}' should be recognized as audio",
            ext
        );
    }

    // Negative cases: should NOT be recognized
    let non_audio = &["txt", "jpg", "png", "pdf", "zip", "wma", "dsd", "opus"];
    for ext in non_audio {
        let fake_path = PathBuf::from(format!("/tmp/test.{}", ext));
        assert!(
            !is_audio_file(&fake_path),
            "Extension '{}' should NOT be recognized as audio",
            ext
        );
    }
}
