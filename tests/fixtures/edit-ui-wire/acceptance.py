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

            # 21-06: the shot properties dialogue panel edits the shot's line list
            # through the real sequence preview/commit and projects real cues; one
            # undo then returns the project to the pristine structural baseline.
            panel = page.get_by_test_id('shot-dialogue')
            expect(panel).to_be_visible()
            textarea = page.get_by_test_id('shot-dialogue-text')
            expect(textarea).to_have_value('我们回不去了。')
            textarea.fill('我们回不去了。\n走吧。')
            page.get_by_test_id('shot-dialogue-save').click()
            page.wait_for_function(
                "() => { const state = window.__wireState;"
                " const shot = (state.data.shots || []).find(item => item.id === '90000000-0000-4000-8000-000000000003');"
                " const cues = (((state.data.timeline || {}).subtitles || {}).cues || [])"
                "   .filter(cue => cue.dialogueRef && cue.dialogueRef.shotId === '90000000-0000-4000-8000-000000000003');"
                " return Boolean(shot) && (shot.dialogue || []).length === 2 && cues.length === 2; }",
                timeout=15000)
            dialogue = page.evaluate('() => window.__wireState')
            shot = [item for item in dialogue['data']['shots'] if item['id'] == '90000000-0000-4000-8000-000000000003'][0]
            assert [line['text'] for line in shot['dialogue']] == ['我们回不去了。', '走吧。'], 'the panel writes the ordered shot lines'
            shot_cues = [cue for cue in dialogue['data']['timeline']['subtitles']['cues']
                         if cue.get('dialogueRef') and cue['dialogueRef']['shotId'] == '90000000-0000-4000-8000-000000000003']
            assert len(shot_cues) == 2, 'each line has one real cue'
            for cue in shot_cues:
                line = [item for item in shot['dialogue'] if item['id'] == cue['dialogueRef']['lineId']][0]
                assert cue['text'] == line['text'], 'the cue text is the same line text'
            all_linked = [cue for cue in dialogue['data']['timeline']['subtitles']['cues'] if cue.get('dialogueRef')]
            expect(page.locator('[data-testid^="subtitle-cue-"][data-dialogue-shot]')).to_have_count(len(all_linked))
            expect(page.get_by_test_id('shot-dialogue-cues')).to_contain_text('2')
            log('21-06 dialogue panel saves lines and their linked subtitle cues', position=dialogue['history']['position'],
                shotCues=len(shot_cues), linkedCues=len(all_linked))
            capture(page, '21-06-dialogue.png')
            # One undo drops the lines and their cues before the structural flows.
            page.get_by_test_id('wire-undo-key').click()
            page.wait_for_function(
                "() => { const state = window.__wireState;"
                " const shot = (state.data.shots || []).find(item => item.id === '90000000-0000-4000-8000-000000000003');"
                " const cues = (((state.data.timeline || {}).subtitles || {}).cues || []);"
                " return document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'undo'"
                "   && (shot.dialogue || []).length === 1 && cues.length === 0; }",
                timeout=15000)
            log('21-06 one undo restores the pre-dialogue shot lines and timeline')


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
