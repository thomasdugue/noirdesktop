// StatePure.test.js — Tests des contrats d'etat et de clearObject

import { describe, test, expect, beforeAll } from '@jest/globals'

let state

beforeAll(async () => {
  state = await import('../state.js')
})

describe('clearObject', () => {
  test('vide toutes les cles d un objet', () => {
    const obj = { a: 1, b: 2, c: 3 }
    state.clearObject(obj)
    expect(Object.keys(obj)).toHaveLength(0)
  })

  test('preserve la reference de l objet', () => {
    const obj = { x: 1 }
    const ref = obj
    state.clearObject(obj)
    expect(obj).toBe(ref)
  })

  test('fonctionne sur un objet deja vide', () => {
    const obj = {}
    state.clearObject(obj)
    expect(Object.keys(obj)).toHaveLength(0)
  })

  test('ne touche pas le prototype', () => {
    const obj = Object.create({ inherited: true })
    obj.own = 1
    state.clearObject(obj)
    expect(Object.keys(obj)).toHaveLength(0)
    expect(obj.inherited).toBe(true)
  })
})

describe('State shape — playback', () => {
  test('playback contient les cles critiques', () => {
    expect(state.playback).toHaveProperty('currentTrackIndex')
    expect(state.playback).toHaveProperty('audioIsPlaying')
    expect(state.playback).toHaveProperty('shuffleMode')
    expect(state.playback).toHaveProperty('repeatMode')
    expect(state.playback).toHaveProperty('currentVolume')
    expect(state.playback).toHaveProperty('playbackContext')
    expect(state.playback).toHaveProperty('autoQueueSource')
    expect(state.playback).toHaveProperty('autoQueueIndex')
  })

  test('playback valeurs initiales correctes', () => {
    expect(state.playback.currentTrackIndex).toBe(-1)
    expect(state.playback.audioIsPlaying).toBe(false)
    expect(state.playback.shuffleMode).toBe('off')
    expect(state.playback.repeatMode).toBe('off')
  })
})

describe('State shape — library', () => {
  test('library contient tracks, albums, artists, tracksByPath', () => {
    expect(state.library).toHaveProperty('tracks')
    expect(state.library).toHaveProperty('albums')
    expect(state.library).toHaveProperty('artists')
    expect(state.library).toHaveProperty('tracksByPath')
    expect(Array.isArray(state.library.tracks)).toBe(true)
    expect(state.library.tracksByPath instanceof Map).toBe(true)
  })
})

describe('State shape — ui', () => {
  test('ui contient currentView, navigationHistory, tracksViewOrder', () => {
    expect(state.ui).toHaveProperty('currentView')
    expect(state.ui).toHaveProperty('navigationHistory')
    expect(state.ui).toHaveProperty('tracksViewOrder')
    expect(state.ui).toHaveProperty('isQueuePanelOpen')
    expect(Array.isArray(state.ui.navigationHistory)).toBe(true)
    expect(Array.isArray(state.ui.tracksViewOrder)).toBe(true)
  })
})

describe('State shape — queue', () => {
  test('queue contient items array', () => {
    expect(state.queue).toHaveProperty('items')
    expect(Array.isArray(state.queue.items)).toBe(true)
  })
})

describe('State shape — search', () => {
  test('search contient query et index Map', () => {
    expect(state.search).toHaveProperty('query')
    expect(state.search).toHaveProperty('index')
    expect(state.search.index instanceof Map).toBe(true)
  })
})

describe('State shape — sort', () => {
  test('sort contient column, direction, albumSortMode', () => {
    expect(state.sort).toHaveProperty('column')
    expect(state.sort).toHaveProperty('direction')
    expect(state.sort).toHaveProperty('albumSortMode')
  })
})

describe('State shape — caches', () => {
  test('caches contient coverCache et thumbnailCache Maps', () => {
    expect(state.caches).toHaveProperty('coverCache')
    expect(state.caches).toHaveProperty('thumbnailCache')
    expect(state.caches.coverCache instanceof Map).toBe(true)
    expect(state.caches.thumbnailCache instanceof Map).toBe(true)
  })
})

describe('State shape — favorites', () => {
  test('favorites contient tracks Set', () => {
    expect(state.favorites).toHaveProperty('tracks')
    expect(state.favorites.tracks instanceof Set).toBe(true)
  })
})
