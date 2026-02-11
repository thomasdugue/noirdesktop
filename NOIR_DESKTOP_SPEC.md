# NOIR DESKTOP — Specifications Techniques Completes

## 1. Vue d'ensemble

**Noir** est un lecteur de musique audiophile pour macOS, construit avec **Tauri 2** (backend Rust + frontend HTML/CSS/JS vanilla). L'application privilegie la lecture bit-perfect, le demarrage instantane et une interface sombre optimisee pour les longues sessions d'ecoute.

| Propriete | Valeur |
|---|---|
| **Identifiant** | `com.tdugue.noir` |
| **Framework** | Tauri 2 |
| **Backend** | Rust |
| **Frontend** | HTML5 + CSS3 + JavaScript vanilla |
| **Plateforme cible** | macOS (CoreAudio natif) |
| **Fenetre par defaut** | 1200x800px, transparente, titlebar overlay |

---

## 2. Architecture globale

```
+-----------------------------------------------------+
|                    FRONTEND                          |
|  index.html + renderer.js (~7 678 lignes)           |
|  styles.css (~4 215 lignes)                         |
|  Communication via Tauri IPC (invoke/listen)        |
+------------------------+----------------------------+
                         | Tauri Commands (61 commandes)
+------------------------v----------------------------+
|                  BACKEND RUST                        |
|  lib.rs (~2 198 lignes) - Orchestrateur principal   |
|  +------------------------------------------------+ |
|  |           MODULE AUDIO                         | |
|  |  audio_engine.rs (980 l.)   - Moteur lecture   | |
|  |  audio_decoder.rs (781 l.)  - Decodage         | |
|  |  resampler.rs (172 l.)      - Reechantillonnage| |
|  |  audio/backend.rs           - Trait abstrait    | |
|  |  audio/coreaudio_backend.rs (934 l.) - HAL     | |
|  |  audio/coreaudio_stream.rs (557 l.)  - Stream  | |
|  +------------------------------------------------+ |
+-----------------------------------------------------+
                         |
              macOS CoreAudio HAL -> DAC -> Sortie audio
```

---

## 3. Chaine audio complete

### 3.1 Pipeline de lecture

```
Fichier audio
    |
Symphonia Decoder (ou Lofty fallback pour M4A/AAC)
    | f32 interleaved
[Resampler Rubato FFT] <- seulement si le DAC ne supporte pas le sample rate source
    |
RingBuffer lock-free (5 secondes de capacite, HeapRb<f32>)
    | (consumer, thread temps-reel)
CoreAudio AudioUnit Callback
    | application du volume (f32 x volume)
CoreAudio HAL -> DAC -> Enceintes/Casque
```

### 3.2 Formats supportes

| Format | Codec | Notes |
|---|---|---|
| FLAC | Symphonia | 16/24-bit, jusqu'a 384 kHz |
| WAV | Symphonia | PCM |
| MP3 | Symphonia | CBR/VBR |
| AAC/M4A | Symphonia + Lofty fallback | Double-probe pour fiabilite |
| ALAC | Symphonia | Apple Lossless |
| Vorbis/OGG | Symphonia | |
| WMA | Symphonia | |
| AIFF | Symphonia | |

### 3.3 Lecture bit-perfect

1. Le moteur detecte le sample rate du fichier source
2. Tente de configurer le DAC au meme sample rate via `kAudioDevicePropertyNominalSampleRate`
3. **Si succes** : lecture bit-perfect (pas de resampling)
4. **Si echec** : fallback avec resampling FFT haute qualite (Rubato, chunks de 1024 samples)

### 3.4 Hog Mode (mode exclusif)

- Acces exclusif au peripherique audio via `kAudioDevicePropertyHogMode`
- Empeche les autres applications d'utiliser le DAC
- Liberation automatique a la fermeture (implementation `Drop`)
- Restauration automatique du sample rate original

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

### 3.7 Progression UI

- Emission d'evenements de progression a **~30 FPS**
- Interpolation cote frontend pour fluidite
- Position trackee atomiquement dans le callback audio

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
    |
