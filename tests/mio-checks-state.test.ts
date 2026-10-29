import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createAgentTaskChecksCache,createAgentTaskChecksView,visibleAgentTaskChecks} from '../apps/web/src/agent-task-checks-state.ts';
import type {AgentTaskChecksReader,AgentTaskChecksRound,AgentTaskChecksViewState} from '../apps/web/src/agent-task-checks-state.ts';
import type {AgentTaskChecksReadOptions} from '../apps/web/src/agent-tasks-v2.ts';
import type {AgentTaskCheck,AgentTaskChecks} from '../packages/contracts/src/agent-task-checks-v2.ts';

const projectId='10000000-0000-4000-8000-000000000001',otherProject='10000000-0000-4000-8000-000000000002';
const runId='20000000-0000-4000-8000-000000000001',otherRun='20000000-0000-4000-8000-000000000002';
const exportId='30000000-0000-4000-8000-000000000001',timelineId='40000000-0000-4000-8000-000000000001',assetId='50000000-0000-4000-8000-000000000001';
const round=(patch:Partial<AgentTaskChecksRound>={}):AgentTaskChecksRound=>({runId,runRevision:1,completed:true,latest:false,backgroundPending:false,visible:true,...patch});
type Preflight='not_requested'|'passed'|'failed';
function report({id=runId,revision=1,preflight,pending=false,timelineRevision=1,extraAsset=false,timeline=timelineId}:{id?:string;revision?:number;preflight?:Preflight;pending?:boolean;timelineRevision?:number;extraAsset?:boolean;timeline?:string}={}):AgentTaskChecks {
 const exported:AgentTaskCheck={id:`export_status:export:${exportId}`,type:'export_status',source:'host',status:'passed',target:{kind:'export',id:exportId},basis:[{kind:'export',id:exportId,revision:1}]};
 const items:AgentTaskCheck[]=preflight?[{id:`timeline_preflight:timeline:${timelineId}`,type:'timeline_preflight',source:'host',status:preflight==='passed'?'passed':preflight==='failed'?'failed':'pending',target:{kind:'timeline',id:timeline},basis:[{kind:'timeline',id:timeline,revision:timelineRevision},...(extraAsset?[{kind:'asset' as const,id:assetId,revision:8}]:[])],...(preflight==='not_requested'?{reason:{code:'PREFLIGHT_NOT_REQUESTED' as const}}:preflight==='failed'?{reason:{code:'PREFLIGHT_BLOCKED' as const,params:{blockingCount:1}}}:{})}]:[];
 return {projectId,runId:id,runRevision:revision,groups:[{id:'export_render',items:[exported]},{id:'generation',items:pending?[{id:`generation_status:run:${id}`,type:'generation_status',source:'host',status:'pending',target:{kind:'run',id},basis:[{kind:'run',id,revision}],reason:{code:'TASK_PENDING'},progress:62}]:[]},{id:'timeline',items},{id:'decomposition_frames',items:[]}]};
}
async function microtasks(){for(let index=0;index<16;index++)await Promise.resolve();}
interface ReadCall {projectId:string;runId:string;options:AgentTaskChecksReadOptions;resolve:(value:AgentTaskChecks)=>void;reject:(error:unknown)=>void}
function deferredReader({honorAbort=true}:{honorAbort?:boolean}={}){
 const calls:ReadCall[]=[];
 const read:AgentTaskChecksReader=(projectId,runId,options={})=>new Promise<AgentTaskChecks>((resolve,reject)=>{
  const cleanup=()=>options.signal?.removeEventListener('abort',aborted),finish=(value:AgentTaskChecks)=>{cleanup();resolve(value);},fail=(error:unknown)=>{cleanup();reject(error);};
  const aborted=()=>fail(new DOMException('Synthetic checks cancellation','AbortError'));
  calls.push({projectId,runId,options,resolve:finish,reject:fail});
  if(honorAbort){if(options.signal?.aborted)aborted();else options.signal?.addEventListener('abort',aborted,{once:true});}
 });
 return {read,calls};
}
function view(t:TestContext,options:Parameters<typeof createAgentTaskChecksView>[0]){const result=createAgentTaskChecksView(options);t.after(()=>result.dispose());return result;}
const preflightItem=(value:AgentTaskChecks|null)=>value?.groups.flatMap(group=>group.items).find(item=>item.type==='timeline_preflight');

