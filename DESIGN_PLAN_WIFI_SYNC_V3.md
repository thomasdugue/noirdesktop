# Design Plan — WiFi Sync v3 (déplacement vers App Sync)

## Le problème en une phrase

WiFi Sync est planqué dans Settings, sans contexte ; les utilisateurs ne savent pas par où commencer, et MTP/Mass Storage vont disparaître. Il faut faire de WiFi Sync **le citoyen de première classe** de l'onglet App Sync, avec un onboarding qui élimine toutes les frictions du premier contact.

## Vision

**App Sync devient WiFi-only.** L'utilisateur clique App Sync dans le sidebar → si serveur OFF, voit un écran "comment ça marche" hyper clair → toggle ON → tutoriel + QR + IP → "Continuer" → écran de sélection d'albums (qui existe déjà). Plus jamais besoin d'ouvrir Settings pour une opération de sync.

---

## Architecture de navigation

### Avant
```
Settings → Devices → WiFi Sync toggle → onboarding card minuscule
App Sync sidebar → Albums view (suppose qu'un device est déjà configuré)
```

### Après
```
App Sync sidebar (tab principal)
  ├── État OFF (default) → Écran "Welcome" (toggle + bénéfices)
  ├── État ON, première fois → Tutoriel onboarding (QR + IP + warnings + Continue)
  ├── État ON, dismissed → Écran de sélection d'albums (l'existant)
  └── Header persistant : status pill (vert = "Server running on 192.168.x.y") + bouton Settings WiFi
```

Settings → Devices : on **garde** une entrée minimale "WiFi Sync server" mais elle ne fait que rediriger vers App Sync ("Manage in App Sync →"). Pas de duplication d'UI.

---

## Sub-views à ajouter dans `dap-sync.js`

Le module a déjà : `setup | albums | syncing | complete | disconnected | settings | first-sync`. On en ajoute deux :

| Nouvelle sub-view | Quand | Contenu |
|---|---|---|
| `wifi-welcome` | Serveur OFF, première visite App Sync | Hero "Sync over WiFi" + 3 bénéfices + gros toggle |
| `wifi-tutorial` | Serveur ON, `localStorage.wifi_tutorial_dismissed !== 'true'` | QR + IP + warnings + checkbox "Don't show again" + Continue |

`albums` reste l'écran principal post-onboarding. `setup` (l'écran Connect your DAP / Insert SD card) **disparaît** quand on supprime MTP/Mass Storage — on le remplacera à terme par `wifi-welcome` comme default.

---

## Wireframe — Écran 1 : `wifi-welcome` (serveur OFF)

