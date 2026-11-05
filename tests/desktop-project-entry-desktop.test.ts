import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,copyFileSync,readFileSync,rmSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {startServer} from '../apps/server/src/index.ts';
import {createServerProject} from './helpers/project-database.ts';
import {createProjectEntryControlClient,createProjectEntryControlBroker} from '../apps/desktop/src/project-entry-control.ts';
import {createProjectEntryDesktopHost} from '../apps/desktop/src/project-entry-desktop-host.ts';
import {createProjectEntriesDesktopBridge} from '../apps/desktop/src/project-entry-desktop-preload.ts';
import {PROJECT_ENTRY_DESKTOP_CHANNEL} from '../packages/contracts/src/project-entry-desktop.ts';
import type {ProjectEntryDesktopOwner} from '../apps/desktop/src/project-entry-desktop-host.ts';
import type {ProjectLocationFacts} from '../packages/contracts/src/project-entry-desktop.ts';
import type {ProjectEntryControlPort} from '../packages/contracts/src/project-entry-native.ts';

const facts:ProjectLocationFacts={fileSystem:'apfs',isLocal:true,volumeReadOnly:false,permissionBits:true,cloud:'not-reported'};
async function fixture(t:test.TestContext,wrap?:(control:ProjectEntryControlPort)=>ProjectEntryControlPort){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-entry-desktop-')),dataDir=path.join(root,'app'),selected=path.join(root,'selected');mkdirSync(selected);
 const created=createServerProject(dataDir,{name:'Original'}),file=created.store.projectFile,projectId=created.projectId;created.store.close();
 const server=await startServer({dataDir,port:0,token:'synthetic-desktop-entry-token'}),backendId=randomUUID();
 let client!:ReturnType<typeof createProjectEntryControlClient>;
 const broker=createProjectEntryControlBroker({backendId,control:wrap?.(server.projectEntries)??server.projectEntries,send:message=>queueMicrotask(()=>client.handle(message))});
 client=createProjectEntryControlClient({backendId,send:message=>queueMicrotask(()=>broker.handle(message))});
 const nativeWindow={},windowId=randomUUID();let contextId=randomUUID(),active=true,ready=true,editor=false,settingsOpened=0;
 const owner=():ProjectEntryDesktopOwner=>{const captured=contextId;return{window:nativeWindow,windowId,backendId,contextId:captured,...(editor?{projectId}:{}),isCurrent:()=>active&&contextId===captured};};
 let directory:string|null=selected,openFile:string|null=file;
 const messages:string[]=[],adopted:string[]=[],probed:string[]=[],revealed:string[]=[],locationFacts=new Map<string,ProjectLocationFacts>();
 const host=createProjectEntryDesktopHost({ownerForEvent:(event:string)=>event==='owner'?owner():null,backend:client.api,isReady:()=>ready,
  chooseDirectory:async(_owner,input)=>{messages.push(input.message);return directory;},chooseOpenFile:async()=>openFile,
  chooseSaveFile:async(_owner,input)=>{messages.push(input.message);return path.join(selected,input.suggestedName+'.mioon');},
  probeLocation:async input=>{probed.push(input.path);return locationFacts.get(input.path)??facts;},admitLocation:async()=>true,
  adoptPrepared:async prepared=>{adopted.push(prepared.windowId);return {ok:true,targetWindowId:prepared.windowId,reason:'accepted'};},
  openRecent:async()=>({ok:false,targetWindowId:null,reason:'unavailable'}),
  openPrivacySettings:async()=>{settingsOpened++;},revealVerifiedPath:async(_owner,file)=>{revealed.push(file);},
 });
 const bridge=createProjectEntriesDesktopBridge((channel,input)=>{assert.equal(channel,PROJECT_ENTRY_DESKTOP_CHANNEL);return host.handle('owner',input);});
 t.after(async()=>{host.close();client.close();broker.close();await server.close();rmSync(root,{recursive:true,force:true});});
 return {root,selected,file,projectId,host,bridge,client,messages,adopted,probed,owner,revealed,get settingsOpened(){return settingsOpened;},asEditor(){editor=true;},setFacts(file:string,value:ProjectLocationFacts){locationFacts.set(file,value);},
  replaceDocument(){contextId=randomUUID();},disable(){ready=false;},cancel(){directory=null;openFile=null;},setOpen(file:string){openFile=file;},closeOwner(){active=false;}};
}

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
 const owner=f.owner();f.host.rememberPendingOpen(owner,pending);assert.deepEqual(await f.bridge.takePendingOpen(),pending);assert.equal(await f.bridge.takePendingOpen(),null);
 const opened=await f.bridge.adoptCopy({token:pending.token});assert.equal(opened.status,'opened');
 if(opened.status==='opened')assert.notEqual(opened.projectId,f.projectId);
 assert.deepEqual(readFileSync(f.file),original);assert.equal(f.adopted.length,1);
 assert.deepEqual(await f.bridge.adoptCopy({token:pending.token}),opened,'same confirmed token observes its original result');
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
