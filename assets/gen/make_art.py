#!/usr/bin/env python3
"""加算十字（Kakuro）的美术资产工厂：一条命令重画出全套位图，产出真实可读的 PNG。

视觉母题取自玩法本身：黑格被一条左上→右下的对角线劈成两半，**右上**写它下面那一竖串的和、
**右下**写它右边那一横串的和（见 README 规则原文与 js/render/board.js 的 drawBlack）。图标、
社交卡、页面纹理、HUD 图标蒙版全都从这一个母题长出来，不复用任何外部素材，也不手抄别人风格。

颜色抄自 css/game.css 的 `:root`（--paper #f5f1e8 / --grid-strong #4a4437 / --selected
#ffe9a8 / --ink #12161d / --hint #7b61ff / --danger #c0392b / --accent #1f6feb）。位图一旦落盘
就冻结了这些取值，所以改了 CSS 要重跑本脚本：`--verify` 会把盘上每个 PNG 的 sha1 与
gen/manifest.json 对一遍，不一致就说明"资产和代码分家了"。

    python3 assets/gen/make_art.py            # 重画全套并写 manifest.json
    python3 assets/gen/make_art.py --verify   # 只校验，不写盘

全程只用固定种子（random.Random(20260928)）与 PIL 的确定性绘制 ⇒ 同一台机器重跑 sha1 相同。
"""
import argparse
import hashlib
import json
import math
import os
import random
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUT_ROOT = os.path.join(REPO, 'assets')
MASTER = 1024

PAL = {
    'ink': (18, 22, 29),
    'paper': (245, 241, 232),
    'paper_hi': (251, 248, 241),
    'paper_lo': (236, 230, 217),
    'tile': (255, 255, 255),
    'tile_alt': (240, 236, 225),
    'grid': (201, 194, 178),
    'clue': (74, 68, 55),          # --grid-strong：黑格
    'clue_hi': (94, 86, 69),
    'clue_lo': (56, 51, 41),
    'selected': (255, 233, 168),   # --selected：选中格的琥珀黄
    'accent': (31, 111, 235),      # --accent
    'hint': (123, 97, 255),        # --hint
    'danger': (192, 57, 43),       # --danger
    'dim': (139, 133, 120),        # --dim
    'note': (125, 135, 148),       # --note
}

MONO_CANDIDATES = [
    ('/System/Library/Fonts/SFNSMono.ttf', 0),
    ('/System/Library/Fonts/Menlo.ttc', 0),
    ('/System/Library/Fonts/Monaco.ttf', 0),
    ('/Library/Fonts/SFNSMono.ttf', 0),
    ('/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf', 0),
]
CJK_CANDIDATES = [
    ('/System/Library/Fonts/STHeiti Medium.ttc', 0),
    ('/System/Library/Fonts/Hiragino Sans GB.ttc', 0),
    ('/System/Library/Fonts/PingFang.ttc', 0),
    ('/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', 0),
]

SEED = 20260928


def hexof(name):
    return '#%02x%02x%02x' % PAL[name]


def load_font(candidates, px):
    for path, idx in candidates:
        if not os.path.exists(path):
            continue
        try:
            return ImageFont.truetype(path, px, index=idx)
        except OSError:
            continue
    raise SystemExit('找不到可用的字体，请把 MONO_CANDIDATES/CJK_CANDIDATES 里任意一个装回来')


def text(draw, xy, s, font, fill, anchor='ld', stroke=0, stroke_fill=None):
    draw.text(xy, s, font=font, fill=fill, anchor=anchor, stroke_width=stroke, stroke_fill=stroke_fill)


def measure(font, s):
    l, t, r, b = font.getbbox(s)
    return r - l, b - t


# ---------- 母题：一张黑格 ----------

