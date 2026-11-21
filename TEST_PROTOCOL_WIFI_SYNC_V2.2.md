# Protocole de test — WiFi Sync v2.2

## Lancement de l'app

```bash
cd /Users/tsunami25/Documents/Thomas/noirdesktop/.claude/worktrees/nice-solomon/noir-tauri && npm run tauri dev
```

## Prérequis
- DAP allumé, connecté au même WiFi que le Mac
- Au moins 2-3 albums dans la bibliothèque HEAN
- Un navigateur Chromium-based sur le DAP (pour la File System Access API)

---

## Bug #1 — Connexion IP-based + token persistant

### T1.1 — IP affichée dans Settings
- Ouvrir Settings → activer "WiFi Sync"
- ✅ L'adresse affichée est `https://192.168.x.y:8443/` (PAS `hean.local`)
- ✅ QR code visible à 240px
- ✅ Boutons présents : "Copy address", "Manage album selection", "Reset sync state", "Rotate access token"

### T1.2 — Connexion DAP
- Sur le DAP : taper l'IP affichée dans le navigateur
- ✅ La WebUI charge sans erreur de cert (accepter le cert self-signed)
- ✅ La page affiche les albums

### T1.3 — Token persistant (le cas qui était cassé)
```bash
cat ~/Library/Application\ Support/com.noir.app/wifi_sync_token.txt
```
- Noter le token actuel
- Quitter HEAN complètement (Cmd+Q)
- Relancer HEAN → activer WiFi Sync
- ✅ Le token doit être **identique** (vérifier avec `cat`)
- Sur le DAP : refresh la WebUI **sans rescanner le QR**
- ✅ La page charge normalement (pas de 401)

### T1.4 — Rotate token
- Sur le Mac, cliquer "Rotate access token" → confirmer
- ✅ Toast "Access token rotated"
- ✅ Le token sur disque a changé (`cat` again)
- ✅ Le QR affiché dans Settings a changé
- Sur le DAP (vieux onglet) : refresh
- ✅ Bannière de restart apparaît (PAS "Failed to fetch")
- Rescanner le nouveau QR → ✅ tout remarche

### T1.5 — PWA install (optionnel, dépend du DAP)
- Sur le DAP : menu navigateur → "Add to Home Screen"
- ✅ Une icône HEAN apparaît, l'ouvrir lance la WebUI

---

## Bug #2 — Page WebUI plus vide

### T2.1 — Premier chargement (état locked)
- Sur le DAP : ouvrir la WebUI **avant** d'avoir choisi un dossier de destination
- ✅ Carte d'onboarding affiche "Pick a folder…" + le **nombre d'albums** (preuve de connexion)
- ✅ Liste des albums **visible mais grisée** (classe `.locked`)
- ✅ Plus besoin de cliquer sur Settings d'abord

### T2.2 — Après pick folder
- Cliquer "Pick a folder" → sélectionner un dossier
- ✅ La liste des albums se dégrise
- ✅ On peut cocher des albums et lancer un sync

### T2.3 — Persistance IndexedDB
- Refresh la page après avoir pické un dossier
- ✅ Le dossier reste sélectionné (handle restauré depuis IndexedDB)
- ✅ État unlocked direct

---

## Bug #3 — "Failed to fetch" sur Reload Library

### T3.1 — Reload normal
- Sur le Mac, sélectionner 2 albums dans la vue DAP Sync
- Sur le DAP : cliquer "Reload library"
- ✅ Les albums sélectionnés apparaissent (pas de "Failed to fetch")

### T3.2 — Détection token stale
- Sur le Mac, cliquer "Rotate access token"
- Sur le DAP (vieux onglet) : cliquer "Reload library"
- ✅ Bannière de restart apparaît avec un bouton refresh (PAS "Failed to fetch")
- Cliquer le bouton refresh → rescanner le nouveau QR
- ✅ Reload library remarche

### T3.3 — Serveur stoppé
- Sur le Mac : désactiver WiFi Sync
- Sur le DAP : cliquer "Reload library"
- ✅ Bannière "unreachable" / restart (pas un crash silencieux)

---

## Tests de non-régression

### T4.1 — Sync end-to-end
- Sélectionner 1 album sur le Mac
- Sur le DAP : cocher → "Sync selected"
- ✅ Le téléchargement progresse, throughput affiché en temps réel sur le Mac
- ✅ Les fichiers atterrissent dans `Downloads/HEAN/Artist/Album/`
- ✅ Une fois fini, l'album passe en "synced" dans la WebUI

### T4.2 — Target folder name
- Dans Settings, changer "Target folder name" de `HEAN` à `MUSIC`
- Sync un album
- ✅ Les fichiers vont dans `Downloads/MUSIC/Artist/Album/`

### T4.3 — Throughput indicator
- Pendant un gros sync, regarder l'indicateur Mac Settings
- ✅ S'affiche en vert avec MB/s, disparaît quand fini

---

## Critères de succès
- 3 bugs reproduits avant patch ❌ → tous fixés ✅
- Aucune régression sur le flow de sync existant
- Token survit aux redémarrages
- WebUI utilisable dès le premier chargement
