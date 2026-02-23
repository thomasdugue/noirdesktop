# Protocole de test — Noir Desktop MVP

## Prérequis
- `cargo build` réussi (déjà fait)
- Bibliothèque musicale scannée avec au moins un album complet (même sample rate)
- Un fichier audio corrompu ou renommé avec une mauvaise extension (pour tester les erreurs)
- Un DAC USB optionnel (pour tester device switch / exclusive mode)

---

## Feature 2 : Error Handling

### Test 2.1 — Fichier introuvable
1. Scanner un dossier, noter un morceau
2. Déplacer/renommer ce fichier dans le Finder
3. Cliquer sur le morceau dans Noir
4. **Attendu** : Toast "Fichier introuvable" pendant 5s, auto-skip vers le morceau suivant

### Test 2.2 — Fichier corrompu
1. Créer un fichier `fake.flac` contenant du texte aléatoire
2. Le placer dans le dossier scanné, rescanner
3. Lancer la lecture de ce fichier
4. **Attendu** : Toast "Fichier audio illisible ou corrompu" ou "Erreur de décodage", auto-skip

### Test 2.3 — Debounce des erreurs
1. Mettre plusieurs fichiers corrompus à la suite dans un album
2. Lancer la lecture du premier
3. **Attendu** : Un seul toast par code d'erreur toutes les 2s (pas de spam), auto-skip enchaîné

### Test 2.4 — Changement de périphérique
1. Ouvrir Settings → Audio
2. Sélectionner un périphérique qui n'existe pas (si possible) ou débrancher un DAC USB pendant la lecture
3. **Attendu** : Toast d'erreur approprié ("Périphérique audio indisponible" ou "Périphérique audio déconnecté")

### Test 2.5 — Mode exclusif
1. Ouvrir une autre app audio (Music, Spotify, YouTube dans Safari)
2. Lancer la lecture dans Noir avec le mode exclusif activé
3. **Attendu** : Si le hog mode échoue → toast "Mode exclusif échoué — vérifiez qu'aucune autre app n'utilise le DAC"

---

## Feature 3 : Raccourcis clavier

### Test 3.1 — Raccourcis par défaut

| Raccourci | Action attendue |
|-----------|----------------|
| `Espace` | Play / Pause |
| `⌘ →` | Morceau suivant |
| `⌘ ←` | Morceau précédent |
| `⇧ →` | Avance de 10s |
| `⇧ ←` | Recule de 10s |
| `⇧ ↑` | Volume + |
| `⇧ ↓` | Volume - |
| `Esc` | Ferme le panneau ouvert |
| `⌘ ,` | Ouvre les Settings |
| `M` | Mute / Unmute |
| `R` | Cycle mode répétition |
| `S` | Toggle shuffle |
| `L` | Toggle favori |

### Test 3.2 — Affichage dans Settings
1. Ouvrir Settings → section "Raccourcis clavier"
2. **Attendu** : Liste des 13 raccourcis avec keycaps stylisées (fond semi-transparent, monospace)

### Test 3.3 — Remapper un raccourci
1. Cliquer sur le keycap de "Lecture / Pause"
2. **Attendu** : Le keycap passe en mode capture (bordure orange, animation pulse, texte "...")
3. Appuyer sur une nouvelle touche (ex: `P`)
4. **Attendu** : Le keycap affiche la nouvelle touche
5. Fermer Settings, tester le nouveau raccourci
6. **Attendu** : `P` déclenche Play/Pause, `Espace` ne fait plus rien pour cette action

### Test 3.4 — Persistance
1. Remapper un raccourci
2. Quitter et relancer Noir
3. **Attendu** : Le raccourci remappé est conservé

### Test 3.5 — Réinitialisation
1. Cliquer "Réinitialiser les raccourcis"
2. **Attendu** : Tous les raccourcis reviennent aux valeurs par défaut

### Test 3.6 — Conflit avec les champs texte
1. Cliquer dans la barre de recherche
2. Taper `M`, `R`, `S`, `L`, `Espace`
3. **Attendu** : Les lettres s'écrivent dans le champ, aucun raccourci ne se déclenche

