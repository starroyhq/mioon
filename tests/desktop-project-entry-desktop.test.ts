import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,copyFileSync,readFileSync,rmSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {startServer} from './helpers/test-server.ts';
import {createServerProject} from './helpers/project-database.ts';
import {createProjectEntryControlClient,createProjectEntryControlBroker} from '../apps/desktop/src/project-entry-control.ts';
import {createProjectEntryDesktopHost} from '../apps/desktop/src/project-entry-desktop-host.ts';
import {createProjectEntriesDesktopBridge} from '../apps/desktop/src/project-entry-desktop-preload.ts';
import {PROJECT_ENTRY_DESKTOP_CHANNEL,PROJECT_ENTRY_DESKTOP_LIMITS} from '../packages/contracts/src/project-entry-desktop.ts';
import type {ProjectEntryDesktopOwner} from '../apps/desktop/src/project-entry-desktop-host.ts';
import type {ProjectLocationFacts} from '../packages/contracts/src/project-entry-desktop.ts';
import type {ProjectEntryControlPort} from '../packages/contracts/src/project-entry-native.ts';
import {projectEntryControlErrorSchema} from '../packages/contracts/src/project-entry-control.ts';
import {readProjectEntryDesktopClient} from '../apps/web/src/project-entry-desktop-client.ts';
import type {ProjectEntriesDesktopBridge} from '../packages/contracts/src/project-entry-desktop.ts';
import type {ProjectWindowOpenResult} from '../apps/desktop/src/project-window-protocol.ts';

const facts:ProjectLocationFacts={fileSystem:'apfs',isLocal:true,volumeReadOnly:false,permissionBits:true,cloud:'not-reported'};
const pendingChannel='mioon:project-entries:pending-open:v1';
const settle=async()=>{for(let index=0;index<8;index++)await new Promise<void>(resolve=>setImmediate(resolve));};
async function fixture(t:test.TestContext,wrap?:(control:ProjectEntryControlPort)=>ProjectEntryControlPort,openRecent?:(
 owner:ProjectEntryDesktopOwner,projectId:string,entryToken:string,remember:boolean)=>Promise<ProjectWindowOpenResult>){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-entry-desktop-')),dataDir=path.join(root,'app'),selected=path.join(root,'selected');mkdirSync(selected);
 const created=createServerProject(dataDir,{name:'Original'}),file=created.store.projectFile,projectId=created.projectId;created.store.close();
 const server=await startServer({dataDir,port:0,token:'synthetic-desktop-entry-token'}),backendId=randomUUID();
 let client!:ReturnType<typeof createProjectEntryControlClient>;
 const broker=createProjectEntryControlBroker({backendId,control:wrap?.(server.projectEntries)??server.projectEntries,send:message=>queueMicrotask(()=>client.handle(message))});
 client=createProjectEntryControlClient({backendId,send:message=>queueMicrotask(()=>broker.handle(message))});
 const nativeWindow={},windowId=randomUUID();let contextId=randomUUID(),active=true,ready=true,editor=false,settingsOpened=0;
 const owner=():ProjectEntryDesktopOwner=>{const captured=contextId;return{window:nativeWindow,windowId,backendId,contextId:captured,...(editor?{projectId}:{}),isCurrent:()=>active&&contextId===captured};};
 let directory:string|null=selected,openFile:string|null=file;
 const messages:string[]=[],adopted:string[]=[],readyRequired:boolean[]=[],probed:string[]=[],revealed:string[]=[],admitted:ProjectLocationFacts[]=[],locationFacts=new Map<string,ProjectLocationFacts>();
 const notices:unknown[]=[],listeners=new Set<(event:unknown,value:unknown)=>void>();
 const host=createProjectEntryDesktopHost({ownerForEvent:(event:string)=>event==='owner'?owner():null,backend:client.api,isReady:()=>ready,
  chooseDirectory:async(_owner,input)=>{messages.push(input.message);return directory;},chooseOpenFile:async()=>openFile,
  chooseSaveFile:async(_owner,input)=>{messages.push(input.message);return path.join(selected,input.suggestedName+'.mioon');},
  probeLocation:async input=>{probed.push(input.path);return locationFacts.get(input.path)??facts;},admitLocation:async(_owner,value)=>{admitted.push(value);return true;},
  adoptPrepared:async(prepared,waitForReady)=>{adopted.push(prepared.windowId);readyRequired.push(waitForReady===true);return {ok:true,targetWindowId:prepared.windowId,reason:'accepted'};},
  openRecent:openRecent??(async()=>({ok:false,targetWindowId:null,reason:'unavailable'})),
  openPrivacySettings:async()=>{settingsOpened++;},revealVerifiedPath:async(_owner,file)=>{revealed.push(file);},
  notifyPendingOpen:(_owner,notice)=>{notices.push(notice);for(const listener of listeners)listener({notForRenderer:true},notice);},
 });
 const invoke=(channel:typeof PROJECT_ENTRY_DESKTOP_CHANNEL,input:unknown)=>{assert.equal(channel,PROJECT_ENTRY_DESKTOP_CHANNEL);return host.handle('owner',input);};
 const bridge=createProjectEntriesDesktopBridge(invoke,{on:(channel,listener)=>{assert.equal(channel,pendingChannel);listeners.add(listener);},removeListener:(channel,listener)=>{assert.equal(channel,pendingChannel);listeners.delete(listener);},context:async()=>owner()});
 t.after(async()=>{host.close();client.close();broker.close();await server.close();rmSync(root,{recursive:true,force:true});});
 return {root,selected,file,projectId,host,bridge,client,messages,adopted,readyRequired,probed,owner,revealed,admitted,notices,listeners,invoke,get settingsOpened(){return settingsOpened;},asEditor(){editor=true;},setFacts(file:string,value:ProjectLocationFacts){locationFacts.set(file,value);},
  replaceDocument(){contextId=randomUUID();},disable(){ready=false;},cancel(){directory=null;openFile=null;},setOpen(file:string){openFile=file;},closeOwner(){active=false;}};
}

