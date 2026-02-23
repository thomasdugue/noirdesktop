// utils.js — Fonctions utilitaires pures pour Noir Desktop

// === VALIDATION D'IMAGES ===

export function isValidImageSrc(src) {
  return src && (src.startsWith('data:image') || src.startsWith('noir://'))
}

export function loadCachedImage(img, placeholder, cachedSrc) {
  if (!img || !isValidImageSrc(cachedSrc)) return false

  if (cachedSrc.startsWith('noir://')) {
    console.log('[NOIR] Loading from protocol:', cachedSrc.substring(0, 60))
  }

  img.onload = () => {
    img.style.display = 'block'
    if (placeholder) placeholder.style.display = 'none'
  }
  img.onerror = () => {
    console.warn('[COVER] Failed to load cached image:', cachedSrc)
    img.style.display = 'none'
    if (placeholder) placeholder.style.display = 'flex'
  }
  img.src = cachedSrc
  return true
}

// === GESTION DES TIMEOUTS ===

const activeTimeouts = new Map()
let timeoutCounter = 0

export function setManagedTimeout(callback, delay, groupId = null) {
  const id = groupId || `timeout_${++timeoutCounter}`
  if (activeTimeouts.has(id)) {
    clearTimeout(activeTimeouts.get(id))
  }
  const timeoutId = setTimeout(() => {
    activeTimeouts.delete(id)
    callback()
  }, delay)
  activeTimeouts.set(id, timeoutId)
  return id
}

export function clearManagedTimeout(id) {
  if (activeTimeouts.has(id)) {
    clearTimeout(activeTimeouts.get(id))
    activeTimeouts.delete(id)
  }
}

export function clearAllManagedTimeouts(prefix = null) {
  for (const [id, timeoutId] of activeTimeouts.entries()) {
    if (!prefix || id.startsWith(prefix)) {
      clearTimeout(timeoutId)
      activeTimeouts.delete(id)
    }
  }
}

// === RESPONSIVE ===

export function getResponsiveItemCount() {
  const mainContent = document.querySelector('.main-content')
  const width = mainContent ? mainContent.clientWidth : window.innerWidth - 280

  if (width < 480) {
    return { tracks: 4, carousel: 12 }
  } else if (width < 768) {
    return { tracks: 8, carousel: 15 }
  } else if (width < 1024) {
    return { tracks: 9, carousel: 20 }
  } else {
    return { tracks: 8, carousel: 25 }
  }
}

// === CODEC DETECTION ===

export function getCodecFromPath(path) {
  if (!path) return null
  const ext = path.split('.').pop()?.toLowerCase()
  const codecMap = {
    'flac': 'FLAC',
    'alac': 'ALAC',
    'wav': 'WAV',
    'aiff': 'AIFF',
    'mp3': 'MP3',
    'm4a': 'AAC',
    'aac': 'AAC',
    'ogg': 'OGG',
    'opus': 'OPUS',
    'wma': 'WMA',
    'dsd': 'DSD',
    'dsf': 'DSD',
    'dff': 'DSD'
  }
  return codecMap[ext] || ext?.toUpperCase()
}

// === ANIMATIONS ===

export function getWaveformAnimationHTML() {
  const bars = 48
  const center = bars / 2
  let html = '<div class="waveform-animation">'
  for (let i = 0; i < bars; i++) {
    const dist = Math.abs(i - center) / center
    const maxH = 60 * (1 - dist * 0.7)
    const delay = (i * 0.05).toFixed(2)
    const duration = (1.2 + Math.random() * 0.8).toFixed(2)
    html += `<div class="waveform-bar" style="height:${maxH}px;animation-delay:${delay}s;animation-duration:${duration}s"></div>`
  }
  html += '</div>'
  return html
}

export function getSineWaveAnimationHTML() {
  return getWaveformAnimationHTML()
}

// === LOADING OVERLAY ===

export function showLoading(message = 'Chargement...') {
  let loader = document.getElementById('loading-overlay')
  if (!loader) {
    loader = document.createElement('div')
    loader.id = 'loading-overlay'
    loader.innerHTML = `
      <div class="loading-content">
        <div class="loading-spinner"></div>
        <div class="loading-message">${escapeHtml(message)}</div>
        <div class="loading-progress"></div>
      </div>
    `
    document.body.appendChild(loader)
  } else {
    loader.querySelector('.loading-message').textContent = message
    loader.style.display = 'flex'
  }
}

export function updateLoading(message, progress = null) {
  const loader = document.getElementById('loading-overlay')
  if (loader) {
    loader.querySelector('.loading-message').textContent = message
    if (progress !== null) {
      loader.querySelector('.loading-progress').textContent = progress
    }
  }
}

export function hideLoading() {
  const loader = document.getElementById('loading-overlay')
  if (loader) {
    loader.style.display = 'none'
  }
}

// === TOAST NOTIFICATIONS ===

export function showToast(message, duration = 3000) {
  const toast = document.getElementById('toast')
  if (!toast) return

  toast.textContent = message
  toast.classList.add('show')

  setTimeout(() => {
    toast.classList.remove('show')
  }, duration)
}

// === HTML HELPERS ===

export function escapeHtml(text) {
  if (!text) return ''
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

// === FORMATAGE ===

export function formatTime(seconds) {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export function formatAlbumDuration(seconds) {
  const hours = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  if (hours > 0) {
    return `${hours}h${mins > 0 ? mins + 'm' : ''}`
  }
  return `${mins}m`
}

export function formatQuality(metadata, filePath = null) {
  if (!metadata) return { label: '-', class: '' }

  const bitDepth = metadata.bitDepth
  const sampleRate = metadata.sampleRate
  const bitrate = metadata.bitrate

  const isLossy = filePath
    ? /\.(mp3|aac|ogg|m4a|wma|opus)$/i.test(filePath)
    : (!bitDepth && bitrate)

  if (isLossy) {
    if (bitrate) {
      const kbps = Math.round(bitrate)
      return { label: `${kbps} kbps`, class: 'quality-lossy' }
    }
    return { label: 'Lossy', class: 'quality-lossy' }
  }

  if (!bitDepth && !sampleRate) return { label: '-', class: '' }

  let qualityClass = 'quality-standard'
  if (sampleRate) {
    if (sampleRate >= 192000) qualityClass = 'quality-192k'
    else if (sampleRate >= 96000) qualityClass = 'quality-96k'
    else if (sampleRate >= 48000) qualityClass = 'quality-48k'
    else qualityClass = 'quality-44k'
  } else if (bitDepth >= 24) {
    qualityClass = 'quality-hires'
  } else if (bitDepth >= 16) {
    qualityClass = 'quality-lossless'
  }

  const bits = bitDepth ? `${bitDepth}-bit` : ''
  const rate = sampleRate ? `${sampleRate >= 1000 ? (sampleRate / 1000).toFixed(1).replace('.0', '') : sampleRate}kHz` : ''
  const label = [bits, rate].filter(Boolean).join(' / ')

  return { label: label || '-', class: qualityClass }
}
