// playlists.js — Gestion des playlists et des favoris pour Noir Desktop
// Inclut: playlists CRUD, favoris, sidebar, modal, tri, drag reorder, menu contextuel

import { library, favorites, ui, contextMenu, dom } from './state.js'
import { invoke } from './state.js'
import { app } from './app.js'
import { formatTime, escapeHtml, showToast } from './utils.js'

// === MODULE STATE ===

let playlists = []                  // Liste des playlists
let selectedPlaylistId = null       // Playlist actuellement affichee
let playlistModalMode = 'create'    // 'create' ou 'rename'
let playlistToRename = null         // ID de la playlist a renommer
let trackToAddToPlaylist = null     // Track a ajouter depuis le sous-menu
let tracksToAddToPlaylist = null    // Tracks multiples a ajouter apres creation
let playlistSortMode = 'manual'    // 'manual', 'recent', 'az', 'za'

// === CONFIRM MODAL STATE ===

let confirmModalResolve = null

// === FAVORIS ===

// Charge les favoris depuis le backend
export async function loadFavorites() {
  try {
    const paths = await invoke('get_favorites')
    favorites.tracks = new Set(paths)
    console.log(`Favoris charges: ${favorites.tracks.size} tracks`)
  } catch (e) {
    console.error('Erreur chargement favoris:', e)
    favorites.tracks = new Set()
  }
}

// Toggle favori avec Optimistic UI
export async function toggleFavorite(trackPath, buttonEl) {
  if (!buttonEl) return

  // Optimistic UI - toggle immediat
  const wasActive = buttonEl.classList.contains('active')
  buttonEl.classList.toggle('active')

  // Mettre a jour le SVG (fill)
  const svg = buttonEl.querySelector('svg')
  if (svg) {
    svg.setAttribute('fill', wasActive ? 'none' : 'currentColor')
  }

  // Mettre a jour le Set local
  if (wasActive) {
    favorites.tracks.delete(trackPath)
  } else {
    favorites.tracks.add(trackPath)
  }

  // Appel async au backend
  try {
    await invoke('toggle_favorite', { trackPath })
    // Recharge les playlists pour mettre a jour le compteur
    await loadPlaylists()
  } catch (err) {
    console.error('Erreur toggle favorite:', err)
    // Rollback en cas d'erreur
    buttonEl.classList.toggle('active')
    if (svg) {
      svg.setAttribute('fill', wasActive ? 'currentColor' : 'none')
    }
    if (wasActive) {
      favorites.tracks.add(trackPath)
    } else {
      favorites.tracks.delete(trackPath)
    }
  }
}

// Genere le HTML du bouton favori pour une track
export function getFavoriteButtonHtml(trackPath) {
  const isFavorite = favorites.tracks.has(trackPath)
  return `
    <button class="track-favorite-btn ${isFavorite ? 'active' : ''}"
            data-track-path="${trackPath}"
            title="${isFavorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}">
      <svg width="14" height="14" viewBox="0 0 24 24"
           fill="${isFavorite ? 'currentColor' : 'none'}"
           stroke="currentColor" stroke-width="2">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
      </svg>
    </button>
  `
}

// === PLAYLISTS ===

// Charge les playlists au demarrage
export async function loadPlaylists() {
  try {
    playlists = await invoke('get_playlists')
    applyPlaylistsOrder()  // Applique l'ordre personnalise
    updatePlaylistsSidebar()
  } catch (e) {
    console.error('Erreur chargement playlists:', e)
    playlists = []
  }
}

// Met a jour l'affichage des playlists dans la sidebar
export function updatePlaylistsSidebar() {
  const container = document.getElementById('playlists-list')
  if (!container) return

  if (playlists.length === 0) {
    container.innerHTML = '<div class="playlists-empty">Aucune playlist</div>'
    return
  }

  // Trie pour avoir "mes favoris" en premier (isSystem = true)
  const sortedPlaylists = [...playlists].sort((a, b) => {
    if (a.isSystem && !b.isSystem) return -1
    if (!a.isSystem && b.isSystem) return 1
    return 0
  })

  // Genere le HTML des playlists avec icone coeur pour favoris
  container.innerHTML = sortedPlaylists.map((playlist, index) => {
    const isFavorites = playlist.id === 'favorites'
    const icon = isFavorites
      ? `<svg class="playlist-icon-heart" viewBox="0 0 24 24" fill="currentColor">
           <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
         </svg>`
      : `<svg viewBox="0 0 24 24" fill="currentColor">
           <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/>
         </svg>`

    return `
      <div class="playlist-item ${selectedPlaylistId === playlist.id ? 'active' : ''} ${isFavorites ? 'playlist-favorites' : ''}"
           data-playlist-id="${playlist.id}"
           data-playlist-index="${index}"
           data-is-system="${playlist.isSystem || false}">
        ${icon}
        <span class="playlist-item-name">${playlist.name}</span>
        <span class="playlist-item-count">${playlist.trackPaths.length}</span>
      </div>
    `
  }).join('')
}

