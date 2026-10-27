---
name: hean-release
description: Use when building, signing, notarizing, or shipping a Hean release/beta — orchestrates the BETA_LAUNCH_GUIDE 4 steps (signing + Sentry + auto-updater + feedback token), validates compile-time secrets, runs `npm run tauri build`, verifies signature/notarization, generates the DMG, and publishes the GitHub release with `latest.json`. Trigger on: "ship", "release", "beta launch", "build release", "publish a new version", "update Hean", "push a beta".
---

# hean-release — orchestration build & beta launch

> ⚠️ **Pipeline actuel = section ci-dessous (source de vérité, ex-CLAUDE.md).** Les étapes 0 à 5 plus bas datent d'avant le Cloudflare Worker : `NOIR_GITHUB_FEEDBACK_TOKEN` n'existe plus (le code lit `NOIR_WORKER_URL` + `NOIR_WORKER_SECRET`), et il ne faut **jamais** lancer `npm run tauri build` à nu — passer par `scripts/release.sh`, puis dylibbundler + fix LC_RPATH + notarisation du DMG. En cas de conflit, la section ci-dessous l'emporte.

## Release pipeline — Apple signing + notarisation + updater

**Scripts wrappers** :
- `scripts/dev.sh` : source `.env.local`, vérifie le DSN chargé, relance `npm install` si `node_modules` absent, lance `npm run tauri dev`. Évite le piège `option_env!` silencieux en mode dev.
- `scripts/release.sh` : source `.env.local`, valide les **6 vars requises** (`HEAN_SENTRY_DSN`, `APPLE_*`, `TAURI_SIGNING_PRIVATE_KEY`), vérifie le certificat Apple dans Keychain, run cargo + JS tests, build release. Vérifie codesign + spctl à la fin.

