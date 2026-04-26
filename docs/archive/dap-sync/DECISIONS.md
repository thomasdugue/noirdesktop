# DAP Sync — Décisions techniques

Ce fichier consolide les décisions architecturales prises pendant le développement de la feature, avec leur justification. **Pour toute réintégration, lire ce fichier en premier** — chaque décision listée ici évite un piège qu'on a déjà payé.

---

## Performance

### 1. **Pas de `fs::metadata()` dans `compute_sync_plan`**

**Problème** : résoudre un chemin SMB + appeler `fs::metadata()` coûte ~12 ms/fichier sur NAS. Avec 800 fichiers à synchroniser : **10,5 secondes** bloquantes à chaque recalcul du plan.

**Décision** : `compute_sync_plan` utilise `track.size_bytes` envoyé par le frontend (estimé JS depuis les métadonnées extraites au scan). La taille réelle est obtenue pendant la copie effective dans `sync_engine.rs`, pas dans le plan.

**Gain** : 10,7 s → **32 ms** (330× plus rapide) sur une bibliothèque de 805 fichiers.

**⚠️ Ne JAMAIS réintroduire `fs::metadata` dans `compute_sync_plan`.**

Référence : commit du sprint 2026-03-14 dans `noir-tauri/CLAUDE.md`.

---

### 2. **Clé de déduplication : `dest_relative_path`, pas `source_path`**

**Problème** : les paths SMB changent entre sessions (UUID NetworkSource peut différer). Comparer les syncs par `source_path` provoque des re-copies infinies.

**Décision** : la clé est `dest_relative_path` (construit depuis artist/album/track), stable d'une session à l'autre.

---

### 3. **Sets pré-calculés pour les lookups de badges**

**Problème** : `filesToCopy.some(f => f.albumId === id)` appelé pour chaque row = O(n) par album = **O(n²)** total. Avec ~160 albums × ~800 fichiers : gel UI visible.

**Décision** : après chaque sync plan, construire `_copyAlbumIds: Set<number>` et `_deleteSourcePaths: Set<string>`. Lookup O(1).

---

### 4. **Debounce obligatoire**

- `saveSelections()` : **800 ms** debounce
- `computeAndRenderSummary()` : **500 ms** debounce

**Problème sans debounce** : chaque clic checkbox → IPC batch complet + recalcul plan Rust → gel UI.

---

### 5. **DocumentFragment pour les listes**

**Problème** : créer les rows une par une dans le DOM = 1 reflow par row = gel visible.

**Décision** : `renderAlbumRows()` construit toutes les rows dans un `DocumentFragment`, un seul `appendChild` final → single reflow.

---

### 6. **Thumbnails batchés**

**Décision** : `loadThumbsBatched()` charge 8 thumbnails par `requestAnimationFrame`. Évite de flood l'IPC.

---

### 7. **Batch adaptatif pour la copie audio**

**Décision** : double seuil aligné sur les albums musicaux : **512 MB OU 40 fichiers** (256 MB / 20 en mode dégradé). Sécurité : flush mid-album à 2 GB (hi-res 24/192 × 20 tracks). À chaque frontière :
- Checkpoint manifest partiel (reprise après crash)
- Spot-check F_NOCACHE du dernier fichier (détection corruption exFAT early)
- Mode dégradé auto si spot-check échoue

---

### 8. **Progress bar basée sur le nombre de tracks, pas les bytes**

**Décision** : `current / total` (fichiers), pas `bytesCopied / totalBytes`. Plus intuitif : 4/8 = 50 % quand 4 tracks sur 8 sont copiées.

---

### 9. **`updateStatusTagsInPlace` au lieu de full re-render**

Mise à jour ciblée des badges "on DAP" / "to add" / "to remove" en modifiant `.innerHTML` des éléments existants.

---

## Protection anti-corruption exFAT

