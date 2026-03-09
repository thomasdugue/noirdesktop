// lyrics.js — Panneau de paroles synchronisées (POC)
// Sources : LRCLIB (synced LRC) → Lyrics.ovh (plain text fallback)

import { ui, playback, library } from './state.js'
import { app } from './app.js'

// === STATE INTERNE ===

let lyricsLines = []       // [{time, text}] pour paroles synchronisées
let isSynced = false
let activeIndex = -1
const lyricsCache = new Map()  // path → {lines, plain, isSynced, source}
let currentTrackPath = null
let fsLyricsOpen = false

// === PANNEAU LATÉRAL ===

export function isLyricsPanelOpen() {
  return ui.isLyricsPanelOpen
}

export function closeLyricsPanel() {
  ui.isLyricsPanelOpen = false
  document.getElementById('lyrics-panel')?.classList.remove('open')
  document.getElementById('btn-lyrics')?.classList.remove('active')
}

export function toggleLyricsPanel() {
  if (!ui.isLyricsPanelOpen) {
    if (ui.isQueuePanelOpen) app.toggleQueuePanel()
    if (ui.isTrackInfoPanelOpen) app.closeTrackInfoPanel()
    if (ui.isSettingsPanelOpen) app.closeSettings()
    if (app.getEqPanelOpen && app.getEqPanelOpen()) app.closeEqPanel()
  }

  ui.isLyricsPanelOpen = !ui.isLyricsPanelOpen
  document.getElementById('lyrics-panel')?.classList.toggle('open', ui.isLyricsPanelOpen)
  document.getElementById('btn-lyrics')?.classList.toggle('active', ui.isLyricsPanelOpen)

  if (ui.isLyricsPanelOpen && playback.currentTrackIndex >= 0) {
    const track = library.tracks[playback.currentTrackIndex]
    if (track) loadLyricsForTrack(track)
  }
}

// === OVERLAY FULLSCREEN ===

export function isFullscreenLyricsOpen() {
  return fsLyricsOpen
}

export function closeFullscreenLyrics() {
  fsLyricsOpen = false
  document.getElementById('fs-lyrics-overlay')?.classList.add('hidden')
  document.getElementById('fs-lyrics-btn')?.classList.remove('active')
}

export function toggleFullscreenLyrics() {
  fsLyricsOpen = !fsLyricsOpen
  document.getElementById('fs-lyrics-overlay')?.classList.toggle('hidden', !fsLyricsOpen)
  document.getElementById('fs-lyrics-btn')?.classList.toggle('active', fsLyricsOpen)

  if (fsLyricsOpen && playback.currentTrackIndex >= 0) {
    const track = library.tracks[playback.currentTrackIndex]
    if (track) loadLyricsForTrack(track)
  }
}

// === LRC PARSER ===

function parseLrc(lrc) {
  const lines = []
  for (const line of lrc.split('\n')) {
    const match = line.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/)
    if (match) {
      const time = parseInt(match[1]) * 60 + parseInt(match[2]) + parseInt(match[3].padEnd(3, '0')) / 1000
      const text = match[4].trim()
      if (text) lines.push({ time, text })
    }
  }
  return lines.sort((a, b) => a.time - b.time)
}

// === FETCH LYRICS ===

export async function loadLyricsForTrack(track) {
  const path = track.path
  currentTrackPath = path

  // Retour immédiat depuis le cache
  if (lyricsCache.has(path)) {
    renderLyrics(lyricsCache.get(path))
    return
  }

  const title = track.metadata?.title || track.name || ''
  const artist = track.metadata?.artist || ''
  const album = track.metadata?.album || ''

  console.log('[lyrics] Searching for:', { title, artist, album, path })

  setLyricsLoading()

  let result = null

  // 1. LRCLIB (exact match → search fallback)
  if (title) {
    result = await fetchFromLrclib(artist, title, album)
  }

  // 2. Lyrics.ovh (plain text)
  if (!result && artist && title) {
    result = await fetchFromLyricsOvh(artist, title)
  }

  if (!result) {
    result = { lines: [], plain: '', isSynced: false, source: null }
  }

  console.log('[lyrics] Result:', result.source || 'not found', '| synced:', result.isSynced, '| lines:', result.lines.length)

  lyricsCache.set(path, result)

  if (currentTrackPath === path) {
    renderLyrics(result)
  }
}

