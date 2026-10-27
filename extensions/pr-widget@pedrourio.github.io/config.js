import GLib from 'gi://GLib';

export const CONFIG_PATH = GLib.build_filenamev([GLib.get_user_config_dir(), 'pr-widget', 'config.json']);
export const CACHE_PATH = GLib.build_filenamev([GLib.get_user_cache_dir(), 'pr-widget', 'prs.json']);

// reviewer: login do reviewer autônomo; defaultOwner: org usada em "repo#número".
const DEFAULTS = {
    reviewer: '',
    reviewerName: 'reviewer',
    defaultOwner: '',
    repoPrefix: '', // prefixo removido do nome do repo na lista, ex.: "minhaempresa-"
    cardPattern: '\\b[A-Z][A-Z0-9]+-\\d+\\b', // regex do código de card no título (padrão: chave do Jira)
    intervalMinutes: 5,
    autoGroupByCard: true,
    groups: [],
    assign: {},
    extra: [],
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
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, JSON.stringify(data, null, 2));
}

export const loadConfig = () => ({...DEFAULTS, ...readJson(CONFIG_PATH, {})});
export const saveConfig = cfg => writeJson(CONFIG_PATH, cfg);
