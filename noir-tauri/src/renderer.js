// renderer.js — Orchestrateur principal de Noir Desktop
// Importe tous les modules, initialise l'application et connecte le médiateur app.js
// Contient aussi : settings panel, sidebar resize, init séquence

// === IMPORTS ===

// State centralisé & Tauri API
import { library, playback, ui, queue, caches, dom } from './state.js'
import { invoke } from './state.js'

// Médiateur cross-module
import { app } from './app.js'

// Utilitaires
import { showToast } from './utils.js'

// Auto-update
import { initAutoUpdate } from './auto-update.js'

// EQ
import {
  eqInit, openEqPanel, closeEqPanel, toggleEqPanel,
  getEqPanelOpen, setEqPanelCallbacks
} from './eq.js'

// Modules extraits
import { initCustomDragSystem, prepareCustomDrag, prepareAlbumDrag } from './drag.js'
import {
  buildSearchIndex, searchTracksWithIndex, initSearchListeners,
  closeSearchPanel, updateTracksFilter
} from './search.js'
import {
  initCoverObserver, selectFolder, groupTracksIntoAlbumsAndArtists,
  buildTrackLookup, loadCoverAsync, loadThumbnailAsync, loadArtistImageAsync,
  observeCoverLoading, startBackgroundScan, invalidateHomeCache,
  updateIndexationStats, initScanListeners, initLibrary, removeTracksFromLibrary,
  invalidateDiscoveryMixCache as libInvalidateDiscoveryMixCache
} from './library.js'
import {
  playTrack, playAlbum, togglePlay, playNextTrack, playPreviousTrack,
  resetPlayerUI, getCurrentTrackDuration, triggerGaplessPreload,
  loadAudioDevices, updateVolumeIcon, updateHogModeStatus,
  updateRepeatButtonUI, initPlayback, getNextTrackInfo, getCurrentTrackPath,
  performSeek
} from './playback.js'
import {
  toggleFullscreenPlayer, closeFullscreenPlayer, isFullscreenOpen,
  setNextTrackInfoCallback, setCurrentTrackPathCallback
} from './fullscreen-player.js'
import {
  addToQueue, playNext, removeFromQueue, clearQueue,
  toggleQueuePanel, updateQueueDisplay, updateQueueIndicators,
  showContextMenu, showAlbumContextMenu, closeContextMenu,
  showTrackInfoPanel, closeTrackInfoPanel, goToTrackAlbum, goToTrackArtist,
  closeAllPanels, showQueueNotification, initPanels,
  enterTrackEditMode, showBulkEditModal
} from './panels.js'
import {
  loadFavorites, toggleFavorite, getFavoriteButtonHtml,
  loadPlaylists, updatePlaylistsSidebar, addTrackToPlaylist,
  showAddToPlaylistMenu, showAddToPlaylistMenuMulti,
  displayPlaylistView, showPlaylistModal, initPlaylists,
  exportPlaylistM3u, importPlaylistM3u
} from './playlists.js'
import {
  initShortcuts, activeShortcuts, formatShortcutDisplay,
  saveShortcuts, loadShortcuts
} from './shortcuts.js'
import {
  initViews, displayCurrentView, navigateToAlbumPage, navigateToArtistPage,
  navigateToMixPage, navigateBack, switchView, updateAlbumTracksHighlight,
  updateHomeNowPlayingSection, updateNowPlayingHighlight, closeAlbumDetail,
  invalidateDiscoveryMixCache, getVirtualScrollState
} from './views.js'

// === WINDOW DRAG ===
// Le drag est géré nativement par Tauri 2 via data-tauri-drag-region sur le titlebar HTML

// === ENREGISTREMENT MÉDIATEUR ===
// Les modules s'auto-enregistrent dans leurs init(), mais certaines fonctions
// sont enregistrées ici pour garantir la complétude du médiateur.

// EQ (pas de module avec auto-enregistrement)
app.closeEqPanel = closeEqPanel
app.openEqPanel = openEqPanel
app.toggleEqPanel = toggleEqPanel
app.getEqPanelOpen = getEqPanelOpen

