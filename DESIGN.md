# Noir Desktop — Design System

> Audiophile music player for macOS. Dark, monochrome, precise.
> Every pixel serves the music. Nothing competes with the album art.

---

## 1. Design Philosophy

**Noir est un instrument, pas une vitrine.** L'interface s'efface pour laisser la musique au premier plan. Le design est sombre, calme, et technique. Il emprunte au monde hi-fi : précision, matériaux nobles, contrôle silencieux.

### Principes directeurs

1. **La musique d'abord.** Les pochettes d'album sont les seuls éléments colorés. L'UI reste monochrome pour ne jamais rivaliser avec l'artwork.
2. **Profondeur par transparence.** Les surfaces utilisent le glass morphism (backdrop-filter blur) pour créer de la hiérarchie sans couleur.
3. **Mouvement intentionnel.** Chaque animation communique un changement d'état. Pas de mouvement décoratif.
4. **Densité maîtrisée.** L'information est dense mais lisible. Pas de padding excessif. L'air est utilisé pour séparer les groupes, pas pour remplir.
5. **macOS-natif.** L'app doit se sentir comme un citoyen de première classe sur macOS. Context menus, glass, smooth easing.

---

## 2. Couleurs

### Palette principale

L'app est **100% monochrome**. Aucune couleur n'est utilisée dans l'UI sauf deux exceptions : le vert pour l'état "en lecture", et le rouge pour les erreurs.

| Token | Valeur | Usage |
|-------|--------|-------|
| `--color-bg` | `#0a0a0a` | Fond principal de l'app |
| `--color-bg-light` | `#111` | Sidebar, player bar (fond de base, avant glass) |
| `--color-bg-lighter` | `#151515` | Panels secondaires |
| `--color-bg-surface` | `#1a1a1a` | Hover léger, fond de carte |
| `--color-bg-hover` | `#222` | Hover interactif |
| `--color-bg-active` | `#2a2a2a` | Pressed/active |
| `--color-bg-elevated` | `#333` | Éléments surélevés |
| `--color-bg-muted` | `#444` | Fond très atténué |

| Token | Valeur | Usage |
|-------|--------|-------|
| `--color-text` | `#fff` | Texte principal |
| `--color-text-muted` | `#888` | Texte secondaire (artiste, meta) |
| `--color-text-dimmed` | `#666` | Texte tertiaire |
| `--color-text-faint` | `#555` | Labels, hints |

| Token | Valeur | Usage |
|-------|--------|-------|
| `--color-border` | `#222` | Bordures principales |
| `--color-border-light` | `#333` | Bordures secondaires |
| `--color-border-muted` | `#444` | Bordures atténuées |

| Token | Valeur | Usage |
|-------|--------|-------|
| `--color-green` | `#4ade80` | État "en lecture" uniquement |
| `--color-error` | `#ff4444` | Erreurs et actions destructives |
| `--color-error-muted` | `#ff6b6b` | Erreurs secondaires |

### Regles strictes

