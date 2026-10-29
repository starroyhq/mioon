import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createAgentTaskChecksCache,createAgentTaskChecksView} from '../apps/web/src/agent-task-checks-state.ts';
import type {AgentTaskChecksReader,AgentTaskChecksRound} from '../apps/web/src/agent-task-checks-state.ts';
import type {AgentTaskChecksReadOptions} from '../apps/web/src/agent-tasks-v2.ts';
import type {AgentTaskChecks,AgentTaskRequirement} from '../packages/contracts/src/agent-task-checks-v2.ts';

const projectId='10000000-0000-4000-8000-000000000001',runId='20000000-0000-4000-8000-000000000001',otherRun='20000000-0000-4000-8000-000000000002';
const timelineId='30000000-0000-4000-8000-000000000001',goalStepId='40000000-0000-4000-8000-000000000001',replacementGoalStepId='40000000-0000-4000-8000-000000000002';
const round=(patch:Partial<AgentTaskChecksRound>={}):AgentTaskChecksRound=>({runId,runRevision:1,completed:false,repairing:true,latest:false,backgroundPending:false,visible:true,attached:true,...patch});
function report({id=runId,revision=1,goal='failed',goalId=goalStepId,preflight}:{id?:string;revision?:number;goal?:AgentTaskRequirement['status'];goalId?:string;preflight?:'not_requested'|'passed'}={}):AgentTaskChecks{
 return {projectId,runId:id,runRevision:revision,requirements:[{
  id:`goal:${goalId}:0`,type:'duration',source:'goal',goalStepId:goalId,status:goal,
  target:{kind:'timeline',id:timelineId},basis:[{kind:'timeline',id:timelineId,revision:1}],expected:{maxSeconds:30},
  current:goal==='pending'?{}:{durationFrames:goal==='failed'?942:900,fps:30,durationSeconds:goal==='failed'?31.4:30},
  ...(goal==='failed'?{reason:{code:'PARAMETERS_MISMATCH' as const}}:goal==='pending'?{reason:{code:'RECORD_UNAVAILABLE' as const}}:{}),
 }],groups:[{id:'export_render',items:[]},{id:'generation',items:[]},{id:'timeline',items:[{
  id:`timeline_references:${timelineId}`,type:'timeline_references',source:'host',status:'passed',
  target:{kind:'timeline',id:timelineId},basis:[{kind:'timeline',id:timelineId,revision:1}],current:{count:6},
 },...(preflight?[{
  id:`timeline_preflight:${timelineId}`,type:'timeline_preflight' as const,source:'host' as const,status:preflight==='passed'?'passed' as const:'pending' as const,
  target:{kind:'timeline' as const,id:timelineId},basis:[{kind:'timeline' as const,id:timelineId,revision:1}],
  ...(preflight==='not_requested'?{reason:{code:'PREFLIGHT_NOT_REQUESTED' as const}}:{}),
 }]:[])]},{id:'decomposition_frames',items:[]}]};
}
async function flush(){for(let index=0;index<16;index++)await Promise.resolve();}
interface ReadCall {runId:string;options:AgentTaskChecksReadOptions;resolve:(value:AgentTaskChecks)=>void;reject:(error:unknown)=>void}
function deferredReader({honorAbort=true}:{honorAbort?:boolean}={}){
 const calls:ReadCall[]=[];
 const read:AgentTaskChecksReader=(requestedProject,id,options={})=>new Promise<AgentTaskChecks>((resolve,reject)=>{
  assert.equal(requestedProject,projectId);
  const clean=()=>options.signal?.removeEventListener('abort',abort),finish=(value:AgentTaskChecks)=>{clean();resolve(value);},fail=(error:unknown)=>{clean();reject(error);};
  const abort=()=>fail(new DOMException('Synthetic requirement read cancellation','AbortError'));
  calls.push({runId:id,options,resolve:finish,reject:fail});
  if(honorAbort){if(options.signal?.aborted)abort();else options.signal?.addEventListener('abort',abort,{once:true});}
 });
 return {read,calls};
}
function fixture(t:TestContext,{honorAbort=true}:{honorAbort?:boolean}={}){
 const reader=deferredReader({honorAbort}),current=createAgentTaskChecksView({scope:'requirements-reader',projectId,read:reader.read,cache:createAgentTaskChecksCache()});
 t.after(()=>current.dispose());return {current,...reader};
}

test('H4b a repairing round reads lightly only while attached and visible',async t=>{
 const f=fixture(t);
 f.current.update(round({repairing:false}));await f.current.recheck();await flush();assert.equal(f.calls.length,0);
 f.current.update(round({visible:false}));await f.current.recheck();await flush();assert.equal(f.calls.length,0);
 f.current.update(round({attached:false}));await f.current.recheck();await flush();assert.equal(f.calls.length,0);
 f.current.update(round());await flush();assert.equal(f.calls.length,1);assert.equal(f.calls[0]!.options.preflight,false);
 f.calls[0]!.resolve(report());await flush();assert.equal(f.current.getState().report?.requirements?.[0]?.status,'failed');assert.equal(f.current.getState().loading,false);
});

