---
name: zone-rule-playback-js
description: La règle de zone audio+UI ne vise que le Rust audio ; playback.js / shortcuts.js (JS frontend) sont de l'UI, pas de l'audio
metadata:
  type: feedback
---

La règle de zone (audio ET UI/library dans un même diff → AVERTISSEMENT) ne se déclenche que si le diff touche les chemins Rust listés : `src-tauri/src/audio/`, `audio_engine.rs`, `audio_decoder.rs`, `coreaudio_*`. Les fichiers JS `noir-tauri/src/playback.js`, `shortcuts.js`, `renderer.js` sont du frontend (UI du player) : un diff qui ne touche qu'eux + styles/index.html ne déclenche PAS la règle.

**Why:** interprétation retenue lors de la relecture du correctif bouton shuffle (2026-10-29) pour éviter un faux positif sur le nom « playback ».
**How to apply:** ne vérifier la règle de zone que sur les chemins exacts listés dans le prompt de l'agent.
