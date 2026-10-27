# jira-widget: busca de cards e placar da sprint na barra do GNOME

Mockups aprovados: canvas "Widget de PRs", prancheta **"Jira · proposta padrão Jira"** (`JiraAtlassian.dc.html`), https://claude.ai/artifact/ExSnY9WvnPZAL3hxCeu6vc. A prancheta "padrão GitHub" ao lado foi a alternativa descartada.

## Intenção

O usuário precisa achar rápido qualquer card do Jira do time e sair dele com o link do card e a PR relacionada. Hoje isso exige abrir o Jira no navegador, buscar, abrir o card, rolar até as PRs. Além disso, quer bater o olho na barra e ver em que pé estão os cards dele na sprint, e ao abrir o menu ver o burndown da sprint.

Prioridade absoluta: custo baixo. Nada roda em segundo plano além de uma checagem leve a cada 15 minutos; a busca só consulta quando o usuário digita.

## Objetivos

1. **Ícone na barra** (lado esquerdo, logo depois do pr-widget): ícone do Jira, número da sprint ativa (`S28`) e um placar estilo KDA com a quantidade de cards **do usuário** na sprint ativa, uma posição por coluna do board, nesta ordem: To Do / In Progress / Code Review / Ready to Test / Testing / Ready to Deploy / Done.
   - Visual (decidido, ver mockup): cada número numa "lozenge" de canto quase reto (raio 3px). To Do: **laranja vazado** (só borda e número laranja). In Progress: azul. Code Review: roxo. Ready to Test: amarelo. Testing: azul-piscina. Ready to Deploy: rosa. Done: verde. Mostra zeros.
   - Atualiza a cada **15 minutos**. **Não** atualiza ao clicar (decisão do usuário: abrir não pode ficar mais lento).
2. **Menu aberto, sem digitar**: título "Sprint 28", lozenge "ATIVA", datas e dias restantes, caixa de busca com foco, e o **gráfico de burndown** da sprint (Story Points, linha "Restante" azul e linha "Diretriz" cinza), com a linha do restante **ondulando devagar como gelatina** enquanto o menu está aberto.
   - O burndown é **o dado do próprio Jira** (o mesmo do relatório de burndown da sprint), não um cálculo nosso sobre status. Segue a regra de concluído do board.
3. **Busca** aceita: `<PROJ>-4583`, `4583` (vira `<PROJ>-4583` (projeto do config)), palavra(s) do título, nome do épico. Escopo: **todos os cards do projeto**, de qualquer pessoa.
4. **Resultado**: o primeiro resultado vem aberto no formato "detalhe" do Jira; os demais em linha única (ícone do tipo, chave, título com reticências, lozenge do status). Clicar numa linha a abre (e fecha a anterior).
   - Card aberto mostra: caminho épico / chave, lozenge de status, título, **Responsável** (avatar com iniciais + nome), **Desenvolvimento** (PRs), **Anexos**.
   - **Anexos**: cada um é um **link clicável que abre a visualização do anexo no navegador** (o navegador já tem a sessão do Jira).
   - **PRs**: achadas buscando a chave do card no GitHub (o Jira desse site não tem as PRs ligadas ao card: links remotos vazios, conferido). Cada PR mostra repo, número e estado; PRs **abertas** mostram o status do reviewer com **as mesmas regras do pr-widget** (`logic.js`: WARN/PASS/mudanças, sua vez, aguardando reviewer, conflito, pronta). A consulta é **por demanda e escopada**: só quando o card é aberto, só as PRs daquele card.
   - Ações: **Abrir no Jira** (botão primário azul), **Copiar link**, **Abrir PR #n** (a primeira PR aberta; some se não houver).
5. Visual geral no **padrão do Jira** (Atlassian dark): fundo do menu `#282e33`, blocos `#22272b`, texto `#b6c2cf`/`#dee4ea`, secundário `#8c9bab`, azul `#579dff`, lozenges em caixa alta 11px negrito. Cores exatas no mockup.

## Não-objetivos

- Criar, editar, comentar ou mover cards. Só leitura.
- Notificações.
- CLI ou skill do Claude para o Jira (o pr-widget tem; aqui não foi pedido).
- Burndown de outras sprints, outros boards, ou placar do time.

## Anti-objetivos (falhou mesmo funcionando)

- Abrir o menu fica lento ou dispara rede antes de digitar.
- Animação gasta CPU com o menu fechado, ou rede/CPU contínuos além do ciclo de 15 min.
- Token do Jira em arquivo de texto ou no repositório.
- Nomes internos da empresa (site, org, projeto, board) no código: ficam no config do usuário, como no pr-widget.

## Restrições

- GNOME Shell 50, Wayland, extensão ESM. Repositório `~/ubuntu-widgets`, pasta `extensions/jira-widget@pedrourio.github.io/`. Seguir o `CLAUDE.md` do repo: `GTypeName` derivado de `import.meta.url` em todo `registerClass`; recarregar com `ext-reload` após mudanças; README atualizado no mesmo commit.
- Sem dependências novas: HTTP com **Soup 3** (`gi://Soup?version=3.0`), segredo com **libsecret** (`gi://Secret`), ambos com typelib instalado. GitHub via `gh` (já autenticado), como o pr-widget.
- Reusar `extensions/pr-widget@pedrourio.github.io/logic.js` para classificar PRs (fragmento GraphQL e `classify`), sem duplicar regra. A importação entre extensões precisa funcionar também nas cópias do `ext-reload` (não dá para usar caminho relativo `../pr-widget@…`, porque a cópia fica em `~/.cache/ext-reload/<uuid>/<carimbo>/<uuid>`). Caminho estável: `~/.local/share/gnome-shell/extensions/pr-widget@pedrourio.github.io/logic.js` via `file://`.
- Config em `~/.config/jira-widget/config.json`: `site` (ex.: `https://<org>.atlassian.net`), `email`, `boardId`, `project` (chave, ex.: `ABC`), `githubOwner`, `intervalMinutes` (padrão 15). Os valores reais do usuário ficam só no config dele (fora do repo).
- Token de API do Jira (Atlassian, Basic auth `email:token`) guardado no chaveiro via libsecret. Precisa de um jeito simples de cadastrar (prefs da extensão com campo de senha, ou comando `secret-tool store`); o menu, sem token, mostra o passo a passo em vez de erro.

