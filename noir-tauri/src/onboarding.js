// onboarding.js — Module d'onboarding 6 étapes pour Noir Desktop
// HTML/CSS/JS extraits verbatim du prototype validé (docs/onboarding-prototype.html).
// Seule différence : les appels Tauri (invoke) remplacent les mocks.

import { library, dom, ui, invoke, listen } from './state.js'
import { app } from './app.js'
import { showToast } from './utils.js'

// === État local au module ===
let onboardingActive = false
let currentStep = 1
let scanUnlisteners = []
let nasState = { host: '', deviceName: '', share: '', path: '/', username: '', password: '', isGuest: true, rememberCreds: false }
let scanStats = { tracks: 0, albums: 0, artists: 0 }
let overlayEl = null

// Browse state
let browsePath = '/'
let selectedFolder = null
let clickTimer = null
let browseShares = []

// ==========================================
// SVG — copié tel quel du prototype
// ==========================================
const FOLDER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`

// ==========================================
// Init — enregistre les slots dans app.js
// ==========================================
export function initOnboarding() {
  app.showOnboarding = showOnboarding
  app.hideOnboarding = hideOnboarding
}

// ==========================================
// Show — construit et injecte le DOM
// ==========================================
export function showOnboarding() {
  if (onboardingActive) return
  onboardingActive = true
  currentStep = 1
  nasState = { host: '', deviceName: '', share: '', path: '/', username: '', password: '', isGuest: true, rememberCreds: false }
  scanStats = { tracks: 0, albums: 0, artists: 0 }

  overlayEl = document.createElement('div')
  overlayEl.id = 'onboarding-overlay'
  // Le HTML ci-dessous est copié tel quel du prototype (lignes 950-1228)
  overlayEl.innerHTML = `
  <div class="modal-overlay">
    <div class="onboarding-modal">

      <!-- Noir logo -->
      <div class="modal-logo">
        <svg viewBox="0 0 343 232" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="31.5" cy="117.5" r="31.5" fill="white"/>
          <path d="M69 117C62.2 94.6 42 86 33 86C33.5 103.833 32.6 141.8 33 149C57 149 67 126.5 69 117Z" fill="white"/>
          <circle cx="311.5" cy="117.5" r="31.5" transform="rotate(-180 311.5 117.5)" fill="white"/>
          <path d="M274 118C280.8 140.4 301 149 310 149C309.5 131.167 310.4 93.2 310 86C286 86 276 108.5 274 118Z" fill="white"/>
          <rect x="69" y="48" width="64" height="138" rx="32" fill="white"/>
          <rect x="137" width="69" height="232" rx="32" fill="white"/>
          <rect x="210" y="48" width="64" height="138" rx="32" fill="white"/>
          <circle cx="171.5" cy="117.5" r="38.5" fill="#111"/>
          <path d="M70 116.854C75.2991 106.115 111.333 91.9599 132 116.854C116.315 139.112 76.359 131.985 70 116.854Z" fill="#111"/>
          <path d="M211 116.854C216.299 106.115 252.333 91.9599 273 116.854C257.315 139.112 217.359 131.985 211 116.854Z" fill="#111"/>
        </svg>
      </div>

      <!-- Step indicator -->
      <div class="step-indicator">
        <div class="step-dot active" data-step="0"></div>
        <div class="step-dot" data-step="1"></div>
        <div class="step-dot" data-step="2"></div>
      </div>

      <!-- ============ STEP 1: Source selection ============ -->
      <div class="step-view active" id="ob-step-1">
        <div class="modal-header">
          <div class="greeting">Welcome to Noir</div>
          <h1>Where is your music?</h1>
          <div class="subtitle">Point Noir to your library and start listening.</div>
        </div>

        <div class="cards-container">
          <div class="source-card" id="card-local">
            <div class="icon-container">
              <div class="scanline"></div>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 12H2"/>
                <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/>
                <line x1="6" y1="16" x2="6.01" y2="16"/>
                <line x1="10" y1="16" x2="10.01" y2="16"/>
              </svg>
            </div>
            <div>
              <div class="card-title">Local folder</div>
              <div class="card-desc">Import from your Mac's<br>internal or external drive</div>
            </div>
          </div>

          <div class="source-card" id="card-nas">
            <div class="icon-container">
              <div class="scanline"></div>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
                <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
                <line x1="6" y1="6" x2="6.01" y2="6"/>
                <line x1="6" y1="18" x2="6.01" y2="18"/>
                <line x1="12" y1="10" x2="12" y2="14"/>
              </svg>
            </div>
            <div>
              <div class="card-title">Network drive</div>
              <div class="card-desc">Connect to a NAS or<br>shared SMB server</div>
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <div class="footer-hint">You can always add more sources later in <kbd>Settings</kbd></div>
          <a class="skip-link" id="ob-skip">I'll do this later</a>
        </div>
      </div>

      <!-- ============ STEP 2: NAS Discovery ============ -->
      <div class="step-view" id="ob-step-2">
        <div class="modal-header">
          <h1>Find your server</h1>
          <div class="subtitle">Select a device on your local network.</div>
        </div>

        <div class="section-content">
          <div class="discovery-tabs">
            <button class="discovery-tab active" data-tab="discover">Discover</button>
            <button class="discovery-tab" data-tab="manual">Manual</button>
          </div>

          <!-- Discover tab -->
          <div id="ob-discover-content">
            <div class="discovery-spinner">
              <div class="spinner-ring"></div>
              <span>Scanning network...</span>
            </div>
            <div class="device-list" id="ob-device-list"></div>
          </div>

          <!-- Manual tab -->
          <div class="manual-input-group" id="ob-manual-content">
            <div class="input-label">Host / IP address</div>
            <input type="text" class="noir-input" id="ob-manual-ip" placeholder="192.168.1.100 or mynas.local">
          </div>
        </div>

        <div class="btn-row">
          <button class="btn-secondary" id="ob-back-2">Back</button>
          <button class="btn-primary" id="ob-btn-nas-next" disabled>Continue</button>
        </div>
      </div>

      <!-- ============ STEP 3: NAS Auth ============ -->
      <div class="step-view" id="ob-step-3">
        <div class="modal-header">
          <h1>Authenticate</h1>
          <div class="subtitle">Provide credentials if required.</div>
        </div>

        <div class="section-content">
          <div class="connected-badge" id="ob-nas-badge">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
              <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
              <line x1="6" y1="6" x2="6.01" y2="6"/>
              <line x1="6" y1="18" x2="6.01" y2="18"/>
            </svg>
            <span><strong id="ob-nas-name">—</strong>&ensp;<span id="ob-nas-ip">—</span></span>
          </div>

          <div class="auth-toggle">
            <span>Connect as guest</span>
            <label class="toggle-switch">
              <input type="checkbox" id="ob-guest-toggle" checked>
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="creds-fields" id="ob-creds-fields">
            <input type="text" class="noir-input" id="ob-username" placeholder="Username" spellcheck="false" autocomplete="off">
            <input type="password" class="noir-input" id="ob-password" placeholder="Password" autocomplete="off">
            <div class="auth-toggle" style="padding: var(--sp-sm) 0 0;">
              <span>Remember credentials</span>
              <label class="toggle-switch">
                <input type="checkbox" id="ob-remember-toggle">
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>
        </div>

        <div class="btn-row">
          <button class="btn-secondary" id="ob-back-3">Back</button>
          <button class="btn-primary" id="ob-btn-connect">Connect & Browse</button>
        </div>
      </div>

      <!-- ============ STEP 4: Browse shares ============ -->
      <div class="step-view" id="ob-step-4">
        <div class="modal-header">
          <h1>Choose a folder</h1>
          <div class="subtitle">Single-click to select. Double-click to open.</div>
        </div>

        <div class="section-content">
          <div class="browse-path">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
              <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
            </svg>
            <span id="ob-browse-path-text">//</span>
          </div>

          <div class="folder-list" id="ob-folder-list">
            <!-- populated by JS -->
          </div>
        </div>

        <div class="btn-row">
          <button class="btn-secondary" id="ob-back-4">Back</button>
          <button class="btn-primary" id="ob-btn-add-folder" disabled>Add this folder</button>
        </div>
      </div>

      <!-- ============ STEP 5: Scanning ============ -->
      <div class="step-view" id="ob-step-5">
        <div class="modal-header">
          <h1>Indexing your library</h1>
          <div class="subtitle">This will only take a moment.</div>
        </div>

        <div class="scanning-visual">
          <div class="scan-icon-wrap">
            <div class="scan-ring-outer"></div>
            <div class="scan-ring-inner"></div>
            <div class="scan-icon-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 18V5l12-2v13"/>
                <circle cx="6" cy="18" r="3"/>
                <circle cx="18" cy="16" r="3"/>
              </svg>
            </div>
          </div>

          <div class="scan-progress">
            <div class="scan-progress-bar">
              <div class="scan-progress-fill" id="ob-scan-fill"></div>
            </div>
            <div class="scan-stats">
              <span><span class="scan-stat-value" id="ob-scan-count">0</span> tracks found</span>
              <span id="ob-scan-folder" style="text-align:right; max-width: 140px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">/music</span>
            </div>
          </div>
        </div>

        <div class="scan-footer">
          <div class="footer-hint">Reading metadata and extracting artwork...</div>
        </div>
      </div>

      <!-- ============ STEP 6: Done ============ -->
      <div class="step-view" id="ob-step-6">
        <div class="modal-header">
          <h1>You're all set</h1>
          <div class="subtitle">Your library is ready to play.</div>
        </div>

        <div class="done-visual">
          <div class="done-check">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>

          <div class="done-stats">
            <div class="done-stat">
              <div class="done-stat-number" id="ob-stat-tracks">0</div>
              <div class="done-stat-label">Tracks</div>
            </div>
            <div class="done-stat">
              <div class="done-stat-number" id="ob-stat-albums">0</div>
              <div class="done-stat-label">Albums</div>
            </div>
            <div class="done-stat">
              <div class="done-stat-number" id="ob-stat-artists">0</div>
              <div class="done-stat-label">Artists</div>
            </div>
          </div>
        </div>

        <div class="done-footer">
          <button class="btn-primary" id="ob-btn-start" style="font-weight: 600;">Start Listening</button>
        </div>
      </div>

    </div>
  </div>
  `

  document.body.appendChild(overlayEl)
  bindAllEvents()

  // Stagger entrance animation for source cards (prototype lignes 1496-1501)
  const cards = overlayEl.querySelectorAll('.source-card')
  cards.forEach((card, i) => {
    card.style.animation = `contentIn 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards`
    card.style.animationDelay = `${0.45 + i * 0.08}s`
    card.style.opacity = '0'
  })
}

// ==========================================
// Hide — supprime le DOM, cleanup
// ==========================================
export function hideOnboarding() {
  if (!onboardingActive) return
  onboardingActive = false
  for (const unlisten of scanUnlisteners) {
    if (typeof unlisten === 'function') unlisten()
  }
  scanUnlisteners = []
  if (overlayEl) { overlayEl.remove(); overlayEl = null }
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null }
}

// ==========================================
// Step navigation — copié du prototype (lignes 1250-1287)
// ==========================================
function goToStep(n) {
  console.log(`[ONBOARDING] goToStep(${n}), currentStep=${currentStep}, overlayEl=${!!overlayEl}`)
  if (!overlayEl || n === currentStep) return
  const modal = overlayEl.querySelector('.onboarding-modal')
  if (!modal) { console.error('[ONBOARDING] goToStep: modal not found!'); return }

  // Hide ALL steps cleanly
  modal.querySelectorAll('.step-view').forEach(s => {
    s.classList.remove('active')
    s.style.display = 'none'
  })

  // Show target step
  const next = overlayEl.querySelector(`#ob-step-${n}`)
  if (!next) { console.error(`[ONBOARDING] goToStep: #ob-step-${n} not found!`); return }
  next.style.display = 'flex'
  // Force reflow to ensure animation replays
  void next.offsetHeight
  next.classList.add('active')
  currentStep = n

  // Reset modal height when leaving auth step
  if (n !== 3) {
    modal.style.minHeight = '440px'
  }

  updateStepDots(n)

  // Step-specific init
  if (n === 2) initDiscovery()
  if (n === 3) initAuth()
  if (n === 4) initBrowse()
  if (n === 5) { /* scan is started by the caller */ }
}

