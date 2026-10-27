// Regras do widget, sem dependências do GNOME: testáveis com `gjs -m check.js`.

const FRAGMENT = `fragment P on PullRequest {
  number title url baseRefName mergeable mergeStateStatus
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

export function classify(pr, {me, reviewer, repoPrefix = '', cardPattern = DEFAULT_CARD_PATTERN}, prev) {
    const reviews = pr.reviews.nodes;
    const bot = reviews.filter(r => r.author?.login === reviewer);
    const last = bot.at(-1);
    let status = 'none';
    if (last) {
        const decision = last.body?.match(/decision:\s*(PASS|WARN)/)?.[1];
        if (last.state === 'CHANGES_REQUESTED')
            status = 'changes';
        else if (decision)
            status = decision.toLowerCase();
        else if (last.state === 'APPROVED')
            status = 'approved';
    }
    const myLast = maxDate([
        ...reviews.filter(r => r.author?.login === me).map(r => r.submittedAt),
        ...pr.comments.nodes.filter(c => c.author?.login === me).map(c => c.createdAt),
        pr.commits.nodes[0]?.commit.committedDate,
    ]);
    const pending = status === 'warn' || status === 'changes';
    const botSpokeLast = !!last && last.submittedAt > myLast;
    // O GitHub calcula conflito sob demanda: UNKNOWN mantém o último valor conhecido.
    const known = pr.mergeable !== 'UNKNOWN';
    const conflict = known ? pr.mergeable === 'CONFLICTING' : !!prev?.conflict;
    const clean = known ? pr.mergeStateStatus === 'CLEAN' : !!prev?.clean;
    return {
        key: `${pr.repository.nameWithOwner}#${pr.number}`,
        url: pr.url,
        repo: pr.repository.nameWithOwner.split('/')[1].replace(repoPrefix && new RegExp(`^${repoPrefix}`), ''),
        num: pr.number,
        title: pr.title,
        base: pr.baseRefName,
        status,
        reviews: bot.length,
        conflict,
        clean,
        needsReply: pending && botSpokeLast,
        waitingBot: pending && !botSpokeLast,
        ready: status === 'pass' && clean && !conflict,
        since: pending ? (botSpokeLast ? last.submittedAt : myLast) : null,
        card: pr.title.match(new RegExp(cardPattern))?.[0] ?? null,
    };
}

const AUTO_COLORS = ['#62a0ea', '#c061cb', '#cdab8f', '#dc8add', '#99c1f1', '#f9f06b'];
const hashColor = s => AUTO_COLORS[[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % AUTO_COLORS.length];

// Cada PR aparece uma vez: automáticos no topo, depois grupos seus, monitoradas, cards, sem grupo.
export function groupPrs(items, cfg, extraKeys) {
    const used = new Set();
    const take = pred => items.filter(p => !used.has(p.key) && pred(p)).map(p => (used.add(p.key), p));
    const groups = [
        {id: 'reply', name: 'Pedem sua resposta', color: '#ff7b63', prs: take(p => p.needsReply)},
        {id: 'ready', name: 'Prontas para merge', color: '#57e389', prs: take(p => p.ready), note: 'PASS e sem conflito'},
    ];
    for (const g of cfg.groups)
        groups.push({id: g.id, name: g.name, color: g.color, prs: take(p => cfg.assign[p.key] === g.id)});
    groups.push({id: 'extra', name: 'Monitoradas por você', color: '#dc8add', prs: take(p => extraKeys.has(p.key))});
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

export function counts(items) {
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