test('native recent ACK keeps cancellation, busy and verified failures distinct at both bridges',async t=>{
 const refused:ProjectWindowOpenResult={ok:false,reason:'unavailable',targetWindowId:null,targetPhase:null};
 let result:ProjectWindowOpenResult=refused;
 const calls:unknown[]=[];
 const f=await fixture(t,undefined,async(owner,projectId,entryToken,remember)=>{calls.push({contextId:owner.contextId,projectId,entryToken,remember});return result;});
 const renderer=readProjectEntryDesktopClient({__mioonProjectEntries:f.bridge});assert.ok(renderer);
 const input={projectId:f.projectId,entryToken:randomUUID(),remember:true};
 const failure={code:'PROJECT_FORMAT_NEWER',database:'project',formatVersion:8,supportedFormatVersion:7} as const;
 result={...refused,failure};
 assert.deepEqual(await renderer.openRecent(input),{status:'failed',reason:'unavailable',failure});
 assert.deepEqual(calls,[{contextId:f.owner().contextId,...input}]);
 result={...refused,reason:'busy'};
 assert.deepEqual(await renderer.openRecent({...input,entryToken:randomUUID()}),{status:'failed',reason:'busy'});
 result={...refused,reason:'cancelled'};
 assert.deepEqual(await renderer.openRecent({...input,entryToken:randomUUID()}),{status:'cancelled'});
 const invalid=createProjectEntriesDesktopBridge(async()=>({ok:true,data:{status:'failed',reason:'unavailable',failure:{...failure,projectFile:'/private/raw.mioon'}}}));
 await assert.rejects(invalid.openRecent(input));
 f.disable();await assert.rejects(renderer.openRecent(input),{code:'PROJECT_ENTRY_UNAVAILABLE'});
 assert.equal(calls.length,3,'the native host still authenticates and gates every request');
});

