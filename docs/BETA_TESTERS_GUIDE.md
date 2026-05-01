# Hean — Guide pour beta-testeurs

Bienvenue dans la beta privée de **Hean**, un lecteur audiophile macOS pour fichiers locaux et NAS.

Merci de tester. Ce guide t'explique l'installation, la prise en main, et comment me remonter les bugs.

---

## Pré-requis

- **macOS 11 (Big Sur) ou plus récent** — l'app refusera de se lancer sur 10.x.
- **Mac Apple Silicon (M1/M2/M3/M4)** ou **Intel** — un build par architecture.
- **~200 Mo d'espace disque** pour l'app + caches (peut grossir selon la taille de ta library).
- Optionnel : un NAS / Synology / partage SMB sur le réseau local pour tester le streaming.

---

## Installation

1. Télécharge le `.dmg` depuis le lien envoyé.
2. Ouvre le `.dmg` → glisse **Hean.app** dans **Applications**.
3. Ouvre Hean depuis le Launchpad ou Spotlight (`Cmd+Espace` → "Hean").

> **Si macOS dit que l'app ne peut pas être ouverte :** clic droit sur l'app → **Ouvrir** (et confirme une fois). C'est un avertissement Gatekeeper — l'app est bien signée par Apple Developer ID, mais la première ouverture demande ta confirmation explicite.

---

## Premier lancement

L'**onboarding** te guide en 6 étapes :

1. **Bienvenue**
2. **Choisir ta library locale** (un dossier qui contient tes fichiers FLAC/MP3/etc.)
3. **NAS discovery** *(optionnel)* — Hean cherche les serveurs SMB sur ton réseau.
   - macOS te demandera la permission **"Local Network"** la première fois → clique **Autoriser**.
   - Sans ça, l'app ne pourra pas voir les NAS.
4. **Authentification SMB** *(si NAS)* — guest ou login/password (stocké dans le Keychain macOS).
5. **Choix du share + dossier** sur le NAS.
6. **Scan** — Hean indexe les métadonnées et génère les vignettes. Sur une grosse library (~10 000 tracks) : compte 1 à 5 minutes en local, plus pour du SMB.

> Tu peux skipper toutes les étapes et configurer plus tard via **Réglages**.

---

## Formats supportés

| Format | Status |
|--------|--------|
| FLAC, ALAC, WAV, AIFF | ✅ Lossless, lecture bit-perfect |
| MP3, AAC/M4A, OGG Vorbis | ✅ Lossy |
| DSD, MQA, Opus, WMA | ❌ Non supportés |

Affichage du format dans l'UI :
- Lossless → `24-bit / 192 kHz`
- Lossy → `320 kbps`

---

## Audio bit-perfect & DAC externe

Pour la **lecture audiophile** :
- Connecte ton DAC en USB.
- Va dans **Audio Output** (icône en bas à droite) → sélectionne ton DAC.
- Active **Hog Mode** pour l'accès exclusif au DAC (interdit à toute autre app de jouer du son en même temps — le seul moyen de garantir le bit-perfect).
- Hean négocie automatiquement le sample rate du fichier (44.1 / 48 / 88.2 / 96 / 192 kHz) avec le DAC.

> **Hog Mode est désactivé** automatiquement avec AirPlay / Bluetooth (incompatible).

---

## Raccourcis clavier

| Raccourci | Action |
|-----------|--------|
| `Espace` | Play / Pause |
| `→` / `←` | Track suivante / précédente |
| `↑` / `↓` | Volume +/- |
| `Cmd+F` | Recherche |
| `Cmd+Q` | Quitter Hean |
| Touches multimédia | Play/Pause/Next/Prev (interceptées même si Apple Music tourne) |

> Les raccourcis sont configurables dans **Réglages → Raccourcis**.

---

## Mises à jour automatiques

Hean vérifie les nouvelles versions au démarrage (5s après le launch). Quand une nouvelle beta est dispo, une notification apparaît — clique **Update** et l'app redémarre sur la nouvelle version.

> Tu peux désactiver les checks dans **Réglages → Mises à jour**.

---

## Comment reporter un bug

**Le plus rapide** : bouton **Feedback** flottant en bas à droite de la fenêtre.
- Choisis **Bug**, donne un titre, décris ce qui s'est passé.
- **Coche "Attach recent logs"** (par défaut) — ça inclut les ~200 derniers Ko de logs, énorme aide pour diagnostiquer.
- Optionnel : ton email si tu veux que je revienne vers toi.

