// panels.js — Queue panel, context menu, and track info panel
// Extracted from renderer.js as part of module decomposition.

import { library, playback, queue, ui, caches, favorites, contextMenu, dom } from './state.js'
import { invoke } from './state.js'
import { app } from './app.js'
import { formatTime, escapeHtml, showToast, isValidImageSrc, formatQuality, getCodecFromPath } from './utils.js'

// === CONSTANTS ===

const DRAG_THRESHOLD = 5 // pixels — minimum movement before queue drag begins

// === MODULE STATE ===

let queueIndicatorsPending = false

// AbortController for context menu document listeners (active only while menu is visible)
let contextMenuAbort = null

// ============================================================================
// QUEUE FUNCTIONS
// ============================================================================

// Add a track to the end of the queue
export function addToQueue(track) {
  queue.items.push(track)
  updateQueueDisplay()
  updateQueueIndicators()
  showQueueNotification(`"${track.metadata?.title || track.name}" added to queue`)
}

// Play next — insert at the top of the queue
export function playNext(track) {
  queue.items.unshift(track)
  updateQueueDisplay()
  updateQueueIndicators()
  showQueueNotification(`"${track.metadata?.title || track.name}" will play next`)
}

// Remove a track from the queue by index
export function removeFromQueue(index) {
  queue.items.splice(index, 1)
  updateQueueDisplay()
  updateQueueIndicators()
}

// Clear the entire queue
export function clearQueue() {
  queue.items.length = 0
  updateQueueDisplay()
  updateQueueIndicators()
}

// Update "in-queue" indicators on visible track rows
// Uses requestIdleCallback to avoid blocking the UI
export function updateQueueIndicators() {
  if (queueIndicatorsPending) return
  queueIndicatorsPending = true

  const updateFn = () => {
    queueIndicatorsPending = false
    const queuePaths = new Set(queue.items.map(t => t.path))

    // Update buttons in the Tracks list view
    document.querySelectorAll('.tracks-list-item').forEach(item => {
      const trackPath = item.dataset.trackPath
      const btn = item.querySelector('.tracks-list-add-queue')
      if (btn && trackPath) {
        const isInQueue = queuePaths.has(trackPath)
        btn.classList.toggle('in-queue', isInQueue)
        btn.title = isInQueue ? 'Remove from queue' : 'Add to queue'
      }
    })

    // Update buttons in the album detail panel
    document.querySelectorAll('.album-track-item').forEach(item => {
      const trackPath = item.dataset.trackPath
      const btn = item.querySelector('.track-add-queue')
      if (btn && trackPath) {
        const isInQueue = queuePaths.has(trackPath)
        btn.classList.toggle('in-queue', isInQueue)
        btn.title = isInQueue ? 'Remove from queue' : 'Add to queue'
      }
    })
  }

  if ('requestIdleCallback' in window) {
    requestIdleCallback(updateFn, { timeout: 100 })
  } else {
    setTimeout(updateFn, 0)
  }
}

// Toggle the queue side panel open/closed
export function toggleQueuePanel() {
  if (!ui.isQueuePanelOpen) {
    // Close other panels before opening
    if (ui.isTrackInfoPanelOpen) closeTrackInfoPanel()
    if (ui.isSettingsPanelOpen) app.closeSettings()
    if (app.getEqPanelOpen()) app.closeEqPanel()
  }
  ui.isQueuePanelOpen = !ui.isQueuePanelOpen
  const panel = document.getElementById('queue-panel')
  const btn = document.getElementById('queue-btn')
  if (panel) panel.classList.toggle('open', ui.isQueuePanelOpen)
  if (btn) btn.classList.toggle('active', ui.isQueuePanelOpen)
}

// Show a temporary queue notification toast
export function showQueueNotification(message) {
  let notification = document.getElementById('queue-notification')
  if (!notification) {
    notification = document.createElement('div')
    notification.id = 'queue-notification'
    notification.className = 'queue-notification'
    document.body.appendChild(notification)
  }
  notification.textContent = message
  notification.classList.add('show')
  setTimeout(() => notification.classList.remove('show'), 2000)
}

// Update the queue panel display (current track + upcoming list)
export function updateQueueDisplay() {
  const queueList = document.getElementById('queue-list')
  const queueEmpty = document.getElementById('queue-empty')
  const queueNext = document.getElementById('queue-next')
  const queueCurrent = document.getElementById('queue-current')
  const clearBtn = document.getElementById('clear-queue')

  if (!queueList) return

  // Show/hide based on whether queue is empty
  if (queue.items.length === 0) {
    queueEmpty?.classList.remove('hidden')
    queueNext?.classList.add('hidden')
    if (clearBtn) clearBtn.style.display = 'none'
  } else {
    queueEmpty?.classList.add('hidden')
    queueNext?.classList.remove('hidden')
    if (clearBtn) clearBtn.style.display = 'block'
  }

  // Update the currently-playing track section
  if (queueCurrent && playback.currentTrackIndex >= 0) {
    const currentTrack = library.tracks[playback.currentTrackIndex]
    queueCurrent.innerHTML = `
      <div class="queue-item-cover">
        <div class="queue-item-placeholder">♪</div>
      </div>
      <div class="queue-item-info">
        <span class="queue-item-title">${currentTrack.metadata?.title || currentTrack.name}</span>
        <span class="queue-item-artist">${currentTrack.metadata?.artist || 'Unknown Artist'}</span>
      </div>
    `
    // Load the cover art
    const coverDiv = queueCurrent.querySelector('.queue-item-cover')
    if (caches.coverCache.has(currentTrack.path)) {
      const cover = caches.coverCache.get(currentTrack.path)
      if (cover) {
        coverDiv.innerHTML = `<img src="${cover}" alt="">`
      }
    }
  }

  // Render the upcoming queue items
  queueList.innerHTML = queue.items.map((track, index) => `
    <div class="queue-item" data-index="${index}" data-track-path="${track.path}">
      <span class="queue-drag-handle" title="Drag to reorder">⠿</span>
      <span class="queue-item-index">${index + 1}</span>
      <div class="queue-item-info">
        <span class="queue-item-title">${track.metadata?.title || track.name}</span>
        <span class="queue-item-artist">${track.metadata?.artist || 'Unknown Artist'}</span>
      </div>
      <button class="queue-item-remove" title="Retirer">✕</button>
    </div>
  `).join('')
}

