// SearchIndex.test.js — Tests de l'index inverse et de la recherche rapide

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals'
import { library, search } from '../state.js'
import { app } from '../app.js'

let buildSearchIndex, searchTracksWithIndex

beforeAll(async () => {
  // Stubs mediator
  app.buildSearchIndex = () => {}
  app.updateTracksFilter = () => {}

  const mod = await import('../search.js')
  buildSearchIndex = mod.buildSearchIndex
  searchTracksWithIndex = mod.searchTracksWithIndex
})

function makeTrack(title, artist, album) {
  return {
    path: `/music/${title.toLowerCase().replace(/\s/g, '_')}.flac`,
    name: `${title}.flac`,
    metadata: { title, artist, album },
  }
}

beforeEach(() => {
  library.tracks = []
  search.index.clear()
})

// === buildSearchIndex ===

describe('buildSearchIndex — basique', () => {
  test('tracks vides → index vide', () => {
    buildSearchIndex()
    expect(search.index.size).toBe(0)
  })

  test('single track indexe les mots du titre, artiste, album', () => {
    library.tracks = [makeTrack('Karma Police', 'Radiohead', 'OK Computer')]
    buildSearchIndex()

    expect(search.index.has('karma')).toBe(true)
    expect(search.index.has('police')).toBe(true)
    expect(search.index.has('radiohead')).toBe(true)
    expect(search.index.has('computer')).toBe(true)
  })

  test('ignore les mots de moins de 2 caracteres', () => {
    library.tracks = [makeTrack('I Am', 'U2', 'War')]
    buildSearchIndex()

    // "i" (1 char) ne doit pas etre indexe
    expect(search.index.has('i')).toBe(false)
    // "am" (2 chars) et "u2" (2 chars) et "war" (3 chars) doivent etre indexes
    expect(search.index.has('am')).toBe(true)
    expect(search.index.has('u2')).toBe(true)
    expect(search.index.has('war')).toBe(true)
  })

  test('caracteres speciaux comme delimiteurs', () => {
    library.tracks = [makeTrack('Self-Destruct', 'Nine Inch Nails', 'The Downward Spiral')]
    buildSearchIndex()

    expect(search.index.has('self')).toBe(true)
    expect(search.index.has('destruct')).toBe(true)
    // "self-destruct" en entier ne doit PAS etre un mot
    expect(search.index.has('self-destruct')).toBe(false)
  })
})

describe('buildSearchIndex — multi-tracks', () => {
  test('mots partages entre tracks → Set contient les deux indices', () => {
    library.tracks = [
      makeTrack('Creep', 'Radiohead', 'Pablo Honey'),
      makeTrack('Karma Police', 'Radiohead', 'OK Computer'),
    ]
    buildSearchIndex()

    const radioheadSet = search.index.get('radiohead')
    expect(radioheadSet).toBeDefined()
    expect(radioheadSet.size).toBe(2)
    expect(radioheadSet.has(0)).toBe(true)
    expect(radioheadSet.has(1)).toBe(true)
  })

  test('mots differents indexes separement', () => {
    library.tracks = [
      makeTrack('Hello', 'Adele', 'Twenty Five'),
      makeTrack('Bohemian Rhapsody', 'Queen', 'News'),
    ]
    buildSearchIndex()

    expect(search.index.get('hello').has(0)).toBe(true)
    expect(search.index.get('hello').has(1)).toBeFalsy()
    expect(search.index.get('queen').has(1)).toBe(true)
    expect(search.index.get('queen').has(0)).toBeFalsy()
  })

  test('taille de l index correspond au nombre de mots uniques', () => {
    library.tracks = [makeTrack('One', 'One Artist', 'One Album')]
    buildSearchIndex()
    // "one" (x3 mais unique), "artist" (1), "album" (1) = 3 mots uniques
    expect(search.index.size).toBe(3)
  })
})

// === searchTracksWithIndex ===

describe('searchTracksWithIndex — single word', () => {
  beforeEach(() => {
    library.tracks = [
      makeTrack('Creep', 'Radiohead', 'Pablo Honey'),
      makeTrack('Karma Police', 'Radiohead', 'OK Computer'),
      makeTrack('Bohemian Rhapsody', 'Queen', 'News of the World'),
    ]
    buildSearchIndex()
  })

  test('match exact', () => {
    const result = searchTracksWithIndex('creep')
    expect(result).toBeDefined()
    expect(result.has(0)).toBe(true)
    expect(result.size).toBe(1)
  })

  test('prefix match — "radio" matche "radiohead"', () => {
    const result = searchTracksWithIndex('radio')
    expect(result).toBeDefined()
    expect(result.has(0)).toBe(true)
    expect(result.has(1)).toBe(true)
    expect(result.size).toBe(2)
  })

  test('substring match — "hapsod" matche "rhapsody"', () => {
    const result = searchTracksWithIndex('hapsod')
    expect(result).toBeDefined()
    expect(result.has(2)).toBe(true)
  })

  test('pas de match → Set vide', () => {
    const result = searchTracksWithIndex('metallica')
    expect(result).toBeDefined()
    expect(result.size).toBe(0)
  })
})

describe('searchTracksWithIndex — multi-word', () => {
  beforeEach(() => {
    library.tracks = [
      makeTrack('Creep', 'Radiohead', 'Pablo Honey'),
      makeTrack('Karma Police', 'Radiohead', 'OK Computer'),
      makeTrack('Bohemian Rhapsody', 'Queen', 'News of the World'),
    ]
    buildSearchIndex()
  })

  test('AND logic — les deux mots doivent matcher', () => {
    // "radiohead" + "karma" = seulement track 1
    const result = searchTracksWithIndex('radiohead karma')
    expect(result.size).toBe(1)
    expect(result.has(1)).toBe(true)
  })

  test('intersection reduit les resultats', () => {
    // "radiohead" seul = 2 tracks, "pablo" seul = 1 track → intersection = 1
    const result = searchTracksWithIndex('radiohead pablo')
    expect(result.size).toBe(1)
    expect(result.has(0)).toBe(true)
  })

  test('un mot sans match → Set vide (early break)', () => {
    const result = searchTracksWithIndex('radiohead metallica')
    expect(result.size).toBe(0)
  })
})

describe('searchTracksWithIndex — edge cases', () => {
  test('null → null', () => {
    expect(searchTracksWithIndex(null)).toBeNull()
  })

  test('empty string → null', () => {
    expect(searchTracksWithIndex('')).toBeNull()
  })

  test('query d un seul char acceptee', () => {
    library.tracks = [makeTrack('ABC', 'Artist', 'Album')]
    buildSearchIndex()
    // La query "a" est acceptee (length >= 1) meme si le mot "a" n'est pas dans l'index (< 2 chars)
    const result = searchTracksWithIndex('a')
    expect(result).toBeDefined()
    // Pas de match car "a" n'est pas dans l'index (mots < 2 chars exclus de l'index)
    // mais "abc" contient "a" via substring match sur les mots de l'index
    // "abc" indexWord.includes("a") = true → match
    expect(result.has(0)).toBe(true)
  })
})
