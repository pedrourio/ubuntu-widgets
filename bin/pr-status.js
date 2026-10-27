// Mesmas regras do pr-widget, no terminal. Uso: pr-status [--view status|group] [busca]
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {buildQuery, classify, groupPrs, counts, relTime, matchesQuery} from '../extensions/pr-widget@pedrourio.github.io/logic.js';
import {loadConfig} from '../extensions/pr-widget@pedrourio.github.io/config.js';

const args = [...ARGV];
const viewAt = args.indexOf('--view');
const view = viewAt >= 0 ? args.splice(viewAt, 2)[1] : 'status';
const query = args.join(' ');
const cfg = loadConfig();

function fetch() {
    const proc = Gio.Subprocess.new(['gh', 'api', 'graphql', '-f', `query=${buildQuery(cfg.extra)}`],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const [, out, err] = proc.communicate_utf8(null, null);
    let json = null;
    try {
        json = JSON.parse(out);
    } catch {}
    if (!json?.data?.search) {
        printerr(`erro ao consultar o GitHub: ${err.trim() || 'gh falhou'}`);
        imports.system.exit(1);
    }
    const d = json.data;
    return [...d.search.nodes, ...Object.keys(d).filter(k => /^x\d+$/.test(k)).map(k => d[k]?.pullRequest)]
        .filter(n => n?.number)
        .map(n => ({n, me: d.viewer.login}));
}

const ctx = me => ({me, reviewer: cfg.reviewer, repoPrefix: cfg.repoPrefix, cardPattern: cfg.cardPattern});
let nodes = fetch();
// O GitHub calcula conflito sob demanda: com UNKNOWN, espera e pergunta de novo uma vez.
let prev = new Map();
if (nodes.some(({n}) => n.mergeable === 'UNKNOWN')) {
    prev = new Map(nodes.map(({n, me}) => [n.url, classify(n, ctx(me))]));
    GLib.usleep(4 * GLib.USEC_PER_SEC);
    nodes = fetch();
}
const seen = new Set();
const items = nodes.filter(({n}) => !seen.has(n.url) && seen.add(n.url)).map(({n, me}) => classify(n, ctx(me), prev.get(n.url)));
const shown = items.filter(p => matchesQuery(p, query));

const c = counts(items);
const who = cfg.reviewerName;
print(`${c.total} PRs abertas · ${c.reply} pedem sua resposta · ${c.waiting} aguardando ${who} · ${c.ready} prontas para merge · ${c.conflict} com conflito · ${c.noReview} sem review`);
if (query)
    print(`busca "${query}": ${shown.length} PR(s)`);

const STATUS = {pass: 'PASS', approved: 'aprovada', warn: 'WARN', changes: 'mudanças pedidas', none: 'sem review'};
for (const g of groupPrs(shown, cfg, new Set(cfg.extra), view)) {
    print(`\n## ${g.name} (${g.prs.length})`);
    for (const p of g.prs) {
        const flags = [
            p.needsReply && `sem resposta sua ${relTime(p.since)}`,
            p.waitingBot && `você respondeu ${relTime(p.since)}`,
            p.ready && 'pronta para merge',
            p.conflict && `conflito com ${p.base}`,
        ].filter(Boolean);
        print(`- ${p.repo}#${p.num} [${STATUS[p.status]}, ${p.reviews} review(s) do ${who}]${flags.length ? ` ${flags.join(' · ')}` : ''}`);
        print(`  ${p.title}`);
        print(`  ${p.url}`);
    }
}
