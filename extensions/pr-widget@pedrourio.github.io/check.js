// gjs -m check.js  → falha com exceção se alguma regra de logic.js quebrar.
import {classify, parsePrRef, groupPrs, counts, matchesQuery, buildCardPrQuery, reviewDecision, trunkOf, groupByEpic, epicLinks, epicJqlFor, VIEWS} from './logic.js';

import {staleCards, EPICS_TTL_MS, epicsFromCache, jiraKeys, canFetch} from './epics.js';
const assert = (cond, msg) => {
    if (!cond)
        throw new Error(`FALHOU: ${msg}`);
};
const ctx = {me: 'eu', reviewer: 'bot', repoPrefix: 'acme-'};
const pr = (reviews, comments, commit, extra = {}) => ({
    number: 1, title: 'feat(MLK-1): x', url: 'u', baseRefName: 'base', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    repository: {nameWithOwner: 'Org/acme-backend'}, // repoPrefix encurta para "backend"
    reviews: {nodes: reviews}, comments: {nodes: comments}, commits: {nodes: [{commit: {committedDate: commit}}]}, ...extra,
});
const bot = (state, decision, at) => ({author: {login: 'bot'}, state, body: decision ? `(decision: ${decision})` : '', submittedAt: at});

let c = classify(pr([bot('APPROVED', 'WARN', '2026-01-02')], [], '2026-01-01'), ctx);
assert(c.status === 'warn' && c.needsReply && !c.waitingBot, 'WARN depois do meu commit pede resposta');

c = classify(pr([bot('APPROVED', 'WARN', '2026-01-02')], [{author: {login: 'eu'}, createdAt: '2026-01-03'}], '2026-01-01'), ctx);
assert(c.waitingBot && !c.needsReply, 'meu comentário depois do WARN = aguardando bot');

c = classify(pr([bot('CHANGES_REQUESTED', null, '2026-01-02')], [], '2026-01-01'), ctx);
assert(c.status === 'changes' && c.needsReply, 'mudanças pedidas pede resposta');

c = classify(pr([bot('DISMISSED', 'PASS', '2026-01-02')], [], '2026-01-01'), ctx);
assert(c.status === 'pass' && c.ready && !c.needsReply, 'PASS limpo = pronta, sem pendência');

