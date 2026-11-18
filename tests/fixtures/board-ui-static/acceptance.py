"""Synthetic component acceptance, using the repository's existing Playwright tool."""
import argparse
import json
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import time
import traceback
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


def running_animations(page):
    return page.evaluate('''() => document.getAnimations().filter(animation =>
      animation.playState === 'running' && animation.effect?.getTiming().iterations === Infinity
    ).map(animation => ({name:animation.animationName??'unknown',target:animation.effect?.target?.className?.baseVal??animation.effect?.target?.className??''}))''')


def sequence_motion_geometry(page):
    return page.locator('[data-board-edge-kind="sequence"]').evaluate_all('''groups => groups.map(group => {
      const path=group.querySelector('.board-sequence-line');
      const dot=group.querySelector('.board-sequence-dot');
      const animation=dot.getAnimations()[0];
      if(!animation)throw new Error('No sequence animation to measure');
      const duration=animation.effect.getTiming().duration,current=animation.currentTime;
      animation.pause();
      const length=path.getTotalLength(),matrix=path.getScreenCTM();
      const errors=[0,.25,.75].map(phase=>{
        animation.currentTime=duration*phase;
        const bounds=dot.getBoundingClientRect(),actual={x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2};
        const point=path.getPointAtLength(length*phase).matrixTransform(matrix);
        return Math.hypot(actual.x-point.x,actual.y-point.y);
      });
      animation.currentTime=current;animation.play();
      return {id:group.dataset.edgeId,maxPhaseErrorPx:Math.max(...errors),
        offsetPosition:getComputedStyle(dot).offsetPosition,offsetAnchor:getComputedStyle(dot).offsetAnchor,
        transformBox:getComputedStyle(dot).transformBox};
    })''')


def edge_endpoint_geometry(page):
    edges=[
      ['sequence-1','film','sequence-out','shot-1','sequence-in'],
      ['sequence-2','shot-1','sequence-out','shot-2','sequence-in'],
      ['sequence-3','shot-2','sequence-out','shot-3','sequence-in'],
      ['sequence-4','shot-3','sequence-out','shot-4','sequence-in'],
      ['reference-1','image','reference-out-bottom','shot-3','reference-in-top'],
      ['reference-2','subject','reference-out-top','shot-3','reference-in-bottom'],
      ['reference-3','subject','reference-out-top','shot-4','reference-in-bottom'],
    ]
    return page.evaluate('''edges => edges.map(([id,source,sourcePort,target,targetPort])=>{
      const path=document.querySelector(`[data-edge-id="${id}"] .react-flow__edge-path`);
      const points=[path.getPointAtLength(0),path.getPointAtLength(path.getTotalLength())];
      const handles=[[source,sourcePort],[target,targetPort]].map(([node,port])=>document.querySelector(`[data-testid="board-port-${node}-${port}"]`));
      const errors=handles.map((handle,index)=>{
        const rect=handle.getBoundingClientRect(),point=points[index].matrixTransform(path.getScreenCTM());
        const center={x:rect.x+rect.width/2,y:rect.y+rect.height/2};
        const side=handle.dataset.portSide;
        const expected={x:side==='left'?rect.left:side==='right'?rect.right:center.x,
          y:side==='top'?rect.top:side==='bottom'?rect.bottom:center.y};
        return {centerDistance:Math.hypot(center.x-point.x,center.y-point.y),
          attachmentDistance:Math.hypot(expected.x-point.x,expected.y-point.y),side};
      });
      return {id,sourcePort,targetPort,sourceErrorPx:errors[0].attachmentDistance,targetErrorPx:errors[1].attachmentDistance,
        sourceCenterDistancePx:errors[0].centerDistance,targetCenterDistancePx:errors[1].centerDistance,
        sourceSide:errors[0].side,targetSide:errors[1].side};
    })''',edges)


