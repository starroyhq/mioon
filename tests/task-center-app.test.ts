import type {TaskMethods, DraftOwner, TaskPaneState, RequestState, FakeTaskController, GenerationApproval} from './helpers/strict-task-app-types.ts';
import { createI18nTestContext, message } from './helpers/i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {captureTaskWorkspaceIntent, navigateTaskShot} from '../apps/web/src/task-workspace-intent.ts';
import {findGenerationProvider, generationProviderForModel, generationProviderIdentity, generationParameters} from '../apps/web/src/generation-settings.ts';
import {parseVideoBinding, videoBindingCapabilities} from '../packages/contracts/src/video-providers.ts';
import {IMAGE_FIXED_OPTIONS,IMAGE_MODELS} from '@mioon/contracts';
import {parseAgentTaskRecoveryLocation,resolveAgentTaskRecoveryLocation} from '../apps/web/src/agent-task-recovery-location.ts';
import {createSubtitleController} from '../apps/web/src/subtitle-state.ts';

import { lenientFunction } from './helpers/eval-source.ts';
const Function = lenientFunction;
const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
function section(start: string, end: string) { const a=app.indexOf(start),b=app.indexOf(end,a);assert.ok(a>=0&&b>a);return app.slice(a,b); }
const bridge=section('  function readTaskRevealContext()', '  async function openAgentRequests(')+section('  function inspectTaskJob(', '  function openExportHistory()');
const agentBridge=section('  async function openAgentRequests(', '  function inspectTaskJob(');
const runBody=section('  async function runDurable(', '  async function recoverTask(');
const recoverBody=section('  async function recoverTask(', '  async function adoptLegacyTask(');
const make=(code: string,deps: Record<string, unknown>,names: readonly string[]): TaskMethods =>Function(...Object.keys(deps),`${code}\nreturn {${names.join(',')}};`)(...Object.values(deps)) as TaskMethods;
const gate=()=>{let resolve!: (value?: unknown) => void;const promise=new Promise<unknown>(r=>{resolve=r;});return {promise,resolve};};
const projectId='11111111-1111-4111-8111-111111111111',shotId='22222222-2222-4222-8222-222222222222',jobId='33333333-3333-4333-8333-333333333333';
function harness() {
 const state: TaskPaneState={projectReady:true,selectedTaskId:undefined,overlay:'tasks',dock:'properties',page:'subtitle',mode:'editing',confirm:[],reveal:[],notice:[],auth:[],refresh:[],ack:[],busy:[],draft:{name:'unsaved',startFrame:7}};
 const refs={importSession:{current:{active:true}},viewReady:{current:true},taskWorkspaceState:{current:{visible:true,connected:true}},currentProject:{current:projectId as string | null},projectEpoch:{current:2},navigationEpoch:{current:3},panelIntent:{current:4},workspaceRef:{current:{id:'original'}},taskShotAttempt:{current:0},dataRef:{current:{project:{id:projectId},jobs:[{id:jobId,shotId,projectId,status:'succeeded'}],shots:[{id:shotId,projectId}],timelineHistory:{revision:1}}}};
 const deps={message,msg:message,...createI18nTestContext(),...refs,clipConnectionBlocked:{current:false},clipDraftRef:{current:null},markPanelIntent:()=>refs.panelIntent.current++,setSelectedTaskId:(value?: string)=>{state.selectedTaskId=value;},setShowDelivery:(value: boolean)=>{if(value)state.overlay='delivery';else if(state.overlay==='delivery')state.overlay=null;},setShowImage:(value: boolean)=>{if(value)state.overlay='image';else if(state.overlay==='image')state.overlay=null;},setShowTasks:(value: boolean)=>{if(value){state.overlay='tasks';state.reveal.push(['tasks',true]);}else if(state.overlay==='tasks')state.overlay=null;},projectSessionReady:()=>state.projectReady,captureTaskWorkspaceIntent,navigateTaskShot,workspaceOriginScope:(w: {id: string})=>w.id,
  guardNavigation:async(message: unknown,extra: unknown,canDiscard: () => boolean)=>{state.confirm.push({message,extra,canDiscard});return canDiscard();},
  setRightDockTab:(value: string|((arg0: string) => string))=>{state.dock=typeof value==='function'?value(state.dock):value;},setPropertiesPage:(value: string)=>{state.page=value;},
  setPanelOpen:(...args: [string, ...unknown[]])=>{state.reveal.push(args);refs.panelIntent.current++;},updateView:(section: string,value: string)=>{state.reveal.push([section,value]);if(section==='activeMode')state.mode=value;},
  context:()=>({projectId:refs.currentProject.current,epoch:refs.navigationEpoch.current}),isCurrent:(c: { projectId: string; epoch: number; })=>c.projectId===refs.currentProject.current&&c.epoch===refs.navigationEpoch.current,
  readableError:(e: Error)=>e.message,isBusy:()=>false,markBusy:(...args: unknown[])=>state.busy.push(args),pendingForProject:()=>[],
  requestCounter:{current:0},setData:(fn: (arg0: { project: { id: string; }; jobs: { id: string; shotId: string; projectId: string; status: string; }[]; shots: { id: string; projectId: string; }[]; timelineHistory: { revision: number; }; }) => { project: { id: string; }; jobs: { id: string; shotId: string; projectId: string; status: string; }[]; shots: { id: string; projectId: string; }[]; timelineHistory: { revision: number; }; })=>{refs.dataRef.current=fn(refs.dataRef.current);},notify:(...args: unknown[])=>state.notice.push(args),
  refresh:async (id: unknown)=>state.refresh.push(id),setAuth:(value: unknown)=>state.auth.push(value),setSubjectRefresh:()=>{},timelineFormatRef:{current:null},subtitlesRef:{current:null as {controller: DraftOwner} | null},
  tasksRef:{current:{submit:async()=>{throw Error('Set explicit submit fixture');},acknowledge:async (task: unknown)=>state.ack.push(task),recover:async()=>{throw Error('Set explicit recovery fixture');}} as FakeTaskController}};
 const methods=make(bridge+runBody+recoverBody,deps,['readTaskRevealContext','readTaskViewContext','captureTaskView','openTasks','inspectTaskJob','runDurable','recoverTask']);
 return {state,refs,deps,...methods,remake:()=>make(bridge+runBody+recoverBody,deps,['inspectTaskJob'])};
}

