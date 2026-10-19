/** Actual CUA browser acceptance. Bundle with installed esbuild before importing
 * in CUA. Only disposable evidence/split-clips/runtime SQLite may be edited;
 * UI actions use the supplied own-cloud browser tab. No renderer state mocks.
 */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
const equal=(actual,expected,message)=>assert.equal(JSON.stringify(actual),JSON.stringify(expected),message);
const domain=timeline=>({tracks:timeline.tracks,clips:timeline.clips,durationFrames:timeline.durationFrames});
export async function runSplitBrowserAcceptance({tab,projectId,dataDir,outDir}){
 assert.ok(path.resolve(dataDir).includes('/evidence/split-clips/runtime/'),'Disposable synthetic copy required');
 await mkdir(outDir,{recursive:true});const store=openStore(dataDir,{lock:false}),s=createServices(store,new Map(),{env:{}});
 const read=()=>s.call('timeline.get',{projectId}),history=()=>s.call('timeline.history.get',{projectId});
 const report={browser:'Own-cloud CUA Chromium; unchanged sandbox',startedAt:new Date().toISOString(),checks:[],screenshots:[]};
 const log=(name,details={})=>report.checks.push({name,passed:true,...details});
 const capture=async name=>{await writeFile(path.join(outDir,name),await tab.screenshot({fullPage:true}));report.screenshots.push(name);};
 const settle=async rev=>{await tab.playwright.locator('.timeline-footnote span').filter({hasText:new RegExp(`时间线 rev ${rev}\\s`)}).waitFor({state:'visible',timeoutMs:10000});await tab.getAXState({emit:false});const next=await read();assert.equal(next.revision,rev);return next;};
 const frame=async value=>{await tab.playwright.getByTestId('timeline-playhead').fill(String(value));await tab.getAXState({emit:false});};
 try{
  await tab.playwright.getByTestId('workspace-editing').click();await tab.getAXState({emit:false});
  let timeline=await read(),revision=timeline.revision;const baseline=structuredClone(timeline),originalHistory=await history();
  const outside=Object.fromEntries(['projects','assets','shots','nodes','edges','jobs','versions','exports'].map(table=>[table,store.list(table)]));
  const clip=timeline.clips.find(c=>c.durationFrames>=30&&store.get('assets',c.assetId).mimeType.startsWith('video/'));assert.ok(clip);
  const splitAt=clip.startFrame+Math.floor(clip.durationFrames/2);
  await tab.playwright.getByTestId(`timeline-clip-${clip.id}`).click();await tab.getAXState({emit:false});
  assert.equal(await tab.playwright.getByTestId('timeline-split').isEnabled(),false,'Start boundary');
  for(const position of [clip.startFrame+clip.durationFrames,clip.startFrame+clip.durationFrames+1]){await frame(position);assert.equal(await tab.playwright.getByTestId('timeline-split').isEnabled(),false);}
  log('Start/end/outside positions disable splitting',{clipId:clip.id});
  await frame(splitAt);assert.equal(await tab.playwright.getByTestId('timeline-split').isEnabled(),true);
  assert.match(await tab.playwright.getByTestId('timeline-split-target').innerText(),new RegExp(`${splitAt}f`));
  await tab.playwright.getByTestId('timeline-split').click();timeline=await settle(++revision);
  const right=timeline.clips.find(c=>!baseline.clips.some(b=>b.id===c.id));assert.ok(right);
  assert.equal(timeline.clips.length,baseline.clips.length+1);assert.equal(timeline.durationFrames,baseline.durationFrames);
  assert.equal(right.startFrame,splitAt);assert.equal(right.sourceInFrame,clip.sourceInFrame+splitAt-clip.startFrame);assert.equal((await history()).cursor,originalHistory.cursor+1);
  assert.equal(await tab.playwright.getByTestId('timeline-split').isEnabled(),false,'The retained left clip ends at the cut');
  log('Toolbar splits only the selected clip with contiguous source ranges and one history entry',{revision,splitAt,rightId:right.id});await capture('01-split-selected-clip.jpg');
  const split=structuredClone(timeline);
  await tab.playwright.getByTestId('timeline-undo').click();timeline=await settle(++revision);equal(domain(timeline),domain(baseline));
  log('One Undo restores exact original composition and original ID',{revision});await capture('02-undone-split.jpg');
  await tab.playwright.getByTestId('timeline-redo').click();timeline=await settle(++revision);equal(domain(timeline),domain(split));
  log('Redo restores both stable IDs and exact source ranges',{revision});await capture('03-redone-split.jpg');
  await tab.reload();timeline=await settle(revision);equal(domain(timeline),domain(split));log('Reload preserves split, selection, playhead and history',{revision});
  await tab.playwright.getByTestId('timeline-undo').click();timeline=await settle(++revision);
  await tab.playwright.getByTestId(`timeline-clip-${clip.id}`).click();await frame(splitAt);
  await tab.playwright.getByLabel('片段名称',{exact:true}).fill('Unsaved split guard');await tab.getAXState({emit:false});assert.equal(await tab.playwright.getByTestId('timeline-split').isEnabled(),false);
  await tab.playwright.getByRole('slider',{name:'时间标尺',exact:true}).press('Control+b');assert.equal((await read()).revision,revision);await capture('04-dirty-split-guard.jpg');
  await tab.playwright.getByRole('button',{name:'放弃修改',exact:true}).click();await tab.getAXState({emit:false});
  const search=tab.playwright.getByRole('textbox',{name:'搜索素材',exact:true});await search.fill('');await search.press('Control+b');assert.equal((await read()).revision,revision);log('Unsaved drafts and text input retain their native shortcut behavior');
  await tab.playwright.getByTestId('workspace-canvas').click();await tab.getAXState({emit:false});await tab.playwright.getByTestId('workspace-canvas').press('Control+b');assert.equal((await read()).revision,revision);assert.equal(await tab.playwright.getByTestId('timeline-split').count(),0);
  await tab.playwright.getByTestId('workspace-editing').click();await tab.getAXState({emit:false});
  await tab.playwright.getByRole('slider',{name:'时间标尺',exact:true}).press('Control+b');timeline=await settle(++revision);
  assert.equal(timeline.clips.length,baseline.clips.length+1);assert.equal((await history()).canRedo,false);log('Ctrl+B works only in Editing and a new split replaces the redo branch',{revision});
  await tab.playwright.getByTestId('timeline-undo').click();timeline=await settle(++revision);
  // An independent real writer advances the version before the displayed split.
  const competitor=await s.call('timeline.track.update',{projectId,expectedRevision:revision,requestId:randomUUID(),trackId:timeline.tracks[0].id,patch:{name:'Split QA concurrent track'}});revision=competitor.revision;
  await tab.playwright.getByTestId('timeline-split').click();await tab.playwright.getByText('保存冲突：内容已在其他窗口更新。已刷新最新状态，请检查后再保存',{exact:true}).waitFor({state:'visible',timeoutMs:10000});timeline=await settle(revision);equal(timeline,competitor);log('Stale split is rejected and refreshes without overwriting concurrent edit',{revision});
  await tab.playwright.getByRole('button',{name:'关闭提示',exact:true}).click();await tab.playwright.getByTestId('timeline-undo').click();timeline=await settle(++revision);equal(domain(timeline),domain(baseline));
  await tab.playwright.getByTestId('timeline-split').click();timeline=await settle(++revision);
  equal(Object.fromEntries(Object.keys(outside).map(table=>[table,store.list(table)])),outside);log('No original media, graph, versions, jobs, exports or project changed');
  report.finalTimeline=timeline;report.finalHistory=await history();await capture('05-final-split-workspace.jpg');report.result='passed';
 }catch(error){report.result='failed';report.error=String(error.stack||error);try{await capture('failure.jpg');}catch{}throw error;}
 finally{report.finishedAt=new Date().toISOString();await writeFile(path.join(outDir,'browser-split-report.json'),JSON.stringify(report,null,2));store.close();}
 return report;
}
