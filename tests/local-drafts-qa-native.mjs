/** Synthetic Linux packaged acceptance. Native UI is operated separately with
 * the supported computer-use API. A crash request signals only this helper's
 * still-owned ChildProcess handle, never a PID recovered from a file. */
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,readdir,lstat,open} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {ensurePrivateDirectory} from '../packages/contracts/src/private-storage.mjs';
import {openStore,ownsStoreLock} from '../packages/business/src/db.mjs';
import {createLocalDrafts} from '../packages/business/src/local-drafts.ts';
import {createTimelineRecoveryBoundary} from '../packages/business/src/timeline-recovery.mjs';
import {readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile} from '../packages/contracts/src/private-storage.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {createWorkspacePreferences} from '../packages/business/src/workspace-preferences.mjs';
import {defaultWorkspaceState} from '../apps/web/src/workspace-state.js';
import {ownQaChild} from './agent-timeline-move-qa-native.mjs';

const repo=fileURLToPath(new URL('../',import.meta.url));
const scenario=process.env.MIOON_DRAFT_QA_SCENARIO||'recovery';
if(!['recovery','capacity'].includes(scenario))throw Error('Unknown synthetic draft scenario');
const root=path.join(repo,'evidence/local-drafts',scenario==='capacity'?'native-capacity':'native'),runtime=path.join(root,'private-runtime'),report=path.join(root,'report');
const userData=path.join(runtime,'user-data'),workspace=path.join(userData,'workspace');
const executable=path.join(repo,'release/desktop/production/linux-unpacked/mioon');
const fixtureFile=path.join(runtime,'fixture.json');
const sha=value=>createHash('sha256').update(value).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function exists(file){try{await lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function readJson(file){const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>2*1024*1024)throw Error('Expected bounded synthetic report');return JSON.parse(await readFile(file,'utf8'));}
async function writeReport(name,value){if(!/^[a-z0-9-]+\.json$/.test(name))throw Error('Invalid report name');await writeFile(path.join(report,name),json(value),{mode:0o600,flag:'wx'});}
async function fileHash(file){const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>512*1024*1024)throw Error('Unexpected evidence file');const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return {bytes:info.size,sha256:hash.digest('hex')};}
function environment(){return {...Object.fromEntries(['PATH','HOME','LANG','LC_ALL','DISPLAY','XAUTHORITY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','TMPDIR'].filter(key=>typeof process.env[key]==='string').map(key=>[key,process.env[key]])),MIOON_DRAFT_QA_SCENARIO:scenario,MIOON_DESKTOP_USER_DATA:userData,MIOON_ENABLE_LIVE_PROVIDER:'0',MIOON_FFMPEG_PATH:'/usr/bin/ffmpeg',MIOON_FFPROBE_PATH:'/usr/bin/ffprobe'};}
async function command(binary,args,label){const stdout=await open(path.join(runtime,label+'.stdout'),'wx',0o600),stderr=await open(path.join(runtime,label+'.stderr'),'wx',0o600);const owned=ownQaChild(spawn(binary,args,{cwd:repo,env:environment(),stdio:['ignore',stdout.fd,stderr.fd]}));let timer;try{const result=await Promise.race([owned.done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Bounded fixture command timed out')),60000);})]);assert.equal(result.code,0);assert.equal(result.signal,null);return result;}catch(error){await owned.stop();throw error;}finally{clearTimeout(timer);await stdout.close();await stderr.close();}}

async function prepare(){
 for(const directory of [root,runtime,report,userData])ensurePrivateDirectory(directory,{create:true});
 if(await exists(fixtureFile))throw Error('Fixture already exists; use its explicit launch/reopen commands');
 const source=path.join(runtime,'synthetic-green-880hz.mp4');
 await command('/usr/bin/ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=0x18bf57:s=320x180:r=30:d=2','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=2','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-shortest',source],'source-media');
 const store=openStore(workspace),services=createServices(store,new Map());let fixture;
 try{
  const project=await services.call('project.create',{name:scenario==='capacity'?'片段草稿 · 容量拒绝退出验收':'片段草稿 · 强杀恢复验收'});
  const asset=await services.call('asset.import',{projectId:project.id,name:'合成绿色画面与 880Hz.mp4',mimeType:'video/mp4',dataBase64:(await readFile(source)).toString('base64')});
  let timeline=await services.call('timeline.format.set',{projectId:project.id,expectedProjectRevision:project.revision,expectedRevision:0,requestId:randomUUID(),presetId:'landscape_720'});
  timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:asset.id,trackId:timeline.tracks.find(track=>track.kind==='video').id,startFrame:0,durationFrames:60,name:'原来已保存的片段'});
  if(scenario==='capacity'){
   const drafts=createLocalDrafts({root:workspace,channel:'production',storage:{readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile},guards:{ownsLock:()=>ownsStoreLock(store),isRestored:()=>false,readTimeline:id=>createTimelineRecoveryBoundary(store.db,{projectId:id}).read(),readClipAsset:(id,clip)=>createTimelineRecoveryBoundary(store.db,{projectId:id}).clipSource(clip)}});
   // Fill the documented retained-slot limit through real service writes and
   // exact CAS deletes. No forged sidecar row, authority, or backend test switch.
   for(let index=0;index<128;index++){
    timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:asset.id,trackId:timeline.tracks.find(track=>track.kind==='video').id,startFrame:60,durationFrames:1,name:'Synthetic retained slot '+index});
    const padding=timeline.clips.find(item=>item.startFrame===60),key={projectId:project.id,timelineId:timeline.id,clipId:padding.id},current=drafts.get(key);
    const raw={name:padding.name,trackId:padding.trackId,startFrame:padding.startFrame,durationFrames:padding.durationFrames,sourceInFrame:padding.sourceInFrame,rect:padding.rect,gain:padding.gain};
    const written=drafts.put({...key,workspaceScope:current.workspaceScope,instanceId:current.instanceId,expectedRevision:current.revision,baseRevision:timeline.revision,source:{assetId:asset.id,assetSha256:asset.sha256},raw});
    drafts.discard({...key,workspaceScope:written.workspaceScope,instanceId:written.instanceId,expectedRevision:written.revision});
    timeline=await services.call('timeline.clip.remove',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),clipId:padding.id});
   }
  }
  const clip=timeline.clips[0],state=defaultWorkspaceState();state.activeMode='editing';state.editing.selectedClipId=clip.id;state.editing.quickAssetId=null;state.editing.previewKind='source';state.shared.inspectorCollapsed=false;delete state.shared.assetSearch;
  createWorkspacePreferences(store).put(project.id,{expectedRevision:0,state});
  fixture={synthetic:true,scenario,id:randomUUID(),projectId:project.id,timelineId:timeline.id,clipId:clip.id,assetId:asset.id,baseRevision:timeline.revision,originalClip:clip,sourceHash:asset.sha256,sourceFile:await fileHash(source)};
 }finally{await services.drain();store.close();}
 await writeFile(fixtureFile,json(fixture),{mode:0o600,flag:'wx'});await writeReport('fixture.json',fixture);await audit('prepared');
 for(const label of ['first','reopen','final'])await writeFile(path.join(runtime,'launch-'+label+'.sh'),`#!/bin/bash\ncd ${JSON.stringify(repo)}\nexport MIOON_DRAFT_QA_SCENARIO=${JSON.stringify(scenario)}\nexec ${JSON.stringify(process.execPath)} tests/local-drafts-qa-native.mjs launch ${label}\n`,{mode:0o700,flag:'wx'});
 return fixture;
}
async function audit(label){
 if(!/^[a-z0-9-]{1,60}$/.test(label))throw Error('Invalid audit label');const fixture=await readJson(fixtureFile);
 const db=new DatabaseSync(path.join(workspace,'workbench.sqlite'),{readOnly:true});let rows;
 try{db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF');rows=Object.fromEntries(['projects','assets','shots','jobs','versions','exports','timelines','timeline_requests','timeline_history','edit_tasks'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));}finally{db.close();}
 const sidecar=path.join(workspace,'local-drafts-v1.json'),draft=await exists(sidecar)?await readJson(sidecar):null;
 const media=[];for(const name of (await readdir(path.join(workspace,'media'))).sort())media.push({name,...await fileHash(path.join(workspace,'media',name))});
 const timeline=rows.timelines.map(row=>JSON.parse(row.data)).find(value=>value.id===fixture.timelineId);
 const result={synthetic:true,at:new Date().toISOString(),tables:Object.fromEntries(Object.entries(rows).map(([key,value])=>[key,{count:value.length,sha256:sha(JSON.stringify(value))}])),timeline,editTasks:rows.edit_tasks.map(row=>({id:row.id,requestId:row.requestId,status:row.status,acknowledged:row.acknowledged})),exports:rows.exports.map(row=>JSON.parse(row.data)),draft,media};
 await writeReport(label+'-audit.json',result);return result;
}
async function launch(label){
 if(!['first','reopen','final'].includes(label))throw Error('Explicit launch label required');const fixture=await readJson(fixtureFile);
 if(await exists(path.join(workspace,'server.lock'))){
  const crash=await readJson(path.join(report,'first-exit.json')),inspection=await readJson(path.join(report,'crash-inspection.json'));
  assert.equal(label,'reopen');assert.equal(crash.result.signal,'SIGKILL');assert.equal(inspection.readOnlyPidProbe,false);assert.equal(inspection.stat,null);assert.equal(inspection.httpError,'ECONNREFUSED');assert.equal(inspection.lockUnchanged,true);
  // Do not remove/rewrite the stale lock. The real backend's normal startup
  // performs its own live-owner check; this fixture only permits that attempt.
 }
 const log=await open(path.join(runtime,label+'-native.log'),'wx',0o600),owned=ownQaChild(spawn(executable,[],{cwd:repo,env:environment(),stdio:['ignore',log.fd,log.fd]}));
 const initial={synthetic:true,label,at:new Date().toISOString(),pid:owned.child.pid,executableHash:await fileHash(executable),asarHash:await fileHash(path.join(path.dirname(executable),'resources/app.asar')),sandboxUnchanged:true,debugging:false};await writeReport(label+'-launch.json',initial);
 let crashRequested=false,timer,deadline;const poll=async()=>{const file=path.join(runtime,label+'-crash-request.json');if(!crashRequested&&await exists(file)){const request=await readJson(file);if(request.fixtureId!==fixture.id||request.label!==label)throw Error('Crash command does not own this fixture');crashRequested=true;if(!owned.closed)owned.child.kill('SIGKILL');}};
 let polling=Promise.resolve();timer=setInterval(()=>{polling=polling.then(poll);polling.catch(()=>{});},200);
 let result;
 try{result=await Promise.race([owned.done,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('Native observation window ended')),30*60*1000);})]);await polling;}
 catch(error){await owned.stop();throw error;}
 finally{clearInterval(timer);clearTimeout(deadline);await log.close();}
 if(crashRequested){assert.equal(result.signal,'SIGKILL');assert.equal(result.code,null);}else{assert.equal(result.code,0);assert.equal(result.signal,null);}
 // Main's child handle is the only signalled process. Utility-process lease
 // cleanup is observed separately; a stale reported PID grants no authority.
 const until=Date.now()+45000;while(await exists(path.join(workspace,'server.lock'))&&Date.now()<until)await pause(250);
 const backendLockReleased=!await exists(path.join(workspace,'server.lock'));
 await writeReport(label+'-exit.json',{...initial,endedAt:new Date().toISOString(),result,crashRequested,backendLockReleased,childSignals:crashRequested?['SIGKILL']:[]});
 if(!backendLockReleased)throw Error('Backend cleanup unconfirmed; no replacement launch allowed');
}
async function crash(label){if(label!=='first')throw Error('Only initial synthetic launch may be killed');const fixture=await readJson(fixtureFile);await writeFile(path.join(runtime,label+'-crash-request.json'),json({fixtureId:fixture.id,label}),{mode:0o600,flag:'wx'});}
async function final(){const until=Date.now()+45000;while(!await exists(path.join(report,'final-exit.json'))&&Date.now()<until)await pause(100);if(!await exists(path.join(report,'final-exit.json')))throw Error('Final owned exit has not settled');const fixture=await readJson(fixtureFile),result=await audit('final'),prepared=await readJson(path.join(report,'prepared-audit.json'));assert.equal(result.timeline.clips[0].name,'Crash-recovered draft');assert.equal(result.timeline.revision,fixture.baseRevision+1);assert.equal(result.editTasks.length,1);assert.equal(result.editTasks[0].status,'applied');assert.equal(result.editTasks[0].acknowledged,1);
 for(const table of ['projects','shots','jobs','versions'])assert.deepEqual(result.tables[table],prepared.tables[table]);
 for(const item of prepared.media)assert.deepEqual(result.media.find(value=>value.name===item.name),item);
 assert.ok(result.draft.entries.every(entry=>entry.draft===null),'Applied exact draft was not cleared');
 const exported=result.exports.filter(item=>item.purpose==='export'&&item.status==='succeeded');assert.equal(exported.length,1);const mediaId=exported[0].assetId;
 const db=new DatabaseSync(path.join(workspace,'workbench.sqlite'),{readOnly:true});let asset;try{asset=JSON.parse(db.prepare('SELECT data FROM assets WHERE id=?').get(mediaId).data);}finally{db.close();}
 assert.equal(asset.projectId,fixture.projectId);assert.ok(/^media\/[a-zA-Z0-9._-]+\.mp4$/.test(asset.relativePath));const file=path.join(workspace,asset.relativePath);
 await command('/usr/bin/ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],'final-probe');const probe=await readJson(path.join(runtime,'final-probe.stdout'));const video=probe.streams.find(stream=>stream.codec_type==='video'),audio=probe.streams.find(stream=>stream.codec_type==='audio');assert.equal(video.width,1280);assert.equal(video.height,720);assert.equal(video.r_frame_rate,'30/1');assert.equal(Number(video.nb_frames),60);assert.equal(audio.sample_rate,'48000');
 await command('/usr/bin/ffmpeg',['-v','error','-i',file,'-f','null','-'],'final-decode');
 const summary={synthetic:true,productionBackend:true,providerCalls:0,mainCrash:await readJson(path.join(report,'first-exit.json')),normalReopens:[await readJson(path.join(report,'reopen-exit.json')),await readJson(path.join(report,'final-exit.json'))],output:await fileHash(file),video:{width:video.width,height:video.height,rate:video.r_frame_rate,frames:video.nb_frames},audio:{codec:audio.codec_name,sampleRate:audio.sample_rate},decodeExit:0,originalMediaUnchanged:true};await writeReport('summary.json',summary);return summary;}
async function inspectCrash(){
 const connection=await readJson(path.join(userData,'mcp-connection.json'));
 const lock=await readFile(path.join(workspace,'server.lock'),'utf8');
 assert.match(lock,/^[1-9][0-9]{0,9}$/);assert.equal(Number(lock),connection.pid);
 const url=new URL(connection.url);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.protocol,'http:');
 let stat=null,exists=false,httpStatus=null,httpError=null;
 try{process.kill(connection.pid,0);exists=true;}catch(error){if(error.code!=='ESRCH')throw error;}
 try{const raw=await readFile('/proc/'+connection.pid+'/stat','utf8'),end=raw.lastIndexOf(')');const fields=raw.slice(end+2).split(' ');stat={state:fields[0],parentPid:Number(fields[1])};}catch(error){if(error.code!=='ENOENT')throw error;}
 try{const response=await fetch(url.origin+'/api/health',{signal:AbortSignal.timeout(1500),redirect:'error'});httpStatus=response.status;await response.body?.cancel();}catch(error){httpError=error.cause?.code||error.name;}
 const result={synthetic:true,at:new Date().toISOString(),reportedPid:connection.pid,readOnlyPidProbe:exists,stat,httpStatus,httpError,lockUnchanged:await readFile(path.join(workspace,'server.lock'),'utf8')===lock};await writeReport('crash-inspection.json',result);return result;
}