test('only visible completed rounds can read checks or start a manual preflight',async t=>{
 const reader=deferredReader(),current=view(t,{scope:'window',projectId,read:reader.read,cache:createAgentTaskChecksCache()});
 current.update(round({visible:false}));await current.recheck();current.update(round({completed:false}));await current.recheck();await microtasks();assert.equal(reader.calls.length,0);
 current.update(round());await microtasks();assert.equal(reader.calls.length,1);assert.equal(reader.calls[0]!.options.preflight,false);
 reader.calls[0]!.resolve(report());await microtasks();assert.equal(current.getState().report?.runId,runId);
 current.update(round());await microtasks();assert.equal(reader.calls.length,1);
});

test('report cache separates scope, project, run and run revision and reuses an exact remount',async t=>{
 const cache=createAgentTaskChecksCache(),calls:Array<{projectId:string;runId:string}>=[];
 const read:AgentTaskChecksReader=async(projectId,id)=>{calls.push({projectId,runId:id});return {...report({id}),projectId};};
 const first=view(t,{scope:'window-a',projectId,read,cache});first.update(round());await microtasks();assert.equal(calls.length,1);first.dispose();
 const remount=view(t,{scope:'window-a',projectId,read,cache});remount.update(round());await microtasks();assert.equal(calls.length,1);
 const differentScope=view(t,{scope:'window-b',projectId,read,cache});differentScope.update(round());await microtasks();assert.equal(calls.length,2);
 const differentProject=view(t,{scope:'window-a',projectId:otherProject,read,cache});differentProject.update(round());await microtasks();assert.equal(calls.length,3);
 remount.update(round({runId:otherRun}));await microtasks();assert.equal(calls.length,4);assert.equal(remount.getState().report?.runId,otherRun);
 const newer=view(t,{scope:'window-a',projectId,read,cache});newer.update(round({runRevision:2}));await microtasks();assert.equal(calls.length,5);
});

test('switching back to a cached round at the same revision does not reread it',async t=>{
 const calls:string[]=[],read:AgentTaskChecksReader=async(_project,id)=>{calls.push(id);return report({id});};
 const current=view(t,{scope:'window',projectId,read,cache:createAgentTaskChecksCache()});
 current.update(round());await microtasks();current.update(round({runId:otherRun}));await microtasks();
 current.update(round());await microtasks();assert.deepEqual(calls,[runId,otherRun]);assert.equal(current.getState().report?.runId,runId);
});

test('the app cache admits at most two simultaneous reads and drains queued work in order',async t=>{
 const cache=createAgentTaskChecksCache(),reader=deferredReader(),ids=[runId,otherRun,'20000000-0000-4000-8000-000000000003'];
 const views=ids.map(id=>{const current=view(t,{scope:'window',projectId,read:reader.read,cache});current.update(round({runId:id}));return current;});
 await microtasks();assert.deepEqual(reader.calls.map(call=>call.runId),ids.slice(0,2));assert.ok(views.every(current=>current.getState().loading));
 reader.calls[0]!.resolve(report());await microtasks();assert.deepEqual(reader.calls.map(call=>call.runId),ids);
 reader.calls[1]!.resolve(report({id:ids[1]}));reader.calls[2]!.resolve(report({id:ids[2]}));await microtasks();assert.ok(views.every(current=>!current.getState().loading));
});

test('hiding or disposing a queued round removes its reader work without blocking later reads',async t=>{
 const cache=createAgentTaskChecksCache(),reader=deferredReader(),ids=[runId,otherRun,...[3,4,5].map(index=>`20000000-0000-4000-8000-${String(index).padStart(12,'0')}`)];
 const views=ids.map(id=>{const current=view(t,{scope:'window',projectId,read:reader.read,cache});current.update(round({runId:id}));return current;});
 views[2]!.update(round({runId:ids[2],visible:false}));views[3]!.dispose();await microtasks();assert.equal(reader.calls.length,2);
 reader.calls[0]!.resolve(report());await microtasks();assert.deepEqual(reader.calls.map(call=>call.runId),[ids[0],ids[1],ids[4]]);
 reader.calls[1]!.resolve(report({id:ids[1]}));reader.calls[2]!.resolve(report({id:ids[4]}));await microtasks();assert.equal(views[2]!.getState().loading,false);
});

