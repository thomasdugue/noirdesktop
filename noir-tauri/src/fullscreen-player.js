// fullscreen-player.js — Vue plein écran immersive
// Reproduction fidèle du système de particules Noir (3 phases) :
//   Phase 0 : Chaotic bits — particules flottantes à gauche, dérive vers le tunnel
//   Phase 1 : Convergence — compression dans le tunnel invisible
//   Phase 2 : Signal wave — particules ressortent en onde, amplitude = RMS audio

import { invoke } from './state.js'

// ============================================================
//  COLOR EXTRACTION — Couleurs dominantes depuis la cover
// ============================================================

// Extract colors from a base64 data URI (guaranteed to work, no CORS issues)
async function extractColorsFromBase64(dataUri, count = 3) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      canvas.width = 64
      canvas.height = 64
      ctx.drawImage(img, 0, 0, 64, 64)
      const data = ctx.getImageData(0, 0, 64, 64).data
      resolve(colorsFromPixelData(data, count))
    }
    img.onerror = () => resolve(defaultColors())
    img.src = dataUri
  })
}

function colorsFromPixelData(data, count) {
  const pixels = []
  for (let i = 0; i < data.length; i += 16) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3]
    if (a < 128) continue
    const brightness = (r + g + b) / 3
    if (brightness < 20 || brightness > 240) continue
    pixels.push([r, g, b])
  }
  if (pixels.length < 5) return defaultColors()
  return kMeansColors(pixels, count)
}

function defaultColors() {
  return [[255, 255, 255], [200, 200, 200], [160, 160, 160]]
}

function kMeansColors(pixels, k) {
  let centroids = []
  const step = Math.max(1, Math.floor(pixels.length / k))
  for (let i = 0; i < k; i++) {
    centroids.push([...pixels[Math.min(i * step, pixels.length - 1)]])
  }

  for (let iter = 0; iter < 10; iter++) {
    const clusters = Array.from({ length: k }, () => [])
    for (const px of pixels) {
      let minDist = Infinity, closest = 0
      for (let c = 0; c < k; c++) {
        const d = (px[0] - centroids[c][0]) ** 2 +
                  (px[1] - centroids[c][1]) ** 2 +
                  (px[2] - centroids[c][2]) ** 2
        if (d < minDist) { minDist = d; closest = c }
      }
      clusters[closest].push(px)
    }
    for (let c = 0; c < k; c++) {
      if (clusters[c].length === 0) continue
      centroids[c] = [
        Math.round(clusters[c].reduce((s, p) => s + p[0], 0) / clusters[c].length),
        Math.round(clusters[c].reduce((s, p) => s + p[1], 0) / clusters[c].length),
        Math.round(clusters[c].reduce((s, p) => s + p[2], 0) / clusters[c].length)
      ]
    }
  }

  return centroids.sort((a, b) => {
    const satA = Math.max(...a) - Math.min(...a)
    const satB = Math.max(...b) - Math.min(...b)
    return (satB * (b[0] + b[1] + b[2])) - (satA * (a[0] + a[1] + a[2]))
  })
}


// ============================================================
//  PARTICLE SYSTEM — 3 phases (fidèle au site Noir)
// ============================================================

function createParticle(W, H, funnelX, funnelY, colors) {
  const side = Math.random()
  let x, y
  if (side < 0.7) {
    x = Math.random() * funnelX * 0.6
    y = Math.random() * H
  } else {
    x = Math.random() * funnelX * 0.8
    y = Math.random() < 0.5 ? -10 : H + 10
  }

  const col = colors[Math.floor(Math.random() * colors.length)]

  return {
    x, y, ox: x, oy: y,
    phase: 0,
    speed: 0.3 + Math.random() * 0.8,
    size: 1 + Math.random() * 2,
    opacity: 0.2 + Math.random() * 0.6,
    drift: (Math.random() - 0.5) * 0.8,
    driftY: (Math.random() - 0.5) * 0.5,
    waveOffset: Math.random() * Math.PI * 2,
    waveAmp: 15 + Math.random() * 25,
    life: 0,
    maxLife: 400 + Math.random() * 600,
    r: col[0], g: col[1], b: col[2],
  }
}


// ============================================================
//  FULLSCREEN PLAYER STATE
// ============================================================

let fsCanvas = null
let fsCtx = null
let fsAnimId = null
let fsParticles = []
let fsColors = defaultColors()
let fsIsOpen = false
let fsIsPlaying = false
let fsRmsEnergy = 0       // Current RMS from Rust (0.0 - ~0.5)
let fsSmoothedRms = 0     // Smoothed for animation
const PARTICLE_COUNT = 600


// ============================================================
//  PUBLIC API
// ============================================================

export function openFullscreenPlayer() {
  const el = document.getElementById('fullscreen-player')
  if (!el) return

  el.classList.remove('hidden')
  el.classList.add('visible')
  fsIsOpen = true

  fsCanvas = document.getElementById('fs-canvas')
  fsCtx = fsCanvas.getContext('2d')

  resizeCanvas()
  window.addEventListener('resize', resizeCanvas)

  updateFullscreenData()

  fsAnimId = requestAnimationFrame(draw)
}

