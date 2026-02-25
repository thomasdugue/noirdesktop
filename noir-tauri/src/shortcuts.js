// shortcuts.js — Keyboard shortcuts module for Noir Desktop
// Handles both global (Tauri OS-level) and local (in-app keydown) shortcuts.

import { playback, library, ui, dom, favorites } from './state.js'
import { invoke } from './state.js'
import { app } from './app.js'
import { showToast } from './utils.js'

// === GLOBAL SHORTCUTS (OS-level via Tauri) ===

let globalShortcutsRegistered = false

async function initGlobalShortcuts() {
  // Avoid registering multiple times
  if (globalShortcutsRegistered) return

  try {
    const { register, unregisterAll } = window.__TAURI__.globalShortcut

    // Unregister all existing shortcuts first
    await unregisterAll()

    // Play/Pause : MediaPlayPause or Cmd/Ctrl+Shift+P
    try {
      await register('MediaPlayPause', () => {
        console.log('[SHORTCUT] MediaPlayPause triggered')
        app.togglePlay()
      })
      console.log('[SHORTCUTS] MediaPlayPause registered')
    } catch (e) {
      console.log('[SHORTCUTS] MediaPlayPause not available, trying Ctrl+Shift+P')
      try {
        const playPauseKey = navigator.platform.includes('Mac') ? 'Cmd+Shift+P' : 'Ctrl+Shift+P'
        await register(playPauseKey, () => {
          console.log('[SHORTCUT] Play/Pause triggered')
          app.togglePlay()
        })
        console.log(`[SHORTCUTS] ${playPauseKey} registered for Play/Pause`)
      } catch (e2) {
        console.warn('[SHORTCUTS] Could not register play/pause shortcut:', e2)
      }
    }

    // Next track : MediaTrackNext or Cmd/Ctrl+Shift+Right
    try {
      await register('MediaTrackNext', () => {
        console.log('[SHORTCUT] MediaTrackNext triggered')
        app.playNextTrack()
      })
      console.log('[SHORTCUTS] MediaTrackNext registered')
    } catch (e) {
      try {
        const nextKey = navigator.platform.includes('Mac') ? 'Cmd+Shift+Right' : 'Ctrl+Shift+Right'
        await register(nextKey, () => {
          console.log('[SHORTCUT] Next track triggered')
          app.playNextTrack()
        })
        console.log(`[SHORTCUTS] ${nextKey} registered for Next`)
      } catch (e2) {
        console.warn('[SHORTCUTS] Could not register next track shortcut:', e2)
      }
    }

    // Previous track : MediaTrackPrevious or Cmd/Ctrl+Shift+Left
    try {
      await register('MediaTrackPrevious', () => {
        console.log('[SHORTCUT] MediaTrackPrevious triggered')
        app.playPreviousTrack()
      })
      console.log('[SHORTCUTS] MediaTrackPrevious registered')
    } catch (e) {
      try {
        const prevKey = navigator.platform.includes('Mac') ? 'Cmd+Shift+Left' : 'Ctrl+Shift+Left'
        await register(prevKey, () => {
          console.log('[SHORTCUT] Previous track triggered')
          app.playPreviousTrack()
        })
        console.log(`[SHORTCUTS] ${prevKey} registered for Previous`)
      } catch (e2) {
        console.warn('[SHORTCUTS] Could not register previous track shortcut:', e2)
      }
    }

    // Volume Up : MediaVolumeUp or Cmd/Ctrl+Shift+Up
    try {
      await register('MediaVolumeUp', () => {
        console.log('[SHORTCUT] MediaVolumeUp triggered')
        adjustVolume(0.1)
      })
      console.log('[SHORTCUTS] MediaVolumeUp registered')
    } catch (e) {
      try {
        const volUpKey = navigator.platform.includes('Mac') ? 'Cmd+Shift+Up' : 'Ctrl+Shift+Up'
        await register(volUpKey, () => {
          console.log('[SHORTCUT] Volume up triggered')
          adjustVolume(0.1)
        })
        console.log(`[SHORTCUTS] ${volUpKey} registered for Volume Up`)
      } catch (e2) {
        console.warn('[SHORTCUTS] Could not register volume up shortcut:', e2)
      }
    }

    // Volume Down : MediaVolumeDown or Cmd/Ctrl+Shift+Down
    try {
      await register('MediaVolumeDown', () => {
        console.log('[SHORTCUT] MediaVolumeDown triggered')
        adjustVolume(-0.1)
      })
      console.log('[SHORTCUTS] MediaVolumeDown registered')
    } catch (e) {
      try {
        const volDownKey = navigator.platform.includes('Mac') ? 'Cmd+Shift+Down' : 'Ctrl+Shift+Down'
        await register(volDownKey, () => {
          console.log('[SHORTCUT] Volume down triggered')
          adjustVolume(-0.1)
        })
        console.log(`[SHORTCUTS] ${volDownKey} registered for Volume Down`)
      } catch (e2) {
        console.warn('[SHORTCUTS] Could not register volume down shortcut:', e2)
      }
    }

    // Mute : MediaMute or Cmd/Ctrl+Shift+M
    try {
      await register('MediaMute', () => {
        console.log('[SHORTCUT] MediaMute triggered')
        toggleMute()
      })
      console.log('[SHORTCUTS] MediaMute registered')
    } catch (e) {
      try {
        const muteKey = navigator.platform.includes('Mac') ? 'Cmd+Shift+M' : 'Ctrl+Shift+M'
        await register(muteKey, () => {
          console.log('[SHORTCUT] Mute triggered')
          toggleMute()
        })
        console.log(`[SHORTCUTS] ${muteKey} registered for Mute`)
      } catch (e2) {
        console.warn('[SHORTCUTS] Could not register mute shortcut:', e2)
      }
    }

    // F7 / F8 / F9 — touches fonction Mac (mode "function keys" activé)
    // En complément des Media* keys, pour couvrir les deux modes clavier macOS
    const macFnKeys = [
      { key: 'F7', action: () => app.playPreviousTrack(), label: 'Previous' },
      { key: 'F8', action: () => app.togglePlay(),        label: 'Play/Pause' },
      { key: 'F9', action: () => app.playNextTrack(),     label: 'Next' },
    ]
    for (const { key, action, label } of macFnKeys) {
      try {
        await register(key, action)
        console.log(`[SHORTCUTS] ${key} registered for ${label}`)
      } catch (e) {
        console.warn(`[SHORTCUTS] ${key} not available for ${label}:`, e)
      }
    }

    globalShortcutsRegistered = true
    console.log('[SHORTCUTS] Global shortcuts initialized successfully')

  } catch (error) {
    console.error('[SHORTCUTS] Error initializing global shortcuts:', error)
  }
}

