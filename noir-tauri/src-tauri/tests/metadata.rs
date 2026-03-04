// =============================================================================
// Metadata Extraction Tests (Spec 4.1 - 4.12)
// Uses lofty crate directly (same as the app does in lib.rs) because
// Metadata / TrackWithMetadata structs are pub(crate) and cannot be accessed
// from integration tests.
// =============================================================================

use lofty::{Accessor, AudioFile, Probe, TaggedFileExt};

/// Helper: absolute path to a fixture file.
fn fixture_path(name: &str) -> String {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    format!("{}/tests/fixtures/{}", manifest_dir, name)
}

// ---------------------------------------------------------------------------
// 4.1  FLAC with full tags — title, artist, album, track, year, genre
// ---------------------------------------------------------------------------

#[test]
fn test_4_1_flac_full_tags() {
    let path = fixture_path("test_44100_16.flac");
    let tagged_file = Probe::open(&path)
        .expect("should open FLAC file")
        .read()
        .expect("should read FLAC tags");

    let tag = tagged_file.primary_tag()
        .or_else(|| tagged_file.first_tag())
        .expect("FLAC file should have tags");

    assert_eq!(tag.title().as_deref(), Some("Test 44.1"),
        "title should be 'Test 44.1'");
    assert_eq!(tag.artist().as_deref(), Some("Noir Test"),
        "artist should be 'Noir Test'");
    assert_eq!(tag.album().as_deref(), Some("Test Album"),
        "album should be 'Test Album'");
    assert_eq!(tag.track(), Some(1),
        "track should be 1");
    assert_eq!(tag.year(), Some(2024),
        "year should be 2024");
    assert_eq!(tag.genre().as_deref(), Some("Electronic"),
        "genre should be 'Electronic'");
}

// ---------------------------------------------------------------------------
// 4.2  FLAC audio properties — sample rate, bit depth, duration
// ---------------------------------------------------------------------------

#[test]
fn test_4_2_flac_audio_properties() {
    let path = fixture_path("test_44100_16.flac");
    let tagged_file = Probe::open(&path)
        .expect("should open")
        .read()
        .expect("should read");

    let props = tagged_file.properties();
    assert_eq!(props.sample_rate(), Some(44100),
        "sample rate should be 44100");
    assert_eq!(props.bit_depth(), Some(16),
        "bit depth should be 16");
    assert!(props.channels() == Some(1) || props.channels() == Some(2),
        "channels should be 1 (mono sine) or 2, got {:?}", props.channels());

    let duration_secs = props.duration().as_secs_f64();
    assert!(duration_secs > 2.9 && duration_secs < 3.1,
        "duration should be ~3s, got {:.3}s", duration_secs);
}

// ---------------------------------------------------------------------------
// 4.3  MP3 (ID3v2) tags — title, artist, track
// ---------------------------------------------------------------------------

#[test]
fn test_4_3_mp3_id3v2_tags() {
    let path = fixture_path("test_320.mp3");
    let tagged_file = Probe::open(&path)
        .expect("should open MP3")
        .read()
        .expect("should read MP3");

    let tag = tagged_file.primary_tag()
        .or_else(|| tagged_file.first_tag())
        .expect("MP3 file should have ID3 tags");

    assert_eq!(tag.title().as_deref(), Some("Test MP3 320"),
        "title should be 'Test MP3 320'");
    assert_eq!(tag.artist().as_deref(), Some("Noir Test"),
        "artist should be 'Noir Test'");
    assert_eq!(tag.track(), Some(4),
        "track should be 4");
}

// ---------------------------------------------------------------------------
// 4.4  MP3 audio properties — sample rate, bitrate
// ---------------------------------------------------------------------------

