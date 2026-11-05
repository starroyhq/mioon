import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {createProjectHomeNativeActionsController} from '../apps/web/src/project-home-native-actions-state.ts';
import type {ProjectHomeNativeActions, ProjectHomeNativeActionIdentity, ProjectHomeNativeActionMetadata, ProjectHomeNativeActionState} from '../apps/web/src/project-home-native-actions-state.ts';
import {projectEntriesResponseSchema} from '../packages/contracts/src/project-entry.ts';
import {projectDeleteResponseSchema} from '../packages/contracts/src/project-lifecycle.ts';
import type {ProjectDeleteInput} from '../packages/contracts/src/project-lifecycle.ts';
import type {ProjectDesktopSelection, ProjectEntriesDesktopBridge} from '../packages/contracts/src/project-entry-desktop.ts';
import {projectCopyResponseSchema} from '../packages/contracts/src/project-copies.ts';
import {BrowserRpcError} from '../apps/web/src/browser-rpc.ts';
import {LOCALES, translate} from '../packages/i18n/src/index.ts';
import {RECENT_PROJECTS} from './fixtures/project-file-ui/fixtures.ts';
import {tagOf, escapeHtml} from './helpers/project-file-ui.ts';
import {lenientFunction} from './helpers/eval-source.ts';
import {createProjectEntryController} from '../apps/web/src/project-entry-state.ts';
import {createLauncherClient} from '../apps/web/src/launcher-state.ts';
import type {ProjectWindowBridge, ProjectWindowContext} from '../apps/web/src/desktop-window-client.ts';
import {projectEntryOwnerFixture} from './helpers/project-entry-fixture.ts';

