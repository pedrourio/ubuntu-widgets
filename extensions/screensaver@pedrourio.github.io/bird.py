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

# pixel art em meio-bloco (2 pixels por célula): T cauda, W asa escura, w asa clara, b costas,
# l barriga, k bico, e olho, f patas. A última linha com f são as garras, que seguram o logo.
UP = """
............W.................
...........WWw................
...........WWww...............
............WWww..............
............WWwww.............
.............WWwww............
.............WWwwww...bbb.....
..............WWwww..bbbbbb...
T.............bbbwwbbbbbbebk..
.TT......bbbbbbbbbbbbbbbbbbkkk
...TTTbbbbbbbbbbllllllllbbb...
.TT.....llllllllllllllll......
T...........llllllllll........
...............f..f...........
..............ff..ff..........
.............................."""
MID = """
..............................
..............................
..............................
..............................
..............................
..............................
......................bbb.....
.....................bbbbbb...
T......WWWWWWWWWWWbbbbbbbebk..
.TT..wwwwwwwwwwwbbbbbbbbbbbkkk
...TTTbwwwwwwwbbllllllllbbb...
.TT.....llllllllllllllll......
T...........llllllllll........
...............f..f...........
..............ff..ff..........
.............................."""
DOWN = """
..............................
..............................
..............................
..............................
..............................
..............................
......................bbb.....
.....................bbbbbb...
T.............bbbbbbbbbbbebk..
.TT......bbbbbbbbbbbbbbbbbbkkk
...TTTbbbbbbbbbbllllllllbbb...
.TT.....llllllWWwwllllll......
T...........WWWwwwlll.........
...........WWwww.f..f.........
..........WWww..ff..ff........
.........WWw.................."""
BIRD = [m.strip('\n').split('\n') for m in (UP, MID, DOWN, MID)]
GRIP_X = 17  # entre as duas patas
GRIP_ROW = max(r for r, line in enumerate(BIRD[0]) if 'f' in line) // 2  # célula das garras

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
    x0, y0 = round(gx) - GRIP_X, round(gy) - GRIP_ROW
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
            draw_bird(f, int(t * 8) % 4, x + grip, y - 1, colors)
        else:
            draw_logo(f, logo, lx, ly, colors)
            u = t - arrive
            if u < hover:
                # pousa o logo e solta as patas: sobe uma célula na segunda metade
                draw_bird(f, int(t * 8) % 4, lx + grip, ly - 1 - (u > hover / 2), colors)
            elif u < hover + leave:
                k = ease_in((u - hover) / leave)
                gx, gy = lx + grip, ly - 2
                draw_bird(f, int(t * 14) % 4, gx + (cols - gx + 40) * k, gy - (gy + 10) * k, colors)
        sys.stdout.write(f.render())
        sys.stdout.flush()
        time.sleep(1 / FPS)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
