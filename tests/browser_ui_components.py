"""Real Chromium keyboard/focus acceptance for the shadcn/Base UI renderer.

Uses the production renderer and real loopback HTTP/SQLite backend against a
temporary copy of the synthetic demo. No intercepted state or paid providers.
Run: python tests/browser_ui_components.py
Optional WB_UI_CASES is a comma-separated list of case IDs for focused reruns.
"""
import hashlib
import json
import os
import pathlib
import re
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
import traceback
import urllib.request

from playwright.sync_api import expect, sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = pathlib.Path(os.environ.get('WB_UI_EVIDENCE', str(ROOT / 'evidence/v3-ui-components')))
TOKEN = 'base-ui-isolated-browser-test-token-no-live-provider'
PID = json.loads((ROOT / 'evidence/v2-demo/demo-project.json').read_text())['projectId']
OUT.mkdir(parents=True, exist_ok=True)


def rpc(base, operation, params=None):
    req = urllib.request.Request(base + '/api/rpc', data=json.dumps({'operation': operation, 'input': params or {}}).encode(), headers={'content-type': 'application/json', 'authorization': 'Bearer ' + TOKEN})
    with urllib.request.urlopen(req, timeout=30) as response:
        result = json.load(response)
    assert result['ok'], result
    return result['data']


def poll(fn, predicate, seconds=12):
    end = time.monotonic() + seconds
    value = None
    while time.monotonic() < end:
        value = fn()
        if predicate(value):
            return value
        time.sleep(.1)
    raise AssertionError('Timed out: ' + str(value)[:1500])


def copy_demo(target):
    source = ROOT / 'examples/multitrack-project'
    shutil.copytree(source, target, ignore=shutil.ignore_patterns('access-token', 'server.lock', '*.sqlite', '*.sqlite-wal', '*.sqlite-shm'))
    # Consistent read-only backup also includes a source WAL without mutating it.
    with sqlite3.connect(f'file:{source / "workbench.sqlite"}?mode=ro', uri=True) as src:
        with sqlite3.connect(target / 'workbench.sqlite') as dst:
            src.backup(dst)


def start(data):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    handle = open(OUT / 'server.log', 'w')
    proc = subprocess.Popen(['node', 'apps/server/src/cli.mjs'], cwd=ROOT, env={**os.environ, 'PORT': str(port), 'WB_TOKEN': TOKEN, 'WB_DATA_DIR': str(data), 'VIDEO_WORKBENCH_ENABLE_LIVE_PROVIDER': '0', 'RUNWAYML_API_SECRET': '', 'RUNWAY_MAX_GENERATIONS': '0'}, stdout=handle, stderr=subprocess.STDOUT)
    base = f'http://127.0.0.1:{port}'
    for _ in range(150):
        if proc.poll() is not None:
            raise RuntimeError('Backend exited: ' + (OUT / 'server.log').read_text())
        try:
            with urllib.request.urlopen(base + '/health', timeout=1) as response:
                if response.status == 200:
                    return proc, handle, base
        except Exception:
            time.sleep(.1)
    raise RuntimeError('Backend health timed out')


def login(page, base):
    page.goto(base + '/?project=' + PID)
    page.get_by_label('访问令牌', exact=True).fill(TOKEN)
    page.get_by_role('button', name='进入工作台', exact=True).click()
    expect(page.get_by_test_id('workbench')).to_be_visible(timeout=15000)
    expect(page.get_by_test_id('timeline-panel')).to_be_visible()


def active(page):
    return page.evaluate('''() => {const e = document.activeElement;return {tag:e?.tagName,role:e?.getAttribute('role'),id:e?.id,testId:e?.getAttribute('data-testid'),text:e?.textContent?.trim().slice(0,100),label:e?.getAttribute('aria-label')}}''')


def assert_button_contrast(button):
    expect(button).to_be_enabled()
    colors = button.evaluate('(e) => {const s = getComputedStyle(e); return {foreground:s.color,background:s.backgroundColor}}')
    def luminance(css):
        assert css.startswith('rgb('), colors
        rgb = [float(x) / 255 for x in re.findall(r'[\d.]+', css)]
        assert len(rgb) == 3, colors
        linear = [x / 12.92 if x <= .04045 else ((x + .055) / 1.055) ** 2.4 for x in rgb]
        return sum(x * weight for x, weight in zip(linear, [.2126, .7152, .0722]))
    foreground, background = luminance(colors['foreground']), luminance(colors['background'])
    ratio = (max(foreground, background) + .05) / (min(foreground, background) + .05)
    assert ratio >= 4.5, {'contrastRatio': ratio, **colors}
    return {**colors, 'contrastRatio': round(ratio, 2), 'requiredMinimum': 4.5}


