# jira-widget: novo card com o Claude — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Do menu do jira-widget, descrever um problema em uma frase, deixar o Claude montar o card (com os campos que você fixar) e publicar no Jira só depois de aprovar a prévia.

**Architecture:** Regras puras novas em `logic.js` (prompt, schema, mescla com campos fixados, corpo do POST em ADF), testadas no `check.js`. `claude.js` roda `claude -p` como subprocesso e devolve `{sessionId, output}`. `extension.js` busca o contexto no Jira, guarda os pedidos pendentes em memória, desenha formulário, faixas e prévia no lugar do conteúdo do menu, e publica com o `JiraClient` que já existe.

**Tech Stack:** GJS ESM, GNOME Shell 50, St/Clutter, Soup 3 (`JiraClient`), `Gio.Subprocess`, `claude` CLI (`-p --output-format json --json-schema`, `--resume`).

**Spec:** `docs/superpowers/specs/2026-11-03-jira-novo-card-design.md` · desenho: pranchetas "Jira · novo card com o Claude" e "Jira · novo card na barra e no menu" no canvas.

## Global Constraints

- Nada chega ao Jira sem o clique em **Publicar no Jira**. O Claude não recebe token nem ferramenta de escrita: `--tools Read Grep Glob`.
- Campo fixado ou editado por você nunca é mudado pelo Claude: `mergePreview` sobrescreve com os fixados depois de toda resposta (inclusive ajustes). Editar à mão não chama o Claude.
- Nada de site, org, projeto, board ou nome de skill interna no código; fixtures usam `ACME`. Chaves novas no config: `codeDir` (padrão `''` = pasta home), `cardGuide` (padrão `''`).
- Token só no chaveiro (já é assim via `_getClient`).
- Pontos permitidos: `[1, 2, 3, 5, 8, 13]`. Timeout do `claude -p`: 180 s. Contexto do Jira em memória por 1 h.
- Textos da interface iguais ao desenho: "✦ Novo card", "Gerar prévia", "Gerando prévia…", "Prévia pronta", "Revisar", "AGUARDANDO APROVAÇÃO", "Por que o Claude escolheu", "Pedir ajuste ao Claude…", "Enviar", "Descartar", "Publicar no Jira", "Claude decide"/"Eu defino", "Claude escreve"/"Eu escrevo".
- Cores: ✦ `#f0a868`; badge pronta `#e0823d` com texto `#1d2125`; erro `#f87168`; faixa pronta `#3d2a1a` borda `#7a4a24`.
- `GTypeName` derivado de `import.meta.url` em qualquer `registerClass` novo. Depois de cada task que toca a extensão: `gjs -m check.js` sem falha e `ext-reload jira-widget@pedrourio.github.io` imprime `ACTIVE`.

## Review Focus

1. Claude devolve valor fora das listas (épico inexistente, pessoa fora do time, 4 pontos) → campo vira vazio e perde o ✦, não vai para o POST. (Task 1: teste de `mergePreview`.)
2. Ajuste do Claude tenta mudar um campo fixado ou editado → valor seu fica. (Task 1: teste de `mergePreview` com `fixed`.)
3. `claude` ausente, deslogado, erro ou passa de 180 s → pedido fica "falhou" (✦ ! na barra) com a última linha do erro; Descartar limpa. (Task 2: `runClaude` rejeita; Task 3: estado `error`.)
4. Publicar falha (400 por campo fora da tela de criação, rede) → continua na prévia com a mensagem, nada perdido; botão desabilitado enquanto publica, sem card duplicado por clique duplo. (Task 5.)
5. Fechar o menu no meio da geração → continua; Cancelar mata o subprocesso; reabrir mostra a faixa certa. (Task 3/4.)

---

### Task 1: Regras puras do card em `logic.js`

**Files:**
- Modify: `extensions/jira-widget@pedrourio.github.io/logic.js` (fim do arquivo)
- Test: `extensions/jira-widget@pedrourio.github.io/check.js` (novo bloco `// novo card` antes do último `ok`)