Mise a jour du cache
```

### 4.2 Scan de la bibliotheque

- **Parcours recursif** des dossiers configures (walkdir)
- **Chargement parallele des metadonnees** via Rayon (tous les coeurs CPU)
- **Double-probe** : Symphonia en premier, Lofty en fallback
- **Evenements de progression** emis dossier par dossier vers le frontend
- Support de **plusieurs chemins de bibliotheque**

### 4.3 Metadonnees extraites

| Champ | Source |
|---|---|
| Titre | Tag ID3/Vorbis/MP4 |
| Artiste | Tag |
| Album | Tag |
| Numero de piste | Tag |
| Duree | Probe audio |
| Bitrate | Probe audio |
| Sample rate | Probe audio |
| Bit depth | Probe audio |
| Format | Extension fichier |

### 4.4 Pochettes d'album (Cover Art)

**Ordre de recherche :**
1. **Embedded** - extraite du fichier audio
2. **Cache local** - `~/.local/share/noir/covers/`
3. **Internet** - recherche automatique sur :
   - MusicBrainz (Cover Art Archive)
   - Deezer API
   - Wikimedia Commons (images d'artistes)

**Thumbnails :**
- Generees en batch (150x150 px, JPEG, filtre Triangle)
- Stockees dans `~/.local/share/noir/thumbnails/`
- Cache des recherches internet echouees (`internet_not_found_cache.json`)

### 4.5 Historique d'ecoute

- Stockage des **1 000 dernieres ecoutes**
- Donnees : piste, artiste, album, horodatage, duree ecoutee
- Calcul des **top artistes** et **albums recemment joues**
- Persiste dans `listening_history.json`

### 4.6 Statistiques de bibliotheque

- Nombre total de pistes
- Nombre d'artistes
- Nombre d'albums
- Repartition par format (FLAC, MP3, AAC, etc.)
- Duree totale de la bibliotheque

---

## 5. Systeme de playlists

| Fonctionnalite | Detail |
|---|---|
| Creation | Nom personnalise |
| Renommage | Oui |
| Suppression | Avec confirmation |
| Ajout de pistes | Par track ou par album entier |
| Favoris | Playlist systeme "favorites" |
| Drag & drop | Glisser des pistes/albums vers une playlist |
| Persistance | `playlists.json` |

---

## 6. Systeme de file d'attente (Queue)

- File d'attente courante + pistes suivantes
- Reordonnement par drag & drop
- Ajout via menu contextuel
- Suppression individuelle ou vidage complet
- Panel lateral dedie dans l'UI

---

## 7. Interface utilisateur

### 7.1 Layout general

```
+----------------------------------------------+
|  Titlebar macOS (zone de drag, 38px)         |
+------------+---------------------------------+
|  Sidebar   |  Contenu principal              |
|  (280px)   |                                 |
|            |  - Barre de recherche           |
|  - Nav     |  - Grille albums / Liste pistes |
|  - Playlists|  - Ecran d'accueil             |
|  - Stats   |  - Detail album/artiste         |
|  indexation|                                 |
+------------+---------------------------------+
|  Player (barre fixe en bas, 100% largeur)    |
|  [Pochette] [Controles] [Progres] [Volume]   |
|  [Specs audio : Source -> Output]            |
+----------------------------------------------+
```

### 7.2 Theme et design system

| Variable CSS | Valeur | Usage |
|---|---|---|
| `--color-bg` | `#0a0a0a` | Fond principal |
| `--color-bg-surface` | `#1a1a1a` | Surfaces elevees |
| `--color-accent` | `#4a9` | Accent vert |
| `--color-text` | `#fff` | Texte principal |
| `--color-text-muted` | `#888` | Texte secondaire |

**Caracteristiques visuelles :**
- Theme sombre integral, optimise pour sessions longues
- Transitions fluides (150-300ms)
- Sidebar style macOS (fond semi-translucide)
- Effet glassmorphism sur la barre du lecteur
- Scrollbars fines et discretes
- Etats de chargement (spinners, placeholders)
- Grille d'albums responsive (5 colonnes)

### 7.3 Vues disponibles

| Vue | Contenu |
|---|---|
| **Accueil** | Albums recemment joues + statistiques d'ecoute |
| **Albums** | Grille de pochettes avec titre/artiste |
| **Artistes** | Liste avec images d'artistes |
| **Pistes** | Tableau triable (titre, artiste, album, duree, format) |
| **Detail album** | Liste de pistes + metadonnees + pochette grande taille |
| **Detail artiste** | Discographie + image artiste |
| **Playlist** | Liste de pistes de la playlist selectionnee |

