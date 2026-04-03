// dap-sync.js — DAP Sync module (SD Card / USB synchronization)
// Renders views into #albums-grid via the view system (views.js switchView).
// Manages sidebar device list, sub-views: setup, albums, syncing, complete, disconnected, settings.

import { invoke, listen } from './state.js'
import { library, ui, dom } from './state.js'
import { app } from './app.js'
import { showToast, escapeHtml } from './utils.js'
import { formatQuality } from './utils.js'

// === LOCAL STATE ===

let destinations = []
let currentDestinationId = null
let selectedAlbums = new Set()
let syncPlan = null
let isSyncing = false
let mountedVolumes = new Set()
let _externalVolumes = [] // Full ExternalVolume objects from last refresh
let dapSubView = 'setup' // setup | albums | syncing | complete | disconnected | settings | first-sync | error
let syncProgress = { phase: '', current: 0, total: 0, currentFile: '', bytesCopied: 0, totalBytes: 0 }
let syncResult = null
let albumSearchFilter = ''
let currentTab = 'albums' // albums | artists | tracks
let sidebarCollapsed = false
let detailsExpanded = false
let currentSortKey = 'alpha-asc' // alpha-asc | alpha-desc | bitrate-asc | bitrate-desc | status
let _summaryDebounceTimer = null
let _saveSelectionsTimer = null
// Pre-computed lookup sets for O(1) status badge checks (rebuilt after each sync plan)
let _copyAlbumIds = new Set()
let _onDapAlbumIds = new Set()
let _deleteSourcePaths = new Set()
// Flag: on first plan computation after page load, auto-deselect albums not on DAP
let _needsOnDapPreselection = false

// === SVG CONSTANTS ===

// DAP icon (Digital Audio Player) — white wireframe style
const DAP_ICON_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="5" y="1" width="14" height="22" rx="2.5"/>
  <rect x="7" y="3" width="10" height="8" rx="1"/>
  <path d="M10 6l3 1.5-3 1.5V6z" fill="currentColor" stroke="none"/>
  <circle cx="12" cy="17" r="3.5"/>
  <circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/>
</svg>`

// TransformerIcon animation — converted to white/monochrome for dark background
const TRANSFORMER_SVG = `<svg width="72" height="72" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" style="overflow:visible" class="dap-trf-icon">
  <style>
    @keyframes trfPulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.015); } }
    @keyframes trfFlow { 0% { stroke-dashoffset: 6; } 100% { stroke-dashoffset: 0; } }
    @keyframes trfGlow { 0%, 100% { opacity: 0.15; } 50% { opacity: 0.5; } }
    @keyframes trfS1 { 0%, 100% { opacity: 0; } 50% { opacity: 0.7; } }
    @keyframes trfS2 { 0%, 100% { opacity: 0.5; } 50% { opacity: 0; } }
    @keyframes trfS3 { 0%, 100% { opacity: 0.2; } 40% { opacity: 0.7; } 80% { opacity: 0; } }
    .trf-body { animation: trfPulse 3s ease-in-out infinite; transform-origin: 10px 10px; }
    .trf-flow { animation: trfFlow 2s linear infinite; stroke-dasharray: 2 4; }
    .trf-glow { animation: trfGlow 2.5s ease-in-out infinite; }
    .trf-s1 { animation: trfS1 3.2s ease-in-out infinite 0.3s; }
    .trf-s2 { animation: trfS2 2.8s ease-in-out infinite 1s; }
    .trf-s3 { animation: trfS3 2.2s ease-in-out infinite 1.8s; }
  </style>
  <circle class="trf-s1" cx="2" cy="3" r="0.45" fill="white" opacity="0"/>
  <circle class="trf-s2" cx="17.5" cy="4.5" r="0.4" fill="white" opacity="0"/>
  <circle class="trf-s3" cx="3" cy="17" r="0.35" fill="white" opacity="0"/>
  <g class="trf-body">
    <rect x="2" y="4" width="5.5" height="12" rx="1.2" stroke="white" stroke-width="1.2" fill="none"/>
    <rect x="2" y="4" width="5.5" height="12" rx="1.2" fill="white" opacity="0.07"/>
    <line x1="3" y1="7" x2="6.5" y2="7" stroke="white" stroke-width="0.6" stroke-linecap="round" opacity="0.35"/>
    <line x1="3" y1="10" x2="6.5" y2="10" stroke="white" stroke-width="0.6" stroke-linecap="round" opacity="0.35"/>
    <line x1="3" y1="13" x2="6.5" y2="13" stroke="white" stroke-width="0.6" stroke-linecap="round" opacity="0.35"/>
    <rect x="12.5" y="4" width="5.5" height="12" rx="1.2" stroke="white" stroke-width="1.2" fill="none"/>
    <rect x="12.5" y="4" width="5.5" height="12" rx="1.2" fill="white" opacity="0.07"/>
    <line x1="13.5" y1="7" x2="17" y2="7" stroke="white" stroke-width="0.6" stroke-linecap="round" opacity="0.35"/>
    <line x1="13.5" y1="10" x2="17" y2="10" stroke="white" stroke-width="0.6" stroke-linecap="round" opacity="0.35"/>
    <line x1="13.5" y1="13" x2="17" y2="13" stroke="white" stroke-width="0.6" stroke-linecap="round" opacity="0.35"/>
    <path class="trf-flow" d="M7.5 7C9 6 11 6 12.5 7" stroke="white" stroke-width="0.8" stroke-linecap="round" fill="none" opacity="0.65"/>
    <path class="trf-flow" d="M7.5 10C9 9 11 9 12.5 10" stroke="white" stroke-width="0.8" stroke-linecap="round" fill="none" opacity="0.65"/>
    <path class="trf-flow" d="M7.5 13C9 12 11 12 12.5 13" stroke="white" stroke-width="0.8" stroke-linecap="round" fill="none" opacity="0.65"/>
    <path class="trf-flow" d="M7.5 7C9 8 11 9 12.5 10" stroke="white" stroke-width="0.6" stroke-linecap="round" fill="none" opacity="0.2"/>
    <path class="trf-flow" d="M7.5 10C9 11 11 12 12.5 13" stroke="white" stroke-width="0.6" stroke-linecap="round" fill="none" opacity="0.2"/>
    <circle class="trf-glow" cx="4.75" cy="7" r="0.4" fill="white" opacity="0.4"/>
    <circle class="trf-glow" cx="4.75" cy="10" r="0.4" fill="white" opacity="0.4"/>
    <circle class="trf-glow" cx="15.25" cy="10" r="0.4" fill="white" opacity="0.4"/>
    <circle class="trf-glow" cx="15.25" cy="13" r="0.4" fill="white" opacity="0.3"/>
    <path d="M11.5 6.5L12.5 7L11.5 7.5" stroke="white" stroke-width="0.6" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.5"/>
    <path d="M11.5 9.5L12.5 10L11.5 10.5" stroke="white" stroke-width="0.6" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.5"/>
  </g>
</svg>`

// === HELPERS ===

function formatBytes(bytes) {
  if (bytes < 0) return '-' + formatBytes(-bytes)
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i]
}

function albumKeyToId(albumKey) {
  let hash = 0
  for (let i = 0; i < albumKey.length; i++) {
    hash = ((hash << 5) - hash + albumKey.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

// === CONTEXT MENU HELPERS (called via app mediator from panels.js) ===

function hasDapDestination() {
  // Has at least one configured destination (mounted or not)
  return destinations.length > 0
}

function getMountedDestinations() {
  return destinations.filter(d => mountedVolumes.has(d.path))
}

function isAlbumSelectedForDap(albumKey) {
  return selectedAlbums.has(albumKeyToId(albumKey))
}

function isArtistFullySelectedForDap(artistKey) {
  const artist = library.artists[artistKey]
  if (!artist || !artist.albums || artist.albums.length === 0) return false
  return artist.albums.every(ak => selectedAlbums.has(albumKeyToId(ak)))
}

function toggleAlbumDapSelection(albumKey) {
  if (!currentDestinationId) return null
  const albumId = albumKeyToId(albumKey)
  let added
  if (selectedAlbums.has(albumId)) {
    selectedAlbums.delete(albumId)
    added = false
  } else {
    selectedAlbums.add(albumId)
    added = true
  }
  updateSelectAllCheckbox()
  // Flush save immediately (no debounce) so navigating to DAP page sees the change
  clearTimeout(_saveSelectionsTimer)
  _doSaveSelections()
  updateSyncNowButton()
  debouncedComputeAndRenderSummary()
  return added
}

function toggleArtistDapSelection(artistKey) {
  if (!currentDestinationId) return null
  const artist = library.artists[artistKey]
  if (!artist || !artist.albums || artist.albums.length === 0) return null
  const albumIds = artist.albums.map(ak => albumKeyToId(ak))
  const allSelected = albumIds.every(id => selectedAlbums.has(id))
  if (allSelected) {
    albumIds.forEach(id => selectedAlbums.delete(id))
  } else {
    albumIds.forEach(id => selectedAlbums.add(id))
  }
  updateSelectAllCheckbox()
  // Flush save immediately (no debounce) so navigating to DAP page sees the change
  clearTimeout(_saveSelectionsTimer)
  _doSaveSelections()
  updateSyncNowButton()
  debouncedComputeAndRenderSummary()
  return { added: !allSelected, count: artist.albums.length }
}

// Toggle albums on a SPECIFIC destination (used by modal when user picks a different dest)
async function toggleAlbumsOnDest(albumKeys, destId, action) {
  // action: 'add' | 'remove'
  const albumIds = albumKeys.map(k => albumKeyToId(k))
  if (destId === currentDestinationId) {
    // Same dest as current — use in-memory selectedAlbums
    for (const id of albumIds) {
      if (action === 'add') selectedAlbums.add(id)
      else selectedAlbums.delete(id)
    }
    updateSelectAllCheckbox()
    clearTimeout(_saveSelectionsTimer)
    _doSaveSelections()
    updateSyncNowButton()
    debouncedComputeAndRenderSummary()
  } else {
    // Different dest — load its selections, modify, save back via batch IPC
    try {
      const existingSelections = await invoke('dap_get_selections', { destinationId: destId })
      const selMap = new Map()
      if (existingSelections) {
        for (const s of existingSelections) selMap.set(s.albumId, s.selected)
      }
      for (const id of albumIds) {
        selMap.set(id, action === 'add')
      }
      // Build full selection list (include all known albums for consistency)
      const allAlbumIds = Object.keys(library.albums).map(k => albumKeyToId(k))
      const selections = allAlbumIds.map(id => {
        if (selMap.has(id)) return [id, selMap.get(id)]
        // Not in DB yet — default to true (same as loadSelections first-use behavior)
        return [id, true]
      })
      await invoke('dap_save_selections_batch', { destinationId: destId, selections })
    } catch (e) {
      console.error('[DAP] Failed to toggle on dest', destId, e)
    }
  }
}

function getAlbumQuality(album) {
  const firstTrack = album.tracks[0]
  if (!firstTrack?.metadata) return { label: '-', class: '' }
  return formatQuality(firstTrack.metadata, firstTrack.path)
}

function getQualityRank(cls) {
  if (!cls) return 0
  if (cls.includes('192k')) return 5
  if (cls.includes('96k')) return 4
  if (cls.includes('48k')) return 3
  if (cls.includes('44k')) return 2
  if (cls.includes('lossy')) return 1
  return 0
}


function getCurrentDest() {
  return destinations.find(d => d.id === currentDestinationId)
}

// Returns a status rank for sorting: 2 = to add, 1 = on DAP, 0 = not on DAP, -1 = to remove
function getAlbumStatusRank(albumId, album) {
  if (!syncPlan) return 0
  const hasCopy = _copyAlbumIds.has(albumId)
  const isSelected = selectedAlbums.has(albumId)
  if (hasCopy && isSelected) return 2 // to add
  if (!hasCopy && isSelected) return 1 // on DAP
  if (_deleteSourcePaths.size > 0 && album.tracks.some(t => _deleteSourcePaths.has(t.path))) return -1 // to remove
  return 0 // not on DAP
}

function getAlbumBitrate(album) {
  const firstTrack = album.tracks[0]
  if (!firstTrack?.metadata) return 0
  const m = firstTrack.metadata
  return (Number(m.bitrate) || 0) || (Number(m.sampleRate) || 0) * (Number(m.bitDepth) || 0)
}

function sortAlbumKeys(albumKeys) {
  switch (currentSortKey) {
    case 'alpha-desc':
      return albumKeys.sort((a, b) => b.localeCompare(a))
    case 'bitrate-desc':
      return albumKeys.sort((a, b) => {
        const ra = getQualityRank(getAlbumQuality(library.albums[a]).class)
        const rb = getQualityRank(getAlbumQuality(library.albums[b]).class)
        if (rb !== ra) return rb - ra
        return getAlbumBitrate(library.albums[b]) - getAlbumBitrate(library.albums[a])
      })
    case 'bitrate-asc':
      return albumKeys.sort((a, b) => {
        const ra = getQualityRank(getAlbumQuality(library.albums[a]).class)
        const rb = getQualityRank(getAlbumQuality(library.albums[b]).class)
        if (ra !== rb) return ra - rb
        return getAlbumBitrate(library.albums[a]) - getAlbumBitrate(library.albums[b])
      })
    case 'status':
      return albumKeys.sort((a, b) => {
        const sa = getAlbumStatusRank(albumKeyToId(a), library.albums[a])
        const sb = getAlbumStatusRank(albumKeyToId(b), library.albums[b])
        return sb - sa || a.localeCompare(b)
      })
    default: // alpha-asc
      return albumKeys.sort((a, b) => a.localeCompare(b))
  }
}

// === SIDEBAR ===

async function loadDestinations() {
  try {
    destinations = await invoke('dap_get_destinations')
  } catch (e) {
    console.error('[DAP] Failed to load destinations:', e)
    destinations = []
  }
  renderSidebarDestinations()
}

function renderSidebarDestinations() {
  const container = document.getElementById('dap-sync-destinations')
  if (!container) return
  container.innerHTML = ''

  if (destinations.length === 0) {
    container.innerHTML = `
      <div class="sb-dap-empty">No device connected</div>
    `
    return
  }

  for (const dest of destinations) {
    // MTP destinations are rendered by renderMtpSidebar(), not here
    if (dest.path.startsWith('mtp://')) continue
    const isMounted = mountedVolumes.has(dest.path)
    // Hide offline volumes — only show mounted devices
    if (!isMounted) continue
    const isActive = dest.id === currentDestinationId && ui.currentView === 'dap-sync'
    const isSyncingDev = isSyncing && isActive

    const item = document.createElement('div')
    item.className = 'sb-dap-device' + (isActive ? ' active' : '')

    const freeBytes = isMounted ? (dest._freeBytes || 0) : 0
    const freeLabel = isMounted && freeBytes > 0 ? formatBytes(freeBytes) + ' free' : (isMounted ? '' : 'offline')

    item.innerHTML = `
      <div class="dev-icon${isSyncingDev ? ' pulsing' : ''}" style="${isMounted ? '' : 'opacity:0.4'}">${DAP_ICON_SVG}</div>
      <div class="dev-info">
        <div class="dev-name${isSyncingDev ? ' pulsing' : ''}">${escapeHtml(dest.name)}</div>
        <div class="dev-space">${isSyncingDev ? 'syncing...' : freeLabel}</div>
      </div>
      ${isMounted ? `<button class="dev-eject" title="Eject"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L2 16h20L12 2zM3 19h18v3H3v-3z"/></svg></button>` : ''}
    `

    // Click device → open sync view
    item.addEventListener('click', (e) => {
      if (e.target.closest('.dev-eject')) return
      openSyncPanel(dest)
    })

    // Eject button → eject volume
    const ejectBtn = item.querySelector('.dev-eject')
    if (ejectBtn) {
      ejectBtn.addEventListener('click', async (e) => {
        e.stopPropagation()
        try {
          await invoke('dap_eject_volume', { path: dest.path })
          showToast(`${dest.name} ejected`)
          await refreshMountedVolumes()
        } catch (err) {
          showToast(`Eject failed: ${err}`)
        }
      })
    }

    // Context menu for delete
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      showDestContextMenu(e, dest)
    })

    container.appendChild(item)
  }

  // Also re-render MTP devices (to sync active state)
  renderMtpSidebar()
}

function checkMounted(path) {
  return mountedVolumes.has(path)
}

async function refreshMountedVolumes() {
  try {
    const volumes = await invoke('dap_list_external_volumes')
    // Preserve MTP paths — they are virtual URIs (mtp://...) not OS-level volumes,
    // so dap_list_external_volumes never returns them.
    const mtpPaths = [...mountedVolumes].filter(p => p.startsWith('mtp://'))
    mountedVolumes.clear()
    for (const p of mtpPaths) mountedVolumes.add(p)
    _externalVolumes = volumes
    for (const v of volumes) {
      mountedVolumes.add(v.path)
      // Store free/total bytes on destinations
      for (const d of destinations) {
        if (d.path === v.path || d.path.startsWith(v.path)) {
          d._freeBytes = v.freeBytes
          d._totalBytes = v.totalBytes
        }
      }
    }
    // Auto-create destinations for new removable volumes not yet configured
    for (const v of volumes) {
      const alreadyConfigured = destinations.some(d => d.path === v.path)
      if (!alreadyConfigured) {
        try {
          const dest = {
            name: v.name,
            path: v.path,
            volumeName: v.name,
            folderStructure: 'artist_album_track',
            mirrorMode: true,
            showInSidebar: true,
          }
          await invoke('dap_save_destination', { dest })
        } catch (e) {
          // Path already exists (UNIQUE constraint) or other error — skip silently
          console.warn('[DAP] Auto-create destination failed for', v.name, e)
        }
      }
    }
    // Reload destinations if any were auto-created
    const hadNew = volumes.some(v => !destinations.some(d => d.path === v.path))
    if (hadNew) {
      try {
        destinations = await invoke('dap_get_destinations')
        // Re-apply free/total bytes
        for (const v of volumes) {
          for (const d of destinations) {
            if (d.path === v.path || d.path.startsWith(v.path)) {
              d._freeBytes = v.freeBytes
              d._totalBytes = v.totalBytes
            }
          }
        }
      } catch (e) { /* ignore */ }
    }
  } catch (e) {
    console.error('[DAP] Failed to list volumes:', e)
  }
  renderSidebarDestinations()
}

function showDestContextMenu(e, dest) {
  const menu = document.createElement('div')
  menu.className = 'context-menu'
  menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:9999;background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:4px 0;min-width:140px;`

  const deleteBtn = document.createElement('div')
  deleteBtn.className = 'context-menu-item'
  deleteBtn.style.cssText = 'padding:6px 12px;font-size:12px;color:#ff4444;cursor:pointer;'
  deleteBtn.textContent = 'Delete destination'
  deleteBtn.addEventListener('click', async () => {
    menu.remove()
    try {
      await invoke('dap_delete_destination', { id: dest.id })
      showToast('Destination deleted', 'success')
      if (currentDestinationId === dest.id) closeSyncPanel()
      await loadDestinations()
    } catch (err) {
      showToast('Failed to delete', 'error')
    }
  })

  menu.appendChild(deleteBtn)
  document.body.appendChild(menu)
  const close = () => { menu.remove(); document.removeEventListener('click', close) }
  setTimeout(() => document.addEventListener('click', close), 10)
}