def assert_trapped(page, dialog, rounds=10):
    visits = []
    for key in ['Tab'] * rounds + ['Shift+Tab'] * rounds:
        page.keyboard.press(key)
        # Base UI focus guards briefly receive focus before their redirect runs.
        # Await the settled destination and still forbid any background control.
        page.wait_for_function("() => [...document.querySelectorAll('[role=dialog]')].some(d => d.contains(document.activeElement))", timeout=1500)
        assert dialog.evaluate('(d) => d.contains(document.activeElement)'), {'key': key, 'active': active(page)}
        visits.append({'key': key, **active(page)})
    assert len({json.dumps(v, sort_keys=True) for v in visits}) >= 2
    return visits


def open_new_project(page):
    switcher = page.get_by_test_id('project-switcher')
    switcher.focus()
    page.keyboard.press('ArrowDown')
    expect(page.get_by_role('menu')).to_be_visible()
    page.keyboard.press('End')
    expect(page.get_by_role('menuitem', name='新建项目', exact=True)).to_be_focused()
    page.keyboard.press('Enter')
    dialog = page.get_by_role('dialog', name='开始一个新故事', exact=True)
    expect(dialog).to_be_visible()
    return dialog


def menu_keyboard(page, state, requests):
    trigger = page.get_by_test_id('project-switcher')
    trigger.focus()
    page.keyboard.press('ArrowDown')
    menu = page.get_by_role('menu')
    expect(menu).to_be_visible()
    expect(menu.get_by_role('menuitem').first).to_be_focused()
    page.keyboard.press('ArrowDown')
    expect(menu.get_by_role('menuitem').nth(1)).to_be_focused()
    page.screenshot(path=str(OUT / '01-project-menu-keyboard.png'), full_page=True)
    page.keyboard.press('Escape')
    expect(menu).not_to_be_visible()
    expect(trigger).to_be_focused()
    trigger.press('ArrowDown')
    page.keyboard.press('Home')
    page.keyboard.press('Enter')
    expect(menu).not_to_be_visible()
    expect(trigger).to_be_focused()
    assert state()['project']['id'] == PID
    assert not mutations(requests)
    return {'keyboard': ['ArrowDown', 'Home', 'Enter', 'Escape'], 'focusRestored': True}


def new_project_dialog(page, state, requests):
    before = rpc(BASE, 'project.list')
    dialog = open_new_project(page)
    expect(page.get_by_test_id('project-name')).to_be_focused()
    page.get_by_test_id('project-name').fill('Must not create: cancelled keyboard regression')
    visits = assert_trapped(page, dialog)
    page.screenshot(path=str(OUT / '02-new-project-focus-trap.png'), full_page=True)
    page.keyboard.press('Escape')
    expect(dialog).not_to_be_visible()
    expect(page.get_by_test_id('project-switcher')).to_be_focused()
    assert rpc(BASE, 'project.list') == before
    dialog = open_new_project(page)
    expect(page.get_by_test_id('project-name')).to_have_value('')
    page.get_by_test_id('project-name').fill('Still must not create')
    dialog.get_by_role('button', name='关闭对话框', exact=True).focus()
    page.keyboard.press('Enter')
    expect(dialog).not_to_be_visible()
    expect(page.get_by_test_id('project-switcher')).to_be_focused()
    assert rpc(BASE, 'project.list') == before
    assert not mutations(requests)
    return {'focusVisits': visits, 'projectsUnchanged': True, 'dismissal': ['Escape', 'close button'], 'reopened': True}


def jobs_dialog(page, state, requests):
    trigger = page.get_by_test_id('jobs-button')
    trigger.focus()
    trigger.press('Enter')
    dialog = page.get_by_role('dialog', name='生成任务', exact=True)
    expect(dialog).to_be_visible()
    visits = assert_trapped(page, dialog, 5)
    page.screenshot(path=str(OUT / '03-jobs-drawer-keyboard.png'), full_page=True)
    page.keyboard.press('Escape')
    expect(dialog).not_to_be_visible()
    expect(trigger).to_be_focused()
    trigger.press('Enter')
    expect(dialog).to_be_visible()
    page.get_by_role('button', name='关闭生成任务', exact=True).press('Enter')
    expect(dialog).not_to_be_visible()
    expect(trigger).to_be_focused()
    assert not mutations(requests)
    return {'focusVisits': visits, 'focusRestored': True, 'reopened': True}