test('ordinary selected native opens defer recent bookkeeping and wait for their candidate',async t=>{
 const inputs:Parameters<ProjectEntryControlPort['openPath']>[0][]=[];
 const f=await fixture(t,port=>({...port,openPath:async input=>{inputs.push(input);return port.openPath(input);}}));
 assert.equal((await f.bridge.openSelectedFile()).status,'opened');
 assert.deepEqual(f.readyRequired,[true]);
 assert.equal(inputs.length,1);
 assert.deepEqual(inputs[0],{projectFile:f.file,windowId:f.adopted[0],deferRecent:true});
 assert.equal((await f.client.api.listRecent()).registered[0].project.lastOpenedAt,null);
});

test('native picker tickets bind the exact owner; creation is once and returns created without bypassing sealed window open',async t=>{
 const f=await fixture(t),before=(await f.client.api.listRecent()).registered.length;
 const capability=await f.bridge.capabilities();assert.equal(capability.create,true);assert.equal(capability.saveAs,false);
 const chosen=await f.bridge.chooseLocation({purpose:'create',suggestedName:'Created',message:'Caller supplied storage guidance'});assert.ok(chosen);
 assert.deepEqual(f.messages,['Caller supplied storage guidance']);assert.equal(chosen.displayPath,f.selected);
 assert.equal((await f.client.api.listRecent()).registered.length,before,'choosing a location does not create');
 const input={token:chosen.token,name:'Created',description:'Caller form',createFolder:true};
 const created=await f.bridge.createAtSelection(input);assert.equal(created.status,'created');assert.equal(created.project.name,'Created');
 assert.equal(f.adopted.length,0,'the renderer must still seal its own successful create before opening');
 assert.deepEqual(await f.bridge.createAtSelection(input),created);
 assert.equal((await f.client.api.listRecent()).registered.length,before+1,'one picker ticket cannot create twice');
 const stale=await f.bridge.chooseLocation({purpose:'create',suggestedName:'Stale',message:''});assert.ok(stale);f.replaceDocument();
 await assert.rejects(f.bridge.createAtSelection({token:stale.token,name:'Stale',createFolder:false}));
 assert.equal((await f.client.api.listRecent()).registered.length,before+1);
});

test('pending native opens notify an already initialized preload and are taken exactly once',async t=>{
 const f=await fixture(t),copy=path.join(f.root,'Late Finder Copy.mioon');copyFileSync(f.file,copy);
 assert.equal(await f.bridge.takePendingOpen(),null,'the launcher has already performed its initial empty take');
 assert.equal(typeof f.bridge.subscribePendingOpen,'function');
 const received:unknown[]=[];const unsubscribe=f.bridge.subscribePendingOpen!(()=>{received.push(f.bridge.takePendingOpen());});
 await settle();const result=await f.host.openPath(f.owner(),copy);assert.equal(result.status,'copy');f.host.rememberPendingOpen(f.owner(),result);
 await settle();assert.equal(f.notices.length,1);assert.equal(received.length,1);assert.deepEqual(await received[0],result);
 assert.equal(await f.bridge.takePendingOpen(),null);unsubscribe();unsubscribe();assert.equal(f.listeners.size,0);
});

test('pending native opens expire with their original ticket and never transfer to a replacement document',async t=>{
 const f=await fixture(t),copy=path.join(f.root,'Expired Finder Copy.mioon');copyFileSync(f.file,copy);
 const result=await f.host.openPath(f.owner(),copy);if(result.status!=='copy')assert.fail();assert.ok(result.expiresAt);
 f.host.rememberPendingOpen(f.owner(),{...result,expiresAt:result.expiresAt+PROJECT_ENTRY_DESKTOP_LIMITS.ticketMs});
 t.mock.method(Date,'now',()=>result.expiresAt!);
 assert.equal(await f.bridge.takePendingOpen(),null,'old prompts must not be delivered with expired authority');
 const notifications=f.notices.length;f.host.rememberPendingOpen(f.owner(),result);assert.equal(f.notices.length,notifications,'remembering an expired result cannot re-notify or extend the original ticket');
 t.mock.restoreAll();const previous=f.owner(),current=await f.host.openPath(previous,copy);f.host.rememberPendingOpen(previous,current);f.replaceDocument();
 assert.equal(await f.bridge.takePendingOpen(),null);assert.throws(()=>f.host.rememberPendingOpen(previous,current),{code:'PROJECT_ENTRY_UNAVAILABLE'});
});

