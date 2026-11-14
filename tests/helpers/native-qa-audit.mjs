/** Native QA has no production inspection IPC. Live evidence is physical-only
 * in another process; logical evidence is collected only after every owner exits. */
import {constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';

/** @typedef {{projectId:string,projectFile:string,historyFile:string,cacheFile:string,coverExpected:boolean}} NativeQaProject */
/** @typedef {{kind:'application'|'project'|'history'|'cache',projectId?:string,file:string}} NativeQaDatabase */
/** @typedef {{formatVersion:1,dataDir:string,projects:NativeQaProject[],databases:NativeQaDatabase[]}} NativeQaLayout */
/** @typedef {{ownerPids:number[]}} OwnerOptions */
/** @typedef {{ownerPids:number[],maxBytes?:number,dummyKeyMarker?:boolean}} FileOptions */
/** @typedef {Record<string,import('node:sqlite').SQLOutputValue>} NativeQaSqlRow */
/** @typedef {{databases:Record<string,{schema:NativeQaSqlRow[],rows:Record<string,NativeQaSqlRow[]>}>,changeMarks:NativeQaSqlRow|undefined}} NativeQaSqlSnapshot */
/** @typedef {{contract:string,projects:Record<string,NativeQaSqlSnapshot>,application:NativeQaSqlSnapshot,preferences:Record<string,unknown>[],domainHash:string,changeMarksContract:string}} NativeQaColdSnapshot */

const MAX_FILE_BYTES=256*1024*1024,MAX_TOTAL_BYTES=1024*1024*1024,MAX_FILES=4096;
const stampKeys=['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs','birthtimeNs'];
const identityKeys=['dev','ino','mode','uid','gid','birthtimeNs'];
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp=(info,keys=stampKeys)=>Object.fromEntries(keys.map(key=>[key,String(info[key])]));
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const failure=(code,detail)=>Object.assign(new Error(`Native QA ${code}: ${detail}`),{code});
const absolute=file=>{if(typeof file!=='string'||!path.isAbsolute(file)||path.resolve(file)!==file)throw failure('NATIVE_QA_LAYOUT_INVALID','an absolute normalized path is required');return file;};
const pidList=pids=>{if(!Array.isArray(pids)||!pids.length||pids.some(pid=>!Number.isSafeInteger(pid)||pid<=1))throw failure('NATIVE_QA_OWNER_INVALID','explicit desktop/utility owner PIDs are required');return pids;};
export function nativeQaProcessAlive(pid){
  if(!Number.isSafeInteger(pid)||pid<=1)throw failure('NATIVE_QA_OWNER_INVALID','invalid owner PID');
  try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;if(error.code==='EPERM')return true;throw error;}
}
const stopped=pids=>{for(const pid of pidList(pids))if(nativeQaProcessAlive(pid))throw failure('NATIVE_QA_LIVE_OWNER',`owner ${pid} is still alive`);};
export function readNativeQaJson(file){
  absolute(file);if(!file.endsWith('.json'))throw failure('NATIVE_QA_UNSAFE_FILE','metadata must be JSON');
  if(!constants.O_NOFOLLOW)throw failure('NATIVE_QA_UNSUPPORTED','O_NOFOLLOW is required');
  const parents=ancestors(file),before=lstatSync(file,{bigint:true});regular(before,file,1024*1024);
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{
    if(!same(stamp(before),stamp(fstatSync(fd,{bigint:true}))))throw failure('NATIVE_QA_UNSTABLE',file);
    const buffer=Buffer.alloc(Number(before.size));let size=0;while(size<buffer.length){const count=readSync(fd,buffer,size,buffer.length-size,size);if(!count)throw failure('NATIVE_QA_UNSTABLE',file);size+=count;}
    if(!same(stamp(before),stamp(fstatSync(fd,{bigint:true})))||!same(stamp(before),stamp(lstatSync(file,{bigint:true}))))throw failure('NATIVE_QA_UNSTABLE',file);stableAncestors(parents);return JSON.parse(buffer.toString('utf8'));
  }finally{closeSync(fd);}
}
export function writeNativeQaJson(file,value){
  absolute(file);if(!file.endsWith('.json'))throw failure('NATIVE_QA_UNSAFE_FILE','evidence must be JSON');
  const parents=ancestors(file),before=lstatSync(file,{bigint:true,throwIfNoEntry:false});if(before)regular(before,file,16*1024*1024);
  const text=JSON.stringify(value,null,2);if(Buffer.byteLength(text)>16*1024*1024)throw failure('NATIVE_QA_LIMIT','report byte budget');
  const temporary=`${file}.${randomUUID()}.tmp`;let created=false;
  try{writeFileSync(temporary,text,{mode:0o600,flag:'wx'});created=true;stableAncestors(parents);
    const current=lstatSync(file,{bigint:true,throwIfNoEntry:false});if(!same(before?stamp(before):null,current?stamp(current):null))throw failure('NATIVE_QA_UNSTABLE',file);
    renameSync(temporary,file);created=false;
  }finally{if(created)unlinkSync(temporary);}
}
export function nativeQaOwners(runtime,{cold=false}={}){
  const launch=readNativeQaJson(path.join(runtime,'launch.json')),archive=path.join(runtime,'native-audit-owner.json');let connection;
  try{const value=readNativeQaJson(path.join(runtime,'user-data/mcp-connection.json'));connection={mainPid:launch.pid,utilityPid:value.pid,origin:value.url};}catch(error){if(error.code!=='ENOENT'||!cold)throw error;connection=readNativeQaJson(archive);}
  if(connection.mainPid!==launch.pid)throw failure('NATIVE_QA_OWNER_INVALID','the archived owner belongs to another launch');
  const origin=new URL(connection.origin);if(origin.protocol!=='http:'||!['127.0.0.1','localhost'].includes(origin.hostname)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw failure('NATIVE_QA_OWNER_INVALID','invalid native loopback origin');
  const ownerPids=pidList([launch.pid,connection.utilityPid]);
  if(cold)stopped(ownerPids);else{if(ownerPids.some(pid=>!nativeQaProcessAlive(pid)))throw failure('NATIVE_QA_OWNER_INVALID','a reported native owner is no longer running');
    writeNativeQaJson(archive,connection);}
  return{launch,...connection,ownerPids};
}
function ancestors(file){
  const result=[];let current=path.dirname(absolute(file));
  while(true){const info=lstatSync(current,{bigint:true});if(!info.isDirectory()||info.isSymbolicLink())throw failure('NATIVE_QA_UNSAFE_FILE',current);result.push([current,stamp(info,identityKeys)]);const parent=path.dirname(current);if(parent===current)break;current=parent;}
  return result;
}
function stableAncestors(before){for(const[file,identity]of before){const info=lstatSync(file,{bigint:true});if(!info.isDirectory()||!same(identity,stamp(info,identityKeys)))throw failure('NATIVE_QA_UNSTABLE',file);}}
function regular(info,file,maxBytes){
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1n||process.getuid&&info.uid!==BigInt(process.getuid())||(info.mode&0o022n)!==0n)throw failure('NATIVE_QA_UNSAFE_FILE',file);
  if(info.size<0n||info.size>BigInt(maxBytes))throw failure('NATIVE_QA_LIMIT',file);
}

