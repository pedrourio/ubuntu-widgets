# printmark

printmark is a small screenshot annotation tool for GNOME Wayland (Rust + GTK4). Press `Print`, pick an area or screen through the desktop portal, annotate it, and copy the result to the clipboard. It exists because Flameshot and Satty only capture the primary monitor on GNOME Wayland; printmark uses the native GNOME screenshot UI (through the portal), which covers every monitor, and adds the editor on top. No daemon, no tray icon.

## Build

```sh
sudo apt install cargo libgtk-4-dev pkg-config
cargo build --release
```

## Install

Requires `gsettings` and `python3` (both present on a standard GNOME install). Run the commands from the repository root.

```sh
install -Dm755 target/release/printmark ~/.local/bin/printmark
scripts/shortcut.sh enable ~/.local/bin/printmark
```

`enable` backs up the native `show-screenshot-ui` binding, clears it, and registers a custom shortcut that runs printmark on `Print`. Existing custom shortcuts are kept. Running it twice is safe.

## Uninstall / restore the native Print

```sh
scripts/shortcut.sh disable
```

This restores the original binding, removes only the printmark shortcut, and deletes the backup.

## First run

The first capture may show a screenshot permission prompt from the desktop portal. Allow it; the editor opens right after.

## Keys

| Key | Action |
| --- | --- |
| `A` | Seta (arrow) |
| `R` | Retângulo |
| `E` | Elipse |
| `P` | Caneta (pen) |
| `H` | Marca-texto (highlighter) |
| `T` | Texto |
| `N` | Número |
| `B` | Tarja (opaque black redaction box) |
| `1`-`6` | Color: red, yellow, green, blue, black, white |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `Ctrl+C` | Copiar: copy the annotated image to the clipboard and quit |
| `Esc` | Descartar: drop the annotations and put the clean image on the clipboard. While typing text, `Esc` only finishes the text. |
| Scroll | Pan |
| `Shift`+scroll | Pan horizontally |
| `Ctrl`+scroll | Zoom at the pointer |

Shapes cannot be selected or moved after drawing; use undo.

After Copiar or Descartar the window closes, but a `printmark` process stays alive as long as it owns the clipboard (Wayland serves the image from the process that copied it). It exits on its own as soon as something else is copied, so a `printmark` in `pgrep` is not a leak.

Set `PRINTMARK_TIMING=1` to print the time from the portal response to the editor being visible.

## Known limits

- `Print` no longer opens the native screenshot UI, so there is no screen recording from it. Recording stays on `Ctrl+Shift+Alt+R`.
- The clean PNG is saved in `Capturas de tela` inside your XDG Pictures folder (`~/Imagens/Capturas de tela/` on a pt-BR system, `~/Pictures/Capturas de tela/` on an English one). Data covered by a tarja stays visible in that file. The annotated image is never written to disk.
- If exporting the annotated image fails on Copiar, the editor stays open. printmark never copies the unredacted image as a fallback.

## License

MIT, see [LICENSE](LICENSE).
