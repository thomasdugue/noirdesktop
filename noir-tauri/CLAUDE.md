# CLAUDE.md

Guide de travail pour Claude Code sur Hean. Ce fichier est volontairement **court** (sommaire toujours lu en entier) : le détail vit dans les skills `.claude/skills/hean-*`, à charger selon la zone touchée.

## Skills Hean — quoi charger avant de travailler

| Zone touchée | Skill |
|---|---|
| **Toute modif de code, toute review de diff** | `hean-invariants` (règles « ne JAMAIS casser » + décisions actées) |
| `src-tauri/src/audio/`, `audio_engine.rs`, `audio_decoder.rs`, EQ, resampler, devices/AirPlay, media keys | `hean-audio` |
| `src-tauri/src/network/`, streaming SMB, `network.js` | `hean-smb` |
| Vues, covers, playlists, homepage, `styles.css` | `hean-frontend` |
| Feedback, Sentry, logs, worker Cloudflare, dashboard, workflows GitHub | `hean-ops` |
| Build release, signature, notarisation, updater | `hean-release` |

Historique des sessions : [`docs/HISTORY.md`](../docs/HISTORY.md).

## Commands

```bash
# depuis noir-tauri/
./scripts/dev.sh                       # dev (source .env.local → secrets option_env! injectés)
cd src-tauri && cargo check            # type-check Rust (rapide)
cd src-tauri && cargo clippy           # lints
cd src-tauri && cargo test             # tests Rust
for f in src/*.js; do node --check "$f" && echo "OK: $f"; done   # seule analyse statique JS
npm test -- --watchAll=false           # Jest (13 fichiers, src/__tests__/)
npm test -- --watchAll=false --testPathPattern=FormatDisplay      # un seul fichier
```

Pas de bundler, pas de linter JS : `src/` est servi tel quel (`frontendDist: "../src"`). Pas de devUrl : `preview_start` (`.claude/launch.json`, entrée `"noir-tauri"`) ouvre une fenêtre macOS native, pas une URL navigateur. Jest : 137 pass / 14 skipped (2026-10-26) — `Navigation`, `PlayerControls`, `AlbumView` sont skippés (besoin de `invoke` Tauri). **CI** (`.github/workflows/ci.yml`) : `node --check` + Jest (ubuntu) et `cargo test --locked` (macOS) sur chaque PR vers `main`.

## Architecture

Tauri v2, macOS. `src/` = 18 modules ES6 vanilla. `src-tauri/` = commandes Tauri + moteur audio Rust.

**Frontend** — `renderer.js` (orchestrateur, init `error-tracking.js` en premier) · `app.js` (**médiateur**, ~95 slots) · `state.js` (**state centralisé**) · `views.js` (toutes les vues, virtual scroll, `transitionView` async) · `playback.js` (contrôle audio via invoke, gapless, interpolation 60fps) · `panels.js` (queue, track info, édition metadata, menus contextuels) · `playlists.js` · `library.js` (covers, scan) · `network.js` (NAS/SMB) · `fullscreen-player.js` · `shortcuts.js` · `eq.js` · `search.js` · `feedback.js` · `error-tracking.js` · `drag.js` (drag custom — HTML5 drag cassé dans la WebView) · `utils.js` (`showToast`, `escapeHtml`, `formatTime`, `clearObject`…) · `lyrics.js` · `onboarding.js` (6 étapes, affiché si aucune source) · `auto-update.js`.

**Backend** (`src-tauri/src/`) — `lib.rs` (75+ `#[tauri::command]`, setup, caches globaux ; Sentry + tracing init AVANT le builder) · `audio_engine.rs`, `audio_decoder.rs` (Symphonia + `SmbProgressiveFile`), `audio/coreaudio_backend.rs`, `audio/coreaudio_stream.rs`, `audio/types.rs`, `audio/backend.rs` (trait pour futur WASAPI) · `media_controls.rs` (souvlaki) · `eq.rs` · `resampler.rs` · `sentry_init.rs` · `logging.rs` · `network/` (`mod.rs`, `smb.rs`, `scanner.rs`, `credentials.rs`, `discovery.rs`, `smb_utils.rs`). DAP Sync est archivé (voir `docs/archive/dap-sync/`).

APIs externes (reqwest) : MusicBrainz + CoverArtArchive, Deezer, WikiMedia. Protocole `noir://` : sert audio + covers depuis le disque, path canonicalisé + boundary-check, range requests.