test('run revisions and a background completion edge each force one lightweight refresh despite cached data',async t=>{
 const reader=deferredReader(),current=view(t,{scope:'window',projectId,read:reader.read,cache:createAgentTaskChecksCache()});
 current.update(round({latest:true,backgroundPending:true}));await microtasks();reader.calls[0]!.resolve(report());await microtasks();
 current.update(round({latest:true,backgroundPending:true,runRevision:2}));await microtasks();assert.equal(reader.calls.length,2);reader.calls[1]!.resolve(report({revision:2}));await microtasks();
 current.update(round({latest:true,backgroundPending:true,runRevision:2}));assert.equal(reader.calls.length,2);
 current.update(round({latest:true,backgroundPending:false,runRevision:2}));await microtasks();assert.equal(reader.calls.length,3);reader.calls[2]!.resolve(report({revision:2}));await microtasks();
 current.update(round({latest:true,backgroundPending:false,runRevision:2}));assert.equal(reader.calls.length,3);assert.ok(reader.calls.every(call=>call.options.preflight===false));
});

test('only the latest round automatically performs a single full preflight after lightweight NOT_REQUESTED',async t=>{
 const cache=createAgentTaskChecksCache(),reader=deferredReader(),old=view(t,{scope:'window',projectId,read:reader.read,cache});
 old.update(round());await microtasks();reader.calls[0]!.resolve(report({preflight:'not_requested'}));await microtasks();assert.equal(reader.calls.length,1);old.dispose();
 const latest=view(t,{scope:'window',projectId,read:reader.read,cache});latest.update(round({latest:true}));await microtasks();assert.equal(reader.calls.length,2);assert.equal(reader.calls[1]!.options.preflight,true);assert.equal(latest.getState().preflighting,true);
 reader.calls[1]!.resolve(report({preflight:'passed'}));await microtasks();assert.equal(latest.getState().preflighting,false);assert.equal(latest.getState().justChecked,false);
 latest.update(round({latest:true,runRevision:2}));await microtasks();reader.calls[2]!.resolve(report({revision:2,preflight:'not_requested'}));await microtasks();assert.equal(reader.calls.length,3);assert.equal(preflightItem(latest.getState().report)?.status,'passed');
});

test('an unsuccessful automatic preflight is not repeated by updates or remounting the same app cache',async t=>{
 const cache=createAgentTaskChecksCache(),reader=deferredReader(),current=view(t,{scope:'window',projectId,read:reader.read,cache});
 current.update(round({latest:true}));await microtasks();reader.calls[0]!.resolve(report({preflight:'not_requested'}));await microtasks();assert.equal(reader.calls.length,2);
 reader.calls[1]!.reject(Error('Synthetic local read failure'));await microtasks();assert.equal(current.getState().error,true);current.dispose();
 const remount=view(t,{scope:'window',projectId,read:reader.read,cache});remount.update(round({latest:true}));await microtasks();assert.equal(reader.calls.length,2);
 remount.update(round({latest:true,runRevision:2}));await microtasks();reader.calls[2]!.resolve(report({revision:2,preflight:'not_requested'}));await microtasks();assert.equal(reader.calls.length,3);assert.equal(reader.calls[2]!.options.preflight,false);
});

test('an unmounted automatic preflight releases only its own lease and a late result cannot consume the remount attempt',async t=>{
 const cache=createAgentTaskChecksCache(),reader=deferredReader({honorAbort:false}),current=view(t,{scope:'window',projectId,read:reader.read,cache});
 current.update(round({latest:true}));await microtasks();reader.calls[0]!.resolve(report({preflight:'not_requested'}));await microtasks();const pending=reader.calls[1]!;assert.equal(pending.options.preflight,true);
 current.dispose();await microtasks();assert.equal(pending.options.signal?.aborted,true);
 const remount=view(t,{scope:'window',projectId,read:reader.read,cache});remount.update(round({latest:true}));await microtasks();assert.equal(reader.calls.length,3);const replacement=reader.calls[2]!;assert.equal(replacement.options.preflight,true);assert.equal(replacement.options.signal?.aborted,false);
 pending.resolve(report({preflight:'failed'}));await microtasks();assert.equal(remount.getState().preflighting,true);assert.equal(preflightItem(remount.getState().report)?.reason?.code,'PREFLIGHT_NOT_REQUESTED');
 const concurrent=view(t,{scope:'window',projectId,read:reader.read,cache});concurrent.update(round({latest:true}));await microtasks();assert.equal(reader.calls.length,3,'The stale cancellation cannot release the replacement lease for another view');
 replacement.resolve(report({preflight:'passed'}));await microtasks();assert.equal(preflightItem(remount.getState().report)?.status,'passed');assert.equal(remount.getState().preflighting,false);remount.dispose();concurrent.dispose();
 const completed=view(t,{scope:'window',projectId,read:reader.read,cache});completed.update(round({latest:true}));await microtasks();assert.equal(reader.calls.length,3);assert.equal(preflightItem(completed.getState().report)?.status,'passed');
});

