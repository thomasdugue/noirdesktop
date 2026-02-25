// views.js — View rendering module for Noir Desktop
// Extracted from renderer.js — handles all view display logic
// Uses app.js mediator for cross-module calls, state.js for shared state

import { library, playback, queue, ui, sort, search, caches, favorites, dom, HOME_CACHE_TTL } from './state.js'
import { invoke } from './state.js'
import { app } from './app.js'
import { isDragging } from './drag.js'
import {
  formatTime, formatAlbumDuration, formatQuality, escapeHtml, isValidImageSrc,
  loadCachedImage, getCodecFromPath, createParticleCanvas, destroyParticleCanvas,
  showToast, getResponsiveItemCount
} from './utils.js'

// === VIRTUAL SCROLL CONSTANTS ===
const TRACK_ITEM_HEIGHT = 48
const VIRTUAL_BUFFER = 10
const POOL_SIZE = 60

// === LOCAL STATE (not worth centralizing) ===
let virtualScrollState = {
  filteredTracks: [],
  visibleStartIndex: 0,
  visibleEndIndex: 0,
  scrollContainer: null,
  contentContainer: null,
  selectedTrackPaths: new Set(),
  lastSelectedPath: null,
  pool: []
}

let artistSortMode = 'name-asc'

// === DISCOVERY MIX CACHE ===
const DISCOVERY_MIX_CACHE_KEY = 'discovery_mixes_cache'
const DISCOVERY_MIX_TTL = 24 * 60 * 60 * 1000  // 24h
let discoveryMixes = []

// ============================================================
// INIT
// ============================================================

export function initViews() {
  // Wire up navigation menu listeners
  dom.navItems.forEach(item => {
    item.addEventListener('click', () => {
      dom.navItems.forEach(i => i.classList.remove('active'))
      item.classList.add('active')

      ui.filteredArtist = null
      ui.currentView = item.dataset.view

      requestAnimationFrame(() => {
        displayCurrentView()
      })
    })
  })
}

// ============================================================
// ALPHABET SCROLLBAR
// ============================================================

export function createAlphabetScrollbar(container, items, getFirstLetter, scrollContainer) {
  const existing = document.querySelector('.alphabet-nav')
  if (existing) existing.remove()

  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('')
  const nav = document.createElement('div')
  nav.className = 'alphabet-nav'

  const letterSet = new Set()
  items.forEach(item => {
    const first = getFirstLetter(item).toUpperCase()
    if (/[A-Z]/.test(first)) {
      letterSet.add(first)
    } else {
      letterSet.add('#')
    }
  })

  for (const letter of letters) {
    const btn = document.createElement('button')
    btn.textContent = letter
    btn.className = 'alphabet-nav-btn'

    if (!letterSet.has(letter)) {
      btn.classList.add('disabled')
    }

    btn.addEventListener('click', () => {
      const target = items.find(item => {
        const first = getFirstLetter(item).toUpperCase()
        if (letter === '#') {
          return !/[A-Z]/.test(first)
        }
        return first === letter
      })

      if (target && target.element) {
        target.element.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    })

    nav.appendChild(btn)
  }

  container.appendChild(nav)
}

// ============================================================
// DISPLAY CURRENT VIEW
// ============================================================

export function displayCurrentView() {
  closeAlbumDetail()

  // Disconnect cover observer to avoid memory leaks
  app.initCoverObserver()  // ensures observer exists

  dom.albumsGridDiv.classList.add('view-transitioning')

  setTimeout(() => {
    dom.albumsGridDiv.textContent = ''
    dom.albumsViewDiv.classList.remove('hidden')

    dom.albumsViewDiv.classList.toggle('home-visible', ui.currentView === 'home')

    switch (ui.currentView) {
      case 'home':
        displayHomeView()
        break
      case 'albums':
        displayAlbumsGrid()
        break
      case 'artists':
        displayArtistsGrid()
        break
      case 'tracks':
        displayTracksGrid()
        break
      case 'album-page':
        displayAlbumPage(ui.currentAlbumPageKey)
        break
      case 'artist-page':
        displayArtistPage(ui.currentArtistPageKey)
        break
      case 'mix-page':
        if (ui.currentMixData) displayMixPage(ui.currentMixData)
        break
      case 'playlist':
        app.displayPlaylistView()
        break
    }

    requestAnimationFrame(() => {
      dom.albumsGridDiv.classList.remove('view-transitioning')
    })
  }, 80)
}

// ============================================================
// NAVIGATION
// ============================================================

export function navigateToArtistPage(artistKey) {
  if (!artistKey || !library.artists[artistKey]) return

  ui.navigationHistory.push({
    view: ui.currentView,
    filteredArtist: ui.filteredArtist,
    scrollPosition: document.querySelector('.albums-view')?.scrollTop || 0
  })

  ui.currentArtistPageKey = artistKey
  ui.currentView = 'artist-page'

  dom.navItems.forEach(i => i.classList.remove('active'))
  document.querySelector('[data-view="artists"]')?.classList.add('active')

  closeAlbumDetail()
  dom.albumsGridDiv.textContent = ''
  dom.albumsViewDiv.classList.remove('hidden')

  displayArtistPage(artistKey)
}

export function navigateToAlbumPage(albumKey) {
  if (!albumKey || !library.albums[albumKey]) return

  ui.navigationHistory.push({
    view: ui.currentView,
    filteredArtist: ui.filteredArtist,
    scrollPosition: document.querySelector('.albums-view')?.scrollTop || 0,
    artistPageKey: ui.currentArtistPageKey
  })

  ui.currentAlbumPageKey = albumKey
  ui.currentView = 'album-page'

  dom.navItems.forEach(i => i.classList.remove('active'))

  closeAlbumDetail()
  dom.albumsGridDiv.textContent = ''
  dom.albumsViewDiv.classList.remove('hidden')

  displayAlbumPage(albumKey)
}

export function navigateToMixPage(mix) {
  if (!mix) return

  ui.navigationHistory.push({
    view: ui.currentView,
    filteredArtist: ui.filteredArtist,
    scrollPosition: document.querySelector('.albums-view')?.scrollTop || 0,
    artistPageKey: ui.currentArtistPageKey
  })

  ui.currentMixData = mix
  ui.currentView = 'mix-page'

  dom.navItems.forEach(i => i.classList.remove('active'))

  closeAlbumDetail()
  dom.albumsGridDiv.textContent = ''
  dom.albumsViewDiv.classList.remove('hidden')

  displayMixPage(mix)
}

export function navigateBack() {
  if (ui.navigationHistory.length === 0) {
    ui.currentView = 'home'
    dom.navItems.forEach(i => i.classList.remove('active'))
    document.querySelector('[data-view="home"]')?.classList.add('active')
    displayCurrentView()
    return
  }

  const previous = ui.navigationHistory.pop()
  ui.currentView = previous.view
  ui.filteredArtist = previous.filteredArtist

  if (previous.view === 'artist-page' && previous.artistPageKey) {
    ui.currentArtistPageKey = previous.artistPageKey
    ui.currentAlbumPageKey = null
  } else {
    ui.currentAlbumPageKey = null
    ui.currentArtistPageKey = null
  }

  dom.navItems.forEach(i => i.classList.remove('active'))
  const activeNav = document.querySelector(`[data-view="${ui.currentView}"]`)
  if (activeNav) activeNav.classList.add('active')

  displayCurrentView()

  if (previous.scrollPosition) {
    setTimeout(() => {
      const albumsView = document.querySelector('.albums-view')
      if (albumsView) albumsView.scrollTop = previous.scrollPosition
    }, 50)
  }
}

export function switchView(view) {
  if (!['home', 'albums', 'artists', 'tracks'].includes(view)) return

  dom.navItems.forEach(item => {
    item.classList.toggle('active', item.dataset.view === view)
  })

  const mainContent = document.querySelector('.main-content')
  mainContent.style.opacity = '0.5'
  mainContent.style.transition = 'opacity 0.15s ease'

  setTimeout(() => {
    ui.currentView = view
    displayCurrentView()

    mainContent.style.opacity = '1'
  }, 100)
}

// ============================================================
// DISCOVERY MIX GENERATION
// ============================================================

async function generateDiscoveryMixes() {
  try {
    const cached = localStorage.getItem(DISCOVERY_MIX_CACHE_KEY)
    if (cached) {
      const parsed = JSON.parse(cached)
      if (parsed.timestamp && (Date.now() - parsed.timestamp < DISCOVERY_MIX_TTL)) {
        const pathSet = new Set(library.tracks.map(t => t.path))
        const validMixes = parsed.mixes.filter(mix =>
          mix.tracks.some(path => pathSet.has(path))
        )
        if (validMixes.length > 0) {
          discoveryMixes = validMixes
          console.log(`[Discovery] Loaded ${validMixes.length} mixes from cache`)
          return discoveryMixes
        }
      }
    }
  } catch (e) {
    console.warn('[Discovery] Cache invalid:', e)
  }

  let playedPathsSet
  try {
    const playedPaths = await invoke('get_all_played_paths')
    playedPathsSet = new Set(playedPaths || [])
  } catch (err) {
    console.error('[Discovery] Failed to get played paths:', err)
    playedPathsSet = new Set()
  }

  const genreDecadeMap = new Map()

  for (const track of library.tracks) {
    if (!track.metadata) continue
    if (playedPathsSet.has(track.path)) continue
    if (!track.metadata.year) continue

    const genre = track.metadata.genre || null
    const decade = Math.floor(track.metadata.year / 10) * 10

    const key = genre ? `${genre}|${decade}` : `Discovery|${decade}`
    if (!genreDecadeMap.has(key)) {
      genreDecadeMap.set(key, [])
    }
    genreDecadeMap.get(key).push(track)
  }

  const MIN_TRACKS_PER_MIX = 10
  const MAX_TRACKS_PER_MIX = 50
  const MAX_TRACKS_PER_ARTIST = 3
  const MIN_ARTISTS_PER_MIX = 3

  const eligibleCombos = []
  for (const [key, trackList] of genreDecadeMap) {
    if (trackList.length >= MIN_TRACKS_PER_MIX) {
      const uniqueArtists = new Set(trackList.map(t => t.metadata?.artist || ''))
      if (uniqueArtists.size >= MIN_ARTISTS_PER_MIX) {
        const [genre, decade] = key.split('|')
        eligibleCombos.push({ genre, decade: parseInt(decade), tracks: trackList })
      }
    }
  }

  if (eligibleCombos.length === 0) {
    discoveryMixes = []
    console.log(`[Discovery] No eligible genre+decade combos (need >=${MIN_TRACKS_PER_MIX} tracks, >=${MIN_ARTISTS_PER_MIX} artists)`)
    return discoveryMixes
  }

  const shuffled = eligibleCombos.sort(() => Math.random() - 0.5)
  const selected = shuffled.slice(0, 20)

  discoveryMixes = selected.map((combo, index) => {
    const artistCount = new Map()
    const shuffledTracks = [...combo.tracks].sort(() => Math.random() - 0.5)
    const mixTracks = []
    for (const track of shuffledTracks) {
      if (mixTracks.length >= MAX_TRACKS_PER_MIX) break
      const artist = track.metadata?.artist || 'Unknown'
      const count = artistCount.get(artist) || 0
      if (count < MAX_TRACKS_PER_ARTIST) {
        mixTracks.push(track)
        artistCount.set(artist, count + 1)
      }
    }
    if (mixTracks.length < MIN_TRACKS_PER_MIX) {
      const usedPaths = new Set(mixTracks.map(t => t.path))
      for (const track of shuffledTracks) {
        if (mixTracks.length >= MAX_TRACKS_PER_MIX) break
        if (!usedPaths.has(track.path)) {
          mixTracks.push(track)
          usedPaths.add(track.path)
        }
      }
    }

    const coverTrack = mixTracks[Math.floor(Math.random() * mixTracks.length)]

    const decadeLabel = combo.decade >= 2000
      ? combo.decade.toString()
      : (combo.decade % 100).toString()

    return {
      id: `discovery-mix-${index}`,
      title: `Mix ${combo.genre} ${decadeLabel}`,
      genre: combo.genre,
      decade: combo.decade,
      decadeLabel,
      tracks: mixTracks.map(t => t.path),
      coverPath: coverTrack.path,
      trackCount: mixTracks.length
    }
  })

  try {
    localStorage.setItem(DISCOVERY_MIX_CACHE_KEY, JSON.stringify({
      timestamp: Date.now(),
      mixes: discoveryMixes
    }))
  } catch (e) {
    console.warn('[Discovery] Failed to cache mixes:', e)
  }

  console.log(`[Discovery] Generated ${discoveryMixes.length} mixes`)
  return discoveryMixes
}

export function invalidateDiscoveryMixCache() {
  localStorage.removeItem(DISCOVERY_MIX_CACHE_KEY)
  discoveryMixes = []
}

// ============================================================
// DISPLAY MIX PAGE
// ============================================================

export function displayMixPage(mix) {
  if (!mix) return

  const existingNav = document.querySelector('.alphabet-nav')
  if (existingNav) existingNav.remove()

  const mixTracks = mix.tracks
    .map(path => library.tracks.find(t => t.path === path))
    .filter(Boolean)

  if (mixTracks.length === 0) return

  const totalDuration = mixTracks.reduce((acc, t) => acc + (t.metadata?.duration || 0), 0)
  const cover = caches.coverCache.get(mix.coverPath) || caches.thumbnailCache.get(mix.coverPath)

  const pageContainer = document.createElement('div')
  pageContainer.className = 'album-page-container mix-page-container'

  pageContainer.innerHTML = `
    <div class="album-page-header">
      <button class="btn-back-nav" title="Retour">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 12H5"/>
          <path d="M12 19l-7-7 7-7"/>
        </svg>
      </button>
      <h1 class="album-page-title">${escapeHtml(mix.title)}</h1>
    </div>
    <div class="album-page-content">
      <div class="album-page-cover mix-page-cover-container">
        ${isValidImageSrc(cover)
          ? `<img src="${cover}" alt="${escapeHtml(mix.title)}" class="mix-page-cover-blurred">`
          : '<div class="album-cover-placeholder">\u266A</div>'
        }
        <div class="mix-page-cover-overlay">
          <span class="mix-page-title-overlay">${escapeHtml(mix.title)}</span>
        </div>
      </div>
      <div class="album-page-info">
        <p class="album-page-artist">${escapeHtml(mix.genre)} \u2014 ${mix.decadeLabel}</p>
        <p class="album-page-meta">
          ${mixTracks.length} titres &bull; ${formatTime(totalDuration)}
        </p>
        <div class="album-page-buttons">
          <button class="btn-primary-small play-mix-btn">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            Play
          </button>
          <button class="btn-add-queue-album add-mix-queue-btn" title="Add to queue">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 5v14"/><path d="M5 12h14"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
    <div class="album-page-tracks mix-page-tracks"></div>
  `

  pageContainer.querySelector('.btn-back-nav').addEventListener('click', navigateBack)

  pageContainer.querySelector('.play-mix-btn').addEventListener('click', () => {
    playMixTracks(mixTracks)
  })

  pageContainer.querySelector('.add-mix-queue-btn').addEventListener('click', () => {
    for (const track of mixTracks) {
      app.addToQueue(track)
    }
    showToast(`${mix.title} added to queue`)
  })

  const tracksContainer = pageContainer.querySelector('.mix-page-tracks')

  mixTracks.forEach((track, idx) => {
    const trackItem = document.createElement('div')
    trackItem.className = 'album-track-item'
    trackItem.dataset.trackPath = track.path

    const duration = track.metadata?.duration ? formatTime(track.metadata.duration) : '-'
    const trackArtist = track.metadata?.artist || 'Unknown Artist'
    const trackTitle = track.metadata?.title || track.name

    trackItem.innerHTML = `
      ${app.getFavoriteButtonHtml(track.path)}
      <span class="track-number">${idx + 1}</span>
      <div class="track-info">
        <span class="track-title">${escapeHtml(trackTitle)}</span>
        <span class="track-artist">${escapeHtml(trackArtist)}</span>
      </div>
      <span class="track-duration">${duration}</span>
    `

    trackItem.addEventListener('click', (e) => {
      if (e.target.closest('.favorite-btn')) return
      const globalIndex = library.tracks.findIndex(t => t.path === track.path)
      if (globalIndex !== -1) app.playTrack(globalIndex)
    })

    trackItem.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      const globalIndex = library.tracks.findIndex(t => t.path === track.path)
      if (globalIndex !== -1) app.showContextMenu(e, track, globalIndex)
    })

    tracksContainer.appendChild(trackItem)
  })

  if (!isValidImageSrc(cover) && mix.coverPath) {
    const pageImg = pageContainer.querySelector('.mix-page-cover-blurred')
    if (pageImg) {
      app.loadThumbnailAsync(mix.coverPath, pageImg, '', '').catch(() => {})
    }
  }

  dom.albumsGridDiv.appendChild(pageContainer)
}

