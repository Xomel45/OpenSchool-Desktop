#!/usr/bin/env python3
"""Draws every OpenSchool app icon (an open book with a small pencil) and writes all the files the apps use.

    python3 icons/make_icons.py [--mobile ../OpenSchool-Mobile]

The drawing below is the only source: change it here and run the script again.

Every icon has the same shape (the book and the pencil lie in the same place), only the colours differ.
Writes (needs `rsvg-convert`):
  icons/svg/<id>.svg                          the full icon (rounded square or circle)
  icons/svg/adaptive/<id>-{bg,fg}.svg         the two layers of an Android adaptive icon
  src-tauri/icons/variants/<id>.png           256 px, embedded in the app (window and tray icon)
  src-tauri/icons/source.png                  1024 px of the default icon; `cargo tauri icon` makes the bundle icons from it
  ui/icons/<id>.png                           128 px, previews in the settings
  <mobile>/app/src/main/res/...               adaptive icon layers (432 px), previews (192 px) and the launcher xml
"""
import argparse
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
DESKTOP = HERE.parent

def book(left, right, line, spine, outline=None):
    y = 20  # the book sits a little low: the pencil has room above its right page
    if outline:
        return (f'<g fill="none" stroke="{outline}" stroke-width="10" stroke-linejoin="round" stroke-linecap="round">'
                f'<path d="M256 {150 + y}c-40-26-92-30-136-18v226c44-12 96-8 136 18z"/>'
                f'<path d="M256 {150 + y}c40-26 92-30 136-18v226c-44-12-96-8-136 18z"/><path d="M256 {150 + y}v226"/></g>')
    return (f'<path d="M256 {150 + y}c-40-26-92-30-136-18v226c44-12 96-8 136 18z" fill="{left}"/>'
            f'<path d="M256 {150 + y}c40-26 92-30 136-18v226c-44-12-96-8-136 18z" fill="{right}"/>'
            f'<path d="M256 {150 + y}v226" stroke="{spine}" stroke-width="8"/>'
            f'<path d="M160 {205 + y}c22-4 44-1 66 8M160 {250 + y}c22-4 44-1 66 8M286 {213 + y}c22-9 44-12 66-8M286 {258 + y}c22-9 44-12 66-8" '
            f'stroke="{line}" stroke-width="12" stroke-linecap="round" fill="none"/>')


SCALE, CX, CY, ROT = 0.5, 330, 210, 40  # the pencil: one place for all icons


def pencil(body, top, wood, tip, outline=None):
    st = f' stroke="{outline}" stroke-width="{9 / SCALE:.0f}" stroke-linejoin="round"' if outline else ''
    return (f'<g transform="translate({CX} {CY}) rotate({ROT}) scale({SCALE}) translate(-256 -256)">'
            f'<rect x="226" y="90" width="60" height="230" rx="6" fill="{body}"{st}/>'
            f'<rect x="226" y="90" width="60" height="44" rx="6" fill="{top}"{st}/>'
            f'<path d="M226 320h60l-30 70z" fill="{wood}"{st}/><path d="M244 366h24l-12 24z" fill="{tip}"{st}/></g>')


def gradient(a, b):
    return (f'<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{a}"/>'
            f'<stop offset="1" stop-color="{b}"/></linearGradient></defs>', 'url(#bg)')


# id -> title, dev-only flag, background (defs, fill), disc colour (round plates), glyph
ICONS = {}


def add(id, title, bg, glyph, dev=False, disc=None):
    defs, fill = bg if isinstance(bg, tuple) else ('', bg)
    ICONS[id] = dict(title=title, dev=dev, defs=defs, fill=fill, disc=disc, glyph=glyph)


add('graphite', 'Графит', '#1a1a1a', book('#2c2c2c', '#383838', '#9a9a9a', '#9a9a9a') + pencil('#d9d9d9', '#8a8a8a', '#bdbdbd', '#1a1a1a'))
add('ink', 'Контур', '#0e0e10', book(0, 0, 0, 0, outline='#f2f2f2') + pencil('#0e0e10', '#0e0e10', '#0e0e10', '#0e0e10', outline='#ffffff'))
add('night', 'Ночь', '#0e0e10', book('#1c1c20', '#26262b', '#f2f2f2', '#f2f2f2') + pencil('#ffffff', '#bdbdbd', '#e6e6e6', '#0e0e10'))
add('paper', 'Бумага', '#f5f5f5', book('#e2e2e2', '#d4d4d4', '#111111', '#111111') + pencil('#111111', '#555555', '#cfcfcf', '#111111'))
add('dusk', 'Закат', gradient('#4f7cff', '#ffb347'),
    book('#ffffff', '#ffe8d0', '#ff9f6b', '#e0306a') + pencil('#ffffff', '#ffd1d6', '#ffe8c4', '#3a3a4a'))
