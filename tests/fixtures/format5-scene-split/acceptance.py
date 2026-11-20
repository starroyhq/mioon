"""Headless acceptance for the format-5 scene-split success path against the
real kernel. Real synthetic media is imported and detected before the browser
starts; the browser itself runs the production scene-detection controller, the
production dialog and the production shared preview/commit session. Every step
is screenshotted and the run writes screens/report.json."""
import argparse
import json
import shutil
import sys
import traceback
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

PROJECT = '93000000-0000-4000-8000-000000000001'
V1 = '93000000-0000-4000-8000-000000000060'
V2 = '93000000-0000-4000-8000-000000000061'
V3 = '93000000-0000-4000-8000-000000000062'
CLIP_SINGLE = '93000000-0000-4000-8000-000000000030'
CLIP_MULTI_LEFT = '93000000-0000-4000-8000-000000000031'
CLIP_MULTI_RIGHT = '93000000-0000-4000-8000-000000000032'
CLIP_DETECT = '93000000-0000-4000-8000-000000000033'
CLIP_MULTI_V2 = '93000000-0000-4000-8000-000000000034'
CLIP_FADE = '93000000-0000-4000-8000-000000000035'
CLIP_NO_CUT = '93000000-0000-4000-8000-000000000036'
SINGLE_ASSET_NAME = 'scene-single.mp4'
MULTI_ASSET_NAME = 'scene-multi.mp4'
DETECT_ASSET_NAME = 'scene-detect.mp4'
CUTS = [30, 60, 90]
# The message counts split clips (one row per clip), not the cut frames inside them.
SPLIT_DONE_ONE = '已在切点处分割 1 个片段'
SPLIT_DONE_SKIPPED = '已在切点处分割 3 个片段；另有 2 个片段的源区间内没有可用切点'
NOTHING_TO_SPLIT = '时间线上来自这个素材的片段，源区间内都没有可用的切点'


