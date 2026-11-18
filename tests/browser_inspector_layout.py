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
MAC_ELECTRON_UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                   'AppleWebKit/537.36 (KHTML, like Gecko) '
                   'Chrome/152.0.0.0 Electron/44.7.0 Safari/537.36')


def check_topbar(page, state, height, inset, mode, scale=1, trailing=None):
    bar = page.locator('.workbench-topbar')
    required = ['.brand', '[data-testid="project-switcher"]',
                '[data-testid="workspace-canvas"]', '[data-testid="workspace-editing"]',
                '.topbar-status > summary', '[data-testid="jobs-button"]',
                '[data-testid="workbench-actions"]', '[data-testid="global-settings-open"]']
    if mode == 'editing':
        required.append('[data-testid="export-timeline"]')
    for selector in required:
        expect(bar.locator(selector)).to_be_visible()
    expect(page.get_by_test_id('workbench')).to_have_attribute('data-workspace-mode', mode)
    measurement = bar.evaluate('''async bar => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(resolve));
        const bounds = element => element.getBoundingClientRect().toJSON();
        const controls = [...bar.querySelectorAll('a, button, summary')].filter(element => {
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return box.width > 0 && box.height > 0 && style.visibility !== 'hidden';
        });
        return {
            bar: bounds(bar), padding: parseFloat(getComputedStyle(bar).paddingLeft),
            paddingRight: parseFloat(getComputedStyle(bar).paddingRight),
            brand: bounds(bar.querySelector('.brand')),
            groups: ['.brand', '[data-testid="project-switcher"]',
                     '.workbench-topbar-mode', '.topbar-actions'].map(selector => ({
                name: selector, bounds: bounds(bar.querySelector(selector)),
            })),
            controls: controls.map(element => ({
                name: element.dataset.testid || element.className || element.tagName,
                bounds: bounds(element),
            })),
        };
    }''')
    box = measurement['bar']
    assert abs(box['height'] - height) < 0.05, (state, measurement)
    assert abs(measurement['padding'] - inset) < 0.01, (state, measurement)
    if trailing is not None:
        assert abs(measurement['paddingRight'] - trailing) < 0.01, (state, measurement)
    assert abs(measurement['brand']['left'] - box['left'] - inset * scale) < 0.05, (state, measurement)
    for group in measurement['groups']:
        bounds = group['bounds']
        assert bounds['width'] > 0 and bounds['height'] > 0, (state, group)
        assert bounds['left'] >= box['left'] - 0.01 and bounds['right'] <= box['right'] + 0.01, (state, group, box)
        assert bounds['top'] >= box['top'] - 0.01 and bounds['bottom'] <= box['bottom'] + 0.01, (state, group, box)
    for one, other in combinations(measurement['groups'], 2):
        a, b = one['bounds'], other['bounds']
        overlap = min(a['right'], b['right']) - max(a['left'], b['left'])
        assert overlap <= 0.01, f"{state}: {one['name']} and {other['name']} overlap by {overlap:.3f}px"
    center = box['top'] + box['height'] / 2
    differences = []
    right_limit = box['right'] - (trailing or 0) + 0.01
    for control in measurement['controls']:
        control_box = control['bounds']
        assert control_box['right'] <= right_limit, (state, control, right_limit)
        delta = abs(control_box['top'] + control_box['height'] / 2 - center)
        differences.append(delta)
        assert delta < 1, f"{state}: {control['name']} differs from the topbar center by {delta:.3f}px"
    assert len(differences) >= len(required), (state, measurement)
    print(f'{state}: {len(differences)} visible controls, largest center difference '
          f'{max(differences):.3f}px, leading inset {measurement["padding"]:.2f}px, '
          f'trailing inset {measurement["paddingRight"]:.2f}px')


