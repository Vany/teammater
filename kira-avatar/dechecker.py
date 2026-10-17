#!/usr/bin/env python3
"""
Replace a painted "transparency" checkerboard with real alpha. Needs python3 (stdlib only)
and ImageMagick 7 (`magick`) for decoding and encoding.

Why (vany 2026-10-17): ChatGPT drew Kira's avatar frames on a fake checkerboard: RGB squares
of ~#FDFDFD and ~#D8D8D8, no alpha. That background is bright and colourless, while her
cream sweater (colour spread ~100/255), skin and purple hair are not. So:

  1. candidate = bright (min channel > 178) and colourless (max-min < 20). The loose limits
     also catch the light, slightly tinted fringe ChatGPT left around hair strands.
  2. background = candidates connected to a SEED: the image border, or a mid-grey checker
     pixel (200..230). The second seed finds pockets enclosed by stray strands, which a
     border flood fill misses. Pure-white eye and glasses glints contain no mid-grey, so they
     stay opaque.
  3. alpha: background 0, figure 255. Then ImageMagick erodes the figure by 1px (drops what is
     left of the blended fringe) and blurs the cut 0.6px, so hair edges aren't jagged.

Originals are never touched: writes <name>-alpha.png next to each input.
usage: dechecker.py frame.png [...]
"""

import subprocess
import sys
from collections import deque


def size(path):
    w, h = subprocess.run(["magick", "identify", "-format", "%w %h", path], capture_output=True, text=True, check=True).stdout.split()
    return int(w), int(h)


def background(rgb, w, h):
    n = w * h
    cand = bytearray(n)
    seeds = deque()
    for i in range(n):
        r, g, b = rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]
        lo, hi = min(r, g, b), max(r, g, b)
        if lo > 178 and hi - lo < 20:
            cand[i] = 1
            y, x = divmod(i, w)
            if x == 0 or y == 0 or x == w - 1 or y == h - 1 or (200 <= lo and hi <= 230):
                seeds.append(i)
    bg = bytearray(n)
    for i in seeds:
        bg[i] = 1
    while seeds:
        i = seeds.popleft()
        y, x = divmod(i, w)
        for j in (i - 1 if x else -1, i + 1 if x < w - 1 else -1, i - w, i + w):
            if 0 <= j < n and cand[j] and not bg[j]:
                bg[j] = 1
                seeds.append(j)
    return bg


def main(paths):
    for path in paths:
        w, h = size(path)
        rgb = subprocess.run(["magick", path, "-alpha", "off", "-depth", "8", "rgb:-"], capture_output=True, check=True).stdout
        bg = background(rgb, w, h)
        alpha = bytes(0 if v else 255 for v in bg)
        out = path[: -len(".png")] + "-alpha.png"
        subprocess.run(
            ["magick", path, "-alpha", "off",
             "(", "-size", f"{w}x{h}", "-depth", "8", "gray:-", "-morphology", "Erode", "Disk:1", "-blur", "0x0.6", ")",
             "-compose", "CopyOpacity", "-composite", out],
            input=alpha, check=True)
        print(f"{out}  transparent {sum(bg) / len(bg):.1%}")


if __name__ == "__main__":
    main(sys.argv[1:])
