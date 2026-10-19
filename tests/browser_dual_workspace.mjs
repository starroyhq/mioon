/** Real own-cloud browser acceptance. Bundle with esbuild and run via CUA REPL.
 * Browser actions only use the supplied supported CUA tab. SQLite/service calls
 * are confined to disposable synthetic data and verify effects or simulate an
 * independent writer. No browser storage injection or app-state mocking.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore } from '../packages/business/src/db.ts';
import { createServices } from '../packages/business/src/services.ts';
export async function runDualWorkspaceAcceptance({tab,fixture,outDir}) {
 assert.ok(fixture.runtime.endsWith('/evidence/dual-workspace/runtime'));
 const store=openStore(path.join(fixture.runtime,'workspace'),{lock:false}),s=createServices(store,new Map(),{env:{}});
 const pid=fixture.project.id,read=()=>s.call('project.get',{projectId:pid});
 await mkdir(outDir,{recursive:true});
 const result={startedAt:new Date().toISOString(),browser:'Own-cloud Chromium through supported CUA; sandbox unchanged',projectId:pid,checks:[],screenshots:[]};
 const save=()=>writeFile(path.join(outDir,'browser-dual-workspace-report.json'),JSON.stringify(result,null,2));
 const log=async(name,details={})=>{result.checks.push({name,passed:true,...details});await save();};
 const equal=(a,b,label)=>assert.equal(JSON.stringify(a),JSON.stringify(b),label);
 async function capture(name){await writeFile(path.join(outDir,name),await tab.screenshot({fullPage:true}));result.screenshots.push(name);await save();}
 async function mode(name){await tab.playwright.getByTestId('workspace-'+name).click();await tab.getAXState({emit:false});assert.equal(await tab.playwright.getByTestId('workbench').getAttribute('data-workspace-mode'),name);}
 async function closeToast(){const close=tab.playwright.getByRole('button',{name:'关闭提示',exact:true});if(await close.isVisible())await close.click();}
 async function switchProject(name){await tab.playwright.getByTestId('project-switcher').click();await tab.playwright.getByRole('menuitem',{name,exact:true}).click();await tab.playwright.getByTestId('project-switcher').filter({hasText:name}).waitFor({state:'visible',timeoutMs:10000});await tab.getAXState({emit:false});}
 const viewport=()=>tab.playwright.locator('.react-flow__viewport').getAttribute('style');
 const selected=()=>tab.playwright.locator('.react-flow__node.selected').getAttribute('data-id');
 const scroll=()=>tab.playwright.getByTestId('timeline-scroll').evaluate(el=>({left:el.scrollLeft,top:el.scrollTop}));
 try{
  const initial=await read(),frozenVersions=structuredClone(initial.versions),frozenEdge=structuredClone(initial.edges.find(e=>e.kind==='reference'));
  await tab.playwright.getByTestId('workbench').waitFor({state:'visible',timeoutMs:15000});
  assert.equal(await tab.playwright.getByTestId('workbench').getAttribute('data-workspace-mode'),'canvas');
  assert.equal(await tab.playwright.getByTestId('timeline-panel').count(),0);assert.equal(await tab.playwright.getByTestId('central-preview').count(),0);
  assert.equal(await tab.playwright.getByRole('button',{name:'展开分镜',exact:true}).getAttribute('aria-expanded'),'false');
  assert.equal(await tab.playwright.getByTestId(`generated-badge-${fixture.versions[0].assetId}`).count(),1);
  await log('Canvas mounts only creative workspace; storyboard defaults collapsed; generated assets carry provenance');
  await tab.playwright.getByTestId(`shot-node-${fixture.shot.id}`).getByText(fixture.shot.title,{exact:true}).click();await tab.playwright.getByRole('tab',{name:'创作参数',exact:true}).click();
  await tab.playwright.getByRole('button',{name:'缩小',exact:true}).click();await tab.getAXState({emit:false});
  const canvasStyle=await viewport();assert.ok(canvasStyle?.includes('scale'));
  await capture('01-canvas-fullsize.jpg');
  await mode('editing');
  assert.equal(await tab.playwright.locator('.react-flow').count(),0);assert.equal(await tab.playwright.getByTestId('storyboard').count(),0);
  assert.equal(await tab.playwright.getByTestId('central-preview').count(),1);assert.equal(await tab.playwright.getByTestId('timeline-panel').count(),1);
  const layout=await tab.playwright.evaluate(()=>{const box=sel=>{const r=document.querySelector(sel).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};return {viewport:{width:innerWidth,height:innerHeight},timeline:box('[data-testid="timeline-panel"]'),preview:box('[data-testid="central-preview"]'),workbench:box('[data-testid="workbench"]'),bodyWidth:document.body.scrollWidth};});
  assert.ok(layout.timeline.width>=layout.viewport.width-2,JSON.stringify(layout));assert.ok(layout.preview.height>180);
  assert.ok(layout.bodyWidth<=layout.viewport.width+2,JSON.stringify(layout));
  await log('Editing mounts large preview with full-width bottom timeline and no Canvas/storyboard',{layout});
  await tab.playwright.getByTestId(`timeline-clip-${fixture.clip.id}`).click();await tab.getAXState({emit:false});
  await tab.playwright.getByTestId('timeline-playhead').fill('351');await tab.playwright.getByTestId('timeline-playhead').press('Tab');
  const slider=tab.playwright.getByRole('slider',{name:/时间线.*缩放/});await slider.press('End');await tab.getAXState({emit:false});
  assert.equal(await slider.getAttribute('aria-valuenow'),'220');
  // Use a native horizontal scroll over a fresh DOM-derived timeline coordinate.
  const scrollBox=await tab.playwright.getByTestId('timeline-scroll').evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
  await tab.scroll([scrollBox.x,scrollBox.y],'right',2);await tab.getAXState({emit:false});const editingScroll=await scroll();
  assert.ok(editingScroll.left>0,JSON.stringify(editingScroll));
  await mode('canvas');equal(await viewport(),canvasStyle,'Canvas viewport must survive workspace unmount');
  assert.equal(await tab.playwright.getByTestId('shot-title').getAttribute('value'),fixture.shot.title);
  await mode('editing');assert.equal(await tab.playwright.getByTestId(`timeline-clip-${fixture.clip.id}`).getAttribute('aria-pressed'),'true');
  assert.equal(await tab.playwright.getByTestId('timeline-playhead').getAttribute('value'),'351');assert.equal(await slider.getAttribute('aria-valuenow'),'220');equal(await scroll(),editingScroll);
  await tab.reload();await tab.playwright.getByTestId('timeline-panel').waitFor({state:'visible',timeoutMs:15000});await tab.getAXState({emit:false});
  assert.equal(await tab.playwright.getByTestId('workbench').getAttribute('data-workspace-mode'),'editing');assert.equal(await tab.playwright.getByTestId('timeline-playhead').getAttribute('value'),'351');assert.equal(await slider.getAttribute('aria-valuenow'),'220');equal(await scroll(),editingScroll);
  await log('Canvas viewport/selection and Editing clip/playhead/zoom/horizontal scroll survive switches and reload',{canvasStyle,editingScroll});
  await capture('02-editing-fullsize.jpg');
  const beforeSource=await read();await tab.playwright.getByTestId('return-to-source').click();await tab.playwright.getByTestId('highlighted-source-version').waitFor({state:'visible',timeoutMs:10000});await tab.getAXState({emit:false});
  assert.equal(await tab.playwright.getByTestId('workbench').getAttribute('data-workspace-mode'),'canvas');
  assert.equal(await tab.playwright.getByTestId(`version-card-${fixture.versions[0].id}`).getAttribute('data-source-highlighted'),'true');
  assert.ok((await tab.playwright.getByTestId(`version-card-${fixture.versions[1].id}`).getAttribute('class')).includes('chosen'));
  equal(await read(),beforeSource,'Return-to-source is read-only, including selected version and timeline history');
  await log('Return-to-source highlights exact V1 while selectedVersionId stays V2; clip asset and history unchanged');await capture('03-exact-source-version.jpg');
  await mode('editing');const originalClip=(await read()).timeline.clips.find(c=>c.id===fixture.clip.id);
  await tab.playwright.getByLabel('片段名称',{exact:true}).fill('Unsaved mode guard');await modeCancel('canvas');
  assert.equal(await tab.playwright.getByLabel('片段名称',{exact:true}).getAttribute('value'),'Unsaved mode guard');equal((await read()).timeline.clips.find(c=>c.id===fixture.clip.id),originalClip);
  await tab.playwright.getByTestId('workspace-canvas').click();await tab.playwright.getByTestId('confirm-action').click();await tab.getAXState({emit:false});assert.equal(await tab.playwright.getByTestId('workbench').getAttribute('data-workspace-mode'),'canvas');
  await mode('editing');assert.equal(await tab.playwright.getByLabel('片段名称',{exact:true}).getAttribute('value'),originalClip.name);
  await log('Dirty mode Cancel/Escape preserve draft; explicit discard changes only view and resets unsaved draft');
  await switchProject(fixture.second.name);assert.equal(await tab.playwright.getByTestId('workbench').getAttribute('data-workspace-mode'),'canvas');assert.equal(await tab.playwright.getByTestId('timeline-panel').count(),0);
  await switchProject(fixture.project.name);await tab.playwright.getByTestId('timeline-panel').waitFor({state:'visible',timeoutMs:10000});
  assert.equal(await tab.playwright.getByTestId('workbench').getAttribute('data-workspace-mode'),'editing');assert.equal(await tab.playwright.getByTestId('timeline-playhead').getAttribute('value'),'351');
  await tab.back();await tab.playwright.getByTestId('project-switcher').filter({hasText:fixture.second.name}).waitFor({state:'visible',timeoutMs:10000});
  assert.equal(await tab.playwright.getByTestId('workbench').getAttribute('data-workspace-mode'),'canvas');
  await tab.forward();await tab.playwright.getByTestId('timeline-panel').waitFor({state:'visible',timeoutMs:10000});assert.equal(await tab.playwright.getByTestId('workbench').getAttribute('data-workspace-mode'),'editing');
  await log('Projects retain independent modes and selections through menu navigation and browser Back/Forward');
  // Independent shared service edit exercises the same refresh boundary as CLI/MCP.
  await mode('canvas');await tab.playwright.getByRole('tab',{name:'创作参数',exact:true}).click();let current=await read();const edited=await s.call('shot.update',{shotId:fixture.shot.id,expectedRevision:current.shots.find(x=>x.id===fixture.shot.id).revision,patch:{title:'晨光 · 外部编辑已同步'}});
  await tab.playwright.getByTestId('shot-title').waitFor({state:'visible',timeoutMs:10000});
  // Polling UI title is observed through normal accessibility refresh.
  for(let i=0;i<20;i++){if(await tab.playwright.getByTestId('shot-title').getAttribute('value')===edited.title)break;await tab.getAXState({emit:false});}
  assert.equal(await tab.playwright.getByTestId('shot-title').getAttribute('value'),edited.title);assert.equal(await tab.playwright.getByTestId('workbench').getAttribute('data-workspace-mode'),'canvas');
  current=await read();await s.call('shot.update',{shotId:edited.id,expectedRevision:current.shots.find(x=>x.id===edited.id).revision,patch:{title:fixture.shot.title}});
  await log('Independent shared-service edit refreshes current data without forcing a workspace mode');
  await mode('canvas');await tab.playwright.getByRole('tab',{name:/版本历史/}).click();await tab.playwright.getByTestId(`version-card-${fixture.versions[0].id}`).getByRole('button',{name:'将此固定版本加入时间线',exact:true}).click();
  await tab.playwright.getByTestId('timeline-panel').waitFor({state:'visible',timeoutMs:10000});await tab.getAXState({emit:false});
  const addedState=await read();const added=addedState.timeline.clips.find(c=>!initial.timeline.clips.some(old=>old.id===c.id));assert.ok(added);assert.equal(added.assetId,fixture.versions[0].assetId);assert.equal(await tab.playwright.getByTestId(`timeline-clip-${added.id}`).getAttribute('aria-pressed'),'true');
  equal(addedState.versions,frozenVersions);equal(addedState.edges.find(e=>e.kind==='reference'),frozenEdge);assert.equal(addedState.shots.find(x=>x.id===fixture.shot.id).selectedVersionId,fixture.versions[1].id);
  await log('Explicit Add-to-Timeline bridge adds one fixed V1 clip and selects Editing without replacing V2 or references',{clipId:added.id});
  await closeToast();await capture('04-editing-fixed-bridge.jpg');
  result.result='passed';result.finishedAt=new Date().toISOString();await save();return result;
 }catch(error){result.result='failed';result.error=String(error.stack||error);try{await capture('failure.jpg');}catch{}await save();throw error;}finally{store.close();}
 async function modeCancel(target){
  for(const dismissal of ['取消','Escape']){
   await tab.playwright.getByTestId('workspace-'+target).click();await tab.playwright.getByTestId('confirm-action').waitFor({state:'visible',timeoutMs:10000});
   if(dismissal==='Escape')await tab.playwright.getByRole('button',{name:'取消',exact:true}).press('Escape');else await tab.playwright.getByRole('button',{name:'取消',exact:true}).click();
   await tab.getAXState({emit:false});assert.equal(await tab.playwright.getByTestId('workbench').getAttribute('data-workspace-mode'),'editing');
  }
 }
}
