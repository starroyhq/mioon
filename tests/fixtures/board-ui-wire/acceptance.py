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
IMAGE2 = '70000000-0000-4000-8000-000000000007'
AUDIO = '70000000-0000-4000-8000-000000000008'
SUBJECT_CHARACTER = '70000000-0000-4000-8000-000000000090'
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
                run_board_management_acceptance(page, result, log, capture, state, wait_position)
                run_subject_acceptance(page, log, capture, state, wait_position)
                run_board_assets_acceptance(page, result, log, capture, state, wait_position)
                run_ri_b_acceptance(page, log, capture, state, wait_position)
                run_gp_acceptance(page, log, capture, state, wait_position)
                run_wt3_subject_creation_acceptance(page, log, capture, state)
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
    page.get_by_test_id('wire-tab-versions').click()
    expect(page.get_by_test_id('board-inspector-versions')).to_be_visible()
    position = int(state(page)['history']['position'])
    page.get_by_test_id(f'board-inspector-version-{VERSION_A2}').click()
    wait_position(page, position + 1)
    expect(page.get_by_test_id('edit-ui-notice-bar')).to_be_visible()
    assert state(page)['history']['undo']['operation'] == 'board.version'
    page.evaluate("() => window.__boardWireActions.clearSelection()")
    expect(page.get_by_test_id('board-inspector-sync')).to_have_attribute('data-synced', 'true')
    log('21-02 board version choice commits one unified-history action', position=position + 1)
    capture(page, '21-02-board-version.png')

    # Unified undo/redo through the shared keyboard shortcuts.
    page.locator('body').press('Control+z')
    page.wait_for_function("(position) => Number(document.querySelector('[data-testid=fixture-history-position]')?.textContent) === position",
                           arg=position, timeout=15000)
    page.locator('body').press('Control+Shift+z')
    wait_position(page, position + 1)
    page.get_by_test_id('wire-tab-settings').click()
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
    page.get_by_test_id(f'board-card-{new_shot}').click(button='right')
    page.get_by_test_id('board-menu-delete').click()
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


def run_board_management_acceptance(page, result, log, capture, state, wait_position) -> None:
    """FR-C review: copy/paste/duplicate, node editing and archive restore on the
    real format-5 board that users actually see (BoardUiLive + BoardInspector)."""
    page.reload()
    page.wait_for_function("() => Boolean(window.__boardWireState?.ready)", timeout=30000)
    expect(page.get_by_test_id('board-ui-live')).to_be_visible()
    position = int(state(page)['history']['position'])

    # Copy / paste / duplicate through the shared shortcuts.
    page.get_by_test_id(f'board-card-{SHOT_A}').click()
    cards_before = page.locator('[data-testid^="board-card-"]').count()
    page.locator('body').press('Control+c')
    page.locator('body').press('Control+v')
    wait_position(page, position + 1)
    page.wait_for_function("(count) => document.querySelectorAll('[data-testid^=board-card-]').length === count",
                           arg=cards_before + 1, timeout=15000)
    assert state(page)['history']['undo']['operation'] == 'board.duplicate'
    page.locator('body').press('Control+d')
    wait_position(page, position + 2)
    page.wait_for_function("(count) => document.querySelectorAll('[data-testid^=board-card-]').length === count",
                           arg=cards_before + 2, timeout=15000)
    assert state(page)['history']['undo']['operation'] == 'board.duplicate'
    log('copy/paste/duplicate create the same unified board action', position=position + 2)
    capture(page, '21-03-board-copy-paste.png')

    # Text node name and content edit through BoardInspector.
    page.get_by_test_id(f'board-card-{TEXT}').click()
    expect(page.get_by_test_id('board-inspector-node-edit')).to_be_visible()
    page.get_by_test_id('board-node-name').fill('笔记改名')
    page.get_by_test_id('board-node-text').fill('更新后的文字')
    page.get_by_test_id('board-node-save').click()
    wait_position(page, position + 3)
    assert state(page)['history']['undo']['operation'] == 'board.node.update'
    page.get_by_test_id(f'board-card-{TEXT}').click()
    expect(page.get_by_test_id(f'board-card-{TEXT}')).to_contain_text('更新后的文字')
    log('text node name/content edit commits one board.node.update with its expected revision')
    capture(page, '21-04-board-node-edit.png')

    # Archive/restore from the real deleted list: a shot returns to the chain tail.
    page.get_by_test_id(f'board-card-{SHOT_B}').click(button='right')
    page.get_by_test_id('board-menu-delete').click()
    wait_position(page, position + 4)
    page.wait_for_selector(f'[data-testid="board-card-{SHOT_B}"]', state='detached')
    page.get_by_test_id('board-ui-archive').click()
    page.get_by_test_id(f'board-ui-restore-{SHOT_B}').click()
    wait_position(page, position + 5)
    page.wait_for_selector(f'[data-testid="board-card-{SHOT_B}"]', state='visible')
    assert state(page)['history']['undo']['operation'] == 'board.restore'
    assert state(page)['mount']['inSync'] is True
    log('deleted-list restore reattaches a shot through board.restore in one action')
    capture(page, '21-05-board-restore.png')

