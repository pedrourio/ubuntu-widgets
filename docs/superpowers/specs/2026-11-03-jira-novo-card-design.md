# jira-widget: novo card com o Claude

Desenho no canvas de design: pranchetas "Jira · novo card com o Claude" e "Jira · novo card na barra e no menu".

## Por quê

Criar um card hoje é abrir o Jira, preencher campo por campo e escrever descrição e critérios do zero. A ideia é descrever o problema em uma ou duas frases pela barra do topo e deixar o Claude montar o card no formato do time, sem que nada chegue ao Jira antes da sua aprovação.

## Objetivos

- Pedido curto (uma ou duas frases; aceita link de PR, print colado ou trecho de log) a partir do menu do jira-widget.
- Cada campo — tipo, sprint, épico, responsável, pontos, prioridade, descrição, critérios de aceite — pode ser fixado por você ou ficar com o Claude.
- Prévia que espera aprovação: o que o Claude escolheu leva ✦ e um porquê curto; todos os campos são editáveis à mão; um campo de ajuste com botão Enviar pede mudanças ao Claude ("é história, não bug").
- Gerar não prende o menu: fecha, a barra mostra o estado (✦ pulsando, ✦ N laranja, ✦ ! vermelho) e uma notificação avisa quando a prévia fica pronta.
- Publicar cria o card no Jira e mostra o link.

## Não objetivos

- Editar cards existentes, mudar status, dividir um card em vários (o ajuste pode sugerir, mas publica um card por prévia).
- Sub-tarefas, anexos e campos além dos oito acima.
- Ícone novo na barra: o ✦ entra na pílula do Jira que já existe.

## Anti-objetivos (falha mesmo funcionando)

- Algo chegar ao Jira sem o clique em Publicar.
- O Claude mudar um campo que você editou ou fixou. Editar à mão não dispara reavaliação; só o campo de ajuste pede mudanças ao Claude, e mesmo aí os campos fixados por você ficam.
- O token do Jira passar pelo Claude, por arquivo ou por log.
- Nome de empresa, site, projeto ou board no código (só no `~/.config/jira-widget/config.json`).

## Como (decidido)

- **Quem publica é o widget, não o Claude.** O Claude só devolve a prévia em JSON; o widget cria o card com o `JiraClient` que já existe (`POST /rest/api/3/issue`), com o token do chaveiro. Mesmo padrão do `pr-resolve`: o agente propõe, o código confere e envia.
- **Claude sem interação:** `claude -p --output-format json --json-schema <schema>`, ferramentas só de leitura (`Read Grep Glob`), rodando na pasta de código configurada. O ajuste retoma a mesma conversa (`--resume <session-id>`), então ele lembra do que já investigou.
- **Contexto vem do widget, não de MCP:** antes de chamar o Claude, o widget busca no Jira e passa no prompt as sprints abertas e a próxima, os épicos abertos, as pessoas do time e até ~5 cards parecidos (busca por texto via JQL), com tipo, épico e pontos de cada um. O Claude escolhe só entre o que veio nessa lista.
- **Entrada:** botão "✦ Novo card" no cabeçalho do menu, ao lado da engrenagem, e Ctrl+N com o menu aberto. O formulário e a prévia abrem no lugar do conteúdo do menu; Esc volta para a sprint sem perder o que está pendente.
- **Pendências:** faixa abaixo da busca por pedido ("Gerando · 18 s · cancelar" ou "Prévia pronta · Revisar"), a mais antiga em cima. Pendências sobrevivem a fechar o menu, mas não a recarregar o shell.

## Config (novas chaves)

- `codeDir`: pasta onde o Claude roda e lê código (ex.: a pasta com os repositórios do time).
- `cardGuide` (opcional): caminho de um arquivo com o modelo de card do time (seções da descrição, formato dos critérios, régua de qualidade). Se existir, o Claude segue e devolve a nota; sem ele, usa um modelo padrão curto e não mostra nota.

## Deixado para quem constrói

- Formato exato do JSON Schema da prévia e como os "porquês" chegam nele.
- Conversão de descrição e critérios para ADF (formato de texto do Jira).
- Como mostrar o progresso enquanto gera (linha de passos via `stream-json` ou só o tempo correndo).
- Limite de pedidos simultâneos e timeout do `claude -p`.
- Onde ficam os testes: regras puras (montar o prompt, validar a prévia, montar o corpo do POST) em `logic.js`, testadas no `check.js`.

## Decisões do Claude (conferir)

- Print colado vai só como contexto para o Claude (salvo em arquivo temporário e lido por ele); não vira anexo do card.
- Responsável que o Claude escolhe sai das pessoas de `team` no config; pontos usam o `pointsField` que já existe.
- Sprint entra depois de criar o card (`POST /rest/agile/1.0/sprint/{id}/issue`); épico vai como `parent`.
- Com "Eu escrevo" em descrição ou critérios, aparece uma caixa de texto no formulário; o Claude não reescreve, só usa como contexto.
- Modelo: o padrão do `claude` instalado; sem escolha na interface.
