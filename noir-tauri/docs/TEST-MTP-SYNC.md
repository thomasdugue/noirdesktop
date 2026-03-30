# Protocole de test MTP Sync

## Pre-requis
- FiiO JM21 connecte en USB
- Dossier `Music/` existant sur la carte SD
- NAS accessible (pour les fichiers SMB)
- App lancee sur la branche `claude/dap-sync-investigation-fiAUf`

---

## Test 1 — Detection device
1. Branche le FiiO JM21
2. L'app detecte le device dans la sidebar
3. Clique sur le chevron → tu vois **Internal Storage** et **Micro SD**
- [X] OK

## Test 2 — Selection storage + premier affichage
1. Clique sur **Micro SD**
2. La vue albums s'ouvre avec ta bibliotheque
3. Les albums deja synches affichent **"on DAP"**
4. Les albums non synches n'ont pas de badge
- [X] OK

## Test 3 — Sync incremental (rien a faire)
1. Sans rien changer, clique **Sync**
2. Le terminal affiche `0 to copy, 0 to delete`
3. Le sync finit quasi-instantanement
- [X] OK
Observation : un toaster s'affiche avec "Nothing to sync" 

## Test 4 — Ajouter un album
1. Coche un **nouvel album** (pas encore sur le DAP, pas Paco De Lucia)
2. Le badge **"to add"** apparait
3. Clique **Sync**
4. Le terminal affiche `X files to copy`
5. L'album est copie sans erreur
6. Apres sync, le badge passe a **"on DAP"**
- [X] OK

## Test 5 — Badge "to remove"
1. **Decocher** un album qui a le badge **"on DAP"**
2. Le badge passe a **"to remove"**
- [X] OK

## Test 6 — Suppression d'un album
1. Avec un album decoche ("to remove"), clique **Sync**
2. Le terminal affiche `X to delete`
3. Les fichiers sont supprimes : `[MTP] Deleted X/X files`
4. Le dossier vide est supprime : `[MTP] Removed empty folder: ...`
5. L'album disparait du DAP (verifier dans l'explorateur de fichiers du FiiO)
- [X] OK

## Test 7 — Ajout + suppression simultanes
1. Decocher un album ("to remove") + cocher un nouvel album ("to add")
2. Clique **Sync**
3. Le terminal affiche `X to copy, Y to delete`
4. L'ancien album est supprime, le nouveau est copie
- [!] OK
Observation lorsque je crée une synchronisation avec des albums à ajouter et un album à supprimer, le processus se passe. En revanche dans le terminal, je constate des erreurs et à la fin de la synchronisation l'application fait apparaître des erreurs également sur le fichier à s'y primer uniquement. En revanche quand je vais dans l'appli d'app, je vois que l'album qui devait être supprimé a effectivement été supprimé. Donc je ne sais pas si ces erreurs auront lieu d'être puisque finalement ça a fonctionné. Quand je retourne sur la page avec l'ensemble des albums à synchroniser, je retourne sur l'album que je voulais supprimer et le badge "to remove" n'apparaît pas. Quand je coche l'album, le badge "to remove" apparaît donc le comportement est ok. Néanmoins j'ai eu une erreur, donc l'utilisateur peut être inquiété par cette erreur qui finalement n'a pas lieu d'être. 
Voici les différentes commandes du terminal 
[MTP] The Weeknd - After Hours/Disc 1/14 - Until I Bleed Out.flac — delete failed: Protocol error: InvalidObjectHandle during DeleteObject
[MTP] Deleted 14/28 files, 14 errors
[MTP] Removed empty folder: Disc 1
[MTP] Removed empty folder: The Weeknd - After Hours
[MTP] Cleaned up 2 empty folders
[MTP] Device connection released
[MTP-SYNC] Delete phase: 14/28 deleted, 14 errors
[MTP] Scanning existing files on device...
[MTP] Found 14 existing files on device
[MTP] Starting batch sync: 16 files to copy into Music/ on storage 1
[MTP] Created folder: Music/dvsn - A Muse In Her Feelings
[MTP] Progress: 10/16 files (0.2 GB)
[MTP] Batch sync complete: 16/16 files copied, 0 already on device, (0.3 GB), 0 errors
[MTP-SYNC] Manifest written: 101 files tracked at /Users/tsunami25/Library/Application Support/noir/mtp_manifest_C0775F15349A0FC555E7C88221D90CF2_1.json
[MTP-SYNC] === SYNC FINISHED WITH ERRORS === 16 copied, 14 deleted, 0.3 GB in 42.6s, 14 errors