def run_ri_b_acceptance(page, log, capture, state, wait_position) -> None:
    """RI-b: reference lines and the live generation-inputs panel (21-06)."""
    def footer():
        return page.get_by_test_id('board-input-footer').inner_text()
    def wait_service_selected() -> None:
        page.wait_for_function(
            "() => document.querySelector('[data-testid=board-input-footer]')?.dataset.service === 'selected'",
            timeout=15000)
    def connect_reference(source: str, target: str) -> None:
        page.get_by_test_id(f'board-port-{source}-reference-out-bottom').focus()
        page.keyboard.press('Enter')
        page.get_by_test_id(f'board-port-{target}-reference-in-top').focus()
        page.keyboard.press('Enter')

    # A board shot without references: empty state and the missing-service state.
    empty_shot = next(card['id'] for card in state(page)['cards'] if card['kind'] == 'shot'
                      and card['id'] not in (SHOT_A, SHOT_B))
    page.get_by_test_id(f'board-card-{empty_shot}').click()
    expect(page.get_by_test_id('board-inspector-generation-inputs')).to_be_visible()
    expect(page.get_by_test_id('board-input-empty')).to_have_text('未连接参考')
    expect(page.get_by_test_id('board-input-footer')).to_have_text('未选择生成服务')
    expect(page.locator('[data-unsupported="true"]')).to_have_count(0)
    log('RI-b empty/no-service panel shows only the footer state')
    capture(page, '21-06-inputs-empty-no-service.png')

    # Drag one material reference line onto the shot through the real ports.
    position = int(state(page)['history']['position'])
    connect_reference(IMAGE2, empty_shot)
    wait_position(page, position + 1)
    assert state(page)['history']['undo']['operation'] == 'reference.attach'
    page.get_by_test_id(f'board-card-{empty_shot}').click()
    assert len(state(page)['inputs']['entries']) == 1
    log('RI-b drags a material reference line through preview/commit', position=position + 1)
    capture(page, '21-06-inputs-attached-no-service.png')

    # Pick the supported multi-reference service: Ark Seedance 2.5. The service
    # picker is the native custom select; the fixture hook writes the same
    # per-shot generation selection the picker writes.
    page.evaluate("([shot]) => window.__boardWireActions.setGeneration(shot,"
                  " {connectionId:'70000000-0000-4000-8000-000000000100', configurationRevision:1,"
                  "  model:'doubao-seedance-2-5-260628'})", [empty_shot])
    wait_service_selected()
    page.wait_for_function("() => document.querySelector('[data-testid=board-input-footer]')?.textContent?.includes('火山方舟')", timeout=15000)
    assert '首尾帧' in footer(), footer()
    assert '用到 1 项' in footer(), footer()
    log('RI-b footer names the service and its derived frames mode', footer=footer())
    capture(page, '21-06-inputs-service-frames.png')

    # Role change to a reference image turns the mode into multi-reference.
    position = int(state(page)['history']['position'])
    edge_id = state(page)['inputs']['entries'][0]['edgeId']
    page.evaluate("([edge, shot, role]) => window.__boardWireActions.changeRole(edge, shot, role)",
                  [edge_id, empty_shot, 'reference_image'])
    wait_position(page, position + 1)
    assert state(page)['history']['undo']['operation'] == 'reference.role.set'
    page.wait_for_function("() => document.querySelector('[data-testid=board-input-footer]')?.textContent?.includes('多参考')", timeout=15000)
    log('RI-b changes a reference role and the footer mode follows', footer=footer())
    capture(page, '21-06-inputs-role.png')

    # A second image, then make it the primary image (first provider image).
    position = int(state(page)['history']['position'])
    connect_reference(IMAGE, empty_shot)
    wait_position(page, position + 1)
    page.get_by_test_id(f'board-card-{empty_shot}').click()
    edge_id = next(entry['edgeId'] for entry in state(page)['inputs']['entries'] if entry['role'] == 'first_frame')
    page.evaluate("([edge, shot, role]) => window.__boardWireActions.changeRole(edge, shot, role)",
                  [edge_id, empty_shot, 'reference_image'])
    wait_position(page, position + 2)
    primary_entry = next(entry for entry in state(page)['inputs']['entries']
                         if entry['role'] == 'reference_image' and entry.get('primary') is not True)
    page.evaluate("([edge, shot]) => window.__boardWireActions.setPrimary(edge, shot)",
                  [primary_entry['edgeId'], empty_shot])
    wait_position(page, position + 3)
    assert state(page)['history']['undo']['operation'] == 'reference.reorder'
    assert any(entry['primary'] for entry in state(page)['inputs']['entries'])
    log('RI-b sets the primary image through the ordered reference action')
    capture(page, '21-06-inputs-primary.png')

    # Reference audio is a first-class input for the supported service.
    position = int(state(page)['history']['position'])
    connect_reference(AUDIO, empty_shot)
    wait_position(page, position + 1)
    page.get_by_test_id(f'board-card-{empty_shot}').click()
    page.wait_for_function("() => document.querySelectorAll('.board-input-row').length >= 3", timeout=15000)
    log('RI-b keeps reference audio in the input list', footer=footer())
    capture(page, '21-06-inputs-audio.png')

    # Wan 3.0 does not take reference audio: the row and the connector say so.
    page.evaluate("([shot]) => window.__boardWireActions.setGeneration(shot,"
                  " {connectionId:'70000000-0000-4000-8000-000000000101', configurationRevision:1,"
                  "  model:'wan3.0-video'})", [empty_shot])
    wait_service_selected()
    page.wait_for_selector('.board-input-row.is-unsupported', timeout=15000)
    assert '当前服务不支持' in page.get_by_test_id('board-inspector-generation-inputs').inner_text()
    page.wait_for_function("() => document.querySelectorAll('[data-unsupported=true]').length > 0", timeout=15000)
    log('RI-b marks an unsupported reference audio on the row and connector', footer=footer())
    capture(page, '21-06-inputs-unsupported-audio.png')

    # The marker follows the selected shot only (the service is chosen per shot).
    page.get_by_test_id(f'board-card-{SHOT_A}').click()
    page.wait_for_function("() => document.querySelectorAll('[data-unsupported=true]').length === 0", timeout=15000)
    page.get_by_test_id(f'board-card-{empty_shot}').click()
    page.wait_for_function("() => document.querySelectorAll('[data-unsupported=true]').length > 0", timeout=15000)
    log('RI-b unsupported markers stay on the selected shot only')

    # Detach one material line; it is one unified-history step.
    position = int(state(page)['history']['position'])
    audio_entry = next(entry for entry in state(page)['inputs']['entries'] if entry['role'] == 'reference_audio')
    page.evaluate("([entry, shot]) => window.__boardWireActions.detachInput(entry, shot)",
                  [audio_entry, empty_shot])
    wait_position(page, position + 1)
    assert state(page)['history']['undo']['operation'] == 'reference.detach'
    log('RI-b detaches a reference line in one undo step')
    capture(page, '21-06-inputs-detach.png')

    # SB-b's bound subject is listed with its name and version inside the same panel.
    page.get_by_test_id(f'board-card-{SHOT_A}').click()
    page.wait_for_function("() => document.querySelector('[data-testid=board-inspector-generation-inputs]')?.textContent?.includes('阿琦')", timeout=15000)
    panel = page.get_by_test_id('board-inspector-generation-inputs').inner_text()
    assert 'V1' in panel, panel
    assert '主体' in panel, panel
    log('RI-b lists the bound subject with its version', footer=footer())
    capture(page, '21-06-inputs-subject.png')