Les cartes SD et clés USB utilisent souvent exFAT. Contrairement à ext4 ou APFS, **un dossier vide créé par erreur devient une entrée fantôme non-supprimable** qui bloque toutes les syncs futures.

### 10. **Source ouverte AVANT `create_dir_all`**

**Décision** : `copy_file_verified_cancellable` ouvre `File::open(source)` **avant** `create_dir_all(dest_parent)`. Si la source n'existe pas → aucun dossier créé.

**⚠️ Ne JAMAIS réintroduire `create_dir_all` avant la vérification de la source.**

### 11. **`cleanup_empty_parent_dirs` après chaque erreur**

Chaque erreur de copie (`File::create`, `write`, `fsync`, `rename`) déclenche une remontée de l'arbre qui supprime les dossiers sans contenu réel.

### 12. **`cleanup_empty_dirs` global en fin de sync**

Parcourt tout l'arbre en fin de **toute** sync (pas seulement cancel). Supprime les dossiers sans fichier audio (covers orphelines incluses).

### 13. **Covers copiées inline, jamais en phase séparée**

**Problème** : l'ancienne approche (toutes les covers en bloc après tous les audio) causait de la corruption exFAT (pattern d'écriture séquentielle trop dense).

**Décision** : chaque cover est copiée immédiatement **après le dernier audio de son album**, dans le même flow que l'audio.

**⚠️ Ne JAMAIS réintroduire une Phase 2b pour les covers.**

### 14. **Covers protégées du mirror mode**

`compute_sync_plan` exclut `cover.jpg/jpeg/png` de `files_to_delete` car elles ne sont pas dans `selected_dest_paths`. Sinon : re-supprimées à chaque sync.

**⚠️ Ne JAMAIS supprimer cette exclusion.**

### 15. **Spotlight désactivé sur le device**

`mdutil -i off <device_path>` au début de chaque sync. Spotlight indexant un device pendant la copie = corruption exFAT documentée.

### 16. **Pas d'Apple Double files**

`COPYFILE_DISABLE=1` dans l'environnement de la copie. Supprime la génération de fichiers `._*` (resource forks) qui polluent le DAP.

### 17. **`quick_integrity_hash` pour détecter la corruption**

SHA-256 sur les premiers 64 KB + derniers 64 KB de chaque fichier. Stocké dans le manifest. Re-sync auto si le hash ne correspond plus.

### 18. **Sanitization stricte des noms de fichiers**

`sanitize_filename()` supprime `$`, parenthèses, caractères de contrôle Unicode, etc. `migrate_dap_filesystem()` renomme in-place sur le device quand les règles changent.

---

## MTP (Media Transfer Protocol)

### 19. **`MTP_LOCK` global**

**Problème** : l'accès USB MTP est exclusif. Deux commandes concurrentes → corruption du Transaction ID.

**Décision** : `MTP_LOCK: Lazy<TokioMutex<()>>` global. Tenu pour toute la durée d'une sync MTP.

### 20. **Pas de `tokio::time::timeout` autour de `storage.upload()`**

**Problème** : `mtp-rs` a un timeout interne de 30 s. En wrapper par un `tokio::time::timeout` externe, l'annulation casse le Transaction ID et le device passe en état incohérent (impossible à recover sans unplug).

**⚠️ Ne JAMAIS wrapper `storage.upload()` avec `tokio::time::timeout`.**

### 21. **Suppresseur `ptpcamerad`**

**Problème** : macOS lance `ptpcamerad` dès qu'il voit un device MTP, ce qui capture l'accès USB exclusif et empêche Hean de communiquer.

**Décision** : thread qui `kill -9 ptpcamerad` toutes les **200 ms** pendant toute la durée d'une sync MTP (macOS le respawn en ~100 ms, donc un polling plus lent le laisserait reprendre). `SuppressorGuard` RAII arrête le thread sur toutes les exit paths.

### 22. **`CloseSession` PTP avant drop**