// Drag
app.prepareCustomDrag = prepareCustomDrag
app.prepareAlbumDrag = prepareAlbumDrag

// Search
app.buildSearchIndex = buildSearchIndex
app.searchTracksWithIndex = searchTracksWithIndex
app.updateTracksFilter = updateTracksFilter
app.closeSearchPanel = closeSearchPanel

// Library
app.invalidateHomeCache = invalidateHomeCache
app.groupTracksIntoAlbumsAndArtists = groupTracksIntoAlbumsAndArtists
app.buildTrackLookup = buildTrackLookup
app.loadThumbnailAsync = loadThumbnailAsync
app.loadCoverAsync = loadCoverAsync
app.loadArtistImageAsync = loadArtistImageAsync
app.observeCoverLoading = observeCoverLoading
app.initCoverObserver = initCoverObserver
app.startBackgroundScan = startBackgroundScan
app.updateIndexationStats = updateIndexationStats
app.removeTracksFromLibrary = removeTracksFromLibrary
app.selectFolder = selectFolder

// Playback
app.playTrack = playTrack
app.playAlbum = playAlbum
app.togglePlay = togglePlay
app.playNextTrack = playNextTrack
app.playPreviousTrack = playPreviousTrack
app.resetPlayerUI = resetPlayerUI
app.getCurrentTrackDuration = getCurrentTrackDuration
app.triggerGaplessPreload = triggerGaplessPreload
app.loadAudioDevices = loadAudioDevices
app.updateVolumeIcon = updateVolumeIcon
app.updateRepeatButtonUI = updateRepeatButtonUI

// Panels
app.addToQueue = addToQueue
app.playNext = playNext
app.removeFromQueue = removeFromQueue
app.clearQueue = clearQueue
app.toggleQueuePanel = toggleQueuePanel
app.updateQueueDisplay = updateQueueDisplay
app.updateQueueIndicators = updateQueueIndicators
app.showContextMenu = showContextMenu
app.showAlbumContextMenu = showAlbumContextMenu
app.closeContextMenu = closeContextMenu
app.hideContextMenu = closeContextMenu
app.showTrackInfoPanel = showTrackInfoPanel
app.closeTrackInfoPanel = closeTrackInfoPanel
app.openTrackInfoInEditMode = async (track) => {
  await showTrackInfoPanel(track)
  enterTrackEditMode(track)
}
app.showBulkEditModal = showBulkEditModal
app.goToTrackAlbum = goToTrackAlbum
app.goToTrackArtist = goToTrackArtist
app.closeAllPanels = closeAllPanels
app.showQueueNotification = showQueueNotification

// Playlists
app.loadFavorites = loadFavorites
app.toggleFavorite = toggleFavorite
app.getFavoriteButtonHtml = getFavoriteButtonHtml
app.loadPlaylists = loadPlaylists
app.updatePlaylistsSidebar = updatePlaylistsSidebar
app.addTrackToPlaylist = addTrackToPlaylist
app.showAddToPlaylistMenu = showAddToPlaylistMenu
app.showAddToPlaylistMenuMulti = showAddToPlaylistMenuMulti
app.displayPlaylistView = displayPlaylistView
app.showPlaylistModal = showPlaylistModal
app.exportPlaylistM3u = exportPlaylistM3u
app.importPlaylistM3u = importPlaylistM3u

// Views
app.displayCurrentView = displayCurrentView
app.navigateToAlbumPage = navigateToAlbumPage
app.navigateToArtistPage = navigateToArtistPage
app.navigateToMixPage = navigateToMixPage
app.navigateBack = navigateBack
app.switchView = switchView
app.updateAlbumTracksHighlight = updateAlbumTracksHighlight
app.updateHomeNowPlayingSection = updateHomeNowPlayingSection
app.updateNowPlayingHighlight = updateNowPlayingHighlight
app.closeAlbumDetail = closeAlbumDetail
app.invalidateDiscoveryMixCache = invalidateDiscoveryMixCache
app.getVirtualScrollState = getVirtualScrollState

// Fullscreen player
app.toggleFullscreenPlayer = toggleFullscreenPlayer
app.closeFullscreenPlayer = closeFullscreenPlayer

