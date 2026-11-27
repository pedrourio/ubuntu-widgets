# Fone: modos de áudio e onda — plano

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** menu no bt-headset-battery com os 3 modos do QCY N20 (BLE/JieLi) e a onda do som com transformação entre 4 estilos.

**Architecture:** regras puras em `qcy.js` (quadros RCSP, modos, reconhecer o fone) e `wave.js` (níveis por FFT, desenho de cada estilo como 5 traços por coluna, estado da transformação), testadas em `check.js` com `gjs -m`. `ble.js` fala com o BlueZ por D-Bus. `extension.js` monta o menu, o `St.DrawingArea` (cairo) e o `pw-record`.

**Tech Stack:** GJS ESM, GNOME Shell 50, Gio D-Bus (BlueZ 5.85), cairo, PipeWire `pw-record`.

**Spec:** `docs/superpowers/specs/2026-11-27-fone-modos-e-onda-design.md`

## Global Constraints

- Só os comandos `FE 01 17` (ler) e `17 03 m s n` com os três trios do spec; só no característico `00000001` do serviço `a002`.
- BLE, `pw-record` e animação só com o menu aberto; tudo parado e desconectado ao fechar e no `destroy`.
- `GTypeName` derivado de `import.meta.url` (CLAUDE.md). Depois de mudar: `ext-reload bt-headset-battery@pedrourio.github.io` → ACTIVE.
- Cores: Normal `#57e389`, ANC `#62a0ea`, Ambiente `#f6d32d`; cinza `rgba(255,255,255,0.45)`.
- Commit + push no `main` a cada tarefa, com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Fone desconecta com o menu aberto: BLE e `pw-record` param, menu volta a só bateria, sem erro no log.
2. Fone de outra marca: nenhuma busca BLE, menu só com bateria.
3. Abrir e fechar o menu rápido várias vezes: nenhum `pw-record` ou conexão BLE sobra.
4. Quadro RCSP partido em duas notificações ou dois quadros numa só: o parser junta e separa.
5. Silêncio: onda parada e cinza, sem divisão por zero na normalização.

---

### Task 1: `qcy.js` — protocolo

**Files:** Create `extensions/bt-headset-battery@pedrourio.github.io/qcy.js`, `check.js`.

**Produces:**
- `MODES = [{id:'normal', name:'Normal', code:[2,0,0], color:'#57e389', icon:'mode-normal'}, {id:'anc', name:'ANC adaptativo', code:[1,5,0], color:'#62a0ea', icon:'mode-anc', badge:'ANC'}, {id:'ambient', name:'Ambiente', code:[3,1,4], color:'#f6d32d', icon:'mode-ambient', badge:'AMB'}]`
- `frame(sn, data) -> Uint8Array` (`FE DC BA C0 FF len_be16 sn ...data EF`)
- `readModeFrame(sn)`, `setModeFrame(sn, modeId)`
- `class FrameParser { push(bytes) -> Array<{flag, cmd, payload}> }` (junta pedaços, separa vários quadros)
- `modeFromPayload(flag, payload) -> modeId | null` (resposta `flag 00`: `[status, sn, 0x17, 3, m, s, n]`; aviso `flag 80`: `[sn, 0x17, 3, m, s, n]`; trio desconhecido → `null`)
- `controlMac(manufBytes) -> 'AA:BB:…' | null` (ordem `[12]:[11]:[13]:[16]:[15]:[14]`, exige ≥ 17 bytes)

- [ ] testes no `check.js` com os bytes reais do spec (ler `fedcbac0ff000401fe0117ef`; trocar ANC `fedcbac0ff0006021703010500ef`; resposta `fedcba00ff000700011703020000ef` → normal; aviso `fedcba80ff0006091703010500ef` → anc; quadro partido ao meio; dois quadros juntos; control MAC do anúncio real `[128,116,191,243,110,100,100,0,248,142,16,172,132,96,248,142,16,…]` → `84:AC:60:10:8E:F8`) → FALHA → implementar → passa → commit.

### Task 2: `wave.js` — onda

**Produces:**
- `COLS = 40`, `STYLES = ['bars','siri','curve','dots']`, `HOLD = 8`, `MORPH = 3`, `BAND = 1.2`
- `levels(samples: Int16Array, out: Float32Array)`: FFT 1024 pontos com janela de Hann, 40 faixas log entre 60 Hz e 7 kHz, escala de dB para 0..1
- `class Smoother { step(levels) }` (sobe rápido, desce devagar)
- `segments(style, i, lv, t, W, H) -> 5 × [x1,y1,x2,y2,width,alpha]` (mesma geometria do protótipo aprovado)
- `morph(t, i, W) -> {a, b, m}` (estilo de agora, próximo e mistura 0..1 com frente da direita para a esquerda)
- `blend(sa, sb, m)`

- [ ] testes: silêncio → todos os níveis 0 e sem NaN; seno de 1 kHz → maior faixa perto de 1 kHz; `morph` em t=0 → m=0; no fim do MORPH todas as colunas m=1; coluna da direita começa antes da esquerda; `segments('siri')` coluna i termina onde a i+1 começa (sem degrau) → FALHA → implementar → passa → commit.

### Task 3: `ble.js` + menu + onda no widget

- [ ] `ble.js`: `class QcyLink` com `async open(classicMac)` (acha/busca o endereço BLE pelo dado de fabricante, conecta, `StartNotify`), `readMode()`, `setMode(id)`, sinal de modo, `close()`; nunca lança para o widget.
- [ ] `extension.js`: menu com cabeçalho, bateria, `St.DrawingArea` da onda, seção de modos (ícones SVG `mode-*-symbolic.svg`, classes `bthb-mode` / `bthb-mode-on-<id>`), etiqueta na barra; ao abrir: `QcyLink.open`, `pw-record`, timer de ~33 ms; ao fechar/destruir: tudo para.
- [ ] `ext-reload` → ACTIVE, log limpo; teste com o Pedro: abrir, ver onda, trocar os três modos ouvindo.
- [ ] README; commit.
