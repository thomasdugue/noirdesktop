// renderer.js - Gère l'interface utilisateur et la lecture audio

// Import Tauri API depuis le module d'état partagé
import { invoke, convertFileSrc, listen } from './state.js';
// Import des fonctions utilitaires
import {
  isValidImageSrc, loadCachedImage,
  setManagedTimeout, clearManagedTimeout, clearAllManagedTimeouts,
  getResponsiveItemCount, getCodecFromPath,
  getWaveformAnimationHTML, getSineWaveAnimationHTML,
  showLoading, updateLoading, hideLoading,
  showToast, escapeHtml,
  formatTime, formatAlbumDuration, formatQuality
} from './utils.js';
// Import auto-update
import { initAutoUpdate } from './auto-update.js';
// Import EQ
import { eqInit, openEqPanel, closeEqPanel, toggleEqPanel, getEqPanelOpen, setEqPanelCallbacks, eqUpdateStatusUI, eqUpdatePanelToggleLabel } from './eq.js';
// Import Fullscreen Player
import { openFullscreenPlayer, closeFullscreenPlayer, toggleFullscreenPlayer, isFullscreenOpen, updateFullscreenData, setFullscreenPlayState, setFullscreenRms, setNextTrackInfoCallback, setCurrentTrackPathCallback } from './fullscreen-player.js';
// === WINDOW DRAG ===
// Le drag est géré nativement par Tauri 2 via l'attribut data-tauri-drag-region sur le titlebar HTML
// Ne PAS ajouter de handler JS mousedown → startDragging() car il interfère avec le mécanisme natif

// === AUDIO ENGINE STATE (Player Audiophile Rust) ===
// Le moteur audio tourne côté Rust, on ne fait que l'interface ici
// NOTE: HTML5 audio fallback has been REMOVED - all audio goes through Rust/CPAL
let audioIsPlaying = false;
let audioDurationFromRust = 0;
let audioPositionFromRust = 0;
let gaplessPreloadTriggered = false;

// === FAVORIS ===
// Set des chemins de tracks favorites (pour lookup O(1))
let favoriteTracks = new Set()

// === SYSTÈME DE DRAG CUSTOM (car HTML5 drag & drop ne fonctionne pas dans Tauri WebView) ===
// On utilise mousedown/mousemove/mouseup à la place
// Le drag ne démarre qu'après un déplacement minimum (pour distinguer clic vs drag)
const DRAG_THRESHOLD = 5 // pixels

let customDragState = {
  isPotentialDrag: false, // mousedown détecté, attente de mouvement
  isDragging: false,      // drag effectivement démarré
  track: null,            // track individuelle (si drag d'une track)
  albumKey: null,         // clé d'album (si drag d'un album complet)
  trackElement: null,
  ghostElement: null,
  startX: 0,
  startY: 0,
  currentHighlightedPlaylist: null // Track le dernier élément survolé pour éviter querySelectorAll
}

