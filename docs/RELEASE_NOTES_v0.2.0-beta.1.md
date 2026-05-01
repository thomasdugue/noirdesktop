# Hean v0.2.0-beta.1 — Release notes

**Date** : 2026-04-26
**Audience** : ~50 beta-testeurs invités

---

## TL;DR

Première beta publique de Hean. Lecteur audiophile macOS pour fichiers locaux et NAS, **bit-perfect** via CoreAudio, **gapless**, support **NAS SMB** avec progressive download.

---

## Nouveautés depuis la dev

### Audio engine (production-grade)
- **Bit-perfect playback** via `coreaudio-rs` (remplacement de CPAL — meilleur contrôle du buffer et seek correct)
- **Hog Mode** : accès exclusif au DAC pour garantir le bit-perfect (incompatible AirPlay/Bluetooth)
- **Sample rate dynamique** : négociation auto avec le DAC (44.1 / 48 / 88.2 / 96 / 192 kHz)
- **EQ paramétrique 8 bandes** (filtres biquad — bypass auto si tous les gains à 0 dB)
- **Gapless preload** : 60s avant fin de track pour SMB (10s en local)
- **Media keys** macOS interceptées via `MPRemoteCommandCenter` même quand Apple Music tourne en arrière-plan

### NAS / SMB
- Discovery automatique via mDNS/Bonjour
- Auth guest ou login/password (stocké dans le **Keychain macOS**)
- **Progressive download** : streaming des fichiers SMB en chunks de 64KB pendant que la lecture commence
- Cache différentiel des métadonnées (re-scan rapide)
- Auto-reconnect au démarrage

### UI / UX
- Refonte design 2026 : ambient color theming, spring physics, kinetic typography
- **Onboarding 6 étapes** : library → NAS discovery → auth → share → folder → scan
- **Virtual scroll** sur les listes de tracks (60 nœuds DOM, peu importe la taille de la library)
- **Custom drag & drop** (HTML5 drag est cassé dans Tauri WebView)
- **Page d'accueil** : Recently Added, Discover, Audiophile picks, Long Albums, Discovery Mixes
- **Fullscreen player** : visualisation particulaire avec extraction de couleur depuis la pochette

### Métadonnées & pochettes
- Pipeline 4 niveaux pour les pochettes : cache mémoire → cache disque → tags audio → MusicBrainz/CoverArtArchive
- Edition de métadonnées (single + bulk) — écrites dans le fichier audio via `lofty`
- Genre enrichment via Deezer
- Lyrics via lrclib.net + lyrics.ovh fallback

### Observabilité (nouveau pour la beta)
- **Sentry** : capture des panics Rust + erreurs JS, avec anonymisation des paths utilisateur
- **Logs persistés** sur disque (rotation journalière, 7 jours)
- **Bouton "Attach logs"** dans le feedback : joint les ~200 derniers Ko de logs au rapport
- **Auto-updater** : check au démarrage, signature minisign vérifiée, install + relance auto

---

## Features explicitement exclues de cette beta

### DAP Sync (archivée)
La synchro vers un Digital Audio Player (Mass Storage / MTP / SMB) a été **retirée du build** le 2026-04-22 à cause d'une instabilité non résolue sur le protocole MTP (Transaction ID mismatches, timeouts, InvalidObjectHandle).

- Code archivé sur la branche `archive/dap-sync-v1` + tag `dap-sync-archive-2026-04`
- Rapport complet : [`docs/archive/dap-sync/`](archive/dap-sync/)
- Les tables SQLite `dap_destinations` et `dap_sync_selection` sont **laissées dans la DB utilisateur** pour préserver les configs en vue d'une future réintégration

### Pas dans cette beta
- Scrobbling (Last.fm, ListenBrainz)
- Intégration Roon / Audirvana / TIDAL / Qobuz
- Sync iCloud / multi-machines
- Build Windows / Linux

---

## Configuration recommandée

- **macOS 11 Big Sur ou plus récent** (le binaire refuse 10.x)
- **Apple Silicon** (build natif M1/M2/M3/M4) ou **Intel x86_64**
- **DAC USB** pour profiter du bit-perfect
- **NAS SMB** sur réseau local (Synology, QNAP, OpenMediaVault, Samba générique) pour tester le streaming

---

## Distribution

- **DMG signé + notarisé** Apple Developer ID
- Disponible sur [GitHub Releases](https://github.com/thomasdugue/noirdesktop/releases) (privé pour cette beta)
- Auto-update vers les beta suivantes (beta.2, beta.3, ...) via le système Tauri updater intégré

---

## Ce que je cherche à valider

1. **Stabilité** sur sessions longues (4h+ sans relance)
2. **Bit-perfect** sur DACs externes — sample rate négocié correctement, pas de conversion silencieuse
3. **NAS / SMB** : connexion stable, lecture sans glitch même en 24/192
4. **Onboarding** : prise en main fluide ou frictions
5. **Performance** sur grosses libraries (>10k tracks)

---

## Channel feedback

- **Bouton in-app** (en bas à droite) → POST vers Cloudflare Worker → GitHub Issue privée
- **GitHub direct** : [thomasdugue/noir-feedback](https://github.com/thomasdugue/noir-feedback) avec le template "Beta bug report"
- **Email** (en dernier recours) : contact@hean.app

---

## Versioning

- `0.2.0-beta.1` — première vague (~50 testeurs)
- `0.2.0-beta.2`, `.3`, ... — itérations de bugfix
- `0.2.0` (release) — quand on aura validé les 5 critères ci-dessus
