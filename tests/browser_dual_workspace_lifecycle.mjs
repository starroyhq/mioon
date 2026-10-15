import { clickWorkbenchAction } from './browser-workbench-actions.mjs';
import assert from 'node:assert/strict';
import {readFile,writeFile,unlink,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
const equal=(a,b)=>assert.equal(JSON.stringify(a),JSON.stringify(b));
export async function runLifecycleBrowserAcceptance({tab,fixture,outDir}){
 const runtime=fixture.runtime;assert.ok(runtime.endsWith('/evidence/dual-workspace/runtime'));
 const store=openStore(runtime+'/workspace',{lock:false}),s=createServices(store,new Map(),{env:{}}),read=()=>s.call('project.get',{projectId:fixture.project.id});
 await mkdir(outDir,{recursive:true});const result={checks:[],startedAt:new Date().toISOString()};
 const save=()=>writeFile(path.join(outDir,'browser-lifecycle-report.json'),JSON.stringify(result,null,2));
 const log=async(name,detail={})=>{result.checks.push({name,passed:true,...detail});await save();};
 const getMode=()=>tab.playwright.getByTestId('workbench').getAttribute('data-workspace-mode');
 async function mode(name){await tab.playwright.getByTestId('workspace-'+name).click();await tab.getAXState({emit:false});assert.equal(await getMode(),name);}
 async function project(name){await tab.playwright.getByTestId('project-switcher').click();await tab.playwright.getByRole('menuitem',{name,exact:true}).click();await tab.playwright.getByTestId('project-switcher').filter({hasText:name}).waitFor({state:'visible',timeoutMs:10000});await tab.getAXState({emit:false});}
 async function fault(operation){try{await unlink(runtime+'/fault-release');}catch{}await writeFile(runtime+'/fault.json',JSON.stringify({operation,kind:'hold'}));}
 const release=()=>writeFile(runtime+'/fault-release','release');
 async function wait(predicate){for(let i=0;i<50;i++){const value=await read();if(predicate(value))return value;await tab.getAXState({emit:false});}throw Error('Expected persisted lifecycle outcome not reached');}
 try{
  await mode('editing');const state=await read(),videoClip=state.timeline.clips.find(c=>state.assets.find(a=>a.id===c.assetId)?.mimeType==='video/mp4'&&c.durationFrames>=120),audioClip=state.timeline.clips.find(c=>state.assets.find(a=>a.id===c.assetId)?.mimeType.startsWith('audio/'));
  const checks=[];
  for(const [kind,clip] of [['video',videoClip],['audio',audioClip]]){
   await tab.playwright.getByTestId(`timeline-clip-${clip.id}`).click();await tab.getAXState({emit:false});const player=tab.playwright.getByTestId('source-preview-'+kind);await player.press('Space');await tab.getAXState({emit:false});
   const playing=await player.evaluate(el=>({paused:el.paused,time:el.currentTime,readyState:el.readyState,error:el.error?.code||null}));assert.equal(playing.paused,false);assert.ok(playing.time>0);assert.equal(playing.error,null);
   await mode('canvas');assert.equal(await player.count(),0);assert.equal(await tab.playwright.getByTestId('central-preview').count(),0);
   await project(fixture.second.name);await mode('editing');assert.equal(await tab.playwright.getByTestId('timeline-playhead').getAttribute('value'),'0');await tab.getAXState({emit:false});
   await project(fixture.project.name);await mode('editing');const resumed=await player.evaluate(el=>({paused:el.paused,time:el.currentTime}));assert.equal(resumed.paused,true);checks.push({kind,playing,resumed});
  }
  await log('Actual video and audio playback stop on workspace unmount; switching projects leaves the second playhead at zero and returns paused',{media:checks});
  await mode('canvas');await tab.playwright.getByTestId(`shot-node-${fixture.shot.id}`).getByText(fixture.shot.title,{exact:true}).click();await tab.playwright.getByRole('tab',{name:'创作参数',exact:true}).click();const beforeGeneration=await read();
  await fault('generation.submit');await tab.playwright.getByTestId('generate-shot').click();const accepted=await wait(data=>data.jobs.length===beforeGeneration.jobs.length+1);const job=accepted.jobs.find(j=>!beforeGeneration.jobs.some(old=>old.id===j.id));
  await project(fixture.second.name);await clickWorkbenchAction(tab, 'jobs-button');assert.equal(await tab.playwright.getByTestId(`job-${job.id}`).count(),0);assert.equal(await tab.playwright.getByTestId('resume-pending').count(),0);await tab.playwright.getByRole('button',{name:'关闭生成任务',exact:true}).click();await release();await tab.getAXState({emit:false});
  assert.ok((await tab.playwright.getByTestId('project-switcher').innerText()).includes(fixture.second.name));assert.equal(await getMode(),'editing');assert.equal(await tab.playwright.getByTestId('timeline-playhead').getAttribute('value'),'0');assert.equal(await tab.playwright.getByRole('button',{name:'关闭生成任务',exact:true}).count(),0);
  await project(fixture.project.name);assert.equal(await getMode(),'canvas');const completed=await wait(data=>data.jobs.find(j=>j.id===job.id)?.status==='succeeded');const exact=completed.jobs.find(j=>j.id===job.id);assert.equal(exact.submissionCount,1);equal(completed.timeline,beforeGeneration.timeline);assert.equal(completed.jobs.length,beforeGeneration.jobs.length+1);
  await log('Held generation submission and late completion remain project-scoped, never reopen Jobs or change mode, and submit exactly once',{jobId:job.id});
  await fault('project.create');await tab.playwright.getByTestId('project-switcher').click();await tab.playwright.getByRole('menuitem',{name:'新建项目',exact:true}).click();const newName='已关闭的新项目 · '+Date.now();await tab.playwright.getByTestId('project-name').fill(newName);await tab.playwright.getByTestId('create-project-submit').click();
  for(let i=0;i<30&&!store.list('projects').some(p=>p.name===newName);i++)await tab.getAXState({emit:false});assert.ok(store.list('projects').some(p=>p.name===newName));await tab.playwright.getByRole('button',{name:'关闭对话框',exact:true}).click();await release();await tab.getAXState({emit:false});
  assert.ok((await tab.playwright.getByTestId('project-switcher').innerText()).includes(fixture.project.name));assert.equal(await getMode(),'canvas');assert.equal(await tab.playwright.getByTestId('project-name').count(),0);await log('Closing a held New Project modal keeps the current project/mode when its accepted response arrives');
  result.result='passed';result.finishedAt=new Date().toISOString();await save();return result;
 }catch(error){result.result='failed';result.error=String(error.stack||error);await release();await save();throw error;}finally{store.close();}
}