---

## Feature 4 : Auto-Update

### Test 4.1 — Section Settings
1. Ouvrir Settings → section "Mises à jour"
2. **Attendu** : Toggle "Vérification automatique" (activé par défaut), bouton "Vérifier", affichage version

### Test 4.2 — Vérification manuelle
1. Cliquer "Vérifier"
2. **Attendu** : Toast d'erreur gracieux (car endpoint/pubkey sont des placeholders). Pas de crash.

### Test 4.3 — Affichage version
1. Regarder le label de version dans Settings
2. **Attendu** : Affiche "Noir v0.1.0" (ou la version de `tauri.conf.json`)

### Test 4.4 — Toggle auto-check
1. Désactiver le toggle "Vérification automatique"
2. Relancer l'app
3. **Attendu** : Pas de vérification silencieuse au démarrage (vérifier dans la console : pas de log updater au startup)

---

## Feature 1 : Gapless Playback

### Test 1.1 — Transition seamless (même sample rate)
1. Activer "Lecture sans coupure" dans Settings → Lecture (devrait être ON par défaut)
2. Sélectionner un album entier (même sample rate, ex: album en 44.1kHz)
3. Lancer la lecture du premier morceau
4. Attendre la fin du morceau (ou avancer à ~10s de la fin)
5. **Attendu** :
   - Console : `[Gapless] Preloading: /chemin/vers/track2.flac` quand il reste <10s
   - Transition sans aucun silence entre les 2 morceaux
   - Console : `GAPLESS TRANSITION` au moment du switch
   - L'UI se met à jour (titre, artiste, cover, durée) sans interruption audio

### Test 1.2 — Skip pendant preload
1. Lancer un album, attendre que le preload se déclenche (<10s restantes)
2. Appuyer sur "Next" (⌘ →) avant la fin naturelle
3. **Attendu** : Le skip fonctionne normalement, pas de double lecture, pas de crash

### Test 1.3 — Désactiver gapless
1. Aller dans Settings → Lecture → désactiver "Lecture sans coupure"
2. Jouer un album jusqu'à la transition
3. **Attendu** : Comportement classique avec micro-gap entre les morceaux (comme avant)

### Test 1.4 — Repeat One
1. Activer Repeat One (cliquer `R` jusqu'au mode repeat one)
2. Jouer un morceau, attendre la fin
3. **Attendu** : Le même morceau recommence (preload du même fichier)

### Test 1.5 — Repeat All
1. Activer Repeat All, jouer le dernier morceau de l'album
2. **Attendu** : Transition gapless vers le premier morceau de l'album

### Test 1.6 — Queue
1. Ajouter un morceau à la queue (clic droit → "Ajouter à la file d'attente")
2. Jouer un morceau, attendre <10s de la fin
3. **Attendu** : Le morceau de la queue est preloaded et enchaîné sans gap

### Test 1.7 — Shuffle
1. Activer le shuffle
2. Jouer un morceau, observer la transition
3. **Attendu** : Le prochain morceau aléatoire est preloaded et enchaîné

---

## Vérification globale

### Stabilité
- [ ] L'app ne crash pas après 30 minutes de lecture continue
- [ ] Pas de fuite mémoire visible (Activity Monitor : RSS ne croît pas indéfiniment)
- [ ] Les transitions gapless n'accumulent pas de mémoire (~15MB max en plus)

### Console
- [ ] Pas d'erreurs JS inattendues dans la console WebView
- [ ] Les logs `[ERROR:...]` Rust correspondent aux toasts affichés

### Régression
- [ ] L'EQ fonctionne toujours (activer, modifier les bandes, vérifier l'effet)
- [ ] Le mode exclusif (hog mode) fonctionne toujours
- [ ] La recherche fonctionne
- [ ] Les favoris fonctionnent
- [ ] Les playlists fonctionnent
- [ ] Le scan de dossier fonctionne
- [ ] Le seek (clic sur la barre de progression) fonctionne
- [ ] Le volume fonctionne (slider + raccourci)