def main() -> int:  # noqa: C901 - one linear acceptance script
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    parser.add_argument('--base', required=True)
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
    result = {'checks': [], 'screens': {}, 'rpc': {}, 'projectId': PROJECT}
    def log(name: str, **details) -> None:
        result['checks'].append({'name': name, 'passed': True, **details})
    def capture(page, name: str) -> None:
        if not screens:
            return
        path = screens / name
        page.screenshot(path=str(path), full_page=True)
        result['screens'][name] = str(path)
    def debug_state(page) -> dict:
        return page.evaluate("async () => (await fetch('/debug/state')).json()")
    def wire(page) -> dict:
        return page.evaluate('() => window.__wireState')
    def clips(page) -> list:
        return wire(page)['data']['timeline']['clips']
    def asset_id(page, name: str) -> str:
        for asset in wire(page)['data']['assets']:
            if asset['name'] == name:
                return asset['id']
        raise AssertionError(f'fixture asset {name} is missing')
    def rpc_entries(page, operation: str) -> list:
        return [entry for entry in page.evaluate('() => window.__wireRpcLog ?? []') if entry['operation'] == operation]
    def wait_notice(page, text: str, timeout: int = 20000) -> None:
        page.wait_for_function(
            "text => { const bar = document.querySelector('[data-testid=edit-ui-notice-bar]');"
            " const message = document.querySelector('[data-testid=edit-ui-notice-message]');"
            " return Boolean(bar) && Boolean(message) && message.textContent === text; }",
            arg=text, timeout=timeout)
    def wait_scene_message(page, text: str, timeout: int = 20000) -> None:
        page.wait_for_function(
            "text => (document.querySelector('[data-testid=wire-scene-message]')?.textContent ?? '') === text",
            arg=text, timeout=timeout)
    def split_rows(receipt: dict) -> dict:
        return {row['clipId']: row for row in receipt['sceneSplit']['split']}
    def close_dialog(page) -> None:
        page.get_by_test_id('scene-dialog-close').click()
        page.wait_for_selector('[data-testid=scene-dialog]', state='detached', timeout=15000)
    def dismiss_notice(page) -> None:
        dismiss = page.get_by_test_id('edit-ui-notice-dismiss')
        if dismiss.count() and dismiss.first.is_visible():
            dismiss.first.click()
            page.wait_for_selector('[data-testid=edit-ui-notice-bar]', state='detached', timeout=15000)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=executable, headless=True, chromium_sandbox=True)
        context = browser.new_context(viewport={'width': 1600, 'height': 1000}, locale='zh-Hans')
        page = context.new_page()
        errors: list = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            page.goto(options.url)
            page.wait_for_function('() => Boolean(window.__wireState?.ready)', timeout=60000)
            page.wait_for_selector('[data-testid="timeline-panel"]', timeout=30000)
            pristine = debug_state(page)
            assert len(pristine['clips']) == 7, pristine['clips']
            assert pristine['history']['position'] == 0, pristine['history']
            single, multi, detect = (asset_id(page, SINGLE_ASSET_NAME), asset_id(page, MULTI_ASSET_NAME),
                                     asset_id(page, DETECT_ASSET_NAME))
            assert pristine['scene'][single]['cuts'] == CUTS
            assert pristine['scene'][multi]['cuts'] == CUTS
            assert pristine['scene'][detect]['latestResultId'] is None
            log('F0 fixture has real imported media and real detected cuts', assets=3,
                single=pristine['scene'][single]['latestResultId'], multi=pristine['scene'][multi]['latestResultId'])

            # ---- A: one main-track clip, real dialog entry, preview/commit, undo/redo.
            page.get_by_test_id(f'wire-asset-{single}').click(button='right')
            page.get_by_test_id('asset-menu-detect-scenes').click()
            page.wait_for_selector('[data-testid=scene-dialog][data-view=results]', timeout=30000)
            expect(page.get_by_test_id('scene-dialog')).to_contain_text('时间线上有 1 个片段来自这个素材')
            capture(page, 'g1-dialog-impact.png')
            log('A1 asset library menu opens the production dialog on the real saved result',
                view=page.get_by_test_id('scene-dialog').get_attribute('data-view'))
            page.get_by_test_id('scene-split').click()
            wait_notice(page, SPLIT_DONE_ONE)
            page.wait_for_function(
                "() => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'scene-split'"
                " && document.querySelector('[data-testid=wire-state]')?.dataset.error === ''", timeout=30000)
            after_split_a = debug_state(page)
            pieces = [clip for clip in after_split_a['clips'] if clip['assetId'] == single]
            assert len(pieces) == 4, pieces
            assert [clip['sourceInFrame'] for clip in pieces] == [0] + CUTS, pieces
            assert pieces[0]['id'] == CLIP_SINGLE, pieces[0]
            assert pieces[0]['startFrame'] == 0 and [clip['startFrame'] for clip in pieces] == [0, 30, 60, 90], pieces
            previews, commits = rpc_entries(page, 'sequence.preview'), rpc_entries(page, 'sequence.commit')
            preview, commit = previews[-1], commits[-1]
            intent = preview['input']['intents'][0]['operation']
            assert intent['kind'] == 'track' and intent['edit']['kind'] == 'split-at-scenes', intent
            assert intent['edit']['assetId'] == single, intent
            assert intent['edit']['resultId'] == pristine['scene'][single]['latestResultId'], intent
            envelope = preview['response']['envelope']
            allocation = envelope['allocation']['splitClips']
            assert len(allocation) == 3, allocation
            assert commit['input']['envelope'] == envelope, 'the commit must reuse the previewed envelope'
            assert commit['input']['expectedPlanDigest'] == preview['response']['planDigest']
            receipt = commit['response']
            scene_rows = receipt['sceneSplit']['split']
            assert len(scene_rows) == 1 and scene_rows[0]['cutFrames'] == CUTS, receipt['sceneSplit']
            assert len(scene_rows[0]['clipIds']) == 4 and scene_rows[0]['clipId'] == CLIP_SINGLE, receipt['sceneSplit']
            assert receipt['sceneSplit']['skipped'] == [], receipt['sceneSplit']
            committed_ids = {clip['id'] for clip in after_split_a['clips']}
            assert all(pair['rightClipId'] in committed_ids for pair in allocation), (allocation, committed_ids)
            assert after_split_a['history']['position'] == 1, after_split_a['history']
            capture(page, 'g1-split-applied.png')
            log('A2 split matches the detected cuts and one preview/commit writes one history step',
                split=scene_rows[0]['cutFrames'],
                rightClipIds=[pair['rightClipId'] for pair in allocation], position=after_split_a['history']['position'])

            # ---- A: no usable cut refuses without writing.
            page.get_by_test_id('scene-split').click()
            wait_scene_message(page, NOTHING_TO_SPLIT)
            page.wait_for_function("() => document.querySelector('[data-testid=wire-state]')?.dataset.error === 'NOTHING_TO_SPLIT'")
            refused = debug_state(page)
            after_refusal = {key: refused[key] for key in ('projectRevision', 'timelineRevision', 'syncRevision')}
            before_refusal = {key: after_split_a[key] for key in ('projectRevision', 'timelineRevision', 'syncRevision')}
            assert after_refusal == before_refusal, (before_refusal, after_refusal)
            assert refused['history'] == after_split_a['history'], (after_split_a['history'], refused['history'])
            assert refused['clips'] == after_split_a['clips']
            assert len(rpc_entries(page, 'sequence.commit')) == len(commits)
            close_dialog(page)
            capture(page, 'g1-nothing-to-split.png')
            log('A3 NOTHING_TO_SPLIT reports the reason and writes nothing', revisions=after_refusal)
            page.get_by_test_id('edit-ui-notice-undo').click()
            page.wait_for_selector('[data-testid=edit-ui-notice-bar]', state='detached', timeout=15000)
            page.wait_for_function(
                "position => Number(document.querySelector('[data-testid=wire-state]')?.dataset.position) === position",
                arg=0, timeout=20000)
            undone = debug_state(page)
            assert undone['clips'] == pristine['clips'], 'one undo restores the exact pristine clips'
            assert undone['history']['position'] == 0, undone['history']
            assert undone['history']['revision'] != pristine['history']['revision']
            capture(page, 'g1-undone.png')
            log('A4 one undo restores the pristine timeline', position=undone['history']['position'])
            page.locator('body').press('Control+Shift+z')
            page.wait_for_function(
                "() => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'redo'"
                " && Number(document.querySelector('[data-testid=wire-state]')?.dataset.position) === 1", timeout=20000)
            redone = debug_state(page)
            assert redone['clips'] == after_split_a['clips'], 'redo replays the exact split patch and ids'
            capture(page, 'g1-redone.png')
            log('A5 redo replays the exact split ids and positions', position=redone['history']['position'])

            # ---- B: the same asset on two main-track pieces plus other tracks.
            before_b = debug_state(page)
            page.get_by_test_id(f'wire-asset-{multi}').click(button='right')
            page.get_by_test_id('asset-menu-detect-scenes').click()
            page.wait_for_selector('[data-testid=scene-dialog][data-view=results]', timeout=30000)
            expect(page.get_by_test_id('scene-dialog')).to_contain_text('时间线上有 5 个片段来自这个素材')
            page.get_by_test_id('scene-split').click()
            wait_notice(page, SPLIT_DONE_SKIPPED)
            page.wait_for_function(
                "() => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'scene-split'", timeout=30000)
            scene_split = page.evaluate('() => window.__sceneSplit')
            rows = split_rows(scene_split)
            assert len(rows) == 3, scene_split
            assert rows[CLIP_MULTI_LEFT]['cutFrames'] == [30] and len(rows[CLIP_MULTI_LEFT]['clipIds']) == 2, rows
            assert rows[CLIP_MULTI_RIGHT]['cutFrames'] == [90] and len(rows[CLIP_MULTI_RIGHT]['clipIds']) == 2, rows
            assert rows[CLIP_MULTI_V2]['cutFrames'] == [30, 60, 90] and len(rows[CLIP_MULTI_V2]['clipIds']) == 4, rows
            skipped = {row['clipId']: row for row in scene_split['sceneSplit']['skipped']}
            assert set(skipped) == {CLIP_FADE, CLIP_NO_CUT}, skipped
            assert skipped[CLIP_FADE]['reason'] == 'FADE_BOUNDS' and skipped[CLIP_FADE]['cutFrames'] == [30], skipped
            assert skipped[CLIP_NO_CUT]['reason'] == 'NO_CUT_IN_RANGE', skipped
            page.wait_for_function(
                "() => Number(document.querySelector('[data-testid=wire-state]')?.dataset.position) === 2", timeout=20000)
            after_b = debug_state(page)
            v1_clips = [clip for clip in after_b['clips'] if clip['trackId'] == V1]
            v2_clips = [clip for clip in after_b['clips'] if clip['trackId'] == V2]
            v3_clips = [clip for clip in after_b['clips'] if clip['trackId'] == V3]
            before_v3 = [clip for clip in before_b['clips'] if clip['trackId'] == V3]
            before_v2 = [clip for clip in before_b['clips'] if clip['trackId'] == V2]
            assert len(v1_clips) == 9, v1_clips
            assert len(v2_clips) == 4 and len(v3_clips) == 2, (v2_clips, v3_clips)
            assert v3_clips == before_v3, (before_v3, v3_clips)
            assert v2_clips[0]['id'] == CLIP_MULTI_V2 and [clip['sourceInFrame'] for clip in v2_clips] == [0] + CUTS, v2_clips
            v1_ids = {clip['id'] for clip in v1_clips}
            for clip in v2_clips[1:]:
                assert clip['anchor'] and clip['anchor']['clipId'] in v1_ids, clip
                owner = next(item for item in v1_clips if item['id'] == clip['anchor']['clipId'])
                assert clip['startFrame'] == owner['startFrame'] + clip['anchor']['offsetFrames'], clip
            committed_ids = {clip['id'] for clip in after_b['clips']}
            for row in rows.values():
                assert all(clip_id in committed_ids for clip_id in row['clipIds'][1:]), row
            assert [{clip['id'] for clip in before_v2} <= {clip['id'] for clip in v2_clips}]
            capture(page, 'g2-multi-applied.png')
            close_dialog(page)
            capture(page, 'g2-skip-reasons.png')
            log('B1 two main-track pieces and the other track split, fade/no-cut rows carry their reason',
                split=len(rows), skipped=[{'clipId': row['clipId'], 'reason': row['reason'], 'cutFrames': row.get('cutFrames')}
                                          for row in scene_split['sceneSplit']['skipped']],
                notice=page.get_by_test_id('edit-ui-notice-message').text_content())
            page.get_by_test_id('edit-ui-notice-undo').click()
            page.wait_for_selector('[data-testid=edit-ui-notice-bar]', state='detached', timeout=15000)
            page.wait_for_function(
                "() => Number(document.querySelector('[data-testid=wire-state]')?.dataset.position) === 1", timeout=20000)
            undone_b = debug_state(page)
            assert undone_b['clips'] == before_b['clips'], 'one undo restores the pre-split multi state'
            capture(page, 'g2-undone.png')
            page.locator('body').press('Control+Shift+z')
            page.wait_for_function(
                "() => document.querySelector('[data-testid=wire-state]')?.dataset.operation === 'redo'"
                " && Number(document.querySelector('[data-testid=wire-state]')?.dataset.position) === 2", timeout=20000)
            redone_b = debug_state(page)
            assert redone_b['clips'] == after_b['clips'], 'redo replays the multi split exactly'
            log('B2 one undo/redo round-trips the multi-track split', position=redone_b['history']['position'])

            # ---- C: detect in the library first, then split in the editing view.
            page.get_by_test_id(f'wire-asset-{detect}').click(button='right')
            page.get_by_test_id('asset-menu-detect-scenes').click()
            page.wait_for_selector('[data-testid=scene-progress]', timeout=30000)
            capture(page, 'g4-detect-progress.png')
            page.wait_for_selector('[data-testid=scene-dialog][data-view=results]', timeout=90000)
            page.wait_for_function(
                "() => { const split = document.querySelector('[data-testid=scene-split]');"
                " return Boolean(split) && !split.disabled; }", timeout=60000)
            detections = rpc_entries(page, 'scene.detect')
            assert detections and detections[-1]['input']['sourceAssetId'] == detect, detections
            page.wait_for_function(
                "assetId => { const results = window.__wireState?.scene?.results ?? {};"
                " const view = results[assetId]; const result = view?.response?.result;"
                " return Boolean(result) && result.cuts.length === 3; }", arg=detect, timeout=60000)
            scene_result = page.evaluate(
                "assetId => { const view = window.__wireState.scene.results[assetId];"
                " return {id: view.response.result.id, cuts: view.response.result.cuts.map(cut => cut.frame), current: view.response.current}; }",
                detect)
            assert scene_result['cuts'] == CUTS and scene_result['current'] is True, scene_result
            detect_state = debug_state(page)
            assert detect_state['scene'][detect]['latestResultId'] == scene_result['id'], detect_state['scene'][detect]
            assert detect_state['scene'][detect]['cuts'] == CUTS
            expect(page.get_by_test_id('scene-dialog')).to_contain_text('时间线上有 1 个片段来自这个素材')
            capture(page, 'g4-detect-result.png')
            log('C1 library detection runs the production task and saves the latest result',
                resultId=scene_result['id'], taskState='succeeded')
            page.get_by_test_id('scene-split').click()
            wait_notice(page, SPLIT_DONE_ONE)
            page.wait_for_function(
                "() => Number(document.querySelector('[data-testid=wire-state]')?.dataset.position) === 3", timeout=30000)
            after_c = debug_state(page)
            detect_pieces = [clip for clip in after_c['clips'] if clip['assetId'] == detect]
            assert len(detect_pieces) == 4 and [clip['sourceInFrame'] for clip in detect_pieces] == [0] + CUTS, detect_pieces
            assert detect_pieces[0]['id'] == CLIP_DETECT and [clip['startFrame'] for clip in detect_pieces] == [240, 270, 300, 330]
            last_preview = rpc_entries(page, 'sequence.preview')[-1]
            assert last_preview['input']['intents'][0]['operation']['edit']['resultId'] == scene_result['id']
            capture(page, 'g4-detect-split.png')
            log('C2 the split uses the result the browser just detected',
                resultId=scene_result['id'], cuts=[clip['sourceInFrame'] for clip in detect_pieces])

            final = debug_state(page)
            assert len(final['clips']) == 18, len(final['clips'])
            assert final['history']['position'] == 3, final['history']
            capture(page, 'g-final-state.png')
            log('F1 final state: 18 clips, history position 3', clips=len(final['clips']), position=final['history']['position'])
            result['rpc'] = {'preview': len(rpc_entries(page, 'sequence.preview')), 'commit': len(rpc_entries(page, 'sequence.commit')),
                             'sceneDetect': len(rpc_entries(page, 'scene.detect')),
                             'sceneTaskGet': len(rpc_entries(page, 'scene.task.get'))}
            result['final'] = {'clips': len(final['clips']), 'historyPosition': final['history']['position'],
                               'timelineRevision': final['timelineRevision'], 'syncRevision': final['syncRevision']}
            assert not errors, errors
            result.update({'ok': True, 'browserVersion': browser.version})
        except Exception as error:
            try:
                if screens:
                    page.screenshot(path=str(screens / 'failure.png'), full_page=True)
                    (screens / 'failure.html').write_text(page.content())
                    result['screens']['failure.png'] = str(screens / 'failure.png')
                result.update({'ok': False, 'error': str(error), 'state': debug_state(page), 'wire': wire(page),
                               'pageErrors': errors})
            except Exception:  # noqa: BLE001 - keep the original failure
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
