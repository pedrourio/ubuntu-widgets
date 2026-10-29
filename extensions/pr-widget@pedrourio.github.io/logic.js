// Regras do widget, sem dependências do GNOME: testáveis com `gjs -m check.js`.

const FRAGMENT = `fragment P on PullRequest {
  number title url state baseRefName mergeable mergeStateStatus
  repository { nameWithOwner }
  reviews(last: 60) { nodes { author { login } state body submittedAt } }
  comments(last: 60) { nodes { author { login } createdAt } }
  commits(last: 1) { nodes { commit { committedDate } } }
}`;

// Uma consulta só: suas PRs abertas + as monitoradas à parte (aliases x0, x1…).
export function buildQuery(extra) {
    const parts = extra.map((key, i) => {
        const m = key.match(/^([^/]+)\/([^#]+)#(\d+)$/);
        return m ? `x${i}: repository(owner: ${JSON.stringify(m[1])}, name: ${JSON.stringify(m[2])}) { pullRequest(number: ${m[3]}) { ...P } }` : '';
    });
    return `${FRAGMENT}
query { viewer { login } search(query: "is:pr is:open author:@me archived:false", type: ISSUE, first: 100) { nodes { ...P } } ${parts.join(' ')} }`;
}

// PRs de um card (o título leva a chave; no corpo, outras PRs só citam o card): usado pelo jira-widget, mesmas regras de classify.
export function buildCardPrQuery(key, owner) {
    return `${FRAGMENT}
query { viewer { login } search(query: ${JSON.stringify(`${key} in:title org:${owner} is:pr`)}, type: ISSUE, first: 10) { nodes { ...P } } }`;
}

export function parsePrRef(text, defaultOwner = '') {
    const t = text.trim();
    let m = t.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/);
    if (m)
        return `${m[1]}/${m[2]}#${m[3]}`;
    m = t.match(/^(?:([\w.-]+)\/)?([\w.-]+)#(\d+)$/);
    const owner = m?.[1] ?? defaultOwner;
    return m && owner ? `${owner}/${m[2]}#${m[3]}` : null;
}

const maxDate = dates => dates.filter(Boolean).reduce((a, b) => (a > b ? a : b), '');

// Código de card no título; padrão = chave de issue do Jira (ABC-123).
export const DEFAULT_CARD_PATTERN = '\\b[A-Z][A-Z0-9]+-\\d+\\b';

// Decisão de um review do reviewer de IA: 'changes' | 'pass' | 'warn' | 'approved' | null.
export function reviewDecision(r) {
    if (r.state === 'CHANGES_REQUESTED')
        return 'changes';
    const decision = r.body?.match(/decision:\s*(PASS|WARN)/)?.[1];
    if (decision)
        return decision.toLowerCase();
    return r.state === 'APPROVED' ? 'approved' : null;
}

export function classify(pr, {me, reviewer, repoPrefix = '', cardPattern = DEFAULT_CARD_PATTERN}, prev) {
    const reviews = pr.reviews.nodes;
    const bot = reviews.filter(r => r.author?.login === reviewer);
    const last = bot.at(-1);
    const status = (last && reviewDecision(last)) ?? 'none';
    const myLast = maxDate([
        ...reviews.filter(r => r.author?.login === me).map(r => r.submittedAt),
        ...pr.comments.nodes.filter(c => c.author?.login === me).map(c => c.createdAt),
        pr.commits.nodes[0]?.commit.committedDate,
    ]);
    // mergeada ou fechada (só acontece com monitoradas) não pede nada a ninguém
    const state = pr.state ?? 'OPEN';
    const open = state === 'OPEN';
    const pending = open && (status === 'warn' || status === 'changes');
    const botSpokeLast = !!last && last.submittedAt > myLast;
    // O GitHub calcula conflito sob demanda: UNKNOWN mantém o último valor conhecido.
    const known = pr.mergeable !== 'UNKNOWN';
    const conflict = open && (known ? pr.mergeable === 'CONFLICTING' : !!prev?.conflict);
    const clean = open && (known ? pr.mergeStateStatus === 'CLEAN' : !!prev?.clean);
    return {
        key: `${pr.repository.nameWithOwner}#${pr.number}`,
        url: pr.url,
        repo: pr.repository.nameWithOwner.split('/')[1].replace(repoPrefix && new RegExp(`^${repoPrefix}`), ''),
        num: pr.number,
        title: pr.title,
        base: pr.baseRefName,
        state,
        status,
        reviews: bot.length,
        conflict,
        clean,
        needsReply: pending && botSpokeLast,
        waitingBot: pending && !botSpokeLast,
        ready: status === 'pass' && clean && !conflict,
        // o GitHub libera o merge (checks, aprovações obrigatórias, sem conflito): é o que vale para o botão
        canMerge: clean && !conflict,
        since: pending ? (botSpokeLast ? last.submittedAt : myLast) : null,
        card: pr.title.match(new RegExp(cardPattern))?.[0] ?? null,
    };
}

const AUTO_COLORS = ['#62a0ea', '#c061cb', '#cdab8f', '#dc8add', '#99c1f1', '#f9f06b'];
const hashColor = s => AUTO_COLORS[[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % AUTO_COLORS.length];

export const VIEWS = {status: 'Por status', group: 'Por grupo'};

// Cada PR aparece uma vez por visualização.
// status: a primeira situação que se aplica, na ordem de urgência.
// group: seus grupos, monitoradas, cards, sem grupo — nada de status misturado.
export function groupPrs(items, cfg, extraKeys, view = 'status') {
    const used = new Set();
    const take = pred => items.filter(p => !used.has(p.key) && pred(p)).map(p => (used.add(p.key), p));
    // PRs que você pediu para monitorar ficam num grupo só delas, no topo, nas duas visões
    const extra = {id: 'extra', name: 'Monitoradas por você', color: '#dc8add', prs: take(p => extraKeys.has(p.key))};
    if (view === 'status') {
        return [
            extra,
            {id: 'reply', name: 'Pedem sua resposta', color: '#ff7b63', prs: take(p => p.needsReply)},
            {id: 'waiting', name: `Aguardando ${cfg.reviewerName ?? 'reviewer'}`, color: '#ffa348', prs: take(p => p.waitingBot)},
            {id: 'ready', name: 'Prontas para merge', color: '#57e389', prs: take(p => p.ready), note: 'PASS e sem conflito'},
            {id: 'conflict', name: 'Com conflito', color: '#ff9ecb', prs: take(p => p.conflict)},
            {id: 'noreview', name: 'Sem review', color: '#9a9996', prs: take(p => p.status === 'none')},
            {id: 'others', name: 'Demais', color: '#77767b', prs: take(() => true), note: 'aprovadas, aguardando checks ou merge'},
        ].filter(g => g.prs.length);
    }
    const groups = [extra];
    for (const g of cfg.groups)
        groups.push({id: g.id, name: g.name, color: g.color, prs: take(p => cfg.assign[p.key] === g.id)});
    if (cfg.autoGroupByCard) {
        const byCard = new Map();
        for (const p of items.filter(p => !used.has(p.key) && p.card))
            byCard.set(p.card, [...(byCard.get(p.card) ?? []), p]);
        for (const [card, prs] of byCard) {
            if (prs.length > 1)
                groups.push({id: `card-${card}`, name: card, color: hashColor(card), prs: take(p => prs.includes(p))});
        }
    }
    groups.push({id: 'nogroup', name: 'Sem grupo', color: '#9a9996', prs: take(() => true)});
    return groups.filter(g => g.prs.length);
}

const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Só dígitos (com ou sem #) = número da PR; senão todas as palavras no título/repo, sem acento.
export function matchesQuery(p, query) {
    const q = fold(query.trim()).replace(/^#/, '');
    if (!q)
        return true;
    if (/^\d+$/.test(q))
        return String(p.num).startsWith(q);
    const hay = fold(`${p.title} ${p.repo}`);
    return q.split(/\s+/).every(t => hay.includes(t));
}

export function counts(all) {
    // monitoradas já mergeadas/fechadas aparecem na lista, mas não contam como abertas
    const items = all.filter(p => !p.state || p.state === 'OPEN');
    return {
        total: items.length,
        reply: items.filter(p => p.needsReply).length,
        waiting: items.filter(p => p.waitingBot).length,
        ready: items.filter(p => p.ready).length,
        conflict: items.filter(p => p.conflict).length,
        noReview: items.filter(p => p.status === 'none').length,
    };
}

export function relTime(iso, now = Date.now()) {
    const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
    if (min < 60)
        return `há ${min} min`;
    const h = Math.round(min / 60);
    if (h < 24)
        return `há ${h} h`;
    const d = Math.round(h / 24);
    return d === 1 ? 'há 1 dia' : `há ${d} dias`;
}
