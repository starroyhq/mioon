"""Synthetic UI-E1 component acceptance, using the repository's Playwright.

The fixture is a standalone loopback page: it starts no application, project
host, RPC client or file writer. Media requests go to the loopback server's
repository-example routes only.
"""
import argparse
import hashlib
import json
import platform
import re
import shutil
import sys
import traceback
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

EXPECTED_COPY_MOVE = {
    'clipId': 'clip-02', 'nodeId': '55555555-5555-4555-8555-000000000002',
    'segmentGroupId': '66666666-6666-4666-8666-000000000002',
    'targetTrackId': 'track-overlay', 'targetStartFrame': 630, 'timelineRevision': 7,
}
EXPECTED_APPLIED_VERSION = '44444444-4444-4444-8444-000000000001'
EXPECTED_BOARD_VERSION = '44444444-4444-4444-8444-000000000002'

LOCALES = {
    'zh-Hans': {'shotTitle': '镜头 02 · 窗口剪影', 'follow': '跟随画板 · V2', 'locked': '锁定 · V1', 'reveal': '在画板中查看',
                'main': '主轨', 'mainMarker': 'V1 · 主轨', 'detached': '未挂靠',
                'followSuffix': '· V2', 'lockedSuffix': '· 锁定 V1', 'placeholderSuffix': '· 待生成（占位 4 秒）',
                'dialog': '复制成新镜头再挪？', 'notice': '已从主轨移除 02 窗口剪影'},
    'zh-Hant': {'shotTitle': '鏡頭 02 · 窗口剪影', 'follow': '跟隨畫板 · V2', 'locked': '鎖定 · V1', 'reveal': '在畫板中查看',
                'main': '主軌', 'mainMarker': 'V1 · 主軌', 'detached': '未掛靠',
                'followSuffix': '· V2', 'lockedSuffix': '· 鎖定 V1', 'placeholderSuffix': '· 待生成（佔位 4 秒）',
                'dialog': '複製成新鏡頭再挪？', 'notice': '已從主軌移除 02 窗口剪影'},
    'en': {'shotTitle': 'Shot 02 · 窗口剪影', 'follow': 'Follow board · V2', 'locked': 'Locked · V1', 'reveal': 'View on board',
           'main': 'Main track', 'mainMarker': 'V1 · Main track', 'detached': 'Not anchored',
           'followSuffix': '· V2', 'lockedSuffix': '· Locked V1', 'placeholderSuffix': '· Not generated (4 s placeholder)',
           'dialog': 'Copy as a new shot and move?', 'notice': 'Removed 02 窗口剪影 from the main track'},
    'ja': {'shotTitle': 'ショット 02 · 窗口剪影', 'follow': 'ボードに追従 · V2', 'locked': 'ロック · V1', 'reveal': 'ボードで表示',
           'main': 'メイントラック', 'mainMarker': 'V1 · メイントラック', 'detached': '未接続',
           'followSuffix': '· V2', 'lockedSuffix': '· ロック V1', 'placeholderSuffix': '· 未生成（4 秒のプレースホルダー）',
           'dialog': '新しいショットとして複製して移動しますか？', 'notice': 'メイントラックから02 窗口剪影を削除しました'},
}


def running_animations(page):
    return page.evaluate('''() => document.getAnimations().filter(animation =>
      animation.playState === 'running' && animation.effect?.getTiming().iterations === Infinity
    ).map(animation => animation.animationName ?? 'unknown')''')


def wait_fixture(page, scenario):
    expect(page.locator('[data-fixture-scenario]')).to_have_attribute('data-fixture-scenario', scenario)
    page.wait_for_function('''() => {
      const timeline = document.querySelector('[data-testid="timeline-panel"]');
      return Boolean(window.__editUiFixture) && timeline && timeline.getBoundingClientRect().height > 0
        && [...document.querySelectorAll('.timeline-clip')].length > 0;
    }''')
    page.evaluate('''async () => {await document.fonts.ready;for(let i=0;i<20;i++)await new Promise(requestAnimationFrame);}''')


def switch(page, scenario):
    page.evaluate('value => window.__editUiFixture.setScenario(value)', scenario)
    wait_fixture(page, scenario)


