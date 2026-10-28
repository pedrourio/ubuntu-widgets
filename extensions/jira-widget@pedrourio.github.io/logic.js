// Regras do widget, sem dependências do GNOME: testáveis com `gjs -m check.js`.

// Ordem da barra = ordem das colunas do board (posição, não nome).
export const COLUMNS = ['todo', 'progress', 'review', 'ready', 'testing', 'deploy', 'done'];

export function columnMap(boardConfig) {
    const map = new Map();
    (boardConfig?.columnConfig?.columns ?? []).slice(0, COLUMNS.length).forEach((col, i) => {
        for (const s of col.statuses ?? [])
            map.set(String(s.id), COLUMNS[i]);
    });
    return map;
}

export function tally(issues, colMap, me) {
    const out = Object.fromEntries(COLUMNS.map(c => [c, 0]));
    for (const i of issues) {
        const col = colMap.get(String(i.fields?.status?.id));
        if (col && i.fields?.assignee?.accountId === me)
            out[col]++;
    }
    return out;
}

export function pickActiveSprint(sprints) {
    const s = (sprints ?? []).find(x => x.state === 'active');
    if (!s)
        return null;
    const m = s.name?.match(/(\d+)\s*$/);
    return {id: s.id, name: s.name, number: m ? Number(m[1]) : null, startDate: s.startDate, endDate: s.endDate};
}

export const daysLeft = (endIso, now = Date.now()) => Math.max(0, Math.ceil((Date.parse(endIso) - now) / 86400e3));

const quote = text => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}*"`;

// Número ou chave → busca exata; texto → título ou épico (épicos achados antes com epicJql).
export function toJql(query, project, epicKeys = []) {
    const q = (query ?? '').trim();
    if (!q)
        return null;
    if (/^\d+$/.test(q))
        return {jql: `key = ${project}-${q}`, byKey: true};
    if (/^[A-Z][A-Z0-9]+-\d+$/i.test(q))
        return {jql: `key = ${q.toUpperCase()}`, byKey: true};
    const parent = epicKeys.length ? ` OR parent in (${epicKeys.join(', ')})` : '';
    return {jql: `project = ${project} AND (summary ~ ${quote(q)}${parent}) ORDER BY updated DESC`, byKey: false};
}

export const epicJql = (query, project) => `project = ${project} AND issuetype = Epic AND summary ~ ${quote(query.trim())}`;

// Repassa os eventos do relatório de burndown do Jira (scopechangeburndownchart):
// restante = cards (ou pontos) no escopo e ainda não concluídos.
export function burndownSeries(raw, unit = 'points') {
    if (!raw?.changes || !raw.startTime || !raw.endTime)
        return null;
    const issues = new Map();
    const get = k => issues.get(k) ?? issues.set(k, {pts: 0, in: false, done: false}).get(k);
    const weight = i => unit === 'cards' ? 1 : i.pts;
    const remaining = () => [...issues.values()].reduce((sum, i) => sum + (i.in && !i.done ? weight(i) : 0), 0);
    const apply = ev => {
        const i = get(ev.key);
        if (ev.statC && 'newValue' in ev.statC)
            i.pts = Number(ev.statC.newValue) || 0;
        if ('added' in ev)
            i.in = ev.added;
        if (ev.column?.done)
            i.done = true;
        else if (ev.column?.notDone)
            i.done = false;
    };
    const times = Object.keys(raw.changes).map(Number).sort((a, b) => a - b);
    for (const t of times.filter(t => t <= raw.startTime))
        raw.changes[t].forEach(apply);
    const total = remaining();
    const points = [{t: raw.startTime, remaining: total}];
    const end = Math.min(raw.now ?? raw.endTime, raw.endTime);
    for (const t of times.filter(t => t > raw.startTime && t <= end)) {
        raw.changes[t].forEach(apply);
        points.push({t, remaining: remaining()});
    }
    points.push({t: end, remaining: remaining()});
    return {unit, total, points, ideal: [{t: raw.startTime, remaining: total}, {t: raw.endTime, remaining: 0}]};
}

export const attachmentUrl = (site, att) => `${site}/secure/attachment/${att.id}/${encodeURIComponent(att.filename)}`;

export function initials(name) {
    const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length)
        return '?';
    return (parts[0][0] + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase();
}

// Histórico de status do bulkfetch de changelogs → Map(issueId → [[ms, statusId], …] em ordem).
export function parseChangelogs(bulk) {
    const out = new Map();
    for (const log of bulk?.issueChangeLogs ?? []) {
        const h = log.changeHistories.flatMap(c => c.items.filter(i => i.fieldId === 'status').map(i => [Number(c.created), String(i.to)]));
        out.set(String(log.issueId), h.sort((a, b) => a[0] - b[0]));
    }
    return out;
}

const STAGES = {posdev: 'ready', pronto: 'deploy', done: 'done'}; // "daqui em diante"
const FLOW = ['progress', 'review', 'ready', 'testing', 'deploy'];
const STALE_MS = 2 * 86400e3;

function personKpis(cards, hist, colMap, {start, now}) {
    const pos = c => COLUMNS.indexOf(colMap.get(String(c.fields.status.id)));
    const n = cards.length;
    const stages = Object.fromEntries(Object.entries(STAGES).map(([k, col]) =>
        [k, cards.filter(c => (k === 'done' ? pos(c) === COLUMNS.indexOf(col) : pos(c) >= COLUMNS.indexOf(col))).length]));
    const hours = Object.fromEntries(FLOW.map(c => [c, 0]));
    const stale = [];
    for (const c of cards) {
        const h = hist.get(String(c.id)) ?? [];
        h.forEach(([t, status], i) => {
            const col = colMap.get(status);
            const from = Math.max(t, start), to = i + 1 < h.length ? h[i + 1][0] : now;
            if (col in hours && to > from)
                hours[col] += (to - from) / 3600e3;
        });
        const col = colMap.get(String(c.fields.status.id));
        if (col !== 'todo' && col !== 'done' && now - (h.at(-1)?.[0] ?? 0) > STALE_MS)
            stale.push(c.key);
    }
    for (const c of FLOW)
        hours[c] = n ? hours[c] / n : 0;
    return {n, ...stages, hours, stale};
}

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

// Você em números absolutos; o time como média das proporções/horas de cada pessoa (quem tem card na sprint).
export function kpis(issues, hist, colMap, window, me, team) {
    const of = id => issues.filter(i => i.fields?.assignee?.accountId === id);
    const mine = personKpis(of(me), hist, colMap, window);
    const others = team.map(id => personKpis(of(id), hist, colMap, window)).filter(p => p.n);
    if (!others.length)
        return {me: mine, team: null, teamStale: null, worst: null};
    const t = {
        ...Object.fromEntries(Object.keys(STAGES).map(k => [k, mean(others.map(p => p[k] / p.n))])),
        hours: Object.fromEntries(FLOW.map(c => [c, mean(others.map(p => p.hours[c]))])),
    };
    // coluna onde você mais passa do time (em horas por card), se passar de 1 h
    const diffs = FLOW.map(c => ({col: c, diff: mine.hours[c] - t.hours[c], ratio: t.hours[c] > 0 ? mine.hours[c] / t.hours[c] : null}));
    const top = diffs.sort((a, b) => b.diff - a.diff)[0];
    return {me: mine, team: t, teamStale: mean(others.map(p => p.stale.length)), worst: top.diff >= 1 ? top : null};
}
