// gjs -m check.js  → falha com exceção se alguma regra de logic.js quebrar.
import {classify, parsePrRef, groupPrs, counts, matchesQuery, buildCardPrQuery} from './logic.js';

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
