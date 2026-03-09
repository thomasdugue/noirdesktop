# NOIR DESKTOP — Specifications Techniques et Fonctionnelles Completes

> **Mise a jour** : 8 mars 2026 — basee sur l'analyse complete du code source (branche `feat/player-redesign-lyrics`)
> **Remplace** : NOIR_DESKTOP_SPEC.md du 20 fevrier 2026

---

## 1. Vue d'ensemble

**Noir** est un lecteur de musique audiophile pour macOS, construit avec **Tauri 2** (backend Rust + frontend HTML/CSS/JS vanilla). L'application privilegie la lecture bit-perfect, le demarrage instantane et une interface sombre optimisee pour les longues sessions d'ecoute.

| Propriete | Valeur |
|---|---|
| **Identifiant** | `com.tdugue.noir` |
| **Framework** | Tauri 2 |
| **Backend** | Rust (~11 100 lignes) |
| **Frontend** | HTML5 + CSS3 + JavaScript vanilla ES6 modules (~13 950 lignes JS, ~7 800 lignes CSS) |
| **Plateforme cible** | macOS (CoreAudio natif) |
| **Fenetre par defaut** | 1200x800px (min 320x400), transparente, titlebar overlay |
| **Typographie** | Geist Mono (variable, monospace, WOFF2) |
| **Version** | 0.1.0 |
| **Total code** | ~25 050 lignes |

---

## 2. Architecture globale

### 2.1 Schema general

```
+-----------------------------------------------------+
|                    FRONTEND (13 950 LOC)             |
|  18 modules ES6 + index.html + styles.css (7 813 l) |
|  Communication via Tauri IPC (invoke/listen)         |
+------------------------+----------------------------+
                         | 82 commandes Tauri
+------------------------v----------------------------+
|              BACKEND RUST (11 100 LOC)               |
|  lib.rs (4 421 l.) - Orchestrateur + 82 commandes   |
|  +------------------------------------------------+ |
|  |           MODULE AUDIO                         | |
|  |  audio_engine.rs (1 055 l.)  - Moteur lecture  | |
|  |  audio_decoder.rs (908 l.)   - Decodage        | |
|  |  resampler.rs (172 l.)       - Reechantillonnage| |
|  |  eq.rs (234 l.)              - EQ 8 bandes     | |
|  |  media_controls.rs (136 l.)  - Media keys macOS| |
|  |  audio/backend.rs (184 l.)   - Trait abstrait   | |
|  |  audio/coreaudio_backend.rs (1 276 l.) - HAL   | |
|  |  audio/coreaudio_stream.rs (667 l.)  - Stream  | |
|  |  audio/types.rs (148 l.)     - Types partages   | |
|  |  audio/error.rs (52 l.)      - Types d'erreur   | |
|  |  audio/stream.rs (118 l.)    - Trait stream     | |
|  |  audio/mod.rs (51 l.)        - Module exports   | |
|  +------------------------------------------------+ |
|  |           MODULE RESEAU (NAS/SMB)              | |
|  |  network/mod.rs (155 l.)     - Types reseau     | |
|  |  network/scanner.rs (810 l.) - Scan differentiel| |
|  |  network/smb.rs (546 l.)     - Client SMB       | |
|  |  network/credentials.rs (95 l.) - Keychain      | |
|  |  network/discovery.rs (85 l.) - mDNS/Bonjour   | |
|  +------------------------------------------------+ |
+-----------------------------------------------------+
              macOS CoreAudio HAL -> DAC -> Sortie audio
```

### 2.2 Modules frontend

| Module | Lignes | Responsabilite |
|---|---|---|
| **renderer.js** | 910 | Orchestrateur : enregistrement modules sur `app`, settings panel, sidebar resize, init() |
| **app.js** | 111 | **Mediateur** : ~95 slots remplis a l'init — empeche les dependances circulaires entre modules |
| **state.js** | 211 | **Etat centralise** : 9 objets mutables partages par reference (playback, library, ui, queue, sort, caches, favorites, contextMenu, dom) |
| **views.js** | 3 098 | Rendu vues : home, albums/artists grids, album/artist/mix detail, virtual scroll, transitionView async |
| **playback.js** | 2 056 | Audio : play/pause/seek/volume, gapless preload, interpolation 60fps, device switching, AirPlay |
| **panels.js** | 1 352 | Queue panel, track info (edition inline), context menus, bulk edit modal, queue indicators |
| **playlists.js** | 1 495 | Playlists CRUD, favoris, add-to-playlist, export/import M3U, thumbnails mosaic, sidebar rendering |
| **library.js** | 934 | Covers lazy-loading (IntersectionObserver), metadata, scan listeners, indexation UI |
| **network.js** | 882 | NAS/SMB : decouverte mDNS, browse shares, connexion, auto-reconnect, credentials session |
| **fullscreen-player.js** | 420 | Vue immersive : particle system (3 phases), cover canvas, metadata, controls sync |
| **shortcuts.js** | 570 | Raccourcis clavier locaux (configurables) + media keys globaux (souvlaki) |
| **eq.js** | 392 | EQ panel UI : 8 bandes parametriques, courbe SVG interactive, presets, toggle |
| **search.js** | 337 | Index inverse, scoring multi-mots, debounce 200ms, panel resultats |
| **feedback.js** | 232 | Bouton flottant + modal (bug/feature/ux), severite, soumission GitHub Issues |
| **lyrics.js** | 285 | Panel paroles (lrclib.net + lyrics.ovh fallback), sync playback, overlay fullscreen |
| **drag.js** | 209 | Drag custom (HTML5 casse dans Tauri WebView), album/track drag, drop zones playlists |
| **utils.js** | 350 | Utilitaires : showToast, formatTime, formatQuality, escapeHtml, responsive helpers, particle canvas |
| **auto-update.js** | 103 | Auto-update via Tauri updater plugin, version check, bouton install |

### 2.3 Pattern mediateur (app.js)

Chaque module exporte ses fonctions et les enregistre sur l'objet `app` dans `renderer.js` :

```
module.fn → app.fn → autre module
```

Cela evite les imports circulaires : aucun module n'importe directement un autre module. Tous communiquent via `app`.

### 2.4 Etat centralise (state.js)

9 objets mutables partages **par reference** :

| Objet | Contenu |
|---|---|
| `playback` | currentTrackIndex, audioIsPlaying, volume, shuffle/repeat modes, gaplessPreloadTriggered, playbackContext |
| `library` | tracks[], albums{}, artists{}, tracksByPath Map, trackAddedDates{} |
| `ui` | currentView, selectedAlbumKey, isQueuePanelOpen, isTrackInfoPanelOpen, isSettingsPanelOpen, isLyricsPanelOpen, tracksViewOrder[], navigationHistory[] |
| `queue` | items[] |
| `search` | query, invertedIndex Map |
| `sort` | column, direction, albumSortMode |
| `caches` | coverCache Map, thumbnailCache Map, homeDataCache{}, HOME_CACHE_TTL |
| `favorites` | tracks Set |
| `contextMenu` | tracks[], trackIndex |
| `dom` | 25+ references DOM cachees |

**Regle critique** : ne JAMAIS reassigner ces objets (`state.library = {...}` interdit). Toujours muter les proprietes (`library.tracks.length = 0; library.tracks.push(...)`).

### 2.5 Fichiers backend Rust

| Fichier | Lignes | Role |
|---|---|---|
| **lib.rs** | 4 421 | Orchestrateur : 82 commandes Tauri, caches globaux, scan, metadata, covers |
| **audio_engine.rs** | 1 055 | Moteur de lecture, device switching, gapless state, preload |
| **audio_decoder.rs** | 908 | Decodage Symphonia, RingBuffer, seeking, resampling pipeline |
| **audio/coreaudio_backend.rs** | 1 276 | HAL macOS : enumeration devices, sample rate, hog mode, AirPlay |
| **audio/coreaudio_stream.rs** | 667 | AudioUnit render callback, EQ, volume, gapless transitions |
| **network/scanner.rs** | 810 | Scan differentiel NAS, progressive download, metadata SMB |
| **network/smb.rs** | 546 | Client SMB (pavao), connexion singleton, browse shares |
| **eq.rs** | 234 | EQ 8 bandes biquad IIR |
| **audio/backend.rs** | 184 | Trait AudioBackend (abstraction plateforme) |
| **resampler.rs** | 172 | Resampler FFT (Rubato, chunks 1024) |
| **network/mod.rs** | 155 | Types reseau (NetworkSource, SmbCredentials, etc.) |
| **audio/types.rs** | 148 | DeviceInfo, HogModeStatus, StreamConfig |
| **media_controls.rs** | 136 | MPRemoteCommandCenter (media keys macOS) |
| **audio/stream.rs** | 118 | Trait AudioOutputStream |
| **network/credentials.rs** | 95 | macOS Keychain + password cache session |
| **network/discovery.rs** | 85 | mDNS/Bonjour (_smb._tcp.local.) |
| **audio/error.rs** | 52 | AudioBackendError enum |
| **audio/mod.rs** | 51 | Module exports |
| **main.rs** | 7 | Point d'entree |