// addAlbumToQueue — ajoute tous les tracks d'un album à la queue
app.addAlbumToQueue = function addAlbumToQueue(albumKey) {
  const album = library.albums[albumKey]
  if (!album) return
  for (const track of album.tracks) {
    addToQueue(track)
  }
  showQueueNotification(`${album.tracks.length} tracks added to queue`)
}

// === SETTINGS PANEL ===

let shortcutCaptureAction = null
let activeCaptureHandler = null  // stored so closeSettings() can clean it up

function openSettings() {
  const panel = document.getElementById('settings-panel')
  if (!panel) return

  if (ui.isQueuePanelOpen) toggleQueuePanel()
  if (ui.isTrackInfoPanelOpen) closeTrackInfoPanel()
  if (getEqPanelOpen()) closeEqPanel()

  ui.isSettingsPanelOpen = true
  panel.classList.add('open')

  populateSettingsAudioDevices()
  populateSettingsLibraryPaths()
  populateSettingsValues()
  populateShortcutsList()
}

function closeSettings() {
  const panel = document.getElementById('settings-panel')
  if (!panel) return

  // Clean up any dangling shortcut capture listener if settings closed mid-capture
  if (activeCaptureHandler) {
    document.removeEventListener('keydown', activeCaptureHandler, true)
    activeCaptureHandler = null
    document.querySelector('.settings-shortcut-key.capturing')?.classList.remove('capturing')
    shortcutCaptureAction = null
  }

  ui.isSettingsPanelOpen = false
  panel.classList.remove('open')
}

function toggleSettingsPanel() {
  if (ui.isSettingsPanelOpen) {
    closeSettings()
  } else {
    openSettings()
  }
}

app.openSettings = openSettings
app.closeSettings = closeSettings
app.toggleSettings = toggleSettingsPanel

// Synchronise le Hog Mode entre player bar et settings panel
function updateHogModeUI(enabled) {
  const playerCheckbox = document.getElementById('exclusive-mode-checkbox')
  if (playerCheckbox) playerCheckbox.checked = enabled

  const settingsCheckbox = document.getElementById('settings-exclusive-mode')
  if (settingsCheckbox) settingsCheckbox.checked = enabled

  updateHogModeStatus(enabled)
}

app.updateHogModeUI = updateHogModeUI

async function populateSettingsAudioDevices() {
  const select = document.getElementById('settings-audio-device')
  if (!select) return

  try {
    const devices = await invoke('get_audio_devices')
    const currentDevice = await invoke('get_current_audio_device')
    const currentId = currentDevice?.id || null

    select.innerHTML = ''
    for (const device of devices) {
      const option = document.createElement('option')
      option.value = device.id
      option.textContent = device.name
      if (device.id === currentId) option.selected = true
      select.appendChild(option)
    }
  } catch (e) {
    console.error('[SETTINGS] Error loading audio devices:', e)
    select.innerHTML = '<option value="">Erreur de chargement</option>'
  }
}

async function populateSettingsLibraryPaths() {
  const container = document.getElementById('settings-library-paths')
  if (!container) return

  try {
    const paths = await invoke('get_library_paths')
    container.innerHTML = ''

    if (paths.length === 0) {
      container.innerHTML = '<div style="font-size: 11px; color: #555; padding: 8px 0;">No folders configured</div>'
      return
    }

    for (const p of paths) {
      const item = document.createElement('div')
      item.className = 'settings-path-item'
      item.innerHTML = `
        <span class="settings-path-text" title="${p}">${p}</span>
        <button class="settings-path-remove" title="Retirer ce dossier" data-path="${p}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6L6 18"/><path d="M6 6l12 12"/>
          </svg>
        </button>
      `
      container.appendChild(item)
    }

    container.querySelectorAll('.settings-path-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        const pathToRemove = btn.dataset.path
        try {
          await invoke('remove_library_path', { path: pathToRemove })
          btn.closest('.settings-path-item').remove()
          showToast(`Folder removed: ${pathToRemove.split('/').pop()}`)

          const [updatedTracks, stats] = await invoke('load_tracks_from_cache')
          library.tracks.length = 0
          for (const t of updatedTracks) library.tracks.push(t)
          groupTracksIntoAlbumsAndArtists()
          buildTrackLookup()
          displayCurrentView()
          updateIndexationStats(stats)
        } catch (e) {
          console.error('[SETTINGS] Error removing library path:', e)
          showToast('Error removing folder')
        }
      })
    })
  } catch (e) {
    console.error('[SETTINGS] Error loading library paths:', e)
  }
}