function updateStepDots(n) {
  if (!overlayEl) return
  const dots = overlayEl.querySelectorAll('.step-dot')
  let dotIdx = n <= 1 ? 0 : n <= 4 ? 1 : 2
  dots.forEach((dot, i) => {
    dot.classList.remove('active', 'done')
    if (i < dotIdx) dot.classList.add('done')
    else if (i === dotIdx) dot.classList.add('active')
  })
}

// ==========================================
// Bind all events
// ==========================================
function bindAllEvents() {
  if (!overlayEl) return

  // === Card interactions — prototype lignes 1292-1317 ===
  overlayEl.querySelectorAll('.source-card').forEach(card => {
    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect()
      const x = (e.clientX - rect.left) / rect.width - 0.5
      const y = (e.clientY - rect.top) / rect.height - 0.5
      card.style.transform = `translateY(-2px) perspective(600px) rotateX(${-y * 4}deg) rotateY(${x * 4}deg)`
    })
    card.addEventListener('mouseleave', () => { card.style.transform = '' })

    card.addEventListener('click', (e) => {
      const ripple = document.createElement('div')
      const rect = card.getBoundingClientRect()
      const size = Math.max(rect.width, rect.height) * 2
      Object.assign(ripple.style, {
        position: 'absolute', width: size + 'px', height: size + 'px',
        borderRadius: '50%', background: 'rgba(255,255,255,0.06)',
        left: (e.clientX - rect.left - size / 2) + 'px',
        top: (e.clientY - rect.top - size / 2) + 'px',
        transform: 'scale(0)', transition: 'transform 0.6s ease, opacity 0.6s ease',
        pointerEvents: 'none', zIndex: '0'
      })
      card.appendChild(ripple)
      requestAnimationFrame(() => { ripple.style.transform = 'scale(1)'; ripple.style.opacity = '0' })
      setTimeout(() => ripple.remove(), 600)
    })
  })

  // Local card click → select folder via Tauri
  document.getElementById('card-local')?.addEventListener('click', () => {
    setTimeout(async () => {
      try {
        const path = await invoke('select_folder')
        if (!path) return
        await invoke('add_library_path', { path })
        goToStep(5)
        startLocalScan()
      } catch (e) {
        console.error('[ONBOARDING] select_folder error:', e)
        showToast('Failed to select folder')
      }
    }, 300)
  })

  // NAS card click
  document.getElementById('card-nas')?.addEventListener('click', () => {
    setTimeout(() => goToStep(2), 300)
  })

  // Skip link
  document.getElementById('ob-skip')?.addEventListener('click', skipOnboarding)

  // === Discovery tabs — prototype lignes 1329-1338 ===
  overlayEl.querySelectorAll('.discovery-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      overlayEl.querySelectorAll('.discovery-tab').forEach(t => t.classList.remove('active'))
      tab.classList.add('active')
      const isManual = tab.dataset.tab === 'manual'
      document.getElementById('ob-discover-content').style.display = isManual ? 'none' : ''
      const manual = document.getElementById('ob-manual-content')
      if (isManual) { manual.classList.add('active'); manual.querySelector('input')?.focus() }
      else manual.classList.remove('active')
    })
  })

  // Manual IP input
  document.getElementById('ob-manual-ip')?.addEventListener('input', () => {
    const manualTab = overlayEl.querySelector('.discovery-tab[data-tab="manual"]')
    const nextBtn = document.getElementById('ob-btn-nas-next')
    if (nextBtn && manualTab?.classList.contains('active')) {
      nextBtn.disabled = !document.getElementById('ob-manual-ip').value.trim()
    }
  })

  // Step 2 buttons
  document.getElementById('ob-back-2')?.addEventListener('click', () => goToStep(1))
  document.getElementById('ob-btn-nas-next')?.addEventListener('click', () => {
    console.log('[ONBOARDING] Continue clicked')
    const manualTab = overlayEl.querySelector('.discovery-tab[data-tab="manual"]')
    if (manualTab?.classList.contains('active')) {
      const ip = document.getElementById('ob-manual-ip')?.value?.trim()
      if (ip) { nasState.host = ip; nasState.deviceName = ip; goToStep(3) }
    } else {
      const selected = overlayEl.querySelector('.device-item.selected')
      console.log('[ONBOARDING] Selected device:', selected?.dataset?.host, 'deviceName:', selected?.querySelector('.device-name')?.textContent)
      if (selected) {
        nasState.host = selected.dataset.host || ''
        nasState.deviceName = selected.querySelector('.device-name')?.textContent || nasState.host
        console.log('[ONBOARDING] → goToStep(3), nasState.host =', nasState.host)
        goToStep(3)
      } else {
        console.warn('[ONBOARDING] No device selected, Continue ignored')
      }
    }
  })

  // === Auth toggle — prototype lignes 1354-1370 ===
  const guestToggle = document.getElementById('ob-guest-toggle')
  const credsFields = document.getElementById('ob-creds-fields')
  const modal = overlayEl.querySelector('.onboarding-modal')

  guestToggle?.addEventListener('change', () => {
    if (guestToggle.checked) {
      credsFields.classList.remove('visible')
      modal.style.minHeight = '440px'
      nasState.isGuest = true
    } else {
      credsFields.classList.add('visible')
      modal.style.minHeight = '540px'
      nasState.isGuest = false
      setTimeout(() => document.getElementById('ob-username')?.focus(), 300)
    }
  })

  // Step 3 buttons
  document.getElementById('ob-back-3')?.addEventListener('click', () => goToStep(2))
  document.getElementById('ob-btn-connect')?.addEventListener('click', async () => {
    const btn = document.getElementById('ob-btn-connect')
    btn.disabled = true
    btn.textContent = 'Connecting...'
    try {
      if (!nasState.isGuest) {
        nasState.username = document.getElementById('ob-username')?.value || ''
        nasState.password = document.getElementById('ob-password')?.value || ''
        nasState.rememberCreds = document.getElementById('ob-remember-toggle')?.checked || false
      }
      await invoke('smb_connect', {
        host: nasState.host,
        username: nasState.isGuest ? 'guest' : nasState.username,
        password: nasState.isGuest ? '' : nasState.password,
        domain: null,
        isGuest: nasState.isGuest
      })
      const shares = await invoke('smb_list_shares', { host: nasState.host })
      browseShares = shares || []
      goToStep(4)
    } catch (e) {
      console.error('[ONBOARDING] SMB connect error:', e)
      showToast('Connection failed: ' + (e?.message || e))
    } finally {
      btn.disabled = false
      btn.textContent = 'Connect & Browse'
    }
  })

  // Step 4 buttons
  document.getElementById('ob-back-4')?.addEventListener('click', () => goToStep(3))
  document.getElementById('ob-btn-add-folder')?.addEventListener('click', async () => {
    if (!selectedFolder) return
    const btn = document.getElementById('ob-btn-add-folder')
    btn.disabled = true
    btn.textContent = 'Adding...'
    try {
      const fullPath = browsePath === '/' ? `/${selectedFolder}` : `${browsePath}/${selectedFolder}`
      const result = await invoke('add_network_source', {
        name: nasState.deviceName || nasState.host,
        host: nasState.host,
        share: nasState.share || browseShares[0] || '',
        path: fullPath,
        username: nasState.isGuest ? 'guest' : nasState.username,
        password: nasState.isGuest ? '' : nasState.password,
        domain: null,
        isGuest: nasState.isGuest
      })
      console.log('[ONBOARDING] add_network_source result:', result)
      goToStep(5)
      startNetworkScan(result.id)
    } catch (e) {
      console.error('[ONBOARDING] add_network_source error:', e)
      showToast('Failed to add folder: ' + (e?.message || e))
      btn.disabled = false
      btn.textContent = 'Add this folder'
    }
  })

  // Step 6 button
  document.getElementById('ob-btn-start')?.addEventListener('click', finishOnboarding)
}

