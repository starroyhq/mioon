/** Bounded, disposable Gate C fixture. Native gestures belong to the supported
 * computer-use driver, never this helper. No backend injection or live provider.
 *
 * node tests/workspace-restore-qa-native.mjs prepare
 * node tests/workspace-restore-qa-native.mjs launch ordinary
 * node tests/workspace-restore-qa-native.mjs launch first
 * node tests/workspace-restore-qa-native.mjs audit after-edit
 * node tests/workspace-restore-qa-native.mjs launch reopen
 * node tests/workspace-restore-qa-native.mjs final
 *
 * A launch owns exactly its ChildProcess until normal app exit. No automatic
 * restart, credential generation, stale-lock removal, PID signalling, sandbox
 * flag, GPU flag, browser driver, or production-code modification is used.
 * Reports and their archive exclude private-runtime (all userData and logs).
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {deflateSync} from 'node:zlib';
import {constants} from 'node:fs';
import {readFile,writeFile,readdir,lstat,open,mkdir,realpath} from 'node:fs/promises';
import {ensurePrivateDirectory} from '../packages/contracts/src/private-storage.mjs';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {createEditTasks} from '../packages/business/src/edit-tasks.mjs';
import {createMockProvider} from '../packages/business/src/providers/mock.mjs';
import {ownQaChild} from './agent-timeline-move-qa-native.mjs';

const repo=fileURLToPath(new URL('../',import.meta.url));
// native/ retains the initial real-Mock schema rejection. native-v2/ retains a
// source24-only diagnostic, explicitly not acceptance. This fresh attempt must
// retain the actual ordinary Mock schema and real local provider ledger.
const root=path.join(repo,'evidence/workspace-restore/native-v3');
const runtime=path.join(root,'private-runtime'),report=path.join(root,'report');
const paths=Object.freeze({root,runtime,report,source:path.join(runtime,'original-workspace'),
  backup:path.join(runtime,'verified-original-backup'),userData:path.join(runtime,'restored-user-data'),
  workspace:path.join(runtime,'restored-user-data/workspace'),
  ordinaryUserData:path.join(runtime,'ordinary-user-data'),ordinaryWorkspace:path.join(runtime,'ordinary-user-data/workspace'),
  sourceVideo:path.join(runtime,'synthetic-green-880hz.mp4'),extraPng:path.join(runtime,'synthetic-extra-magenta.png')});
const limit=Object.freeze({tables:128,rows:500,allRows:5000,sqlBytes:16*1024*1024,
  files:256,fileBytes:64*1024*1024,totalBytes:256*1024*1024,
  packageFiles:512,packageFileBytes:512*1024*1024,packageBytes:2*1024*1024*1024,
  outputBytes:2*1024*1024,commandMs:120000,nativeMs:45*60*1000});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
const stamp=()=>new Date().toISOString();
const q=name=>{if(!/^[A-Za-z_][A-Za-z_0-9]*$/u.test(name))throw Error('Unexpected SQL identifier');return '"'+name+'"';};
async function absent(file){try{await lstat(file);return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}}
async function readJson(file,max=limit.sqlBytes){const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>max)throw Error('Bounded report expected');return JSON.parse(await readFile(file,'utf8'));}
async function save(name,value){if(!/^[a-z0-9][a-z0-9.-]{0,90}\.json$/u.test(name))throw Error('Unexpected report name');const bytes=Buffer.from(json(value));if(bytes.length>limit.sqlBytes)throw Error('Report byte bound');await writeFile(path.join(report,name),bytes,{mode:0o600,flag:'wx'});return {bytes:bytes.length,sha256:sha(bytes)};}
function environment(userData=paths.userData){const env=Object.fromEntries(['PATH','HOME','LANG','LC_ALL','DISPLAY','XAUTHORITY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','TMPDIR'].filter(key=>typeof process.env[key]==='string').map(key=>[key,process.env[key]]));return {...env,MIOON_DESKTOP_USER_DATA:userData,MIOON_ENABLE_LIVE_PROVIDER:'0',MIOON_FFMPEG_PATH:'/usr/bin/ffmpeg',MIOON_FFPROBE_PATH:'/usr/bin/ffprobe'};}
async function cold(directory){if(!(await absent(path.join(directory,'server.lock'))))throw Error('Close the owned native backend normally; no lock is removed');for(const suffix of ['-wal','-journal']){const file=path.join(directory,'workbench.sqlite'+suffix);if(!(await absent(file))&&(await lstat(file)).size)throw Error('Closed checkpointed SQLite required');}}
async function fixture(){const value=await readJson(path.join(report,'fixture.json'));if(value.synthetic!==true||value.workspace!==paths.workspace||value.source!==paths.source)throw Error('Unexpected fixture identity');return value;}
async function hashFile(file,max=limit.fileBytes){
 const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>max)throw Error('Unexpected bounded regular file');
 const fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW),digest=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let count=0;
 try{for(;;){const {bytesRead}=await fd.read(buffer,0,buffer.length,null);if(!bytesRead)break;count+=bytesRead;if(count>max)throw Error('File grew past bound');digest.update(buffer.subarray(0,bytesRead));}const after=await fd.stat();if(count!==stat.size||after.ino!==stat.ino||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw Error('File changed during hashing');}
 finally{await fd.close();}
 return {bytes:count,mode:stat.mode&0o777,sha256:digest.digest('hex')};
}
async function tree(directory,{entries,maxFiles=limit.files,maxFileBytes=limit.fileBytes,maxBytes=limit.totalBytes}={}){
 const out={};let total=0,count=0;
 async function visit(relative,depth){if(depth>8||++count>maxFiles)throw Error('Tree entry bound');const file=path.join(directory,relative),stat=await lstat(file);if(stat.isSymbolicLink())throw Error('Tree links refused');if(stat.isDirectory()){out[relative||'.']={kind:'directory',mode:stat.mode&0o777};const names=(await readdir(file)).sort();if(names.length>maxFiles)throw Error('Directory bound');for(const name of names)await visit(path.join(relative,name),depth+1);}else{const info=await hashFile(file,maxFileBytes);if((total+=info.bytes)>maxBytes)throw Error('Tree byte bound');out[relative]={kind:'file',...info};}}
 if(entries){for(const name of entries)if(!(await absent(path.join(directory,name))))await visit(name,0);}else await visit('',0);
 return out;
}
const managedTree=directory=>tree(directory,{entries:['workbench.sqlite','media','image-staging','frame-staging']});

// All data cells retain SQLite type plus exact CAST(... AS BLOB) bytes. In
// particular TEXT whitespace, BLOB bytes and NULL are never JSON-normalized.
function rawTable(db,name,columns,where='',parameters=[]){
 const allColumns=columns??db.prepare(`PRAGMA table_info(${q(name)})`).all().map(row=>row.name);
 if(allColumns.length>64)throw Error('SQL column bound');
 const size=allColumns.map(column=>`coalesce(length(CAST(${q(column)} AS BLOB)),0)`).join('+');
 const budget=db.prepare(`SELECT count(*) AS records,coalesce(sum(${size}),0) AS bytes FROM ${q(name)} ${where}`).get(...parameters);
 if(budget.records>limit.rows||budget.bytes>limit.sqlBytes/4)throw Error('SQL materialization bound');
 const select=allColumns.flatMap((column,index)=>[`typeof(${q(column)}) AS t${index}`,`hex(CAST(${q(column)} AS BLOB)) AS v${index}`]);
 const values=db.prepare(`SELECT CAST(rowid AS TEXT) AS capturedRowid,${select.join(',')} FROM ${q(name)} ${where} ORDER BY rowid LIMIT ${limit.rows+1}`).all(...parameters);
 if(values.length>limit.rows)throw Error('SQL row bound');
 return {columns:allColumns,rows:values.map(row=>({rowid:row.capturedRowid,values:allColumns.map((_,index)=>({type:row['t'+index],hex:row['v'+index]}))}))};
}
function rawSnapshot(db){
 const names=db.prepare(`SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name LIMIT ${limit.tables+1}`).all().map(row=>row.name);
 if(names.length>limit.tables)throw Error('SQL table bound');const tables={};let count=0,bytes=0;
 for(const name of names){const value=rawTable(db,name);count+=value.rows.length;bytes+=Buffer.byteLength(JSON.stringify(value));if(count>limit.allRows||bytes>limit.sqlBytes)throw Error('SQL aggregate bound');tables[name]=value;}return tables;
}
function cell(row,table,column){const value=row.values[table.columns.indexOf(column)];if(!value)throw Error('Missing captured column');return value.type==='null'?null:Buffer.from(value.hex,'hex').toString('utf8');}
function decoded(table,column='data'){return table.rows.map(row=>JSON.parse(cell(row,table,column)));}
async function readDb(callback,directory=paths.workspace){
 const db=new DatabaseSync(path.join(directory,'workbench.sqlite'),{readOnly:true});
 try{db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN;');const value=callback(db);db.exec('COMMIT');return value;}
 finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}
}

// Own the exact handle, bound both pipes, wait for its actual close, and retain
// exit evidence even after timeout/error. Raw native logs never enter reports.
async function ownedCommand(executable,args,label,{native=false,timeout=limit.commandMs,userData=paths.userData}={}){
 if(!/^[a-z0-9-]{1,70}$/u.test(label))throw Error('Invalid command label');
 const owned=ownQaChild(spawn(executable,args,{cwd:repo,env:environment(userData),stdio:['ignore','pipe','pipe']}));
 const chunks={stdout:[],stderr:[]},sizes={stdout:0,stderr:0};let failure,timer,stopPromise,rejectCleanup;
 const cleanupFailed=new Promise((_,reject)=>{rejectCleanup=reject;});cleanupFailed.catch(()=>{});
 const stop=reason=>{failure??=reason;stopPromise??=owned.stop();stopPromise.catch(rejectCleanup);};
 const onSignal=signal=>stop(Error('Owned launcher received '+signal));const onTerm=()=>onSignal('SIGTERM'),onInt=()=>onSignal('SIGINT');
 process.once('SIGTERM',onTerm);process.once('SIGINT',onInt);
 for(const key of ['stdout','stderr'])owned.child[key].on('data',chunk=>{if(failure)return;sizes[key]+=chunk.length;if(sizes[key]>limit.outputBytes)return stop(Error('Owned output bound exceeded'));chunks[key].push(chunk);});
 timer=setTimeout(()=>stop(Error('Owned command deadline exceeded')),timeout);
 const finish=async()=>{let result;try{result=await Promise.race([owned.done,cleanupFailed]);if(stopPromise)await stopPromise;}finally{clearTimeout(timer);process.removeListener('SIGTERM',onTerm);process.removeListener('SIGINT',onInt);}
  const stdout=Buffer.concat(chunks.stdout),stderr=Buffer.concat(chunks.stderr);
  await writeFile(path.join(runtime,label+'.stdout'),stdout,{mode:0o600,flag:'wx'});await writeFile(path.join(runtime,label+'.stderr'),stderr,{mode:0o600,flag:'wx'});
  await save(label+'-exit.json',{at:stamp(),synthetic:true,code:result.code,signal:result.signal,error:result.error??null,normal:!failure&&result.code===0&&!result.signal&&!result.error,stdoutBytes:stdout.length,stderrBytes:stderr.length,...(failure?{helperFailure:failure.message}:{})});
  if(failure||result.code!==0||result.signal||result.error)throw failure??Error('Owned command did not exit normally');return {stdout,stderr};};
 const completion=finish();completion.catch(()=>{});return native?{owned,finish:()=>completion}:completion;
}
async function offline(command){
 const args=['apps/cli/src/backup.mjs',command,...(command==='create'?['--source',paths.source,'--destination',paths.backup]:command==='restore'?['--directory',paths.backup,'--destination',paths.workspace]:['--directory',paths.backup])];
 const {stdout}=await ownedCommand(process.execPath,args,'offline-'+command),result=JSON.parse(stdout.toString('utf8'));
 assert.equal(result.ok,true);if(command==='restore'){assert.equal(result.data.publication,'confirmed');assert.equal(result.data.databaseSchemaVersion,25);}else assert.equal(result.data.integrity,'verified');
 assert.equal(result.data.warnings,undefined);await save('offline-'+command+'.json',{synthetic:true,args,result});return result.data;
}
function syntheticPng(){
 const chunk=(type,bytes)=>{const name=Buffer.from(type),body=Buffer.concat([name,bytes]),out=Buffer.alloc(bytes.length+12);out.writeUInt32BE(bytes.length,0);body.copy(out,4);let crc=0xffffffff;for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;};
 const header=Buffer.alloc(13);header.writeUInt32BE(64,0);header.writeUInt32BE(64,4);header[8]=8;header[9]=2;
 const pixels=Buffer.alloc(64*(1+64*3));for(let y=0;y<64;y++)for(let x=0;x<64;x++){const offset=y*193+1+x*3;pixels[offset]=230;pixels[offset+1]=(x<32)===(y<32)?35:95;pixels[offset+2]=190;}
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
async function verifyOriginals(baseline){
 await cold(paths.source);assert.deepEqual(await managedTree(paths.source),baseline.sourceFiles,'Original source bytes/modes changed');
 assert.deepEqual(await tree(paths.backup),baseline.backupFiles,'Original backup bytes/modes changed');
 assert.deepEqual(await hashFile(paths.sourceVideo),baseline.inputVideo,'Synthetic input video changed');assert.deepEqual(await hashFile(paths.extraPng),baseline.extraPng,'Synthetic PNG changed');
}
async function prepareOrdinary(){
 ensurePrivateDirectory(paths.ordinaryUserData,{create:true});
 const store=openStore(paths.ordinaryWorkspace),services=createServices(store,new Map());
 try{
  const project=await services.call('project.create',{name:'普通工作区 · 同一生产包导出验收'}),bytes=await readFile(paths.sourceVideo);
  const asset=await services.call('asset.import',{projectId:project.id,name:'普通工作区 · 绿色与 880Hz.mp4',mimeType:'video/mp4',dataBase64:bytes.toString('base64')});
  let timeline=await services.call('timeline.format.set',{projectId:project.id,expectedProjectRevision:project.revision,expectedRevision:0,requestId:randomUUID(),presetId:'landscape_720'});
  timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:asset.id,trackId:timeline.tracks[0].id,startFrame:0,sourceInFrame:0,durationFrames:90,name:'普通工作区 · 3 秒原片'});
  assert.equal(store.list('jobs').length,0);assert.equal(store.list('exports').length,0);
  return {projectId:project.id,assetId:asset.id,timelineId:timeline.id,clipId:timeline.clips[0].id,sourceSha256:asset.sha256};
 }finally{await services.drain();store.close();}
}
function assertCaptured(db,baseline){
 const holds=rawTable(db,'workspace_restore_holds');if(baseline.holds)assert.deepEqual(holds,baseline.holds,'Captured holds changed');
 for(const hold of holds.rows){const kind=cell(hold,holds,'kind'),rowid=cell(hold,holds,'capturedRowid'),source=baseline.sourceRows[kind];if(!source)throw Error('Held table absent from baseline');const before=source.rows.find(row=>row.rowid===rowid);if(!before)throw Error('Held row absent from baseline');const after=rawTable(db,kind,source.columns,'WHERE rowid=?',[rowid]);assert.deepEqual(after.rows,[before],`Captured ${kind} row changed`);}
 for(const [sourceName,target] of [['timeline_history','workspace_restore_timeline_history'],['timeline_history_cursors','workspace_restore_timeline_cursors']]){
  const source=baseline.sourceRows[sourceName],archived=rawTable(db,target,source.columns);assert.deepEqual(archived,source,'Captured timeline history archive changed');
 }
 for(const name of ['mock_provider_tasks','mock_provider_submissions'])if(baseline.sourceRows[name])assert.deepEqual(rawTable(db,name),baseline.sourceRows[name],'Unexpected inherited Mock provider activity');
 if(baseline.sourceRows.mock_provider_submissions){const source=baseline.sourceRows.sqlite_sequence,before=source.rows.filter(row=>cell(row,source,'name')==='mock_provider_submissions'),after=rawTable(db,'sqlite_sequence',source.columns,"WHERE name='mock_provider_submissions'");assert.deepEqual(after.rows,before,'Captured Mock submission sequence changed');}
 return holds.rows.length;
}
export async function prepareRestoreNative(){
 await mkdir(path.dirname(root),{recursive:true});ensurePrivateDirectory(root,{create:true});
 if(!(await absent(path.join(report,'fixture.json')))){const value=await fixture();await verifyOriginals(await readJson(path.join(report,'baseline.json')));return value;}
 // An incomplete preparation is never silently resumed, removed or reused.
 for(const directory of [runtime,report]){if(!(await absent(directory)))throw Error('Incomplete fixture exists; preserve it for review');ensurePrivateDirectory(directory,{create:true});}
 ensurePrivateDirectory(paths.userData,{create:true});
 await ownedCommand('/usr/bin/ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=0x18bf57:s=320x180:r=30:d=3','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=3','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-ac','2','-t','3','-movflags','+faststart','-n',paths.sourceVideo],'prepare-video');
 await writeFile(paths.extraPng,syntheticPng(),{mode:0o600,flag:'wx'});
 const oldEnv={MIOON_FFMPEG_PATH:process.env.MIOON_FFMPEG_PATH,MIOON_FFPROBE_PATH:process.env.MIOON_FFPROBE_PATH};
 process.env.MIOON_FFMPEG_PATH='/usr/bin/ffmpeg';process.env.MIOON_FFPROBE_PATH='/usr/bin/ffprobe';
 let store,services,tasks,description,sourceRows,ordinary;
 try{
  store=openStore(paths.source);const mock=createMockProvider({db:store.db,root:paths.source});services=createServices(store,new Map([['mock',mock]]));tasks=createEditTasks({store,services});
  const project=await services.call('project.create',{name:'工作区恢复 · 本地合成验收',description:'Synthetic local restore branch. No real provider requests.'});
  const bytes=await readFile(paths.sourceVideo),asset=await services.call('asset.import',{projectId:project.id,name:'绿色与 880Hz 合成原片.mp4',mimeType:'video/mp4',dataBase64:bytes.toString('base64')});
  let timeline=await services.call('timeline.format.set',{projectId:project.id,expectedProjectRevision:project.revision,expectedRevision:0,requestId:randomUUID(),presetId:'landscape_720'});
  timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:asset.id,trackId:timeline.tracks[0].id,startFrame:0,sourceInFrame:0,durationFrames:90,name:'恢复后编辑与撤销 · 3 秒原片'});
  const oldPreview=await services.call('timeline.render',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'preview'});
  const pending=tasks.prepare({projectId:project.id,operation:'timeline.clip.update',input:{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),clipId:timeline.clips[0].id,patch:{name:'Captured pending edit: must never run'}},origin:'new'});
  const jobs=[];
  for(const status of ['queued','running','submission_unknown']){
   const shot=await services.call('shot.create',{projectId:project.id,title:'历史冻结任务 · '+status,prompt:'Synthetic held '+status+' record. Never submit.',requestId:randomUUID()});
   let job=await services.call('generation.submit',{shotId:shot.id,expectedRevision:shot.revision,providerId:'mock',requestId:randomUUID(),...(status==='submission_unknown'?{parameters:{scenario:'accepted_then_response_lost'}}:{})});
   // Exercise the actual local Mock ledger without a worker, network request,
   // poll, download or render. The unknown scenario commits its local provider
   // acceptance before deliberately losing the reply. Both remain captured.
   if(status!=='queued'){
    let providerJobId=null;
    if(status==='running')providerJobId=(await mock.submit(job.snapshot,{requestId:job.requestId,jobId:job.id})).providerJobId;
    else await assert.rejects(mock.submit(job.snapshot,{requestId:job.requestId,jobId:job.id}),error=>error.code==='SUBMISSION_UNKNOWN'&&error.uncertain===true);
    job=services.saveJob(job,{status,phase:status==='running'?'polling':'reconciliation_required',submissionCount:1,providerJobId,error:status==='submission_unknown'?{code:'SUBMISSION_UNKNOWN',message:'Synthetic local Mock acceptance with lost reply; no external request occurred.',retryable:true}:null});
   }
   jobs.push({id:job.id,status});
  }
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM mock_provider_tasks').get().n,2);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM mock_provider_submissions').get().n,2);
  assert.equal(store.db.prepare('SELECT sum(poll_count+download_attempts) AS n FROM mock_provider_tasks').get().n,0);
  await tasks.drain();await services.drain();sourceRows=rawSnapshot(store.db);
  description={...paths,synthetic:true,projectId:project.id,assetId:asset.id,timelineId:timeline.id,clipId:timeline.clips[0].id,originalPreviewId:oldPreview.id,pendingTaskId:pending.task.id,jobs,initialTimeline:timeline};
  ordinary=await prepareOrdinary();
 }finally{
  try{await tasks?.drain();await services?.drain();}finally{store?.close();for(const [key,value] of Object.entries(oldEnv))if(value===undefined)delete process.env[key];else process.env[key]=value;}
 }
 await cold(paths.source);
 const sourceFiles=await managedTree(paths.source),sourceRowsRecord=await save('original-raw-rows.json',{synthetic:true,tables:sourceRows});
 const created=await offline('create'),backupFiles=await tree(paths.backup),verified=await offline('verify');
 assert.deepEqual(await managedTree(paths.source),sourceFiles);assert.deepEqual(await tree(paths.backup),backupFiles);
 const restored=await offline('restore');await cold(paths.workspace);
 const baseline={synthetic:true,at:stamp(),sourceFiles,backupFiles,inputVideo:await hashFile(paths.sourceVideo),extraPng:await hashFile(paths.extraPng),sourceRows,sourceRowsRecord,created,verified,restored};
 await verifyOriginals(baseline);
 baseline.holds=await readDb(db=>{
  for(const [name,before] of Object.entries(sourceRows)){if(name==='schema_version')continue;assert.deepEqual(rawTable(db,name,before.columns),before,`Immediate restore preservation: ${name}`);}
  assertCaptured(db,baseline);return rawTable(db,'workspace_restore_holds');
 });
 const sealed=await save('baseline.json',baseline);await save('baseline-seal.json',{synthetic:true,sha256:sealed.sha256,bytes:sealed.bytes});
 await save('fixture.json',{...description,ordinary,workspaceOrigin:restored.workspaceOrigin,sourceSha256:baseline.inputVideo.sha256,extraPngSha256:baseline.extraPng.sha256,heldCount:baseline.holds.rows.length});
 await auditRestoreNative('prepared');return fixture();
}
async function baseline(){const seal=await readJson(path.join(report,'baseline-seal.json')),file=await hashFile(path.join(report,'baseline.json'),limit.sqlBytes);assert.equal(file.sha256,seal.sha256);assert.equal(file.bytes,seal.bytes);const value=await readJson(path.join(report,'baseline.json'));assert.equal(value.synthetic,true);return value;}
export async function auditRestoreNative(label){
 if(!/^[a-z0-9-]{1,48}$/u.test(label))throw Error('Invalid audit label');const f=await fixture(),b=await baseline();await verifyOriginals(b);
 const value=await readDb(db=>{
  const heldCount=assertCaptured(db,b),tables=rawSnapshot(db);
  return {heldCount,tables,restoration:db.prepare('SELECT restorationId,workspaceOrigin,sourceBackupId,manifestHash,sourceDbHash,profile,createdAt FROM workspace_restoration WHERE id=1').get(),
   timeline:decoded(tables.timelines).find(item=>item.id===f.timelineId),exports:decoded(tables.exports),assets:decoded(tables.assets),
   newEditOperations:tables.edit_tasks.rows.filter(row=>!b.sourceRows.edit_tasks.rows.some(old=>old.rowid===row.rowid)&&cell(row,tables.edit_tasks,'status')==='applied').map(row=>cell(row,tables.edit_tasks,'operation'))};
 });
 assert.equal(value.restoration.workspaceOrigin,f.workspaceOrigin);
 const media=await tree(paths.workspace,{entries:['media','image-staging','frame-staging']});
 for(const [name,info] of Object.entries(b.sourceFiles))if(name!=='workbench.sqlite'&&info.kind==='file'){assert.equal(media[name]?.sha256,info.sha256,'Captured media changed');assert.equal(media[name]?.bytes,info.bytes);}
 const result={at:stamp(),synthetic:true,label,sourceUnchanged:true,backupUnchanged:true,capturedRowsUnchanged:true,capturedHistoryArchiveUnchanged:true,...value,media};await save(label+'-audit.json',result);return result;
}
async function auditOrdinary(label){
 const f=await fixture();await verifyOriginals(await baseline());
 const data=await readDb(db=>{const tables=rawSnapshot(db);assert.equal(tables.workspace_restoration,undefined);assert.equal(tables.jobs.rows.length,0,'No ordinary supplier work is part of this fixture');return {tables,assets:decoded(tables.assets),exports:decoded(tables.exports),timeline:decoded(tables.timelines).find(item=>item.id===f.ordinary.timelineId)};},paths.ordinaryWorkspace);
 const original=data.assets.find(item=>item.id===f.ordinary.assetId);assert.equal(original?.sha256,f.sourceSha256);assert.equal((await hashFile(path.join(paths.ordinaryWorkspace,original.relativePath))).sha256,f.sourceSha256);
 const value={synthetic:true,at:stamp(),label,profile:'ordinary',...data};await save(label+'-audit.json',value);return value;
}
async function packageIdentity(){
 const directory=path.join(repo,'release/desktop/production/linux-unpacked'),entry=path.join(directory,'mioon'),asar=path.join(directory,'resources/app.asar');
 const files=await tree(directory,{maxFiles:limit.packageFiles,maxFileBytes:limit.packageFileBytes,maxBytes:limit.packageBytes}),runtimes={};
 for(const [name,file] of Object.entries({node:process.execPath,ffmpeg:'/usr/bin/ffmpeg',ffprobe:'/usr/bin/ffprobe'})){const actual=await realpath(file);runtimes[name]={path:actual,...await hashFile(actual,limit.packageFileBytes)};}
 return {entry,asar,files,packageTreeSha256:sha(JSON.stringify(files)),executableSha256:files.mioon.sha256,asarSha256:files['resources/app.asar'].sha256,runtimes,sourceFiles:{packageJson:await hashFile(path.join(repo,'package.json')),lockfile:await hashFile(path.join(repo,'pnpm-lock.yaml'))},nodeVersion:process.version};
}
export async function launchRestoreNative(label){
 if(!['ordinary','first','reopen'].includes(label))throw Error('Only the explicit ordinary, first and reopen attempts are supported');await fixture();const workspace=label==='ordinary'?paths.ordinaryWorkspace:paths.workspace;await cold(workspace);await verifyOriginals(await baseline());
 if(!(await absent(path.join(report,'native-'+label+'-launch.json')))||!(await absent(path.join(report,'native-'+label+'-exit.json'))))throw Error('Native attempt already recorded; no automatic restart');
 if(label==='reopen'){const first=await readJson(path.join(report,'native-first-exit.json'));assert.equal(first.normal,true,'Reopen requires observed first normal exit');}
 const identity=await packageIdentity();
 for(const previous of ['ordinary','first','reopen'])if(!(await absent(path.join(report,'native-'+previous+'-launch.json')))){const prior=await readJson(path.join(report,'native-'+previous+'-launch.json'));assert.equal(identity.packageTreeSha256,prior.packageTreeSha256,'Packaged runtime changed between native sessions');assert.deepEqual(identity.runtimes,prior.runtimes);}
 if(label==='reopen'){const first=await readJson(path.join(report,'native-first-launch.json'));assert.equal(identity.packageTreeSha256,first.packageTreeSha256,'Packaged runtime changed between native sessions');assert.deepEqual(identity.runtimes,first.runtimes);}
 const native=await ownedCommand(identity.entry,[],'native-'+label,{native:true,timeout:limit.nativeMs,userData:label==='ordinary'?paths.ordinaryUserData:paths.userData});
 try{
  await save('native-'+label+'-launch.json',{at:stamp(),synthetic:true,pid:native.owned.child.pid,platform:'linux-x64',argv:[],backend:'unchanged packaged production backend',...identity});
  await native.finish();await cold(workspace);if(label==='ordinary')await auditOrdinary(label+'-exit');else await auditRestoreNative(label+'-exit');
 }catch(error){if(!native.owned.closed)await native.owned.stop();throw error;}
}
function toneEvidence(bytes){
 if(bytes.length%4||bytes.length<8000)throw Error('Expected decoded floating point audio');const count=bytes.length/4;let squares=0;const frequencies=[440,800,880,960,1760],powers={};
 for(let i=0;i<count;i++){const sample=bytes.readFloatLE(i*4);if(!Number.isFinite(sample))throw Error('Invalid PCM sample');squares+=sample*sample;}
 for(const hz of frequencies){let re=0,im=0;for(let i=0;i<count;i++){const value=bytes.readFloatLE(i*4),angle=2*Math.PI*hz*i/8000;re+=value*Math.cos(angle);im+=value*Math.sin(angle);}powers[hz]=(re*re+im*im)/(count*count);}
 const rms=Math.sqrt(squares/count),ratio=powers[880]/Math.max(1e-20,...frequencies.filter(hz=>hz!==880).map(hz=>powers[hz]));
 assert(rms>0.001,'Synthetic output must contain audible non-silent audio');assert(ratio>10,'Expected 880Hz synthetic audio');return {sampleRate:8000,samples:count,rms,powers,tone880ToOtherRatio:ratio};
}
export async function finalizeRestoreNative(){
 const f=await fixture();await cold(paths.workspace);await cold(paths.ordinaryWorkspace);
 for(const label of ['ordinary','first','reopen'])assert.equal((await readJson(path.join(report,'native-'+label+'-exit.json'))).normal,true,'Three normal native exits required');
 const audit=await auditRestoreNative('final'),ordinary=await auditOrdinary('ordinary-final'),b=await baseline();
 assert(audit.assets.some(asset=>asset.id!==f.assetId&&asset.sha256===f.extraPngSha256&&asset.mimeType==='image/png'),'The extra PNG must be imported through the native UI');
 assert(audit.newEditOperations.includes('timeline.clip.update'),'A fresh timeline clip edit is required');assert(audit.newEditOperations.includes('timeline.undo'),'A fresh undo is required');
 const captured=new Set(b.sourceRows.exports.rows.map(row=>cell(row,b.sourceRows.exports,'id'))),outputs=audit.exports.filter(item=>!captured.has(item.id)&&item.status==='succeeded');
 for(const purpose of ['preview','export'])assert(outputs.some(item=>item.purpose===purpose),'A fresh completed '+purpose+' is required');
 const ordinaryOutputs=ordinary.exports.filter(item=>item.status==='succeeded');assert(ordinaryOutputs.some(item=>item.purpose==='export'),'An ordinary completed export is required');
 if(outputs.length+ordinaryOutputs.length>8)throw Error('Native output audit bound');const probes=[];
 for(const {output,profile} of [...outputs.map(output=>({output,profile:'restored'})),...ordinaryOutputs.map(output=>({output,profile:'ordinary'}))]){
  const auditData=profile==='restored'?audit:ordinary,directory=profile==='restored'?paths.workspace:paths.ordinaryWorkspace,projectId=profile==='restored'?f.projectId:f.ordinary.projectId;
  const asset=auditData.assets.find(item=>item.id===output.assetId);assert(asset&&asset.projectId===projectId);if(!/^media\/[A-Za-z0-9.-]+\.mp4$/u.test(asset.relativePath))throw Error('Expected owned MP4');
  const file=path.join(directory,asset.relativePath),info=await hashFile(file);assert.equal(info.sha256,asset.sha256);
  const binding=profile==='restored'?await readDb(db=>db.prepare('SELECT exportId,projectId,workspaceOrigin FROM workspace_restore_export_origins WHERE exportId=?').get(output.id)):null;if(profile==='restored')assert.equal(binding?.workspaceOrigin,f.workspaceOrigin);
  const probe=await ownedCommand('/usr/bin/ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],'probe-'+output.id),metadata=JSON.parse(probe.stdout.toString('utf8'));
  const video=metadata.streams.find(item=>item.codec_type==='video'),audio=metadata.streams.find(item=>item.codec_type==='audio'),timeline=output.snapshot.timeline;
  assert(video&&audio,'Expected both video and audio');assert.equal(video.codec_name,'h264');assert.equal(audio.codec_name,'aac');assert.equal(video.width,timeline.width);assert.equal(video.height,timeline.height);assert.equal(video.avg_frame_rate,'30/1');assert(Math.abs(Number(metadata.format.duration)-timeline.durationFrames/30)<0.15,'Expected timeline duration');assert(Number(metadata.format.duration)<=10,'Synthetic duration bound');
  await ownedCommand('/usr/bin/ffmpeg',['-hide_banner','-v','error','-xerror','-threads','1','-i',file,'-map','0:v:0','-map','0:a:0','-f','null','-'],'decode-'+output.id);
  const pcm=await ownedCommand('/usr/bin/ffmpeg',['-hide_banner','-v','error','-threads','1','-i',file,'-map','0:a:0','-ac','1','-ar','8000','-t','10','-f','f32le','pipe:1'],'audio-'+output.id);
  probes.push({profile,exportId:output.id,purpose:output.purpose,file:asset.relativePath,...info,binding,probe:metadata,fullDecodePassed:true,audio:toneEvidence(pcm.stdout)});
 }
 await verifyOriginals(b);
 const summary={at:stamp(),synthetic:true,platform:'linux-x64',nativeExitCodes:{ordinary:0,first:0,reopen:0},originalSourceUnchanged:true,originalBackupUnchanged:true,capturedRowsAndHistoryUnchanged:true,newImportVerified:true,newEditAndUndoVerified:true,probes,
  limits:limit,evidenceScope:'Source/backup byte hashes, raw captured records and archived history, exact packaged runtime hashes, fresh import/edit/undo and restored preview/export plus ordinary export, three observed native exits. UI observations and screenshots are recorded separately by the supported computer-use driver. No claim of OS-wide network or subprocess tracing.',
  archiveExclusions:['private-runtime','userData','credentials','tokens','settings','native stdout/stderr'],archiveEntries:['report/*.json']};
 await save('summary.json',summary);
 const names=(await readdir(report)).sort();if(names.length>limit.files||names.some(name=>!name.endsWith('.json')))throw Error('Report-only archive bound');
 let total=0;for(const name of names){const info=await hashFile(path.join(report,name),limit.sqlBytes);total+=info.bytes;if(total>limit.totalBytes)throw Error('Archive byte bound');}
 const archive=path.join(root,'workspace-restore-native-evidence.tar.gz');if(!(await absent(archive)))throw Error('Evidence archive already exists');
 await ownedCommand('/usr/bin/tar',['-czf',archive,'--directory',root,...names.map(name=>'report/'+name)],'archive-reports');
 return {summary:path.join(report,'summary.json'),archive,...await hashFile(archive,limit.totalBytes),outputs:probes.length};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [command,arg,...rest]=process.argv.slice(2);if(rest.length)throw Error('Unexpected extra arguments');
 if(command==='prepare'&&arg===undefined)console.log(JSON.stringify(await prepareRestoreNative()));
 else if(command==='launch')await launchRestoreNative(arg);
 else if(command==='audit')console.log(JSON.stringify(await auditRestoreNative(arg)));
 else if(command==='final'&&arg===undefined)console.log(JSON.stringify(await finalizeRestoreNative()));
 else throw Error('Expected prepare | launch ordinary|first|reopen | audit <label> | final');
}
