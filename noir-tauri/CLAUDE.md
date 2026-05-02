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
| `renderer.js` | ~890 | Orchestrator: registers all module functions on `app`, settings panel, sidebar resize, `init()` ; init `error-tracking.js` AVANT tout autre module pour capturer les erreurs d'init |
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
| `feedback.js` | ~245 | Floating feedback button + modal (bug/feature/other), checkbox "Attach recent logs" → invoke `get_recent_logs` et préfixe la description, envoie via Tauri `submit_feedback` |
| `error-tracking.js` | ~85 | **Forwarder Sentry JS** : `window.error` + `unhandledrejection` → `invoke('report_js_error')`. Anti-spam dédup 5s. Pas de SDK `@sentry/browser` (1 seul DSN côté Rust) |
| `drag.js` | ~182 | Custom drag (mousedown/move/up) — HTML5 drag is broken in Tauri WebView |
| `utils.js` | ~350 | Pure utilities: `showToast`, `escapeHtml`, `formatTime`, `setManagedTimeout`, `createParticleCanvas` |
| `lyrics.js` | ~220 | Lyrics panel (lrclib.net, lyrics.ovh fallback) |
| `onboarding.js` | ~1 110 | Onboarding flow (6 steps): library path selection, NAS discovery (avec hint permission Local Network macOS), SMB auth/browse, scan progress. Shown when `savedPaths.length === 0 && networkSources.length === 0` |
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
- Accent vert : `#4ade80` (statut success)
- Rouge : `#f87171` (erreurs)

### Cover art resolution pipeline

**`loadThumbnailAsync(path, imgElement, artist, album)`** (`library.js`) — pipeline 4 niveaux :

1. **`thumbnailCache`** (mémoire) → instantané si déjà chargé dans cette session
2. **`get_cover_thumbnail`** (IPC Rust) → cache disque `~/.noir_desktop/thumbnails/{hash}_thumb.jpg`
3. **`get_cover`** (IPC Rust) → extraction depuis les tags du fichier audio (lofty)
4. **`fetch_internet_cover`** (IPC Rust) → MusicBrainz + CoverArtArchive (nécessite `artist` + `album` non null)

**⚠️ Contrainte `isConnected`** : `loadThumbnailFromQueue()` vérifie `imgElement.isConnected` dès l'entrée en file d'attente (ligne 400 de library.js). Si l'élément `<img>` n'est PAS connecté au DOM, la fonction retourne immédiatement sans charger la cover. Conséquence : ne JAMAIS créer un `<img>` détaché et le passer à `loadThumbnailAsync` en espérant qu'il sera inséré plus tard. L'`<img>` doit être dans le DOM AVANT l'appel.

**Internet cover storage** : `~/.noir_desktop/covers/internet_{md5(artist|||album)}.jpg`

### CSS layout — critical flex constraint

`.main-content` has `min-width: 0` — **do not remove**. Without it, carousels with `width: calc(100% + extra)` inflate the flex item beyond the viewport, breaking grid layouts (e.g. `.home-recent-grid` columns expand to 1492px each instead of ~268px) and preventing horizontal scroll on carousels.

```css
.main-content { flex: 1; min-width: 0; }  /* min-width: 0 is critical */
```

### Backend — Rust (`src-tauri/src/`)

