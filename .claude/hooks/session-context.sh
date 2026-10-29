#!/usr/bin/env bash
# Hook SessionStart — donne à Claude l'état du workspace dès le début de
# session : branche, avance sur main, fichiers modifiés, secrets présents ou non.
# Remplace la lecture manuelle du début du « Protocole de session ».

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" || exit 0

branch=$(git branch --show-current)
ahead=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo "?")
behind=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo "?")
dirty=$(git status --porcelain | wc -l | tr -d ' ')

echo "État du workspace Hean :"
echo "- Branche : $branch ($ahead commit(s) d'avance sur origin/main, $behind de retard)"
echo "- Fichiers modifiés non commités : $dirty"
if [ -f noir-tauri/scripts/.env.local ]; then
  echo "- Secrets : scripts/.env.local présent → ./scripts/dev.sh utilisable"
else
  echo "- Secrets : scripts/.env.local ABSENT dans ce workspace → ./scripts/dev.sh refusera de démarrer ; lancer l'app avec 'npm run tauri dev' (sans Sentry ni feedback) ou demander à Thomas de copier le fichier"
fi
[ -d noir-tauri/node_modules ] || echo "- noir-tauri/node_modules absent → npm ci nécessaire avant Jest / tauri dev"
echo "Rappel protocole : lancer l'agent test-runner avant de modifier du code."
exit 0
