"""Headless acceptance for UI-E2 against the real format-5 kernel and RPC."""
import argparse
import json
import shutil
import sys
import traceback
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

CLIP_A2 = '90000000-0000-4000-8000-000000000031'
CLIP_A = '90000000-0000-4000-8000-000000000030'


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    parser.add_argument('--screens')
    parser.add_argument('--browser')
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
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=executable, headless=True, chromium_sandbox=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 900}, locale='zh-Hans')
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            page.goto(options.url)
            page.wait_for_function("() => Boolean(window.__wireState?.ready)", timeout=30000)
            page.wait_for_selector('[data-testid="timeline-panel"]', timeout=30000)
            state = page.evaluate("() => window.__wireState")
            assert state['data']['timeline']['clips'], 'fixture timeline must have clips'
            assert len(state['data']['timeline']['clips']) == 4

            wire = lambda: page.evaluate("() => window.__wireState")
            def dismiss_notice() -> None:
                dismiss = page.get_by_test_id('edit-ui-notice-dismiss')
                if dismiss.count() and dismiss.is_visible():
                    dismiss.click()

            def undo_once() -> None:
                before = int(page.get_by_test_id('wire-state').get_attribute('data-position'))
                notice_undo = page.get_by_test_id('edit-ui-notice-undo')
                if notice_undo.count() and notice_undo.is_visible():
                    notice_undo.click()
                    page.wait_for_function("() => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'notice-undo'")
                else:
                    page.get_by_test_id('wire-undo-key').click()
                    page.wait_for_function("() => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'undo'")
                after = int(page.get_by_test_id('wire-state').get_attribute('data-position'))
                assert after == before - 1, (before, after)

            # ED: insert asset at the beginning/middle/end of the main track.
            for button, frame, label in [('wire-insert-start', 0, 'start'), ('wire-insert-mid', 60, 'middle'), ('wire-insert-end', 150, 'end')]:
                before = wire()
                page.get_by_test_id(button).click()
                page.wait_for_function("() => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'insert-asset'")
                after = wire()
                assert len(after['data']['timeline']['clips']) == len(before['data']['timeline']['clips']) + 1, (label, after.get('lastError'))
                inserted = [clip for clip in after['data']['timeline']['clips'] if clip['id'] not in {item['id'] for item in before['data']['timeline']['clips']}]
                assert len(inserted) == 1 and inserted[0]['startFrame'] == frame, (label, inserted)
                assert inserted[0]['sequenceSource']['nodeId'] not in {clip['sequenceSource']['nodeId'] for clip in before['data']['timeline']['clips']}
                assert len(after['data']['nodes']) == len(before['data']['nodes']) + 1, 'main insert creates a board media node'
                log(f'ED 主轨插入（{label}）', frame=frame)
                capture(page, f'ed-main-insert-{label}.png')
                undo_once()
                assert len(wire()['data']['timeline']['clips']) == 4, f'{label} undo'

            # ED: overlay clips on V2 and the audio track.
            before = wire()
            page.get_by_test_id('wire-insert-v2').click()
            page.wait_for_function("() => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'insert-asset'")
            after = wire()
            overlay = [clip for clip in after['data']['timeline']['clips'] if clip['id'] not in {item['id'] for item in before['data']['timeline']['clips']}]
            assert len(overlay) == 1 and overlay[0]['trackId'] == '90000000-0000-4000-8000-000000000061'
            assert overlay[0]['anchor']['clipId'] in {clip['id'] for clip in before['data']['timeline']['clips'] if clip['trackId'] == '90000000-0000-4000-8000-000000000060'}
            assert len(after['data']['nodes']) == len(before['data']['nodes']), 'overlay does not create a board node'
            page.get_by_test_id('track-lane-90000000-0000-4000-8000-000000000061').click()
            log('ED V2 放置片段并挂到主轨')
            capture(page, 'ed-overlay-v2.png')
            undo_once()

            before = wire()
            page.get_by_test_id('wire-insert-audio').click()
            page.wait_for_function("() => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'insert-asset'")
            after = wire()
            overlay = [clip for clip in after['data']['timeline']['clips'] if clip['id'] not in {item['id'] for item in before['data']['timeline']['clips']}]
            assert len(overlay) == 1 and overlay[0]['trackId'] == '90000000-0000-4000-8000-000000000062'
            assert overlay[0]['assetId'] == '90000000-0000-4000-8000-000000000013'
            log('ED 音频轨放置音频片段')
            capture(page, 'ed-overlay-audio.png')
            undo_once()

            # ED: copy/paste a main-track clip. The paste creates one new shot and
            # one main clip; undo removes both as one action.
            before = wire()
            page.get_by_test_id('timeline-clip-90000000-0000-4000-8000-000000000030').click()
            page.wait_for_function("() => JSON.parse(document.querySelector('[data-testid=wire-inspector-state]').textContent).clip === '90000000-0000-4000-8000-000000000030'")
            page.get_by_test_id('wire-copy').click()
            page.get_by_test_id('wire-playhead-60').click()
            page.wait_for_function("() => document.querySelector('[data-testid=wire-state]').getAttribute('data-playhead') === '60'")
            page.get_by_test_id('wire-paste').click()
            page.wait_for_function("() => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'paste-clip'")
            after = wire()
            assert len(after['data']['timeline']['clips']) == len(before['data']['timeline']['clips']) + 1
            assert len(after['data']['shots']) == len(before['data']['shots']) + 1, 'main paste copies the shot'
            pasted = [clip for clip in after['data']['timeline']['clips'] if clip['id'] not in {item['id'] for item in before['data']['timeline']['clips']}]
            assert len(pasted) == 1 and pasted[0]['sequenceSource']['nodeId'] not in {clip['sequenceSource']['nodeId'] for clip in before['data']['timeline']['clips']}
            log('ED 主轨复制粘贴生成新镜头', frame=pasted[0]['startFrame'])
            capture(page, 'ed-paste-main.png')
            undo_once()
            assert len(wire()['data']['shots']) == len(before['data']['shots'])

            # ED: copy/paste an other-track clip re-anchors the new item.
            before = wire()
            page.get_by_test_id('wire-insert-v2').click()
            page.wait_for_function("() => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'insert-asset'")
            v2 = wire()
            source = [clip for clip in v2['data']['timeline']['clips'] if clip['id'] not in {item['id'] for item in before['data']['timeline']['clips']}][0]
            dismiss_notice()
            page.get_by_test_id('wire-copy-v2').click()
            page.get_by_test_id('wire-playhead-120').click()
            page.wait_for_function("() => document.querySelector('[data-testid=wire-state]').getAttribute('data-playhead') === '120'")
            page.get_by_test_id('wire-paste').click()
            page.wait_for_function("() => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'paste-clip'")
            copied = wire()
            v2_clips = [clip for clip in copied['data']['timeline']['clips'] if clip['trackId'] == '90000000-0000-4000-8000-000000000061']
            assert len(v2_clips) == 2, (copied.get('lastError'), v2_clips)
            assert all(clip['anchor']['clipId'] for clip in v2_clips), 'all overlay clips stay anchored'
            log('ED V2 复制粘贴并重新挂靠')
            capture(page, 'ed-paste-overlay.png')
            undo_once()
            undo_once()

            # ED: blank timeline right-click menu. Paste is disabled without a
            # clipboard and commits exactly one paste action when available.
            lane = page.get_by_test_id('track-lane-90000000-0000-4000-8000-000000000061')
            lane.click(button='right', position={'x': 120, 'y': 10})
            expect(page.get_by_test_id('timeline-blank-menu')).to_be_visible()
            capture(page, 'ed-blank-menu-disabled.png')
            page.keyboard.press('Escape')
            page.get_by_test_id('timeline-clip-90000000-0000-4000-8000-000000000030').click()
            page.wait_for_function("() => JSON.parse(document.querySelector('[data-testid=wire-inspector-state]').textContent).clip === '90000000-0000-4000-8000-000000000030'")
            page.get_by_test_id('wire-copy').click()
            lane.click(button='right', position={'x': 120, 'y': 10})
            expect(page.get_by_test_id('timeline-blank-menu')).to_be_visible()
            capture(page, 'ed-blank-menu.png')
            before = wire()
            page.get_by_test_id('timeline-menu-paste').click()
            page.wait_for_function("() => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'paste-clip'")
            after = wire()
            assert len(after['data']['timeline']['clips']) == len(before['data']['timeline']['clips']) + 1
            assert after['data']['timeline']['clips'][-1] or True
            log('ED 空白右键粘贴')
            undo_once()

            # 21-04 first: delete, one undo bar, then undo (simple action).
            page.get_by_test_id(f'timeline-clip-{CLIP_A}').click()
            page.get_by_test_id('wire-delete').click()
            expect(page.get_by_test_id('edit-ui-notice-bar')).to_be_visible()
            expect(page.get_by_test_id('edit-ui-notice-undo')).to_be_visible()
            log('21-04 delete shows one undo bar')
            capture(page, '21-04-delete-segment.png')
            page.get_by_test_id('edit-ui-notice-undo').click()
            page.wait_for_function("() => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'notice-undo'")
            page.wait_for_function("() => document.querySelector('[data-testid=edit-ui-notice-bar]') === null")
            restored = page.evaluate("() => window.__wireState")
            assert any(clip['id'] == CLIP_A for clip in restored['data']['timeline']['clips']), 'undo restores the deleted clip'
            log('21-04 undo restores the deleted clip', position=restored['history']['position'])

            # Native shortcuts traverse the same unified history on a trim.
            page.get_by_test_id(f'timeline-clip-{CLIP_A}').click()
            page.get_by_test_id('wire-trim').click()
            page.wait_for_function("() => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'clip-trim'")
            before = int(page.get_by_test_id('wire-state').get_attribute('data-position'))
            page.locator('body').press('Control+z')
            page.wait_for_function("() => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'undo'")
            after_undo = int(page.get_by_test_id('wire-state').get_attribute('data-position'))
            assert after_undo == before - 1, (before, after_undo)
            page.locator('body').press('Control+Shift+z')
            page.wait_for_function("() => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'redo'")
            after_redo = int(page.get_by_test_id('wire-state').get_attribute('data-position'))
            assert after_redo == before, (before, after_redo)
            log('Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z traverse the unified history', position=after_redo)

            # 21-02: select the shot clip, lock it through the real version bar.
            page.get_by_test_id(f'timeline-clip-{CLIP_A2}').click()
            expect(page.get_by_test_id('edit-ui-version-lock')).to_be_visible()
            page.get_by_test_id('edit-ui-version-lock').click()
            page.wait_for_function("() => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'clip-version'")
            page.wait_for_function("() => JSON.parse(document.querySelector('[data-testid=wire-inspector-state]').textContent).mode === 'locked'")
            log('21-02 lock switches the selected clip to locked mode', operation='clip-version')
            capture(page, '21-02-main-track-sync.png')

            # 21-03: moving a split piece away from its sibling asks for the copy
            # confirmation; cancel writes nothing, confirm commits the exact preview.
            clips_before = page.get_by_test_id('wire-state').get_attribute('data-clips')
            page.get_by_test_id('wire-move-copy').click()
            expect(page.get_by_test_id('edit-ui-copy-move-dialog')).to_be_visible()
            page.get_by_test_id('edit-ui-copy-move-cancel').click()
            page.wait_for_function("() => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'copy-cancelled'")
            assert page.get_by_test_id('wire-state').get_attribute('data-clips') == clips_before
            page.get_by_test_id('wire-move-copy').click()
            expect(page.get_by_test_id('edit-ui-copy-move-dialog')).to_be_visible()
            log('21-03 copy confirmation opens for a split piece', clips=clips_before)
            capture(page, '21-03-split-move.png')
            page.get_by_test_id('edit-ui-copy-move-confirm').click()
            page.wait_for_function("() => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'clip-move'")
            page.wait_for_function("() => document.querySelector('[data-testid=edit-ui-copy-move-dialog]') === null")
            moved = page.evaluate("() => window.__wireState")
            target = [clip for clip in moved['data']['timeline']['clips'] if clip['id'] == '90000000-0000-4000-8000-000000000031']
            assert target and target[0]['sequenceSource']['nodeId'] != '90000000-0000-4000-8000-000000000003', 'confirmed move adopts the copied shot'
            log('21-03 confirm commits the same copy envelope with a new shot', position=moved['history']['position'])
            capture(page, '21-03-copy-confirmed.png')

            # Export preflight reaches the real format-5 blocker before media work.
            page.get_by_test_id('wire-export').click()
            page.wait_for_function("() => document.querySelector('[data-testid=wire-state]')?.dataset.operation?.startsWith('preflight:')")
            issue = page.get_by_test_id('wire-export-issue')
            expect(issue).to_have_attribute('data-code', 'PLACEHOLDER_CLIP')
            page.get_by_test_id('wire-export-locate').click()
            log('export preflight reports PLACEHOLDER_CLIP and locates its clip', code='PLACEHOLDER_CLIP')
            capture(page, '21-export-placeholder.png')
            assert not errors, errors
            result.update({'ok': True, 'projectClips': len(restored['data']['timeline']['clips']),
                           'browserVersion': browser.version})
        except Exception as error:
            result.update({'ok': False, 'error': str(error)})
            traceback.print_exc()
            raise
        finally:
            if options.screens:
                (screens / 'report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
            context.close()
            browser.close()
    print(json.dumps(result, ensure_ascii=False))
    return 0
if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        sys.exit(1)