// Initialise queue panel event listeners (including drag reorder)
export function initQueueListeners() {
  const queueBtn = document.getElementById('queue-btn')
  const clearQueueBtn = document.getElementById('clear-queue')
  const closeQueueBtn = document.getElementById('close-queue')
  const queueList = document.getElementById('queue-list')

  if (queueBtn) {
    queueBtn.addEventListener('click', toggleQueuePanel)
  }

  if (clearQueueBtn) {
    clearQueueBtn.addEventListener('click', clearQueue)
  }

  if (closeQueueBtn) {
    closeQueueBtn.addEventListener('click', toggleQueuePanel)
  }

  // EVENT DELEGATION for queue list
  if (queueList) {
    // Click on an item
    queueList.addEventListener('click', (e) => {
      const item = e.target.closest('.queue-item')
      if (!item) return

      const index = parseInt(item.dataset.index)
      const trackPath = item.dataset.trackPath

      // Remove button
      if (e.target.closest('.queue-item-remove')) {
        e.stopPropagation()
        removeFromQueue(index)
        return
      }

      // Click on info = play immediately
      if (e.target.closest('.queue-item-info')) {
        const globalIndex = library.tracks.findIndex(t => t.path === trackPath)
        if (globalIndex !== -1) {
          queue.items.splice(index, 1)
          app.playTrack(globalIndex)
          updateQueueDisplay()
        }
      }
    })

    // Right-click = context menu
    queueList.addEventListener('contextmenu', (e) => {
      const item = e.target.closest('.queue-item')
      if (!item) return

      const trackPath = item.dataset.trackPath
      const track = library.tracks.find(t => t.path === trackPath)
      if (!track) return

      const globalIndex = library.tracks.findIndex(t => t.path === trackPath)
      showContextMenu(e, track, globalIndex)
    })

    // === CUSTOM DRAG for queue reorder (HTML5 drag does not work in Tauri WebView) ===
    let queueDragState = {
      isDragging: false,
      isPotentialDrag: false,
      draggedItem: null,
      draggedIndex: -1,
      startX: 0,
      startY: 0,
      currentDropTarget: null
    }

    // Mousedown: prepare drag
    queueList.addEventListener('mousedown', (e) => {
      // Ignore if clicking the remove button
      if (e.target.closest('.queue-item-remove')) return

      const item = e.target.closest('.queue-item')
      if (!item) return

      queueDragState.isPotentialDrag = true
      queueDragState.draggedItem = item
      queueDragState.draggedIndex = parseInt(item.dataset.index)
      queueDragState.startX = e.clientX
      queueDragState.startY = e.clientY
    })

    // Mousemove: handle drag
    document.addEventListener('mousemove', (e) => {
      if (!queueDragState.isPotentialDrag) return

      // Check movement threshold
      if (!queueDragState.isDragging) {
        const dx = Math.abs(e.clientX - queueDragState.startX)
        const dy = Math.abs(e.clientY - queueDragState.startY)

        if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
          queueDragState.isDragging = true
          queueDragState.draggedItem?.classList.add('dragging')
        }
      }

      if (!queueDragState.isDragging) return

      // Find element under cursor
      const elementUnder = document.elementFromPoint(e.clientX, e.clientY)
      const targetItem = elementUnder?.closest('.queue-item')

      // Remove indicator from old target
      if (queueDragState.currentDropTarget && queueDragState.currentDropTarget !== targetItem) {
        queueDragState.currentDropTarget.classList.remove('drag-over-top', 'drag-over-bottom')
      }

      // Add indicator on new target
      if (targetItem && targetItem !== queueDragState.draggedItem) {
        const rect = targetItem.getBoundingClientRect()
        const midY = rect.top + rect.height / 2

        if (e.clientY < midY) {
          targetItem.classList.add('drag-over-top')
          targetItem.classList.remove('drag-over-bottom')
        } else {
          targetItem.classList.add('drag-over-bottom')
          targetItem.classList.remove('drag-over-top')
        }
        queueDragState.currentDropTarget = targetItem
      } else {
        queueDragState.currentDropTarget = null
      }
    })

    // Mouseup: finish drag
    document.addEventListener('mouseup', (e) => {
      if (!queueDragState.isPotentialDrag) return

      const wasDragging = queueDragState.isDragging
      const draggedIndex = queueDragState.draggedIndex

      // Clean up classes
      if (queueDragState.draggedItem) {
        queueDragState.draggedItem.classList.remove('dragging')
      }
      if (queueDragState.currentDropTarget) {
        queueDragState.currentDropTarget.classList.remove('drag-over-top', 'drag-over-bottom')
      }

      // If we actually dragged, rearrange the queue
      if (wasDragging && queueDragState.currentDropTarget) {
        const targetIndex = parseInt(queueDragState.currentDropTarget.dataset.index)

        if (targetIndex !== draggedIndex) {
          const rect = queueDragState.currentDropTarget.getBoundingClientRect()
          const midY = rect.top + rect.height / 2
          let newIndex = e.clientY < midY ? targetIndex : targetIndex + 1

          // Adjust if moving down
          if (newIndex > draggedIndex) {
            newIndex--
          }

          // Rearrange the queue
          const [movedTrack] = queue.items.splice(draggedIndex, 1)
          queue.items.splice(newIndex, 0, movedTrack)

          // Update display
          updateQueueDisplay()
          updateQueueIndicators()
        }
      }

      // Reset state
      queueDragState.isPotentialDrag = false
      queueDragState.isDragging = false
      queueDragState.draggedItem = null
      queueDragState.draggedIndex = -1
      queueDragState.currentDropTarget = null
    })
  }
}