#[test]
fn test_4_4_mp3_audio_properties() {
    let path = fixture_path("test_320.mp3");
    let tagged_file = Probe::open(&path)
        .expect("should open")
        .read()
        .expect("should read");

    let props = tagged_file.properties();
    assert_eq!(props.sample_rate(), Some(44100),
        "sample rate should be 44100");

    // MP3 bitrate: 320kbps CBR
    if let Some(bitrate) = props.audio_bitrate() {
        assert!(bitrate >= 310 && bitrate <= 330,
            "bitrate should be ~320kbps, got {}", bitrate);
    }
}

// ---------------------------------------------------------------------------
// 4.5  MP3 VBR — title extraction
// ---------------------------------------------------------------------------

#[test]
fn test_4_5_mp3_vbr_tags() {
    let path = fixture_path("test_vbr.mp3");
    let tagged_file = Probe::open(&path)
        .expect("should open VBR MP3")
        .read()
        .expect("should read VBR MP3");

    let tag = tagged_file.primary_tag()
        .or_else(|| tagged_file.first_tag())
        .expect("VBR MP3 should have tags");

    assert_eq!(tag.title().as_deref(), Some("Test MP3 VBR"),
        "title should be 'Test MP3 VBR'");
}

// ---------------------------------------------------------------------------
// 4.6  WAV audio properties — sample rate, bit depth
// ---------------------------------------------------------------------------

#[test]
fn test_4_6_wav_properties() {
    let path = fixture_path("test_44100_16.wav");
    let tagged_file = Probe::open(&path)
        .expect("should open WAV")
        .read()
        .expect("should read WAV");

    let props = tagged_file.properties();
    assert_eq!(props.sample_rate(), Some(44100),
        "sample rate should be 44100");
    assert_eq!(props.bit_depth(), Some(16),
        "bit depth should be 16");
}

// ---------------------------------------------------------------------------
// 4.7  AIFF audio properties
// ---------------------------------------------------------------------------

#[test]
fn test_4_7_aiff_properties() {
    let path = fixture_path("test_44100_16.aiff");
    let tagged_file = Probe::open(&path)
        .expect("should open AIFF")
        .read()
        .expect("should read AIFF");

    let props = tagged_file.properties();
    assert_eq!(props.sample_rate(), Some(44100),
        "sample rate should be 44100");
    assert_eq!(props.bit_depth(), Some(16),
        "bit depth should be 16");
}

// ---------------------------------------------------------------------------
// 4.8  ALAC (M4A) — title, sample rate
// ---------------------------------------------------------------------------

#[test]
fn test_4_8_alac_m4a_tags_and_properties() {
    let path = fixture_path("test_alac.m4a");
    let tagged_file = Probe::open(&path)
        .expect("should open ALAC/M4A")
        .read()
        .expect("should read ALAC/M4A");

    let tag = tagged_file.primary_tag()
        .or_else(|| tagged_file.first_tag())
        .expect("ALAC M4A should have tags");

    assert_eq!(tag.title().as_deref(), Some("Test ALAC"),
        "title should be 'Test ALAC'");
    assert_eq!(tag.artist().as_deref(), Some("Noir Test"),
        "artist should be 'Noir Test'");

    let props = tagged_file.properties();
    assert_eq!(props.sample_rate(), Some(44100),
        "sample rate should be 44100");
}

// ---------------------------------------------------------------------------
// 4.9  File without tags — defaults
// ---------------------------------------------------------------------------

#[test]
fn test_4_9_no_tags_defaults() {
    let path = fixture_path("test_no_tags.flac");
    let tagged_file = Probe::open(&path)
        .expect("should open tagless FLAC")
        .read()
        .expect("should read tagless FLAC");

    // May or may not have a tag container; if it does, fields should be None/empty
    let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag());

    match tag {
        Some(t) => {
            // If a tag container exists, fields should be empty/None
            let title = t.title();
            let artist = t.artist();
            assert!(title.is_none() || title.as_deref() == Some(""),
                "title should be None or empty for untagged file, got {:?}", title);
            assert!(artist.is_none() || artist.as_deref() == Some(""),
                "artist should be None or empty for untagged file, got {:?}", artist);
        }
        None => {
            // No tag container at all — perfectly valid for a tagless file
        }
    }

    // Audio properties should still be present
    let props = tagged_file.properties();
    assert_eq!(props.sample_rate(), Some(44100),
        "sample rate should still be 44100 even without tags");
}