// === ADD DESTINATION ===

async function addDestination() {
  try {
    const volumes = await invoke('dap_list_external_volumes')
    if (volumes.length === 0) {
      showToast('No external volumes detected. Connect a USB drive or SD card.', 'warning')
      return
    }
    if (volumes.length === 1) {
      await createDestinationFromVolume(volumes[0])
      return
    }
    showVolumePicker(volumes)
  } catch (e) {
    showToast('Failed to detect volumes', 'error')
  }
}

function showVolumePicker(volumes) {
  const overlay = document.createElement('div')
  overlay.className = 'dap-modal-overlay'

  const modal = document.createElement('div')
  modal.className = 'dap-modal'
  modal.innerHTML = `<h3 style="margin:0 0 16px;font-size:14px;color:#fff;">Select Volume</h3>`

  for (const vol of volumes) {
    const btn = document.createElement('button')
    btn.className = 'dap-volume-btn'
    btn.innerHTML = `
      <span style="font-size:18px;">&#128190;</span>
      <div>
        <div>${escapeHtml(vol.name)}</div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${formatBytes(vol.freeBytes)} free of ${formatBytes(vol.totalBytes)}</div>
      </div>
    `
    btn.addEventListener('click', async () => { overlay.remove(); await createDestinationFromVolume(vol) })
    modal.appendChild(btn)
  }

  const cancelBtn = document.createElement('button')
  cancelBtn.className = 'dap-btn-secondary'
  cancelBtn.style.marginTop = '8px'
  cancelBtn.textContent = 'Cancel'
  cancelBtn.addEventListener('click', () => overlay.remove())
  modal.appendChild(cancelBtn)

  overlay.appendChild(modal)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  document.body.appendChild(overlay)
}

// === Wave break modal — blocks UI until USB replug ===
// The DAP firmware crashes after ~470 MTP writes without a physical USB reset.
// This modal is impossible to dismiss — the user MUST unplug and replug.

let _waveBreakOverlay = null

function showWaveBreakModal(waveNum, totalWaves, filesCopied, filesRemaining) {
  dismissWaveBreakModal()
  const overlay = document.createElement('div')
  overlay.className = 'dap-modal-overlay dap-wave-modal-overlay'
  overlay.innerHTML = `
    <div class="dap-modal dap-wave-modal">
      <div class="dap-wave-icon">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2v6m0 8v6"/>
          <path d="M6 12H2"/>
          <path d="M22 12h-4"/>
          <rect x="7" y="7" width="10" height="10" rx="1"/>
        </svg>
      </div>
      <h3 class="dap-wave-title">Unplug your DAP now</h3>
      <p class="dap-wave-subtitle">Wave ${waveNum}/${totalWaves} complete — ${filesCopied} files synced</p>
      <div class="dap-wave-steps">
        <div class="dap-wave-step dap-wave-step-active" data-step="unplug">
          <span class="dap-wave-step-num">1</span>
          <span>Unplug the USB cable</span>
        </div>
        <div class="dap-wave-step" data-step="wait">
          <span class="dap-wave-step-num">2</span>
          <span>Wait 5 seconds</span>
        </div>
        <div class="dap-wave-step" data-step="replug">
          <span class="dap-wave-step-num">3</span>
          <span>Plug it back in</span>
        </div>
      </div>
      <p class="dap-wave-remaining">${filesRemaining} files remaining after replug</p>
    </div>
  `
  // NO click-to-dismiss — user must physically replug
  document.body.appendChild(overlay)
  _waveBreakOverlay = overlay
}

function updateWaveBreakModal(phase) {
  if (!_waveBreakOverlay) return
  const steps = _waveBreakOverlay.querySelectorAll('.dap-wave-step')
  const title = _waveBreakOverlay.querySelector('.dap-wave-title')
  if (phase === 'unplugged') {
    // Step 1 done, step 2+3 active
    steps.forEach(s => s.classList.remove('dap-wave-step-active', 'dap-wave-step-done'))
    const step1 = _waveBreakOverlay.querySelector('[data-step="unplug"]')
    const step2 = _waveBreakOverlay.querySelector('[data-step="wait"]')
    const step3 = _waveBreakOverlay.querySelector('[data-step="replug"]')
    if (step1) step1.classList.add('dap-wave-step-done')
    if (step2) step2.classList.add('dap-wave-step-active')
    if (step3) step3.classList.add('dap-wave-step-active')
    if (title) title.textContent = 'Now plug it back in'
  }
}

function dismissWaveBreakModal() {
  if (_waveBreakOverlay) {
    _waveBreakOverlay.remove()
    _waveBreakOverlay = null
  }
}

async function createDestinationFromVolume(volume) {
  const dest = {
    name: volume.name,
    path: volume.path,
    volumeName: volume.name,
    folderStructure: 'artist_album_track',
    mirrorMode: true,
    showInSidebar: true,
  }
  try {
    const id = await invoke('dap_save_destination', { dest })
    showToast(`Destination "${volume.name}" added`, 'success')
    await loadDestinations()
    const newDest = destinations.find(d => d.id === id)
    if (newDest) openSyncPanel(newDest)
  } catch (e) {
    showToast('Failed to save destination', 'error')
  }
}

// === NAVIGATION ===

function navigateToDapSync() {
  // Deactivate nav items
  dom.navItems?.forEach(i => i.classList.remove('active'))
  document.querySelectorAll('.playlist-item.active').forEach(el => el.classList.remove('active'))

  ui.currentView = 'dap-sync'
  renderSidebarDestinations()
  app.displayCurrentView()
}

async function openSyncPanel(dest) {
  currentDestinationId = dest.id
  currentTab = 'albums'
  renderSidebarDestinations()

  // If sync is in progress, go to syncing view instead of albums
  if (isSyncing) {
    dapSubView = 'syncing'
    navigateToDapSync()
    return
  }

  const isMounted = mountedVolumes.has(dest.path)
  if (!isMounted) {
    dapSubView = 'disconnected'
  } else {
    dapSubView = 'albums'
    await loadSelections(dest.id)
  }

  navigateToDapSync()
}

// === DAP TOP BAR (persistent sync zone, replaces search bar in DAP view) ===

function showDapTopBar() {
  const searchInner = document.getElementById('search-bar-inner')
  const dapBar = document.getElementById('dap-sync-bar')
  if (searchInner) searchInner.style.display = 'none'
  if (dapBar) dapBar.classList.remove('hidden')
  renderDapTopBar()
}

function hideDapTopBar() {
  const searchInner = document.getElementById('search-bar-inner')
  const dapBar = document.getElementById('dap-sync-bar')
  if (searchInner) searchInner.style.display = ''
  if (dapBar) { dapBar.classList.add('hidden'); dapBar.innerHTML = '' }
}

function renderDapTopBar() {
  // Top bar is now empty — sync stats moved to expandable panel,
  // Sync button moved to dest-bar. We just keep the bar element present
  // so search-bar-inner stays hidden and feedback/settings remain visible.
  const bar = document.getElementById('dap-sync-bar')
  if (!bar) return
  bar.innerHTML = ''
}

// Update the Sync button inside the dest-bar (called after plan computation)
function updateSyncButton() {
  const btn = document.getElementById('dap-sync-now-btn')
  if (!btn) return
  const isDisabled = selectedAlbums.size === 0 || isSyncing
  const hasPendingChanges = syncPlan && ((syncPlan.filesToCopy?.length ?? 0) > 0 || (syncPlan.filesToDelete?.length ?? 0) > 0)
  btn.disabled = isDisabled
  btn.innerHTML = isSyncing ? 'Syncing\u2026' : 'Sync <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></svg>'
  btn.classList.toggle('has-changes', !isDisabled && hasPendingChanges)
}

function closeSyncPanel() {
  hideDapTopBar()
  currentDestinationId = null
  syncPlan = null
  dapSubView = 'setup'
  renderSidebarDestinations()
  // Navigate back to previous view
  if (ui.currentView === 'dap-sync') {
    app.switchView('home')
  }
}

// === MAIN VIEW RENDER (called from views.js) ===

export function displayDapSyncView() {
  const grid = dom.albumsGridDiv
  if (!grid) return
  grid.textContent = ''
  grid.classList.add('dap-sync-view')

  // Show/hide DAP top bar based on active sub-view
  const topBarViews = ['albums', 'syncing', 'settings']
  if (topBarViews.includes(dapSubView)) showDapTopBar()
  else hideDapTopBar()

  switch (dapSubView) {
    case 'setup': renderSetupView(grid); break
    case 'albums': renderAlbumsView(grid); break
    case 'syncing': renderSyncingView(grid); break
    case 'complete': renderCompleteView(grid); break
    case 'disconnected': renderDisconnectedView(grid); break
    case 'settings': renderSettingsView(grid); break
    case 'error': renderErrorView(grid); break
    case 'first-sync': renderFirstSyncView(grid); break
    default: renderSetupView(grid); break
  }
}

// === SCREEN 1: SETUP ===

function renderSetupView(grid) {
  const div = document.createElement('div')
  div.className = 'dap-setup-center dap-fade-in'
  div.innerHTML = `
    <div class="dap-setup-icon">&#128241;</div>
    <div class="dap-setup-title">Connect your DAP</div>
    <div class="dap-setup-desc">Insert your DAP's SD card into a card reader, or connect your DAP via USB. Select a device in the sidebar to start syncing.</div>
    <button class="dap-setup-btn" id="dap-select-folder-btn">
      <span>&#128193;</span> Select destination folder
    </button>
  `
  grid.appendChild(div)
  div.querySelector('#dap-select-folder-btn').addEventListener('click', addDestination)
}

// === SCREEN 2: SYNC PANEL (Albums) ===