function playMixTracks(mixTracks) {
  if (!mixTracks || mixTracks.length === 0) return
  const firstTrack = mixTracks[0]
  const globalIndex = library.tracks.findIndex(t => t.path === firstTrack.path)
  if (globalIndex !== -1) {
    for (let i = 1; i < mixTracks.length; i++) {
      app.addToQueue(mixTracks[i])
    }
    app.playTrack(globalIndex)
  }
}

// ============================================================
// DISPLAY ALBUM PAGE
// ============================================================

export function displayAlbumPage(albumKey) {
  const album = library.albums[albumKey]
  if (!album) return

  const existingNav = document.querySelector('.alphabet-nav')
  if (existingNav) existingNav.remove()

  const cover = caches.coverCache.get(album.coverPath) || caches.thumbnailCache.get(album.coverPath)

  const totalDuration = album.tracks.reduce((acc, t) => acc + (t.metadata?.duration || 0), 0)

  const firstTrack = album.tracks[0]
  const quality = formatQuality(firstTrack?.metadata, firstTrack?.path)

  const qualityTag = quality.label && quality.label !== '-'
    ? `<span class="quality-tag ${quality.class}">${quality.label}</span>`
    : ''

  const pageContainer = document.createElement('div')
  pageContainer.className = 'album-page-container'

  pageContainer.innerHTML = `
    <div class="album-page-header">
      <button class="btn-back-nav" title="Retour">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 12H5"/>
          <path d="M12 19l-7-7 7-7"/>
        </svg>
      </button>
      <h1 class="album-page-title">${album.album}</h1>
    </div>
    <div class="album-page-content">
      <div class="album-page-cover">
        ${isValidImageSrc(cover)
          ? `<img src="${cover}" alt="${album.album}">`
          : '<div class="album-cover-placeholder">\u266A</div>'
        }
      </div>
      <div class="album-page-info">
        <p class="album-page-artist clickable-artist" data-artist="${escapeHtml(album.artist)}">${escapeHtml(album.artist)}</p>
        <p class="album-page-meta">
          ${album.tracks.length} titres \u2022 ${formatTime(totalDuration)}${firstTrack?.metadata?.year ? ` \u2022 ${firstTrack.metadata.year}` : ''}
          ${qualityTag ? `<span class="album-page-tags">${qualityTag}</span>` : ''}
        </p>
        <div class="album-page-buttons">
          <button class="btn-primary-small play-album-btn">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
            Play
          </button>
          <button class="btn-add-queue-album add-album-queue-btn" title="Add to queue">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M16 5H3"/><path d="M16 12H3"/><path d="M9 19H3"/><path d="m16 16-3 3 3 3"/><path d="M21 5v12a2 2 0 0 1-2 2h-6"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
    <div class="album-page-tracks"></div>
  `

  pageContainer.querySelector('.btn-back-nav').addEventListener('click', navigateBack)

  const artistLink = pageContainer.querySelector('.album-page-artist.clickable-artist')
  if (artistLink && library.artists[album.artist]) {
    artistLink.addEventListener('click', () => {
      navigateToArtistPage(album.artist)
    })
  }

  pageContainer.querySelector('.play-album-btn').addEventListener('click', () => {
    app.playAlbum(albumKey)
  })

  pageContainer.querySelector('.add-album-queue-btn').addEventListener('click', () => {
    app.addAlbumToQueue(albumKey)
    app.showQueueNotification(`Album "${album.album}" added to queue`)
  })

  const tracksContainer = pageContainer.querySelector('.album-page-tracks')

  const uniqueArtists = new Set(album.tracks.map(t => t.metadata?.artist || album.artist))
  const isMultiArtist = uniqueArtists.size > 1

  const uniqueDiscs = new Set(album.tracks.map(t => t.metadata?.disc || 1))
  const isMultiDisc = uniqueDiscs.size > 1
  let currentDiscNumber = null

  album.tracks.forEach((track, idx) => {
    if (isMultiDisc) {
      const disc = track.metadata?.disc || 1
      if (disc !== currentDiscNumber) {
        currentDiscNumber = disc
        const separator = document.createElement('div')
        separator.className = 'disc-separator'
        separator.innerHTML = `<span class="disc-label">CD ${disc}</span>`
        tracksContainer.appendChild(separator)
      }
    }

    const trackItem = document.createElement('div')
    trackItem.className = 'album-track-item'
    trackItem.dataset.trackPath = track.path

    const duration = track.metadata?.duration ? formatTime(track.metadata.duration) : '-'
    const trackArtist = track.metadata?.artist || album.artist

    trackItem.innerHTML = `
      ${app.getFavoriteButtonHtml(track.path)}
      <span class="track-number">${track.metadata?.track || (idx + 1)}</span>
      ${isMultiArtist
        ? `<div class="track-info">
            <span class="track-title">${track.metadata?.title || track.name}</span>
            <span class="track-artist">${trackArtist}</span>
          </div>`
        : `<span class="track-title">${track.metadata?.title || track.name}</span>`
      }
      <button class="track-add-queue${queue.items.some(q => q.path === track.path) ? ' in-queue' : ''}" title="Add to queue">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M16 5H3"/><path d="M16 12H3"/><path d="M9 19H3"/><path d="m16 16-3 3 3 3"/><path d="M21 5v12a2 2 0 0 1-2 2h-6"/>
        </svg>
      </button>
      <button class="track-add-playlist" title="Add to playlist">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 5v14"/><path d="M5 12h14"/>
        </svg>
      </button>
      <span class="track-duration">${duration}</span>
    `

    trackItem.addEventListener('dblclick', () => {
      const globalIndex = library.tracks.findIndex(t => t.path === track.path)
      if (globalIndex !== -1) {
        playback.currentPlayingAlbumKey = albumKey
        app.playTrack(globalIndex)
      }
    })

    trackItem.querySelector('.track-add-queue').addEventListener('click', (e) => {
      e.stopPropagation()
      app.addToQueue(track)
      app.showQueueNotification(`"${track.metadata?.title || track.name}" added to queue`)
      trackItem.querySelector('.track-add-queue').classList.add('in-queue')
    })

    trackItem.querySelector('.track-add-playlist').addEventListener('click', (e) => {
      e.stopPropagation()
      app.showAddToPlaylistMenu(e, track)
    })

    const favBtn = trackItem.querySelector('.track-favorite-btn')
    if (favBtn) {
      favBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        app.toggleFavorite(track.path, favBtn)
      })
    }

    trackItem.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return
      app.prepareCustomDrag(e, track, trackItem)
    })

    trackItem.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      const globalIndex = library.tracks.findIndex(t => t.path === track.path)
      app.showContextMenu(e, track, globalIndex)
    })

    tracksContainer.appendChild(trackItem)
  })

  dom.albumsGridDiv.appendChild(pageContainer)

  if (!isValidImageSrc(cover) && album.coverPath) {
    const albumPageCoverContainer = pageContainer.querySelector('.album-page-cover')
    if (albumPageCoverContainer) {
      const hiddenImg = document.createElement('img')
      hiddenImg.style.display = 'none'
      albumPageCoverContainer.appendChild(hiddenImg)

      app.loadThumbnailAsync(album.coverPath, hiddenImg).then(() => {
        const cachedSrc = caches.coverCache.get(album.coverPath) || caches.thumbnailCache.get(album.coverPath)
        if (isValidImageSrc(cachedSrc) && albumPageCoverContainer) {
          const placeholder = albumPageCoverContainer.querySelector('.album-cover-placeholder')
          if (placeholder) {
            const newImg = document.createElement('img')
            newImg.src = cachedSrc
            newImg.alt = album.album
            placeholder.replaceWith(newImg)
          }
          if (hiddenImg.parentNode) hiddenImg.remove()
        }
      })
    }
  }

  const albumsView = document.querySelector('.albums-view')
  if (albumsView) albumsView.scrollTop = 0
}

// ============================================================
// SHOW / CLOSE ALBUM DETAIL (inline panel in albums grid)
// ============================================================