def reference_motion_geometry(page):
    targets=[['reference-1','shot-3','reference-in-top'],['reference-2','shot-3','reference-in-bottom'],['reference-3','shot-4','reference-in-bottom']]
    return page.evaluate('''targets => targets.map(([id,node,port])=>{
      const path=document.querySelector(`[data-edge-id="${id}"] .board-reference-line`);
      const handle=document.querySelector(`[data-testid="board-port-${node}-${port}"]`);
      const side=handle.dataset.portSide;
      if(side!=='top'&&side!=='bottom')throw new Error('Reference target must be a top or bottom handle');
      const normal=side==='top'?1:-1,length=path.getTotalLength();
      const end=path.getPointAtLength(length),start=path.getPointAtLength(0);
      const samples=Array.from({length:257},(_,index)=>path.getPointAtLength(length*index/256));
      const lastHalf=path.getPointAtLength(Math.max(0,length-.5));
      const lastOne=path.getPointAtLength(Math.max(0,length-1));
      const normalSteps=samples.slice(1).map((point,index)=>(point.y-samples[index].y)*normal);
      return {id,targetSide:side,length,
        lastHalfArcNormalAdvance:(end.y-lastHalf.y)*normal,
        lastOneArcNormalAdvance:(end.y-lastOne.y)*normal,
        minimumNormalStep:Math.min(...normalSteps),
        targetNormalOvershoot:Math.max(...samples.map(point=>(point.y-end.y)*normal)),
        lateralOvershoot:Math.max(0,...samples.map(point=>Math.max(Math.min(start.x,end.x)-point.x,point.x-Math.max(start.x,end.x))))};
    })''',targets)


def assert_reference_motion_geometry(rows):
    for row in rows:
        assert row['lastHalfArcNormalAdvance']>.05 and row['lastOneArcNormalAdvance']>.05, 'Reference path enters from the wrong side: '+json.dumps(row)
        assert row['minimumNormalStep']>=-.01, 'Reference path turns back before its target: '+json.dumps(row)
        assert row['targetNormalOvershoot']<=.01 and row['lateralOvershoot']<=.01, 'Reference path overshoots its target corridor: '+json.dumps(row)


def wait_ready(page, scenario='sample'):
    expect(page.get_by_test_id('board-ui-static')).to_be_visible()
    expect(page.locator('[data-fixture-scenario]')).to_have_attribute('data-fixture-scenario', scenario)
    page.wait_for_function('''() => window.__boardFixture && [...document.querySelectorAll('.react-flow__node')].every(node =>
      getComputedStyle(node).visibility !== 'hidden' && node.getBoundingClientRect().width > 0)''')
    page.evaluate('''async () => {await document.fonts.ready;for(let i=0;i<15;i++)await new Promise(requestAnimationFrame);}''')


def port(page, node_id, port_id):
    return page.get_by_test_id(f'board-port-{node_id}-{port_id}')


def connect_drag(page, source, target, reference):
    start, end = source.bounding_box(), target.bounding_box()
    assert start and end
    page.mouse.move(start['x']+start['width']/2,start['y']+start['height']/2)
    page.mouse.down()
    page.mouse.move(start['x']+start['width']/2+20,start['y']+start['height']/2+10,steps=5)
    expect(port(page,'shot-4','reference-in-top' if reference else 'sequence-in')).to_have_attribute('data-candidate','true')
    expect(port(page,'shot-4','sequence-in' if reference else 'reference-in-top')).to_have_attribute('data-candidate','false')
    expect(port(page,'film','sequence-out')).to_have_attribute('data-candidate','false')
    page.mouse.move(end['x']+end['width']/2,end['y']+end['height']/2,steps=10)
    page.mouse.up()


def stationary_interval(page):
    return page.evaluate('''async () => {
      const samples=[];let last;
      for(let i=0;i<45;i++){const now=await new Promise(requestAnimationFrame);if(last!==undefined)samples.push(now-last);last=now;}
      samples.sort((a,b)=>a-b);return samples[Math.floor(samples.length/2)];
    }''')