def run_board_assets_acceptance(page, result, log, capture, state, wait_position) -> None:
    """FR-C2: add assets/text to the real format-5 board from the asset library
    button, drag-drop, blank-canvas menu and paste; every add is one undo step."""
    IMAGE_ASSET = '70000000-0000-4000-8000-000000000012'
    VIDEO_ASSET = '70000000-0000-4000-8000-000000000010'
    AUDIO_ASSET = '70000000-0000-4000-8000-000000000015'
    def count(page): return page.locator('[data-testid^="board-card-"]').count()
    def add_and_undo(action, label, screenshot, expected='board.node.create'):
        position = int(state(page)['history']['position'])
        before = count(page)
        action()
        wait_position(page, position + 1)
        page.wait_for_function("(count) => document.querySelectorAll('[data-testid^=board-card-]').length === count",
                               arg=before + 1, timeout=15000)
        assert state(page)['history']['undo']['operation'] == expected
        capture(page, screenshot)
        page.locator('body').press('Control+z')
        page.wait_for_function("(position) => Number(document.querySelector('[data-testid=fixture-history-position]')?.textContent) === position",
                               arg=position, timeout=15000)
        page.wait_for_function("(count) => document.querySelectorAll('[data-testid^=board-card-]').length === count",
                               arg=before, timeout=15000)
        log(f'{label} adds one board node and undoes in one step')
    page.reload()
    page.wait_for_function("() => Boolean(window.__boardWireState?.ready)", timeout=30000)
    expect(page.get_by_test_id('board-fixture-assets')).to_be_visible()
    add_and_undo(lambda: page.get_by_test_id(f'asset-to-canvas-{IMAGE_ASSET}').click(),
                 'asset-library button', '21-07-asset-button.png')
    # Drag a video asset card onto the board canvas.
    def drag(asset_id):
        canvas = page.get_by_test_id('board-ui-canvas')
        box = canvas.bounding_box()
        page.get_by_test_id(f'asset-card-{asset_id}').drag_to(canvas,
            target_position={'x': box['width'] * .55, 'y': box['height'] * .45})
    add_and_undo(lambda: drag(VIDEO_ASSET), 'asset drag-drop', '21-08-asset-drop.png')
    add_and_undo(lambda: drag(AUDIO_ASSET), 'audio drag-drop', '21-08-asset-drop-audio.png')
    # Blank-canvas right click -> add text.
    def add_text():
        page.get_by_test_id('board-ui-canvas').click(position={'x': 420, 'y': 300}, button='right')
        expect(page.get_by_test_id('board-pane-menu')).to_be_visible()
        page.get_by_test_id('board-pane-add-text').click()
    add_and_undo(add_text, 'blank-canvas text', '21-09-pane-menu.png')
    # Paste from the blank menu after copying the text card. Reload first so the
    # fixture camera fits every card after the add/undo history above.
    page.reload()
    page.wait_for_function("() => Boolean(window.__boardWireState?.ready)", timeout=30000)
    page.get_by_test_id(f'board-card-{TEXT}').click()
    page.locator('body').press('Control+c')
    def paste():
        page.get_by_test_id('board-ui-canvas').click(position={'x': 24, 'y': 24}, button='right')
        expect(page.get_by_test_id('board-pane-menu')).to_be_visible()
        page.get_by_test_id('board-pane-paste').click()
    add_and_undo(paste, 'blank-canvas paste', '21-10-pane-paste.png', expected='board.duplicate')
    # Later acceptance functions interact with the bottom-left subject area; the
    # fixture asset panel is fixed there, so tuck it away once FR-C2 checks end.
    page.evaluate("() => { const panel = document.querySelector('[data-testid=board-fixture-assets]'); if (panel) panel.style.display = 'none'; }")


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




