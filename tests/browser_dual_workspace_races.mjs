import { clickWorkbenchAction } from './browser-workbench-actions.mjs';
/** Browser-only UI through CUA; explicit local fault fixture loses/holds actual
 * accepted backend responses. No fake domain data, paid calls or browser eval writes. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
const equal=(a,b,message)=>assert.equal(JSON.stringify(a),JSON.stringify(b),message);
export async function runDualWorkspaceRaceAcceptance({tab,fixture,outDir}){
 const runtime=fixture.runtime;assert.ok(runtime.endsWith('/evidence/dual-workspace/runtime'));
 const store=openStore(path.join(runtime,'workspace'),{lock:false}),s=createServices(store,new Map(),{env:{}}),pid=fixture.project.id;
 const read=()=>s.call('project.get',{projectId:pid}),history=()=>s.call('timeline.history.get',{projectId:pid});
 await mkdir(outDir,{recursive:true});const result={startedAt:new Date().toISOString(),checks:[],screenshots:[],browser:'Supported own-cloud CUA + actual accepted HTTP response faults'};
 const save=()=>writeFile(path.join(outDir,'browser-races-report.json'),JSON.stringify(result,null,2));
 const log=async(name,details={})=>{result.checks.push({name,passed:true,...details});await save();};
 const capture=async name=>{await writeFile(path.join(outDir,name),await tab.screenshot({fullPage:true}));result.screenshots.push(name);await save();};
 async function mode(name){await tab.playwright.getByTestId('workspace-'+name).click();await tab.getAXState({emit:false});assert.equal(await tab.playwright.getByTestId('workbench').getAttribute('data-workspace-mode'),name);}
 async function closeOverlays(){for(const name of ['关闭生成任务','关闭提示']){const control=tab.playwright.getByRole('button',{name,exact:true});if(await control.isVisible())await control.click();}await tab.getAXState({emit:false});}
 async function project(name){await tab.playwright.getByTestId('project-switcher').click();await tab.playwright.getByRole('menuitem',{name,exact:true}).click();await tab.playwright.getByTestId('project-switcher').filter({hasText:name}).waitFor({state:'visible',timeoutMs:10000});await tab.getAXState({emit:false});}
 async function fault(operation,kind){try{await unlink(path.join(runtime,'fault-release'));}catch{}await writeFile(path.join(runtime,'fault.json'),JSON.stringify({operation,kind}));}
 const release=()=>writeFile(path.join(runtime,'fault-release'),'release');
 async function waitState(predicate){for(let i=0;i<50;i++){const data=await read();if(predicate(data))return data;await tab.getAXState({emit:false});}throw Error('Persisted QA state did not reach expected result');}
 try{
  await closeOverlays();await mode('editing');await tab.playwright.getByTestId(`timeline-clip-${fixture.clip.id}`).click();
  await tab.playwright.getByTestId('timeline-playhead').fill('29');await tab.playwright.getByTestId('timeline-playhead').press('Tab');await mode('canvas');await mode('editing');
  assert.equal(await tab.playwright.getByTestId('timeline-playhead').getAttribute('value'),'29');await tab.reload();await tab.playwright.getByTestId('timeline-playhead').waitFor({state:'visible',timeoutMs:15000});await tab.getAXState({emit:false});
  assert.equal(await tab.playwright.getByTestId('timeline-playhead').getAttribute('value'),'29');await log('A paused source preview cannot clamp a saved playhead outside the selected clip during switch/reload');
  await mode('canvas');const beforeKey=await read();await tab.playwright.getByRole('button',{name:'缩小',exact:true}).press('Control+z');equal((await read()).timeline,beforeKey.timeline);equal((await read()).timelineHistory,beforeKey.timelineHistory);await log('Canvas Ctrl+Z leaves durable timeline and history untouched');
  await mode('editing');const beforeDrop=await read(),beforeDropHistory=await history();await fault('timeline.track.add','drop');await tab.playwright.getByTestId('add-video-track').click();
  await tab.playwright.getByTestId('resume-pending').waitFor({state:'visible',timeoutMs:10000});await closeOverlays();
  const dropped=await waitState(data=>data.timeline.tracks.length===beforeDrop.timeline.tracks.length+1);assert.equal(dropped.timeline.revision,beforeDrop.timeline.revision+1);
  await mode('canvas');await project(fixture.second.name);await clickWorkbenchAction(tab, 'jobs-button');assert.equal(await tab.playwright.getByTestId('resume-pending').count(),0);await closeOverlays();
  await project(fixture.project.name);assert.equal(await tab.playwright.getByTestId('workbench').getAttribute('data-workspace-mode'),'canvas');await clickWorkbenchAction(tab, 'jobs-button');await tab.playwright.getByTestId('resume-pending').waitFor({state:'visible',timeoutMs:10000});await capture('05-lost-response-project-recovery.jpg');
  await tab.playwright.getByTestId('resume-pending').click();await tab.playwright.getByTestId('resume-pending').waitFor({state:'detached',timeoutMs:10000});await closeOverlays();
  const recovered=await read();equal(recovered.timeline,dropped.timeline);assert.equal((await history()).length,beforeDropHistory.length+1);assert.equal(await tab.playwright.getByTestId('workbench').getAttribute('data-workspace-mode'),'canvas');
  await log('Lost accepted timeline response survives mode/project switches; other project has no pending record; exact replay neither duplicates nor navigates',{revision:recovered.timeline.revision});
  await mode('canvas');await tab.playwright.getByTestId(`shot-node-${fixture.shot.id}`).getByText(fixture.shot.title,{exact:true}).click();await tab.playwright.getByRole('tab',{name:'创作参数',exact:true}).click();
  const beforeSave=await read(), firstDraft='First accepted save '+Date.now(), generateDraft='Saved without obsolete generation '+Date.now();await tab.playwright.getByTestId('shot-prompt').fill(firstDraft);await fault('shot.update','hold');await tab.playwright.getByTestId('save-shot').click();
  await waitState(data=>data.shots.find(x=>x.id===fixture.shot.id).prompt===firstDraft);
  await tab.playwright.getByTestId('shot-prompt').fill('Newer draft typed while save response is delayed');await release();
  await tab.getAXState({emit:false});await tab.playwright.getByRole('button',{name:'放弃修改',exact:true}).waitFor({state:'visible',timeoutMs:10000});
  assert.equal(await tab.playwright.getByTestId('shot-prompt').evaluate(el=>el.value),'Newer draft typed while save response is delayed');assert.equal((await read()).shots.find(x=>x.id===fixture.shot.id).prompt,firstDraft);
  await log('A delayed save acknowledgement preserves newer Inspector draft text');await tab.playwright.getByRole('button',{name:'放弃修改',exact:true}).click();
  await tab.playwright.getByTestId('shot-prompt').fill(generateDraft);await fault('shot.update','hold');await tab.playwright.getByTestId('generate-shot').click();
  await waitState(data=>data.shots.find(x=>x.id===fixture.shot.id).prompt===generateDraft);
  await tab.playwright.getByTestId('workspace-editing').click();await tab.playwright.getByTestId('confirm-action').click();await tab.getAXState({emit:false});assert.equal(await tab.playwright.getByTestId('workbench').getAttribute('data-workspace-mode'),'editing');await release();
  await tab.getAXState({emit:false});equal((await read()).jobs,beforeSave.jobs);assert.equal(await tab.playwright.getByTestId('workbench').getAttribute('data-workspace-mode'),'editing');
  await log('Discarding and switching during held save-and-generate prevents the obsolete generation continuation');
  await mode('canvas');await tab.playwright.getByRole('tab',{name:/版本历史/}).click();const beforeLate=await read();await fault('timeline.clip.add','hold');await tab.playwright.getByTestId(`version-card-${fixture.versions[0].id}`).getByRole('button',{name:'将此固定版本加入时间线',exact:true}).click();
  const acceptedLate=await waitState(data=>data.timeline.clips.length===beforeLate.timeline.clips.length+1);await project(fixture.second.name);await release();await tab.getAXState({emit:false});
  assert.ok((await tab.playwright.getByTestId('project-switcher').innerText()).includes(fixture.second.name));assert.equal(await tab.playwright.getByTestId('workbench').getAttribute('data-workspace-mode'),'canvas');
  await project(fixture.project.name);assert.equal(await tab.playwright.getByTestId('workbench').getAttribute('data-workspace-mode'),'canvas');equal((await read()).timeline,acceptedLate.timeline);
  await log('Late Add-to-Timeline completion never hijacks another project or its mode; original project retains accepted clip');
  await tab.playwright.getByRole('tab',{name:'创作参数',exact:true}).click();await tab.playwright.getByTestId('shot-prompt').fill('Back navigation must keep this draft when cancelled');await tab.back();await tab.playwright.getByTestId('confirm-action').waitFor({state:'visible',timeoutMs:10000});await tab.playwright.getByRole('button',{name:'取消',exact:true}).click();await tab.getAXState({emit:false});
  assert.ok((await tab.url()).includes(pid));assert.equal(await tab.playwright.getByTestId('shot-prompt').evaluate(el=>el.value),'Back navigation must keep this draft when cancelled');await tab.playwright.getByRole('button',{name:'放弃修改',exact:true}).click();await log('Cancelling dirty browser Back restores current project URL and keeps the exact draft');
  await mode('editing');await tab.playwright.getByTestId(`timeline-clip-${fixture.clip.id}`).click();await tab.playwright.getByLabel('片段名称',{exact:true}).fill('Accepted clip save');await fault('timeline.clip.update','hold');await tab.playwright.getByTestId('save-clip').click();
  await waitState(data=>data.timeline.clips.find(x=>x.id===fixture.clip.id).name==='Accepted clip save');await tab.playwright.getByLabel('片段名称',{exact:true}).fill('Newer clip draft');await release();await tab.getAXState({emit:false});
  assert.equal(await tab.playwright.getByLabel('片段名称',{exact:true}).getAttribute('value'),'Newer clip draft');await tab.playwright.getByRole('button',{name:'放弃修改',exact:true}).click();await log('A delayed TimelineInspector acknowledgement also preserves newer unsaved clip text');
  // Generation and typed-reference pending use the same durable log. A real
  // accepted typed detach is replayed while Canvas navigation stays independent.
  await mode('canvas');await tab.playwright.getByRole('tab',{name:'创作参数',exact:true}).click();const beforeReference=await read();await fault('reference.detach','drop');await tab.playwright.getByTestId('detach-reference').click();await tab.playwright.getByTestId('confirm-action').click();await closeOverlays();
  await mode('editing');await mode('canvas');await clickWorkbenchAction(tab, 'jobs-button');await tab.playwright.getByTestId('resume-pending').waitFor({state:'visible',timeoutMs:10000});await tab.playwright.getByTestId('resume-pending').click();await tab.playwright.getByTestId('resume-pending').waitFor({state:'detached',timeoutMs:10000});await closeOverlays();
  const afterReference=await read();assert.equal(afterReference.edges.some(e=>e.id===fixture.edge.edge?.id||e.id===beforeReference.edges.find(e=>e.kind==='reference')?.id),false);equal(afterReference.versions,beforeReference.versions);equal(afterReference.timeline,beforeReference.timeline);
  await log('A lost typed-reference response also survives mode switches and exact recovery without touching immutable versions or timeline');
  await capture('06-race-safe-canvas.jpg');result.result='passed';result.finishedAt=new Date().toISOString();await save();return result;
 }catch(error){result.result='failed';result.error=String(error.stack||error);try{await release();await capture('races-failure.jpg');}catch{}await save();throw error;}finally{store.close();}
}
