# pr-widget: aba "Por épico", com trunk e satélites

Desenho no canvas de design: prancheta "PRs · agrupar por épico", versão **B** (já com os ajustes do Pedro). Cópia local do HTML: `/tmp/claude-1000/-home-pedro/8dcc1fc5-3751-4ce7-a540-ada954793a17/scratchpad/artifact-files/710499bf-4c61-4193-8dee-7acf5b269ee9/project/PrsPorEpico.dc.html` (segunda coluna). Em resumo:
- cabeçalho do épico: fundo `#373e47`, borda arredondada 6px, 12px de espaço acima, título branco em negrito, contador e o resumo à direita;
- subtítulo do card: sem fundo, recuado 14px, bolinha da cor do épico, nome e contador;
- PR: recuada 56px, com uma linha de 2px `#444c56` à esquerda; bolinha do estado mais à direita que a do subtítulo;
- trunk: no lugar de um subtítulo de card, a linha da PR trunk com a etiqueta "trunk"; as satélites recuadas embaixo, como as PRs de um card, com o código do card antes do título.

## Por quê

O Pedro trabalha em trunk: cada card de um épico abre a própria PR, e muitas vezes uma PR mira na branch de outra. Hoje a lista do widget não mostra que essas PRs são o mesmo trabalho, então não dá para ver de relance quais PRs do épico estão prontas nem em que ordem mergear.

## Objetivos

- Aba nova **Por épico**, ao lado de "Por status" e "Por grupo".
- **Etapa 1, Jira:** cada PR com card no título (`cardPattern`, ex.: MLK-123) é agrupada pelo épico do card. Dentro do épico, um subgrupo por card.
- **Etapa 2, branches:** se a branch base de uma PR é a branch head de outra PR da lista, a de base é o **trunk** e a outra é a **satélite**. Dentro do épico, o trunk vira o primeiro nível (etiqueta "trunk") e as satélites ficam recuadas embaixo dele, cada uma com o código do card. PRs do épico fora de qualquer trunk continuam nos subgrupos por card.
- Cabeçalho do épico: "N prontas · M merged · T PRs".
- Cada linha de PR é a mesma das outras abas: estado, reviewer, botões de Merge, resolver e desmonitorar.
- `pr-status --view epic` mostra a mesma visão no terminal; a skill `pr-status` e o README dizem como usar.

## Não objetivos

- Buscar PRs que o widget não lista hoje (de colegas que você não monitora). A aba reorganiza só as PRs que já estão no widget.
- Sugerir ou automatizar a ordem de merge além do que a relação trunk/satélite já mostra.
- Editar épico ou card no Jira.

## Anti-objetivos

- **A etapa do Jira deixar o widget lento ou fazer chamada a cada atualização.** No máximo uma busca por atualização, mais uma para subir de subtarefa (JQL `key in (...)` com `fields=parent`), só para cards que ainda não estão no cache; o mapa card → épico fica em cache (arquivo em `~/.cache/pr-widget/`) por algumas horas. Jira fora do ar ou sem token não pode quebrar as outras abas nem atrasar o placar.
- Pedir login novo: usa o site, o email e o token que o jira-widget já guarda (`~/.config/jira-widget/config.json` e o chaveiro, schema `io.github.pedrourio.JiraWidget`).
- Nome de empresa, site, projeto ou board no código.
- Uma PR aparecer duas vezes na mesma aba.

## Casos de borda (decididos)

- Nesta aba, PRs monitoradas entram no épico ou no trunk a que pertencem (é comum a sua PR mirar a branch de um colega que você monitora); só as monitoradas sem épico e sem trunk ficam em "Monitoradas por você", no topo. A detecção de trunk roda sobre todas as PRs da lista, monitoradas incluídas.
- O "M merged" do cabeçalho conta as monitoradas já mergeadas (são as únicas mergeadas que o widget tem); com M = 0, o trecho some.
- Trunk sem épico no Jira (ou Jira indisponível): o trunk com as satélites aparece como grupo próprio, com o nome do card do trunk, porque a relação de branches basta para mostrar que andam juntas.
- Satélite de um card de outro épico: fica embaixo do trunk (é o que decide a ordem de merge); o código do card mostra a origem.
- Card sem épico: grupo "Sem épico", no fim. PR sem card no título: grupo "Sem card", depois.
- Sem config ou token do Jira: a aba funciona só com a etapa 2; os cards ficam em "Sem épico" e uma linha discreta avisa que o Jira não está configurado.

## Decisões do Claude (conferir)

- O pr-widget importa `jira.js` e `secret.js` do jira-widget pelo caminho instalado, como o jira-widget já faz com o `logic.js` do pr-widget. Sem jira-widget instalado, a aba fica só com a etapa 2.
- A consulta GraphQL passa a pedir também `headRefName` (o `baseRefName` já vem). O par base/head só liga PRs do mesmo repositório.
- Cadeia (satélite de satélite): um nível só; a satélite da satélite aparece embaixo do mesmo trunk raiz.
- O pai do card que não é épico (subtarefa → história) sobe mais um nível com uma segunda busca, só para os pais que não estão no cache; depois disso, sem épico.
- Ordem: épicos com mais PRs prontas primeiro; dentro do épico, trunks antes dos cards soltos.
- A regra de agrupar fica em `logic.js` (função pura, testada no `check.js`); a busca no Jira fica fora dela.

## Deixado para quem constrói

- Formato do grupo aninhado que `groupPrs` devolve para a aba nova, sem quebrar as outras duas.
- Tempo exato do cache e quando invalidá-lo.
- Como o `pr-status` imprime os níveis no terminal.
