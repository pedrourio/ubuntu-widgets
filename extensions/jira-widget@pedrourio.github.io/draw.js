// Desenho do burndown em Cairo, sem St: o shell usa, e dá para gerar prévia em PNG com gjs puro.
export const W = 560, H = 190, PAD = {l: 36, r: 12, t: 16, b: 22};
const BLUE = [0x57 / 255, 0x9d / 255, 0xff / 255], GREY = [0x8c / 255, 0x9b / 255, 0xab / 255], GRID = [0x38 / 255, 0x41 / 255, 0x4a / 255];
export const AMP = 2.2; // px: tem que parecer gelatina, não terremoto
const WAVELENGTH = 180; // px entre duas cristas

export function draw(cr, s, phase = 0) {
    const start = s.ideal[0].t, end = s.ideal[1].t;
    const top = Math.max(s.total, ...s.points.map(p => p.remaining), 1);
    const x = t => PAD.l + (t - start) / (end - start) * (W - PAD.l - PAD.r);
    const y = v => PAD.t + (1 - v / top) * (H - PAD.t - PAD.b);
    cr.selectFontFace('Noto Sans', 0, 0);
    cr.setFontSize(10);

    // grade e eixo de pontos (topo, metade, zero)
    cr.setLineWidth(1);
    for (const v of [top, top / 2, 0]) {
        cr.setSourceRGB(...GRID);
        cr.moveTo(PAD.l, y(v));
        cr.lineTo(W - PAD.r, y(v));
        cr.stroke();
        cr.setSourceRGB(...GREY);
        cr.moveTo(2, y(v) + 3);
        cr.showText(String(Math.round(v)));
    }
    // dias da sprint
    for (let t = start; t <= end; t += 86400e3) {
        const d = new Date(t);
        cr.moveTo(x(t) - 12, H - 6);
        cr.showText(`${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    // diretriz
    cr.setSourceRGB(...GREY);
    cr.setLineWidth(1.5);
    cr.moveTo(x(start), y(s.total));
    cr.lineTo(x(end), y(0));
    cr.stroke();

    // Curva base (degraus suavizados), amostrada a cada ~3 px para a onda deformar a linha inteira.
    const base = s.points.map(p => [x(p.t), y(p.remaining)]);
    const samples = [base[0]];
    for (let i = 1; i < base.length; i++) {
        const [x0, y0] = base[i - 1], [x1, y1] = base[i];
        const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 3));
        for (let k = 1; k <= n; k++) {
            const u = k / n, v = 1 - u;
            // Bézier com controles no meio do trecho (mesma forma de antes)
            samples.push([v * v * v * x0 + 3 * v * u * (x0 + x1) / 2 + u * u * u * x1,
                v * v * v * y0 + 3 * v * v * u * y0 + 3 * v * u * u * y1 + u * u * u * y1]);
        }
    }
    // Onda que corre da esquerda para a direita: presa no início, solta a partir de ~80 px,
    // com um harmônico leve para parecer gelatina em vez de seno de livro.
    const x0 = base[0][0];
    const pts = samples.map(([px, py]) => {
        const d = px - x0;
        const env = Math.min(1, d / 80) ** 2;
        const k = 2 * Math.PI * d / WAVELENGTH;
        return [px, py + env * AMP * (Math.sin(phase - k) + 0.35 * Math.sin(2 * phase - 1.7 * k))];
    });
    const path = () => {
        cr.moveTo(...pts[0]);
        for (let i = 1; i < pts.length; i++)
            cr.lineTo(...pts[i]);
    };
    path();
    const last = pts.at(-1);
    cr.lineTo(last[0], y(0));
    cr.lineTo(pts[0][0], y(0));
    cr.closePath();
    cr.setSourceRGBA(...BLUE, 0.14);
    cr.fill();
    path();
    cr.setSourceRGB(...BLUE);
    cr.setLineWidth(2.5);
    cr.setLineJoin(1); // ROUND: sem bicos entre amostras
    cr.stroke();
    cr.arc(last[0], last[1], 4.5, 0, 2 * Math.PI);
    cr.fill();
    cr.setSourceRGB(0xde / 255, 0xe4 / 255, 0xea / 255);
    cr.setFontSize(11);
    const text = `Restante: ${Math.round(s.points.at(-1).remaining)}`;
    const tx = Math.min(last[0] + 8, W - PAD.r - cr.textExtents(text).width);
    cr.moveTo(tx, Math.max(PAD.t + 10, last[1] - 8));
    cr.showText(text);
}
