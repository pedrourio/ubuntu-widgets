// Protocolo do QCY MeloBuds N20 (chip JieLi, RCSP sobre BLE), testado no fone em 2026-11-27.
// Só estes comandos vão ao fone: ler o modo (FE 01 17) e trocar o modo (17 03 m s n).
// Sem dependências do GNOME: testável com `gjs -m check.js`.

export const QCY_COMPANY = 0x521c;
export const SERVICE = '0000a002-0000-1000-8000-00805f9b34fb';
export const WRITE_CHAR = '00000001-0000-1000-8000-00805f9b34fb';
export const NOTIFY_CHAR = '00000002-0000-1000-8000-00805f9b34fb';

export const MODES = [
    {id: 'normal', name: 'Normal', code: [2, 0, 0], color: '#57e389', icon: 'mode-normal'},
    {id: 'anc', name: 'ANC adaptativo', code: [1, 5, 0], color: '#62a0ea', icon: 'mode-anc', badge: 'ANC'},
    {id: 'ambient', name: 'Ambiente', code: [3, 1, 4], color: '#f6d32d', icon: 'mode-ambient', badge: 'AMB'},
];

const HEAD = [0xfe, 0xdc, 0xba];
const TAIL = 0xef;
const ANC_CMD = 0x17;

// FE DC BA | C0 (comando que pede resposta) | FF (comando personalizado) | tamanho BE16 | sn | dados | EF
export function frame(sn, data) {
    const len = data.length + 1;
    return Uint8Array.from([...HEAD, 0xc0, 0xff, len >> 8, len & 0xff, sn & 0xff, ...data, TAIL]);
}

export const readModeFrame = sn => frame(sn, [0xfe, 0x01, ANC_CMD]);

export function setModeFrame(sn, id) {
    const mode = MODES.find(m => m.id === id);
    if (!mode)
        throw new Error(`modo desconhecido: ${id}`);
    return frame(sn, [ANC_CMD, 3, ...mode.code]);
}

// Avisos do BLE podem partir um quadro em dois ou juntar vários: guarda o resto para o próximo push.
export class FrameParser {
    constructor() {
        this._buf = [];
    }

    push(bytes) {
        this._buf.push(...bytes);
        const out = [];
        for (;;) {
            const start = this._buf.findIndex((b, i) => b === HEAD[0] && this._buf[i + 1] === HEAD[1] && this._buf[i + 2] === HEAD[2]);
            if (start < 0) {
                this._buf = this._buf.slice(-2);
                return out;
            }
            this._buf = this._buf.slice(start);
            if (this._buf.length < 7)
                return out;
            const len = (this._buf[5] << 8) | this._buf[6];
            if (this._buf.length < 8 + len)
                return out;
            if (this._buf[7 + len] === TAIL)
                out.push({flag: this._buf[3], cmd: this._buf[4], payload: this._buf.slice(7, 7 + len)});
            this._buf = this._buf.slice(this._buf[7 + len] === TAIL ? 8 + len : 1);
        }
    }
}

// Resposta à leitura (flag 00): [status, sn, 17, 03, m, s, n]. Aviso do fone (flag 80): [sn, 17, 03, m, s, n].
export function modeFromPayload(flag, payload) {
    const body = flag === 0x00 ? payload.slice(2) : flag === 0x80 ? payload.slice(1) : [];
    if (body[0] !== ANC_CMD || body[1] !== 3)
        return null;
    return MODES.find(m => m.code.every((v, i) => v === body[2 + i]))?.id ?? null;
}

// Dado de fabricante 0x521c: endereço do fone no Bluetooth clássico, em ordem embaralhada.
export function controlMac(data) {
    if (!data || data.length < 17)
        return null;
    return [12, 11, 13, 16, 15, 14].map(i => data[i].toString(16).padStart(2, '0').toUpperCase()).join(':');
}