**Interfaces:**
- Produces:
  - `CARD_FIELDS = ['type', 'sprint', 'epic', 'assignee', 'points', 'priority', 'description', 'criteria']`
  - `POINTS = [1, 2, 3, 5, 8, 13]`
  - `similarJql(text: string, project: string) → string|null` — até 4 palavras com ≥ 4 letras, maiores primeiro, `project = P AND text ~ "<palavras>" ORDER BY updated DESC`, aspas e barra escapadas como em `toJql`; `null` sem palavra útil.
  - `ctx` (formato que a Task 3 monta): `{types: string[], priorities: string[], sprints: [{id: number, name: string}], epics: [{key, summary}], people: [{id, name}], similar: [{key, summary, type, epic, points}]}`
  - `previewSchema(ctx) → object` — JSON Schema: `summary` string; `type` enum `ctx.types`; `sprint` enum `ctx.sprints` ids como string + `"backlog"`; `epic` enum keys + `""`; `assignee` enum ids + `""`; `points` enum `POINTS`; `priority` enum `ctx.priorities`; `description` string; `criteria` string[]; `why` objeto com string opcional por campo; `score` `{value: int, max: int}` opcional. `required`: summary, type, description, criteria.
  - `cardPrompt({text, fixed, ctx, guide, image}) → string` — inclui o pedido, `ctx` em JSON, os fixados com "não mude estes campos", o modelo (`guide` ou modelo padrão curto: contexto, comportamento atual, esperado; critérios "Dado/quando/então"), caminho do print se houver, "responda em português", "explique em `why` cada campo que você escolheu, em até 10 palavras", "use Read/Grep/Glob para achar onde está no código e cite o caminho na descrição".
  - `mergePreview(out, fixed, ctx) → {values: {…CARD_FIELDS, summary}, ai: Set<string>, why, score}` — fixados vencem; valor fora das listas de `ctx` vira `''`/`null` e sai de `ai`; `ai` = campos em `CARD_FIELDS` não fixados e com valor.
  - `toAdf(description: string, criteria: string[]) → object` — `{type: 'doc', version: 1, content: [...parágrafos por linha em branco, heading nível 3 "Critérios de aceite", orderedList]}`.
  - `issueBody(values, {project, pointsField}) → object` — `{fields: {project: {key}, summary, issuetype: {name}, description: toAdf(...), parent?: {key}, assignee?: {accountId}, priority?: {name}, [pointsField]?: n}}`; omite vazios; sprint não entra (vai depois, Task 5).

- [ ] **Step 1: Escrever os testes**

```js
// novo card
assert(similarJql('o filtro por CAT ignora grupo', 'ACME') === 'project = ACME AND text ~ "filtro ignora grupo" ORDER BY updated DESC', 'parecidos: palavras úteis, maiores primeiro');
assert(similarJql('a de um', 'ACME') === null, 'sem palavra útil, sem busca');
const ctx = {types: ['Bug', 'História'], priorities: ['Alta', 'Média'], sprints: [{id: 29, name: 'Sprint 29'}], epics: [{key: 'ACME-1', summary: 'Relatórios'}],
    people: [{id: 'u1', name: 'Eu'}], similar: []};
const s = previewSchema(ctx);
assert(s.properties.sprint.enum.join() === '29,backlog' && s.properties.points.enum.join() === '1,2,3,5,8,13', 'schema com as listas');
const out = {summary: 'X', type: 'Bug', sprint: '29', epic: 'ACME-9', assignee: 'u1', points: 4, priority: 'Alta', description: 'd', criteria: ['c'], why: {type: 'bug'}};
const m = mergePreview(out, {assignee: 'u1', sprint: '29'}, ctx);
assert(m.values.epic === '' && !m.ai.has('epic'), 'épico fora da lista some');
assert(m.values.points === null && !m.ai.has('points'), 'pontos fora da escala somem');
assert(m.ai.has('type') && !m.ai.has('assignee') && !m.ai.has('sprint'), 'fixados não levam ✦');
assert(mergePreview({...out, assignee: ''}, {assignee: 'u1'}, ctx).values.assignee === 'u1', 'Claude não muda fixado');
const body = issueBody({...m.values, points: 3, epic: 'ACME-1'}, {project: 'ACME', pointsField: 'customfield_1'});
assert(body.fields.project.key === 'ACME' && body.fields.parent.key === 'ACME-1' && body.fields.customfield_1 === 3 && !('sprint' in body.fields), 'corpo do POST');
assert(!('parent' in issueBody({...m.values, epic: ''}, {project: 'ACME', pointsField: ''}).fields), 'sem épico, sem parent');
const adf = toAdf('a\n\nb', ['c1', 'c2']);
assert(adf.content.length === 4 && adf.content[2].type === 'heading' && adf.content[3].content.length === 2, 'ADF: 2 parágrafos, título, lista');
assert(cardPrompt({text: 'pedido', fixed: {sprint: '29'}, ctx, guide: '', image: null}).includes('pedido'), 'prompt leva o pedido');
ok('novo card');
```

