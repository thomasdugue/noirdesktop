# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Dev — from noir-tauri/ directory
npm run tauri dev                  # Rust build + native macOS window
cd src-tauri && cargo check        # Rust type-check only (fast)
cd src-tauri && cargo clippy       # Rust lints
cd src-tauri && cargo test         # Rust unit tests (resampler, etc.)
cd src-tauri && cargo build --release  # Optimized build (LTO + strip)

# JS syntax check (no bundler — node --check is the only static analysis)
for f in src/*.js; do node --check "$f" && echo "OK: $f"; done
```

There is no JS linter config and no bundler. The frontend is served as-is from `src/` (`tauri.conf.json` → `frontendDist: "../src"`).

```bash
# JS tests (Jest, 4 test files in src/__tests__/)
npm test -- --watchAll=false          # Run once
npm test -- --watchAll=false --testPathPattern=FormatDisplay  # Single test file
```

Test files: `FormatDisplay.test.js`, `Navigation.test.js`, `PlayerControls.test.js`, `AlbumView.test.js`. Many tests are skipped (require Tauri `invoke` which isn't available in Node test environment).

The `.claude/launch.json` entry (name: `"noir-tauri"`) runs `npm run tauri dev` with env vars sourced from `scripts/.env.local`. Used by `preview_start` to start the dev server in Claude sessions. The native window opens; there is no browser URL to preview.

## Architecture

**Tauri v2 desktop app — macOS primary target.**

```
src/           Vanilla JS (ES6 modules) + CSS + HTML — no bundler
src-tauri/     Rust backend (Tauri commands + audio engine)
```

### Frontend — 18 JS modules

The JS was refactored (Feb 2026) from a 9 600-line monolith into:

| Module | Lines | Role |
|--------|-------|------|
| `renderer.js` | ~830 | Orchestrator: registers all module functions on `app`, settings panel, sidebar resize, `init()` |
| `app.js` | ~109 | **Mediator**: ~95 `null` slots filled at init — the only way modules call each other |
| `state.js` | ~205 | **Centralized mutable state** (see below) |
| `views.js` | ~3 100 | All view rendering: home, albums/artists grids, album/artist/mix pages, virtual scroll (60-node pool). `transitionView` is async (supports `await renderFn()`) |
| `playback.js` | ~2 050 | Audio control via Rust invoke: play/pause/seek/volume, gapless preload, 60fps position interpolation, hog mode status, media keys sync |
| `panels.js` | ~1 354 | Queue panel, track info panel (+ inline metadata editing), context menus (single/multi/album), bulk edit modal |
| `playlists.js` | ~1 495 | Playlists CRUD, favorites, add-to-playlist menus |
| `library.js` | ~934 | Cover loading (thumbnail/full/internet/artist), metadata, library scanning, indexation UI |
| `network.js` | ~882 | NAS/SMB source management, share browser modal, `browseFolder`, `saveNetworkSource`, connect/disconnect flow |
| `dap-sync.js` | ~1 695 | **DAP Sync module** — SD card/USB synchronization (see detailed section below) |
| `fullscreen-player.js` | ~416 | Fullscreen immersive view: particle system (3 phases), color extraction from cover art |
| `shortcuts.js` | ~555 | Configurable local shortcuts + global media keys (Cmd+Shift+P/Right/Left fallbacks), persisted to localStorage. F7/F8/F9 intentionnellement absents (conflictent avec Apple Music) |
| `eq.js` | ~392 | EQ panel UI (8-band parametric), connects to `set_eq_bands` Tauri command |
| `search.js` | ~337 | Inverted index, multi-word scoring, 200ms debounce, result panel |
| `feedback.js` | ~222 | Floating feedback button + modal (bug/feature/other), saves to local JSON via Tauri `submit_feedback` |
| `drag.js` | ~182 | Custom drag (mousedown/move/up) — HTML5 drag is broken in Tauri WebView |
| `utils.js` | ~350 | Pure utilities: `showToast`, `escapeHtml`, `formatTime`, `setManagedTimeout`, `createParticleCanvas` |
| `lyrics.js` | ~220 | Lyrics panel (lrclib.net, lyrics.ovh fallback) |
| `onboarding.js` | ~1 100 | Onboarding flow (6 steps): library path selection, NAS discovery, SMB auth/browse, scan progress. Shown when `savedPaths.length === 0 && networkSources.length === 0` |
| `auto-update.js` | ~103 | Auto-update check via Tauri updater plugin |

### State objects (`state.js`)

Shared by reference across all modules. **Never reassign — only mutate properties.**

| Object | Key fields |
|--------|-----------|
| `playback` | `currentTrackIndex`, `audioIsPlaying`, `currentPlayingAlbumKey`, `shuffleMode`, `repeatMode`, `volume`, `playbackContext` ('library'/'album'/null), `shufflePlayedTracks Set` |
| `library` | `tracks[]`, `albums{}`, `artists{}`, `tracksByPath Map` |
| `ui` | `currentView`, `selectedAlbumKey`, `isQueuePanelOpen`, `isTrackInfoPanelOpen`, `tracksViewOrder[]` |
| `queue` | `items[]` |
| `sort` | `column`, `direction`, `albumSortMode` |
| `caches` | `coverCache Map`, `thumbnailCache Map`, `homeDataCache` |
| `favorites` | `tracks Set` |
| `contextMenu` | `tracks[]`, `trackIndex` |
| `dom` | DOM element references cached at init |

**`playbackContext`** — détermine le comportement en fin de track/album :
- `'library'` → joué depuis la vue tracks → séquentiel selon `ui.tracksViewOrder` (ordre visuel trié/filtré)
- `'album'` → toute autre vue → s'arrête en fin d'album (pas de saut inter-album)
- `null` → indéterminé → conservateur (s'arrête en fin d'album)

**`ui.tracksViewOrder`** — mis à jour par `views.js` (`displayTracksGrid` + `updateTracksFilter`) à chaque rendu ou changement de tri/filtre. Contient les paths dans l'ordre visuel de la vue tracks. Utilisé par `playback.js` pour la navigation séquentielle : `getNextTrackPath()`, `playNextTrack()` Step 3, et `playback_gapless_transition`. **Ne jamais naviguer avec `library.tracks[currentTrackIndex + 1]` en contexte library** — l'ordre de `library.tracks` ne correspond pas à l'ordre de la vue.

### Critical patterns

```js
// Cross-module calls always go through app mediator — NEVER import directly between modules
app.showToast('hello')        // ✅
import { showToast } from './panels.js'  // ❌ creates circular deps

// State objects are shared by reference — mutate properties, never reassign
library.tracks.length = 0; library.tracks.push(...newTracks)  // ✅
library.tracks = newTracks     // ❌ breaks other modules' reference
clearObject(library.albums)    // ✅ helper in utils.js — empties without breaking ref

// Tauri invokes must always be wrapped
try {
  const result = await invoke('command_name', { arg })
} catch (e) {
  showToast('User-facing message')
}
invoke('save_all_caches').catch(console.error)  // fire-and-forget pattern

// Event delegation on dynamic lists — never add per-item listeners
gridContainer.addEventListener('click', (e) => {
  const card = e.target.closest('.album-card')
  if (card?.dataset.albumKey) showAlbumDetail(card.dataset.albumKey, ...)
})

// Transient document-level listeners (context menu, modal close) — use AbortController
let myAbort = null
function showSomething() {
  if (myAbort) myAbort.abort()
  myAbort = new AbortController()
  document.addEventListener('click', closeHandler, { signal: myAbort.signal })
}

// network.js — modal state shared with Tauri event handlers
// Tauri events (e.g. nas_device_found) fire outside the modal's closure scope.
// currentModalState holds a reference to the live state object so event-driven
// callbacks can update the correct state. Always set on modal open, clear on close.
let currentModalState = null  // module-level in network.js

// transitionView is async — renderFn can return a Promise (e.g. displayHomeView)
// renderVersion counter cancels obsolete renders when a new transition starts
await transitionView(async () => {
  await displayHomeView()  // fetches data from Rust before building DOM
})
```

### Design system & typography

**Référence design** : `/Users/tsunami25/Documents/Thomas/Noir Design System/noir-design-system.html` — composants : `noir-btn-primary`, `noir-btn-secondary`, `noir-btn-icon`, variables, couleurs, exemples.

**Polices** :
- `DM Sans` — police principale du corps/métadonnées, définie comme `--font-sans: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif` dans `:root`
- `Geist Mono` — police mono pour éléments techniques (chemins, tailles, bitrate), chargée via `@font-face` dans `styles.css`

**Palette de couleurs** (thème sombre, monochrome) :
- `--color-bg: #0a0a0a` (fond principal)
- `--color-bg-lighter: #111` / `--color-bg-surface: #161616` / `--color-bg-hover: #1a1a1a`
- `--color-border: #222` / `--color-border-light: #333`
- `--color-text: #fff` / `--color-text-muted: #888` / `--color-text-faint: #555`
- Accent vert : `#4ade80` (statut success, badges "on DAP")
- Rouge : `#f87171` (erreurs, badges "to remove")

**Convention CSS DAP Sync** : préfixe `dap-` pour toutes les classes. Sous-préfixes : `dap-dest-` (destination bar), `dap-det-` (details panel), `dap-alb-` (album rows), `dap-sync-` (syncing view), `dap-complete-` (success view).

### Cover art resolution pipeline

**`loadThumbnailAsync(path, imgElement, artist, album)`** (`library.js`) — pipeline 4 niveaux :

1. **`thumbnailCache`** (mémoire) → instantané si déjà chargé dans cette session
2. **`get_cover_thumbnail`** (IPC Rust) → cache disque `~/.noir_desktop/thumbnails/{hash}_thumb.jpg`
3. **`get_cover`** (IPC Rust) → extraction depuis les tags du fichier audio (lofty)
4. **`fetch_internet_cover`** (IPC Rust) → MusicBrainz + CoverArtArchive (nécessite `artist` + `album` non null)

**⚠️ Contrainte `isConnected`** : `loadThumbnailFromQueue()` vérifie `imgElement.isConnected` dès l'entrée en file d'attente (ligne 400 de library.js). Si l'élément `<img>` n'est PAS connecté au DOM, la fonction retourne immédiatement sans charger la cover. Conséquence : ne JAMAIS créer un `<img>` détaché et le passer à `loadThumbnailAsync` en espérant qu'il sera inséré plus tard. L'`<img>` doit être dans le DOM AVANT l'appel. Pattern correct dans DAP sync : insérer l'`<img>` dans le wrapper `.dap-alb-art` (déjà dans le DOM), puis appeler `loadThumbnailAsync`.

**Internet cover storage** : `~/.noir_desktop/covers/internet_{md5(artist|||album)}.jpg`

### CSS layout — critical flex constraint

`.main-content` has `min-width: 0` — **do not remove**. Without it, carousels with `width: calc(100% + extra)` inflate the flex item beyond the viewport, breaking grid layouts (e.g. `.home-recent-grid` columns expand to 1492px each instead of ~268px) and preventing horizontal scroll on carousels.

```css
.main-content { flex: 1; min-width: 0; }  /* min-width: 0 is critical */
```

### Backend — Rust (`src-tauri/src/`)

| File | Role |
|------|------|
| `lib.rs` | 75+ `#[tauri::command]` functions + app setup + global cache statics |
| `audio_engine.rs` | Playback state, device switching, hog mode (bit-perfect via CoreAudio exclusive) |
| `audio_decoder.rs` | Symphonia-based decoding (FLAC/WAV/MP3/AAC/ALAC/Vorbis) + `SmbProgressiveFile` |
| `audio/coreaudio_backend.rs` | macOS CoreAudio HAL, sample rate negotiation, system default device sync |
| `audio/coreaudio_stream.rs` | CoreAudio AudioUnit stream setup + render callback, gapless transition |
| `media_controls.rs` | souvlaki wrapper — enregistre Noir dans `MPRemoteCommandCenter` pour intercepter les media keys même quand Apple Music tourne. Expose `init_media_controls`, `update_metadata`, `update_playback_state`. Émet `media-control` vers JS. |
| `eq.rs` | 8-band parametric EQ (biquad filters) |
| `resampler.rs` | Sample rate conversion (rubato FFT, 1024-sample chunks) |
| `dap_sync/` | DAP Sync subsystem: db, manifest, sync_plan, sync_engine, volumes, watcher, smb_utils (see dedicated section above) |
| `audio/types.rs` | Shared types: `AudioInfo`, `PlaybackCommand`, standard sample rates |
| `audio/backend.rs` | `AudioBackend` trait (abstraction for future WASAPI port) |