### State objects (`state.js`) — partagés par référence, **jamais réassignés**

| Objet | Champs clés |
|---|---|
| `playback` | `currentTrackIndex`, `audioIsPlaying`, `currentPlayingAlbumKey`, `shuffleMode`, `repeatMode`, `volume`, `playbackContext`, `shufflePlayedTracks` |
| `library` | `tracks[]`, `albums{}`, `artists{}`, `tracksByPath Map` |
| `ui` | `currentView`, `selectedAlbumKey`, `isQueuePanelOpen`, `isTrackInfoPanelOpen`, `tracksViewOrder[]` |
| `queue` / `sort` / `caches` / `favorites` / `contextMenu` / `dom` | items · column/direction/albumSortMode · coverCache/thumbnailCache/homeDataCache · tracks Set · tracks/trackIndex · refs DOM |

`playbackContext` : `'library'` (vue tracks → séquentiel selon `ui.tracksViewOrder`), `'album'` (s'arrête en fin d'album), `null` (conservateur = comme album). **Navigation séquentielle en vue tracks : toujours `ui.tracksViewOrder`, jamais `library.tracks[currentTrackIndex ± 1]`** (ordre de scan ≠ ordre visuel).

### Critical patterns

```js
app.showToast('hello')                          // ✅ appels inter-modules via le médiateur
import { showToast } from './panels.js'         // ❌ deps circulaires

library.tracks.length = 0; library.tracks.push(...newTracks)  // ✅ muter
library.tracks = newTracks                      // ❌ casse la référence des autres modules
clearObject(library.albums)                     // ✅ vide sans casser la ref

try { await invoke('cmd', { arg }) } catch (e) { showToast('Message utilisateur') }  // invoke toujours wrappé
invoke('save_all_caches').catch(console.error)  // fire-and-forget

grid.addEventListener('click', (e) => {         // event delegation, jamais de listener par item
  const card = e.target.closest('.album-card')
  if (card?.dataset.albumKey) showAlbumDetail(card.dataset.albumKey)
})

if (myAbort) myAbort.abort()                    // listeners document transitoires → AbortController
myAbort = new AbortController()
document.addEventListener('click', closeHandler, { signal: myAbort.signal })

await transitionView(async () => { await displayHomeView() })  // async ; renderVersion annule les renders obsolètes
// network.js : currentModalState = état live du modal, lu par les events Tauri (nas_device_found). Set à l'ouverture, clear à la fermeture.
```

### Data files (`~/.local/share/noir/`, via `dirs::data_dir()`)

`config.json` (library_paths, **excluded_paths**, device, EQ) · `tracks_cache.json` · `metadata_cache.json` · `cover_cache.json` · `network_sources.json` (sans mots de passe → Keychain) · `network_scan_cache.json` · `playlists.json` · `listening_history.json` · `thumbnails/` · `covers/` · `smb_buffer/` (temp, nettoyé) · `feedback/` · `dap_sync.db` (archivé, laissé en place pour les testeurs).

### Security conventions

`write_metadata` canonicalise + `starts_with()` sur `library_paths` · `escapeHtml()` sur toute donnée affichée · `save_file_secure()` → 0600 · `println!` Rust sous `#[cfg(debug_assertions)]` · CSP dans `tauri.conf.json` · **jamais** commit `scripts/.env.local`.

## Key constraints

- **Virtual scroll** : pool de 60 nœuds (`POOL_SIZE=60`, `TRACK_ITEM_HEIGHT=48`) dans `views.js` — ne jamais modifier les nœuds tracks hors de ce système.
- **Covers** : l'`<img>` doit être dans le DOM AVANT `loadThumbnailAsync` (check `isConnected`). `get_cover_thumbnail` peut renvoyer `null` → toujours fallback `get_cover`. Détails : `hean-frontend`.
- **`.main-content { min-width: 0 }`** — ne pas retirer (sinon les grids explosent).
- **`scan_complete`** ne recharge que si `shouldReload` (sinon race avec le `displayHomeView` initial).
- **Édition metadata** : après save, toujours `app.groupTracksIntoAlbumsAndArtists()`.
- **SMB singleton** : un seul `SmbClient` à la fois, tout passe par le mutex `CONNECTION`. Détails : `hean-smb`.
- **Gapless** : `audio_preload_next` ~60s avant la fin pour SMB, ~10s en local.
- **Media keys** : souvlaki (`MPRemoteCommandCenter`) ; pas de F7/F8/F9 en global shortcuts (conflit Apple Music) ; ne pas retirer `unsafe impl Send for MediaControlsWrapper`.
- **Release profile** : `opt-level=3`, `lto=true`, `strip=true`, `codegen-units=1`.