const id=(n:number)=>`77000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const projectId=RECENT_PROJECTS[0]!.projectId;
const selection:ProjectDesktopSelection={token:id(50),displayPath:'/synthetic/Panel name/Panel name.mioon',facts:{fileSystem:'apfs',isLocal:true,volumeReadOnly:false,permissionBits:true,cloud:'not-reported'},template:{id:'timeline-basics',version:1,name:'Panel name'}};
const held=<T>()=>Promise.withResolvers<T>();
type ExampleInput=Parameters<NonNullable<ProjectEntriesDesktopBridge['instantiateTemplate']>>[0];
function fixture(onNativeResult?:(projectId:string,permit:()=>boolean)=>Promise<boolean>,onNativeMetadata?:(metadata:ProjectHomeNativeActionMetadata)=>void){
 let snapshot=projectEntriesResponseSchema.parse({version:1,appLibraryScope:'a'.repeat(64),instanceId:id(1),registered:[{project:structuredClone(RECENT_PROJECTS[0]!),availability:{state:'available'},coverUrl:`/api/project-covers/${projectId}`}]}),owner:ProjectHomeNativeActionIdentity|null={appLibraryScope:snapshot.appLibraryScope,instanceId:snapshot.instanceId,epoch:1};
 const reads:unknown[]=[],trashes:ProjectDeleteInput[]=[],examples:ExampleInput[]=[],metadata:ProjectHomeNativeActionMetadata[]=[],opened:string[]=[];
 let ids=100,refreshes=0,allowed=true,openAccepted=false;
 let read:()=>Promise<unknown>=async()=>snapshot;
 let trash:(input:ProjectDeleteInput)=>Promise<unknown>=async input=>projectDeleteResponseSchema.parse({requestId:input.requestId,projectId:input.projectId,projectFile:input.projectFile,trashed:true,records:'retained'});
 let choose:ProjectEntriesDesktopBridge['chooseLocation']=async()=>selection;
 let instantiate:NonNullable<ProjectEntriesDesktopBridge['instantiateTemplate']>=async input=>projectCopyResponseSchema.parse({requestId:input.requestId,sourceProjectId:projectId,project:{projectId:id(60),projectFile:selection.displayPath,fileIdentity:{dev:'1',ino:'60'},name:input.name,lastOpenedAt:null,summary:null},contentSequence:0,contentToken:'a'.repeat(32),versions:0});
 let refresh=async()=>{refreshes++;};
 let ports:ProjectHomeNativeActions|undefined={trash:async input=>{trashes.push(input);return trash(input);},example:{templates:[{id:'timeline-basics',version:1}],bridge:{chooseLocation:input=>choose(input),instantiateTemplate:async input=>{examples.push(input);return instantiate(input);}}}};
 const controller=createProjectHomeNativeActionsController({ports:()=>ports,owner:()=>owner,canStart:()=>allowed,readDirectory:async()=>{reads.push('GET');return read();},onChange:(_state,next)=>{metadata.push(next);onNativeMetadata?.(next);},onRefresh:()=>refresh(),onOpenCreated:async projectId=>{opened.push(projectId);return openAccepted;},...(onNativeResult?{onOpenNativeResult:onNativeResult}:{}),newRequestId:()=>id(++ids)});controller.activate();
 return {controller,reads,trashes,examples,metadata,opened,get snapshot(){return snapshot;},set snapshot(value){snapshot=value;},get refreshes(){return refreshes;},setOwner(value:ProjectHomeNativeActionIdentity|null){owner=value;},setAllowed(value:boolean){allowed=value;},setRead(value:typeof read){read=value;},setTrash(value:typeof trash){trash=value;},setChoose(value:typeof choose){choose=value;},setInstantiate(value:typeof instantiate){instantiate=value;},setRefresh(value:typeof refresh){refresh=value;},setOpen(value:boolean){openAccepted=value;},setPorts(value:ProjectHomeNativeActions|undefined){ports=value;}};
}

test('missing native capabilities and denied departure permits perform no directory read or mutation',async()=>{
 const f=fixture();f.setPorts(undefined);assert.equal(await f.controller.prepareTrash(projectId),false);assert.equal(await f.controller.startExample('Storage','Suggested'),false);
 assert.deepEqual(f.reads,[]);const g=fixture();assert.equal(await g.controller.prepareTrash(projectId,()=>false),false);assert.equal(await g.controller.startExample('Storage','Suggested',()=>false),false);assert.deepEqual(g.reads,[]);assert.deepEqual(g.trashes,[]);assert.deepEqual(g.examples,[]);
});

test('trash uses fresh strict registration, file identity and real cached revision only after explicit confirmation',async()=>{
 const f=fixture();assert.equal(await f.controller.prepareTrash(projectId),true);assert.equal(f.controller.getState().kind,'confirm-trash');assert.equal(f.trashes.length,0);
 assert.ok(Object.isFrozen(f.controller.getState().project));assert.ok(Object.isFrozen(f.controller.getState().project!.fileIdentity));
 assert.equal(await f.controller.confirmTrash(),true);assert.equal(f.reads.length,2);assert.equal(f.trashes.length,1);
 assert.deepEqual(f.trashes[0],{requestId:id(101),projectId,projectFile:RECENT_PROJECTS[0]!.projectFile,fileIdentity:RECENT_PROJECTS[0]!.fileIdentity,expectedRevision:RECENT_PROJECTS[0]!.summary!.revision,confirmTrash:true});
 assert.ok(Object.isFrozen(f.trashes[0]));assert.ok(Object.isFrozen(f.trashes[0]!.fileIdentity));assert.equal(f.controller.getState().notice?.kind,'success');assert.equal(f.refreshes,1);
 assert.equal(f.snapshot.registered.length,1,'The action does not optimistically mutate the supplied directory');
});

test('cancelled confirmation, unknown summaries and malformed directories never fabricate a revision or dispatch',async()=>{
 const f=fixture();await f.controller.prepareTrash(projectId);assert.equal(f.controller.close(),true);assert.equal(await f.controller.confirmTrash(),false);assert.deepEqual(f.trashes,[]);
 const g=fixture();g.snapshot.registered[0]!.project.summary=null;g.snapshot.registered[0]!.coverUrl=null;assert.equal(await g.controller.prepareTrash(projectId),false);assert.equal(g.controller.getState().reason,'facts');assert.equal(await g.controller.confirmTrash(),false);assert.deepEqual(g.trashes,[]);
 const h=fixture();h.setRead(async()=>({...h.snapshot,unexpected:true}));assert.equal(await h.controller.prepareTrash(projectId),false);assert.deepEqual(h.trashes,[]);
});

test('changed path, inode, revision and removed registration after confirmation refresh the list without submitting',async()=>{
 for(const change of ['path','inode','revision','removed'] as const){
  const f=fixture();await f.controller.prepareTrash(projectId);
  if(change==='path')f.snapshot.registered[0]!.project.projectFile='/synthetic/Moved.mioon';
  if(change==='inode')f.snapshot.registered[0]!.project.fileIdentity.ino='999';
  if(change==='revision')f.snapshot.registered[0]!.project.summary!.revision++;
  if(change==='removed')f.snapshot.registered=[];
  assert.equal(await f.controller.confirmTrash(),false);assert.deepEqual(f.trashes,[],change);assert.equal(f.controller.getState().notice?.kind,'changed');assert.equal(f.refreshes,1);
 }
});

test('late metadata reads cannot mutate after input, library, instance, epoch or renderer lifetime changes',async()=>{
 for(const change of ['input','scope','instance','epoch','dispose'] as const){
  const f=fixture(),gate=held<unknown>();let permit=true;f.setRead(()=>gate.promise);const pending=f.controller.prepareTrash(projectId,()=>permit);
  if(change==='input')permit=false;
  if(change==='scope')f.setOwner({appLibraryScope:'b'.repeat(64),instanceId:id(1),epoch:1});
  if(change==='instance')f.setOwner({appLibraryScope:'a'.repeat(64),instanceId:id(2),epoch:1});
  if(change==='epoch')f.setOwner({appLibraryScope:'a'.repeat(64),instanceId:id(1),epoch:2});
  if(change==='dispose')f.controller.dispose();
  gate.resolve(f.snapshot);assert.equal(await pending,false);assert.deepEqual(f.trashes,[],change);assert.equal(f.controller.getMetadata().busy,false);
 }
});

test('waiting work and S8 are decided by the trash service; HOST_BUSY does not invent a specific waiting cause',async()=>{
 const f=fixture();f.setTrash(async()=>{throw new BrowserRpcError('PROJECT_HOST_BUSY',true);});await f.controller.prepareTrash(projectId);assert.equal(await f.controller.confirmTrash(),false);
 assert.equal(f.trashes.length,1);assert.equal(f.controller.getState().kind,'trash-blocked');assert.equal(f.controller.getState().reason,'busy');assert.equal(f.refreshes,0);assert.equal(f.controller.getState().notice,null);
 const g=fixture();await g.controller.prepareTrash(projectId);assert.equal(await g.controller.confirmTrash(),true,'No local draft or guessed waiting-task predicate blocks a service-authorized action');
});

test('network, protocol mismatch and explicit unconfirmed outcomes lock the original input; recheck is exact and never automatic',async()=>{
 for(const outcome of ['network','receipt','unconfirmed'] as const){
  const f=fixture();f.setTrash(async input=>{if(outcome==='receipt')return{requestId:id(999),projectId:input.projectId,projectFile:input.projectFile,trashed:true,records:'retained'};throw new BrowserRpcError(outcome==='network'?'NETWORK':'PROJECT_TRASH_UNCONFIRMED',outcome!=='network');});
  await f.controller.prepareTrash(projectId);assert.equal(await f.controller.confirmTrash(),false);const original=f.trashes[0]!;
  assert.equal(f.controller.getState().kind,'trash-unknown');assert.equal(f.controller.getMetadata().unknown,true);assert.equal(f.controller.close(),false);assert.equal(f.controller.getState().notice,null);assert.equal(f.refreshes,0);assert.equal(await f.controller.prepareTrash(projectId),false);assert.equal(f.trashes.length,1);
  f.setTrash(async input=>({requestId:input.requestId,projectId:input.projectId,projectFile:input.projectFile,trashed:true,records:'retained'}));
  f.snapshot.registered=[];assert.equal(await f.controller.recheck(),true,'A missing registration cannot prevent reading the exact original receipt');assert.equal(f.trashes.length,2);assert.equal(f.trashes[1],original);assert.equal(f.controller.getState().notice?.kind,'success');assert.equal(f.controller.getMetadata().unknown,false);
 }
});

test('an explicit recheck has one synchronous latch and retains unknown close metadata while waiting',async()=>{
 const f=fixture();f.setTrash(async()=>{throw new BrowserRpcError('NETWORK');});await f.controller.prepareTrash(projectId);await f.controller.confirmTrash();
 const gate=held<unknown>();f.setRead(()=>gate.promise);const pending=f.controller.recheck();assert.equal(await f.controller.recheck(),false);assert.equal(f.trashes.length,1);assert.equal(f.controller.getMetadata().unknown,true);
 gate.resolve(f.snapshot);await pending;assert.equal(f.trashes.length,2);assert.equal(f.trashes[1],f.trashes[0]);
});

test('visibility disposal retains uncertain intent; only explicit same-identity consent can recheck it',async()=>{
 const f=fixture(),gate=held<unknown>();f.setTrash(()=>gate.promise);await f.controller.prepareTrash(projectId);const pending=f.controller.confirmTrash();await new Promise(setImmediate);
 f.controller.dispose();f.controller.activate();gate.resolve({requestId:f.trashes[0]!.requestId,projectId,projectFile:f.trashes[0]!.projectFile,trashed:true,records:'retained'});assert.equal(await pending,false);assert.equal(f.controller.getState().kind,'trash-unknown');assert.equal(f.controller.getState().notice,null);
 assert.equal(await f.controller.recheck(()=>false),false);assert.equal(f.trashes.length,1);
 f.setOwner({appLibraryScope:'a'.repeat(64),instanceId:id(3),epoch:2});assert.equal(await f.controller.recheck(),false);assert.equal(f.trashes.length,1);
 f.setOwner({appLibraryScope:'a'.repeat(64),instanceId:id(1),epoch:1});f.setTrash(async input=>({requestId:input.requestId,projectId,projectFile:input.projectFile,trashed:true,records:'retained'}));assert.equal(await f.controller.recheck(),true);assert.equal(f.trashes[1],f.trashes[0]);
});

test('confirmed receipt remains success even when the subsequent read-only list refresh fails',async()=>{
 const f=fixture();f.setRefresh(async()=>{throw Error('List read failed');});await f.controller.prepareTrash(projectId);assert.equal(await f.controller.confirmTrash(),true);assert.equal(f.controller.getState().kind,'idle');assert.equal(f.controller.getState().notice?.kind,'success');assert.equal(f.controller.getMetadata().unknown,false);assert.equal(f.trashes.length,1);
});

test('template cancellation reads metadata only and a stale chooser response cannot instantiate',async()=>{
 const f=fixture();f.setChoose(async()=>null);assert.equal(await f.controller.startExample('Storage','Suggested'),false);assert.equal(f.controller.getState().kind,'idle');assert.deepEqual(f.examples,[]);assert.deepEqual(f.opened,[]);
 const g=fixture(),gate=held<ProjectDesktopSelection|null>();let permit=true;g.setChoose(()=>gate.promise);const pending=g.controller.startExample('Storage','Suggested',()=>permit);await new Promise(setImmediate);permit=false;gate.resolve(selection);assert.equal(await pending,false);assert.deepEqual(g.examples,[]);assert.equal(g.controller.getMetadata().busy,false);
});

test('template dispatch uses the main-validated name/token and keeps created receipt separate from an explicit open',async()=>{
 const f=fixture();assert.equal(await f.controller.startExample('Storage','Suggested'),true);assert.equal(f.examples.length,1);assert.deepEqual(f.examples[0],{token:selection.token,templateId:'timeline-basics',templateVersion:1,name:'Panel name',requestId:id(101)});
 assert.equal('parentDir'in f.examples[0]!,false);assert.equal('projectFile'in f.examples[0]!,false);assert.equal(f.controller.getState().kind,'example-created');assert.deepEqual(f.opened,[]);
 assert.equal(await f.controller.retryOpen(),false);assert.deepEqual(f.opened,[id(60)]);assert.equal(f.controller.getState().kind,'example-created');assert.equal(f.examples.length,1);
 f.setOpen(true);assert.equal(await f.controller.retryOpen(),true);assert.equal(f.controller.getState().kind,'idle');assert.equal(f.examples.length,1);
});

test('unknown template confirmation preserves the exact original token and request without allocating another destination',async()=>{
 const f=fixture();f.setInstantiate(async()=>{throw Object.assign(Error('Unknown'),{code:'PROJECT_ENTRY_OUTCOME_UNKNOWN',status:409,details:{}});});await f.controller.startExample('Storage','Suggested');
 const original=f.examples[0]!;assert.equal(f.controller.getState().kind,'example-unknown');assert.equal(f.controller.close(),false);assert.deepEqual(f.opened,[]);assert.equal(await f.controller.startExample('Storage','Suggested'),false);
 await f.controller.recheck();assert.equal(f.examples.length,2);assert.equal(f.examples[1],original);assert.equal(f.controller.getMetadata().unknown,true);assert.deepEqual(f.opened,[]);
});

test('a confirmed template ACK opens once with the literal native permit; failed open retains its receipt and only retries opening',async()=>{
 for(const accepted of [true,false]){
  const calls:{projectId:string;permit:()=>boolean}[]=[],nativePermit=()=>true,localPermit=()=>nativePermit();
  const f=fixture(async(projectId,permit)=>{calls.push({projectId,permit});return accepted;});
  assert.equal(await f.controller.startExample('Storage','Suggested',localPermit,nativePermit),true);assert.equal(calls.length,1);assert.equal(calls[0]!.permit,nativePermit);assert.notEqual(calls[0]!.permit,localPermit);assert.equal(calls[0]!.projectId,id(60));assert.equal(f.examples.length,1);assert.deepEqual(f.opened,[]);
  if(accepted)assert.equal(f.controller.getState().kind,'idle');
  else{const receipt=f.controller.getState().exampleReceipt;assert.ok(receipt);assert.equal(receipt.requestId,f.examples[0]!.requestId);assert.equal(f.controller.getState().kind,'example-created');assert.ok(Object.isFrozen(receipt));f.setOpen(true);assert.equal(await f.controller.retryOpen(),true);assert.equal(f.examples.length,1);assert.deepEqual(f.opened,[id(60)]);assert.equal(calls.length,1);}
 }
});

test('new input or a revoked native permit preserves the verified template receipt without opening or classifying it as unknown',async()=>{
 const gate=held<Awaited<ReturnType<NonNullable<ProjectEntriesDesktopBridge['instantiateTemplate']>>>>();let permit=true,opens=0;
 const f=fixture(async()=>{opens++;return true;});f.setInstantiate(()=>gate.promise);
 const nativePermit=()=>permit,pending=f.controller.startExample('Storage','Suggested',()=>nativePermit(),nativePermit);await new Promise(setImmediate);permit=false;
 gate.resolve(projectCopyResponseSchema.parse({requestId:f.examples[0]!.requestId,sourceProjectId:projectId,project:{projectId:id(60),projectFile:selection.displayPath,fileIdentity:{dev:'1',ino:'60'},name:'Panel name',lastOpenedAt:null,summary:null},contentSequence:0,contentToken:'a'.repeat(32),versions:0}));
 assert.equal(await pending,true);assert.equal(opens,0);assert.equal(f.controller.getState().kind,'example-created');assert.equal(f.controller.getMetadata().unknown,false);assert.equal(f.controller.getState().exampleReceipt!.requestId,f.examples[0]!.requestId);assert.equal(f.examples.length,1);
});

test('automatic opening uses the captured live native authority rather than a stale copy of its own busy prop',async()=>{
 let opens=0;const f=fixture(async()=>{opens++;return true;}),permit=()=>true;
 f.setRefresh(async()=>{f.setAllowed(false);});
 assert.equal(await f.controller.startExample('Storage','Suggested',permit,permit),true);assert.equal(opens,1);assert.equal(f.controller.getState().kind,'idle');assert.equal(f.examples.length,1);
});

test('a validated ACK arriving after disposal is retained privately and explicit recheck does not instantiate again',async()=>{
 const gate=held<Awaited<ReturnType<NonNullable<ProjectEntriesDesktopBridge['instantiateTemplate']>>>>(),f=fixture();f.setInstantiate(()=>gate.promise);
 const pending=f.controller.startExample('Storage','Suggested');await new Promise(setImmediate);f.controller.dispose();f.controller.activate();
 gate.resolve(projectCopyResponseSchema.parse({requestId:f.examples[0]!.requestId,sourceProjectId:projectId,project:{projectId:id(60),projectFile:selection.displayPath,fileIdentity:{dev:'1',ino:'60'},name:'Panel name',lastOpenedAt:null,summary:null},contentSequence:0,contentToken:'a'.repeat(32),versions:0}));
 assert.equal(await pending,false);assert.equal(f.controller.getState().kind,'example-unknown');assert.equal(await f.controller.recheck(),true);assert.equal(f.examples.length,1);assert.equal(f.controller.getState().kind,'example-created');assert.equal(f.controller.getState().exampleReceipt!.project.projectId,id(60));
});

function screenAction(f:ReturnType<typeof fixture>,prepare:()=>Promise<(()=>boolean)|null>){
 const source=readFileSync(new URL('../apps/web/src/ProjectHomeDirectoryScreen.tsx',import.meta.url),'utf8'),start=source.indexOf('  async function nativeAction('),end=source.indexOf('  async function open(',start);assert.ok(start>=0&&end>start);
 const busy:boolean[]=[],env={preparingNative:{current:false},opening:{current:null},active:()=>true,canAct:()=>f.controller.getState().kind==='idle',form:{current:{dirty:false,busy:false,version:1}},current:{current:{phase:'home',onPrepareNativeAction:prepare}},lifetime:{current:1},mounted:{current:true},setOpeningBusy:(value:boolean)=>busy.push(value),confirm:async()=>assert.fail('Native consent must not be repeated by the page'),t:(key:string)=>key,native:f.controller};
 const action=lenientFunction('env',`with(env){${source.slice(start,end)};return nativeAction;}`)(env) as (action:'trash'|'example'|'recheck',projectId?:string)=>Promise<void>;
 return {action,env,busy};
}

function parentScreenFixture(){
 let entry!:ReturnType<typeof createProjectEntryController>,confirmations=0,preparations=0;
 const granted:(()=>boolean)[]=[],openedPermits:(()=>boolean)[]=[],hostOpens:string[]=[],parentReads:unknown[][]=[];
 const extra={dirty:false,busy:false,unknown:false,identity:[1]};
 const f=fixture(async(projectId,permit)=>{openedPermits.push(permit);return entry.openNativeResult(projectId,permit);},metadata=>entry.reportNativeAction(metadata));
 const context:ProjectWindowContext={version:2,role:'launcher',windowId:id(30),contextId:id(31),backendId:f.snapshot.instanceId,initialProjectId:null,autoOpen:false,editorProjectId:null,editorPhase:'none',editorCount:0,entryMode:null,entryVersion:0,entryReceipt:null,settingsSlot:null,settingsVersion:0,selectionProjectId:null,selectionVersion:0,locatorStatus:null,locatorIntent:null,quitting:false};
 const bridge:ProjectWindowBridge={context:async()=>context,openProject:async projectId=>{hostOpens.push(projectId);return{ok:true,reason:'accepted',targetWindowId:id(90),targetPhase:null};},publishLocatorStatus:async()=>true,requestLocatorAction:async()=>true,requestProjectEntry:async()=>true,showProjects:async()=>true,showSettings:async()=>true,closeSettings:async()=>true,editorStatus:async()=>true,subscribe:()=>()=>{}};
 const identity=projectEntryOwnerFixture(()=>f.snapshot,parentReads);
 entry=createProjectEntryController({context,bridge,identity,readAdditionalSnapshot:()=>extra,confirm:async()=>{confirmations++;return true;},newToken:()=>id(91),
  client:createLauncherClient(async()=>assert.fail('Home native actions cannot dispatch the legacy create RPC'),{parseCreateInput:value=>value,readDirectory:async()=>f.snapshot})});
 entry.activate();entry.reportCreate({dirty:true,busy:false,version:1});
 const screen=screenAction(f,async()=>{preparations++;const permit=await entry.prepareHomeNativeDeparture();if(permit)granted.push(permit);return permit;});
 // Match the production ProjectEntry refresh callback: interaction observation
 // does not revoke the departure intent or discard the retained draft.
 f.setRefresh(async()=>{entry.interacted();await entry.refresh();});
 return{f,entry,screen,context,extra,parentReads,granted,openedPermits,hostOpens,get confirmations(){return confirmations;},get preparations(){return preparations;}};
}

test('actual parent and Screen recheck a template unknown with the original opaque permit and exact input',async t=>{
 const p=parentScreenFixture(),{f,entry,screen}=p;t.after(()=>{f.controller.dispose();entry.dispose();});
 f.setInstantiate(async()=>{throw Object.assign(Error('Unknown'),{code:'PROJECT_ENTRY_OUTCOME_UNKNOWN',status:409,details:{}});});
 await screen.action('example');const original=f.examples[0]!;
 assert.equal(f.controller.getState().kind,'example-unknown');assert.equal(entry.readCloseSnapshot().unknown,true);assert.equal(f.controller.close(),false);assert.equal(p.confirmations,1);assert.equal(p.preparations,1);
 const beforePrepare=p.parentReads.length;assert.equal(await entry.prepareHomeNativeDeparture(),null,'A new action remains forbidden by the real parent unknown gate');assert.equal(p.parentReads.length,beforePrepare);
 const gate=held<Awaited<ReturnType<NonNullable<ProjectEntriesDesktopBridge['instantiateTemplate']>>>>();f.setInstantiate(()=>gate.promise);
 const pending=screen.action('recheck');await new Promise(setImmediate);await screen.action('recheck');
 assert.equal(f.examples.length,2);assert.equal(f.examples[1],original);assert.equal(entry.readCloseSnapshot().unknown,true);assert.equal(f.controller.close(),false);assert.deepEqual(p.hostOpens,[]);
 const receipt=projectCopyResponseSchema.parse({requestId:original.requestId,sourceProjectId:projectId,project:{projectId:id(60),projectFile:selection.displayPath,fileIdentity:{dev:'1',ino:'60'},name:original.name,lastOpenedAt:null,summary:null},contentSequence:0,contentToken:'a'.repeat(32),versions:0});
 f.snapshot.registered.push({project:receipt.project,availability:{state:'available'},coverUrl:null});gate.resolve(receipt);await pending;
 assert.equal(f.controller.getState().kind,'idle');assert.equal(entry.readCloseSnapshot().unknown,false);assert.equal(entry.readCloseSnapshot().dirty,true);assert.deepEqual(p.hostOpens,[receipt.project.projectId]);
 assert.equal(p.openedPermits[0],p.granted[0],'The original parent WeakSet permit reaches automatic open without a wrapper');assert.equal(p.openedPermits.length,1);assert.equal(p.confirmations,1);assert.equal(p.preparations,1);assert.equal(f.examples.length,2);
 assert.deepEqual(f.examples[1],{token:selection.token,templateId:'timeline-basics',templateVersion:1,name:'Panel name',requestId:original.requestId});
});

test('actual parent and Screen retain unknown without reads or replay after another guard or the original authority expires',async t=>{
 for(const change of ['native-busy','native-unknown','native-input','parent-input','page-input','page-lifetime','visibility','parent-lifetime','lease','context','library','instance','epoch'] as const){
  const p=parentScreenFixture(),{f,entry,screen}=p;t.after(()=>{f.controller.dispose();entry.dispose();});
  f.setInstantiate(async()=>{throw Object.assign(Error('Unknown'),{code:'PROJECT_ENTRY_OUTCOME_UNKNOWN',status:409,details:{}});});await screen.action('example');const original=f.examples[0]!;
  switch(change){
   case'native-busy':p.extra.busy=true;break;
   case'native-unknown':p.extra.unknown=true;break;
   case'native-input':p.extra.identity=[2];p.extra.dirty=true;break;
   case'parent-input':entry.reportCreate({dirty:true,busy:false,version:2});break;
   case'page-input':screen.env.form.current.version++;break;
   case'page-lifetime':screen.env.lifetime.current++;break;
   case'visibility':f.controller.dispose();f.controller.activate();break;
   case'parent-lifetime':entry.dispose();entry.activate();break;
   case'lease':entry.updateContext({...p.context,leaseRevoked:true});break;
   case'context':entry.updateContext({...p.context,settingsModalOpen:true});break;
   case'library':f.setOwner({appLibraryScope:'b'.repeat(64),instanceId:f.snapshot.instanceId,epoch:1});break;
   case'instance':f.setOwner({appLibraryScope:f.snapshot.appLibraryScope,instanceId:id(2),epoch:1});break;
   case'epoch':f.setOwner({appLibraryScope:f.snapshot.appLibraryScope,instanceId:f.snapshot.instanceId,epoch:2});break;
  }
  const reads=f.reads.length,parentReads=p.parentReads.length;await screen.action('recheck');
  assert.equal(f.reads.length,reads,change);assert.equal(p.parentReads.length,parentReads,change);assert.equal(f.examples.length,1,change);assert.equal(f.examples[0],original,change);assert.deepEqual(p.hostOpens,[],change);
  assert.equal(f.controller.getState().kind,'example-unknown',change);assert.equal(f.controller.close(),false,change);assert.equal(entry.readCloseSnapshot().unknown,true,change);assert.equal(p.confirmations,1,change);assert.equal(p.preparations,1,change);
 }
});

test('actual Screen obtains native dirty consent before metadata GET or its own busy report; cancellation has zero effects',async()=>{
 const f=fixture(),gate=held<(()=>boolean)|null>(),screen=screenAction(f,()=>gate.promise);const pending=screen.action('trash',projectId);
 assert.equal(f.controller.getMetadata().busy,false);assert.deepEqual(f.reads,[]);assert.deepEqual(f.metadata,[]);gate.resolve(null);await pending;
 assert.deepEqual(f.reads,[]);assert.deepEqual(f.trashes,[]);assert.deepEqual(screen.busy,[true,false]);assert.equal(screen.env.preparingNative.current,false);
});

test('actual Screen rejects late native consent after new local input or a replaced page lifetime',async()=>{
 for(const change of ['input','lifetime'] as const){const f=fixture(),gate=held<(()=>boolean)|null>(),screen=screenAction(f,()=>gate.promise),pending=screen.action('trash',projectId);
  if(change==='input')screen.env.form.current.version++;else screen.env.lifetime.current++;
  gate.resolve(()=>true);await pending;assert.deepEqual(f.reads,[],change);assert.deepEqual(f.trashes,[]);assert.equal(f.controller.getState().kind,'idle');
 }
});

test('actual Screen reports a failed preparation and retains unknown when the original permit is revoked',async()=>{
 const f=fixture(),screen=screenAction(f,async()=>{throw Error('Preparation unavailable');});await screen.action('trash',projectId);assert.deepEqual(f.reads,[]);assert.deepEqual(f.trashes,[]);assert.equal(f.controller.getState().kind,'trash-blocked');assert.equal(f.controller.getMetadata().busy,false);
 f.controller.close();let allowed=true;f.setTrash(async()=>{throw new BrowserRpcError('NETWORK');});await f.controller.prepareTrash(projectId,()=>allowed);await f.controller.confirmTrash();const reads=f.reads.length,original=f.trashes[0];allowed=false;await screen.action('recheck');assert.equal(f.controller.getState().kind,'trash-unknown');assert.equal(f.controller.close(),false);assert.equal(f.reads.length,reads);assert.equal(f.trashes.length,1);assert.equal(f.trashes[0],original);
});

test('actual Screen carries the live native permit through fresh metadata and explicit unknown recheck',async()=>{
 const f=fixture();let allowed=true;const screen=screenAction(f,async()=>()=>allowed);await screen.action('trash',projectId);assert.equal(f.controller.getState().kind,'confirm-trash');
 allowed=false;assert.equal(await f.controller.confirmTrash(),false);assert.equal(f.reads.length,1);assert.deepEqual(f.trashes,[]);f.controller.close();allowed=true;
 f.setTrash(async()=>{throw new BrowserRpcError('NETWORK');});await screen.action('trash',projectId);await f.controller.confirmTrash();const original=f.trashes[0];assert.equal(f.controller.getState().kind,'trash-unknown');
 f.setTrash(async input=>({requestId:input.requestId,projectId:input.projectId,projectFile:input.projectFile,trashed:true,records:'retained'}));await screen.action('recheck');assert.equal(f.trashes[1],original);assert.equal(f.controller.getState().kind,'idle');
});

const root=fileURLToPath(new URL('../',import.meta.url));
const bundle=await build({stdin:{contents:`import React from 'react';import{renderToStaticMarkup}from'react-dom/server';import{ProjectHomeNativeActionsView}from'./src/project-home-native-actions.tsx';import ProjectHome from './src/ProjectHome.tsx';import{setLocale}from ${JSON.stringify(root+'tests/fixtures/project-file-ui/ssr-i18n.tsx')};export function render(kind,props,locale){setLocale(locale);return renderToStaticMarkup(React.createElement(kind==='home'?ProjectHome:ProjectHomeNativeActionsView,props));}`,loader:'tsx',resolveDir:root+'apps/web'},bundle:true,platform:'node',format:'cjs',write:false,jsx:'automatic',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'},nodePaths:[root+'apps/web/node_modules'],plugins:[{name:'native-home-ssr',setup(build){build.onResolve({filter:/^@mioon\/ui\/components\/(?:dialog|dropdown-menu)$/},()=>({path:root+'tests/fixtures/project-file-ui/ssr-overlays.tsx'}));build.onResolve({filter:/\/i18n\/I18nProvider\.tsx$/},()=>({path:root+'tests/fixtures/project-file-ui/ssr-i18n.tsx'}));}}]});
const module:{exports:unknown}={exports:{}};Function('require','module','exports',bundle.outputFiles[0]!.text)(createRequire(import.meta.url),module,module.exports);
const ui=module.exports as {render(kind:'home'|'action',props:Record<string,unknown>,locale:typeof LOCALES[number]):string};
const noop=()=>{};
const view=(state:ProjectHomeNativeActionState,locale:typeof LOCALES[number],extra:Record<string,unknown>={})=>ui.render('action',{state,onClose:noop,onConfirmTrash:noop,onRecheck:noop,onRetryOpen:noop,onDismissNotice:noop,...extra},locale);
const disabled=(tag:string|null)=>tag!==null&&/\sdisabled=""/u.test(tag);

test('12-22 confirmation and unknown/result controls render in four languages without inventing capabilities',async()=>{
 const f=fixture();await f.controller.prepareTrash(projectId);const confirm=f.controller.getState();f.setTrash(async()=>{throw new BrowserRpcError('NETWORK');});await f.controller.confirmTrash();const unknown=f.controller.getState();
 for(const locale of LOCALES){const html=view(confirm,locale);assert.ok(html.includes(escapeHtml(translate(locale,'projectHomeNative.trash.title',{name:RECENT_PROJECTS[0]!.name}))));assert.ok(html.includes(escapeHtml(RECENT_PROJECTS[0]!.projectFile)));assert.ok(html.includes(escapeHtml(translate(locale,'projectHomeNative.trash.records'))));assert.ok(tagOf(html,'project-home-trash-confirm'));assert.equal(tagOf(html,'project-home-trash-help'),null);
  const waiting=view(unknown,locale);assert.equal(disabled(tagOf(waiting,'project-home-native-close')),true);assert.ok(tagOf(waiting,'project-home-native-recheck'));assert.equal(tagOf(waiting,'project-home-trash-confirm'),null);assert.ok(waiting.includes(escapeHtml(translate(locale,'projectHomeNative.trash.unknown'))));
 }
});

test('12-22b differentiates only actual host-window facts and safe service reasons; absent permission help stays hidden',async()=>{
 const f=fixture();f.setTrash(async()=>{throw new BrowserRpcError('PROJECT_HOST_BUSY',true);});await f.controller.prepareTrash(projectId);await f.controller.confirmTrash();
 for(const locale of LOCALES){const generic=view(f.controller.getState(),locale);assert.ok(generic.includes(escapeHtml(translate(locale,'projectHomeNative.trash.busy'))));assert.ok(!generic.includes(escapeHtml(translate(locale,'projectHomeNative.trash.open'))));
  const opened=view(f.controller.getState(),locale,{openedProjectIds:[projectId],onOpenProject:noop});assert.ok(opened.includes(escapeHtml(translate(locale,'projectHomeNative.trash.open'))));assert.ok(tagOf(opened,'project-home-trash-open'));
  const denied:ProjectHomeNativeActionState={...f.controller.getState(),reason:'denied'};assert.equal(tagOf(view(denied,locale),'project-home-trash-help'),null);assert.ok(tagOf(view(denied,locale,{onHelpAccess:noop}),'project-home-trash-help'));
 }
});

test('example affordance is absent by default and only supplied real capability renders it in four languages',()=>{
 const props={projects:[],phase:'home',busy:false,listBusy:false,page:'projects',onPage:noop,onOpen:noop,onRetry:noop,onRefresh:noop,onCreate:async()=>false,settings:null};
 for(const locale of LOCALES){assert.equal(tagOf(ui.render('home',props,locale),'project-home-example'),null);const html=ui.render('home',{...props,onStartExample:noop},locale);assert.ok(tagOf(html,'project-home-example'));assert.ok(html.includes(escapeHtml(translate(locale,'projectHomeNative.example'))));}
});

test('a definitive template preflight error renders example guidance rather than trash instructions in four languages',async()=>{
 const f=fixture();f.setChoose(async()=>{throw new BrowserRpcError('PROJECT_FILE_EXISTS',true);});assert.equal(await f.controller.startExample('Storage','Suggested'),false);assert.equal(f.controller.getState().kind,'example-blocked');assert.deepEqual(f.examples,[]);
 for(const locale of LOCALES){const html=view(f.controller.getState(),locale);assert.ok(html.includes(escapeHtml(translate(locale,'projectHomeNative.example.blockedTitle'))));assert.ok(html.includes(escapeHtml(translate(locale,'projectHomeNative.example.unavailable'))));assert.ok(!html.includes(escapeHtml(translate(locale,'projectHomeNative.trash.unavailable'))));assert.equal(tagOf(html,'project-home-trash-confirm'),null);}
});