// ==========================================
// Step 2: NAS Discovery
// ==========================================
function initDiscovery() {
  if (!overlayEl) return
  const deviceList = document.getElementById('ob-device-list')
  if (deviceList) deviceList.innerHTML = ''
  const nextBtn = document.getElementById('ob-btn-nas-next')
  if (nextBtn) nextBtn.disabled = true

  startNASDiscovery()
}

async function startNASDiscovery() {
  try {
    const unlisten = await listen('nas_device_found', (event) => {
      const device = event.payload
      console.log('[ONBOARDING] nas_device_found:', JSON.stringify(device))
      if (!device || !overlayEl) return
      addDeviceToList(device)
    })
    scanUnlisteners.push(unlisten)
    await invoke('discover_nas_devices')
  } catch (e) {
    console.error('[ONBOARDING] NAS discovery error:', e)
  }
}

function addDeviceToList(device) {
  if (!overlayEl) return
  const list = document.getElementById('ob-device-list')
  if (!list) return
  // DiscoveredNas struct: { hostname, ip, port, display_name }
  // IPv4 → use IP directly. IPv6-only → use hostname (.local) for SMB compatibility
  const hasIPv4 = device.ip && /^\d+\.\d+\.\d+\.\d+$/.test(device.ip)
  const host = hasIPv4 ? device.ip : (device.hostname || device.ip || '')
  const displayName = device.display_name || device.hostname || device.ip || 'Unknown'
  if (list.querySelector(`.device-item[data-host="${CSS.escape(host)}"]`)) return

  const item = document.createElement('div')
  item.className = 'device-item'
  item.dataset.host = host
  item.innerHTML = `
    <div class="device-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="2" y="7" width="20" height="10" rx="2"/><line x1="6" y1="12" x2="6.01" y2="12"/>
      </svg>
    </div>
    <div>
      <div class="device-name">${esc(displayName)}</div>
      <div class="device-ip">${esc(device.ip || host)}</div>
    </div>
    <div class="device-status"></div>
  `
  item.addEventListener('click', () => {
    list.querySelectorAll('.device-item').forEach(i => i.classList.remove('selected'))
    item.classList.add('selected')
    const nextBtn = document.getElementById('ob-btn-nas-next')
    if (nextBtn) nextBtn.disabled = false
  })
  list.appendChild(item)
}