test('missing or expired picker tickets are explicit pre-dispatch failures with no project writes',async t=>{
 const f=await fixture(t),before=readFileSync(f.file),registered=(await f.client.api.listRecent()).registered;
 await assert.rejects(f.bridge.adoptCopy({token:randomUUID()}),error=>{assert.equal(error instanceof Error,false);assert.deepEqual(error,{code:'PROJECT_ENTRY_TICKET_EXPIRED',status:409,details:{}});return true;});
 let clock=Date.now();t.mock.method(Date,'now',()=>clock);
 const chosen=await f.bridge.chooseLocation({purpose:'create',suggestedName:'Expired',message:''});assert.ok(chosen);
 const duplicate=await f.bridge.chooseLocation({purpose:'duplicate',suggestedName:'Expired copy',message:''});assert.ok(duplicate);
 clock+=PROJECT_ENTRY_DESKTOP_LIMITS.ticketMs;
 await assert.rejects(f.bridge.createAtSelection({token:chosen.token,name:'Expired',createFolder:true}),{code:'PROJECT_ENTRY_TICKET_EXPIRED',status:409});
 const page=readProjectEntryDesktopClient({__mioonProjectEntries:f.bridge});assert.ok(page);
 await assert.rejects(page.duplicate({token:duplicate.token,projectId:f.projectId,requestId:randomUUID()}),error=>{assert.ok(error instanceof Error);assert.equal(projectEntryControlErrorSchema.parse(error).code,'PROJECT_ENTRY_TICKET_EXPIRED');return true;});
 t.mock.restoreAll();assert.deepEqual(readFileSync(f.file),before);assert.deepEqual((await f.client.api.listRecent()).registered,registered);
});

test('preload rejects with exact error DTOs and the page rebuilds its own Error without replaying a request',async t=>{
 const token=randomUUID(),projectId=randomUUID(),requestId=randomUUID();
 const cases:Array<{name:string;error:{code:string;status:number;details:Record<string,unknown>};call:(bridge:ProjectEntriesDesktopBridge)=>Promise<unknown>}>=
 [
  {name:'adoptCopy expired',error:{code:'PROJECT_ENTRY_TICKET_EXPIRED',status:409,details:{}},call:bridge=>bridge.adoptCopy({token})},
  {name:'duplicate expired',error:{code:'PROJECT_ENTRY_TICKET_EXPIRED',status:409,details:{}},call:bridge=>bridge.duplicate({token,projectId,requestId})},
  {name:'template destination exists',error:{code:'PROJECT_FILE_EXISTS',status:409,details:{requestId,operation:'instantiateTemplate'}},call:bridge=>bridge.instantiateTemplate!({token,templateId:'timeline-basics',templateVersion:1,name:'Example',requestId})},
  {name:'location rejected',error:{code:'PROJECT_LOCATION_REJECTED',status:409,details:{}},call:bridge=>bridge.chooseLocation({purpose:'create',suggestedName:'Example',message:''})},
  {name:'access denied',error:{code:'PROJECT_ACCESS_DENIED',status:403,details:{projectId}},call:bridge=>bridge.openSelectedFile()},
  {name:'entry busy',error:{code:'PROJECT_ENTRY_BUSY',status:503,details:{}},call:bridge=>bridge.duplicate({token,projectId,requestId})},
  {name:'host busy',error:{code:'PROJECT_HOST_BUSY',status:409,details:{}},call:bridge=>bridge.copyTo({token,sourceToken:randomUUID(),requestId})},
  {name:'format details',error:{code:'PROJECT_FORMAT_NEWER',status:409,details:{projectId,requestId,operation:'openPath',database:'history',reason:'format',invalidReason:'unsupported',formatVersion:2,supportedFormatVersion:1}},call:bridge=>bridge.openSelectedFile()},
  {name:'explicit unknown',error:{code:'PROJECT_ENTRY_OUTCOME_UNKNOWN',status:409,details:{requestId,operation:'duplicate'}},call:bridge=>bridge.duplicate({token,projectId,requestId})},
  {name:'server failure',error:{code:'INTERNAL_ERROR',status:500,details:{}},call:bridge=>bridge.adoptCopy({token})},
 ];
 for(const item of cases)await t.test(item.name,async()=>{
  let calls=0;const expected=projectEntryControlErrorSchema.parse(item.error);
  const bridge=createProjectEntriesDesktopBridge(async()=>{calls++;return {ok:false,error:expected};});
  await assert.rejects(item.call(bridge),error=>{assert.equal(error instanceof Error,false);assert.deepEqual(error,expected);return true;});
  assert.equal(calls,1,'the preload must not retry a refused request');
  const page=readProjectEntryDesktopClient({__mioonProjectEntries:bridge});assert.ok(page);
  await assert.rejects(item.call(page),error=>{assert.ok(error instanceof Error);assert.equal(error.message,expected.code);assert.deepEqual(projectEntryControlErrorSchema.parse(error),expected);return true;});
  assert.equal(calls,2,'the page must dispatch its request exactly once');
 });
});