export function closeFullscreenPlayer() {
  const el = document.getElementById('fullscreen-player')
  if (!el) return

  el.classList.remove('visible')
  el.classList.add('hidden')
  fsIsOpen = false

  window.removeEventListener('resize', resizeCanvas)

  if (fsAnimId) {
    cancelAnimationFrame(fsAnimId)
    fsAnimId = null
  }
}

export function toggleFullscreenPlayer() {
  if (fsIsOpen) closeFullscreenPlayer()
  else openFullscreenPlayer()
}

export function isFullscreenOpen() {
  return fsIsOpen
}

export function setFullscreenPlayState(playing) {
  fsIsPlaying = playing
}

export function setFullscreenRms(rms) {
  fsRmsEnergy = rms
}

export function updateFullscreenData() {
  if (!fsIsOpen) return

  // Update fullscreen cover
  const coverImg = document.querySelector('#cover-art img')
  const fsCover = document.getElementById('fs-cover')
  if (fsCover && coverImg) {
    fsCover.src = coverImg.src
    fsCover.style.display = 'block'
  } else if (fsCover) {
    fsCover.style.display = 'none'
  }

  // Extract colors via Rust base64 (bypasses noir:// CORS/tainted canvas)
  if (_getCurrentTrackPathCb) {
    const trackPath = _getCurrentTrackPathCb()
    if (trackPath && trackPath !== _lastColorTrackPath) {
      _lastColorTrackPath = trackPath
      invoke('get_cover_base64', { path: trackPath }).then(dataUri => {
        if (!dataUri) return
        extractColorsFromBase64(dataUri).then(colors => {
          if (colors && colors.length > 0) {
            fsColors = colors
            // Update existing particles with new colors
            for (const p of fsParticles) {
              const col = colors[Math.floor(Math.random() * colors.length)]
              p.r = col[0]; p.g = col[1]; p.b = col[2]
            }
          }
        })
      })
    }
  }

  // Update title & artist
  const fsTitle = document.getElementById('fs-title')
  const fsArtist = document.getElementById('fs-artist')
  if (fsTitle) fsTitle.textContent = document.getElementById('track-name')?.textContent || '-'
  if (fsArtist) fsArtist.textContent = document.getElementById('track-folder')?.textContent || '-'

  // Update specs + copy bit-perfect / resampled class from main player
  const fsSrc = document.getElementById('fs-src-specs')
  const fsOut = document.getElementById('fs-out-specs')
  if (fsSrc) fsSrc.textContent = document.getElementById('source-specs')?.textContent || '-'
  if (fsOut) fsOut.textContent = document.getElementById('output-specs')?.textContent || '-'

  const mainSpecs = document.getElementById('audio-specs')
  const fsSpecs = document.getElementById('fs-audio-specs')
  if (mainSpecs && fsSpecs) {
    fsSpecs.classList.remove('bit-perfect', 'resampled', 'mismatch')
    if (mainSpecs.classList.contains('bit-perfect')) fsSpecs.classList.add('bit-perfect')
    else if (mainSpecs.classList.contains('resampled')) fsSpecs.classList.add('resampled')
    else if (mainSpecs.classList.contains('mismatch')) fsSpecs.classList.add('mismatch')
  }

  // Update "up next" — uses callback set by renderer.js to avoid circular imports
  const fsNext = document.getElementById('fs-next-track')
  if (fsNext && _getNextTrackInfoCb) {
    const info = _getNextTrackInfoCb()
    if (info && info.title) {
      fsNext.textContent = info.title + (info.artist ? ' — ' + info.artist : '')
    } else {
      fsNext.textContent = ''
    }
  }
}

// Callbacks set from renderer.js to avoid circular imports
let _getNextTrackInfoCb = null
let _getCurrentTrackPathCb = null
let _lastColorTrackPath = null

export function setNextTrackInfoCallback(cb) {
  _getNextTrackInfoCb = cb
}

export function setCurrentTrackPathCallback(cb) {
  _getCurrentTrackPathCb = cb
}


// ============================================================
//  CANVAS RESIZE & PARTICLE INIT
// ============================================================

let W = 0, H = 0, funnelX = 0, funnelY = 0

function resizeCanvas() {
  if (!fsCanvas) return
  W = fsCanvas.width = window.innerWidth
  H = fsCanvas.height = window.innerHeight
  funnelX = W * 0.52
  funnelY = H * 0.5

  // Reinit particles
  fsParticles = []
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    fsParticles.push(createParticle(W, H, funnelX, funnelY, fsColors))
  }
}


// ============================================================
//  DRAW LOOP — Reproduit fidèlement le rendu du site Noir
// ============================================================

