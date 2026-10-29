# ubuntu-widgets

Extensões pequenas para a barra do topo do GNOME Shell 50 (Wayland), feitas para gastar quase nada de RAM: rodam dentro do próprio shell, sem processo extra.

| Extensão | O que faz |
| --- | --- |
| `pr-widget` | Suas PRs abertas no GitHub: contadores na barra (pedem sua resposta, aguardando o reviewer, prontas para merge, com conflito) e um menu com grupos, status do reviewer autônomo, abrir PR e copiar link. |
| `pr-status` + skill do Claude Code | O mesmo status das PRs no terminal (`pr-status [--view status\|group] [busca]`) e a skill `pr-status`, que faz o Claude consultar por ele. Usa o mesmo `logic.js` do widget. |
| `bt-headset-battery` | Ícone do fone Bluetooth conectado com barra e porcentagem de bateria (lida do UPower). |

## Instalar

```sh
./install.sh          # liga as extensões, ext-hotload, ext-reload, pr-status e a skill por symlink
```

As extensões carregam no próximo login. Para carregar já, sem sair da conta: rode o `ext-hotload <uuid>...` que o `install.sh` mostra no final, depois `Alt+F2` → `lg` → `Ctrl+V` → `Enter`. Isso só vale na primeira carga de cada extensão.

### Recarregar sem logout: `ext-reload`

Ative uma vez a extensão `ext-reload@pedrourio.github.io` (`ext-hotload ext-reload@pedrourio.github.io`). Daí em diante, depois de mudar o código:

```sh
ext-reload                                  # todas as extensões do repo
ext-reload pr-widget@pedrourio.github.io    # só uma
```

O GNOME guarda os módulos já importados pelo caminho do arquivo e só barra a recarga por versão. O `ext-reload` copia a extensão para `~/.cache/ext-reload/<uuid>/<carimbo>/<uuid>`, descarrega a antiga e carrega a cópia (mesmo uuid e versão, caminho novo). Classes `GObject.registerClass` precisam de `GTypeName` derivado de `import.meta.url` para não colidir. O próprio `ext-reload` só muda com logout.

## pr-widget

`Super+G` abre o menu com o cursor na busca (muda em `org.gnome.shell.extensions.pr-widget open-shortcut`).

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

O menu tem duas visualizações: **Por status** (monitoradas por você, pedem resposta, aguardando o reviewer, prontas, com conflito, sem review, demais) e **Por grupo** (monitoradas, seus grupos, cards, sem grupo). PRs monitoradas ficam sempre num grupo só delas, no topo, com o estado (aberta, merged, fechada); mergeadas e fechadas não contam nos contadores. PRs que o GitHub libera para merge (checks, aprovações e sem conflito), suas ou monitoradas, ganham um botão **Merge** no hover: o primeiro clique pede confirmação, o segundo roda `gh pr merge --merge` (merge commit) e avisa por notificação; ao adicionar uma, o menu se atualiza na hora e filtra por ela. `viewMode` define qual abre primeiro.

A decisão do reviewer vem do review mais recente dele: `CHANGES_REQUESTED`, ou `decision: PASS|WARN` no texto do review.

Regras testadas em `extensions/pr-widget@pedrourio.github.io/check.js`:

```sh
cd extensions/pr-widget@pedrourio.github.io && gjs -m check.js
```

## jira-widget

Na barra, ao lado do pr-widget: ícone, número da sprint ativa (`S28`) e um placar estilo KDA com os **seus** cards da sprint por coluna do board — To Do (laranja vazado) / In Progress / Code Review / Ready to Test / Testing / Ready to Deploy / Done. As colunas são lidas do próprio board (pela posição), não fixadas no código.

`Super+J` abre o menu com o cursor na busca (muda em `org.gnome.shell.extensions.jira-widget open-shortcut`). Ao abrir: sprint, dias restantes, busca e o burndown da sprint (o mesmo dado do relatório do Jira, contado em cards; `burndownUnit: "points"` conta Story Points), com a linha ondulando de leve só enquanto o menu está aberto (respeita "animações" desligadas no GNOME). Buscar por `123`, `PROJ-123`, palavra do título ou nome do épico abre o card: responsável, PRs (achadas no GitHub pela chave no título, com as regras do pr-widget) e anexos como links.

Abaixo do burndown, primeiro o bloco **Entrega (últimos 30 dias)**, você × média do time, atualizado no máximo a cada 6 h: **lead time** (PR aberta até o deploy em produção, ou seja, a primeira PR `deployHead → deployBases` mergeada depois do merge da sua PR), **revisão do reviewer de IA** (PASS já na 1ª revisão, revisões por PR, mergeadas com PASS; mesma regra de decisão do pr-widget) e **eficiência do fluxo** (tempo em In Progress + Code Review ÷ tempo de In Progress até Done, cards concluídos). Usa `gh` para as PRs e o histórico de status do Jira.

Depois, os **KPIs seus × média do time** (`team` no config): estágios de entrega (pós-dev = Ready to Test em diante, pronto = Ready to Deploy em diante, done = só Done), horas por card em cada coluna nesta sprint (com destaque na coluna em que você mais passa do time) e cards parados há mais de 2 dias. O histórico de status vem de `POST /rest/api/3/changelog/bulkfetch`, numa chamada para a sprint inteira.

Custo: uma consulta pequena a cada `intervalMinutes` (padrão 15) para placar e burndown; abrir o menu não consulta nada; a busca espera 400 ms sem digitar e cancela a anterior; PRs só do card aberto.

Config em `~/.config/jira-widget/config.json` (ou pela engrenagem do menu):

| chave | o que é |
|---|---|
| `site` | `https://<org>.atlassian.net` |
| `email` | email da conta Atlassian |
| `boardId` | id do board scrum |
| `project` | chave do projeto (`123` vira `PROJ-123`) |
| `githubOwner` | organização no GitHub onde estão as PRs |
| `burndownUnit` | `cards` (padrão) ou `points` |
| `pointsField` | campo de Story Points (`customfield_…`), usado com `burndownUnit: "points"` |
| `intervalMinutes` | intervalo do placar, padrão 15 |
| `team` | accountIds de quem entra na média do time nos KPIs |
| `githubLogin`, `teamGithub` | seu usuário e os do time no GitHub (bloco Entrega) |
| `deployHead`, `deployBases` | branch de integração e as de produção (padrão `base` → `master`/`main`) |

Token de API: gere em https://id.atlassian.com/manage-profile/security/api-tokens e cole nas preferências (engrenagem do menu) ou rode `jira-token`. Fica no chaveiro (libsecret), nunca em arquivo.

O burndown usa o endpoint interno do relatório do Jira (`/rest/greenhopper/1.0/rapid/charts/scopechangeburndownchart`); se ele mudar, o bloco mostra "Burndown indisponível" e o resto segue.

```sh
cd extensions/jira-widget@pedrourio.github.io && gjs -m check.js   # regras
```
