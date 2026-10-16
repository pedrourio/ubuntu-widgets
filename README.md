# printmark

printmark is a small screenshot annotation tool for GNOME Wayland (Rust + GTK4). Press `Print`, pick an area or screen through the desktop portal, annotate it, and copy the result to the clipboard. It exists because the native GNOME screenshot UI is awkward on multi-monitor setups. printmark runs only during a capture: no daemon, no tray icon.

## Build

```sh
sudo apt install cargo libgtk-4-dev pkg-config
cargo build --release
```

## Install

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

The first capture shows the screenshot permission prompt from the desktop portal. Allow it; the editor opens right after.

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
| `Esc` | Descartar: quit without copying. While typing text, `Esc` only finishes the text. |
| Scroll | Pan |
| `Ctrl`+scroll | Zoom at the pointer |

Shapes cannot be selected or moved after drawing; use undo.

Set `PRINTMARK_TIMING=1` to print the time from the portal response to the editor being visible.

## Known limits

- `Print` no longer opens the native screenshot UI, so there is no screen recording from it. Recording stays on `Ctrl+Shift+Alt+R`.
- The clean PNG is saved in the screenshots folder (`~/Imagens/Capturas de tela/`) by the portal. Data covered by a tarja stays visible in that file. The annotated image is never written to disk.
- If exporting the annotated image fails on Copiar, the editor stays open. printmark never copies the unredacted image as a fallback.

## License

MIT, see [LICENSE](LICENSE).
