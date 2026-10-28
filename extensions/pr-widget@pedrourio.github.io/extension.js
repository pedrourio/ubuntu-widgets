import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {buildQuery, classify, groupPrs, counts, parsePrRef, relTime, matchesQuery, VIEWS} from './logic.js';
import {loadConfig, saveConfig, writeJson, CONFIG_PATH, CACHE_PATH} from './config.js';

const COUNTERS = ['reply', 'waiting', 'ready', 'conflict'];
const STATUS = {pass: 'PASS', approved: 'aprovada', warn: 'WARN', changes: 'mudanças pedidas', none: 'sem review'};

// Estado da PR pela forma do ícone (lê-se sem depender da cor), na ordem de prioridade.
const STATE = [
    ['reply', p => p.needsReply],
    ['waiting', p => p.waitingBot],
    ['ready', p => p.ready],
    ['conflict', p => p.conflict],
    ['open', () => true],
];

const esc = t => GLib.markup_escape_text(t, -1);

const label = (text, style_class = '', props = {}) =>
    new St.Label({text, style_class, y_align: Clutter.ActorAlign.CENTER, ...props});

const iconButton = (icon_name, accessible_name, onClick) => {
    const btn = new St.Button({style_class: 'prw-btn', child: new St.Icon({icon_name, icon_size: 16}), accessible_name, can_focus: true});
    btn.connect('clicked', onClick);
    return btn;
};

