/** Isolated synthetic packaged Linux acceptance. This helper never automates GUI.
 * Serial gate: prepare; launch first; audit first-boot; operator edits title and
 * prompt using native UI and waits for local autosave; audit before-crash; crash
 * first; inspect-crash; launch reopen; audit after-reopen; operator explicitly
 * restores title/prompt; audit after-restore; operator clicks text-only save once;
 * verify-text-save; operator exports the existing timeline through normal local
 * export preflight/confirmation; verify-export; normal Quit; launch final; audit
 * after-normal-reopen; normal Quit; final.
 *
 * Launch/crash inspection/relaunch must share PID/network namespaces. Only the
 * launcher's saved ChildProcess handle receives SIGKILL. Never numeric PID kills,
 * manual stale-lock removal, renderer injection, browser evaluation, remote
 * debugging, GPU flags, private auth seeding, or GUI automation. Operator-reviewed
 * original native JPG screenshots belong in report only. Never share private-runtime.
 *
 * Native evidence proves title/prompt draft recovery and one real text save and
 * one existing timeline export. Receipt/ACK death is separate Node process-only
 * evidence; this helper explicitly does not claim native GUI lost-ACK coverage.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,readdir,lstat,open,readlink} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {schemas} from '@mioon/contracts';
import {createLocalShotTextSchemas} from '@mioon/contracts/local-shot-text';
import {ensurePrivateDirectory,readPrivateFile,validateManagedFile} from '../packages/contracts/src/private-storage.mjs';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {createProviderRegistry} from '../packages/business/src/provider-registry.mjs';
import {createWorkspacePreferences} from '../packages/business/src/workspace-preferences.mjs';
import {defaultWorkspaceState} from '../apps/web/src/workspace-state.js';
import {ownQaChild} from './agent-timeline-move-qa-native.mjs';

const repo=fileURLToPath(new URL('../',import.meta.url)),scenario=process.env.MIOON_LOCAL_SHOT_TEXT_QA_RUN||'native';
assert.ok(['native','native-repeat'].includes(scenario),'Unexpected synthetic QA run directory');
const root=path.join(repo,'evidence/local-shot-text',scenario),runtime=path.join(root,'private-runtime'),report=path.join(root,'report');
const userData=path.join(runtime,'user-data'),workspace=path.join(userData,'workspace');
const executable=path.join(repo,'release/desktop/production/linux-unpacked/mioon'),asar=path.join(path.dirname(executable),'resources/app.asar');
const fixtureFile=path.join(runtime,'fixture.json'),sidecarFile=path.join(workspace,'local-shot-text-v1.json'),lockFile=path.join(workspace,'server.lock');
const contract=createLocalShotTextSchemas(value=>schemas['shot.update'].safeParse(value).success);
const sha=value=>createHash('sha256').update(value).digest('hex'),json=value=>JSON.stringify(value,null,2)+'\n';
const canonical=value=>JSON.stringify(value,(_key,item)=>item!==null&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),safeLabel=value=>typeof value==='string'&&/^[a-z0-9-]{1,60}$/.test(value);
const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
async function exists(file){try{await lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
function readJson(file,maxBytes=2*1024*1024){return JSON.parse(readPrivateFile(file,{maxBytes,private:true,encoding:'utf8'}));}
async function writeReport(name,value){assert.match(name,/^[a-z0-9-]+\.json$/);ensurePrivateDirectory(report);const contents=json(value);
 assert.ok(Buffer.byteLength(contents)<=2*1024*1024,'Report size limit');await writeFile(path.join(report,name),contents,{mode:0o600,flag:'wx'});}
async function fileHash(file,maxBytes=512*1024*1024){
 const before=await lstat(file);assert.ok(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size<=maxBytes,'Unexpected evidence file');
 const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);const after=await lstat(file);
 for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])assert.equal(after[key],before[key],'Evidence changed while hashing');return {bytes:before.size,sha256:hash.digest('hex')};
}
async function packageHashes(){return {executable:await fileHash(executable),asar:await fileHash(asar)};}
function environment(){return {...Object.fromEntries(['PATH','HOME','LANG','LC_ALL','DISPLAY','XAUTHORITY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','TMPDIR']
 .filter(key=>typeof process.env[key]==='string').map(key=>[key,process.env[key]])),MIOON_DESKTOP_USER_DATA:userData,MIOON_ENABLE_LIVE_PROVIDER:'0',MIOON_FFMPEG_PATH:'/usr/bin/ffmpeg',MIOON_FFPROBE_PATH:'/usr/bin/ffprobe'};}
async function command(binary,args,label){
 assert.ok(['/usr/bin/ffmpeg','/usr/bin/ffprobe'].includes(binary));assert.ok(safeLabel(label));
 const stdout=await open(path.join(runtime,label+'.stdout'),'wx',0o600);let stderr,owned,timer;
 try{stderr=await open(path.join(runtime,label+'.stderr'),'wx',0o600);owned=ownQaChild(spawn(binary,args,{cwd:repo,env:environment(),stdio:['ignore',stdout.fd,stderr.fd]}));
  const result=await Promise.race([owned.done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Bounded synthetic media command timed out')),60000);})]);assert.deepEqual(result,{code:0,signal:null});return result;
 }catch(error){if(owned&&!owned.closed)await owned.stop();throw error;}finally{clearTimeout(timer);await stdout.close();await stderr?.close();}
}
function fixture(){for(const directory of [root,runtime,report,userData,workspace])ensurePrivateDirectory(directory);const value=readJson(fixtureFile,128*1024);
 assert.equal(value.synthetic,true);assert.equal(value.scenario,'local-shot-text');assert.equal(value.workspace,workspace);return value;}
function sidecar(){const info=validateManagedFile(sidecarFile,{root:workspace,allowMissing:true,private:true,maxBytes:16*1024*1024});const bytes=readPrivateFile(sidecarFile,{root:workspace,allowMissing:true,private:true,maxBytes:16*1024*1024});
 return bytes===null?null:{disk:contract.disk.parse(JSON.parse(bytes.toString('utf8'))),bytes:bytes.length,sha256:sha(bytes),stat:{mode:info.mode&0o777,dev:String(info.dev),ino:String(info.ino),size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs}};}
function lockSnapshot(){const info=validateManagedFile(lockFile,{root:workspace,allowMissing:true,private:true,maxBytes:64});if(!info)return null;
 const bytes=readPrivateFile(lockFile,{root:workspace,private:true,maxBytes:64});assert.match(bytes.toString('utf8'),/^[1-9][0-9]{0,9}$/);
 return {pid:Number(bytes.toString('utf8')),bytes:bytes.length,sha256:sha(bytes),dev:String(info.dev),ino:String(info.ino),mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs};}
async function namespaces(){return {pid:await readlink('/proc/self/ns/pid'),network:await readlink('/proc/self/ns/net')};}
async function processStat(pid){assert.ok(Number.isSafeInteger(pid)&&pid>0);try{const raw=await readFile('/proc/'+pid+'/stat','utf8');assert.ok(raw.length<8192);
 const fields=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);return {state:fields[0],parentPid:Number(fields[1]),startTicks:fields[19]};
 }catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return null;throw error;}}
async function safeConnection(){
 // Discovery and credentials stay private; never copy the token or tokenFile.
 const value=readJson(path.join(userData,'mcp-connection.json'),4096),url=new URL(value.url);assert.equal(value.version,1);assert.equal(value.channel,'production');
 assert.equal(url.protocol,'http:');assert.equal(url.hostname,'127.0.0.1');for(const field of ['username','password','search','hash'])assert.equal(url[field],'');
 assert.ok(Number.isSafeInteger(value.pid)&&value.pid>0);const port=Number(url.port);assert.ok(Number.isSafeInteger(port)&&port>0&&port<=65535);
 return {origin:url.origin,port,backendPid:value.pid,channel:value.channel,namespaces:await namespaces()};
}
async function health(origin){try{const response=await fetch(origin+'/health',{signal:AbortSignal.timeout(1500),redirect:'error'}),status=response.status;await response.body?.cancel();return {status,error:null};}
 catch(error){return {status:null,error:error.cause?.code||error.name};}}
async function waitConnection(owned,previous){for(const deadline=Date.now()+120000;Date.now()<deadline;){
 if(owned.closed)throw Error('Packaged process exited before native connection became ready');
 if(await exists(path.join(userData,'mcp-connection.json'))){const connection=await safeConnection(),lock=lockSnapshot();
  if((!previous||connection.backendPid!==previous.backendPid)&&lock?.pid===connection.backendPid&&await processStat(connection.backendPid)){
   const probe=await health(connection.origin);if(probe.status===200)return {...connection,health:probe};}}
 await pause(200);}throw Error('Packaged native connection did not become ready in the bounded startup window');}

async function prepare(){
 assert.equal(process.platform,'linux','This fixture is Linux-only');assert.equal(await exists(root),false,'Native fixture already exists; no overwrite or cleanup is permitted');
 for(const directory of [root,runtime,report,userData])ensurePrivateDirectory(directory,{create:true});
 await writeFile(path.join(runtime,'prepare-claim.json'),json({synthetic:true,id:randomUUID()}),{mode:0o600,flag:'wx'});
 const source=path.join(runtime,'synthetic-green-880hz.mp4');
 await command('/usr/bin/ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=0x18bf57:s=320x180:r=30:d=2',
  '-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=2','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-ac','2','-shortest','-movflags','+faststart','-n',source],'source-media');
 process.env.MIOON_FFMPEG_PATH='/usr/bin/ffmpeg';process.env.MIOON_FFPROBE_PATH='/usr/bin/ffprobe';
 const env={MIOON_ENABLE_LIVE_PROVIDER:'0'},store=openStore(workspace),providers=createProviderRegistry({db:store.db,root:workspace,env}),services=createServices(store,providers,{env});let value;
 try{
  const project=await services.call('project.create',{name:'镜头文字恢复 · 合成验收'});
  let timeline=await services.call('timeline.format.set',{projectId:project.id,expectedProjectRevision:project.revision,expectedRevision:0,requestId:randomUUID(),presetId:'landscape_720'});
  const shot=await services.call('shot.create',{projectId:project.id,title:'Saved native title',prompt:'Saved native prompt',duration:7,aspectRatio:'16:9',parameters:{seed:42},lastFrameAssetId:null});
  const asset=await services.call('asset.import',{projectId:project.id,name:'合成绿色画面与 880Hz.mp4',mimeType:'video/mp4',dataBase64:(await readFile(source)).toString('base64')});
  timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:asset.id,
   trackId:timeline.tracks.find(track=>track.kind==='video').id,startFrame:0,durationFrames:60,name:'镜头文字恢复验收的 2 秒时间线'});
  const state=defaultWorkspaceState();delete state.shared.assetSearch;state.canvas.viewport={x:0,y:0,zoom:1};state.activeMode='canvas';state.canvas.selectedId=shot.id;state.editing.selectedClipId=timeline.clips[0].id;state.editing.playhead=17;state.editing.previewKind='source';
  createWorkspacePreferences(store).put(project.id,{expectedRevision:0,state});
  assert.equal(await exists(sidecarFile),false,'Preparation must never seed a text draft or text intent');
  value={synthetic:true,scenario:'local-shot-text',id:randomUUID(),workspace,projectId:project.id,projectName:project.name,timelineId:timeline.id,clipId:timeline.clips[0].id,
   assetId:asset.id,shotId:shot.id,baseRevision:shot.revision,timelineRevision:timeline.revision,expectedShot:shot,expectedTimeline:timeline,expectedTitle:'Crash-recovered title',expectedPrompt:'Crash-recovered prompt with exact original text.',optionalUnsavedFormDuration:9,sourceSha256:asset.sha256,sourceFile:await fileHash(source),initialSidecarAbsent:true};
 }finally{try{await services.drain();}finally{store.close();}}
 await writeFile(fixtureFile,json(value),{mode:0o600,flag:'wx'});const {workspace:privateWorkspace,...sanitized}=value;await writeReport('fixture.json',sanitized);await audit('prepared');
 for(const label of ['first','reopen','final'])await writeFile(path.join(runtime,'launch-'+label+'.sh'),
  `#!/bin/bash\nset -e\ncd ${quote(repo)}\nexport MIOON_LOCAL_SHOT_TEXT_QA_RUN=${quote(scenario)}\nexec ${quote(process.execPath)} tests/local-shot-text-qa-native.mjs launch ${label}\n`,{mode:0o700,flag:'wx'});
 return sanitized;
}
function readDatabase(){
 validateManagedFile(path.join(workspace,'workbench.sqlite'),{root:workspace,maxBytes:32*1024*1024});const db=new DatabaseSync(path.join(workspace,'workbench.sqlite'),{readOnly:true}),rows={};let schema;
 try{db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name LIMIT 513').all();assert.ok(schema.length<=512,'Schema audit limit');
  const names=schema.filter(item=>item.type==='table');assert.ok(names.length<=128,'Table audit limit');for(const {name} of names){assert.match(name,/^[a-z_]+$/);rows[name]=db.prepare(`SELECT * FROM "${name}" ORDER BY rowid LIMIT 1001`).all();assert.ok(rows[name].length<=1000&&Buffer.byteLength(JSON.stringify(rows[name]))<=1024*1024,'Synthetic row audit limit');}db.exec('COMMIT');
 }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}return {rows,schemaSha256:sha(JSON.stringify(schema))};
}
function row(result,prepared){const entries=result.sidecar?.disk.entries??[];assert.equal(entries.length,1);assert.equal(entries[0].projectId,prepared.projectId);assert.equal(entries[0].shotId,prepared.shotId);return entries[0];}
function assertDraft(result,prepared){const saved=row(result,prepared);assert.equal(saved.shotId,prepared.shotId);assert.deepEqual(saved.draft.raw,{title:prepared.expectedTitle,prompt:prepared.expectedPrompt});assert.equal(saved.draft.baseRevision,prepared.baseRevision);assert.deepEqual(saved.draft.baseText,{title:prepared.expectedShot.title,prompt:prepared.expectedShot.prompt});assert.equal(saved.intent,null);assert.equal(saved.intentRevision,0);assert.ok(saved.draftRevision>=1);assert.equal(result.sidecar.stat.mode,0o600);}
function assertSavedShot(result,prepared){assert.equal(result.shots.length,1);const actual=result.shots[0];assert.equal(actual.title,prepared.expectedTitle);assert.equal(actual.prompt,prepared.expectedPrompt);assert.equal(actual.revision,prepared.baseRevision+1);const permitted=new Set(['title','prompt','revision','updatedAt']);for(const key of new Set([...Object.keys(actual),...Object.keys(prepared.expectedShot)]))if(!permitted.has(key))assert.deepEqual(actual[key],prepared.expectedShot[key],`Text save changed unrelated shot field ${key}`);}
function assertBusinessUnchanged(result,baseline,{allowPreferences=false}={}){
 assert.equal(result.schemaSha256,baseline.schemaSha256);assert.deepEqual(Object.keys(result.tables),Object.keys(baseline.tables));
 for(const name of Object.keys(baseline.tables))if(!(allowPreferences&&name==='workspace_preferences'))assert.deepEqual(result.tables[name],baseline.tables[name],`Unexpected change in ${name}`);
 assert.deepEqual(result.media,baseline.media,'Unexpected media change');assert.deepEqual(result.timelines,baseline.timelines,'Saved timeline changed');
}
async function audit(label){
 assert.ok(safeLabel(label));const prepared=fixture(),{rows,schemaSha256}=readDatabase(),names=(await readdir(path.join(workspace,'media'))).sort();assert.ok(names.length<=32,'Media audit limit');
 const media=[];for(const name of names){assert.match(name,/^[a-zA-Z0-9._-]+\.(mp4|png|wav)$/);media.push({name,...await fileHash(path.join(workspace,'media',name),32*1024*1024)});}
 const tables=Object.fromEntries(Object.entries(rows).map(([name,value])=>[name,{count:value.length,sha256:sha(JSON.stringify(value)),rowSha256:value.map(item=>sha(JSON.stringify(item)))}]));
 const result={synthetic:true,at:new Date().toISOString(),label,fixtureId:prepared.id,schemaSha256,tables,logicalDatabaseSha256:sha(JSON.stringify(tables)),
  shots:rows.shots.map(item=>JSON.parse(item.data)),mutationRequests:rows.mutation_requests.map(item=>({...item,response:JSON.parse(item.response),responseRaw:item.response})),
  timelines:rows.timelines.map(item=>JSON.parse(item.data)),assets:rows.assets.map(item=>JSON.parse(item.data)),exports:rows.exports.map(item=>JSON.parse(item.data)),
  timelineRequests:rows.timeline_requests.map(item=>({requestId:item.requestId,requestHash:item.requestHash,response:JSON.parse(item.response)})),sidecar:sidecar(),lock:lockSnapshot(),media};
 assert.deepEqual(result.timelines,[prepared.expectedTimeline]);
 if(['prepared','first-boot','before-crash','after-reopen','after-restore'].includes(label))assert.deepEqual(result.shots,[prepared.expectedShot]);
 if(['after-text-save','after-export','after-normal-reopen','final'].includes(label))assertSavedShot(result,prepared);
 if(label==='prepared'||label==='first-boot'){assert.equal(result.sidecar,null);assert.equal(result.exports.length,0);if(label==='first-boot')assertBusinessUnchanged(result,readJson(path.join(report,'prepared-audit.json')),{allowPreferences:true});}
 if(label==='before-crash'){assertDraft(result,prepared);assertBusinessUnchanged(result,readJson(path.join(report,'prepared-audit.json')),{allowPreferences:true});assert.equal(result.lock?.pid,readJson(path.join(report,'first-connection.json')).backendPid);}
 if(label==='after-reopen'||label==='after-restore'){assertDraft(result,prepared);const before=readJson(path.join(report,'before-crash-audit.json'));assertBusinessUnchanged(result,before,{allowPreferences:true});assert.deepEqual(result.sidecar,before.sidecar,'Discovery and restoring the saved text must not alter retained sidecar bytes');}
 if(label==='after-normal-reopen') {const before=readJson(path.join(report,'after-export-audit.json'));assertBusinessUnchanged(result,before,{allowPreferences:true});assert.deepEqual(result.sidecar,before.sidecar);}
 await writeReport(label+'-audit.json',result);return result;
}
async function launch(label){
 assert.equal(process.platform,'linux');assert.ok(['first','reopen','final'].includes(label));const prepared=fixture();let previous=null;assert.equal(await exists(path.join(report,label+'-launch.json')),false,'Launch evidence already exists');
 if(label==='first'){assert.equal(lockSnapshot(),null);assert.equal(sidecar(),null);assert.equal(await exists(path.join(userData,'mcp-connection.json')),false);}
 else if(label==='reopen'){
  const exit=readJson(path.join(report,'first-exit.json')),inspection=readJson(path.join(report,'crash-inspection.json'));assert.deepEqual(exit.result,{code:null,signal:'SIGKILL'});assert.equal(exit.crashRequested,true);
  assert.equal(inspection.backendProcessAbsent,true);assert.equal(inspection.health.error,'ECONNREFUSED');assert.equal(inspection.lockUnchanged,true);assert.deepEqual(await namespaces(),inspection.namespaces);
  assert.deepEqual(lockSnapshot(),inspection.lock,'Only product startup may reclaim this unchanged stale lock');previous=readJson(path.join(report,'first-connection.json'));
 }else{const exit=readJson(path.join(report,'reopen-exit.json'));assert.deepEqual(exit.result,{code:0,signal:null});assert.equal(exit.backendLockReleased,true);assert.equal(lockSnapshot(),null);
  readJson(path.join(report,'export-verification.json'));previous=readJson(path.join(report,'reopen-connection.json'));}
 const hashes=await packageHashes();if(label!=='first')assert.deepEqual(hashes,readJson(path.join(report,'first-launch.json')).packageHashes);
 const log=await open(path.join(runtime,label+'-native.log'),'wx',0o600);let owned;
 try{
  owned=ownQaChild(spawn(executable,[],{cwd:repo,env:environment(),stdio:['ignore',log.fd,log.fd]}));
  const initial={synthetic:true,fixtureId:prepared.id,launchId:randomUUID(),label,at:new Date().toISOString(),mainPid:owned.child.pid,argv:[],packageHashes:hashes,namespaces:await namespaces(),sandboxUnchanged:true,gpuUnchanged:true,debugging:false};
  await writeReport(label+'-launch.json',initial);const connection=await waitConnection(owned,previous);
  if(previous){assert.notEqual(connection.backendPid,previous.backendPid);assert.notEqual(connection.port,previous.port,'Fresh-origin acceptance requires a different backend port');}
  await writeReport(label+'-connection.json',{synthetic:true,label,launchId:initial.launchId,at:new Date().toISOString(),...connection});let crashRequested=false;const childSignals=[];
  for(const deadline=Date.now()+30*60*1000;!owned.closed;){
   if(Date.now()>=deadline)throw Error('Native observation window ended before an operator quit');
   if(label==='first'&&!crashRequested&&await exists(path.join(runtime,'first-crash-request.json'))){
    const request=readJson(path.join(runtime,'first-crash-request.json'));assert.equal(request.fixtureId,prepared.id);assert.equal(request.launchId,initial.launchId);assert.equal(request.label,'first');
    const before=readJson(path.join(report,'before-crash-audit.json'));assertDraft(before,prepared);assert.deepEqual(lockSnapshot(),before.lock);assert.deepEqual(sidecar(),before.sidecar);
    crashRequested=true;assert.equal(owned.child.kill('SIGKILL'),true,'The exact owned main process was not signalled');childSignals.push('SIGKILL');}
   if(!owned.closed)await pause(200);
  }
  const result=await owned.done;if(!crashRequested)for(const deadline=Date.now()+45000;lockSnapshot()!==null&&Date.now()<deadline;)await pause(250);
  const remainingLock=lockSnapshot(),backendLockReleased=remainingLock===null,endedPackageHashes=await packageHashes();
  const exit={...initial,endedAt:new Date().toISOString(),result,crashRequested,childSignals,backendLockReleased,remainingLock,endedPackageHashes};await writeReport(label+'-exit.json',exit);assert.deepEqual(endedPackageHashes,hashes);
  if(crashRequested){assert.deepEqual(result,{code:null,signal:'SIGKILL'});assert.equal(backendLockReleased,false);assert.deepEqual(remainingLock,readJson(path.join(report,'before-crash-audit.json')).lock);}
  else{assert.deepEqual(result,{code:0,signal:null});assert.equal(backendLockReleased,true,'Normal quit did not release the backend lock');}
 }catch(error){if(owned&&!owned.closed)await owned.stop();throw error;}finally{await log.close();}
}
async function crash(label){
 assert.equal(label,'first','Only the initial exact owned native main may be crashed');const prepared=fixture();assert.equal(await exists(path.join(report,'first-exit.json')),false);
 const launchRecord=readJson(path.join(report,'first-launch.json')),before=readJson(path.join(report,'before-crash-audit.json'));assertDraft(before,prepared);assert.deepEqual(sidecar(),before.sidecar);assert.deepEqual(lockSnapshot(),before.lock);
 await writeFile(path.join(runtime,'first-crash-request.json'),json({fixtureId:prepared.id,label,launchId:launchRecord.launchId}),{mode:0o600,flag:'wx'});
}
async function inspectCrash(){
 const prepared=fixture(),exit=readJson(path.join(report,'first-exit.json')),connection=readJson(path.join(report,'first-connection.json')),before=readJson(path.join(report,'before-crash-audit.json'));
 assert.deepEqual(exit.result,{code:null,signal:'SIGKILL'});const nativeNamespaces=await namespaces();assert.deepEqual(nativeNamespaces,connection.namespaces,'Inspect in the native PID/network namespaces');
 assert.deepEqual(await safeConnection(),Object.fromEntries(Object.entries(connection).filter(([key])=>['origin','port','backendPid','channel','namespaces'].includes(key))));let stat,probe;
 for(const deadline=Date.now()+45000;;){assert.deepEqual(lockSnapshot(),before.lock,'Inspection must leave the exact stale lock untouched');stat=await processStat(connection.backendPid);probe=await health(connection.origin);
  if((stat===null&&probe.error==='ECONNREFUSED')||Date.now()>=deadline)break;await pause(250);}
 const result={synthetic:true,fixtureId:prepared.id,at:new Date().toISOString(),namespaces:nativeNamespaces,origin:connection.origin,port:connection.port,reportedBackendPid:connection.backendPid,
  stat,backendProcessAbsent:stat===null,health:probe,lock:lockSnapshot(),lockUnchanged:JSON.stringify(lockSnapshot())===JSON.stringify(before.lock),numericPidSignals:0};
 await writeReport('crash-inspection.json',result);assert.equal(result.backendProcessAbsent,true,'Backend remains; do not relaunch or remove its lock');assert.equal(probe.error,'ECONNREFUSED');assert.equal(result.lockUnchanged,true);return result;
}
async function verifyTextSave(){
 const prepared=fixture(),before=readJson(path.join(report,'after-restore-audit.json')),result=await audit('after-text-save'),saved=row(result,prepared);
 assertSavedShot(result,prepared);assert.equal(saved.intent.outcome.status,'applied');assert.equal(saved.intent.outcome.shotRevision,prepared.baseRevision+1);assert.equal(saved.intent.baseRevision,prepared.baseRevision);assert.deepEqual(saved.intent.baseText,{title:prepared.expectedShot.title,prompt:prepared.expectedShot.prompt});
 assert.equal(saved.intent.input.shotId,prepared.shotId);assert.equal(saved.intent.input.expectedRevision,prepared.baseRevision);assert.deepEqual(saved.intent.input.patch,{title:prepared.expectedTitle,prompt:prepared.expectedPrompt});assert.deepEqual(saved.intent.draft.raw,saved.intent.input.patch);assert.equal(saved.draft,null);assert.equal(saved.draftRevision,row(before,prepared).draftRevision+1);
 assert.equal(result.schemaSha256,before.schemaSha256);assert.deepEqual(result.media,before.media);assert.deepEqual(result.timelines,before.timelines);assert.equal(result.exports.length,0);
 for(const [name,table] of Object.entries(before.tables)){
  if(name==='shots')assert.equal(result.tables[name].count,table.count);
  else if(name==='mutation_requests'){assert.equal(result.tables[name].count,table.count+1);for(const digest of table.rowSha256)assert.ok(result.tables[name].rowSha256.includes(digest));}
  else if(name!=='workspace_preferences')assert.deepEqual(result.tables[name],table,`Unexpected text-save change in ${name}`);
 }
 const receipts=result.mutationRequests.filter(item=>!before.mutationRequests.some(prior=>prior.requestId===item.requestId));assert.equal(receipts.length,1);const receipt=receipts[0],{requestId,...fields}=saved.intent.input;
 assert.equal(receipt.requestId,requestId);assert.equal(receipt.operation,'shot.update');assert.equal(receipt.projectId,prepared.projectId);assert.equal(receipt.canonicalInput,canonical(fields));assert.deepEqual(receipt.response,result.shots[0]);assert.equal(Object.hasOwn(receipt.response,'status'),false);assert.equal(saved.intent.outcome.responseSha256,sha(canonical(receipt.response)));
 const verification={synthetic:true,fixtureId:prepared.id,at:new Date().toISOString(),shotId:prepared.shotId,intentId:saved.intent.intentId,requestId,frozenInput:saved.intent.input,revisionBefore:prepared.baseRevision,revisionAfter:result.shots[0].revision,exactCapturedDraftCleared:true,unrelatedShotFieldsUnchanged:true,onlyChangedBusinessRows:{shots:1,mutation_requests:1},originalMediaUnchanged:true,originalTimelineUnchanged:true,receiptSha256:sha(receipt.responseRaw)};
 await writeReport('text-save-verification.json',verification);return verification;
}
async function verifyExport(){
 const prepared=fixture(),before=readJson(path.join(report,'after-text-save-audit.json')),pending=readDatabase().rows.exports.map(item=>JSON.parse(item.data));
 assert.equal(pending.length,1);assert.equal(pending[0].status,'succeeded','Wait for the one native export to succeed');const result=await audit('after-export'),exported=result.exports[0];
 assert.deepEqual(result.sidecar,before.sidecar,'Timeline export must never rewrite the completed text intent');assert.deepEqual(result.shots,before.shots);assert.deepEqual(result.mutationRequests,before.mutationRequests);
 assert.equal(exported.purpose,'export');assert.equal(exported.mode,'timeline');assert.equal(exported.projectId,prepared.projectId);assert.equal(exported.timelineRevision,prepared.timelineRevision);assert.deepEqual(exported.snapshot.timeline,prepared.expectedTimeline);assert.equal(result.schemaSha256,before.schemaSha256);
 for(const [name,table] of Object.entries(before.tables)){
  if(['assets','exports','timeline_requests'].includes(name)){assert.equal(result.tables[name].count,table.count+1,`One export adds one ${name} row`);for(const digest of table.rowSha256)assert.ok(result.tables[name].rowSha256.includes(digest),`Original ${name} row changed`);}
  else if(name!=='workspace_preferences')assert.deepEqual(result.tables[name],table,`Unexpected export change in ${name}`);
 }
 const requests=result.timelineRequests.filter(item=>!before.timelineRequests.some(prior=>prior.requestId===item.requestId));assert.equal(requests.length,1);const receipt=requests[0];assert.equal(receipt.requestId,exported.requestId);assert.equal(receipt.response.id,exported.id);assert.equal(receipt.response.status,'queued');assert.deepEqual(receipt.response.snapshot,exported.snapshot);
 for(const original of before.media)assert.deepEqual(result.media.find(item=>item.name===original.name),original);assert.equal(result.media.length,before.media.length+1);
 const asset=result.assets.find(item=>item.id===exported.assetId);assert.ok(asset);assert.equal(asset.projectId,prepared.projectId);assert.equal(asset.provenance,'export');assert.match(asset.relativePath,/^media\/[a-zA-Z0-9._-]+\.mp4$/);const file=path.join(workspace,asset.relativePath),output=await fileHash(file,32*1024*1024);assert.equal(output.sha256,asset.sha256);
 await command('/usr/bin/ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],'export-probe');const probe=readJson(path.join(runtime,'export-probe.stdout')),video=probe.streams.find(stream=>stream.codec_type==='video'),audio=probe.streams.find(stream=>stream.codec_type==='audio');assert.ok(video&&audio);assert.equal(video.width,1280);assert.equal(video.height,720);assert.equal(video.r_frame_rate,'30/1');assert.equal(Number(video.nb_frames),60);assert.equal(audio.sample_rate,'48000');
 await command('/usr/bin/ffmpeg',['-v','error','-i',file,'-f','null','-'],'export-decode');const verification={synthetic:true,fixtureId:prepared.id,at:new Date().toISOString(),exportId:exported.id,assetId:asset.id,requestId:exported.requestId,onlyAddedBusinessRows:{assets:1,exports:1,timeline_requests:1},originalMediaUnchanged:true,shotTextReceiptUnchanged:true,output,video:{width:video.width,height:video.height,rate:video.r_frame_rate,frames:Number(video.nb_frames)},audio:{codec:audio.codec_name,sampleRate:audio.sample_rate},decodeExit:0};await writeReport('export-verification.json',verification);return verification;
}
async function final(){
 const prepared=fixture();for(const deadline=Date.now()+45000;!await exists(path.join(report,'final-exit.json'))&&Date.now()<deadline;)await pause(100);
 assert.equal(await exists(path.join(report,'final-exit.json')),true);assert.equal(lockSnapshot(),null,'Final normal quit did not release its lock');
 const screenshots=[];for(const name of ['01-saved-shot','02-autosaved-text','03-discovered-text','04-restored-text','05-text-saved','06-export-succeeded','07-normal-reopen']){
  const file=path.join(report,name+'.jpg'),handle=await open(file,'r');try{const bytes=Buffer.alloc(3);await handle.read(bytes,0,3,0);assert.equal(bytes.toString('hex'),'ffd8ff');}finally{await handle.close();}screenshots.push({name:name+'.jpg',...await fileHash(file,32*1024*1024)});}
 const result=await audit('final'),after=readJson(path.join(report,'after-export-audit.json')),normal=readJson(path.join(report,'after-normal-reopen-audit.json'));
 const preparedAudit=readJson(path.join(report,'prepared-audit.json')),firstBoot=readJson(path.join(report,'first-boot-audit.json')),beforeCrash=readJson(path.join(report,'before-crash-audit.json'));
 const recovered=readJson(path.join(report,'after-reopen-audit.json')),restored=readJson(path.join(report,'after-restore-audit.json'));
 assert.equal(preparedAudit.sidecar,null);assert.equal(firstBoot.sidecar,null);assertBusinessUnchanged(firstBoot,preparedAudit,{allowPreferences:true});
 for(const observation of [beforeCrash,recovered,restored]){assertDraft(observation,prepared);assertBusinessUnchanged(observation,preparedAudit,{allowPreferences:true});}
 assert.deepEqual(recovered.sidecar,beforeCrash.sidecar);assert.deepEqual(restored.sidecar,beforeCrash.sidecar);
 assertBusinessUnchanged(result,after,{allowPreferences:true});assertBusinessUnchanged(normal,after,{allowPreferences:true});assert.deepEqual(result.sidecar,after.sidecar);assert.deepEqual(normal.sidecar,after.sidecar);
 const launches=[],connections=[],exits=[];for(const label of ['first','reopen','final']){launches.push(readJson(path.join(report,label+'-launch.json')));connections.push(readJson(path.join(report,label+'-connection.json')));exits.push(readJson(path.join(report,label+'-exit.json')));}
 const hashes=await packageHashes();for(const launch of launches)assert.deepEqual(launch.packageHashes,hashes);for(const exit of exits)assert.deepEqual(exit.endedPackageHashes,hashes);
 assert.deepEqual(exits[0].result,{code:null,signal:'SIGKILL'});assert.deepEqual(exits[0].childSignals,['SIGKILL']);for(const exit of exits.slice(1)){assert.deepEqual(exit.result,{code:0,signal:null});assert.equal(exit.backendLockReleased,true);}
 const summary={synthetic:true,scenario:'local-shot-text',platform:'linux',productionBackend:true,fixtureId:prepared.id,packageHashes:hashes,
  draftOnlyCrashRecovery:true,startupAndDiscoveryDidNotSaveOrExport:true,explicitTextRestoreDidNotSaveOrExport:true,exactlyOneTextSave:true,unrelatedShotFieldsUnchanged:true,savedTimelineUnchanged:true,originalMediaUnchanged:true,
  originalSidecarBytesUnchangedOnDiscovery:true,normalReopenPreservedAppliedIntent:true,ports:connections.map(({label,origin,port,backendPid})=>({label,origin,port,backendPid})),
  crash:exits[0],normalExits:exits.slice(1),crashInspection:readJson(path.join(report,'crash-inspection.json')),textSaveVerification:readJson(path.join(report,'text-save-verification.json')),exportVerification:readJson(path.join(report,'export-verification.json')),screenshots,
  nativeLostAckBoundaryTested:false,lostAckCoverage:'Separate real-service Node process SIGKILL matrix; no claimed native GUI lost-ACK observation',
  uiEvidence:'Native screenshots reviewed by operator; no renderer injection',deliveryScope:'Report only; exclude private-runtime, discovery, credentials, database and media'};
 await writeReport('summary.json',summary);return summary;
}

const [action,label,...extra]=process.argv.slice(2);assert.equal(extra.length,0);
if(action==='prepare')console.log(json(await prepare()));else if(action==='launch')await launch(label);else if(action==='audit')console.log(json(await audit(label)));
else if(action==='verify-text-save')console.log(json(await verifyTextSave()));else if(action==='crash')await crash(label);else if(action==='inspect-crash')console.log(json(await inspectCrash()));else if(action==='verify-export')console.log(json(await verifyExport()));
else if(action==='final')console.log(json(await final()));else throw Error('Expected prepare/launch first|reopen|final/audit label/crash first/inspect-crash/verify-text-save/verify-export/final');
