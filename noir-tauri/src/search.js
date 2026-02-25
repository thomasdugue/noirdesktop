// search.js — Index inversé et recherche rapide dans la bibliothèque
// Fournit une recherche <16ms sur 10K+ tracks via index inversé

import { library, search, ui, caches, dom } from './state.js'
import { invoke } from './state.js'
import { app } from './app.js'
import { escapeHtml, isValidImageSrc } from './utils.js'

// === INDEX DE RECHERCHE ===

// Construit un index inversé pour la recherche rapide
export function buildSearchIndex() {
  search.index.clear()

  library.tracks.forEach((track, i) => {
    const text = [
      track.metadata?.title || track.name || '',
      track.metadata?.artist || '',
      track.metadata?.album || ''
    ].join(' ').toLowerCase()

    const words = text.split(/[\s\-_.,;:!?'"()\[\]{}]+/)

    for (const word of words) {
      if (word.length < 2) continue

      if (!search.index.has(word)) {
        search.index.set(word, new Set())
      }
      search.index.get(word).add(i)
    }
  })

  console.log(`[Search] Index built: ${search.index.size} unique words for ${library.tracks.length} tracks`)
}

// Recherche rapide utilisant l'index inversé
export function searchTracksWithIndex(query) {
  if (!query || query.length < 1) return null

  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length >= 1)
  if (queryWords.length === 0) return null

  let resultSet = null

  for (const queryWord of queryWords) {
    const wordMatches = new Set()

    for (const [indexWord, trackIndices] of search.index.entries()) {
      if (indexWord.startsWith(queryWord) || indexWord.includes(queryWord)) {
        for (const idx of trackIndices) {
          wordMatches.add(idx)
        }
      }
    }

    if (resultSet === null) {
      resultSet = wordMatches
    } else {
      resultSet = new Set([...resultSet].filter(x => wordMatches.has(x)))
    }

    if (resultSet.size === 0) break
  }

  return resultSet
}

// === PANEL DE RÉSULTATS DE RECHERCHE ===

let searchDebounceTimer = null

export function initSearchListeners() {
  dom.searchInput.addEventListener('input', (e) => {
    const query = e.target.value.trim()
    search.query = query.toLowerCase()

    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = setTimeout(() => {
      updateSearchResultsPanel(query)

      if (ui.currentView === 'tracks') {
        app.updateTracksFilter()
      }
    }, 200)
  })

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-bar-inner')) {
      closeSearchPanel()
    }
  })

  dom.searchInput.addEventListener('focus', () => {
    if (dom.searchInput.value.trim().length > 0) {
      updateSearchResultsPanel(dom.searchInput.value.trim())
    }
  })

  dom.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSearchPanel()
      dom.searchInput.blur()
    }
  })
}

export function closeSearchPanel() {
  dom.searchResultsPanel.classList.add('hidden')
}

