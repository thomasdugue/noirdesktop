# NOIR DESKTOP — Specifications Techniques Completes (mise à jour)

> **Mise à jour** : 20 février 2026 — basée sur l'analyse complète du code source (branche `main`, fichiers modifiés non committés inclus)
> **Remplace** : NOIR_DESKTOP_SPEC.md du 11 février 2026

---

## 1. Vue d'ensemble

**Noir** est un lecteur de musique audiophile pour macOS, construit avec **Tauri 2** (backend Rust + frontend HTML/CSS/JS vanilla). L'application privilégie la lecture bit-perfect, le démarrage instantané et une interface sombre optimisée pour les longues sessions d'écoute.

| Propriété | Valeur |
|---|---|
| **Identifiant** | `com.tdugue.noir` |
| **Framework** | Tauri 2 |
| **Backend** | Rust |
| **Frontend** | HTML5 + CSS3 + JavaScript vanilla |
| **Plateforme cible** | macOS (CoreAudio natif) |
| **Fenêtre par défaut** | 1200×800px (min 320×400), transparente, titlebar overlay |
| **Typographie** | Geist Mono (variable, monospace) |
| **Version** | 0.1.0 |

---

## 2. Architecture globale

```
+-----------------------------------------------------+
|                    FRONTEND                          |
|  index.html (630 l.) + renderer.js (10 258 l.)      |
|  styles.css (5 890 l.) + fonts/GeistMono-Variable    |
|  Communication via Tauri IPC (invoke/listen)         |
+------------------------+----------------------------+
                         | Tauri Commands (59 commandes)
+------------------------v----------------------------+
|                  BACKEND RUST                        |
|  lib.rs (3 271 l.) - Orchestrateur principal         |
|  +------------------------------------------------+ |
|  |           MODULE AUDIO                         | |
|  |  audio_engine.rs (981 l.)   - Moteur lecture   | |
|  |  audio_decoder.rs (780 l.)  - Décodage         | |
|  |  resampler.rs (171 l.)      - Rééchantillonnage| |
|  |  eq.rs (234 l.)             - EQ 8 bandes      | |
|  |  audio/backend.rs (174 l.)  - Trait abstrait    | |
|  |  audio/coreaudio_backend.rs (941 l.) - HAL     | |
|  |  audio/coreaudio_stream.rs (621 l.)  - Stream  | |
|  |  audio/types.rs (125 l.)    - Types partagés   | |
|  |  audio/error.rs (52 l.)     - Types d'erreur   | |
|  |  audio/stream.rs (110 l.)   - Trait stream     | |
|  |  audio/mod.rs (51 l.)       - Module exports   | |
|  +------------------------------------------------+ |
+-----------------------------------------------------+
                         |
              macOS CoreAudio HAL → DAC → Sortie audio
```

**Total : ~24 289 lignes de code**

---

## 3. Chaîne audio complète

### 3.1 Pipeline de lecture

```
Fichier audio
    │
Symphonia Decoder (ou Lofty fallback pour M4A/AAC)
    │ f32 interleaved
[Resampler Rubato FFT] ← seulement si le DAC ne supporte pas le sample rate source
    │
RingBuffer lock-free (5 secondes de capacité, HeapRb<f32>)
    │ (consumer, thread temps-réel)
CoreAudio AudioUnit Callback
    │ Égaliseur 8 bandes (biquad IIR, si activé)
    │ Application du volume (f32 × volume)
CoreAudio HAL → DAC → Enceintes/Casque
```

### 3.2 Formats supportés

| Format | Codec | Notes |
|---|---|---|
| FLAC | Symphonia | 16/24-bit, jusqu'à 384 kHz |
| WAV | Symphonia | PCM |
| MP3 | Symphonia | CBR/VBR |
| AAC/M4A | Symphonia + Lofty fallback | Double-probe pour fiabilité |
| ALAC | Symphonia | Apple Lossless |
| Vorbis/OGG | Symphonia | |
| WMA | Symphonia | |
| AIFF | Symphonia | |

### 3.3 Lecture bit-perfect

