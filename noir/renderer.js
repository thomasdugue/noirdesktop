// renderer.js - Gère l'interface utilisateur et la lecture audio

const { ipcRenderer } = require('electron')

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
let currentView = 'albums' // Vue actuelle : 'albums', 'artists', 'tracks'
let filteredArtist = null  // Artiste filtré (pour la navigation artiste → albums)
let isShuffleOn = false    // Mode shuffle activé
let repeatMode = 'off'     // Mode répétition : 'off', 'all', 'one'
let lastVolume = 100       // Dernier volume avant mute

// Navigation menu
const navItems = document.querySelectorAll('.nav-item')

// === SÉLECTION DE DOSSIER ===
async function selectFolder() {
  const folderPath = await ipcRenderer.invoke('select-folder')
  if (!folderPath) return // Annulé

  await addFolder(folderPath)
}

// Ajoute un dossier à la bibliothèque
async function addFolder(folderPath) {
  // Scanne le dossier
  const audioFiles = await ipcRenderer.invoke('scan-folder', folderPath)

  if (audioFiles.length === 0) {
    alert('Aucun fichier audio trouvé dans ce dossier.')
    return
  }

  // Sauvegarde le chemin pour la prochaine fois
  await ipcRenderer.invoke('add-library-path', folderPath)

  // Ajoute les morceaux à la liste existante (évite les doublons par chemin)
  const existingPaths = new Set(tracks.map(t => t.path))
  for (const file of audioFiles) {
    if (!existingPaths.has(file.path)) {
      tracks.push(file)
    }
  }

  // Charge les métadonnées et groupe par album
  await loadMetadataAndGroupAlbums()

  // Cache le message de bienvenue
  welcomeDiv.classList.add('hidden')
}