export function showAlbumDetail(albumKey, cover, clickedCard) {
  closeAlbumDetail()

  ui.selectedAlbumKey = albumKey
  const album = library.albums[albumKey]

  ui.albumDetailDiv = document.createElement('div')
  ui.albumDetailDiv.className = 'album-detail'
  ui.albumDetailDiv.id = 'album-detail'

  const totalDuration = album.tracks.reduce((acc, t) => acc + (t.metadata?.duration || 0), 0)

  const firstTrack = album.tracks[0]
  const albumQuality = formatQuality(firstTrack?.metadata, firstTrack?.path)
  const qualityTag = albumQuality.label !== '-'
    ? `<span class="quality-tag ${albumQuality.class}">${albumQuality.label}</span>`
    : ''

  ui.albumDetailDiv.innerHTML = `
    <div class="album-detail-header">
      <div class="album-detail-cover">
        ${isValidImageSrc(cover)
          ? `<img src="${cover}" alt="${album.album}">`
          : '<div class="album-cover-placeholder">\u266A</div>'
        }
      </div>
      <div class="album-detail-info">
        <h2 class="album-detail-title">${album.album}</h2>
        <p class="album-detail-artist">${album.artist}</p>
        <p class="album-detail-meta">
          ${album.tracks.length} titres \u2022 ${formatTime(totalDuration)}${firstTrack?.metadata?.year ? ` \u2022 ${firstTrack.metadata.year}` : ''}
          ${qualityTag ? `<span class="album-detail-tags">${qualityTag}</span>` : ''}
        </p>
        <div class="album-detail-buttons">
          <button class="btn-primary-small play-album-btn">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
            Play
          </button>
          <button class="btn-add-queue-album add-album-queue-btn" title="Add all to queue">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M16 5H3"/><path d="M16 12H3"/><path d="M9 19H3"/><path d="m16 16-3 3 3 3"/><path d="M21 5v12a2 2 0 0 1-2 2h-6"/>
            </svg>
          </button>
        </div>
      </div>
      <button class="btn-close close-album-detail">\u2715</button>
    </div>
    <div class="album-tracks"></div>
  `

  // Async cover loading fallback
  if (!isValidImageSrc(cover) && album.coverPath) {
    const detailCoverContainer = ui.albumDetailDiv.querySelector('.album-detail-cover')
    if (detailCoverContainer) {
      const hiddenImg = document.createElement('img')
      hiddenImg.style.display = 'none'
      detailCoverContainer.appendChild(hiddenImg)

      app.loadThumbnailAsync(album.coverPath, hiddenImg).then(() => {
        const cachedCover = caches.coverCache.get(album.coverPath) || caches.thumbnailCache.get(album.coverPath)
        if (isValidImageSrc(cachedCover) && detailCoverContainer) {
          const placeholder = detailCoverContainer.querySelector('.album-cover-placeholder')
          if (placeholder) {
            const newImg = document.createElement('img')
            newImg.src = cachedCover
            newImg.alt = album.album
            placeholder.replaceWith(newImg)
          }
          if (hiddenImg.parentNode) hiddenImg.remove()
        }
      })
    }
  }

  // Track list
  const albumTracksDiv = ui.albumDetailDiv.querySelector('.album-tracks')
  album.tracks.forEach((track, index) => {
    const trackItem = document.createElement('div')
    trackItem.className = 'album-track-item'
    trackItem.dataset.trackPath = track.path

    const duration = track.metadata?.duration ? formatTime(track.metadata.duration) : '-:--'
    const trackArtist = track.metadata?.artist || 'Unknown Artist'

    const isInQueue = queue.items.some(q => q.path === track.path)
    const inQueueClass = isInQueue ? 'in-queue' : ''
    const buttonsHtml = `
      <button class="track-add-playlist" title="Add to playlist">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>
        </svg>
      </button>
      <button class="track-add-queue ${inQueueClass}" title="${isInQueue ? 'Already in queue' : 'Add to queue'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M16 5H3"/><path d="M16 12H3"/><path d="M9 19H3"/><path d="m16 16-3 3 3 3"/><path d="M21 5v12a2 2 0 0 1-2 2h-6"/>
        </svg>
      </button>
    `

    if (album.isVariousArtists) {
      trackItem.innerHTML = `
        ${app.getFavoriteButtonHtml(track.path)}
        <span class="track-number">${track.metadata?.track || index + 1}</span>
        <div class="track-info">
          <span class="track-title">${track.metadata?.title || track.name}</span>
          <span class="track-artist">${trackArtist}</span>
        </div>
        <span class="track-duration">${duration}</span>
        ${buttonsHtml}
      `
    } else {
      trackItem.innerHTML = `
        ${app.getFavoriteButtonHtml(track.path)}
        <span class="track-number">${track.metadata?.track || index + 1}</span>
        <span class="track-title">${track.metadata?.title || track.name}</span>
        <span class="track-duration">${duration}</span>
        ${buttonsHtml}
      `
    }

    albumTracksDiv.appendChild(trackItem)
  })

  // Event delegation for album detail tracks
  albumTracksDiv.addEventListener('click', (e) => {
    const trackItem = e.target.closest('.album-track-item')
    if (!trackItem) return

    const trackPath = trackItem.dataset.trackPath
    const track = library.tracks.find(t => t.path === trackPath)
    if (!track) return

    const addQueueBtn = e.target.closest('.track-add-queue')
    if (addQueueBtn) {
      e.stopPropagation()
      const isInQueue = queue.items.some(q => q.path === track.path)
      if (isInQueue) {
        const queueIndex = queue.items.findIndex(q => q.path === track.path)
        if (queueIndex !== -1) {
          app.removeFromQueue(queueIndex)
        }
        addQueueBtn.classList.remove('in-queue')
        addQueueBtn.title = 'Add to queue'
      } else {
        app.addToQueue(track)
        addQueueBtn.classList.add('in-queue')
        addQueueBtn.title = 'Remove from queue'
      }
      return
    }

    if (e.target.closest('.track-add-playlist')) {
      e.stopPropagation()
      app.showAddToPlaylistMenu(e, track)
      return
    }

    const favBtn = e.target.closest('.track-favorite-btn')
    if (favBtn) {
      e.stopPropagation()
      app.toggleFavorite(track.path, favBtn)
      return
    }

    // Simple click = select track
    albumTracksDiv.querySelectorAll('.album-track-item.selected').forEach(el => {
      el.classList.remove('selected')
    })
    trackItem.classList.add('selected')
  })

  albumTracksDiv.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return
    const trackItem = e.target.closest('.album-track-item')
    if (!trackItem) return

    const trackPath = trackItem.dataset.trackPath
    const globalIndex = library.tracks.findIndex(t => t.path === trackPath)
    if (globalIndex !== -1) {
      app.playTrack(globalIndex)
      updateAlbumTracksHighlight()
    }
  })

  albumTracksDiv.addEventListener('contextmenu', (e) => {
    const trackItem = e.target.closest('.album-track-item')
    if (!trackItem) return

    const trackPath = trackItem.dataset.trackPath
    const track = library.tracks.find(t => t.path === trackPath)
    if (!track) return

    const globalIndex = library.tracks.findIndex(t => t.path === trackPath)
    app.showContextMenu(e, track, globalIndex)
  })

  albumTracksDiv.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return
    const trackItem = e.target.closest('.album-track-item')
    if (!trackItem) return

    const trackPath = trackItem.dataset.trackPath
    const track = library.tracks.find(t => t.path === trackPath)
    if (!track) return

    app.prepareCustomDrag(e, track, trackItem)
  })

  // Context menu on album detail header
  ui.albumDetailDiv.querySelector('.album-detail-header').addEventListener('contextmenu', (e) => {
    e.preventDefault()
    app.showAlbumContextMenu(e, albumKey)
  })

  // Panel buttons
  ui.albumDetailDiv.querySelector('.close-album-detail').addEventListener('click', closeAlbumDetail)
  ui.albumDetailDiv.querySelector('.play-album-btn').addEventListener('click', () => {
    if (ui.selectedAlbumKey) app.playAlbum(ui.selectedAlbumKey)
  })
  ui.albumDetailDiv.querySelector('.add-album-queue-btn').addEventListener('click', () => {
    if (ui.selectedAlbumKey) {
      const alb = library.albums[ui.selectedAlbumKey]
      alb.tracks.forEach(track => app.addToQueue(track))
      app.showQueueNotification(`${alb.tracks.length} tracks added to queue`)
    }
  })

  // Insert panel after clicked row
  const gridContainer = clickedCard.closest('.albums-grid-container')
  if (gridContainer) {
    const allCards = Array.from(gridContainer.querySelectorAll('.album-card'))
    const clickedIndex = allCards.indexOf(clickedCard)
    const gridStyle = window.getComputedStyle(gridContainer)
    const gridColumns = gridStyle.gridTemplateColumns.split(' ').length
    const rowEnd = Math.ceil((clickedIndex + 1) / gridColumns) * gridColumns - 1
    const lastCardInRow = allCards[Math.min(rowEnd, allCards.length - 1)]
    lastCardInRow.after(ui.albumDetailDiv)
  } else {
    dom.albumsGridDiv.appendChild(ui.albumDetailDiv)
  }

  setTimeout(() => {
    ui.albumDetailDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, 50)

  updateAlbumTracksHighlight()
}

export function updateAlbumTracksHighlight() {
  if (!ui.selectedAlbumKey || !ui.albumDetailDiv) return

  const album = library.albums[ui.selectedAlbumKey]
  const trackItems = ui.albumDetailDiv.querySelectorAll('.album-track-item')

  trackItems.forEach((item, index) => {
    const track = album.tracks[index]
    const globalIndex = library.tracks.findIndex(t => t.path === track.path)
    item.classList.toggle('playing', globalIndex === playback.currentTrackIndex)
  })
}

export function closeAlbumDetail() {
  if (ui.albumDetailDiv) {
    ui.albumDetailDiv.remove()
    ui.albumDetailDiv = null
  }
  ui.selectedAlbumKey = null
}

// ============================================================
// UPDATE NOW PLAYING HIGHLIGHT (for album-page and track views)
// ============================================================

export function updateNowPlayingHighlight() {
  // Update album detail panel if open
  updateAlbumTracksHighlight()

  // Update album page tracks if on album-page view
  if (ui.currentView === 'album-page' && ui.currentAlbumPageKey) {
    const trackItems = dom.albumsGridDiv.querySelectorAll('.album-track-item')
    const currentTrack = playback.currentTrackIndex >= 0 ? library.tracks[playback.currentTrackIndex] : null
    trackItems.forEach(item => {
      item.classList.toggle('playing', currentTrack && item.dataset.trackPath === currentTrack.path)
    })
  }

  // Update mix page tracks if on mix-page view
  if (ui.currentView === 'mix-page') {
    const trackItems = dom.albumsGridDiv.querySelectorAll('.album-track-item')
    const currentTrack = playback.currentTrackIndex >= 0 ? library.tracks[playback.currentTrackIndex] : null
    trackItems.forEach(item => {
      item.classList.toggle('playing', currentTrack && item.dataset.trackPath === currentTrack.path)
    })
  }
}

// ============================================================
// HOME VIEW
// ============================================================

