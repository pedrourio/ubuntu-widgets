#!/usr/bin/env bash
# Isolated: never touches the real GNOME settings.
set -euo pipefail
export XDG_CONFIG_HOME=$(mktemp -d) GSETTINGS_BACKEND=keyfile
here=$(cd "$(dirname "$0")" && pwd)
MK=org.gnome.settings-daemon.plugins.media-keys
BASE=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings
PM=$BASE/printmark/
C0=$BASE/custom0/ C1=$BASE/custom1/

eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got [$2], want [$3]"; exit 1; }; }

gsettings set $MK custom-keybindings "['$C0', '$C1']"
eq seed-print "$(gsettings get org.gnome.shell.keybindings show-screenshot-ui)" "['Print']"

"$here/../scripts/shortcut.sh" enable /x/printmark
"$here/../scripts/shortcut.sh" enable /x/printmark

eq list "$(gsettings get $MK custom-keybindings)" "['$C0', '$C1', '$PM']"
eq screenshot-ui "$(gsettings get org.gnome.shell.keybindings show-screenshot-ui)" "@as []"
S=$MK.custom-keybinding:$PM
eq binding "$(gsettings get $S binding)" "'Print'"
eq command "$(gsettings get $S command)" "'/x/printmark'"
eq name "$(gsettings get $S name)" "'printmark'"

"$here/../scripts/shortcut.sh" disable

eq list-restored "$(gsettings get $MK custom-keybindings)" "['$C0', '$C1']"
eq screenshot-restored "$(gsettings get org.gnome.shell.keybindings show-screenshot-ui)" "['Print']"
eq binding-reset "$(gsettings get $S command)" "''"
[ ! -e "$XDG_CONFIG_HOME/printmark/show-screenshot-ui.bak" ] || { echo "FAIL backup not deleted"; exit 1; }
echo ok