function populateShortcutsList() {
  const container = document.getElementById('settings-shortcuts-list')
  if (!container) return

  container.innerHTML = ''
  for (const [action, binding] of Object.entries(activeShortcuts)) {
    const row = document.createElement('div')
    row.className = 'settings-shortcut-row'

    const label = document.createElement('span')
    label.className = 'settings-shortcut-label'
    label.textContent = binding.label

    const keyBtn = document.createElement('button')
    keyBtn.className = 'settings-shortcut-key'
    keyBtn.textContent = formatShortcutDisplay(binding)
    keyBtn.title = 'Cliquer pour modifier'
    keyBtn.dataset.action = action
    keyBtn.addEventListener('click', () => startShortcutCapture(action, keyBtn))

    row.appendChild(label)
    row.appendChild(keyBtn)
    container.appendChild(row)
  }
}

function startShortcutCapture(action, buttonEl) {
  if (shortcutCaptureAction) {
    const prevBtn = document.querySelector('.settings-shortcut-key.capturing')
    if (prevBtn) {
      prevBtn.classList.remove('capturing')
      prevBtn.textContent = formatShortcutDisplay(activeShortcuts[shortcutCaptureAction])
    }
  }

  shortcutCaptureAction = action
  buttonEl.classList.add('capturing')
  buttonEl.textContent = 'Appuyez...'

  const captureHandler = (e) => {
    e.preventDefault()
    e.stopPropagation()

    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return

    const isLetter = e.key.length === 1 && /[a-z,]/i.test(e.key)
    const newBinding = {
      ...activeShortcuts[action],
      shift: e.shiftKey,
      meta: e.metaKey,
      ctrl: e.ctrlKey,
      alt: e.altKey,
    }
    if (isLetter) {
      newBinding.key = e.key.toLowerCase()
      delete newBinding.code
    } else {
      newBinding.code = e.code
      delete newBinding.key
    }

    activeShortcuts[action] = newBinding
    saveShortcuts()

    buttonEl.classList.remove('capturing')
    buttonEl.textContent = formatShortcutDisplay(newBinding)
    shortcutCaptureAction = null
    activeCaptureHandler = null

    document.removeEventListener('keydown', captureHandler, true)
  }

  activeCaptureHandler = captureHandler
  document.addEventListener('keydown', captureHandler, true)
}

function resetShortcuts() {
  localStorage.removeItem('keyboard_shortcuts')
  loadShortcuts()
  populateShortcutsList()
  showToast('Shortcuts reset')
}

async function populateSettingsValues() {
  const hogToggle = document.getElementById('settings-exclusive-mode')
  if (hogToggle) {
    try {
      const isExclusive = await invoke('is_exclusive_mode')
      hogToggle.checked = isExclusive
    } catch (e) {
      console.error('[SETTINGS] Error loading hog mode:', e)
    }
  }

  const volumeRange = document.getElementById('settings-default-volume')
  const volumeValue = document.getElementById('settings-volume-value')
  const savedVolume = localStorage.getItem('settings_default_volume')
  if (volumeRange) {
    volumeRange.value = savedVolume !== null ? savedVolume : 100
    if (volumeValue) volumeValue.textContent = `${volumeRange.value}%`
  }

  const autoResume = document.getElementById('settings-auto-resume')
  if (autoResume) {
    autoResume.checked = localStorage.getItem('settings_auto_resume') === 'true'
  }
}

