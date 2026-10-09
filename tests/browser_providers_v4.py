"""V4: real built renderer + isolated real backend, only synthetic local assets.
No credentials, live calls, intercepted metadata, or external browser requests.
Run after pnpm build: python3 tests/browser_providers_v4.py
"""
import json, os, pathlib, re, shutil, socket, sqlite3, subprocess, tempfile, time, traceback, urllib.parse, urllib.request
from playwright.sync_api import expect, sync_playwright
ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = pathlib.Path(os.environ.get('WB_PROVIDER_EVIDENCE', str(ROOT / 'evidence/v4-browser-provider')))
OUT.mkdir(parents=True, exist_ok=True)
TOKEN = 'v4-provider-ui-local-test-only'
PID = json.loads((ROOT / 'evidence/v2-demo/demo-project.json').read_text())['projectId']
steps = []; errors = []; blocked_network = []; generation_requests = []; cli_operations = []; active_page = None
def log(step, **details):
    steps.append({'step': step, **details}); print(step, flush=True)
def rpc(base, operation, params=None):
    req = urllib.request.Request(base + '/api/rpc', data=json.dumps({'operation': operation, 'input': params or {}}).encode(), headers={'content-type': 'application/json', 'authorization': 'Bearer ' + TOKEN})
    with urllib.request.urlopen(req, timeout=60) as response: result = json.load(response)
    assert result['ok'], result
    return result['data']
def cli(base, token_file, operation, params=None):
    # A real CLI subprocess shares the browser's isolated backend. The synthetic
    # token stays in a private file, never in process arguments or evidence.
    prefixes = ('WB_', 'VIDEO_WORKBENCH_', 'RUNWAY_', 'RUNWAYML_', 'ARK_', 'VEO_', 'GEMINI_', 'MINIMAX_', 'HAILUO_', 'VIDU_')
    env = {key: value for key, value in os.environ.items() if not key.startswith(prefixes)}
    env.update(WB_BASE_URL=base, WB_TOKEN_FILE=str(token_file), VIDEO_WORKBENCH_ENABLE_LIVE_PROVIDER='0')
    result = subprocess.run(['node', 'apps/cli/src/index.mjs', *operation.split('.'), '--input', '-'], input=json.dumps(params or {}), text=True, capture_output=True, timeout=60, cwd=ROOT, env=env)
    assert result.returncode == 0, (operation, result.stdout, result.stderr)
    assert len(result.stdout.strip().splitlines()) == 1
    envelope = json.loads(result.stdout)
    assert envelope['ok'] and 'data' in envelope, envelope
    assert TOKEN not in result.stdout and TOKEN not in result.stderr
    cli_operations.append({'operation': operation, 'exitCode': result.returncode, 'transport': 'cli'})
    return envelope['data']
def poll(fn, predicate, seconds=40):
    end = time.monotonic() + seconds; value = None
    while time.monotonic() < end:
        value = fn()
        if predicate(value): return value
        if active_page is not None: active_page.wait_for_timeout(150)
        else: time.sleep(.15)
    raise AssertionError('Timed out: ' + str(value)[:2000])
def copy_demo(target):
    source = ROOT / 'examples/multitrack-project'
    shutil.copytree(source, target, ignore=shutil.ignore_patterns('access-token', 'server.lock', '*.sqlite', '*.sqlite-wal', '*.sqlite-shm'))
    with sqlite3.connect(f'file:{source / "workbench.sqlite"}?mode=ro', uri=True) as src:
        with sqlite3.connect(target / 'workbench.sqlite') as dst: src.backup(dst)