// ============================================================================
// CONTEXT MENU FUNCTIONS
// ============================================================================

// Context menu for an album (right-click on album header)
export function showAlbumContextMenu(e, albumKey) {
  e.preventDefault()

  const album = library.albums[albumKey]
  if (!album) return

  // Remove any existing album context menu
  document.querySelectorAll('.album-context-menu').forEach(m => m.remove())
  hideContextMenu()

  const menu = document.createElement('div')
  menu.className = 'context-menu album-context-menu'
  menu.innerHTML = `
    <button class="context-menu-item" data-action="play-album">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      <span>Play album</span>
    </button>
    <button class="context-menu-item" data-action="add-album-queue">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M16 5H3"/><path d="M16 12H3"/><path d="M9 19H3"/><path d="M16 16l-3 3 3 3"/><path d="M21 5v12a2 2 0 0 1-2 2h-6"/>
      </svg>
      <span>Ajouter à la file d'attente</span>
    </button>
    <div class="context-menu-separator"></div>
    <button class="context-menu-item" data-action="create-playlist-from-album">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 5v14"/><path d="M5 12h14"/>
      </svg>
      <span>Créer une playlist avec cet album</span>
    </button>
  `

  // Position
  menu.style.left = `${e.clientX}px`
  menu.style.top = `${e.clientY}px`
  document.body.appendChild(menu)

  // Actions
  menu.querySelector('[data-action="play-album"]').addEventListener('click', () => {
    app.playAlbum(albumKey)
    menu.remove()
  })

  menu.querySelector('[data-action="add-album-queue"]').addEventListener('click', () => {
    album.tracks.forEach(track => addToQueue(track))
    showQueueNotification(`${album.tracks.length} tracks added to queue`)
    menu.remove()
  })

  menu.querySelector('[data-action="create-playlist-from-album"]').addEventListener('click', async () => {
    const playlistName = `${album.artist} - ${album.album}`

    try {
      const newPlaylist = await invoke('create_playlist', { name: playlistName })
      // Playlist storage is handled by the playlists module
      app.updatePlaylistsSidebar()

      // Add all album tracks to the new playlist
      for (const track of album.tracks) {
        await app.addTrackToPlaylist(newPlaylist.id, track)
      }

      showToast(`Playlist "${playlistName}" created with ${album.tracks.length} tracks`)
    } catch (e) {
      console.error('Erreur création playlist:', e)
      showToast('Error creating playlist')
    }

    menu.remove()
  })

  // Close on click outside
  const closeHandler = (ev) => {
    if (!ev.target.closest('.album-context-menu')) {
      menu.remove()
      document.removeEventListener('click', closeHandler)
    }
  }
  setTimeout(() => document.addEventListener('click', closeHandler), 0)
}

// Show the track context menu (with multi-selection support)
// selectedTrackPaths: optional Set<string> of selected track paths (for multi-selection)
export function showContextMenu(e, track, trackIndex, selectedTrackPaths = null) {
  e.preventDefault()
  e.stopPropagation()

  const isMultiSelection = selectedTrackPaths
    ? selectedTrackPaths.size > 1 && selectedTrackPaths.has(track.path)
    : false

  // If multi-selection, keep all selected tracks; otherwise just the clicked one
  contextMenu.tracks = isMultiSelection
    ? library.tracks.filter(t => selectedTrackPaths.has(t.path))
    : [track]
  contextMenu.trackIndex = trackIndex

  const menu = document.getElementById('context-menu')
  if (!menu) return

  // Update labels based on number of tracks
  updateContextMenuLabels(menu, contextMenu.tracks.length)

  // Menu position
  const x = e.clientX
  const y = e.clientY

  // Adjust to keep within the screen
  const menuWidth = 220
  const menuHeight = 280
  const windowWidth = window.innerWidth
  const windowHeight = window.innerHeight

  let posX = x
  let posY = y

  if (x + menuWidth > windowWidth) {
    posX = windowWidth - menuWidth - 10
  }
  if (y + menuHeight > windowHeight) {
    posY = windowHeight - menuHeight - 10
  }

  menu.style.left = `${posX}px`
  menu.style.top = `${posY}px`
  menu.classList.remove('hidden')

  // Activate document-level close listeners only while menu is visible
  activateContextMenuCloseListeners()

  // Update option visibility based on context
  const goToAlbumBtn = menu.querySelector('[data-action="go-to-album"]')
  const goToArtistBtn = menu.querySelector('[data-action="go-to-artist"]')
  const showInfoBtn = menu.querySelector('[data-action="show-info"]')
  const isMulti = contextMenu.tracks.length > 1

  // Hide "Go to album", "Go to artist" and "Info" in multi-selection
  if (goToAlbumBtn) {
    goToAlbumBtn.style.display = (isMulti || (ui.currentView === 'albums' && ui.selectedAlbumKey)) ? 'none' : 'flex'
  }
  if (goToArtistBtn) {
    goToArtistBtn.style.display = (isMulti || ui.currentView === 'artists') ? 'none' : 'flex'
  }
  if (showInfoBtn) {
    showInfoBtn.style.display = isMulti ? 'none' : 'flex'
  }
}