- **JAMAIS** de couleur d'accent autre que blanc, vert (lecture), ou rouge (erreur)
- **JAMAIS** de gradient coloré (pas de bleu-violet, pas de dégradé rainbow)
- **JAMAIS** de couleur dans les bordures (sauf `--color-green` pour l'état lecture)
- Les seules couleurs visibles dans l'app proviennent des **pochettes d'album**
- Les fonds glass utilisent `rgba()` avec des valeurs de gris, jamais de teinte

---

## 3. Typographie

### Polices

| Token | Police | Fallback | Usage |
|-------|--------|----------|-------|
| `--font-body` | Geist Mono (variable) | SF Mono, Monaco, Menlo | UI, navigation, labels, contrôles, temps |
| `--font-sans` | DM Sans | -apple-system, Helvetica Neue | Titres de page, titres de section, noms de tracks/artistes/albums dans le contenu |

### Echelle typographique

| Token | Taille | Usage |
|-------|--------|-------|
| `--fs-caption` | 9px | Captions, timestamps ultra-compact |
| `--fs-small` | 10px | Labels secondaires, stat labels |
| `--fs-body` | 11px | Texte courant, métadonnées |
| `--fs-label` | 12px | Labels de formulaire, badges |
| `--fs-subheading` | 13px | Sous-titres, titres de track dans le player |
| `--fs-title` | 14px | Titres d'éléments (queue header, settings) |
| `--fs-heading` | 16px | Sous-titres de page |
| `--fs-section-title` | 22px | Titres de section (home page) |
| `--fs-page-title` | 28px | Titres de page (album, artiste) |
| `--fs-hero` | 48px | Usage exceptionnel (splash, onboarding) |

### Regles strictes

- **Geist Mono** pour tout ce qui est UI/navigation/contrôle
- **DM Sans** pour tout ce qui est contenu musical (noms de tracks, artistes, albums, titres de page, titres de section)
- **JAMAIS** de font-size en dehors de l'échelle ci-dessus. Si une nouvelle taille est nécessaire, ajouter un token
- **JAMAIS** de `font-family` en valeur directe. Toujours `var(--font-body)` ou `var(--font-sans)`
- Les titres de page (`.album-page-title`, `.home-section-title`) utilisent `font-weight: 600-700` et `letter-spacing: -0.02em` à `-0.03em`
- Les labels uppercase utilisent `letter-spacing: 0.08em` et `font-size: 10px`
- Les nombres (durées, compteurs, stats) utilisent `font-variant-numeric: tabular-nums`

---

## 4. Espacement

### Echelle de spacing

| Token | Valeur | Usage |
|-------|--------|-------|
| `--sp-xs` | 4px | Micro-gaps (entre icône et label) |
| `--sp-sm` | 8px | Gaps internes (padding bouton, gap flex) |
| `--sp-md` | 12px | Padding de section interne |
| `--sp-base` | 16px | Padding standard |
| `--sp-lg` | 20px | Padding de section |
| `--sp-xl` | 24px | Marge entre sections |
| `--sp-2xl` | 32px | Marge de page |
| `--sp-3xl` | 40px | Marge héro |

### Regles strictes

- **JAMAIS** de valeur de padding/margin/gap en dehors de l'échelle. Utiliser les tokens `var(--sp-*)`
- Le padding interne d'un composant est toujours `--sp-sm` (8px) ou `--sp-md` (12px)
- L'espace entre sections sur la home page est `--sp-2xl` (32px) minimum
- L'espace entre un titre de section et son contenu est `--sp-base` (16px)

---

## 5. Rayons de bordure

| Token | Valeur | Usage |
|-------|--------|-------|
| `--radius-sm` | 4px | Boutons compacts, pills, track rows |
| `--radius-md` | 8px | Cards, covers, inputs, panels |
| `--radius-lg` | 12px | Modals, dropdowns, containers principaux |

### Regles strictes

- **JAMAIS** de `border-radius` en valeur directe. Toujours `var(--radius-*)`.
- Les pochettes d'album utilisent toujours `--radius-md`
- Les boutons ronds (play/pause) utilisent `border-radius: 50%`
- Les pochettes d'artiste dans le carousel utilisent `border-radius: 50%`
- Pas de border-radius > 12px sauf les cercles (50%)
- **Règle d'imbrication** : inner radius = outer radius - gap

---

## 6. Ombres et élévation

| Token | Valeur | Usage |
|-------|--------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.3)` | Boutons, badges |
| `--shadow-md` | `0 4px 12px rgba(0,0,0,0.4)` | Cards, covers au hover |
| `--shadow-lg` | `0 12px 32px rgba(0,0,0,0.5)` | Panels, modals, context menus |

### Hiérarchie d'élévation

| Niveau | Elements | Traitement |
|--------|----------|------------|
| 0 (fond) | `.app`, contenu principal | `--color-bg`, aucune ombre |
| 1 (surface) | Sidebar, player bar | Glass morphism (blur 36-40px), ombre subtile |
| 2 (panel) | Queue, settings, track info, EQ, lyrics | Glass morphism (blur 36px), ombre latérale |
| 3 (overlay) | Context menus, modals, search results | Glass morphism (blur 32-40px), ombre forte |
| 4 (toast) | Notifications toast | Glass morphism (blur 32px), ombre moyenne |

### Regles strictes

- **JAMAIS** d'ombre sur un élément sans `--shadow-*` token
- Les ombres sont toujours noires avec une opacité entre 0.3 et 0.6
- **JAMAIS** d'ombre colorée (pas de box-shadow bleu, vert, etc.) sauf le glow vert pour `--color-green`

---

## 7. Glass Morphism

Le glass morphism est le trait visuel distinctif de Noir. Il crée de la profondeur sans couleur.

### Paramètres par élément

| Element | `background` alpha | `blur` | `saturate` | `brightness` | Extras |
|---------|-------------------|--------|-----------|-------------|--------|
| Player bar | 0.65 | 40px | 1.6 | 1.05 | `inset 0 1px 0 rgba(255,255,255,0.03)` |
| Sidebar | 0.60 | 36px | 1.4 | 1.03 | — |
| Panels (queue, settings, EQ, lyrics, track info) | 0.68-0.70 | 36px | 1.5 | 1.04 | `inset 1px 0 0 rgba(255,255,255,0.03)` |
| Context menu | 0.72 | 40px | 1.6 | 1.05 | `inset 0 1px 0 rgba(255,255,255,0.04)` |
| Modals (content) | 0.78 | 32px | 1.4 | — | `inset 0 1px 0 rgba(255,255,255,0.04)` |
| Modal backdrop | — | 16px | — | — | Sur le fond sombre, pas le contenu |
| Toasts | 0.70 | 32px | 1.5 | — | `inset 0 1px 0 rgba(255,255,255,0.04)` |
| Search results | 0.70 | 36px | 1.5 | — | `inset 0 1px 0 rgba(255,255,255,0.03)` |
| Resume tile | 0.45-0.60 | 32px | 1.4 | — | gradient `linear-gradient(135deg, ...)` |
| Album detail | 0.55 | 28px | 1.4 | — | `inset 0 1px 0 rgba(255,255,255,0.03)` |

### Regles strictes

- **Toujours** doubler `backdrop-filter` avec `-webkit-backdrop-filter` (WebKit/Tauri)
- L'opacité du fond ne descend **jamais en dessous de 0.45** (lisibilité)
- L'opacité du fond ne monte **jamais au dessus de 0.85** (sinon pas de glass visible)
- Le blur minimum est **28px** pour un effet visible
- **Toujours** ajouter `saturate()` au backdrop-filter (minimum 1.3)
- Les bordures sur les surfaces glass sont **toujours** `rgba(255, 255, 255, 0.04-0.10)`
- Le highlight inset (`inset 0 1px 0 rgba(255,255,255,0.03)`) est recommande sur toute surface glass pour simuler la lumière du haut

---

## 8. Transitions et animations

### Durées

| Token | Valeur | Usage |
|-------|--------|-------|
| `--transition-fast` | 0.15s ease | Hover, focus, toggle |
| `--transition-normal` | 0.2s ease | Changements d'état |
| `--transition-slow` | 0.3s ease | Panels, overlays |

### Easing

| Token | Valeur | Usage |
|-------|--------|-------|
| `--ease-out-expo` | `cubic-bezier(0.16, 1, 0.3, 1)` | Panels qui glissent, éléments qui entrent |
| `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Rebond (toasts, toggles) |
| `ease` | CSS natif | Hover simples |