def start(data):
    with socket.socket() as sock: sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    prefixes = ('RUNWAY_', 'RUNWAYML_', 'ARK_', 'VEO_', 'GEMINI_', 'MINIMAX_', 'HAILUO_', 'VIDU_')
    env = {key: value for key, value in os.environ.items() if not key.startswith(prefixes)}
    env.update(PORT=str(port), WB_TOKEN=TOKEN, WB_DATA_DIR=str(data), VIDEO_WORKBENCH_ENABLE_LIVE_PROVIDER='0')
    handle = open(OUT / 'server.log', 'w')
    proc = subprocess.Popen(['node', 'apps/server/src/cli.mjs'], cwd=ROOT, env=env, stdout=handle, stderr=subprocess.STDOUT)
    base = f'http://127.0.0.1:{port}'
    for _ in range(100):
        if proc.poll() is not None: raise RuntimeError('Backend exited before health; inspect server.log')
        try:
            with urllib.request.urlopen(base + '/health', timeout=1) as response:
                if response.status == 200: return proc, handle, base
        except Exception: time.sleep(.1)
    raise RuntimeError('Backend startup timed out')
def stop(proc, handle):
    proc.terminate()
    try: proc.wait(timeout=40)
    except subprocess.TimeoutExpired: proc.kill(); proc.wait()
    handle.close()
def login(page, base):
    page.goto(base + '/?project=' + PID); page.get_by_label('访问令牌', exact=True).fill(TOKEN)
    page.get_by_role('button', name='进入工作台', exact=True).click()
    expect(page.get_by_test_id('workbench')).to_be_visible(timeout=15000)
def dismiss(page):
    for name in ['关闭生成任务', '关闭提示']:
        button = page.get_by_role('button', name=name, exact=True)
        if button.is_visible(): button.click()
def choose(page, testid, label):
    page.get_by_test_id(testid).click(); page.get_by_role('option', name=label, exact=True).click()
    expect(page.get_by_role('option')).to_have_count(0)
def close_select(page):
    page.keyboard.press('Escape'); expect(page.get_by_role('option')).to_have_count(0)
def status_label(provider): return {'available': '可用', 'disabled': '未启用', 'not_configured': '配置未完成'}[provider['status']]
def choose_provider(page, provider):
    label = (provider.get('name') or provider['id']) + ' · ' + status_label(provider) + (' · 本地模拟' if provider.get('mock') else '')
    choose(page, 'provider-select', label)
    expect(page.get_by_test_id('provider-status')).to_have_attribute('data-status', provider['status'])
def capture(page, name, focus=None):
    if focus: page.get_by_test_id(focus).scroll_into_view_if_needed()
    page.screenshot(path=str(OUT / name), full_page=True)