// ==========================================
// Step 3: Auth
// ==========================================
function initAuth() {
  if (!overlayEl) return
  const nameEl = document.getElementById('ob-nas-name')
  const ipEl = document.getElementById('ob-nas-ip')
  if (nameEl) nameEl.textContent = nasState.deviceName || nasState.host
  if (ipEl) ipEl.textContent = nasState.host

  const guestToggle = document.getElementById('ob-guest-toggle')
  if (guestToggle) { guestToggle.checked = true; nasState.isGuest = true }
  const credsEl = document.getElementById('ob-creds-fields')
  if (credsEl) credsEl.classList.remove('visible')
}

// ==========================================
// Step 4: Browse — logique du prototype (lignes 1372-1461)
// ==========================================
function initBrowse() {
  if (!overlayEl) return
  browsePath = '/'
  selectedFolder = null
  nasState.share = ''
  const addBtn = document.getElementById('ob-btn-add-folder')
  if (addBtn) { addBtn.disabled = true; addBtn.textContent = 'Add this folder' }

  if (browseShares.length > 0) renderSharesList()
  else renderFolderList()
  updateBrowsePath()
}

function renderSharesList() {
  const list = document.getElementById('ob-folder-list')
  if (!list) return
  list.innerHTML = ''

  browseShares.forEach(share => {
    // share is an object { name: "shareName", ... } from smb_list_shares
    const shareName = share.name || share
    const item = document.createElement('div')
    item.className = 'folder-item'
    item.dataset.folder = shareName
    item.innerHTML = `${FOLDER_SVG}<span>${esc(shareName)}</span><span class="folder-chevron">&#8250;</span>`

    item.addEventListener('click', () => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return }
      clickTimer = setTimeout(() => {
        clickTimer = null
        list.querySelectorAll('.folder-item').forEach(i => i.classList.remove('selected'))
        item.classList.add('selected')
        selectedFolder = shareName
        nasState.share = shareName
        const addBtn = document.getElementById('ob-btn-add-folder')
        if (addBtn) addBtn.disabled = false
      }, 220)
    })

    item.addEventListener('dblclick', () => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null }
      nasState.share = shareName
      browsePath = '/'
      selectedFolder = null
      const addBtn = document.getElementById('ob-btn-add-folder')
      if (addBtn) addBtn.disabled = true
      browseRemoteFolder()
    })

    list.appendChild(item)
  })
}