### Patterns d'animation

| Pattern | Timing | Propriétés | Usage |
|---------|--------|-----------|-------|
| Hover bouton | `--transition-fast` | `background, color, border-color` | Tous les boutons |
| Hover card (album/carousel) | 0.3s `--ease-out-expo` | `transform, box-shadow, filter` | Cards qui montent |
| Hover track row | `--transition-fast` | `background` | Rangées de liste |
| Panel slide | 0.35s `--ease-out-expo` | `transform` | Queue, settings, track info |
| Context menu entrée | 0.15s `--ease-out-expo` | `opacity, transform (scale + translateY)` | Depuis `scale(0.96) translateY(-4px)` |
| View transition | 0.12-0.18s ease | `opacity, transform (translateY 6px)` | Changement de page |
| Bouton press | 0.1s ease | `transform: scale(0.92-0.97)` | Active state |
| Nav indicator | 0.25s `--ease-out-expo` | `transform: scaleY()` | Barre latérale active |
| Stagger reveal | 0/30/60ms delay | `opacity, transform` | Boutons d'action track |
| Pulse | 2s ease-in-out infinite | `opacity` | Barre verte "en lecture" |

### Regles strictes

- **JAMAIS** `transition: all`. Toujours lister les propriétés explicitement
- **JAMAIS** animer `width`, `height`, `top`, `left`. Utiliser `transform` et `opacity` uniquement
- **JAMAIS** de durée > 0.5s sauf les animations loop (pulse, shimmer)
- **JAMAIS** de durée < 0.1s (invisible)
- Les panels glissent toujours avec `--ease-out-expo`, jamais avec `ease` basique
- `prefers-reduced-motion: reduce` doit annuler toutes les animations
- Les hover de cards utilisent `translateY(-6px)` + `scale(1.02)` + `--shadow-lg`
- Les hover de track rows utilisent seulement `background`, pas de transform

