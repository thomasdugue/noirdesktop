// network.js — UI réseau: discovery NAS, share browser, source management
// Gère la section "Network Library" dans les settings

import { invoke, library } from './state.js'
import { app } from './app.js'
import { showToast } from './utils.js'

// === ÉTAT DU MODULE ===
let discoveryAbort = null
let browserAbort = null
let isDiscovering = false
let isBrowsing = false

// Cache des résultats de browse SMB → clé: "host\tshare\tpath" → entries[]
const smbBrowseCache = new Map()
// ID de navigation courante — pour ignorer les résultats périmés
let activeBrowseId = 0
// Référence au state de la modale active (shared avec addDiscoveredDevice via event Tauri)
// Fix bug : les devices découverts via 'nas_device_found' recevaient un state frais { host: '' }
// au lieu du state partagé → clic n'updateait pas le bon objet → state.host restait ''
let currentModalState = null

// === INIT ===

export function initNetworkUI() {
  const addNetworkBtn = document.getElementById('settings-add-network')
  if (addNetworkBtn) {
    addNetworkBtn.addEventListener('click', openNetworkDiscoveryModal)
  }

  // Écouter les événements réseau depuis Rust
  initNetworkListeners()

  // Auto-reconnect : reconnecte silencieusement toutes les sources avec credentials en Keychain.
  // Fire-and-forget — ne bloque pas l'init. Délai 1s pour laisser l'app finir de démarrer.
  setTimeout(() => autoReconnectNetworkSources(), 1000)
}

/**
 * Tente de reconnecter en silence toutes les sources réseau non-guest activées.
 * Rust récupère le mot de passe depuis le Keychain automatiquement (credentials.rs).
 */
async function autoReconnectNetworkSources() {
  try {
    const sources = await invoke('get_network_sources')
    for (const source of sources) {
      if (!source.enabled || source.credentials?.is_guest) continue
      try {
        await invoke('reconnect_network_source', { sourceId: source.id })
        console.log(`[NETWORK] Auto-reconnect: ${source.name} ✓`)
      } catch (e) {
        // Silencieux — le statut reste rouge, l'utilisateur peut relancer manuellement
        console.warn(`[NETWORK] Auto-reconnect failed for ${source.name}:`, e)
      }
    }
  } catch (e) {
    console.warn('[NETWORK] autoReconnectNetworkSources error:', e)
  }
}

function initNetworkListeners() {
  // Migration: clean up any credentials previously stored in localStorage
  try {
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('noir-nas-creds-')) localStorage.removeItem(key)
    })
  } catch (e) { /* ignore */ }

  try {
    const { listen } = window.__TAURI__.event
    listen('nas_device_found', (event) => {
      addDiscoveredDevice(event.payload)
    })
    listen('network_source_connected', (event) => {
      updateSourceStatus(event.payload.source_id, 'connected')
    })
    listen('network_source_disconnected', (event) => {
      updateSourceStatus(event.payload.source_id, 'disconnected')
      showToast(`NAS disconnected: ${event.payload.name}`)
    })
  } catch (e) {
    console.warn('[NETWORK] Could not init event listeners:', e)
  }
}

// === SETTINGS — SOURCE LIST ===

