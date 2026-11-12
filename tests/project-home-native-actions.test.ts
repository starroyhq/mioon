import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {build, transformSync} from 'esbuild';
import {createProjectHomeNativeActionsController} from '../apps/web/src/project-home-native-actions-state.ts';
import type {ProjectHomeNativeActions, ProjectHomeNativeActionIdentity, ProjectHomeNativeActionMetadata, ProjectHomeNativeActionState} from '../apps/web/src/project-home-native-actions-state.ts';
import {projectEntriesResponseSchema} from '../packages/contracts/src/project-entry.ts';
import {projectDeleteResponseSchema} from '../packages/contracts/src/project-lifecycle.ts';
import type {ProjectDeleteInput} from '../packages/contracts/src/project-lifecycle.ts';
import type {ProjectDesktopSelection, ProjectEntriesDesktopBridge} from '../packages/contracts/src/project-entry-desktop.ts';
import {projectCopyResponseSchema} from '../packages/contracts/src/project-copies.ts';
import {BrowserRpcError, browserRpc} from '../apps/web/src/browser-rpc.ts';
import {rpc as legacyRpc} from '../apps/web/src/api.ts';
import {LOCALES, translate} from '../packages/i18n/src/index.ts';
import {RECENT_PROJECTS} from './fixtures/project-file-ui/fixtures.ts';
import {tagOf, escapeHtml} from './helpers/project-file-ui.ts';
import {lenientFunction} from './helpers/eval-source.ts';
import {createProjectEntryController} from '../apps/web/src/project-entry-state.ts';
import {createLauncherClient} from '../apps/web/src/launcher-state.ts';
import type {ProjectWindowBridge, ProjectWindowContext} from '../apps/web/src/desktop-window-client.ts';
import {projectEntryOwnerFixture} from './helpers/project-entry-fixture.ts';
import {readProjectEntryIdentity} from '../apps/web/src/project-entry-identity.ts';
import {i18nTestModule} from './helpers/i18n.ts';
import {readProjectEntryDesktopClient} from '../apps/web/src/project-entry-desktop-client.ts';
import {createProjectEntryDirectoryController} from '../apps/web/src/project-entry-directory-state.ts';
import type {ProjectEntryDirectoryController} from '../apps/web/src/project-entry-directory-state.ts';

