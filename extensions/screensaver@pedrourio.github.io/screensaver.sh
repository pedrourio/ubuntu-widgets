#!/usr/bin/env bash
# Anima logo.txt em loop com o tte, um efeito sorteado por vez; qualquer tecla sai.
# Sem argumento abre num terminal em tela cheia; --run é o loop dentro dele.
here=$(dirname "$(readlink -f "$0")")
tte=$(command -v tte || echo "$HOME/.local/bin/tte")
if [[ $1 != --run ]]; then
  [[ -x $tte ]] || { echo "tte não encontrado: uv tool install terminaltexteffects" >&2; exit 1; }
  exec ptyxis -s --fullscreen -T screensaver -- "$here/screensaver.sh" --run
fi
effects=(beams binarypath blackhole bouncyballs bubbles burn colorshift crumble decrypt errorcorrect expand fireworks highlight laseretch matrix middleout orbittingvolley overflow pour print rain randomsequence rings scattered slice slide spotlights spray swarm sweep synthgrid unstable vhstape waves wipe)
tput civis
trap 'tput cnorm; kill $pid 2>/dev/null' EXIT
while true; do
  clear
  "$tte" -i "$here/logo.txt" --frame-rate 120 --canvas-width 0 --canvas-height 0 \
    --anchor-canvas c --anchor-text c "${effects[RANDOM % ${#effects[@]}]}" &
  pid=$!
  while kill -0 $pid 2>/dev/null; do
    read -rsn1 -t 0.3 && exit
  done
  read -rsn1 -t 2 && exit
done