export async function displayHomeView() {
  dom.albumsGridDiv.classList.remove('tracks-mode')

  const existingNav = document.querySelector('.alphabet-nav')
  if (existingNav) existingNav.remove()

  const now = Date.now()
  const cacheValid = caches.homeDataCache.isValid && (now - caches.homeDataCache.lastFetch < HOME_CACHE_TTL)

  let lastPlayed, recentTracks, allPlayedAlbums, topArtists

  if (cacheValid) {
    lastPlayed = caches.homeDataCache.lastPlayed
    recentTracks = caches.homeDataCache.recentTracks
    allPlayedAlbums = caches.homeDataCache.allPlayedAlbums
    topArtists = caches.homeDataCache.topArtists
  } else {
    try {
      const [lastPlayedResult, recentTracksResult, allPlayedAlbumsResult, topArtistsResult] = await Promise.all([
        invoke('get_last_played').catch(() => null),
        invoke('get_recent_albums', { days: 15 }).catch(() => []),
        invoke('get_all_played_albums').catch(() => []),
        invoke('get_top_artists', { limit: 20 }).catch(() => [])
      ])
      lastPlayed = lastPlayedResult
      recentTracks = recentTracksResult || []
      allPlayedAlbums = allPlayedAlbumsResult || []
      topArtists = topArtistsResult || []

      caches.homeDataCache.lastPlayed = lastPlayed
      caches.homeDataCache.recentTracks = recentTracks
      caches.homeDataCache.allPlayedAlbums = allPlayedAlbums
      caches.homeDataCache.topArtists = topArtists
      caches.homeDataCache.lastFetch = now
      caches.homeDataCache.isValid = true
    } catch (err) {
      console.error('Erreur chargement historique:', err)
      lastPlayed = null
      recentTracks = []
      allPlayedAlbums = []
      topArtists = []
    }
  }

  await generateDiscoveryMixes()

  const homeContainer = document.createElement('div')
  homeContainer.className = 'home-container'

  // === 1. Now Playing / Resume tile ===
  const isCurrentlyPlaying = playback.audioIsPlaying && playback.currentTrackIndex >= 0
  const currentTrack = isCurrentlyPlaying ? library.tracks[playback.currentTrackIndex] : null
  const displayTrack = currentTrack || (lastPlayed && lastPlayed.path ? lastPlayed : null)

  if (displayTrack) {
    const resumeSection = document.createElement('section')
    resumeSection.className = 'home-section home-resume-section'
    resumeSection.id = 'home-now-playing-section'

    const resumeTile = document.createElement('div')
    resumeTile.className = 'home-resume-tile'
    resumeTile.dataset.trackPath = displayTrack.path

    const title = currentTrack?.metadata?.title || currentTrack?.name || displayTrack.title || 'Titre inconnu'
    const artist = currentTrack?.metadata?.artist || displayTrack.artist || 'Unknown Artist'
    const albumName = currentTrack?.metadata?.album || displayTrack.album || ''
    const label = isCurrentlyPlaying ? 'Now Playing' : 'Resume Playback'

    let specsTagsHtml = ''
    if (currentTrack?.metadata) {
      const meta = currentTrack.metadata
      const codec = meta.codec || getCodecFromPath(currentTrack.path)
      const bitDepth = meta.bitDepth ? `${meta.bitDepth}-bit` : ''
      const sampleRate = meta.sampleRate ? `${(meta.sampleRate / 1000).toFixed(1).replace('.0', '')}kHz` : ''
      const duration = meta.duration ? formatTime(meta.duration) : ''

      const tags = []
      if (bitDepth) tags.push(`<span class="resume-spec-tag bitdepth">${bitDepth}</span>`)
      if (sampleRate) tags.push(`<span class="resume-spec-tag samplerate">${sampleRate}</span>`)

      const textParts = []
      if (codec) textParts.push(codec.toUpperCase())
      if (duration) textParts.push(duration)
      const textSpecs = textParts.length > 0 ? `<span class="resume-specs-text">${textParts.join(' \u2022 ')}</span>` : ''

      if (tags.length > 0 || textSpecs) {
        specsTagsHtml = `<div class="resume-specs-container">${tags.join('')}${textSpecs}</div>`
      }
    }

    resumeTile.innerHTML = `
      <div class="resume-cover">
        <img class="resume-cover-img" style="display: none;" alt="">
        <div class="resume-cover-placeholder">\u266A</div>
      </div>
      <div class="resume-info">
        <span class="resume-label${isCurrentlyPlaying ? ' resume-label-active' : ''}">${label}</span>
        <span class="resume-title">${escapeHtml(title)}</span>
        <span class="resume-artist">${escapeHtml(artist)}</span>
        ${albumName ? `<span class="resume-album">${escapeHtml(albumName)}</span>` : ''}
        ${specsTagsHtml}
      </div>
      <button class="resume-play-btn">${isCurrentlyPlaying ? '\u23F8' : '\u25B6'}</button>
    `

    // Particle animation for currently playing track
    if (isCurrentlyPlaying) {
      createParticleCanvas(resumeTile)
    }

    const coverPath = currentTrack?.path || displayTrack.path
    const img = resumeTile.querySelector('.resume-cover-img')
    const placeholder = resumeTile.querySelector('.resume-cover-placeholder')
    if (img && placeholder) {
      const cachedCover = caches.coverCache.get(coverPath) || caches.thumbnailCache.get(coverPath)
      if (!loadCachedImage(img, placeholder, cachedCover)) {
        app.loadThumbnailAsync(coverPath, img, artist, albumName).then(() => {
          if (img.isConnected && img.style.display === 'block') {
            placeholder.style.display = 'none'
          }
        })
      }
    }

    resumeSection.appendChild(resumeTile)
    homeContainer.appendChild(resumeSection)
  }

  // === 2. Recently Played grid ===
  if (recentTracks.length > 0) {
    const recentSection = document.createElement('section')
    recentSection.className = 'home-section'

    const recentHeader = document.createElement('h2')
    recentHeader.className = 'home-section-title'
    recentHeader.textContent = 'Recently Played'
    recentSection.appendChild(recentHeader)

    const grid = document.createElement('div')
    grid.className = 'home-recent-grid'

    const maxTracks = 6
    const uniqueTracks = []
    const seenTracks = new Set()
    for (const entry of recentTracks) {
      if (entry && entry.path && !seenTracks.has(entry.path)) {
        seenTracks.add(entry.path)
        uniqueTracks.push(entry)
        if (uniqueTracks.length >= maxTracks) break
      }
    }

    for (const entry of uniqueTracks) {
      const albumKey = entry.album || 'Unknown Album'
      const album = library.albums[albumKey]

      const item = document.createElement('div')
      item.className = 'recent-track-item'
      item.dataset.trackPath = entry.path
      item.innerHTML = `
        <div class="recent-track-cover">
          <img class="recent-track-img" style="display: none;" alt="">
          <div class="recent-track-placeholder">\u266A</div>
        </div>
        <div class="recent-track-info">
          <span class="recent-track-title">${escapeHtml(entry.title) || 'Titre inconnu'}</span>
          <span class="recent-track-artist">${escapeHtml(entry.artist) || 'Unknown Artist'}</span>
          <span class="recent-track-album">${escapeHtml(entry.album) || ''}</span>
        </div>
      `

      const img = item.querySelector('.recent-track-img')
      const placeholder = item.querySelector('.recent-track-placeholder')

      const coverPath = (album && album.coverPath) ? album.coverPath : entry.path
      if (img && placeholder) {
        const cachedCover = caches.coverCache.get(coverPath)
        if (!loadCachedImage(img, placeholder, cachedCover)) {
          app.loadThumbnailAsync(coverPath, img, entry.artist, entry.album).then(() => {
            if (img.isConnected && img.style.display === 'block') {
              placeholder.style.display = 'none'
            }
          })
        }
      }

      grid.appendChild(item)
    }

    recentSection.appendChild(grid)
    homeContainer.appendChild(recentSection)
  }

  // === 3. New Releases carousel ===
  const albumKeys = Object.keys(library.albums)
  if (albumKeys.length > 0 && Object.keys(library.trackAddedDates).length > 0) {
    const sortedByRecent = albumKeys
      .map(key => {
        const album = library.albums[key]
        let mostRecentDate = 0
        for (const track of album.tracks) {
          const addedDate = library.trackAddedDates[track.path] || 0
          if (addedDate > mostRecentDate) {
            mostRecentDate = addedDate
          }
        }
        return { key, album, addedDate: mostRecentDate }
      })
      .filter(item => item.addedDate > 0)
      .sort((a, b) => b.addedDate - a.addedDate)
      .slice(0, 25)

    if (sortedByRecent.length > 0) {
      const newSection = document.createElement('section')
      newSection.className = 'home-section'
      newSection.id = 'home-nouveautes-section'

      const newHeader = document.createElement('h2')
      newHeader.className = 'home-section-title'
      newHeader.textContent = 'New Releases'
      newSection.appendChild(newHeader)

      const newCarousel = document.createElement('div')
      newCarousel.className = 'home-carousel'
      newCarousel.id = 'nouveautes-carousel'

      const { carousel: maxCarousel } = getResponsiveItemCount()
      const selection = sortedByRecent.slice(0, maxCarousel)

      for (const { key: aKey, album } of selection) {
        if (!album) continue
        const item = createCarouselAlbumItem(aKey, album)
        newCarousel.appendChild(item)
      }

      newSection.appendChild(newCarousel)
      homeContainer.appendChild(newSection)
    }
  }

  // === 4. Discover carousel (unplayed albums) ===
  const playedAlbumsSet = new Set(allPlayedAlbums.map(e => e?.album || ''))
  const unplayedAlbums = Object.keys(library.albums).filter(key => !playedAlbumsSet.has(key))

  if (unplayedAlbums.length > 0) {
    const discoverSection = document.createElement('section')
    discoverSection.className = 'home-section'
    discoverSection.id = 'home-decouvrir-section'

    const discoverHeader = document.createElement('h2')
    discoverHeader.className = 'home-section-title'
    discoverHeader.textContent = 'Discover'
    discoverSection.appendChild(discoverHeader)

    const carousel = document.createElement('div')
    carousel.className = 'home-carousel'
    carousel.id = 'decouvrir-carousel'

    const { carousel: maxCarousel } = getResponsiveItemCount()
    const shuffled = [...unplayedAlbums].sort(() => Math.random() - 0.5)
    const selection = shuffled.slice(0, maxCarousel)

    for (const aKey of selection) {
      const album = library.albums[aKey]
      if (!album) continue
      const item = createCarouselAlbumItem(aKey, album)
      carousel.appendChild(item)
    }

    discoverSection.appendChild(carousel)
    homeContainer.appendChild(discoverSection)
  }

  // === 5. Your Favorite Artists ===
  if (topArtists.length >= 5) {
    const artistsSection = document.createElement('section')
    artistsSection.className = 'home-section'

    const artistsHeader = document.createElement('h2')
    artistsHeader.className = 'home-section-title'
    artistsHeader.textContent = 'Your Favorite Artists'
    artistsSection.appendChild(artistsHeader)

    const artistsCarousel = document.createElement('div')
    artistsCarousel.className = 'home-carousel'

    for (const artist of topArtists) {
      const item = document.createElement('div')
      item.className = 'carousel-item artist-carousel-item'
      item.dataset.artistName = artist.name
      item.innerHTML = `
        <div class="carousel-cover artist-cover">
          <img class="carousel-cover-img artist-cover-img" style="display: none;" alt="">
          <div class="carousel-cover-placeholder">\uD83D\uDC64</div>
        </div>
        <div class="carousel-title">${escapeHtml(artist.name)}</div>
        <div class="carousel-artist">${artist.play_count} plays</div>
      `

      const img = item.querySelector('.carousel-cover-img')
      const placeholder = item.querySelector('.carousel-cover-placeholder')

      if (img && placeholder) {
        app.loadArtistImageAsync(artist.name, img, artist.sample_album, artist.sample_path).then(() => {
          if (img.isConnected && img.style.display === 'block') {
            placeholder.style.display = 'none'
          }
        })
      }

      artistsCarousel.appendChild(item)
    }

    artistsSection.appendChild(artistsCarousel)
    homeContainer.appendChild(artistsSection)
  }

  // === 6. Audiophile Quality carousel ===
  const hiResAlbumKeys = Object.keys(library.albums).filter(key => {
    const album = library.albums[key]
    return album.tracks.some(track => {
      const bd = track.metadata?.bitDepth
      const sr = track.metadata?.sampleRate
      return (bd && bd >= 24) || (sr && sr >= 88200)
    })
  })

  const hiResSelection = hiResAlbumKeys.reverse().slice(0, 25)

  if (hiResSelection.length > 0) {
    const hiResSection = document.createElement('section')
    hiResSection.className = 'home-section'

    const hiResHeader = document.createElement('h2')
    hiResHeader.className = 'home-section-title'
    hiResHeader.textContent = 'Audiophile Quality'
    hiResSection.appendChild(hiResHeader)

    const hiResCarousel = document.createElement('div')
    hiResCarousel.className = 'home-carousel'

    for (const aKey of hiResSelection) {
      const album = library.albums[aKey]
      if (!album) continue

      const hiResTrack = album.tracks.find(t =>
        (t.metadata?.bitDepth >= 24) || (t.metadata?.sampleRate >= 88200)
      )
      const quality = formatQuality(hiResTrack?.metadata, hiResTrack?.path)

      const item = document.createElement('div')
      item.className = 'carousel-item hires-carousel-item'
      item.dataset.albumKey = aKey
      item.innerHTML = `
        <div class="carousel-cover">
          <img class="carousel-cover-img" style="display: none;" alt="">
          <div class="carousel-cover-placeholder">\u266A</div>
          <span class="hires-badge">${quality.label}</span>
        </div>
        <div class="carousel-title">${escapeHtml(album.album)}</div>
        <div class="carousel-artist">${escapeHtml(album.artist)}</div>
      `

      const img = item.querySelector('.carousel-cover-img')
      const placeholder = item.querySelector('.carousel-cover-placeholder')

      if (album.coverPath && img && placeholder) {
        const cachedCover = caches.coverCache.get(album.coverPath)
        if (!loadCachedImage(img, placeholder, cachedCover)) {
          app.loadThumbnailAsync(album.coverPath, img, album.artist, album.album).then(() => {
            if (img.isConnected && img.style.display === 'block') {
              placeholder.style.display = 'none'
            }
          })
        }
      }

      hiResCarousel.appendChild(item)
    }

    hiResSection.appendChild(hiResCarousel)
    homeContainer.appendChild(hiResSection)
  }

  // === 7. Long Albums carousel (> 60 minutes) ===
  const longAlbumKeys = Object.keys(library.albums).filter(key => {
    const album = library.albums[key]
    const totalDuration = album.tracks.reduce((sum, track) => {
      return sum + (track.metadata?.duration || 0)
    }, 0)
    return totalDuration >= 3600
  })

  if (longAlbumKeys.length >= 3) {
    const longSection = document.createElement('section')
    longSection.className = 'home-section'

    const longHeader = document.createElement('h2')
    longHeader.className = 'home-section-title'
    longHeader.textContent = 'Long Albums'
    longSection.appendChild(longHeader)

    const longCarousel = document.createElement('div')
    longCarousel.className = 'home-carousel'

    const sortedByDuration = longAlbumKeys
      .map(key => {
        const album = library.albums[key]
        const totalDuration = album.tracks.reduce((sum, t) => sum + (t.metadata?.duration || 0), 0)
        return { key, album, duration: totalDuration }
      })
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 15)

    for (const { key: aKey, album, duration } of sortedByDuration) {
      if (!album) continue

      const durationStr = formatAlbumDuration(duration)

      const item = document.createElement('div')
      item.className = 'carousel-item'
      item.dataset.albumKey = aKey
      item.innerHTML = `
        <div class="carousel-cover">
          <img class="carousel-cover-img" style="display: none;" alt="">
          <div class="carousel-cover-placeholder">\u266A</div>
          <span class="duration-badge">${durationStr}</span>
        </div>
        <div class="carousel-title">${escapeHtml(album.album)}</div>
        <div class="carousel-artist">${escapeHtml(album.artist)}</div>
      `

      const img = item.querySelector('.carousel-cover-img')
      const placeholder = item.querySelector('.carousel-cover-placeholder')

      if (album.coverPath && img && placeholder) {
        const cachedCover = caches.coverCache.get(album.coverPath)
        if (!loadCachedImage(img, placeholder, cachedCover)) {
          app.loadThumbnailAsync(album.coverPath, img, album.artist, album.album).then(() => {
            if (img.isConnected && img.style.display === 'block') {
              placeholder.style.display = 'none'
            }
          })
        }
      }

      longCarousel.appendChild(item)
    }

    longSection.appendChild(longCarousel)
    homeContainer.appendChild(longSection)
  }

  // === 8. Added This Week ===
  const oneWeekAgo = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60)
  const thisWeekAlbums = Object.keys(library.albums)
    .map(key => {
      const album = library.albums[key]
      let mostRecentDate = 0
      for (const track of album.tracks) {
        const addedDate = library.trackAddedDates[track.path] || 0
        if (addedDate > mostRecentDate) {
          mostRecentDate = addedDate
        }
      }
      return { key, album, addedDate: mostRecentDate }
    })
    .filter(item => item.addedDate >= oneWeekAgo)
    .sort((a, b) => b.addedDate - a.addedDate)
    .slice(0, 15)

  if (thisWeekAlbums.length >= 3) {
    const weekSection = document.createElement('section')
    weekSection.className = 'home-section'

    const weekHeader = document.createElement('h2')
    weekHeader.className = 'home-section-title'
    weekHeader.textContent = 'Added This Week'
    weekSection.appendChild(weekHeader)

    const weekCarousel = document.createElement('div')
    weekCarousel.className = 'home-carousel'

    for (const { key: aKey, album, addedDate } of thisWeekAlbums) {
      if (!album) continue

      const daysAgo = Math.floor((Date.now() / 1000 - addedDate) / (24 * 60 * 60))
      const timeLabel = daysAgo === 0 ? "Aujourd'hui" : daysAgo === 1 ? 'Hier' : `Il y a ${daysAgo}j`

      const item = document.createElement('div')
      item.className = 'carousel-item'
      item.dataset.albumKey = aKey
      item.innerHTML = `
        <div class="carousel-cover">
          <img class="carousel-cover-img" style="display: none;" alt="">
          <div class="carousel-cover-placeholder">\u266A</div>
          <span class="time-badge">${timeLabel}</span>
        </div>
        <div class="carousel-title">${escapeHtml(album.album)}</div>
        <div class="carousel-artist">${escapeHtml(album.artist)}</div>
      `

      const img = item.querySelector('.carousel-cover-img')
      const placeholder = item.querySelector('.carousel-cover-placeholder')

      if (album.coverPath && img && placeholder) {
        const cachedCover = caches.coverCache.get(album.coverPath)
        if (!loadCachedImage(img, placeholder, cachedCover)) {
          app.loadThumbnailAsync(album.coverPath, img, album.artist, album.album).then(() => {
            if (img.isConnected && img.style.display === 'block') {
              placeholder.style.display = 'none'
            }
          })
        }
      }

      weekCarousel.appendChild(item)
    }

    weekSection.appendChild(weekCarousel)
    homeContainer.appendChild(weekSection)
  }

  // === 9. Random Mix ===
  const allAlbumKeys = Object.keys(library.albums)
  if (allAlbumKeys.length >= 10) {
    const mixSection = document.createElement('section')
    mixSection.className = 'home-section'

    const mixHeader = document.createElement('h2')
    mixHeader.className = 'home-section-title'
    mixHeader.textContent = 'Random Mix'
    mixSection.appendChild(mixHeader)

    const mixCarousel = document.createElement('div')
    mixCarousel.className = 'home-carousel'

    const shuffledAlbums = [...allAlbumKeys].sort(() => Math.random() - 0.5).slice(0, 12)

    for (const aKey of shuffledAlbums) {
      const album = library.albums[aKey]
      if (!album) continue
      const item = createCarouselAlbumItem(aKey, album)
      mixCarousel.appendChild(item)
    }

    mixSection.appendChild(mixCarousel)
    homeContainer.appendChild(mixSection)
  }

  // === 10. Discovery Mix ===
  if (discoveryMixes.length > 0) {
    const discoverySection = document.createElement('section')
    discoverySection.className = 'home-section'
    discoverySection.id = 'home-discovery-mix-section'

    const discoveryHeader = document.createElement('h2')
    discoveryHeader.className = 'home-section-title'
    discoveryHeader.textContent = 'Discovery Mix'
    discoverySection.appendChild(discoveryHeader)

    const discoveryCarousel = document.createElement('div')
    discoveryCarousel.className = 'home-carousel'
    discoveryCarousel.id = 'discovery-mix-carousel'

    for (const mix of discoveryMixes) {
      const item = document.createElement('div')
      item.className = 'carousel-item discovery-mix-item'
      item.dataset.mixId = mix.id
      item.innerHTML = `
        <div class="carousel-cover discovery-mix-cover">
          <img class="carousel-cover-img discovery-mix-bg-img" style="display: none;" alt="">
          <div class="carousel-cover-placeholder">\u266A</div>
          <div class="discovery-mix-overlay">
            <span class="discovery-mix-label">${escapeHtml(mix.title)}</span>
          </div>
        </div>
        <div class="carousel-title">${escapeHtml(mix.title)}</div>
        <div class="carousel-artist">${mix.trackCount} titres</div>
      `

      const img = item.querySelector('.discovery-mix-bg-img')
      const placeholder = item.querySelector('.carousel-cover-placeholder')

      if (mix.coverPath && img && placeholder) {
        const cachedCover = caches.coverCache.get(mix.coverPath) || caches.thumbnailCache.get(mix.coverPath)
        if (!loadCachedImage(img, placeholder, cachedCover)) {
          app.loadThumbnailAsync(mix.coverPath, img, '', '').then(() => {
            if (img.isConnected && img.style.display === 'block') {
              placeholder.style.display = 'none'
            }
          })
        }
      }

      discoveryCarousel.appendChild(item)
    }

    discoverySection.appendChild(discoveryCarousel)
    homeContainer.appendChild(discoverySection)
  }

  // Empty state message
  if (!lastPlayed && recentTracks.length === 0 && unplayedAlbums.length === 0) {
    const emptyMessage = document.createElement('div')
    emptyMessage.className = 'home-empty'
    emptyMessage.innerHTML = `
      <h2>Welcome to Noir</h2>
      <p>Start listening to music to fill this page.</p>
    `
    homeContainer.appendChild(emptyMessage)
  }

  // === EVENT DELEGATION ===
  homeContainer.addEventListener('click', async (e) => {
    const playBtn = e.target.closest('.resume-play-btn')
    if (playBtn) {
      e.stopPropagation()
      if (playback.audioIsPlaying) {
        try {
          await invoke('audio_pause')
        } catch (err) {
          console.error('audio_pause error:', err)
        }
        playback.audioIsPlaying = false
        dom.playPauseBtn.textContent = '\u25B6'
        playBtn.textContent = '\u25B6'
      } else if (playback.currentTrackIndex >= 0) {
        try {
          await invoke('audio_resume')
          playback.audioIsPlaying = true
          dom.playPauseBtn.textContent = '\u23F8'
          playBtn.textContent = '\u23F8'
        } catch (err) {
          app.playTrack(playback.currentTrackIndex)
        }
      }
      return
    }

    const resumeTile = e.target.closest('.home-resume-tile')
    if (resumeTile) {
      const trackPath = resumeTile.dataset.trackPath
      if (trackPath) {
        const trackIndex = library.tracks.findIndex(t => t.path === trackPath)
        if (trackIndex !== -1) app.playTrack(trackIndex)
      }
      return
    }

    const recentItem = e.target.closest('.recent-track-item')
    if (recentItem) {
      const trackPath = recentItem.dataset.trackPath
      if (trackPath) {
        const trackIndex = library.tracks.findIndex(t => t.path === trackPath)
        if (trackIndex !== -1) app.playTrack(trackIndex)
      }
      return
    }

    const mixItem = e.target.closest('.discovery-mix-item')
    if (mixItem) {
      const mixId = mixItem.dataset.mixId
      const mix = discoveryMixes.find(m => m.id === mixId)
      if (mix) navigateToMixPage(mix)
      return
    }

    const carouselItem = e.target.closest('.carousel-item')
    if (carouselItem) {
      const artistName = carouselItem.dataset.artistName
      if (artistName && library.artists[artistName]) {
        openArtistFromHome(artistName)
        return
      }

      const albumKey = carouselItem.dataset.albumKey
      if (albumKey && library.albums[albumKey]) {
        openAlbumFromHome(albumKey, library.albums[albumKey])
      }
      return
    }
  })

  // DRAG & DROP DELEGATION
  homeContainer.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return

    const carouselItem = e.target.closest('.carousel-item')
    if (carouselItem) {
      const albumKey = carouselItem.dataset.albumKey
      if (albumKey && library.albums[albumKey]) {
        app.prepareAlbumDrag(e, albumKey, carouselItem)
      }
      return
    }

    const recentTrackItem = e.target.closest('.recent-track-item')
    if (recentTrackItem) {
      const trackPath = recentTrackItem.dataset.trackPath
      const track = library.tracks.find(t => t.path === trackPath)
      if (track) {
        app.prepareCustomDrag(e, track, recentTrackItem)
      }
      return
    }
  })

  // CONTEXT MENU on recent tracks
  homeContainer.addEventListener('contextmenu', (e) => {
    const recentItem = e.target.closest('.recent-track-item')
    if (recentItem) {
      e.preventDefault()
      e.stopPropagation()
      const trackPath = recentItem.dataset.trackPath
      const trackIndex = library.tracks.findIndex(t => t.path === trackPath)
      if (trackIndex !== -1) {
        app.showContextMenu(e, library.tracks[trackIndex], trackIndex)
      }
    }
  })

  dom.albumsGridDiv.appendChild(homeContainer)
}

