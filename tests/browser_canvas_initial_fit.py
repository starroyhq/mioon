"""Check the first canvas open against a development build, with synthetic projects only."""

import argparse
import json
from pathlib import Path
import secrets
import shutil
import subprocess
from tempfile import TemporaryDirectory
import time

from playwright.sync_api import expect, sync_playwright

from helpers.qa_env import test_env


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / 'tests/helpers/browser-canvas-initial-fit-fixture.ts'
MAC_CHROME = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
PANE = '[data-testid="canvas-drop-zone"] .react-flow'
SHOT = '[data-testid^="shot-node-"]'


def measure(page, count):
    expect(page.locator(SHOT)).to_have_count(count)
    return page.evaluate('''async ({paneSelector, nodeSelector}) => {
        const pane = document.querySelector(paneSelector);
        const viewport = pane.querySelector('.react-flow__viewport');
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        const transform = () => getComputedStyle(viewport).transform;
        // Wait for real node measurement and the last fit/zoom update.
        let previous = '', stable = 0;
        for (let index = 0; index < 120 && stable < 8; index++) {
            await frame();
            const allMeasured = [...pane.querySelectorAll('.react-flow__node')].every(node =>
                getComputedStyle(node).visibility === 'visible' && node.getBoundingClientRect().width > 0);
            const next = transform();
            stable = allMeasured && previous === next ? stable + 1 : 0;
            previous = next;
        }
        if (stable < 8) throw new Error('Canvas viewport did not settle');
        const {a: zoom, e: x, f: y} = new DOMMatrixReadOnly(transform());
        const area = pane.getBoundingClientRect().toJSON();
        const docks = [
            ['left', 'right', Math.max, '#dock-assets[data-visible="true"], .recall-assets'],
            ['right', 'left', Math.min, '#dock-inspector[data-visible="true"], .recall-inspector'],
            ['top', 'bottom', Math.max, '.board-toolbar-heading'],
            ['bottom', 'top', Math.min, '.board-storyboard'],
        ];
        for (const [inside, outside, limit, selector] of docks) {
            for (const overlay of document.querySelectorAll(selector)) {
                const box = overlay.getBoundingClientRect();
                if (box.width > 0 && box.height > 0) area[inside] = limit(area[inside], box[outside]);
            }
        }
        const nodes = [...pane.querySelectorAll(nodeSelector)].map(node => node.getBoundingClientRect().toJSON());
        return {viewport: {x, y, zoom}, area, nodes};
    }''', {'paneSelector': PANE, 'nodeSelector': SHOT})


def assert_saved_zoom(page, context, origin, project_id):
    zoom_in = page.get_by_role('button', name='放大', exact=True)
    for _ in range(4):
        zoom_in.click()
        zoomed = measure(page, 1)['viewport']
        if abs(zoomed['zoom'] - 1.75) < 0.0001:
            break
    assert abs(zoomed['zoom'] - 1.75) < 0.0001, f'Manual zoom was blocked: {zoomed}'
    indicator = page.locator('.canvas-controls > span')
    expect(indicator).to_have_text('175%')
    # The canvas remains free to choose a later viewport in both local and saved paths.
    for _ in range(100):
        response = context.request.get(f'{origin}/api/workspace-preferences/{project_id}')
        assert response.ok, 'Could not read saved canvas preferences'
        state = response.json()['data']['state'] or {}
        saved = state.get('canvas', {}).get('viewport') or {}
        if abs(saved.get('zoom', 0) - zoomed['zoom']) < 0.0001:
            break
        time.sleep(0.05)
    else:
        raise AssertionError('Manual zoom was not persisted')
    def check_restored(action):
        restored = measure(page, 1)['viewport']
        expect(indicator).to_have_text('175%')
        assert abs(restored['zoom'] - zoomed['zoom']) < 0.0001, f'{action} changed saved zoom: {zoomed}, {restored}'
        assert all(abs(restored[axis] - zoomed[axis]) < 1 for axis in ('x', 'y')), f'{action} changed saved pan: {zoomed}, {restored}'

    page.get_by_test_id('workspace-editing').click()
    expect(page.locator(PANE)).to_have_count(0)
    page.get_by_test_id('workspace-canvas').click()
    check_restored('Workspace switch')
    page.reload(wait_until='domcontentloaded')
    page.get_by_test_id(f'pf-card-open-{project_id}').or_(page.locator(PANE)).first.wait_for()
    if not page.locator(PANE).is_visible():
        page.get_by_test_id(f'pf-card-open-{project_id}').click()
    check_restored('Project reopen')
    print('Manual and restored zoom 175.00%, with matching pan and indicator')


