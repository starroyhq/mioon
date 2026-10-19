import json,pathlib,time,traceback
from playwright.sync_api import sync_playwright
root=pathlib.Path('/private/tmp/mioon-light-v3-uf1kv1gy');meta=json.loads((root/'preview.json').read_text());out=root/'output/playwright/task-popover-diagnostic-exact';out.mkdir(parents=True,exist_ok=True)
token=(pathlib.Path(meta['root'])/'access-token').read_text().strip();results={'stages':[],'errors':[],'requests':[]}
probe=r'''(()=>{window.__taskProbe=[];const log=(kind,data)=>window.__taskProbe.push({at:performance.now(),kind,...data});const target=e=>e?.closest?.('[data-testid]')?.getAttribute('data-testid')||e?.tagName||null;
for(const type of ['focusin','focusout','pointerdown','pointerup','click'])document.addEventListener(type,e=>log(type,{target:target(e.target),related:target(e.relatedTarget)}),true);
for(const type of ['focus','blur'])window.addEventListener(type,()=>log('window-'+type,{}));
const original=HTMLElement.prototype.focus;HTMLElement.prototype.focus=function(...args){log('focus-call',{target:target(this),stack:new Error().stack?.split('\n').slice(1,7)});return original.apply(this,args)};
window.__taskSnapshot=()=>{const trigger=document.querySelector('[data-testid=jobs-button]');let f=trigger&&trigger[Object.keys(trigger).find(k=>k.startsWith('__reactFiber$'))];let owner=null;while(f){const p=f.memoizedProps;if(p&&typeof p.scope==='string'&&'onOpenTasks'in p){let h=f.memoizedState;const hooks=[];for(let n=0;h&&n<8;n++,h=h.next){const v=h.memoizedState;if(typeof v==='boolean'||v===null)hooks.push(v);else if(v&&typeof v==='object'&&'current'in v)hooks.push({current:v.current&&typeof v.current==='object'?{scope:v.current.scope,visible:v.current.visible}:v.current});else if(Array.isArray(v)&&v[0]&&typeof v[0]==='object'&&'scope'in v[0])hooks.push({token:v[0]})}owner={scope:p.scope,visible:p.visible,hooks};break}f=f.return}const popup=document.querySelector('.task-overview');const button=document.querySelector('[data-testid=task-overview-all]');const rect=button?.getBoundingClientRect();return{owner,expanded:trigger?.getAttribute('aria-expanded'),popup:!!popup,button:!!button,active:target(document.activeElement),buttonRect:rect&&{x:rect.x,y:rect.y,width:rect.width,height:rect.height},hit:rect?target(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)):null,theme:document.documentElement.dataset.theme,compact:document.querySelector('.dock-workbench')?.dataset.compact}};
let previous='';setInterval(()=>{const state=window.__taskSnapshot();const next=JSON.stringify(state);if(next!==previous){previous=next;log('state',state)}},10)})();'''
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless=True)
 c=b.new_context(viewport={'width':1440,'height':900},color_scheme='light');c.add_init_script("localStorage.setItem('mioon.app-language.v1',JSON.stringify({version:1,preference:'en'}))");c.add_init_script(probe)
 page=c.new_page();page.set_default_timeout(7000);page.on('pageerror',lambda e:results['errors'].append(str(e)))
 def request(req):
  path=req.url.split('?',1)[0].replace(meta['url'],'')
  if '/api/' in path:results['requests'].append({'at':time.monotonic(),'method':req.method,'path':path})
 page.on('request',request)
 def stage(name):
  s=page.evaluate('()=>window.__taskSnapshot?.()');results['stages'].append({'name':name,'state':s})
 def capture(name):
  page.screenshot(path=str(out/(name+'.png')),animations='disabled');metric=page.evaluate('()=>({width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,lang:document.documentElement.lang,theme:document.documentElement.dataset.theme})');assert metric['scroll']<=metric['width']+1 and metric['theme']=='light'
 try:
  page.goto(meta['url']+'/?project='+meta['projectId']);page.get_by_test_id('login-submit').wait_for();page.locator('#access-token').fill(token);page.get_by_test_id('login-submit').click();page.get_by_test_id('timeline-clip-'+meta['clipId']).wait_for();page.wait_for_function("()=>document.documentElement.dataset.theme==='light'");page.locator('.brand').click();page.get_by_test_id('project-home-create-toggle').wait_for()
  for width,height in [(1440,900),(1050,680)]:
   page.set_viewport_size({'width':width,'height':height});capture(str(width)+'-home');page.get_by_test_id('project-home-create-toggle').click();page.get_by_test_id('project-home-create-form').wait_for();capture(str(width)+'-new-project');page.get_by_test_id('project-home-create-cancel').click()
  page.get_by_test_id('project-home-open-'+meta['projectId']).click();page.get_by_test_id('workspace-editing').wait_for()
  for width,height in [(1440,900),(1050,680)]:
   page.set_viewport_size({'width':width,'height':height});page.get_by_test_id('workspace-canvas').click();capture(str(width)+'-canvas');page.get_by_test_id('workspace-editing').click();page.get_by_test_id('timeline-clip-'+meta['clipId']).click();page.get_by_test_id('clip-inspector').wait_for(state='attached');page.wait_for_function('(id)=>document.querySelector("[data-testid=timeline-clip-"+id+"]")?.getAttribute("aria-pressed")=="true"',arg=meta['clipId']);capture(str(width)+'-editing');page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
   page.get_by_test_id('jobs-button').click();page.get_by_test_id('task-overview-all').wait_for();capture(str(width)+'-task-popover');page.get_by_test_id('task-overview-all').click();capture(str(width)+'-tasks');page.locator('[role=dialog]:visible').bounding_box();page.keyboard.press('Escape')
   if width==1050:break
   page.get_by_test_id('global-settings-open').click();page.get_by_test_id('web-settings-dialog').wait_for(state='visible')
   for category in ['general','workspace','video-tools','models','agent','extensions','shortcuts','about']:
    page.get_by_test_id('settings-category-'+category).click();page.wait_for_function('(category)=>document.querySelector("[data-testid=settings-center]")?.dataset.page===category',arg=category);capture(str(width)+'-settings-'+category);page.get_by_test_id('web-settings-dialog').bounding_box()
   page.get_by_test_id('settings-center-close').click();page.get_by_test_id('export-timeline').click();capture(str(width)+'-export');page.get_by_test_id('timeline-export-dialog').bounding_box();page.keyboard.press('Escape')
  results['passed']=True
 except Exception as e:
  results['passed']=False;results['exception']=str(e);stage('failure');page.screenshot(path=str(out/'failure.png'),animations='disabled')
 finally:
  results['probe']=page.evaluate('()=>window.__taskProbe');(out/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2));print(json.dumps({'passed':results.get('passed'),'exception':results.get('exception'),'stages':results['stages'][-5:],'errors':results['errors']}));c.close();b.close()
