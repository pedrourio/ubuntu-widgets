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
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {COLUMNS, columnMap, tally, pickActiveSprint, burndownSeries, daysLeft, toJql, epicJql, attachmentUrl, initials, parseChangelogs, kpis, flowEfficiency,
    similarJql, previewSchema, cardPrompt, mergePreview, issueBody, CARD_FIELDS, POINTS} from './logic.js';
import {runClaude} from './claude.js';
import {loadConfig, readJson, writeJson, CONFIG_PATH, CACHE_PATH} from './config.js';
import {lookupToken} from './secret.js';
import {JiraClient} from './jira.js';
import {fetchCardPrs, fetchDelivery} from './prs.js';
import {Burndown} from './chart.js';

const DAY = 86400e3;
const DELIVERY_EVERY = 6 * 3600e3;
const DELIVERY_DAYS = 30;
const FIELDS = 'summary,status,assignee,parent,issuetype,attachment';
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const ERRORS = {
    config: `Preencha site, email e board em ${CONFIG_PATH}.`,
    notoken: 'Cole seu token do Jira para começar.',
    auth: 'Token inválido ou expirado.',
    net: 'Sem conexão com o Jira. Mostrando o último placar.',
};

const FIELD_NAMES = {type: 'Tipo', sprint: 'Sprint', epic: 'Épico', assignee: 'Responsável', points: 'Pontos', priority: 'Prioridade',
    description: 'Descrição', criteria: 'Critérios de aceite'};
const TEXT_FIELDS = ['description', 'criteria'];

