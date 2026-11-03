import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// claude -p sem interação, só com ferramentas de leitura; devolve a saída estruturada e a sessão (para --resume).
// O shell não tem ~/.local/bin no PATH, por isso o caminho de reserva.
export function runClaude({prompt, schema, cwd, resume = null, cancellable = null, timeoutSec = 180}) {
    const bin = GLib.find_program_in_path('claude') ?? GLib.build_filenamev([GLib.get_home_dir(), '.local/bin/claude']);
    if (!GLib.file_test(bin, GLib.FileTest.IS_EXECUTABLE))
        return Promise.reject(new Error('claude não encontrado'));
    // --tools só limita as ferramentas internas; --strict-mcp-config tira os servidores MCP do usuário
    // (shell, criar card no Jira), que o texto de terceiros no prompt poderia acionar.
    // prompt antes de --tools: a opção aceita vários valores e engoliria o que vem depois
    const argv = [bin, '-p', prompt, '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--strict-mcp-config',
        ...(resume ? ['--resume', resume] : []), '--tools', 'Read', 'Grep', 'Glob'];
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE});
    launcher.set_cwd(cwd || GLib.get_home_dir());
    return new Promise((resolve, reject) => {
        let proc, why = null;
        try {
            proc = launcher.spawnv(argv);
        } catch (e) {
            reject(new Error(e.message));
            return;
        }
        // SIGTERM: o claude encerra os próprios filhos
        const stop = reason => {
            why = reason;
            proc.send_signal(15);
        };
        let timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSec, () => {
            timer = 0;
            stop('tempo esgotado');
            return GLib.SOURCE_REMOVE;
        });
        const cancelId = cancellable?.connect(() => stop('cancelado')) ?? 0;
        proc.communicate_utf8_async(null, null, (p, res) => {
            if (timer)
                GLib.source_remove(timer);
            if (cancelId)
                cancellable.disconnect(cancelId);
            try {
                const [, out, err] = p.communicate_utf8_finish(res);
                if (why)
                    throw new Error(why);
                let json = null;
                try {
                    json = JSON.parse(out);
                } catch {}
                if (!json || json.is_error || !json.structured_output)
                    throw new Error((json?.result || err.trim().split('\n').pop() || 'claude falhou').slice(0, 200));
                resolve({sessionId: json.session_id, output: json.structured_output});
            } catch (e) {
                reject(e);
            }
        });
    });
}
