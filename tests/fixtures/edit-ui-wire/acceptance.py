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
    def dismiss_notice(page) -> None:
        # Panel actions show the same undo bar as the app; in the harness it can
        # cover the toolbar, so clear it before the next toolbar click.
        dismiss = page.get_by_test_id('edit-ui-notice-dismiss')
        if dismiss.count() and dismiss.first.is_visible():
            dismiss.first.click()

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


            # UI-E3: format-5 inspector panels write through the same shared
            # preview/commit entry (production mapping + session, real kernel).
            PANEL_CLIP = '90000000-0000-4000-8000-000000000030'
            for label, call in [
                ('panel-rename', 'window.__panel.rename()'),
                ('panel-props', 'window.__panel.props()'),
                ('panel-colour', 'window.__panel.colour()'),
                ('panel-transform', 'window.__panel.transform()'),
            ]:
                outcome = page.evaluate(f"() => {call}")
                assert outcome['ok'], (label, outcome)
            dismiss_notice(page)
            page.locator('body').press('Control+z')
            page.wait_for_function(
                "clipId => { const state = window.__wireState;"
                " const clip = ((state.data || {}).timeline?.clips || []).find(item => item.id === clipId);"
                " return document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'undo'"
                "   && Boolean(clip) && !clip.transform; }",
                arg=PANEL_CLIP, timeout=15000)
            dismiss_notice(page)
            page.locator('body').press('Control+Shift+z')
            page.wait_for_function(
                "clipId => { const state = window.__wireState;"
                " const clip = ((state.data || {}).timeline?.clips || []).find(item => item.id === clipId);"
                " return document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'redo'"
                "   && Boolean(clip?.transform); }",
                arg=PANEL_CLIP, timeout=15000)
            outcome = page.evaluate("() => window.__panel.transition()")
            assert outcome['ok'], outcome
            page.wait_for_function(
                "args => { const state = window.__wireState;"
                " const clips = ((state.data || {}).timeline?.clips || []);"
                " const clip = clips.find(item => item.id === args[0]);"
                " const incoming = clips.find(item => item.id === args[1]);"
                " return clip?.name === '改名镜头' && clip?.gain === 0.5 && clip?.fadeInFrames === 3"
                "   && clip?.colour?.profileId === 'mioon-rec709-sdr-clip-v1' && incoming?.transitionIn?.kind === 'dissolve'; }",
                arg=[PANEL_CLIP, '90000000-0000-4000-8000-000000000031'], timeout=15000)
            unsupported = page.evaluate("() => window.__panel.unsupportedRect()")
            assert unsupported['kind'] == 'unsupported' and unsupported['fields'] == ['rect'], unsupported
            log('UI-E3 inspector property edits go through the shared entry with undo/redo')
            capture(page, 'ui-e3-panels.png')

            # UI-E3 review: the quick transition add entry B hid in AU is back;
            # colour/audio-role/volume-envelope/loudness-gain batches all commit
            # through the same production session, and the format panel path runs.
            # The previous panel check already set a transition on that cut; clear
            # it through the same session so the quick-add button appears again.
            cleared = page.evaluate("() => window.__panel.clearTransition('90000000-0000-4000-8000-000000000031')")
            assert cleared['ok'], cleared
            page.wait_for_function(
                "() => { const state = window.__wireState;"
                " const clip = ((state.data || {}).timeline?.clips || []).find(item => item.id === '90000000-0000-4000-8000-000000000031');"
                " return !clip?.transitionIn; }",
                timeout=15000)
            transition_button = page.get_by_test_id('timeline-transition-add-90000000-0000-4000-8000-000000000031')
            expect(transition_button).to_be_visible()
            expect(transition_button).to_be_enabled()
            transition_button.click()
            page.wait_for_function(
                "() => { const state = window.__wireState;"
                " const clip = ((state.data || {}).timeline?.clips || []).find(item => item.id === '90000000-0000-4000-8000-000000000031');"
                " return document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'panel-transition-add'"
                "   && clip?.transitionIn?.kind === 'dissolve'; }",
                timeout=15000)
            gains = page.evaluate("() => window.__panel.applyGains([{clipId: '90000000-0000-4000-8000-000000000030', gain: 0.8}])")
            assert gains['ok'], gains
            role = page.evaluate("() => window.__panel.audioRole('90000000-0000-4000-8000-000000000030', 'music')")
            assert role['ok'], role
            envelope = page.evaluate("() => window.__panel.envelope('90000000-0000-4000-8000-000000000030')")
            assert envelope['ok'], envelope
            page.wait_for_function(
                "() => { const state = window.__wireState;"
                " const clip = ((state.data || {}).timeline?.clips || []).find(item => item.id === '90000000-0000-4000-8000-000000000030');"
                " return clip?.gain === 0.8 && clip?.audioRole === 'music'"
                "   && clip?.volumeEnvelope?.profileId === 'mioon-clip-linear-attenuation-v1'; }",
                timeout=15000)
            log('UI-E3 AU entries restored: quick transition, colour/audio role/envelope, loudness gains')
            # Format panel (FR-B2) through the production session.commit path.
            format_result = page.evaluate("() => window.__panel.format('landscape_720')")
            assert format_result['ok'], format_result
            page.wait_for_function(
                "() => { const timeline = (window.__wireState.data || {}).timeline || {};"
                " return timeline.width === 1280 && timeline.height === 720; }",
                timeout=15000)
            log('UI-E3 format panel switches the output frame through the shared entry')
            capture(page, 'ui-e3-au-entries.png')

            # Subtitle page: plain add/update/remove, one-step undo, overlap
            # rejection, and an in-flight second click that never writes.
            added = page.evaluate("() => window.__panel.addSubtitle('面板字幕', 10, 20)")
            assert added['ok'], added
            cue_id = added['cueId']
            updated = page.evaluate("(id) => window.__panel.updateSubtitle(id, '面板字幕改')", cue_id)
            assert updated['ok'], updated
            page.wait_for_function(
                "args => { const cues = (((window.__wireState.data || {}).timeline || {}).subtitles || {}).cues || [];"
                " return cues.some(cue => cue.id === args[0] && cue.text === args[1]); }",
                arg=[cue_id, '面板字幕改'], timeout=15000)
            removed = page.evaluate("(id) => window.__panel.removeSubtitle(id)", cue_id)
            assert removed['ok'], removed
            page.wait_for_function(
                "cueId => !((((window.__wireState.data || {}).timeline || {}).subtitles || {}).cues || []).some(cue => cue.id === cueId)",
                arg=cue_id, timeout=15000)
            first = page.evaluate("() => window.__panel.addSubtitle('重叠甲', 10, 20)")
            assert first['ok'], first
            overlap = page.evaluate("() => window.__panel.addSubtitle('重叠乙', 15, 10)")
            assert overlap['ok'] is False and overlap['code'] == 'SEQUENCE_EDIT_SUBTITLE_INVALID', overlap
            dismiss_notice(page)
            page.locator('body').press('Control+z')
            page.wait_for_function(
                "cueId => !((((window.__wireState.data || {}).timeline || {}).subtitles || {}).cues || []).some(cue => cue.id === cueId)",
                arg=first['cueId'], timeout=15000)
            double = page.evaluate("() => window.__panel.double()")
            assert double == ['applied', 'SEQUENCE_EDIT_PATCH_INVALID'], double
            log('UI-E3 subtitle add/update/remove, overlap rejection and one-flight guard')

            # A dialogue-linked cue edits the shot line in the same action: the
            # subtitle page text edit and remove round-trip through DL-a.
            textarea = page.get_by_test_id('shot-dialogue-text')
            textarea.fill('我们回不去了。\n走吧。')
            page.get_by_test_id('shot-dialogue-save').click()
            page.wait_for_function(
                "() => { const state = window.__wireState;"
                " const shot = (state.data.shots || []).find(item => item.id === '90000000-0000-4000-8000-000000000003');"
                " const cues = (((state.data.timeline || {}).subtitles || {}).cues || [])"
                "   .filter(cue => cue.dialogueRef && cue.dialogueRef.shotId === '90000000-0000-4000-8000-000000000003');"
                " return Boolean(shot) && (shot.dialogue || []).length === 2 && cues.length === 2; }",
                timeout=15000)
            linked = page.evaluate("() => (((window.__wireState.data || {}).timeline || {}).subtitles || {}).cues || []")
            linked_cues = [cue for cue in linked if cue.get('dialogueRef')]
            assert len(linked_cues) == 2, linked_cues
            target = linked_cues[1]
            linked_edit = page.evaluate("(id) => window.__panel.updateSubtitle(id, '字幕侧改台词')", target['id'])
            assert linked_edit['ok'], linked_edit
            page.wait_for_function(
                "args => { const state = window.__wireState;"
                " const shot = (state.data.shots || []).find(item => item.id === '90000000-0000-4000-8000-000000000003');"
                " const line = (shot?.dialogue || []).find(item => item.id === args[0]);"
                " const cue = ((((state.data || {}).timeline || {}).subtitles || {}).cues || []).find(item => item.id === args[1]);"
                " return line?.text === '字幕侧改台词' && cue?.text === '字幕侧改台词'; }",
                arg=[target['dialogueRef']['lineId'], target['id']], timeout=15000)
            linked_remove = page.evaluate("(id) => window.__panel.removeSubtitle(id)", target['id'])
            assert linked_remove['ok'], linked_remove
            page.wait_for_function(
                "lineId => { const state = window.__wireState;"
                " const shot = (state.data.shots || []).find(item => item.id === '90000000-0000-4000-8000-000000000003');"
                " return (shot?.dialogue || []).length === 1 && !(shot.dialogue || []).some(item => item.id === lineId); }",
                arg=target['dialogueRef']['lineId'], timeout=15000)
            log('UI-E3 dialogue-linked subtitle text edit and remove sync the shot line')
            capture(page, 'ui-e3-dialogue-linked.png')
            # Return to the pristine structural baseline: undo the cue removal,
            # the line-text edit, then the dialogue action. Each press must move
            # the unified cursor back exactly one step; the final state is what
            # this check asserts (the intermediate counts depend on step order).
            for _ in range(3):
                dismiss_notice(page)
                before = int(page.get_by_test_id('wire-state').get_attribute('data-position'))
                page.locator('body').press('Control+z')
                page.wait_for_function(
                    "position => Number(document.querySelector('[data-testid=wire-state]')?.dataset.position) === position",
                    arg=before - 1, timeout=15000)
            page.wait_for_function(
                "() => { const state = window.__wireState;"
                " const shot = (state.data.shots || []).find(item => item.id === '90000000-0000-4000-8000-000000000003');"
                " const cues = (((state.data.timeline || {}).subtitles || {}).cues || []);"
                " return (shot?.dialogue || []).length === 1 && cues.length === 0; }",
                timeout=15000)

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
            trim_base = int(page.get_by_test_id('wire-state').get_attribute('data-position'))
            page.get_by_test_id('wire-trim').click()
            # The label lands before the follow-up history refresh; wait for the
            # cursor too so the shortcut expectations below are exact.
            page.wait_for_function(
                "position => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'clip-trim'"
                " && Number(document.querySelector('[data-testid=wire-state]')?.dataset.position) === position",
                arg=trim_base + 1, timeout=15000)
            before = trim_base + 1
            page.locator('body').press('Control+z')
            # The shortcut publishes its operation before the follow-up history
            # refresh lands; wait for the cursor itself, not just the label.
            page.wait_for_function(
                "position => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'undo'"
                " && Number(document.querySelector('[data-testid=wire-state]')?.dataset.position) === position",
                arg=before - 1, timeout=15000)
            after_undo = int(page.get_by_test_id('wire-state').get_attribute('data-position'))
            assert after_undo == before - 1, (before, after_undo)
            page.locator('body').press('Control+Shift+z')
            page.wait_for_function(
                "position => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'redo'"
                " && Number(document.querySelector('[data-testid=wire-state]')?.dataset.position) === position",
                arg=before, timeout=15000)
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