---

## 3. Chaine audio complete

### 3.1 Pipeline de lecture

```
Fichier audio (local ou SmbProgressiveFile)
    |
Symphonia Decoder (double-probe avec Lofty fallback pour M4A/AAC)
    | f32 interleaved
[Resampler Rubato FFT] <- seulement si le DAC ne supporte pas le sample rate source
    |
RingBuffer lock-free (5 secondes de capacite, HeapRb<f32>)
    | (consumer, thread temps-reel)
CoreAudio AudioUnit Callback
    | Egaliseur 8 bandes (biquad IIR, bypass si flat)
    | Application du volume (f32 x volume)
    | Calcul RMS (pour visualisation)
CoreAudio HAL -> DAC -> Enceintes/Casque
```

### 3.2 Formats supportes

| Format | Codec | Notes |
|---|---|---|
| FLAC | Symphonia | 16/24-bit, jusqu'a 384 kHz |
| WAV | Symphonia | PCM |
| AIFF | Symphonia | PCM |
| MP3 | Symphonia | CBR/VBR |
| AAC/M4A | Symphonia + Lofty fallback | Double-probe pour fiabilite |
| ALAC | Symphonia | Apple Lossless |
| Vorbis/OGG | Symphonia | |

**Formats intentionnellement absents** : DSD, Opus, MQA, WMA.

### 3.3 Lecture bit-perfect

1. Le moteur detecte le sample rate du fichier source
2. Tente de configurer le DAC au meme sample rate via `kAudioDevicePropertyNominalSampleRate`
3. **Si succes** : lecture bit-perfect (pas de resampling)
4. **Si echec** : fallback avec resampling FFT haute qualite (Rubato, chunks de 1024 samples)
5. **Exception AirPlay** : ne jamais changer le sample rate (casse la session reseau)

**Indicateur visuel** : effet "silver shine" sur les specs audio quand la lecture est bit-perfect.

### 3.4 Hog Mode (mode exclusif)

- Acces exclusif au peripherique audio via `kAudioDevicePropertyHogMode`
- Empeche les autres applications d'utiliser le DAC
- Liberation automatique a la fermeture (implementation `Drop`)
- Restauration automatique du sample rate original
- Gestion du changement de device pendant le Hog Mode (`hog_locked_device` flag)
- **Contraintes** : impossible sur AirPlay (auto-desactive lors du switch vers AirPlay)
- **Status detaille** : retourne PID proprietaire, nom device, `owned_by_us` flag

### 3.5 Seek instantane

| Etape | Detail |
|---|---|
| 1 | Frontend debounce 100ms |
| 2 | `audio_seek(time)` -> AudioEngine |
| 3 | Flag `seeking = true` (avant envoi commande) |
| 4 | `AudioUnitReset()` - flush du buffer interne CoreAudio (~50ms) |
| 5 | Symphonia seek + reset decodeur |
| 6 | Pre-remplissage 300ms dans le RingBuffer |
| 7 | `seeking = false` -> reprise de la sortie |
| **Latence totale** | **~200ms** |

### 3.6 Suivi de peripherique (Device Following)

- Detection automatique du changement de peripherique par defaut
- Hot-swap casque/DAC transparent
- Reconfiguration automatique du stream audio
- Aucune interruption perceptible de la lecture
- Fallback vers le device par defaut si le device manuel est debranche

### 3.7 AirPlay handling

