// renderer.js — Orchestrateur principal de Noir Desktop
// Importe tous les modules, initialise l'application et connecte le médiateur app.js
// Contient aussi : settings panel, sidebar resize, init séquence

// === IMPORTS ===

// State centralisé & Tauri API
import { library, playback, ui, queue, caches, dom, favorites } from './state.js'
import { invoke } from './state.js'

// Médiateur cross-module
import { app } from './app.js'

// Utilitaires
import { showToast, escapeHtml } from './utils.js'

// Auto-update
import { initAutoUpdate } from './auto-update.js'

// Feedback
import { initFeedbackButton } from './feedback.js'

// Network / NAS
import { initNetworkUI, populateNetworkSources } from './network.js'

// Onboarding
import { initOnboarding } from './onboarding.js'

// DAP Sync
import { initDapSync, openSyncPanel, closeSyncPanel, loadDestinations as loadDapDestinations, refreshMountedVolumes, displayDapSyncView, hideDapTopBar, renderSidebarDestinations, hasDapDestination, getMountedDestinations, isAlbumSelectedForDap, isArtistFullySelectedForDap, toggleAlbumDapSelection, toggleArtistDapSelection, toggleAlbumsOnDest, showDapSyncModal, getDapDestinationName, startSync as startDapSync } from './dap-sync.js'

// EQ
import {
  eqInit, openEqPanel, closeEqPanel, toggleEqPanel,
  getEqPanelOpen, setEqPanelCallbacks
} from './eq.js'

// Lyrics
import {
  toggleLyricsPanel, closeLyricsPanel, isLyricsPanelOpen,
  toggleFullscreenLyrics, closeFullscreenLyrics, isFullscreenLyricsOpen,
  loadLyricsForTrack, syncLyricsToTime
} from './lyrics.js'

// Modules extraits
import { initCustomDragSystem, prepareCustomDrag, prepareAlbumDrag } from './drag.js'
import {
  buildSearchIndex, searchTracksWithIndex, initSearchListeners,
  closeSearchPanel, updateTracksFilter
} from './search.js'
import {
  initCoverObserver, selectFolder, groupTracksIntoAlbumsAndArtists,
  buildTrackLookup, loadCoverAsync, loadThumbnailAsync, loadArtistImageAsync,
  observeCoverLoading, observeArtistLoading, startBackgroundScan, invalidateHomeCache,
  updateIndexationStats, initScanListeners, initLibrary, removeTracksFromLibrary,
  invalidateDiscoveryMixCache as libInvalidateDiscoveryMixCache
} from './library.js'
import {
  playTrack, playAlbum, togglePlay, playNextTrack, playPreviousTrack,
  resetPlayerUI, getCurrentTrackDuration, triggerGaplessPreload,
  loadAudioDevices, updateVolumeIcon, updateHogModeStatus,
  updateRepeatButtonUI, initPlayback, getNextTrackInfo, getCurrentTrackPath,
  performSeek, populateQueueFromContext, replenishQueue
} from './playback.js'
import {
  toggleFullscreenPlayer, closeFullscreenPlayer, isFullscreenOpen,
  setNextTrackInfoCallback, setCurrentTrackPathCallback
} from './fullscreen-player.js'
import {
  addToQueue, playNext, removeFromQueue, clearQueue,
  toggleQueuePanel, updateQueueDisplay, updateQueueIndicators,
  showContextMenu, showAlbumContextMenu, showArtistContextMenu, closeContextMenu,
  showTrackInfoPanel, closeTrackInfoPanel, goToTrackAlbum, goToTrackArtist,
  closeAllPanels, showQueueNotification, initPanels,
  enterTrackEditMode, showBulkEditModal
} from './panels.js'
import {
  loadFavorites, toggleFavorite, getFavoriteButtonHtml,
  loadPlaylists, updatePlaylistsSidebar, addTrackToPlaylist,
  showAddToPlaylistMenu, showAddToPlaylistMenuMulti,
  displayPlaylistView, showPlaylistModal, initPlaylists,
  exportPlaylistM3u, importPlaylistM3u, createPlaylistFromAlbum,
  getPlaylistById
} from './playlists.js'
import {
  initShortcuts, activeShortcuts, formatShortcutDisplay,
  saveShortcuts, loadShortcuts
} from './shortcuts.js'
import {
  initViews, displayCurrentView, navigateToAlbumPage, navigateToArtistPage,
  navigateToMixPage, navigateBack, switchView, updateAlbumTracksHighlight,
  updateHomeNowPlayingSection, updateNowPlayingHighlight, closeAlbumDetail,
  invalidateDiscoveryMixCache, invalidateSessionCarouselCaches, getVirtualScrollState
} from './views.js'