// Initialise le système de drag custom au chargement
function initCustomDragSystem() {
  // Crée l'élément ghost pour le drag visuel
  const ghost = document.createElement('div')
  ghost.className = 'drag-ghost'
  ghost.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 9999;
    background: #2a2a2a;
    border: 1px solid #fff;
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 13px;
    color: #fff;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    display: none;
    max-width: 250px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `
  document.body.appendChild(ghost)
  customDragState.ghostElement = ghost

  // Gère le déplacement de la souris
  document.addEventListener('mousemove', (e) => {
    // Si on est en potentiel drag, vérifie si on a assez bougé pour démarrer
    if (customDragState.isPotentialDrag && !customDragState.isDragging) {
      const dx = Math.abs(e.clientX - customDragState.startX)
      const dy = Math.abs(e.clientY - customDragState.startY)

      if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
        // Démarre vraiment le drag
        customDragState.isDragging = true

        // Ajoute classe sur body pour empêcher tout highlight
        document.body.classList.add('dragging-active')

        // Affiche le ghost avec le bon texte selon le type de drag
        if (customDragState.albumKey && albums[customDragState.albumKey]) {
          const album = albums[customDragState.albumKey]
          customDragState.ghostElement.textContent = '💿 ' + album.album + ' (' + album.tracks.length + ' titres)'
        } else if (customDragState.track) {
          const title = customDragState.track.metadata?.title || customDragState.track.name
          customDragState.ghostElement.textContent = '♪ ' + title
        }
        customDragState.ghostElement.style.display = 'block'

        // Ajoute la classe dragging
        if (customDragState.trackElement) {
          customDragState.trackElement.classList.add('dragging-track')
        }
      }
    }

    // Si on est en drag actif, met à jour la position
    if (customDragState.isDragging) {
      customDragState.ghostElement.style.left = (e.clientX + 15) + 'px'
      customDragState.ghostElement.style.top = (e.clientY + 15) + 'px'

      // Vérifie si on survole une playlist
      const playlistItem = document.elementFromPoint(e.clientX, e.clientY)?.closest('.playlist-item')

      // Optimisation : ne met à jour que si l'élément survolé a changé
      if (playlistItem !== customDragState.currentHighlightedPlaylist) {
        // Retire le highlight de l'ancien
        if (customDragState.currentHighlightedPlaylist) {
          customDragState.currentHighlightedPlaylist.classList.remove('drag-over')
        }
        // Ajoute le highlight sur le nouveau
        if (playlistItem) {
          playlistItem.classList.add('drag-over')
        }
        customDragState.currentHighlightedPlaylist = playlistItem
      }
    }
  })

  // Gère le relâchement de la souris
  document.addEventListener('mouseup', async (e) => {
    const wasDragging = customDragState.isDragging

    // Cache le ghost
    if (customDragState.ghostElement) {
      customDragState.ghostElement.style.display = 'none'
    }

    // Retire la classe de body
    document.body.classList.remove('dragging-active')

    // Nettoie le highlight de la playlist (optimisé - pas de querySelectorAll)
    if (customDragState.currentHighlightedPlaylist) {
      customDragState.currentHighlightedPlaylist.classList.remove('drag-over')
    }
    // Nettoie la classe dragging-track de l'élément source
    if (customDragState.trackElement) {
      customDragState.trackElement.classList.remove('dragging-track')
    }

    // Si on était vraiment en train de drag, vérifie le drop
    if (wasDragging) {
      const playlistItem = document.elementFromPoint(e.clientX, e.clientY)?.closest('.playlist-item')

      if (playlistItem) {
        const playlistId = playlistItem.dataset.playlistId
        if (playlistId) {
          // Si c'est un album, ajoute tous les tracks
          if (customDragState.albumKey && albums[customDragState.albumKey]) {
            const album = albums[customDragState.albumKey]
            for (const track of album.tracks) {
              await addTrackToPlaylist(playlistId, track)
            }
            showToast(`Album "${album.album}" added to playlist`)
          } else if (customDragState.track) {
            // Sinon ajoute juste la track
            await addTrackToPlaylist(playlistId, customDragState.track)
          }
        }
      }
    }

    // Reset l'état
    customDragState.isPotentialDrag = false
    customDragState.isDragging = false
    customDragState.track = null
    customDragState.albumKey = null
    customDragState.trackElement = null
    customDragState.currentHighlightedPlaylist = null
  })

  // === DRAG DEPUIS LE PLAYER ===
  // Permet de glisser la track en cours de lecture vers une playlist
  const playerLeft = document.querySelector('.player-left')
  if (playerLeft) {
    playerLeft.addEventListener('mousedown', (e) => {
      // Ignore si on clique sur un bouton ou si pas de track en lecture
      if (e.target.closest('button') || currentTrackIndex < 0) return
      const currentTrack = tracks[currentTrackIndex]
      if (!currentTrack) return
      prepareCustomDrag(e, currentTrack, playerLeft)
    })
    playerLeft.style.cursor = 'grab'
  }
}

// Prépare un drag custom pour une track (appelé sur mousedown)
function prepareCustomDrag(e, track, trackElement) {
  // Ignore si on clique sur un bouton
  if (e.target.closest('button')) return false

  customDragState.isPotentialDrag = true
  customDragState.isDragging = false
  customDragState.track = track
  customDragState.albumKey = null
  customDragState.trackElement = trackElement
  customDragState.startX = e.clientX
  customDragState.startY = e.clientY

  return true // Indique qu'on a préparé le drag
}

// Prépare un drag custom pour un album complet (appelé sur mousedown sur une card album)
function prepareAlbumDrag(e, albumKey, cardElement) {
  // Ignore si on clique sur un bouton
  if (e.target.closest('button')) return false

  customDragState.isPotentialDrag = true
  customDragState.isDragging = false
  customDragState.track = null
  customDragState.albumKey = albumKey
  customDragState.trackElement = cardElement
  customDragState.startX = e.clientX
  customDragState.startY = e.clientY

  return true
}

// === SCROLLBAR ALPHABÉTIQUE ===
// Crée une barre de navigation alphabétique rapide pour les pages Artistes/Albums
function createAlphabetScrollbar(container, items, getFirstLetter, scrollContainer) {
  // Supprime la scrollbar existante si présente
  const existing = document.querySelector('.alphabet-nav')
  if (existing) existing.remove()

  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('')
  const nav = document.createElement('div')
  nav.className = 'alphabet-nav'

  // Trouve quelles lettres ont des items
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

    // Grise les lettres sans items
    if (!letterSet.has(letter)) {
      btn.classList.add('disabled')
    }

    btn.addEventListener('click', () => {
      // Trouve le premier item commençant par cette lettre
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

// === ÉLÉMENTS DE LA PAGE ===
const selectFolderBtn = document.getElementById('select-folder')
const openFolderWelcomeBtn = document.getElementById('open-folder-welcome')
const welcomeDiv = document.getElementById('welcome')
const albumsViewDiv = document.getElementById('albums-view')
const albumsGridDiv = document.getElementById('albums-grid')
const playerDiv = document.getElementById('player')
// audioElement removed - all audio handled by Rust/CPAL
const trackNameEl = document.getElementById('track-name')
const trackFolderEl = document.getElementById('track-folder')
const playPauseBtn = document.getElementById('play-pause')
const progressBar = document.getElementById('progress')
const currentTimeEl = document.getElementById('current-time')
const durationEl = document.getElementById('duration')
const coverArtEl = document.getElementById('cover-art')
const prevBtn = document.getElementById('prev')
const nextBtn = document.getElementById('next')
const searchInput = document.getElementById('search-input')
const searchResultsPanel = document.getElementById('search-results-panel')
const shuffleBtn = document.getElementById('shuffle')
const repeatBtn = document.getElementById('repeat')
const volumeBar = document.getElementById('volume')
const volumeBtn = document.getElementById('volume-btn')
const audioOutputBtn = document.getElementById('audio-output-btn')
const audioOutputMenu = document.getElementById('audio-output-menu')
const audioOutputList = document.getElementById('audio-output-list')
const exclusiveModeCheckbox = document.getElementById('exclusive-mode-checkbox')

// Panel détail album (sera créé dynamiquement)
let albumDetailDiv = null

// === ÉTAT DE L'APPLICATION ===
let tracks = []           // Liste de tous les morceaux
let albums = {}           // Albums groupés { "Artiste - Album": { tracks: [], cover: null } }
let artists = {}          // Artistes groupés { "Artiste": { albums: [], tracks: [] } }
let currentTrackIndex = -1 // Index du morceau en cours
let searchQuery = ''      // Recherche en cours
let selectedAlbumKey = null // Album actuellement sélectionné
let currentView = 'home' // Vue actuelle : 'home', 'albums', 'artists', 'tracks'
let filteredArtist = null  // Artiste filtré (pour la navigation artiste → albums)
let shuffleMode = 'off'    // Mode shuffle : 'off', 'album', 'library'
let repeatMode = 'off'     // Mode répétition : 'off', 'all', 'one'
let shufflePlayedTracks = new Set()  // Historique des tracks joués en shuffle (évite les doublons)
let currentPlayingAlbumKey = null  // Album en cours de lecture (pour skip séquentiel)
let lastVolume = 100       // Dernier volume avant mute

// === FILE D'ATTENTE (QUEUE) ===
let queue = []             // File d'attente des morceaux à jouer
let isQueuePanelOpen = false // État du panel queue

// === PANEL INFORMATIONS TRACK ===
let isTrackInfoPanelOpen = false // État du panel d'informations
let trackInfoCurrentTrack = null // Track actuellement affichée dans le panel

// === TRI DES COLONNES (vue Titres) ===
let sortColumn = 'title'   // Colonne de tri : 'title', 'artist', 'album', 'duration'
let sortDirection = 'asc'  // Direction : 'asc' ou 'desc'

// === TRI DES ALBUMS ===
let albumSortMode = 'artist-asc' // 'artist-asc', 'artist-desc', 'album-asc', 'album-desc'

// === CACHE POUR LES PERFORMANCES ===
// Note: Les caches stockent maintenant des URLs noir:// (~60 octets) au lieu de base64 (~700KB)
// Cela réduit la consommation mémoire de ~99% par pochette
const coverCache = new Map()      // Cache des pochettes { path: "noir://localhost/covers/xxx.jpg" }
const thumbnailCache = new Map()  // Cache des thumbnails { path: "noir://localhost/thumbnails/xxx_thumb.jpg" }

// isValidImageSrc, loadCachedImage → importés depuis utils.js
let metadataLoaded = false        // Indique si les métadonnées ont été chargées
let trackAddedDates = {}          // Dates d'ajout des tracks { path: timestamp }

// === INDEX DE RECHERCHE ===
const searchIndex = new Map()     // Index inversé : mot → Set<index de track>

// === DIAGNOSTIC PERFORMANCE ===
const PERF = {
  thumbnailCalls: 0,
  thumbnailCacheHits: 0,
  thumbnailCacheMisses: 0,
  coverFallbacks: 0,
  internetFallbacks: 0,
  totalLoadTime: 0,
  slowLoads: [],  // > 500ms
  pageLoads: [],  // Temps de chargement par page

  reset() {
    this.thumbnailCalls = 0
    this.thumbnailCacheHits = 0
    this.thumbnailCacheMisses = 0
    this.coverFallbacks = 0
    this.internetFallbacks = 0
    this.totalLoadTime = 0
    this.slowLoads = []
  },

  log() {
    const hitRate = this.thumbnailCalls > 0 ? (this.thumbnailCacheHits/this.thumbnailCalls*100).toFixed(1) : 0
    const avgTime = this.thumbnailCalls > 0 ? (this.totalLoadTime/this.thumbnailCalls).toFixed(0) : 0
    console.log(`%c[PERF] === THUMBNAIL PERFORMANCE REPORT ===`, 'color: #00ff00; font-weight: bold')
    console.log(`[PERF] Total calls: ${this.thumbnailCalls}`)
    console.log(`[PERF] Cache hits: ${this.thumbnailCacheHits} (${hitRate}%)`)
    console.log(`[PERF] Cache misses: ${this.thumbnailCacheMisses}`)
    console.log(`[PERF] Cover fallbacks: ${this.coverFallbacks}`)
    console.log(`[PERF] Internet fallbacks: ${this.internetFallbacks}`)
    console.log(`[PERF] Avg load time: ${avgTime}ms`)
    console.log(`[PERF] Slow loads (>500ms): ${this.slowLoads.length}`)
    if (this.slowLoads.length > 0) {
      console.log(`[PERF] Top 10 slowest:`)
      this.slowLoads.sort((a, b) => parseInt(b.time) - parseInt(a.time)).slice(0, 10).forEach((s, i) => {
        console.log(`  ${i+1}. ${s.time}ms - ${s.type} - ${s.path}`)
      })
    }
    console.log(`%c[PERF] === END REPORT ===`, 'color: #00ff00; font-weight: bold')
  }
}

// Exposer pour debug console
window.PERF = PERF

// Cache des données Home (évite les appels backend répétés)
let homeDataCache = {
  lastPlayed: null,
  recentTracks: [],
  allPlayedAlbums: [],
  topArtists: [],
  lastFetch: 0,
  isValid: false
}
const HOME_CACHE_TTL = 30000  // 30 secondes de validité

// Invalide le cache Home (appelé quand on joue une track, etc.)
function invalidateHomeCache() {
  homeDataCache.isValid = false
}

// === LAZY LOADING DES POCHETTES (Intersection Observer) ===
let coverObserver = null

function initCoverObserver() {
  if (coverObserver) return  // Déjà initialisé

  coverObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const card = entry.target
        const img = card.querySelector('.album-cover-img, .carousel-cover-img')
        const placeholder = card.querySelector('.album-cover-placeholder, .carousel-cover-placeholder')
        const coverPath = card.dataset.coverPath

        if (coverPath && img && !img.src) {
          // Vérifie le cache d'abord (instantané)
          const cached = coverCache.get(coverPath)
          if (isValidImageSrc(cached)) {
            img.src = cached
            img.style.display = 'block'
            if (placeholder) placeholder.style.display = 'none'
          } else {
            // Charge le thumbnail de façon asynchrone (150x150 WebP)
            loadThumbnailAsync(coverPath, img).then(() => {
              if (img.style.display === 'block' && placeholder) {
                placeholder.style.display = 'none'
              }
            })
          }
        }

        // Une fois chargé, on arrête d'observer
        coverObserver.unobserve(card)
      }
    })
  }, {
    root: document.querySelector('.albums-view'),
    rootMargin: '100px',  // Charge un peu avant d'être visible
    threshold: 0.1
  })
}

// Observe une carte pour lazy loading
function observeCoverLoading(card, coverPath) {
  if (!coverObserver) initCoverObserver()
  card.dataset.coverPath = coverPath
  coverObserver.observe(card)
}

// setManagedTimeout, clearManagedTimeout, clearAllManagedTimeouts → importés depuis utils.js

// getResponsiveItemCount → importé depuis utils.js

// Navigation menu
const navItems = document.querySelectorAll('.nav-item')

// getCodecFromPath, getWaveformAnimationHTML, getSineWaveAnimationHTML → importés depuis utils.js
// showLoading, updateLoading, hideLoading → importés depuis utils.js

// === SÉLECTION DE DOSSIER ===
async function selectFolder() {
  const folderPath = await invoke('select_folder')
  if (!folderPath) return // Annulé

  await addFolder(folderPath)
}

// Ajoute un dossier à la bibliothèque
async function addFolder(folderPath) {
  showLoading('Scan du dossier...')

  // Scanne le dossier AVEC métadonnées (version optimisée parallèle)
  const tracksWithMetadata = await invoke('scan_folder_with_metadata', { path: folderPath })

  if (tracksWithMetadata.length === 0) {
    hideLoading()
    alert('No audio files found in this folder.')
    return
  }

  updateLoading(`${tracksWithMetadata.length} files loaded`)

  // Sauvegarde le chemin pour la prochaine fois
  await invoke('add_library_path', { path: folderPath })

  // Ajoute les morceaux à la liste existante (évite les doublons par chemin)
  const existingPaths = new Set(tracks.map(t => t.path))
  let newCount = 0
  for (const track of tracksWithMetadata) {
    if (!existingPaths.has(track.path)) {
      // Les métadonnées sont déjà incluses !
      tracks.push(track)
      newCount++
    }
  }

  // Sauvegarde le cache
  await invoke('save_all_caches')

  // Regroupe par album/artiste et construit les index
  groupTracksIntoAlbumsAndArtists()
  buildTrackLookup()  // Index O(1) pour lookups par path

  // Cache le message de bienvenue
  welcomeDiv.classList.add('hidden')

  hideLoading()

  // Affiche la vue courante
  displayCurrentView()
}

// Charge les métadonnées pour une liste de tracks
async function loadMetadataForTracks(trackList) {
  const total = trackList.length
  let loaded = 0

  // Charge par lots de 20 pour éviter de surcharger
  const batchSize = 20
  for (let i = 0; i < trackList.length; i += batchSize) {
    const batch = trackList.slice(i, i + batchSize)

    // Charge les métadonnées en parallèle pour ce lot
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

    // Met à jour le message de progression
    updateLoading(`Metadata: ${loaded}/${total}`, `${Math.round(loaded/total*100)}%`)
  }
}

// Groupe les tracks en albums et artistes (sans recharger les métadonnées)
function groupTracksIntoAlbumsAndArtists() {
  albums = {}
  artists = {}

  for (const track of tracks) {
    if (!track.metadata) continue

    // Groupe par nom d'album uniquement (pas par artiste-album)
    const albumKey = track.metadata.album || 'Unknown Album'
    const artistKey = track.metadata.artist

    // Groupe par album
    if (!albums[albumKey]) {
      albums[albumKey] = {
        artist: track.metadata.artist,
        album: track.metadata.album,
        tracks: [],
        coverPath: track.path,
        cover: null, // Sera chargé à la demande
        artistsSet: new Set() // Pour détecter les albums multi-artistes
      }
    }
    albums[albumKey].tracks.push(track)
    albums[albumKey].artistsSet.add(track.metadata.artist)

    // Groupe par artiste
    if (!artists[artistKey]) {
      artists[artistKey] = {
        name: artistKey,
        albums: new Set(),
        tracks: [],
        coverPath: track.path
      }
    }
    artists[artistKey].albums.add(albumKey)
    artists[artistKey].tracks.push(track)
  }

  // Trie les morceaux de chaque album par numéro de piste
  // Et détermine l'artiste affiché
  for (const albumKey in albums) {
    // Trie par numéro de disque, puis par numéro de track, puis par nom de fichier
    albums[albumKey].tracks.sort((a, b) => {
      const discA = a.metadata?.disc || 1
      const discB = b.metadata?.disc || 1
      if (discA !== discB) return discA - discB
      const trackA = a.metadata?.track || 0
      const trackB = b.metadata?.track || 0
      if (trackA !== trackB) return trackA - trackB
      // Fallback: tri alphabétique par nom de fichier
      return (a.name || '').localeCompare(b.name || '')
    })

    const artistsArray = Array.from(albums[albumKey].artistsSet)
    const totalTracks = albums[albumKey].tracks.length

    if (artistsArray.length > 1) {
      // Compte le nombre de tracks par artiste
      const artistCounts = {}
      for (const track of albums[albumKey].tracks) {
        const artist = track.metadata?.artist || 'Unknown Artist'
        artistCounts[artist] = (artistCounts[artist] || 0) + 1
      }

      // Trouve l'artiste majoritaire (> 50% des tracks)
      let mainArtist = null
      for (const [artist, count] of Object.entries(artistCounts)) {
        if (count > totalTracks / 2) {
          mainArtist = artist
          break
        }
      }

      if (mainArtist) {
        // Artiste majoritaire trouvé
        albums[albumKey].artist = mainArtist
        albums[albumKey].isVariousArtists = true // Garde true pour afficher l'artiste sur chaque track
      } else {
        // Pas d'artiste majoritaire = Artistes Variés
        albums[albumKey].artist = 'Various Artists'
        albums[albumKey].isVariousArtists = true
      }
    } else {
      albums[albumKey].artist = artistsArray[0] || 'Unknown Artist'
      albums[albumKey].isVariousArtists = false
    }

    // Supprime le Set temporaire
    delete albums[albumKey].artistsSet
  }

  // Convertit les Sets en Arrays pour les artistes
  for (const artistKey in artists) {
    artists[artistKey].albums = Array.from(artists[artistKey].albums)
  }

  metadataLoaded = true

  // Reconstruit l'index de recherche
  buildSearchIndex()
}

// Construit un index inversé pour la recherche rapide
function buildSearchIndex() {
  searchIndex.clear()

  tracks.forEach((track, i) => {
    const text = [
      track.metadata?.title || track.name || '',
      track.metadata?.artist || '',
      track.metadata?.album || ''
    ].join(' ').toLowerCase()

    // Tokenize : sépare par espaces et caractères spéciaux
    const words = text.split(/[\s\-_.,;:!?'"()\[\]{}]+/)

    for (const word of words) {
      if (word.length < 2) continue // Ignore les mots trop courts

      // Ajoute l'index du track pour ce mot
      if (!searchIndex.has(word)) {
        searchIndex.set(word, new Set())
      }
      searchIndex.get(word).add(i)
    }
  })

  console.log(`[Search] Index built: ${searchIndex.size} unique words for ${tracks.length} tracks`)
}

// Recherche rapide utilisant l'index inversé
function searchTracksWithIndex(query) {
  if (!query || query.length < 1) return null // Fallback vers recherche classique

  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length >= 1)
  if (queryWords.length === 0) return null

  let resultSet = null

  for (const queryWord of queryWords) {
    const wordMatches = new Set()

    // Cherche tous les mots de l'index qui commencent par queryWord (prefix match)
    for (const [indexWord, trackIndices] of searchIndex.entries()) {
      if (indexWord.startsWith(queryWord) || indexWord.includes(queryWord)) {
        for (const idx of trackIndices) {
          wordMatches.add(idx)
        }
      }
    }

    // Intersection des résultats (tous les mots doivent matcher)
    if (resultSet === null) {
      resultSet = wordMatches
    } else {
      resultSet = new Set([...resultSet].filter(x => wordMatches.has(x)))
    }

    // Si plus aucun résultat, on peut arrêter
    if (resultSet.size === 0) break
  }

  return resultSet
}

// === MODULE INDEXATION ===
// Elements
const indexationHeader = document.getElementById('indexation-header')
const indexationContent = document.getElementById('indexation-content')
const indexationActive = document.getElementById('indexation-active')
const indexationInactive = document.getElementById('indexation-inactive')
const btnToggleIndexation = document.getElementById('btn-toggle-indexation')

// Progress elements
const progressMiniFill = document.getElementById('progress-mini-fill')
const progressMini = document.getElementById('indexation-progress-mini')
const indexationProgressFill = document.getElementById('indexation-progress-fill')
const indexationPercent = document.getElementById('indexation-percent')
const indexationFolder = document.getElementById('indexation-folder')

// Buttons
const refreshCollapsed = document.getElementById('refresh-indexation-collapsed')
const addContentBtn = document.getElementById('add-content-btn')

// Stats elements
const statArtists = document.getElementById('stat-artists')
const statAlbums = document.getElementById('stat-albums')
const statMp3 = document.getElementById('stat-mp3')
const statFlac16 = document.getElementById('stat-flac16')
const statFlac24 = document.getElementById('stat-flac24')

// États
let isIndexing = false
let isIndexationExpanded = false

// Met à jour l'interface selon les états
function updateIndexationUI() {
  // Toggle replié/déplié
  if (isIndexationExpanded) {
    indexationContent?.classList.remove('hidden')
    btnToggleIndexation?.classList.add('expanded')
  } else {
    indexationContent?.classList.add('hidden')
    btnToggleIndexation?.classList.remove('expanded')
  }

  // Selon l'état d'indexation
  if (isIndexing) {
    // Mode actif (indexation en cours)
    indexationActive?.classList.remove('hidden')
    indexationInactive?.classList.add('hidden')
    // Masquer progress mini si déplié (on a déjà la grande barre visible)
    if (isIndexationExpanded) {
      progressMini?.classList.add('hidden')
    } else {
      progressMini?.classList.remove('hidden')
    }
    refreshCollapsed?.classList.add('hidden')
  } else {
    // Mode inactif (indexation terminée)
    indexationActive?.classList.add('hidden')
    indexationInactive?.classList.remove('hidden')
    progressMini?.classList.add('hidden')
    refreshCollapsed?.classList.remove('hidden')
  }
}

// Met à jour l'affichage des statistiques
function updateIndexationStats(stats) {
  if (!stats) return

  if (statArtists) statArtists.textContent = stats.artists_count || 0
  if (statAlbums) statAlbums.textContent = stats.albums_count || 0
  if (statMp3) statMp3.textContent = stats.mp3_count || 0
  if (statFlac16) statFlac16.textContent = stats.flac_16bit_count || 0
  if (statFlac24) statFlac24.textContent = stats.flac_24bit_count || 0

  isIndexing = false
  updateIndexationUI()
}

// Met à jour la barre de progression
function updateIndexationProgress(progress) {
  const percent = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0

  // Progress mini (header replié)
  if (progressMiniFill) progressMiniFill.style.width = percent + '%'

  // Progress détaillé (contenu déplié)
  if (indexationProgressFill) indexationProgressFill.style.width = percent + '%'
  if (indexationPercent) indexationPercent.textContent = percent + '%'
  if (indexationFolder) indexationFolder.textContent = progress.folder

  isIndexing = true
  updateIndexationUI()
}

// showToast → importé depuis utils.js

// Lance le scan en arrière-plan
async function startBackgroundScan() {
  console.log('Starting background scan...')
  isIndexing = true
  updateIndexationUI()
  await invoke('start_background_scan')
}

// Recharge la bibliothèque depuis le cache mis à jour
async function reloadLibraryFromCache() {
  console.log('[RELOAD] Reloading library from updated cache...')

  const [cachedTracks, cachedStats] = await invoke('load_tracks_from_cache')
  console.log('[RELOAD] Got from cache:', cachedTracks?.length || 0, 'tracks')

  if (cachedTracks) {
    // Reset et recharge
    tracks.length = 0
    for (const track of cachedTracks) {
      tracks.push(track)
    }
    console.log('[RELOAD] tracks.length after reload:', tracks.length)

    // Recharge les dates d'ajout
    const addedDates = await invoke('get_added_dates')
    trackAddedDates = addedDates || {}

    // Regroupe et affiche
    console.log('[RELOAD] Grouping tracks...')
    groupTracksIntoAlbumsAndArtists()
    buildTrackLookup()  // Index O(1) pour lookups par path
    console.log('[RELOAD] Albums:', Object.keys(albums).length, '| Artists:', Object.keys(artists).length)

    if (tracks.length > 0) {
      welcomeDiv.classList.add('hidden')
      console.log('[RELOAD] Displaying view:', currentView)
      displayCurrentView()
    } else {
      console.log('[RELOAD] ⚠️ No tracks after reload')
    }
  } else {
    console.log('[RELOAD] ⚠️ cachedTracks is null/undefined')
  }
}

// Écoute les événements de scan depuis Rust
async function initScanListeners() {
  // Progression du scan
  await listen('scan_progress', (event) => {
    const progress = event.payload
    updateIndexationProgress(progress)
  })

  // Fin du scan
  await listen('scan_complete', (event) => {
    const { stats, new_tracks, removed_tracks } = event.payload

    console.log(`Background scan complete: ${stats.total_tracks} tracks (${new_tracks} new, ${removed_tracks} removed)`)

    // Met à jour les stats
    updateIndexationStats(stats)

    // Affiche le toast
    showToast(`Indexing complete - ${stats.total_tracks} files`)

    // Recharge la bibliothèque si:
    // 1. Des changements ont été détectés (new_tracks > 0 ou removed_tracks > 0)
    // 2. OU si la bibliothèque locale est vide mais le scan a trouvé des tracks
    const shouldReload = new_tracks > 0 || removed_tracks > 0 || (tracks.length === 0 && stats.total_tracks > 0)
    if (shouldReload) {
      console.log(`Reloading library: new=${new_tracks}, removed=${removed_tracks}, local=${tracks.length}, scanned=${stats.total_tracks}`)
      invalidateDiscoveryMixCache()  // Invalide les mixes de découverte après un rescan
      reloadLibraryFromCache()
    }
  })

  // Enrichissement des genres via Deezer (arrière-plan post-scan)
  await listen('genre_enrichment_progress', (event) => {
    const { current, total, enriched } = event.payload
    console.log(`[Genre Enrichment] ${current}/${total} albums (${enriched} enriched)`)
  })

  await listen('genre_enrichment_complete', async (event) => {
    const { enriched_albums, total_albums } = event.payload
    console.log(`[Genre Enrichment] Complete: ${enriched_albums}/${total_albums} albums enriched`)

    if (enriched_albums > 0) {
      // Recharge les tracks avec les genres enrichis
      try {
        const [updatedTracks] = await invoke('load_tracks_from_cache')
        tracks.length = 0
        for (const t of updatedTracks) tracks.push(t)
        filteredTracks = [...tracks]
        groupTracksIntoAlbumsAndArtists()
        buildTrackLookup()

        // Invalide et régénère les mixes de découverte
        invalidateDiscoveryMixCache()

        // Refresh la home si on y est
        if (currentView === 'home') {
          displayHomeView()
        }

        showToast(`Genres enriched for ${enriched_albums} albums`)
      } catch (e) {
        console.error('[Genre Enrichment] Failed to reload tracks:', e)
      }
    }
  })

  // Chemins de bibliothèque inaccessibles (disque externe non monté, etc.)
  await listen('library_paths_inaccessible', (event) => {
    const paths = event.payload
    console.warn('[Library] Inaccessible paths:', paths)

    // Affiche un message d'avertissement persistant
    showInaccessiblePathsWarning(paths)
  })
}

// Affiche un avertissement pour les chemins inaccessibles
function showInaccessiblePathsWarning(paths) {
  // Retire l'ancien avertissement s'il existe
  const existingWarning = document.querySelector('.inaccessible-paths-warning')
  if (existingWarning) existingWarning.remove()

  // Crée le message d'avertissement
  const warning = document.createElement('div')
  warning.className = 'inaccessible-paths-warning'

  const pathsList = paths.map(p => {
    // Extrait le nom du volume ou du dossier pour un affichage plus lisible
    const parts = p.split('/')
    const volumeName = parts[2] || p  // /Volumes/NomDuVolume/...
    return volumeName
  }).join(', ')

  warning.innerHTML = `
    <div class="warning-icon">⚠️</div>
    <div class="warning-content">
      <div class="warning-title">Library unavailable</div>
      <div class="warning-message">
        Some folders in your library are not accessible: <strong>${escapeHtml(pathsList)}</strong>
        <br>Check that your external drive is connected.
      </div>
    </div>
    <button class="warning-close" title="Close">×</button>
  `

  // Ajoute le bouton de fermeture
  warning.querySelector('.warning-close').addEventListener('click', () => {
    warning.remove()
  })

  // Insère en bas, au-dessus du player (pour ne pas conflit avec les traffic lights macOS)
  const player = document.querySelector('.player')
  if (player) {
    player.insertAdjacentElement('beforebegin', warning)
  } else {
    document.body.appendChild(warning)
  }
}

// Toggle replié/déplié
if (btnToggleIndexation) {
  btnToggleIndexation.addEventListener('click', (e) => {
    e.stopPropagation()
    isIndexationExpanded = !isIndexationExpanded
    updateIndexationUI()
  })
}

// Clic sur le header (toggle aussi)
if (indexationHeader) {
  indexationHeader.addEventListener('click', (e) => {
    // Ne toggle pas si on clique sur un bouton
    if (e.target.closest('button')) return
    isIndexationExpanded = !isIndexationExpanded
    updateIndexationUI()
  })
}

// Boutons de refresh (replié et déplié)
if (refreshCollapsed) {
  refreshCollapsed.addEventListener('click', (e) => {
    e.stopPropagation()
    startBackgroundScan()
  })
}

// Bouton "Ajouter du contenu" ouvre le sélecteur de dossier
if (addContentBtn) {
  addContentBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    selectFolder()
  })
}

// Initialise les listeners de scan au démarrage
document.addEventListener('DOMContentLoaded', () => {
  initScanListeners()
  updateIndexationUI()  // État initial
})

// Au démarrage : charge depuis le cache puis scan en arrière-plan
async function init() {
  console.log('[INIT] Starting initialization...')

  // Initialise le cache en mémoire côté Rust (une seule fois)
  console.log('[INIT] Calling init_cache...')
  await invoke('init_cache')
  console.log('[INIT] init_cache completed')

  // Charge les favoris au démarrage (crée la playlist si nécessaire)
  await loadFavorites()

  const savedPaths = await invoke('get_library_paths')
  console.log('[INIT] Library paths:', savedPaths)

  if (savedPaths.length === 0) {
    console.log('[INIT] No library paths configured')
    // Pas de bibliothèque configurée - affiche les stats vides
    updateIndexationStats({ artists_count: 0, albums_count: 0, mp3_count: 0, flac_16bit_count: 0, flac_24bit_count: 0 })
    return
  }

  // === DÉMARRAGE INSTANTANÉ ===
  // 1. Charge depuis le cache (instantané)
  console.log('[INIT] Loading tracks from cache...')
  const [cachedTracks, cachedStats] = await invoke('load_tracks_from_cache')
  console.log('[INIT] Received from cache:', {
    tracksCount: cachedTracks?.length || 0,
    stats: cachedStats
  })

  if (cachedTracks && cachedTracks.length > 0) {
    // Affiche immédiatement les tracks depuis le cache
    console.log('[INIT] Populating tracks array...')
    for (const track of cachedTracks) {
      tracks.push(track)
    }
    console.log('[INIT] tracks.length after population:', tracks.length)

    // Charge les dates d'ajout
    const addedDates = await invoke('get_added_dates')
    trackAddedDates = addedDates || {}

    // Affiche la bibliothèque
    console.log('[INIT] Grouping tracks into albums and artists...')
    groupTracksIntoAlbumsAndArtists()
    buildTrackLookup()  // Index O(1) pour lookups par path
    console.log('[INIT] Albums count:', Object.keys(albums).length)
    console.log('[INIT] Artists count:', Object.keys(artists).length)

    welcomeDiv.classList.add('hidden')
    console.log('[INIT] Displaying current view:', currentView)
    displayCurrentView()

    // Affiche les stats du cache
    updateIndexationStats(cachedStats)

    console.log(`[INIT] ✅ Instant startup complete: ${cachedTracks.length} tracks loaded from cache`)
  } else {
    console.log('[INIT] ⚠️ No tracks in cache, will wait for background scan')
  }

  // 2. Lance le scan en arrière-plan pour détecter les changements
  console.log('[INIT] Starting background scan...')
  startBackgroundScan()
}

// Debug: log l'état de la bibliothèque
window.debugLibrary = function() {
  console.log('=== LIBRARY DEBUG ===')
  console.log('tracks.length:', tracks.length)
  console.log('albums count:', Object.keys(albums).length)
  console.log('artists count:', Object.keys(artists).length)
  console.log('currentView:', currentView)
  console.log('First 3 tracks:', tracks.slice(0, 3))
  console.log('First 3 album keys:', Object.keys(albums).slice(0, 3))
}

// Lance l'initialisation
init()

// Sauvegarde le cache avant de fermer l'application
window.addEventListener('beforeunload', () => {
  // Note: beforeunload n'attend pas les promesses async
  // On utilise un appel synchrone via invoke qui sera exécuté
  invoke('save_all_caches')
})

// Sauvegarde périodique du cache (toutes les 30 secondes)
setInterval(() => {
  invoke('save_all_caches')
}, 30000)

// Les deux boutons font la même chose
selectFolderBtn.addEventListener('click', selectFolder)
openFolderWelcomeBtn.addEventListener('click', selectFolder)

// === NAVIGATION MENU ===
navItems.forEach(item => {
  item.addEventListener('click', () => {
    // Met à jour l'état actif immédiatement (feedback visuel instantané)
    navItems.forEach(i => i.classList.remove('active'))
    item.classList.add('active')

    // Réinitialise le filtre artiste
    filteredArtist = null

    // Change la vue
    currentView = item.dataset.view

    // Affiche immédiatement un état vide puis charge le contenu
    // Cela évite le délai perçu avant le changement de vue
    requestAnimationFrame(() => {
      displayCurrentView()
    })
  })
})

// Affiche la vue courante (rapide car les métadonnées sont déjà en cache)
function displayCurrentView() {
  // Ferme le panel de détail album si ouvert
  closeAlbumDetail()

  // Nettoie l'observer de lazy loading pour éviter les fuites mémoire
  if (coverObserver) {
    coverObserver.disconnect()
  }

  // Transition fade-out rapide (100ms)
  albumsGridDiv.classList.add('view-transitioning')

  // Attend la fin du fade-out puis render le contenu
  setTimeout(() => {
    // Vide le contenu
    albumsGridDiv.textContent = ''
    albumsViewDiv.classList.remove('hidden')

    // Toggle la classe home-visible pour pauser les animations wave quand hors de la home
    albumsViewDiv.classList.toggle('home-visible', currentView === 'home')

    switch (currentView) {
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
        displayAlbumPage(currentAlbumPageKey)
        break
      case 'artist-page':
        displayArtistPage(currentArtistPageKey)
        break
      case 'mix-page':
        if (currentMixData) displayMixPage(currentMixData)
        break
    }

    // Fade-in après le render
    requestAnimationFrame(() => {
      albumsGridDiv.classList.remove('view-transitioning')
    })
  }, 80)  // 80ms pour le fade-out
}

// === HISTORIQUE DE NAVIGATION ===
let navigationHistory = []
let currentAlbumPageKey = null
let currentArtistPageKey = null
let currentMixData = null  // Mix de découverte en cours d'affichage

// === DISCOVERY MIX CACHE ===
const DISCOVERY_MIX_CACHE_KEY = 'discovery_mixes_cache'
const DISCOVERY_MIX_TTL = 24 * 60 * 60 * 1000  // 24h en ms
let discoveryMixes = []  // Mixes courants : [{ id, title, genre, decade, tracks, coverPath, trackCount }]

// Navigue vers la page dédiée d'un artiste
// === DISCOVERY MIX GENERATION ===

async function generateDiscoveryMixes() {
  // Vérifie le cache localStorage
  try {
    const cached = localStorage.getItem(DISCOVERY_MIX_CACHE_KEY)
    if (cached) {
      const parsed = JSON.parse(cached)
      if (parsed.timestamp && (Date.now() - parsed.timestamp < DISCOVERY_MIX_TTL)) {
        // Valide que les paths cachés existent encore dans la bibliothèque
        const pathSet = new Set(tracks.map(t => t.path))
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

  // Récupère tous les paths jamais écoutés depuis le backend
  let playedPathsSet
  try {
    const playedPaths = await invoke('get_all_played_paths')
    playedPathsSet = new Set(playedPaths || [])
  } catch (err) {
    console.error('[Discovery] Failed to get played paths:', err)
    playedPathsSet = new Set()
  }

  // Groupe les tracks non-écoutées par genre+décennie
  // Tracks sans genre → groupées par décennie seule avec label "Découverte"
  const genreDecadeMap = new Map()

  for (const track of tracks) {
    if (!track.metadata) continue
    if (playedPathsSet.has(track.path)) continue   // Skip tracks écoutées
    if (!track.metadata.year) continue               // Skip sans année

    const genre = track.metadata.genre || null
    const decade = Math.floor(track.metadata.year / 10) * 10  // 1994 → 1990

    // Tracks avec genre → genre+décennie, tracks sans genre → "Découverte"+décennie
    const key = genre ? `${genre}|${decade}` : `Discovery|${decade}`
    if (!genreDecadeMap.has(key)) {
      genreDecadeMap.set(key, [])
    }
    genreDecadeMap.get(key).push(track)
  }

  // Seuil : min 10 tracks ET au moins 3 artistes différents pour un vrai mix
  const MIN_TRACKS_PER_MIX = 10
  const MAX_TRACKS_PER_MIX = 50
  const MAX_TRACKS_PER_ARTIST = 3  // Diversité : max 3 tracks par artiste dans un mix
  const MIN_ARTISTS_PER_MIX = 3

  const eligibleCombos = []
  for (const [key, trackList] of genreDecadeMap) {
    if (trackList.length >= MIN_TRACKS_PER_MIX) {
      // Vérifie qu'il y a assez d'artistes distincts
      const uniqueArtists = new Set(trackList.map(t => t.metadata?.artist || ''))
      if (uniqueArtists.size >= MIN_ARTISTS_PER_MIX) {
        const [genre, decade] = key.split('|')
        eligibleCombos.push({ genre, decade: parseInt(decade), tracks: trackList })
      }
    }
  }

  if (eligibleCombos.length === 0) {
    discoveryMixes = []
    console.log(`[Discovery] No eligible genre+decade combos (need ≥${MIN_TRACKS_PER_MIX} tracks, ≥${MIN_ARTISTS_PER_MIX} artists)`)
    return discoveryMixes
  }

  // Shuffle et prend max 20
  const shuffled = eligibleCombos.sort(() => Math.random() - 0.5)
  const selected = shuffled.slice(0, 20)

  // Pour chaque combo, sélectionne des tracks avec diversité d'artistes
  discoveryMixes = selected.map((combo, index) => {
    // Diversification : limite max N tracks par artiste, mélange les artistes
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
    // Si pas assez après la limite, complète sans contrainte
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

    // Choisit une track aléatoire pour la cover
    const coverTrack = mixTracks[Math.floor(Math.random() * mixTracks.length)]

    // Label décennie : "90" pour 1990, "2000" pour 2000+
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

  // Sauvegarde dans localStorage
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

function invalidateDiscoveryMixCache() {
  localStorage.removeItem(DISCOVERY_MIX_CACHE_KEY)
  discoveryMixes = []
}

// === NAVIGATION ===

function navigateToArtistPage(artistKey) {
  if (!artistKey || !artists[artistKey]) return

  // Sauvegarde la vue actuelle dans l'historique
  navigationHistory.push({
    view: currentView,
    filteredArtist: filteredArtist,
    scrollPosition: document.querySelector('.albums-view')?.scrollTop || 0
  })

  currentArtistPageKey = artistKey
  currentView = 'artist-page'

  // Garde "Artistes" en surbrillance dans le menu
  navItems.forEach(i => i.classList.remove('active'))
  document.querySelector('[data-view="artists"]')?.classList.add('active')

  // Vide et prépare le conteneur
  closeAlbumDetail()
  if (coverObserver) coverObserver.disconnect()
  albumsGridDiv.textContent = ''
  albumsViewDiv.classList.remove('hidden')

  displayArtistPage(artistKey)
}

// Navigue vers la page dédiée d'un album
function navigateToAlbumPage(albumKey) {
  if (!albumKey || !albums[albumKey]) return

  // Sauvegarde la vue actuelle dans l'historique (inclut le contexte artiste si on vient de là)
  navigationHistory.push({
    view: currentView,
    filteredArtist: filteredArtist,
    scrollPosition: document.querySelector('.albums-view')?.scrollTop || 0,
    artistPageKey: currentArtistPageKey  // Préserve la page artiste pour le retour
  })

  currentAlbumPageKey = albumKey
  currentView = 'album-page'

  // Désactive tous les nav items car on est sur une page dédiée
  navItems.forEach(i => i.classList.remove('active'))

  // Vide et prépare le conteneur (navigation directe, pas via displayCurrentView)
  closeAlbumDetail()
  if (coverObserver) coverObserver.disconnect()
  albumsGridDiv.textContent = ''
  albumsViewDiv.classList.remove('hidden')

  displayAlbumPage(albumKey)
}

// Navigue vers la page d'un mix de découverte
function navigateToMixPage(mix) {
  if (!mix) return

  navigationHistory.push({
    view: currentView,
    filteredArtist: filteredArtist,
    scrollPosition: document.querySelector('.albums-view')?.scrollTop || 0,
    artistPageKey: currentArtistPageKey
  })

  currentMixData = mix
  currentView = 'mix-page'

  navItems.forEach(i => i.classList.remove('active'))

  closeAlbumDetail()
  if (coverObserver) coverObserver.disconnect()
  albumsGridDiv.textContent = ''
  albumsViewDiv.classList.remove('hidden')

  displayMixPage(mix)
}

// Affiche la page détail d'un mix de découverte
function displayMixPage(mix) {
  if (!mix) return

  const existingNav = document.querySelector('.alphabet-nav')
  if (existingNav) existingNav.remove()

  // Résout les objets track depuis les paths
  const mixTracks = mix.tracks
    .map(path => tracks.find(t => t.path === path))
    .filter(Boolean)

  if (mixTracks.length === 0) return

  const totalDuration = mixTracks.reduce((acc, t) => acc + (t.metadata?.duration || 0), 0)
  const cover = coverCache.get(mix.coverPath) || thumbnailCache.get(mix.coverPath)

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
          : '<div class="album-cover-placeholder">♪</div>'
        }
        <div class="mix-page-cover-overlay">
          <span class="mix-page-title-overlay">${escapeHtml(mix.title)}</span>
        </div>
      </div>
      <div class="album-page-info">
        <p class="album-page-artist">${escapeHtml(mix.genre)} — ${mix.decadeLabel}</p>
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

  // Bouton retour
  pageContainer.querySelector('.btn-back-nav').addEventListener('click', navigateBack)

  // Bouton Lecture
  pageContainer.querySelector('.play-mix-btn').addEventListener('click', () => {
    playMixTracks(mixTracks)
  })

  // Bouton Ajouter à la file
  pageContainer.querySelector('.add-mix-queue-btn').addEventListener('click', () => {
    for (const track of mixTracks) {
      addToQueue(track)
    }
    showToast(`${mix.title} added to queue`)
  })

  // Liste des tracks
  const tracksContainer = pageContainer.querySelector('.mix-page-tracks')

  mixTracks.forEach((track, idx) => {
    const trackItem = document.createElement('div')
    trackItem.className = 'album-track-item'
    trackItem.dataset.trackPath = track.path

    const duration = track.metadata?.duration ? formatTime(track.metadata.duration) : '-'
    const trackArtist = track.metadata?.artist || 'Unknown Artist'
    const trackTitle = track.metadata?.title || track.name

    trackItem.innerHTML = `
      ${getFavoriteButtonHtml(track.path)}
      <span class="track-number">${idx + 1}</span>
      <div class="track-info">
        <span class="track-title">${escapeHtml(trackTitle)}</span>
        <span class="track-artist">${escapeHtml(trackArtist)}</span>
      </div>
      <span class="track-duration">${duration}</span>
    `

    trackItem.addEventListener('click', (e) => {
      if (e.target.closest('.favorite-btn')) return
      const globalIndex = tracks.findIndex(t => t.path === track.path)
      if (globalIndex !== -1) playTrack(globalIndex)
    })

    trackItem.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      const globalIndex = tracks.findIndex(t => t.path === track.path)
      if (globalIndex !== -1) showContextMenu(e, track, globalIndex)
    })

    tracksContainer.appendChild(trackItem)
  })

  // Charge la cover si pas en cache
  if (!isValidImageSrc(cover) && mix.coverPath) {
    const pageImg = pageContainer.querySelector('.mix-page-cover-blurred')
    if (pageImg) {
      loadThumbnailAsync(mix.coverPath, pageImg, '', '').catch(() => {})
    }
  }

  albumsGridDiv.appendChild(pageContainer)
}

// Joue un mix : lance la première track et ajoute le reste à la queue
function playMixTracks(mixTracks) {
  if (!mixTracks || mixTracks.length === 0) return
  const firstTrack = mixTracks[0]
  const globalIndex = tracks.findIndex(t => t.path === firstTrack.path)
  if (globalIndex !== -1) {
    // Ajoute les tracks restantes à la queue
    for (let i = 1; i < mixTracks.length; i++) {
      addToQueue(mixTracks[i])
    }
    playTrack(globalIndex)
  }
}

// Retour arrière dans l'historique
function navigateBack() {
  if (navigationHistory.length === 0) {
    // Par défaut, retour à home
    currentView = 'home'
    navItems.forEach(i => i.classList.remove('active'))
    document.querySelector('[data-view="home"]')?.classList.add('active')
    displayCurrentView()
    return
  }

  const previous = navigationHistory.pop()
  currentView = previous.view
  filteredArtist = previous.filteredArtist

  // Restaure les clés de page selon le type de vue
  if (previous.view === 'artist-page' && previous.artistPageKey) {
    currentArtistPageKey = previous.artistPageKey
    currentAlbumPageKey = null
  } else {
    currentAlbumPageKey = null
    currentArtistPageKey = null
  }

  // Restaure le nav item actif
  navItems.forEach(i => i.classList.remove('active'))
  const activeNav = document.querySelector(`[data-view="${currentView}"]`)
  if (activeNav) activeNav.classList.add('active')

  displayCurrentView()

  // Restaure la position de scroll
  if (previous.scrollPosition) {
    setTimeout(() => {
      const albumsView = document.querySelector('.albums-view')
      if (albumsView) albumsView.scrollTop = previous.scrollPosition
    }, 50)
  }
}

// Affiche la page dédiée d'un album
function displayAlbumPage(albumKey) {
  const album = albums[albumKey]
  if (!album) return

  // Supprime la scrollbar alphabétique sur la page album
  const existingNav = document.querySelector('.alphabet-nav')
  if (existingNav) existingNav.remove()

  // Note: albumsGridDiv est déjà vidé par displayCurrentView() ou navigateToAlbumPage()

  // Récupère la pochette depuis le cache (vérifie les deux caches)
  const cover = coverCache.get(album.coverPath) || thumbnailCache.get(album.coverPath)

  // Nombre de tracks et durée totale
  const totalDuration = album.tracks.reduce((acc, t) => acc + (t.metadata?.duration || 0), 0)

  // Qualité de l'album
  const firstTrack = album.tracks[0]
  const quality = formatQuality(firstTrack?.metadata, firstTrack?.path)

  const qualityTag = quality.label && quality.label !== '-'
    ? `<span class="quality-tag ${quality.class}">${quality.label}</span>`
    : ''

  // Container de la page
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
          : '<div class="album-cover-placeholder">♪</div>'
        }
      </div>
      <div class="album-page-info">
        <p class="album-page-artist clickable-artist" data-artist="${escapeHtml(album.artist)}">${escapeHtml(album.artist)}</p>
        <p class="album-page-meta">
          ${album.tracks.length} titres • ${formatTime(totalDuration)}
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

  // Event listener pour le bouton retour
  pageContainer.querySelector('.btn-back-nav').addEventListener('click', navigateBack)

  // Event listener pour le nom de l'artiste (navigation vers page artiste)
  const artistLink = pageContainer.querySelector('.album-page-artist.clickable-artist')
  if (artistLink && artists[album.artist]) {
    artistLink.addEventListener('click', () => {
      navigateToArtistPage(album.artist)
    })
  }

  // Event listener pour lecture album
  pageContainer.querySelector('.play-album-btn').addEventListener('click', () => {
    playAlbum(albumKey)
  })

  // Event listener pour ajouter à la queue
  pageContainer.querySelector('.add-album-queue-btn').addEventListener('click', () => {
    addAlbumToQueue(albumKey)
    showQueueNotification(`Album "${album.album}" added to queue`)
  })

  // Liste des tracks
  const tracksContainer = pageContainer.querySelector('.album-page-tracks')

  // Détecte si l'album est multi-artiste
  const uniqueArtists = new Set(album.tracks.map(t => t.metadata?.artist || album.artist))
  const isMultiArtist = uniqueArtists.size > 1

  // Détecte si l'album est multi-disc (CD1, CD2, etc.)
  const uniqueDiscs = new Set(album.tracks.map(t => t.metadata?.disc || 1))
  const isMultiDisc = uniqueDiscs.size > 1
  let currentDiscNumber = null

  album.tracks.forEach((track, idx) => {
    // Insère un séparateur de disc si le disc change
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
      ${getFavoriteButtonHtml(track.path)}
      <span class="track-number">${track.metadata?.track || (idx + 1)}</span>
      ${isMultiArtist
        ? `<div class="track-info">
            <span class="track-title">${track.metadata?.title || track.name}</span>
            <span class="track-artist">${trackArtist}</span>
          </div>`
        : `<span class="track-title">${track.metadata?.title || track.name}</span>`
      }
      <button class="track-add-queue${queue.some(q => q.path === track.path) ? ' in-queue' : ''}" title="Add to queue">
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

    // Double-clic pour jouer
    trackItem.addEventListener('dblclick', () => {
      const globalIndex = tracks.findIndex(t => t.path === track.path)
      if (globalIndex !== -1) {
        currentPlayingAlbumKey = albumKey
        playTrack(globalIndex)
      }
    })

    // Bouton ajouter à la queue
    trackItem.querySelector('.track-add-queue').addEventListener('click', (e) => {
      e.stopPropagation()
      addToQueue(track)
      showQueueNotification(`"${track.metadata?.title || track.name}" added to queue`)
      trackItem.querySelector('.track-add-queue').classList.add('in-queue')
    })

    // Bouton ajouter à une playlist
    trackItem.querySelector('.track-add-playlist').addEventListener('click', (e) => {
      e.stopPropagation()
      showAddToPlaylistMenu(e, track)
    })

    // Bouton favori
    const favBtn = trackItem.querySelector('.track-favorite-btn')
    if (favBtn) {
      favBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        toggleFavorite(track.path, favBtn)
      })
    }

    // Prépare le drag
    trackItem.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return
      prepareCustomDrag(e, track, trackItem)
    })

    // Menu contextuel (clic droit)
    trackItem.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      const globalIndex = tracks.findIndex(t => t.path === track.path)
      showContextMenu(e, track, globalIndex)
    })

    tracksContainer.appendChild(trackItem)
  })

  albumsGridDiv.appendChild(pageContainer)

  // Chargement async du cover si pas en cache — utilise invoke('get_cover') directement
  if (!isValidImageSrc(cover) && album.coverPath) {
    // Utilise loadThumbnailAsync qui est le chemin le plus robuste
    // (essaie thumbnail, puis cover, puis internet)
    const albumPageCoverContainer = pageContainer.querySelector('.album-page-cover')
    if (albumPageCoverContainer) {
      const hiddenImg = document.createElement('img')
      hiddenImg.style.display = 'none'
      albumPageCoverContainer.appendChild(hiddenImg)

      loadThumbnailAsync(album.coverPath, hiddenImg).then(() => {
        const cachedSrc = coverCache.get(album.coverPath) || thumbnailCache.get(album.coverPath)
        if (isValidImageSrc(cachedSrc) && albumPageCoverContainer) {
          const placeholder = albumPageCoverContainer.querySelector('.album-cover-placeholder')
          if (placeholder) {
            const newImg = document.createElement('img')
            newImg.src = cachedSrc
            newImg.alt = album.album
            placeholder.replaceWith(newImg)
          }
          // Nettoie l'img cachée
          if (hiddenImg.parentNode) hiddenImg.remove()
        }
      })
    }
  }

  // Force scroll en haut - l'utilisateur doit voir l'artwork immédiatement
  const albumsView = document.querySelector('.albums-view')
  if (albumsView) albumsView.scrollTop = 0
}

// === NAVIGATION PROGRAMMATIQUE avec transition fluide ===
function switchView(view) {
  if (!['home', 'albums', 'artists', 'tracks'].includes(view)) return

  // Met à jour la nav active
  navItems.forEach(item => {
    item.classList.toggle('active', item.dataset.view === view)
  })

  // Transition fluide : fade out puis fade in
  const mainContent = document.querySelector('.main-content')
  mainContent.style.opacity = '0.5'
  mainContent.style.transition = 'opacity 0.15s ease'

  setTimeout(() => {
    currentView = view
    displayCurrentView()

    // Fade in
    mainContent.style.opacity = '1'
  }, 100)
}

// === RECHERCHE AVEC PANEL DE RÉSULTATS ===
let searchDebounceTimer = null

searchInput.addEventListener('input', (e) => {
  const query = e.target.value.trim()
  searchQuery = query.toLowerCase()

  // Debounce : attend 200ms après la dernière frappe (optimisation pour grosses bibliothèques)
  clearTimeout(searchDebounceTimer)
  searchDebounceTimer = setTimeout(() => {
    updateSearchResultsPanel(query)

    // Si on est sur la vue "tracks", rafraîchit la liste filtrée (sans reconstruire le DOM)
    if (currentView === 'tracks') {
      updateTracksFilter()
    }
  }, 200)
})

// Ferme le panel si on clique ailleurs
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-bar-inner')) {
    closeSearchPanel()
  }
})

// Focus sur l'input : réouvre le panel si y'a une recherche
searchInput.addEventListener('focus', () => {
  if (searchInput.value.trim().length > 0) {
    updateSearchResultsPanel(searchInput.value.trim())
  }
})

// Échap ferme le panel
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeSearchPanel()
    searchInput.blur()
  }
})

function closeSearchPanel() {
  searchResultsPanel.classList.add('hidden')
}

// === RACCOURCIS CLAVIER GLOBAUX ===
document.addEventListener('keydown', (e) => {
  // Ignore si on est dans un champ de saisie
  const isInputFocused = document.activeElement.tagName === 'INPUT' ||
                         document.activeElement.tagName === 'TEXTAREA'

  // Tab : ouvrir la recherche (toujours actif)
  if (e.key === 'Tab' && !isInputFocused) {
    e.preventDefault()
    searchInput.focus()
    return
  }

  // Les autres raccourcis ne fonctionnent pas si on est dans un input
  if (isInputFocused) return

  switch (e.key) {
    // Note: Space est géré dans initLocalKeyboardShortcuts() avec togglePlay()

    case 'ArrowLeft': // Flèche gauche : Track précédente ou restart
      e.preventDefault()
      // Si > 3 secondes dans la chanson, restart. Sinon, track précédente
      const currentPosition = audioPositionFromRust > 0 ? audioPositionFromRust : 0
      if (currentPosition > 3) {
        invoke('audio_seek', { time: 0.0 }).catch((e) => {
          console.error('audio_seek error:', e)
        })
      } else if (currentTrackIndex > 0) {
        playTrack(currentTrackIndex - 1)
      }
      break

    case 'ArrowRight': // Flèche droite : Track suivante
      e.preventDefault()
      playNextTrack()
      break

    case 'Backspace': // Backspace : Supprimer les tracks sélectionnées
    case 'Delete':
      e.preventDefault()
      const { selectedTrackPaths } = virtualScrollState
      if (selectedTrackPaths.size > 0 && currentView === 'tracks') {
        const tracksToDelete = tracks.filter(t => selectedTrackPaths.has(t.path))
        if (tracksToDelete.length > 0) {
          removeTracksFromLibrary(tracksToDelete)
        }
      }
      break

    case 'Enter': // Enter : Lire la/les track(s) sélectionnée(s)
      e.preventDefault()
      const { selectedTrackPaths: selected } = virtualScrollState
      if (selected.size > 0 && currentView === 'tracks') {
        const selectedTracks = tracks.filter(t => selected.has(t.path))
        if (selectedTracks.length > 0) {
          // Joue le premier
          const firstIdx = tracks.findIndex(t => t.path === selectedTracks[0].path)
          if (firstIdx !== -1) playTrack(firstIdx)
          // Ajoute les autres à la queue
          for (let i = 1; i < selectedTracks.length; i++) {
            addToQueue(selectedTracks[i])
          }
        }
      }
      break
  }
})

function updateSearchResultsPanel(query) {
  const content = searchResultsPanel.querySelector('.search-results-content')

  // Si pas de query, ferme le panel
  if (!query || query.length < 1) {
    closeSearchPanel()
    return
  }

  const q = query.toLowerCase()
  const results = { artists: [], albums: [], tracks: [] }
  const maxResults = 10 // Max par catégorie

  // Recherche dans les artistes
  for (const artistName of Object.keys(artists)) {
    if (artistName.toLowerCase().includes(q)) {
      const artist = artists[artistName]
      // Trouve un album pour l'image
      const firstAlbumKey = artist.albums?.[0]
      const sampleAlbum = firstAlbumKey ? albums[firstAlbumKey] : null
      results.artists.push({
        name: artistName,
        albumCount: artist.albums?.length || 0,
        coverPath: sampleAlbum?.coverPath || null
      })
      if (results.artists.length >= maxResults) break
    }
  }

  // Recherche dans les albums
  for (const [albumKey, album] of Object.entries(albums)) {
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

  // Recherche dans les tracks — multi-mots, title + artist + album, scoring
  const queryWords = q.split(/\s+/).filter(w => w.length >= 1)
  const scoredTracks = []

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i]
    const title = (track.metadata?.title || track.name).toLowerCase()
    const trackArtist = (track.metadata?.artist || '').toLowerCase()
    const trackAlbum = (track.metadata?.album || '').toLowerCase()
    const fullText = title + ' ' + trackArtist + ' ' + trackAlbum

    // Chaque mot de la query doit matcher quelque part (AND logic)
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

      // Scoring: titre pèse plus, début de mot > milieu
      if (inTitle) {
        if (title === qw) score += 100              // titre exact
        else if (title.startsWith(qw)) score += 60  // début du titre
        else {
          // Vérifie si c'est un début de mot dans le titre
          const titleWords = title.split(/[\s\-_.,;:!?'"()\[\]{}]+/)
          if (titleWords.some(w => w === qw)) score += 50       // mot exact dans titre
          else if (titleWords.some(w => w.startsWith(qw))) score += 40 // début de mot
          else score += 20  // substring quelconque dans titre
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
      const albumObj = albums[track.metadata?.album || '']
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

  // Trie par score décroissant, prend les N premiers
  scoredTracks.sort((a, b) => b.score - a.score)
  results.tracks = scoredTracks.slice(0, maxResults)

  // Si aucun résultat
  if (results.artists.length === 0 && results.albums.length === 0 && results.tracks.length === 0) {
    content.innerHTML = `<div class="search-no-results">No results for "${escapeHtml(query)}"</div>`
    searchResultsPanel.classList.remove('hidden')
    return
  }

  // Construit le HTML
  let html = ''

  // Section Artistes
  if (results.artists.length > 0) {
    html += `<div class="search-section">
      <div class="search-section-title">Artists</div>`
    for (const artist of results.artists) {
      html += `
        <div class="search-result-item" data-type="artist" data-artist="${escapeHtml(artist.name)}">
          <div class="search-result-cover artist" data-cover-path="${escapeHtml(artist.coverPath || '')}">
            <span>👤</span>
          </div>
          <div class="search-result-info">
            <div class="search-result-title">${escapeHtml(artist.name)}</div>
            <div class="search-result-subtitle">${artist.albumCount} album${artist.albumCount > 1 ? 's' : ''}</div>
          </div>
        </div>`
    }
    html += '</div>'
  }

  // Section Albums
  if (results.albums.length > 0) {
    html += `<div class="search-section">
      <div class="search-section-title">Albums</div>`
    for (const album of results.albums) {
      html += `
        <div class="search-result-item" data-type="album" data-album-key="${escapeHtml(album.key)}">
          <div class="search-result-cover" data-cover-path="${escapeHtml(album.coverPath || '')}">
            <span>♪</span>
          </div>
          <div class="search-result-info">
            <div class="search-result-title">${escapeHtml(album.title)}</div>
            <div class="search-result-subtitle">${escapeHtml(album.artist)}</div>
          </div>
        </div>`
    }
    html += '</div>'
  }

  // Section Titres
  if (results.tracks.length > 0) {
    html += `<div class="search-section">
      <div class="search-section-title">Tracks</div>`
    for (const track of results.tracks) {
      html += `
        <div class="search-result-item" data-type="track" data-track-index="${track.index}">
          <div class="search-result-cover" data-cover-path="${escapeHtml(track.coverPath || '')}">
            <span>♪</span>
          </div>
          <div class="search-result-info">
            <div class="search-result-title">${escapeHtml(track.title)}</div>
            <div class="search-result-subtitle">${escapeHtml(track.artist)} · ${escapeHtml(track.album)}</div>
          </div>
        </div>`
    }
    html += '</div>'
  }

  content.innerHTML = html
  searchResultsPanel.classList.remove('hidden')

  // Charge les pochettes pour les résultats
  loadSearchResultCovers()

  // Ajoute les événements de clic
  content.querySelectorAll('.search-result-item').forEach(item => {
    item.addEventListener('click', () => handleSearchResultClick(item))
  })
}

function loadSearchResultCovers() {
  const covers = searchResultsPanel.querySelectorAll('.search-result-cover[data-cover-path]')

  covers.forEach(coverDiv => {
    const path = coverDiv.dataset.coverPath
    if (!path) return

    const placeholder = coverDiv.querySelector('span')

    // Check cache d'abord
    const cached = coverCache.get(path)
    if (isValidImageSrc(cached)) {
      coverDiv.innerHTML = `<img src="${cached}" alt="">`
      return
    }

    // Charge async
    invoke('get_cover', { path }).then(cover => {
      if (isValidImageSrc(cover)) {
        coverCache.set(path, cover)
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
  searchInput.value = ''
  searchQuery = ''

  if (type === 'artist') {
    const artistName = item.dataset.artist
    // Navigue vers la page artiste dédiée (avec photo, stats, albums)
    navigateToArtistPage(artistName)
  } else if (type === 'album') {
    const albumKey = item.dataset.albumKey
    const album = albums[albumKey]
    if (album) {
      // Navigue vers albums et ouvre le détail
      openAlbumFromHome(albumKey, album)
    }
  } else if (type === 'track') {
    const trackIndex = parseInt(item.dataset.trackIndex, 10)
    if (!isNaN(trackIndex) && trackIndex >= 0) {
      playTrack(trackIndex)
    }
  }
}

// === CHARGEMENT ASYNCHRONE DES POCHETTES ===
async function loadCoverAsync(path, imgElement, artist = null, album = null) {
  // Vérifications de sécurité
  if (!path || !imgElement) return

  // Vérifie le cache d'abord
  if (coverCache.has(path)) {
    const cover = coverCache.get(path)
    if (isValidImageSrc(cover) && imgElement.isConnected) {
      imgElement.src = cover
      imgElement.style.display = 'block'
    }
    return
  }

  try {
    // 1. Essaie d'abord la pochette embarquée dans le fichier
    let cover = await invoke('get_cover', { path })

    // 2. Si pas de pochette embarquée, cherche sur Internet
    if (!cover && artist && album) {
      cover = await invoke('fetch_internet_cover', { artist, album })
    }

    coverCache.set(path, cover) // Met en cache même si null

    // Vérifie que l'élément est toujours dans le DOM avant de modifier
    if (isValidImageSrc(cover) && imgElement.isConnected) {
      imgElement.src = cover
      imgElement.style.display = 'block'
    }
  } catch (e) {
    console.error('Erreur cover:', path, e)
    coverCache.set(path, null)
  }
}

// === CHARGEMENT ASYNCHRONE DES THUMBNAILS (VERSION OPTIMISÉE NON-BLOQUANTE) ===
// Stratégie:
// 1. Check cache mémoire JS (instantané)
// 2. Check cache disque Rust via get_cover_thumbnail (rapide, lecture seule)
// 3. Si pas de thumbnail: utiliser get_cover comme fallback (bloquant mais rare après première génération)
// 4. Génération batch en arrière-plan après le scan

// === SYSTÈME DE QUEUE À CONCURRENCE LIMITÉE ===
// Pour éviter de saturer le NAS avec 100 requêtes simultanées
const MAX_CONCURRENT_LOADS = 5  // Maximum 5 chargements en parallèle
let activeLoads = 0
const loadQueue = []

// File d'attente pour la génération batch en arrière-plan
let thumbnailGenerationQueue = []
let thumbnailGenerationRunning = false

// Fonction principale - ajoute à la queue au lieu de charger directement
// Retourne une Promise pour compatibilité avec les appels .then()
function loadThumbnailAsync(path, imgElement, artist = null, album = null) {
  return new Promise((resolve) => {
    // Vérifications de sécurité
    if (!path || !imgElement) {
      resolve()
      return
    }

    PERF.thumbnailCalls++

    // 1. Cache mémoire JS (instantané) - pas besoin de queue
    if (thumbnailCache.has(path)) {
      PERF.thumbnailCacheHits++
      const thumb = thumbnailCache.get(path)
      if (isValidImageSrc(thumb)) {
        imgElement.src = thumb
        imgElement.style.display = 'block'
      }
      resolve()
      return
    }

    PERF.thumbnailCacheMisses++

    // Ajouter à la queue avec callback de résolution
    loadQueue.push({ path, imgElement, artist, album, startTime: performance.now(), resolve })

    // Démarrer le traitement si possible
    processLoadQueue()
  })
}

// Traite la queue avec concurrence limitée
async function processLoadQueue() {
  while (loadQueue.length > 0 && activeLoads < MAX_CONCURRENT_LOADS) {
    const item = loadQueue.shift()
    if (!item) continue

    activeLoads++

    // Dispatch vers le bon handler selon le type
    const handler = item.type === 'artist'
      ? loadArtistImageFromQueue(item)
      : loadThumbnailFromQueue(item)

    handler.finally(() => {
      activeLoads--
      // Continue avec le suivant
      processLoadQueue()
    })
  }
}

// Charge un thumbnail depuis la queue
async function loadThumbnailFromQueue(item) {
  const { path, imgElement, artist, album, startTime, resolve } = item

  // Vérifie que l'élément est toujours dans le DOM
  if (!imgElement.isConnected) {
    if (resolve) resolve()
    return
  }

  try {
    // 2. Check thumbnail sur disque
    const thumbStart = performance.now()
    let thumb = await invoke('get_cover_thumbnail', { path })
    const thumbTime = performance.now() - thumbStart

    if (isValidImageSrc(thumb)) {
      // Thumbnail trouvé sur disque!
      thumbnailCache.set(path, thumb)
      coverCache.set(path, thumb) // Sync pour album page, detail panel, info panel
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

    // 3. Pas de thumbnail -> utiliser cover complète comme fallback
    PERF.coverFallbacks++

    // Ajouter à la queue de génération (pour fichiers AVEC cover)
    if (!thumbnailGenerationQueue.includes(path)) {
      thumbnailGenerationQueue.push(path)
      // Déclenche le traitement si pas déjà en cours
      if (!thumbnailGenerationRunning) {
        setTimeout(processThumnailGenerationQueue, 100)
      }
    }

    // Charge la cover complète pour affichage immédiat
    const coverStart = performance.now()
    let cover = await invoke('get_cover', { path })
    const coverTime = performance.now() - coverStart

    if (isValidImageSrc(cover)) {
      // Cover trouvée dans le fichier!
      thumbnailCache.set(path, cover)
      coverCache.set(path, cover) // Sync pour album page, detail panel, info panel
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

    // PAS de cover locale -> marquer comme "pending Internet" et NE PAS BLOQUER
    thumbnailCache.set(path, null)

    // Ajouter à la queue Internet si on a artist+album
    if (artist && album) {
      PERF.internetFallbacks++
      queueInternetCoverFetch(path, artist, album, imgElement)
    }

    const totalTime = performance.now() - startTime
    PERF.totalLoadTime += totalTime
  } catch (e) {
    console.error('[PERF] Error loading thumbnail:', path, e)
    thumbnailCache.set(path, null)
  }

  if (resolve) resolve()
}

// Génère les thumbnails manquants en arrière-plan (appelé périodiquement)
async function processThumnailGenerationQueue() {
  if (thumbnailGenerationRunning || thumbnailGenerationQueue.length === 0) return

  thumbnailGenerationRunning = true

  // Prend un batch de 20 images à la fois
  const batch = thumbnailGenerationQueue.splice(0, 20)

  if (batch.length > 0) {
    console.log(`[THUMBNAIL] Generating ${batch.length} thumbnails in background...`)
    try {
      const generated = await invoke('generate_thumbnails_batch', { paths: batch })
      console.log(`[THUMBNAIL] Generated ${generated} thumbnails`)

      // Invalide le cache mémoire pour les images générées
      // (elles seront rechargées en thumbnail au prochain affichage)
      for (const path of batch) {
        thumbnailCache.delete(path)
      }
    } catch (e) {
      console.error('[THUMBNAIL] Batch generation error:', e)
    }
  }

  thumbnailGenerationRunning = false

  // Continue si queue pas vide (auto-chaînage)
  if (thumbnailGenerationQueue.length > 0) {
    setTimeout(processThumnailGenerationQueue, 100) // Petite pause entre les batches
  }
}

// Note: Plus de setInterval ! Le traitement se lance automatiquement quand on ajoute à la queue
// et se chaîne via setTimeout tant qu'il reste des items

// === QUEUE POUR FETCH INTERNET NON-BLOQUANT ===
// Charge les covers depuis Internet en arrière-plan (ne bloque pas l'UI)
const internetCoverQueue = []
let internetFetchRunning = false

function queueInternetCoverFetch(path, artist, album, imgElement) {
  // Évite les doublons
  if (internetCoverQueue.find(q => q.path === path)) return

  internetCoverQueue.push({ path, artist, album, imgElement })

  // Lance le traitement si pas déjà en cours
  if (!internetFetchRunning) {
    processInternetCoverQueue()
  }
}

async function processInternetCoverQueue() {
  if (internetFetchRunning || internetCoverQueue.length === 0) return

  internetFetchRunning = true

  // Traite un item à la fois (évite de surcharger le réseau)
  const item = internetCoverQueue.shift()
  if (!item) {
    internetFetchRunning = false
    return
  }

  try {
    const cover = await invoke('fetch_internet_cover', { artist: item.artist, album: item.album })

    if (isValidImageSrc(cover)) {
      // Met en cache et affiche si l'élément est toujours visible
      thumbnailCache.set(item.path, cover)
      if (item.imgElement && item.imgElement.isConnected) {
        item.imgElement.src = cover
        item.imgElement.style.display = 'block'
        // Cache le placeholder
        const placeholder = item.imgElement.nextElementSibling || item.imgElement.parentElement?.querySelector('.carousel-cover-placeholder, .album-cover-placeholder')
        if (placeholder) placeholder.style.display = 'none'
      }
    }
  } catch (e) {
    console.error('[INTERNET] Error fetching cover:', item.artist, item.album, e)
  }

  internetFetchRunning = false

  // Continue avec le prochain
  if (internetCoverQueue.length > 0) {
    // Petit délai pour éviter de surcharger
    setTimeout(processInternetCoverQueue, 100)
  }
}

// Cache séparé pour les images d'artistes
const artistImageCache = new Map()

// Queue pour les images d'artistes (utilise la même limite de concurrence)
const artistLoadQueue = []

// === CHARGEMENT ASYNCHRONE DES IMAGES D'ARTISTES ===
// Utilise une queue à concurrence limitée comme les thumbnails
function loadArtistImageAsync(artistName, imgElement, fallbackAlbum = null, fallbackCoverPath = null) {
  return new Promise((resolve) => {
    const cacheKey = `artist:${artistName}`

    // Vérifie le cache mémoire d'abord (instantané)
    if (artistImageCache.has(cacheKey)) {
      const image = artistImageCache.get(cacheKey)
      if (isValidImageSrc(image)) {
        imgElement.src = image
        imgElement.style.display = 'block'
      }
      resolve()
      return
    }

    // Ajouter à la queue partagée avec les thumbnails
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

    // Démarrer le traitement
    processLoadQueue()
  })
}

// Charge une image d'artiste depuis la queue
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

// === AFFICHAGE DE LA PAGE HOME ===
// escapeHtml → importé depuis utils.js

async function displayHomeView() {
  // Note: albumsGridDiv est déjà vidé par displayCurrentView()
  // albumsViewDiv.classList.remove('hidden') aussi
  albumsGridDiv.classList.remove('tracks-mode')  // Retire le mode tracks

  // Supprime la scrollbar alphabétique si présente
  const existingNav = document.querySelector('.alphabet-nav')
  if (existingNav) existingNav.remove()

  // Utilise le cache si valide (évite les appels backend répétés)
  const now = Date.now()
  const cacheValid = homeDataCache.isValid && (now - homeDataCache.lastFetch < HOME_CACHE_TTL)

  let lastPlayed, recentTracks, allPlayedAlbums, topArtists

  if (cacheValid) {
    // Utilise les données en cache (navigation instantanée)
    lastPlayed = homeDataCache.lastPlayed
    recentTracks = homeDataCache.recentTracks
    allPlayedAlbums = homeDataCache.allPlayedAlbums
    topArtists = homeDataCache.topArtists
  } else {
    // Charge les données depuis le backend
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

      // Met en cache
      homeDataCache = {
        lastPlayed,
        recentTracks,
        allPlayedAlbums,
        topArtists,
        lastFetch: now,
        isValid: true
      }
    } catch (err) {
      console.error('Erreur chargement historique:', err)
      lastPlayed = null
      recentTracks = []
      allPlayedAlbums = []
      topArtists = []
    }
  }

  // Génère les mixes de découverte (utilise le cache si valide)
  await generateDiscoveryMixes()

  const homeContainer = document.createElement('div')
  homeContainer.className = 'home-container'

  // === 1. Tuile "Lecture en cours" ou "Reprendre la lecture" ===
  // Si une piste est en cours de lecture, on affiche "Lecture en cours" avec les specs
  // Sinon, on affiche "Reprendre la lecture" avec la dernière piste jouée
  const isCurrentlyPlaying = audioIsPlaying && currentTrackIndex >= 0
  const currentTrack = isCurrentlyPlaying ? tracks[currentTrackIndex] : null
  const displayTrack = currentTrack || (lastPlayed && lastPlayed.path ? lastPlayed : null)

  if (displayTrack) {
    const resumeSection = document.createElement('section')
    resumeSection.className = 'home-section home-resume-section'
    resumeSection.id = 'home-now-playing-section'

    const resumeTile = document.createElement('div')
    resumeTile.className = 'home-resume-tile'
    resumeTile.dataset.trackPath = displayTrack.path

    // Détermine le titre, l'artiste, l'album et les specs
    const title = currentTrack?.metadata?.title || currentTrack?.name || displayTrack.title || 'Titre inconnu'
    const artist = currentTrack?.metadata?.artist || displayTrack.artist || 'Unknown Artist'
    const album = currentTrack?.metadata?.album || displayTrack.album || ''
    const label = isCurrentlyPlaying ? 'Now Playing' : 'Resume Playback'

    // Specs techniques : bit depth et sample rate en tags colorés, codec et durée en texte
    let specsTagsHtml = ''
    if (currentTrack?.metadata) {
      const meta = currentTrack.metadata
      const codec = meta.codec || getCodecFromPath(currentTrack.path)
      const bitDepth = meta.bitDepth ? `${meta.bitDepth}-bit` : ''
      const sampleRate = meta.sampleRate ? `${(meta.sampleRate / 1000).toFixed(1).replace('.0', '')}kHz` : ''
      const duration = meta.duration ? formatTime(meta.duration) : ''

      // Tags colorés uniquement pour bit depth et sample rate
      const tags = []
      if (bitDepth) tags.push(`<span class="resume-spec-tag bitdepth">${bitDepth}</span>`)
      if (sampleRate) tags.push(`<span class="resume-spec-tag samplerate">${sampleRate}</span>`)

      // Texte pour codec et durée
      const textParts = []
      if (codec) textParts.push(codec.toUpperCase())
      if (duration) textParts.push(duration)
      const textSpecs = textParts.length > 0 ? `<span class="resume-specs-text">${textParts.join(' • ')}</span>` : ''

      if (tags.length > 0 || textSpecs) {
        specsTagsHtml = `<div class="resume-specs-container">${tags.join('')}${textSpecs}</div>`
      }
    }

    // Animation sinusoïdale CSS en background (seulement si en cours de lecture)
    const waveHtml = isCurrentlyPlaying ? getSineWaveAnimationHTML() : ''

    resumeTile.innerHTML = `
      ${waveHtml}
      <div class="resume-cover">
        <img class="resume-cover-img" style="display: none;" alt="">
        <div class="resume-cover-placeholder">♪</div>
      </div>
      <div class="resume-info">
        <span class="resume-label${isCurrentlyPlaying ? ' resume-label-active' : ''}">${label}</span>
        <span class="resume-title">${escapeHtml(title)}</span>
        <span class="resume-artist">${escapeHtml(artist)}</span>
        ${album ? `<span class="resume-album">${escapeHtml(album)}</span>` : ''}
        ${specsTagsHtml}
      </div>
      <button class="resume-play-btn">${isCurrentlyPlaying ? '⏸' : '▶'}</button>
    `

    // Charge la pochette avec vérification DOM
    const coverPath = currentTrack?.path || displayTrack.path
    const img = resumeTile.querySelector('.resume-cover-img')
    const placeholder = resumeTile.querySelector('.resume-cover-placeholder')
    if (img && placeholder) {
      // Vérifie d'abord le cache mémoire pour affichage instantané
      const cachedCover = coverCache.get(coverPath) || thumbnailCache.get(coverPath)
      if (!loadCachedImage(img, placeholder, cachedCover)) {
        // Sinon charge via la queue
        loadThumbnailAsync(coverPath, img, artist, album).then(() => {
          if (img.isConnected && img.style.display === 'block') {
            placeholder.style.display = 'none'
          }
        })
      }
    }

    resumeSection.appendChild(resumeTile)
    homeContainer.appendChild(resumeSection)
  }

  // === 2. Grille "Écouté récemment" (tracks des 15 derniers jours) ===
  if (recentTracks.length > 0) {
    const recentSection = document.createElement('section')
    recentSection.className = 'home-section'

    const recentHeader = document.createElement('h2')
    recentHeader.className = 'home-section-title'
    recentHeader.textContent = 'Recently Played'
    recentSection.appendChild(recentHeader)

    const grid = document.createElement('div')
    grid.className = 'home-recent-grid'

    // Maximum 6 tuiles pour "Écouté récemment"
    const maxTracks = 6

    // Déduplique les tracks et garde les 6 plus récentes
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
      const album = albums[albumKey]

      const item = document.createElement('div')
      item.className = 'recent-track-item'
      item.dataset.trackPath = entry.path
      item.innerHTML = `
        <div class="recent-track-cover">
          <img class="recent-track-img" style="display: none;" alt="">
          <div class="recent-track-placeholder">♪</div>
        </div>
        <div class="recent-track-info">
          <span class="recent-track-title">${escapeHtml(entry.title) || 'Titre inconnu'}</span>
          <span class="recent-track-artist">${escapeHtml(entry.artist) || 'Unknown Artist'}</span>
          <span class="recent-track-album">${escapeHtml(entry.album) || ''}</span>
        </div>
      `

      const img = item.querySelector('.recent-track-img')
      const placeholder = item.querySelector('.recent-track-placeholder')

      // Charge la pochette - vérifie le cache d'abord pour affichage instantané
      const coverPath = (album && album.coverPath) ? album.coverPath : entry.path
      if (img && placeholder) {
        const cachedCover = coverCache.get(coverPath)
        if (!loadCachedImage(img, placeholder, cachedCover)) {
          loadThumbnailAsync(coverPath, img, entry.artist, entry.album).then(() => {
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

  // === 3. Carrousel "nouveautés" (25 derniers albums ajoutés) ===
  const albumKeys = Object.keys(albums)
  if (albumKeys.length > 0 && Object.keys(trackAddedDates).length > 0) {
    // Trie les albums par la date d'ajout la plus récente de leurs tracks
    // Utilise trackAddedDates (timestamps réels stockés dans le backend)
    const sortedByRecent = albumKeys
      .map(key => {
        const album = albums[key]
        // Trouve la date d'ajout la plus récente parmi les tracks de l'album
        let mostRecentDate = 0
        for (const track of album.tracks) {
          const addedDate = trackAddedDates[track.path] || 0
          if (addedDate > mostRecentDate) {
            mostRecentDate = addedDate
          }
        }
        return { key, album, addedDate: mostRecentDate }
      })
      .filter(item => item.addedDate > 0) // Ne garde que les albums avec une date d'ajout connue
      .sort((a, b) => b.addedDate - a.addedDate) // Plus récent en premier
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

      // Calcule le nombre d'items selon la taille de l'écran
      const { carousel: maxCarousel } = getResponsiveItemCount()
      const selection = sortedByRecent.slice(0, maxCarousel)

      for (const { key: albumKey, album } of selection) {
        if (!album) continue

        const item = document.createElement('div')
        item.className = 'carousel-item'
        item.dataset.albumKey = albumKey
        item.innerHTML = `
          <div class="carousel-cover">
            <img class="carousel-cover-img" style="display: none;" alt="">
            <div class="carousel-cover-placeholder">♪</div>
          </div>
          <div class="carousel-title">${escapeHtml(album.album)}</div>
          <div class="carousel-artist">${escapeHtml(album.artist)}</div>
        `

        const img = item.querySelector('.carousel-cover-img')
        const placeholder = item.querySelector('.carousel-cover-placeholder')

        // Charge la pochette
        if (album.coverPath && img && placeholder) {
          const cachedCover = coverCache.get(album.coverPath)
          if (!loadCachedImage(img, placeholder, cachedCover)) {
            loadThumbnailAsync(album.coverPath, img, album.artist, album.album).then(() => {
              if (img.isConnected && img.style.display === 'block') {
                placeholder.style.display = 'none'
              }
            })
          }
        }

        newCarousel.appendChild(item)
      }

      newSection.appendChild(newCarousel)
      homeContainer.appendChild(newSection)
    }
  }

  // === 4. Carrousel "À découvrir" (albums jamais écoutés) ===
  const playedAlbumsSet = new Set(allPlayedAlbums.map(e => e?.album || ''))
  const unplayedAlbums = Object.keys(albums).filter(key => !playedAlbumsSet.has(key))

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

    // Calcule le nombre d'items selon la taille de l'écran
    const { carousel: maxCarousel } = getResponsiveItemCount()

    // Sélection aléatoire de max N albums
    const shuffled = [...unplayedAlbums].sort(() => Math.random() - 0.5)
    const selection = shuffled.slice(0, maxCarousel)

    for (const albumKey of selection) {
      const album = albums[albumKey]
      if (!album) continue

      const item = document.createElement('div')
      item.className = 'carousel-item'
      item.dataset.albumKey = albumKey
      item.innerHTML = `
        <div class="carousel-cover">
          <img class="carousel-cover-img" style="display: none;" alt="">
          <div class="carousel-cover-placeholder">♪</div>
        </div>
        <div class="carousel-title">${escapeHtml(album.album)}</div>
        <div class="carousel-artist">${escapeHtml(album.artist)}</div>
      `

      const img = item.querySelector('.carousel-cover-img')
      const placeholder = item.querySelector('.carousel-cover-placeholder')

      // Charge la pochette - vérifie le cache d'abord pour affichage instantané
      if (album.coverPath && img && placeholder) {
        const cachedCover = coverCache.get(album.coverPath)
        if (!loadCachedImage(img, placeholder, cachedCover)) {
          loadThumbnailAsync(album.coverPath, img, album.artist, album.album).then(() => {
            if (img.isConnected && img.style.display === 'block') {
              placeholder.style.display = 'none'
            }
          })
        }
      }

      carousel.appendChild(item)
    }

    discoverSection.appendChild(carousel)
    homeContainer.appendChild(discoverSection)
  }

  // === 5. Carrousel "Tes artistes préférés" ===
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
          <div class="carousel-cover-placeholder">👤</div>
        </div>
        <div class="carousel-title">${escapeHtml(artist.name)}</div>
        <div class="carousel-artist">${artist.play_count} plays</div>
      `

      const img = item.querySelector('.carousel-cover-img')
      const placeholder = item.querySelector('.carousel-cover-placeholder')

      // Charge la PHOTO de l'artiste (pas la cover d'album)
      if (img && placeholder) {
        // Utilise loadArtistImageAsync qui récupère les vraies photos d'artiste via Deezer/MusicBrainz
        loadArtistImageAsync(artist.name, img, artist.sample_album, artist.sample_path).then(() => {
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

  // === 6. Carrousel "Qualité Audiophile" (albums Hi-Res) ===
  const hiResAlbumKeys = Object.keys(albums).filter(key => {
    const album = albums[key]
    return album.tracks.some(track => {
      const bd = track.metadata?.bitDepth
      const sr = track.metadata?.sampleRate
      return (bd && bd >= 24) || (sr && sr >= 88200)
    })
  })

  // Inverse pour avoir les derniers ajoutés en premier, max 25
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

    for (const albumKey of hiResSelection) {
      const album = albums[albumKey]
      if (!album) continue

      // Trouve le premier track Hi-Res pour afficher sa qualité
      const hiResTrack = album.tracks.find(t =>
        (t.metadata?.bitDepth >= 24) || (t.metadata?.sampleRate >= 88200)
      )
      const quality = formatQuality(hiResTrack?.metadata, hiResTrack?.path)

      const item = document.createElement('div')
      item.className = 'carousel-item hires-carousel-item'
      item.dataset.albumKey = albumKey
      item.innerHTML = `
        <div class="carousel-cover">
          <img class="carousel-cover-img" style="display: none;" alt="">
          <div class="carousel-cover-placeholder">♪</div>
          <span class="hires-badge">${quality.label}</span>
        </div>
        <div class="carousel-title">${escapeHtml(album.album)}</div>
        <div class="carousel-artist">${escapeHtml(album.artist)}</div>
      `

      const img = item.querySelector('.carousel-cover-img')
      const placeholder = item.querySelector('.carousel-cover-placeholder')

      // Charge la pochette (cache d'abord pour affichage instantané)
      if (album.coverPath && img && placeholder) {
        const cachedCover = coverCache.get(album.coverPath)
        if (!loadCachedImage(img, placeholder, cachedCover)) {
          loadThumbnailAsync(album.coverPath, img, album.artist, album.album).then(() => {
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

  // === 7. Carrousel "Albums longs" (durée > 60 minutes) - parfait pour écoute immersive ===
  const longAlbumKeys = Object.keys(albums).filter(key => {
    const album = albums[key]
    // Calcule la durée totale de l'album
    const totalDuration = album.tracks.reduce((sum, track) => {
      return sum + (track.metadata?.duration || 0)
    }, 0)
    return totalDuration >= 3600 // 60 minutes en secondes
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

    // Trie par durée décroissante, prend les 15 plus longs
    const sortedByDuration = longAlbumKeys
      .map(key => {
        const album = albums[key]
        const totalDuration = album.tracks.reduce((sum, t) => sum + (t.metadata?.duration || 0), 0)
        return { key, album, duration: totalDuration }
      })
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 15)

    for (const { key: albumKey, album, duration } of sortedByDuration) {
      if (!album) continue

      const durationStr = formatAlbumDuration(duration)

      const item = document.createElement('div')
      item.className = 'carousel-item'
      item.dataset.albumKey = albumKey
      item.innerHTML = `
        <div class="carousel-cover">
          <img class="carousel-cover-img" style="display: none;" alt="">
          <div class="carousel-cover-placeholder">♪</div>
          <span class="duration-badge">${durationStr}</span>
        </div>
        <div class="carousel-title">${escapeHtml(album.album)}</div>
        <div class="carousel-artist">${escapeHtml(album.artist)}</div>
      `

      const img = item.querySelector('.carousel-cover-img')
      const placeholder = item.querySelector('.carousel-cover-placeholder')

      if (album.coverPath && img && placeholder) {
        const cachedCover = coverCache.get(album.coverPath)
        if (!loadCachedImage(img, placeholder, cachedCover)) {
          loadThumbnailAsync(album.coverPath, img, album.artist, album.album).then(() => {
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

  // === 8. Carrousel "Ajoutés cette semaine" ===
  const oneWeekAgo = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60)
  const thisWeekAlbums = Object.keys(albums)
    .map(key => {
      const album = albums[key]
      // Trouve la date d'ajout la plus récente parmi les tracks
      let mostRecentDate = 0
      for (const track of album.tracks) {
        const addedDate = trackAddedDates[track.path] || 0
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

    for (const { key: albumKey, album, addedDate } of thisWeekAlbums) {
      if (!album) continue

      // Calcule "il y a X jours"
      const daysAgo = Math.floor((Date.now() / 1000 - addedDate) / (24 * 60 * 60))
      const timeLabel = daysAgo === 0 ? "Aujourd'hui" : daysAgo === 1 ? 'Hier' : `Il y a ${daysAgo}j`

      const item = document.createElement('div')
      item.className = 'carousel-item'
      item.dataset.albumKey = albumKey
      item.innerHTML = `
        <div class="carousel-cover">
          <img class="carousel-cover-img" style="display: none;" alt="">
          <div class="carousel-cover-placeholder">♪</div>
          <span class="time-badge">${timeLabel}</span>
        </div>
        <div class="carousel-title">${escapeHtml(album.album)}</div>
        <div class="carousel-artist">${escapeHtml(album.artist)}</div>
      `

      const img = item.querySelector('.carousel-cover-img')
      const placeholder = item.querySelector('.carousel-cover-placeholder')

      if (album.coverPath && img && placeholder) {
        const cachedCover = coverCache.get(album.coverPath)
        if (!loadCachedImage(img, placeholder, cachedCover)) {
          loadThumbnailAsync(album.coverPath, img, album.artist, album.album).then(() => {
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

  // === 9. Carrousel "Mix aléatoire" (sélection aléatoire d'albums) ===
  const allAlbumKeys = Object.keys(albums)
  if (allAlbumKeys.length >= 10) {
    const mixSection = document.createElement('section')
    mixSection.className = 'home-section'

    const mixHeader = document.createElement('h2')
    mixHeader.className = 'home-section-title'
    mixHeader.textContent = 'Random Mix'
    mixSection.appendChild(mixHeader)

    const mixCarousel = document.createElement('div')
    mixCarousel.className = 'home-carousel'

    // Sélection vraiment aléatoire de 12 albums
    const shuffledAlbums = [...allAlbumKeys].sort(() => Math.random() - 0.5).slice(0, 12)

    for (const albumKey of shuffledAlbums) {
      const album = albums[albumKey]
      if (!album) continue

      const item = document.createElement('div')
      item.className = 'carousel-item'
      item.dataset.albumKey = albumKey
      item.innerHTML = `
        <div class="carousel-cover">
          <img class="carousel-cover-img" style="display: none;" alt="">
          <div class="carousel-cover-placeholder">♪</div>
        </div>
        <div class="carousel-title">${escapeHtml(album.album)}</div>
        <div class="carousel-artist">${escapeHtml(album.artist)}</div>
      `

      const img = item.querySelector('.carousel-cover-img')
      const placeholder = item.querySelector('.carousel-cover-placeholder')

      if (album.coverPath && img && placeholder) {
        const cachedCover = coverCache.get(album.coverPath)
        if (!loadCachedImage(img, placeholder, cachedCover)) {
          loadThumbnailAsync(album.coverPath, img, album.artist, album.album).then(() => {
            if (img.isConnected && img.style.display === 'block') {
              placeholder.style.display = 'none'
            }
          })
        }
      }

      mixCarousel.appendChild(item)
    }

    mixSection.appendChild(mixCarousel)
    homeContainer.appendChild(mixSection)
  }

  // === 10. Carrousel "Mix de découverte" (playlists genre+décennie) ===
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
          <div class="carousel-cover-placeholder">♪</div>
          <div class="discovery-mix-overlay">
            <span class="discovery-mix-label">${escapeHtml(mix.title)}</span>
          </div>
        </div>
        <div class="carousel-title">${escapeHtml(mix.title)}</div>
        <div class="carousel-artist">${mix.trackCount} titres</div>
      `

      const img = item.querySelector('.discovery-mix-bg-img')
      const placeholder = item.querySelector('.carousel-cover-placeholder')

      // Charge la cover depuis la track représentative du mix
      if (mix.coverPath && img && placeholder) {
        const cachedCover = coverCache.get(mix.coverPath) || thumbnailCache.get(mix.coverPath)
        if (!loadCachedImage(img, placeholder, cachedCover)) {
          loadThumbnailAsync(mix.coverPath, img, '', '').then(() => {
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

  // Message si rien à afficher
  if (!lastPlayed && recentTracks.length === 0 && unplayedAlbums.length === 0) {
    const emptyMessage = document.createElement('div')
    emptyMessage.className = 'home-empty'
    emptyMessage.innerHTML = `
      <h2>Welcome to Noir</h2>
      <p>Start listening to music to fill this page.</p>
    `
    homeContainer.appendChild(emptyMessage)
  }

  // EVENT DELEGATION - un seul listener pour tout le container
  homeContainer.addEventListener('click', async (e) => {
    // Clic sur bouton play/pause de la tuile "Lecture en cours"
    const playBtn = e.target.closest('.resume-play-btn')
    if (playBtn) {
      e.stopPropagation()
      // Toggle play/pause
      if (audioIsPlaying) {
        try {
          await invoke('audio_pause')
        } catch (err) {
          console.error('audio_pause error:', err)
        }
        audioIsPlaying = false
        playPauseBtn.textContent = '▶'
        playBtn.textContent = '▶'
      } else if (currentTrackIndex >= 0) {
        try {
          await invoke('audio_resume')
          audioIsPlaying = true
          playPauseBtn.textContent = '⏸'
          playBtn.textContent = '⏸'
        } catch (err) {
          // Audio pas encore chargé (auto-resume) → lancer la lecture complète
          playTrack(currentTrackIndex)
        }
      }
      return
    }

    // Clic sur tuile "Reprendre la lecture" (hors bouton play)
    const resumeTile = e.target.closest('.home-resume-tile')
    if (resumeTile) {
      const trackPath = resumeTile.dataset.trackPath
      if (trackPath) {
        const trackIndex = tracks.findIndex(t => t.path === trackPath)
        if (trackIndex !== -1) playTrack(trackIndex)
      }
      return
    }

    // Clic sur track "Écouté récemment"
    const recentItem = e.target.closest('.recent-track-item')
    if (recentItem) {
      const trackPath = recentItem.dataset.trackPath
      if (trackPath) {
        const trackIndex = tracks.findIndex(t => t.path === trackPath)
        if (trackIndex !== -1) playTrack(trackIndex)
      }
      return
    }

    // Clic sur un mix de découverte
    const mixItem = e.target.closest('.discovery-mix-item')
    if (mixItem) {
      const mixId = mixItem.dataset.mixId
      const mix = discoveryMixes.find(m => m.id === mixId)
      if (mix) navigateToMixPage(mix)
      return
    }

    // Clic sur album "À découvrir" ou artiste
    const carouselItem = e.target.closest('.carousel-item')
    if (carouselItem) {
      // Clic sur un artiste
      const artistName = carouselItem.dataset.artistName
      if (artistName && artists[artistName]) {
        openArtistFromHome(artistName)
        return
      }

      // Clic sur un album
      const albumKey = carouselItem.dataset.albumKey
      if (albumKey && albums[albumKey]) {
        openAlbumFromHome(albumKey, albums[albumKey])
      }
      return
    }
  })

  // DRAG & DROP DELEGATION - permet de drag les albums/tracks de la home vers playlists
  homeContainer.addEventListener('mousedown', (e) => {
    // Ignore si on clique sur un bouton
    if (e.target.closest('button')) return

    // Drag d'un album depuis un carousel
    const carouselItem = e.target.closest('.carousel-item')
    if (carouselItem) {
      const albumKey = carouselItem.dataset.albumKey
      if (albumKey && albums[albumKey]) {
        prepareAlbumDrag(e, albumKey, carouselItem)
      }
      return
    }

    // Drag d'une track récente
    const recentTrackItem = e.target.closest('.recent-track-item')
    if (recentTrackItem) {
      const trackPath = recentTrackItem.dataset.trackPath
      const track = tracks.find(t => t.path === trackPath)
      if (track) {
        prepareCustomDrag(e, track, recentTrackItem)
      }
      return
    }
  })

  // CONTEXT MENU sur les tracks de la Home (Écouté récemment)
  homeContainer.addEventListener('contextmenu', (e) => {
    const recentItem = e.target.closest('.recent-track-item')
    if (recentItem) {
      e.preventDefault()
      e.stopPropagation()
      const trackPath = recentItem.dataset.trackPath
      const trackIndex = tracks.findIndex(t => t.path === trackPath)
      if (trackIndex !== -1) {
        showContextMenu(e, tracks[trackIndex], trackIndex)
      }
    }
  })

  albumsGridDiv.appendChild(homeContainer)
}

// Met à jour la section "Lecture en cours" de la Home quand une track joue
function updateHomeNowPlayingSection() {
  // Ne fait rien si on n'est pas sur la home
  if (currentView !== 'home') return

  const section = document.getElementById('home-now-playing-section')
  if (!section) return

  const currentTrack = currentTrackIndex >= 0 ? tracks[currentTrackIndex] : null
  if (!currentTrack) return

  // Récupère ou crée la tuile
  let resumeTile = section.querySelector('.home-resume-tile')
  if (!resumeTile) {
    resumeTile = document.createElement('div')
    resumeTile.className = 'home-resume-tile'
    section.appendChild(resumeTile)
  }

  // Détermine les infos
  const title = currentTrack.metadata?.title || currentTrack.name || 'Titre inconnu'
  const artist = currentTrack.metadata?.artist || 'Unknown Artist'
  const album = currentTrack.metadata?.album || ''

  // Specs techniques
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
    const textSpecs = textParts.length > 0 ? `<span class="resume-specs-text">${textParts.join(' • ')}</span>` : ''

    if (tags.length > 0 || textSpecs) {
      specsTagsHtml = `<div class="resume-specs-container">${tags.join('')}${textSpecs}</div>`
    }
  }

  // Animation sinusoïdale (toujours affichée car track en cours)
  const waveHtml = getSineWaveAnimationHTML()

  // Met à jour le path
  resumeTile.dataset.trackPath = currentTrack.path

  // Reconstruit le contenu complet
  resumeTile.innerHTML = `
    ${waveHtml}
    <div class="resume-cover">
      <img class="resume-cover-img" style="display: none;" alt="">
      <div class="resume-cover-placeholder">♪</div>
    </div>
    <div class="resume-info">
      <span class="resume-label resume-label-active">Now Playing</span>
      <span class="resume-title">${escapeHtml(title)}</span>
      <span class="resume-artist">${escapeHtml(artist)}</span>
      ${album ? `<span class="resume-album">${escapeHtml(album)}</span>` : ''}
      ${specsTagsHtml}
    </div>
    <button class="resume-play-btn">${audioIsPlaying ? '⏸' : '▶'}</button>
  `

  // Charge le thumbnail de la pochette
  const img = resumeTile.querySelector('.resume-cover-img')
  const placeholder = resumeTile.querySelector('.resume-cover-placeholder')
  if (img && placeholder) {
    loadThumbnailAsync(currentTrack.path, img, artist, album).then(() => {
      if (img.isConnected && img.style.display === 'block') {
        placeholder.style.display = 'none'
      }
    })
  }
}

// === AFFICHAGE DE LA GRILLE D'ALBUMS ===

// Ouvre la page d'un artiste depuis la Home
function openArtistFromHome(artistName) {
  if (!artistName || !artists[artistName]) return
  // Navigue vers la page dédiée de l'artiste (au lieu de filtrer la grille)
  navigateToArtistPage(artistName)
}

// Ouvre un album depuis la page Home, les résultats de recherche ou la page artiste
// Navigue vers la page dédiée de l'album avec historique
function openAlbumFromHome(albumKey, album) {
  // Vérifie que l'album existe
  if (!albumKey || !album) return

  // Navigue vers la page dédiée de l'album
  navigateToAlbumPage(albumKey)
}

// === AFFICHAGE DE LA GRILLE D'ALBUMS ===
function displayAlbumsGrid() {
  // Clear explicite du conteneur (peut être appelé récursivement depuis le menu de tri)
  albumsGridDiv.textContent = ''
  albumsGridDiv.classList.remove('tracks-mode')  // Retire le mode tracks
  if (coverObserver) coverObserver.disconnect()

  // Supprime la scrollbar alphabétique si présente
  const existingNav = document.querySelector('.alphabet-nav')
  if (existingNav) existingNav.remove()

  // Si on filtre par artiste, affiche un header avec bouton retour
  if (filteredArtist) {
    const header = document.createElement('div')
    header.className = 'view-header'
    header.innerHTML = `
      <button class="btn-back-nav" title="Retour">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 12H5"/>
          <path d="M12 19l-7-7 7-7"/>
        </svg>
      </button>
      <h2>${filteredArtist}</h2>
    `
    header.querySelector('.btn-back-nav').addEventListener('click', () => {
      filteredArtist = null
      currentView = 'artists'
      navItems.forEach(i => i.classList.remove('active'))
      document.querySelector('[data-view="artists"]').classList.add('active')
      displayArtistsGrid()
    })
    albumsGridDiv.appendChild(header)
  } else {
    // Header avec titre ET bouton de tri (icône) - même style que les Artistes
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
          <button class="sort-option${albumSortMode === 'artist-asc' ? ' active' : ''}" data-sort="artist-asc">Artiste A → Z</button>
          <button class="sort-option${albumSortMode === 'artist-desc' ? ' active' : ''}" data-sort="artist-desc">Artiste Z → A</button>
          <button class="sort-option${albumSortMode === 'album-asc' ? ' active' : ''}" data-sort="album-asc">Album A → Z</button>
          <button class="sort-option${albumSortMode === 'album-desc' ? ' active' : ''}" data-sort="album-desc">Album Z → A</button>
          <button class="sort-option${albumSortMode === 'recent' ? ' active' : ''}" data-sort="recent">Derniers Ajouts</button>
        </div>
      </div>
    `

    const sortBtn = headerDiv.querySelector('#album-sort-btn')
    const sortMenu = headerDiv.querySelector('#album-sort-menu')

    // Toggle menu au clic sur le bouton
    sortBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      sortMenu.classList.toggle('hidden')
    })

    // Sélection d'une option de tri
    sortMenu.querySelectorAll('.sort-option').forEach(option => {
      option.addEventListener('click', (e) => {
        e.stopPropagation()
        albumSortMode = option.dataset.sort
        sortMenu.classList.add('hidden')
        displayAlbumsGrid()
      })
    })

    // Ferme le menu si on clique ailleurs (utilise capture pour éviter les conflits)
    const closeAlbumSortMenu = (e) => {
      if (!e.target.closest('.artist-sort-dropdown')) {
        sortMenu.classList.add('hidden')
      }
    }
    // Retire l'ancien listener s'il existe et ajoute le nouveau
    document.removeEventListener('click', window._albumSortMenuClose)
    window._albumSortMenuClose = closeAlbumSortMenu
    document.addEventListener('click', closeAlbumSortMenu)

    albumsGridDiv.appendChild(headerDiv)
  }

  // Conteneur pour la grille
  const gridContainer = document.createElement('div')
  gridContainer.className = 'albums-grid-container'

  // Pour le tri "recent", pré-calcule les indices des tracks (évite O(n²))
  let trackIndexMap = null
  if (albumSortMode === 'recent') {
    trackIndexMap = new Map()
    tracks.forEach((t, i) => trackIndexMap.set(t.path, i))
  }

  // Trie les albums selon le mode sélectionné
  const albumKeys = Object.keys(albums).sort((a, b) => {
    const albumA = albums[a]
    const albumB = albums[b]
    switch (albumSortMode) {
      case 'artist-asc': return albumA.artist.localeCompare(albumB.artist)
      case 'artist-desc': return albumB.artist.localeCompare(albumA.artist)
      case 'album-asc': return albumA.album.localeCompare(albumB.album)
      case 'album-desc': return albumB.album.localeCompare(albumA.album)
      case 'recent':
        // Tri par date d'ajout - utilise la map pré-calculée (O(1) au lieu de O(n))
        const lastTrackA = albumA.tracks.length > 0 ? (trackIndexMap.get(albumA.tracks[albumA.tracks.length - 1].path) ?? -1) : -1
        const lastTrackB = albumB.tracks.length > 0 ? (trackIndexMap.get(albumB.tracks[albumB.tracks.length - 1].path) ?? -1) : -1
        return lastTrackB - lastTrackA // Plus récent en premier
      default: return 0
    }
  })

  for (const albumKey of albumKeys) {
    const album = albums[albumKey]

    // Filtre par artiste si actif
    if (filteredArtist && album.artist !== filteredArtist) continue

    // Filtre par recherche
    if (searchQuery) {
      const matchesAlbum = album.album.toLowerCase().includes(searchQuery)
      const matchesArtist = album.artist.toLowerCase().includes(searchQuery)
      if (!matchesAlbum && !matchesArtist) continue
    }

    const card = document.createElement('div')
    card.className = 'album-card'
    card.dataset.albumKey = albumKey

    // Vérifie si la pochette est déjà en cache (affichage instantané)
    const cachedCover = coverCache.get(album.coverPath)
    const hasCachedCover = isValidImageSrc(cachedCover)

    // Crée la carte avec placeholder ou image si en cache
    card.innerHTML = `
      <div class="album-cover">
        <img class="album-cover-img" ${hasCachedCover ? `src="${cachedCover}"` : 'style="display: none;"'} alt="${album.album}">
        <div class="album-cover-placeholder" ${hasCachedCover ? 'style="display: none;"' : ''}>♪</div>
      </div>
      <div class="album-title">${album.album}</div>
      <div class="album-artist">${album.artist}</div>
    `

    // Si pas en cache, utilise le lazy loading (charge uniquement quand visible)
    if (!hasCachedCover && album.coverPath) {
      observeCoverLoading(card, album.coverPath)
    }

    // Clic sur un album = ouvre le panel de détail (comportement original)
    card.addEventListener('click', () => {
      // Ignore si on était en train de drag
      if (customDragState.isDragging) return
      const cover = coverCache.get(album.coverPath) || thumbnailCache.get(album.coverPath)
      showAlbumDetail(albumKey, cover, card)
    })

    // Clic droit sur un album = menu contextuel
    card.addEventListener('contextmenu', (e) => {
      showAlbumContextMenu(e, albumKey)
    })

    // Drag & drop pour ajouter l'album complet à une playlist
    card.addEventListener('mousedown', (e) => {
      prepareAlbumDrag(e, albumKey, card)
    })

    gridContainer.appendChild(card)
  }

  albumsGridDiv.appendChild(gridContainer)
}

// === AFFICHAGE DE LA GRILLE D'ARTISTES ===
// Mode de tri pour les artistes (même pattern que les albums)
let artistSortMode = 'name-asc'

function displayArtistsGrid() {
  // Clear explicite (nécessaire quand appelé directement depuis le menu de tri)
  albumsGridDiv.textContent = ''
  albumsGridDiv.classList.remove('tracks-mode')  // Retire le mode tracks

  // Header avec titre ET bouton de tri (icône)
  const headerDiv = document.createElement('div')
  headerDiv.className = 'view-header-with-sort'

  // Labels des modes de tri (simplifié)
  const artistSortLabels = {
    'name-asc': 'Nom A → Z',
    'name-desc': 'Nom Z → A',
    'recent': 'Derniers Ajouts'
  }

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
        <button class="sort-option${artistSortMode === 'name-asc' ? ' active' : ''}" data-sort="name-asc">Nom A → Z</button>
        <button class="sort-option${artistSortMode === 'name-desc' ? ' active' : ''}" data-sort="name-desc">Nom Z → A</button>
        <button class="sort-option${artistSortMode === 'recent' ? ' active' : ''}" data-sort="recent">Derniers Ajouts</button>
      </div>
    </div>
  `

  const sortBtn = headerDiv.querySelector('#artist-sort-btn')
  const sortMenu = headerDiv.querySelector('#artist-sort-menu')

  // Toggle menu au clic sur le bouton
  sortBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    sortMenu.classList.toggle('hidden')
  })

  // Sélection d'une option de tri
  sortMenu.querySelectorAll('.sort-option').forEach(option => {
    option.addEventListener('click', (e) => {
      e.stopPropagation()
      artistSortMode = option.dataset.sort
      sortMenu.classList.add('hidden')
      displayArtistsGrid()
    })
  })

  // Ferme le menu si on clique ailleurs
  const closeArtistSortMenu = (e) => {
    if (!e.target.closest('.artist-sort-dropdown')) {
      sortMenu.classList.add('hidden')
    }
  }
  // Retire l'ancien listener s'il existe et ajoute le nouveau
  document.removeEventListener('click', window._artistSortMenuClose)
  window._artistSortMenuClose = closeArtistSortMenu
  document.addEventListener('click', closeArtistSortMenu)

  albumsGridDiv.appendChild(headerDiv)

  // Conteneur pour la grille (même style que les albums)
  const gridContainer = document.createElement('div')
  gridContainer.className = 'albums-grid-container'

  // Trie les artistes selon le mode sélectionné
  const sortedArtists = Object.keys(artists).sort((a, b) => {
    const artistA = artists[a]
    const artistB = artists[b]
    switch (artistSortMode) {
      case 'name-asc': return artistA.name.localeCompare(artistB.name)
      case 'name-desc': return artistB.name.localeCompare(artistA.name)
      case 'recent':
        // Tri par date d'ajout (basé sur l'index dans tracks - les derniers ajoutés sont à la fin)
        const lastTrackA = artistA.tracks.length > 0 ? tracks.findIndex(t => t.path === artistA.tracks[artistA.tracks.length - 1].path) : -1
        const lastTrackB = artistB.tracks.length > 0 ? tracks.findIndex(t => t.path === artistB.tracks[artistB.tracks.length - 1].path) : -1
        return lastTrackB - lastTrackA // Plus récent en premier
      default: return 0
    }
  })

  // Collecte pour la scrollbar alphabétique
  const alphabetItems = []

  for (const artistKey of sortedArtists) {
    const artist = artists[artistKey]

    // Filtre par recherche
    if (searchQuery) {
      if (!artist.name.toLowerCase().includes(searchQuery)) continue
    }

    const card = document.createElement('div')
    card.className = 'album-card artist-card'

    const albumCount = artist.albums.length
    const trackCount = artist.tracks.length

    card.innerHTML = `
      <div class="album-cover artist-cover">
        <img class="album-cover-img" style="display: none;" alt="${artist.name}">
        <div class="album-cover-placeholder">♪</div>
      </div>
      <div class="album-title">${artist.name}</div>
      <div class="album-artist">${albumCount} album${albumCount > 1 ? 's' : ''} • ${trackCount} titre${trackCount > 1 ? 's' : ''}</div>
    `

    const img = card.querySelector('.album-cover-img')
    const placeholder = card.querySelector('.album-cover-placeholder')

    // Récupère le premier album de l'artiste pour le fallback Internet
    const firstAlbum = artist.albums.length > 0 ? artist.albums[0] : null
    // Récupère le coverPath du premier track pour le fallback local
    const fallbackCoverPath = artist.coverPath || null

    // Charge l'image d'artiste (photo Deezer/MusicBrainz ou fallback pochette)
    loadArtistImageAsync(artist.name, img, firstAlbum, fallbackCoverPath).then(() => {
      if (img.style.display === 'block') {
        placeholder.style.display = 'none'
      }
    })

    // Clic sur un artiste = filtre les albums par cet artiste
    card.addEventListener('click', () => {
      showArtistAlbums(artistKey)
    })

    gridContainer.appendChild(card)

    // Ajoute à la liste pour la scrollbar alphabétique
    alphabetItems.push({ name: artist.name, element: card })
  }

  albumsGridDiv.appendChild(gridContainer)

  // Ajoute la scrollbar alphabétique si tri A-Z ou Z-A
  if (artistSortMode === 'name-asc' || artistSortMode === 'name-desc') {
    createAlphabetScrollbar(
      document.body,
      alphabetItems,
      item => item.name.charAt(0),
      albumsViewDiv
    )
  } else {
    // Supprime la scrollbar si elle existe
    const existingNav = document.querySelector('.alphabet-nav')
    if (existingNav) existingNav.remove()
  }
}

// Affiche les albums d'un artiste
function showArtistAlbums(artistKey) {
  // Navigue vers la page dédiée de l'artiste (comme la page album)
  navigateToArtistPage(artistKey)
}

// Affiche la page dédiée d'un artiste
function displayArtistPage(artistKey) {
  const artist = artists[artistKey]
  if (!artist) return

  // Supprime la scrollbar alphabétique sur la page artiste individuelle
  const existingNav = document.querySelector('.alphabet-nav')
  if (existingNav) existingNav.remove()

  // Trouve tous les albums de cet artiste
  const artistAlbums = Object.keys(albums)
    .filter(key => albums[key].artist === artistKey)
    .map(key => ({ key, ...albums[key] }))
    .sort((a, b) => {
      // Tri par année si disponible, sinon alphabétique
      const yearA = a.tracks[0]?.metadata?.year || 9999
      const yearB = b.tracks[0]?.metadata?.year || 9999
      return yearA - yearB
    })

  const totalTracks = artist.tracks.length
  const totalDuration = artist.tracks.reduce((acc, t) => acc + (t.metadata?.duration || 0), 0)

  // Container de la page
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
        <div class="artist-photo-placeholder">♪</div>
      </div>
      <div class="artist-page-info">
        <p class="artist-page-meta">
          ${artistAlbums.length} album${artistAlbums.length > 1 ? 's' : ''} • ${totalTracks} titre${totalTracks > 1 ? 's' : ''} • ${formatTime(totalDuration)}
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

  // Event listener pour le bouton retour
  pageContainer.querySelector('.btn-back-nav').addEventListener('click', navigateBack)

  // Event listener pour lecture de tous les tracks de l'artiste
  pageContainer.querySelector('.play-artist-btn').addEventListener('click', () => {
    if (artist.tracks.length > 0) {
      const firstTrack = artist.tracks[0]
      const globalIndex = tracks.findIndex(t => t.path === firstTrack.path)
      if (globalIndex !== -1) {
        playTrack(globalIndex)
      }
    }
  })

  // Event listener pour ajouter à la queue
  pageContainer.querySelector('.add-artist-queue-btn').addEventListener('click', () => {
    artist.tracks.forEach(track => {
      if (!queue.find(q => q.path === track.path)) {
        queue.push(track)
      }
    })
    showQueueNotification(`${artist.tracks.length} tracks added to queue`)
  })

  // Charge la photo de l'artiste
  const img = pageContainer.querySelector('.artist-page-photo-img')
  const placeholder = pageContainer.querySelector('.artist-photo-placeholder')
  const firstAlbum = artist.albums.length > 0 ? artist.albums[0] : null
  const fallbackCoverPath = artist.coverPath || null

  loadArtistImageAsync(artist.name, img, firstAlbum, fallbackCoverPath).then(() => {
    if (img.style.display === 'block') {
      placeholder.style.display = 'none'
    }
  })

  // Séparer les albums complets des tracks isolées (albums avec 1 seule track)
  const fullAlbums = artistAlbums.filter(a => a.tracks.length > 1)
  let looseTracks = artistAlbums.filter(a => a.tracks.length === 1).flatMap(a => a.tracks)

  // Fallback : si aucun album trouvé mais l'artiste a des tracks, les afficher directement
  if (artistAlbums.length === 0 && artist.tracks.length > 0) {
    looseTracks = [...artist.tracks]
  }

  // Grille des albums de l'artiste
  const albumsGrid = pageContainer.querySelector('.artist-albums-grid')

  // Affiche les albums complets en grille
  for (const albumData of fullAlbums) {
    const card = document.createElement('div')
    card.className = 'album-card'
    card.dataset.albumKey = albumData.key

    // Vérifie si la pochette est en cache
    const cachedCover = coverCache.get(albumData.coverPath)
    const hasCachedCover = isValidImageSrc(cachedCover)

    const year = albumData.tracks[0]?.metadata?.year
    const yearText = year ? ` • ${year}` : ''

    card.innerHTML = `
      <div class="album-cover">
        <img class="album-cover-img" ${hasCachedCover ? `src="${cachedCover}"` : 'style="display: none;"'} alt="${albumData.album}">
        <div class="album-cover-placeholder" ${hasCachedCover ? 'style="display: none;"' : ''}>♪</div>
      </div>
      <div class="album-title">${albumData.album}</div>
      <div class="album-artist">${albumData.tracks.length} titre${albumData.tracks.length > 1 ? 's' : ''}${yearText}</div>
    `

    // Si pas en cache, charge le thumbnail
    if (!hasCachedCover && albumData.coverPath) {
      const cardImg = card.querySelector('.album-cover-img')
      const cardPlaceholder = card.querySelector('.album-cover-placeholder')
      loadThumbnailAsync(albumData.coverPath, cardImg, artist.name, albumData.album).then(() => {
        if (cardImg.isConnected && cardImg.style.display === 'block') {
          cardPlaceholder.style.display = 'none'
        }
      })
    }

    // Clic sur un album = ouvre la page album
    card.addEventListener('click', () => {
      navigateToAlbumPage(albumData.key)
    })

    albumsGrid.appendChild(card)
  }

  // Affiche les tracks isolées en liste (si présentes)
  // NOTE: On affiche aussi cette section même si c'est la seule (pas d'albums complets)
  if (looseTracks.length > 0) {
    const looseSection = document.createElement('div')
    looseSection.className = 'artist-loose-tracks-section'

    // Titre différent si c'est la seule section
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
        ${getFavoriteButtonHtml(track.path)}
        <span class="track-number">${trackNum}</span>
        <div class="track-info">
          <span class="track-title">${escapeHtml(title)}</span>
          <span class="track-artist">${escapeHtml(albumName)}</span>
        </div>
        <button class="track-add-queue${queue.some(q => q.path === track.path) ? ' in-queue' : ''}" title="Add to queue">
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

      // Double-clic pour jouer (même pattern que les tracks album)
      trackItem.addEventListener('dblclick', () => {
        const globalIndex = tracks.findIndex(t => t.path === track.path)
        if (globalIndex !== -1) {
          playTrack(globalIndex)
        }
      })

      // Bouton ajouter à la queue
      trackItem.querySelector('.track-add-queue').addEventListener('click', (e) => {
        e.stopPropagation()
        addToQueue(track)
        showQueueNotification(`"${track.metadata?.title || track.name}" added to queue`)
        trackItem.querySelector('.track-add-queue').classList.add('in-queue')
      })

      // Bouton ajouter à une playlist
      trackItem.querySelector('.track-add-playlist').addEventListener('click', (e) => {
        e.stopPropagation()
        showAddToPlaylistMenu(e, track)
      })

      // Bouton favori
      const favBtn = trackItem.querySelector('.track-favorite-btn')
      if (favBtn) {
        favBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          toggleFavorite(track.path, favBtn)
        })
      }

      // Menu contextuel (clic droit)
      trackItem.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        const globalIndex = tracks.findIndex(t => t.path === track.path)
        if (globalIndex !== -1) {
          showContextMenu(e, track, globalIndex)
        }
      })

      trackList.appendChild(trackItem)
    }

    // Ajoute directement dans la grille pour qu'elle soit visible
    albumsGrid.appendChild(looseSection)
  }

  albumsGridDiv.appendChild(pageContainer)

  // Force scroll en haut
  const albumsView = document.querySelector('.albums-view')
  if (albumsView) albumsView.scrollTop = 0
}

// Retourne l'indicateur de tri (▲ ou ▼) pour une colonne
function getSortIndicator(column) {
  if (sortColumn !== column) return ''
  return sortDirection === 'asc' ? '▲' : '▼'
}

// === VIRTUAL SCROLLING POUR LA LISTE DES TITRES ===
// Configuration du virtual scroll
const TRACK_ITEM_HEIGHT = 48 // Hauteur d'un item en pixels
const VIRTUAL_BUFFER = 10    // Nombre d'items à rendre au-dessus/dessous de la zone visible
const POOL_SIZE = 60         // Taille du pool de nœuds DOM recyclables

// État du virtual scroll
let virtualScrollState = {
  filteredTracks: [],        // Tracks triées et filtrées
  visibleStartIndex: 0,      // Premier index visible
  visibleEndIndex: 0,        // Dernier index visible
  scrollContainer: null,     // Référence au conteneur de scroll
  contentContainer: null,    // Référence au conteneur des items
  selectedTrackPaths: new Set(),  // Tracks sélectionnées (multi-sélection)
  lastSelectedPath: null,    // Dernière track sélectionnée (pour Shift+Clic)
  pool: []                   // Pool de nœuds DOM réutilisables
}

// === LOOKUP MAP POUR PERFORMANCES O(1) ===
// Remplace tracks.find() O(n) par tracksByPath.get() O(1)
const tracksByPath = new Map() // path → { track, index }

function buildTrackLookup() {
  tracksByPath.clear()
  tracks.forEach((track, i) => tracksByPath.set(track.path, { track, index: i }))
}

// Trie et filtre les tracks
function getSortedAndFilteredTracks() {
  // Trie les tracks selon la colonne sélectionnée
  let sortedTracks = [...tracks].sort((a, b) => {
    let valueA, valueB

    switch (sortColumn) {
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
        return sortDirection === 'asc' ? result : -result
      default:
        valueA = a.metadata?.title || a.name
        valueB = b.metadata?.title || b.name
    }

    const comparison = valueA.localeCompare(valueB)
    return sortDirection === 'asc' ? comparison : -comparison
  })

  // Filtre par recherche
  if (searchQuery) {
    // Tente d'abord la recherche par index (rapide)
    const indexedResults = searchTracksWithIndex(searchQuery)

    if (indexedResults && indexedResults.size > 0) {
      // Filtre les tracks triées selon l'index
      sortedTracks = sortedTracks.filter(track => {
        const trackIndex = tracks.indexOf(track)
        return indexedResults.has(trackIndex)
      })
    } else {
      // Fallback : recherche classique par includes (pour sous-chaînes au milieu)
      sortedTracks = sortedTracks.filter(track => {
        const title = (track.metadata?.title || track.name).toLowerCase()
        const artist = (track.metadata?.artist || '').toLowerCase()
        const album = (track.metadata?.album || '').toLowerCase()
        return title.includes(searchQuery) || artist.includes(searchQuery) || album.includes(searchQuery)
      })
    }
  }

  return sortedTracks
}

// Crée un nœud DOM réutilisable pour le pool
function createPoolNode() {
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
  // Cache des références directes aux enfants pour éviter querySelector à chaque update
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

// Met à jour les éléments visibles dans le virtual scroll (avec recyclage DOM)
function updateVirtualScrollItems() {
  const { filteredTracks, contentContainer, scrollContainer, pool } = virtualScrollState

  // Vérifications de sécurité
  if (!contentContainer || !scrollContainer || !scrollContainer.isConnected) return
  if (!filteredTracks || filteredTracks.length === 0) return
  if (!pool || pool.length === 0) return

  const scrollTop = scrollContainer.scrollTop
  const viewportHeight = scrollContainer.clientHeight

  // Vérifie que le conteneur a une hauteur (est visible)
  if (viewportHeight === 0) return

  // Calcule les indices visibles
  const startIndex = Math.max(0, Math.floor(scrollTop / TRACK_ITEM_HEIGHT) - VIRTUAL_BUFFER)
  const endIndex = Math.min(
    filteredTracks.length - 1,
    Math.ceil((scrollTop + viewportHeight) / TRACK_ITEM_HEIGHT) + VIRTUAL_BUFFER
  )

  // Optimisation : ne rien faire si les indices n'ont pas changé
  if (startIndex === virtualScrollState.visibleStartIndex && endIndex === virtualScrollState.visibleEndIndex) {
    return
  }

  virtualScrollState.visibleStartIndex = startIndex
  virtualScrollState.visibleEndIndex = endIndex

  const visibleCount = endIndex - startIndex + 1

  // Recycle les nœuds DOM du pool au lieu de recréer le HTML
  for (let p = 0; p < pool.length; p++) {
    const el = pool[p]
    if (p < visibleCount) {
      const trackIndex = startIndex + p
      const track = filteredTracks[trackIndex]
      const isFav = favoriteTracks.has(track.path)
      const isInQueue = queue.some(q => q.path === track.path)
      const quality = formatQuality(track.metadata, track.path)

      // Position et visibilité
      el.style.top = (trackIndex * TRACK_ITEM_HEIGHT) + 'px'
      el.style.display = ''
      el.dataset.trackPath = track.path
      el.dataset.virtualIndex = trackIndex

      // Mise à jour du contenu texte (pas de innerHTML = pas de parse)
      el._title.textContent = track.metadata?.title || track.name
      el._artist.textContent = track.metadata?.artist || 'Unknown Artist'
      el._album.textContent = track.metadata?.album || ''
      el._duration.textContent = track.metadata?.duration ? formatTime(track.metadata.duration) : '-:--'
      el._quality.textContent = quality.label
      el._quality.className = 'quality-tag ' + quality.class

      // États visuels
      el._favBtn.classList.toggle('active', isFav)
      el._favBtn.title = isFav ? 'Retirer des favoris' : 'Ajouter aux favoris'
      el._favSvg.setAttribute('fill', isFav ? 'currentColor' : 'none')
      el._queueBtn.classList.toggle('in-queue', isInQueue)
      el._queueBtn.title = isInQueue ? 'Remove from queue' : 'Add to queue'
      el.classList.toggle('selected', virtualScrollState.selectedTrackPaths.has(track.path))
    } else {
      // Cache les nœuds non utilisés
      el.style.display = 'none'
    }
  }
}

// Met à jour l'affichage visuel de la sélection multiple
function updateTrackSelectionDisplay() {
  const { selectedTrackPaths, contentContainer } = virtualScrollState
  if (!contentContainer) return

  contentContainer.querySelectorAll('.tracks-list-item').forEach(item => {
    const isSelected = selectedTrackPaths.has(item.dataset.trackPath)
    item.classList.toggle('selected', isSelected)
  })
}

// === AFFICHAGE DE LA LISTE DES TITRES (avec Virtual Scrolling) ===
function displayTracksGrid() {
  // Ferme tout panel ouvert qui pourrait créer une "double sidebar"
  closeAlbumDetail()

  // Clear explicite du conteneur (peut être appelé récursivement depuis le tri)
  albumsGridDiv.textContent = ''

  // Active le mode tracks pour éviter double scrollbar
  albumsGridDiv.classList.add('tracks-mode')

  // Supprime la scrollbar alphabétique si présente
  const existingNav = document.querySelector('.alphabet-nav')
  if (existingNav) existingNav.remove()

  // Header avec titre
  const headerDiv = document.createElement('div')
  headerDiv.className = 'view-header-simple'
  headerDiv.innerHTML = `<h1 class="view-title">Tracks</h1>`
  albumsGridDiv.appendChild(headerDiv)

  // Récupère les tracks triées et filtrées
  virtualScrollState.filteredTracks = getSortedAndFilteredTracks()
  const totalTracks = virtualScrollState.filteredTracks.length

  // Crée le conteneur principal
  const tracksContainer = document.createElement('div')
  tracksContainer.className = 'tracks-list-view'

  // Header de la liste avec tri (sticky)
  const header = document.createElement('div')
  header.className = 'tracks-list-header'
  header.innerHTML = `
    <span class="sortable" data-sort="title">Titre ${getSortIndicator('title')}</span>
    <span class="sortable" data-sort="artist">Artiste ${getSortIndicator('artist')}</span>
    <span class="sortable" data-sort="album">Album ${getSortIndicator('album')}</span>
    <span>Qualité</span>
    <span class="sortable" data-sort="duration">Duration ${getSortIndicator('duration')}</span>
  `

  // Ajoute les événements de clic pour le tri
  header.querySelectorAll('.sortable').forEach(span => {
    span.addEventListener('click', () => {
      const column = span.dataset.sort
      if (sortColumn === column) {
        sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'
      } else {
        sortColumn = column
        sortDirection = 'asc'
      }
      displayTracksGrid()
    })
  })

  tracksContainer.appendChild(header)

  // Conteneur de scroll avec hauteur fixe
  const scrollContainer = document.createElement('div')
  scrollContainer.className = 'virtual-scroll-container'
  scrollContainer.style.cssText = `
    flex: 1;
    overflow-y: auto;
    position: relative;
    contain: strict;
  `

  // Conteneur interne avec la hauteur totale (pour la scrollbar)
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

  // Sauvegarde les références et reset les indices pour forcer le rendu
  virtualScrollState.scrollContainer = scrollContainer
  virtualScrollState.contentContainer = contentContainer
  virtualScrollState.visibleStartIndex = -1  // Force le re-render
  virtualScrollState.visibleEndIndex = -1

  // Crée le pool de nœuds DOM réutilisables (recyclage au lieu de innerHTML)
  virtualScrollState.pool = []
  for (let i = 0; i < POOL_SIZE; i++) {
    const node = createPoolNode()
    node.style.display = 'none' // Caché par défaut
    contentContainer.appendChild(node)
    virtualScrollState.pool.push(node)
  }

  // Affiche le nombre de résultats si recherche
  if (searchQuery && totalTracks < tracks.length) {
    const countDiv = document.createElement('div')
    countDiv.className = 'search-results-count'
    countDiv.style.cssText = 'padding: 8px 16px; color: #666; font-size: 13px;'
    countDiv.textContent = `${totalTracks} result${totalTracks > 1 ? 's' : ''}`
    tracksContainer.insertBefore(countDiv, scrollContainer)
  }

  // Écoute le scroll avec throttling
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

  // === EVENT DELEGATION sur le conteneur de contenu ===

  // Drag & drop pour ajouter des tracks à une playlist
  contentContainer.addEventListener('mousedown', (e) => {
    const trackItem = e.target.closest('.tracks-list-item')
    if (!trackItem || e.target.closest('button')) return

    const trackPath = trackItem.dataset.trackPath
    const entry = tracksByPath.get(trackPath)  // O(1) lookup
    if (entry) {
      prepareCustomDrag(e, entry.track, trackItem)
    }
  })

  // Clic (avec support multi-sélection Cmd/Shift)
  contentContainer.addEventListener('click', (e) => {
    const trackItem = e.target.closest('.tracks-list-item')
    if (!trackItem) return

    const trackPath = trackItem.dataset.trackPath
    const entry = tracksByPath.get(trackPath)  // O(1) lookup
    if (!entry) return
    const track = entry.track

    // Bouton favori (cœur)
    const favBtn = e.target.closest('.track-favorite-btn')
    if (favBtn) {
      e.stopPropagation()
      toggleFavorite(track.path, favBtn)
      return
    }

    // Bouton toggle queue (ajouter/retirer)
    const addQueueBtn = e.target.closest('.tracks-list-add-queue')
    if (addQueueBtn) {
      e.stopPropagation()
      const isInQueue = queue.some(q => q.path === track.path)
      if (isInQueue) {
        // Retire de la queue
        const queueIndex = queue.findIndex(q => q.path === track.path)
        if (queueIndex !== -1) {
          removeFromQueue(queueIndex)
        }
        addQueueBtn.classList.remove('in-queue')
        addQueueBtn.title = 'Add to queue'
      } else {
        // Ajoute à la queue
        addToQueue(track)
        addQueueBtn.classList.add('in-queue')
        addQueueBtn.title = 'Remove from queue'
      }
      return
    }

    // Bouton ajouter à une playlist
    if (e.target.closest('.tracks-list-add-playlist')) {
      e.stopPropagation()
      showAddToPlaylistMenu(e, track)
      return
    }

    // === SÉLECTION AVEC SUPPORT CMD/SHIFT ===
    const { selectedTrackPaths, lastSelectedPath, filteredTracks } = virtualScrollState

    if (e.metaKey || e.ctrlKey) {
      // Cmd/Ctrl + Clic : Toggle sélection individuelle
      if (selectedTrackPaths.has(trackPath)) {
        selectedTrackPaths.delete(trackPath)
      } else {
        selectedTrackPaths.add(trackPath)
      }
      virtualScrollState.lastSelectedPath = trackPath
    } else if (e.shiftKey && lastSelectedPath) {
      // Shift + Clic : Sélection de plage
      const currentIndex = filteredTracks.findIndex(t => t.path === trackPath)
      const lastIndex = filteredTracks.findIndex(t => t.path === lastSelectedPath)

      if (currentIndex !== -1 && lastIndex !== -1) {
        const start = Math.min(currentIndex, lastIndex)
        const end = Math.max(currentIndex, lastIndex)

        // Ajoute toute la plage à la sélection
        for (let i = start; i <= end; i++) {
          selectedTrackPaths.add(filteredTracks[i].path)
        }
      }
    } else {
      // Clic simple : Sélection unique
      selectedTrackPaths.clear()
      selectedTrackPaths.add(trackPath)
      virtualScrollState.lastSelectedPath = trackPath
    }

    // Met à jour l'affichage visuel
    updateTrackSelectionDisplay()
  })

  // Double-clic = jouer la track
  contentContainer.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return

    const trackItem = e.target.closest('.tracks-list-item')
    if (!trackItem) return

    const trackPath = trackItem.dataset.trackPath
    const entry = tracksByPath.get(trackPath)  // O(1) lookup
    if (entry) {
      playTrack(entry.index)
    }
  })

  // Clic droit
  contentContainer.addEventListener('contextmenu', (e) => {
    const trackItem = e.target.closest('.tracks-list-item')
    if (!trackItem) return

    const trackPath = trackItem.dataset.trackPath
    const entry = tracksByPath.get(trackPath)  // O(1) lookup
    if (!entry) return

    showContextMenu(e, entry.track, entry.index)
  })

  // NOTE: Handler mousedown dupliqué supprimé (déjà géré ligne ~3885)

  albumsGridDiv.appendChild(tracksContainer)

  // Render initial APRÈS montage dans le DOM (sinon clientHeight = 0)
  requestAnimationFrame(() => {
    updateVirtualScrollItems()
  })
}

// Mise à jour légère du filtre (recherche) sans reconstruction DOM
// Évite de détruire le virtual scroll pendant la lecture audio
function updateTracksFilter() {
  // Fallback si le virtual scroll n'est pas initialisé
  if (!virtualScrollState.scrollContainer || !virtualScrollState.scrollContainer.isConnected) {
    displayTracksGrid()
    return
  }

  // Recalcule les tracks filtrées
  virtualScrollState.filteredTracks = getSortedAndFilteredTracks()
  const totalTracks = virtualScrollState.filteredTracks.length

  // Met à jour la hauteur du contenu virtuel (scrollbar)
  if (virtualScrollState.contentContainer) {
    virtualScrollState.contentContainer.style.height = (totalTracks * TRACK_ITEM_HEIGHT) + 'px'
  }

  // Met à jour le compteur de résultats si présent
  const existingCount = document.querySelector('.search-results-count')
  if (searchQuery && totalTracks < tracks.length) {
    if (existingCount) {
      existingCount.textContent = `${totalTracks} result${totalTracks > 1 ? 's' : ''}`
    }
  } else if (existingCount) {
    existingCount.remove()
  }

  // Reset scroll position et force re-render
  virtualScrollState.scrollContainer.scrollTop = 0
  virtualScrollState.visibleStartIndex = -1
  virtualScrollState.visibleEndIndex = -1
  updateVirtualScrollItems()
}

// Formate la qualité audio
// formatQuality → importé depuis utils.js

// Affiche le panel de détail d'un album sous la carte cliquée
function showAlbumDetail(albumKey, cover, clickedCard) {
  // Ferme le panel existant si ouvert
  closeAlbumDetail()

  selectedAlbumKey = albumKey
  const album = albums[albumKey]

  // Crée le panel
  albumDetailDiv = document.createElement('div')
  albumDetailDiv.className = 'album-detail'
  albumDetailDiv.id = 'album-detail'

  // Nombre de tracks et durée totale
  const totalDuration = album.tracks.reduce((acc, t) => acc + (t.metadata?.duration || 0), 0)

  // Qualité de l'album (basée sur la première track)
  const firstTrack = album.tracks[0]
  const albumQuality = formatQuality(firstTrack?.metadata, firstTrack?.path)
  const qualityTag = albumQuality.label !== '-'
    ? `<span class="quality-tag ${albumQuality.class}">${albumQuality.label}</span>`
    : ''

  // Note: le bitrate est maintenant inclus dans formatQuality pour les formats lossy
  // Plus besoin d'un tag bitrate séparé

  // Contenu du panel
  albumDetailDiv.innerHTML = `
    <div class="album-detail-header">
      <div class="album-detail-cover">
        ${isValidImageSrc(cover)
          ? `<img src="${cover}" alt="${album.album}">`
          : '<div class="album-cover-placeholder">♪</div>'
        }
      </div>
      <div class="album-detail-info">
        <h2 class="album-detail-title">${album.album}</h2>
        <p class="album-detail-artist">${album.artist}</p>
        <p class="album-detail-meta">
          ${album.tracks.length} titres • ${formatTime(totalDuration)}
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
      <button class="btn-close close-album-detail">✕</button>
    </div>
    <div class="album-tracks"></div>
  `

  // Chargement async du cover si pas en cache (fallback)
  if (!isValidImageSrc(cover) && album.coverPath) {
    const detailCoverContainer = albumDetailDiv.querySelector('.album-detail-cover')
    if (detailCoverContainer) {
      // Crée un élément img caché pour loadThumbnailAsync
      const hiddenImg = document.createElement('img')
      hiddenImg.style.display = 'none'
      detailCoverContainer.appendChild(hiddenImg)

      loadThumbnailAsync(album.coverPath, hiddenImg).then(() => {
        const cachedCover = coverCache.get(album.coverPath) || thumbnailCache.get(album.coverPath)
        if (isValidImageSrc(cachedCover) && detailCoverContainer) {
          const placeholder = detailCoverContainer.querySelector('.album-cover-placeholder')
          if (placeholder) {
            const newImg = document.createElement('img')
            newImg.src = cachedCover
            newImg.alt = album.album
            placeholder.replaceWith(newImg)
          }
          // Nettoie l'img cachée
          if (hiddenImg.parentNode) hiddenImg.remove()
        }
      })
    }
  }

  // Liste des tracks
  const albumTracksDiv = albumDetailDiv.querySelector('.album-tracks')
  album.tracks.forEach((track, index) => {
    const trackItem = document.createElement('div')
    trackItem.className = 'album-track-item'
    trackItem.dataset.trackPath = track.path

    const duration = track.metadata?.duration ? formatTime(track.metadata.duration) : '-:--'
    const trackArtist = track.metadata?.artist || 'Unknown Artist'

    // Vérifie si le track est déjà dans la queue
    const isInQueue = queue.some(q => q.path === track.path)
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

    // Affiche l'artiste si c'est un album multi-artistes
    if (album.isVariousArtists) {
      trackItem.innerHTML = `
        ${getFavoriteButtonHtml(track.path)}
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
        ${getFavoriteButtonHtml(track.path)}
        <span class="track-number">${track.metadata?.track || index + 1}</span>
        <span class="track-title">${track.metadata?.title || track.name}</span>
        <span class="track-duration">${duration}</span>
        ${buttonsHtml}
      `
    }

    albumTracksDiv.appendChild(trackItem)
  })

  // === EVENT DELEGATION pour les tracks de l'album ===
  albumTracksDiv.addEventListener('click', (e) => {
    const trackItem = e.target.closest('.album-track-item')
    if (!trackItem) return

    const trackPath = trackItem.dataset.trackPath
    const track = tracks.find(t => t.path === trackPath)
    if (!track) return

    // Bouton toggle queue (ajouter/retirer)
    const addQueueBtn = e.target.closest('.track-add-queue')
    if (addQueueBtn) {
      e.stopPropagation()
      const isInQueue = queue.some(q => q.path === track.path)
      if (isInQueue) {
        // Retire de la queue
        const queueIndex = queue.findIndex(q => q.path === track.path)
        if (queueIndex !== -1) {
          removeFromQueue(queueIndex)
        }
        addQueueBtn.classList.remove('in-queue')
        addQueueBtn.title = 'Add to queue'
      } else {
        // Ajoute à la queue
        addToQueue(track)
        addQueueBtn.classList.add('in-queue')
        addQueueBtn.title = 'Remove from queue'
      }
      return
    }

    // Bouton ajouter à une playlist
    if (e.target.closest('.track-add-playlist')) {
      e.stopPropagation()
      showAddToPlaylistMenu(e, track)
      return
    }

    // Bouton favori
    const favBtn = e.target.closest('.track-favorite-btn')
    if (favBtn) {
      e.stopPropagation()
      toggleFavorite(track.path, favBtn)
      return
    }

    // Simple clic = sélectionner la track
    albumTracksDiv.querySelectorAll('.album-track-item.selected').forEach(el => {
      el.classList.remove('selected')
    })
    trackItem.classList.add('selected')
  })

  // Double-clic = jouer la track
  albumTracksDiv.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return

    const trackItem = e.target.closest('.album-track-item')
    if (!trackItem) return

    const trackPath = trackItem.dataset.trackPath
    const globalIndex = tracks.findIndex(t => t.path === trackPath)
    if (globalIndex !== -1) {
      playTrack(globalIndex)
      updateAlbumTracksHighlight()
    }
  })

  albumTracksDiv.addEventListener('contextmenu', (e) => {
    const trackItem = e.target.closest('.album-track-item')
    if (!trackItem) return

    const trackPath = trackItem.dataset.trackPath
    const track = tracks.find(t => t.path === trackPath)
    if (!track) return

    const globalIndex = tracks.findIndex(t => t.path === trackPath)
    showContextMenu(e, track, globalIndex)
  })

  // Drag custom pour les tracks d'album
  albumTracksDiv.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return

    const trackItem = e.target.closest('.album-track-item')
    if (!trackItem) return

    const trackPath = trackItem.dataset.trackPath
    const track = tracks.find(t => t.path === trackPath)
    if (!track) return

    prepareCustomDrag(e, track, trackItem)
  })

  // Menu contextuel sur le header de l'album pour créer une playlist
  albumDetailDiv.querySelector('.album-detail-header').addEventListener('contextmenu', (e) => {
    e.preventDefault()
    showAlbumContextMenu(e, albumKey)
  })

  // Event listeners pour le panel
  albumDetailDiv.querySelector('.close-album-detail').addEventListener('click', closeAlbumDetail)
  albumDetailDiv.querySelector('.play-album-btn').addEventListener('click', () => {
    if (selectedAlbumKey) playAlbum(selectedAlbumKey)
  })
  albumDetailDiv.querySelector('.add-album-queue-btn').addEventListener('click', () => {
    if (selectedAlbumKey) {
      const album = albums[selectedAlbumKey]
      album.tracks.forEach(track => addToQueue(track))
      showQueueNotification(`${album.tracks.length} tracks added to queue`)
    }
  })

  // Insère le panel après la rangée de l'album cliqué
  const gridContainer = clickedCard.closest('.albums-grid-container')
  if (gridContainer) {
    // Trouve tous les albums dans la grille
    const allCards = Array.from(gridContainer.querySelectorAll('.album-card'))
    const clickedIndex = allCards.indexOf(clickedCard)

    // Calcule le nombre de cartes par rangée
    const gridStyle = window.getComputedStyle(gridContainer)
    const gridColumns = gridStyle.gridTemplateColumns.split(' ').length

    // Trouve la dernière carte de la rangée
    const rowEnd = Math.ceil((clickedIndex + 1) / gridColumns) * gridColumns - 1
    const lastCardInRow = allCards[Math.min(rowEnd, allCards.length - 1)]

    // Insère le panel après la dernière carte de la rangée
    lastCardInRow.after(albumDetailDiv)
  } else {
    // Fallback : ajoute à la fin de la grille
    albumsGridDiv.appendChild(albumDetailDiv)
  }

  // Scroll vers le panel
  setTimeout(() => {
    albumDetailDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, 50)

  // Met à jour le highlight si une track est en cours
  updateAlbumTracksHighlight()
}

// Met à jour le highlight de la track en cours dans le panel
function updateAlbumTracksHighlight() {
  if (!selectedAlbumKey || !albumDetailDiv) return

  const album = albums[selectedAlbumKey]
  const trackItems = albumDetailDiv.querySelectorAll('.album-track-item')

  trackItems.forEach((item, index) => {
    const track = album.tracks[index]
    const globalIndex = tracks.findIndex(t => t.path === track.path)
    item.classList.toggle('playing', globalIndex === currentTrackIndex)
  })
}

// Ferme le panel de détail
function closeAlbumDetail() {
  if (albumDetailDiv) {
    albumDetailDiv.remove()
    albumDetailDiv = null
  }
  selectedAlbumKey = null
}

// Joue un album entier (premier morceau)
function playAlbum(albumKey) {
  if (!albumKey) return
  const album = albums[albumKey]
  if (!album || !album.tracks || album.tracks.length === 0) return

  const firstTrack = album.tracks[0]
  const globalIndex = tracks.findIndex(t => t.path === firstTrack.path)
  if (globalIndex !== -1) {
    playTrack(globalIndex)
    updateAlbumTracksHighlight()
  }
}

// === LECTURE D'UN MORCEAU ===
async function playTrack(index) {
  // Validation des entrées
  if (index < 0 || index >= tracks.length) {
    console.error('playTrack: index invalide', index)
    return
  }

  // Reset complet de l'UI AVANT tout (évite les états incohérents)
  resetPlayerUI()
  gaplessPreloadTriggered = false

  currentTrackIndex = index
  const track = tracks[index]

  if (!track || !track.path) {
    console.error('playTrack: track invalide', track)
    return
  }

  // Met à jour l'affichage avec les métadonnées
  const title = track.metadata?.title || track.name || 'Titre inconnu'
  const artist = track.metadata?.artist || track.folder || 'Unknown Artist'
  trackNameEl.textContent = title
  trackFolderEl.textContent = artist

  // Affiche les specs techniques (bitrate/sample rate)
  const trackQualityEl = document.getElementById('track-quality')
  if (trackQualityEl) {
    const quality = formatQuality(track.metadata, track.path)
    trackQualityEl.textContent = quality.label !== '-' ? quality.label : ''
  }

  // Charge la pochette (depuis le cache si possible)
  let cover = coverCache.get(track.path)
  if (cover === undefined) {
    // 1. Essaie d'abord la pochette embarquée
    cover = await invoke('get_cover', { path: track.path })

    // 2. Si pas de pochette, cherche sur Internet
    if (!cover && track.metadata) {
      cover = await invoke('fetch_internet_cover', {
        artist: track.metadata.artist || 'Unknown Artist',
        album: track.metadata.album || 'Unknown Album'
      })
    }

    coverCache.set(track.path, cover)
  }

  if (isValidImageSrc(cover)) {
    const img = document.createElement('img')
    img.src = cover
    img.onerror = () => {
      coverArtEl.innerHTML = '<div class="cover-placeholder">♪</div>'
    }
    coverArtEl.innerHTML = ''
    coverArtEl.appendChild(img)
  } else {
    coverArtEl.innerHTML = '<div class="cover-placeholder">♪</div>'
  }

  // === AUDIO ENGINE RUST : Joue le fichier via le backend (STREAMING) ===
  try {
    // Joue via le moteur Rust (non-bloquant, démarre après ~100ms de buffer)
    await invoke('audio_play', { path: track.path })
    audioIsPlaying = true
    // La durée sera mise à jour via l'événement playback_progress
    // Utilise la durée des métadonnées comme estimation initiale
    const estimatedDuration = track.metadata?.duration || 0
    audioDurationFromRust = estimatedDuration
    durationEl.textContent = estimatedDuration > 0 ? formatTime(estimatedDuration) : '--:--'
    console.log('Streaming started (Rust):', track.path)
  } catch (e) {
    console.error('Rust audio_play error:', e)
    // No HTML5 fallback - Rust is the only audio path
    audioIsPlaying = false
  }
  playPauseBtn.textContent = audioIsPlaying ? '⏸' : '▶'

  // Note: resetPlayerUI() est appelé en début de fonction

  // Note: gapless preload is now triggered by playback_progress when < 10s remaining

  // Track l'album en cours de lecture (utilise le nom d'album seul comme clé, cohérent avec groupTracksIntoAlbumsAndArtists)
  currentPlayingAlbumKey = track.metadata?.album || 'Unknown Album'

  // Affiche le lecteur
  playerDiv.classList.remove('hidden')
  document.body.classList.add('player-visible')

  // Met à jour le highlight dans le panel album si ouvert
  updateAlbumTracksHighlight()

  // Met à jour la section "Lecture en cours" de la Home si visible
  updateHomeNowPlayingSection()

  // Met à jour la vue fullscreen si ouverte
  setFullscreenPlayState(true)
  syncFsPlayPauseIcon(true)
  // Petit délai pour laisser la cover se charger avant d'extraire les couleurs
  setTimeout(() => updateFullscreenData(), 200)

  // Enregistre la lecture dans l'historique et invalide le cache Home
  invoke('record_play', {
    path: track.path,
    artist: track.metadata?.artist || 'Unknown Artist',
    album: track.metadata?.album || '',
    title: track.metadata?.title || track.name
  }).then(() => {
    invalidateHomeCache()  // Les stats ont changé, invalide le cache
  }).catch(err => console.error('Erreur enregistrement historique:', err))
}

// === GAPLESS PRELOAD ===

function getNextTrackPath() {
  // Queue priority
  if (queue.length > 0) return queue[0].path

  // Repeat one = same track
  if (repeatMode === 'one' && currentTrackIndex >= 0) return tracks[currentTrackIndex]?.path

  const currentTrack = tracks[currentTrackIndex]
  if (!currentTrack) return null

  const currentFolder = currentTrack.path.substring(0, currentTrack.path.lastIndexOf('/'))
  const albumTracks = tracks.filter(t => {
    const folder = t.path.substring(0, t.path.lastIndexOf('/'))
    return folder === currentFolder && t.metadata?.album === currentTrack.metadata?.album
  }).sort((a, b) => {
    const discA = a.metadata?.disc || 1
    const discB = b.metadata?.disc || 1
    if (discA !== discB) return discA - discB
    return (a.metadata?.track || 0) - (b.metadata?.track || 0)
  })

  const idx = albumTracks.findIndex(t => t.path === currentTrack.path)
  if (idx >= 0 && idx < albumTracks.length - 1) {
    return albumTracks[idx + 1].path
  }

  // End of album — repeat all wraps, otherwise null
  if (repeatMode === 'all' && albumTracks.length > 0) {
    return albumTracks[0].path
  }
  return null
}

function getNextTrackInfo() {
  // Queue priority
  if (queue.length > 0) {
    const q = queue[0]
    return { title: q.title || q.metadata?.title || '', artist: q.artist || q.metadata?.artist || '' }
  }

  const nextPath = getNextTrackPath()
  if (!nextPath) return null

  const nextTrack = tracks.find(t => t.path === nextPath)
  if (!nextTrack) return null

  return {
    title: nextTrack.metadata?.title || nextTrack.path.split('/').pop().replace(/\.[^.]+$/, ''),
    artist: nextTrack.metadata?.artist || ''
  }
}

function triggerGaplessPreload() {
  const gaplessEnabled = localStorage.getItem('settings_gapless') !== 'false'
  if (!gaplessEnabled) return

  const nextPath = getNextTrackPath()
  if (!nextPath) return

  console.log('[Gapless] Preloading:', nextPath)
  invoke('audio_preload_next', { path: nextPath }).catch(e => {
    console.log('[Gapless] Preload failed (non-critical):', e)
  })
}

// === CONTRÔLES DU LECTEUR ===

// Flag pour éviter les appels multiples pendant le toggle
let isTogglingPlayState = false
let lastToggleAction = null  // 'pause' ou 'resume' - pour éviter l'action inverse trop rapide

// Fonction toggle play/pause (réutilisable par raccourcis clavier)
async function togglePlay() {
  // Si pas de track sélectionnée, essayer de charger la dernière jouée ou la première
  if (currentTrackIndex < 0 || !tracks[currentTrackIndex]) {
    if (tracks.length === 0) return  // Pas de musique du tout

    try {
      // Essayer de récupérer la dernière track jouée
      const lastPlayed = await invoke('get_last_played')
      if (lastPlayed && lastPlayed.path) {
        const index = tracks.findIndex(t => t.path === lastPlayed.path)
        if (index >= 0) {
          playTrack(index)
          return
        }
      }
    } catch (e) {
      console.log('[togglePlay] Could not get last played:', e)
    }

    // Fallback : jouer la première track
    playTrack(0)
    return
  }

  // Évite les appels multiples rapides (debounce strict)
  if (isTogglingPlayState) {
    console.log('[togglePlay] Debounce - ignoring call')
    return
  }
  isTogglingPlayState = true

  // Détermine l'action à effectuer basée sur l'état Rust (source de vérité)
  const shouldResume = isPausedFromRust || !audioIsPlaying
  const action = shouldResume ? 'resume' : 'pause'

  // Protection supplémentaire : évite d'envoyer la même action 2 fois de suite
  // ou une action inverse immédiatement après (symptôme du bug double-entrée)
  if (lastToggleAction === action) {
    console.log('[togglePlay] Same action already pending:', action)
    isTogglingPlayState = false
    return
  }

  lastToggleAction = action
  console.log('[togglePlay] Action:', action, '| isPausedFromRust:', isPausedFromRust, '| audioIsPlaying:', audioIsPlaying)

  try {
    if (shouldResume) {
      // PLAY / RESUME via Rust
      await invoke('audio_resume')
      // L'état sera mis à jour par l'événement playback_resumed
    } else {
      // PAUSE via Rust
      await invoke('audio_pause')
      // L'état sera mis à jour par l'événement playback_paused
    }
  } catch (e) {
    console.error('[togglePlay] Error:', e)
  }

  // Met à jour le composant Home si visible
  updateHomeNowPlayingSection()

  // Réactive après un délai plus long pour être sûr que l'événement Rust est arrivé
  setTimeout(() => {
    isTogglingPlayState = false
    lastToggleAction = null  // Reset pour permettre la prochaine action
  }, 250)
}

playPauseBtn.addEventListener('click', togglePlay)

// Fonction pour jouer le morceau précédent (réutilisable par raccourcis clavier)
function playPreviousTrack() {
  const currentTrack = tracks[currentTrackIndex]
  const currentFolder = currentTrack?.path ? currentTrack.path.substring(0, currentTrack.path.lastIndexOf('/')) : null

  // Filtre les tracks qui sont dans le même dossier ET ont le même album metadata
  const albumTracks = currentFolder ? tracks.filter(t => {
    const folder = t.path.substring(0, t.path.lastIndexOf('/'))
    return (folder === currentFolder || (t.metadata?.album === currentTrack?.metadata?.album && t.metadata?.artist === currentTrack?.metadata?.artist))
  }).sort((a, b) => {
    const discA = a.metadata?.disc || 1
    const discB = b.metadata?.disc || 1
    if (discA !== discB) return discA - discB
    const trackA = a.metadata?.track || 0
    const trackB = b.metadata?.track || 0
    if (trackA !== trackB) return trackA - trackB
    return (a.name || '').localeCompare(b.name || '')
  }) : []

  const currentAlbumTrackIndex = albumTracks.findIndex(t => t.path === currentTrack?.path)

  console.log('playPreviousTrack DEBUG:', {
    currentAlbumTrackIndex,
    albumTracksCount: albumTracks.length,
    currentFolder
  })

  if (albumTracks.length > 0 && currentAlbumTrackIndex > 0) {
    // Track précédente dans l'album
    const prevAlbumTrack = albumTracks[currentAlbumTrackIndex - 1]
    const globalIndex = tracks.findIndex(t => t.path === prevAlbumTrack.path)
    console.log('Playing previous album track:', { prevTrack: prevAlbumTrack?.metadata?.title, globalIndex })
    if (globalIndex !== -1) {
      playTrack(globalIndex)
      return
    }
  } else if (albumTracks.length > 0 && currentAlbumTrackIndex === 0 && repeatMode === 'all') {
    // Début de l'album + repeat all = va à la dernière track de l'album
    const lastTrack = albumTracks[albumTracks.length - 1]
    const globalIndex = tracks.findIndex(t => t.path === lastTrack.path)
    if (globalIndex !== -1) {
      playTrack(globalIndex)
      return
    }
  }

  // Fallback: comportement global
  if (currentTrackIndex > 0) {
    playTrack(currentTrackIndex - 1)
  }
}

// Morceau précédent
prevBtn.addEventListener('click', playPreviousTrack)

// Morceau suivant
nextBtn.addEventListener('click', () => {
  playNextTrack()
})

// === CLICK SUR COVER ART = Navigation vers l'album ===
// Simple clic = aller à l'album, Double-clic = fullscreen player
let coverClickTimer = null
coverArtEl.addEventListener('click', () => {
  // Si on était en train de drag, ne pas naviguer
  if (customDragState.isDragging) return

  if (!currentPlayingAlbumKey || currentTrackIndex < 0) return

  // Attendre pour distinguer simple clic vs double-clic
  if (coverClickTimer) {
    clearTimeout(coverClickTimer)
    coverClickTimer = null
    return // Le dblclick handler s'en charge
  }

  coverClickTimer = setTimeout(() => {
    coverClickTimer = null
    const album = albums[currentPlayingAlbumKey]
    if (!album) {
      console.log('Album not found for key:', currentPlayingAlbumKey)
      return
    }
    navigateToAlbumPage(currentPlayingAlbumKey)
  }, 250)
})

coverArtEl.addEventListener('dblclick', () => {
  if (customDragState.isDragging) return
  if (currentTrackIndex < 0) return
  if (coverClickTimer) {
    clearTimeout(coverClickTimer)
    coverClickTimer = null
  }
  openFullscreenPlayer()
})

// Sync fullscreen play/pause icon with current state
function syncFsPlayPauseIcon(playing) {
  const iconPlay = document.getElementById('fs-icon-play')
  const iconPause = document.getElementById('fs-icon-pause')
  if (iconPlay) iconPlay.style.display = playing ? 'none' : ''
  if (iconPause) iconPause.style.display = playing ? '' : 'none'
}

// === FULLSCREEN PLAYER INIT ===
setNextTrackInfoCallback(() => getNextTrackInfo())
setCurrentTrackPathCallback(() => currentTrackIndex >= 0 && tracks[currentTrackIndex] ? tracks[currentTrackIndex].path : null)

document.getElementById('fs-close')?.addEventListener('click', () => {
  closeFullscreenPlayer()
})

// Fullscreen controls — prev / play-pause / next
document.getElementById('fs-prev')?.addEventListener('click', () => playPreviousTrack())
document.getElementById('fs-next-btn')?.addEventListener('click', () => playNextTrack())
document.getElementById('fs-play-pause')?.addEventListener('click', () => togglePlay())

// Fullscreen progress bar — seek
const fsProgressBar = document.getElementById('fs-progress')
let fsIsSeeking = false
if (fsProgressBar) {
  fsProgressBar.addEventListener('input', () => {
    fsIsSeeking = true
    const duration = getCurrentTrackDuration()
    const time = (fsProgressBar.value / 100) * duration
    document.getElementById('fs-current-time').textContent = formatTime(time)
  })
  fsProgressBar.addEventListener('change', () => {
    // Sync to main progress bar and trigger seek
    progressBar.value = fsProgressBar.value
    performSeek()
    fsIsSeeking = false
  })
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isFullscreenOpen()) {
    e.preventDefault()
    e.stopPropagation()
    closeFullscreenPlayer()
  }
})

// === DRAG FROM COVER ART = Ajouter le track en cours à une playlist ===
coverArtEl.addEventListener('mousedown', (e) => {
  if (currentTrackIndex < 0) return

  const currentTrack = tracks[currentTrackIndex]
  if (!currentTrack) return

  prepareCustomDrag(e, currentTrack, coverArtEl)
})

// Fonction pour jouer le morceau suivant (gère queue + shuffle + repeat + album context)
function playNextTrack() {
  // 1. Priorité : vérifie la file d'attente
  if (queue.length > 0) {
    const nextTrack = queue.shift() // Retire le premier de la queue
    const globalIndex = tracks.findIndex(t => t.path === nextTrack.path)
    if (globalIndex !== -1) {
      playTrack(globalIndex)
      updateQueueDisplay()
      updateQueueIndicators()
      return
    }
  }

  // 2. Récupère les tracks de l'album en cours
  // Match par dossier OU par métadonnées album+artiste (pour albums multi-CD dans des sous-dossiers)
  const currentTrack = tracks[currentTrackIndex]
  const currentFolder = currentTrack?.path ? currentTrack.path.substring(0, currentTrack.path.lastIndexOf('/')) : null

  // Filtre les tracks du même album: même dossier OU même album+artiste (multi-CD)
  const albumTracks = currentFolder ? tracks.filter(t => {
    const folder = t.path.substring(0, t.path.lastIndexOf('/'))
    return (folder === currentFolder || (t.metadata?.album === currentTrack?.metadata?.album && t.metadata?.artist === currentTrack?.metadata?.artist))
  }).sort((a, b) => {
    const discA = a.metadata?.disc || 1
    const discB = b.metadata?.disc || 1
    if (discA !== discB) return discA - discB
    const trackA = a.metadata?.track || 0
    const trackB = b.metadata?.track || 0
    if (trackA !== trackB) return trackA - trackB
    return (a.name || '').localeCompare(b.name || '')
  }) : []

  // Trouve l'index du track actuel dans l'album
  const currentAlbumTrackIndex = albumTracks.findIndex(t => t.path === currentTrack?.path)

  // DEBUG
  console.log('playNextTrack DEBUG:', {
    currentFolder,
    albumTracksCount: albumTracks.length,
    currentTrackPath: currentTrack?.path,
    currentAlbumTrackIndex,
    shuffleMode,
    repeatMode
  })

  // 3. Gestion des modes shuffle (seulement si le track actuel est bien dans l'album)
  if (shuffleMode === 'album' && albumTracks.length > 1 && currentAlbumTrackIndex !== -1) {
    // Shuffle dans l'album uniquement - évite les doublons
    const availableTracks = albumTracks.filter(t => !shufflePlayedTracks.has(t.path))

    if (availableTracks.length === 0) {
      // Tous les tracks ont été joués, on reset et on recommence
      shufflePlayedTracks.clear()
      if (currentTrack) shufflePlayedTracks.add(currentTrack.path)
      // Re-filter après reset
      const freshTracks = albumTracks.filter(t => !shufflePlayedTracks.has(t.path))
      if (freshTracks.length > 0) {
        const randomTrack = freshTracks[Math.floor(Math.random() * freshTracks.length)]
        shufflePlayedTracks.add(randomTrack.path)
        const globalIndex = tracks.findIndex(t => t.path === randomTrack.path)
        if (globalIndex !== -1) {
          playTrack(globalIndex)
          return
        }
      }
    } else {
      // Choisir parmi les tracks non encore joués
      const randomTrack = availableTracks[Math.floor(Math.random() * availableTracks.length)]
      shufflePlayedTracks.add(randomTrack.path)
      const globalIndex = tracks.findIndex(t => t.path === randomTrack.path)
      if (globalIndex !== -1) {
        playTrack(globalIndex)
        return
      }
    }
  } else if (shuffleMode === 'library') {
    // Shuffle sur toute la bibliothèque - évite les doublons
    const availableTracks = tracks.filter(t => !shufflePlayedTracks.has(t.path))

    if (availableTracks.length === 0) {
      // Tous les tracks ont été joués, on reset
      shufflePlayedTracks.clear()
      if (currentTrack) shufflePlayedTracks.add(currentTrack.path)
      const freshTracks = tracks.filter(t => !shufflePlayedTracks.has(t.path))
      if (freshTracks.length > 0) {
        const randomTrack = freshTracks[Math.floor(Math.random() * freshTracks.length)]
        shufflePlayedTracks.add(randomTrack.path)
        const globalIndex = tracks.findIndex(t => t.path === randomTrack.path)
        playTrack(globalIndex)
        return
      }
    } else {
      const randomTrack = availableTracks[Math.floor(Math.random() * availableTracks.length)]
      shufflePlayedTracks.add(randomTrack.path)
      const globalIndex = tracks.findIndex(t => t.path === randomTrack.path)
      playTrack(globalIndex)
      return
    }
  }

  // 4. Mode séquentiel : track suivante dans l'album
  if (albumTracks.length > 0 && currentAlbumTrackIndex !== -1) {
    // On est dans un album, on joue le track suivant de l'album
    if (currentAlbumTrackIndex < albumTracks.length - 1) {
      // Track suivante dans l'album
      const nextAlbumTrack = albumTracks[currentAlbumTrackIndex + 1]
      const globalIndex = tracks.findIndex(t => t.path === nextAlbumTrack.path)
      console.log('playNextTrack: playing next album track', {
        nextAlbumTrack: nextAlbumTrack?.name,
        globalIndex,
        currentAlbumTrackIndex,
        albumTracksLength: albumTracks.length
      })
      if (globalIndex !== -1) {
        playTrack(globalIndex)
        return
      }
    } else if (repeatMode === 'all') {
      // Fin de l'album + repeat all = retour au début de l'album
      const firstTrack = albumTracks[0]
      const globalIndex = tracks.findIndex(t => t.path === firstTrack.path)
      console.log('playNextTrack: repeat all - back to first track', { globalIndex })
      if (globalIndex !== -1) {
        playTrack(globalIndex)
        return
      }
    } else {
      // Fin de l'album, pas de repeat
      console.log('playNextTrack: end of album, no repeat - stopping')
    }
  } else {
    // Pas d'album ou track non trouvé dans l'album - comportement séquentiel global
    console.log('playNextTrack: fallback to global sequential', {
      hasAlbum: !!currentAlbum,
      currentAlbumTrackIndex,
      currentTrackIndex,
      tracksLength: tracks.length
    })
    if (currentTrackIndex < tracks.length - 1) {
      console.log('playNextTrack: playing global next track', { nextIndex: currentTrackIndex + 1 })
      playTrack(currentTrackIndex + 1)
      return
    } else if (repeatMode === 'all') {
      console.log('playNextTrack: repeat all - back to track 0')
      playTrack(0)
      return
    }
  }

  // Fin de lecture
  console.log('playNextTrack: END OF PLAYBACK - no next track to play')
  playPauseBtn.textContent = '▶'
}

// Obtient la durée correcte du track (Rust prioritaire, sinon audio element)
function getCurrentTrackDuration() {
  // Priorité : durée du moteur Rust
  if (audioDurationFromRust > 0) {
    return audioDurationFromRust
  }

  // Fallback : métadonnées
  const track = tracks[currentTrackIndex]
  const metadataDuration = track?.metadata?.duration
  if (metadataDuration && metadataDuration > 0) {
    return metadataDuration
  }

  return 0
}

// === LISTENERS ÉVÉNEMENTS AUDIO RUST ===
// Ces événements sont émis par le moteur Rust

// === INTERPOLATION FLUIDE (60 FPS) ===
// Variables pour l'interpolation entre les updates Rust (100ms)
let lastRustPosition = 0           // Dernière position reçue de Rust
let lastRustTimestamp = 0          // Timestamp de la dernière update Rust
let interpolationAnimationId = null // ID de requestAnimationFrame
let isSeekingUI = false            // Flag pour éviter l'interpolation pendant le seek
let isPausedFromRust = false       // État de pause reçu de Rust
let lastDisplayedPosition = 0      // Dernière position affichée (pour lissage)
let seekTimeoutId = null           // Timeout de sécurité pour réactiver l'interpolation après seek
let seekPending = false            // True si un seek est en attente (évite les doubles)
let isUserDragging = false         // True pendant que l'utilisateur drag la progress bar
let seekTargetPosition = 0         // Position demandée lors du seek (ne change pas pendant l'attente)

// Constantes de lissage
const MAX_INTERPOLATION_DELTA = 0.15  // Max 150ms d'interpolation (évite les sauts)
const SMOOTHING_FACTOR = 0.3          // Facteur de lissage pour transitions douces

// Démarre l'interpolation fluide
function startPositionInterpolation() {
  if (interpolationAnimationId) return // Déjà en cours

  function interpolate() {
    // Continue toujours la boucle pour réagir aux changements d'état
    interpolationAnimationId = requestAnimationFrame(interpolate)

    // Ne met pas à jour si pas en lecture ou en seek
    if (!audioIsPlaying || isSeekingUI || isPausedFromRust) {
      return
    }

    const now = performance.now()
    const elapsed = (now - lastRustTimestamp) / 1000 // En secondes
    const duration = audioDurationFromRust

    if (duration <= 0 || lastRustTimestamp === 0) {
      return
    }

    // Borne l'interpolation pour éviter les sauts (max 150ms depuis dernière update Rust)
    const boundedElapsed = Math.min(elapsed, MAX_INTERPOLATION_DELTA)

    // Calcule la position cible
    const targetPosition = Math.min(lastRustPosition + boundedElapsed, duration)

    // Lissage : approche progressivement la position cible (évite les micro-saccades)
    const smoothedPosition = lastDisplayedPosition +
      (targetPosition - lastDisplayedPosition) * SMOOTHING_FACTOR

    // Clamp final
    const clampedPosition = Math.max(0, Math.min(smoothedPosition, duration))
    lastDisplayedPosition = clampedPosition

    // Met à jour l'affichage
    const percent = (clampedPosition / duration) * 100
    progressBar.value = Math.min(percent, 100)
    currentTimeEl.textContent = formatTime(clampedPosition)
    updateProgressBarStyle(percent)

    // Sync fullscreen progress bar & time
    if (isFullscreenOpen() && !fsIsSeeking) {
      const fsProg = document.getElementById('fs-progress')
      const fsCur = document.getElementById('fs-current-time')
      const fsDur = document.getElementById('fs-duration')
      if (fsProg) fsProg.value = Math.min(percent, 100)
      if (fsCur) fsCur.textContent = formatTime(clampedPosition)
      if (fsDur) fsDur.textContent = formatTime(duration)
    }
  }

  interpolationAnimationId = requestAnimationFrame(interpolate)
}

// Arrête l'interpolation
function stopPositionInterpolation() {
  if (interpolationAnimationId) {
    cancelAnimationFrame(interpolationAnimationId)
    interpolationAnimationId = null
  }
}

// Synchronise immédiatement avec une position Rust (appelé sur événement)
// IMPORTANT: Ignore les updates pendant un seek pour éviter le "snap back"
function syncToRustPosition(position) {
  // Si on est en seek, vérifie si la position Rust correspond à notre seek
  if (isSeekingUI) {
    // Compare avec seekTargetPosition (la position DEMANDÉE, pas interpolée)
    // Tolérance de 1 seconde car le décodeur peut seek légèrement avant/après
    const seekDelta = Math.abs(position - seekTargetPosition)
    if (seekDelta < 1.0) {
      // La position Rust correspond à notre seek → le seek a abouti !
      console.log(`[Sync] Seek confirmed: Rust at ${position.toFixed(2)}s (target was ${seekTargetPosition.toFixed(2)}s, delta: ${seekDelta.toFixed(3)}s)`)

      // Réactive l'interpolation immédiatement maintenant que le seek est confirmé
      isSeekingUI = false
      seekPending = false

      // Annule le timeout de sécurité
      if (seekTimeoutId) {
        clearTimeout(seekTimeoutId)
        seekTimeoutId = null
      }

      // Met à jour la position avec la vraie position de Rust
      lastRustPosition = position
      lastRustTimestamp = performance.now()
      lastDisplayedPosition = position
    } else {
      // La position Rust est loin de notre seek → ignorer (ancienne position)
      console.log(`[Sync] Ignoring stale position: ${position.toFixed(2)}s (seek target: ${seekTargetPosition.toFixed(2)}s)`)
      return
    }
  } else {
    // Pas en seek, synchronisation normale
    lastRustPosition = position
    lastRustTimestamp = performance.now()
    lastDisplayedPosition = position
  }
}

// === RESET UI COMPLET (appelé à chaque changement de piste) ===
// Remet tous les compteurs et l'affichage à zéro
function resetPlayerUI() {
  // Reset des variables d'interpolation
  lastRustPosition = 0
  lastRustTimestamp = 0
  lastDisplayedPosition = 0
  audioPositionFromRust = 0
  isSeekingUI = false
  isPausedFromRust = false

  // Annule le timeout de seek si actif
  if (seekTimeoutId) {
    clearTimeout(seekTimeoutId)
    seekTimeoutId = null
  }
  seekPending = false

  // Reset de l'affichage
  progressBar.value = 0
  updateProgressBarStyle(0)
  currentTimeEl.textContent = '0:00'

  // Reset du moniteur audio specs
  resetAudioSpecs()

  console.log('Player UI reset complete')
}

// === MONITEUR AUDIO SPECS (SOURCE vs OUTPUT) ===
// Formate un sample rate pour l'affichage (ex: 96000 → "96kHz")
function formatSampleRate(hz) {
  if (hz >= 1000) {
    const khz = hz / 1000
    // Affiche sans décimale si c'est un nombre rond
    return khz % 1 === 0 ? `${khz}kHz` : `${khz.toFixed(1)}kHz`
  }
  return `${hz}Hz`
}

// Met à jour l'affichage des specs audio
function updateAudioSpecs(specs) {
  const container = document.getElementById('audio-specs')
  const sourceEl = document.getElementById('source-specs')
  const outputEl = document.getElementById('output-specs')

  if (!container || !sourceEl || !outputEl) return

  // Formater les valeurs SOURCE
  sourceEl.textContent = `${formatSampleRate(specs.source_sample_rate)}/${specs.source_bit_depth}bit`

  // Formater OUTPUT - avec "(resampled)" si conversion active
  if (specs.is_mismatch) {
    outputEl.textContent = `${formatSampleRate(specs.output_sample_rate)} ↓`
  } else {
    outputEl.textContent = formatSampleRate(specs.output_sample_rate)
  }

  // Alerte visuelle selon le match/mismatch
  container.classList.remove('bit-perfect', 'mismatch', 'resampled')
  if (specs.is_mismatch) {
    // Resampling actif = cyan (pas rouge, car le resampling fonctionne correctement)
    container.classList.add('resampled')
    console.log(`🔄 Resampled: ${specs.source_sample_rate}Hz → ${specs.output_sample_rate}Hz`)
  } else {
    container.classList.add('bit-perfect')
    console.log(`✓ Bit-perfect: ${specs.source_sample_rate}Hz/${specs.source_bit_depth}bit`)
  }

  // Met à jour les specs dans le fullscreen player
  updateFullscreenData()
}

// Reset du moniteur audio specs
function resetAudioSpecs() {
  const container = document.getElementById('audio-specs')
  const sourceEl = document.getElementById('source-specs')
  const outputEl = document.getElementById('output-specs')

  if (container) container.classList.remove('bit-perfect', 'mismatch', 'resampled')
  if (sourceEl) sourceEl.textContent = '-'
  if (outputEl) outputEl.textContent = '-'
}

// Écoute la progression de lecture depuis Rust
async function initRustAudioListeners() {
  // Progression de lecture (émis ~10 fois par seconde par Rust)
  await listen('playback_progress', (event) => {
    const { position, duration, rms } = event.payload

    // Met à jour les variables globales
    audioPositionFromRust = position
    audioDurationFromRust = duration

    // Forward RMS energy to fullscreen player visualisation
    if (rms !== undefined) setFullscreenRms(rms)

    // Synchronise l'interpolation avec la position Rust
    syncToRustPosition(position)

    // Met à jour la durée (ne change pas souvent)
    durationEl.textContent = formatTime(duration)

    // NOTE: Ne PAS réactiver isSeekingUI ici !
    // Le timeout de performSeek() (150ms) gère la réactivation.
    // Réactiver ici causait un bug où le curseur revenait en arrière
    // car l'interpolation redémarrait trop tôt (~3ms au lieu de 150ms).

    // Marque qu'on n'est pas en pause (on reçoit des updates)
    isPausedFromRust = false

    // Filet de sécurité : redémarre la boucle RAF si elle a été stoppée
    if (!interpolationAnimationId) {
      startPositionInterpolation()
    }

    // Gapless: preload next track when < 10s remaining
    const remaining = duration - position
    if (remaining > 0 && remaining < 10 && !gaplessPreloadTriggered && audioIsPlaying) {
      gaplessPreloadTriggered = true
      triggerGaplessPreload()
    }
  })

  // Seeking en cours (émis par Rust quand un seek démarre)
  await listen('playback_seeking', (event) => {
    const targetPosition = event.payload
    isSeekingUI = true
    seekTargetPosition = targetPosition  // Met à jour la cible pour syncToRustPosition

    // Met à jour l'UI immédiatement avec la position cible
    lastRustPosition = targetPosition
    lastRustTimestamp = performance.now()
    lastDisplayedPosition = targetPosition

    if (audioDurationFromRust > 0) {
      const percent = (targetPosition / audioDurationFromRust) * 100
      progressBar.value = Math.min(percent, 100)
      currentTimeEl.textContent = formatTime(targetPosition)
      updateProgressBarStyle(percent)
    }

    // Timeout de sécurité : si Rust ne confirme pas dans 2s, réactive l'interpolation
    if (seekTimeoutId) clearTimeout(seekTimeoutId)
    seekTimeoutId = setTimeout(() => {
      if (isSeekingUI) {
        console.log('[Seek] Safety timeout from playback_seeking event')
        isSeekingUI = false
      }
    }, 2000)
  })

  // Pause/Resume depuis Rust - synchronise l'état global
  await listen('playback_paused', () => {
    isPausedFromRust = true
    audioIsPlaying = false
    playPauseBtn.textContent = '▶'
    // Stoppe la boucle RAF pour économiser le CPU
    stopPositionInterpolation()
    setFullscreenPlayState(false)
    syncFsPlayPauseIcon(false)
  })

  await listen('playback_resumed', () => {
    isPausedFromRust = false
    audioIsPlaying = true
    playPauseBtn.textContent = '⏸'
    // Re-synchronise le timestamp pour éviter un saut
    lastRustTimestamp = performance.now()
    // Redémarre la boucle RAF
    startPositionInterpolation()
    setFullscreenPlayState(true)
    syncFsPlayPauseIcon(true)
  })

  // Fin de lecture (émis par Rust quand le track est terminé)
  await listen('playback_ended', () => {
    console.log('Rust: playback_ended - transitioning to next track')

    // IMPORTANT: Sauvegarder l'index AVANT toute modification d'état
    const indexToRepeat = currentTrackIndex

    // Marque la fin de lecture AVANT la transition
    audioIsPlaying = false
    isPausedFromRust = false

    // Reset immédiat de l'UI pour la transition
    resetPlayerUI()

    // Stoppe la boucle RAF (sera redémarrée par playTrack si nécessaire)
    stopPositionInterpolation()

    // Petit délai pour laisser Rust nettoyer son état avant de lancer la suite
    setTimeout(() => {
      // Gère repeat et next track
      if (repeatMode === 'one' && indexToRepeat >= 0 && indexToRepeat < tracks.length) {
        // Répète le même morceau (utilise l'index sauvegardé)
        playTrack(indexToRepeat)
      } else {
        playNextTrack()
      }
    }, 50) // 50ms suffisent pour que Rust nettoie
  })

  // Moniteur de specs audio SOURCE vs OUTPUT
  await listen('playback_audio_specs', (event) => {
    const specs = event.payload
    updateAudioSpecs(specs)
  })

  // === GAPLESS TRANSITION ===
  await listen('playback_gapless_transition', () => {
    console.log('[Gapless] Seamless transition occurred')
    gaplessPreloadTriggered = false

    // Advance to the next track in the UI (without calling playTrack)
    if (queue.length > 0) {
      const nextTrack = queue.shift()
      const globalIndex = tracks.findIndex(t => t.path === nextTrack.path)
      if (globalIndex !== -1) {
        currentTrackIndex = globalIndex
        updateQueueDisplay()
        updateQueueIndicators()
      }
    } else if (repeatMode === 'one') {
      // Stay on same track, just reset position display
    } else {
      // Advance to next track in album order
      const currentTrack = tracks[currentTrackIndex]
      if (currentTrack) {
        const currentFolder = currentTrack.path.substring(0, currentTrack.path.lastIndexOf('/'))
        const albumTracks = tracks.filter(t => {
          const folder = t.path.substring(0, t.path.lastIndexOf('/'))
          return folder === currentFolder && t.metadata?.album === currentTrack.metadata?.album
        }).sort((a, b) => {
          const discA = a.metadata?.disc || 1
          const discB = b.metadata?.disc || 1
          if (discA !== discB) return discA - discB
          return (a.metadata?.track || 0) - (b.metadata?.track || 0)
        })

        const idx = albumTracks.findIndex(t => t.path === currentTrack.path)
        if (idx >= 0 && idx < albumTracks.length - 1) {
          const nextTrack = albumTracks[idx + 1]
          const globalIndex = tracks.findIndex(t => t.path === nextTrack.path)
          if (globalIndex !== -1) currentTrackIndex = globalIndex
        } else if (repeatMode === 'all' && albumTracks.length > 0) {
          const globalIndex = tracks.findIndex(t => t.path === albumTracks[0].path)
          if (globalIndex !== -1) currentTrackIndex = globalIndex
        }
      }
    }

    // Update the UI with the new track info
    const track = tracks[currentTrackIndex]
    if (track) {
      const trackNameEl = document.getElementById('track-name')
      const trackFolderEl = document.getElementById('track-folder')
      if (trackNameEl) trackNameEl.textContent = track.metadata?.title || track.name
      if (trackFolderEl) trackFolderEl.textContent = track.metadata?.artist || track.folder

      // Update duration
      audioDurationFromRust = track.metadata?.duration || 0
      durationEl.textContent = formatTime(audioDurationFromRust)

      // Reset position
      audioPositionFromRust = 0
      lastRustPosition = 0
      lastRustTimestamp = performance.now()
      lastDisplayedPosition = 0

      // Update cover
      updateCoverArt(track)
      updateNowPlayingHighlight()
      updateHomeNowPlayingSection()

      // Record play
      invoke('record_play', {
        path: track.path,
        artist: track.metadata?.artist || 'Unknown Artist',
        album: track.metadata?.album || '',
        title: track.metadata?.title || track.name
      }).then(() => invalidateHomeCache()).catch(() => {})
    }
  })

  // === ERROR HANDLING ===
  // Erreurs de lecture structurées depuis Rust (debounce 2s par code d'erreur)
  const errorLastShown = {}
  const ERROR_DEBOUNCE_MS = 2000
  const AUTO_SKIP_ERRORS = new Set(['file_probe_failed', 'decode_failed', 'file_not_found'])

  await listen('playback_error', (event) => {
    const { code, message, details } = event.payload
    console.error(`[PlaybackError:${code}] ${message} — ${details}`)

    // Debounce : n'affiche pas la même erreur 2 fois en 2s
    const now = Date.now()
    if (errorLastShown[code] && now - errorLastShown[code] < ERROR_DEBOUNCE_MS) {
      return
    }
    errorLastShown[code] = now

    // Affiche le toast d'erreur (5s)
    showToast(message, 5000)

    // Auto-skip sur les erreurs de fichier (passe au morceau suivant)
    if (AUTO_SKIP_ERRORS.has(code) && audioIsPlaying) {
      setTimeout(() => {
        console.log(`[PlaybackError] Auto-skipping due to ${code}`)
        playNextTrack()
      }, 300)
    }
  })

  // Démarre l'interpolation au chargement
  startPositionInterpolation()

  console.log('Rust audio listeners initialized (with smooth 60fps interpolation)')
}

// Initialise au chargement
document.addEventListener('DOMContentLoaded', initRustAudioListeners)

// Met à jour visuellement la barre de progression (couleur de remplissage)
function updateProgressBarStyle(percent) {
  const clampedPercent = Math.min(Math.max(percent, 0), 100)
  progressBar.style.background = `linear-gradient(to right, #fff 0%, #fff ${clampedPercent}%, #333 ${clampedPercent}%, #333 100%)`
}

// === SEEK DEBOUNCE ===
// Note: isUserDragging, seekPending et seekTimeoutId sont déclarés en haut
// avec les autres variables d'interpolation pour éviter les problèmes de hoisting

// Fonction de seek unique (évite la duplication de code)
// IMPORTANT: Garde le curseur à la position demandée même si le seek échoue ou prend du temps
async function performSeek() {
  if (seekPending) return  // Évite les seeks multiples
  seekPending = true

  const duration = getCurrentTrackDuration()
  if (duration > 0) {
    const time = (progressBar.value / 100) * duration

    // Annule le timeout précédent si on seek rapidement plusieurs fois
    if (seekTimeoutId) {
      clearTimeout(seekTimeoutId)
      seekTimeoutId = null
    }

    // IMPORTANT: Stocke la position demandée pour la comparaison dans syncToRustPosition
    // Cette valeur ne changera pas pendant l'attente du seek
    seekTargetPosition = time

    // FORCE la position visuelle immédiatement
    // Ces valeurs seront utilisées par l'interpolation même si le seek prend du temps
    lastRustPosition = time
    lastRustTimestamp = performance.now()
    lastDisplayedPosition = time
    currentTimeEl.textContent = formatTime(time)
    updateProgressBarStyle((time / duration) * 100)

    console.log(`[Seek] Requesting seek to ${time.toFixed(2)}s`)

    // Seek via Rust
    try {
      await invoke('audio_seek', { time })
      console.log(`[Seek] Backend accepted seek to ${time.toFixed(2)}s`)
    } catch (e) {
      console.error('[Seek] audio_seek error:', e)
      // IMPORTANT: Même en cas d'erreur, on garde la position demandée
      // L'utilisateur veut cette position, le chargement suivra
      lastRustPosition = time
      lastRustTimestamp = performance.now()
    }

    // Timeout de sécurité : réactive l'interpolation après 2 secondes max
    // même si le backend ne confirme pas (évite de rester bloqué)
    seekTimeoutId = setTimeout(() => {
      if (isSeekingUI) {
        console.log('[Seek] Safety timeout: re-enabling interpolation')
        isSeekingUI = false
      }
      seekPending = false
      seekTimeoutId = null
    }, 2000)  // 2 secondes max d'attente
  } else {
    seekPending = false
  }
}

// mousedown = début de l'interaction (clic ou drag)
progressBar.addEventListener('mousedown', (e) => {
  isUserDragging = true
  isSeekingUI = true  // Bloque l'interpolation pendant l'interaction
  seekPending = false  // Reset le flag de seek
})

// input = pendant le drag OU clic direct (mise à jour VISUELLE)
progressBar.addEventListener('input', () => {
  const duration = getCurrentTrackDuration()
  if (duration > 0) {
    const time = (progressBar.value / 100) * duration
    // Met à jour UNIQUEMENT l'affichage visuel
    currentTimeEl.textContent = formatTime(time)
    updateProgressBarStyle(progressBar.value)
    // PAS de seek ici pour éviter le flood !
  }
})

// mouseup = fin de l'interaction → effectue le seek
// Note: On utilise mouseup sur le document car l'utilisateur peut relâcher en dehors du slider
document.addEventListener('mouseup', (e) => {
  if (!isUserDragging) return
  isUserDragging = false

  // Effectue le seek
  performSeek()
})

// change = backup pour les clics directs (certains navigateurs l'émettent)
progressBar.addEventListener('change', () => {
  // Si on est encore en mode dragging, mouseup va s'en occuper
  if (isUserDragging) return

  // Sinon, effectue le seek (cas d'un clic sans mouseup détecté)
  if (!seekPending) {
    isSeekingUI = true
    performSeek()
  }
})

// === SHUFFLE & REPEAT ===
shuffleBtn.addEventListener('click', () => {
  // Reset l'historique des tracks joués à chaque changement de mode
  shufflePlayedTracks.clear()

  // Cycle : off → album → library → off
  if (shuffleMode === 'off') {
    shuffleMode = 'album'
    shuffleBtn.classList.add('active')
    shuffleBtn.textContent = '⤮ᴬ'
    shuffleBtn.title = 'Shuffle (Album)'
  } else if (shuffleMode === 'album') {
    shuffleMode = 'library'
    shuffleBtn.textContent = '⤮∞'
    shuffleBtn.title = 'Shuffle (Library)'
  } else {
    shuffleMode = 'off'
    shuffleBtn.classList.remove('active')
    shuffleBtn.textContent = '⤮'
    shuffleBtn.title = 'Shuffle'
  }
})

// Met à jour l'UI du bouton repeat selon le mode actuel
function updateRepeatButtonUI() {
  if (!repeatBtn) return

  if (repeatMode === 'all') {
    repeatBtn.classList.add('active')
    repeatBtn.textContent = '⟳'
    repeatBtn.title = 'Repeat all'
  } else if (repeatMode === 'one') {
    repeatBtn.classList.add('active')
    repeatBtn.textContent = '⟳₁'
    repeatBtn.title = 'Repeat one'
  } else {
    repeatBtn.classList.remove('active')
    repeatBtn.textContent = '⟳'
    repeatBtn.title = 'Repeat'
  }
}

repeatBtn.addEventListener('click', () => {
  // Cycle : off → all → one → off
  if (repeatMode === 'off') {
    repeatMode = 'all'
  } else if (repeatMode === 'all') {
    repeatMode = 'one'
  } else {
    repeatMode = 'off'
  }
  updateRepeatButtonUI()
})

// === VOLUME ===
let currentVolume = 1.0 // Volume actuel (0.0 - 1.0)

volumeBar.addEventListener('input', async () => {
  const volume = volumeBar.value / 100
  currentVolume = volume

  // Volume via Rust only
  try {
    await invoke('audio_set_volume', { volume })
  } catch (e) {
    console.error('audio_set_volume error:', e)
  }

  updateVolumeIcon(volume)
  if (volume > 0) lastVolume = volumeBar.value
})

volumeBtn.addEventListener('click', async () => {
  if (currentVolume > 0) {
    // Mute
    lastVolume = volumeBar.value
    volumeBar.value = 0
    currentVolume = 0

    try {
      await invoke('audio_set_volume', { volume: 0.0 })
    } catch (e) {
      console.error('audio_set_volume error:', e)
    }

    updateVolumeIcon(0)
  } else {
    // Unmute
    volumeBar.value = lastVolume
    currentVolume = lastVolume / 100

    try {
      await invoke('audio_set_volume', { volume: currentVolume })
    } catch (e) {
      console.error('audio_set_volume error:', e)
    }

    updateVolumeIcon(currentVolume)
  }
})

function updateVolumeIcon(volume) {
  const iconPath = document.getElementById('volume-icon-path')
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

// === SÉLECTEUR DE SORTIE AUDIO ===
let currentAudioDeviceId = null
let devicePollingInterval = null

function stopDevicePolling() {
  if (devicePollingInterval) {
    clearInterval(devicePollingInterval)
    devicePollingInterval = null
  }
}

function startDevicePolling() {
  stopDevicePolling()
  devicePollingInterval = setInterval(async () => {
    if (!audioOutputMenu.classList.contains('hidden')) {
      await loadAudioDevices()
    } else {
      stopDevicePolling()
    }
  }, 3000)
}

// Toggle le menu de sélection audio
audioOutputBtn.addEventListener('click', async (e) => {
  e.stopPropagation()

  if (audioOutputMenu.classList.contains('hidden')) {
    // Ouvre le menu et charge les devices
    await loadAudioDevices()
    await loadExclusiveMode()
    audioOutputMenu.classList.remove('hidden')
    startDevicePolling()
    audioOutputBtn.classList.add('active')
  } else {
    // Ferme le menu
    audioOutputMenu.classList.add('hidden')
    audioOutputBtn.classList.remove('active')
    stopDevicePolling()
  }
})

// Ferme le menu au clic ailleurs
document.addEventListener('click', (e) => {
  if (!audioOutputMenu.classList.contains('hidden') &&
      !audioOutputMenu.contains(e.target) &&
      e.target !== audioOutputBtn) {
    audioOutputMenu.classList.add('hidden')
    audioOutputBtn.classList.remove('active')
    stopDevicePolling()
  }
})

// Charge la liste des périphériques audio
async function loadAudioDevices() {
  console.log('[AUDIO-OUTPUT] Loading audio devices (with refresh)...')
  try {
    const devices = await invoke('refresh_audio_devices')
    console.log('[AUDIO-OUTPUT] Available devices:', devices)

    const currentDevice = await invoke('get_current_audio_device')
    console.log('[AUDIO-OUTPUT] Current device:', currentDevice)

    currentAudioDeviceId = currentDevice?.id || null

    audioOutputList.innerHTML = ''

    for (const device of devices) {
      const item = document.createElement('button')
      item.className = `audio-output-item${device.id === currentAudioDeviceId ? ' active' : ''}`
      item.dataset.deviceId = device.id

      // Formate le sample rate
      const sampleRate = device.current_sample_rate
        ? `${(device.current_sample_rate / 1000).toFixed(1).replace('.0', '')} kHz`
        : ''

      // Formate les sample rates supportés
      const supportedRates = device.supported_sample_rates && device.supported_sample_rates.length > 0
        ? device.supported_sample_rates.map(r => `${r/1000}k`).join(', ')
        : ''

      item.innerHTML = `
        <div class="audio-output-item-info">
          <div class="audio-output-item-name">${device.name}</div>
          <div class="audio-output-item-details">
            ${sampleRate}${supportedRates ? ` • Supporte: ${supportedRates}` : ''}
          </div>
        </div>
        ${device.is_default ? '<span class="audio-output-item-default">Default</span>' : ''}
      `

      item.addEventListener('click', () => selectAudioDevice(device.id, device.name))
      audioOutputList.appendChild(item)
    }
  } catch (e) {
    console.error('[AUDIO-OUTPUT] Error loading devices:', e)
    console.error('[AUDIO-OUTPUT] Error details:', JSON.stringify(e, null, 2))
    audioOutputList.innerHTML = `<div style="padding: 16px; color: #ff6b6b;">Error: ${escapeHtml(e?.message || e || 'Audio engine not initialized')}</div>`
  }
}

// Sélectionne un périphérique audio
async function selectAudioDevice(deviceId, deviceName) {
  console.log('[AUDIO-OUTPUT] Selecting device:', deviceId, deviceName)
  console.log('[AUDIO-OUTPUT] Previous device was:', currentAudioDeviceId)

  // Ne fait rien si c'est déjà le device actif
  if (deviceId === currentAudioDeviceId) {
    console.log('[AUDIO-OUTPUT] Already on this device, skipping')
    audioOutputMenu.classList.add('hidden')
    audioOutputBtn.classList.remove('active')
    return
  }

  // Ferme le menu immédiatement
  audioOutputMenu.classList.add('hidden')
  audioOutputBtn.classList.remove('active')

  try {
    console.log('[AUDIO-OUTPUT] Calling set_audio_device...')
    await invoke('set_audio_device', { deviceId })
    console.log('[AUDIO-OUTPUT] Device preference changed successfully')

    const previousDeviceId = currentAudioDeviceId
    currentAudioDeviceId = deviceId

    // Met à jour l'affichage
    audioOutputList.querySelectorAll('.audio-output-item').forEach(item => {
      item.classList.toggle('active', item.dataset.deviceId === deviceId)
    })

    // Si de la musique joue ou était en pause, relance la lecture sur le nouveau device
    // Note: Le backend CPAL utilise toujours le device par défaut système, donc on doit
    // forcer une relance pour que le changement prenne effet via prepare_for_streaming()
    const wasPlaying = audioIsPlaying || !isPausedFromRust
    if (currentTrackIndex >= 0 && tracks[currentTrackIndex]) {
      const currentTrack = tracks[currentTrackIndex]
      console.log('[AUDIO-OUTPUT] Restarting playback on new device...', { wasPlaying, audioIsPlaying, isPausedFromRust })
      showToast(`Output: ${deviceName}`)

      // Sauvegarde la position actuelle (utilise le slider comme référence fiable)
      const progressSlider = document.getElementById('progress')
      let currentPosition = audioPositionFromRust
      if (progressSlider && audioDurationFromRust > 0) {
        currentPosition = (parseFloat(progressSlider.value) / 100) * audioDurationFromRust
      }

      try {
        // Stoppe d'abord pour libérer le stream
        await invoke('audio_stop').catch(() => {})

        // Court délai pour laisser le temps au stream de se fermer
        await new Promise(resolve => setTimeout(resolve, 100))

        // Relance la lecture
        await invoke('audio_play', { path: currentTrack.path })

        // Seek à la position précédente après un court délai
        if (currentPosition > 1) {
          setTimeout(async () => {
            try {
              await invoke('audio_seek', { time: currentPosition })
              console.log('[AUDIO-OUTPUT] Seeked to previous position:', currentPosition.toFixed(2))
            } catch (e) {
              console.error('[AUDIO-OUTPUT] Error seeking:', e)
            }
          }, 300)
        }

        // Si c'était en pause avant, remet en pause
        if (!wasPlaying || isPausedFromRust) {
          setTimeout(async () => {
            try {
              await invoke('audio_pause')
              console.log('[AUDIO-OUTPUT] Restored pause state')
            } catch (e) {
              console.error('[AUDIO-OUTPUT] Error pausing:', e)
            }
          }, 400)
        }

        console.log('[AUDIO-OUTPUT] Playback restarted on new device')
      } catch (playErr) {
        console.error('[AUDIO-OUTPUT] Error restarting playback:', playErr)
        showToast('Error changing output')
      }
    } else {
      showToast(`Audio output: ${deviceName}`)
    }
  } catch (e) {
    console.error('[AUDIO-OUTPUT] Error changing device:', e)
    showToast('Error changing audio output')
  }
}

// Charge l'état du mode exclusif
async function loadExclusiveMode() {
  console.log('[AUDIO-OUTPUT] Loading exclusive mode state...')
  try {
    const isExclusive = await invoke('is_exclusive_mode')
    console.log('[AUDIO-OUTPUT] Exclusive mode is:', isExclusive)
    exclusiveModeCheckbox.checked = isExclusive
    updateHogModeStatus(isExclusive)
  } catch (e) {
    console.error('[AUDIO-OUTPUT] Error loading exclusive mode:', e)
  }
}

// Met à jour l'affichage du statut Hog Mode
function updateHogModeStatus(isActive) {
  const statusEl = document.getElementById('hog-mode-status')
  if (statusEl) {
    statusEl.textContent = isActive ? 'Active' : 'Disabled'
    statusEl.classList.toggle('active', isActive)
  }
}

// Initialise le tooltip Hog Mode (portaled to body for no-clip)
function initHogModeTooltip() {
  const infoBtn = document.getElementById('hog-mode-info-btn')
  const tooltip = document.getElementById('hog-mode-tooltip')

  if (infoBtn && tooltip) {
    // Extraire le tooltip du flux du DOM et l'ajouter au body (portal)
    document.body.appendChild(tooltip)

    infoBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      // Positionne le tooltip au-dessus du bouton info
      const rect = infoBtn.getBoundingClientRect()
      tooltip.style.bottom = `${window.innerHeight - rect.top + 12}px`
      tooltip.style.right = `${window.innerWidth - rect.right}px`
      tooltip.classList.toggle('visible')
    })

    // Ferme le tooltip en cliquant ailleurs
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.hog-mode-container') && !e.target.closest('.hog-mode-tooltip')) {
        tooltip.classList.remove('visible')
      }
    })
  }
}

// Initialise au chargement
document.addEventListener('DOMContentLoaded', initHogModeTooltip)

// Toggle le mode exclusif (Hog Mode)
exclusiveModeCheckbox.addEventListener('change', async () => {
  const newState = exclusiveModeCheckbox.checked
  console.log('[AUDIO-OUTPUT] Toggling exclusive mode to:', newState)
  console.log('[AUDIO-OUTPUT] Current device ID:', currentAudioDeviceId)
  console.log('[AUDIO-OUTPUT] Audio is currently playing:', audioIsPlaying)

  try {
    console.log('[AUDIO-OUTPUT] Calling set_exclusive_mode...')
    await invoke('set_exclusive_mode', { enabled: newState })
    console.log('[AUDIO-OUTPUT] Exclusive mode changed successfully')

    // Met à jour le statut visuel (player + settings synchronisés)
    updateHogModeUI(newState)

    if (newState) {
      // Le Hog Mode nécessite de relancer la lecture pour prendre effet
      if (audioIsPlaying && currentTrackIndex >= 0) {
        showToast('Exclusive mode enabled - Restarting playback...')
        // Relance le track actuel pour que le Hog Mode prenne effet
        const currentTrack = tracks[currentTrackIndex]
        if (currentTrack) {
          console.log('[AUDIO-OUTPUT] Restarting playback for Hog Mode...')
          try {
            await invoke('audio_play', { path: currentTrack.path })
            console.log('[AUDIO-OUTPUT] Playback restarted in exclusive mode')
          } catch (playErr) {
            console.error('[AUDIO-OUTPUT] Error restarting playback:', playErr)
          }
        }
      } else {
        showToast('Exclusive mode enabled (bit-perfect)')
      }
    } else {
      showToast('Exclusive mode disabled')
    }
  } catch (e) {
    console.error('[AUDIO-OUTPUT] Error changing exclusive mode:', e)
    // Revert le checkbox et le statut
    exclusiveModeCheckbox.checked = !newState
    updateHogModeUI(!newState)
    showToast('Error changing mode')
  }
})

// === ÉGALISEUR → importé depuis eq.js ===




// formatTime, formatAlbumDuration → importés depuis utils.js

// === FILE D'ATTENTE (QUEUE) ===

// Ajouter un morceau à la fin de la queue
function addToQueue(track) {
  queue.push(track)
  updateQueueDisplay()
  updateQueueIndicators()
  showQueueNotification(`"${track.metadata?.title || track.name}" added to queue`)
}

// Jouer ensuite (ajoute en haut de la queue)
function playNext(track) {
  queue.unshift(track)
  updateQueueDisplay()
  updateQueueIndicators()
  showQueueNotification(`"${track.metadata?.title || track.name}" will play next`)
}

// Retirer un morceau de la queue
function removeFromQueue(index) {
  queue.splice(index, 1)
  updateQueueDisplay()
  updateQueueIndicators()
}

// Vider la queue
function clearQueue() {
  queue = []
  updateQueueDisplay()
  updateQueueIndicators()
}

// Met à jour les indicateurs "in-queue" sur les tracks visibles
// Utilise requestIdleCallback pour ne pas bloquer l'UI
let queueIndicatorsPending = false
function updateQueueIndicators() {
  // Évite les appels multiples en rafale
  if (queueIndicatorsPending) return
  queueIndicatorsPending = true

  const updateFn = () => {
    queueIndicatorsPending = false
    const queuePaths = new Set(queue.map(t => t.path))

    // Met à jour les boutons dans la vue Titres
    document.querySelectorAll('.tracks-list-item').forEach(item => {
      const trackPath = item.dataset.trackPath
      const btn = item.querySelector('.tracks-list-add-queue')
      if (btn && trackPath) {
        const isInQueue = queuePaths.has(trackPath)
        btn.classList.toggle('in-queue', isInQueue)
        btn.title = isInQueue ? 'Remove from queue' : 'Add to queue'
      }
    })

    // Met à jour les boutons dans le panel album detail
    document.querySelectorAll('.album-track-item').forEach(item => {
      const trackPath = item.dataset.trackPath
      const btn = item.querySelector('.track-add-queue')
      if (btn && trackPath) {
        const isInQueue = queuePaths.has(trackPath)
        btn.classList.toggle('in-queue', isInQueue)
        btn.title = isInQueue ? 'Remove from queue' : 'Add to queue'
      }
    })
  }

  // Utilise requestIdleCallback si disponible, sinon setTimeout
  if ('requestIdleCallback' in window) {
    requestIdleCallback(updateFn, { timeout: 100 })
  } else {
    setTimeout(updateFn, 0)
  }
}

// Toggle le panel de la queue
function toggleQueuePanel() {
  if (!isQueuePanelOpen) {
    // Ferme les autres panels avant d'ouvrir
    if (isTrackInfoPanelOpen) closeTrackInfoPanel()
    if (isSettingsPanelOpen) closeSettings()
    if (getEqPanelOpen()) closeEqPanel()
  }
  isQueuePanelOpen = !isQueuePanelOpen
  const panel = document.getElementById('queue-panel')
  const btn = document.getElementById('queue-btn')
  if (panel) panel.classList.toggle('open', isQueuePanelOpen)
  if (btn) btn.classList.toggle('active', isQueuePanelOpen)
}

// Affiche une notification temporaire
function showQueueNotification(message) {
  let notification = document.getElementById('queue-notification')
  if (!notification) {
    notification = document.createElement('div')
    notification.id = 'queue-notification'
    notification.className = 'queue-notification'
    document.body.appendChild(notification)
  }
  notification.textContent = message
  notification.classList.add('show')
  setTimeout(() => notification.classList.remove('show'), 2000)
}

// Met à jour l'affichage de la queue
function updateQueueDisplay() {
  const queueList = document.getElementById('queue-list')
  const queueEmpty = document.getElementById('queue-empty')
  const queueNext = document.getElementById('queue-next')
  const queueCurrent = document.getElementById('queue-current')
  const clearBtn = document.getElementById('clear-queue')

  if (!queueList) return

  // Affiche/masque selon si la queue est vide
  if (queue.length === 0) {
    queueEmpty?.classList.remove('hidden')
    queueNext?.classList.add('hidden')
    if (clearBtn) clearBtn.style.display = 'none'
  } else {
    queueEmpty?.classList.add('hidden')
    queueNext?.classList.remove('hidden')
    if (clearBtn) clearBtn.style.display = 'block'
  }

  // Met à jour le morceau en cours
  if (queueCurrent && currentTrackIndex >= 0) {
    const currentTrack = tracks[currentTrackIndex]
    queueCurrent.innerHTML = `
      <div class="queue-item-cover">
        <div class="queue-item-placeholder">♪</div>
      </div>
      <div class="queue-item-info">
        <span class="queue-item-title">${currentTrack.metadata?.title || currentTrack.name}</span>
        <span class="queue-item-artist">${currentTrack.metadata?.artist || 'Unknown Artist'}</span>
      </div>
    `
    // Charge la pochette
    const placeholder = queueCurrent.querySelector('.queue-item-placeholder')
    const coverDiv = queueCurrent.querySelector('.queue-item-cover')
    if (coverCache.has(currentTrack.path)) {
      const cover = coverCache.get(currentTrack.path)
      if (cover) {
        coverDiv.innerHTML = `<img src="${cover}" alt="">`
      }
    }
  }

  // Met à jour la liste des morceaux en attente (génère seulement le HTML)
  queueList.innerHTML = queue.map((track, index) => `
    <div class="queue-item" data-index="${index}" data-track-path="${track.path}">
      <span class="queue-drag-handle" title="Drag to reorder">⠿</span>
      <span class="queue-item-index">${index + 1}</span>
      <div class="queue-item-info">
        <span class="queue-item-title">${track.metadata?.title || track.name}</span>
        <span class="queue-item-artist">${track.metadata?.artist || 'Unknown Artist'}</span>
      </div>
      <button class="queue-item-remove" title="Retirer">✕</button>
    </div>
  `).join('')
}

// Initialise les event listeners de la queue
function initQueueListeners() {
  const queueBtn = document.getElementById('queue-btn')
  const clearQueueBtn = document.getElementById('clear-queue')
  const closeQueueBtn = document.getElementById('close-queue')
  const queueList = document.getElementById('queue-list')

  if (queueBtn) {
    queueBtn.addEventListener('click', toggleQueuePanel)
  }

  if (clearQueueBtn) {
    clearQueueBtn.addEventListener('click', clearQueue)
  }

  if (closeQueueBtn) {
    closeQueueBtn.addEventListener('click', toggleQueuePanel)
  }

  // EVENT DELEGATION pour la liste de queue
  if (queueList) {
    // Clic sur un item
    queueList.addEventListener('click', (e) => {
      const item = e.target.closest('.queue-item')
      if (!item) return

      const index = parseInt(item.dataset.index)
      const trackPath = item.dataset.trackPath

      // Bouton supprimer
      if (e.target.closest('.queue-item-remove')) {
        e.stopPropagation()
        removeFromQueue(index)
        return
      }

      // Clic sur info = joue immédiatement
      if (e.target.closest('.queue-item-info')) {
        const globalIndex = tracks.findIndex(t => t.path === trackPath)
        if (globalIndex !== -1) {
          queue.splice(index, 1)
          playTrack(globalIndex)
          updateQueueDisplay()
        }
      }
    })

    // Clic droit = menu contextuel
    queueList.addEventListener('contextmenu', (e) => {
      const item = e.target.closest('.queue-item')
      if (!item) return

      const trackPath = item.dataset.trackPath
      const track = tracks.find(t => t.path === trackPath)
      if (!track) return

      const globalIndex = tracks.findIndex(t => t.path === trackPath)
      showContextMenu(e, track, globalIndex)
    })

    // === DRAG CUSTOM pour réorganiser la queue (car HTML5 drag ne fonctionne pas dans Tauri WebView) ===
    let queueDragState = {
      isDragging: false,
      isPotentialDrag: false,
      draggedItem: null,
      draggedIndex: -1,
      startX: 0,
      startY: 0,
      currentDropTarget: null
    }

    // Mousedown : prépare le drag
    queueList.addEventListener('mousedown', (e) => {
      // Ignore si clic sur le bouton supprimer
      if (e.target.closest('.queue-item-remove')) return

      const item = e.target.closest('.queue-item')
      if (!item) return

      queueDragState.isPotentialDrag = true
      queueDragState.draggedItem = item
      queueDragState.draggedIndex = parseInt(item.dataset.index)
      queueDragState.startX = e.clientX
      queueDragState.startY = e.clientY
    })

    // Mousemove : gère le drag
    document.addEventListener('mousemove', (e) => {
      if (!queueDragState.isPotentialDrag) return

      // Vérifie le seuil de mouvement
      if (!queueDragState.isDragging) {
        const dx = Math.abs(e.clientX - queueDragState.startX)
        const dy = Math.abs(e.clientY - queueDragState.startY)

        if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
          queueDragState.isDragging = true
          queueDragState.draggedItem?.classList.add('dragging')
        }
      }

      if (!queueDragState.isDragging) return

      // Trouve l'élément sous le curseur
      const elementUnder = document.elementFromPoint(e.clientX, e.clientY)
      const targetItem = elementUnder?.closest('.queue-item')

      // Retire l'indicateur de l'ancien target
      if (queueDragState.currentDropTarget && queueDragState.currentDropTarget !== targetItem) {
        queueDragState.currentDropTarget.classList.remove('drag-over-top', 'drag-over-bottom')
      }

      // Ajoute l'indicateur sur le nouveau target
      if (targetItem && targetItem !== queueDragState.draggedItem) {
        const rect = targetItem.getBoundingClientRect()
        const midY = rect.top + rect.height / 2

        if (e.clientY < midY) {
          targetItem.classList.add('drag-over-top')
          targetItem.classList.remove('drag-over-bottom')
        } else {
          targetItem.classList.add('drag-over-bottom')
          targetItem.classList.remove('drag-over-top')
        }
        queueDragState.currentDropTarget = targetItem
      } else {
        queueDragState.currentDropTarget = null
      }
    })

    // Mouseup : termine le drag
    document.addEventListener('mouseup', (e) => {
      if (!queueDragState.isPotentialDrag) return

      const wasDragging = queueDragState.isDragging
      const draggedIndex = queueDragState.draggedIndex

      // Nettoie les classes
      if (queueDragState.draggedItem) {
        queueDragState.draggedItem.classList.remove('dragging')
      }
      if (queueDragState.currentDropTarget) {
        queueDragState.currentDropTarget.classList.remove('drag-over-top', 'drag-over-bottom')
      }

      // Si on a vraiment dragué, effectue le réarrangement
      if (wasDragging && queueDragState.currentDropTarget) {
        const targetIndex = parseInt(queueDragState.currentDropTarget.dataset.index)

        if (targetIndex !== draggedIndex) {
          const rect = queueDragState.currentDropTarget.getBoundingClientRect()
          const midY = rect.top + rect.height / 2
          let newIndex = e.clientY < midY ? targetIndex : targetIndex + 1

          // Ajuste si on déplace vers le bas
          if (newIndex > draggedIndex) {
            newIndex--
          }

          // Réorganise la queue
          const [movedTrack] = queue.splice(draggedIndex, 1)
          queue.splice(newIndex, 0, movedTrack)

          // Met à jour l'affichage
          updateQueueDisplay()
          updateQueueIndicators()
        }
      }

      // Reset l'état
      queueDragState.isPotentialDrag = false
      queueDragState.isDragging = false
      queueDragState.draggedItem = null
      queueDragState.draggedIndex = -1
      queueDragState.currentDropTarget = null
    })
  }
}

// Appelle l'initialisation après le chargement du DOM
document.addEventListener('DOMContentLoaded', initQueueListeners)

// === MENU CONTEXTUEL ===
let contextMenuTracks = []  // Tracks sélectionnées pour le menu contextuel
let contextMenuTrackIndex = -1

// Menu contextuel pour un album (clic droit sur le header du panel album)
function showAlbumContextMenu(e, albumKey) {
  e.preventDefault()

  const album = albums[albumKey]
  if (!album) return

  // Supprime tout menu existant
  document.querySelectorAll('.album-context-menu').forEach(m => m.remove())
  hideContextMenu()

  const menu = document.createElement('div')
  menu.className = 'context-menu album-context-menu'
  menu.innerHTML = `
    <button class="context-menu-item" data-action="play-album">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      <span>Play album</span>
    </button>
    <button class="context-menu-item" data-action="add-album-queue">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M16 5H3"/><path d="M16 12H3"/><path d="M9 19H3"/><path d="M16 16l-3 3 3 3"/><path d="M21 5v12a2 2 0 0 1-2 2h-6"/>
      </svg>
      <span>Ajouter à la file d'attente</span>
    </button>
    <div class="context-menu-separator"></div>
    <button class="context-menu-item" data-action="create-playlist-from-album">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 5v14"/><path d="M5 12h14"/>
      </svg>
      <span>Créer une playlist avec cet album</span>
    </button>
  `

  // Position
  menu.style.left = `${e.clientX}px`
  menu.style.top = `${e.clientY}px`
  document.body.appendChild(menu)

  // Actions
  menu.querySelector('[data-action="play-album"]').addEventListener('click', () => {
    playAlbum(albumKey)
    menu.remove()
  })

  menu.querySelector('[data-action="add-album-queue"]').addEventListener('click', () => {
    album.tracks.forEach(track => addToQueue(track))
    showQueueNotification(`${album.tracks.length} tracks added to queue`)
    menu.remove()
  })

  menu.querySelector('[data-action="create-playlist-from-album"]').addEventListener('click', async () => {
    // Crée une nouvelle playlist avec le nom "Artiste - Album"
    const playlistName = `${album.artist} - ${album.album}`

    try {
      const newPlaylist = await invoke('create_playlist', { name: playlistName })
      playlists.push(newPlaylist)
      updatePlaylistsSidebar()

      // Ajoute tous les tracks de l'album
      for (const track of album.tracks) {
        await addTrackToPlaylist(newPlaylist.id, track)
      }

      showToast(`Playlist "${playlistName}" created with ${album.tracks.length} tracks`)
    } catch (e) {
      console.error('Erreur création playlist:', e)
      showToast('Error creating playlist')
    }

    menu.remove()
  })

  // Ferme au clic ailleurs
  const closeHandler = (ev) => {
    if (!ev.target.closest('.album-context-menu')) {
      menu.remove()
      document.removeEventListener('click', closeHandler)
    }
  }
  setTimeout(() => document.addEventListener('click', closeHandler), 0)
}

// Affiche le menu contextuel (avec support multi-sélection)
function showContextMenu(e, track, trackIndex) {
  e.preventDefault()
  e.stopPropagation()

  const { selectedTrackPaths } = virtualScrollState
  const isMultiSelection = selectedTrackPaths.size > 1 && selectedTrackPaths.has(track.path)

  // Si multi-sélection, on garde tous les tracks sélectionnés
  // Sinon, on utilise uniquement le track cliqué
  contextMenuTracks = isMultiSelection
    ? tracks.filter(t => selectedTrackPaths.has(t.path))
    : [track]
  contextMenuTrackIndex = trackIndex

  const menu = document.getElementById('context-menu')
  if (!menu) return

  // Met à jour les labels selon le nombre de tracks
  updateContextMenuLabels(menu, contextMenuTracks.length)

  // Position du menu
  const x = e.clientX
  const y = e.clientY

  // Ajuste la position pour ne pas dépasser l'écran
  const menuWidth = 220
  const menuHeight = 280
  const windowWidth = window.innerWidth
  const windowHeight = window.innerHeight

  let posX = x
  let posY = y

  if (x + menuWidth > windowWidth) {
    posX = windowWidth - menuWidth - 10
  }
  if (y + menuHeight > windowHeight) {
    posY = windowHeight - menuHeight - 10
  }

  menu.style.left = `${posX}px`
  menu.style.top = `${posY}px`
  menu.classList.remove('hidden')

  // Met à jour la visibilité des options selon le contexte
  const goToAlbumBtn = menu.querySelector('[data-action="go-to-album"]')
  const goToArtistBtn = menu.querySelector('[data-action="go-to-artist"]')
  const showInfoBtn = menu.querySelector('[data-action="show-info"]')
  const isMulti = contextMenuTracks.length > 1

  // Cache "Voir l'album", "Voir l'artiste" et "Informations" en multi-sélection
  if (goToAlbumBtn) {
    goToAlbumBtn.style.display = (isMulti || (currentView === 'albums' && selectedAlbumKey)) ? 'none' : 'flex'
  }
  if (goToArtistBtn) {
    goToArtistBtn.style.display = (isMulti || currentView === 'artists') ? 'none' : 'flex'
  }
  if (showInfoBtn) {
    showInfoBtn.style.display = isMulti ? 'none' : 'flex'
  }
}

// Met à jour les labels du menu contextuel selon le nombre de tracks
function updateContextMenuLabels(menu, count) {
  const isMulti = count > 1

  const playBtn = menu.querySelector('[data-action="play"] span')
  const queueBtn = menu.querySelector('[data-action="add-to-queue"] span')
  const playlistBtn = menu.querySelector('[data-action="add-to-playlist"] span')
  const removeBtn = menu.querySelector('[data-action="remove-from-library"] span')

  if (playBtn) playBtn.textContent = isMulti ? `Lire ${count} titres` : 'Lire'
  if (queueBtn) queueBtn.textContent = isMulti ? `Add ${count} to queue` : 'Add to queue'
  if (playlistBtn) playlistBtn.textContent = isMulti ? `Add ${count} to playlist` : 'Add to playlist'
  if (removeBtn) removeBtn.textContent = isMulti ? `Remove ${count} tracks` : 'Remove from library'
}

// Cache le menu contextuel
function hideContextMenu() {
  const menu = document.getElementById('context-menu')
  if (menu) {
    menu.classList.add('hidden')
  }
  contextMenuTracks = []
  contextMenuTrackIndex = -1
}

// Gère les actions du menu contextuel (avec support multi-sélection)
function handleContextMenuAction(action) {
  if (contextMenuTracks.length === 0) return

  const isMulti = contextMenuTracks.length > 1

  switch (action) {
    case 'play':
      if (isMulti) {
        // Multi : joue le premier, ajoute les autres à la queue
        const firstIdx = tracks.findIndex(t => t.path === contextMenuTracks[0].path)
        if (firstIdx !== -1) playTrack(firstIdx)
        // Ajoute les autres à la queue
        for (let i = 1; i < contextMenuTracks.length; i++) {
          addToQueue(contextMenuTracks[i])
        }
      } else {
        // Simple : joue le track
        const idx = tracks.findIndex(t => t.path === contextMenuTracks[0].path)
        if (idx !== -1) playTrack(idx)
      }
      break

    case 'add-to-queue':
      contextMenuTracks.forEach(track => addToQueue(track))
      if (isMulti) {
        showQueueNotification(`${contextMenuTracks.length} tracks added to queue`)
      }
      break

    case 'add-to-playlist':
      if (isMulti) {
        showAddToPlaylistMenuMulti(contextMenuTracks)
      } else {
        showAddToPlaylistMenu(null, contextMenuTracks[0])
      }
      return // Ne pas fermer le menu, le sous-menu s'en charge

    case 'go-to-album':
      if (!isMulti) {
        goToTrackAlbum(contextMenuTracks[0])
      }
      break

    case 'go-to-artist':
      if (!isMulti) {
        goToTrackArtist(contextMenuTracks[0])
      }
      break

    case 'show-info':
      if (!isMulti) {
        showTrackInfoPanel(contextMenuTracks[0])
      }
      break

    case 'remove-from-library':
      removeTracksFromLibrary(contextMenuTracks)
      break
  }

  hideContextMenu()
}

// Navigue vers l'album du track
function goToTrackAlbum(track) {
  const albumName = track.metadata?.album
  if (!albumName) return

  // Trouve l'album correspondant
  const albumKey = Object.keys(albums).find(key => {
    return albums[key].album === albumName
  })

  if (albumKey) {
    // Navigue vers la page dédiée de l'album
    navigateToAlbumPage(albumKey)
  }
}

// Navigue vers l'artiste du track
function goToTrackArtist(track) {
  const artistName = track.metadata?.artist
  if (!artistName || !artists[artistName]) return

  // Passe en vue artistes filtrée par albums de cet artiste
  showArtistAlbums(artistName)
}

// === PANEL INFORMATIONS TRACK ===

// Détecte les doublons d'un track dans la bibliothèque
function findTrackDuplicates(track) {
  const meta = track.metadata || {}
  const title = (meta.title || track.name || '').toLowerCase().trim()
  const artist = (meta.artist || '').toLowerCase().trim()

  if (!title) return []

  return tracks.filter(t => {
    if (t.path === track.path) return false // Exclut le track lui-même
    const tMeta = t.metadata || {}
    const tTitle = (tMeta.title || t.name || '').toLowerCase().trim()
    const tArtist = (tMeta.artist || '').toLowerCase().trim()
    return tTitle === title && tArtist === artist
  })
}

// Affiche le panel d'informations pour un track
async function showTrackInfoPanel(track) {
  const panel = document.getElementById('track-info-panel')
  const content = document.getElementById('track-info-content')
  if (!panel || !content) return

  // Ferme les autres panels avant d'ouvrir
  if (isQueuePanelOpen) toggleQueuePanel()
  if (isSettingsPanelOpen) closeSettings()
  if (getEqPanelOpen()) closeEqPanel()

  trackInfoCurrentTrack = track
  isTrackInfoPanelOpen = true
  panel.classList.add('open')

  // Metadata
  const meta = track.metadata || {}
  const title = meta.title || track.name || 'Titre inconnu'
  const artist = meta.artist || 'Unknown Artist'
  const album = meta.album || 'Unknown Album'
  const year = meta.year || null
  const trackNum = meta.track || null
  const disc = meta.disc || null
  const duration = meta.duration ? formatTime(meta.duration) : '-'
  const bitDepth = meta.bitDepth || null
  const sampleRate = meta.sampleRate || null
  const bitrate = meta.bitrate || null
  const codec = meta.codec || null
  const genre = meta.genre || null

  // Détermine le format de fichier depuis le path
  const fileExt = track.path ? track.path.split('.').pop().toUpperCase() : null

  // Qualité audio
  const quality = formatQuality(meta, track.path)

  // Détecte les doublons
  const duplicates = findTrackDuplicates(track)
  const hasDuplicates = duplicates.length > 0

  // Icône de qualité
  const qualityIcon = quality.class === 'quality-hires'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>'
    : quality.class === 'quality-lossless'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'

  // Construit le HTML
  let html = `
    <div class="track-info-artwork-section">
      <div class="track-info-artwork-container">
        <div class="track-info-artwork-loader" id="track-info-artwork-loader">
          <div class="artwork-spinner"></div>
        </div>
        <img class="track-info-artwork" id="track-info-artwork-img" src="" alt="Artwork" style="display: none;">
        <div class="track-info-artwork-placeholder" id="track-info-artwork-placeholder" style="display: none;">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
          </svg>
        </div>
      </div>
    </div>

    ${hasDuplicates ? `
    <div class="track-info-duplicate-alert">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <span>${duplicates.length} duplicate${duplicates.length > 1 ? 's' : ''} found in library</span>
    </div>
    ` : ''}

    <div class="track-info-title-section">
      <h2 class="track-info-title">${escapeHtml(title)}</h2>
      <p class="track-info-artist track-info-clickable" data-artist="${escapeHtml(artist)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="track-info-link-icon">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
        </svg>
        ${escapeHtml(artist)}
      </p>
      <p class="track-info-album track-info-clickable" data-album="${escapeHtml(album)}">
        <svg viewBox="0 0 24 24" fill="currentColor" class="track-info-link-icon">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"/>
        </svg>
        ${escapeHtml(album)}
      </p>
      <div class="track-info-quality-badge ${quality.class}">
        ${qualityIcon}
        <span>${quality.label}</span>
      </div>
    </div>

    <div class="track-info-specs">
      <div class="track-info-specs-grid">
        <div class="track-info-spec">
          <span class="track-info-spec-label">Quality</span>
          <span class="track-info-spec-value">${quality.label}</span>
        </div>
        <div class="track-info-spec">
          <span class="track-info-spec-label">Duration</span>
          <span class="track-info-spec-value">${duration}</span>
        </div>
        ${fileExt ? `
        <div class="track-info-spec">
          <span class="track-info-spec-label">Format</span>
          <span class="track-info-spec-value">${fileExt}${codec ? ` (${codec})` : ''}</span>
        </div>
        ` : ''}
        ${sampleRate ? `
        <div class="track-info-spec">
          <span class="track-info-spec-label">Sample Rate</span>
          <span class="track-info-spec-value">${formatSampleRate(sampleRate)}</span>
        </div>
        ` : ''}
        ${bitrate ? `
        <div class="track-info-spec">
          <span class="track-info-spec-label">Bitrate</span>
          <span class="track-info-spec-value">${Math.round(bitrate)} kbps</span>
        </div>
        ` : ''}
        ${bitDepth ? `
        <div class="track-info-spec">
          <span class="track-info-spec-label">Profondeur</span>
          <span class="track-info-spec-value">${bitDepth}-bit</span>
        </div>
        ` : ''}
      </div>
    </div>

    ${year || trackNum || genre ? `
    <div class="track-info-metadata">
      <div class="track-info-metadata-grid">
        ${year ? `
        <div class="track-info-metadata-item">
          <span class="track-info-metadata-label">Year</span>
          <span class="track-info-metadata-value">${year}</span>
        </div>
        ` : ''}
        ${trackNum ? `
        <div class="track-info-metadata-item">
          <span class="track-info-metadata-label">Piste</span>
          <span class="track-info-metadata-value">${disc ? `${disc}-` : ''}${trackNum}</span>
        </div>
        ` : ''}
        ${genre ? `
        <div class="track-info-metadata-item">
          <span class="track-info-metadata-label">Genre</span>
          <span class="track-info-metadata-value">${escapeHtml(genre)}</span>
        </div>
        ` : ''}
      </div>
    </div>
    ` : ''}

    <div class="track-info-file">
      <span class="track-info-metadata-label">Fichier</span>
      <div class="track-info-file-path">${escapeHtml(track.path || '')}</div>
    </div>

    <div class="track-info-actions">
      <button class="track-info-refresh-btn" id="track-info-refresh-btn" title="Refresh metadata">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>
          <path d="M21 3v5h-5"/>
        </svg>
        Rafraîchir les métadonnées
      </button>
    </div>
  `

  content.innerHTML = html

  // Ajoute les event listeners pour les liens cliquables
  const artistLink = content.querySelector('.track-info-artist.track-info-clickable')
  const albumLink = content.querySelector('.track-info-album.track-info-clickable')

  if (artistLink) {
    artistLink.addEventListener('click', () => {
      const artistName = artistLink.dataset.artist
      if (artistName && artists[artistName]) {
        closeTrackInfoPanel()
        showArtistAlbums(artistName)
      }
    })
  }

  if (albumLink) {
    albumLink.addEventListener('click', () => {
      const albumName = albumLink.dataset.album
      if (albumName) {
        const albumKey = Object.keys(albums).find(key => albums[key].album === albumName)
        if (albumKey) {
          closeTrackInfoPanel()
          navigateToAlbumPage(albumKey)
        }
      }
    })
  }

  // Event listener pour le bouton refresh métadonnées
  const refreshBtn = document.getElementById('track-info-refresh-btn')
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true
      refreshBtn.textContent = 'Actualisation...'
      try {
        const newMeta = await invoke('refresh_metadata', { path: track.path })
        // Met à jour le track en mémoire
        track.metadata = newMeta
        // Met à jour aussi dans le tableau global tracks
        const idx = tracks.findIndex(t => t.path === track.path)
        if (idx >= 0) tracks[idx].metadata = newMeta
        // Invalide le cache cover pour forcer le rechargement
        coverCache.delete(track.path)
        // Recharge le panel avec les nouvelles données
        showTrackInfoPanel(track)
        showToast('Metadata updated')
      } catch (e) {
        console.error('Erreur refresh metadata:', e)
        showToast('Error updating')
        refreshBtn.disabled = false
        refreshBtn.textContent = 'Refresh metadata'
      }
    })
  }

  // Charge l'artwork de façon asynchrone - FORCE le chargement
  const imgEl = document.getElementById('track-info-artwork-img')
  const placeholderEl = document.getElementById('track-info-artwork-placeholder')
  const loaderEl = document.getElementById('track-info-artwork-loader')

  if (imgEl && placeholderEl && loaderEl) {
    // Check caches d'abord (instantané, pas de loader)
    const cachedCover = coverCache.get(track.path) || thumbnailCache.get(track.path)
    if (isValidImageSrc(cachedCover)) {
      imgEl.src = cachedCover
      imgEl.style.display = 'block'
      placeholderEl.style.display = 'none'
      loaderEl.style.display = 'none'
    } else {
    // Affiche le loader pendant le chargement
    loaderEl.style.display = 'flex'
    imgEl.style.display = 'none'
    placeholderEl.style.display = 'none'

    try {
      // Force le chargement depuis le backend
      const cover = await invoke('get_cover', { path: track.path })

      if (cover) {
        imgEl.src = cover
        imgEl.onload = () => {
          loaderEl.style.display = 'none'
          imgEl.style.display = 'block'
          placeholderEl.style.display = 'none'
        }
        imgEl.onerror = () => {
          loaderEl.style.display = 'none'
          imgEl.style.display = 'none'
          placeholderEl.style.display = 'flex'
        }
        // Met en cache
        coverCache.set(track.path, cover)
      } else {
        // Pas de cover, affiche le placeholder
        loaderEl.style.display = 'none'
        imgEl.style.display = 'none'
        placeholderEl.style.display = 'flex'
      }
    } catch (e) {
      console.warn('Impossible de charger la pochette:', e)
      loaderEl.style.display = 'none'
      imgEl.style.display = 'none'
      placeholderEl.style.display = 'flex'
    }
    } // fin else (pas en cache)
  }
}

// Ferme le panel d'informations
function closeTrackInfoPanel() {
  const panel = document.getElementById('track-info-panel')
  if (panel) {
    panel.classList.remove('open')
  }
  isTrackInfoPanelOpen = false
  trackInfoCurrentTrack = null
}

// Toggle le panel d'informations
function toggleTrackInfoPanel() {
  if (isTrackInfoPanelOpen) {
    closeTrackInfoPanel()
  }
}

// Initialise les événements du panel d'informations
function initTrackInfoPanelListeners() {
  const closeBtn = document.getElementById('close-track-info')
  if (closeBtn) {
    closeBtn.addEventListener('click', closeTrackInfoPanel)
  }

  // Ferme avec Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isTrackInfoPanelOpen) {
      closeTrackInfoPanel()
    }
  })
}

// Initialise au chargement du DOM
document.addEventListener('DOMContentLoaded', initTrackInfoPanelListeners)

// Supprime un track de la bibliothèque
function removeTrackFromLibrary(track) {
  // Trouve l'index dans la liste globale
  const index = tracks.findIndex(t => t.path === track.path)
  if (index === -1) return

  // Supprime de la liste des tracks
  tracks.splice(index, 1)

  // Supprime de la queue si présent
  const queueIndex = queue.findIndex(q => q.path === track.path)
  if (queueIndex !== -1) {
    queue.splice(queueIndex, 1)
  }

  // Regroupe les albums/artistes
  groupTracksIntoAlbumsAndArtists()
  buildTrackLookup()  // Rebuild index after track removal

  // Rafraîchit l'affichage
  displayCurrentView()
  updateQueueDisplay()
  updateQueueIndicators()

  showQueueNotification(`"${track.metadata?.title || track.name}" removed from library`)
}

// Initialise les event listeners du menu contextuel
function initContextMenuListeners() {
  const menu = document.getElementById('context-menu')
  if (!menu) return

  // Clic sur une option du menu
  menu.querySelectorAll('.context-menu-item').forEach(item => {
    item.addEventListener('click', () => {
      const action = item.dataset.action
      handleContextMenuAction(action)
    })
  })

  // Ferme le menu si on clique ailleurs
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#context-menu')) {
      hideContextMenu()
    }
  })

  // Ferme le menu avec Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideContextMenu()
    }
  })

  // Ferme le menu si on scroll
  document.addEventListener('scroll', hideContextMenu, true)
}

// Initialise au chargement du DOM
document.addEventListener('DOMContentLoaded', initContextMenuListeners)

// === PLAYLISTS ===
// === FAVORIS ===

// Charge les favoris depuis le backend
async function loadFavorites() {
  try {
    const paths = await invoke('get_favorites')
    favoriteTracks = new Set(paths)
    console.log(`Favoris chargés: ${favoriteTracks.size} tracks`)
  } catch (e) {
    console.error('Erreur chargement favoris:', e)
    favoriteTracks = new Set()
  }
}

// Toggle favori avec Optimistic UI
async function toggleFavorite(trackPath, buttonEl) {
  if (!buttonEl) return

  // Optimistic UI - toggle immédiat
  const wasActive = buttonEl.classList.contains('active')
  buttonEl.classList.toggle('active')

  // Mettre à jour le SVG (fill)
  const svg = buttonEl.querySelector('svg')
  if (svg) {
    svg.setAttribute('fill', wasActive ? 'none' : 'currentColor')
  }

  // Mettre à jour le Set local
  if (wasActive) {
    favoriteTracks.delete(trackPath)
  } else {
    favoriteTracks.add(trackPath)
  }

  // Appel async au backend
  try {
    await invoke('toggle_favorite', { trackPath })
    // Recharge les playlists pour mettre à jour le compteur
    await loadPlaylists()
  } catch (err) {
    console.error('Erreur toggle favorite:', err)
    // Rollback en cas d'erreur
    buttonEl.classList.toggle('active')
    if (svg) {
      svg.setAttribute('fill', wasActive ? 'currentColor' : 'none')
    }
    if (wasActive) {
      favoriteTracks.add(trackPath)
    } else {
      favoriteTracks.delete(trackPath)
    }
  }
}

// Génère le HTML du bouton favori pour une track
function getFavoriteButtonHtml(trackPath) {
  const isFavorite = favoriteTracks.has(trackPath)
  return `
    <button class="track-favorite-btn ${isFavorite ? 'active' : ''}"
            data-track-path="${trackPath}"
            title="${isFavorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}">
      <svg width="14" height="14" viewBox="0 0 24 24"
           fill="${isFavorite ? 'currentColor' : 'none'}"
           stroke="currentColor" stroke-width="2">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
      </svg>
    </button>
  `
}

// === PLAYLISTS ===

let playlists = []  // Liste des playlists
let selectedPlaylistId = null  // Playlist actuellement affichée
let playlistModalMode = 'create'  // 'create' ou 'rename'
let playlistToRename = null  // ID de la playlist à renommer
let trackToAddToPlaylist = null  // Track à ajouter depuis le sous-menu
let playlistSortMode = 'manual'  // 'manual', 'recent', 'az', 'za'

// Charge les playlists au démarrage
async function loadPlaylists() {
  try {
    playlists = await invoke('get_playlists')
    applyPlaylistsOrder()  // Applique l'ordre personnalisé
    updatePlaylistsSidebar()
  } catch (e) {
    console.error('Erreur chargement playlists:', e)
    playlists = []
  }
}

// Met à jour l'affichage des playlists dans la sidebar
function updatePlaylistsSidebar() {
  const container = document.getElementById('playlists-list')
  if (!container) return

  if (playlists.length === 0) {
    container.innerHTML = '<div class="playlists-empty">Aucune playlist</div>'
    return
  }

  // Trie pour avoir "mes favoris" en premier (isSystem = true)
  const sortedPlaylists = [...playlists].sort((a, b) => {
    if (a.isSystem && !b.isSystem) return -1
    if (!a.isSystem && b.isSystem) return 1
    return 0
  })

  // Génère le HTML des playlists avec icône cœur pour favoris
  container.innerHTML = sortedPlaylists.map((playlist, index) => {
    const isFavorites = playlist.id === 'favorites'
    const icon = isFavorites
      ? `<svg class="playlist-icon-heart" viewBox="0 0 24 24" fill="currentColor">
           <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
         </svg>`
      : `<svg viewBox="0 0 24 24" fill="currentColor">
           <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/>
         </svg>`

    return `
      <div class="playlist-item ${selectedPlaylistId === playlist.id ? 'active' : ''} ${isFavorites ? 'playlist-favorites' : ''}"
           data-playlist-id="${playlist.id}"
           data-playlist-index="${index}"
           data-is-system="${playlist.isSystem || false}">
        ${icon}
        <span class="playlist-item-name">${playlist.name}</span>
        <span class="playlist-item-count">${playlist.trackPaths.length}</span>
      </div>
    `
  }).join('')
}

// Initialise les event listeners de la sidebar des playlists (appelé une seule fois)
function initPlaylistSidebarListeners() {
  const container = document.getElementById('playlists-list')
  if (!container) return

  // Clic = afficher la playlist
  container.addEventListener('click', (e) => {
    const item = e.target.closest('.playlist-item')
    if (!item) return

    const playlistId = item.dataset.playlistId
    const playlist = playlists.find(p => p.id === playlistId)
    if (!playlist) return

    selectedPlaylistId = playlistId
    currentView = 'playlist'
    navItems.forEach(i => i.classList.remove('active'))

    // Met à jour la classe active sans recréer les éléments
    container.querySelectorAll('.playlist-item').forEach(el => {
      el.classList.toggle('active', el.dataset.playlistId === playlistId)
    })

    displayPlaylistView(playlist)
  })

  // Clic droit = menu contextuel playlist
  container.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.playlist-item')
    if (!item) return

    e.preventDefault()
    const playlistId = item.dataset.playlistId
    const playlist = playlists.find(p => p.id === playlistId)
    if (playlist) {
      showPlaylistContextMenu(e, playlist)
    }
  })

  // === DRAG CUSTOM pour réorganiser les playlists (car HTML5 drag ne fonctionne pas dans Tauri WebView) ===
  let playlistDragState = {
    isDragging: false,
    isPotentialDrag: false,
    draggedItem: null,
    draggedIndex: -1,
    startX: 0,
    startY: 0,
    currentDropTarget: null
  }

  const DRAG_THRESHOLD = 5

  // Mousedown sur toute la playlist = prépare le drag
  container.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.playlist-item')
    if (!item) return

    playlistDragState.isPotentialDrag = true
    playlistDragState.draggedItem = item
    playlistDragState.draggedIndex = parseInt(item.dataset.playlistIndex, 10)
    playlistDragState.startX = e.clientX
    playlistDragState.startY = e.clientY
  })

  // Mousemove : gère le drag
  document.addEventListener('mousemove', (e) => {
    if (!playlistDragState.isPotentialDrag) return

    // Vérifie le seuil de mouvement
    if (!playlistDragState.isDragging) {
      const dx = Math.abs(e.clientX - playlistDragState.startX)
      const dy = Math.abs(e.clientY - playlistDragState.startY)

      if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
        playlistDragState.isDragging = true
        playlistDragState.draggedItem?.classList.add('dragging')
      }
    }

    if (!playlistDragState.isDragging) return

    // Trouve l'élément sous le curseur
    const elementUnder = document.elementFromPoint(e.clientX, e.clientY)
    const targetItem = elementUnder?.closest('.playlist-item')

    // Retire l'indicateur de l'ancien target
    if (playlistDragState.currentDropTarget && playlistDragState.currentDropTarget !== targetItem) {
      playlistDragState.currentDropTarget.classList.remove('drag-over-top', 'drag-over-bottom')
    }

    // Ajoute l'indicateur sur le nouveau target
    if (targetItem && targetItem !== playlistDragState.draggedItem) {
      const rect = targetItem.getBoundingClientRect()
      const midY = rect.top + rect.height / 2

      if (e.clientY < midY) {
        targetItem.classList.add('drag-over-top')
        targetItem.classList.remove('drag-over-bottom')
      } else {
        targetItem.classList.add('drag-over-bottom')
        targetItem.classList.remove('drag-over-top')
      }

      playlistDragState.currentDropTarget = targetItem
    }
  })

  // Mouseup : termine le drag
  document.addEventListener('mouseup', async (e) => {
    if (!playlistDragState.isPotentialDrag) return

    const wasDragging = playlistDragState.isDragging
    const draggedIndex = playlistDragState.draggedIndex

    // Nettoie les classes
    if (playlistDragState.draggedItem) {
      playlistDragState.draggedItem.classList.remove('dragging')
    }
    if (playlistDragState.currentDropTarget) {
      playlistDragState.currentDropTarget.classList.remove('drag-over-top', 'drag-over-bottom')
    }

    // Si on a vraiment dragué, effectue le réarrangement
    if (wasDragging && playlistDragState.currentDropTarget) {
      const targetIndex = parseInt(playlistDragState.currentDropTarget.dataset.playlistIndex, 10)

      if (targetIndex !== draggedIndex) {
        const rect = playlistDragState.currentDropTarget.getBoundingClientRect()
        const midY = rect.top + rect.height / 2
        let newIndex = e.clientY < midY ? targetIndex : targetIndex + 1

        // Ajuste l'index si on déplace vers le bas
        if (draggedIndex < newIndex) {
          newIndex--
        }

        // Réorganise les playlists
        const [movedPlaylist] = playlists.splice(draggedIndex, 1)
        playlists.splice(newIndex, 0, movedPlaylist)

        // Sauvegarde et met à jour l'affichage
        await savePlaylistsOrder()
        updatePlaylistsSidebar()
      }
    }

    // Reset l'état
    playlistDragState.isPotentialDrag = false
    playlistDragState.isDragging = false
    playlistDragState.draggedItem = null
    playlistDragState.draggedIndex = -1
    playlistDragState.currentDropTarget = null
  })
}