/** O_NOFOLLOW plus lstat/fstat/length/post-fstat/path/ancestor proofs. Never
 * returns file bytes. Reading a live DB here is safe only in another process.
 * @param {string} file
 * @param {FileOptions} options */
export function nativeQaFileFingerprint(file,{ownerPids,maxBytes=MAX_FILE_BYTES,dummyKeyMarker=false}={}){
  if(pidList(ownerPids).includes(process.pid))throw failure('NATIVE_QA_SAME_PROCESS','closing a read descriptor could release this process SQLite locks');
  if(!constants.O_NOFOLLOW)throw failure('NATIVE_QA_UNSUPPORTED','O_NOFOLLOW is required');
  absolute(file);const parents=ancestors(file);let fd;
  try{
    const before=lstatSync(file,{bigint:true});regular(before,file,maxBytes);
    fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|(constants.O_NONBLOCK||0));
    const opened=fstatSync(fd,{bigint:true});regular(opened,file,maxBytes);
    if(!same(stamp(before),stamp(opened)))throw failure('NATIVE_QA_UNSTABLE',file);
    const hash=createHash('sha256'),buffer=Buffer.alloc(64*1024),marker=Buffer.from('mioon-qa-dummy-agent-key-');let bytes=0,tail=Buffer.alloc(0),plaintextDummyKeyPresent=false;
    while(true){const count=readSync(fd,buffer,0,buffer.length,bytes);if(!count)break;bytes+=count;if(bytes>maxBytes||BigInt(bytes)>before.size)throw failure('NATIVE_QA_UNSTABLE',file);const chunk=buffer.subarray(0,count);hash.update(chunk);
      if(dummyKeyMarker){const checked=Buffer.concat([tail,chunk]);plaintextDummyKeyPresent||=checked.includes(marker);tail=Buffer.from(checked.subarray(Math.max(0,checked.length-marker.length+1)));}}
    // Do not rely only on timestamps: a same-size write can share their clock
    // tick. Two complete reads must agree before accepting this physical sample.
    const sha256=hash.digest('hex'),again=createHash('sha256');let repeated=0;
    while(true){const count=readSync(fd,buffer,0,buffer.length,repeated);if(!count)break;repeated+=count;if(repeated>maxBytes||BigInt(repeated)>before.size)throw failure('NATIVE_QA_UNSTABLE',file);again.update(buffer.subarray(0,count));}
    if(repeated!==bytes||again.digest('hex')!==sha256)throw failure('NATIVE_QA_UNSTABLE',file);
    if(BigInt(bytes)!==before.size||!same(stamp(before),stamp(fstatSync(fd,{bigint:true})))||!same(stamp(before),stamp(lstatSync(file,{bigint:true}))))throw failure('NATIVE_QA_UNSTABLE',file);
    stableAncestors(parents);
    return{file,identity:stamp(before),bytes,sha256,...(dummyKeyMarker?{plaintextDummyKeyPresent}:{})};
  }catch(error){if(error.code==='ENOENT'||error.code==='ELOOP')throw failure('NATIVE_QA_UNSTABLE',file);throw error;}finally{if(fd!==undefined)closeSync(fd);}
}

