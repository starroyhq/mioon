"""Actual Chromium user-flow and MCP-result visual evidence; no UI state mocks."""
import json, os, pathlib, shutil, socket, subprocess, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright, expect
ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'evidence'/'v2-before';OUT.mkdir(parents=True,exist_ok=True)
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
    close=page.get_by_role('button',name='关闭生成任务')
    if close.is_visible():close.click()
    page.get_by_test_id('storyboard-shot-'+shot['id']).locator('.storyboard-preview').click();expect(page.get_by_test_id('shot-title')).to_have_value(shot['title'])
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=shutil.which('chromium'),headless=True)
    manifest=json.loads((ROOT/'evidence/demo.json').read_text())
    proc,handle,base=start(ROOT/'examples/demo-project')
    try:
        context=browser.new_context(viewport={'width':1600,'height':1000})
        page=context.new_page(); login(page,base,manifest['projectId'])
        page.get_by_test_id('fit-canvas').click(); page.wait_for_timeout(700)
        screenshot(page,'01-current-workbench.png')
        (OUT/'visible-text.txt').write_text(page.locator('body').inner_text())
        context.close()
    finally:stop(proc,handle)
    browser.close()
print('CAPTURED baseline')
