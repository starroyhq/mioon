import base64, json, os, pathlib, time, urllib.request, uuid
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path('/private/tmp/mioon-redesign-2_80wkck')
META = json.loads((ROOT / 'preview.json').read_text())
URL = META['url']
TOKEN = (pathlib.Path(META['root']) / 'access-token').read_text().strip()
REPO = pathlib.Path('/Users/kouzen/.codex/worktrees/mioon-redesign/mioon')
OUT = ROOT / 'output/playwright/compact-visual'
OUT.mkdir(parents=True, exist_ok=True)
RESULT = {'url': URL, 'purpose': 'Actual UI screenshots and pointer interaction in a separate synthetic project; no application source changes.', 'checks': [], 'screenshots': {}, 'pageErrors': [], 'globalPreferenceWrites': [], 'projectPreferenceWrites': [], 'creativeMutations': []}

def rpc(operation, payload):
    request = urllib.request.Request(URL + '/api/rpc', data=json.dumps({'operation': operation, 'input': payload}).encode(), headers={'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(request, timeout=30) as response:
        value = json.load(response)
    if not value.get('ok'):
        raise AssertionError(operation + ': ' + str(value.get('error', {}).get('code')))
    return value['data']

def api_get(path):
    request = urllib.request.Request(URL + path, headers={'Authorization': 'Bearer ' + TOKEN})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)['data']

preferences_before = api_get('/api/ui-preferences')['preferences']
project = rpc('project.create', {'name': '紧凑布局视觉补验（独立合成项目）', 'timelinePresetId': 'portrait_1080'})
pid = project['id']
asset = rpc('asset.import', {'projectId': pid, 'name': '本地合成画面.mp4', 'mimeType': 'video/mp4', 'dataBase64': base64.b64encode((REPO / 'docs/verification/mioon-redesign/export-journey/accepted-export.mp4').read_bytes()).decode()})
shot = rpc('shot.create', {'requestId': str(uuid.uuid4()), 'projectId': pid, 'title': '布局与草稿保留检查', 'prompt': '本地合成项目，检查浮层和面板尺寸。', 'position': {'x': 80, 'y': 100}})
timeline = rpc('timeline.get', {'projectId': pid})
timeline = rpc('timeline.clip.add', {'projectId': pid, 'expectedRevision': timeline['revision'], 'requestId': str(uuid.uuid4()), 'trackId': timeline['tracks'][0]['id'], 'assetId': asset['id'], 'name': '独立合成片段', 'startFrame': 0, 'durationFrames': 120})
clip = timeline['clips'][0]
RESULT.update({'projectId': pid, 'assetId': asset['id'], 'clipId': clip['id'], 'setup': 'Public local RPC project.create/asset.import/shot.create/timeline.clip.add; existing synthetic 1080x1920/4s MP4; no supplier generation.'})

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless=True)
    RESULT['browserVersion'] = browser.version
    context = browser.new_context(locale='zh-CN', viewport={'width': 1440, 'height': 900}, device_scale_factor=1)
    context.add_init_script("localStorage.setItem('mioon.app-language.v1',JSON.stringify({version:1,preference:'zh-Hans'}))")
    page = context.new_page()
    page.on('pageerror', lambda error: RESULT['pageErrors'].append(str(error)))
    def observe(request):
        if request.method == 'PUT' and '/api/ui-preferences' in request.url:
            RESULT['globalPreferenceWrites'].append('PUT /api/ui-preferences')
        if request.method == 'PUT' and '/api/workspace-preferences/' in request.url:
            RESULT['projectPreferenceWrites'].append({'projectId': request.url.split('/api/workspace-preferences/')[-1], 'state': (request.post_data_json or {}).get('state')})
        if request.method == 'POST' and '/api/rpc' in request.url:
            operation = (request.post_data_json or {}).get('operation', '')
            if operation in {'generation.submit', 'job.retry', 'timeline.render', 'shot.update'} or operation.startswith(('timeline.clip.', 'timeline.track.')):
                RESULT['creativeMutations'].append(operation)
    page.on('request', observe)
    def capture(name):
        page.evaluate("async()=>{await Promise.all(document.getAnimations().filter(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))}")
        page.screenshot(path=str(OUT / (name + '.png')), animations='disabled')
        RESULT['screenshots'][name] = {'file': name + '.png', 'viewport': page.viewport_size, 'geometry': page.evaluate("""()=>Object.fromEntries(['workbench','dock-canvas','dock-assets','dock-inspector','dock-timeline','reopen-timeline','resize-timeline'].map(id=>{const e=document.querySelector('[data-testid="'+id+'"]'),r=e?.getBoundingClientRect();return[id,r?{x:r.x,y:r.y,width:r.width,height:r.height,visible:e.dataset.visible??null}:null]}))""")}
        print('CAPTURE ' + name, flush=True)
    def check(name, **details):
        RESULT['checks'].append({'check': name, **details})
    def hit(locator):
        locator.scroll_into_view_if_needed()
        return locator.evaluate('(e)=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}')
    def compact():
        expect(page.get_by_test_id('workbench')).to_have_attribute('data-compact', 'true')
        expect(page.get_by_test_id('workbench')).to_have_attribute('data-narrow', 'false')

    try:
        page.goto(URL + '/?project=' + pid)
        page.get_by_test_id('access-token').fill(TOKEN)
        page.get_by_test_id('login-submit').click()
        expect(page.get_by_test_id('workbench')).to_be_visible(timeout=20000)
        if os.environ.get('MIOON_OVERLAY_CSS_PREVIEW') == '1':
            page.add_style_tag(content='.shell-redesign .dock-assets.panel-overlay,.shell-redesign .dock-inspector.panel-overlay{grid-column:1/-1;grid-row:1/2}')
            RESULT['candidateOverlayStyleInjected'] = True
        page.wait_for_function("()=>getComputedStyle(document.documentElement).zoom==='1'")
        page.get_by_test_id('workspace-canvas').click()
        page.get_by_test_id('shot-node-' + shot['id']).locator('.node-header').click()
        prompt = page.get_by_test_id('shot-prompt')
        expect(prompt).to_be_visible()
        original_prompt = prompt.input_value()
        draft = original_prompt + '\n浮层和宽窄切换期间保留此草稿。'
        prompt.fill(draft)
        page.set_viewport_size({'width': 1050, 'height': 680})
        compact()
        for name in ['assets', 'inspector']:
            expect(page.get_by_test_id('reopen-' + name)).to_be_visible()
        capture('canvas-1050-dual-rails')
        page.get_by_test_id('reopen-inspector').click()
        expect(prompt).to_have_value(draft)
        page.get_by_test_id('pin-inspector').click()
        expect(page.get_by_test_id('dock-inspector')).to_have_attribute('data-visible', 'true')
        capture('canvas-1050-assets-collapsed-inspector-pinned')
        before_canvas = page.get_by_test_id('dock-canvas').bounding_box()
        page.get_by_test_id('reopen-assets').click()
        expect(page.get_by_test_id('dock-assets')).to_have_attribute('data-visible', 'true')
        expect(page.get_by_test_id('asset-card-' + asset['id'])).to_be_visible()
        overlay = page.get_by_test_id('dock-assets')
        assert 'panel-overlay' in overlay.get_attribute('class')
        after_canvas = page.get_by_test_id('dock-canvas').bounding_box()
        assert abs(before_canvas['width'] - after_canvas['width']) < 1
        overlay_box = overlay.bounding_box()
        assert overlay_box['x'] < before_canvas['x'] + before_canvas['width'] and overlay_box['x'] + overlay_box['width'] > before_canvas['x']
        capture('canvas-1050-assets-overlay')
        check('1050 material rail opens actual populated overlay over unchanged canvas; inspector draft preserved', overlay=overlay_box)
        page.get_by_test_id('reopen-assets').click()
        expect(overlay).to_have_attribute('data-visible', 'false')
        expect(prompt).to_have_value(draft)
        page.set_viewport_size({'width': 1440, 'height': 900})
        expect(prompt).to_have_value(draft)
        prompt.fill(original_prompt)
        page.get_by_test_id('workspace-editing').click()
        # The actual local shot-text controller can retain a dirty draft marker
        # after returning to the same string. Complete its visible guard rather
        # than bypassing the form/controller through page JavaScript.
        page.wait_for_timeout(250)
        confirmation = page.get_by_role('dialog')
        if confirmation.is_visible():
            confirmation.get_by_role('button', name='继续', exact=True).click()
        page.get_by_test_id('timeline-clip-' + clip['id']).click()
        expect(page.get_by_test_id('clip-inspector')).to_be_visible()
        source = page.get_by_test_id('source-preview-video')
        source.wait_for()
        source.evaluate("media=>new Promise(resolve=>{if(media.readyState>=2)resolve();else media.addEventListener('loadeddata',resolve,{once:true})})")
        capture('editing-1440-before-resize')
        page.set_viewport_size({'width': 1050, 'height': 680})
        compact()
        page.get_by_test_id('reopen-inspector').click()
        inspector_overlay = page.get_by_test_id('dock-inspector').bounding_box()
        region_width = page.locator('.inspector-region').bounding_box()['width']
        assert inspector_overlay['width'] > 300 and region_width > 300
        assert inspector_overlay['y'] + inspector_overlay['height'] <= page.get_by_test_id('dock-timeline').bounding_box()['y']
        assert hit(page.get_by_test_id('right-dock-tab-agent'))
        assert hit(page.get_by_test_id('pin-inspector'))
        page.locator('#clip-name').click()
        capture('editing-1050-properties-overlay')
        page.get_by_test_id('pin-inspector').click()
        expect(page.get_by_test_id('clip-inspector')).to_be_visible()
        page.get_by_test_id('reopen-assets').click()
        asset_overlay = page.get_by_test_id('dock-assets').bounding_box()
        assert asset_overlay['width'] > 250
        assert page.get_by_test_id('import-button').bounding_box()['width'] > 200
        assert asset_overlay['y'] + asset_overlay['height'] <= page.get_by_test_id('dock-timeline').bounding_box()['y']
        filters = page.get_by_test_id('asset-filters-open')
        assert hit(filters)
        filters.click()
        expect(page.locator('.asset-filter-popover')).to_be_visible()
        page.keyboard.press('Escape')
        capture('editing-1050-assets-overlay')
        page.get_by_test_id('reopen-assets').click()
        check('editing overlays retain actual content width, hit-testable controls and normal body/pin/filter clicks within preview row', inspector=inspector_overlay, inspectorRegionWidth=region_width, assets=asset_overlay)
        handle = page.get_by_test_id('resize-timeline')
        expect(handle).to_be_visible()
        old_height = float(handle.get_attribute('aria-valuenow'))
        box = handle.bounding_box()
        x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x, y + old_height - 160, steps=12)
        page.mouse.up()
        expect(handle).to_have_attribute('aria-valuenow', '160')
        page.wait_for_timeout(700)
        actual_height = page.get_by_test_id('dock-timeline').bounding_box()['height']
        assert abs(actual_height - 160) < 1
        page.get_by_test_id('timeline-clip-' + clip['id']).scroll_into_view_if_needed()
        capture('editing-1050-timeline-160-inspector-pinned')
        check('real pointer resize reaches 160 CSS px and keeps selected clip', initialHeight=old_height, finalHeight=actual_height)
        before_stage = page.locator('.preview-stage').bounding_box()['height']
        retained_clip = page.get_by_test_id('timeline-clip-' + clip['id']).element_handle()
        retained_scroll = page.get_by_test_id('timeline-scroll').evaluate('(e)=>({left:e.scrollLeft,top:e.scrollTop})')
        page.get_by_test_id('toggle-timeline').click()
        expect(page.get_by_test_id('reopen-timeline')).to_have_count(0)
        expect(page.get_by_test_id('dock-timeline')).to_have_attribute('data-visible', 'true')
        expect(page.get_by_test_id('toggle-timeline')).to_be_visible()
        body = page.locator('.timeline-panel > .timeline-body')
        assert body.evaluate('(e)=>e.inert && getComputedStyle(e).display==="none"')
        assert not handle.is_visible()
        bar_height = page.get_by_test_id('dock-timeline').bounding_box()['height']
        assert abs(bar_height - 40) < 1, bar_height
        page.get_by_test_id('timeline-playhead').fill('30')
        expect(page.get_by_test_id('timeline-playhead')).to_have_value('30')
        snapping = page.get_by_test_id('timeline-snapping')
        previous_snap = snapping.get_attribute('aria-pressed')
        snapping.click()
        expect(snapping).to_have_attribute('aria-pressed', 'false' if previous_snap=='true' else 'true')
        page.keyboard.press('Backspace')
        page.keyboard.press('Shift+Backspace')
        expect(page.locator('[role=dialog]:visible')).to_have_count(0)
        collapsed_stage = page.locator('.preview-stage').bounding_box()['height']
        assert collapsed_stage > before_stage + 90
        capture('editing-1050-timeline-collapsed')
        check('same timeline instance collapses to full toolbar; playhead/snap remain usable; hidden body is inert and deletion shortcuts do nothing', previewBefore=before_stage, previewCollapsed=collapsed_stage, collapsedBarHeight=bar_height)
        page.get_by_test_id('toggle-timeline').click()
        expect(page.get_by_test_id('dock-timeline')).to_have_attribute('data-visible', 'true')
        expect(handle).to_have_attribute('aria-valuenow', '160')
        expect(page.get_by_test_id('timeline-clip-' + clip['id'])).to_have_class(__import__('re').compile('selected'))
        assert page.get_by_test_id('timeline-clip-' + clip['id']).evaluate('(e,retained)=>e===retained', retained_clip)
        assert page.get_by_test_id('timeline-scroll').evaluate('(e)=>({left:e.scrollLeft,top:e.scrollTop})') == retained_scroll
        capture('editing-1050-timeline-restored-160')
        check('toolbar expansion restores 160 px and exact selected clip without creative mutation')
        page.get_by_test_id('toggle-inspector').click()
        expect(page.get_by_test_id('reopen-inspector')).to_be_visible()
        capture('editing-1050-timeline-160-dual-rails')
        check('1050 editing inspector collapses to rail with timeline still 160 px')
        page.set_viewport_size({'width': 1440, 'height': 900})
        expect(page.get_by_test_id('dock-inspector')).to_have_attribute('data-visible', 'true')
        expect(handle).to_have_attribute('aria-valuenow', '160')
        capture('editing-1440-timeline-restored-160')
        page.reload()
        expect(page.get_by_test_id('workbench')).to_be_visible()
        page.get_by_test_id('workspace-editing').click()
        expect(page.get_by_test_id('resize-timeline')).to_have_attribute('aria-valuenow', '160')
        check('1440 return and actual reload retain isolated project 160 px layout')
        persisted = api_get('/api/workspace-preferences/' + pid)
        RESULT['persistedProjectLayout'] = (persisted.get('state') or {}).get('layout')
        assert RESULT['persistedProjectLayout']['editing']['timelineHeight'] == 160
        assert api_get('/api/ui-preferences')['preferences'] == preferences_before
        assert not RESULT['globalPreferenceWrites']
        assert all(item['projectId'] == pid for item in RESULT['projectPreferenceWrites'])
        assert not RESULT['creativeMutations'], RESULT['creativeMutations']
        assert not RESULT['pageErrors'], RESULT['pageErrors']
        RESULT['passed'] = True
    except Exception as error:
        RESULT['passed'] = False
        RESULT['error'] = str(error)
        page.screenshot(path=str(OUT / 'failure.png'), animations='disabled')
        raise
    finally:
        (OUT / 'results.json').write_text(json.dumps(RESULT, ensure_ascii=False, indent=2) + '\n')
        browser.close()
print(json.dumps({'passed': RESULT['passed'], 'checks': len(RESULT['checks']), 'screenshots': len(RESULT['screenshots']), 'globalPreferenceWrites': len(RESULT['globalPreferenceWrites']), 'pageErrors': len(RESULT['pageErrors'])}, ensure_ascii=False))