// Initialise les event listeners de la sidebar des playlists (appele une seule fois)
function initPlaylistSidebarListeners() {
  const container = document.getElementById('playlists-list')
  if (!container) return

  // Clic = afficher la playlist
  container.addEventListener('click', (e) => {
    const item = e.target.closest('.playlist-item')
    if (!item) return

    const playlistId = item.dataset.playlistId
    const playlist = playlists.find(p => p.id === playlistId)
    if (!playlist) return

    selectedPlaylistId = playlistId
    ui.currentView = 'playlist'
    dom.navItems.forEach(i => i.classList.remove('active'))

    // Met a jour la classe active sans recreer les elements
    container.querySelectorAll('.playlist-item').forEach(el => {
      el.classList.toggle('active', el.dataset.playlistId === playlistId)
    })

    displayPlaylistView(playlist)
  })

  // Clic droit = menu contextuel playlist
  container.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.playlist-item')
    if (!item) return

    e.preventDefault()
    const playlistId = item.dataset.playlistId
    const playlist = playlists.find(p => p.id === playlistId)
    if (playlist) {
      showPlaylistContextMenu(e, playlist)
    }
  })

  // === DRAG CUSTOM pour reorganiser les playlists ===
  let playlistDragState = {
    isDragging: false,
    isPotentialDrag: false,
    draggedItem: null,
    draggedIndex: -1,
    startX: 0,
    startY: 0,
    currentDropTarget: null
  }

  const DRAG_THRESHOLD = 5

  // Mousedown sur toute la playlist = prepare le drag
  container.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.playlist-item')
    if (!item) return

    playlistDragState.isPotentialDrag = true
    playlistDragState.draggedItem = item
    playlistDragState.draggedIndex = parseInt(item.dataset.playlistIndex, 10)
    playlistDragState.startX = e.clientX
    playlistDragState.startY = e.clientY
  })

  // Mousemove : gere le drag
  document.addEventListener('mousemove', (e) => {
    if (!playlistDragState.isPotentialDrag) return

    // Verifie le seuil de mouvement
    if (!playlistDragState.isDragging) {
      const dx = Math.abs(e.clientX - playlistDragState.startX)
      const dy = Math.abs(e.clientY - playlistDragState.startY)

      if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
        playlistDragState.isDragging = true
        playlistDragState.draggedItem?.classList.add('dragging')
      }
    }

    if (!playlistDragState.isDragging) return

    // Trouve l'element sous le curseur
    const elementUnder = document.elementFromPoint(e.clientX, e.clientY)
    const targetItem = elementUnder?.closest('.playlist-item')

    // Retire l'indicateur de l'ancien target
    if (playlistDragState.currentDropTarget && playlistDragState.currentDropTarget !== targetItem) {
      playlistDragState.currentDropTarget.classList.remove('drag-over-top', 'drag-over-bottom')
    }

    // Ajoute l'indicateur sur le nouveau target
    if (targetItem && targetItem !== playlistDragState.draggedItem) {
      const rect = targetItem.getBoundingClientRect()
      const midY = rect.top + rect.height / 2

      if (e.clientY < midY) {
        targetItem.classList.add('drag-over-top')
        targetItem.classList.remove('drag-over-bottom')
      } else {
        targetItem.classList.add('drag-over-bottom')
        targetItem.classList.remove('drag-over-top')
      }

      playlistDragState.currentDropTarget = targetItem
    }
  })

  // Mouseup : termine le drag
  document.addEventListener('mouseup', async (e) => {
    if (!playlistDragState.isPotentialDrag) return

    const wasDragging = playlistDragState.isDragging
    const draggedIndex = playlistDragState.draggedIndex

    // Nettoie les classes
    if (playlistDragState.draggedItem) {
      playlistDragState.draggedItem.classList.remove('dragging')
    }
    if (playlistDragState.currentDropTarget) {
      playlistDragState.currentDropTarget.classList.remove('drag-over-top', 'drag-over-bottom')
    }

    // Si on a vraiment drague, effectue le rearrangement
    if (wasDragging && playlistDragState.currentDropTarget) {
      const targetIndex = parseInt(playlistDragState.currentDropTarget.dataset.playlistIndex, 10)

      if (targetIndex !== draggedIndex) {
        const rect = playlistDragState.currentDropTarget.getBoundingClientRect()
        const midY = rect.top + rect.height / 2
        let newIndex = e.clientY < midY ? targetIndex : targetIndex + 1

        // Ajuste l'index si on deplace vers le bas
        if (draggedIndex < newIndex) {
          newIndex--
        }

        // Reorganise les playlists
        const [movedPlaylist] = playlists.splice(draggedIndex, 1)
        playlists.splice(newIndex, 0, movedPlaylist)

        // Sauvegarde et met a jour l'affichage
        await savePlaylistsOrder()
        updatePlaylistsSidebar()
      }
    }

    // Reset l'etat
    playlistDragState.isPotentialDrag = false
    playlistDragState.isDragging = false
    playlistDragState.draggedItem = null
    playlistDragState.draggedIndex = -1
    playlistDragState.currentDropTarget = null
  })
}

// Sauvegarde l'ordre des playlists
async function savePlaylistsOrder() {
  try {
    const playlistIds = playlists.map(p => p.id)
    // Essaie d'abord avec Rust
    try {
      await invoke('reorder_playlists', { playlistIds })
    } catch (e) {
      // Fallback: sauvegarde dans localStorage
      localStorage.setItem('playlists_order', JSON.stringify(playlistIds))
    }
  } catch (e) {
    console.error('Erreur sauvegarde ordre playlists:', e)
  }
}

