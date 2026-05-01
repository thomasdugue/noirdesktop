#!/usr/bin/env bash
#
# dev.sh — Lance Hean en dev avec les env vars de .env.local injectées
#
# Usage : ./scripts/dev.sh
#
# Sans ce wrapper, npm run tauri dev ne voit pas HEAN_SENTRY_DSN ni les autres
# vars compile-time, et le binaire produit n'a pas Sentry.

set -e

cd "$(dirname "$0")/.."

if [[ ! -f "scripts/.env.local" ]]; then
  echo "❌ scripts/.env.local introuvable"
  exit 1
fi

# Exporte automatiquement toutes les vars du fichier dans l'env
set -a
# shellcheck disable=SC1091
source scripts/.env.local
set +a

# Confirme visuellement que le DSN est bien chargé
if [[ -n "${HEAN_SENTRY_DSN:-}" ]]; then
  echo "✓ Sentry DSN chargé : ${HEAN_SENTRY_DSN:0:60}…"
else
  echo "⚠ HEAN_SENTRY_DSN non défini dans .env.local"
fi

# Installe les dépendances npm si elles manquent (cas worktree fraîche)
if [[ ! -d "node_modules" ]] || [[ ! -x "node_modules/.bin/tauri" ]]; then
  echo "→ node_modules manquant — npm install (peut prendre 1-2 min)…"
  npm install
fi

echo "→ Lancement de Hean en mode dev (recompile Rust si nécessaire)…"
echo

npm run tauri dev