test('malformed or lost native entry replies cannot fabricate a coded business rejection',async()=>{
 for(const reply of [{ok:false,error:{code:'PROJECT_FILE_EXISTS',status:409}},{ok:false,error:{code:'PROJECT_FILE_EXISTS',status:409,details:{},extra:true}},{ok:false,error:{code:'PROJECT_FILE_EXISTS',status:409,details:{}},extra:true}]){
  let calls=0;const bridge=createProjectEntriesDesktopBridge(async()=>{calls++;return reply;});
  const page=readProjectEntryDesktopClient({__mioonProjectEntries:bridge});assert.ok(page);
  await assert.rejects(page.adoptCopy({token:randomUUID()}),error=>{assert.equal(projectEntryControlErrorSchema.safeParse(error).success,false);return true;});
  assert.equal(calls,1);
 }
 let calls=0;const lost=new Error('Synthetic transport loss'),bridge=createProjectEntriesDesktopBridge(async()=>{calls++;throw lost;});
 const page=readProjectEntryDesktopClient({__mioonProjectEntries:bridge});assert.ok(page);
 await assert.rejects(page.adoptCopy({token:randomUUID()}),error=>{assert.equal(error,lost);assert.equal(projectEntryControlErrorSchema.safeParse(error).success,false);return true;});assert.equal(calls,1);
});

test('preload filters pending notices by the immutable document identity and releases its precise listener',async t=>{
 const f=await fixture(t),identity=f.owner(),binding=Promise.withResolvers<typeof identity>();
 const listeners=new Set<(event:unknown,value:unknown)=>void>();let notifications=0;
 const bridge=createProjectEntriesDesktopBridge(f.invoke,{on:(_channel,listener)=>listeners.add(listener),removeListener:(_channel,listener)=>{listeners.delete(listener);},context:()=>binding.promise});
 assert.equal(typeof bridge.subscribePendingOpen,'function');const unsubscribe=bridge.subscribePendingOpen!(()=>{notifications++;});
 const send=(value:unknown)=>{for(const listener of listeners)listener({privateElectronEvent:true},value);};
 const notice={backendId:identity.backendId,windowId:identity.windowId,contextId:identity.contextId};
 send({...notice,contextId:randomUUID()});send({...notice,extra:true});send(notice);assert.equal(notifications,0);
 binding.resolve(identity);await settle();assert.equal(notifications,1,'a matching notice received while binding is not lost');
 send({...notice,backendId:randomUUID()});send({...notice,windowId:randomUUID()});await settle();assert.equal(notifications,1);
 unsubscribe();unsubscribe();assert.equal(listeners.size,0);send(notice);await settle();assert.equal(notifications,1);
 const late=Promise.withResolvers<typeof identity>();const removed=createProjectEntriesDesktopBridge(f.invoke,{on:(_channel,listener)=>listeners.add(listener),removeListener:(_channel,listener)=>{listeners.delete(listener);},context:()=>late.promise});
 const release=removed.subscribePendingOpen!(()=>{notifications++;});send(notice);release();late.resolve(identity);await settle();assert.equal(notifications,1);assert.equal(listeners.size,0);
});