export async function populateNetworkSources() {
  const container = document.getElementById('settings-network-sources')
  if (!container) return

  try {
    const sources = await invoke('get_network_sources')
    container.innerHTML = ''

    if (sources.length === 0) {
      container.innerHTML = '<div style="font-size: 11px; color: #555; padding: 8px 0;">No network sources configured</div>'
      return
    }

    for (const source of sources) {
      const item = document.createElement('div')
      item.className = 'settings-path-item settings-network-item'
      item.dataset.sourceId = source.id
      item.innerHTML = `
        <div class="settings-network-status" data-status="${source.enabled ? 'connected' : 'disabled'}" title="${source.enabled ? 'Connected' : 'Disabled'}"></div>
        <span class="settings-path-text" title="//${source.host}/${source.share}${source.remote_path}">
          ${escapeHtml(source.name)} — //${escapeHtml(source.host)}/${escapeHtml(source.share)}
        </span>
        <button class="settings-network-sync" title="Re-index" data-source-id="${source.id}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </button>
        <button class="settings-network-toggle" title="${source.enabled ? 'Disable' : 'Enable'}" data-source-id="${source.id}" data-enabled="${source.enabled}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            ${source.enabled
              ? '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>'
              : '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>'}
          </svg>
        </button>
        <button class="settings-path-remove" title="Remove" data-source-id="${source.id}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6L6 18"/><path d="M6 6l12 12"/>
          </svg>
        </button>
      `
      container.appendChild(item)
    }

    // Wire up sync (réindexer) buttons
    container.querySelectorAll('.settings-network-sync').forEach(btn => {
      btn.addEventListener('click', async () => {
        const sourceId = btn.dataset.sourceId
        if (btn.classList.contains('syncing')) return  // déjà en cours
        btn.classList.add('syncing')
        btn.title = 'Indexing...'
        try {
          await invoke('scan_network_source_cmd', { sourceId })
          populateNetworkSources()
          showToast('Re-indexing complete')
        } catch (e) {
          showToast('Re-indexing failed')
          console.warn('[Network] Sync failed:', e)
        } finally {
          btn.classList.remove('syncing')
          btn.title = 'Re-index'
        }
      })
    })

    // Wire up toggle buttons
    container.querySelectorAll('.settings-network-toggle').forEach(btn => {
      btn.addEventListener('click', async () => {
        const sourceId = btn.dataset.sourceId
        const currentlyEnabled = btn.dataset.enabled === 'true'
        try {
          await invoke('toggle_network_source', { sourceId, enabled: !currentlyEnabled })
          populateNetworkSources()
          showToast(currentlyEnabled ? 'Network source disabled' : 'Network source enabled')
        } catch (e) {
          showToast('Failed to toggle source')
        }
      })
    })

    // Wire up remove buttons
    container.querySelectorAll('.settings-path-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        const sourceId = btn.dataset.sourceId
        try {
          // remove_network_source retourne les stats mises à jour (local seulement)
          const result = await invoke('remove_network_source', { sourceId })
          btn.closest('.settings-path-item').remove()
          showToast('Network source removed')
          // Rechargement immédiat de la librairie → les tracks SMB disparaissent
          try {
            const [updatedTracks] = await invoke('load_tracks_from_cache')
            library.tracks.length = 0
            for (const t of updatedTracks) library.tracks.push(t)
            app.groupTracksIntoAlbumsAndArtists()
            app.buildTrackLookup()
            app.displayCurrentView()
            if (result?.stats) app.updateIndexationStats(result.stats)

            // Check if library is now completely empty → show welcome/setup
            if (library.tracks.length === 0) {
              const remainingPaths = await invoke('get_library_paths')
              let remainingNet = []
              try { remainingNet = await invoke('get_network_sources') } catch (_) {}
              if (remainingPaths.length === 0 && remainingNet.length === 0) {
                const welcomeDiv = document.getElementById('welcome')
                if (welcomeDiv) welcomeDiv.classList.remove('hidden')
                const setupBtn = document.getElementById('setup-library-btn')
                const openBtn = document.getElementById('open-folder-welcome')
                if (setupBtn) setupBtn.style.display = ''
                if (openBtn) openBtn.style.display = 'none'
              }
            }
          } catch (reloadErr) {
            console.warn('[Network] Library reload after remove failed:', reloadErr)
          }
        } catch (e) {
          showToast('Failed to remove source')
          console.warn('[Network] remove_network_source failed:', e)
        }
      })
    })

    // Update statuses
    try {
      const statuses = await invoke('get_network_status')
      for (const [sourceId, status] of Object.entries(statuses)) {
        updateSourceStatus(sourceId, status)
      }
    } catch (_) { /* ignore */ }
  } catch (e) {
    console.error('[NETWORK] Error loading network sources:', e)
  }
}

function updateSourceStatus(sourceId, status) {
  const item = document.querySelector(`.settings-network-item[data-source-id="${sourceId}"]`)
  if (!item) return
  const dot = item.querySelector('.settings-network-status')
  if (dot) {
    dot.dataset.status = status
    dot.title = status.charAt(0).toUpperCase() + status.slice(1)
  }
}

// === DISCOVERY MODAL ===

