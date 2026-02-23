# QA TRACKER — Noir Desktop

## Synthèse

| Sévérité | Ouverts | En cours | Résolus |
|---|---|---|---|
| 🔴 Critique | 0 | 0 | 3 |
| 🟠 Majeur | 0 | 0 | 6 |
| 🟡 Mineur | 2 | 0 | 5 |

**Dernier audit** : 2025-01-XX
**Prochaine action recommandée** : Tester l'EQ 8 bandes en conditions réelles

---

## Problèmes résolus

### QA-001 — [BUG] Hog Mode empêche le changement de device

| Champ | Valeur |
|---|---|
| **Sévérité** | 🔴 Critique |
| **Type** | Bug |
| **Symptôme** | Quand le Hog Mode est activé, changer de sortie audio ne fonctionne pas car macOS détecte un changement de device par défaut et `check_device_change()` l'intercepte |
| **Fichiers** | `coreaudio_backend.rs` |
| **Cause probable** | `set_exclusive_mode(Exclusive)` verrouillait le device via `manual_device_id` mais aucun mécanisme ne permettait de le déverrouiller sauf un changement explicite de device |
| **Solution** | Ajout du champ `hog_locked_device: bool` — verrouille en mode exclusif, déverrouille en mode partagé ou changement de device |
| **Statut** | 🟢 Résolu |

### QA-002 — [BUG] Side panels se superposent

| Champ | Valeur |
|---|---|
| **Sévérité** | 🟠 Majeur |
| **Type** | Bug |
| **Symptôme** | Ouvrir le panneau queue puis le panneau track-info les affiche tous les deux simultanément, causant des bugs visuels |
| **Fichiers** | `renderer.js` (`toggleQueuePanel`, `showTrackInfoPanel`, `closeAllPanels`) |
| **Cause probable** | Chaque panneau ne fermait pas les autres — pas de coordination mutuellement exclusive |
| **Solution** | Cross-closure systématique : chaque panneau ferme les autres avant de s'ouvrir |
| **Statut** | 🟢 Résolu |

### QA-003 — [BUG] Crash de recherche pendant la lecture

| Champ | Valeur |
|---|---|
| **Sévérité** | 🔴 Critique |
| **Type** | Crash |
| **Symptôme** | Taper une recherche pendant la lecture cause un crash JS — le scroll container est détruit puis recréé, cassant les références |
| **Fichiers** | `renderer.js` (`updateTracksFilter`, `displayTracksGrid`) |
| **Cause probable** | `displayTracksGrid()` détruisait et recréait le DOM complet, invalidant toutes les refs |
| **Solution** | Création de `updateTracksFilter()` — filtre les tracks et re-render via le pool DOM existant sans reconstruire |
| **Statut** | 🟢 Résolu |

### QA-004 — [PERF] Boucle RAF tourne en permanence

| Champ | Valeur |
|---|---|
| **Sévérité** | 🟠 Majeur |
| **Type** | Performance |
| **Symptôme** | ~2-5% CPU en permanence même au repos (aucune lecture) |
| **Fichiers** | `renderer.js` (`startPositionInterpolation`, `stopPositionInterpolation`) |
| **Cause probable** | Le RAF tournait 60fps en continu, même en pause — `stopPositionInterpolation()` n'était jamais appelé |
| **Solution** | Stop RAF dans les listeners `playback_paused` et `playback_ended`, restart dans `playback_resumed` |
| **Statut** | 🟢 Résolu |

### QA-005 — [PERF] transition: all sur 32 éléments CSS

| Champ | Valeur |
|---|---|
| **Sévérité** | 🟡 Mineur |
| **Type** | Performance |
| **Symptôme** | Transitions CSS forçaient le recalcul de toutes les propriétés à chaque hover, coûteux sur les listes longues |
| **Fichiers** | `styles.css` |
| **Cause probable** | 32 occurrences de `transition: all` transient TOUTES les propriétés |
| **Solution** | Remplacé par les propriétés exactes (`color`, `background-color`, `opacity`) |
| **Statut** | 🟢 Résolu |

### QA-006 — [PERF] border-left cause des recalculs layout

