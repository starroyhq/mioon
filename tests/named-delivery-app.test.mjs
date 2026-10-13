import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {schemas,isTimelineMutationResponse,hasRequestNotAppliedProof} from '@mioon/contracts';
import {createLocalDeliveryController} from '../apps/web/src/local-delivery-state.ts';
import {createTimelineDeliveryNameController} from '../apps/web/src/export-delivery-state.ts';
import {createExportRangeController} from '../apps/web/src/export-range-state.ts';

const source=readFileSync(new URL('../apps/web/src/App.jsx',import.meta.url),'utf8');
function actual(start,end,environment){
 const first=source.indexOf(start),last=source.indexOf(end,first);
 assert.ok(first>=0&&last>first,'actual App function boundaries must remain present');
 return Function(...Object.keys(environment),`return (${source.slice(first,last).trim()});`)(...Object.values(environment));
}
const id='89100000-0000-4000-8000-000000000001';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function nameFixture(context={scope:`${id}:1`,projectId:id,enabled:true}){
 let live={...context};const controller=createTimelineDeliveryNameController({getContext:()=>live});controller.setContext(live);
 return {controller,get live(){return live;},set(patch){live={...live,...patch};controller.setContext(live);},choose(value){return controller.choose(value,live.scope,controller.getVersion(live.scope));}};
}
function projectGuard(f,confirmation=async()=>true){
 const reference={current:{controller:f.controller}},events=[],formatState={};
 const guard=actual('  async function guardProjectNavigation(','  async function changeMode(',{
  localDeliveryRef:{current:null},deliveryNameRef:reference,timelineFormatRef:{current:{controller:{getState:()=>formatState,hasUnsaved:()=>false,discardDraft:()=>events.push('discard-format')}}},
  guardNavigation:async(message,dirty)=>{events.push({message,dirty});return confirmation();},
 });
 return {guard,reference,events};
}

test('actual project guard allows first project without a delivery draft and preserves cancelled drafts',async()=>{
 const empty=nameFixture({scope:'null:0',projectId:null,enabled:false}),first=projectGuard(empty);
 assert.equal(await first.guard('select first'),true);assert.equal(first.events[0].dirty,false);
 const f=nameFixture();f.choose('版本 A');const h=projectGuard(f,async()=>false);
 assert.equal(await h.guard('discard?'),false);assert.equal(f.controller.getName(f.live.scope),'版本 A');assert.equal(f.controller.hasUnsaved(),true);
 assert.equal(h.events[0].dirty,true);assert.ok(!h.events.includes('discard-format'));
});

test('actual project guard rejects new typing and replacement controller during confirmation',async()=>{
 for(const replacement of [false,true]){
  const f=nameFixture();f.choose('版本 A');const wait=deferred(),h=projectGuard(f,()=>wait.promise);
  const result=h.guard('discard?');
  if(replacement)h.reference.current={controller:nameFixture().controller};else f.choose('更新的草稿');
  wait.resolve(true);assert.equal(await result,false);assert.ok(!h.events.includes('discard-format'));
  assert.equal(f.controller.hasUnsaved(),true);
 }
});

function renderHarness(f,{pending=false,submit,run,restored=false,canPrepare=true}={}){
 const calls=[],dataRef={current:{timeline:{id:'timeline',revision:7,clips:[{id:'clip'}]}}};
 const binding={projectId:id,expectedRevision:7,preflightSnapshotHash:'a'.repeat(64),deliveryName:'版本 A'};
 const environment={panelIntent:{current:0},openExportHistory:()=>calls.push(['history',true]),deliveryNameRef:{current:{controller:f.controller}},workspaceRef:{current:{restored}},dataRef,currentProject:{current:id},
  exportCheckContext:()=>({scope:f.live.scope,projectId:id}),exportPreflight:{controller:{setContext(){},takeExportBinding(value){return value===binding?binding:null;},takeUncheckedExportIntent(){return null;}}},
  isBusy:()=>false,pendingForProject:()=>pending?[{key:'timeline:render:export'}]:[],notify:(...args)=>calls.push(['notify',...args]),openTasks:(canReveal=()=>true)=>{if(canReveal())calls.push(['jobs',true]);},
  localDeliveryRef:{current:{controller:{canPrepare:()=>canPrepare,submit:async(...args)=>{calls.push(['submit',...args]);return submit?.(...args);}}}},
  context:()=>({scope:f.live.scope,projectId:environment.currentProject.current}),isCurrent:captured=>captured.scope===f.live.scope&&captured.projectId===environment.currentProject.current,
  requestId:()=> 'named-app-key-0001',run:async(...args)=>{calls.push(['run',...args]);return run?.(...args);},updateView(){},setPreviewKind(){},setShowExports:value=>calls.push(['history',value]),
 };
 return {render:actual('  async function renderTimeline(','  async function previewSource(',environment),binding,calls,environment};
}
const accepted=()=>({id:'89100000-0000-4000-8000-000000000002',projectId:id,mode:'timeline',purpose:'export',status:'queued',snapshot:{deliveryName:'版本 A'}});

