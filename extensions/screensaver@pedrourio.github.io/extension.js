// Depois de idle-minutes sem mexer no mouse nem no teclado, abre o screensaver.sh em todos os monitores
// e esconde o ponteiro; qualquer mexida fecha. O comando `screensaver` chama Start por D-Bus.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const INHIBIT_IDLE = 8; // GsmInhibitorFlag: vídeo tocando, chamada etc.
const PATH = '/io/github/pedrourio/Screensaver';
const IFACE = `<node><interface name="io.github.pedrourio.Screensaver"><method name="Start"/></interface></node>`;

export default class ScreensaverExtension extends Extension {
    enable() {
        this._monitor = global.backend.get_core_idle_monitor();
        this._procs = new Map(); // pid → {proc, monitor}
        this._settings = this.getSettings();
        this._settings.connectObject('changed::idle-minutes', () => this._watch(), this);
        this._watch();
        global.display.connectObject('window-created', (_d, win) => this._place(win), this);
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._dbus.export(Gio.DBus.session, PATH);
    }

    disable() {
        this._dbus.unexport();
        this._dbus = null;
        global.display.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._settings = null;
        this._unwatch();
        this._close();
        this._monitor = null;
        this._procs = null;
    }

    Start() {
        this._open();
    }

    _watch() {
        this._unwatch();
        this._idleId = this._monitor.add_idle_watch(this._settings.get_uint('idle-minutes') * 60e3, () => this._maybeOpen());
    }

    _unwatch() {
        if (this._idleId)
            this._monitor.remove_watch(this._idleId);
        this._idleId = 0;
        this._unwatchActive();
    }

    _unwatchActive() {
        if (this._armId)
            GLib.source_remove(this._armId);
        this._armId = 0;
        if (this._activeId)
            this._monitor.remove_watch(this._activeId);
        this._activeId = 0;
    }

    _maybeOpen() {
        if (this._procs.size || Main.sessionMode.isLocked)
            return;
        Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager',
            'IsInhibited', new GLib.Variant('(u)', [INHIBIT_IDLE]), null, Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                let inhibited = false;
                try {
                    [inhibited] = conn.call_finish(res).deepUnpack();
                } catch {}
                if (!inhibited && this._monitor && this._monitor.get_idletime() > 1000)
                    this._open();
            });
    }

    // um terminal por monitor; _place põe cada janela em tela cheia no seu
    _open() {
        if (this._procs.size)
            return;
        Main.layoutManager.monitors.forEach((_m, monitor) => {
            try {
                const proc = Gio.Subprocess.new(['ptyxis', '-s', '-T', 'screensaver', '--', `${this.path}/screensaver.sh`, '--run'], Gio.SubprocessFlags.NONE);
                const pid = Number(proc.get_identifier());
                this._procs.set(pid, {proc, monitor});
                proc.wait_async(null, () => {
                    this._procs?.delete(pid);
                    if (this._procs && !this._procs.size)
                        this._close();
                });
            } catch (e) {
                console.error(`screensaver: ${e.message}`);
            }
        });
        if (!this._procs.size)
            return;
        global.backend.get_cursor_tracker().inhibit_cursor_visibility();
        this._cursorHidden = true;
        // vigia de atividade dispara uma vez só; espera 1 s para soltar o Enter de quem rodou `screensaver` não fechar
        this._armId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._armId = 0;
            this._activeId = this._monitor.add_user_active_watch(() => {
                this._activeId = 0;
                this._close();
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _place(win) {
        const entry = this._procs.get(win.get_pid());
        if (!entry)
            return;
        const id = win.connect('shown', () => {
            win.disconnect(id);
            win.move_to_monitor(entry.monitor);
            win.make_fullscreen();
        });
    }

    _close() {
        this._unwatchActive();
        for (const {proc} of this._procs.values())
            proc.force_exit();
        this._procs.clear();
        if (this._cursorHidden)
            global.backend.get_cursor_tracker().uninhibit_cursor_visibility();
        this._cursorHidden = false;
    }
}
