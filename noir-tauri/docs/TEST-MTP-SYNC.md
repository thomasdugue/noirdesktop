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
- [ ] OK

## Test 2 — Selection storage + premier affichage
1. Clique sur **Micro SD**
2. La vue albums s'ouvre avec ta bibliotheque
3. Les albums deja synches affichent **"on DAP"**
4. Les albums non synches n'ont pas de badge
- [ ] OK

## Test 3 — Sync incremental (rien a faire)
1. Sans rien changer, clique **Sync**
2. Le terminal affiche `0 to copy, 0 to delete`
3. Le sync finit quasi-instantanement
- [ ] OK

## Test 4 — Ajouter un album
1. Coche un **nouvel album** (pas encore sur le DAP, pas Paco De Lucia)
2. Le badge **"to add"** apparait
3. Clique **Sync**
4. Le terminal affiche `X files to copy`
5. L'album est copie sans erreur
6. Apres sync, le badge passe a **"on DAP"**
- [ ] OK

## Test 5 — Badge "to remove"
1. **Decocher** un album qui a le badge **"on DAP"**
2. Le badge passe a **"to remove"**
- [ ] OK

## Test 6 — Suppression d'un album
1. Avec un album decoche ("to remove"), clique **Sync**
2. Le terminal affiche `X to delete`
3. Les fichiers sont supprimes : `[MTP] Deleted X/X files`
4. Le dossier vide est supprime : `[MTP] Removed empty folder: ...`
5. L'album disparait du DAP (verifier dans l'explorateur de fichiers du FiiO)
- [ ] OK

## Test 7 — Ajout + suppression simultanes
1. Decocher un album ("to remove") + cocher un nouvel album ("to add")
2. Clique **Sync**
3. Le terminal affiche `X to copy, Y to delete`
4. L'ancien album est supprime, le nouveau est copie
- [ ] OK

## Test 8 — Timeout / album problematique
1. Coche **Paco De Lucia** et lance un sync
2. Le terminal affiche `[MTP] TIMEOUT: ... — poisoning folder`
3. Les tracks restantes sont skipees instantanement (pas de cascade de timeouts)
4. Le sync finit en moins de 1 minute (pas 10 min)
5. Les tracks en erreur ne sont PAS dans le manifest (prochain sync les repropose)
- [ ] OK

## Test 9 — Re-sync apres erreur
1. Relance un sync avec Paco De Lucia toujours coche
2. Les tracks en erreur sont reproposees : `X to copy`
3. Les tracks deja OK ne sont pas re-uploadees
- [ ] OK

## Test 10 — Cancel mid-sync
1. Coche un gros album et lance un sync
2. Pendant le transfert, clique **Cancel**
3. Le sync s'arrete, toast "Sync cancelled"
4. Relance un sync → seuls les fichiers restants sont copies
- [ ] OK

## Test 11 — Guard USB exclusif
1. Pendant un sync, essaie de changer d'album (cocher/decocher)
2. Le plan ne doit PAS etre recalcule pendant le sync
3. Pas de `dap_compute_sync_plan` dans le terminal pendant le sync
- [ ] OK

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