1. Le moteur détecte le sample rate du fichier source
2. Tente de configurer le DAC au même sample rate via `kAudioDevicePropertyNominalSampleRate`
3. **Si succès** : lecture bit-perfect (pas de resampling)
4. **Si échec** : fallback avec resampling FFT haute qualité (Rubato, chunks de 1024 samples)

**Indicateur visuel** : effet "silver shine" sur les specs audio quand la lecture est bit-perfect.

### 3.4 Hog Mode (mode exclusif)

- Accès exclusif au périphérique audio via `kAudioDevicePropertyHogMode`
- Empêche les autres applications d'utiliser le DAC
- Libération automatique à la fermeture (implémentation `Drop`)
- Restauration automatique du sample rate original
- Gestion correcte du changement de device pendant le Hog Mode (`hog_locked_device` flag)

### 3.5 Seek instantané

| Étape | Détail |
|---|---|
| 1 | Frontend debounce 100ms |
| 2 | `audio_seek(time)` → AudioEngine |
| 3 | Flag `seeking = true` (avant envoi commande) |
| 4 | `AudioUnitReset()` - flush du buffer interne CoreAudio (~50ms) |
| 5 | Symphonia seek + reset décodeur |
| 6 | Pré-remplissage 300ms dans le RingBuffer |
| 7 | `seeking = false` → reprise de la sortie |
| **Latence totale** | **~200ms** |

### 3.6 Suivi de périphérique (Device Following)

- Détection automatique du changement de périphérique par défaut
- Hot-swap casque/DAC transparent
- Reconfiguration automatique du stream audio
- Aucune interruption perceptible de la lecture
- Fallback vers le device par défaut si le device manuel est débranché

### 3.7 Égaliseur 8 bandes

| Propriété | Valeur |
|---|---|
| **Type** | Biquad IIR (PeakingEQ) via crate `biquad 0.4` |
| **Bandes** | 32, 64, 250, 1k, 2k, 4k, 8k, 16 kHz |
| **Plage** | -12 dB à +12 dB par bande |
| **Q** | Butterworth (Q_BUTTERWORTH_F32) |
| **Topologie** | DirectForm1, cascade de 8 filtres |
| **Thread safety** | Gains partagés via AtomicU32, filtres locaux au callback |
| **Bypass** | Automatique quand gain ≈ 0 dB (bit-perfect préservé) |
| **Persistance** | État sauvegardé dans settings.json |

**Presets prédéfinis** : Flat, Bass Boost, Treble Boost, Loudness, Vocal, Rock, Jazz, Classical, Electronic, Hip-Hop, Late Night.

**UI** : Courbe SVG interactive avec 8 points draggables, sélecteur de presets, toggle on/off. Accessible depuis le sélecteur de sortie audio dans le player.

**Compatibilité AutoEQ** : La structure biquad (PeakingEQ, freq, gain, Q) est identique au format AutoEQ. Intégration future prévue pour les profils par modèle de casque.

### 3.8 Gapless playback (lecture sans coupure)

- Pré-chargement de la piste N+1 via `audio_preload_next`
- Second consumer RingBuffer préparé pendant la lecture de N
- Détection de fin de piste : 3+ callbacks vides + `decoding_complete`
- Basculement instantané vers le buffer pré-chargé (swap consumer/state)
- Support du changement de sample rate entre pistes
- Toggle activable/désactivable dans les paramètres

### 3.9 Progression UI

- Émission d'événements de progression à **~30 FPS** depuis le callback audio
- Interpolation côté frontend (requestAnimationFrame) pour fluidité 60 FPS
- Position trackée atomiquement dans le callback audio
- RAF stoppé quand la lecture est en pause (0% CPU au repos)

---

## 4. Gestion de la bibliothèque

### 4.1 Démarrage instantané

```
Lancement de l'app
    │
Chargement de tracks_cache.json (< 50ms)
    │
Affichage immédiat de la bibliothèque
    │ (en parallèle, thread séparé)
Scan en arrière-plan avec événements de progression
    │
Émission du diff (pistes ajoutées/supprimées)
    │
Enrichissement des genres (Deezer/MusicBrainz, optionnel)
    │
Mise à jour du cache
```