// Charge les métadonnées de tous les morceaux et groupe par album et artiste
async function loadMetadataAndGroupAlbums() {
  albums = {}
  artists = {}

  for (const track of tracks) {
    // Charge les métadonnées si pas encore fait
    if (!track.metadata) {
      track.metadata = await ipcRenderer.invoke('get-metadata', track.path)
    }

    const albumKey = `${track.metadata.artist} - ${track.metadata.album}`
    const artistKey = track.metadata.artist

    // Groupe par album
    if (!albums[albumKey]) {
      albums[albumKey] = {
        artist: track.metadata.artist,
        album: track.metadata.album,
        tracks: [],
        coverPath: track.path
      }
    }
    albums[albumKey].tracks.push(track)

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
  for (const albumKey in albums) {
    albums[albumKey].tracks.sort((a, b) => (a.metadata.track || 0) - (b.metadata.track || 0))
  }

  // Convertit les Sets en Arrays pour les artistes
  for (const artistKey in artists) {
    artists[artistKey].albums = Array.from(artists[artistKey].albums)
  }

  // Affiche la vue courante
  displayCurrentView()
}

// Au démarrage : charge toutes les bibliothèques sauvegardées
async function init() {
  const savedPaths = await ipcRenderer.invoke('get-library-paths')

  for (const folderPath of savedPaths) {
    const audioFiles = await ipcRenderer.invoke('scan-folder', folderPath)
    tracks.push(...audioFiles)
  }

  if (tracks.length > 0) {
    await loadMetadataAndGroupAlbums()
    welcomeDiv.classList.add('hidden')
  }
}

// Lance l'initialisation
init()

// Les deux boutons font la même chose
selectFolderBtn.addEventListener('click', selectFolder)
openFolderWelcomeBtn.addEventListener('click', selectFolder)

// === NAVIGATION MENU ===
navItems.forEach(item => {
  item.addEventListener('click', () => {
    // Met à jour l'état actif
    navItems.forEach(i => i.classList.remove('active'))
    item.classList.add('active')

    // Réinitialise le filtre artiste
    filteredArtist = null

    // Change la vue
    currentView = item.dataset.view
    displayCurrentView()
  })
})

// Affiche la vue courante
function displayCurrentView() {
  // Ferme le panel de détail album si ouvert
  closeAlbumDetail()

  switch (currentView) {
    case 'albums':
      displayAlbumsGrid()
      break
    case 'artists':
      displayArtistsGrid()
      break
    case 'tracks':
      displayTracksGrid()
      break
  }
}

// === RECHERCHE ===
searchInput.addEventListener('input', (e) => {
  searchQuery = e.target.value.toLowerCase().trim()
  displayCurrentView()
})

// === AFFICHAGE DE LA GRILLE D'ALBUMS ===
async function displayAlbumsGrid() {
  albumsGridDiv.innerHTML = ''
  albumsViewDiv.classList.remove('hidden')

  // Si on filtre par artiste, affiche un header avec bouton retour
  if (filteredArtist) {
    const header = document.createElement('div')
    header.className = 'view-header'
    header.innerHTML = `
      <button class="btn-back">← Retour</button>
      <h2>${filteredArtist}</h2>
    `
    header.querySelector('.btn-back').addEventListener('click', () => {
      filteredArtist = null
      currentView = 'artists'
      navItems.forEach(i => i.classList.remove('active'))
      document.querySelector('[data-view="artists"]').classList.add('active')
      displayArtistsGrid()
    })
    albumsGridDiv.appendChild(header)
  }

  // Conteneur pour la grille
  const gridContainer = document.createElement('div')
  gridContainer.className = 'albums-grid-container'

  for (const albumKey in albums) {
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

    // Charge la pochette
    const cover = await ipcRenderer.invoke('get-cover', album.coverPath)

    card.innerHTML = `
      <div class="album-cover">
        ${cover && cover.startsWith('data:image')
          ? `<img src="${cover}" alt="${album.album}">`
          : '<div class="album-cover-placeholder">♪</div>'
        }
      </div>
      <div class="album-title">${album.album}</div>
      <div class="album-artist">${album.artist}</div>
    `

    // Clic sur un album = ouvre le panel de détail
    card.addEventListener('click', () => {
      showAlbumDetail(albumKey, cover, card)
    })

    gridContainer.appendChild(card)
  }

  albumsGridDiv.appendChild(gridContainer)
}

// === AFFICHAGE DE LA GRILLE D'ARTISTES ===
async function displayArtistsGrid() {
  albumsGridDiv.innerHTML = ''
  albumsViewDiv.classList.remove('hidden')

  // Conteneur pour la grille (même style que les albums)
  const gridContainer = document.createElement('div')
  gridContainer.className = 'albums-grid-container'

  // Trie les artistes par nom
  const sortedArtists = Object.keys(artists).sort((a, b) => a.localeCompare(b))

  for (const artistKey of sortedArtists) {
    const artist = artists[artistKey]

    // Filtre par recherche
    if (searchQuery) {
      if (!artist.name.toLowerCase().includes(searchQuery)) continue
    }

    const card = document.createElement('div')
    card.className = 'album-card artist-card'

    // Charge la pochette du premier album de l'artiste
    const cover = await ipcRenderer.invoke('get-cover', artist.coverPath)

    const albumCount = artist.albums.length
    const trackCount = artist.tracks.length

    card.innerHTML = `
      <div class="album-cover artist-cover">
        ${cover && cover.startsWith('data:image')
          ? `<img src="${cover}" alt="${artist.name}">`
          : '<div class="album-cover-placeholder">♪</div>'
        }
      </div>
      <div class="album-title">${artist.name}</div>
      <div class="album-artist">${albumCount} album${albumCount > 1 ? 's' : ''} • ${trackCount} titre${trackCount > 1 ? 's' : ''}</div>
    `

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
  filteredArtist = artistKey

  // Passe en vue albums filtrée
  currentView = 'albums'
  navItems.forEach(i => i.classList.remove('active'))
  document.querySelector('[data-view="albums"]').classList.add('active')

  displayAlbumsGrid()
}

// === AFFICHAGE DE LA LISTE DES TITRES ===
async function displayTracksGrid() {
  albumsGridDiv.innerHTML = ''
  albumsViewDiv.classList.remove('hidden')

  // Crée un conteneur pour la liste des titres
  const tracksContainer = document.createElement('div')
  tracksContainer.className = 'tracks-list-view'

  // Header de la liste
  const header = document.createElement('div')
  header.className = 'tracks-list-header'
  header.innerHTML = `
    <span>Titre</span>
    <span>Artiste</span>
    <span>Album</span>
    <span>Qualité</span>
    <span>Durée</span>
  `
  tracksContainer.appendChild(header)

  // Trie les tracks par titre
  const sortedTracks = [...tracks].sort((a, b) => {
    const titleA = a.metadata?.title || a.name
    const titleB = b.metadata?.title || b.name
    return titleA.localeCompare(titleB)
  })

  for (let i = 0; i < sortedTracks.length; i++) {
    const track = sortedTracks[i]
    const title = track.metadata?.title || track.name
    const artist = track.metadata?.artist || 'Artiste inconnu'
    const album = track.metadata?.album || ''
    const duration = track.metadata?.duration ? formatTime(track.metadata.duration) : '-:--'

    // Qualité audio
    const quality = formatQuality(track.metadata)

    // Filtre par recherche
    if (searchQuery) {
      const matchesTitle = title.toLowerCase().includes(searchQuery)
      const matchesArtist = artist.toLowerCase().includes(searchQuery)
      const matchesAlbum = album.toLowerCase().includes(searchQuery)
      if (!matchesTitle && !matchesArtist && !matchesAlbum) continue
    }

    const trackItem = document.createElement('div')
    trackItem.className = 'tracks-list-item'

    trackItem.innerHTML = `
      <span class="tracks-list-title">${title}</span>
      <span class="tracks-list-artist">${artist}</span>
      <span class="tracks-list-album">${album}</span>
      <span class="tracks-list-quality"><span class="quality-tag ${quality.class}">${quality.label}</span></span>
      <span class="tracks-list-duration">${duration}</span>
    `

    // Retrouve l'index original pour la lecture
    const originalIndex = tracks.findIndex(t => t.path === track.path)
    trackItem.addEventListener('click', () => {
      playTrack(originalIndex)
    })

    tracksContainer.appendChild(trackItem)
  }

  albumsGridDiv.appendChild(tracksContainer)
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
async function showAlbumDetail(albumKey, cover, clickedCard) {
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
        <p class="album-detail-meta">${album.tracks.length} titres • ${formatTime(totalDuration)}</p>
        <button class="btn-primary-small play-album-btn">Lecture</button>
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

    const duration = track.metadata?.duration ? formatTime(track.metadata.duration) : '-:--'

    trackItem.innerHTML = `
      <span class="track-number">${track.metadata?.track || index + 1}</span>
      <span class="track-title">${track.metadata?.title || track.name}</span>
      <span class="track-duration">${duration}</span>
    `

    trackItem.addEventListener('click', () => {
      const globalIndex = tracks.findIndex(t => t.path === track.path)
      if (globalIndex !== -1) {
        playTrack(globalIndex)
        updateAlbumTracksHighlight()
      }
    })

    albumTracksDiv.appendChild(trackItem)
  })

  // Event listeners pour le panel
  albumDetailDiv.querySelector('.close-album-detail').addEventListener('click', closeAlbumDetail)
  albumDetailDiv.querySelector('.play-album-btn').addEventListener('click', () => {
    if (selectedAlbumKey) playAlbum(selectedAlbumKey)
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
  const album = albums[albumKey]
  if (album.tracks.length > 0) {
    const firstTrack = album.tracks[0]
    const globalIndex = tracks.findIndex(t => t.path === firstTrack.path)
    if (globalIndex !== -1) {
      playTrack(globalIndex)
      updateAlbumTracksHighlight()
    }
  }
}

// === LECTURE D'UN MORCEAU ===
async function playTrack(index) {
  currentTrackIndex = index
  const track = tracks[index]

  // Met à jour l'affichage avec les métadonnées
  const title = track.metadata ? track.metadata.title : track.name
  const artist = track.metadata ? track.metadata.artist : track.folder
  trackNameEl.textContent = title
  trackFolderEl.textContent = artist

  // Charge la pochette
  const cover = await ipcRenderer.invoke('get-cover', track.path)
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

  // Charge et joue
  audioElement.src = 'file://' + track.path
  audioElement.play()
  playPauseBtn.textContent = '⏸'

  // Affiche le lecteur
  playerDiv.classList.remove('hidden')

  // Met à jour le highlight dans le panel album si ouvert
  updateAlbumTracksHighlight()
}

// === CONTRÔLES DU LECTEUR ===
playPauseBtn.addEventListener('click', () => {
  if (audioElement.paused) {
    audioElement.play()
    playPauseBtn.textContent = '⏸'
  } else {
    audioElement.pause()
    playPauseBtn.textContent = '▶'
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

// Fonction pour jouer le morceau suivant (gère shuffle)
function playNextTrack() {
  if (isShuffleOn) {
    // Mode shuffle : joue un morceau aléatoire différent
    let randomIndex
    do {
      randomIndex = Math.floor(Math.random() * tracks.length)
    } while (randomIndex === currentTrackIndex && tracks.length > 1)
    playTrack(randomIndex)
  } else if (currentTrackIndex < tracks.length - 1) {
    playTrack(currentTrackIndex + 1)
  }
}

// Mise à jour de la barre de progression
audioElement.addEventListener('timeupdate', () => {
  if (audioElement.duration) {
    const percent = (audioElement.currentTime / audioElement.duration) * 100
    progressBar.value = percent
    currentTimeEl.textContent = formatTime(audioElement.currentTime)
  }
})

// Quand les métadonnées sont chargées (durée disponible)
audioElement.addEventListener('loadedmetadata', () => {
  durationEl.textContent = formatTime(audioElement.duration)
})

// Clic sur la barre de progression = seek
progressBar.addEventListener('input', () => {
  const time = (progressBar.value / 100) * audioElement.duration
  audioElement.currentTime = time
})

// Quand un morceau se termine
audioElement.addEventListener('ended', () => {
  if (repeatMode === 'one') {
    // Répète le même morceau
    audioElement.currentTime = 0
    audioElement.play()
  } else if (isShuffleOn) {
    // Mode shuffle
    playNextTrack()
  } else if (currentTrackIndex < tracks.length - 1) {
    // Morceau suivant
    playTrack(currentTrackIndex + 1)
  } else if (repeatMode === 'all') {
    // Répète tout : retour au début
    playTrack(0)
  } else {
    playPauseBtn.textContent = '▶'
  }
})

// === SHUFFLE & REPEAT ===
shuffleBtn.addEventListener('click', () => {
  isShuffleOn = !isShuffleOn
  shuffleBtn.classList.toggle('active', isShuffleOn)
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
volumeBar.addEventListener('input', () => {
  const volume = volumeBar.value / 100
  audioElement.volume = volume
  updateVolumeIcon(volume)
  if (volume > 0) lastVolume = volumeBar.value
})

volumeBtn.addEventListener('click', () => {
  if (audioElement.volume > 0) {
    // Mute
    lastVolume = volumeBar.value
    volumeBar.value = 0
    audioElement.volume = 0
    updateVolumeIcon(0)
  } else {
    // Unmute
    volumeBar.value = lastVolume
    audioElement.volume = lastVolume / 100
    updateVolumeIcon(lastVolume / 100)
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