function openNetworkDiscoveryModal() {
  // Remove existing modal if any
  closeNetworkModal()

  const modal = document.createElement('div')
  modal.id = 'network-modal'
  modal.className = 'modal'
  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-content network-modal-content">
      <div class="network-modal-header">
        <h3>Add Network Folder (NAS)</h3>
        <button id="network-modal-close" class="network-modal-close-x" title="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <div class="network-tabs">
        <button class="network-tab active" data-tab="discover">Discover</button>
        <button class="network-tab" data-tab="manual">Manual</button>
      </div>

      <div id="network-tab-discover" class="network-tab-content active">
        <p class="network-hint">Searching for NAS devices on your network...</p>
        <div id="network-discovered-list" class="network-discovered-list">
          <div class="network-spinner"></div>
        </div>
      </div>

      <div id="network-tab-manual" class="network-tab-content" style="display:none">
        <label class="network-label">Host / IP address</label>
        <input type="text" id="network-manual-host" class="modal-input" placeholder="192.168.1.100 or mynas.local">
        <button id="network-manual-connect" class="network-btn-primary" style="margin-top:8px;width:100%">
          Connect
        </button>
      </div>

      <div id="network-auth-section" style="display:none">
        <hr class="network-divider">
        <h4 id="network-auth-title">Authentication</h4>
        <div class="network-auth-form">
          <div class="network-guest-toggle">
            <span>Connect as guest</span>
            <label class="ios-toggle">
              <input type="checkbox" id="network-guest-mode" checked>
              <span class="ios-toggle-slider"></span>
            </label>
          </div>
          <div id="network-creds-fields" style="display:none">
            <input type="text" id="network-username" class="modal-input"
              placeholder="Username"
              style="margin-top:4px"
              spellcheck="false"
              autocorrect="off"
              autocapitalize="none"
              autocomplete="username">
            <input type="password" id="network-password" class="modal-input"
              placeholder="Password"
              style="margin-top:4px"
              spellcheck="false"
              autocorrect="off"
              autocomplete="current-password">
            <div class="network-remember-row" style="opacity:0.6;font-size:11px;margin-top:6px">
              <span>Credentials stored securely in Keychain</span>
            </div>
          </div>
          <button id="network-auth-connect" class="network-btn-primary" style="margin-top:10px;width:100%">
            Connect &amp; Browse Shares
          </button>
        </div>
      </div>

      <div id="network-browse-section" style="display:none">
        <hr class="network-divider">
        <!-- Barre collante : chemin sélectionné + bouton Add (toujours visible) -->
        <div class="network-select-bar">
          <div id="network-folder-path" class="network-folder-path-inline">No folder selected</div>
          <button id="network-add-here" class="network-btn-primary network-add-here-btn" disabled>
            + Add this folder
          </button>
        </div>
        <div class="network-browse-hint">Click = select · Double-click = open</div>
        <div id="network-shares-list" class="network-shares-list"></div>
      </div>

      <!-- Section nom : affichée après clic sur "Add this folder" -->
      <div id="network-save-section" style="display:none">
        <hr class="network-divider">
        <label class="network-label">Name (optional)</label>
        <input type="text" id="network-source-name" class="modal-input" placeholder="My NAS">
        <div style="display:flex;gap:8px;margin-top:12px">
          <button id="network-cancel" class="network-btn-secondary" style="flex:1">Cancel</button>
          <button id="network-save" class="network-btn-primary" style="flex:1">Confirm Add Source</button>
        </div>
      </div>

    </div>
  `
  document.body.appendChild(modal)

  // State pour le flow — partagé avec addDiscoveredDevice via currentModalState
  const state = { host: '', share: '', path: '/', selectedHost: null }
  currentModalState = state

  // Abort controller pour cleanup
  if (discoveryAbort) discoveryAbort.abort()
  discoveryAbort = new AbortController()
  const { signal } = discoveryAbort

  // Close modal
  const closeBtn = modal.querySelector('#network-modal-close')
  closeBtn.addEventListener('click', closeNetworkModal, { signal })
  modal.addEventListener('click', (e) => {
    if (!modal.querySelector('.modal-content').contains(e.target)) closeNetworkModal()
  }, { signal })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeNetworkModal()
  }, { signal })

  // Tab switching
  modal.querySelectorAll('.network-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      modal.querySelectorAll('.network-tab').forEach(t => t.classList.remove('active'))
      modal.querySelectorAll('.network-tab-content').forEach(c => { c.style.display = 'none'; c.classList.remove('active') })
      tab.classList.add('active')
      const content = modal.querySelector(`#network-tab-${tab.dataset.tab}`)
      if (content) { content.style.display = ''; content.classList.add('active') }
    }, { signal })
  })

  // Guest mode toggle — masque/affiche les champs credentials
  const guestMode = modal.querySelector('#network-guest-mode')
  const updateCredsVisibility = () => {
    const credsFields = modal.querySelector('#network-creds-fields')
    if (credsFields) credsFields.style.display = guestMode.checked ? 'none' : ''
  }
  guestMode.addEventListener('change', updateCredsVisibility, { signal })
  updateCredsVisibility() // état initial

  // Manual connect
  const manualConnect = modal.querySelector('#network-manual-connect')
  manualConnect.addEventListener('click', () => {
    const host = modal.querySelector('#network-manual-host').value.trim()
    if (!host) return
    state.host = host
    showAuthSection(modal, state)
  }, { signal })

  // Auth connect / Disconnect — même bouton, comportement selon dataset.connected
  const authConnect = modal.querySelector('#network-auth-connect')
  authConnect.addEventListener('click', async () => {
    if (authConnect.dataset.connected === 'true') {
      disconnectFromNas(modal, state)
    } else {
      await connectAndBrowse(modal, state)
    }
  }, { signal })

  // "Add this folder" — PAS de { signal }, toujours actif
  const addHereBtn = modal.querySelector('#network-add-here')
  if (addHereBtn) {
    addHereBtn.addEventListener('click', () => {
      // Affiche la section nom
      const saveSection = modal.querySelector('#network-save-section')
      if (saveSection) saveSection.style.display = ''
      const nameInput = modal.querySelector('#network-source-name')
      if (nameInput && !nameInput.value) nameInput.value = state.share || state.host
      nameInput?.focus()
    })
  }

  // Cancel in save section
  const cancelBtn = modal.querySelector('#network-cancel')
  if (cancelBtn) {
    cancelBtn.addEventListener('click', closeNetworkModal, { signal })
  }

  // Confirm Add Source — PAS de { signal }
  const saveBtn = modal.querySelector('#network-save')
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      await saveNetworkSource(modal, state)
    })
  }

  // Start discovery
  startDiscovery(modal, state)
}