test('actual Tasks entry reveals its overlay without changing the dock, drafts or business state',()=>{
 const h=harness(),before=structuredClone(h.state.draft);h.state.dock='delivery';assert.equal(h.openTasks(undefined,jobId),true);assert.equal(h.state.selectedTaskId,jobId);
 assert.equal(h.state.dock,'delivery');assert.equal(h.state.overlay,'tasks');assert.deepEqual(h.state.reveal,[['tasks',true]]);assert.deepEqual(h.state.draft,before);assert.equal(h.state.confirm.length,0);assert.equal(h.state.ack.length,0);
 const n=h.state.reveal.length;assert.equal(h.openTasks(()=>false,'obsolete-job'),false);assert.equal(h.state.reveal.length,n);assert.equal(h.state.selectedTaskId,jobId);
});
test('actual Tasks view capture is separate from a generic delayed reveal capture',()=>{
 const h=harness();h.refs.taskWorkspaceState.current.visible=false;
 assert.equal(h.captureTaskView(),null);assert.equal((captureTaskWorkspaceIntent)!(h.readTaskRevealContext)!(),true);
 h.refs.taskWorkspaceState.current.connected=false;assert.equal(captureTaskWorkspaceIntent(h.readTaskRevealContext),null);
});

function agentRequestHarness({kind='image',identity='task',holdAt=null}: {kind?: string; identity?: string; holdAt?: string | null}={}) {
 const sourceId='44444444-4444-4444-8444-444444444444',groupId='55555555-5555-4555-8555-555555555555',requestId='66666666-6666-4666-8666-666666666666',at='2026-10-22T00:00:00.000Z';
 const state: RequestState={ready:true,nativeAllowed:true,nativeUnknown:false,composing:false,accept:true,guardCalls:0,discards:0,reads:[],effects:[],notices:[],recovery:null,draft:{text:'Keep my manual draft',inFrame:12,outFrame:88}},entered=gate(),release=gate();
 const clipCapture={};
 const refs={currentProject:{current:projectId as string | null},projectEpoch:{current:2},navigationEpoch:{current:3},panelIntent:{current:4},viewRef:{current:{activeMode:'canvas'}},viewReady:{current:true},taskWorkspaceState:{current:{connected:true}},workspaceRef:{current:'original'},shotTextRef:{current:null as DraftOwner | null},subtitlesRef:{current:null as {controller: DraftOwner} | null},clipDraftRef:{current:({hasPendingComposition:()=>state.composing,capture:()=>clipCapture,isCurrent:(token: {})=>token===clipCapture} as DraftOwner | null)},document:{visibilityState:'visible'}};
 const task=kind==='image'?{id:jobId,projectId,groupId,requestId,name:'Saved image',prompt:'Saved prompt',providerId:'mock',model:IMAGE_MODELS.mock,options:{...IMAGE_FIXED_OPTIONS},state:'local_result_error',revision:3,dispatched:true,versionId:null,errorCode:'LOCAL_RESULT_ERROR',createdAt:at,updatedAt:at}:{id:jobId,projectId,requestId,sourceAssetId:sourceId,sourceHash:'a'.repeat(64),sourceFrame:30,fps:30,profileId:'local-png-1024-v1',state:'interrupted',revision:3,started:true,result:null,errorCode:'INTERRUPTED',createdAt:at,updatedAt:at};
 const deps={...refs,restored:false,loading:false,online:true,auth:true,nativeWindow:true,data:{project:{id:projectId}},dataRef:{current:{assets:[{id:sourceId,projectId,sha256:'a'.repeat(64),mimeType:'video/mp4'}]}},parseAgentTaskRecoveryLocation,resolveAgentTaskRecoveryLocation,
  projectSessionReady:()=>state.ready,readEditorWindowInputs:(navigation: unknown)=>{assert.equal(navigation,true);return {busy:!state.nativeAllowed,unknown:state.nativeUnknown};},context:()=>({projectId:refs.currentProject.current,epoch:refs.navigationEpoch.current,workspace:refs.workspaceRef.current}),isCurrent:(value: { projectId: string; epoch: number; workspace: string; })=>value.projectId===refs.currentProject.current&&value.epoch===refs.navigationEpoch.current&&value.workspace===refs.workspaceRef.current,
  guardNavigation:async(_message: unknown,_extra: unknown,current: () => boolean)=>{state.guardCalls++;if(holdAt==='guard'){(entered.resolve)!();await release.promise;}if(!state.accept||!current())return false;state.discards++;return true;},msg:message,
  rpc:async(operation: string,input: Record<string, unknown>)=>{state.reads.push({operation,input});if(holdAt==='read'){(entered.resolve)!();await release.promise;}if(state.throwRead)throw Error('PRIVATE_READ_FAILURE');if(operation.endsWith('request.get'))return {projectId,requestId,operation:kind==='image'?'image.generate':'frame.extract',response:{...task,state:'queued',revision:1,...(kind==='image'?{dispatched:false}:{started:false}),errorCode:null}};return task;},
  notify:(...args: unknown[])=>state.notices.push(args),markPanelIntent:()=>refs.panelIntent.current++,requestId:()=> 'fixed-reveal-click',setAgentRecovery:(value: RequestState["recovery"])=>{state.recovery=value;},
  openTasks:(current: () => boolean,selection: string)=>{if(refs.clipDraftRef.current?.hasPendingComposition()||!current()||!refs.currentProject.current||!refs.viewReady.current)return false;state.effects.push(['tasks',selection]);return true;},
  setShowTasks:(value: boolean)=>state.effects.push(['tasks',value]),setShowDelivery:(value: boolean)=>state.effects.push(['delivery',value]),setShowImage:(value: boolean)=>state.effects.push(['image',value]),setPropertiesPage:(value: string)=>state.effects.push(['properties',value]),setRightDockTab:(value: string)=>state.effects.push(['dock',value]),setPanelOpen:(...args: unknown[])=>{state.effects.push(['panel',...args]);refs.panelIntent.current++;},updateView:(section: string,value: string)=>{state.effects.push([section,value]);if(section==='activeMode')refs.viewRef.current.activeMode=value;},
 };
 const remake=()=>make(agentBridge,deps,['openAgentRequests']).openAgentRequests;
 return {state,refs,deps,entered,release,remake,open:remake(),selection:`${kind}${identity==='request'?'-request':''}:${identity==='request'?requestId:jobId}`};
}
function originalRequestDraftOwner(h: ReturnType<typeof agentRequestHarness>, kind: string) {
 let version=0,state={draft:{text:'Saved input'},dirty:false};
 const controller={capture:()=>({version}),isCurrent:(token: { version: number; })=>token.version===version,getState:()=>state,hasPendingComposition:()=>false};
 const install=(next: DraftOwner | null)=>{if(kind==='shot')h.refs.shotTextRef.current=next;else if(kind==='clip')h.refs.clipDraftRef.current=next;else h.refs.subtitlesRef.current=next?{controller:next}:null;};
 install(controller);
 return {controller,install,edit(text: string){version++;state={draft:{text},dirty:true};},dispose(){version++;},getState:()=>state};
}
for(const kind of ['image','frame'])for(const input of ['shot','clip','subtitle'])for(const change of ['edit','edit-back','owner'])test(`Mio ${kind} lookup rejects a new ordinary ${input} ${change} after confirmation`,async()=>{
 const h=agentRequestHarness({kind,holdAt:'read'}),draft=originalRequestDraftOwner(h,input),pending=h.open(h.selection);await h.entered.promise;
 draft.edit('Typed after confirmation');if(change==='edit-back')draft.edit('Saved input');if(change==='owner')draft.install({...draft.controller});
 const retained=draft.getState();(h.release.resolve)!();assert.equal(await pending,false);assert.equal(h.state.discards,1);assert.equal(h.state.reads.length,1);assert.deepEqual((h.state.effects as unknown),[]);assert.deepEqual((h.state.notices as unknown),[]);assert.equal(h.state.recovery,null);assert.equal(draft.getState(),retained,'a late lookup neither discards nor alters the new ordinary input');
});
for(const input of ['shot','clip','subtitle'])test(`Mio lookup captures the ${input} owner after the approved discard`,async()=>{
 const h=agentRequestHarness({kind:'frame'}),draft=originalRequestDraftOwner(h,input),guard=h.deps.guardNavigation;draft.edit('Old confirmed input');
 h.deps.guardNavigation=async(...args: Parameters<typeof guard>)=>{const allowed=await guard(...args);if(allowed)draft.edit('Discarded baseline');return allowed;};
 assert.equal(await h.remake()(h.selection),true);assert.equal((h.state.recovery)!.current(),true);assert.equal(draft.getState().draft.text,'Discarded baseline');
});
for(const input of ['shot','clip','subtitle'])test(`Mio image recovery intent rejects new ${input} input while its owner remains mounted`,async()=>{
 const h=agentRequestHarness(),draft=originalRequestDraftOwner(h,input);assert.equal(await h.open(h.selection),true);assert.equal((h.state.recovery)!.current(),true);
 draft.edit('New input before image lookup');assert.equal((h.state.recovery)!.current(),false);assert.equal(draft.getState().draft.text,'New input before image lookup');
});
for(const input of ['shot','clip'])test(`Mio frame recovery intent survives its own expected ${input} form unmount`,async()=>{
 const h=agentRequestHarness({kind:'frame'}),draft=originalRequestDraftOwner(h,input),subtitle=originalRequestDraftOwner(h,'subtitle');
 assert.equal(await h.open(h.selection),true);draft.dispose();draft.install(null);assert.equal((h.state.recovery)!.current(),true,'the legal frame navigation must not invalidate itself by disposing its old form');
 subtitle.edit('Retained App subtitle');assert.equal((h.state.recovery)!.current(),false);assert.equal(subtitle.getState().draft.text,'Retained App subtitle');
});
test('the App-owned subtitle controller preserves ordinary input when frame navigation hides its page',()=>{
 const timeline={id:jobId,projectId,revision:1,durationFrames:90,fps:30,subtitles:{profileId:'bottom_cjk_v1',cues:[{id:shotId,text:'Saved',startFrame:0,durationFrames:30}]}},scope=`${projectId}:2`;
 const controller=createSubtitleController({submit:async()=>{throw Error('The retained subtitle must not submit');}} as unknown as Parameters<typeof createSubtitleController>[0]);controller.setContext({scope,projectId,timeline,connected:true,pending:false});controller.setVisible(true);assert.equal(controller.select(shotId),true);assert.equal(controller.edit('text','Retained subtitle'),true);
 const draft=controller.getState();controller.setVisible(false);controller.setContext({scope,projectId,timeline,connected:true,pending:false});assert.equal(controller.getState(),draft);assert.equal((controller.getState().draft)!.text,'Retained subtitle');assert.equal(controller.hasUnsaved(),true);controller.dispose();
 assert.match(app,/const subtitles = useSubtitles\(/);assert.match(app,/scope: `\$\{projectId\}:\$\{projectEpoch\.current\}`/);
});
for(const kind of ['image','frame'])for(const identity of ['task','request'])test(`Mio ${kind} ${identity} reveal reads only the exact original record and preserves manual input`,async()=>{
 const h=agentRequestHarness({kind,identity}),before=structuredClone(h.state.draft);assert.equal(await h.open(h.selection),true);assert.deepEqual(h.state.reads.map(item=>item.operation),identity==='request'?[`${kind}.request.get`,`${kind}.task.get`]:[`${kind}.task.get`]);assert.ok(h.state.reads.every(item=>item.input.projectId===projectId));assert.equal((h.state.recovery)!.projectId,projectId);assert.equal((h.state.recovery)!.taskId,jobId);assert.equal((h.state.recovery)!.current(),true);assert.deepEqual(h.state.draft,before);assert.ok(h.state.effects.some(item=>item[0]==='image'&&item[1]===(kind==='image')));
 if(kind==='frame'){assert.deepEqual(h.state.effects.find(item=>item[0]==='editing'),['editing',{quickAssetId:'44444444-4444-4444-8444-444444444444',selectedClipId:null,previewKind:'source'}]);assert.ok(h.state.effects.some(item=>item[0]==='dock'&&item[1]==='properties'));}else assert.ok(!h.state.effects.some(item=>['dock','editing','properties','panel'].includes(item[0])));
 h.state.composing=true;assert.equal((h.state.recovery)!.current(),false,'an already delivered intent loses navigation authority when IME begins');
});
test('Mio original-request reveal rejects malformed namespaces and retains ordinary Tasks admission',async()=>{
 const h=agentRequestHarness();for(const value of ['image:https://private.invalid','frame-request:not-a-uuid'])assert.equal(await h.open(value),false);assert.deepEqual((h.state.reads as unknown),[]);assert.deepEqual((h.state.effects as unknown),[]);
 assert.equal(await h.open(jobId),true);assert.deepEqual(h.state.effects,[['tasks',jobId]]);h.state.effects=[];h.refs.currentProject.current='other';assert.equal(await h.open(jobId),false);h.refs.currentProject.current=projectId;h.state.composing=true;assert.equal(await h.open(jobId),false);h.state.composing=false;h.refs.viewReady.current=false;assert.equal(await h.open(jobId),false);assert.deepEqual((h.state.effects as unknown),[]);
});
for(const admission of ['restored','loading','offline','auth','project','ready','view','connected','IME','retained','retained-unknown'])test(`Mio original-request reveal rejects ${admission} before lookup or navigation`,async()=>{
 const h=agentRequestHarness();if(['restored','loading'].includes(admission))(h.deps as unknown as Record<string, unknown>)[admission]=true;if(admission==='offline')h.deps.online=false;if(admission==='auth')h.deps.auth=false;if(admission==='project')h.refs.currentProject.current=null;if(admission==='ready')h.state.ready=false;if(admission==='view')h.refs.viewReady.current=false;if(admission==='connected')h.refs.taskWorkspaceState.current.connected=false;if(admission==='IME')h.state.composing=true;if(admission==='retained')h.state.nativeAllowed=false;if(admission==='retained-unknown')h.state.nativeUnknown=true;
 assert.equal(await h.remake()(h.selection),false);assert.equal(h.state.guardCalls,0);assert.deepEqual((h.state.reads as unknown),[]);assert.deepEqual((h.state.effects as unknown),[]);assert.equal(h.state.recovery,null);
});
for(const phase of ['guard','read'])for(const change of ['project','projectEpoch','workspace','navigation','panel','mode','hidden','view','ready','connected','IME','retained','retained-unknown'])test(`Mio original-request reveal ignores ${change} during ${phase}`,async()=>{
 const h=agentRequestHarness({kind:'frame',holdAt:phase}),before=structuredClone(h.state.draft),pending=h.open(h.selection);await h.entered.promise;
 if(change==='project')h.refs.currentProject.current='other';if(change==='projectEpoch')h.refs.projectEpoch.current++;if(change==='workspace')h.refs.workspaceRef.current='restored';if(change==='navigation')h.refs.navigationEpoch.current++;if(change==='panel')h.refs.panelIntent.current++;if(change==='mode')h.refs.viewRef.current.activeMode='editing';if(change==='hidden')h.refs.document.visibilityState='hidden';if(change==='view')h.refs.viewReady.current=false;if(change==='ready')h.state.ready=false;if(change==='connected')h.refs.taskWorkspaceState.current.connected=false;if(change==='IME')h.state.composing=true;if(change==='retained')h.state.nativeAllowed=false;if(change==='retained-unknown')h.state.nativeUnknown=true;
 (h.release.resolve)!();assert.equal(await pending,false);assert.equal(h.state.discards,phase==='guard'?0:1);assert.equal(h.state.reads.length,phase==='guard'?0:1);assert.deepEqual((h.state.effects as unknown),[]);assert.deepEqual((h.state.notices as unknown),[]);assert.equal(h.state.recovery,null);assert.deepEqual(h.state.draft,before);
});
test('Mio frame reveal requires the original project-local source hash and keeps failure diagnostics private',async()=>{
 for(const invalid of ['project','hash','missing']){const h=agentRequestHarness({kind:'frame'});if(invalid==='missing')h.deps.dataRef.current.assets=[];else h.deps.dataRef.current.assets[0][invalid==='project'?'projectId':'sha256']='wrong';assert.equal(await h.open(h.selection),false);assert.deepEqual((h.state.effects as unknown),[]);assert.equal(h.state.recovery,null);assert.equal(h.state.notices.length,1);}
 const h=agentRequestHarness();h.state.throwRead=true;assert.equal(await h.open(h.selection),false);assert.deepEqual((h.state.effects as unknown),[]);assert.equal(h.state.notices.length,1);assert.doesNotMatch(JSON.stringify(h.state.notices),/PRIVATE_READ_FAILURE/);
});
test('a retained disconnected clip blocks durable dispatch and recovery before touching task state', async () => {
 const h=harness();h.deps.clipConnectionBlocked.current=true;
 assert.equal(await h.runDurable('timeline:mutation','timeline.track.update',{projectId}),null);
 assert.equal(await h.recoverTask({id:'task',projectId},false,()=>true),null);
 assert.deepEqual((h.state.busy as unknown),[]);assert.deepEqual((h.state.ack as unknown),[]);assert.deepEqual((h.state.refresh as unknown),[]);assert.deepEqual((h.state.notice as unknown),[]);
});
test('actual view-shot bridge reaches Properties and the fixed shot without using the old async inspect path',async()=>{
 const h=harness();assert.equal(await h.inspectTaskJob(h.refs.dataRef.current.jobs[0],()=>true),true);
 assert.equal(h.state.dock,'properties');assert.equal(h.state.page,'inspector');assert.equal(h.state.mode,'canvas');
 assert.deepEqual(h.state.reveal[0],['canvas',{selectedId:shotId,inspectorTab:'versions',highlightedVersionId:null}]);
 assert.equal(h.state.confirm.length,1);assert.equal(h.state.confirm[0].extra,false);assert.deepEqual(h.state.reveal.at(-1),['inspector',true,'canvas']);
});
for(const change of ['cancel','hidden','panel','project','workspace','job','shot','reboundJob'])test(`actual Tasks target guard preserves inputs when ${change} occurs during confirmation`,async()=>{
 const h=harness(),entered=gate(),release=gate();let discard=0;const before=structuredClone(h.state.draft);
 h.deps.guardNavigation=async(_message: unknown,_extra: unknown,canDiscard: () => boolean)=>{(entered.resolve)!();await release.promise;if(change==='cancel'||!canDiscard())return false;discard++;return true;};
 const {inspectTaskJob}=h.remake();const pending=inspectTaskJob(h.refs.dataRef.current.jobs[0],()=>h.refs.taskWorkspaceState.current.visible);await entered.promise;
 if(change==='hidden')h.refs.taskWorkspaceState.current.visible=false;
 if(change==='panel')h.refs.panelIntent.current++;
 if(change==='project')h.refs.projectEpoch.current++;
 if(change==='workspace')h.refs.workspaceRef.current={id:'restored'};
 if(change==='job')h.refs.dataRef.current.jobs=[];
 if(change==='shot')h.refs.dataRef.current.shots=[];
 if(change==='reboundJob')h.refs.dataRef.current.jobs[0].shotId='other';
 (release.resolve)!();assert.equal(await pending,false);assert.equal(discard,0);assert.equal(h.state.reveal.length,0);assert.deepEqual(h.state.draft,before);
});
test('actual newer Tasks shot choice invalidates earlier pending confirmation before discard',async()=>{
 const h=harness(),gates=[gate(),gate()],entered=[gate(),gate()];let calls=0,discard=0;
 const otherShot='44444444-4444-4444-8444-444444444444',otherJob={id:'55555555-5555-4555-8555-555555555555',shotId:otherShot,projectId,status:'failed'};
 h.refs.dataRef.current.jobs.push(otherJob);h.refs.dataRef.current.shots.push({id:otherShot,projectId});
 h.deps.guardNavigation=async(_message: unknown,_extra: unknown,current: () => boolean)=>{const i=calls++;(entered[i].resolve)!();await gates[i].promise;if(!current())return false;discard++;return true;};
 const {inspectTaskJob}=h.remake(),first=inspectTaskJob(h.refs.dataRef.current.jobs[0],()=>true);await entered[0].promise;
 const second=inspectTaskJob(otherJob,()=>true);await entered[1].promise;(gates[0].resolve)!();assert.equal(await first,false);assert.equal(discard,0);
 (gates[1].resolve)!();assert.equal(await second,true);assert.equal(discard,1);assert.equal((h.state.reveal[0][1] as {selectedId: string}).selectedId,otherShot);
});
for(const operation of ['timeline.format.set','timeline.subtitle.add','subject.create'])test(`direct ${operation} runner cannot steal the dock after a delayed unknown result`,async()=>{
 const h=harness(),entered=gate(),release=gate(),input={projectId,requestId:'original-fixed-request'};
 h.deps.tasksRef.current.submit=async (args: { input: unknown; })=>{assert.equal(args.input,input);(entered.resolve)!();await release.promise;return {task:{status:'unknown',input,projectId}};};
 const pending=h.runDurable('lane',operation,input);await entered.promise;h.refs.panelIntent.current++;h.state.dock='agent';(release.resolve)!();
 assert.equal(await pending,null);assert.equal(h.state.dock,'agent');assert.equal(h.state.reveal.length,0);assert.equal(input.requestId,'original-fixed-request');
});
test('delayed unknown still reveals Tasks when the original view choice is current',async()=>{
 const h=harness();h.state.dock='properties';h.deps.tasksRef.current.submit=async()=>({task:{status:'unknown'}});
 assert.equal(await h.runDurable('lane','timeline.track.update',{projectId}),null);assert.equal(h.state.dock,'properties');assert.equal(h.state.overlay,'tasks');assert.equal(h.state.reveal.length,1);
});
test('already accepted exact result still acknowledges and refreshes after the user leaves Tasks',async()=>{
 const h=harness(),entered=gate(),release=gate(),task={id:'task',projectId,status:'applied',requestId:'original-key'},result={revision:12};
 h.deps.tasksRef.current.submit=async()=>{(entered.resolve)!();await release.promise;return {task,result};};
 const pending=h.runDurable('lane','timeline.track.update',{projectId,requestId:task.requestId});await entered.promise;h.refs.panelIntent.current++;h.state.dock='delivery';(release.resolve)!();
 assert.deepEqual(await pending,result);assert.deepEqual(h.state.ack,[task]);assert.deepEqual(h.state.refresh,[projectId]);assert.equal(h.state.dock,'delivery');assert.equal(h.state.reveal.length,0);
});
test('Tasks recovery lookup loses execution and notice authority when the pane hides',async()=>{
 const h=harness(),entered=gate(),release=gate();let current=true,executions=0;
 h.deps.tasksRef.current.recover=async(task,{canExecute})=>{(entered.resolve)!();await release.promise;if(canExecute())executions++;return {task:{...task,status:'unknown'}};};
 const pending=h.recoverTask({id:'task',projectId},false,()=>current);await entered.promise;current=false;(release.resolve)!();await pending;
 assert.equal(executions,0);assert.equal(h.state.notice.length,0);assert.equal(h.state.ack.length,0);assert.equal(h.state.busy.at(-1)![2],false);
});
test('Tasks recovery handles an applied receipt after hiding without rewriting drafts or opening panels',async()=>{
 const h=harness(),entered=gate(),release=gate(),task={id:'task',projectId,status:'applied',requestId:'fixed-key',lane:'timeline:mutation'},draft=structuredClone(h.state.draft);let current=true;
 h.deps.tasksRef.current.recover=async()=>{(entered.resolve)!();await release.promise;return {task};};
 const pending=h.recoverTask(task,false,()=>current);await entered.promise;current=false;(release.resolve)!();await pending;
 assert.deepEqual(h.state.ack,[task]);assert.deepEqual(h.state.refresh,[projectId]);assert.deepEqual(h.state.draft,draft);assert.equal(h.state.reveal.length,0);assert.equal(h.state.notice.length,0);
});

for(const changedProject of [false,true])test(`Tasks hidden recovery 401 retains authentication handling, changed project=${changedProject}`,async()=>{
 const h=harness(),entered=gate(),release=gate();let current=true;
 h.deps.tasksRef.current.recover=async()=>{(entered.resolve)!();await release.promise;throw Object.assign(new Error('Session expired'),{code:'UNAUTHORIZED'});};
 const pending=h.recoverTask({id:'task',projectId},false,()=>current);await entered.promise;current=false;
 if(changedProject)h.refs.currentProject.current='another-project';(release.resolve)!();await pending;
 assert.deepEqual(h.state.auth,changedProject?[]:[false]);assert.equal(h.state.notice.length,0);assert.equal(h.state.reveal.length,0);
 assert.equal(h.state.ack.length,0);assert.equal(h.state.busy.at(-1)![2],false);
});

test('paid retry keeps its Tasks review and rejects a revoked pane before submission',()=>{
 const code=section('  function retryGeneration(', '  async function createProject('),snapshot={title:'Fixed original',duration:4,aspectRatio:'16:9',referenceAssetIds:[]};
 const job={id:jobId,shotId,projectId,providerId:'synthetic-paid-adapter',model:'fixed-test-model',snapshot};
 const state={reviews:[] as unknown[],submitted:[] as {retryJobId: string}[],notices:[] as unknown[]},realConfirmRef={current:null as GenerationApproval | null};let viewCurrent=true;
 const deps={message,msg:message,...createI18nTestContext(),findGenerationProvider,generationProviderForModel,generationProviderIdentity,generationParameters,parseVideoBinding,videoBindingCapabilities,providers:[{id:job.providerId,mock:false}],checkGeneration:()=>true,reviewGeneration:null,
  dataRef:{current:{shots:[{id:shotId,projectId}],jobs:[job],assets:[]}},generationReviewScope:{current:{key:'tasks'}},realConfirmRef,
  setRealConfirm:(value: unknown)=>state.reviews.push(value),context:()=>({projectId,epoch:1}),isCurrent:()=>true,
  generationReferenceIdentity:()=> 'fixed-source',generationReferences:()=>({references:[]}),generationOptionsRef:{current:{}},generationSelection:()=>({}),
  subjectVideoIdentity:()=>null,subjectVideoProfileIdentity:()=>null,submitGeneration:(args: {retryJobId: string})=>state.submitted.push(args),notify:(message: unknown)=>state.notices.push(message)};
 // reviewGeneration is declared by the actual extracted code, not a stub.
 delete (deps as {reviewGeneration?: unknown}).reviewGeneration;const h=make(code,deps,['retryGeneration','confirmGeneration']);h.retryGeneration(job,()=>viewCurrent);
 const approval=realConfirmRef.current;assert.ok(approval);assert.deepEqual(approval.shot,{...snapshot,id:shotId});assert.equal(approval.approvalView,deps.generationReviewScope.current);assert.equal(typeof approval.taskViewGuard,'function');
 viewCurrent=false;h.confirmGeneration(approval);assert.equal(state.submitted.length,0);assert.equal(state.notices.length,1);
 viewCurrent=true;h.retryGeneration(job,()=>viewCurrent);h.confirmGeneration(realConfirmRef.current);assert.equal(state.submitted.length,1);assert.equal(state.submitted[0].retryJobId,jobId);
});

test('actual App keeps retained owners mounted and routes task opening through its overlay',()=>{
 assert.doesNotMatch(app,/\bshowJobs\b|\bsetShowJobs\b/);assert.match(app+readFileSync(new URL('../apps/web/src/TaskPopover.tsx',import.meta.url),'utf8'),/right-dock-tab-tasks/);assert.match(app,/id="right-dock-tasks"[\s\S]*?<TaskCenter\b[^>]*selectedTaskId=\{selectedTaskId\}[^>]*taskViewScope=/);
 assert.match(app,/onInspectJob=\{inspectTaskJob(?: as never)?\}/);assert.match(app,/setShowTasks\(false\); setShowDelivery\(false\);/);
 for(const page of ['properties','agent','image','delivery','tasks'])assert.match(app,new RegExp(`id="right-dock-${page}"`));
 assert.match(app,/onReload=\{\(\(\) => tasksRef\.current!\.load\(currentProject\.current as string\)\) as never\}/);
 assert.doesNotMatch(bridge,/\.execute\(|\.recover\(|\.acknowledge\(|\.load\(|\brpc\(|setInterval|setTimeout/);
 assert.doesNotMatch(agentBridge,/\.execute\(|\.recover\(|\.acknowledge\(|\.load\(|setInterval|setTimeout/);
 assert.equal([...agentBridge.matchAll(/\brpc\(/g)].length,1,'the separate original-request route has exactly one resolver-owned read seam');
 assert.match(agentBridge,/resolveAgentTaskRecoveryLocation\(location, projectId, async \(operation, input\) => rpc\(operation, input\), current\)/);
});


test('home or a failed opening grants neither task observation nor delayed reveal authority',()=>{
 const h=harness();h.state.projectReady=false;assert.equal(h.readTaskRevealContext().active,false);assert.equal(h.captureTaskView(),null);assert.equal(captureTaskWorkspaceIntent(h.readTaskRevealContext),null);assert.equal(h.state.ack.length,0);assert.equal(h.state.reveal.length,0);
});
