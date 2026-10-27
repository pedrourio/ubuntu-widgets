import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {loadConfig, saveConfig} from './config.js';
import {lookupToken, storeToken} from './secret.js';

const TOKEN_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';

export default class JiraWidgetPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const cfg = loadConfig();
        const page = new Adw.PreferencesPage();
        window.add(page);

        // Token primeiro: é para cá que a engrenagem do menu traz.
        const tokenGroup = new Adw.PreferencesGroup({title: 'Token do Jira', description: 'Guardado no chaveiro do Ubuntu, nunca em arquivo.'});
        const token = new Adw.PasswordEntryRow({title: 'Cole o token de API', show_apply_button: true});
        const status = new Adw.ActionRow({title: 'Verificando…'});
        const refreshStatus = async () => {
            const has = cfg.site ? await lookupToken(cfg.site).catch(() => null) : null;
            status.title = !cfg.site ? 'Preencha o site abaixo antes do token' : has ? 'Token salvo' : 'Sem token';
        };
        token.connect('apply', async () => {
            const value = token.text.trim();
            if (!value || !cfg.site)
                return;
            try {
                await storeToken(cfg.site, value);
                token.text = '';
                status.title = 'Token salvo. O widget usa no próximo ciclo.';
                // tocar o config faz o widget reler já, sem esperar 15 min
                saveConfig(cfg);
            } catch (e) {
                status.title = `Não salvei: ${e.message}`;
            }
        });
        tokenGroup.add(token);
        tokenGroup.add(status);
        const link = new Adw.ActionRow({title: 'Gerar um token na Atlassian', activatable: true});
        link.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        link.connect('activated', () => Gtk.show_uri(window, TOKEN_URL, 0));
        tokenGroup.add(link);
        page.add(tokenGroup);
        refreshStatus();

        const group = new Adw.PreferencesGroup({title: 'Conexão', description: 'Mudanças valem em até 2 segundos.'});
        const text = (key, title) => {
            const row = new Adw.EntryRow({title, text: String(cfg[key] ?? ''), show_apply_button: true});
            row.connect('apply', () => {
                cfg[key] = row.text.trim().replace(/\/+$/, '');
                saveConfig(cfg);
                if (key === 'site')
                    refreshStatus();
            });
            group.add(row);
        };
        const number = (key, title, min, max) => {
            const row = Adw.SpinRow.new_with_range(min, max, 1);
            row.title = title;
            row.value = Number(cfg[key]) || min;
            row.connect('notify::value', () => {
                cfg[key] = row.value;
                saveConfig(cfg);
            });
            group.add(row);
        };
        text('site', 'Site (ex.: https://empresa.atlassian.net)');
        text('email', 'Email da conta Atlassian');
        number('boardId', 'Id do board', 1, 1e6);
        text('project', 'Chave do projeto');
        text('githubOwner', 'Organização no GitHub (para achar as PRs)');
        text('pointsField', 'Campo de Story Points (customfield_…)');
        number('intervalMinutes', 'Atualizar o placar a cada (min)', 5, 120);
        page.add(group);

        window.connect('map', () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            token.grab_focus();
            return GLib.SOURCE_REMOVE;
        }));
    }
}