### 7.4 Recherche

- Recherche en direct (live search) avec dropdown de resultats
- Matching sur titre, artiste, album
- Panel de resultats avec navigation clavier

### 7.5 Menu contextuel

- Clic droit sur pistes et albums
- Sous-menus (liste de playlists)
- Calcul de position intelligent (viewport-aware)
- Actions : lire, ajouter a la queue, ajouter a une playlist, favoris, aller a l'artiste/album

### 7.6 Controles de lecture

| Controle | Detail |
|---|---|
| Play/Pause | Bascule |
| Precedent/Suivant | Navigation dans la queue |
| Barre de progression | Seek par clic ou drag |
| Volume | Slider + mute toggle |
| Shuffle | Lecture aleatoire |
| Repeat | Boucle (piste / all / off) |
| Specs audio | Affichage Source rate -> Output rate |

### 7.7 Selecteur de sortie audio

- Liste des peripheriques de sortie disponibles
- Selection du peripherique actif
- Toggle Hog Mode (mode exclusif)
- Indicateur du peripherique actuel

### 7.8 Drag & Drop personnalise

- Implementation custom (HTML5 drag casse dans Tauri WebView)
- Seuil de detection de 5px
- Element fantome visuel pendant le drag
- Glisser des pistes/albums vers les playlists
- Surbrillance au survol des cibles

### 7.9 Raccourcis clavier

- Espace : Play/Pause
- Fleches : Navigation
- Touches media du clavier : supportees

### 7.10 Notifications

- Systeme de toasts (messages temporaires)
- Feedback sur les actions utilisateur

---

## 8. Persistance des donnees

Tous les fichiers sont stockes dans `~/.local/share/noir/` :

| Fichier | Contenu |
|---|---|
| `config.json` | Chemins des dossiers de bibliotheque |
| `metadata_cache.json` | Metadonnees de toutes les pistes |
| `cover_cache.json` | Chemins des pochettes extraites |
| `tracks_cache.json` | Liste complete des pistes (demarrage instantane) |
| `playlists.json` | Playlists utilisateur + systeme |
| `listening_history.json` | Historique d'ecoute (1 000 entrees) |
| `added_dates_cache.json` | Dates d'import des pistes |
| `internet_not_found_cache.json` | Pochettes non trouvees en ligne |
| `covers/` | Pochettes extraites (JPEG) |
| `thumbnails/` | Miniatures 150x150 (JPEG) |

---

## 9. Dependances principales (Rust)

| Crate | Version | Role |
|---|---|---|
| `tauri` | 2 | Framework applicatif |
| `symphonia` | 0.5 | Decodage audio multi-format |
| `cpal` | 0.15 | Detection de peripheriques |
| `coreaudio-rs` | 0.11 | Streaming CoreAudio |
| `coreaudio-sys` | 0.2 | Acces HAL direct |
| `rubato` | 0.14 | Resampling FFT |
| `ringbuf` | 0.4 | Buffer lock-free |
| `crossbeam-channel` | 0.5 | Communication inter-threads |
| `parking_lot` | 0.12 | Mutex rapides |
| `rayon` | 1.8 | Parallelisme (scan bibliotheque) |
| `lofty` | 0.18 | Lecture de tags (fallback) |
| `walkdir` | 2 | Parcours de repertoires |
| `reqwest` | 0.11 | Requetes HTTP (pochettes) |
| `tauri-plugin-dialog` | 2 | Selecteur de fichiers natif |

---

## 10. API IPC (Tauri Commands)

Le backend expose **61 commandes Tauri** au frontend, organisees par domaine :

### Audio
`play_track`, `pause_audio`, `resume_audio`, `stop_audio`, `audio_seek`, `set_volume`, `get_audio_state`, `get_audio_devices`, `set_audio_device`, `set_hog_mode`, `get_hog_mode`, `audio_preload_next`

### Bibliotheque
`scan_library`, `get_tracks`, `get_cached_tracks`, `get_albums`, `get_artists`, `get_album_tracks`, `get_artist_albums`, `get_library_stats`, `add_library_path`, `remove_library_path`, `get_library_paths`