test('a complete preflight survives lightweight refresh with the same timeline basis even when it had extra assets',async t=>{
 const reader=deferredReader(),current=view(t,{scope:'window',projectId,read:reader.read,cache:createAgentTaskChecksCache()});
 current.update(round());await microtasks();reader.calls[0]!.resolve(report({preflight:'not_requested'}));await microtasks();
 const manual=current.recheck();await microtasks();reader.calls[1]!.resolve(report({preflight:'passed',extraAsset:true}));await manual;assert.equal(preflightItem(current.getState().report)?.basis.length,2);
 current.update(round({runRevision:2}));await microtasks();reader.calls[2]!.resolve(report({revision:2,preflight:'not_requested'}));await microtasks();const retained=preflightItem(current.getState().report);assert.equal(retained?.status,'passed');assert.equal(retained?.basis.length,2);assert.equal(reader.calls.length,3);
});

test('a changed timeline revision or identity invalidates cached full preflight data',async t=>{
 const reader=deferredReader(),current=view(t,{scope:'window',projectId,read:reader.read,cache:createAgentTaskChecksCache()});
 current.update(round());await microtasks();reader.calls[0]!.resolve(report({preflight:'not_requested'}));await microtasks();
 let manual=current.recheck();await microtasks();reader.calls[1]!.resolve(report({preflight:'passed'}));await manual;
 current.update(round({runRevision:2}));await microtasks();reader.calls[2]!.resolve(report({revision:2,preflight:'not_requested',timelineRevision:2}));await microtasks();assert.equal(preflightItem(current.getState().report)?.reason?.code,'PREFLIGHT_NOT_REQUESTED');
 manual=current.recheck();await microtasks();reader.calls[3]!.resolve(report({revision:2,preflight:'passed',timelineRevision:2}));await manual;
 current.update(round({runRevision:3}));await microtasks();reader.calls[4]!.resolve(report({revision:3,preflight:'not_requested',timelineRevision:2,timeline:'40000000-0000-4000-8000-000000000002'}));await microtasks();assert.equal(preflightItem(current.getState().report)?.reason?.code,'PREFLIGHT_NOT_REQUESTED');
});

test('NOT_REQUESTED, non-applicable items and empty groups are hidden while failures lead their own group',()=>{
 const value=report({preflight:'not_requested'}),passed=value.groups[0]!.items[0]!;
 value.groups[0]!.items.push({...passed,id:'failure',status:'failed',reason:{code:'ARTIFACT_UNAVAILABLE'}},{...passed,id:'not-applicable',status:'not_applicable',reason:{code:'NO_APPLICABLE_TASK'}});
 const visible=visibleAgentTaskChecks(value);assert.deepEqual(visible.map(group=>group.id),['export_render']);assert.deepEqual(visible[0]!.items.map(item=>item.id),['failure',passed.id]);
 const busy=visibleAgentTaskChecks(value,true);assert.deepEqual(busy.map(group=>group.id),['export_render','timeline']);assert.equal(busy[1]!.items[0]!.reason?.code,'PREFLIGHT_NOT_REQUESTED');assert.deepEqual(visibleAgentTaskChecks(null),[]);
});

test('manual preflight is deduplicated, marks justChecked and keeps that marker until the next refresh',async t=>{
 const reader=deferredReader(),current=view(t,{scope:'window',projectId,read:reader.read,cache:createAgentTaskChecksCache()});
 current.update(round());await microtasks();reader.calls[0]!.resolve(report({preflight:'not_requested'}));await microtasks();
 const manual=current.recheck();await current.recheck();assert.equal(reader.calls.length,2);assert.equal(reader.calls[1]!.options.preflight,true);assert.equal(current.getState().preflighting,true);
 reader.calls[1]!.resolve(report({preflight:'passed'}));await manual;assert.equal(current.getState().justChecked,true);
 current.update(round());await microtasks();assert.equal(current.getState().justChecked,true);assert.equal(reader.calls.length,2);
 current.update(round({runRevision:2}));assert.equal(current.getState().justChecked,false);await microtasks();reader.calls[2]!.resolve(report({revision:2,preflight:'not_requested'}));await microtasks();assert.equal(current.getState().justChecked,false);
});