def geometry(page):
    rows = page.evaluate('''() => {
      const content = document.querySelector('.timeline-content');
      const bounds = content.getBoundingClientRect();
      return [...document.querySelectorAll('.edit-ui-anchor-link')].map(group => {
        const line = group.querySelector('line'), dot = group.querySelector('circle');
        const id = group.dataset.anchorId, kind = group.dataset.anchorKind;
        const source = content.querySelector(`[data-testid="${kind === 'cue' ? 'subtitle-cue-' : 'timeline-clip-'}${id}"]`);
        const target = content.querySelector(`[data-testid="timeline-clip-${group.dataset.anchorTarget}"]`);
        const sourceRect = source.getBoundingClientRect(), targetRect = target.getBoundingClientRect();
        const x = Number(line.getAttribute('x1')), top = Number(line.getAttribute('y1')), bottom = Number(line.getAttribute('y2'));
        return {id, kind, x, top, bottom,
          expectedX: sourceRect.left - bounds.left, expectedTop: sourceRect.bottom - bounds.top + 2,
          expectedBottom: targetRect.top - bounds.top + 8,
          dotX: Number(dot.getAttribute('cx')), dotY: Number(dot.getAttribute('cy')),
          sourceScreenX: sourceRect.left, dotScreenX: dot.getBoundingClientRect().left};
      });
    }''')
    return rows


def assert_anchor_geometry(rows):
    assert len(rows) == 3, f'Expected three attached anchors, got {json.dumps(rows)}'
    for row in rows:
        assert abs(row['x'] - row['expectedX']) <= 1.2, 'Anchor column is not on its source start: ' + json.dumps(row)
        assert abs(row['top'] - row['expectedTop']) <= 1.2, 'Anchor line does not start below its source: ' + json.dumps(row)
        assert abs(row['bottom'] - row['expectedBottom']) <= 1.2, 'Anchor dot is not on the main-track segment: ' + json.dumps(row)
        assert row['dotX'] == row['x'] and row['dotY'] == row['bottom'], 'Anchor dot and line disagree: ' + json.dumps(row)


def relative_anchor_positions(page):
    """Dot position relative to its own source start and target top; both move with
    the scrolled content, so these values must not change while scrolling."""
    return page.evaluate('''() => {
      const content = document.querySelector('.timeline-content');
      return [...document.querySelectorAll('.edit-ui-anchor-link')].map(group => {
        const dot = group.querySelector('.edit-ui-anchor-dot').getBoundingClientRect();
        const id = group.dataset.anchorId, kind = group.dataset.anchorKind;
        const source = content.querySelector(`[data-testid="${kind === 'cue' ? 'subtitle-cue-' : 'timeline-clip-'}${id}"]`);
        const target = content.querySelector(`[data-testid="timeline-clip-${group.dataset.anchorTarget}"]`);
        const sourceRect = source.getBoundingClientRect(), targetRect = target.getBoundingClientRect();
        return {id, kind, x: dot.x + dot.width / 2 - sourceRect.left, y: dot.y + dot.height / 2 - targetRect.top};
      });
    }''')