### Metadonnees & Pochettes
`get_track_metadata`, `get_cover_art`, `get_cover_art_base64`, `get_thumbnail`, `search_internet_cover`, `get_artist_image`

### Playlists
`get_playlists`, `create_playlist`, `rename_playlist`, `delete_playlist`, `add_to_playlist`, `remove_from_playlist`, `get_playlist_tracks`, `toggle_favorite`, `is_favorite`

### Historique
`record_listen`, `get_listening_history`, `get_recently_played`, `get_top_artists`

### Recherche
`search_library`

### Evenements emis (backend -> frontend)
`scan_progress`, `scan_complete`, `audio_progress`, `audio_ended`, `audio_error`, `device_changed`

---

## 11. Performances et fiabilite

### Performances

| Aspect | Implementation |
|---|---|
| Demarrage | < 50ms (cache JSON) |
| Scan bibliotheque | Parallele (Rayon, tous les coeurs) |
| Audio callback | Lock-free (aucun mutex en thread temps-reel) |
| Buffer | 5 secondes (absorbe les pics I/O) |
| Seek | ~200ms (AudioUnitReset + pre-fill 300ms) |
| Progression UI | Interpolation 30 FPS |
| Thumbnails | Batch, JPEG, filtre Triangle |

### Fiabilite

| Aspect | Implementation |
|---|---|
| Decodage | Double-probe Symphonia + Lofty |
| Nettoyage | `Drop` impl (libere Hog Mode, restaure sample rates) |
| Device change | Gestion gracieuse, pas de crash |
| Resampling | Fallback automatique si bit-perfect impossible |
| Caches | Mises a jour atomiques, coherence garantie |
| Seek | Rate-limiting pour eviter le flooding |

---

## 12. Structure du code source

```
noir-tauri/
+-- src/
|   +-- index.html              (376 lignes)   - Structure HTML
|   +-- renderer.js             (7 678 lignes) - Logique frontend
|   +-- styles.css              (4 215 lignes) - Styles
+-- src-tauri/
|   +-- Cargo.toml                             - Dependances Rust
|   +-- tauri.conf.json                        - Config Tauri
|   +-- capabilities/default.json              - Permissions Tauri
|   +-- src/
|       +-- lib.rs              (2 198 lignes) - Orchestrateur + commandes IPC
|       +-- audio_engine.rs     (980 lignes)   - Moteur de lecture
|       +-- audio_decoder.rs    (781 lignes)   - Decodage + resampling
|       +-- resampler.rs        (172 lignes)   - Resampler FFT (Rubato)
|       +-- audio/
|           +-- mod.rs                         - Module audio
|           +-- backend.rs                     - Trait abstrait backend
|           +-- coreaudio_backend.rs (934 l.)  - HAL macOS
|           +-- coreaudio_stream.rs  (557 l.)  - AudioUnit stream
+-- package.json                               - Dependances frontend
```

**Total estime : ~17 900 lignes de code**

---

## 13. Axes d'evolution identifies

| Domaine | Possibilite |
|---|---|
| Multi-plateforme | Backend WASAPI pour Windows (infrastructure trait prete) |
| DSP | Egaliseur, chaine de traitement audio |
| Visualiseur | FFT disponible via Rubato, visualisations spectrales |
| Scrobbling | Integration Last.fm |
| Streaming reseau | Sources HTTP/HTTPS |
| UI avancee | Virtual scrolling pour tres grandes bibliotheques, affichage waveform, paroles, mini-player |
| Gapless | Pre-chargement de la piste suivante (`audio_preload_next` prevu) |

---

## 14. Roadmap d'optimisation

Plan d'optimisation priorise par ordre d'execution recommande. Chaque chantier est documente avec son diagnostic precis, la solution cible, les risques de regression et les evolutions qu'il debloque.

---

### PHASE 1 — Quick wins (1 journee, risque quasi nul)

#### 1.1 Stopper la boucle RAF quand idle

**Diagnostic :**
`startPositionInterpolation()` lance un `requestAnimationFrame` perpetuel qui tourne meme quand aucune piste n'est en lecture. Il return early mais consomme un cycle RAF par frame (60/s), soit ~2-5% CPU en permanence.