async function browseRemoteFolder() {
  const list = document.getElementById('ob-folder-list')
  if (!list) return
  updateBrowsePath()
  list.innerHTML = `<div class="discovery-spinner"><div class="spinner-ring"></div><span>Loading...</span></div>`

  try {
    const entries = await invoke('smb_browse', { host: nasState.host, share: nasState.share, path: browsePath })
    renderFolderEntries(entries || [])
  } catch (e) {
    console.error('[ONBOARDING] smb_browse error:', e)
    list.innerHTML = `<div style="font-size:11px;color:#666;text-align:center;padding:24px 0;">Failed to browse folder</div>`
  }
}

function renderFolderEntries(entries) {
  const list = document.getElementById('ob-folder-list')
  if (!list) return
  list.innerHTML = ''

  // Back item
  if (browsePath !== '/') {
    const backItem = document.createElement('div')
    backItem.className = 'folder-item'
    backItem.style.color = 'var(--color-text-faint)'
    backItem.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg><span>..</span>`
    backItem.addEventListener('click', () => {
      const parts = browsePath.split('/').filter(Boolean)
      parts.pop()
      browsePath = parts.length ? '/' + parts.join('/') : '/'
      selectedFolder = null
      document.getElementById('ob-btn-add-folder').disabled = true
      browseRemoteFolder()
    })
    list.appendChild(backItem)
  } else if (nasState.share) {
    const backItem = document.createElement('div')
    backItem.className = 'folder-item'
    backItem.style.color = 'var(--color-text-faint)'
    backItem.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg><span>..</span>`
    backItem.addEventListener('click', () => {
      nasState.share = ''
      browsePath = '/'
      selectedFolder = null
      document.getElementById('ob-btn-add-folder').disabled = true
      renderSharesList()
      updateBrowsePath()
    })
    list.appendChild(backItem)
  }

  const folders = entries.filter(e => e.is_dir)
  folders.forEach(entry => {
    const name = entry.name || String(entry)
    const item = document.createElement('div')
    item.className = 'folder-item'
    item.dataset.folder = name
    item.innerHTML = `${FOLDER_SVG}<span>${esc(name)}</span><span class="folder-chevron">&#8250;</span>`

    item.addEventListener('click', () => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return }
      clickTimer = setTimeout(() => {
        clickTimer = null
        list.querySelectorAll('.folder-item').forEach(i => i.classList.remove('selected'))
        item.classList.add('selected')
        selectedFolder = name
        document.getElementById('ob-btn-add-folder').disabled = false
      }, 220)
    })

    item.addEventListener('dblclick', () => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null }
      browsePath = browsePath === '/' ? `/${name}` : `${browsePath}/${name}`
      selectedFolder = null
      document.getElementById('ob-btn-add-folder').disabled = true
      browseRemoteFolder()
    })

    list.appendChild(item)
  })

  if (folders.length === 0 && !list.querySelector('.folder-item')) {
    list.innerHTML = `<div style="font-size:11px;color:#666;text-align:center;padding:24px 0;">No folders found</div>`
  }
}