```
┌─────────────────────────────────────────────────────────────┐
│  [App Sync sidebar item ACTIVE]                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                                                       │  │
│  │             ◢◣  (icône WiFi animée 96px)              │  │
│  │                                                       │  │
│  │           Sync your music over WiFi                   │  │
│  │                                                       │  │
│  │     Send albums to any DAP on your network            │  │
│  │     without cables, MTP drivers, or SD cards.         │  │
│  │                                                       │  │
│  │  ┌───────┐  ┌───────┐  ┌───────┐                      │  │
│  │  │  📱   │  │  ⚡   │  │  🔒   │                      │  │
│  │  │ Any   │  │ Fast  │  │ Local │                      │  │
│  │  │ DAP   │  │ ~5 MB/s│  │ only  │                      │  │
│  │  └───────┘  └───────┘  └───────┘                      │  │
│  │                                                       │  │
│  │       ┌──────────────────────────────┐                │  │
│  │       │  [⬤  ] Start the server      │                │  │
│  │       └──────────────────────────────┘                │  │
│  │                                                       │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Tone of voice :** affirmatif, court, confiant. Pas de "Welcome to WiFi Sync, the new way to..." Direct : *Sync your music over WiFi*.

**Toggle :** un seul gros bouton (pas une checkbox planquée). Quand cliqué → `start_wifi_sync_server` → transition vers `wifi-tutorial`.

**Pas de champ "destination folder"** ici — il vit dans le tutoriel ou dans le header une fois en mode actif. Zéro friction au premier clic.

---

## Wireframe — Écran 2 : `wifi-tutorial` (serveur ON, première fois)

```
┌─────────────────────────────────────────────────────────────┐
│  [● Server running]   192.168.1.42:8443    [⚙ WiFi Settings]│
│  ┌───────────────────────────────────────────────────────┐  │
│  │                                                       │  │
│  │   Open this on your DAP browser:                      │  │
│  │                                                       │  │
│  │   ┌─────────────────────────────────────────────┐     │  │
│  │   │                                             │     │  │
│  │   │      https://192.168.1.42:8443/             │     │  │
│  │   │                                             │     │  │
│  │   │              [📋 Copy address]              │     │  │
│  │   └─────────────────────────────────────────────┘     │  │
│  │                                                       │  │
│  │   ┌─────────────────┐    1. Open the address above    │  │
│  │   │                 │       in your DAP's browser     │  │
│  │   │   ███ ██  ███   │                                 │  │
│  │   │   █ █ ██  █ █   │    2. Your DAP will warn you    │  │
│  │   │   ███ ██  ███   │       "Connection not secure"   │  │
│  │   │     QR 280px    │       — click "Advanced" then   │  │
│  │   │                 │       "Proceed anyway". This is │  │
│  │   │                 │       safe — the server runs    │  │
│  │   └─────────────────┘       only on your local WiFi.  │  │
│  │                                                       │  │
│  │                             3. Pick a destination     │  │
│  │                                folder on your DAP     │  │
│  │                                                       │  │
│  │                             4. Choose albums to sync  │  │
│  │                                                       │  │
│  │   ┌──────────────────────────────────────────────┐    │  │
│  │   │ ☐ Don't show this tutorial again             │    │  │
│  │   └──────────────────────────────────────────────┘    │  │
│  │                                                       │  │
│  │              [ Continue to album selection → ]        │  │
│  │                                                       │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Header persistant** (réutilise le pattern `dap-sync-bar`) :
- À gauche : status pill `● Server running` (vert `#4ade80`) + l'IP en monospace cliquable (copy on click)
- À droite : bouton `⚙ WiFi Settings` qui ouvre un petit popover (rotate token, change folder name, stop server)

