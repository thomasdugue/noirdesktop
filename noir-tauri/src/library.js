// library.js — Gestion de la bibliothèque musicale (covers, métadonnées, indexation, scan)
// Regroupe : lazy loading, cover system, folder selection, groupement albums/artistes,
// indexation UI, scan listeners, thumbnail generation

import { library, caches, ui, dom, PERF, clearObject } from './state.js'
import { invoke, listen } from './state.js'
import { app } from './app.js'
import {
  isValidImageSrc, showToast, escapeHtml,
  showLoading, updateLoading, hideLoading
} from './utils.js'

// === LAZY LOADING DES POCHETTES (Intersection Observer) ===
let coverObserver = null

export function initCoverObserver() {
  if (coverObserver) return

  coverObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const card = entry.target
        const img = card.querySelector('.album-cover-img, .carousel-cover-img')
        const placeholder = card.querySelector('.album-cover-placeholder, .carousel-cover-placeholder')
        const coverPath = card.dataset.coverPath

        if (coverPath && img && !img.src) {
          const cached = caches.coverCache.get(coverPath)
          if (isValidImageSrc(cached)) {
            img.src = cached
            img.style.display = 'block'
            if (placeholder) placeholder.style.display = 'none'
          } else {
            loadThumbnailAsync(coverPath, img).then(() => {
              if (img.style.display === 'block' && placeholder) {
                placeholder.style.display = 'none'
              }
            })
          }
        }

        coverObserver.unobserve(card)
      }
    })
  }, {
    root: document.querySelector('.albums-view'),
    rootMargin: '100px',
    threshold: 0.1
  })
}

export function observeCoverLoading(card, coverPath) {
  if (!coverObserver) initCoverObserver()
  card.dataset.coverPath = coverPath
  coverObserver.observe(card)
}

// === SÉLECTION DE DOSSIER ===
export async function selectFolder() {
  try {
    const folderPath = await invoke('select_folder')
    if (!folderPath) return

    await addFolder(folderPath)
  } catch (e) {
    console.error('[LIBRARY] Error selecting folder:', e)
    showToast('Error selecting folder')
  }
}

async function addFolder(folderPath) {
  showLoading('Scan du dossier...')

  try {
    const tracksWithMetadata = await invoke('scan_folder_with_metadata', { path: folderPath })

    if (tracksWithMetadata.length === 0) {
      hideLoading()
      alert('No audio files found in this folder.')
      return
    }

    updateLoading(`${tracksWithMetadata.length} files loaded`)

    await invoke('add_library_path', { path: folderPath })

    const existingPaths = new Set(library.tracks.map(t => t.path))
    let newCount = 0
    for (const track of tracksWithMetadata) {
      if (!existingPaths.has(track.path)) {
        library.tracks.push(track)
        newCount++
      }
    }

    invoke('save_all_caches').catch(console.error)

    groupTracksIntoAlbumsAndArtists()
    buildTrackLookup()

    dom.welcomeDiv.classList.add('hidden')
    app.displayCurrentView()
  } catch (e) {
    console.error('[LIBRARY] Error adding folder:', e)
    showToast('Error scanning folder')
  } finally {
    hideLoading()
  }
}

// === CHARGEMENT DES MÉTADONNÉES ===
export async function loadMetadataForTracks(trackList) {
  const total = trackList.length
  let loaded = 0

  const batchSize = 20
  for (let i = 0; i < trackList.length; i += batchSize) {
    const batch = trackList.slice(i, i + batchSize)

    await Promise.all(batch.map(async (track) => {
      if (!track.metadata) {
        try {
          track.metadata = await invoke('get_metadata', { path: track.path })
        } catch (e) {
          console.error('Erreur metadata:', track.path, e)
          track.metadata = {
            title: track.name,
            artist: 'Unknown Artist',
            album: 'Unknown Album',
            track: 0,
            duration: 0
          }
        }
      }
      loaded++
    }))

    updateLoading(`Metadata: ${loaded}/${total}`, `${Math.round(loaded/total*100)}%`)
  }
}

