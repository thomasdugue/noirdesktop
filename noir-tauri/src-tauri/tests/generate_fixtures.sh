#!/bin/bash
# Generate test audio fixtures for Noir Desktop test suite
# Requires: ffmpeg

set -e

FIXTURES_DIR="$(dirname "$0")/fixtures"
mkdir -p "$FIXTURES_DIR"

# Skip if fixtures already generated
if [ -f "$FIXTURES_DIR/.generated" ]; then
    echo "Fixtures already generated, skipping."
    exit 0
fi

echo "Generating test audio fixtures..."

# --- FLAC files ---

# 1. FLAC 16-bit/44.1kHz with tags
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=3:sample_rate=44100" \
    -c:a flac -sample_fmt s16 \
    -metadata title="Test 44.1" -metadata artist="Noir Test" \
    -metadata album="Test Album" -metadata track="1" \
    -metadata date="2024" -metadata genre="Electronic" \
    "$FIXTURES_DIR/test_44100_16.flac" 2>/dev/null

# 2. FLAC 24-bit/96kHz with tags
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=3:sample_rate=96000" \
    -c:a flac -sample_fmt s32 \
    -metadata title="Test 96k" -metadata artist="Noir Test" \
    -metadata album="Test Album" -metadata track="2" \
    -metadata date="2024" -metadata genre="Electronic" \
    "$FIXTURES_DIR/test_96000_24.flac" 2>/dev/null

# 3. FLAC 24-bit/192kHz with tags
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=3:sample_rate=192000" \
    -c:a flac -sample_fmt s32 \
    -metadata title="Test 192k" -metadata artist="Noir Test" \
    -metadata album="Test Album" -metadata track="3" \
    -metadata date="2024" -metadata genre="Electronic" \
    "$FIXTURES_DIR/test_192000_24.flac" 2>/dev/null

# --- WAV file ---
# 4. WAV 16-bit/44.1kHz
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=3:sample_rate=44100" \
    -c:a pcm_s16le \
    "$FIXTURES_DIR/test_44100_16.wav" 2>/dev/null

# --- AIFF file ---
# 5. AIFF 16-bit/44.1kHz
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=3:sample_rate=44100" \
    -c:a pcm_s16be -f aiff \
    "$FIXTURES_DIR/test_44100_16.aiff" 2>/dev/null

# --- MP3 files ---
# 6. MP3 320kbps CBR with ID3v2 tags
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=3:sample_rate=44100" \
    -c:a libmp3lame -b:a 320k \
    -metadata title="Test MP3 320" -metadata artist="Noir Test" \
    -metadata album="Test Album" -metadata track="4" \
    "$FIXTURES_DIR/test_320.mp3" 2>/dev/null

# 7. MP3 VBR
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=3:sample_rate=44100" \
    -c:a libmp3lame -q:a 2 \
    -metadata title="Test MP3 VBR" -metadata artist="Noir Test" \
    "$FIXTURES_DIR/test_vbr.mp3" 2>/dev/null

# --- ALAC (M4A) ---
# 8. ALAC in M4A container
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=3:sample_rate=44100" \
    -c:a alac \
    -metadata title="Test ALAC" -metadata artist="Noir Test" \
    -metadata album="Test Album" \
    "$FIXTURES_DIR/test_alac.m4a" 2>/dev/null

# --- Special test files ---

# 9. Corrupted FLAC (truncated)
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=3:sample_rate=44100" \
    -c:a flac -sample_fmt s16 \
    "$FIXTURES_DIR/test_corrupted_tmp.flac" 2>/dev/null
# Truncate to 100 bytes to create a corrupted file
dd if="$FIXTURES_DIR/test_corrupted_tmp.flac" of="$FIXTURES_DIR/test_corrupted.flac" bs=100 count=1 2>/dev/null
rm -f "$FIXTURES_DIR/test_corrupted_tmp.flac"

# 10. Not an audio file
echo "This is not an audio file. Just plain text." > "$FIXTURES_DIR/test_notaudio.txt"

# 11. Empty FLAC (0 samples) - generate a very short sine then truncate
# Use a silence source with 0 duration doesn't work in ffmpeg, so generate 1 sample
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=0.00002:sample_rate=44100" \
    -c:a flac -sample_fmt s16 \
    "$FIXTURES_DIR/test_empty.flac" 2>/dev/null

