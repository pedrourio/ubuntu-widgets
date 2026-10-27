// Chamado pelo bin/jira-token; o token chega por variável de ambiente, nunca por argumento.
import GLib from 'gi://GLib';
import {loadConfig} from '../extensions/jira-widget@pedrourio.github.io/config.js';
import {storeToken} from '../extensions/jira-widget@pedrourio.github.io/secret.js';
import {JiraClient} from '../extensions/jira-widget@pedrourio.github.io/jira.js';

const cfg = loadConfig();
const token = GLib.getenv('JIRA_TOKEN');
const loop = new GLib.MainLoop(null, false);
(async () => {
    try {
        if (!cfg.site || !cfg.email)
            throw new Error(`preencha site e email em ~/.config/jira-widget/config.json`);
        const me = await new JiraClient(cfg, token).request('/rest/api/3/myself');
        await storeToken(cfg.site, token);
        print(`Token salvo no chaveiro. Conectado como ${me.displayName}.`);
    } catch (e) {
        printerr(`Não salvei: ${e.message}`);
        imports.system.exit(1);
    } finally {
        loop.quit();
    }
})();
loop.run();
