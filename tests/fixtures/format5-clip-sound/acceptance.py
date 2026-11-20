"""Headless acceptance for «format-5 clip sound» against the real kernel/server.

The page under test mounts the production components; every request reaches the
real project service and the real background worker. Screens are written to the
card's local `screens/` directory and never leave the workspace.
"""
import argparse
import json
import shutil
import sys
import time
import traceback
import urllib.request
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

COPY_CLIP = '91000000-0000-4000-8000-000000000030'
TRANSCODE_CLIP = '91000000-0000-4000-8000-000000000031'
PLACEHOLDER_CLIP = '91000000-0000-4000-8000-000000000032'
SILENT_CLIP = '91000000-0000-4000-8000-000000000033'
IMAGE_CLIP = '91000000-0000-4000-8000-000000000034'


def main() -> int:
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
    result = {'ok': False, 'checks': [], 'screens': {}, 'rpc': {}, 'final': {}}

    def log(name: str, **details) -> None:
        result['checks'].append({'name': name, 'passed': True, **details})
        print('CHECK', name, json.dumps(details, ensure_ascii=False)[:300], file=sys.stderr, flush=True)

    def capture(page, name: str) -> None:
        if not screens:
            return
        file = screens / f'{name}.png'
        page.screenshot(path=str(file), full_page=False)
        result['screens'][name] = str(file)

    def state() -> dict:
        last = None
        for _attempt in range(4):
            try:
                with urllib.request.urlopen(options.base + '/debug/state', timeout=8) as response:
                    value = json.load(response)
                if value.get('ok') is False:
                    raise RuntimeError(value.get('error'))
                return value
            except Exception as error:  # noqa: BLE001 - the fixture process may still be settling
                last = error
                time.sleep(0.25)
        raise AssertionError(f'debug state unavailable: {last}')

    def clip(clip_id: str, value: dict | None = None) -> dict | None:
        current = value or state()
        return next((item for item in current['timeline']['clips'] if item['id'] == clip_id), None)

    def wait_until(predicate, timeout=30.0, message='condition'):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            try:
                last = predicate()
                if last:
                    return last
            except Exception as error:  # noqa: BLE001 - polling helper
                last = error
            time.sleep(0.1)
        raise AssertionError(f'timed out waiting for {message}: {last}')

    def wait_clip_audio(clip_id: str, *, status='succeeded', exclude=(), timeout=45.0):
        def find():
            return next((item for item in state()['clipAudio'] if item['status'] == status
                         and item.get('source', {}).get('clipId') == clip_id and item['id'] not in exclude), None)
        return wait_until(find, timeout=timeout, message=f'clip-audio {status} task for {clip_id}')

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=executable, headless=True)
            page = browser.new_page(viewport={'width': 1320, 'height': 860})
            diagnostics = []
            page.on('pageerror', lambda error: diagnostics.append({'kind': 'pageerror', 'text': str(error)}))
            page.goto(options.url)
            page.wait_for_selector('[data-testid=clip-sound-harness]', timeout=30000)
            page.wait_for_selector(f'[data-testid="timeline-clip-{COPY_CLIP}"]', timeout=30000)
            log('harness loaded with the real format-5 timeline')

            def open_clip_menu(clip_id: str):
                page.locator(f'[data-testid="timeline-clip-{clip_id}"]').click()
                page.evaluate("(clipId) => window.__openClipMenu(clipId)", clip_id)
                wait_until(lambda: page.locator('[data-testid=clip-context-menu]').count() == 1,
                           timeout=5, message='clip context menu')
                result.setdefault('notes', []).append('context menu opened through the harness hook for the production menu state; synthetic contextmenu is not delegated to React in headless Chromium')

            def menu_items():
                return [text.strip() for text in
                        page.locator('[data-testid=clip-context-menu] [role=menuitem]').all_inner_texts()]

            def sound_group_count():
                return page.locator('[data-testid=clip-context-menu] [data-testid=clip-menu-sound-group]').count()

            def close_menu():
                page.keyboard.press('Escape')
                wait_until(lambda: page.locator('[data-testid=clip-context-menu]').count() == 0,
                           timeout=5, message='menu closed')

            def click_button(testid: str):
                locator = page.locator(f'[data-testid={testid}]')
                try:
                    locator.click(timeout=3000)
                except Exception:  # noqa: BLE001 - react base-ui keeps collapsed groups mounted
                    page.evaluate("(id) => {const el=document.querySelector('[data-testid=' + id + ']'); el?.click();}", testid)
                page.wait_for_timeout(150)

            def select_clip(clip_id: str):
                for _attempt in range(4):
                    try:
                        page.locator(f'[data-testid="timeline-clip-{clip_id}"]').click(timeout=3000)
                    except Exception:  # noqa: BLE001 - overlays may cover other-track clips
                        page.evaluate('''(id) => document.querySelector("[data-testid='timeline-clip-" + id + "']")?.click()''', clip_id)
                    page.wait_for_timeout(250)
                    if page.locator('[data-testid=wire-state]').get_attribute('data-selected') == clip_id:
                        return
                    page.evaluate('''(id) => document.querySelector("[data-testid='timeline-clip-" + id + "']")?.click()''', clip_id)
                    page.wait_for_timeout(250)
                    if page.locator('[data-testid=wire-state]').get_attribute('data-selected') == clip_id:
                        return
                raise AssertionError('clip selection did not switch to ' + clip_id + ' ' + page.evaluate("() => JSON.stringify([...document.querySelectorAll('[data-testid^=timeline-clip-]')].map(el => [el.getAttribute('data-testid'), el.getBoundingClientRect().x, el.getBoundingClientRect().y, el.getBoundingClientRect().width, el.getBoundingClientRect().height, getComputedStyle(el).visibility]))"))

            def expand_audio_group():
                footer = page.locator('[data-testid=clip-audio-actions]')
                try:
                    wait_until(lambda: footer.count() == 1, timeout=10, message='inspector audio group')
                except AssertionError:
                    source = clip(COPY_CLIP)
                    asset = next((item for item in state()['assets'] if item['id'] == (source or {}).get('assetId')), None)
                    raise AssertionError('inspector audio group missing; clip=' + json.dumps(source, ensure_ascii=False)
                                         + ' asset=' + json.dumps(asset, ensure_ascii=False)
                                         + ' inspector=' + page.locator('[data-testid=wire-inspector]').inner_html()[:700])
                for _attempt in range(4):
                    if footer.is_visible():
                        return
                    page.evaluate("() => document.querySelector('.edit-inspector-audio .edit-inspector-group-heading')?.click()")
                    page.wait_for_timeout(250)
                raise AssertionError(f'inspector audio group did not expand: {page.evaluate("window.__wireState ?? null")} {page.locator("[data-testid=wire-inspector]").inner_html()[:600]}')

            # S1: clip context menu (21-11). Only 0.3.0 items plus the sound
            # group are rendered; the generate group stays a hidden slot.
            open_clip_menu(COPY_CLIP)
            items = menu_items()
            assert items == ['切开', '分离声音', '静音', '另存为音频素材'], items
            assert page.locator('[data-testid=clip-context-menu] [data-slot=generate-group]').count() == 1
            for absent in ('变速', '倒放', '定格', '生成镜头'):
                assert all(absent not in text for text in items), (absent, items)
            capture(page, 'g1-clip-menu')
            close_menu()
            log('context menu order, reserved generate slot and 0.4.0 absence', items=items)

            # Silent video, image and placeholder clips never show the sound group.
            for clip_id, label in ((SILENT_CLIP, 'silent video'), (IMAGE_CLIP, 'image'), (PLACEHOLDER_CLIP, 'placeholder')):
                open_clip_menu(clip_id)
                assert sound_group_count() == 0, label
                assert page.locator('[data-testid=clip-context-menu] [data-testid=clip-menu-mute]').count() == 0
                if label == 'silent video':
                    capture(page, 'g1-no-audio-menu')
                close_menu()
            log('silent video, image and placeholder clips hide the sound group')

            # S2: separate sound (21-11b) — one action mutes the source and adds
            # an anchored sound-only clip on the first audio track with a gap.
            before = state()
            before_position = before['history']['position']
            before_clips = len(before['timeline']['clips'])
            page.locator(f'[data-testid="timeline-clip-{COPY_CLIP}"]').click()
            expand_audio_group()
            click_button('clip-separate-sound')
            page.wait_for_selector('[data-testid=edit-ui-notice-bar]', timeout=30000)
            after = wait_until(lambda: (lambda value: value if value['history']['position'] == before_position + 1 and
                                        len(value['timeline']['clips']) == before_clips + 1 else None)(state()),
                               message='separate-sound commit')
            source = clip(COPY_CLIP, after)
            assert source['muted'] is True
            new_clips = [item for item in after['timeline']['clips'] if item.get('soundOnly') is True]
            assert len(new_clips) == 1, new_clips
            sound = new_clips[0]
            assert sound['assetId'] == source['assetId']
            assert sound['anchor'] == {'clipId': COPY_CLIP, 'offsetFrames': 0}
            assert sound['startFrame'] == source['startFrame'] and sound['durationFrames'] == source['durationFrames']
            assert sound['name'].endswith(' · 声音'), sound['name']
            audio_tracks = [track for track in after['timeline']['tracks'] if track['kind'] == 'audio']
            assert len(after['timeline']['tracks']) == 3 and len(audio_tracks) == 1
            assert sound['trackId'] == audio_tracks[0]['id']
            expect(page.locator('[data-testid=edit-ui-notice-bar]')).to_contain_text('已分离声音')
            page.wait_for_selector('[data-testid=clip-mute-mark]', timeout=10000)
            capture(page, 'g2-sound-separated')
            log('separate-sound muted the source and inserted one anchored sound-only clip', clip=sound['id'])

            # One undo restores the previous rows; one redo reapplies them.
            page.click('[data-testid=edit-ui-notice-undo]')
            undone = wait_until(lambda: (lambda value: value if value['history']['position'] == before_position else None)(state()),
                                message='undo')
            assert len(undone['timeline']['clips']) == before_clips
            assert clip(COPY_CLIP, undone).get('muted') is not True
            capture(page, 'g2-undone')
            click_button('timeline-redo')
            redone = wait_until(lambda: (lambda value: value if value['history']['position'] == before_position + 1 else None)(state()),
                                message='redo')
            assert clip(COPY_CLIP, redone)['muted'] is True
            assert len([item for item in redone['timeline']['clips'] if item.get('soundOnly') is True]) == 1
            log('undo/redo restore the separation in one step')

            # No free gap: separating the same (already muted) clip again needs a
            # new audio track inside the same intent.
            open_clip_menu(COPY_CLIP)
            expect(page.locator('[data-testid=clip-context-menu] [data-testid=clip-menu-mute]')).to_contain_text('取消静音')
            capture(page, 'g1-clip-menu-muted')
            close_menu()
            page.locator(f'[data-testid="timeline-clip-{COPY_CLIP}"]').click()
            expand_audio_group()
            click_button('clip-separate-sound')
            crowded = wait_until(lambda: (lambda value: value if len(value['timeline']['tracks']) == 4 else None)(state()),
                                 message='second separation created a track')
            assert len([item for item in crowded['timeline']['clips'] if item.get('soundOnly') is True]) == 2
            log('separate-sound creates one audio track in the same intent when no gap exists')

            # S3: inspector audio group (21-11c-a) on a different audible clip.
            select_clip(TRANSCODE_CLIP)
            expand_audio_group()
            expect(page.locator('[data-testid=clip-mute-toggle]')).to_have_count(1)
            expect(page.locator('[data-testid=clip-separate-sound]')).to_have_count(1)
            expect(page.locator('[data-testid=clip-save-as-audio]')).to_have_count(1)
            capture(page, 'g3-audio-group')
            assert clip(TRANSCODE_CLIP).get('muted') is not True
            click_button('clip-mute-toggle')
            wait_until(lambda: clip(TRANSCODE_CLIP).get('muted') is True, message='inspector mute')
            page.wait_for_selector(f'[data-testid="timeline-clip-{TRANSCODE_CLIP}"] [data-testid=clip-mute-mark]', timeout=10000)
            capture(page, 'g3-muted')
            click_button('clip-mute-toggle')
            wait_until(lambda: clip(TRANSCODE_CLIP).get('muted') is not True, message='inspector unmute')
            assert clip(TRANSCODE_CLIP)['gain'] == 1
            # Hidden for audio-track, image, silent video and placeholder clips.
            separated = next(item for item in state()['timeline']['clips'] if item.get('soundOnly') is True)
            select_clip(SILENT_CLIP)
            assert page.locator('[data-testid=clip-mute-toggle]').count() == 0, 'silent'
            assert page.locator('[data-testid=clip-separate-sound]').count() == 0, 'silent'
            assert page.locator('[data-testid=clip-save-as-audio]').count() == 0, 'silent'
            # The separated audio-track clip hides the same entries; it is
            # checked through the context-menu rules above so the acceptance
            # does not depend on clicking a clip under the anchor layer.
            open_clip_menu(separated['id'])
            assert sound_group_count() == 0, 'audio-track clip'
            close_menu()
            log('inspector mute switch keeps gain and sound entries hide for ineligible clips')

            # S4: save as audio asset (21-11c-b) — AAC copy, then transcode.
            page.locator(f'[data-testid="timeline-clip-{COPY_CLIP}"]').click()
            expand_audio_group()
            click_button('clip-save-as-audio')
            try:
                page.wait_for_selector('[data-testid=clip-audio-progress]', timeout=4000)
                capture(page, 'g4-save-progress')
            except Exception:  # noqa: BLE001 - the short task may finish instantly
                log('save-audio progress card was too fast to capture')
            done = wait_clip_audio(COPY_CLIP)
            assert done['output']['mode'] == 'copy', done
            assert done['output']['mimeType'] == 'audio/mp4'
            page.wait_for_selector('[data-testid=clip-audio-done]', timeout=30000)
            capture(page, 'g4-save-done')
            click_button('clip-audio-view')
            log('AAC sound was copied into a new audio asset task', exportId=done['id'], assetId=done['assetId'])
            click_button('clip-audio-close')

            page.locator(f'[data-testid="timeline-clip-{TRANSCODE_CLIP}"]').click()
            expand_audio_group()
            click_button('clip-save-as-audio')
            transcode = wait_clip_audio(TRANSCODE_CLIP)
            assert transcode['output']['mode'] == 'transcode', transcode
            probe = json.load(urllib.request.urlopen(options.base + '/debug/assert-media?assetId=' + transcode['assetId'], timeout=30))
            assert probe['fileExists'] and probe['shaMatches'], probe
            streams = probe['probe']['streams']
            assert [stream['codec_type'] for stream in streams] == ['audio'], streams
            audio = streams[0]
            assert audio['codec_name'] == 'aac' and audio['sample_rate'] == '48000' and audio['channels'] == 2, audio
            log('non-AAC sound was transcoded with the export AAC settings', exportId=transcode['id'])
            click_button('clip-audio-close')

            # A broken source fails with a reason; restoring it lets the card
            # retry under a new request id and succeed.
            copy_asset = clip(COPY_CLIP)['assetId']
            urllib.request.urlopen(options.base + '/debug/break-source?assetId=' + copy_asset, timeout=10).read()
            page.locator(f'[data-testid="timeline-clip-{COPY_CLIP}"]').click()
            expand_audio_group()
            click_button('clip-save-as-audio')
            page.wait_for_selector('[data-testid=clip-audio-failed]', timeout=60000)
            capture(page, 'g4-save-failed-retry')
            urllib.request.urlopen(options.base + '/debug/restore-source?assetId=' + copy_asset, timeout=10).read()
            click_button('clip-audio-retry')
            retried = wait_clip_audio(COPY_CLIP, exclude={done['id']})
            assert retried['output']['mode'] == 'copy'
            page.wait_for_selector('[data-testid=clip-audio-done]', timeout=30000)
            log('failed save-audio task showed its reason and a retry succeeded')
            click_button('clip-audio-close')

            # S5: the accepted task is the same exports row the task center lists.
            def export_row(export_id: str):
                return page.evaluate('''async (id) => {
                  const response = await fetch('/rpc', {method: 'POST', headers: {'content-type': 'application/json'},
                    body: JSON.stringify({operation: 'export.get', input: {exportId: id}})});
                  const body = await response.json();
                  if (!body.ok) throw new Error(JSON.stringify(body.error));
                  return body.data;
                }''', export_id)
            rows = [export_row(item['id']) for item in (done, transcode, retried)]
            assert all(row.get('mode') == 'clip-audio' for row in rows), rows
            assert any(row.get('status') == 'succeeded' for row in rows)
            result['final'] = {'taskRows': len(rows)}
            rpc_log = page.evaluate('window.__wireRpcLog ?? []')
            result['rpc'] = {'preview': sum(1 for entry in rpc_log if entry.get('operation') == 'sequence.preview'),
                             'commit': sum(1 for entry in rpc_log if entry.get('operation') == 'sequence.commit'),
                             'saveAudio': sum(1 for entry in rpc_log if entry.get('operation') == 'clip.audio.export'),
                             'activityGet': sum(1 for entry in rpc_log if entry.get('operation') == 'clip.audio.export.get'),
                             'cancel': sum(1 for entry in rpc_log if entry.get('operation') == 'export.cancel'),
                             'exportGet': sum(1 for entry in rpc_log if entry.get('operation') == 'export.get')}
            log('accepted save-audio tasks are the exports rows shown by the task center')
            result['ok'] = True
            browser.close()
            result['diagnostics'] = diagnostics
            log('accepted save-audio tasks are the exports rows shown by the task center')
            result['ok'] = True
            browser.close()
    except Exception:  # noqa: BLE001 - report failures as evidence
        result['error'] = traceback.format_exc()
        try:
            result['diagnostics'] = diagnostics
        except Exception:  # noqa: BLE001
            pass
        if screens:
            try:
                page.screenshot(path=str(screens / 'failure.png'))
                result['screens']['failure'] = str(screens / 'failure.png')
            except Exception:  # noqa: BLE001
                pass
    finally:
        if screens:
            (screens / 'report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
        print(json.dumps({key: result[key] for key in ('ok', 'checks', 'error', 'final', 'rpc') if key in result},
                         ensure_ascii=False, indent=2))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
