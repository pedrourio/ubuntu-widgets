# pr-widget: aba "Por épico" — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** aba "Por épico" no pr-widget e no `pr-status`, agrupando PRs por épico do Jira e, dentro dele, por trunk/satélite (branches) e por card.

**Architecture:** regra pura em `pr-widget/logic.js` (`groupByEpic`, `epicLinks`, detecção de trunk), testada no `check.js`. Busca no Jira em `pr-widget/epics.js`, que importa `jira.js`/`secret.js`/`config.js` do jira-widget por caminho e guarda o mapa card → épico em `~/.cache/pr-widget/epics.json`. O widget e o `pr-status` chamam os dois.

**Tech Stack:** GJS ESM (GNOME Shell 50), St/Clutter, Soup 3, libsecret, `gh api graphql`.

**Spec:** `docs/superpowers/specs/2026-11-04-prs-por-epico-design.md`

## Global Constraints

- Nada de site, org, projeto ou board no código; Jira vem de `~/.config/jira-widget/config.json` e do chaveiro (schema `io.github.pedrourio.JiraWidget`).
- No máximo uma busca no Jira por atualização, mais uma para subir de subtarefa; só para cards fora do cache. Jira fora do ar ou sem token não quebra as outras abas nem atrasa o placar.
- Uma PR aparece uma vez só por aba.
- Regra só em `logic.js`; widget e `bin/pr-status.js` importam o mesmo arquivo (CLAUDE.md). Mudou visão/opção: ajustar `bin/pr-status.js`, `claude-skills/pr-status/SKILL.md` e `README.md` no mesmo commit.
- Antes de commitar: `cd extensions/pr-widget@pedrourio.github.io && gjs -m check.js`, o `check.js` do jira-widget (importa `logic.js` do pr-widget) e `bin/pr-status` sem erro. Depois de mudar a extensão: `ext-reload pr-widget@pedrourio.github.io` → ACTIVE.
- Commit + push no `main` a cada tarefa, com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Trunk e satélite em repositórios diferentes com o mesmo nome de branch: não podem se ligar (só mesmo repo).
2. Ciclo de branches (A mira em B, B mira em A) ou base igual à própria head: não pode travar nem sumir PR.
3. Card sem épico e trunk sem épico ao mesmo tempo: o trunk vira grupo próprio, o resto vai para "Sem épico".
4. Cache com card cujo épico mudou: depois do prazo, a busca volta a perguntar.
5. Monitorada mergeada que é satélite: entra no trunk e conta no "M merged".

Cada item tem teste na Tarefa 1 (1–3, 5) ou na Tarefa 2 (4).

---

### Task 1: regra de agrupar por épico em `logic.js`

**Files:**
- Modify: `extensions/pr-widget@pedrourio.github.io/logic.js` (FRAGMENT, `classify`, `VIEWS`, novas funções)
- Test: `extensions/pr-widget@pedrourio.github.io/check.js` (bloco novo "por épico")

**Interfaces:**
- Produces:
  - FRAGMENT pede `headRefName`; `classify` devolve também `head: pr.headRefName ?? null` e `fullRepo: pr.repository.nameWithOwner`.
  - `VIEWS = {status: 'Por status', group: 'Por grupo', epic: 'Por épico'}`.
  - `trunkOf(items) -> Map<prKey, rootTrunkKey>`: para cada satélite, a chave da PR trunk raiz. Liga S → T quando `S.fullRepo === T.fullRepo && S.base === T.head && S.key !== T.key`; sobe a cadeia até a raiz com conjunto de visitados (ciclo para no primeiro repetido).
  - `groupByEpic(items, epicOf, extraKeys) -> EpicGroup[]`, onde `epicOf: Map<card, {key, name} | null>` e
    `EpicGroup = {id, kind: 'extra'|'epic'|'trunk'|'noepic'|'nocard', name, color, summary: {ready, merged, total}, prs?: Pr[], subs?: Sub[]}`,
    `Sub = {id, kind: 'trunk'|'card', name, trunk?: Pr, prs: Pr[]}` (no `trunk`, `prs` são as satélites; `trunk` fica fora de `prs`).
  - Regras: trunk raiz + satélites formam um bloco; o bloco vai para o épico do card do trunk (`epicOf.get(trunk.card)`), senão vira `EpicGroup` `kind:'trunk'` com `name` = card do trunk (ou `repo #num`) e um único `Sub`. PRs restantes com card e épico → `Sub` `kind:'card'` no épico. Card sem épico → `noepic` ("Sem épico", subs por card). Sem card → `nocard` ("Sem card", `prs`). Monitoradas (`extraKeys`) que não caíram em épico nem trunk → `extra` ("Monitoradas por você", `prs`) no topo. Ordem: `extra`, épicos (mais `ready` primeiro, depois `key`), grupos `trunk`, `noepic`, `nocard`; dentro do épico, subs `trunk` antes de `card`. `summary.ready` conta `p.ready`, `merged` conta `p.state === 'MERGED'`, `total` todas. `color` do épico = `hashColor(epic.key)`; grupos vazios saem.
  - `epicLinks(issues) -> {epics: Map<cardKey, {key, name}|null>, climb: Map<cardKey, parentKey>}` a partir da resposta de `/rest/api/3/search/jql` com `fields=parent,issuetype,summary`: issue com `issuetype.hierarchyLevel === 1` é o próprio épico; pai com `fields.issuetype.hierarchyLevel === 1` → épico `{key: parent.key, name: parent.fields.summary}`; pai de outro nível → `climb`; sem pai → `null`.
  - `epicJqlFor(keys) -> string`: `key in (K1,K2)`; só chaves que casam `^[A-Z][A-Z0-9]+-\d+$`.

