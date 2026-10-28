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
import {COLUMNS, columnMap, tally, pickActiveSprint, burndownSeries, daysLeft, toJql, epicJql, attachmentUrl, initials} from './logic.js';
import {loadConfig, readJson, writeJson, CONFIG_PATH, CACHE_PATH} from './config.js';
import {lookupToken} from './secret.js';
import {JiraClient} from './jira.js';
import {fetchCardPrs} from './prs.js';
import {Burndown} from './chart.js';

const DAY = 86400e3;
const FIELDS = 'summary,status,assignee,parent,issuetype,attachment';
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const ERRORS = {
    config: `Preencha site, email e board em ${CONFIG_PATH}.`,
    notoken: 'Cole seu token do Jira para começar.',
    auth: 'Token inválido ou expirado.',
    net: 'Sem conexão com o Jira. Mostrando o último placar.',
};

const day = iso => {
    const d = new Date(iso);
    return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

const wrap = l => {
    l.clutter_text.line_wrap = true;
    l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return l;
};

const button = (text, style_class, onClick, props = {}) => {
    const b = new St.Button({label: text, style_class, can_focus: true, ...props});
    b.connect('clicked', onClick);
    return b;
};

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
        this._prCache = new Map();
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
        this.menu.connect('open-state-changed', (_m, open) => {
            // aberto não refaz o conteúdo (apagaria o que está sendo digitado)
            if (open && this._dirty)
                this._render();
            if (open) {
                // depois do foco que o próprio menu põe no primeiro item ao abrir
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    if (this.menu.isOpen && this._search.get_stage()) {
                        this._search.grab_key_focus();
                        this._search.clutter_text.set_cursor_position(-1);
                    }
                    return GLib.SOURCE_REMOVE;
                });
                // última busca salva, mas sem resultado na memória (ex.: depois do login)
                if (this._pendingSearch) {
                    this._pendingSearch = false;
                    this._runSearch(this._search.text);
                } else if (this._pendingPrRow) {
                    this._openCard(this._pendingPrRow);
                }
                // anima só aberto e com o gráfico à vista
                if (this._burndownBox.visible)
                    this._chart?.start();
            } else {
                // a busca fica: reabrir mostra o mesmo texto e os mesmos resultados, sem consultar
                this._chart?.stop();
                this._searchCancel?.cancel();
                this._prCancel?.cancel();
            }
        });

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
            this._prCache.clear();
            this._persist();
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
        const {sprint, error} = this._state;

        const header = new St.BoxLayout({style_class: 'jw-header'});
        header.add_child(label(sprint?.name ?? 'Nenhuma sprint ativa', 'jw-title'));
        if (sprint) {
            header.add_child(label('ATIVA', 'jw-tag jw-tag-blue'));
            const left = daysLeft(sprint.endDate);
            header.add_child(label(`${day(sprint.startDate)} – ${day(sprint.endDate)} · ${left === 1 ? '1 dia restante' : `${left} dias restantes`}`,
                'jw-muted', {x_expand: true, x_align: Clutter.ActorAlign.END}));
        } else {
            header.add_child(new St.Widget({x_expand: true}));
        }
        const gear = new St.Button({style_class: 'jw-icon-btn', child: new St.Icon({icon_name: 'emblem-system-symbolic', icon_size: 16}),
            accessible_name: 'Configurar Jira', can_focus: true});
        gear.connect('clicked', () => this._openPrefs());
        header.add_child(gear);
        content.add_child(header);

        if (error) {
            const box = new St.BoxLayout({vertical: true, style_class: 'jw-notice'});
            box.add_child(wrap(label(ERRORS[error], 'jw-notice-text')));
            if (error === 'notoken' || error === 'auth')
                box.add_child(button('Colar token', 'jw-primary', () => this._openPrefs(), {x_align: Clutter.ActorAlign.START}));
            content.add_child(box);
        }

        const field = new St.BoxLayout({style_class: 'jw-search-box'});
        field.add_child(new St.Icon({icon_name: 'edit-find-symbolic', icon_size: 16, style_class: 'jw-muted', y_align: Clutter.ActorAlign.CENTER}));
        this._search = new St.Entry({hint_text: `Pesquisar por ${this._cfg.project || 'PROJ'}-123, título ou épico`, can_focus: true, x_expand: true, style_class: 'jw-search',
            text: this._state.lastQuery ?? ''});
        this._search.clutter_text.connect('text-changed', () => this._queueSearch());
        field.add_child(this._search);
        content.add_child(field);

        this._burndownBox = new St.BoxLayout({vertical: true, style_class: 'jw-block'});
        const bdHead = new St.BoxLayout();
        bdHead.add_child(label('Gráfico de burndown', 'jw-block-title', {x_expand: true}));
        bdHead.add_child(label('Story Points', 'jw-muted'));
        this._burndownBox.add_child(bdHead);
        this._chart = null;
        if (this._state.burndown) {
            this._chart = new Burndown();
            this._chart.setData(this._state.burndown);
            this._burndownBox.add_child(this._chart);
        } else {
            this._burndownBox.add_child(label(sprint ? 'Burndown indisponível' : 'Sem sprint ativa para o burndown', 'jw-muted'));
        }
        content.add_child(this._burndownBox);

        this._status = label('', 'jw-muted', {visible: false});
        content.add_child(this._status);
        this._results = new St.BoxLayout({vertical: true, style_class: 'jw-results'});
        const scroll = new St.ScrollView({style_class: 'jw-scroll', hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC});
        scroll.set_child(this._results);
        content.add_child(scroll);
        this._restoreSearch();
    }

    // Redesenho (ciclo de 15 min, login) mantém a busca: da memória se der, senão busca ao abrir.
    _restoreSearch() {
        const q = this._search.text;
        if (!q.trim())
            return;
        this._burndownBox.visible = false;
        if (this._lastResult?.q === q)
            this._showRows(this._lastResult.issues);
        else
            this._pendingSearch = true;
    }

    _persist() {
        const {error: _e, ...persist} = this._state;
        writeJson(CACHE_PATH, persist);
    }

    _openPrefs() {
        this.menu.close();
        this._ext.openPreferences();
    }

    // Espera parar de digitar; cancela a busca anterior em andamento.
    _queueSearch() {
        if (this._searchTimer)
            GLib.source_remove(this._searchTimer);
        const q = this._search.text;
        const empty = !q.trim();
        this._burndownBox.visible = empty;
        if (empty && this.menu.isOpen)
            this._chart?.start();
        else
            this._chart?.stop();
        if (empty) {
            this._searchCancel?.cancel();
            this._results.destroy_all_children();
            this._status.visible = false;
            this._lastResult = null;
            this._pendingSearch = false;
            if (this._state.lastQuery) {
                this._state.lastQuery = '';
                this._persist();
            }
            return;
        }
        this._searchTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._searchTimer = null;
            this._runSearch(q);
            return GLib.SOURCE_REMOVE;
        });
    }

    async _runSearch(q) {
        this._searchCancel?.cancel();
        const cancel = this._searchCancel = new Gio.Cancellable();
        this._showStatus('Pesquisando…');
        try {
            if (!await this._getClient())
                throw Object.assign(new Error('token'), {kind: 'notoken'});
            const project = this._cfg.project;
            let jq = toJql(q, project);
            if (!jq.byKey) {
                const epics = await this._client.request('/rest/api/3/search/jql', {jql: epicJql(q, project), fields: 'summary', maxResults: 10}, cancel);
                jq = toJql(q, project, epics.issues.map(i => i.key));
            }
            const r = await this._client.request('/rest/api/3/search/jql', {jql: jq.jql, fields: FIELDS, maxResults: 10}, cancel);
            if (cancel.is_cancelled())
                return;
            this._lastResult = {q, issues: r.issues};
            this._state.lastQuery = q;
            this._persist();
            this._showRows(r.issues);
        } catch (e) {
            if (cancel.is_cancelled() || this._destroyed)
                return;
            // busca por chave inexistente volta 400 no Jira: é "não achei", não erro
            if (e.status === 400 && toJql(q, this._cfg.project)?.byKey) {
                this._results.destroy_all_children();
                this._showStatus('Nenhum card encontrado.');
                return;
            }
            this._showStatus(ERRORS[e.kind ?? (e.status === 401 || e.status === 403 ? 'auth' : 'net')]);
        }
    }

    _showRows(issues) {
        this._results.destroy_all_children();
        this._rows = issues.map(issue => ({issue, box: new St.BoxLayout({vertical: true, style_class: 'jw-result'})}));
        for (const row of this._rows)
            this._results.add_child(row.box);
        this._rows.forEach((row, i) => this._fillRow(row, i === 0));
        this._showStatus(issues.length ? '' : 'Nenhum card encontrado.');
    }

    _showStatus(text) {
        this._status.text = text;
        this._status.visible = Boolean(text);
    }

    _lozenge(status) {
        const col = columnMap(this._state.board).get(String(status?.id)) ?? 'none';
        return label((status?.name ?? '').toUpperCase(), `jw-tag jw-st-${col}`);
    }

    // Um card aberto por vez: clicar numa linha fechada abre ela e fecha a anterior.
    _fillRow(row, open) {
        row.box.destroy_all_children();
        row.open = open;
        const f = row.issue.fields;
        if (!open) {
            const line = new St.Button({style_class: 'jw-row', can_focus: true, x_expand: true, accessible_name: `${row.issue.key} ${f.summary}`});
            const b = new St.BoxLayout({style_class: 'jw-row-box', x_expand: true});
            b.add_child(label(row.issue.key, 'jw-key'));
            const title = label(f.summary, 'jw-row-title', {x_expand: true});
            title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            b.add_child(title);
            b.add_child(this._lozenge(f.status));
            line.set_child(b);
            line.connect('clicked', () => {
                for (const other of this._rows.filter(r => r.open))
                    this._fillRow(other, false);
                this._fillRow(row, true);
            });
            row.box.add_child(line);
            return;
        }
        const card = new St.BoxLayout({vertical: true, style_class: 'jw-card'});
        const path = new St.BoxLayout({style_class: 'jw-path'});
        if (f.parent) {
            path.add_child(button(f.parent.fields?.summary ?? f.parent.key, 'jw-link', () => this._launch(this._browse(f.parent.key))));
            path.add_child(label('/', 'jw-muted'));
        }
        path.add_child(button(row.issue.key, 'jw-link jw-key-link', () => this._launch(this._browse(row.issue.key))));
        path.add_child(new St.Widget({x_expand: true}));
        path.add_child(this._lozenge(f.status));
        card.add_child(path);
        card.add_child(wrap(label(f.summary, 'jw-card-title')));

        const grid = new St.BoxLayout({vertical: true, style_class: 'jw-fields'});
        const fieldRow = (name, value) => {
            const r = new St.BoxLayout({style_class: 'jw-field'});
            r.add_child(label(name, 'jw-field-name', {y_align: Clutter.ActorAlign.START}));
            r.add_child(value);
            grid.add_child(r);
        };
        const who = new St.BoxLayout({style_class: 'jw-who'});
        if (f.assignee) {
            who.add_child(label(initials(f.assignee.displayName), 'jw-avatar'));
            who.add_child(label(f.assignee.displayName));
        } else {
            who.add_child(label('Sem responsável', 'jw-muted'));
        }
        fieldRow('Responsável', who);
        row.dev = new St.BoxLayout({vertical: true, style_class: 'jw-dev'});
        row.dev.add_child(label('buscando PRs…', 'jw-muted'));
        fieldRow('Desenvolvimento', row.dev);
        const atts = new St.BoxLayout({vertical: true, style_class: 'jw-atts'});
        for (const a of f.attachment ?? [])
            atts.add_child(button(a.filename, 'jw-link', () => this._launch(attachmentUrl(this._cfg.site, a)), {x_align: Clutter.ActorAlign.START}));
        if (!atts.get_n_children())
            atts.add_child(label('Nenhum', 'jw-muted'));
        fieldRow('Anexos', atts);
        card.add_child(grid);

        row.actions = new St.BoxLayout({style_class: 'jw-actions'});
        row.actions.add_child(button('Abrir no Jira', 'jw-primary', () => this._launch(this._browse(row.issue.key))));
        const copy = button('Copiar link', 'jw-secondary', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._browse(row.issue.key));
            copy.label = 'Copiado';
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1600, () => {
                // o card pode ter sido redesenhado nesse meio tempo (botão já destruído)
                if (copy._alive)
                    copy.label = 'Copiar link';
                return GLib.SOURCE_REMOVE;
            });
        });
        copy._alive = true;
        copy.connect('destroy', () => (copy._alive = false));
        row.actions.add_child(copy);
        card.add_child(row.actions);
        row.box.add_child(card);
        this._openCard(row);
    }

    _browse(key) {
        return `${this._cfg.site}/browse/${key}`;
    }

    _launch(uri) {
        Gio.AppInfo.launch_default_for_uri(uri, null);
        this.menu.close();
    }

    // PRs só deste card, só quando ele abre; a busca anterior de PRs é cancelada.
    async _openCard(row) {
        // redesenho com o menu fechado (ciclo de 15 min): PRs só quando abrir
        if (!this.menu.isOpen) {
            this._pendingPrRow = row;
            return;
        }
        this._pendingPrRow = null;
        this._prCancel?.cancel();
        const cancel = this._prCancel = new Gio.Cancellable();
        const dev = row.dev;
        let prs;
        try {
            const prDir = Main.extensionManager.lookup('pr-widget@pedrourio.github.io')?.path;
            prs = this._prCache.get(row.issue.key) ?? await fetchCardPrs(row.issue.key, this._cfg.githubOwner, cancel, prDir);
            this._prCache.set(row.issue.key, prs);
        } catch (e) {
            console.error(`jira-widget: PRs de ${row.issue.key}: ${e.message}`);
            if (cancel.is_cancelled() || !dev.get_stage())
                return;
            dev.destroy_all_children();
            dev.add_child(wrap(label(`PRs indisponíveis: ${e.message}`, 'jw-muted')));
            return;
        }
        if (cancel.is_cancelled() || !dev.get_stage())
            return;
        dev.destroy_all_children();
        for (const pr of prs) {
            const b = new St.Button({style_class: 'jw-link', can_focus: true, x_align: Clutter.ActorAlign.START, accessible_name: `${pr.repo} #${pr.num}`});
            const l = label('', '');
            l.clutter_text.set_markup(`${GLib.markup_escape_text(`${pr.repo} #${pr.num}`, -1)} <span foreground="${pr.state === 'OPEN' ? '#f8e6a0' : '#8c9bab'}">· ${GLib.markup_escape_text(pr.text, -1)}</span>`);
            b.set_child(l);
            b.connect('clicked', () => this._launch(pr.url));
            dev.add_child(b);
        }
        if (!prs.length)
            dev.add_child(label('Nenhuma PR encontrada no GitHub', 'jw-muted'));
        const open = prs.find(p => p.state === 'OPEN');
        if (open)
            row.actions.add_child(button(`Abrir PR #${open.num}`, 'jw-secondary', () => this._launch(open.url)));
    }

    destroy() {
        this._destroyed = true;
        if (this._timer)
            GLib.source_remove(this._timer);
        if (this._debounce)
            GLib.source_remove(this._debounce);
        this._monitor?.cancel();
        if (this._searchTimer)
            GLib.source_remove(this._searchTimer);
        this._searchCancel?.cancel();
        this._prCancel?.cancel();
        this._client?.abort();
        super.destroy();
    }
});

export default class JiraWidgetExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        // depois do Spotify (1), dos fones (2) e das PRs (3)
        Main.panel.addToStatusArea(this.uuid, this._indicator, 4, 'left');
        // Super+J: abre (ou fecha) o menu; o foco vai para a busca ao abrir
        Main.wm.addKeybinding('open-shortcut', this.getSettings(), Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._indicator.menu.toggle());
    }

    disable() {
        Main.wm.removeKeybinding('open-shortcut');
        this._indicator.destroy();
        this._indicator = null;
    }
}
