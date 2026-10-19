/** Isolated synthetic Linux packaged acceptance. No GUI automation in this helper.
 * Run serially, never alongside tests/build/media QA. CUA's native shell launcher
 * opens only the generated private-runtime/launch-*.sh scripts in this checkout.
 *
 * MIOON_CLIP_CLOSE_QA_SCENARIO=recovery (default): prepare; launch first;
 * audit first-boot; operator types exactly "Close-recovered draft", then requests
 * ordinary native Quit immediately, without waiting for a draft-status message.
 * Complete the native keep-record/quit confirmation; audit after-close; launch
 * reopen; audit after-reopen; explicitly restore to the form; audit after-restore;
 * click Save Clip exactly once; verify-clip-save; export exactly once through the
 * ordinary native preflight/confirmation; verify-export; normal Quit; launch final;
 * audit after-normal-reopen; normal Quit; complete native-observations.json; final.
 * Do NOT insert an audit or a screenshot between typing and the first Quit.
 *
 * MIOON_CLIP_CLOSE_QA_SCENARIO=capacity: prepare; launch first; audit first-boot;
 * type fixture.expectedName and observe the explicit capacity refusal; audit
 * after-refusal; normal Quit; photograph the current draft/view-unconfirmed dialog;
 * choose Continue Editing; audit after-continue; explicitly choose Abandon Current
 * Input, Keep Draft Records and confirm; audit after-abandon; normal Quit;
 * audit after-close; launch reopen; audit after-reopen; normal Quit;
 * complete native-observations.json; final. Then run suite-final to bind both.
 *
 * Operators save original native JPGs listed in private-runtime/native-observations.json
 * into report/. Replace null observations only with facts actually observed.
 * Screenshots and operator observations prove UI actions; DB hashes alone do not.
 * A quick-looking native interaction does NOT prove input-to-Quit <250 ms. This
 * helper never claims native pre-debounce causality. Deterministic mock-timer
 * evidence belongs separately to clip-draft-close-drain.test.mjs.
 *
 * No renderer injection, browser evaluation, remote debugging, private auth
 * seeding, production test hooks, GPU/security/permission changes, lock removal,
 * numeric PID signals, or crash command. Native failures preserve the owned
 * process until an operator normally quits it. Media timeouts may stop only the
 * helper's exact owned media ChildProcess. Every child stream goes directly to an
 * owned private file descriptor; there are no pipe-text collectors.
 * Share report/ only, never private-runtime/, discovery, tokens, DB or media.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,readdir,lstat,open,readlink} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {clipDraftDiskSchema,LOCAL_DRAFT_LIMITS} from '@mioon/contracts/local-drafts';
import {ensurePrivateDirectory,readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile} from '../packages/contracts/src/private-storage.ts';
import {openStore,ownsStoreLock} from '../packages/business/src/db.ts';
import {createServices,hash as businessHash} from '../packages/business/src/services.ts';
import {createProviderRegistry} from '../packages/business/src/provider-registry.ts';
import {createLocalDrafts} from '../packages/business/src/local-drafts.ts';
import {createTimelineRecoveryBoundary} from '../packages/business/src/timeline-recovery.ts';
import {createWorkspacePreferences} from '../packages/business/src/workspace-preferences.ts';
import {defaultWorkspaceState} from '../apps/web/src/workspace-state.ts';
import {ownQaChild} from './agent-timeline-move-qa-native.mjs';

const repo=fileURLToPath(new URL('../',import.meta.url)),scenario=process.env.MIOON_CLIP_CLOSE_QA_SCENARIO||'recovery';
assert.ok(['recovery','capacity'].includes(scenario),'Unexpected synthetic close scenario');
const evidence=path.join(repo,'evidence/clip-close'),root=path.join(evidence,scenario==='capacity'?'native-capacity':'native');
const runtime=path.join(root,'private-runtime'),report=path.join(root,'report'),userData=path.join(runtime,'user-data'),workspace=path.join(userData,'workspace');
const executable=path.join(repo,'release/desktop/production/linux-unpacked/mioon'),asar=path.join(path.dirname(executable),'resources/app.asar');
const fixtureFile=path.join(runtime,'fixture.json'),sidecarFile=path.join(workspace,'local-drafts-v1.json'),lockFile=path.join(workspace,'server.lock');
const sha=value=>createHash('sha256').update(value).digest('hex'),json=value=>JSON.stringify(value,null,2)+'\n';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),safeLabel=value=>typeof value==='string'&&/^[a-z0-9-]{1,60}$/.test(value);
const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
const recoveryScreens=['01-saved-clip','02-close-confirmation','03-discovered-draft','04-restored-form','05-clip-saved','06-export-succeeded','07-normal-reopen'];
const capacityScreens=['01-saved-clip','02-capacity-refusal','03-close-unconfirmed','04-continue-editing','05-abandon-confirmation','06-input-abandoned','07-normal-reopen'];
async function exists(file){try{await lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
function readJson(file,maxBytes=4*1024*1024){return JSON.parse(readPrivateFile(file,{maxBytes,private:true,encoding:'utf8'}));}
async function writeReport(name,value){assert.match(name,/^[a-z0-9-]+\.json$/);ensurePrivateDirectory(report);const contents=json(value);
 assert.ok(Buffer.byteLength(contents)<=4*1024*1024,'Report size limit');await writeFile(path.join(report,name),contents,{mode:0o600,flag:'wx'});}
async function fileHash(file,maxBytes=512*1024*1024){
 const before=await lstat(file);assert.ok(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size<=maxBytes,'Unexpected evidence file');
 const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);const after=await lstat(file);
 for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])assert.equal(after[key],before[key],'Evidence changed while hashing');return {bytes:before.size,sha256:hash.digest('hex')};
}
async function packageHashes(){return {executable:await fileHash(executable),asar:await fileHash(asar)};}
function environment(){return {...Object.fromEntries(['PATH','HOME','LANG','LC_ALL','DISPLAY','XAUTHORITY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','TMPDIR']
 .filter(key=>typeof process.env[key]==='string').map(key=>[key,process.env[key]])),MIOON_DESKTOP_USER_DATA:userData,MIOON_ENABLE_LIVE_PROVIDER:'0',MIOON_FFMPEG_PATH:'/usr/bin/ffmpeg',MIOON_FFPROBE_PATH:'/usr/bin/ffprobe'};}
async function mediaCommand(binary,args,label){
 assert.ok(['/usr/bin/ffmpeg','/usr/bin/ffprobe'].includes(binary));assert.ok(safeLabel(label));
 const stdout=await open(path.join(runtime,label+'.stdout'),'wx',0o600);let stderr,owned,timer;
 try{stderr=await open(path.join(runtime,label+'.stderr'),'wx',0o600);owned=ownQaChild(spawn(binary,args,{cwd:repo,env:environment(),stdio:['ignore',stdout.fd,stderr.fd]}));
  const result=await Promise.race([owned.done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Bounded synthetic media command timed out')),60000);})]);assert.deepEqual(result,{code:0,signal:null});return result;
 }catch(error){if(owned&&!owned.closed)await owned.stop();throw error;}finally{clearTimeout(timer);await stdout.close();await stderr?.close();}
}
function fixture(){for(const directory of [root,runtime,report,userData,workspace])ensurePrivateDirectory(directory);const value=readJson(fixtureFile,128*1024);
 assert.equal(value.synthetic,true);assert.equal(value.kind,'clip-close');assert.equal(value.scenario,scenario);assert.equal(value.workspace,workspace);assert.equal(value.repo,repo);return value;}
function sidecar(){const info=validateManagedFile(sidecarFile,{root:workspace,allowMissing:true,private:true,maxBytes:LOCAL_DRAFT_LIMITS.envelopeBytes});
 const bytes=readPrivateFile(sidecarFile,{root:workspace,allowMissing:true,private:true,maxBytes:LOCAL_DRAFT_LIMITS.envelopeBytes});
 return bytes===null?null:{disk:clipDraftDiskSchema.parse(JSON.parse(bytes.toString('utf8'))),bytes:bytes.length,sha256:sha(bytes),mode:info.mode&0o777};}
function lockSnapshot(){const info=validateManagedFile(lockFile,{root:workspace,allowMissing:true,private:true,maxBytes:64});if(!info)return null;
 const bytes=readPrivateFile(lockFile,{root:workspace,private:true,maxBytes:64});assert.match(bytes.toString('utf8'),/^[1-9][0-9]{0,9}$/);
 return {pid:Number(bytes.toString('utf8')),sha256:sha(bytes),dev:String(info.dev),ino:String(info.ino)};}
async function namespaces(){return {pid:await readlink('/proc/self/ns/pid'),network:await readlink('/proc/self/ns/net')};}
async function processStat(pid){assert.ok(Number.isSafeInteger(pid)&&pid>0);try{const raw=await readFile('/proc/'+pid+'/stat','utf8');assert.ok(raw.length<8192);
 const fields=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);return {state:fields[0],parentPid:Number(fields[1]),startTicks:fields[19]};
 }catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return null;throw error;}}
async function safeConnection(){
 // Discovery may name a private tokenFile. Neither it nor a credential is read,
 // copied into a report, sent to a provider, or used to drive a business API.
 const value=readJson(path.join(userData,'mcp-connection.json'),4096),url=new URL(value.url);assert.equal(value.version,1);assert.equal(value.channel,'production');
 assert.equal(url.protocol,'http:');assert.equal(url.hostname,'127.0.0.1');for(const field of ['username','password','search','hash'])assert.equal(url[field],'');
 assert.ok(Number.isSafeInteger(value.pid)&&value.pid>0);const port=Number(url.port);assert.ok(Number.isSafeInteger(port)&&port>0&&port<=65535);
 return {origin:url.origin,port,backendPid:value.pid,channel:value.channel,namespaces:await namespaces()};
}
async function health(origin){try{const response=await fetch(origin+'/health',{signal:AbortSignal.timeout(1500),redirect:'error'}),status=response.status;await response.body?.cancel();return {status,error:null};}
 catch(error){return {status:null,error:error.cause?.code||error.name};}}
async function waitConnection(owned,previous){for(const deadline=Date.now()+120000;Date.now()<deadline;){
 if(owned.closed)throw Error('Packaged process exited before native readiness');
 if(await exists(path.join(userData,'mcp-connection.json'))){const connection=await safeConnection(),lock=lockSnapshot();
  if((!previous||connection.backendPid!==previous.backendPid)&&lock?.pid===connection.backendPid&&await processStat(connection.backendPid)){
   const probe=await health(connection.origin);if(probe.status===200)return {...connection,health:probe};}}
 await pause(200);}throw Error('Native startup readiness was not confirmed');}
const rawFor=clip=>Object.fromEntries(['name','trackId','startFrame','durationFrames','sourceInFrame','rect','gain','fadeInFrames','fadeOutFrames'].filter(key=>Object.hasOwn(clip,key)).map(key=>[key,structuredClone(clip[key])]));
function draftRow(result,prepared){const entries=result.sidecar?.disk.entries??[];assert.equal(entries.length,1);const row=entries[0];
 for(const key of ['projectId','timelineId','clipId'])assert.equal(row[key],prepared[key]);return row;}
function assertDraft(result,prepared){const row=draftRow(result,prepared);assert.ok(row.revision>=1);assert.equal(row.draft.baseRevision,prepared.baseRevision);
 assert.deepEqual(row.draft.source,{assetId:prepared.assetId,assetSha256:prepared.sourceSha256});assert.deepEqual(row.draft.raw,{...rawFor(prepared.originalClip),name:prepared.expectedName});assert.equal(result.sidecar.mode,0o600);}
function assertCapacity(result,prepared){assert.equal(result.sidecar?.disk.entries.length,128);assert.equal(result.sidecar.mode,0o600);
 assert.ok(result.sidecar.disk.entries.every(row=>row.draft===null&&row.revision===2&&row.projectId===prepared.projectId&&row.timelineId===prepared.timelineId&&row.clipId!==prepared.clipId));}
function assertSavedTimeline(result,prepared){assert.equal(result.timelines.length,1);const expected=structuredClone(prepared.expectedTimeline),actual=result.timelines[0];
 expected.revision++;expected.updatedAt=actual.updatedAt;expected.clips[0].name=prepared.expectedName;assert.deepEqual(actual,expected,'Only the saved name/revision/timestamp may change');}
function unchanged(result,before,{allowPreferences=false}={}){assert.equal(result.schemaSha256,before.schemaSha256);assert.deepEqual(Object.keys(result.tables),Object.keys(before.tables));
 for(const name of Object.keys(before.tables))if(!(allowPreferences&&name==='workspace_preferences'))assert.deepEqual(result.tables[name],before.tables[name],`Unexpected change in ${name}`);
 assert.deepEqual(result.media,before.media);assert.deepEqual(result.timelines,before.timelines);}
function retainedRows(result,before,name,added){assert.equal(result.tables[name].count,before.tables[name].count+added,`Unexpected ${name} count`);
 for(const digest of before.tables[name].rowSha256)assert.ok(result.tables[name].rowSha256.includes(digest),`Existing ${name} row changed`);}
function tableDigest(rows){return {count:rows.length,sha256:sha(JSON.stringify(rows)),rowSha256:rows.map(row=>sha(JSON.stringify(row)))};}
function snapshot(timeline){return {tracks:timeline.tracks,clips:timeline.clips,durationFrames:timeline.durationFrames,...(Object.hasOwn(timeline,'subtitles')?{subtitles:timeline.subtitles}:{})};}

async function prepare(){
 assert.equal(process.platform,'linux');assert.equal(await exists(root),false,'Fixture already exists; no overwrite or cleanup permitted');
 for(const directory of [root,runtime,report,userData])ensurePrivateDirectory(directory,{create:true});
 await writeFile(path.join(runtime,'prepare-claim.json'),json({synthetic:true,scenario,id:randomUUID()}),{mode:0o600,flag:'wx'});
 const source=path.join(runtime,'synthetic-green-880hz.mp4');
 await mediaCommand('/usr/bin/ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=0x18bf57:s=320x180:r=30:d=2',
  '-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=2','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-ac','2','-shortest','-movflags','+faststart','-n',source],'source-media');
 process.env.MIOON_FFMPEG_PATH='/usr/bin/ffmpeg';process.env.MIOON_FFPROBE_PATH='/usr/bin/ffprobe';
 const env={MIOON_ENABLE_LIVE_PROVIDER:'0'},store=openStore(workspace),providers=createProviderRegistry({db:store.db,root:workspace,env}),services=createServices(store,providers,{env});let value;
 try{
  const project=await services.call('project.create',{name:scenario==='capacity'?'片段关闭 · 容量拒绝合成验收':'片段关闭 · 正常退出恢复合成验收'});
  let timeline=await services.call('timeline.format.set',{projectId:project.id,expectedProjectRevision:project.revision,expectedRevision:0,requestId:randomUUID(),presetId:'landscape_720'});
  const asset=await services.call('asset.import',{projectId:project.id,name:'合成绿色画面与 880Hz.mp4',mimeType:'video/mp4',dataBase64:(await readFile(source)).toString('base64')});
  timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:asset.id,
   trackId:timeline.tracks.find(track=>track.kind==='video').id,startFrame:0,durationFrames:60,name:'Original saved clip'});
  if(scenario==='capacity'){
   const drafts=createLocalDrafts({root:workspace,channel:'production',storage:{readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile},
    guards:{ownsLock:()=>ownsStoreLock(store),isRestored:()=>false,readTimeline:id=>createTimelineRecoveryBoundary(store.db,{projectId:id}).read(),readClipAsset:(id,clip)=>createTimelineRecoveryBoundary(store.db,{projectId:id}).clipSource(clip)}});
   assert.equal(LOCAL_DRAFT_LIMITS.slots,128);
   // All retained tombstones come from the real service and exact CAS discard.
   // No direct sidecar write, fabricated authority, or backend test switch.
   for(let index=0;index<128;index++){
    timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:asset.id,
     trackId:timeline.tracks.find(track=>track.kind==='video').id,startFrame:60,durationFrames:1,name:'Synthetic retained slot '+index});
    const padding=timeline.clips.find(clip=>clip.startFrame===60),key={projectId:project.id,timelineId:timeline.id,clipId:padding.id},current=drafts.get(key);
    const written=drafts.put({...key,workspaceScope:current.workspaceScope,instanceId:current.instanceId,expectedRevision:current.revision,baseRevision:timeline.revision,
     source:{assetId:asset.id,assetSha256:asset.sha256},raw:rawFor(padding)});
    const discarded=drafts.discard({...key,workspaceScope:written.workspaceScope,instanceId:written.instanceId,expectedRevision:written.revision});assert.equal(discarded.draft,null);assert.equal(discarded.revision,2);
    timeline=await services.call('timeline.clip.remove',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),clipId:padding.id});
   }
  }else assert.equal(await exists(sidecarFile),false,'Recovery preparation must not seed a draft');
  assert.equal(timeline.clips.length,1);assert.equal(timeline.durationFrames,60);const clip=timeline.clips[0],state=defaultWorkspaceState();
  delete state.shared.assetSearch;state.canvas.viewport={x:0,y:0,zoom:1};state.activeMode='editing';state.editing.selectedClipId=clip.id;state.editing.quickAssetId=null;state.editing.previewKind='source';
  createWorkspacePreferences(store).put(project.id,{expectedRevision:0,state});
  value={synthetic:true,kind:'clip-close',scenario,id:randomUUID(),repo,workspace,projectId:project.id,projectName:project.name,timelineId:timeline.id,clipId:clip.id,
   assetId:asset.id,baseRevision:timeline.revision,originalClip:clip,expectedTimeline:timeline,expectedName:scenario==='capacity'?'Capacity-refused current input':'Close-recovered draft',
   sourceSha256:asset.sha256,sourceFile:await fileHash(source),initialSidecarAbsent:scenario==='recovery',packageHashes:await packageHashes()};
 }finally{try{await services.drain();}finally{store.close();}}
 await writeFile(fixtureFile,json(value),{mode:0o600,flag:'wx'});const {workspace:privateWorkspace,repo:privateRepo,...sanitized}=value;
 await writeReport('fixture.json',sanitized);await audit('prepared');
 const native={version:1,fixtureId:value.id,scenario,screenshotsReviewed:null,syntheticDesktopOnly:null,
  screenshots:(scenario==='capacity'?capacityScreens:recoveryScreens).map(name=>name+'.jpg'),
  ...(scenario==='capacity'?{refusedName:null,capacityMessage:null,quitWarning:{title:null,message:null,detail:null,selectedButton:null},continuedSameInput:null,
   abandonAction:null,abandonConfirmation:null,confirmedAbandon:null,recordRetainedNotice:null,reopenedOriginalName:null}:
   {typedName:null,noWaitForDraftNotice:null,ordinaryQuitRequested:null,quitConfirmation:{title:null,message:null,detail:null,selectedButton:null},
    recoveryWasDiscovered:null,explicitRestoreClicked:null,restoredName:null,saveClipClicks:null,exportConfirmations:null,reopenedSavedName:null}),
  timing:{inputToQuitUpperBoundMs:null,measurementSource:null},
  note:'Fill only observed native facts; screenshots alone or helper invocation timestamps do not prove input-to-Quit <250 ms.'};
 await writeFile(path.join(runtime,'native-observations.json'),json(native),{mode:0o600,flag:'wx'});
 for(const label of scenario==='capacity'?['first','reopen']:['first','reopen','final'])await writeFile(path.join(runtime,'launch-'+label+'.sh'),
  `#!/bin/bash\nset -e\ncd ${quote(repo)}\nexport MIOON_CLIP_CLOSE_QA_SCENARIO=${quote(scenario)}\nexec ${quote(process.execPath)} tests/clip-close-qa-native.mjs launch ${label}\n`,{mode:0o700,flag:'wx'});
 return sanitized;
}
function readDatabase(){validateManagedFile(path.join(workspace,'workbench.sqlite'),{root:workspace,maxBytes:32*1024*1024});
 const db=new DatabaseSync(path.join(workspace,'workbench.sqlite'),{readOnly:true}),rows={};let schema;
 try{db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name LIMIT 513').all();assert.ok(schema.length<=512);
  const tables=schema.filter(item=>item.type==='table');assert.ok(tables.length<=128);for(const {name} of tables){assert.match(name,/^[a-z_]+$/);
   rows[name]=db.prepare(`SELECT * FROM "${name}" ORDER BY rowid LIMIT 1001`).all();assert.ok(rows[name].length<=1000&&Buffer.byteLength(JSON.stringify(rows[name]))<=2*1024*1024,'Synthetic table audit limit');}db.exec('COMMIT');
 }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}return {rows,schemaSha256:sha(JSON.stringify(schema))};}
async function audit(label){
 const labels=scenario==='capacity'?['prepared','first-boot','after-refusal','after-continue','after-abandon','after-close','after-reopen','capacity-final']:
  ['prepared','first-boot','after-close','after-reopen','after-restore','after-clip-save','after-clip-save-recheck','after-export','after-normal-reopen','final'];assert.ok(labels.includes(label),'Unexpected serial audit stage');
 const prepared=fixture(),{rows,schemaSha256}=readDatabase(),names=(await readdir(path.join(workspace,'media'))).sort();assert.ok(names.length<=32);const media=[];
 for(const name of names){assert.match(name,/^[a-zA-Z0-9._-]+\.(mp4|png|wav)$/);media.push({name,...await fileHash(path.join(workspace,'media',name),32*1024*1024)});}
 const tables=Object.fromEntries(Object.entries(rows).map(([name,value])=>[name,{count:value.length,sha256:sha(JSON.stringify(value)),rowSha256:value.map(item=>sha(JSON.stringify(item)))}]));
 const result={synthetic:true,at:new Date().toISOString(),scenario,label,fixtureId:prepared.id,schemaSha256,tables,logicalDatabaseSha256:sha(JSON.stringify(tables)),
  databaseHashMeaning:'All SQLite schema/table/row contents; SQLite/WAL physical pages are not a logical-data hash',timelines:rows.timelines.map(row=>JSON.parse(row.data)),
  assets:rows.assets.map(row=>JSON.parse(row.data)),exports:rows.exports.map(row=>JSON.parse(row.data)),editTasks:rows.edit_tasks.map(row=>({...row,input:JSON.parse(row.input)})),
  timelineRequests:rows.timeline_requests.map(row=>({requestId:row.requestId,requestHash:row.requestHash,response:JSON.parse(row.response)})),
  timelineHistory:rows.timeline_history.map(row=>({id:row.id,projectId:row.projectId,position:row.position,operation:row.operation,beforeSha256:businessHash(JSON.parse(row.beforeSnapshot)),afterSha256:businessHash(JSON.parse(row.afterSnapshot))})),
  historyCursors:rows.timeline_history_cursors,sidecar:sidecar(),lock:lockSnapshot(),media};
 if(label==='prepared'){assert.deepEqual(result.timelines,[prepared.expectedTimeline]);assert.equal(result.editTasks.length,0);assert.equal(result.exports.length,0);assert.equal(result.lock,null);}
 if(scenario==='capacity'){
  assertCapacity(result,prepared);assert.deepEqual(result.timelines,[prepared.expectedTimeline]);
  if(label==='first-boot'){const before=readJson(path.join(report,'prepared-audit.json'));unchanged(result,before,{allowPreferences:true});assert.deepEqual(result.sidecar,before.sidecar);}
  else if(label!=='prepared'){const before=readJson(path.join(report,'first-boot-audit.json'));unchanged(result,before);assert.deepEqual(result.sidecar,before.sidecar);}
  if(label==='after-continue'){readJson(path.join(report,'after-refusal-audit.json'));assert.equal(await exists(path.join(report,'first-exit.json')),false,'Continue Editing unexpectedly exited');
   const connection=readJson(path.join(report,'first-connection.json'));assert.equal(result.lock?.pid,connection.backendPid);assert.ok(await processStat(connection.backendPid));assert.equal((await health(connection.origin)).status,200);}
  if(label==='after-abandon')readJson(path.join(report,'after-continue-audit.json'));
 }else{
  if(['prepared','first-boot','after-close','after-reopen','after-restore'].includes(label))assert.deepEqual(result.timelines,[prepared.expectedTimeline]);else assertSavedTimeline(result,prepared);
  if(label==='prepared'||label==='first-boot'){assert.equal(result.sidecar,null);if(label==='first-boot')unchanged(result,readJson(path.join(report,'prepared-audit.json')),{allowPreferences:true});}
  if(['after-close','after-reopen','after-restore'].includes(label)){assertDraft(result,prepared);unchanged(result,readJson(path.join(report,'first-boot-audit.json')),{allowPreferences:true});
   if(label!=='after-close')assert.deepEqual(result.sidecar,readJson(path.join(report,'after-close-audit.json')).sidecar,'Discovery/restore changed durable draft bytes');}
  if(label==='after-normal-reopen'||label==='final'){const before=readJson(path.join(report,'after-export-audit.json'));unchanged(result,before,{allowPreferences:true});assert.deepEqual(result.sidecar,before.sidecar);}
 }
 if(label==='first-boot'){const connection=readJson(path.join(report,'first-connection.json'));assert.equal(result.lock?.pid,connection.backendPid);}
 if(label==='after-close'){const exit=readJson(path.join(report,'first-exit.json'));assertNormalExit(exit);assert.equal(result.lock,null);if(scenario==='capacity')readJson(path.join(report,'after-abandon-audit.json'));}
 await writeReport(label+'-audit.json',result);return result;
}
function assertNormalExit(exit){assert.deepEqual(exit.result,{code:0,signal:null});assert.deepEqual(exit.childSignals,[]);assert.equal(exit.backendLockReleased,true);assert.equal(exit.backendProcessAbsent,true);assert.equal(exit.health.error,'ECONNREFUSED');assert.deepEqual(exit.endedPackageHashes,exit.packageHashes);}
async function observeClosed(connection){let lock,stat,probe;
 for(const deadline=Date.now()+45000;;){lock=lockSnapshot();stat=await processStat(connection.backendPid);probe=await health(connection.origin);
  if((lock===null&&stat===null&&probe.error==='ECONNREFUSED')||Date.now()>=deadline)break;await pause(250);}
 return {backendLockReleased:lock===null,backendProcessAbsent:stat===null,remainingLock:lock,remainingBackendStat:stat,health:probe};}
async function launch(label){
 assert.equal(process.platform,'linux');assert.ok((scenario==='capacity'?['first','reopen']:['first','reopen','final']).includes(label));const prepared=fixture();let previous=null;
 assert.equal(await exists(path.join(report,label+'-launch.json')),false,'Launch evidence already exists');assert.equal(lockSnapshot(),null,'Only normal cleanup may release the lock; never delete it');
 if(label==='first'){assert.equal(await exists(path.join(userData,'mcp-connection.json')),false);if(scenario==='recovery')assert.equal(sidecar(),null);else assertCapacity({sidecar:sidecar()},prepared);}
 else{const prior=label==='reopen'?'first':'reopen';assertNormalExit(readJson(path.join(report,prior+'-exit.json')));previous=readJson(path.join(report,prior+'-connection.json'));
  assert.deepEqual(await namespaces(),previous.namespaces,'Native launches and audits must share namespaces');
  if(label==='reopen')readJson(path.join(report,'after-close-audit.json'));else readJson(path.join(report,'export-verification.json'));}
 const hashes=await packageHashes();assert.deepEqual(hashes,prepared.packageHashes,'Packaged bits changed after fixture preparation');
 const log=await open(path.join(runtime,label+'-native.log'),'wx',0o600);let owned,initial,connection;
 try{
  owned=ownQaChild(spawn(executable,[],{cwd:repo,env:environment(),stdio:['ignore',log.fd,log.fd]}));
  initial={synthetic:true,scenario,fixtureId:prepared.id,launchId:randomUUID(),label,at:new Date().toISOString(),mainPid:owned.child.pid,argv:[],packageHashes:hashes,namespaces:await namespaces(),sandboxUnchanged:true,gpuUnchanged:true,debugging:false};
  await writeReport(label+'-launch.json',initial);connection=await waitConnection(owned,previous);
  if(previous){assert.notEqual(connection.backendPid,previous.backendPid);assert.notEqual(connection.port,previous.port,'Fresh-origin acceptance needs a different port');}
  await writeReport(label+'-connection.json',{synthetic:true,label,launchId:initial.launchId,at:new Date().toISOString(),...connection});
  let windowReported=false;const deadline=Date.now()+30*60*1000;
  while(!owned.closed){if(!windowReported&&Date.now()>=deadline){windowReported=true;
    await writeReport(label+'-observation-window-ended.json',{synthetic:true,label,fixtureId:prepared.id,normalQuitStillRequired:true,childSignals:[],message:'No forced cleanup; operator must normally quit the still-owned native app.'});}
   await pause(200);}
  const result=await owned.done,closed=await observeClosed(connection),endedPackageHashes=await packageHashes();
  const exit={...initial,endedAt:new Date().toISOString(),result,childSignals:[],...closed,endedPackageHashes};await writeReport(label+'-exit.json',exit);assertNormalExit(exit);
  assert.equal(windowReported,false,'Native observation window ended; this run is not an acceptance pass');
 }catch(error){
  // Retain the exact native ChildProcess handle. Never turn a failing close test
  // into a forced-exit pass, detach it, kill a PID, or remove its workspace lock.
  if(owned&&!owned.closed){await writeReport(label+'-blocked.json',{synthetic:true,label,fixtureId:prepared.id,normalQuitRequired:true,nativeSignalsSent:0,errorCode:error.code||'NATIVE_QA_CHECK_FAILED'});await owned.done;}
  throw error;
 }finally{await log.close();}
}
async function verifyClipSave({recheck=false}={}){
 assert.equal(scenario,'recovery');const prepared=fixture(),before=readJson(path.join(report,'after-restore-audit.json'));let result,reverification;
 if(recheck){
  // A verifier correction never overwrites the first observation or replays UI
  // Save. Read the current DB/sidecar/media once into a new immutable report and
  // prove its business state still equals the original failed-verifier snapshot.
  assert.equal(await exists(path.join(report,'clip-save-verification.json')),false,'Existing verification must not be overwritten');
  const originalFile=path.join(report,'after-clip-save-audit.json'),original=readJson(originalFile);assert.equal(original.fixtureId,prepared.id);assert.equal(original.label,'after-clip-save');
  result=await audit('after-clip-save-recheck');unchanged(result,original,{allowPreferences:true});assert.deepEqual(result.sidecar,original.sidecar);
  reverification={originalAudit:await fileHash(originalFile,4*1024*1024),recheckAudit:await fileHash(path.join(report,'after-clip-save-recheck-audit.json'),4*1024*1024),
   originalAuditPreserved:true,allBusinessTablesSidecarAndMediaUnchanged:true,viewPreferencesMayChange:true,businessRequestsSent:0};
 }else result=await audit('after-clip-save');
 assertSavedTimeline(result,prepared);
 const prior=draftRow(before,prepared),current=draftRow(result,prepared);assert.equal(current.draft,null);assert.equal(current.revision,prior.revision+1,'Only exact acknowledged draft may be cleared');
 assert.equal(result.schemaSha256,before.schemaSha256);assert.deepEqual(result.media,before.media);assert.equal(result.exports.length,0);assert.equal(result.editTasks.length,1);
 const task=result.editTasks[0];assert.equal(task.position,1,'This fixture must contain only its first durable edit task');assert.equal(task.status,'applied');assert.equal(task.acknowledged,1);assert.equal(task.origin,'new');assert.equal(task.operation,'timeline.clip.update');assert.equal(task.projectId,prepared.projectId);
 assert.deepEqual(task.input,{projectId:prepared.projectId,expectedRevision:prepared.baseRevision,requestId:task.requestId,clipId:prepared.clipId,patch:{...rawFor(prepared.originalClip),name:prepared.expectedName}});
 assert.equal(task.digest,businessHash({operation:'timeline.clip.update',input:task.input}));assert.equal(task.receiptDigest,businessHash(result.timelines[0]));
 const requests=result.timelineRequests.filter(item=>!before.timelineRequests.some(prior=>prior.requestId===item.requestId));assert.equal(requests.length,1);const receipt=requests[0];
 assert.equal(receipt.requestId,task.requestId);assert.equal(receipt.requestHash,task.digest);assert.deepEqual(receipt.response,result.timelines[0]);
 const addedHistory=result.timelineHistory.filter(item=>!before.timelineHistory.some(prior=>prior.id===item.id));assert.equal(addedHistory.length,1);const history=addedHistory[0];
 assert.equal(history.projectId,prepared.projectId);assert.equal(history.operation,'timeline.clip.update');assert.equal(history.beforeSha256,businessHash(snapshot(prepared.expectedTimeline)));assert.equal(history.afterSha256,businessHash(snapshot(result.timelines[0])));
 assert.equal(result.historyCursors.length,1);assert.equal(before.historyCursors.length,1);assert.equal(result.historyCursors[0].projectId,prepared.projectId);assert.equal(result.historyCursors[0].position,before.historyCursors[0].position+1);assert.equal(history.position,result.historyCursors[0].position);
 for(const name of Object.keys(before.tables)){
  if(['edit_tasks','timeline_requests','timeline_history'].includes(name))retainedRows(result,before,name,1);
  else if(['timelines','timeline_history_cursors'].includes(name))assert.equal(result.tables[name].count,before.tables[name].count);
  else if(name==='sqlite_sequence'){
   // First edit_tasks insertion advances precisely this AUTOINCREMENT sequence.
   // Exact complete-table digests reject any other sequence row or high-water mark.
   assert.deepEqual(before.tables[name],tableDigest([]),'Unexpected pre-save sequence');
   assert.deepEqual(result.tables[name],tableDigest([{name:'edit_tasks',seq:1}]),'Unexpected save sequence change');
  }
  else if(name!=='workspace_preferences')assert.deepEqual(result.tables[name],before.tables[name],`Unexpected clip save in ${name}`);
 }
 const verification={synthetic:true,fixtureId:prepared.id,at:new Date().toISOString(),editTaskId:task.id,requestId:task.requestId,frozenInput:task.input,
  revisionBefore:prepared.baseRevision,revisionAfter:result.timelines[0].revision,onlyBusinessChanges:{timelines:1,edit_tasks:1,timeline_requests:1,timeline_history:1,timeline_history_cursors:1},
  sqliteSequence:{before:[],after:[{name:'edit_tasks',seq:1}],noUnrelatedSequenceChanges:true},...(reverification?{readOnlyReverification:reverification}:{}),
  exactDraftCleared:true,unrelatedClipFieldsUnchanged:true,originalMediaUnchanged:true};await writeReport('clip-save-verification.json',verification);return verification;
}
async function verifyExport(){
 assert.equal(scenario,'recovery');const prepared=fixture(),before=readJson(path.join(report,'after-clip-save-audit.json'));readJson(path.join(report,'clip-save-verification.json'));
 const pending=readDatabase().rows.exports.map(row=>JSON.parse(row.data));assert.equal(pending.length,1);assert.equal(pending[0].status,'succeeded','Wait for the one native export to succeed');
 const result=await audit('after-export'),exported=result.exports[0];assert.deepEqual(result.sidecar,before.sidecar);assert.deepEqual(result.timelines,before.timelines);assert.deepEqual(result.editTasks,before.editTasks);assert.equal(result.schemaSha256,before.schemaSha256);
 assert.deepEqual(result.tables.sqlite_sequence,tableDigest([{name:'edit_tasks',seq:1}]),'Timeline export must not allocate any AUTOINCREMENT identity');
 assert.deepEqual(result.tables.sqlite_sequence,before.tables.sqlite_sequence);
 assert.equal(exported.purpose,'export');assert.equal(exported.mode,'timeline');assert.equal(exported.projectId,prepared.projectId);assert.equal(exported.timelineRevision,prepared.baseRevision+1);assert.deepEqual(exported.snapshot.timeline,result.timelines[0]);
 for(const name of Object.keys(before.tables))if(['assets','exports','timeline_requests'].includes(name))retainedRows(result,before,name,1);else if(name!=='workspace_preferences')assert.deepEqual(result.tables[name],before.tables[name],`Unexpected export change in ${name}`);
 const requests=result.timelineRequests.filter(item=>!before.timelineRequests.some(prior=>prior.requestId===item.requestId));assert.equal(requests.length,1);const receipt=requests[0];assert.equal(receipt.requestId,exported.requestId);assert.notEqual(receipt.requestId,result.editTasks[0].requestId);assert.equal(receipt.response.id,exported.id);assert.equal(receipt.response.status,'queued');assert.deepEqual(receipt.response.snapshot,exported.snapshot);
 for(const original of before.media)assert.deepEqual(result.media.find(item=>item.name===original.name),original);assert.equal(result.media.length,before.media.length+1);
 const asset=result.assets.find(item=>item.id===exported.assetId);assert.ok(asset);assert.equal(asset.projectId,prepared.projectId);assert.equal(asset.provenance,'export');assert.match(asset.relativePath,/^media\/[a-zA-Z0-9._-]+\.mp4$/);
 const file=path.join(workspace,asset.relativePath),output=await fileHash(file,32*1024*1024);assert.equal(output.sha256,asset.sha256);
 await mediaCommand('/usr/bin/ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],'export-probe');const probe=readJson(path.join(runtime,'export-probe.stdout')),video=probe.streams.find(stream=>stream.codec_type==='video'),audio=probe.streams.find(stream=>stream.codec_type==='audio');
 assert.ok(video&&audio);assert.equal(video.width,1280);assert.equal(video.height,720);assert.equal(video.r_frame_rate,'30/1');assert.equal(Number(video.nb_frames),60);assert.equal(audio.sample_rate,'48000');
 await mediaCommand('/usr/bin/ffmpeg',['-v','error','-i',file,'-f','null','-'],'export-decode');
 const verification={synthetic:true,fixtureId:prepared.id,at:new Date().toISOString(),exportId:exported.id,assetId:asset.id,requestId:exported.requestId,onlyAddedBusinessRows:{assets:1,exports:1,timeline_requests:1},
  originalMediaUnchanged:true,clipSaveReceiptUnchanged:true,output,video:{width:video.width,height:video.height,rate:video.r_frame_rate,frames:Number(video.nb_frames)},audio:{codec:audio.codec_name,sampleRate:audio.sample_rate},decodeExit:0};
 await writeReport('export-verification.json',verification);return verification;
}
async function nativeEvidence(prepared){
 const value=readJson(path.join(runtime,'native-observations.json'),64*1024);assert.equal(value.version,1);assert.equal(value.fixtureId,prepared.id);assert.equal(value.scenario,scenario);
 assert.equal(value.screenshotsReviewed,true);assert.equal(value.syntheticDesktopOnly,true);const names=scenario==='capacity'?capacityScreens:recoveryScreens;assert.deepEqual(value.screenshots,names.map(name=>name+'.jpg'));
 const text=(input,label)=>{assert.ok(typeof input==='string'&&input.length>0&&input.length<=2000,`Missing bounded native observation: ${label}`);return input;};
 let observations;
 if(scenario==='capacity'){
  assert.equal(value.refusedName,prepared.expectedName);assert.match(text(value.capacityMessage,'capacityMessage'),/容量已满/);assert.equal(value.continuedSameInput,true);
  const warning=Object.fromEntries(['title','message','detail','selectedButton'].map(key=>[key,text(value.quitWarning[key],'quitWarning.'+key)]));assert.equal(warning.selectedButton,'继续编辑');
  assert.match(warning.title+warning.message+warning.detail,/草稿/);assert.match(warning.title+warning.message+warning.detail,/视图|位置/);assert.match(warning.title+warning.message+warning.detail,/未确认|尚未/);
  assert.equal(value.abandonAction,'放弃当前输入，保留草稿记录');assert.match(text(value.abandonConfirmation,'abandonConfirmation'),/不会删除|不删除/);assert.equal(value.confirmedAbandon,true);
  assert.match(text(value.recordRetainedNotice,'recordRetainedNotice'),/保留/);assert.equal(value.reopenedOriginalName,prepared.originalClip.name);
  observations={refusedName:value.refusedName,capacityMessage:value.capacityMessage,quitWarning:warning,continuedSameInput:true,abandonAction:value.abandonAction,abandonConfirmation:value.abandonConfirmation,confirmedAbandon:true,recordRetainedNotice:value.recordRetainedNotice,reopenedOriginalName:value.reopenedOriginalName};
 }else{
  assert.equal(value.typedName,prepared.expectedName);assert.equal(value.noWaitForDraftNotice,true);assert.equal(value.ordinaryQuitRequested,true);assert.equal(value.recoveryWasDiscovered,true);assert.equal(value.explicitRestoreClicked,true);
  assert.equal(value.restoredName,prepared.expectedName);assert.equal(value.saveClipClicks,1);assert.equal(value.exportConfirmations,1);assert.equal(value.reopenedSavedName,prepared.expectedName);
  const confirmation=Object.fromEntries(['title','message','detail','selectedButton'].map(key=>[key,text(value.quitConfirmation[key],'quitConfirmation.'+key)]));
  observations={typedName:value.typedName,noWaitForDraftNotice:true,ordinaryQuitRequested:true,quitConfirmation:confirmation,recoveryWasDiscovered:true,explicitRestoreClicked:true,restoredName:value.restoredName,saveClipClicks:1,exportConfirmations:1,reopenedSavedName:value.reopenedSavedName};
 }
 let timing=null;if(value.timing?.inputToQuitUpperBoundMs!==null){assert.ok(Number.isFinite(value.timing.inputToQuitUpperBoundMs)&&value.timing.inputToQuitUpperBoundMs>=0);timing={operatorReportedUpperBoundMs:value.timing.inputToQuitUpperBoundMs,measurementSource:text(value.timing.measurementSource,'measurementSource')};}
 const screenshots=[];for(const name of names){const file=path.join(report,name+'.jpg');const digest=await fileHash(file,32*1024*1024),handle=await open(file,'r');
  try{const bytes=Buffer.alloc(3);await handle.read(bytes,0,3,0);assert.equal(bytes.toString('hex'),'ffd8ff');}finally{await handle.close();}screenshots.push({name:name+'.jpg',...digest});}
 return {observations,screenshots,timing,nativeInputToQuitUnder250msIndependentlyVerified:false,nativePreDebounceCausalityProved:false,
  timingLimit:'No native event instrumentation or causal debounce claim. Native recovery and deterministic mock-timer causality are separate evidence.'};
}
async function final(){
 const prepared=fixture(),last=scenario==='capacity'?'reopen':'final';for(const deadline=Date.now()+45000;!await exists(path.join(report,last+'-exit.json'))&&Date.now()<deadline;)await pause(100);
 assert.equal(await exists(path.join(report,last+'-exit.json')),true);assert.equal(lockSnapshot(),null);const native=await nativeEvidence(prepared);
 const result=await audit(scenario==='capacity'?'capacity-final':'final'),baseline=readJson(path.join(report,'prepared-audit.json')),firstBoot=readJson(path.join(report,'first-boot-audit.json'));
 unchanged(firstBoot,baseline,{allowPreferences:true});const labels=scenario==='capacity'?['first','reopen']:['first','reopen','final'],launches=[],connections=[],exits=[];const hashes=await packageHashes();assert.deepEqual(hashes,prepared.packageHashes);
 for(const label of labels){const launch=readJson(path.join(report,label+'-launch.json')),connection=readJson(path.join(report,label+'-connection.json')),exit=readJson(path.join(report,label+'-exit.json'));
  assert.equal(launch.fixtureId,prepared.id);assert.equal(connection.launchId,launch.launchId);assertNormalExit(exit);assert.deepEqual(launch.packageHashes,hashes);assert.deepEqual(exit.endedPackageHashes,hashes);launches.push(launch);connections.push(connection);exits.push(exit);}
 assert.equal(new Set(connections.map(item=>item.port)).size,connections.length);assert.equal(new Set(connections.map(item=>item.backendPid)).size,connections.length);
 let acceptance;
 if(scenario==='capacity'){
  for(const label of ['after-refusal','after-continue','after-abandon','after-close','after-reopen','capacity-final']){const observed=label==='capacity-final'?result:readJson(path.join(report,label+'-audit.json'));unchanged(observed,firstBoot);assert.deepEqual(observed.sidecar,baseline.sidecar);assertCapacity(observed,prepared);}
  acceptance={retainedSlots:128,tombstonesCreatedThroughRealDraftService:true,allDatabaseTablesUnchangedAfterFirstBoot:true,sidecarBytesUnchangedFromPreparation:true,originalMediaUnchanged:true,
   noBusinessSaveOrExport:true,continueEditingKeptBackendAlive:true,explicitAbandonKeptRecords:true,preparedToFirstBootPreferencesUnchanged:JSON.stringify(firstBoot.tables.workspace_preferences)===JSON.stringify(baseline.tables.workspace_preferences)};
 }else{
  for(const label of ['after-close','after-reopen','after-restore']){const observed=readJson(path.join(report,label+'-audit.json'));assertDraft(observed,prepared);unchanged(observed,firstBoot,{allowPreferences:true});}
  const closed=readJson(path.join(report,'after-close-audit.json'));for(const label of ['after-reopen','after-restore'])assert.deepEqual(readJson(path.join(report,label+'-audit.json')).sidecar,closed.sidecar);
  const exported=readJson(path.join(report,'after-export-audit.json')),reopened=readJson(path.join(report,'after-normal-reopen-audit.json'));unchanged(reopened,exported,{allowPreferences:true});assert.deepEqual(reopened.sidecar,exported.sidecar);
  acceptance={normalCloseRecoveredExactName:true,discoveryAndExplicitRestoreHadZeroBusinessWrites:true,exactlyOneClipSave:true,exactlyOneTimelineExport:true,unrelatedClipFieldsUnchanged:true,originalMediaUnchanged:true,
   clipSaveVerification:readJson(path.join(report,'clip-save-verification.json')),exportVerification:readJson(path.join(report,'export-verification.json'))};
 }
 const summary={synthetic:true,kind:'clip-close',scenario,platform:'linux',productionBackend:true,fixtureId:prepared.id,packageHashes:hashes,
  nativeGuiAutomated:false,rendererInjected:false,numericPidSignals:0,nativeChildSignals:0,liveProviderEnabled:false,initialCredentialsSeeded:false,
  ...acceptance,ports:connections.map(({label,origin,port,backendPid})=>({label,origin,port,backendPid})),normalExits:exits,...native,
  separateCausalTest:'tests/clip-draft-close-drain.test.mjs; results must be reported separately, never inferred from this helper',
  deliveryScope:'Report only; exclude private-runtime, discovery, credentials, database and media'};await writeReport('summary.json',summary);return summary;
}
async function suiteFinal(){
 const recovery=readJson(path.join(evidence,'native/report/summary.json')),capacity=readJson(path.join(evidence,'native-capacity/report/summary.json'));
 assert.equal(recovery.scenario,'recovery');assert.equal(capacity.scenario,'capacity');assert.notEqual(recovery.fixtureId,capacity.fixtureId);assert.deepEqual(recovery.packageHashes,capacity.packageHashes);
 assert.equal(recovery.normalCloseRecoveredExactName,true);assert.equal(capacity.allDatabaseTablesUnchangedAfterFirstBoot,true);assert.equal(capacity.sidecarBytesUnchangedFromPreparation,true);
 const result={synthetic:true,kind:'clip-close',independentFixtures:true,packageHashes:recovery.packageHashes,recoveryFixtureId:recovery.fixtureId,capacityFixtureId:capacity.fixtureId,
  normalRecoveryPassed:true,capacityRefusalPassed:true,nativePreDebounceCausalityProved:false,causalEvidence:'Separate deterministic mock-timer tests; not a native <250 ms claim'};
 await writeReport('suite-summary.json',result);return result;
}

const [action,label,...extra]=process.argv.slice(2);assert.equal(extra.length,0);if(!['launch','audit'].includes(action))assert.equal(label,undefined);
if(action==='prepare')console.log(json(await prepare()));else if(action==='launch')await launch(label);else if(action==='audit')console.log(json(await audit(label)));
else if(action==='verify-clip-save')console.log(json(await verifyClipSave()));else if(action==='reverify-clip-save')console.log(json(await verifyClipSave({recheck:true})));else if(action==='verify-export')console.log(json(await verifyExport()));
else if(action==='final')console.log(json(await final()));else if(action==='suite-final')console.log(json(await suiteFinal()));else throw Error('Expected prepare/launch first|reopen|final/audit label/verify-clip-save/reverify-clip-save/verify-export/final/suite-final');