// Helper: create a standard carousel album item with cover loading
function createCarouselAlbumItem(albumKey, album) {
  const item = document.createElement('div')
  item.className = 'carousel-item'
  item.dataset.albumKey = albumKey
  item.innerHTML = `
    <div class="carousel-cover">
      <img class="carousel-cover-img" style="display: none;" alt="">
      <div class="carousel-cover-placeholder">\u266A</div>
    </div>
    <div class="carousel-title">${escapeHtml(album.album)}</div>
    <div class="carousel-artist">${escapeHtml(album.artist)}</div>
  `

  const img = item.querySelector('.carousel-cover-img')
  const placeholder = item.querySelector('.carousel-cover-placeholder')

  if (album.coverPath && img && placeholder) {
    const cachedCover = caches.coverCache.get(album.coverPath)
    if (!loadCachedImage(img, placeholder, cachedCover)) {
      app.loadThumbnailAsync(album.coverPath, img, album.artist, album.album).then(() => {
        if (img.isConnected && img.style.display === 'block') {
          placeholder.style.display = 'none'
        }
      })
    }
  }

  return item
}

// ============================================================
// UPDATE HOME NOW PLAYING SECTION
// ============================================================

export function updateHomeNowPlayingSection() {
  if (ui.currentView !== 'home') return

  const section = document.getElementById('home-now-playing-section')
  if (!section) return

  const currentTrack = playback.currentTrackIndex >= 0 ? library.tracks[playback.currentTrackIndex] : null
  if (!currentTrack) return

  let resumeTile = section.querySelector('.home-resume-tile')
  if (!resumeTile) {
    resumeTile = document.createElement('div')
    resumeTile.className = 'home-resume-tile'
    section.appendChild(resumeTile)
  }

  const title = currentTrack.metadata?.title || currentTrack.name || 'Titre inconnu'
  const artist = currentTrack.metadata?.artist || 'Unknown Artist'
  const albumName = currentTrack.metadata?.album || ''

  let specsTagsHtml = ''
  if (currentTrack.metadata) {
    const meta = currentTrack.metadata
    const codec = meta.codec || getCodecFromPath(currentTrack.path)
    const bitDepth = meta.bitDepth ? `${meta.bitDepth}-bit` : ''
    const sampleRate = meta.sampleRate ? `${(meta.sampleRate / 1000).toFixed(1).replace('.0', '')}kHz` : ''
    const duration = meta.duration ? formatTime(meta.duration) : ''

    const tags = []
    if (bitDepth) tags.push(`<span class="resume-spec-tag bitdepth">${bitDepth}</span>`)
    if (sampleRate) tags.push(`<span class="resume-spec-tag samplerate">${sampleRate}</span>`)

    const textParts = []
    if (codec) textParts.push(codec.toUpperCase())
    if (duration) textParts.push(duration)
    const textSpecs = textParts.length > 0 ? `<span class="resume-specs-text">${textParts.join(' \u2022 ')}</span>` : ''

    if (tags.length > 0 || textSpecs) {
      specsTagsHtml = `<div class="resume-specs-container">${tags.join('')}${textSpecs}</div>`
    }
  }

  // Destroy previous particle animation before replacing innerHTML
  destroyParticleCanvas(resumeTile)

  resumeTile.dataset.trackPath = currentTrack.path

  resumeTile.innerHTML = `
    <div class="resume-cover">
      <img class="resume-cover-img" style="display: none;" alt="">
      <div class="resume-cover-placeholder">\u266A</div>
    </div>
    <div class="resume-info">
      <span class="resume-label resume-label-active">Now Playing</span>
      <span class="resume-title">${escapeHtml(title)}</span>
      <span class="resume-artist">${escapeHtml(artist)}</span>
      ${albumName ? `<span class="resume-album">${escapeHtml(albumName)}</span>` : ''}
      ${specsTagsHtml}
    </div>
    <button class="resume-play-btn">${playback.audioIsPlaying ? '\u23F8' : '\u25B6'}</button>
  `

  // Start particle animation
  createParticleCanvas(resumeTile)

  const img = resumeTile.querySelector('.resume-cover-img')
  const placeholder = resumeTile.querySelector('.resume-cover-placeholder')
  if (img && placeholder) {
    app.loadThumbnailAsync(currentTrack.path, img, artist, albumName).then(() => {
      if (img.isConnected && img.style.display === 'block') {
        placeholder.style.display = 'none'
      }
    })
  }
}

