import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,mkdirSync,copyFileSync,renameSync,readFileSync,linkSync,lstatSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {startServer,type InspectProject} from './helpers/test-server.ts';
import {projectLocation,serverAppDirectories} from '../apps/server/src/project-host/directories.ts';
import {createServerProject} from './helpers/project-database.ts';
import {createProjectEntryControlClient,createProjectEntryControlBroker,safeProjectEntryControlError} from '../apps/desktop/src/project-entry-control.ts';
import {PROJECT_ENTRY_CONTROL_LIMITS} from '../packages/contracts/src/project-entry-control.ts';
import type {ProjectEntryControlPort} from '../packages/contracts/src/project-entry-native.ts';
import {CACHE_SCHEMA_VERSION,createProjectFile,FORMAT4_HISTORY_SCHEMA_VERSION,FORMAT4_PROJECT_SCHEMA_VERSION,HISTORY_SCHEMA_VERSION,isProjectFileHeld,openProjectStore,openStore,PROJECT_FILE_SCHEMA_VERSION} from '../packages/business/src/project-file/index.ts';
import {openAppLibrary,isAppLibraryHeld} from '../packages/business/src/app-db/index.ts';
import type {NativeAssetMediaPort} from '../packages/contracts/src/asset-media-native.ts';
import {createProjectEntries} from '../apps/server/src/project-entries.ts';
import type {ProjectHostManager} from '../apps/server/src/project-host/manager.ts';
import type {ProjectRegistryPort} from '../apps/server/src/project-host/ports.ts';

async function fixture(t:test.TestContext,wrap?:(control:ProjectEntryControlPort)=>ProjectEntryControlPort,onReply?:(message:unknown,deliver:()=>void)=>void){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-entry-control-')),dataDir=path.join(root,'app'),parent=path.join(root,'selected');mkdirSync(parent);
 const created=createServerProject(dataDir,{name:'Original'}),projectId=created.projectId,file=created.store.projectFile;created.store.close();
 let inspect!:InspectProject;
 const server=await startServer({dataDir,port:0,token:'synthetic-project-entry-control-token',localDraftChannel:'production',inspectProject:read=>{inspect=read;}}),backendId=randomUUID(),sent:unknown[]=[];
 let client!:ReturnType<typeof createProjectEntryControlClient>;
 const broker=createProjectEntryControlBroker({backendId,control:wrap?.(server.projectEntries)??server.projectEntries,send:message=>{const deliver=()=>queueMicrotask(()=>client.handle(message));if(onReply)onReply(message,deliver);else deliver();}});
 client=createProjectEntryControlClient({backendId,send:message=>{sent.push(message);queueMicrotask(()=>broker.handle(message));}});
 t.after(async()=>{client.close();broker.close();await server.close();rmSync(root,{recursive:true,force:true});});
 return {server,client,broker,backendId,sent,root,dataDir,parent,projectId,file,inspect};
}

test('default desktop open keeps the released project format and rejects a real candidate pair',async t=>{
 const f=await fixture(t),windowId=randomUUID();
 const opened=await f.client.api.openPath({projectFile:f.file,windowId});
 assert.equal(opened.project.projectId,f.projectId);
 f.inspect(f.projectId,db=>{
  assert.equal(db.prepare('PRAGMA project.user_version').get()?.user_version,PROJECT_FILE_SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT version FROM main.schema_version').get()?.version,HISTORY_SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT version FROM cache.schema_version').get()?.version,CACHE_SCHEMA_VERSION);
 });
 f.client.api.release({windowId});

 const projectFile=path.join(f.parent,'candidate.mioon');
 createProjectFile(projectFile,{format4:{}});
 const candidate=openProjectStore({projectFile,locate:projectId=>projectLocation(serverAppDirectories(f.dataDir),projectId),format4:{}});
 try{
  assert.equal(candidate.db.prepare('PRAGMA project.user_version').get()?.user_version,FORMAT4_PROJECT_SCHEMA_VERSION);
  assert.equal(candidate.db.prepare('SELECT version FROM main.schema_version').get()?.version,FORMAT4_HISTORY_SCHEMA_VERSION);
 }finally{candidate.close();}
 await assert.rejects(f.client.api.openPath({projectFile,windowId:randomUUID()}),{
  code:'PROJECT_FORMAT_NEWER',details:{database:'project',reason:'format-newer',formatVersion:FORMAT4_PROJECT_SCHEMA_VERSION,supportedFormatVersion:PROJECT_FILE_SCHEMA_VERSION},
 });
});