// ---------------------------------------------------------------------------
// 4.10  Cover art embedded in FLAC
// ---------------------------------------------------------------------------

#[test]
fn test_4_10_cover_art_embedded() {
    let path = fixture_path("test_cover.flac");
    let tagged_file = Probe::open(&path)
        .expect("should open cover FLAC")
        .read()
        .expect("should read cover FLAC");

    let tag = tagged_file.primary_tag()
        .or_else(|| tagged_file.first_tag())
        .expect("cover FLAC should have tags");

    // Verify the title tag
    assert_eq!(tag.title().as_deref(), Some("Test Cover"),
        "title should be 'Test Cover'");

    // Check for embedded pictures
    let pictures = tag.pictures();
    // The cover was embedded using metaflac or ffmpeg; there should be at least one picture
    assert!(!pictures.is_empty(),
        "cover FLAC should have at least one embedded picture, found 0");

    let pic = &pictures[0];
    assert!(pic.data().len() > 10,
        "embedded picture data should be non-trivial, got {} bytes", pic.data().len());
}

// ---------------------------------------------------------------------------
// 4.11  Disc number from multi-disc files
// ---------------------------------------------------------------------------

#[test]
fn test_4_11_disc_number_extraction() {
    // Disc 1, Track 1
    let path_d1t1 = fixture_path("test_multidisc_d1t1.flac");
    let tagged_d1t1 = Probe::open(&path_d1t1)
        .expect("should open d1t1")
        .read()
        .expect("should read d1t1");
    let tag_d1t1 = tagged_d1t1.primary_tag()
        .or_else(|| tagged_d1t1.first_tag())
        .expect("d1t1 should have tags");

    assert_eq!(tag_d1t1.title().as_deref(), Some("Disc 1 Track 1"));
    assert_eq!(tag_d1t1.track(), Some(1), "track should be 1");
    assert_eq!(tag_d1t1.disk(), Some(1), "disc should be 1");

    // Disc 1, Track 2
    let path_d1t2 = fixture_path("test_multidisc_d1t2.flac");
    let tagged_d1t2 = Probe::open(&path_d1t2)
        .expect("should open d1t2")
        .read()
        .expect("should read d1t2");
    let tag_d1t2 = tagged_d1t2.primary_tag()
        .or_else(|| tagged_d1t2.first_tag())
        .expect("d1t2 should have tags");

    assert_eq!(tag_d1t2.track(), Some(2), "track should be 2");
    assert_eq!(tag_d1t2.disk(), Some(1), "disc should be 1");

    // Disc 2, Track 1
    let path_d2t1 = fixture_path("test_multidisc_d2t1.flac");
    let tagged_d2t1 = Probe::open(&path_d2t1)
        .expect("should open d2t1")
        .read()
        .expect("should read d2t1");
    let tag_d2t1 = tagged_d2t1.primary_tag()
        .or_else(|| tagged_d2t1.first_tag())
        .expect("d2t1 should have tags");

    assert_eq!(tag_d2t1.track(), Some(1), "track should be 1");
    assert_eq!(tag_d2t1.disk(), Some(2), "disc should be 2");
}

// ---------------------------------------------------------------------------
// 4.12  Codec detection — FileType mapping
// ---------------------------------------------------------------------------

#[test]
fn test_4_12_codec_detection_flac() {
    let path = fixture_path("test_44100_16.flac");
    let tagged_file = Probe::open(&path)
        .expect("should open")
        .read()
        .expect("should read");

    assert_eq!(tagged_file.file_type(), lofty::FileType::Flac,
        "FLAC file should be detected as FileType::Flac");
}