function closeNetworkModal() {
  const modal = document.getElementById('network-modal')
  if (modal) modal.remove()
  currentModalState = null
  if (discoveryAbort) {
    discoveryAbort.abort()
    discoveryAbort = null
  }
}

async function startDiscovery(modal, state) {
  isDiscovering = true
  try {
    const devices = await invoke('discover_nas_devices')
    const list = modal.querySelector('#network-discovered-list')
    if (!list) return

    if (devices.length === 0) {
      list.innerHTML = '<div class="network-hint">No NAS devices found. Try "Manual" tab.</div>'
    } else {
      list.innerHTML = ''
      for (const device of devices) {
        addDiscoveredDeviceToList(list, device, modal, state)
      }
    }
  } catch (e) {
    const list = modal.querySelector('#network-discovered-list')
    if (list) list.innerHTML = `<div class="network-hint">Discovery error: ${escapeHtml(String(e))}</div>`
  }
  isDiscovering = false
}

function addDiscoveredDevice(device) {
  const list = document.querySelector('#network-discovered-list')
  const modal = document.getElementById('network-modal')
  if (!list || !modal) return
  // Remove spinner if present
  const spinner = list.querySelector('.network-spinner')
  if (spinner) spinner.remove()
  // Fix : utiliser currentModalState (state partagé) plutôt qu'un objet frais
  // Sinon, le clic sur un item découvert via cet event updateait le mauvais state
  const state = currentModalState || { host: '', share: '', path: '/' }
  addDiscoveredDeviceToList(list, device, modal, state)
}

function addDiscoveredDeviceToList(list, device, modal, state) {
  const item = document.createElement('div')
  item.className = 'network-discovered-item'
  item.innerHTML = `
    <div class="network-device-icon">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="2" y="7" width="20" height="10" rx="2"/><line x1="6" y1="12" x2="6.01" y2="12"/>
        <line x1="10" y1="12" x2="10.01" y2="12"/>
      </svg>
    </div>
    <div class="network-device-info">
      <div class="network-device-name">${escapeHtml(device.display_name || device.hostname)}</div>
      <div class="network-device-ip">${escapeHtml(device.ip)}:${device.port}</div>
    </div>
  `
  item.addEventListener('click', () => {
    // IPv4 → utiliser l'IP directe. IPv6-only → utiliser le hostname (.local)
    // macOS résout .local via mDNSResponder, libsmbclient bénéficie du resolver système
    const hasIPv4 = device.ip && /^\d+\.\d+\.\d+\.\d+$/.test(device.ip)
    state.host = hasIPv4 ? device.ip : (device.hostname || device.ip)
    list.querySelectorAll('.network-discovered-item').forEach(i => i.classList.remove('selected'))
    item.classList.add('selected')
    showAuthSection(modal, state)
  })
  list.appendChild(item)
}