// Applique l'ordre sauvegarde des playlists
function applyPlaylistsOrder() {
  const savedOrder = localStorage.getItem('playlists_order')
  if (!savedOrder) return

  try {
    const order = JSON.parse(savedOrder)
    const orderedPlaylists = []

    // Reconstruit la liste dans l'ordre sauvegarde
    for (const id of order) {
      const playlist = playlists.find(p => p.id === id)
      if (playlist) orderedPlaylists.push(playlist)
    }

    // Ajoute les nouvelles playlists non presentes dans l'ordre
    for (const playlist of playlists) {
      if (!orderedPlaylists.find(p => p.id === playlist.id)) {
        orderedPlaylists.push(playlist)
      }
    }

    playlists = orderedPlaylists
  } catch (e) {
    console.error('Erreur application ordre playlists:', e)
  }
}

// === AFFICHAGE PLAYLIST VIEW ===

// Affiche la vue d'une playlist
export function displayPlaylistView(playlist) {
  const albumsGridDiv = dom.albumsGridDiv
  const albumsViewDiv = dom.albumsViewDiv

  // Vide le contenu
  albumsGridDiv.textContent = ''
  albumsViewDiv.classList.remove('hidden')
  // closeAlbumDetail is not yet in app.js mediator -- call it via DOM approach
  const albumDetail = document.getElementById('album-detail')
  if (albumDetail) albumDetail.classList.add('hidden')

  // Header de la playlist
  const header = document.createElement('div')
  header.className = 'playlist-view-header'

  const trackCount = playlist.trackPaths.length
  let playlistTracks = playlist.trackPaths
    .map((path, idx) => {
      const track = library.tracks.find(t => t.path === path)
      if (track) {
        return { ...track, originalIndex: idx }
      }
      return null
    })
    .filter(Boolean)

  // Applique le tri selon le mode selectionne
  if (playlistSortMode === 'az') {
    playlistTracks.sort((a, b) => {
      const titleA = a.metadata?.title || a.name || ''
      const titleB = b.metadata?.title || b.name || ''
      return titleA.localeCompare(titleB)
    })
  } else if (playlistSortMode === 'za') {
    playlistTracks.sort((a, b) => {
      const titleA = a.metadata?.title || a.name || ''
      const titleB = b.metadata?.title || b.name || ''
      return titleB.localeCompare(titleA)
    })
  } else if (playlistSortMode === 'recent') {
    // Inverse l'ordre (derniers ajoutes en premier)
    playlistTracks.reverse()
  }
  // 'manual' = ordre original, pas de tri

  const totalDuration = playlistTracks.reduce((acc, t) => acc + (t.metadata?.duration || 0), 0)

  header.innerHTML = `
    <div class="playlist-header-info">
      <h2>${playlist.name}</h2>
      <p>${trackCount} titre${trackCount > 1 ? 's' : ''} • ${formatTime(totalDuration)}</p>
    </div>
    <div class="playlist-header-buttons">
      <div class="playlist-sort-dropdown">
        <button class="btn-sort-playlist" title="Trier">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>
          </svg>
          <span class="sort-label">Tri</span>
        </button>
        <div class="sort-menu hidden">
          <button class="sort-option ${playlistSortMode === 'manual' ? 'active' : ''}" data-sort="manual">Manuel</button>
          <button class="sort-option ${playlistSortMode === 'recent' ? 'active' : ''}" data-sort="recent">Recently Added</button>
          <button class="sort-option ${playlistSortMode === 'az' ? 'active' : ''}" data-sort="az">A-Z</button>
          <button class="sort-option ${playlistSortMode === 'za' ? 'active' : ''}" data-sort="za">Z-A</button>
        </div>
      </div>
      <button class="btn-primary-small play-playlist-btn" ${trackCount === 0 ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        Play
      </button>
    </div>
  `

  albumsGridDiv.appendChild(header)

  // Liste des tracks avec drag & drop
  const tracksContainer = document.createElement('div')
  tracksContainer.className = 'playlist-tracks-list'
  tracksContainer.id = 'playlist-tracks-container'

  if (trackCount === 0) {
    tracksContainer.innerHTML = '<div class="playlist-empty-message">Cette playlist est vide.<br>Ajoutez des morceaux avec le bouton + ou le clic droit.</div>'
  } else {
    // Genere le HTML des tracks (sans event listeners individuels)
    tracksContainer.innerHTML = playlistTracks.map((track, index) => {
      if (!track) return ''
      const title = track.metadata?.title || track.name
      const artist = track.metadata?.artist || 'Unknown Artist'
      const duration = track.metadata?.duration ? formatTime(track.metadata.duration) : '-:--'
      return `
        <div class="playlist-track-item" data-index="${index}" data-track-path="${track.path}">
          <span class="playlist-track-number">${index + 1}</span>
          <div class="playlist-track-info">
            <span class="playlist-track-title">${title}</span>
            <span class="playlist-track-artist">${artist}</span>
          </div>
          <span class="playlist-track-duration">${duration}</span>
          <button class="playlist-track-remove" title="Retirer de la playlist">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6L6 18"/><path d="M6 6l12 12"/>
            </svg>
          </button>
        </div>
      `
    }).join('')

    // EVENT DELEGATION : Un seul listener pour tous les clics
    tracksContainer.addEventListener('click', (e) => {
      const trackItem = e.target.closest('.playlist-track-item')
      if (!trackItem) return

      const trackPath = trackItem.dataset.trackPath
      const track = library.tracks.find(t => t.path === trackPath)
      if (!track) return

      // Bouton supprimer
      if (e.target.closest('.playlist-track-remove')) {
        e.stopPropagation()
        removeTrackFromPlaylist(playlist.id, track.path)
        return
      }

      // Simple clic = selectionner la track
      tracksContainer.querySelectorAll('.playlist-track-item.selected').forEach(el => {
        el.classList.remove('selected')
      })
      trackItem.classList.add('selected')
    })

    // Double-clic = jouer la track
    tracksContainer.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return

      const trackItem = e.target.closest('.playlist-track-item')
      if (!trackItem) return

      const trackPath = trackItem.dataset.trackPath
      const globalIndex = library.tracks.findIndex(t => t.path === trackPath)
      if (globalIndex !== -1) app.playTrack(globalIndex)
    })

    // EVENT DELEGATION : Un seul listener pour les clics droits
    tracksContainer.addEventListener('contextmenu', (e) => {
      const trackItem = e.target.closest('.playlist-track-item')
      if (!trackItem) return

      const trackPath = trackItem.dataset.trackPath
      const track = library.tracks.find(t => t.path === trackPath)
      if (!track) return

      const globalIndex = library.tracks.findIndex(t => t.path === trackPath)
      app.showContextMenu(e, track, globalIndex)
    })

    // Drag custom pour les tracks de playlist
    tracksContainer.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return

      const trackItem = e.target.closest('.playlist-track-item')
      if (!trackItem) return

      const trackPath = trackItem.dataset.trackPath
      const track = library.tracks.find(t => t.path === trackPath)
      if (!track) return

      app.prepareCustomDrag(e, track, trackItem)
    })
  }

  albumsGridDiv.appendChild(tracksContainer)

  // Event listener pour le bouton lecture
  header.querySelector('.play-playlist-btn')?.addEventListener('click', () => {
    playPlaylist(playlist)
  })

  // Event listeners pour le tri
  const sortBtn = header.querySelector('.btn-sort-playlist')
  const sortMenu = header.querySelector('.sort-menu')

  if (sortBtn && sortMenu) {
    sortBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      sortMenu.classList.toggle('hidden')
    })

    sortMenu.querySelectorAll('.sort-option').forEach(option => {
      option.addEventListener('click', (e) => {
        e.stopPropagation()
        const newSort = option.dataset.sort
        playlistSortMode = newSort
        sortMenu.classList.add('hidden')
        displayPlaylistView(playlist)  // Rafraichit la vue avec le nouveau tri
      })
    })

    // Ferme le menu si on clique ailleurs
    document.addEventListener('click', () => {
      sortMenu.classList.add('hidden')
    }, { once: true })
  }
}