function renderAlbumsView(grid) {
  const dest = getCurrentDest()
  if (!dest) { renderSetupView(grid); return }

  const wrapper = document.createElement('div')
  wrapper.className = 'dap-content dap-fade-in'

  // Destination bar
  const freeBytes = dest._freeBytes || 0
  const totalBytes = dest._totalBytes || 0
  const usedPct = totalBytes > 0 ? ((totalBytes - freeBytes) / totalBytes * 100).toFixed(0) : 0

  const syncDisabled = selectedAlbums.size === 0 || isSyncing

  wrapper.innerHTML = `
    <div class="dap-dest-card">
      <div class="dap-dest-bar ${detailsExpanded ? 'details-open' : ''}">
        <span class="dap-dest-icon">${DAP_ICON_SVG}</span>
        <div class="dap-dest-info">
          <div class="dap-dest-path">${escapeHtml(getMtpDisplayName(dest) || dest.name || dest.path)}</div>
          <div class="dap-dest-space">${formatBytes(freeBytes)} free / ${formatBytes(totalBytes)}</div>
          <div class="dap-storage-bar"><div class="dap-storage-fill" style="width:${usedPct}%"></div></div>
        </div>
        <button class="dap-dest-sync-btn" id="dap-sync-now-btn" ${syncDisabled ? 'disabled' : ''}>
          ${isSyncing ? 'Syncing\u2026' : 'Sync <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></svg>'}
        </button>
        <button class="dap-dest-toggle ${detailsExpanded ? 'open' : ''}" id="dap-dest-toggle" title="Show details">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <button class="dap-dest-gear" id="dap-goto-settings" title="Settings">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
      </div>
      <div class="dap-dest-details ${detailsExpanded ? '' : 'collapsed'}" id="dap-dest-details">
        <div class="dap-summary-loading">Computing sync plan\u2026</div>
      </div>
    </div>

    <div class="dap-sync-tabs">
      <div class="dap-sync-tab active" data-tab="albums">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"/></svg>
        Albums
      </div>
      <div class="dap-sync-tab" data-tab="artists">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
        Artists
      </div>
      <div class="dap-sync-tab" data-tab="tracks">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
        Tracks
      </div>
    </div>

    <div class="dap-search-sort-row">
      <div class="dap-search-box">
        <input type="text" placeholder="Filter albums..." id="dap-album-search" value="${escapeHtml(albumSearchFilter)}">
      </div>
      <div class="artist-sort-dropdown">
        <button id="dap-sort-btn" class="btn-sort-icon" title="Sort">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18"/>
            <path d="M7 12h10"/>
            <path d="M10 18h4"/>
          </svg>
        </button>
        <div id="dap-sort-menu" class="sort-menu hidden">
          <button class="sort-option${currentSortKey === 'alpha-asc' ? ' active' : ''}" data-sort="alpha-asc">Album A → Z</button>
          <button class="sort-option${currentSortKey === 'alpha-desc' ? ' active' : ''}" data-sort="alpha-desc">Album Z → A</button>
          <button class="sort-option${currentSortKey === 'bitrate-desc' ? ' active' : ''}" data-sort="bitrate-desc">Qualité ↓</button>
          <button class="sort-option${currentSortKey === 'bitrate-asc' ? ' active' : ''}" data-sort="bitrate-asc">Qualité ↑</button>
          <button class="sort-option${currentSortKey === 'status' ? ' active' : ''}" data-sort="status">Status</button>
        </div>
      </div>
    </div>

    <div class="dap-select-all-row" id="dap-select-all-row">
      <div class="dap-chk ${selectedAlbums.size === Object.keys(library.albums).length ? 'on' : ''}" id="dap-toggle-all"></div>
      <div class="dap-select-all-label">All (${Object.keys(library.albums).length} albums)</div>
      <div class="dap-select-dropdown">
        <button id="dap-select-btn" class="btn-sort-icon" title="Select by status">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        <div id="dap-select-menu" class="sort-menu hidden">
          <button class="sort-option" data-select="all">Select All</button>
          <button class="sort-option" data-select="none">Deselect All</button>
          <div class="sort-menu-separator"></div>
          <button class="sort-option" data-select="on-dap">On DAP</button>
          <button class="sort-option" data-select="to-add">To Add</button>
          <button class="sort-option" data-select="to-remove">To Remove</button>
        </div>
      </div>
    </div>

    <div class="dap-albums-list" id="dap-albums-list"></div>
  `

  // Show sync-in-progress banner if applicable
  if (isSyncing) {
    const banner = document.createElement('div')
    banner.className = 'dap-sync-banner'
    banner.innerHTML = `<span>Sync in progress\u2026</span><button class="dap-btn-link" id="dap-view-progress">View progress</button>`
    wrapper.insertBefore(banner, wrapper.firstChild)
    banner.querySelector('#dap-view-progress').addEventListener('click', () => {
      dapSubView = 'syncing'
      app.displayCurrentView()
    })
  }

  grid.appendChild(wrapper)

  // Populate album rows
  renderAlbumRows()

  // Compute summary (also updates top bar stats)
  computeAndRenderSummary()

  // Wire events
  const syncBtn = wrapper.querySelector('#dap-sync-now-btn')
  if (syncBtn && !isSyncing) syncBtn.addEventListener('click', startSync)

  wrapper.querySelector('#dap-dest-toggle').addEventListener('click', (e) => { e.stopPropagation(); toggleDestDetails() })
  wrapper.querySelector('.dap-dest-bar').addEventListener('click', (e) => {
    // Don't toggle if clicking on buttons inside the bar
    if (e.target.closest('button')) return
    toggleDestDetails()
  })
  wrapper.querySelector('#dap-goto-settings').addEventListener('click', () => {
    dapSubView = 'settings'
    app.displayCurrentView()
  })

  wrapper.querySelector('#dap-toggle-all').addEventListener('click', function () {
    const wasOn = this.classList.contains('on')
    // Immediate visual feedback before async operations
    this.classList.toggle('on', !wasOn)
    if (wasOn) {
      deselectAll()
    } else {
      selectAll()
    }
  })

  // Select-by-status dropdown
  const dapSelectBtn = wrapper.querySelector('#dap-select-btn')
  const dapSelectMenu = wrapper.querySelector('#dap-select-menu')
  if (dapSelectBtn && dapSelectMenu) {
    dapSelectBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      dapSelectMenu.classList.toggle('hidden')
    })
    dapSelectMenu.querySelectorAll('.sort-option').forEach(option => {
      option.addEventListener('click', (e) => {
        e.stopPropagation()
        dapSelectMenu.classList.add('hidden')
        selectByStatus(option.dataset.select)
      })
    })
    const closeDapSelectMenu = (e) => {
      if (!e.target.closest('.dap-select-dropdown')) {
        dapSelectMenu.classList.add('hidden')
      }
    }
    document.removeEventListener('click', window._dapSelectMenuClose)
    window._dapSelectMenuClose = closeDapSelectMenu
    document.addEventListener('click', closeDapSelectMenu)
  }

  wrapper.querySelector('#dap-album-search').addEventListener('input', (e) => {
    albumSearchFilter = e.target.value
    renderTabContent()
  })

  // Sort dropdown (same pattern as album/artist views)
  const dapSortBtn = wrapper.querySelector('#dap-sort-btn')
  const dapSortMenu = wrapper.querySelector('#dap-sort-menu')
  dapSortBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    dapSortMenu.classList.toggle('hidden')
  })
  dapSortMenu.querySelectorAll('.sort-option').forEach(option => {
    option.addEventListener('click', (e) => {
      e.stopPropagation()
      currentSortKey = option.dataset.sort
      dapSortMenu.classList.add('hidden')
      // Update active state on all options
      dapSortMenu.querySelectorAll('.sort-option').forEach(o => o.classList.toggle('active', o.dataset.sort === currentSortKey))
      renderTabContent()
    })
  })
  const closeDapSortMenu = (e) => {
    if (!e.target.closest('.artist-sort-dropdown')) {
      dapSortMenu.classList.add('hidden')
    }
  }
  document.removeEventListener('click', window._dapSortMenuClose)
  window._dapSortMenuClose = closeDapSortMenu
  document.addEventListener('click', closeDapSortMenu)

  // Tab switching
  wrapper.querySelectorAll('.dap-sync-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      wrapper.querySelectorAll('.dap-sync-tab').forEach(t => t.classList.remove('active'))
      tab.classList.add('active')
      currentTab = tab.dataset.tab
      albumSearchFilter = ''
      const searchInput = document.getElementById('dap-album-search')
      if (searchInput) {
        searchInput.value = ''
        searchInput.placeholder = currentTab === 'artists' ? 'Filter artists...' : currentTab === 'tracks' ? 'Filter tracks...' : 'Filter albums...'
      }
      renderTabContent()
      updateSelectAllLabel()
    })
  })
}

function renderAlbumRows() {
  const container = document.getElementById('dap-albums-list')
  if (!container) return
  container.innerHTML = ''

  const filter = albumSearchFilter.toLowerCase()
  const albumKeys = sortAlbumKeys(Object.keys(library.albums))

  // Build all rows into a DocumentFragment (single DOM reflow)
  const fragment = document.createDocumentFragment()
  const thumbQueue = []

  for (const albumKey of albumKeys) {
    const album = library.albums[albumKey]
    const albumName = album.album || albumKey
    const artistName = album.artist || 'Unknown Artist'

    if (filter && !albumName.toLowerCase().includes(filter) && !artistName.toLowerCase().includes(filter)) continue

    const albumId = albumKeyToId(albumKey)
    const isSelected = selectedAlbums.has(albumId)
    const quality = getAlbumQuality(album)

    // Status badges — O(1) lookups via pre-computed Sets
    let statusTag = ''
    if (syncPlan) {
      const hasCopy = _copyAlbumIds.has(albumId)
      const hasDelete = _deleteSourcePaths.size > 0 && album.tracks.some(t => _deleteSourcePaths.has(t.path))
      const onDap = _onDapAlbumIds.has(albumId) && isSelected
      if (onDap && !hasCopy) {
        statusTag = '<span class="dap-status-tag on-dap">on DAP</span>'
      } else if (hasCopy && isSelected) {
        statusTag = '<span class="dap-status-tag to-add">to add</span>'
      } else if (hasDelete) {
        statusTag = '<span class="dap-status-tag to-remove">to remove</span>'
      }
    }

    const row = document.createElement('div')
    row.className = 'dap-album-row'
    row.innerHTML = `
      <div class="dap-chk ${isSelected ? 'on' : ''}" data-album-id="${albumId}"></div>
      <div class="dap-alb-art" data-cover-path="${album.coverPath || ''}"></div>
      <div class="dap-alb-info">
        <div class="dap-alb-name">${escapeHtml(albumName)}</div>
        <div class="dap-alb-artist">${escapeHtml(artistName)}</div>
      </div>
      <div class="dap-alb-badges">${statusTag}</div>
      <span class="quality-tag ${quality.class}">${quality.label}</span>
    `

    // Event delegation: use a single click handler per row
    row.addEventListener('click', (e) => {
      if (e.target.closest('.quality-tag')) return
      const chk = row.querySelector('.dap-chk')
      if (!chk) return
      if (chk.classList.contains('on')) {
        selectedAlbums.delete(albumId)
        chk.classList.remove('on')
      } else {
        selectedAlbums.add(albumId)
        chk.classList.add('on')
      }
      updateSelectAllCheckbox()
      saveSelections()
      updateSyncNowButton()
      debouncedComputeAndRenderSummary()
    })

    // Queue thumbnail for deferred loading
    if (album.coverPath && app.loadThumbnailAsync) {
      thumbQueue.push({ row, coverPath: album.coverPath, artist: album.artist, albumName })
    }

    fragment.appendChild(row)
  }

  container.appendChild(fragment)
  updateSelectAllCheckbox()

  // Load thumbnails in batches to avoid flooding IPC
  loadThumbsBatched(thumbQueue)
}

function loadThumbsBatched(queue) {
  const BATCH = 8
  let i = 0
  function nextBatch() {
    const end = Math.min(i + BATCH, queue.length)
    for (; i < end; i++) {
      const { row, coverPath, artist, albumName } = queue[i]
      const wrapper = row.querySelector('.dap-alb-art')
      if (!wrapper || !wrapper.isConnected) continue
      // Insert img INTO the DOM-connected wrapper so loadThumbnailAsync's
      // isConnected check passes (needed for internet cover fallback)
      const img = document.createElement('img')
      img.className = 'dap-alb-art-img'
      img.style.display = 'none'
      wrapper.appendChild(img)
      app.loadThumbnailAsync(coverPath, img, artist, albumName).then(() => {
        if (img.src) {
          img.style.display = ''
        }
      })
    }
    if (i < queue.length) requestAnimationFrame(nextBatch)
  }
  if (queue.length > 0) requestAnimationFrame(nextBatch)
}

function renderTabContent() {
  const container = document.getElementById('dap-albums-list')
  switch (currentTab) {
    case 'artists': renderArtistRows(); break
    case 'tracks': renderTrackRows(); break
    default: renderAlbumRows(); break
  }
  // Subtle fade-in on tab switch
  if (container) {
    container.classList.remove('dap-tab-enter')
    // Force reflow to restart animation
    void container.offsetWidth
    container.classList.add('dap-tab-enter')
  }
}

function updateSelectAllLabel() {
  const label = document.querySelector('.dap-select-all-label')
  if (!label) return
  switch (currentTab) {
    case 'artists': {
      const artistCount = new Set(Object.values(library.albums).map(a => a.artist || 'Unknown Artist')).size
      label.textContent = `All (${artistCount} artists)`
      break
    }
    case 'tracks': {
      const trackCount = Object.values(library.albums).reduce((sum, a) => sum + a.tracks.length, 0)
      label.textContent = `All (${trackCount} tracks)`
      break
    }
    default:
      label.textContent = `All (${Object.keys(library.albums).length} albums)`
  }
}