- [ ] **Step 2:** `cd extensions/jira-widget@pedrourio.github.io && gjs -m check.js` → falha no import (`similarJql` não exportado).
- [ ] **Step 3:** Implementar as funções acima em `logic.js` (reusar o `quote` que já existe para o JQL). Adicionar os nomes ao `import` do `check.js`.
- [ ] **Step 4:** `gjs -m check.js` → todas as linhas `ok:`, incluindo `ok: novo card`.
- [ ] **Step 5:** Commit `jira-widget: regras do novo card (prompt, schema, prévia, corpo do POST)`.

### Task 2: `claude.js` — rodar o Claude sem interação

**Files:**
- Create: `extensions/jira-widget@pedrourio.github.io/claude.js`
- Create (scratch, fora do repo): um `try-claude.js` de uso manual

**Interfaces:**
- Produces: `runClaude({prompt: string, schema: object, cwd: string, resume?: string, cancellable?: Gio.Cancellable, timeoutSec = 180}) → Promise<{sessionId: string, output: object}>`
- Rejeita com `Error` de mensagem curta: `'claude não encontrado'`, `'tempo esgotado'`, `'cancelado'`, ou a última linha de stderr / `result` quando `is_error`.

- [ ] **Step 1:** Implementar: binário = `GLib.find_program_in_path('claude') ?? ~/.local/bin/claude` (o shell não tem `~/.local/bin` no PATH); argv `[bin, '-p', prompt, '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--tools', 'Read', 'Grep', 'Glob', ...(resume ? ['--resume', resume] : [])]` — prompt antes de `--tools`, que aceita vários valores. `Gio.SubprocessLauncher` com `set_cwd(cwd)`, flags `STDIN_PIPE | STDOUT_PIPE | STDERR_PIPE`, `communicate_utf8_async(null, …)` (fecha a entrada). Timeout e `cancellable` chamam `force_exit()`. Sucesso = JSON com `structured_output` e `session_id`.
- [ ] **Step 2:** Verificação manual: `try-claude.js` chama `runClaude` com um schema `{tipo: enum Bug|História}` em `GLib.MainLoop` e imprime o resultado; `gjs -m try-claude.js` → imprime `sessionId` e `{tipo: …}`. Repetir com `timeoutSec: 1` → `tempo esgotado`.
- [ ] **Step 3:** Commit `jira-widget: claude.js roda claude -p com saída estruturada`.

### Task 3: Contexto do Jira, pedidos pendentes e ✦ na barra

**Files:**
- Modify: `extensions/jira-widget@pedrourio.github.io/extension.js` (`_init`, `_updatePill`, `destroy`; métodos novos)
- Modify: `extensions/jira-widget@pedrourio.github.io/config.js` (`DEFAULTS`: `codeDir: ''`, `cardGuide: ''`)
- Modify: `extensions/jira-widget@pedrourio.github.io/stylesheet.css` (`.jw-ai`, `.jw-ai-ready`, `.jw-ai-error`)

