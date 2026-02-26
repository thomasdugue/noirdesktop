// playback.js — Contrôle audio Rust
// Gère la lecture, le seek, le volume, le shuffle/repeat, la sortie audio et l'interpolation 60fps.

import { playback, library, queue, caches, dom } from './state.js'
import { invoke, listen } from './state.js'
import { app } from './app.js'
import { formatTime, formatQuality, showToast, isValidImageSrc, escapeHtml, getCodecFromPath } from './utils.js'
import { isDragging } from './drag.js'

// === CONSTANTES ===
const MAX_INTERPOLATION_DELTA = 0.15  // Max 150ms d'interpolation (évite les sauts)
const SMOOTHING_FACTOR = 0.3          // Facteur de lissage pour transitions douces
const DRAG_THRESHOLD = 5              // pixels minimum pour distinguer clic/drag en queue

// === LECTURE D'UN ALBUM ===

export function playAlbum(albumKey) {
  if (!albumKey) return
  const album = library.albums[albumKey]
  if (!album || !album.tracks || album.tracks.length === 0) return

  const firstTrack = album.tracks[0]
  const globalIndex = library.tracks.findIndex(t => t.path === firstTrack.path)
  if (globalIndex !== -1) {
    playTrack(globalIndex)
    app.updateAlbumTracksHighlight()
  }
}

// === LECTURE D'UN MORCEAU ===

export async function playTrack(index) {
  // Validation des entrées
  if (index < 0 || index >= library.tracks.length) {
    console.error('playTrack: index invalide', index)
    return
  }

  // Reset complet de l'UI AVANT tout (évite les états incohérents)
  resetPlayerUI()
  playback.gaplessPreloadTriggered = false

  playback.currentTrackIndex = index
  const track = library.tracks[index]

  if (!track || !track.path) {
    console.error('playTrack: track invalide', track)
    return
  }

  // Met à jour l'affichage avec les métadonnées
  const title = track.metadata?.title || track.name || 'Titre inconnu'
  const artist = track.metadata?.artist || track.folder || 'Unknown Artist'
  dom.trackNameEl.textContent = title
  dom.trackFolderEl.textContent = artist

  // Affiche les specs techniques (bitrate/sample rate)
  const trackQualityEl = document.getElementById('track-quality')
  if (trackQualityEl) {
    const quality = formatQuality(track.metadata, track.path)
    trackQualityEl.textContent = quality.label !== '-' ? quality.label : ''
  }

  // Charge la pochette (depuis le cache si possible)
  let cover = caches.coverCache.get(track.path)
  if (cover === undefined) {
    try {
      // 1. Essaie d'abord la pochette embarquée
      cover = await invoke('get_cover', { path: track.path })

      // 2. Si pas de pochette, cherche sur Internet
      if (!cover && track.metadata) {
        cover = await invoke('fetch_internet_cover', {
          artist: track.metadata.artist || 'Unknown Artist',
          album: track.metadata.album || 'Unknown Album'
        })
      }
    } catch (e) {
      console.error('[PLAYBACK] Error loading cover:', e)
      cover = null
    }

    caches.coverCache.set(track.path, cover)
  }

  if (isValidImageSrc(cover)) {
    const img = document.createElement('img')
    img.src = cover
    img.onerror = () => {
      dom.coverArtEl.innerHTML = '<div class="cover-placeholder">♪</div>'
    }
    dom.coverArtEl.innerHTML = ''
    dom.coverArtEl.appendChild(img)
  } else {
    dom.coverArtEl.innerHTML = '<div class="cover-placeholder">♪</div>'
  }

  // === AUDIO ENGINE RUST : Joue le fichier via le backend (STREAMING) ===
  try {
    // Joue via le moteur Rust (non-bloquant, démarre après ~100ms de buffer)
    await invoke('audio_play', { path: track.path })
    playback.audioIsPlaying = true
    // La durée sera mise à jour via l'événement playback_progress
    // Utilise la durée des métadonnées comme estimation initiale
    const estimatedDuration = track.metadata?.duration || 0
    playback.audioDurationFromRust = estimatedDuration
    dom.durationEl.textContent = estimatedDuration > 0 ? formatTime(estimatedDuration) : '--:--'
    console.log('Streaming started (Rust):', track.path)
  } catch (e) {
    console.error('Rust audio_play error:', e)
    // No HTML5 fallback - Rust is the only audio path
    playback.audioIsPlaying = false
  }
  dom.playPauseBtn.textContent = playback.audioIsPlaying ? '⏸' : '▶'

  // Note: resetPlayerUI() est appelé en début de fonction

  // Note: gapless preload is now triggered by playback_progress when < 10s remaining

  // Track l'album en cours de lecture (utilise le nom d'album seul comme clé, cohérent avec groupTracksIntoAlbumsAndArtists)
  playback.currentPlayingAlbumKey = track.metadata?.album || 'Unknown Album'

  // Affiche le lecteur
  dom.playerDiv.classList.remove('hidden')
  document.body.classList.add('player-visible')

  // Met à jour le highlight dans le panel album si ouvert
  app.updateAlbumTracksHighlight()

  // Met à jour la section "Lecture en cours" de la Home si visible
  app.updateHomeNowPlayingSection()

  // Enregistre la lecture dans l'historique et invalide le cache Home
  invoke('record_play', {
    path: track.path,
    artist: track.metadata?.artist || 'Unknown Artist',
    album: track.metadata?.album || '',
    title: track.metadata?.title || track.name
  }).then(() => {
    app.invalidateHomeCache()  // Les stats ont changé, invalide le cache
  }).catch(err => console.error('Erreur enregistrement historique:', err))
}

// === GAPLESS PRELOAD ===

