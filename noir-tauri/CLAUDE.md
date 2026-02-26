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
# Run on all modules, not just renderer.js:
for f in src/*.js; do node --check "$f" && echo "OK: $f"; done
```

There are no tests, no linter config, and no bundler. The frontend is served as-is from `src/` (`tauri.conf.json` → `frontendDist: "../src"`).

The `.claude/launch.json` entry (`npm run tauri dev` with `--prefix noirdesktop/noir-tauri`) is used by `preview_start` "Noir Tauri Dev" to start the server in Claude sessions. The native window opens; there is no browser URL to preview.

## Architecture

**Tauri v2 desktop app — macOS primary target.**

```
src/           Vanilla JS (ES6 modules) + CSS + HTML — no bundler
src-tauri/     Rust backend (Tauri commands + audio engine)
```

### Frontend — 11 JS modules + 2 utilities

The JS was refactored (Feb 2026) from a 9 600-line monolith into:

| Module | Lines | Role |
|--------|-------|------|
| `renderer.js` | ~760 | Orchestrator: registers all module functions on `app`, settings panel, sidebar resize, `init()` |
| `app.js` | ~106 | **Mediator**: ~95 `null` slots filled at init — the only way modules call each other |
| `state.js` | ~197 | **Centralized mutable state** (see below) |
| `views.js` | ~2 880 | All view rendering: home, albums/artists grids, album/artist/mix pages, virtual scroll (60-node pool) |
| `playback.js` | ~1 500 | Audio control via Rust invoke: play/pause/seek/volume, gapless preload, 60fps position interpolation |
| `panels.js` | ~1 350 | Queue panel, track info panel (+ inline metadata editing), context menus (single/multi/album), bulk edit modal |
| `playlists.js` | ~1 240 | Playlists CRUD, favorites, add-to-playlist menus |
| `library.js` | ~850 | Cover loading (thumbnail/full/internet/artist), metadata, library scanning, indexation UI |
| `shortcuts.js` | ~564 | Configurable local shortcuts + global media keys, persisted to localStorage |
| `search.js` | ~337 | Inverted index, multi-word scoring, 200ms debounce, result panel |
| `drag.js` | ~182 | Custom drag (mousedown/move/up) — HTML5 drag is broken in Tauri WebView |
| `utils.js` | ~350 | Pure utilities: `showToast`, `escapeHtml`, `formatTime`, `setManagedTimeout`, `createParticleCanvas`, `showLoading` |
| `eq.js` | ~392 | EQ panel UI (8-band parametric), connects to `set_eq_bands` Tauri command |

### State objects (`state.js`)

Shared by reference across all modules. **Never reassign — only mutate properties.**

| Object | Key fields |
|--------|-----------|
| `playback` | `currentTrackIndex`, `audioIsPlaying`, `currentPlayingAlbumKey`, `shuffleMode`, `repeatMode`, `volume` |
| `library` | `tracks[]`, `albums{}`, `artists{}`, `tracksByPath Map` |
| `ui` | `currentView`, `selectedAlbumKey`, `isQueuePanelOpen`, `isTrackInfoPanelOpen` |
| `queue` | `items[]` |
| `sort` | `column`, `direction`, `albumSortMode` |
| `caches` | `coverCache Map`, `thumbnailCache Map`, `homeDataCache` |
| `favorites` | `tracks Set` |
| `contextMenu` | `tracks[]`, `trackIndex` |
| `dom` | DOM element references cached at init |

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
function hideSomething() {
  if (myAbort) { myAbort.abort(); myAbort = null }
}
```

### Backend — Rust (`src-tauri/src/`)

| File | Role |
|------|------|
| `lib.rs` | 60+ `#[tauri::command]` functions + app setup + global cache statics |
| `audio_engine.rs` | Playback state, device switching, hog mode (bit-perfect via CoreAudio exclusive) |
| `audio_decoder.rs` | Symphonia-based decoding (FLAC/WAV/MP3/AAC/ALAC/Vorbis) |
| `audio/coreaudio_backend.rs` | macOS CoreAudio HAL, sample rate negotiation |
| `eq.rs` | 8-band parametric EQ (biquad filters) |
| `resampler.rs` | Sample rate conversion (rubato FFT, 1024-sample chunks) |
| `audio/coreaudio_stream.rs` | CoreAudio AudioUnit stream setup + render callback |
| `types.rs` | Shared types: `AudioInfo`, `PlaybackCommand`, standard sample rates |
| `backend.rs` | `AudioBackend` trait (abstraction for future WASAPI port) |

**Global cache statics in `lib.rs`:**

| Static | Type | Notes |
|--------|------|-------|
| `TRACKS_CACHE` | `Mutex<TracksCache>` | All tracks with metadata — source for `load_tracks_from_cache` |
| `METADATA_CACHE` | `Mutex<MetadataCache>` | Per-path metadata cache (`HashMap<String, Metadata>`) |
| `COVER_CACHE` | `Mutex<CoverCache>` | Cover art binary data |

**Critical — `write_metadata` must update BOTH caches:** `METADATA_CACHE` invalidation alone is not enough. When `genre_enrichment_complete` fires (background async task), the JS listener calls `load_tracks_from_cache` → replaces `library.tracks` from `TRACKS_CACHE`. If `TRACKS_CACHE` was not updated, JS-side mutations are overwritten with stale data and tracks appear to "disappear" (they are actually under the old artist/album name). Always update `TRACKS_CACHE` + call `save_tracks_cache()` inside `write_metadata`.

**Tauri commands grouped by domain:**
- **Cache/metadata** (18): `scan_folder_with_metadata`, `get_cover`, `get_cover_thumbnail`, `fetch_internet_cover`, `fetch_artist_image`, `load_tracks_from_cache`, `start_background_scan`, `write_metadata`, …
- **Playlists** (11): `get_playlists`, `create_playlist`, `add_track_to_playlist`, `toggle_favorite`, `export_playlist_m3u`, `import_playlist_m3u`, …
- **Audio playback** (9): `audio_play`, `audio_pause`, `audio_seek`, `audio_preload_next`, `set_gapless_enabled`, …
- **Audio devices** (7): `get_audio_devices`, `set_audio_device`, `set_exclusive_mode`, …
- **Listening history** (8): `record_play`, `get_top_artists`, `get_recent_albums`, …
- **EQ** (3): `set_eq_enabled`, `set_eq_bands`, `get_eq_state`

**Startup flow:** `init_cache()` → `load_tracks_from_cache()` (instant, from disk) → `start_background_scan()` (async, emits `scan_progress` events) → `enrich_genres_from_deezer()` (async, emits `genre_enrichment_complete`).

### External APIs (called from Rust via reqwest)

MusicBrainz + CoverArtArchive (album art), Deezer (artist images + genre enrichment), WikiMedia.

### Audio pipeline (end-to-end)

```
File → [Symphonia decoder] → f32 interleaved
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
- **Supported formats**: FLAC, WAV, AIFF, ALAC, MP3, AAC/M4A, OGG Vorbis (via Symphonia `features = ["all"]`)
- **Not supported**: WMA, DSD, Opus, MQA — extensions removed from scanner to avoid broken playback

### `noir://` custom protocol

Serves audio files and covers from disk. Defined in `lib.rs` → `tauri::Builder::register_asynchronous_uri_scheme_protocol("noir", ...)`.

- Path is URL-decoded then **canonicalized** + **boundary-checked** against allowed directories (library paths, thumbnail dir, cover dir)
- Helper functions `noir_response()` / `noir_response_with_headers()` build HTTP responses
- MIME type detection by extension, streaming with range request support

### Data files

All persisted to `~/.local/share/noir/` (or platform equivalent via `dirs::data_dir()`):

| File | Content |
|------|---------|
| `config.json` | `library_paths[]`, `excluded_paths[]`, audio device, EQ state |
| `tracks_cache.json` | Full track metadata (loaded at startup → `library.tracks`) |
| `metadata_cache.json` | Per-path raw metadata |
| `cover_cache.json` | Base64 cover art |
| `playlists.json` | User playlists |
| `listening_history.json` | Play history for home page stats |
| `thumbnails/` | 80×80 JPEG thumbnails |

### Security conventions

- **Path validation**: `write_metadata` canonicalizes the path and checks `starts_with()` against configured `library_paths` — prevents writing outside the library
- **HTML escaping**: `escapeHtml()` from `utils.js` used on all user-facing data (47+ call sites)
- **File permissions**: `save_file_secure()` in `lib.rs` sets 0600 on all cache files
- **Debug logging**: use `#[cfg(debug_assertions)]` to wrap `println!` in Rust — stripped in release builds
- **CSP**: configured in `tauri.conf.json` line 25 — controls script/img/connect sources

## Key Constraints

- **macOS only for audio**: CoreAudio backend, hog mode, exclusive stream — no Windows/Linux audio path. The `AudioBackend` trait in `backend.rs` is ready for a future WASAPI implementation.
- **Release profile**: `Cargo.toml` has `[profile.release]` with `opt-level = 3`, `lto = true`, `strip = true`, `codegen-units = 1` for anti-reverse-engineering and performance.
- **No bundler**: `"type": "module"` in package.json, scripts loaded via `<script type="module">` in index.html.
- **No devUrl**: Tauri serves static files from `src/` directly. `preview_start` opens a native macOS window, not a browser URL.
- **Virtual scroll**: `views.js` maintains a 60-node DOM pool (`POOL_SIZE=60`, `TRACK_ITEM_HEIGHT=48`). Never modify track DOM nodes outside this system.
- **Gapless playback**: `audio_preload_next` must be called ~5s before track end. Timing logic in `playback.js`.
- **Event delegation**: album/artist grid cards carry `dataset.albumKey` / `dataset.artistKey`. Add interactions via delegation on the grid container, not per-card listeners.
- **Context menu lifecycle**: `panels.js` uses `contextMenuAbort` (AbortController) — document listeners are active only while the menu is visible. `activeCaptureHandler` in `renderer.js` stores the current shortcut-capture keydown listener for cleanup if settings close mid-capture.
- **Metadata editing**: `panels.js` → `enterTrackEditMode()` (single track inline form) and `showBulkEditModal()` (N tracks). Genre field uses `setupGenreCombobox()` backed by `getLibraryGenres()` (collected from `library.tracks`). After save, always call `app.groupTracksIntoAlbumsAndArtists()` to rebuild the artist/album index, otherwise the Artists view will show stale/duplicate entries.
