# Tests AirPlay — 2026-03-05

Fixes appliqués : double `set_system_default_device`, polling readiness 3s, erreur AudioUnit explicite, gestion changement d'ID device, guard hog mode Rust, retry JS 1.5s.

**Pré-requis :** un receiver AirPlay sur le réseau, un casque filaire ou USB, optionnel: casque Bluetooth.

---

## 1. Switch de base

- [ ] **T1 — Built-in → AirPlay (1ère fois)**
  - Lancer une piste sur Built-in
  - Sélectionner le device AirPlay dans le panneau sorties
  - Le son sort du receiver AirPlay (~2s de latence acceptable)

- [ ] **T2 — AirPlay → Built-in**
  - Depuis AirPlay, repasser sur Built-in
  - Le son switch immédiatement sur les haut-parleurs

- [ ] **T3 — Built-in → AirPlay (2ème fois, stale)**
  - Après T2, re-sélectionner AirPlay
  - Le son doit sortir du receiver AirPlay (c'était le bug principal)

- [ ] **T4 — Cycle rapide ×3**
  - Enchaîner : AirPlay → Built-in → AirPlay → Built-in → AirPlay
  - Chaque switch fonctionne, pas de silence permanent

---

## 2. Hog mode / mode exclusif

- [ ] **T5 — Activer Hog Mode sur AirPlay (UI)**
  - Être sur AirPlay, tenter d'activer le mode exclusif
  - Résultat : toast d'erreur, hog mode reste OFF

- [ ] **T6 — Hog ON sur Built-in → switch AirPlay**
  - Activer hog mode sur Built-in
  - Switcher vers AirPlay
  - Le hog mode est auto-désactivé, toast affiché, son sur AirPlay

---

## 3. Cas d'erreur

- [ ] **T7 — AirPlay receiver éteint / hors réseau**
  - Éteindre le receiver AirPlay
  - Tenter de le sélectionner dans Noir
  - Message d'erreur visible (pas de silence sans explication)

---

## 4. Non-régression autres devices

- [ ] **T8 — USB DAC**
  - Brancher un DAC USB, sélectionner comme sortie
  - Le son sort du DAC, pas de latence ajoutée

- [ ] **T9 — Bluetooth**
  - Connecter un casque Bluetooth, sélectionner comme sortie
  - Le son sort du casque Bluetooth

---

## 5. Préservation de position

- [ ] **T10 — Position préservée après switch**
  - Lancer une piste, avancer à ~1:30
  - Switcher Built-in → AirPlay (ou inversement)
  - La lecture reprend à ~1:30 (±2s acceptable)

---

## 6. Sync volume macOS

- [ ] **T11 — Volume macOS après switch**
  - Switcher de device dans Noir
  - Utiliser les touches volume du Mac
  - Le volume change sur le device actif dans Noir (pas l'ancien)

---

## 7. Tests automatisés

- [ ] **T12 — `cargo test`** (src-tauri/)
  - `cd src-tauri && cargo test`
  - ~110 pass, ~18 ignored, 0 failed

- [ ] **T13 — `npm test`** (racine noir-tauri/)
  - `npm test -- --watchAll=false`
  - 11 pass, 0 failed

---

## Résultat

| Total | Pass | Fail | Skip |
|-------|------|------|------|
| /13   |      |      |      |

**Testeur :**
**Date :**
**Notes :**
