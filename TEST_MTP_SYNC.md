# Protocole de test MTP Sync

## Pre-requis
- FiiO JM21 connecte en USB
- Dossier `Music/` existant sur la carte Micro SD
- NAS accessible (pour les fichiers SMB)
- App lancee sur la branche avec les fixes

```bash
cd ~/Documents/Thomas/noirdesktop && cd noir-tauri && npm run tauri dev
```

---

## Test 1 — Detection device au demarrage
1. Branche le FiiO JM21 **avant** de lancer l'app
2. Lance l'app
3. Le device apparait dans la sidebar MTP
4. Clique sur le chevron → **Internal Storage** et **Micro SD** visibles

- [ ] OK

---

## Test 2 — Hot-plug : branchement apres demarrage
1. Lance l'app **sans** le FiiO branche
2. Verifie qu'aucun device MTP n'apparait
3. Branche le FiiO
4. Attends ~10 secondes (polling)
5. Le device apparait dans la sidebar **sans reload**

- [ ] OK

---

## Test 3 — Hot-plug : debranchement
1. Avec le FiiO branche et visible dans la sidebar
2. Debranche le FiiO
3. Attends ~10 secondes
4. Le device disparait de la sidebar **sans reload**

- [ ] OK

---

## Test 4 — Selection storage + premier affichage
1. Clique sur **Micro SD**
2. La vue albums s'ouvre avec ta bibliotheque
3. Les albums deja synches affichent **"on DAP"**
4. Les albums non synches n'ont pas de badge

- [ ] OK

---

## Test 5 — Sync incremental (rien a faire)
1. Sans rien changer, clique **Sync**
2. Le terminal affiche `0 to copy, 0 to delete`
3. Le sync finit quasi-instantanement

- [ ] OK

---

## Test 6 — Ajouter un album
1. Coche un **nouvel album** (pas encore sur le DAP)
2. Le badge **"to add"** apparait
3. Clique **Sync**
4. Le terminal affiche `X files to copy`
5. L'album est copie sans erreur
6. **Apres sync, le badge passe a "on DAP"** (pas "to add")

- [ ] OK

---

## Test 7 — Badge "to remove" sur album present
1. **Decoche** un album qui a le badge **"on DAP"**
2. Le badge passe a **"to remove"**

- [ ] OK

---

## Test 8 — Suppression d'un album
1. Avec un album decoche ("to remove"), clique **Sync**
2. Le terminal affiche `X to delete`
3. Les fichiers sont supprimes : `[MTP] Deleted X/X files`
4. **Apres sync, l'album n'a plus de badge** (ni "on DAP", ni "to remove")

- [ ] OK

---

## Test 9 — Re-sync apres suppression (idempotent)
1. Apres le test 8, clique **Sync** a nouveau
2. Le terminal affiche `0 to copy, 0 to delete`
3. Rien n'est re-copie ni re-supprime

- [ ] OK

---

## Test 10 — Formatage carte SD (manifest stale)
1. Avec plusieurs albums synches (**"on DAP"**)
2. Formate la carte Micro SD depuis le FiiO (ou un lecteur de carte)
3. Cree un dossier `Music/` vide sur la carte si necessaire
4. Rebranche le FiiO
5. Retourne sur la vue DAP sync
6. **Les albums ne doivent PAS afficher "on DAP"** — ils doivent etre en **"to add"** (si coches) ou sans badge (si decoches)

- [ ] OK

---

## Test 11 — Decocher un album absent du device (post-formatage)
1. Apres le test 10 (carte formatee, albums en "to add")
2. Decoche un album qui etait selectionne
3. **Le badge disparait** (pas de badge, PAS "to remove")
4. L'album n'est pas sur le device, donc rien a supprimer

- [ ] OK

---

## Test 12 — Sync apres formatage
1. Apres le test 10 (carte formatee)
2. Garde quelques albums coches ("to add")
3. Clique **Sync**
4. Les fichiers sont copies normalement
5. Apres sync, les badges passent a **"on DAP"**

- [ ] OK

---

## Resume des bugs corriges

| # | Bug | Comportement attendu |
|---|-----|---------------------|
| 1 | Badge stale apres sync | "to add" → "on DAP" apres sync |
| 2 | Badge "to remove" absent | Decocher "on DAP" → "to remove" |
| 3 | Hot-plug non detecte | Device apparait/disparait sans reload (~10s) |
| 4 | "ON DAP" apres formatage | Carte vide = pas de "on DAP" |
| 5 | "to remove" sur album absent | Decocher un album absent = pas de badge |
