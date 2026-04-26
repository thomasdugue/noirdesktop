# DAP Sync — Mode d'emploi de la réintégration

Ce document guide pas à pas la réintégration de la feature DAP Sync dans une version future de Hean.

**Avant de commencer** : lire [KNOWN_ISSUES.md](KNOWN_ISSUES.md) et avoir un plan pour les 3 problèmes pré-requis (Transaction ID, timeout adaptatif, checkpoint atomique).

---

## Deux stratégies possibles

### Stratégie A — Réimport tel quel depuis l'archive

**Quand l'utiliser** : si on veut reprendre exactement là où on s'était arrêté, avec le même design et les mêmes bugs connus. Utile pour valider rapidement un fix spécifique.

### Stratégie B — Refonte inspirée de l'archive

**Quand l'utiliser** (recommandé si + de 6 mois entre l'archivage et la reprise) : repartir d'une architecture neuve mais s'inspirer des modules Rust éprouvés (`sync_plan`, `sync_engine`, `manifest`, `db`, `volumes`, `watcher`). Le frontend `dap-sync.js` (2 957 lignes) gagnerait à être redécoupé en modules plus petits.

Dans tous les cas : **conserver la branche `archive/dap-sync-v1` intacte** jusqu'à validation complète de la nouvelle version.

---

## Stratégie A — Procédure de réimport

### 1. Restaurer le backend Rust

```bash
cd noir-tauri/src-tauri/src

# Restaurer le module complet (sauf smb_utils.rs qui vit ailleurs maintenant)
git checkout archive/dap-sync-v1 -- dap_sync/db.rs
git checkout archive/dap-sync-v1 -- dap_sync/manifest.rs
git checkout archive/dap-sync-v1 -- dap_sync/mod.rs
git checkout archive/dap-sync-v1 -- dap_sync/mtp.rs
git checkout archive/dap-sync-v1 -- dap_sync/sync_engine.rs
git checkout archive/dap-sync-v1 -- dap_sync/sync_plan.rs
git checkout archive/dap-sync-v1 -- dap_sync/volumes.rs
git checkout archive/dap-sync-v1 -- dap_sync/watcher.rs
```