**Pipeline complet (dans l'ordre, 6 étapes)** :
1. `cargo build --release` (LTO, ~5 min) → produit `Hean.app`
2. **Bundle dylibs externes** via `dylibbundler -b -x <bin> -d <Frameworks/> -p @executable_path/../Frameworks/ -cd`. Embarque ~92 dylibs Samba dépendances de `libsmbclient` (sinon l'app crash sur les Macs sans Homebrew).
3. **Fix doublons LC_RPATH** : `dylibbundler` ajoute un rpath à chaque dylib mais certaines en avaient déjà un de Homebrew → doublons → macOS dyld refuse (depuis Big Sur). Boucle `install_name_tool -delete_rpath @executable_path/../Frameworks/` sur les ~66 dylibs concernées.
4. Re-sign chaque dylib + l'app entière avec `--force --sign $APPLE_SIGNING_IDENTITY --options runtime --timestamp`
5. **Notariser l'app** via `xcrun notarytool submit ... --wait` (~2-5 min) puis `xcrun stapler staple`
6. Créer DMG via `hdiutil create -volname "Hean" -format UDZO`, signer le DMG, **notariser le DMG aussi** (sinon Gatekeeper refuse même si l'app à l'intérieur est notarisée), stapler
7. Tarball updater : `tar -czf Hean.app.tar.gz Hean.app` + `tauri signer sign --private-key $TAURI_SIGNING_PRIVATE_KEY --password $TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
8. Publier sur GitHub Releases : DMG, `.app.tar.gz`, `.app.tar.gz.sig`, `latest.json` (le fichier consulté par l'updater)

**Tauri updater** :
- Endpoint : `https://github.com/thomasdugue/noirdesktop/releases/latest/download/latest.json` (typo `tdugue/noir-desktop` corrigée 2026-05-01)
- Pubkey minisign dans `tauri.conf.json` doit matcher la clé privée dans `~/.tauri/hean.key` (regénérée 2026-05-01 sans password — l'ancienne avait un password inconnu)
- Si on régénère la clé : il faut **rebuilder l'app** pour que la nouvelle pubkey soit embarquée, sinon les futurs updates signés seront rejetés par les apps déjà installées

**`.env.local` requis** (`scripts/.env.local`, gitignored) :
```
HEAN_SENTRY_DSN=...
NOIR_WORKER_URL=https://noir-feedback.<sub>.workers.dev
NOIR_WORKER_SECRET=...
APPLE_SIGNING_IDENTITY="Developer ID Application: Thomas Dugué (XXXXXXXXXX)"
APPLE_TEAM_ID=...
APPLE_ID=thomas.dugue@gmail.com
APPLE_PASSWORD=xxxx-xxxx-xxxx-xxxx          # App-Specific Password Apple, pas le mdp Apple ID
TAURI_SIGNING_PRIVATE_KEY=...               # contenu du fichier ~/.tauri/hean.key
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=...      # password de la clé minisign si chiffrée
```

⚠️ **NE JAMAIS commit `.env.local`** (gitignored par `.env*` racine + `*.local` dans `noir-tauri/.gitignore`). Permissions `chmod 600` recommandé.


## Pourquoi ce skill existe

Hean injecte **6 secrets à la compile-time** via `option_env!()`. Une variable absente ou mal nommée → `option_env!()` retourne `None` **silencieusement** : le binaire est livré sans Sentry, sans feedback token, sans signature. Ce skill empêche ce piège.

Référence canonique : `docs/BETA_LAUNCH_GUIDE.md`. Ce skill est le runbook exécutable.

## Prérequis (vérifier avant de lancer)

| Élément | Commande de vérif |
|---|---|
| Cwd = `noir-tauri/` | `pwd \| grep -q noir-tauri$` |
| Cert Developer ID importé | `security find-identity -v -p codesigning \| grep "Developer ID Application"` |
| Clé updater Tauri | `test -f ~/.tauri/hean.key` |
| `gh` authentifié | `gh auth status` |
| Branche propre | `git status --short` (vide) |
| Version bump | vérifier `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `package.json` cohérents |

## Étape 0 — Pré-flight : valider les 6 secrets compile-time

`option_env!()` est silencieux. Toujours valider explicitement.

```bash
cd noir-tauri
set -a; source scripts/.env.local; set +a

required=(
  HEAN_SENTRY_DSN
  NOIR_GITHUB_FEEDBACK_TOKEN
  TAURI_SIGNING_PRIVATE_KEY
  APPLE_ID
  APPLE_PASSWORD
  APPLE_TEAM_ID
  APPLE_SIGNING_IDENTITY
)
missing=()
for v in "${required[@]}"; do
  [ -z "${!v}" ] && missing+=("$v")
done
[ ${#missing[@]} -gt 0 ] && { echo "MISSING: ${missing[*]}"; exit 1; }
echo "All 6 compile-time secrets present."
```

`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` est optionnel (chaîne vide acceptée). Les autres sont obligatoires pour une release distribuée.

**Pièges connus** :
- `NOIR_GITHUB_TOKEN` ≠ `NOIR_GITHUB_FEEDBACK_TOKEN` (le code lit le second).
- Le DSN Sentry ne doit pas être quoté avec des espaces.
- `APPLE_PASSWORD` doit être un **app-specific password** (pas le mot de passe iCloud principal).
- Si `TAURI_SIGNING_PRIVATE_KEY` est passé via `$(cat ~/.tauri/hean.key)` : vérifier que la clé est multiline (PEM-style), pas tronquée.

Sanity-check token feedback :
```bash
curl -sf -H "Authorization: token $NOIR_GITHUB_FEEDBACK_TOKEN" \
  https://api.github.com/repos/thomasdugue/noir-feedback > /dev/null \
  && echo "feedback token OK" || echo "feedback token KO"
```

## Étape 1 — Build signé + notarisé

```bash
cd noir-tauri
APPLE_SIGNING_IDENTITY="$APPLE_SIGNING_IDENTITY" \
HEAN_SENTRY_DSN="$HEAN_SENTRY_DSN" \
NOIR_GITHUB_FEEDBACK_TOKEN="$NOIR_GITHUB_FEEDBACK_TOKEN" \
TAURI_SIGNING_PRIVATE_KEY="$TAURI_SIGNING_PRIVATE_KEY" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
APPLE_ID="$APPLE_ID" APPLE_PASSWORD="$APPLE_PASSWORD" APPLE_TEAM_ID="$APPLE_TEAM_ID" \
  npm run tauri build
```

Tauri v2 fait signature + notarisation auto si toutes les vars Apple sont définies. Compter ~5-15 min (notarisation Apple). Artefacts attendus :
- `src-tauri/target/release/bundle/macos/Hean.app`
- `src-tauri/target/release/bundle/macos/Hean.app.tar.gz` (+ `.sig` pour updater)
- `src-tauri/target/release/bundle/dmg/Hean_<version>_aarch64.dmg`

## Étape 2 — Vérifier signature & notarisation

```bash
APP=src-tauri/target/release/bundle/macos/Hean.app
codesign -vvv --deep --strict "$APP"           # signature valide
spctl -a -vvv "$APP" 2>&1 | grep "Notarized"   # doit afficher "source=Notarized Developer ID"
```

Si `spctl` échoue :
```bash
xcrun notarytool log <submission-id> \
  --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID"
```

Symptômes côté utilisateur sans cette vérif :
- `"Hean.app is damaged"` → notarisation manquée.
- `"developer cannot be verified"` → pas signé Developer ID Application.

## Étape 3 — Générer le DMG branded

```bash
python3 scripts/generate-dmg.py
```

Le script utilise `dmg-window.html` (700×390, glow custom) et place app + raccourci `Applications`. Vérifier la taille (~80-150 Mo selon assets) et que le nom contient bien la version courante.

## Étape 4 — Auto-updater : `latest.json` + GitHub release

**Vérifier d'abord** que `tauri.conf.json` pointe vers le bon repo :
```
https://github.com/thomasdugue/noirdesktop/releases/latest/download/latest.json
```
Pas `tdugue/noir-desktop` (ancien chemin, bug connu du guide).

Construire `latest.json` :
```bash
VERSION=$(jq -r .version package.json)
SIG=$(cat src-tauri/target/release/bundle/macos/Hean.app.tar.gz.sig)
URL="https://github.com/thomasdugue/noirdesktop/releases/download/v${VERSION}/Hean.app.tar.gz"
PUBDATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat > /tmp/latest.json <<EOF
{
  "version": "${VERSION}",
  "notes": "Beta release ${VERSION}",
  "pub_date": "${PUBDATE}",
  "platforms": {
    "darwin-aarch64": { "signature": "${SIG}", "url": "${URL}" },
    "darwin-x86_64":  { "signature": "${SIG}", "url": "${URL}" }
  }
}
EOF
```

Publier (⚠️ **action visible publiquement — confirmer avec l'utilisateur avant d'exécuter**) :
```bash
gh release create "v${VERSION}" \
  --title "v${VERSION}" --notes "Beta release ${VERSION}" --prerelease \
  src-tauri/target/release/bundle/macos/Hean.app.tar.gz \
  src-tauri/target/release/bundle/macos/Hean.app.tar.gz.sig \
  src-tauri/target/release/bundle/dmg/Hean_${VERSION}_aarch64.dmg \
  /tmp/latest.json
```

## Étape 5 — Smoke tests post-publication

1. **DMG** : ouvrir le `.dmg` sur une autre machine, glisser dans Applications, lancer → pas de "damaged".
2. **Sentry** : forcer une erreur (déconnecter un NAS pendant un scan). Vérifier que l'event apparaît sur `hean-desktop` (env `beta`).
3. **Feedback** : envoyer un feedback "Test beta" depuis l'app → issue créée dans `thomasdugue/noir-feedback` avec labels `beta` + `bug`.
4. **Updater** : publier une `v<n+1>` puis lancer `v<n>` installée → doit proposer la mise à jour sous 5s, télécharger, relancer en `v<n+1>`.
5. **Fallback feedback (optionnel)** : rebuild sans `NOIR_GITHUB_FEEDBACK_TOKEN`, vérifier que le feedback est sauvé dans `~/.config/hean/feedback/` sans erreur.

## Checklist finale (à cocher dans la conversation)

- [ ] 6 secrets compile-time validés (étape 0)
- [ ] Build signé + notarisé (étape 1)
- [ ] `codesign -vvv` + `spctl` "Notarized" OK (étape 2)
- [ ] DMG généré + taille cohérente (étape 3)
- [ ] `latest.json` généré avec signature non vide (étape 4)
- [ ] Release GitHub publiée (uniquement après confirmation utilisateur)
- [ ] 4 smoke tests passés (étape 5)

## Quand NE PAS utiliser ce skill

- Build dev local (`npm run tauri dev`) — aucun secret nécessaire.
- `cargo build --release` sans intention de distribution — passer juste les secrets utiles.
- Hotfix sans changement de version — bumper la version d'abord, sinon l'updater ne déclenchera rien.

## Fichiers critiques

- `docs/BETA_LAUNCH_GUIDE.md` — référence narrative complète
- `noir-tauri/scripts/.env.local` — secrets locaux (gitignored)
- `noir-tauri/scripts/generate-dmg.py` — packaging DMG
- `noir-tauri/src-tauri/tauri.conf.json` — `bundle.macOS.signing.identity`, `plugins.updater.endpoints`, `plugins.updater.pubkey`
- `noir-tauri/src-tauri/src/lib.rs` — `option_env!("HEAN_SENTRY_DSN")`, `option_env!("NOIR_GITHUB_FEEDBACK_TOKEN")`
- `noir-tauri/src-tauri/Cargo.toml` — profil release (`opt-level=3`, `lto=true`, `strip=true`)