test('H4b repair revision updates refresh lightly without starting automatic full preflight',async t=>{
 const f=fixture(t);f.current.update(round({latest:true}));await flush();
 f.calls[0]!.resolve(report({preflight:'not_requested'}));await flush();assert.equal(f.calls.length,1);
 f.current.update(round({latest:true,runRevision:2}));await flush();assert.equal(f.calls.length,2);
 f.calls[1]!.resolve(report({revision:2,preflight:'not_requested'}));await flush();assert.equal(f.current.getState().report?.runRevision,2);
 f.current.update(round({latest:true,runRevision:2}));await flush();assert.equal(f.calls.length,2);assert.ok(f.calls.every(call=>call.options.preflight===false));
});

test('H4b repair completion enables one automatic full preflight after the completion light read',async t=>{
 const f=fixture(t);f.current.update(round({latest:true}));await flush();f.calls[0]!.resolve(report({preflight:'not_requested'}));await flush();
 assert.equal(f.calls.length,1);f.current.update(round({completed:true,repairing:false,latest:true,runRevision:2}));await flush();
 assert.equal(f.calls.length,2);assert.equal(f.calls[1]!.options.preflight,false);
 f.calls[1]!.resolve(report({revision:2,preflight:'not_requested',goal:'passed'}));await flush();assert.equal(f.calls.length,3);assert.equal(f.calls[2]!.options.preflight,true);
 f.calls[2]!.resolve(report({revision:2,preflight:'passed',goal:'passed'}));await flush();assert.equal(f.current.getState().preflighting,false);assert.equal(f.current.getState().justChecked,false);
 f.current.update(round({completed:true,repairing:false,latest:true,runRevision:2}));await flush();assert.equal(f.calls.length,3);
 f.current.update(round({completed:true,repairing:false,latest:true,runRevision:3}));await flush();assert.equal(f.calls.length,4);
 f.calls[3]!.resolve(report({revision:3,preflight:'not_requested',goal:'passed'}));await flush();assert.equal(f.calls.length,4);assert.equal(f.calls.filter(call=>call.options.preflight).length,1);
});

test('H4b pending requirements alone keep the five-second fallback alive and stop when settled',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t);
 f.current.update(round({completed:true,repairing:false}));await flush();f.calls[0]!.resolve(report({goal:'pending'}));await flush();
 assert.ok(f.current.getState().report?.groups.flatMap(group=>group.items).every(item=>item.status==='passed'));
 t.mock.timers.tick(4999);await flush();assert.equal(f.calls.length,1);t.mock.timers.tick(1);await flush();assert.equal(f.calls.length,2);assert.equal(f.calls[1]!.options.preflight,false);
 f.calls[1]!.resolve(report({goal:'passed'}));await flush();t.mock.timers.tick(15000);await flush();assert.equal(f.calls.length,2);
});

test('H4b active repair polls failed requirements and stops after detachment without accepting a late result',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t,{honorAbort:false});
 f.current.update(round());await flush();f.calls[0]!.resolve(report());await flush();
 t.mock.timers.tick(5000);await flush();assert.equal(f.calls.length,2);assert.equal(f.calls[1]!.options.preflight,false);
 f.current.update(round({repairing:false,attached:false}));await flush();assert.equal(f.calls[1]!.options.signal?.aborted,true);
 f.calls[1]!.resolve(report({goal:'passed'}));await flush();assert.equal(f.current.getState().report?.requirements?.[0]?.status,'failed');assert.equal(f.current.getState().loading,false);
 t.mock.timers.tick(15000);await flush();assert.equal(f.calls.length,2);
});

test('H4b hidden and old repair responses cannot populate the newly selected round',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t,{honorAbort:false});
 f.current.update(round());await flush();const hidden=f.calls[0]!;
 f.current.update(round({visible:false}));await flush();assert.equal(hidden.options.signal?.aborted,true);
 f.current.update(round({runId:otherRun,runRevision:2}));await flush();assert.equal(f.calls.length,2);assert.equal(f.calls[1]!.runId,otherRun);
 hidden.resolve(report({goal:'passed'}));await flush();assert.equal(f.current.getState().report,null);
 f.calls[1]!.resolve(report({id:otherRun,revision:2}));await flush();assert.equal(f.current.getState().report?.runId,otherRun);
 f.current.update(round({runId:otherRun,runRevision:2,visible:false}));t.mock.timers.tick(15000);await flush();assert.equal(f.calls.length,2);
});

test('H4b manual full preflight survives repair completion, revision changes and hiding',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t);
 f.current.update(round({latest:true,backgroundPending:true}));await flush();f.calls[0]!.resolve(report());await flush();
 const manual=f.current.recheck();await flush();const full=f.calls[1]!;assert.equal(full.options.preflight,true);
 f.current.update(round({completed:true,repairing:false,latest:true,runRevision:2,backgroundPending:false,visible:false}));t.mock.timers.tick(10000);await flush();
 assert.equal(full.options.signal?.aborted,false);assert.equal(f.calls.length,2);assert.equal(f.current.getState().preflighting,true);
 full.resolve(report({preflight:'passed',goal:'passed'}));await manual;await flush();assert.equal(f.current.getState().justChecked,true);assert.equal(f.current.getState().preflighting,false);
 t.mock.timers.tick(15000);await flush();assert.equal(f.calls.length,2);
 f.current.update(round({completed:true,repairing:false,latest:true,runRevision:2}));await flush();assert.equal(f.calls.length,3);assert.equal(f.calls[2]!.options.preflight,false);
 f.calls[2]!.resolve(report({revision:2,preflight:'not_requested',goal:'passed'}));await flush();assert.equal(f.calls.length,3);
});

