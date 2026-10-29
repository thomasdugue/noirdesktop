#!/usr/bin/env bash
# Hook PostToolUse — après chaque modification d'un fichier JS du frontend,
# vérifie sa syntaxe avec node --check (pas de bundler ni de linter dans Hean :
# c'est la seule analyse statique JS). En cas d'erreur, Claude la reçoit et
# doit corriger avant de continuer.

path=$(jq -r '.tool_response.filePath // .tool_input.file_path // ""')
case "$path" in
  */noir-tauri/src/*.js) ;;
  *) exit 0 ;;
esac
[ -f "$path" ] || exit 0

if ! out=$(node --check "$path" 2>&1); then
  echo "Erreur de syntaxe JS dans $path (node --check) — corrige-la avant de continuer :" >&2
  echo "$out" | head -15 >&2
  exit 2
fi
exit 0