c = classify(pr([bot('APPROVED', 'PASS', '2026-01-02')], [], '2026-01-01', {mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN'}), ctx, {conflict: true, clean: false});
assert(c.conflict && !c.ready, 'UNKNOWN mantém o conflito anterior');

c = classify(pr([], [], '2026-01-01'), ctx);
assert(c.status === 'none' && c.reviews === 0 && c.repo === 'backend', 'sem review');

assert(parsePrRef('https://github.com/A/b/pull/12') === 'A/b#12', 'URL');
assert(parsePrRef('backend#7', 'Org') === 'Org/backend#7', 'repo#n com org padrão');
assert(parsePrRef('backend#7') === null, 'repo#n sem org padrão');
assert(parsePrRef('lixo') === null, 'entrada inválida');

const items = [
    {key: 'a', needsReply: true, conflict: true, status: 'warn', card: 'MLK-1'}, {key: 'b', ready: true, status: 'pass', card: 'MLK-1'},
    {key: 'c', waitingBot: true, status: 'warn', card: 'MLK-2'}, {key: 'd', conflict: true, status: 'pass', card: 'MLK-2'},
    {key: 'e', status: 'none', card: 'MLK-3'}, {key: 'f', status: 'pass', card: null},
];
const cfgG = {groups: [{id: 'g', name: 'G', color: '#fff'}], assign: {f: 'g', a: 'g'}, autoGroupByCard: true};
const ids = view => groupPrs(items, cfgG, new Set(), view).map(g => `${g.id}:${g.prs.map(p => p.key).join('')}`).join(' ');
assert(ids('status') === 'reply:a waiting:c ready:b conflict:d noreview:e others:f', `visão por status (${ids('status')})`);
assert(ids('group') === 'g:af card-MLK-2:cd nogroup:be', `visão por grupo ignora status (${ids('group')})`);
// monitoradas ficam num grupo só delas, no topo, nas duas visões (mesmo com status ou grupo próprio)
const idsX = view => groupPrs(items, cfgG, new Set(['a', 'c']), view).map(g => `${g.id}:${g.prs.map(p => p.key).join('')}`).join(' ');
assert(idsX('status') === 'extra:ac ready:b conflict:d noreview:e others:f', `monitoradas na visão por status (${idsX('status')})`);
assert(idsX('group') === 'extra:ac g:f nogroup:bde', `monitoradas na visão por grupo (${idsX('group')})`);
assert(counts([{needsReply: true, status: 'warn'}, {status: 'none'}]).noReview === 1, 'contagem');

print('ok: todas as regras passaram');

c = classify(pr([], [], '2026-01-01', {title: 'fix(PROJ-42): usa UTF-8'}), ctx);
assert(c.card === 'PROJ-42', `card pelo padrão Jira (${c.card})`);
c = classify(pr([], [], '2026-01-01', {title: 'ajuste #77'}), {...ctx, cardPattern: '#\\d+'});
assert(c.card === '#77', 'cardPattern configurável');
print('ok: cardPattern');

const sample = {num: 1266, title: 'feat: cadastro identificado por credencial e CNPJ', repo: 'backend'};
assert(matchesQuery(sample, '') && matchesQuery(sample, '#12') && matchesQuery(sample, '1266'), 'busca por número');
assert(!matchesQuery(sample, '1271'), 'número diferente não casa');
assert(matchesQuery(sample, 'credêncial cnpj') && matchesQuery(sample, 'backend cadastro'), 'busca por palavras, sem acento');
assert(!matchesQuery(sample, 'credencial audiometria'), 'todas as palavras precisam casar');
print('ok: busca');

assert(reviewDecision({state: 'CHANGES_REQUESTED', body: 'decision: PASS'}) === 'changes' && reviewDecision({state: 'COMMENTED', body: '(decision: WARN)'}) === 'warn'
    && reviewDecision({state: 'APPROVED', body: ''}) === 'approved' && reviewDecision({state: 'COMMENTED', body: 'oi'}) === null, 'decisão de um review');

// estado da PR e merge liberado
c = classify(pr([bot('APPROVED', 'PASS', '2026-01-02')], [], '2026-01-01', {state: 'OPEN'}), ctx);
assert(c.state === 'OPEN' && c.canMerge, 'aberta e CLEAN = dá para mergear');
c = classify(pr([bot('APPROVED', 'WARN', '2026-01-02')], [], '2026-01-01', {state: 'OPEN'}), ctx);
assert(c.canMerge && !c.ready, 'monitorada de outra pessoa: merge segue o GitHub (CLEAN), não o PASS do reviewer');
c = classify(pr([bot('APPROVED', 'PASS', '2026-01-02')], [], '2026-01-01', {state: 'OPEN', mergeStateStatus: 'BLOCKED'}), ctx);
assert(!c.canMerge, 'bloqueada pelo GitHub = sem merge');
c = classify(pr([bot('APPROVED', 'WARN', '2026-01-02')], [], '2026-01-01', {state: 'MERGED', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN'}), ctx, {conflict: true, clean: true});
assert(c.state === 'MERGED' && !c.canMerge && !c.needsReply && !c.waitingBot && !c.ready && !c.conflict, 'mergeada não pede nada nem conta como pendência');
assert(counts([c]).reply === 0 && counts([c]).conflict === 0 && counts([c]).total === 0 && counts([c]).noReview === 0, 'mergeada fora dos contadores');
c = classify(pr([], [], '2026-01-01'), ctx);
assert(c.state === 'OPEN', 'sem state no dado = aberta (consultas antigas)');

// PRs de um card (usado pelo jira-widget)
const cq = buildCardPrQuery('ACME-1', 'Org');
assert(cq.includes('ACME-1 in:title org:Org is:pr') && cq.includes('...P') && cq.includes('viewer { login }'), 'consulta de PRs do card');
assert(/fragment P on PullRequest \{\s*number title url state /.test(cq), 'fragmento traz o estado da PR');
assert(buildCardPrQuery('A"B', 'Org').includes('A\\"B in:title org:Org'), 'chave escapada na consulta');
print('ok: PRs do card');

// por épico: trunk/satélite pelas branches, épico pelo Jira
const mk = (key, {card = null, base = 'base', head = `h-${key}`, ready = false, state = 'OPEN', repo = 'Org/back'} = {}) =>
    ({key: `${repo}#${key}`, fullRepo: repo, num: key, repo: repo.split('/')[1], card, base, head, ready, state, title: `t${key}`});
assert(VIEWS.epic === 'Por épico', 'aba Por épico');
assert(classify(pr([], [], '2026-01-01', {headRefName: 'feat/x'}), ctx).head === 'feat/x', 'classify traz a branch da PR');
let T = mk(1, {head: 'feat/t'}), S1 = mk(2, {base: 'feat/t', head: 'feat/s1'}), S2 = mk(3, {base: 'feat/s1'});
let tr = trunkOf([S2, T, S1]);
assert(tr.get(S1.key) === T.key && tr.get(S2.key) === T.key && !tr.has(T.key), 'satélite de satélite sobe até o trunk raiz');
assert(trunkOf([mk(1, {head: 'feat/t'}), mk(2, {base: 'feat/t', repo: 'Org/front'})]).size === 0, 'repos diferentes não se ligam');
const A = mk(1, {head: 'a', base: 'b'}), B = mk(2, {head: 'b', base: 'a'});
let eg = groupByEpic([A, B], new Map(), new Set());
const flat = gs => gs.flatMap(g => [...(g.prs ?? []), ...(g.subs ?? []).flatMap(s => [...(s.trunk ? [s.trunk] : []), ...s.prs])]);
assert(flat(eg).length === 2, 'ciclo de branches: cada PR uma vez');

const E = {key: 'MLK-100', name: 'Relatórios'}, F = {key: 'MLK-200', name: 'EPIs'};
T = mk(1, {card: 'MLK-1', head: 'feat/t', ready: true});
const S = mk(2, {card: 'MLK-9', base: 'feat/t'});
const P = mk(3, {card: 'MLK-2', ready: true});
const N = mk(4, {card: 'MLK-5'}), X = mk(5);
eg = groupByEpic([P, S, T, N, X], new Map([['MLK-1', E], ['MLK-2', E], ['MLK-9', F], ['MLK-5', null]]), new Set());
const ge = eg.find(g => g.kind === 'epic');
assert(eg.filter(g => g.kind === 'epic').length === 1 && ge.name.startsWith('MLK-100'), 'só o épico do trunk ganha grupo');
assert(ge.subs[0].kind === 'trunk' && ge.subs[0].trunk === T && ge.subs[0].prs[0] === S && ge.subs[1].kind === 'card' && ge.subs[1].prs[0] === P, 'trunk antes do card; satélite de outro épico fica no trunk');
assert(ge.summary.ready === 2 && ge.summary.total === 3, 'resumo do épico');
assert(eg.find(g => g.kind === 'noepic').subs[0].prs[0] === N && eg.find(g => g.kind === 'nocard').prs[0] === X, 'sem épico e sem card');
assert(flat(eg).length === 5, 'nenhuma PR perdida nem repetida');

eg = groupByEpic([mk(1, {card: 'MLK-1', head: 'feat/t'}), mk(2, {card: 'MLK-2', base: 'feat/t'})], new Map(), new Set());
assert(eg.length === 1 && eg[0].kind === 'trunk' && eg[0].name === 'MLK-1', 'trunk sem épico vira grupo próprio');

const M = mk(7, {card: 'MLK-3', base: 'feat/t', state: 'MERGED'}), L = mk(8, {card: 'MLK-4'});
eg = groupByEpic([L, M, T], new Map([['MLK-1', E]]), new Set([M.key, L.key]));
assert(eg[0].kind === 'extra' && eg[0].prs[0] === L, 'monitorada solta no topo');
assert(eg[1].subs[0].prs[0] === M && eg[1].summary.merged === 1, 'monitorada mergeada entra no trunk e conta merged');

const el = epicLinks([
    {key: 'MLK-1', fields: {issuetype: {hierarchyLevel: 0}, parent: {key: 'MLK-100', fields: {summary: 'Relatórios', issuetype: {hierarchyLevel: 1}}}}},
    {key: 'MLK-2', fields: {issuetype: {hierarchyLevel: -1}, parent: {key: 'MLK-50', fields: {summary: 'história', issuetype: {hierarchyLevel: 0}}}}},
    {key: 'MLK-3', fields: {issuetype: {hierarchyLevel: 0}}},
    {key: 'MLK-100', fields: {summary: 'Relatórios', issuetype: {hierarchyLevel: 1}}},
]);
assert(el.epics.get('MLK-1')?.key === 'MLK-100' && el.epics.get('MLK-1').name === 'Relatórios', 'pai épico');
assert(el.climb.get('MLK-2') === 'MLK-50' && !el.epics.has('MLK-2'), 'subtarefa sobe mais um nível');
assert(el.epics.get('MLK-3') === null && el.epics.get('MLK-100')?.key === 'MLK-100', 'sem pai = sem épico; épico é o próprio');
assert(epicJqlFor(['MLK-1', 'UTF-8x', 'MLK-2']) === 'key in (MLK-1,MLK-2)', 'JQL só com chaves válidas');
print('ok: por épico');

// cache dos épicos
const now = 10 * EPICS_TTL_MS;
const cache = {'MLK-1': {epic: null, at: now - 3600e3}, 'MLK-2': {epic: null, at: now - 7 * 3600e3}};
assert(JSON.stringify(staleCards(['MLK-1', 'MLK-2', 'MLK-3'], cache, now)) === '["MLK-2","MLK-3"]', 'busca só ausentes e vencidos');
print('ok: cache dos épicos');

// achados da revisão
// 1. cache lido na hora, sem esperar a rede
assert(epicsFromCache(['MLK-1', 'MLK-9'], {'MLK-1': {epic: E, at: 1}}).get('MLK-1') === E && !epicsFromCache(['MLK-9'], {}).has('MLK-9'), 'épicos do cache sem rede');
// 2. PR de promoção (head = branch longa) ou de fork não vira trunk
const prom = mk(10, {head: 'base', base: 'master'}), feat = mk(11, {card: 'MLK-1', base: 'base'});
assert(trunkOf([prom, feat]).size === 0, 'PR base→master não vira trunk');
assert(trunkOf([{...mk(1, {head: 'feat/t'}), headRepo: 'Fork/back'}, mk(2, {base: 'feat/t'})]).size === 0, 'PR de fork não vira trunk');
assert(trunkOf([{...mk(1, {head: 'feat/t'}), headRepo: 'Org/back'}, mk(2, {base: 'feat/t'})]).size === 1, 'mesmo repo liga');
// 3. só chaves do projeto vão ao Jira; falha recente segura novas buscas
assert(JSON.stringify(jiraKeys(['MLK-1', 'NR-7', 'SHA-256'], 'MLK')) === '["MLK-1"]', 'só o projeto do Jira');
assert(JSON.stringify(jiraKeys(['MLK-1', 'NR-7', 'utf-8'], '')) === '["MLK-1","NR-7"]', 'sem projeto: só a forma da chave');
assert(!canFetch({'#failedAt': now - 60e3}, now) && canFetch({'#failedAt': now - 3600e3}, now) && canFetch({}, now), 'espera 30 min depois de uma falha');
print('ok: achados da revisão');