---

## 9. Composants

### Boutons

| Type | Fond | Bordure | Taille | Rayon |
|------|------|---------|--------|-------|
| Primary (`.btn-primary`) | `--color-accent` (blanc) | none | padding 14px 28px | `--radius-md` |
| Control (`.btn-control`) | transparent | 2px solid #333 | 44x44px | 50% (rond) |
| Play (`.btn-play`) | transparent | 2px solid #333 | 38x38px | 50% |
| Nav (`.btn-nav`) | transparent | 2px solid #333 | 30x30px | 50% |
| Mode (`.btn-mode`) | transparent | none | 36x36px | `--radius-sm` |
| Icon (`.btn-icon`) | transparent | 1px solid `--color-border-light` | 28x28px | `--radius-md` |
| Ghost (`.btn-icon-small`) | transparent | 1px solid `--color-border` | variable | `--radius-sm` |

**Hover :** Primary = `box-shadow` glow + `translateY(-1px)`. Ghost = `border-color` + `background` subtil.
**Active :** `scale(0.92-0.97)` + suppression du shadow.
**Play button hover :** anneau extérieur (`::after`, border 1px rgba blanc).

### Cards (albums)

- Largeur fixe : 180px (grid), `clamp(120px, 18vw, 160px)` (carousel)
- Cover : carré, `--radius-md`, `overflow: hidden`
- Inner border : `::after` avec `box-shadow: inset 0 0 0 1px rgba(255,255,255,0.04)`
- Hover : `translateY(-6px) scale(1.02)`, `--shadow-lg`, `brightness(1.08) contrast(1.02)` sur l'image

### Track rows

- Padding : `10px 12px`
- Rayon : `--radius-sm`
- Hover : `background: rgba(255,255,255,0.04)` + barre accent gauche (2px, `rgba(255,255,255,0.3)`)
- Playing : barre accent verte (`--color-green`) avec animation pulse
- Selected : `background: rgba(255,255,255,0.06)`
- Action buttons : apparaissent au hover avec stagger (0/30/60ms)

### Navigation sidebar

- Nav item actif : `background: linear-gradient(90deg, rgba(255,255,255,0.06), transparent)` + barre gauche 2px blanche
- Nav item hover (non-actif) : `translateX(2px)` + fond subtil
- Playlist active : meme barre gauche 2px blanche
- Logo : `filter: drop-shadow()` au hover