### 4.2 Scan de la bibliothèque

- **Parcours récursif** des dossiers configurés (walkdir)
- **Chargement parallèle des métadonnées** via Rayon (tous les coeurs CPU)
- **Double-probe** : Symphonia en premier, Lofty en fallback
- **Événements de progression** émis dossier par dossier vers le frontend
- Support de **plusieurs chemins de bibliothèque**
- Détection des chemins inaccessibles avec événement `library_paths_inaccessible`

### 4.3 Métadonnées extraites

| Champ | Source |
|---|---|
| Titre | Tag ID3/Vorbis/MP4 |
| Artiste | Tag |
| Album | Tag |
| Numéro de piste | Tag |
| Numéro de disque | Tag |
| Année | Tag |
| Genre | Tag + enrichissement Deezer/MusicBrainz |
| Durée | Probe audio |
| Bitrate | Probe audio |
| Sample rate | Probe audio |
| Bit depth | Probe audio (24-bit par défaut pour AAC) |
| Format/Codec | Extension fichier + probe |

### 4.4 Normalisation des genres

- ~160 mappings de normalisation (ex: "Electro" → "Electronic", "Hip Hop" → "Hip-Hop")
- Enrichissement post-scan via Deezer API et MusicBrainz release-groups
- Événements de progression dédiés (`genre_enrichment_progress`, `genre_enrichment_complete`)

### 4.5 Pochettes d'album (Cover Art)