| Champ | Valeur |
|---|---|
| **Sévérité** | 🟡 Mineur |
| **Type** | Performance |
| **Symptôme** | Multi-sélection de pistes déclenchait des recalculs layout à chaque ajout/retrait de border |
| **Fichiers** | `styles.css` (`.tracks-list-item.selected`) |
| **Cause probable** | `border-left: 3px solid` change le box model |
| **Solution** | Remplacé par `box-shadow: inset 3px 0 0 #fff` (pas d'impact layout) |
| **Statut** | 🟢 Résolu |

### QA-007 — [PERF] Recherche sans index — O(N) par frappe

| Champ | Valeur |
|---|---|
| **Sévérité** | 🟠 Majeur |
| **Type** | Performance |
| **Symptôme** | Latence perceptible sur bibliothèques 10K+ à chaque lettre tapée |
| **Fichiers** | `renderer.js` (`buildSearchIndex`, `getSortedAndFilteredTracks`) |
| **Cause probable** | Pas d'index de recherche, debounce à 100ms seulement |
| **Solution** | Index inversé par mots + debounce à 200ms |
| **Statut** | 🟢 Résolu |

### QA-008 — [PERF] Requêtes HTTP bloquantes (reqwest::blocking)

| Champ | Valeur |
|---|---|
| **Sévérité** | 🟠 Majeur |
| **Type** | Performance / Bug |
| **Symptôme** | Gel potentiel de l'UI quand plusieurs pochettes sont téléchargées en parallèle (threads Tokio saturés) |
| **Fichiers** | `lib.rs` (fetch_cover_from_musicbrainz, fetch_artist_image, etc.) |
| **Cause probable** | `reqwest::blocking::Client` bloque les threads du pool Tokio |
| **Solution** | Migration vers `reqwest::Client` async, `tokio::time::sleep` au lieu de `thread::sleep` |
| **Statut** | 🟢 Résolu |

### QA-009 — [MEM] Pochettes en base64 — ~700KB par album en heap JS

| Champ | Valeur |
|---|---|
| **Sévérité** | 🔴 Critique |
| **Type** | Performance / Mémoire |
| **Symptôme** | Mémoire WebView explose avec les grosses bibliothèques (700MB+ pour 1000 albums) |
| **Fichiers** | `lib.rs`, `renderer.js`, `tauri.conf.json` |
| **Cause probable** | Pochettes encodées en base64 stockées dans des Map JS sans éviction |
| **Solution** | Protocole custom `noir://` — les pochettes sont servies directement depuis le disque, cache navigateur natif |
| **Statut** | 🟢 Résolu |

### QA-010 — [PERF] Virtual scroll — innerHTML à chaque RAF

| Champ | Valeur |
|---|---|
| **Sévérité** | 🟠 Majeur |
| **Type** | Performance |
| **Symptôme** | Saccades pendant le scroll rapide (GC pauses dues à la destruction/recréation de nœuds DOM) |
| **Fichiers** | `renderer.js` (`updateVirtualScrollItems`, `displayTracksGrid`) |
| **Cause probable** | `contentContainer.innerHTML = html` reconstruit 30-50 nœuds DOM à chaque changement de position de scroll |
| **Solution** | Pool de 60 nœuds DOM réutilisables — mise à jour via propriétés directes (`textContent`, `classList.toggle`) |
| **Statut** | 🟢 Résolu |

### QA-011 — [PERF] tracks.find() O(n) dans les handlers

| Champ | Valeur |
|---|---|
| **Sévérité** | 🟡 Mineur |
| **Type** | Performance |
| **Symptôme** | Chaque clic dans la liste fait un scan linéaire de toutes les pistes |
| **Fichiers** | `renderer.js` |
| **Cause probable** | `tracks.find(t => t.path === path)` sur 10K+ pistes = 10K comparaisons |
| **Solution** | `tracksByPath` Map pour lookup O(1) |
| **Statut** | 🟢 Résolu |

---

## Problèmes ouverts

### QA-012 — [AUDIT] EQ: validation des gains reçus du frontend

| Champ | Valeur |
|---|---|
| **Sévérité** | 🟡 Mineur |
| **Type** | Anti-pattern |
| **Symptôme** | Pas de risque immédiat mais le frontend pourrait envoyer des gains hors [-12, +12] ou un array de taille incorrecte |
| **Fichiers** | `lib.rs` (`set_eq_bands`) |
| **Cause probable** | La commande `set_eq_bands` ne valide pas la longueur du vecteur `gains` |
| **Solution proposée** | Ajouter un guard `if gains.len() != 8 { return Err(...) }` et clamper chaque gain |
| **Statut** | 🟡 Ouvert |

### QA-013 — [AUDIT] EQ: transitoire audio au changement de preset

| Champ | Valeur |
|---|---|
| **Sévérité** | 🟡 Mineur |
| **Type** | Anti-pattern |
| **Symptôme** | Quand un preset est appliqué, les 8 filtres biquad sont réinitialisés d'un coup (`DirectForm1::new()`), ce qui peut causer un micro-clic audible |
| **Fichiers** | `eq.rs` (`EqBandFilter::update_if_needed`) |
| **Cause probable** | Le reset des filtres efface l'historique (z1, z2), créant une discontinuité dans le signal |
| **Solution proposée** | V2 : interpoler les coefficients sur ~10ms ou appliquer un crossfade court |
| **Statut** | 🟡 Ouvert |

---

## Changelog des audits

### Audit initial — 2025-01-XX

**Scope** : Revue complète du code après implémentation des Phases 1-4 + EQ 8 bandes

**Findings** :
- ✅ Aucun `transition: all` restant dans le CSS
- ✅ Aucun `reqwest::blocking` dans le code Rust
- ✅ Aucun `innerHTML` dans les hot paths du virtual scroll
- ✅ Pool DOM de 60 nœuds correctement implémenté
- ✅ Protocole `noir://` avec cache `immutable` pour les pochettes
- ✅ Index de recherche inversé avec debounce 200ms
- ✅ RAF stoppé en pause/fin de lecture
- ⚠️ QA-012 : validation des gains EQ côté backend
- ⚠️ QA-013 : transitoire possible au changement de preset EQ