test('cancelled dialogs and missing capability cause no creation, and renderer paths/stamps are never accepted',async t=>{
 const f=await fixture(t),before=(await f.client.api.listRecent()).registered;
 f.cancel();assert.equal(await f.bridge.chooseLocation({purpose:'create',suggestedName:'Cancelled',message:''}),null);
 assert.deepEqual(await f.bridge.openSelectedFile(),{status:'cancelled'});assert.deepEqual((await f.client.api.listRecent()).registered,before);
 await assert.rejects(f.host.dispatch('foreign',{action:'openSelectedFile'}));
 await assert.rejects(f.host.dispatch('owner',{action:'openSelectedFile',projectFile:f.file}));
 await assert.rejects(f.host.dispatch('owner',{action:'adoptCopy',token:randomUUID(),sourceFile:f.file,sourceStamp:{contentSequence:1,contentToken:'forged'}}));
 f.disable();assert.equal((await f.bridge.capabilities()).ready,false);await assert.rejects(f.bridge.openSelectedFile());
});

test('COPY observation stays in main and confirmation adopts only its unchanged selected copy',async t=>{
 const f=await fixture(t),copy=path.join(f.root,'Finder Copy.mioon');copyFileSync(f.file,copy);const original=readFileSync(f.file);f.setOpen(copy);
 const pending=await f.bridge.openSelectedFile();assert.equal(pending.status,'copy');
 assert.equal('sourceFile'in pending||'sourceIdentity'in pending||'sourceStamp'in pending,false,'only display facts, never a source capability, reach the page');
 if(pending.status!=='copy')assert.fail();
 assert.equal(pending.name,'Original');assert.deepEqual(pending.original,{name:'Original',displayPath:f.file});
 assert.equal(f.admitted.length,1);
 const owner=f.owner();f.host.rememberPendingOpen(owner,pending);assert.deepEqual(await f.bridge.takePendingOpen(),pending);assert.equal(await f.bridge.takePendingOpen(),null);
 const opened=await f.bridge.adoptCopy({token:pending.token});assert.equal(opened.status,'opened');
 if(opened.status==='opened')assert.notEqual(opened.projectId,f.projectId);
 assert.deepEqual(readFileSync(f.file),original);assert.equal(f.adopted.length,1);
 assert.equal(f.admitted.length,1,'opening and confirming the same copy reuses one unchanged location admission');
 assert.deepEqual(await f.bridge.adoptCopy({token:pending.token}),opened,'same confirmed token observes its original result');
 const now=Date.now();t.mock.method(Date,'now',()=>now+PROJECT_ENTRY_DESKTOP_LIMITS.ticketMs+1);
 assert.deepEqual(await f.bridge.adoptCopy({token:pending.token}),opened,'a cached exact replay is checked before the consumed or expired ticket');t.mock.restoreAll();
});