### DAP Sync subsystem — Frontend (`src/dap-sync.js`)

Module dédié à la synchronisation de Digital Audio Players (SD card, USB mass storage). Gère le cycle complet : configuration device → sélection albums → calcul du plan → exécution sync → feedback résultat.

**Sub-views** : `setup` | `albums` | `syncing` | `complete` | `disconnected` | `settings` | `first-sync`

**État local (module-level, PAS dans `state.js`)** :

| Variable | Type | Rôle |
|----------|------|------|
| `destinations` | `Array` | Liste des devices DAP configurés (depuis SQLite via `dap_get_destinations`) |
| `currentDestinationId` | `number\|null` | ID du device actif |
| `selectedAlbums` | `Set<number>` | IDs des albums sélectionnés pour sync |
| `syncPlan` | `Object\|null` | Plan de sync retourné par `dap_compute_sync_plan` |
| `isSyncing` | `boolean` | Sync en cours |
| `mountedVolumes` | `Set<string>` | Chemins des volumes montés |
| `dapSubView` | `string` | Sub-view courante |
| `syncProgress` | `Object` | Progression de la sync en cours |
| `syncResult` | `Object\|null` | Résultat de la dernière sync |
| `albumSearchFilter` | `string` | Filtre texte dans la liste |
| `currentTab` | `string` | Onglet actif : `albums` \| `artists` \| `tracks` |
| `currentSortKey` | `string` | Tri actif : `alpha-asc` \| `alpha-desc` \| `bitrate-asc` \| `bitrate-desc` \| `status` |
| `detailsExpanded` | `boolean` | Panneau détails du header device déplié/replié |
| `_copyAlbumIds` | `Set<number>` | Set pré-calculé des albumIds ayant des fichiers à copier (O(1) lookup) |
| `_deleteSourcePaths` | `Set<string>` | Set pré-calculé des source paths à supprimer (O(1) lookup) |
| `_summaryDebounceTimer` | `number\|null` | Timer du debounce de `computeAndRenderSummary` (500ms) |
| `_saveSelectionsTimer` | `number\|null` | Timer du debounce de `saveSelections` (800ms) |
| `_needsOnDapPreselection` | `boolean` | Flag : après le 1er plan, auto-désélectionner les albums pas encore sur le DAP |

**Fonctions clés** :

| Fonction | Rôle |
|----------|------|
| `initDapSync()` | Init : lance le volume watcher, charge destinations + volumes, setup event listeners |
| `openSyncPanel(dest)` | Ouvre le panneau pour un device → `loadSelections` → `navigateToDapSync` |
| `renderAlbumsView(grid)` | Vue principale : dest bar + details + tabs + search/sort + select-all + albums list + footer |
| `renderAlbumRows()` | Rendu des rows album : DocumentFragment, status badges O(1), click handlers, thumbnails batchés |
| `renderArtistRows()` | Rows par artiste : groupement albums, checkbox toggle tous les albums de l'artiste |
| `renderTrackRows()` | Rows par track : flatten de tous les albums/tracks |
| `computeAndRenderSummary()` | **Cœur** : `buildTracksForSync()` → IPC `dap_compute_sync_plan` → `precomputeSyncPlanLookups()` → `renderSummary()` → `renderDapTopBar()` → `updateStatusTagsInPlace()` |
| `debouncedComputeAndRenderSummary()` | Wrapper debounce 500ms pour `computeAndRenderSummary` |
| `precomputeSyncPlanLookups()` | Construit `_copyAlbumIds` et `_deleteSourcePaths` pour lookups O(1) |
| `updateStatusTagsInPlace()` | Met à jour les badges "on DAP" / "to add" / "to remove" sans full re-render |
| `buildTracksForSync()` | Construit le tableau `TrackForSync[]` à envoyer au backend Rust |
| `saveSelections()` | Debounced (800ms) → `_doSaveSelections()` → IPC `dap_save_selections_batch` |
| `showDapTopBar()` / `hideDapTopBar()` | Remplace la search bar par la barre d'info sync (ou restaure) |
| `updateSyncButton()` | Met à jour le bouton Sync dans la dest-bar (disabled/enabled, pulse si changements pendants) |
| `renderSummary(plan, dest)` | Panneau détails 2 colonnes (Selection + Sync) + footer (free after sync / last sync) |
| `toggleDestDetails()` | Toggle expand/collapse du panneau détails (max-height transition) |
| `startSync()` | Lance la sync : IPC `dap_execute_sync` → passe en subview `syncing` |
| `renderSidebarDestinations()` | Rendu sidebar : icône DAP, status monté/démonté, badge syncing |
| `loadThumbsBatched(queue)` | Charge les thumbnails par batch de 8 via `requestAnimationFrame` |

**Flux checkbox click** :
```
click → toggle selectedAlbums Set → chk.classList.toggle('on')
  → updateSelectAllCheckbox()  [instantané]
  → saveSelections()           [debounce 800ms → IPC dap_save_selections_batch]
  → updateSyncNowButton()      [instantané]
  → debouncedComputeAndRenderSummary()  [debounce 500ms → IPC dap_compute_sync_plan → update badges]
```

**Flux page load** :
```
openSyncPanel(dest)
  → loadSelections(dest.id)     [IPC dap_get_selections]
  → navigateToDapSync()         [ui.currentView = 'dap-sync' → displayCurrentView()]
    → renderAlbumsView(grid)    [DOM construction]
      → renderAlbumRows()       [DocumentFragment, O(1) badges, batched thumbs]
      → computeAndRenderSummary()  [async: buildTracksForSync → IPC Rust → update UI]
```

**Intégration cross-module** :
- `app.js` mediator : `openSyncPanel`, `closeSyncPanel`, `loadDapDestinations`, `refreshMountedVolumes`, `displayDapSyncView`, `hideDapTopBar`, `renderSidebarDestinations`
- `views.js` : `displayCurrentView()` appelle `app.displayDapSyncView()` pour `case 'dap-sync'`. Quand on quitte la vue DAP : `app.hideDapTopBar()` restaure la search bar, `app.renderSidebarDestinations()` désélectionne le device dans la sidebar
- `renderer.js` : importe et enregistre toutes les fonctions DAP sur `app`
- `index.html` : `<div class="dap-sync-bar hidden" id="dap-sync-bar">` dans le header (remplace la search bar), `<div id="dap-sync-destinations">` dans la sidebar