// Joue une playlist
function playPlaylist(playlist) {
  const playlistTracks = playlist.trackPaths
    .map(path => library.tracks.find(t => t.path === path))
    .filter(Boolean)

  if (playlistTracks.length > 0) {
    // Joue le premier track
    const firstTrack = playlistTracks[0]
    const globalIndex = library.tracks.findIndex(t => t.path === firstTrack.path)
    if (globalIndex !== -1) {
      app.playTrack(globalIndex)
      // Ajoute le reste a la queue
      for (let i = 1; i < playlistTracks.length; i++) {
        app.addToQueue(playlistTracks[i])
      }
    }
  }
}

// === CREATION / RENOMMAGE PLAYLIST ===

export function showPlaylistModal(mode = 'create', playlist = null) {
  playlistModalMode = mode
  playlistToRename = playlist

  const modal = document.getElementById('playlist-modal')
  const title = document.getElementById('playlist-modal-title')
  const input = document.getElementById('playlist-name-input')
  const confirmBtn = document.getElementById('playlist-modal-confirm')

  if (mode === 'create') {
    title.textContent = 'New playlist'
    input.value = ''
    input.placeholder = 'Playlist name'
    confirmBtn.textContent = 'Create'
  } else {
    title.textContent = 'Rename playlist'
    input.value = playlist?.name || ''
    input.placeholder = 'New name'
    confirmBtn.textContent = 'Rename'
  }

  modal.classList.remove('hidden')
  input.focus()
  input.select()
}

function hidePlaylistModal() {
  const modal = document.getElementById('playlist-modal')
  modal.classList.add('hidden')
  playlistModalMode = 'create'
  playlistToRename = null
  trackToAddToPlaylist = null
  tracksToAddToPlaylist = null
}

