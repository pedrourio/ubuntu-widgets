// Depois de idle-minutes sem mexer no mouse nem no teclado, abre o screensaver.sh; qualquer mexida fecha.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const INHIBIT_IDLE = 8; // GsmInhibitorFlag: vídeo tocando, chamada etc.

export default class ScreensaverExtension extends Extension {
    enable() {
        this._monitor = global.backend.get_core_idle_monitor();
        this._settings = this.getSettings();
        this._settings.connectObject('changed::idle-minutes', () => this._watch(), this);
        this._watch();
    }

    disable() {
        this._settings.disconnectObject(this);
        this._settings = null;
        this._unwatch();
        this._close();
        this._monitor = null;
    }

    _watch() {
        this._unwatch();
        this._idleId = this._monitor.add_idle_watch(this._settings.get_uint('idle-minutes') * 60e3, () => this._maybeOpen());
    }

    _unwatch() {
        if (this._idleId)
            this._monitor.remove_watch(this._idleId);
        if (this._activeId)
            this._monitor.remove_watch(this._activeId);
        this._idleId = this._activeId = 0;
    }

    _maybeOpen() {
        if (this._proc || Main.sessionMode.isLocked)
            return;
        Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager',
            'IsInhibited', new GLib.Variant('(u)', [INHIBIT_IDLE]), null, Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                let inhibited = false;
                try {
                    [inhibited] = conn.call_finish(res).deepUnpack();
                } catch {}
                if (!inhibited && this._monitor && !this._proc && this._monitor.get_idletime() > 1000)
                    this._open();
            });
    }

    _open() {
        try {
            this._proc = Gio.Subprocess.new([`${this.path}/screensaver.sh`], Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.error(`screensaver: ${e.message}`);
            return;
        }
        this._proc.wait_async(null, () => {
            this._proc = null;
        });
        // vigia de atividade dispara uma vez só; abrir a janela não conta como atividade
        this._activeId = this._monitor.add_user_active_watch(() => {
            this._activeId = 0;
            this._close();
        });
    }

    _close() {
        this._proc?.force_exit();
        this._proc = null;
    }
}