def test_browser():
    global active_page
    data = pathlib.Path(tempfile.mkdtemp(prefix='workbench-v4-ui-')) / 'project'; copy_demo(data)
    token_file = data.parent / 'cli-token'
    descriptor = os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as handle: handle.write(TOKEN)
    proc, handle, base = start(data)
    try:
        caps = rpc(base, 'provider.list')
        required = set(os.environ.get('WB_REQUIRED_PROVIDER_IDS', 'mock,runway,ark,veo,minimax,vidu').split(','))
        assert required <= {p['id'] for p in caps}, [p['id'] for p in caps]
        assert all(p['status'] == 'not_configured' and not p['configured'] and not p['enabled'] for p in caps if not p['mock'])
        (OUT / 'capabilities.json').write_text(json.dumps(caps, ensure_ascii=False, indent=2))
        state = lambda: rpc(base, 'project.get', {'projectId': PID})
        baseline = state(); timeline = baseline['timeline']
        assert len(timeline['tracks']) == 3 and len(timeline['clips']) == 5
        prompt = '原创几何图形在清晨柔光中缓慢旋转。仅验证本地软件流程。'
        shot = cli(base, token_file, 'shot.create', {'projectId': PID, 'title': 'V4 · 生成服务商验证', 'prompt': prompt, 'duration': 2, 'aspectRatio': '9:16', 'position': {'x': 860, 'y': 420}})
        sid = shot['id']; expected_revision = shot['revision']
        assert next(s for s in state()['shots'] if s['id'] == sid) == shot
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=shutil.which('chromium'), headless=True, chromium_sandbox=True)
            context = browser.new_context(viewport={'width': 1680, 'height': 1120}, accept_downloads=True)
            page = context.new_page(); active_page = page; page.on('pageerror', lambda error: errors.append(str(error)))
            def network_guard(route):
                parsed = urllib.parse.urlparse(route.request.url)
                if parsed.hostname != '127.0.0.1': blocked_network.append(route.request.url); route.abort('blockedbyclient'); return
                if parsed.path == '/api/rpc' and route.request.method == 'POST':
                    payload = route.request.post_data_json
                    if payload.get('operation') == 'generation.submit':
                        generation_requests.append(payload['input'])
                        if payload['input'].get('providerId') != 'mock': route.abort('blockedbyclient'); return
                route.continue_()
            context.route('**/*', network_guard)
            login(page, base)
            page.get_by_test_id('storyboard-shot-' + sid).locator('.storyboard-preview').click()
            expect(page.get_by_test_id('shot-inspector')).to_be_visible()
            expect(page.get_by_test_id('shot-title')).to_have_value(shot['title'])
            expect(page.get_by_test_id('shot-prompt')).to_have_value(prompt)
            expect(page.get_by_test_id('shot-node-' + sid)).to_be_visible()
            page.get_by_test_id('provider-select').click(); expect(page.get_by_role('option')).to_have_count(len(caps))
            assert not any('sora' in name.lower() for name in page.get_by_role('option').all_text_contents())
            capture(page, '01-provider-options.png'); close_select(page)
            log('V4-UI-1: CLI-created shot appears in the real browser with all provider choices', providers=[p['id'] for p in caps], transport='cli', projectId=PID, shotId=sid)
            # No intercepted metadata; every real model is inspectable without keys.
            for provider in [p for p in caps if not p['mock']]:
                choose_provider(page, provider)
                for model in provider['modelCapabilities']:
                    choose(page, 'model-select', model.get('name') or model['id'])
                    expect(page.get_by_test_id('shot-prompt')).to_have_value(prompt)
                    expect(page.get_by_test_id('generate-shot')).to_be_disabled()
                    expect(page.get_by_test_id('model-capabilities')).to_contain_text(' / '.join(str(d) for d in model['durations']) + ' 秒')
                    page.get_by_test_id('shot-duration').click(); expect(page.get_by_role('option')).to_have_count(len(set(model['durations'] + [2]))); labels = page.get_by_role('option').all_text_contents()
                    for duration in model['durations']: assert f'{duration} 秒' in labels, (model, labels)
                    if 2 not in model['durations']: assert '2 秒 · 不支持' in labels
                    close_select(page); page.get_by_test_id('shot-ratio').click(); expect(page.get_by_role('option')).to_have_count(len(set(model['aspectRatios'] + ['9:16']))); labels = page.get_by_role('option').all_text_contents()
                    for ratio in model['aspectRatios']: assert ratio in labels
                    close_select(page)
                for variable in provider['configuration']['missing']: expect(page.get_by_test_id('provider-missing')).to_contain_text(variable)
                assert page.locator('input[type=password]').count() == 0
                details = page.get_by_test_id('provider-details-toggle')
                expect(details).to_have_attribute('aria-expanded', 'false')
                expect(page.get_by_test_id('provider-details-content')).not_to_be_visible()
                expect(page.get_by_test_id('provider-readiness-summary')).to_contain_text(f'还需配置 {len(set(provider["configuration"]["missing"]))} 项')
                expect(page.locator('.provider-security')).to_contain_text('API 密钥仅在服务器配置')
                # The compact default keeps provider, selected model and model limits
                # in the inspector together instead of displacing them with setup prose.
                capture(page, f'02-{provider["id"]}-safe-setup.png', 'provider-settings')
                for field in ['provider-select', 'model-select', 'model-capabilities', 'provider-status']:
                    expect(page.get_by_test_id(field)).to_be_in_viewport(ratio=1)
                closed_height = page.get_by_test_id('provider-status').bounding_box()['height']
                assert closed_height < 280, (provider['id'], closed_height)
                details.focus(); page.keyboard.press('Enter')
                expect(details).to_have_attribute('aria-expanded', 'true')
                expect(page.get_by_test_id('provider-details-content')).to_be_visible()
                requirements = page.get_by_test_id('provider-requirements').locator('li').all_text_contents()
                assert requirements == list(dict.fromkeys(r.strip() for r in provider['configuration']['requirements'] if r.strip()))
                if provider['id'] == 'minimax': capture(page, '02-minimax-configuration-expanded.png', 'provider-details-content')
                details.focus(); page.keyboard.press('Space')
                expect(details).to_have_attribute('aria-expanded', 'false')
                expect(page.get_by_test_id('provider-details-content')).not_to_be_visible()
                expect(page.get_by_test_id('shot-prompt')).to_have_value(prompt)
                expect(page.get_by_test_id('generate-shot')).to_be_disabled()
            saved = next(s for s in state()['shots'] if s['id'] == sid)
            assert saved['revision'] == expected_revision and saved['duration'] == 2 and saved['parameters'] == {}
            log('V4-UI-2: model limits, compact setup, keyboard disclosure and blocked live generation verified')
            dual_provider = next(p for p in caps if not p['mock'] and any(set(m['inputModes']) >= {'text', 'image'} for m in p['modelCapabilities']))
            dual_model = next(m for m in dual_provider['modelCapabilities'] if set(m['inputModes']) >= {'text', 'image'})
            choose_provider(page, dual_provider); choose(page, 'model-select', dual_model.get('name') or dual_model['id'])
            choose(page, 'shot-duration', f'{dual_model["durations"][0]} 秒'); choose(page, 'shot-ratio', dual_model['aspectRatios'][0])
            expect(page.get_by_test_id('input-mode-select')).to_contain_text('文生视频'); expect(page.get_by_test_id('text-mode-hint')).to_be_visible()
            choose(page, 'input-mode-select', '图生视频'); expect(page.get_by_test_id('generation-issue')).to_contain_text('选择一张首帧参考图')
            image = next(a for a in baseline['assets'] if a['mimeType'].startswith('image/'))
            image_button = page.get_by_role('button', name='参考图 ' + image['name'], exact=True)
            image_button.click(); expect(image_button).to_have_attribute('aria-pressed', 'true')
            choose(page, 'input-mode-select', '文生视频'); expect(page.get_by_role('dialog', name='请确认此操作')).to_be_visible()
            page.get_by_role('button', name='取消', exact=True).click(); expect(image_button).to_have_attribute('aria-pressed', 'true')
            expect(page.get_by_test_id('input-mode-select')).to_contain_text('图生视频')
            choose(page, 'input-mode-select', '文生视频'); page.get_by_test_id('confirm-action').click()
            expect(page.get_by_test_id('text-mode-hint')).to_be_visible(); expect(page.get_by_test_id('shot-prompt')).to_have_value(prompt)
            capture(page, '03-text-image-mode.png', 'input-mode-select')
            log('V4-UI-3: image/text switching and cancel/confirm preserve prompt and image intent')
            page.get_by_test_id('save-shot').click(); expect(page.get_by_test_id('save-shot')).to_have_count(0)
            before = len(generation_requests)
            page.get_by_role('button', name='生成 V4 · 生成服务商验证', exact=True).click()
            expect(page.get_by_role('alert')).to_contain_text(status_label(dual_provider)); assert len(generation_requests) == before
            dismiss(page); log('V4-UI-4: canvas uses inspector provider and cannot bypass preflight')
            # Two real local mock generations; Chromium decodes the actual MP4.
            mock = next(p for p in caps if p['mock']); choose_provider(page, mock)
            choose(page, 'shot-duration', '2 秒'); choose(page, 'shot-ratio', '9:16')
            expect(page.get_by_test_id('input-mode-select')).to_contain_text('文生视频'); expect(page.get_by_test_id('generate-shot')).to_be_enabled()
            page.get_by_test_id('generate-shot').click()
            generated = poll(state, lambda value: len([v for v in value['versions'] if v['shotId'] == sid]) == 1, seconds=90)
            expect(page.get_by_role('button', name='关闭生成任务')).to_be_visible(timeout=15000); dismiss(page)
            first = next(v for v in generated['versions'] if v['shotId'] == sid)
            assert first['snapshot']['referenceAssetIds'] == [] and first['isMock']
            video = page.get_by_test_id('shot-node-' + sid).locator('video'); expect(video).to_be_visible(timeout=15000)
            video.evaluate('(v) => { v.muted = true; return v.play(); }')
            playback = poll(lambda: video.evaluate('(v) => ({time: v.currentTime, width: v.videoWidth, height: v.videoHeight, error: v.error && v.error.code})'), lambda value: value['time'] > .15 and value['width'] > 0)
            assert not playback['error']; video.evaluate('(v) => v.pause()')
            choose(page, 'input-mode-select', '图生视频'); expect(page.get_by_test_id('generate-shot')).to_be_disabled()
            image_button.click(); page.get_by_test_id('generate-shot').click()
            generated = poll(state, lambda value: len([v for v in value['versions'] if v['shotId'] == sid]) == 2, seconds=90)
            expect(page.get_by_role('button', name='关闭生成任务')).to_be_visible(timeout=15000); dismiss(page)
            versions = sorted([v for v in generated['versions'] if v['shotId'] == sid], key=lambda version: version['number'])
            assert versions[0] == first and versions[1]['snapshot']['referenceAssetIds'] == [image['id']]
            assert len(generation_requests) == 2 and all(r['providerId'] == 'mock' for r in generation_requests)
            capture(page, '04-local-mock-versions.png', 'provider-select'); log('V4-UI-5: text and image mock each produce an immutable MP4', playback=playback)
            page.reload(); expect(page.get_by_test_id('workbench')).to_be_visible()
            page.get_by_test_id('storyboard-shot-' + sid).locator('.storyboard-preview').click(); page.get_by_role('tab', name='版本历史').click()
            expect(page.locator('.version-card')).to_have_count(2); capture(page, '05-persisted-versions-and-timeline.png')
            persisted = state(); assert persisted['timeline'] == timeline
            assert sorted([v for v in persisted['versions'] if v['shotId'] == sid], key=lambda version: version['number']) == versions
            cli_state = cli(base, token_file, 'project.get', {'projectId': PID})
            assert cli_state['project']['id'] == PID
            assert sorted([v for v in cli_state['versions'] if v['shotId'] == sid], key=lambda version: version['number']) == versions
            assert cli_state['timeline'] == timeline
            page.get_by_test_id('workspace-preview').click(); page.get_by_test_id('preview-timeline-mode').click()
            composite = page.get_by_test_id('timeline-preview-video'); expect(composite).to_be_visible()
            composite.evaluate('(v) => { v.muted = true; return v.play(); }')
            decoded = poll(lambda: composite.evaluate('(v) => ({time: v.currentTime, width: v.videoWidth, error: v.error && v.error.code})'), lambda value: value['time'] > .15 and value['width'] == 720)
            assert not decoded['error']; composite.evaluate('(v) => v.pause()'); capture(page, '06-existing-multitrack-playback.png')
            log('V4-UI-6: browser reload and CLI readback preserve versions; unchanged multitrack edit plays', timelineId=timeline['id'], timelineRevision=timeline['revision'], transport='cli')
            assert not errors, errors; assert not blocked_network, blocked_network
            (OUT / 'project-state.json').write_text(json.dumps(persisted, ensure_ascii=False, indent=2))
            context.close(); browser.close()
        return {'status': 'PASS', 'steps': steps, 'pageErrors': errors, 'blockedNetwork': blocked_network, 'generationRequests': generation_requests, 'cliOperations': cli_operations, 'noRealProviderCalls': True}
    finally: stop(proc, handle)
if __name__ == '__main__':
    try: result = test_browser()
    except Exception as error:
        (OUT / 'result.json').write_text(json.dumps({'status': 'FAIL', 'steps': steps, 'error': str(error), 'traceback': traceback.format_exc(), 'pageErrors': errors, 'blockedNetwork': blocked_network, 'generationRequests': generation_requests}, ensure_ascii=False, indent=2)); raise
    (OUT / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps({'status': result['status'], 'steps': len(steps), 'evidence': str(OUT)}, ensure_ascii=False))
