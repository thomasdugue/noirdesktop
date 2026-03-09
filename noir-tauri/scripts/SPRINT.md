# Sprint Plan — Noir Beta
> jeudi 26 février 2026 · 8 issues analysées · `feedback-agent.js` + `sprint-planner.js`

---

## Vue d'ensemble

| Issue | Titre | Coût | Impact | Risque | Verdict | Modules |
|---|---|---|---|---|---|---|
| [#13](https://github.com/thomasdugue/noir-feedback/issues/13) | Problème sur random album | ? | ? | ? | ? | ? |
| [#12](https://github.com/thomasdugue/noir-feedback/issues/12) | Repetit one ne fonctionne pas | 4-6 heures | ████░ 4/5 | ███░░ 3/5 | 🔧 standard | `playback.js`, `state.js`, `app.js`, `lib.rs`, `audio_engine.rs` |
| [#10](https://github.com/thomasdugue/noir-feedback/issues/10) | Liste de lecture vide : la lecture continue | 2h | ████░ 4/5 | ██░░░ 2/5 | ⚡ quick-win | `playback.js`, `renderer.js`, `state.js` |
| [#9](https://github.com/thomasdugue/noir-feedback/issues/9) | Erreur d'affichage pour les articles qui n'on | 3-4 heures | ████░ 4/5 | ██░░░ 2/5 | ⚡ quick-win | `views.js`, `playback.js` |
| [#8](https://github.com/thomasdugue/noir-feedback/issues/8) | Double sélection dans le side panel | 2h | ████░ 4/5 | ██░░░ 2/5 | ⚡ quick-win | `renderer.js`, `state.js` |
| [#7](https://github.com/thomasdugue/noir-feedback/issues/7) | Page pas de résultats, artiste et album | 2h | ████░ 4/5 | █░░░░ 1/5 | ⚡ quick-win | `views.js` |
| [#4](https://github.com/thomasdugue/noir-feedback/issues/4) | Racourci clavier système Mac | 4-6 heures | ████░ 4/5 | ███░░ 3/5 | 🔍 needs-investigation | `shortcuts.js`, `lib.rs`, `audio_engine.rs`, `playback.js` |
| [#2](https://github.com/thomasdugue/noir-feedback/issues/2) | le bouton give feedback et settigns ne sont p | 2-3 heures | ████░ 4/5 | ██░░░ 2/5 | ⚡ quick-win | `renderer.js` |

---

## Détail rapide par issue



<details>
<summary><strong>#12</strong> — Repetit one ne fonctionne pas</summary>

- **Coût :** 4-6 heures — Investigation du cycle state→JS→Rust (playback.js + lib.rs + audio_engine.rs) + tests gapless + validation cross-module via app.js médiateur
- **Impact :** Repeat One dysfonctionnel affecte ~25% beta testers, bloque use case critique de relecture de single track
- **Risques :** Régression sur repeat modes (ALL/SHUFFLE) ou gestion queue si mutation state.playback.repeat mal synchronisée entre JS et Rust ; edge case gapless decoding si logique seek imbriquée

</details>

<details>
<summary><strong>#10</strong> — Liste de lecture vide : la lecture continue</summary>

- **Coût :** 2h — Ajout vérification queue vide dans playback.js (advance track) + logique d'arrêt dans renderer.js (UI sync), pas de changement Rust nécessaire.
- **Impact :** Évite playback fantôme quand playlist vidée, affecte ~65% testeurs en mode shuffle/repeat avec suppression dynamique de tracks.
- **Risques :** Régression sur gestion queue pendant lecture (race condition si advance_track appelé pendant mutation state.queue), test edge case : pause→vider queue→play doit arrêter immédiatement.

</details>

<details>
<summary><strong>#9</strong> — Erreur d'affichage pour les articles qui n'ont qu'une seule track</summary>

- **Coût :** 3-4 heures — Modification de la logique de rendu artist-page dans views.js pour détecter les artistes sans albums et afficher une liste de tracks avec métadonnées complètes (titre, durée, album) + ajustements CSS mineurs.
- **Impact :** Restaure la visibilité des tracks pour ~35% des utilisateurs (artistes de compilations avec une seule track). Permet la consultation complète des métadonnées (titre, durée, contexte album).
- **Risques :** Risque de régression sur le rendu album existant si la condition de détection (artistes sans albums) n'est pas correctement isolée ; peut affecter l'ordre d'affichage si la logique d'enrichissement de métadonnées n'est pas alignée avec state.library.

</details>

<details>
<summary><strong>#8</strong> — Double sélection dans le side panel</summary>

- **Coût :** 2h — Ajouter un système de déselection exclusive dans renderer.js lors du clic sur un item du side panel, sans refactor majeur du state.
- **Impact :** Corrige l'UX de navigation critère pour ~85% des beta testers : une seule section du side panel ne peut être active simultanément.
- **Risques :** Régression possible sur les actions multi-sélection (playlists) si la logique de clearing d'état n'est pas isolée au side panel uniquement.

</details>

<details>
<summary><strong>#7</strong> — Page pas de résultats, artiste et album</summary>

- **Coût :** 2h — Modification légère de views.js pour ajouter rendu conditionnel (empty state) + texte localisé + bouton reset, sans logique search complexe.
- **Impact :** ~85% des utilisateurs (testeurs) voient une feedback claire au lieu d'une page blanche lors de recherches sans résultats albums/artistes, élimine frustration UX.
- **Risques :** Risque minimal : ajout conditionnel de DOM, pas de mutation state.js ni logique audio — pourrait affecter scroll virtuel si mal placé mais contenable.

</details>

<details>
<summary><strong>#4</strong> — Racourci clavier système Mac</summary>

- **Coût :** 4-6 heures — Diagnostic Tauri/macOS (global hotkeys vs F-keys système), implémentation binding Rust + test multi-plateforme (macOS/Windows/Linux) requis.
- **Impact :** 35% beta testers bloqués sur raccourcis critiques (pause/skip/preview) — contrôle playback dégradé sur macOS.
- **Risques :** Régression sur Windows/Linux si binding global hotkeys mal géré ; conflit avec raccourcis système macOS (F7=Rewind, F8=Play/Pause natifs) pouvant casser audio_engine ou créer double-événements.

</details>

<details>
<summary><strong>#2</strong> — le bouton give feedback et settigns ne sont pas responsive</summary>

- **Coût :** 2-3 heures — Analyse CSS du header (renderer.js) + ajout media queries + test responsive sur breakpoints critiques (mobile/tablet/desktop) — pas de refactoring JS nécessaire.
- **Impact :** Restaure l'accès aux boutons Settings/Feedback sur ~60% des résolutions (redimensionnement fenêtre, petits écrans), critique pour UX.
- **Risques :** Régression potentielle sur layout existant si flexbox/grid mal configuré, risque de chevauchement avec queue panel ou sidebar — requiert test cross-view.

</details>

---

## 👉 Prochaines étapes

Pour générer le plan d'implémentation détaillé des issues que tu choisis :

```bash
node scripts/sprint-planner.js --plan 13,12,10
```

**Quick wins suggérés :** #10, #9, #8, #7, #2
**À investiguer d'abord :** #4

---
*Généré par sprint-planner.js — 2026-02-26T12:10:42.931Z*

---

## 🛠 Plans d'implémentation détaillés

### #15 — bouton play RESUME PLAYBOACK de la home ne fonctionne pas

🔗 [GitHub](https://github.com/thomasdugue/noir-feedback/issues/15) · modules : `views.js`, `playback.js`, `state.js`, `renderer.js` · 🦀 Rust

**Cause racine :** Le bouton 'Resume Playback' de la home ne déclenche probablement pas correctement la commande Rust ou l'état playback n'est pas correctement restauré au démarrage. Il manque soit la persistence de l'état (track ID, position) entre les sessions, soit le handler du bouton ne vérifie pas l'existence d'un état sauvegardé, soit la communication avec le backend Rust échoue silencieusement lors de la tentative de reprise.

#### Plan d'implémentation

#### Étape 1 — `src/state.js`
> **Où :** objet playback{}

Vérifier si les propriétés nécessaires à la reprise sont présentes (currentTrackId, position, wasPlaying) et si elles survivent au reload

```js
// playback: { currentTrackId: null, position: 0, wasPlaying: false, ... }
```

#### Étape 2 — `src/renderer.js`
> **Où :** fonction initApp ou équivalent au démarrage

Ajouter la restauration de l'état playback depuis localStorage au démarrage de l'app

```js
// const saved = localStorage.getItem('playbackState'); if(saved) Object.assign(state.playback, JSON.parse(saved))
```

#### Étape 3 — `src/playback.js`
> **Où :** fonctions pause/stop et mise à jour de position

Ajouter la persistence de l'état dans localStorage à chaque changement critique (pause, position, track change)

```js
// localStorage.setItem('playbackState', JSON.stringify({currentTrackId, position, wasPlaying: state.playback.isPlaying}))
```

#### Étape 4 — `src/views.js`
> **Où :** fonction renderHome, section 'Resume Playback'

Identifier le handler du bouton play et vérifier qu'il appelle correctement la fonction de reprise avec les bons paramètres (trackId + position)

```js
// btn.onclick = () => app.resumePlayback(state.playback.currentTrackId, state.playback.position)
```

#### Étape 5 — `src/playback.js`
> **Où :** fonction de reprise ou play

Créer/vérifier l'existence d'une fonction resumePlayback qui charge le track sauvegardé et seek à la position stockée avant de lancer play

```js
// async resumePlayback(trackId, pos) { await invoke('play_track', {path}); await invoke('seek', {position: pos}); }
```

#### Étape 6 — `src/app.js`
> **Où :** exports du médiateur

Exposer la fonction resumePlayback si elle n'est pas déjà accessible depuis views.js

```js
// export const resumePlayback = (id, pos) => playback.resumePlayback(id, pos)
```

#### Étape 7 — `src-tauri/src/lib.rs`
> **Où :** commandes Tauri

Vérifier que les commandes play_track et seek gèrent correctement les cas où l'audio engine n'est pas initialisé ou est en état stale

```js
// if engine.is_none() { engine = Some(AudioEngine::new()); } engine.play(path); engine.seek(pos);
```

#### Étape 8 — `src/views.js`
> **Où :** renderHome, condition d'affichage de Resume Playback

S'assurer que la section Resume Playback ne s'affiche que si state.playback.currentTrackId existe et est valide

```js
// if(state.playback.currentTrackId && state.library.tracks[state.playback.currentTrackId]) { /* render resume */ }
```

#### Cas limites
- Track sauvegardé n'existe plus dans la bibliothèque (supprimé ou déplacé)
- Position sauvegardée dépasse la durée réelle du fichier audio (fichier modifié)
- localStorage plein ou désactivé dans les paramètres navigateur
- Multiple instances de l'app ouvertes simultanément (conflit d'état)
- Premier lancement de l'app sans état sauvegardé

#### Tests
- [ ] Lancer un track, mettre en pause à 30s, fermer l'app, rouvrir → bouton Resume Playback visible et fonctionnel
- [ ] Reprendre la lecture → doit démarrer au bon track et à la bonne position (±1s)
- [ ] Supprimer le fichier du track en pause, rouvrir l'app → Resume Playback ne s'affiche pas ou affiche un message d'erreur
- [ ] Premier lancement → pas de Resume Playback affiché
- [ ] Laisser jouer jusqu'à la fin d'un track, fermer → Resume Playback ne devrait pas s'afficher (ou passer au suivant)
- [ ] Tester avec localStorage désactivé → l'app ne doit pas crasher

#### Risques de régression
Si la persistence est trop agressive (à chaque update de position), cela pourrait causer des lenteurs ou user le SSD. La restauration d'état au démarrage pourrait interférer avec l'autoplay ou d'autres mécanismes de démarrage. Le seek immédiat après play_track pourrait causer des race conditions si l'audio n'est pas encore chargé.

#### Effort
1h analyse (tracer le flow complet du bouton + vérifier état persistant) + 2h implem (persistence localStorage + resumePlayback + guards Rust) + 1h test (scénarios edge cases)

---
