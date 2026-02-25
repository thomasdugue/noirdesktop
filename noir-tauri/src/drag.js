// drag.js — Système de drag & drop custom (car HTML5 drag ne fonctionne pas dans Tauri WebView)
// Utilise mousedown/mousemove/mouseup avec seuil de déplacement minimum

import { library, playback } from './state.js'
import { app } from './app.js'
import { showToast } from './utils.js'

const DRAG_THRESHOLD = 5 // pixels minimum avant de démarrer le drag

const customDragState = {
  isPotentialDrag: false,
  isDragging: false,
  track: null,
  albumKey: null,
  trackElement: null,
  ghostElement: null,
  startX: 0,
  startY: 0,
  currentHighlightedPlaylist: null
}

// Initialise le système de drag custom au chargement
export function initCustomDragSystem() {
  // Crée l'élément ghost pour le drag visuel
  const ghost = document.createElement('div')
  ghost.className = 'drag-ghost'
  ghost.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 9999;
    background: #2a2a2a;
    border: 1px solid #fff;
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 13px;
    color: #fff;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    display: none;
    max-width: 250px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `
  document.body.appendChild(ghost)
  customDragState.ghostElement = ghost

  // Gère le déplacement de la souris
  document.addEventListener('mousemove', (e) => {
    if (customDragState.isPotentialDrag && !customDragState.isDragging) {
      const dx = Math.abs(e.clientX - customDragState.startX)
      const dy = Math.abs(e.clientY - customDragState.startY)

      if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
        customDragState.isDragging = true
        document.body.classList.add('dragging-active')

        if (customDragState.albumKey && library.albums[customDragState.albumKey]) {
          const album = library.albums[customDragState.albumKey]
          customDragState.ghostElement.textContent = '\uD83D\uDCBF ' + album.album + ' (' + album.tracks.length + ' titres)'
        } else if (customDragState.track) {
          const title = customDragState.track.metadata?.title || customDragState.track.name
          customDragState.ghostElement.textContent = '\u266A ' + title
        }
        customDragState.ghostElement.style.display = 'block'

        if (customDragState.trackElement) {
          customDragState.trackElement.classList.add('dragging-track')
        }
      }
    }

    if (customDragState.isDragging) {
      customDragState.ghostElement.style.left = (e.clientX + 15) + 'px'
      customDragState.ghostElement.style.top = (e.clientY + 15) + 'px'

      const playlistItem = document.elementFromPoint(e.clientX, e.clientY)?.closest('.playlist-item')

      if (playlistItem !== customDragState.currentHighlightedPlaylist) {
        if (customDragState.currentHighlightedPlaylist) {
          customDragState.currentHighlightedPlaylist.classList.remove('drag-over')
        }
        if (playlistItem) {
          playlistItem.classList.add('drag-over')
        }
        customDragState.currentHighlightedPlaylist = playlistItem
      }
    }
  })

  // Gère le relâchement de la souris
  document.addEventListener('mouseup', async (e) => {
    const wasDragging = customDragState.isDragging

    if (customDragState.ghostElement) {
      customDragState.ghostElement.style.display = 'none'
    }

    document.body.classList.remove('dragging-active')

    if (customDragState.currentHighlightedPlaylist) {
      customDragState.currentHighlightedPlaylist.classList.remove('drag-over')
    }
    if (customDragState.trackElement) {
      customDragState.trackElement.classList.remove('dragging-track')
    }

    if (wasDragging) {
      const playlistItem = document.elementFromPoint(e.clientX, e.clientY)?.closest('.playlist-item')

      if (playlistItem) {
        const playlistId = playlistItem.dataset.playlistId
        if (playlistId) {
          if (customDragState.albumKey && library.albums[customDragState.albumKey]) {
            const album = library.albums[customDragState.albumKey]
            for (const track of album.tracks) {
              await app.addTrackToPlaylist(playlistId, track)
            }
            showToast(`Album "${album.album}" added to playlist`)
          } else if (customDragState.track) {
            await app.addTrackToPlaylist(playlistId, customDragState.track)
          }
        }
      }
    }

    // Reset l'état
    customDragState.isPotentialDrag = false
    customDragState.isDragging = false
    customDragState.track = null
    customDragState.albumKey = null
    customDragState.trackElement = null
    customDragState.currentHighlightedPlaylist = null
  })

  // === DRAG DEPUIS LE PLAYER ===
  const playerLeft = document.querySelector('.player-left')
  if (playerLeft) {
    playerLeft.addEventListener('mousedown', (e) => {
      if (e.target.closest('button') || playback.currentTrackIndex < 0) return
      const currentTrack = library.tracks[playback.currentTrackIndex]
      if (!currentTrack) return
      prepareCustomDrag(e, currentTrack, playerLeft)
    })
    playerLeft.style.cursor = 'grab'
  }
}

// Prépare un drag custom pour une track (appelé sur mousedown)
export function prepareCustomDrag(e, track, trackElement) {
  if (e.target.closest('button')) return false

  customDragState.isPotentialDrag = true
  customDragState.isDragging = false
  customDragState.track = track
  customDragState.albumKey = null
  customDragState.trackElement = trackElement
  customDragState.startX = e.clientX
  customDragState.startY = e.clientY

  return true
}

// Prépare un drag custom pour un album complet
export function prepareAlbumDrag(e, albumKey, cardElement) {
  if (e.target.closest('button')) return false

  customDragState.isPotentialDrag = true
  customDragState.isDragging = false
  customDragState.track = null
  customDragState.albumKey = albumKey
  customDragState.trackElement = cardElement
  customDragState.startX = e.clientX
  customDragState.startY = e.clientY

  return true
}

// Expose l'état pour vérifier si un drag est en cours (utilisé dans views.js)
export function isDragging() {
  return customDragState.isDragging
}