def clue_cell(img, box, dn=None, ac=None, tone='dark', split_alpha=76):
    """在 img 的 box（x0,y0,x1,y1，单位与 img 同尺度）里画一个 Kakuro 黑格。

    画法和 js/render/board.js 的 drawBlack 对齐：对角线左上→右下，纵和靠右上、横和靠右下，
    两个数都右对齐 —— 所以"这一竖串的和"和"这一横串的和"各待在自己该在的三角形里。
    """
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = box
    w = x1 - x0
    h = y1 - y0
    if tone == 'dark':
        top, bottom = PAL['clue_hi'], PAL['clue_lo']
        num_c, num_a = PAL['paper'], PAL['selected']
    else:
        top, bottom = PAL['paper_hi'], PAL['paper_lo']
        num_c, num_a = PAL['clue'], PAL['danger']
    # 竖向微渐变：纯色在小尺寸下发死
    for i in range(int(h)):
        t = i / max(1, h - 1)
        c = tuple(int(top[k] * (1 - t) + bottom[k] * t) for k in range(3))
        d.line([(x0, y0 + i), (x1, y0 + i)], fill=c)
    # 对角分割线
    lw = max(1.0, w * 0.018)
    pad = w * 0.055
    d.line([(x0 + pad, y0 + pad), (x1 - pad, y1 - pad)],
           fill=num_c + (split_alpha,), width=int(round(lw)))
    # 两个和：字号取格径的 0.30（CSS/画布那侧是 Cell.clueRatio = 0.31）
    fs = max(6, int(round(w * 0.30)))
    font = load_font(MONO_CANDIDATES, fs)
    right = x1 - w * 0.075
    if dn:
        text(d, (right, y0 + h * 0.285), str(dn), font, num_c + (255,), anchor='rm')
    if ac:
        text(d, (right, y0 + h * 0.755), str(ac), font, num_a + (255,), anchor='rm')
    return img


def grain(img, amount=5, seed=SEED, low=64):
    """低频颗粒：给纸面和黑格一点"印在纸上"的味道，不引入新的色相。

    噪声先在低分辨率上取随机值再双线性放大（所以它是"纸纤维"级别的低频，不是椒盐），
    最后用 ImageChops.add 做有符号叠加：add(im, N, 1, -128) 就是 im + (N-128)。
    """
    rnd = random.Random(seed)
    n = Image.new('L', (low, low))
    n.putdata([rnd.randrange(256) for _ in range(low * low)])
    n = n.resize(img.size, Image.BILINEAR)
    n = n.point(lambda v: max(0, min(255, 128 + int((v - 128) * amount / 128.0))))
    if img.mode != 'RGBA':
        return ImageChops.add(img.convert('RGB'), n.convert('RGB'), 1.0, -128)
    r, g, b, a = img.split()
    nr, ng, nb = n.convert('RGB').split()
    return Image.merge('RGBA', (
        ImageChops.add(r, nr, 1.0, -128),
        ImageChops.add(g, ng, 1.0, -128),
        ImageChops.add(b, nb, 1.0, -128),
        a,
    ))


def rounded_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def tile(img, box, digit, tone='tile', lw=1, line_col=None):
    """白格 / 选中格：数字居中，字号取格径的 0.6（= js/theme.js 的 Cell.digitRatio）。"""
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = box
    bg = {'tile': PAL['tile'], 'alt': PAL['tile_alt'], 'sel': PAL['selected']}[tone]
    d.rectangle([x0, y0, x1, y1], fill=bg + (255,))
    if digit is not None:
        f = load_font(MONO_CANDIDATES, max(6, int((x1 - x0) * 0.6)))
        text(d, ((x0 + x1) / 2, (y0 + y1) / 2 + (y1 - y0) * 0.02), str(digit), f,
             PAL['ink'] + (255,), anchor='mm')
    if line_col:
        d.rectangle([x0, y0, x1, y1], outline=line_col + (255,), width=lw)
    return img


