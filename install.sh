#!/usr/bin/env bash
# Liga as extensões e o ext-hotload deste repositório por symlink (editar aqui = editar o instalado).
set -euo pipefail
repo=$(cd "$(dirname "$0")" && pwd)
dest="$HOME/.local/share/gnome-shell/extensions"
mkdir -p "$dest" "$HOME/.local/bin"
for ext in "$repo"/extensions/*/; do
  ln -sfn "${ext%/}" "$dest/$(basename "$ext")"
  echo "ligado: $(basename "$ext")"
done
ln -sfn "$repo/bin/ext-hotload" "$HOME/.local/bin/ext-hotload"
echo "Para carregar sem logout: ext-hotload $(cd "$repo/extensions" && echo *)"
