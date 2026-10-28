// gjs -m check.js  → falha com exceção se alguma regra de logic.js quebrar.
import {COLUMNS, columnMap, tally, pickActiveSprint, daysLeft, toJql, epicJql, burndownSeries, attachmentUrl, initials, parseChangelogs, kpis} from './logic.js';

const assert = (cond, msg) => {
    if (!cond)
        throw new Error(`FALHOU: ${msg}`);
};
const ok = msg => print(`ok: ${msg}`);

// busca
assert(toJql('4583', 'ACME').jql.includes('key = ACME-4583') && toJql('4583', 'ACME').byKey, 'número vira chave do projeto');
assert(toJql('acme-12', 'ACME').byKey && toJql('acme-12', 'ACME').jql.includes('key = ACME-12'), 'chave em minúsculas');
assert(toJql('relatório "PCA"', 'ACME').jql.includes('summary ~ "relatório \\"PCA\\"*"'), 'aspas escapadas');
assert(toJql('a\\b', 'ACME').jql.includes('a\\\\b'), 'barra invertida escapada');
assert(toJql('   ', 'ACME') === null, 'vazio não busca');
assert(toJql('agenda AND', 'ACME').jql.startsWith('project = ACME AND (summary ~ "agenda AND*"'), 'palavra reservada fica dentro das aspas');
assert(toJql('agenda', 'ACME', ['ACME-1', 'ACME-2']).jql.includes('parent in (ACME-1, ACME-2)'), 'épicos entram por parent');
assert(!toJql('agenda', 'ACME').jql.includes('parent in'), 'sem épicos, sem parent');
assert(toJql('agenda', 'ACME').jql.endsWith('ORDER BY updated DESC'), 'mais recentes primeiro');
assert(epicJql('agenda', 'ACME') === 'project = ACME AND issuetype = Epic AND summary ~ "agenda*"', 'busca de épico');
ok('busca');

// placar
const board = {columnConfig: {columns: COLUMNS.map((_c, i) => ({name: `col${i}`, statuses: [{id: String(100 + i)}, {id: String(200 + i)}]}))}};
const map = columnMap(board);
assert(map.get('100') === 'todo' && map.get('206') === 'done' && map.get('203') === 'ready', 'colunas pela posição');
const issue = (status, who) => ({fields: {status: {id: status}, assignee: who ? {accountId: who} : null}});
const t = tally([issue('100', 'eu'), issue('206', 'eu'), issue('101', 'outro'), issue('105', null), issue('999', 'eu')], map, 'eu');
assert(t.todo === 1 && t.done === 1 && t.progress === 0 && Object.keys(t).length === 7, 'conta só os meus, status desconhecido ignorado');
ok('placar');

// sprint
assert(pickActiveSprint([]) === null && pickActiveSprint(undefined) === null, 'sem sprint ativa');
const sp = pickActiveSprint([{id: 9, name: 'Sprint 28', state: 'active', startDate: '2026-10-26T17:00:00Z', endDate: '2026-10-30T21:00:00Z'}]);
assert(sp.number === 28 && sp.id === 9, 'número da sprint');
assert(pickActiveSprint([{id: 1, name: 'Foco', state: 'active'}]).number === null, 'nome sem número');
assert(daysLeft('2026-10-30T21:00:00Z', Date.parse('2026-10-27T12:00:00Z')) === 4, 'dias restantes');
assert(daysLeft('2026-10-30T21:00:00Z', Date.parse('2026-11-02T12:00:00Z')) === 0, 'sprint vencida = 0');
ok('sprint');

