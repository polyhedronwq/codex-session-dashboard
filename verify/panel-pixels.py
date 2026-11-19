"""A 档：判面板截图是不是"真的有内容"。

空白/转圈时几乎全是背景色；正常渲染时有大量文字与卡片。
不依赖 DOM（面板在跨源 iframe 里读不到），只看像素。

    python verify/panel-pixels.py verify/shots/panel-live.png
"""
import sys

from PIL import Image

MIN_INK = 1.5      # 非背景像素占比下限（%），空白/加载态通常 < 0.5%


def main(path):
    image = Image.open(path).convert('RGB')
    width, height = image.size
    pixels = image.load()

    # 背景色取四角的中位数，避免深色主题误判
    corners = [pixels[0, 0], pixels[width // 2, 0], pixels[0, height - 1], pixels[width - 1, height - 1]]
    bg = [sorted(c[i] for c in corners)[len(corners) // 2] for i in range(3)]

    ink = 0
    for y in range(0, height, 2):
        for x in range(0, width, 2):
            r, g, b = pixels[x, y]
            if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > 24:
                ink += 1
    total = (width // 2 + 1) * (height // 2 + 1)
    ratio = ink / total * 100

    print(f'  尺寸 {width}x{height}  背景 rgb{tuple(bg)}  非背景像素 {ratio:.2f}%')
    if ratio < MIN_INK:
        print(f'  低于阈值 {MIN_INK}%：面板很可能是空白或加载态')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
