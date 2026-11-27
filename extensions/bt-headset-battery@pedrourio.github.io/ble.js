// Conexão BLE com o QCY pelo BlueZ (D-Bus), só enquanto o menu está aberto. Nunca lança para o widget:
// devolve false/erro em texto. Só escreve no característico de comandos (00000001) do serviço a002.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {QCY_COMPANY, SERVICE, WRITE_CHAR, NOTIFY_CHAR, FrameParser, modeFromPayload, readModeFrame, setModeFrame, controlMac} from './qcy.js';

const BLUEZ = 'org.bluez';
const ADAPTER = '/org/bluez/hci0';
const wait = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => (r(), GLib.SOURCE_REMOVE)));

export class QcyLink {
    constructor(onMode) {
        this._onMode = onMode;
        this._parser = new FrameParser();
        this._sn = 0;
        this._closed = false;
    }

    _call(path, iface, method, args = null, type = null, timeout = 15000) {
        return new Promise((resolve, reject) => this._bus.call(BLUEZ, path, iface, method, args, type ? new GLib.VariantType(type) : null,
            Gio.DBusCallFlags.NONE, timeout, null, (b, res) => {
                try {
                    resolve(b.call_finish(res));
                } catch (e) {
                    reject(e);
                }
            }));
    }

    async _objects() {
        return (await this._call('/', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects', null, '(a{oa{sa{sv}}})')).recursiveUnpack()[0];
    }

    // Endereço BLE do fone: o anúncio do fabricante QCY traz o endereço clássico do fone conectado.
    _findDevice(objs, classicMac) {
        for (const [path, ifaces] of Object.entries(objs)) {
            const md = ifaces['org.bluez.Device1']?.ManufacturerData?.[QCY_COMPANY];
            if (md && controlMac(md) === classicMac.toUpperCase())
                return path;
        }
        return null;
    }

    // true quando conectou e pediu o modo atual (a resposta chega pelo onMode).
    async open(classicMac) {
        try {
            this._bus = Gio.DBus.system;
            let objs = await this._objects();
            let dev = this._findDevice(objs, classicMac);
            if (!dev) {
                // o BlueZ só guarda o endereço BLE enquanto o vê numa busca
                await this._call(ADAPTER, 'org.bluez.Adapter1', 'SetDiscoveryFilter',
                    new GLib.Variant('(a{sv})', [{Transport: new GLib.Variant('s', 'le')}])).catch(() => {});
                await this._call(ADAPTER, 'org.bluez.Adapter1', 'StartDiscovery').catch(() => {});
                for (let i = 0; i < 20 && !dev && !this._closed; i++) {
                    await wait(300);
                    dev = this._findDevice(await this._objects(), classicMac);
                }
                await this._call(ADAPTER, 'org.bluez.Adapter1', 'StopDiscovery').catch(() => {});
            }
            if (!dev || this._closed)
                return false;
            this._dev = dev;
            await this._call(dev, 'org.bluez.Device1', 'Connect');
            let write = null, notify = null;
            for (let i = 0; i < 25 && !this._closed && !(write && notify); i++) {
                objs = await this._objects();
                const service = Object.keys(objs).find(p => p.startsWith(`${dev}/`) && objs[p]['org.bluez.GattService1']?.UUID === SERVICE);
                if (service) {
                    for (const [p, ifaces] of Object.entries(objs)) {
                        const uuid = p.startsWith(`${service}/`) && ifaces['org.bluez.GattCharacteristic1']?.UUID;
                        if (uuid === WRITE_CHAR)
                            write = p;
                        else if (uuid === NOTIFY_CHAR)
                            notify = p;
                    }
                }
                if (!(write && notify))
                    await wait(200);
            }
            if (!write || !notify || this._closed)
                return false;
            this._write = write;
            this._notify = notify;
            this._sub = this._bus.signal_subscribe(BLUEZ, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', notify, null,
                Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                    const value = params.recursiveUnpack()[1].Value;
                    if (!value)
                        return;
                    for (const f of this._parser.push(value)) {
                        const mode = f.cmd === 0xff ? modeFromPayload(f.flag, f.payload) : null;
                        if (mode)
                            this._onMode(mode);
                    }
                });
            await this._call(notify, 'org.bluez.GattCharacteristic1', 'StartNotify');
            await this._send(readModeFrame(this._nextSn()));
            return !this._closed;
        } catch (e) {
            console.warn(`bt-headset-battery: BLE do QCY: ${e.message}`);
            return false;
        }
    }

    _nextSn() {
        this._sn = (this._sn + 1) & 0xff;
        return this._sn;
    }

    _send(bytes) {
        return this._call(this._write, 'org.bluez.GattCharacteristic1', 'WriteValue',
            new GLib.Variant('(aya{sv})', [[...bytes], {type: new GLib.Variant('s', 'command')}]));
    }

    async setMode(id) {
        if (!this._write || this._closed)
            return false;
        try {
            await this._send(setModeFrame(this._nextSn(), id));
            return true;
        } catch (e) {
            console.warn(`bt-headset-battery: troca de modo: ${e.message}`);
            return false;
        }
    }

    close() {
        this._closed = true;
        if (this._sub)
            this._bus.signal_unsubscribe(this._sub);
        this._sub = 0;
        // é a conexão BLE (endereço próprio); o áudio do Bluetooth clássico não cai
        if (this._dev)
            this._call(this._dev, 'org.bluez.Device1', 'Disconnect').catch(() => {});
        this._dev = this._write = this._notify = null;
    }
}