**Événements Tauri écoutés** :
- `volume_change` → `refreshMountedVolumes()` (re-détecte les volumes montés, auto-crée destinations pour nouveaux volumes amovibles)
- `dap_sync_progress` → met à jour `syncProgress`, throttled via `requestAnimationFrame`
- `dap_sync_complete` → `isSyncing = false`, `await refreshMountedVolumes()`, switch vers `complete` ou `albums`

**Auto-volume detection** : `refreshMountedVolumes()` auto-crée des destinations pour les volumes amovibles non encore configurés (USB, SD, micro SD). La contrainte UNIQUE sur `path` dans `dap_destinations` empêche les doublons. `_externalVolumes` (module-level) stocke les objets `ExternalVolume` complets du dernier refresh.

**Multi-destination modal** : `showDapSyncModal({ albumKeys, artistName })` affiche un sélecteur de destination (pills) quand plusieurs volumes sont montés. Le toggle album se fait au moment du confirm (pas avant l'ouverture). `toggleAlbumsOnDest(albumKeys, destId, action)` gère le toggle sur n'importe quelle destination. `getMountedDestinations()` filtre par volumes montés.

**Disconnected screen retry** : le Retry button utilise un fallback par `volumeName` si le path exact ne matche pas (macOS peut remonter un volume sous un path différent, e.g. `/Volumes/NAME 1`). En cas de match par nom, le path de la destination est mis à jour automatiquement en base. Feedback inline (status message + shake animation) en plus du toast.

**Optimisations de performance (critiques)** :
1. **DocumentFragment** : `renderAlbumRows()` construit toutes les rows dans un fragment, un seul appendChild → single DOM reflow
2. **O(1) status badges** : `_copyAlbumIds` (Set) et `_deleteSourcePaths` (Set) pré-calculés après chaque sync plan. Avant : `filesToCopy.some(f => f.albumId === id)` = O(n) par album = O(n²) total
3. **Debounce save** : `saveSelections()` debounced 800ms — évite d'envoyer tous les albums via IPC à chaque clic
4. **Debounce compute** : `computeAndRenderSummary()` debounced 500ms — évite de recalculer le plan Rust à chaque clic
5. **Thumbnails batchés** : `loadThumbsBatched()` charge 8 thumbnails par `requestAnimationFrame` — évite de flood l'IPC
6. **`updateStatusTagsInPlace()`** : met à jour les badges en modifiant `.innerHTML` des éléments existants au lieu de re-render toute la liste

### DAP Sync subsystem — Backend Rust (`src-tauri/src/dap_sync/`)

```
dap_sync/
├── mod.rs          — Module manifest (7 sous-modules)
├── db.rs           — SQLite : tables dap_destinations + dap_sync_selection
├── manifest.rs     — Lecture/écriture .hean-sync.json sur le device
├── sync_plan.rs    — Calcul du plan (diff manifest vs sélection)
├── sync_engine.rs  — Exécution copy/delete + écriture manifest
├── volumes.rs      — Enumération volumes USB/SD (diskutil + df)
├── watcher.rs      — Surveillance /Volumes (notify crate) → événements mount/unmount
└── smb_utils.rs    — Résolution smb:// → chemin local (parse mount output)
```

**Tables SQLite** (dans `~/.local/share/com.noir.app/dap_sync.db`) :

```sql
-- Destinations (devices DAP configurés)
CREATE TABLE dap_destinations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,                    -- /Volumes/SDCARD
    volume_name TEXT,
    folder_structure TEXT NOT NULL DEFAULT 'artist_album_track',
    mirror_mode INTEGER NOT NULL DEFAULT 1,
    show_in_sidebar INTEGER NOT NULL DEFAULT 1,
    last_sync_at TEXT,
    last_sync_albums_count INTEGER DEFAULT 0,
    last_sync_size_bytes INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sélections (quels albums syncer sur quel device)
CREATE TABLE dap_sync_selection (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    destination_id INTEGER NOT NULL REFERENCES dap_destinations(id) ON DELETE CASCADE,
    album_id INTEGER NOT NULL,
    selected INTEGER NOT NULL DEFAULT 1,
    UNIQUE(destination_id, album_id)
);
```

**Structs clés** :

| Struct | Fichier | Rôle |
|--------|---------|------|
| `DapDestination` | `db.rs` | Config device : name, path, folder_structure, mirror_mode |
| `TrackForSync` | `sync_plan.rs` | Track envoyée par le frontend : path, title, artist, album, size_bytes, album_id |
| `SyncPlan` | `sync_plan.rs` | Résultat du calcul : files_to_copy, files_to_delete, files_unchanged, enough_space |
| `SyncAction` | `sync_plan.rs` | Action individuelle : source_path, dest_relative_path, size_bytes, action, album_id |
| `SyncManifest` | `manifest.rs` | Fichier `.hean-sync.json` sur le device : liste des fichiers synchés |
| `SyncedFile` | `manifest.rs` | Fichier dans le manifest : dest_relative_path, size_bytes, quick_hash (SHA256 first+last 4KB) |
| `ExternalVolume` | `volumes.rs` | Volume détecté : name, path, total_bytes, free_bytes, is_removable |
| `SyncProgress` | `sync_engine.rs` | Événement progress : phase, current/total, current_file, bytes_copied |
| `SyncComplete` | `sync_engine.rs` | Événement fin : success, files_copied, files_deleted, duration_ms, errors |

**Commandes Tauri `dap_*`** (dans `lib.rs`) :

| Commande | Rôle |
|----------|------|
| `dap_list_external_volumes` | Liste les volumes USB/SD removable |
| `dap_get_volume_info` | Info espace d'un volume (free/total bytes) |
| `dap_save_destination` | Crée/met à jour un device DAP en base |
| `dap_get_destinations` | Liste tous les devices configurés |
| `dap_get_destination` | Récupère un device par ID |
| `dap_delete_destination` | Supprime un device + ses sélections (CASCADE) |
| `dap_eject_volume` | Éjecte un volume via `diskutil eject` |
| `dap_save_selection` | Sauvegarde une sélection album unitaire |
| `dap_save_selections_batch` | Sauvegarde batch dans une transaction |
| `dap_get_selections` | Récupère les sélections d'un device |
| `dap_read_manifest` | Lit `.hean-sync.json` du device |
| `dap_compute_sync_plan` | Calcule le plan sans exécuter (preview) |
| `dap_execute_sync` | Exécute la sync dans un thread séparé → émet `dap_sync_progress` + `dap_sync_complete` |
| `dap_cancel_sync` | Met le flag `DAP_SYNC_CANCEL` pour avorter la sync |
| `dap_start_volume_watcher` | Démarre la surveillance des montages/démontages |

**Algorithme `compute_sync_plan`** (sync_plan.rs) :
1. Lit le manifest (`.hean-sync.json`) → construit `HashMap<dest_relative_path, SyncedFile>`
2. Pour chaque track sélectionnée :
   - Calcule `dest_relative_path` depuis les métadonnées (artist/album/track) via `build_dest_path()`
   - Si le path existe dans le manifest → `unchanged` (même contenu, pas de re-copie)
   - Sinon → `files_to_copy` (utilise `track.size_bytes` du frontend, PAS `fs::metadata`)
3. Mirror mode : fichiers dans le manifest non sélectionnés → `files_to_delete`
4. Vérifie l'espace : `enough_space = net_bytes ≤ 0 || net_bytes ≤ free_bytes`

**⚠️ Décision de performance critique** : `compute_sync_plan` n'appelle PAS `fs::metadata()` sur les fichiers source pour obtenir la taille réelle. Cause : sur SMB, chaque `fs::metadata()` prend ~12ms (I/O réseau). Avec 800 fichiers à copier → **10 secondes bloquantes**. On utilise `track.size_bytes` (estimé côté JS depuis les métadonnées) à la place. La taille réelle est déterminée pendant la copie effective (`sync_engine.rs`). **NE JAMAIS réintroduire `fs::metadata` dans `compute_sync_plan`.**

**Exécution sync** (`sync_engine.rs`) — 3 phases :
1. **Delete** : supprime les fichiers du DAP non sélectionnés (mirror mode). Covers protégées du mirror mode (pas dans `selected_dest_paths`). Orphaned covers nettoyées par `cleanup_empty_dirs` après suppression.
2. **Copy + covers inline** : copie les fichiers audio via chunked I/O (256KB, cancel check par chunk) + résolution SMB. Source ouverte AVANT `create_dir_all` (prévention ghost dirs). Covers copiées inline après le dernier audio de chaque album (pas de Phase 2b séparée). `cleanup_empty_parent_dirs` après chaque erreur.
3. **Manifest** : écrit `.hean-sync.json` avec la liste des fichiers synchés + quick_hash (SHA256 first+last 4KB). `cleanup_empty_dirs` parcourt tout l'arbre en fin de sync.

**Protection anti-ghost exFAT** — 3 niveaux :
1. **Prévention** : source ouverte (`File::open`) AVANT `create_dir_all`. Si source introuvable → aucun dossier créé.
2. **Nettoyage immédiat** : `cleanup_empty_parent_dirs(dest)` après chaque erreur (File::create, write, fsync, rename). Remonte vers la racine, supprime les dossiers sans contenu réel.
3. **Nettoyage global** : `cleanup_empty_dirs(dest_path)` en fin de TOUTE sync (pas seulement cancel). Supprime les dossiers sans fichier audio (covers orphelines incluses).

**Résolution SMB** (`smb_utils.rs`) :
- `build_smb_mount_map()` parse la sortie de `mount` pour mapper `smb://host/share` → `/Volumes/share`
- `resolve_smb_path()` résout une URL SMB en chemin local via cette map
- Utilisé dans `sync_engine.rs` (copie) — PAS dans `sync_plan.rs` (calcul plan)

**Global cache statics in `lib.rs`:**

| Static | Type | Notes |
|--------|------|-------|
| `TRACKS_CACHE` | `Mutex<TracksCache>` | All tracks with metadata — source for `load_tracks_from_cache` |
| `METADATA_CACHE` | `Mutex<MetadataCache>` | Per-path metadata cache (`HashMap<String, Metadata>`) |
| `COVER_CACHE` | `Mutex<CoverCache>` | Cover art paths |
| `NETWORK_SOURCES` | `Lazy<Mutex<Vec<NetworkSource>>>` | NAS sources (loaded once at startup) |
| `PROGRESSIVE_DOWNLOADS` | `Lazy<Mutex<HashMap<PathBuf, (Arc<AtomicU64>, Arc<AtomicBool>)>>>` | Registry: temp file → (bytes_written, download_done) |
| `CURRENT_DOWNLOAD_CANCEL` | `Lazy<Mutex<Option<Arc<AtomicBool>>>>` | Cancel flag for the active SMB download thread |

**Critical — `write_metadata` must update BOTH caches:** `METADATA_CACHE` invalidation alone is not enough. When `genre_enrichment_complete` fires (background async task), the JS listener calls `load_tracks_from_cache` → replaces `library.tracks` from `TRACKS_CACHE`. If `TRACKS_CACHE` was not updated, JS-side mutations are overwritten with stale data. Always update `TRACKS_CACHE` + call `save_tracks_cache()` inside `write_metadata`.

**Tauri commands grouped by domain:**
- **Cache/metadata** (18): `scan_folder_with_metadata`, `get_cover`, `get_cover_thumbnail`, `fetch_internet_cover`, `fetch_artist_image`, `load_tracks_from_cache`, `start_background_scan`, `write_metadata`, …
- **Playlists** (11): `get_playlists`, `create_playlist`, `add_track_to_playlist`, `toggle_favorite`, `export_playlist_m3u`, `import_playlist_m3u`, …
- **Audio playback** (9): `audio_play`, `audio_pause`, `audio_seek`, `audio_preload_next` (async, SMB-aware), `set_gapless_enabled`, …
- **Audio devices** (8): `get_audio_devices`, `refresh_audio_devices`, `set_audio_device`, `get_system_default_device_id`, `set_exclusive_mode`, `hog_mode_status`, …
- **Media controls** (2): `update_media_metadata`, `update_media_playback_state` — mis à jour par JS à chaque changement de track/état play
- **Listening history** (8): `record_play`, `get_top_artists`, `get_recent_albums`, …
- **EQ** (3): `set_eq_enabled`, `set_eq_bands`, `get_eq_state`
- **Network/NAS** (10): `add_network_source`, `remove_network_source`, `get_network_sources`, `toggle_network_source`, `scan_network_source_cmd`, `discover_nas_devices`, `smb_connect`, `smb_list_shares`, `smb_browse`, `update_network_source_credentials`
- **DAP Sync** (15): `dap_list_external_volumes`, `dap_get_volume_info`, `dap_save_destination`, `dap_get_destinations`, `dap_get_destination`, `dap_delete_destination`, `dap_eject_volume`, `dap_save_selection`, `dap_save_selections_batch`, `dap_get_selections`, `dap_read_manifest`, `dap_compute_sync_plan`, `dap_execute_sync`, `dap_cancel_sync`, `dap_start_volume_watcher`
- **Feedback** (1): `submit_feedback`

**Startup flow:** `init_cache()` → `load_tracks_from_cache()` (instant, from disk) → `start_background_scan()` (async, emits `scan_progress` events, **local files only**) → `enrich_genres_from_deezer()` (async, emits `genre_enrichment_complete`). NAS scanning only triggered via `scan_network_source_cmd` (never from `start_background_scan`). `media_controls::init_media_controls()` called in `setup()` to register `MPRemoteCommandCenter` immediately.

### Network/NAS subsystem (`src-tauri/src/network/`)

```
network/
├── mod.rs          — NetworkSource, SmbCredentials types; load/save network_sources.json
├── smb.rs          — SMB client (pavao wrapper); CONNECTION mutex; browse/read_file/read_file_head
├── scanner.rs      — Differential scan; start_progressive_download; extract_smb_metadata_and_cover
├── credentials.rs  — macOS Keychain + PASSWORD_CACHE (session-level in-memory cache)
└── discovery.rs    — mDNS/Bonjour discovery (_smb._tcp.local., 5s timeout)
```

**SMB URI format:** `smb://{source_id}/{share}/{remote_path}`
- `source_id` = UUID of `NetworkSource` — used to look up host + credentials
- `remote_path` starts with `/`

**Progressive download (`scanner.rs` + `audio_decoder.rs`):**
- `start_progressive_download(source, share, remote_path, cancel_previous: bool)` — spawns OS thread that downloads in 64KB chunks, writes to `smb_buffer/{hash}.tmp`, updates `PROGRESSIVE_DOWNLOADS` registry
- `cancel_previous = true` for `audio_play` (cancel old download), `false` for `audio_preload_next` (don't interrupt current track)
- `audio_play` waits for 4MB threshold (≈111ms at 36 MB/s) before starting the engine, with 15s timeout
- `SmbProgressiveFile` (in `audio_decoder.rs`) implements `Read + Seek + MediaSource` with blocking wait loops
- **`byte_len()` must return `Some(bytes_written)` at all times** — returning `None` makes Symphonia treat the stream as non-seekable

**`add_network_source` returns a `NetworkSource` object** (not a string ID). Callers must use `result.id` to get the UUID for subsequent commands like `scan_network_source_cmd`. See `network.js` line 876 for the canonical pattern: `invoke('scan_network_source_cmd', { sourceId: result.id })`.

**Critical SMB constraint:** `libsmbclient` (via pavao) is a **process-level singleton**. Two concurrent `SmbClient` instances cause EINVAL (os error 22). All SMB operations share a single `CONNECTION: Lazy<Mutex<Option<ActiveConnection>>>` — concurrent access is serialized through this lock.

**Gapless with SMB:** `audio_preload_next` is `async` and SMB-aware — it parses `smb://`, calls `start_progressive_download(cancel_previous=false)`, waits 4MB, then calls `engine.preload_next(temp_path)`. Triggered at 60s remaining (vs. 10s for local files) to cover NAS latency.

**Gapless transition + seek:** `CallbackData` in `coreaudio_stream.rs` carries `current_path: Arc<Mutex<Option<String>>>` + `next_path: Arc<Mutex<Option<String>>>`. During gapless transition: `*data.current_path.lock() = data.next_path.lock().take()`. Without this, seek-restart after gapless opens the wrong file.

**Password cache:** `credentials.rs` keeps `PASSWORD_CACHE: Lazy<Mutex<HashMap<String,String>>>` — Keychain accessed at most once per source per session. `get_cover_smb()` checks this cache and skips the SMB connection if no session password is present (avoids Keychain dialogs at startup).

### Playlist thumbnails — pattern async

`playlists.js` utilise un chargement lazy de covers via attributs `data-cover-path`, `data-cover-artist`, `data-cover-album` :

1. `getPlaylistAlbumCovers(playlist)` — retourne ≤4 objets `{ path, artist, album }` (1 par album unique si `library.tracks` est peuplé, sinon paths bruts). **Déduplication par nom d'album seul** (`album.trim().normalize('NFC')`) — identique à la clé de `library.albums`. **Ne PAS dédupliquer par artist+album** sinon les variations "feat." créent de faux doublons (même pochette × N).
2. `buildPlaylistThumbHtml(covers, size)` — génère le HTML avec des `<div data-cover-path="..." data-cover-artist="..." data-cover-album="...">` (PAS `<img>`) selon le nombre de covers :
   - 0 → `playlist-cover-empty` (icône ♪)
   - 1 → `playlist-cover-single` (1 colonne, image pleine)
   - 2 → 2 divs côte à côte
   - 3-4 → grille 2×2 (le 4e slot répète le 1er si 3 covers)
3. `loadPlaylistThumbs(containerEl)` — async, fire-and-forget. Chaîne de fallback **4 niveaux** :
   1. `thumbnailCache` / `coverCache` (mémoire)
   2. `get_cover_thumbnail` (cache disque, instantané si pré-généré)
   3. `get_cover` (extrait depuis le fichier audio)
   4. `fetch_internet_cover` (MusicBrainz/Deezer — nécessite `artist` + `album` depuis les data-attributes)
   - Injecte `cell.style.backgroundImage = url(...)` et ajoute la classe `has-cover`

**`get_cover_thumbnail` vs `get_cover`** : `get_cover_thumbnail` retourne `null` si le thumbnail n'a pas été pré-généré par le scan en arrière-plan. Ne jamais l'utiliser seul sans fallback — utiliser `get_cover` en second essai.

**Timing sidebar au démarrage** : `initPlaylistListeners()` appelle `loadPlaylists()` → `updatePlaylistsSidebar()` depuis `DOMContentLoaded`. À ce moment, `init()` (async) n'a pas encore peuplé `library.tracks` (plusieurs `await` en attente). Fix : `renderer.js` appelle explicitement `app.updatePlaylistsSidebar()` après `groupTracksIntoAlbumsAndArtists()` + `displayCurrentView()` dans `init()`.

### External APIs (called from Rust via reqwest)

MusicBrainz + CoverArtArchive (album art), Deezer (artist images + genre enrichment), WikiMedia.

### Feedback → GitHub Issues

- `submit_feedback` (Tauri command) : sauvegarde locale + POST `https://api.github.com/repos/thomasdugue/noir-feedback/issues`
- Token injecté au **compile time** via `option_env!("NOIR_GITHUB_FEEDBACK_TOKEN")` dans `lib.rs`
- La variable d'env `NOIR_GITHUB_FEEDBACK_TOKEN` doit être définie **avant `cargo build`** (pas au runtime)
- Le launch config parent (`Documents/Thomas/.claude/launch.json`) la définit dans `env: {}`
- Sans token → le feedback est sauvé en local seulement (`~/.local/share/noir/feedback/`)
- **Piège** : le nom de l'env var doit être **exactement** `NOIR_GITHUB_FEEDBACK_TOKEN` — tout autre nom (`NOIR_GITHUB_TOKEN`, etc.) fait que `option_env!` retourne `None`
- **NE JAMAIS** committer, logger ou documenter la valeur du token

### Audio pipeline (end-to-end)

```
File / SmbProgressiveFile → [Symphonia decoder] → f32 interleaved
  → [Resampler FFT] (only if DAC doesn't support source rate)
  → [RingBuffer lock-free] (5s capacity, HeapRb<f32>)
  → (real-time callback thread)
  → [EQ 8-band biquad] (bypassed if all gains ≈ 0 dB)
  → [Volume] (sample × volume f32)
  → [CoreAudio HAL] (kAudioUnitSubType_HALOutput, direct to device)
  → DAC
```

- **Bit-perfect** when: no resampling + EQ off + volume 100% + hog mode on
- **Sample rate auto-switch**: `coreaudio_backend.rs` negotiates with the DAC via `kAudioDevicePropertyNominalSampleRate`
- **Hog Mode**: `kAudioDevicePropertyHogMode` in `coreaudio_backend.rs` — exclusive device access
- **Supported formats**: FLAC, WAV, AIFF, ALAC, MP3, AAC/M4A, OGG Vorbis
- **Not supported**: WMA, DSD, Opus, MQA — extensions removed from scanner

### `noir://` custom protocol

Serves audio files and covers from disk. Registered in `lib.rs` via `tauri::Builder::register_asynchronous_uri_scheme_protocol("noir", ...)`.

- Path is URL-decoded then **canonicalized** + **boundary-checked** against allowed directories
- Supports HTTP range requests for audio streaming
- MIME type detected by extension

### Data files

All persisted to `~/.local/share/noir/` (via `dirs::data_dir()`):

| File/Dir | Content |
|----------|---------|
| `config.json` | `library_paths[]`, `excluded_paths[]`, audio device, EQ state |
| `tracks_cache.json` | Full track metadata (loaded at startup → `library.tracks`) |
| `metadata_cache.json` | Per-path raw metadata |
| `cover_cache.json` | Cover art paths (smb:// URIs → local file paths) |
| `network_sources.json` | NAS source list (no passwords — those are in Keychain) |
| `network_scan_cache.json` | Differential scan cache: `source_id → path → {size, modified, metadata}` |
| `playlists.json` | User playlists |
| `listening_history.json` | Play history for home page stats |
| `thumbnails/` | 80×80 JPEG thumbnails |
| `covers/` | Extracted cover art (named by `{hash}.jpg/png`) |
| `smb_buffer/` | Progressive download temp files (`{hash}.tmp`) — cleaned up on app exit |
| `feedback/` | User feedback JSON files |
| `dap_sync.db` | SQLite DB for DAP destinations + album selections (tables: `dap_destinations`, `dap_sync_selection`) |

DAP sync also writes `.hean-sync.json` on the destination device root (e.g. `/Volumes/SDCARD/.hean-sync.json`) — manifest of synced files with quick hashes.

### Security conventions

- **Path validation**: `write_metadata` canonicalizes + checks `starts_with()` against `library_paths` — prevents writing outside the library
- **HTML escaping**: `escapeHtml()` from `utils.js` used on all user-facing data (47+ call sites)
- **File permissions**: `save_file_secure()` sets 0600 on all cache files
- **Debug logging**: use `#[cfg(debug_assertions)]` to wrap `println!` in Rust — stripped in release
- **CSP**: configured in `tauri.conf.json` — controls script/img/connect sources

## Key Constraints

- **macOS only for audio**: CoreAudio backend, hog mode, exclusive stream. The `AudioBackend` trait is ready for a future WASAPI port.
- **No bundler**: `"type": "module"` in package.json; scripts loaded via `<script type="module">` in index.html.
- **No devUrl**: Tauri serves static files from `src/` directly. `preview_start` opens a native macOS window, not a browser URL.
- **Virtual scroll**: `views.js` maintains a 60-node DOM pool (`POOL_SIZE=60`, `TRACK_ITEM_HEIGHT=48`). Never modify track DOM nodes outside this system.
- **Gapless preload timing**: `audio_preload_next` must be called ~60s before track end for SMB tracks (10s for local). Timing logic in `playback.js`.
- **Event delegation**: album/artist grid cards carry `dataset.albumKey` / `dataset.artistKey`. Add interactions via delegation on the grid container, not per-card listeners.
- **DAP Sync — top bar scope** : la barre d'info sync (`#dap-sync-bar`) remplace la search bar UNIQUEMENT sur la vue `dap-sync`. `hideDapTopBar()` doit être appelé dans `displayCurrentView()` quand `ui.currentView !== 'dap-sync'` pour restaurer la search bar. `renderSidebarDestinations()` doit aussi être appelé pour désélectionner le device dans la sidebar.
- **DAP Sync — pas de `fs::metadata` dans `compute_sync_plan`** : la résolution SMB + `fs::metadata()` coûte ~12ms/fichier. Avec 800 fichiers : 10 secondes bloquantes. Utiliser `track.size_bytes` (estimé JS) à la place. **Régression critique si réintroduit.**
- **Cover thumbnails — `isConnected` obligatoire** : `loadThumbnailAsync` vérifie `imgElement.isConnected` avant de lancer le chargement. Un `<img>` détaché du DOM (créé via `document.createElement` mais pas encore inséré) est silencieusement ignoré. Toujours insérer l'`<img>` dans le DOM AVANT d'appeler `loadThumbnailAsync`. Pattern DAP sync : `wrapper.appendChild(img)` puis `loadThumbnailAsync(path, img, artist, album)`.
- **DAP Sync — `dest_relative_path` comme clé de déduplication** : le plan compare par chemin de destination (construit depuis artist/album/track), PAS par source path. Les paths SMB changent entre sessions (UUID différent). La clé `dest_relative_path` est stable.
- **DAP Sync — debounce obligatoire** : `saveSelections` (800ms) et `computeAndRenderSummary` (500ms) DOIVENT être debounced. Sans debounce, chaque clic checkbox envoie tous les albums via IPC + recalcule le plan Rust = gel UI.
- **DAP Sync — pre-computed Sets** : `_copyAlbumIds` et `_deleteSourcePaths` DOIVENT être des `Set` pré-calculés après chaque sync plan. L'ancien pattern `filesToCopy.some(f => f.albumId === id)` était O(n) par album = O(n²) total avec ~160 albums × ~800 fichiers.
- **DAP Sync — DocumentFragment** : `renderAlbumRows()` DOIT construire dans un `DocumentFragment` avant un seul `appendChild`. Créer les rows une par une dans le DOM cause un reflow par row = gel visible.
- **DAP Sync — progress bar basée sur tracks** : la barre de progression pendant la sync utilise `current / total` (nombre de fichiers), PAS `bytesCopied / totalBytes`. Plus intuitif pour l'utilisateur (4/8 = 50% quand 4 tracks sur 8 sont copiées).
- **DAP Sync — albumId** : le hash JS `albumKeyToId(albumKey)` génère un ID numérique stable à partir de la clé string de l'album. Ce même ID est passé côté Rust dans `TrackForSync.album_id` et revient dans `SyncAction.album_id` pour le mapping bidirectionnel.
- **`transitionView` async**: `transitionView(renderFn)` awaits `renderFn()` before fade-in. `displayHomeView` is async (fetches data from Rust). The `renderVersion` counter prevents stale renders when multiple transitions overlap. `scan_complete` listener must check `shouldReload` before triggering `reloadLibraryFromCache()` — unconditional reload causes race conditions with the initial `displayHomeView`.
- **SMB singleton**: `libsmbclient` is process-level — only one `SmbClient` can exist at a time. All SMB ops share `CONNECTION` mutex. Never instantiate a second `SmbClient` concurrently.
- **Metadata editing**: `panels.js` → `enterTrackEditMode()` (single track) and `showBulkEditModal()` (N tracks). After save, always call `app.groupTracksIntoAlbumsAndArtists()` to rebuild the artist/album index.
- **Release profile**: `Cargo.toml` has `opt-level=3`, `lto=true`, `strip=true`, `codegen-units=1`.
- **souvlaki `!Send` workaround**: `media_controls.rs` uses `unsafe impl Send for MediaControlsWrapper`. Justified because `MPRemoteCommandCenter` uses GCD internally (thread-safe by macOS design). Do not remove or move without understanding this constraint.
- **Media keys**: F7/F8/F9 global shortcuts intentionally absent from `shortcuts.js` — they conflict with Apple Music in media-key mode. Media key routing is handled via `MPRemoteCommandCenter` (souvlaki in `media_controls.rs`). The `media-control` Tauri event is what JS listens to.
- **DAP Sync — JAMAIS de dossier vide sur exFAT** : les dossiers vides sur exFAT deviennent des entrées fantômes non-supprimables qui bloquent toutes les syncs futures. `copy_file_verified_cancellable` ouvre la source AVANT `create_dir_all`. Chaque erreur de copie déclenche `cleanup_empty_parent_dirs`. Fin de sync déclenche `cleanup_empty_dirs` (global). **NE JAMAIS réintroduire `create_dir_all` avant la vérification de la source.**
- **DAP Sync — covers inline, jamais en phase séparée** : les covers sont copiées immédiatement après le dernier audio de chaque album, pas dans une Phase 2b. L'ancienne approche (toutes les covers en bloc après tous les audio) causait de la corruption exFAT. **NE JAMAIS réintroduire une phase séparée pour les covers.**
- **DAP Sync — covers protégées du mirror mode** : `compute_sync_plan` exclut les covers (`cover.jpg/jpeg/png`) de `files_to_delete` car elles ne sont pas dans `selected_dest_paths`. Les covers orphelines sont nettoyées par `cleanup_empty_dirs` quand le dossier n'a plus d'audio. **NE JAMAIS supprimer cette exclusion.**
- **DAP Sync — cancel side JS** : `dap_cancel_sync` pose un flag AtomicBool, mais le thread Rust peut être bloqué sur un `read()` SMB. Le JS a un timeout de 3s qui ramène l'utilisateur à la vue albums immédiatement, sans attendre la confirmation Rust.

## Décisions techniques actées

- **Audio engine = coreaudio-rs.** CPAL a été remplacé car il ne donnait pas assez de contrôle sur le buffer interne CoreAudio (seek cassé, pas d'accès à AudioUnitReset, pas de contrôle du buffer size). **NE JAMAIS revenir à CPAL.**
- **Bit-perfect = pas de resampling.** Le sample rate du device doit correspondre au sample rate du fichier. Hog mode pour accès exclusif au DAC.
- **Dynamic sample rate switching** entre morceaux de sample rates différents.
- **Affichage format :** lossless (FLAC, ALAC, WAV, AIFF) → "24-bit / 192kHz". Lossy (MP3, AAC, OGG) → "320 kbps". Partout dans l'interface, sans exception.
- **Thumbnails des pochettes :** format léger (WebP/JPEG), générées au scan, utilisées dans les listes/carrousels. Pleine résolution uniquement sur la page album.
- **Un fichier audio = une entrée en base.** Jamais de doublons pour un même chemin.
- **Tracks triées par** `disc_number` ASC puis `track_number` ASC. Fallback : nom de fichier.
- **Page d'accueil :** contenu calculé une fois au lancement, stable pendant la session.
- **SMB réseau :** connexion native gérée par Noir (pas par Finder). Cache local des metadata. Buffering : copie locale avant lecture pour éviter la latence réseau.
- **Media keys macOS :** souvlaki (`MPRemoteCommandCenter`) utilisé pour que Noir prenne le contrôle des touches multimédia même quand Apple Music tourne. Les global shortcuts Tauri `MediaPlayPause/MediaTrackNext/MediaTrackPrevious` ne suffisent pas — Apple Music les intercepte en priorité. **Ne jamais réajouter F7/F8/F9 comme global shortcuts Tauri.**
- **Navigation séquentielle en vue tracks :** toujours utiliser `ui.tracksViewOrder` (paths dans l'ordre visuel trié/filtré), jamais `library.tracks[currentTrackIndex ± 1]`. L'ordre de `library.tracks` est l'ordre de scan, qui diffère du tri visuel.
- **AirPlay / Bluetooth device handling** :
  - `kAudioDevicePropertyTransportType` identifie les devices : AirPlay (`0x61697270`), Bluetooth (`0x626C7565`), Built-in (`0x626C746E`), USB (`0x75736220`).
  - `DeviceInfo` porte `transport_type: u32` + `is_airplay: bool`. Le champ `is_airplay` est utilisé côté JS pour le badge UI, toast dédié, et blocage automatique du hog mode (incompatible AirPlay).
  - AirPlay et Bluetooth peuvent disparaître de `kAudioHardwarePropertyDevices` quand inactifs. Fix : `airplay_session_devices` (cache en session dans `CoreAudioBackend`) + réinjection dans `device_cache` même si CoreAudio les retire. `stale_airplay_ids` identifie les devices cachés non-actifs.
  - **Stratégie system default (critique pour AirPlay)** : un device AirPlay n'existe dans CoreAudio QUE tant qu'il est le défaut système macOS. Dès qu'il perd ce statut, macOS tue la session et le device disparaît du HAL — impossible de le réactiver via `set_system_default_device` (l'API accepte silencieusement mais ne fait rien). Stratégie dans `set_output_device` :
    - **→ AirPlay** : `set_system_default_device(airplay_id)` + 800ms d'attente pour activation réseau
    - **AirPlay →** non-AirPlay : **NE PAS changer le défaut système** (garde AirPlay vivant). Audio route vers le nouveau device via assignement AudioUnit explicite (`get_device_id()` retourne `Some(id)` pour les non-AirPlay)
    - **non-AirPlay → non-AirPlay** : `set_system_default_device` normalement (sync volume macOS)
  - **Routing AudioUnit AirPlay** : `get_device_id()` retourne `None` pour les devices AirPlay → l'AudioUnit utilise le défaut système (qui est AirPlay). `AudioUnitSetProperty(kAudioOutputUnitProperty_CurrentDevice)` échoue systématiquement pour AirPlay.
  - **`prepare_for_streaming` skip AirPlay** : ne change PAS le sample rate d'un device AirPlay (casse la session réseau). Retourne le rate natif (44100Hz). macOS gère le resampling AirPlay en interne.
  - **Hog mode guard Rust** : `set_exclusive_mode(Exclusive)` refuse si le device actif est AirPlay. Auto-désactivé dans `set_output_device` quand on switch vers AirPlay.
  - **Erreur AudioUnit stricte** : `coreaudio_stream.rs` retourne une erreur si `AudioUnitSetProperty(kAudioOutputUnitProperty_CurrentDevice)` échoue pour un device non-AirPlay (pas de fallback silencieux sur le mauvais device).
  - **Retry JS AirPlay** : si `audio_play` échoue sur un device AirPlay, retry automatique après 1.5s (le receiver peut être en cours d'activation).
  - **Sync polling JS** : après `set_audio_device`, lit le défaut système RÉEL via `get_system_default_device_id()` (qui peut différer du device sélectionné si AirPlay est préservé). `_lastKnownSystemDefault = actualDefault` empêche le polling de confondre la préservation AirPlay avec un changement externe.
  - **Limitation connue** : quand le défaut système est préservé sur AirPlay et l'audio joue sur built-in, la notification volume macOS affiche "AirPlay" (cosmétique — le volume fonctionne sur le bon device).
  - `_lastGoodPosition` (JS) : dernière position de lecture confirmée par `playback_progress`. Non réinitialisée par `playback_started` → survit aux restarts de stream pendant les device switches. `_seekCancelToken` empêche les seeks périmés.

## Invariants protégés par des tests (ne JAMAIS casser)

- **Un album = une seule entrée dans `library.albums`.** Quel que soit le nombre d'artistes différents dans les tracks d'un album, il doit produire exactement UNE entrée dans `library.albums`. La clé d'album est normalisée via `normalizeKey()` (trim + NFC). **Jamais** de clé brute `track.metadata.album` — toujours `normalizeKey(track.metadata.album)`. Tests : Module 13 (AlbumGrouping.test.js), tests 13.5–13.7.
- **Pas de duplication visuelle sur la homepage.** La section "Recently Played" déduplique par album (clé composite `artiste|||album`), pas seulement par chemin de fichier. Un même album ne doit apparaître qu'une seule fois même si plusieurs tracks ont été écoutées.
- **SMB : connexion périmée = retry automatique.** `read_file_to_temp_progressive()` doit tenter un retry avec reconnexion fraîche si `open_with()` échoue (connexion expirée). Ne JAMAIS supprimer ce mécanisme de retry.
- **SMB : credentials = gestion d'erreur explicite.** `retrieve_password()` ne doit JAMAIS utiliser `unwrap_or_default()`. Un échec Keychain doit retourner une erreur claire à l'utilisateur, pas un mot de passe vide silencieux.
- **SMB : propagation d'erreur du thread de download.** `LAST_DOWNLOAD_ERROR` stocke l'erreur du thread de download. `audio_play` doit la récupérer via `take_last_download_error()` quand `bytes_written == 0` pour afficher l'erreur réelle au lieu d'un message générique.
- **Suppression de tracks = PERMANENTE.** Quand l'utilisateur supprime des tracks de la bibliothèque, elles ne doivent JAMAIS revenir, même après redémarrage ou re-scan NAS. Mécanisme : `excluded_paths` dans `config.json`. Défense en profondeur — les `excluded_paths` DOIVENT être vérifiés à CHAQUE point d'entrée :
  1. `init_cache()` : filtre les tracks exclues au chargement du cache depuis le disque
  2. `start_background_scan()` : filtre les tracks locales via `excluded_paths` + filtre les SMB tracks préservées
  3. `scan_network_source_cmd()` : filtre les tracks NAS re-scannées par `excluded_paths`
  Ne JAMAIS ajouter un code path qui charge ou scanne des tracks sans vérifier `excluded_paths`.
- **Métadonnées éditées = écrites dans le fichier audio.** `write_metadata()` doit TOUJOURS écrire les tags dans le fichier audio réel (via lofty), pas seulement dans le cache. Le cache est un accélérateur, pas la source de vérité — la source de vérité est le fichier audio.
- **METADATA_CACHE : UPDATE, jamais REMOVE.** `write_metadata()` doit mettre à jour l'entrée `METADATA_CACHE` avec les nouvelles valeurs (`get_mut` + set champs), PAS la supprimer. La suppression créait une race condition fatale : le background scan (concurrent) re-lisait le fichier audio (pas encore écrit par lofty), réinsérait les anciennes métadonnées dans `METADATA_CACHE`, et cette corruption persistait indéfiniment. L'update garantit que : (1) `get_metadata_internal()` retourne les valeurs les plus récentes, (2) `scan_folder_with_metadata()` ne réinsère pas de données stale (check `!contains_key`). Ne JAMAIS revenir à `cache.entries.remove()` dans `write_metadata()`.
- **`start_background_scan()` : re-application METADATA_CACHE.** Après `cache.tracks = all_tracks`, les métadonnées de chaque track doivent être re-synchronisées depuis un snapshot de `METADATA_CACHE` (pris AVANT le lock `TRACKS_CACHE` pour éviter le deadlock). Cela capture les user edits qui ont eu lieu pendant le scan. Ne JAMAIS supprimer cette re-application.
- **METADATA_CACHE : jamais de stale data.** `get_metadata_internal()` vérifie `METADATA_CACHE` avant de lire le fichier. L'update dans `write_metadata()` + la re-application dans `start_background_scan()` garantissent que les user edits ne sont jamais perdus. Ne JAMAIS retirer le `save_metadata_cache_to_file()` dans `write_metadata()`.
- **Playlist mosaic covers : déduplication par album seul.** `getPlaylistAlbumCovers()` déduplique par `album.trim().normalize('NFC')` (nom d'album seul), identique à la clé de `library.albums`. **Ne JAMAIS dédupliquer par `artist+album`** — les variations "feat." dans les noms d'artistes créent de faux albums distincts (même pochette dupliquée × N dans la mosaïque). Régression constatée 2026-03-16.
- **Playlist mosaic covers : fallback internet OBLIGATOIRE.** `loadPlaylistThumbs()` DOIT avoir 4 niveaux de fallback : (1) `thumbnailCache`/`coverCache` → (2) `get_cover_thumbnail` → (3) `get_cover` → (4) `fetch_internet_cover(artist, album)`. Sans le niveau 4, les albums sans cover embarquée (cover récupérée uniquement via MusicBrainz/Deezer) affichent une cellule noire. Les attributs `data-cover-artist` et `data-cover-album` DOIVENT être injectés par `buildPlaylistThumbHtml` pour que le fallback fonctionne.
- **Boutons 'Add to Queue' et 'Add to Playlist' au survol des tracks.** Les règles CSS `.track-add-queue` et `.track-add-playlist` (opacity 0 → 1 au hover de `.playlist-track-item`) ne doivent PAS être supprimées. Régression constatée si ces règles sont absentes.

## Règles de travail

- Ne JAMAIS modifier les fichiers audio (`src-tauri/src/audio/` ou équivalent) quand tu travailles sur l'UI ou la library. Et inversement.
- Avant de commencer : `cargo check` pour valider que le code Rust compile. `for f in src/*.js; do node --check "$f"; done` pour vérifier la syntaxe JS.
- Un prompt = une tâche. Ne pas toucher à ce qui est hors scope.
- Répondre toujours en français.

## Protocole de session

### DÉBUT de session
1. Lis ce fichier (CLAUDE.md)
2. Lance `cd src-tauri && cargo check` — note les erreurs s'il y en a
3. Lance `cd src-tauri && cargo test` — note les résultats (X pass, Y fail, Z ignored)
4. Lance `cd .. && npm test -- --watchAll=false` — note les résultats
5. Lance `for f in src/*.js; do node --check "$f"; done` — note les erreurs s'il y en a
6. Si des tests échouent AVANT de commencer → dis-le moi, on corrige d'abord

### FIN de session
1. Lance `cd src-tauri && cargo test` — compare avec les résultats du début
2. Lance `cd .. && npm test -- --watchAll=false` — compare avec les résultats du début
3. Si un test qui passait avant échoue maintenant → RÉGRESSION → corrige avant de terminer
4. Mets à jour CLAUDE.md : section "Bugs connus" et "Historique des sessions"
5. Fais un commit "[tâche du jour] terminée"

## Specs détaillées

Lire la spec correspondante AVANT de travailler sur une feature :
- `docs/NOIR_DESKTOP_SPEC.md` → spécification principale de l'application
- `docs/prompt-test-suite-noir.md` → prompt de référence pour la suite de tests
- `docs/SPEC-test-suite.md` → suite de tests complète, fichiers de test, protocole

## Bugs connus

- **gapless_transition en contexte library** : quand `ui.tracksViewOrder` est vide (vue tracks jamais rendue pendant la session), la gapless transition ne peut pas déterminer l'ordre visuel et laisse `currentTrackIndex` inchangé. Cas marginal (nécessite de jouer depuis tracks view sans jamais l'avoir affichée).
- **Drag ESC sur homepage** : annuler un drag avec Escape sur la homepage peut laisser le ghost visible si le drag a commencé mais que `customDragState.isDragging` n'est pas encore `true`.
- **Sidebar playlist thumbnail au 1er démarrage (sans cache)** : si aucun thumbnail n'a jamais été généré (première installation), `loadPlaylistThumbs` appelle `get_cover` qui extrait depuis le fichier audio — légère latence notable.

## Historique des sessions

- **2026-03-04** : Infrastructure anti-régression — CLAUDE.md enrichi, docs/SPEC-test-suite.md, suite de tests complète : 100 pass / 0 fail / 19 ignored (Rust) + 11 pass / 14 skipped (JS). Modules testés : audio_decode, audio_seek, ring_buffer, metadata, library_scanner, queue, network_source (ignored), tauri_commands (ignored). Frontend : FormatDisplay, Navigation (skip), PlayerControls (skip), AlbumView (skip)
- **2026-03-04** : Fix #16 (sync audio device bidirectionnel Noir↔Système), fix player disparu (`ui` non importé dans `playback.js`), fix Now Playing race condition (PASSE 2 async), fix #3 library sequential (playbackContext + tracksViewOrder), fix shuffle (track courante exclue avant tirage), fix #4 media keys (souvlaki MPRemoteCommandCenter + suppression F7/F8/F9 conflictuels)
- **2026-03-04** : Sprint 2 — Fix #22 (dock click restaure la fenêtre : `RunEvent::Reopen` avec `.build().run(callback)` + `use tauri::Manager`), Fix #23 (auto-reconnect NAS au démarrage : `autoReconnectNetworkSources()` dans `network.js`), Fix #17 (drag HTML5 carousel homepage : `-webkit-user-drag: none; pointer-events: none` sur `.carousel-cover-img`), Fix #18 (thumbnails playlist : `<img>` → `<div>` avec `background-image`, layout adaptatif 0-4 covers, fallback `get_cover_thumbnail` → `get_cover`, rebuild sidebar après chargement library, `getPlaylistAlbumPaths` résilient si library vide)
- **2026-03-05** : AirPlay Level 1 — détection transport type CoreAudio + badge UI + blocage hog mode AirPlay. Session cache pour AirPlay (persist dans la liste même quand CoreAudio les désactive). Stale AirPlay reconnect via `set_system_default_device`. Sync device fix (`_lastKnownSystemDefault` change-tracking + `_audioStreamDeviceId`). Fix Bluetooth DAC invisible (transport type `0x626C7565` ajouté au filtre + session cache). Fix position perdue sur device switch (`_lastGoodPosition` + `_seekCancelToken`). Traduction messages français → anglais dans le panel audio output.
- **2026-03-06** : AirPlay Level 2 — Fix playback AirPlay qui cassait après le premier switch. Cause racine : `set_system_default_device` ne peut PAS réactiver un device AirPlay stale (API accepte silencieusement sans effet). Solution : stratégie de préservation session AirPlay (ne pas changer le défaut système quand on quitte AirPlay). Routing AirPlay via défaut système (`get_device_id()` → None). `prepare_for_streaming` skip sample rate pour AirPlay. Guard hog mode Rust dans `set_exclusive_mode`. Erreur AudioUnit explicite (non-AirPlay). Retry JS 1.5s pour AirPlay. Auto-reset `exclusive_mode=Shared` quand switch → AirPlay avec hog actif. 800ms d'attente activation AirPlay. Tests T1-T6, T8-T13 passés, T11 limitation cosmétique (notification volume macOS).
- **2026-03-08** : Fix home page — (1) `transitionView` rendu async avec `renderVersion` pour annuler les renders obsolètes, (2) `displayHomeView` awaitée dans `displayCurrentView`, (3) `scan_complete` conditionnel (ne reload que si `new_tracks > 0 || removed_tracks > 0`), (4) `min-width: 0` sur `.main-content` — cause racine du grid 4496px (carousels `calc(100% + extra)` inflataient le flex item), (5) fallback `thumbnailCache` pour covers Recently Played, (6) media queries responsive `.home-recent-grid` (3 cols → 2 → 1).
- **2026-03-09** : Onboarding integration — Intégration du prototype onboarding (6 étapes) dans l'app. Fixes : (1) CSS variables manquantes `--sp-*`, `--fs-*`, `--color-green` dans `:root`, (2) stats 0/0/0 → payload `data.stats.mp3_count` au lieu de `data.mp3_count`, (3) NAS "Unknown" → `device.display_name`/`device.hostname` au lieu de `device.name`/`device.host`, (4) IPv6 → fallback hostname `.local`, (5) `smb_connect` manquait `isGuest`/`domain`, (6) `add_network_source` manquait `name`/`domain`/`isGuest`, (7) `[object Object]` dans folders → `share.name`, (8) scan progress → champs corrects `data.phase`/`data.current`/`data.total`/`data.folder`, (9) NAS scan 0 tracks → `add_network_source` retourne `NetworkSource` objet, fix `result.id`.
- **2026-03-15** : Home page carousels — (1) Rename "New Releases" → "Recently Added" + NAS albums inclus (fix ADDED_DATES_CACHE dans `scan_network_source_cmd` pour tracks NAS), (2) Session-level caching pour Discover/Audiophile/Long Albums/Random Mix/Discovery Mix (sélection stable par session, invalidée sur `scan_complete` ou `genre_enrichment_complete`), (3) Fix covers Recently Played — cause racine : lookup album avec clé composite `"artist — album"` alors que `library.albums` utilise `normalizeKey(albumName)` seul. Fix : lookup 4 niveaux (normalizedKey → compositeKey → linear scan → track path), (4) Fix covers Discovery Mix — cause racine : `tryLoadCover()` vérifiait `!img.isConnected` AVANT d'appeler `loadThumbnailAsync`, mais l'élément n'était pas encore dans le DOM (homeContainer attaché plus tard). Résultat : retour immédiat pour TOUS les mixes, aucune cover chargée. Fix : remplacé par le même pattern `.then()` que `createCarouselAlbumItem` (pushes to queue, processed after DOM built). (5) Ajout `coverCandidates` multi-album dans `generateDiscoveryMixes` avec fallback chain + reconstruction pour ancien format localStorage.
- **2026-03-15** : DAP Sync — sprint UX polish + cover fix. **UX** : (1) Select All toggle visuel immédiat, (2) default selection = albums déjà on DAP (flag `_needsOnDapPreselection` + auto-deselect après 1er plan), (3) sort dropdown button+menu (même pattern que views.js), (4) bitrate sort fonctionnel (`getQualityRank()` primary + `getAlbumBitrate()` tiebreaker), (5) top bar vidée (feedback/settings seulement), bouton Sync déplacé dans dest-bar avec icône SVG, (6) stats sync dans panneau déployable 2 colonnes (Selection + Sync) + footer (free/last sync), (7) dest-bar entièrement cliquable pour toggle détails, (8) animation fade-in subtile sur changement d'onglet (`dapTabIn` 180ms, `prefers-reduced-motion` respecté), (9) tailles de police augmentées (album names 13px, artists 11.5px, tabs 12.5px, details labels 11.5px), (10) barre de progression syncing basée sur nombre de tracks (pas bytes), icône transfert agrandie 96px, (11) écran success : icône DAP blanche 76px + badge check animé + 6 micro-particules flottantes + espacement Done/eject augmenté. **Bug fix** : covers albums internet (Deezer/MusicBrainz) ne s'affichaient pas — cause : `loadThumbsBatched` créait un `<img>` détaché du DOM → `loadThumbnailFromQueue` rejetait via `isConnected` check → fix : `<img>` inséré DANS le wrapper `.dap-alb-art` déjà connecté au DOM avant l'appel `loadThumbnailAsync`. **CSS** : supprimé le `display: none` en doublon sur `.dap-dest-details.collapsed` (conflictait avec la transition max-height), ajouté `padding/border-width: 0` au collapsed state.
- **2026-03-16** : Fix playlist mosaic covers — 2 bugs corrigés dans `playlists.js`. **(1) Déduplication incohérente** : `getPlaylistAlbumCovers` dédupliquait par `artist::album` (artist+album combinés) alors que `library.albums` déduplique par album seul (`normalizeKey(album)`). Conséquence : les variations "feat." dans les noms d'artistes créaient de faux albums distincts → même pochette affichée 2, 3 ou 4 fois dans la mosaïque, ou cellules fantômes noires. Fix : renommé en `getPlaylistAlbumCovers`, retourne des objets `{ path, artist, album }`, déduplique par `album.trim().normalize('NFC')` seul. **(2) Fallback internet manquant** : `loadPlaylistThumbs` n'avait que 3 niveaux de fallback (cache → thumbnail → get_cover). Les albums sans cover embarquée (récupérée via MusicBrainz/Deezer) restaient noirs. Fix : ajout étape 4 `fetch_internet_cover(artist, album)` + injection `data-cover-artist`/`data-cover-album` dans `buildPlaylistThumbHtml`. Invariants ajoutés dans CLAUDE.md pour prévenir les régressions.
- **2026-03-14** : DAP Sync — sprint UX + performance critique. **Bugs corrigés** : (B1) `SyncAction` manquait `album_id` → tags "to add"/"to remove" ne s'affichaient jamais → ajouté dans struct + build, (B2) Checkbox albums ne recalculait pas le plan → ajout `computeAndRenderSummary()`, (B3) `computeAndRenderSummary()` re-rendait seulement l'onglet Albums → remplacé par `renderTabContent()`, (B4) Sync non-incrémental → comparaison par `dest_relative_path` (stable across SMB sessions) au lieu de `source_path`, (B5) Storage 0B/0B après sync → `await refreshMountedVolumes()` avant `displayCurrentView()`, (B6) Tags dans mauvaise colonne → CSS `.dap-alb-badges` largeur fixe. **Performance** (cause racine identifiée via marqueurs `[PERF]`/`[PERF-RS]`) : `fs::metadata()` sur fichiers SMB = 12ms/fichier × 805 fichiers = **10.5 secondes**. Fix : suppression de `fs::metadata()` + `resolve_smb_path()` dans `compute_sync_plan()`, utilisation de `track.size_bytes` (estimé JS). Résultat : 10.7s → **32ms** (330× plus rapide). **Optimisations JS** : (1) DocumentFragment pour single DOM reflow, (2) Sets pré-calculés `_copyAlbumIds`/`_deleteSourcePaths` pour O(1) lookups (était O(n²)), (3) debounce `saveSelections` 800ms + `computeAndRenderSummary` 500ms, (4) thumbnails batchés 8/frame, (5) `updateStatusTagsInPlace()` au lieu de full re-render. **UI** : (1) couleurs jaunes supprimées (monochrome), (2) stats intégrées dans header device repliable (`dap-dest-details`), (3) bouton Cancel supprimé du footer, (4) colonnes tags dédiées, (5) sort dropdown (A→Z, Z→A, bitrate ↑↓, status), (6) bouton Change supprimé, (7) icône Settings agrandie (même design que Settings app), (8) top bar info sync remplace search bar uniquement sur vue DAP, (9) sidebar device se désélectionne en quittant la vue DAP. **Marqueurs de performance** encore présents dans le code (`console.time('[PERF]')` et `eprintln!("[PERF-RS]")`) — à retirer une fois la stabilité confirmée.
- **2026-03-23** : DAP Sync — élimination des ghost directories exFAT et corruption covers. **Ghost dirs** : cause racine identifiée — `create_dir_all` créait des dossiers AVANT de vérifier la source → si la copie échouait, le dossier vide devenait une entrée fantôme non-supprimable sur exFAT, bloquant toutes les syncs futures. Fix 3 niveaux : (1) source ouverte avant mkdir, (2) `cleanup_empty_parent_dirs` après chaque erreur, (3) `cleanup_empty_dirs` global en fin de sync. **Covers** : (1) copiées inline (après dernier audio de chaque album) au lieu d'une Phase 2b séparée — prévient corruption exFAT, (2) exclues du mirror mode delete (n'étaient pas dans `selected_dest_paths` → supprimées à chaque re-sync), (3) orphelines nettoyées par `cleanup_empty_dirs` quand dossier n'a plus d'audio. **Cancel** : (1) JS timeout 3s ramène à albums immédiatement (thread Rust peut bloquer sur SMB read), (2) cancel check ajouté avant opérations SMB bloquantes. **Sanitization** : `$` ajouté aux caractères strippés, migration manifest auto-rename fichiers sur le DAP quand les règles changent.
- **2026-03-17** : DAP Sync — auto-volume detection + multi-destination + disconnected screen redesign. **Auto-volume** : `refreshMountedVolumes()` auto-crée destinations pour volumes amovibles non configurés (UNIQUE constraint empêche doublons). `_externalVolumes` stocke les objets ExternalVolume complets. **Multi-dest modal** : `showDapSyncModal` avec sélecteur destination (pills), `toggleAlbumsOnDest(albumKeys, destId, action)`, `getMountedDestinations()`. Context menu handlers (`panels.js`) simplifiés — n'appellent plus le toggle directement, passent par la modale. **Disconnected screen** : icône DAP avec badge X rouge (remplace emoji prise), particules atténuées, pulse animation, chemin monospace inline. **Retry fix** : fallback `volumeName` quand le path ne matche plus (macOS remonte parfois sous un path différent), mise à jour automatique du path en base, feedback inline (status error message + shake animation icon) en plus du toast.
- **2026-03-24** : DAP Sync — batch adaptatif pour la copie audio. Optimisé pour les bibliothèques musicales (albums 10-20 tracks, 3-150 MB/fichier). Double seuil aligné sur les albums : 512 MB ou 40 fichiers (256 MB / 20 en mode dégradé). Sécurité : flush mid-album à 2 GB (hi-res 24/192 × 20 tracks). À chaque frontière de batch : checkpoint manifest partiel (reprise crash) + spot-check F_NOCACHE du dernier fichier (détection corruption exFAT early). Mode dégradé automatique si le spot-check échoue. Implémentation additive : zéro modification de `copy_file_verified()`, progress per-file, cleanup every-10-files, retry/error handling, cancel check — tout inchangé.
