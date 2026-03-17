// LibraryLookup.test.js — Tests de buildTrackLookup et normalizeKey (edge cases)

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals'
import { library, clearObject } from '../state.js'
import { app } from '../app.js'

let buildTrackLookup, normalizeKey

beforeAll(async () => {
  app.buildSearchIndex = () => {}

  const lib = await import('../library.js')
  buildTrackLookup = lib.buildTrackLookup
  normalizeKey = lib.normalizeKey
})

function makeTrack(path, album, artist) {
  return {
    path,
    name: path.split('/').pop(),
    metadata: { title: path.split('/').pop().replace('.flac', ''), album, artist },
  }
}

beforeEach(() => {
  library.tracks = []
  library.tracksByPath.clear()
})

describe('buildTrackLookup', () => {
  test('construit la Map a partir des tracks', () => {
    library.tracks = [
      makeTrack('/music/a.flac', 'Album A', 'Artist'),
      makeTrack('/music/b.flac', 'Album B', 'Artist'),
    ]
    buildTrackLookup()

    expect(library.tracksByPath.size).toBe(2)
  })

  test('lookup par path retourne track et index', () => {
    library.tracks = [
      makeTrack('/music/a.flac', 'Album A', 'Artist'),
      makeTrack('/music/b.flac', 'Album B', 'Artist'),
    ]
    buildTrackLookup()

    const entry = library.tracksByPath.get('/music/b.flac')
    expect(entry).toBeDefined()
    expect(entry.index).toBe(1)
    expect(entry.track.path).toBe('/music/b.flac')
  })

  test('vide les entrees precedentes avant reconstruction', () => {
    library.tracks = [makeTrack('/music/a.flac', 'Album', 'Artist')]
    buildTrackLookup()
    expect(library.tracksByPath.size).toBe(1)

    library.tracks = [
      makeTrack('/music/x.flac', 'Album', 'Artist'),
      makeTrack('/music/y.flac', 'Album', 'Artist'),
      makeTrack('/music/z.flac', 'Album', 'Artist'),
    ]
    buildTrackLookup()
    expect(library.tracksByPath.size).toBe(3)
    expect(library.tracksByPath.has('/music/a.flac')).toBe(false)
  })

  test('tracks vides → map vide', () => {
    library.tracks = []
    buildTrackLookup()
    expect(library.tracksByPath.size).toBe(0)
  })
})

describe('normalizeKey — edge cases additionnels', () => {
  test('nombres dans la cle', () => {
    expect(normalizeKey('2001: A Space Odyssey')).toBe('2001: A Space Odyssey')
  })

  test('caracteres speciaux preserves (sauf espaces)', () => {
    expect(normalizeKey("L'Album (Deluxe)")).toBe("L'Album (Deluxe)")
  })

  test('strings tres longues', () => {
    const long = 'A'.repeat(1000)
    expect(normalizeKey(long)).toBe(long)
  })

  test('scripts mixtes (latin + CJK)', () => {
    const mixed = '  初音ミク Miku  '
    expect(normalizeKey(mixed)).toBe('初音ミク Miku')
  })
})
