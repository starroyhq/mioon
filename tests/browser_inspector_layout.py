"""Run against the built app: python3 tests/browser_inspector_layout.py."""

import argparse
from itertools import combinations
import json
from pathlib import Path
import re
import secrets
import shutil
import subprocess
from tempfile import TemporaryDirectory
import time

from playwright.sync_api import expect, sync_playwright

from helpers.qa_env import test_env


ROOT = Path(__file__).resolve().parents[1]
SYNTHETIC_FIXTURE = ROOT / 'tests/helpers/browser-inspector-layout-fixture.ts'
MAC_CHROME = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
REQUIRED = ('provider-select', 'input-mode-select', 'shot-ratio', 'shot-duration')
CONFIGURED = (*REQUIRED, 'model-select', 'generation-resolution')


def check_layout(inspector, state, controls):
    for control in controls:
        expect(inspector.get_by_test_id(control)).to_be_visible()
    rows = inspector.evaluate('''async (panel, controls) => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(resolve));
        const bounds = element => element.getBoundingClientRect().toJSON();
        return controls.map(testId => {
            const control = panel.querySelector(`[data-testid="${testId}"]`);
            const labels = [...panel.querySelectorAll('label')].filter(label =>
                label.htmlFor && label.htmlFor === control.id);
            if (labels.length !== 1)
                throw new Error(`${testId}: expected one associated label, got ${labels.length}`);
            return {name: testId, label: bounds(labels[0]), control: bounds(control)};
        });
    }''', list(controls))
    errors, differences = [], []
    for row in rows:
        name, label, control = row['name'], row['label'], row['control']
        if min(label['width'], label['height'], control['width'], control['height']) <= 0:
            errors.append(f'{name}: empty label or control box')
        delta = abs(label['y'] + label['height'] / 2 - control['y'] - control['height'] / 2)
        differences.append(delta)
        if delta >= 2:
            errors.append(f'{name}: label and control centers differ by {delta:.2f}px')
        if label['right'] > control['left']:
            errors.append(f'{name}: label extends into the control column')
    for one, other in combinations(rows, 2):
        a, b = one['label'], other['label']
        if min(a['right'], b['right']) > max(a['left'], b['left']) and min(a['bottom'], b['bottom']) > max(a['top'], b['top']):
            errors.append(f"{one['name']} and {other['name']}: labels overlap")
    assert not errors, f'{state}: ' + '; '.join(errors)
    print(f'{state}: {len(rows)} rows, largest center difference {max(differences):.2f}px, no overlapping labels')


def check_model_badge(inspector):
    model = inspector.get_by_test_id('model-select')
    badge = inspector.get_by_test_id('video-model-unverified')
    expect(badge).to_be_visible()
    # Read both boxes in one browser task, even if the inspector has scrolled.
    model_box, badge_box = model.evaluate("""model => {
        const badge = model.closest('[data-testid="provider-settings"]')
            .querySelector('[data-testid="video-model-unverified"]');
        return [model.getBoundingClientRect().toJSON(), badge.getBoundingClientRect().toJSON()];
    }""")
    delta = abs(model_box['top'] + model_box['height'] / 2 - badge_box['top'] - badge_box['height'] / 2)
    assert badge_box['left'] >= model_box['right'] and delta < 2, 'Unverified badge is not beside the model control'