## Test 8 — Timeout / album problematique
1. Coche **Paco De Lucia** et lance un sync
2. Le terminal affiche `[MTP] TIMEOUT: ... — poisoning folder`
3. Les tracks restantes sont skipees instantanement (pas de cascade de timeouts)
4. Le sync finit en moins de 1 minute (pas 10 min)
5. Les tracks en erreur ne sont PAS dans le manifest (prochain sync les repropose)
- [!] OK
Observation: toujours une erreur sur Paco De Lucia sur la traque numéro 5. 
L'erreur est MTP Upload Time Out 
Voici ce qui apparaît dans le terminal 
[MTP] Device scan for plan: 30 files found on device
[PERF-RS] MTP device scan: 416.941542ms (30 files)
[PERF-RS] get_volume_info: 8.667µs
[PERF-RS] manifest_lookup build: 87.875µs (92 entries)
[PERF-RS] DAP filesystem scan: 90.042µs (30 files, 2 folders with files)
[DEBUG-RS] Sample DAP folders with files: ["Twisted Teens - Blame The Clown", "dvsn - A Muse In Her Feelings"]
[DAP-SYNC] Manifest validation: 64 files in manifest but missing on device → will be re-queued for copy
[DEBUG-RS] Track NOT on DAP: dest_rel="Paco De Lucia - Entre Dos Aguas/01 - Entre Dos Aguas.flac", artist=Some("Paco De Lucia"), album=Some("Entre Dos Aguas")
[DEBUG-RS] Track NOT on DAP: dest_rel="Paco De Lucia - Entre Dos Aguas/02 - Zorongo Gitano.flac", artist=Some("Paco De Lucia"), album=Some("Entre Dos Aguas")
[DEBUG-RS] Track NOT on DAP: dest_rel="Paco De Lucia - Entre Dos Aguas/03 - Rio Ancho.flac", artist=Some("Paco De Lucia"), album=Some("Entre Dos Aguas")
[DEBUG-RS] Track NOT on DAP: dest_rel="Paco De Lucia - Entre Dos Aguas/04 - En La Caleta.flac", artist=Some("Paco De Lucia"), album=Some("Entre Dos Aguas")
[DEBUG-RS] Track NOT on DAP: dest_rel="Paco De Lucia - Entre Dos Aguas/05 - Convite.flac", artist=Some("Paco De Lucia"), album=Some("Entre Dos Aguas")
[PERF-RS] track loop: 3.008625ms (42 tracks, 28 unchanged (0 via disk), 14 to copy, 0 manifest-stale)
[PERF-RS] Cover resolution: 3 albums, 3 to copy, 0 not found
[PERF-RS] compute_sync_plan TOTAL: 9.787875ms | 14 to copy, 3 covers, 0 to delete, 28 unchanged
[PERF-RS] dap_compute_sync_plan TOTAL: 428.663625ms
[MTP-SYNC] Starting MTP sync: 14 files to copy, 0 to delete on storage 1
[MTP] Scanning for MTP devices...
[MTP] Device found: QUALCOMM FiiO JM21 (serial: C0775F15349A0FC555E7C88221D90CF2)
[MTP]   Storage: Espace de stockage interne partagé (16.3 GB free / 21.2 GB total)
[MTP]   Storage: JM21 Micro SD (1999.3 GB free / 1999.9 GB total)
[MTP] Device connection released
[MTP] Scanning existing files on device...
[MTP] Found 30 existing files on device
[MTP] Starting batch sync: 14 files to copy into Music/ on storage 1
[MTP] Created folder: Music/Paco De Lucia - Entre Dos Aguas
[MTP] TIMEOUT: Paco De Lucia - Entre Dos Aguas/05 - Convite.flac — poisoning folder 'Paco De Lucia - Entre Dos Aguas' (remaining files will be skipped)
[MTP] Batch sync complete: 4/14 files copied, 0 already on device, (0.1 GB), 10 errors
[MTP-SYNC] Manifest written: 105 files tracked at /Users/tsunami25/Library/Application Support/noir/mtp_manifest_C0775F15349A0FC555E7C88221D90CF2_1.json
[MTP-SYNC] === SYNC FINISHED WITH ERRORS === 4 copied, 0 deleted, 0.1 GB in 48.2s, 10 errors
[MTP] Scanning for MTP devices...
[MTP] No MTP device found: Invalid data: Transaction ID mismatch: expected 1, got 73
[MTP] Scanning for MTP devices...
[MTP] Device found: QUALCOMM FiiO JM21 (serial: C0775F15349A0FC555E7C88221D90CF2)
[MTP]   Storage: Espace de stockage interne partagé (16.3 GB free / 21.2 GB total)
[MTP]   Storage: JM21 Micro SD (1999.2 GB free / 1999.9 GB total)
[MTP] Device connection released
[MTP] Scanning for MTP devices...
[MTP] Device found: QUALCOMM FiiO JM21 (serial: C0775F15349A0FC555E7C88221D90CF2)
[MTP]   Storage: Espace de stockage interne partagé (16.3 GB free / 21.2 GB total)
[MTP]   Storage: JM21 Micro SD (1999.2 GB free / 1999.9 GB total)
[MTP] Device connection released
[MTP] Scanning for MTP devices...
[MTP] Device found: QUALCOMM FiiO JM21 (serial: C0775F15349A0FC555E7C88221D90CF2)
[MTP]   Storage: Espace de stockage interne partagé (16.3 GB free / 21.2 GB total)
[MTP]   Storage: JM21 Micro SD (1999.2 GB free / 1999.9 GB total)
[MTP] Device connection released
[MTP] Scanning for MTP devices...
[MTP] Device found: QUALCOMM FiiO JM21 (serial: C0775F15349A0FC555E7C88221D90CF2)
[MTP]   Storage: Espace de stockage interne partagé (16.3 GB free / 21.2 GB total)
[MTP]   Storage: JM21 Micro SD (1999.2 GB free / 1999.9 GB total)
[MTP] Device connection released
[MTP] Scanning for MTP devices...
[MTP] Device found: QUALCOMM FiiO JM21 (serial: C0775F15349A0FC555E7C88221D90CF2)
[MTP]   Storage: Espace de stockage interne partagé (16.3 GB free / 21.2 GB total)
[MTP]   Storage: JM21 Micro SD (1999.2 GB free / 1999.9 GB total)
[MTP] Device connection released
## Test 9 — Re-sync apres erreur
1. Relance un sync avec Paco De Lucia toujours coche
2. Les tracks en erreur sont reproposees : `X to copy`
3. Les tracks deja OK ne sont pas re-uploadees
- [!] OK
Observation les tracks déjà présentes ne sont pas resynchronisés, ce qui est très bien
Mais j'ai toujours une erreur sur la tracte 5 
Et quand je retry une troisième fois, j'ai ce message qui apparaît dans l'application : MTP device not found: Invalid data: Transaction ID mismatch: expected 1, got 62

