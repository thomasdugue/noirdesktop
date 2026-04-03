# Guide de lancement beta — Hean Desktop

4 etapes manuelles a completer avant la distribution de la beta.

---

## 1. Code signing + notarisation macOS

### Prerequis
- Compte Apple Developer ($99/an) : https://developer.apple.com/programs/
- Xcode installe (pour `codesign`, `xcrun notarytool`)

### Etape 1 : Creer un certificat
1. Aller sur https://developer.apple.com/account/resources/certificates/list
2. Creer un certificat **Developer ID Application** (pour distribution hors App Store)
3. Telecharger le `.cer` et double-cliquer pour l'importer dans Keychain Access
4. Verifier : `security find-identity -v -p codesigning` — le certificat doit apparaitre

### Etape 2 : Configurer Tauri
Ajouter dans `noir-tauri/src-tauri/tauri.conf.json`, dans le bloc `"bundle"` :

```json
"bundle": {
  "active": true,
  "targets": "all",
  "macOS": {
    "signing": {
      "identity": "Developer ID Application: Thomas Dugue (984A3Q922B)"
    }
  },
  "icon": [...]
}
```

Remplacer `TEAM_ID` par ton Team ID Apple (visible sur https://developer.apple.com/account#MembershipDetailsCard).

### Etape 3 : Variables d'environnement pour la notarisation
```bash
export APPLE_ID="thomas.dugue@gmail.com"
export APPLE_PASSWORD="hinu-lcaw-jjty-gdxm"   # App-specific password
export APPLE_TEAM_ID="984A3Q922B"
```

Pour generer un App-Specific Password : https://appleid.apple.com/account/manage → Security → App-Specific Passwords.

### Etape 4 : Build signe + notarise
```bash
cd noir-tauri
APPLE_SIGNING_IDENTITY="Developer ID Application: Thomas Dugue (984A3Q922B)" \
  npm run tauri build
```

Tauri v2 gere automatiquement la signature et la notarisation si les variables sont definies.

### Etape 5 : Verifier
```bash
# Verifier la signature
codesign -vvv --deep --strict src-tauri/target/release/bundle/macos/Hean.app

# Verifier la notarisation
spctl -a -vvv src-tauri/target/release/bundle/macos/Hean.app
# Doit afficher : "source=Notarized Developer ID"
```

### Problemes courants
- **"Hean.app is damaged"** → la notarisation a echoue ou n'a pas ete faite
- **"developer cannot be verified"** → pas signe avec Developer ID Application
- Si `spctl` echoue, verifier les logs : `xcrun notarytool log <submission-id> --apple-id $APPLE_ID --password $APPLE_PASSWORD --team-id $APPLE_TEAM_ID`

---

## 2. Integration Sentry

### Etape 1 : Creer un projet Sentry
1. Creer un compte sur https://sentry.io
2. Creer un projet : Platform = **Rust**, nom = `hean-desktop`
3. Copier le **DSN** (format : `https://f37fb9ee81493aa3d37f5895cba7d69f@o4511016013463552.ingest.de.sentry.io/4511065962381392`)

### Etape 2 : Ajouter la dependance
```bash
cd noir-tauri/src-tauri
cargo add sentry --features "backtrace,contexts,panic,debug-images"
```

### Etape 3 : Initialiser dans lib.rs
Dans `noir-tauri/src-tauri/src/lib.rs`, ajouter **avant** `AudioEngine::new()` dans le bloc `setup()` (vers la ligne 4733) :

```rust
// Sentry error tracking (release builds only)
let _sentry_guard = sentry::init((
    option_env!("HEAN_SENTRY_DSN").unwrap_or(""),
    sentry::ClientOptions {
        release: Some(env!("CARGO_PKG_VERSION").into()),
        environment: Some("beta".into()),
        ..Default::default()
    },
));
```

**Important** : `_sentry_guard` doit rester en scope pour toute la duree de l'app. Le placer au debut du `setup()` garantit cela.

### Etape 4 : Injecter le DSN au build
```bash
HEAN_SENTRY_DSN="https://f37fb9ee81493aa3d37f5895cba7d69f@o4511016013463552.ingest.de.sentry.io/4511065962381392" npm run tauri build
```

Ou dans `scripts/.env.local` :
```
HEAN_SENTRY_DSN=https://f37fb9ee81493aa3d37f5895cba7d69f@o4511016013463552.ingest.de.sentry.io/4511065962381392
```

### Etape 5 : Verifier
1. Builder en release : `HEAN_SENTRY_DSN="..." cargo build --release`
2. Lancer l'app
3. Provoquer une erreur (ex: debrancher un DAP pendant la sync)
4. Verifier sur https://sentry.io que l'evenement apparait

### Note
Sans DSN (dev local), `sentry::init("")` est un no-op — aucun impact sur les perfs.

---

## 3. Test E2E auto-updater

### Prerequis
- Code signing configure (etape 1)
- Cle de signature Tauri updater (deja generee — la pubkey est dans `tauri.conf.json`)

### Probleme a corriger d'abord
L'endpoint dans `tauri.conf.json` pointe vers un mauvais repo :
```
https://github.com/tdugue/noir-desktop/releases/...
```
Il faut le corriger vers le vrai repo :
```
https://github.com/thomasdugue/noirdesktop/releases/latest/download/latest.json
```

### Etape 1 : Generer la cle privee (si pas deja fait)
```bash
npx @tauri-apps/cli signer generate -w ~/.tauri/hean.key
```
Cela genere une paire cle privee/publique. La cle publique doit correspondre a celle dans `tauri.conf.json` (`plugins.updater.pubkey`).

Sauvegarder la cle privee en lieu sur — elle sera necessaire pour signer chaque release.

### Etape 2 : Creer la release v0.2.0-beta.1
```bash
cd noir-tauri

# Build signe pour distribution
TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/hean.key) \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
  npm run tauri build

# Les artefacts sont dans src-tauri/target/release/bundle/
# Le fichier .tar.gz.sig contient la signature pour l'updater
```

### Etape 3 : Publier sur GitHub
```bash
# Creer le fichier latest.json
cat > /tmp/latest.json << 'EOF'
{
  "version": "0.2.0-beta.1",
  "notes": "First beta release",
  "pub_date": "2026-03-17T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<contenu du fichier .tar.gz.sig>",
      "url": "https://github.com/thomasdugue/noirdesktop/releases/download/v0.2.0-beta.1/Hean.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "<contenu du fichier .tar.gz.sig>",
      "url": "https://github.com/thomasdugue/noirdesktop/releases/download/v0.2.0-beta.1/Hean.app.tar.gz"
    }
  }
}
EOF

# Creer la release GitHub
gh release create v0.2.0-beta.1 \
  --title "v0.2.0-beta.1" \
  --notes "First beta release" \
  --prerelease \
  src-tauri/target/release/bundle/macos/Hean.app.tar.gz \
  src-tauri/target/release/bundle/macos/Hean.app.tar.gz.sig \
  /tmp/latest.json
```

### Etape 4 : Creer la release v0.2.0-beta.2 (pour tester la mise a jour)
1. Changer la version dans les 3 fichiers : `0.2.0-beta.1` → `0.2.0-beta.2`
2. Rebuilder et republier (memes commandes, tag `v0.2.0-beta.2`)
3. Mettre a jour `latest.json` avec la nouvelle version

### Etape 5 : Tester
1. Installer `v0.2.0-beta.1` manuellement
2. Lancer l'app — elle doit detecter `v0.2.0-beta.2` apres 5 secondes
3. Cliquer "Update" → l'app telecharge, installe, et relance
4. Verifier que la version affichee est `0.2.0-beta.2`

### Problemes courants
- **"Signature verification failed"** → la pubkey dans `tauri.conf.json` ne correspond pas a la cle privee utilisee pour signer
- **Pas de notification de mise a jour** → verifier que `latest.json` est accessible a l'URL configuree (`curl` pour tester)
- **"Network error"** → le repo doit etre public ou le token GitHub doit avoir les droits

---

## 4. Test E2E feedback token

### Etat actuel
Le mecanisme est deja implemente dans `lib.rs` :
- `option_env!("NOIR_GITHUB_FEEDBACK_TOKEN")` injecte le token au compile-time
- Sans token → feedback sauve localement dans `~/.config/hean/feedback/`
- Avec token → cree aussi une GitHub Issue dans `thomasdugue/noir-feedback`

### Etape 1 : Verifier le token
Le token doit avoir le scope `repo` (ou `public_repo` si le repo feedback est public).

```bash
# Tester le token manuellement
curl -H "Authorization: token $NOIR_GITHUB_FEEDBACK_TOKEN" \
  https://api.github.com/repos/thomasdugue/noir-feedback
# Doit retourner les infos du repo, pas un 404
```

### Etape 2 : Build release avec le token
```bash
cd noir-tauri

# Sourcer les variables d'env
source scripts/.env.local

# Verifier que le token est defini
echo $NOIR_GITHUB_FEEDBACK_TOKEN  # ne doit PAS etre vide

# Build
npm run tauri build
```

**Piege** : le token est injecte par `option_env!()` a la **compilation**, pas au runtime. Un `cargo build --release` sans la variable = binaire sans token.

### Etape 3 : Tester le flux complet
1. Lancer le build release : `./src-tauri/target/release/Hean`
2. Cliquer le bouton Feedback (en bas a droite)
3. Remplir : type "Bug", titre "Test beta feedback", description quelconque
4. Soumettre

### Etape 4 : Verifier
- **Cote local** : `ls ~/.config/hean/feedback/` — un fichier JSON doit exister
- **Cote GitHub** : https://github.com/thomasdugue/noir-feedback/issues — une issue doit apparaitre avec les labels `beta` + `bug`

### Etape 5 : Tester le fallback (sans token)
```bash
# Build sans token
unset NOIR_GITHUB_FEEDBACK_TOKEN
cargo build --release

# Lancer et soumettre un feedback
# → doit se sauver localement sans erreur visible
# → pas d'issue GitHub creee
```

---

## Ordre recommande

```
1. Code signing    ← bloquant pour tout le reste (distribution)
2. Feedback token  ← rapide, juste un build avec la variable
3. Auto-updater    ← necessite 2 releases signees
4. Sentry          ← peut etre ajoute apres le lancement beta
```

## Checklist finale

- [ ] Certificat Developer ID Application installe
- [ ] `tauri.conf.json` configure avec l'identite de signature
- [ ] Build signe et notarise avec succes
- [ ] Endpoint updater corrige (`thomasdugue/noirdesktop`)
- [ ] Release v0.2.0-beta.1 publiee sur GitHub
- [ ] Release v0.2.0-beta.2 publiee + mise a jour testee
- [ ] Build release avec `NOIR_GITHUB_FEEDBACK_TOKEN` — issue GitHub creee
- [ ] Build release sans token — fallback local fonctionne
- [ ] Sentry DSN configure et premier evenement recu