def run_browser(metadata, token, executable):
    origin = metadata['origin']
    with sync_playwright() as playwright, playwright.chromium.launch(executable_path=executable) as browser:
        context = browser.new_context(viewport={'width': 1440, 'height': 900}, locale='zh-CN',
                                      reduced_motion='reduce', service_workers='block')
        context.add_init_script("""localStorage.setItem('mioon.app-language.v1', JSON.stringify({version: 1, preference: 'zh-Hans'}))""")
        assert context.request.post(origin + '/api/login', data={'token': token}).ok, 'Fixture login failed'

        def fixture_rpc(route):
            request = route.request
            if not request.url.startswith(origin + '/'):
                route.abort()
                return
            if request.method == 'POST' and request.url.endswith('/rpc'):
                operation = request.post_data_json['operation']
                if operation in ('provider.list', 'video.connection.list'):
                    data = [] if operation == 'provider.list' else metadata['connections']
                    route.fulfill(json={'ok': True, 'data': data})
                    return
            route.continue_()

        context.route('**/*', fixture_rpc)
        page = context.new_page()
        page_errors = []
        page.on('pageerror', lambda error: page_errors.append(str(error)))
        tid = page.get_by_test_id
        inspector = tid('shot-inspector')
        provider = inspector.get_by_test_id('provider-select')

        def open_shot(title):
            expand = page.get_by_role('button', name='展开分镜', exact=True)
            if expand.is_visible():
                expand.click()
            card = page.locator('[data-testid^="storyboard-shot-"]').filter(has=page.get_by_text(title, exact=True))
            card.locator('.storyboard-preview').click()
            expect(inspector).to_be_visible()

        def choose_minimax():
            owner = inspector.locator('.agent-editing-owner').filter(has=tid('provider-settings'))
            start = owner.get_by_test_id('agent-editing-start')
            if start.is_visible():
                start.click()
                expect(owner.get_by_test_id('agent-editing-release')).to_be_visible()
            provider.click()
            page.get_by_role('option', name=re.compile('MiniMax')).click()
            expect(provider).to_contain_text('MiniMax')
            expect(inspector.get_by_test_id('model-select')).to_contain_text('MiniMax')

        page.goto(origin, wait_until='domcontentloaded')
        page.get_by_role('button', name=re.compile('^打开.*' + metadata['name'])).click()
        expect(tid('workbench')).to_be_visible()
        tid('workspace-canvas').click()
        open_shot(metadata['plainTitle'])
        expect(provider).to_contain_text('选择生成服务商')
        expect(tid('generation-issue')).to_have_count(0)
        expect(tid('video-generation-directory-error')).to_have_count(0)
        check_layout(inspector, 'no provider', REQUIRED)

        choose_minimax()
        expect(tid('last-frame-issue')).to_have_count(0)
        check_layout(inspector, 'MiniMax', CONFIGURED)
        check_model_badge(inspector)
        expect(tid('shot-frame-references')).to_have_count(0)

        open_shot(metadata['tailTitle'])
        choose_minimax()
        references = tid('shot-frame-references')
        expect(references).to_be_visible()
        expect(references.get_by_test_id('last-frame-issue')).to_have_text('所选模型不支持尾帧')
        expect(tid('generate-shot')).to_be_disabled()
        tail = references.get_by_test_id('last-frame-choice-' + metadata['tailId'])
        expect(tail).to_have_attribute('aria-pressed', 'true')
        expect(references.get_by_test_id('clear-last-frame')).to_be_visible()
        expect(references.get_by_test_id('video-frame-summary')).to_have_count(0)
        expect(references).not_to_contain_text(re.compile('素材标识与校验值|已选尾帧：|' + metadata['tailId']))
        check_layout(inspector, 'MiniMax with an unsupported persisted tail frame', CONFIGURED)
        check_model_badge(inspector)
        assert not page_errors, f'Browser page errors: {page_errors}'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dist-dir', type=Path, default=ROOT / 'apps/web/dist')
    parser.add_argument('--browser', default=shutil.which('google-chrome') or shutil.which('chromium')
                        or (str(MAC_CHROME) if MAC_CHROME.is_file() else None))
    args = parser.parse_args()
    if not (args.dist_dir / 'index.html').is_file():
        parser.error('Missing web build; run node scripts/tooling.ts build --channel=development first')
    token = secrets.token_hex(32)
    with TemporaryDirectory(prefix='mioon-inspector-layout-') as temp, TemporaryDirectory(prefix='mioon-inspector-home-') as home:
        folder = Path(temp).resolve()
        with (folder / 'fixture.log').open('w+', encoding='utf-8') as log:
            process = subprocess.Popen(['node', str(SYNTHETIC_FIXTURE), str(folder), str(args.dist_dir.resolve()), token],
                                       cwd=ROOT, env=test_env(HOME=home), stdout=log, stderr=subprocess.STDOUT)
            try:
                ready = folder / 'ready.json'
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline and process.poll() is None:
                    if ready.is_file():
                        try:
                            metadata = json.loads(ready.read_text(encoding='utf-8'))
                        except json.JSONDecodeError:
                            pass  # The fixture is still writing its readiness message.
                        else:
                            break
                    time.sleep(0.05)
                else:
                    log.seek(0)
                    raise RuntimeError('The synthetic fixture did not start:\n' + log.read())
                run_browser(metadata, token, args.browser)
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