def check_main_scenario(page, result):
    expect(page.get_by_test_id('timeline-track-track-main')).to_have_attribute('data-main-track', 'true')
    main_header = page.get_by_test_id('timeline-track-track-main').locator('.track-label')
    expect(main_header).to_contain_text('主轨')
    expect(main_header.locator('.track-kind')).to_have_text('V1')
    expect(page.get_by_test_id('edit-ui-shot-bar')).to_be_visible()
    expect(page.get_by_test_id('edit-ui-shot-name')).to_contain_text('镜头 02 · 窗口剪影')
    expect(page.get_by_test_id('edit-ui-version-select')).to_contain_text('跟随画板 · V2')
    expect(page.get_by_test_id('edit-ui-version-lock')).to_have_attribute('aria-pressed', 'false')
    assert page.get_by_test_id('edit-ui-version-lock').evaluate('node => node.getAttribute("aria-label")') == '锁定版本'
    assert 'V1 · 主轨' in page.locator('.fixture-inspector-scroll .fixture-value').all_text_contents()
    title = lambda clip: page.get_by_test_id('timeline-clip-' + clip).inner_text()
    assert '02 窗口剪影 · V2' in title('clip-02'), title('clip-02')
    assert '03 霓虹街头 · 锁定 V1' in title('clip-03'), title('clip-03')
    assert '04 海岸航拍 · 待生成（占位 4 秒）' in title('clip-04'), title('clip-04')
    assert '· V' not in title('clip-01'), 'An imported media clip must not show a shot version suffix: ' + title('clip-01')
    assert page.get_by_test_id('timeline-clip-clip-04').get_attribute('class').find('edit-ui-placeholder') >= 0
    assert float(page.get_by_test_id('timeline-clip-clip-04').evaluate('node => getComputedStyle(node).opacity')) < 0.7
    assert page.get_by_test_id('edit-ui-anchor-layer').get_attribute('data-anchor-count') == '3'
    assert set(page.get_by_test_id('edit-ui-anchor-layer').get_attribute('data-anchor-ids').split(',')) == {
        'cue:cue-1:clip-01:30', 'cue:cue-2:clip-02:300', 'clip:clip-overlay:clip-03:510'}
    assert_anchor_geometry(geometry(page))
    result['checks'].append('main track marker, three clip suffixes, dimmed placeholder and three anchors')
    # Zoom: the link keeps its column because both ends are positioned by frame.
    before = {(row['id'], row['kind']): row for row in geometry(page)}
    page.evaluate('() => window.__editUiFixture.setZoom(70)')
    page.wait_for_function('''() => Math.abs(Number(document.querySelector('[data-testid="timeline-scroll"]').dataset.pixelsPerFrame) - 70 / 30) < 1e-6''')
    page.evaluate('''async () => {for(let i=0;i<6;i++)await new Promise(requestAnimationFrame);}''')
    zoomed = {(row['id'], row['kind']): row for row in geometry(page)}
    assert_anchor_geometry(geometry(page))
    for key, row in before.items():
        growth = (zoomed[key]['x'] - 168) / (row['x'] - 168)
        assert abs(growth - 70 / 46) < 0.02, f'Anchor column did not follow zoom: {row} -> {zoomed[key]}'
    result['zoomRatios'] = {f'{key[1]}:{key[0]}': round((zoomed[key]['x'] - 168) / (row['x'] - 168), 4) for key, row in before.items()}
    result['checks'].append('anchor columns follow zoom')
    # Scroll: absolute positions move with the content, relative positions stay.
    relative_before = relative_anchor_positions(page)
    screen_before = [row['dotScreenX'] for row in geometry(page)]
    page.evaluate('''() => {const scroll = document.querySelector('[data-testid="timeline-scroll"]'); scroll.scrollLeft = 180;
      scroll.dispatchEvent(new Event('scroll', {bubbles: true}));}''')
    page.evaluate('''async () => {for(let i=0;i<8;i++)await new Promise(requestAnimationFrame);}''')
    actual_scroll = page.evaluate('() => document.querySelector("[data-testid=timeline-scroll]").scrollLeft')
    assert actual_scroll >= 170, f'The timeline did not scroll: {actual_scroll}'
    screen_after = [row['dotScreenX'] for row in geometry(page)]
    moved = [before - after for before, after in zip(screen_before, screen_after, strict=True)]
    assert all(abs(delta - actual_scroll) <= 1.5 for delta in moved), f'Anchor dots did not follow scrolling: {moved} vs {actual_scroll}'
    relative_after = relative_anchor_positions(page)
    assert all(abs(left['x'] - right['x']) <= 0.6 and abs(left['y'] - right['y']) <= 0.6
               for left, right in zip(relative_before, relative_after, strict=True)), 'Anchor geometry changed while scrolling'
    result['checks'].append('anchor columns follow timeline scrolling')
    page.evaluate('() => window.__editUiFixture.setZoom(46)')
    page.evaluate('''() => {const scroll = document.querySelector('[data-testid="timeline-scroll"]'); scroll.scrollLeft = 0;
      scroll.dispatchEvent(new Event('scroll', {bubbles: true}));}''')
    page.evaluate('''async () => {for(let i=0;i<8;i++)await new Promise(requestAnimationFrame);}''')
    return result