function renderArtistRows() {
  const container = document.getElementById('dap-albums-list')
  if (!container) return
  container.innerHTML = ''

  const filter = albumSearchFilter.toLowerCase()

  // Group albums by artist
  const artistMap = {}
  for (const albumKey of Object.keys(library.albums)) {
    const album = library.albums[albumKey]
    const artistName = album.artist || 'Unknown Artist'
    if (!artistMap[artistName]) {
      artistMap[artistName] = []
    }
    artistMap[artistName].push({ albumKey, album })
  }

  let artistNames = Object.keys(artistMap)
  switch (currentSortKey) {
    case 'alpha-desc':
      artistNames.sort((a, b) => b.localeCompare(a)); break
    case 'bitrate-desc':
      artistNames.sort((a, b) => {
        const ra = Math.max(...artistMap[a].map(x => getQualityRank(getAlbumQuality(x.album).class)))
        const rb = Math.max(...artistMap[b].map(x => getQualityRank(getAlbumQuality(x.album).class)))
        if (rb !== ra) return rb - ra
        return Math.max(...artistMap[b].map(x => getAlbumBitrate(x.album))) - Math.max(...artistMap[a].map(x => getAlbumBitrate(x.album)))
      }); break
    case 'bitrate-asc':
      artistNames.sort((a, b) => {
        const ra = Math.max(...artistMap[a].map(x => getQualityRank(getAlbumQuality(x.album).class)))
        const rb = Math.max(...artistMap[b].map(x => getQualityRank(getAlbumQuality(x.album).class)))
        if (ra !== rb) return ra - rb
        return Math.max(...artistMap[a].map(x => getAlbumBitrate(x.album))) - Math.max(...artistMap[b].map(x => getAlbumBitrate(x.album)))
      }); break
    case 'status':
      artistNames.sort((a, b) => {
        const sa = Math.max(...artistMap[a].map(x => getAlbumStatusRank(albumKeyToId(x.albumKey), x.album)))
        const sb = Math.max(...artistMap[b].map(x => getAlbumStatusRank(albumKeyToId(x.albumKey), x.album)))
        return sb - sa || a.localeCompare(b)
      }); break
    default:
      artistNames.sort((a, b) => a.localeCompare(b))
  }

  for (const artistName of artistNames) {
    if (filter && !artistName.toLowerCase().includes(filter)) continue

    const albums = artistMap[artistName]
    const albumIds = albums.map(a => albumKeyToId(a.albumKey))
    const allSelected = albumIds.every(id => selectedAlbums.has(id))
    const someSelected = albumIds.some(id => selectedAlbums.has(id))
    const trackCount = albums.reduce((sum, a) => sum + a.album.tracks.length, 0)

    // Get best quality across all albums by this artist
    let bestQuality = null
    for (const { album } of albums) {
      const q = getAlbumQuality(album)
      if (!bestQuality || getQualityRank(q.class) > getQualityRank(bestQuality.class)) {
        bestQuality = q
      }
    }

    // Status badge — O(1) lookups via pre-computed Sets
    let statusTag = ''
    if (syncPlan) {
      let hasAnyCopy = false, hasAnyDelete = false, allOnDap = true
      for (const { albumKey, album } of albums) {
        const aid = albumKeyToId(albumKey)
        const isSel = selectedAlbums.has(aid)
        const hasCopy = _copyAlbumIds.has(aid)
        const isOnDap = _onDapAlbumIds.has(aid)
        const hasDelete = _deleteSourcePaths.size > 0 && album.tracks.some(t => _deleteSourcePaths.has(t.path))
        if (hasCopy) { hasAnyCopy = true; allOnDap = false }
        else if (!isSel || !isOnDap) allOnDap = false
        if (hasDelete) hasAnyDelete = true
      }
      if (allOnDap && someSelected) {
        statusTag = '<span class="dap-status-tag on-dap">on DAP</span>'
      } else if (hasAnyCopy) {
        statusTag = '<span class="dap-status-tag to-add">to add</span>'
      } else if (hasAnyDelete && !someSelected) {
        statusTag = '<span class="dap-status-tag to-remove">to remove</span>'
      }
    }

    const row = document.createElement('div')
    row.className = 'dap-album-row'
    row.innerHTML = `
      <div class="dap-chk ${allSelected ? 'on' : (someSelected ? 'partial' : '')}" data-artist="${escapeHtml(artistName)}"></div>
      <div class="dap-artist-avatar">${escapeHtml(artistName.charAt(0).toUpperCase())}</div>
      <div class="dap-alb-info">
        <div class="dap-alb-name">${escapeHtml(artistName)}</div>
        <div class="dap-alb-artist">${albums.length} album${albums.length > 1 ? 's' : ''} · ${trackCount} track${trackCount !== 1 ? 's' : ''}</div>
      </div>
      ${statusTag}
      <span class="quality-tag ${bestQuality?.class || ''}">${bestQuality?.label || '-'}</span>
    `

    const chk = row.querySelector('.dap-chk')
    chk.addEventListener('click', (e) => {
      e.stopPropagation()
      // Use live state — not stale closure variable
      const nowAllSelected = albumIds.every(id => selectedAlbums.has(id))
      if (nowAllSelected) {
        albumIds.forEach(id => selectedAlbums.delete(id))
        chk.classList.remove('on', 'partial')
      } else {
        albumIds.forEach(id => selectedAlbums.add(id))
        chk.classList.add('on')
        chk.classList.remove('partial')
      }
      updateSelectAllCheckbox()
      saveSelections()
      updateSyncNowButton()
      debouncedComputeAndRenderSummary()
    })

    row.addEventListener('click', (e) => {
      if (e.target.closest('.dap-chk')) return
      chk.click()
    })

    container.appendChild(row)
  }

  updateSelectAllCheckbox()
}

function renderTrackRows() {
  const container = document.getElementById('dap-albums-list')
  if (!container) return
  container.innerHTML = ''

  const filter = albumSearchFilter.toLowerCase()
  const albumKeys = sortAlbumKeys(Object.keys(library.albums))

  for (const albumKey of albumKeys) {
    const album = library.albums[albumKey]
    const albumId = albumKeyToId(albumKey)
    const isAlbumSelected = selectedAlbums.has(albumId)

    for (const track of album.tracks) {
      const meta = track.metadata || {}
      const title = meta.title || track.name || 'Unknown'
      const artistName = meta.artist || album.artist || 'Unknown Artist'

      if (filter && !title.toLowerCase().includes(filter) && !artistName.toLowerCase().includes(filter) && !(album.album || '').toLowerCase().includes(filter)) continue

      const quality = formatQuality(meta, track.path)

      // Status badge — O(1) lookups via pre-computed Sets
      let statusTag = ''
      if (syncPlan) {
        const hasCopy = _copyAlbumIds.has(albumId)
        const hasDelete = _deleteSourcePaths.size > 0 && album.tracks.some(t => _deleteSourcePaths.has(t.path))
        const onDap = _onDapAlbumIds.has(albumId) && isAlbumSelected
        if (onDap && !hasCopy) {
          statusTag = '<span class="dap-status-tag on-dap">on DAP</span>'
        } else if (hasCopy && isAlbumSelected) {
          statusTag = '<span class="dap-status-tag to-add">to add</span>'
        } else if (hasDelete) {
          statusTag = '<span class="dap-status-tag to-remove">to remove</span>'
        }
      }

      const row = document.createElement('div')
      row.className = 'dap-album-row' + (!isAlbumSelected ? ' dap-row-dimmed' : '')
      row.innerHTML = `
        <div class="dap-chk ${isAlbumSelected ? 'on' : ''}" data-album-id="${albumId}"></div>
        <div class="dap-track-num">${meta.track || '-'}</div>
        <div class="dap-alb-info">
          <div class="dap-alb-name">${escapeHtml(title)}</div>
          <div class="dap-alb-artist">${escapeHtml(artistName)} — ${escapeHtml(album.album || albumKey)}</div>
        </div>
        ${statusTag}
        <span class="quality-tag ${quality.class}">${quality.label}</span>
      `

      const chk = row.querySelector('.dap-chk')
      chk.addEventListener('click', (e) => {
        e.stopPropagation()
        const wasSelected = selectedAlbums.has(albumId)
        if (wasSelected) {
          selectedAlbums.delete(albumId)
        } else {
          selectedAlbums.add(albumId)
        }
        // Update all track rows sharing this albumId in-place
        const allChks = container.querySelectorAll(`.dap-chk[data-album-id="${albumId}"]`)
        for (const c of allChks) {
          c.classList.toggle('on', !wasSelected)
          c.closest('.dap-album-row')?.classList.toggle('dap-row-dimmed', wasSelected)
        }
        updateSelectAllCheckbox()
        saveSelections()
        updateSyncNowButton()
        debouncedComputeAndRenderSummary()
      })

      row.addEventListener('click', (e) => {
        if (e.target.closest('.dap-chk')) return
        chk.click()
      })

      container.appendChild(row)
    }
  }

  updateSelectAllCheckbox()
}

function updateSelectAllCheckbox() {
  const chk = document.getElementById('dap-toggle-all')
  if (!chk) return
  const total = Object.keys(library.albums).length
  if (selectedAlbums.size === total) {
    chk.classList.add('on')
  } else {
    chk.classList.remove('on')
  }
}

function updateSyncNowButton() {
  updateSyncButton()
}

function selectAll() {
  for (const albumKey of Object.keys(library.albums)) {
    selectedAlbums.add(albumKeyToId(albumKey))
  }
  renderTabContent()
  updateSelectAllCheckbox()
  saveSelections()
  updateSyncNowButton()
  debouncedComputeAndRenderSummary()
}

function deselectAll() {
  selectedAlbums.clear()
  renderTabContent()
  updateSelectAllCheckbox()
  saveSelections()
  updateSyncNowButton()
  debouncedComputeAndRenderSummary()
}

function selectByStatus(mode) {
  switch (mode) {
    case 'all':
      selectAll()
      return
    case 'none':
      deselectAll()
      return
    case 'on-dap':
      // Select only albums already on the DAP
      selectedAlbums.clear()
      for (const albumId of _onDapAlbumIds) {
        selectedAlbums.add(albumId)
      }
      break
    case 'to-add':
      // Select only albums that need to be copied (not yet on DAP)
      selectedAlbums.clear()
      for (const albumKey of Object.keys(library.albums)) {
        const albumId = albumKeyToId(albumKey)
        if (!_onDapAlbumIds.has(albumId)) {
          selectedAlbums.add(albumId)
        }
      }
      break
    case 'to-remove':
      // Select only albums that are on DAP but would be removed (currently on DAP + in delete plan)
      selectedAlbums.clear()
      // Albums on DAP that have files marked for deletion
      for (const albumKey of Object.keys(library.albums)) {
        const albumId = albumKeyToId(albumKey)
        const album = library.albums[albumKey]
        if (_onDapAlbumIds.has(albumId) || (_deleteSourcePaths.size > 0 && album.tracks.some(t => _deleteSourcePaths.has(t.path)))) {
          // Check if this album has tracks marked for deletion
          if (_deleteSourcePaths.size > 0 && album.tracks.some(t => _deleteSourcePaths.has(t.path))) {
            selectedAlbums.add(albumId)
          }
        }
      }
      break
    default:
      return
  }
  renderTabContent()
  updateSelectAllCheckbox()
  saveSelections()
  updateSyncNowButton()
  debouncedComputeAndRenderSummary()
}

// === SUMMARY ===

function debouncedComputeAndRenderSummary() {
  clearTimeout(_summaryDebounceTimer)
  _summaryDebounceTimer = setTimeout(() => computeAndRenderSummary(), 500)
}

function precomputeSyncPlanLookups() {
  _copyAlbumIds = new Set()
  _onDapAlbumIds = new Set()
  _deleteSourcePaths = new Set()
  if (!syncPlan) return
  if (syncPlan.filesToCopy) {
    for (const f of syncPlan.filesToCopy) _copyAlbumIds.add(f.albumId)
  }
  if (syncPlan.unchangedAlbumIds) {
    for (const id of syncPlan.unchangedAlbumIds) _onDapAlbumIds.add(id)
  }
  if (syncPlan.filesToDelete) {
    for (const f of syncPlan.filesToDelete) _deleteSourcePaths.add(f.sourcePath)
  }
}

async function computeAndRenderSummary() {
  const details = document.getElementById('dap-dest-details')
  if (!details) return

  const dest = getCurrentDest()
  if (!dest) return

  // Skip plan recomputation for MTP destinations during sync — would compete
  // for exclusive USB access and cause the device to disconnect (error 0xe00002c5).
  if (isSyncing && dest.path && dest.path.startsWith('mtp://')) {
    console.log('[DAP] Skipping plan recompute — MTP sync in progress')
    return
  }

  if (!mountedVolumes.has(dest.path)) {
    details.innerHTML = '<div class="dap-summary-error">Volume not mounted</div>'
    return
  }

  details.innerHTML = '<div class="dap-summary-loading">Computing\u2026</div>'

  try {
    const tracksForSync = buildTracksForSync()
    const folderStructure = dest.folderStructure || 'artist_album_track'
    const mirrorMode = dest.mirrorMode !== false

    syncPlan = await invoke('dap_compute_sync_plan', {
      tracks: tracksForSync,
      destPath: dest.path,
      folderStructure,
      mirrorMode,
    })

    // Pre-compute lookup sets for O(1) status badge checks
    precomputeSyncPlanLookups()

    // On first load: auto-select ONLY albums already on DAP
    // so the user sees a selection matching the device's current state
    if (_needsOnDapPreselection) {
      _needsOnDapPreselection = false
      selectedAlbums.clear()
      for (const albumId of _onDapAlbumIds) {
        selectedAlbums.add(albumId)
      }
      console.log(`[DAP] Auto-preselection: ${_onDapAlbumIds.size} albums on DAP selected, ${_copyAlbumIds.size} albums not on DAP`)
      saveSelections()
      renderTabContent()
      updateSelectAllCheckbox()
      // Re-compute with corrected selections
      computeAndRenderSummary()
      return
    }

    renderSummary(syncPlan, dest)

    updateSyncButton()          // Update Sync button state in dest-bar
    renderDapTopBar()           // Keep top bar in sync (hides search bar)

    updateStatusTagsInPlace()   // Update status badges without full re-render
  } catch (e) {
    details.innerHTML = `<div class="dap-summary-error">${escapeHtml(String(e))}</div>`
  }
}

function updateStatusTagsInPlace() {
  const container = document.getElementById('dap-albums-list')
  if (!container || !syncPlan) return

  // Build albumId → albumKey reverse map for quick lookups
  const idToKey = {}
  for (const albumKey of Object.keys(library.albums)) {
    idToKey[albumKeyToId(albumKey)] = albumKey
  }

  for (const row of container.querySelectorAll('.dap-album-row')) {
    const chk = row.querySelector('.dap-chk')
    const badge = row.querySelector('.dap-alb-badges')
    if (!chk || !badge) continue

    const albumId = parseInt(chk.dataset.albumId)
    if (isNaN(albumId)) continue

    const albumKey = idToKey[albumId]
    if (!albumKey) continue

    const album = library.albums[albumKey]
    const isSelected = selectedAlbums.has(albumId)

    let statusTag = ''
    const hasCopy = _copyAlbumIds.has(albumId)
    const hasDelete = _deleteSourcePaths.size > 0 && album.tracks.some(t => _deleteSourcePaths.has(t.path))
    const onDap = _onDapAlbumIds.has(albumId) && isSelected
    if (onDap && !hasCopy) statusTag = '<span class="dap-status-tag on-dap">on DAP</span>'
    else if (hasCopy && isSelected) statusTag = '<span class="dap-status-tag to-add">to add</span>'
    else if (hasDelete) statusTag = '<span class="dap-status-tag to-remove">to remove</span>'

    badge.innerHTML = statusTag
  }
}

