# jira-widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extensão GNOME na barra do topo com sprint + placar KDA dos meus cards, burndown animado do Jira e busca de cards com PRs e anexos.

**Architecture:** Regras puras em `logic.js` (testadas com `gjs -m check.js`, como o pr-widget); rede isolada em `jira.js` (Soup 3 + Basic auth com token do libsecret); `extension.js` só desenha e agenda. Ciclo de 15 min alimenta barra e burndown a partir de memória/cache; menu aberto não faz rede; busca e PRs são por demanda.

**Tech Stack:** GJS ESM, GNOME Shell 50, St/Clutter/Cairo, Soup 3, Secret 1, Adw (prefs), `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-10-27-jira-widget-design.md`

## Global Constraints

- Pasta `extensions/jira-widget@pedrourio.github.io/`, uuid `jira-widget@pedrourio.github.io`, `shell-version: ["50"]`.
- Todo `GObject.registerClass` com `GTypeName` derivado de `import.meta.url` (padrão do pr-widget).
- Sem nomes internos no código/repo: site, email, boardId, project, githubOwner só em `~/.config/jira-widget/config.json`. Fixtures de teste usam `ACME`, `https://acme.atlassian.net`.
- Token só no chaveiro (schema `io.github.pedrourio.JiraWidget`, atributo `site`). Nunca em arquivo, log ou erro exibido.
- Rede: nada ao abrir o menu; ciclo a cada `intervalMinutes` (padrão 15); busca com debounce 400 ms e cancelamento da anterior; PRs só ao abrir um card.
- Animação só com menu aberto e burndown visível; desligada se `org.gnome.desktop.interface enable-animations` = false.
- Cores (padrão Jira dark): menu `#282e33`, bloco `#22272b`, texto `#b6c2cf`/`#dee4ea`, secundário `#8c9bab`, azul `#579dff`. Lozenges da barra: To Do vazado `#fea362`; In Progress `#09326c`/`#85b8ff`; Code Review `#352c63`/`#b8acf6`; Ready to Test `#533f04`/`#f8e6a0`; Testing `#1d474c`/`#9dd9ee`; Ready to Deploy `#50253f`/`#fdd0ec`; Done `#164b35`/`#7ee2b8`.
- Após cada task que toca a extensão: `ext-reload jira-widget@pedrourio.github.io` deve imprimir `ACTIVE`.

## Review Focus

