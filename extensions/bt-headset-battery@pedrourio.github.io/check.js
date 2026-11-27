// gjs -m check.js  → falha com exceção se alguma regra de qcy.js ou wave.js quebrar.
import {MODES, frame, readModeFrame, setModeFrame, FrameParser, modeFromPayload, controlMac} from './qcy.js';

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
