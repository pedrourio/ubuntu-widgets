#!/usr/bin/env bash
# Liga as extensões e o ext-hotload deste repositório por symlink (editar aqui = editar o instalado).
set -euo pipefail
repo=$(cd "$(dirname "$0")" && pwd)
dest="$HOME/.local/share/gnome-shell/extensions"
mkdir -p "$dest" "$HOME/.local/bin"
for ext in "$repo"/extensions/*/; do
  [[ -d $ext/schemas ]] && glib-compile-schemas "$ext/schemas"
  ln -sfn "${ext%/}" "$dest/$(basename "$ext")"
  echo "ligado: $(basename "$ext")"
done
for bin in ext-hotload ext-reload pr-status jira-token; do
  ln -sfn "$repo/bin/$bin" "$HOME/.local/bin/$bin"
done
# skills do Claude Code: o mesmo repo, para andarem junto com o widget
mkdir -p "$HOME/.claude/skills"
for skill in "$repo"/claude-skills/*/; do
  ln -sfn "${skill%/}" "$HOME/.claude/skills/$(basename "$skill")"
  echo "skill: $(basename "$skill")"
done
echo "Para carregar sem logout: ext-hotload $(cd "$repo/extensions" && echo *)"
