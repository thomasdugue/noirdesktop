---
name: hean-frontend
description: Patterns UI de Hean — design system Noir (couleurs, DM Sans/Geist Mono), pipeline covers/thumbnails (isConnected), contrainte CSS min-width:0, mosaïques playlist, homepage carousels. Charger avant de toucher src/*.js côté vues (views.js, library.js, playlists.js, panels.js, renderer.js) ou styles.css.
---

# hean-frontend — UI, covers & CSS

Les patterns transverses (médiateur `app.js`, state par référence, event delegation, AbortController) restent dans `noir-tauri/CLAUDE.md`.

## Design system & typography

**Référence design** : `/Users/tsunami25/Documents/Thomas/Noir Design System/noir-design-system.html` — composants : `noir-btn-primary`, `noir-btn-secondary`, `noir-btn-icon`, variables, couleurs, exemples.

**Polices** :
- `DM Sans` — police principale du corps/métadonnées, définie comme `--font-sans: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif` dans `:root`
- `Geist Mono` — police mono pour éléments techniques (chemins, tailles, bitrate), chargée via `@font-face` dans `styles.css`

**Palette de couleurs** (thème sombre, monochrome) :
- `--color-bg: #0a0a0a` (fond principal)
- `--color-bg-lighter: #111` / `--color-bg-surface: #161616` / `--color-bg-hover: #1a1a1a`
- `--color-border: #222` / `--color-border-light: #333`
- `--color-text: #fff` / `--color-text-muted: #888` / `--color-text-faint: #555`
- Accent vert : `#4ade80` (statut success)
- Rouge : `#f87171` (erreurs)

## Cover art resolution pipeline

**`loadThumbnailAsync(path, imgElement, artist, album)`** (`library.js`) — pipeline 4 niveaux :

1. **`thumbnailCache`** (mémoire) → instantané si déjà chargé dans cette session
2. **`get_cover_thumbnail`** (IPC Rust) → cache disque `~/.noir_desktop/thumbnails/{hash}_thumb.jpg`
3. **`get_cover`** (IPC Rust) → extraction depuis les tags du fichier audio (lofty)
4. **`fetch_internet_cover`** (IPC Rust) → MusicBrainz + CoverArtArchive (nécessite `artist` + `album` non null)

**⚠️ Contrainte `isConnected`** : `loadThumbnailFromQueue()` vérifie `imgElement.isConnected` dès l'entrée en file d'attente (ligne 400 de library.js). Si l'élément `<img>` n'est PAS connecté au DOM, la fonction retourne immédiatement sans charger la cover. Conséquence : ne JAMAIS créer un `<img>` détaché et le passer à `loadThumbnailAsync` en espérant qu'il sera inséré plus tard. L'`<img>` doit être dans le DOM AVANT l'appel.

**Internet cover storage** : `~/.noir_desktop/covers/internet_{md5(artist|||album)}.jpg`

## CSS layout — critical flex constraint

`.main-content` has `min-width: 0` — **do not remove**. Without it, carousels with `width: calc(100% + extra)` inflate the flex item beyond the viewport, breaking grid layouts (e.g. `.home-recent-grid` columns expand to 1492px each instead of ~268px) and preventing horizontal scroll on carousels.

```css
.main-content { flex: 1; min-width: 0; }  /* min-width: 0 is critical */
```

## Playlist thumbnails — pattern async

`playlists.js` utilise un chargement lazy de covers via attributs `data-cover-path`, `data-cover-artist`, `data-cover-album` :

1. `getPlaylistAlbumCovers(playlist)` — retourne ≤4 objets `{ path, artist, album }` (1 par album unique si `library.tracks` est peuplé, sinon paths bruts). **Déduplication par nom d'album seul** (`album.trim().normalize('NFC')`) — identique à la clé de `library.albums`. **Ne PAS dédupliquer par artist+album** sinon les variations "feat." créent de faux doublons (même pochette × N).
2. `buildPlaylistThumbHtml(covers, size)` — génère le HTML avec des `<div data-cover-path="..." data-cover-artist="..." data-cover-album="...">` (PAS `<img>`) selon le nombre de covers :
   - 0 → `playlist-cover-empty` (icône ♪)
   - 1 → `playlist-cover-single` (1 colonne, image pleine)
   - 2 → 2 divs côte à côte
   - 3-4 → grille 2×2 (le 4e slot répète le 1er si 3 covers)
3. `loadPlaylistThumbs(containerEl)` — async, fire-and-forget. Chaîne de fallback **4 niveaux** :
   1. `thumbnailCache` / `coverCache` (mémoire)
   2. `get_cover_thumbnail` (cache disque, instantané si pré-généré)
   3. `get_cover` (extrait depuis le fichier audio)
   4. `fetch_internet_cover` (MusicBrainz/Deezer — nécessite `artist` + `album` depuis les data-attributes)
   - Injecte `cell.style.backgroundImage = url(...)` et ajoute la classe `has-cover`

**`get_cover_thumbnail` vs `get_cover`** : `get_cover_thumbnail` retourne `null` si le thumbnail n'a pas été pré-généré par le scan en arrière-plan. Ne jamais l'utiliser seul sans fallback — utiliser `get_cover` en second essai.

**Timing sidebar au démarrage** : `initPlaylistListeners()` appelle `loadPlaylists()` → `updatePlaylistsSidebar()` depuis `DOMContentLoaded`. À ce moment, `init()` (async) n'a pas encore peuplé `library.tracks` (plusieurs `await` en attente). Fix : `renderer.js` appelle explicitement `app.updatePlaylistsSidebar()` après `groupTracksIntoAlbumsAndArtists()` + `displayCurrentView()` dans `init()`.