def select_keyboard(page, trigger, target, keys):
    value = trigger.locator('[data-slot="select-value"]')
    previous = value.inner_text()
    trigger.focus()
    page.keyboard.press('ArrowDown')
    popup = page.get_by_role('listbox')
    expect(popup).to_be_visible()
    for key in keys:
        page.keyboard.press(key)
    page.keyboard.press('Enter')
    expect(popup).not_to_be_visible()
    expect(trigger).to_contain_text(target)
    expect(trigger).to_be_focused()
    chosen = value.inner_text()
    trigger.press('ArrowDown')
    expect(popup).to_be_visible()
    page.keyboard.press('Home')
    page.keyboard.press('Escape')
    expect(popup).not_to_be_visible()
    expect(value).to_have_text(chosen)
    expect(trigger).to_be_focused()
    return {'previous': previous, 'chosen': chosen, 'keyboard': ['ArrowDown', *keys, 'Enter', 'ArrowDown', 'Home', 'Escape'], 'focusRestored': True}


def shot_selects(page, state, requests):
    before = state()
    expect(page.get_by_test_id('shot-inspector')).to_be_visible()
    ratio = select_keyboard(page, page.get_by_role('combobox', name='画面比例', exact=True), '9:16', ['Home'])
    duration = select_keyboard(page, page.get_by_role('combobox', name='镜头时长', exact=True), '4 秒', ['4'])
    page.screenshot(path=str(OUT / '04-shot-selects-keyboard.png'), full_page=True)
    assert state()['shots'] == before['shots']
    assert not mutations(requests)
    return {'aspectRatio': ratio, 'duration': duration, 'draftNotPersisted': True}


def inspector_tabs(page, state, requests):
    inspector = page.get_by_test_id('shot-inspector')
    settings = inspector.get_by_role('tab', name='创作参数', exact=True)
    versions = inspector.get_by_role('tab', name='版本历史', exact=False)
    settings.focus()
    settings.press('ArrowRight')
    expect(versions).to_be_focused()
    # Base UI uses manual activation by default: arrows move roving focus,
    # Enter chooses the focused tab without prematurely switching content.
    expect(settings).to_have_attribute('aria-selected', 'true')
    expect(versions).to_have_attribute('aria-selected', 'false')
    versions.press('Enter')
    expect(versions).to_have_attribute('aria-selected', 'true')
    expect(settings).to_have_attribute('aria-selected', 'false')
    expect(settings).to_have_attribute('tabindex', '-1')
    expect(versions).to_have_attribute('tabindex', '0')
    expect(inspector.get_by_role('tabpanel')).to_be_visible()
    page.screenshot(path=str(OUT / '05-inspector-roving-tabs.png'), full_page=True)
    versions.press('ArrowLeft')
    expect(settings).to_be_focused()
    settings.press('Enter')
    expect(settings).to_have_attribute('aria-selected', 'true')
    expect(page.get_by_role('combobox', name='画面比例', exact=True)).to_be_visible()
    assert not mutations(requests)
    return {'rovingTabindex': True, 'arrowMovesFocus': True, 'enterActivatesPanel': True}


def panels_keyboard(page, state, requests):
    results = []
    for panel, toggle, reopen, content in [
        ('assets', 'toggle-assets', 'reopen-assets', 'asset-panel'),
        ('inspector', 'toggle-inspector', 'reopen-inspector', 'shot-inspector'),
    ]:
        button = page.get_by_test_id(toggle)
        button.focus()
        expect(button).to_have_attribute('aria-expanded', 'true')
        button.press('Enter')
        expect(page.get_by_test_id(content)).not_to_be_visible()
        opener = page.get_by_test_id(reopen)
        expect(opener).to_be_visible()
        opener.focus()
        opener.press('Enter')
        expect(page.get_by_test_id(content)).to_be_visible()
        expect(button).to_have_attribute('aria-expanded', 'true')
        results.append(panel)
    button = page.get_by_test_id('toggle-timeline')
    button.focus()
    button.press('Space')
    expect(button).to_have_attribute('aria-expanded', 'false')
    expect(page.get_by_test_id('timeline-playhead')).not_to_be_visible()
    expect(button).to_be_focused()
    button.press('Space')
    expect(button).to_have_attribute('aria-expanded', 'true')
    expect(page.get_by_test_id('timeline-playhead')).to_be_visible()
    assert not mutations(requests)
    return {'keyboardReachablePanels': results + ['timeline']}


