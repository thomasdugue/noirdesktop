// dap-sync.js — DAP Sync module (SD Card / USB synchronization)
// Renders views into #albums-grid via the view system (views.js switchView).
// Manages sidebar device list, sub-views: setup, albums, syncing, complete, disconnected, settings.

import { invoke, listen } from './state.js'
import { library, ui, dom } from './state.js'
import { app } from './app.js'
import { showToast } from './utils.js'
import { formatQuality } from './utils.js'

// === LOCAL STATE ===

let destinations = []
let currentDestinationId = null
let selectedAlbums = new Set()
let syncPlan = null
let isSyncing = false
let mountedVolumes = new Set()
let dapSubView = 'setup' // setup | albums | syncing | complete | disconnected | settings | first-sync
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

function escapeHtml(str) {
  const el = document.createElement('span')
  el.textContent = str
  return el.innerHTML
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
      <div class="sb-dap-empty">No devices configured</div>
      <button class="sb-dap-add-cta" id="dap-add-dest-cta">+ Add destination</button>
    `
    container.querySelector('#dap-add-dest-cta')?.addEventListener('click', addDestination)
    return
  }

  for (const dest of destinations) {
    const isMounted = mountedVolumes.has(dest.path)
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

}

function checkMounted(path) {
  return mountedVolumes.has(path)
}

async function refreshMountedVolumes() {
  try {
    const volumes = await invoke('dap_list_external_volumes')
    mountedVolumes.clear()
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
  console.time('[PERF] openSyncPanel TOTAL')
  currentDestinationId = dest.id
  currentTab = 'albums'
  renderSidebarDestinations()

  // If sync is in progress, go to syncing view instead of albums
  if (isSyncing) {
    dapSubView = 'syncing'
    navigateToDapSync()
    console.timeEnd('[PERF] openSyncPanel TOTAL')
    return
  }

  const isMounted = mountedVolumes.has(dest.path)
  if (!isMounted) {
    dapSubView = 'disconnected'
  } else {
    dapSubView = 'albums'
    console.time('[PERF] loadSelections')
    await loadSelections(dest.id)
    console.timeEnd('[PERF] loadSelections')
  }

  console.time('[PERF] navigateToDapSync')
  navigateToDapSync()
  console.timeEnd('[PERF] navigateToDapSync')
  console.timeEnd('[PERF] openSyncPanel TOTAL')
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
  btn.innerHTML = isSyncing ? 'Syncing\u2026' : 'Sync <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l1.5-1.5M12 20v-8m0 0l3 3m-3-3l-3 3"/><path d="M20 12l-1.5 1.5M12 4v8m0 0l-3-3m3 3l3-3"/></svg>'
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
  console.time('[PERF] renderAlbumsView TOTAL')
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
    <div class="dap-dest-bar">
      <span class="dap-dest-icon">${DAP_ICON_SVG}</span>
      <div class="dap-dest-info">
        <div class="dap-dest-path">${escapeHtml(dest.path)}</div>
        <div class="dap-dest-space">${formatBytes(freeBytes)} free / ${formatBytes(totalBytes)}</div>
        <div class="dap-storage-bar"><div class="dap-storage-fill" style="width:${usedPct}%"></div></div>
      </div>
      <button class="dap-dest-sync-btn" id="dap-sync-now-btn" ${syncDisabled ? 'disabled' : ''}>
        ${isSyncing ? 'Syncing\u2026' : 'Sync <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l1.5-1.5M12 20v-8m0 0l3 3m-3-3l-3 3"/><path d="M20 12l-1.5 1.5M12 4v8m0 0l-3-3m3 3l3-3"/></svg>'}
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

    <div class="dap-sync-tabs">
      <div class="dap-sync-tab active" data-tab="albums">Albums</div>
      <div class="dap-sync-tab" data-tab="artists">Artists</div>
      <div class="dap-sync-tab" data-tab="tracks">Tracks</div>
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
  console.time('[PERF] renderAlbumRows (initial)')
  renderAlbumRows()
  console.timeEnd('[PERF] renderAlbumRows (initial)')

  // Compute summary (also updates top bar stats)
  console.log('[PERF] Starting computeAndRenderSummary (async, will log separately)')
  computeAndRenderSummary()
  console.timeEnd('[PERF] renderAlbumsView TOTAL')

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
  console.time('[PERF] renderAlbumRows')
  const container = document.getElementById('dap-albums-list')
  if (!container) return
  container.innerHTML = ''

  const filter = albumSearchFilter.toLowerCase()
  console.time('[PERF] renderAlbumRows → sort')
  const albumKeys = sortAlbumKeys(Object.keys(library.albums))
  console.timeEnd('[PERF] renderAlbumRows → sort')

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
      console.time('[PERF] album checkbox click handler')
      if (e.target.closest('.quality-tag')) { console.timeEnd('[PERF] album checkbox click handler'); return }
      const chk = row.querySelector('.dap-chk')
      if (!chk) { console.timeEnd('[PERF] album checkbox click handler'); return }
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
      console.timeEnd('[PERF] album checkbox click handler')
      console.log('[PERF] checkbox handler done — computeAndRenderSummary will fire after 500ms debounce')
    })

    // Queue thumbnail for deferred loading
    if (album.coverPath && app.loadThumbnailAsync) {
      thumbQueue.push({ row, coverPath: album.coverPath, artist: album.artist, albumName })
    }

    fragment.appendChild(row)
  }

  console.time('[PERF] renderAlbumRows → DOM append')
  container.appendChild(fragment)
  console.timeEnd('[PERF] renderAlbumRows → DOM append')
  updateSelectAllCheckbox()

  console.log(`[PERF] renderAlbumRows: ${albumKeys.length} album keys, ${thumbQueue.length} thumbnails queued`)
  console.timeEnd('[PERF] renderAlbumRows')

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
  console.time('[PERF] computeAndRenderSummary TOTAL')
  const details = document.getElementById('dap-dest-details')
  if (!details) { console.timeEnd('[PERF] computeAndRenderSummary TOTAL'); return }

  const dest = getCurrentDest()
  if (!dest) { console.timeEnd('[PERF] computeAndRenderSummary TOTAL'); return }

  if (!mountedVolumes.has(dest.path)) {
    details.innerHTML = '<div class="dap-summary-error">Volume not mounted</div>'
    console.timeEnd('[PERF] computeAndRenderSummary TOTAL')
    return
  }

  details.innerHTML = '<div class="dap-summary-loading">Computing\u2026</div>'

  try {
    console.time('[PERF] buildTracksForSync')
    const tracksForSync = buildTracksForSync()
    console.timeEnd('[PERF] buildTracksForSync')
    console.log(`[PERF] tracksForSync: ${tracksForSync.length} tracks built`)
    const folderStructure = dest.folderStructure || 'artist_album_track'
    const mirrorMode = dest.mirrorMode !== false

    console.time('[PERF] invoke dap_compute_sync_plan (RUST IPC)')
    syncPlan = await invoke('dap_compute_sync_plan', {
      tracks: tracksForSync,
      destPath: dest.path,
      folderStructure,
      mirrorMode,
    })
    console.timeEnd('[PERF] invoke dap_compute_sync_plan (RUST IPC)')
    console.log(`[PERF] syncPlan: ${syncPlan?.filesToCopy?.length ?? 0} to copy, ${syncPlan?.coversToCopy?.length ?? 0} covers, ${syncPlan?.filesToDelete?.length ?? 0} to delete, ${syncPlan?.filesUnchanged ?? 0} unchanged`)

    // Pre-compute lookup sets for O(1) status badge checks
    console.time('[PERF] precomputeSyncPlanLookups')
    precomputeSyncPlanLookups()
    console.timeEnd('[PERF] precomputeSyncPlanLookups')

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

    console.time('[PERF] renderSummary')
    renderSummary(syncPlan, dest)
    console.timeEnd('[PERF] renderSummary')

    console.time('[PERF] updateSyncButton')
    updateSyncButton()          // Update Sync button state in dest-bar
    renderDapTopBar()           // Keep top bar in sync (hides search bar)
    console.timeEnd('[PERF] updateSyncButton')

    console.time('[PERF] updateStatusTagsInPlace')
    updateStatusTagsInPlace()   // Update status badges without full re-render
    console.timeEnd('[PERF] updateStatusTagsInPlace')
  } catch (e) {
    details.innerHTML = `<div class="dap-summary-error">${escapeHtml(String(e))}</div>`
  }
  console.timeEnd('[PERF] computeAndRenderSummary TOTAL')
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
  if (panel) panel.classList.toggle('collapsed', !detailsExpanded)
  if (btn) btn.classList.toggle('open', detailsExpanded)
}

// === SCREEN 3: SYNCING ===

function renderSyncingView(grid) {
  const dest = getCurrentDest()
  const deviceName = dest?.name || 'Device'

  const div = document.createElement('div')
  div.className = 'dap-setup-center dap-fade-in'

  const p = syncProgress
  const phaseDots = ['Prepare', 'Remove', 'Copy']
  const currentPhaseIdx = p.phase === 'copy' ? 2 : p.phase === 'delete' ? 1 : 0

  let stepperHtml = '<div class="dap-stepper">'
  phaseDots.forEach((label, i) => {
    if (i > 0) stepperHtml += '<div class="dap-step-line"></div>'
    const cls = i < currentPhaseIdx ? 'done' : i === currentPhaseIdx ? 'current' : 'pending'
    const content = i < currentPhaseIdx ? '&#10003;' : (i + 1)
    stepperHtml += `<div class="dap-step-dot ${cls}">${content}</div><span class="dap-step-label ${cls}">${label}</span>`
  })
  stepperHtml += '</div>'

  const pct = p.total > 0 ? (p.current / p.total * 100).toFixed(1) : 0

  div.innerHTML = `
    <div class="dap-trf-anim-wrap">${TRANSFORMER_SVG}</div>
    <div class="dap-syncing-label">Syncing to ${escapeHtml(deviceName)}</div>
    ${stepperHtml}
    <div class="dap-sync-progress-area">
      <div class="dap-prog-bar"><div class="dap-prog-fill" style="width:${pct}%"></div></div>
      <div class="dap-prog-stats">
        <span>${p.current} / ${p.total} files</span>
        <span>${formatBytes(p.bytesCopied)} / ${formatBytes(p.totalBytes)}</span>
      </div>
      <div class="dap-prog-file">${escapeHtml(p.currentFile || '')}</div>
      <div class="dap-prog-time">syncing...</div>
    </div>
    <button class="dap-btn-secondary" id="dap-cancel-sync-btn">Cancel sync</button>
  `

  grid.appendChild(div)
  div.querySelector('#dap-cancel-sync-btn').addEventListener('click', cancelSync)
}

// === SCREEN 4: COMPLETE ===

function renderCompleteView(grid) {
  const dest = getCurrentDest()
  const deviceName = dest?.name || 'Device'
  const r = syncResult || {}

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

  div.innerHTML = `
    <div class="dap-complete-dap-icon">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="5" y="1" width="14" height="22" rx="2.5"/>
        <rect x="7" y="3" width="10" height="8" rx="1"/>
        <path d="M10 6l3 1.5-3 1.5V6z" fill="currentColor" stroke="none"/>
        <circle cx="12" cy="17" r="3.5"/>
        <circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/>
      </svg>
      <div class="dap-check-badge">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <path class="dap-check-path" d="M5 12l5 5L19 7"/>
        </svg>
      </div>
      ${particles}
    </div>
    <div class="dap-complete-title">Sync complete</div>
    <div class="dap-complete-subtitle">All changes applied to ${escapeHtml(deviceName)}</div>
    <div class="dap-complete-stats">
      <div class="dap-complete-row"><span>Files copied</span><span class="g">+${r.filesCopied || 0}</span></div>
      <div class="dap-complete-row"><span>Files removed</span><span class="r">&minus;${r.filesDeleted || 0}</span></div>
      <div class="dap-complete-divider"></div>
      <div class="dap-complete-row"><span>DAP storage</span><span>${formatBytes(totalBytes - freeBytes)} / ${formatBytes(totalBytes)}</span></div>
      <div class="dap-storage-bar"><div class="dap-storage-fill" style="width:${usedPct}%"></div></div>
      <div class="dap-sum-footer-text">${formatBytes(freeBytes)} free</div>
    </div>
    <div class="dap-complete-actions">
      <div class="dap-eject-msg"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 10H5l7-10z"/><line x1="5" y1="21" x2="19" y2="21"/></svg> You can safely eject your SD card</div>
      <button class="dap-btn-primary" id="dap-done-btn" style="margin-top: 16px;">Done</button>
    </div>
  `

  grid.appendChild(div)
  div.querySelector('#dap-done-btn').addEventListener('click', () => {
    dapSubView = 'albums'
    app.displayCurrentView()
  })
}

// === SCREEN 7: DISCONNECTED ===

function renderDisconnectedView(grid) {
  const dest = getCurrentDest()

  const div = document.createElement('div')
  div.className = 'dap-setup-center dap-fade-in'
  div.innerHTML = `
    <div class="dap-setup-icon">&#128268;</div>
    <div class="dap-setup-title">DAP not connected</div>
    <div class="dap-disc-subtitle">The destination folder is not available:</div>
    <div class="dap-disc-path">${escapeHtml(dest?.path || '/Volumes/...')}</div>
    <div class="dap-disc-desc">Insert your SD card into a card reader<br>or connect your DAP via USB, then click Retry.</div>
    <div class="dap-disc-buttons">
      <button class="dap-btn-secondary" id="dap-change-dest-btn">Change destination</button>
      <button class="dap-btn-primary" id="dap-retry-btn">Retry</button>
    </div>
  `

  grid.appendChild(div)
  div.querySelector('#dap-change-dest-btn').addEventListener('click', addDestination)
  div.querySelector('#dap-retry-btn').addEventListener('click', async () => {
    await refreshMountedVolumes()
    const d = getCurrentDest()
    if (d && mountedVolumes.has(d.path)) {
      dapSubView = 'albums'
      await loadSelections(d.id)
      app.displayCurrentView()
    } else {
      showToast('Device still not connected', 'warning')
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
      <div><div class="dap-set-label">Last sync</div><div class="dap-set-desc">${dest.lastSync ? new Date(dest.lastSync).toLocaleString() : 'Never'}</div></div>
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

// === SCREEN 6: FIRST SYNC ===

function renderFirstSyncView(grid) {
  const div = document.createElement('div')
  div.className = 'dap-first-sync dap-fade-in'

  div.innerHTML = `
    <div class="dap-warn-box">
      <div class="dap-warn-title">&#9888; Existing music detected on your DAP</div>
      <div class="dap-warn-text">Your DAP already contains audio files that were not synced by Noir. Since sync mirror mode is enabled, files not in your selection would normally be deleted.</div>
    </div>
    <div class="dap-first-sync-question">What would you like to do?</div>
    <div class="dap-radio-group">
      <div class="dap-radio-opt" data-value="keep">
        <div class="dap-radio-circle"></div>
        <div><div class="dap-r-label">Keep existing files</div><div class="dap-r-desc">Noir will adopt existing files and only add new ones. Nothing will be deleted.</div></div>
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
  console.time('[PERF] loadSelections IPC')
  // Always select ALL albums initially so the first sync plan computation
  // can determine which albums are already on the DAP vs which need copying.
  // After plan computation, _needsOnDapPreselection triggers auto-deselection
  // of albums not yet on the device.
  selectedAlbums.clear()
  for (const albumKey of Object.keys(library.albums)) {
    selectedAlbums.add(albumKeyToId(albumKey))
  }
  _needsOnDapPreselection = true
  try {
    await invoke('dap_get_selections', { destinationId: destId })
    console.timeEnd('[PERF] loadSelections IPC')
  } catch (e) {
    console.timeEnd('[PERF] loadSelections IPC')
    console.error('[DAP] Failed to load selections (will auto-detect from DAP):', e)
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
  console.log(`[PERF] buildTracksForSync: ${tracks.length} tracks, ${estimatedCount} with estimated size (no fileSize in metadata)`)
  return tracks
}

function estimateFileSize(meta) {
  if (!meta?.duration) return 0
  if (meta.bitrate) return Math.round(meta.duration * meta.bitrate / 8)
  const sr = meta.sampleRate || 44100
  const bd = meta.bitDepth || 16
  return Math.round(meta.duration * sr * bd * 2 / 8)
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
    await invoke('dap_execute_sync', {
      tracks: tracksForSync,
      destPath: dest.path,
      folderStructure,
      mirrorMode,
    })
  } catch (e) {
    showToast(`Sync error: ${e}`, 'error')
    isSyncing = false
    dapSubView = 'albums'
    renderSidebarDestinations()
    app.displayCurrentView()
  }
}

