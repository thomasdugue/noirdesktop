#!/usr/bin/env bash
# Hook Stop — rappel automatique pour enrichir le skill hean-invariants.
# Déclenché quand du code de l'app a changé sur la branche (vs origin/main)
# sans que hean-invariants ait été touché. Une seule fois par ensemble de
# fichiers modifiés, pour ne pas relancer le rappel à chaque réponse.

input=$(cat)
[ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false')" = "true" ] && exit 0

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" || exit 0
base=$(git merge-base HEAD origin/main 2>/dev/null) || exit 0

# Fichiers modifiés : commités + non commités + nouveaux fichiers
changed=$( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } | sort -u )

code=$(printf '%s\n' "$changed" | grep -E '^noir-tauri/(src|src-tauri/src)/' | grep -v '__tests__')
[ -z "$code" ] && exit 0
printf '%s\n' "$changed" | grep -qx 'noir-tauri/.claude/skills/hean-invariants/SKILL.md' && exit 0

# Déjà rappelé pour exactement ces fichiers ? → silence
state="$(git rev-parse --git-dir)/hean-invariant-reminded"
fingerprint=$(printf '%s' "$code" | shasum | cut -d' ' -f1)
grep -qx "$fingerprint" "$state" 2>/dev/null && exit 0
echo "$fingerprint" >> "$state"

files=$(printf '%s' "$code" | head -8 | tr '\n' ' ')
reason="Rappel automatique (hook hean-invariants) : du code a changé sur cette branche ($files) mais le skill hean-invariants n'a pas été mis à jour.
Si ce travail corrige un bug qui pourrait revenir, ou établit une règle à respecter à l'avenir : propose à Thomas, en une phrase simple, la règle à ajouter (quoi + pourquoi) et demande-lui seulement « oui / non ». S'il répond oui : ajoute-la dans noir-tauri/.claude/skills/hean-invariants/SKILL.md (section invariants, avec sa gravité) + une ligne dans le résumé « Invariants » de noir-tauri/CLAUDE.md.
Si le travail ne crée aucune règle (refacto, doc, feature sans risque de régression), ne dis rien de plus et termine."

jq -n --arg r "$reason" '{decision: "block", reason: $r}'
