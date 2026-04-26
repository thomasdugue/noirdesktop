# DAP Sync — Vue d'ensemble architecturale

## Définition

DAP Sync = synchronisation de la bibliothèque musicale de Hean vers un **Digital Audio Player** (baladeur audio haute-résolution) connecté en USB ou monté sur SD card. 3 modes supportés :

1. **Mass Storage** : le DAP est monté comme volume USB standard (`/Volumes/XXX`) — copie fichier classique
2. **MTP** (Media Transfer Protocol) : le DAP est accessible via protocole MTP uniquement (Android, FiiO récents) — pas de montage, upload via `mtp-rs`
3. **SMB source** : la bibliothèque *source* est sur un NAS — résolution de `smb://` vers chemin local ou streaming

## Sub-views frontend

| Sub-view | Quand |
|---|---|
| `setup` | Première configuration d'un device |
| `albums` | Sélection des albums à synchroniser (vue principale) |
| `syncing` | Sync en cours (progress bar, phase, fichier courant) |
| `complete` | Sync terminée avec succès |
| `disconnected` | Device démonté pendant une opération |
| `settings` | Folder structure, mirror mode, etc. |
| `first-sync` | Onboarding pour le premier sync |

## Module frontend — `src/dap-sync.js` (2 957 lignes)

### État local (module-level, **pas** dans `state.js`)

| Variable | Type | Rôle |
|---|---|---|
| `destinations` | `Array` | Devices DAP configurés (depuis SQLite) |
| `currentDestinationId` | `number\|null` | ID du device actif |
| `selectedAlbums` | `Set<number>` | IDs des albums sélectionnés |
| `syncPlan` | `Object\|null` | Plan retourné par `dap_compute_sync_plan` |
| `isSyncing` | `boolean` | Sync en cours |
| `mountedVolumes` | `Set<string>` | Chemins des volumes montés |
| `dapSubView` | `string` | Sub-view courante |
| `syncProgress` | `Object` | Progression en cours |
| `syncResult` | `Object\|null` | Résultat de la dernière sync |
| `albumSearchFilter` | `string` | Filtre texte |
| `currentTab` | `'albums' \| 'artists' \| 'tracks'` | Onglet actif |
| `currentSortKey` | `'alpha-asc' \| 'alpha-desc' \| 'bitrate-asc' \| 'bitrate-desc' \| 'status'` | Tri actif |
| `detailsExpanded` | `boolean` | Panneau détails déplié |
| `_copyAlbumIds` | `Set<number>` | Albums avec fichiers à copier (O(1) lookup) |
| `_deleteSourcePaths` | `Set<string>` | Source paths à supprimer (O(1) lookup) |
| `_summaryDebounceTimer` | `number\|null` | Timer debounce compute (500ms) |
| `_saveSelectionsTimer` | `number\|null` | Timer debounce save (800ms) |
| `_needsOnDapPreselection` | `boolean` | Flag auto-désélection après 1er plan |
| `_externalVolumes` | `Array<ExternalVolume>` | Cache du dernier refresh volumes |

### Fonctions clés exportées

| Fonction | Rôle |
|---|---|
| `initDapSync()` | Init : volume watcher + destinations + volumes + event listeners |
| `openSyncPanel(dest)` | Ouvre le panneau pour un device |
| `renderAlbumsView(grid)` | Vue principale (dest bar + tabs + list + footer) |
| `renderAlbumRows()` | Rows album (DocumentFragment, batched thumbs) |
| `renderArtistRows()` | Rows par artiste |
| `renderTrackRows()` | Rows par track |
| `computeAndRenderSummary()` | Cœur : IPC `dap_compute_sync_plan` → badges + top bar |
| `debouncedComputeAndRenderSummary()` | Wrapper debounce 500ms |
| `precomputeSyncPlanLookups()` | Construit `_copyAlbumIds` + `_deleteSourcePaths` |
| `updateStatusTagsInPlace()` | Met à jour badges sans full re-render |
| `buildTracksForSync()` | Construit `TrackForSync[]` pour le backend |
| `saveSelections()` | Debounced (800ms) → IPC `dap_save_selections_batch` |
| `showDapTopBar()` / `hideDapTopBar()` | Bascule search bar ↔ sync bar |
| `updateSyncButton()` | Bouton Sync (enabled/disabled, pulse) |
| `renderSummary(plan, dest)` | Panneau détails 2 colonnes |
| `startSync()` | Lance la sync |
| `renderSidebarDestinations()` | Rendu sidebar DAP |
| `loadThumbsBatched(queue)` | 8 thumbnails / `requestAnimationFrame` |
| `showDapSyncModal({ albumKeys, artistName })` | Modal multi-destination |
| `toggleAlbumsOnDest(albumKeys, destId, action)` | Toggle sur n'importe quelle destination |
| `getMountedDestinations()` | Filtre par volumes montés |

