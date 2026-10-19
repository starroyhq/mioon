from pathlib import Path
import json,re
from playwright.sync_api import sync_playwright
root=Path('/private/tmp/mioon-copy-punctuation-qg9xp0pw');meta=json.loads((root/'preview.json').read_text());out=root/'browser';out.mkdir(exist_ok=True)
expected={'zh-Hans':'全局设置独立于项目。片段属性和导出选项仍在各自的工作区','zh-Hant':'全域設定獨立於專案。片段屬性和匯出選項仍在各自的工作區','en':'Global settings are separate from projects. Clip properties and export options stay in their workspaces','ja':'全体設定はプロジェクトとは別に管理されます。クリップのプロパティと書き出し設定は各作業画面にあります'}
r={'states':[],'errors':[],'externalRequests':[]}
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless=True)
 for locale in expected:
  c=b.new_context(viewport={'width':1440,'height':900},color_scheme='light');c.add_init_script("localStorage.setItem('mioon.app-language.v1',JSON.stringify({version:1,preference:"+json.dumps(locale)+"}))");page=c.new_page();page.on('pageerror',lambda e:r['errors'].append(str(e)));page.on('request',lambda req:r['externalRequests'].append(req.url) if req.url.startswith(('https://','http://')) and not req.url.startswith(meta['url']) else None)
  page.goto(meta['url']+'/?project='+meta['projectId']);page.locator('#access-token').fill((Path(meta['root'])/'access-token').read_text().strip());page.get_by_test_id('login-submit').click();page.get_by_test_id('workspace-canvas').wait_for();page.get_by_test_id('global-settings-open').click();dialog=page.get_by_test_id('web-settings-dialog');dialog.wait_for();page.get_by_text(expected[locale],exact=True).wait_for()
  if locale=='zh-Hans':
   page.get_by_test_id('appearance-theme').click();page.get_by_role('listbox').get_by_role('option',name='浅色',exact=True).click();page.get_by_test_id('appearance-save').click();page.wait_for_function("()=>document.querySelector('[data-testid=appearance-save]').disabled")
  page.wait_for_function("()=>document.documentElement.dataset.theme==='light'")
  for w,h in [(1440,900),(1050,680)]:
   page.set_viewport_size({'width':w,'height':h});texts=dialog.locator('p:visible').all_text_contents();assert all(not re.search(r'(?<!\.)[。.]$',text.strip()) for text in texts),texts;assert page.evaluate('document.documentElement.scrollWidth')<=w+1;page.screenshot(path=str(out/f'{locale}-{w}-settings.png'),animations='disabled');r['states'].append({'locale':locale,'width':w,'height':h,'scope':expected[locale],'paragraphs':texts})
  c.close()
 b.close()
assert not r['errors'] and not r['externalRequests'],r
(out/'results.json').write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'states':len(r['states']),'pageErrors':r['errors'],'externalRequests':r['externalRequests']}))
