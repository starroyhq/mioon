"""Headless acceptance for UI-B2 against the real format-5 kernel and RPC."""
import argparse
import json
import shutil
import statistics
import sys
import traceback
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

SHOT_A = '70000000-0000-4000-8000-000000000003'
SHOT_B = '70000000-0000-4000-8000-000000000004'
IMAGE = '70000000-0000-4000-8000-000000000005'
TEXT = '70000000-0000-4000-8000-000000000006'
ROOT = '70000000-0000-4000-8000-000000000002'
VERSION_A = '70000000-0000-4000-8000-000000000020'
VERSION_A2 = '70000000-0000-4000-8000-000000000022'
EDGE_AB = '70000000-0000-4000-8000-000000000081'


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    parser.add_argument('--screens')
    parser.add_argument('--browser')
    parser.add_argument('--stress', action='store_true')
    options = parser.parse_args()
    executable = options.browser or shutil.which('chromium') or shutil.which('google-chrome')
    mac = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    if not executable and mac.exists():
        executable = str(mac)
    assert executable, 'A Chromium executable is required'
    screens = Path(options.screens) if options.screens else None
    if screens:
        screens.mkdir(parents=True, exist_ok=True)
    result = {'checks': [], 'screens': {}}
    def log(name: str, **details) -> None:
        result['checks'].append({'name': name, 'passed': True, **details})
    def capture(page, name: str) -> None:
        if not screens:
            return
        path = screens / name
        page.screenshot(path=str(path), full_page=True)
        result['screens'][name] = str(path)
    def state(page):
        return page.evaluate("() => window.__boardWireState")
    def wait_position(page, minimum: int) -> None:
        page.wait_for_function("(minimum) => Number(document.querySelector('[data-testid=fixture-history-position]')?.textContent ?? 0) >= minimum",
                               arg=minimum, timeout=15000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=executable, headless=True, chromium_sandbox=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 900}, locale='zh-Hans')
        page = context.new_page()
        errors = []
        console_messages = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda message: console_messages.append(f'{message.type}: {message.text}'))
        try:
            page.goto(options.url)
            page.wait_for_function("() => Boolean(window.__boardWireState?.ready)", timeout=120000 if options.stress else 30000)
            if options.stress:
                run_stress(page, result, log, capture, state)
            else:
                run_acceptance(page, result, log, capture, state, wait_position)
            assert not errors, errors
            result.update({'ok': True, 'browserVersion': browser.version})
        except Exception as error:
            result.update({'ok': False, 'error': str(error), 'pageErrors': errors, 'console': console_messages[-20:],
                           'body': (page.locator('body').inner_text(timeout=2000) if page else '')[:500]})
            traceback.print_exc()
            raise
        finally:
            if options.screens:
                (screens / 'report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
            context.close()
            browser.close()
    print(json.dumps(result, ensure_ascii=False))
    return 0


def run_acceptance(page, result, log, capture, state, wait_position) -> None:
    expect(page.get_by_test_id('board-ui-live')).to_be_visible()
    expect(page.get_by_test_id(f'board-card-{ROOT}')).to_be_visible()
    expect(page.get_by_test_id(f'board-card-{SHOT_A}')).to_be_visible()
    expect(page.get_by_test_id(f'board-card-{SHOT_B}')).to_be_visible()
    expect(page.get_by_test_id(f'board-card-{IMAGE}')).to_be_visible()
    expect(page.get_by_test_id(f'board-card-{TEXT}')).to_be_visible()
    expect(page.get_by_test_id('board-floating-label')).to_have_count(1)
    expect(page.get_by_test_id('board-reference-edge-70000000-0000-4000-8000-000000000083')).to_be_visible()
    assert page.locator('[data-testid^="board-sequence-edge-"]').count() >= 2
    assert '首帧' in (page.locator('[data-testid^="board-reference-edge-"]').first.text_content() or '')
    film_items = page.locator('[data-testid^="board-film-item-"]')
    assert film_items.count() == 2, film_items.count()
    expect(page.get_by_test_id('fixture-sync')).to_have_attribute('data-synced', 'true')
    log('format-5 board renders real chain, reference line, role label, floating label and film strip',
        cards=page.locator('[data-testid^="board-card-"]').count(), film_items=film_items.count())
    capture(page, '21-01-board-wire.png')

    # Version choice on the real board (21-02).
    page.get_by_test_id(f'board-card-{SHOT_A}').click()
    expect(page.get_by_test_id('board-inspector-versions')).to_be_visible()
    position = int(state(page)['history']['position'])
    page.get_by_test_id(f'board-inspector-version-{VERSION_A2}').click()
    wait_position(page, position + 1)
    expect(page.get_by_test_id('edit-ui-notice-bar')).to_be_visible()
    assert state(page)['history']['undo']['operation'] == 'board.version'
    expect(page.get_by_test_id('board-inspector-sync')).to_have_attribute('data-synced', 'true')
    log('21-02 board version choice commits one unified-history action', position=position + 1)
    capture(page, '21-02-board-version.png')

    # Unified undo/redo through the shared keyboard shortcuts.
    page.locator('body').press('Control+z')
    page.wait_for_function("(position) => Number(document.querySelector('[data-testid=fixture-history-position]')?.textContent) === position",
                           arg=position, timeout=15000)
    page.locator('body').press('Control+Shift+z')
    wait_position(page, position + 1)
    log('Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z traverse the one board/editing history')

    # Chain insert: disconnect the A->B edge, then connect through the keyboard ports.
    page.get_by_test_id(f'board-sequence-edge-{EDGE_AB}').click(force=True)
    page.get_by_test_id('board-ui-disconnect').click()
    wait_position(page, position + 2)
    assert state(page)['history']['undo']['operation'] == 'board.disconnect'
    page.get_by_test_id(f'board-card-{SHOT_A}').click()
    page.get_by_test_id(f'board-port-{SHOT_A}-sequence-out').focus()
    page.keyboard.press('Enter')
    page.get_by_test_id(f'board-port-{SHOT_B}-sequence-in').focus()
    page.keyboard.press('Enter')
    wait_position(page, position + 3)
    assert state(page)['history']['undo']['operation'] == 'board.connect'
    assert state(page)['mount']['inSync'] is True
    log('keyboard ports disconnect and reconnect the chain through preview/commit',
        undo=state(page)['history']['undo']['operation'])
    capture(page, '21-01-board-connect.png')

    # Film strip "+" appends one shot; the board, main track and history change together.
    ids_before = {card['id'] for card in state(page)['cards']}
    page.get_by_test_id('board-film-add').click()
    wait_position(page, position + 4)
    page.wait_for_function("(ids) => window.__boardWireState.cards.some(card => !ids.includes(card.id))",
                           arg=list(ids_before), timeout=15000)
    assert state(page)['history']['undo']['operation'] == 'board.shot.append'
    new_shot = next(card['id'] for card in state(page)['cards'] if card['id'] not in ids_before)
    log('film-strip + appends a shot to the chain in one undo step', newShot=new_shot)
    capture(page, '21-01-board-add-shot.png')

    # Delete reattaches, the notice undoes the exact action.
    page.get_by_test_id(f'board-card-{new_shot}').click()
    page.get_by_test_id('board-inspector-delete').click()
    wait_position(page, position + 5)
    page.wait_for_selector(f'[data-testid="board-card-{new_shot}"]', state='detached')
    expect(page.get_by_test_id('edit-ui-notice-bar')).to_be_visible()
    page.get_by_test_id('edit-ui-notice-undo').click()
    page.wait_for_function("(target) => Number(document.querySelector('[data-testid=fixture-history-position]')?.textContent) === target",
                           arg=position + 4, timeout=15000)
    page.wait_for_selector(f'[data-testid="board-card-{new_shot}"]', state='visible')
    log('delete is one undoable archive action and the notice restores it')
    capture(page, '21-01-board-delete-undo.png')

    # A new film root is a board-only action.
    page.get_by_test_id('board-ui-add-root').click()
    wait_position(page, position + 5)
    assert state(page)['history']['undo']['operation'] == 'board.root.create'
    assert len(state(page)['films']) == 2
    log('new film root is created without moving the active main track')
    capture(page, '21-01-board-new-root.png')

    # Layout drag persists through board.layout.move.
    box = page.get_by_test_id(f'board-card-{SHOT_A}').bounding_box()
    assert box
    x, y = box['x'] + box['width'] / 2, box['y'] + 18
    page.mouse.move(x, y)
    page.mouse.down()
    for step in range(1, 9):
        page.mouse.move(x + step * 12, y + step * 6)
        page.wait_for_timeout(16)
    page.mouse.up()
    wait_position(page, position + 6)
    assert state(page)['history']['undo']['operation'] == 'board.layout.move'
    log('dragging a card writes one board.layout.move action', operation='board.layout.move')
    capture(page, '21-01-board-layout.png')

    # Reduced motion switches off the continuous line motion.
    page.emulate_media(reduced_motion='reduce')
    page.reload()
    page.wait_for_function("() => Boolean(window.__boardWireState?.ready)", timeout=30000)
    expect(page.get_by_test_id('board-ui-static')).to_have_attribute('data-reduce-motion', 'true')
    expect(page.get_by_test_id('board-sequence-edge-70000000-0000-4000-8000-000000000080')).to_have_attribute('data-reduce-motion', 'true')
    log('reduced motion is forwarded to the board and sequence dots')
    capture(page, '21-01-board-reduced-motion.png')


def run_stress(page, result, log, capture, state) -> None:
    expect(page.get_by_test_id('board-ui-live')).to_be_visible()
    cards = page.locator('[data-testid^="board-card-"]')
    page.wait_for_function("() => document.querySelectorAll('[data-testid^=board-card-]').length >= 500", timeout=60000)
    log('stress board mounted', cards=cards.count())
    pane = page.get_by_test_id('board-ui-canvas').bounding_box()
    assert pane
    # Warm up the viewport once, then measure a steady pan; the first
    # interaction after fit-all includes React Flow's resume work and is not a
    # steady-state frame.
    for warmup in range(2):
        page.mouse.move(pane['x'] + pane['width'] * .5, pane['y'] + pane['height'] * .5)
        page.mouse.down(button='middle')
        for step in range(1, 9):
            page.mouse.move(pane['x'] + pane['width'] * .5 - step * 14, pane['y'] + pane['height'] * .5 - step * 5)
            page.wait_for_timeout(16)
        page.mouse.up(button='middle')
        page.mouse.move(pane['x'] + pane['width'] * .5 + 60, pane['y'] + pane['height'] * .5)
        page.wait_for_timeout(120)
    page.evaluate("""() => {
      window.__frameSamples = []; window.__sampling = true; let last = performance.now();
      const tick = now => { if (!window.__sampling) return; window.__frameSamples.push(now - last); last = now; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }""")
    page.mouse.move(pane['x'] + pane['width'] * .45, pane['y'] + pane['height'] * .5)
    page.mouse.down(button='middle')
    for step in range(1, 31):
        page.mouse.move(pane['x'] + pane['width'] * .45 - step * 6, pane['y'] + pane['height'] * .5 - step * 3)
        page.wait_for_timeout(16)
    page.mouse.up(button='middle')
    page.wait_for_timeout(300)
    samples = page.evaluate("() => {window.__sampling = false; return window.__frameSamples;}")
    samples = [sample for sample in samples if sample > 0]
    p95 = statistics.quantiles(samples, n=20)[18] if len(samples) >= 20 else max(samples or [0])
    p50 = statistics.median(samples) if samples else 0
    result['performance'] = {'samples': len(samples), 'p50': round(p50, 2), 'p95': round(p95, 2),
                             'max': round(max(samples or [0]), 2), 'uiB1TwoHundredEdgeP95': 16.8}
    log('500-shot board pan frame pacing measured', **result['performance'])
    assert p95 <= 34, result['performance']
    capture(page, '21-01-board-500-shots.png')


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        sys.exit(1)