def check_version_bar(page, result):
    switch(page, 'main')
    # Version bar callbacks: reveal, lock toggle and dropdown choice.
    page.evaluate('window.__editUiFixture.clearCallbacks()')
    page.get_by_test_id('edit-ui-shot-reveal').click()
    page.get_by_test_id('edit-ui-version-lock').click()
    page.get_by_test_id('edit-ui-version-select').click()
    expect(page.locator('[role="option"]').filter(has_text='跟随画板 · V2')).to_be_visible()
    page.locator('[role="option"]').filter(has_text='跟随画板 · V2').click()
    page.keyboard.press('Escape')
    page.wait_for_timeout(80)
    callbacks = page.evaluate('window.__editUiFixture.readCallbacks()')
    assert callbacks['reveals'] == 1, callbacks
    assert callbacks['versionChoices'] == [
        {'mode': 'locked', 'versionId': EXPECTED_APPLIED_VERSION},
        {'mode': 'follow', 'versionId': EXPECTED_BOARD_VERSION},
    ], callbacks
    result['checks'].append('properties version dropdown and lock button report through callbacks')
    return result


def check_copy_move(page, result, screens=None):
    switch(page, 'copy-move')
    page.evaluate('window.__editUiFixture.clearCallbacks()')
    dialog = page.get_by_test_id('edit-ui-copy-move-dialog')
    expect(dialog).to_be_visible()
    if screens:
        result['screens']['copy-move'] = capture(page, screens / '21-03-split-move.png')
    expect(page.get_by_test_id('edit-ui-copy-move-title')).to_have_text('复制成新镜头再挪？')
    assert dialog.locator('p').count() == 0, 'The confirmation must not carry the explanatory sentence'
    assert dialog.locator('button').count() == 2
    assert page.evaluate('document.activeElement?.dataset?.testid') == 'edit-ui-copy-move-confirm'
    page.keyboard.press('Tab')
    assert page.evaluate('document.activeElement?.dataset?.testid') == 'edit-ui-copy-move-cancel', 'Tab did not stay inside the dialog'
    page.keyboard.press('Enter')
    callbacks = page.evaluate('window.__editUiFixture.readCallbacks()')
    assert callbacks['cancelled'] == 1 and callbacks['confirmed'] == [], 'Enter on cancel must cancel: ' + json.dumps(callbacks)
    switch(page, 'main')
    switch(page, 'copy-move')
    page.evaluate('window.__editUiFixture.clearCallbacks()')
    page.keyboard.press('Escape')
    assert page.evaluate('window.__editUiFixture.readCallbacks()')['cancelled'] == 1, 'Escape must cancel'
    expect(page.get_by_test_id('edit-ui-copy-move-dialog')).to_be_hidden()
    switch(page, 'main')
    switch(page, 'copy-move')
    page.evaluate('window.__editUiFixture.clearCallbacks()')
    expect(page.get_by_test_id('edit-ui-copy-move-confirm')).to_be_focused()
    page.keyboard.press('Enter')
    callbacks = page.evaluate('window.__editUiFixture.readCallbacks()')
    assert callbacks['cancelled'] == 0
    assert callbacks['confirmed'] == [EXPECTED_COPY_MOVE], 'Enter must confirm the bound request: ' + json.dumps(callbacks)
    expect(page.get_by_test_id('edit-ui-copy-move-dialog')).to_be_hidden()
    switch(page, 'main')
    switch(page, 'copy-move')
    page.evaluate('window.__editUiFixture.clearCallbacks()')
    page.get_by_test_id('edit-ui-copy-move-cancel').click()
    assert page.evaluate('window.__editUiFixture.readCallbacks()')['cancelled'] == 1
    result['checks'].append('copy-and-move confirmation keeps only title and buttons, binds its request and handles Enter/Esc/Tab')
    return result


