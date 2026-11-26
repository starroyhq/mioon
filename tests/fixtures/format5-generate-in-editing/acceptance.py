"""Headless acceptance for GE-b: blank-timeline generation entries and the 21-09 panel.

Run against a development server with a format-5 project (an AC build, or a
format-5 project file already registered in the data directory). Screenshots are
written only to --screens (never committed); the assertions are the gate.

    python3 tests/fixtures/format5-generate-in-editing/acceptance.py \
      --url http://127.0.0.1:4319 --token-file /path/to/data/access-token \
      --screens /private/tmp/geb-screens
"""
import argparse
import json
import shutil
import sys
import time
import traceback
import urllib.request
import uuid
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    parser.add_argument('--token')
    parser.add_argument('--token-file')
    parser.add_argument('--screens')
    parser.add_argument('--browser')
    options = parser.parse_args()
    token = options.token
    if not token and options.token_file:
        token = Path(options.token_file).read_text().strip()
    assert token, 'Pass --token or --token-file'
    base = options.url.rstrip('/')
    screens = Path(options.screens) if options.screens else None
    if screens:
        screens.mkdir(parents=True, exist_ok=True)
    executable = options.browser or shutil.which('chromium') or shutil.which('google-chrome')
    mac = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    if not executable and mac.exists():
        executable = str(mac)
    assert executable, 'A Chromium executable is required'
    result = {'checks': [], 'screens': {}}

    def log(name, **details):
        result['checks'].append({'name': name, 'passed': True, **details})
        print(f"ok - {name}", flush=True)

    def capture(page, name):
        if not screens:
            return
        page.screenshot(path=str(screens / name), full_page=True)
        result['screens'][name] = str(screens / name)

    def rpc(operation, params, project=None):
        url = f'{base}/api/projects/{project}/rpc' if project else f'{base}/api/rpc'
        request = urllib.request.Request(url, data=json.dumps({'operation': operation, 'input': params}).encode(),
            headers={'content-type': 'application/json', 'authorization': 'Bearer ' + token})
        with urllib.request.urlopen(request, timeout=120) as response:
            value = json.load(response)
        assert value.get('ok'), value
        return value['data']

    def menu_items(page):
        items = page.locator('[data-testid^="timeline-menu-"]')
        return [items.nth(index).get_attribute('data-testid') for index in range(items.count())]

    def dismiss_toast(page):
        # Board notices can queue while earlier actions settle; close every one
        # that arrives so the 21-08/21-09 evidence has no stale toast.
        for _ in range(10):
            toast = page.get_by_test_id('global-toast')
            if not toast.count():
                return
            toast.locator('button').last.click(force=True)
            page.wait_for_timeout(400)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=executable, headless=True, chromium_sandbox=True)
        context = browser.new_context(viewport={'width': 1600, 'height': 1000}, locale='zh-Hans')
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            projects = rpc('project.list', {})
            name = f"GE-b acceptance {len(projects) + 1}"
            project = rpc('project.create', {'name': name})['id']
            log('project created', projectId=project)
            projects = rpc('project.list', {})
            created = next(item for item in projects if item['id'] == project)
            format_version = rpc('project.get', {'projectId': project}, project).get('projectFormatVersion')
            assert format_version == 5, f'acceptance needs a format-5 project, got {format_version!r}'
            log('format-5 project available')
            # Seed the three shots through the same sequence preview/commit RPC
            # the board uses; this keeps the evidence free of transient board toasts.
            for index in range(3):
                node = str(uuid.uuid4())
                preview = rpc('sequence.preview', {'projectId': project, 'requestId': f'seed-{node}',
                    'intents': [{'side': 'board', 'operation': {'kind': 'board.shot.append', 'nodeId': node,
                        'name': f'镜头 {index + 1}'}}]}, project)
                assert rpc('sequence.commit', {'projectId': project, 'envelope': preview['envelope'],
                    'expectedPlanDigest': preview['planDigest']}, project)['status'] == 'applied'
            seeded = rpc('project.get', {'projectId': project}, project)
            assert len(seeded['shots']) == 3, len(seeded['shots'])
            page.goto(base + '/')
            page.locator('input[type="password"]').fill(token)
            page.get_by_role('button', name='进入 Mioon', exact=True).click()
            page.wait_for_timeout(1500)
            if page.get_by_test_id('project-home').count() == 0:
                page.get_by_test_id('project-home-page-projects').click(force=True)
                page.wait_for_timeout(1000)
            page.get_by_test_id('pf-card-open-' + project).click(force=True)
            page.wait_for_timeout(4000)
            expect(page.get_by_test_id('workbench')).to_be_visible(timeout=20000)
            log('format-5 project seeded with three shots')
            page.get_by_test_id('workspace-editing').click(force=True)
            page.wait_for_timeout(2500)
            page.wait_for_timeout(1200)
            dismiss_toast(page)
            log('editing timeline mounted')
            main_track = page.locator('.timeline-track[data-main-track="true"]')
            assert main_track.count() == 1
            main_id = main_track.get_attribute('data-testid').replace('timeline-track-', '')
            lane = page.get_by_test_id('track-lane-' + main_id)
            box = lane.bounding_box()
            assert box
            page.mouse.click(box['x'] + box['width'] - 40, box['y'] + box['height'] / 2, button='right')
            page.wait_for_timeout(800)
            items = menu_items(page)
            assert 'timeline-menu-generate' in items, items
            capture(page, '21-08-generate-entry-menu.png')
            log('main-track end offers 在末尾生成镜头', items=items)
            page.get_by_test_id('timeline-menu-generate').click(force=True)
            expect(page.get_by_test_id('editing-generate-panel')).to_be_visible(timeout=20000)
            dismiss_toast(page)
            assert page.locator('.timeline-clip.selected').count() == 1
            state = rpc('project.get', {'projectId': project}, project)
            new_clip = max(state['timeline']['clips'], key=lambda clip: clip['startFrame'] + clip['durationFrames'])
            assert new_clip['name'] != 'Clip' and new_clip['name'], new_clip.get('name')
            log('placeholder created, selected and named after the shot', clipName=new_clip['name'],
                durationFrames=new_clip['durationFrames'], sourceState=new_clip.get('sourceState'))
            # The panel must not claim a failure before the job reaches a terminal state.
            panel_text = page.get_by_test_id('editing-generate-panel').inner_text()
            clip_shot = new_clip.get('shotId') or (new_clip.get('sequenceSource') or {}).get('nodeId')
            job = next((item for item in state.get('jobs', []) if item.get('shotId') == clip_shot), None)
            if not job or job.get('status') not in ('failed', 'cancelled', 'submission_unknown'):
                assert '生成失败' not in panel_text, panel_text
            log('fresh placeholder does not show a failure without a failed job')
            capture(page, '21-09-new-shot-generate-panel.png')
            # Duration follows the panel: one resize intent, one history step. Do it
            # immediately: a mock job may finish within a few seconds.
            duration = page.get_by_test_id('editing-generate-duration')
            duration.click(force=True)
            page.wait_for_timeout(400)
            options = page.get_by_role('option')
            for index in range(options.count()):
                if options.nth(index).inner_text().strip().startswith('2'):
                    options.nth(index).click(force=True)
                    break
            page.wait_for_timeout(2000)
            state = rpc('project.get', {'projectId': project}, project)
            resized = next(clip for clip in state['timeline']['clips'] if clip['id'] == new_clip['id'])
            assert resized['durationFrames'] == 60, resized['durationFrames']
            history = rpc('sequence.history.get', {'projectId': project}, project)
            assert history['undo']['operation'] == 'timeline.generate.resize', history['undo']
            capture(page, '21-09-panel-duration-2s.png')
            log('duration 4->2 s resized the placeholder in one history step')
            # Other video tracks offer 在这里生成镜头 only inside a main-track shot; audio tracks never do.
            page.get_by_role('button', name='轨道', exact=True).click(force=True)
            page.wait_for_timeout(500)
            page.get_by_test_id('add-video-track').click(force=True)
            page.wait_for_timeout(1500)
            state = rpc('project.get', {'projectId': project}, project)
            overlay = next(track for track in state['timeline']['tracks']
                if track['kind'] == 'video' and track['id'] != main_id)
            overlay_lane = page.get_by_test_id('track-lane-' + overlay['id'])
            overlay_box = overlay_lane.bounding_box()
            page.mouse.click(overlay_box['x'] + 260, overlay_box['y'] + overlay_box['height'] / 2, button='right')
            page.wait_for_timeout(700)
            assert 'timeline-menu-generate' in menu_items(page)
            capture(page, '21-08-generate-entry-menu-overlay.png')
            page.keyboard.press('Escape')
            log('overlay track offers 在这里生成镜头 inside a main shot')
            page.get_by_role('button', name='轨道', exact=True).click(force=True)
            page.wait_for_timeout(500)
            page.get_by_test_id('add-audio-track').click(force=True)
            page.wait_for_timeout(1500)
            state = rpc('project.get', {'projectId': project}, project)
            audio = next(track for track in state['timeline']['tracks'] if track['kind'] == 'audio')
            audio_lane = page.get_by_test_id('track-lane-' + audio['id'])
            audio_box = audio_lane.bounding_box()
            page.mouse.click(audio_box['x'] + 260, audio_box['y'] + audio_box['height'] / 2, button='right')
            page.wait_for_timeout(700)
            assert 'timeline-menu-generate' not in menu_items(page)
            page.keyboard.press('Escape')
            log('audio track never offers a generation entry')
            # GE-b clip menu: a real right-click on a main-track shot places the
            # generated shot before/after it (packed position), one undo each.
            def clip_menu_generate(where):
                state = rpc('project.get', {'projectId': project}, project)
                main = state['timeline']['mainTrack']['trackId']
                target = next(clip for clip in state['timeline']['clips']
                    if clip['trackId'] == main and (clip.get('sequenceSource') or {}).get('kind') == 'shot')
                dismiss_toast(page)
                page.get_by_test_id('timeline-clip-' + target['id']).click(button='right', force=True)
                page.wait_for_timeout(500)
                expect(page.get_by_test_id('clip-context-menu')).to_be_visible(timeout=10000)
                assert page.get_by_test_id('clip-menu-generate-before').count() == 1
                assert page.get_by_test_id('clip-menu-generate-after').count() == 1
                capture(page, f'21-08-clip-generate-{where}-menu.png')
                page.get_by_test_id('clip-menu-generate-' + where).click(force=True)
                page.wait_for_timeout(300)
                history = rpc('sequence.history.get', {'projectId': project}, project)
                assert history['undo']['operation'] == 'timeline.generate.placeholder', history['undo']
                after = rpc('project.get', {'projectId': project}, project)
                clips = [clip for clip in after['timeline']['clips'] if clip['trackId'] == after['timeline']['mainTrack']['trackId']]
                generated = next(clip for clip in clips if clip['id'] not in {item['id'] for item in state['timeline']['clips']})
                if where == 'before':
                    assert generated['startFrame'] == target['startFrame'], (generated, target)
                else:
                    end = target['startFrame'] + target['durationFrames']
                    assert generated['startFrame'] == end, (generated, target, end)
                rpc('sequence.undo', {'projectId': project, 'requestId': f'undo-clip-{uuid.uuid4()}',
                    'actionId': history['undo']['actionId'],
                    'expected': {'position': history['position'], 'revision': history['revision']}}, project)
                restored = rpc('project.get', {'projectId': project}, project)
                assert all(clip['id'] != generated['id'] for clip in restored['timeline']['clips'])
                return target['id']
            clip_menu_generate('before')
            log('clip menu 在前面生成镜头 places before the shot and undoes in one step')
            clip_menu_generate('after')
            log('clip menu 在后面生成镜头 places after the shot and undoes in one step')
            # Q-13: every entry only places; the panel's Generate starts the task.
            dismiss_toast(page)
            page.eval_on_selector('[data-testid="timeline-scroll"]',
                'el => { el.scrollLeft = el.scrollWidth; el.dispatchEvent(new Event("scroll", {bubbles: true})); }')
            page.wait_for_timeout(900)
            state = rpc('project.get', {'projectId': project}, project)
            main = state['timeline']['mainTrack']['trackId']
            main_clips = sorted([clip for clip in state['timeline']['clips'] if clip['trackId'] == main],
                key=lambda clip: clip['startFrame'])
            last_box = page.get_by_test_id('timeline-clip-' + main_clips[-1]['id']).bounding_box()
            assert last_box
            page.mouse.click(min(1580, last_box['x'] + last_box['width'] + 30),
                last_box['y'] + last_box['height'] / 2, button='right')
            page.wait_for_timeout(700)
            assert 'timeline-menu-generate' in menu_items(page)
            page.get_by_test_id('timeline-menu-generate').click(force=True)
            page.wait_for_timeout(2500)
            state = rpc('project.get', {'projectId': project}, project)
            placed_shot = next(shot for shot in state['shots'] if shot['title'] == '新镜头')
            assert not [job for job in state.get('jobs', []) if job['shotId'] == placed_shot['id']], \
                'placing the placeholder must not start generation'
            expect(page.get_by_test_id('editing-generate-panel')).to_be_visible(timeout=20000)
            page.get_by_test_id('editing-generate-prompt').fill('Q-13 面板里再生成')
            page.get_by_test_id('editing-generate-save').click(force=True)
            page.wait_for_timeout(1500)
            if page.get_by_test_id('editing-generate-submit').is_disabled():
                page.get_by_test_id('editing-generate-service').click(force=True)
                page.wait_for_timeout(500)
                item = page.locator('[data-testid^="editing-generate-service-"]').first
                assert item.count(), 'the panel offers the board service picker'
                item.click(force=True)
                page.wait_for_timeout(1500)
            page.get_by_test_id('editing-generate-submit').click(force=True)
            deadline = time.time() + 60
            job = None
            while time.time() < deadline:
                state = rpc('project.get', {'projectId': project}, project)
                job = next((item for item in state.get('jobs', []) if item['shotId'] == placed_shot['id']), None)
                if job:
                    break
                page.wait_for_timeout(500)
            assert job, 'the panel Generate button must start the task'
            log('Q-13 placement has no task; panel Generate starts it', jobStatus=job['status'])
            # WT-1-18: a long packed project must keep the main end entry on the
            # main track after an overlay right-click and horizontal scrolling.
            long_name = 'GE-b acceptance long ' + str(uuid.uuid4())[:8]
            long = rpc('project.create', {'name': long_name})['id']
            for index in range(40):
                node = str(uuid.uuid4())
                seed = rpc('sequence.preview', {'projectId': long, 'requestId': f'seed-long-{node}',
                    'intents': [{'side': 'board', 'operation': {'kind': 'board.shot.append', 'nodeId': node,
                        'name': f'长镜头 {index + 1}'}}]}, long)
                rpc('sequence.commit', {'projectId': long, 'envelope': seed['envelope'],
                    'expectedPlanDigest': seed['planDigest']}, long)
            page.get_by_role('link', name='Mioon').click(force=True)
            page.wait_for_timeout(2500)
            if page.get_by_test_id('project-home').count() == 0:
                page.get_by_test_id('project-home-page-projects').click(force=True)
                page.wait_for_timeout(1000)
            page.get_by_test_id('pf-card-open-' + long).click(force=True)
            page.wait_for_timeout(4500)
            page.get_by_test_id('workspace-editing').click(force=True)
            page.wait_for_timeout(2500)
            dismiss_toast(page)
            long_state = rpc('project.get', {'projectId': long}, long)
            long_main = long_state['timeline']['mainTrack']['trackId']
            assert len([clip for clip in long_state['timeline']['clips'] if clip['trackId'] == long_main]) == 40
            # Add the overlay track and generate one overlay placeholder first.
            page.get_by_role('button', name='轨道', exact=True).click(force=True)
            page.wait_for_timeout(500)
            page.get_by_test_id('add-video-track').click(force=True)
            page.wait_for_timeout(1500)
            long_state = rpc('project.get', {'projectId': long}, long)
            overlay = next(track for track in long_state['timeline']['tracks']
                if track['kind'] == 'video' and track['id'] != long_main)
            overlay_lane = page.get_by_test_id('track-lane-' + overlay['id'])
            overlay_box = overlay_lane.bounding_box()
            assert overlay_box
            page.mouse.click(overlay_box['x'] + 500, overlay_box['y'] + overlay_box['height'] / 2, button='right')
            page.wait_for_timeout(700)
            assert 'timeline-menu-generate' in menu_items(page)
            page.keyboard.press('Escape')
            page.wait_for_timeout(300)
            # Scroll to the horizon and right-click the main end: target stays main.
            page.eval_on_selector('[data-testid="timeline-scroll"]',
                'el => { el.scrollLeft = el.scrollWidth; el.dispatchEvent(new Event("scroll", {bubbles: true})); }')
            page.wait_for_timeout(1000)
            long_state = rpc('project.get', {'projectId': long}, long)
            main_clips = sorted([clip for clip in long_state['timeline']['clips'] if clip['trackId'] == long_main],
                key=lambda clip: clip['startFrame'])
            last_clip = page.get_by_test_id('timeline-clip-' + main_clips[-1]['id']).bounding_box()
            assert last_clip
            page.mouse.click(min(1580, last_clip['x'] + last_clip['width'] + 30),
                last_clip['y'] + last_clip['height'] / 2, button='right')
            page.wait_for_timeout(800)
            assert 'timeline-menu-generate' in menu_items(page)
            end_item_text = page.get_by_test_id('timeline-menu-generate').inner_text()
            assert '在末尾生成镜头' in end_item_text, end_item_text
            capture(page, '21-08-long-main-end-menu.png')
            page.get_by_test_id('timeline-menu-generate').click(force=True)
            page.wait_for_timeout(3500)
            long_after = rpc('project.get', {'projectId': long}, long)
            long_main_after = [clip for clip in long_after['timeline']['clips'] if clip['trackId'] == long_main]
            generated_end = max(long_main_after, key=lambda clip: clip['startFrame'])
            assert generated_end['startFrame'] >= main_clips[-1]['startFrame'] + main_clips[-1]['durationFrames'], generated_end
            assert len(long_main_after) == 41, len(long_main_after)
            log('40-shot scrolled project keeps the main end entry on the main track',
                clips=len(long_main_after), startFrame=generated_end['startFrame'])
            assert not errors, errors
            result['projectId'] = project
            result['passed'] = True
            print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
            return 0
        except Exception as error:  # noqa: BLE001 - acceptance prints the failing step
            result['passed'] = False
            result['error'] = str(error)
            result['traceback'] = traceback.format_exc()
            print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
            return 1
        finally:
            browser.close()


if __name__ == '__main__':
    sys.exit(main())