**Interfaces:**
- Consumes: Task 1 (`similarJql`, `previewSchema`, `cardPrompt`, `mergePreview`), Task 2 (`runClaude`).
- Produces:
  - `async _cardContext(text) → ctx` — com o `JiraClient` de `_getClient()`: sprints `GET /rest/agile/1.0/board/{boardId}/sprint?state=active,future`; épicos `project = P AND issuetype = Epic AND statusCategory != Done` (summary); pessoas: você + `cfg.team` via `GET /rest/api/3/user/bulk?accountId=…`; tipos `GET /rest/api/3/issue/createmeta/{project}/issuetypes` (sem subtarefa); prioridades `GET /rest/api/3/priority`; `similar` pelo `similarJql` (até 5, com `issuetype`, `parent`, `pointsField`). Tudo menos `similar` guardado 1 h em `this._ctxCache`.
  - `this._drafts: Draft[]`, `Draft = {id, text, fixed, image, status: 'gen'|'ready'|'error', startedAt, sessionId, preview, error, cancel: Gio.Cancellable}`
  - `_startDraft(text, fixed, image)`, `_adjustDraft(draft, message)`, `_cancelDraft(draft)`, `_dropDraft(draft)` — cada um termina em `_updatePill()` e `_renderWhenClosed()`; pronto → `Main.notify('Prévia do card pronta', summary)`.
- [ ] **Step 1:** Implementar `_cardContext` e os métodos de pedido. `_adjustDraft` chama `runClaude` com `resume: draft.sessionId` e o prompt "Ajuste pedido: <mensagem>. Campos fixados (não mude): <json>", e passa a resposta por `mergePreview` com `fixed` = fixados do pedido + campos editados na prévia.
- [ ] **Step 2:** Pílula: um `St.Label` `this._aiLabel` depois dos lozenges: oculto sem pedidos; `✦` com classe `jw-ai` e opacidade pulsando (`ease` de 1 s, só enquanto há `gen`); `✦ N` com `jw-ai-ready` quando há `ready`; `✦ !` com `jw-ai-error` quando há `error` (prioridade: error > ready > gen). `destroy` cancela todos os `cancel`.
- [ ] **Step 3:** Verificação: ligar temporariamente `_startDraft('teste do botão salvar', {}, null)` no `_init`, `ext-reload` → barra mostra ✦ pulsando e depois `✦ 1` + notificação. Remover a linha.
- [ ] **Step 4:** `gjs -m check.js` ok, `ext-reload` → `ACTIVE`. Commit `jira-widget: pedidos de card ao Claude e estado na barra`.

### Task 4: Entrada — botão, Ctrl+N, formulário e faixas

**Files:**
- Modify: `extensions/jira-widget@pedrourio.github.io/extension.js` (`_render` e métodos novos `_renderForm`, `_draftStrip`)
- Modify: `extensions/jira-widget@pedrourio.github.io/stylesheet.css`

**Interfaces:**
- Consumes: Task 3 (`_drafts`, `_startDraft`, `_cancelDraft`, `_cardContext` para preencher os seletores de "Eu defino").
- Produces: `this._view: 'sprint' | 'form' | {draft}` — `_render()` desenha o conteúdo de acordo com `_view`; Esc em `form`/prévia volta para `'sprint'` sem apagar pedidos.

