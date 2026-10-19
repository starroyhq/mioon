/** Real browser acceptance using the supported CUA tab API.
 * Bundle for the CUA REPL's workspace-package resolver before running:
 *   node -e "import('esbuild').then(b=>b.build({entryPoints:['tests/browser_timeline_history.mjs'],bundle:true,platform:'node',format:'esm',outfile:'evidence/timeline-history/runtime/browser-qa.bundle.mjs'}))"
 * In the own-cloud CUA REPL, with a signed-in tab displaying the copied synthetic
 * multitrack project:
 *   const qa = await import('/workspace/shared/video-workbench/evidence/timeline-history/runtime/browser-qa.bundle.mjs');
 *   await qa.runHistoryBrowserAcceptance({tab, projectId, dataDir, outDir});
 * dataDir must be the disposable evidence/timeline-history/runtime copy, never
 * original media or a user's workspace. Keep Chromium's sandbox enabled.
 * Node SQLite is only used to verify and create one competing local edit; all
 * renderer actions and screenshots go through the supplied CUA browser tab.
 */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
const equal=(actual,expected,message)=>assert.equal(JSON.stringify(actual),JSON.stringify(expected),message);
const domain=timeline=>({tracks:timeline.tracks,clips:timeline.clips,durationFrames:timeline.durationFrames});
export async function runHistoryBrowserAcceptance({tab,projectId,dataDir,outDir}) {
 assert.ok(['/evidence/timeline-history/runtime/', '/evidence/dual-workspace/runtime/'].some(part => path.resolve(dataDir).includes(part)), 'Only an isolated synthetic QA copy may be edited');
 await mkdir(outDir,{recursive:true});
 const store=openStore(dataDir,{lock:false}),services=createServices(store,new Map(),{env:{}});
 const read=()=>services.call('timeline.get',{projectId});
 const history=()=>services.call('timeline.history.get',{projectId});
 const outside=()=>Object.fromEntries(['projects','assets','shots','nodes','edges','jobs','versions','exports'].map(table=>[table,store.list(table)]));
 const result={startedAt:new Date().toISOString(),browser:'Own-cloud CUA Chromium; sandbox unchanged',projectId,checks:[],screenshots:[]};
 const log=(name,details={})=>result.checks.push({name,passed:true,...details});
 async function settle(revision) {
  await tab.playwright.locator('.timeline-footnote span').filter({hasText:new RegExp(`时间线 rev ${revision}\\s`)}).waitFor({state:'visible',timeoutMs:10000});
  await tab.getAXState({emit:false});
  const current=await read();assert.equal(current.revision,revision);return current;
 }
 async function capture(name) {const bytes=await tab.screenshot({fullPage:true});await writeFile(path.join(outDir,name),bytes);result.screenshots.push(name);}
 try {
  await tab.playwright.getByTestId('workspace-editing').click();await tab.getAXState({emit:false});
  let timeline=await read(),revision=timeline.revision;
  const baseline=structuredClone(timeline),baselineHistory=await history(),unchanged=outside();
  assert.ok(timeline.clips.length>0&&timeline.tracks.length<11,'Use the existing synthetic multitrack fixture');
  await tab.playwright.getByTestId('add-video-track').click();timeline=await settle(++revision);
  const newVideo=timeline.tracks.find(track=>!baseline.tracks.some(old=>old.id===track.id));assert.ok(newVideo);
  assert.equal((await history()).cursor,baselineHistory.cursor+1);assert.equal(await tab.playwright.getByTestId('timeline-undo').isEnabled(),true);
  log('Adding a track journals one edit and enables Undo',{revision,trackId:newVideo.id});await capture('01-added-track.jpg');
  await tab.playwright.getByTestId('timeline-undo').click();timeline=await settle(++revision);equal(domain(timeline),domain(baseline));
  assert.equal(await tab.playwright.getByTestId('timeline-redo').isEnabled(),true);log('Undo restores exact tracks/clips/duration and enables Redo',{revision});await capture('02-undone-track.jpg');
  await tab.playwright.getByRole('slider',{name:'时间标尺',exact:true}).press('Control+Shift+z');timeline=await settle(++revision);assert.ok(timeline.tracks.some(track=>track.id===newVideo.id));
  log('Ctrl+Shift+Z redoes with the original stable track ID',{revision});
  const search=tab.playwright.getByRole('textbox',{name:'搜索素材',exact:true});await search.fill('');await search.pressSequentially('historyguard');const beforeText=await search.getAttribute('value');await search.press('Control+z');await tab.getAXState({emit:false});
  assert.notEqual(await search.getAttribute('value'),beforeText);assert.equal((await read()).revision,revision);log('Native text Undo changes search text without traversing timeline');await search.fill('');
  const clip=timeline.clips[0];await tab.playwright.getByTestId(`timeline-clip-${clip.id}`).click();await tab.playwright.getByLabel('片段名称',{exact:true}).fill('Unsaved history guard');await tab.getAXState({emit:false});
  assert.equal(await tab.playwright.getByTestId('timeline-undo').isEnabled(),false);assert.equal(await tab.playwright.getByTestId('timeline-redo').isEnabled(),false);
  await tab.playwright.getByRole('slider',{name:'时间标尺',exact:true}).press('Control+z');assert.equal((await read()).revision,revision);log('Unsaved clip changes disable controls and shortcuts');await capture('03-unsaved-guard.jpg');
  await tab.playwright.getByRole('button',{name:'放弃修改',exact:true}).click();await tab.playwright.getByRole('slider',{name:'时间标尺',exact:true}).press('Control+z');timeline=await settle(++revision);equal(domain(timeline),domain(baseline));
  await tab.playwright.getByRole('slider',{name:'时间标尺',exact:true}).press('Control+y');timeline=await settle(++revision);assert.ok(timeline.tracks.some(track=>track.id===newVideo.id));log('Ctrl+Z and Ctrl+Y traverse history after discarding the draft',{revision});
  await tab.playwright.getByTestId('timeline-undo').click();timeline=await settle(++revision);
  await tab.playwright.getByTestId('add-audio-track').click();timeline=await settle(++revision);
  assert.equal((await history()).canRedo,false);assert.equal((await history()).length,baselineHistory.cursor+1);assert.ok(!timeline.tracks.some(track=>track.id===newVideo.id));
  log('A new edit after Undo replaces the redo branch',{revision});
  await tab.playwright.getByTestId('timeline-undo').click();timeline=await settle(++revision);const reloaded=structuredClone(timeline),savedHistory=await history();
  await tab.reload();timeline=await settle(revision);equal(timeline,reloaded);equal(await history(),savedHistory);assert.equal(await tab.playwright.getByTestId('timeline-redo').isEnabled(),true);
  log('Page reload retains the durable cursor, timeline and available redo',{revision});await capture('04-reloaded-undo.jpg');
  await tab.playwright.getByTestId('timeline-redo').click();timeline=await settle(++revision);
  // Deliberately race a real independent writer against the displayed revision.
  // No response is mocked: the backend itself must return REVISION_CONFLICT.
  const competing=await services.call('timeline.track.update',{projectId,expectedRevision:revision,requestId:randomUUID(),trackId:timeline.tracks[0].id,patch:{name:'History QA competing edit'}});revision=competing.revision;
  await tab.playwright.getByTestId('timeline-undo').click();await tab.playwright.getByText('保存冲突：内容已在其他窗口更新。已刷新最新状态，请检查后再保存',{exact:true}).waitFor({state:'visible',timeoutMs:10000});
  timeline=await settle(revision);equal(timeline,competing);assert.equal((await history()).revision,revision);assert.equal(await tab.playwright.getByTestId('timeline-undo').isEnabled(),true);
  log('Stale Undo rejects atomically and refreshes current timeline/history',{revision});await capture('05-conflict-refresh.jpg');
  await tab.playwright.getByRole('button',{name:'关闭提示',exact:true}).click();
  // Leave a compact three-track view with a usable redo action for the screenshot.
  await tab.playwright.getByTestId('timeline-undo').click();timeline=await settle(++revision);
  await tab.playwright.getByTestId('timeline-undo').click();timeline=await settle(++revision);
  await tab.playwright.getByTestId(`timeline-clip-${clip.id}`).click();await tab.getAXState({emit:false});
  equal(outside(),unchanged,'No generated version, selected shot, job, export, asset or project may change');
  log('Original media, jobs, versions, exports and project state remain unchanged');
  await capture('06-final-history-controls.jpg');
  result.finishedAt=new Date().toISOString();result.result='passed';result.finalTimeline=await read();result.finalHistory=await history();
 } catch(error) {result.finishedAt=new Date().toISOString();result.result='failed';result.error=String(error.stack||error);try{await capture('failure.jpg');}catch{}throw error;}
 finally {await writeFile(path.join(outDir,'browser-history-report.json'),JSON.stringify(result,null,2));store.close();}
 return result;
}