def check_removed(page, result, screens=None):
    switch(page, 'removed')
    page.evaluate('window.__editUiFixture.clearCallbacks()')
    bar = page.get_by_test_id('edit-ui-notice-bar')
    expect(bar).to_have_count(1)
    expect(page.get_by_test_id('edit-ui-notice-message')).to_have_text('已从主轨移除 02 窗口剪影')
    assert bar.locator('button').count() == 2, 'The undo bar has undo and close only'
    expect(page.get_by_test_id('edit-ui-detached-cue-cue-2')).to_be_visible()
    expect(page.get_by_test_id('edit-ui-detached-cue-cue-2')).to_contain_text('未挂靠')
    detached = page.get_by_test_id('edit-ui-detached-cue-cue-2').evaluate('node => parseFloat(node.style.left)')
    cue = page.get_by_test_id('subtitle-cue-cue-2').evaluate('node => parseFloat(node.style.left) + node.getBoundingClientRect().width')
    assert abs(detached - (cue + 6)) <= 1.5, f'Detached label is not next to its cue: {detached} vs {cue}'
    page.get_by_test_id('timeline-clip-clip-02').is_hidden()
    if screens:
        result['screens']['removed'] = capture(page, screens / '21-04-delete-segment.png')
    # Keyboard: the bar is reachable by Tab and undo runs from the focused button.
    page.evaluate('document.body.focus()')
    for _ in range(40):
        page.keyboard.press('Tab')
        if page.evaluate('document.activeElement?.dataset?.testid') == 'edit-ui-notice-undo':
            break
    assert page.evaluate('document.activeElement?.dataset?.testid') == 'edit-ui-notice-undo', 'Undo button is not keyboard reachable'
    page.keyboard.press('Enter')
    assert page.evaluate('window.__editUiFixture.readCallbacks()')['undone'] == ['notice-removed-02']
    page.get_by_test_id('edit-ui-notice-dismiss').click()
    assert page.evaluate('window.__editUiFixture.readCallbacks()')['dismissed'] == ['notice-removed-02']
    result['checks'].append('removed scenario shows one undo bar, detached cue label and a keyboard-reachable undo')
    return result


def check_locales(page, result, screens):
    switch(page, 'main')
    for locale, strings in LOCALES.items():
        page.evaluate('value => window.__editUiFixture.setLocale(value)', locale)
        page.wait_for_function('(value) => document.documentElement.lang === value', arg=locale)
        page.evaluate('''async () => {for(let i=0;i<6;i++)await new Promise(requestAnimationFrame);}''')
        expect(page.get_by_test_id('timeline-track-track-main').locator('.track-label')).to_contain_text(strings['main'])
        title = page.get_by_test_id('timeline-clip-clip-02').inner_text()
        assert strings['followSuffix'] in title, f'{locale}: {title}'
        locked = page.get_by_test_id('timeline-clip-clip-03').inner_text()
        assert strings['lockedSuffix'] in locked, f'{locale}: {locked}'
        placeholder = page.get_by_test_id('timeline-clip-clip-04').inner_text()
        assert strings['placeholderSuffix'] in placeholder, f'{locale}: {placeholder}'
        expect(page.get_by_test_id('edit-ui-shot-name')).to_have_text(strings['shotTitle'])
        expect(page.get_by_test_id('edit-ui-version-select')).to_contain_text(strings['follow'])
        expect(page.get_by_test_id('edit-ui-shot-reveal')).to_have_text(strings['reveal'])
        assert strings['mainMarker'] in page.locator('.fixture-inspector-scroll .fixture-value').all_text_contents()
        switch(page, 'copy-move')
        expect(page.get_by_test_id('edit-ui-copy-move-title')).to_have_text(strings['dialog'])
        switch(page, 'removed')
        expect(page.get_by_test_id('edit-ui-notice-message')).to_have_text(strings['notice'])
        expect(page.get_by_test_id('edit-ui-detached-cue-cue-2')).to_contain_text(strings['detached'])
        switch(page, 'main')
    page.evaluate('() => window.__editUiFixture.setLocale("zh-Hans")')
    page.wait_for_function('() => document.documentElement.lang === "zh-Hans"')
    page.evaluate('''async () => {for(let i=0;i<6;i++)await new Promise(requestAnimationFrame);}''')
    result['checks'].append('four locales render the main track, suffixes, version bar, dialog and notice')
    return result


def capture(page, target):
    path = Path(target)
    path.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(path), full_page=True)
    return {'path': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size}