## Fatos do Jira conferidos (para o builder não adivinhar)

- Board scrum do projeto (id no config). Sprint ativa no momento do design: "Sprint 28", 26–30/out. Campo sprint: `customfield_10020`. Story Points: `customfield_10028` (é o campo de estimativa do board).
- Colunas do board e status mapeados (endpoint público `GET /rest/agile/1.0/board/{id}/configuration`):
  1. Sprint Backlog → Tarefas pendentes, Triage, Backlog, In Analysis (= **To Do**)
  2. Running → Em progresso, Impedimento (= **In Progress**)
  3. Ready For Code Review → Ready to CodeReview
  4. Ready for testing → Ready to Test
  5. Testing → Teste
  6. Ready to Deploy → Ready to deploy
  7. Itens concluídos → DONE
  O placar deve **ler esse mapeamento do board** (por id de status), não fixar nomes no código; pode cachear por dia.
- Placar do usuário hoje: 11/0/0/10/1/2/4 (28 cards).
- Anexos vêm em `fields.attachment[]` com `filename`, `mimeType`, `id`. A URL `content` da API exige auth; para abrir no navegador use a visualização do Jira: `{site}/browse/{KEY}` não abre o anexo direto — o builder deve achar a URL de visualização que funciona com a sessão do navegador (candidatas: `{site}/rest/api/3/attachment/content/{id}` aberta no navegador logado, ou `{site}/secure/attachment/{id}/{filename}`) e testar.
- PRs: `gh search prs "<KEY>" --owner <githubOwner>` retorna as 3 PRs do card (títulos levam a chave). No widget, usar GraphQL `search(type: ISSUE, query: "<KEY> org:<owner> is:pr")` com o mesmo fragmento do `logic.js`, para ter os campos que o `classify` precisa.
- Burndown: não há endpoint público; o relatório do Jira usa `GET {site}/rest/greenhopper/1.0/rapid/charts/scopechangeburndownchart?rapidViewId={board}&sprintId={sprint}` (interno, aceita Basic auth). Ele devolve eventos de mudança no tempo; o builder converte em série "restante por dia" e a linha diretriz (início → zero no fim). Se o endpoint falhar, o bloco do gráfico some com uma linha "burndown indisponível", sem quebrar o resto.

## Como funciona (decidido)

- **Ciclo de 15 min** (e na carga da extensão): sprint ativa do board → issues da sprint com `status, assignee` (só para contar os do usuário) → burndown. Resultado vai para memória e para `~/.cache/jira-widget/state.json` (a barra aparece com o último valor ao logar, antes da primeira consulta). Nada mais roda periodicamente.
- **Abrir o menu**: só desenha a partir da memória. Zero rede.
- **Digitar**: espera ~400 ms sem digitar; cancela a consulta anterior em andamento; uma busca JQL com `fields` mínimos (summary, status, assignee, parent, issuetype, attachment). Número puro/`<PROJ>-n` vira busca por chave. Texto: título **ou** épico.
- **Abrir um card**: dispara a busca de PRs daquele card (uma chamada `gh`), mostra "buscando PRs…" no bloco Desenvolvimento e preenche quando chega.
- **Animação**: só com o menu aberto e só enquanto o bloco do burndown está visível (some ao digitar); para ao fechar. Respeita `org.gnome.desktop.interface enable-animations` (desligado = linha parada). Movimento suave e pequeno (poucos px), ciclo de ~3 s, como no mockup.

## Deixado para o builder

- Como desenhar o gráfico (St.DrawingArea + cairo é o caminho natural) e a taxa de quadros da animação (baixa; o usuário quer economia).
- Formato exato da busca por épico em JQL (pode ser duas consultas: épicos que casam, depois `parent in (...)`, ou outra forma que dê o mesmo resultado em ≤2 chamadas).
- Ícone do Jira na barra: SVG próprio, só preenchimento (lição do pr-widget: traço some em ícone symbolic), sem logo oficial.
- Quantos resultados mostrar (sugestão: 10) e o estado "nenhum card encontrado".
- Estados de erro (sem rede, token inválido, 401/403): mensagem curta no menu, barra mantém o último valor com indicação discreta.
- Navegação por teclado (setas/Enter nos resultados) no nível do pr-widget.

## Decisões tomadas por mim no lugar do usuário (conferir)

- Placar mostra zeros (o formato KDA pede todas as posições).
- Busca inclui cards de qualquer status, inclusive concluídos, ordenados pelo mais recentemente atualizado; até 10 resultados.
- O ícone fica logo depois do pr-widget (índice 4 na esquerda).
- Token cadastrado pelas preferências da extensão (campo de senha) e salvo no chaveiro; sem token, o menu explica onde gerar e onde colar.
- Para classificar PRs, o widget lê também o config do pr-widget (`~/.config/pr-widget/config.json`: reviewer, repoPrefix etc.), via o `config.js` dele no mesmo caminho estável do `logic.js`. Sem pr-widget instalado, as PRs aparecem só com repo, número e estado.
- Card sem responsável mostra "Sem responsável"; card sem PR mostra "Nenhuma PR encontrada no GitHub".
