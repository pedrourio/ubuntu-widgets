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