function showAuthSection(modal, state) {
  const authSection = modal.querySelector('#network-auth-section')
  const authTitle = modal.querySelector('#network-auth-title')
  if (!authSection) return
  authSection.style.display = ''
  if (authTitle) authTitle.textContent = `Connect to ${state.host}`

  // Réinitialiser le bouton si précédemment en état "Disconnect"
  const authBtn = modal.querySelector('#network-auth-connect')
  if (authBtn && authBtn.dataset.connected === 'true') {
    authBtn.dataset.connected = ''
    authBtn.className = 'network-btn-primary'
    authBtn.textContent = 'Connect & Browse Shares'
    authBtn.disabled = false
  }

  // Credentials are stored in macOS Keychain — no pre-fill from JS
  // The Keychain handles credential retrieval at connection time (Rust side)
}

async function connectAndBrowse(modal, state) {
  const guestCheckbox = modal.querySelector('#network-guest-mode')
  let isGuest = guestCheckbox ? guestCheckbox.checked : true
  const username = modal.querySelector('#network-username')?.value.trim() || ''
  const password = modal.querySelector('#network-password')?.value || ''

  // Auto-guest si aucune credential saisie
  if (!isGuest && !username && !password) {
    isGuest = true
    if (guestCheckbox) guestCheckbox.checked = true
    const credsFields = modal.querySelector('#network-creds-fields')
    if (credsFields) credsFields.style.display = 'none'
  }

  state.username = isGuest ? '' : username
  state.password = isGuest ? '' : password
  state.isGuest = isGuest

  const authBtn = modal.querySelector('#network-auth-connect')
  if (authBtn) { authBtn.disabled = true; authBtn.textContent = 'Connecting…' }

  let connectSuccess = false
  try {
    await invoke('smb_connect', {
      host: state.host,
      username,
      password,
      domain: null,
      isGuest: isGuest,
    })

    // List shares
    const shares = await invoke('smb_list_shares', { host: state.host })
    connectSuccess = true

    // Credentials are stored securely in macOS Keychain via Rust backend
    // (handled by smb_connect → credentials.rs → store_password)

    // Changer le bouton en "Disconnect" (secondaire)
    const currentAuthBtn = modal.querySelector('#network-auth-connect')
    if (currentAuthBtn) {
      currentAuthBtn.dataset.connected = 'true'
      currentAuthBtn.className = 'network-btn-secondary'
      currentAuthBtn.textContent = 'Disconnect'
      currentAuthBtn.disabled = false
    }

    // Verrouiller la sélection NAS → l'utilisateur doit d'abord Disconnect
    lockNasSelection(modal, state)
    showShareBrowser(modal, state, shares)
  } catch (e) {
    showToast(`Connection failed: ${e}`)
    console.error('[Network] Connect error:', e)
  } finally {
    // Toujours réinitialiser le bouton si la connexion a échoué
    if (!connectSuccess) {
      const currentAuthBtn = modal.querySelector('#network-auth-connect')
      if (currentAuthBtn) {
        currentAuthBtn.dataset.connected = ''
        currentAuthBtn.className = 'network-btn-primary'
        currentAuthBtn.textContent = 'Connect & Browse Shares'
        currentAuthBtn.disabled = false
      }
    }
  }
}

function lockNasSelection(modal, state) {
  // Masquer les onglets Discover / Manual → l'utilisateur ne peut plus choisir un autre NAS
  const tabsEl = modal.querySelector('.network-tabs')
  const discoverContent = modal.querySelector('#network-tab-discover')
  const manualContent = modal.querySelector('#network-tab-manual')
  if (tabsEl) tabsEl.style.display = 'none'
  if (discoverContent) discoverContent.style.display = 'none'
  if (manualContent) manualContent.style.display = 'none'

  // Afficher un badge "Connected to {host}" à la place
  let badge = modal.querySelector('#network-connected-badge')
  if (!badge) {
    badge = document.createElement('div')
    badge.id = 'network-connected-badge'
    badge.className = 'network-connected-badge'
    const authSection = modal.querySelector('#network-auth-section')
    if (authSection) authSection.parentNode.insertBefore(badge, authSection)
  }
  badge.innerHTML = `
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
    </svg>
    Connected to <strong>${escapeHtml(state.host)}</strong>
  `
  badge.style.display = ''
}