test('copy confirmation rejects changed location facts without another warning or backend mutation',async t=>{
 let mutations=0;const f=await fixture(t,control=>{const adopt=control.adoptCopy;assert.ok(adopt);return {...control,adoptCopy:async input=>{mutations++;return adopt.call(control,input);}};}),copy=path.join(f.root,'Changed Location Copy.mioon');copyFileSync(f.file,copy);
 const exfat:ProjectLocationFacts={...facts,fileSystem:'exfat',permissionBits:false};f.setFacts(copy,exfat);f.setOpen(copy);
 const registered=(await f.client.api.listRecent()).registered,before=readFileSync(copy),result=await f.bridge.openSelectedFile();if(result.status!=='copy')assert.fail();assert.equal(f.admitted.length,1);
 f.setFacts(copy,{...exfat,cloud:'known-icloud'});
 await assert.rejects(f.bridge.adoptCopy({token:result.token}),{code:'PROJECT_COPY_SOURCE_CHANGED',status:409});
 assert.equal(mutations,0);assert.equal(f.admitted.length,1);assert.deepEqual(readFileSync(copy),before);assert.deepEqual((await f.client.api.listRecent()).registered,registered);
});

test('trusted OS admission is reusable only for its same path, document, and fully re-observed location facts',async t=>{
 let opens=0;const f=await fixture(t,control=>({...control,openPath:async input=>{opens++;return control.openPath(input);}})),copy=path.join(f.root,'Scoped Admission Copy.mioon');copyFileSync(f.file,copy);
 const owner=f.owner(),admission={owner,file:copy,facts};
 await assert.rejects(f.host.openPath(owner,copy,{...admission,file:f.file}),{code:'PROJECT_COPY_SOURCE_CHANGED'});
 await assert.rejects(f.host.openPath(owner,copy,{...admission,facts:{...facts,permissionBits:false}}),{code:'PROJECT_COPY_SOURCE_CHANGED'});
 await assert.rejects(f.host.openPath(owner,copy,{...admission,owner:{...owner,contextId:randomUUID()}}),{code:'PROJECT_COPY_SOURCE_CHANGED'});
 assert.equal(opens,0);assert.equal(f.admitted.length,0);
 const result=await f.host.openPath(owner,copy,admission);assert.equal(result.status,'copy');assert.equal(opens,1);assert.equal(f.admitted.length,0);
 await assert.rejects(f.host.dispatch('owner',{action:'openSelectedFile',admission:{file:copy,facts}}));
});

test('COPY opens only its verified registered original and the display path cannot be used as a capability',async t=>{
 const f=await fixture(t),copy=path.join(f.root,'Unrelated filename.mioon');copyFileSync(f.file,copy);const before=readFileSync(copy);f.setOpen(copy);
 const pending=await f.bridge.openSelectedFile();if(pending.status!=='copy')assert.fail();
 assert.deepEqual(pending.original,{name:'Original',displayPath:f.file});
 const opened=await f.bridge.openOriginal({token:pending.token});assert.equal(opened.status,'opened');if(opened.status==='opened')assert.equal(opened.projectId,f.projectId);
 assert.deepEqual(readFileSync(copy),before);await assert.rejects(f.host.dispatch('owner',{action:'openOriginal',token:pending.token,projectFile:copy}));
 f.replaceDocument();await assert.rejects(f.bridge.openOriginal({token:pending.token}));
});

