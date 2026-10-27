# ubuntu-widgets

Extensões pequenas para a barra do topo do GNOME Shell 50 (Wayland), feitas para gastar quase nada de RAM: rodam dentro do próprio shell, sem processo extra.

| Extensão | O que faz |
| --- | --- |
| `pr-widget` | Suas PRs abertas no GitHub: contadores na barra (pedem sua resposta, aguardando o reviewer, prontas para merge, com conflito) e um menu com grupos, status do reviewer autônomo, abrir PR e copiar link. |
| `bt-headset-battery` | Ícone do fone Bluetooth conectado com barra e porcentagem de bateria (lida do UPower). |

## Instalar

```sh
./install.sh          # liga as extensões por symlink e instala o ext-hotload
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
  "cardPattern": "\\b[A-Z][A-Z0-9]+-\\d+\\b",
  "groups": [{"id": "g1", "name": "Meu grupo", "color": "#62a0ea"}],
  "assign": {"org/repo#123": "g1"},
  "extra": ["org/repo#456"]
}
```

A decisão do reviewer vem do review mais recente dele: `CHANGES_REQUESTED`, ou `decision: PASS|WARN` no texto do review.

Regras testadas em `extensions/pr-widget@pedrourio.github.io/check.js`:

```sh
cd extensions/pr-widget@pedrourio.github.io && gjs -m check.js
```
