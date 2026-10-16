#!/usr/bin/env bash
# Usage: shortcut.sh enable <binary-path> | disable
set -euo pipefail

MK=org.gnome.settings-daemon.plugins.media-keys
PM=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/printmark/
SS_SCHEMA=org.gnome.shell.keybindings
SS_KEY=show-screenshot-ui
BAK=${XDG_CONFIG_HOME:-$HOME/.config}/printmark/show-screenshot-ui.bak

# list_edit add|remove: edit the custom-keybindings list, keeping other entries.
list_edit() {
  local cur new
  cur=$(gsettings get $MK custom-keybindings)
  new=$(python3 - "$1" "$PM" "$cur" <<'PY'
import ast, sys
op, path, cur = sys.argv[1:4]
items = ast.literal_eval(cur.removeprefix("@as "))
items = [i for i in items if i != path]
if op == "add":
    items.append(path)
print(repr(items))
PY
)
  gsettings set $MK custom-keybindings "$new"
}

case "${1:-}" in
  enable)
    # Absolute: GNOME runs the command from its own cwd.
    bin=$(realpath "${2:?usage: shortcut.sh enable <binary-path>}")
    if [ ! -e "$BAK" ]; then
      mkdir -p "$(dirname "$BAK")"
      gsettings get $SS_SCHEMA $SS_KEY > "$BAK"
    fi
    gsettings set $SS_SCHEMA $SS_KEY "[]"
    list_edit add
    S=$MK.custom-keybinding:$PM
    gsettings set "$S" name printmark
    gsettings set "$S" command "$bin"
    gsettings set "$S" binding Print
    ;;
  disable)
    orig="['Print']"
    [ -e "$BAK" ] && orig=$(cat "$BAK")
    gsettings set $SS_SCHEMA $SS_KEY "$orig"
    list_edit remove
    gsettings reset-recursively $MK.custom-keybinding:$PM
    rm -f "$BAK"
    ;;
  *)
    echo "usage: $0 enable <binary-path> | disable" >&2
    exit 2
    ;;
esac