function renderFolderList() {
  const list = document.getElementById('ob-folder-list')
  if (!list) return
  list.innerHTML = `<div style="font-size:11px;color:#666;text-align:center;padding:24px 0;">No shares available</div>`
}

function updateBrowsePath() {
  const pathEl = document.getElementById('ob-browse-path-text')
  if (!pathEl) return
  const sharePrefix = nasState.share ? `/${nasState.share}` : ''
  pathEl.textContent = `//${nasState.host}${sharePrefix}${browsePath === '/' ? '/' : browsePath}`
}

// ==========================================
// Step 5: Scanning
// ==========================================
function startLocalScan() {
  resetScanUI('local')
  listenForScanEvents('local')
  if (app.startBackgroundScan) app.startBackgroundScan()
}

function startNetworkScan(sourceId) {
  resetScanUI('network')
  listenForScanEvents('network')
  invoke('scan_network_source_cmd', { sourceId }).catch(e => {
    console.error('[ONBOARDING] scan_network_source_cmd error:', e)
  })
}

function resetScanUI(scanType) {
  const fill = document.getElementById('ob-scan-fill')
  const count = document.getElementById('ob-scan-count')
  const folder = document.getElementById('ob-scan-folder')
  const progressBar = document.getElementById('ob-scan-fill')?.parentElement

  if (count) count.textContent = '0'
  if (folder) folder.textContent = ''

  if (scanType === 'network') {
    // Network scan: determinate progress (current/total tracks available)
    if (fill) { fill.style.animation = 'none'; fill.style.transition = 'width 0.3s ease'; fill.style.width = '0%'; fill.style.marginLeft = '0' }
    if (progressBar) progressBar.style.display = ''
  } else {
    // Local scan: indeterminate — progress bar hidden, only folder names + loader visible
    if (progressBar) progressBar.style.display = 'none'
    if (fill) { fill.style.width = '0%'; fill.style.marginLeft = '0'; fill.style.animation = 'none' }
  }
}