// Sauvegarde l'ordre des playlists (utilise localStorage en attendant la commande Rust)
async function savePlaylistsOrder() {
  try {
    const playlistIds = playlists.map(p => p.id)
    // Essaie d'abord avec Rust
    try {
      await invoke('reorder_playlists', { playlistIds })
    } catch (e) {
      // Fallback: sauvegarde dans localStorage
      localStorage.setItem('playlists_order', JSON.stringify(playlistIds))
    }
  } catch (e) {
    console.error('Erreur sauvegarde ordre playlists:', e)
  }
}

// Applique l'ordre sauvegardé des playlists
function applyPlaylistsOrder() {
  const savedOrder = localStorage.getItem('playlists_order')
  if (!savedOrder) return

  try {
    const order = JSON.parse(savedOrder)
    const orderedPlaylists = []

    // Reconstruit la liste dans l'ordre sauvegardé
    for (const id of order) {
      const playlist = playlists.find(p => p.id === id)
      if (playlist) orderedPlaylists.push(playlist)
    }

    // Ajoute les nouvelles playlists non présentes dans l'ordre
    for (const playlist of playlists) {
      if (!orderedPlaylists.find(p => p.id === playlist.id)) {
        orderedPlaylists.push(playlist)
      }
    }

    playlists = orderedPlaylists
  } catch (e) {
    console.error('Erreur application ordre playlists:', e)
  }
}