// Update context menu labels based on the number of tracks
function updateContextMenuLabels(menu, count) {
  const isMulti = count > 1

  const playBtn = menu.querySelector('[data-action="play"] span')
  const queueBtn = menu.querySelector('[data-action="add-to-queue"] span')
  const playlistBtn = menu.querySelector('[data-action="add-to-playlist"] span')
  const removeBtn = menu.querySelector('[data-action="remove-from-library"] span')

  const editBtn = menu.querySelector('[data-action="edit-metadata"] span')

  if (playBtn) playBtn.textContent = isMulti ? `Lire ${count} titres` : 'Lire'
  if (queueBtn) queueBtn.textContent = isMulti ? `Add ${count} to queue` : 'Add to queue'
  if (playlistBtn) playlistBtn.textContent = isMulti ? `Add ${count} to playlist` : 'Add to playlist'
  if (removeBtn) removeBtn.textContent = isMulti ? `Remove ${count} tracks` : 'Remove from library'
  if (editBtn) editBtn.textContent = isMulti ? `Edit ${count} tracks` : 'Edit Metadata'
}

// Hide the context menu
export function closeContextMenu() {
  const menu = document.getElementById('context-menu')
  if (menu) {
    menu.classList.add('hidden')
  }
  contextMenu.tracks = []
  contextMenu.trackIndex = -1
}

// Alias kept for internal consistency (original name in renderer.js)
function hideContextMenu() {
  if (contextMenuAbort) {
    contextMenuAbort.abort()
    contextMenuAbort = null
  }
  closeContextMenu()
}

// Handle context menu action clicks (with multi-selection support)
function handleContextMenuAction(action) {
  if (contextMenu.tracks.length === 0) return

  const isMulti = contextMenu.tracks.length > 1

  switch (action) {
    case 'play':
      if (isMulti) {
        // Multi: play the first, add the rest to queue
        const firstIdx = library.tracks.findIndex(t => t.path === contextMenu.tracks[0].path)
        if (firstIdx !== -1) app.playTrack(firstIdx)
        for (let i = 1; i < contextMenu.tracks.length; i++) {
          addToQueue(contextMenu.tracks[i])
        }
      } else {
        const idx = library.tracks.findIndex(t => t.path === contextMenu.tracks[0].path)
        if (idx !== -1) app.playTrack(idx)
      }
      break

    case 'add-to-queue':
      contextMenu.tracks.forEach(track => addToQueue(track))
      if (isMulti) {
        showQueueNotification(`${contextMenu.tracks.length} tracks added to queue`)
      }
      break

    case 'add-to-playlist':
      if (isMulti) {
        app.showAddToPlaylistMenuMulti(contextMenu.tracks)
      } else {
        app.showAddToPlaylistMenu(null, contextMenu.tracks[0])
      }
      return // Don't close menu — the sub-menu handles it

    case 'go-to-album':
      if (!isMulti) {
        goToTrackAlbum(contextMenu.tracks[0])
      }
      break

    case 'go-to-artist':
      if (!isMulti) {
        goToTrackArtist(contextMenu.tracks[0])
      }
      break

    case 'show-info':
      if (!isMulti) {
        showTrackInfoPanel(contextMenu.tracks[0])
      }
      break

    case 'edit-metadata':
      if (isMulti) {
        app.showBulkEditModal(contextMenu.tracks)
      } else {
        app.openTrackInfoInEditMode(contextMenu.tracks[0])
      }
      break

    case 'remove-from-library': {
      const tracks = [...contextMenu.tracks]
      const count = tracks.length
      const msg = count > 1
        ? `Supprimer ${count} tracks de la bibliothèque ? Cette action est permanente.`
        : `Supprimer « ${tracks[0]?.metadata?.title || tracks[0]?.name || 'cette track'} » de la bibliothèque ? Cette action est permanente.`
      if (confirm(msg)) {
        app.removeTracksFromLibrary(tracks)
      }
      break
    }
  }

  hideContextMenu()
}

// Initialise context menu event listeners — called ONCE at init
export function initContextMenuListeners() {
  const menu = document.getElementById('context-menu')
  if (!menu) return

  // Single delegated listener on the menu container (instead of one per item)
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.context-menu-item')
    if (item) handleContextMenuAction(item.dataset.action)
  })
}

// Activate document-level close listeners while the context menu is visible.
// Uses AbortController so they are automatically removed when the menu hides.
function activateContextMenuCloseListeners() {
  if (contextMenuAbort) contextMenuAbort.abort()
  contextMenuAbort = new AbortController()
  const { signal } = contextMenuAbort

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#context-menu')) hideContextMenu()
  }, { signal })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideContextMenu()
  }, { signal })

  document.addEventListener('scroll', hideContextMenu, { signal, capture: true })
}

// ============================================================================
// TRACK INFO PANEL
// ============================================================================

// Format sample rate for display (e.g. 96000 -> "96kHz")
function formatSampleRate(hz) {
  if (hz >= 1000) {
    const khz = hz / 1000
    return khz % 1 === 0 ? `${khz}kHz` : `${khz.toFixed(1)}kHz`
  }
  return `${hz}Hz`
}

// Detect duplicate tracks in the library
function findTrackDuplicates(track) {
  const meta = track.metadata || {}
  const title = (meta.title || track.name || '').toLowerCase().trim()
  const artist = (meta.artist || '').toLowerCase().trim()

  if (!title) return []

  return library.tracks.filter(t => {
    if (t.path === track.path) return false // Exclude self
    const tMeta = t.metadata || {}
    const tTitle = (tMeta.title || t.name || '').toLowerCase().trim()
    const tArtist = (tMeta.artist || '').toLowerCase().trim()
    return tTitle === title && tArtist === artist
  })
}