// ============================================================
// OPEN FROM HOME HELPERS
// ============================================================

export function openArtistFromHome(artistName) {
  if (!artistName || !library.artists[artistName]) return
  navigateToArtistPage(artistName)
}

export function openAlbumFromHome(albumKey, album) {
  if (!albumKey || !album) return
  navigateToAlbumPage(albumKey)
}

// ============================================================
// ALBUMS GRID
// ============================================================

export function displayAlbumsGrid() {
  dom.albumsGridDiv.textContent = ''
  dom.albumsGridDiv.classList.remove('tracks-mode')

  const existingNav = document.querySelector('.alphabet-nav')
  if (existingNav) existingNav.remove()

  if (ui.filteredArtist) {
    const header = document.createElement('div')
    header.className = 'view-header'
    header.innerHTML = `
      <button class="btn-back-nav" title="Retour">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 12H5"/>
          <path d="M12 19l-7-7 7-7"/>
        </svg>
      </button>
      <h2>${ui.filteredArtist}</h2>
    `
    header.querySelector('.btn-back-nav').addEventListener('click', () => {
      ui.filteredArtist = null
      ui.currentView = 'artists'
      dom.navItems.forEach(i => i.classList.remove('active'))
      document.querySelector('[data-view="artists"]').classList.add('active')
      displayArtistsGrid()
    })
    dom.albumsGridDiv.appendChild(header)
  } else {
    const headerDiv = document.createElement('div')
    headerDiv.className = 'view-header-with-sort'

    headerDiv.innerHTML = `
      <h1 class="view-title">Albums</h1>
      <div class="artist-sort-dropdown">
        <button id="album-sort-btn" class="btn-sort-icon" title="Trier">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18"/>
            <path d="M7 12h10"/>
            <path d="M10 18h4"/>
          </svg>
        </button>
        <div id="album-sort-menu" class="sort-menu hidden">
          <button class="sort-option${sort.albumSortMode === 'artist-asc' ? ' active' : ''}" data-sort="artist-asc">Artiste A \u2192 Z</button>
          <button class="sort-option${sort.albumSortMode === 'artist-desc' ? ' active' : ''}" data-sort="artist-desc">Artiste Z \u2192 A</button>
          <button class="sort-option${sort.albumSortMode === 'album-asc' ? ' active' : ''}" data-sort="album-asc">Album A \u2192 Z</button>
          <button class="sort-option${sort.albumSortMode === 'album-desc' ? ' active' : ''}" data-sort="album-desc">Album Z \u2192 A</button>
          <button class="sort-option${sort.albumSortMode === 'recent' ? ' active' : ''}" data-sort="recent">Derniers Ajouts</button>
        </div>
      </div>
    `

    const sortBtn = headerDiv.querySelector('#album-sort-btn')
    const sortMenu = headerDiv.querySelector('#album-sort-menu')

    sortBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      sortMenu.classList.toggle('hidden')
    })

    sortMenu.querySelectorAll('.sort-option').forEach(option => {
      option.addEventListener('click', (e) => {
        e.stopPropagation()
        sort.albumSortMode = option.dataset.sort
        sortMenu.classList.add('hidden')
        displayAlbumsGrid()
      })
    })

    const closeAlbumSortMenu = (e) => {
      if (!e.target.closest('.artist-sort-dropdown')) {
        sortMenu.classList.add('hidden')
      }
    }
    document.removeEventListener('click', window._albumSortMenuClose)
    window._albumSortMenuClose = closeAlbumSortMenu
    document.addEventListener('click', closeAlbumSortMenu)

    dom.albumsGridDiv.appendChild(headerDiv)
  }

  const gridContainer = document.createElement('div')
  gridContainer.className = 'albums-grid-container'

  let trackIndexMap = null
  if (sort.albumSortMode === 'recent') {
    trackIndexMap = new Map()
    library.tracks.forEach((t, i) => trackIndexMap.set(t.path, i))
  }

  const sortedAlbumKeys = Object.keys(library.albums).sort((a, b) => {
    const albumA = library.albums[a]
    const albumB = library.albums[b]
    switch (sort.albumSortMode) {
      case 'artist-asc': return albumA.artist.localeCompare(albumB.artist)
      case 'artist-desc': return albumB.artist.localeCompare(albumA.artist)
      case 'album-asc': return albumA.album.localeCompare(albumB.album)
      case 'album-desc': return albumB.album.localeCompare(albumA.album)
      case 'recent':
        const lastTrackA = albumA.tracks.length > 0 ? (trackIndexMap.get(albumA.tracks[albumA.tracks.length - 1].path) ?? -1) : -1
        const lastTrackB = albumB.tracks.length > 0 ? (trackIndexMap.get(albumB.tracks[albumB.tracks.length - 1].path) ?? -1) : -1
        return lastTrackB - lastTrackA
      default: return 0
    }
  })

  for (const albumKey of sortedAlbumKeys) {
    const album = library.albums[albumKey]

    if (ui.filteredArtist && album.artist !== ui.filteredArtist) continue

    if (search.query) {
      const matchesAlbum = album.album.toLowerCase().includes(search.query)
      const matchesArtist = album.artist.toLowerCase().includes(search.query)
      if (!matchesAlbum && !matchesArtist) continue
    }

    const card = document.createElement('div')
    card.className = 'album-card'
    card.dataset.albumKey = albumKey

    const cachedCover = caches.coverCache.get(album.coverPath)
    const hasCachedCover = isValidImageSrc(cachedCover)

    card.innerHTML = `
      <div class="album-cover">
        <img class="album-cover-img" ${hasCachedCover ? `src="${cachedCover}"` : 'style="display: none;"'} alt="${album.album}">
        <div class="album-cover-placeholder" ${hasCachedCover ? 'style="display: none;"' : ''}>\u266A</div>
      </div>
      <div class="album-title">${album.album}</div>
      <div class="album-artist">${album.artist}</div>
    `

    if (!hasCachedCover && album.coverPath) {
      app.observeCoverLoading(card, album.coverPath)
    }

    gridContainer.appendChild(card)
  }

  // Event delegation: 3 listeners on the container instead of 3×N on each card
  gridContainer.addEventListener('click', (e) => {
    if (isDragging()) return
    const card = e.target.closest('.album-card')
    if (!card) return
    const key = card.dataset.albumKey
    const album = library.albums[key]
    if (!album) return
    const cover = caches.coverCache.get(album.coverPath) || caches.thumbnailCache.get(album.coverPath)
    showAlbumDetail(key, cover, card)
  })

  gridContainer.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.album-card')
    if (card?.dataset.albumKey) app.showAlbumContextMenu(e, card.dataset.albumKey)
  })

  gridContainer.addEventListener('mousedown', (e) => {
    const card = e.target.closest('.album-card')
    if (card?.dataset.albumKey) app.prepareAlbumDrag(e, card.dataset.albumKey, card)
  })

  dom.albumsGridDiv.appendChild(gridContainer)
}

// ============================================================
// ARTISTS GRID
// ============================================================

export function displayArtistsGrid() {
  dom.albumsGridDiv.textContent = ''
  dom.albumsGridDiv.classList.remove('tracks-mode')

  const headerDiv = document.createElement('div')
  headerDiv.className = 'view-header-with-sort'

  headerDiv.innerHTML = `
    <h1 class="view-title">Artistes</h1>
    <div class="artist-sort-dropdown">
      <button id="artist-sort-btn" class="btn-sort-icon" title="Trier">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18"/>
          <path d="M7 12h10"/>
          <path d="M10 18h4"/>
        </svg>
      </button>
      <div id="artist-sort-menu" class="sort-menu hidden">
        <button class="sort-option${artistSortMode === 'name-asc' ? ' active' : ''}" data-sort="name-asc">Nom A \u2192 Z</button>
        <button class="sort-option${artistSortMode === 'name-desc' ? ' active' : ''}" data-sort="name-desc">Nom Z \u2192 A</button>
        <button class="sort-option${artistSortMode === 'recent' ? ' active' : ''}" data-sort="recent">Derniers Ajouts</button>
      </div>
    </div>
  `

  const sortBtn = headerDiv.querySelector('#artist-sort-btn')
  const sortMenu = headerDiv.querySelector('#artist-sort-menu')

  sortBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    sortMenu.classList.toggle('hidden')
  })

  sortMenu.querySelectorAll('.sort-option').forEach(option => {
    option.addEventListener('click', (e) => {
      e.stopPropagation()
      artistSortMode = option.dataset.sort
      sortMenu.classList.add('hidden')
      displayArtistsGrid()
    })
  })

  const closeArtistSortMenu = (e) => {
    if (!e.target.closest('.artist-sort-dropdown')) {
      sortMenu.classList.add('hidden')
    }
  }
  document.removeEventListener('click', window._artistSortMenuClose)
  window._artistSortMenuClose = closeArtistSortMenu
  document.addEventListener('click', closeArtistSortMenu)

  dom.albumsGridDiv.appendChild(headerDiv)

  const gridContainer = document.createElement('div')
  gridContainer.className = 'albums-grid-container'

  const sortedArtists = Object.keys(library.artists).sort((a, b) => {
    const artistA = library.artists[a]
    const artistB = library.artists[b]
    switch (artistSortMode) {
      case 'name-asc': return artistA.name.localeCompare(artistB.name)
      case 'name-desc': return artistB.name.localeCompare(artistA.name)
      case 'recent':
        const lastTrackA = artistA.tracks.length > 0 ? library.tracks.findIndex(t => t.path === artistA.tracks[artistA.tracks.length - 1].path) : -1
        const lastTrackB = artistB.tracks.length > 0 ? library.tracks.findIndex(t => t.path === artistB.tracks[artistB.tracks.length - 1].path) : -1
        return lastTrackB - lastTrackA
      default: return 0
    }
  })

  const alphabetItems = []

  for (const artistKey of sortedArtists) {
    const artist = library.artists[artistKey]

    if (search.query) {
      if (!artist.name.toLowerCase().includes(search.query)) continue
    }

    const card = document.createElement('div')
    card.className = 'album-card artist-card'

    const albumCount = artist.albums.length
    const trackCount = artist.tracks.length

    card.innerHTML = `
      <div class="album-cover artist-cover">
        <img class="album-cover-img" style="display: none;" alt="${artist.name}">
        <div class="album-cover-placeholder">\u266A</div>
      </div>
      <div class="album-title">${artist.name}</div>
      <div class="album-artist">${albumCount} album${albumCount > 1 ? 's' : ''} \u2022 ${trackCount} titre${trackCount > 1 ? 's' : ''}</div>
    `

    const img = card.querySelector('.album-cover-img')
    const placeholder = card.querySelector('.album-cover-placeholder')

    const firstAlbum = artist.albums.length > 0 ? artist.albums[0] : null
    const fallbackCoverPath = artist.coverPath || null

    app.loadArtistImageAsync(artist.name, img, firstAlbum, fallbackCoverPath).then(() => {
      if (img.style.display === 'block') {
        placeholder.style.display = 'none'
      }
    })

    card.dataset.artistKey = artistKey

    gridContainer.appendChild(card)

    alphabetItems.push({ name: artist.name, element: card })
  }

  // Event delegation: 1 listener on the container instead of 1×N on each card
  gridContainer.addEventListener('click', (e) => {
    const card = e.target.closest('.artist-card')
    if (card?.dataset.artistKey) showArtistAlbums(card.dataset.artistKey)
  })

  dom.albumsGridDiv.appendChild(gridContainer)

  if (artistSortMode === 'name-asc' || artistSortMode === 'name-desc') {
    createAlphabetScrollbar(
      document.body,
      alphabetItems,
      item => item.name.charAt(0),
      dom.albumsViewDiv
    )
  } else {
    const existingNav = document.querySelector('.alphabet-nav')
    if (existingNav) existingNav.remove()
  }
}