function cancelSync() {
  invoke('dap_cancel_sync').catch(() => {})
}

// === EVENT LISTENERS ===

function setupEventListeners() {
  listen('volume_change', () => refreshMountedVolumes())

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

  listen('dap_sync_complete', async (event) => {
    const c = event.payload
    isSyncing = false
    syncResult = c
    renderSidebarDestinations()

    if (c.success) {
      dapSubView = 'complete'
      // Await volume refresh so renderCompleteView() reads up-to-date free/total bytes
      await refreshMountedVolumes()
    } else if (c.errors?.length > 0) {
      const msg = c.errors[0]
      if (msg.includes('cancelled')) {
        showToast('Sync cancelled', 'warning')
        dapSubView = 'albums'
      } else {
        showToast(`Sync failed: ${msg}`, 'error')
        dapSubView = 'albums'
      }
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
  const labelEl = document.querySelector('.dap-syncing-label')

  const pct = p.total > 0 ? (p.current / p.total * 100).toFixed(1) : 0

  if (fillEl) fillEl.style.width = `${pct}%`
  if (statsEl) statsEl.innerHTML = `<span>${p.current} / ${p.total} files</span><span>${formatBytes(p.bytesCopied)} / ${formatBytes(p.totalBytes)}</span>`
  if (fileEl) fileEl.textContent = p.currentFile || ''

  // Update stepper dots
  const dots = document.querySelectorAll('.dap-step-dot')
  const labels = document.querySelectorAll('.dap-step-label')
  const phaseIdx = p.phase === 'copy' ? 2 : p.phase === 'delete' ? 1 : 0
  dots.forEach((dot, i) => {
    dot.className = 'dap-step-dot ' + (i < phaseIdx ? 'done' : i === phaseIdx ? 'current' : 'pending')
    dot.innerHTML = i < phaseIdx ? '&#10003;' : (i + 1)
  })
  labels.forEach((label, i) => {
    label.className = 'dap-step-label ' + (i < phaseIdx ? 'done' : i === phaseIdx ? 'current' : 'pending')
  })
}

// === SIDEBAR HEADER TOGGLE ===

function initSidebarToggle() {
  const header = document.getElementById('dap-sync-header-toggle')
  if (!header) return

  header.addEventListener('click', () => {
    header.classList.toggle('open')
    const list = document.getElementById('dap-sync-destinations')
    if (list) list.style.display = header.classList.contains('open') ? '' : 'none'
    sidebarCollapsed = !header.classList.contains('open')
  })
}

// === INIT ===

export async function initDapSync() {
  invoke('dap_start_volume_watcher').catch((e) => console.warn('[DAP] Volume watcher:', e))
  await loadDestinations()
  await refreshMountedVolumes()
  setupEventListeners()
  initSidebarToggle()
}

// === EXPORTS ===
export { openSyncPanel, closeSyncPanel, loadDestinations, refreshMountedVolumes, hideDapTopBar, renderSidebarDestinations }
