// TrackNavigation.test.js — Tests de getNextTrackPath, getNextTrackInfo, getCurrentTrackPath

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals'
import { library, playback, queue } from '../state.js'
import { app } from '../app.js'

let getNextTrackPath, getNextTrackInfo, getCurrentTrackPath

function makeTrack(path, title, artist, album) {
  return {
    path,
    name: path.split('/').pop(),
    metadata: { title, artist, album },
  }
}

beforeAll(async () => {
  app.buildSearchIndex = () => {}
  app.updateQueueDisplay = () => {}
  app.updateQueueIndicators = () => {}

  const mod = await import('../playback.js')
  getNextTrackPath = mod.getNextTrackPath
  getNextTrackInfo = mod.getNextTrackInfo
  getCurrentTrackPath = mod.getCurrentTrackPath
})

beforeEach(() => {
  library.tracks = [
    makeTrack('/music/a.flac', 'Alpha', 'Artist A', 'Album 1'),
    makeTrack('/music/b.flac', 'Beta', 'Artist B', 'Album 1'),
    makeTrack('/music/c.flac', 'Gamma', 'Artist C', 'Album 2'),
  ]
  queue.items = []
  playback.currentTrackIndex = 0
  playback.repeatMode = 'off'
  playback.shuffleMode = 'off'
  playback.autoQueueSource = null
  playback.autoQueueIndex = 0
})

// === getNextTrackPath ===

describe('getNextTrackPath', () => {
  test('repeat-one retourne le track courant', () => {
    playback.repeatMode = 'one'
    playback.currentTrackIndex = 1
    expect(getNextTrackPath()).toBe('/music/b.flac')
  })

  test('queue prioritaire — retourne premier element', () => {
    queue.items = [library.tracks[2], library.tracks[1]]
    expect(getNextTrackPath()).toBe('/music/c.flac')
  })

  test('null quand queue vide et pas de source', () => {
    queue.items = []
    playback.autoQueueSource = null
    playback.repeatMode = 'off'
    expect(getNextTrackPath()).toBeNull()
  })

  test('replenish si queue vide et source disponible', () => {
    const paths = library.tracks.map(t => t.path)
    playback.autoQueueSource = { type: 'library', id: null, tracks: paths }
    playback.autoQueueIndex = 0
    queue.items = []
    // replenishQueue should add tracks from index 1 onwards
    const result = getNextTrackPath()
    expect(result).not.toBeNull()
  })

  test('repeat-one avec index invalide retourne undefined/null', () => {
    playback.repeatMode = 'one'
    playback.currentTrackIndex = -1
    // currentTrackIndex < 0, condition fails, falls through
    const result = getNextTrackPath()
    // No queue, no source → null
    expect(result).toBeNull()
  })
})

// === getNextTrackInfo ===

describe('getNextTrackInfo', () => {
  test('retourne title et artist du prochain track', () => {
    queue.items = [library.tracks[1]]
    const info = getNextTrackInfo()
    expect(info).not.toBeNull()
    expect(info.title).toBe('Beta')
    expect(info.artist).toBe('Artist B')
  })

  test('null quand pas de next', () => {
    queue.items = []
    playback.autoQueueSource = null
    expect(getNextTrackInfo()).toBeNull()
  })

  test('gere metadata manquante', () => {
    const noMeta = { path: '/music/x.flac', name: 'x.flac', metadata: {} }
    library.tracks.push(noMeta)
    queue.items = [noMeta]
    const info = getNextTrackInfo()
    expect(info).not.toBeNull()
    // Should fallback to track.name for title
    expect(info.title).toBe('x.flac')
    expect(info.artist).toBe('')
  })
})

// === getCurrentTrackPath ===

describe('getCurrentTrackPath', () => {
  test('retourne le path du track courant', () => {
    playback.currentTrackIndex = 2
    expect(getCurrentTrackPath()).toBe('/music/c.flac')
  })

  test('index -1 retourne null', () => {
    playback.currentTrackIndex = -1
    expect(getCurrentTrackPath()).toBeNull()
  })

  test('index hors limites retourne null', () => {
    playback.currentTrackIndex = 999
    expect(getCurrentTrackPath()).toBeNull()
  })
})
