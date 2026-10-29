#!/usr/bin/env bash
# Hook PreToolUse — empêche Claude de lire, modifier ou afficher les secrets
# de signature et de compilation (scripts/.env.local, clés minisign *.key,
# ~/.tauri/). `source scripts/.env.local` reste autorisé : c'est ainsi que
# dev.sh / release.sh chargent les variables sans les afficher.

input=$(cat)
tool=$(printf '%s' "$input" | jq -r '.tool_name // ""')

deny() {
  jq -n --arg r "$1" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
  exit 0
}

is_secret_path() {
  case "$1" in
    *.env.local|*/.env.local.*|*.key|*/.tauri/*) return 0 ;;
  esac
  return 1
}

case "$tool" in
  Edit|Write|Read|NotebookEdit)
    path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""')
    if is_secret_path "$path"; then
      deny "Fichier de secrets protégé ($path) : ni lecture ni écriture par Claude. Pour vérifier qu'une variable existe sans l'afficher : set -a; source scripts/.env.local; set +a; [ -n \"\$NOM_VAR\" ] && echo présente. Pour la modifier, Thomas le fait lui-même."
    fi
    ;;
  Bash)
    cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')
    if printf '%s' "$cmd" | grep -Eq '\.env\.local|\.tauri/|hean\.key'; then
      # Toute commande qui affiche, copie, déplace, supprime ou réécrit le fichier
      if printf '%s' "$cmd" | grep -Eq '(^|[^0-9&])>|\btee\b|\brm\b|\bmv\b|\bcp\b|\bsed\b|\bcat\b|\bhead\b|\btail\b|\bless\b|\bmore\b|\bgrep\b|\bawk\b|\bxxd\b|\bstrings\b|\bbase64\b|\bopen\b|\bchmod\b'; then
        deny "Commande refusée : elle afficherait ou modifierait un fichier de secrets (.env.local / clé de signature). Autorisé : set -a; source scripts/.env.local; set +a puis tester les variables avec [ -n \"\$NOM_VAR\" ], sans jamais les afficher."
      fi
    fi
    ;;
esac
exit 0
