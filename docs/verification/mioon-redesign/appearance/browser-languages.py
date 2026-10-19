import json,pathlib
from playwright.sync_api import sync_playwright
root=pathlib.Path('/private/tmp/mioon-light-v3-uf1kv1gy');meta=json.loads((root/'preview.json').read_text());out=root/'output/playwright/appearance/languages';out.mkdir(parents=True,exist_ok=True)
results={'states':[],'errors':[]};token=(pathlib.Path(meta['root'])/'access-token').read_text().strip()
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless=True)
 for locale in ['zh-Hans','zh-Hant','en','ja']:
  c=b.new_context(viewport={'width':1440,'height':900},color_scheme='light');c.add_init_script("localStorage.setItem('mioon.app-language.v1',JSON.stringify({version:1,preference:"+json.dumps(locale)+"}))")
  page=c.new_page();page.on('pageerror',lambda e:results['errors'].append(str(e)));page.goto(meta['url']+'/?project='+meta['projectId']);page.get_by_test_id('login-submit').wait_for();page.screenshot(path=str(out/f'{locale}-login.png'),animations='disabled');page.locator('#access-token').fill(token);page.get_by_test_id('login-submit').click();page.get_by_test_id('timeline-clip-'+meta['clipId']).wait_for();page.wait_for_function("()=>document.documentElement.dataset.theme==='light'");page.locator('.brand').click();page.get_by_test_id('project-home-create-toggle').wait_for()
  def select_clip_if_needed():
   clip=page.get_by_test_id('timeline-clip-'+meta['clipId'])
   if clip.get_attribute('aria-pressed')!='true':
    clip.click()
  def capture(state,width,height,dialog=None):
   page.screenshot(path=str(out/f'{locale}-{width}-{state}.png'),animations='disabled')
   metric=page.evaluate('''()=>({width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,lang:document.documentElement.lang,theme:document.documentElement.dataset.theme})''');metric['state']=state
   assert metric['scroll']<=width+1 and metric['theme']=='light',metric
   if dialog:
    r=dialog.bounding_box();assert r and r['x']>=-1 and r['y']>=-1 and r['x']+r['width']<=width+1 and r['y']+r['height']<=height+1,(state,r);metric['dialog']=r
   results['states'].append(metric)
  for width,height in [(1440,900),(1050,680)]:
   page.set_viewport_size({'width':width,'height':height});capture('home',width,height)
   page.get_by_test_id('project-home-create-toggle').click();page.get_by_test_id('project-home-create-form').wait_for();capture('new-project',width,height,page.locator('[role=dialog]:visible'));page.get_by_test_id('project-home-create-cancel').click()
  page.get_by_test_id('project-home-open-'+meta['projectId']).click();page.get_by_test_id('workspace-editing').wait_for()
  for width,height in [(1440,900),(1050,680)]:
   page.set_viewport_size({'width':width,'height':height});page.get_by_test_id('workspace-canvas').click();capture('canvas',width,height);page.get_by_test_id('workspace-editing').click();select_clip_if_needed();page.get_by_test_id('clip-inspector').wait_for(state='attached');page.wait_for_function('(id)=>document.querySelector("[data-testid=timeline-clip-"+id+"]")?.getAttribute("aria-pressed")=="true"',arg=meta['clipId']);capture('editing',width,height);page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
   page.get_by_test_id('jobs-button').click();page.get_by_test_id('task-overview-all').wait_for();capture('task-popover',width,height);page.get_by_test_id('task-overview-all').click();capture('tasks',width,height,page.locator('[role=dialog]:visible'));page.keyboard.press('Escape')
   page.get_by_test_id('global-settings-open').click();dialog=page.get_by_test_id('web-settings-dialog');dialog.wait_for(state='visible')
   for category in ['general','workspace','video-tools','models','agent','extensions','shortcuts','about']:
    page.get_by_test_id('settings-category-'+category).click();page.wait_for_function('(category)=>document.querySelector("[data-testid=settings-center]")?.dataset.page===category',arg=category);capture('settings-'+category,width,height,dialog)
   page.get_by_test_id('settings-center-close').click();page.get_by_test_id('export-timeline').click();capture('export',width,height,page.get_by_test_id('timeline-export-dialog'));page.keyboard.press('Escape')
  c.close()
 b.close()
assert not results['errors'],results['errors'];(root/'four-languages-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2));print(json.dumps({'states':len(results['states']),'errors':results['errors']}))