/** @param {NativeQaLayout} layout
 * @returns {NativeQaLayout} */
function validateLayout(layout){
  if(layout?.formatVersion!==1||!Array.isArray(layout.projects)||!Array.isArray(layout.databases)||!layout.projects.length)throw failure('NATIVE_QA_LAYOUT_INVALID','a cold prepared layout is required');
  absolute(layout.dataDir);const expected=[{kind:'application',file:path.join(layout.dataDir,'app-library.db')}];
  const ids=new Set();
  for(const project of layout.projects){if(typeof project.projectId!=='string'||!/^[-0-9a-f]{36}$/u.test(project.projectId)||ids.has(project.projectId))throw failure('NATIVE_QA_LAYOUT_INVALID','duplicate or invalid project ID');ids.add(project.projectId);
    for(const[kind,key]of[['project','projectFile'],['history','historyFile'],['cache','cacheFile']]){const file=absolute(project[key]);if(kind==='project'?!file.endsWith('.mioon'):path.basename(file)!==`${kind}.db`)throw failure('NATIVE_QA_LAYOUT_INVALID',file);expected.push({kind,projectId:project.projectId,file});}}
  if(!same(layout.databases,expected)||new Set(expected.map(entry=>entry.file)).size!==expected.length)throw failure('NATIVE_QA_LAYOUT_INVALID','database paths do not match the cold project list');
  return layout;
}

/** Call after fixture preparation and before spawning Desktop. All paths come
 * from the real registry and real attached kernels, including external files.
 * @param {string} dataDir
 * @returns {Promise<NativeQaLayout>} */
