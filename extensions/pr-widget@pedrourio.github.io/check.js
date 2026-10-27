// gjs -m check.js  → falha com exceção se alguma regra de logic.js quebrar.
import {classify, parsePrRef, groupPrs, counts, matchesQuery} from './logic.js';

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
    {key: 'a', needsReply: true, card: 'MLK-1'}, {key: 'b', ready: true, card: 'MLK-1'},
    {key: 'c', card: 'MLK-2'}, {key: 'd', card: 'MLK-2'}, {key: 'e', card: 'MLK-3'}, {key: 'f', card: null},
];
const groups = groupPrs(items, {groups: [{id: 'g', name: 'G', color: '#fff'}], assign: {f: 'g'}, autoGroupByCard: true}, new Set());
const ids = groups.map(g => `${g.id}:${g.prs.map(p => p.key).join('')}`).join(' ');
assert(ids === 'reply:a ready:b g:f card-MLK-2:cd nogroup:e', `agrupamento exclusivo (${ids})`);
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
