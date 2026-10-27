// Burndown desenhado com Cairo; a linha do restante ondula de leve só enquanto start() estiver ativo.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import {draw, W, H} from './draw.js';

const PERIOD = 3000; // ms
const FRAME = 50; // ms (~20 fps): suave o bastante e barato

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

    start() {
        if (this._tick || !this._series || !this._anim.get_boolean('enable-animations'))
            return;
        const t0 = Date.now();
        this._tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, FRAME, () => {
            this._phase = ((Date.now() - t0) % PERIOD) / PERIOD * 2 * Math.PI;
            this.queue_repaint();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._tick)
            GLib.source_remove(this._tick);
        this._tick = null;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        if (this._series)
            draw(cr, this._series, this._phase);
        cr.$dispose();
    }
});