// Show the track info side panel
export async function showTrackInfoPanel(track) {
  const panel = document.getElementById('track-info-panel')
  const content = document.getElementById('track-info-content')
  if (!panel || !content) return

  // Close other panels before opening
  if (ui.isQueuePanelOpen) toggleQueuePanel()
  if (ui.isSettingsPanelOpen) app.closeSettings()
  if (app.getEqPanelOpen()) app.closeEqPanel()

  ui.trackInfoCurrentTrack = track
  ui.isTrackInfoPanelOpen = true
  panel.classList.add('open')

  // Metadata
  const meta = track.metadata || {}
  const title = meta.title || track.name || 'Titre inconnu'
  const artist = meta.artist || 'Unknown Artist'
  const album = meta.album || 'Unknown Album'
  const year = meta.year || null
  const trackNum = meta.track || null
  const disc = meta.disc || null
  const duration = meta.duration ? formatTime(meta.duration) : '-'
  const bitDepth = meta.bitDepth || null
  const sampleRate = meta.sampleRate || null
  const bitrate = meta.bitrate || null
  const codec = meta.codec || null
  const genre = meta.genre || null

  // File extension from path
  const fileExt = track.path ? track.path.split('.').pop().toUpperCase() : null

  // Audio quality badge
  const quality = formatQuality(meta, track.path)

  // Detect duplicates
  const duplicates = findTrackDuplicates(track)
  const hasDuplicates = duplicates.length > 0

  // Quality icon
  const qualityIcon = quality.class === 'quality-hires'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>'
    : quality.class === 'quality-lossless'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'

  // Build HTML
  let html = `
    <div class="track-info-artwork-section">
      <div class="track-info-artwork-container">
        <div class="track-info-artwork-loader" id="track-info-artwork-loader">
          <div class="artwork-spinner"></div>
        </div>
        <img class="track-info-artwork" id="track-info-artwork-img" src="" alt="Artwork" style="display: none;">
        <div class="track-info-artwork-placeholder" id="track-info-artwork-placeholder" style="display: none;">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
          </svg>
        </div>
      </div>
    </div>

    ${hasDuplicates ? `
    <div class="track-info-duplicate-alert">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <span>${duplicates.length} duplicate${duplicates.length > 1 ? 's' : ''} found in library</span>
    </div>
    ` : ''}

    <div class="track-info-title-section">
      <h2 class="track-info-title">${escapeHtml(title)}</h2>
      <p class="track-info-artist track-info-clickable" data-artist="${escapeHtml(artist)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="track-info-link-icon">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
        </svg>
        ${escapeHtml(artist)}
      </p>
      <p class="track-info-album track-info-clickable" data-album="${escapeHtml(album)}">
        <svg viewBox="0 0 24 24" fill="currentColor" class="track-info-link-icon">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"/>
        </svg>
        ${escapeHtml(album)}
      </p>
      <div class="track-info-quality-badge ${quality.class}">
        ${qualityIcon}
        <span>${quality.label}</span>
      </div>
    </div>

    <div class="track-info-specs">
      <div class="track-info-specs-grid">
        <div class="track-info-spec">
          <span class="track-info-spec-label">Quality</span>
          <span class="track-info-spec-value">${quality.label}</span>
        </div>
        <div class="track-info-spec">
          <span class="track-info-spec-label">Duration</span>
          <span class="track-info-spec-value">${duration}</span>
        </div>
        ${fileExt ? `
        <div class="track-info-spec">
          <span class="track-info-spec-label">Format</span>
          <span class="track-info-spec-value">${fileExt}${codec ? ` (${codec})` : ''}</span>
        </div>
        ` : ''}
        ${sampleRate ? `
        <div class="track-info-spec">
          <span class="track-info-spec-label">Sample Rate</span>
          <span class="track-info-spec-value">${formatSampleRate(sampleRate)}</span>
        </div>
        ` : ''}
        ${bitrate ? `
        <div class="track-info-spec">
          <span class="track-info-spec-label">Bitrate</span>
          <span class="track-info-spec-value">${Math.round(bitrate)} kbps</span>
        </div>
        ` : ''}
        ${bitDepth ? `
        <div class="track-info-spec">
          <span class="track-info-spec-label">Profondeur</span>
          <span class="track-info-spec-value">${bitDepth}-bit</span>
        </div>
        ` : ''}
      </div>
    </div>

    ${year || trackNum || genre ? `
    <div class="track-info-metadata">
      <div class="track-info-metadata-grid">
        ${year ? `
        <div class="track-info-metadata-item">
          <span class="track-info-metadata-label">Year</span>
          <span class="track-info-metadata-value">${year}</span>
        </div>
        ` : ''}
        ${trackNum ? `
        <div class="track-info-metadata-item">
          <span class="track-info-metadata-label">Piste</span>
          <span class="track-info-metadata-value">${disc ? `${disc}-` : ''}${trackNum}</span>
        </div>
        ` : ''}
        ${genre ? `
        <div class="track-info-metadata-item">
          <span class="track-info-metadata-label">Genre</span>
          <span class="track-info-metadata-value">${escapeHtml(genre)}</span>
        </div>
        ` : ''}
      </div>
    </div>
    ` : ''}

    <div class="track-info-file">
      <span class="track-info-metadata-label">Fichier</span>
      <div class="track-info-file-path">${escapeHtml(track.path || '')}</div>
    </div>

    <div class="track-info-actions">
      <button class="track-info-refresh-btn" id="track-info-refresh-btn" title="Refresh metadata">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>
          <path d="M21 3v5h-5"/>
        </svg>
        Rafraîchir les métadonnées
      </button>
      <button class="track-info-edit-btn" id="track-info-edit-btn" title="Edit Metadata">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
        Edit
      </button>
    </div>
  `

  content.innerHTML = html

  // Event listener for edit button
  const editBtn = document.getElementById('track-info-edit-btn')
  if (editBtn) {
    editBtn.addEventListener('click', () => enterTrackEditMode(track))
  }

  // Add event listeners for clickable links
  const artistLink = content.querySelector('.track-info-artist.track-info-clickable')
  const albumLink = content.querySelector('.track-info-album.track-info-clickable')

  if (artistLink) {
    artistLink.addEventListener('click', () => {
      const artistName = artistLink.dataset.artist
      if (artistName && library.artists[artistName]) {
        closeTrackInfoPanel()
        app.navigateToArtistPage(artistName)
      }
    })
  }

  if (albumLink) {
    albumLink.addEventListener('click', () => {
      const albumName = albumLink.dataset.album
      if (albumName) {
        const albumKey = Object.keys(library.albums).find(key => library.albums[key].album === albumName)
        if (albumKey) {
          closeTrackInfoPanel()
          app.navigateToAlbumPage(albumKey)
        }
      }
    })
  }

  // Event listener for metadata refresh button
  const refreshBtn = document.getElementById('track-info-refresh-btn')
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true
      refreshBtn.textContent = 'Actualisation...'
      try {
        const newMeta = await invoke('refresh_metadata', { path: track.path })
        // Update track in memory
        track.metadata = newMeta
        // Update in the global tracks array
        const idx = library.tracks.findIndex(t => t.path === track.path)
        if (idx >= 0) library.tracks[idx].metadata = newMeta
        // Invalidate cover cache to force reload
        caches.coverCache.delete(track.path)
        // Reload panel with new data
        showTrackInfoPanel(track)
        showToast('Metadata updated')
      } catch (e) {
        console.error('Erreur refresh metadata:', e)
        showToast('Error updating')
        refreshBtn.disabled = false
        refreshBtn.textContent = 'Refresh metadata'
      }
    })
  }

  // Load artwork asynchronously
  const imgEl = document.getElementById('track-info-artwork-img')
  const placeholderEl = document.getElementById('track-info-artwork-placeholder')
  const loaderEl = document.getElementById('track-info-artwork-loader')

  if (imgEl && placeholderEl && loaderEl) {
    // Check caches first (instant, no loader)
    const cachedCover = caches.coverCache.get(track.path) || caches.thumbnailCache.get(track.path)
    if (isValidImageSrc(cachedCover)) {
      imgEl.src = cachedCover
      imgEl.style.display = 'block'
      placeholderEl.style.display = 'none'
      loaderEl.style.display = 'none'
    } else {
      // Show loader while loading
      loaderEl.style.display = 'flex'
      imgEl.style.display = 'none'
      placeholderEl.style.display = 'none'

      try {
        // Force load from backend
        const cover = await invoke('get_cover', { path: track.path })

        if (cover) {
          imgEl.src = cover
          imgEl.onload = () => {
            loaderEl.style.display = 'none'
            imgEl.style.display = 'block'
            placeholderEl.style.display = 'none'
          }
          imgEl.onerror = () => {
            loaderEl.style.display = 'none'
            imgEl.style.display = 'none'
            placeholderEl.style.display = 'flex'
          }
          // Cache the result
          caches.coverCache.set(track.path, cover)
        } else {
          // No cover, show placeholder
          loaderEl.style.display = 'none'
          imgEl.style.display = 'none'
          placeholderEl.style.display = 'flex'
        }
      } catch (e) {
        console.warn('Impossible de charger la pochette:', e)
        loaderEl.style.display = 'none'
        imgEl.style.display = 'none'
        placeholderEl.style.display = 'flex'
      }
    }
  }
}