async function confirmPlaylistModal() {
  const input = document.getElementById('playlist-name-input')
  const name = input.value.trim()

  if (!name) return

  // IMPORTANT: Sauvegarder les refs IMMEDIATEMENT avant tout await
  // car hidePlaylistModal() pourrait etre appele pendant les awaits
  const pendingTrack = trackToAddToPlaylist
  const pendingTracks = tracksToAddToPlaylist
  const mode = playlistModalMode

  console.log('[PLAYLIST] confirmPlaylistModal called:', { name, mode, hasPendingTrack: !!pendingTrack, hasPendingTracks: !!pendingTracks?.length })

  if (mode === 'create') {
    try {
      const newPlaylist = await invoke('create_playlist', { name })
      console.log('[PLAYLIST] Created playlist:', JSON.stringify(newPlaylist))
      playlists.push(newPlaylist)
      updatePlaylistsSidebar()

      // Ajouter les tracks pendantes
      if (pendingTracks && pendingTracks.length > 0) {
        for (const track of pendingTracks) {
          const result = await invoke('add_track_to_playlist', {
            playlistId: newPlaylist.id,
            trackPath: track.path
          })
          console.log('[PLAYLIST] Added track to playlist:', { trackPath: track.path, result })
        }
        await loadPlaylists()
        app.showQueueNotification(`${pendingTracks.length} tracks added to "${name}"`)
      }
      else if (pendingTrack) {
        console.log('[PLAYLIST] Adding single track:', { playlistId: newPlaylist.id, trackPath: pendingTrack.path })
        const result = await invoke('add_track_to_playlist', {
          playlistId: newPlaylist.id,
          trackPath: pendingTrack.path
        })
        console.log('[PLAYLIST] add_track_to_playlist result:', result)
        await loadPlaylists()
        app.showQueueNotification(`"${pendingTrack.metadata?.title || pendingTrack.name}" added to "${name}"`)
      } else {
        app.showQueueNotification(`Playlist "${name}" created`)
      }
    } catch (e) {
      console.error('[PLAYLIST] Error creating playlist or adding tracks:', e)
      showToast('Error creating playlist')
    }
  } else if (mode === 'rename' && playlistToRename) {
    await invoke('rename_playlist', { id: playlistToRename.id, newName: name })
    await loadPlaylists()
    app.showQueueNotification(`Playlist renamed to "${name}"`)
  }

  // Cleanup des variables de pending track
  trackToAddToPlaylist = null
  tracksToAddToPlaylist = null
  hidePlaylistModal()
}

// === AJOUTER / SUPPRIMER DES TRACKS ===

export async function addTrackToPlaylist(playlistId, track) {
  let result
  try {
    result = await invoke('add_track_to_playlist', {
      playlistId,
      trackPath: track.path
    })
  } catch (e) {
    console.error('[PLAYLISTS] Error adding track to playlist:', e)
    showToast('Error adding track to playlist')
    return
  }

  if (result) {
    await loadPlaylists()
    const playlist = playlists.find(p => p.id === playlistId)
    app.showQueueNotification(`Added to "${playlist?.name}"`)
  }
}

export async function removeTrackFromPlaylist(playlistId, trackPath) {
  let result
  try {
    result = await invoke('remove_track_from_playlist', {
      playlistId,
      trackPath
    })
  } catch (e) {
    console.error('[PLAYLISTS] Error removing track from playlist:', e)
    showToast('Error removing track from playlist')
    return
  }

  if (result) {
    await loadPlaylists()
    const playlist = playlists.find(p => p.id === playlistId)

    // Rafraichit la vue
    if (selectedPlaylistId === playlistId && playlist) {
      displayPlaylistView(playlist)
    }
  }
}

// === SUPPRESSION PLAYLIST ===

export async function deletePlaylist(playlistId) {
  const playlist = playlists.find(p => p.id === playlistId)

  // Empecher la suppression des playlists systeme (favoris, etc.)
  if (playlist?.isSystem) {
    app.showQueueNotification("This playlist cannot be deleted")
    return
  }

  // Demander confirmation avant suppression
  const confirmed = await showConfirmModal(
    'Supprimer la playlist ?',
    `The playlist "${playlist?.name}" will be permanently deleted.`,
    'Supprimer'
  )

  if (!confirmed) return

  let result
  try {
    result = await invoke('delete_playlist', { id: playlistId })
  } catch (e) {
    console.error('[PLAYLISTS] Error deleting playlist:', e)
    showToast('Error deleting playlist')
    return
  }

  if (result) {
    await loadPlaylists()
    app.showQueueNotification(`Playlist deleted`)

    // Retourne a la vue albums si on etait sur cette playlist
    if (selectedPlaylistId === playlistId) {
      selectedPlaylistId = null
      ui.currentView = 'albums'
      dom.navItems.forEach(i => i.classList.remove('active'))
      document.querySelector('[data-view="albums"]')?.classList.add('active')
      app.displayCurrentView()
    }
  }
}

// === MODALE DE CONFIRMATION ===

export function showConfirmModal(title, message, confirmText = 'Supprimer') {
  return new Promise((resolve) => {
    confirmModalResolve = resolve

    const modal = document.getElementById('confirm-modal')
    const titleEl = document.getElementById('confirm-modal-title')
    const messageEl = document.getElementById('confirm-modal-message')
    const confirmBtn = document.getElementById('confirm-modal-confirm')

    titleEl.textContent = title
    messageEl.textContent = message
    confirmBtn.textContent = confirmText

    modal.classList.remove('hidden')
  })
}

export function hideConfirmModal(result = false) {
  const modal = document.getElementById('confirm-modal')
  modal.classList.add('hidden')

  if (confirmModalResolve) {
    confirmModalResolve(result)
    confirmModalResolve = null
  }
}

// === MENU CONTEXTUEL PLAYLIST (clic droit sur une playlist) ===