// === VOLUME HELPERS ===

// Adjust volume by a relative delta (delta in 0-1 range)
function adjustVolume(delta) {
  // volumeBar uses a 0-100 scale
  const currentVolumePercent = dom.volumeBar ? parseFloat(dom.volumeBar.value) : 100
  const deltaPercent = delta * 100 // Convert delta 0-1 to 0-100
  const newVolumePercent = Math.max(0, Math.min(100, currentVolumePercent + deltaPercent))
  const newVolumeNormalized = newVolumePercent / 100 // For Rust backend (0-1)

  if (dom.volumeBar) {
    dom.volumeBar.value = newVolumePercent
    updateVolumeIcon(newVolumeNormalized)
  }

  // Send to Rust backend (expects 0-1)
  invoke('audio_set_volume', { volume: newVolumeNormalized }).catch(console.error)

  // Visual feedback
  showToast(`Volume: ${Math.round(newVolumePercent)}%`)
}

// Toggle mute (uses playback.lastVolume from state)
function toggleMute() {
  const currentVolumePercent = dom.volumeBar ? parseFloat(dom.volumeBar.value) : 100

  if (currentVolumePercent > 0) {
    // Mute
    playback.lastVolume = currentVolumePercent
    if (dom.volumeBar) {
      dom.volumeBar.value = 0
      updateVolumeIcon(0)
    }
    invoke('audio_set_volume', { volume: 0 }).catch(console.error)
    showToast('Volume: Muted')
  } else {
    // Unmute
    const restorePercent = playback.lastVolume || 100
    if (dom.volumeBar) {
      dom.volumeBar.value = restorePercent
      updateVolumeIcon(restorePercent / 100)
    }
    invoke('audio_set_volume', { volume: restorePercent / 100 }).catch(console.error)
    showToast(`Volume: ${Math.round(restorePercent)}%`)
  }
}