test('H4b pausing out of repair cancels its manual full preflight and late completion stays inert',async t=>{
 const f=fixture(t,{honorAbort:false});f.current.update(round());await flush();f.calls[0]!.resolve(report());await flush();
 const manual=f.current.recheck();await flush();const full=f.calls[1]!;
 f.current.update(round({repairing:false,attached:false}));await flush();assert.equal(full.options.signal?.aborted,true);assert.equal(f.current.getState().preflighting,false);
 full.resolve(report({goal:'passed',preflight:'passed'}));await manual;await flush();assert.equal(f.current.getState().justChecked,false);assert.equal(f.current.getState().report?.requirements?.[0]?.status,'failed');assert.equal(f.calls.length,2);
});

test('H4b a visible repair finishing with replaced goals performs exactly one light read after the old full preflight',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t);
 f.current.update(round({latest:true,goalStepId}));await flush();f.calls[0]!.resolve(report({preflight:'not_requested'}));await flush();
 const manual=f.current.recheck();await flush();const full=f.calls[1]!;assert.equal(full.options.preflight,true);
 const completed=round({latest:true,completed:true,repairing:false,runRevision:2,goalStepId:replacementGoalStepId});
 f.current.update(completed);await flush();assert.equal(full.options.signal?.aborted,false);assert.equal(f.calls.length,2);
 full.resolve(report({goal:'passed',preflight:'passed'}));await manual;await flush();
 assert.equal(f.calls.length,3);assert.equal(f.calls[2]!.options.preflight,false);assert.equal(f.current.getState().loading,true);
 f.calls[2]!.resolve(report({revision:2,goalId:replacementGoalStepId,preflight:'not_requested'}));await flush();
 assert.equal(f.current.getState().report?.requirements?.[0]?.goalStepId,replacementGoalStepId);assert.equal(f.current.getState().report?.requirements?.[0]?.status,'failed');
 assert.equal(f.current.getState().report?.runRevision,2);assert.equal(f.current.getState().loading,false);
 f.current.update(completed);t.mock.timers.tick(15000);await flush();assert.equal(f.calls.length,3,'the old all-passed report must neither suppress nor repeat the replacement read');
});

test('H4b a hidden goal replacement waits for visibility before consuming its one post-full light read',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t);
 f.current.update(round({goalStepId}));await flush();f.calls[0]!.resolve(report());await flush();
 const manual=f.current.recheck();await flush();const full=f.calls[1]!;
 const completed=round({completed:true,repairing:false,runRevision:2,goalStepId:replacementGoalStepId});
 f.current.update({...completed,visible:false});await flush();assert.equal(full.options.signal?.aborted,false);
 full.resolve(report({goal:'passed',preflight:'passed'}));await manual;await flush();t.mock.timers.tick(20000);await flush();assert.equal(f.calls.length,2);
 f.current.update(completed);await flush();assert.equal(f.calls.length,3);assert.equal(f.calls[2]!.options.preflight,false);
 f.calls[2]!.resolve(report({revision:2,goalId:replacementGoalStepId,goal:'passed',preflight:'passed'}));await flush();
 assert.equal(f.current.getState().report?.requirements?.[0]?.goalStepId,replacementGoalStepId);
 f.current.update(completed);t.mock.timers.tick(15000);await flush();assert.equal(f.calls.length,3);
});

test('H4b switching rounds discards a queued goal refresh and an obsolete full result cannot overwrite the new round',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t,{honorAbort:false});
 f.current.update(round({goalStepId}));await flush();f.calls[0]!.resolve(report());await flush();
 const manual=f.current.recheck();await flush();const full=f.calls[1]!;
 f.current.update(round({goalStepId:replacementGoalStepId}));await flush();assert.equal(full.options.signal?.aborted,false);assert.equal(f.calls.length,2);
 const selected=round({runId:otherRun,runRevision:3,completed:true,repairing:false,goalStepId:replacementGoalStepId});
 f.current.update(selected);await flush();assert.equal(full.options.signal?.aborted,true);assert.equal(f.calls.length,3);assert.equal(f.calls[2]!.runId,otherRun);
 const currentReport=report({id:otherRun,revision:3,goalId:replacementGoalStepId,goal:'passed',preflight:'passed'});
 f.calls[2]!.resolve(currentReport);await flush();assert.deepEqual(f.current.getState().report,currentReport);
 full.resolve(report({goal:'passed',preflight:'passed'}));await manual;await flush();assert.deepEqual(f.current.getState().report,currentReport);
 f.current.update(selected);t.mock.timers.tick(15000);await flush();assert.equal(f.calls.length,3);
});
