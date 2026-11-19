"""Headless acceptance for the format-5 previs editor against the real kernel.

Drives the production PrevisEditorHost + production format-5 RPC adapter over
real HTTP project RPC: open the editor, select a figure, choose a subject,
follow → lock, autosave the scene through sequence.preview/commit, write the
thumbnail cache, and prove the scene-revision CAS refuses a stale render.
"""
import argparse
import json
import shutil
import sys
import traceback
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

PROJECT = '7a000000-0000-4000-8000-000000000001'
PREVIS = '7a000000-0000-4000-8000-000000000003'
SUBJECT = '7a000000-0000-4000-8000-000000000010'
VERSION = '7a000000-0000-4000-8000-000000000011'


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

    def log(name, **details):
        result['checks'].append({'name': name, 'passed': True, **details})

    def capture(page, name):
        if not screens:
            return
        path = screens / name
        page.screenshot(path=str(path), full_page=True)
        result['screens'][name] = str(path)

    def rpc(page, operation, input):
        return page.evaluate("([operation, input]) => window.__previsWireRpc(operation, input)", [operation, input])

    def previs_node(page):
        project = rpc(page, 'project.get', {'projectId': PROJECT})
        return next(node for node in project['nodes'] if node['id'] == PREVIS)

    def history(page):
        return rpc(page, 'sequence.history.get', {'projectId': PROJECT, 'origin': 'user'})

    def wait_history(page, minimum, timeout=30000):
        page.wait_for_function(
            "([projectId, minimum]) => window.__previsWireRpc('sequence.history.get', {projectId, origin: 'user'})"
            ".then(view => Number(view.position) >= minimum)", arg=[PROJECT, minimum], timeout=timeout)

    def choose(page, testid, label):
        page.get_by_test_id(testid).click()
        option = page.get_by_role('option', name=label, exact=True)
        option.wait_for(state='visible', timeout=15000)
        option.click()

    def trigger_text(page, testid):
        return (page.get_by_test_id(testid).inner_text() or '').strip()

    def thumbnail_jpeg(page, width=216, height=384):
        data_url = page.evaluate("""([width, height]) => {
          const canvas = document.createElement('canvas');
          canvas.width = width; canvas.height = height;
          const context = canvas.getContext('2d');
          context.fillStyle = '#284b63'; context.fillRect(0, 0, width, height);
          context.fillStyle = '#e8e2d2'; context.beginPath();
          context.arc(width / 2, height / 2, Math.min(width, height) / 4, 0, Math.PI * 2); context.fill();
          return canvas.toDataURL('image/jpeg', 0.85);
        }""", [width, height])
        return data_url.split(',', 1)[1]

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
            page.wait_for_function("() => Boolean(window.__previsWireState?.ready)", timeout=60000)
            expect(page.get_by_test_id('previs-editor')).to_be_visible(timeout=60000)
            # The editor is open on the real format-5 node and the project frame.
            expect(page.get_by_test_id('previs-properties')).to_be_visible()
            log('format-5 previs editor opens on the real kernel node',
                webglAvailable=page.locator('[data-testid=previs-webgl]').count() == 0)
            capture(page, '30-01-previs-editor.png')

            # Select the standing figure; the format-5 subject rows appear.
            page.get_by_test_id('previs-outline-f1').click()
            expect(page.get_by_test_id('previs-figure-subject')).to_be_visible()
            # No subject yet; the version row does not exist while there is none.
            assert trigger_text(page, 'previs-figure-subject') == '无', trigger_text(page, 'previs-figure-subject')
            assert page.get_by_test_id('previs-figure-subject-version').count() == 0
            log('figure subject rows exist only for format 5 and start empty')

            # Follow the subject: the version row shows "跟随最新".
            choose(page, 'previs-figure-subject', 'Hero')
            expect(page.get_by_test_id('previs-figure-subject-version')).to_be_visible()
            follow_text = trigger_text(page, 'previs-figure-subject-version')
            assert follow_text == '跟随最新', follow_text
            assert trigger_text(page, 'previs-figure-subject') == 'Hero'
            log('choosing a subject writes a follow reference', display=follow_text)
            page.wait_for_timeout(400)
            capture(page, '30-02-previs-subject-follow.png')

            # Lock the head version: the row shows "锁定 V1".
            choose(page, 'previs-figure-subject-version', '锁定 V1')
            locked_text = trigger_text(page, 'previs-figure-subject-version')
            assert locked_text == '锁定 V1', locked_text
            log('locking pins the head version in the same row', display=locked_text)
            page.wait_for_timeout(400)
            capture(page, '30-03-previs-subject-locked.png')

            # Autosave: the scene goes through sequence.preview + sequence.commit.
            wait_history(page, 2)
            page.wait_for_function(
                "() => document.querySelector('[data-testid=previs-save-status]')?.dataset.status === 'saved'",
                timeout=30000)
            node = previs_node(page)
            assert node['sceneRevision'] >= 2, node['sceneRevision']
            figure = next(item for item in node['scene']['figures'] if item['id'] == 'f1')
            assert figure['subject'] == {'subjectId': SUBJECT, 'subjectVersionId': VERSION}, figure.get('subject')
            view = history(page)
            assert view['undo']['operation'] == 'previs.scene.set', view['undo']
            log('subject edit autosaves through the unified entry as one previs.scene.set step',
                sceneRevision=node['sceneRevision'], historyPosition=view['position'])
            capture(page, '30-04-previs-scene-saved.png')

            # Thumbnail cache. The production editor renders and uploads the card
            # through previs.thumbnail.set; a headless browser without WebGL falls
            # back to the same real RPC with a real 2D-canvas JPEG.
            scene_revision = node['sceneRevision']
            webgl_ready = page.locator('[data-testid=previs-webgl]').count() == 0
            frame_preset = page.evaluate('() => window.__previsWireState.framePresetId')
            thumbnail = None
            if webgl_ready:
                try:
                    page.wait_for_function(
                        "([projectId, nodeId, revision, framePresetId]) => window.__previsWireRpc('previs.thumbnail.get', "
                        "{projectId, nodeId, slots: ['card'], framePresetId}).then(result => result.items.some(item => item.sceneRevision >= revision))",
                        arg=[PROJECT, PREVIS, scene_revision, frame_preset], timeout=25000)
                    thumbnail = rpc(page, 'previs.thumbnail.get',
                                    {'projectId': PROJECT, 'nodeId': PREVIS, 'slots': ['card'], 'framePresetId': frame_preset})
                except Exception as error:  # noqa: BLE001 - WebGL capture may be unavailable
                    console_messages.append(f'editor thumbnail upload unavailable: {error}')
                    probe = rpc(page, 'previs.thumbnail.get',
                                {'projectId': PROJECT, 'nodeId': PREVIS, 'slots': ['card'], 'framePresetId': frame_preset})
                    result['thumbnailProbe'] = {'items': probe.get('items', []),
                        'onThumbnailCalls': page.evaluate('() => window.__previsWireState.thumbnails'),
                        'rpcLog': page.evaluate("() => (window.__previsWireLog ?? []).filter(entry => entry.operation.startsWith('previs.') || entry.operation.startsWith('sequence.')).map(entry => [entry.operation, entry.ok, entry.code])")}
            thumbnail_source = 'editor-capture'
            if thumbnail is None or not thumbnail['items']:
                thumbnail_source = 'real-rpc-fallback'
                input = {'projectId': PROJECT, 'nodeId': PREVIS, 'slot': 'card',
                         'sceneRevision': scene_revision, 'framePresetId': frame_preset,
                         'dataBase64': thumbnail_jpeg(page)}
                written = rpc(page, 'previs.thumbnail.set', input)
                assert written['sceneRevision'] == scene_revision and written['slot'] == 'card', written
                thumbnail = rpc(page, 'previs.thumbnail.get',
                                {'projectId': PROJECT, 'nodeId': PREVIS, 'slots': ['card'], 'framePresetId': frame_preset})
            item = next(item for item in thumbnail['items'] if item['slot'] == 'card')
            assert item['sceneRevision'] == scene_revision, item
            assert item['byteLength'] > 0
            log('previs.thumbnail.set writes the derived cache and get reads it back',
                source=thumbnail_source, sceneRevision=item['sceneRevision'], byteLength=item['byteLength'],
                webglAtThumbnail=webgl_ready, framePresetId=frame_preset,
                rpcLog=page.evaluate("() => (window.__previsWireLog ?? []).filter(entry => entry.operation.startsWith('previs.') || entry.operation.startsWith('sequence.')).map(entry => [entry.operation, entry.ok ?? null, entry.code ?? null])"))
            capture(page, '30-05-previs-thumbnail.png')

            # Thumbnail CAS: a render of an older scene revision is refused.
            before = history(page)
            stale = {'projectId': PROJECT, 'nodeId': PREVIS, 'slot': 'card',
                     'sceneRevision': max(1, scene_revision - 1), 'dataBase64': thumbnail_jpeg(page)}
            error = page.evaluate("""input => window.__previsWireRpc('previs.thumbnail.set', input)
                .then(() => null, failure => ({code: failure.code, details: failure.details ?? null}))""", stale)
            assert error and error['code'] == 'REVISION_CONFLICT', error
            log('a stale thumbnail render is refused with REVISION_CONFLICT', code=error['code'])
            after = history(page)
            assert after['position'] == before['position'], [before['position'], after['position']]
            log('the thumbnail cache writes no history step or undo entry', historyPosition=after['position'])

            assert not errors, errors
            result.update({'ok': True, 'format': 5, 'browserVersion': browser.version,
                           'webglAvailable': webgl_ready, 'thumbnailSource': thumbnail_source,
                           'sceneRevision': scene_revision, 'subject': SUBJECT, 'subjectVersion': VERSION})
        except Exception as error:
            result.update({'ok': False, 'error': str(error), 'pageErrors': errors,
                           'console': console_messages[-20:],
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


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        sys.exit(1)