// === GROUPEMENT ALBUMS / ARTISTES ===
export function groupTracksIntoAlbumsAndArtists() {
  clearObject(library.albums)
  clearObject(library.artists)

  for (const track of library.tracks) {
    if (!track.metadata) continue

    const albumKey = track.metadata.album || 'Unknown Album'
    const artistKey = track.metadata.artist

    // Groupe par album
    if (!library.albums[albumKey]) {
      library.albums[albumKey] = {
        artist: track.metadata.artist,
        album: track.metadata.album,
        tracks: [],
        coverPath: track.path,
        cover: null,
        artistsSet: new Set()
      }
    }
    library.albums[albumKey].tracks.push(track)
    library.albums[albumKey].artistsSet.add(track.metadata.artist)

    // Groupe par artiste
    if (!library.artists[artistKey]) {
      library.artists[artistKey] = {
        name: artistKey,
        albums: new Set(),
        tracks: [],
        coverPath: track.path
      }
    }
    library.artists[artistKey].albums.add(albumKey)
    library.artists[artistKey].tracks.push(track)
  }

  // Trie les morceaux de chaque album et détermine l'artiste affiché
  for (const albumKey in library.albums) {
    library.albums[albumKey].tracks.sort((a, b) => {
      const discA = a.metadata?.disc || 1
      const discB = b.metadata?.disc || 1
      if (discA !== discB) return discA - discB
      const trackA = a.metadata?.track || 0
      const trackB = b.metadata?.track || 0
      if (trackA !== trackB) return trackA - trackB
      return (a.name || '').localeCompare(b.name || '')
    })

    const artistsArray = Array.from(library.albums[albumKey].artistsSet)
    const totalTracks = library.albums[albumKey].tracks.length

    if (artistsArray.length > 1) {
      const artistCounts = {}
      for (const track of library.albums[albumKey].tracks) {
        const artist = track.metadata?.artist || 'Unknown Artist'
        artistCounts[artist] = (artistCounts[artist] || 0) + 1
      }

      let mainArtist = null
      for (const [artist, count] of Object.entries(artistCounts)) {
        if (count > totalTracks / 2) {
          mainArtist = artist
          break
        }
      }

      if (mainArtist) {
        library.albums[albumKey].artist = mainArtist
        library.albums[albumKey].isVariousArtists = true
      } else {
        library.albums[albumKey].artist = 'Various Artists'
        library.albums[albumKey].isVariousArtists = true
      }
    } else {
      library.albums[albumKey].artist = artistsArray[0] || 'Unknown Artist'
      library.albums[albumKey].isVariousArtists = false
    }

    delete library.albums[albumKey].artistsSet
  }

  // Convertit les Sets en Arrays pour les artistes
  for (const artistKey in library.artists) {
    library.artists[artistKey].albums = Array.from(library.artists[artistKey].albums)
  }

  library.metadataLoaded = true

  // Reconstruit l'index de recherche
  app.buildSearchIndex()
}

// === LOOKUP MAP O(1) ===
export function buildTrackLookup() {
  library.tracksByPath.clear()
  library.tracks.forEach((track, i) => library.tracksByPath.set(track.path, { track, index: i }))
}

// === CHARGEMENT ASYNCHRONE DES POCHETTES ===
export async function loadCoverAsync(path, imgElement, artist = null, album = null) {
  if (!path || !imgElement) return

  if (caches.coverCache.has(path)) {
    const cover = caches.coverCache.get(path)
    if (isValidImageSrc(cover) && imgElement.isConnected) {
      imgElement.src = cover
      imgElement.style.display = 'block'
    }
    return
  }

  try {
    let cover = await invoke('get_cover', { path })

    if (!cover && artist && album) {
      cover = await invoke('fetch_internet_cover', { artist, album })
    }

    caches.coverCache.set(path, cover)

    if (isValidImageSrc(cover) && imgElement.isConnected) {
      imgElement.src = cover
      imgElement.style.display = 'block'
    }
  } catch (e) {
    console.error('Erreur cover:', path, e)
    caches.coverCache.set(path, null)
  }
}

// === THUMBNAILS (VERSION OPTIMISÉE NON-BLOQUANTE) ===
const MAX_CONCURRENT_LOADS = 5
let activeLoads = 0
const loadQueue = []

let thumbnailGenerationQueue = []
let thumbnailGenerationRunning = false

export function loadThumbnailAsync(path, imgElement, artist = null, album = null) {
  return new Promise((resolve) => {
    if (!path || !imgElement) {
      resolve()
      return
    }

    PERF.thumbnailCalls++

    if (caches.thumbnailCache.has(path)) {
      PERF.thumbnailCacheHits++
      const thumb = caches.thumbnailCache.get(path)
      if (isValidImageSrc(thumb)) {
        imgElement.src = thumb
        imgElement.style.display = 'block'
      }
      resolve()
      return
    }

    PERF.thumbnailCacheMisses++

    loadQueue.push({ path, imgElement, artist, album, startTime: performance.now(), resolve })
    processLoadQueue()
  })
}

