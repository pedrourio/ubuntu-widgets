import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import UPowerGlib from 'gi://UPowerGlib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BAR_WIDTH = 28;
const AUDIO_KINDS = [UPowerGlib.DeviceKind.HEADSET, UPowerGlib.DeviceKind.HEADPHONES];

// Nome do tipo derivado do caminho do arquivo: o ext-reload carrega cópias em caminhos novos
// e o GObject não aceita registrar o mesmo nome duas vezes.
const Indicator = GObject.registerClass({GTypeName: `BtIndicator_${GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, import.meta.url, -1)}`},
class Indicator extends PanelMenu.Button {
    _init(dir) {
        super._init(0.5, 'Bluetooth Headset Battery', true);
        this._earbuds = Gio.icon_new_for_string(`${dir}/earbuds-symbolic.svg`);

        const box = new St.BoxLayout({style_class: 'bthb-box'});
        this._icon = new St.Icon({style_class: 'system-status-icon'});
        this._bar = new St.Widget({style_class: 'bthb-bar', width: BAR_WIDTH, y_align: Clutter.ActorAlign.CENTER});
        this._fill = new St.Widget({style_class: 'bthb-fill'});
        this._bar.add_child(this._fill);
        this._label = new St.Label({style_class: 'bthb-label', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._icon);
        box.add_child(this._bar);
        box.add_child(this._label);
        this.add_child(box);

        this._client = UPowerGlib.Client.new_full(null);
        this._client.connectObject(
            'device-added', () => this._sync(),
            'device-removed', () => this._sync(),
            this);
        this._sync();
    }

    _sync() {
        this._device?.disconnectObject(this);
        this._device = this._client.get_devices().find(d => AUDIO_KINDS.includes(d.kind));
        this.visible = !!this._device;
        if (!this._device)
            return;
        this._device.connectObject('notify::percentage', () => this._update(), this);
        this._update();
    }

    _update() {
        const {model, percentage} = this._device;
        if (/QCY/i.test(model))
            this._icon.gicon = this._earbuds;
        else
            this._icon.icon_name = /JBL/i.test(model) ? 'audio-headset-symbolic' : 'audio-headphones-symbolic';

        const pct = Math.round(percentage);
        this._fill.width = Math.round(BAR_WIDTH * pct / 100);
        this._fill.style_class = `bthb-fill${pct <= 20 ? ' low' : pct <= 50 ? ' mid' : ''}`;
        this._label.text = `${pct}%`;
    }

    destroy() {
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