async function listenForScanEvents(scanType) {
  try {
    // scan_progress payload: { phase: "scanning"|"scanning_network", current: N, total: N, folder: "name" }
    const unlistenProgress = await listen('scan_progress', (event) => {
      if (!overlayEl) return
      const data = event.payload
      if (!data) return

      const fill = document.getElementById('ob-scan-fill')
      const count = document.getElementById('ob-scan-count')
      const folder = document.getElementById('ob-scan-folder')

      // Network scan: determinate progress bar + track count
      if (data.phase === 'scanning_network' && data.total > 0) {
        const percent = Math.min(Math.round((data.current / data.total) * 100), 100)
        if (fill) fill.style.width = percent + '%'
        if (count) count.textContent = data.current.toLocaleString()
      }

      // Both scan types: show folder name
      if (data.folder && folder) {
        folder.textContent = data.folder
      }
    })
    scanUnlisteners.push(unlistenProgress)

    // scan_complete payload: { stats: { mp3_count, flac_16bit_count, flac_24bit_count, albums_count, artists_count, total_tracks, ... }, new_tracks, removed_tracks }
    const unlistenComplete = await listen('scan_complete', async (event) => {
      if (!overlayEl) return
      const data = event.payload
      const fill = document.getElementById('ob-scan-fill')
      if (fill) { fill.style.animation = 'none'; fill.style.width = '100%'; fill.style.marginLeft = '0' }
      // Show progress bar at 100% for completion
      const progressBar = fill?.parentElement
      if (progressBar) progressBar.style.display = ''

      const stats = data?.stats || data || {}
      if (stats.mp3_count != null) {
        scanStats.tracks = (stats.mp3_count || 0) + (stats.flac_16bit_count || 0) + (stats.flac_24bit_count || 0) + (stats.other_count || 0)
      } else {
        scanStats.tracks = stats.total_tracks || 0
      }
      scanStats.albums = stats.albums_count || 0
      scanStats.artists = stats.artists_count || 0
      console.log('[ONBOARDING] scan_complete stats:', JSON.stringify(scanStats))

      const count = document.getElementById('ob-scan-count')
      if (count && scanStats.tracks > 0) count.textContent = scanStats.tracks.toLocaleString()

      setTimeout(() => {
        if (!overlayEl) return
        goToStep(6)
        updateDoneStats()
      }, 800)
    })
    scanUnlisteners.push(unlistenComplete)
  } catch (e) {
    console.error('[ONBOARDING] Error setting up scan listeners:', e)
  }
}