def master_icon(bleed=False):
    """1024 母图：一块 2×2 的加算十字小盘坐在纸上。

    黑格 12↓/16→、白格 3 与 7、右下角那格 9 同时属于两条 run —— 3+9=12、7+9=16，
    图标本身就是一道自洽的题，不是随便摆的装饰。bleed=True 给 iOS / maskable：满幅方图，
    盘面缩到 62% 留安全区（系统会再切一次圆角/遮罩）。
    """
    s = MASTER
    img = Image.new('RGBA', (s, s), PAL['paper'] + (255,))
    d = ImageDraw.Draw(img)
    for i in range(s):
        t = i / (s - 1)
        c = tuple(int(PAL['paper_hi'][k] * (1 - t) + PAL['paper_lo'][k] * t) for k in range(3))
        d.line([(0, i), (s, i)], fill=c + (255,))
    img = grain(img, amount=3, seed=SEED, low=96)
    d = ImageDraw.Draw(img)

    side = s * (0.62 if bleed else 0.70)
    x0 = (s - side) / 2
    y0 = (s - side) / 2
    cell = side / 2
    lw = max(2, int(s * 0.008))
    # 盘面投影：只压一层很淡的落纸阴影，不再画暗角
    sh = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rectangle([x0 + lw, y0 + lw * 3, x0 + side + lw, y0 + side + lw * 3],
                                 fill=(58, 51, 41, 90))
    img = Image.alpha_composite(img, sh.filter(ImageFilter.GaussianBlur(s * 0.008)))
    d = ImageDraw.Draw(img)

    d.rectangle([x0 - lw, y0 - lw, x0 + side + lw, y0 + side + lw], fill=PAL['clue'] + (255,))
    clue = Image.new('RGBA', (int(cell), int(cell)), (0, 0, 0, 0))
    clue_cell(clue, (0, 0, cell, cell), dn=12, ac=16, split_alpha=88)
    img.paste(clue, (int(x0), int(y0)), clue)
    d = ImageDraw.Draw(img)
    tile(img, (x0 + cell, y0, x0 + side, y0 + cell), 3, 'tile')
    tile(img, (x0, y0 + cell, x0 + cell, y0 + side), 7, 'alt')
    tile(img, (x0 + cell, y0 + cell, x0 + side, y0 + side), 9, 'sel')
    hair = max(1, int(s * 0.0035))
    d.line([(x0 + cell, y0 + cell), (x0 + side, y0 + cell)], fill=PAL['grid'] + (255,), width=hair)
    d.line([(x0 + cell, y0 + cell), (x0 + cell, y0 + side)], fill=PAL['grid'] + (255,), width=hair)
    if not bleed:
        img.putalpha(rounded_mask(s, int(s * 0.225)))
    return img


# ---------- 纸面纹理（页面底纹，CSS 平铺） ----------

def periodic_noise(side, lattice, rnd):
    """格点上取随机值、按周期双线性插值 —— 平铺接缝不存在。"""
    grid = [[rnd.randrange(256) for _ in range(lattice)] for _ in range(lattice)]
    out = []
    step = lattice / side
    for y in range(side):
        gy = y * step
        j0 = int(gy) % lattice
        j1 = (j0 + 1) % lattice
        fy = gy - int(gy)
        row = []
        for x in range(side):
            gx = x * step
            i0 = int(gx) % lattice
            i1 = (i0 + 1) % lattice
            fx = gx - int(gx)
            a = grid[j0][i0] * (1 - fx) + grid[j0][i1] * fx
            b = grid[j1][i0] * (1 - fx) + grid[j1][i1] * fx
            row.append(a * (1 - fy) + b * fy)
        out.append(row)
    return out


def paper_tile(side=256):
    rnd = random.Random(SEED + 7)
    n1 = periodic_noise(side, 32, rnd)
    n2 = periodic_noise(side, 128, rnd)
    img = Image.new('RGBA', (side, side), PAL['paper'] + (0,))
    px = img.load()
    for y in range(side):
        for x in range(side):
            v = (n1[y][x] - 128) * 0.7 + (n2[y][x] - 128) * 0.3
            a = int(max(0, min(255, 6 + v * 0.055)))
            c = 70 + int(v * 0.5)
            px[x, y] = (c, c - 6, c - 16, a)
    # 纸纤维：几道几乎看不见的横纹（同样按周期闭合）
    d = ImageDraw.Draw(img, 'RGBA')
    for k in range(6):
        y = int(side * (0.08 + 0.15 * k))
        d.line([(0, y), (side, y)], fill=(90, 82, 66, 6), width=1)
    return img.quantize(colors=32, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)