export function showArtistAlbums(artistKey) {
  navigateToArtistPage(artistKey)
}

// ============================================================
// ARTIST PAGE
// ============================================================

export function displayArtistPage(artistKey) {
  const artist = library.artists[artistKey]
  if (!artist) return

  const existingNav = document.querySelector('.alphabet-nav')
  if (existingNav) existingNav.remove()

  const artistAlbums = Object.keys(library.albums)
    .filter(key => library.albums[key].artist === artistKey)
    .map(key => ({ key, ...library.albums[key] }))
    .sort((a, b) => {
      const yearA = a.tracks[0]?.metadata?.year || 9999
      const yearB = b.tracks[0]?.metadata?.year || 9999
      return yearA - yearB
    })

  const totalTracks = artist.tracks.length
  const totalDuration = artist.tracks.reduce((acc, t) => acc + (t.metadata?.duration || 0), 0)

  const pageContainer = document.createElement('div')
  pageContainer.className = 'artist-page-container'

  pageContainer.innerHTML = `
    <div class="album-page-header">
      <button class="btn-back-nav" title="Retour">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 12H5"/>
          <path d="M12 19l-7-7 7-7"/>
        </svg>
      </button>
      <h1 class="album-page-title">${artist.name}</h1>
    </div>
    <div class="artist-page-content">
      <div class="artist-page-photo">
        <img class="artist-page-photo-img" style="display: none;" alt="${artist.name}">
        <div class="artist-photo-placeholder">\u266A</div>
      </div>
      <div class="artist-page-info">
        <p class="artist-page-meta">
          ${artistAlbums.length} album${artistAlbums.length > 1 ? 's' : ''} \u2022 ${totalTracks} titre${totalTracks > 1 ? 's' : ''} \u2022 ${formatTime(totalDuration)}
        </p>
        <div class="artist-page-buttons">
          <button class="btn-primary-small play-artist-btn">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
            Tout lire
          </button>
          <button class="btn-add-queue-album add-artist-queue-btn" title="Add to queue">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M16 5H3"/><path d="M16 12H3"/><path d="M9 19H3"/><path d="m16 16-3 3 3 3"/><path d="M21 5v12a2 2 0 0 1-2 2h-6"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
    <div class="artist-albums-grid"></div>
  `

  pageContainer.querySelector('.btn-back-nav').addEventListener('click', navigateBack)

  pageContainer.querySelector('.play-artist-btn').addEventListener('click', () => {
    if (artist.tracks.length > 0) {
      const firstTrack = artist.tracks[0]
      const globalIndex = library.tracks.findIndex(t => t.path === firstTrack.path)
      if (globalIndex !== -1) {
        app.playTrack(globalIndex)
      }
    }
  })

  pageContainer.querySelector('.add-artist-queue-btn').addEventListener('click', () => {
    artist.tracks.forEach(track => {
      if (!queue.items.find(q => q.path === track.path)) {
        queue.items.push(track)
      }
    })
    app.showQueueNotification(`${artist.tracks.length} tracks added to queue`)
  })

  // Load artist photo
  const img = pageContainer.querySelector('.artist-page-photo-img')
  const placeholder = pageContainer.querySelector('.artist-photo-placeholder')
  const firstAlbum = artist.albums.length > 0 ? artist.albums[0] : null
  const fallbackCoverPath = artist.coverPath || null

  app.loadArtistImageAsync(artist.name, img, firstAlbum, fallbackCoverPath).then(() => {
    if (img.style.display === 'block') {
      placeholder.style.display = 'none'
    }
  })

  // Separate full albums from loose tracks
  const fullAlbums = artistAlbums.filter(a => a.tracks.length > 1)
  let looseTracks = artistAlbums.filter(a => a.tracks.length === 1).flatMap(a => a.tracks)

  if (artistAlbums.length === 0 && artist.tracks.length > 0) {
    looseTracks = [...artist.tracks]
  }

  const albumsGrid = pageContainer.querySelector('.artist-albums-grid')

  // Full albums
  for (const albumData of fullAlbums) {
    const card = document.createElement('div')
    card.className = 'album-card'
    card.dataset.albumKey = albumData.key

    const cachedCover = caches.coverCache.get(albumData.coverPath)
    const hasCachedCover = isValidImageSrc(cachedCover)

    const year = albumData.tracks[0]?.metadata?.year
    const yearText = year ? ` \u2022 ${year}` : ''

    card.innerHTML = `
      <div class="album-cover">
        <img class="album-cover-img" ${hasCachedCover ? `src="${cachedCover}"` : 'style="display: none;"'} alt="${albumData.album}">
        <div class="album-cover-placeholder" ${hasCachedCover ? 'style="display: none;"' : ''}>\u266A</div>
      </div>
      <div class="album-title">${albumData.album}</div>
      <div class="album-artist">${albumData.tracks.length} titre${albumData.tracks.length > 1 ? 's' : ''}${yearText}</div>
    `

    if (!hasCachedCover && albumData.coverPath) {
      const cardImg = card.querySelector('.album-cover-img')
      const cardPlaceholder = card.querySelector('.album-cover-placeholder')
      app.loadThumbnailAsync(albumData.coverPath, cardImg, artist.name, albumData.album).then(() => {
        if (cardImg.isConnected && cardImg.style.display === 'block') {
          cardPlaceholder.style.display = 'none'
        }
      })
    }

    card.addEventListener('click', () => {
      navigateToAlbumPage(albumData.key)
    })

    albumsGrid.appendChild(card)
  }

  // Loose tracks
  if (looseTracks.length > 0) {
    const looseSection = document.createElement('div')
    looseSection.className = 'artist-loose-tracks-section'

    const sectionTitle = fullAlbums.length === 0 ? 'Tracks' : 'Singles & Loose Tracks'

    looseSection.innerHTML = `
      <h3 class="artist-loose-tracks-title">${sectionTitle}</h3>
      <div class="artist-loose-tracks-list"></div>
    `

    const trackList = looseSection.querySelector('.artist-loose-tracks-list')

    for (const [idx, track] of looseTracks.entries()) {
      const trackItem = document.createElement('div')
      trackItem.className = 'album-track-item'
      trackItem.dataset.trackPath = track.path

      const title = track.metadata?.title || track.name
      const albumName = track.metadata?.album || ''
      const duration = track.metadata?.duration ? formatTime(track.metadata.duration) : '-'
      const trackNum = track.metadata?.track || (idx + 1)

      trackItem.innerHTML = `
        ${app.getFavoriteButtonHtml(track.path)}
        <span class="track-number">${trackNum}</span>
        <div class="track-info">
          <span class="track-title">${escapeHtml(title)}</span>
          <span class="track-artist">${escapeHtml(albumName)}</span>
        </div>
        <button class="track-add-queue${queue.items.some(q => q.path === track.path) ? ' in-queue' : ''}" title="Add to queue">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 5H3"/><path d="M16 12H3"/><path d="M9 19H3"/><path d="m16 16-3 3 3 3"/><path d="M21 5v12a2 2 0 0 1-2 2h-6"/>
          </svg>
        </button>
        <button class="track-add-playlist" title="Add to playlist">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 5v14"/><path d="M5 12h14"/>
          </svg>
        </button>
        <span class="track-duration">${duration}</span>
      `

      trackItem.addEventListener('dblclick', () => {
        const globalIndex = library.tracks.findIndex(t => t.path === track.path)
        if (globalIndex !== -1) {
          app.playTrack(globalIndex)
        }
      })

      trackItem.querySelector('.track-add-queue').addEventListener('click', (e) => {
        e.stopPropagation()
        app.addToQueue(track)
        app.showQueueNotification(`"${track.metadata?.title || track.name}" added to queue`)
        trackItem.querySelector('.track-add-queue').classList.add('in-queue')
      })

      trackItem.querySelector('.track-add-playlist').addEventListener('click', (e) => {
        e.stopPropagation()
        app.showAddToPlaylistMenu(e, track)
      })

      const favBtn = trackItem.querySelector('.track-favorite-btn')
      if (favBtn) {
        favBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          app.toggleFavorite(track.path, favBtn)
        })
      }

      trackItem.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        const globalIndex = library.tracks.findIndex(t => t.path === track.path)
        if (globalIndex !== -1) {
          app.showContextMenu(e, track, globalIndex)
        }
      })

      trackList.appendChild(trackItem)
    }

    albumsGrid.appendChild(looseSection)
  }

  dom.albumsGridDiv.appendChild(pageContainer)

  const albumsView = document.querySelector('.albums-view')
  if (albumsView) albumsView.scrollTop = 0
}

// ============================================================
// VIRTUAL SCROLLING — TRACKS GRID
// ============================================================

export function getSortIndicator(column) {
  if (sort.column !== column) return ''
  return sort.direction === 'asc' ? '\u25B2' : '\u25BC'
}

export function getSortedAndFilteredTracks() {
  let sortedTracks = [...library.tracks].sort((a, b) => {
    let valueA, valueB

    switch (sort.column) {
      case 'title':
        valueA = a.metadata?.title || a.name
        valueB = b.metadata?.title || b.name
        break
      case 'artist':
        valueA = a.metadata?.artist || 'Unknown Artist'
        valueB = b.metadata?.artist || 'Unknown Artist'
        break
      case 'album':
        valueA = a.metadata?.album || ''
        valueB = b.metadata?.album || ''
        break
      case 'duration':
        valueA = a.metadata?.duration || 0
        valueB = b.metadata?.duration || 0
        const result = valueA - valueB
        return sort.direction === 'asc' ? result : -result
      default:
        valueA = a.metadata?.title || a.name
        valueB = b.metadata?.title || b.name
    }

    const comparison = valueA.localeCompare(valueB)
    return sort.direction === 'asc' ? comparison : -comparison
  })

  if (search.query) {
    const indexedResults = app.searchTracksWithIndex(search.query)

    if (indexedResults && indexedResults.size > 0) {
      sortedTracks = sortedTracks.filter(track => {
        const trackIndex = library.tracks.indexOf(track)
        return indexedResults.has(trackIndex)
      })
    } else {
      sortedTracks = sortedTracks.filter(track => {
        const title = (track.metadata?.title || track.name).toLowerCase()
        const artist = (track.metadata?.artist || '').toLowerCase()
        const album = (track.metadata?.album || '').toLowerCase()
        return title.includes(search.query) || artist.includes(search.query) || album.includes(search.query)
      })
    }
  }

  return sortedTracks
}