// ==========================================
// Step 6: Done
// ==========================================
function updateDoneStats() {
  const t = document.getElementById('ob-stat-tracks')
  const a = document.getElementById('ob-stat-albums')
  const r = document.getElementById('ob-stat-artists')
  if (t) t.textContent = scanStats.tracks.toLocaleString()
  if (a) a.textContent = scanStats.albums.toLocaleString()
  if (r) r.textContent = scanStats.artists.toLocaleString()
}

// ==========================================
// Finish — transition vers l'app
// ==========================================
async function finishOnboarding() {
  try {
    const [cachedTracks, cachedStats] = await invoke('load_tracks_from_cache')
    library.tracks.length = 0
    for (const t of cachedTracks) library.tracks.push(t)

    let addedDates = {}
    try { addedDates = await invoke('get_added_dates') || {} } catch (_) {}
    library.trackAddedDates = addedDates

    app.groupTracksIntoAlbumsAndArtists()
    app.buildTrackLookup()

    if (dom.welcomeDiv) dom.welcomeDiv.classList.add('hidden')
    ui.currentView = 'home'
    app.displayCurrentView()
    if (app.updatePlaylistsSidebar) app.updatePlaylistsSidebar()
    if (cachedStats) app.updateIndexationStats(cachedStats)

    hideOnboarding()
  } catch (e) {
    console.error('[ONBOARDING] finishOnboarding error:', e)
    showToast('Error loading library')
    hideOnboarding()
  }
}

// ==========================================
// Skip — ferme et montre le bouton setup
// ==========================================
function skipOnboarding() {
  hideOnboarding()
  if (dom.welcomeDiv) dom.welcomeDiv.classList.remove('hidden')
  const setupBtn = document.getElementById('setup-library-btn')
  const openBtn = document.getElementById('open-folder-welcome')
  if (setupBtn) setupBtn.style.display = ''
  if (openBtn) openBtn.style.display = 'none'
}

// ==========================================
// Utility
// ==========================================
function esc(str) {
  const div = document.createElement('div')
  div.textContent = str || ''
  return div.innerHTML
}
