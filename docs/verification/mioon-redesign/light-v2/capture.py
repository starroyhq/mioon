import json,pathlib,hashlib
from playwright.sync_api import sync_playwright
root=pathlib.Path('/private/tmp/mioon-light-v2-81z_mlwk');repo=pathlib.Path('/Users/kouzen/.codex/worktrees/mioon-redesign/mioon');meta=json.loads((root/'preview.json').read_text());out=root/'output/playwright/light-v2';out.mkdir(parents=True,exist_ok=True)
css=(repo/'packages/ui/src/styles/light-preview.css').read_text();results={'scope':'Isolated second light candidate after user rejected v1 as high contrast; no production preference activation.','url':meta['url'],'candidateStyleSource':'compiled development build; only isolated preview class activated','runtimeStyleInjection':False,'cssSha256':hashlib.sha256(css.encode()).hexdigest(),'states':[],'checks':[],'pageErrors':[],'externalRequests':[]}
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless=True)
 c=b.new_context(viewport={'width':1440,'height':900},color_scheme='light');c.add_init_script("localStorage.setItem('mioon.app-language.v1',JSON.stringify({version:1,preference:'zh-Hans'}))")
 page=c.new_page();page.on('pageerror',lambda e:results['pageErrors'].append(str(e)))
 page.on('request',lambda r:results['externalRequests'].append(r.url) if r.url.startswith(('http://','https://')) and not r.url.startswith(meta['url']) else None)
 page.goto(meta['url']+'/?project='+meta['projectId']);page.locator('#access-token').fill((pathlib.Path(meta['root'])/'access-token').read_text().strip());page.get_by_test_id('login-submit').click();page.get_by_test_id('workspace-editing').click();page.get_by_test_id('timeline-clip-'+meta['clipId']).click();page.wait_for_function("()=>document.querySelector('[data-testid^=timeline-clip-][aria-pressed=true]')!==null")
 page.get_by_test_id('clip-inspector').wait_for(state='attached')
 page.evaluate('''async()=>{const {data}=await(await fetch('/api/ui-preferences')).json();const r=await fetch('/api/ui-preferences',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRevision:data.revision,requestId:crypto.randomUUID(),preferences:{...data.preferences,theme:'system',scalePercent:100}})});if(!r.ok)throw Error('prefs rejected');await window.__mioonUiPreferences.reload()}''')
 def root_state():return page.evaluate("()=>({systemLight:matchMedia('(prefers-color-scheme: light)').matches,productionTheme:document.documentElement.dataset.theme,appearance:document.documentElement.dataset.appearance,previewClass:document.documentElement.classList.contains('mioon-light-preview'),panel:getComputedStyle(document.documentElement).getPropertyValue('--wb-panel').trim()})")
 before=root_state();assert before['systemLight'] and before['productionTheme']=='dark' and before['appearance']=='system' and not before['previewClass'];results['before']=before
 page.screenshot(path=str(out/'production-system-light-remains-dark.png'),animations='disabled')
 page.evaluate("document.documentElement.classList.add('mioon-light-preview')")
 for width,height in [(1440,900),(1050,680)]:
  page.set_viewport_size({'width':width,'height':height});page.wait_for_function('(compact)=>document.querySelector(".workbench").dataset.compact===String(compact)',arg=width<1150)
  if width==1050 and page.get_by_test_id('reopen-inspector').is_visible():page.get_by_test_id('reopen-inspector').click()
  page.screenshot(path=str(out/f'editing-{width}.png'),animations='disabled')
  metrics=page.evaluate('''()=>{const d=document.documentElement,sel=s=>document.querySelector(s),r=e=>{if(!e)return null;const b=e.getBoundingClientRect(),c=getComputedStyle(e);return{width:b.width,height:b.height,color:c.color,background:c.backgroundColor,border:c.borderColor}};return{docWidth:d.scrollWidth,viewport:innerWidth,panel:r(sel('.dock-panel')),track:r(sel('.track-lane')),mediaLabel:r(sel('.timeline-clip .clip-copy>strong')),tokens:Object.fromEntries(['bg','panel','card','raised','line','line-subtle','text','soft','muted','accent'].map(k=>[k,getComputedStyle(d).getPropertyValue('--wb-'+k).trim()]))}}''');assert metrics['docWidth']<=width,metrics;results['states'].append({'state':'editing','width':width,'height':height,**metrics})
  page.get_by_test_id('global-settings-open').click();dialog=page.get_by_test_id('web-settings-dialog');dialog.wait_for();page.screenshot(path=str(out/f'settings-{width}.png'),animations='disabled');bounds=dialog.bounding_box();assert bounds['x']>=0 and bounds['y']>=0 and bounds['x']+bounds['width']<=width+1 and bounds['y']+bounds['height']<=height+1,bounds
  results['states'].append({'state':'settings','width':width,'height':height,'dialog':bounds})
  # A real keyboard focus must remain visible on the light candidate.
  page.get_by_test_id('settings-center-close').focus();page.keyboard.press('Tab');page.keyboard.press('Shift+Tab');focus=page.get_by_test_id('settings-center-close').evaluate('e=>({outline:getComputedStyle(e).outlineStyle,outlineWidth:getComputedStyle(e).outlineWidth})');assert focus['outline']!='none' and float(focus['outlineWidth'].replace('px',''))>=1,focus
  page.keyboard.press('Escape');dialog.wait_for(state='hidden')
 page.set_viewport_size({'width':1440,'height':900});page.evaluate("document.documentElement.classList.remove('mioon-light-preview')");after=root_state();assert not after['previewClass'] and after['panel']==before['panel'] and after['productionTheme']=='dark';results['after']=after
 results['checks']=['system-light-remains-production-dark','two-sizes-editing-and-settings-no-overflow','keyboard-focus-visible','candidate-removal-restores-original-theme','no-external-requests']
 assert not results['pageErrors'] and not results['externalRequests'],results
 b.close()
(out/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'states':len(results['states']),'checks':results['checks'],'pageErrors':results['pageErrors'],'externalRequests':results['externalRequests']}))
