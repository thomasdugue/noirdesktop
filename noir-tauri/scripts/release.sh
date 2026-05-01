#!/usr/bin/env bash
#
# release.sh — Build release signé + notarisé pour Hean
#
# Usage : ./scripts/release.sh
#
# Source automatiquement scripts/.env.local et valide que TOUTES les variables
# requises sont définies avant de lancer le build. Sans ça, `option_env!`
# retourne None silencieusement et le binaire produit n'a ni DSN Sentry ni
# token feedback — fail silent insidieux.

set -euo pipefail

# Couleurs pour les messages
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# === 1. Vérifier le répertoire ===
if [[ ! -f "package.json" ]] || [[ ! -d "src-tauri" ]]; then
  echo -e "${RED}❌ Lance ce script depuis noir-tauri/ (pas depuis ${PWD}).${NC}"
  exit 1
fi

# === 2. Sourcer .env.local ===
if [[ -f "scripts/.env.local" ]]; then
  echo -e "${GREEN}✓ Sourcing scripts/.env.local${NC}"
  set -a  # auto-export
  # shellcheck disable=SC1091
  source scripts/.env.local
  set +a
else
  echo -e "${YELLOW}⚠ scripts/.env.local manquant — les vars doivent être déjà dans l'env${NC}"
fi

# === 3. Variables requises ===
REQUIRED_VARS=(
  "HEAN_SENTRY_DSN"
  "APPLE_ID"
  "APPLE_PASSWORD"
  "APPLE_TEAM_ID"
  "APPLE_SIGNING_IDENTITY"
  "TAURI_SIGNING_PRIVATE_KEY"
)

# Optionnel : password de la clé Tauri (si chiffrée).
# NOIR_WORKER_URL/SECRET : sans eux, le feedback in-app est sauvé localement
# seulement (~/.local/share/noir/feedback/) et n'est PAS envoyé au worker
# Cloudflare → GitHub Issues. Voir scripts/cloudflare-worker.js pour le déploiement.
OPTIONAL_VARS=(
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
  "NOIR_WORKER_URL"
  "NOIR_WORKER_SECRET"
)

missing=()
for var in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    missing+=("$var")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo -e "${RED}❌ Variables manquantes :${NC}"
  printf '   - %s\n' "${missing[@]}"
  echo
  echo "Définis-les dans scripts/.env.local ou exporte-les avant le build."
  echo "Voir docs/BETA_LAUNCH_GUIDE.md pour les détails."
  exit 1
fi

echo -e "${GREEN}✓ Toutes les variables requises sont définies${NC}"
for var in "${OPTIONAL_VARS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    echo -e "  ${YELLOW}⚠ $var (optionnel) non défini${NC}"
  fi
done

# === 4. Vérifier le certificat Apple ===
if ! security find-identity -v -p codesigning | grep -q "$APPLE_SIGNING_IDENTITY"; then
  echo -e "${RED}❌ Certificat introuvable dans le Keychain :${NC}"
  echo "   $APPLE_SIGNING_IDENTITY"
  echo
  echo "Vérifie : security find-identity -v -p codesigning"
  exit 1
fi
echo -e "${GREEN}✓ Certificat trouvé : $APPLE_SIGNING_IDENTITY${NC}"

# === 5. Tests pré-release ===
echo
echo "=== Tests pré-release ==="

echo -e "${GREEN}→ cargo check${NC}"
(cd src-tauri && cargo check 2>&1 | tail -3)

echo -e "${GREEN}→ cargo test${NC}"
(cd src-tauri && cargo test --lib 2>&1 | tail -10)

echo -e "${GREEN}→ JS syntax check${NC}"
for f in src/*.js; do
  node --check "$f" || { echo -e "${RED}❌ Syntax error in $f${NC}"; exit 1; }
done
echo "  All JS files OK"

# === 6. Build ===
echo
echo "=== Build release ==="
echo -e "${YELLOW}⏱  Compte 5-15 min pour le build + notarisation${NC}"
echo

npm run tauri build

# === 7. Vérifications post-build ===
echo
echo "=== Vérifications ==="

APP_PATH="src-tauri/target/release/bundle/macos/Hean.app"
DMG_PATH=$(ls -t src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1 || echo "")

if [[ ! -d "$APP_PATH" ]]; then
  echo -e "${RED}❌ Hean.app introuvable à $APP_PATH${NC}"
  exit 1
fi

echo -e "${GREEN}→ codesign verification${NC}"
if codesign -vvv --deep --strict "$APP_PATH" 2>&1 | tail -5; then
  echo -e "${GREEN}  ✓ Signature OK${NC}"
else
  echo -e "${RED}  ❌ Signature invalide${NC}"
  exit 1
fi

echo -e "${GREEN}→ Gatekeeper / notarization${NC}"
if spctl -a -vvv "$APP_PATH" 2>&1 | grep -q "Notarized Developer ID"; then
  echo -e "${GREEN}  ✓ Notarisé${NC}"
else
  echo -e "${YELLOW}  ⚠ Pas (encore?) notarisé — vérifie :${NC}"
  spctl -a -vvv "$APP_PATH" 2>&1 | tail -5 || true
fi

# === 8. Résumé ===
echo
echo "=== Artifacts produits ==="
echo -e "${GREEN}App :${NC} $APP_PATH"
[[ -n "$DMG_PATH" ]] && echo -e "${GREEN}DMG :${NC} $DMG_PATH"

UPDATER_TGZ=$(ls src-tauri/target/release/bundle/macos/*.app.tar.gz 2>/dev/null | head -1 || echo "")
UPDATER_SIG=$(ls src-tauri/target/release/bundle/macos/*.app.tar.gz.sig 2>/dev/null | head -1 || echo "")
[[ -n "$UPDATER_TGZ" ]] && echo -e "${GREEN}Updater bundle :${NC} $UPDATER_TGZ"
[[ -n "$UPDATER_SIG" ]] && echo -e "${GREEN}Updater signature :${NC} $UPDATER_SIG"

echo
echo -e "${GREEN}✓ Build prêt à publier sur GitHub Releases${NC}"
echo
echo "Prochaine étape :"
echo "  gh release create v\$(node -p \"require('./package.json').version\") \\"
echo "    --prerelease \\"
echo "    --notes-file ../docs/RELEASE_NOTES_v0.2.0-beta.1.md \\"
echo "    \"$DMG_PATH\" \"$UPDATER_TGZ\" \"$UPDATER_SIG\" /tmp/latest.json"
