// Épico de cada card, pelo Jira do jira-widget (config e token dele). Cache em arquivo: só cards novos ou vencidos vão ao Jira.
import GLib from 'gi://GLib';
import {epicLinks, epicJqlFor, ISSUE_KEY} from './logic.js';
import {readJson, writeJson} from './config.js';

export const EPICS_TTL_MS = 6 * 3600 * 1000;
export const EPICS_CACHE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'pr-widget', 'epics.json']);

export const staleCards = (cards, cache, now) => cards.filter(c => !(now - (cache[c]?.at ?? -Infinity) < EPICS_TTL_MS));

export const epicsFromCache = (cards, cache) => new Map(cards.filter(c => c in cache).map(c => [c, cache[c].epic]));
const toMap = epicsFromCache;
// Leitura do cache na hora, sem rede: a aba mostra os épicos já conhecidos antes da busca terminar.
export const cachedEpics = cards => epicsFromCache(cards, readJson(EPICS_CACHE, {}));

// Só chaves do projeto do Jira (títulos com "NR-7" ou "SHA-256" fariam a busca inteira falhar).
export const jiraKeys = (cards, project) => cards.filter(c => ISSUE_KEY.test(c) && (!project || c.startsWith(`${project}-`)));
const FAIL_WAIT_MS = 30 * 60 * 1000;
export const canFetch = (cache, now) => !(now - (cache['#failedAt'] ?? -Infinity) < FAIL_WAIT_MS);

// Nunca lança: sem jira-widget, sem config, sem token ou com erro de rede devolve o que o cache tem e error.
export async function loadEpics(cards, {jiraDir, now = Date.now()}) {
    const cache = readJson(EPICS_CACHE, {});
    if (!jiraDir)
        return {epicOf: toMap(cards, cache), error: 'jira'};
    let JiraClient, lookupToken, cfg;
    try {
        const [jira, secret, config] = await Promise.all(['jira.js', 'secret.js', 'config.js']
            .map(f => import(`file://${GLib.build_filenamev([jiraDir, f])}`)));
        ({JiraClient} = jira);
        ({lookupToken} = secret);
        cfg = config.loadConfig();
    } catch (e) {
        console.warn(`pr-widget: jira-widget: ${e.message}`);
        return {epicOf: toMap(cards, cache), error: 'jira'};
    }
    const stale = jiraKeys(staleCards([...new Set(cards)], cache, now), cfg.project);
    if (!stale.length)
        return {epicOf: toMap(cards, cache), error: null};
    // falhou há pouco: não insiste a cada atualização
    if (!canFetch(cache, now))
        return {epicOf: toMap(cards, cache), error: 'jira'};
    try {
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
        delete cache['#failedAt'];
        writeJson(EPICS_CACHE, cache);
        return {epicOf: toMap(cards, cache), error: null};
    } catch (e) {
        console.warn(`pr-widget: épicos do Jira: ${e.message}`);
        cache['#failedAt'] = now;
        writeJson(EPICS_CACHE, cache);
        return {epicOf: toMap(cards, cache), error: 'jira'};
    }
}
