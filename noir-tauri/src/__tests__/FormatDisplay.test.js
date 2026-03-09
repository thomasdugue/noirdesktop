// FormatDisplay.test.js — Module 9: Quality format display tests
// Tests the formatQuality pure function from utils.js
//
// formatQuality(metadata, filePath = null)
//   metadata: { bitDepth, sampleRate, bitrate }
//   Returns: { label: string, class: string }

import { describe, test, expect } from '@jest/globals';
import { formatQuality } from '../utils.js';

describe('Module 9 — formatQuality', () => {

  // 9.1: FLAC 24-bit/192kHz (hi-res lossless)
  test('9.1: FLAC 24-bit/192kHz returns hi-res label and quality-192k class', () => {
    const metadata = { bitDepth: 24, sampleRate: 192000 };
    const result = formatQuality(metadata, '/music/album/track.flac');
    expect(result).toEqual({ label: '24-bit / 192kHz', class: 'quality-192k' });
  });

  // 9.2: MP3 320kbps (lossy)
  test('9.2: MP3 320kbps returns lossy label with kbps', () => {
    const metadata = { bitrate: 320 };
    const result = formatQuality(metadata, '/music/album/track.mp3');
    expect(result).toEqual({ label: '320 kbps', class: 'quality-lossy' });
  });

  // 9.3: WAV 16-bit/44.1kHz (CD quality lossless)
  test('9.3: WAV 16-bit/44.1kHz returns CD quality label and quality-44k class', () => {
    const metadata = { bitDepth: 16, sampleRate: 44100 };
    const result = formatQuality(metadata, '/music/album/track.wav');
    expect(result).toEqual({ label: '16-bit / 44.1kHz', class: 'quality-44k' });
  });

  // 9.4: null metadata returns dash fallback
  test('9.4: null metadata returns fallback { label: "-", class: "" }', () => {
    const result = formatQuality(null);
    expect(result).toEqual({ label: '-', class: '' });
  });

  // 9.4b: metadata with no bitDepth and no sampleRate (and no bitrate) returns fallback
  test('9.4b: missing bitDepth, sampleRate, and bitrate returns fallback', () => {
    const metadata = {};
    const result = formatQuality(metadata);
    expect(result).toEqual({ label: '-', class: '' });
  });

  // Additional edge cases

  test('9.5: FLAC 16-bit/96kHz returns quality-96k class', () => {
    const metadata = { bitDepth: 16, sampleRate: 96000 };
    const result = formatQuality(metadata, '/music/track.flac');
    expect(result).toEqual({ label: '16-bit / 96kHz', class: 'quality-96k' });
  });

  test('9.6: FLAC 24-bit/48kHz returns quality-48k class', () => {
    const metadata = { bitDepth: 24, sampleRate: 48000 };
    const result = formatQuality(metadata, '/music/track.flac');
    expect(result).toEqual({ label: '24-bit / 48kHz', class: 'quality-48k' });
  });

  test('9.7: AAC lossy with bitrate detected by file extension', () => {
    const metadata = { bitrate: 256 };
    const result = formatQuality(metadata, '/music/track.m4a');
    expect(result).toEqual({ label: '256 kbps', class: 'quality-lossy' });
  });

  test('9.8: lossy without bitrate returns generic Lossy label', () => {
    const metadata = {};
    const result = formatQuality(metadata, '/music/track.ogg');
    expect(result).toEqual({ label: 'Lossy', class: 'quality-lossy' });
  });

  test('9.9: bitDepth only (no sampleRate) for lossless', () => {
    const metadata = { bitDepth: 24 };
    const result = formatQuality(metadata);
    expect(result).toEqual({ label: '24-bit', class: 'quality-hires' });
  });

  test('9.10: sampleRate only (no bitDepth) for lossless', () => {
    const metadata = { sampleRate: 44100 };
    const result = formatQuality(metadata);
    expect(result).toEqual({ label: '44.1kHz', class: 'quality-44k' });
  });

});
