// renderer.js - Gère l'interface utilisateur et la lecture audio

// Import Tauri API
const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;

// === WINDOW DRAG (pour déplacer la fenêtre depuis le titlebar) ===
document.addEventListener('DOMContentLoaded', () => {
  const titlebar = document.querySelector('.titlebar')
  if (titlebar) {
    titlebar.addEventListener('mousedown', async (e) => {
      // Ne drag pas si on clique sur un bouton ou autre élément interactif
      if (e.target.closest('button, input, a, [data-no-drag]')) return
      // Démarre le drag de la fenêtre via Tauri
      await getCurrentWindow().startDragging()
    })
  }
})

// === AUDIO ENGINE STATE (Player Audiophile Rust) ===
// Le moteur audio tourne côté Rust, on ne fait que l'interface ici
let audioIsPlaying = false;
let audioDurationFromRust = 0;
let audioPositionFromRust = 0;
let useHtmlAudioFallback = false;  // True si on utilise le fallback HTML5 au lieu de Rust

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
  track: null,
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
    border: 1px solid #4a9;
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

        // Affiche le ghost
        const title = customDragState.track.metadata?.title || customDragState.track.name
        customDragState.ghostElement.textContent = '♪ ' + title
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
    if (wasDragging && customDragState.track) {
      const playlistItem = document.elementFromPoint(e.clientX, e.clientY)?.closest('.playlist-item')

      if (playlistItem) {
        const playlistId = playlistItem.dataset.playlistId
        if (playlistId) {
          await addTrackToPlaylist(playlistId, customDragState.track)
        }
      }
    }

    // Reset l'état
    customDragState.isPotentialDrag = false
    customDragState.isDragging = false
    customDragState.track = null
    customDragState.trackElement = null
    customDragState.currentHighlightedPlaylist = null
  })
}

// Prépare un drag custom pour une track (appelé sur mousedown)
function prepareCustomDrag(e, track, trackElement) {
  // Ignore si on clique sur un bouton
  if (e.target.closest('button')) return false

  customDragState.isPotentialDrag = true
  customDragState.isDragging = false
  customDragState.track = track
  customDragState.trackElement = trackElement
  customDragState.startX = e.clientX
  customDragState.startY = e.clientY

  return true // Indique qu'on a préparé le drag
}

// === ÉLÉMENTS DE LA PAGE ===
const selectFolderBtn = document.getElementById('select-folder')
const openFolderWelcomeBtn = document.getElementById('open-folder-welcome')
const welcomeDiv = document.getElementById('welcome')
const albumsViewDiv = document.getElementById('albums-view')
const albumsGridDiv = document.getElementById('albums-grid')
const playerDiv = document.getElementById('player')
const audioElement = document.getElementById('audio')
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
let currentPlayingAlbumKey = null  // Album en cours de lecture (pour skip séquentiel)
let lastVolume = 100       // Dernier volume avant mute

// === FILE D'ATTENTE (QUEUE) ===
let queue = []             // File d'attente des morceaux à jouer
let isQueuePanelOpen = false // État du panel queue

// === TRI DES COLONNES (vue Titres) ===
let sortColumn = 'title'   // Colonne de tri : 'title', 'artist', 'album', 'duration'
let sortDirection = 'asc'  // Direction : 'asc' ou 'desc'

// === TRI DES ALBUMS ===
let albumSortMode = 'artist-asc' // 'artist-asc', 'artist-desc', 'album-asc', 'album-desc'

// === CACHE POUR LES PERFORMANCES ===
const coverCache = new Map()  // Cache des pochettes { path: base64 }
let metadataLoaded = false    // Indique si les métadonnées ont été chargées
let trackAddedDates = {}      // Dates d'ajout des tracks { path: timestamp }

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
          if (cached && cached.startsWith('data:image')) {
            img.src = cached
            img.style.display = 'block'
            if (placeholder) placeholder.style.display = 'none'
          } else {
            // Charge de façon asynchrone
            loadCoverAsync(coverPath, img).then(() => {
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

// === GESTION DES TIMEOUTS (évite les fuites mémoire) ===
const activeTimeouts = new Map()  // { id: timeoutId }
let timeoutCounter = 0

function setManagedTimeout(callback, delay, groupId = null) {
  const id = groupId || `timeout_${++timeoutCounter}`
  // Annule l'ancien timeout du même groupe si existant
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

function clearManagedTimeout(id) {
  if (activeTimeouts.has(id)) {
    clearTimeout(activeTimeouts.get(id))
    activeTimeouts.delete(id)
  }
}

function clearAllManagedTimeouts(prefix = null) {
  for (const [id, timeoutId] of activeTimeouts.entries()) {
    if (!prefix || id.startsWith(prefix)) {
      clearTimeout(timeoutId)
      activeTimeouts.delete(id)
    }
  }
}

// === RESPONSIVE ITEM COUNT (pour Homepage) ===
function getResponsiveItemCount() {
  const mainContent = document.querySelector('.main-content')
  const width = mainContent ? mainContent.clientWidth : window.innerWidth - 280

  // Calcule le nombre d'items selon la largeur disponible
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

// Navigation menu
const navItems = document.querySelectorAll('.nav-item')

// === HELPER: Détecte le codec depuis l'extension du fichier ===
function getCodecFromPath(path) {
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

// === ANIMATION CSS SINUSOIDALE POUR "LECTURE EN COURS" ===
// Génère le HTML pour l'animation de 3 lignes sinusoïdales asynchrones
function getSineWaveAnimationHTML() {
  return `
    <svg class="sine-wave-animation" viewBox="0 0 500 100" preserveAspectRatio="none">
      <path class="sine-wave sine-wave-1" d="M0,50 Q62.5,25 125,50 T250,50 T375,50 T500,50" />
      <path class="sine-wave sine-wave-2" d="M0,50 Q62.5,30 125,50 T250,50 T375,50 T500,50" />
      <path class="sine-wave sine-wave-3" d="M0,50 Q62.5,35 125,50 T250,50 T375,50 T500,50" />
    </svg>
  `
}

// === INDICATEUR DE CHARGEMENT ===
function showLoading(message = 'Chargement...') {
  let loader = document.getElementById('loading-overlay')
  if (!loader) {
    loader = document.createElement('div')
    loader.id = 'loading-overlay'
    loader.innerHTML = `
      <div class="loading-content">
        <div class="loading-spinner"></div>
        <div class="loading-message">${message}</div>
        <div class="loading-progress"></div>
      </div>
    `
    document.body.appendChild(loader)
  } else {
    loader.querySelector('.loading-message').textContent = message
    loader.style.display = 'flex'
  }
}

function updateLoading(message, progress = null) {
  const loader = document.getElementById('loading-overlay')
  if (loader) {
    loader.querySelector('.loading-message').textContent = message
    if (progress !== null) {
      loader.querySelector('.loading-progress').textContent = progress
    }
  }
}

function hideLoading() {
  const loader = document.getElementById('loading-overlay')
  if (loader) {
    loader.style.display = 'none'
  }
}

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
    alert('Aucun fichier audio trouvé dans ce dossier.')
    return
  }

  updateLoading(`${tracksWithMetadata.length} fichiers chargés`)

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

  // Regroupe par album/artiste
  groupTracksIntoAlbumsAndArtists()

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
            artist: 'Artiste inconnu',
            album: 'Album inconnu',
            track: 0,
            duration: 0
          }
        }
      }
      loaded++
    }))

    // Met à jour le message de progression
    updateLoading(`Métadonnées: ${loaded}/${total}`, `${Math.round(loaded/total*100)}%`)
  }
}