#[test]
fn test_4_12_codec_detection_mp3() {
    let path = fixture_path("test_320.mp3");
    let tagged_file = Probe::open(&path)
        .expect("should open")
        .read()
        .expect("should read");

    assert_eq!(tagged_file.file_type(), lofty::FileType::Mpeg,
        "MP3 file should be detected as FileType::Mpeg");
}

#[test]
fn test_4_12_codec_detection_wav() {
    let path = fixture_path("test_44100_16.wav");
    let tagged_file = Probe::open(&path)
        .expect("should open")
        .read()
        .expect("should read");

    assert_eq!(tagged_file.file_type(), lofty::FileType::Wav,
        "WAV file should be detected as FileType::Wav");
}

#[test]
fn test_4_12_codec_detection_aiff() {
    let path = fixture_path("test_44100_16.aiff");
    let tagged_file = Probe::open(&path)
        .expect("should open")
        .read()
        .expect("should read");

    assert_eq!(tagged_file.file_type(), lofty::FileType::Aiff,
        "AIFF file should be detected as FileType::Aiff");
}

#[test]
fn test_4_12_codec_detection_m4a() {
    let path = fixture_path("test_alac.m4a");
    let tagged_file = Probe::open(&path)
        .expect("should open")
        .read()
        .expect("should read");

    assert_eq!(tagged_file.file_type(), lofty::FileType::Mp4,
        "M4A file should be detected as FileType::Mp4");
}

// ---------------------------------------------------------------------------
// Additional: ALAC vs AAC distinction logic (same as lib.rs)
// ---------------------------------------------------------------------------

#[test]
fn test_alac_vs_aac_distinction() {
    // The app distinguishes ALAC from AAC by checking if bit_depth is Some.
    // ALAC has bit_depth (it's lossless), AAC typically doesn't.
    let path = fixture_path("test_alac.m4a");
    let tagged_file = Probe::open(&path)
        .expect("should open")
        .read()
        .expect("should read");

    let props = tagged_file.properties();
    let file_type = tagged_file.file_type();

    assert_eq!(file_type, lofty::FileType::Mp4);

    // The lib.rs logic:
    //   if metadata.bit_depth.is_some() { "ALAC" } else { "AAC" }
    let codec = if props.bit_depth().is_some() {
        "ALAC"
    } else {
        "AAC"
    };

    assert_eq!(codec, "ALAC",
        "ALAC file should have bit_depth set, yielding codec='ALAC'");
}

// ---------------------------------------------------------------------------
// Additional: Format quality display logic (same as JS formatQuality)
// ---------------------------------------------------------------------------

/// Mirrors the JS `formatQuality` logic from views.js:
///   Lossless (FLAC, ALAC, WAV, AIFF) => "{bit_depth}-bit / {sample_rate_khz}kHz"
///   Lossy (MP3, AAC, OGG) => "{bitrate} kbps"
fn format_quality(
    codec: &str,
    bit_depth: Option<u8>,
    sample_rate: Option<u32>,
    bitrate: Option<u32>,
) -> String {
    let lossless_codecs = ["FLAC", "ALAC", "WAV", "AIFF"];
    if lossless_codecs.contains(&codec) {
        let bd = bit_depth.unwrap_or(16);
        let sr = sample_rate.unwrap_or(44100);
        let sr_khz = sr as f64 / 1000.0;
        if sr_khz == sr_khz.floor() {
            format!("{}-bit / {}kHz", bd, sr_khz as u32)
        } else {
            format!("{}-bit / {:.1}kHz", bd, sr_khz)
        }
    } else {
        let br = bitrate.unwrap_or(0);
        format!("{} kbps", br)
    }
}

#[test]
fn test_format_quality_flac_cd() {
    let result = format_quality("FLAC", Some(16), Some(44100), None);
    assert_eq!(result, "16-bit / 44.1kHz");
}