export function getNextTrackPath() {
  // Queue priority
  if (queue.items.length > 0) return queue.items[0].path

  // Repeat one = same track
  if (playback.repeatMode === 'one' && playback.currentTrackIndex >= 0) return library.tracks[playback.currentTrackIndex]?.path

  const currentTrack = library.tracks[playback.currentTrackIndex]
  if (!currentTrack) return null

  const currentFolder = currentTrack.path.substring(0, currentTrack.path.lastIndexOf('/'))
  const albumTracks = library.tracks.filter(t => {
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
  if (playback.repeatMode === 'all' && albumTracks.length > 0) {
    return albumTracks[0].path
  }
  return null
}

export function triggerGaplessPreload() {
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

// Fonction toggle play/pause (réutilisable par raccourcis clavier)
export async function togglePlay() {
  // Si pas de track sélectionnée, essayer de charger la dernière jouée ou la première
  if (playback.currentTrackIndex < 0 || !library.tracks[playback.currentTrackIndex]) {
    if (library.tracks.length === 0) return  // Pas de musique du tout

    try {
      // Essayer de récupérer la dernière track jouée
      const lastPlayed = await invoke('get_last_played')
      if (lastPlayed && lastPlayed.path) {
        const index = library.tracks.findIndex(t => t.path === lastPlayed.path)
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
  if (playback.isTogglingPlayState) {
    console.log('[togglePlay] Debounce - ignoring call')
    return
  }
  playback.isTogglingPlayState = true

  // Détermine l'action à effectuer basée sur l'état Rust (source de vérité)
  const shouldResume = playback.isPausedFromRust || !playback.audioIsPlaying
  const action = shouldResume ? 'resume' : 'pause'

  // Protection supplémentaire : évite d'envoyer la même action 2 fois de suite
  // ou une action inverse immédiatement après (symptôme du bug double-entrée)
  if (playback.lastToggleAction === action) {
    console.log('[togglePlay] Same action already pending:', action)
    playback.isTogglingPlayState = false
    return
  }

  playback.lastToggleAction = action
  console.log('[togglePlay] Action:', action, '| isPausedFromRust:', playback.isPausedFromRust, '| audioIsPlaying:', playback.audioIsPlaying)

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
  app.updateHomeNowPlayingSection()

  // Réactive après un délai plus long pour être sûr que l'événement Rust est arrivé
  setTimeout(() => {
    playback.isTogglingPlayState = false
    playback.lastToggleAction = null  // Reset pour permettre la prochaine action
  }, 250)
}

// Fonction pour jouer le morceau précédent (réutilisable par raccourcis clavier)
export function playPreviousTrack() {
  const currentTrack = library.tracks[playback.currentTrackIndex]
  const currentFolder = currentTrack?.path ? currentTrack.path.substring(0, currentTrack.path.lastIndexOf('/')) : null

  // Filtre les tracks qui sont dans le même dossier ET ont le même album metadata
  const albumTracks = currentFolder ? library.tracks.filter(t => {
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
    const globalIndex = library.tracks.findIndex(t => t.path === prevAlbumTrack.path)
    console.log('Playing previous album track:', { prevTrack: prevAlbumTrack?.metadata?.title, globalIndex })
    if (globalIndex !== -1) {
      playTrack(globalIndex)
      return
    }
  } else if (albumTracks.length > 0 && currentAlbumTrackIndex === 0 && playback.repeatMode === 'all') {
    // Début de l'album + repeat all = va à la dernière track de l'album
    const lastTrack = albumTracks[albumTracks.length - 1]
    const globalIndex = library.tracks.findIndex(t => t.path === lastTrack.path)
    if (globalIndex !== -1) {
      playTrack(globalIndex)
      return
    }
  }

  // Fallback: comportement global
  if (playback.currentTrackIndex > 0) {
    playTrack(playback.currentTrackIndex - 1)
  }
}

// Fonction pour jouer le morceau suivant (gère queue + shuffle + repeat + album context)
export function playNextTrack() {
  // 1. Priorité : vérifie la file d'attente
  if (queue.items.length > 0) {
    const nextTrack = queue.items.shift() // Retire le premier de la queue
    const globalIndex = library.tracks.findIndex(t => t.path === nextTrack.path)
    if (globalIndex !== -1) {
      playTrack(globalIndex)
      app.updateQueueDisplay()
      app.updateQueueIndicators()
      return
    }
  }

  // 2. Récupère les tracks de l'album en cours
  // Match par dossier OU par métadonnées album+artiste (pour albums multi-CD dans des sous-dossiers)
  const currentTrack = library.tracks[playback.currentTrackIndex]
  const currentFolder = currentTrack?.path ? currentTrack.path.substring(0, currentTrack.path.lastIndexOf('/')) : null

  // Filtre les tracks du même album: même dossier OU même album+artiste (multi-CD)
  const albumTracks = currentFolder ? library.tracks.filter(t => {
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
    shuffleMode: playback.shuffleMode,
    repeatMode: playback.repeatMode
  })

  // 3. Gestion des modes shuffle (seulement si le track actuel est bien dans l'album)
  if (playback.shuffleMode === 'album' && albumTracks.length > 1 && currentAlbumTrackIndex !== -1) {
    // Shuffle dans l'album uniquement - évite les doublons
    const availableTracks = albumTracks.filter(t => !playback.shufflePlayedTracks.has(t.path))

    if (availableTracks.length === 0) {
      // Tous les tracks ont été joués, on reset et on recommence
      playback.shufflePlayedTracks.clear()
      if (currentTrack) playback.shufflePlayedTracks.add(currentTrack.path)
      // Re-filter après reset
      const freshTracks = albumTracks.filter(t => !playback.shufflePlayedTracks.has(t.path))
      if (freshTracks.length > 0) {
        const randomTrack = freshTracks[Math.floor(Math.random() * freshTracks.length)]
        playback.shufflePlayedTracks.add(randomTrack.path)
        const globalIndex = library.tracks.findIndex(t => t.path === randomTrack.path)
        if (globalIndex !== -1) {
          playTrack(globalIndex)
          return
        }
      }
    } else {
      // Choisir parmi les tracks non encore joués
      const randomTrack = availableTracks[Math.floor(Math.random() * availableTracks.length)]
      playback.shufflePlayedTracks.add(randomTrack.path)
      const globalIndex = library.tracks.findIndex(t => t.path === randomTrack.path)
      if (globalIndex !== -1) {
        playTrack(globalIndex)
        return
      }
    }
  } else if (playback.shuffleMode === 'library') {
    // Shuffle sur toute la bibliothèque - évite les doublons
    const availableTracks = library.tracks.filter(t => !playback.shufflePlayedTracks.has(t.path))

    if (availableTracks.length === 0) {
      // Tous les tracks ont été joués, on reset
      playback.shufflePlayedTracks.clear()
      if (currentTrack) playback.shufflePlayedTracks.add(currentTrack.path)
      const freshTracks = library.tracks.filter(t => !playback.shufflePlayedTracks.has(t.path))
      if (freshTracks.length > 0) {
        const randomTrack = freshTracks[Math.floor(Math.random() * freshTracks.length)]
        playback.shufflePlayedTracks.add(randomTrack.path)
        const globalIndex = library.tracks.findIndex(t => t.path === randomTrack.path)
        playTrack(globalIndex)
        return
      }
    } else {
      const randomTrack = availableTracks[Math.floor(Math.random() * availableTracks.length)]
      playback.shufflePlayedTracks.add(randomTrack.path)
      const globalIndex = library.tracks.findIndex(t => t.path === randomTrack.path)
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
      const globalIndex = library.tracks.findIndex(t => t.path === nextAlbumTrack.path)
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
    } else if (playback.repeatMode === 'all') {
      // Fin de l'album + repeat all = retour au début de l'album
      const firstTrack = albumTracks[0]
      const globalIndex = library.tracks.findIndex(t => t.path === firstTrack.path)
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
      hasAlbum: !!playback.currentPlayingAlbumKey,
      currentAlbumTrackIndex,
      currentTrackIndex: playback.currentTrackIndex,
      tracksLength: library.tracks.length
    })
    if (playback.currentTrackIndex < library.tracks.length - 1) {
      console.log('playNextTrack: playing global next track', { nextIndex: playback.currentTrackIndex + 1 })
      playTrack(playback.currentTrackIndex + 1)
      return
    } else if (playback.repeatMode === 'all') {
      console.log('playNextTrack: repeat all - back to track 0')
      playTrack(0)
      return
    }
  }

  // Fin de lecture
  console.log('playNextTrack: END OF PLAYBACK - no next track to play')
  dom.playPauseBtn.textContent = '▶'
}

// Obtient la durée correcte du track (Rust prioritaire, sinon métadonnées)
export function getCurrentTrackDuration() {
  // Priorité : durée du moteur Rust
  if (playback.audioDurationFromRust > 0) {
    return playback.audioDurationFromRust
  }

  // Fallback : métadonnées
  const track = library.tracks[playback.currentTrackIndex]
  const metadataDuration = track?.metadata?.duration
  if (metadataDuration && metadataDuration > 0) {
    return metadataDuration
  }

  return 0
}

// === INTERPOLATION FLUIDE (60 FPS) ===

// Démarre l'interpolation fluide
export function startPositionInterpolation() {
  if (playback.interpolationAnimationId) return // Déjà en cours

  function interpolate() {
    // Continue toujours la boucle pour réagir aux changements d'état
    playback.interpolationAnimationId = requestAnimationFrame(interpolate)

    // Ne met pas à jour si pas en lecture ou en seek
    if (!playback.audioIsPlaying || playback.isSeekingUI || playback.isPausedFromRust) {
      return
    }

    const now = performance.now()
    const elapsed = (now - playback.lastRustTimestamp) / 1000 // En secondes
    const duration = playback.audioDurationFromRust

    if (duration <= 0 || playback.lastRustTimestamp === 0) {
      return
    }

    // Borne l'interpolation pour éviter les sauts (max 150ms depuis dernière update Rust)
    const boundedElapsed = Math.min(elapsed, MAX_INTERPOLATION_DELTA)

    // Calcule la position cible
    const targetPosition = Math.min(playback.lastRustPosition + boundedElapsed, duration)

    // Lissage : approche progressivement la position cible (évite les micro-saccades)
    const smoothedPosition = playback.lastDisplayedPosition +
      (targetPosition - playback.lastDisplayedPosition) * SMOOTHING_FACTOR

    // Clamp final
    const clampedPosition = Math.max(0, Math.min(smoothedPosition, duration))
    playback.lastDisplayedPosition = clampedPosition

    // Met à jour l'affichage
    const percent = (clampedPosition / duration) * 100
    dom.progressBar.value = Math.min(percent, 100)
    dom.currentTimeEl.textContent = formatTime(clampedPosition)
    updateProgressBarStyle(percent)
  }

  playback.interpolationAnimationId = requestAnimationFrame(interpolate)
}

// Arrête l'interpolation
export function stopPositionInterpolation() {
  if (playback.interpolationAnimationId) {
    cancelAnimationFrame(playback.interpolationAnimationId)
    playback.interpolationAnimationId = null
  }
}

// Synchronise immédiatement avec une position Rust (appelé sur événement)
// IMPORTANT: Ignore les updates pendant un seek pour éviter le "snap back"
export function syncToRustPosition(position) {
  // Si on est en seek, vérifie si la position Rust correspond à notre seek
  if (playback.isSeekingUI) {
    // Compare avec seekTargetPosition (la position DEMANDÉE, pas interpolée)
    // Tolérance de 1 seconde car le décodeur peut seek légèrement avant/après
    const seekDelta = Math.abs(position - playback.seekTargetPosition)
    if (seekDelta < 1.0) {
      // La position Rust correspond à notre seek → le seek a abouti !
      console.log(`[Sync] Seek confirmed: Rust at ${position.toFixed(2)}s (target was ${playback.seekTargetPosition.toFixed(2)}s, delta: ${seekDelta.toFixed(3)}s)`)

      // Réactive l'interpolation immédiatement maintenant que le seek est confirmé
      playback.isSeekingUI = false
      playback.seekPending = false

      // Annule le timeout de sécurité
      if (playback.seekTimeoutId) {
        clearTimeout(playback.seekTimeoutId)
        playback.seekTimeoutId = null
      }

      // Met à jour la position avec la vraie position de Rust
      playback.lastRustPosition = position
      playback.lastRustTimestamp = performance.now()
      playback.lastDisplayedPosition = position
    } else {
      // La position Rust est loin de notre seek → ignorer (ancienne position)
      console.log(`[Sync] Ignoring stale position: ${position.toFixed(2)}s (seek target: ${playback.seekTargetPosition.toFixed(2)}s)`)
      return
    }
  } else {
    // Pas en seek, synchronisation normale
    playback.lastRustPosition = position
    playback.lastRustTimestamp = performance.now()
    playback.lastDisplayedPosition = position
  }
}

// === RESET UI COMPLET (appelé à chaque changement de piste) ===
// Remet tous les compteurs et l'affichage à zéro
export function resetPlayerUI() {
  // Reset des variables d'interpolation
  playback.lastRustPosition = 0
  playback.lastRustTimestamp = 0
  playback.lastDisplayedPosition = 0
  playback.audioPositionFromRust = 0
  playback.isSeekingUI = false
  playback.isPausedFromRust = false

  // Annule le timeout de seek si actif
  if (playback.seekTimeoutId) {
    clearTimeout(playback.seekTimeoutId)
    playback.seekTimeoutId = null
  }
  playback.seekPending = false

  // Reset de l'affichage
  dom.progressBar.value = 0
  updateProgressBarStyle(0)
  dom.currentTimeEl.textContent = '0:00'

  // Reset du moniteur audio specs
  resetAudioSpecs()

  console.log('Player UI reset complete')
}

// === SEEK ===

// Fonction de seek unique (évite la duplication de code)
// IMPORTANT: Garde le curseur à la position demandée même si le seek échoue ou prend du temps
export async function performSeek() {
  if (playback.seekPending) return  // Évite les seeks multiples
  playback.seekPending = true

  const duration = getCurrentTrackDuration()
  if (duration > 0) {
    const time = (dom.progressBar.value / 100) * duration

    // Annule le timeout précédent si on seek rapidement plusieurs fois
    if (playback.seekTimeoutId) {
      clearTimeout(playback.seekTimeoutId)
      playback.seekTimeoutId = null
    }

    // IMPORTANT: Stocke la position demandée pour la comparaison dans syncToRustPosition
    // Cette valeur ne changera pas pendant l'attente du seek
    playback.seekTargetPosition = time

    // FORCE la position visuelle immédiatement
    // Ces valeurs seront utilisées par l'interpolation même si le seek prend du temps
    playback.lastRustPosition = time
    playback.lastRustTimestamp = performance.now()
    playback.lastDisplayedPosition = time
    dom.currentTimeEl.textContent = formatTime(time)
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
      playback.lastRustPosition = time
      playback.lastRustTimestamp = performance.now()
    }

    // Timeout de sécurité : réactive l'interpolation après 2 secondes max
    // même si le backend ne confirme pas (évite de rester bloqué)
    playback.seekTimeoutId = setTimeout(() => {
      if (playback.isSeekingUI) {
        console.log('[Seek] Safety timeout: re-enabling interpolation')
        playback.isSeekingUI = false
      }
      playback.seekPending = false
      playback.seekTimeoutId = null
    }, 2000)  // 2 secondes max d'attente
  } else {
    playback.seekPending = false
  }
}

// Met à jour visuellement la barre de progression (couleur de remplissage)
export function updateProgressBarStyle(percent) {
  const clampedPercent = Math.min(Math.max(percent, 0), 100)
  dom.progressBar.style.background = `linear-gradient(to right, #fff 0%, #fff ${clampedPercent}%, #333 ${clampedPercent}%, #333 100%)`
}

// === MONITEUR AUDIO SPECS (SOURCE vs OUTPUT) ===

// Formate un sample rate pour l'affichage (ex: 96000 → "96kHz")
export function formatSampleRate(hz) {
  if (hz >= 1000) {
    const khz = hz / 1000
    // Affiche sans décimale si c'est un nombre rond
    return khz % 1 === 0 ? `${khz}kHz` : `${khz.toFixed(1)}kHz`
  }
  return `${hz}Hz`
}

// === BIT PERFECT ANIMATION ===

let _bpAnimTimer = null
let _isBitPerfect = false
const BP_FADE = 400      // ms pour les transitions opacity
const BP_SHIMMER = 800   // ms pour le balayage silver
const BP_PAUSE = 8000    // ms d'affichage SRC/OUT avant nouveau cycle

function stopBitPerfectAnimation() {
  _isBitPerfect = false
  if (_bpAnimTimer !== null) { clearTimeout(_bpAnimTimer); _bpAnimTimer = null }
  const badge = document.getElementById('bit-perfect-badge')
  const container = document.getElementById('audio-specs')
  if (badge) {
    badge.style.transition = 'none'
    badge.style.opacity = '0'
    badge.classList.remove('shimmering')
  }
  if (container) {
    Array.from(container.querySelectorAll('.specs-source, .specs-separator, .specs-output'))
      .forEach(el => { el.style.transition = 'none'; el.style.opacity = '1' })
  }
}

function startBitPerfectAnimation() {
  if (_isBitPerfect) return   // déjà en cours
  _isBitPerfect = true

  function runCycle() {
    if (!_isBitPerfect) return
    const container = document.getElementById('audio-specs')
    const badge = document.getElementById('bit-perfect-badge')
    if (!container || !badge) return

    const parts = Array.from(container.querySelectorAll('.specs-source, .specs-separator, .specs-output'))

    // 1. Fade out SRC / OUT
    parts.forEach(el => { el.style.transition = `opacity ${BP_FADE}ms`; el.style.opacity = '0' })

    // 2. Fade in "BIT PERFECT"
    _bpAnimTimer = setTimeout(() => {
      if (!_isBitPerfect) return
      badge.style.transition = `opacity ${BP_FADE}ms`
      badge.style.opacity = '1'

      // 3. Shimmer +1s après l'apparition
      _bpAnimTimer = setTimeout(() => {
        if (!_isBitPerfect) return
        badge.classList.add('shimmering')

        // 4. Fade out "BIT PERFECT" 2s après la fin du shimmer
        _bpAnimTimer = setTimeout(() => {
          if (!_isBitPerfect) return
          badge.classList.remove('shimmering')
          badge.style.transition = `opacity ${BP_FADE}ms`
          badge.style.opacity = '0'

          // 5. Fade in SRC / OUT
          _bpAnimTimer = setTimeout(() => {
            if (!_isBitPerfect) return
            parts.forEach(el => { el.style.transition = `opacity ${BP_FADE}ms`; el.style.opacity = '1' })

            // 6. Pause 8s puis nouveau cycle
            _bpAnimTimer = setTimeout(runCycle, BP_PAUSE)
          }, BP_FADE + 50)
        }, BP_SHIMMER + 2000)
      }, 1000)
    }, BP_FADE + 50)
  }

  runCycle()
}

// Met à jour l'affichage des specs audio
export function updateAudioSpecs(specs) {
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
    stopBitPerfectAnimation()
    container.classList.add('resampled')
    console.log(`🔄 Resampled: ${specs.source_sample_rate}Hz → ${specs.output_sample_rate}Hz`)
  } else {
    container.classList.add('bit-perfect')
    console.log(`✓ Bit-perfect: ${specs.source_sample_rate}Hz/${specs.source_bit_depth}bit`)
    startBitPerfectAnimation()
  }
}

// Reset du moniteur audio specs
export function resetAudioSpecs() {
  stopBitPerfectAnimation()
  const container = document.getElementById('audio-specs')
  const sourceEl = document.getElementById('source-specs')
  const outputEl = document.getElementById('output-specs')

  if (container) container.classList.remove('bit-perfect', 'mismatch', 'resampled')
  if (sourceEl) sourceEl.textContent = '-'
  if (outputEl) outputEl.textContent = '-'
}

// === COVER ART ===

// Met à jour la pochette du player (utilisé par les transitions gapless)
export async function updateCoverArt(track) {
  if (!track) return

  let cover = caches.coverCache.get(track.path)
  if (cover === undefined) {
    try {
      cover = await invoke('get_cover', { path: track.path })

      if (!cover && track.metadata) {
        cover = await invoke('fetch_internet_cover', {
          artist: track.metadata.artist || 'Unknown Artist',
          album: track.metadata.album || 'Unknown Album'
        })
      }
    } catch (e) {
      console.error('[PLAYBACK] Error loading cover art:', e)
      cover = null
    }

    caches.coverCache.set(track.path, cover)
  }

  if (isValidImageSrc(cover)) {
    const img = document.createElement('img')
    img.src = cover
    img.onerror = () => {
      dom.coverArtEl.innerHTML = '<div class="cover-placeholder">♪</div>'
    }
    dom.coverArtEl.innerHTML = ''
    dom.coverArtEl.appendChild(img)
  } else {
    dom.coverArtEl.innerHTML = '<div class="cover-placeholder">♪</div>'
  }
}

// === LISTENERS ÉVÉNEMENTS AUDIO RUST ===
// Ces événements sont émis par le moteur Rust

export async function initRustAudioListeners() {
  // Progression de lecture (émis ~10 fois par seconde par Rust)
  await listen('playback_progress', (event) => {
    const { position, duration } = event.payload

    // Met à jour les variables globales
    playback.audioPositionFromRust = position
    playback.audioDurationFromRust = duration

    // Synchronise l'interpolation avec la position Rust
    syncToRustPosition(position)

    // Met à jour la durée (ne change pas souvent)
    dom.durationEl.textContent = formatTime(duration)

    // NOTE: Ne PAS réactiver isSeekingUI ici !
    // Le timeout de performSeek() (150ms) gère la réactivation.
    // Réactiver ici causait un bug où le curseur revenait en arrière
    // car l'interpolation redémarrait trop tôt (~3ms au lieu de 150ms).

    // Marque qu'on n'est pas en pause (on reçoit des updates)
    playback.isPausedFromRust = false

    // Filet de sécurité : redémarre la boucle RAF si elle a été stoppée
    if (!playback.interpolationAnimationId) {
      startPositionInterpolation()
    }

    // Gapless: preload next track when < 10s remaining
    const remaining = duration - position
    if (remaining > 0 && remaining < 10 && !playback.gaplessPreloadTriggered && playback.audioIsPlaying) {
      playback.gaplessPreloadTriggered = true
      triggerGaplessPreload()
    }
  })

  // Seeking en cours (émis par Rust quand un seek démarre)
  await listen('playback_seeking', (event) => {
    const targetPosition = event.payload
    playback.isSeekingUI = true
    playback.seekTargetPosition = targetPosition  // Met à jour la cible pour syncToRustPosition

    // Met à jour l'UI immédiatement avec la position cible
    playback.lastRustPosition = targetPosition
    playback.lastRustTimestamp = performance.now()
    playback.lastDisplayedPosition = targetPosition

    if (playback.audioDurationFromRust > 0) {
      const percent = (targetPosition / playback.audioDurationFromRust) * 100
      dom.progressBar.value = Math.min(percent, 100)
      dom.currentTimeEl.textContent = formatTime(targetPosition)
      updateProgressBarStyle(percent)
    }

    // Timeout de sécurité : si Rust ne confirme pas dans 2s, réactive l'interpolation
    if (playback.seekTimeoutId) clearTimeout(playback.seekTimeoutId)
    playback.seekTimeoutId = setTimeout(() => {
      if (playback.isSeekingUI) {
        console.log('[Seek] Safety timeout from playback_seeking event')
        playback.isSeekingUI = false
      }
    }, 2000)
  })

  // Pause/Resume depuis Rust - synchronise l'état global
  await listen('playback_paused', () => {
    playback.isPausedFromRust = true
    playback.audioIsPlaying = false
    dom.playPauseBtn.textContent = '▶'
    // Stoppe la boucle RAF pour économiser le CPU
    stopPositionInterpolation()
  })

  await listen('playback_resumed', () => {
    playback.isPausedFromRust = false
    playback.audioIsPlaying = true
    dom.playPauseBtn.textContent = '⏸'
    // Re-synchronise le timestamp pour éviter un saut
    playback.lastRustTimestamp = performance.now()
    // Redémarre la boucle RAF
    startPositionInterpolation()
  })

  // Fin de lecture (émis par Rust quand le track est terminé)
  await listen('playback_ended', () => {
    console.log('Rust: playback_ended - transitioning to next track')

    // IMPORTANT: Sauvegarder l'index AVANT toute modification d'état
    const indexToRepeat = playback.currentTrackIndex

    // Marque la fin de lecture AVANT la transition
    playback.audioIsPlaying = false
    playback.isPausedFromRust = false

    // Reset immédiat de l'UI pour la transition
    resetPlayerUI()

    // Stoppe la boucle RAF (sera redémarrée par playTrack si nécessaire)
    stopPositionInterpolation()

    // Petit délai pour laisser Rust nettoyer son état avant de lancer la suite
    setTimeout(() => {
      // Gère repeat et next track
      if (playback.repeatMode === 'one' && indexToRepeat >= 0 && indexToRepeat < library.tracks.length) {
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
    playback.gaplessPreloadTriggered = false

    // Advance to the next track in the UI (without calling playTrack)
    if (queue.items.length > 0) {
      const nextTrack = queue.items.shift()
      const globalIndex = library.tracks.findIndex(t => t.path === nextTrack.path)
      if (globalIndex !== -1) {
        playback.currentTrackIndex = globalIndex
        app.updateQueueDisplay()
        app.updateQueueIndicators()
      }
    } else if (playback.repeatMode === 'one') {
      // Stay on same track, just reset position display
    } else {
      // Advance to next track in album order
      const currentTrack = library.tracks[playback.currentTrackIndex]
      if (currentTrack) {
        const currentFolder = currentTrack.path.substring(0, currentTrack.path.lastIndexOf('/'))
        const albumTracks = library.tracks.filter(t => {
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
          const globalIndex = library.tracks.findIndex(t => t.path === nextTrack.path)
          if (globalIndex !== -1) playback.currentTrackIndex = globalIndex
        } else if (playback.repeatMode === 'all' && albumTracks.length > 0) {
          const globalIndex = library.tracks.findIndex(t => t.path === albumTracks[0].path)
          if (globalIndex !== -1) playback.currentTrackIndex = globalIndex
        }
      }
    }

    // Update the UI with the new track info
    const track = library.tracks[playback.currentTrackIndex]
    if (track) {
      if (dom.trackNameEl) dom.trackNameEl.textContent = track.metadata?.title || track.name
      if (dom.trackFolderEl) dom.trackFolderEl.textContent = track.metadata?.artist || track.folder

      // Update duration
      playback.audioDurationFromRust = track.metadata?.duration || 0
      dom.durationEl.textContent = formatTime(playback.audioDurationFromRust)

      // Reset position
      playback.audioPositionFromRust = 0
      playback.lastRustPosition = 0
      playback.lastRustTimestamp = performance.now()
      playback.lastDisplayedPosition = 0

      // Update cover
      updateCoverArt(track)
      app.updateNowPlayingHighlight()
      app.updateHomeNowPlayingSection()

      // Record play
      invoke('record_play', {
        path: track.path,
        artist: track.metadata?.artist || 'Unknown Artist',
        album: track.metadata?.album || '',
        title: track.metadata?.title || track.name
      }).then(() => app.invalidateHomeCache()).catch(() => {})
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
    if (AUTO_SKIP_ERRORS.has(code) && playback.audioIsPlaying) {
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

// === REPEAT BUTTON UI ===

// Met à jour l'UI du bouton repeat selon le mode actuel
export function updateRepeatButtonUI() {
  if (!dom.repeatBtn) return

  if (playback.repeatMode === 'all') {
    dom.repeatBtn.classList.add('active')
    dom.repeatBtn.textContent = '⟳'
    dom.repeatBtn.title = 'Repeat all'
  } else if (playback.repeatMode === 'one') {
    dom.repeatBtn.classList.add('active')
    dom.repeatBtn.textContent = '⟳₁'
    dom.repeatBtn.title = 'Repeat one'
  } else {
    dom.repeatBtn.classList.remove('active')
    dom.repeatBtn.textContent = '⟳'
    dom.repeatBtn.title = 'Repeat'
  }
}

// === VOLUME ICON ===

export function updateVolumeIcon(volume) {
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

function stopDevicePolling() {
  if (playback.devicePollingInterval) {
    clearInterval(playback.devicePollingInterval)
    playback.devicePollingInterval = null
  }
}

function startDevicePolling() {
  stopDevicePolling()
  playback.devicePollingInterval = setInterval(async () => {
    if (!dom.audioOutputMenu.classList.contains('hidden')) {
      await loadAudioDevices()
    } else {
      stopDevicePolling()
    }
  }, 3000)
}

// Charge la liste des périphériques audio
export async function loadAudioDevices() {
  console.log('[AUDIO-OUTPUT] Loading audio devices (with refresh)...')
  try {
    const devices = await invoke('refresh_audio_devices')
    console.log('[AUDIO-OUTPUT] Available devices:', devices)

    const currentDevice = await invoke('get_current_audio_device')
    console.log('[AUDIO-OUTPUT] Current device:', currentDevice)

    playback.currentAudioDeviceId = currentDevice?.id || null

    dom.audioOutputList.innerHTML = ''

    for (const device of devices) {
      const item = document.createElement('button')
      item.className = `audio-output-item${device.id === playback.currentAudioDeviceId ? ' active' : ''}`
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
      dom.audioOutputList.appendChild(item)
    }
  } catch (e) {
    console.error('[AUDIO-OUTPUT] Error loading devices:', e)
    console.error('[AUDIO-OUTPUT] Error details:', JSON.stringify(e, null, 2))
    dom.audioOutputList.innerHTML = `<div style="padding: 16px; color: #ff6b6b;">Error: ${escapeHtml(e?.message || e || 'Audio engine not initialized')}</div>`
  }
}

// Sélectionne un périphérique audio
export async function selectAudioDevice(deviceId, deviceName) {
  console.log('[AUDIO-OUTPUT] Selecting device:', deviceId, deviceName)
  console.log('[AUDIO-OUTPUT] Previous device was:', playback.currentAudioDeviceId)

  // Ne fait rien si c'est déjà le device actif
  if (deviceId === playback.currentAudioDeviceId) {
    console.log('[AUDIO-OUTPUT] Already on this device, skipping')
    dom.audioOutputMenu.classList.add('hidden')
    dom.audioOutputBtn.classList.remove('active')
    return
  }

  // Ferme le menu immédiatement
  dom.audioOutputMenu.classList.add('hidden')
  dom.audioOutputBtn.classList.remove('active')

  try {
    console.log('[AUDIO-OUTPUT] Calling set_audio_device...')
    await invoke('set_audio_device', { deviceId })
    console.log('[AUDIO-OUTPUT] Device preference changed successfully')

    const previousDeviceId = playback.currentAudioDeviceId
    playback.currentAudioDeviceId = deviceId

    // Met à jour l'affichage
    dom.audioOutputList.querySelectorAll('.audio-output-item').forEach(item => {
      item.classList.toggle('active', item.dataset.deviceId === deviceId)
    })

    // Si de la musique joue ou était en pause, relance la lecture sur le nouveau device
    // Note: Le backend CPAL utilise toujours le device par défaut système, donc on doit
    // forcer une relance pour que le changement prenne effet via prepare_for_streaming()
    const wasPlaying = playback.audioIsPlaying || !playback.isPausedFromRust
    if (playback.currentTrackIndex >= 0 && library.tracks[playback.currentTrackIndex]) {
      const currentTrack = library.tracks[playback.currentTrackIndex]
      console.log('[AUDIO-OUTPUT] Restarting playback on new device...', { wasPlaying, audioIsPlaying: playback.audioIsPlaying, isPausedFromRust: playback.isPausedFromRust })
      showToast(`Output: ${deviceName}`)

      // Sauvegarde la position actuelle (utilise le slider comme référence fiable)
      const progressSlider = document.getElementById('progress')
      let currentPosition = playback.audioPositionFromRust
      if (progressSlider && playback.audioDurationFromRust > 0) {
        currentPosition = (parseFloat(progressSlider.value) / 100) * playback.audioDurationFromRust
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
        if (!wasPlaying || playback.isPausedFromRust) {
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

// Charge l'état du mode exclusif avec status détaillé
export async function loadExclusiveMode() {
  console.log('[AUDIO-OUTPUT] Loading exclusive mode state...')
  try {
    const status = await invoke('hog_mode_status')
    console.log('[AUDIO-OUTPUT] Hog Mode status:', status)
    dom.exclusiveModeCheckbox.checked = status.enabled
    updateHogModeStatus(status)
  } catch (e) {
    console.error('[AUDIO-OUTPUT] Error loading exclusive mode:', e)
    // Fallback à l'ancien check simple
    try {
      const isExclusive = await invoke('is_exclusive_mode')
      dom.exclusiveModeCheckbox.checked = isExclusive
      updateHogModeStatus(isExclusive)
    } catch (_) {}
  }
}

// Met à jour l'affichage du statut Hog Mode
// Accepte un objet HogModeStatus ou un booléen (rétro-compatibilité)
export function updateHogModeStatus(statusOrBool) {
  const statusEl = document.getElementById('hog-mode-status')
  if (!statusEl) return

  if (typeof statusOrBool === 'boolean') {
    statusEl.textContent = statusOrBool ? 'Active' : 'Disabled'
    statusEl.classList.toggle('active', statusOrBool)
    return
  }

  const status = statusOrBool
  if (status.enabled && status.owned_by_us) {
    statusEl.textContent = status.device_name ? `Active · ${status.device_name}` : 'Active'
    statusEl.classList.add('active')
    statusEl.classList.remove('conflict')
  } else if (status.owner_pid !== -1 && !status.owned_by_us) {
    statusEl.textContent = `Locked (PID ${status.owner_pid})`
    statusEl.classList.remove('active')
    statusEl.classList.add('conflict')
  } else {
    statusEl.textContent = 'Disabled'
    statusEl.classList.remove('active', 'conflict')
  }
}

// Initialise le tooltip Hog Mode (portaled to body for no-clip)
export function initHogModeTooltip() {
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

// === INITIALISATION ===

// Wire all playback-related DOM event listeners
export function initPlayback() {
  // === Play / Pause ===
  dom.playPauseBtn.addEventListener('click', togglePlay)

  // === Previous / Next ===
  dom.prevBtn.addEventListener('click', playPreviousTrack)
  dom.nextBtn.addEventListener('click', () => {
    playNextTrack()
  })

  // === Cover Art click → navigate to album ===
  dom.coverArtEl.addEventListener('click', () => {
    // Si on était en train de drag, ne pas naviguer
    if (isDragging()) return

    if (!playback.currentPlayingAlbumKey || playback.currentTrackIndex < 0) return

    const album = library.albums[playback.currentPlayingAlbumKey]
    if (!album) {
      console.log('Album not found for key:', playback.currentPlayingAlbumKey)
      return
    }

    // Navigue vers la page album dédiée
    app.navigateToAlbumPage(playback.currentPlayingAlbumKey)
  })

  // === Drag from Cover Art → add current track to playlist ===
  dom.coverArtEl.addEventListener('mousedown', (e) => {
    if (playback.currentTrackIndex < 0) return

    const currentTrack = library.tracks[playback.currentTrackIndex]
    if (!currentTrack) return

    app.prepareCustomDrag(e, currentTrack, dom.coverArtEl)
  })

  // === Right-click on Cover Art → context menu for current track ===
  dom.coverArtEl.addEventListener('contextmenu', (e) => {
    if (playback.currentTrackIndex < 0) return
    const currentTrack = library.tracks[playback.currentTrackIndex]
    if (!currentTrack) return
    e.preventDefault()
    app.showContextMenu(e, currentTrack, playback.currentTrackIndex)
  })

  // === Progress Bar (seek) ===

  // mousedown = début de l'interaction (clic ou drag)
  dom.progressBar.addEventListener('mousedown', (e) => {
    playback.isUserDragging = true
    playback.isSeekingUI = true  // Bloque l'interpolation pendant l'interaction
    playback.seekPending = false  // Reset le flag de seek
  })

  // input = pendant le drag OU clic direct (mise à jour VISUELLE)
  dom.progressBar.addEventListener('input', () => {
    const duration = getCurrentTrackDuration()
    if (duration > 0) {
      const time = (dom.progressBar.value / 100) * duration
      // Met à jour UNIQUEMENT l'affichage visuel
      dom.currentTimeEl.textContent = formatTime(time)
      updateProgressBarStyle(dom.progressBar.value)
      // PAS de seek ici pour éviter le flood !
    }
  })

  // mouseup = fin de l'interaction → effectue le seek
  // Note: On utilise mouseup sur le document car l'utilisateur peut relâcher en dehors du slider
  document.addEventListener('mouseup', (e) => {
    if (!playback.isUserDragging) return
    playback.isUserDragging = false

    // Effectue le seek
    performSeek()
  })

  // change = backup pour les clics directs (certains navigateurs l'émettent)
  dom.progressBar.addEventListener('change', () => {
    // Si on est encore en mode dragging, mouseup va s'en occuper
    if (playback.isUserDragging) return

    // Sinon, effectue le seek (cas d'un clic sans mouseup détecté)
    if (!playback.seekPending) {
      playback.isSeekingUI = true
      performSeek()
    }
  })

  // === Shuffle ===
  dom.shuffleBtn.addEventListener('click', () => {
    // Reset l'historique des tracks joués à chaque changement de mode
    playback.shufflePlayedTracks.clear()

    // Cycle : off → album → library → off
    if (playback.shuffleMode === 'off') {
      playback.shuffleMode = 'album'
      dom.shuffleBtn.classList.add('active')
      dom.shuffleBtn.textContent = '⤮ᴬ'
      dom.shuffleBtn.title = 'Shuffle (Album)'
    } else if (playback.shuffleMode === 'album') {
      playback.shuffleMode = 'library'
      dom.shuffleBtn.textContent = '⤮∞'
      dom.shuffleBtn.title = 'Shuffle (Library)'
    } else {
      playback.shuffleMode = 'off'
      dom.shuffleBtn.classList.remove('active')
      dom.shuffleBtn.textContent = '⤮'
      dom.shuffleBtn.title = 'Shuffle'
    }
  })

  // === Repeat ===
  dom.repeatBtn.addEventListener('click', () => {
    // Cycle : off → all → one → off
    if (playback.repeatMode === 'off') {
      playback.repeatMode = 'all'
    } else if (playback.repeatMode === 'all') {
      playback.repeatMode = 'one'
    } else {
      playback.repeatMode = 'off'
    }
    updateRepeatButtonUI()
  })

  // === Volume ===
  dom.volumeBar.addEventListener('input', async () => {
    const volume = dom.volumeBar.value / 100
    playback.currentVolume = volume

    // Volume via Rust only
    try {
      await invoke('audio_set_volume', { volume })
    } catch (e) {
      console.error('audio_set_volume error:', e)
    }

    updateVolumeIcon(volume)
    if (volume > 0) playback.lastVolume = dom.volumeBar.value
  })

  dom.volumeBtn.addEventListener('click', async () => {
    if (playback.currentVolume > 0) {
      // Mute
      playback.lastVolume = dom.volumeBar.value
      dom.volumeBar.value = 0
      playback.currentVolume = 0

      try {
        await invoke('audio_set_volume', { volume: 0.0 })
      } catch (e) {
        console.error('audio_set_volume error:', e)
      }

      updateVolumeIcon(0)
    } else {
      // Unmute
      dom.volumeBar.value = playback.lastVolume
      playback.currentVolume = playback.lastVolume / 100

      try {
        await invoke('audio_set_volume', { volume: playback.currentVolume })
      } catch (e) {
        console.error('audio_set_volume error:', e)
      }

      updateVolumeIcon(playback.currentVolume)
    }
  })

  // === Audio Output selector ===

  // Toggle le menu de sélection audio
  dom.audioOutputBtn.addEventListener('click', async (e) => {
    e.stopPropagation()

    if (dom.audioOutputMenu.classList.contains('hidden')) {
      // Ouvre le menu et charge les devices
      await loadAudioDevices()
      await loadExclusiveMode()
      dom.audioOutputMenu.classList.remove('hidden')
      startDevicePolling()
      dom.audioOutputBtn.classList.add('active')
    } else {
      // Ferme le menu
      dom.audioOutputMenu.classList.add('hidden')
      dom.audioOutputBtn.classList.remove('active')
      stopDevicePolling()
    }
  })

  // Ferme le menu au clic ailleurs
  document.addEventListener('click', (e) => {
    if (!dom.audioOutputMenu.classList.contains('hidden') &&
        !dom.audioOutputMenu.contains(e.target) &&
        e.target !== dom.audioOutputBtn) {
      dom.audioOutputMenu.classList.add('hidden')
      dom.audioOutputBtn.classList.remove('active')
      stopDevicePolling()
    }
  })

  // Toggle le mode exclusif (Hog Mode)
  dom.exclusiveModeCheckbox.addEventListener('change', async () => {
    const newState = dom.exclusiveModeCheckbox.checked
    console.log('[AUDIO-OUTPUT] Toggling exclusive mode to:', newState)
    console.log('[AUDIO-OUTPUT] Current device ID:', playback.currentAudioDeviceId)
    console.log('[AUDIO-OUTPUT] Audio is currently playing:', playback.audioIsPlaying)

    try {
      console.log('[AUDIO-OUTPUT] Calling set_exclusive_mode...')
      await invoke('set_exclusive_mode', { enabled: newState })
      console.log('[AUDIO-OUTPUT] Exclusive mode changed successfully')

      // Met à jour le statut visuel (player + settings synchronisés)
      app.updateHogModeUI(newState)

      // Récupère le status détaillé après le changement
      let status = null
      try { status = await invoke('hog_mode_status') } catch (_) {}

      if (newState) {
        const deviceLabel = status?.device_name || ''
        // Le Hog Mode nécessite de relancer la lecture pour prendre effet
        if (playback.audioIsPlaying && playback.currentTrackIndex >= 0) {
          showToast(`Exclusive mode on ${deviceLabel} — Restarting playback...`)
          const currentTrack = library.tracks[playback.currentTrackIndex]
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
          showToast(`Exclusive mode enabled${deviceLabel ? ` · ${deviceLabel}` : ''} (bit-perfect)`)
        }
      } else {
        showToast('Exclusive mode disabled — shared audio restored')
      }

      // Met à jour le statut détaillé
      if (status) updateHogModeStatus(status)
    } catch (e) {
      console.error('[AUDIO-OUTPUT] Error changing exclusive mode:', e)
      // Revert le checkbox et le statut
      dom.exclusiveModeCheckbox.checked = !newState
      app.updateHogModeUI(!newState)
      // Message d'erreur descriptif
      const errMsg = typeof e === 'string' ? e : (e.message || 'Unknown error')
      if (errMsg.includes('locked') || errMsg.includes('PID')) {
        showToast('Device locked by another app — close it first')
      } else {
        showToast('Exclusive mode failed — check that no other app uses the DAC')
      }
    }
  })

  // === Rust audio event listeners ===
  initRustAudioListeners()

  // === Hog Mode tooltip ===
  initHogModeTooltip()

  // === Register in app mediator ===
  app.playTrack = playTrack
  app.playAlbum = playAlbum
  app.togglePlay = togglePlay
  app.playNextTrack = playNextTrack
  app.playPreviousTrack = playPreviousTrack
  app.resetPlayerUI = resetPlayerUI
  app.getCurrentTrackDuration = getCurrentTrackDuration
  app.triggerGaplessPreload = triggerGaplessPreload
}