async function capacityFinal(){
 assert.equal(scenario,'capacity');
 const prepared=await readJson(path.join(report,'prepared-audit.json')),result=await audit('capacity-final');
 assert.deepEqual(result.tables,prepared.tables,'Refused autosave and local-only discard must not dispatch a business write');
 assert.deepEqual(result.timeline,prepared.timeline);assert.deepEqual(result.draft,prepared.draft);assert.deepEqual(result.media,prepared.media);
 assert.equal(result.draft.entries.length,128);assert.ok(result.draft.entries.every(entry=>entry.draft===null));
 const exits=await Promise.all(['first','reopen'].map(label=>readJson(path.join(report,label+'-exit.json'))));
 for(const exit of exits){assert.deepEqual(exit.result,{code:0,signal:null});assert.equal(exit.backendLockReleased,true);}
 const summary={synthetic:true,scenario,productionBackend:true,slots:128,allRetainedRecordsUnchanged:true,businessTablesUnchanged:true,originalMediaUnchanged:true,normalExits:exits};
 await writeReport('capacity-summary.json',summary);return summary;
}

const [action,label]=process.argv.slice(2);
if(action==='prepare')console.log(json(await prepare()));else if(action==='launch')await launch(label);else if(action==='audit')console.log(json(await audit(label)));else if(action==='crash')await crash(label);else if(action==='final')console.log(json(await final()));else if(action==='capacity-final')console.log(json(await capacityFinal()));else if(action==='inspect-crash')console.log(json(await inspectCrash()));else throw Error('Expected prepare/launch/audit/crash/final');
