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

### Frontend — 17 JS modules

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
| `audio/types.rs` | Shared types: `AudioInfo`, `PlaybackCommand`, standard sample rates |
| `audio/backend.rs` | `AudioBackend` trait (abstraction for future WASAPI port) |

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

`playlists.js` utilise un chargement lazy de covers via attribut `data-cover-path` :

1. `getPlaylistAlbumPaths(playlist)` — retourne ≤4 paths de tracks (1 par album si `library.tracks` est peuplé, sinon paths bruts). **Résilient** : si la lib n'est pas encore chargée, utilise les paths directs sans dédup.
2. `buildPlaylistThumbHtml(paths, size)` — génère le HTML avec des `<div data-cover-path="...">` (PAS `<img>`) selon le nombre de covers :
   - 0 → `playlist-cover-empty` (icône ♪)
   - 1 → `playlist-cover-single` (1 colonne, image pleine)
   - 2 → 2 divs côte à côte
   - 3-4 → grille 2×2 (le 4e slot répète le 1er si 3 covers)
3. `loadPlaylistThumbs(containerEl)` — async, fire-and-forget. Chaîne de fallback :
   - `thumbnailCache` / `coverCache` (mémoire) → `get_cover_thumbnail` (cache disque, cache-only, instantané si pré-généré) → `get_cover` (extrait depuis le fichier audio, **toujours fiable**)
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
- **`transitionView` async**: `transitionView(renderFn)` awaits `renderFn()` before fade-in. `displayHomeView` is async (fetches data from Rust). The `renderVersion` counter prevents stale renders when multiple transitions overlap. `scan_complete` listener must check `shouldReload` before triggering `reloadLibraryFromCache()` — unconditional reload causes race conditions with the initial `displayHomeView`.
- **SMB singleton**: `libsmbclient` is process-level — only one `SmbClient` can exist at a time. All SMB ops share `CONNECTION` mutex. Never instantiate a second `SmbClient` concurrently.
- **Metadata editing**: `panels.js` → `enterTrackEditMode()` (single track) and `showBulkEditModal()` (N tracks). After save, always call `app.groupTracksIntoAlbumsAndArtists()` to rebuild the artist/album index.
- **Release profile**: `Cargo.toml` has `opt-level=3`, `lto=true`, `strip=true`, `codegen-units=1`.
- **souvlaki `!Send` workaround**: `media_controls.rs` uses `unsafe impl Send for MediaControlsWrapper`. Justified because `MPRemoteCommandCenter` uses GCD internally (thread-safe by macOS design). Do not remove or move without understanding this constraint.
- **Media keys**: F7/F8/F9 global shortcuts intentionally absent from `shortcuts.js` — they conflict with Apple Music in media-key mode. Media key routing is handled via `MPRemoteCommandCenter` (souvlaki in `media_controls.rs`). The `media-control` Tauri event is what JS listens to.

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
