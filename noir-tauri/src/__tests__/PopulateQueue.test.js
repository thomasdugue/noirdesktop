// PopulateQueue.test.js — Tests de populateQueueFromContext et replenishQueue

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals'
import { library, playback, queue } from '../state.js'
import { app } from '../app.js'

let populateQueueFromContext, replenishQueue

// Generate 25 tracks for testing
function generateTracks(count) {
  return Array.from({ length: count }, (_, i) => ({
    path: `/music/track${String(i).padStart(2, '0')}.flac`,
    name: `track${String(i).padStart(2, '0')}.flac`,
    metadata: { title: `Track ${i}`, artist: 'Artist', album: `Album ${Math.floor(i / 5)}` },
  }))
}

beforeAll(async () => {
  app.buildSearchIndex = () => {}
  app.updateQueueDisplay = () => {}
  app.updateQueueIndicators = () => {}

  const mod = await import('../playback.js')
  populateQueueFromContext = mod.populateQueueFromContext
  replenishQueue = mod.replenishQueue
})

beforeEach(() => {
  library.tracks = generateTracks(25)
  queue.items = []
  playback.shuffleMode = 'off'
  playback.repeatMode = 'off'
  playback.autoQueueSource = null
  playback.autoQueueIndex = 0
  playback.currentTrackIndex = -1
})

// === populateQueueFromContext ===

describe('populateQueueFromContext — basique', () => {
  test('vide la queue existante avant de remplir', () => {
    queue.items = [{ path: '/old.flac' }]
    const context = { type: 'album', id: 'a', tracks: library.tracks.map(t => t.path) }
    populateQueueFromContext(context, 0)
    expect(queue.items.find(t => t.path === '/old.flac')).toBeUndefined()
  })

  test('ajoute les tracks apres startIndex', () => {
    const context = { type: 'library', id: null, tracks: library.tracks.map(t => t.path) }
    populateQueueFromContext(context, 0)
    // Should not include track at startIndex (0), starts from index 1
    expect(queue.items.find(t => t.path === '/music/track00.flac')).toBeUndefined()
    expect(queue.items.length).toBeGreaterThan(0)
    expect(queue.items[0].path).toBe('/music/track01.flac')
  })

  test('respecte AUTO_QUEUE_MIN (15 tracks max)', () => {
    const context = { type: 'library', id: null, tracks: library.tracks.map(t => t.path) }
    populateQueueFromContext(context, 0)
    // 24 remaining tracks after index 0, but capped at 15
    expect(queue.items.length).toBe(15)
  })

  test('stocke autoQueueSource et autoQueueIndex', () => {
    const context = { type: 'album', id: 'test', tracks: library.tracks.map(t => t.path) }
    populateQueueFromContext(context, 5)
    expect(playback.autoQueueSource).toBe(context)
    expect(playback.autoQueueIndex).toBeGreaterThan(5)
  })
})

describe('populateQueueFromContext — shuffle', () => {
  test('melange quand shuffleMode != off', () => {
    playback.shuffleMode = 'all'
    const paths = library.tracks.map(t => t.path)
    const context = { type: 'library', id: null, tracks: paths }
    populateQueueFromContext(context, 0)

    // Queue should have items but order may differ from sequential
    expect(queue.items.length).toBe(15)
    // The items should be a subset of the remaining tracks (paths after index 0)
    const remainingPaths = new Set(paths.slice(1, 16))
    for (const item of queue.items) {
      expect(remainingPaths.has(item.path)).toBe(true)
    }
  })

  test('n inclut pas la track courante (startIndex)', () => {
    playback.shuffleMode = 'all'
    const context = { type: 'library', id: null, tracks: library.tracks.map(t => t.path) }
    populateQueueFromContext(context, 3)
    expect(queue.items.find(t => t.path === '/music/track03.flac')).toBeUndefined()
  })
})

describe('populateQueueFromContext — edge cases', () => {
  test('null context → no-op', () => {
    populateQueueFromContext(null, 0)
    expect(queue.items.length).toBe(0)
  })

  test('context sans tracks → no-op', () => {
    populateQueueFromContext({ type: 'album', id: 'x', tracks: [] }, 0)
    expect(queue.items.length).toBe(0)
  })

  test('startIndex en fin de liste → queue vide', () => {
    const tracks = library.tracks.slice(0, 3).map(t => t.path)
    const context = { type: 'album', id: 'a', tracks }
    populateQueueFromContext(context, 2) // last index, nothing after
    expect(queue.items.length).toBe(0)
  })
})

// === replenishQueue ===

describe('replenishQueue — basique', () => {
  test('ajoute quand queue < MIN', () => {
    const paths = library.tracks.map(t => t.path)
    const context = { type: 'library', id: null, tracks: paths }
    // Setup: queue has 3 items, source has remaining tracks
    playback.autoQueueSource = context
    playback.autoQueueIndex = 3
    queue.items = library.tracks.slice(0, 3)

    replenishQueue()
    // Should add tracks to reach ~15
    expect(queue.items.length).toBeGreaterThan(3)
  })

  test('no-op sans autoQueueSource', () => {
    playback.autoQueueSource = null
    queue.items = [library.tracks[0]]
    replenishQueue()
    expect(queue.items.length).toBe(1)
  })

  test('no-op quand queue >= MIN', () => {
    const paths = library.tracks.map(t => t.path)
    playback.autoQueueSource = { type: 'library', id: null, tracks: paths }
    playback.autoQueueIndex = 0
    queue.items = library.tracks.slice(0, 15)
    replenishQueue()
    expect(queue.items.length).toBe(15)
  })
})

describe('replenishQueue — repeat-all', () => {
  test('wraparound quand source epuisee + repeat all', () => {
    const paths = library.tracks.slice(0, 5).map(t => t.path)
    const context = { type: 'album', id: 'a', tracks: paths }
    playback.autoQueueSource = context
    playback.autoQueueIndex = 4 // at the end of source
    playback.repeatMode = 'all'
    queue.items = [library.tracks[0]]

    replenishQueue()
    // Should have added tracks from the beginning via wraparound
    expect(queue.items.length).toBeGreaterThan(1)
  })

  test('no-op quand source epuisee sans repeat', () => {
    const paths = library.tracks.slice(0, 5).map(t => t.path)
    const context = { type: 'album', id: 'a', tracks: paths }
    playback.autoQueueSource = context
    playback.autoQueueIndex = 4 // at the end
    playback.repeatMode = 'off'
    queue.items = [library.tracks[0]]

    replenishQueue()
    // Should NOT add anything
    expect(queue.items.length).toBe(1)
  })
})

describe('replenishQueue — edge cases', () => {
  test('met a jour autoQueueIndex apres replenish', () => {
    const paths = library.tracks.map(t => t.path)
    const context = { type: 'library', id: null, tracks: paths }
    playback.autoQueueSource = context
    playback.autoQueueIndex = 5
    queue.items = []

    const indexBefore = playback.autoQueueIndex
    replenishQueue()
    expect(playback.autoQueueIndex).toBeGreaterThan(indexBefore)
  })
})