def slider_keyboard(page, state, requests):
    slider = page.locator('.timeline-zoom-slider').get_by_role('slider')
    expect(slider).to_have_count(1)
    before = float(slider.input_value())
    slider.focus()
    page.keyboard.press('ArrowRight')
    expect(slider).to_have_value(str(int(before + 1)))
    page.keyboard.press('End')
    expect(slider).to_have_value('220')
    page.keyboard.press('Home')
    expect(slider).to_have_value('28')
    page.keyboard.press('ArrowRight')
    expect(slider).to_have_value('29')
    page.screenshot(path=str(OUT / '06-timeline-slider-keyboard.png'), full_page=True)
    assert not mutations(requests)
    return {'initial': before, 'arrowRight': before + 1, 'end': 220, 'home': 28, 'final': 29}


def ruler_keyboard(page, state, requests):
    ruler = page.get_by_role('slider', name='时间标尺', exact=True)
    ruler.focus()
    checks = [('Home', 0), ('ArrowLeft', 0), ('ArrowRight', 1), ('PageUp', 31), ('PageDown', 1), ('End', 18000), ('ArrowRight', 18000), ('Home', 0)]
    for key, expected in checks:
        page.keyboard.press(key)
        expect(ruler).to_have_attribute('aria-valuenow', str(expected))
        expect(page.get_by_test_id('timeline-playhead')).to_have_value(str(expected))
    assert not mutations(requests)
    return {'keysAndFrames': checks, 'boundsRespected': True}


def switches_keyboard(page, state, requests):
    before = state()['timeline']
    visual = next(t for t in before['tracks'] if t['kind'] == 'video')
    audio = next(t for t in before['tracks'] if t['kind'] == 'audio')
    results = []
    for track, label, field in [(visual, '显示 ', 'hidden'), (audio, '静音 ', 'muted')]:
        control = page.get_by_role('switch', name=label + track['name'], exact=True)
        control.focus()
        original = track[field]
        control.press('Space')
        changed = poll(state, lambda v: next(t for t in v['timeline']['tracks'] if t['id'] == track['id'])[field] != original)
        expect(control).to_have_attribute('aria-checked', str(not (not original if field == 'hidden' else original)).lower())
        expect(control).to_be_focused()
        expect(control).to_be_enabled()
        control.press('Space')
        poll(state, lambda v: next(t for t in v['timeline']['tracks'] if t['id'] == track['id'])[field] == original)
        results.append({'trackId': track['id'], 'field': field, 'toggledAndRestored': True})
    assert len([r for r in requests if r['operation'] == 'timeline.track.update']) == 4
    assert state()['assets'] == INITIAL['assets']
    return {'switches': results, 'exactMutationCount': 4}


def track_select(page, state, requests):
    before = state()['timeline']
    track_names = {t['id']: t['name'] for t in before['tracks']}
    visuals = [t for t in before['tracks'] if t['kind'] == 'video']
    clip = next(c for c in before['clips'] if c['trackId'] == visuals[0]['id'])
    page.get_by_test_id('timeline-clip-' + clip['id']).click()
    expect(page.get_by_test_id('clip-inspector')).to_be_visible()
    result = select_keyboard(page, page.get_by_role('combobox', name='所在轨道', exact=True), visuals[-1]['name'], ['End'])
    assert state()['timeline'] == before
    assert not mutations(requests)
    return {'track': result, 'persistedTrackUnchanged': track_names[clip['trackId']]}