async function processLoadQueue() {
  while (loadQueue.length > 0 && activeLoads < MAX_CONCURRENT_LOADS) {
    const item = loadQueue.shift()
    if (!item) continue

    activeLoads++

    const handler = item.type === 'artist'
      ? loadArtistImageFromQueue(item)
      : loadThumbnailFromQueue(item)

    handler.finally(() => {
      activeLoads--
      processLoadQueue()
    })
  }
}

async function loadThumbnailFromQueue(item) {
  const { path, imgElement, artist, album, startTime, resolve } = item

  if (!imgElement.isConnected) {
    if (resolve) resolve()
    return
  }

  try {
    const thumbStart = performance.now()
    let thumb = await invoke('get_cover_thumbnail', { path })
    const thumbTime = performance.now() - thumbStart

    if (isValidImageSrc(thumb)) {
      caches.thumbnailCache.set(path, thumb)
      caches.coverCache.set(path, thumb)
      if (imgElement.isConnected) {
        imgElement.src = thumb
        imgElement.style.display = 'block'
      }
      const totalTime = performance.now() - startTime
      PERF.totalLoadTime += totalTime
      if (totalTime > 500) {
        PERF.slowLoads.push({
          path: path.split('/').pop(),
          time: totalTime.toFixed(0),
          type: 'thumb-disk',
          thumbTime: thumbTime.toFixed(0)
        })
      }
      if (resolve) resolve()
      return
    }

    PERF.coverFallbacks++

    if (!thumbnailGenerationQueue.includes(path)) {
      thumbnailGenerationQueue.push(path)
      if (!thumbnailGenerationRunning) {
        setTimeout(processThumnailGenerationQueue, 100)
      }
    }

    const coverStart = performance.now()
    let cover = await invoke('get_cover', { path })
    const coverTime = performance.now() - coverStart

    if (isValidImageSrc(cover)) {
      caches.thumbnailCache.set(path, cover)
      caches.coverCache.set(path, cover)
      if (imgElement.isConnected) {
        imgElement.src = cover
        imgElement.style.display = 'block'
      }
      const totalTime = performance.now() - startTime
      PERF.totalLoadTime += totalTime
      if (totalTime > 500) {
        PERF.slowLoads.push({
          path: path.split('/').pop(),
          time: totalTime.toFixed(0),
          type: 'cover-fallback',
          coverTime: coverTime.toFixed(0)
        })
      }
      if (resolve) resolve()
      return
    }

    caches.thumbnailCache.set(path, null)

    if (artist && album) {
      PERF.internetFallbacks++
      queueInternetCoverFetch(path, artist, album, imgElement)
    }

    const totalTime = performance.now() - startTime
    PERF.totalLoadTime += totalTime
  } catch (e) {
    console.error('[PERF] Error loading thumbnail:', path, e)
    caches.thumbnailCache.set(path, null)
  }

  if (resolve) resolve()
}

async function processThumnailGenerationQueue() {
  if (thumbnailGenerationRunning || thumbnailGenerationQueue.length === 0) return

  thumbnailGenerationRunning = true

  const batch = thumbnailGenerationQueue.splice(0, 20)

  if (batch.length > 0) {
    console.log(`[THUMBNAIL] Generating ${batch.length} thumbnails in background...`)
    try {
      const generated = await invoke('generate_thumbnails_batch', { paths: batch })
      console.log(`[THUMBNAIL] Generated ${generated} thumbnails`)

      for (const path of batch) {
        caches.thumbnailCache.delete(path)
      }
    } catch (e) {
      console.error('[THUMBNAIL] Batch generation error:', e)
    }
  }

  thumbnailGenerationRunning = false

  if (thumbnailGenerationQueue.length > 0) {
    setTimeout(processThumnailGenerationQueue, 100)
  }
}

// === QUEUE INTERNET COVER (non-bloquant) ===
const internetCoverQueue = []
let internetFetchRunning = false

function queueInternetCoverFetch(path, artist, album, imgElement) {
  if (internetCoverQueue.find(q => q.path === path)) return

  internetCoverQueue.push({ path, artist, album, imgElement })

  if (!internetFetchRunning) {
    processInternetCoverQueue()
  }
}

