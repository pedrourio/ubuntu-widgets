# ubuntu-widgets

## pr-widget, pr-status e a skill andam juntos

- `extensions/pr-widget@pedrourio.github.io/logic.js` é a única fonte das regras (classificação, agrupamento, busca). O widget e o `bin/pr-status.js` importam esse mesmo arquivo; nunca duplique regra em um dos dois.
- Mudou regra, visualização, flag ou opção no widget? No mesmo commit: ajuste `bin/pr-status.js` se a saída ou as opções mudarem, `claude-skills/pr-status/SKILL.md` se o jeito de usar ou ler mudar, e o `README.md`.
- Antes de commitar: `cd extensions/pr-widget@pedrourio.github.io && gjs -m check.js` e `bin/pr-status` (precisa rodar sem erro).
- Nada de nomes internos de empresa no código (reviewer, org, prefixo de repo): ficam em `~/.config/pr-widget/config.json`.
- Extensão já carregada só pega código novo após logout; o `ext-hotload` serve apenas na primeira carga de cada uuid.
