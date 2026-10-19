import pathlib,json
from playwright.sync_api import sync_playwright
root=pathlib.Path('/private/tmp/mioon-light-v3-uf1kv1gy');m=json.loads((root/'preview.json').read_text());out=root/'output/playwright/appearance';out.mkdir(parents=True,exist_ok=True)
r={'checks':[],'pageErrors':[],'externalRequests':[],'preferenceWrites':0,'states':[],'runtimeStyleInjection':False}
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless=True)
 c=b.new_context(viewport={'width':1440,'height':900},color_scheme='light');c.add_init_script("localStorage.setItem('mioon.app-language.v1',JSON.stringify({version:1,preference:'zh-Hans'}))")
 page=c.new_page();page.on('pageerror',lambda e:r['pageErrors'].append(str(e)))
 def request(req):
  if req.url.startswith(('http://','https://')) and not req.url.startswith(m['url']):r['externalRequests'].append(req.url)
  if req.url.endswith('/api/ui-preferences') and req.method=='PUT':r['preferenceWrites']+=1
 page.on('request',request);page.goto(m['url']+'/?project='+m['projectId']);page.locator('#access-token').fill((pathlib.Path(m['root'])/'access-token').read_text().strip());page.get_by_test_id('login-submit').click();page.get_by_test_id('workspace-canvas').wait_for();page.wait_for_function("()=>['light','dark','system'].includes(document.documentElement.dataset.appearance)")
 def state():return page.evaluate("()=>({theme:document.documentElement.dataset.theme,appearance:document.documentElement.dataset.appearance,dark:document.documentElement.classList.contains('dark'),light:document.documentElement.classList.contains('light'),flow:[...document.querySelectorAll('.react-flow')].map(e=>({dark:e.classList.contains('dark'),light:e.classList.contains('light')})),mediaOverlay:getComputedStyle(document.documentElement).getPropertyValue('--wb-media-overlay').trim()})")
 def expect(theme,appearance):
  page.wait_for_function('(v)=>document.documentElement.dataset.theme===v[0]&&document.documentElement.dataset.appearance===v[1]',arg=[theme,appearance]);s=state();assert s['dark'] != s['light'] and s['theme']==theme,s
  if s['flow']:assert all(f[theme] and not f['dark' if theme=='light' else 'light'] for f in s['flow']),s
  r['states'].append(s);return s
 def open_settings():page.get_by_test_id('global-settings-open').click();page.get_by_test_id('web-settings-dialog').wait_for();page.wait_for_function("()=>!document.querySelector('[data-testid=appearance-theme]').disabled")
 def select_theme(theme):
  page.get_by_test_id('appearance-theme').click();page.get_by_role('listbox').wait_for();page.get_by_role('listbox').get_by_role('option',name={'dark':'深色','light':'浅色','system':'跟随系统'}[theme],exact=True).click()
 def choose(theme):
  open_settings();select_theme(theme)
  if page.get_by_test_id('appearance-save').is_enabled():
   with page.expect_response(lambda x:x.url.endswith('/api/ui-preferences') and x.request.method=='PUT') as response:page.get_by_test_id('appearance-save').click()
   assert response.value.status==200;page.wait_for_function("()=>document.querySelector('[data-testid=appearance-save]').disabled")
  page.get_by_test_id('settings-center-close').click()
 choose('system');expect('light','system');r['checks'].append('saved-system-resolves-real-light-os-and-flow')
 choose('light');expect('light','light');page.screenshot(path=str(out/'canvas-light.png'),animations='disabled');page.emulate_media(color_scheme='dark');expect('light','light');r['checks'].append('explicit-light-ignores-dark-os')
 page.reload();page.get_by_test_id('workspace-canvas').wait_for();expect('light','light');r['checks'].append('saved-light-survives-reload')
 choose('system');expect('dark','system');writes=r['preferenceWrites'];page.emulate_media(color_scheme='light');expect('light','system');page.emulate_media(color_scheme='dark');expect('dark','system');assert r['preferenceWrites']==writes;r['checks'].append('live-system-light-dark-without-writes')
 choose('dark');page.emulate_media(color_scheme='light');expect('dark','dark');page.screenshot(path=str(out/'canvas-dark.png'),animations='disabled');r['checks'].append('explicit-dark-ignores-light-os')
 open_settings();writes=r['preferenceWrites'];select_theme('light');expect('light','light');page.locator('.settings-appearance-actions').get_by_role('button',name='放弃',exact=True).click();expect('dark','dark');assert r['preferenceWrites']==writes;page.get_by_test_id('settings-center-close').click();r['checks'].append('draft-theme-previews-and-discard-restores-without-write')
 choose('light');expect('light','light');page.get_by_test_id('workspace-editing').click();page.get_by_test_id('timeline-clip-'+m['clipId']).click();page.screenshot(path=str(out/'editing-light-1440.png'),animations='disabled');open_settings();page.screenshot(path=str(out/'settings-light-1440.png'),animations='disabled');page.get_by_test_id('settings-center-close').click();r['checks'].append('production-light-editing-and-settings')
 choose('system');expect('light','system');page.reload();page.get_by_test_id('workspace-editing').wait_for();expect('light','system');r['checks'].append('saved-system-survives-reload')
 assert not r['pageErrors'] and not r['externalRequests'];b.close()
(out/'results.json').write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'checks':r['checks'],'errors':r['pageErrors'],'externalRequests':r['externalRequests'],'writes':r['preferenceWrites']}))
