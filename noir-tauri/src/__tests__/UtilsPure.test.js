// UtilsPure.test.js — Tests des fonctions utilitaires pures de utils.js

import { describe, test, expect, beforeAll } from '@jest/globals'

let formatTime, formatAlbumDuration, getCodecFromPath, isValidImageSrc, escapeHtml

beforeAll(async () => {
  const utils = await import('../utils.js')
  formatTime = utils.formatTime
  formatAlbumDuration = utils.formatAlbumDuration
  getCodecFromPath = utils.getCodecFromPath
  isValidImageSrc = utils.isValidImageSrc
  escapeHtml = utils.escapeHtml
})

describe('formatTime', () => {
  test('0 seconds → "0:00"', () => {
    expect(formatTime(0)).toBe('0:00')
  })

  test('61 seconds → "1:01"', () => {
    expect(formatTime(61)).toBe('1:01')
  })

  test('3661 seconds → "61:01"', () => {
    expect(formatTime(3661)).toBe('61:01')
  })

  test('fractional seconds → floors correctly', () => {
    expect(formatTime(90.7)).toBe('1:30')
  })

  test('single-digit seconds → zero-padded', () => {
    expect(formatTime(5)).toBe('0:05')
    expect(formatTime(65)).toBe('1:05')
  })
})

describe('formatAlbumDuration', () => {
  test('300s → "5m"', () => {
    expect(formatAlbumDuration(300)).toBe('5m')
  })

  test('3660s → "1h1m"', () => {
    expect(formatAlbumDuration(3660)).toBe('1h1m')
  })

  test('3600s → "1h" (exact hour, no minutes)', () => {
    expect(formatAlbumDuration(3600)).toBe('1h')
  })

  test('0s → "0m"', () => {
    expect(formatAlbumDuration(0)).toBe('0m')
  })

  test('86400s → "24h"', () => {
    expect(formatAlbumDuration(86400)).toBe('24h')
  })
})

describe('getCodecFromPath', () => {
  test('.flac → FLAC', () => {
    expect(getCodecFromPath('/music/song.flac')).toBe('FLAC')
  })

  test('.mp3 → MP3', () => {
    expect(getCodecFromPath('/music/song.mp3')).toBe('MP3')
  })

  test('.m4a → AAC', () => {
    expect(getCodecFromPath('/music/song.m4a')).toBe('AAC')
  })

  test('.dsf → DSD', () => {
    expect(getCodecFromPath('/music/song.dsf')).toBe('DSD')
  })

  test('null path → null', () => {
    expect(getCodecFromPath(null)).toBe(null)
  })

  test('unknown extension → uppercase extension', () => {
    expect(getCodecFromPath('/music/song.xyz')).toBe('XYZ')
  })
})

describe('isValidImageSrc', () => {
  test('data:image prefix → true', () => {
    expect(isValidImageSrc('data:image/png;base64,abc')).toBe(true)
  })

  test('noir:// prefix → true', () => {
    expect(isValidImageSrc('noir://covers/abc.jpg')).toBe(true)
  })

  test('null → false', () => {
    expect(isValidImageSrc(null)).toBeFalsy()
  })

  test('empty string → false', () => {
    expect(isValidImageSrc('')).toBeFalsy()
  })

  test('http URL → false', () => {
    expect(isValidImageSrc('https://example.com/img.jpg')).toBeFalsy()
  })
})

describe('escapeHtml', () => {
  test('escapes angle brackets', () => {
    const result = escapeHtml('<script>alert("xss")</script>')
    expect(result).not.toContain('<script>')
    expect(result).toContain('&lt;')
    expect(result).toContain('&gt;')
  })

  test('escapes ampersand', () => {
    expect(escapeHtml('a & b')).toContain('&amp;')
  })

  test('null → empty string', () => {
    expect(escapeHtml(null)).toBe('')
  })

  test('normal text → unchanged', () => {
    expect(escapeHtml('Hello World')).toBe('Hello World')
  })
})
