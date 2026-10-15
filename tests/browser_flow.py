"""Actual Chromium user-flow and MCP-result visual evidence; no UI state mocks."""
import json, os, pathlib, shutil, socket, subprocess, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright, expect
from browser_workbench_actions import workbench_action
ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=pathlib.Path(os.environ.get('MIOON_BROWSER_EVIDENCE',str(ROOT/'evidence'/'browser')));OUT.mkdir(parents=True,exist_ok=True)
TOKEN='browser-local-test-token-2026-only'
steps=[];errors=[]
def log(name,**details):
    steps.append({'step':name,'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),**details});print(name,flush=True)
def start(data):
    sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
    handle=open(OUT/('server-'+str(port)+'.log'),'w')
    proc=subprocess.Popen(['node','server/index.mjs'],cwd=ROOT,env={**os.environ,'PORT':str(port),'MIOON_TOKEN':TOKEN,'MIOON_DATA_DIR':str(data),'MIOON_ENABLE_LIVE_PROVIDER':'0','RUNWAYML_API_SECRET':'','RUNWAY_MAX_GENERATIONS':'0'},stdout=handle,stderr=subprocess.STDOUT)
    base=f'http://127.0.0.1:{port}'
    for _ in range(100):
        if proc.poll() is not None: raise RuntimeError('Backend exited; inspect server log')
        try:
            with urllib.request.urlopen(base+'/health',timeout=1) as r:
                if r.status==200:return proc,handle,base
        except Exception:time.sleep(.1)
    raise RuntimeError('Backend startup timeout')
def stop(proc,handle):
    proc.terminate()
    try:proc.wait(timeout=30)
    except subprocess.TimeoutExpired:proc.kill();proc.wait()
    handle.close()
def rpc(base,op,params):
    req=urllib.request.Request(base+'/api/rpc',data=json.dumps({'operation':op,'input':params}).encode(),headers={'content-type':'application/json','authorization':'Bearer '+TOKEN})
    with urllib.request.urlopen(req,timeout=60) as r:value=json.load(r)
    assert value['ok'],value
    return value['data']
def poll(fn,predicate,seconds=60):
    end=time.time()+seconds
    while time.time()<end:
        value=fn()
        if predicate(value):return value
        time.sleep(.3)
    raise AssertionError('Timed out waiting for '+str(value)[:300])
def login(page,base,project=None):
    page.goto(base+('/?project='+project if project else '/'))
    page.get_by_label('访问令牌',exact=True).fill(TOKEN)
    page.get_by_role('button',name='进入工作台',exact=True).click()
    expect(page.get_by_test_id('workbench')).to_be_visible(timeout=15000)
def screenshot(page,name):page.screenshot(path=str(OUT/name),full_page=True)
def select_shot(page,shot):
    page.get_by_test_id('workspace-canvas').click()
    if page.get_by_role('button',name='展开分镜',exact=True).is_visible():page.get_by_role('button',name='展开分镜',exact=True).click()
    close=page.get_by_role('button',name='关闭生成任务')
    if close.is_visible():close.click()
    page.get_by_test_id('storyboard-shot-'+shot['id']).locator('.storyboard-preview').click();expect(page.get_by_test_id('shot-title')).to_have_value(shot['title'])
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=shutil.which('chromium'),headless=True,chromium_sandbox=True)
    data=pathlib.Path(tempfile.mkdtemp(prefix='mioon-browser-'))
    proc,handle,base=start(data)
    try:
        context=browser.new_context(viewport={'width':1600,'height':1000},accept_downloads=True)
        page=context.new_page();page.on('pageerror',lambda error:errors.append(str(error)))
        login(page,base);log('A1: backend and actual Chromium login reachable',base=base)
        screenshot(page,'A1-empty-workbench.png')
        page.get_by_test_id('empty-create-project').click()
        page.get_by_test_id('project-name').fill('浏览器验收 · 星星故事')
        page.get_by_test_id('create-project-submit').click()
        expect(page.get_by_test_id('project-switcher')).to_contain_text('浏览器验收')
        project=rpc(base,'project.list',{})[0];pid=project['id']
        page.get_by_test_id('asset-upload').set_input_files(str(ROOT/'examples/synthetic/reference.png'))
        state=poll(lambda:rpc(base,'project.get',{'projectId':pid}),lambda v:len(v['assets'])==1)
        page.get_by_test_id('create-three-shots').click()
        state=poll(lambda:rpc(base,'project.get',{'projectId':pid}),lambda v:len(v['shots'])==3)
        shots=state['shots'];log('A10: UI imported PNG and created three persistent shots',projectId=pid,shotIds=[s['id'] for s in shots])
        for i,shot in enumerate(shots):
            select_shot(page,shot)
            page.get_by_test_id('shot-prompt').fill(f'合成故事镜头 {i+1}：小狗追星、举杯、产品定格。软件验收测试。')
            page.get_by_test_id('save-shot').click()
            expect(page.get_by_test_id('save-shot')).to_have_count(0)
            page.get_by_test_id('generate-shot').click()
            poll(lambda:rpc(base,'project.get',{'projectId':pid}),lambda v:any(j['shotId']==shot['id'] and j['status']=='succeeded' for j in v['jobs']))
            expect(page.locator('[data-testid="shot-node-'+shot['id']+'"] .version-tag')).to_contain_text('V1',timeout=15000)
        state=rpc(base,'project.get',{'projectId':pid});shots=state['shots'];log('A10: three UI mock generations succeeded with managed MP4s')
        # Actual browser video decoding/playback, rather than src-only inspection.
        video=page.locator('[data-testid="shot-node-'+shots[0]['id']+'"] video')
        video.evaluate('(v)=>{v.muted=true;return v.play()}');page.wait_for_timeout(600)
        playback=video.evaluate('(v)=>({time:v.currentTime,width:v.videoWidth,height:v.videoHeight,error:v.error&&v.error.code})')
        assert playback['time']>0 and playback['width']>0 and not playback['error'],playback
        log('A10: browser decoded and played generated media',playback=playback)
        # Duplicate user clicks should not enqueue a second task for the same action.
        first=shots[0];select_shot(page,first)
        before=len(state['jobs']);lost_responses=[]
        def lose_generation_response(route):
            payload=route.request.post_data_json
            if payload and payload.get('operation')=='generation.submit' and not lost_responses:
                lost_responses.append(payload['input']['requestId']);route.fetch();route.abort('failed')
            else:route.continue_()
        page.route('**/api/rpc',lose_generation_response)
        page.get_by_test_id('generate-shot').dblclick(delay=5)
        state=poll(lambda:rpc(base,'project.get',{'projectId':pid}),lambda v:len([x for x in v['versions'] if x['shotId']==first['id']])==2)
        assert len(state['jobs'])==before+1 and len(lost_responses)==1
        page.unroute('**/api/rpc',lose_generation_response)
        log('A10: response lost after server acceptance plus double-click generated exactly one new immutable version',requestId=lost_responses[0])
        if page.get_by_role('button',name='关闭生成任务').is_visible():page.get_by_role('button',name='关闭生成任务').click()
        if page.get_by_role('button',name='关闭提示').is_visible():page.get_by_role('button',name='关闭提示').click()
        page.get_by_role('tab',name='版本历史').click()
        page.get_by_role('button',name='比较',exact=True).click()
        expect(page.get_by_role('dialog',name='版本对比')).to_be_visible()
        expect(page.get_by_role('dialog').locator('video')).to_have_count(2)
        screenshot(page,'A6-version-comparison.png')
        page.get_by_role('button',name='选用版本 2',exact=True).click()
        poll(lambda:rpc(base,'project.get',{'projectId':pid}),lambda v:next(s for s in v['shots'] if s['id']==first['id'])['selectedVersionId']==next(x for x in v['versions'] if x['shotId']==first['id'] and x['number']==2)['id'])
        page.get_by_role('button',name='关闭对话框').click()
        # Reordering explicitly differs from canvas coordinates.
        page.get_by_role('button',name='将 '+shots[2]['title']+' 前移',exact=True).click()
        state=poll(lambda:rpc(base,'project.get',{'projectId':pid}),lambda v:v['shots'][1]['id']==shots[2]['id'])
        assert [s['position'] for s in sorted(state['shots'],key=lambda x:x['id'])]==[s['position'] for s in sorted(shots,key=lambda x:x['id'])]
        if page.get_by_role('button',name='关闭提示').is_visible():page.get_by_role('button',name='关闭提示').click()
        page.get_by_test_id('fit-canvas').click();page.wait_for_timeout(500);screenshot(page,'A10-media-canvas.png')
        # Generic text node is persisted through actual form editing.
        page.get_by_test_id('add-text-node').click();page.get_by_label('文字内容',exact=True).fill('自制合成测试素材；真实产品图未接入。')
        page.get_by_role('button',name='保存节点',exact=True).click()
        poll(lambda:rpc(base,'project.get',{'projectId':pid}),lambda v:any(n['text'].startswith('自制合成') for n in v['nodes']))
        # Refresh recovery and harmless modal dismissal.
        page.reload();expect(page.get_by_test_id('workbench')).to_be_visible();expect(page.get_by_test_id('storyboard').locator('.storyboard-shot')).to_have_count(3)
        log('A10: version selection, separate ordering, text node and refresh persistence verified')
        select_shot(page,first);page.get_by_role('button',name='高级参数',exact=True).click();page.get_by_test_id('mock-scenario').click();page.get_by_role('option',name='提交状态未知（禁止重提）',exact=True).click();page.get_by_test_id('generate-shot').click()
        state=poll(lambda:rpc(base,'project.get',{'projectId':pid}),lambda v:any(j['status']=='submission_unknown' for j in v['jobs']))
        # Submission opens its modal asynchronously; await it instead of racing a second trigger click.
        expect(page.get_by_role('button',name='关闭生成任务')).to_be_visible(timeout=15000)
        expect(page.get_by_text('服务商可能已接受任务并计费。请在服务商核实，系统不会盲目重新提交。',exact=True)).to_be_visible(timeout=15000)
        screenshot(page,'A7-unknown-submission.png');page.get_by_role('button',name='关闭生成任务').click()
        log('A7: UI visibly preserves unknown submission warning, no automatic second submit')
        workbench_action(page, 'export-button').click();expect(page.get_by_role('dialog',name='导出记录')).to_be_visible()
        expect(page.get_by_test_id('download-export')).to_be_visible(timeout=90000)
        screenshot(page,'A8-export-ready.png')
        with page.expect_download() as download_info:page.get_by_test_id('download-export').click()
        download=download_info.value;download.save_as(str(OUT/'browser-export-portrait.mp4'))
        log('A8/A10: actual UI export and download completed',file='browser-export-portrait.mp4')
        page.get_by_role('button',name='关闭对话框').click();workbench_action(page, 'jobs-button').click();page.get_by_role('button',name='关闭生成任务').click()
        state=rpc(base,'project.get',{'projectId':pid});(OUT/'project-state.json').write_text(json.dumps(state,ensure_ascii=False,indent=2))
        (OUT/'browser-errors.json').write_text(json.dumps(errors,indent=2));assert not errors,errors
        context.close()
    finally:stop(proc,handle)
    # A3: open the exact persisted project created through a real MCP client.
    manifest=json.loads((ROOT/'evidence/mcp-demo/demo-project.json').read_text())
    mcp_pid=manifest['projectId']
    proc,handle,base=start(ROOT/'examples/mcp-project' if (ROOT/'examples/mcp-project/workbench.sqlite').exists() else pathlib.Path(manifest['dataDirectory']))
    try:
        context=browser.new_context(viewport={'width':1600,'height':1000});page=context.new_page()
        login(page,base,mcp_pid);page.get_by_role('button',name='展开分镜',exact=True).click();expect(page.get_by_test_id('storyboard').locator('.storyboard-shot')).to_have_count(3)
        for shot_id in manifest['shotIds']:
            expect(page.locator('[data-testid="shot-node-'+shot_id+'"] video')).to_have_count(1)
        page.get_by_test_id('fit-canvas').click();page.wait_for_timeout(600);screenshot(page,'A3-mcp-project-in-ui.png')
        log('A3: actual UI displays the exact MCP-created project and selected versions',projectId=mcp_pid)
        context.close()
    finally:stop(proc,handle)
    demo=json.loads((ROOT/'evidence/demo.json').read_text())
    proc,handle,base=start(ROOT/'examples/demo-project')
    try:
        context=browser.new_context(viewport={'width':1600,'height':1000});page=context.new_page()
        login(page,base,demo['projectId']);page.get_by_role('button',name='展开分镜',exact=True).click();expect(page.get_by_test_id('storyboard').locator('.storyboard-shot')).to_have_count(5)
        page.get_by_test_id('fit-canvas').click();page.wait_for_timeout(600);screenshot(page,'M3-story-demo.png')
        log('M3: requested five-beat10second story sample opens with mock versions',projectId=demo['projectId'])
        context.close()
    finally:stop(proc,handle)
    browser.close()
(OUT/'steps.json').write_text(json.dumps({'status':'PASS','steps':steps,'pageErrors':errors},ensure_ascii=False,indent=2))
print(json.dumps({'status':'PASS','steps':len(steps),'evidence':str(OUT)},ensure_ascii=False))