function renderSummary(plan, dest) {
  const details = document.getElementById('dap-dest-details')
  if (!details) return

  // --- Library stats from selection ---
  let totalTracks = 0
  const artistSet = new Set()
  for (const albumKey of Object.keys(library.albums)) {
    const albumId = albumKeyToId(albumKey)
    if (!selectedAlbums.has(albumId)) continue
    const album = library.albums[albumKey]
    totalTracks += album.tracks.length
    if (album.artist) artistSet.add(album.artist)
  }

  // --- Sync plan stats ---
  const copyCount = plan.filesToCopy?.length || 0
  const coversCount = plan.coversToCopy?.length || 0
  const deleteCount = plan.filesToDelete?.length || 0
  const unchanged = plan.filesUnchanged || 0
  const totalCopyB = (plan.totalCopyBytes || 0) + (plan.totalCoverBytes || 0)
  const copyBytes = formatBytes(totalCopyB)
  const deleteBytes = formatBytes(plan.totalDeleteBytes || 0)

  const totalBytes = dest._totalBytes || 0
  const freeBytes = dest._freeBytes || 0
  const usedBytes = totalBytes - freeBytes
  const netB = (plan.netBytes || 0) + (plan.totalCoverBytes || 0)
  const afterUsed = usedBytes + netB
  const afterFree = totalBytes - afterUsed
  const afterPct = totalBytes > 0 ? (afterUsed / totalBytes * 100).toFixed(0) : 0

  // --- Last sync info ---
  const lastSyncStr = dest.lastSyncAt
    ? new Date(dest.lastSyncAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'Never'

  details.innerHTML = `
    <div class="dap-det-grid">
      <div class="dap-det-col">
        <div class="dap-det-col-title">Selection</div>
        <div class="dap-det-row">
          <span class="dap-det-label">Albums</span>
          <span class="dap-det-val">${selectedAlbums.size}</span>
        </div>
        <div class="dap-det-row">
          <span class="dap-det-label">Artists</span>
          <span class="dap-det-val">${artistSet.size}</span>
        </div>
        <div class="dap-det-row">
          <span class="dap-det-label">Tracks</span>
          <span class="dap-det-val">${totalTracks}</span>
        </div>
      </div>
      <div class="dap-det-col">
        <div class="dap-det-col-title">Sync</div>
        <div class="dap-det-row">
          <span class="dap-det-label">To copy</span>
          <span class="dap-det-val g">${copyCount > 0 ? `+${copyCount}${coversCount > 0 ? ` + ${coversCount} covers` : ''} (${copyBytes})` : 'Nothing'}</span>
        </div>
        <div class="dap-det-row">
          <span class="dap-det-label">To remove</span>
          <span class="dap-det-val r">${deleteCount > 0 ? `\u2212${deleteCount} (${deleteBytes})` : 'Nothing'}</span>
        </div>
        <div class="dap-det-row">
          <span class="dap-det-label">On DAP</span>
          <span class="dap-det-val">${unchanged} files</span>
        </div>
      </div>
    </div>
    <div class="dap-det-footer">
      <span class="dap-det-footer-item">Free after sync: <strong>${totalBytes > 0 ? formatBytes(afterFree) : '\u2014'}</strong></span>
      <span class="dap-det-footer-sep">\u00b7</span>
      <span class="dap-det-footer-item">Last sync: <strong>${escapeHtml(lastSyncStr)}</strong></span>
    </div>
    ${!plan.enoughSpace ? '<div class="dap-sum-error">Not enough space on destination</div>' : ''}
  `
}

function toggleDestDetails() {
  detailsExpanded = !detailsExpanded
  const panel = document.getElementById('dap-dest-details')
  const btn = document.getElementById('dap-dest-toggle')
  const bar = panel?.previousElementSibling
  if (panel) panel.classList.toggle('collapsed', !detailsExpanded)
  if (btn) btn.classList.toggle('open', detailsExpanded)
  if (bar?.classList.contains('dap-dest-bar')) bar.classList.toggle('details-open', detailsExpanded)
}

// === SCREEN 3: SYNCING ===

function renderSyncingView(grid) {
  const dest = getCurrentDest()
  const deviceName = dest?.name || 'Device'

  const div = document.createElement('div')
  div.className = 'dap-setup-center dap-fade-in'

  const p = syncProgress
  const phaseLabel = p.phase === 'copy' ? 'Copying files' : p.phase === 'delete' ? 'Removing files' : 'Preparing'
  const pct = p.total > 0 ? (p.current / p.total * 100).toFixed(1) : 0

  div.innerHTML = `
    <div class="dap-trf-anim-wrap">${TRANSFORMER_SVG}</div>
    <div class="dap-syncing-label">Syncing to ${escapeHtml(deviceName)}</div>
    <div class="dap-phase-indicator">
      <span class="dap-phase-dot"></span>
      <span class="dap-phase-text">${phaseLabel}</span>
    </div>
    <div class="dap-sync-progress-area">
      <div class="dap-prog-bar"><div class="dap-prog-fill" style="width:${pct}%"></div></div>
      <div class="dap-prog-stats">
        <span>${p.current} / ${p.total} files</span>
        <span>${formatBytes(p.bytesCopied)} / ${formatBytes(p.totalBytes)}</span>
      </div>
      <div class="dap-prog-file">${escapeHtml(p.currentFile || '')}</div>
    </div>
    <button class="dap-btn-secondary" id="dap-cancel-sync-btn">Cancel sync</button>
  `

  grid.appendChild(div)
  div.querySelector('#dap-cancel-sync-btn').addEventListener('click', () => {
    cancelSync()
  })
}

// === SCREEN 4: COMPLETE ===

function renderCompleteView(grid) {
  const dest = getCurrentDest()
  const deviceName = dest?.name || 'Device'
  const r = syncResult || {}
  const hasErrors = r.errors?.length > 0

  const freeBytes = dest?._freeBytes || 0
  const totalBytes = dest?._totalBytes || 0
  const usedPct = totalBytes > 0 ? ((totalBytes - freeBytes) / totalBytes * 100).toFixed(0) : 0

  const div = document.createElement('div')
  div.className = 'dap-setup-center dap-fade-in'
  // Generate subtle micro-particles
  const particles = Array.from({ length: 6 }, (_, i) => {
    const angle = (i / 6) * Math.PI * 2 + (Math.random() * 0.5 - 0.25)
    const dist = 28 + Math.random() * 16
    const tx = Math.round(Math.cos(angle) * dist)
    const ty = Math.round(Math.sin(angle) * dist)
    const dur = (1.6 + Math.random() * 1.2).toFixed(1)
    const delay = (Math.random() * 2.5).toFixed(1)
    const size = (2 + Math.random() * 1.5).toFixed(1)
    return `<span class="dap-particle" style="--tx:${tx}px;--ty:${ty}px;--dur:${dur}s;--delay:${delay}s;width:${size}px;height:${size}px"></span>`
  }).join('')

  // Title adapts to success vs partial success
  const titleText = hasErrors ? 'Sync completed with errors' : 'Sync complete'
  const subtitleText = hasErrors
    ? `${r.filesCopied || 0} files synced to ${escapeHtml(deviceName)} — ${r.errors.length} failed`
    : `All changes applied to ${escapeHtml(deviceName)}`

  // Error report section — grouped by album with human-readable reasons
  let errorReportHtml = ''
  if (hasErrors) {
    // Group errors by album folder (Artist/Album)
    const albumErrors = new Map() // folder → { tracks: [], reason: string }
    for (const err of r.errors) {
      // Parse "Artist/Album/track.flac — Reason"
      const dashIdx = err.indexOf(' — ')
      const path = dashIdx > 0 ? err.substring(0, dashIdx) : err
      const rawReason = dashIdx > 0 ? err.substring(dashIdx + 3) : 'Unknown error'

      // Extract album folder (everything before last /)
      const lastSlash = path.lastIndexOf('/')
      const folder = lastSlash > 0 ? path.substring(0, lastSlash) : 'Unknown'
      const filename = lastSlash > 0 ? path.substring(lastSlash + 1) : path

      // Human-readable reason (no dev jargon)
      let reason = 'Unknown error'
      if (rawReason.includes('exFAT') || rawReason.includes('Invalid argument') || rawReason.includes('directory rejected')) {
        reason = 'SD card filesystem rejected the folder name'
      } else if (rawReason.includes('Source file not found') || rawReason.includes('not found')) {
        reason = 'Source file not found on NAS'
      } else if (rawReason.includes('Permission denied')) {
        reason = 'Permission denied'
      } else if (rawReason.includes('No space left')) {
        reason = 'No space left on SD card'
      } else if (rawReason.includes('ghost') || rawReason.includes('Ghost')) {
        reason = 'Corrupted folder from previous sync'
      } else if (rawReason.includes('Size mismatch') || rawReason.includes('Partial')) {
        reason = 'File was not fully copied (USB issue)'
      } else if (rawReason.includes('cancelled')) {
        reason = 'Sync was cancelled'
      } else {
        reason = rawReason.length > 60 ? rawReason.substring(0, 57) + '...' : rawReason
      }

      if (!albumErrors.has(folder)) {
        albumErrors.set(folder, { tracks: [], reason })
      }
      albumErrors.get(folder).tracks.push(filename)
    }

    const albumCount = albumErrors.size
    const trackCount = r.errors.length
    let albumListHtml = ''
    for (const [folder, info] of albumErrors) {
      const trackList = info.tracks.length <= 3
        ? info.tracks.map(t => `<div class="dap-err-track">${escapeHtml(t)}</div>`).join('')
        : info.tracks.slice(0, 2).map(t => `<div class="dap-err-track">${escapeHtml(t)}</div>`).join('')
          + `<div class="dap-err-track dap-err-more">+ ${info.tracks.length - 2} more tracks</div>`

      albumListHtml += `
        <div class="dap-err-album">
          <div class="dap-err-album-header">
            <span class="dap-err-album-name">${escapeHtml(folder)}</span>
            <span class="dap-err-album-count">${info.tracks.length} track${info.tracks.length > 1 ? 's' : ''}</span>
          </div>
          <div class="dap-err-reason">${escapeHtml(info.reason)}</div>
          <div class="dap-err-tracks">${trackList}</div>
        </div>`
    }

    errorReportHtml = `
      <div class="dap-complete-error-report">
        <div class="dap-complete-retry-msg">Some files couldn't be synced. Retry to complete the transfer.</div>
        <details class="dap-err-details">
          <summary class="dap-err-summary">${trackCount} track${trackCount > 1 ? 's' : ''} in ${albumCount} album${albumCount > 1 ? 's' : ''} failed</summary>
          <div class="dap-err-list">${albumListHtml}</div>
        </details>
      </div>`
  }

  div.innerHTML = `
    <div class="dap-complete-dap-icon">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="5" y="1" width="14" height="22" rx="2.5"/>
        <rect x="7" y="3" width="10" height="8" rx="1"/>
        <path d="M10 6l3 1.5-3 1.5V6z" fill="currentColor" stroke="none"/>
        <circle cx="12" cy="17" r="3.5"/>
        <circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/>
      </svg>
      <div class="${hasErrors ? 'dap-warn-badge' : 'dap-check-badge'}">
        ${hasErrors
          ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v4"/><circle cx="12" cy="16" r="0.5" fill="currentColor"/></svg>'
          : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path class="dap-check-path" d="M5 12l5 5L19 7"/></svg>'
        }
      </div>
      ${particles}
    </div>
    <div class="dap-complete-title">${titleText}</div>
    <div class="dap-complete-subtitle">${subtitleText}</div>
    <div class="dap-complete-stats">
      <div class="dap-complete-row"><span>Files copied</span><span class="g">+${r.filesCopied || 0}</span></div>
      ${hasErrors ? `<div class="dap-complete-row"><span>Files failed</span><span class="r">${r.errors.length}</span></div>` : ''}
      <div class="dap-complete-row"><span>Files removed</span><span class="r">&minus;${r.filesDeleted || 0}</span></div>
      <div class="dap-complete-divider"></div>
      <div class="dap-complete-row"><span>DAP storage</span><span>${formatBytes(totalBytes - freeBytes)} / ${formatBytes(totalBytes)}</span></div>
      <div class="dap-storage-bar"><div class="dap-storage-fill" style="width:${usedPct}%"></div></div>
      <div class="dap-sum-footer-text">${formatBytes(freeBytes)} free</div>
    </div>
    ${errorReportHtml}
    <div class="dap-complete-actions">
      ${hasErrors
        ? `<button class="dap-btn-primary" id="dap-retry-btn">Retry sync</button>
           <button class="dap-btn-secondary" id="dap-done-btn" style="margin-top: 8px;">Back to albums</button>`
        : `<div class="dap-eject-msg"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 10H5l7-10z"/><line x1="5" y1="21" x2="19" y2="21"/></svg> You can safely eject your SD card</div>
           <button class="dap-btn-primary" id="dap-done-btn" style="margin-top: 16px;">Done</button>`
      }
    </div>
  `

  grid.appendChild(div)
  div.querySelector('#dap-done-btn')?.addEventListener('click', () => {
    dapSubView = 'albums'
    app.displayCurrentView()
  })
  div.querySelector('#dap-retry-btn')?.addEventListener('click', () => {
    dapSubView = 'albums'
    app.displayCurrentView()
    // Small delay to let the view render, then start sync
    setTimeout(() => startSync(), 300)
  })
}

// === SCREEN 7: DISCONNECTED ===

function renderDisconnectedView(grid) {
  const dest = getCurrentDest()
  const deviceName = dest?.name || 'Device'

  // Subtle particles (muted, slower than success screen)
  const particles = Array.from({ length: 4 }, (_, i) => {
    const angle = (i / 4) * Math.PI * 2 + (Math.random() * 0.6 - 0.3)
    const dist = 24 + Math.random() * 14
    const tx = Math.round(Math.cos(angle) * dist)
    const ty = Math.round(Math.sin(angle) * dist)
    const dur = (2.5 + Math.random() * 1.5).toFixed(1)
    const delay = (Math.random() * 3).toFixed(1)
    const size = (1.5 + Math.random() * 1).toFixed(1)
    return `<span class="dap-particle dap-particle-muted" style="--tx:${tx}px;--ty:${ty}px;--dur:${dur}s;--delay:${delay}s;width:${size}px;height:${size}px"></span>`
  }).join('')

  const div = document.createElement('div')
  div.className = 'dap-setup-center dap-fade-in'
  div.innerHTML = `
    <div class="dap-disc-icon">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="5" y="1" width="14" height="22" rx="2.5"/>
        <rect x="7" y="3" width="10" height="8" rx="1"/>
        <path d="M10 6l3 1.5-3 1.5V6z" fill="currentColor" stroke="none"/>
        <circle cx="12" cy="17" r="3.5"/>
        <circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/>
      </svg>
      <div class="dap-disc-badge">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 6L6 18"/><path d="M6 6l12 12"/>
        </svg>
      </div>
      ${particles}
    </div>
    <div class="dap-disc-title">${escapeHtml(deviceName)} disconnected</div>
    <p class="dap-disc-text">
      The destination volume is no longer available.
      <br><span class="dap-disc-path-inline">${escapeHtml(dest?.path || '/Volumes/...')}</span>
    </p>
    <p class="dap-disc-hint" id="dap-disc-hint">Insert your SD card or connect your DAP via USB, then retry.</p>
    <div class="dap-disc-status" id="dap-disc-status"></div>
    <div class="dap-disc-actions">
      <button class="dap-btn-secondary" id="dap-change-dest-btn">Change destination</button>
      <button class="dap-btn-primary" id="dap-retry-btn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></svg>
        Retry
      </button>
    </div>
  `

  grid.appendChild(div)
  div.querySelector('#dap-change-dest-btn').addEventListener('click', addDestination)
  div.querySelector('#dap-retry-btn').addEventListener('click', async () => {
    const btn = div.querySelector('#dap-retry-btn')
    const statusEl = div.querySelector('#dap-disc-status')
    const iconEl = div.querySelector('.dap-disc-icon')

    // Visual feedback: show "Checking..." state
    if (btn) { btn.disabled = true; btn.textContent = 'Checking\u2026' }
    if (statusEl) { statusEl.textContent = ''; statusEl.className = 'dap-disc-status' }

    await refreshMountedVolumes()
    const d = getCurrentDest()

    // Also try matching by volume name (macOS may remount at different path e.g. /Volumes/NAME 1)
    let matched = d && mountedVolumes.has(d.path)
    if (!matched && d && d.volumeName) {
      const byName = _externalVolumes.find(v => v.name === d.volumeName)
      if (byName) {
        console.log('[DAP] Path mismatch but volumeName matched — updating dest path:', d.path, '→', byName.path)
        // Update the destination path to the new mount point
        try {
          await invoke('dap_save_destination', { dest: { ...d, path: byName.path } })
          d.path = byName.path
          mountedVolumes.add(byName.path)
          matched = true
        } catch (e) {
          console.warn('[DAP] Failed to update dest path:', e)
        }
      }
    }

    console.log('[DAP] Retry result — dest:', d?.name, 'destPath:', d?.path, 'matched:', matched, 'mountedPaths:', Array.from(mountedVolumes), 'volumes:', _externalVolumes.map(v => v.name + ':' + v.path))

    if (matched) {
      dapSubView = 'albums'
      await loadSelections(d.id)
      app.displayCurrentView()
    } else {
      // Restore button
      if (btn) {
        btn.disabled = false
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></svg> Retry'
      }
      // INLINE status feedback (visible right on the disconnected screen)
      if (statusEl) {
        statusEl.textContent = 'Device not detected — check your connection'
        statusEl.className = 'dap-disc-status dap-disc-status-error'
      }
      // Shake the icon briefly to confirm the check happened
      if (iconEl) {
        iconEl.classList.add('dap-disc-shake')
        setTimeout(() => iconEl.classList.remove('dap-disc-shake'), 500)
      }
    }
  })
}

// === SCREEN 8: SETTINGS ===

function renderSettingsView(grid) {
  const dest = getCurrentDest()
  if (!dest) { renderSetupView(grid); return }

  const div = document.createElement('div')
  div.className = 'dap-content dap-fade-in'

  const folderOptions = [
    ['artist_album_track', 'Artist / Album / Track'],
    ['albumartist_album_track', 'Album Artist / Album / Track'],
    ['genre_artist_album_track', 'Genre / Artist / Album / Track'],
    ['flat', 'Flat'],
  ]

  const currentFolder = dest.folderStructure || 'artist_album_track'
  const currentFolderLabel = folderOptions.find(o => o[0] === currentFolder)?.[1] || currentFolder

  div.innerHTML = `
    <div class="dap-settings-header">
      <button class="btn-back-nav" id="dap-settings-back" title="Back">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 12H5"/>
          <path d="M12 19l-7-7 7-7"/>
        </svg>
      </button>
      <div>
        <div class="dap-settings-title">DAP Sync Settings</div>
        <div class="dap-settings-subtitle">Configure sync for ${escapeHtml(dest.name)}</div>
      </div>
    </div>
    <div class="dap-set-row">
      <div><div class="dap-set-label">Destination folder</div><div class="dap-set-desc">${escapeHtml(dest.path)}</div></div>
      <div class="dap-set-val" id="dap-settings-change-dest">Change...</div>
    </div>
    <div class="dap-set-row">
      <div><div class="dap-set-label">Folder structure</div><div class="dap-set-desc">How files are organized on your DAP</div></div>
      <select class="dap-set-select" id="dap-settings-folder">
        ${folderOptions.map(([v, l]) => `<option value="${v}" ${v === currentFolder ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    <div class="dap-set-row">
      <div><div class="dap-set-label">Sync mirror mode</div><div class="dap-set-desc">Remove files from DAP when deselected</div></div>
      <div class="dap-toggle ${dest.mirrorMode !== false ? 'on' : ''}" id="dap-settings-mirror"></div>
    </div>
    <div class="dap-set-row">
      <div><div class="dap-set-label">Show DAP Sync in sidebar</div><div class="dap-set-desc">Display the DAP Sync section</div></div>
      <div class="dap-toggle ${dest.showInSidebar !== false ? 'on' : ''}" id="dap-settings-sidebar"></div>
    </div>
    <div class="dap-set-row last">
      <div><div class="dap-set-label">Last sync</div><div class="dap-set-desc">${dest.lastSyncAt ? new Date(dest.lastSyncAt).toLocaleString() : 'Never'}</div></div>
    </div>
  `

  grid.appendChild(div)

  // Wire events
  div.querySelector('#dap-settings-change-dest').addEventListener('click', addDestination)
  div.querySelector('#dap-settings-folder').addEventListener('change', async (e) => {
    dest.folderStructure = e.target.value
    await saveDestSettings(dest)
  })
  div.querySelector('#dap-settings-mirror').addEventListener('click', async function () {
    this.classList.toggle('on')
    dest.mirrorMode = this.classList.contains('on')
    await saveDestSettings(dest)
  })
  div.querySelector('#dap-settings-sidebar').addEventListener('click', async function () {
    this.classList.toggle('on')
    dest.showInSidebar = this.classList.contains('on')
    await saveDestSettings(dest)
  })
  div.querySelector('#dap-settings-back').addEventListener('click', () => {
    dapSubView = 'albums'
    app.displayCurrentView()
  })
}

// === SCREEN 8: SYNC ERROR ===

function renderErrorView(grid) {
  const dest = getCurrentDest()
  const deviceName = dest?.name || 'Device'
  const r = syncResult || {}
  const errorList = r.errors || []

  // Separate the abort message from individual file errors
  const abortMsg = errorList.find(e => e.startsWith('Aborting:') || e.startsWith('Destination not writable'))
  const fileErrors = errorList.filter(e => !e.startsWith('Aborting:') && !e.startsWith('Destination not writable'))

  const div = document.createElement('div')
  div.className = 'dap-setup-center dap-fade-in'

  div.innerHTML = `
    <div class="dap-error-icon">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="5" y="1" width="14" height="22" rx="2.5"/>
        <rect x="7" y="3" width="10" height="8" rx="1"/>
        <path d="M10 6l3 1.5-3 1.5V6z" fill="currentColor" stroke="none"/>
        <circle cx="12" cy="17" r="3.5"/>
        <circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/>
      </svg>
      <div class="dap-error-badge">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 8v4"/><circle cx="12" cy="16" r="0.5" fill="currentColor"/>
        </svg>
      </div>
    </div>
    <div class="dap-error-title">Sync failed</div>
    <div class="dap-error-subtitle">${r.filesCopied > 0 ? `${r.filesCopied} files copied before failure` : 'No files were copied'}</div>
    ${abortMsg ? `<div class="dap-error-reason">${escapeHtml(abortMsg)}</div>` : ''}
    ${fileErrors.length > 0 ? `
      <div class="dap-error-details">
        <div class="dap-error-details-header">${fileErrors.length} error${fileErrors.length > 1 ? 's' : ''}</div>
        <textarea class="dap-error-textarea" readonly rows="6" spellcheck="false">${fileErrors.join('\n')}</textarea>
      </div>
    ` : ''}
    <div class="dap-error-actions">
      <button class="dap-btn-secondary" id="dap-error-back-btn">Back to albums</button>
      <button class="dap-btn-primary" id="dap-error-retry-btn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></svg>
        Retry sync
      </button>
    </div>
  `

  grid.appendChild(div)
  div.querySelector('#dap-error-back-btn').addEventListener('click', () => {
    dapSubView = 'albums'
    app.displayCurrentView()
  })
  div.querySelector('#dap-error-retry-btn').addEventListener('click', () => {
    startSync()
  })
}

// === SCREEN 6: FIRST SYNC ===

function renderFirstSyncView(grid) {
  const div = document.createElement('div')
  div.className = 'dap-first-sync dap-fade-in'

  div.innerHTML = `
    <div class="dap-warn-box">
      <div class="dap-warn-title">&#9888; Existing music detected on your DAP</div>
      <div class="dap-warn-text">Your DAP already contains audio files that were not synced by Hean. Since sync mirror mode is enabled, files not in your selection would normally be deleted.</div>
    </div>
    <div class="dap-first-sync-question">What would you like to do?</div>
    <div class="dap-radio-group">
      <div class="dap-radio-opt" data-value="keep">
        <div class="dap-radio-circle"></div>
        <div><div class="dap-r-label">Keep existing files</div><div class="dap-r-desc">Hean will adopt existing files and only add new ones. Nothing will be deleted.</div></div>
      </div>
      <div class="dap-radio-opt sel" data-value="replace">
        <div class="dap-radio-circle"></div>
        <div><div class="dap-r-label">Replace everything <span class="dap-rec-tag">Recommended</span></div><div class="dap-r-desc">Files not in your selection will be permanently deleted. Your DAP will mirror your selection.</div></div>
      </div>
    </div>
    <div class="dap-first-sync-actions">
      <button class="dap-btn-secondary" id="dap-first-cancel">Cancel</button>
      <button class="dap-btn-primary" id="dap-first-continue">Continue</button>
    </div>
  `

  grid.appendChild(div)

  div.querySelectorAll('.dap-radio-opt').forEach(opt => {
    opt.addEventListener('click', () => {
      div.querySelectorAll('.dap-radio-opt').forEach(o => o.classList.remove('sel'))
      opt.classList.add('sel')
    })
  })

  div.querySelector('#dap-first-cancel').addEventListener('click', closeSyncPanel)
  div.querySelector('#dap-first-continue').addEventListener('click', () => {
    dapSubView = 'albums'
    app.displayCurrentView()
  })
}

// === DATA HELPERS ===

async function loadSelections(destId) {
  selectedAlbums.clear()
  _needsOnDapPreselection = true
  try {
    const selections = await invoke('dap_get_selections', { destinationId: destId })
    if (selections && selections.length > 0) {
      // Use saved selections from DB
      for (const sel of selections) {
        if (sel.selected) selectedAlbums.add(sel.albumId)
      }
      _needsOnDapPreselection = false
    } else {
      // No selections saved yet (first sync) — select ALL albums
      // _needsOnDapPreselection stays true for auto-deselection after first plan
      for (const albumKey of Object.keys(library.albums)) {
        selectedAlbums.add(albumKeyToId(albumKey))
      }
    }
  } catch (e) {
    console.error('[DAP] Failed to load selections (will auto-detect from DAP):', e)
    // Fallback: select all albums
    for (const albumKey of Object.keys(library.albums)) {
      selectedAlbums.add(albumKeyToId(albumKey))
    }
  }
}

function saveSelections() {
  clearTimeout(_saveSelectionsTimer)
  _saveSelectionsTimer = setTimeout(() => _doSaveSelections(), 800)
}

async function _doSaveSelections() {
  if (!currentDestinationId) return
  const allAlbumIds = Object.keys(library.albums).map(k => albumKeyToId(k))
  const selections = allAlbumIds.map(id => [id, selectedAlbums.has(id)])
  try {
    await invoke('dap_save_selections_batch', { destinationId: currentDestinationId, selections })
  } catch (e) {
    console.error('[DAP] Failed to save selections:', e)
  }
}

function buildTracksForSync() {
  const tracks = []
  let estimatedCount = 0
  for (const albumKey of Object.keys(library.albums)) {
    const albumId = albumKeyToId(albumKey)
    if (!selectedAlbums.has(albumId)) continue
    const album = library.albums[albumKey]
    for (const track of album.tracks) {
      const meta = track.metadata || {}
      const hasFileSize = !!meta.fileSize
      if (!hasFileSize) estimatedCount++
      tracks.push({
        path: track.path,
        title: meta.title || track.name || 'Unknown',
        artist: meta.artist || null,
        album: meta.album || null,
        albumArtist: null,
        genre: meta.genre || null,
        trackNumber: meta.track || null,
        discNumber: meta.disc || null,
        sizeBytes: meta.fileSize || estimateFileSize(meta),
        modifiedAt: '2026-01-01T00:00:00Z',
        albumId: albumId,
      })
    }
  }
  return tracks
}

function estimateFileSize(meta) {
  if (!meta?.duration) return 0
  if (meta.bitrate && meta.bitrate > 0) return Math.round(meta.duration * meta.bitrate / 8)
  const sr = meta.sampleRate || 44100
  const bd = meta.bitDepth || 16
  const rawPcmBytes = Math.round(meta.duration * sr * bd * 2 / 8)
  // Lossless formats (FLAC, ALAC) compress to ~60-65% of raw PCM
  const ext = (meta.format || meta.codec || meta.path || '').toLowerCase()
  if (ext.includes('flac') || ext.includes('alac') || ext.includes('ape')) {
    return Math.round(rawPcmBytes * 0.65)
  }
  return rawPcmBytes
}

async function saveDestSettings(dest) {
  try {
    await invoke('dap_save_destination', { dest })
  } catch (e) {
    console.error('[DAP] Failed to save settings:', e)
  }
}

// === SYNC EXECUTION ===

async function startSync() {
  if (isSyncing) return
  const dest = getCurrentDest()
  if (!dest) return

  isSyncing = true
  syncProgress = { phase: 'prepare', current: 0, total: 0, currentFile: '', bytesCopied: 0, totalBytes: 0 }

  const tracksForSync = buildTracksForSync()
  const folderStructure = dest.folderStructure || 'artist_album_track'
  const mirrorMode = dest.mirrorMode !== false

  // Switch to syncing view
  dapSubView = 'syncing'
  renderSidebarDestinations()
  app.displayCurrentView()

  try {
    if (dest.path.startsWith('mtp://')) {
      // MTP sync: build file list from sync plan and use MTP-specific command
      const plan = syncPlan
      const hasFilesToCopy = plan && plan.filesToCopy && plan.filesToCopy.length > 0
      const hasFilesToDelete = plan && plan.filesToDelete && plan.filesToDelete.length > 0

      if (!hasFilesToCopy && !hasFilesToDelete) {
        showToast('Nothing to sync')
        isSyncing = false
        dapSubView = 'albums'
        app.displayCurrentView()
        return
      }
      // Parse storage index from mtp://serial/index
      const parts = dest.path.replace('mtp://', '').split('/')
      const storageIndex = parseInt(parts[1]) || 1

      // Build file pairs: (resolved_source_path, dest_relative_path)
      const files = hasFilesToCopy ? plan.filesToCopy.map(f => [f.sourcePath, f.destRelativePath]) : []
      // Build delete list: dest_relative_paths to remove from device
      const filesToDelete = hasFilesToDelete ? plan.filesToDelete.map(f => f.destRelativePath) : []

      await invoke('dap_execute_mtp_sync', {
        files,
        filesToDelete,
        storageIndex,
        destPath: dest.path,
        folderStructure,
      })
    } else {
      // Mass storage sync (filesystem-based)
      await invoke('dap_execute_sync', {
        tracks: tracksForSync,
        destPath: dest.path,
        folderStructure,
        mirrorMode,
      })
    }
  } catch (e) {
    showToast(`Sync error: ${e}`, 'error')
    isSyncing = false
    dapSubView = 'albums'
    renderSidebarDestinations()
    app.displayCurrentView()
  }
}

function cancelSync() {
  // Send cancel to Rust (sets the atomic flag — sync thread will stop at next check point)
  invoke('dap_cancel_sync').catch(() => {})

  // Return to albums view IMMEDIATELY — don't wait for Rust to confirm.
  // The Rust sync thread may be blocked on SMB read or exFAT write for up to 60s.
  // It will eventually see the cancel flag, clean up, and emit dap_sync_complete.
  // We handle the UI transition here so the user is never stuck.
  isSyncing = false
  dapSubView = 'albums'
  showToast('Sync cancelled — cleanup in progress', 'warning')
  if (ui.currentView === 'dap-sync') {
    app.displayCurrentView()
  }
}

// === EVENT LISTENERS ===

function setupEventListeners() {
  listen('volume_change', () => {
    // During MTP sync, skip volume refresh — it can trigger detectMtpDevices()
    // which competes for exclusive USB access and disconnects the DAP.
    if (isSyncing) {
      console.log('[DAP] Skipping volume_change — sync in progress')
      return
    }
    refreshMountedVolumes()
    // USB plug/unplug may also affect MTP devices
    detectMtpDevices()
  })

  let _progressRafPending = false
  listen('dap_sync_progress', (event) => {
    const p = event.payload
    syncProgress = {
      phase: p.phase || syncProgress.phase,
      current: p.current || 0,
      total: p.total || 0,
      currentFile: p.currentFile || '',
      bytesCopied: p.bytesCopied || 0,
      totalBytes: p.totalBytes || 0,
    }

    // Throttle DOM updates to once per animation frame (avoids flooding the main thread
    // during large syncs — hundreds of events/sec would block scroll on other views)
    if (ui.currentView === 'dap-sync' && dapSubView === 'syncing' && !_progressRafPending) {
      _progressRafPending = true
      requestAnimationFrame(() => {
        _progressRafPending = false
        updateSyncingProgress()
      })
    }
  })

  // MTP wave complete: planned USB replug required between waves
  // Shows a BLOCKING full-screen modal — the user MUST unplug/replug to continue.
  // Without a physical USB reset, the DAP firmware will crash.
  listen('mtp_wave_complete', (event) => {
    const p = event.payload
    const fillEl = document.querySelector('.dap-prog-fill')
    if (fillEl) fillEl.classList.add('dap-prog-pulse')
    showWaveBreakModal(p.waveNum, p.totalWaves, p.filesCopied, p.filesRemaining)
  })

  // MTP wave: device was unplugged, waiting for replug
  listen('mtp_wave_unplugged', () => {
    updateWaveBreakModal('unplugged')
  })

  // MTP wave resuming: device replugged, next wave starting
  listen('mtp_wave_resuming', (event) => {
    const p = event.payload
    const fillEl = document.querySelector('.dap-prog-fill')
    if (fillEl) fillEl.classList.remove('dap-prog-pulse')
    dismissWaveBreakModal()
    showToast(`Wave ${p.waveNum} starting — ${p.filesRemaining} files remaining`, 'success')
  })

  // MTP wave timeout: user never unplugged, sync aborted
  listen('mtp_wave_timeout', () => {
    dismissWaveBreakModal()
    showToast('Sync paused — unplug/replug your DAP and restart to continue', 'warning')
  })

  // MTP needs replug: emergency — firmware crashed mid-wave, user must unplug/replug
  // Reuses the wave break modal for consistent blocking UX
  listen('mtp_needs_replug', (event) => {
    const p = event.payload
    const fillEl = document.querySelector('.dap-prog-fill')
    if (fillEl) fillEl.classList.add('dap-prog-pulse')
    // Show the same blocking modal — emergency replug is just as critical as a wave break
    showWaveBreakModal(0, 0, p.filesCopied, p.filesRemaining)
    // Override the title for emergency context
    const title = document.querySelector('.dap-wave-title')
    const subtitle = document.querySelector('.dap-wave-subtitle')
    if (title) title.textContent = 'DAP needs a reset'
    if (subtitle) subtitle.textContent = `Firmware stalled after ${p.filesCopied} files`
  })

  // MTP replug detected: device is back after emergency replug
  listen('mtp_replug_detected', (event) => {
    const p = event.payload
    const fillEl = document.querySelector('.dap-prog-fill')
    if (fillEl) fillEl.classList.remove('dap-prog-pulse')
    dismissWaveBreakModal()
    showToast(`DAP reconnected — ${p.filesRemaining} files remaining`, 'success')
  })

  listen('dap_sync_complete', async (event) => {
    const c = event.payload
    isSyncing = false
    syncResult = c
    // Always dismiss the wave break / replug modal — sync is done
    dismissWaveBreakModal()
    renderSidebarDestinations()

    if (c.errors?.length > 0 && c.errors[0].includes('cancelled')) {
      // Cancel already handled by cancelSync() — just update state silently
      dapSubView = 'albums'
    } else if (c.success) {
      // Perfect sync — no errors at all
      dapSubView = 'complete'
      await refreshMountedVolumes()
      // Recompute sync plan so badges reflect the new state (manifest updated by Rust)
      await computeAndRenderSummary()
    } else if (c.filesCopied > 0) {
      // Partial success — some files copied, some errors
      // Show complete screen (files were synced) but with error report
      dapSubView = 'complete'
      await refreshMountedVolumes()
      // Recompute sync plan so badges reflect the new state
      await computeAndRenderSummary()
    } else {
      // Total failure — no files copied
      dapSubView = 'error'
    }

    if (ui.currentView === 'dap-sync') {
      app.displayCurrentView()
    }
  })
}

function updateSyncingProgress() {
  const p = syncProgress
  const fillEl = document.querySelector('.dap-prog-fill')
  const statsEl = document.querySelector('.dap-prog-stats')
  const fileEl = document.querySelector('.dap-prog-file')
  const phaseTextEl = document.querySelector('.dap-phase-text')

  const pct = p.total > 0 ? (p.current / p.total * 100).toFixed(1) : 0

  if (fillEl) fillEl.style.width = `${pct}%`
  if (statsEl) statsEl.innerHTML = `<span>${p.current} / ${p.total} files</span><span>${formatBytes(p.bytesCopied)} / ${formatBytes(p.totalBytes)}</span>`
  if (fileEl) fileEl.textContent = p.currentFile || ''

  // Update phase label
  const phaseLabel = p.phase === 'copy' ? 'Copying files' : p.phase === 'delete' ? 'Removing files' : 'Preparing'
  if (phaseTextEl) phaseTextEl.textContent = phaseLabel
}

// === SIDEBAR HEADER TOGGLE ===

function initSidebarToggle() {
  const header = document.getElementById('dap-sync-header-toggle')
  if (!header) return

  header.addEventListener('click', () => {
    header.classList.toggle('open')
    const isOpen = header.classList.contains('open')
    const list = document.getElementById('dap-sync-destinations')
    if (list) list.style.display = isOpen ? '' : 'none'
    const mtpList = document.getElementById('dap-mtp-devices')
    if (mtpList) mtpList.style.display = isOpen ? '' : 'none'
    sidebarCollapsed = !isOpen
  })
}

// === INIT ===

export async function initDapSync() {
  invoke('dap_start_volume_watcher').catch((e) => console.warn('[DAP] Volume watcher:', e))
  await loadDestinations()
  await refreshMountedVolumes()
  setupEventListeners()
  initSidebarToggle()
  // Detect MTP devices (DAPs connected via USB)
  detectMtpDevices()
  startMtpPolling()

  // Startup retry: volumes and MTP devices often aren't visible immediately at app launch.
  // diskutil may not have indexed freshly mounted SD cards yet, and ptpcamerad may still
  // be claiming the MTP device on the first attempt. Retry after 3s and 8s to catch them.
  setTimeout(async () => {
    const hadVolumes = mountedVolumes.size > 0
    const hadMtp = mtpDevices.length > 0
    await refreshMountedVolumes()
    if (!hadMtp) await detectMtpDevices()
    if (!hadVolumes && mountedVolumes.size > 0) {
      console.log('[DAP] Startup retry (3s): found volumes after delayed scan')
    }
  }, 3000)
  setTimeout(async () => {
    const hadVolumes = mountedVolumes.size > 0
    const hadMtp = mtpDevices.length > 0
    await refreshMountedVolumes()
    if (!hadMtp) await detectMtpDevices()
    if ((!hadVolumes && mountedVolumes.size > 0) || (!hadMtp && mtpDevices.length > 0)) {
      console.log('[DAP] Startup retry (8s): found devices after delayed scan')
    }
  }, 8000)
}

// === MTP DEVICE DETECTION ===
let mtpDevices = []
let mtpExpanded = new Set() // serials of expanded MTP devices in sidebar
let _mtpPollingInterval = null
let _mtpDetecting = false // race guard — prevents concurrent detectMtpDevices calls
let _mtpBackoffUntil = 0 // timestamp — suppress polling after sync errors
let _mtpConsecutiveFailures = 0 // consecutive detection failures — grace period before "disconnected"
const MTP_DISCONNECT_THRESHOLD = 3 // require 3 consecutive failures (30s at 10s poll) before declaring disconnected

function startMtpPolling() {
  if (_mtpPollingInterval) clearInterval(_mtpPollingInterval)
  _mtpPollingInterval = setInterval(() => detectMtpDevices(), 10000) // 10s
}

function mtpBackoff(durationMs = 30000) {
  _mtpBackoffUntil = Date.now() + durationMs
  _mtpConsecutiveFailures = 0
}

/** Get a human-readable name for an MTP destination.
 *  mtp://serial/0 → "FiiO JM21 / Internal Storage"
 *  mtp://serial/1 → "FiiO JM21 / Micro SD"
 */
function getMtpDisplayName(dest) {
  if (!dest || !dest.path || !dest.path.startsWith('mtp://')) return null
  // Find the MTP device that matches this destination
  const parts = dest.path.replace('mtp://', '').split('/')
  const serial = parts[0]
  const storageIdx = parseInt(parts[1] || '0', 10)
  const device = mtpDevices.find(d => d.serial === serial)
  if (!device) return dest.name || dest.path
  const storage = device.storages[storageIdx]
  const storageName = storage
    ? (storage.description || (storageIdx === 0 ? 'Internal Storage' : 'Micro SD'))
    : (storageIdx === 0 ? 'Internal Storage' : 'Micro SD')
  return `${device.model} — ${storageName}`
}

async function detectMtpDevices() {
  // Race guard — only one detection at a time
  if (_mtpDetecting) return
  // Back-off after sync errors (MTP Transaction ID mismatch needs time to recover)
  if (Date.now() < _mtpBackoffUntil) return
  _mtpDetecting = true
  try {
    const previousSerials = new Set(mtpDevices.map(d => d.serial))
    const result = await invoke('dap_detect_mtp_devices')

    if (result.length > 0) {
      // Device detected — reset failure counter, update devices
      _mtpConsecutiveFailures = 0
      _mtpBackoffUntil = 0
      mtpDevices = result
    } else {
      // No device found — increment failure counter but DON'T clear mtpDevices yet
      _mtpConsecutiveFailures++
      if (_mtpConsecutiveFailures < MTP_DISCONNECT_THRESHOLD) {
        // Grace period: keep previous devices in memory, don't update UI
        // This prevents transient USB glitches (post-sync recovery, ptpcamerad) from showing "disconnected"
        console.log(`[MTP] Detection empty (attempt ${_mtpConsecutiveFailures}/${MTP_DISCONNECT_THRESHOLD}) — keeping previous state`)
        return
      }
      // Threshold reached: NOW declare disconnected
      console.log(`[MTP] ${MTP_DISCONNECT_THRESHOLD} consecutive failures — declaring disconnected`)
      mtpDevices = []
    }

    const currentSerials = new Set(mtpDevices.map(d => d.serial))

    // Only re-render sidebar if devices changed
    const changed = previousSerials.size !== currentSerials.size
      || [...previousSerials].some(s => !currentSerials.has(s))
      || [...currentSerials].some(s => !previousSerials.has(s))
    if (changed) {
      console.log('[MTP] Devices changed:', mtpDevices.map(d => d.model).join(', ') || 'none')
      renderMtpSidebar()

      // Remove MTP paths from mountedVolumes for disconnected devices
      for (const serial of previousSerials) {
        if (!currentSerials.has(serial)) {
          for (const p of [...mountedVolumes]) {
            if (p.startsWith(`mtp://${serial}/`)) {
              mountedVolumes.delete(p)
            }
          }
        }
      }

      // If current destination is an MTP device that disappeared, show disconnected
      if (currentDestinationId) {
        const dest = getCurrentDest()
        if (dest?.path?.startsWith('mtp://') && !mountedVolumes.has(dest.path)) {
          if (ui.currentView === 'dap-sync' && dapSubView !== 'syncing') {
            renderSidebarDestinations()
            app.displayCurrentView()
          }
        }
      }
    }
  } catch (e) {
    console.warn('[MTP] Detection failed:', e)
    _mtpConsecutiveFailures++
    if (_mtpConsecutiveFailures >= MTP_DISCONNECT_THRESHOLD) {
      mtpDevices = []
      renderMtpSidebar()
    }
  } finally {
    _mtpDetecting = false
  }
}