def confirmation_dirty(page, state, requests):
    before = state()
    first, second = before['timeline']['clips'][:2]
    current = page.get_by_test_id('timeline-clip-' + first['id'])
    other = page.get_by_test_id('timeline-clip-' + second['id'])
    current.click()
    page.get_by_test_id('clip-duration').fill('77')
    dialog = page.get_by_role('dialog', name='请确认此操作', exact=True)
    for dismiss in ['Escape', '取消']:
        other.click()
        expect(dialog).to_be_visible()
        expect(dialog.get_by_role('button', name='取消', exact=True)).to_be_focused()
        assert_trapped(page, dialog, 3)
        page.screenshot(path=str(OUT / ('07-dirty-confirm-' + ('escape' if dismiss == 'Escape' else 'cancel') + '.png')), full_page=True)
        if dismiss == 'Escape':
            page.keyboard.press('Escape')
        else:
            dialog.get_by_role('button', name='取消', exact=True).press('Enter')
        expect(dialog).not_to_be_visible()
        expect(page.get_by_test_id('clip-duration')).to_have_value('77')
        expect(current).to_have_attribute('aria-pressed', 'true')
        assert state()['timeline'] == before['timeline']
        assert not mutations(requests)
    other.click()
    expect(dialog).to_be_visible()
    page.get_by_test_id('confirm-action').press('Enter')
    expect(dialog).not_to_be_visible()
    expect(other).to_have_attribute('aria-pressed', 'true')
    expect(page.get_by_test_id('clip-duration')).to_have_value(str(second['durationFrames']))
    assert state()['timeline'] == before['timeline']
    assert not mutations(requests)
    return {'escapePreservesDraft': True, 'cancelPreservesDraft': True, 'reopen': True, 'continueDiscardsOnlyUnsavedDraft': True}


def confirmation_removal(page, state, requests):
    before = state()
    clip = before['timeline']['clips'][0]
    page.get_by_test_id('timeline-clip-' + clip['id']).click()
    remove = page.get_by_test_id('remove-clip')
    dialog = page.get_by_role('dialog', name='请确认此操作', exact=True)
    for dismiss in ['Escape', '取消']:
        remove.focus()
        remove.press('Enter')
        expect(dialog).to_be_visible()
        expect(dialog.get_by_role('button', name='取消', exact=True)).to_be_focused()
        if dismiss == 'Escape':
            page.keyboard.press('Escape')
        else:
            dialog.get_by_role('button', name='取消', exact=True).press('Enter')
        expect(dialog).not_to_be_visible()
        expect(remove).to_be_focused()
        assert state()['timeline'] == before['timeline']
        assert not mutations(requests)
    remove.press('Enter')
    expect(dialog).to_be_visible()
    contrast = assert_button_contrast(page.get_by_test_id('confirm-action'))
    page.screenshot(path=str(OUT / '08-explicit-clip-removal-confirmation.png'), full_page=True)
    page.get_by_test_id('confirm-action').press('Enter')
    expect(dialog).not_to_be_visible()
    after = poll(state, lambda v: len(v['timeline']['clips']) == len(before['timeline']['clips']) - 1)
    assert {c['id'] for c in after['timeline']['clips']} == {c['id'] for c in before['timeline']['clips']} - {clip['id']}
    assert after['assets'] == before['assets']
    assert after['shots'] == before['shots']
    assert after['versions'] == before['versions']
    assert after['timeline']['tracks'] == before['timeline']['tracks']
    assert after['timeline']['revision'] == before['timeline']['revision'] + 1
    assert len([r for r in requests if r['operation'] == 'timeline.clip.remove']) == 1
    # A subsequent confirmation still works after an accepted deletion.
    page.get_by_test_id('timeline-clip-' + after['timeline']['clips'][0]['id']).click()
    page.get_by_test_id('remove-clip').press('Enter')
    expect(dialog).to_be_visible()
    page.keyboard.press('Escape')
    expect(dialog).not_to_be_visible()
    assert state()['timeline'] == after['timeline']
    assert len(mutations(requests)) == 1
    return {'removedClipId': clip['id'], 'assetIdRetained': clip['assetId'], 'exactMutationCount': 1, 'revisionDelta': 1, 'reopenedAfterSuccess': True, 'continueButtonContrast': contrast}


def mutations(requests):
    return [r for r in requests if r['operation'] not in ['project.get', 'project.list', 'provider.list']]


CASES = [
    ('menu', menu_keyboard), ('new-project', new_project_dialog), ('jobs', jobs_dialog),
    ('shot-selects', shot_selects), ('inspector-tabs', inspector_tabs),
    ('panels', panels_keyboard), ('slider', slider_keyboard), ('ruler', ruler_keyboard), ('switches', switches_keyboard),
    ('track-select', track_select), ('dirty-confirmation', confirmation_dirty),
    ('removal-confirmation', confirmation_removal),
]


