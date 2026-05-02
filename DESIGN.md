# Design System — Hean

Design system du lecteur audio macOS Hean. Thème sombre monochrome, esthétique "instrument de précision" pour audiophiles.

## Philosophie

Hean est un instrument de précision, pas un player mainstream. L'esthétique communique : **précision, qualité, confiance, warmth**. Penser platine vinyle haut de gamme, pas playlist Spotify.

## Tokens

### Couleurs

```css
--color-bg: #0a0a0a          /* Fond principal */
--color-bg-lighter: #111     /* Sidebar, surfaces élevées */
--color-bg-surface: #161616  /* Surfaces secondaires */
--color-bg-hover: #1a1a1a    /* Hover states */
--color-bg-elevated: #1e1e1e /* Contrôles (sliders, inputs) */
--color-border: #222         /* Bordures principales */
--color-border-light: #333   /* Bordures légères */
--color-text: #fff           /* Texte principal */
--color-text-muted: #888     /* Texte secondaire */
--color-text-faint: #555     /* Texte tertiaire */
--color-accent: #fff         /* Accent = blanc */
--color-green: #4ade80       /* Success / statuts positifs */
--color-error: #f87171       /* Erreurs */
```

### Glassmorphism

```css
--glass-bg: rgba(17, 17, 17, 0.78)
--glass-blur: blur(20px) saturate(150%)
--glass-border: rgba(255, 255, 255, 0.06)
```

Appliqué sur : sidebar, player bar, modals, context menus, toasts, search panel.
**Pas** sur : grilles albums, listes tracks, pages album/artiste (restent opaques).

### Typographie

| Token | Taille | Usage |
|-------|--------|-------|
| `--fs-caption` | 10px | Métadonnées tertiaires |
| `--fs-small` | 11px | Labels secondaires |
| `--fs-body` | 12px | Corps de texte |
| `--fs-label` | 13px | Labels principaux |
| `--fs-subheading` | 14px | Sous-titres |
| `--fs-title` | 15px | Titres |
| `--fs-heading` | 18px | Headings |

Polices :
- **DM Sans** — corps, métadonnées (`--font-sans`)
- **Geist Mono** — éléments techniques : chemins, bitrate, taille de fichier

### Spacing

Scale 4px : 4, 8, 12, 16, 20, 24, 32, 40.

### Shadows

```css
--shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3)
--shadow-md: 0 4px 12px rgba(0, 0, 0, 0.4)
--shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.5)
--shadow-glow: 0 0 40px rgba(255, 255, 255, 0.03)
--shadow-inset: inset 0 1px 0 rgba(255, 255, 255, 0.05)
```

### Transitions

```css
--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1)
--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1)
--ease-smooth: cubic-bezier(0.4, 0, 0.2, 1)
--transition-fast: 0.15s
--transition-normal: 0.2s
--transition-slow: 0.3s
```

## Surfaces et profondeur

3 niveaux de luminosité créent la hiérarchie sans couleur :

1. **Fond** (`#0a0a0a`) — contenu principal, grilles
2. **Surfaces élevées** (glass `rgba(17,17,17,0.78)`) — sidebar, player bar
3. **Overlays** (glass + border) — modals, context menus, toasts

### Inner highlights (light edge)

`border-top: 1px solid rgba(255, 255, 255, 0.04)` sur les surfaces élevées (sidebar header, player bar). Simule une source lumineuse au-dessus.

### Neumorphism ultra-subtil

Progress bar et volume slider : `box-shadow: inset 0 1px 2px rgba(0,0,0,0.4), 0 0.5px 0 rgba(255,255,255,0.04)`. Donne un relief physique aux contrôles audio.

## Micro-interactions

| Élément | Effet | Timing |
|---------|-------|--------|
| Album card hover | `translateY(-4px)` + glow shadow | 0.3s ease-out-expo |
| Cover art load | `scale(0.97→1)` + fade-in | 0.4s ease-out |
| Play/pause button | `scale(0.92)` on active, spring return | 0.15s spring |
| View transitions | `translateY(6px→0)` + opacity | 0.18s smooth |
| Toast entrée | fade-in + glassmorphism | 0.3s |

## Ambient glow

Le player bar affiche un halo blanc subtil dont l'intensité varie avec la luminosité de la pochette en cours de lecture.

- Extraction de luminosité via canvas 64×64 (réutilise `fullscreen-player.js`)
- CSS variable `--ambient-intensity` (0.02 pour covers sombres, 0.06 pour covers claires)
- `box-shadow: 0 -15px 50px rgba(255, 255, 255, var(--ambient-intensity))`
- 100% monochrome, aucune couleur ajoutée au thème principal

## Règles d'usage

1. **Jamais de couleur d'accent** hors vert (success) et rouge (erreur). L'identité est monochrome.
2. **Glassmorphism sélectif** — uniquement sur les overlays et surfaces flottantes, jamais sur le contenu principal.
3. **Animations fonctionnelles** — chaque animation doit communiquer un changement d'état. Pas de décoration gratuite.
4. **Profondeur par luminosité** — 3 niveaux max. La hiérarchie se lit dans les gris.
5. **Typographie lisible** — minimum 10px (caption). Le body est à 12px pour le confort sur Retina.
