import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {COLUMNS, columnMap, tally, pickActiveSprint, burndownSeries} from './logic.js';
import {loadConfig, readJson, writeJson, CONFIG_PATH, CACHE_PATH} from './config.js';
import {lookupToken} from './secret.js';
import {JiraClient} from './jira.js';

const DAY = 86400e3;

const label = (text, style_class = '', props = {}) =>
    new St.Label({text, style_class, y_align: Clutter.ActorAlign.CENTER, ...props});

// Nome do tipo derivado do caminho do arquivo: o ext-reload carrega cópias em caminhos novos
// e o GObject não aceita registrar o mesmo nome duas vezes.
const Indicator = GObject.registerClass({GTypeName: `JwIndicator_${GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, import.meta.url, -1)}`},
class Indicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Jira', false);
        this._ext = ext;
        this._cfg = loadConfig();
        // Barra aparece com o último valor conhecido antes de qualquer rede.
        this._state = {sprint: null, counts: null, burndown: null, error: null, updatedAt: null, me: null, board: null, boardAt: 0, ...readJson(CACHE_PATH, {})};
        this._state.error = null;

        const box = new St.BoxLayout({style_class: 'jw-pill'});
        box.add_child(new St.Icon({gicon: Gio.icon_new_for_string(`${ext.path}/jira-symbolic.svg`), style_class: 'system-status-icon'}));
        this._sprintLabel = label('–', 'jw-sprint');
        box.add_child(this._sprintLabel);
        this._lz = {};
        const kda = new St.BoxLayout({style_class: 'jw-kda'});
        for (const c of COLUMNS) {
            this._lz[c] = label('', `jw-lz jw-${c}`, {visible: false});
            kda.add_child(this._lz[c]);
        }
        box.add_child(kda);
        this.add_child(box);
        this._updatePill();

        this.menu.box.add_style_class_name('jw-menu');
        this._render();

        this._monitor = Gio.File.new_for_path(CONFIG_PATH).monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', (_m, _f, _o, event) => {
            if (event !== Gio.FileMonitorEvent.CHANGES_DONE_HINT && event !== Gio.FileMonitorEvent.CREATED)
                return;
            if (this._debounce)
                GLib.source_remove(this._debounce);
            this._debounce = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 2, () => {
                this._debounce = null;
                this._cfg = loadConfig();
                this._client = null;
                this._startTimer();
                this.refreshCycle();
                return GLib.SOURCE_REMOVE;
            });
        });

        this.refreshCycle();
        this._startTimer();
    }

    _startTimer() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, Math.max(1, this._cfg.intervalMinutes) * 60, () => {
            this.refreshCycle();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // Token relido a cada ciclo: salvar um token novo nas preferências vale no próximo ciclo.
    async _getClient() {
        const token = this._cfg.site ? await lookupToken(this._cfg.site) : null;
        if (!token)
            return null;
        if (!this._client || this._token !== token) {
            this._client?.abort();
            this._token = token;
            this._client = new JiraClient(this._cfg, token);
        }
        return this._client;
    }

    async _pages(jql, fields) {
        const out = [];
        let token = null;
        do {
            const r = await this._client.request('/rest/api/3/search/jql', {jql, fields, maxResults: 100, ...(token ? {nextPageToken: token} : {})});
            out.push(...r.issues);
            token = r.isLast === false ? r.nextPageToken : null;
        } while (token);
        return out;
    }

    async refreshCycle() {
        if (this._busy)
            return;
        this._busy = true;
        const s = this._state;
        try {
            if (!this._cfg.site || !this._cfg.email || !this._cfg.boardId)
                throw Object.assign(new Error('config'), {kind: 'config'});
            if (!await this._getClient())
                throw Object.assign(new Error('token'), {kind: 'notoken'});
            const c = this._client;
            if (!s.me)
                s.me = (await c.request('/rest/api/3/myself')).accountId;
            if (!s.board || Date.now() - s.boardAt > DAY) {
                s.board = await c.request(`/rest/agile/1.0/board/${this._cfg.boardId}/configuration`);
                s.boardAt = Date.now();
            }
            s.sprint = pickActiveSprint((await c.request(`/rest/agile/1.0/board/${this._cfg.boardId}/sprint`, {state: 'active'})).values);
            if (s.sprint) {
                const mine = await this._pages(`sprint = ${s.sprint.id} AND assignee = currentUser()`, 'status,assignee');
                s.counts = tally(mine, columnMap(s.board), s.me);
                // falha do burndown (endpoint interno) não derruba o placar
                try {
                    const params = {rapidViewId: this._cfg.boardId, sprintId: s.sprint.id};
                    if (this._cfg.pointsField)
                        params.statisticFieldId = `field_${this._cfg.pointsField}`;
                    s.burndown = burndownSeries(await c.request('/rest/greenhopper/1.0/rapid/charts/scopechangeburndownchart', params));
                } catch {
                    s.burndown = null;
                }
            } else {
                s.counts = null;
                s.burndown = null;
            }
            s.error = null;
            s.updatedAt = Date.now();
            const {error: _e, ...persist} = s;
            writeJson(CACHE_PATH, persist);
        } catch (e) {
            s.error = e.kind ?? (e.status === 401 || e.status === 403 ? 'auth' : 'net');
        } finally {
            this._busy = false;
        }
        if (this._destroyed)
            return;
        this._updatePill();
        this._renderWhenClosed();
    }

    _updatePill() {
        const {sprint, counts, error} = this._state;
        this._sprintLabel.text = sprint?.number != null ? `S${sprint.number}` : sprint ? 'S' : '–';
        for (const c of COLUMNS) {
            this._lz[c].text = String(counts?.[c] ?? 0);
            this._lz[c].visible = Boolean(counts);
        }
        // valor velho continua visível, mas apagado
        if (error)
            this.add_style_class_name('jw-stale');
        else
            this.remove_style_class_name('jw-stale');
    }

    _renderWhenClosed() {
        if (this.menu.isOpen)
            this._dirty = true;
        else
            this._render();
    }

    // PopupMenu vazio não abre: o conteúdo precisa existir antes do primeiro clique.
    _render() {
        this._dirty = false;
        this.menu.removeAll();
        const content = new St.BoxLayout({vertical: true, style_class: 'jw-content'});
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'jw-item'});
        item.add_child(content);
        this.menu.addMenuItem(item);
        content.add_child(label(this._state.sprint?.name ?? 'Nenhuma sprint ativa', 'jw-title'));
    }

    destroy() {
        this._destroyed = true;
        if (this._timer)
            GLib.source_remove(this._timer);
        if (this._debounce)
            GLib.source_remove(this._debounce);
        this._monitor?.cancel();
        this._client?.abort();
        super.destroy();
    }
});

export default class JiraWidgetExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        // depois do Spotify (1), dos fones (2) e das PRs (3)
        Main.panel.addToStatusArea(this.uuid, this._indicator, 4, 'left');
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}