| File | Role |
|------|------|
| `lib.rs` | 75+ `#[tauri::command]` functions + app setup + global cache statics. `pub fn run()` initialise Sentry et tracing AVANT le builder Tauri (les guards doivent vivre toute la durée de l'app) |
| `audio_engine.rs` | Playback state, device switching, hog mode (bit-perfect via CoreAudio exclusive) |
| `audio_decoder.rs` | Symphonia-based decoding (FLAC/WAV/MP3/AAC/ALAC/Vorbis) + `SmbProgressiveFile` |
| `audio/coreaudio_backend.rs` | macOS CoreAudio HAL, sample rate negotiation, system default device sync |
| `audio/coreaudio_stream.rs` | CoreAudio AudioUnit stream setup + render callback, gapless transition |
| `media_controls.rs` | souvlaki wrapper — enregistre Noir dans `MPRemoteCommandCenter` pour intercepter les media keys même quand Apple Music tourne. Expose `init_media_controls`, `update_metadata`, `update_playback_state`. Émet `media-control` vers JS. |
| `eq.rs` | 8-band parametric EQ (biquad filters) |
| `resampler.rs` | Sample rate conversion (rubato FFT, 1024-sample chunks) |
| `sentry_init.rs` | **Sentry init** + panic hook (auto-enregistré par feature `panic`) + anonymisation paths utilisateur (`/Users/<x>` → `<HOME>`) dans `before_send`. Toggle runtime via `SENTRY_ENABLED: AtomicBool` (Settings → Privacy). Capture aussi les erreurs JS forwardées via `capture_js_error()`. DSN injecté au compile-time via `option_env!("HEAN_SENTRY_DSN")`. |
| `logging.rs` | **Logs persistés** via `tracing` + `tracing-appender`. Rotation journalière dans `~/Library/Application Support/noir/logs/noir.log`. Garde 7 jours, cleanup auto. `read_recent_logs(max_bytes)` lit les 1-2 derniers fichiers (concaténés, tronqués au tail). Utilisé par le bouton "Joindre les logs" du modal feedback. |
| `network/smb_utils.rs` | Parse `mount` output → map `smb://host/share` to local `/Volumes/...` — used as fallback by `audio_play` and `audio_preload_next` for local SMB mounts |
| `audio/types.rs` | Shared types: `AudioInfo`, `PlaybackCommand`, standard sample rates |
| `audio/backend.rs` | `AudioBackend` trait (abstraction for future WASAPI port) |

### DAP Sync — feature archivée

La feature DAP Sync (synchronisation vers Digital Audio Player via Mass Storage / MTP / SMB) a été retirée du build actif le 2026-04-22 à cause de bugs d'instabilité non résolus. Le code est conservé sur la branche `archive/dap-sync-v1` et le tag `dap-sync-archive-2026-04`. Voir [`docs/archive/dap-sync/`](../docs/archive/dap-sync/) pour le rapport complet (architecture, décisions, bugs connus, procédure de réintégration).

**Reste encore actif** : `network/smb_utils.rs` (résolution `smb://` → chemin local), utilisé par le streaming audio SMB.

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

### Feedback → Cloudflare Worker → GitHub Issues

Architecture mise en place 2026-04 → l'app NE contient PLUS le token GitHub. Tout passe par un worker Cloudflare proxy qui détient le secret côté serveur.

```
Hean app → POST $NOIR_WORKER_URL → Cloudflare Worker → GitHub Issues API
                                  ↑                    ↑
                                  vit côté Cloudflare  GITHUB_TOKEN secret côté CF
```

- `submit_feedback` (Tauri command, [lib.rs:4084](src-tauri/src/lib.rs)) : sauvegarde locale **toujours** dans `~/Library/Application Support/noir/feedback/` (backup) + POST vers le worker si `NOIR_WORKER_URL` + `NOIR_WORKER_SECRET` sont injectés au compile-time
- Worker : [scripts/cloudflare-worker.js](scripts/cloudflare-worker.js) — 2 routes :
  - `POST /feedback` (ou racine, legacy) : valide `X-Noir-Secret`, forward à GitHub Issues avec `GITHUB_TOKEN` (secret CF)
  - `GET /sentry/issues` + `/sentry/issue/{shortId}` : proxy Sentry pour le dashboard (contourne CORS browser-side, voir Dashboard ci-dessous)
- Déploiement : `cd noir-tauri/scripts && wrangler deploy` (1 fois) puis `wrangler secret put GITHUB_TOKEN` + `NOIR_SECRET` + `SENTRY_AUTH_TOKEN`
- Sans worker configuré (env vars absents au build) → feedback sauvé en local seulement
- **Piège** : env vars sont `NOIR_WORKER_URL` + `NOIR_WORKER_SECRET` (pas `FEEDBACK_*`). `option_env!` retourne `None` sinon, et le code fait fallback "local-only" silencieusement.

### Observabilité — Sentry + logs persistés

**Stack** :
- Sentry pour les **panics Rust** (panic hook auto via feature `panic`) + **erreurs JS** (`window.error` + `unhandledrejection` → `report_js_error` Tauri command → `sentry::capture_event` côté Rust)
- Tracing pour les **logs persistés** (`tracing-appender`, rotation journalière, `~/Library/Application Support/noir/logs/`)

**Anonymisation** : `before_send` dans `sentry_init::scrub_event` remplace `/Users/<name>/...` → `<HOME>/...` dans message + breadcrumbs + exception values. `send_default_pii: false` pour ne pas stocker les IPs côté Sentry.

**RGPD opt-out** : Settings → Privacy → "Send error reports" toggle.
- Persisté dans `Config.sentry_enabled: Option<bool>` (config.json)
- Lu au boot par `pub fn run()` AVANT init Sentry
- Toggle runtime via `AtomicBool` SENTRY_ENABLED checké dans `before_send` → désactivation immédiate sans redémarrage si Sentry était init au boot
- Si toggle activé alors que Sentry n'a pas été init au boot (`enabled=false` au démarrage) → message "Restart Hean to enable error reporting" affiché dans le hint

**Bouton "Attach recent logs" du modal feedback** : appelle `get_recent_logs(maxKb: 200)` qui retourne les 1-2 derniers fichiers de log concaténés et tronqués au tail. Préfixé à la description avant POST au worker.

**DSN compile-time** : injecté via `option_env!("HEAN_SENTRY_DSN")` (project Sentry `hean-app/rust`, région EU `https://de.sentry.io`). Sans DSN → `sentry_init::init()` retourne `None`, no-op total.

### Release pipeline — Apple signing + notarisation + updater

**Scripts wrappers** :
- `scripts/dev.sh` : source `.env.local`, vérifie le DSN chargé, relance `npm install` si `node_modules` absent, lance `npm run tauri dev`. Évite le piège `option_env!` silencieux en mode dev.
- `scripts/release.sh` : source `.env.local`, valide les **6 vars requises** (`HEAN_SENTRY_DSN`, `APPLE_*`, `TAURI_SIGNING_PRIVATE_KEY`), vérifie le certificat Apple dans Keychain, run cargo + JS tests, build release. Vérifie codesign + spctl à la fin.

**Pipeline complet (dans l'ordre, 6 étapes)** :
1. `cargo build --release` (LTO, ~5 min) → produit `Hean.app`
2. **Bundle dylibs externes** via `dylibbundler -b -x <bin> -d <Frameworks/> -p @executable_path/../Frameworks/ -cd`. Embarque ~92 dylibs Samba dépendances de `libsmbclient` (sinon l'app crash sur les Macs sans Homebrew).
3. **Fix doublons LC_RPATH** : `dylibbundler` ajoute un rpath à chaque dylib mais certaines en avaient déjà un de Homebrew → doublons → macOS dyld refuse (depuis Big Sur). Boucle `install_name_tool -delete_rpath @executable_path/../Frameworks/` sur les ~66 dylibs concernées.
4. Re-sign chaque dylib + l'app entière avec `--force --sign $APPLE_SIGNING_IDENTITY --options runtime --timestamp`
5. **Notariser l'app** via `xcrun notarytool submit ... --wait` (~2-5 min) puis `xcrun stapler staple`
6. Créer DMG via `hdiutil create -volname "Hean" -format UDZO`, signer le DMG, **notariser le DMG aussi** (sinon Gatekeeper refuse même si l'app à l'intérieur est notarisée), stapler
7. Tarball updater : `tar -czf Hean.app.tar.gz Hean.app` + `tauri signer sign --private-key $TAURI_SIGNING_PRIVATE_KEY --password $TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
8. Publier sur GitHub Releases : DMG, `.app.tar.gz`, `.app.tar.gz.sig`, `latest.json` (le fichier consulté par l'updater)

**Tauri updater** :
- Endpoint : `https://github.com/thomasdugue/noirdesktop/releases/latest/download/latest.json` (typo `tdugue/noir-desktop` corrigée 2026-05-01)
- Pubkey minisign dans `tauri.conf.json` doit matcher la clé privée dans `~/.tauri/hean.key` (regénérée 2026-05-01 sans password — l'ancienne avait un password inconnu)
- Si on régénère la clé : il faut **rebuilder l'app** pour que la nouvelle pubkey soit embarquée, sinon les futurs updates signés seront rejetés par les apps déjà installées

**`.env.local` requis** (`scripts/.env.local`, gitignored) :
```
HEAN_SENTRY_DSN=...
NOIR_WORKER_URL=https://noir-feedback.<sub>.workers.dev
NOIR_WORKER_SECRET=...
APPLE_SIGNING_IDENTITY="Developer ID Application: Thomas Dugué (XXXXXXXXXX)"
APPLE_TEAM_ID=...
APPLE_ID=thomas.dugue@gmail.com
APPLE_PASSWORD=xxxx-xxxx-xxxx-xxxx          # App-Specific Password Apple, pas le mdp Apple ID
TAURI_SIGNING_PRIVATE_KEY=...               # contenu du fichier ~/.tauri/hean.key
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=...      # password de la clé minisign si chiffrée
```

⚠️ **NE JAMAIS commit `.env.local`** (gitignored par `.env*` racine + `*.local` dans `noir-tauri/.gitignore`). Permissions `chmod 600` recommandé.

### Dev dashboard (`docs/index.html` → GitHub Pages)

[`thomasdugue.github.io/noirdesktop/`](https://thomasdugue.github.io/noirdesktop/) — cockpit du dev qui affiche :
- **Issues GitHub** (de `noir-feedback`) avec checkbox de sélection
- **Crashs Sentry** (via worker proxy `/sentry/issues`) **dans la même liste**, avec icône éclair violette + checkbox
- Filtres 2D : Source (All/GitHub/Sentry) × Type (All/Bugs/UX/Sprint/High)
- 4 actions : Feedback Agent, Synthèse Sprint, Plan détaillé, Debug

**Plan détaillé** ([`scripts/sprint-planner.js --plan <ids>`](scripts/sprint-planner.js)) :
- Accepte mix de numéros GitHub (`12`) et Sentry shortIds (`RUST-1`)
- Sentry shortIds → fetch via worker `/sentry/issue/{shortId}` (qui résout le shortId → groupId puis fetch issue + last event avec stack trace)
- Modèle : **`claude-opus-4-7`** (pas 4-5 ni 4-6)
- Adaptive thinking + effort `xhigh` (recommandé Anthropic pour coding/agentic)
- **Charge 583 KB de codebase main** dans le prompt (16 fichiers JS + 13 fichiers Rust prioritaires, cap 60KB par fichier, total 600KB)
- **Prompt caching** : `cache_control: ephemeral` sur le bloc codebase → ~90% économie sur les appels 2/N dans la même fenêtre 5min
- Génère `SPRINT.md` qui est **upload comme artifact** GitHub Actions (pas commit dans le repo — l'ancien commit a été supprimé pour ne plus polluer les nouveaux runs)

**Tokens GitHub côté repo** :
- Secret repo `NOIR_GITHUB_TOKEN` : utilisé par les workflows CI (`feedback-agent.yml`, `sprint-plan.yml`, `sprint-synthesis.yml`) pour fetch les issues. Doit avoir `Issues:Read` sur `thomasdugue/noir-feedback`.
- PAT du dashboard browser (localStorage) : pour fetch issues + déclencher les workflows. Doit avoir `Issues:RW` + `Actions:RW` sur `noirdesktop` ET `noir-feedback`.

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
| `dap_sync.db` | **Feature archivée** — SQLite DB des destinations DAP (tables laissées en place pour préserver les configs des beta-testers, plus lues depuis 2026-04-22) |

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
- **Cover thumbnails — `isConnected` obligatoire** : `loadThumbnailAsync` vérifie `imgElement.isConnected` avant de lancer le chargement. Un `<img>` détaché du DOM (créé via `document.createElement` mais pas encore inséré) est silencieusement ignoré. Toujours insérer l'`<img>` dans le DOM AVANT d'appeler `loadThumbnailAsync`.
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
- **Sentry = un seul DSN côté Rust.** Pas de SDK `@sentry/browser` JS (1.5MB minifié, lourd, pas de bundler). Les erreurs JS sont forwardées via `invoke('report_js_error')` → `sentry::capture_event()` côté Rust. Économie + 1 seul projet Sentry à monitorer + pas de double-comptage.
- **Tokens secrets compile-time only.** `option_env!()` lit les env vars à la compilation, pas au runtime. **Ne JAMAIS** stocker un token (Sentry DSN, GitHub feedback, Tauri signing key) dans le runtime — toujours via `option_env!`. Wrapper `release.sh` valide les vars AVANT le build pour éviter les builds release silencieusement sans secrets.
- **Cloudflare Worker pour le feedback** (au lieu d'un GitHub PAT compile-time dans le binaire). Le binaire ne contient plus de credentials GitHub — uniquement l'URL du worker + un secret partagé. Le worker tient le `GITHUB_TOKEN` côté serveur. Si le binaire fuit, le pire qui arrive c'est qu'on doit révoquer le `NOIR_SECRET` (pas un token GitHub avec des droits étendus).
- **Dylib bundling pour libsmbclient.** Sur macOS, `pavao` linke contre `libsmbclient.0.8.1.dylib` qui dépend transitivement de ~92 dylibs Samba (Homebrew). Sans bundling, l'app crash au lancement chez tous les Macs sans Homebrew. Pipeline release.sh : `dylibbundler` → fix LC_RPATH dupliqués (`install_name_tool -delete_rpath`) → re-sign chaque dylib + l'app entière → notariser. **Ne JAMAIS skipper le bundling**, sous peine de DMG inutilisables chez les testeurs.
- **DMG ET app sont notarisés séparément.** Tauri notarise l'app mais pas le DMG. Sans notarisation explicite du DMG (`xcrun notarytool submit Hean_*.dmg`), Gatekeeper refuse le DMG même si l'app à l'intérieur est OK. Toujours notariser les deux + stapler les deux.
- **Privacy toggle = `AtomicBool` runtime + persistence config.json.** Le toggle dans Settings → Privacy ne nécessite pas de redémarrage SI Sentry était init au boot (le `before_send` callback check l'AtomicBool à chaque event). Si Sentry n'a pas été init au boot (`enabled=false` au démarrage), le toggle persiste mais ne prend effet qu'au prochain reboot. UI affiche un hint "Restart Hean to enable error reporting" dans ce cas.
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
- **Sentry `before_send` doit drop les events si `SENTRY_ENABLED.load(Relaxed) == false`.** Sans ce check, désactiver le toggle dans Settings ne stoppe pas l'envoi des events qui sont déjà dans le hub Sentry. Le test unitaire `scrubs_*` couvre l'anonymisation des paths mais pas le toggle — vérifier visuellement après chaque modif de `sentry_init.rs`.
- **`option_env!()` doit être utilisé pour TOUS les secrets compile-time** (`HEAN_SENTRY_DSN`, `NOIR_WORKER_URL`, `NOIR_WORKER_SECRET`). Sans ça, le binaire release est silencieusement privé du secret (pas d'erreur runtime, juste un fallback "save locally" / "no Sentry"). `scripts/release.sh` valide la présence des vars AVANT le build pour éviter ce piège — ne JAMAIS bypass ce script en lançant `npm run tauri build` à nu.
- **`dylibbundler` doit être suivi du fix LC_RPATH dupliqués.** dylibbundler ajoute systématiquement un `LC_RPATH @executable_path/../Frameworks/` à chaque dylib mais certaines dylibs Samba en avaient déjà un (Homebrew). 66/92 dylibs ont des doublons → macOS dyld refuse depuis Big Sur. Le pipeline doit : (1) `dylibbundler` → (2) boucle sur Frameworks/ qui détecte les doublons et fait `install_name_tool -delete_rpath` une seule fois → (3) re-sign chaque dylib touchée. Ne JAMAIS oublier l'étape 2.

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
- **2026-03-16** : Fix playlist mosaic covers — 2 bugs corrigés dans `playlists.js`. **(1) Déduplication incohérente** : `getPlaylistAlbumCovers` dédupliquait par `artist::album` (artist+album combinés) alors que `library.albums` déduplique par album seul (`normalizeKey(album)`). Conséquence : les variations "feat." dans les noms d'artistes créaient de faux albums distincts → même pochette affichée 2, 3 ou 4 fois dans la mosaïque, ou cellules fantômes noires. Fix : renommé en `getPlaylistAlbumCovers`, retourne des objets `{ path, artist, album }`, déduplique par `album.trim().normalize('NFC')` seul. **(2) Fallback internet manquant** : `loadPlaylistThumbs` n'avait que 3 niveaux de fallback (cache → thumbnail → get_cover). Les albums sans cover embarquée (récupérée via MusicBrainz/Deezer) restaient noirs. Fix : ajout étape 4 `fetch_internet_cover(artist, album)` + injection `data-cover-artist`/`data-cover-album` dans `buildPlaylistThumbHtml`. Invariants ajoutés dans CLAUDE.md pour prévenir les régressions.
- **2026-04-22** : Retrait de la feature DAP Sync (Mass Storage / MTP / SMB) avant le lancement de la beta — instabilité non résolue sur MTP (Transaction ID mismatch, timeouts, InvalidObjectHandle). Code archivé sur branche `archive/dap-sync-v1` + tag `dap-sync-archive-2026-04`. Rapport complet dans [`docs/archive/dap-sync/`](../docs/archive/dap-sync/). `smb_utils.rs` déplacé vers `network/` (partagé avec le streaming audio). Les tables SQLite `dap_destinations` / `dap_sync_selection` sont laissées en place dans la DB utilisateur pour préserver les configurations des beta-testers en vue d'une future réintégration. Les sprints DAP Sync (2026-03-14, 03-15, 03-17, 03-23, 03-24) sont résumés dans l'archive (voir DECISIONS.md et KNOWN_ISSUES.md).
- **2026-05-01 / 02** : **Préparation launch beta v0.2.0-beta.1** — session intensive (~10h) qui a câblé tout ce qui manquait avant la distribution aux 50 testeurs. (1) **Sentry** : nouveaux modules `sentry_init.rs` + `error-tracking.js`, panic hook auto, anonymisation paths (`/Users/<x>` → `<HOME>`), forwarder JS via `report_js_error` Tauri command, toggle privacy RGPD dans Settings (AtomicBool runtime + persisté config.json). (2) **Logs persistés** : nouveau module `logging.rs` avec tracing-appender (rotation journalière, 7 jours, `~/Library/Application Support/noir/logs/`), bouton "Joindre les logs" dans le modal feedback. (3) **Cloudflare Worker** : refactor du worker pour ajouter route `/sentry/issues` + `/sentry/issue/{shortId}` (proxy Sentry pour contourner CORS browser). (4) **Apple signing E2E** : `scripts/release.sh` automatisé (validation env vars, certificate keychain, codesign, notarisation app + DMG), bug Notarisation 403 résolu (acceptation des nouveaux Apple Developer agreements), bug `dylibbundler` (92 dylibs Samba bundlées dans Frameworks/) et fix doublons LC_RPATH (66 dylibs corrigées via `install_name_tool -delete_rpath`) — sans ces 2 étapes l'app crash au lancement. (5) **Tauri updater** : fix endpoint typo (`tdugue/noir-desktop` → `thomasdugue/noirdesktop`), regénération clé minisign sans password (l'ancienne avait un password inconnu), ajout `bundle.macOS.minimumSystemVersion: "11.0"`. (6) **Release v0.2.0-beta.1 publiée sur GitHub** avec DMG signé+notarisé (~35 MB), tarball updater + signature, latest.json. (7) **Dashboard dev** ([thomasdugue.github.io/noirdesktop](https://thomasdugue.github.io/noirdesktop/)) : ajout des crashs Sentry dans la même liste que les issues GitHub avec checkbox + filtre Source 2D, refonte `sprint-planner.js` pour Opus 4.7 + adaptive thinking + effort xhigh + chargement de 583 KB de codebase main + prompt caching ~90% économie sur appels 2/N. (8) **Bug fix** : suppression de `SPRINT.md` du repo (était commit, créait des synthèses parasites en concaténant l'historique avec les nouveaux runs). (9) **Onboarding** : hint permission Local Network macOS sur l'étape NAS discovery. (10) **Docs testeurs** : `BETA_TESTERS_GUIDE.md`, `BETA_KNOWN_ISSUES.md`, `RELEASE_NOTES_v0.2.0-beta.1.md`, template GitHub `beta-bug-report.md`. Vars `.env.local` mappées : `HEAN_SENTRY_DSN`, `NOIR_WORKER_URL`/`SECRET`, `APPLE_*`, `TAURI_SIGNING_PRIVATE_KEY`/`PASSWORD`. Worker re-déployé avec secret `SENTRY_AUTH_TOKEN`. À faire pour beta.2 : ajouter `NSAppleEventsUsageDescription` + `NSDocumentsFolderUsageDescription` dans `tauri.conf.json` pour clarifier les popups système.