// Opções de um campo a partir do contexto do Jira: [[valor, texto]]
const fieldOptions = (f, ctx) => ({
    type: ctx.types.map(t => [t, t]),
    sprint: [...ctx.sprints.map(sp => [String(sp.id), sp.state === 'active' ? `${sp.name} (ativa)` : sp.name]), ['backlog', 'Backlog']],
    epic: [['', 'Sem épico'], ...ctx.epics.map(e => [e.key, `${e.key} · ${e.summary}`])],
    assignee: [['', 'Sem responsável'], ...ctx.people.map(p => [p.id, p.name])],
    points: POINTS.map(n => [n, String(n)]),
    priority: ctx.priorities.map(p => [p, p]),
})[f] ?? [];

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
        this._drafts = []; // pedidos de card ao Claude; só em memória
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
        this._aiLabel = label('✦', 'jw-ai', {visible: false});
        box.add_child(this._aiLabel);
        this.add_child(box);
        this._updatePill();

        this.menu.box.add_style_class_name('jw-menu');
        this._view = 'sprint';
        this._form = null;
        // Ctrl+N abre o formulário; Esc no formulário ou na prévia volta para a sprint em vez de fechar.
        // captured-event ligado antes do PopupMenuManager (que fecha o menu no Esc pelo mesmo sinal).
        this.menu.actor.connect('captured-event', (_a, ev) => {
            if (ev.type() !== Clutter.EventType.KEY_PRESS)
                return Clutter.EVENT_PROPAGATE;
            const sym = ev.get_key_symbol();
            if (sym === Clutter.KEY_n && (ev.get_state() & Clutter.ModifierType.CONTROL_MASK)) {
                this._openForm();
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Escape && this._view !== 'sprint') {
                this._showView('sprint');
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
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
            this._tickStrips();
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
                const colMap = columnMap(s.board);
                const mine = await this._pages(`sprint = ${s.sprint.id} AND assignee = currentUser()`, 'status,assignee');
                s.counts = tally(mine, colMap, s.me);
                // KPIs: cards da sprint de todo mundo + histórico de status numa chamada só (por página de 1000)
                try {
                    const all = await this._pages(`sprint = ${s.sprint.id}`, 'status,assignee');
                    const logs = {issueChangeLogs: []};
                    let next = null;
                    do {
                        const r = await c.post('/rest/api/3/changelog/bulkfetch', {issueIdsOrKeys: all.map(i => i.id), fieldIds: ['status'], maxResults: 1000, ...(next ? {nextPageToken: next} : {})});
                        logs.issueChangeLogs.push(...r.issueChangeLogs);
                        next = r.nextPageToken ?? null;
                    } while (next);
                    s.kpis = kpis(all, parseChangelogs(logs), colMap, {start: Date.parse(s.sprint.startDate), now: Date.now()}, s.me, this._cfg.team ?? []);
                } catch {
                    s.kpis = null;
                }
                // falha do burndown (endpoint interno) não derruba o placar
                try {
                    const params = {rapidViewId: this._cfg.boardId, sprintId: s.sprint.id};
                    if (this._cfg.pointsField)
                        params.statisticFieldId = `field_${this._cfg.pointsField}`;
                    s.burndown = burndownSeries(await c.request('/rest/greenhopper/1.0/rapid/charts/scopechangeburndownchart', params), this._cfg.burndownUnit);
                } catch {
                    s.burndown = null;
                }
            } else {
                s.counts = null;
                s.burndown = null;
                s.kpis = null;
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
        if (!this._state.error)
            this._refreshDelivery();
    }

    // Métricas de entrega mudam devagar: no máximo a cada 6 h (GitHub + histórico do Jira dos últimos 30 dias).
    async _refreshDelivery() {
        const s = this._state;
        if (this._deliveryBusy || (s.deliveryAt && Date.now() - s.deliveryAt < DELIVERY_EVERY) || !this._cfg.githubLogin || !s.board)
            return;
        this._deliveryBusy = true;
        try {
            const c = this._client;
            const colMap = columnMap(s.board);
            const doneIds = [...colMap].filter(([, col]) => col === 'done').map(([id]) => id);
            const ids = [s.me, ...(this._cfg.team ?? [])].map(i => `"${i}"`).join(',');
            const cards = await this._pages(`project = ${this._cfg.project} AND assignee in (${ids}) AND status CHANGED TO (${doneIds.join(',')}) AFTER -${DELIVERY_DAYS}d`, 'assignee');
            const logs = {issueChangeLogs: []};
            for (let i = 0; i < cards.length; i += 1000) {
                let next = null;
                do {
                    const r = await c.post('/rest/api/3/changelog/bulkfetch', {issueIdsOrKeys: cards.slice(i, i + 1000).map(x => x.id), fieldIds: ['status'], maxResults: 1000, ...(next ? {nextPageToken: next} : {})});
                    logs.issueChangeLogs.push(...r.issueChangeLogs);
                    next = r.nextPageToken ?? null;
                } while (next);
            }
            const flow = flowEfficiency(cards, parseChangelogs(logs), colMap, s.me, this._cfg.team ?? []);
            const prDir = Main.extensionManager.lookup('pr-widget@pedrourio.github.io')?.path;
            const prs = await fetchDelivery(this._cfg, DELIVERY_DAYS, null, prDir);
            const reviewerName = readJson(GLib.build_filenamev([GLib.get_user_config_dir(), 'pr-widget', 'config.json']), {}).reviewerName ?? 'reviewer';
            s.delivery = {days: DELIVERY_DAYS, prs, flow, reviewerName};
            s.deliveryAt = Date.now();
            this._persist();
        } catch (e) {
            console.error(`jira-widget: métricas de entrega: ${e.message}`);
        } finally {
            this._deliveryBusy = false;
        }
        if (!this._destroyed)
            this._renderWhenClosed();
    }

    _updatePill() {
        const {sprint, counts, error} = this._state;
        this._sprintLabel.text = sprint?.number != null ? `S${sprint.number}` : sprint ? 'S' : '–';
        for (const c of COLUMNS) {
            this._lz[c].text = String(counts?.[c] ?? 0);
            this._lz[c].visible = Boolean(counts);
        }
        // ✦ só com pedido de card: erro > prévias prontas > gerando (pulsa)
        const err = this._drafts.some(d => d.status === 'error');
        const ready = this._drafts.filter(d => d.status === 'ready').length;
        const gen = this._drafts.some(d => d.status === 'gen');
        this._aiLabel.visible = this._drafts.length > 0;
        this._aiLabel.text = err ? '✦ !' : ready ? `✦ ${ready}` : '✦';
        this._aiLabel.style_class = err ? 'jw-ai jw-ai-error' : ready ? 'jw-ai jw-ai-ready' : 'jw-ai';
        this._aiLabel.remove_all_transitions();
        this._aiLabel.opacity = 255;
        if (gen && !err && !ready)
            this._aiLabel.ease({opacity: 90, duration: 800, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE, repeatCount: -1, autoReverse: true});
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
        const newCard = new St.Button({style_class: 'jw-new-card', can_focus: true, accessible_name: 'Novo card com o Claude'});
        const nc = new St.BoxLayout({style_class: 'jw-new-card-box'});
        nc.add_child(label('✦', 'jw-ai'));
        nc.add_child(label('Novo card'));
        newCard.set_child(nc);
        newCard.connect('clicked', () => this._openForm());
        header.add_child(newCard);
        header.add_child(gear);
        content.add_child(header);

        if (this._view === 'form') {
            this._renderForm(content);
            return;
        }
        if (this._view?.draft) {
            this._renderPreview(content, this._view.draft);
            return;
        }

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
        this._stripBox = new St.BoxLayout({vertical: true, style_class: 'jw-strips'});
        this._stripBox.connect('destroy', () => (this._stripBox = null));
        content.add_child(this._stripBox);
        this._renderStrips();

        this._burndownBox = new St.BoxLayout({vertical: true, style_class: 'jw-block'});
        const bdHead = new St.BoxLayout();
        bdHead.add_child(label('Gráfico de burndown', 'jw-block-title', {x_expand: true}));
        bdHead.add_child(label(this._state.burndown?.unit === 'points' ? 'Story Points' : 'Cards', 'jw-muted'));
        this._burndownBox.add_child(bdHead);
        this._chart = null;
        if (this._state.burndown) {
            this._chart = new Burndown();
            this._chart.setData(this._state.burndown);
            this._burndownBox.add_child(this._chart);
        } else {
            this._burndownBox.add_child(label(sprint ? 'Burndown indisponível' : 'Sem sprint ativa para o burndown', 'jw-muted'));
        }
        // entrega (30 dias) em cima, como principal; KPIs da sprint embaixo
        if (this._state.delivery?.prs?.me?.n)
            this._burndownBox.add_child(this._deliveryBlock(this._state.delivery));
        if (this._state.kpis?.me?.n)
            this._burndownBox.add_child(this._kpiBlock(this._state.kpis));
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

    // Peças de desenho comuns aos blocos de métricas (legenda, título, barra com traço do time, linha).
    _kit(box) {
        const pct = x => `${Math.round(x * 100)}%`;
        const hrs = x => `${x.toFixed(1).replace('.', ',')} h`;
        const legend = (me, team) => {
            const l = new St.BoxLayout({style_class: 'jw-legend'});
            for (const [cls, text] of [[me, 'Você'], [team, 'Média do time']]) {
                l.add_child(new St.Widget({style_class: cls, y_align: Clutter.ActorAlign.CENTER}));
                l.add_child(label(text, 'jw-legend-text'));
            }
            return l;
        };
        const head = (title, right) => {
            const h = new St.BoxLayout({style_class: 'jw-kpi-head'});
            h.add_child(label(title, 'jw-block-title', {x_expand: true}));
            if (right)
                h.add_child(label(right, 'jw-muted'));
            box.add_child(h);
        };
        // barra horizontal: largura proporcional dentro de um trilho fixo
        const TRACK = 300;
        const bar = (frac, cls, marker = null) => {
            const track = new St.Widget({style_class: 'jw-track', width: TRACK, layout_manager: new Clutter.FixedLayout(), y_align: Clutter.ActorAlign.CENTER});
            track.add_child(new St.Widget({style_class: cls, width: Math.max(2, Math.round(TRACK * Math.min(1, frac))), height: 10}));
            if (marker !== null) {
                const m = new St.Widget({style_class: 'jw-marker', width: 2, height: 18});
                m.set_position(Math.round(TRACK * Math.min(1, marker)) - 1, -4);
                track.add_child(m);
            }
            return track;
        };
        const row = (name, widget, value, nameCls = 'jw-kpi-name') => {
            const r = new St.BoxLayout({style_class: 'jw-kpi-row'});
            r.add_child(label(name, nameCls));
            r.add_child(widget);
            const v = label('', 'jw-kpi-value');
            v.clutter_text.set_markup(value);
            r.add_child(v);
            box.add_child(r);
        };
        return {pct, hrs, legend, head, bar, row, TRACK};
    }

    // Entrega dos últimos 30 dias: lead time até produção, revisão do reviewer de IA, eficiência do fluxo.
    _deliveryBlock(d) {
        const box = new St.BoxLayout({vertical: true, style_class: 'jw-kpis'});
        const {pct, legend, head, bar, row} = this._kit(box);
        const {me, team} = d.prs;
        const days = h => `${(h / 24).toFixed(1).replace('.', ',')} d`;
        const num = x => x.toFixed(1).replace('.', ',');
        // diferença colorida: verde quando você está melhor (higherBetter diz o sentido)
        const vs = (mine, theirs, fmt, higherBetter) => {
            if (theirs === null || theirs === undefined)
                return '';
            const better = higherBetter ? mine > theirs : mine < theirs;
            const same = Math.abs(mine - theirs) < 1e-9 || fmt(mine) === fmt(theirs);
            return ` <span foreground="${same ? '#8c9bab' : better ? '#7ee2b8' : '#fd9891'}">· time ${fmt(theirs)}</span>`;
        };
        head('Entrega', `últimos ${d.days} dias`);
        box.add_child(legend('jw-sw-me', 'jw-sw-mark'));
        if (me.leadHours !== null) {
            const top = Math.max(me.leadHours, team?.leadHours ?? 0) * 1.25;
            row('Lead time', bar(me.leadHours / top, 'jw-bar-me', team?.leadHours != null ? team.leadHours / top : null),
                `<b>${days(me.leadHours)}</b>${vs(me.leadHours, team?.leadHours, days, false)}`);
        }
        if (me.firstPass !== null) {
            row('PASS de 1ª', bar(me.firstPass, 'jw-bar-me', team?.firstPass ?? null), `<b>${pct(me.firstPass)}</b>${vs(me.firstPass, team?.firstPass, pct, true)}`);
            const top = Math.max(me.reviewsPerPr, team?.reviewsPerPr ?? 0) * 1.25;
            row('Revisões/PR', bar(me.reviewsPerPr / top, 'jw-bar-me', team?.reviewsPerPr != null ? team.reviewsPerPr / top : null),
                `<b>${num(me.reviewsPerPr)}</b>${team ? ` <span foreground="#8c9bab">· time ${num(team.reviewsPerPr)}</span>` : ''}`);
            row('Merge com PASS', bar(me.mergedPass, 'jw-bar-me', team?.mergedPass ?? null), `<b>${pct(me.mergedPass)}</b>${vs(me.mergedPass, team?.mergedPass, pct, true)}`);
        }
        const flow = d.flow;
        if (flow?.me?.ratio != null)
            row('Eficiência', bar(flow.me.ratio, 'jw-bar-me', flow.team?.ratio ?? null), `<b>${pct(flow.me.ratio)}</b>${vs(flow.me.ratio, flow.team?.ratio, pct, true)}`);
        // leitura que só os números juntos mostram: itera mais e mergeia mais com PASS
        if (team && me.reviewsPerPr > team.reviewsPerPr * 1.3 && me.mergedPass > team.mergedPass + 0.1)
            box.add_child(wrap(label(`Você itera mais com o ${d.reviewerName} (${num(me.reviewsPerPr)} revisões por PR) e mergeia com PASS mais vezes (${pct(me.mergedPass)} × ${pct(team.mergedPass)}).`, 'jw-callout-blue')));
        box.add_child(wrap(label(`Lead time: PR aberta até o deploy em produção · Eficiência: tempo em In Progress e Code Review sobre o total até Done · ${me.n} PRs, ${flow?.me?.n ?? 0} cards`, 'jw-muted')));
        return box;
    }

    // Você × média do time: estágios de entrega, horas por coluna, parados.
    _kpiBlock(k) {
        const box = new St.BoxLayout({vertical: true, style_class: 'jw-kpis'});
        const {pct, hrs, legend, head, bar, row, TRACK} = this._kit(box);

        head('Seu ritmo na sprint');
        box.add_child(legend('jw-sw-me', 'jw-sw-mark'));
        const {me, team} = k;
        for (const [key, name] of [['posdev', 'Pós-dev'], ['pronto', 'Pronto'], ['done', 'Done']]) {
            const mine = me[key] / me.n;
            let cmp = '';
            if (team) {
                const pp = Math.round((mine - team[key]) * 100);
                cmp = pp === 0 ? ' <span foreground="#8c9bab">= time</span>' : ` <span foreground="${pp > 0 ? '#7ee2b8' : '#fd9891'}">${pp > 0 ? '+' : ''}${pp} pp</span>`;
            }
            row(name, bar(mine, 'jw-bar-me', team ? team[key] : null), `<b>${me[key]}/${me.n} · ${pct(mine)}</b>${cmp}`);
        }
        box.add_child(wrap(label('Pós-dev = Ready to Test em diante · Pronto = Ready to Deploy em diante', 'jw-muted')));

        if (team) {
            head('Onde seus cards param', 'horas por card nesta sprint');
            box.add_child(legend('jw-sw-me', 'jw-sw-team'));
            const names = {progress: 'In Progress', review: 'Code Review', ready: 'Ready to Test', testing: 'Testing', deploy: 'Ready to Deploy'};
            const top = Math.max(1, ...Object.keys(names).flatMap(c => [me.hours[c], team.hours[c]]));
            for (const [col, name] of Object.entries(names)) {
                const hot = k.worst?.col === col;
                // posições fixas: em caixa vertical as barras esticariam até a largura toda
                const holder = new St.Widget({width: TRACK, height: 14, layout_manager: new Clutter.FixedLayout(), y_align: Clutter.ActorAlign.CENTER});
                const mineBar = new St.Widget({style_class: hot ? 'jw-bar-hot' : 'jw-bar-me', width: Math.max(2, Math.round(TRACK * me.hours[col] / top)), height: 6});
                const teamBar = new St.Widget({style_class: 'jw-bar-team', width: Math.max(2, Math.round(TRACK * team.hours[col] / top)), height: 6});
                teamBar.set_position(0, 8);
                holder.add_child(mineBar);
                holder.add_child(teamBar);
                row(name, holder, `${hot ? '<b>' : ''}${hrs(me.hours[col])}${hot ? '</b>' : ''} <span foreground="#8c9bab">· time ${hrs(team.hours[col]).replace(' h', '')}</span>`,
                    hot ? 'jw-kpi-name jw-hot' : 'jw-kpi-name');
            }
            if (k.worst)
                box.add_child(wrap(label(k.worst.ratio ? `Seus cards ficam ${k.worst.ratio.toFixed(1).replace('.', ',')}× mais tempo em ${names[k.worst.col]} que os do time.`
                    : `Seus cards passam ${hrs(k.worst.diff)} a mais em ${names[k.worst.col]} que os do time.`, 'jw-callout')));
        }

        const stale = new St.BoxLayout({style_class: 'jw-kpi-head'});
        stale.add_child(label('Parados há mais de 2 dias', 'jw-block-title', {x_expand: true}));
        const n = label('', 'jw-kpi-value');
        n.clutter_text.set_markup(`<b>${me.stale.length}</b>${k.teamStale !== null ? ` <span foreground="#8c9bab">· time ${k.teamStale.toFixed(1).replace('.', ',')}</span>` : ''}`);
        stale.add_child(n);
        box.add_child(stale);
        if (me.stale.length) {
            const keys = new St.BoxLayout({style_class: 'jw-stale-keys'});
            for (const key of me.stale.slice(0, 5))
                keys.add_child(button(key, 'jw-link jw-key-link', () => (this._search.text = key)));
            if (me.stale.length > 5)
                keys.add_child(label(`+${me.stale.length - 5}`, 'jw-muted'));
            box.add_child(keys);
        }
        return box;
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

    // Listas que o Claude pode escolher; tudo menos os parecidos fica 1 h em memória.
    async _cardContext(text) {
        if (!await this._getClient())
            throw new Error('sem token do Jira');
        const c = this._client;
        const cfg = this._cfg;
        if (!this._ctxCache || Date.now() - this._ctxCache.at > 3600e3) {
            const me = this._state.me ?? (await c.request('/rest/api/3/myself')).accountId;
            const ids = [me, ...(cfg.team ?? [])].map(i => `accountId=${encodeURIComponent(i)}`).join('&');
            const [sprints, epics, users, meta, priorities] = await Promise.all([
                c.request(`/rest/agile/1.0/board/${cfg.boardId}/sprint`, {state: 'active,future'}),
                this._pages(`project = ${cfg.project} AND issuetype = Epic AND statusCategory != Done ORDER BY updated DESC`, 'summary'),
                c.request(`/rest/api/3/user/bulk?${ids}`),
                c.request(`/rest/api/3/issue/createmeta/${cfg.project}/issuetypes`),
                c.request('/rest/api/3/priority'),
            ]);
            this._ctxCache = {at: Date.now(), ctx: {
                types: (meta.issueTypes ?? meta.values ?? []).filter(t => !t.subtask).map(t => t.name),
                priorities: priorities.map(p => p.name),
                sprints: sprints.values.map(sp => ({id: sp.id, name: sp.name, state: sp.state})),
                epics: epics.map(e => ({key: e.key, summary: e.fields.summary})),
                people: users.values.map(u => ({id: u.accountId, name: u.displayName})),
            }};
        }
        const jql = similarJql(text, cfg.project);
        const similar = jql ? (await c.request('/rest/api/3/search/jql', {jql, maxResults: 5,
            fields: ['summary', 'issuetype', 'parent', cfg.pointsField].filter(Boolean).join(',')})).issues : [];
        return {...this._ctxCache.ctx, similar: similar.map(i => ({key: i.key, summary: i.fields.summary, type: i.fields.issuetype?.name,
            epic: i.fields.parent?.key ?? null, points: cfg.pointsField ? i.fields[cfg.pointsField] ?? null : null}))};
    }

    _guide() {
        if (!this._cfg.cardGuide)
            return '';
        try {
            return new TextDecoder().decode(GLib.file_get_contents(this._cfg.cardGuide)[1]);
        } catch {
            return '';
        }
    }

    _startDraft(text, fixed, image) {
        const d = {id: GLib.uuid_string_random(), text, fixed, image, edited: {}, status: 'gen', startedAt: Date.now(), sessionId: null, preview: null, error: null, ctx: null};
        this._drafts.push(d);
        this._runDraft(d, async () => {
            d.ctx = await this._cardContext(text);
            return runClaude({prompt: cardPrompt({text, fixed, ctx: d.ctx, guide: this._guide(), image}), schema: previewSchema(d.ctx),
                cwd: this._cfg.codeDir, cancellable: d.cancel});
        });
    }

    // Retoma a mesma conversa; o que você fixou ou editou volta como fixado e a mescla garante.
    _adjustDraft(d, message) {
        const fixed = {...d.fixed, ...d.edited};
        this._runDraft(d, () => runClaude({prompt: `Ajuste pedido: ${message}\nCampos fixados (não mude, devolva o mesmo valor): ${JSON.stringify(fixed)}`,
            schema: previewSchema(d.ctx), cwd: this._cfg.codeDir, resume: d.sessionId, cancellable: d.cancel}));
    }

    async _runDraft(d, run) {
        d.cancel = new Gio.Cancellable();
        d.status = 'gen';
        d.startedAt = Date.now();
        d.error = null;
        this._draftsChanged(d);
        try {
            const {sessionId, output} = await run();
            if (this._destroyed || !this._drafts.includes(d))
                return;
            d.sessionId = sessionId;
            d.preview = mergePreview(output, {...d.fixed, ...d.edited}, d.ctx);
            d.status = 'ready';
            d.readyAt = Date.now();
            Main.notify('Prévia do card pronta', d.preview.values.summary);
        } catch (e) {
            if (this._destroyed || !this._drafts.includes(d))
                return;
            // ajuste que falhou ou foi cancelado volta para a prévia anterior
            if (d.preview) {
                d.status = 'ready';
                d.error = d.cancel.is_cancelled() ? null : e.message;
            } else if (d.cancel.is_cancelled()) {
                this._dropDraft(d);
                return;
            } else {
                d.status = 'error';
                d.error = e.message;
            }
        }
        if (!this._destroyed)
            this._draftsChanged(d);
    }

    _showView(view) {
        this._view = view;
        this._render();
        if (view === 'sprint')
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (this._search?.get_stage())
                    this._search.grab_key_focus();
                return GLib.SOURCE_REMOVE;
            });
    }

    _openForm() {
        this._form ??= {text: '', fixed: {}, image: null};
        this._showView('form');
        // contexto já em cache deixa os seletores de "Eu defino" prontos
        if (!this._ctxCache)
            this._cardContext('').then(() => {
                if (this._view === 'form' && this.menu.isOpen)
                    this._render();
            }).catch(e => console.error(`jira-widget: contexto do card: ${e.message}`));
    }

    // Botão que mostra o valor atual; clique abre a lista logo abaixo.
    _choice(options, current, onPick) {
        const box = new St.BoxLayout({vertical: true, x_expand: true});
        const cur = options.find(([v]) => v === current)?.[1] ?? 'Escolher';
        const scroll = new St.ScrollView({style_class: 'jw-pick-scroll', hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC, visible: false});
        box.add_child(button(`${cur} ▾`, 'jw-pick', () => (scroll.visible = !scroll.visible), {x_align: Clutter.ActorAlign.START}));
        const list = new St.BoxLayout({vertical: true, style_class: 'jw-pick-list'});
        for (const [v, text] of options)
            list.add_child(button(text, `jw-pick-item${v === current ? ' jw-pick-on' : ''}`, () => onPick(v), {x_align: Clutter.ActorAlign.FILL}));
        scroll.set_child(list);
        box.add_child(scroll);
        return box;
    }

    _multiline(text, hint, onChange) {
        const e = new St.Entry({text, hint_text: hint, can_focus: true, x_expand: true, style_class: 'jw-input'});
        e.clutter_text.single_line_mode = false;
        e.clutter_text.activatable = false;
        wrap({clutter_text: e.clutter_text});
        e.clutter_text.connect('text-changed', () => onChange(e.text));
        return e;
    }

    _segmented(ai, text, onSet) {
        const seg = new St.BoxLayout({style_class: 'jw-seg'});
        seg.add_child(button(text[0], `jw-seg-btn${ai ? ' jw-seg-ai' : ''}`, () => onSet(true)));
        seg.add_child(button(text[1], `jw-seg-btn${ai ? '' : ' jw-seg-on'}`, () => onSet(false)));
        return seg;
    }

    _renderForm(content) {
        const f = this._form;
        const head = new St.BoxLayout({style_class: 'jw-header'});
        head.add_child(label('Novo card', 'jw-title'));
        head.add_child(label(this._cfg.project || '', 'jw-tag jw-tag-blue'));
        head.add_child(label('Esc volta', 'jw-muted', {x_expand: true, x_align: Clutter.ActorAlign.END}));
        content.add_child(head);

        const entry = this._multiline(f.text, 'O que precisa ser feito?', t => {
            f.text = t;
            go.reactive = Boolean(t.trim());
        });
        entry.add_style_class_name('jw-input-focus');
        // Ctrl+V com imagem na área de transferência guarda o print para o Claude ler
        entry.clutter_text.connect('key-press-event', (_a, ev) => {
            if (ev.get_key_symbol() === Clutter.KEY_v && (ev.get_state() & Clutter.ModifierType.CONTROL_MASK))
                St.Clipboard.get_default().get_content(St.ClipboardType.CLIPBOARD, 'image/png', (_c, bytes) => {
                    if (!bytes?.get_size() || this._destroyed)
                        return;
                    const path = GLib.build_filenamev([GLib.get_user_cache_dir(), 'jira-widget', `print-${GLib.uuid_string_random()}.png`]);
                    GLib.file_set_contents(path, bytes.get_data());
                    if (f.image)
                        GLib.unlink(f.image);
                    f.image = path;
                    if (this._view === 'form')
                        this._render();
                });
            return Clutter.EVENT_PROPAGATE;
        });
        content.add_child(entry);
        const hint = new St.BoxLayout({style_class: 'jw-header'});
        hint.add_child(label('Uma ou duas frases bastam. Pode colar link de PR, print ou trecho de log.', 'jw-muted', {x_expand: true}));
        if (f.image)
            hint.add_child(button('print anexado ✕', 'jw-link', () => {
                GLib.unlink(f.image);
                f.image = null;
                this._render();
            }));
        content.add_child(hint);

        const ctx = this._ctxCache?.ctx;
        const rows = new St.BoxLayout({vertical: true, style_class: 'jw-block jw-form-rows'});
        for (const k of CARD_FIELDS) {
            const row = new St.BoxLayout({style_class: 'jw-form-row'});
            row.add_child(label(FIELD_NAMES[k], 'jw-form-key'));
            const text = TEXT_FIELDS.includes(k);
            const ai = !(k in f.fixed);
            const right = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'jw-form-val'});
            right.add_child(this._segmented(ai, text ? ['✦ Claude escreve', 'Eu escrevo'] : ['✦ Claude decide', 'Eu defino'], toAi => {
                if (toAi)
                    delete f.fixed[k];
                else if (!(k in f.fixed))
                    f.fixed[k] = text ? (k === 'criteria' ? [] : '') : fieldOptions(k, ctx ?? {types: [], sprints: [], epics: [], people: [], priorities: []})[0]?.[0] ?? '';
                this._render();
            }));
            if (!ai && text)
                right.add_child(this._multiline(k === 'criteria' ? f.fixed[k].join('\n') : f.fixed[k], k === 'criteria' ? 'Um critério por linha' : 'Descrição',
                    t => (f.fixed[k] = k === 'criteria' ? t.split('\n').map(x => x.trim()).filter(Boolean) : t)));
            else if (!ai)
                right.add_child(ctx ? this._choice(fieldOptions(k, ctx), f.fixed[k], v => {
                    f.fixed[k] = v;
                    this._render();
                }) : label('Carregando opções do Jira…', 'jw-muted'));
            row.add_child(right);
            rows.add_child(row);
        }
        content.add_child(rows);

        const foot = new St.BoxLayout({style_class: 'jw-header'});
        foot.add_child(wrap(label('O Claude consulta o Jira e o código. Nada vai para o Jira sem sua aprovação.', 'jw-muted', {x_expand: true})));
        const go = button('Gerar prévia', 'jw-primary', () => {
            if (!f.text.trim())
                return;
            this._startDraft(f.text.trim(), f.fixed, f.image);
            this._form = null;
            this._showView('sprint');
        });
        go.reactive = Boolean(f.text.trim());
        foot.add_child(go);
        content.add_child(foot);
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (entry.get_stage()) {
                entry.grab_key_focus();
                entry.clutter_text.set_cursor_position(-1);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // Uma faixa por pedido, o mais antigo em cima.
    _renderStrips() {
        if (!this._stripBox)
            return;
        this._stripBox.destroy_all_children();
        this._stripBox.visible = this._drafts.length > 0;
        for (const d of this._drafts) {
            const strip = new St.BoxLayout({style_class: `jw-strip jw-strip-${d.status}`});
            strip.add_child(label(d.status === 'error' ? '✦ !' : '✦', d.status === 'error' ? 'jw-ai jw-ai-error' : 'jw-ai'));
            const title = d.preview?.values.summary ?? d.text;
            const what = {gen: d.preview ? 'Ajustando' : 'Gerando', ready: 'Prévia pronta', error: 'Falhou'}[d.status];
            const l = label(`${what} · ${d.status === 'error' ? d.error : title}`, 'jw-strip-text', {x_expand: true});
            l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            strip.add_child(l);
            if (d.status === 'gen') {
                d._clock = label(`${Math.round((Date.now() - d.startedAt) / 1000)} s`, 'jw-muted');
                strip.add_child(d._clock);
                strip.add_child(button('cancelar', 'jw-link', () => this._cancelDraft(d)));
            } else if (d.status === 'ready') {
                strip.add_child(label(`há ${Math.max(1, Math.round((Date.now() - d.readyAt) / 60e3))} min`, 'jw-muted'));
                strip.add_child(button('Revisar', 'jw-primary', () => this._showView({draft: d})));
            } else {
                strip.add_child(button('Descartar', 'jw-link', () => this._dropDraft(d)));
            }
            this._stripBox.add_child(strip);
        }
    }

    // Relógio das faixas: só anda com o menu aberto e algo gerando.
    _tickStrips() {
        if (this._stripTimer || !this.menu.isOpen || !this._drafts.some(d => d.status === 'gen'))
            return;
        this._stripTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            const gen = this._drafts.filter(d => d.status === 'gen');
            for (const d of gen)
                if (d._clock?.get_stage())
                    d._clock.text = `${Math.round((Date.now() - d.startedAt) / 1000)} s`;
            if (this.menu.isOpen && gen.length)
                return GLib.SOURCE_CONTINUE;
            this._stripTimer = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    // Só refaz a prévia em tela se foi ela que mudou (refazer tira o foco de quem está digitando).
    _refreshDraftViews(changed) {
        if (this._view === 'sprint')
            this._renderStrips();
        else if (this._view?.draft && this._view.draft === changed)
            this._render();
        this._tickStrips();
    }

    // Prévia editável: editar um campo tira o ✦ e o fixa para os próximos ajustes; nada chama o Claude sozinho.
    _renderPreview(content, d) {
        const p = d.preview;
        const v = p.values;
        const edit = (k, val) => {
            v[k] = val;
            p.ai.delete(k);
            d.edited[k] = val;
        };
        const head = new St.BoxLayout({style_class: 'jw-header'});
        head.add_child(label('AGUARDANDO APROVAÇÃO', 'jw-tag jw-tag-wait'));
        head.add_child(label(p.score ? `nota ${p.score.value}/${p.score.max} na régua de card` : '', 'jw-muted', {x_expand: true, x_align: Clutter.ActorAlign.END}));
        content.add_child(head);
        if (d.status === 'gen' || d.error) {
            const box = new St.BoxLayout({style_class: 'jw-notice'});
            box.add_child(wrap(label(d.status === 'gen' ? 'Ajustando com o Claude…' : d.error, 'jw-notice-text', {x_expand: true})));
            if (d.status === 'gen')
                box.add_child(button('cancelar', 'jw-link', () => this._cancelDraft(d)));
            content.add_child(box);
        }

        const title = new St.Entry({text: v.summary, can_focus: true, x_expand: true, style_class: 'jw-input jw-preview-title'});
        title.clutter_text.connect('text-changed', () => edit('summary', title.text));
        content.add_child(title);

        const grid = new St.BoxLayout({vertical: true, style_class: 'jw-block jw-form-rows'});
        for (const k of ['type', 'sprint', 'epic', 'assignee', 'points', 'priority']) {
            const row = new St.BoxLayout({style_class: 'jw-form-row'});
            const key = new St.BoxLayout({style_class: 'jw-form-key'});
            if (p.ai.has(k))
                key.add_child(label('✦ ', 'jw-ai'));
            key.add_child(label(FIELD_NAMES[k]));
            row.add_child(key);
            row.add_child(this._choice(fieldOptions(k, d.ctx), v[k], val => {
                edit(k, val);
                this._render();
            }));
            grid.add_child(row);
        }
        content.add_child(grid);

        const desc = new St.BoxLayout({vertical: true, style_class: 'jw-block'});
        desc.add_child(label(`${p.ai.has('description') ? '✦ ' : ''}Descrição`, 'jw-block-title'));
        desc.add_child(this._multiline(v.description, 'Descrição', t => edit('description', t)));
        desc.add_child(label(`${p.ai.has('criteria') ? '✦ ' : ''}Critérios de aceite (um por linha)`, 'jw-block-title'));
        desc.add_child(this._multiline(v.criteria.join('\n'), 'Um critério por linha', t => edit('criteria', t.split('\n').map(x => x.trim()).filter(Boolean))));
        content.add_child(desc);

        const reasons = [...p.ai].filter(k => p.why[k]);
        if (reasons.length) {
            const why = new St.BoxLayout({vertical: true, style_class: 'jw-block'});
            why.add_child(label('Por que o Claude escolheu', 'jw-block-title'));
            for (const k of reasons)
                why.add_child(wrap(label(`${FIELD_NAMES[k]}: ${p.why[k]}`, 'jw-muted')));
            content.add_child(why);
        }

        const adjust = new St.BoxLayout({style_class: 'jw-header'});
        const ask = new St.Entry({text: d.askText ?? '', hint_text: 'Pedir ajuste ao Claude… ex.: “é história, não bug”', can_focus: true, x_expand: true, style_class: 'jw-input'});
        ask.clutter_text.connect('text-changed', () => (d.askText = ask.text));
        const send = () => {
            if (ask.text.trim() && d.status !== 'gen') {
                d.askText = '';
                this._adjustDraft(d, ask.text.trim());
            }
        };
        ask.clutter_text.connect('activate', send);
        adjust.add_child(ask);
        adjust.add_child(button('Enviar', 'jw-primary', send));
        content.add_child(adjust);

        const foot = new St.BoxLayout({style_class: 'jw-header'});
        foot.add_child(button('Descartar', 'jw-link jw-danger', () => {
            this._dropDraft(d);
            this._showView('sprint');
        }, {x_expand: true, x_align: Clutter.ActorAlign.START}));
        const pub = button(d.publishing ? 'Publicando…' : 'Publicar no Jira', 'jw-primary', () => this._publish(d));
        pub.reactive = !d.publishing && d.status !== 'gen' && Boolean(v.summary.trim() && v.type);
        foot.add_child(pub);
        content.add_child(foot);
    }

    // Cria o card e, se houver, põe na sprint; falhar mantém a prévia. publishing impede card duplicado.
    async _publish(d) {
        if (d.publishing)
            return;
        d.publishing = true;
        d.error = null;
        this._render();
        const v = d.preview.values;
        let key;
        try {
            if (!await this._getClient())
                throw new Error('Sem token do Jira.');
            key = (await this._client.post('/rest/api/3/issue', issueBody(v, this._cfg))).key;
        } catch (e) {
            d.publishing = false;
            d.error = `Não publicou: ${e.message}`;
            if (!this._destroyed && this._view?.draft === d)
                this._render();
            return;
        }
        // card já existe: daqui em diante nada pode voltar para "Não publicou" (outro clique duplicaria)
        try {
            let warn = '';
            if (/^\d+$/.test(v.sprint)) {
                try {
                    await this._client.post(`/rest/agile/1.0/sprint/${v.sprint}/issue`, {issues: [key]});
                } catch {
                    warn = ', mas não entrou na sprint';
                }
            }
            const source = MessageTray.getSystemSource();
            const n = new MessageTray.Notification({source, title: `Card ${key} criado${warn}`, body: v.summary});
            n.addAction('Abrir no Jira', () => this._launch(this._browse(key)));
            source.addNotification(n);
        } catch (e) {
            console.error(`jira-widget: card ${key} criado, aviso falhou: ${e.message}`);
        }
        this._dropDraft(d);
        if (this._view?.draft === d)
            this._showView('sprint');
    }

    _cancelDraft(d) {
        d.cancel?.cancel();
    }

    _dropDraft(d) {
        d.cancel?.cancel();
        this._drafts = this._drafts.filter(x => x !== d);
        if (d.image)
            GLib.unlink(d.image);
        this._draftsChanged();
    }

    // Menu aberto: só as faixas e a prévia em tela mudam (refazer tudo apagaria a busca digitada).
    _draftsChanged(d = null) {
        this._updatePill();
        if (!this.menu.isOpen)
            this._render();
        else
            this._refreshDraftViews(d);
    }

    destroy() {
        this._destroyed = true;
        // prints colados podem ter dado sensível: não ficam no cache
        for (const d of this._drafts) {
            d.cancel?.cancel();
            if (d.image)
                GLib.unlink(d.image);
        }
        if (this._form?.image)
            GLib.unlink(this._form.image);
        if (this._stripTimer)
            GLib.source_remove(this._stripTimer);
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