for(const reason of ['read-only','network'] as const)test(`${reason} selection stays closed and its read-only source ticket uses ordinary copyTo with a system save target`,async t=>{
 let opens=0;const f=await fixture(t,control=>({...control,async openPath(input){opens++;return control.openPath(input);}}));
 f.setFacts(f.file,{...facts,...(reason==='read-only'?{volumeReadOnly:true}:{isLocal:false})});
 const before=readFileSync(f.file),registered=(await f.client.api.listRecent()).registered;
 const observed=await f.bridge.openSelectedFile();if(observed.status!=='copy-source')assert.fail();
 assert.equal(observed.reason,reason);assert.equal(observed.name,'Original');assert.equal(observed.displayPath,f.file);assert.equal(opens,0);assert.equal(f.adopted.length,0);
 assert.deepEqual((await f.client.api.listRecent()).registered,registered,'observation cannot open or register its source');
 const target=await f.bridge.chooseLocation({purpose:'copy-to',suggestedName:observed.name,message:'Shared storage explanation'});assert.ok(target);
 assert.equal(target.displayPath,path.join(f.selected,'Original.mioon'));assert.equal(f.messages.at(-1),'Shared storage explanation');
 const result=await f.bridge.copyTo({token:target.token,sourceToken:observed.token,requestId:randomUUID()}) as {project:{projectId:string}};
 assert.notEqual(result.project.projectId,f.projectId);assert.deepEqual(readFileSync(f.file),before);
 const occupied=await f.bridge.chooseLocation({purpose:'copy-to',suggestedName:observed.name,message:'Shared storage explanation'});assert.ok(occupied);
 await assert.rejects(f.bridge.copyTo({token:occupied.token,sourceToken:observed.token,requestId:randomUUID()}),{code:'PROJECT_FILE_EXISTS'});
 f.replaceDocument();await assert.rejects(f.bridge.reveal({token:observed.token}));
});

test('a real read-only file on a writable volume produces a source ticket without admitting an editor', {skip:process.platform==='win32'||process.getuid?.()===0},async t=>{
 const f=await fixture(t);chmodSync(f.file,0o444);const before=readFileSync(f.file);
 try{const result=await f.bridge.openSelectedFile();if(result.status!=='copy-source')assert.fail();
 assert.equal(result.reason,'read-only');assert.equal(result.facts.volumeReadOnly,false);assert.equal(f.adopted.length,0);assert.deepEqual(readFileSync(f.file),before);
 }finally{chmodSync(f.file,0o600);}
});

test('fixed help and reveal accept only current registered identities or owner tickets; current facts come from the registered path',async t=>{
 const f=await fixture(t);await f.bridge.openPrivacySettings();assert.equal(f.settingsOpened,1);
 await f.bridge.reveal({projectId:f.projectId});assert.deepEqual(f.revealed,[f.file]);
 const target=await f.bridge.chooseLocation({purpose:'create',suggestedName:'Create',message:''});assert.ok(target);await f.bridge.reveal({token:target.token});assert.deepEqual(f.revealed,[f.file,f.selected]);
 await assert.rejects(f.host.dispatch('owner',{action:'reveal',path:f.file}));await assert.rejects(f.host.dispatch('owner',{action:'openPrivacySettings',url:'https://untrusted.invalid'}));
 await assert.rejects(f.bridge.reveal({projectId:randomUUID()}));await assert.rejects(f.bridge.currentLocation());
 f.asEditor();assert.deepEqual(await f.bridge.currentLocation(),{displayPath:f.file,facts});assert.equal((await f.bridge.capabilities()).locationFacts,true);
 f.replaceDocument();await assert.rejects(f.bridge.reveal({token:target.token}));
});

test('a system dialog answer from an old document cannot probe, create, or open for a replacement',async()=>{
 let complete!: (value:string|null)=>void;
 const gate=new Promise<string|null>(resolve=>{complete=resolve;});let current=true,calls=0;
 const owner={window:{},windowId:randomUUID(),backendId:randomUUID(),contextId:randomUUID(),isCurrent:()=>current};
 const backend=createProjectEntryControlClient({backendId:owner.backendId,send:()=>{assert.fail('No backend dispatch may survive the old dialog');}});
 const host=createProjectEntryDesktopHost({ownerForEvent:()=>owner,backend:backend.api,isReady:()=>true,
  chooseDirectory:async()=>gate,chooseOpenFile:async()=>gate,chooseSaveFile:async()=>gate,
  probeLocation:async()=>{calls++;return facts;},admitLocation:async()=>true,adoptPrepared:async()=>{assert.fail();},openRecent:async()=>{assert.fail();}});
 const pending=host.dispatch(null,{action:'openSelectedFile'});current=false;complete('/synthetic/old.mioon');await assert.rejects(pending);
 assert.equal(calls,0);host.close();backend.close();
});