// ============================================================================
// TRACK INFO — EDIT MODE (single track)
// ============================================================================

// Bascule le panel track info en mode édition (inputs à la place des textes)
// Collecte les genres uniques de la librairie, triés alphabétiquement
function getLibraryGenres() {
  const genres = new Set()
  library.tracks.forEach(t => { if (t.metadata?.genre) genres.add(t.metadata.genre) })
  return [...genres].sort((a, b) => a.localeCompare(b))
}

// Monte un combobox sur un input genre existant (appelé après innerHTML)
function setupGenreCombobox(inputId, dropdownId, initialValue) {
  const input = document.getElementById(inputId)
  const dropdown = document.getElementById(dropdownId)
  if (!input || !dropdown) return

  const allGenres = getLibraryGenres()
  if (initialValue) input.value = initialValue

  function renderDropdown(filter) {
    const q = (filter || '').toLowerCase()
    const filtered = q
      ? allGenres.filter(g => g.toLowerCase().includes(q))
      : allGenres
    dropdown.innerHTML = filtered
      .map(g => `<div class="genre-dropdown-item" data-genre="${escapeHtml(g)}">${escapeHtml(g)}</div>`)
      .join('')
    dropdown.classList.toggle('open', filtered.length > 0)
  }

  input.addEventListener('focus', () => renderDropdown(input.value))
  input.addEventListener('input', () => renderDropdown(input.value))
  input.addEventListener('blur', () => {
    setTimeout(() => dropdown.classList.remove('open'), 150)
  })
  dropdown.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.genre-dropdown-item')
    if (item) {
      input.value = item.dataset.genre
      dropdown.classList.remove('open')
    }
  })
}

