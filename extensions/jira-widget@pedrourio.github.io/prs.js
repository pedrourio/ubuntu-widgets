// PRs de um card, buscadas no GitHub pela chave, com as regras do pr-widget.
// Caminho estável do pr-widget: as cópias do ext-reload ficam em outra pasta e "../" não funcionaria.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// Fora do shell (testes) usa o caminho instalado; dentro, a pasta da cópia que está carregada agora:
// o shell guarda módulos pelo caminho, e o instalado ficou na versão do login.
const INSTALLED = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions', 'pr-widget@pedrourio.github.io']);
const STATUS = {pass: 'PASS', approved: 'aprovada', warn: 'WARN', changes: 'mudanças pedidas', none: 'sem review'};

const loaded = new Map();
const loadPrWidget = dir => {
    if (!loaded.has(dir)) {
        loaded.set(dir, Promise.all([import(`file://${dir}/logic.js`), import(`file://${dir}/config.js`)])
            .then(([logic, config]) => ({...logic, cfg: config.loadConfig()}))
            .catch(e => {
                console.error(`jira-widget: não consegui importar o pr-widget de ${dir}: ${e}`);
                loaded.delete(dir); // tenta de novo no próximo card
                return null;
            }));
    }
    return loaded.get(dir);
};

function gh(argv, cancellable) {
    return new Promise((resolve, reject) => {
        const gh = GLib.find_program_in_path('gh');
        if (!gh) {
            reject(new Error('gh não encontrado no PATH'));
            return;
        }
        const proc = Gio.Subprocess.new([gh, ...argv], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        proc.communicate_utf8_async(null, cancellable, (p, res) => {
            try {
                const [, out, err] = p.communicate_utf8_finish(res);
                const json = JSON.parse(out || 'null');
                if (!json?.data?.search)
                    throw new Error(err.trim().split('\n').pop() || 'gh falhou');
                resolve(json.data);
            } catch (e) {
                reject(e);
            }
        });
    });
}

// → [{repo, num, url, state, text}]; `text` já vem no formato da linha (ex.: "aberta · WARN · sua vez").
export async function fetchCardPrs(key, owner, cancellable, prWidgetDir = INSTALLED) {
    const pw = await loadPrWidget(prWidgetDir);
    if (!pw)
        throw new Error('pr-widget não instalado');
    const data = await gh(['api', 'graphql', '-f', `query=${pw.buildCardPrQuery(key, owner)}`], cancellable);
    const ctx = {me: data.viewer.login, reviewer: pw.cfg.reviewer, repoPrefix: pw.cfg.repoPrefix, cardPattern: pw.cfg.cardPattern};
    return data.search.nodes.filter(n => n?.number).map(n => {
        const c = pw.classify(n, ctx);
        let text = n.state === 'MERGED' ? 'merged' : n.state === 'CLOSED' ? 'fechada' : 'aberta';
        if (n.state === 'OPEN') {
            text += ` · ${STATUS[c.status]}`;
            if (c.needsReply)
                text += ' · sua vez';
            else if (c.waitingBot)
                text += ` · aguardando ${pw.cfg.reviewerName}`;
            if (c.conflict)
                text += ' · conflito';
            else if (c.ready)
                text += ' · pronta para merge';
        }
        return {repo: c.repo, num: c.num, url: c.url, state: n.state, text, needsReply: c.needsReply};
    });
}