def check_topbar_scale_controls(page, metadata):
    page.set_viewport_size({'width': 1440, 'height': 900})
    cases = {case['scale']: case for case in metadata['chromeScaleCases']}
    # Return the real preference to 100% before opening the other host contexts.
    for scale in (0.9, 1.25, 1):
        chrome = cases[scale]
        percent = round(scale * 100)
        page.get_by_test_id('global-settings-open').click()
        appearance = page.get_by_test_id('settings-appearance')
        expect(appearance).to_be_visible()
        slider = appearance.get_by_test_id('appearance-scale').get_by_role('slider')
        expect(slider).to_be_enabled()
        slider.press('End' if percent == 125 else 'Home')
        if percent != 125:
            for _ in range(percent - 90):
                slider.press('ArrowRight')
        expect(appearance.locator('.settings-appearance-scale > output')).to_have_text(f'{percent}%')
        with page.expect_response(lambda response: response.request.method == 'PUT'
                                  and response.url.endswith('/api/ui-preferences')) as saved:
            appearance.get_by_test_id('appearance-save').click()
        assert saved.value.ok, 'The appearance preference did not save'
        expect(appearance.locator('.settings-appearance-actions > .wb-badge')).to_have_text('已保存')
        page.get_by_test_id('settings-center-close').click()
        expect(page.get_by_test_id('web-settings-dialog')).to_be_hidden()
        page.wait_for_function('scale => Math.abs(parseFloat(getComputedStyle(document.documentElement).zoom) - scale) < 0.0001', arg=scale)
        expected_inset = ((chrome['position']['x'] - chrome['controlOutset']
                           + chrome['controlGroupWidth']) / scale + chrome['gap'])
        assert abs(chrome['leadingInset'] - expected_inset) < 0.0001
        for mode in ('canvas', 'editing'):
            page.get_by_test_id('workspace-' + mode).click()
            label = f'macOS desktop 1440x900 {percent}% {mode}'
            check_topbar(page, label, chrome['topbarHeight'] * scale, chrome['leadingInset'], mode, scale)
            page.evaluate("document.documentElement.dataset.desktopFullscreen = 'true'")
            check_topbar(page, label + ' fullscreen', chrome['topbarHeight'] * scale, chrome['gap'], mode, scale)
            page.evaluate("document.documentElement.dataset.desktopFullscreen = 'false'")
            check_topbar(page, label + ' restored', chrome['topbarHeight'] * scale, chrome['leadingInset'], mode, scale)


WINDOWS_WCO_CONTROL_WIDTH = 138
WINDOWS_WCO_SCRIPT = '''Object.defineProperty(navigator, 'windowControlsOverlay', {configurable: true, value: {
  visible: true,
  getTitlebarAreaRect: () => ({x: 0, y: 0, width: Math.max(0, window.innerWidth - %d), height: 44,
    right: Math.max(0, window.innerWidth - %d), bottom: 44}),
  addEventListener() {},
  removeEventListener() {},
}});''' % (WINDOWS_WCO_CONTROL_WIDTH, WINDOWS_WCO_CONTROL_WIDTH)


