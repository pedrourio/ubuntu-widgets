---
name: pr-status
description: Use when the user asks about their open GitHub PRs — "quais PRs estão abertas", "status das minhas PRs", "o que o reviewer pediu", "o que está pronto para merge", "quais PRs têm conflito", "tem PR esperando resposta minha?", "procura a PR de credencial" — or before deciding what to work on next. Runs the pr-status CLI (same rules as the pr-widget in the GNOME top bar) instead of querying gh PR by PR.
---

# pr-status

Uma chamada traz todas as PRs abertas do usuário com o status do reviewer autônomo, conflito e prontidão para merge. Não consulte PR por PR com `gh pr view`: o `pr-status` já faz isso numa consulta GraphQL.

```sh
pr-status                    # agrupado por status (urgência primeiro)
pr-status --view group       # agrupado pelos grupos do usuário / card
pr-status 1266               # busca por número (prefixo)
pr-status credencial cnpj    # busca por palavras no título ou repo
```

A saída começa com uma linha de contadores e depois lista cada PR com `repo#número [decisão, N reviews] flags`, o título e a URL. Leva cerca de 4 s quando o GitHub ainda não calculou os conflitos, porque o comando espera e consulta de novo.

## Como ler

- **Monitoradas por você**: PRs de outras pessoas que o usuário pediu para acompanhar (`extra` no config). Ficam sempre nesta seção, no topo, fora das seções de status.
- **Pedem sua resposta**: o reviewer deu WARN ou pediu mudanças e falou depois do último commit ou comentário do usuário. É a fila de ação.
- **Aguardando <reviewer>**: o usuário já respondeu e falta o reviewer revisar de novo.
- **Prontas para merge**: decisão PASS e o GitHub libera o merge.
- **Com conflito**: precisa de rebase/merge da branch de destino antes de qualquer outra coisa.
- Cada PR aparece numa seção só, na ordem acima.

## Ao responder

- Comece pela fila de ação (pedem resposta), depois conflitos, depois o resto. Cite `repo#número` com o link.
- Para detalhar o que o reviewer pediu numa PR, leia o último review dele: `gh api repos/<org>/<repo>/pulls/<n>/reviews --jq '.[-1].body'` e o comentário de review mais recente da PR.
- Monitoradas mostram `MERGED`/`FECHADA` quando não estão mais abertas; essas não contam nos contadores.
- `GitHub libera merge` = checks, aprovações obrigatórias e sem conflito. Só faça merge se o usuário pedir, PR a PR: `gh pr merge <n> -R <org>/<repo> --merge` (merge commit; squash não é aceito em todos os repos).
- Configuração (reviewer, org padrão, grupos) fica em `~/.config/pr-widget/config.json`; não edite sem o usuário pedir.
