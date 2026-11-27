// Onda do som: níveis por faixa (FFT) e o desenho de cada estilo como 5 traços arredondados por coluna,
// para que um estilo se transforme no outro coluna a coluna (protótipo aprovado no canvas).
// Sem dependências do GNOME: testável com `gjs -m check.js`.

export const COLS = 40;
export const STYLES = ['bars', 'siri', 'curve', 'dots'];
export const HOLD = 8;   // segundos parado em cada estilo
export const MORPH = 3;  // segundos para a frente cruzar o painel (direita → esquerda)
export const BAND = 1.2; // segundos que cada coluna leva para se transformar

const N = 1024, RATE = 16000, F_LO = 60, F_HI = 7000, DB_FLOOR = -70, DB_TOP = -12;
const hann = Float32Array.from({length: N}, (_, n) => 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (N - 1)));
const re = new Float32Array(N), im = new Float32Array(N);
// faixas logarítmicas entre 60 Hz e 7 kHz, em índices de bin
const edges = Array.from({length: COLS + 1}, (_, i) => F_LO * Math.pow(F_HI / F_LO, i / COLS) * N / RATE);

function fft() {
    for (let i = 1, j = 0; i < N; i++) {
        let bit = N >> 1;
        for (; j & bit; bit >>= 1)
            j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }
    for (let len = 2; len <= N; len <<= 1) {
        const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < N; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const a = i + k, b = a + len / 2;
                const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
            }
        }
    }
}

// samples: os últimos 1024 valores (s16, 16 kHz, mono). out: COLS níveis entre 0 e 1.
export function levels(samples, out) {
    for (let n = 0; n < N; n++) {
        re[n] = (samples[n] ?? 0) / 32768 * hann[n];
        im[n] = 0;
    }
    fft();
    for (let c = 0; c < COLS; c++) {
        let lo = Math.floor(edges[c]), hi = Math.max(lo + 1, Math.floor(edges[c + 1]));
        let peak = 0;
        for (let k = lo; k < hi && k < N / 2; k++)
            peak = Math.max(peak, Math.hypot(re[k], im[k]) / (N / 4));
        const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
        out[c] = Math.min(1, Math.max(0, (db - DB_FLOOR) / (DB_TOP - DB_FLOOR)));
    }
}

// Sobe rápido e desce devagar, para a onda não tremer.
export class Smoother {
    constructor() {
        this.v = new Float32Array(COLS);
    }

    step(lv) {
        for (let i = 0; i < COLS; i++)
            this.v[i] += (lv[i] - this.v[i]) * (lv[i] > this.v[i] ? 0.6 : 0.12);
        return this.v;
    }
}

const smooth = x => {
    x = Math.max(0, Math.min(1, x));
    return x * x * (3 - 2 * x);
};

// Estilo de agora (a), o próximo (b) e quanto a coluna i já virou (m, 0..1).
export function morph(t, i, W) {
    const period = HOLD + MORPH;
    const seg = Math.floor(t / period) % STYLES.length;
    const lt = t - Math.floor(t / period) * period;
    const a = STYLES[seg], b = STYLES[(seg + 1) % STYLES.length];
    if (lt < HOLD)
        return {a, b, m: 0};
    const start = (1 - (i + 0.5) / COLS) * (MORPH - BAND);
    return {a, b, m: smooth((lt - HOLD - start) / BAND)};
}

// Nível num ponto x qualquer: interpolado entre os centros das colunas (curvas contínuas).
function levelAt(lv, x, W) {
    const p = x / (W / COLS) - 0.5;
    const i = Math.max(0, Math.min(COLS - 1, Math.floor(p)));
    const j = Math.min(COLS - 1, i + 1);
    const f = Math.max(0, Math.min(1, p - i));
    return lv[i] * (1 - f) + lv[j] * f;
}

// 5 traços [x1, y1, x2, y2, largura, alfa] da coluna i no estilo pedido.
export function segments(style, i, lv, t, W, H) {
    const dx = W / COLS, l = i * dx, r = l + dx, cx = l + dx / 2;
    if (style === 'bars') {
        const hb = Math.max(1, levelAt(lv, cx, W) * H * 0.9 - 5);
        const s = [cx, H / 2 - hb / 2, cx, H / 2 + hb / 2, 4.5, 1];
        return [s, [...s.slice(0, 5), 0], [...s.slice(0, 5), 0], [...s.slice(0, 5), 0], [...s.slice(0, 5), 0]];
    }
    if (style === 'siri') {
        let vol = 0;
        for (const v of lv)
            vol += v;
        vol /= COLS;
        const y = (x, k) => {
            const u = x / W * 2 - 1;
            return H / 2 + Math.sin(u * Math.PI * (2.5 + k) + t * (3 + k) * 2) * (1 - u * u) ** 2 * vol * H * 0.9 * [1, 0.7, 0.5][k];
        };
        const out = [0, 1, 2].map(k => [l, y(l, k), r, y(r, k), 2.4, [0.95, 0.65, 0.45][k]]);
        return [...out, [cx, H / 2, cx, H / 2, 2.4, 0], [cx, H / 2, cx, H / 2, 2.4, 0]];
    }
    if (style === 'curve') {
        const y = x => H - 3 - levelAt(lv, x, W) ** 0.8 * (H - 8);
        const yc = y(cx);
        const dot = [cx, yc, cx, yc, 2.4, 0];
        return [[l, y(l), r, y(r), 2.4, 1], [cx, Math.min(H - 3, yc + dx / 2 + 1.5), cx, H - 3, dx, 0.28], dot, dot, dot];
    }
    // dots: coluna de 5 pontos; acesos do centro para fora conforme o nível
    const dy = H / 5, d = Math.min(dx, dy) * 0.72, v = levelAt(lv, cx, W);
    return [0, 1, 2, 3, 4].map(j => [cx, j * dy + dy / 2, cx, j * dy + dy / 2, d, Math.abs(j - 2) <= v * 5 / 2 ? 1 : 0.15]);
}

export const blend = (sa, sb, m) => sa.map((s, j) => s.map((v, n) => v * (1 - m) + sb[j][n] * m));