**Ordre de recherche :**
1. **Embedded** — extraite du fichier audio
2. **Cache local** — `~/.local/share/noir/covers/`
3. **Internet** — recherche automatique sur :
   - MusicBrainz (Cover Art Archive)
   - Deezer API
   - Wikimedia Commons (images d'artistes)

**Protocole custom `noir://`** :
- Les pochettes sont servies via le protocole Tauri `noir://localhost/covers/{hash}.ext`
- Les thumbnails via `noir://localhost/thumbnails/{hash}_thumb.jpg`
- Header `Cache-Control: max-age=31536000, immutable` pour cache navigateur
- Élimine le pipeline base64 et réduit l'empreinte mémoire de ~700 KB/album à ~60 octets/album

**Thumbnails :**
- Générées en batch (150×150 px, JPEG, filtre Triangle)
- Stockées dans `~/.local/share/noir/thumbnails/`
- Cache des recherches internet échouées (`internet_not_found_cache.json`)
- Chargement asynchrone via queues parallèles (IntersectionObserver)

### 4.6 Historique d'écoute

- Stockage des **1 000 dernières écoutes**
- Données : piste, artiste, album, titre, horodatage
- Calcul des **top artistes** et **albums récemment joués**
- Persiste dans `listening_history.json`

### 4.7 Statistiques de bibliothèque

- Nombre total de pistes, artistes, albums
- Répartition par format (MP3, FLAC 16-bit, FLAC 24-bit)
- Affichées dans le module d'indexation de la sidebar

---

## 5. Système de playlists

| Fonctionnalité | Détail |
|---|---|
| Création | Nom personnalisé via modale |
| Renommage | Via menu contextuel ou double-clic |
| Suppression | Avec modale de confirmation |
| Ajout de pistes | Par track, par album, ou par sélection multiple |
| Réordonnement des pistes | Drag & drop dans la vue playlist |
| Réordonnement des playlists | Drag & drop dans la sidebar |
| Favoris | Playlist système "mes favoris" (toggle cœur, Cmd+H) |
| Drag & drop | Glisser des pistes/albums vers une playlist dans la sidebar |
| Persistance | `playlists.json` |

---

## 6. Système de file d'attente (Queue)

- File d'attente courante + pistes suivantes
- Affichage "Now Playing" + "Up Next" dans le panel
- Réordonnement par drag & drop
- Ajout via menu contextuel ou bouton dédié
- Suppression individuelle ou vidage complet
- Panel latéral dédié dans l'UI (toggle via bouton ou Cmd+Q)
- Indicateur visuel sur les pistes en queue dans la liste

---

## 7. Interface utilisateur

### 7.1 Layout général

```
+----------------------------------------------+
|  Titlebar macOS (zone de drag, 38px)    [⚙]  |
+------------+---------------------------------+
|  Sidebar   |  Contenu principal              |
|  (280px    |                                 |
|  resize    |  - Barre de recherche (sticky)  |
|  180-400px)|  - Home / Albums / Artistes /   |
|            |    Pistes / Détail album /      |
|  - Nav     |    Détail artiste / Playlist /  |
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

**Panels latéraux** (un seul ouvert à la fois) :
- Queue panel (droite)
- Track Info panel (droite)
- Settings panel (droite)
- EQ panel (dans le menu de sortie audio)

### 7.2 Thème et design system

| Variable CSS | Valeur | Usage |
|---|---|---|
| `--color-bg` | `#0a0a0a` | Fond principal |
| `--color-bg-light` | `#111` | Fond léger |
| `--color-bg-surface` | `#1a1a1a` | Surfaces élevées |
| `--color-bg-hover` | `#222` | États hover |
| `--color-bg-elevated` | `#333` | Bordures, élévation |
| `--color-accent` | `#fff` | Accent principal |
| `--color-text` | `#fff` | Texte principal |
| `--color-text-muted` | `#888` | Texte secondaire |
| `--color-text-dimmed` | `#666` | Texte tertiaire |
| `--color-text-faint` | `#555` | Texte désactivé |
| `--color-border` | `#222` | Bordures |
| `--color-error` | `#ff4444` | Erreurs |
| `--radius-sm/md/lg` | `2/6/8px` | Rayons de bordure |
| `--transition-fast` | `0.15s ease` | Transitions rapides |
| `--font-body` | `Geist Mono` | Typographie monospace |

**Caractéristiques visuelles :**
- Thème sombre intégral, sans mode clair
- Police monospace (Geist Mono Variable, WOFF2)
- Transitions ciblées (pas de `transition: all`)
- Sidebar style macOS avec resize handle
- Effet silver-shine sur l'indicateur bit-perfect
- Animation SVG sine-wave sur la home (pausée hors vue)
- Scrollbars fines et discrètes
- Grille d'albums/artistes responsive (auto-fit)

### 7.3 Vues disponibles

| Vue | Contenu |
|---|---|
| **Accueil (Home)** | Now Playing, Recently Played, Top Artists, Recently Played Albums, Discovery Mixes |
| **Albums** | Grille de pochettes avec tri (artiste/album, asc/desc), scrollbar alphabétique |
| **Artistes** | Grille avec images d'artistes, scrollbar alphabétique, tri (nom asc/desc) |
| **Pistes** | Tableau triable par colonne (titre, artiste, album, qualité, durée), virtual scroll |
| **Détail album** | Liste de pistes + métadonnées + pochette grande taille |
| **Détail artiste** | Discographie groupée par album + image artiste |
| **Playlist** | Liste de pistes de la playlist sélectionnée |
| **Discovery mix** | Collection thématique de pistes (Recently Played, Top Artists, etc.) |

### 7.4 Page d'accueil (Home)

- Section "Now Playing" avec pochette et contrôles
- Carousels horizontaux : Recently Played Tracks, Top Artists, Recently Played Albums
- Discovery Mixes (collections thématiques générées automatiquement)
- Nombre d'items responsive selon la largeur (`getResponsiveItemCount()`)
- Cache de 30 secondes (`HOME_CACHE_TTL`) pour éviter les rechargements
- Invalidation du cache sur changement de piste

### 7.5 Recherche

- Recherche en direct (live search) avec dropdown de résultats
- **Index inversé** `Map<mot, Set<index>>` construit au chargement
- Matching par préfixe sur titre, artiste, album
- Debounce de 200ms sur l'input
- Résultats groupés par type (pistes, albums, artistes)
- Navigation clavier (flèches, Enter, Escape)
- Recherche < 16ms même sur 10K+ pistes

### 7.6 Menu contextuel

- Clic droit sur pistes et albums
- Actions : Lire, Ajouter à la queue, Ajouter à une playlist (sous-menu), Aller à l'album, Aller à l'artiste, Info, Supprimer de la bibliothèque
- Sous-menus dynamiques (liste des playlists)
- Calcul de position intelligent (viewport-aware)
- Support de la multi-sélection (labels adaptés)

### 7.7 Contrôles de lecture

| Contrôle | Détail |
|---|---|
| Play/Pause | Bascule avec debounce |
| Précédent | Retour au début (<3s) ou piste précédente |
| Suivant | Priorité : queue > album séquentiel > repeat |
| Barre de progression | Seek par clic ou drag |
| Volume | Slider 0-100% + mute toggle + icône adaptative |
| Shuffle | 3 modes : off → album → library → off |
| Repeat | 3 modes : off → all → one → off |
| Specs audio | Source (rate/bit) → Output (rate/bit) |

### 7.8 Sélecteur de sortie audio

- Liste des périphériques de sortie disponibles (refresh automatique)
- Sélection du périphérique actif avec indicateur "Défaut"
- Toggle Hog Mode (mode exclusif) avec tooltip explicatif
- **Section Égaliseur** avec bouton d'ouverture + toggle on/off
- Panneau EQ avec courbe SVG interactive et presets

### 7.9 Panel Track Info

- Panneau latéral avec détails complets d'une piste
- Pochette, titre, artiste, album, numéro de piste
- Bitrate, sample rate, format, bit depth
- Historique d'écoute (play count, dernière écoute)
- Chemin du fichier
- Bouton de rafraîchissement des métadonnées
- Toggle via Cmd+I

### 7.10 Drag & Drop personnalisé

- Implémentation custom (HTML5 drag cassé dans Tauri WebView)
- Seuil de détection de 5px
- Élément fantôme visuel pendant le drag
- Glisser des pistes/albums vers les playlists dans la sidebar
- Surbrillance au survol des cibles
- Support du drag d'albums complets

### 7.11 Raccourcis clavier

| Raccourci | Action |
|---|---|
| Espace | Play/Pause |
| Cmd+← / Cmd+→ | Piste précédente / suivante |
| Cmd+↑ / Cmd+↓ | Volume +/- |
| Cmd+M | Toggle mute |
| Cmd+H | Toggle favori |
| Cmd+F | Focus recherche |
| Cmd+S | Cycle shuffle |
| Cmd+R | Cycle repeat |
| Cmd+I | Toggle panel Track Info |
| Cmd+Q | Toggle panel Queue |
| Escape | Fermer panel/menu actif |

- Raccourcis personnalisables dans les paramètres
- Capture de touche pour remapping
- Persistance dans localStorage
- Reset aux valeurs par défaut

### 7.12 Paramètres (Settings)

| Section | Options |
|---|---|
| **Audio** | Sélecteur de device, toggle mode exclusif, volume au démarrage |
| **Bibliothèque** | Liste des chemins, ajout/suppression de dossiers |
| **Lecture** | Auto-resume au démarrage, gapless playback |
| **Raccourcis** | Liste éditable, capture de touche, reset |
| **Mises à jour** | Auto-check toggle, vérification manuelle, version, installation |

### 7.13 Notifications

- Système de toasts (messages temporaires en bas à droite)
- Feedback sur les actions utilisateur (changement de device, erreurs, etc.)
- Animation slide-up avec auto-dismiss

### 7.14 Sidebar redimensionnable

- Largeur par défaut : 280px
- Plage : 180px – 400px
- Handle de resize avec curseur visuel

---

## 8. Persistance des données

Tous les fichiers sont stockés dans `~/.local/share/noir/` :

| Fichier | Contenu |
|---|---|
| `config.json` | Chemins des dossiers de bibliothèque |
| `metadata_cache.json` | Métadonnées de toutes les pistes |
| `cover_cache.json` | Chemins des pochettes extraites |
| `tracks_cache.json` | Liste complète des pistes (démarrage instantané) |
| `playlists.json` | Playlists utilisateur + système |
| `listening_history.json` | Historique d'écoute (1 000 entrées) |
| `added_dates_cache.json` | Dates d'import des pistes |
| `internet_not_found_cache.json` | Pochettes non trouvées en ligne |
| `settings.json` | Préférences (EQ, volume, gapless, etc.) |
| `covers/` | Pochettes extraites (JPEG/PNG) |
| `thumbnails/` | Miniatures 150×150 (JPEG) |

---

## 9. Dépendances principales (Rust)

| Crate | Version | Rôle |
|---|---|---|
| `tauri` | 2 | Framework applicatif |
| `tauri-plugin-dialog` | 2 | Sélecteur de fichiers natif |
| `tauri-plugin-opener` | 2 | Ouverture d'URLs |
| `tauri-plugin-global-shortcut` | 2 | Raccourcis globaux |
| `tauri-plugin-updater` | 2 | Auto-mises à jour |
| `symphonia` | 0.5 (all features) | Décodage audio multi-format |
| `coreaudio-rs` | 0.11 | Wrapper CoreAudio streaming |
| `coreaudio-sys` | 0.2 | Accès HAL direct |
| `core-foundation` | 0.9 | Types macOS |
| `rubato` | 0.14 | Resampling FFT |
| `biquad` | 0.4 | Filtres biquad IIR (EQ) |
| `ringbuf` | 0.4 | Buffer lock-free |
| `crossbeam-channel` | 0.5 | Communication inter-threads |
| `parking_lot` | 0.12 | Mutex rapides |
| `rayon` | 1.8 | Parallélisme (scan bibliothèque) |
| `lofty` | 0.18 | Lecture de tags (fallback) |
| `image` | 0.24 | Génération de thumbnails |
| `walkdir` | 2 | Parcours de répertoires |
| `reqwest` | 0.11 (async, JSON) | Requêtes HTTP asynchrones |
| `tokio` | 1 (rt-multi-thread, time) | Runtime async |
| `serde` / `serde_json` | 1 | Sérialisation JSON |
| `base64` | 0.21 | Encodage base64 |
| `dirs` | 5 | Chemins platform |
| `once_cell` | 1.18 | Lazy statics |
| `percent-encoding` | 2.3 | Décodage URL (protocole noir://) |

---

## 10. API IPC (Tauri Commands)

Le backend expose **59 commandes Tauri** au frontend, organisées par domaine :

### Cache & Métadonnées (14)
`init_cache`, `save_all_caches`, `scan_folder`, `scan_folder_with_metadata`, `get_metadata`, `refresh_metadata`, `load_all_metadata_cache`, `get_added_dates`, `get_cover`, `get_cover_thumbnail`, `generate_thumbnails_batch`, `fetch_internet_cover`, `fetch_artist_image`, `clear_cache`

### Bibliothèque (8)
`add_library_path`, `remove_library_path`, `get_library_paths`, `select_folder`, `load_tracks_from_cache`, `start_background_scan`, `get_library_stats`, `trigger_genre_enrichment`, `reset_genre_enrichment`

### Playlists & Favoris (10)
`get_playlists`, `create_playlist`, `rename_playlist`, `delete_playlist`, `add_track_to_playlist`, `remove_track_from_playlist`, `reorder_playlist_tracks`, `toggle_favorite`, `is_favorite`, `get_favorites`

### Audio Engine (9)
`audio_play`, `audio_pause`, `audio_resume`, `audio_stop`, `audio_seek`, `audio_set_volume`, `audio_get_state`, `audio_preload_next`, `set_gapless_enabled`

### Audio Backend & Device (7)
`get_audio_devices`, `refresh_audio_devices`, `get_current_audio_device`, `set_audio_device`, `get_audio_sample_rate`, `set_exclusive_mode`, `is_exclusive_mode`

### Égaliseur (3)
`set_eq_enabled`, `set_eq_bands`, `get_eq_state`

### Historique (6)
`record_play`, `get_listening_history`, `get_last_played`, `get_recent_albums`, `get_all_played_albums`, `get_all_played_paths`, `get_top_artists`

### Événements émis (backend → frontend)

| Événement | Données | Fréquence |
|---|---|---|
| `scan_progress` | phase, current, total, folder | Par dossier |
| `scan_complete` | stats, new_tracks, removed_tracks | Fin de scan |
| `genre_enrichment_progress` | current, total | Par piste |
| `genre_enrichment_complete` | — | Fin enrichissement |
| `library_paths_inaccessible` | paths[] | Si erreur accès |
| `playback_progress` | duration, position | ~30 FPS |
| `playback_seeking` | position | Après seek |
| `playback_paused` | — | Mise en pause |
| `playback_resumed` | — | Reprise |
| `playback_ended` | — | Fin de piste |
| `playback_loading` | bool | Chargement |
| `playback_audio_specs` | source_sr, source_bit, output_sr, ... | Par piste |
| `playback_gapless_transition` | — | Transition gapless |
| `playback_error` | code, message, details | Erreur lecture |

---

## 11. Performances et fiabilité

### Performances

| Aspect | Implémentation |
|---|---|
| Démarrage | < 50ms (cache JSON) |
| Scan bibliothèque | Parallèle (Rayon, tous les coeurs) |
| Audio callback | Lock-free (aucun mutex en thread temps-réel) |
| Buffer | 5 secondes (absorbe les pics I/O) |
| Seek | ~200ms (AudioUnitReset + pre-fill 300ms) |
| Progression UI | Interpolation 60 FPS (RAF stoppé au repos) |
| Thumbnails | Batch, JPEG, filtre Triangle |
| Recherche | < 16ms via index inversé |
| Pochettes mémoire | ~60 octets/album (URLs noir://) |
| Virtual scroll | 60 nœuds DOM recyclés (pool) |
| Transitions CSS | Propriétés ciblées (pas `transition: all`) |
| Requêtes HTTP | Asynchrones (ne bloquent pas le pool Tokio) |
| CPU au repos | < 1% (RAF stoppé, pas de polling) |

### Fiabilité

| Aspect | Implémentation |
|---|---|
| Décodage | Double-probe Symphonia + Lofty |
| Nettoyage | `Drop` impl (libère Hog Mode, restaure sample rates) |
| Device change | Gestion gracieuse, fallback vers défaut |
| Resampling | Fallback automatique si bit-perfect impossible |
| Caches | Mises à jour atomiques, cohérence garantie |
| Seek | Rate-limiting pour éviter le flooding |
| EQ | Bypass à 0 dB (bit-perfect préservé) |
| Gapless | Double-buffering avec détection de fin explicite |
| Panels | Fermeture croisée (un seul panel ouvert) |

---

## 12. Structure du code source

```
noir-tauri/
├── src/
│   ├── index.html              (630 lignes)    - Structure HTML
│   ├── renderer.js             (10 258 lignes) - Logique frontend
│   ├── styles.css              (5 890 lignes)  - Styles + design system
│   └── fonts/
│       └── GeistMono-Variable.woff2            - Police monospace variable
├── src-tauri/
│   ├── Cargo.toml                              - 26 dépendances Rust
│   ├── tauri.conf.json                         - Config Tauri + CSP + protocole noir://
│   ├── capabilities/default.json               - Permissions Tauri
│   ├── icons/                                  - 16 fichiers (PNG, ICNS, ICO)
│   └── src/
│       ├── main.rs             (6 lignes)      - Point d'entrée
│       ├── lib.rs              (3 271 lignes)  - Orchestrateur + 59 commandes IPC
│       ├── audio_engine.rs     (981 lignes)    - Moteur de lecture + gapless
│       ├── audio_decoder.rs    (780 lignes)    - Décodage + resampling + seek
│       ├── resampler.rs        (171 lignes)    - Resampler FFT (Rubato)
│       ├── eq.rs               (234 lignes)    - EQ 8 bandes (biquad IIR)
│       └── audio/
│           ├── mod.rs          (51 lignes)     - Module exports
│           ├── backend.rs      (174 lignes)    - Trait AudioBackend
│           ├── types.rs        (125 lignes)    - DeviceInfo, ExclusiveMode, SampleRate
│           ├── error.rs        (52 lignes)     - AudioBackendError
│           ├── stream.rs       (110 lignes)    - Trait AudioOutputStream
│           ├── coreaudio_backend.rs (941 l.)   - HAL macOS (device control)
│           └── coreaudio_stream.rs  (621 l.)   - AudioUnit stream + callback
└── package.json                                - Dépendances frontend (Tauri CLI)
```

**Total : ~24 289 lignes de code** (17 Rust + 17 Frontend, avec overlap de structure)

---

## 13. Axes d'évolution identifiés

| Domaine | Possibilité | Statut |
|---|---|---|
| Multi-plateforme | Backend WASAPI pour Windows (infrastructure trait prête) | Prévu |
| DSP avancé | AutoEQ (profils par modèle de casque) | Prévu (structure biquad compatible) |
| Visualiseur | FFT disponible via Rubato, visualisations spectrales | Envisagé |
| Scrobbling | Intégration Last.fm | Envisagé |
| Streaming réseau | Sources HTTP/HTTPS | Envisagé |
| UI avancée | Waveform, paroles, mini-player | Envisagé |
| Crossfade | Transition douce entre pistes | Envisagé |
| ReplayGain | Normalisation du volume inter-pistes | Envisagé |
| Modularisation JS | Découper renderer.js en ~10 modules ES | Phase 7 |

---

## 14. Roadmap d'optimisation

### État d'avancement

| Phase | Titre | Statut |
|---|---|---|
| **Phase 1** | Quick wins (RAF idle, CSS, search index) | ✅ Terminée |
| **Phase 2** | Async HTTP (reqwest) | ✅ Terminée |
| **Phase 3** | Protocole custom noir:// (pochettes) | ✅ Terminée |
| **Phase 4** | Recyclage DOM (virtual scroll) | ✅ Terminée |
| **Phase 5** | RwLock + message passing | 📋 Planifiée |
| **Phase 6** | Gapless (double-buffering) | ✅ Implémenté |
| **Phase 7** | Modularisation renderer.js | 📋 Planifiée |

### Phases restantes

#### Phase 5 — Architecture audio (refactoring profond)

**Objectif** : Remplacer les 7 `Lazy<Mutex<T>>` par `RwLock` sur les caches + message passing pour le moteur audio.

**Bénéfice** : Seek, pause, volume instantanés même pendant un scan de bibliothèque. Fin des micro-freezes quand le moteur audio ouvre un fichier.

**Complexité** : Élevée.

#### Phase 7 — Modularisation renderer.js

**Objectif** : Découper les 10 258 lignes en ~10 modules ES (audio-controller, library-store, views/*, search, queue, playlist, context-menu, drag-drop).

**Bénéfice** : Réduction du temps de debug, testabilité, maintenabilité.

**Complexité** : Élevée (2-3 jours, recommandé en incrémental).

### Matrice de priorisation (mise à jour)

```
                        IMPACT
                 Faible    Moyen    Élevé    Critique
              +----------+--------+--------+----------+
  Triviale    |          |        | ✅ 1.1 |          |
              +----------+--------+--------+----------+
  Faible      |          | ✅ 1.3 | ✅ 2.1 |          |
              |          | ✅ 1.2 |        |          |
              +----------+--------+--------+----------+
COMPLEXITÉ    |          |        | ✅ 4.1 | ✅ 3.1   |
  Moyenne     |          |        |        |          |
              +----------+--------+--------+----------+
  Élevée      |          |        |  5.1   | ✅ 6.1   |
              |          |        |  7.1   |          |
              +----------+--------+--------+----------+
```

### Dépendances entre chantiers

```
✅ Phase 1 (quick wins) ------> aucune dépendance ✅ FAIT
✅ Phase 2 (async HTTP) ------> aucune dépendance ✅ FAIT
✅ Phase 3 (protocole covers) -> aucune dépendance ✅ FAIT
✅ Phase 4 (virtual scroll) --> aucune dépendance ✅ FAIT
📋 Phase 5 (message passing) -> aucune dépendance (bénéficie de Phase 2)
✅ Phase 6 (gapless) ---------> implémenté avant Phase 5
📋 Phase 7 (modularisation) --> aucune dépendance technique
```

---

*Spécification mise à jour le 20 février 2026 — basée sur l'analyse complète du code source de Noir Desktop (branche `main`).*