**Décision** : `close_mtp_device()` envoie explicitement `PTP CloseSession` avant de drop l'instance. Sans ça, la firmware ne flush pas toujours son write cache et les derniers fichiers peuvent être corrompus.

### 23. **Manifest MTP stocké en local**

Les devices MTP ne supportent pas toujours les fichiers cachés à leur racine. Le manifest est dans `~/Library/Application Support/noir/mtp_manifest_{SERIAL}_{STORAGE_ID}.json`.

### 24. **Flush préventif toutes les 40 fichiers (MTP)**

**Problème** : gros syncs MTP → write cache firmware saturé → timeout.

**Décision** : pause de X secondes toutes les 40 fichiers pour laisser la firmware flush.

### 25. **Polling MTP stoppé pendant `compute_sync_plan` + sync**

**Problème** : polling périodique du device MTP pendant un plan/sync → contention USB → timeouts.

**Décision** : flag atomique stoppant le polling pendant ces opérations.

---

## SMB (source sur NAS)

### 26. **`smb_utils` partagé avec le streaming audio**

**Important** : `smb_utils::resolve_smb_path` et `build_smb_mount_map` sont utilisés **aussi** par `audio_play` et `audio_preload_next` (streaming SMB avec fallback mount local). **Le module doit survivre au retrait de DAP Sync** — il a été déplacé hors de `dap_sync/` pour être réutilisable.

### 27. **Fallback par `volumeName`**

**Problème** : macOS remonte parfois un volume sous un path légèrement différent (`/Volumes/NAME 1` au lieu de `/Volumes/NAME`).

**Décision** : retry par `volumeName` quand le path exact ne matche pas, mise à jour automatique du path en base.

### 28. **Cancel check avant opérations SMB bloquantes**

Le thread Rust peut être bloqué sur un `read()` SMB indéfiniment. Le JS a donc un **timeout de 3 s** qui ramène l'utilisateur à la vue albums immédiatement, sans attendre la confirmation Rust.

---

## UX / Cycle de vie

### 29. **Auto-détection des volumes**

`refreshMountedVolumes()` auto-crée des destinations pour volumes amovibles non encore configurés. UNIQUE constraint sur `path` empêche les doublons.

### 30. **Prévention du sleep macOS pendant une sync**

`SleepGuard` RAII lance `caffeinate -s -i`. Automatiquement killed en fin de sync.

### 31. **Top bar scopée à la vue DAP**

`#dap-sync-bar` remplace la search bar **uniquement** sur la vue `dap-sync`. `hideDapTopBar()` obligatoire dans `displayCurrentView()` quand on quitte la vue.

### 32. **Sidebar device désélectionnée en quittant la vue**

`renderSidebarDestinations()` appelé aussi quand `ui.currentView !== 'dap-sync'`.

---

## Stratégie générale

### 33. **Pas de `fs::metadata` = trust du frontend**

La confiance au frontend pour la taille des fichiers évite 10 s de blocage mais impose que le JS calcule la taille correctement à partir des métadonnées audio. Le mismatch éventuel est rattrapé à la copie réelle.

### 34. **Three-level protection (ghost dirs)**

Les 3 niveaux (prévention + cleanup immédiat + cleanup global) sont **complémentaires**, pas redondants. Supprimer un niveau ré-introduit la vulnérabilité.

### 35. **Badge state machine unique source de vérité = plan + manifest**

Les badges "on DAP" / "to add" / "to remove" sont dérivés de `(selectedAlbums, syncPlan)`. Pas d'état local séparé. Toute mise à jour passe par `computeAndRenderSummary → precomputeSyncPlanLookups → updateStatusTagsInPlace`.

### 36. **`albumId` = hash JS stable**

`albumKeyToId(albumKey)` génère un ID numérique stable à partir de la clé string de l'album. Passé dans `TrackForSync.album_id` côté Rust et revient dans `SyncAction.album_id` pour le mapping bidirectionnel.