// Nome do tipo derivado do caminho do arquivo: o ext-reload carrega cópias em caminhos novos
// e o GObject não aceita registrar o mesmo nome duas vezes.
const Indicator = GObject.registerClass({GTypeName: `PrwIndicator_${GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, import.meta.url, -1)}`},
class Indicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'PRs abertas', false);
        this._ext = ext;
        this._items = [];
        this._prev = new Map();
        this._collapsed = new Set(['others', 'nogroup']);
        this._error = null;
        this._updatedAt = null;

        const box = new St.BoxLayout({style_class: 'prw-pill'});
        box.add_child(new St.Icon({gicon: Gio.icon_new_for_string(`${ext.path}/pr-symbolic.svg`), style_class: 'system-status-icon'}));
        this._total = label('…', 'prw-total');
        box.add_child(this._total);
        this._badges = {};
        for (const k of COUNTERS) {
            this._badges[k] = label('', `prw-badge prw-${k}`, {visible: false});
            box.add_child(this._badges[k]);
        }
        this.add_child(box);

        this.menu.box.add_style_class_name('prw-menu');
        // PopupMenu vazio não abre: o conteúdo precisa existir antes do primeiro clique.
        this._cfg = loadConfig();
        this._view = this._cfg.viewMode === 'group' ? 'group' : 'status';
        this._render();
        this.menu.connect('open-state-changed', (_m, open) => {
            // Com o menu aberto o conteúdo não é refeito (apagaria o que está sendo digitado).
            if (open && this._dirty)
                this._render();
            else if (open)
                this._syncUpdated();
            if (open)
                // já dá para digitar ao abrir; no idle, depois do foco que o menu põe no primeiro item
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    if (this.menu.isOpen && this._search.get_stage())
                        this._search.grab_key_focus();
                    return GLib.SOURCE_REMOVE;
                });
            else
                this._search.text = '';
        });

        this._monitor = Gio.File.new_for_path(CONFIG_PATH).monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', (_m, _f, _o, event) => {
            if (event !== Gio.FileMonitorEvent.CHANGES_DONE_HINT && event !== Gio.FileMonitorEvent.CREATED)
                return;
            // Junta salvamentos seguidos (ex.: arrastar o seletor de cor) numa consulta só.
            if (this._debounce)
                GLib.source_remove(this._debounce);
            this._debounce = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 2, () => {
                this._debounce = null;
                this._cfg = loadConfig();
                this._startTimer();
                this.refresh();
                return GLib.SOURCE_REMOVE;
            });
        });

        this.refresh();
        this._startTimer();
    }

    _startTimer() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, Math.max(1, this._cfg.intervalMinutes) * 60, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _renderWhenClosed() {
        if (this.menu.isOpen)
            this._dirty = true;
        else
            this._render();
    }

    refresh() {
        if (this._busy)
            return;
        const gh = GLib.find_program_in_path('gh');
        if (!gh) {
            this._fail('gh não encontrado no PATH');
            return;
        }
        this._busy = true;
        try {
            const proc = Gio.Subprocess.new(
                [gh, 'api', 'graphql', '-f', `query=${buildQuery(this._cfg.extra)}`],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                if (this._destroyed)
                    return;
                this._busy = false;
                try {
                    const [, out, err] = p.communicate_utf8_finish(res);
                    let json = null;
                    try {
                        json = JSON.parse(out);
                    } catch {}
                    // Com erro parcial (ex.: PR monitorada que não existe) o gh sai != 0 mas traz data.
                    if (!json?.data?.search)
                        throw new Error(err.trim().split('\n').pop() || 'gh falhou');
                    this._apply(json.data, json.errors?.[0]?.message ?? null);
                } catch (e) {
                    this._fail(e.message);
                }
            });
        } catch (e) {
            this._busy = false;
            this._fail(e.message);
        }
    }

    _apply(data, partialError) {
        const ctx = {me: data.viewer.login, reviewer: this._cfg.reviewer, repoPrefix: this._cfg.repoPrefix, cardPattern: this._cfg.cardPattern};
        const extraNodes = Object.keys(data).filter(k => /^x\d+$/.test(k)).map(k => data[k]?.pullRequest);
        const seen = new Set();
        this._items = [...data.search.nodes, ...extraNodes]
            .filter(n => n?.number && !seen.has(n.url) && seen.add(n.url))
            .map(n => {
                const c = classify(n, ctx, this._prev.get(n.url));
                this._prev.set(n.url, c);
                return c;
            });
        this._error = partialError;
        this._updatedAt = Date.now();
        writeJson(CACHE_PATH, this._items.map(p => ({key: p.key, title: p.title})));
        this._updatePill();
        this._renderWhenClosed();
    }

    _fail(message) {
        this._busy = false;
        this._error = message;
        this._updatePill();
        this._renderWhenClosed();
    }

    _updatePill() {
        const c = counts(this._items);
        const failed = this._error && !this._updatedAt;
        this._total.text = failed ? '!' : String(c.total);
        this._total.style_class = failed ? 'prw-total prw-error' : 'prw-total';
        for (const k of COUNTERS) {
            this._badges[k].text = String(c[k]);
            this._badges[k].visible = !failed && c[k] > 0;
        }
    }

    _render() {
        this._dirty = false;
        this.menu.removeAll();
        const content = new St.BoxLayout({vertical: true, style_class: 'prw-content'});
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'prw-item'});
        item.add_child(content);
        this.menu.addMenuItem(item);

        const header = new St.BoxLayout({style_class: 'prw-header'});
        header.add_child(label('Minhas PRs', 'prw-title'));
        this._updatedLabel = label('', 'prw-muted', {x_expand: true});
        this._syncUpdated();
        header.add_child(this._updatedLabel);
        // Troca de visualização só na memória: salvar no config dispararia outra consulta ao GitHub.
        const views = new St.BoxLayout({style_class: 'prw-views'});
        for (const [id, name] of Object.entries(VIEWS)) {
            const tab = new St.BoxLayout({style_class: 'prw-tab-box'});
            tab.add_child(label(name));
            if (this._view === id)
                tab.add_child(label(String(this._items.length), 'prw-counter'));
            const btn = new St.Button({child: tab, can_focus: true, toggle_mode: true, checked: this._view === id, style_class: 'prw-view'});
            btn.connect('clicked', () => {
                this._view = id;
                this._render();
            });
            views.add_child(btn);
        }
        header.add_child(views);
        const refresh = iconButton('view-refresh-symbolic', 'Atualizar agora', () => this.refresh());
        refresh.add_style_class_name('prw-flat');
        header.add_child(refresh);
        content.add_child(header);

        if (this._error)
            content.add_child(label(`Erro ao consultar o GitHub: ${this._error}`, 'prw-errortext'));
        if (!this._cfg.reviewer)
            content.add_child(label(`Defina "reviewer" em ${CONFIG_PATH} para ver o status do reviewer.`, 'prw-errortext'));

        const c = counts(this._items);
        const chips = new St.BoxLayout({style_class: 'prw-chips'});
        for (const [k, text] of [['reply', 'pedem sua resposta'], ['waiting', `aguardando ${this._cfg.reviewerName}`], ['ready', 'prontas para merge'], ['conflict', 'com conflito'], ['noReview', 'sem review']]) {
            if (c[k])
                chips.add_child(label(`${c[k]} ${text}`, `prw-chip prw-chip-${k}`));
        }
        content.add_child(chips);

        this._search = new St.Entry({hint_text: 'Buscar por número ou título', can_focus: true, x_expand: true, style_class: 'prw-entry prw-search', text: this._query ?? ''});
        this._search.set_primary_icon(new St.Icon({icon_name: 'edit-find-symbolic', icon_size: 14}));
        this._search.clutter_text.connect('text-changed', () => {
            this._query = this._search.text;
            this._applyFilter();
        });
        content.add_child(this._search);

        const list = new St.BoxLayout({vertical: true, style_class: 'prw-list'});
        const extraKeys = new Set(this._cfg.extra);
        this._groupRefs = [];
        for (const g of groupPrs(this._items, this._cfg, extraKeys, this._view))
            list.add_child(this._group(g));
        this._noMatch = label('Nenhuma PR encontrada.', 'prw-muted', {visible: false});
        list.add_child(this._noMatch);
        const scroll = new St.ScrollView({style_class: 'prw-scroll', hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC});
        scroll.set_child(list);
        content.add_child(scroll);

        content.add_child(this._footer());
        this._applyFilter();
    }

    // Filtra em memória: nenhuma consulta nova ao GitHub.
    _applyFilter() {
        const q = this._query ?? '';
        let any = false;
        for (const g of this._groupRefs) {
            let shown = 0;
            for (const {p, row} of g.items) {
                row.visible = matchesQuery(p, q);
                shown += row.visible ? 1 : 0;
            }
            g.box.visible = shown > 0;
            // buscando, grupos recolhidos abrem para mostrar o que casou
            g.rows.visible = q.trim() ? true : !this._collapsed.has(g.id);
            g.toggle.child.icon_name = g.rows.visible ? 'pan-down-symbolic' : 'pan-end-symbolic';
            any ||= shown > 0;
        }
        this._noMatch.visible = !any && this._items.length > 0;
    }

    _syncUpdated() {
        this._updatedLabel.text = this._updatedAt
            ? `${this._items.length} abertas · ${relTime(new Date(this._updatedAt).toISOString())}`
            : 'Atualizando…';
    }

    _group(g) {
        const box = new St.BoxLayout({vertical: true, style_class: 'prw-group'});
        const head = new St.BoxLayout({style_class: 'prw-group-header'});
        const rows = new St.BoxLayout({vertical: true, visible: !this._collapsed.has(g.id)});
        const toggle = iconButton(rows.visible ? 'pan-down-symbolic' : 'pan-end-symbolic', `Recolher ou expandir ${g.name}`, () => {
            rows.visible = !rows.visible;
            if (rows.visible)
                this._collapsed.delete(g.id);
            else
                this._collapsed.add(g.id);
            toggle.child.icon_name = rows.visible ? 'pan-down-symbolic' : 'pan-end-symbolic';
        });
        toggle.add_style_class_name('prw-flat');
        toggle.add_style_class_name('prw-toggle');
        head.add_child(toggle);
        // a cor do grupo só importa na visão por grupo; por status o ícone de cada PR já diz
        if (this._view === 'group')
            head.add_child(new St.Widget({style_class: 'prw-dot', style: `background-color: ${g.color};`, y_align: Clutter.ActorAlign.CENTER}));
        head.add_child(label(g.name, 'prw-group-name'));
        head.add_child(label(String(g.prs.length), 'prw-counter', {accessible_name: `${g.prs.length} PRs`}));
        const conflicts = g.prs.filter(p => p.conflict).length;
        const note = g.note ?? (conflicts && g.id !== 'conflict' ? `${conflicts} com conflito` : '');
        head.add_child(label(note, 'prw-muted prw-note', {x_expand: true, x_align: Clutter.ActorAlign.END}));
        box.add_child(head);
        const items = g.prs.map(p => ({p, row: this._row(p)}));
        for (const {row} of items)
            rows.add_child(row);
        box.add_child(rows);
        this._groupRefs.push({id: g.id, box, rows, toggle, items});
        return box;
    }

    _row(p) {
        const row = new St.BoxLayout({style_class: 'prw-row', reactive: true, track_hover: true, can_focus: true});
        const [state] = STATE.find(([, test]) => test(p));
        row.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(`${this._ext.path}/state-${state}-symbolic.svg`),
            icon_size: 16, style_class: `prw-state prw-state-${state}`, y_align: Clutter.ActorAlign.START,
        }));

        const body = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'prw-row-body'});
        const title = label(p.title, 'prw-pr-title', {x_expand: true});
        title.clutter_text.line_wrap = true;
        title.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        title.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        body.add_child(title);

        // tudo que não é o título numa linha cinza; só o conflito ganha cor
        const parts = [esc(`${p.repo} #${p.num}`), esc(STATUS[p.status])];
        if (p.waitingBot)
            parts.push('você respondeu');
        if (p.conflict)
            parts.push(`<span foreground="#e275ad">${esc(`conflito com ${p.base}`)}</span>`);
        const meta = label('', 'prw-meta');
        meta.clutter_text.set_markup(parts.join(' · '));
        meta.clutter_text.line_wrap = true;
        body.add_child(meta);
        row.add_child(body);

        // números à direita, no mesmo lugar em toda linha; os botões ocupam esse lugar no hover
        const info = new St.BoxLayout({vertical: true, style_class: 'prw-info', y_align: Clutter.ActorAlign.START});
        const reviews = new St.BoxLayout({style_class: 'prw-info-line', x_align: Clutter.ActorAlign.END,
            accessible_name: `${p.reviews} reviews do ${this._cfg.reviewerName}`});
        reviews.add_child(new St.Icon({gicon: Gio.icon_new_for_string(`${this._ext.path}/state-reply-symbolic.svg`), icon_size: 12}));
        reviews.add_child(label(String(p.reviews)));
        info.add_child(reviews);
        if (p.since)
            info.add_child(label(relTime(p.since), '', {x_align: Clutter.ActorAlign.END}));
        row.add_child(info);

        const actions = new St.BoxLayout({style_class: 'prw-actions', y_align: Clutter.ActorAlign.START, visible: false});
        actions.add_child(iconButton('web-browser-symbolic', `Abrir PR ${p.num} no navegador`, () => {
            Gio.AppInfo.launch_default_for_uri(p.url, null);
            this.menu.close();
        }));
        const copy = iconButton('edit-copy-symbolic', `Copiar link da PR ${p.num}`, () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, p.url);
            copy.child.icon_name = 'object-select-symbolic';
            copy.add_style_class_name('prw-btn-done');
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1600, () => {
                if (!this._destroyed && copy.get_stage()) {
                    copy.child.icon_name = 'edit-copy-symbolic';
                    copy.remove_style_class_name('prw-btn-done');
                }
                return GLib.SOURCE_REMOVE;
            });
        });
        actions.add_child(copy);
        row.add_child(actions);

        // botões aparecem com o mouse em cima ou com o foco do teclado na linha ou num dos botões
        const sync = () => {
            const focus = global.stage.key_focus;
            const active = row.hover || (focus !== null && row.contains(focus));
            actions.visible = active;
            info.visible = !active;
            if (active)
                row.add_style_pseudo_class('active');
            else
                row.remove_style_pseudo_class('active');
        };
        row.connect('notify::hover', sync);
        for (const a of [row, ...actions.get_children()]) {
            a.connect('key-focus-in', sync);
            a.connect('key-focus-out', () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (!this._destroyed && row.get_stage())
                    sync();
                return GLib.SOURCE_REMOVE;
            }));
        }
        return row;
    }

    _footer() {
        const box = new St.BoxLayout({vertical: true, style_class: 'prw-footer'});
        box.add_child(label('Monitorar outra PR', 'prw-group-name'));
        const line = new St.BoxLayout({style_class: 'prw-line'});
        const entry = new St.Entry({hint_text: 'URL da PR ou repo#número', can_focus: true, x_expand: true, style_class: 'prw-entry'});
        const error = label('Use a URL da PR ou org/repo#número (só repo#número se "defaultOwner" estiver configurado).', 'prw-errortext', {visible: false});
        const add = () => {
            const key = parsePrRef(entry.text, this._cfg.defaultOwner);
            if (!key) {
                error.visible = true;
                return;
            }
            if (!this._cfg.extra.includes(key)) {
                this._cfg.extra = [...this._cfg.extra, key];
                saveConfig(this._cfg); // o monitor do arquivo dispara a atualização
            }
            entry.text = '';
            error.visible = false;
        };
        entry.clutter_text.connect('activate', add);
        const btn = new St.Button({label: 'Adicionar', style_class: 'prw-primary', can_focus: true});
        btn.connect('clicked', add);
        line.add_child(entry);
        line.add_child(btn);
        box.add_child(line);
        box.add_child(error);
        const org = new St.Button({label: 'Organizar grupos e cores', style_class: 'prw-link', x_align: Clutter.ActorAlign.START, can_focus: true});
        org.connect('clicked', () => {
            this.menu.close();
            this._ext.openPreferences();
        });
        box.add_child(org);
        return box;
    }

    destroy() {
        this._destroyed = true;
        if (this._timer)
            GLib.source_remove(this._timer);
        if (this._debounce)
            GLib.source_remove(this._debounce);
        this._monitor?.cancel();
        super.destroy();
    }
});

export default class PrWidgetExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        // depois do Spotify (1) e dos fones (2)
        Main.panel.addToStatusArea(this.uuid, this._indicator, 3, 'left');
        // Super+G: abre (ou fecha) o menu; o foco vai para a busca ao abrir
        Main.wm.addKeybinding('open-shortcut', this.getSettings(), Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._indicator.menu.toggle());
    }

    disable() {
        Main.wm.removeKeybinding('open-shortcut');
        this._indicator.destroy();
        this._indicator = null;
    }
}