async function processInternetCoverQueue() {
  if (internetFetchRunning || internetCoverQueue.length === 0) return

  internetFetchRunning = true

  const item = internetCoverQueue.shift()
  if (!item) {
    internetFetchRunning = false
    return
  }

  try {
    const cover = await invoke('fetch_internet_cover', { artist: item.artist, album: item.album })

    if (isValidImageSrc(cover)) {
      caches.thumbnailCache.set(item.path, cover)
      if (item.imgElement && item.imgElement.isConnected) {
        item.imgElement.src = cover
        item.imgElement.style.display = 'block'
        const placeholder = item.imgElement.nextElementSibling || item.imgElement.parentElement?.querySelector('.carousel-cover-placeholder, .album-cover-placeholder')
        if (placeholder) placeholder.style.display = 'none'
      }
    }
  } catch (e) {
    console.error('[INTERNET] Error fetching cover:', item.artist, item.album, e)
  }

  internetFetchRunning = false

  if (internetCoverQueue.length > 0) {
    setTimeout(processInternetCoverQueue, 100)
  }
}

// === IMAGES D'ARTISTES ===
const artistImageCache = new Map()

export function loadArtistImageAsync(artistName, imgElement, fallbackAlbum = null, fallbackCoverPath = null) {
  return new Promise((resolve) => {
    const cacheKey = `artist:${artistName}`

    if (artistImageCache.has(cacheKey)) {
      const image = artistImageCache.get(cacheKey)
      if (isValidImageSrc(image)) {
        imgElement.src = image
        imgElement.style.display = 'block'
      }
      resolve()
      return
    }

    loadQueue.push({
      type: 'artist',
      artistName,
      imgElement,
      fallbackAlbum,
      fallbackCoverPath,
      cacheKey,
      startTime: performance.now(),
      resolve
    })

    processLoadQueue()
  })
}

async function loadArtistImageFromQueue(item) {
  const { artistName, imgElement, fallbackAlbum, fallbackCoverPath, cacheKey, resolve } = item

  if (!imgElement.isConnected) {
    if (resolve) resolve()
    return
  }

  try {
    const image = await invoke('fetch_artist_image', {
      artist: artistName,
      fallbackAlbum: fallbackAlbum,
      fallbackCoverPath: fallbackCoverPath
    })

    artistImageCache.set(cacheKey, image)

    if (isValidImageSrc(image) && imgElement.isConnected) {
      imgElement.src = image
      imgElement.style.display = 'block'
    }
  } catch (e) {
    console.error('Erreur artist image:', artistName, e)
    artistImageCache.set(cacheKey, null)
  }

  if (resolve) resolve()
}

// === MODULE INDEXATION ===
const indexationEls = {
  get header() { return document.getElementById('indexation-header') },
  get content() { return document.getElementById('indexation-content') },
  get active() { return document.getElementById('indexation-active') },
  get inactive() { return document.getElementById('indexation-inactive') },
  get btnToggle() { return document.getElementById('btn-toggle-indexation') },
  get progressMiniFill() { return document.getElementById('progress-mini-fill') },
  get progressMini() { return document.getElementById('indexation-progress-mini') },
  get progressFill() { return document.getElementById('indexation-progress-fill') },
  get percent() { return document.getElementById('indexation-percent') },
  get folder() { return document.getElementById('indexation-folder') },
  get refreshCollapsed() { return document.getElementById('refresh-indexation-collapsed') },
  get addContentBtn() { return document.getElementById('add-content-btn') },
  get statArtists() { return document.getElementById('stat-artists') },
  get statAlbums() { return document.getElementById('stat-albums') },
  get statMp3() { return document.getElementById('stat-mp3') },
  get statFlac16() { return document.getElementById('stat-flac16') },
  get statFlac24() { return document.getElementById('stat-flac24') },
}

function updateIndexationUI() {
  if (ui.isIndexationExpanded) {
    indexationEls.content?.classList.remove('hidden')
    indexationEls.btnToggle?.classList.add('expanded')
  } else {
    indexationEls.content?.classList.add('hidden')
    indexationEls.btnToggle?.classList.remove('expanded')
  }

  if (ui.isIndexing) {
    indexationEls.active?.classList.remove('hidden')
    indexationEls.inactive?.classList.add('hidden')
    if (ui.isIndexationExpanded) {
      indexationEls.progressMini?.classList.add('hidden')
    } else {
      indexationEls.progressMini?.classList.remove('hidden')
    }
    indexationEls.refreshCollapsed?.classList.add('hidden')
  } else {
    indexationEls.active?.classList.add('hidden')
    indexationEls.inactive?.classList.remove('hidden')
    indexationEls.progressMini?.classList.add('hidden')
    indexationEls.refreshCollapsed?.classList.remove('hidden')
  }
}