function draw() {
  if (!fsIsOpen || !fsCtx) return

  fsCtx.clearRect(0, 0, W, H)

  // Smooth RMS
  if (fsIsPlaying) {
    fsSmoothedRms += (fsRmsEnergy - fsSmoothedRms) * 0.15
  } else {
    fsSmoothedRms *= 0.95
  }
  // Clamp to usable range (RMS is typically 0.0 - 0.3 for music)
  const rmsNorm = Math.min(fsSmoothedRms / 0.15, 1.0)

  // --- Subtle funnel guide lines ---
  const primaryCol = fsColors[0]
  fsCtx.save()
  fsCtx.strokeStyle = `rgba(${primaryCol[0]},${primaryCol[1]},${primaryCol[2]},0.02)`
  fsCtx.lineWidth = 1
  fsCtx.beginPath()
  fsCtx.moveTo(0, 0)
  fsCtx.lineTo(funnelX, funnelY)
  fsCtx.moveTo(0, H)
  fsCtx.lineTo(funnelX, funnelY)
  fsCtx.stroke()
  fsCtx.restore()

  // --- Funnel glow ---
  const grad = fsCtx.createRadialGradient(funnelX, funnelY, 0, funnelX, funnelY, 60)
  grad.addColorStop(0, `rgba(${primaryCol[0]},${primaryCol[1]},${primaryCol[2]},0.06)`)
  grad.addColorStop(1, `rgba(${primaryCol[0]},${primaryCol[1]},${primaryCol[2]},0)`)
  fsCtx.fillStyle = grad
  fsCtx.beginPath()
  fsCtx.arc(funnelX, funnelY, 60, 0, Math.PI * 2)
  fsCtx.fill()

  // --- Particles (3 phases) ---
  for (let i = 0; i < fsParticles.length; i++) {
    const p = fsParticles[i]
    p.life++

    if (p.life > p.maxLife) {
      Object.assign(p, createParticle(W, H, funnelX, funnelY, fsColors))
      continue
    }

    const lifeRatio = p.life / p.maxLife

    // === PHASE 0 : Chaotic bits (0% - 45%) ===
    if (lifeRatio < 0.45) {
      const toFunnelX = funnelX - p.x
      const toFunnelY = funnelY - p.y
      const dist = Math.sqrt(toFunnelX * toFunnelX + toFunnelY * toFunnelY)

      p.x += p.drift + (toFunnelX / dist) * p.speed * 0.5
      p.y += p.driftY + (toFunnelY / dist) * p.speed * 0.3
      p.x += (Math.random() - 0.5) * 1.2
      p.y += (Math.random() - 0.5) * 1.2
      p.phase = 0
    }

    // === PHASE 1 : Convergence (45% - 55%) ===
    else if (lifeRatio < 0.55) {
      const t = (lifeRatio - 0.45) / 0.1
      p.x = funnelX + t * 40
      p.y = funnelY + (p.oy - funnelY) * (1 - t) * 0.1
      p.phase = 1
    }

    // === PHASE 2 : Signal wave (55% - 100%) — amplitude driven by RMS ===
    else {
      const t = (lifeRatio - 0.55) / 0.45
      p.x = funnelX + 40 + t * (W - funnelX)

      // Base wave amplitude, scaled by real audio RMS energy
      const audioScale = fsIsPlaying ? (0.3 + rmsNorm * 1.5) : 0.15
      p.y = funnelY +
        Math.sin(t * Math.PI * 3 + p.waveOffset) * p.waveAmp * audioScale * (1 - t * 0.3)
      p.phase = 2
    }

    // --- Draw particle ---
    const fadeIn = Math.min(p.life / 30, 1)
    const fadeOut = Math.max(1 - (p.life - p.maxLife + 60) / 60, 0)
    const alpha = p.opacity * fadeIn * Math.min(fadeOut, 1)

    fsCtx.beginPath()
    fsCtx.arc(p.x, p.y, p.phase === 2 ? p.size * 0.8 : p.size, 0, Math.PI * 2)
    fsCtx.fillStyle = p.phase === 2
      ? `rgba(${p.r},${p.g},${p.b},${alpha * 0.9})`
      : `rgba(${p.r},${p.g},${p.b},${alpha * 0.5})`
    fsCtx.fill()

    // Trail for signal wave particles
    if (p.phase === 2 && alpha > 0.2) {
      fsCtx.beginPath()
      fsCtx.arc(p.x - 3, p.y, p.size * 0.4, 0, Math.PI * 2)
      fsCtx.fillStyle = `rgba(${p.r},${p.g},${p.b},${alpha * 0.2})`
      fsCtx.fill()
    }
  }

  // --- Subtle continuous wave reference line ---
  fsCtx.save()
  const time = Date.now() * 0.001
  const waveCol = fsColors[1] || fsColors[0]
  fsCtx.strokeStyle = `rgba(${waveCol[0]},${waveCol[1]},${waveCol[2]},0.04)`
  fsCtx.lineWidth = 1
  fsCtx.beginPath()
  const waveScale = fsIsPlaying ? (15 + rmsNorm * 25) : 10
  for (let x = funnelX + 40; x < W; x += 2) {
    const t = (x - funnelX - 40) / (W - funnelX - 40)
    const y = funnelY + Math.sin(t * Math.PI * 3 + time) * waveScale
    x === funnelX + 40 ? fsCtx.moveTo(x, y) : fsCtx.lineTo(x, y)
  }
  fsCtx.stroke()
  fsCtx.restore()

  fsAnimId = requestAnimationFrame(draw)
}