function unlockNasSelection(modal) {
  // Restaurer les onglets et le contenu Discover (tab par défaut)
  const tabsEl = modal.querySelector('.network-tabs')
  const discoverContent = modal.querySelector('#network-tab-discover')
  if (tabsEl) tabsEl.style.display = ''
  if (discoverContent) discoverContent.style.display = ''

  // Masquer le badge "Connected"
  const badge = modal.querySelector('#network-connected-badge')
  if (badge) badge.style.display = 'none'
}

function disconnectFromNas(modal, state) {
  // Réinitialiser le state de browse
  state.share = ''
  state.path = '/'

  // Masquer la section browse
  const browseSection = modal.querySelector('#network-browse-section')
  if (browseSection) browseSection.style.display = 'none'

  // Remettre le bouton en état "Connect"
  const authBtn = modal.querySelector('#network-auth-connect')
  if (authBtn) {
    authBtn.dataset.connected = ''
    authBtn.className = 'network-btn-primary'
    authBtn.textContent = 'Connect & Browse Shares'
    authBtn.disabled = false
  }

  // Restaurer la sélection NAS (onglets + liste)
  unlockNasSelection(modal)

  // Réafficher la barre de sélection
  updateSelectBar(modal, state)
}

function showShareBrowser(modal, state, shares) {
  const browseSection = modal.querySelector('#network-browse-section')
  const sharesList = modal.querySelector('#network-shares-list')
  const saveSection = modal.querySelector('#network-save-section')

  if (browseSection) browseSection.style.display = ''

  if (!sharesList) return

  sharesList.innerHTML = ''
  for (const share of shares) {
    const item = document.createElement('div')
    item.className = 'network-share-item'
    item.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </svg>
      <span>${escapeHtml(share.name)}</span>
      <span class="network-dblclick-hint">double-click to open</span>
    `
    // Single click = sélectionner ce share (racine)
    item.addEventListener('click', () => {
      state.share = share.name
      state.path = '/'
      sharesList.querySelectorAll('.network-share-item').forEach(i => i.classList.remove('selected'))
      item.classList.add('selected')
      updateSelectBar(modal, state)
    })
    // Double click = naviguer dans le share
    item.addEventListener('dblclick', async () => {
      state.share = share.name
      state.path = '/'
      await browseFolder(modal, state)
    })
    sharesList.appendChild(item)
  }
}

function updateSelectBar(modal, state) {
  const pathDisplay = modal.querySelector('#network-folder-path')
  const addHereBtn = modal.querySelector('#network-add-here')
  if (pathDisplay) {
    pathDisplay.textContent = `//${state.host}/${state.share}${state.path}`
  }
  if (addHereBtn) addHereBtn.disabled = !state.share
}

