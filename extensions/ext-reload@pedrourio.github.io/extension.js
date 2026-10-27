// Recarrega uma extensão do usuário sem logout. O GNOME guarda os módulos já importados
// pelo caminho do arquivo e só bloqueia a recarga por versão; carregar uma cópia em outro
// caminho, com o mesmo uuid e a mesma versão, traz o código novo.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ExtensionType, ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const PATH = '/io/github/pedrourio/ExtReload';
const IFACE = `<node><interface name="io.github.pedrourio.ExtReload">
  <method name="Reload"><arg type="s" direction="in" name="uuid"/><arg type="s" direction="out" name="result"/></method>
</interface></node>`;
const SRC = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions']);
const COPIES = GLib.build_filenamev([GLib.get_user_cache_dir(), 'ext-reload']);
const STATE = Object.fromEntries(Object.entries(ExtensionState).map(([k, v]) => [v, k]));

function run(argv) {
    return new Promise((resolve, reject) => {
        const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDERR_PIPE);
        proc.communicate_utf8_async(null, null, (p, res) => {
            const [, , err] = p.communicate_utf8_finish(res);
            p.get_successful() ? resolve() : reject(new Error(err.trim() || argv.join(' ')));
        });
    });
}

export default class ExtReload extends Extension {
    enable() {
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        // Exporta na conexão do próprio gnome-shell: chama-se com --dest org.gnome.Shell.
        this._dbus.export(Gio.DBus.session, PATH);
    }

    disable() {
        this._dbus.unexport();
        this._dbus = null;
    }

    async ReloadAsync([uuid], invocation) {
        try {
            invocation.return_value(new GLib.Variant('(s)', [await this._reload(uuid)]));
        } catch (e) {
            invocation.return_error_literal(Gio.DBusError, Gio.DBusError.FAILED, e.message);
        }
    }

    async _reload(uuid) {
        if (uuid === this.uuid)
            throw new Error('não recarrego a mim mesmo; esta precisa de logout');
        // uuid vira caminho: nada de barra ou "..", e só extensões instaladas pelo usuário
        if (!/^[\w.-]+@[\w.-]+$/.test(uuid) || uuid.includes('..'))
            throw new Error(`uuid inválido: ${uuid}`);
        const src = GLib.build_filenamev([SRC, uuid]);
        if (!GLib.file_test(GLib.build_filenamev([src, 'metadata.json']), GLib.FileTest.EXISTS))
            throw new Error(`não instalada: ${src}`);

        // a pasta precisa ter o nome do uuid; o carimbo de tempo é o que muda o caminho
        const stamp = String(GLib.get_real_time());
        const base = GLib.build_filenamev([COPIES, uuid]);
        const dest = GLib.build_filenamev([base, stamp, uuid]);
        GLib.mkdir_with_parents(GLib.path_get_dirname(dest), 0o700);
        await run(['cp', '-rL', `${src}/.`, dest]);

        const mgr = Main.extensionManager;
        const old = mgr.lookup(uuid);
        if (old)
            await mgr.unloadExtension(old);
        const ext = mgr.createExtensionObject(uuid, Gio.File.new_for_path(dest), ExtensionType.PER_USER);
        await mgr.loadExtension(ext);

        // cópias antigas: o código delas já está em memória, os arquivos não fazem falta
        const dir = Gio.File.new_for_path(base);
        const it = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let info; (info = it.next_file(null));) {
            if (info.get_name() !== stamp)
                await run(['rm', '-rf', GLib.build_filenamev([base, info.get_name()])]).catch(() => {});
        }

        const state = STATE[ext.state] ?? String(ext.state);
        return ext.error ? `${state}: ${ext.error}` : state;
    }
}