function updateSearchResultsPanel(query) {
  const content = dom.searchResultsPanel.querySelector('.search-results-content')

  if (!query || query.length < 1) {
    closeSearchPanel()
    return
  }

  const q = query.toLowerCase()
  const results = { artists: [], albums: [], tracks: [] }
  const maxResults = 10

  // Recherche dans les artistes
  for (const artistName of Object.keys(library.artists)) {
    if (artistName.toLowerCase().includes(q)) {
      const artist = library.artists[artistName]
      const firstAlbumKey = artist.albums?.[0]
      const sampleAlbum = firstAlbumKey ? library.albums[firstAlbumKey] : null
      results.artists.push({
        name: artistName,
        albumCount: artist.albums?.length || 0,
        coverPath: sampleAlbum?.coverPath || null
      })
      if (results.artists.length >= maxResults) break
    }
  }

  // Recherche dans les albums
  for (const [albumKey, album] of Object.entries(library.albums)) {
    if (album.album.toLowerCase().includes(q) || album.artist.toLowerCase().includes(q)) {
      results.albums.push({
        key: albumKey,
        title: album.album,
        artist: album.artist,
        coverPath: album.coverPath || null
      })
      if (results.albums.length >= maxResults) break
    }
  }

  // Recherche dans les tracks — multi-mots, scoring
  const queryWords = q.split(/\s+/).filter(w => w.length >= 1)
  const scoredTracks = []

  for (let i = 0; i < library.tracks.length; i++) {
    const track = library.tracks[i]
    const title = (track.metadata?.title || track.name).toLowerCase()
    const trackArtist = (track.metadata?.artist || '').toLowerCase()
    const trackAlbum = (track.metadata?.album || '').toLowerCase()

    let allMatch = true
    let score = 0

    for (const qw of queryWords) {
      const inTitle = title.includes(qw)
      const inArtist = trackArtist.includes(qw)
      const inAlbum = trackAlbum.includes(qw)

      if (!inTitle && !inArtist && !inAlbum) {
        allMatch = false
        break
      }

      if (inTitle) {
        if (title === qw) score += 100
        else if (title.startsWith(qw)) score += 60
        else {
          const titleWords = title.split(/[\s\-_.,;:!?'"()\[\]{}]+/)
          if (titleWords.some(w => w === qw)) score += 50
          else if (titleWords.some(w => w.startsWith(qw))) score += 40
          else score += 20
        }
      } else if (inArtist) {
        if (trackArtist === qw) score += 30
        else if (trackArtist.startsWith(qw)) score += 20
        else score += 10
      } else if (inAlbum) {
        score += 5
      }
    }

    if (allMatch && queryWords.length > 0) {
      const albumObj = library.albums[track.metadata?.album || '']
      scoredTracks.push({
        path: track.path,
        title: track.metadata?.title || track.name,
        artist: track.metadata?.artist || 'Inconnu',
        album: track.metadata?.album || 'Inconnu',
        coverPath: albumObj?.coverPath || null,
        index: i,
        score
      })
    }
  }

  scoredTracks.sort((a, b) => b.score - a.score)
  results.tracks = scoredTracks.slice(0, maxResults)

  if (results.artists.length === 0 && results.albums.length === 0 && results.tracks.length === 0) {
    content.innerHTML = `<div class="search-no-results">No results for "${escapeHtml(query)}"</div>`
    dom.searchResultsPanel.classList.remove('hidden')
    return
  }

  // Construit le HTML
  let html = ''

  if (results.artists.length > 0) {
    html += `<div class="search-section">
      <div class="search-section-title">Artists</div>`
    for (const artist of results.artists) {
      html += `
        <div class="search-result-item" data-type="artist" data-artist="${escapeHtml(artist.name)}">
          <div class="search-result-cover artist" data-cover-path="${escapeHtml(artist.coverPath || '')}">
            <span>\uD83D\uDC64</span>
          </div>
          <div class="search-result-info">
            <div class="search-result-title">${escapeHtml(artist.name)}</div>
            <div class="search-result-subtitle">${artist.albumCount} album${artist.albumCount > 1 ? 's' : ''}</div>
          </div>
        </div>`
    }
    html += '</div>'
  }

  if (results.albums.length > 0) {
    html += `<div class="search-section">
      <div class="search-section-title">Albums</div>`
    for (const album of results.albums) {
      html += `
        <div class="search-result-item" data-type="album" data-album-key="${escapeHtml(album.key)}">
          <div class="search-result-cover" data-cover-path="${escapeHtml(album.coverPath || '')}">
            <span>\u266A</span>
          </div>
          <div class="search-result-info">
            <div class="search-result-title">${escapeHtml(album.title)}</div>
            <div class="search-result-subtitle">${escapeHtml(album.artist)}</div>
          </div>
        </div>`
    }
    html += '</div>'
  }

  if (results.tracks.length > 0) {
    html += `<div class="search-section">
      <div class="search-section-title">Tracks</div>`
    for (const track of results.tracks) {
      html += `
        <div class="search-result-item" data-type="track" data-track-index="${track.index}">
          <div class="search-result-cover" data-cover-path="${escapeHtml(track.coverPath || '')}">
            <span>\u266A</span>
          </div>
          <div class="search-result-info">
            <div class="search-result-title">${escapeHtml(track.title)}</div>
            <div class="search-result-subtitle">${escapeHtml(track.artist)} \u00B7 ${escapeHtml(track.album)}</div>
          </div>
        </div>`
    }
    html += '</div>'
  }

  content.innerHTML = html
  dom.searchResultsPanel.classList.remove('hidden')

  loadSearchResultCovers()

  content.querySelectorAll('.search-result-item').forEach(item => {
    item.addEventListener('click', () => handleSearchResultClick(item))
  })
}

function loadSearchResultCovers() {
  const covers = dom.searchResultsPanel.querySelectorAll('.search-result-cover[data-cover-path]')

  covers.forEach(coverDiv => {
    const path = coverDiv.dataset.coverPath
    if (!path) return

    const cached = caches.coverCache.get(path)
    if (isValidImageSrc(cached)) {
      coverDiv.innerHTML = `<img src="${cached}" alt="">`
      return
    }

    invoke('get_cover', { path }).then(cover => {
      if (isValidImageSrc(cover)) {
        caches.coverCache.set(path, cover)
        if (coverDiv.isConnected) {
          coverDiv.innerHTML = `<img src="${cover}" alt="">`
        }
      }
    }).catch(() => {})
  })
}

function handleSearchResultClick(item) {
  const type = item.dataset.type

  closeSearchPanel()
  dom.searchInput.value = ''
  search.query = ''

  if (type === 'artist') {
    const artistName = item.dataset.artist
    app.navigateToArtistPage(artistName)
  } else if (type === 'album') {
    const albumKey = item.dataset.albumKey
    const album = library.albums[albumKey]
    if (album) {
      app.navigateToAlbumPage(albumKey)
    }
  } else if (type === 'track') {
    const trackIndex = parseInt(item.dataset.trackIndex, 10)
    if (!isNaN(trackIndex) && trackIndex >= 0) {
      app.playTrack(trackIndex)
    }
  }
}

// Met à jour le filtre des tracks (utilisé quand on tape dans la recherche en vue tracks)
export function updateTracksFilter() {
  // Délègue au module views qui gère le virtual scroll
  if (ui.currentView === 'tracks') {
    app.displayCurrentView()
  }
}