def design(page, options):
    failures, requests, result = [], [], {'checks': []}
    page.on('pageerror', lambda error: failures.append(str(error)))
    origin = urlparse(options.url).netloc

    def observe(request):
        parsed = urlparse(request.url)
        if parsed.netloc != origin:
            requests.append(request.url)
        elif parsed.path.startswith('/api/rpc'):
            requests.append(request.url)
    page.on('request', observe)
    page.goto(options.url, wait_until='networkidle')
    wait_fixture(page, 'main')
    screens = Path(options.screens) if options.screens else None
    result['screens'] = {}
    result = check_main_scenario(page, result)
    if screens:
        result['screens']['main'] = capture(page, screens / '21-02-main-track-sync.png')
    result = check_copy_move(page, result, screens)
    result = check_removed(page, result, screens)
    result = check_version_bar(page, result)
    result = check_locales(page, result, screens)
    # Reduced motion: no infinite animation may keep running.
    page.emulate_media(reduced_motion='reduce')
    for motion in ['app', 'prop', 'normal']:
        page.evaluate('value => window.__editUiFixture.setMotion(value)', motion)
        page.wait_for_timeout(120)
        assert running_animations(page) == [], f'Reduced motion ({motion}) left running animations: {running_animations(page)}'
    result['checks'].append('reduced motion leaves no continuous animation')
    page.emulate_media(reduced_motion='no-preference')
    switch(page, 'copy-move')
    page.evaluate('value => window.__editUiFixture.setMotion(value)', 'normal')
    assert not failures, 'Browser page errors: ' + '; '.join(failures)
    assert not requests, 'Fixture contacted a backend or external origin: ' + json.dumps(requests)
    result['requests'] = 'loopback fixture assets and repository media examples only'
    result['checks'].append('zero backend/external requests and zero browser page errors')
    return result


def wait_baseline(page):
    page.wait_for_function('() => window.__editUiBaseline && window.__editUiBaseline.ready === true')
    page.evaluate('''async () => {await document.fonts.ready;for(let i=0;i<20;i++)await new Promise(requestAnimationFrame);}''')


def baseline(page, options):
    page.goto(options.url, wait_until='networkidle')
    wait_baseline(page)
    expect(page.get_by_test_id('timeline-panel')).to_be_visible()
    target = options.out or str(Path(options.screens or '.') / 'baseline-current.png')
    path = Path(target)
    path.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(path), full_page=True)
    result = {'mode': 'baseline', 'checks': ['real editing timeline rendered without the UI-E1 projection prop'],
              'captured': {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size}}
    if options.compare:
        before = Path(options.compare)
        assert before.exists(), f'Missing baseline screenshot: {before}'
        before_hash = hashlib.sha256(before.read_bytes()).hexdigest()
        result['compare'] = {'sha256': before_hash, 'bytes': before.stat().st_size}
        result['equal'] = before_hash == result['captured']['sha256']
        assert result['equal'], 'Rendering without the optional projection prop differs from the recorded baseline'
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    parser.add_argument('--mode', choices=['design', 'baseline'], default='design')
    parser.add_argument('--screens')
    parser.add_argument('--report')
    parser.add_argument('--out')
    parser.add_argument('--compare')
    parser.add_argument('--browser')
    options = parser.parse_args()
    executable = options.browser or shutil.which('chromium') or shutil.which('google-chrome')
    mac = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    if not executable and mac.exists():
        executable = str(mac)
    assert executable, 'A Chromium executable is required'
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=executable, headless=True, chromium_sandbox=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 900}, device_scale_factor=1, reduced_motion='no-preference')
        page = context.new_page()
        try:
            result = baseline(page, options) if options.mode == 'baseline' else design(page, options)
            result.update({'ok': True, 'browserVersion': browser.version, 'platform': platform.system(),
                           'architecture': platform.machine(), 'viewport': [1440, 900]})
            if options.report:
                Path(options.report).parent.mkdir(parents=True, exist_ok=True)
                Path(options.report).write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
            print(json.dumps(result, ensure_ascii=False))
        finally:
            context.close()
            browser.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        detail = str(error)
        print(json.dumps({'ok': False, 'error': detail}, ensure_ascii=False))
        traceback.print_exc()
        sys.exit(1)