// burndown: pontos 5+3 no início, A conclui no meio, C entra depois do início com 2
const H = 3600e3;
const DAYMS = 86400e3;
const raw = {
    startTime: 10 * H, endTime: 20 * H, now: 16 * H,
    changes: {
        [1 * H]: [{key: 'A', statC: {newValue: 5}, added: true}, {key: 'B', statC: {newValue: 3}, added: true}],
        [12 * H]: [{key: 'A', column: {done: true, newStatus: '206'}}],
        [14 * H]: [{key: 'C', statC: {newValue: 2}, added: true}],
        [15 * H]: [{key: 'B', added: false}],
    },
};
const s = burndownSeries(raw);
assert(s.total === 8 && s.points[0].t === 10 * H && s.points[0].remaining === 8, 'começa no escopo do início');
assert(s.points.map(p => p.remaining).join() === '8,3,5,2,2', `repassa eventos: ${s.points.map(p => p.remaining)}`);
assert(s.points.at(-1).t === 16 * H, 'termina em agora');
assert(s.ideal[0].remaining === 8 && s.ideal[1].remaining === 0 && s.ideal[1].t === 20 * H, 'diretriz até zero no fim');
const c = burndownSeries(raw, 'cards');
assert(c.total === 2 && c.points.map(p => p.remaining).join() === '2,1,2,1,1', `por cards: ${c.points.map(p => p.remaining)}`);
assert(c.unit === 'cards' && s.unit === 'points', 'unidade vai junto com a série');
assert(burndownSeries({}) === null && burndownSeries(null) === null, 'formato inválido');
ok('burndown');

assert(attachmentUrl('https://acme.atlassian.net', {id: '7', filename: 'AJUSTES PCA.xlsx'}) === 'https://acme.atlassian.net/secure/attachment/7/AJUSTES%20PCA.xlsx', 'url do anexo');
assert(initials('Pedro Henrique Urio') === 'PU' && initials('Ana') === 'A' && initials('') === '?' && initials(null) === '?', 'iniciais');
ok('anexo e iniciais');

// KPIs: estágios de entrega, horas por coluna, parados, você × média do time
const st = i => String(100 + COLUMNS.indexOf(i)); // id de status da coluna, no board de teste
const card = (id, who, col) => ({id, key: `ACME-${id}`, fields: {status: {id: st(col)}, assignee: {accountId: who}}});
const bulk = {issueChangeLogs: [
    {issueId: '1', changeHistories: [{created: 12 * H, items: [{fieldId: 'status', to: st('ready')}]}, {created: 11 * H, items: [{fieldId: 'status', to: st('progress')}]}]},
    {issueId: '2', changeHistories: [{created: 15 * H, items: [{fieldId: 'status', to: st('done')}, {fieldId: 'assignee', to: 'x'}]}]},
    {issueId: '3', changeHistories: [{created: 12 * H, items: [{fieldId: 'status', to: st('deploy')}]}]},
    {issueId: '4', changeHistories: [{created: 10 * H, items: [{fieldId: 'status', to: st('progress')}]}]},
]};
const hist = parseChangelogs(bulk);
assert(hist.get('1').map(([t]) => t / H).join() === '11,12' && hist.get('2').length === 1, 'histórico ordenado, só status');
const sprintIssues = [card('1', 'eu', 'ready'), card('2', 'eu', 'done'), card('3', 'a', 'deploy'), card('4', 'b', 'progress'), card('5', 'fora', 'done')];
const k = kpis(sprintIssues, hist, map, {start: 10 * H, now: 16 * H + 2 * DAYMS}, 'eu', ['a', 'b']);
assert(k.me.n === 2 && k.me.posdev === 2 && k.me.pronto === 1 && k.me.done === 1, `estágios meus: ${JSON.stringify(k.me)}`);
assert(k.team.posdev === 0.5 && k.team.pronto === 0.5 && k.team.done === 0, `estágios do time são média de proporções: ${JSON.stringify(k.team)}`);
assert(Math.abs(k.me.hours.progress - 0.5) < 1e-9, `horas em progress por card: ${k.me.hours.progress}`); // 1 h / 2 cards
assert(k.me.hours.ready > 24 && k.team.hours.progress > 24, 'card ainda na coluna conta até agora');
assert(k.me.stale.join() === 'ACME-1' && k.teamStale === 1, `parados > 2 dias: ${k.me.stale} / ${k.teamStale}`);
assert(k.worst?.col === 'ready', `coluna mais acima do time: ${JSON.stringify(k.worst)}`);
assert(kpis(sprintIssues, hist, map, {start: 10 * H, now: 16 * H}, 'eu', []).team === null, 'sem time, sem comparação');
ok('kpis');