async function fetchFromLrclib(artist, title, album) {
  const headers = { 'Lrclib-Client': 'Noir Desktop v0.1.0 (github.com/thomasdugue/noirdesktop)' }

  // Étape 1 : correspondance exacte via /api/get
  try {
    const params = new URLSearchParams({ track_name: title })
    if (artist) params.set('artist_name', artist)
    if (album) params.set('album_name', album)

    const res = await fetch(`https://lrclib.net/api/get?${params}`, { headers, signal: AbortSignal.timeout(5000) })
    console.log('[lyrics] LRCLIB /api/get status:', res.status, 'for', artist, '-', title)

    if (res.ok) {
      const data = await res.json()
      const parsed = parseLrcLibResponse(data)
      if (parsed) return parsed
    }
  } catch (e) {
    console.warn('[lyrics] LRCLIB /api/get error:', e)
  }

  // Étape 2 : recherche floue via /api/search (si pas de résultat exact)
  try {
    const params = new URLSearchParams({ q: `${artist} ${title}`.trim() })
    const res = await fetch(`https://lrclib.net/api/search?${params}`, { headers, signal: AbortSignal.timeout(5000) })
    console.log('[lyrics] LRCLIB /api/search status:', res.status)

    if (res.ok) {
      const results = await res.json()
      if (Array.isArray(results) && results.length > 0) {
        console.log('[lyrics] LRCLIB search found', results.length, 'results, using first:', results[0].trackName)
        const parsed = parseLrcLibResponse(results[0])
        if (parsed) return parsed
      }
    }
  } catch (e) {
    console.warn('[lyrics] LRCLIB /api/search error:', e)
  }

  return null
}

function parseLrcLibResponse(data) {
  if (!data) return null
  if (data.instrumental) {
    return { lines: [], plain: '♪ Instrumental', isSynced: false, source: 'LRCLIB' }
  }
  if (data.syncedLyrics) {
    return { lines: parseLrc(data.syncedLyrics), plain: data.plainLyrics || '', isSynced: true, source: 'LRCLIB' }
  }
  if (data.plainLyrics) {
    return { lines: [], plain: data.plainLyrics, isSynced: false, source: 'LRCLIB' }
  }
  return null
}

async function fetchFromLyricsOvh(artist, title) {
  try {
    const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    console.log('[lyrics] Lyrics.ovh status:', res.status)
    if (!res.ok) return null
    const data = await res.json()
    if (data.lyrics) {
      return { lines: [], plain: data.lyrics, isSynced: false, source: 'Lyrics.ovh' }
    }
  } catch (e) {
    console.warn('[lyrics] Lyrics.ovh error:', e)
  }
  return null
}

// === RENDER ===

function setLyricsLoading() {
  const loading = '<div class="lyrics-loading">Searching lyrics…</div>'
  const panelEl = document.getElementById('lyrics-lines')
  const fsEl = document.getElementById('fs-lyrics-lines')
  if (panelEl) panelEl.innerHTML = loading
  if (fsEl) fsEl.innerHTML = loading
  document.getElementById('lyrics-source')?.textContent === '' // clear source label
  lyricsLines = []
  isSynced = false
  activeIndex = -1
}

function buildLyricsHTML(result) {
  if (!result.source) return '<div class="lyrics-empty">No lyrics found</div>'
  if (isSynced && lyricsLines.length > 0) {
    return lyricsLines
      .map((line, i) => `<div class="lyric-line" data-index="${i}">${escapeHtml(line.text)}</div>`)
      .join('')
  }
  if (result.plain) {
    const html = result.plain
      .split(/\n\n+/)
      .map(para => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
      .join('')
    return `<div class="lyrics-plain">${html}</div>`
  }
  return '<div class="lyrics-empty">No lyrics found</div>'
}

function renderLyrics(result) {
  lyricsLines = result.lines || []
  isSynced = result.isSynced || false
  activeIndex = -1

  const sourceLabel = result.source ? `${result.source}${isSynced ? ' · synced' : ''}` : ''
  const sourceEl = document.getElementById('lyrics-source')
  if (sourceEl) sourceEl.textContent = sourceLabel

  const html = buildLyricsHTML(result)
  const panelEl = document.getElementById('lyrics-lines')
  const fsEl = document.getElementById('fs-lyrics-lines')
  if (panelEl) panelEl.innerHTML = html
  if (fsEl) fsEl.innerHTML = html
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// === SYNC EN TEMPS RÉEL ===

export function syncLyricsToTime(currentTime) {
  if (!isSynced || lyricsLines.length === 0) return

  let newIndex = -1
  for (let i = lyricsLines.length - 1; i >= 0; i--) {
    if (currentTime >= lyricsLines[i].time) {
      newIndex = i
      break
    }
  }

  if (newIndex === activeIndex) return
  activeIndex = newIndex

  // Sync dans le panneau latéral si ouvert
  if (ui.isLyricsPanelOpen) {
    syncContainer(document.getElementById('lyrics-lines'), activeIndex)
  }
  // Sync dans l'overlay fullscreen si ouvert
  if (fsLyricsOpen) {
    syncContainer(document.getElementById('fs-lyrics-lines'), activeIndex)
  }
}

function syncContainer(container, index) {
  if (!container) return
  const allLines = container.querySelectorAll('.lyric-line')
  allLines.forEach((el, i) => el.classList.toggle('active', i === index))
  if (index >= 0 && allLines[index]) {
    allLines[index].scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}