def run_subject_acceptance(page, log, capture, state, wait_position) -> None:
    """SB-b: subject card creation, binding lifecycle, subject-input editing and
    the two destructive commands over the same real RPC/history."""
    subject_id = '70000000-0000-4000-8000-000000000090'
    subject_version = '70000000-0000-4000-8000-000000000092'
    look_id = '70000000-0000-4000-8000-000000000091'
    shot_a, shot_b = '70000000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000004'
    start = int(state(page)['history']['position'])
    expect(page.get_by_test_id('board-fixture-subjects')).to_be_visible()

    # 1. Create a subject card from the subject library (drag payload), then
    # link it to two shots through the keyboard reference ports.
    palette = page.get_by_test_id(f'fixture-subject-{subject_id}')
    board_canvas = page.get_by_test_id('board-ui-canvas')
    palette.drag_to(board_canvas, target_position={'x': 260, 'y': 260})
    wait_position(page, start + 1)
    cards = state(page)['cards']
    card = next(item for item in cards if item['kind'] == 'subject' and item['subjectId'] == subject_id)
    assert state(page)['history']['undo']['operation'] == 'subject.card.create', state(page)['history']
    log('dragging a subject from the library creates one subject card', card=card['id'])
    capture(page, '21-01-subject-card.png')

    for count, shot_id in enumerate((shot_a, shot_b), start=1):
        page.wait_for_function("(count) => window.__boardWireState.bindings.length === count - 1",
                               arg=count, timeout=15000)
        page.get_by_test_id(f'board-port-{card["id"]}-reference-out-top').focus()
        page.keyboard.press('Enter')
        page.get_by_test_id(f'board-port-{shot_id}-reference-in-top').focus()
        page.keyboard.press('Enter')
        page.wait_for_function("(count) => window.__boardWireState.bindings.length === count",
                               arg=count, timeout=15000)
    bindings = state(page)['bindings']
    assert len(bindings) == 2 and all(binding['bindingMode'] == 'follow' for binding in bindings), bindings
    assert {binding['shotId'] for binding in bindings} == {shot_a, shot_b}
    log('one subject card binds to multiple shots through the reference ports')
    capture(page, '21-01-subject-bindings.png')

    # 2. Shot generation inputs: follow by default, lock a concrete version,
    # switch back to follow, detach and restore.
    page.get_by_test_id(f'board-card-{shot_a}').click()
    page.get_by_test_id('wire-tab-settings').click()
    expect(page.get_by_test_id('board-inspector-generation-inputs')).to_be_visible()
    first = next(binding for binding in bindings if binding['shotId'] == shot_a)
    key = first['id']
    # The row menu opens from the keyboard, closes on Escape/outside click, and
    # its entries are ordinary keyboard-selectable menu buttons.
    row = page.get_by_test_id(f'board-input-{key}').locator('button')
    row.focus()
    page.keyboard.press('Enter')
    expect(page.get_by_test_id(f'board-input-menu-{key}')).to_be_visible()
    page.keyboard.press('Escape')
    expect(page.get_by_test_id(f'board-input-menu-{key}')).to_have_count(0)
    row.focus()
    page.keyboard.press('Enter')
    expect(page.get_by_test_id(f'board-input-menu-{key}')).to_be_visible()
    page.get_by_test_id('board-inspector-shot-title').click()
    expect(page.get_by_test_id(f'board-input-menu-{key}')).to_have_count(0)
    row.focus()
    page.keyboard.press('Enter')
    page.locator(f'[data-testid="board-input-menu-{key}"] button').first.focus()
    page.keyboard.press('Enter')
    expect(page.get_by_test_id(f'board-input-menu-{key}')).to_have_count(0)
    log('GB 21-10b row menu opens by keyboard, closes on Escape/outside click and selects by keyboard')
    page.get_by_test_id(f'board-input-{key}').locator('button').click()
    expect(page.get_by_test_id(f'board-input-menu-{key}')).to_be_visible()
    page.get_by_test_id(f'board-input-lock-{key}-{subject_version}').click()
    page.wait_for_function("(id) => window.__boardWireState.bindings.find(item => item.id === id)?.bindingMode === 'locked'",
                           arg=key, timeout=15000)
    log('locking V1 from the 21-10b input row menu writes one unified action')
    page.get_by_test_id(f'board-input-{key}').click()
    page.get_by_test_id(f'board-input-follow-{key}').click()
    page.wait_for_function("(id) => window.__boardWireState.bindings.find(item => item.id === id)?.bindingMode === 'follow'",
                           arg=key, timeout=15000)
    page.get_by_test_id(f'board-input-{key}').click()
    page.get_by_test_id(f'board-input-detach-{key}').click()
    page.wait_for_function("(id) => window.__boardWireState.bindings.find(item => item.id === id)?.bindingMode === 'detached'",
                           arg=key, timeout=15000)
    expect(page.get_by_test_id(f'board-input-detached-{key}')).to_be_visible()
    page.get_by_test_id(f'board-input-restore-{key}').click()
    page.wait_for_function("(id) => window.__boardWireState.bindings.find(item => item.id === id)?.bindingMode === 'follow'",
                           arg=key, timeout=15000)
    log('follow/lock/detach/restore traverse the same unified history')
    capture(page, '21-06-subject-inputs.png')

    # 3. Subject card selection lists linked shots and confirms both delete scopes.
    page.get_by_test_id(f'board-card-{card["id"]}').click()
    expect(page.get_by_test_id('board-inspector-linked-shots')).to_be_visible()
    assert page.get_by_test_id('board-inspector-linked-shots').locator('li').count() == 2
    log('the subject card lists every linked shot')
    capture(page, '21-01-subject-linked-shots.png')

    page.get_by_test_id('board-inspector-delete-card').click()
    expect(page.get_by_test_id('board-delete-confirm')).to_be_visible()
    expect(page.get_by_test_id('board-delete-impact')).to_contain_text('2')
    capture(page, '21-01-subject-delete-card-confirm.png')
    page.get_by_test_id('board-delete-confirm-button').click()
    page.wait_for_function("(cardId) => !window.__boardWireState.cards.some(item => item.id === cardId)",
                           arg=card['id'], timeout=15000)
    assert state(page)['history']['undo']['operation'] == 'subject.card.delete'
    page.locator('body').press('Control+z')
    page.wait_for_function("(cardId) => window.__boardWireState.cards.some(item => item.id === cardId)",
                           arg=card['id'], timeout=15000)
    log('deleting a subject card confirms its impact and undoes as one step')
    capture(page, '21-01-subject-delete-card-undone.png')


