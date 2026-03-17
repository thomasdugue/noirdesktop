// FavoritesLogic.test.js — Tests de getValidFavoritesCount, getPlaylistById, getFavoriteButtonHtml

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals'
import { library, favorites } from '../state.js'
import { app } from '../app.js'

let getValidFavoritesCount, getPlaylistById, getFavoriteButtonHtml

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

  const mod = await import('../playlists.js')
  getValidFavoritesCount = mod.getValidFavoritesCount
  getPlaylistById = mod.getPlaylistById
  getFavoriteButtonHtml = mod.getFavoriteButtonHtml
})

beforeEach(() => {
  library.tracks = [
    makeTrack('/music/a.flac', 'A', 'Artist', 'Album'),
    makeTrack('/music/b.flac', 'B', 'Artist', 'Album'),
    makeTrack('/music/c.flac', 'C', 'Artist', 'Album'),
  ]
  // Build tracksByPath for getValidFavoritesCount
  library.tracksByPath = new Map()
  for (let i = 0; i < library.tracks.length; i++) {
    library.tracksByPath.set(library.tracks[i].path, { track: library.tracks[i], index: i })
  }
  favorites.tracks = new Set()
})

// === getValidFavoritesCount ===

describe('getValidFavoritesCount', () => {
  test('intersection avec library — paths valides', () => {
    favorites.tracks = new Set(['/music/a.flac', '/music/c.flac'])
    expect(getValidFavoritesCount()).toBe(2)
  })

  test('paths orphelins exclus du comptage', () => {
    favorites.tracks = new Set(['/music/a.flac', '/music/gone.flac', '/music/deleted.flac'])
    expect(getValidFavoritesCount()).toBe(1)
  })

  test('library vide → retourne taille favorites brute', () => {
    library.tracks = []
    favorites.tracks = new Set(['/a.flac', '/b.flac'])
    expect(getValidFavoritesCount()).toBe(2)
  })

  test('favorites vide → 0', () => {
    favorites.tracks = new Set()
    expect(getValidFavoritesCount()).toBe(0)
  })
})

// === getPlaylistById ===

describe('getPlaylistById', () => {
  // Note: playlists is module-private, loaded via loadPlaylists (invoke).
  // With no invoke response set, playlists stays empty.
  test('retourne null si playlist manquante', () => {
    expect(getPlaylistById('nonexistent')).toBeNull()
  })

  test('retourne null pour id undefined', () => {
    expect(getPlaylistById(undefined)).toBeNull()
  })
})

// === getFavoriteButtonHtml ===

describe('getFavoriteButtonHtml', () => {
  test('classe active pour un favori', () => {
    favorites.tracks = new Set(['/music/a.flac'])
    const html = getFavoriteButtonHtml('/music/a.flac')
    expect(html).toContain('active')
    expect(html).toContain('fill="currentColor"')
  })

  test('pas active pour un non-favori', () => {
    favorites.tracks = new Set()
    const html = getFavoriteButtonHtml('/music/a.flac')
    expect(html).not.toContain('class="track-favorite-btn active"')
    expect(html).toContain('fill="none"')
  })

  test('contient SVG heart', () => {
    const html = getFavoriteButtonHtml('/music/a.flac')
    expect(html).toContain('<svg')
    expect(html).toContain('</svg>')
    expect(html).toContain('<path')
  })
})
