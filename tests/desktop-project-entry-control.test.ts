import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,mkdirSync,copyFileSync,renameSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {startServer} from '../apps/server/src/index.ts';
import {createServerProject} from './helpers/project-database.ts';
import {createProjectEntryControlClient,createProjectEntryControlBroker} from '../apps/desktop/src/project-entry-control.ts';
import {PROJECT_ENTRY_CONTROL_LIMITS} from '../packages/contracts/src/project-entry-control.ts';
import type {ProjectEntryControlPort} from '../packages/contracts/src/project-entry-native.ts';

async function fixture(t:test.TestContext,wrap?:(control:ProjectEntryControlPort)=>ProjectEntryControlPort,onReply?:(message:unknown,deliver:()=>void)=>void){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-entry-control-')),dataDir=path.join(root,'app'),parent=path.join(root,'selected');mkdirSync(parent);
 const created=createServerProject(dataDir,{name:'Original'}),projectId=created.projectId,file=created.store.projectFile;created.store.close();
 const server=await startServer({dataDir,port:0,token:'synthetic-project-entry-control-token'}),backendId=randomUUID(),sent:unknown[]=[];
 let client!:ReturnType<typeof createProjectEntryControlClient>;
 const broker=createProjectEntryControlBroker({backendId,control:wrap?.(server.projectEntries)??server.projectEntries,send:message=>{const deliver=()=>queueMicrotask(()=>client.handle(message));if(onReply)onReply(message,deliver);else deliver();}});
 client=createProjectEntryControlClient({backendId,send:message=>{sent.push(message);queueMicrotask(()=>broker.handle(message));}});
 t.after(async()=>{client.close();broker.close();await server.close();rmSync(root,{recursive:true,force:true});});
 return {server,client,broker,backendId,sent,root,parent,projectId,file};
}

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