export function updateIndexationStats(stats) {
  if (!stats) return

  if (indexationEls.statArtists) indexationEls.statArtists.textContent = stats.artists_count || 0
  if (indexationEls.statAlbums) indexationEls.statAlbums.textContent = stats.albums_count || 0
  if (indexationEls.statMp3) indexationEls.statMp3.textContent = stats.mp3_count || 0
  if (indexationEls.statFlac16) indexationEls.statFlac16.textContent = stats.flac_16bit_count || 0
  if (indexationEls.statFlac24) indexationEls.statFlac24.textContent = stats.flac_24bit_count || 0

  ui.isIndexing = false
  updateIndexationUI()
}

function updateIndexationProgress(progress) {
  const percent = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0

  if (indexationEls.progressMiniFill) indexationEls.progressMiniFill.style.width = percent + '%'
  if (indexationEls.progressFill) indexationEls.progressFill.style.width = percent + '%'
  if (indexationEls.percent) indexationEls.percent.textContent = percent + '%'
  if (indexationEls.folder) indexationEls.folder.textContent = progress.folder

  ui.isIndexing = true
  updateIndexationUI()
}

export async function startBackgroundScan() {
  console.log('Starting background scan...')
  ui.isIndexing = true
  updateIndexationUI()
  try {
    await invoke('start_background_scan')
  } catch (e) {
    console.error('[LIBRARY] Error starting background scan:', e)
  }
}

// Cache des discovery mixes
let discoveryMixCacheValid = true

export function invalidateHomeCache() {
  caches.homeDataCache.isValid = false
}

export function invalidateDiscoveryMixCache() {
  discoveryMixCacheValid = false
}

async function reloadLibraryFromCache() {
  console.log('[RELOAD] Reloading library from updated cache...')

  let cachedTracks, cachedStats
  try {
    ;[cachedTracks, cachedStats] = await invoke('load_tracks_from_cache')
  } catch (e) {
    console.error('[RELOAD] Error loading tracks from cache:', e)
    return
  }
  console.log('[RELOAD] Got from cache:', cachedTracks?.length || 0, 'tracks')

  if (cachedTracks) {
    library.tracks.length = 0
    for (const track of cachedTracks) {
      library.tracks.push(track)
    }
    console.log('[RELOAD] tracks.length after reload:', library.tracks.length)

    let addedDates = {}
    try {
      addedDates = await invoke('get_added_dates') || {}
    } catch (e) {
      console.error('[RELOAD] Error loading added dates:', e)
    }
    library.trackAddedDates = addedDates

    console.log('[RELOAD] Grouping tracks...')
    groupTracksIntoAlbumsAndArtists()
    buildTrackLookup()
    console.log('[RELOAD] Albums:', Object.keys(library.albums).length, '| Artists:', Object.keys(library.artists).length)

    if (library.tracks.length > 0) {
      dom.welcomeDiv.classList.add('hidden')
      console.log('[RELOAD] Displaying view:', ui.currentView)
      app.displayCurrentView()
    } else {
      console.log('[RELOAD] No tracks after reload')
    }
  } else {
    console.log('[RELOAD] cachedTracks is null/undefined')
  }
}