export function enterTrackEditMode(track) {
  const content = document.getElementById('track-info-content')
  if (!content) return

  const meta = track.metadata || {}
  const origTitle  = meta.title  || track.name || ''
  const origArtist = meta.artist || ''
  const origAlbum  = meta.album  || ''
  const origYear   = meta.year   ? String(meta.year)  : ''
  const origTrack  = meta.track  ? String(meta.track) : ''
  const origGenre  = meta.genre  || ''

  content.innerHTML = `
    <div class="track-info-edit-form">
      <div class="track-info-edit-field">
        <label class="track-info-edit-label">Title</label>
        <input id="edit-title" type="text" value="${escapeHtml(origTitle)}" class="track-info-input" placeholder="Title">
      </div>
      <div class="track-info-edit-field">
        <label class="track-info-edit-label">Artist</label>
        <input id="edit-artist" type="text" value="${escapeHtml(origArtist)}" class="track-info-input" placeholder="Artist">
      </div>
      <div class="track-info-edit-field">
        <label class="track-info-edit-label">Album</label>
        <input id="edit-album" type="text" value="${escapeHtml(origAlbum)}" class="track-info-input" placeholder="Album">
      </div>
      <div class="track-info-edit-field">
        <label class="track-info-edit-label">Year</label>
        <input id="edit-year" type="number" value="${origYear}" class="track-info-input track-info-input-short" placeholder="2024" min="1900" max="2099">
      </div>
      <div class="track-info-edit-field">
        <label class="track-info-edit-label">Track #</label>
        <input id="edit-track-num" type="number" value="${origTrack}" class="track-info-input track-info-input-short" placeholder="1" min="1">
      </div>
      <div class="track-info-edit-field">
        <label class="track-info-edit-label">Genre</label>
        <div class="genre-combobox">
          <input id="edit-genre" type="text" class="track-info-input" autocomplete="off" placeholder="Genre">
          <div class="genre-dropdown" id="edit-genre-dropdown"></div>
        </div>
      </div>
    </div>
    <div class="track-info-edit-actions">
      <button class="track-info-cancel-btn" id="track-edit-cancel">Cancel</button>
      <button class="track-info-save-btn" id="track-edit-save">Save</button>
    </div>
  `

  setupGenreCombobox('edit-genre', 'edit-genre-dropdown', origGenre)

  content.querySelector('#track-edit-cancel').addEventListener('click', () => {
    showTrackInfoPanel(track)
  })
  content.querySelector('#track-edit-save').addEventListener('click', () => {
    saveTrackMetadata(track, { origTitle, origArtist, origAlbum, origYear, origTrack, origGenre })
  })

  // Focus le premier champ
  const firstInput = content.querySelector('.track-info-input')
  if (firstInput) firstInput.focus()
}

async function saveTrackMetadata(track, orig) {
  const saveBtn = document.getElementById('track-edit-save')
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...' }

  const newTitle   = document.getElementById('edit-title')?.value.trim()
  const newArtist  = document.getElementById('edit-artist')?.value.trim()
  const newAlbum   = document.getElementById('edit-album')?.value.trim()
  const newYearStr = document.getElementById('edit-year')?.value.trim()
  const newTrackStr = document.getElementById('edit-track-num')?.value.trim()
  const newGenre   = document.getElementById('edit-genre')?.value.trim()

  // Envoyer uniquement les champs modifiés (non-vides et différents de l'original)
  const payload = {
    path:        track.path,
    title:       (newTitle   && newTitle   !== orig.origTitle)   ? newTitle   : null,
    artist:      (newArtist  && newArtist  !== orig.origArtist)  ? newArtist  : null,
    album:       (newAlbum   && newAlbum   !== orig.origAlbum)   ? newAlbum   : null,
    year:        (newYearStr && newYearStr !== orig.origYear)     ? parseInt(newYearStr,  10) : null,
    trackNumber: (newTrackStr && newTrackStr !== orig.origTrack) ? parseInt(newTrackStr, 10) : null,
    genre:       (newGenre   && newGenre   !== orig.origGenre)   ? newGenre   : null,
  }

  try {
    await invoke('write_metadata', payload)
    // Muter track.metadata en place (pattern state.js — ne pas réassigner)
    if (payload.title)       track.metadata.title  = payload.title
    if (payload.artist)      track.metadata.artist = payload.artist
    if (payload.album)       track.metadata.album  = payload.album
    if (payload.year)        track.metadata.year   = payload.year
    if (payload.trackNumber) track.metadata.track  = payload.trackNumber
    if (payload.genre)       track.metadata.genre  = payload.genre
    // Reconstruire l'index artistes/albums pour refléter les nouvelles métadonnées
    app.groupTracksIntoAlbumsAndArtists()
    app.invalidateHomeCache?.()
    if (['artists', 'albums', 'home'].includes(ui.currentView)) {
      app.displayCurrentView()
    }
    showToast('Metadata saved')
    showTrackInfoPanel(track)
  } catch (err) {
    console.error('write_metadata error:', err)
    showToast(`Error: ${err}`, 'error')
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save' }
  }
}

// ============================================================================
// BULK EDIT MODAL (multiple tracks)
// ============================================================================

export function showBulkEditModal(tracks) {
  // Supprimer un éventuel modal existant
  document.getElementById('bulk-edit-modal')?.remove()

  // Calculer les valeurs communes à toutes les tracks sélectionnées
  function commonValue(getter) {
    const vals = tracks.map(getter).filter(v => v !== null && v !== undefined && v !== '')
    if (vals.length === 0) return { value: '', count: 0, allSame: true }
    const unique = [...new Set(vals.map(String))]
    return { value: unique.length === 1 ? unique[0] : '', count: unique.length, allSame: unique.length === 1 }
  }

  const cArtist = commonValue(t => t.metadata?.artist)
  const cAlbum  = commonValue(t => t.metadata?.album)
  const cYear   = commonValue(t => t.metadata?.year)
  const cGenre  = commonValue(t => t.metadata?.genre)

  const ph = (c) => !c.allSame && c.count > 0 ? `placeholder="${c.count} different values"` : ''
  const n = tracks.length

  const modal = document.createElement('div')
  modal.id = 'bulk-edit-modal'
  modal.className = 'bulk-edit-overlay'
  modal.innerHTML = `
    <div class="bulk-edit-dialog">
      <div class="bulk-edit-header">
        <h2 class="bulk-edit-title">Edit ${n} track${n > 1 ? 's' : ''}</h2>
        <button class="bulk-edit-close" id="bulk-edit-close" title="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <p class="bulk-edit-hint">Leave empty to keep the original value for each track.</p>
      <div class="track-info-edit-form">
        <div class="track-info-edit-field">
          <label class="track-info-edit-label">Artist</label>
          <input id="bulk-artist" type="text" value="${escapeHtml(cArtist.value)}" ${ph(cArtist)} class="track-info-input">
        </div>
        <div class="track-info-edit-field">
          <label class="track-info-edit-label">Album</label>
          <input id="bulk-album" type="text" value="${escapeHtml(cAlbum.value)}" ${ph(cAlbum)} class="track-info-input">
        </div>
        <div class="track-info-edit-field">
          <label class="track-info-edit-label">Year</label>
          <input id="bulk-year" type="number" value="${cYear.value}" ${ph(cYear)} class="track-info-input track-info-input-short" min="1900" max="2099">
        </div>
        <div class="track-info-edit-field">
          <label class="track-info-edit-label">Genre</label>
          <div class="genre-combobox">
            <input id="bulk-genre" type="text" value="${escapeHtml(cGenre.value)}" ${ph(cGenre)} class="track-info-input" autocomplete="off">
            <div class="genre-dropdown" id="bulk-genre-dropdown"></div>
          </div>
        </div>
        <div class="track-info-edit-field track-info-edit-field-checkbox">
          <label class="bulk-edit-checkbox-label">
            <input type="checkbox" id="bulk-autonumber" class="bulk-edit-checkbox">
            Auto-number tracks (1, 2, 3…)
          </label>
        </div>
      </div>
      <div class="track-info-edit-actions">
        <button class="track-info-cancel-btn" id="bulk-edit-cancel">Cancel</button>
        <button class="track-info-save-btn" id="bulk-edit-save">Save ${n} track${n > 1 ? 's' : ''}</button>
      </div>
    </div>
  `

  document.body.appendChild(modal)

  setupGenreCombobox('bulk-genre', 'bulk-genre-dropdown', cGenre.value)

  const closeFn = () => modal.remove()
  document.getElementById('bulk-edit-close').addEventListener('click', closeFn)
  document.getElementById('bulk-edit-cancel').addEventListener('click', closeFn)
  modal.addEventListener('click', (e) => { if (e.target === modal) closeFn() })
  document.getElementById('bulk-edit-save').addEventListener('click', () => {
    saveBulkMetadata(tracks, modal)
  })
}