function initSettingsPanel() {
  const btnSettings = document.getElementById('btn-settings')
  if (btnSettings) {
    btnSettings.addEventListener('click', toggleSettingsPanel)
  }

  const closeBtn = document.getElementById('close-settings')
  if (closeBtn) {
    closeBtn.addEventListener('click', closeSettings)
  }

  const audioSelect = document.getElementById('settings-audio-device')
  if (audioSelect) {
    audioSelect.addEventListener('change', async () => {
      const deviceId = audioSelect.value
      if (!deviceId) return
      try {
        await invoke('set_audio_device', { deviceId })
        const selectedName = audioSelect.options[audioSelect.selectedIndex].text
        showToast(`Audio output: ${selectedName}`)
        loadAudioDevices()
      } catch (e) {
        console.error('[SETTINGS] Error changing audio device:', e)
        showToast('Error changing audio output')
      }
    })
  }

  const hogToggle = document.getElementById('settings-exclusive-mode')
  if (hogToggle) {
    hogToggle.addEventListener('change', async () => {
      const enabled = hogToggle.checked
      try {
        await invoke('set_exclusive_mode', { enabled })
        updateHogModeUI(enabled)
        showToast(enabled ? 'Exclusive mode enabled (bit-perfect)' : 'Exclusive mode disabled')

        if (enabled && playback.audioIsPlaying && playback.currentTrackIndex >= 0) {
          const currentTrack = library.tracks[playback.currentTrackIndex]
          if (currentTrack) {
            await invoke('audio_play', { path: currentTrack.path })
          }
        }
      } catch (e) {
        console.error('[SETTINGS] Error toggling exclusive mode:', e)
        hogToggle.checked = !enabled
        showToast('Error changing mode')
      }
    })
  }

  const volumeRange = document.getElementById('settings-default-volume')
  const volumeValue = document.getElementById('settings-volume-value')
  if (volumeRange) {
    volumeRange.addEventListener('input', () => {
      const val = volumeRange.value
      if (volumeValue) volumeValue.textContent = `${val}%`
      localStorage.setItem('settings_default_volume', val)
    })
  }

  const addFolderBtn = document.getElementById('settings-add-folder')
  if (addFolderBtn) {
    addFolderBtn.addEventListener('click', async () => {
      try {
        const selected = await invoke('select_folder')
        if (selected) {
          await invoke('add_library_path', { path: selected })
          showToast(`Folder added: ${selected.split('/').pop()}`)
          populateSettingsLibraryPaths()
          invoke('scan_folder_with_metadata', { path: selected })
        }
      } catch (e) {
        console.error('[SETTINGS] Error adding folder:', e)
      }
    })
  }

  const autoResume = document.getElementById('settings-auto-resume')
  if (autoResume) {
    autoResume.addEventListener('change', () => {
      localStorage.setItem('settings_auto_resume', autoResume.checked)
      showToast(autoResume.checked ? 'Auto-resume enabled' : 'Auto-resume disabled')
    })
  }

  const resetShortcutsBtn = document.getElementById('settings-reset-shortcuts')
  if (resetShortcutsBtn) {
    resetShortcutsBtn.addEventListener('click', resetShortcuts)
  }

  const gaplessToggle = document.getElementById('settings-gapless')
  if (gaplessToggle) {
    const gaplessSaved = localStorage.getItem('settings_gapless')
    gaplessToggle.checked = gaplessSaved !== 'false'
    gaplessToggle.addEventListener('change', () => {
      const enabled = gaplessToggle.checked
      localStorage.setItem('settings_gapless', enabled)
      invoke('set_gapless_enabled', { enabled }).catch(console.error)
      showToast(enabled ? 'Gapless playback enabled' : 'Gapless playback disabled')
    })
  }
}

// === SIDEBAR RESIZE ===