// === SCAN LISTENERS ===
export async function initScanListeners() {
  await listen('scan_progress', (event) => {
    updateIndexationProgress(event.payload)
  })

  await listen('scan_complete', (event) => {
    const { stats, new_tracks, removed_tracks } = event.payload

    console.log(`Background scan complete: ${stats.total_tracks} tracks (${new_tracks} new, ${removed_tracks} removed)`)
    updateIndexationStats(stats)
    showToast(`Indexing complete - ${stats.total_tracks} files`)

    const shouldReload = new_tracks > 0 || removed_tracks > 0 || (library.tracks.length === 0 && stats.total_tracks > 0)
    if (shouldReload) {
      console.log(`Reloading library: new=${new_tracks}, removed=${removed_tracks}, local=${library.tracks.length}, scanned=${stats.total_tracks}`)
      invalidateDiscoveryMixCache()
      reloadLibraryFromCache()
    }
  })

  await listen('genre_enrichment_progress', (event) => {
    const { current, total, enriched } = event.payload
    console.log(`[Genre Enrichment] ${current}/${total} albums (${enriched} enriched)`)
  })

  await listen('genre_enrichment_complete', async (event) => {
    const { enriched_albums, total_albums } = event.payload
    console.log(`[Genre Enrichment] Complete: ${enriched_albums}/${total_albums} albums enriched`)

    if (enriched_albums > 0) {
      try {
        const [updatedTracks] = await invoke('load_tracks_from_cache')
        library.tracks.length = 0
        for (const t of updatedTracks) library.tracks.push(t)
        groupTracksIntoAlbumsAndArtists()
        buildTrackLookup()

        invalidateDiscoveryMixCache()

        if (ui.currentView === 'home') {
          app.displayCurrentView()
        }

        showToast(`Genres enriched for ${enriched_albums} albums`)
      } catch (e) {
        console.error('[Genre Enrichment] Failed to reload tracks:', e)
      }
    }
  })

  await listen('library_paths_inaccessible', (event) => {
    const paths = event.payload
    console.warn('[Library] Inaccessible paths:', paths)
    showInaccessiblePathsWarning(paths)
  })
}

function showInaccessiblePathsWarning(paths) {
  const existingWarning = document.querySelector('.inaccessible-paths-warning')
  if (existingWarning) existingWarning.remove()

  const warning = document.createElement('div')
  warning.className = 'inaccessible-paths-warning'

  const pathsList = paths.map(p => {
    const parts = p.split('/')
    return parts[2] || p
  }).join(', ')

  warning.innerHTML = `
    <div class="warning-icon">\u26A0\uFE0F</div>
    <div class="warning-content">
      <div class="warning-title">Library unavailable</div>
      <div class="warning-message">
        Some folders in your library are not accessible: <strong>${escapeHtml(pathsList)}</strong>
        <br>Check that your external drive is connected.
      </div>
    </div>
    <button class="warning-close" title="Close">\u00D7</button>
  `

  warning.querySelector('.warning-close').addEventListener('click', () => {
    warning.remove()
  })

  const player = document.querySelector('.player')
  if (player) {
    player.insertAdjacentElement('beforebegin', warning)
  } else {
    document.body.appendChild(warning)
  }
}

// Supprime des tracks de la bibliothèque (persistant : survit aux rescans)
export async function removeTracksFromLibrary(tracksToRemove) {
  if (!tracksToRemove || tracksToRemove.length === 0) return

  // Accepte objets track ou strings
  const paths = tracksToRemove.map(t => typeof t === 'string' ? t : t.path)
  const pathSet = new Set(paths)

  // Persister l'exclusion côté Rust (config.json + caches)
  try {
    await invoke('exclude_tracks_from_library', { paths })
  } catch (e) {
    console.error('[Library] Failed to exclude tracks:', e)
  }

  // Retire de la liste locale
  for (let i = library.tracks.length - 1; i >= 0; i--) {
    if (pathSet.has(library.tracks[i].path)) {
      library.tracks.splice(i, 1)
    }
  }

  // Regroupe et reconstruit
  groupTracksIntoAlbumsAndArtists()
  buildTrackLookup()
  app.displayCurrentView()
}

// === INITIALISATION ===
export function initLibrary() {
  // Indexation toggle
  const btnToggle = indexationEls.btnToggle
  if (btnToggle) {
    btnToggle.addEventListener('click', (e) => {
      e.stopPropagation()
      ui.isIndexationExpanded = !ui.isIndexationExpanded
      updateIndexationUI()
    })
  }

  const header = indexationEls.header
  if (header) {
    header.addEventListener('click', (e) => {
      if (e.target.closest('button')) return
      ui.isIndexationExpanded = !ui.isIndexationExpanded
      updateIndexationUI()
    })
  }

  const refreshBtn = indexationEls.refreshCollapsed
  if (refreshBtn) {
    refreshBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      startBackgroundScan()
    })
  }

  const addBtn = indexationEls.addContentBtn
  if (addBtn) {
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      selectFolder()
    })
  }

  // Init scan listeners et état initial
  initScanListeners()
  updateIndexationUI()
}

// Expose pour debug
export { coverObserver, discoveryMixCacheValid }