/// Rend les résultats de browse dans la liste — utilisé par browseFolder (cache hit + miss)
function renderBrowseResults(modal, state, sharesList, entries) {
  sharesList.innerHTML = ''

  // Bouton retour vers la liste des shares (à la racine d'un share)
  if (state.path === '/' || state.path === '') {
    const back = document.createElement('div')
    back.className = 'network-share-item network-back-item'
    back.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>
      </svg>
      <span>All shares</span>
    `
    back.addEventListener('click', async () => {
      state.share = ''
      state.path = '/'
      updateSelectBar(modal, state)
      try {
        const shares = await invoke('smb_list_shares', { host: state.host })
        showShareBrowser(modal, state, shares)
      } catch (err) {
        sharesList.innerHTML = `<div class="network-error">Error reloading shares: ${escapeHtml(String(err))}</div>`
      }
    })
    sharesList.appendChild(back)
  } else {
    // Bouton retour vers le dossier parent
    const back = document.createElement('div')
    back.className = 'network-share-item network-back-item'
    back.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>
      </svg>
      <span>..</span>
    `
    back.addEventListener('click', () => {
      const parts = state.path.split('/').filter(Boolean)
      parts.pop()
      state.path = parts.length === 0 ? '/' : '/' + parts.join('/')
      browseFolder(modal, state)
    })
    sharesList.appendChild(back)
  }

  // Dossiers uniquement (les fichiers audio ne sont pas affichés dans le browser)
  const folders = entries.filter(e => e.is_dir)
  for (const folder of folders) {
    const folderPath = state.path === '/' ? `/${folder.name}` : `${state.path}/${folder.name}`
    const item = document.createElement('div')
    item.className = 'network-share-item'
    item.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </svg>
      <span>${escapeHtml(folder.name)}</span>
      <span class="network-dblclick-hint">double-click to open</span>
    `
    // Single click = sélectionner ce dossier (sans naviguer)
    item.addEventListener('click', () => {
      state.path = folderPath
      sharesList.querySelectorAll('.network-share-item').forEach(i => i.classList.remove('selected'))
      item.classList.add('selected')
      updateSelectBar(modal, state)
    })
    // Double click = naviguer dans le dossier
    item.addEventListener('dblclick', () => {
      state.path = folderPath
      browseFolder(modal, state)
    })
    sharesList.appendChild(item)
  }

  if (folders.length === 0) {
    const audioCount = entries.filter(e => !e.is_dir).length
    const hint = audioCount > 0
      ? `<div class="network-hint">${audioCount} audio file(s) — folder selected</div>`
      : `<div class="network-hint">Empty folder</div>`
    sharesList.insertAdjacentHTML('beforeend', hint)
  }
}

async function browseFolder(modal, state) {
  updateSelectBar(modal, state)

  const sharesList = modal.querySelector('#network-shares-list')
  if (!sharesList) return

  const myId = ++activeBrowseId
  const cacheKey = `${state.host}\t${state.share}\t${state.path}`

  // Cache hit → affiche immédiatement (pas de refresh fond : tiendrait mutex ~1 min)
  const cached = smbBrowseCache.get(cacheKey)
  if (cached) {
    renderBrowseResults(modal, state, sharesList, cached)
    return
  }

  // Pas de cache : spinner centré (remplace le contenu de la liste)
  sharesList.innerHTML = `
    <div class="smb-browse-loading">
      <div class="smb-spinner"></div>
      <span>Loading...</span>
    </div>
  `

  try {
    const entries = await invoke('smb_browse', {
      host: state.host,
      share: state.share,
      path: state.path,
    })

    if (activeBrowseId !== myId) return // Navigation plus récente → ignorer

    smbBrowseCache.set(cacheKey, entries)
    renderBrowseResults(modal, state, sharesList, entries)
  } catch (e) {
    if (activeBrowseId !== myId) return
    // Affiche l'erreur avec hint retour (la liste a été vidée pour le spinner)
    const errMsg = String(e)
    const isAccessDenied = errMsg.toLowerCase().includes('access') || errMsg.toLowerCase().includes('denied') || errMsg.toLowerCase().includes('logon')
    sharesList.innerHTML = `
      <div class="network-error">
        <strong>Could not open folder</strong><br>
        ${escapeHtml(errMsg)}
        ${isAccessDenied ? '<br><em>Check permissions in DSM for this share.</em>' : ''}
      </div>
      <div class="network-hint" style="padding:8px 0">↩ Use the back button to try again</div>
    `
    console.error('[SMB Browse] Error:', e)
  }
}

async function saveNetworkSource(modal, state) {
  const name = modal.querySelector('#network-source-name')?.value.trim() || state.host
  const saveBtn = modal.querySelector('#network-save')
  // Supprimer erreur inline précédente
  modal.querySelector('.smb-save-error')?.remove()
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...' }

  try {
    const result = await invoke('add_network_source', {
      name,
      host: state.host,
      share: state.share,
      path: state.path,
      username: state.username || '',
      password: state.password || '',
      domain: null,
      isGuest: state.isGuest || false,
    })

    closeNetworkModal()
    showToast(`Network source added: ${name}`)
    populateNetworkSources()

    // Fire-and-forget — NE PAS awaiter (scan peut durer plusieurs minutes)
    invoke('scan_network_source_cmd', { sourceId: result.id })
      .then(() => { populateNetworkSources() })
      .catch(e => console.warn('[Network] Scan after add failed:', e))

  } catch (e) {
    // Erreur inline persistante dans le modal (visible sans toast éphémère)
    const errDiv = document.createElement('div')
    errDiv.className = 'network-error smb-save-error'
    errDiv.style.marginTop = '8px'
    errDiv.textContent = `Error: ${e}`
    modal.querySelector('#network-save-section')?.appendChild(errDiv)
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Confirm Add Source' }
  }
}

// === HELPERS ===

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}