**Solution :**
- `cancelAnimationFrame(interpolationAnimationId)` dans les handlers pause/stop
- `startPositionInterpolation()` dans le handler play/resume

**Risques de regression :** Quasi nul. Seul risque : oublier de relancer la boucle, ce qui figerait la barre de progression. Testable en 30 secondes.

**Consequence UX :** Aucune visible. Reduction de la consommation CPU au repos, meilleure autonomie batterie sur MacBook.

**Evolutions debloquees :** Permet d'ajouter d'autres boucles RAF (visualiseur, VU-metre) sans accumuler de cout CPU quand elles sont inactives.

**Complexite :** ~10 lignes de code.

---

#### 1.2 Fix animations CSS

**Diagnostic :**
- `.btn-sort-icon` utilise `transition: all 0.15s ease` qui transite toute propriete, y compris celles qui declenchent un recalcul layout
- Les `.tracks-list-item` transitent `background`, ce qui trigger un repaint par element sur chaque hover (~50 items visibles)
- La selection `.selected` ajoute `border-left: 3px` + change `padding-left`, ce qui trigger un recalcul layout pour chaque item selectionne
- Les 3 animations SVG wave sur la home page animent `d: path(...)` en CSS, forcant le navigateur a re-parser et re-rasteriser le path SVG a chaque frame

**Solution :**
- `transition: all` -> `transition: color 0.15s, background-color 0.15s` (cible les proprietes exactes)
- `border-left: 3px` -> `box-shadow: inset 3px 0 0 var(--color-accent)` (pas de changement de box model)
- SVG path animations -> `transform: translateY()` sur des shapes simples (GPU-composite)
- Ajouter `will-change: transform` sur les items du virtual scroll

**Risques de regression :** Faible. Le remplacement de `border-left` par `box-shadow` peut avoir un rendu visuel legerement different (pas de decalage du contenu). A verifier visuellement.

**Consequence UX :** Home page moins gourmande en CPU. Hover sur les pistes plus fluide.

**Evolutions debloquees :** Libere du budget GPU/CPU pour des animations plus riches (transitions de vue, effets de pochette, visualiseur spectral).

**Complexite :** ~1-2h, modifications CSS uniquement.

---

#### 1.3 Debounce + index de recherche

**Diagnostic :**
`getSortedAndFilteredTracks()` trie un clone de l'integralite du tableau de pistes (O(N log N)) puis filtre avec `.toLowerCase().includes()` sur chaque piste (O(N * M)), et ce a chaque frappe clavier. Sur une bibliotheque de 10K pistes, chaque touche declenche un tri complet + re-rendu.

**Solution :**
- Debounce de 150-200ms sur l'input de recherche
- Construire un index inverse `Map<string, Set<trackId>>` au chargement de la bibliotheque (mots extraits de titre, artiste, album)
- Le mettre a jour sur `scan_complete`
- La recherche devient un lookup O(1) dans la Map + intersection de Sets

**Risques de regression :** Faible. Le debounce est sans risque. L'index doit etre maintenu a jour lors des scans et modifications de playlists, mais c'est un ajout, pas une modification du code existant.

**Consequence UX :** Resultats de recherche quasi-instantanes (<16ms) au lieu d'un lag perceptible sur les grandes bibliotheques.

**Evolutions debloquees :** L'index inverse permet d'ajouter facilement la recherche fuzzy, l'autocompletion, et la recherche par metadonnees etendues (genre, annee, label).

**Complexite :** Debounce : 5 lignes. Index : construire la Map au chargement. ~1-2h total.

---

### PHASE 2 — Stabilite du runtime (effort faible, gain majeur)

#### 2.1 Async pour les appels HTTP

**Diagnostic :**
Toutes les fonctions `fetch_internet_cover`, `fetch_artist_image`, `fetch_cover_from_musicbrainz`, `fetch_artist_image_from_deezer`, `fetch_artist_image_from_musicbrainz` utilisent `reqwest::blocking::Client` dans des `#[tauri::command]`. Ces commandes tournent sur le runtime Tokio. Un appel bloquant avec timeout de 5s affame le runtime : les autres commandes (y compris les controles audio) attendent qu'un thread se libere. Le `std::thread::sleep(Duration::from_millis(300))` pour le rate limiting MusicBrainz bloque un thread du runtime pendant 300ms.