async function saveBulkMetadata(tracks, modal) {
  const saveBtn = document.getElementById('bulk-edit-save')
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...' }

  const newArtist  = document.getElementById('bulk-artist')?.value.trim() || null
  const newAlbum   = document.getElementById('bulk-album')?.value.trim()  || null
  const newYearStr = document.getElementById('bulk-year')?.value.trim()
  const newYear    = newYearStr ? parseInt(newYearStr, 10) : null
  const newGenre   = document.getElementById('bulk-genre')?.value.trim()  || null
  const autoNum    = document.getElementById('bulk-autonumber')?.checked

  let saved = 0
  let errors = 0

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i]
    const trackNumber = autoNum ? i + 1 : null
    try {
      await invoke('write_metadata', {
        path: t.path,
        title: null,
        artist: newArtist,
        album: newAlbum,
        year: newYear,
        trackNumber,
        genre: newGenre,
      })
      if (newArtist)   t.metadata.artist = newArtist
      if (newAlbum)    t.metadata.album  = newAlbum
      if (newYear)     t.metadata.year   = newYear
      if (newGenre)    t.metadata.genre  = newGenre
      if (trackNumber) t.metadata.track  = trackNumber
      saved++
    } catch (err) {
      console.error(`write_metadata error for ${t.path}:`, err)
      errors++
    }
  }

  // Reconstruire l'index artistes/albums pour refléter les nouvelles métadonnées
  app.groupTracksIntoAlbumsAndArtists()
  app.invalidateHomeCache?.()
  if (['artists', 'albums', 'home'].includes(ui.currentView)) {
    app.displayCurrentView()
  }

  modal.remove()

  if (errors === 0) {
    showToast(`${saved} track${saved > 1 ? 's' : ''} updated`)
  } else {
    showToast(`${saved}/${tracks.length} tracks updated (${errors} error${errors > 1 ? 's' : ''})`, 'error')
  }
}

// Close the track info panel
export function closeTrackInfoPanel() {
  const panel = document.getElementById('track-info-panel')
  if (panel) {
    panel.classList.remove('open')
  }
  ui.isTrackInfoPanelOpen = false
  ui.trackInfoCurrentTrack = null
}

// Toggle the track info panel (close if open)
function toggleTrackInfoPanel() {
  if (ui.isTrackInfoPanelOpen) {
    closeTrackInfoPanel()
  }
}

// Initialise track info panel event listeners
export function initTrackInfoListeners() {
  const closeBtn = document.getElementById('close-track-info')
  if (closeBtn) {
    closeBtn.addEventListener('click', closeTrackInfoPanel)
  }

  // Close with Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.isTrackInfoPanelOpen) {
      closeTrackInfoPanel()
    }
  })
}

// ============================================================================
// NAVIGATION HELPERS (from context menu / track info)
// ============================================================================

// Navigate to the album page for a given track
export function goToTrackAlbum(track) {
  const albumName = track.metadata?.album
  if (!albumName) return

  const albumKey = Object.keys(library.albums).find(key => {
    return library.albums[key].album === albumName
  })

  if (albumKey) {
    app.navigateToAlbumPage(albumKey)
  }
}

// Navigate to the artist page for a given track
export function goToTrackArtist(track) {
  const artistName = track.metadata?.artist
  if (!artistName || !library.artists[artistName]) return

  app.navigateToArtistPage(artistName)
}

// ============================================================================
// CLOSE ALL PANELS (utility)
// ============================================================================

// Close all side panels (queue, track info, settings, EQ)
export function closeAllPanels() {
  if (ui.isQueuePanelOpen) toggleQueuePanel()
  if (ui.isTrackInfoPanelOpen) closeTrackInfoPanel()
  if (ui.isSettingsPanelOpen) app.closeSettings()
  if (app.getEqPanelOpen()) app.closeEqPanel()
}

// ============================================================================
// INITIALIZATION
// ============================================================================

// Master init — call once after DOMContentLoaded
export function initPanels() {
  initQueueListeners()
  initContextMenuListeners()
  initTrackInfoListeners()
}