### Panels latéraux

- Largeur : queue = 320px, track info = 380px
- Animation d'entrée : `transform: translateX(100%)` -> `translateX(0)`, 0.35s `--ease-out-expo`
- Fond : glass morphism (voir section 7)
- Bordure intérieure : `1px solid rgba(255,255,255,0.04-0.06)`

### Context menus

- Fond : glass morphism (blur 40px, alpha 0.72)
- Animation : `scale(0.96) translateY(-4px)` -> `scale(1) translateY(0)`, 0.15s
- Items hover : `rgba(255,255,255,0.08)`, `--radius-sm`
- Séparateurs : `linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent)`

### Modals

- Backdrop : `backdrop-filter: blur(16px)` sur l'overlay sombre
- Contenu : glass morphism (blur 32px, alpha 0.78)
- Rayon : `--radius-lg`
- Ombre : `--shadow-lg` doublée

---

## 10. Accessibilite

### Focus

- `:focus-visible` : `outline: 2px solid var(--color-accent)`, `outline-offset: 2px`
- `:focus:not(:focus-visible)` : `outline: none` (souris)
- **JAMAIS** `outline: none` sans remplacement pour le clavier

### Touch targets

- Minimum 44x44px pour tous les éléments interactifs (boutons de contrôle)
- Minimum 28x28px pour les boutons secondaires dans les listes

### Mouvement

- `@media (prefers-reduced-motion: reduce)` annule toutes les animations (`animation-duration: 0.01ms`, `transition-duration: 0.01ms`)
- **JAMAIS** ajouter une animation sans la tester avec reduced-motion

### Contraste