function showPlaylistContextMenu(e, playlist) {
  // Supprime tous les menus contextuels playlist existants (evite les doublons)
  document.querySelectorAll('.playlist-context-menu').forEach(m => m.remove())

  // Cree un menu contextuel temporaire pour la playlist
  hideContextMenuElement()

  const isSystemPlaylist = playlist.isSystem || playlist.id === 'favorites'

  const menu = document.createElement('div')
  menu.className = 'context-menu playlist-context-menu'
  menu.innerHTML = `
    <button class="context-menu-item" data-action="play-playlist">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      <span>Play</span>
    </button>
    <div class="context-menu-separator"></div>
    <button class="context-menu-item" data-action="rename-playlist">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
      </svg>
      <span>Rename</span>
    </button>
    <button class="context-menu-item" data-action="export-m3u">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      <span>Export M3U</span>
    </button>
    ${!isSystemPlaylist ? `
      <button class="context-menu-item context-menu-item-danger" data-action="delete-playlist">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
        </svg>
        <span>Delete</span>
      </button>
    ` : ''}
  `

  // Position
  menu.style.left = `${e.clientX}px`
  menu.style.top = `${e.clientY}px`
  document.body.appendChild(menu)

  // Actions
  menu.querySelector('[data-action="play-playlist"]').addEventListener('click', () => {
    playPlaylist(playlist)
    menu.remove()
  })

  menu.querySelector('[data-action="rename-playlist"]').addEventListener('click', () => {
    showPlaylistModal('rename', playlist)
    menu.remove()
  })

  menu.querySelector('[data-action="export-m3u"]').addEventListener('click', () => {
    exportPlaylistM3u(playlist.id)
    menu.remove()
  })

  // Supprimer uniquement si pas une playlist systeme
  const deleteBtn = menu.querySelector('[data-action="delete-playlist"]')
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      deletePlaylist(playlist.id)
      menu.remove()
    })
  }

  // Ferme au clic ailleurs
  const closeHandler = (ev) => {
    if (!ev.target.closest('.playlist-context-menu')) {
      menu.remove()
      document.removeEventListener('click', closeHandler)
    }
  }
  setTimeout(() => document.addEventListener('click', closeHandler), 0)
}

// Helper: hide the main context menu element directly via DOM
function hideContextMenuElement() {
  const menu = document.getElementById('context-menu')
  if (menu) menu.classList.add('hidden')
  const submenu = document.getElementById('playlist-submenu')
  if (submenu) submenu.classList.add('hidden')
}

// === MINI-MENU AJOUTER A PLAYLIST (pour le bouton + sur les tracks) ===

export function showAddToPlaylistMenu(e, track) {
  if (e) {
    e.stopPropagation()
    e.preventDefault()
  }

  // Supprime tout menu existant
  document.querySelectorAll('.add-to-playlist-menu').forEach(m => m.remove())

  const menu = document.createElement('div')
  menu.className = 'context-menu add-to-playlist-menu'

  let menuContent = ''

  if (playlists.length === 0) {
    menuContent = '<div style="padding: 10px 14px; color: #555; font-size: 12px;">Aucune playlist</div>'
  } else {
    playlists.forEach(playlist => {
      menuContent += `
        <button class="context-menu-item" data-playlist-id="${playlist.id}">
          <svg viewBox="0 0 24 24" fill="currentColor" style="width: 14px; height: 14px;">
            <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/>
          </svg>
          <span>${playlist.name}</span>
        </button>
      `
    })
  }

  menuContent += `
    <div class="context-menu-separator"></div>
    <button class="context-menu-item" data-action="new-playlist">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px;">
        <circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>
      </svg>
      <span>Nouvelle playlist...</span>
    </button>
  `

  menu.innerHTML = menuContent

  // Position
  let posX, posY
  if (e && e.target) {
    const rect = e.target.getBoundingClientRect()
    posX = rect.right + 5
    posY = rect.top

    // Ajuste si depasse l'ecran
    if (posX + 180 > window.innerWidth) {
      posX = rect.left - 185
    }
    if (posY + 200 > window.innerHeight) {
      posY = window.innerHeight - 210
    }
  } else {
    // Position au centre si pas d'evenement
    posX = (window.innerWidth - 200) / 2
    posY = (window.innerHeight - 200) / 2
  }

  menu.style.left = `${posX}px`
  menu.style.top = `${posY}px`
  document.body.appendChild(menu)

  // Events
  menu.querySelectorAll('[data-playlist-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      addTrackToPlaylist(btn.dataset.playlistId, track)
      menu.remove()
    })
  })

  menu.querySelector('[data-action="new-playlist"]').addEventListener('click', () => {
    trackToAddToPlaylist = track
    menu.remove()
    showPlaylistModal('create')
  })

  // Ferme au clic ailleurs (capture phase pour intercepter avant autres handlers)
  const closeHandler = (ev) => {
    if (!ev.target.closest('.add-to-playlist-menu') &&
        !ev.target.closest('.tracks-list-add-playlist') &&
        !ev.target.closest('.track-add-playlist')) {
      menu.remove()
      document.removeEventListener('click', closeHandler, true)
    }
  }
  // Ajout immediat avec capture
  requestAnimationFrame(() => {
    document.addEventListener('click', closeHandler, true)
  })
}

