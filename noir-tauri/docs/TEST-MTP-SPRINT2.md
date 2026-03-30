# Protocole de test — Sprint MTP Sync #2

**Branche** : `claude/zen-booth`
**Date** : 2026-03-30
**Device** : FiiO JM21 (MTP USB)

---

## Pré-requis

```bash
cd ~/Documents/Thomas/noirdesktop/.claude/worktrees/zen-booth/noir-tauri && npx @tauri-apps/cli dev
```

- FiiO JM21 connecté en USB
- Bibliothèque NAS accessible (tracks SMB)
- Album Paco De Lucia présent dans la sélection (contient le fichier "05 - Convite.flac" qui timeout systématiquement)

---

## Test A — Per-file timeout (Fix critique)

### A1. Première sync avec track qui timeout

1. Sélectionner l'album Paco De Lucia (+ quelques autres albums)
2. Lancer la sync
3. **Observer dans le terminal** :
   - [ ] Track 5 ("Convite.flac") affiche `[MTP] TIMEOUT: ...`
   - [ ] Message : `"siblings will still be attempted after 5s delay"`
   - [ ] Pause de ~5 secondes visible dans les logs
   - [ ] Track 6 est **tentée** (pas skippée)
   - [ ] Tracks 7, 8, 9 sont aussi tentées
   - [ ] Les autres albums se sync normalement

**PASS** = Tracks 6-9 sont tentées après le timeout de track 5
**FAIL** = Tracks 6-9 skippées (ancien comportement folder-level)

### A2. Retry sync (track 5 skippée, le reste OK)

1. Sans débrancher, relancer la sync
2. **Observer** :
   - [ ] Track 5 affiche `"Skipped (previously timed out)"` — PAS re-tentée
   - [ ] Tracks 6-9 : soit déjà sur le device (skipped), soit copiées si A1 a échoué pour elles
   - [ ] Le compteur `files_copied` affiche un nombre cohérent (pas gonflé)

**PASS** = Track 5 skippée, pas de boucle infinie
**FAIL** = Track 5 re-tentée et timeout à nouveau

### A3. Vérifier le DAP

1. Sur le FiiO JM21, naviguer dans Music/
2. **Vérifier** :
   - [ ] Dossier Paco De Lucia contient les tracks 1-4 et 6-9 (track 5 absente = normal)
   - [ ] Les autres albums sont complets

---

## Test B — Thumbnails SMB (Fix moyenne)

### B1. Vérifier les thumbnails après connexion NAS

1. Se connecter au NAS (cliquer sur la source réseau dans la sidebar)
2. Attendre que le scan se termine
3. Naviguer dans la vue Albums
4. **Observer** :
   - [ ] Les pochettes d'albums NAS s'affichent (pas de carrés noirs)
   - [ ] Dans le terminal : `generate_thumbnails_batch` affiche des `generated > 0`

**PASS** = Pochettes visibles, thumbnails générés
**FAIL** = Carrés noirs, `0 generated, X failed`

### B2. Vérifier dans la vue DAP Sync

1. Ouvrir la vue DAP Sync
2. **Observer** les thumbnails dans la liste d'albums :
   - [ ] Les albums NAS affichent leurs pochettes

---

## Test C — MTP disconnected/reconnected

### C1. Détection déconnexion MTP

1. Sélectionner la destination MTP (FiiO JM21)
2. Vérifier que la vue "albums" s'affiche normalement
3. **Débrancher le câble USB** du FiiO
4. **Observer** (attendre ~10s pour le polling) :
   - [ ] L'écran passe en vue "disconnected"
   - [ ] Icône DAP avec badge X rouge
   - [ ] Message "... disconnected"
   - [ ] Boutons "Change destination" et "Retry" visibles

**PASS** = Vue disconnected affichée automatiquement
**FAIL** = Vue albums reste affichée malgré la déconnexion

### C2. Retry après reconnexion

1. **Rebrancher le câble USB**
2. Attendre 2-3 secondes
3. Cliquer sur **Retry**
4. **Observer** :
   - [ ] Le bouton affiche "Checking…"
   - [ ] Retour à la vue albums avec les données du device
   - [ ] La sidebar montre le device comme connecté

**PASS** = Retour à albums après Retry
**FAIL** = Message "Device not detected" malgré le branchement

### C3. Retry sans reconnexion

1. Depuis l'écran disconnected (device toujours débranché)
2. Cliquer sur **Retry**
3. **Observer** :
   - [ ] Message inline "Device not detected — check your connection"
   - [ ] Shake animation sur l'icône
   - [ ] Le bouton Retry redevient actif

**PASS** = Feedback d'erreur inline clair
**FAIL** = Pas de feedback ou crash

---

## Test D — Régressions (vérifications rapides)

### D1. Sync incrémentale toujours fonctionnelle

1. Après une sync réussie, relancer la sync immédiatement
2. **Vérifier** : `0 files to copy` (pas de re-copie)

### D2. Badges actualisés après sync

1. Ajouter un nouvel album à la sélection
2. Lancer la sync
3. Revenir à la liste albums
4. **Vérifier** : l'album passe de "to add" à "on DAP"

### D3. Transaction ID mismatch recovery

1. Après une sync avec timeout, observer le terminal
2. **Vérifier** :
   - [ ] Un seul `Transaction ID mismatch` au polling suivant
   - [ ] Recovery automatique au polling d'après (pas de crash)

### D4. Polling MTP pas trop verbeux

1. Laisser l'app tourner 1 minute sans rien faire
2. **Vérifier** dans le terminal :
   - [ ] Pas de spam `[MTP] Device found` toutes les 10s
   - [ ] Logs MTP uniquement quand un changement est détecté

---

## Résumé des résultats

| Test | Description | Résultat |
|------|-------------|----------|
| A1 | Timeout per-file (tracks 6-9 tentées) | |
| A2 | Retry skip track 5 uniquement | |
| A3 | Vérification fichiers sur DAP | |
| B1 | Thumbnails SMB après connexion NAS | |
| B2 | Thumbnails dans vue DAP Sync | |
| C1 | Détection déconnexion MTP | |
| C2 | Retry après reconnexion | |
| C3 | Retry sans reconnexion | |
| D1 | Sync incrémentale | |
| D2 | Badges actualisés | |
| D3 | Transaction ID recovery | |
| D4 | Polling pas verbeux | |
