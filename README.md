# ubuntu-widgets

Extensões pequenas para a barra do topo do GNOME Shell 50 (Wayland), feitas para gastar quase nada de RAM: rodam dentro do próprio shell, sem processo extra.

| Extensão | O que faz |
| --- | --- |
| `pr-widget` | Suas PRs abertas no GitHub: contadores na barra (pedem sua resposta, aguardando o reviewer, prontas para merge, com conflito) e um menu com grupos, status do reviewer autônomo, abrir PR e copiar link. |
| `pr-status` + skill do Claude Code | O mesmo status das PRs no terminal (`pr-status [--view status\|group] [busca]`) e a skill `pr-status`, que faz o Claude consultar por ele. Usa o mesmo `logic.js` do widget. |
| `bt-headset-battery` | Ícone do fone Bluetooth conectado com barra e porcentagem de bateria (lida do UPower). |

## Instalar

```sh
./install.sh          # liga as extensões, ext-hotload, pr-status e a skill por symlink
```

As extensões carregam no próximo login. Para carregar já, sem sair da conta: rode o `ext-hotload <uuid>...` que o `install.sh` mostra no final, depois `Alt+F2` → `lg` → `Ctrl+V` → `Enter`. Isso só vale na primeira carga de cada extensão; código alterado depois exige logout.

## pr-widget

Requer o [`gh`](https://cli.github.com/) autenticado. Uma consulta GraphQL a cada `intervalMinutes`.

Configuração em `~/.config/pr-widget/config.json` (grupos e cores também se editam em **Organizar grupos e cores**, no menu):

```json
{
  "reviewer": "login-do-reviewer-autonomo",
  "reviewerName": "Nome curto exibido",
  "defaultOwner": "org-padrao-para-repo#numero",
  "repoPrefix": "prefixo-removido-do-nome-do-repo-",
  "intervalMinutes": 5,
  "autoGroupByCard": true,
  "viewMode": "status",
  "cardPattern": "\\b[A-Z][A-Z0-9]+-\\d+\\b",
  "groups": [{"id": "g1", "name": "Meu grupo", "color": "#62a0ea"}],
  "assign": {"org/repo#123": "g1"},
  "extra": ["org/repo#456"]
}
```

O menu tem duas visualizações: **Por status** (pedem resposta, aguardando o reviewer, prontas, com conflito, sem review, demais) e **Por grupo** (seus grupos, monitoradas, cards, sem grupo). `viewMode` define qual abre primeiro.

A decisão do reviewer vem do review mais recente dele: `CHANGES_REQUESTED`, ou `decision: PASS|WARN` no texto do review.

Regras testadas em `extensions/pr-widget@pedrourio.github.io/check.js`:

```sh
cd extensions/pr-widget@pedrourio.github.io && gjs -m check.js
```