// Affiche la vue d'une playlist
function displayPlaylistView(playlist) {
  // Vide le contenu (appelé directement, pas via displayCurrentView)
  albumsGridDiv.textContent = ''
  albumsViewDiv.classList.remove('hidden')
  closeAlbumDetail()

  // Header de la playlist
  const header = document.createElement('div')
  header.className = 'playlist-view-header'

  const trackCount = playlist.trackPaths.length
  let playlistTracks = playlist.trackPaths
    .map((path, idx) => {
      const track = tracks.find(t => t.path === path)
      if (track) {
        return { ...track, originalIndex: idx }
      }
      return null
    })
    .filter(Boolean)

  // Applique le tri selon le mode sélectionné
  if (playlistSortMode === 'az') {
    playlistTracks.sort((a, b) => {
      const titleA = a.metadata?.title || a.name || ''
      const titleB = b.metadata?.title || b.name || ''
      return titleA.localeCompare(titleB)
    })
  } else if (playlistSortMode === 'za') {
    playlistTracks.sort((a, b) => {
      const titleA = a.metadata?.title || a.name || ''
      const titleB = b.metadata?.title || b.name || ''
      return titleB.localeCompare(titleA)
    })
  } else if (playlistSortMode === 'recent') {
    // Inverse l'ordre (derniers ajoutés en premier)
    playlistTracks.reverse()
  }
  // 'manual' = ordre original, pas de tri

  const totalDuration = playlistTracks.reduce((acc, t) => acc + (t.metadata?.duration || 0), 0)

  header.innerHTML = `
    <div class="playlist-header-info">
      <h2>${playlist.name}</h2>
      <p>${trackCount} titre${trackCount > 1 ? 's' : ''} • ${formatTime(totalDuration)}</p>
    </div>
    <div class="playlist-header-buttons">
      <div class="playlist-sort-dropdown">
        <button class="btn-sort-playlist" title="Trier">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>
          </svg>
          <span class="sort-label">Tri</span>
        </button>
        <div class="sort-menu hidden">
          <button class="sort-option ${playlistSortMode === 'manual' ? 'active' : ''}" data-sort="manual">Manuel</button>
          <button class="sort-option ${playlistSortMode === 'recent' ? 'active' : ''}" data-sort="recent">Recently Added</button>
          <button class="sort-option ${playlistSortMode === 'az' ? 'active' : ''}" data-sort="az">A-Z</button>
          <button class="sort-option ${playlistSortMode === 'za' ? 'active' : ''}" data-sort="za">Z-A</button>
        </div>
      </div>
      <button class="btn-primary-small play-playlist-btn" ${trackCount === 0 ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        Play
      </button>
    </div>
  `

  albumsGridDiv.appendChild(header)

  // Liste des tracks avec drag & drop
  const tracksContainer = document.createElement('div')
  tracksContainer.className = 'playlist-tracks-list'
  tracksContainer.id = 'playlist-tracks-container'

  if (trackCount === 0) {
    tracksContainer.innerHTML = '<div class="playlist-empty-message">Cette playlist est vide.<br>Ajoutez des morceaux avec le bouton + ou le clic droit.</div>'
  } else {
    // Génère le HTML des tracks (sans event listeners individuels)
    tracksContainer.innerHTML = playlistTracks.map((track, index) => {
      if (!track) return ''
      const title = track.metadata?.title || track.name
      const artist = track.metadata?.artist || 'Unknown Artist'
      const duration = track.metadata?.duration ? formatTime(track.metadata.duration) : '-:--'
      return `
        <div class="playlist-track-item" data-index="${index}" data-track-path="${track.path}">
          <span class="playlist-track-number">${index + 1}</span>
          <div class="playlist-track-info">
            <span class="playlist-track-title">${title}</span>
            <span class="playlist-track-artist">${artist}</span>
          </div>
          <span class="playlist-track-duration">${duration}</span>
          <button class="playlist-track-remove" title="Retirer de la playlist">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6L6 18"/><path d="M6 6l12 12"/>
            </svg>
          </button>
        </div>
      `
    }).join('')

    // EVENT DELEGATION : Un seul listener pour tous les clics
    tracksContainer.addEventListener('click', (e) => {
      const trackItem = e.target.closest('.playlist-track-item')
      if (!trackItem) return

      const trackPath = trackItem.dataset.trackPath
      const track = tracks.find(t => t.path === trackPath)
      if (!track) return

      // Bouton supprimer
      if (e.target.closest('.playlist-track-remove')) {
        e.stopPropagation()
        removeTrackFromPlaylist(playlist.id, track.path)
        return
      }

      // Simple clic = sélectionner la track
      tracksContainer.querySelectorAll('.playlist-track-item.selected').forEach(el => {
        el.classList.remove('selected')
      })
      trackItem.classList.add('selected')
    })

    // Double-clic = jouer la track
    tracksContainer.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return

      const trackItem = e.target.closest('.playlist-track-item')
      if (!trackItem) return

      const trackPath = trackItem.dataset.trackPath
      const globalIndex = tracks.findIndex(t => t.path === trackPath)
      if (globalIndex !== -1) playTrack(globalIndex)
    })

    // EVENT DELEGATION : Un seul listener pour les clics droits
    tracksContainer.addEventListener('contextmenu', (e) => {
      const trackItem = e.target.closest('.playlist-track-item')
      if (!trackItem) return

      const trackPath = trackItem.dataset.trackPath
      const track = tracks.find(t => t.path === trackPath)
      if (!track) return

      const globalIndex = tracks.findIndex(t => t.path === trackPath)
      showContextMenu(e, track, globalIndex)
    })

    // Drag custom pour les tracks de playlist
    tracksContainer.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return

      const trackItem = e.target.closest('.playlist-track-item')
      if (!trackItem) return

      const trackPath = trackItem.dataset.trackPath
      const track = tracks.find(t => t.path === trackPath)
      if (!track) return

      prepareCustomDrag(e, track, trackItem)
    })
  }

  albumsGridDiv.appendChild(tracksContainer)

  // Event listener pour le bouton lecture
  header.querySelector('.play-playlist-btn')?.addEventListener('click', () => {
    playPlaylist(playlist)
  })

  // Event listeners pour le tri
  const sortBtn = header.querySelector('.btn-sort-playlist')
  const sortMenu = header.querySelector('.sort-menu')

  if (sortBtn && sortMenu) {
    sortBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      sortMenu.classList.toggle('hidden')
    })

    sortMenu.querySelectorAll('.sort-option').forEach(option => {
      option.addEventListener('click', (e) => {
        e.stopPropagation()
        const newSort = option.dataset.sort
        playlistSortMode = newSort
        sortMenu.classList.add('hidden')
        displayPlaylistView(playlist)  // Rafraîchit la vue avec le nouveau tri
      })
    })

    // Ferme le menu si on clique ailleurs
    document.addEventListener('click', () => {
      sortMenu.classList.add('hidden')
    }, { once: true })
  }
}