def check_topbar_hosts(browser, metadata, token, fixture_rpc):
    chrome = metadata['windowChrome']
    assert chrome['leadingInset'] == (chrome['position']['x'] - chrome['controlOutset']
                                      + chrome['controlGroupWidth'] + chrome['gap'])
    origin = metadata['origin']
    hosts = [
        ('macOS desktop', MAC_ELECTRON_UA, 'mac'),
        ('Windows desktop', MAC_ELECTRON_UA.replace('Macintosh; Intel Mac OS X 10_15_7',
                                                 'Windows NT 10.0; Win64; x64'), 'windows'),
        ('Linux desktop', MAC_ELECTRON_UA.replace('Macintosh; Intel Mac OS X 10_15_7',
                                               'X11; Linux x86_64'), 'linux'),
        ('ordinary browser', MAC_ELECTRON_UA.replace(' Electron/44.7.0', ''), 'browser'),
    ]
    for host, user_agent, kind in hosts:
        context = browser.new_context(viewport={'width': 1440, 'height': 900}, user_agent=user_agent,
                                      locale='zh-CN', reduced_motion='reduce', service_workers='block')
        if kind == 'windows':
            context.add_init_script(WINDOWS_WCO_SCRIPT)
            # The preload bridge is absent in a plain browser context; capture the
            # page-reported caption band color instead of painting it natively.
            context.add_init_script("""window.__mioonWindowChrome = {setTitleBarColor(color) {
                (window.__mioonTitleBarColors || (window.__mioonTitleBarColors = [])).push(color);
            }};""")
        try:
            context.add_init_script("""localStorage.setItem('mioon.app-language.v1', JSON.stringify({version: 1, preference: 'zh-Hans'}))""")
            assert context.request.post(origin + '/api/login', data={'token': token}).ok, 'Topbar fixture login failed'
            context.route('**/*', fixture_rpc)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(origin, wait_until='domcontentloaded')
            page.get_by_role('button', name=re.compile('^打开.*' + metadata['name'])).click()
            expect(page.get_by_test_id('workbench')).to_be_visible()
            frame = page.locator('html')
            if kind == 'mac':
                expect(frame).to_have_attribute('data-desktop-frame', 'mac-inset')
            elif kind == 'windows':
                expect(frame).to_have_attribute('data-desktop-frame', 'win-overlay')
            else:
                expect(frame).not_to_have_attribute('data-desktop-frame', 'mac-inset')
                expect(frame).not_to_have_attribute('data-desktop-frame', 'win-overlay')
            sizes = [(1440, 900), (1050, 680), (800, 680), (1050, 480)] if kind == 'mac' else (
                [(1440, 900), (1050, 680)] if kind == 'windows' else [(1440, 900)])
            for width, height in sizes:
                page.set_viewport_size({'width': width, 'height': height})
                if kind == 'mac' and (width <= 800 or height == 480):
                    expect(page.get_by_test_id('workbench')).to_have_attribute('data-narrow', 'true')
                for mode in ('canvas', 'editing'):
                    page.get_by_test_id('workspace-' + mode).click()
                    label = f'{host} {width}x{height} {mode}'
                    if kind == 'mac':
                        check_topbar(page, label, chrome['topbarHeight'], chrome['leadingInset'], mode)
                    elif kind == 'windows':
                        # The renderer reserves exactly the live overlay width at
                        # both window sizes; the mock reports a constant band.
                        check_topbar(page, label, 44, 12, mode, trailing=WINDOWS_WCO_CONTROL_WIDTH)
                    else:
                        check_topbar(page, label, 44, 12, mode)
                    if kind == 'mac':
                        page.evaluate("document.documentElement.dataset.desktopFullscreen = 'true'")
                        check_topbar(page, label + ' fullscreen', chrome['topbarHeight'], chrome['gap'], mode)
                        page.evaluate("document.documentElement.dataset.desktopFullscreen = 'false'")
                        check_topbar(page, label + ' restored', chrome['topbarHeight'], chrome['leadingInset'], mode)
            if kind == 'windows':
                page.set_viewport_size({'width': 1440, 'height': 900})
                page.get_by_test_id('workspace-canvas').click()
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and not page.evaluate("(window.__mioonTitleBarColors || []).length > 0"):
                    time.sleep(0.05)
                assert page.evaluate("(window.__mioonTitleBarColors || []).length > 0"), 'The page never reported a caption band color'
                expected = page.evaluate("getComputedStyle(document.querySelector('.workbench-topbar')).backgroundColor")
                reported = page.evaluate("(window.__mioonTitleBarColors || []).slice(-1)[0]")
                assert reported == expected, f'Windows caption band color {reported!r} must match the top bar {expected!r}'

                def choose_theme(label):
                    page.get_by_test_id('global-settings-open').click()
                    appearance = page.get_by_test_id('settings-appearance')
                    expect(appearance).to_be_visible()
                    appearance.get_by_test_id('appearance-theme').get_by_text(label, exact=True).click()
                    with page.expect_response(lambda response: response.request.method == 'PUT'
                                              and response.url.endswith('/api/ui-preferences')) as saved:
                        appearance.get_by_test_id('appearance-save').click()
                    assert saved.value.ok, 'The appearance preference did not save'
                    page.get_by_test_id('settings-center-close').click()
                    expect(page.get_by_test_id('web-settings-dialog')).to_be_hidden()

                def latest_reported_after(count):
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline:
                        page.evaluate("window.dispatchEvent(new Event('resize'))")
                        colors = page.evaluate("(window.__mioonTitleBarColors || [])")
                        expected_color = page.evaluate("getComputedStyle(document.querySelector('.workbench-topbar')).backgroundColor")
                        if len(colors) > count and colors[-1] == expected_color:
                            return colors[-1]
                        time.sleep(0.05)
                    assert False, ('A theme change must report the settled caption band color',
                                   page.evaluate("window.__mioonTitleBarColors"),
                                   page.evaluate("getComputedStyle(document.querySelector('.workbench-topbar')).backgroundColor"))

                count = page.evaluate("(window.__mioonTitleBarColors || []).length")
                choose_theme('浅色')
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and page.evaluate("document.documentElement.dataset.theme") != 'light':
                    time.sleep(0.05)
                assert page.evaluate("document.documentElement.dataset.theme") == 'light'
                reported_light = latest_reported_after(count)
                expected_light = page.evaluate("getComputedStyle(document.querySelector('.workbench-topbar')).backgroundColor")
                assert reported_light == expected_light, (reported_light, expected_light)
                assert reported_light != reported, 'A theme change must repaint the caption band color'
                count = page.evaluate("(window.__mioonTitleBarColors || []).length")
                choose_theme('深色')
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and page.evaluate("document.documentElement.dataset.theme") != 'dark':
                    time.sleep(0.05)
                reported_dark = latest_reported_after(count)
                expected_dark = page.evaluate("getComputedStyle(document.querySelector('.workbench-topbar')).backgroundColor")
                assert reported_dark == expected_dark, (reported_dark, expected_dark)
                assert reported_dark != reported_light
                print(f'Windows caption band color: {reported!r} (dark) -> {reported_light!r} (light) -> {reported_dark!r} (restored dark)')
            if kind == 'mac':
                check_topbar_scale_controls(page, metadata)
            assert not errors, f'{host} page errors: {errors}'
        finally:
            context.close()


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


