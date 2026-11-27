// gjs -m check.js  → falha com exceção se alguma regra de qcy.js ou wave.js quebrar.
import {MODES, frame, readModeFrame, setModeFrame, FrameParser, modeFromPayload, controlMac} from './qcy.js';
import {COLS, STYLES, HOLD, MORPH, levels, Smoother, segments, morph, blend} from './wave.js';

const assert = (cond, msg) => {
    if (!cond)
        throw new Error(`FALHOU: ${msg}`);
};
const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const bytes = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));

// protocolo do QCY N20 (bytes reais de 2026-11-27)
assert(MODES.map(m => m.id).join() === 'normal,anc,ambient', 'três modos na ordem do menu');
assert(hex(readModeFrame(1)) === 'fedcbac0ff000401fe0117ef', 'ler modo');
assert(hex(setModeFrame(2, 'anc')) === 'fedcbac0ff0006021703010500ef', 'ANC adaptativo');
assert(hex(setModeFrame(2, 'ambient')) === 'fedcbac0ff0006021703030104ef', 'ambiente');
assert(hex(setModeFrame(4, 'normal')) === 'fedcbac0ff0006041703020000ef', 'normal');
assert(hex(frame(7, [1, 2])) === 'fedcbac0ff00030701' + '02ef', 'quadro genérico');
let threw = false;
try {
    setModeFrame(1, 'vento');
} catch {
    threw = true;
}
assert(threw, 'modo desconhecido não vira comando');

const p = new FrameParser();
let out = p.push(bytes('fedcba00ff0007000117'));
assert(out.length === 0, 'quadro pela metade espera o resto');
out = p.push(bytes('03020000ef'));
assert(out.length === 1 && modeFromPayload(out[0].flag, out[0].payload) === 'normal', 'resposta à leitura = normal');
out = p.push(bytes('fedcba00ff00020002effedcba80ff0006091703010500ef'));
assert(out.length === 2, 'dois quadros numa notificação');
assert(modeFromPayload(out[0].flag, out[0].payload) === null, 'confirmação de escrita não traz modo');
assert(modeFromPayload(out[1].flag, out[1].payload) === 'anc', 'aviso espontâneo = ANC');
out = p.push(bytes('0011fedcba80ff00060b1703030104ef'));
assert(out.length === 1 && modeFromPayload(out[0].flag, out[0].payload) === 'ambient', 'lixo antes do quadro é ignorado');
out = new FrameParser().push(bytes('fedcba80ff0006091703090900ef'));
assert(modeFromPayload(out[0].flag, out[0].payload) === null, 'trio desconhecido = null');

const adv = [128, 116, 191, 243, 110, 100, 100, 0, 248, 142, 16, 172, 132, 96, 248, 142, 16, 67, 3, 189, 110, 89, 105, 23];
assert(controlMac(adv) === '84:AC:60:10:8E:F8', 'control MAC do anúncio');
assert(controlMac(adv.slice(0, 10)) === null, 'anúncio curto');
print('ok: qcy');

// onda
const W = 280, H = 56, RATE = 16000;
const lv = new Float32Array(COLS);
levels(new Int16Array(1024), lv);
assert(lv.every(v => v === 0), 'silêncio = níveis zerados');
const sine = Int16Array.from({length: 1024}, (_, n) => Math.round(12000 * Math.sin(2 * Math.PI * 1000 * n / RATE)));
levels(sine, lv);
const top = lv.indexOf(Math.max(...lv));
const centre = i => 60 * Math.pow(7000 / 60, (i + 0.5) / COLS);
assert(Math.abs(Math.log(centre(top) / 1000)) < 0.25, `seno de 1 kHz cai na faixa de 1 kHz (faixa ${top}, ${Math.round(centre(top))} Hz)`);
assert(lv.every(v => Number.isFinite(v) && v >= 0 && v <= 1), 'níveis entre 0 e 1');
const sm = new Smoother();
const z = sm.step(new Float32Array(COLS));
assert(z.every(v => v === 0), 'suavizador começa em zero');
assert(STYLES.join() === 'bars,siri,curve,dots', 'ordem dos estilos');
let st = morph(0, 0, W);
assert(st.a === 'bars' && st.b === 'siri' && st.m === 0, 'começa nas barras, sem mistura');
st = morph(HOLD + MORPH - 0.01, 0, W);
assert(st.m > 0.99, 'no fim da transformação a coluna da esquerda já virou');
const mid = HOLD + MORPH / 2;
assert(morph(mid, COLS - 1, W).m > morph(mid, 0, W).m, 'a direita transforma antes da esquerda');
assert(morph(4 * (HOLD + MORPH) + 1, 0, W).a === 'bars', 'ciclo recomeça');
lv.fill(0.5);
for (let i = 0; i < COLS - 1; i++) {
    const a = segments('siri', i, lv, 1.3, W, H), b = segments('siri', i + 1, lv, 1.3, W, H);
    for (let k = 0; k < 3; k++)
        assert(Math.abs(a[k][2] - b[k][0]) < 1e-6 && Math.abs(a[k][3] - b[k][1]) < 1e-6, 'Siri contínua entre colunas');
}
assert(segments('dots', 0, lv, 0, W, H).length === 5 && segments('bars', 0, lv, 0, W, H).length === 5, '5 traços por coluna');
const bl = blend([[0, 0, 10, 10, 2, 1]], [[10, 10, 20, 20, 4, 0]], 0.5)[0];
assert(bl.join() === '5,5,15,15,3,0.5', 'mistura linear');
print('ok: onda');
