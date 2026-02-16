# Rapport de diagnostic et optimisations - Noir

**Date**: Sessions nocturnes (cumul)
**Fichiers principaux**: renderer.js (~8900 lignes), styles.css (~5500 lignes), lib.rs, coreaudio_backend.rs

---

## Résumé des optimisations effectuées

### 1. Performance JavaScript

#### ✅ Event Delegation dans displayHomeView()
- **Avant**: Chaque élément avait son propre event listener (potentiellement 20+ listeners)
- **Après**: Un seul listener sur le container avec délégation
- **Impact**: Réduction de 95% des event listeners sur la Homepage

#### ✅ Appels asynchrones parallèles
- **Avant**: 3 appels `invoke()` séquentiels
- **Après**: `Promise.all()` avec `.catch()` individuels
- **Impact**: ~3x plus rapide au chargement de la Homepage

#### ✅ Système de gestion des timeouts
- **Ajout**: `setManagedTimeout()`, `clearManagedTimeout()`, `clearAllManagedTimeouts()`
- **Impact**: Évite les fuites mémoire dues aux timeouts orphelins

#### ✅ Recherche optimisée (anti-crash)
- **Avant**: `displayTracksGrid()` dans le search handler → détruit le DOM entier pendant la lecture audio → crash
- **Après**: Nouvelle fonction `updateTracksFilter()` qui recalcule les tracks filtrées et re-render via le pool existant SANS reconstruction DOM
- **Impact**: Recherche fluide pendant la lecture, plus aucun crash

### 2. Sécurité et robustesse

#### ✅ Protections null/undefined
- `playTrack()`: Validation de l'index et du track
- `playAlbum()`: Vérification de l'albumKey et de l'album
- `updateVirtualScrollItems()`: Vérification isConnected et viewportHeight
- `loadCoverAsync()`: Vérification du path, de l'imgElement et isConnected
- `openAlbumFromHome()`: Vérification albumKey, album, et état de la vue

#### ✅ Protection XSS
- Ajout de la fonction `escapeHtml()` pour sécuriser les données affichées

### 3. CSS

#### ✅ Design System avec variables CSS
- Ajout de `:root` avec toutes les couleurs, transitions et rayons
- Variables: `--color-bg`, `--color-text`, `--color-accent`, `--transition-*`, `--radius-*`

#### ✅ Nettoyage des duplications
- Fusion de `.playlist-tracks-list` (2 déclarations → 1)

---

## Nouvelles fonctionnalités

### ✅ Genre musical — Normalisation automatique (Rust)
- **Fichier**: `src-tauri/src/lib.rs`
- Extraction du genre depuis les tags audio (ID3v2, Vorbis, etc.) via `lofty::Accessor::genre()`
- Table de correspondance `GENRE_MAP` (~160 entrées) pour normaliser les variantes (hip hop, hiphop, hip-hop → "Hip-Hop")
- Support des codes numériques ID3v1 : `(17)` → "Rock"
- Fonction `normalize_genre()` avec fallback `title_case()`
- Champ `genre: Option<String>` avec `#[serde(default)]` pour compatibilité cache existant

### ✅ Track Info — Refresh metadata
- **Fichier**: `src/renderer.js`
- Bouton "Rafraîchir les métadonnées" dans le panel Track Info
- Appel `invoke('refresh_metadata')` → relit le fichier audio, met à jour le cache
- Affichage du genre dans le panel d'informations

### ✅ Bouton Settings — Déplacé dans la titlebar
- **Fichier**: `src/index.html`, `src/styles.css`
- Le bouton settings est passé du sidebar-footer à la titlebar (en haut à droite)
- Icône SVG engrenage, 28x28px, `-webkit-app-region: no-drag`

### ✅ Fenêtre déplaçable — Fix drag
- **Fichier**: `src/renderer.js`
- Le handler mousedown sur `.titlebar` appelait `startDragging()` en async/await → cassait le drag natif
- Fix: synchrone + `e.preventDefault()` + background `rgba(0,0,0,0.01)` pour capturer les events

