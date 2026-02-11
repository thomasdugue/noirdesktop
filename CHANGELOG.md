# Noir Player — Changelog

Historique cumulatif des développements, décisions d'architecture et bugs résolus.

---

## [2025-02-11] Améliorations Panel Info + Toggle Hog Mode

### Fonctionnalités

- **Menu contextuel page Album** : Clic droit sur les tracks fonctionne maintenant
- **Détection des doublons** : Alerte visuelle si un titre existe plusieurs fois dans la bibliothèque
- **Liens cliquables** : Artiste et album dans le panel info sont maintenant cliquables (navigation directe)
- **Loader artwork** : Spinner pendant le chargement de la pochette, force le chargement depuis le backend
- **Toggle Hog Mode redessiné** : Switch iOS-style avec tooltip d'information détaillée

### Design

| Élément | Style |
|---------|-------|
| Toggle Hog Mode | Switch 44x24px, vert #22c55e actif, animation glow |
| Tooltip | 280px, background #1a1a1a, warning box ambre |
| Alerte doublon | Fond dégradé ambre, animation pulse |
| Liens cliquables | Hover avec background subtil, icône apparaît |

### Fichiers Modifiés

```
index.html    — Nouveau HTML toggle Hog Mode avec tooltip
styles.css    — ~150 lignes : toggle switch, tooltip, alerte doublons, liens
renderer.js   — findTrackDuplicates(), initHogModeTooltip(), updateHogModeStatus()
```

---

## [2025-02-11] Panel Informations Track

### Fonctionnalités

- **Panel Informations** : Nouveau side panel affichant les métadonnées complètes d'un track
  - Accessible via le menu contextuel → "Informations"
  - Affiche : artwork, titre, artiste, album, qualité audio (badge coloré)
  - Caractéristiques audio : fréquence, profondeur de bits, débit
  - Métadonnées : durée, format, année, numéro de piste, codec
  - Chemin complet du fichier

### Design

| Élément | Style |
|---------|-------|
| Panel | Side panel droit, 380px, animation slide-in cubic-bezier |
| Artwork | 200x200px avec shadow et hover scale |
| Badge qualité | Hi-Res (doré), Lossless (bleu), Lossy (gris) |
| Specs grid | 3 colonnes avec icônes et labels |
| Typography | Labels uppercase 10px, valeurs 13-14px |

### Fichiers Modifiés

```
index.html    — Bouton "Informations" menu contextuel + aside panel
styles.css    — ~200 lignes de styles pour le panel d'informations
renderer.js   — showTrackInfoPanel(), closeTrackInfoPanel(), init listeners
```

---

## [2025-02-11] Commit `6931ed5` — Pure CoreAudio Implementation

### Fonctionnalités

- **Suppression de CPAL** : Implémentation CoreAudio native pure
  - `kAudioUnitSubType_HALOutput` au lieu de `DefaultOutput`
  - `kAudioOutputUnitProperty_CurrentDevice` pour sélection directe du device
  - Paramètre `device_id: Option<AudioObjectID>` dans `CoreAudioStream::new()`

- **Fix rechargement cache library** : `init_cache()` recharge maintenant `TRACKS_CACHE` depuis le disque au démarrage

- **Fix Hog Mode** : Libération automatique lors du changement de périphérique (déconnexion casque/DAC)

### Décisions d'Architecture

| Décision | Justification |
|----------|---------------|
| Supprimer CPAL | CPAL ne permet pas de sélectionner un device spécifique, toujours le défaut système |
| HALOutput vs DefaultOutput | HALOutput permet `kAudioOutputUnitProperty_CurrentDevice` pour router vers un DAC précis |
| Windows séparé (futur) | WASAPI sera implémenté nativement plutôt que via CPAL pour le même niveau de contrôle |

### Bugs Résolus

| Bug | Cause | Solution |
|-----|-------|----------|
| Library vide après redémarrage | `TRACKS_CACHE` non rechargé depuis `tracks_cache.json` | Appel explicite `load_tracks_cache()` dans `init_cache()` |
| "Erreur de chargement" panel audio | Hog Mode verrouillé sur device déconnecté | Libération dans `check_device_change()` avant switch |
| Compilation E0599 | `unwrap_or` sur `u32` (pas `Option`) | Accès direct sans unwrap |
| Compilation E0063 | `StreamConfig` mal initialisé | Utiliser `StreamConfig::stereo(rate)` |

### Fichiers Modifiés

```
Cargo.toml                    — cpal supprimé
audio/backend.rs              — get_device_id() remplace get_cpal_device()
audio/coreaudio_backend.rs    — imports CPAL supprimés, nouvelle logique device
audio/coreaudio_stream.rs     — HALOutput + device selection
audio/stream.rs               — paramètre device_id ajouté
audio_engine.rs               — DeviceCapabilities supprimé, simplifié
lib.rs                        — fix cache reload
```

### Prochaines Étapes

Plan de 14 correctifs UX en 3 batches (voir `bright-scribbling-ripple.md`) :

**Batch 1 — Player**
- [ ] Repeat 1 ne fonctionne pas
- [ ] Random rejoue des titres déjà écoutés
- [ ] SRC/OUT cache le nom de l'artiste
- [ ] Artwork manquant dans "Lecture en cours"

**Batch 2 — Navigation**
- [ ] Back depuis album → page vide
- [ ] Nom artiste non cliquable
- [ ] Tri albums crée liste dupliquée
- [ ] Double sidebar page Titres

**Batch 3 — UX Polish**
- [ ] Drag & drop vers playlists
- [ ] Couleur cœur blanc
- [ ] Carrousel artistes photo
- [ ] Menus contextuels multiples

---

## Architecture Audio Actuelle

```
┌─────────────────────────────────────────────────────────────┐
│                      audio_engine.rs                        │
│  Gestion playback (play, pause, seek, stop)                │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
┌─────────────────────────┐     ┌─────────────────────────────┐
│   coreaudio_backend.rs  │     │   coreaudio_stream.rs       │
│  Device enumeration     │     │  AudioUnit HAL output       │
│  Sample rate control    │     │  Render callback            │
│  Hog Mode               │     │  AudioUnitReset() (seek)    │
│  get_device_id()        │     │  Volume control             │
└─────────────────────────┘     └─────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │   CoreAudio     │
                    │   (macOS HAL)   │
                    └─────────────────┘
```

---

*Mis à jour automatiquement après chaque commit*
