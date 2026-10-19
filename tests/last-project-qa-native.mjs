/** Synthetic packaged Linux acceptance; never a product entry point.
 * Native UI actions and screenshots are performed separately. No locator,
 * renderer storage, credentials, or injected application switches are seeded.
 * Only exact owned ChildProcess handles may be signalled by this helper.
 *
 * Sequence (run launch/inspect-crash in the native desktop namespaces):
 * prepare; launch first; audit first-boot; explicitly open fixture.target in
 * the project menu; audit before-crash; crash first; inspect-crash;
 * launch reopen; audit after-reopen; [one native export; verify-export];
 * normal Quit; launch final; [audit normal-reopen-before-export; optional
 * one native export and verify-export]; audit after-normal-reopen; normal Quit; final.
 * Keep screenshots in report/{01-first-fallback,02-explicit-target-saved,
 * 03-crash-reopened-target,04-normal-reopened-target}.jpg. Deliver report only,
 * never private-runtime. A screenshot records the operator's UI observation;
 * this helper makes no hidden DOM or renderer-state assertion.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,readdir,lstat,open,readlink} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {ensurePrivateDirectory,readPrivateFile,validateManagedFile} from '../packages/contracts/src/private-storage.ts';
import {lastProjectDiskSchema} from '../packages/contracts/src/last-project.ts';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createProviderRegistry} from '../packages/business/src/provider-registry.ts';
import {createWorkspacePreferences} from '../packages/business/src/workspace-preferences.ts';
import {defaultWorkspaceState} from '../apps/web/src/workspace-state.ts';
import {ownQaChild} from './agent-timeline-move-qa-native.mjs';

const repo=fileURLToPath(new URL('../',import.meta.url));
const scenario=process.env.MIOON_LAST_PROJECT_QA_RUN||'native';
assert.ok(['native','native-repeat'].includes(scenario),'Unexpected synthetic QA run directory');
const root=path.join(repo,'evidence/last-project',scenario);
const runtime=path.join(root,'private-runtime'),report=path.join(root,'report');
const userData=path.join(runtime,'user-data'),workspace=path.join(userData,'workspace');
const executable=path.join(repo,'release/desktop/production/linux-unpacked/mioon');
const asar=path.join(path.dirname(executable),'resources/app.asar');
const fixtureFile=path.join(runtime,'fixture.json'),locatorFile=path.join(workspace,'last-project-v1.json');
const lockFile=path.join(workspace,'server.lock');
const sha=value=>createHash('sha256').update(value).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const shellQuote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
const safeLabel=value=>typeof value==='string'&&/^[a-z0-9-]{1,60}$/.test(value);
async function exists(file){try{await lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
function readJson(file,maxBytes=2*1024*1024){return JSON.parse(readPrivateFile(file,{maxBytes,private:true,encoding:'utf8'}));}
async function writeReport(name,value){
 assert.match(name,/^[a-z0-9-]+\.json$/);ensurePrivateDirectory(report);
 const contents=json(value);assert.ok(Buffer.byteLength(contents)<=2*1024*1024,'Report size limit');
 await writeFile(path.join(report,name),contents,{mode:0o600,flag:'wx'});
}
async function fileHash(file,maxBytes=512*1024*1024){
 const before=await lstat(file);
 assert.ok(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size<=maxBytes,'Unexpected evidence file');
 const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
 const after=await lstat(file);
 for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])assert.equal(after[key],before[key],'Evidence changed while hashing');
 return {bytes:before.size,sha256:hash.digest('hex')};
}
async function packageHashes(){return {executable:await fileHash(executable),asar:await fileHash(asar)};}
function environment(){
 return {...Object.fromEntries(['PATH','HOME','LANG','LC_ALL','DISPLAY','XAUTHORITY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','TMPDIR']
  .filter(key=>typeof process.env[key]==='string').map(key=>[key,process.env[key]])),
  MIOON_DESKTOP_USER_DATA:userData,MIOON_ENABLE_LIVE_PROVIDER:'0',MIOON_FFMPEG_PATH:'/usr/bin/ffmpeg',MIOON_FFPROBE_PATH:'/usr/bin/ffprobe'};
}
async function command(binary,args,label){
 assert.ok(['/usr/bin/ffmpeg','/usr/bin/ffprobe'].includes(binary));assert.ok(safeLabel(label));
 const stdout=await open(path.join(runtime,label+'.stdout'),'wx',0o600);let stderr,owned,timer;
 try{
  stderr=await open(path.join(runtime,label+'.stderr'),'wx',0o600);
  owned=ownQaChild(spawn(binary,args,{cwd:repo,env:environment(),stdio:['ignore',stdout.fd,stderr.fd]}));
  const result=await Promise.race([owned.done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Bounded synthetic media command timed out')),60000);})]);
  assert.deepEqual(result,{code:0,signal:null});return result;
 }catch(error){if(owned&&!owned.closed)await owned.stop();throw error;}
 finally{clearTimeout(timer);await stdout.close();await stderr?.close();}
}
function fixture(){
 for(const directory of [root,runtime,report,userData,workspace])ensurePrivateDirectory(directory);
 const value=readJson(fixtureFile,128*1024);
 assert.equal(value.synthetic,true);assert.equal(value.scenario,'last-project');assert.equal(value.workspace,workspace);
 assert.notEqual(value.target.id,value.originalFallback.id);return value;
}
function locator(){
 const bytes=readPrivateFile(locatorFile,{root:workspace,allowMissing:true,private:true,maxBytes:4096});
 return bytes===null?null:{...lastProjectDiskSchema.parse(JSON.parse(bytes.toString('utf8'))),bytes:bytes.length,sha256:sha(bytes)};
}
function lockSnapshot(){
 const info=validateManagedFile(lockFile,{root:workspace,allowMissing:true,private:true,maxBytes:64});
 if(!info)return null;
 const bytes=readPrivateFile(lockFile,{root:workspace,private:true,maxBytes:64});
 assert.match(bytes.toString('utf8'),/^[1-9][0-9]{0,9}$/);
 return {pid:Number(bytes.toString('utf8')),bytes:bytes.length,sha256:sha(bytes),
  dev:String(info.dev),ino:String(info.ino),mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs};
}
async function namespaces(){return {pid:await readlink('/proc/self/ns/pid'),network:await readlink('/proc/self/ns/net')};}
async function processStat(pid){
 assert.ok(Number.isSafeInteger(pid)&&pid>0);
 try{
  const raw=await readFile('/proc/'+pid+'/stat','utf8');assert.ok(raw.length<8192);
  const fields=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);
  return {state:fields[0],parentPid:Number(fields[1]),startTicks:fields[19]};
 }catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return null;throw error;}
}
async function safeConnection(){
 // Discovery stays private: never copy the descriptor, tokenFile, or a token.
 const value=readJson(path.join(userData,'mcp-connection.json'),4096),url=new URL(value.url);
 assert.equal(value.version,1);assert.equal(value.channel,'production');
 assert.equal(url.protocol,'http:');assert.equal(url.hostname,'127.0.0.1');
 assert.equal(url.username,'');assert.equal(url.password,'');assert.equal(url.search,'');assert.equal(url.hash,'');
 assert.ok(Number.isSafeInteger(value.pid)&&value.pid>0);
 const port=Number(url.port);assert.ok(Number.isSafeInteger(port)&&port>0&&port<=65535);
 return {origin:url.origin,port,backendPid:value.pid,channel:value.channel,namespaces:await namespaces()};
}
async function health(origin){
 try{
  const response=await fetch(origin+'/health',{signal:AbortSignal.timeout(1500),redirect:'error'});
  const status=response.status;await response.body?.cancel();return {status,error:null};
 }catch(error){return {status:null,error:error.cause?.code||error.name};}
}
async function waitConnection(owned,previous){
 for(const deadline=Date.now()+120000;Date.now()<deadline;){
  if(owned.closed)throw Error('Packaged process exited before native connection became ready');
  if(await exists(path.join(userData,'mcp-connection.json'))){
   const connection=await safeConnection(),lock=lockSnapshot();
   if((!previous||connection.backendPid!==previous.backendPid)&&lock?.pid===connection.backendPid&&await processStat(connection.backendPid)){
    const probe=await health(connection.origin);if(probe.status===200)return {...connection,health:probe};
   }
  }
  await pause(200);
 }
 throw Error('Packaged native connection did not become ready in the bounded startup window');
}

async function prepare(){
 assert.equal(process.platform,'linux','This fixture is Linux-only');
 assert.equal(await exists(root),false,'Native fixture directory already exists; no overwrite or cleanup is permitted');
 for(const directory of [root,runtime,report,userData])ensurePrivateDirectory(directory,{create:true});
 await writeFile(path.join(runtime,'prepare-claim.json'),json({synthetic:true,id:randomUUID()}),{mode:0o600,flag:'wx'});
 const source=path.join(runtime,'synthetic-green-880hz.mp4');
 await command('/usr/bin/ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=0x18bf57:s=320x180:r=30:d=2',
  '-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=2','-c:v','libx264','-threads','1','-pix_fmt','yuv420p',
  '-c:a','aac','-ac','2','-shortest','-movflags','+faststart','-n',source],'source-media');
 // The real asset-import service owns its probe; use the same installed tools
 // as the packaged launch, without inheriting an unrelated tool override.
 process.env.MIOON_FFMPEG_PATH='/usr/bin/ffmpeg';process.env.MIOON_FFPROBE_PATH='/usr/bin/ffprobe';
 // Match ordinary server schema initialization, including the empty mock
 // provider tables. Constructing this registry never submits a provider task.
 const fixtureProviderEnvironment={MIOON_ENABLE_LIVE_PROVIDER:'0'};
 const store=openStore(workspace),providers=createProviderRegistry({db:store.db,root:workspace,env:fixtureProviderEnvironment});
 const services=createServices(store,providers,{env:fixtureProviderEnvironment});let value;
 try{
  const initialized=[];
  for(const name of ['最近项目 · 合成项目 A','最近项目 · 合成项目 B']){
   const project=await services.call('project.create',{name});
   const timeline=await services.call('timeline.format.set',{projectId:project.id,expectedProjectRevision:project.revision,
    expectedRevision:0,requestId:randomUUID(),presetId:'landscape_720'});
   initialized.push({project,timeline});
  }
  const listed=await services.call('project.list',{});assert.equal(listed.length,2);
  const originalFallback=listed[0],target=listed[1];assert.notEqual(target.id,originalFallback.id);
  const asset=await services.call('asset.import',{projectId:target.id,name:'合成绿色画面与 880Hz.mp4',mimeType:'video/mp4',dataBase64:(await readFile(source)).toString('base64')});
  let timeline=initialized.find(item=>item.project.id===target.id).timeline;
  timeline=await services.call('timeline.clip.add',{projectId:target.id,expectedRevision:timeline.revision,requestId:randomUUID(),
   assetId:asset.id,trackId:timeline.tracks.find(track=>track.kind==='video').id,startFrame:0,durationFrames:60,name:'上次项目的已保存片段'});
  const clip=timeline.clips[0],preferences=createWorkspacePreferences(store),saved=[];
  for(const project of listed){
   const state=defaultWorkspaceState();delete state.shared.assetSearch;
   state.canvas.viewport={x:0,y:0,zoom:1};
   if(project.id===target.id){state.activeMode='editing';state.editing.selectedClipId=clip.id;state.editing.playhead=17;state.editing.previewKind='source';}
   saved.push(preferences.put(project.id,{expectedRevision:0,state}));
  }
  const finalList=await services.call('project.list',{});assert.equal(finalList[0].id,originalFallback.id);
  assert.equal(await exists(locatorFile),false,'Preparation must never seed a locator');
  value={synthetic:true,scenario:'last-project',id:randomUUID(),workspace,
   projectList:finalList.map(({id,name})=>({id,name})),originalFallback:{id:originalFallback.id,name:originalFallback.name},
   target:{id:target.id,name:target.name},timelineId:timeline.id,clipId:clip.id,assetId:asset.id,baseRevision:timeline.revision,
   expectedTimeline:timeline,targetPreferences:saved.find(item=>item.projectId===target.id),sourceSha256:asset.sha256,
   sourceFile:await fileHash(source),initialLocatorAbsent:true};
 }finally{try{await services.drain();}finally{store.close();}}
 await writeFile(fixtureFile,json(value),{mode:0o600,flag:'wx'});
 await writeReport('fixture.json',value);await audit('prepared');
 for(const label of ['first','reopen','final'])await writeFile(path.join(runtime,'launch-'+label+'.sh'),
  `#!/bin/bash\nset -e\ncd ${shellQuote(repo)}\nexport MIOON_LAST_PROJECT_QA_RUN=${shellQuote(scenario)}\nexec ${shellQuote(process.execPath)} tests/last-project-qa-native.mjs launch ${label}\n`,{mode:0o700,flag:'wx'});
 return value;
}

function readDatabase(){
 validateManagedFile(path.join(workspace,'workbench.sqlite'),{root:workspace,maxBytes:32*1024*1024});
 const db=new DatabaseSync(path.join(workspace,'workbench.sqlite'),{readOnly:true}),rows={};let schema;
 try{
  db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
  schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name LIMIT 513').all();
  assert.ok(schema.length<=512,'Schema audit limit');
  const names=schema.filter(item=>item.type==='table');assert.ok(names.length<=128,'Table audit limit');
  for(const {name} of names){
   assert.match(name,/^[a-z_]+$/);rows[name]=db.prepare(`SELECT * FROM "${name}" ORDER BY rowid LIMIT 1001`).all();
   assert.ok(rows[name].length<=1000&&Buffer.byteLength(JSON.stringify(rows[name]))<=1024*1024,'Synthetic row audit limit');
  }
  db.exec('COMMIT');
 }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}
 return {rows,schemaSha256:sha(JSON.stringify(schema))};
}
function assertTargetPreferences(result,preparedFixture){
 const preference=result.preferences.find(item=>item.projectId===preparedFixture.target.id);
 assert.deepEqual(preference,preparedFixture.targetPreferences,'Saved target editing preferences changed');
 assert.equal(preference.state.activeMode,'editing');assert.equal(preference.state.editing.selectedClipId,preparedFixture.clipId);
 assert.equal(preference.state.editing.playhead,17);
}
function assertRemembered(result,preparedFixture){
 assert.equal(result.locator?.revision,1);assert.equal(result.locator.projectId,preparedFixture.target.id);
 assert.notEqual(result.locator.projectId,preparedFixture.originalFallback.id);assertTargetPreferences(result,preparedFixture);
}
function assertUnchanged(result,baseline,{allowFallbackPreferences=false}={}){
 assert.equal(result.schemaSha256,baseline.schemaSha256);
 assert.deepEqual(Object.keys(result.tables),Object.keys(baseline.tables));
 for(const name of Object.keys(baseline.tables))if(!(allowFallbackPreferences&&name==='workspace_preferences'))
  assert.deepEqual(result.tables[name],baseline.tables[name],`Unexpected change in ${name}`);
 assert.deepEqual(result.media,baseline.media,'Unexpected original media change');
 assert.deepEqual(result.timelines,baseline.timelines,'Saved timeline changed');
}
async function audit(label){
 assert.ok(safeLabel(label),'Invalid audit label');const preparedFixture=fixture(),{rows,schemaSha256}=readDatabase();
 const names=(await readdir(path.join(workspace,'media'))).sort();assert.ok(names.length<=32,'Media audit limit');
 const media=[];for(const name of names){assert.match(name,/^[a-zA-Z0-9._-]+\.(mp4|png|wav)$/);media.push({name,...await fileHash(path.join(workspace,'media',name),32*1024*1024)});}
 const tables=Object.fromEntries(Object.entries(rows).map(([name,value])=>[name,{count:value.length,sha256:sha(JSON.stringify(value)),rowSha256:value.map(row=>sha(JSON.stringify(row)))}]));
 const result={synthetic:true,at:new Date().toISOString(),label,fixtureId:preparedFixture.id,schemaSha256,tables,
  logicalDatabaseSha256:sha(JSON.stringify(tables)),databaseFile:await fileHash(path.join(workspace,'workbench.sqlite'),32*1024*1024),
  preferences:rows.workspace_preferences.map(row=>({projectId:row.projectId,revision:row.revision,state:JSON.parse(row.state)})),
  timelines:rows.timelines.map(row=>JSON.parse(row.data)),assets:rows.assets.map(row=>JSON.parse(row.data)),
  exports:rows.exports.map(row=>JSON.parse(row.data)),timelineRequests:rows.timeline_requests.map(row=>({requestId:row.requestId,response:JSON.parse(row.response)})),
  locator:locator(),lock:lockSnapshot(),media};
 if(label==='prepared'){assert.equal(result.locator,null);assertTargetPreferences(result,preparedFixture);}
 if(label==='first-boot'){
  assert.equal(result.locator,null,'Ordinary first boot must not write a locator');
  assertUnchanged(result,readJson(path.join(report,'prepared-audit.json')),{allowFallbackPreferences:true});assertTargetPreferences(result,preparedFixture);
 }
 if(label==='before-crash'){
  assertRemembered(result,preparedFixture);assertUnchanged(result,readJson(path.join(report,'prepared-audit.json')),{allowFallbackPreferences:true});
  assert.equal(readJson(path.join(report,'first-boot-audit.json')).locator,null);
  const connection=readJson(path.join(report,'first-connection.json'));assert.equal(result.lock?.pid,connection.backendPid);
 }
 if(label==='after-reopen'||label==='after-normal-reopen'){
  assertRemembered(result,preparedFixture);
  const before=readJson(path.join(report,'before-crash-audit.json'));
  const baseline=label==='after-normal-reopen'&&await exists(path.join(report,'export-verification.json'))?readJson(path.join(report,'after-export-audit.json')):before;
  assertUnchanged(result,baseline);assert.deepEqual(result.locator,before.locator,'Rediscovery must not rewrite locator bytes or revision');
 }
 await writeReport(label+'-audit.json',result);return result;
}

async function launch(label){
 assert.equal(process.platform,'linux');assert.ok(['first','reopen','final'].includes(label),'Explicit launch label required');
 const preparedFixture=fixture();let previous=null;
 assert.equal(await exists(path.join(report,label+'-launch.json')),false,'Launch evidence already exists');
 if(label==='first'){
  assert.equal(lockSnapshot(),null);assert.equal(locator(),null);assert.equal(await exists(path.join(userData,'mcp-connection.json')),false);
 }else if(label==='reopen'){
  const exit=readJson(path.join(report,'first-exit.json')),inspection=readJson(path.join(report,'crash-inspection.json'));
  assert.deepEqual(exit.result,{code:null,signal:'SIGKILL'});assert.equal(exit.crashRequested,true);
  assert.equal(inspection.backendProcessAbsent,true);assert.equal(inspection.health.error,'ECONNREFUSED');assert.equal(inspection.lockUnchanged,true);
  assert.deepEqual(await namespaces(),inspection.namespaces,'Reopen must use the inspected native namespaces');
  assert.deepEqual(lockSnapshot(),inspection.lock,'Only product startup may reclaim this unchanged stale lock');
  previous=readJson(path.join(report,'first-connection.json'));
 }else{
  const exit=readJson(path.join(report,'reopen-exit.json'));assert.deepEqual(exit.result,{code:0,signal:null});assert.equal(exit.backendLockReleased,true);
  assert.equal(lockSnapshot(),null);readJson(path.join(report,'after-reopen-audit.json'));previous=readJson(path.join(report,'reopen-connection.json'));
 }
 const hashes=await packageHashes();if(label!=='first')assert.deepEqual(hashes,readJson(path.join(report,'first-launch.json')).packageHashes);
 const log=await open(path.join(runtime,label+'-native.log'),'wx',0o600);let owned;
 try{
  owned=ownQaChild(spawn(executable,[],{cwd:repo,env:environment(),stdio:['ignore',log.fd,log.fd]}));
  const initial={synthetic:true,fixtureId:preparedFixture.id,launchId:randomUUID(),label,at:new Date().toISOString(),
   mainPid:owned.child.pid,executable,argv:[],packageHashes:hashes,namespaces:await namespaces(),sandboxUnchanged:true,debugging:false};
  await writeReport(label+'-launch.json',initial);
  const connection=await waitConnection(owned,previous);
  if(previous){assert.notEqual(connection.backendPid,previous.backendPid);assert.notEqual(connection.port,previous.port,'Fresh-origin acceptance requires a different backend port');}
  await writeReport(label+'-connection.json',{synthetic:true,label,launchId:initial.launchId,at:new Date().toISOString(),...connection});
  let crashRequested=false;const childSignals=[];
  for(const deadline=Date.now()+30*60*1000;!owned.closed;){
   if(Date.now()>=deadline)throw Error('Native observation window ended before an operator quit');
   if(label==='first'&&!crashRequested&&await exists(path.join(runtime,'first-crash-request.json'))){
    const request=readJson(path.join(runtime,'first-crash-request.json'));
    assert.equal(request.fixtureId,preparedFixture.id);assert.equal(request.launchId,initial.launchId);assert.equal(request.label,'first');
    const before=readJson(path.join(report,'before-crash-audit.json'));assertRemembered(before,preparedFixture);
    assert.deepEqual(lockSnapshot(),before.lock);assert.deepEqual(locator(),before.locator);
    crashRequested=true;assert.equal(owned.child.kill('SIGKILL'),true,'The exact owned main process was not signalled');childSignals.push('SIGKILL');
   }
   if(!owned.closed)await pause(200);
  }
  const result=await owned.done;
  if(!crashRequested)for(const deadline=Date.now()+45000;lockSnapshot()!==null&&Date.now()<deadline;)await pause(250);
  const remainingLock=lockSnapshot(),backendLockReleased=remainingLock===null,endedPackageHashes=await packageHashes();
  const exit={...initial,endedAt:new Date().toISOString(),result,crashRequested,childSignals,backendLockReleased,remainingLock,endedPackageHashes};
  await writeReport(label+'-exit.json',exit);assert.deepEqual(endedPackageHashes,hashes);
  if(crashRequested){
   assert.deepEqual(result,{code:null,signal:'SIGKILL'});assert.equal(backendLockReleased,false,'Expected the real crash to leave a stale lock');
   assert.deepEqual(remainingLock,readJson(path.join(report,'before-crash-audit.json')).lock);
  }else{assert.deepEqual(result,{code:0,signal:null});assert.equal(backendLockReleased,true,'Normal quit did not release the backend lock');}
 }catch(error){if(owned&&!owned.closed)await owned.stop();throw error;}
 finally{await log.close();}
}
async function crash(label){
 assert.equal(label,'first','Only the initial exact owned native main process may be crashed');const preparedFixture=fixture();
 assert.equal(await exists(path.join(report,'first-exit.json')),false,'The initial launch already exited');
 const launchRecord=readJson(path.join(report,'first-launch.json')),before=readJson(path.join(report,'before-crash-audit.json'));
 assertRemembered(before,preparedFixture);assert.deepEqual(locator(),before.locator);assert.deepEqual(lockSnapshot(),before.lock);
 await writeFile(path.join(runtime,'first-crash-request.json'),json({fixtureId:preparedFixture.id,label,launchId:launchRecord.launchId}),{mode:0o600,flag:'wx'});
}
async function inspectCrash(){
 const preparedFixture=fixture(),exit=readJson(path.join(report,'first-exit.json')),connection=readJson(path.join(report,'first-connection.json'));
 assert.deepEqual(exit.result,{code:null,signal:'SIGKILL'});
 const before=readJson(path.join(report,'before-crash-audit.json')),nativeNamespaces=await namespaces();
 assert.deepEqual(nativeNamespaces,connection.namespaces,'Inspect in the native PID/network namespaces, not another executor');
 assert.deepEqual(await safeConnection(),Object.fromEntries(Object.entries(connection).filter(([key])=>['origin','port','backendPid','channel','namespaces'].includes(key))));
 let stat,probe;
 for(const deadline=Date.now()+45000;;){
  assert.deepEqual(lockSnapshot(),before.lock,'Crash inspection must leave the exact stale lock untouched');
  stat=await processStat(connection.backendPid);probe=await health(connection.origin);
  if((stat===null&&probe.error==='ECONNREFUSED')||Date.now()>=deadline)break;
  await pause(250);
 }
 const result={synthetic:true,fixtureId:preparedFixture.id,at:new Date().toISOString(),namespaces:nativeNamespaces,
  origin:connection.origin,port:connection.port,reportedBackendPid:connection.backendPid,stat,backendProcessAbsent:stat===null,
  health:probe,lock:lockSnapshot(),lockUnchanged:JSON.stringify(lockSnapshot())===JSON.stringify(before.lock),numericPidSignals:0};
 await writeReport('crash-inspection.json',result);
 assert.equal(result.backendProcessAbsent,true,'Backend still exists; do not relaunch or remove its lock');
 assert.equal(probe.error,'ECONNREFUSED','Old backend port is not confirmed closed');assert.equal(result.lockUnchanged,true);
 return result;
}

async function verifyExport(){
 const preparedFixture=fixture(),before=readJson(path.join(report,'after-reopen-audit.json'));
 const pending=readDatabase().rows.exports.map(row=>JSON.parse(row.data));
 assert.equal(pending.length,1);assert.equal(pending[0].status,'succeeded','Wait for the one native export to succeed before verification');
 const result=await audit('after-export');
 assertRemembered(result,preparedFixture);assert.deepEqual(result.locator,before.locator);assert.equal(result.schemaSha256,before.schemaSha256);
 assert.equal(before.exports.length,0);assert.equal(result.exports.length,1);
 const exported=result.exports[0];assert.equal(exported.status,'succeeded');assert.equal(exported.purpose,'export');assert.equal(exported.mode,'timeline');
 assert.equal(exported.projectId,preparedFixture.target.id);assert.equal(exported.timelineRevision,preparedFixture.baseRevision);
 assert.deepEqual(exported.snapshot.timeline,preparedFixture.expectedTimeline);
 for(const [name,table] of Object.entries(before.tables)){
  if(['assets','exports','timeline_requests'].includes(name)){
   assert.equal(result.tables[name].count,table.count+1,`One export must add exactly one ${name} row`);
   for(const hash of table.rowSha256)assert.ok(result.tables[name].rowSha256.includes(hash),`Original ${name} row changed`);
  }else assert.deepEqual(result.tables[name],table,`Export unexpectedly changed ${name}`);
 }
 assert.deepEqual(Object.keys(result.tables),Object.keys(before.tables));assert.deepEqual(result.timelines,before.timelines);
 const request=result.timelineRequests.filter(item=>!before.timelineRequests.some(prior=>prior.requestId===item.requestId));
 assert.equal(request.length,1);assert.equal(request[0].requestId,exported.requestId);assert.equal(request[0].response.id,exported.id);
 assert.equal(request[0].response.status,'queued');assert.deepEqual(request[0].response.snapshot,exported.snapshot);
 for(const original of before.media)assert.deepEqual(result.media.find(item=>item.name===original.name),original);
 assert.equal(result.media.length,before.media.length+1);
 const asset=result.assets.find(item=>item.id===exported.assetId);assert.ok(asset);assert.equal(asset.projectId,preparedFixture.target.id);assert.equal(asset.provenance,'export');
 assert.match(asset.relativePath,/^media\/[a-zA-Z0-9._-]+\.mp4$/);const file=path.join(workspace,asset.relativePath),output=await fileHash(file,32*1024*1024);
 assert.equal(output.sha256,asset.sha256);assert.ok(!before.media.some(item=>item.name===path.basename(file)));
 await command('/usr/bin/ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],'export-probe');
 const probe=readJson(path.join(runtime,'export-probe.stdout')),video=probe.streams.find(stream=>stream.codec_type==='video'),audio=probe.streams.find(stream=>stream.codec_type==='audio');
 assert.ok(video&&audio);assert.equal(video.width,1280);assert.equal(video.height,720);assert.equal(video.r_frame_rate,'30/1');assert.equal(Number(video.nb_frames),60);assert.equal(audio.sample_rate,'48000');
 await command('/usr/bin/ffmpeg',['-v','error','-i',file,'-f','null','-'],'export-decode');
 const verification={synthetic:true,fixtureId:preparedFixture.id,at:new Date().toISOString(),exportId:exported.id,assetId:asset.id,requestId:exported.requestId,
  onlyAddedRows:{assets:1,exports:1,timeline_requests:1},originalMediaUnchanged:true,output,
  video:{width:video.width,height:video.height,rate:video.r_frame_rate,frames:Number(video.nb_frames)},audio:{codec:audio.codec_name,sampleRate:audio.sample_rate},decodeExit:0};
 await writeReport('export-verification.json',verification);return verification;
}
async function final(){
 const preparedFixture=fixture();for(const deadline=Date.now()+45000;!await exists(path.join(report,'final-exit.json'))&&Date.now()<deadline;)await pause(100);
 assert.equal(await exists(path.join(report,'final-exit.json')),true,'Final owned normal exit has not settled');
 assert.equal(lockSnapshot(),null,'Final normal quit has not released its lock');
 const screenshots=[];for(const name of ['01-first-fallback','02-explicit-target-saved','03-crash-reopened-target','04-normal-reopened-target']){
  const file=path.join(report,name+'.jpg'),header=await open(file,'r');try{const bytes=Buffer.alloc(3);await header.read(bytes,0,3,0);assert.equal(bytes.toString('hex'),'ffd8ff');}finally{await header.close();}
  screenshots.push({name:name+'.jpg',...await fileHash(file,32*1024*1024)});
 }
 const result=await audit('final'),before=readJson(path.join(report,'before-crash-audit.json'));
 const prepared=readJson(path.join(report,'prepared-audit.json')),firstBoot=readJson(path.join(report,'first-boot-audit.json'));
 const recovered=readJson(path.join(report,'after-reopen-audit.json')),normalReopened=readJson(path.join(report,'after-normal-reopen-audit.json'));
 const normalBeforeExport=await exists(path.join(report,'normal-reopen-before-export-audit.json'))?readJson(path.join(report,'normal-reopen-before-export-audit.json')):null;
 if(normalBeforeExport){assertUnchanged(normalBeforeExport,before);assert.deepEqual(normalBeforeExport.locator,before.locator);}
 assert.equal(prepared.locator,null);assert.equal(firstBoot.locator,null);assertRemembered(result,preparedFixture);
 assertUnchanged(firstBoot,prepared,{allowFallbackPreferences:true});assertUnchanged(before,prepared,{allowFallbackPreferences:true});
 assertUnchanged(recovered,before);assert.deepEqual(recovered.locator,before.locator);
 const exportVerification=await exists(path.join(report,'export-verification.json'))?readJson(path.join(report,'export-verification.json')):null;
 const baseline=exportVerification?readJson(path.join(report,'after-export-audit.json')):before;
 assertUnchanged(normalReopened,baseline);assertUnchanged(result,baseline);assert.deepEqual(result.locator,before.locator);assert.deepEqual(normalReopened.locator,before.locator);
 const launches=[],connections=[],exits=[];
 for(const label of ['first','reopen','final']){
  launches.push(readJson(path.join(report,label+'-launch.json')));connections.push(readJson(path.join(report,label+'-connection.json')));exits.push(readJson(path.join(report,label+'-exit.json')));
 }
 assert.equal(new Set(launches.map(item=>item.launchId)).size,3);assert.equal(new Set(launches.map(item=>item.mainPid)).size,3);
 assert.notEqual(connections[0].port,connections[1].port);assert.notEqual(connections[0].backendPid,connections[1].backendPid);
 const currentHashes=await packageHashes();for(const item of [...launches,...exits])assert.deepEqual(item.packageHashes,currentHashes);
 for(const item of exits)assert.deepEqual(item.endedPackageHashes,currentHashes);
 assert.deepEqual(exits[0].result,{code:null,signal:'SIGKILL'});assert.deepEqual(exits[0].childSignals,['SIGKILL']);assert.equal(exits[0].backendLockReleased,false);
 for(const item of exits.slice(1)){assert.deepEqual(item.result,{code:0,signal:null});assert.equal(item.crashRequested,false);assert.deepEqual(item.childSignals,[]);assert.equal(item.backendLockReleased,true);}
 const inspection=readJson(path.join(report,'crash-inspection.json'));assert.equal(inspection.backendProcessAbsent,true);assert.equal(inspection.health.error,'ECONNREFUSED');assert.equal(inspection.lockUnchanged,true);
 const summary={synthetic:true,scenario:'last-project',platform:'linux',productionBackend:true,fixtureId:preparedFixture.id,
  selectedTarget:preparedFixture.target,originalFallback:preparedFixture.originalFallback,selectedTargetIsNotOrdinaryFallback:true,
  originalLocatorAbsent:true,locatorRevision:result.locator.revision,locatorBytesUnchangedAcrossRecovery:true,
  targetEditingPreferencesUnchanged:true,businessTablesAndRequestsUnchangedBeforeExport:true,originalMediaUnchanged:true,
  ports:connections.map(({label,origin,port,backendPid})=>({label,origin,port,backendPid})),differentOriginAfterCrash:true,
  packageHashes:currentHashes,crash:exits[0],normalExits:exits.slice(1),crashInspection:inspection,
  exportVerification,normalReopenBeforeExportAudited:Boolean(normalBeforeExport),screenshots,uiEvidence:'Native screenshots reviewed by the operator; no injected renderer inspection',
  deliveryScope:'report only; exclude private-runtime, browser profiles, discovery files, credentials, database and media'};
 await writeReport('summary.json',summary);return summary;
}

const [action,label,...extra]=process.argv.slice(2);assert.equal(extra.length,0,'Unexpected fixture arguments');
if(action==='prepare')console.log(json(await prepare()));
else if(action==='launch')await launch(label);
else if(action==='audit')console.log(json(await audit(label)));
else if(action==='crash')await crash(label);
else if(action==='inspect-crash')console.log(json(await inspectCrash()));
else if(action==='verify-export')console.log(json(await verifyExport()));
else if(action==='final')console.log(json(await final()));
else throw Error('Expected prepare/launch first|reopen|final/audit label/crash first/inspect-crash/verify-export/final');