test('real utility control roundtrip opens the selected original, creates once and isolates replies by generation',async t=>{
 const f=await fixture(t),capability=await f.client.api.capabilities();assert.equal(capability.open,true);assert.equal(capability.adoptCopy,true);
 assert.equal((await f.client.api.listRecent()).registered[0]!.project.projectId,f.projectId);
 const windowId=randomUUID(),opened=await f.client.api.openPath({projectFile:f.file,windowId});
 assert.equal(opened.windowId,windowId);assert.equal(opened.project.projectFile,f.file);
 const selected=await f.client.api.create({name:'Selected',parentDir:f.parent});assert.ok(selected.projectFile.startsWith(f.parent+path.sep));
 const request=f.sent.find(message=>message!==null&&typeof message==='object'&&'command'in message&&(message.command as {operation:string}).operation==='create')!;
 const before=(await f.client.api.listRecent()).registered.length;f.broker.handle(request);
 await new Promise<void>(resolve=>setImmediate(resolve));assert.equal((await f.client.api.listRecent()).registered.length,before,'same control request ID is not another create');
 assert.equal(f.client.handle({type:'project-entry-control-response',version:1,backendId:randomUUID(),requestId:randomUUID(),ok:true,data:opened}),true);
 f.client.api.release({windowId});
 const adoptedCopy=path.join(f.root,'Finder Copy.mioon');copyFileSync(f.file,adoptedCopy);
 const observed=await f.client.api.inspectSelectedCopy({projectFile:adoptedCopy});assert.equal(observed.sourceProjectId,f.projectId);
 assert.match(observed.sourceStamp.contentToken,/^[a-f0-9]{32}$/u);assert.equal(observed.sourceFile,adoptedCopy);
 const source=await f.client.api.observeSource({projectFile:adoptedCopy});assert.equal(source.name,'Original');assert.equal(source.source.sourceFile,adoptedCopy);
});

test('cancelling an unacknowledged ready write never releases its displayed window lease', async t => {
 const acknowledgement = Promise.withResolvers<() => void>(), released: string[] = [];
 const f = await fixture(t, control => ({...control, release(input) {
  released.push(input.windowId); control.release(input);
 }}), (message, deliver) => {
  if (message !== null && typeof message === 'object' && 'ok' in message && message.ok === true
      && 'data' in message && message.data === true) acknowledgement.resolve(deliver);
  else deliver();
 });
 const windowId = randomUUID(), input = {projectId: f.projectId, windowId, deferRecent: true as const};
 const opened = await f.client.api.acquire(input);
 const abort = new AbortController();
 const pending = f.client.request({operation: 'markOpened', input: {windowId, contextId: randomUUID()}}, {signal: abort.signal});
 const deliver = await acknowledgement.promise;
 abort.abort();
 await assert.rejects(pending, {code: 'PROJECT_ENTRY_OUTCOME_UNKNOWN'});
 deliver();
 assert.deepEqual(await f.client.api.acquire(input), opened);
 assert.equal(isProjectFileHeld(opened.project.fileIdentity), true);
 assert.deepEqual(released, []);
 f.client.api.release({windowId});
 await new Promise<void>(resolve => setImmediate(resolve));
 assert.deepEqual(released, [windowId]);
 assert.equal(isProjectFileHeld(opened.project.fileIdentity), false);
});

