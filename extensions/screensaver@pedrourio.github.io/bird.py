#!/usr/bin/env python3
"""Uma andorinha chega segurando o logo.txt pelas patas, larga no centro da tela e vai embora."""
import math
import os
import random
import shutil
import sys
import time

HERE = os.path.dirname(os.path.realpath(__file__))
FPS = 30

# A ave é desenhada por geometria, um quadro por fase da batida: corpo em elipse inclinada, cabeça,
# bico, cauda em forquilha, patas com garras e a asa como 5 penas em leque saindo do ombro.
# Letras: T cauda, W asa escura, w asa clara, b costas, l barriga, k bico, e olho, f patas.
FLAP_FRAMES = 8


SIZE_W, SIZE_H = 44, 28  # pixels; no terminal, 44 colunas × 14 linhas

def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy or 1)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy), t

def stroke(px, py, a, b, w0, w1):
    d, t = seg_dist(px, py, *a, *b)
    return d <= (w0 + (w1 - w0) * t) / 2

def frame(phase):
    bob = -math.sin(2 * math.pi * phase) * 0.9  # sobe quando a asa desce
    g = [['.'] * SIZE_W for _ in range(SIZE_H)]
    tilt = math.radians(-10)
    cx, cy = 23, 15 + bob
    hx, hy = 32.5, 11.2 + bob
    sx, sy = 25, 12.2 + bob  # ombro
    flap = math.radians(85) * math.cos(2 * math.pi * phase)  # + em cima, - embaixo
    for y in range(SIZE_H):
        for x in range(SIZE_W):
            px, py = x + 0.5, y + 0.5
            ch = '.'
            # cauda: duas pontas curtas, finas
            if stroke(px, py, (15, 15.5 + bob), (7.5, 12 + bob), 2.2, 0.6) or stroke(px, py, (15, 16 + bob), (8, 19.5 + bob), 2.2, 0.6):
                ch = 'T'
            # corpo: elipse inclinada; costas em cima, barriga embaixo
            u = (px - cx) * math.cos(tilt) + (py - cy) * math.sin(tilt)
            v = -(px - cx) * math.sin(tilt) + (py - cy) * math.cos(tilt)
            if (u / 10) ** 2 + (v / 4.3) ** 2 <= 1:
                ch = 'l' if v > 0.6 else 'b'
            # pescoço e cabeça
            if math.hypot(px - hx, py - hy) <= 3.7 or stroke(px, py, (cx + 5, cy - 1), (hx, hy), 6, 6):
                ch = 'b' if py < hy + 1.8 else 'l'
            if stroke(px, py, (hx + 2.8, hy - 0.1), (hx + 6.2, hy + 0.7), 2.2, 0.9):
                ch = 'k'
            if math.hypot(px - (hx + 1.4), py - (hy - 0.9)) <= 0.75:
                ch = 'e'
            # patas recolhidas segurando: duas pernas e garras
            for lx in (22, 25.5):
                if stroke(px, py, (lx, cy + 3), (lx - 0.5, cy + 6.2), 1.1, 1.1):
                    ch = 'f'
                if stroke(px, py, (lx - 1.6, cy + 6.6), (lx + 1, cy + 6.6), 1, 1):
                    ch = 'f'
            # asa: 5 penas em leque saindo do ombro, girando com a batida
            for i, (ln, wd) in enumerate([(6.5, 4.2), (9, 3.6), (11.5, 3), (13, 2.4), (12.5, 2)]):
                # leque: penas de fora mais varridas para trás
                ang = math.pi - flap * (0.95 - 0.08 * i) + math.radians(4 * i) * (1 if flap >= 0 else -1)
                bx, by = sx + ln * math.cos(ang), sy - ln * math.sin(ang) * 1.0
                if stroke(px, py, (sx, sy), (bx, by), wd + 1.2, wd * 0.55):
                    d, t = seg_dist(px, py, sx, sy, bx, by)
                    ch = 'W' if i >= 3 or t > 0.8 else 'w'
            g[y][x] = ch
    return [''.join(r) for r in g]


BIRD = [frame(i / FLAP_FRAMES) for i in range(FLAP_FRAMES)]
GRIP_X = 24  # entre as duas patas


def grip_row(art):
    """Célula das garras (última linha com f); muda com o balanço do corpo."""
    return max(r for r, line in enumerate(art) if 'f' in line) // 2


