// Regras do widget, sem dependências do GNOME: testáveis com `gjs -m check.js`.

const FRAGMENT = `fragment P on PullRequest {
  number title url state baseRefName headRefName mergeable mergeStateStatus
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
        head: pr.headRefName ?? null,
        fullRepo: pr.repository.nameWithOwner,
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

export const VIEWS = {status: 'Por status', group: 'Por grupo', epic: 'Por épico'};

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

// Trunk: a PR em cuja branch outra PR do mesmo repo mira. Devolve satélite → trunk raiz.
// Ciclos (A mira em B e B em A) ficam de fora: nenhuma das duas é raiz.
export function trunkOf(items) {
    const byHead = new Map(items.filter(p => p.head).map(p => [`${p.fullRepo}:${p.head}`, p]));
    const parent = new Map();
    for (const p of items) {
        const t = byHead.get(`${p.fullRepo}:${p.base}`);
        if (t && t.key !== p.key)
            parent.set(p.key, t.key);
    }
    const out = new Map();
    for (const k of parent.keys()) {
        const seen = new Set([k]);
        let root = parent.get(k);
        while (parent.has(root) && !seen.has(root)) {
            seen.add(root);
            root = parent.get(root);
        }
        if (!parent.has(root))
            out.set(k, root);
    }
    return out;
}

const summarize = prs => ({ready: prs.filter(p => p.ready).length, merged: prs.filter(p => p.state === 'MERGED').length, total: prs.length});

// Aba Por épico: épico (Jira) → trunk com satélites (branches) ou card → PRs. Cada PR aparece uma vez.
// epicOf: card → {key, name} | null. Monitoradas entram no épico/trunk; só as soltas ficam no topo.
export function groupByEpic(items, epicOf, extraKeys) {
    const roots = trunkOf(items);
    const byKey = new Map(items.map(p => [p.key, p]));
    const blocks = new Map(); // trunk → satélites
    for (const [sat, root] of roots)
        blocks.set(root, [...(blocks.get(root) ?? []), byKey.get(sat)]);
    const epics = new Map();
    const epicGroup = e => {
        if (!epics.has(e.key))
            epics.set(e.key, {id: `epic-${e.key}`, kind: 'epic', name: `${e.key} · ${e.name}`, color: hashColor(e.key), subs: [], cards: new Map()});
        return epics.get(e.key);
    };
    const trunks = [];
    for (const [root, sats] of blocks) {
        const t = byKey.get(root);
        const sub = {id: `trunk-${t.key}`, kind: 'trunk', name: t.card ?? `${t.repo} #${t.num}`, trunk: t, prs: sats};
        const e = t.card && epicOf.get(t.card);
        if (e)
            epicGroup(e).subs.push(sub);
        else
            trunks.push({id: sub.id, kind: 'trunk', name: sub.name, color: hashColor(t.key), subs: [sub]});
    }
    const placed = new Set([...blocks.keys(), ...roots.keys()]);
    const extra = [], noepic = new Map(), nocard = [];
    for (const p of items.filter(p => !placed.has(p.key))) {
        const e = p.card && epicOf.get(p.card);
        if (e) {
            const g = epicGroup(e);
            g.cards.set(p.card, [...(g.cards.get(p.card) ?? []), p]);
        } else if (extraKeys.has(p.key)) {
            extra.push(p);
        } else if (p.card) {
            noepic.set(p.card, [...(noepic.get(p.card) ?? []), p]);
        } else {
            nocard.push(p);
        }
    }
    const cardSubs = (m, color) => [...m].map(([card, prs]) => ({id: `card-${card}`, kind: 'card', name: card, color, prs}));
    const all = g => g.subs.flatMap(s => [...(s.trunk ? [s.trunk] : []), ...s.prs]);
    const epicList = [...epics.values()].map(({cards, ...g}) => {
        g.subs.push(...cardSubs(cards, g.color));
        return {...g, summary: summarize(all(g))};
    }).sort((a, b) => b.summary.ready - a.summary.ready || a.id.localeCompare(b.id));
    const nogroup = {id: 'noepic', kind: 'noepic', name: 'Sem épico', color: '#9a9996', subs: cardSubs(noepic, '#9a9996')};
    return [
        {id: 'extra', kind: 'extra', name: 'Monitoradas por você', color: '#dc8add', prs: extra, summary: summarize(extra)},
        ...epicList,
        ...trunks.map(g => ({...g, summary: summarize(all(g))})),
        {...nogroup, summary: summarize(all(nogroup))},
        {id: 'nocard', kind: 'nocard', name: 'Sem card', color: '#77767b', prs: nocard, summary: summarize(nocard)},
    ].filter(g => g.summary.total);
}

// Resposta de /search/jql (fields=parent,issuetype,summary) → épico de cada card, ou o pai para subir mais um nível.
export function epicLinks(issues) {
    const epics = new Map(), climb = new Map();
    for (const i of issues) {
        const par = i.fields.parent;
        if (i.fields.issuetype?.hierarchyLevel === 1)
            epics.set(i.key, {key: i.key, name: i.fields.summary});
        else if (!par)
            epics.set(i.key, null);
        else if (par.fields?.issuetype?.hierarchyLevel === 1)
            epics.set(i.key, {key: par.key, name: par.fields.summary});
        else
            climb.set(i.key, par.key);
    }
    return {epics, climb};
}

export const epicJqlFor = keys => `key in (${keys.filter(k => /^[A-Z][A-Z0-9]+-\d+$/.test(k)).join(',')})`;