**Solution :**
- Remplacer `reqwest::blocking::Client` par `reqwest::Client` (async)
- Marquer les commandes avec `#[tauri::command(async)]`
- Remplacer `std::thread::sleep` par `tokio::time::sleep`
- Alternative minimale : wrapper les appels dans `tokio::task::spawn_blocking`

**Risques de regression :** Faible. Le passage blocking -> async est bien documente dans reqwest. Seul risque : un appel bloquant residuel oublie qui freezerait le runtime Tokio.

**Consequence UX :** Plus aucun gel de l'UI pendant la recherche de pochettes en ligne. Les controles audio (play, pause, seek) restent reactifs meme pendant un fetch MusicBrainz/Deezer.

**Evolutions debloquees :** Permet d'ajouter du fetch concurrent (plusieurs pochettes en parallele), des retries intelligents, et du streaming reseau (sources HTTP).

**Complexite :** ~2h. Changer `reqwest::blocking::get` en `reqwest::get().await` dans chaque fonction concernee.

---

### PHASE 3 — Memoire (le plus gros gain mesurable)

#### 3.1 Protocole Tauri custom pour les pochettes

**Diagnostic :**
`coverCache` dans `renderer.js` est un `Map<string, string>` sans aucune politique d'eviction. Chaque pochette est stockee en base64 data URI. Une image de 500 KB source produit ~700 KB en base64 (+33% inflation). Pour 1 000 albums : ~700 MB en memoire dans le processus WebView. Pour 5 000+ albums : multi-GB, crash probable.

De plus, chaque pochette transite integralement par IPC (serialisation JSON du base64), ce qui est un double cout : memoire + CPU de serialisation.

**Solution :**
- Enregistrer un protocole Tauri custom (`noir://covers/{hash}.jpg`, `noir://thumbnails/{hash}_thumb.jpg`)
- Le handler Rust lit le fichier depuis le disque et renvoie un stream binaire avec le bon Content-Type
- Cote JS, remplacer tous les `src="data:image/..."` par `src="noir://covers/{hash}.jpg"`
- Le WebView gere alors le cache nativement (cache HTTP integre), pas besoin de `coverCache` JS
- Supprimer le `Map` coverCache et les commandes `get_cover_art_base64`

**Risques de regression :** Moyen. Le passage de base64 a un protocole custom change le contrat IPC pour toutes les images. Si le mapping hash -> fichier est desynchronise, pochettes manquantes. Toutes les vues (home, albums, detail, queue, player) doivent etre mises a jour.

**Consequence UX :** Elimination des ralentissements et freezes sur les grandes bibliotheques. Navigation plus fluide, consommation RAM divisee par 10+ pour les pochettes.

**Evolutions debloquees :** Lazy-loading avance, zoom sur pochettes HD, cache disque persistant cote WebView. Prerequis pour supporter des bibliotheques de 50K+ pistes.

**Complexite :** Moyenne. Tauri 2 supporte les custom protocols nativement (`tauri::protocol::asset`). Le gros du travail est de remplacer tous les `src` dans le JS et de tester chaque vue.

---

### PHASE 4 — Fluidite du rendu (grandes bibliotheques)

#### 4.1 Recyclage DOM dans le virtual scroll

**Diagnostic :**
`updateVirtualScrollItems()` reconstruit `innerHTML` pour tous les elements visibles a chaque changement de position de scroll. Cela detruit et recree des noeuds DOM a chaque frame de scroll, generant une pression GC constante et des micro-saccades visibles pendant le scroll rapide.

**Solution :**
- Maintenir un pool fixe d'elements DOM (~50 items), positionnes en `position: absolute`
- Sur scroll, ne mettre a jour que `style.top` et le contenu texte des elements recycles
- Ne jamais appeler `innerHTML` pendant un scroll
- Pattern identique a iOS UITableView / Android RecyclerView

**Risques de regression :** Moyen. Le recyclage DOM change fondamentalement la logique de rendu des pistes. Risques : desynchronisation entre position de scroll et contenu affiche, elements "fantomes" apres un scroll rapide, bugs de selection si les refs DOM sont recyclees, handlers d'evenements attaches aux mauvais elements.

