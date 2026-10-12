import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createTimelineDeliveryNameController} from '../apps/web/src/export-delivery-state.ts';

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
 const reference={current:{controller:f.controller}},events=[];
 const guard=actual('  async function guardProjectNavigation(','  async function changeMode(',{
  deliveryNameRef:reference,timelineFormatRef:{current:{controller:{hasUnsaved:()=>false,discardDraft:()=>events.push('discard-format')}}},
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

function renderHarness(f,{pending=false,run}={}){
 const calls=[],dataRef={current:{timeline:{id:'timeline',revision:7,clips:[{id:'clip'}]}}};
 const binding={projectId:id,expectedRevision:7,preflightSnapshotHash:'a'.repeat(64),deliveryName:'版本 A'};
 const environment={panelIntent:{current:0},openExportHistory:()=>calls.push(['history',true]),deliveryNameRef:{current:{controller:f.controller}},workspaceRef:{current:{restored:false}},dataRef,currentProject:{current:id},
  exportCheckContext:()=>({scope:f.live.scope,projectId:id}),exportPreflight:{controller:{setContext(){},takeExportBinding(value){return value===binding?binding:null;},takeUncheckedExportIntent(){return null;}}},
  isBusy:()=>false,pendingForProject:()=>pending?[{key:'timeline:render:export'}]:[],notify:(...args)=>calls.push(['notify',...args]),setShowJobs:value=>calls.push(['jobs',value]),
  requestId:()=> 'named-app-key-0001',run:async(...args)=>{calls.push(['run',...args]);return run?.(...args);},updateView(){},setPreviewKind(){},setShowExports:value=>calls.push(['history',value]),
 };
 return {render:actual('  async function renderTimeline(','  async function previewSource(',environment),binding,calls,environment};
}
const accepted=()=>({id:'89100000-0000-4000-8000-000000000002',projectId:id,mode:'timeline',purpose:'export',status:'queued',snapshot:{deliveryName:'版本 A'}});

test('actual render preserves captured exact name and marks only matching strict-run acknowledgement clean',async()=>{
 const f=nameFixture();f.choose('版本 A');const h=renderHarness(f,{run:async()=>accepted()});
 await h.render('export',h.binding);const request=h.calls.find(row=>row[0]==='run');
 assert.deepEqual(request.slice(1),['timeline:render:export','timeline.render',{...h.binding,requestId:'named-app-key-0001',purpose:'export'}]);
 assert.equal(f.controller.getName(f.live.scope),'版本 A');assert.equal(f.controller.hasUnsaved(),false);
});

test('actual render unknown outcome retains draft and existing pending key prevents new submission',async()=>{
 for(const pending of [false,true]){
  const f=nameFixture();f.choose('版本 A');const h=renderHarness(f,{pending,run:async()=>null});
  await h.render('export',h.binding);assert.equal(f.controller.hasUnsaved(),true);assert.equal(f.controller.getName(f.live.scope),'版本 A');
  assert.equal(h.calls.filter(row=>row[0]==='run').length,pending?0:1);
 }
});

test('actual render late acknowledgement cannot clear a changed draft or new project epoch',async()=>{
 for(const change of ['name','epoch']){
  const f=nameFixture();f.choose('版本 A');const waiting=deferred(),h=renderHarness(f,{run:()=>waiting.promise});
  const result=h.render('export',h.binding);
  if(change==='name')f.choose('更新的草稿');else {f.set({scope:`${id}:2`});f.choose('新项目周期的草稿');}
  waiting.resolve(accepted());await result;assert.equal(f.controller.hasUnsaved(),true);assert.notEqual(f.controller.getName(f.live.scope),'版本 A');
 }
});

test('cancelled project confirmation does not consume a valid render capture',async()=>{
 const f=nameFixture();f.choose('版本 A');const waiting=deferred(),h=renderHarness(f,{run:()=>waiting.promise});
 const result=h.render('export',h.binding),guard=projectGuard(f,async()=>false);
 assert.equal(await guard.guard('discard?'),false);waiting.resolve(accepted());await result;assert.equal(f.controller.hasUnsaved(),false);
});

test('App wires name scope, validation, view identity, disclosure and unload guard without persisting title drafts',()=>{
 assert.match(source,/useTimelineDeliveryName\(\{ \.\.\.deliveryNameContext\(\), getContext: deliveryNameContext \}\)/);
 assert.match(source,/deliveryNameRef\.current = deliveryName/);
 assert.match(source,/deliveryName: deliveryName\.controller\.getName/);
 assert.match(source,/deliveryNameVersion: deliveryName\.controller\.getVersion/);
 assert.match(source,/settingsVersion', 'deliveryNameVersion'\]\.some/);
 assert.match(source,/!deliveryName\.error/);
 assert.match(source,/!deliveryNameRef\.current\?\.controller\.hasUnsaved\(\)/);
 assert.match(source,/deliveryName=\{deliveryName\.value\}/);
 assert.match(source,/deliveryNameError=\{deliveryName\.error\}/);
});

test('late accepted render cannot reopen delivery history after a newer panel or project choice',async()=>{
 for(const change of ['panel','project','name']){
  const f=nameFixture();f.choose('版本 A');const waiting=deferred(),h=renderHarness(f,{run:()=>waiting.promise});
  const result=h.render('export',h.binding);
  if(change==='panel')h.environment.panelIntent.current++;
  if(change==='project')h.environment.currentProject.current='another-project';
  if(change==='name')f.choose('新草稿');
  waiting.resolve(accepted());await result;
  assert.ok(!h.calls.some(row=>row[0]==='history'),change);
  assert.equal(h.calls.filter(row=>row[0]==='run').length,1);
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