const fixtureId=n=>`89100000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const stamp='2026-10-12T00:00:00.000Z';
const tickUntil=async check=>{for(let index=0;index<40&&!check();index++)await Promise.resolve();assert.ok(check(),'Expected async fixture phase');};
function exportReceipt(input){
 const timelineId=fixtureId(3),trackId=fixtureId(4),assetId=fixtureId(5);
 return {id:fixtureId(2),projectId:id,requestId:input.requestId,mode:'timeline',purpose:'export',timelineRevision:input.expectedRevision,
  snapshot:{timeline:{id:timelineId,projectId:id,revision:input.expectedRevision,fps:30,width:720,height:1280,durationFrames:30,
   tracks:[{id:trackId,kind:'video',name:'Video',orderIndex:0,hidden:false,muted:false}],
   clips:[{id:fixtureId(6),trackId,assetId,name:'Image',startFrame:0,durationFrames:30,sourceInFrame:0,gain:1,rect:{x:0,y:0,width:720,height:1280}}],createdAt:stamp,updatedAt:stamp},
   assets:[{id:assetId,sha256:'b'.repeat(64),mimeType:'image/png',duration:0,width:1,height:1}],deliveryName:input.deliveryName},
  status:'queued',assetId:null,url:null,error:null,createdAt:stamp,updatedAt:stamp};
}
async function coordinatedRenderHarness(t,{preparation,execution,refreshing}={}){
 const f=nameFixture();f.choose('版本 A');const h=renderHarness(f),transportCalls=[],refreshes=[];
 h.environment.dataRef.current={project:{id},timeline:exportReceipt({...h.binding,requestId:'named-app-key-0001'}).snapshot.timeline};
 let stored={supported:true,workspaceScope:'c'.repeat(64),instanceId:fixtureId(7),projectId:id,draftRevision:0,draft:null,intentRevision:0,intent:null,draftTargetStatus:'unset',intentTargetStatus:'unset'},sequence=100;
 const record=(method,input)=>transportCalls.push({method,input:structuredClone(input)});
 const client={
  async get(projectId){record('get',projectId);return structuredClone(stored);},
  async put(input){record('put',input);stored={...stored,draftRevision:stored.draftRevision+1,draft:{draftId:input.draftId,timelineId:input.timelineId,baseRevision:input.baseRevision,raw:structuredClone(input.raw),updatedAt:stamp},draftTargetStatus:'matching'};return structuredClone(stored);},
  async prepare(input){record('prepare',input);stored={...stored,intentRevision:stored.intentRevision+1,intent:{intentId:input.intentId,timelineId:input.timelineId,baseRevision:input.baseRevision,draft:structuredClone(input.draft),input:structuredClone(input.input),createdAt:stamp,outcome:{status:'pending'}},intentTargetStatus:'matching'};if(preparation)await preparation.promise;return structuredClone(stored);},
  async execute(input){record('execute',input);if(execution)await execution.promise;const response=exportReceipt(stored.intent.input);assert.equal(isTimelineMutationResponse('timeline.render',stored.intent.input,response),true);
   stored={...stored,intentRevision:stored.intentRevision+1,intent:{...stored.intent,outcome:{status:'accepted',exportId:response.id,responseSha256:'d'.repeat(64),resolvedAt:stamp}},draftRevision:stored.draftRevision+1,draft:null,draftTargetStatus:'unset'};return {envelope:structuredClone(stored),response};},
  async discard(){assert.fail('Export acknowledgement must not discard through the draft API');},
  async recover(){assert.fail('Fresh export must not replay through recovery');},
 };
 const rangeController=createExportRangeController();rangeController.setContext({scope:f.live.scope,projectId:id,timelineId:h.environment.dataRef.current.timeline.id,revision:7,durationFrames:30,enabled:true});
 const localEnvironment={...h.environment,projectEpoch:{current:1},navigationEpoch:{current:0},exportSettings:{controller:{getVersion:()=>1}},exportRange:{controller:rangeController},online:true,auth:true,loading:false,rightDockTab:'delivery',showExports:false,panelVisible:()=>true,deliveryName:{controller:f.controller}};
 let contextCallback=actual('  function localDeliveryContext(','  const localDelivery = useLocalDelivery(',localEnvironment);
 const localDeliveryContext=()=>contextCallback();
 const setDeliveryView=patch=>{Object.assign(localEnvironment,patch);contextCallback=actual('  function localDeliveryContext(','  const localDelivery = useLocalDelivery(',localEnvironment);};
 const hookEnvironment={localDeliveryContext,schemas,isTimelineMutationResponse,hasRequestNotAppliedProof,deliveryNameRef:h.environment.deliveryNameRef,currentProject:h.environment.currentProject,
  refresh:async projectId=>{refreshes.push(projectId);if(refreshing)await refreshing.promise;},
  useLocalDelivery:options=>({controller:createLocalDeliveryController({...options,client,delay:60000,createId:()=>fixtureId(sequence++)})})};
 const first=source.indexOf('  const localDelivery = useLocalDelivery('),last=source.indexOf('  localDeliveryRef.current = localDelivery;',first);
 assert.ok(first>=0&&last>first,'App coordinator options must have explicit extraction boundaries');
 const local=Function(...Object.keys(hookEnvironment),`${source.slice(first,last)};return localDelivery;`)(...Object.values(hookEnvironment));
 const originalSubmit=local.controller.submit;
 local.controller.submit=(...args)=>{h.calls.push(['submit',...args]);return originalSubmit(...args);};
 h.environment.localDeliveryRef.current=local;t.after(()=>local.controller.dispose());await local.controller.load();
 return {...h,f,local,transportCalls,refreshes,setDeliveryView,localContext:localDeliveryContext};
}

test('actual App options and real coordinator preserve the exact original render input through prepare, execute and refresh',async t=>{
 const h=await coordinatedRenderHarness(t);await h.render('export',h.binding);
 const exact={...h.binding,requestId:'named-app-key-0001',purpose:'export'};
 assert.deepEqual(h.calls.find(row=>row[0]==='submit')[1],exact);
 assert.deepEqual(h.transportCalls.map(call=>call.method),['get','put','prepare','execute']);
 assert.deepEqual(h.transportCalls.find(call=>call.method==='prepare').input.input,exact);
 assert.deepEqual(h.refreshes,[id]);assert.equal(h.calls.some(row=>row[0]==='run'),false);
 assert.equal(h.local.controller.getState().intent.outcome.status,'accepted');assert.equal(h.f.controller.hasUnsaved(),false);
 assert.equal(h.f.controller.getName(h.f.live.scope),'版本 A');assert.ok(h.calls.some(row=>row[0]==='history'));
});

for(const transition of ['panel hide/show','history/compose'])test(`real App execution epoch blocks prepared export after ${transition} returns to the same view`,async t=>{
 const preparation=deferred(),h=await coordinatedRenderHarness(t,{preparation});
 const before=h.localContext(),result=h.render('export',h.binding);
 await tickUntil(()=>h.transportCalls.some(call=>call.method==='prepare'));
 const prepared=structuredClone(h.transportCalls.find(call=>call.method==='prepare').input);
 h.environment.panelIntent.current++;
 h.setDeliveryView(transition==='panel hide/show'?{panelVisible:()=>false}:{showExports:true});
 assert.equal(h.localContext().visible,false);
 h.environment.panelIntent.current++;
 h.setDeliveryView(transition==='panel hide/show'?{panelVisible:()=>true}:{showExports:false});
 const returned=h.localContext();assert.equal(returned.visible,true);
 assert.notEqual(returned.executionEpoch,before.executionEpoch);
 assert.equal(returned.deliveryName,before.deliveryName);assert.equal(returned.nameVersion,before.nameVersion);
 assert.equal(returned.scope,before.scope);assert.equal(returned.timelineRevision,before.timelineRevision);
 // The controller need not observe the transient hidden render. Its next
 // synchronous App context read must still distinguish this later visit.
 preparation.resolve();await result;
 const state=h.local.controller.getState();
 assert.deepEqual(h.transportCalls.map(call=>call.method),['get','put','prepare']);
 assert.equal(state.intent.intentId,prepared.intentId);assert.deepEqual(state.intent.input,prepared.input);
 assert.deepEqual(state.intent.draft,prepared.draft);assert.equal(state.intent.outcome.status,'pending');assert.equal(state.pending,true);
 assert.equal(h.local.controller.canPrepare(),false);assert.deepEqual(h.refreshes,[]);
 assert.equal(h.calls.some(row=>row[0]==='run'||row[0]==='history'),false);
 assert.equal(h.f.controller.getName(h.f.live.scope),'版本 A');assert.equal(h.f.controller.hasUnsaved(),true);
 await h.render('export',h.binding);
 assert.equal(h.calls.filter(row=>row[0]==='submit').length,1);assert.deepEqual(h.transportCalls.map(call=>call.method),['get','put','prepare']);
});

for(const changeAt of ['execution','refresh'])test(`real coordinator ACK refresh cannot clear a newer name typed during ${changeAt}`,async t=>{
 const execution=deferred(),refreshing=deferred(),h=await coordinatedRenderHarness(t,{execution,refreshing});
 const result=h.render('export',h.binding);await tickUntil(()=>h.transportCalls.some(call=>call.method==='execute'));
 const original=structuredClone(h.transportCalls.find(call=>call.method==='prepare').input.input);
 if(changeAt==='execution')h.f.choose('更新的草稿');
 execution.resolve();await tickUntil(()=>h.refreshes.length===1);
 if(changeAt==='refresh')h.f.choose('更新的草稿');
 refreshing.resolve();await result;
 assert.deepEqual(h.local.controller.getState().intent.input,original);assert.deepEqual(h.refreshes,[id]);
 assert.equal(h.f.controller.getName(h.f.live.scope),'更新的草稿');assert.equal(h.f.controller.hasUnsaved(),true);
 h.local.controller.capture();assert.equal(h.local.controller.getState().dirty,true);
 assert.equal(h.calls.some(row=>row[0]==='history'||row[0]==='run'),false);
 assert.equal(h.calls.filter(row=>row[0]==='submit').length,1);
});

test('actual normal export uses coordinator with exact captured input and marks only its matching acknowledgement clean',async()=>{
 const f=nameFixture();f.choose('版本 A');const h=renderHarness(f,{submit:async()=>accepted()});
 await h.render('export',h.binding);const request=h.calls.find(row=>row[0]==='submit');
 assert.deepEqual(request[1],{...h.binding,requestId:'named-app-key-0001',purpose:'export'});
 assert.equal(request[2].canExecute(),true);assert.equal(request[2].nameCapture.value,'版本 A');
 assert.equal(h.calls.filter(row=>row[0]==='run').length,0);
 assert.equal(f.controller.getName(f.live.scope),'版本 A');assert.equal(f.controller.hasUnsaved(),false);
});

test('restored export preserves the legacy runner and exact named input without consulting the coordinator',async()=>{
 const f=nameFixture();f.choose('版本 A');const h=renderHarness(f,{restored:true,canPrepare:false,run:async()=>accepted()});
 await h.render('export',h.binding);
 assert.deepEqual(h.calls.find(row=>row[0]==='run').slice(1),['timeline:render:export','timeline.render',{...h.binding,requestId:'named-app-key-0001',purpose:'export'}]);
 assert.equal(h.calls.filter(row=>row[0]==='submit').length,0);assert.equal(f.controller.hasUnsaved(),false);
});

test('timeline preview remains on the legacy runner and never submits or acknowledges a delivery draft',async()=>{
 const f=nameFixture();f.choose('版本 A');const h=renderHarness(f,{canPrepare:false,run:async()=>({...accepted(),purpose:'preview'})});
 await h.render('preview');
 assert.deepEqual(h.calls.find(row=>row[0]==='run').slice(1),['timeline:render:preview','timeline.render',{projectId:id,expectedRevision:7,requestId:'named-app-key-0001',purpose:'preview'}]);
 assert.equal(h.calls.filter(row=>row[0]==='submit').length,0);assert.equal(f.controller.hasUnsaved(),true);
});

test('normal export cannot fall through to legacy run when the private coordinator is not ready',async()=>{
 const f=nameFixture();f.choose('版本 A');const h=renderHarness(f,{canPrepare:false});await h.render('export',h.binding);
 assert.equal(h.calls.some(row=>row[0]==='submit'||row[0]==='run'),false);assert.equal(f.controller.hasUnsaved(),true);
});

test('actual render unknown outcome retains draft and existing pending key prevents new submission',async()=>{
 for(const pending of [false,true]){
  const f=nameFixture();f.choose('版本 A');const h=renderHarness(f,{pending,submit:async()=>null});
  await h.render('export',h.binding);assert.equal(f.controller.hasUnsaved(),true);assert.equal(f.controller.getName(f.live.scope),'版本 A');
  assert.equal(h.calls.filter(row=>row[0]==='submit').length,pending?0:1);
 }
});

test('actual render late acknowledgement cannot clear a changed draft or new project epoch',async()=>{
 for(const change of ['name','epoch']){
  const f=nameFixture();f.choose('版本 A');const waiting=deferred(),h=renderHarness(f,{submit:()=>waiting.promise});
  const result=h.render('export',h.binding);
  if(change==='name')f.choose('更新的草稿');else {f.set({scope:`${id}:2`});f.choose('新项目周期的草稿');}
  waiting.resolve(accepted());await result;assert.equal(f.controller.hasUnsaved(),true);assert.notEqual(f.controller.getName(f.live.scope),'版本 A');
 }
});

test('cancelled project confirmation does not consume a valid render capture',async()=>{
 const f=nameFixture();f.choose('版本 A');const waiting=deferred(),h=renderHarness(f,{submit:()=>waiting.promise});
 const result=h.render('export',h.binding),guard=projectGuard(f,async()=>false);
 assert.equal(await guard.guard('discard?'),false);waiting.resolve(accepted());await result;assert.equal(f.controller.hasUnsaved(),false);
});

test('App wires name scope, validation, view identity, disclosure and independent unload guard',()=>{
 assert.match(source,/useTimelineDeliveryName\(\{ \.\.\.deliveryNameContext\(\), getContext: deliveryNameContext \}\)/);
 assert.match(source,/deliveryNameRef\.current = deliveryName/);
 assert.match(source,/deliveryName: deliveryName\.controller\.getName/);
 assert.match(source,/deliveryNameVersion: deliveryName\.controller\.getVersion/);
 assert.match(source,/settingsVersion', 'deliveryNameVersion', 'rangeVersion'\]\.some/);
 assert.match(source,/!deliveryName\.error/);
 assert.match(source,/!deliveryNameRef\.current\?\.controller\.hasUnsaved\(\)/);
 assert.match(source,/deliveryName=\{deliveryName\.value\}/);
 assert.match(source,/deliveryNameError=\{deliveryName\.error\}/);
});

test('late accepted render cannot reopen delivery history after a newer panel or project choice',async()=>{
 for(const change of ['panel','project','name']){
  const f=nameFixture();f.choose('版本 A');const waiting=deferred(),h=renderHarness(f,{submit:()=>waiting.promise});
  const result=h.render('export',h.binding);
  if(change==='panel')h.environment.panelIntent.current++;
  if(change==='project')h.environment.currentProject.current='another-project';
  if(change==='name')f.choose('新草稿');
  waiting.resolve(accepted());await result;
  assert.ok(!h.calls.some(row=>row[0]==='history'),change);
  assert.equal(h.calls.filter(row=>row[0]==='submit').length,1);
 }
});

test('actual history opener only changes the shared dock, and compose reopen keeps the name draft',()=>{
 const f=nameFixture();f.choose('留在右栏的草稿');const calls=[];
 const environment={setShowExports:value=>calls.push(['history',value]),setRightDockTab:value=>calls.push(['tab',value]),setPanelOpen:(...args)=>calls.push(['panel',...args]),exportPreflight:{controller:{setVisible:value=>calls.push(['visible',value])}}};
 const open=actual('  function openExportHistory(','  async function createExport(',environment);
 const compose=actual('  function openTimelineExport(','  const historyState',environment);
 open();compose();
 assert.deepEqual(calls,[['history',true],['tab','delivery'],['panel','inspector',true],['history',false],['tab','delivery'],['panel','inspector',true],['visible',true]]);
 assert.equal(f.controller.getName(f.live.scope),'留在右栏的草稿');assert.equal(f.controller.hasUnsaved(),true);
});

test('delivery pages retain both forms with inherited visibility and never submit on open/hide',()=>{
 assert.match(source,/visible: rightDockTab === 'delivery' && !showExports && panelVisible\('inspector'\)/);
 assert.match(source,/<AgentDockPane id="delivery-compose-pane"[^>]*visible=\{!showExports\}/);
 assert.match(source,/<AgentDockPane id="delivery-history-pane"[^>]*visible=\{showExports\}/);
 assert.match(source,/onPage=\{page => \{ markPanelIntent\(\); setShowExports\(page === 'history'\); \}\}/);
 assert.doesNotMatch(source,/showExports && <Modal|<Modal title="导出记录"/);
 const open=source.slice(source.indexOf('  function openExportHistory('),source.indexOf('  async function createExport('));
 assert.doesNotMatch(open,/rpc|run\(|requestId|acknowledge|discardDraft|choose\(|\.check\(/);
});