// Joue une playlist
function playPlaylist(playlist) {
  const playlistTracks = playlist.trackPaths
    .map(path => tracks.find(t => t.path === path))
    .filter(Boolean)

  if (playlistTracks.length > 0) {
    // Joue le premier track
    const firstTrack = playlistTracks[0]
    const globalIndex = tracks.findIndex(t => t.path === firstTrack.path)
    if (globalIndex !== -1) {
      playTrack(globalIndex)
      // Ajoute le reste à la queue
      for (let i = 1; i < playlistTracks.length; i++) {
        addToQueue(playlistTracks[i])
      }
    }
  }
}

// === CRÉATION / RENOMMAGE PLAYLIST ===
function showPlaylistModal(mode = 'create', playlist = null) {
  playlistModalMode = mode
  playlistToRename = playlist

  const modal = document.getElementById('playlist-modal')
  const title = document.getElementById('playlist-modal-title')
  const input = document.getElementById('playlist-name-input')
  const confirmBtn = document.getElementById('playlist-modal-confirm')

  if (mode === 'create') {
    title.textContent = 'New playlist'
    input.value = ''
    input.placeholder = 'Playlist name'
    confirmBtn.textContent = 'Create'
  } else {
    title.textContent = 'Rename playlist'
    input.value = playlist?.name || ''
    input.placeholder = 'New name'
    confirmBtn.textContent = 'Rename'
  }

  modal.classList.remove('hidden')
  input.focus()
  input.select()
}