// Groupe les tracks en albums et artistes (sans recharger les métadonnées)
function groupTracksIntoAlbumsAndArtists() {
  albums = {}
  artists = {}

  for (const track of tracks) {
    if (!track.metadata) continue

    // Groupe par nom d'album uniquement (pas par artiste-album)
    const albumKey = track.metadata.album || 'Album inconnu'
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
    albums[albumKey].tracks.sort((a, b) => (a.metadata.track || 0) - (b.metadata.track || 0))

    const artistsArray = Array.from(albums[albumKey].artistsSet)
    const totalTracks = albums[albumKey].tracks.length

    if (artistsArray.length > 1) {
      // Compte le nombre de tracks par artiste
      const artistCounts = {}
      for (const track of albums[albumKey].tracks) {
        const artist = track.metadata?.artist || 'Artiste inconnu'
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
        albums[albumKey].artist = 'Artistes Variés'
        albums[albumKey].isVariousArtists = true
      }
    } else {
      albums[albumKey].artist = artistsArray[0] || 'Artiste inconnu'
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

// Toast
const toast = document.getElementById('toast')

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

// Affiche un toast de notification
function showToast(message, duration = 3000) {
  if (!toast) return

  toast.textContent = message
  toast.classList.add('show')

  setTimeout(() => {
    toast.classList.remove('show')
  }, duration)
}

// Lance le scan en arrière-plan
async function startBackgroundScan() {
  console.log('Starting background scan...')
  isIndexing = true
  updateIndexationUI()
  await invoke('start_background_scan')
}

// Recharge la bibliothèque depuis le cache mis à jour
async function reloadLibraryFromCache() {
  console.log('Reloading library from updated cache...')

  const [cachedTracks, cachedStats] = await invoke('load_tracks_from_cache')

  if (cachedTracks) {
    // Reset et recharge
    tracks.length = 0
    for (const track of cachedTracks) {
      tracks.push(track)
    }

    // Recharge les dates d'ajout
    const addedDates = await invoke('get_added_dates')
    trackAddedDates = addedDates || {}

    // Regroupe et affiche
    groupTracksIntoAlbumsAndArtists()

    if (tracks.length > 0) {
      welcomeDiv.classList.add('hidden')
      displayCurrentView()
    }
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
    showToast(`Indexation terminée - ${stats.total_tracks} fichiers`)

    // Si des changements ont été détectés, recharge la bibliothèque
    if (new_tracks > 0 || removed_tracks > 0) {
      reloadLibraryFromCache()
    }
  })
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
  // Initialise le cache en mémoire côté Rust (une seule fois)
  await invoke('init_cache')

  // Charge les favoris au démarrage (crée la playlist si nécessaire)
  await loadFavorites()

  const savedPaths = await invoke('get_library_paths')

  if (savedPaths.length === 0) {
    // Pas de bibliothèque configurée - affiche les stats vides
    updateIndexationStats({ artists_count: 0, albums_count: 0, mp3_count: 0, flac_16bit_count: 0, flac_24bit_count: 0 })
    return
  }

  // === DÉMARRAGE INSTANTANÉ ===
  // 1. Charge depuis le cache (instantané)
  const [cachedTracks, cachedStats] = await invoke('load_tracks_from_cache')

  if (cachedTracks && cachedTracks.length > 0) {
    // Affiche immédiatement les tracks depuis le cache
    for (const track of cachedTracks) {
      tracks.push(track)
    }

    // Charge les dates d'ajout
    const addedDates = await invoke('get_added_dates')
    trackAddedDates = addedDates || {}

    // Affiche la bibliothèque
    groupTracksIntoAlbumsAndArtists()
    welcomeDiv.classList.add('hidden')
    displayCurrentView()

    // Affiche les stats du cache
    updateIndexationStats(cachedStats)

    console.log(`Instant startup: ${cachedTracks.length} tracks loaded from cache`)
  }

  // 2. Lance le scan en arrière-plan pour détecter les changements
  startBackgroundScan()
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

  // Vide le contenu immédiatement pour un feedback visuel instantané
  // Utilise textContent = '' qui est plus rapide que innerHTML = '' pour le cleanup
  albumsGridDiv.textContent = ''
  albumsViewDiv.classList.remove('hidden')

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
  }
}

// === HISTORIQUE DE NAVIGATION ===
let navigationHistory = []
let currentAlbumPageKey = null
let currentArtistPageKey = null

// Navigue vers la page dédiée d'un artiste
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

  // Sauvegarde la vue actuelle dans l'historique
  navigationHistory.push({
    view: currentView,
    filteredArtist: filteredArtist,
    scrollPosition: document.querySelector('.albums-view')?.scrollTop || 0
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
  currentAlbumPageKey = null
  currentArtistPageKey = null

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

  // Note: albumsGridDiv est déjà vidé par displayCurrentView() ou navigateToAlbumPage()

  // Récupère la pochette depuis le cache
  const cover = coverCache.get(album.coverPath)

  // Nombre de tracks et durée totale
  const totalDuration = album.tracks.reduce((acc, t) => acc + (t.metadata?.duration || 0), 0)

  // Qualité de l'album
  const firstTrack = album.tracks[0]
  const quality = formatQuality(firstTrack?.metadata)

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
        ${cover && cover.startsWith('data:image')
          ? `<img src="${cover}" alt="${album.album}">`
          : '<div class="album-cover-placeholder">♪</div>'
        }
      </div>
      <div class="album-page-info">
        <p class="album-page-artist">${album.artist}</p>
        <p class="album-page-meta">
          ${album.tracks.length} titres • ${formatTime(totalDuration)}
          ${qualityTag ? `<span class="album-page-tags">${qualityTag}</span>` : ''}
        </p>
        <div class="album-page-buttons">
          <button class="btn-primary-small play-album-btn">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
            Lecture
          </button>
          <button class="btn-add-queue-album add-album-queue-btn" title="Ajouter à la file d'attente">
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

  // Event listener pour lecture album
  pageContainer.querySelector('.play-album-btn').addEventListener('click', () => {
    playAlbum(albumKey)
  })

  // Event listener pour ajouter à la queue
  pageContainer.querySelector('.add-album-queue-btn').addEventListener('click', () => {
    addAlbumToQueue(albumKey)
    showQueueNotification(`Album "${album.album}" ajouté à la file d'attente`)
  })

  // Liste des tracks
  const tracksContainer = pageContainer.querySelector('.album-page-tracks')

  // Détecte si l'album est multi-artiste
  const uniqueArtists = new Set(album.tracks.map(t => t.metadata?.artist || album.artist))
  const isMultiArtist = uniqueArtists.size > 1

  album.tracks.forEach((track, idx) => {
    const trackItem = document.createElement('div')
    trackItem.className = 'album-track-item'
    trackItem.dataset.trackPath = track.path

    const duration = track.metadata?.duration ? formatTime(track.metadata.duration) : '-'
    const trackArtist = track.metadata?.artist || album.artist

    trackItem.innerHTML = `
      ${getFavoriteButtonHtml(track.path)}
      <span class="track-number">${idx + 1}</span>
      ${isMultiArtist
        ? `<div class="track-info">
            <span class="track-title">${track.metadata?.title || track.name}</span>
            <span class="track-artist">${trackArtist}</span>
          </div>`
        : `<span class="track-title">${track.metadata?.title || track.name}</span>`
      }
      <button class="track-add-queue${queue.some(q => q.path === track.path) ? ' in-queue' : ''}" title="Ajouter à la file d'attente">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M16 5H3"/><path d="M16 12H3"/><path d="M9 19H3"/><path d="m16 16-3 3 3 3"/><path d="M21 5v12a2 2 0 0 1-2 2h-6"/>
        </svg>
      </button>
      <button class="track-add-playlist" title="Ajouter à une playlist">
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
      showQueueNotification(`"${track.metadata?.title || track.name}" ajouté à la file d'attente`)
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

    tracksContainer.appendChild(trackItem)
  })

  albumsGridDiv.appendChild(pageContainer)

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

  // Debounce : attend 100ms après la dernière frappe
  clearTimeout(searchDebounceTimer)
  searchDebounceTimer = setTimeout(() => {
    updateSearchResultsPanel(query)
  }, 100)
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
    case ' ': // Espace : Play/Pause
      e.preventDefault()
      if (currentTrackIndex !== -1) {
        if (!audioIsPlaying) {
          if (useHtmlAudioFallback) {
            audioElement.play()
          } else {
            invoke('audio_resume').catch((e) => {
              console.error('audio_resume error:', e)
              // Ne bascule PAS vers HTML5 automatiquement pour éviter les flux parallèles
            })
          }
          audioIsPlaying = true
          playPauseBtn.textContent = '⏸'
        } else {
          if (useHtmlAudioFallback) {
            audioElement.pause()
          } else {
            invoke('audio_pause').catch((e) => {
              console.error('audio_pause error:', e)
            })
          }
          audioIsPlaying = false
          playPauseBtn.textContent = '▶'
        }
      }
      break

    case 'ArrowLeft': // Flèche gauche : Track précédente ou restart
      e.preventDefault()
      // Si > 3 secondes dans la chanson, restart. Sinon, track précédente
      const currentPosition = audioPositionFromRust > 0 ? audioPositionFromRust : 0
      if (currentPosition > 3) {
        if (useHtmlAudioFallback) {
          audioElement.currentTime = 0
        } else {
          invoke('audio_seek', { time: 0.0 }).catch((e) => {
            console.error('audio_seek error:', e)
          })
        }
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
  const maxResults = 5 // Max par catégorie

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

  // Recherche dans les tracks
  for (const track of tracks) {
    const title = (track.metadata?.title || track.name).toLowerCase()
    const artist = (track.metadata?.artist || '').toLowerCase()
    const albumName = (track.metadata?.album || '').toLowerCase()

    if (title.includes(q) || artist.includes(q) || albumName.includes(q)) {
      // Trouve l'album pour la pochette
      const trackArtist = track.metadata?.artist || 'Inconnu'
      const trackAlbum = track.metadata?.album || 'Inconnu'
      const albumKey = trackAlbum
      const album = albums[albumKey]

      results.tracks.push({
        path: track.path,
        title: track.metadata?.title || track.name,
        artist: trackArtist,
        album: trackAlbum,
        coverPath: album?.coverPath || null,
        index: tracks.indexOf(track)
      })
      if (results.tracks.length >= maxResults) break
    }
  }

  // Si aucun résultat
  if (results.artists.length === 0 && results.albums.length === 0 && results.tracks.length === 0) {
    content.innerHTML = `<div class="search-no-results">Aucun résultat pour "${escapeHtml(query)}"</div>`
    searchResultsPanel.classList.remove('hidden')
    return
  }

  // Construit le HTML
  let html = ''

  // Section Artistes
  if (results.artists.length > 0) {
    html += `<div class="search-section">
      <div class="search-section-title">Artistes</div>`
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
      <div class="search-section-title">Titres</div>`
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
    if (cached && cached.startsWith('data:image')) {
      coverDiv.innerHTML = `<img src="${cached}" alt="">`
      return
    }

    // Charge async
    invoke('get_cover', { path }).then(cover => {
      if (cover && cover.startsWith('data:image')) {
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
    // Navigue vers la vue albums filtrée par cet artiste
    filteredArtist = artistName
    navigateTo('albums')
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
    if (cover && cover.startsWith('data:image') && imgElement.isConnected) {
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
    if (cover && cover.startsWith('data:image') && imgElement.isConnected) {
      imgElement.src = cover
      imgElement.style.display = 'block'
    }
  } catch (e) {
    console.error('Erreur cover:', path, e)
    coverCache.set(path, null)
  }
}

// Cache séparé pour les images d'artistes
const artistImageCache = new Map()

// === CHARGEMENT ASYNCHRONE DES IMAGES D'ARTISTES ===
async function loadArtistImageAsync(artistName, imgElement, fallbackAlbum = null, fallbackCoverPath = null) {
  const cacheKey = `artist:${artistName}`

  // Vérifie le cache d'abord
  if (artistImageCache.has(cacheKey)) {
    const image = artistImageCache.get(cacheKey)
    if (image && image.startsWith('data:image')) {
      imgElement.src = image
      imgElement.style.display = 'block'
    }
    return
  }

  try {
    // Recherche une image d'artiste (photo Deezer/MusicBrainz ou fallback pochette)
    const image = await invoke('fetch_artist_image', {
      artist: artistName,
      fallbackAlbum: fallbackAlbum,
      fallbackCoverPath: fallbackCoverPath
    })

    artistImageCache.set(cacheKey, image) // Met en cache même si null

    if (image && image.startsWith('data:image')) {
      imgElement.src = image
      imgElement.style.display = 'block'
    }
  } catch (e) {
    console.error('Erreur artist image:', artistName, e)
    artistImageCache.set(cacheKey, null)
  }
}

// === AFFICHAGE DE LA PAGE HOME ===
// Fonction utilitaire pour échapper le HTML (évite XSS)
function escapeHtml(text) {
  if (!text) return ''
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

async function displayHomeView() {
  // Note: albumsGridDiv est déjà vidé par displayCurrentView()
  // albumsViewDiv.classList.remove('hidden') aussi

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
    const artist = currentTrack?.metadata?.artist || displayTrack.artist || 'Artiste inconnu'
    const album = currentTrack?.metadata?.album || displayTrack.album || ''
    const label = isCurrentlyPlaying ? 'Lecture en cours' : 'Reprendre la lecture'

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
      loadCoverAsync(coverPath, img, artist, album).then(() => {
        if (img.isConnected && img.style.display === 'block') {
          placeholder.style.display = 'none'
        }
      })
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
    recentHeader.textContent = 'Écouté récemment'
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
      const albumKey = entry.album || 'Album inconnu'
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
          <span class="recent-track-artist">${escapeHtml(entry.artist) || 'Artiste inconnu'}</span>
          <span class="recent-track-album">${escapeHtml(entry.album) || ''}</span>
        </div>
      `

      const img = item.querySelector('.recent-track-img')
      const placeholder = item.querySelector('.recent-track-placeholder')

      // Charge la pochette - vérifie le cache d'abord pour affichage instantané
      const coverPath = (album && album.coverPath) ? album.coverPath : entry.path
      if (img && placeholder) {
        const cachedCover = coverCache.get(coverPath)
        if (cachedCover && cachedCover.startsWith('data:image')) {
          img.src = cachedCover
          img.style.display = 'block'
          placeholder.style.display = 'none'
        } else {
          loadCoverAsync(coverPath, img, entry.artist, entry.album).then(() => {
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
      newHeader.textContent = 'nouveautés'
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
          if (cachedCover && cachedCover.startsWith('data:image')) {
            img.src = cachedCover
            img.style.display = 'block'
            placeholder.style.display = 'none'
          } else {
            loadCoverAsync(album.coverPath, img, album.artist, album.album).then(() => {
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
    discoverHeader.textContent = 'À découvrir'
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
        // Si déjà en cache, affiche immédiatement (pas de flash)
        const cachedCover = coverCache.get(album.coverPath)
        if (cachedCover && cachedCover.startsWith('data:image')) {
          img.src = cachedCover
          img.style.display = 'block'
          placeholder.style.display = 'none'
        } else {
          // Sinon charge de manière asynchrone
          loadCoverAsync(album.coverPath, img, album.artist, album.album).then(() => {
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
    artistsHeader.textContent = 'Tes artistes préférés'
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
        <div class="carousel-artist">${artist.play_count} écoutes</div>
      `

      const img = item.querySelector('.carousel-cover-img')
      const placeholder = item.querySelector('.carousel-cover-placeholder')

      // Charge l'image de l'artiste (depuis le cache ou via l'API)
      if (img && placeholder) {
        // Essaie d'abord le cache de l'album sample
        const cachedCover = artist.sample_path ? coverCache.get(artist.sample_path) : null
        if (cachedCover && cachedCover.startsWith('data:image')) {
          img.src = cachedCover
          img.style.display = 'block'
          placeholder.style.display = 'none'
        } else if (artist.sample_path) {
          // Sinon charge la pochette de l'album sample
          loadCoverAsync(artist.sample_path, img, artist.name, artist.sample_album).then(() => {
            if (img.isConnected && img.style.display === 'block') {
              placeholder.style.display = 'none'
            }
          })
        }
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
    hiResHeader.textContent = 'Qualité Audiophile'
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
      const quality = formatQuality(hiResTrack?.metadata)

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
        if (cachedCover && cachedCover.startsWith('data:image')) {
          img.src = cachedCover
          img.style.display = 'block'
          placeholder.style.display = 'none'
        } else {
          loadCoverAsync(album.coverPath, img, album.artist, album.album).then(() => {
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

  // Message si rien à afficher
  if (!lastPlayed && recentTracks.length === 0 && unplayedAlbums.length === 0) {
    const emptyMessage = document.createElement('div')
    emptyMessage.className = 'home-empty'
    emptyMessage.innerHTML = `
      <h2>Bienvenue sur Noir</h2>
      <p>Commencez à écouter de la musique pour remplir cette page.</p>
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
        if (useHtmlAudioFallback) {
          audioElement.pause()
        } else {
          try {
            await invoke('audio_pause')
          } catch (err) {
            console.error('audio_pause error:', err)
          }
        }
        audioIsPlaying = false
        playPauseBtn.textContent = '▶'
        playBtn.textContent = '▶'
      } else if (currentTrackIndex >= 0) {
        if (useHtmlAudioFallback) {
          // Mode fallback HTML5 : joue directement
          audioElement.play()
          audioIsPlaying = true
          playPauseBtn.textContent = '⏸'
          playBtn.textContent = '⏸'
        } else {
          // Mode Rust : essaie de reprendre
          try {
            await invoke('audio_resume')
            audioIsPlaying = true
            playPauseBtn.textContent = '⏸'
            playBtn.textContent = '⏸'
          } catch (err) {
            console.error('audio_resume error:', err)
            // Ne bascule PAS automatiquement vers HTML5 pour éviter les flux parallèles
          }
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
  const artist = currentTrack.metadata?.artist || 'Artiste inconnu'
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
      <span class="resume-label resume-label-active">Lecture en cours</span>
      <span class="resume-title">${escapeHtml(title)}</span>
      <span class="resume-artist">${escapeHtml(artist)}</span>
      ${album ? `<span class="resume-album">${escapeHtml(album)}</span>` : ''}
      ${specsTagsHtml}
    </div>
    <button class="resume-play-btn">${audioIsPlaying ? '⏸' : '▶'}</button>
  `

  // Charge la pochette
  const img = resumeTile.querySelector('.resume-cover-img')
  const placeholder = resumeTile.querySelector('.resume-cover-placeholder')
  if (img && placeholder) {
    loadCoverAsync(currentTrack.path, img, artist, album).then(() => {
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
  // Note: albumsGridDiv est déjà vidé par displayCurrentView()

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
    const hasCachedCover = cachedCover && cachedCover.startsWith('data:image')

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
      const cover = coverCache.get(album.coverPath)
      showAlbumDetail(albumKey, cover, card)
    })

    gridContainer.appendChild(card)
  }

  albumsGridDiv.appendChild(gridContainer)
}

// === AFFICHAGE DE LA GRILLE D'ARTISTES ===
// Mode de tri pour les artistes (même pattern que les albums)
let artistSortMode = 'name-asc'

function displayArtistsGrid() {
  // Note: albumsGridDiv est déjà vidé par displayCurrentView()

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
  }

  albumsGridDiv.appendChild(gridContainer)
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
          <button class="btn-add-queue-album add-artist-queue-btn" title="Ajouter à la file d'attente">
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
    showQueueNotification(`${artist.tracks.length} titres ajoutés à la file d'attente`)
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

  // Grille des albums de l'artiste
  const albumsGrid = pageContainer.querySelector('.artist-albums-grid')

  for (const albumData of artistAlbums) {
    const card = document.createElement('div')
    card.className = 'album-card'
    card.dataset.albumKey = albumData.key

    // Vérifie si la pochette est en cache
    const cachedCover = coverCache.get(albumData.coverPath)
    const hasCachedCover = cachedCover && cachedCover.startsWith('data:image')

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

    // Si pas en cache, charge la pochette
    if (!hasCachedCover && albumData.coverPath) {
      const cardImg = card.querySelector('.album-cover-img')
      const cardPlaceholder = card.querySelector('.album-cover-placeholder')
      loadCoverAsync(albumData.coverPath, cardImg, artist.name, albumData.album).then(() => {
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

// État du virtual scroll
let virtualScrollState = {
  filteredTracks: [],        // Tracks triées et filtrées
  visibleStartIndex: 0,      // Premier index visible
  visibleEndIndex: 0,        // Dernier index visible
  scrollContainer: null,     // Référence au conteneur de scroll
  contentContainer: null,    // Référence au conteneur des items
  selectedTrackPaths: new Set(),  // Tracks sélectionnées (multi-sélection)
  lastSelectedPath: null     // Dernière track sélectionnée (pour Shift+Clic)
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
        valueA = a.metadata?.artist || 'Artiste inconnu'
        valueB = b.metadata?.artist || 'Artiste inconnu'
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
    sortedTracks = sortedTracks.filter(track => {
      const title = (track.metadata?.title || track.name).toLowerCase()
      const artist = (track.metadata?.artist || '').toLowerCase()
      const album = (track.metadata?.album || '').toLowerCase()
      return title.includes(searchQuery) || artist.includes(searchQuery) || album.includes(searchQuery)
    })
  }

  return sortedTracks
}

// Crée le HTML d'un item de track
function createTrackItemHTML(track, index) {
  const title = track.metadata?.title || track.name
  const artist = track.metadata?.artist || 'Artiste inconnu'
  const album = track.metadata?.album || ''
  const duration = track.metadata?.duration ? formatTime(track.metadata.duration) : '-:--'
  const quality = formatQuality(track.metadata)
  const isInQueue = queue.some(q => q.path === track.path)
  const inQueueClass = isInQueue ? 'in-queue' : ''
  const selectedClass = virtualScrollState.selectedTrackPaths.has(track.path) ? 'selected' : ''

  return `
    <div class="tracks-list-item ${selectedClass}" data-track-path="${track.path}" data-virtual-index="${index}" style="position: absolute; top: ${index * TRACK_ITEM_HEIGHT}px; left: 0; right: 0; height: ${TRACK_ITEM_HEIGHT}px;">
      <span class="track-drag-handle" title="Glisser vers une playlist">⠿</span>
      <span class="tracks-list-title">${title}</span>
      <span class="tracks-list-artist">${artist}</span>
      <span class="tracks-list-album">${album}</span>
      <span class="tracks-list-quality"><span class="quality-tag ${quality.class}">${quality.label}</span></span>
      <span class="tracks-list-duration">${duration}</span>
      <button class="tracks-list-add-playlist" title="Ajouter à une playlist">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>
        </svg>
      </button>
      <button class="tracks-list-add-queue ${inQueueClass}" title="${isInQueue ? 'Déjà dans la file' : 'Ajouter à la file'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M16 5H3"/><path d="M16 12H3"/><path d="M9 19H3"/><path d="m16 16-3 3 3 3"/><path d="M21 5v12a2 2 0 0 1-2 2h-6"/>
        </svg>
      </button>
    </div>
  `
}

// Met à jour les éléments visibles dans le virtual scroll
function updateVirtualScrollItems() {
  const { filteredTracks, contentContainer, scrollContainer } = virtualScrollState

  // Vérifications de sécurité
  if (!contentContainer || !scrollContainer || !scrollContainer.isConnected) return
  if (!filteredTracks || filteredTracks.length === 0) return

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

  // Ne re-render que si les indices ont changé significativement
  if (startIndex === virtualScrollState.visibleStartIndex && endIndex === virtualScrollState.visibleEndIndex) {
    return
  }

  virtualScrollState.visibleStartIndex = startIndex
  virtualScrollState.visibleEndIndex = endIndex

  // Génère le HTML pour les items visibles
  let html = ''
  for (let i = startIndex; i <= endIndex; i++) {
    html += createTrackItemHTML(filteredTracks[i], i)
  }

  contentContainer.innerHTML = html
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
  // Note: albumsGridDiv est déjà vidé par displayCurrentView()

  // Header avec titre
  const headerDiv = document.createElement('div')
  headerDiv.className = 'view-header-simple'
  headerDiv.innerHTML = `<h1 class="view-title">Titres</h1>`
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
    <span class="sortable" data-sort="duration">Durée ${getSortIndicator('duration')}</span>
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

  // Affiche le nombre de résultats si recherche
  if (searchQuery && totalTracks < tracks.length) {
    const countDiv = document.createElement('div')
    countDiv.className = 'search-results-count'
    countDiv.style.cssText = 'padding: 8px 16px; color: #666; font-size: 13px;'
    countDiv.textContent = `${totalTracks} résultat${totalTracks > 1 ? 's' : ''}`
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

  // Clic (avec support multi-sélection Cmd/Shift)
  contentContainer.addEventListener('click', (e) => {
    const trackItem = e.target.closest('.tracks-list-item')
    if (!trackItem) return

    const trackPath = trackItem.dataset.trackPath
    const track = tracks.find(t => t.path === trackPath)
    if (!track) return

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
        addQueueBtn.title = 'Ajouter à la file'
      } else {
        // Ajoute à la queue
        addToQueue(track)
        addQueueBtn.classList.add('in-queue')
        addQueueBtn.title = 'Retirer de la file'
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
    const originalIndex = tracks.findIndex(t => t.path === trackPath)
    if (originalIndex !== -1) {
      playTrack(originalIndex)
    }
  })

  // Clic droit
  contentContainer.addEventListener('contextmenu', (e) => {
    const trackItem = e.target.closest('.tracks-list-item')
    if (!trackItem) return

    const trackPath = trackItem.dataset.trackPath
    const track = tracks.find(t => t.path === trackPath)
    if (!track) return

    const originalIndex = tracks.findIndex(t => t.path === trackPath)
    showContextMenu(e, track, originalIndex)
  })

  // Drag custom avec mousedown
  contentContainer.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return

    const trackItem = e.target.closest('.tracks-list-item')
    if (!trackItem) return

    const trackPath = trackItem.dataset.trackPath
    const track = tracks.find(t => t.path === trackPath)
    if (!track) return

    prepareCustomDrag(e, track, trackItem)
  })

  albumsGridDiv.appendChild(tracksContainer)

  // Render initial APRÈS montage dans le DOM (sinon clientHeight = 0)
  requestAnimationFrame(() => {
    updateVirtualScrollItems()
  })
}

// Formate la qualité audio
function formatQuality(metadata) {
  if (!metadata) return { label: '-', class: '' }

  const bitDepth = metadata.bitDepth
  const sampleRate = metadata.sampleRate

  if (!bitDepth && !sampleRate) return { label: '-', class: '' }

  // Détermine la classe de qualité
  let qualityClass = 'quality-standard'
  if (sampleRate >= 96000 || bitDepth >= 24) {
    qualityClass = 'quality-hires'
  } else if (sampleRate >= 44100 && bitDepth >= 16) {
    qualityClass = 'quality-lossless'
  }

  // Format: "24bit/96kHz" ou "16bit/44.1kHz"
  const bits = bitDepth ? `${bitDepth}bit` : ''
  const rate = sampleRate ? `${sampleRate >= 1000 ? (sampleRate / 1000).toFixed(1).replace('.0', '') : sampleRate}kHz` : ''
  const label = [bits, rate].filter(Boolean).join('/')

  return { label: label || '-', class: qualityClass }
}

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
  const albumQuality = formatQuality(firstTrack?.metadata)
  const qualityTag = albumQuality.label !== '-'
    ? `<span class="quality-tag ${albumQuality.class}">${albumQuality.label}</span>`
    : ''

  // Bitrate de l'album
  const bitrate = firstTrack?.metadata?.bitrate
  const bitrateTag = bitrate
    ? `<span class="quality-tag quality-bitrate">${Math.round(bitrate / 1000)} kbps</span>`
    : ''

  // Contenu du panel
  albumDetailDiv.innerHTML = `
    <div class="album-detail-header">
      <div class="album-detail-cover">
        ${cover && cover.startsWith('data:image')
          ? `<img src="${cover}" alt="${album.album}">`
          : '<div class="album-cover-placeholder">♪</div>'
        }
      </div>
      <div class="album-detail-info">
        <h2 class="album-detail-title">${album.album}</h2>
        <p class="album-detail-artist">${album.artist}</p>
        <p class="album-detail-meta">
          ${album.tracks.length} titres • ${formatTime(totalDuration)}
          ${qualityTag ? `<span class="album-detail-tags">${qualityTag}${bitrateTag}</span>` : ''}
        </p>
        <div class="album-detail-buttons">
          <button class="btn-primary-small play-album-btn">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
            Lecture
          </button>
          <button class="btn-add-queue-album add-album-queue-btn" title="Ajouter tout à la file">
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

  // Liste des tracks
  const albumTracksDiv = albumDetailDiv.querySelector('.album-tracks')
  album.tracks.forEach((track, index) => {
    const trackItem = document.createElement('div')
    trackItem.className = 'album-track-item'
    trackItem.dataset.trackPath = track.path

    const duration = track.metadata?.duration ? formatTime(track.metadata.duration) : '-:--'
    const trackArtist = track.metadata?.artist || 'Artiste inconnu'

    // Vérifie si le track est déjà dans la queue
    const isInQueue = queue.some(q => q.path === track.path)
    const inQueueClass = isInQueue ? 'in-queue' : ''
    const buttonsHtml = `
      <button class="track-add-playlist" title="Ajouter à une playlist">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>
        </svg>
      </button>
      <button class="track-add-queue ${inQueueClass}" title="${isInQueue ? 'Déjà dans la file' : 'Ajouter à la file'}">
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
        addQueueBtn.title = 'Ajouter à la file'
      } else {
        // Ajoute à la queue
        addToQueue(track)
        addQueueBtn.classList.add('in-queue')
        addQueueBtn.title = 'Retirer de la file'
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

  // Event listeners pour le panel
  albumDetailDiv.querySelector('.close-album-detail').addEventListener('click', closeAlbumDetail)
  albumDetailDiv.querySelector('.play-album-btn').addEventListener('click', () => {
    if (selectedAlbumKey) playAlbum(selectedAlbumKey)
  })
  albumDetailDiv.querySelector('.add-album-queue-btn').addEventListener('click', () => {
    if (selectedAlbumKey) {
      const album = albums[selectedAlbumKey]
      album.tracks.forEach(track => addToQueue(track))
      showQueueNotification(`${album.tracks.length} titres ajoutés à la file`)
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

  currentTrackIndex = index
  const track = tracks[index]

  if (!track || !track.path) {
    console.error('playTrack: track invalide', track)
    return
  }

  // Met à jour l'affichage avec les métadonnées
  const title = track.metadata?.title || track.name || 'Titre inconnu'
  const artist = track.metadata?.artist || track.folder || 'Artiste inconnu'
  trackNameEl.textContent = title
  trackFolderEl.textContent = artist

  // Affiche les specs techniques (bitrate/sample rate)
  const trackQualityEl = document.getElementById('track-quality')
  if (trackQualityEl) {
    const quality = formatQuality(track.metadata)
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
        artist: track.metadata.artist || 'Artiste inconnu',
        album: track.metadata.album || 'Album inconnu'
      })
    }

    coverCache.set(track.path, cover)
  }

  if (cover && cover.startsWith('data:image')) {
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
    useHtmlAudioFallback = false
    // La durée sera mise à jour via l'événement playback_progress
    // Utilise la durée des métadonnées comme estimation initiale
    const estimatedDuration = track.metadata?.duration || 0
    audioDurationFromRust = estimatedDuration
    durationEl.textContent = estimatedDuration > 0 ? formatTime(estimatedDuration) : '--:--'
    console.log('Streaming started (Rust):', track.path)
  } catch (e) {
    console.error('Rust audio_play error:', e)
    // Fallback sur audioElement si le moteur Rust échoue
    useHtmlAudioFallback = true
    audioElement.src = convertFileSrc(track.path)
    audioElement.play()
    audioIsPlaying = true
    console.log('Streaming started (HTML5 fallback):', track.path)
  }
  playPauseBtn.textContent = '⏸'

  // Note: resetPlayerUI() est appelé en début de fonction

  // Précharge le prochain track pour gapless (si disponible)
  const nextTrackIndex = currentTrackIndex + 1
  if (nextTrackIndex < tracks.length) {
    const nextTrack = tracks[nextTrackIndex]
    invoke('audio_preload_next', { path: nextTrack.path }).catch(e => {
      console.log('Preload next track failed (non-critical):', e)
    })
  }

  // Track l'album en cours de lecture (utilise le nom d'album seul comme clé, cohérent avec groupTracksIntoAlbumsAndArtists)
  currentPlayingAlbumKey = track.metadata?.album || 'Album inconnu'

  // Affiche le lecteur
  playerDiv.classList.remove('hidden')
  document.body.classList.add('player-visible')

  // Met à jour le highlight dans le panel album si ouvert
  updateAlbumTracksHighlight()

  // Met à jour la section "Lecture en cours" de la Home si visible
  updateHomeNowPlayingSection()

  // Enregistre la lecture dans l'historique et invalide le cache Home
  invoke('record_play', {
    path: track.path,
    artist: track.metadata?.artist || 'Artiste inconnu',
    album: track.metadata?.album || '',
    title: track.metadata?.title || track.name
  }).then(() => {
    invalidateHomeCache()  // Les stats ont changé, invalide le cache
  }).catch(err => console.error('Erreur enregistrement historique:', err))
}

// === CONTRÔLES DU LECTEUR ===
playPauseBtn.addEventListener('click', async () => {
  // Si pas de track sélectionnée, ne fait rien
  if (currentTrackIndex < 0 || !tracks[currentTrackIndex]) return

  const currentTrack = tracks[currentTrackIndex]

  if (!audioIsPlaying) {
    // PLAY / RESUME
    if (useHtmlAudioFallback) {
      // Utilise HTML5 audio
      audioElement.play()
      audioIsPlaying = true
      playPauseBtn.textContent = '⏸'
    } else {
      // Utilise Rust
      try {
        await invoke('audio_resume')
        audioIsPlaying = true
        playPauseBtn.textContent = '⏸'
      } catch (e) {
        console.error('audio_resume error:', e)
        // Ne bascule PAS automatiquement vers HTML5 pour éviter les flux parallèles
        // L'utilisateur doit relancer la piste si Rust a vraiment planté
      }
    }
    // Met à jour le composant Home si visible
    updateHomeNowPlayingSection()
  } else {
    // PAUSE
    if (useHtmlAudioFallback) {
      // Utilise HTML5 audio
      audioElement.pause()
      audioIsPlaying = false
      playPauseBtn.textContent = '▶'
    } else {
      // Utilise Rust
      try {
        await invoke('audio_pause')
        audioIsPlaying = false
        playPauseBtn.textContent = '▶'
      } catch (e) {
        console.error('audio_pause error:', e)
        // Ne pas appeler audioElement.pause() si on n'est pas en mode fallback
        // pour éviter les états incohérents
        audioIsPlaying = false
        playPauseBtn.textContent = '▶'
      }
    }
    // Met à jour le composant Home si visible
    updateHomeNowPlayingSection()
  }
})

// Morceau précédent
prevBtn.addEventListener('click', () => {
  if (currentTrackIndex > 0) {
    playTrack(currentTrackIndex - 1)
  }
})

// Morceau suivant
nextBtn.addEventListener('click', () => {
  playNextTrack()
})

// === CLICK SUR COVER ART = Navigation vers l'album ===
coverArtEl.addEventListener('click', () => {
  if (!currentPlayingAlbumKey || currentTrackIndex < 0) return

  const album = albums[currentPlayingAlbumKey]
  if (!album) {
    console.log('Album not found for key:', currentPlayingAlbumKey)
    return
  }

  // Navigue vers la page album dédiée
  navigateToAlbumPage(currentPlayingAlbumKey)
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

  // 2. Récupère les tracks de l'album en cours (si on joue un album)
  const currentAlbum = currentPlayingAlbumKey ? albums[currentPlayingAlbumKey] : null
  const albumTracks = currentAlbum?.tracks || []

  // Trouve l'index du track actuel dans l'album
  const currentTrack = tracks[currentTrackIndex]
  const currentAlbumTrackIndex = albumTracks.findIndex(t => t.path === currentTrack?.path)

  // DEBUG
  console.log('playNextTrack DEBUG:', {
    currentPlayingAlbumKey,
    albumExists: !!currentAlbum,
    albumTracksCount: albumTracks.length,
    currentTrackPath: currentTrack?.path,
    currentAlbumTrackIndex,
    shuffleMode,
    repeatMode
  })

  // 3. Gestion des modes shuffle (seulement si le track actuel est bien dans l'album)
  if (shuffleMode === 'album' && albumTracks.length > 1 && currentAlbumTrackIndex !== -1) {
    // Shuffle dans l'album uniquement
    let randomAlbumIndex
    do {
      randomAlbumIndex = Math.floor(Math.random() * albumTracks.length)
    } while (randomAlbumIndex === currentAlbumTrackIndex && albumTracks.length > 1)

    const randomTrack = albumTracks[randomAlbumIndex]
    const globalIndex = tracks.findIndex(t => t.path === randomTrack.path)
    if (globalIndex !== -1) {
      playTrack(globalIndex)
      return
    }
  } else if (shuffleMode === 'library') {
    // Shuffle sur toute la bibliothèque
    let randomIndex
    do {
      randomIndex = Math.floor(Math.random() * tracks.length)
    } while (randomIndex === currentTrackIndex && tracks.length > 1)
    playTrack(randomIndex)
    return
  }

  // 4. Mode séquentiel : track suivante dans l'album
  if (currentAlbum && currentAlbumTrackIndex !== -1) {
    // On est dans un album, on joue le track suivant de l'album
    if (currentAlbumTrackIndex < albumTracks.length - 1) {
      // Track suivante dans l'album
      const nextAlbumTrack = albumTracks[currentAlbumTrackIndex + 1]
      const globalIndex = tracks.findIndex(t => t.path === nextAlbumTrack.path)
      if (globalIndex !== -1) {
        playTrack(globalIndex)
        return
      }
    } else if (repeatMode === 'all') {
      // Fin de l'album + repeat all = retour au début de l'album
      const firstTrack = albumTracks[0]
      const globalIndex = tracks.findIndex(t => t.path === firstTrack.path)
      if (globalIndex !== -1) {
        playTrack(globalIndex)
        return
      }
    }
  } else {
    // Pas d'album, comportement séquentiel global
    if (currentTrackIndex < tracks.length - 1) {
      playTrack(currentTrackIndex + 1)
      return
    } else if (repeatMode === 'all') {
      playTrack(0)
      return
    }
  }

  // Fin de lecture
  playPauseBtn.textContent = '▶'
}

// Obtient la durée correcte du track (Rust prioritaire, sinon audio element)
function getCurrentTrackDuration() {
  // Priorité : durée du moteur Rust
  if (audioDurationFromRust > 0) {
    return audioDurationFromRust
  }

  // Fallback : audio element
  const audioDuration = audioElement.duration
  if (audioDuration && isFinite(audioDuration) && audioDuration > 0) {
    return audioDuration
  }

  // Dernier recours : métadonnées
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
  // Si on est en seek, ignore les positions venant de Rust
  // car elles peuvent être "en retard" par rapport à la position demandée
  if (isSeekingUI) {
    // Vérifie si la position Rust est proche de notre position de seek
    // (tolérance de 0.5 seconde = le seek a abouti)
    const seekDelta = Math.abs(position - lastRustPosition)
    if (seekDelta < 0.5) {
      // La position Rust correspond à notre seek → le seek a abouti !
      console.log(`[Sync] Seek confirmed: Rust at ${position.toFixed(2)}s (delta: ${seekDelta.toFixed(3)}s)`)

      // Réactive l'interpolation immédiatement maintenant que le seek est confirmé
      isSeekingUI = false
      seekPending = false

      // Annule le timeout de sécurité
      if (seekTimeoutId) {
        clearTimeout(seekTimeoutId)
        seekTimeoutId = null
      }
    } else {
      // La position Rust est loin de notre seek → ignorer (ancienne position)
      console.log(`[Sync] Ignoring stale position: ${position.toFixed(2)}s (expected ~${lastRustPosition.toFixed(2)}s)`)
      return
    }
  }

  lastRustPosition = position
  lastRustTimestamp = performance.now()
  lastDisplayedPosition = position
}

// === RESET UI COMPLET (appelé à chaque changement de piste) ===
// Remet tous les compteurs et l'affichage à zéro
function resetPlayerUI() {
  // CRITIQUE: Stoppe TOUJOURS l'élément HTML5 audio pour éviter deux flux audio en parallèle
  // Même si useHtmlAudioFallback est false, l'audioElement pourrait encore jouer d'un état précédent
  try {
    audioElement.pause()
    audioElement.currentTime = 0
    audioElement.src = ''  // Libère complètement la ressource
  } catch (e) {
    // Ignore les erreurs (élément peut ne pas exister ou être dans un état invalide)
  }

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

  console.log('Player UI reset complete (HTML5 audio stopped)')
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
    const { position, duration } = event.payload

    // Met à jour les variables globales
    audioPositionFromRust = position
    audioDurationFromRust = duration

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
  })

  // Seeking en cours (émis par Rust quand un seek démarre)
  await listen('playback_seeking', (event) => {
    const targetPosition = event.payload
    isSeekingUI = true

    // Synchronise immédiatement à la position cible
    syncToRustPosition(targetPosition)

    if (audioDurationFromRust > 0) {
      const percent = (targetPosition / audioDurationFromRust) * 100
      progressBar.value = Math.min(percent, 100)
      currentTimeEl.textContent = formatTime(targetPosition)
      updateProgressBarStyle(percent)
    }
  })

  // Pause/Resume depuis Rust
  await listen('playback_paused', () => {
    isPausedFromRust = true
  })

  await listen('playback_resumed', () => {
    isPausedFromRust = false
    // Re-synchronise le timestamp pour éviter un saut
    lastRustTimestamp = performance.now()
  })

  // Fin de lecture (émis par Rust quand le track est terminé)
  await listen('playback_ended', () => {
    console.log('Rust: playback_ended - transitioning to next track')

    // Marque la fin de lecture AVANT la transition
    audioIsPlaying = false
    isPausedFromRust = false

    // Reset immédiat de l'UI pour la transition
    resetPlayerUI()

    // Petit délai pour laisser Rust nettoyer son état avant de lancer la suite
    setTimeout(() => {
      // Gère repeat et next track
      if (repeatMode === 'one') {
        // Répète le même morceau
        playTrack(currentTrackIndex)
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

  // Démarre l'interpolation au chargement
  startPositionInterpolation()

  console.log('Rust audio listeners initialized (with smooth 60fps interpolation)')
}

// Initialise au chargement
document.addEventListener('DOMContentLoaded', initRustAudioListeners)

// Fallback: Mise à jour via audioElement (si Rust échoue)
audioElement.addEventListener('timeupdate', () => {
  // Ne fait rien si Rust gère l'audio
  if (audioDurationFromRust > 0) return

  const duration = getCurrentTrackDuration()
  if (duration > 0) {
    const percent = (audioElement.currentTime / duration) * 100
    progressBar.value = Math.min(percent, 100)
    currentTimeEl.textContent = formatTime(audioElement.currentTime)
    updateProgressBarStyle(percent)
  }
})

// Met à jour visuellement la barre de progression (couleur de remplissage)
function updateProgressBarStyle(percent) {
  const clampedPercent = Math.min(Math.max(percent, 0), 100)
  progressBar.style.background = `linear-gradient(to right, #1db954 0%, #1db954 ${clampedPercent}%, #333 ${clampedPercent}%, #333 100%)`
}

// Fallback: Quand les métadonnées sont chargées (audio element)
audioElement.addEventListener('loadedmetadata', () => {
  // Ne fait rien si Rust gère l'audio
  if (audioDurationFromRust > 0) return

  const duration = getCurrentTrackDuration()
  durationEl.textContent = formatTime(duration)
})

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

// Fallback: Quand un morceau se termine (audio element - utilisé si Rust échoue)
audioElement.addEventListener('ended', () => {
  // Ignore si Rust gère l'audio (l'événement playback_ended s'en occupe)
  if (audioDurationFromRust > 0) {
    console.log('audioElement ended ignored (Rust handles playback)')
    return
  }

  console.log('audioElement ended, repeatMode:', repeatMode)
  if (repeatMode === 'one') {
    // Répète le même morceau
    const currentSrc = audioElement.src
    audioElement.src = currentSrc
    audioElement.load()
    audioElement.play().catch(e => console.error('Play error:', e))
  } else {
    playNextTrack()
  }
})

// === SHUFFLE & REPEAT ===
shuffleBtn.addEventListener('click', () => {
  // Cycle : off → album → library → off
  if (shuffleMode === 'off') {
    shuffleMode = 'album'
    shuffleBtn.classList.add('active')
    shuffleBtn.textContent = '⤮ᴬ'
    shuffleBtn.title = 'Aléatoire (Album)'
  } else if (shuffleMode === 'album') {
    shuffleMode = 'library'
    shuffleBtn.textContent = '⤮∞'
    shuffleBtn.title = 'Aléatoire (Bibliothèque)'
  } else {
    shuffleMode = 'off'
    shuffleBtn.classList.remove('active')
    shuffleBtn.textContent = '⤮'
    shuffleBtn.title = 'Aléatoire'
  }
})

repeatBtn.addEventListener('click', () => {
  // Cycle : off → all → one → off
  if (repeatMode === 'off') {
    repeatMode = 'all'
    repeatBtn.classList.add('active')
    repeatBtn.textContent = '⟳'
    repeatBtn.title = 'Répéter tout'
  } else if (repeatMode === 'all') {
    repeatMode = 'one'
    repeatBtn.textContent = '⟳₁'
    repeatBtn.title = 'Répéter un'
  } else {
    repeatMode = 'off'
    repeatBtn.classList.remove('active')
    repeatBtn.textContent = '⟳'
    repeatBtn.title = 'Répéter'
  }
})

// === VOLUME ===
let currentVolume = 1.0 // Volume actuel (0.0 - 1.0)

volumeBar.addEventListener('input', async () => {
  const volume = volumeBar.value / 100
  currentVolume = volume

  // Volume via Rust
  try {
    await invoke('audio_set_volume', { volume })
  } catch (e) {
    console.error('audio_set_volume error:', e)
    // Fallback
    audioElement.volume = volume
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
      audioElement.volume = 0
    }

    updateVolumeIcon(0)
  } else {
    // Unmute
    volumeBar.value = lastVolume
    currentVolume = lastVolume / 100

    try {
      await invoke('audio_set_volume', { volume: currentVolume })
    } catch (e) {
      audioElement.volume = currentVolume
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

// === UTILITAIRES ===
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

// === FILE D'ATTENTE (QUEUE) ===

// Ajouter un morceau à la fin de la queue
function addToQueue(track) {
  queue.push(track)
  updateQueueDisplay()
  updateQueueIndicators()
  showQueueNotification(`"${track.metadata?.title || track.name}" ajouté à la file`)
}

// Jouer ensuite (ajoute en haut de la queue)
function playNext(track) {
  queue.unshift(track)
  updateQueueDisplay()
  updateQueueIndicators()
  showQueueNotification(`"${track.metadata?.title || track.name}" sera joué ensuite`)
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
        btn.title = isInQueue ? 'Retirer de la file' : 'Ajouter à la file'
      }
    })

    // Met à jour les boutons dans le panel album detail
    document.querySelectorAll('.album-track-item').forEach(item => {
      const trackPath = item.dataset.trackPath
      const btn = item.querySelector('.track-add-queue')
      if (btn && trackPath) {
        const isInQueue = queuePaths.has(trackPath)
        btn.classList.toggle('in-queue', isInQueue)
        btn.title = isInQueue ? 'Retirer de la file' : 'Ajouter à la file'
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
        <span class="queue-item-artist">${currentTrack.metadata?.artist || 'Artiste inconnu'}</span>
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
      <span class="queue-drag-handle" title="Glisser pour réorganiser">⠿</span>
      <span class="queue-item-index">${index + 1}</span>
      <div class="queue-item-info">
        <span class="queue-item-title">${track.metadata?.title || track.name}</span>
        <span class="queue-item-artist">${track.metadata?.artist || 'Artiste inconnu'}</span>
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
  const isMulti = contextMenuTracks.length > 1

  // Cache "Voir l'album" et "Voir l'artiste" en multi-sélection
  if (goToAlbumBtn) {
    goToAlbumBtn.style.display = (isMulti || (currentView === 'albums' && selectedAlbumKey)) ? 'none' : 'flex'
  }
  if (goToArtistBtn) {
    goToArtistBtn.style.display = (isMulti || currentView === 'artists') ? 'none' : 'flex'
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
  if (queueBtn) queueBtn.textContent = isMulti ? `Ajouter ${count} à la file` : 'Ajouter à la file d\'attente'
  if (playlistBtn) playlistBtn.textContent = isMulti ? `Ajouter ${count} à une playlist` : 'Ajouter à une playlist'
  if (removeBtn) removeBtn.textContent = isMulti ? `Supprimer ${count} titres` : 'Supprimer de la bibliothèque'
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
        showQueueNotification(`${contextMenuTracks.length} titres ajoutés à la file`)
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

  // Rafraîchit l'affichage
  displayCurrentView()
  updateQueueDisplay()
  updateQueueIndicators()

  showQueueNotification(`"${track.metadata?.title || track.name}" supprimé de la bibliothèque`)
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
          <button class="sort-option ${playlistSortMode === 'recent' ? 'active' : ''}" data-sort="recent">Derniers ajoutés</button>
          <button class="sort-option ${playlistSortMode === 'az' ? 'active' : ''}" data-sort="az">A-Z</button>
          <button class="sort-option ${playlistSortMode === 'za' ? 'active' : ''}" data-sort="za">Z-A</button>
        </div>
      </div>
      <button class="btn-primary-small play-playlist-btn" ${trackCount === 0 ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        Lecture
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
      const artist = track.metadata?.artist || 'Artiste inconnu'
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
    title.textContent = 'Nouvelle playlist'
    input.value = ''
    input.placeholder = 'Nom de la playlist'
    confirmBtn.textContent = 'Créer'
  } else {
    title.textContent = 'Renommer la playlist'
    input.value = playlist?.name || ''
    input.placeholder = 'Nouveau nom'
    confirmBtn.textContent = 'Renommer'
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
}

async function confirmPlaylistModal() {
  const input = document.getElementById('playlist-name-input')
  const name = input.value.trim()

  if (!name) return

  if (playlistModalMode === 'create') {
    const newPlaylist = await invoke('create_playlist', { name })
    playlists.push(newPlaylist)
    updatePlaylistsSidebar()
    showQueueNotification(`Playlist "${name}" créée`)

    // Si on ajoutait plusieurs tracks, les ajouter maintenant
    if (tracksToAddToPlaylist && tracksToAddToPlaylist.length > 0) {
      for (const track of tracksToAddToPlaylist) {
        await invoke('add_track_to_playlist', {
          playlistId: newPlaylist.id,
          trackPath: track.path
        })
      }
      await loadPlaylists()
      showQueueNotification(`${tracksToAddToPlaylist.length} titres ajoutés à "${name}"`)
      tracksToAddToPlaylist = null
      trackToAddToPlaylist = null
    }
    // Si on ajoutait un seul track
    else if (trackToAddToPlaylist) {
      await invoke('add_track_to_playlist', {
        playlistId: newPlaylist.id,
        trackPath: trackToAddToPlaylist.path
      })
      await loadPlaylists()
      showQueueNotification(`Ajouté à "${name}"`)
      trackToAddToPlaylist = null
    }
  } else if (playlistModalMode === 'rename' && playlistToRename) {
    await invoke('rename_playlist', { id: playlistToRename.id, newName: name })
    await loadPlaylists()
    showQueueNotification(`Playlist renommée en "${name}"`)
  }

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
    showQueueNotification(`Ajouté à "${playlist?.name}"`)
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
    showQueueNotification("Cette playlist ne peut pas être supprimée")
    return
  }

  // Demander confirmation avant suppression
  const confirmed = await showConfirmModal(
    'Supprimer la playlist ?',
    `Attention, la playlist "${playlist?.name}" sera définitivement supprimée.`,
    'Supprimer'
  )

  if (!confirmed) return

  const result = await invoke('delete_playlist', { id: playlistId })

  if (result) {
    await loadPlaylists()
    showQueueNotification(`Playlist supprimée`)

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
  // Crée un menu contextuel temporaire pour la playlist
  hideContextMenu()

  const isSystemPlaylist = playlist.isSystem || playlist.id === 'favorites'

  const menu = document.createElement('div')
  menu.className = 'context-menu playlist-context-menu'
  menu.innerHTML = `
    <button class="context-menu-item" data-action="play-playlist">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      <span>Lecture</span>
    </button>
    <div class="context-menu-separator"></div>
    <button class="context-menu-item" data-action="rename-playlist">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
      </svg>
      <span>Renommer</span>
    </button>
    ${!isSystemPlaylist ? `
      <button class="context-menu-item context-menu-item-danger" data-action="delete-playlist">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
        </svg>
        <span>Supprimer</span>
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
      showQueueNotification(`${tracksToAdd.length} titres ajoutés à "${playlist?.name}"`)
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
  const title = count === 1 ? 'Supprimer ce titre ?' : `Supprimer ${count} titres ?`
  const message = count === 1
    ? `Le titre "${tracksToRemove[0].metadata?.title || tracksToRemove[0].name}" sera supprimé de votre bibliothèque.`
    : `${count} titres seront supprimés de votre bibliothèque.`

  const confirmed = await showConfirmModal(title, message, 'Supprimer')
  if (!confirmed) return

  // Supprime chaque track
  for (const track of tracksToRemove) {
    await removeTrackFromLibrary(track)
  }

  // Clear la sélection
  virtualScrollState.selectedTrackPaths.clear()
  updateTrackSelectionDisplay()

  showQueueNotification(`${count} titre${count > 1 ? 's' : ''} supprimé${count > 1 ? 's' : ''}`)
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
            showQueueNotification(`${contextMenuTracks.length} titres ajoutés à "${playlist.name}"`)
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
