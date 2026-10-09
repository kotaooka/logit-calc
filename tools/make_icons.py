# アプリアイコンを作る（S 字の確率曲線と 0/1 の点）。python tools/make_icons.py（Pillow が必要）
import math
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'icons'
BG, WHITE, ORANGE, AXIS = (29, 92, 150), (255, 255, 255), (255, 168, 120), (150, 185, 215)

def draw(size, maskable=False):
    s = 4 * size  # 4 倍で描いて縮小（縁を滑らかにする）
    im = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if maskable:
        d.rectangle([0, 0, s, s], fill=BG); k = 0.72
    else:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=s * 0.2, fill=BG); k = 1.0
    c = s / 2
    X = lambda u: c + (u - 0.5) * s * 0.66 * k
    Y = lambda v: c - (v - 0.5) * s * 0.56 * k
    w = round(s * 0.035 * k)
    d.line([X(0), Y(0), X(1), Y(0)], fill=AXIS, width=round(w * 0.6))
    d.line([X(0), Y(1), X(1), Y(1)], fill=AXIS, width=round(w * 0.6))
    pts = [(X(i / 80), Y(1 / (1 + math.exp(-(i / 80 - 0.5) * 12)))) for i in range(81)]
    d.line(pts, fill=WHITE, width=w, joint='curve')
    r = s * 0.032 * k
    for u in [0.08, 0.22, 0.34, 0.46]:
        d.ellipse([X(u) - r, Y(0) - r, X(u) + r, Y(0) + r], fill=WHITE)
    for u in [0.56, 0.7, 0.84, 0.95]:
        d.ellipse([X(u) - r, Y(1) - r, X(u) + r, Y(1) + r], fill=ORANGE)
    return im.resize((size, size), Image.LANCZOS)

OUT.mkdir(exist_ok=True)
draw(512).save(OUT / 'icon-512.png')
draw(192).save(OUT / 'icon-192.png')
draw(512, maskable=True).save(OUT / 'icon-maskable-512.png')
draw(180, maskable=True).convert('RGB').save(OUT / 'apple-touch-icon.png')
print('icons/ に書き出しました')