**Consequence UX :** Scroll parfaitement fluide a 60 fps meme sur des bibliotheques de 20K+ pistes. Elimination des micro-saccades.

**Evolutions debloquees :** Permet d'ajouter des fonctionnalites couteuses par row (waveform miniature, indicateur de qualite audio, pochette inline) sans degrader les performances.

**Complexite :** Moyenne. Le pattern est bien connu. Le plus delicat est de gerer correctement la selection, le drag & drop et les event listeners sur des elements recycles.

---

### PHASE 5 — Architecture audio (refactoring profond)

#### 5.1 RwLock sur les caches + message passing pour le moteur audio

**Diagnostic :**
7 `Lazy<Mutex<T>>` independants. Chaque commande Tauri verrouille un ou plusieurs Mutex en sequence :
- Risque de deadlock si deux commandes verrouillent les caches dans un ordre different (fragile, le code actuel l'evite par chance)
- Le Mutex sur `AUDIO_ENGINE` bloque pendant `engine.play()` : si l'ouverture du fichier prend du temps, tous les autres commandes audio (seek, pause, volume) sont bloquees
- Pendant le scan, `get_metadata_internal` verrouille `METADATA_CACHE` par fichier. Avec Rayon sur tous les coeurs, c'est N lock/unlock, et le UI entre en competition pour le meme lock

**Solution :**
- Remplacer `Mutex` par `RwLock` sur les caches (lecture concurrente, ecriture exclusive) : les caches sont lus ~100x plus qu'ecrits
- Remplacer le Mutex sur `AUDIO_ENGINE` par du message passing (channel `crossbeam`, deja en dependance) : les commandes Tauri envoient un message, le moteur traite dans son propre thread, zero contention
- Regrouper les caches dans un seul `AppState` avec un ordre de verrouillage documente pour eliminer les deadlocks
- Pendant le scan, accumuler les metadonnees localement puis ecrire en batch (un seul lock en ecriture a la fin)

**Risques de regression :** Eleve. Refactoring profond du coeur de l'app. Le passage Mutex -> channel change le flow de controle du moteur audio. Risques : race conditions sur les transitions de piste, messages perdus, ordre des commandes non garanti si mal implemente, regressions sur seek/pause/stop.

**Consequence UX :** Seek, pause, volume instantanes meme pendant un scan de bibliotheque. Fin des micro-freezes quand le moteur audio est occupe a ouvrir un fichier.

**Evolutions debloquees :** Architecture prerequise pour le vrai gapless (le moteur doit pouvoir recevoir des commandes pendant qu'il decode). Permet aussi d'ajouter un DSP chain sans bloquer les controles.

**Complexite :** Elevee. Creer un thread dedie avec une boucle `recv()`, remplacer les appels directs `engine.play()` par des `tx.send(Command::Play)`. Tester toutes les combinaisons (seek pendant play, pause pendant seek, device change pendant transition).

---

### PHASE 6 — Qualite audio audiophile

#### 6.1 Vrai gapless (double-buffering)

**Diagnostic :**
`audio_preload_next` existe dans l'API mais n'est pas implemente reellement. La transition entre pistes suit ce chemin : fin de piste -> detection (3 callbacks vides comme seuil) -> chargement piste suivante -> decodage -> pre-fill 500ms -> lecture. Resultat : gap audible de ~200-500ms entre les pistes.

C'est le point qui separe le plus Noir d'Audirvana. Les albums live, concept, classiques et les mix DJ sont inutilisables sans gapless.

**Solution :**
- Implementer un second `AudioDecoder` pre-initialise pour la piste N+1
- Pendant la lecture de N, decoder les premieres secondes de N+1 dans un buffer secondaire
- Le decodeur de la piste N signale explicitement `EndOfStream` (remplace le seuil de 3 callbacks vides)
- A la fin de N, bascule instantanee sur le buffer de N+1
- Gerer le cas ou N+1 a un sample rate different (trigger un changement de device config)

**Risques de regression :** Eleve. Introduit un second decodeur concurrent. Risques : deux decodeurs qui ecrivent dans le meme RingBuffer, synchronisation de la fin de N avec le debut de N+1, gestion memoire doublee pendant la transition, edge cases (derniere piste, shuffle qui change N+1, seek pendant la transition, repeat mode).

**Consequence UX :** Transition sans coupure entre les pistes. C'est LA feature qui differencie un lecteur audiophile d'un lecteur classique.

**Evolutions debloquees :** Prerequis pour le crossfade, le ReplayGain inter-piste, et les albums live/concept sans coupure.

**Complexite :** Elevee. Necessite la phase 5 en place (le moteur doit pouvoir recevoir des commandes pendant le decodage). Architecture a concevoir soigneusement.

**Note :** Depend de la phase 5 (message passing). Ne pas tenter sans.

---

### PHASE 7 — Maintenabilite (en continu)

#### 7.1 Modulariser renderer.js

**Diagnostic :**
Un seul fichier de 7 678 lignes, tout l'etat en variables module-level (`tracks`, `albums`, `artists`, `queue`, `playlists`, `currentTrackIndex`, `audioIsPlaying`, etc.), aucune encapsulation. N'importe quelle fonction peut muter n'importe quel global a n'importe quel moment.

Consequences actuelles :
- Modifier la queue peut casser la recherche (meme scope)
- Bugs de state silencieux impossibles a tracer
- Temps de comprehension eleve pour tout nouveau developpeur
- Impossible de tester unitairement une vue ou un composant

**Solution :**
- Decouper en ~10 modules ES :
  - `audio-controller.js` : controles de lecture, progression, volume
  - `library-store.js` : etat de la bibliotheque, tracks, albums, artistes
  - `views/home.js` : page d'accueil, carousels
  - `views/albums.js` : grille albums, detail album
  - `views/tracks.js` : virtual scroll, liste de pistes
  - `views/artists.js` : grille artistes, detail artiste
  - `search.js` : recherche, index, resultats
  - `queue.js` : file d'attente, gestion
  - `playlist.js` : playlists, favoris
  - `context-menu.js` : menus contextuels
  - `drag-drop.js` : systeme de drag & drop custom
- Centraliser l'etat dans un store simple (pattern pub/sub) pour tracer les mutations
- Chaque module exporte des fonctions pures + s'abonne aux evenements du store

**Risques de regression :** Moyen a eleve. Refactoring massif. Variables globales oubliees lors du decoupage, imports circulaires entre modules, event listeners qui referencent des fonctions deplacees, ordre d'initialisation casse. Necessite des tests manuels exhaustifs de chaque vue et interaction.

**Consequence UX :** Aucune directe. Mais reduction drastique du temps de debug et d'ajout de features.

**Evolutions debloquees :** Prerequis pour toute evolution majeure de l'UI. Permet d'isoler les bugs, de tester unitairement, d'ajouter des vues sans toucher au reste. Ouvre la porte a un eventuel passage a un framework (Svelte, Solid) module par module.

**Complexite :** Elevee. 2-3 jours minimum. Recommande de le faire incrementalement (un module a la fois) plutot qu'en big-bang.

---

### Matrice de priorisation

```
                        IMPACT
                 Faible    Moyen    Eleve    Critique
              +----------+--------+--------+----------+
  Triviale    |          |        |  1.1   |          |
              +----------+--------+--------+----------+
  Faible      |          | 1.3    |  2.1   |          |
              |          | 1.2    |        |          |
              +----------+--------+--------+----------+
COMPLEXITE    |          |        |  4.1   |  3.1     |
  Moyenne     |          |        |        |          |
              +----------+--------+--------+----------+
  Elevee      |          |        |  5.1   |  6.1     |
              |          |        |  7.1   |          |
              +----------+--------+--------+----------+
```

### Dependances entre chantiers

```
Phase 1 (quick wins) -----> aucune dependance, executable immediatement
Phase 2 (async HTTP) -----> aucune dependance
Phase 3 (protocole covers) -> aucune dependance
Phase 4 (virtual scroll) --> aucune dependance
Phase 5 (message passing) -> aucune dependance (mais beneficie de Phase 2)
Phase 6 (gapless) ---------> DEPEND DE Phase 5 (moteur audio par messages)
Phase 7 (modularisation) --> aucune dependance technique, mais facilite les Phases 3 et 4
```

---

*Specification redigee le 11 fevrier 2026 - basee sur l'analyse complete du code source de Noir Desktop (branche `main`, commit `8c807ac`).*
