// ShuffleButton.test.js — Régression : icône shuffle fixe + badge de statut
//
// Bug corrigé : le statut était collé au texte du bouton ('⤮ᴬ', '⤮∞') → l'icône
// se décalait à chaque changement de mode, et le raccourci clavier utilisait un
// autre glyphe (⤢ U+2922 au lieu de ⤮ U+292E).

import { describe, test, expect, beforeAll } from '@jest/globals'
import { readFileSync } from 'fs'

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')

let SHUFFLE_ICON, getShuffleButtonState

beforeAll(async () => {
  const utils = await import('../utils.js')
  SHUFFLE_ICON = utils.SHUFFLE_ICON
  getShuffleButtonState = utils.getShuffleButtonState
})

describe('getShuffleButtonState', () => {
  test('icône principale = ⤮ (U+292E, flèches qui se croisent)', () => {
    expect(SHUFFLE_ICON).toBe('⤮')
  })

  test('off → pas de badge, bouton inactif', () => {
    expect(getShuffleButtonState('off')).toEqual({ badge: '', title: 'Shuffle', active: false })
  })

  test('album → badge "A", bouton actif', () => {
    expect(getShuffleButtonState('album')).toEqual({ badge: 'A', title: 'Shuffle (Album)', active: true })
  })

  test('library → badge "∞", bouton actif', () => {
    expect(getShuffleButtonState('library')).toEqual({ badge: '∞', title: 'Shuffle (Library)', active: true })
  })

  test('mode inconnu → traité comme off', () => {
    expect(getShuffleButtonState(undefined)).toEqual(getShuffleButtonState('off'))
  })
})

describe('Bouton shuffle — structure stable', () => {
  test('index.html : icône et badge sont deux éléments séparés', () => {
    const html = read('index.html')
    const button = html.match(/<button id="shuffle"[^>]*>([\s\S]*?)<\/button>/)
    expect(button).not.toBeNull()
    expect(button[1]).toContain(`<span class="shuffle-icon">${'⤮'}</span>`)
    expect(button[1]).toMatch(/<span class="shuffle-badge" hidden><\/span>/)
  })

  test('aucun module ne réécrit le texte du bouton (sinon l\'icône bouge)', () => {
    for (const file of ['playback.js', 'shortcuts.js']) {
      expect(read(file)).not.toMatch(/shuffleBtn\.(textContent|innerHTML|innerText)\s*=/)
    }
  })

  test('le raccourci clavier n\'utilise plus le glyphe ⤢ (U+2922)', () => {
    expect(read('shortcuts.js')).not.toMatch(/\\u2922|⤢/)
  })
})