def drag_measurement(page, nominal, seconds=4):
    # Choose a real empty React Flow pane point; never synthesize onMove state.
    point=page.evaluate('''() => {
      const pane=document.querySelector('[data-testid="board-ui-canvas"] .react-flow__pane');
      const bounds=pane.getBoundingClientRect();
      for(let yi=2;yi<8;yi++)for(let xi=1;xi<9;xi++){
        const x=bounds.x+bounds.width*xi/10,y=bounds.y+bounds.height*yi/10;
        if(document.elementFromPoint(x,y)===pane)return {x,y};
      }
      throw new Error('No empty pane point for measured pointer drag');
    }''')
    before=page.locator('.react-flow__viewport').evaluate('node => getComputedStyle(node).transform')
    page.evaluate('''seconds => {
      window.__boardDragSample=new Promise(resolve=>{
        const values=[];let first,last;
        const tick=now=>{if(first===undefined)first=now;if(last!==undefined)values.push(now-last);last=now;
          if(now-first>=seconds*1000)resolve(values);else requestAnimationFrame(tick);};
        requestAnimationFrame(tick);
      });
    }''',seconds)
    page.mouse.move(point['x'],point['y'])
    page.mouse.down()
    started=time.monotonic()
    index=0
    moved_during_trial=False
    while time.monotonic()-started<seconds:
        # Continuous horizontal back-and-forth path stays inside the viewport.
        delta=(index%40 if (index//40)%2==0 else 40-index%40)
        page.mouse.move(point['x']+delta,point['y']+12*((index%40)/40))
        if index==10:
            moved_during_trial=before!=page.locator('.react-flow__viewport').evaluate('node => getComputedStyle(node).transform')
        time.sleep(1/120)
        index+=1
    values=page.evaluate('() => window.__boardDragSample')
    after=page.locator('.react-flow__viewport').evaluate('node => getComputedStyle(node).transform')
    assert moved_during_trial or before!=after, 'Measured pointer sequence did not pan the React Flow viewport'
    # Restore by completing the real pointer path, so later trials fit the same edges.
    page.mouse.move(point['x'],point['y'])
    page.mouse.up()
    ordered=sorted(values)
    return {'frames':len(values),'medianMs':ordered[len(ordered)//2],
      'p95Ms':ordered[min(len(ordered)-1,int(len(ordered)*.95))],'maxMs':max(values),
      'longFramesAbove2xRefresh':sum(value>nominal*2 for value in values),
      'estimatedMissedRefreshes':sum(max(0,round(value/nominal)-1) for value in values),
      'pointerMoves':index,'actualPan':True}


def acceptance(page, options):
    failures=[]
    page.on('pageerror',lambda error:failures.append(str(error)))
    requests=[]
    origin=urlparse(options.url).netloc
    def observe(request):
        parsed=urlparse(request.url)
        if parsed.path.startswith('/api') or parsed.scheme in ('http','https') and parsed.netloc!=origin:
            requests.append(request.url)
    page.on('request',observe)
    page.goto(options.url,wait_until='networkidle')
    wait_ready(page)
    result={'checks':[]}
    expect(page.locator('[data-board-edge-kind="sequence"]')).to_have_count(4)
    expect(page.locator('[data-board-edge-kind="reference"]')).to_have_count(3)
    expect(page.locator('.board-sequence-dot')).to_have_count(4)
    assert page.locator('.board-sequence-line').evaluate_all('nodes => nodes.every(node => getComputedStyle(node).strokeDasharray === "none" && !node.hasAttribute("marker-end"))')
    assert page.locator('.board-reference-line').evaluate_all('nodes => nodes.every(node => getComputedStyle(node).strokeDasharray !== "none")')
    assert len(running_animations(page))==7
    result['sequenceMotionGeometry']=sequence_motion_geometry(page)
    assert max(row['maxPhaseErrorPx'] for row in result['sequenceMotionGeometry'])<2, 'Sequence light dot is not following its own edge from source to target: '+json.dumps(result['sequenceMotionGeometry'])
    result['edgeEndpointGeometry']=edge_endpoint_geometry(page)
    assert max(max(row['sourceErrorPx'],row['targetErrorPx']) for row in result['edgeEndpointGeometry'])<2, 'Edge path is not attached to its selected handle: '+json.dumps(result['edgeEndpointGeometry'])
    result['referenceMotionGeometry']=reference_motion_geometry(page)
    assert_reference_motion_geometry(result['referenceMotionGeometry'])
    expect(page.locator('.board-reference-label').filter(has_text='首帧')).to_have_count(1)
    expect(page.locator('[data-testid^="board-port-film-"]')).to_have_count(1)
    expect(page.locator('[data-testid^="board-port-shot-1-"]')).to_have_count(4)
    expect(page.locator('[data-testid^="board-port-image-"]')).to_have_count(4)
    expect(page.locator('[data-testid^="board-port-text-"]')).to_have_count(0)
    for side,port_id in [('left','sequence-in'),('right','sequence-out'),('top','reference-in-top'),('bottom','reference-in-bottom')]:
        expect(port(page,'shot-1',port_id)).to_have_attribute('data-port-side',side)
    items=page.locator('[data-testid^="board-film-item-"]')
    assert items.evaluate_all('nodes => nodes.map(node => node.dataset.testid)')==[f'board-film-item-shot-{index}' for index in range(1,5)]
    expect(page.get_by_test_id('board-film-overview')).to_contain_text('画板概览')
    assert page.get_by_test_id('board-film-overview').locator('dd').all_text_contents()==['4','2','1','1','1','0:15']
    expect(page.get_by_test_id('board-card-film')).to_contain_text('9:16 · 15 秒')
    expect(page.get_by_test_id('board-card-shot-1').locator('footer')).to_have_text('16:9 · 4s')
    assert page.locator('.board-film-duration').all_text_contents()==['4s','3s','3s','5s']
    expect(page.get_by_test_id('board-film-strip').locator('header')).to_contain_text('15 秒')
    expect(page.locator('.react-flow__attribution')).to_have_count(0)
    expect(page.get_by_test_id('board-floating-label')).to_have_count(1)
    assert page.get_by_test_id('board-floating-label').evaluate_all('nodes => nodes.map(node => node.closest("article").dataset.testid).sort()')==['board-card-text']
    expect(page.get_by_test_id('board-film-strip')).to_contain_text('与剪辑同步')
    result['checks'].append('real React Flow edges, CSS animations, role labels, port families and chain order')
    if options.screens:
        Path(options.screens).mkdir(parents=True,exist_ok=True)
        page.screenshot(path=str(Path(options.screens)/'21-01-static-board.png'),full_page=True)
    toggle=page.get_by_test_id('board-film-strip-toggle')
    toggle.click()
    expect(toggle).to_have_attribute('aria-expanded','false')
    expect(page.get_by_test_id('board-film-item-shot-1')).to_be_hidden()
    toggle.click()
    expect(page.get_by_test_id('board-film-item-shot-1')).to_be_visible()
    page.get_by_test_id('board-film-add').click()
    page.get_by_test_id('board-film-item-shot-3').click()
    assert page.evaluate('window.__boardFixture.readCallbacks().added')==1
    assert page.evaluate('window.__boardFixture.readCallbacks().located')==['shot-3']
    result['checks'].append('strip collapse, add callback, locate callback and selected-node navigation')
    for key in ['Enter','Space']:
        page.reload(wait_until='networkidle');wait_ready(page)
        node=page.get_by_test_id('rf__node-shot-2')
        node.focus();node.press(key)
        expect(page.get_by_test_id('board-selected-summary')).to_contain_text('路口俯拍')
        expect(node).to_have_class(re.compile(r'\bselected\b'))
    result['checks'].append('Enter and Space select the focused React Flow node and show its inspector')
    page.reload(wait_until='networkidle');wait_ready(page)
    connect_drag(page,port(page,'image','reference-out-top'),port(page,'shot-4','reference-in-top'),True)
    connections=page.evaluate('window.__boardFixture.readCallbacks().connections')
    assert len(connections)==1 and connections[0]['sourceId']=='image' and connections[0]['targetId']=='shot-4' and connections[0]['kind']=='reference', 'Pointer reference callback: '+json.dumps(connections)
    expect(page.locator('[data-board-edge-kind="reference"]')).to_have_count(3)
    page.reload(wait_until='networkidle');wait_ready(page)
    connect_drag(page,port(page,'image','sequence-out'),port(page,'shot-4','sequence-in'),False)
    connections=page.evaluate('window.__boardFixture.readCallbacks().connections')
    assert len(connections)==1 and connections[0]['kind']=='sequence'
    page.evaluate('window.__boardFixture.clearCallbacks()')
    connect_drag(page,port(page,'image','sequence-out'),port(page,'shot-4','reference-in-top'),False)
    assert page.evaluate('window.__boardFixture.readCallbacks().connections')==[], 'Incompatible port family reached the connection callback'
    result['checks'].append('pointer drag highlights only compatible target family and calls normalized callback without persistence')
    page.reload(wait_until='networkidle');wait_ready(page)
    page.evaluate('''() => {
      window.__boardKeyLog=[];window.__boardFocusTrace=[];
      document.addEventListener('keydown',event=>window.__boardKeyLog.push({key:event.key,testid:event.target.dataset.testid}),true);
      const sample=kind=>window.__boardFocusTrace.push({kind,time:performance.now(),
        imageVisibility:getComputedStyle(document.querySelector('[data-testid="rf__node-image"]')).visibility,
        focused:document.activeElement?.dataset.testid??null});
      window.__boardFocusObserver=new MutationObserver(()=>sample('mutation'));
      window.__boardFocusObserver.observe(document.querySelector('.react-flow__nodes'),{subtree:true,attributes:true,attributeFilter:['style','tabindex']});
      document.addEventListener('focusin',()=>sample('focus'),true);
    }''')
    port(page,'shot-4','reference-in-top').focus()
    port(page,'shot-4','reference-in-top').press('Enter')
    expect(port(page,'image','reference-out-top')).to_have_attribute('data-candidate','true')
    expect(port(page,'image','sequence-out')).to_have_attribute('data-candidate','false')
    port(page,'image','reference-out-top').focus()
    focused=page.evaluate('document.activeElement?.dataset.testid')
    assert focused=='board-port-image-reference-out-top', 'Port lost focus after keyboard connection state changed: '+json.dumps(page.evaluate('window.__boardFocusTrace'))
    # Traverse the real tab order, then send the key to the actual focused port.
    for _ in range(30):
        if page.evaluate('document.activeElement?.dataset.testid')=='board-port-image-reference-out-top':break
        page.keyboard.press('Tab')
    expect(port(page,'image','reference-out-top')).to_be_focused()
    page.keyboard.press('Space')
    page.wait_for_function('window.__boardFixture.readCallbacks().connections.length === 1',timeout=3000)
    connections=page.evaluate('window.__boardFixture.readCallbacks().connections')
    assert len(connections)==1 and connections[0]['sourceId']=='image' and connections[0]['targetId']=='shot-4' and connections[0]['kind']=='reference', 'Keyboard backward callback: '+json.dumps({'connections':connections,'keys':page.evaluate('window.__boardKeyLog')})
    result['checks'].append('backward keyboard connection resolves source/target and excludes incompatible source ports')
    result['keyboardFocusTrace']=page.evaluate('window.__boardFocusObserver.disconnect();window.__boardFocusTrace')
    assert all(row['imageVisibility']=='visible' for row in result['keyboardFocusTrace']), 'Keyboard connection remeasured and hid an existing source node'
    page.reload(wait_until='networkidle');wait_ready(page)
    for motion in ['app','prop']:
        page.evaluate('value => window.__boardFixture.setMotion(value)',motion)
        expect(page.locator('[data-fixture-motion]')).to_have_attribute('data-fixture-motion',motion)
        page.wait_for_timeout(100)
        assert running_animations(page)==[],f'{motion} reduce-motion left a running infinite animation'
    page.evaluate('window.__boardFixture.setMotion("normal")')
    page.emulate_media(reduced_motion='reduce')
    page.wait_for_timeout(100)
    assert running_animations(page)==[],'system reduce-motion left a running infinite animation'
    if options.screens:page.screenshot(path=str(Path(options.screens)/'21-01-reduced-motion.png'),full_page=True)
    page.emulate_media(reduced_motion='no-preference')
    page.wait_for_timeout(100)
    assert len(running_animations(page))==7
    result['checks'].append('system, app setting and explicit prop stop all running infinite CSS animations; re-enable restores animation')
    for locale in ['en','zh-Hant','ja','zh-Hans']:
        page.evaluate('value => window.__boardFixture.setLocale(value)',locale)
        expect(page.locator('html')).to_have_attribute('lang',locale)
        assert page.locator('.board-reference-label').evaluate_all('nodes => nodes.every(node => node.textContent.trim().length>0)')
        long_duration='15 s' if locale=='en' else '15 秒'
        expect(page.get_by_test_id('board-card-film')).to_contain_text('9:16 · '+long_duration)
        expect(page.get_by_test_id('board-film-strip').locator('header')).to_contain_text(long_duration)
        expect(page.get_by_test_id('board-card-shot-1').locator('footer')).to_have_text('16:9 · 4s')
        assert page.locator('.board-film-duration').all_text_contents()==['4s','3s','3s','5s']
    result['checks'].append('four locales render role and component labels through the real provider')
    if not options.skip_performance:
        page.evaluate('window.__boardFixture.setScenario("stress")');wait_ready(page,'stress')
        expect(page.locator('[data-board-edge-kind]')).to_have_count(200)
        expect(page.locator('.board-sequence-dot')).to_have_count(100)
        visibility=page.locator('[data-board-edge-kind] .react-flow__edge-path').evaluate_all('''nodes => {
          const canvas=document.querySelector('[data-testid="board-ui-canvas"]').getBoundingClientRect();
          const bounds=nodes.map(node=>node.getBoundingClientRect());
          return {intersecting:bounds.filter(b=>b.right>=canvas.left&&b.left<=canvas.right&&b.bottom>=canvas.top&&b.top<=canvas.bottom).length,
            fullyInside:bounds.filter(b=>b.left>=canvas.left&&b.right<=canvas.right&&b.top>=canvas.top&&b.bottom<=canvas.bottom).length};
        }''')
        assert visibility['fullyInside']==200,f'Only {visibility["fullyInside"]}/200 complete edge paths fit inside the canvas'
        if options.screens:page.screenshot(path=str(Path(options.screens)/'200-edge-stress.png'),full_page=True)
        performance={'edgeCount':200,'visiblePathCount':visibility['intersecting'],'fullyInsidePathCount':visibility['fullyInside'],'sequenceDots':100,'referencePaths':100,'trials':[]}
        for motion in ['normal','app']:
            page.evaluate('value => window.__boardFixture.setMotion(value)',motion)
            page.wait_for_timeout(150)
            count=len(running_animations(page))
            assert count==(200 if motion=='normal' else 0)
            nominal=stationary_interval(page)
            for trial in range(3):
                row=drag_measurement(page,nominal)
                row.update({'motion':motion,'trial':trial+1,'stationaryMedianMs':nominal,'runningAnimations':count})
                performance['trials'].append(row)
                print(f'benchmark {motion} {trial+1}: p95={row["p95Ms"]:.2f}ms',file=sys.stderr,flush=True)
        result['performance']=performance
    assert not failures, 'Browser page errors: '+'; '.join(failures)
    assert not requests, 'Fixture made backend or external requests'
    result['checks'].append('zero backend/external requests and zero browser page errors')
    return result


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--url',required=True)
    parser.add_argument('--screens')
    parser.add_argument('--report')
    parser.add_argument('--browser')
    parser.add_argument('--skip-performance',action='store_true')
    options=parser.parse_args()
    executable=options.browser or shutil.which('chromium') or shutil.which('google-chrome')
    mac=Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    if not executable and mac.exists():executable=str(mac)
    assert executable,'A Chromium executable is required'
    with sync_playwright() as playwright:
        browser=playwright.chromium.launch(executable_path=executable,headless=True,chromium_sandbox=True)
        context=browser.new_context(viewport={'width':1440,'height':900},device_scale_factor=1,reduced_motion='no-preference')
        page=context.new_page()
        try:
            result=acceptance(page,options)
            result.update({'ok':True,'browserVersion':browser.version,'platform':platform.system(),'architecture':platform.machine(),'viewport':[1440,900]})
            result['browserEnvironment']=page.evaluate('''() => ({hardwareConcurrency:navigator.hardwareConcurrency,userAgent:navigator.userAgent})''')
            if options.report:
                Path(options.report).parent.mkdir(parents=True,exist_ok=True)
                Path(options.report).write_text(json.dumps(result,indent=2)+'\n')
            print(json.dumps(result,ensure_ascii=False))
        finally:
            context.close();browser.close()


if __name__=='__main__':
    try:main()
    except Exception as error:
        detail=str(error).replace(str(Path(__file__).resolve().parents[3]),'<repo>')
        print(json.dumps({'ok':False,'error':detail},ensure_ascii=False))
        traceback.print_exc()
        sys.exit(1)