for(const kind of ['project','history','cache','application'] as const)test(`source observation refuses an alias of a held ${kind} before any descriptor can release its real write lock`,async t=>{
 const f=await fixture(t),store=openStore(path.join(f.root,'foreign-project')),library=openAppLibrary({dataDir:path.join(f.root,'foreign-app')});
 try{store.put('projects',{id:store.projectId,name:'Held source'});
 const file={project:store.projectFile,history:path.join(store.localDir,'history.db'),cache:path.join(store.cacheDir,'cache.db'),application:library.databaseFile}[kind],alias=path.join(f.parent,`${kind}.mioon`);
 linkSync(file,alias);const info=lstatSync(alias,{bigint:true}),identity={dev:String(info.dev),ino:String(info.ino)};
 assert.equal(kind==='application'?isAppLibraryHeld(identity):isProjectFileHeld(identity),true);
 const probe=()=>{const result=spawnSync(process.execPath,['--input-type=module','-e',`import{DatabaseSync}from'node:sqlite';let db;try{db=new DatabaseSync(process.argv[1],{timeout:0});db.exec('BEGIN IMMEDIATE;ROLLBACK');process.stdout.write(JSON.stringify({ok:true}));}catch(error){process.stdout.write(JSON.stringify({ok:false,errcode:error.errcode}));}finally{db?.close();}`,file],{encoding:'utf8',timeout:60_000});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
 assert.deepEqual(probe(),{ok:false,errcode:5});
 await assert.rejects(f.client.api.observeSource({projectFile:alias}),{code:'PROJECT_LOCKED'});
 assert.deepEqual(probe(),{ok:false,errcode:5},'refusing the source must preserve the existing owner lock');
 }finally{store.close();library.close();}
});

test('format projection keeps only verified complete database/version facts and MOVED evidence stays unchanged',()=>{
 const detail={database:'history',formatVersion:123,supportedFormatVersion:122};
 assert.deepEqual(safeProjectEntryControlError({code:'PROJECT_UNAVAILABLE',status:409,details:{reason:'PROJECT_FORMAT_NEWER'},cause:{code:'PROJECT_FORMAT_NEWER',details:detail}}).details,{reason:'PROJECT_FORMAT_NEWER',...detail});
 for(const details of [{formatVersion:123},{database:'project',formatVersion:123},{database:'unknown',formatVersion:123,supportedFormatVersion:122}]){
  const result=safeProjectEntryControlError({code:'PROJECT_FORMAT_NEWER',status:409,details});assert.equal('formatVersion'in result.details,false);assert.equal('supportedFormatVersion'in result.details,false);
 }
 const projectId=randomUUID();assert.deepEqual(safeProjectEntryControlError({code:'PROJECT_FILE_MOVED',status:409,details:{projectId}}),{code:'PROJECT_FILE_MOVED',status:409,details:{projectId}});
});

test('native source observation guards private application files and relink preserves only strict cause codes',async t=>{
 const f=await fixture(t,control=>({...control,nativeRelink:{async candidate(){throw Object.assign(new Error('private source path must never escape'),{code:'REVISION_CONFLICT',status:409});},async preview(){assert.fail();},async apply(){assert.fail();},async discard(){}}}));
 await assert.rejects(f.client.api.observeSource({projectFile:path.join(f.root,'app','app-library.db')}),{code:'PROJECT_LOCATION_INVALID'});
 await assert.rejects(f.client.api.nativeRelink.candidate({projectId:f.projectId,ownerToken:randomUUID(),assetId:randomUUID(),expectedReferenceRevision:1,sourcePath:f.file}),error=>{assert.equal((error as {code:string}).code,'REVISION_CONFLICT');assert.equal(String(error).includes('private source path'),false);return true;});
});

for(const operation of ['candidate','preview','apply'] as const)test(`native ${operation} enforces application scope at its real continuation and apply uncertainty retains its original request`,async()=>{
 let scope='a'.repeat(64),begun!:()=>void,finish!:()=>void,effects=0,forwarded:AbortSignal|undefined;
 const entered=new Promise<void>(resolve=>{begun=resolve;}),gate=new Promise<void>(resolve=>{finish=resolve;});
 const projectId=randomUUID(),ownerToken=randomUUID(),assetId=randomUUID(),token=randomUUID(),requestId='original-native-apply-request';
 const native:NativeAssetMediaPort={
  async candidate(input,options){forwarded=options?.signal;begun();await gate;options?.beforeEffect?.();effects++;return{projectId,assetId,expectedReferenceRevision:1,candidateToken:token,displayPath:input.sourcePath,outside:false,confirmationRequired:false};},
  async preview(_input,options){forwarded=options?.signal;begun();await gate;options?.beforeEffect?.();effects++;return{projectId,assetId,expectedReferenceRevision:1,previewToken:token,displayPath:'/verified/source.png',outside:false,rows:[{assetId,name:'Source',from:'source.png',to:'/verified/source.png',outcome:'picked',referenceRevision:1}],foundBy:null};},
  async apply(_input,options){forwarded=options?.signal;options?.beforeEffect?.();effects++;begun();await gate;return{status:'failed',error:{code:'REVISION_CONFLICT',status:409},confirmedDirectories:[]};},
  async discard(){},
 };
 const stop=new AbortController(),request=new AbortController();let callerChecks=0;
 const failAccess={get(){assert.fail('Private native forwarding cannot fall back to opening a project');}};
 const entry=createProjectEntries({manager:new Proxy({} as ProjectHostManager,failAccess),registry:new Proxy({} as ProjectRegistryPort,failAccess),projectsDir:'/unread-projects',channel:'development',signal:stop.signal,readScope:()=>scope,createProject:async()=>{assert.fail();},refreshSummaries(){assert.fail();},nativeRelink:native});
 const port=entry.control.nativeRelink!;
 const pending=operation==='candidate'?port.candidate({projectId,ownerToken,assetId,expectedReferenceRevision:1,sourcePath:'/verified/source.png'},{signal:request.signal,beforeEffect:()=>{callerChecks++;}}):operation==='preview'?port.preview({projectId,ownerToken,candidateToken:token,allowOutside:false},{signal:request.signal,beforeEffect:()=>{callerChecks++;}}):port.apply({projectId,ownerToken,previewToken:token,requestId},{signal:request.signal,beforeEffect:()=>{callerChecks++;}});
 await entered;assert.equal(forwarded,request.signal);assert.ok(callerChecks>0);scope='b'.repeat(64);finish();
 await assert.rejects(pending,error=>{const failure=error as {code:string;details?:{requestId?:string}};assert.equal(failure.code,operation==='apply'?'PROJECT_ENTRY_OUTCOME_UNKNOWN':'PROJECT_ENTRY_SCOPE_MISMATCH');if(operation==='apply'){assert.equal(failure.details?.requestId,requestId);assert.equal(safeProjectEntryControlError(error).details.requestId,requestId);}return true;});
 assert.equal(effects,operation==='apply'?1:0);
 await assert.rejects(port.candidate({projectId,ownerToken,assetId,expectedReferenceRevision:1,sourcePath:'/verified/source.png'}),{code:'PROJECT_ENTRY_SCOPE_MISMATCH'});
 stop.abort();
});

test('relink cancellation aborts the exact service call and a late candidate is discarded instead of granting a usable ticket',async t=>{
 let begun!:()=>void,finish!:()=>void,signal:AbortSignal|undefined;const entered=new Promise<void>(resolve=>{begun=resolve;}),gate=new Promise<void>(resolve=>{finish=resolve;});
 const ownerToken=randomUUID(),assetId=randomUUID(),candidateToken=randomUUID(),discarded:unknown[]=[];
 const f=await fixture(t,control=>({...control,nativeRelink:{async candidate(input,options){signal=options?.signal;begun();await gate;return{projectId:input.projectId,assetId,expectedReferenceRevision:1,candidateToken,displayPath:input.sourcePath,outside:false,confirmationRequired:false};},async preview(){assert.fail();},async apply(){assert.fail();},async discard(input){discarded.push(input);}}}));
 const cancel=new AbortController(),pending=f.client.api.nativeRelink.candidate({projectId:f.projectId,ownerToken,assetId,expectedReferenceRevision:1,sourcePath:f.file},{signal:cancel.signal});
 await entered;cancel.abort();await assert.rejects(pending,{code:'PROJECT_ENTRY_UNAVAILABLE'});for(let i=0;i<5;i++)await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(signal?.aborted,true);
 finish();for(let i=0;i<10;i++)await new Promise<void>(resolve=>setImmediate(resolve));assert.deepEqual(discarded,[{projectId:f.projectId,ownerToken,candidateToken}]);
});

test('completed relink candidate cancellation cleans only its own ticket and a cancelled apply is never executed again',async t=>{
 let queued!:()=>void,ackQueued=new Promise<void>(resolve=>{queued=resolve;});let applying=false,applies=0;const discarded:unknown[]=[];
 const ownerToken=randomUUID(),assetId=randomUUID(),candidateToken=randomUUID();
 const port:NativeAssetMediaPort={async candidate(input){return{projectId:input.projectId,assetId,expectedReferenceRevision:1,candidateToken,displayPath:input.sourcePath,outside:false,confirmationRequired:false};},async preview(){assert.fail();},async apply(){applies++;return{status:'failed',error:{code:'REVISION_CONFLICT',status:409},confirmedDirectories:[]};},async discard(input){discarded.push(input);}};
 const f=await fixture(t,control=>({...control,nativeRelink:port}),(message,deliver)=>{const value=message as {ok?:boolean;data?:{candidateToken?:string;status?:string}};if(value.ok&&(value.data?.candidateToken===candidateToken||applying&&value.data?.status==='failed'))queued();else deliver();});
 const cancel=new AbortController(),candidate=f.client.api.nativeRelink.candidate({projectId:f.projectId,ownerToken,assetId,expectedReferenceRevision:1,sourcePath:f.file},{signal:cancel.signal});
 await ackQueued;cancel.abort();await assert.rejects(candidate,{code:'PROJECT_ENTRY_UNAVAILABLE'});for(let i=0;i<10;i++)await new Promise<void>(resolve=>setImmediate(resolve));assert.deepEqual(discarded,[{projectId:f.projectId,ownerToken,candidateToken}]);
 ackQueued=new Promise<void>(resolve=>{queued=resolve;});applying=true;const stop=new AbortController(),apply=f.client.api.nativeRelink.apply({projectId:f.projectId,ownerToken,previewToken:randomUUID(),requestId:randomUUID()},{signal:stop.signal});
 await ackQueued;stop.abort();await assert.rejects(apply,{code:'PROJECT_ENTRY_OUTCOME_UNKNOWN'});for(let i=0;i<5;i++)await new Promise<void>(resolve=>setImmediate(resolve));
 const request=f.sent.find(message=>message!==null&&typeof message==='object'&&'command'in message&&(message.command as {operation:string}).operation==='mediaRelinkApply');assert.ok(request);f.broker.handle(request);for(let i=0;i<5;i++)await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(applies,1);
});

test('control timeout cancels its own pending lease and drops late ACK without reopening or retrying',async t=>{
 let start!:()=>void,finish!:()=>void;
 const begun=new Promise<void>(resolve=>{start=resolve;}),gate=new Promise<void>(resolve=>{finish=resolve;});
 const released:string[]=[];
 const f=await fixture(t,control=>({...control,async openPath(input){const opened=control.openPath(input);void opened.catch(()=>{});start();await gate;return opened;},release(input){released.push(input.windowId);control.release(input);}}));
 const windowId=randomUUID(),pending=f.client.request({operation:'openPath',input:{projectFile:f.file,windowId}},{timeoutMs:20});
 await begun;await assert.rejects(pending,{code:'PROJECT_ENTRY_UNAVAILABLE'});finish();
 for(let i=0;i<30;i++)await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(released.filter(id=>id===windowId).length,1);
 assert.equal(f.sent.filter(message=>message!==null&&typeof message==='object'&&'command'in message&&(message.command as {operation:string}).operation==='openPath').length,1);
 const newWindow=randomUUID();assert.equal((await f.client.api.acquire({projectId:f.projectId,windowId:newWindow})).windowId,newWindow);f.client.api.release({windowId:newWindow});
});

test('unknown create ACK is never retried, while malformed/cross-window results and excessive pending are rejected',async t=>{
 let resolveCreate!:()=>void;
 const gate=new Promise<void>(resolve=>{resolveCreate=resolve;});let creates=0;
 const f=await fixture(t,control=>({...control,async create(input){creates++;await gate;return control.create(input);}}));
 const pending=f.client.request({operation:'create',input:{name:'Unknown',parentDir:f.parent}},{timeoutMs:20});
 await assert.rejects(pending,error=>{assert.equal((error as {code:string}).code,'PROJECT_ENTRY_OUTCOME_UNKNOWN');return true;});resolveCreate();
 for(let i=0;i<30;i++)await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(creates,1);
 const hung=createProjectEntryControlClient({backendId:randomUUID(),send:()=>{}});t.after(()=>hung.close());
 const requests=Array.from({length:PROJECT_ENTRY_CONTROL_LIMITS.pending},()=>hung.request({operation:'listRecent',input:{}}).catch(()=>null));
 await assert.rejects(hung.request({operation:'listRecent',input:{}}),{code:'PROJECT_ENTRY_BUSY'});hung.close();await Promise.all(requests);
});

test('the trusted proxy rejects a structurally valid reply for another window and keeps permission codes safe',async t=>{
 const f=await fixture(t,control=>({...control,async openPath(){throw Object.assign(new Error('/private/raw/path must not cross'),{code:'EACCES'});}}));
 await assert.rejects(f.client.api.openPath({projectFile:f.file,windowId:randomUUID()}),error=>{
  assert.equal((error as {code:string}).code,'PROJECT_ACCESS_DENIED');assert.equal(String(error).includes('/private/raw/path'),false);return true;
 });
 let sent:unknown;
 const proxy=createProjectEntryControlClient({backendId:f.backendId,send:message=>{sent=message;}});t.after(()=>proxy.close());
 const pending=proxy.api.acquire({projectId:f.projectId,windowId:randomUUID()});
 const request=sent as {requestId:string};
 const project=(await f.client.api.listRecent()).registered.find(entry=>entry.project.projectId===f.projectId)!.project;
 proxy.handle({type:'project-entry-control-response',version:1,backendId:f.backendId,requestId:request.requestId,ok:true,data:{windowId:randomUUID(),project}});
 await assert.rejects(pending,{code:'PROJECT_ENTRY_UNAVAILABLE'});
});

test('cancel after completed open but before its ACK releases the real lease and tombstones the old success',async t=>{
 const windowId=randomUUID();let acknowledge!:()=>void,queued!:()=>void,late:unknown;
 const replies:unknown[]=[],released:string[]=[];
 const ackQueued=new Promise<void>(resolve=>{queued=resolve;});
 const f=await fixture(t,control=>({...control,release(input){released.push(input.windowId);control.release(input);}}),(message,deliver)=>{
  replies.push(message);
  if(message!==null&&typeof message==='object'&&'ok'in message&&message.ok===true&&'data'in message&&message.data!==null&&typeof message.data==='object'&&'windowId'in message.data&&message.data.windowId===windowId){late=message;acknowledge=deliver;queued();}else deliver();
 });
 const cancel=new AbortController(),pending=f.client.request({operation:'openPath',input:{windowId,projectFile:f.file}},{signal:cancel.signal});
 await ackQueued;cancel.abort();await assert.rejects(pending,{code:'PROJECT_ENTRY_UNAVAILABLE'});
 for(let i=0;i<5;i++)await new Promise<void>(resolve=>setImmediate(resolve));
 const other=await f.client.api.create({name:'Other',parentDir:f.parent});
 const rebound=await f.server.projectEntries.acquire({windowId,projectId:other.projectId});assert.equal(rebound.project.projectId,other.projectId,'no unowned lease remains from the completed old open');
 f.server.projectEntries.release({windowId});acknowledge();
 f.client.api.release({windowId});for(let i=0;i<5;i++)await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(released.filter(id=>id===windowId).length,1,'cancel plus explicit close cleanup call the native release only once');
 const request=f.sent.find(message=>message!==null&&typeof message==='object'&&'command'in message&&(message.command as {operation:string}).operation==='openPath')!;
 const parsed=request as {requestId:string};
 // Replay through the same broker cannot resurrect its retired successful
 // lease. The old main promise has already settled and ignores the late ACK.
 assert.ok(late);f.broker.handle(request);for(let i=0;i<5;i++)await new Promise<void>(resolve=>setImmediate(resolve));
 const last=replies.at(-1) as {requestId:string;ok:boolean;error?:{code:string}};
 assert.equal(last.requestId,parsed.requestId);assert.equal(last.ok,false);assert.equal(last.error?.code,'PROJECT_ENTRY_UNAVAILABLE');
});

test('window cleanup bypasses 32 occupied business slots and a cancelled committed create cannot be executed again',async t=>{
 const waits:Array<()=>void>=[];let creates=0;
 const f=await fixture(t,control=>({...control,async create(input){creates++;return control.create(input);},async inspectSelectedCopy(input){await new Promise<void>(resolve=>waits.push(resolve));return control.inspectSelectedCopy!(input);}}));
 const windowId=randomUUID();await f.client.api.acquire({projectId:f.projectId,windowId});
 const observations=Array.from({length:PROJECT_ENTRY_CONTROL_LIMITS.pending},()=>f.client.api.inspectSelectedCopy({projectFile:f.file}).catch(()=>null));
 for(let i=0;i<5;i++)await new Promise<void>(resolve=>setImmediate(resolve));
 f.client.api.release({windowId});
 for(let i=0;i<5;i++)await new Promise<void>(resolve=>setImmediate(resolve));
 const another=randomUUID();
 // Reusing the released native binding with a different project below proves
 // release was delivered even though no ordinary request slot was available.
 const other=await f.server.projectEntries.create({name:'Cleanup',parentDir:f.parent});
 assert.equal((await f.server.projectEntries.acquire({windowId,projectId:other.projectId})).project.projectId,other.projectId);f.server.projectEntries.release({windowId});
 for(const resolve of waits)resolve();await Promise.all(observations);
 assert.equal((await f.client.api.acquire({projectId:f.projectId,windowId:another})).windowId,another);f.client.api.release({windowId:another});
 assert.equal(creates,0);
});

test('a committed create whose ACK was cancelled retains an unknown tombstone instead of being resubmitted',async t=>{
 let queued!:()=>void;const ackQueued=new Promise<void>(resolve=>{queued=resolve;});
 const replies:unknown[]=[];let creates=0;
 const f=await fixture(t,control=>({...control,async create(input){creates++;return control.create(input);}}),(message,deliver)=>{
  replies.push(message);
  if(message!==null&&typeof message==='object'&&'ok'in message&&message.ok===true&&'data'in message&&message.data!==null&&typeof message.data==='object'&&'name'in message.data&&message.data.name==='Committed')queued();else deliver();
 });
 const cancelled=new AbortController(),pending=f.client.request({operation:'create',input:{name:'Committed',parentDir:f.parent}},{signal:cancelled.signal});
 await ackQueued;cancelled.abort();await assert.rejects(pending,{code:'PROJECT_ENTRY_OUTCOME_UNKNOWN'});
 for(let i=0;i<5;i++)await new Promise<void>(resolve=>setImmediate(resolve));
 const request=f.sent.find(message=>message!==null&&typeof message==='object'&&'command'in message&&(message.command as {operation:string}).operation==='create')!;
 f.broker.handle(request);for(let i=0;i<5;i++)await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(creates,1);assert.equal((replies.at(-1) as {ok:boolean;error:{code:string}}).error.code,'PROJECT_ENTRY_OUTCOME_UNKNOWN');
 assert.equal((await f.client.api.listRecent()).registered.filter(entry=>entry.project.name==='Committed').length,1);
});

test('a committed copy with a mismatched receipt is unknown and replay does not perform a second copy',async t=>{
 let copies=0;
 const f=await fixture(t,control=>({...control,async duplicate(input){copies++;const result=await control.duplicate!(input);return {...result,requestId:randomUUID()};}}));
 const target=path.join(f.parent,'Copied.mioon');
 await assert.rejects(f.client.api.duplicate({projectId:f.projectId,projectFile:target,requestId:randomUUID()}),{code:'PROJECT_ENTRY_OUTCOME_UNKNOWN'});
 for(let i=0;i<5;i++)await new Promise<void>(resolve=>setImmediate(resolve));
 const request=f.sent.find(message=>message!==null&&typeof message==='object'&&'command'in message&&(message.command as {operation:string}).operation==='duplicate')!;
 f.broker.handle(request);for(let i=0;i<5;i++)await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(copies,1);assert.ok((await f.client.api.listRecent()).registered.some(entry=>entry.project.projectFile===target));
});

test('a structurally valid create reply for another selected target is unknown with the original control request identity',async t=>{
 const f=await fixture(t),project=(await f.client.api.listRecent()).registered[0]!.project;
 const sent:unknown[]=[],proxy=createProjectEntryControlClient({backendId:f.backendId,send:message=>sent.push(message)});t.after(()=>proxy.close());
 const pending=proxy.api.create({name:'Selected',projectFile:path.join(f.parent,'Selected.mioon')});
 const original=sent[0] as {requestId:string};
 proxy.handle({type:'project-entry-control-response',version:1,backendId:f.backendId,requestId:original.requestId,ok:true,data:project});
 await assert.rejects(pending,error=>{
  const failed=error as {code:string;details:{requestId:string;operation:string}};assert.equal(failed.code,'PROJECT_ENTRY_OUTCOME_UNKNOWN');assert.equal(failed.details.requestId,original.requestId);assert.equal(failed.details.operation,'create');return true;
 });
});

test('prepare-acquire resolves a moved registration through the real bridge before the path-fenced window acquisition',async t=>{
 const f=await fixture(t),moved=path.join(path.dirname(f.file),'Moved.mioon'),bytes=readFileSync(f.file);
 renameSync(f.file,moved);
 const prepared=await f.client.api.prepareAcquire({projectId:f.projectId});
 assert.equal(prepared.projectId,f.projectId);assert.equal(prepared.projectFile,moved);assert.deepEqual(readFileSync(moved),bytes);
 const windowId=randomUUID(),opened=await f.client.api.acquire({projectId:f.projectId,windowId,expectedProjectFile:prepared.projectFile});
 assert.equal(opened.project.projectFile,moved);f.client.api.release({windowId});
 const wrongResponses:unknown[]=[],proxy=createProjectEntryControlClient({backendId:f.backendId,send:message=>wrongResponses.push(message)});t.after(()=>proxy.close());
 const pending=proxy.api.prepareAcquire({projectId:f.projectId});
 const request=wrongResponses[0] as {requestId:string};
 proxy.handle({type:'project-entry-control-response',version:1,backendId:f.backendId,requestId:request.requestId,ok:true,data:{...prepared,projectId:randomUUID()}});
 await assert.rejects(pending,{code:'PROJECT_ENTRY_UNAVAILABLE'});
});
