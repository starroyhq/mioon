"""Actual Chromium V2 interaction acceptance on a copied synthetic project.
No app-state mocking: mouse/keyboard/file picker actions are checked against HTTP.
A route abort intentionally loses one accepted response to exercise exact replay.
"""
import json, os, pathlib, shutil, socket, subprocess, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright, expect
ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=pathlib.Path(os.environ.get('MIOON_BROWSER_EVIDENCE',str(ROOT/'evidence/v3-browser'))); OUT.mkdir(parents=True,exist_ok=True)
TOKEN='v2-browser-local-test-token-no-live-provider'
steps=[]; errors=[]
def log(step,**values):
    steps.append({'step':step,'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),**values});print(step,flush=True)
def rpc(base,op,params):
    r=urllib.request.Request(base+'/api/rpc',data=json.dumps({'operation':op,'input':params}).encode(),headers={'content-type':'application/json','authorization':'Bearer '+TOKEN})
    with urllib.request.urlopen(r,timeout=60) as response: result=json.load(response)
    assert result['ok'],result
    return result['data']
def poll(fn,predicate,seconds=60):
    end=time.time()+seconds; value=None
    while time.time()<end:
        value=fn()
        if predicate(value):return value
        time.sleep(.15)
    raise AssertionError('Wait timed out: '+str(value)[:1000])
def start(data):
    s=socket.socket();s.bind(('127.0.0.1',0));port=s.getsockname()[1];s.close()
    handle=open(OUT/('server-'+str(port)+'.log'),'w')
    proc=subprocess.Popen(['node','server/index.mjs'],cwd=ROOT,env={**os.environ,'PORT':str(port),'MIOON_TOKEN':TOKEN,'MIOON_DATA_DIR':str(data),'MIOON_ENABLE_LIVE_PROVIDER':'0','RUNWAYML_API_SECRET':'','RUNWAY_MAX_GENERATIONS':'0'},stdout=handle,stderr=subprocess.STDOUT)
    base=f'http://127.0.0.1:{port}'
    for _ in range(100):
        if proc.poll() is not None:raise RuntimeError('Backend exited before health')
        try:
            with urllib.request.urlopen(base+'/health',timeout=1) as response:
                if response.status==200:return proc,handle,base
        except Exception:time.sleep(.1)
    raise RuntimeError('Backend start timeout')
def stop(proc,handle):
    proc.terminate()
    try:proc.wait(timeout=90)
    except subprocess.TimeoutExpired:proc.kill();proc.wait()
    handle.close()
def login(page,base,pid):
    page.goto(base+'/?project='+pid)
    page.get_by_label('访问令牌',exact=True).fill(TOKEN)
    page.get_by_role('button',name='进入工作台',exact=True).click()
    expect(page.get_by_test_id('workbench')).to_be_visible(timeout=15000)
def dismiss(page):
    for name in ['关闭提示','关闭生成任务']:
        button=page.get_by_role('button',name=name,exact=True)
        if button.is_visible():button.click()
def screenshot(page,name):page.screenshot(path=str(OUT/name),full_page=True)
def drag(page,source,target,tx,ty=None,source_x=None):
    source.scroll_into_view_if_needed(); a=source.bounding_box(); b=target.bounding_box(); assert a and b
    sx=a['x']+(source_x if source_x is not None else min(a['width']/2,25));sy=a['y']+a['height']/2
    x=b['x']+tx;y=b['y']+(ty if ty is not None else b['height']/2)
    page.mouse.move(sx,sy);page.mouse.down();page.mouse.move(sx+6,sy+3,steps=3);page.mouse.move(x,y,steps=25);page.mouse.move(x+1,y,steps=2);page.mouse.up()

manifest=json.loads((ROOT/'evidence/v2-demo/demo-project.json').read_text());pid=manifest['projectId']
data=pathlib.Path(tempfile.mkdtemp(prefix='workbench-v2-browser-'))/'project'
shutil.copytree(ROOT/'examples/multitrack-project',data,ignore=shutil.ignore_patterns('access-token','server.lock','*.sqlite-wal','*.sqlite-shm'))
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=shutil.which('chromium'),headless=True,chromium_sandbox=True)
    proc,handle,base=start(data)
    try:
        context=browser.new_context(viewport={'width':1600,'height':1050},accept_downloads=True)
        page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        login(page,base,pid)
        state=lambda:rpc(base,'project.get',{'projectId':pid})
        initial=state();tl=initial['timeline'];assert len(tl['tracks'])==3 and len(tl['clips'])==5
        for label in ['01 素材库','画板工作区','03 属性']:
            expect(page.get_by_label(label,exact=True)).to_be_visible()
        page.get_by_test_id('fit-canvas').click();page.wait_for_timeout(500)
        screenshot(page,'01-canvas-regions.png')
        page.get_by_test_id('region-guide-toggle').click();expect(page.get_by_test_id('region-guide')).to_be_visible();screenshot(page,'02-region-guide.png');page.get_by_role('button',name='关闭区域说明').click()
        expect(page.get_by_test_id('timeline-panel')).to_have_count(0)
        log('V2-B1: Canvas regions and in-app guide visible; timeline unmounted',projectId=pid)
        page.get_by_test_id('workspace-editing').click();page.get_by_test_id('preview-timeline-mode').click()
        video=page.get_by_test_id('timeline-preview-video');expect(video).to_be_visible()
        video.evaluate('(v)=>{v.muted=true;return v.play()}');poll(lambda:video.evaluate('(v)=>v.readyState'),lambda r:r>=3);video.evaluate('(v)=>v.pause()')
        page.get_by_test_id('timeline-playhead').fill('90');page.get_by_test_id('timeline-playhead').press('Tab')
        poll(lambda:video.evaluate('(v)=>({t:v.currentTime,w:v.videoWidth,h:v.videoHeight,ready:v.readyState,seeking:v.seeking})'),lambda v:abs(v['t']-3)<.09 and v['w']==720 and v['ready']>=3 and not v['seeking'])
        screenshot(page,'03-timeline-preview.png')
        video.evaluate('(v)=>{v.muted=true;return v.play()}');page.wait_for_timeout(450);played=video.evaluate('(v)=>({time:v.currentTime,width:v.videoWidth,height:v.videoHeight,error:v.error&&v.error.code})');assert played['time']>3.15 and not played['error'];video.evaluate('(v)=>v.pause()')
        playhead=int(page.get_by_test_id('timeline-playhead').input_value());assert playhead>94
        log('V2-B2: true timeline render decodes; playhead seeks video and playback advances playhead',playback=played,playhead=playhead)
        assets=initial['assets'];audio=next(a for a in assets if a['mimeType'].startswith('audio/'));image=next(a for a in assets if a['mimeType'].startswith('image/'))
        page.get_by_test_id('asset-panel').get_by_role('tab',name='音频',exact=True).click()
        page.get_by_role('button',name='预览 '+audio['name'],exact=True).click();player=page.get_by_test_id('source-preview-audio');expect(player).to_be_visible();player.evaluate('(v)=>v.play()');page.wait_for_timeout(250);assert player.evaluate('(v)=>v.currentTime')>0;player.evaluate('(v)=>v.pause()')
        page.get_by_test_id('asset-upload').set_input_files(str(ROOT/'examples/timeline-synthetic/sound-bed.wav'))
        imported=poll(state,lambda v:len(v['assets'])==len(assets)+1);assert imported['assets'][-1]['mimeType']=='audio/wav'
        dismiss(page);log('V2-B3: audio library filter, actual source playback and WAV browser import work')
        page.get_by_test_id('asset-panel').get_by_role('tab',name='图片',exact=True).click();page.get_by_test_id('workspace-canvas').click()
        before_nodes=len(state()['nodes']);target=page.get_by_test_id('canvas-drop-zone');box=target.bounding_box()
        drag(page,page.get_by_test_id('asset-card-'+image['id']).locator('.asset-card-meta'),target,box['width']*.65,box['height']*.45)
        poll(state,lambda v:len(v['nodes'])==before_nodes+1)
        dismiss(page);log('V2-B4: real pointer drag from image library to canvas persisted a new asset node')
        # Drop the same source onto a new compatible track, then drag an existing
        # clip from V2 to it; actual HTML5 pointer events carry the app's drag payload.
        page.get_by_test_id('workspace-editing').click()
        expect(page.get_by_test_id('timeline-panel')).to_be_visible()
        before_tracks=len(state()['timeline']['tracks']);page.get_by_test_id('add-video-track').click()
        current=poll(state,lambda v:len(v['timeline']['tracks'])==before_tracks+1);newtrack=max(current['timeline']['tracks'],key=lambda t:t['orderIndex'])
        lane=page.get_by_test_id('track-lane-'+newtrack['id']);expect(lane).to_be_visible()
        before_clips=len(current['timeline']['clips']);drag(page,page.get_by_test_id('asset-card-'+image['id']).locator('.asset-card-meta'),lane,20)
        current=poll(state,lambda v:len(v['timeline']['clips'])==before_clips+1);newclip=next(c for c in current['timeline']['clips'] if c['trackId']==newtrack['id'])
        assert 5<=newclip['startFrame']<=11
        dismiss(page)
        overlay=next(c for c in initial['timeline']['clips'] if c['assetId']==image['id']);clip=page.get_by_test_id('timeline-clip-'+overlay['id'])
        # Move to 4 seconds on V3. Grab at 10px; drop at 4sec*76px +10.
        drag(page,clip,lane,4*76+10,source_x=10)
        current=poll(state,lambda v:next(c for c in v['timeline']['clips'] if c['id']==overlay['id'])['trackId']==newtrack['id'])
        moved=next(c for c in current['timeline']['clips'] if c['id']==overlay['id']);assert abs(moved['startFrame']-120)<=1 and moved['durationFrames']==overlay['durationFrames'] and moved['sourceInFrame']==0
        dismiss(page);log('V2-B5: real library-to-timeline drop, added track and cross-track pointer move persist',clipId=moved['id'],startFrame=moved['startFrame'],trackId=newtrack['id'])
        # Timing and source trim editing, plus unsaved-state retention while mode
        # and properties panel are hidden and restored.
        baseclip=next(c for c in initial['timeline']['clips'] if c['startFrame']==150 and c['durationFrames']==150)
        page.get_by_test_id('timeline-clip-'+baseclip['id']).click();expect(page.get_by_test_id('clip-inspector')).to_be_visible()
        page.get_by_test_id('clip-duration').fill('90');page.get_by_test_id('clip-source-in').fill('30')
        page.get_by_test_id('workspace-canvas').click()
        expect(page.get_by_test_id('confirm-action')).to_be_visible()
        page.get_by_role('button',name='取消',exact=True).click()
        expect(page.get_by_test_id('workspace-editing')).to_have_attribute('aria-selected','true')
        expect(page.get_by_test_id('clip-duration')).to_have_value('90')
        page.get_by_test_id('toggle-inspector').click();page.get_by_test_id('reopen-inspector').click();expect(page.get_by_test_id('clip-source-in')).to_have_value('30')
        page.get_by_test_id('save-clip').click()
        current=poll(state,lambda v:next(c for c in v['timeline']['clips'] if c['id']==baseclip['id'])['sourceInFrame']==30)
        assert next(c for c in current['timeline']['clips'] if c['id']==baseclip['id'])['durationFrames']==90
        dismiss(page);page.get_by_test_id('preview-timeline-mode').click();expect(page.get_by_test_id('preview-stale')).to_be_visible();screenshot(page,'04-stale-preview-and-trim.png')
        page.get_by_test_id('toggle-assets').click();page.get_by_test_id('reopen-assets').click();page.get_by_test_id('toggle-timeline').click();page.get_by_test_id('toggle-timeline').click()
        expect(page.get_by_test_id('timeline-clip-'+baseclip['id'])).to_be_visible()
        log('V2-B6: frame-precise trim and source offset save; mode Cancel/collapsed panels retain unsaved edits; stale render is explicit')
        # Same-track overlap rejection must not mutate the authoritative timeline.
        page.get_by_test_id('timeline-clip-'+moved['id']).click();before=state()['timeline'];page.get_by_test_id('clip-start').fill('0');page.get_by_test_id('save-clip').click()
        expect(page.get_by_role('alert')).to_contain_text('同一轨道',timeout=10000)
        assert state()['timeline']==before
        screenshot(page,'05-overlap-rejected.png');dismiss(page);page.get_by_role('button',name='放弃修改',exact=True).click()
        # Unsupported visual-to-audio move is rejected before service mutation.
        audio_track=next(t for t in before['tracks'] if t['kind']=='audio')
        page.get_by_test_id('track-lane-'+audio_track['id']).scroll_into_view_if_needed()
        drag(page,page.get_by_test_id('timeline-clip-'+baseclip['id']),page.get_by_test_id('track-lane-'+audio_track['id']),8*76+10,source_x=10)
        expect(page.locator('.toast')).to_contain_text('兼容',timeout=5000);assert state()['timeline']==before;dismiss(page)
        log('V2-B7: overlap and incompatible cross-track drops visibly reject with unchanged timeline')
        # Picture and sound controls are distinct real persisted operations.
        vtrack=next(t for t in before['tracks'] if t['id']==baseclip['trackId'])
        page.get_by_role('switch',name='显示 '+vtrack['name'],exact=True).click();poll(state,lambda v:next(t for t in v['timeline']['tracks'] if t['id']==vtrack['id'])['hidden'])
        page.get_by_role('switch',name='静音 '+audio_track['name'],exact=True).click();poll(state,lambda v:next(t for t in v['timeline']['tracks'] if t['id']==audio_track['id'])['muted'])
        page.get_by_role('switch',name='显示 '+vtrack['name'],exact=True).click();poll(state,lambda v:not next(t for t in v['timeline']['tracks'] if t['id']==vtrack['id'])['hidden'])
        page.get_by_role('switch',name='静音 '+audio_track['name'],exact=True).click();poll(state,lambda v:not next(t for t in v['timeline']['tracks'] if t['id']==audio_track['id'])['muted'])
        log('V2-B8: separate track picture visibility and mute controls persist')
        # Lose one accepted mutation response; refresh and recover exact request.
        lost=[];count=len(state()['timeline']['tracks'])
        def lose(route):
            body=route.request.post_data_json
            if body and body.get('operation')=='timeline.track.add' and not lost:
                lost.append(body);route.fetch();route.abort('failed')
            else:route.continue_()
        page.route('**/api/rpc',lose);page.get_by_test_id('add-audio-track').click();poll(state,lambda v:len(v['timeline']['tracks'])==count+1)
        expect(page.get_by_test_id('pending-submission')).to_be_visible();page.unroute('**/api/rpc',lose)
        page.reload();expect(page.get_by_test_id('workbench')).to_be_visible();page.get_by_test_id('jobs-button').click();expect(page.get_by_test_id('resume-pending')).to_be_visible();page.get_by_test_id('resume-pending').click();expect(page.get_by_test_id('pending-submission')).to_have_count(0)
        assert len(state()['timeline']['tracks'])==count+1 and len(lost)==1;dismiss(page)
        log('V2-B9: accepted mutation response loss survives reload; exact replay creates only one track',requestId=lost[0]['input']['requestId'])
        before_exports=len(state()['exports']);page.get_by_test_id('timeline-render-preview').click()
        rendered=poll(state,lambda v:len(v['exports'])==before_exports+1 and v['exports'][-1]['status']=='succeeded',120)
        expect(page.get_by_test_id('timeline-preview-video')).to_be_visible(timeout=15000);expect(page.get_by_test_id('preview-stale')).to_have_count(0)
        current=rendered['timeline'];render=rendered['exports'][-1];assert render['timelineRevision']==current['revision']
        v=page.get_by_test_id('timeline-preview-video');v.evaluate('(v)=>{v.muted=true;return v.play()}');page.wait_for_timeout(350);assert v.evaluate('(v)=>v.currentTime')>0;v.evaluate('(v)=>v.pause()')
        page.get_by_test_id('timeline-playhead').fill('180');page.get_by_test_id('timeline-playhead').press('Tab');poll(lambda:v.evaluate('(v)=>v.currentTime'),lambda x:abs(x-6)<.1)
        screenshot(page,'06-updated-multitrack-preview.png');log('V2-B10: render updated timeline, real playback and seek from exact frame succeed',revision=current['revision'])
        before_exports=len(rendered['exports']);page.get_by_test_id('export-timeline').click();expect(page.get_by_role('dialog',name='导出记录')).to_be_visible()
        final=poll(state,lambda v:len(v['exports'])==before_exports+1 and v['exports'][-1]['status']=='succeeded',120)
        downloads=page.get_by_test_id('download-export');expect(downloads.first).to_be_visible(timeout=10000)
        with page.expect_download() as info:downloads.first.click()
        info.value.save_as(str(OUT/'browser-timeline-export.mp4'));screenshot(page,'07-timeline-export-ready.png');page.get_by_role('button',name='关闭对话框').click();dismiss(page)
        assert final['exports'][-1]['mode']=='timeline' and final['exports'][-1]['purpose']=='export'
        log('V2-B11: final timeline export from actual UI downloads successfully',exportId=final['exports'][-1]['id'],durationFrames=final['timeline']['durationFrames'])
        before=state()['timeline'];page.reload();expect(page.get_by_test_id('timeline-panel')).to_be_visible();assert state()['timeline']==before
        log('V2-B12: persisted track IDs, clip timing/trim, layer controls and references survive full page reload')
        (OUT/'final-project-state.json').write_text(json.dumps(state(),ensure_ascii=False,indent=2));context.close()
        # A pristine source copy provides final deliverable views, at two useful
        # desktop sizes, without hiding mutated-test state in the acceptance data.
        pristine=pathlib.Path(tempfile.mkdtemp(prefix='workbench-v2-showcase-'))/'project';shutil.copytree(ROOT/'examples/multitrack-project',pristine)
    except Exception:
        if 'page' in locals():screenshot(page,'failure.png')
        raise
    finally:stop(proc,handle)
    proc,handle,base=start(pristine)
    try:
        context=browser.new_context(viewport={'width':1600,'height':1050});page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)));login(page,base,pid)
        collapse=page.get_by_role('button',name='收起分镜',exact=True)
        if collapse.is_visible():collapse.click()
        page.get_by_test_id('fit-canvas').click();page.wait_for_timeout(500);screenshot(page,'deliverable-canvas.png')
        overlay=next(c for c in manifest['preview']['snapshot']['timeline']['clips'] if c.get('rect',{}).get('width')==280)
        page.get_by_test_id('timeline-clip-'+overlay['id']).click();page.get_by_test_id('preview-timeline-mode').click();showcase_video=page.get_by_test_id('timeline-preview-video');showcase_video.evaluate('(v)=>{v.muted=true;return v.play()}');poll(lambda:showcase_video.evaluate('(v)=>v.readyState'),lambda r:r>=3);showcase_video.evaluate('(v)=>v.pause()');page.get_by_test_id('timeline-playhead').fill('90');page.get_by_test_id('timeline-playhead').press('Tab')
        poll(lambda:page.get_by_test_id('timeline-preview-video').evaluate('(v)=>({t:v.currentTime,ready:v.readyState,seeking:v.seeking})'),lambda v:abs(v['t']-3)<.1 and v['ready']>=3 and not v['seeking'])
        screenshot(page,'deliverable-preview.png');page.get_by_test_id('region-guide-toggle').click();screenshot(page,'deliverable-region-guide.png');page.get_by_role('button',name='关闭区域说明').click()
        page.set_viewport_size({'width':1366,'height':900});page.wait_for_timeout(300);screenshot(page,'deliverable-1366.png')
        bounds=page.locator('[data-testid="timeline-panel"]').bounding_box();assert bounds['height']>180 and bounds['y']+bounds['height']<=905,bounds
        assert not errors,errors;log('V2-B13: pristine canvas/preview/region overview captured; 1366×900 desktop timeline remains usable')
        context.close()
    finally:stop(proc,handle);browser.close()
(OUT/'page-errors.json').write_text(json.dumps(errors,indent=2));(OUT/'steps.json').write_text(json.dumps({'status':'PASS','steps':steps,'pageErrors':errors},ensure_ascii=False,indent=2))
print(json.dumps({'status':'PASS','steps':len(steps),'evidence':str(OUT)},ensure_ascii=False))