function hidePlaylistModal() {
  const modal = document.getElementById('playlist-modal')
  modal.classList.add('hidden')
  playlistModalMode = 'create'
  playlistToRename = null
  trackToAddToPlaylist = null
  tracksToAddToPlaylist = null
}

async function confirmPlaylistModal() {
  const input = document.getElementById('playlist-name-input')
  const name = input.value.trim()

  if (!name) return

  // IMPORTANT: Sauvegarder les refs IMMÉDIATEMENT avant tout await
  // car hidePlaylistModal() pourrait être appelé pendant les awaits (backdrop click, Escape, etc.)
  const pendingTrack = trackToAddToPlaylist
  const pendingTracks = tracksToAddToPlaylist
  const mode = playlistModalMode

  console.log('[PLAYLIST] confirmPlaylistModal called:', { name, mode, hasPendingTrack: !!pendingTrack, hasPendingTracks: !!pendingTracks?.length })

  if (mode === 'create') {
    try {
      const newPlaylist = await invoke('create_playlist', { name })
      console.log('[PLAYLIST] Created playlist:', JSON.stringify(newPlaylist))
      playlists.push(newPlaylist)
      updatePlaylistsSidebar()

      // Ajouter les tracks pendantes
      if (pendingTracks && pendingTracks.length > 0) {
        for (const track of pendingTracks) {
          const result = await invoke('add_track_to_playlist', {
            playlistId: newPlaylist.id,
            trackPath: track.path
          })
          console.log('[PLAYLIST] Added track to playlist:', { trackPath: track.path, result })
        }
        await loadPlaylists()
        showQueueNotification(`${pendingTracks.length} tracks added to "${name}"`)
      }
      else if (pendingTrack) {
        console.log('[PLAYLIST] Adding single track:', { playlistId: newPlaylist.id, trackPath: pendingTrack.path })
        const result = await invoke('add_track_to_playlist', {
          playlistId: newPlaylist.id,
          trackPath: pendingTrack.path
        })
        console.log('[PLAYLIST] add_track_to_playlist result:', result)
        await loadPlaylists()
        showQueueNotification(`"${pendingTrack.metadata?.title || pendingTrack.name}" added to "${name}"`)
      } else {
        showQueueNotification(`Playlist "${name}" created`)
      }
    } catch (e) {
      console.error('[PLAYLIST] Error creating playlist or adding tracks:', e)
      showToast('Error creating playlist')
    }
  } else if (mode === 'rename' && playlistToRename) {
    await invoke('rename_playlist', { id: playlistToRename.id, newName: name })
    await loadPlaylists()
    showQueueNotification(`Playlist renamed to "${name}"`)
  }

  // Cleanup des variables de pending track
  trackToAddToPlaylist = null
  tracksToAddToPlaylist = null
  hidePlaylistModal()
}