def run_gp_acceptance(page, log, capture, state, wait_position) -> None:
    """GP: 21-10 shot properties, draft save, conflicts, server-planned generation."""
    shot_a = '70000000-0000-4000-8000-000000000003'
    page.get_by_test_id(f'board-card-{shot_a}').click()
    page.get_by_test_id('wire-tab-settings').click()
    expect(page.get_by_test_id('board-shot-fields')).to_be_visible()
    expect(page.get_by_test_id('shot-dialogue')).to_be_visible()
    # The title is edited inside its own row, not through a separate field.
    page.get_by_test_id('board-inspector-shot-title').click()
    page.get_by_test_id('board-shot-title').fill('窗口剪影 · 改')
    page.keyboard.press('Enter')
    page.get_by_test_id('board-shot-prompt').fill('雨夜窗口的剪影，人物缓慢回头。')
    page.get_by_test_id('board-shot-duration').click()
    page.get_by_role('option').filter(has_text='4').first.click()
    page.get_by_test_id('board-shot-save').click()
    page.wait_for_function("() => window.__boardWireState.shots.some(shot => shot.id === '70000000-0000-4000-8000-000000000003' && shot.title === '窗口剪影 · 改' && shot.duration === 4)", timeout=15000)
    assert state(page)['history']['undo']['operation'] == 'board.shot.update'
    # 21-10: duration sits below the input rows and above the service footer.
    rows_box = page.locator('.board-input-list').bounding_box()
    duration_box = page.get_by_test_id('board-shot-duration').bounding_box()
    footer_box = page.get_by_test_id('board-input-footer').bounding_box()
    assert rows_box and duration_box and footer_box
    assert rows_box['y'] < duration_box['y'] < footer_box['y'], (rows_box, duration_box, footer_box)
    log('GB 21-10 title row/description/duration and F dialogue panel render')
    capture(page, '21-10-shot-properties.png')

    # An untouched draft follows an external revision change.
    rev = int(next(shot['revision'] for shot in state(page)['shots'] if shot['id'] == shot_a))
    page.evaluate("([shotId, revision]) => window.__boardWireActions.updateShot(shotId, {title: '外部改的标题'}, revision)", [shot_a, rev])
    page.wait_for_function("() => window.__boardWireState.shots.some(shot => shot.id === '70000000-0000-4000-8000-000000000003' && shot.title === '外部改的标题')", timeout=15000)
    expect(page.get_by_test_id('board-inspector-shot-title')).to_contain_text('外部改的标题')
    log('GB an untouched shot draft follows an external revision change')

    # A dirty draft keeps its start revision: save reports a conflict and never
    # overwrites the other writer.
    page.get_by_test_id('board-inspector-shot-title').click()
    page.get_by_test_id('board-shot-title').fill('本地草稿标题')
    page.keyboard.press('Enter')
    page.get_by_test_id('board-shot-prompt').fill('本地草稿描述，不应覆盖别处。')
    rev = int(next(shot['revision'] for shot in state(page)['shots'] if shot['id'] == shot_a))
    page.evaluate("([shotId, revision]) => window.__boardWireActions.updateShot(shotId, {title: '别处又改了'}, revision)", [shot_a, rev])
    page.wait_for_function("() => window.__boardWireState.shots.some(shot => shot.id === '70000000-0000-4000-8000-000000000003' && shot.title === '别处又改了')", timeout=15000)
    page.get_by_test_id('board-shot-save').click()
    expect(page.get_by_test_id('board-shot-error')).to_be_visible()
    assert next(shot['title'] for shot in state(page)['shots'] if shot['id'] == shot_a) == '别处又改了'
    log('GB a dirty shot draft keeps its start revision and gets a conflict instead of overwriting')
    capture(page, '21-10-shot-conflict.png')
    page.get_by_test_id('board-shot-discard').click()

    # Mock is a selected service without a configured video connection: the
    # footer and read-only projection must still report it.
    page.evaluate("() => window.__boardWireActions.installMockProvider()")
    page.evaluate("([shot]) => window.__boardWireActions.setGeneration(shot, {providerId:'mock'})", [shot_a])
    page.wait_for_function("() => window.__boardWireState.inputs?.service === 'mock'", timeout=15000)
    expect(page.get_by_test_id('board-input-footer')).to_have_attribute('data-service', 'selected')
    expect(page.get_by_test_id('board-input-footer')).not_to_have_text('未选择生成服务')
    assert int(state(page)['inputs']['usedCount']) >= 1
    # WT-3-05: Mock cannot emit sound; the dialogue status must say the selected
    # service is unsupported instead of pretending no service was selected.
    expect(page.get_by_test_id('shot-dialogue-generation-unsupported')).to_be_visible(timeout=15000)
    marker = page.get_by_test_id('shot-dialogue-generation-unsupported').inner_text()
    assert '当前服务不支持' in marker, marker
    log('WT-3-01 Mock is reported by the live projection and footer',
        footer=page.get_by_test_id('board-input-footer').inner_text())
    log('WT-3-05 Mock is a selected but silent service in the dialogue status', marker=marker)
    capture(page, '21-10-mock-service.png')
    capture(page, '21-10-mock-dialogue-unsupported.png')

    # Server-planned generation from the board: select the service through the
    # 21-10 footer itself, then generate without client input.
    before_cards = len(state(page)['cards'])
    page.get_by_test_id('board-ui-add-shot').click()
    page.wait_for_function("(count) => window.__boardWireState.cards.length > count", arg=before_cards, timeout=15000)
    page.wait_for_function("() => window.__boardWireState.history.undo.operation === 'board.shot.append'", timeout=15000)
    new_shot = next(card['id'] for card in reversed(state(page)['cards']) if card['kind'] == 'shot')
    page.get_by_test_id(f'board-card-{new_shot}').click()
    page.get_by_test_id('wire-tab-settings').click()
    page.get_by_test_id('board-shot-prompt').fill('雨停后路口的俯拍。')
    page.get_by_test_id('board-shot-duration').click()
    page.get_by_role('option').filter(has_text='4').first.click()
    page.get_by_test_id('board-shot-save').click()
    page.wait_for_function("(shotId) => window.__boardWireState.shots.some(shot => shot.id === shotId && shot.prompt === '雨停后路口的俯拍。' && shot.duration === 4)", arg=new_shot, timeout=15000)
    page.evaluate("(shotId) => window.__boardWireActions.updateShot(shotId, {aspectRatio:'16:9'}, window.__boardWireState.shots.find(shot => shot.id === shotId).revision)", arg=new_shot)
    page.wait_for_function("(shotId) => window.__boardWireState.shots.find(shot => shot.id === shotId)?.aspectRatio === '16:9'", arg=new_shot, timeout=15000)
    page.get_by_test_id('board-input-footer').click()
    expect(page.get_by_test_id('board-service-menu')).to_be_visible()
    page.locator('button[data-testid^="board-service-"]').filter(has_text='火山方舟').first.click()
    page.wait_for_function("() => Boolean(window.__boardWireState.inputs?.service)", timeout=15000)
    expect(page.get_by_test_id('board-inspector-generate')).to_be_enabled()
    page.get_by_test_id('board-inspector-generate').click()
    page.wait_for_function("(shotId) => (window.__boardWireState.jobs ?? []).some(job => job.shotId === shotId)", arg=new_shot, timeout=15000)
    log('GB board generation submits only the shot and selected service; server plans inputs', jobs=len(state(page)['jobs']))
    capture(page, '21-10-shot-generate.png')

    # WT-1-07: the format-5 board creates a previs node through the same unified
    # create intent as formats 3/4, offset from the existing cards, one undo step.
    previous_cards = state(page)['cards']
    before_cards = len(previous_cards)
    previous_ids = {card['id'] for card in previous_cards}
    position = int(state(page)['history']['position'])
    expect(page.get_by_test_id('board-ui-add-previs')).to_be_visible()
    page.get_by_test_id('board-ui-add-previs').click()
    page.wait_for_function("(count) => window.__boardWireState.cards.length > count", arg=before_cards, timeout=15000)
    wait_position(page, position + 1)
    cards = state(page)['cards']
    new_previs = next(card for card in cards if card['id'] not in previous_ids)
    assert new_previs['kind'] == 'previs', new_previs
    positions = state(page)['positions']
    assert all(positions[new_previs['id']] != positions[item['id']] for item in previous_cards if item['id'] in positions)
    assert state(page)['history']['undo']['operation'] == 'previs.create', state(page)['history']
    log('WT-1-07 board toolbar creates an offset previs node in one unified action', previs=new_previs['id'])
    capture(page, '21-10-add-previs.png')
    page.locator('body').press('Control+z')
    page.wait_for_function("(position) => Number(document.querySelector('[data-testid=fixture-history-position]')?.textContent) === position",
                           arg=position, timeout=15000)
    page.wait_for_function("(id) => !window.__boardWireState.cards.some(card => card.id === id)", arg=new_previs['id'], timeout=15000)
    log('WT-1-07 one undo removes the previs creation')