def check_input_limits(inspector):
    section = inspector.get_by_test_id('generation-input-summary')
    toggle = section.get_by_test_id('generation-input-toggle')
    details = section.get_by_test_id('generation-input-details')
    expect(toggle).to_have_attribute('aria-expanded', 'false')
    expect(details).to_be_hidden()
    closed = section.bounding_box()
    model = inspector.get_by_test_id('model-select').bounding_box()
    resolution = inspector.get_by_test_id('generation-resolution').bounding_box()
    assert abs(closed['height'] - model['height']) < 2, ('collapsed input limits vs model', closed, model)
    assert abs(closed['height'] - resolution['height']) < 2, ('collapsed input limits vs resolution', closed, resolution)

    toggle.click()
    expect(toggle).to_have_attribute('aria-expanded', 'true')
    expect(details).to_be_visible()
    expanded = section.evaluate('''section => {
        const details = section.querySelector('[data-testid="generation-input-details"]');
        const trigger = section.querySelector('[data-testid="generation-input-toggle"]');
        return {
            section: section.getBoundingClientRect().height,
            trigger: trigger.getBoundingClientRect().height,
            details: details.getBoundingClientRect().height,
            overflow: details.scrollHeight - details.clientHeight,
        };
    }''')
    assert abs(expanded['trigger'] - closed['height']) < 2, expanded
    assert abs(expanded['section'] - expanded['trigger'] - expanded['details']) < 2, expanded
    assert expanded['details'] > 0 and expanded['overflow'] <= 1, expanded
    toggle.click()
    expect(details).to_be_hidden()
    assert abs(section.bounding_box()['height'] - closed['height']) < 2
    print(f"input limits: {closed['height']:.2f}px closed, {expanded['details']:.2f}px of additional content")


def check_subject_heading(inspector):
    group = inspector.get_by_test_id('shot-subject-and-style')
    title = group.get_by_role('button', name='主体与风格', exact=True)
    help_button = group.get_by_test_id('shot-subject-planning-help')
    expect(group.get_by_text('主体与风格', exact=True)).to_have_count(1)
    expect(help_button).to_have_accessible_name('生成时需另选主体版本')
    title_box, help_box = title.bounding_box(), help_button.bounding_box()
    delta = abs(title_box['y'] + title_box['height'] / 2 - help_box['y'] - help_box['height'] / 2)
    assert delta < 2 and 0 <= help_box['x'] - title_box['x'] - title_box['width'] < 8, (title_box, help_box)
    title.click()
    expect(title).to_have_attribute('aria-expanded', 'false')
    expect(help_button).to_be_visible()
    title.click()
    expect(title).to_have_attribute('aria-expanded', 'true')


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
        check_input_limits(inspector)
        check_subject_heading(inspector)

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
        check_topbar_hosts(browser, metadata, token, fixture_rpc)


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