- Texte principal (#fff) sur fond (#0a0a0a) = ratio 19.3:1 (AAA)
- Texte muted (#888) sur fond (#0a0a0a) = ratio 5.3:1 (AA)
- Texte dimmed (#666) sur fond (#0a0a0a) = ratio 3.5:1 (utiliser seulement pour labels non-essentiels)
- Texte faint (#555) sur fond (#0a0a0a) = ratio 2.7:1 (decoratif uniquement, jamais pour du contenu critique)

---

## 11. Icones

- Source : SVG inline dans le HTML
- Taille par défaut : 18x18px (nav), 14x14px (boutons compacts), 24px (player controls)
- Couleur : `currentColor` (hérite du parent)
- Opacité inactive : 0.6 (nav items)
- Opacité active : 1.0
- **JAMAIS** d'emoji comme icône
- **JAMAIS** d'icône dans un cercle coloré (pattern "SaaS template")

---

## 12. Textures et effets visuels

### Film grain (noise)

- Overlay SVG fractal noise sur `.app::before`
- Opacité : 0.025 (2.5%)
- `z-index: 9999`, `pointer-events: none`
- Crée une sensation analogique sans être visible consciemment

### Vignette

- Sur les covers d'album page : `box-shadow: inset 0 0 40px rgba(0,0,0,0.2)`
- Crée de la profondeur cinématique

### Cover art halo

- Sur la cover art dans le player : `::after` avec blur(16px), opacity 0.35
- L'album art "irradie" subtilement sa couleur autour

### Inner border

- Sur toutes les pochettes (album grid, carousel) : `::after` avec `box-shadow: inset 0 0 0 1px rgba(255,255,255,0.04)`
- Simule un reflet de verre

---

## 13. Anti-patterns (ce qu'on ne fait JAMAIS)

### Couleurs
- Pas de gradient coloré (bleu-violet, rainbow, etc.)
- Pas de couleur d'accent autre que blanc/vert/rouge
- Pas de fond coloré sur les badges (sauf vert pour lecture)
- Pas de `border-left: 3px solid <color>` sur les cards

### Layout
- Pas de grid 3 colonnes symétriques avec icônes dans cercles
- Pas de "hero section" avec image plein écran et overlay
- Pas de carousel automatique
- Pas d'emoji dans les titres ou les boutons
- Pas de sections de même hauteur empilées

### Typographie
- Pas de font en dehors de Geist Mono et DM Sans
- Pas de texte centré sauf le fullscreen player
- Pas de `text-align: center` sur les titres de section
- Pas de letterspacing positif sur du texte lowercase (sauf labels uppercase)

### Effets
- Pas de blob décoratif, cercle flottant, ou SVG ondulé
- Pas de shadow colorée
- Pas de `transition: all`
- Pas d'animation sur les propriétés de layout (width, height, top, left)
- Pas de border-radius uniforme > 12px sur tout

### UX
- Pas d'empty state vide (juste "No items"). Toujours : message + action primaire
- Pas de bouton "Submit" ou "Continue" generique. Toujours un verbe spécifique
- Pas de modal de confirmation sans possibilité d'annuler
- Pas de loading sans feedback visuel (utiliser shimmer/skeleton)

---

## 14. Checklist nouveau composant

Avant de merger un nouveau composant CSS, vérifier :

- [ ] Utilise uniquement des tokens CSS (`--color-*`, `--sp-*`, `--fs-*`, `--radius-*`, `--shadow-*`, `--transition-*`)
- [ ] Aucune valeur de couleur hex/rgb directe (sauf dans les `rgba()` pour glass/overlay)
- [ ] Aucune font-family directe (utilise `var(--font-body)` ou `var(--font-sans)`)
- [ ] Aucun `transition: all`
- [ ] Aucune animation sur width/height/top/left
- [ ] Focus-visible state présent sur les éléments interactifs
- [ ] Touch target >= 44px (contrôles) ou >= 28px (actions secondaires)
- [ ] Hover state défini
- [ ] Active/pressed state défini (scale 0.92-0.97)
- [ ] Fonctionne avec `prefers-reduced-motion: reduce`
- [ ] Le glass morphism suit les paramètres de la section 7
- [ ] Les bordures sur surfaces glass utilisent `rgba(255,255,255,0.04-0.10)`
- [ ] Le blur backdrop est toujours doublé (`backdrop-filter` + `-webkit-backdrop-filter`)
- [ ] Les nombres utilisent `font-variant-numeric: tabular-nums`
- [ ] La police est correcte (Geist Mono pour UI, DM Sans pour contenu musical)

---

## 15. Structure du fichier CSS

```
styles.css
├── @font-face declarations
├── :root (tous les tokens)
├── Typography metadata (font-sans assignments)
├── Reset + focus-visible
├── Layout (app, sidebar, main content)
├── Sidebar navigation
├── Search bar
├── Album grid + cards
├── Album page + detail
├── Track lists
├── Home page sections + carousel
├── Player bar (grid layout)
├── Cover art
├── Controls, progress, volume
├── Queue panel
├── Track info panel
├── Context menus
├── Settings panel
├── DAP sync section
├── Modals
├── Fullscreen player
├── Responsive breakpoints
├── Splash screen
├── Micro-interactions (v1)
├── Glass morphism overrides (v1)
├── Design Upgrade v2 (premium polish)
│   ├── Noise texture
│   ├── Sidebar premium nav
│   ├── Player glass + halo
│   ├── Progress/volume sliders
│   ├── Album cards hover
│   ├── Track rows accent
│   ├── Album page hero
│   ├── Home sections
│   ├── Queue glass
│   ├── Fullscreen cinematic
│   ├── Context menu macOS
│   ├── Modals glass
│   ├── Search focus
│   ├── Panels glass
│   ├── Buttons refined
│   ├── Audio specs badges
│   ├── Settings/EQ panels
│   ├── Typography upgrades
│   ├── Sidebar playlists
│   ├── View transitions
│   └── Staggered reveals
├── Scrollbar
├── Empty state
└── @media (prefers-reduced-motion)
```

Les règles de la section "Design Upgrade v2" utilisent une spécificité égale ou des `!important` ciblés pour overrider les règles de base. En cas de conflit, la dernière règle dans le fichier gagne (cascade CSS).