# ---------- 胜利印章 ----------

def solved_stamp(side=256):
    img = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = cy = side / 2
    r = side * 0.44
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=PAL['danger'] + (255,), width=int(side * 0.035))
    r2 = r - side * 0.075
    d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], outline=PAL['danger'] + (150,), width=int(side * 0.012))
    f1 = load_font(MONO_CANDIDATES, int(side * 0.20))
    f2 = load_font(MONO_CANDIDATES, int(side * 0.085))
    text(d, (cx, cy - side * 0.055), '16', f1, PAL['danger'] + (255,), anchor='mm')
    text(d, (cx, cy + side * 0.035), '23', f1, PAL['danger'] + (255,), anchor='mm')
    text(d, (cx, cy + side * 0.175), 'ALL RUNS OK', f2, PAL['danger'] + (200,), anchor='mm')
    # 缺口的墨迹：让印章像盖上去的
    rnd = random.Random(SEED + 3)
    for _ in range(220):
        a = rnd.random() * 6.2832
        rr = r * (0.55 + rnd.random() * 0.5)
        x, y = cx + rr * math.cos(a), cy + rr * math.sin(a)
        s = rnd.randrange(1, 4)
        d.rectangle([x, y, x + s, y + s], fill=(0, 0, 0, 0))
    return img.rotate(-11, expand=True, resample=Image.BICUBIC)


# ---------- HUD 图标蒙版（CSS mask 用，颜色由 CSS 出） ----------

def ui_glyph(kind, side=48):
    img = Image.new('L', (side, side), 0)
    d = ImageDraw.Draw(img)
    m = side * 0.12
    w = max(2, int(side * 0.075))
    if kind in ('sound-on', 'sound-off'):
        d.polygon([(m, side * 0.36), (side * 0.34, side * 0.36), (side * 0.52, side * 0.2),
                   (side * 0.52, side * 0.8), (side * 0.34, side * 0.64), (m, side * 0.64)], fill=255)
        if kind == 'sound-on':
            cx = side * 0.62
            for rr, ww in ((side * 0.16, w), (side * 0.28, int(w * 0.85))):
                d.arc([cx - rr, side * 0.5 - rr, cx + rr, side * 0.5 + rr], -58, 58, fill=255, width=ww)
        else:
            d.line([(side * 0.66, side * 0.33), (side * 0.9, side * 0.67)], fill=255, width=w)
            d.line([(side * 0.66, side * 0.67), (side * 0.9, side * 0.33)], fill=255, width=w)
    elif kind == 'pause':
        for cx in (side * 0.36, side * 0.64):
            d.rounded_rectangle([cx - side * 0.09, m, cx + side * 0.09, side - m], radius=side * 0.05, fill=255)
    elif kind == 'play':
        d.polygon([(side * 0.28, m), (side * 0.28, side - m), (side * 0.82, side * 0.5)], fill=255)
    elif kind == 'replay':
        rr = side * 0.3
        d.arc([side * 0.5 - rr, side * 0.5 - rr, side * 0.5 + rr, side * 0.5 + rr], -55, 205, fill=255, width=w)
        ax, ay = side * 0.5 + rr * math.cos(math.radians(-55)), side * 0.5 + rr * math.sin(math.radians(-55))
        d.polygon([(ax, ay), (ax - side * 0.2, ay - side * 0.05), (ax - side * 0.05, ay + side * 0.17)], fill=255)
    elif kind == 'fullscreen':
        L = side * 0.3
        for (x, y, sx, sy) in ((m, m, 1, 1), (side - m, m, -1, 1), (m, side - m, 1, -1), (side - m, side - m, -1, -1)):
            d.line([(x, y), (x + sx * L, y)], fill=255, width=w)
            d.line([(x, y), (x, y + sy * L)], fill=255, width=w)
    elif kind == 'pencil':
        d.line([(side * 0.22, side * 0.78), (side * 0.74, side * 0.26)], fill=255, width=int(side * 0.16))
        d.polygon([(side * 0.14, side * 0.86), (side * 0.22, side * 0.68), (side * 0.4, side * 0.86)], fill=255)
        d.line([(side * 0.78, side * 0.22), (side * 0.88, side * 0.12)], fill=255, width=int(side * 0.09))
    elif kind == 'hint':
        d.ellipse([side * 0.2, side * 0.14, side * 0.8, side * 0.74], outline=255, width=w)
        d.rounded_rectangle([side * 0.4, side * 0.7, side * 0.6, side * 0.9], radius=side * 0.04, fill=255)
        f = load_font(MONO_CANDIDATES, int(side * 0.4))
        text(d, (side * 0.5, side * 0.44), '?', f, 255, anchor='mm')
    else:
        raise SystemExit('unknown glyph ' + kind)
    out = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    out.putalpha(img)
    black = Image.new('RGBA', (side, side), (0, 0, 0, 255))
    return Image.composite(black, out, img)