// Menu pour ajouter plusieurs tracks a une playlist
export function showAddToPlaylistMenuMulti(tracksToAdd) {
  // Supprime tout menu existant
  document.querySelectorAll('.add-to-playlist-menu').forEach(m => m.remove())

  const menu = document.createElement('div')
  menu.className = 'context-menu add-to-playlist-menu'

  let menuContent = ''

  if (playlists.length === 0) {
    menuContent = '<div style="padding: 10px 14px; color: #555; font-size: 12px;">Aucune playlist</div>'
  } else {
    playlists.forEach(playlist => {
      menuContent += `
        <button class="context-menu-item" data-playlist-id="${playlist.id}">
          <svg viewBox="0 0 24 24" fill="currentColor" style="width: 14px; height: 14px;">
            <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/>
          </svg>
          <span>${escapeHtml(playlist.name)}</span>
        </button>
      `
    })
  }

  menuContent += `
    <div class="context-menu-separator"></div>
    <button class="context-menu-item" data-action="new-playlist">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px;">
        <circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>
      </svg>
      <span>Nouvelle playlist...</span>
    </button>
  `

  menu.innerHTML = menuContent

  // Position au centre de l'ecran pour multi-selection
  const menuWidth = 200
  const menuHeight = Math.min(300, playlists.length * 40 + 80)
  menu.style.left = `${(window.innerWidth - menuWidth) / 2}px`
  menu.style.top = `${(window.innerHeight - menuHeight) / 2}px`
  document.body.appendChild(menu)

  // Events
  menu.querySelectorAll('[data-playlist-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const playlistId = btn.dataset.playlistId
      for (const track of tracksToAdd) {
        await addTrackToPlaylist(playlistId, track)
      }
      const playlist = playlists.find(p => p.id === playlistId)
      app.showQueueNotification(`${tracksToAdd.length} tracks added to "${playlist?.name}"`)
      menu.remove()
    })
  })

  const newPlaylistBtn = menu.querySelector('[data-action="new-playlist"]')
  if (newPlaylistBtn) {
    newPlaylistBtn.addEventListener('click', () => {
      // Stocke les tracks pour les ajouter apres creation
      tracksToAddToPlaylist = tracksToAdd
      menu.remove()
      showPlaylistModal('create')
    })
  }

  // Ferme au clic ailleurs
  const closeHandler = (ev) => {
    if (!ev.target.closest('.add-to-playlist-menu')) {
      menu.remove()
      document.removeEventListener('click', closeHandler, true)
    }
  }
  requestAnimationFrame(() => {
    document.addEventListener('click', closeHandler, true)
  })
}

// === SOUS-MENU PLAYLISTS (dans le menu contextuel principal) ===

export function showPlaylistSubmenu() {
  const submenu = document.getElementById('playlist-submenu')
  const list = document.getElementById('playlist-submenu-list')
  const menu = document.getElementById('context-menu')
  const parentBtn = document.querySelector('[data-action="add-to-playlist"]')

  if (!submenu || !list || !menu || !parentBtn) return

  list.innerHTML = ''

  if (playlists.length === 0) {
    list.innerHTML = '<div style="padding: 8px 14px; color: #555; font-size: 12px;">Aucune playlist</div>'
  } else {
    playlists.forEach(playlist => {
      const item = document.createElement('button')
      item.className = 'context-menu-item'
      item.innerHTML = `
        <svg viewBox="0 0 24 24" fill="currentColor" style="width: 14px; height: 14px;">
          <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/>
        </svg>
        <span>${playlist.name}</span>
      `
      item.addEventListener('click', async (e) => {
        e.stopPropagation()
        if (contextMenu.tracks.length > 0) {
          for (const track of contextMenu.tracks) {
            await addTrackToPlaylist(playlist.id, track)
          }
          if (contextMenu.tracks.length > 1) {
            app.showQueueNotification(`${contextMenu.tracks.length} tracks added to "${playlist.name}"`)
          }
        }
        hideContextMenuElement()
      })
      list.appendChild(item)
    })
  }

  // Position le sous-menu avec position fixed (coordonnees ecran)
  const btnRect = parentBtn.getBoundingClientRect()
  const menuRect = menu.getBoundingClientRect()

  // Position a droite du menu principal
  let left = menuRect.right - 4
  let top = btnRect.top

  // Verifie si le sous-menu depasse a droite de l'ecran
  if (left + 180 > window.innerWidth) {
    left = menuRect.left - 180 + 4  // Affiche a gauche du menu
  }

  // Verifie si le sous-menu depasse en bas de l'ecran
  if (top + 200 > window.innerHeight) {
    top = window.innerHeight - 210
  }

  submenu.style.left = `${left}px`
  submenu.style.top = `${top}px`
  submenu.classList.remove('hidden')
}

export function hidePlaylistSubmenu() {
  const submenu = document.getElementById('playlist-submenu')
  if (submenu) submenu.classList.add('hidden')
}

// === EXPORT / IMPORT M3U ===

export async function exportPlaylistM3u(playlistId) {
  try {
    const filePath = await invoke('export_playlist_m3u', { playlistId })
    const fileName = filePath.split('/').pop()
    showToast(`Playlist exported: ${fileName}`)
  } catch (e) {
    if (e === 'Export cancelled') return
    showToast('Export failed')
    console.error('[PLAYLIST] Export M3U error:', e)
  }
}

