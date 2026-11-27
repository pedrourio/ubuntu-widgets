import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Cairo from 'cairo';
import UPowerGlib from 'gi://UPowerGlib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {MODES} from './qcy.js';
import {QcyLink} from './ble.js';
import {COLS, STYLES, HOLD, MORPH, levels, Smoother, segments, morph, blend} from './wave.js';

const BAR_WIDTH = 28;
const AUDIO_KINDS = [UPowerGlib.DeviceKind.HEADSET, UPowerGlib.DeviceKind.HEADPHONES];
const WAVE_W = 280, WAVE_H = 56;
const FFT_N = 1024;
const SILENT = 0.03;
const PENDING_MS = 2000;

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);

// Nome do tipo derivado do caminho do arquivo: o ext-reload carrega cópias em caminhos novos
// e o GObject não aceita registrar o mesmo nome duas vezes.
const Indicator = GObject.registerClass({GTypeName: `BtIndicator_${GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, import.meta.url, -1)}`},
class Indicator extends PanelMenu.Button {
    _init(dir) {
        super._init(0.5, 'Bluetooth Headset Battery', false);
        this._dir = dir;
        this._earbuds = Gio.icon_new_for_string(`${dir}/earbuds-symbolic.svg`);
        this._mode = null;
        this._samples = new Int16Array(FFT_N);
        this._lv = new Float32Array(COLS);
        this._smoother = new Smoother();

        const box = new St.BoxLayout({style_class: 'bthb-box'});
        this._icon = new St.Icon({style_class: 'system-status-icon'});
        this._bar = new St.Widget({style_class: 'bthb-bar', width: BAR_WIDTH, y_align: Clutter.ActorAlign.CENTER});
        this._fill = new St.Widget({style_class: 'bthb-fill'});
        this._bar.add_child(this._fill);
        this._label = new St.Label({style_class: 'bthb-label', y_align: Clutter.ActorAlign.CENTER});
        this._badge = new St.Label({style_class: 'bthb-badge', y_align: Clutter.ActorAlign.CENTER, visible: false});
        box.add_child(this._icon);
        box.add_child(this._bar);
        box.add_child(this._label);
        box.add_child(this._badge);
        this.add_child(box);
        this._buildMenu();

        this.menu.connect('open-state-changed', (_m, open) => (open ? this._start() : this._stop()));

        this._client = UPowerGlib.Client.new_full(null);
        this._client.connectObject(
            'device-added', () => this._sync(),
            'device-removed', () => this._sync(),
            this);
        this._sync();
    }

    _buildMenu() {
        this.menu.box.add_style_class_name('bthb-menu');
        const head = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const col = new St.BoxLayout({vertical: true, style_class: 'bthb-head', x_expand: true});
        this._name = new St.Label({style_class: 'bthb-name'});
        const batt = new St.BoxLayout({style_class: 'bthb-box'});
        this._mbar = new St.Widget({style_class: 'bthb-bar', width: 120, y_align: Clutter.ActorAlign.CENTER});
        this._mfill = new St.Widget({style_class: 'bthb-fill'});
        this._mbar.add_child(this._mfill);
        this._mlabel = new St.Label({style_class: 'bthb-label', y_align: Clutter.ActorAlign.CENTER});
        batt.add_child(this._mbar);
        batt.add_child(this._mlabel);
        col.add_child(this._name);
        col.add_child(batt);
        head.add_child(col);
        this.menu.addMenuItem(head);

        const waveItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._wave = new St.DrawingArea({width: WAVE_W, height: WAVE_H, style_class: 'bthb-wave'});
        this._wave.connect('repaint', area => this._paint(area));
        waveItem.add_child(this._wave);
        this.menu.addMenuItem(waveItem);

        this._modeSection = new PopupMenu.PopupMenuSection();
        this._modeSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const title = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        title.add_child(new St.Label({text: 'MODO DE ÁUDIO', style_class: 'bthb-section'}));
        this._modeSection.addMenuItem(title);
        this._status = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._statusLabel = new St.Label({style_class: 'bthb-status'});
        this._status.add_child(this._statusLabel);
        this._modeSection.addMenuItem(this._status);
        this._modeItems = MODES.map(m => {
            const item = new PopupMenu.PopupBaseMenuItem({style_class: 'bthb-mode'});
            item.add_child(new St.Icon({gicon: Gio.icon_new_for_string(`${this._dir}/${m.icon}-symbolic.svg`), style_class: 'popup-menu-icon'}));
            item.add_child(new St.Label({text: m.name, y_align: Clutter.ActorAlign.CENTER}));
            item.connect('activate', () => {
                this._pick(m.id);
                return Clutter.EVENT_STOP;
            });
            // trocar não fecha o menu: dá para ouvir e trocar de novo
            item.activate = () => this._pick(m.id);
            this._modeSection.addMenuItem(item);
            return {m, item};
        });
        this.menu.addMenuItem(this._modeSection);
        this._paintModes();
    }

    _sync() {
        this._device?.disconnectObject(this);
        this._device = this._client.get_devices().find(d => AUDIO_KINDS.includes(d.kind));
        this.visible = !!this._device;
        if (!this._device) {
            this.menu.close();
            return;
        }
        this._device.connectObject('notify::percentage', () => this._update(), this);
        this._update();
    }

    _isQcy() {
        return /QCY/i.test(this._device?.model ?? '');
    }

    _update() {
        const {model, percentage} = this._device;
        if (this._isQcy())
            this._icon.gicon = this._earbuds;
        else
            this._icon.icon_name = /JBL/i.test(model) ? 'audio-headset-symbolic' : 'audio-headphones-symbolic';

        const pct = Math.round(percentage);
        const cls = `bthb-fill${pct <= 20 ? ' low' : pct <= 50 ? ' mid' : ''}`;
        this._fill.width = Math.round(BAR_WIDTH * pct / 100);
        this._fill.style_class = cls;
        this._label.text = `${pct}%`;
        this._name.text = model;
        this._mfill.width = Math.round(120 * pct / 100);
        this._mfill.style_class = cls;
        this._mlabel.text = `${pct}%`;
        this._modeSection.actor.visible = this._isQcy();
    }

    // Cor e negrito só no modo selecionado; os outros ficam cinza. Etiqueta na barra fora do Normal.
    _paintModes() {
        for (const {m, item} of this._modeItems) {
            item.remove_style_class_name(`bthb-on-${m.id}`);
            item.remove_style_class_name('bthb-pending');
            if (m.id === this._mode)
                item.add_style_class_name(`bthb-on-${m.id}`);
            if (m.id === this._pending)
                item.add_style_class_name(`bthb-on-${m.id}`), item.add_style_class_name('bthb-pending');
        }
        const mode = MODES.find(m => m.id === this._mode);
        this._badge.visible = !!mode?.badge;
        this._badge.text = mode?.badge ?? '';
        this._badge.style_class = `bthb-badge bthb-badge-${mode?.id ?? 'normal'}`;
    }

    _setStatus(text) {
        this._statusLabel.text = text ?? '';
        this._status.visible = !!text;
    }

    async _pick(id) {
        if (!this._link || id === this._mode)
            return;
        this._pending = id;
        this._setStatus(null);
        this._paintModes();
        const ok = await this._link.setMode(id);
        if (this._pendingTimer)
            GLib.source_remove(this._pendingTimer);
        // o fone confirma pelo aviso; sem ele, volta ao anterior
        this._pendingTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ok ? PENDING_MS : 0, () => {
            this._pendingTimer = 0;
            if (this._pending === id) {
                this._pending = null;
                this._setStatus('Não deu para trocar');
                this._paintModes();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _onMode(id) {
        this._mode = id;
        if (this._pending === id)
            this._pending = null;
        this._setStatus(null);
        this._paintModes();
    }

    // ── painel aberto: BLE, captura do som e animação; fechado: nada roda ──
    _start() {
        // cada abertura começa num estilo sorteado, já parado nele (início do tempo de espera)
        this._t0 = GLib.get_monotonic_time() - Math.floor(Math.random() * STYLES.length) * (HOLD + MORPH) * 1e6;
        this._startAudio();
        this._tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
            this._wave.queue_repaint();
            return GLib.SOURCE_CONTINUE;
        });
        if (this._isQcy() && this._device.serial) {
            this._setStatus(this._mode ? null : 'Conectando ao fone…');
            for (const {item} of this._modeItems)
                item.reactive = false;
            const link = this._link = new QcyLink(id => this._onMode(id));
            link.open(this._device.serial).then(ok => {
                if (link !== this._link)
                    return;
                if (!ok) {
                    this._setStatus('Não deu para conectar ao fone');
                    return;
                }
                this._setStatus(null);
                for (const {item} of this._modeItems)
                    item.reactive = true;
            });
        }
    }

    _stop() {
        if (this._tick)
            GLib.source_remove(this._tick);
        this._tick = 0;
        if (this._pendingTimer)
            GLib.source_remove(this._pendingTimer);
        this._pendingTimer = 0;
        this._pending = null;
        this._link?.close();
        this._link = null;
        this._audioCancel?.cancel();
        this._audioCancel = null;
        this._audio?.force_exit();
        this._audio = null;
        this._samples.fill(0);
        this._smoother = new Smoother();
        this._paintModes();
    }

    // Monitor da saída padrão do PipeWire (o que vai para o fone), nunca o microfone.
    _startAudio() {
        const bin = GLib.find_program_in_path('pw-record');
        if (!bin)
            return;
        try {
            this._audio = Gio.Subprocess.new([bin, '-P', '{ stream.capture.sink=true }', '--rate', '16000', '--channels', '1', '--format', 's16', '-'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.warn(`bt-headset-battery: pw-record: ${e.message}`);
            return;
        }
        const stream = this._audio.get_stdout_pipe();
        const cancel = this._audioCancel = new Gio.Cancellable();
        let odd = null;
        const read = () => stream.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, cancel, (s, res) => {
            let bytes;
            try {
                bytes = s.read_bytes_finish(res).toArray();
            } catch {
                return;
            }
            if (!bytes.length || cancel.is_cancelled())
                return;
            if (odd !== null)
                bytes = Uint8Array.from([odd, ...bytes]);
            odd = bytes.length % 2 ? bytes[bytes.length - 1] : null;
            const fresh = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1);
            // guarda só as últimas 1024 amostras
            if (fresh.length >= FFT_N) {
                this._samples.set(fresh.subarray(fresh.length - FFT_N));
            } else {
                this._samples.copyWithin(0, fresh.length);
                this._samples.set(fresh, FFT_N - fresh.length);
            }
            read();
        });
        read();
    }

    _paint(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const sx = w / WAVE_W, sy = h / WAVE_H;
        cr.scale(sx, sy);
        levels(this._samples, this._lv);
        const lv = this._smoother.step(this._lv);
        let vol = 0;
        for (const v of lv)
            vol += v;
        vol /= COLS;
        const color = vol < SILENT ? [1, 1, 1] : rgb((MODES.find(m => m.id === this._mode) ?? MODES[0]).color);
        const alpha = vol < SILENT ? 0.3 : 1;
        const t = (GLib.get_monotonic_time() - (this._t0 ?? 0)) / 1e6;
        cr.setLineCap(Cairo.LineCap.ROUND);
        for (let i = 0; i < COLS; i++) {
            const {a, b, m} = morph(t, i, WAVE_W);
            const segs = m > 0 ? blend(segments(a, i, lv, t, WAVE_W, WAVE_H), segments(b, i, lv, t, WAVE_W, WAVE_H), m)
                : segments(a, i, lv, t, WAVE_W, WAVE_H);
            for (const [x1, y1, x2, y2, width, op] of segs) {
                if (op <= 0.01)
                    continue;
                cr.setSourceRGBA(...color, op * alpha);
                cr.setLineWidth(width);
                cr.moveTo(x1, y1);
                cr.lineTo(x2, y2);
                cr.stroke();
            }
        }
        cr.$dispose();
    }

    destroy() {
        this._stop();
        this._device?.disconnectObject(this);
        this._client.disconnectObject(this);
        this._client = null;
        super.destroy();
    }
});

export default class BtHeadsetBatteryExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this.path);
        // logo depois do widget do Spotify (Now Playing fica no índice 1)
        Main.panel.addToStatusArea(this.uuid, this._indicator, 2, 'left');
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}
