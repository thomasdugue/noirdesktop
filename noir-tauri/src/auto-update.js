// auto-update.js — Gestion des mises à jour automatiques

import { showToast } from './utils.js';

let pendingUpdate = null

async function checkForUpdates(showNoUpdateToast = false) {
  const statusEl = document.getElementById('settings-update-status')
  const availableRow = document.getElementById('settings-update-available')

  try {
    const { check } = window.__TAURI__.updater
    if (!check) {
      if (showNoUpdateToast) showToast('Check not available')
      return
    }

    if (statusEl) statusEl.textContent = 'Checking...'

    const update = await check()
    if (update?.available) {
      pendingUpdate = update
      const versionEl = document.getElementById('settings-update-version')
      if (versionEl) versionEl.textContent = `Update available: v${update.version}`
      if (availableRow) availableRow.style.display = 'flex'
      if (statusEl) statusEl.textContent = `Version actuelle : ${await getAppVersion()}`
      showToast(`Update v${update.version} available`)
    } else {
      pendingUpdate = null
      if (availableRow) availableRow.style.display = 'none'
      if (statusEl) statusEl.textContent = `Up to date — v${await getAppVersion()}`
      if (showNoUpdateToast) showToast('No update available')
    }
  } catch (e) {
    console.log('[UPDATE] Check failed (expected if no server):', e)
    if (statusEl) statusEl.textContent = `Version actuelle : ${await getAppVersion()}`
    if (showNoUpdateToast) showToast('Unable to check for updates')
  }
}

async function installUpdate() {
  if (!pendingUpdate) return
  try {
    showToast('Installing update...')
    await pendingUpdate.downloadAndInstall()
    showToast('Update installed — restarting...')
    const { relaunch } = window.__TAURI__.process
    if (relaunch) await relaunch()
  } catch (e) {
    console.error('[UPDATE] Install failed:', e)
    showToast('Error during installation')
  }
}

async function getAppVersion() {
  try {
    const { getVersion } = window.__TAURI__.app
    return await getVersion()
  } catch {
    return '0.1.0'
  }
}

async function updateVersionDisplay() {
  const version = await getAppVersion()
  const el = document.getElementById('settings-version-label')
  if (el) el.textContent = `Noir v${version}`
  const statusEl = document.getElementById('settings-update-status')
  if (statusEl) statusEl.textContent = `Version actuelle : ${version}`
}

export function initAutoUpdate() {
  // Auto-update toggle
  const autoUpdateToggle = document.getElementById('settings-auto-update')
  if (autoUpdateToggle) {
    const saved = localStorage.getItem('settings_auto_update')
    autoUpdateToggle.checked = saved !== 'false' // default: true
    autoUpdateToggle.addEventListener('change', () => {
      localStorage.setItem('settings_auto_update', autoUpdateToggle.checked)
    })
  }

  // Check button
  const checkBtn = document.getElementById('settings-check-update')
  if (checkBtn) {
    checkBtn.addEventListener('click', () => checkForUpdates(true))
  }

  // Install button
  const installBtn = document.getElementById('settings-install-update')
  if (installBtn) {
    installBtn.addEventListener('click', installUpdate)
  }

  // Version display
  updateVersionDisplay()

  // Startup check (silent, after 5s)
  const autoEnabled = localStorage.getItem('settings_auto_update') !== 'false'
  if (autoEnabled) {
    setTimeout(() => checkForUpdates(false), 5000)
  }
}