export async function importPlaylistM3u() {
  try {
    const playlist = await invoke('import_playlist_m3u')
    playlists.push(playlist)
    updatePlaylistsSidebar()
    showToast(`Playlist "${escapeHtml(playlist.name)}" imported (${playlist.trackPaths.length} tracks)`)
  } catch (e) {
    if (e === 'Import cancelled') return
    showToast('Import failed')
    console.error('[PLAYLIST] Import M3U error:', e)
  }
}

// === GETTER pour l'etat interne du module ===

export function getSelectedPlaylistId() {
  return selectedPlaylistId
}

export function setSelectedPlaylistId(id) {
  selectedPlaylistId = id
}

export function getPlaylists() {
  return playlists
}

// === INITIALISATION ===

export function initPlaylists() {
  initPlaylistListeners()
  initConfirmModalListeners()
}

// Initialise les listeners des playlists
function initPlaylistListeners() {
  // Bouton creer playlist dans sidebar
  const createBtn = document.getElementById('create-playlist-btn')
  if (createBtn) {
    createBtn.addEventListener('click', () => showPlaylistModal('create'))
  }

  // Bouton importer M3U dans sidebar
  const importBtn = document.getElementById('import-m3u-btn')
  if (importBtn) {
    importBtn.addEventListener('click', () => importPlaylistM3u())
  }

  // Modale playlist
  const modalCancel = document.getElementById('playlist-modal-cancel')
  const modalConfirm = document.getElementById('playlist-modal-confirm')
  const modalBackdrop = document.querySelector('#playlist-modal .modal-backdrop')
  const modalInput = document.getElementById('playlist-name-input')

  if (modalCancel) modalCancel.addEventListener('click', hidePlaylistModal)
  if (modalConfirm) modalConfirm.addEventListener('click', confirmPlaylistModal)
  if (modalBackdrop) modalBackdrop.addEventListener('click', hidePlaylistModal)
  if (modalInput) {
    modalInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmPlaylistModal()
      if (e.key === 'Escape') hidePlaylistModal()
    })
  }

  // Sous-menu playlists dans menu contextuel
  const addToPlaylistBtn = document.querySelector('[data-action="add-to-playlist"]')
  const submenu = document.getElementById('playlist-submenu')

  if (addToPlaylistBtn) {
    addToPlaylistBtn.addEventListener('mouseenter', showPlaylistSubmenu)
    addToPlaylistBtn.addEventListener('mouseleave', (e) => {
      // Ne cache pas si on va vers le sous-menu
      const relatedTarget = e.relatedTarget
      if (relatedTarget && (relatedTarget.closest('#playlist-submenu') || relatedTarget.closest('[data-action="add-to-playlist"]'))) {
        return
      }
      setTimeout(() => {
        if (!document.querySelector('#playlist-submenu:hover') && !document.querySelector('[data-action="add-to-playlist"]:hover')) {
          hidePlaylistSubmenu()
        }
      }, 100)
    })
  }

  if (submenu) {
    submenu.addEventListener('mouseleave', (e) => {
      const relatedTarget = e.relatedTarget
      if (relatedTarget && relatedTarget.closest('[data-action="add-to-playlist"]')) {
        return
      }
      hidePlaylistSubmenu()
    })
  }

  // Creer nouvelle playlist depuis sous-menu
  const createNewPlaylistBtn = document.querySelector('[data-action="create-new-playlist"]')
  if (createNewPlaylistBtn) {
    createNewPlaylistBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      // Utilise le premier track si multi-selection, sinon le track unique
      trackToAddToPlaylist = contextMenu.tracks.length > 0 ? contextMenu.tracks[0] : null
      tracksToAddToPlaylist = contextMenu.tracks.length > 1 ? [...contextMenu.tracks] : null
      hideContextMenuElement()
      showPlaylistModal('create')
    })
  }

  // Initialise les listeners de la sidebar des playlists
  initPlaylistSidebarListeners()

  // Charge les playlists
  loadPlaylists()
}

// Initialisation des listeners de la modale de confirmation
function initConfirmModalListeners() {
  const cancelBtn = document.getElementById('confirm-modal-cancel')
  const confirmBtn = document.getElementById('confirm-modal-confirm')
  const backdrop = document.querySelector('#confirm-modal .modal-backdrop')

  if (cancelBtn) cancelBtn.addEventListener('click', () => hideConfirmModal(false))
  if (confirmBtn) confirmBtn.addEventListener('click', () => hideConfirmModal(true))
  if (backdrop) backdrop.addEventListener('click', () => hideConfirmModal(false))

  // Echap pour fermer
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('confirm-modal').classList.contains('hidden')) {
      hideConfirmModal(false)
    }
  })
}

// === REGISTER WITH APP MEDIATOR ===

app.loadPlaylists = loadPlaylists
app.loadFavorites = loadFavorites
app.toggleFavorite = toggleFavorite
app.getFavoriteButtonHtml = getFavoriteButtonHtml
app.updatePlaylistsSidebar = updatePlaylistsSidebar
app.addTrackToPlaylist = addTrackToPlaylist
app.showAddToPlaylistMenu = showAddToPlaylistMenu
app.showAddToPlaylistMenuMulti = showAddToPlaylistMenuMulti
app.displayPlaylistView = displayPlaylistView
app.showPlaylistModal = showPlaylistModal