def main():
    global BASE, INITIAL
    selected = set(filter(None, os.environ.get('WB_UI_CASES', '').split(',')))
    report = {'status': 'RUNNING', 'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'source': 'real Chromium + production Vite renderer + isolated real HTTP/SQLite backend', 'liveProvidersEnabled': False, 'cases': [], 'pageErrors': [], 'nativeDialogs': []}
    index = ROOT / 'apps/web/dist/index.html'
    report['rendererBuild'] = {'indexSha256': hashlib.sha256(index.read_bytes()).hexdigest(), 'mtimeUtc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(index.stat().st_mtime))}
    report['rendererBuild']['assets'] = [{'path': path.relative_to(ROOT / 'apps/web/dist').as_posix(), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in sorted((ROOT / 'apps/web/dist/assets').glob('*')) if path.suffix in ['.js', '.css']]
    with tempfile.TemporaryDirectory(prefix='workbench-base-ui-keyboard-') as temp:
        data = pathlib.Path(temp) / 'data'
        copy_demo(data)
        proc, handle, BASE = start(data)
        try:
            seed = rpc(BASE, 'project.get', {'projectId': PID})
            # The timeline-only demo intentionally has no shots. Add one real
            # persisted fixture through the supported API, never mocked state.
            if not seed['shots']:
                reference = next(a for a in seed['assets'] if a['mimeType'].startswith('image/'))
                fixture = rpc(BASE, 'shot.create', {'projectId': PID, 'title': 'Keyboard fixture', 'prompt': 'Synthetic local UI acceptance only', 'duration': 2, 'aspectRatio': '16:9', 'referenceAssetIds': [reference['id']], 'position': {'x': 350, 'y': 80}})
                report['fixtureSetup'] = {'operation': 'shot.create', 'shotId': fixture['id'], 'scope': 'temporary copied database only'}
            INITIAL = rpc(BASE, 'project.get', {'projectId': PID})
            report['initial'] = {'projectId': PID, 'clips': len(INITIAL['timeline']['clips']), 'assets': len(INITIAL['assets']), 'timelineRevision': INITIAL['timeline']['revision']}
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(executable_path=shutil.which('chromium'), headless=True, chromium_sandbox=True)
                report['chromiumVersion'] = browser.version
                for name, test in CASES:
                    if selected and name not in selected:
                        continue
                    context = browser.new_context(viewport={'width': 1600, 'height': 1050}, reduced_motion='reduce')
                    page = context.new_page()
                    page.set_default_timeout(7000)
                    requests = []
                    page.on('pageerror', lambda error: report['pageErrors'].append(str(error)))
                    page.on('dialog', lambda dialog: (report['nativeDialogs'].append({'type': dialog.type, 'message': dialog.message}), dialog.dismiss()))
                    def record(request):
                        if request.url.endswith('/api/rpc') and request.method == 'POST':
                            requests.append(request.post_data_json)
                    page.on('request', record)
                    result = {'id': name, 'status': 'RUNNING'}
                    began = time.monotonic()
                    try:
                        login(page, BASE)
                        result['details'] = test(page, lambda: rpc(BASE, 'project.get', {'projectId': PID}), requests)
                        result['status'] = 'PASS'
                    except Exception as error:
                        result.update(status='FAIL', error=str(error), traceback=traceback.format_exc(), activeElement=active(page))
                        page.screenshot(path=str(OUT / ('failure-' + name + '.png')), full_page=True)
                        (OUT / ('failure-' + name + '.aria.txt')).write_text(page.locator('body').aria_snapshot())
                    finally:
                        result['durationSeconds'] = round(time.monotonic() - began, 2)
                        result['mutations'] = mutations(requests)
                        report['cases'].append(result)
                        (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
                        print(json.dumps({k: result[k] for k in ['id', 'status', 'durationSeconds']} | ({'error': result['error']} if 'error' in result else {}), ensure_ascii=False), flush=True)
                        context.close()
                browser.close()
            report['final'] = rpc(BASE, 'project.get', {'projectId': PID})
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            handle.close()
    report['status'] = 'PASS' if all(c['status'] == 'PASS' for c in report['cases']) and not report['pageErrors'] and not report['nativeDialogs'] else 'FAIL'
    report['completedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({'status': report['status'], 'cases': len(report['cases']), 'failures': [c['id'] for c in report['cases'] if c['status'] != 'PASS'], 'pageErrors': report['pageErrors'], 'evidence': str(OUT)}, ensure_ascii=False), flush=True)
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
