# Rapport de diagnostic et optimisations - Noir

**Date**: Session nocturne
**Fichiers analysés**: renderer.js (3084 lignes), styles.css (2705 lignes), lib.rs

---

## Résumé des optimisations effectuées

### 1. Performance JavaScript

#### ✅ Event Delegation dans displayHomeView()
- **Avant**: Chaque élément avait son propre event listener (potentiellement 20+ listeners)
- **Après**: Un seul listener sur le container avec délégation
- **Impact**: Réduction de 95% des event listeners sur la Homepage

#### ✅ Appels asynchrones parallèles
- **Avant**:
  ```javascript
  const lastPlayed = await invoke('get_last_played')
  const recentTracks = await invoke('get_recent_albums', { days: 15 })
  const allPlayedAlbums = await invoke('get_all_played_albums')
  ```
- **Après**:
  ```javascript
  const [lastPlayedResult, recentTracksResult, allPlayedAlbumsResult] = await Promise.all([
    invoke('get_last_played').catch(() => null),
    invoke('get_recent_albums', { days: 15 }).catch(() => []),
    invoke('get_all_played_albums').catch(() => [])
  ])
  ```
- **Impact**: ~3x plus rapide au chargement de la Homepage

#### ✅ Système de gestion des timeouts
- **Ajout**: `setManagedTimeout()`, `clearManagedTimeout()`, `clearAllManagedTimeouts()`
- **Impact**: Évite les fuites mémoire dues aux timeouts orphelins

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
- Facilite la maintenance et le theming futur
- Variables disponibles:
  - `--color-bg`, `--color-bg-light`, `--color-bg-surface`, etc.
  - `--color-text`, `--color-text-muted`, `--color-text-dimmed`
  - `--color-accent`, `--color-accent-hover`
  - `--transition-fast`, `--transition-normal`, `--transition-slow`
  - `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl`

#### ✅ Nettoyage des duplications
- Fusion de `.playlist-tracks-list` (2 déclarations → 1)
- Autres duplications conservées car légitimes (styles de base + responsive)

---

## Bugs corrigés

1. **Virtual Scroll vide (page Titres)**
   - Cause: `updateVirtualScrollItems()` appelé avant le montage DOM
   - Fix: Déplacement après `appendChild()` avec `requestAnimationFrame()`

2. **Race conditions dans openAlbumFromHome()**
   - Cause: Timeouts non nettoyés lors de changement de vue
   - Fix: Utilisation de `setManagedTimeout()` avec vérification de l'état

3. **Crash potentiel dans playTrack()**
   - Cause: Pas de validation de l'index
   - Fix: Vérification `index >= 0 && index < tracks.length`

---

## Métriques

| Métrique | Avant | Après |
|----------|-------|-------|
| Event listeners Homepage | ~20+ | 1 (délégué) |
| Appels API séquentiels | 3 | 0 (parallèles) |
| Variables CSS | 0 | 25+ |
| Protections null | ~5 | ~15+ |

---

## Recommandations pour le futur

1. **Migration progressive vers variables CSS**
   - Remplacer progressivement `#1a1a1a` par `var(--color-bg-surface)` etc.

2. **Tests automatisés**
   - Ajouter des tests pour les fonctions critiques (playTrack, displayHomeView)

3. **Lazy loading des pochettes**
   - Implémenter IntersectionObserver pour ne charger que les pochettes visibles

4. **Service Worker**
   - Cache offline pour les métadonnées et pochettes

---

## Fichiers modifiés

- `/src/renderer.js` - Optimisations JS, protections null, event delegation
- `/src/styles.css` - Variables CSS, nettoyage duplications