## Test 10 — Cancel mid-sync
1. Coche un gros album et lance un sync
2. Pendant le transfert, clique **Cancel**
3. Le sync s'arrete, toast "Sync cancelled"
4. Relance un sync → seuls les fichiers restants sont copies
- [X] OK
J'ai l'impression que c'est 

## Test 11 — Guard USB exclusif
1. Pendant un sync, essaie de changer d'album (cocher/decocher)
2. Le plan ne doit PAS etre recalcule pendant le sync
3. Pas de `dap_compute_sync_plan` dans le terminal pendant le sync
- [!] OK
Observation: le test ne peut pas être réalisé dans la mesure où, lorsqu'une synchronisation est en cours, l'accès au management de la synchronisation (à savoir ajouter des albums ou en supprimer) n'est pas accessible et c'est le comportement souhaité 

---

## Resultats

| Test | Resultat | Notes |
|------|----------|-------|
| 1 — Detection | | |
| 2 — Affichage | | |
| 3 — Incremental | | |
| 4 — Ajout | | |
| 5 — Badge to remove | | |
| 6 — Suppression | | |
| 7 — Ajout + suppression | | |
| 8 — Timeout | | |
| 9 — Re-sync erreur | | |
| 10 — Cancel | | |
| 11 — Guard USB | | |
