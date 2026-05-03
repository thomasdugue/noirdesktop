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

// === PARTICLE ANIMATION ===
// Effet : chaos (gauche) → tunnel convergent (centre) → signal analogique sinusoïdal (droite)

const activeParticleAnimations = new Map()
const PARTICLE_COUNT = 65

export function createParticleCanvas(container) {
  destroyParticleCanvas(container)

  const canvas = document.createElement('canvas')
  canvas.className = 'particle-canvas'
  container.insertBefore(canvas, container.firstChild)

  const ctx = canvas.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  let w = 0, h = 0

  function resize() {
    w = container.offsetWidth
    h = container.offsetHeight
    canvas.width = w * dpr
    canvas.height = h * dpr
    canvas.style.width = w + 'px'
    canvas.style.height = h + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  resize()

  // fromLeft=true : recycle depuis le bord gauche, false : placement initial aléatoire
  function resetParticle(p, fromLeft) {
    p.x = fromLeft ? -5 : Math.random() * w
    p.y = Math.random() * h
    p.speed = 0.5 + Math.random() * 0.6
    p.drift = Math.random() * Math.PI * 2
    p.driftSpeed = 0.018 + Math.random() * 0.025
    p.size = 0.8 + Math.random() * 1.6
    p.opacity = 0.12 + Math.random() * 0.20
  }

  const particles = []
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const p = {}
    resetParticle(p, false)
    particles.push(p)
  }

  let waveTime = 0
  // Objet mutable pour que destroyParticleCanvas annule toujours le bon frame
  const state = { canvas, animId: null }
  activeParticleAnimations.set(container, state)

  function smoothstep(t) {
    const c = Math.max(0, Math.min(1, t))
    return c * c * (3 - 2 * c)
  }

  function animate() {
    if (!container.isConnected) {
      activeParticleAnimations.delete(container)
      return
    }

    state.animId = requestAnimationFrame(animate)

    // Pas de dessin quand la home est cachée (CPU quasi nul)
    if (container.offsetParent === null) return

    const cw = container.offsetWidth
    const ch = container.offsetHeight
    if (cw !== w || ch !== h) resize()

    waveTime += 0.04
    ctx.clearRect(0, 0, w, h)

    const cy = h / 2

    for (const p of particles) {
      p.drift += p.driftSpeed
      p.x += p.speed

      // Recyclage depuis la gauche quand la particule sort à droite
      if (p.x > w + 5) resetParticle(p, true)

      const xFrac = Math.max(0, Math.min(1, p.x / w))

      // --- Calcul des y cibles par zone ---
      // Zone chaos : dérive sinusoïdale propre à chaque particule
      const noiseY = cy + (h * 0.40) * Math.sin(p.drift)
      // Zone signal : onde sinusoïdale commune (signal analogique)
      // freq=6 → ~2.4 cycles visibles dans la zone onde (60%→100%)
      const waveY = cy + (h * 0.27) * Math.sin(6 * Math.PI * 2 * xFrac - waveTime)

      let y, alpha

      if (xFrac < 0.35) {
        // Zone chaos : désorganisé, flux de gauche
        y = noiseY
        alpha = p.opacity

      } else if (xFrac < 0.62) {
        // Zone tunnel : convergence progressive vers le centre
        const blend = smoothstep((xFrac - 0.35) / 0.27)
        y = noiseY + (cy - noiseY) * blend
        alpha = p.opacity + blend * 0.07

      } else {
        // Zone signal : émergence progressive de l'onde analogique
        const blend = smoothstep((xFrac - 0.62) / 0.23)
        y = cy + (waveY - cy) * blend
        alpha = p.opacity + 0.07 + blend * 0.10
      }

      ctx.beginPath()
      ctx.arc(p.x, y, p.size, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(alpha, 1)})`
      ctx.fill()
    }
  }

  state.animId = requestAnimationFrame(animate)
}

export function destroyParticleCanvas(container) {
  const anim = activeParticleAnimations.get(container)
  if (anim) {
    cancelAnimationFrame(anim.animId)
    if (anim.canvas.parentNode) anim.canvas.remove()
    activeParticleAnimations.delete(container)
  }
}

// === LOADING OVERLAY ===

export function showLoading(message = 'Loading...') {
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

let _toastTimeout

/**
 * Affiche un toast notification.
 * @param {string} message - Le message à afficher
 * @param {string|null} type - 'error' pour un style rouge, null sinon
 * @param {number} duration - Durée en ms (0 = persistant, défaut 3000)
 */
export function showToast(message, type, duration) {
  const toast = document.getElementById('toast')
  if (!toast) return

  clearTimeout(_toastTimeout)
  toast.textContent = message
  toast.classList.add('show')
  toast.classList.toggle('toast-error', type === 'error')

  // Rétro-compatibilité : si type est un nombre, c'est l'ancien usage (message, duration)
  if (typeof type === 'number') {
    duration = type
    toast.classList.remove('toast-error')
  }

  const ms = duration ?? 3000
  if (ms !== 0) {
    _toastTimeout = setTimeout(() => toast.classList.remove('show'), ms)
  }
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

// === METADATA ORNAMENTS ===

/**
 * Build a Geist Mono ornament line for the player bar / track info.
 * Example: "FLAC · 24-BIT / 192 KHZ · 6:42 · TRACK 7 / 12"
 * Returns null if there's nothing meaningful to show.
 */
export function formatTrackOrnament(track) {
  if (!track) return null
  const parts = []
  const meta = track.metadata || {}

  // Format from extension
  const ext = (track.path || '').match(/\.([a-z0-9]+)$/i)
  const fmt = ext ? ext[1].toUpperCase() : null
  if (fmt) parts.push(fmt)

  // Quality (24-bit / 192kHz or 320 kbps)
  const q = formatQuality(meta, track.path)
  if (q.label && q.label !== '-') parts.push(q.label.toUpperCase())

  // Duration
  if (meta.duration) parts.push(formatTime(meta.duration))

  // Track position
  const trackNum = meta.track || meta.trackNumber || meta.track_number
  if (trackNum) {
    parts.push(`TRACK ${String(trackNum).padStart(2, '0')}`)
  }

  return parts.length ? parts.join(' · ') : null
}

/**
 * Build the editorial banner for an album page.
 * Example: "PINK FLOYD · 1973 · 10 TRACKS · 42:49 · ROCK"
 */
export function formatAlbumOrnament(album) {
  if (!album) return null
  const parts = []
  if (album.artist) parts.push(String(album.artist).toUpperCase())
  const firstTrack = album.tracks?.[0]
  const year = firstTrack?.metadata?.year
  if (year) parts.push(String(year))
  if (album.tracks?.length) parts.push(`${album.tracks.length} TRACKS`)
  const totalDuration = (album.tracks || []).reduce((acc, t) => acc + (t.metadata?.duration || 0), 0)
  if (totalDuration) parts.push(formatTime(totalDuration))
  const genre = firstTrack?.metadata?.genre
  if (genre) parts.push(String(genre).toUpperCase())
  return parts.length ? parts.join(' · ') : null
}

/**
 * Build the editorial banner for a playlist.
 * Example: "47 TRACKS · 3:12:45 · 18 ARTISTS · 1.4 GB"
 */
export function formatPlaylistOrnament(tracks) {
  if (!tracks || tracks.length === 0) return null
  const parts = []
  parts.push(`${tracks.length} TRACK${tracks.length > 1 ? 'S' : ''}`)
  const totalDuration = tracks.reduce((acc, t) => acc + (t.metadata?.duration || 0), 0)
  if (totalDuration) parts.push(formatTime(totalDuration))
  const artists = new Set()
  tracks.forEach(t => {
    const a = t.metadata?.artist
    if (a) artists.add(a)
  })
  if (artists.size > 0) parts.push(`${artists.size} ARTIST${artists.size > 1 ? 'S' : ''}`)
  const totalBytes = tracks.reduce((acc, t) => acc + (t.fileSize || t.file_size || 0), 0)
  if (totalBytes > 0) {
    const gb = totalBytes / (1024 ** 3)
    if (gb >= 1) parts.push(`${gb.toFixed(1)} GB`)
    else parts.push(`${(totalBytes / (1024 ** 2)).toFixed(0)} MB`)
  }
  return parts.join(' · ')
}

/**
 * Number of dots representing bit-depth. Lossy fallback uses bitrate ratio (max 320).
 * Returns { count, total } so we can render filled/empty dots.
 */
export function getBitDepthMeter(metadata, filePath) {
  if (!metadata) return null
  const bitDepth = metadata.bitDepth
  const isLossy = filePath ? /\.(mp3|aac|ogg|m4a|wma|opus)$/i.test(filePath) : !bitDepth
  if (isLossy && metadata.bitrate) {
    const ratio = Math.min(1, metadata.bitrate / 320)
    return { count: Math.max(1, Math.round(ratio * 8)), total: 8, lossy: true }
  }
  if (bitDepth >= 32) return { count: 8, total: 8, lossy: false }
  if (bitDepth >= 24) return { count: 6, total: 8, lossy: false }
  if (bitDepth >= 16) return { count: 4, total: 8, lossy: false }
  return null
}

/**
 * Number of dots representing sample-rate. 44.1k=3, 48k=4, 96k=6, 192k=8.
 */
export function getSampleRateMeter(sampleRate) {
  if (!sampleRate) return null
  if (sampleRate >= 192000) return { count: 8, total: 8 }
  if (sampleRate >= 96000) return { count: 6, total: 8 }
  if (sampleRate >= 48000) return { count: 4, total: 8 }
  if (sampleRate >= 44100) return { count: 3, total: 8 }
  return { count: 2, total: 8 }
}
