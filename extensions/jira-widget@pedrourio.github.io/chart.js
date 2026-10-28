// Burndown desenhado com Cairo; a linha do restante ondula de leve só enquanto start() estiver ativo.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import {draw, W, H} from './draw.js';

const PERIOD = 3200; // ms por ciclo da onda

export const Burndown = GObject.registerClass({GTypeName: `JwBurndown_${GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, import.meta.url, -1)}`},
class Burndown extends St.DrawingArea {
    _init() {
        super._init({width: W, height: H, style_class: 'jw-chart'});
        this._series = null;
        this._phase = 0;
        this._anim = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this.connect('destroy', () => this.stop());
    }

    setData(series) {
        this._series = series;
        this.queue_repaint();
    }

    // Quadros no ritmo da tela (Clutter.Timeline): fluido, e só existe com o menu aberto.
    start() {
        if (this._timeline || !this._series || !this._anim.get_boolean('enable-animations'))
            return;
        this._timeline = new Clutter.Timeline({actor: this, duration: PERIOD, repeat_count: -1});
        this._timeline.connect('new-frame', (_t, msecs) => {
            this._phase = msecs / PERIOD * 2 * Math.PI;
            this.queue_repaint();
        });
        this._timeline.start();
    }

    stop() {
        this._timeline?.stop();
        this._timeline = null;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        if (this._series)
            draw(cr, this._series, this._phase);
        cr.$dispose();
    }
});