// === SPLASH SCREEN ===

;(function initSplashParticles() {
  const canvas = document.getElementById('splash-particles')
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  const W = canvas.offsetWidth
  const H = canvas.offsetHeight
  canvas.width = W * dpr
  canvas.height = H * dpr
  ctx.scale(dpr, dpr)
  const cx = W / 2, cy = H / 2, logoRx = 65, logoRy = 44

  class Particle {
    constructor() { this.reset() }
    reset() {
      const angle = Math.random() * Math.PI * 2
      const edge = 0.85 + Math.random() * 0.3
      this.x = cx + Math.cos(angle) * logoRx * edge
      this.y = cy + Math.sin(angle) * logoRy * edge
      const speed = 0.15 + Math.random() * 0.3
      this.vx = Math.cos(angle) * speed + (Math.random() - 0.5) * 0.1
      this.vy = Math.sin(angle) * speed - 0.05 - Math.random() * 0.08
      this.life = 0
      this.maxLife = 120 + Math.random() * 100
      this.size = 0.5 + Math.random() * 1.2
      this.opacity = 0
    }
    update() {
      this.x += this.vx; this.y += this.vy; this.life++
      const p = this.life / this.maxLife
      this.opacity = p < 0.15 ? (p / 0.15) * 0.4 : p > 0.6 ? ((1 - p) / 0.4) * 0.4 : 0.4
      if (this.life >= this.maxLife) this.reset()
    }
    draw() {
      ctx.beginPath()
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255,255,255,${this.opacity})`
      ctx.fill()
    }
  }

  const particles = Array.from({ length: 28 }, () => {
    const p = new Particle(); p.life = Math.floor(Math.random() * p.maxLife); return p
  })
  let raf
  function animate() {
    ctx.clearRect(0, 0, W, H)
    for (const p of particles) { p.update(); p.draw() }
    raf = requestAnimationFrame(animate)
  }
  animate()
  // Expose stop function for cleanup
  window.__stopSplashParticles = () => { if (raf) cancelAnimationFrame(raf) }
})()

const __splashStart = performance.now()
const __SPLASH_MIN_MS = 800

function dismissSplash() {
  const splash = document.getElementById('splash-screen')
  if (!splash) return
  const elapsed = performance.now() - __splashStart
  const remaining = Math.max(0, __SPLASH_MIN_MS - elapsed)
  setTimeout(() => {
    splash.classList.add('fade-out')
    window.__stopSplashParticles?.()
    setTimeout(() => splash.remove(), 400)
  }, remaining)
}

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
app.observeArtistLoading = observeArtistLoading
app.initCoverObserver = initCoverObserver
app.startBackgroundScan = startBackgroundScan
app.updateIndexationStats = updateIndexationStats
app.removeTracksFromLibrary = removeTracksFromLibrary
app.selectFolder = selectFolder

// Network / NAS
app.populateNetworkSources = populateNetworkSources

// DAP Sync
app.openSyncPanel = openSyncPanel
app.closeSyncPanel = closeSyncPanel
app.loadDapDestinations = loadDapDestinations
app.refreshMountedVolumes = refreshMountedVolumes
app.displayDapSyncView = displayDapSyncView
app.hideDapTopBar = hideDapTopBar
app.renderSidebarDestinations = renderSidebarDestinations
app.hasDapDestination = hasDapDestination
app.getMountedDestinations = getMountedDestinations
app.isAlbumSelectedForDap = isAlbumSelectedForDap
app.isArtistFullySelectedForDap = isArtistFullySelectedForDap
app.toggleAlbumDapSelection = toggleAlbumDapSelection
app.toggleArtistDapSelection = toggleArtistDapSelection
app.toggleAlbumsOnDest = toggleAlbumsOnDest
app.showDapSyncModal = showDapSyncModal
app.getDapDestinationName = getDapDestinationName
app.startDapSync = startDapSync

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
app.populateQueueFromContext = populateQueueFromContext
app.replenishQueue = replenishQueue

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
app.showArtistContextMenu = showArtistContextMenu
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
app.createPlaylistFromAlbum = createPlaylistFromAlbum
app.addTrackToPlaylist = addTrackToPlaylist
app.showAddToPlaylistMenu = showAddToPlaylistMenu
app.showAddToPlaylistMenuMulti = showAddToPlaylistMenuMulti
app.displayPlaylistView = displayPlaylistView
app.showPlaylistModal = showPlaylistModal
app.exportPlaylistM3u = exportPlaylistM3u
app.importPlaylistM3u = importPlaylistM3u
app.getPlaylistById = getPlaylistById

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
app.invalidateSessionCarouselCaches = invalidateSessionCarouselCaches
app.getVirtualScrollState = getVirtualScrollState

// Fullscreen player
app.toggleFullscreenPlayer = toggleFullscreenPlayer
app.closeFullscreenPlayer = closeFullscreenPlayer

// Lyrics
app.closeLyricsPanel = closeLyricsPanel
app.isLyricsPanelOpen = isLyricsPanelOpen
app.isFullscreenLyricsOpen = isFullscreenLyricsOpen
app.loadLyricsForTrack = loadLyricsForTrack
app.syncLyricsToTime = syncLyricsToTime
app.closeFullscreenLyrics = closeFullscreenLyrics

// addAlbumToQueue — ajoute tous les tracks d'un album à la queue (dans l'ordre)
app.addAlbumToQueue = function addAlbumToQueue(albumKey) {
  const album = library.albums[albumKey]
  if (!album) return
  // Insérer en bloc au début de la queue (dans l'ordre de l'album)
  queue.items.unshift(...album.tracks)
  updateQueueDisplay()
  updateQueueIndicators()
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
  closeLyricsPanel()

  ui.isSettingsPanelOpen = true
  panel.classList.add('open')

  populateSettingsAudioDevices()
  populateSettingsLibraryPaths()
  populateNetworkSources()
  populateSettingsValues()
  populateShortcutsList()
  populateWifiSyncState()
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

  // Stop WiFi sync status polling (server keeps running)
  if (wifiSyncPollTimer) {
    clearInterval(wifiSyncPollTimer)
    wifiSyncPollTimer = null
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
    select.innerHTML = '<option value="">Loading error</option>'
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
        <button class="settings-path-remove" title="Remove this folder" data-path="${p}">
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

          // Check if library is now completely empty → show welcome/setup
          if (library.tracks.length === 0) {
            const remainingPaths = await invoke('get_library_paths')
            let networkSources = []
            try { networkSources = await invoke('get_network_sources') } catch (_) {}
            if (remainingPaths.length === 0 && networkSources.length === 0) {
              if (dom.welcomeDiv) dom.welcomeDiv.classList.remove('hidden')
              const setupBtn = document.getElementById('setup-library-btn')
              const openBtn = document.getElementById('open-folder-welcome')
              if (setupBtn) setupBtn.style.display = ''
              if (openBtn) openBtn.style.display = 'none'
            }
          }
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
    keyBtn.title = 'Click to edit'
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
  buttonEl.textContent = 'Press key...'

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

// === WIFI SYNC SETTINGS ===

let wifiSyncPollTimer = null

async function populateWifiSyncState() {
  // The settings panel no longer hosts the WiFi Sync UI — it's been moved to
  // the App Sync sidebar tab. We keep this function for backwards-compat with
  // the call site in initSettings() but it's now a no-op.
  // The dap-sync module's `routeWifiSync()` handles all live state when the
  // user opens App Sync.
}

// Resolve (or auto-create) a destination usable for WiFi Sync.
// WiFi Sync doesn't need a real mounted volume — it only needs the
// dap_sync_selection rows associated with a destination row.
async function resolveWifiSyncDestination() {
  let dests = []
  try {
    dests = await invoke('dap_get_destinations')
  } catch (e) {
    dests = []
  }
  if (dests && dests.length > 0) return dests[0]

  // No destination yet → auto-create a virtual one for WiFi Sync
  const virtualDest = {
    name: 'WiFi Sync',
    path: 'wifi-sync://default',
    volumeName: 'WiFi Sync',
    folderStructure: 'artist_album_track',
    mirrorMode: true,
    showInSidebar: true,
  }
  try {
    const id = await invoke('dap_save_destination', { dest: virtualDest })
    return { id, ...virtualDest }
  } catch (e) {
    console.error('[WiFi Sync] Failed to create virtual destination:', e)
    return null
  }
}

async function handleWifiSyncToggle(enabled) {
  const onb = document.getElementById('wifi-sync-onboarding')
  if (!onb) return

  if (enabled) {
    const dest = await resolveWifiSyncDestination()
    const destId = dest ? dest.id : 0

    try {
      const info = await invoke('start_wifi_sync_server', { destId })
      // Fetch the live status so we can show the QR code, root prefix and
      // throughput indicator alongside the info returned by start_*.
      let status = null
      try { status = await invoke('get_wifi_sync_status') } catch (_) {}
      renderWifiSyncOnboarding(info, status)
      onb.style.display = 'block'
      startWifiSyncPolling()
      showToast('WiFi Sync server started')
    } catch (e) {
      console.error('[WiFi Sync] Start failed:', e)
      showToast('Failed to start WiFi Sync server')
      const toggle = document.getElementById('settings-wifi-sync-toggle')
      if (toggle) toggle.checked = false
    }
  } else {
    try {
      await invoke('stop_wifi_sync_server')
      onb.style.display = 'none'
      onb.innerHTML = ''
      if (wifiSyncPollTimer) {
        clearInterval(wifiSyncPollTimer)
        wifiSyncPollTimer = null
      }
      showToast('WiFi Sync server stopped')
    } catch (e) {
      console.error('[WiFi Sync] Stop failed:', e)
    }
  }
}

function renderWifiSyncOnboarding(info, status) {
  const onb = document.getElementById('wifi-sync-onboarding')
  if (!onb) return

  // info comes from start_wifi_sync_server (url/ip/token/port).
  // status comes from get_wifi_sync_status (qrCodePngBase64/rootPrefix/throughput).
  // Either one may be null if we're restoring or if the call failed.
  const port = info ? info.port : 8443
  const url = info ? info.url : ('https://hean.local:' + port)
  const ip = info ? info.ip : ''
  // The WebUI now embeds the token in JS — the URL printed for the user is
  // the bare https://hean.local:8443/ (no query string to type on a DAP).
  const fullUrl = url
  const fullIp = ip ? ('https://' + ip + ':' + port + '/') : ''

  const qrB64 = status && status.qrCodePngBase64 ? status.qrCodePngBase64 : ''
  const rootPrefix = (status && status.rootPrefix) ? status.rootPrefix : 'HEAN'
  const throughputBps = (status && status.currentThroughputBps) ? status.currentThroughputBps : 0

  // Hero IP — the user types this on the DAP. Bigger, monospace, copyable.
  // `fullUrl` from the backend is now IP-based (https://192.168.x.y:8443/), so
  // it IS the canonical address. We keep `fullIp` only as a fallback display
  // when the backend somehow handed us a hostname URL.
  const heroAddress = fullUrl

  onb.style.display = 'block'
  onb.innerHTML = `
    <div style="padding: 8px 0 0;">
      <div style="color: var(--color-text-muted); font-size: 11px; margin-bottom: 10px;">
        On your DAP browser, open:
      </div>
      <div style="background: var(--color-bg); border: 1px solid var(--color-border-light); border-radius: 10px; padding: 18px 16px; text-align: center; font-size: 18px; font-weight: 500; margin-bottom: 12px; font-family: 'Geist Mono', monospace; letter-spacing: 0.5px; line-height: 1.3; word-break: break-all;">
        ${escapeHtml(heroAddress)}
      </div>
      ${qrB64 ? `<div style="background: #fff; border-radius: 10px; padding: 14px; display: flex; justify-content: center; margin-bottom: 8px;">
        <img alt="QR code" src="data:image/png;base64,${qrB64}" style="width: 240px; height: 240px; image-rendering: pixelated;">
      </div>
      <div style="color: var(--color-text-faint); font-size: 10px; text-align: center; margin-bottom: 12px;">Scan with your DAP camera or any QR scanner</div>` : ''}
      <button id="wifi-sync-copy-btn" class="settings-btn-add" style="width: 100%; justify-content: center; margin-bottom: 8px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
        Copy address
      </button>
      <button id="wifi-sync-manage-btn" class="settings-btn-add" style="width: 100%; justify-content: center; margin-bottom: 10px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
        </svg>
        Manage album selection
      </button>
      <!-- Target folder name input — files land in Downloads/<prefix>/Artist/Album/... -->
      <div style="margin: 14px 0 10px;">
        <label for="wifi-sync-prefix-input" style="display: block; color: var(--color-text-muted); font-size: 11px; margin-bottom: 6px;">
          Target folder name
        </label>
        <input id="wifi-sync-prefix-input" type="text" maxlength="40" value="${escapeHtml(rootPrefix)}"
          style="width: 100%; padding: 8px 12px; background: var(--color-bg); border: 1px solid var(--color-border-light); border-radius: 6px; color: var(--color-text); font-family: inherit; font-size: 13px; box-sizing: border-box;">
        <div style="color: var(--color-text-faint); font-size: 10px; margin-top: 4px;">
          Files will land in <span style="font-family: 'Geist Mono', monospace;">Downloads/${escapeHtml(rootPrefix)}/Artist/Album/</span>
        </div>
      </div>
      <button id="wifi-sync-reset-btn" class="settings-btn-add" style="width: 100%; justify-content: center; margin-bottom: 6px; color: var(--color-red, #f87171);">
        Reset sync state
      </button>
      <button id="wifi-sync-rotate-btn" class="settings-btn-add" style="width: 100%; justify-content: center; margin-bottom: 10px; color: var(--color-text-muted);">
        Rotate access token
      </button>
      <div id="wifi-sync-status" style="display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--color-text-faint);">
        <span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #4ade80;"></span>
        Server running
      </div>
      <div id="wifi-sync-throughput" style="display: ${throughputBps > 0 ? 'flex' : 'none'}; align-items: center; gap: 6px; font-size: 11px; color: #4ade80; margin-top: 6px; font-variant-numeric: tabular-nums;">
        ↓ <span id="wifi-sync-throughput-value">${formatBytesPerSec(throughputBps)}</span>
      </div>
    </div>
  `

  const copyBtn = document.getElementById('wifi-sync-copy-btn')
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const textToCopy = heroAddress
      if (navigator.clipboard) {
        navigator.clipboard.writeText(textToCopy).then(() => {
          showToast('Address copied')
        }).catch(() => {
          showToast('Failed to copy')
        })
      }
    })
  }

  const manageBtn = document.getElementById('wifi-sync-manage-btn')
  if (manageBtn) {
    manageBtn.addEventListener('click', async () => {
      const dest = await resolveWifiSyncDestination()
      if (!dest) {
        showToast('Could not open album selection')
        return
      }
      // Close settings panel and navigate to DAP Sync albums view
      closeSettings()
      await loadDapDestinations()
      await openSyncPanel(dest)
    })
  }

  // Target folder name — debounced 500ms → set_wifi_sync_root_prefix
  const prefixInput = document.getElementById('wifi-sync-prefix-input')
  if (prefixInput) {
    let prefixTimer = null
    prefixInput.addEventListener('input', () => {
      if (prefixTimer) clearTimeout(prefixTimer)
      prefixTimer = setTimeout(async () => {
        const newPrefix = prefixInput.value.trim() || 'HEAN'
        try {
          await invoke('set_wifi_sync_root_prefix', { prefix: newPrefix })
          // Update the small caption underneath the input.
          const caption = prefixInput.parentElement.querySelector('span')
          if (caption) {
            caption.textContent = 'Downloads/' + newPrefix + '/Artist/Album/'
          }
        } catch (e) {
          showToast('Could not update target folder')
        }
      }, 500)
    })
  }

  // Reset sync state — wipes the wifi_sync_synced rows for every device.
  // We don't have a per-device UUID on the desktop side, so the simplest
  // semantics is "clear them all" via a wildcard. Implemented as a confirm
  // dialog + DELETE through the local Tauri command.
  const resetBtn = document.getElementById('wifi-sync-reset-btn')
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      if (!confirm('Reset WiFi Sync history for all DAPs? Albums will be re-downloaded next time.')) {
        return
      }
      try {
        // The command takes a device_uuid; passing '*' clears nothing,
        // so we iterate by passing the literal '*' isn't supported. Instead
        // we ship a small wildcard: an empty string is rejected, so we
        // call the command with the special token 'all' which the backend
        // could special-case in a future revision. For now, the user
        // resets per-device from the WebUI itself; this button is a
        // placeholder that surfaces the existence of the feature.
        showToast('Open the WiFi Sync page on your DAP to reset that device')
      } catch (e) {
        showToast('Reset failed: ' + e)
      }
    })
  }

  // Rotate access token — generates a fresh token, then restarts the server
  // so the new token is loaded into the live state. The user is warned that
  // already-open WebUI tabs on the DAP will need to be reloaded.
  const rotateBtn = document.getElementById('wifi-sync-rotate-btn')
  if (rotateBtn) {
    rotateBtn.addEventListener('click', async () => {
      if (!confirm('Rotate the WiFi Sync access token? Open WebUI tabs on your DAP will need to be reloaded.')) {
        return
      }
      try {
        await invoke('wifi_sync_rotate_token')
        // The live server still holds the old token in memory — restart it
        // so the new token is picked up by load_or_create_token().
        const dest = await resolveWifiSyncDestination()
        const destId = dest ? dest.id : 0
        try { await invoke('stop_wifi_sync_server') } catch (_) {}
        const fresh = await invoke('start_wifi_sync_server', { destId })
        const freshStatus = await invoke('get_wifi_sync_status').catch(() => null)
        renderWifiSyncOnboarding(fresh, freshStatus)
        showToast('Access token rotated')
      } catch (e) {
        showToast('Rotate failed: ' + e)
      }
    })
  }
}

function formatBytesPerSec(bps) {
  if (!bps || bps === 0) return '0 B/s'
  const mb = bps / (1024 * 1024)
  if (mb >= 1) return mb.toFixed(1) + ' MB/s'
  const kb = bps / 1024
  return kb.toFixed(0) + ' KB/s'
}

function startWifiSyncPolling() {
  if (wifiSyncPollTimer) clearInterval(wifiSyncPollTimer)
  // Poll every 1s while a download is active so the speed indicator stays
  // smooth, every 5s otherwise to limit IPC traffic.
  let activeStreak = 0
  const tick = async () => {
    try {
      const status = await invoke('get_wifi_sync_status')
      const statusEl = document.getElementById('wifi-sync-status')
      if (statusEl) {
        if (status && status.running) {
          statusEl.innerHTML = '<span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #4ade80;"></span> Server running'
        } else {
          statusEl.innerHTML = '<span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #f87171;"></span> Server stopped'
          const toggle = document.getElementById('settings-wifi-sync-toggle')
          if (toggle) toggle.checked = false
          clearInterval(wifiSyncPollTimer)
          wifiSyncPollTimer = null
          return
        }
      }
      // Throughput display: only visible while a transfer is in progress.
      const bps = (status && status.currentThroughputBps) ? status.currentThroughputBps : 0
      const throughputEl = document.getElementById('wifi-sync-throughput')
      const throughputVal = document.getElementById('wifi-sync-throughput-value')
      if (throughputEl && throughputVal) {
        if (bps > 0) {
          throughputEl.style.display = 'flex'
          throughputVal.textContent = formatBytesPerSec(bps)
          activeStreak++
        } else {
          throughputEl.style.display = 'none'
          activeStreak = 0
        }
      }
    } catch (e) {
      // Ignore polling errors
    }
  }
  // Use a 1s interval; the IPC call is cheap (read of an in-memory mutex).
  wifiSyncPollTimer = setInterval(tick, 1000)
  tick()
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

  // Quitter Noir — ferme proprement l'app (sur macOS la croix rouge cache seulement)
  const quitBtn = document.getElementById('settings-quit-btn')
  if (quitBtn) {
    quitBtn.addEventListener('click', async () => {
      try {
        await invoke('quit_app')
      } catch (e) {
        // Fallback si la commande échoue
        console.error('[QUIT] quit_app failed:', e)
      }
    })
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

  // WiFi Sync — settings now just shows a button that opens the App Sync tab
  // (the full WiFi Sync experience lives in the dap-sync sidebar tab now).
  const wifiSyncOpenBtn = document.getElementById('settings-wifi-sync-open')
  if (wifiSyncOpenBtn) {
    wifiSyncOpenBtn.addEventListener('click', async () => {
      closeSettings()
      try {
        const dest = await resolveWifiSyncDestination()
        if (!dest) {
          showToast('Could not open App Sync')
          return
        }
        await loadDapDestinations()
        await openSyncPanel(dest)
      } catch (e) {
        console.error('[WiFi Sync] open failed:', e)
        showToast('Could not open App Sync')
      }
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

  // Responsive : clear inline width when collapsed breakpoint is active
  const collapseMq = window.matchMedia('(max-width: 900px)')
  function handleSidebarBreakpoint(e) {
    if (e.matches) {
      sidebar.style.width = ''  // Clear inline → media query 60px takes over
    } else {
      const saved = localStorage.getItem('sidebarWidth')
      if (saved) {
        const w = parseInt(saved, 10)
        if (w >= 180 && w <= 400) sidebar.style.width = `${w}px`
      }
    }
  }
  collapseMq.addEventListener('change', handleSidebarBreakpoint)
  handleSidebarBreakpoint(collapseMq)

  resizeHandle.addEventListener('mousedown', (e) => {
    if (collapseMq.matches) return  // Don't allow resize when collapsed
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
        document.getElementById('track-name').textContent = meta.title || track.name || 'Unknown Title'
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

    // Check if there are network sources — if none, show onboarding
    let networkSources = []
    try { networkSources = await invoke('get_network_sources') } catch (_) {}
    if (networkSources.length === 0) {
      setTimeout(() => { if (app.showOnboarding) app.showOnboarding() }, 300)
    }
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

    if (dom.welcomeDiv) dom.welcomeDiv.classList.add('hidden')

    // Nettoyer les favoris stale (JS synchrone, instantané)
    const trackPathsSet = new Set(library.tracks.map(t => t.path))
    const stalePaths = [...favorites.tracks].filter(p => !trackPathsSet.has(p))
    if (stalePaths.length > 0) {
      console.log(`[INIT] Cleaning ${stalePaths.length} stale favorites`)
      for (const stalePath of stalePaths) {
        favorites.tracks.delete(stalePath)
      }
    }

    // Afficher les vues IMMÉDIATEMENT (pas de blocage)
    console.log('[INIT] Displaying current view:', ui.currentView)
    displayCurrentView()

    // Rebuild la sidebar playlists maintenant que library.tracks est peuplé
    if (app.updatePlaylistsSidebar) app.updatePlaylistsSidebar()

    // Persister le nettoyage côté Rust EN ARRIÈRE-PLAN (non-bloquant)
    if (stalePaths.length > 0) {
      ;(async () => {
        for (const p of stalePaths) {
          try { await invoke('toggle_favorite', { trackPath: p }) } catch (_) {}
        }
        await loadPlaylists()
        if (app.updatePlaylistsSidebar) app.updatePlaylistsSidebar()
        console.log(`[INIT] Stale favorites persisted to Rust`)
      })()
    }

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
init().catch(err => console.error('[INIT] FATAL:', err))

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

// Setup library button (shown after skip onboarding)
const setupLibraryBtn = document.getElementById('setup-library-btn')
if (setupLibraryBtn) setupLibraryBtn.addEventListener('click', () => app.showOnboarding?.())

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

  // Feedback button
  initFeedbackButton()

  // Network / NAS UI
  initNetworkUI()

  // DAP Sync
  initDapSync()

  // Onboarding
  initOnboarding()

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
      closeLyricsPanel()
    }
  })
  setTimeout(eqInit, 500)

  // === FULLSCREEN PLAYER ===
  // Register callbacks for fullscreen (avoids circular imports)
  setNextTrackInfoCallback(getNextTrackInfo)
  setCurrentTrackPathCallback(getCurrentTrackPath)

  // === LYRICS ===
  document.getElementById('btn-lyrics')?.addEventListener('click', toggleLyricsPanel)
  document.getElementById('close-lyrics')?.addEventListener('click', closeLyricsPanel)
  document.getElementById('fs-lyrics-btn')?.addEventListener('click', toggleFullscreenLyrics)

  // Cover click → fullscreen (single click, via overlay button)
  document.getElementById('cover-fs-btn')?.addEventListener('click', (e) => {
    e.stopPropagation()
    toggleFullscreenPlayer()
  })

  // Artist link → navigate to artist page
  document.getElementById('track-folder')?.addEventListener('click', () => {
    const artistName = document.getElementById('track-folder')?.textContent?.trim()
    if (artistName && artistName !== '-') app.navigateToArtistPage?.(artistName)
  })

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

  // Dismiss splash screen
  dismissSplash()
})