- [ ] **Step 1: testes que falham** (no `check.js`, bloco `// por épico`), com um helper `mk(key, {card, base, head, ready, state, repo})` que monta objetos já classificados:
  - `trunkOf`: T(head `feat/t`), S1(base `feat/t`), S2(base `feat/s1`, onde S1.head = `feat/s1`) → S1 e S2 apontam para T.
  - mesmo nome de branch em repos diferentes → `trunkOf` vazio.
  - ciclo A.base = B.head e B.base = A.head → termina, cada PR aparece uma vez em `groupByEpic`.
  - `groupByEpic`: épico E com trunk T (card C1, épico E), satélite S (card C9 de outro épico F) e PR solta P (card C2, épico E) → grupo E com subs `[trunk T com prs [S], card C2 com [P]]`; F não ganha grupo para S.
  - trunk sem épico (`epicOf` vazio) → grupo `kind:'trunk'` com nome do card do trunk; PR com card sem épico → `noepic`; sem card → `nocard`.
  - monitorada mergeada que é satélite → dentro do trunk e `summary.merged === 1`; monitorada solta sem épico → grupo `extra` em primeiro.
  - soma de PRs em todos os grupos = `items.length` (nenhuma duplicada, nenhuma perdida).
  - `epicLinks`: card com pai épico, card subtarefa (pai história → `climb`), card sem pai (`null`), issue que é épico.
  - `epicJqlFor(['MLK-1','UTF-8x','MLK-2'])` === `'key in (MLK-1,MLK-2)'`.
- [ ] **Step 2:** `cd extensions/pr-widget@pedrourio.github.io && gjs -m check.js` → FALHA (import não existe).
- [ ] **Step 3:** implementar as funções e mudanças acima em `logic.js`; `groupPrs(..., 'epic')` não existe — a aba épico chama `groupByEpic`.
- [ ] **Step 4:** `gjs -m check.js` → todos `ok`; `cd ../jira-widget@pedrourio.github.io && gjs -m check.js` → todos `ok`.
- [ ] **Step 5:** commit `pr-widget: regra da aba Por épico (trunk, satélites, épico do Jira)`.

### Task 2: busca dos épicos no Jira com cache (`epics.js`)

**Files:**
- Create: `extensions/pr-widget@pedrourio.github.io/epics.js`
- Test: `check.js` (cache, com `now` e leitura/escrita injetadas)

**Interfaces:**
- Consumes: `epicLinks`, `epicJqlFor` (Task 1); do jira-widget, por caminho: `JiraClient` (`jira.js`), `lookupToken` (`secret.js`), `loadConfig` (`config.js`).
- Produces:
  - `EPICS_TTL_MS = 6 * 3600 * 1000`; `EPICS_CACHE = ~/.cache/pr-widget/epics.json` com `{card: {epic: {key,name}|null, at}}`.
  - `staleCards(cards, cache, now) -> string[]`: cards ausentes ou com `at` mais velho que o TTL (pura, testada).
  - `async loadEpics(cards, {jiraDir, now = Date.now()}) -> {epicOf: Map, error: string|null}`: lê o cache, busca só `staleCards` (1ª chamada com `epicJqlFor`, `fields: 'parent,issuetype,summary'`, `maxResults: 100`; 2ª só para os pais de `climb`), grava o cache e devolve o mapa. Sem `jiraDir`, sem config (`site`/`email`) ou sem token → devolve o que o cache tem e `error: 'jira'`; erro de rede → idem, com log, sem lançar.