| Aspect | Comportement |
|---|---|
| **Detection** | `kAudioDevicePropertyTransportType` == 0x61697270 |
| **Sample rate** | Ne jamais changer (casse la session reseau macOS) |
| **Hog mode** | Impossible (API echoue silencieusement), auto-desactive au switch vers AirPlay |
| **Session preservation** | Quand on quitte AirPlay, garder le device comme system default (sinon il disparait de CoreAudio) |
| **Cache session** | `airplay_session_devices` HashMap maintient les devices AirPlay en cache meme si CoreAudio les retire |
| **Stale detection** | `stale_airplay_ids` detecte les devices qui ne sont plus dans CoreAudio |
| **Device routing** | `get_device_id()` retourne None pour AirPlay -> AudioUnit utilise le system default |
| **Auto-retry** | 1.5s apres echec (delai d'activation du recepteur) |

### 3.8 Egaliseur 8 bandes

| Propriete | Valeur |
|---|---|
| **Type** | Biquad IIR (PeakingEQ) via crate `biquad 0.4` |
| **Bandes** | 32, 64, 250, 1k, 2k, 4k, 8k, 16 kHz |
| **Plage** | -12 dB a +12 dB par bande |
| **Q** | Butterworth (Q_BUTTERWORTH_F32) |
| **Topologie** | DirectForm1, cascade de 8 filtres |
| **Thread safety** | Gains partages via AtomicU32 (f32::to_bits), filtres locaux au callback |
| **Bypass** | Automatique quand gain = 0 dB (bit-perfect preserve) |
| **Latence** | Zero (lock-free, temps-reel) |
| **Persistance** | Etat sauvegarde dans settings.json |

**Presets predefinis** (11) : Flat, Bass Boost, Treble Boost, Loudness, Vocal, Rock, Jazz, Classical, Electronic, Hip-Hop, Late Night.

**UI** : Courbe SVG interactive avec 8 points draggables, selecteur de presets, toggle on/off. Accessible depuis le selecteur de sortie audio dans le player.

### 3.9 Gapless playback (lecture sans coupure)

| Aspect | Detail |
|---|---|
| **Pre-chargement local** | Piste N+1 preloadee via `audio_preload_next`, declenchee ~10s avant la fin |
| **Pre-chargement SMB** | Declenchee ~60s avant la fin (compense la latence reseau) |
| **Mecanisme** | Second consumer RingBuffer prepare pendant la lecture de N |
| **Detection fin** | 3+ callbacks vides + `decoding_complete` flag atomique |
| **Transition** | Swap instantane consumers + streaming_state + current_path Arc |
| **Seek-restart safety** | `current_path` Arc<Mutex<>> mis a jour lors de la transition (empeche re-probe de l'ancien fichier) |
| **Sample rate change** | Support du changement de sample rate entre pistes |
| **Toggle** | Activable/desactivable dans les parametres |

### 3.10 Media Controls (souvlaki / MPRemoteCommandCenter)

- Integration macOS `MPRemoteCommandCenter` via crate souvlaki (media_controls.rs, 136 lignes)
- Enregistre Noir comme "Now Playing" app via GCD
- **Callbacks** : Play, Pause, Next, Previous, Stop -> emettent event `media-control` vers le frontend
- **Metadata** : Titre, artiste, album mis a jour dans le Control Center/Lock Screen a chaque changement de piste
- **F7/F8/F9 absents** : intentionnellement non utilises (conflit avec Apple Music qui intercepte les media keys globales)

### 3.11 Progression UI

- Emission d'evenements de progression a **~100ms** depuis le callback audio (Rust)
- Interpolation cote frontend via `requestAnimationFrame` pour fluidite **60 FPS**
- `_lastGoodPosition` survit aux restarts de stream pendant les device switches (resilience AirPlay)
- `_seekCancelToken` annule les seeks perimees pendant les changements de device
- RAF stoppe quand la lecture est en pause (0% CPU au repos)

---

## 4. Gestion de la bibliotheque

### 4.1 Demarrage instantane

```
Lancement de l'app
    |
Chargement de tracks_cache.json (< 50ms)
    |
Affichage immediat de la bibliotheque
    | (en parallele, thread separe)
Scan en arriere-plan avec evenements de progression
    |
Emission du diff (pistes ajoutees/supprimees)
    | (conditionnel : shouldReload = new_tracks > 0 || removed_tracks > 0)
Enrichissement des genres (Deezer/MusicBrainz, optionnel)
    |
Mise a jour du cache
```

### 4.2 Scan de la bibliotheque

- **Parcours recursif** des dossiers configures (walkdir)
- **Chargement parallele des metadonnees** via Rayon (tous les coeurs CPU)
- **Double-probe** : Symphonia en premier, Lofty en fallback
- **Evenements de progression** emis tous les 10 fichiers vers le frontend
- Support de **plusieurs chemins de bibliotheque**
- Detection des chemins inaccessibles avec evenement `library_paths_inaccessible`
- **Exclusion de tracks** : `exclude_tracks_from_library` persiste dans `config.excluded_paths`

### 4.3 Metadonnees extraites

| Champ | Source |
|---|---|
| Titre | Tag ID3/Vorbis/MP4 |
| Artiste | Tag |
| Album | Tag |
| Numero de piste | Tag |
| Numero de disque | Tag |
| Annee | Tag |
| Genre | Tag + enrichissement Deezer/MusicBrainz |
| Duree | Probe audio |
| Bitrate | Probe audio |
| Sample rate | Probe audio |
| Bit depth | Probe audio (24-bit par defaut pour AAC) |
| Format/Codec | Extension fichier + probe |

### 4.4 Ecriture de metadonnees (write_metadata)

- Ecrit les tags via lofty::TaggedFile
- **Coherence critique** : met a jour a la fois `METADATA_CACHE` ET `TRACKS_CACHE` (sinon les mutations JS-side sont ecrasees par le cache perime au prochain `load_tracks_from_cache`)
- Persiste `TRACKS_CACHE` sur disque immediatement apres ecriture
- Validation de securite : verifie que le chemin est dans les library paths configures
- **Bulk edit** : edition sequentielle de N tracks, puis `groupTracksIntoAlbumsAndArtists()` + `displayCurrentView()` (toutes vues)

### 4.5 Normalisation des genres

- ~160 mappings de normalisation (ex: "Electro" -> "Electronic", "Hip Hop" -> "Hip-Hop")
- Enrichissement post-scan via Deezer API et MusicBrainz release-groups
- Evenements de progression dedies (`genre_enrichment_progress`, `genre_enrichment_complete`)

### 4.6 Pochettes d'album (Cover Art)

**Ordre de recherche :**
1. **Embedded** — extraite du fichier audio
2. **Cache local** — `~/.local/share/noir/covers/`
3. **Internet** — recherche automatique sur :
   - MusicBrainz (Cover Art Archive)
   - Deezer API
   - Wikimedia Commons (images d'artistes)

**Protocole custom `noir://`** :
- Les pochettes sont servies via `noir://localhost/covers/{hash}.ext`
- Les thumbnails via `noir://localhost/thumbnails/{hash}_thumb.jpg`
- Header `Cache-Control: max-age=31536000, immutable` pour cache navigateur
- Elimine le pipeline base64 : ~60 octets/album au lieu de ~700 KB/album

**Thumbnails :**
- Generees en batch (80x80 px, JPEG, filtre Triangle)
- Stockees dans `~/.local/share/noir/thumbnails/`
- Cache des recherches internet echouees (`internet_not_found_cache.json`, TTL 30 jours)
- Chargement asynchrone via IntersectionObserver (lazy loading)

**Fallback chain (frontend)** :
```
thumbnailCache -> coverCache -> get_cover_thumbnail (disque) -> get_cover (extraction audio) -> internet
```

### 4.7 Historique d'ecoute

- Stockage des **1 000 dernieres ecoutes**
- Donnees : piste, artiste, album, titre, horodatage (Unix seconds)
- Calcul des **top artistes** (par nombre d'ecoutes, avec album count)
- Calcul des **albums recemment joues** (par nombre de jours)
- Calcul de **tous les albums joues** (tries par play count)
- Calcul des **pistes jouees** (pour discovery mixes)
- Persiste dans `listening_history.json`

### 4.8 Statistiques de bibliotheque

- Nombre total de pistes, artistes, albums
- Repartition par format (MP3, FLAC 16-bit, FLAC 24-bit)
- Affichees dans le module d'indexation de la sidebar

### 4.9 Sources reseau (NAS/SMB)

#### Decouverte mDNS
- Broadcast mDNS `_smb._tcp.local.` pendant 5 secondes
- Emission d'evenements `nas_device_found` en temps reel
- Preference IPv4 sur IPv6
- UI : modal avec onglets "Decouvrir" et "Manuel"

#### Connexion SMB
- Client SMB2/3 via crate pavao (wrapper libsmbclient)
- **Singleton process-level** : un seul `SmbClient` peut exister simultanement
- `CONNECTION: Lazy<Mutex<Option<ActiveConnection>>>` partage par toutes les operations
- `ensure_connection_with_guard()` opere sur le MutexGuard deja acquis (empeche double-lock)

#### Scan differentiel
- Enumeration recursive des fichiers audio sur le share SMB (scanner.rs, 810 lignes)
- Cache par source : si taille + date de modification identiques, skip la relecture de metadata
- Extraction de metadata via lofty + extraction de covers embeddees
- Evenements de progression `scan_progress` tous les 10 fichiers

#### Progressive download
- `start_progressive_download(source, share, remote_path, cancel_previous)` spawne un thread OS
- Telecharge par chunks de 64 KB vers `~/.local/share/noir/smb_buffer/{hash}.tmp`
- Ecrit `bytes_written` + `done` flags dans le registre `PROGRESSIVE_DOWNLOADS`
- Annulation via `AtomicBool` flag -> le thread sort au prochain chunk
- Seuil de lecture : 4 MB (~111ms a 36 MB/s) avant demarrage du playback
- Timeout maximum : 15s, puis lecture du stream partiel

#### Gapless sur SMB
- `audio_preload_next` appelle le download avec `cancel_previous=false` (ne pas interrompre le download en cours)
- Attend 4 MB, puis preload dans le moteur audio
- Pre-declenchement a 60s de la fin (vs 10s pour les fichiers locaux)

#### Credentials macOS Keychain
- **Premier niveau** : cache memoire `PASSWORD_CACHE: Mutex<HashMap<String, String>>`
- **Deuxieme niveau** : macOS Keychain (dialogue une fois par source par session)
- **Protection demarrage a froid** : `has_password_in_session()` verifie le cache SANS toucher au Keychain
- Utilise dans `reconnect_network_source()` pour eviter les dialogues Keychain au demarrage

#### Auto-reconnexion
- `autoReconnectNetworkSources()` fire-and-forget (delai 1s apres init)
- Tentative silencieuse pour toutes les sources activees
- Echec silencieux : statut affiche "deconnecte", retry manuel possible
- Evenements : `network_source_connected`, `network_source_disconnected`

---

## 5. Systeme de playlists

| Fonctionnalite | Detail |
|---|---|
| Creation | Nom personnalise via modale |
| Renommage | Via menu contextuel ou double-clic |
| Suppression | Avec modale de confirmation |
| Ajout de pistes | Par track, par album, ou par selection multiple |
| Reordonnement des pistes | Drag & drop dans la vue playlist |
| Reordonnement des playlists | Drag & drop dans la sidebar |
| Favoris | Playlist systeme "mes favoris" (toggle coeur, Cmd+Shift+D) |
| Drag & drop | Glisser des pistes/albums vers une playlist dans la sidebar |
| Export M3U | Via menu contextuel, dialogue de sauvegarde natif |
| Import M3U | Via bouton dans la sidebar, creation automatique de playlist |
| Creation depuis album | Via menu contextuel d'un album |
| Persistance | `playlists.json` |

### 5.1 Thumbnails mosaic

| Nombre de covers | Rendu |
|---|---|
| 0 | Icone note de musique (placeholder) |
| 1 | Cover unique plein format |
| 2 | Deux covers cote a cote |
| 3-4 | Grille 2x2 (4e slot repete la 1re si seulement 3 covers) |

- **Chargement lazy** : `loadPlaylistThumbs(containerEl)` fire-and-forget
- **Fallback chain** : `thumbnailCache` -> `coverCache` -> `get_cover_thumbnail` (disque, cache-only) -> `get_cover` (extraction audio)
- **Animation** : fade-in sur chargement (opacity 0->1)

### 5.2 Favoris

- `favorites.tracks` : Set de chemins de fichiers
- **Comptage valide** : `getValidFavoritesCount()` fait l'intersection avec `library.tracksByPath` (exclut les chemins perimees)
- Toggle via Cmd+Shift+D ou menu contextuel
- Persistance cote Rust (playlist systeme `is_system: true`)

---

## 6. Systeme de file d'attente (Queue)

- File d'attente courante + pistes suivantes
- Affichage "Now Playing" + "Up Next" dans le panel
- Reordonnement par drag & drop
- Ajout via menu contextuel ou bouton dedie ("Play next", "Add to queue")
- Ajout d'albums entiers a la queue
- Suppression individuelle ou vidage complet
- Panel lateral dedie dans l'UI (toggle via bouton ou Cmd+Shift+L)
- Indicateur visuel sur les pistes en queue dans la liste (badge)
- Auto-scroll vers la piste courante a l'ouverture du panel
- Notification toast lors de l'ajout a la queue

---

## 7. Interface utilisateur

### 7.1 Layout general

```
+----------------------------------------------+
|  Titlebar macOS (zone de drag, 38px)    [Cog] |
+------------+---------------------------------+
|  Sidebar   |  Contenu principal              |
|  (280px    |                                 |
|  resize    |  - Barre de recherche (sticky)  |
|  180-400px)|  - Home / Albums / Artistes /   |
|            |    Pistes / Detail album /      |
|  - Nav     |    Detail artiste / Playlist /  |
|  - Playlists|    Discovery mix               |
|  - Module  |                                 |
|  indexation|                                 |
+------------+---------------------------------+
|  Player (barre fixe en bas, 100% largeur)    |
|  [Pochette] [Info] [Queue] [Progression]     |
|  [Shuffle] [Prev Play Next] [Repeat]         |
|  [Specs audio] [Volume] [Sortie + EQ]        |
+----------------------------------------------+
```

**Panels lateraux** (un seul ouvert a la fois) :
- Queue panel (droite, 320px)
- Track Info panel (droite, 400px)
- Settings panel (droite)
- EQ panel (dans le menu de sortie audio)
- Lyrics panel (droite)

**Modals** :
- Playlist modal (creer/renommer)
- Confirm modal (confirmation suppression)
- Feedback modal (bug/feature/ux report)
- Network discovery modal (decouverte NAS + browse shares)
- Bulk edit modal (edition metadonnees N tracks)

**Overlays plein ecran** :
- Fullscreen player (#fullscreen-player, z-index:10000, particle system)
- Fullscreen lyrics (#fs-lyrics-overlay)

### 7.2 Theme et design system

#### Variables CSS (29)

| Variable | Valeur | Usage |
|---|---|---|
| `--color-bg` | `#0a0a0a` | Fond principal |
| `--color-bg-light` | `#111` | Fond leger |
| `--color-bg-lighter` | `#151515` | Fond intermediaire |
| `--color-bg-surface` | `#1a1a1a` | Surfaces elevees |
| `--color-bg-hover` | `#222` | Etats hover |
| `--color-bg-active` | `#2a2a2a` | Etats actifs |
| `--color-bg-elevated` | `#333` | Bordures, elevation |
| `--color-bg-muted` | `#444` | Fond attenue |
| `--color-accent` | `#fff` | Accent principal |
| `--color-accent-hover` | `#ccc` | Accent hover |
| `--color-accent-muted` | `#888` | Accent attenue |
| `--color-text` | `#fff` | Texte principal |
| `--color-text-muted` | `#888` | Texte secondaire |
| `--color-text-dimmed` | `#666` | Texte tertiaire |
| `--color-text-faint` | `#555` | Texte desactive |
| `--color-border` | `#222` | Bordures |
| `--color-border-light` | `#333` | Bordures claires |
| `--color-border-muted` | `#444` | Bordures attenuees |
| `--color-error` | `#ff4444` | Erreurs |
| `--color-error-muted` | `#ff6b6b` | Erreurs secondaires |
| `--color-success` | `#fff` | Succes |
| `--radius-sm` | `2px` | Rayon petit |
| `--radius-md` | `6px` | Rayon moyen |
| `--radius-lg` | `8px` | Rayon grand |
| `--radius-xl` | `8px` | Rayon extra-large |
| `--transition-fast` | `0.15s ease` | Transitions rapides |
| `--transition-normal` | `0.2s ease` | Transitions normales |
| `--transition-slow` | `0.3s ease` | Transitions lentes |
| `--font-body` | `Geist Mono` | Typographie monospace |

**Caracteristiques visuelles :**
- Theme sombre integral, sans mode clair
- Police monospace (Geist Mono Variable, WOFF2, weight 100-900)
- Transitions ciblees (pas de `transition: all`)
- Sidebar style macOS avec resize handle
- Effet silver-shine sur l'indicateur bit-perfect (animation 15s)
- Animation SVG sine-wave sur la home (pausee hors vue)
- Grille d'albums/artistes responsive (auto-fill)
- Total CSS : **7 813 lignes**

#### Scrollbars

**Globales** : 8px width, thumb #333, hover #555, track transparent, border-radius 4px

**Carousels home page** (hover-only) :
- Par defaut : thumb transparent (invisible)
- Au hover du carousel : track `rgba(255,255,255,0.05)`, thumb `rgba(255,255,255,0.2)`
- Au hover du thumb : `rgba(255,255,255,0.35)`, active `rgba(255,255,255,0.45)`
- Hauteur : 6px, border-radius 3px

**Lyrics panel** : 4px width, thumb #222, border-radius 2px

### 7.3 Vues disponibles

| Vue | Contenu |
|---|---|
| **Accueil (Home)** | Resume Playback, Recently Played, Top Artists, Discovery Mixes |
| **Albums** | Grille de pochettes avec tri (artiste/album, asc/desc), scrollbar alphabetique |
| **Artistes** | Grille avec images d'artistes, scrollbar alphabetique, tri (nom asc/desc) |
| **Pistes** | Tableau triable par colonne (titre, artiste, album, qualite, duree), virtual scroll |
| **Detail album** | Liste de pistes + metadonnees + pochette grande taille |
| **Detail artiste** | Discographie groupee par album + image artiste + section loose tracks |
| **Playlist** | Liste de pistes de la playlist selectionnee |
| **Discovery mix** | Collection thematique de pistes (Recently Played, Top Artists, etc.) |
| **Fullscreen player** | Vue immersive avec particle system, cover, metadata, controles |
| **Fullscreen lyrics** | Overlay paroles synchronisees |

### 7.4 Page d'accueil (Home)

#### Sections affichees

1. **Resume Playback** — derniere piste jouee (1 item max, avec cover, titre, artiste)
2. **Recently Played** — grille responsive de tracks recentes (max 6 items)
   - 3 colonnes >= 768px, 2 colonnes 480-768px, 1 colonne < 480px
3. **Discovery Mixes** — carousel horizontal de 5 mixes thematiques generes automatiquement
4. **Top Artists** — carousel horizontal des 8 artistes les plus ecoutes

#### Cache hybrid bloquant/instantane

- **Cold cache** (premier affichage ou cache expire) : `await Promise.all(invokes Rust)` — fetch Recently Played, Discovery Mixes, Resume Playback
- **Warm cache** : lecture instantanee depuis `caches.homeDataCache`
- `HOME_CACHE_TTL = 30 * 60 * 1000` (30 minutes)
- Invalidation via `scan_complete` listener quand `shouldReload = true`

#### transitionView async

- `transitionView(renderFn)` est **async** et accepte des render functions async
- **renderVersion counter** : chaque appel incremente un compteur, annule les renders obsoletes
- Fade-out 130ms -> `await renderFn()` -> fade-in 200ms
- Si deja en transition : skip le fade-out, swap direct
- **Invariant** : `isTransitioning` revient a `false` dans TOUS les chemins de sortie

#### scan_complete conditionnel

```javascript
const shouldReload = new_tracks > 0 || removed_tracks > 0 ||
                     (library.tracks.length === 0 && stats.total_tracks > 0)
```

Le reload n'est declenche que si des changements ont eu lieu. Cela evite la race condition avec le premier `displayHomeView` au demarrage.

#### Carousels

- **Largeur** : `calc(100% + clamp(16px,4vw,30px) + 24px)` — s'etend jusqu'au bord droit du viewport
- Compense le padding-right du parent (`clamp`) et de l'albums-view (`24px`)
- Scroll horizontal via mousewheel/touchpad ou scrollbar hover

### 7.5 Recherche

- Recherche en direct (live search) avec dropdown de resultats
- **Index inverse** `Map<mot, Set<index>>` construit au chargement
- Matching par prefixe et substring sur titre, artiste, album
- Scoring multi-mots : intersection des resultats, scoring par pertinence (exact > prefixe > substring)
- Debounce de 200ms sur l'input
- Resultats groupes par type (pistes, albums, artistes)
- Navigation clavier (fleches, Enter, Escape)
- Recherche < 16ms meme sur 10K+ pistes
- **Filter tracks view** : `updateTracksFilter()` filtre la vue virtual scroll en temps reel

### 7.6 Menu contextuel

#### Menu contextuel de track
- Clic droit sur pistes dans la grille, la queue, ou le virtual scroll
- Actions (labels adaptes a la multi-selection) :
  - Lire / Lire apres / Ajouter a la queue
  - Ajouter a une playlist (sous-menu dynamique)
  - Editer la track / Editer N tracks (bulk edit modal)
  - Aller a l'album / Aller a l'artiste
  - Ouvrir dans le Finder
  - Supprimer
- Calcul de position intelligent (viewport-aware)
- **AbortController** : listeners actifs uniquement tant que le menu est visible

#### Menu contextuel d'album
- Clic droit sur carte d'album
- Actions : Lire l'album, ajouter a la queue, creer playlist depuis album, supprimer
- HTML separe du menu track (`.album-context-menu`)

### 7.7 Controles de lecture

| Controle | Detail |
|---|---|
| Play/Pause | Bascule avec debounce |
| Precedent | Retour au debut (<3s) ou piste precedente |
| Suivant | Priorite : queue > album sequentiel > repeat |
| Barre de progression | Seek par clic ou drag |
| Volume | Slider 0-100% + mute toggle + icone adaptative |
| Shuffle | 3 modes : off -> album -> library -> off |
| Repeat | 3 modes : off -> all -> one -> off |
| Specs audio | Source (rate/bit) -> Output (rate/bit) |

#### Playback context

| Contexte | Comportement "Next track" |
|---|---|
| `'library'` | Sequentiel via `ui.tracksViewOrder` |
| `'album'` | Stoppe a la fin de l'album |
| `null` | Conservatif (stoppe a la fin de l'album) |

### 7.8 Selecteur de sortie audio

- Liste des peripheriques de sortie disponibles (refresh automatique)
- Selection du peripherique actif avec indicateur "Defaut"
- Toggle Hog Mode (mode exclusif) avec tooltip explicatif
- **Section Egaliseur** avec bouton d'ouverture + toggle on/off
- Panneau EQ avec courbe SVG interactive et presets

### 7.9 Panel Track Info

- Panneau lateral avec details complets d'une piste
- **Sections affichees** :
  1. Pochette (lazy-loaded via IntersectionObserver)
  2. Titre + liens artiste/album (cliquables -> navigation)
  3. Badge qualite (lossless/lossy avec couleurs)
  4. Grille specs : Format, Sample Rate, Bitrate, Bit Depth
  5. Grille metadata : Year, Track#/Disc#, Genre
  6. Chemin du fichier (selectionnable)
  7. Boutons : Refresh metadata, Edit track
- **Mode edition inline** : remplace l'affichage par des champs input (titre, artiste, album, annee, track#, genre)
- **Alerte duplicat** : affichee si le fichier existe en plusieurs endroits
- Toggle via Cmd+Shift+I

### 7.10 Drag & Drop personnalise

- **Implementation custom** : HTML5 drag casse dans Tauri WebView
- Seuil de detection de 5px (mousedown -> mousemove > 5px -> isDragging)
- Element fantome visuel pendant le drag (fixed position, suit le curseur a +15px)
- Escape annule le drag et reset l'etat
- **Sources de drag** : track (player, context menu, grille), album (grille albums)
- **Zones de drop** : playlist item (ajoute les tracks), sidebar playlists (cree une nouvelle playlist)
- Surbrillance au survol des cibles (classe `drag-over`)

### 7.11 Raccourcis clavier

| Raccourci | Action |
|---|---|
| Espace | Play/Pause (si pas dans un input) |
| Cmd+Shift+Left | Piste precedente |
| Cmd+Shift+Right | Piste suivante |
| Cmd+Shift+Space | Toggle play/pause |
| Cmd+Shift+Up | Volume + |
| Cmd+Shift+Down | Volume - |
| Cmd+Shift+D | Toggle favori |
| Cmd+Shift+P | Focus recherche |
| Cmd+Shift+L | Toggle panel Queue |
| Cmd+Shift+I | Toggle panel Track Info |
| Cmd+Shift+E | Toggle panel EQ |
| Cmd+I | Edit metadata track courante |
| Escape | Fermer panel/menu actif |

- Raccourcis personnalisables dans les parametres (localStorage)
- Capture de touche pour remapping
- Reset aux valeurs par defaut
- **Media keys** : via souvlaki/MPRemoteCommandCenter (pas F7/F8/F9 — conflit Apple Music)

### 7.12 Parametres (Settings)

| Section | Options |
|---|---|
| **Audio** | Selecteur de device, toggle mode exclusif, volume au demarrage |
| **Bibliotheque** | Liste des chemins locaux, ajout/suppression de dossiers |
| **Reseau** | Liste des sources NAS, sync/toggle/remove, decouverte/ajout |
| **Lecture** | Auto-resume au demarrage, gapless playback |
| **Raccourcis** | Liste editable, capture de touche, reset |
| **Mises a jour** | Auto-check toggle, verification manuelle, version, installation |

### 7.13 Notifications (Toasts)

- Messages temporaires en bas a droite
- Feedback sur les actions utilisateur (changement de device, erreurs, ajout queue, etc.)
- Animation slide-up avec auto-dismiss (3s par defaut)
- Types : success (blanc), error (rouge)

### 7.14 Sidebar redimensionnable

- Largeur par defaut : 280px
- Plage : 180px - 400px
- Handle de resize (8px, bord droit) avec curseur visuel
- Persistance dans localStorage
- **Collapse < 900px** : 48px width, `.playlists-actions` hidden, inline width cleared via matchMedia listener
- En mode collapse, le contenu textuel est masque, seules les icones restent

### 7.15 Fullscreen Player

- **Activation** : clic sur la pochette dans le player bar
- **Particle system** : 3 phases d'animation (spawn, float, fade)
- **Color extraction** : couleurs dominantes extraites de la cover via canvas
- **RMS visualization** : niveau audio en temps reel (calcule dans le callback CoreAudio)
- **Affichage** : pochette centree, titre/artiste, barre de progression, controles (prev/play/next)
- **Next track** : label en bas indiquant la prochaine piste
- **z-index** : 10000 (au-dessus de tout)

### 7.16 Lyrics (Paroles)

- **Sources** : lrclib.net (prioritaire) + lyrics.ovh (fallback)
- **Synchronisation** : les lignes s'illuminent en sync avec la position de lecture
- **Panel lateral** : affichage scrollable a droite
- **Overlay fullscreen** : paroles en plein ecran, superposees au fullscreen player
- **Toggle** : bouton dans le player bar ou raccourci clavier

### 7.17 Feedback (Bug reports)

- **Bouton flottant** : icone globe, position fixe en bas a droite
- **Modal** :
  1. Type : Bug / UX Issue / Feature Request / Other
  2. Severite (conditionnel) : High / Medium / Low (visible pour Bug + UX)
  3. Titre : 80 caracteres max avec compteur
  4. Description : >=10 caracteres requis
  5. Email : optionnel
- **Contexte auto-capture** : version app, vue courante, taille bibliotheque, statut lecture, timestamp
- **Soumission** : `submit_feedback` -> POST GitHub Issues API (`thomasdugue/noir-feedback`)
- **Fallback offline** : sauvegarde locale en JSON dans `feedback/`
- **Token** : `NOIR_GITHUB_FEEDBACK_TOKEN` injecte a la compilation via `option_env!`
- **UX** : Cmd+Enter pour soumettre, Escape pour fermer, shake animation sur erreur de validation

### 7.18 Auto-update

- Integration Tauri updater plugin
- Check automatique au demarrage (configurable dans les parametres)
- Verification manuelle via bouton dans les parametres
- Affichage de la version courante
- Bouton d'installation quand une mise a jour est disponible
- Endpoints : GitHub releases (`noir-desktop/releases/latest/download/latest.json`)

### 7.19 Bulk Metadata Edit

- **Declenchement** : menu contextuel "Editer N tracks" (multi-selection requise)
- **Modal** : champs Artist, Album, Year, Genre
- **Placeholder "mixed values"** : affiche quand les tracks selectionnees ont des valeurs differentes pour un champ
- **Sauvegarde** : `invoke('write_metadata', ...)` sequentiel pour chaque track
- **Post-save** :
  1. Met a jour les proprietes des objets track en memoire (mutation par reference)
  2. `groupTracksIntoAlbumsAndArtists()` — reconstruit l'index albums/artistes depuis `library.tracks`
  3. `invalidateHomeCache()` — invalide le cache de la page d'accueil
  4. `displayCurrentView()` — **inconditionnel** (rafraichit TOUTES les vues, pas seulement albums/artists/home)
- **Unification artistes** : si N tracks passent au meme artiste, `groupTracksIntoAlbumsAndArtists()` les regroupe automatiquement sous un seul objet artiste

### 7.20 Virtual Scroll (vue Pistes)

- **Pool DOM** : 60 noeuds recycles (pas de creation/destruction dynamique)
- **Hauteur item** : `TRACK_ITEM_HEIGHT = 48px`
- **Buffer** : `VIRTUAL_BUFFER = 10` items au-dessus/en-dessous du viewport visible
- **Event delegation** : un seul listener sur le container grid (pas de listeners par item)
- **Spacer** : hauteur = `totalTracks * 48px` (pour la physique de scroll native)
- **Multi-selection** :
  - Ctrl/Cmd+click : ajout/retrait de la selection
  - Shift+click : selection par plage
  - `virtualScrollState.selectedTrackPaths Set` contient les chemins selectionnes
  - Visuel : classe `.track-item-selected` (fond plus sombre)
- **Performance** : 10K+ tracks a 60fps via recyclage DOM

---

## 8. Persistance des donnees

Tous les fichiers sont stockes dans `~/.local/share/noir/` :

| Fichier/Dossier | Contenu |
|---|---|
| `config.json` | Chemins des dossiers de bibliotheque, excluded_paths |
| `metadata_cache.json` | Metadonnees de toutes les pistes |
| `cover_cache.json` | Chemins des pochettes extraites |
| `tracks_cache.json` | Liste complete des pistes (demarrage instantane) |
| `playlists.json` | Playlists utilisateur + systeme |
| `listening_history.json` | Historique d'ecoute (1 000 entrees) |
| `added_dates_cache.json` | Dates d'import des pistes |
| `internet_not_found_cache.json` | Pochettes non trouvees en ligne (TTL 30 jours) |
| `settings.json` | Preferences (EQ, volume, gapless, etc.) |
| `network_sources.json` | Sources NAS/SMB configurees |
| `covers/` | Pochettes extraites (JPEG/PNG) |
| `thumbnails/` | Miniatures 80x80 (JPEG) |
| `smb_buffer/` | Fichiers temporaires de progressive download SMB |
| `feedback/` | Feedbacks locaux en attente d'envoi |

---

## 9. Dependencies principales (Rust)

| Crate | Version | Role |
|---|---|---|
| `tauri` | 2 | Framework applicatif, IPC |
| `tauri-plugin-dialog` | 2 | Selecteur de fichiers natif |
| `tauri-plugin-opener` | 2 | Ouverture d'URLs |
| `tauri-plugin-global-shortcut` | 2 | Raccourcis globaux |
| `tauri-plugin-updater` | 2 | Auto-mises a jour |
| `symphonia` | 0.5 (all features) | Decodage audio multi-format |
| `coreaudio-rs` | 0.11 | Wrapper CoreAudio streaming |
| `coreaudio-sys` | 0.2 | Acces HAL direct |
| `core-foundation` | 0.9 | Types macOS (CFString) |
| `rubato` | 0.14 | Resampling FFT |
| `biquad` | 0.4 | Filtres biquad IIR (EQ) |
| `ringbuf` | 0.4 | Buffer lock-free (5s) |
| `crossbeam-channel` | 0.5 | Communication inter-threads (decoder commands) |
| `parking_lot` | 0.12 | Mutex rapides pour threads temps-reel |
| `rayon` | 1.8 | Parallelisme (scan bibliotheque) |
| `lofty` | 0.18 | Lecture/ecriture de tags audio |
| `image` | 0.24 | Generation de thumbnails |
| `walkdir` | 2 | Parcours de repertoires |
| `reqwest` | 0.11 (async, JSON) | Requetes HTTP asynchrones (Deezer, MusicBrainz, GitHub) |
| `tokio` | 1 (rt-multi-thread, time) | Runtime async |
| `serde` / `serde_json` | 1 | Serialisation JSON |
| `base64` | 0.21 | Encodage base64 |
| `dirs` | 5 | Chemins platform |
| `once_cell` | 1.18 | Lazy statics |
| `percent-encoding` | 2.3 | Decodage URL (protocole noir://) |
| `pavao` | 0.2 | Client SMB2/3 (wrapper libsmbclient) |
| `mdns-sd` | 0.11 | Decouverte mDNS/Bonjour |
| `uuid` | 1 + v4 | Generation UUID (sources reseau) |
| `security-framework` | 2 | Acces macOS Keychain |
| `souvlaki` | 0.7 | Media controls (MPRemoteCommandCenter) |

---

## 10. API IPC (82 commandes Tauri)

### Cache & Metadonnees (20)

| Commande | Signature | Role |
|---|---|---|
| `init_cache` | `() -> bool` | Force-load all caches at startup |
| `save_all_caches` | `() -> ()` | Persist all caches to disk |
| `load_tracks_from_cache` | `() -> (Vec<Track>, LibraryStats)` | Instant library load from disk |
| `scan_folder` | `(path) -> Vec<AudioTrack>` | Fast file enumeration (no metadata) |
| `scan_folder_with_metadata` | `(path) -> Vec<TrackWithMetadata>` | Parallel metadata scan via rayon |
| `get_metadata` | `(path) -> Metadata` | Get metadata from cache or file |
| `refresh_metadata` | `(path) -> Metadata` | Force re-read metadata from file |
| `write_metadata` | `(path, title?, artist?, album?, year?, genre?, track?) -> bool` | Write tags + update BOTH caches |
| `load_all_metadata_cache` | `() -> HashMap` | Dump entire metadata cache |
| `get_added_dates` | `() -> HashMap<String, u64>` | Track addition timestamps |
| `get_cover` | `(path) -> Option<String>` | Get cover path (embedded or internet) |
| `get_cover_base64` | `(path) -> Option<String>` | Get cover as base64 data URI |
| `get_cover_thumbnail` | `(path) -> Option<String>` | Get pre-generated 80x80 JPEG |
| `generate_thumbnails_batch` | `(paths) -> u32` | Generate missing thumbnails |
| `fetch_internet_cover` | `(artist, album) -> Option<String>` | MusicBrainz + Cover Art Archive |
| `fetch_artist_image` | `(artist, fallback_album, fallback_cover_path) -> Option<String>` | Deezer API + fallbacks |
| `get_library_stats` | `() -> LibraryStats` | Total tracks, albums, artists, duration |
| `trigger_genre_enrichment` | `(app_handle) -> ()` | Async Deezer + MusicBrainz enrichment |
| `reset_genre_enrichment` | `(app_handle) -> ()` | Retry enrichment for tracks without genres |
| `clear_cache` | `() -> ()` | Clear all in-memory caches |

### Bibliotheque (5)

| Commande | Signature | Role |
|---|---|---|
| `add_library_path` | `(path) -> ()` | Add folder to library |
| `remove_library_path` | `(path) -> ()` | Remove folder + drop cached tracks |
| `exclude_tracks_from_library` | `(paths) -> usize` | Exclude paths persistently |
| `get_library_paths` | `() -> Vec<String>` | List library folders |
| `select_folder` | `(app) -> Option<String>` | Native folder picker dialog |

### Scan (2)

| Commande | Signature | Role |
|---|---|---|
| `start_background_scan` | `(app_handle) -> ()` | Async scan all local library paths |
| `scan_network_source_cmd` | `(source_id, app_handle) -> ()` | Scan specific NAS source |

### Playlists (12)

| Commande | Signature | Role |
|---|---|---|
| `get_playlists` | `() -> Vec<Playlist>` | All playlists (creates Favorites if missing) |
| `create_playlist` | `(name) -> Playlist` | Create with UUID + timestamp |
| `rename_playlist` | `(id, name) -> bool` | |
| `delete_playlist` | `(id) -> bool` | Cannot delete system playlists |
| `add_track_to_playlist` | `(playlist_id, track_path) -> bool` | |
| `remove_track_from_playlist` | `(playlist_id, track_path) -> bool` | |
| `reorder_playlist_tracks` | `(playlist_id, paths) -> bool` | Replace track order |
| `toggle_favorite` | `(track_path) -> bool` | Returns new favorite state |
| `is_favorite` | `(track_path) -> bool` | |
| `get_favorites` | `() -> Vec<String>` | All favorite paths |
| `export_playlist_m3u` | `(playlist_id, app) -> String` | Save dialog + M3U export |
| `import_playlist_m3u` | `(app) -> Playlist` | File picker + M3U import |

### Audio Playback (9)

| Commande | Signature | Role |
|---|---|---|
| `audio_play` | `(path) -> ()` | Start playback (local or SMB) |
| `audio_pause` | `() -> ()` | |
| `audio_resume` | `() -> ()` | |
| `audio_stop` | `() -> ()` | |
| `audio_seek` | `(time: f64) -> ()` | Seek to seconds |
| `audio_set_volume` | `(volume: f32) -> ()` | 0.0-1.0 |
| `audio_get_state` | `() -> AudioPlaybackState` | is_playing, position, duration |
| `audio_preload_next` | `(path) -> ()` | Gapless preload (SMB-aware) |
| `set_gapless_enabled` | `(enabled) -> ()` | |

### Audio Devices (8)

| Commande | Signature | Role |
|---|---|---|
| `get_audio_devices` | `() -> Vec<DeviceInfo>` | Cached device list |
| `refresh_audio_devices` | `() -> Vec<DeviceInfo>` | Refresh from OS |
| `get_current_audio_device` | `() -> DeviceInfo` | |
| `set_audio_device` | `(device_id) -> ()` | AirPlay-aware switching |
| `get_system_default_device_id` | `() -> Option<String>` | Real system default |
| `get_audio_sample_rate` | `() -> u32` | |
| `set_exclusive_mode` | `(enabled) -> ()` | Hog mode on/off |
| `is_exclusive_mode` | `() -> bool` | |
| `hog_mode_status` | `() -> HogModeStatus` | Detailed status with PID |

### EQ (3)

| Commande | Signature | Role |
|---|---|---|
| `set_eq_enabled` | `(enabled) -> ()` | Master on/off |
| `set_eq_bands` | `(gains: Vec<f32>) -> ()` | 8 gains en dB (-12 a +12) |
| `get_eq_state` | `() -> EqStateResponse` | enabled + gains[] |

### Historique (8)

| Commande | Signature | Role |
|---|---|---|
| `record_play` | `(path, artist, album, title) -> ()` | Record play event |
| `get_listening_history` | `() -> ListeningHistory` | All entries + played_paths |
| `get_last_played` | `() -> Option<ListeningEntry>` | |
| `get_recent_albums` | `(days) -> Vec<ListeningEntry>` | Unique albums in N days |
| `get_all_played_albums` | `() -> Vec<ListeningEntry>` | All unique albums by play count |
| `get_all_played_paths` | `() -> Vec<String>` | For discovery mixes |
| `get_top_artists` | `(limit) -> Vec<TopArtist>` | Top N by play count |

### Media Controls (2)

| Commande | Signature | Role |
|---|---|---|
| `update_media_metadata` | `(title, artist, album) -> ()` | Update macOS Now Playing info |
| `update_media_playback_state` | `(is_playing) -> ()` | Update play/pause in Control Center |

### Network/NAS (12)

| Commande | Signature | Role |
|---|---|---|
| `discover_nas_devices` | `(app_handle) -> Vec<DiscoveredNas>` | 5s mDNS discovery |
| `smb_connect` | `(host, username, password, domain?, is_guest?) -> ()` | Test SMB connection |
| `smb_list_shares` | `(host) -> Vec<SmbShare>` | |
| `smb_browse` | `(host, share, path) -> Vec<SmbEntry>` | List remote files/folders |
| `add_network_source` | `(name, host, share, path, username, password, domain?) -> ScanComplete` | Add + immediate scan |
| `remove_network_source` | `(source_id) -> ScanComplete` | Remove + delete Keychain + library cleanup |
| `get_network_sources` | `() -> Vec<NetworkSource>` | |
| `toggle_network_source` | `(source_id, enabled) -> ()` | Enable/disable |
| `update_network_source_credentials` | `(source_id, username, password, domain?) -> ()` | |
| `get_network_status` | `() -> HashMap<String, String>` | Status per source |
| `reconnect_network_source` | `(source_id) -> ()` | Manual reconnect (Keychain-safe) |

### Misc (3)

| Commande | Signature | Role |
|---|---|---|
| `submit_feedback` | `(payload) -> String` | GitHub Issues API + local fallback |
| `quit_app` | `(app_handle) -> ()` | Proper exit |

### Evenements emis (backend -> frontend)

| Evenement | Donnees | Frequence |
|---|---|---|
| `scan_progress` | phase, current, total | Tous les 10 fichiers |
| `scan_complete` | stats, new_tracks, removed_tracks | Fin de scan |
| `genre_enrichment_progress` | current, total, enriched_albums | Tous les 10 albums |
| `genre_enrichment_complete` | enriched_albums, fallback_count | Fin enrichissement |
| `library_paths_inaccessible` | paths[] | Si erreur acces |
| `playback_progress` | position, duration | ~100ms |
| `playback_complete` | path | Fin naturelle de piste |
| `playback_started` | path | Debut de lecture |
| `media-control` | "play" / "pause" / "next" / "previous" | Media keys pressees |
| `nas_device_found` | hostname, ip, port, display_name | Pendant decouverte mDNS |
| `network_source_connected` | source_id | Connexion reussie |
| `network_source_disconnected` | source_id | Deconnexion |

### Caches globaux Rust (statiques)

| Statique | Type | Role |
|---|---|---|
| `TRACKS_CACHE` | `Lazy<Mutex<TracksCache>>` | Toutes les pistes avec metadata |
| `METADATA_CACHE` | `Lazy<Mutex<MetadataCache>>` | Metadata par chemin |
| `COVER_CACHE` | `Lazy<Mutex<CoverCache>>` | Chemin piste -> chemin cover |
| `NETWORK_SOURCES` | `Lazy<Mutex<Vec<NetworkSource>>>` | Sources NAS |
| `LISTENING_HISTORY` | `Lazy<Mutex<ListeningHistory>>` | Historique d'ecoute |
| `ADDED_DATES_CACHE` | `Lazy<Mutex<AddedDatesCache>>` | Dates d'ajout |
| `INTERNET_COVER_NOT_FOUND_CACHE` | `Lazy<Mutex<...>>` | "Not found" TTL 30 jours |
| `CURRENT_DOWNLOAD_CANCEL` | `Lazy<Mutex<Option<Arc<AtomicBool>>>>` | Annulation download SMB |
| `AUDIO_ENGINE` | `Lazy<Mutex<AudioEngine>>` | Moteur de lecture singleton |
| `EQ_STATE` | `Lazy<EqSharedState>` | EQ lock-free (AtomicU32) |

---

## 11. Performances et fiabilite

### Performances

| Aspect | Implementation |
|---|---|
| Demarrage | < 50ms (cache JSON tracks_cache.json) |
| Scan bibliotheque | Parallele (Rayon, tous les coeurs) |
| Audio callback | Lock-free (aucun mutex en thread temps-reel) |
| Buffer audio | 5 secondes (absorbe les pics I/O) |
| Seek | ~200ms (AudioUnitReset + pre-fill 300ms) |
| Progression UI | Interpolation 60 FPS (RAF stoppe au repos) |
| Thumbnails | Batch, JPEG 80x80, filtre Triangle |
| Recherche | < 16ms via index inverse |
| Pochettes memoire | ~60 octets/album (URLs noir://) |
| Virtual scroll | 60 noeuds DOM recycles (pool) |
| Transitions CSS | Proprietes ciblees (pas `transition: all`) |
| Requetes HTTP | Asynchrones (ne bloquent pas le pool Tokio) |
| CPU au repos | < 1% (RAF stoppe, pas de polling) |
| EQ | Zero-latence (AtomicU32 lock-free pour gains) |
| Event delegation | Un seul listener sur les containers grid (pas par item) |
| Listeners transients | AbortController (cleanup automatique a la fermeture) |

### Fiabilite

| Aspect | Implementation |
|---|---|
| Decodage | Double-probe Symphonia + Lofty |
| Nettoyage | `Drop` impl (libere Hog Mode, restaure sample rates) |
| Device change | Gestion gracieuse, fallback vers defaut |
| AirPlay | Session preservation, pas de sample rate change, auto-retry |
| Resampling | Fallback automatique si bit-perfect impossible |
| Caches | Mises a jour atomiques, coherence garantie (double cache write_metadata) |
| Seek | Rate-limiting pour eviter le flooding |
| EQ | Bypass a 0 dB (bit-perfect preserve) |
| Gapless | Double-buffering avec detection de fin explicite + current_path Arc |
| Panels | Fermeture croisee (un seul panel ouvert) |
| SMB | Singleton process-level (libsmbclient), annulation atomique des downloads |
| Keychain | Password cache session (evite dialogues au demarrage a froid) |
| transitionView | renderVersion counter annule les renders obsoletes, isTransitioning toujours reset |
| scan_complete | Conditionnel (pas de reload si aucun changement) |

---

## 12. Structure du code source

```
noir-tauri/
+-- src/
|   +-- index.html              (630 lignes)    - Structure HTML
|   +-- styles.css              (7 813 lignes)  - Styles + design system + 29 variables
|   +-- renderer.js             (910 lignes)    - Orchestrateur + settings
|   +-- app.js                  (111 lignes)    - Mediateur cross-module
|   +-- state.js                (211 lignes)    - Etat centralise partage
|   +-- views.js                (3 098 lignes)  - Rendu vues + virtual scroll
|   +-- playback.js             (2 056 lignes)  - Audio + gapless + AirPlay
|   +-- panels.js               (1 352 lignes)  - Queue + track info + context menu + bulk edit
|   +-- playlists.js            (1 495 lignes)  - Playlists + favoris + M3U
|   +-- library.js              (934 lignes)    - Covers + metadata + scan
|   +-- network.js              (882 lignes)    - NAS/SMB + decouverte + credentials
|   +-- fullscreen-player.js    (420 lignes)    - Vue immersive + particles
|   +-- shortcuts.js            (570 lignes)    - Raccourcis + media keys
|   +-- eq.js                   (392 lignes)    - EQ panel + SVG
|   +-- search.js               (337 lignes)    - Index inverse + panel
|   +-- feedback.js             (232 lignes)    - Bug reports + GitHub
|   +-- lyrics.js               (285 lignes)    - Paroles + sync
|   +-- drag.js                 (209 lignes)    - Drag custom
|   +-- utils.js                (350 lignes)    - Utilitaires
|   +-- auto-update.js          (103 lignes)    - Auto-update
|   +-- __tests__/
|   |   +-- FormatDisplay.test.js              - Tests formatQuality()
|   |   +-- Navigation.test.js                 - Tests navigation
|   |   +-- PlayerControls.test.js             - Tests controles
|   |   +-- AlbumView.test.js                  - Tests album grid
|   +-- fonts/
|       +-- GeistMono-Variable.woff2           - Police monospace variable
+-- src-tauri/
|   +-- Cargo.toml                             - 30 dependances Rust
|   +-- tauri.conf.json                        - Config Tauri + CSP + protocole noir://
|   +-- capabilities/default.json              - Permissions Tauri
|   +-- icons/                                 - 16 fichiers (PNG, ICNS, ICO)
|   +-- src/
|       +-- main.rs             (7 lignes)     - Point d'entree
|       +-- lib.rs              (4 421 lignes) - Orchestrateur + 82 commandes IPC
|       +-- audio_engine.rs     (1 055 lignes) - Moteur de lecture + gapless
|       +-- audio_decoder.rs    (908 lignes)   - Decodage + resampling + seek
|       +-- resampler.rs        (172 lignes)   - Resampler FFT (Rubato)
|       +-- eq.rs               (234 lignes)   - EQ 8 bandes (biquad IIR)
|       +-- media_controls.rs   (136 lignes)   - MPRemoteCommandCenter
|       +-- audio/
|       |   +-- mod.rs          (51 lignes)    - Module exports
|       |   +-- backend.rs      (184 lignes)   - Trait AudioBackend
|       |   +-- types.rs        (148 lignes)   - DeviceInfo, HogModeStatus, StreamConfig
|       |   +-- error.rs        (52 lignes)    - AudioBackendError
|       |   +-- stream.rs       (118 lignes)   - Trait AudioOutputStream
|       |   +-- coreaudio_backend.rs (1 276 l) - HAL macOS (device control + AirPlay)
|       |   +-- coreaudio_stream.rs  (667 l)   - AudioUnit stream + callback
|       +-- network/
|           +-- mod.rs          (155 lignes)   - Types reseau
|           +-- scanner.rs      (810 lignes)   - Scan differentiel + progressive download
|           +-- smb.rs          (546 lignes)   - Client SMB (pavao singleton)
|           +-- credentials.rs  (95 lignes)    - Keychain + password cache
|           +-- discovery.rs    (85 lignes)    - mDNS/Bonjour
+-- docs/
|   +-- NOIR_DESKTOP_SPEC.md                   - Ce document
+-- package.json                               - Dependencies frontend (Tauri CLI)
```

**Total : ~25 050 lignes de code** (13 950 JS + 7 813 CSS + 630 HTML + 11 100 Rust)

---

## 13. Comportements UX valides (anti-regression)

Ce catalogue documente les comportements critiques qui ne doivent JAMAIS etre casses lors de modifications futures. Avant toute modification, verifier si un comportement valide est affecte.

| ID | Comportement | Invariant critique | Fichiers |
|---|---|---|---|
| **V001** | Home page chargement au demarrage | `transitionView` est async, `displayHomeView` DOIT etre awaitee, `renderVersion` counter annule les renders obsoletes | views.js |
| **V002** | Recently Played responsive grid | `width:100%` + `box-sizing:border-box` sur `.home-recent-grid`, media queries 3->2->1 cols, max 6 items | styles.css, views.js |
| **V003** | Carousel width calculation | `min-width:0` sur `.main-content` (CRITIQUE — sans ca, les carousels gonflent le flex item a ~4500px), `overflow-x:clip` sur `.albums-view` | styles.css |
| **V004** | scan_complete conditionnel | `shouldReload = new_tracks > 0 || removed_tracks > 0` — pas de reload si rien n'a change (evite race condition au demarrage) | library.js |
| **V005** | Drag & Drop custom | HTML5 drag casse dans Tauri WebView -> implementation mousedown/mousemove/mouseup avec seuil 5px | drag.js |
| **V006** | Virtual scroll pool | 60 nodes recycles, `TRACK_ITEM_HEIGHT=48px`, event delegation sur le container (pas de listeners par item) | views.js |
| **V007** | Media keys souvlaki | `MPRemoteCommandCenter` via souvlaki, F7/F8/F9 intentionnellement absents (conflit Apple Music) | media_controls.rs, shortcuts.js |
| **V008** | AirPlay session preservation | Pas de changement de sample rate, pas de hog mode, garder comme system default quand on switch vers un autre device | coreaudio_backend.rs |
| **V009** | SMB Keychain cold start | `has_password_in_session()` AVANT `retrieve_password()` dans `reconnect_network_source` — evite les dialogues Keychain au demarrage | credentials.rs, lib.rs |
| **V010** | Artist loose tracks full width | `grid-column: 1 / -1` sur `.artist-loose-tracks-section` — sans ca, contraint a 180px par `.artist-albums-grid` qui utilise `repeat(auto-fill, 180px)` | styles.css |
| **V011** | Carousel scrollbar hover-only | Thumb `rgba(255,255,255,0)` par defaut (transparent), visible au hover du carousel avec opacites progressives | styles.css |
| **V012** | Bulk edit refresh toutes vues | `displayCurrentView()` appele SANS condition apres `saveBulkMetadata` — ne PAS re-ajouter de condition `if (includes(currentView))` | panels.js |
| **V013** | state.js references partagees | Ne JAMAIS reassigner les objets state (`library = {}` interdit). Muter les proprietes : `library.tracks.length = 0; push(...)` / `clearObject(obj)` | state.js |
| **V014** | artist.albums est Array | Apres `groupTracksIntoAlbumsAndArtists()`, `artist.albums` est un Array (pas un Set). Utiliser `.length`, PAS `.size` | library.js |
| **V015** | write_metadata double cache | Met a jour METADATA_CACHE ET TRACKS_CACHE dans le backend Rust — sinon les mutations JS-side sont ecrasees au prochain load_tracks_from_cache | lib.rs |
| **V016** | Sidebar collapse <900px | 48px width, `.playlists-actions` hidden, inline `style.width` cleared via matchMedia listener (sinon l'inline width ecrase le media query) | styles.css, renderer.js |

---

## 14. Axes d'evolution

| Domaine | Possibilite | Statut |
|---|---|---|
| Multi-plateforme | Backend WASAPI pour Windows (infrastructure trait prete) | Prevu |
| DSP avance | AutoEQ (profils par modele de casque, structure biquad compatible) | Prevu |
| Visualiseur | FFT disponible via Rubato, visualisations spectrales | Envisage |
| Scrobbling | Integration Last.fm | Envisage |
| Crossfade | Transition douce entre pistes | Envisage |
| ReplayGain | Normalisation du volume inter-pistes | Envisage |
| Phase 5 | Architecture audio (RwLock + message passing) | Planifie |

### Phases completees

| Phase | Titre | Statut |
|---|---|---|
| Phase 1 | Quick wins (RAF idle, CSS, search index) | Terminee |
| Phase 2 | Async HTTP (reqwest) | Terminee |
| Phase 3 | Protocole custom noir:// (pochettes) | Terminee |
| Phase 4 | Recyclage DOM (virtual scroll 60 noeuds) | Terminee |
| Phase 6 | Gapless (double-buffering) | Terminee |
| Phase 7 | Modularisation renderer.js (18 modules ES6) | Terminee |

---

## 15. Patterns de developpement

### 15.1 Mediateur app.js

Pour ajouter une nouvelle fonction cross-module :
1. Exporter la fonction depuis le module source
2. L'enregistrer sur `app` dans `renderer.js` : `app.maFonction = module.maFonction`
3. L'appeler depuis d'autres modules via `app.maFonction()`
4. Ne JAMAIS importer directement un module dans un autre module

### 15.2 Lazy loading covers

- `observeCoverLoading(card, path, artist, album)` — pour albums
  - Stocke `data-cover-artist`, `data-cover-album` sur le card
  - IntersectionObserver declenche `loadThumbnailAsync` -> `fetch_internet_cover`
- `observeArtistLoading(card, artistName, fallbackAlbum, fallbackCoverPath)` — pour artistes
  - Stocke `data-artist-name`, `data-fallback-album`, `data-fallback-cover-path`
  - IntersectionObserver declenche `loadArtistImageAsync` -> Deezer/MusicBrainz

### 15.3 transitionView async + renderVersion

```javascript
let renderVersion = 0
async function transitionView(renderFn) {
  const version = ++renderVersion
  // fade-out 130ms
  await renderFn()
  if (renderVersion !== version) return  // obsolete, abandonner
  // fade-in 200ms
}
```

### 15.4 clearObject() pour references partagees

```javascript
function clearObject(obj) {
  for (const key of Object.keys(obj)) delete obj[key]
}
// Pour les tableaux : array.length = 0; array.push(...newItems)
```

### 15.5 AbortController pour listeners transients

```javascript
if (abortController) abortController.abort()
abortController = new AbortController()
document.addEventListener('keydown', handler, { signal: abortController.signal })
// Cleanup automatique quand on appelle abort()
```

### 15.6 Methodologie debugging CSS

1. **TOUJOURS mesurer** avec `getBoundingClientRect()` + `getComputedStyle()` AVANT de modifier le CSS
2. Identifier quel element a les mauvaises dimensions
3. Remonter la chaine parent jusqu'a trouver la source du probleme
4. Ne pas deviner — mesurer

---

## 16. Tests

### Tests JavaScript

- **Framework** : Jest
- **Commande** : `npm test -- --watchAll=false`
- **Resultats** : ~11 pass, ~14 skipped (tests limites par l'absence de `invoke` Tauri en environnement Node)

| Fichier | Tests |
|---|---|
| `FormatDisplay.test.js` | 10 pass — formatQuality() (FLAC/MP3/WAV/AAC) |
| `Navigation.test.js` | 2 pass — navigation state |
| `PlayerControls.test.js` | Skipped — necessite audio engine Tauri |
| `AlbumView.test.js` | Skipped — necessite DOM Tauri |

### Tests Rust

- **Commande** : `cd src-tauri && cargo test`
- **Resultats** : ~110 pass, ~18 ignored (contexte Tauri/CoreAudio non disponible en CI)

---

*Specification mise a jour le 8 mars 2026 — basee sur l'analyse complete du code source de Noir Desktop (branche `feat/player-redesign-lyrics`).*