test('a failed read keeps the last successful report and an initial failure invents no report',async t=>{
 const cache=createAgentTaskChecksCache(),reader=deferredReader(),current=view(t,{scope:'window',projectId,read:reader.read,cache});
 current.update(round());await microtasks();reader.calls[0]!.resolve(report());await microtasks();const saved=current.getState().report;
 const manual=current.recheck();await microtasks();reader.calls[1]!.reject(Error('Synthetic full preflight unavailable'));await manual;assert.equal(current.getState().report,saved);assert.equal(current.getState().error,true);assert.equal(current.getState().loading,false);
 const empty=view(t,{scope:'other-window',projectId,read:reader.read,cache});empty.update(round());await microtasks();reader.calls[2]!.reject(Error('Synthetic lightweight read unavailable'));await microtasks();assert.equal(empty.getState().report,null);assert.equal(empty.getState().error,true);
});

test('an ignored abort cannot let a late previous-round result replace or cache the current round',async t=>{
 const cache=createAgentTaskChecksCache(),reader=deferredReader({honorAbort:false}),updates:AgentTaskChecksViewState[]=[],current=view(t,{scope:'window',projectId,read:reader.read,cache,onChange:value=>updates.push(value)});
 current.update(round());await microtasks();current.update(round({runId:otherRun}));await microtasks();assert.equal(reader.calls[0]!.options.signal?.aborted,true);assert.equal(current.getState().report,null);
 reader.calls[1]!.resolve(report({id:otherRun}));await microtasks();reader.calls[0]!.resolve(report());await microtasks();assert.equal(current.getState().report?.runId,otherRun);assert.ok(updates.every(value=>value.report?.runId!==runId));
 const remount=view(t,{scope:'window',projectId,read:reader.read,cache});remount.update(round());await microtasks();assert.equal(reader.calls.length,3);reader.calls[2]!.resolve(report());await microtasks();
});

test('hiding or disposing cancels an active lightweight read and late results do not publish or populate the cache',async t=>{
 const cache=createAgentTaskChecksCache(),reader=deferredReader({honorAbort:false}),updates:AgentTaskChecksViewState[]=[],current=view(t,{scope:'window',projectId,read:reader.read,cache,onChange:value=>updates.push(value)});
 current.update(round());await microtasks();current.update(round({visible:false}));assert.equal(reader.calls[0]!.options.signal?.aborted,true);assert.equal(current.getState().loading,false);
 reader.calls[0]!.resolve(report());await microtasks();assert.equal(current.getState().report,null);
 current.update(round());await microtasks();assert.equal(reader.calls.length,2);const count=updates.length;current.dispose();reader.calls[1]!.resolve(report());await microtasks();assert.equal(updates.length,count);assert.equal(current.getState().report,null);
 const remount=view(t,{scope:'window',projectId,read:reader.read,cache});remount.update(round());await microtasks();assert.equal(reader.calls.length,3);reader.calls[2]!.resolve(report());await microtasks();
});

test('manual full preflight survives revision and background completion updates without an intervening lightweight read',async t=>{
 const reader=deferredReader(),current=view(t,{scope:'window',projectId,read:reader.read,cache:createAgentTaskChecksCache()});
 current.update(round({latest:true,backgroundPending:true}));await microtasks();reader.calls[0]!.resolve(report({pending:true}));await microtasks();
 const manual=current.recheck();await microtasks();const full=reader.calls[1]!;assert.equal(full.options.preflight,true);
 current.update(round({latest:true,backgroundPending:false,runRevision:2}));await microtasks();assert.equal(full.options.signal?.aborted,false);assert.equal(reader.calls.length,2);assert.equal(current.getState().preflighting,true);
 full.resolve(report({revision:1,preflight:'passed'}));await manual;await microtasks();assert.equal(reader.calls.length,2);assert.equal(preflightItem(current.getState().report)?.status,'passed');assert.equal(current.getState().justChecked,true);assert.equal(current.getState().preflighting,false);
 current.update(round({latest:true,backgroundPending:false,runRevision:2}));await microtasks();assert.equal(reader.calls.length,2);assert.equal(current.getState().justChecked,true);
});