### Flux checkbox click

```
click → toggle selectedAlbums Set → chk.classList.toggle('on')
  → updateSelectAllCheckbox()               [instantané]
  → saveSelections()                        [debounce 800ms → IPC dap_save_selections_batch]
  → updateSyncNowButton()                   [instantané]
  → debouncedComputeAndRenderSummary()      [debounce 500ms → IPC dap_compute_sync_plan → update badges]
```

### Flux page load

```
openSyncPanel(dest)
  → loadSelections(dest.id)                 [IPC dap_get_selections]
  → navigateToDapSync()                     [ui.currentView = 'dap-sync' → displayCurrentView()]
    → renderAlbumsView(grid)                [DOM construction]
      → renderAlbumRows()                   [DocumentFragment, O(1) badges, batched thumbs]
      → computeAndRenderSummary()           [async: buildTracksForSync → IPC Rust → update UI]
```

### Événements Tauri écoutés

| Événement | Handler |
|---|---|
| `volume_change` | `refreshMountedVolumes()` — re-détecte volumes, auto-crée destinations |
| `dap_sync_progress` | MAJ `syncProgress`, throttled via rAF |
| `dap_sync_complete` | `isSyncing = false`, `await refreshMountedVolumes()`, switch vers `complete` ou `albums` |

### Intégration cross-module (mediator pattern)

- **`app.js`** : slots `openSyncPanel`, `closeSyncPanel`, `loadDapDestinations`, `refreshMountedVolumes`, `displayDapSyncView`, `hideDapTopBar`, `renderSidebarDestinations`
- **`views.js`** : `displayCurrentView()` appelle `app.displayDapSyncView()` pour `case 'dap-sync'`. `hideDapTopBar()` pour restaurer la search bar.
- **`renderer.js`** : importe et enregistre toutes les fonctions DAP sur `app`
- **`index.html`** : `<div id="dap-sync-bar">` dans le header, `<div id="dap-sync-destinations">` dans la sidebar
- **`panels.js`** : context menu "Add/Remove from my DAP" (28 références)
- **`playlists.js`** : 1 référence DAP

---

## Backend Rust — `src-tauri/src/dap_sync/` (~6 980 lignes)

```
dap_sync/
├── mod.rs           14 lignes  — Module manifest
├── db.rs           273 lignes  — SQLite : dap_destinations + dap_sync_selection
├── manifest.rs     198 lignes  — .hean-sync.json read/write
├── volumes.rs      215 lignes  — Enumération /Volumes (diskutil + df)
├── watcher.rs      138 lignes  — Surveillance /Volumes (notify crate)
├── smb_utils.rs    200 lignes  — Résolution smb:// → chemin local ⚠️ SHARED AVEC STREAMING AUDIO
├── sync_plan.rs  1 733 lignes  — Calcul du plan (diff manifest vs sélection)
├── sync_engine.rs 2 368 lignes — Exécution copy/delete/manifest (Mass Storage)
└── mtp.rs        1 834 lignes  — Détection/upload/delete MTP + ptpcamerad suppressor
```

### Structs clés

| Struct | Fichier | Rôle |
|---|---|---|
| `DapDestination` | `db.rs` | Config device : name, path, folder_structure, mirror_mode |
| `TrackForSync` | `sync_plan.rs` | Track envoyée par le frontend : path, title, artist, album, size_bytes, album_id |
| `SyncPlan` | `sync_plan.rs` | Résultat : files_to_copy, files_to_delete, files_unchanged, enough_space |
| `SyncAction` | `sync_plan.rs` | Action : source_path, dest_relative_path, size_bytes, action, album_id |
| `SyncManifest` | `manifest.rs` | Format `.hean-sync.json` : hean_version, last_sync, files[] |
| `SyncedFile` | `manifest.rs` | Fichier tracké : dest_relative_path, size_bytes, quick_hash |
| `ExternalVolume` | `volumes.rs` | Volume détecté : name, path, total_bytes, free_bytes, is_removable |
| `SyncProgress` | `sync_engine.rs` | Event progress : phase, current/total, current_file, bytes_copied |
| `SyncComplete` | `sync_engine.rs` | Event fin : success, files_copied, files_deleted, duration_ms, errors |
| `MtpDeviceInfo` | `mtp.rs` | manufacturer, model, serial, storages[] |
| `MtpStorageInfo` | `mtp.rs` | id, description, capacity_bytes, free_bytes |

### 15 commandes Tauri exposées (`dap_*`)