Ce que je vois côté serveur :
- Ta description + logs joints
- Version de l'app, taille de la library, vue active, état de lecture
- **Aucune** info personnelle (pas de noms de fichiers anonymisés, pas d'identifiant utilisateur)

> Si tu préfères GitHub : ouvre une issue sur [thomasdugue/noir-feedback](https://github.com/thomasdugue/noir-feedback) en utilisant le template **Beta bug report**.

---

## Ce que je cherche à valider pendant cette beta

1. **Stabilité** — l'app tient-elle plusieurs heures sans crash ? Sans memory leak ?
2. **Bit-perfect** — ton DAC est-il correctement détecté ? Le sample rate négocié est-il le bon ? (à comparer avec un DAP ou un autre player audiophile)
3. **NAS / SMB** — la connexion est-elle stable ? La lecture sans glitch même sur un fichier 24/192 ?
4. **Onboarding** — la prise en main est-elle fluide ou tu te perds quelque part ?
5. **Performance** — sur une grosse library (>10k tracks), l'UI reste-t-elle réactive ?

---

## Limitations connues

Voir [BETA_KNOWN_ISSUES.md](BETA_KNOWN_ISSUES.md) pour la liste complète.

En résumé :
- macOS uniquement (pas de Windows/Linux pour l'instant)
- Pas de scrobbling Last.fm / Roon / etc.
- Pas de sync vers DAP (la feature a été archivée pour la beta — voir le [rapport d'archive](archive/dap-sync/))
- Quelques bugs cosmétiques sur le drag & drop dans la homepage

---

## Privacy & rapports d'erreurs

Pour pouvoir débugger efficacement la beta, Hean envoie automatiquement des **rapports d'erreurs anonymisés** à Sentry quand l'app crash ou qu'une exception inattendue se produit.

### Ce qui est envoyé

- Stack traces du code (Rust et JS)
- Version de Hean, version macOS, architecture (Apple Silicon / Intel)
- Heure de l'erreur, fuseau horaire

### Ce qui N'EST PAS envoyé

- ❌ Ton adresse IP (Sentry est configuré pour ne pas la stocker)
- ❌ Le contenu de ta library (titres, artistes, fichiers)
- ❌ Les chemins vers tes fichiers (`/Users/<toi>/...` est remplacé par `<HOME>/...` avant envoi)
- ❌ Tes credentials NAS / Keychain
- ❌ Tout texte que tu as tapé dans l'app

### Désactiver les rapports d'erreurs

**Settings → Privacy → Send error reports** : toggle OFF.

L'effet est immédiat — plus aucun event ne part dès que tu décoches. Si Hean était déjà en train d'envoyer un crash au moment du toggle, il est jeté avant le réseau.

### Demande de suppression de données

Écris à **contact@hean.app** avec ta version de Hean et la période concernée — je supprime les events Sentry correspondants. Sous RGPD, j'ai 30 jours pour traiter la demande, en pratique ça prend quelques minutes.

---

## Données stockées sur ta machine

Tout est dans `~/Library/Application Support/noir/` :

| Fichier | Contenu |
|---------|---------|
| `tracks_cache.json` | Métadonnées de tes tracks |
| `playlists.json` | Tes playlists |
| `config.json` | Préférences (chemins library, EQ, device audio) |
| `network_sources.json` | Configs NAS (sans password — ça c'est dans le Keychain macOS) |
| `thumbnails/`, `covers/` | Pochettes |
| `logs/` | Logs de l'app (rotation journalière, 7 jours conservés) |
| `feedback/` | Tes feedbacks soumis (backup local) |

Si tu veux **tout reset** : ferme Hean → supprime ce dossier → relance Hean → l'onboarding repart de zéro.

---

## Désinstallation

1. Quitte Hean (`Cmd+Q`).
2. Drag **Hean.app** depuis Applications vers la corbeille.
3. Optionnel : supprime `~/Library/Application Support/noir/` pour purger les caches et settings.

---

Merci encore. N'hésite pas à m'envoyer du feedback même sur des trucs "mineurs" — c'est souvent là qu'il y a les meilleures pistes.

— Thomas
