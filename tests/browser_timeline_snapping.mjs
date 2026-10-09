/** Supported own-cloud CUA + native pointer drags, normal authenticated backend.
 * Reads only the copied synthetic SQLite database; no renderer state injection.
 * screenshotDir must be the current CUA task workspace. */
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
const domain=t=>({tracks:t.tracks,clips:t.clips,durationFrames:t.durationFrames});
export async function createSnappingAcceptance({tab,sky,fixture,screenshotDir,desktopOffset}) {
 assert.ok(fixture.dataDir.endsWith('/evidence/timeline-snapping/runtime/workspace'));
 await mkdir(screenshotDir,{recursive:true});
 const db=new DatabaseSync(path.join(fixture.dataDir,'workbench.sqlite'),{readOnly:true});
 const read=(id=fixture.project.id)=>JSON.parse(db.prepare('SELECT data FROM timelines WHERE projectId=?').get(id).data);
 const cursor=()=>db.prepare('SELECT position FROM timeline_history_cursors WHERE projectId=?').get(fixture.project.id)?.position||0;
 const report={browser:'Own-cloud CUA Chromium with native Sky pointer drag; unchanged sandbox',startedAt:new Date().toISOString(),checks:[],screenshots:[]};
 const save=()=>writeFile(path.join(screenshotDir,'browser-snapping-report.json'),JSON.stringify(report,null,2));
 const log=async(name,details={})=>{report.checks.push({name,passed:true,...details});await save();};
 const capture=async name=>{await writeFile(path.join(screenshotDir,name),await tab.screenshot({fullPage:true}));if(!report.screenshots.includes(name))report.screenshots.push(name);await save();};
 const rect=locator=>locator.evaluate(el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,pxPerFrame:el.style.backgroundSize.split('px')[0]/30};});
 const settle=async rev=>{await tab.playwright.locator('.timeline-footnote span').filter({hasText:new RegExp(`时间线 rev ${rev}\\s`)}).waitFor({state:'visible',timeoutMs:10000});await tab.getAXState({emit:false});assert.equal(read().revision,rev);return read();};
 const frame=async value=>{await tab.playwright.getByTestId('timeline-playhead').fill(String(value));await tab.getAXState({emit:false});};
 const undo=async()=>{const rev=read().revision;await tab.playwright.getByTestId('timeline-undo').click();return settle(rev+1);};
 const project=async name=>{await tab.playwright.getByTestId('project-switcher').click();await tab.playwright.getByRole('menuitem').filter({hasText:name}).click();await tab.getAXState({emit:false});};
 const fault=async kind=>{try{await unlink(path.join(fixture.runtime,'fault-release'));}catch{}await writeFile(path.join(fixture.runtime,'fault.json'),JSON.stringify({operation:'timeline.clip.update',kind}));};
 const release=()=>writeFile(path.join(fixture.runtime,'fault-release'),'release');
 async function drag({clipId,assetId,trackId,startFrame,expectFrame,valid=true,alt=false,cancel=false,screenshot}) {
  const source=tab.playwright.getByTestId(`${clipId?'timeline-clip':'asset-card'}-${clipId||assetId}`),lane=tab.playwright.getByTestId(`track-lane-${trackId}`);
  const from=await rect(source),to=await rect(lane);
  // Assets originate in their name strip, avoiding native image/video controls.
  const grab=clipId?from.width/2:0,sourceY=clipId?from.y+from.height/2:from.y+Math.min(from.height-36,112);
  const a={x:Math.round(from.x+from.width/2+desktopOffset.x),y:Math.round(sourceY+desktopOffset.y)};
  const b={x:Math.round(to.x+startFrame*to.pxPerFrame+grab+desktopOffset.x),y:Math.round(to.y+to.height/2+desktopOffset.y)};
  assert.ok(a.y>desktopOffset.y&&a.y<desktopOffset.y+757&&b.y>desktopOffset.y&&b.y<desktopOffset.y+757,'Drag endpoints must be visible');
  const points=[a,{x:a.x+7,y:a.y},...Array.from({length:15},(_,i)=>({x:Math.round(a.x+(b.x-a.x)*(i+1)/15),y:Math.round(a.y+(b.y-a.y)*(i+1)/15)})),...Array.from({length:420},()=>b),...(cancel?[{x:b.x,y:desktopOffset.y+470},{x:desktopOffset.x+700,y:desktopOffset.y+470}]:[])];
  // Shift avoids Xfce's Alt+mouse-down window-move shortcut; it has no app semantics.
  const input=sky.drag({path:points,...(alt?{key:'Alt_L+Shift_L'}:{})}).catch(error=>({error}));
  let preview;
  try {
   const target=lane.locator(`[data-testid="timeline-drop-preview"][data-start-frame="${expectFrame}"]`);
   await target.waitFor({state:'visible',timeoutMs:6000});
   assert.equal(await target.getAttribute('data-valid'),String(valid));
   preview={frame:Number(await target.getAttribute('data-start-frame')),duration:Number(await target.getAttribute('data-duration-frames')),status:await tab.playwright.getByTestId('timeline-drop-status').innerText(),guide:await tab.playwright.getByTestId('timeline-snap-guide').count()};
   if(screenshot)await capture(screenshot);
  } finally {const result=await input;if(result?.error)throw result.error;}
  await tab.getAXState({emit:false});return preview;
 }
 return {read,cursor,report,log,capture,settle,frame,undo,project,fault,release,drag,domain,db,save};
}