export function createPoolNode() {
  const el = document.createElement('div')
  el.className = 'tracks-list-item'
  el.style.cssText = 'position: absolute; left: 0; right: 0; height: ' + TRACK_ITEM_HEIGHT + 'px;'
  el.innerHTML = `
    <button class="track-favorite-btn" title="Favoris">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
      </svg>
    </button>
    <span class="tracks-list-title"></span>
    <span class="tracks-list-artist"></span>
    <span class="tracks-list-album"></span>
    <span class="tracks-list-quality"><span class="quality-tag"></span></span>
    <span class="tracks-list-duration"></span>
    <button class="tracks-list-add-playlist" title="Add to playlist">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>
      </svg>
    </button>
    <button class="tracks-list-add-queue" title="Add to queue">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M16 5H3"/><path d="M16 12H3"/><path d="M9 19H3"/><path d="m16 16-3 3 3 3"/><path d="M21 5v12a2 2 0 0 1-2 2h-6"/>
      </svg>
    </button>
  `
  el._favBtn = el.querySelector('.track-favorite-btn')
  el._favSvg = el._favBtn.querySelector('svg')
  el._title = el.querySelector('.tracks-list-title')
  el._artist = el.querySelector('.tracks-list-artist')
  el._album = el.querySelector('.tracks-list-album')
  el._quality = el.querySelector('.quality-tag')
  el._duration = el.querySelector('.tracks-list-duration')
  el._queueBtn = el.querySelector('.tracks-list-add-queue')
  return el
}

export function updateVirtualScrollItems() {
  const { filteredTracks, contentContainer, scrollContainer, pool } = virtualScrollState

  if (!contentContainer || !scrollContainer || !scrollContainer.isConnected) return
  if (!filteredTracks || filteredTracks.length === 0) return
  if (!pool || pool.length === 0) return

  const scrollTop = scrollContainer.scrollTop
  const viewportHeight = scrollContainer.clientHeight

  if (viewportHeight === 0) return

  const startIndex = Math.max(0, Math.floor(scrollTop / TRACK_ITEM_HEIGHT) - VIRTUAL_BUFFER)
  const endIndex = Math.min(
    filteredTracks.length - 1,
    Math.ceil((scrollTop + viewportHeight) / TRACK_ITEM_HEIGHT) + VIRTUAL_BUFFER
  )

  if (startIndex === virtualScrollState.visibleStartIndex && endIndex === virtualScrollState.visibleEndIndex) {
    return
  }

  virtualScrollState.visibleStartIndex = startIndex
  virtualScrollState.visibleEndIndex = endIndex

  const visibleCount = endIndex - startIndex + 1

  for (let p = 0; p < pool.length; p++) {
    const el = pool[p]
    if (p < visibleCount) {
      const trackIndex = startIndex + p
      const track = filteredTracks[trackIndex]
      const isFav = favorites.tracks.has(track.path)
      const isInQueue = queue.items.some(q => q.path === track.path)
      const quality = formatQuality(track.metadata, track.path)

      el.style.top = (trackIndex * TRACK_ITEM_HEIGHT) + 'px'
      el.style.display = ''
      el.dataset.trackPath = track.path
      el.dataset.virtualIndex = trackIndex

      el._title.textContent = track.metadata?.title || track.name
      el._artist.textContent = track.metadata?.artist || 'Unknown Artist'
      el._album.textContent = track.metadata?.album || ''
      el._duration.textContent = track.metadata?.duration ? formatTime(track.metadata.duration) : '-:--'
      el._quality.textContent = quality.label
      el._quality.className = 'quality-tag ' + quality.class

      el._favBtn.classList.toggle('active', isFav)
      el._favBtn.title = isFav ? 'Retirer des favoris' : 'Ajouter aux favoris'
      el._favSvg.setAttribute('fill', isFav ? 'currentColor' : 'none')
      el._queueBtn.classList.toggle('in-queue', isInQueue)
      el._queueBtn.title = isInQueue ? 'Remove from queue' : 'Add to queue'
      el.classList.toggle('selected', virtualScrollState.selectedTrackPaths.has(track.path))
    } else {
      el.style.display = 'none'
    }
  }
}

export function updateTrackSelectionDisplay() {
  const { selectedTrackPaths, contentContainer } = virtualScrollState
  if (!contentContainer) return

  contentContainer.querySelectorAll('.tracks-list-item').forEach(item => {
    const isSelected = selectedTrackPaths.has(item.dataset.trackPath)
    item.classList.toggle('selected', isSelected)
  })
}

export function displayTracksGrid() {
  closeAlbumDetail()

  dom.albumsGridDiv.textContent = ''
  dom.albumsGridDiv.classList.add('tracks-mode')

  const existingNav = document.querySelector('.alphabet-nav')
  if (existingNav) existingNav.remove()

  const headerDiv = document.createElement('div')
  headerDiv.className = 'view-header-simple'
  headerDiv.innerHTML = `<h1 class="view-title">Tracks</h1>`
  dom.albumsGridDiv.appendChild(headerDiv)

  virtualScrollState.filteredTracks = getSortedAndFilteredTracks()
  const totalTracks = virtualScrollState.filteredTracks.length

  const tracksContainer = document.createElement('div')
  tracksContainer.className = 'tracks-list-view'

  const header = document.createElement('div')
  header.className = 'tracks-list-header'
  header.innerHTML = `
    <span class="sortable" data-sort="title">Titre ${getSortIndicator('title')}</span>
    <span class="sortable" data-sort="artist">Artiste ${getSortIndicator('artist')}</span>
    <span class="sortable" data-sort="album">Album ${getSortIndicator('album')}</span>
    <span>Qualit\u00E9</span>
    <span class="sortable" data-sort="duration">Duration ${getSortIndicator('duration')}</span>
  `

  header.querySelectorAll('.sortable').forEach(span => {
    span.addEventListener('click', () => {
      const column = span.dataset.sort
      if (sort.column === column) {
        sort.direction = sort.direction === 'asc' ? 'desc' : 'asc'
      } else {
        sort.column = column
        sort.direction = 'asc'
      }
      displayTracksGrid()
    })
  })

  tracksContainer.appendChild(header)

  const scrollContainer = document.createElement('div')
  scrollContainer.className = 'virtual-scroll-container'
  scrollContainer.style.cssText = `
    flex: 1;
    overflow-y: auto;
    position: relative;
    contain: strict;
  `

  const totalHeight = totalTracks * TRACK_ITEM_HEIGHT
  const contentContainer = document.createElement('div')
  contentContainer.className = 'virtual-scroll-content'
  contentContainer.style.cssText = `
    position: relative;
    height: ${totalHeight}px;
    width: 100%;
  `

  scrollContainer.appendChild(contentContainer)
  tracksContainer.appendChild(scrollContainer)

  virtualScrollState.scrollContainer = scrollContainer
  virtualScrollState.contentContainer = contentContainer
  virtualScrollState.visibleStartIndex = -1
  virtualScrollState.visibleEndIndex = -1

  virtualScrollState.pool = []
  for (let i = 0; i < POOL_SIZE; i++) {
    const node = createPoolNode()
    node.style.display = 'none'
    contentContainer.appendChild(node)
    virtualScrollState.pool.push(node)
  }

  if (search.query && totalTracks < library.tracks.length) {
    const countDiv = document.createElement('div')
    countDiv.className = 'search-results-count'
    countDiv.style.cssText = 'padding: 8px 16px; color: #666; font-size: 13px;'
    countDiv.textContent = `${totalTracks} result${totalTracks > 1 ? 's' : ''}`
    tracksContainer.insertBefore(countDiv, scrollContainer)
  }

  let scrollTicking = false
  scrollContainer.addEventListener('scroll', () => {
    if (!scrollTicking) {
      requestAnimationFrame(() => {
        updateVirtualScrollItems()
        scrollTicking = false
      })
      scrollTicking = true
    }
  })

  // === EVENT DELEGATION ===

  // Drag
  contentContainer.addEventListener('mousedown', (e) => {
    const trackItem = e.target.closest('.tracks-list-item')
    if (!trackItem || e.target.closest('button')) return

    const trackPath = trackItem.dataset.trackPath
    const entry = library.tracksByPath.get(trackPath)
    if (entry) {
      app.prepareCustomDrag(e, entry.track, trackItem)
    }
  })

  // Click (with multi-selection support)
  contentContainer.addEventListener('click', (e) => {
    const trackItem = e.target.closest('.tracks-list-item')
    if (!trackItem) return

    const trackPath = trackItem.dataset.trackPath
    const entry = library.tracksByPath.get(trackPath)
    if (!entry) return
    const track = entry.track

    const favBtn = e.target.closest('.track-favorite-btn')
    if (favBtn) {
      e.stopPropagation()
      app.toggleFavorite(track.path, favBtn)
      return
    }

    const addQueueBtn = e.target.closest('.tracks-list-add-queue')
    if (addQueueBtn) {
      e.stopPropagation()
      const isInQueue = queue.items.some(q => q.path === track.path)
      if (isInQueue) {
        const queueIndex = queue.items.findIndex(q => q.path === track.path)
        if (queueIndex !== -1) {
          app.removeFromQueue(queueIndex)
        }
        addQueueBtn.classList.remove('in-queue')
        addQueueBtn.title = 'Add to queue'
      } else {
        app.addToQueue(track)
        addQueueBtn.classList.add('in-queue')
        addQueueBtn.title = 'Remove from queue'
      }
      return
    }

    if (e.target.closest('.tracks-list-add-playlist')) {
      e.stopPropagation()
      app.showAddToPlaylistMenu(e, track)
      return
    }

    // Multi-selection with Cmd/Shift
    const { selectedTrackPaths, lastSelectedPath, filteredTracks } = virtualScrollState

    if (e.metaKey || e.ctrlKey) {
      if (selectedTrackPaths.has(trackPath)) {
        selectedTrackPaths.delete(trackPath)
      } else {
        selectedTrackPaths.add(trackPath)
      }
      virtualScrollState.lastSelectedPath = trackPath
    } else if (e.shiftKey && lastSelectedPath) {
      const currentIndex = filteredTracks.findIndex(t => t.path === trackPath)
      const lastIndex = filteredTracks.findIndex(t => t.path === lastSelectedPath)

      if (currentIndex !== -1 && lastIndex !== -1) {
        const start = Math.min(currentIndex, lastIndex)
        const end = Math.max(currentIndex, lastIndex)

        for (let i = start; i <= end; i++) {
          selectedTrackPaths.add(filteredTracks[i].path)
        }
      }
    } else {
      selectedTrackPaths.clear()
      selectedTrackPaths.add(trackPath)
      virtualScrollState.lastSelectedPath = trackPath
    }

    updateTrackSelectionDisplay()
  })

  // Double-click = play
  contentContainer.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return

    const trackItem = e.target.closest('.tracks-list-item')
    if (!trackItem) return

    const trackPath = trackItem.dataset.trackPath
    const entry = library.tracksByPath.get(trackPath)
    if (entry) {
      app.playTrack(entry.index)
    }
  })

  // Right-click
  contentContainer.addEventListener('contextmenu', (e) => {
    const trackItem = e.target.closest('.tracks-list-item')
    if (!trackItem) return

    const trackPath = trackItem.dataset.trackPath
    const entry = library.tracksByPath.get(trackPath)
    if (!entry) return

    app.showContextMenu(e, entry.track, entry.index, virtualScrollState.selectedTrackPaths)
  })

  dom.albumsGridDiv.appendChild(tracksContainer)

  requestAnimationFrame(() => {
    updateVirtualScrollItems()
  })
}

// Lightweight filter update (search) without rebuilding DOM
export function updateTracksFilter() {
  if (!virtualScrollState.scrollContainer || !virtualScrollState.scrollContainer.isConnected) {
    displayTracksGrid()
    return
  }

  virtualScrollState.filteredTracks = getSortedAndFilteredTracks()
  const totalTracks = virtualScrollState.filteredTracks.length

  if (virtualScrollState.contentContainer) {
    virtualScrollState.contentContainer.style.height = (totalTracks * TRACK_ITEM_HEIGHT) + 'px'
  }

  const existingCount = document.querySelector('.search-results-count')
  if (search.query && totalTracks < library.tracks.length) {
    if (existingCount) {
      existingCount.textContent = `${totalTracks} result${totalTracks > 1 ? 's' : ''}`
    }
  } else if (existingCount) {
    existingCount.remove()
  }

  virtualScrollState.scrollContainer.scrollTop = 0
  virtualScrollState.visibleStartIndex = -1
  virtualScrollState.visibleEndIndex = -1
  updateVirtualScrollItems()
}

// Expose virtualScrollState for keyboard shortcuts
export function getVirtualScrollState() {
  return virtualScrollState
}