test('an automatic preflight remains active across viewport hide and reveal without duplicate reads',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const cache=createAgentTaskChecksCache(),reader=deferredReader(),current=view(t,{scope:'window',projectId,read:reader.read,cache});
 current.update(round({latest:true}));await microtasks();reader.calls[0]!.resolve(report({preflight:'not_requested'}));await microtasks();const full=reader.calls[1]!;
 current.update(round({latest:true,visible:false}));t.mock.timers.tick(10000);await microtasks();assert.equal(full.options.signal?.aborted,false);assert.equal(current.getState().preflighting,true);assert.equal(reader.calls.length,2);
 current.update(round({latest:true}));await microtasks();assert.equal(full.options.signal?.aborted,false);assert.equal(reader.calls.length,2);
 full.resolve(report({preflight:'passed'}));await microtasks();assert.equal(preflightItem(current.getState().report)?.status,'passed');assert.equal(current.getState().justChecked,false);assert.equal(reader.calls.length,2);
 current.update(round({latest:true,visible:false}));current.update(round({latest:true}));await microtasks();assert.equal(reader.calls.length,2);
});

test('a hidden full preflight can finish and populate cache while pending lightweight polling stays paused',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const cache=createAgentTaskChecksCache(),reader=deferredReader(),current=view(t,{scope:'window',projectId,read:reader.read,cache});
 current.update(round());await microtasks();reader.calls[0]!.resolve(report({preflight:'not_requested',pending:true}));await microtasks();const manual=current.recheck();await microtasks();const full=reader.calls[1]!;
 current.update(round({visible:false}));full.resolve(report({preflight:'passed',pending:true}));await manual;await microtasks();assert.equal(full.options.signal?.aborted,false);assert.equal(preflightItem(current.getState().report)?.status,'passed');assert.equal(current.getState().justChecked,true);
 t.mock.timers.tick(20000);await microtasks();assert.equal(reader.calls.length,2,'Hidden views must not start the pending lightweight timer');current.dispose();
 const remount=view(t,{scope:'window',projectId,read:reader.read,cache});remount.update(round());await microtasks();assert.equal(reader.calls.length,2);assert.equal(preflightItem(remount.getState().report)?.status,'passed');
 t.mock.timers.tick(4999);await microtasks();assert.equal(reader.calls.length,2);t.mock.timers.tick(1);await microtasks();assert.equal(reader.calls.length,3);assert.equal(reader.calls[2]!.options.preflight,false);reader.calls[2]!.resolve(report({preflight:'not_requested'}));await microtasks();
});

test('detaching, leaving completed state and switching runs cancel full preflight explicitly',async t=>{
 for(const transition of [{attached:false},{completed:false},{runId:otherRun}] satisfies Array<Partial<AgentTaskChecksRound>>){
  const reader=deferredReader(),current=view(t,{scope:'window',projectId,read:reader.read,cache:createAgentTaskChecksCache()});
  current.update(round());await microtasks();reader.calls[0]!.resolve(report());await microtasks();const manual=current.recheck();await microtasks();const full=reader.calls[1]!;
  current.update(round(transition));await manual;await microtasks();assert.equal(full.options.signal?.aborted,true);assert.equal(current.getState().preflighting,false);
  if(transition.runId){assert.equal(reader.calls.length,3);assert.equal(reader.calls[2]!.runId,otherRun);assert.equal(reader.calls[2]!.options.preflight,false);reader.calls[2]!.resolve(report({id:otherRun}));await microtasks();}else{assert.equal(reader.calls.length,2);current.update(round({visible:false,...transition}));await microtasks();assert.equal(reader.calls.length,2);}
  current.dispose();
 }
});