- [ ] **Step 1:** No cabeçalho, antes da engrenagem: botão "✦ Novo card" (✦ em `#f0a868`). Ctrl+N com o menu aberto (`key-press-event` no `this.menu.actor`) faz o mesmo.
- [ ] **Step 2:** `_renderForm()`: campo de texto multilinha com foco ("Uma ou duas frases bastam. Pode colar link de PR, print ou trecho de log."); Ctrl+V com imagem na área de transferência (`St.Clipboard.get_content(CLIPBOARD, 'image/png', …)`) salva em `~/.cache/jira-widget/print-<id>.png` e mostra "print anexado ✕". Oito linhas, uma por campo de `CARD_FIELDS`, com seletor de dois estados ("✦ Claude decide"/"Eu defino"; descrição e critérios "✦ Claude escreve"/"Eu escrevo"); "Eu defino" mostra o seletor de valores de `ctx` (ou caixa de texto para descrição/critérios). Rodapé: "O Claude consulta o Jira e o código. Nada vai para o Jira sem sua aprovação." + "Gerar prévia" (desabilitado com texto vazio) → `_startDraft` e volta para `'sprint'`.
- [ ] **Step 3:** `_draftStrip(draft)` abaixo da busca, mais antigo em cima: `gen` → "✦ Gerando · <texto> · <s> s · cancelar"; `ready` → "✦ Prévia pronta · <summary> · há N min · Revisar"; `error` → "✦ Falhou · <erro> · Descartar". Revisar → `_view = {draft}`. O contador de segundos só anda com o menu aberto.
- [ ] **Step 4:** `ext-reload` → `ACTIVE`; abrir o menu, Ctrl+N, gerar um pedido, fechar o menu, reabrir: faixa "Gerando" e depois "Prévia pronta". Commit `jira-widget: botão novo card, formulário e faixas de pendência`.

### Task 5: Prévia, ajuste e publicação

**Files:**
- Modify: `extensions/jira-widget@pedrourio.github.io/extension.js` (método novo `_renderPreview(draft)`, `_publish(draft)`)
- Modify: `extensions/jira-widget@pedrourio.github.io/stylesheet.css`

**Interfaces:**
- Consumes: Task 1 (`issueBody`), Task 3 (`_adjustDraft`, `_dropDraft`), `JiraClient.post`.

- [ ] **Step 1:** `_renderPreview(draft)` seguindo a prancheta: lozenge "AGUARDANDO APROVAÇÃO" e, se houver `score`, "nota N/M na régua de card"; título editável; chips com ✦ nos campos em `ai`; grade de seletores editáveis (tipo, sprint, épico, responsável, pontos, prioridade); descrição e critérios editáveis; bloco "Por que o Claude escolheu" com `why` de cada campo em `ai`; campo "Pedir ajuste ao Claude…" + "Enviar" (Enter também) → `_adjustDraft`; "Descartar" e "Publicar no Jira". Editar um campo grava em `draft.preview.values`, tira o campo de `ai` e o põe em `draft.edited` (entra como fixado no próximo ajuste).
- [ ] **Step 2:** `_publish(draft)`: desabilita o botão ("Publicando…"); `POST /rest/api/3/issue` com `issueBody(values, cfg)`; se `sprint` for id, `POST /rest/agile/1.0/sprint/{id}/issue` com `{issues: [key]}`; sucesso → `Main.notify('Card criado', '<KEY> · <summary>')` com abrir no navegador, `_dropDraft`, volta para `'sprint'`; falha → reabilita, mostra a mensagem do Jira (`errors`/`errorMessages` da resposta, sem token) e mantém a prévia. Se o card foi criado mas a sprint falhou, avisa "Card <KEY> criado, mas não entrou na sprint" e não tenta de novo.
- [ ] **Step 3:** Verificação ponta a ponta no Jira real: criar um card de teste ("teste do widget, pode apagar") com a sprint fixada, conferir no Jira tipo, épico, pontos, descrição com a lista de critérios e a sprint; apagar o card de teste no Jira à mão.
- [ ] **Step 4:** `gjs -m check.js` ok, `ext-reload` → `ACTIVE`. Atualizar o `README.md` (seção do jira-widget: o botão, o ✦ na barra, `codeDir` e `cardGuide` no config). Commit `jira-widget: prévia editável, ajuste com o Claude e publicação`.
