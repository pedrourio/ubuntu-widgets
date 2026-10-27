import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {loadConfig, saveConfig, readJson, CACHE_PATH} from './config.js';
import {parsePrRef} from './logic.js';

const toHex = rgba => `#${[rgba.red, rgba.green, rgba.blue].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;

export default class PrWidgetPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(720, 860);
        const cfg = loadConfig();
        const save = () => saveConfig(cfg);
        let page = null;

        // Recria a página inteira a cada mudança estrutural: simples, e a lista é curta.
        const build = () => {
            if (page)
                window.remove(page);
            page = new Adw.PreferencesPage({title: 'Organizar', icon_name: 'view-list-symbolic'});

            const groups = new Adw.PreferencesGroup({
                title: 'Grupos',
                description: '"Pedem sua resposta" e "Prontas para merge" são automáticos e sempre ficam no topo.',
            });
            const addGroup = new Gtk.Button({label: 'Novo grupo', valign: Gtk.Align.CENTER});
            addGroup.connect('clicked', () => {
                cfg.groups.push({id: `g${Date.now()}`, name: 'Novo grupo', color: '#62a0ea'});
                save();
                build();
            });
            groups.set_header_suffix(addGroup);
            for (const g of cfg.groups) {
                const row = new Adw.EntryRow({title: 'Nome do grupo', text: g.name, show_apply_button: true});
                row.connect('apply', () => {
                    g.name = row.text;
                    save();
                    build();
                });
                const rgba = new Gdk.RGBA();
                rgba.parse(g.color);
                const color = new Gtk.ColorDialogButton({dialog: new Gtk.ColorDialog({with_alpha: false}), rgba, valign: Gtk.Align.CENTER, tooltip_text: 'Cor do grupo'});
                color.connect('notify::rgba', () => {
                    g.color = toHex(color.rgba);
                    save();
                });
                const del = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, tooltip_text: `Excluir grupo ${g.name}`});
                del.add_css_class('flat');
                del.connect('clicked', () => {
                    cfg.groups = cfg.groups.filter(x => x !== g);
                    for (const key of Object.keys(cfg.assign)) {
                        if (cfg.assign[key] === g.id)
                            delete cfg.assign[key];
                    }
                    save();
                    build();
                });
                row.add_suffix(color);
                row.add_suffix(del);
                groups.add(row);
            }
            page.add(groups);

            const prs = new Adw.PreferencesGroup({title: 'PRs e seus grupos'});
            const auto = new Adw.SwitchRow({
                title: 'Agrupar sozinho pelo código do card (ex.: ABC-123)',
                subtitle: 'Vale para PRs sem grupo quando há mais de uma do mesmo card',
                active: cfg.autoGroupByCard,
            });
            auto.connect('notify::active', () => {
                cfg.autoGroupByCard = auto.active;
                save();
            });
            prs.add(auto);
            const names = ['Sem grupo', ...cfg.groups.map(g => g.name)];
            const cached = readJson(CACHE_PATH, []);
            if (!cached.length)
                prs.add(new Adw.ActionRow({title: 'A lista aparece depois da primeira atualização do widget.'}));
            for (const p of cached) {
                const row = new Adw.ComboRow({title: p.title, subtitle: p.key, model: Gtk.StringList.new(names)});
                row.selected = cfg.groups.findIndex(g => g.id === cfg.assign[p.key]) + 1;
                row.connect('notify::selected', () => {
                    if (row.selected === 0)
                        delete cfg.assign[p.key];
                    else
                        cfg.assign[p.key] = cfg.groups[row.selected - 1].id;
                    save();
                });
                prs.add(row);
            }
            page.add(prs);

            const extra = new Adw.PreferencesGroup({
                title: 'PRs monitoradas além das suas',
                description: 'PRs de outras pessoas que você quer acompanhar, com o mesmo status do reviewer.',
            });
            for (const key of cfg.extra) {
                const row = new Adw.ActionRow({title: key});
                const rm = new Gtk.Button({label: 'Parar de monitorar', valign: Gtk.Align.CENTER});
                rm.add_css_class('flat');
                rm.connect('clicked', () => {
                    cfg.extra = cfg.extra.filter(k => k !== key);
                    save();
                    build();
                });
                row.add_suffix(rm);
                extra.add(row);
            }
            const entry = new Adw.EntryRow({title: 'Adicionar PR (URL ou repo#número)', show_apply_button: true});
            entry.connect('apply', () => {
                const key = parsePrRef(entry.text, cfg.defaultOwner);
                if (!key) {
                    entry.add_css_class('error');
                    return;
                }
                if (!cfg.extra.includes(key))
                    cfg.extra.push(key);
                save();
                build();
            });
            extra.add(entry);
            page.add(extra);

            window.add(page);
        };
        build();
    }
}
