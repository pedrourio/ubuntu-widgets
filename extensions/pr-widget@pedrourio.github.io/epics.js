// Épico de cada card, pelo Jira do jira-widget (config e token dele). Cache em arquivo: só cards novos ou vencidos vão ao Jira.
import GLib from 'gi://GLib';
import {epicLinks, epicJqlFor} from './logic.js';
import {readJson, writeJson} from './config.js';

export const EPICS_TTL_MS = 6 * 3600 * 1000;
export const EPICS_CACHE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'pr-widget', 'epics.json']);

export const staleCards = (cards, cache, now) => cards.filter(c => !(now - (cache[c]?.at ?? -Infinity) < EPICS_TTL_MS));

const toMap = (cards, cache) => new Map(cards.filter(c => c in cache).map(c => [c, cache[c].epic]));

// Nunca lança: sem jira-widget, sem config, sem token ou com erro de rede devolve o que o cache tem e error.
export async function loadEpics(cards, {jiraDir, now = Date.now()}) {
    const cache = readJson(EPICS_CACHE, {});
    const stale = staleCards([...new Set(cards)], cache, now).filter(c => /^[A-Z][A-Z0-9]+-\d+$/.test(c));
    if (!stale.length)
        return {epicOf: toMap(cards, cache), error: null};
    try {
        if (!jiraDir)
            throw new Error('jira-widget não instalado');
        const [{JiraClient}, {lookupToken}, {loadConfig}] = await Promise.all(['jira.js', 'secret.js', 'config.js']
            .map(f => import(`file://${GLib.build_filenamev([jiraDir, f])}`)));
        const cfg = loadConfig();
        const token = cfg.site && cfg.email ? await lookupToken(cfg.site) : null;
        if (!token)
            throw new Error('Jira sem config ou token');
        const client = new JiraClient(cfg, token);
        const search = keys => client.request('/rest/api/3/search/jql', {jql: epicJqlFor(keys), fields: 'parent,issuetype,summary', maxResults: 100})
            .then(r => epicLinks(r.issues ?? []));
        const first = await search(stale);
        // subtarefa: o pai é história; mais uma busca só para esses pais
        const second = first.climb.size ? await search([...new Set(first.climb.values())]) : {epics: new Map()};
        for (const c of stale) {
            const epic = first.epics.has(c) ? first.epics.get(c) : second.epics.get(first.climb.get(c)) ?? null;
            cache[c] = {epic, at: now};
        }
        writeJson(EPICS_CACHE, cache);
        return {epicOf: toMap(cards, cache), error: null};
    } catch (e) {
        console.warn(`pr-widget: épicos do Jira: ${e.message}`);
        return {epicOf: toMap(cards, cache), error: 'jira'};
    }
}