| Commande | Rôle |
|---|---|
| `dap_list_external_volumes` | Liste volumes USB/SD removable |
| `dap_get_volume_info` | Espace libre/total d'un volume |
| `dap_save_destination` | Crée/MAJ un device |
| `dap_get_destinations` | Liste tous les devices |
| `dap_get_destination` | Récupère un device par ID |
| `dap_delete_destination` | Supprime device + sélections (CASCADE) |
| `dap_eject_volume` | Éjecte via `diskutil eject` |
| `dap_save_selection` | Sauvegarde sélection album unitaire |
| `dap_save_selections_batch` | Sauvegarde batch (transaction) |
| `dap_get_selections` | Récupère sélections d'un device |
| `dap_read_manifest` | Lit `.hean-sync.json` |
| `dap_compute_sync_plan` | Calcule plan (preview, sans exécution) |
| `dap_execute_sync` | Exécute Mass Storage dans thread séparé (émet progress + complete) |
| `dap_execute_mtp_sync` | Exécute MTP (émet progress + complete) |
| `dap_cancel_sync` | Set `DAP_SYNC_CANCEL` flag |
| `dap_start_volume_watcher` | Démarre surveillance montages |
| `dap_detect_mtp` / `dap_get_mtp_info` | Détection + info MTP |

### Algorithme `compute_sync_plan`

1. Lit le manifest (`.hean-sync.json`) → `HashMap<dest_relative_path, SyncedFile>`
2. Pour chaque track sélectionnée :
   - Calcule `dest_relative_path` depuis metadata (artist/album/track) via `build_dest_path()`
   - Si path dans manifest → `unchanged`
   - Sinon → `files_to_copy` (utilise `track.size_bytes` JS, **jamais `fs::metadata`** — cf. DECISIONS.md)
3. Mirror mode : fichiers du manifest non sélectionnés → `files_to_delete`
4. Vérifie l'espace : `enough_space = net_bytes ≤ 0 || net_bytes ≤ free_bytes`

### Exécution sync (`sync_engine.rs`) — 3 phases

1. **Delete** : supprime fichiers non sélectionnés (mirror mode). Covers protégées. Orphaned covers nettoyées.
2. **Copy + covers inline** : chunked I/O (256 KB, cancel check/chunk) + résolution SMB. Source ouverte **avant** `create_dir_all`. Covers copiées après le dernier audio de chaque album (pas de Phase 2b).
3. **Manifest** : écrit `.hean-sync.json` avec `quick_hash` (SHA-256 first 64 KB + last 64 KB). `cleanup_empty_dirs` en fin de sync.

### Tauri events émis

- `volume_change` : `{ event_type: "mounted"|"unmounted", volume_name, path }`
- `dap_sync_progress` : `{ phase, current, total, current_file, bytes_copied, total_bytes, action }`
- `dap_sync_complete` : `{ success, files_copied, files_deleted, total_bytes_copied, duration_ms, errors }`

---

## Persistance

### Tables SQLite (`~/.local/share/noir/dap_sync.db`)

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

**Au moment de l'archivage**, les tables sont **laissées en place** dans la DB des beta-testers pour préserver leurs configurations. Elles ne seront plus lues tant que la feature n'est pas réintégrée.

### Manifest device (`.hean-sync.json` à la racine du DAP ou local pour MTP)

```json
{
  "hean_version": "0.9.0",
  "last_sync": "2026-04-21T18:32:10Z",
  "destination_path": "/Volumes/SDCARD",
  "folder_structure": "artist_album_track",
  "files": [
    {
      "source_path": "/Volumes/NAS/Music/.../track.flac",
      "dest_relative_path": "Artist - Album/01 - Track.flac",
      "size_bytes": 52428800,
      "modified_at": "2026-04-21T18:32:05Z",
      "quick_hash": "abc123..."
    }
  ]
}
```

Pour MTP, le manifest est stocké localement dans `~/Library/Application Support/noir/mtp_manifest_{SERIAL}_{STORAGE_ID}.json` (le device MTP ne supporte pas toujours les fichiers cachés à sa racine).

## Dépendances exclusives

### Cargo
- `mtp-rs = { git = "https://github.com/vdavid/mtp-rs.git" }` — protocole MTP
- `notify` — surveillance filesystem `/Volumes` (possiblement partagée)

### Macros / env vars
- `COPYFILE_DISABLE=1` — désactive Apple Double (`._*`) pendant la copie (macOS)
- `mdutil -i off` — désactive Spotlight sur le device (corruption exFAT)

### Processus externes
- `diskutil info`, `diskutil eject` — volumes removable
- `df -k` — espace disque
- `mount` — parse pour mapper SMB → chemin local
- `caffeinate -s -i` — empêche sleep pendant sync (via `SleepGuard` RAII)
- `ptpcamerad` — suppressor (kill toutes les 200 ms — sinon macOS le respawn et capture le device MTP)