# paletas sorteadas a cada voo; o logo usa as cores da asa (W → w)
PALETTES = [
    {'W': (40, 90, 200), 'w': (110, 165, 255), 'b': (30, 60, 140)},    # azul
    {'W': (31, 132, 90), 'w': (126, 226, 184), 'b': (22, 80, 56)},     # verde
    {'W': (110, 93, 198), 'w': (184, 172, 246), 'b': (60, 48, 120)},   # violeta
    {'W': (194, 72, 52), 'w': (253, 162, 120), 'b': (120, 40, 30)},    # pôr do sol
]
FIXED = {'l': (235, 238, 242), 'k': (255, 166, 77), 'e': (16, 18, 20), 'f': (255, 140, 60)}


def ease_out(t):
    return 1 - (1 - t) ** 3


def ease_in(t):
    return t * t * t


def mix(a, b, k):
    return tuple(round(a[i] + (b[i] - a[i]) * k) for i in range(3))


class Frame:
    def __init__(self, cols, rows):
        self.cols, self.rows = cols, rows
        self.cells = {}

    def put(self, x, y, ch, fg, bg=None):
        x, y = round(x), round(y)
        if 0 <= x < self.cols and 0 <= y < self.rows:
            self.cells[y, x] = (ch, fg, bg)

    def render(self):
        out = ['\x1b[H']
        for y in range(self.rows):
            last = None
            for x in range(self.cols):
                ch, fg, bg = self.cells.get((y, x), (' ', None, None))
                if (fg, bg) != last:
                    out.append('\x1b[0m')
                    if fg:
                        out.append('\x1b[38;2;%d;%d;%dm' % fg)
                    if bg:
                        out.append('\x1b[48;2;%d;%d;%dm' % bg)
                    last = (fg, bg)
                out.append(ch)
            out.append('\x1b[0m' + ('\r\n' if y < self.rows - 1 else ''))
        return ''.join(out)


def draw_logo(f, logo, lx, ly, colors):
    width = max(map(len, logo))
    for r, line in enumerate(logo):
        for c, ch in enumerate(line):
            if ch != ' ':
                f.put(lx + c, ly + r, ch, mix(colors['W'], colors['w'], c / max(1, width - 1)))


def draw_bird(f, wing, gx, gy, colors):
    """gx, gy = célula das garras na tela."""
    art = BIRD[wing]
    x0, y0 = round(gx) - GRIP_X, round(gy) - grip_row(art)
    for r in range(0, len(art), 2):
        for c in range(len(art[r])):
            hi, lo = colors.get(art[r][c]), colors.get(art[r + 1][c])
            if hi or lo:
                f.put(x0 + c, y0 + r // 2, '▀' if hi else '▄', hi or lo, lo if hi else None)


def grip_column(logo):
    """Meio do bloco da primeira linha do logo mais perto do centro (no </>, o topo da barra)."""
    top, mid = logo[0], max(map(len, logo)) / 2
    blocks, c = [], 0
    while c < len(top):
        if top[c] != ' ':
            s = c
            while c < len(top) and top[c] != ' ':
                c += 1
            blocks.append((s + c - 1) / 2)
        c += 1
    return round(min(blocks, key=lambda b: abs(b - mid))) if blocks else int(mid)


def main():
    logo = open(os.path.join(HERE, 'logo.txt')).read().rstrip('\n').split('\n')
    colors = {**random.choice(PALETTES), **FIXED}
    colors['T'] = colors['W']
    lw, lh = max(map(len, logo)), len(logo)
    grip = grip_column(logo)
    arrive, hover, leave, rest = 3.5, 1.0, 2.0, 4.0
    sys.stdout.write('\x1b[?25l\x1b[2J')
    start = time.monotonic()
    while (t := time.monotonic() - start) < arrive + hover + leave + rest:
        cols, rows = shutil.get_terminal_size()
        f = Frame(cols, rows)
        lx, ly = (cols - lw) // 2, (rows - lh) // 2 + 2  # pouso: um pouco abaixo do centro
        if t < arrive:
            k = ease_out(t / arrive)
            x = -lw - 10 + (lx + lw + 10) * k
            y = ly - 4 + 4 * k + math.sin(t * 5) * (1 - k) * 1.5
            draw_logo(f, logo, x, y, colors)
            draw_bird(f, int(t * 16) % FLAP_FRAMES, x + grip, y - 1, colors)
        else:
            draw_logo(f, logo, lx, ly, colors)
            u = t - arrive
            if u < hover:
                # pousa o logo e solta as patas: sobe uma célula na segunda metade
                draw_bird(f, int(t * 16) % FLAP_FRAMES, lx + grip, ly - 1 - (u > hover / 2), colors)
            elif u < hover + leave:
                k = ease_in((u - hover) / leave)
                gx, gy = lx + grip, ly - 2
                draw_bird(f, int(t * 28) % FLAP_FRAMES, gx + (cols - gx + 40) * k, gy - (gy + 10) * k, colors)
        sys.stdout.write(f.render())
        sys.stdout.flush()
        time.sleep(1 / FPS)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
