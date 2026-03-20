// QueueManagement.test.js — Tests des fonctions de gestion de queue (panels.js)

import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals'
import { queue } from '../state.js'
import { app } from '../app.js'

let addToQueue, playNext, removeFromQueue, clearQueue

beforeAll(async () => {
  // Stubs pour les fonctions appelees par les queue ops
  app.updateQueueDisplay = () => {}
  app.updateQueueIndicators = () => {}
  app.showQueueNotification = () => {}
  app.buildSearchIndex = () => {}

  const panels = await import('../panels.js')
  addToQueue = panels.addToQueue
  playNext = panels.playNext
  removeFromQueue = panels.removeFromQueue
  clearQueue = panels.clearQueue
})

function makeTrack(title) {
  return {
    path: `/music/${title.toLowerCase().replace(/\s/g, '_')}.flac`,
    name: `${title}.flac`,
    metadata: { title, artist: 'Test Artist', album: 'Test Album' },
  }
}

beforeEach(() => {
  queue.items.length = 0
})

// === addToQueue ===

describe('addToQueue', () => {
  test('ajoute un track dans la queue', () => {
    addToQueue(makeTrack('Song A'))
    expect(queue.items).toHaveLength(1)
  })

  test('la longueur augmente a chaque ajout', () => {
    addToQueue(makeTrack('Song A'))
    addToQueue(makeTrack('Song B'))
    addToQueue(makeTrack('Song C'))
    expect(queue.items).toHaveLength(3)
  })

  test('donnees du track preservees', () => {
    const track = makeTrack('Test Song')
    addToQueue(track)
    expect(queue.items[0].metadata.title).toBe('Test Song')
    expect(queue.items[0].path).toContain('test_song')
  })
})

// === playNext ===

describe('playNext', () => {
  test('insere en position 0 (debut de queue)', () => {
    addToQueue(makeTrack('Song A'))
    playNext(makeTrack('Song B'))
    expect(queue.items[0].metadata.title).toBe('Song B')
  })

  test('le bon track est en tete apres insertion', () => {
    addToQueue(makeTrack('Song A'))
    addToQueue(makeTrack('Song B'))
    playNext(makeTrack('Priority'))
    expect(queue.items[0].metadata.title).toBe('Priority')
    expect(queue.items).toHaveLength(3)
  })
})

// === removeFromQueue ===

describe('removeFromQueue', () => {
  test('retire le bon index', () => {
    addToQueue(makeTrack('Song A'))
    addToQueue(makeTrack('Song B'))
    addToQueue(makeTrack('Song C'))
    // Queue apres 3 unshift: [C, B, A]
    removeFromQueue(1) // retire B
    expect(queue.items).toHaveLength(2)
    expect(queue.items.map(t => t.metadata.title)).not.toContain('Song B')
  })

  test('queue reduit de taille', () => {
    addToQueue(makeTrack('Song A'))
    addToQueue(makeTrack('Song B'))
    expect(queue.items).toHaveLength(2)
    removeFromQueue(0)
    expect(queue.items).toHaveLength(1)
  })

  test('retirer d une queue vide ne crash pas', () => {
    expect(() => removeFromQueue(0)).not.toThrow()
    expect(queue.items).toHaveLength(0)
  })
})

// === clearQueue ===

describe('clearQueue', () => {
  test('vide la queue', () => {
    addToQueue(makeTrack('Song A'))
    addToQueue(makeTrack('Song B'))
    clearQueue()
    expect(queue.items).toHaveLength(0)
  })

  test('reference de items preservee (length = 0, pas reassignment)', () => {
    const ref = queue.items
    addToQueue(makeTrack('Song A'))
    clearQueue()
    expect(queue.items).toBe(ref)
  })
})

// === Ordering ===

describe('Queue ordering', () => {
  test('interleaving addToQueue et playNext', () => {
    addToQueue(makeTrack('A'))
    playNext(makeTrack('B'))
    addToQueue(makeTrack('C'))
    // unshift(A) → [A]
    // unshift(B) → [B, A]
    // unshift(C) → [C, B, A]
    expect(queue.items[0].metadata.title).toBe('C')
    expect(queue.items[1].metadata.title).toBe('B')
    expect(queue.items[2].metadata.title).toBe('A')
  })

  test('ajouts multiples preservent l ordre LIFO', () => {
    addToQueue(makeTrack('First'))
    addToQueue(makeTrack('Second'))
    addToQueue(makeTrack('Third'))
    // unshift = LIFO → [Third, Second, First]
    expect(queue.items[0].metadata.title).toBe('Third')
    expect(queue.items[2].metadata.title).toBe('First')
  })
})

// === Integration ===

describe('Queue integration', () => {
  test('add puis remove restaure l etat', () => {
    addToQueue(makeTrack('A'))
    addToQueue(makeTrack('B'))
    removeFromQueue(0)
    removeFromQueue(0)
    expect(queue.items).toHaveLength(0)
  })

  test('clear apres ajouts multiples', () => {
    for (let i = 0; i < 10; i++) {
      addToQueue(makeTrack(`Song ${i}`))
    }
    expect(queue.items).toHaveLength(10)
    clearQueue()
    expect(queue.items).toHaveLength(0)
  })
})