# ---------- 社交卡 ----------

OG_W, OG_H = 1200, 630
# 一块自洽的小盘：纵和 16=9+4+3、17=8+9、12=7+5；横和 24=9+8+7、18=4+9+5、3=3
OG_BOARD = [
    [('x',), ('d', 16), ('d', 17), ('d', 12)],
    [('a', 24), ('v', 9), ('v', 8), ('v', 7)],
    [('a', 18), ('v', 4), ('v', 9), ('n', [2, 5])],
    [('a', 3), ('v', 3), ('x',), ('x',)],
]


def og_card():
    ss = 2
    img = Image.new('RGBA', (OG_W * ss, OG_H * ss), PAL['paper'] + (255,))
    d = ImageDraw.Draw(img)
    for i in range(OG_H * ss):
        t = i / (OG_H * ss - 1)
        c = tuple(int(PAL['paper_hi'][k] * (1 - t) + PAL['paper_lo'][k] * t) for k in range(3))
        d.line([(0, i), (OG_W * ss, i)], fill=c)
    tex = Image.new('RGBA', (OG_W * ss, OG_H * ss), (0, 0, 0, 0))
    tile_img = paper_tile(256).convert('RGBA')
    tile_alpha = tile_img.split()[3]
    for ty in range(0, OG_H * ss, 256):
        for tx in range(0, OG_W * ss, 256):
            tex.paste(tile_img, (tx, ty), tile_alpha)
    img = Image.alpha_composite(img, tex)
    d = ImageDraw.Draw(img)

    fx = load_font(CJK_CANDIDATES, int(72 * ss))
    fm = load_font(MONO_CANDIDATES, int(26 * ss))
    fs = load_font(CJK_CANDIDATES, int(24 * ss))
    ink, dim = PAL['ink'] + (255,), PAL['dim'] + (255,)

    X = int(64 * ss)
    text(d, (X, int(96 * ss)), '加算十字', fx, ink, anchor='lm')
    text(d, (X, int(150 * ss)), 'KAKURO · CROSS SUM', fm, PAL['accent'] + (255,), anchor='lm')
    line1 = '黑格里那两个数，各管一条 run。'
    line2 = '每局唯一解，每局都能用组合清单与进差法推到底。'
    line3 = '提示只说推得出的那一步 —— 不含猜测。'
    for k, s in enumerate((line1, line2, line3)):
        text(d, (X, int((232 + 44 * k) * ss)), s, fs, ink if k == 0 else dim, anchor='lm')
    # 底部三个小方块 = 图例
    for k, (lab, col) in enumerate((('组合清单', PAL['accent']), ('占位排他', PAL['hint']), ('进差法', PAL['danger']))):
        bx = X + k * int(196 * ss)
        by = int(414 * ss)
        d.rounded_rectangle([bx, by, bx + int(16 * ss), by + int(16 * ss)], radius=int(4 * ss), fill=col + (255,))
        text(d, (bx + int(26 * ss), by + int(8 * ss)), lab, fs, ink, anchor='lm')
    text(d, (X, int(516 * ss)), 'z-biz-game', fm, dim, anchor='lm')
    text(d, (X + measure(fm, 'z-biz-game')[0] + int(14 * ss), int(518 * ss)),
         '推理类数字盘 · 零猜测', fs, dim, anchor='lm')

    # 右侧棋盘
    cell = int(112 * ss)
    bw = cell * len(OG_BOARD[0])
    bh = cell * len(OG_BOARD)
    ox = OG_W * ss - bw - int(56 * ss)
    oy = (OG_H * ss - bh) // 2
    d.rectangle([ox - int(10 * ss), oy - int(10 * ss), ox + bw + int(10 * ss), oy + bh + int(10 * ss)],
                fill=PAL['clue'] + (255,))
    for r, row in enumerate(OG_BOARD):
        for c, spec in enumerate(row):
            x0, y0 = ox + c * cell, oy + r * cell
            kind = spec[0]
            if kind == 'x':
                d.rectangle([x0 + 2, y0 + 2, x0 + cell - 2, y0 + cell - 2], fill=PAL['paper'] + (255,))
                continue
            if kind in ('d', 'a'):
                cellimg = Image.new('RGBA', (cell, cell), (0, 0, 0, 0))
                clue_cell(cellimg, (0, 0, cell, cell), dn=spec[1] if kind == 'd' else None,
                          ac=spec[1] if kind == 'a' else None, split_alpha=70)
                img.paste(cellimg, (x0, y0), cellimg)
                d = ImageDraw.Draw(img)
                continue
            bg = PAL['selected'] if (r, c) == (1, 1) else (PAL['tile'] if (r + c) % 2 == 0 else PAL['tile_alt'])
            d.rectangle([x0 + 2, y0 + 2, x0 + cell - 2, y0 + cell - 2], fill=bg + (255,))
            if kind == 'v':
                f = load_font(MONO_CANDIDATES, int(cell * 0.52))
                text(d, (x0 + cell // 2, y0 + int(cell * 0.55)), str(spec[1]), f, ink, anchor='mm')
            elif kind == 'n':
                slot = cell // 3
                f = load_font(MONO_CANDIDATES, int(slot * 0.62))
                for dig in spec[1]:
                    i = dig - 1
                    text(d, (x0 + (i % 3) * slot + slot // 2, y0 + (i // 3) * slot + slot // 2),
                         str(dig), f, PAL['note'] + (255,), anchor='mm')
    d.rectangle([ox, oy, ox + bw, oy + bh], outline=PAL['clue'] + (255,), width=int(6 * ss))
    return img.resize((OG_W, OG_H), Image.LANCZOS)


# ---------- 出盘 ----------

def derive(master, sizes, dirname, basename, bleed_from=None):
    os.makedirs(os.path.join(OUT_ROOT, dirname), exist_ok=True)
    made = []
    for px in sizes:
        im = master.resize((px, px), Image.LANCZOS)
        if bleed_from == 'ios':
            im = im.convert('RGB')
        path = os.path.join(OUT_ROOT, dirname, basename.format(px=px))
        im.save(path, optimize=True)
        made.append(path)
    return made


def png_info(path):
    with open(path, 'rb') as f:
        head = f.read(24)
    w = int.from_bytes(head[16:20], 'big')
    h = int.from_bytes(head[20:24], 'big')
    with open(path, 'rb') as f:
        sha = hashlib.sha1(f.read()).hexdigest()
    return {'file': os.path.relpath(path, REPO), 'w': w, 'h': h,
            'bytes': os.path.getsize(path), 'sha1': sha[:12]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--verify', action='store_true', help='只把盘上 PNG 的 sha1 与 manifest 对一遍')
    args = ap.parse_args()
    man_path = os.path.join(HERE, 'manifest.json')

    if args.verify:
        man = json.load(open(man_path, encoding='utf-8'))
        bad = []
        for e in man['files']:
            p = os.path.join(REPO, e['file'])
            if not os.path.exists(p):
                bad.append((e['file'], 'missing'))
                continue
            got = png_info(p)
            for k in ('w', 'h', 'bytes', 'sha1'):
                if got[k] != e[k]:
                    bad.append((e['file'], f'{k}: {e[k]} -> {got[k]}'))
        print(f'manifest {len(man["files"])} 项，不符 {len(bad)} 项')
        for f, why in bad:
            print('  MISMATCH', f, why)
        return 1 if bad else 0

    for sub in ('icons', 'og', 'textures', 'ui'):
        os.makedirs(os.path.join(OUT_ROOT, sub), exist_ok=True)

    rounded = master_icon(bleed=False)
    flat = master_icon(bleed=True)
    rounded.save(os.path.join(OUT_ROOT, 'icons', 'icon-1024.png'), optimize=True)
    flat.save(os.path.join(OUT_ROOT, 'icons', 'icon-1024-flat.png'), optimize=True)

    files = [os.path.join(OUT_ROOT, 'icons', 'icon-1024.png'),
             os.path.join(OUT_ROOT, 'icons', 'icon-1024-flat.png')]
    files += derive(rounded, [512, 192, 96, 64, 48, 32, 16], 'icons', 'icon-{px}.png')
    files += derive(flat, [512], 'icons', 'maskable-{px}.png')
    files += derive(flat, [180, 167, 152, 120], 'icons', 'apple-touch-icon-{px}.png')
    # 单文件别名：浏览器/iOS 默认抓的名字
    for src, dst in (('icon-192.png', 'favicon-192.png'), ('icon-32.png', 'favicon-32.png'),
                     ('icon-48.png', 'favicon-48.png'), ('icon-16.png', 'favicon-16.png'),
                     ('apple-touch-icon-180.png', 'apple-touch-icon.png')):
        data = open(os.path.join(OUT_ROOT, 'icons', src), 'rb').read()
        p = os.path.join(OUT_ROOT, 'icons', dst)
        with open(p, 'wb') as f:
            f.write(data)
        files.append(p)

    paper = paper_tile(256)
    p = os.path.join(OUT_ROOT, 'textures', 'paper-256.png')
    paper.save(p, optimize=True)
    files.append(p)
    stamp = solved_stamp(256)
    p = os.path.join(OUT_ROOT, 'textures', 'solved-stamp-256.png')
    stamp.save(p, optimize=True)
    files.append(p)

    for g in ('sound-on', 'sound-off', 'pause', 'play', 'replay', 'fullscreen', 'pencil', 'hint'):
        p = os.path.join(OUT_ROOT, 'ui', f'{g}-48.png')
        ui_glyph(g, 48).save(p, optimize=True)
        files.append(p)

    og = og_card()
    p = os.path.join(OUT_ROOT, 'og', 'kakuro-og-1200x630.png')
    og.save(p, optimize=True)
    files.append(p)

    entries = [png_info(f) for f in files]
    with open(man_path, 'w', encoding='utf-8') as f:
        json.dump({'generator': 'assets/gen/make_art.py', 'seed': SEED,
                   'palette_ref': 'css/game.css :root', 'files': entries}, f,
                  ensure_ascii=False, indent=1, sort_keys=True)
        f.write('\n')
    big = [e for e in entries if min(e['w'], e['h']) >= 180]
    print(f'写出 {len(entries)} 个文件，其中边长≥180 的 {len(big)} 张；manifest -> assets/gen/manifest.json')
    for e in entries:
        print('  %-44s %5dx%-5d %7dB sha1=%s' % (e['file'], e['w'], e['h'], e['bytes'], e['sha1']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