function initSidebarResize() {
  const sidebar = document.querySelector('.sidebar')
  const resizeHandle = document.getElementById('sidebar-resize-handle')

  if (!sidebar || !resizeHandle) return

  let isResizing = false
  let startX = 0
  let startWidth = 0

  const savedWidth = localStorage.getItem('sidebarWidth')
  if (savedWidth) {
    const width = parseInt(savedWidth, 10)
    if (width >= 180 && width <= 400) {
      sidebar.style.width = `${width}px`
    }
  }

  resizeHandle.addEventListener('mousedown', (e) => {
    isResizing = true
    startX = e.clientX
    startWidth = sidebar.offsetWidth
    resizeHandle.classList.add('active')
    document.body.classList.add('sidebar-resizing')
    e.preventDefault()
  })

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return
    const delta = e.clientX - startX
    let newWidth = startWidth + delta
    newWidth = Math.max(180, Math.min(400, newWidth))
    sidebar.style.width = `${newWidth}px`
  })

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false
      resizeHandle.classList.remove('active')
      document.body.classList.remove('sidebar-resizing')
      localStorage.setItem('sidebarWidth', sidebar.offsetWidth.toString())
    }
  })
}

// === VOLUME PAR DÉFAUT ===

function applyDefaultVolume() {
  const savedVolume = localStorage.getItem('settings_default_volume')
  if (savedVolume !== null) {
    const vol = parseInt(savedVolume, 10)
    const volumeBarEl = document.getElementById('volume')
    if (volumeBarEl) {
      volumeBarEl.value = vol
      const normalizedVol = vol / 100
      playback.currentVolume = normalizedVol
      updateVolumeIcon(normalizedVol)
      invoke('audio_set_volume', { volume: normalizedVol }).catch(console.error)
    }
  }
}

// === REPRISE AUTO ===

async function handleAutoResume() {
  if (localStorage.getItem('settings_auto_resume') !== 'true') return

  try {
    const lastPlayed = await invoke('get_last_played')
    if (lastPlayed && lastPlayed.path) {
      const trackIndex = library.tracks.findIndex(t => t.path === lastPlayed.path)
      if (trackIndex >= 0) {
        playback.currentTrackIndex = trackIndex
        const track = library.tracks[trackIndex]
        const meta = track.metadata || {}
        document.getElementById('track-name').textContent = meta.title || track.name || 'Titre inconnu'
        document.getElementById('track-folder').textContent = meta.artist || 'Unknown Artist'
        const player = document.getElementById('player')
        if (player) player.classList.remove('hidden')
      }
    }
  } catch (e) {
    console.error('[SETTINGS] Error auto-resume:', e)
  }
}

// === INITIALISATION PRINCIPALE ===

async function init() {
  console.log('[INIT] Starting initialization...')

  // Init le cache Rust
  console.log('[INIT] Calling init_cache...')
  await invoke('init_cache')
  console.log('[INIT] init_cache completed')

  // Charge les favoris
  await loadFavorites()

  const savedPaths = await invoke('get_library_paths')
  console.log('[INIT] Library paths:', savedPaths)

  if (savedPaths.length === 0) {
    console.log('[INIT] No library paths configured')
    updateIndexationStats({ artists_count: 0, albums_count: 0, mp3_count: 0, flac_16bit_count: 0, flac_24bit_count: 0 })
    return
  }

  // Charge depuis le cache (démarrage instantané)
  console.log('[INIT] Loading tracks from cache...')
  const [cachedTracks, cachedStats] = await invoke('load_tracks_from_cache')
  console.log('[INIT] Received from cache:', {
    tracksCount: cachedTracks?.length || 0,
    stats: cachedStats
  })

  if (cachedTracks && cachedTracks.length > 0) {
    console.log('[INIT] Populating tracks array...')
    for (const track of cachedTracks) {
      library.tracks.push(track)
    }
    console.log('[INIT] tracks.length after population:', library.tracks.length)

    // Charge les dates d'ajout
    let addedDates = {}
    try {
      addedDates = await invoke('get_added_dates') || {}
    } catch (e) {
      console.error('[INIT] Error loading added dates:', e)
    }
    library.trackAddedDates = addedDates

    // Groupe et indexe
    console.log('[INIT] Grouping tracks into albums and artists...')
    groupTracksIntoAlbumsAndArtists()
    buildTrackLookup()
    console.log('[INIT] Albums count:', Object.keys(library.albums).length)
    console.log('[INIT] Artists count:', Object.keys(library.artists).length)

    dom.welcomeDiv.classList.add('hidden')
    console.log('[INIT] Displaying current view:', ui.currentView)
    displayCurrentView()

    updateIndexationStats(cachedStats)

    console.log(`[INIT] Instant startup complete: ${cachedTracks.length} tracks loaded from cache`)
  } else {
    console.log('[INIT] No tracks in cache, will wait for background scan')
  }

  // Lance le scan en arrière-plan
  console.log('[INIT] Starting background scan...')
  startBackgroundScan()
}

