// gjs -m check.js  → falha com exceção se alguma regra de logic.js quebrar.
import {COLUMNS, columnMap, tally, pickActiveSprint, daysLeft, toJql, epicJql, burndownSeries, attachmentUrl, initials} from './logic.js';

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
assert(burndownSeries({}) === null && burndownSeries(null) === null, 'formato inválido');
ok('burndown');

assert(attachmentUrl('https://acme.atlassian.net', {id: '7', filename: 'AJUSTES PCA.xlsx'}) === 'https://acme.atlassian.net/secure/attachment/7/AJUSTES%20PCA.xlsx', 'url do anexo');
assert(initials('Pedro Henrique Urio') === 'PU' && initials('Ana') === 'A' && initials('') === '?' && initials(null) === '?', 'iniciais');
ok('anexo e iniciais');