export async function prepareNativeQaAuditLayout(dataDir){
  absolute(dataDir);
  const {openAppLibrary}=await import('../../packages/business/src/app-db/index.ts');
  const {openServerProject}=await import('./project-database.ts');
  const {readProjectCover}=await import('../../packages/business/src/project-home.ts');
  const library=openAppLibrary({dataDir});let registrations;
  try{registrations=library.registry.list().sort((a,b)=>a.projectId.localeCompare(b.projectId));}finally{library.close();}
  const projects=[];
  for(const registration of registrations){const store=openServerProject(dataDir,registration.projectId);try{
    const files=Object.fromEntries(store.db.prepare('PRAGMA database_list').all().map(row=>[row.name,row.file]));
    if(files.project!==registration.projectFile)throw failure('NATIVE_QA_LAYOUT_INVALID','registry and actual project file differ');
    projects.push({projectId:registration.projectId,projectFile:files.project,historyFile:files.main,cacheFile:files.cache,coverExpected:readProjectCover(store,registration.projectId)!==null});
  }finally{store.close();}}
  return validateLayout({formatVersion:1,dataDir,projects,databases:[{kind:'application',file:path.join(dataDir,'app-library.db')},...projects.flatMap(project=>[
    {kind:'project',projectId:project.projectId,file:project.projectFile},{kind:'history',projectId:project.projectId,file:project.historyFile},{kind:'cache',projectId:project.projectId,file:project.cacheFile},
  ])]});
}
function fileSet(layout){
  const directories=[...new Set(layout.databases.map(entry=>path.dirname(entry.file)))].sort(),files=new Set(layout.databases.map(entry=>entry.file)),states=[];
  for(const directory of directories){const info=lstatSync(directory,{bigint:true});if(!info.isDirectory()||info.isSymbolicLink())throw failure('NATIVE_QA_UNSAFE_FILE',directory);
    const entries=readdirSync(directory).sort();if(entries.length>MAX_FILES)throw failure('NATIVE_QA_LIMIT',directory);
    for(const name of entries){const target=path.join(directory,name),owned=layout.databases.filter(db=>path.dirname(db.file)===directory);
      if(owned.some(db=>['-journal','-wal','-shm'].includes(name.slice(path.basename(db.file).length))&&name.startsWith(path.basename(db.file))||name.startsWith(`${path.basename(db.file)}-mj`)))files.add(target);
      else if(/\.(?:mioon|sqlite|db)$/u.test(name)&&!files.has(target))throw failure('NATIVE_QA_LAYOUT_CHANGED',target);}
    states.push({directory,identity:stamp(info),entries});}
  if(files.size>MAX_FILES)throw failure('NATIVE_QA_LIMIT','too many SQLite files');
  return{files:[...files].sort(),directories:states};
}
/** @param {NativeQaLayout} layout
 * @param {OwnerOptions} options */
export function snapshotNativeQaFiles(layout,{ownerPids}={}){
  validateLayout(layout);pidList(ownerPids);if(ownerPids.includes(process.pid))throw failure('NATIVE_QA_SAME_PROCESS','live fingerprints require a separate report process');
  try{
  const before=fileSet(layout),files=[];let bytes=0;
  for(const file of before.files){const item=nativeQaFileFingerprint(file,{ownerPids});bytes+=item.bytes;if(bytes>MAX_TOTAL_BYTES)throw failure('NATIVE_QA_LIMIT','SQLite snapshot byte budget');files.push(item);}
  const after=fileSet(layout);
  if(!same(before,after))throw failure('NATIVE_QA_UNSTABLE','SQLite files or parent directory changed during the snapshot');
  // Recheck all paths after reading the final file, not just after its own read.
  for(const item of files)if(!same(item.identity,stamp(lstatSync(item.file,{bigint:true}))))throw failure('NATIVE_QA_UNSTABLE',item.file);
  const databases=layout.databases.map(db=>({...db,physicalChangeFingerprint:fingerprint(files.filter(item=>item.file===db.file||item.file.startsWith(`${db.file}-`)))}));
  return{contract:'native-qa-physical-v1',files,directories:before.directories,databases,sha256:fingerprint({files,directories:before.directories})};
  }catch(error){if(error.code==='ENOENT'||error.code==='ELOOP')throw failure('NATIVE_QA_UNSTABLE','a SQLite path disappeared or changed');throw error;}
}

/** No owner may be alive, and normal openers retain their ordinary LOCKED
 * refusal. data_version values from different cold connections are not compared.
 * @param {NativeQaLayout} layout
 * @param {OwnerOptions} options
 * @returns {Promise<NativeQaColdSnapshot>} */
