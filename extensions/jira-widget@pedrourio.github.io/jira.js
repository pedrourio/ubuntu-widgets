import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

export class JiraError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

export class JiraClient {
    constructor(cfg, token) {
        this._site = cfg.site;
        this._auth = `Basic ${GLib.base64_encode(new TextEncoder().encode(`${cfg.email}:${token}`))}`;
        this._session = new Soup.Session({timeout: 20});
    }

    // GET com query string; resolve o JSON. A mensagem de erro nunca leva o token.
    request(path, params = {}, cancellable = null) {
        const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
        const msg = Soup.Message.new('GET', `${this._site}${path}${qs ? `?${qs}` : ''}`);
        msg.request_headers.append('Authorization', this._auth);
        msg.request_headers.append('Accept', 'application/json');
        return new Promise((resolve, reject) => {
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
                try {
                    const bytes = s.send_and_read_finish(res);
                    const status = msg.get_status();
                    if (status >= 400)
                        throw new JiraError(status, `Jira respondeu ${status} em ${path}`);
                    resolve(JSON.parse(new TextDecoder().decode(bytes.get_data())));
                } catch (e) {
                    reject(e instanceof JiraError ? e : new JiraError(0, e.message));
                }
            });
        });
    }

    abort() {
        this._session.abort();
    }
}