**Tutoriel** :
- QR 280×280 (avant 180px — le doublement matérialise l'instruction "scanne ça")
- 4 étapes numérotées en colonne à droite, **avec le warning cert traité comme une étape normale**, pas comme un avertissement effrayant. Phrasé positif : *"Your DAP will warn you... This is safe because..."*
- Checkbox "Don't show this tutorial again" → `localStorage.setItem('wifi_tutorial_dismissed', 'true')`
- Bouton primary `Continue to album selection →` (la flèche rappelle la progression)

**Tailles de police** (réponse à "augmenter la taille des caractères") :
- Hero address: **22px** Geist Mono (avant 14px)
- Étapes 1-4: **15px** DM Sans (avant 11-12px)
- "Open this on your DAP browser:": **14px** muted
- Checkbox label: **13px**

---

## Wireframe — Écran 3 : `albums` post-tutoriel (existant, header retravaillé)

```
┌─────────────────────────────────────────────────────────────┐
│  [● Running]  192.168.1.42:8443  📁 HEAN  [↻ Restart] [⚙]   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  ▼ Server details (collapsible)                       │  │
│  │     Connected DAPs: 1   Last sync: 2 min ago          │  │
│  │     Throughput: ↓ 4.2 MB/s   Token: a1b2…             │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │  [Albums] [Artists] [Tracks]    [🔍 search]    [↕ A-Z]│  │
│  │  ┌───┐ ☐ Album 1  ─ Artist 1   24/192 FLAC  [+ to add]│  │
│  │  ┌───┐ ☑ Album 2  ─ Artist 2   16/44 MP3   [✓ on DAP]│  │
│  │  ...                                                  │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

Le header reprend le pattern `dap-dest-details` (déjà collapsible) mais le contenu change : au lieu de "Storage 14/64 GB" on a "IP / Folder / Token / Throughput / Connected DAPs". Réutilisation maximale des composants existants.

---

## Réponses aux feedbacks QA inline

### "Rotate access token" incompréhensible
**Renommer en :** `Reset access code` (mot "code" = compréhensible, "rotate" = jargon crypto). 

**Tooltip :** *"Generate a new access code. Open WebUI tabs on your DAP will need to be rescanned. Use this if you suspect someone else got access to the QR."*

Le bouton vit dans le popover **WiFi Settings** (icône ⚙ du header), pas en première page. C'est une opération rare, elle n'a rien à faire à côté du QR principal.

### "0 min left" alors que le téléchargement continue
**Cause** : ETA calculé à partir d'un throughput instantané qui descend à 0 entre deux fichiers, ou tout au début quand le buffer est vide.

**Fix design** :
- Tant que `bytes_copied / total_bytes < 0.05` ou `throughput < 100 KB/s` : afficher *"Starting…"* au lieu d'un ETA
- Sinon : afficher l'ETA avec un lissage sur 5 secondes (`exponential moving average`)
- Si `eta < 5s` : afficher *"Almost done…"* (jamais "0 min left")

**Position** : barre de progression sticky en haut de page pendant la sync (pas dans le panneau collapsible) :

```
┌─────────────────────────────────────────────────────────────┐
│  ↓ Syncing — 142/805 files · 4.2 MB/s · ~3 min remaining    │
│  ████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  18%  │
└─────────────────────────────────────────────────────────────┘
```

### Persistance du dossier de destination
**Cause technique** : le `FileSystemDirectoryHandle` est stocké dans IndexedDB côté **DAP browser**, mais la persistance dépend de la permission accordée. Quand l'utilisateur revient, on doit appeler `handle.requestPermission({ mode: 'readwrite' })` qui peut prompt mais qui retourne `'granted'` immédiatement si la permission est encore valide.

**Fix dans `webui.js`** :
1. Au load : `idb.get('destHandle')` → si présent, `await handle.requestPermission()` → si granted, skip le pick folder, passer direct à l'écran albums
2. Persist également le `rootPrefix` dans `localStorage` côté WebUI
3. Afficher dans le header WebUI : *"📁 [folder name] · [change]"* au lieu de cacher l'info

### "Augmenter la taille des caractères"
Échelle typographique unifiée pour toute la zone WiFi Sync :

| Élément | Avant | Après |
|---|---|---|
| Hero address (mono) | 14px | **22px** |
| Tutorial steps | 11-12px | **15px** |
| Album/artist names | 13px / 11.5px | **14.5px / 12.5px** |
| Status badges | 10px | **11.5px** |
| Tabs | 12.5px | **14px** |
| Throughput indicator | 11px | **13px** |

C'est un app desktop avec beaucoup de whitespace — on peut se permettre +2/+3px partout sans casser la densité.

### Cert warning sur le DAP (T1.2)
**Le warning HTTPS ne peut pas disparaître techniquement** (cert self-signed) — mais on peut le **désamorcer dans le tutoriel**. C'est exactement ce que fait l'étape 2 du wireframe : on prévient l'utilisateur, on explique pourquoi c'est safe, on lui dit quoi cliquer. Pas de surprise = pas d'angoisse.

### T3.3 NOK (rien ne se passe quand serveur stoppé)
Le `pingServer()` retourne `'unreachable'` mais la bannière n'apparaît pas. Bug à fixer dans `webui.js` — vérifier que `showRestartBanner('unreachable')` est bien appelé dans le catch de fetch et que la classe CSS `.banner.unreachable` a `display: block`.

---

## Plan d'implémentation (ordonné, ~2h de travail)

### Étape 1 — Backend (~10 min)
- Aucun changement Rust requis, sauf ajout d'un endpoint `/folder-name` pour set/get le rootPrefix server-side (déjà existant via `set_wifi_sync_root_prefix`)
- Vérifier que `wifi_sync_rotate_token` rename → ajouter alias `wifi_sync_reset_access_code` pour la nouvelle UX (garder l'ancien pour compat)

### Étape 2 — `dap-sync.js` (~45 min)
1. Ajouter `wifi-welcome` et `wifi-tutorial` dans le switch de `displayDapSyncView`
2. Écrire `renderWifiWelcomeView(grid)` — toggle gros, 3 bénéfices, classes `dap-wifi-welcome-*`
3. Écrire `renderWifiTutorialView(grid)` — header persistant, hero address, QR 280px, 4 étapes, checkbox dismiss, bouton continue
4. Modifier `openSyncPanel(dest)` pour router vers `wifi-welcome` si serveur OFF, `wifi-tutorial` si ON et non-dismissed, `albums` sinon
5. Header `dap-sync-bar` enrichi : status pill + IP cliquable + folder name + popover settings
6. Popover `WiFi Settings` : Reset access code (avec confirm + tooltip), Change folder name, Stop server

### Étape 3 — `styles.css` (~20 min)
- Nouveau bloc `/* === WiFi Sync (App Sync tab) === */`
- Classes `dap-wifi-welcome`, `dap-wifi-tutorial`, `dap-wifi-hero-address`, `dap-wifi-step`, `dap-wifi-popover`
- Augmenter les `font-size` listés dans le tableau ci-dessus
- Animation fade-in sur la transition welcome → tutorial → albums

### Étape 4 — `webui.js` côté WebUI DAP (~30 min)
- Persistance handle + permission au load
- Header WebUI avec folder name visible et bouton "change"
- Fix bannière `unreachable` (T3.3)
- Lissage ETA + "Starting…" / "Almost done…" / barre sticky en haut
- Augmenter font-sizes (ce sont des gros doigts sur petit écran DAP — encore plus important)

### Étape 5 — Settings cleanup (~10 min)
- Settings → Devices : remplacer la grosse onboarding card par une ligne minimale "WiFi Sync server: [Manage in App Sync →]"
- Garder le toggle pour les power users qui préfèrent activer depuis Settings, mais le toggle redirige vers App Sync après activation

### Étape 6 — Tests manuels (~5 min)
Re-passer le protocole T1.1 → T4.3 avec les nouveaux écrans.

---

## Ce qu'on garde, ce qu'on jette

**On garde :**
- Tout le backend Rust (token persistant, /ping, IP-based URL, certs)
- Le compute_album_tracks single source of truth
- Le pattern `compute_sync_plan` + sync engine
- Les composants `dap-dest-details` (collapsible) pour le header
- L'écran albums existant (pattern intact)
- IndexedDB côté WebUI

**On jette :**
- L'onboarding card actuelle dans Settings (4 niveaux d'imbrication, tout petit)
- Le sub-view `setup` quand MTP/Mass Storage seront supprimés
- "Rotate access token" comme bouton de premier niveau (descendu dans popover)

**On déplace :**
- La gestion du dossier destination (du tutoriel obligatoire vers le header persistant + persistance auto)
- Le throughput indicator (du panneau collapsible vers la barre sticky pendant sync)

---

## Question pour vous

Une seule décision à prendre avant que je code :

**Est-ce que le toggle `Start the server` dans `wifi-welcome` doit aussi pick automatiquement le folder de destination côté WebUI ?** Deux options :

- **A) Pure :** le toggle démarre le serveur, le tutoriel guide l'utilisateur, le pick folder se fait sur le DAP comme aujourd'hui. (Cohérent, mais 1 étape de plus)
- **B) Smart :** le toggle démarre le serveur **et** ouvre une fenêtre Mac pour pick un dossier de destination par défaut côté Mac (qu'on stockerait en config), que le DAP réutilisera s'il n'a rien. (Plus fluide mais ajoute une feature backend)

Je recommande **A**. C'est le DAP qui télécharge les fichiers, c'est sur le DAP qu'on choisit où ils atterrissent. Mélanger les deux côtés crée de la confusion.

---

## Statut

**DONE_WITH_CONCERNS** — Plan prêt à coder. Une décision A/B ouverte sur le pick folder. Aucun blocker technique. Délai estimé 2h pour l'implémentation complète + 30 min de tests.