## Invariants — résumé (détail + pourquoi : skill `hean-invariants`)

1. Un album = une seule entrée dans `library.albums`, clé `normalizeKey()` (trim + NFC), jamais la clé brute.
2. Homepage « Recently Played » : dédup par album (`artiste|||album`), pas par chemin.
3. SMB : retry avec reconnexion fraîche si `open_with()` échoue — ne jamais supprimer.
4. SMB : `retrieve_password()` jamais `unwrap_or_default()` — erreur Keychain explicite.
5. SMB : `audio_play` récupère `take_last_download_error()` quand `bytes_written == 0`.
6. Suppression de tracks = permanente : `excluded_paths` vérifié dans `init_cache`, `start_background_scan`, `scan_network_source_cmd` — et dans tout nouveau point d'entrée.
7. Metadata éditées = écrites dans le fichier audio (lofty) ; le cache n'est pas la source de vérité.
8. `write_metadata` : `METADATA_CACHE` mis à jour (UPDATE), **jamais** `remove()` ; garder `save_metadata_cache_to_file()`.
9. `start_background_scan` : ré-appliquer le snapshot `METADATA_CACHE` (pris avant le lock `TRACKS_CACHE`).
10. Mosaïques playlist : dédup par nom d'album seul, jamais artist+album.
11. Mosaïques playlist : fallback 4 niveaux obligatoire, jusqu'à `fetch_internet_cover`.
12. Mosaïque sidebar 28×28 : positionnement absolu, **jamais** CSS Grid.
13. Mosaïque sidebar : garder le rebuild auto (rAF + `_thumbsRefreshScheduled`) dans `loadPlaylistThumbs()`.
14. Garder les règles CSS hover `.track-add-queue` / `.track-add-playlist`.
15. Sentry `before_send` drop les events si `SENTRY_ENABLED == false`.
16. Tous les secrets compile-time via `option_env!()` ; ne jamais bypass `scripts/release.sh`.
17. `dylibbundler` toujours suivi du fix LC_RPATH dupliqués + re-sign.
18. Audio = coreaudio-rs, **jamais** revenir à CPAL. Bit-perfect = pas de resampling.

## Règles de travail

- Ne JAMAIS modifier l'audio (`src-tauri/src/audio/` et fichiers audio) quand tu travailles sur l'UI ou la library. Et inversement.
- Un prompt = une tâche. Ne pas toucher à ce qui est hors scope.
- Répondre toujours en français.

## Protocole de session

**Début** : (1) lire ce fichier + le skill de la zone · (2) `cargo check` · (3) `cargo test` · (4) `npm test -- --watchAll=false` · (5) `node --check` sur `src/*.js` — noter X pass / Y fail. Si des tests échouent AVANT de commencer → le signaler, on corrige d'abord.

**Fin** : relancer `cargo test` + `npm test` et comparer au début. Un test qui passait et échoue = RÉGRESSION → corriger avant de terminer. Mettre à jour « Bugs connus » ci-dessous, ajouter une entrée dans `docs/HISTORY.md`, et si une nouvelle règle est née, l'ajouter à `hean-invariants` (+ une ligne au résumé ci-dessus). Commit « [tâche du jour] terminée ».

## Specs détaillées

À lire AVANT de travailler sur une feature : `docs/NOIR_DESKTOP_SPEC.md` (spec principale) · `docs/SPEC-test-suite.md` (suite de tests, protocole) · `docs/prompt-test-suite-noir.md`.

## Bugs connus

- **gapless_transition en contexte library** : si `ui.tracksViewOrder` est vide (vue tracks jamais rendue), la transition laisse `currentTrackIndex` inchangé. Cas marginal.
- **Drag ESC sur homepage** : annuler un drag avec Escape peut laisser le ghost visible si `customDragState.isDragging` n'est pas encore `true`.
- **Sidebar playlist thumbnail au 1er démarrage (sans cache)** : `loadPlaylistThumbs` passe par `get_cover` → légère latence.