// === AJOUTER / SUPPRIMER DES TRACKS ===
async function addTrackToPlaylist(playlistId, track) {
  const result = await invoke('add_track_to_playlist', {
    playlistId,
    trackPath: track.path
  })

  if (result) {
    await loadPlaylists()
    const playlist = playlists.find(p => p.id === playlistId)
    showQueueNotification(`Added to "${playlist?.name}"`)
    // Ne pas naviguer vers la playlist, rester sur la vue actuelle
  }
}

async function removeTrackFromPlaylist(playlistId, trackPath) {
  const result = await invoke('remove_track_from_playlist', {
    playlistId,
    trackPath
  })

  if (result) {
    await loadPlaylists()
    const playlist = playlists.find(p => p.id === playlistId)

    // Rafraîchit la vue
    if (selectedPlaylistId === playlistId && playlist) {
      displayPlaylistView(playlist)
    }
  }
}

async function deletePlaylist(playlistId) {
  const playlist = playlists.find(p => p.id === playlistId)

  // Empêcher la suppression des playlists système (favoris, etc.)
  if (playlist?.isSystem) {
    showQueueNotification("This playlist cannot be deleted")
    return
  }

  // Demander confirmation avant suppression
  const confirmed = await showConfirmModal(
    'Supprimer la playlist ?',
    `The playlist "${playlist?.name}" will be permanently deleted.`,
    'Supprimer'
  )

  if (!confirmed) return

  const result = await invoke('delete_playlist', { id: playlistId })

  if (result) {
    await loadPlaylists()
    showQueueNotification(`Playlist deleted`)

    // Retourne à la vue albums si on était sur cette playlist
    if (selectedPlaylistId === playlistId) {
      selectedPlaylistId = null
      currentView = 'albums'
      navItems.forEach(i => i.classList.remove('active'))
      document.querySelector('[data-view="albums"]').classList.add('active')
      displayCurrentView()
    }
  }
}

// === MENU CONTEXTUEL PLAYLIST (clic droit sur une playlist) ===
function showPlaylistContextMenu(e, playlist) {
  // Supprime tous les menus contextuels playlist existants (évite les doublons)
  document.querySelectorAll('.playlist-context-menu').forEach(m => m.remove())

  // Crée un menu contextuel temporaire pour la playlist
  hideContextMenu()

  const isSystemPlaylist = playlist.isSystem || playlist.id === 'favorites'

  const menu = document.createElement('div')
  menu.className = 'context-menu playlist-context-menu'
  menu.innerHTML = `
    <button class="context-menu-item" data-action="play-playlist">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      <span>Play</span>
    </button>
    <div class="context-menu-separator"></div>
    <button class="context-menu-item" data-action="rename-playlist">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
      </svg>
      <span>Rename</span>
    </button>
    ${!isSystemPlaylist ? `
      <button class="context-menu-item context-menu-item-danger" data-action="delete-playlist">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
        </svg>
        <span>Delete</span>
      </button>
    ` : ''}
  `

  // Position
  menu.style.left = `${e.clientX}px`
  menu.style.top = `${e.clientY}px`
  document.body.appendChild(menu)

  // Actions
  menu.querySelector('[data-action="play-playlist"]').addEventListener('click', () => {
    playPlaylist(playlist)
    menu.remove()
  })

  menu.querySelector('[data-action="rename-playlist"]').addEventListener('click', () => {
    showPlaylistModal('rename', playlist)
    menu.remove()
  })

  // Supprimer uniquement si pas une playlist système
  const deleteBtn = menu.querySelector('[data-action="delete-playlist"]')
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      deletePlaylist(playlist.id)
      menu.remove()
    })
  }

  // Ferme au clic ailleurs
  const closeHandler = (ev) => {
    if (!ev.target.closest('.playlist-context-menu')) {
      menu.remove()
      document.removeEventListener('click', closeHandler)
    }
  }
  setTimeout(() => document.addEventListener('click', closeHandler), 0)
}

// === MINI-MENU AJOUTER À PLAYLIST (pour le bouton + sur les tracks) ===
function showAddToPlaylistMenu(e, track) {
  if (e) {
    e.stopPropagation()
    e.preventDefault()
  }

  // Supprime tout menu existant
  document.querySelectorAll('.add-to-playlist-menu').forEach(m => m.remove())

  const menu = document.createElement('div')
  menu.className = 'context-menu add-to-playlist-menu'

  let menuContent = ''

  if (playlists.length === 0) {
    menuContent = '<div style="padding: 10px 14px; color: #555; font-size: 12px;">Aucune playlist</div>'
  } else {
    playlists.forEach(playlist => {
      menuContent += `
        <button class="context-menu-item" data-playlist-id="${playlist.id}">
          <svg viewBox="0 0 24 24" fill="currentColor" style="width: 14px; height: 14px;">
            <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/>
          </svg>
          <span>${playlist.name}</span>
        </button>
      `
    })
  }

  menuContent += `
    <div class="context-menu-separator"></div>
    <button class="context-menu-item" data-action="new-playlist">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px;">
        <circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>
      </svg>
      <span>Nouvelle playlist...</span>
    </button>
  `

  menu.innerHTML = menuContent

  // Position
  let posX, posY
  if (e && e.target) {
    const rect = e.target.getBoundingClientRect()
    posX = rect.right + 5
    posY = rect.top

    // Ajuste si dépasse l'écran
    if (posX + 180 > window.innerWidth) {
      posX = rect.left - 185
    }
    if (posY + 200 > window.innerHeight) {
      posY = window.innerHeight - 210
    }
  } else {
    // Position au centre si pas d'événement
    posX = (window.innerWidth - 200) / 2
    posY = (window.innerHeight - 200) / 2
  }

  menu.style.left = `${posX}px`
  menu.style.top = `${posY}px`
  document.body.appendChild(menu)

  // Events
  menu.querySelectorAll('[data-playlist-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      addTrackToPlaylist(btn.dataset.playlistId, track)
      menu.remove()
    })
  })

  menu.querySelector('[data-action="new-playlist"]').addEventListener('click', () => {
    trackToAddToPlaylist = track
    menu.remove()
    showPlaylistModal('create')
  })

  // Ferme au clic ailleurs (capture phase pour intercepter avant autres handlers)
  const closeHandler = (ev) => {
    if (!ev.target.closest('.add-to-playlist-menu') &&
        !ev.target.closest('.tracks-list-add-playlist') &&
        !ev.target.closest('.track-add-playlist')) {
      menu.remove()
      document.removeEventListener('click', closeHandler, true)
    }
  }
  // Ajout immédiat avec capture
  requestAnimationFrame(() => {
    document.addEventListener('click', closeHandler, true)
  })
}

// Menu pour ajouter plusieurs tracks à une playlist
function showAddToPlaylistMenuMulti(tracksToAdd) {
  // Supprime tout menu existant
  document.querySelectorAll('.add-to-playlist-menu').forEach(m => m.remove())

  const menu = document.createElement('div')
  menu.className = 'context-menu add-to-playlist-menu'

  let menuContent = ''

  if (playlists.length === 0) {
    menuContent = '<div style="padding: 10px 14px; color: #555; font-size: 12px;">Aucune playlist</div>'
  } else {
    playlists.forEach(playlist => {
      menuContent += `
        <button class="context-menu-item" data-playlist-id="${playlist.id}">
          <svg viewBox="0 0 24 24" fill="currentColor" style="width: 14px; height: 14px;">
            <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/>
          </svg>
          <span>${escapeHtml(playlist.name)}</span>
        </button>
      `
    })
  }

  menuContent += `
    <div class="context-menu-separator"></div>
    <button class="context-menu-item" data-action="new-playlist">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px;">
        <circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>
      </svg>
      <span>Nouvelle playlist...</span>
    </button>
  `

  menu.innerHTML = menuContent

  // Position au centre de l'écran pour multi-sélection
  const menuWidth = 200
  const menuHeight = Math.min(300, playlists.length * 40 + 80)
  menu.style.left = `${(window.innerWidth - menuWidth) / 2}px`
  menu.style.top = `${(window.innerHeight - menuHeight) / 2}px`
  document.body.appendChild(menu)

  // Events
  menu.querySelectorAll('[data-playlist-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const playlistId = btn.dataset.playlistId
      for (const track of tracksToAdd) {
        await addTrackToPlaylist(playlistId, track)
      }
      const playlist = playlists.find(p => p.id === playlistId)
      showQueueNotification(`${tracksToAdd.length} tracks added to "${playlist?.name}"`)
      menu.remove()
      // Clear la sélection
      virtualScrollState.selectedTrackPaths.clear()
      updateTrackSelectionDisplay()
    })
  })

  const newPlaylistBtn = menu.querySelector('[data-action="new-playlist"]')
  if (newPlaylistBtn) {
    newPlaylistBtn.addEventListener('click', () => {
      // Stocke les tracks pour les ajouter après création
      tracksToAddToPlaylist = tracksToAdd
      menu.remove()
      showPlaylistModal('create')
    })
  }

  // Ferme au clic ailleurs
  const closeHandler = (ev) => {
    if (!ev.target.closest('.add-to-playlist-menu')) {
      menu.remove()
      document.removeEventListener('click', closeHandler, true)
    }
  }
  requestAnimationFrame(() => {
    document.addEventListener('click', closeHandler, true)
  })
}