add('indigo', 'Индиго', gradient('#4f7cff', '#7b4fff'),
    book('#ffffff', '#dfe6ff', '#7b8cff', '#7b4fff') + pencil('#ffd45e', '#ff8f9e', '#ffe8c4', '#2a2a3a'))
add('dawn', 'Заря', gradient('#4f7cff', '#ff5f6d'),
    book('#ffffff', '#dfe6ff', '#7b8cff', '#7b4fff') + pencil('#ffd45e', '#ff8f9e', '#ffe8c4', '#2a2a3a'))
add('ring', 'Круг', '#4f7cff', book('#4f7cff', '#7b9bff', '#ffffff', '#ffffff') + pencil('#ffb347', '#ff5f6d', '#ffe8c4', '#2a2a3a'), disc='#ffffff')
add('disc', 'Диск', '#0e0e10', book('#111111', '#333333', '#f5f5f5', '#f5f5f5') + pencil('#ffffff', '#bdbdbd', '#e6e6e6', '#111111', outline='#111111'),
    dev=True, disc='#f5f5f5')
add('spark', 'Искра', '#0e0e10', book('#1c1c20', '#26262b', '#f2f2f2', '#f2f2f2') + pencil('#ffffff', '#ff4d5e', '#e6e6e6', '#0e0e10'), dev=True)
DEFAULT = 'graphite'
CIRCLE = {'ring', 'disc'}  # a round plate instead of a rounded square


def full_svg(id):
    i = ICONS[id]
    rx = 256 if id in CIRCLE else 112
    disc = f'<circle cx="256" cy="256" r="196" fill="{i["disc"]}"/>' if i['disc'] else ''
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">{i["defs"]}'
            f'<rect width="512" height="512" rx="{rx}" fill="{i["fill"]}"/>{disc}{i["glyph"]}</svg>\n')


def bg_svg(id):
    i = ICONS[id]
    disc = f'<circle cx="256" cy="256" r="196" fill="{i["disc"]}"/>' if i['disc'] else ''
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="432" height="432" viewBox="0 0 512 512">{i["defs"]}'
            f'<rect width="512" height="512" fill="{i["fill"]}"/>{disc}</svg>\n')


def fg_svg(id):
    # Android shows only the middle two thirds of the 108 dp layer: the drawing is shrunk to stay inside.
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="432" height="432" viewBox="0 0 512 512">'
            f'<g transform="translate(256 256) scale(0.78) translate(-256 -256)">{ICONS[id]["glyph"]}</g></svg>\n')


def png(svg, out, size):
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['rsvg-convert', '-w', str(size), '-h', str(size), '-o', str(out), str(svg)], check=True)


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mobile', help='path of the OpenSchool-Mobile checkout')
    args = ap.parse_args()
    svg = HERE / 'svg'
    for id in ICONS:
        write(svg / f'{id}.svg', full_svg(id))
        write(svg / 'adaptive' / f'{id}-bg.svg', bg_svg(id))
        write(svg / 'adaptive' / f'{id}-fg.svg', fg_svg(id))
        png(svg / f'{id}.svg', DESKTOP / 'src-tauri/icons/variants' / f'{id}.png', 256)
        png(svg / f'{id}.svg', DESKTOP / 'ui/icons' / f'{id}.png', 128)
    png(svg / f'{DEFAULT}.svg', DESKTOP / 'src-tauri/icons/source.png', 1024)
    if args.mobile:
        res = pathlib.Path(args.mobile) / 'app/src/main/res'
        for id in ICONS:
            png(svg / 'adaptive' / f'{id}-bg.svg', res / 'drawable-nodpi' / f'ic_{id}_bg.png', 432)
            png(svg / 'adaptive' / f'{id}-fg.svg', res / 'drawable-nodpi' / f'ic_{id}_fg.png', 432)
            png(svg / f'{id}.svg', res / 'drawable-nodpi' / f'ic_prev_{id}.png', 192)
            write(res / 'mipmap-anydpi-v26' / f'ic_{id}.xml',
                  '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
                  f'    <background android:drawable="@drawable/ic_{id}_bg" />\n    <foreground android:drawable="@drawable/ic_{id}_fg" />\n</adaptive-icon>\n')
    print('icons:', ', '.join(ICONS), file=sys.stderr)


if __name__ == '__main__':
    main()