1. Busca com aspas, barra invertida ou palavras reservadas de JQL (`"`, `\`, `AND`) → não quebra a consulta; busca o texto literal. (Task 2: teste de `toJql`.)
2. Token errado/expirado (401/403) → menu mostra "Token inválido" + botão de configuração; barra mantém último placar com marca discreta; nada de stack trace. (Task 1: `request` rejeita com `JiraError{status}`; Task 4: estado de erro.)
3. Board sem sprint ativa (entre sprints) → barra mostra só o ícone com "–", menu diz "Nenhuma sprint ativa" e a busca continua funcionando. (Task 2: `pickActiveSprint([])` → `null`; Task 3.)
4. Sem rede no login → barra usa `state.json` do cache; quando a rede volta, o próximo ciclo corrige. (Task 3.)
5. Endpoint de burndown 404/formato inesperado → bloco "burndown indisponível", resto intacto. (Task 2: `burndownSeries` com entrada inválida → `null`.)

---

### Task 1: Config, chaveiro e cliente HTTP (+ captura de fixtures)

**Files:**
- Create: `extensions/jira-widget@pedrourio.github.io/metadata.json`, `config.js`, `secret.js`, `jira.js`
- Create (fora do repo): `~/.config/jira-widget/config.json` com os valores reais do usuário

**Interfaces:**
- Produces:
  - `config.js`: `CONFIG_PATH`, `CACHE_PATH` (`~/.cache/jira-widget/state.json`), `loadConfig() → {site, email, boardId, project, githubOwner, intervalMinutes}`, `readJson`, `writeJson` (copiar o padrão do pr-widget).
  - `secret.js`: `lookupToken(site) → Promise<string|null>`, `storeToken(site, token) → Promise<void>`.
  - `jira.js`: `class JiraClient { constructor(cfg, token); request(path, params = {}, cancellable = null) → Promise<object> }`; erro = `JiraError extends Error { status }`; mensagem nunca contém o token.

- [ ] **Step 1:** Pedir ao usuário para gerar um token em https://id.atlassian.com/manage-profile/security/api-tokens e gravar: `secret-tool store --label="Jira widget" xdg:schema io.github.pedrourio.JiraWidget site <site>` (cola o token no prompt). Escrever o `config.json` real.
- [ ] **Step 2:** Implementar os três módulos. `JiraClient` usa uma `Soup.Session` única, header `Authorization: Basic base64(email:token)`, `Accept: application/json`, `send_and_read_async`; status ≥ 400 → `JiraError`.
- [ ] **Step 3:** Script descartável no scratchpad (não commitar) que chama `/rest/api/3/myself`, `/rest/agile/1.0/board/{id}/configuration`, `/rest/agile/1.0/board/{id}/sprint?state=active`, `/rest/greenhopper/1.0/rapid/charts/scopechangeburndownchart?rapidViewId={id}&sprintId={sprint}` e salva as respostas cruas no scratchpad.
  Expected: os quatro com 200. Anotar no plano (esta linha) o formato real do burndown.
- [ ] **Step 4:** Descobrir a URL de anexo que abre no navegador logado: abrir `{site}/rest/api/3/attachment/content/{id}` e `{site}/secure/attachment/{id}/{filename}` de um card com anexo no navegador. Registrar a que funciona como `attachmentUrl(site, att)` na Task 2.
- [ ] **Step 5: Commit** `jira-widget: config, chaveiro e cliente HTTP`.

### Task 2: Regras puras (`logic.js`) e `check.js`

**Files:**
- Create: `extensions/jira-widget@pedrourio.github.io/logic.js`, `check.js`

**Interfaces:**
- Produces:
  - `COLUMNS = ['todo','progress','review','ready','testing','deploy','done']` (ordem da barra).
  - `columnMap(boardConfig) → Map<statusId, columnKey>`: colunas do board na ordem 1..7 viram as chaves acima (posição, não nome).
  - `tally(issues, colMap, meAccountId) → {todo, progress, review, ready, testing, deploy, done}`.
  - `pickActiveSprint(sprints) → {id, name, number, startDate, endDate} | null` (`number` = dígitos finais do nome, ex. "Sprint 28" → 28).
  - `daysLeft(endIso, now = Date.now()) → number` (dias corridos arredondados para cima, mínimo 0).
  - `toJql(query, project) → {jql, byKey: boolean} | null`: `''` → null; `/^\d+$/` → `key = ${project}-n`; `/^[A-Z][A-Z0-9]+-\d+$/i` → `key = ...`; senão `project = P AND (summary ~ "texto*" OR parent in (epicKeys))`. A busca por épico é feita em duas chamadas: `epicJql(query, project)` primeiro e `toJql(query, project, epicKeys)` depois. Texto escapado (`\` e `"`); termina `ORDER BY updated DESC`.
  - `epicJql(query, project) → string`.
  - `burndownSeries(raw, sprint) → {total, points: [{t, remaining}], ideal: [{t, remaining}]} | null` (formato do raw = o anotado na Task 1, Step 3).
  - `attachmentUrl(site, att) → string`.
  - `initials(displayName) → string` ("Pedro Henrique Urio" → "PU").

- [ ] **Step 1: Testes** (estilo `assert(cond, msg)` do pr-widget):
  - `toJql('4583','ACME').jql` contém `key = ACME-4583`; `toJql('acme-12','ACME').byKey === true`.
  - `toJql('relatório "PCA"','ACME').jql` contém `summary ~ "relatório \\"PCA\\"*"`; `toJql('a\\b','ACME')` escapa a barra.
  - `toJql('   ','ACME') === null`.
  - `tally` com 3 issues (2 minhas em colunas 1 e 7, 1 de outro) → `{todo:1, done:1, resto 0}`.
  - `pickActiveSprint([])` → null; `pickActiveSprint([{name:'Sprint 28', state:'active', ...}]).number === 28`.
  - `daysLeft('2026-10-30T21:00:00Z', Date.parse('2026-10-27T12:00:00Z')) === 4`.
  - `burndownSeries(fixture, sprint)` → `points[0].remaining === total`; `burndownSeries({}, sprint) === null`.
  - `initials('Pedro Henrique Urio') === 'PU'`; `initials('') === '?'`.
- [ ] **Step 2:** `gjs -m check.js` → FAIL (funções inexistentes).
- [ ] **Step 3:** Implementar. Fixture do burndown = versão reduzida e anonimizada da resposta real, embutida no `check.js`.
- [ ] **Step 4:** `gjs -m check.js` → todos `ok:`.
- [ ] **Step 5: Commit** `jira-widget: regras de busca, placar e burndown`.

### Task 3: Barra + ciclo de 15 min

**Files:**
- Create: `extension.js`, `stylesheet.css`, `jira-symbolic.svg` (losango de duas camadas, só `fill`, como o `pr-symbolic.svg`)
- Modify: `install.sh` não precisa (já liga `extensions/*/`)

**Interfaces:**
- Consumes: Task 1 (`loadConfig`, `lookupToken`, `JiraClient`), Task 2 (`columnMap`, `tally`, `pickActiveSprint`, `burndownSeries`).
- Produces: `Indicator._state = {sprint, counts, burndown, error, updatedAt}` (é o que a Task 4/6 desenham); `Indicator.refreshCycle() → Promise<void>`.

- [ ] **Step 1:** Indicator na esquerda, índice 4. Pill: ícone, label `S{number}` (ou `–`), 7 lozenges na ordem de `COLUMNS` (classes `.jw-lz .jw-{key}`; `todo` vazado). Mostra zeros.
- [ ] **Step 2:** `refreshCycle`: myself (uma vez, guarda accountId) → board configuration (cache por dia) → sprint ativa → `search/jql` `sprint = {id}` com `fields=status,assignee`, paginado → burndown. Grava `state.json`; ao iniciar, lê `state.json` antes de qualquer rede. Timer `intervalMinutes`. Falha parcial do burndown não derruba o placar.
- [ ] **Step 3:** `ext-hotload jira-widget@pedrourio.github.io` (primeira carga; usuário cola no lg), depois `ext-reload jira-widget@pedrourio.github.io` → `ACTIVE`. Conferir na barra: `S28` e o placar igual à contagem do Jira.
- [ ] **Step 4: Commit** `jira-widget: barra com sprint e placar`.

### Task 4: Menu, busca e card aberto

**Files:**
- Modify: `extension.js`, `stylesheet.css`

**Interfaces:**
- Consumes: Task 2 (`toJql`, `epicJql`, `attachmentUrl`, `initials`, `daysLeft`), `JiraClient.request`.
- Produces: `Indicator._openCard(issue)` (gancho que a Task 5 usa para PRs); `Indicator._burndownBox` (área que a Task 6 preenche).

- [ ] **Step 1:** Cabeçalho: "Sprint N", lozenge "ATIVA", datas + "N dias restantes", botão engrenagem (`emblem-system-symbolic`, `accessible_name: 'Configurar Jira'`) → `openPreferences()`. Sem token: bloco com texto "Cole seu token do Jira para começar" e botão primário "Colar token" que faz o mesmo.
- [ ] **Step 2:** Entry de busca com foco ao abrir; debounce 400 ms; `Gio.Cancellable` da busca anterior cancelado; com texto, o burndown some. Resultados (máx. 10): primeiro aberto, demais em linha (tipo, chave, título com reticências, lozenge de status pela coluna via `columnMap`). Clique alterna qual está aberto. Vazio: "Nenhum card encontrado".
- [ ] **Step 3:** Card aberto: caminho épico/chave, lozenge, título, Responsável (círculo com `initials` + nome; "Sem responsável"), Desenvolvimento (placeholder "buscando PRs…", preenchido na Task 5), Anexos (cada um `St.Button` estilo link → `Gio.AppInfo.launch_default_for_uri(attachmentUrl(...))`; "Nenhum"). Ações: "Abrir no Jira" (primário), "Copiar link" (feedback de check 1,6 s como no pr-widget).
- [ ] **Step 4:** Erros: 401/403 → "Token inválido ou expirado" + botão de configuração; rede → "Sem conexão com o Jira". Barra mantém último placar e ganha classe `.jw-stale`.
- [ ] **Step 5:** `ext-reload` → `ACTIVE`; testar manualmente: o número de um card real com e sem prefixo, uma palavra de título, nome de um épico, `"aspas"`.
- [ ] **Step 6: Commit** `jira-widget: busca e card`.

### Task 5: PRs do card (por demanda, regras do pr-widget)

**Files:**
- Modify: `extensions/pr-widget@pedrourio.github.io/logic.js` (exportar `buildCardPrQuery`; acrescentar `state` ao `FRAGMENT`), `extensions/pr-widget@pedrourio.github.io/check.js`
- Create: `extensions/jira-widget@pedrourio.github.io/prs.js`

**Interfaces:**
- Produces (pr-widget): `buildCardPrQuery(key, owner) → string` — `search(query: "<key> org:<owner> is:pr", type: ISSUE, first: 10) { nodes { ...P } }` + `viewer { login }`.
- Produces (jira-widget): `fetchCardPrs(key, cfg, cancellable) → Promise<Array<{repo, num, url, state, classified|null}>>`. Importa `logic.js`/`config.js` do pr-widget por `file://` de `~/.local/share/gnome-shell/extensions/pr-widget@pedrourio.github.io/` (import dinâmico; se falhar, `classified = null`). `classified` = `classify(...)` só para `state === 'OPEN'`.

- [ ] **Step 1: Teste (pr-widget check.js):** `buildCardPrQuery('ACME-1','Org')` contém `ACME-1 org:Org is:pr` e `...P`; `FRAGMENT` contém `state`.
- [ ] **Step 2:** `gjs -m check.js` (pr-widget) → FAIL; implementar; → `ok:`. `bin/pr-status` continua rodando sem erro.
- [ ] **Step 3:** `fetchCardPrs` via `gh api graphql` (Gio.Subprocess async, cancelável). Render em Desenvolvimento: `repo #n · aberta · WARN · sua vez` (texto de status do pr-widget), `· merged`, `· fechada`. Botão "Abrir PR #n" = primeira aberta. Sem resultados: "Nenhuma PR encontrada no GitHub".
- [ ] **Step 4:** `ext-reload` (as duas) → `ACTIVE`; abrir um card real que tenha PRs → todas aparecem.
- [ ] **Step 5: Commit** `jira-widget: PRs do card com as regras do pr-widget`.

### Task 6: Burndown animado

**Files:**
- Create: `extensions/jira-widget@pedrourio.github.io/chart.js`
- Modify: `extension.js`

**Interfaces:**
- Consumes: `_state.burndown` (`burndownSeries`), `_burndownBox`.
- Produces: `class Burndown extends St.DrawingArea { setData(series); start(); stop() }`.

- [ ] **Step 1:** Desenho Cairo como no mockup: grade, eixo de pontos (total/metade/0), dias da sprint, diretriz cinza `#8c9bab`, restante azul `#579dff` com área 14% e ponto "hoje" com rótulo "Restante: N".
- [ ] **Step 2:** Onda: deslocamento vertical por ponto `amp * sin(2π t/3s + i·0.9)` com `amp` ≤ 3 px, redesenho por `Clutter.Timeline` ~20 fps. `start()` no `open-state-changed` aberto e só se o burndown estiver visível; `stop()` ao fechar e ao digitar. `enable-animations` falso → nunca anima.
- [ ] **Step 3:** `series === null` → "Burndown indisponível".
- [ ] **Step 4:** `ext-reload` → `ACTIVE`. Conferir com `top -p $(pgrep -x gnome-shell)`: CPU volta ao repouso com o menu fechado.
- [ ] **Step 5: Commit** `jira-widget: burndown animado`.

### Task 7: Preferências (token e config) + docs

**Files:**
- Create: `extensions/jira-widget@pedrourio.github.io/prefs.js`
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: `storeToken`, `lookupToken`, `loadConfig`/`writeJson`.

- [ ] **Step 1:** Adw: primeiro grupo "Token do Jira" com `Adw.PasswordEntryRow` (foco ao abrir), botão "Salvar" (→ `storeToken`), link "Gerar token" (URL da Atlassian do Step 1 da Task 1) e status "Token salvo"/"Sem token". Segundo grupo: site, email, board, projeto, owner do GitHub, intervalo.
- [ ] **Step 2:** O widget detecta config/token novos: monitor do `config.json` (debounce 2 s, como o pr-widget) e nova `lookupToken` a cada ciclo.
- [ ] **Step 3:** README: seção jira-widget (o que faz, config sem valores internos, token, custo de rede). CLAUDE.md: "jira-widget importa `logic.js` do pr-widget para PRs; mudou o `FRAGMENT`, rode o check das duas".
- [ ] **Step 4:** Engrenagem do menu abre prefs com o campo de token focado; salvar token novo → próximo ciclo sem erro. `ext-reload` → `ACTIVE`.
- [ ] **Step 5: Commit** `jira-widget: preferências e docs`.