// Variable pour stocker les tracks à ajouter après création de playlist
let tracksToAddToPlaylist = null

// Supprime plusieurs tracks de la bibliothèque
// === MODALE DE CONFIRMATION ===
let confirmModalResolve = null

function showConfirmModal(title, message, confirmText = 'Supprimer') {
  return new Promise((resolve) => {
    confirmModalResolve = resolve

    const modal = document.getElementById('confirm-modal')
    const titleEl = document.getElementById('confirm-modal-title')
    const messageEl = document.getElementById('confirm-modal-message')
    const confirmBtn = document.getElementById('confirm-modal-confirm')

    titleEl.textContent = title
    messageEl.textContent = message
    confirmBtn.textContent = confirmText

    modal.classList.remove('hidden')
  })
}

function hideConfirmModal(result = false) {
  const modal = document.getElementById('confirm-modal')
  modal.classList.add('hidden')

  if (confirmModalResolve) {
    confirmModalResolve(result)
    confirmModalResolve = null
  }
}

// Initialisation des listeners de la modale de confirmation
document.addEventListener('DOMContentLoaded', () => {
  const cancelBtn = document.getElementById('confirm-modal-cancel')
  const confirmBtn = document.getElementById('confirm-modal-confirm')
  const backdrop = document.querySelector('#confirm-modal .modal-backdrop')

  if (cancelBtn) cancelBtn.addEventListener('click', () => hideConfirmModal(false))
  if (confirmBtn) confirmBtn.addEventListener('click', () => hideConfirmModal(true))
  if (backdrop) backdrop.addEventListener('click', () => hideConfirmModal(false))

  // Échap pour fermer
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('confirm-modal').classList.contains('hidden')) {
      hideConfirmModal(false)
    }
  })
})

async function removeTracksFromLibrary(tracksToRemove) {
  if (tracksToRemove.length === 0) return

  // Demande toujours confirmation avec modale
  const count = tracksToRemove.length
  const title = count === 1 ? 'Remove this track?' : `Remove ${count} tracks?`
  const message = count === 1
    ? `"${tracksToRemove[0].metadata?.title || tracksToRemove[0].name}" will be removed from your library.`
    : `${count} tracks will be removed from your library.`

  const confirmed = await showConfirmModal(title, message, 'Supprimer')
  if (!confirmed) return

  // Persiste l'exclusion côté Rust (survit aux redémarrages/rescans)
  const pathsToExclude = tracksToRemove.map(t => t.path)
  try {
    await invoke('exclude_tracks_from_library', { paths: pathsToExclude })
    console.log(`[LIBRARY] Excluded ${pathsToExclude.length} tracks permanently`)
  } catch (e) {
    console.error('[LIBRARY] Error excluding tracks:', e)
  }

  // Supprime chaque track du state frontend
  for (const track of tracksToRemove) {
    removeTrackFromLibrary(track)
  }

  // Clear la sélection
  virtualScrollState.selectedTrackPaths.clear()
  updateTrackSelectionDisplay()

  showQueueNotification(`${count} track${count > 1 ? 's' : ''} removed`)
}

// === SOUS-MENU PLAYLISTS (dans le menu contextuel principal) ===
function showPlaylistSubmenu() {
  const submenu = document.getElementById('playlist-submenu')
  const list = document.getElementById('playlist-submenu-list')
  const menu = document.getElementById('context-menu')
  const parentBtn = document.querySelector('[data-action="add-to-playlist"]')

  if (!submenu || !list || !menu || !parentBtn) return

  list.innerHTML = ''

  if (playlists.length === 0) {
    list.innerHTML = '<div style="padding: 8px 14px; color: #555; font-size: 12px;">Aucune playlist</div>'
  } else {
    playlists.forEach(playlist => {
      const item = document.createElement('button')
      item.className = 'context-menu-item'
      item.innerHTML = `
        <svg viewBox="0 0 24 24" fill="currentColor" style="width: 14px; height: 14px;">
          <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/>
        </svg>
        <span>${playlist.name}</span>
      `
      item.addEventListener('click', async (e) => {
        e.stopPropagation()
        if (contextMenuTracks.length > 0) {
          for (const track of contextMenuTracks) {
            await addTrackToPlaylist(playlist.id, track)
          }
          if (contextMenuTracks.length > 1) {
            showQueueNotification(`${contextMenuTracks.length} tracks added to "${playlist.name}"`)
          }
        }
        hideContextMenu()
      })
      list.appendChild(item)
    })
  }

  // Position le sous-menu avec position fixed (coordonnées écran)
  const btnRect = parentBtn.getBoundingClientRect()
  const menuRect = menu.getBoundingClientRect()

  // Position à droite du menu principal
  let left = menuRect.right - 4
  let top = btnRect.top

  // Vérifie si le sous-menu dépasse à droite de l'écran
  if (left + 180 > window.innerWidth) {
    left = menuRect.left - 180 + 4  // Affiche à gauche du menu
  }

  // Vérifie si le sous-menu dépasse en bas de l'écran
  if (top + 200 > window.innerHeight) {
    top = window.innerHeight - 210
  }

  submenu.style.left = `${left}px`
  submenu.style.top = `${top}px`
  submenu.classList.remove('hidden')
}

function hidePlaylistSubmenu() {
  const submenu = document.getElementById('playlist-submenu')
  if (submenu) submenu.classList.add('hidden')
}

// Initialise les listeners des playlists
function initPlaylistListeners() {
  // Bouton créer playlist dans sidebar
  const createBtn = document.getElementById('create-playlist-btn')
  if (createBtn) {
    createBtn.addEventListener('click', () => showPlaylistModal('create'))
  }

  // Modale
  const modalCancel = document.getElementById('playlist-modal-cancel')
  const modalConfirm = document.getElementById('playlist-modal-confirm')
  const modalBackdrop = document.querySelector('.modal-backdrop')
  const modalInput = document.getElementById('playlist-name-input')

  if (modalCancel) modalCancel.addEventListener('click', hidePlaylistModal)
  if (modalConfirm) modalConfirm.addEventListener('click', confirmPlaylistModal)
  if (modalBackdrop) modalBackdrop.addEventListener('click', hidePlaylistModal)
  if (modalInput) {
    modalInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmPlaylistModal()
      if (e.key === 'Escape') hidePlaylistModal()
    })
  }

  // Sous-menu playlists dans menu contextuel
  const addToPlaylistBtn = document.querySelector('[data-action="add-to-playlist"]')
  const submenu = document.getElementById('playlist-submenu')

  if (addToPlaylistBtn) {
    addToPlaylistBtn.addEventListener('mouseenter', showPlaylistSubmenu)
    addToPlaylistBtn.addEventListener('mouseleave', (e) => {
      // Ne cache pas si on va vers le sous-menu
      const relatedTarget = e.relatedTarget
      if (relatedTarget && (relatedTarget.closest('#playlist-submenu') || relatedTarget.closest('[data-action="add-to-playlist"]'))) {
        return
      }
      setTimeout(() => {
        if (!document.querySelector('#playlist-submenu:hover') && !document.querySelector('[data-action="add-to-playlist"]:hover')) {
          hidePlaylistSubmenu()
        }
      }, 100)
    })
  }

  if (submenu) {
    submenu.addEventListener('mouseleave', (e) => {
      const relatedTarget = e.relatedTarget
      if (relatedTarget && relatedTarget.closest('[data-action="add-to-playlist"]')) {
        return
      }
      hidePlaylistSubmenu()
    })
  }

  // Créer nouvelle playlist depuis sous-menu
  const createNewPlaylistBtn = document.querySelector('[data-action="create-new-playlist"]')
  if (createNewPlaylistBtn) {
    createNewPlaylistBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      // Utilise le premier track si multi-sélection, sinon le track unique
      trackToAddToPlaylist = contextMenuTracks.length > 0 ? contextMenuTracks[0] : null
      tracksToAddToPlaylist = contextMenuTracks.length > 1 ? [...contextMenuTracks] : null
      hideContextMenu()
      showPlaylistModal('create')
    })
  }

  // Initialise les listeners de la sidebar des playlists
  initPlaylistSidebarListeners()

  // Charge les playlists
  loadPlaylists()
}

// Initialise au chargement du DOM
document.addEventListener('DOMContentLoaded', initPlaylistListeners)
document.addEventListener('DOMContentLoaded', initCustomDragSystem)

// === RACCOURCIS CLAVIER GLOBAUX ===
// Ces raccourcis fonctionnent même quand l'application n'est pas au focus

let globalShortcutsRegistered = false

async function initGlobalShortcuts() {
  // Évite d'enregistrer plusieurs fois
  if (globalShortcutsRegistered) return

  try {
    const { register, unregisterAll } = window.__TAURI__.globalShortcut

    // D'abord désenregistre tous les raccourcis existants
    await unregisterAll()

    // Play/Pause : MediaPlayPause ou Cmd/Ctrl+Space
    try {
      await register('MediaPlayPause', () => {
        console.log('[SHORTCUT] MediaPlayPause triggered')
        togglePlay()
      })
      console.log('[SHORTCUTS] MediaPlayPause registered')
    } catch (e) {
      console.log('[SHORTCUTS] MediaPlayPause not available, trying Ctrl+Space')
      try {
        // Fallback : Cmd+Space sur Mac, Ctrl+Space sur Windows/Linux
        const playPauseKey = navigator.platform.includes('Mac') ? 'Cmd+Shift+P' : 'Ctrl+Shift+P'
        await register(playPauseKey, () => {
          console.log('[SHORTCUT] Play/Pause triggered')
          togglePlay()
        })
        console.log(`[SHORTCUTS] ${playPauseKey} registered for Play/Pause`)
      } catch (e2) {
        console.warn('[SHORTCUTS] Could not register play/pause shortcut:', e2)
      }
    }

    // Track suivante : MediaTrackNext ou Cmd/Ctrl+Right
    try {
      await register('MediaTrackNext', () => {
        console.log('[SHORTCUT] MediaTrackNext triggered')
        playNextTrack()
      })
      console.log('[SHORTCUTS] MediaTrackNext registered')
    } catch (e) {
      try {
        const nextKey = navigator.platform.includes('Mac') ? 'Cmd+Shift+Right' : 'Ctrl+Shift+Right'
        await register(nextKey, () => {
          console.log('[SHORTCUT] Next track triggered')
          playNextTrack()
        })
        console.log(`[SHORTCUTS] ${nextKey} registered for Next`)
      } catch (e2) {
        console.warn('[SHORTCUTS] Could not register next track shortcut:', e2)
      }
    }

    // Track précédente : MediaTrackPrevious ou Cmd/Ctrl+Left
    try {
      await register('MediaTrackPrevious', () => {
        console.log('[SHORTCUT] MediaTrackPrevious triggered')
        playPreviousTrack()
      })
      console.log('[SHORTCUTS] MediaTrackPrevious registered')
    } catch (e) {
      try {
        const prevKey = navigator.platform.includes('Mac') ? 'Cmd+Shift+Left' : 'Ctrl+Shift+Left'
        await register(prevKey, () => {
          console.log('[SHORTCUT] Previous track triggered')
          playPreviousTrack()
        })
        console.log(`[SHORTCUTS] ${prevKey} registered for Previous`)
      } catch (e2) {
        console.warn('[SHORTCUTS] Could not register previous track shortcut:', e2)
      }
    }

    // Volume Up : MediaVolumeUp ou Cmd/Ctrl+Up
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

    // Volume Down : MediaVolumeDown ou Cmd/Ctrl+Down
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

    // Mute : MediaMute ou Cmd/Ctrl+M
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

    globalShortcutsRegistered = true
    console.log('[SHORTCUTS] Global shortcuts initialized successfully')

  } catch (error) {
    console.error('[SHORTCUTS] Error initializing global shortcuts:', error)
  }
}

// Ajuste le volume de façon relative (delta en pourcentage 0-1)
function adjustVolume(delta) {
  // volumeBar utilise une échelle 0-100
  const currentVolumePercent = volumeBar ? parseFloat(volumeBar.value) : 100
  const deltaPercent = delta * 100 // Convertit delta 0-1 vers 0-100
  const newVolumePercent = Math.max(0, Math.min(100, currentVolumePercent + deltaPercent))
  const newVolumeNormalized = newVolumePercent / 100 // Pour Rust (0-1)

  if (volumeBar) {
    volumeBar.value = newVolumePercent
    updateVolumeIcon(newVolumeNormalized)
  }

  // Envoie au backend Rust (attend 0-1)
  invoke('audio_set_volume', { volume: newVolumeNormalized }).catch(console.error)

  // Feedback visuel
  showToast(`Volume: ${Math.round(newVolumePercent)}%`)
}

// Toggle mute (utilise lastVolume qui est déjà défini globalement)
function toggleMute() {
  const currentVolumePercent = volumeBar ? parseFloat(volumeBar.value) : 100

  if (currentVolumePercent > 0) {
    // Mute
    lastVolume = currentVolumePercent
    if (volumeBar) {
      volumeBar.value = 0
      updateVolumeIcon(0)
    }
    invoke('audio_set_volume', { volume: 0 }).catch(console.error)
    showToast('Volume: Muted')
  } else {
    // Unmute
    const restorePercent = lastVolume || 100
    if (volumeBar) {
      volumeBar.value = restorePercent
      updateVolumeIcon(restorePercent / 100)
    }
    invoke('audio_set_volume', { volume: restorePercent / 100 }).catch(console.error)
    showToast(`Volume: ${Math.round(restorePercent)}%`)
  }
}

// Initialise les raccourcis au chargement
document.addEventListener('DOMContentLoaded', initGlobalShortcuts)

// === RACCOURCIS CLAVIER LOCAUX CONFIGURABLES ===

// Raccourcis par défaut : { action: { key, meta, ctrl, shift, alt } }
// key = e.code pour les touches spéciales, e.key.toLowerCase() pour les lettres
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

// Map action → callback
const SHORTCUT_ACTIONS = {
  play_pause:     () => togglePlay(),
  next_track:     () => playNextTrack(),
  prev_track:     () => playPreviousTrack(),
  seek_forward:   () => seekRelative(10),
  seek_backward:  () => seekRelative(-10),
  volume_up:      () => adjustVolume(0.05),
  volume_down:    () => adjustVolume(-0.05),
  close_panel:    () => closeAllPanels(),
  settings:       () => toggleSettings(),
  mute:           () => toggleMute(),
  repeat:         () => cycleRepeatMode(),
  shuffle:        () => toggleShuffleMode(),
  favorite:       () => toggleFavoriteFromKeyboard(),
}

// Raccourcis actifs (merge defaults + localStorage overrides)
let activeShortcuts = {}

function loadShortcuts() {
  // Clone les défauts
  activeShortcuts = {}
  for (const [action, binding] of Object.entries(DEFAULT_SHORTCUTS)) {
    activeShortcuts[action] = { ...binding }
  }
  // Merge les overrides depuis localStorage
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

function saveShortcuts() {
  // Sauvegarde seulement les différences par rapport aux défauts
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

// Vérifie si un événement keydown correspond à un binding
function matchesShortcut(event, binding) {
  // Vérifie les modifiers
  const metaMatch = binding.meta ? (event.metaKey || event.ctrlKey) : !(event.metaKey || event.ctrlKey)
  const shiftMatch = binding.shift ? event.shiftKey : !event.shiftKey
  const altMatch = binding.alt ? event.altKey : !event.altKey

  if (!metaMatch || !shiftMatch || !altMatch) return false

  // Vérifie la touche : par code OU par key
  if (binding.code) return event.code === binding.code
  if (binding.key) return event.key.toLowerCase() === binding.key
  return false
}

// Formate un raccourci pour l'affichage (⌘ ⇧ ⌥ + touche)
function formatShortcutDisplay(binding) {
  const parts = []
  if (binding.meta) parts.push('⌘')
  if (binding.ctrl) parts.push('⌃')
  if (binding.alt) parts.push('⌥')
  if (binding.shift) parts.push('⇧')

  // Touche principale
  const keyName = binding.code || binding.key || '?'
  const displayNames = {
    'Space': '␣', 'ArrowRight': '→', 'ArrowLeft': '←',
    'ArrowUp': '↑', 'ArrowDown': '↓', 'Escape': 'Esc',
    ',': ',',
  }
  parts.push(displayNames[keyName] || keyName.toUpperCase())
  return parts.join(' ')
}

function initLocalKeyboardShortcuts() {
  loadShortcuts()

  document.addEventListener('keydown', (e) => {
    // Ignore si on est dans un champ de texte (sauf si c'est un shortcut capture)
    if (e.target.matches('input, textarea, [contenteditable]')) return

    // Teste chaque raccourci actif
    for (const [action, binding] of Object.entries(activeShortcuts)) {
      if (matchesShortcut(e, binding)) {
        e.preventDefault()
        const callback = SHORTCUT_ACTIONS[action]
        if (callback) callback()
        return
      }
    }
  })
}

// Toggle favori depuis le raccourci clavier (sans élément bouton)
async function toggleFavoriteFromKeyboard() {
  if (currentTrackIndex < 0 || !tracks[currentTrackIndex]) {
    showToast('No track playing')
    return
  }

  const trackPath = tracks[currentTrackIndex].path
  const trackTitle = tracks[currentTrackIndex].metadata?.title || tracks[currentTrackIndex].name

  try {
    const isNowFavorite = await invoke('toggle_favorite', { trackPath })

    // Met à jour le Set local
    if (isNowFavorite) {
      favoriteTracks.add(trackPath)
      showToast(`"${trackTitle}" added to favorites ❤️`)
      // Affiche l'animation du cœur sur la pochette du player
      showHeartAnimation()
    } else {
      favoriteTracks.delete(trackPath)
      showToast(`"${trackTitle}" removed from favorites`)
    }

    // Met à jour l'icône dans le player si visible
    updatePlayerFavoriteIcon(trackPath, isNowFavorite)

    // Recharge les playlists pour mettre à jour le compteur
    await loadPlaylists()
  } catch (err) {
    console.error('Erreur toggle favorite:', err)
    showToast('Error toggling favorite')
  }
}

// Affiche l'animation du cœur qui s'envole sur la pochette du player
function showHeartAnimation() {
  const coverArt = document.getElementById('cover-art')
  if (!coverArt) return

  // Crée l'élément cœur avec SVG blanc
  const heart = document.createElement('div')
  heart.className = 'like-heart-animation'
  heart.innerHTML = `<svg width="32" height="32" viewBox="0 0 24 24" fill="#fff" stroke="none">
    <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
  </svg>`

  // Ajoute au parent de la cover (pour le positionnement relatif)
  const coverContainer = coverArt.closest('.cover-art') || coverArt.parentElement
  if (coverContainer) {
    coverContainer.style.position = 'relative'
    coverContainer.appendChild(heart)

    // Supprime après l'animation
    setTimeout(() => {
      heart.remove()
    }, 800)
  }
}

// Met à jour l'icône favori dans le player
function updatePlayerFavoriteIcon(trackPath, isFavorite) {
  // Trouve tous les boutons favoris visibles pour ce track
  const buttons = document.querySelectorAll(`.btn-favorite[data-track-path="${trackPath}"]`)
  buttons.forEach(btn => {
    btn.classList.toggle('active', isFavorite)
    const svg = btn.querySelector('svg')
    if (svg) {
      svg.setAttribute('fill', isFavorite ? 'currentColor' : 'none')
    }
  })
}

// Ferme tous les panneaux ouverts
function closeAllPanels() {
  // Ferme le détail d'album
  if (typeof closeAlbumDetail === 'function') {
    closeAlbumDetail()
  }

  // Ferme le context menu
  if (typeof hideContextMenu === 'function') {
    hideContextMenu()
  }

  // Ferme les menus de playlist
  document.querySelectorAll('.playlist-context-menu').forEach(m => m.remove())

  // Ferme le menu de sortie audio
  const audioOutputMenu = document.getElementById('audio-output-menu')
  if (audioOutputMenu && !audioOutputMenu.classList.contains('hidden')) {
    audioOutputMenu.classList.add('hidden')
    const audioOutputBtn = document.getElementById('audio-output-btn')
    if (audioOutputBtn) audioOutputBtn.classList.remove('active')
  }

  // Ferme le modal de playlist
  const playlistModal = document.getElementById('playlist-modal')
  if (playlistModal && !playlistModal.classList.contains('hidden')) {
    playlistModal.classList.add('hidden')
  }

  // Ferme les panneaux latéraux
  if (isQueuePanelOpen) toggleQueuePanel()
  if (isTrackInfoPanelOpen) closeTrackInfoPanel()
  if (isSettingsPanelOpen) closeSettings()
  if (getEqPanelOpen()) closeEqPanel()
}

// Seek relatif en secondes
function seekRelative(seconds) {
  // Utilise la position actuelle du slider de progression (plus fiable)
  const progressSlider = document.getElementById('progress')
  let currentPos = audioPositionFromRust

  // Si le slider existe, utilise sa valeur comme référence
  if (progressSlider && audioDurationFromRust > 0) {
    currentPos = (parseFloat(progressSlider.value) / 100) * audioDurationFromRust
  }

  const newPosition = Math.max(0, Math.min(audioDurationFromRust, currentPos + seconds))
  console.log('[SEEK] Seeking from', currentPos.toFixed(2), 'to', newPosition.toFixed(2), '(delta:', seconds, ')')

  invoke('audio_seek', { time: newPosition }).catch(err => {
    console.error('[SEEK] Error:', err)
  })
}

// Cycle repeat mode (off -> all -> one -> off)
function cycleRepeatMode() {
  const modes = ['off', 'all', 'one']
  const currentIndex = modes.indexOf(repeatMode)
  const nextIndex = (currentIndex + 1) % modes.length
  repeatMode = modes[nextIndex]

  // Met à jour l'UI
  if (repeatBtn) {
    updateRepeatButtonUI()
  }

  // Feedback
  const labels = { off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' }
  showToast(labels[repeatMode])
}

// Toggle shuffle mode (cycle: off -> album -> library -> off)
function toggleShuffleMode() {
  // Reset le shuffle history quand on change de mode
  shufflePlayedTracks.clear()

  // Cycle entre les modes
  if (shuffleMode === 'off') {
    shuffleMode = 'album'
    if (shuffleBtn) {
      shuffleBtn.classList.add('active')
      shuffleBtn.textContent = '⤮ᴬ'
      shuffleBtn.title = 'Shuffle (Album)'
    }
    showToast('Shuffle (Album)')
  } else if (shuffleMode === 'album') {
    shuffleMode = 'library'
    if (shuffleBtn) {
      shuffleBtn.textContent = '⤮∞'
      shuffleBtn.title = 'Shuffle (Library)'
    }
    showToast('Shuffle (Library)')
  } else {
    shuffleMode = 'off'
    if (shuffleBtn) {
      shuffleBtn.classList.remove('active')
      shuffleBtn.textContent = '⤮'
      shuffleBtn.title = 'Shuffle'
    }
    showToast('Shuffle disabled')
  }
}

// Initialise les raccourcis locaux
document.addEventListener('DOMContentLoaded', initLocalKeyboardShortcuts)

// === SIDEBAR RESIZE ===
function initSidebarResize() {
  const sidebar = document.querySelector('.sidebar')
  const resizeHandle = document.getElementById('sidebar-resize-handle')

  if (!sidebar || !resizeHandle) return

  let isResizing = false
  let startX = 0
  let startWidth = 0

  // Charge la largeur sauvegardée
  const savedWidth = localStorage.getItem('sidebarWidth')
  if (savedWidth) {
    const width = parseInt(savedWidth, 10)
    if (width >= 180 && width <= 400) {
      sidebar.style.width = `${width}px`
    }
  }

  resizeHandle.addEventListener('mousedown', (e) => {
    isResizing = true
    startX = e.clientX
    startWidth = sidebar.offsetWidth
    resizeHandle.classList.add('active')
    document.body.classList.add('sidebar-resizing')
    e.preventDefault()
  })

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return

    const delta = e.clientX - startX
    let newWidth = startWidth + delta

    // Limites min/max
    newWidth = Math.max(180, Math.min(400, newWidth))

    sidebar.style.width = `${newWidth}px`
  })

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false
      resizeHandle.classList.remove('active')
      document.body.classList.remove('sidebar-resizing')

      // Sauvegarde la largeur
      localStorage.setItem('sidebarWidth', sidebar.offsetWidth.toString())
    }
  })
}

document.addEventListener('DOMContentLoaded', initSidebarResize)

// === PANNEAU PARAMÈTRES (SETTINGS) ===
let isSettingsPanelOpen = false

function openSettings() {
  const panel = document.getElementById('settings-panel')
  if (!panel) return

  // Ferme les autres panels
  if (isQueuePanelOpen) toggleQueuePanel()
  if (isTrackInfoPanelOpen) closeTrackInfoPanel()
  if (getEqPanelOpen()) closeEqPanel()

  isSettingsPanelOpen = true
  panel.classList.add('open')

  // Peuple les données
  populateSettingsAudioDevices()
  populateSettingsLibraryPaths()
  populateSettingsValues()
  populateShortcutsList()
}

function closeSettings() {
  const panel = document.getElementById('settings-panel')
  if (!panel) return
  isSettingsPanelOpen = false
  panel.classList.remove('open')
}

function toggleSettings() {
  if (isSettingsPanelOpen) {
    closeSettings()
  } else {
    openSettings()
  }
}

// Peuple le select des périphériques audio dans les settings
async function populateSettingsAudioDevices() {
  const select = document.getElementById('settings-audio-device')
  if (!select) return

  try {
    const devices = await invoke('get_audio_devices')
    const currentDevice = await invoke('get_current_audio_device')
    const currentId = currentDevice?.id || null

    select.innerHTML = ''
    for (const device of devices) {
      const option = document.createElement('option')
      option.value = device.id
      option.textContent = device.name
      if (device.id === currentId) option.selected = true
      select.appendChild(option)
    }
  } catch (e) {
    console.error('[SETTINGS] Error loading audio devices:', e)
    select.innerHTML = '<option value="">Erreur de chargement</option>'
  }
}

// Peuple la liste des dossiers de bibliothèque
async function populateSettingsLibraryPaths() {
  const container = document.getElementById('settings-library-paths')
  if (!container) return

  try {
    const paths = await invoke('get_library_paths')
    container.innerHTML = ''

    if (paths.length === 0) {
      container.innerHTML = '<div style="font-size: 11px; color: #555; padding: 8px 0;">No folders configured</div>'
      return
    }

    for (const p of paths) {
      const item = document.createElement('div')
      item.className = 'settings-path-item'
      item.innerHTML = `
        <span class="settings-path-text" title="${p}">${p}</span>
        <button class="settings-path-remove" title="Retirer ce dossier" data-path="${p}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6L6 18"/><path d="M6 6l12 12"/>
          </svg>
        </button>
      `
      container.appendChild(item)
    }

    // Event listeners pour supprimer
    container.querySelectorAll('.settings-path-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        const pathToRemove = btn.dataset.path
        try {
          await invoke('remove_library_path', { path: pathToRemove })
          btn.closest('.settings-path-item').remove()
          showToast(`Folder removed: ${pathToRemove.split('/').pop()}`)
          // Recharger la bibliothèque pour refléter la suppression
          const [updatedTracks, stats] = await invoke('load_tracks_from_cache')
          tracks.length = 0
          for (const t of updatedTracks) tracks.push(t)
          filteredTracks = [...tracks]
          groupTracksIntoAlbumsAndArtists()
          buildTrackLookup()
          displayCurrentView()
          updateIndexationStats(stats)
        } catch (e) {
          console.error('[SETTINGS] Error removing library path:', e)
          showToast('Error removing folder')
        }
      })
    })
  } catch (e) {
    console.error('[SETTINGS] Error loading library paths:', e)
  }
}

// Peuple les valeurs actuelles des settings
// === SETTINGS : RACCOURCIS CLAVIER ===

let shortcutCaptureAction = null // action en cours de capture

function populateShortcutsList() {
  const container = document.getElementById('settings-shortcuts-list')
  if (!container) return

  container.innerHTML = ''
  for (const [action, binding] of Object.entries(activeShortcuts)) {
    const row = document.createElement('div')
    row.className = 'settings-shortcut-row'

    const label = document.createElement('span')
    label.className = 'settings-shortcut-label'
    label.textContent = binding.label

    const keyBtn = document.createElement('button')
    keyBtn.className = 'settings-shortcut-key'
    keyBtn.textContent = formatShortcutDisplay(binding)
    keyBtn.title = 'Cliquer pour modifier'
    keyBtn.dataset.action = action
    keyBtn.addEventListener('click', () => startShortcutCapture(action, keyBtn))

    row.appendChild(label)
    row.appendChild(keyBtn)
    container.appendChild(row)
  }
}

function startShortcutCapture(action, buttonEl) {
  // Annule une capture en cours
  if (shortcutCaptureAction) {
    const prevBtn = document.querySelector('.settings-shortcut-key.capturing')
    if (prevBtn) {
      prevBtn.classList.remove('capturing')
      prevBtn.textContent = formatShortcutDisplay(activeShortcuts[shortcutCaptureAction])
    }
  }

  shortcutCaptureAction = action
  buttonEl.classList.add('capturing')
  buttonEl.textContent = 'Appuyez...'

  // Capture le prochain keydown
  const captureHandler = (e) => {
    e.preventDefault()
    e.stopPropagation()

    // Ignore les modifier seuls
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return

    // Construit le nouveau binding
    const isLetter = e.key.length === 1 && /[a-z,]/i.test(e.key)
    const newBinding = {
      ...activeShortcuts[action],
      shift: e.shiftKey,
      meta: e.metaKey,
      ctrl: e.ctrlKey,
      alt: e.altKey,
    }
    if (isLetter) {
      newBinding.key = e.key.toLowerCase()
      delete newBinding.code
    } else {
      newBinding.code = e.code
      delete newBinding.key
    }

    // Applique
    activeShortcuts[action] = newBinding
    saveShortcuts()

    // Met à jour l'UI
    buttonEl.classList.remove('capturing')
    buttonEl.textContent = formatShortcutDisplay(newBinding)
    shortcutCaptureAction = null

    // Retire le handler
    document.removeEventListener('keydown', captureHandler, true)
  }

  document.addEventListener('keydown', captureHandler, true)
}

function resetShortcuts() {
  localStorage.removeItem('keyboard_shortcuts')
  loadShortcuts()
  populateShortcutsList()
  showToast('Shortcuts reset')
}

async function populateSettingsValues() {
  // Hog Mode
  const hogToggle = document.getElementById('settings-exclusive-mode')
  if (hogToggle) {
    try {
      const isExclusive = await invoke('is_exclusive_mode')
      hogToggle.checked = isExclusive
    } catch (e) {
      console.error('[SETTINGS] Error loading hog mode:', e)
    }
  }

  // Volume par défaut
  const volumeRange = document.getElementById('settings-default-volume')
  const volumeValue = document.getElementById('settings-volume-value')
  const savedVolume = localStorage.getItem('settings_default_volume')
  if (volumeRange) {
    volumeRange.value = savedVolume !== null ? savedVolume : 100
    if (volumeValue) volumeValue.textContent = `${volumeRange.value}%`
  }

  // Reprise auto
  const autoResume = document.getElementById('settings-auto-resume')
  if (autoResume) {
    autoResume.checked = localStorage.getItem('settings_auto_resume') === 'true'
  }
}

// Initialise les événements du panneau settings
function initSettingsPanel() {
  // Bouton ouverture
  const btnSettings = document.getElementById('btn-settings')
  if (btnSettings) {
    btnSettings.addEventListener('click', toggleSettings)
  }

  // Bouton fermeture
  const closeBtn = document.getElementById('close-settings')
  if (closeBtn) {
    closeBtn.addEventListener('click', closeSettings)
  }

  // Changement de périphérique audio
  const audioSelect = document.getElementById('settings-audio-device')
  if (audioSelect) {
    audioSelect.addEventListener('change', async () => {
      const deviceId = audioSelect.value
      if (!deviceId) return
      try {
        await invoke('set_audio_device', { deviceId })
        const selectedName = audioSelect.options[audioSelect.selectedIndex].text
        showToast(`Audio output: ${selectedName}`)
        // Met à jour aussi le menu player
        loadAudioDevices()
      } catch (e) {
        console.error('[SETTINGS] Error changing audio device:', e)
        showToast('Error changing audio output')
      }
    })
  }

  // Toggle Hog Mode (settings)
  const hogToggle = document.getElementById('settings-exclusive-mode')
  if (hogToggle) {
    hogToggle.addEventListener('change', async () => {
      const enabled = hogToggle.checked
      try {
        await invoke('set_exclusive_mode', { enabled })
        updateHogModeUI(enabled)
        showToast(enabled ? 'Exclusive mode enabled (bit-perfect)' : 'Exclusive mode disabled')

        // Relance la lecture si nécessaire
        if (enabled && audioIsPlaying && currentTrackIndex >= 0) {
          const currentTrack = tracks[currentTrackIndex]
          if (currentTrack) {
            await invoke('audio_play', { path: currentTrack.path })
          }
        }
      } catch (e) {
        console.error('[SETTINGS] Error toggling exclusive mode:', e)
        hogToggle.checked = !enabled
        showToast('Error changing mode')
      }
    })
  }

  // Volume par défaut
  const volumeRange = document.getElementById('settings-default-volume')
  const volumeValue = document.getElementById('settings-volume-value')
  if (volumeRange) {
    volumeRange.addEventListener('input', () => {
      const val = volumeRange.value
      if (volumeValue) volumeValue.textContent = `${val}%`
      localStorage.setItem('settings_default_volume', val)
    })
  }

  // Ajouter un dossier
  const addFolderBtn = document.getElementById('settings-add-folder')
  if (addFolderBtn) {
    addFolderBtn.addEventListener('click', async () => {
      try {
        const selected = await invoke('select_folder')
        if (selected) {
          await invoke('add_library_path', { path: selected })
          showToast(`Folder added: ${selected.split('/').pop()}`)
          populateSettingsLibraryPaths()
          // Déclenche un scan
          invoke('scan_folder_with_metadata', { path: selected })
        }
      } catch (e) {
        console.error('[SETTINGS] Error adding folder:', e)
      }
    })
  }

  // Reprise auto
  const autoResume = document.getElementById('settings-auto-resume')
  if (autoResume) {
    autoResume.addEventListener('change', () => {
      localStorage.setItem('settings_auto_resume', autoResume.checked)
      showToast(autoResume.checked ? 'Auto-resume enabled' : 'Auto-resume disabled')
    })
  }

  // Réinitialiser les raccourcis
  const resetShortcutsBtn = document.getElementById('settings-reset-shortcuts')
  if (resetShortcutsBtn) {
    resetShortcutsBtn.addEventListener('click', resetShortcuts)
  }

  // Gapless playback
  const gaplessToggle = document.getElementById('settings-gapless')
  if (gaplessToggle) {
    const gaplessSaved = localStorage.getItem('settings_gapless')
    gaplessToggle.checked = gaplessSaved !== 'false'
    gaplessToggle.addEventListener('change', () => {
      const enabled = gaplessToggle.checked
      localStorage.setItem('settings_gapless', enabled)
      invoke('set_gapless_enabled', { enabled }).catch(console.error)
      showToast(enabled ? 'Gapless playback enabled' : 'Gapless playback disabled')
    })
  }
}

// === AUTO-UPDATE → importé depuis auto-update.js ===

// Synchronise le Hog Mode entre player bar et settings panel
function updateHogModeUI(enabled) {
  // Met à jour le toggle du player bar
  const playerCheckbox = document.getElementById('exclusive-mode-checkbox')
  if (playerCheckbox) playerCheckbox.checked = enabled

  // Met à jour le toggle des settings
  const settingsCheckbox = document.getElementById('settings-exclusive-mode')
  if (settingsCheckbox) settingsCheckbox.checked = enabled

  // Met à jour le statut texte
  updateHogModeStatus(enabled)
}

// Applique le volume par défaut au démarrage
function applyDefaultVolume() {
  const savedVolume = localStorage.getItem('settings_default_volume')
  if (savedVolume !== null) {
    const vol = parseInt(savedVolume, 10)
    const volumeBarEl = document.getElementById('volume')
    if (volumeBarEl) {
      volumeBarEl.value = vol
      const normalizedVol = vol / 100
      currentVolume = normalizedVol
      updateVolumeIcon(normalizedVol)
      invoke('audio_set_volume', { volume: normalizedVol }).catch(console.error)
    }
  }
}

// Reprise auto au démarrage
async function handleAutoResume() {
  if (localStorage.getItem('settings_auto_resume') !== 'true') return

  try {
    const lastPlayed = await invoke('get_last_played')
    if (lastPlayed && lastPlayed.path) {
      // Trouve le track dans la bibliothèque
      const trackIndex = tracks.findIndex(t => t.path === lastPlayed.path)
      if (trackIndex >= 0) {
        currentTrackIndex = trackIndex
        // Affiche les infos sans lancer la lecture
        const track = tracks[trackIndex]
        const meta = track.metadata || {}
        document.getElementById('track-name').textContent = meta.title || track.name || 'Titre inconnu'
        document.getElementById('track-folder').textContent = meta.artist || 'Unknown Artist'
        // Affiche le player bar
        const player = document.getElementById('player')
        if (player) player.classList.remove('hidden')
      }
    }
  } catch (e) {
    console.error('[SETTINGS] Error auto-resume:', e)
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initSettingsPanel()
  applyDefaultVolume()
  initAutoUpdate()
  // Init EQ avec callbacks pour fermer les autres panels
  setEqPanelCallbacks({
    closeOtherPanels: () => {
      if (audioOutputMenu && !audioOutputMenu.classList.contains('hidden')) {
        audioOutputMenu.classList.add('hidden')
        audioOutputBtn.classList.remove('active')
      }
      if (isQueuePanelOpen) toggleQueuePanel()
      if (isTrackInfoPanelOpen) closeTrackInfoPanel()
      if (isSettingsPanelOpen) closeSettings()
    }
  })
  setTimeout(eqInit, 500)
  // Auto-resume après un délai pour laisser la bibliothèque se charger
  setTimeout(handleAutoResume, 3000)
})
