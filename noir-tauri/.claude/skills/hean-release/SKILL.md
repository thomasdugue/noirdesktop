---
name: hean-release
description: Use when building, signing, notarizing, or shipping a Hean release/beta — orchestrates the BETA_LAUNCH_GUIDE 4 steps (signing + Sentry + auto-updater + feedback token), validates compile-time secrets, runs `npm run tauri build`, verifies signature/notarization, generates the DMG, and publishes the GitHub release with `latest.json`. Trigger on: "ship", "release", "beta launch", "build release", "publish a new version", "update Hean", "push a beta".
---

# hean-release — orchestration build & beta launch

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