const id=(n:number)=>`77000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const projectId=RECENT_PROJECTS[0]!.projectId;
const selection:ProjectDesktopSelection={token:id(50),displayPath:'/synthetic/Panel name/Panel name.mioon',facts:{fileSystem:'apfs',isLocal:true,volumeReadOnly:false,permissionBits:true,cloud:'not-reported'},template:{id:'timeline-basics',version:1,name:'Panel name'}};
const held=<T>()=>Promise.withResolvers<T>();
type ExampleInput=Parameters<NonNullable<ProjectEntriesDesktopBridge['instantiateTemplate']>>[0];
const templateReceipt=(input:ExampleInput)=>projectCopyResponseSchema.parse({requestId:input.requestId,sourceProjectId:projectId,project:{projectId:id(60),projectFile:selection.displayPath,fileIdentity:{dev:'1',ino:'60'},name:input.name,lastOpenedAt:null,summary:null},contentSequence:0,contentToken:'a'.repeat(32),versions:0});
function fixture(onNativeResult?:(projectId:string,permit:()=>boolean)=>Promise<boolean>,onNativeMetadata?:(metadata:ProjectHomeNativeActionMetadata)=>void){
 let snapshot=projectEntriesResponseSchema.parse({version:1,appLibraryScope:'a'.repeat(64),instanceId:id(1),registered:[{project:structuredClone(RECENT_PROJECTS[0]!),availability:{state:'available'},coverUrl:`/api/project-covers/${projectId}`}]}),owner:ProjectHomeNativeActionIdentity|null={appLibraryScope:snapshot.appLibraryScope,instanceId:snapshot.instanceId,epoch:1};
 const reads:unknown[]=[],trashes:ProjectDeleteInput[]=[],examples:ExampleInput[]=[],metadata:ProjectHomeNativeActionMetadata[]=[],opened:string[]=[];
 let ids=100,refreshes=0,allowed=true,openAccepted=false,readOwner:(()=>ProjectHomeNativeActionIdentity|null)|null=null;
 let read:()=>Promise<unknown>=async()=>snapshot;
 let trash:(input:ProjectDeleteInput)=>Promise<unknown>=async input=>projectDeleteResponseSchema.parse({requestId:input.requestId,projectId:input.projectId,projectFile:input.projectFile,trashed:true,records:'retained'});
 let choose:ProjectEntriesDesktopBridge['chooseLocation']=async()=>selection;
 let instantiate:NonNullable<ProjectEntriesDesktopBridge['instantiateTemplate']>=async input=>templateReceipt(input);
 let refresh=async()=>{refreshes++;};
 let ports:ProjectHomeNativeActions|undefined={trash:async input=>{trashes.push(input);return trash(input);},example:{templates:[{id:'timeline-basics',version:1}],bridge:{chooseLocation:input=>choose(input),instantiateTemplate:async input=>{examples.push(input);return instantiate(input);}}}};
 const controller=createProjectHomeNativeActionsController({ports:()=>ports,owner:()=>readOwner?readOwner():owner,canStart:()=>allowed,readDirectory:async()=>{reads.push('GET');return read();},onChange:(_state,next)=>{metadata.push(next);onNativeMetadata?.(next);},onRefresh:()=>refresh(),onOpenCreated:async projectId=>{opened.push(projectId);return openAccepted;},...(onNativeResult?{onOpenNativeResult:onNativeResult}:{}),newRequestId:()=>id(++ids)});controller.activate();
 return {controller,reads,trashes,examples,metadata,opened,get snapshot(){return snapshot;},set snapshot(value){snapshot=value;},get refreshes(){return refreshes;},setOwner(value:ProjectHomeNativeActionIdentity|null){owner=value;},setOwnerReader(value:()=>ProjectHomeNativeActionIdentity|null){readOwner=value;},setAllowed(value:boolean){allowed=value;},setRead(value:typeof read){read=value;},setTrash(value:typeof trash){trash=value;},setChoose(value:typeof choose){choose=value;},setInstantiate(value:typeof instantiate){instantiate=value;},setRefresh(value:typeof refresh){refresh=value;},setOpen(value:boolean){openAccepted=value;},setPorts(value:ProjectHomeNativeActions|undefined){ports=value;}};
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
 const original=f.examples[0]!;assert.equal(f.controller.getState().kind,'example-unknown');assert.equal(f.controller.close(),true);assert.equal(f.controller.getState().dialogHidden,true);assert.deepEqual(f.opened,[]);assert.equal(await f.controller.startExample('Storage','Suggested'),false);
 assert.equal(await f.controller.recheck(),false);assert.equal(f.examples.length,1);assert.equal(f.examples[0],original);assert.equal(f.controller.getMetadata().unknown,true);assert.deepEqual(f.opened,[]);
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
 assert.equal(f.controller.getState().reason,'changed');assert.equal(await f.controller.retryOpen(),false);assert.equal(opens,0);assert.deepEqual(f.opened,[]);assert.equal(f.controller.close(),true);
});

test('automatic opening uses the captured live native authority rather than a stale copy of its own busy prop',async()=>{
 let opens=0;const f=fixture(async()=>{opens++;return true;}),permit=()=>true;
 f.setRefresh(async()=>{f.setAllowed(false);});
 assert.equal(await f.controller.startExample('Storage','Suggested',permit,permit),true);assert.equal(opens,1);assert.equal(f.controller.getState().kind,'idle');assert.equal(f.examples.length,1);
});

test('a permit revoked during the post-ACK refresh preserves creation but cannot authorize opening or an old-permit retry',async()=>{
 let permitted=true,opens=0;
 const f=fixture(async()=>{opens++;return true;}),nativePermit=()=>permitted;
 f.setRefresh(async()=>{permitted=false;});
 assert.equal(await f.controller.startExample('Storage','Suggested',nativePermit,nativePermit),true);
 assert.equal(f.controller.getState().kind,'example-created');assert.equal(f.controller.getState().reason,'changed');assert.ok(f.controller.getState().exampleReceipt);
 assert.equal(f.controller.getMetadata().unknown,false);assert.equal(f.controller.getMetadata().busy,false);assert.equal(opens,0);
 permitted=true;assert.equal(await f.controller.retryOpen(),false,'A revoked operation cannot silently regain opening authority.');
 assert.equal(opens,0);assert.deepEqual(f.opened,[]);assert.equal(f.examples.length,1);assert.equal(f.controller.close(),true);
});

test('a verified ACK across disposal settles known creation without opening or reusing the old native permit',async()=>{
 const gate=held<Awaited<ReturnType<NonNullable<ProjectEntriesDesktopBridge['instantiateTemplate']>>>>();let opens=0;
 const f=fixture(async()=>{opens++;return true;}),nativePermit=()=>true;f.setInstantiate(()=>gate.promise);
 const pending=f.controller.startExample('Storage','Suggested',nativePermit,nativePermit);await new Promise(setImmediate);const original=f.examples[0]!;
 f.controller.dispose();f.controller.activate();gate.resolve(templateReceipt(original));
 assert.equal(await pending,true);assert.equal(f.controller.getState().kind,'example-created');assert.equal(f.controller.getMetadata().unknown,false);assert.equal(f.controller.getMetadata().busy,false);
 assert.equal(f.controller.getState().project,null);assert.equal(f.controller.getState().exampleReceipt,null);assert.equal(opens,0);
 assert.equal(await f.controller.recheck(nativePermit,nativePermit),false);assert.equal(await f.controller.retryOpen(),false);assert.equal(opens,0);
 assert.equal(f.examples.length,1);assert.equal(f.examples[0],original);assert.equal(f.controller.close(),true);
});

test('verified template ACKs after a real owner change are known and closable without leaking an old library project',async()=>{
 for(const change of ['scope','instance','epoch','blocked'] as const){
  const gate=held<Awaited<ReturnType<NonNullable<ProjectEntriesDesktopBridge['instantiateTemplate']>>>>();let opens=0;
  const f=fixture(async()=>{opens++;return true;}),nativePermit=()=>true;f.setInstantiate(()=>gate.promise);
  const pending=f.controller.startExample('Storage','Suggested',nativePermit,nativePermit);await new Promise(setImmediate);const original=f.examples[0]!;
  f.setOwner(change==='blocked'?null:{appLibraryScope:change==='scope'?'b'.repeat(64):f.snapshot.appLibraryScope,instanceId:change==='instance'?id(2):f.snapshot.instanceId,epoch:change==='epoch'?2:1});
  gate.resolve(templateReceipt(original));assert.equal(await pending,true,change);
  assert.equal(f.controller.getState().kind,'example-created',change);assert.equal(f.controller.getState().project,null,change);assert.equal(f.controller.getState().exampleReceipt,null,change);
  assert.equal(f.controller.getMetadata().unknown,false,change);assert.equal(f.controller.getMetadata().busy,false,change);assert.equal(opens,0,change);
  assert.equal(await f.controller.retryOpen(),false,change);assert.equal(await f.controller.recheck(nativePermit,nativePermit),false,change);
  assert.equal(f.examples.length,1,change);assert.equal(f.examples[0],original,change);assert.equal(f.controller.close(),true,change);
 }
});

test('an owner or permit change while automatic opening awaits a refusal or error restores a closable known result',async()=>{
 for(const change of ['owner','permit'] as const)for(const outcome of ['refused','error'] as const){
  const gate=held<boolean>(),calls:{projectId:string;permit:()=>boolean}[]=[];let permitted=true;
  const f=fixture(async(projectId,permit)=>{calls.push({projectId,permit});return gate.promise;}),nativePermit=()=>permitted;
  const pending=f.controller.startExample('Storage','Suggested',nativePermit,nativePermit);await new Promise(setImmediate);
  assert.equal(f.controller.getState().kind,'opening-example',outcome);assert.equal(calls.length,1,outcome);assert.equal(calls[0]!.permit,nativePermit,outcome);
  if(change==='owner')f.setOwner({appLibraryScope:f.snapshot.appLibraryScope,instanceId:id(2),epoch:2});else permitted=false;
  if(outcome==='error')gate.reject(Error('Open unavailable'));else gate.resolve(false);
  assert.equal(await pending,true,outcome);assert.equal(f.controller.getState().kind,'example-created',outcome);
  if(change==='owner'){assert.equal(f.controller.getState().project,null,outcome);assert.equal(f.controller.getState().exampleReceipt,null,outcome);}
  else{assert.ok(f.controller.getState().project,outcome);assert.ok(f.controller.getState().exampleReceipt,outcome);}
  assert.equal(f.controller.getState().reason,'changed',outcome);
  assert.equal(f.controller.getMetadata().busy,false,outcome);assert.equal(f.controller.getMetadata().unknown,false,outcome);
  permitted=true;
  assert.equal(await f.controller.retryOpen(),false,outcome);assert.equal(f.examples.length,1,outcome);assert.equal(calls.length,1,outcome);assert.equal(f.controller.close(),true,outcome);
 }
});

function screenAction(f:ReturnType<typeof fixture>,prepare:()=>Promise<(()=>boolean)|null>,prepareRecheck?:(version:number)=>Promise<(()=>boolean)|null>,onOpen?:(id:string)=>Promise<boolean>){
 const source=readFileSync(new URL('../apps/web/src/ProjectHomeDirectoryScreen.tsx',import.meta.url),'utf8'),start=source.indexOf('  async function nativeAction('),end=source.indexOf('  async function open(',start);assert.ok(start>=0&&end>start);
 const busy:boolean[]=[],env={preparingNative:{current:false},opening:{current:null},active:()=>true,ready:()=>({snapshot:f.snapshot}),canAct:()=>f.controller.getState().kind==='idle',catalogReady:()=>true,rejectNativeStart:(_example:boolean)=>{},form:{current:{dirty:false,busy:false,version:1}},current:{current:{phase:'home',catalogReady:true as boolean|(()=>boolean),onPrepareNativeAction:prepare,onPrepareNativeRecheck:prepareRecheck,onOpen,onRetry:async()=>false,parentGuardsDeparture:Boolean(onOpen)}},lifetime:{current:1},mounted:{current:true},setOpeningBusy:(value:boolean)=>busy.push(value),confirm:async()=>assert.fail('Native consent must not be repeated by the page'),t:(key:string)=>key,locale:'ja',native:f.controller};
 const guardStart=source.indexOf('  const catalogReady ='),guardEnd=source.indexOf('  async function reload(',guardStart);assert.ok(guardStart>=0&&guardEnd>guardStart);
 const guards=lenientFunction('env',`with(env){${source.slice(guardStart,guardEnd)};return {canAct,catalogReady,rejectNativeStart};}`)(env) as {canAct:()=>boolean;catalogReady:()=>boolean;rejectNativeStart:(example:boolean)=>void};
 env.canAct=guards.canAct;env.catalogReady=guards.catalogReady;env.rejectNativeStart=guards.rejectNativeStart;
 const action=lenientFunction('env',`with(env){${source.slice(start,end)};return nativeAction;}`)(env) as (action:'trash'|'example'|'recheck',projectId?:string)=>Promise<void>;
 const openEnd=source.indexOf('  const state = directory.getState()',end);assert.ok(openEnd>end);
 const open=lenientFunction('env',`with(env){${source.slice(end,openEnd)};return open;}`)(env) as (id:string)=>Promise<boolean>;
 return {action,open,env,busy};
}

function screenIdentity(f:ReturnType<typeof fixture>,directory:ProjectEntryDirectoryController){
 const source=readFileSync(new URL('../apps/web/src/ProjectHomeDirectoryScreen.tsx',import.meta.url),'utf8');
 const start=source.indexOf('  function ready()'),end=source.indexOf('  async function reload(',start),scopeStart=source.indexOf('const verifiedScope =');
 assert.ok(start>=0&&end>start&&scopeStart>=0);
 let catalog=true,active=true,parent:{appLibraryScope:string;instanceId:string}|null={appLibraryScope:f.snapshot.appLibraryScope,instanceId:f.snapshot.instanceId};
 const env={directory,active:()=>active,native:f.controller,opening:{current:null},preparingNative:{current:false},form:{current:{busy:false}},current:{current:{summaryScope:f.snapshot.appLibraryScope,catalogReady:()=>catalog,entryIdentity:()=>parent,phase:'home',busy:false}}};
 const owner=lenientFunction('env',`with(env){${source.slice(scopeStart,source.indexOf('\n',scopeStart))}\n${source.slice(start,end)};return {ready,actionOwner,baseCanAct,canAct};}`)(env) as {ready:()=>unknown;actionOwner:()=>ProjectHomeNativeActionIdentity|null;baseCanAct:()=>boolean;canAct:()=>boolean};
 return {...owner,setCatalog(value:boolean){catalog=value;},setParent(value:typeof parent){parent=value;},setActive(value:boolean){active=value;}};
}

test('actual Screen keeps in-flight identity through parent and own directory refresh while forbidding new actions',async()=>{
 for(const window of ['parent-catalog','screen-directory'] as const){
  const acknowledgement=held<Awaited<ReturnType<NonNullable<ProjectEntriesDesktopBridge['instantiateTemplate']>>>>(),directoryReply=held<unknown>(),calls:{projectId:string;permit:()=>boolean}[]=[];
  const f=fixture(async(projectId,permit)=>{calls.push({projectId,permit});return false;});f.setInstantiate(()=>acknowledgement.promise);
  let read=async():Promise<unknown>=>f.snapshot;
  const directory=createProjectEntryDirectoryController({read:()=>read(),expectedScope:()=>f.snapshot.appLibraryScope});directory.activate();assert.equal(await directory.refresh(),true);
  const screen=screenIdentity(f,directory);f.setOwnerReader(screen.actionOwner);
  const verified={appLibraryScope:f.snapshot.appLibraryScope,instanceId:f.snapshot.instanceId,epoch:1};
  assert.deepEqual(screen.actionOwner(),verified);assert.equal(screen.canAct(),true);
  const nativePermit=()=>true,pending=f.controller.startExample('Storage','Suggested',nativePermit,nativePermit);await new Promise(setImmediate);const original=f.examples[0]!;
  assert.equal(screen.baseCanAct(),true);let refresh:Promise<boolean>|null=null;
  if(window==='parent-catalog')screen.setCatalog(false);
  else{read=()=>directoryReply.promise;refresh=directory.refresh();assert.equal(directory.getState().phase,'loading');assert.equal(directory.getState().snapshot,null);assert.equal(screen.ready(),null);}
  assert.deepEqual(screen.actionOwner(),verified,window);assert.equal(screen.baseCanAct(),false,window);assert.equal(screen.canAct(),false,window);
  acknowledgement.resolve(templateReceipt(original));assert.equal(await pending,true,window);
  assert.equal(f.controller.getState().kind,'example-created',window);assert.equal(f.controller.getMetadata().unknown,false,window);assert.equal(f.controller.getMetadata().busy,false,window);
  assert.equal(f.controller.getState().exampleReceipt?.requestId,original.requestId,window);assert.equal(calls.length,1,window);assert.equal(calls[0]!.permit,nativePermit,window);
  assert.equal(f.examples.length,1,window);assert.equal(f.examples[0],original,window);assert.equal(f.controller.close(),true,window);
  if(refresh){directoryReply.resolve(f.snapshot);assert.equal(await refresh,true);}
  screen.setParent(null);assert.equal(screen.actionOwner(),null,'A parent identity refusal remains effective even with a local pin.');
  screen.setParent({appLibraryScope:'b'.repeat(64),instanceId:f.snapshot.instanceId});assert.equal(screen.actionOwner(),null);
  screen.setParent({appLibraryScope:f.snapshot.appLibraryScope,instanceId:id(2)});assert.equal(screen.actionOwner(),null);
  screen.setParent({appLibraryScope:f.snapshot.appLibraryScope,instanceId:f.snapshot.instanceId});screen.setActive(false);assert.equal(screen.actionOwner(),null);
  f.controller.dispose();directory.dispose();
 }
});

function parentScreenFixture(){
 let entry!:ReturnType<typeof createProjectEntryController>,confirmations=0,preparations=0,recheckPreparations=0,legacyWrites=0,consent:boolean|Promise<boolean>=true;
 const granted:(()=>boolean)[]=[],openedPermits:(()=>boolean)[]=[],hostOpens:string[]=[],parentReads:unknown[][]=[];
 const extra={dirty:false,busy:false,unknown:false,identity:[1]};
 const f=fixture(async(projectId,permit)=>{openedPermits.push(permit);return entry.openNativeResult(projectId,permit);},metadata=>entry.reportNativeAction(metadata));
 const context:ProjectWindowContext={version:2,role:'launcher',windowId:id(30),contextId:id(31),backendId:f.snapshot.instanceId,initialProjectId:null,autoOpen:false,editorProjectId:null,editorPhase:'none',editorCount:0,entryMode:null,entryVersion:0,entryReceipt:null,settingsSlot:null,settingsVersion:0,selectionProjectId:null,selectionVersion:0,locatorStatus:null,locatorIntent:null,quitting:false};
 const bridge:ProjectWindowBridge={context:async()=>context,openProject:async projectId=>{hostOpens.push(projectId);return{ok:true,reason:'accepted',targetWindowId:id(90),targetPhase:null};},publishLocatorStatus:async()=>true,requestLocatorAction:async()=>true,requestProjectEntry:async()=>true,showProjects:async()=>true,showSettings:async()=>true,closeSettings:async()=>true,editorStatus:async()=>true,subscribe:()=>()=>{}};
 const identity=projectEntryOwnerFixture(()=>f.snapshot,parentReads);
 entry=createProjectEntryController({context,bridge,identity,readAdditionalSnapshot:()=>extra,confirm:async()=>{confirmations++;return consent;},newToken:()=>id(91),
  client:createLauncherClient(async()=>{legacyWrites++;assert.fail('Home native actions cannot dispatch the legacy create RPC');},{parseCreateInput:value=>value,readDirectory:async()=>f.snapshot})});
 entry.activate();entry.reportCreate({dirty:true,busy:false,version:1});
 const screen=screenAction(f,async()=>{preparations++;const permit=await entry.prepareHomeNativeDeparture();if(permit)granted.push(permit);return permit;},async version=>{recheckPreparations++;return entry.prepareHomeNativeRecheck(version);},id=>entry.open(id));
 // Match the production ProjectEntry refresh callback: interaction observation
 // does not revoke the departure intent or discard the retained draft.
 f.setRefresh(async()=>{entry.interacted();await entry.refresh();});
 return{f,entry,screen,context,extra,parentReads,granted,openedPermits,hostOpens,setConsent(value:boolean|Promise<boolean>){consent=value;},get confirmations(){return confirmations;},get preparations(){return preparations;},get recheckPreparations(){return recheckPreparations;},get legacyWrites(){return legacyWrites;}};
}

test('P3a actual parent and Screen require renewed consent before an exact trash recheck after visibility lifetime changes',async t=>{
 const p=parentScreenFixture(),{f,entry,screen}=p;t.after(()=>{f.controller.dispose();entry.dispose();});
 f.setTrash(async()=>{throw new BrowserRpcError('NETWORK');});await screen.action('trash',projectId);await f.controller.confirmTrash();const original=f.trashes[0]!;
 f.controller.dispose();f.controller.activate();screen.env.lifetime.current++;
 p.setConsent(false);const reads=f.reads.length,parentReads=p.parentReads.length;await screen.action('recheck');
 assert.equal(p.confirmations,2,'The retained unknown needs a new explicit consent');assert.equal(f.reads.length,reads);assert.equal(p.parentReads.length,parentReads);assert.equal(f.trashes.length,1);assert.equal(f.controller.close(),false);assert.equal(entry.readCloseSnapshot().unknown,true);
 p.setConsent(true);f.setTrash(async input=>projectDeleteResponseSchema.parse({requestId:input.requestId,projectId:input.projectId,projectFile:input.projectFile,trashed:true,records:'retained'}));const recheck=screen.action('recheck');await screen.action('recheck');await recheck;
 assert.equal(p.confirmations,3);assert.equal(p.recheckPreparations,2);assert.ok(p.parentReads.length>parentReads);assert.equal(f.trashes.length,2);assert.equal(f.trashes[1],original);assert.equal(f.controller.getState().notice?.kind,'success');assert.equal(entry.readCloseSnapshot().unknown,false);assert.equal(entry.readCloseSnapshot().dirty,true);assert.deepEqual(p.hostOpens,[]);
});

test('P3a renewed consent cannot authorize a late trash recheck after another input, owner or native guard changes',async t=>{
 for(const change of ['page-input','page-lifetime','home-version','native-busy','native-unknown','lease','library'] as const){
  const p=parentScreenFixture(),{f,entry,screen}=p;t.after(()=>{f.controller.dispose();entry.dispose();});
  f.setTrash(async()=>{throw new BrowserRpcError('NETWORK');});await screen.action('trash',projectId);await f.controller.confirmTrash();const original=f.trashes[0]!;
  f.controller.dispose();f.controller.activate();screen.env.lifetime.current++;
  const gate=held<boolean>();p.setConsent(gate.promise);const reads=f.reads.length,pending=screen.action('recheck');await new Promise(setImmediate);assert.equal(p.confirmations,2,change);
  switch(change){
   case'page-input':screen.env.form.current.version++;entry.reportCreate({dirty:true,busy:false,version:2});break;
   case'page-lifetime':screen.env.lifetime.current++;break;
   case'home-version':f.controller.dispose();f.controller.activate();break;
   case'native-busy':p.extra.busy=true;break;
   case'native-unknown':p.extra.unknown=true;break;
   case'lease':entry.updateContext({...p.context,leaseRevoked:true});break;
   case'library':f.snapshot.appLibraryScope='b'.repeat(64);break;
  }
  gate.resolve(true);await pending;assert.equal(f.reads.length,reads,change);assert.equal(f.trashes.length,1,change);assert.equal(f.trashes[0],original,change);assert.equal(f.controller.getMetadata().unknown,true,change);assert.equal(entry.readCloseSnapshot().unknown,true,change);assert.equal(f.controller.close(),false,change);assert.deepEqual(p.hostOpens,[],change);
 }
});

function projectEntryHomeBindings(controller:ReturnType<typeof createProjectEntryController>):{nativeActions:ProjectHomeNativeActions}{
 const source=readFileSync(new URL('../apps/web/src/ProjectEntry.tsx',import.meta.url),'utf8');
 const module:{exports:{default?:(props:{controller:unknown;onSettings:()=>void})=>unknown}}={exports:{}};
 const dependencies:Record<string,unknown>={react:createRequire(new URL('../apps/web/package.json',import.meta.url))('react'),
  './i18n/I18nProvider.tsx':i18nTestModule(),'@mioon/ui/components/button':{Button:'button'},'@mioon/ui/components/dialog':{Dialog:'dialog',DialogContent:'dialog-content',DialogDescription:'dialog-description',DialogTitle:'dialog-title'},
  './ProjectHomeDirectoryScreen.tsx':{__esModule:true,default:'project-home'},'./NativeProjectEntryDialogs.tsx':{NativeProjectEntryDialogs:'native-dialogs'},
  './project-entry-identity.ts':{readProjectEntryIdentity},'./api.ts':{rpc:legacyRpc},'./browser-rpc.ts':{browserRpc}};
 Function('require','module','exports',transformSync(source,{loader:'tsx',format:'cjs',jsx:'transform'}).code)((name:string)=>{assert.ok(Object.hasOwn(dependencies,name),name);return dependencies[name];},module,module.exports);
 const desktop={getState:()=>({capabilities:{ready:true,create:true},busy:false}),readCloseSnapshot:()=>({unknown:false})};
 const tree=module.exports.default!({controller:{...controller,desktop},onSettings(){}});
 const home=(value:unknown):Record<string,unknown>|null=>{if(!value||typeof value!=='object')return null;if(Array.isArray(value)){for(const child of value){const found=home(child);if(found)return found;}return null;}const node=value as {type?:unknown;props?:Record<string,unknown>};return node.type==='project-home'?node.props??null:home(node.props?.children);};
 const bindings=home(tree);assert.ok(bindings);assert.ok(bindings.nativeActions);
 return bindings as {nativeActions:ProjectHomeNativeActions};
}

test('P1 production ProjectEntry trash uses the real client to distinguish definitive 4xx from unknown transport outcomes',async t=>{
 let reply:()=>Promise<Response>=async()=>assert.fail('A response must be supplied');
 const requests:{url:string;method:string|undefined;body:unknown}[]=[];
 t.mock.method(globalThis,'fetch',async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{requests.push({url:String(url),method:init?.method,body:JSON.parse(String(init?.body))});return reply();});
 for(const [code,status,kind,reason] of [['PROJECT_HOST_BUSY',409,'trash-blocked','busy'],['PROJECT_ACCESS_DENIED',403,'trash-blocked','denied'],['REVISION_CONFLICT',409,'idle',null],['PROJECT_TRASH_UNCONFIRMED',409,'trash-unknown',null],['SERVER_ERROR',503,'trash-unknown',null],['NETWORK',0,'trash-unknown',null]] as const){
  const p=parentScreenFixture(),{f,entry}=p;t.after(()=>{f.controller.dispose();entry.dispose();});
  reply=status===0?async()=>{throw Error('Disconnected');}:async()=>new Response(JSON.stringify({ok:false,error:{code,message:'Synthetic rejection',details:{}}}),{status,headers:{'content-type':'application/json'}});
  const bindings=projectEntryHomeBindings(entry);f.setPorts({trash:bindings.nativeActions.trash});
  await f.controller.prepareTrash(projectId);assert.equal(await f.controller.confirmTrash(),false,code);
  assert.equal(f.controller.getState().kind,kind,code);assert.equal(f.controller.getState().reason,reason,code);assert.equal(f.controller.getMetadata().unknown,kind==='trash-unknown',code);
  assert.equal(entry.readCloseSnapshot().unknown,kind==='trash-unknown',code);assert.equal(f.controller.getState().notice?.kind,code==='REVISION_CONFLICT'?'changed':undefined,code);
  assert.deepEqual(p.hostOpens,[],code);assert.equal(requests.at(-1)!.url,'/api/rpc');assert.equal(requests.at(-1)!.method,'POST');
  assert.equal((requests.at(-1)!.body as {operation:string}).operation,'project.delete');
 }
 assert.equal(requests.length,6,'A rejection or network error must not cause an automatic replay');
});


test('actual parent and Screen open a verified template ACK with the original opaque permit and exact input',async t=>{
 const p=parentScreenFixture(),{f,entry,screen}=p;t.after(()=>{f.controller.dispose();entry.dispose();});
 const gate=held<Awaited<ReturnType<NonNullable<ProjectEntriesDesktopBridge['instantiateTemplate']>>>>();f.setInstantiate(()=>gate.promise);
 const pending=screen.action('example');await new Promise(setImmediate);const original=f.examples[0]!;
 assert.equal(f.controller.getState().kind,'working-example');assert.equal(entry.readCloseSnapshot().busy,true);assert.equal(f.controller.close(),false);assert.equal(p.confirmations,1);assert.equal(p.preparations,1);
 const beforePrepare=p.parentReads.length;assert.equal(await entry.prepareHomeNativeDeparture(),null,'A new action remains forbidden by the real parent busy gate');assert.equal(p.parentReads.length,beforePrepare);assert.deepEqual(p.hostOpens,[]);
 const receipt=projectCopyResponseSchema.parse({requestId:original.requestId,sourceProjectId:projectId,project:{projectId:id(60),projectFile:selection.displayPath,fileIdentity:{dev:'1',ino:'60'},name:original.name,lastOpenedAt:null,summary:null},contentSequence:0,contentToken:'a'.repeat(32),versions:0});
 f.snapshot.registered.push({project:receipt.project,availability:{state:'available'},coverUrl:null});gate.resolve(receipt);await pending;
 assert.equal(f.controller.getState().kind,'idle');assert.equal(entry.readCloseSnapshot().unknown,false);assert.equal(entry.readCloseSnapshot().dirty,true);assert.deepEqual(p.hostOpens,[receipt.project.projectId]);
 assert.equal(p.openedPermits[0],p.granted[0],'The original parent WeakSet permit reaches automatic open without a wrapper');assert.equal(p.openedPermits.length,1);assert.equal(p.confirmations,1);assert.equal(p.preparations,1);assert.equal(f.examples.length,1);
 assert.deepEqual(f.examples[0],{token:selection.token,templateId:'timeline-basics',templateVersion:1,name:'Panel name',locale:'ja',requestId:original.requestId});
});

test('without renewed consent actual parent and Screen retain trash unknown after another guard or the original authority expires',async t=>{
 for(const change of ['native-busy','native-unknown','native-input','parent-input','page-input','page-lifetime','visibility','parent-lifetime','lease','context','library','instance','epoch'] as const){
  const p=parentScreenFixture(),{f,entry,screen}=p;t.after(()=>{f.controller.dispose();entry.dispose();});
  screen.env.current.current.onPrepareNativeRecheck=undefined;
  f.setTrash(async()=>{throw new BrowserRpcError('NETWORK');});await screen.action('trash',projectId);await f.controller.confirmTrash();const original=f.trashes[0]!;
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
  assert.equal(f.reads.length,reads,change);assert.equal(p.parentReads.length,parentReads,change);assert.equal(f.trashes.length,1,change);assert.equal(f.trashes[0],original,change);assert.deepEqual(p.hostOpens,[],change);
  assert.equal(f.controller.getState().kind,'trash-unknown',change);assert.equal(f.controller.close(),false,change);assert.equal(entry.readCloseSnapshot().unknown,true,change);assert.equal(p.confirmations,1,change);assert.equal(p.preparations,1,change);
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
  gate.resolve(()=>true);await pending;assert.deepEqual(f.reads,[],change);assert.deepEqual(f.trashes,[]);assert.equal(f.controller.getState().kind,change==='input'?'trash-blocked':'idle');
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

test('known creation without live opening authority is closable and points to recent projects in every locale',async()=>{
 for(const changed of ['owner','permit'] as const){
  const gate=held<Awaited<ReturnType<NonNullable<ProjectEntriesDesktopBridge['instantiateTemplate']>>>>();let allowed=true;
  const f=fixture(),nativePermit=()=>allowed;f.setInstantiate(()=>gate.promise);
  const pending=f.controller.startExample('Storage','Suggested',nativePermit,nativePermit);await new Promise(setImmediate);
  if(changed==='owner')f.setOwner({appLibraryScope:f.snapshot.appLibraryScope,instanceId:id(2),epoch:2});else allowed=false;
  gate.resolve(templateReceipt(f.examples[0]!));assert.equal(await pending,true);
  const state=f.controller.getState();assert.equal(state.kind,'example-created');assert.equal(state.reason,'changed');assert.equal(f.controller.getMetadata().unknown,false);
  for(const locale of LOCALES){const html=view(state,locale);
   assert.ok(html.includes(escapeHtml(translate(locale,'projectHomeNative.example.createdRecent'))),locale);
   assert.ok(tagOf(html,'project-home-native-close'),locale);assert.equal(disabled(tagOf(html,'project-home-native-close')),false,locale);
   assert.equal(tagOf(html,'project-home-example-open'),null,locale);assert.equal(tagOf(html,'project-home-example-refresh'),null,locale);assert.equal(tagOf(html,'project-home-native-recheck'),null,locale);
  }
  assert.equal(await f.controller.retryOpen(),false);assert.equal(f.examples.length,1);assert.deepEqual(f.opened,[]);assert.equal(f.controller.close(),true);
 }
});

test('12-22 confirmation and unknown/result controls render in four languages without inventing capabilities',async()=>{
 const f=fixture();await f.controller.prepareTrash(projectId);const confirm=f.controller.getState();f.setTrash(async()=>{throw new BrowserRpcError('NETWORK');});await f.controller.confirmTrash();const unknown=f.controller.getState();
 for(const locale of LOCALES){const html=view(confirm,locale);assert.ok(html.includes(escapeHtml(translate(locale,'projectHomeNative.trash.title',{name:RECENT_PROJECTS[0]!.name}))));assert.ok(html.includes(escapeHtml(RECENT_PROJECTS[0]!.projectFile)));assert.ok(html.includes(escapeHtml(translate(locale,'projectHomeNative.trash.records'))));assert.ok(tagOf(html,'project-home-trash-confirm'));assert.equal(tagOf(html,'project-home-trash-help'),null);
  const waiting=view(unknown,locale);assert.equal(disabled(tagOf(waiting,'project-home-native-close')),true);assert.ok(tagOf(waiting,'project-home-native-recheck'));assert.equal(tagOf(waiting,'project-home-trash-confirm'),null);assert.ok(waiting.includes(escapeHtml(translate(locale,'projectHomeNative.trash.unknown'))));
 }
});

test('P3b template unknown offers truthful refresh and an enabled close without promising a result recheck in four languages',async()=>{
 const f=fixture();f.setInstantiate(async()=>{throw Object.assign(Error('Unknown'),{code:'PROJECT_ENTRY_OUTCOME_UNKNOWN',status:409,details:{}});});await f.controller.startExample('Storage','Suggested');
 for(const locale of LOCALES){const html=view(f.controller.getState(),locale,{onRefresh:noop});
  assert.equal(disabled(tagOf(html,'project-home-native-close')),false,locale);assert.equal(tagOf(html,'project-home-native-recheck'),null,locale);assert.ok(tagOf(html,'project-home-example-refresh'),locale);
  assert.ok(html.includes(escapeHtml(translate(locale,'projectHomeNative.example.unknown'))),locale);assert.equal(tagOf(html,'project-home-example-open'),null,locale);assert.equal(tagOf(html,'project-home-trash-confirm'),null,locale);
 }
 assert.equal(f.examples.length,1);assert.equal(f.controller.getMetadata().unknown,true);
});

test('P3b closing and refreshing a template unknown retains its exact intent without replaying or opening',async t=>{
 const p=parentScreenFixture(),{f,entry,screen}=p;t.after(()=>{f.controller.dispose();entry.dispose();});
 f.setInstantiate(async()=>{throw Object.assign(Error('Unknown'),{code:'PROJECT_ENTRY_OUTCOME_UNKNOWN',status:409,details:{}});});await screen.action('example');const original=f.examples[0]!;
 assert.equal(f.controller.close(),true);assert.equal(f.controller.getState().dialogHidden,true);assert.equal(f.controller.getState().kind,'example-unknown');assert.equal(entry.readCloseSnapshot().unknown,true);
 assert.equal(await f.controller.refreshExample(),true);await screen.action('recheck');
 assert.equal(f.examples.length,1);assert.equal(f.examples[0],original);assert.deepEqual(p.hostOpens,[]);assert.equal(f.controller.getState().notice,null);assert.equal(f.controller.getState().exampleReceipt,null);assert.equal(entry.readCloseSnapshot().unknown,true);
 f.controller.dispose();f.controller.activate();assert.equal(f.controller.getState().dialogHidden,true);assert.equal(f.controller.getMetadata().unknown,true);assert.equal(await f.controller.startExample('Storage','Suggested'),false);assert.equal(f.examples.length,1);
});

test('P3b a closed template unknown permits an explicit ordinary open while keeping unknown close metadata and blocking new writes',async t=>{
 const p=parentScreenFixture(),{f,entry,screen}=p;t.after(()=>{f.controller.dispose();entry.dispose();});
 f.setInstantiate(async()=>{throw Object.assign(Error('Unknown'),{code:'PROJECT_ENTRY_OUTCOME_UNKNOWN',status:409,details:{}});});await screen.action('example');const original=f.examples[0]!;
 f.controller.close();assert.equal(f.controller.getMetadata().allowOpen,true);assert.equal(entry.readCloseSnapshot().unknown,true);
 assert.equal(await f.controller.refreshExample(),true);assert.equal(await entry.show('new'),false);assert.equal(await entry.create('No extra project',''),false);await screen.action('trash',projectId);await screen.action('example');
 assert.equal(p.legacyWrites,0);assert.deepEqual(f.trashes,[]);assert.equal(f.examples.length,1);assert.equal(f.examples[0],original);
 assert.equal(await screen.open(projectId),true);assert.deepEqual(p.hostOpens,[projectId]);assert.equal(p.confirmations,2,'Explicit ordinary open keeps its own dirty consent');assert.equal(entry.readCloseSnapshot().dirty,true);assert.equal(entry.readCloseSnapshot().unknown,true);assert.equal(f.controller.getState().exampleReceipt,null);assert.equal(f.controller.getState().notice,null);assert.equal(f.examples.length,1);
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
 assert.equal(f.controller.getState().reason,'exists');
 for(const locale of LOCALES){const html=view(f.controller.getState(),locale);assert.ok(html.includes(escapeHtml(translate(locale,'projectHomeNative.example.blockedTitle'))));assert.ok(html.includes(escapeHtml(translate(locale,'projectHomeNative.example.exists'))));assert.ok(!html.includes(escapeHtml(translate(locale,'projectHomeNative.trash.unavailable'))));assert.equal(tagOf(html,'project-home-trash-confirm'),null);}
});

test('Screen reads a live catalog predicate and preserves its false guard without dispatching',async()=>{
 let ready=false,panels=0;
 const f=fixture(),screen=screenAction(f,async()=>{ready=false;await new Promise(setImmediate);ready=true;return()=>true;});
 screen.env.current.current.catalogReady=()=>ready;
 f.setChoose(async()=>{panels++;return null;});
 await screen.action('example');assert.equal(panels,0);assert.deepEqual(f.reads,[]);assert.equal(f.controller.getState().reason,'facts');
 f.controller.close();ready=true;await screen.action('example');assert.equal(panels,1);assert.equal(f.controller.getState().notice?.kind,'example-cancelled');
 assert.deepEqual(f.examples,[]);
});

test('example preparation and revoked pre-write permits leave visible reasons without writes',async()=>{
 for(const [prepare,reason] of [[async()=>null,'confirmation'],[async()=>()=>false,'changed']] as const){
  const f=fixture(),screen=screenAction(f,prepare);await screen.action('example');
  assert.equal(f.controller.getState().kind,'example-blocked');assert.equal(f.controller.getState().reason,reason);assert.deepEqual(f.reads,[]);assert.deepEqual(f.examples,[]);
 }
 for(const stage of ['directory','selection'] as const){
  let allowed=true,panels=0;const gate=held<unknown>(),f=fixture(),screen=screenAction(f,async()=>()=>allowed);
  if(stage==='directory')f.setRead(()=>gate.promise);
  f.setChoose(async()=>{panels++;if(stage==='selection')await gate.promise;return selection;});
  const pending=screen.action('example');await new Promise(setImmediate);allowed=false;gate.resolve(f.snapshot);await pending;
  assert.equal(f.controller.getState().kind,'example-blocked',stage);assert.equal(f.controller.getState().reason,'changed',stage);assert.equal(panels,stage==='selection'?1:0);assert.deepEqual(f.examples,[]);assert.deepEqual(f.opened,[]);
 }
});

test('trash preparation failures stay visible and never dispatch a destructive request',async()=>{
 for(const [prepare,reason] of [[async()=>null,'confirmation'],[async()=>()=>false,'changed']] as const){
  const f=fixture(),screen=screenAction(f,prepare);await screen.action('trash',projectId);
  assert.equal(f.controller.getState().kind,'trash-blocked');assert.equal(f.controller.getState().reason,reason);assert.deepEqual(f.reads,[]);assert.deepEqual(f.trashes,[]);
  for(const locale of LOCALES)assert.ok(view(f.controller.getState(),locale).includes(escapeHtml(translate(locale,reason==='confirmation'?'projectHomeNative.trash.confirmation':'projectHomeNative.trash.preparationChanged'))));
 }
 const f=fixture();f.setAllowed(false);assert.equal(await f.controller.prepareTrash(projectId),false);assert.equal(f.controller.getState().kind,'trash-blocked');assert.equal(f.controller.getState().reason,'facts');assert.deepEqual(f.reads,[]);assert.deepEqual(f.trashes,[]);
});

test('example rejections and cancellation render their safe specific feedback in every locale',async()=>{
 const keys={facts:'projectHomeNative.example.facts',changed:'projectHomeNative.example.changed',confirmation:'projectHomeNative.example.confirmation',exists:'projectHomeNative.example.exists',busy:'projectHomeNative.example.busy',denied:'projectHomeNative.example.denied'} as const;
 for(const [reason,key] of Object.entries(keys)){
  const f=fixture();f.controller.rejectPreparation(true,reason as keyof typeof keys);
  for(const locale of LOCALES){const html=view(f.controller.getState(),locale,{onHelpAccess:noop});assert.ok(html.includes(escapeHtml(translate(locale,key))));assert.equal(Boolean(tagOf(html,'project-home-example-help')),reason==='denied');}
 }
 const f=fixture();f.setChoose(async()=>null);await f.controller.startExample('Storage','Suggested');
 for(const locale of LOCALES)assert.ok(view(f.controller.getState(),locale).includes(escapeHtml(translate(locale,'projectHomeNative.example.cancelled'))));
});

test('P2 the real template adapter keeps pre-write unavailable and expired definitive and requests a new selection',async t=>{
 for(const code of ['PROJECT_ENTRY_UNAVAILABLE','PROJECT_ENTRY_TICKET_EXPIRED'])await t.test(code,async()=>{
 let calls=0;const bridge=readProjectEntryDesktopClient({__mioonProjectEntries:{capabilities:async()=>assert.fail('Capabilities are already verified by the entry owner'),chooseLocation:async()=>selection,instantiateTemplate:async()=>{calls++;throw{code,status:409,details:{}};}}});assert.ok(bridge);
 const f=fixture();f.setPorts({example:{bridge,templates:[{id:'timeline-basics',version:1}]}});assert.equal(await f.controller.startExample('Storage','Suggested'),false);
 assert.equal(calls,1);assert.equal(f.controller.getState().kind,'example-blocked');assert.equal(f.controller.getState().reason,'selection');assert.equal(f.controller.getMetadata().unknown,false);assert.deepEqual(f.opened,[]);
 for(const locale of LOCALES){const html=view(f.controller.getState(),locale);assert.ok(html.includes(escapeHtml(translate(locale,'projectHomeNative.example.selectAgain'))));assert.equal(tagOf(html,'project-home-native-recheck'),null);assert.equal(disabled(tagOf(html,'project-home-native-close')),false);}
 assert.equal(f.controller.close(),true);assert.equal(calls,1);
 });
});