# 12. FLAC with embedded cover art
# First create a tiny JPEG image (1x1 pixel red)
python3 -c "
import struct
# Minimal JPEG: 1x1 pixel red
data = bytes([
    0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43,
    0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
    0x09, 0x08, 0x0A, 0x0C, 0x14, 0x0D, 0x0C, 0x0B, 0x0B, 0x0C, 0x19, 0x12,
    0x13, 0x0F, 0x14, 0x1D, 0x1A, 0x1F, 0x1E, 0x1D, 0x1A, 0x1C, 0x1C, 0x20,
    0x24, 0x2E, 0x27, 0x20, 0x22, 0x2C, 0x23, 0x1C, 0x1C, 0x28, 0x37, 0x29,
    0x2C, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1F, 0x27, 0x39, 0x3D, 0x38, 0x32,
    0x3C, 0x2E, 0x33, 0x34, 0x32, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01,
    0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xFF, 0xC4, 0x00, 0x1F, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
    0x09, 0x0A, 0x0B, 0xFF, 0xC4, 0x00, 0xB5, 0x10, 0x00, 0x02, 0x01, 0x03,
    0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7D,
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
    0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xA1, 0x08,
    0x23, 0x42, 0xB1, 0xC1, 0x15, 0x52, 0xD1, 0xF0, 0x24, 0x33, 0x62, 0x72,
    0x82, 0x09, 0x0A, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2A, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45,
    0x46, 0x47, 0x48, 0x49, 0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
    0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x73, 0x74, 0x75,
    0x76, 0x77, 0x78, 0x79, 0x7A, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3,
    0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6,
    0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9,
    0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA, 0xE1, 0xE2,
    0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF1, 0xF2, 0xF3, 0xF4,
    0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA, 0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01,
    0x00, 0x00, 0x3F, 0x00, 0x7B, 0x94, 0x11, 0x00, 0x00, 0x00, 0xFF, 0xD9
])
with open('$FIXTURES_DIR/cover.jpg', 'wb') as f:
    f.write(data)
" 2>/dev/null || true

# Generate FLAC with cover art using ffmpeg
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=3:sample_rate=44100" \
    -c:a flac -sample_fmt s16 \
    -metadata title="Test Cover" -metadata artist="Noir Test" \
    -metadata album="Cover Album" \
    "$FIXTURES_DIR/test_cover_tmp.flac" 2>/dev/null

# Attach cover art using metaflac if available, or ffmpeg
if command -v metaflac &> /dev/null; then
    cp "$FIXTURES_DIR/test_cover_tmp.flac" "$FIXTURES_DIR/test_cover.flac"
    metaflac --import-picture-from="$FIXTURES_DIR/cover.jpg" "$FIXTURES_DIR/test_cover.flac"
else
    # Use ffmpeg to attach cover
    ffmpeg -y -i "$FIXTURES_DIR/test_cover_tmp.flac" \
        -i "$FIXTURES_DIR/cover.jpg" \
        -map 0:a -map 1:0 -c:a copy \
        -metadata:s:v title="Cover" -metadata:s:v comment="Cover (front)" \
        -disposition:v attached_pic \
        "$FIXTURES_DIR/test_cover.flac" 2>/dev/null || \
    cp "$FIXTURES_DIR/test_cover_tmp.flac" "$FIXTURES_DIR/test_cover.flac"
fi
rm -f "$FIXTURES_DIR/test_cover_tmp.flac"

# 13. FLAC without any tags
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=3:sample_rate=44100" \
    -c:a flac -sample_fmt s16 \
    -map_metadata -1 \
    "$FIXTURES_DIR/test_no_tags.flac" 2>/dev/null

# 14-16. Multi-disc files
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=3:sample_rate=44100" \
    -c:a flac -sample_fmt s16 \
    -metadata title="Disc 1 Track 1" -metadata artist="Noir Test" \
    -metadata album="Multi Disc Album" -metadata track="1" -metadata disc="1" \
    "$FIXTURES_DIR/test_multidisc_d1t1.flac" 2>/dev/null

ffmpeg -y -f lavfi -i "sine=frequency=440:duration=3:sample_rate=44100" \
    -c:a flac -sample_fmt s16 \
    -metadata title="Disc 1 Track 2" -metadata artist="Noir Test" \
    -metadata album="Multi Disc Album" -metadata track="2" -metadata disc="1" \
    "$FIXTURES_DIR/test_multidisc_d1t2.flac" 2>/dev/null

ffmpeg -y -f lavfi -i "sine=frequency=440:duration=3:sample_rate=44100" \
    -c:a flac -sample_fmt s16 \
    -metadata title="Disc 2 Track 1" -metadata artist="Noir Test" \
    -metadata album="Multi Disc Album" -metadata track="1" -metadata disc="2" \
    "$FIXTURES_DIR/test_multidisc_d2t1.flac" 2>/dev/null

# Clean up temp files
rm -f "$FIXTURES_DIR/cover.jpg"

# Mark as generated
touch "$FIXTURES_DIR/.generated"

echo "All fixtures generated successfully!"
ls -la "$FIXTURES_DIR/"