// Update the volume icon based on normalized volume (0-1)
// Matches the SVG path swap approach used in the main player UI
function updateVolumeIcon(volume) {
  const iconPath = document.getElementById('volume-icon-path')
  if (!iconPath) return
  if (volume === 0) {
    // Mute
    iconPath.setAttribute('d', 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z')
  } else if (volume < 0.5) {
    // Low
    iconPath.setAttribute('d', 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z')
  } else {
    // High
    iconPath.setAttribute('d', 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z')
  }
}

// === CONFIGURABLE LOCAL SHORTCUTS ===

// Default shortcut bindings: { action: { key/code, modifiers, label } }
// key = e.key.toLowerCase() for letters, code = e.code for special keys
const DEFAULT_SHORTCUTS = {
  play_pause:     { code: 'Space', shift: false, meta: false, ctrl: false, alt: false, label: 'Play / Pause' },
  next_track:     { code: 'ArrowRight', shift: false, meta: true, ctrl: false, alt: false, label: 'Next track' },
  prev_track:     { code: 'ArrowLeft', shift: false, meta: true, ctrl: false, alt: false, label: 'Previous track' },
  seek_forward:   { code: 'ArrowRight', shift: true, meta: false, ctrl: false, alt: false, label: 'Seek forward 10s' },
  seek_backward:  { code: 'ArrowLeft', shift: true, meta: false, ctrl: false, alt: false, label: 'Seek backward 10s' },
  volume_up:      { code: 'ArrowUp', shift: true, meta: false, ctrl: false, alt: false, label: 'Volume up' },
  volume_down:    { code: 'ArrowDown', shift: true, meta: false, ctrl: false, alt: false, label: 'Volume down' },
  close_panel:    { code: 'Escape', shift: false, meta: false, ctrl: false, alt: false, label: 'Close panel' },
  settings:       { key: ',', shift: false, meta: true, ctrl: false, alt: false, label: 'Settings' },
  mute:           { key: 'm', shift: false, meta: false, ctrl: false, alt: false, label: 'Mute' },
  repeat:         { key: 'r', shift: false, meta: false, ctrl: false, alt: false, label: 'Repeat mode' },
  shuffle:        { key: 's', shift: false, meta: false, ctrl: false, alt: false, label: 'Shuffle' },
  favorite:       { key: 'l', shift: false, meta: false, ctrl: false, alt: false, label: 'Add to favorites' },
}

// Map action -> callback (all cross-module calls go through app mediator)
const SHORTCUT_ACTIONS = {
  play_pause:     () => app.togglePlay(),
  next_track:     () => app.playNextTrack(),
  prev_track:     () => app.playPreviousTrack(),
  seek_forward:   () => seekRelative(10),
  seek_backward:  () => seekRelative(-10),
  volume_up:      () => adjustVolume(0.05),
  volume_down:    () => adjustVolume(-0.05),
  close_panel:    () => app.closeAllPanels(),
  settings:       () => app.toggleSettings(),
  mute:           () => toggleMute(),
  repeat:         () => cycleRepeatMode(),
  shuffle:        () => toggleShuffleMode(),
  favorite:       () => toggleFavoriteFromKeyboard(),
}

// Active shortcuts (defaults merged with localStorage overrides)
let activeShortcuts = {}

function loadShortcuts() {
  // Clone defaults
  activeShortcuts = {}
  for (const [action, binding] of Object.entries(DEFAULT_SHORTCUTS)) {
    activeShortcuts[action] = { ...binding }
  }
  // Merge overrides from localStorage
  try {
    const saved = localStorage.getItem('keyboard_shortcuts')
    if (saved) {
      const overrides = JSON.parse(saved)
      for (const [action, binding] of Object.entries(overrides)) {
        if (activeShortcuts[action]) {
          activeShortcuts[action] = { ...activeShortcuts[action], ...binding }
        }
      }
    }
  } catch (e) {
    console.warn('[SHORTCUTS] Error loading saved shortcuts:', e)
  }
}

export function saveShortcuts() {
  // Only save differences from defaults
  const overrides = {}
  for (const [action, binding] of Object.entries(activeShortcuts)) {
    const def = DEFAULT_SHORTCUTS[action]
    if (!def) continue
    const changed = (binding.code !== def.code) || (binding.key !== def.key) ||
      (binding.shift !== def.shift) || (binding.meta !== def.meta) ||
      (binding.ctrl !== def.ctrl) || (binding.alt !== def.alt)
    if (changed) {
      overrides[action] = { code: binding.code, key: binding.key, shift: binding.shift, meta: binding.meta, ctrl: binding.ctrl, alt: binding.alt }
    }
  }
  if (Object.keys(overrides).length > 0) {
    localStorage.setItem('keyboard_shortcuts', JSON.stringify(overrides))
  } else {
    localStorage.removeItem('keyboard_shortcuts')
  }
}

// Check if a keydown event matches a shortcut binding
function matchesShortcut(event, binding) {
  // Check modifiers
  const metaMatch = binding.meta ? (event.metaKey || event.ctrlKey) : !(event.metaKey || event.ctrlKey)
  const shiftMatch = binding.shift ? event.shiftKey : !event.shiftKey
  const altMatch = binding.alt ? event.altKey : !event.altKey

  if (!metaMatch || !shiftMatch || !altMatch) return false

  // Check key: by code OR by key
  if (binding.code) return event.code === binding.code
  if (binding.key) return event.key.toLowerCase() === binding.key
  return false
}

// Format a shortcut for display (symbols: command, shift, option, ctrl + key)
export function formatShortcutDisplay(binding) {
  const parts = []
  if (binding.meta) parts.push('\u2318')
  if (binding.ctrl) parts.push('\u2303')
  if (binding.alt) parts.push('\u2325')
  if (binding.shift) parts.push('\u21E7')

  // Main key
  const keyName = binding.code || binding.key || '?'
  const displayNames = {
    'Space': '\u2423', 'ArrowRight': '\u2192', 'ArrowLeft': '\u2190',
    'ArrowUp': '\u2191', 'ArrowDown': '\u2193', 'Escape': 'Esc',
    ',': ',',
  }
  parts.push(displayNames[keyName] || keyName.toUpperCase())
  return parts.join(' ')
}

// === LOCAL KEYDOWN HANDLER ===

function handleKeyDown(e) {
  // Ignore if typing in a text field (unless it's a shortcut capture)
  if (e.target.matches('input, textarea, [contenteditable]')) return

  // Test each active shortcut
  for (const [action, binding] of Object.entries(activeShortcuts)) {
    if (matchesShortcut(e, binding)) {
      e.preventDefault()
      const callback = SHORTCUT_ACTIONS[action]
      if (callback) callback()
      return
    }
  }
}

// === HELPER ACTIONS (internal to shortcuts module) ===

// Toggle favorite from keyboard shortcut (no button element needed)
async function toggleFavoriteFromKeyboard() {
  if (playback.currentTrackIndex < 0 || !library.tracks[playback.currentTrackIndex]) {
    showToast('No track playing')
    return
  }

  const track = library.tracks[playback.currentTrackIndex]
  const trackPath = track.path
  const trackTitle = track.metadata?.title || track.name

  try {
    const isNowFavorite = await invoke('toggle_favorite', { trackPath })

    // Update the local Set
    if (isNowFavorite) {
      favorites.tracks.add(trackPath)
      showToast(`"${trackTitle}" added to favorites`)
      // Show heart animation on the player cover art
      showHeartAnimation()
    } else {
      favorites.tracks.delete(trackPath)
      showToast(`"${trackTitle}" removed from favorites`)
    }

    // Update the favorite icon in the player if visible
    updatePlayerFavoriteIcon(trackPath, isNowFavorite)

    // Reload playlists to update the counter
    if (app.loadPlaylists) await app.loadPlaylists()
  } catch (err) {
    console.error('Error toggle favorite:', err)
    showToast('Error toggling favorite')
  }
}

// Show a floating heart animation on the player cover art
function showHeartAnimation() {
  const coverArt = document.getElementById('cover-art')
  if (!coverArt) return

  // Create the heart element with white SVG
  const heart = document.createElement('div')
  heart.className = 'like-heart-animation'
  heart.innerHTML = `<svg width="32" height="32" viewBox="0 0 24 24" fill="#fff" stroke="none">
    <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
  </svg>`

  // Append to the cover's parent (for relative positioning)
  const coverContainer = coverArt.closest('.cover-art') || coverArt.parentElement
  if (coverContainer) {
    coverContainer.style.position = 'relative'
    coverContainer.appendChild(heart)

    // Remove after animation completes
    setTimeout(() => {
      heart.remove()
    }, 800)
  }
}

// Update the favorite icon in the player for a given track
function updatePlayerFavoriteIcon(trackPath, isFavorite) {
  // Find all visible favorite buttons for this track
  const buttons = document.querySelectorAll(`.btn-favorite[data-track-path="${trackPath}"]`)
  buttons.forEach(btn => {
    btn.classList.toggle('active', isFavorite)
    const svg = btn.querySelector('svg')
    if (svg) {
      svg.setAttribute('fill', isFavorite ? 'currentColor' : 'none')
    }
  })
}

// Close all open panels
function closeAllPanels() {
  // Close album detail
  if (typeof app.closeAlbumDetail === 'function') {
    app.closeAlbumDetail()
  }

  // Close context menu
  if (typeof app.hideContextMenu === 'function') {
    app.hideContextMenu()
  }

  // Close playlist context menus
  document.querySelectorAll('.playlist-context-menu').forEach(m => m.remove())

  // Close audio output menu
  const audioOutputMenu = document.getElementById('audio-output-menu')
  if (audioOutputMenu && !audioOutputMenu.classList.contains('hidden')) {
    audioOutputMenu.classList.add('hidden')
    const audioOutputBtn = document.getElementById('audio-output-btn')
    if (audioOutputBtn) audioOutputBtn.classList.remove('active')
  }

  // Close playlist modal
  const playlistModal = document.getElementById('playlist-modal')
  if (playlistModal && !playlistModal.classList.contains('hidden')) {
    playlistModal.classList.add('hidden')
  }

  // Close side panels
  if (ui.isQueuePanelOpen && app.toggleQueuePanel) app.toggleQueuePanel()
  if (ui.isTrackInfoPanelOpen && app.closeTrackInfoPanel) app.closeTrackInfoPanel()
  if (ui.isSettingsPanelOpen && app.closeSettings) app.closeSettings()
  if (app.getEqPanelOpen && app.getEqPanelOpen() && app.closeEqPanel) app.closeEqPanel()
}

// Seek relative in seconds
function seekRelative(seconds) {
  // Use the current progress slider position (more reliable)
  const progressSlider = document.getElementById('progress')
  let currentPos = playback.audioPositionFromRust

  // If the slider exists, use its value as reference
  if (progressSlider && playback.audioDurationFromRust > 0) {
    currentPos = (parseFloat(progressSlider.value) / 100) * playback.audioDurationFromRust
  }

  const newPosition = Math.max(0, Math.min(playback.audioDurationFromRust, currentPos + seconds))
  console.log('[SEEK] Seeking from', currentPos.toFixed(2), 'to', newPosition.toFixed(2), '(delta:', seconds, ')')

  invoke('audio_seek', { time: newPosition }).catch(err => {
    console.error('[SEEK] Error:', err)
  })
}

// Cycle repeat mode (off -> all -> one -> off)
function cycleRepeatMode() {
  const modes = ['off', 'all', 'one']
  const currentIndex = modes.indexOf(playback.repeatMode)
  const nextIndex = (currentIndex + 1) % modes.length
  playback.repeatMode = modes[nextIndex]

  // Update UI
  if (dom.repeatBtn) {
    updateRepeatButtonUI()
  }

  // Feedback
  const labels = { off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' }
  showToast(labels[playback.repeatMode])
}

// Update repeat button visual state
function updateRepeatButtonUI() {
  if (!dom.repeatBtn) return

  if (playback.repeatMode === 'all') {
    dom.repeatBtn.classList.add('active')
    dom.repeatBtn.textContent = '\u27F3'
    dom.repeatBtn.title = 'Repeat all'
  } else if (playback.repeatMode === 'one') {
    dom.repeatBtn.classList.add('active')
    dom.repeatBtn.textContent = '\u27F3\u2081'
    dom.repeatBtn.title = 'Repeat one'
  } else {
    dom.repeatBtn.classList.remove('active')
    dom.repeatBtn.textContent = '\u27F3'
    dom.repeatBtn.title = 'Repeat'
  }
}

// Toggle shuffle mode (cycle: off -> album -> library -> off)
function toggleShuffleMode() {
  // Reset shuffle history when changing mode
  playback.shufflePlayedTracks.clear()

  // Cycle between modes
  if (playback.shuffleMode === 'off') {
    playback.shuffleMode = 'album'
    if (dom.shuffleBtn) {
      dom.shuffleBtn.classList.add('active')
      dom.shuffleBtn.textContent = '\u2922\u1D2C'
      dom.shuffleBtn.title = 'Shuffle (Album)'
    }
    showToast('Shuffle (Album)')
  } else if (playback.shuffleMode === 'album') {
    playback.shuffleMode = 'library'
    if (dom.shuffleBtn) {
      dom.shuffleBtn.textContent = '\u2922\u221E'
      dom.shuffleBtn.title = 'Shuffle (Library)'
    }
    showToast('Shuffle (Library)')
  } else {
    playback.shuffleMode = 'off'
    if (dom.shuffleBtn) {
      dom.shuffleBtn.classList.remove('active')
      dom.shuffleBtn.textContent = '\u2922'
      dom.shuffleBtn.title = 'Shuffle'
    }
    showToast('Shuffle disabled')
  }
}

// === PUBLIC API ===

// Main initialization function — call once from the entry point
export function initShortcuts() {
  // Load saved shortcut overrides and set up local keydown listener
  loadShortcuts()
  document.addEventListener('keydown', handleKeyDown)

  // Initialize OS-level global shortcuts (Tauri)
  initGlobalShortcuts()

  // Register functions on the app mediator for cross-module access
  app.closeAllPanels = closeAllPanels
}

// Expose for settings UI
export { DEFAULT_SHORTCUTS, activeShortcuts, loadShortcuts }
