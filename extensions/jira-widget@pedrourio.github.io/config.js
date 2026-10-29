import GLib from 'gi://GLib';

export const CONFIG_PATH = GLib.build_filenamev([GLib.get_user_config_dir(), 'jira-widget', 'config.json']);
export const CACHE_PATH = GLib.build_filenamev([GLib.get_user_cache_dir(), 'jira-widget', 'state.json']);

// Valores da empresa ficam só no config do usuário, nunca aqui.
const DEFAULTS = {
    site: '', // https://<org>.atlassian.net
    email: '',
    boardId: 0,
    project: '',
    githubOwner: '',
    intervalMinutes: 15,
    burndownUnit: 'cards', // 'cards' ou 'points'
    pointsField: '',
    team: [], // accountIds de quem entra na média do time
    githubLogin: '', // seu usuário no GitHub (métricas de entrega)
    teamGithub: [], // usuários do GitHub do time, na mesma lógica de "team"
    deployHead: 'base', // branch de integração; um deploy é uma PR dela para deployBases
    deployBases: ['master', 'main'], // campo de Story Points do site (customfield_…); vazio = burndown pelo padrão do Jira
};

export function readJson(path, fallback) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return fallback;
    }
}

export function writeJson(path, data) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    GLib.file_set_contents(path, JSON.stringify(data, null, 2));
}

export const loadConfig = () => {
    const cfg = {...DEFAULTS, ...readJson(CONFIG_PATH, {})};
    cfg.site = cfg.site.replace(/\/+$/, '');
    return cfg;
};
export const saveConfig = cfg => writeJson(CONFIG_PATH, cfg);