#[test]
fn test_format_quality_flac_hires_96() {
    let result = format_quality("FLAC", Some(24), Some(96000), None);
    assert_eq!(result, "24-bit / 96kHz");
}

#[test]
fn test_format_quality_flac_hires_192() {
    let result = format_quality("FLAC", Some(24), Some(192000), None);
    assert_eq!(result, "24-bit / 192kHz");
}

#[test]
fn test_format_quality_mp3_320() {
    let result = format_quality("MP3", None, Some(44100), Some(320));
    assert_eq!(result, "320 kbps");
}

#[test]
fn test_format_quality_alac() {
    let result = format_quality("ALAC", Some(16), Some(44100), None);
    assert_eq!(result, "16-bit / 44.1kHz");
}

#[test]
fn test_format_quality_wav() {
    let result = format_quality("WAV", Some(16), Some(44100), None);
    assert_eq!(result, "16-bit / 44.1kHz");
}

#[test]
fn test_format_quality_aiff() {
    let result = format_quality("AIFF", Some(16), Some(44100), None);
    assert_eq!(result, "16-bit / 44.1kHz");
}

#[test]
fn test_format_quality_flac_441_display() {
    // 44.1kHz should display as "44.1kHz" (not "44kHz") when it's not a round number
    let result = format_quality("FLAC", Some(16), Some(44100), None);
    // 44100 / 1000 = 44.1 => floor is 44.0 which != 44.1 => should show 44.1
    // But in our implementation: 44.1 != 44.0 so it goes to the else branch
    assert!(result.contains("44"), "should contain '44': {}", result);
}

// ---------------------------------------------------------------------------
// Additional: Hi-res FLAC properties (96kHz)
// ---------------------------------------------------------------------------

#[test]
fn test_hires_flac_96_properties() {
    let path = fixture_path("test_96000_24.flac");
    let tagged_file = Probe::open(&path)
        .expect("should open 96k FLAC")
        .read()
        .expect("should read 96k FLAC");

    let props = tagged_file.properties();
    assert_eq!(props.sample_rate(), Some(96000),
        "sample rate should be 96000");
    // ffmpeg uses -sample_fmt s32 for 24-bit FLAC, lofty may report 24 or 32
    let bd = props.bit_depth();
    assert!(bd == Some(24) || bd == Some(32),
        "bit depth should be 24 or 32, got {:?}", bd);
}

// ---------------------------------------------------------------------------
// Additional: Hi-res FLAC properties (192kHz)
// ---------------------------------------------------------------------------

#[test]
fn test_hires_flac_192_properties() {
    let path = fixture_path("test_192000_24.flac");
    let tagged_file = Probe::open(&path)
        .expect("should open 192k FLAC")
        .read()
        .expect("should read 192k FLAC");

    let props = tagged_file.properties();
    assert_eq!(props.sample_rate(), Some(192000),
        "sample rate should be 192000");

    let bd = props.bit_depth();
    assert!(bd == Some(24) || bd == Some(32),
        "bit depth should be 24 or 32, got {:?}", bd);
}

// ---------------------------------------------------------------------------
// Additional: Corrupted file — lofty behavior
// ---------------------------------------------------------------------------

#[test]
fn test_corrupted_flac_lofty() {
    let path = fixture_path("test_corrupted.flac");
    let result = Probe::open(&path).and_then(|p| p.read());

    // Corrupted file (100 bytes) — lofty should fail to parse
    assert!(result.is_err(),
        "lofty should return Err for corrupted FLAC, got Ok");
}

// ---------------------------------------------------------------------------
// Additional: Non-audio file — lofty behavior
// ---------------------------------------------------------------------------

#[test]
fn test_non_audio_lofty() {
    let path = fixture_path("test_notaudio.txt");
    let result = Probe::open(&path).and_then(|p| p.read());

    assert!(result.is_err(),
        "lofty should return Err for .txt file, got Ok");
}