// Debug helper
window.debugLibrary = function() {
  console.log('=== LIBRARY DEBUG ===')
  console.log('tracks.length:', library.tracks.length)
  console.log('albums count:', Object.keys(library.albums).length)
  console.log('artists count:', Object.keys(library.artists).length)
  console.log('currentView:', ui.currentView)
  console.log('First 3 tracks:', library.tracks.slice(0, 3))
  console.log('First 3 album keys:', Object.keys(library.albums).slice(0, 3))
}

// === LANCEMENT ===

// Init modules qui n'ont pas besoin du DOM
initLibrary()
initScanListeners()

// Lance l'init principale
init()

// Sauvegarde du cache
window.addEventListener('beforeunload', () => {
  invoke('save_all_caches').catch(console.error)
})

setInterval(() => {
  invoke('save_all_caches').catch(console.error)
}, 30000)

// Boutons de sélection de dossier
dom.selectFolderBtn.addEventListener('click', selectFolder)
dom.openFolderWelcomeBtn.addEventListener('click', selectFolder)

// === DOM READY ===

document.addEventListener('DOMContentLoaded', () => {
  // Init des modules qui dépendent du DOM
  initViews()
  initPlayback()
  initPanels()
  initPlaylists()
  initSearchListeners()
  initCustomDragSystem()
  initShortcuts()
  initCoverObserver()

  // Settings & sidebar
  initSettingsPanel()
  initSidebarResize()

  // Volume par défaut
  applyDefaultVolume()

  // Auto-update
  initAutoUpdate()

  // EQ avec callbacks pour fermer les autres panels
  setEqPanelCallbacks({
    closeOtherPanels: () => {
      if (dom.audioOutputMenu && !dom.audioOutputMenu.classList.contains('hidden')) {
        dom.audioOutputMenu.classList.add('hidden')
        dom.audioOutputBtn.classList.remove('active')
      }
      if (ui.isQueuePanelOpen) toggleQueuePanel()
      if (ui.isTrackInfoPanelOpen) closeTrackInfoPanel()
      if (ui.isSettingsPanelOpen) closeSettings()
    }
  })
  setTimeout(eqInit, 500)

  // === FULLSCREEN PLAYER ===
  // Register callbacks for fullscreen (avoids circular imports)
  setNextTrackInfoCallback(getNextTrackInfo)
  setCurrentTrackPathCallback(getCurrentTrackPath)

  // Cover double-click opens fullscreen
  const coverArt = document.getElementById('cover-art')
  if (coverArt) {
    coverArt.addEventListener('dblclick', () => toggleFullscreenPlayer())
  }

  // Fullscreen close button
  const fsClose = document.getElementById('fs-close')
  if (fsClose) fsClose.addEventListener('click', () => closeFullscreenPlayer())

  // Fullscreen controls
  const fsPrev = document.getElementById('fs-prev')
  if (fsPrev) fsPrev.addEventListener('click', () => playPreviousTrack())

  const fsPlayPause = document.getElementById('fs-play-pause')
  if (fsPlayPause) fsPlayPause.addEventListener('click', () => togglePlay())

  const fsNextBtn = document.getElementById('fs-next-btn')
  if (fsNextBtn) fsNextBtn.addEventListener('click', () => playNextTrack())

  // Fullscreen progress bar seek
  const fsProgress = document.getElementById('fs-progress')
  if (fsProgress) {
    fsProgress.addEventListener('input', () => {
      // Mirror value to main progress bar then seek
      const mainProgress = document.getElementById('progress')
      if (mainProgress) mainProgress.value = fsProgress.value
      performSeek()
    })
  }

  // Escape closes fullscreen
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isFullscreenOpen()) {
      closeFullscreenPlayer()
    }
  })

  // Auto-resume après délai
  setTimeout(handleAutoResume, 3000)
})
