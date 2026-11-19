#!/usr/bin/env python3
"""Christmas night scene rendered in the terminal.

Every character cell is split into two pixels with the upper half block, so
the scene is drawn on a real framebuffer in 24-bit color: a rotating, shaded
3D tree, aurora, moon, parallax snow, a sleigh crossing the sky.

Usage: python3 natal.py [--fps N] [--seconds N] [--256]
Press Ctrl+C to exit.
"""
import math
import os
import random
import shutil
import sys
import time

TAU = math.tau
sin, cos, exp = math.sin, math.cos, math.exp

MAX_COLS, MAX_ROWS = 320, 96
TIERS = 5
GROW_TIME = 2.6          # seconds the tree takes to rise
STAR_TIME = 3.2          # moment the star ignites

BALL_COLORS = [(225, 30, 45), (45, 115, 245), (250, 190, 40), (225, 60, 205), (205, 215, 235)]
BULB_COLORS = [(255, 60, 60), (255, 200, 40), (60, 255, 120), (70, 160, 255), (255, 90, 220)]

FONT = {
    "F": ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
    "E": ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
    "L": ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
    "I": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
    "Z": ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
    "N": ["#...#", "##..#", "#.#.#", "#.#.#", "#..##", "#...#", "#...#"],
    "A": [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    "T": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
    " ": ["....."] * 7,
}
MESSAGE = "FELIZ NATAL"

DEER = [
    "....#.#..",
    ".....##..",
    ".....###.",
    "#######..",
    ".#####...",
]
DEER_LEGS = (
    [".#...#...", "#.....#.."],
    [".#...#...", "..#.#...."],
)
SLED = [
    ".........",
    "...rr....",
    "..rrrr...",
    "#.rrrr.#.",
    "########.",
    ".######..",
    "########.",
]
SLEIGH_W = 30


def lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


def rgb(c):
    return (
        max(0, min(255, int(c[0]))),
        max(0, min(255, int(c[1]))),
        max(0, min(255, int(c[2]))),
    )


class Scene:
    """Pixel scene of W x H. Static parts are baked once, the rest per frame."""

    def __init__(self, W, H, seed=25):
        self.W, self.H = W, H
        self.rng = rng = random.Random(seed)

        self.horizon = horizon = int(H * 0.74)
        self.cx = cx = W // 2
        self.base = base = min(H - 3, horizon + max(2, int(H * 0.06)))
        tree_h = int(H * 0.56)
        trunk_h = max(2, int(H * 0.035))
        self.top = top = base - tree_h
        self.fh = fh = tree_h - trunk_h
        self.rmax = rmax = min(fh * 0.44, W * 0.24)
        self.moon = (W * 0.80, H * 0.19, max(3.5, H * 0.075))

        self._bake_background(trunk_h)
        self._bake_tree()
        self._bake_decor()
        self._bake_presents()
        self._bake_text()
        self._init_particles()

    # ------------------------------------------------------------------ bake

    def radius(self, yf):
        f = (yf * TIERS * 0.999) % 1.0
        return self.rmax * (yf ** 0.85) * (0.60 + 0.40 * f) + 1.0

    def _bake_background(self, trunk_h):
        W, H, rng = self.W, self.H, self.rng
        horizon, cx, base, rmax = self.horizon, self.cx, self.base, self.rmax
        mcx, mcy, mr = self.moon

        ground = [horizon + int(round(1.5 * sin(x * 0.04 + 0.5) + sin(x * 0.09))) for x in range(W)]
        ridge1 = [
            min(horizon, int(horizon - H * (0.10 + 0.07 * sin(x * 0.021 + 1) + 0.04 * sin(x * 0.057 + 2.2)
                                            + 0.02 * sin(x * 0.13))))
            for x in range(W)
        ]
        ridge2 = [
            min(horizon, int(horizon - H * (0.035 + 0.025 * sin(x * 0.034 + 4) + 0.012 * sin(x * 0.11 + 1))))
            for x in range(W)
        ]
        self.sky_limit = ridge1
        craters = [(-0.30, -0.20, 0.25), (0.25, 0.30, 0.20), (0.10, -0.45, 0.15)]

        bg = [None] * (W * H)
        sky_cells = []
        for y in range(H):
            sky = lerp((3, 5, 18), (20, 26, 62), min(1.0, y / max(1, horizon)) ** 1.3)
            for x in range(W):
                i = y * W + x
                if y >= ground[x]:
                    depth = (y - ground[x]) / max(1, H - 1 - ground[x])
                    col = lerp((84, 100, 148), (176, 192, 228), depth)
                    n = rng.randint(-5, 5)
                    gx = (x - cx) / (rmax * 1.7)
                    gy = (y - base) / (H * 0.09)
                    g = exp(-(gx * gx + gy * gy))
                    bg[i] = rgb((col[0] + n + 70 * g, col[1] + n + 46 * g, col[2] + n + 8 * g))
                elif y >= ridge2[x]:
                    bg[i] = (12, 17, 38)
                elif y >= ridge1[x]:
                    cap = y - ridge1[x]
                    if cap < 2 + (x * 7 % 3):
                        bg[i] = (66, 80, 126)
                    else:
                        bg[i] = rgb(lerp((28, 36, 74), (19, 26, 54), min(1.0, cap / (H * 0.15))))
                else:
                    d = math.hypot(x - mcx, y - mcy)
                    if d <= mr:
                        shade = 1.0 - 0.25 * (d / mr) ** 2
                        for ox, oy, cr in craters:
                            if math.hypot(x - mcx - ox * mr, y - mcy - oy * mr) < cr * mr:
                                shade *= 0.82
                        bg[i] = rgb((238 * shade, 233 * shade, 206 * shade))
                    else:
                        g = exp(-(d - mr) / (mr * 0.9))
                        bg[i] = rgb((sky[0] + 46 * g, sky[1] + 48 * g, sky[2] + 58 * g))
                        if d > mr + 2 and y < H * 0.6:
                            sky_cells.append(i)

        # Distant pines along the horizon, keeping the main tree's spot clear.
        for _ in range(W // 9):
            px = rng.randrange(W)
            if abs(px - cx) < rmax * 1.35:
                continue
            ph = max(3, int(H * rng.uniform(0.05, 0.11)))
            bottom = ground[px] + 1
            for k in range(ph):
                y = bottom - ph + k
                tier = (k * 3.0 / ph) % 1.0
                half = (k / ph) * ph * 0.30 * (0.55 + 0.45 * tier) + 0.4
                x0, x1 = int(px - half), int(px + half)
                for x in range(x0, x1 + 1):
                    if 0 <= x < W and 0 <= y < H:
                        bg[y * W + x] = (52, 70, 94) if (x == x0 and tier > 0.7) else (7, 20, 20)

        # Trunk.
        tw = max(1, int(rmax * 0.09))
        for y in range(base - trunk_h - 1, base + 1):
            for x in range(cx - tw, cx + tw + 1):
                k = 1.0 - 0.45 * (x - cx + tw) / (2 * tw)
                bg[y * W + x] = rgb((84 * k, 52 * k, 26 * k))

        self.bg = bg
        n_stars = min(len(sky_cells), W * H // 110)
        self.stars = [
            (i, rng.uniform(0, TAU), rng.uniform(0.8, 3.5), rng.choice((40, 70, 110, 170)))
            for i in rng.sample(sky_cells, n_stars)
        ]

    def _bake_tree(self):
        """Foliage texture indexed by (row, angle) and the list of lit pixels."""
        W, rng, fh, top, cx = self.W, self.rng, self.fh, self.top, self.cx
        tex = []
        for row in range(fh):
            yf = (row + 0.5) / fh
            f = (yf * TIERS * 0.999) % 1.0
            tier = int(yf * TIERS * 0.999)
            line = []
            for a in range(256):
                th = a / 256 * TAU
                v = 0.78 + 0.14 * sin(th * 9 + row * 1.3) + 0.16 * rng.random()
                col = (18 * v, 122 * v, 50 * v)
                if f > 0.72 and sin(th * 5 + tier * 2.1) + sin(th * 11 + tier * 1.3) > 0.4:
                    col = (225, 235, 250)            # snow resting on the branch tips
                phase = (th + yf * TAU * 4) % TAU    # golden garland helix
                if phase < 0.40:
                    col = (255, 236, 150) if 0.13 < phase < 0.27 else (255, 196, 60)
                line.append(col)
            tex.append(line)
        self.tex = tex

        pixels = []
        for row in range(fh):
            yf = (row + 0.5) / fh
            f = (yf * TIERS * 0.999) % 1.0
            r = self.radius(yf)
            y = top + row
            for x in range(int(cx - r), int(cx + r) + 1):
                u = (x - cx) / r
                if abs(u) > 1.0 or not 0 <= x < W:
                    continue
                nz = math.sqrt(1.0 - u * u)
                light = max(0.0, -0.5 * u + 0.866 * nz)
                lam = (0.28 + 0.72 * light) * (0.5 + 0.5 * min(1.0, f * 3.5))
                pixels.append((y * W + x, int(math.asin(u) / TAU * 256), row, lam, yf))
        self.tree_px = pixels

    def _bake_decor(self):
        rng = self.rng
        self.balls = []
        for j in range(TIERS):
            count = j + 2
            off = rng.uniform(0, TAU)
            for k in range(count):
                self.balls.append((off + k * TAU / count, (j + 0.82) / TIERS,
                                   BALL_COLORS[(j + k) % len(BALL_COLORS)]))
        n = 56
        self.bulbs = []
        for k in range(n):
            yf = 0.06 + 0.92 * k / (n - 1)
            self.bulbs.append((-yf * TAU * 5, yf, k))
        self.ball_r2 = max(1.0, self.H / 70) ** 2 + 0.3

    def _bake_presents(self):
        W, H, cx, base, rmax = self.W, self.H, self.cx, self.base, self.rmax
        s = max(1, H // 45)
        specs = [
            (-0.55, 6, 4, (200, 30, 40), (250, 205, 80)),
            (-0.24, 4, 3, (40, 95, 215), (235, 240, 250)),
            (0.30, 5, 5, (30, 150, 75), (225, 40, 50)),
            (0.62, 4, 3, (150, 60, 200), (250, 205, 80)),
        ]
        overlay = []
        bottom = min(H - 1, base + 1)
        for off, w, h, col, ribbon in specs:
            w, h = w * s, h * s
            x0 = int(cx + off * rmax - w / 2)
            for dy in range(h):
                for dx in range(w):
                    x, y = x0 + dx, bottom - h + 1 + dy
                    if not (0 <= x < W and 0 <= y < H):
                        continue
                    c = col
                    if dy < s:
                        c = lerp(col, (255, 255, 255), 0.28)      # lid
                    if abs(dx - (w - 1) / 2) < s * 0.75 or s <= dy < 2 * s:
                        c = ribbon
                    if dx >= w - s:
                        c = lerp(c, (0, 0, 0), 0.25)              # shaded side
                    overlay.append((y * W + x, rgb(c)))
        self.presents = overlay

    def _bake_text(self):
        W, H = self.W, self.H
        self.text_px, self.text_shadow = [], []
        room = H - (self.base + 3)
        s = 2 if (W >= 150 and room >= 16) else 1
        width = len(MESSAGE) * 6 * s - s
        if room < 7 * s + 1 or width > W - 2:
            return
        x0 = (W - width) // 2
        y0 = H - 7 * s - s
        cells = set()
        for li, ch in enumerate(MESSAGE):
            for gy, line in enumerate(FONT[ch]):
                for gx, bit in enumerate(line):
                    if bit != "#":
                        continue
                    for sy in range(s):
                        for sx in range(s):
                            x, y = x0 + (li * 6 + gx) * s + sx, y0 + gy * s + sy
                            cells.add((x, y))
                            self.text_px.append((y * W + x, x, li))
        for x, y in cells:
            sx, sy = x + s, y + s
            if (sx, sy) not in cells and sx < W and sy < H:
                self.text_shadow.append(sy * W + sx)

    def _init_particles(self):
        W, H = self.W, self.H
        area = W * H
        spec = [
            (4.0, (120, 132, 165), 0.50, 0.6, area // 240),
            (8.0, (192, 202, 228), 0.75, 1.2, area // 380),
            (15.0, (255, 255, 255), 1.00, 2.2, area // 650),
        ]
        self.snow = [
            (speed, col, alpha, sway,
             [[random.uniform(0, W), random.uniform(0, H), random.uniform(0, TAU)] for _ in range(n)])
            for speed, col, alpha, sway, n in spec
        ]
        self.trail = []
        self.meteor = None
        self.next_meteor = 5.0

    # ---------------------------------------------------------------- render

    def render(self, t, dt):
        W, H = self.W, self.H
        buf = self.bg[:]
        size = W * H

        def add(i, r, g, b):
            p = buf[i]
            r += p[0]
            g += p[1]
            b += p[2]
            buf[i] = (r if r < 255 else 255, g if g < 255 else 255, b if b < 255 else 255)

        def glow(x, y, col, k):
            """Additive soft dot centered on (x, y)."""
            for dy in (-2, -1, 0, 1, 2):
                yy = y + dy
                if not 0 <= yy < H:
                    continue
                for dx in (-2, -1, 0, 1, 2):
                    xx = x + dx
                    d2 = dx * dx + dy * dy
                    if d2 > 5 or not 0 <= xx < W:
                        continue
                    w = k / (1.0 + d2 * 1.4)
                    add(yy * W + xx, int(col[0] * w), int(col[1] * w), int(col[2] * w))

        for i, ph, sp, br in self.stars:
            v = int(br * (0.55 + 0.45 * sin(t * sp + ph)))
            add(i, v, v, v)

        self._aurora(t, add)
        self._meteor(t, dt, add)
        self._sleigh(t, dt, buf, add, glow)

        wind = 2.0 + 5.0 * sin(t * 0.23)
        for layer in self.snow[:2]:
            self._snow_layer(layer, t, dt, wind, buf)

        self._tree(t, buf, glow)
        self._star(t, add)

        for i, col in self.presents:
            buf[i] = col
        self._text(t, buf)
        self._snow_layer(self.snow[2], t, dt, wind, buf)
        return buf

    def _aurora(self, t, add):
        W, H, limit = self.W, self.H, self.sky_limit
        base = H * 0.33
        for x in range(W):
            n = sin(x * 0.045 + t * 0.35) + 0.6 * sin(x * 0.11 - t * 0.5 + 1.3) + 0.4 * sin(x * 0.023 + t * 0.17)
            a = 0.5 + 0.3 * n
            if a <= 0.05:
                continue
            a *= 0.72 + 0.28 * sin(x * 0.9 + t * 1.6 + 3 * sin(x * 0.05 + t * 0.1))
            yb = int(base + H * 0.07 * sin(x * 0.03 + t * 0.2) + H * 0.04 * sin(x * 0.08 - t * 0.31))
            length = int(H * 0.26 * min(1.2, a)) + 2
            lim = limit[x]
            for k in range(length):
                y = yb - k
                if y < 0:
                    break
                if y >= lim:
                    continue
                q = k / length
                inten = a * (1 - q) ** 1.4 * min(1.0, k / 2 + 0.4) * 0.62
                add(y * W + x, int((30 + 150 * q * q) * inten), int((255 - 170 * q) * inten),
                    int((110 + 130 * q) * inten))

    def _meteor(self, t, dt, add):
        W, H = self.W, self.H
        if self.meteor is None and t > self.next_meteor:
            self.meteor = [random.uniform(0.1, 0.6) * W, random.uniform(0.03, 0.2) * H, 0.9]
            self.next_meteor = t + random.uniform(6, 14)
        m = self.meteor
        if m is None:
            return
        vx, vy = W * 0.5, H * 0.18
        m[0] += vx * dt
        m[1] += vy * dt
        m[2] -= dt
        if m[2] <= 0:
            self.meteor = None
            return
        fade = min(1.0, m[2] * 3)
        for k in range(15):
            x, y = int(m[0] - vx * k * 0.012), int(m[1] - vy * k * 0.012)
            if 0 <= x < W and 0 <= y < self.sky_limit[x]:
                v = int(255 * (1 - k / 15) * fade)
                add(y * W + x, v, v, v)

    def _sleigh(self, t, dt, buf, add, glow):
        W, H = self.W, self.H
        ts = (t - 6.0) % 22.0
        active = t > 6.0 and ts < 9.0
        if active:
            p = ts / 9.0
            x0 = int(-SLEIGH_W - 5 + p * (W + SLEIGH_W + 10))
            y0 = int(self.moon[1] - 4 - H * 0.03 * sin(p * TAU))
            legs = DEER_LEGS[int(t * 7) % 2]
            deer = DEER + legs
            dark = (6, 7, 14)

            def put(x, y, col):
                if 0 <= x < W and 0 <= y < H:
                    buf[y * W + x] = col

            for r, line in enumerate(SLED):
                for c, ch in enumerate(line):
                    if ch != ".":
                        put(x0 + c, y0 + r, (205, 28, 38) if ch == "r" else dark)
            for dx0 in (11, 21):
                for r, line in enumerate(deer):
                    for c, ch in enumerate(line):
                        if ch == "#":
                            put(x0 + dx0 + c, y0 + r, dark)
            for c in (8, 9, 10, 18, 19, 20):
                put(x0 + c, y0 + 3, dark)
            glow(x0 + 29, y0 + 2, (255, 40, 30), 0.9)     # the famous nose
            for _ in range(2):
                self.trail.append([x0 - 1 + random.uniform(-1, 1), y0 + 5 + random.uniform(-1, 1), 1.4])

        alive = []
        for s in self.trail:
            s[2] -= dt
            s[1] += 2.5 * dt
            if s[2] > 0:
                alive.append(s)
                x, y = int(s[0]), int(s[1])
                if 0 <= x < W and 0 <= y < H:
                    k = min(1.0, s[2])
                    add(y * W + x, int(255 * k), int(205 * k), int(90 * k))
        self.trail = alive

    def _snow_layer(self, layer, t, dt, wind, buf):
        W, H = self.W, self.H
        speed, col, alpha, sway, flakes = layer
        drift = wind * speed / 10.0
        for f in flakes:
            f[1] += speed * dt
            f[0] += (drift + sway * sin(t * 1.3 + f[2])) * dt
            if f[1] >= H:
                f[1] -= H
                f[0] = random.uniform(0, W)
            x, y = int(f[0]) % W, int(f[1])
            i = y * W + x
            p = buf[i]
            buf[i] = (int(p[0] + (col[0] - p[0]) * alpha), int(p[1] + (col[1] - p[1]) * alpha),
                      int(p[2] + (col[2] - p[2]) * alpha))

    def _tree(self, t, buf, glow):
        W, H, cx, top, fh = self.W, self.H, self.cx, self.top, self.fh
        rot = t * 0.6
        shift = int(rot / TAU * 256)
        cut = 1.0 - min(1.0, t / GROW_TIME)
        tex = self.tex
        for i, a0, row, lam, yf in self.tree_px:
            if yf < cut:
                continue
            c = tex[row][(a0 - shift) & 255]
            buf[i] = (int(c[0] * lam), int(c[1] * lam), int(c[2] * lam))

        r2 = self.ball_r2
        span = int(math.sqrt(r2))
        for n, (theta, yf, col) in enumerate(self.balls):
            if t < GROW_TIME + n * 0.06:
                continue
            phi = theta + rot
            c = cos(phi)
            if c <= 0.1:
                continue
            x = int(cx + self.radius(yf) * 0.93 * sin(phi))
            y = int(top + yf * fh)
            k = 0.55 + 0.45 * c
            for dy in range(-span, span + 1):
                for dx in range(-span, span + 1):
                    if dx * dx + dy * dy > r2:
                        continue
                    xx, yy = x + dx, y + dy
                    if not (0 <= xx < W and 0 <= yy < H):
                        continue
                    shade = k * (1.25 if (dx < 0 and dy < 0) else 0.75 if (dx > 0 or dy > 0) else 1.0)
                    buf[yy * W + xx] = rgb((col[0] * shade, col[1] * shade, col[2] * shade))
            if 0 <= x - 1 < W and 0 <= y - 1 < H and span >= 1:
                buf[(y - 1) * W + x - 1] = rgb(lerp(col, (255, 255, 255), 0.7))  # specular

        step = int(t * 2)
        for theta, yf, k in self.bulbs:
            if t < GROW_TIME + 0.4 + k * 0.03:
                continue
            phi = theta + rot
            c = cos(phi)
            if c <= 0.05:
                continue
            x = int(cx + self.radius(yf) * 0.95 * sin(phi))
            y = int(top + yf * fh)
            col = BULB_COLORS[(k + step) % len(BULB_COLORS)]
            twinkle = 0.55 + 0.45 * sin(t * 3.1 + k * 1.7)
            glow(x, y, col, 0.75 * twinkle * (0.4 + 0.6 * c))
            if 0 <= x < W and 0 <= y < H:
                buf[y * W + x] = rgb(lerp(col, (255, 255, 255), 0.55 * twinkle))

    def _star(self, t, add):
        if t < STAR_TIME:
            return
        W, H = self.W, self.H
        sx, sy = self.cx, self.top - 1
        flash = exp(-(t - STAR_TIME) * 1.5)
        R = H * 0.085 * (0.85 + 0.15 * sin(t * 3)) * (1 + 1.6 * flash)
        span = int(R) + 1
        spin = t * 0.6
        for dy in range(-span, span + 1):
            y = sy + dy
            if not 0 <= y < H:
                continue
            for dx in range(-span, span + 1):
                x = sx + dx
                d = math.hypot(dx, dy)
                if d > R or not 0 <= x < W:
                    continue
                ray = abs(cos(2 * (math.atan2(dy, dx) - spin))) ** 8
                k = (1 - d / R) ** 2 * (0.35 + 0.65 * ray) * (1 + 2 * flash)
                add(y * W + x, int(255 * k), int(222 * k), int(120 * k))
        for dx, dy, col in ((0, 0, (255, 255, 230)), (1, 0, (255, 236, 140)), (-1, 0, (255, 236, 140)),
                            (0, 1, (255, 236, 140)), (0, -1, (255, 236, 140)), (0, -2, (255, 212, 90)),
                            (2, 0, (255, 212, 90)), (-2, 0, (255, 212, 90))):
            x, y = sx + dx, sy + dy
            if 0 <= x < W and 0 <= y < H:
                add(y * W + x, *col)

    def _text(self, t, buf):
        if t < 4.0 or not self.text_px:
            return
        if t > 4.0 + len(MESSAGE) * 0.12 + 0.4:
            for i in self.text_shadow:
                p = buf[i]
                buf[i] = (int(p[0] * 0.45), int(p[1] * 0.45), int(p[2] * 0.5))
        for i, x, li in self.text_px:
            al = (t - 4.0 - li * 0.12) * 2.5
            if al <= 0:
                continue
            al = min(1.0, al)
            k = 0.5 + 0.5 * sin(x * 0.09 - t * 2.5)
            col = (255, 255, 255) if k > 0.97 else lerp((215, 25, 45), (255, 214, 90), k)
            p = buf[i]
            buf[i] = (int(p[0] + (col[0] - p[0]) * al), int(p[1] + (col[1] - p[1]) * al),
                      int(p[2] + (col[2] - p[2]) * al))


def encode(buf, W, rows, ox=1, oy=1, truecolor=True):
    """Turn the pixel buffer into escape sequences, two pixels per cell."""
    if truecolor:
        def fg(c):
            return "\033[38;2;%d;%d;%dm" % c

        def bg(c):
            return "\033[48;2;%d;%d;%dm" % c
    else:
        def cube(c):
            return 16 + 36 * ((c[0] * 5 + 127) // 255) + 6 * ((c[1] * 5 + 127) // 255) + (c[2] * 5 + 127) // 255

        def fg(c):
            return "\033[38;5;%dm" % cube(c)

        def bg(c):
            return "\033[48;5;%dm" % cube(c)

    out = []
    last_fg = last_bg = None
    for row in range(rows):
        out.append("\033[%d;%dH" % (oy + row, ox))
        ti = row * 2 * W
        bi = ti + W
        for x in range(W):
            a, b = buf[ti + x], buf[bi + x]
            if b != last_bg:
                out.append(bg(b))
                last_bg = b
            if a == b:
                out.append(" ")
            else:
                if a != last_fg:
                    out.append(fg(a))
                    last_fg = a
                out.append("▀")
    out.append("\033[0m")
    return "".join(out)


def main():
    argv = sys.argv[1:]

    def option(name, default):
        return float(argv[argv.index(name) + 1]) if name in argv else default

    fps = option("--fps", 20)
    seconds = option("--seconds", 0)
    truecolor = "--256" not in argv and os.environ.get("COLORTERM", "") in ("truecolor", "24bit")
    if "--truecolor" in argv:
        truecolor = True

    if not sys.stdout.isatty():
        print("Rode direto num terminal: python3 natal.py")
        return 1

    write = sys.stdout.buffer.write
    write(b"\033[?1049h\033[?25l\033[2J")   # alternate screen, hide cursor
    start = last = time.monotonic()
    size = scene = None
    cols = rows = ox = oy = 0
    try:
        while True:
            term = shutil.get_terminal_size()
            if (term.columns, term.lines) != size:
                size = (term.columns, term.lines)
                cols, rows = min(term.columns, MAX_COLS), min(term.lines, MAX_ROWS)
                ox, oy = (term.columns - cols) // 2 + 1, (term.lines - rows) // 2 + 1
                write(b"\033[0m\033[2J")
                scene = Scene(cols, rows * 2) if (cols >= 50 and rows >= 18) else None
            now = time.monotonic()
            t, dt, last = now - start, min(0.2, now - last), now
            if seconds and t >= seconds:
                break
            if scene is None:
                write("\033[1;1HAumente o terminal (mínimo 50x18).".encode())
            else:
                write(encode(scene.render(t, dt), cols, rows, ox, oy, truecolor).encode())
            sys.stdout.buffer.flush()
            time.sleep(max(0.0, 1.0 / fps - (time.monotonic() - now)))
    except KeyboardInterrupt:
        pass
    finally:
        write(b"\033[0m\033[?25h\033[?1049l")   # restore the terminal
        sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
