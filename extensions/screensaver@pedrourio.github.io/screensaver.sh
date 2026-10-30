#!/usr/bin/env bash
# Anima logo.txt em loop com o tte, um efeito sorteado por vez; qualquer tecla sai.
# Sem argumento pede à extensão para abrir em todos os monitores; --run é o loop dentro de cada terminal.
here=$(dirname "$(readlink -f "$0")")
tte=$(command -v tte || echo "$HOME/.local/bin/tte")
if [[ $1 != --run ]]; then
  [[ -x $tte ]] || { echo "tte não encontrado: uv tool install terminaltexteffects" >&2; exit 1; }
  gdbus call --session --dest org.gnome.Shell --object-path /io/github/pedrourio/Screensaver \
    --method io.github.pedrourio.Screensaver.Start >/dev/null && exit
  echo "extensão screensaver@pedrourio.github.io não está ativa" >&2; exit 1
fi
effects=(beams binarypath blackhole bouncyballs bubbles burn colorshift crumble decrypt errorcorrect expand fireworks highlight laseretch matrix middleout orbittingvolley overflow pour print rain randomsequence rings scattered slice slide smoke spotlights spray swarm sweep synthgrid thunderstorm unstable vhstape waves wipe)
tput civis
trap 'tput cnorm; kill $pid 2>/dev/null' EXIT
while true; do
  clear
  tput civis
  if (( RANDOM % 5 == 0 )) && [[ -x /usr/games/cbonsai ]]; then
    # 1 vez em 5: bonsais crescendo por 40 s. LC_ALL=C: com locale pt o cbonsai não lê "0.01";
    # --foreground: num grupo de processos próprio o ncurses fica parado esperando o terminal
    LC_ALL=C timeout --foreground 40 /usr/games/cbonsai -li -t 0.01 -w 1.5 -L 48 -m '</>' </dev/null &
  else
    "$tte" -i "$here/logo.txt" --frame-rate 120 --canvas-width 0 --canvas-height 0 \
      --anchor-canvas c --anchor-text c "${effects[RANDOM % ${#effects[@]}]}" &
  fi
  pid=$!
  while kill -0 $pid 2>/dev/null; do
    read -rsn1 -t 0.3 && exit
  done
  read -rsn1 -t 2 && exit
done
