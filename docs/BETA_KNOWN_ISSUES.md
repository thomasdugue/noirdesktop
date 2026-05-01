# Hean — Bugs & limitations connus (beta v0.2.0-beta.1)

Mis à jour : **2026-04-26**

Si tu rencontres un bug qui n'est pas listé ici, **reporte-le** via le bouton Feedback de l'app.

---

## Bugs connus

### Drag & drop (homepage — annulation Escape)
**Symptôme :** annuler un drag avec `Esc` sur la homepage peut laisser le ghost (preview) visible à l'écran.
**Quand :** drag commencé mais pas encore "validé" (`customDragState.isDragging` pas encore à `true`).
**Workaround :** clique ailleurs ou relance le drag — le ghost se nettoie.
**Impact :** cosmétique uniquement. Pas de perte de données.

### Sidebar playlist thumbnails — premier démarrage
**Symptôme :** au tout premier lancement (cache vide), les vignettes des playlists dans la sidebar ont une légère latence (1-2s) avant d'apparaître.
**Cause :** le cache de thumbnails n'a pas encore été généré, l'app extrait les pochettes depuis les fichiers audio à la volée.
**Workaround :** aucun — c'est un coût one-shot. Au lancement suivant, les thumbnails sont instantanés.
**Impact :** UX, première impression seulement.

### Gapless transition en vue Tracks (jamais affichée)
**Symptôme :** si tu lances une lecture séquentielle depuis la vue Tracks **sans jamais avoir affiché cette vue auparavant** dans la session, la transition gapless peut laisser le `currentTrackIndex` inchangé.
**Workaround :** clique sur "Tracks" dans la sidebar avant de lancer la lecture.
**Impact :** très marginal — il faut un scénario spécifique pour le déclencher.

---

## Limitations connues (par design pour cette beta)

### Plateforme
- **macOS uniquement.** Pas de build Windows ni Linux. Le backend audio (CoreAudio + Hog Mode) est macOS-natif.
- **macOS 11 (Big Sur) minimum.** Versions plus anciennes refusées au lancement.

### Formats audio
- ✅ Supportés : FLAC, ALAC, WAV, AIFF, MP3, AAC/M4A, OGG Vorbis
- ❌ Non supportés : DSD, MQA, Opus, WMA

### Features non incluses
- Pas de **DAP Sync** (synchro vers un Digital Audio Player) — feature archivée pour la beta. [Voir l'archive](archive/dap-sync/) pour le pourquoi.
- Pas de **scrobbling** (Last.fm, ListenBrainz).
- Pas d'intégration **Roon / Audirvana / TIDAL / Qobuz**.
- Pas de **sync iCloud / multi-machines**.

### AirPlay / Bluetooth
- AirPlay et Bluetooth sont supportés en lecture, mais le **Hog Mode** est désactivé (incompatible avec ces transports — macOS gère le buffer en interne).
- Quand tu sors d'AirPlay vers un autre device, la **notification volume macOS** peut afficher "AirPlay" pendant un moment (cosmétique — le volume contrôle bien le bon device).

### Métadonnées
- L'éditeur de métadonnées écrit dans le **fichier audio lui-même** (via lofty). C'est destructif — pas d'undo natif. Sauvegarde tes fichiers si tu fais des modifications massives.

---

## Points d'attention pour le code (post-beta)

Liste pour info — ces TODOs sont dans le code mais **non bloquants** pour la beta :

- `src-tauri/src/audio/coreaudio_backend.rs:807` — récupération du fabricant via `kAudioObjectPropertyManufacturer` (purement informatif dans la liste des devices)
- `src-tauri/src/audio/coreaudio_backend.rs:1131` — listeners CoreAudio pour le hot-plug (actuellement on poll au lieu de réagir aux événements système)

---

## Ce que tu ne devrais PAS voir (= bugs sérieux à reporter)

- Crash de l'app (la fenêtre disparaît brutalement)
- Audio qui se coupe en plein milieu d'une track
- Glitch / pop audible pendant une transition gapless ou un changement de sample rate
- App qui freeze pendant > 5s (UI ne répond plus)
- Pochettes qui ne se chargent jamais (alors que tu as bien Internet)
- Tracks supprimées qui réapparaissent après un redémarrage
- Métadonnées éditées qui ne sont pas persistées
- Mot de passe SMB redemandé à chaque démarrage

→ Si tu vois un de ces comportements, **reporte-le avec les logs joints** (case "Attach recent logs" cochée dans le modal feedback).