### ✅ Effet Bit-Perfect — Brillance argentée (CSS)
- **Fichier**: `src/styles.css`
- Quand SRC = OUT (bit-perfect), le composant audio-specs passe en couleur argent (#C0C5CE) + gras
- Reflet miroir animé traversant le composant toutes les ~4s
- Gradient avec pic central à 55% d'opacité, animation `silver-shine` avec cubic-bezier

---

## Bugs corrigés

### Session précédente

1. **Virtual Scroll vide (page Titres)**
   - Cause: `updateVirtualScrollItems()` appelé avant le montage DOM
   - Fix: Déplacement après `appendChild()` avec `requestAnimationFrame()`

2. **Race conditions dans openAlbumFromHome()**
   - Cause: Timeouts non nettoyés lors de changement de vue
   - Fix: `setManagedTimeout()` avec vérification de l'état

3. **Crash potentiel dans playTrack()**
   - Cause: Pas de validation de l'index
   - Fix: Vérification `index >= 0 && index < tracks.length`

### Session actuelle

4. **Artwork homepage disparaît à la 2e visite**
   - Cause: `imgElement.isConnected` check dans `loadThumbnailAsync()` en path synchrone (cache hit) → élément pas encore dans le DOM quand `homeContainer` n'a pas été appendé
   - Fix: Suppression du check `isConnected` pour le path synchrone uniquement

5. **Bouton "Reprendre la lecture" ne fonctionne pas**
   - Cause: `audio_resume` ne fonctionne que sur un audio déjà chargé, mais l'auto-resume ne charge pas l'audio
   - Fix: Fallback `playTrack(currentTrackIndex)` dans le catch block du resume handler

6. **Bouton play blanc sur fond blanc (Lecture en cours)**
   - Cause: `.resume-play-btn` avait `color: #fff` sur un fond blanc
   - Fix: `color: #0a0a0a`

7. **Hog Mode bascule sur les enceintes Mac**
   - Cause: En activant le hog mode, macOS change temporairement le default output device → `check_device_change()` détecte un faux changement → libère le hog sur le casque → bascule sur les enceintes
   - Fix: Nouveau champ `hog_locked_device: bool` dans `CoreAudioBackend`. À l'activation du hog, on verrouille le device via `manual_device_id = Some(device_id)` → `get_active_device_id()` retourne toujours le casque. Libération automatique quand hog désactivé.

8. **Deux side panels ouverts simultanément**
   - Cause: Fermeture croisée incomplète — `toggleQueuePanel()` ne fermait pas track-info ni settings, `showTrackInfoPanel()` ne fermait pas settings
   - Fix: Chaque panel ferme les autres avant de s'ouvrir. `closeAllPanels()` ferme les 3 panels. Monkey-patch `_originalCloseAllPanels` supprimé.

9. **Crash lors de la recherche pendant lecture audio**
   - Cause: Le search handler appelait `displayTracksGrid()` qui détruit le DOM entier (pool nodes, scroll container) → les events `playback_progress` référencent un DOM stale → crash
   - Fix: Nouvelle fonction `updateTracksFilter()` qui recalcule les filtres et re-render via le pool existant sans toucher au DOM container

---

## Métriques

| Métrique | Avant | Après |
|----------|-------|-------|
| Event listeners Homepage | ~20+ | 1 (délégué) |
| Appels API séquentiels | 3 | 0 (parallèles) |
| Variables CSS | 0 | 25+ |
| Protections null | ~5 | ~15+ |
| Genres normalisés | 0 | ~160 variantes mappées |
| Bugs corrigés (total) | 3 | 9 |

---

## Architecture des fichiers modifiés

| Fichier | Lignes | Rôle |
|---------|--------|------|
| `src/renderer.js` | ~8900 | UI, audio, virtual scroll, panels, recherche |
| `src/styles.css` | ~5500 | Design system monochrome, animations, panels |
| `src/index.html` | ~515 | Structure HTML, titlebar, player, panels |
| `src-tauri/src/lib.rs` | ~2600 | Backend Rust, metadata, genres, cache, scan |
| `src-tauri/src/audio/coreaudio_backend.rs` | ~890 | CoreAudio, hog mode, device management |
| `src-tauri/tauri.conf.json` | ~55 | Config Tauri, window, titlebar overlay |