/** Run on a signed-in Editing tab showing the copied baseline project at 76px/s,
 * scroll 0. desktopOffset is measured from a fresh native screenshot, never guessed.
 * Each native drag is observed in-flight before the actual drop is checked in SQLite. */
export async function runSnappingAcceptance(options) {
 const q=await createSnappingAcceptance(options),{tab,sky,fixture,desktopOffset}=options;
 const base=q.read(),initialCursor=q.cursor(),clip=base.clips[0],target=fixture.targetTrack.id;
 const close=async()=>{for(const name of ['关闭生成任务','关闭提示']){const control=tab.playwright.getByRole('button',{name,exact:true});if(await control.isVisible())await control.click();}await tab.getAXState({emit:false});};
 const search=async text=>{await tab.playwright.getByRole('textbox',{name:'搜索素材',exact:true}).fill(text);await tab.getAXState({emit:false});};
 const move=patch=>q.drag({clipId:clip.id,trackId:target,startFrame:122,expectFrame:120,...patch});
 try {
  await q.frame(0);let revision=q.read().revision;
  const snapped=await move({screenshot:'01-live-snap-preview.jpg'});await q.settle(revision+1);
  assert.equal(q.read().clips.find(c=>c.id===clip.id).startFrame,snapped.frame);assert.equal(q.cursor(),initialCursor+1);
  await q.log('Native center-grab drag snaps to another clip edge and commits the displayed frame exactly once',{preview:snapped});
  const moved=q.domain(q.read());await q.undo();assert.deepEqual(q.domain(q.read()),q.domain(base));
  revision=q.read().revision;await tab.playwright.getByTestId('timeline-redo').click();await q.settle(revision+1);assert.deepEqual(q.domain(q.read()),moved);
  await q.capture('02-snapped-result.jpg');await q.log('Undo and Redo preserve exact composition and stable clip ID');await q.undo();await q.frame(0);
  revision=q.read().revision;const alt=await move({alt:true,expectFrame:122,screenshot:'03-alt-free-drag.jpg'});await q.settle(revision+1);assert.equal(q.read().clips.find(c=>c.id===clip.id).startFrame,122);assert.equal(alt.guide,0);
  await q.log('Native Alt override preserves center pickup while disabling snapping',{preview:alt,nativeNote:'Alt+Shift avoids the Xfce window-move binding; Shift has no timeline semantics.'});await q.undo();
  await tab.playwright.getByTestId('timeline-snapping').click();revision=q.read().revision;
  const off=await move({expectFrame:122});await q.settle(revision+1);assert.equal(q.read().clips.find(c=>c.id===clip.id).startFrame,122);await q.undo();
  await tab.reload();await tab.playwright.getByTestId('timeline-snapping').waitFor({state:'visible'});assert.equal(await tab.playwright.getByTestId('timeline-snapping').getAttribute('aria-pressed'),'false');
  await q.project(fixture.second.name);await tab.playwright.getByTestId('workspace-editing').click();assert.equal(await tab.playwright.getByTestId('timeline-snapping').getAttribute('aria-pressed'),'true');
  await q.project(fixture.project.name);await tab.playwright.getByTestId('timeline-snapping').waitFor({state:'visible'});assert.equal(await tab.playwright.getByTestId('timeline-snapping').getAttribute('aria-pressed'),'false');
  await q.log('Magnet-off survives reload/project switches while another project defaults on',{preview:off});await tab.playwright.getByTestId('timeline-snapping').click();await q.frame(0);
  revision=q.read().revision;let cursor=q.cursor();const overlap=await move({trackId:clip.trackId,startFrame:148,expectFrame:150,valid:false,screenshot:'04-overlap-rejected.jpg'});assert.equal(q.read().revision,revision);assert.equal(q.cursor(),cursor);await q.log('Overlap stays visibly invalid rather than finding another frame',{preview:overlap});
  const cancel=await move({cancel:true});assert.equal(q.read().revision,revision);assert.equal(q.cursor(),cursor);assert.equal(await tab.playwright.getByTestId('timeline-drop-preview').count(),0);await q.log('Outside-lane release cancels without mutation/history',{preview:cancel});
  await sky.scroll({direction:'down',pixels:110,x:desktopOffset.x+1058,y:desktopOffset.y+652});await tab.getAXState({emit:false});
  const wrong=await move({trackId:fixture.audioTrack.id,valid:false,screenshot:'05-incompatible-lane.jpg'});assert.equal(q.read().revision,revision);await q.log('Cross-kind lane rejects the exact prospective placement',{preview:wrong});
  await sky.scroll({direction:'up',pixels:200,x:desktopOffset.x+1058,y:desktopOffset.y+644});await search('星形');await q.frame(225);revision=q.read().revision;
  const imageId=base.clips.find(c=>c.name.includes('星形')).assetId;
  const image=await q.drag({assetId:imageId,trackId:target,startFrame:223,expectFrame:225,screenshot:'06-image-default-duration.jpg'});await q.settle(revision+1);
  const added=q.read().clips.find(c=>!base.clips.some(b=>b.id===c.id));assert.equal(added.durationFrames,90);assert.equal(added.startFrame,225);await q.log('Image insertion commits the explicit 90-frame default',{preview:image});
  await q.frame(253);revision=q.read().revision;const end=await q.drag({clipId:added.id,trackId:target,startFrame:165,expectFrame:163,screenshot:'07-end-edge-playhead.jpg'});await q.settle(revision+1);assert.equal(q.read().clips.find(c=>c.id===added.id).startFrame+90,253);await q.log('Moving end snaps to the playhead',{preview:end});
  await search('时长未知');revision=q.read().revision;cursor=q.cursor();const unknown=await q.drag({assetId:fixture.unknownAssetId,trackId:target,startFrame:20,expectFrame:20,valid:false,screenshot:'08-unknown-duration-rejected.jpg'});assert.equal(q.read().revision,revision);assert.equal(q.cursor(),cursor);assert.equal(unknown.guide,0);assert.match(unknown.status,/时长未知/);await q.log('Unknown media duration is an invalid illustration, not an invented placement',{preview:unknown});
  await search('01 First');await q.frame(0);revision=q.read().revision;const video=await q.drag({assetId:clip.assetId,trackId:target,startFrame:32,expectFrame:30});await q.settle(revision+1);const addedVideo=q.read().clips.find(c=>c.assetId===clip.assetId&&c.id!==clip.id);assert.equal(addedVideo.durationFrames,120);assert.equal(addedVideo.startFrame,30);await q.log('Known video duration supports end-edge asset snapping',{preview:video});await q.undo();await q.undo();await q.undo();
  const zoom=tab.playwright.getByRole('slider',{name:'时间线 缩放',exact:true});await zoom.press('Home');await tab.getAXState({emit:false});await q.frame(0);revision=q.read().revision;const low=await move({startFrame:127.5});await q.settle(revision+1);await q.undo();await zoom.press('End');await tab.getAXState({emit:false});revision=q.read().revision;const high=await move({startFrame:1,expectFrame:0});await q.settle(revision+1);await q.undo();await q.log('Native minimum/maximum zoom drags retain an 8px snap radius',{low,high});await zoom.press('Home');for(let i=0;i<48;i++)await zoom.press('ArrowRight');await tab.getAXState({emit:false});
  await q.frame(0);revision=q.read().revision;cursor=q.cursor();await q.fault('drop');await move();await tab.playwright.getByTestId('resume-pending').waitFor({state:'visible',timeoutMs:10000});assert.equal(q.read().revision,revision+1);assert.equal(q.cursor(),cursor+1);const lost=q.read();await q.capture('09-lost-response-recovery.jpg');await close();
  await q.project(fixture.second.name);await tab.playwright.getByTestId('jobs-button').click();assert.equal(await tab.playwright.getByTestId('resume-pending').count(),0);await close();await q.project(fixture.project.name);await tab.playwright.getByTestId('jobs-button').click();await tab.playwright.getByTestId('resume-pending').click();await tab.playwright.getByTestId('resume-pending').waitFor({state:'detached',timeoutMs:10000});await close();assert.deepEqual(q.read(),lost);assert.equal(q.cursor(),cursor+1);await q.log('Lost accepted response replays exactly once across project switches');
  revision=q.read().revision;const other=q.read(fixture.second.id);await q.fault('hold');await move({startFrame:298,expectFrame:300});assert.equal(q.read().revision,revision+1);const held=q.read();await q.project(fixture.second.name);await q.release();await tab.getAXState({emit:false});assert.ok((await tab.playwright.getByTestId('project-switcher').innerText()).includes(fixture.second.name));assert.deepEqual(q.read(fixture.second.id),other);await q.project(fixture.project.name);await q.settle(revision+1);assert.deepEqual(q.read(),held);await q.log('Late accepted move cannot hijack a newer project or workspace');await q.capture('10-final-snapping-workspace.jpg');
  q.report.result='passed';q.report.finalTimeline=q.read();q.report.finalCursor=q.cursor();
 }catch(error){q.report.result='failed';q.report.error=String(error.stack||error);try{await q.release();await q.capture('failure.jpg');}catch{}throw error;}
 finally{q.report.finishedAt=new Date().toISOString();await q.save();q.db.close();}
 return q.report;
}