def run_browser(metadata, token, executable, screenshots):
    origin = metadata['origin']
    failures = []
    with sync_playwright() as playwright, playwright.chromium.launch(executable_path=executable) as browser:
        for project in metadata['projects']:
            count = project['count']
            context = browser.new_context(viewport={'width': 1440, 'height': 900}, locale='zh-CN',
                                          reduced_motion='reduce', service_workers='block')
            try:
                context.add_init_script("""localStorage.setItem('mioon.app-language.v1', JSON.stringify({version: 1, preference: 'zh-Hans'}))""")
                assert context.request.post(origin + '/api/login', data={'token': token}).ok, 'Fixture login failed'
                context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(origin + '/') else route.abort())
                page = context.new_page()
                page_errors = []
                page.on('pageerror', lambda error: page_errors.append(str(error)))
                page.goto(origin, wait_until='domcontentloaded')
                saved = context.request.get(f"{origin}/api/workspace-preferences/{project['projectId']}")
                assert saved.ok and saved.json()['data']['state'] is None, 'Fixture contains saved preferences'
                page.get_by_test_id(f"pf-card-open-{project['projectId']}").click()
                board = page.locator(PANE)
                expect(board).to_be_visible()
                result = measure(page, count)
                zoom, bounds, cards = result['viewport']['zoom'], result['area'], result['nodes']
                visible = sum(
                    card['width'] > 0 and card['height'] > 0 and
                    card['left'] >= bounds['left'] - 1 and card['right'] <= bounds['right'] + 1 and
                    card['top'] >= bounds['top'] - 1 and card['bottom'] <= bounds['bottom'] + 1
                    for card in cards
                )
                print(f'{count} shots: initial zoom {zoom * 100:.2f}%, {visible}/{count} inside the canvas')
                if screenshots is not None and count == 30:
                    page.mouse.move(0, 0)
                    page.screenshot(path=screenshots / '03-canvas-initial-fit.png', animations='disabled')
                if not 0 < zoom <= 1.0001:
                    failures.append(f'{count} shots: first-open zoom {zoom * 100:.2f}% exceeds 100%')
                if visible != count:
                    failures.append(f'{count} shots: {visible}/{count} shots lie completely inside the viewport')
                if count == 1 and zoom <= 1.0001 and visible == count:
                    assert_saved_zoom(page, context, origin, project['projectId'])
                assert not page_errors, f'Browser page errors: {page_errors}'
            finally:
                context.close()
    assert not failures, '\n'.join(failures)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dist-dir', type=Path, default=ROOT / 'apps/web/dist')
    parser.add_argument('--browser', default=shutil.which('google-chrome') or shutil.which('chromium')
                        or (str(MAC_CHROME) if MAC_CHROME.is_file() else None))
    parser.add_argument('--screenshots', type=Path)
    args = parser.parse_args()
    if not (args.dist_dir / 'index.html').is_file():
        parser.error('Missing development web build')
    if args.screenshots is not None:
        args.screenshots.mkdir(parents=True, exist_ok=True)

    token = secrets.token_hex(32)
    with TemporaryDirectory(prefix='mioon-canvas-fit-') as temp, TemporaryDirectory(prefix='mioon-canvas-home-') as home:
        folder = Path(temp).resolve()
        with (folder / 'fixture.log').open('w+', encoding='utf-8') as log:
            process = subprocess.Popen(['node', str(FIXTURE), str(folder), str(args.dist_dir.resolve()), token],
                                       cwd=ROOT, env=test_env(HOME=home), stdout=log, stderr=subprocess.STDOUT)
            try:
                ready = folder / 'ready.json'
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline and process.poll() is None:
                    if ready.is_file():
                        try:
                            metadata = json.loads(ready.read_text(encoding='utf-8'))
                        except json.JSONDecodeError:
                            pass
                        else:
                            break
                    time.sleep(0.05)
                else:
                    log.seek(0)
                    raise RuntimeError('The synthetic fixture did not start:\n' + log.read())
                run_browser(metadata, token, args.browser, args.screenshots)
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)


if __name__ == '__main__':
    main()