export async function auditColdNativeQa(layout,{ownerPids}={}){
  validateLayout(layout);stopped(ownerPids);
  const {openAppLibrary}=await import('../../packages/business/src/app-db/index.ts');
  const {openServerProject}=await import('./project-database.ts');
  const {auditQaDatabases,hashQaSnapshot}=await import('./kernel-qa-fixture.mjs');
  const library=openAppLibrary({dataDir:layout.dataDir});let application;
  try{const current=library.registry.list().map(entry=>({projectId:entry.projectId,projectFile:entry.projectFile})).sort((a,b)=>a.projectId.localeCompare(b.projectId));
    if(!same(current,layout.projects.map(({projectId,projectFile})=>({projectId,projectFile}))))throw failure('NATIVE_QA_LAYOUT_CHANGED','the real registry no longer matches the prelaunch manifest');
    application=auditQaDatabases(library.db);
  }finally{library.close();}
  const projects={};for(const project of layout.projects){stopped(ownerPids);const store=openServerProject(layout.dataDir,project.projectId);try{projects[project.projectId]=auditQaDatabases(store.db);}finally{store.close();}}
  stopped(ownerPids);
  const preferences=application.databases.main.rows.workspace_preferences.map(row=>({...row,state:JSON.parse(row.state)}));
  return{contract:'native-qa-cold-sql-v1',projects,application,preferences,domainHash:hashQaSnapshot(projects),changeMarksContract:'per-connection evidence only; not comparable data_version across cold openings'};
}

export function nativeQaDomain(cold){
  const logical=snapshot=>({databases:snapshot.databases});
  const main=cold.application.databases.main,mutable=new Set(['ui-preferences-v1.json','last-project-v1.json','workspace-settings-v1.json']);
  const application={databases:{...cold.application.databases,main:{...main,rows:{...main.rows,workspace_preferences:[],app_documents:main.rows.app_documents.filter(row=>!mutable.has(row.name))}}}};
  const domain={projects:Object.fromEntries(Object.entries(cold.projects).map(([id,snapshot])=>[id,logical(snapshot)])),application};
  return{domain,domainHash:fingerprint(domain)};
}

/** Actual CLI HTTP paths. Warm the manager before the byte baseline: a cold
 * host open legitimately updates B1 lastOpenedAt/summary. No table is excluded. */
export async function verifyNativeQaCliInspections(layout,{connectionFile,ownerPids,cliFile=path.resolve('apps/cli/src/index.ts')}={}){
  validateLayout(layout);const projectId=layout.projects[0].projectId,execute=promisify(execFile),env={PATH:process.env.PATH||'',HOME:path.dirname(connectionFile),MIOON_CONNECTION_FILE:connectionFile};
  const invoke=async operation=>{const input={projectId,...(['asset.inspect','shot.inspect'].includes(operation)?{limit:2}:{})};
    const{stdout}=await execute(process.execPath,[cliFile,...operation.split('.'),'--input',JSON.stringify(input)],{env,encoding:'utf8',timeout:10000,maxBuffer:256*1024});
    const result=JSON.parse(stdout);assert.equal(result.ok,true,operation);return{operation,input,result};};
  const warmed=await invoke('project.inspect');
  let coverReady=null;
  if(layout.projects[0].coverExpected){
    const {resolveConnection}=await import('../../packages/client/src/connection.ts');
    const connection=await resolveConnection(env),deadline=Date.now()+22000;
    while(true){const response=await fetch(`${connection.base}/api/project-covers/${projectId}`,{headers:{authorization:`Bearer ${connection.token}`},signal:AbortSignal.timeout(5000)});
      const bytes=Buffer.from(await response.arrayBuffer());
      if(response.status===200){if(response.headers.get('content-type')!=='image/jpeg'||!bytes.length||bytes.length>1024*1024)throw failure('NATIVE_QA_COVER_NOT_READY','invalid cover response');coverReady={status:200,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};break;}
      if(response.status!==404||Date.now()>=deadline)throw failure('NATIVE_QA_COVER_NOT_READY','the normal cache-only cover did not become ready before the byte baseline');
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  }
  const before=snapshotNativeQaFiles(layout,{ownerPids}),results=[];
  for(const operation of['project.inspect','asset.inspect','shot.inspect','timeline.inspect'])results.push(await invoke(operation));
  const after=snapshotNativeQaFiles(layout,{ownerPids});
  assert.deepEqual(after,before,'Inspection changed SQLite bytes, identities or the complete sidecar file set');
  assert.equal(after.sha256,before.sha256,'A physical database change occurred during inspection');
  return{contract:'native-qa-cli-physical-v1',warmed,coverReady,results,allTablesUnchanged:true,physicalBefore:before,physicalAfter:after,
    changeProof:'All database/sidecar bytes and file identities are identical; per-database physicalChangeFingerprint replaces cross-connection data_version.'};
}
