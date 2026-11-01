"""Screenshots of the project file screens (U1) from the built gallery.

Usage:
  python3 tests/fixtures/project-file-ui/capture.py --dist <gallery build> [--group all|home|media|versions-pack|rules] [--only id,id] [--out-root <dir>]

Needs Python 3.11, Playwright and Pillow, and a Chromium: $MIOON_CHROMIUM,
`chromium` on PATH, or Google Chrome on macOS. Dark theme, Simplified Chinese,
1440x900, reduced motion. Each image is stored under 95,000 bytes: a 256-colour
PNG, or a JPEG when the PNG is larger. Exits 1 on a page error, a console
error, a fixture error, an unknown scene or an image that stays too large.
"""
import argparse
import functools
import http.server
import io
import json
import os
import shutil
import sys
import threading
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[3]
MAX_BYTES = 95_000
VIEWPORT = {'width': 1440, 'height': 900}
DIALOG_MARGIN = 24


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A002 - signature of the base class
        pass


def chromium() -> str:
    for candidate in (os.environ.get('MIOON_CHROMIUM'), shutil.which('chromium'), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'):
        if candidate and Path(candidate).exists():
            return candidate
    sys.exit('No Chromium found: set MIOON_CHROMIUM.')


def compress(png: bytes) -> tuple[bytes, str]:
    """256-colour PNG first; JPEG at quality 82, then 72, when that is too large."""
    image = Image.open(io.BytesIO(png)).convert('RGB')
    buffer = io.BytesIO()
    image.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE).save(buffer, format='PNG', optimize=True)
    if buffer.tell() < MAX_BYTES:
        return buffer.getvalue(), 'png'
    for quality in (82, 72):
        buffer = io.BytesIO()
        image.save(buffer, format='JPEG', quality=quality, optimize=True, progressive=True)
        if buffer.tell() < MAX_BYTES:
            return buffer.getvalue(), 'jpg'
    return buffer.getvalue(), 'too-large'


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--dist', required=True)
    parser.add_argument('--out-root', default=str(ROOT / 'docs/verification/project-file-ui'))
    parser.add_argument('--group', default='all')
    parser.add_argument('--only', default='')
    options = parser.parse_args()
    handler = functools.partial(QuietHandler, directory=options.dist)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_address[1]}/index.html'
    failed = False
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=chromium(), headless=True)
        settings = dict(viewport=VIEWPORT, locale='zh-CN', timezone_id='Asia/Shanghai', color_scheme='dark', reduced_motion='reduce')
        contexts = {1: browser.new_context(device_scale_factor=1, **settings), 2: browser.new_context(device_scale_factor=2, **settings)}
        index = contexts[1].new_page()
        index.goto(base)
        index.wait_for_function('() => Array.isArray(window.__projectFileScenes)', timeout=15000)
        table = index.evaluate('window.__projectFileScenes')
        index.close()
        groups = sorted({scene['group'] for scene in table}) if options.group == 'all' else [options.group]
        only = [item for item in options.only.split(',') if item]
        unknown = [item for item in only if item not in {scene['id'] for scene in table}]
        if unknown or any(group not in {scene['group'] for scene in table} for group in groups):
            print(f'unknown scene or group: {unknown or groups}')
            return 1
        for group in groups:
            directory = Path(options.out_root) / group
            directory.mkdir(parents=True, exist_ok=True)
            results_file = directory / 'results.json'
            previous = json.loads(results_file.read_text('utf-8'))['scenes'] if only and results_file.exists() else []
            if not only:
                for stale in directory.iterdir():
                    if stale.name != 'README.md':
                        stale.unlink()
            captured = {entry['id']: entry for entry in previous}
            for scene in (item for item in table if item['group'] == group and (not only or item['id'] in only)):
                entry = capture(contexts, base, scene, directory)
                for name in {entry['file'], f"{scene['id']}.png", f"{scene['id']}.jpg"} - {entry['file']}:
                    (directory / name).unlink(missing_ok=True)
                captured[scene['id']] = entry
                failed = failed or bool(entry['errors'])
                print(f"{scene['id']}: {entry['format']} {entry['bytes']} bytes {entry['width']}x{entry['height']} {'; '.join(entry['errors'])}")
            ordered = [captured[scene['id']] for scene in table if scene['group'] == group and scene['id'] in captured]
            results = {'group': group, 'browser': browser.version, 'viewport': VIEWPORT, 'scenes': ordered}
            results_file.write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n', 'utf-8')
        browser.close()
    server.shutdown()
    return 1 if failed else 0


def capture(contexts, base: str, scene: dict, directory: Path) -> dict:
    errors: list[str] = []
    scale = 2 if scene['capture'] == 'frame' else 1
    page = contexts[scale].new_page()
    page.on('pageerror', lambda error: errors.append(f'pageerror: {error}'))
    page.on('console', lambda message: errors.append(f'console: {message.text}') if message.type == 'error' else None)
    page.goto(f"{base}?scene={scene['id']}&locale=zh-Hans")
    try:
        page.wait_for_function('() => document.body.dataset.fixtureReady === "true" || Boolean(document.body.dataset.fixtureError)', timeout=15000)
        fixture_error = page.evaluate('document.body.dataset.fixtureError || ""')
        if fixture_error:
            errors.append(f'fixture: {fixture_error}')
        page.evaluate('document.fonts.ready.then(() => true)')
        page.wait_for_function("() => document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity)", timeout=5000)
        # Opening a dialog focuses its first control. With no pointer event yet,
        # Chrome draws the keyboard focus ring on that button; a mouse click on
        # the dialog title hides it, as when the dialog is opened with the mouse.
        if page.evaluate("() => document.activeElement instanceof HTMLButtonElement && document.activeElement.matches(':focus-visible')"):
            title = page.locator('[data-slot="dialog-title"]')
            if title.count():
                title.last.click()
        page.wait_for_timeout(150)
        if scene['capture'] == 'frame':
            png = page.locator('[data-scene-frame]').screenshot(animations='disabled')
        elif scene['capture'] == 'dialog':
            box = page.locator('[data-slot="dialog-content"]').last.bounding_box()
            x, y = max(0, box['x'] - DIALOG_MARGIN), max(0, box['y'] - DIALOG_MARGIN)
            clip = {'x': x, 'y': y, 'width': min(VIEWPORT['width'] - x, box['width'] + 2 * DIALOG_MARGIN), 'height': min(VIEWPORT['height'] - y, box['height'] + 2 * DIALOG_MARGIN)}
            png = page.screenshot(clip=clip, animations='disabled')
        else:
            png = page.screenshot(animations='disabled')
    except Exception as error:  # noqa: BLE001 - every failure is reported per scene
        errors.append(f'capture: {error}')
        png = page.screenshot(animations='disabled')
    page.close()
    data, kind = compress(png)
    if kind == 'too-large':
        errors.append(f'image stays above {MAX_BYTES} bytes')
        kind = 'jpg'
    name = f"{scene['id']}.{kind}"
    (directory / name).write_bytes(data)
    width, height = Image.open(io.BytesIO(data)).size
    return {'id': scene['id'], 'design': scene['design'], 'state': scene['state'], 'capture': scene['capture'], 'file': name, 'format': kind,
            'bytes': len(data), 'width': width, 'height': height, 'errors': errors}


if __name__ == '__main__':
    sys.exit(main())
