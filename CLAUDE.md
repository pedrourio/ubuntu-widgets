# ubuntu-widgets

## pr-widget, pr-status e a skill andam juntos

- `extensions/pr-widget@pedrourio.github.io/logic.js` é a única fonte das regras (classificação, agrupamento, busca). O widget e o `bin/pr-status.js` importam esse mesmo arquivo; nunca duplique regra em um dos dois.
- Mudou regra, visualização, flag ou opção no widget? No mesmo commit: ajuste `bin/pr-status.js` se a saída ou as opções mudarem, `claude-skills/pr-status/SKILL.md` se o jeito de usar ou ler mudar, e o `README.md`.
- Antes de commitar: `cd extensions/pr-widget@pedrourio.github.io && gjs -m check.js` e `bin/pr-status` (precisa rodar sem erro).
- Nada de nomes internos de empresa no código (reviewer, org, prefixo de repo): ficam em `~/.config/pr-widget/config.json`.
- Depois de mudar qualquer extensão, rode `bin/ext-reload` (todas) ou `ext-reload <uuid>`: recarrega sem logout e mostra o estado (ACTIVE ou o erro). Só o próprio `ext-reload@…` precisa de logout.
- Toda classe com `GObject.registerClass` numa extensão precisa de `GTypeName` derivado de `import.meta.url` (ver pr-widget), senão a recarga falha com "Type name … is already registered".

## jira-widget

- Regras em `extensions/jira-widget@pedrourio.github.io/logic.js`, testadas por `gjs -m check.js` na mesma pasta. Desenho do burndown em `draw.js` (sem St) para dar para gerar PNG fora do shell.
- O jira-widget importa `logic.js` e `config.js` do pr-widget pelo caminho instalado (`~/.local/share/gnome-shell/extensions/pr-widget@…`) para classificar PRs. Mudou o `FRAGMENT` ou o `classify`? Rode o `check.js` das duas extensões.
- Nada de site, org, projeto ou board no código: só em `~/.config/jira-widget/config.json`. Token só no chaveiro.
