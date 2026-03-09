# Noir Beta Feedback — Week of February 25, 2026

## Summary

- **13** new feedbacks processed (9 bugs, 0 features, 4 UX, 0 other)
- Average importance score: **7.5/10**
- Quick wins identified (importance ≥ 7, complexity ≤ 5): **8**

---

## 🔴 Critical Bugs (importance ≥ 8)

| Issue | Title | Importance | Effort | Action |
|---|---|---|---|---|
| [#11](https://github.com/thomasdugue/noir-feedback/issues/11) | Problème avec le Hog Mode, Exclusive Mode | 9/10 | 1_week | Investiguer l'implémentation du Hog Mode dans la couche audi |
| [#13](https://github.com/thomasdugue/noir-feedback/issues/13) | Problème sur random album | 8/10 | half_day | Implémenter la suppression des tracks jouées du pool de shuf |
| [#12](https://github.com/thomasdugue/noir-feedback/issues/12) | Repetit one ne fonctionne pas | 8/10 | half_day | Investiguer la logique REPEAT ONE dans le backend Rust et le |
| [#10](https://github.com/thomasdugue/noir-feedback/issues/10) | Liste de lecture vide : la lecture continue | 8/10 | half_day | Implémenter vérification playlist vide avant continuation le |
| [#9](https://github.com/thomasdugue/noir-feedback/issues/9) | Erreur d'affichage pour les articles qui n'ont qu' | 8/10 | half_day | Implémenter affichage track list pour artistes sans album |
| [#8](https://github.com/thomasdugue/noir-feedback/issues/8) | Double sélection dans le side panel | 8/10 | half_day | Implémenter un système de sélection exclusive dans le side p |
| [#5](https://github.com/thomasdugue/noir-feedback/issues/5) | Actualisation des données lorsque je modifie les m | 8/10 | 1_day | Implémenter un système de cache invalidation après modificat |
| [#3](https://github.com/thomasdugue/noir-feedback/issues/3) | Lecture continue : problème de liste de lecture | 8/10 | 1_day | Debuguer la logique de transition de liste de lecture en lec |

---

## ⚡ Quick Wins — Best Impact/Effort Ratio

| Issue | Title | Importance | Effort | Action |
|---|---|---|---|---|
| [#7](https://github.com/thomasdugue/noir-feedback/issues/7) | Page pas de résultats, artiste et album | 7/10 | half_day | Ajouter message 'Aucun résultat' + bouton reset search album |
| [#10](https://github.com/thomasdugue/noir-feedback/issues/10) | Liste de lecture vide : la lecture continue | 8/10 | half_day | Implémenter vérification playlist vide avant continuation le |
| [#8](https://github.com/thomasdugue/noir-feedback/issues/8) | Double sélection dans le side panel | 8/10 | half_day | Implémenter un système de sélection exclusive dans le side p |
| [#2](https://github.com/thomasdugue/noir-feedback/issues/2) | le bouton give feedback et settigns ne sont pas re | 7/10 | half_day | Implémenter responsive design pour header buttons, ajouter h |
| [#13](https://github.com/thomasdugue/noir-feedback/issues/13) | Problème sur random album | 8/10 | half_day | Implémenter la suppression des tracks jouées du pool de shuf |
| [#12](https://github.com/thomasdugue/noir-feedback/issues/12) | Repetit one ne fonctionne pas | 8/10 | half_day | Investiguer la logique REPEAT ONE dans le backend Rust et le |
| [#9](https://github.com/thomasdugue/noir-feedback/issues/9) | Erreur d'affichage pour les articles qui n'ont qu' | 8/10 | half_day | Implémenter affichage track list pour artistes sans album |
| [#4](https://github.com/thomasdugue/noir-feedback/issues/4) | Racourci clavier système Mac | 7/10 | half_day | Vérifier binding clavier F7/F8/F9 dans Tauri/Rust et test ma |

---

## 💡 Most Requested Features

*None this week.*

---

## 📊 All Issues — Priority Ranking

| Issue | Title | Category | Importance | Complexity | Score | Sprint |
|---|---|---|---|---|---|---|
| [#7](https://github.com/thomasdugue/noir-feedback/issues/7) | Page pas de résultats, artiste et album | ux | 7 | 2 | 3.5 | ✅ |
| [#14](https://github.com/thomasdugue/noir-feedback/issues/14) | Légère animation entre les pages | ux | 6 | 2 | 3 |  |
| [#6](https://github.com/thomasdugue/noir-feedback/issues/6) | Et qui porte des playlists dans la page  | ux | 6 | 2 | 3 |  |
| [#10](https://github.com/thomasdugue/noir-feedback/issues/10) | Liste de lecture vide : la lecture conti | bug | 8 | 3 | 2.67 | ✅ |
| [#8](https://github.com/thomasdugue/noir-feedback/issues/8) | Double sélection dans le side panel | bug | 8 | 3 | 2.67 | ✅ |
| [#2](https://github.com/thomasdugue/noir-feedback/issues/2) | le bouton give feedback et settigns ne s | ux | 7 | 3 | 2.33 | ✅ |
| [#13](https://github.com/thomasdugue/noir-feedback/issues/13) | Problème sur random album | bug | 8 | 4 | 2 | ✅ |
| [#12](https://github.com/thomasdugue/noir-feedback/issues/12) | Repetit one ne fonctionne pas | bug | 8 | 4 | 2 | ✅ |
| [#9](https://github.com/thomasdugue/noir-feedback/issues/9) | Erreur d'affichage pour les articles qui | bug | 8 | 4 | 2 | ✅ |
| [#4](https://github.com/thomasdugue/noir-feedback/issues/4) | Racourci clavier système Mac | bug | 7 | 4 | 1.75 | ✅ |
| [#5](https://github.com/thomasdugue/noir-feedback/issues/5) | Actualisation des données lorsque je mod | bug | 8 | 6 | 1.33 |  |
| [#3](https://github.com/thomasdugue/noir-feedback/issues/3) | Lecture continue : problème de liste de  | bug | 8 | 6 | 1.33 |  |
| [#11](https://github.com/thomasdugue/noir-feedback/issues/11) | Problème avec le Hog Mode, Exclusive Mod | bug | 9 | 7 | 1.29 |  |

---

## 🎯 Recommended Sprint (next v0.x)

Actions in priority order:
1. [#7](https://github.com/thomasdugue/noir-feedback/issues/7) — Page pas de résultats, artiste et album (7/10 importance, half_day)
2. [#10](https://github.com/thomasdugue/noir-feedback/issues/10) — Liste de lecture vide : la lecture continue (8/10 importance, half_day)
3. [#8](https://github.com/thomasdugue/noir-feedback/issues/8) — Double sélection dans le side panel (8/10 importance, half_day)
4. [#2](https://github.com/thomasdugue/noir-feedback/issues/2) — le bouton give feedback et settigns ne sont pas responsive (7/10 importance, half_day)
5. [#13](https://github.com/thomasdugue/noir-feedback/issues/13) — Problème sur random album (8/10 importance, half_day)
6. [#12](https://github.com/thomasdugue/noir-feedback/issues/12) — Repetit one ne fonctionne pas (8/10 importance, half_day)
7. [#9](https://github.com/thomasdugue/noir-feedback/issues/9) — Erreur d'affichage pour les articles qui n'ont qu'une seule track (8/10 importance, half_day)
8. [#4](https://github.com/thomasdugue/noir-feedback/issues/4) — Racourci clavier système Mac (7/10 importance, half_day)

---
*Generated by feedback-agent.js — 2026-02-25T19:49:23.466Z*