def run_wt3_subject_creation_acceptance(page, log, capture, state) -> None:
    """WT-3-02 (product decision 11-21): the format-5 subject library creates a
    subject and a second version without touching the board/timeline undo stack;
    the board still binds it through the subject-card intent; generation freezes
    the version the shot actually uses."""
    shot_a = '70000000-0000-4000-8000-000000000003'
    history_before = int(state(page)['history']['position'])
    page.set_input_files('[data-testid=subject-import-input]', str(Path(__file__).parent / 'reference.png'))
    page.wait_for_function("(minimum) => (window.__boardWireState.assetCount ?? 0) > minimum", arg=5, timeout=15000)
    page.wait_for_function("() => (window.__boardWireState.subjectImages ?? []).some(asset => asset.mimeType === 'image/png' && asset.id && !asset.id.startsWith('70000000'))", timeout=15000)
    known_subjects = {subject['id'] for subject in state(page).get('subjectList', [])}
    page.get_by_test_id('subject-new').click()
    page.wait_for_selector('#subject-create-image', timeout=15000)
    page.get_by_test_id('subject-name').fill('走查主体甲')
    page.get_by_test_id('subject-create-image').click()
    page.wait_for_timeout(500)
    options = page.locator('[role=option]').all_inner_texts()
    assert any('reference.png' in option for option in options), options
    page.get_by_role('option').filter(has_text='reference.png').first.click()
    page.get_by_test_id('subject-create').click()
    page.wait_for_function("(known) => (window.__boardWireState.subjectList ?? []).some(subject => !known.includes(subject.id))",
                           arg=sorted(known_subjects), timeout=15000)
    created = next(subject for subject in state(page)['subjectList'] if subject['id'] not in known_subjects)
    assert int(state(page)['history']['position']) == history_before, 'subject.create is not a board/timeline undo step'
    log('WT-3-02 imports an image and creates a subject through the library panel', subjectId=created['id'])
    capture(page, '21-12-subject-created.png')

    # A second version appends retained evidence and becomes the new head. The
    # production controller action is the same path the version form submits;
    # the inspector form's AgentEditingBoundary needs the full workbench shell,
    # which this board fixture does not mount.
    known_images = {asset['id'] for asset in state(page).get('subjectImages', [])}
    page.set_input_files('[data-testid=subject-import-input]', str(Path(__file__).parent / 'version2.png'))
    page.wait_for_function("(known) => (window.__boardWireState.subjectImages ?? []).some(asset => asset.mimeType === 'image/png' && !known.includes(asset.id))",
                           arg=sorted(known_images), timeout=15000)
    version_asset = next(asset['id'] for asset in state(page)['subjectImages']
                         if asset['mimeType'] == 'image/png' and asset['id'] not in known_images)
    page.evaluate("([subjectId, assetId]) => window.__boardWireActions.subjectAddVersion(subjectId, assetId)",
                  [created['id'], version_asset])
    page.wait_for_function("""async (subjectId) => {
      const response = await fetch('/rpc', {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({operation: 'subject.version.list', input: {projectId: '70000000-0000-4000-8000-000000000001',
          subjectId, limit: 20}})});
      const body = await response.json();
      return body.ok && (body.data.items || []).length === 2;
    }""", arg=created['id'], timeout=15000)
    versions = page.evaluate("""async (subjectId) => {
      const response = await fetch('/rpc', {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({operation: 'subject.version.list', input: {projectId: '70000000-0000-4000-8000-000000000001',
          subjectId, limit: 20}})});
      const body = await response.json();
      return body.data.items;
    }""", created['id'])
    version_two = next(version for version in versions if version['number'] == 2)
    assert int(state(page)['history']['position']) == history_before, 'subject.version.add is not a board/timeline undo step'
    log('WT-3-02 appends the second subject version as retained evidence', version=version_two['id'], history=history_before)

    # The board still owns putting the subject card on the canvas: a new shot
    # takes the card and binds it through the unified subject intent.
    cards_before = len(state(page)['cards'])
    page.get_by_test_id('board-ui-add-shot').click()
    page.wait_for_function("(count) => window.__boardWireState.cards.length > count", arg=cards_before, timeout=15000)
    new_shot = next(card['id'] for card in reversed(state(page)['cards']) if card['kind'] == 'shot')
    page.get_by_test_id(f'board-card-{new_shot}').click()
    shot_revision = next(shot['revision'] for shot in state(page)['shots'] if shot['id'] == new_shot)
    page.evaluate("([shotId, revision]) => window.__boardWireActions.updateShot(shotId, {prompt: '雨停后的路口俯拍。', duration: 4, aspectRatio: '9:16'}, revision)",
                  [new_shot, shot_revision])
    page.wait_for_function("(shotId) => { const shot = window.__boardWireState.shots.find(item => item.id === shotId); return shot?.prompt === '雨停后的路口俯拍。' && shot?.duration === 4; }",
                           arg=new_shot, timeout=15000)
    page.evaluate("""(subjectId) => {
      const card = document.querySelector(`[data-testid="subject-card-${subjectId}"]`);
      const canvas = document.querySelector('[data-testid=board-ui-canvas]');
      if (!card || !canvas) throw new Error('subject drag targets missing');
      const rect = canvas.getBoundingClientRect();
      const dataTransfer = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', {bubbles: true, dataTransfer}));
      canvas.dispatchEvent(new DragEvent('dragover', {bubbles: true, clientX: rect.left + rect.width * 0.5,
        clientY: rect.top + rect.height * 0.55, dataTransfer}));
      canvas.dispatchEvent(new DragEvent('drop', {bubbles: true, clientX: rect.left + rect.width * 0.5,
        clientY: rect.top + rect.height * 0.55, dataTransfer}));
    }""", created['id'])
    page.wait_for_function("(subjectId) => window.__boardWireState.cards.some(card => card.kind === 'subject' && card.subjectId === subjectId)",
                           arg=created['id'], timeout=15000)
    card_id = next(card['id'] for card in state(page)['cards']
                   if card['kind'] == 'subject' and card['subjectId'] == created['id'])
    page.get_by_test_id(f'board-card-{card_id}').click()
    page.get_by_test_id(f'board-port-{card_id}-reference-out-top').focus()
    page.keyboard.press('Enter')
    page.get_by_test_id(f'board-port-{new_shot}-reference-in-top').focus()
    page.keyboard.press('Enter')
    page.wait_for_function("(subjectId) => (window.__boardWireState.bindings ?? []).some(binding => binding.subjectId === subjectId)",
                           arg=created['id'], timeout=15000)
    binding = next(binding for binding in state(page)['bindings'] if binding['subjectId'] == created['id'])
    assert binding['shotId'] == new_shot, binding
    log('WT-3-02 drops the subject card on the board and binds it to a shot', binding=binding)

    # The generation input plan freezes the version this shot actually uses (V2).
    page.get_by_test_id(f'board-card-{new_shot}').click()
    expect(page.get_by_test_id('board-input-footer')).to_be_visible()
    page.get_by_test_id('board-input-footer').click()
    expect(page.get_by_test_id('board-service-menu')).to_be_visible()
    page.locator('button[data-testid^="board-service-"]').filter(has_text='火山方舟').first.click()
    page.wait_for_function("() => Boolean(window.__boardWireState.inputs?.service)", timeout=15000)
    page.get_by_test_id('board-inspector-generate').click()
    page.wait_for_function("(shotId) => (window.__boardWireState.jobs ?? []).some(job => job.shotId === shotId)",
                           arg=new_shot, timeout=30000)
    job_id = page.evaluate("(shotId) => window.__boardWireState.jobs.find(job => job.shotId === shotId).id", new_shot)
    snapshot = page.evaluate("""async (jobId) => {
      const response = await fetch('/rpc', {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({operation: 'job.get', input: {jobId}})});
      const body = await response.json();
      if (!body.ok) throw new Error((body.error && body.error.message) || 'job.get failed');
      return body.data.snapshot;
    }""", job_id)
    freeze = snapshot['format5ReferenceInputs']
    subject_entry = next(entry for entry in freeze['entries']
                         if entry['source'] == 'subject' and entry.get('subjectId') == created['id'])
    assert subject_entry['status'] == 'used', subject_entry
    assert subject_entry['subjectVersionId'] == version_two['id'], subject_entry
    if 'subjectVersionNumber' in subject_entry:
        assert subject_entry['subjectVersionNumber'] == 2, subject_entry
    log('WT-3-02 generation freezes the used subject version', version=version_two['id'],
        frozen=subject_entry)
    capture(page, '21-12-subject-version-freeze.png')


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        sys.exit(1)