test('cancelling an automatic preflight by detachment leaves a retry available when the round is attached again',async t=>{
 const reader=deferredReader(),current=view(t,{scope:'window',projectId,read:reader.read,cache:createAgentTaskChecksCache()});
 current.update(round({latest:true}));await microtasks();reader.calls[0]!.resolve(report({preflight:'not_requested'}));await microtasks();const full=reader.calls[1]!;
 current.update(round({latest:true,attached:false}));await microtasks();assert.equal(full.options.signal?.aborted,true);assert.equal(reader.calls.length,2);
 current.update(round({latest:true,attached:true}));await microtasks();assert.equal(reader.calls.length,3);assert.equal(reader.calls[2]!.options.preflight,false);reader.calls[2]!.resolve(report({preflight:'not_requested'}));await microtasks();
 assert.equal(reader.calls.length,4);assert.equal(reader.calls[3]!.options.preflight,true);reader.calls[3]!.resolve(report({preflight:'passed'}));await microtasks();
 assert.equal(preflightItem(current.getState().report)?.status,'passed');current.update(round({latest:true,attached:true}));await microtasks();assert.equal(reader.calls.length,4);
});

test('a real automatic timeout consumes the attempt and is not retried on remount',async t=>{
 const cache=createAgentTaskChecksCache(),reader=deferredReader(),current=view(t,{scope:'window',projectId,read:reader.read,cache});
 current.update(round({latest:true}));await microtasks();reader.calls[0]!.resolve(report({preflight:'not_requested'}));await microtasks();const full=reader.calls[1]!;
 full.reject(Object.assign(Error('Synthetic timeout'),{code:'NETWORK'}));await microtasks();assert.equal(full.options.signal?.aborted,false);assert.equal(current.getState().error,true);current.dispose();
 const remount=view(t,{scope:'window',projectId,read:reader.read,cache});remount.update(round({latest:true}));await microtasks();assert.equal(reader.calls.length,2);assert.equal(remount.getState().preflighting,false);
 remount.update(round({latest:true,runRevision:2}));await microtasks();assert.equal(reader.calls.length,3);reader.calls[2]!.resolve(report({revision:2,preflight:'not_requested'}));await microtasks();assert.equal(reader.calls.length,3);assert.equal(reader.calls[2]!.options.preflight,false);
});

test('visible older pending results poll no sooner than five seconds and stop when hidden or settled',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let reads=0;
 const read:AgentTaskChecksReader=async()=>report({pending:++reads<3}),current=view(t,{scope:'window',projectId,read,cache:createAgentTaskChecksCache()});
 current.update(round());await microtasks();assert.equal(reads,1);t.mock.timers.tick(4999);await microtasks();assert.equal(reads,1);
 t.mock.timers.tick(1);await microtasks();assert.equal(reads,2);
 current.update(round({visible:false}));t.mock.timers.tick(10000);await microtasks();assert.equal(reads,2);
 current.update(round());await microtasks();t.mock.timers.tick(5000);await microtasks();assert.equal(reads,3);
 t.mock.timers.tick(20000);await microtasks();assert.equal(reads,3);assert.equal(current.getState().report?.groups[1]!.items.length,0);
});

test('latest pending results also use the five-second fallback and background completion refreshes immediately',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let reads=0;
 const read:AgentTaskChecksReader=async()=>{reads++;return report({pending:true});},current=view(t,{scope:'window',projectId,read,cache:createAgentTaskChecksCache()});
 current.update(round({latest:true,backgroundPending:true}));await microtasks();t.mock.timers.tick(4999);await microtasks();assert.equal(reads,1);t.mock.timers.tick(1);await microtasks();assert.equal(reads,2);
 current.update(round({latest:true,backgroundPending:false}));await microtasks();assert.equal(reads,3);t.mock.timers.tick(4999);await microtasks();assert.equal(reads,3);t.mock.timers.tick(1);await microtasks();assert.equal(reads,4);
 current.dispose();t.mock.timers.tick(20000);await microtasks();assert.equal(reads,4);
});

test('two synchronous reader failures release both admission slots for the next queued read',async t=>{
 const cache=createAgentTaskChecksCache();let calls=0;
 const read:AgentTaskChecksReader=(_project,id)=>{if(++calls<=2)throw Error('Synthetic synchronous read failure');return Promise.resolve(report({id}));};
 const views=[runId,otherRun,'20000000-0000-4000-8000-000000000003'].map(id=>{const current=view(t,{scope:'window',projectId,read,cache});current.update(round({runId:id}));return current;});
 await microtasks();assert.equal(calls,3);assert.equal(views[0]!.getState().error,true);assert.equal(views[1]!.getState().error,true);assert.equal(views[2]!.getState().error,false);assert.equal(views[2]!.getState().report?.runId,'20000000-0000-4000-8000-000000000003');assert.ok(views.every(current=>!current.getState().loading));
});