**⚠️ smb_utils.rs** : au moment du retrait, ce fichier a été **déplacé** hors de `dap_sync/` (il est partagé avec le streaming audio). Il faut **mettre à jour `mod.rs`** pour pointer vers son nouvel emplacement actuel (ou reprendre le fichier depuis l'archive si la localisation actuelle convient).

### 2. Réenregistrer le module dans `lib.rs`

Dans `noir-tauri/src-tauri/src/lib.rs` :

```rust
mod dap_sync;  // ← restaurer cette ligne (était retirée)
```

### 3. Restaurer les 15 commandes Tauri dans `lib.rs`

Depuis l'archive, récupérer les blocs :

```bash
# Récupérer le lib.rs archivé pour référence
git show archive/dap-sync-v1:noir-tauri/src-tauri/src/lib.rs > /tmp/lib.rs.archive
```

Commandes à restaurer (chercher par nom dans `/tmp/lib.rs.archive`) :
- `dap_list_external_volumes`
- `dap_get_volume_info`
- `dap_save_destination`, `dap_get_destinations`, `dap_get_destination`, `dap_delete_destination`
- `dap_eject_volume`
- `dap_save_selection`, `dap_save_selections_batch`, `dap_get_selections`
- `dap_read_manifest`
- `dap_compute_sync_plan`
- `dap_execute_sync`, `dap_execute_mtp_sync`
- `dap_detect_mtp`, `dap_get_mtp_info`
- `dap_cancel_sync`
- `dap_start_volume_watcher`

Les ajouter aussi dans `tauri::generate_handler![...]`.

### 4. Restaurer la dépendance MTP dans `Cargo.toml`

```toml
# === DAP Sync (SD Card / USB sync) ===
# MTP (Media Transfer Protocol) — pure Rust, async, for DAP sync via USB
mtp-rs = { git = "https://github.com/vdavid/mtp-rs.git", branch = "main" }
```

Vérifier aussi que `notify` est bien présent (il peut avoir été retiré s'il n'était utilisé que par `watcher.rs`).

### 5. Démarrer le watcher au boot

Dans `lib.rs`, dans le `setup()` de l'app Tauri, restaurer :

```rust
dap_sync::watcher::start_volume_watcher(app.handle().clone());
```

### 6. Restaurer le module frontend

```bash
cd noir-tauri/src
git checkout archive/dap-sync-v1 -- dap-sync.js
```

### 7. Restaurer les intégrations cross-module

**`renderer.js`** — restaurer l'import (vers la ligne 30) et les enregistrements sur `app` (vers lignes 209, 968) :

```js
import {
  initDapSync, openSyncPanel, closeSyncPanel,
  loadDestinations as loadDapDestinations,
  refreshMountedVolumes, displayDapSyncView, hideDapTopBar,
  renderSidebarDestinations, hasDapDestination, getMountedDestinations,
  isAlbumSelectedForDap, isArtistFullySelectedForDap,
  toggleAlbumDapSelection, toggleArtistDapSelection, toggleAlbumsOnDest,
  showDapSyncModal, getDapDestinationName, startSync as startDapSync
} from './dap-sync.js'
```

**`app.js`** — restaurer le slot `// === DAP Sync ===` (vers ligne 111) et ses setters.

**`views.js`** — restaurer la vue `'dap-sync'` dans les switches (vers lignes 340-342, 375, 516) :

```js
case 'dap-sync':
  app.displayDapSyncView()
  break
// + restaurer la vérification ui.currentView !== 'dap-sync' avant hideDapTopBar
```

**`panels.js`** — restaurer les 28 références du context menu "Add/Remove from my DAP" (voir l'archive pour les blocs exacts).

**`playlists.js`** — restaurer la référence DAP unique.

**`index.html`** — restaurer les éléments :

```html
<div class="dap-sync-bar hidden" id="dap-sync-bar"><!-- ... --></div>
<div id="dap-sync-destinations"><!-- ... --></div>
```

(Chercher dans `git show archive/dap-sync-v1:noir-tauri/index.html` les blocs exacts.)

### 8. Restaurer le CSS

```bash
cd noir-tauri/src
git show archive/dap-sync-v1:src/styles.css | grep -A 3 "\.dap-"
```

Restaurer depuis l'archive :
- Bloc `/* DAP Sync Modal */` (~ligne 6647 de l'archive)
- Classes `.dap-modal-*`, `.dap-dest-*`, `.dap-det-*`, `.dap-alb-*`, `.dap-sync-*`, `.dap-complete-*`
- `@keyframes dapSyncRingSpin`, `dapTabIn`
- `.dap-sync-view` (référencée par `views.js`)

### 9. Validation

```bash
cd noir-tauri
# Backend
cd src-tauri && cargo check && cargo clippy && cargo test && cd ..
# Frontend
for f in src/*.js; do node --check "$f" && echo "OK: $f"; done
npm test -- --watchAll=false
# End-to-end
npm run tauri dev
```

Puis dérouler le [TEST_PROTOCOL.md](TEST_PROTOCOL.md) avec un DAP physique.

### 10. État de la base de données utilisateur

**Important** : au moment du retrait, les tables SQLite `dap_destinations` et `dap_sync_selection` ont été **laissées en place** dans la base `~/.local/share/noir/dap_sync.db` des beta-testers. Elles sont donc déjà présentes avec potentiellement des configurations existantes.

Au redémarrage, `dap_get_destinations` retournera ces destinations historiques. Si des schémas ont changé entre l'archivage et la reprise, prévoir une migration.

---

## Fichiers à restaurer — liste exhaustive

| Fichier | Action |
|---|---|
| `noir-tauri/src-tauri/src/dap_sync/mod.rs` | Restaurer depuis archive |
| `noir-tauri/src-tauri/src/dap_sync/db.rs` | Restaurer depuis archive |
| `noir-tauri/src-tauri/src/dap_sync/manifest.rs` | Restaurer depuis archive |
| `noir-tauri/src-tauri/src/dap_sync/mtp.rs` | Restaurer depuis archive |
| `noir-tauri/src-tauri/src/dap_sync/sync_engine.rs` | Restaurer depuis archive |
| `noir-tauri/src-tauri/src/dap_sync/sync_plan.rs` | Restaurer depuis archive |
| `noir-tauri/src-tauri/src/dap_sync/volumes.rs` | Restaurer depuis archive |
| `noir-tauri/src-tauri/src/dap_sync/watcher.rs` | Restaurer depuis archive |
| `noir-tauri/src-tauri/src/dap_sync/smb_utils.rs` | **Ne pas toucher** — déjà déplacé hors de `dap_sync/`, toujours présent |
| `noir-tauri/src-tauri/src/lib.rs` | Restaurer : `mod dap_sync`, 15 commandes, `generate_handler`, init watcher |
| `noir-tauri/src-tauri/Cargo.toml` | Restaurer : `mtp-rs` |
| `noir-tauri/src/dap-sync.js` | Restaurer depuis archive |
| `noir-tauri/src/renderer.js` | Restaurer import + enregistrements app |
| `noir-tauri/src/app.js` | Restaurer slot DAP |
| `noir-tauri/src/views.js` | Restaurer vue `'dap-sync'` |
| `noir-tauri/src/panels.js` | Restaurer context menu DAP |
| `noir-tauri/src/playlists.js` | Restaurer ref DAP |
| `noir-tauri/src/styles.css` | Restaurer bloc `.dap-*` |
| `noir-tauri/index.html` | Restaurer éléments `#dap-sync-bar` + `#dap-sync-destinations` |
| `noir-tauri/CLAUDE.md` | Restaurer les sections DAP (architecture frontend/backend, constraints, décisions) |

---

## Vérification post-réintégration

Checklist minimale avant de considérer la réintégration comme terminée :

- [ ] `cargo check` passe
- [ ] `cargo clippy` passe sans nouveau warning
- [ ] `cargo test` passe (y compris les tests `smb_utils` et `volumes`)
- [ ] `npm test` passe
- [ ] `npm run tauri dev` lance l'app
- [ ] Les 12 tests de [TEST_PROTOCOL.md](TEST_PROTOCOL.md) passent sur un vrai DAP
- [ ] Les 5 issues de [KNOWN_ISSUES.md](KNOWN_ISSUES.md) ont un fix ou une mitigation documentée
- [ ] Le streaming SMB audio fonctionne toujours (non-régression de la feature qui partage `smb_utils`)
- [ ] La documentation `noir-tauri/CLAUDE.md` est à jour (section DAP Sync restaurée + adaptée)
- [ ] Les tables SQLite existantes des utilisateurs sont lues correctement (pas de crash au boot si schéma inchangé)