function getStorageIcon(description) {
  const lower = (description || '').toLowerCase()
  if (lower.includes('sd') || lower.includes('micro') || lower.includes('card') || lower.includes('externe')) {
    // SD card icon
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="4" y="2" width="16" height="20" rx="2"/>
      <path d="M8 2v6"/><path d="M12 2v6"/><path d="M16 2v6"/>
    </svg>`
  }
  // Internal storage icon (DAP device)
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
    <line x1="12" y1="18" x2="12.01" y2="18"/>
  </svg>`
}

function getStorageDisplayName(storage, deviceModel) {
  const lower = (storage.description || '').toLowerCase()
  if (lower.includes('sd') || lower.includes('micro') || lower.includes('card') || lower.includes('externe')) {
    return 'Micro SD'
  }
  if (lower.includes('intern') || lower.includes('partag')) {
    return 'Internal Storage'
  }
  return storage.description || 'Storage'
}

function renderMtpSidebar() {
  const container = document.getElementById('dap-mtp-devices')
  if (!container) return
  container.innerHTML = ''

  if (mtpDevices.length === 0) return

  for (const device of mtpDevices) {
    const isExpanded = mtpExpanded.has(device.serial)

    // --- PARENT ITEM (device name + MTP badge + chevron) ---
    const parent = document.createElement('div')
    parent.className = 'sb-dap-device sb-mtp-device sb-mtp-parent'
    parent.innerHTML = `
      <div class="dev-icon" style="color: #4ade80">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
          <line x1="12" y1="18" x2="12.01" y2="18"/>
          <path d="M9 6h6"/>
        </svg>
      </div>
      <div class="dev-info">
        <div class="dev-name">${escapeHtml(device.model)}</div>
        <div class="dev-space"><span class="mtp-badge">MTP</span></div>
      </div>
      <span class="sb-mtp-chevron${isExpanded ? ' open' : ''}">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 6l6 6-6 6"/>
        </svg>
      </span>
    `
    parent.addEventListener('click', () => {
      if (mtpExpanded.has(device.serial)) {
        mtpExpanded.delete(device.serial)
      } else {
        mtpExpanded.add(device.serial)
      }
      renderMtpSidebar()
    })
    container.appendChild(parent)

    // --- SUB-ITEMS (one per storage, only if expanded) ---
    if (isExpanded) {
      const storageList = document.createElement('div')
      storageList.className = 'sb-mtp-storages'

      device.storages.forEach((storage, idx) => {
        const mtpPath = `mtp://${device.serial}/${idx}`
        const isActive = destinations.some(d => d.path === mtpPath && d.id === currentDestinationId)
          && ui.currentView === 'dap-sync'
        const freeLabel = storage.freeBytes > 0 ? formatBytes(storage.freeBytes) + ' free' : ''

        const sub = document.createElement('div')
        sub.className = 'sb-dap-device sb-mtp-storage' + (isActive ? ' active' : '')
        sub.innerHTML = `
          <div class="dev-icon sb-mtp-storage-icon" style="color: #4ade80">
            ${getStorageIcon(storage.description)}
          </div>
          <div class="dev-info">
            <div class="dev-name">${escapeHtml(getStorageDisplayName(storage, device.model))}</div>
            <div class="dev-space">${freeLabel}</div>
          </div>
        `
        sub.addEventListener('click', (e) => {
          e.stopPropagation()
          openMtpSyncPanel(device, idx)
        })
        storageList.appendChild(sub)
      })

      container.appendChild(storageList)
    }
  }
}

// === MTP SYNC PANEL ===

let currentMtpDevice = null

async function openMtpSyncPanel(device, storageIndex) {
  currentMtpDevice = device

  // Use explicit index if provided, otherwise fallback to SD auto-detection
  let idx = storageIndex
  if (idx === undefined) {
    const sdStorage = device.storages.find(s => s.description.toLowerCase().includes('sd'))
      || device.storages[device.storages.length - 1]
    idx = device.storages.indexOf(sdStorage)
  }

  // Create or find a destination for this MTP device + storage
  const mtpPath = `mtp://${device.serial}/${idx}`
  let dest = destinations.find(d => d.path === mtpPath)

  if (!dest) {
    // Create new destination in DB with storage-specific name
    const storageName = getStorageDisplayName(device.storages[idx], device.model)
    try {
      await invoke('dap_save_destination', {
        dest: {
          id: null,
          name: `${device.model} — ${storageName}`,
          path: mtpPath,
          volumeName: device.model,
          folderStructure: 'artist_album_track',
          mirrorMode: true,
          showInSidebar: true,
          lastSyncAt: null,
          lastSyncAlbumsCount: null,
          lastSyncSizeBytes: null
        }
      })
      await loadDestinations()
      dest = destinations.find(d => d.path === mtpPath)
    } catch (e) {
      console.error('[MTP] Failed to create destination:', e)
      showToast('Failed to setup MTP device')
      return
    }
  }

  if (!dest) {
    showToast('Failed to find MTP destination')
    return
  }

  // Mark MTP path as "mounted" so openSyncPanel doesn't show disconnected screen
  mountedVolumes.add(mtpPath)

  // Open the standard sync panel
  openSyncPanel(dest)

  // Re-render sidebar to reflect active sub-item
  renderMtpSidebar()
}

// === DAP SYNC MODAL (Sync Now / Sync Later confirmation) ===

let _dapModalAbort = null

function getDapDestinationName() {
  return getCurrentDest()?.name || 'DAP'
}

function showDapSyncModal({ albumKeys, artistName }) {
  // Remove any existing modal
  const existing = document.getElementById('dap-sync-modal')
  if (existing) existing.remove()
  if (_dapModalAbort) { _dapModalAbort.abort(); _dapModalAbort = null }

  const mounted = getMountedDestinations()
  if (mounted.length === 0) {
    showToast('No DAP device connected')
    return
  }

  // Default to current dest, or first mounted
  let selectedDestId = (currentDestinationId && mounted.find(d => d.id === currentDestinationId))
    ? currentDestinationId
    : mounted[0].id

  // Determine action (add/remove) based on current selection state for the selected dest
  function getActionForDest(destId) {
    if (destId === currentDestinationId) {
      const albumIds = albumKeys.map(k => albumKeyToId(k))
      const allSelected = albumIds.every(id => selectedAlbums.has(id))
      return allSelected ? 'remove' : 'add'
    }
    return 'add'
  }

  let action = getActionForDest(selectedDestId)

  // Build content info (what's being synced)
  function buildContentInfo() {
    if (artistName) {
      const count = albumKeys.length
      return { label: artistName, sub: `${count} album${count > 1 ? 's' : ''}` }
    } else if (albumKeys.length === 1) {
      const album = library.albums[albumKeys[0]]
      const artistLabel = album?.artist || ''
      return { label: album?.album || 'Album', sub: artistLabel }
    } else {
      return { label: `${albumKeys.length} albums`, sub: '' }
    }
  }

  // Destination selector — NAS-discovery-inspired cards
  const showDestSelector = mounted.length > 1
  function buildDestSelectorHtml() {
    if (!showDestSelector) return ''
    return `
      <div class="dap-modal-section-label">Destination</div>
      <div class="dap-modal-dest-list">
        ${mounted.map(d => {
          const freeLabel = d._freeBytes ? formatBytes(d._freeBytes) + ' free' : ''
          return `
          <div class="dap-modal-dest-card${d.id === selectedDestId ? ' active' : ''}" data-dest-id="${d.id}">
            <div class="dap-modal-dest-card-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="5" y="1" width="14" height="22" rx="2.5"/>
                <rect x="7" y="3" width="10" height="8" rx="1"/>
                <circle cx="12" cy="17" r="3.5"/>
                <circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/>
              </svg>
            </div>
            <div class="dap-modal-dest-card-info">
              <div class="dap-modal-dest-card-name">${escapeHtml(d.name)}</div>
              ${freeLabel ? `<div class="dap-modal-dest-card-space">${freeLabel}</div>` : ''}
            </div>
            <div class="dap-modal-dest-card-check">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
          </div>`
        }).join('')}
      </div>
    `
  }

  const info = buildContentInfo()
  const title = action === 'add' ? 'Add to DAP' : 'Remove from DAP'
  const destLabel = showDestSelector ? 'Choose destination device' : ('to ' + escapeHtml(mounted[0]?.name || 'DAP'))

  // Get album cover info for artwork display
  let coverAlbumKey = albumKeys[0] || null
  const coverAlbum = coverAlbumKey ? library.albums[coverAlbumKey] : null

  const modal = document.createElement('div')
  modal.id = 'dap-sync-modal'
  modal.className = 'modal'
  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-content dap-modal-content">
      <div class="dap-modal-hero">
        <div class="dap-modal-icon-centered">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="5" y="1" width="14" height="22" rx="2.5"/>
            <rect x="7" y="3" width="10" height="8" rx="1"/>
            <path d="M10 6l3 1.5-3 1.5V6z" fill="currentColor" stroke="none"/>
            <circle cx="12" cy="17" r="3.5"/>
            <circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/>
          </svg>
          <div class="dap-modal-sync-ring">
            <svg width="72" height="72" viewBox="0 0 72 72" fill="none">
              <path d="M56 28a22 22 0 0 0-40 0" stroke="rgba(255,255,255,0.18)" stroke-width="1.5" stroke-linecap="round"/>
              <path d="M16 44a22 22 0 0 0 40 0" stroke="rgba(255,255,255,0.18)" stroke-width="1.5" stroke-linecap="round"/>
              <path d="M55 28l3-3.5M55 28l-4-2" stroke="rgba(255,255,255,0.3)" stroke-width="1.3" stroke-linecap="round"/>
              <path d="M17 44l-3 3.5M17 44l4 2" stroke="rgba(255,255,255,0.3)" stroke-width="1.3" stroke-linecap="round"/>
            </svg>
          </div>
        </div>
        <div class="dap-modal-title">${title}</div>
        <div class="dap-modal-subtitle">${destLabel}</div>
      </div>

      <div class="dap-modal-content-card">
        <div class="dap-modal-artwork" id="dap-modal-artwork-wrap">
          <svg class="dap-modal-artwork-placeholder" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none"/>
          </svg>
        </div>
        <div class="dap-modal-content-info">
          <div class="dap-modal-content-name">${escapeHtml(info.label)}</div>
          ${info.sub ? `<div class="dap-modal-content-sub">${escapeHtml(info.sub)}</div>` : ''}
        </div>
      </div>

      ${buildDestSelectorHtml()}

      <div class="dap-modal-actions">
        <button class="dap-modal-btn-secondary" data-action="sync-later">Sync Later</button>
        <button class="dap-modal-btn-primary" data-action="sync-now">
          Sync Now
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>
        </button>
      </div>
    </div>
  `
  document.body.appendChild(modal)

  // Load album artwork AFTER modal is in DOM (isConnected constraint)
  if (coverAlbum?.coverPath && app.loadThumbnailAsync) {
    const artworkWrap = modal.querySelector('#dap-modal-artwork-wrap')
    if (artworkWrap) {
      const img = document.createElement('img')
      img.className = 'dap-modal-artwork-img'
      img.style.display = 'none'
      artworkWrap.appendChild(img)
      app.loadThumbnailAsync(coverAlbum.coverPath, img, coverAlbum.artist, coverAlbum.album).then(() => {
        if (img.src) {
          img.style.display = ''
          const placeholder = artworkWrap.querySelector('.dap-modal-artwork-placeholder')
          if (placeholder) placeholder.style.display = 'none'
        }
      })
    }
  }

  _dapModalAbort = new AbortController()
  const { signal } = _dapModalAbort

  function closeModal() {
    modal.remove()
    if (_dapModalAbort) { _dapModalAbort.abort(); _dapModalAbort = null }
  }

  function updateModalUI() {
    const titleEl = modal.querySelector('.dap-modal-title')
    if (titleEl) titleEl.textContent = action === 'add' ? 'Add to DAP' : 'Remove from DAP'
  }

  // Destination card selection handlers
  if (showDestSelector) {
    for (const card of modal.querySelectorAll('.dap-modal-dest-card')) {
      card.addEventListener('click', () => {
        selectedDestId = Number(card.dataset.destId)
        action = getActionForDest(selectedDestId)
        modal.querySelectorAll('.dap-modal-dest-card').forEach(c => c.classList.remove('active'))
        card.classList.add('active')
        updateModalUI()
      }, { signal })
    }
  }

  async function performAction(syncNow) {
    closeModal()
    await toggleAlbumsOnDest(albumKeys, selectedDestId, action)
    if (syncNow) {
      const dest = destinations.find(d => d.id === selectedDestId)
      if (dest) {
        currentDestinationId = dest.id
        await loadSelections(dest.id)
        dapSubView = 'albums'
        navigateToDapSync()
        startSync()
      }
    } else {
      showToast(action === 'add' ? 'Added to DAP sync' : 'Removed from DAP sync')
    }
  }

  modal.querySelector('[data-action="sync-later"]').addEventListener('click', () => {
    performAction(false)
  }, { signal })

  modal.querySelector('[data-action="sync-now"]').addEventListener('click', () => {
    performAction(true)
  }, { signal })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal()
  }, { signal })

  modal.addEventListener('mousedown', (e) => {
    if (e.target === modal || e.target.classList.contains('modal-backdrop')) closeModal()
  }, { signal })
}

// === EXPORTS ===
export { openSyncPanel, closeSyncPanel, loadDestinations, refreshMountedVolumes, hideDapTopBar, renderSidebarDestinations, hasDapDestination, getMountedDestinations, isAlbumSelectedForDap, isArtistFullySelectedForDap, toggleAlbumDapSelection, toggleArtistDapSelection, toggleAlbumsOnDest, showDapSyncModal, getDapDestinationName, startSync }