- [ ] **Step 1:** testes de `staleCards`: card ausente → stale; `at` de 7 h atrás → stale; `at` de 1 h → fresco.
- [ ] **Step 2:** `gjs -m check.js` → FALHA.
- [ ] **Step 3:** implementar `epics.js` (imports do jira-widget com `await import(\`file://${jiraDir}/jira.js\`)`).
- [ ] **Step 4:** `gjs -m check.js` → ok; teste manual: `gjs -m -c "import {loadEpics} from './epics.js'; print(JSON.stringify([...(await loadEpics(['<um card real>'], {jiraDir: '<caminho do jira-widget>'})).epicOf]))"` imprime o épico; segunda execução não faz chamada (cache).
- [ ] **Step 5:** commit `pr-widget: épicos dos cards pelo Jira, com cache`.

### Task 3: aba "Por épico" no menu

**Files:**
- Modify: `extensions/pr-widget@pedrourio.github.io/extension.js` (render da lista, `_group`, atualização)
- Modify: `extensions/pr-widget@pedrourio.github.io/stylesheet.css`

**Interfaces:**
- Consumes: `groupByEpic`, `VIEWS` (Task 1); `loadEpics` (Task 2).
- Produces: nada para outras tarefas.

- [ ] **Step 1:** depois de cada atualização do GitHub, chamar `loadEpics(cards distintos de this._items, {jiraDir: Main.extensionManager.lookup('jira-widget@pedrourio.github.io')?.path})` sem bloquear o placar; guardar `this._epicOf`/`this._epicError` e re-renderizar só se a aba épico estiver aberta.
- [ ] **Step 2:** aba `epic`: lista vem de `groupByEpic(this._items, this._epicOf ?? new Map(), extraKeys)`. Cabeçalho do épico (classe `prw-epic-header`): bolinha, nome `KEY · resumo`, contador e à direita `N prontas · M merged · T PRs` (o trecho merged some com M = 0). Sub `card` (`prw-sub-header`): bolinha da cor do épico, nome do card, contador. Sub `trunk`: a linha da PR trunk (via `_row`) com etiqueta "trunk" (`prw-trunk-tag`) no lugar do subtítulo; satélites com o código do card antes do título. PRs dentro de subs com `prw-row-nested`. Recolher/expandir e busca (`_applyFilter`) funcionam nos dois níveis; `this._groupRefs` cobre cada sub. Com `this._epicError`, uma linha `prw-muted` "Jira não configurado: agrupando só por trunk" acima da lista.
- [ ] **Step 3:** CSS a partir do canvas (spec): `.prw-epic-header { background-color: #373e47; border-radius: 6px; margin-top: 12px; }` título `#ffffff` 700; `.prw-sub-header { padding: 4px 8px 4px 14px; }` sem fundo; `.prw-row-nested { margin-left: 56px; padding-left: 14px; border-left: 2px solid #444c56; }`; etiqueta trunk no estilo do `prw-counter`.
- [ ] **Step 4:** `ext-reload pr-widget@pedrourio.github.io` → ACTIVE; `journalctl --user -b --since "-2 min" -o cat | grep -i "pr-widget\|JS ERROR"` vazio; teste visual com o Pedro (abrir a aba e conferir com a prancheta B).
- [ ] **Step 5:** commit `pr-widget: aba Por épico no menu`.

### Task 4: `pr-status --view epic`, skill e README

**Files:**
- Modify: `bin/pr-status.js`, `claude-skills/pr-status/SKILL.md`, `README.md`

**Interfaces:**
- Consumes: `groupByEpic` (Task 1), `loadEpics` (Task 2) com `jiraDir` = `extensions/jira-widget@pedrourio.github.io` relativo ao script.
- [ ] **Step 1:** `--view epic`: imprime `## <épico> (N prontas · T PRs)`, `### trunk <repo>#<num>` ou `### <card>`, e as PRs com o formato atual recuadas dois espaços; satélites com `[<card>]` antes do título. Sem Jira: uma linha `(Jira não configurado: agrupando só por trunk)`. Atualizar o comentário de uso no topo.
- [ ] **Step 2:** `bin/pr-status --view epic` e `bin/pr-status` rodam sem erro; conferir que a soma das PRs bate com o total da primeira linha.
- [ ] **Step 3:** SKILL.md: quando usar `--view epic` (ordem de merge num trunk, PRs de um épico). README: aba "Por épico" na seção do pr-widget (Jira opcional, cache de 6 h, trunk/satélite).
- [ ] **Step 4:** os dois `check.js` → ok.
- [ ] **Step 5:** commit `pr-status: --view epic; README e skill`.
