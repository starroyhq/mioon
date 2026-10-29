import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {agentTaskGoalsSchema,agentTaskChecksSchema} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskGoalCondition,AgentTaskJson,AgentTaskStep} from '../packages/contracts/src/agent-tasks-v2.ts';
import {AGENT_TASK_GOAL_SET_PARAMETERS,evaluateAgentTaskGoals,latestAgentTaskGoals,normalizeAgentTaskGoals} from '../packages/business/src/agent/task-goals-v2.ts';
import type {TaskGoalObservation,TaskSavedGoals} from '../packages/business/src/agent/task-goals-v2.ts';
import {readAgentTaskChecks} from '../packages/business/src/agent/task-checks-v2.ts';
import {openStore} from '../packages/business/src/db.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createServices} from '../packages/business/src/services.ts';

const goals=(condition:AgentTaskGoalCondition):TaskSavedGoals=>({stepId:randomUUID(),conditions:[condition]});
function observation(durationFrames=900):TaskGoalObservation{
 const owner=(kind:'timeline'|'project'|'run')=>{const id=randomUUID();return {target:{kind,id},basis:[{kind,id,revision:1}]};};
 return {timeline:{...owner('timeline'),values:{durationFrames,fps:30}},project:owner('project'),run:owner('run'),checks:[],steps:[],exports:[]};
}
test('H4b duration forms normalize deterministically while saved legacy seconds remain byte compatible',()=>{
 assert.equal(JSON.stringify(normalizeAgentTaskGoals({conditions:[{type:'duration',seconds:30}]})),'{"conditions":[{"type":"duration","seconds":30,"toleranceSeconds":0}]}');
 assert.equal(JSON.stringify(normalizeAgentTaskGoals({conditions:[{type:'duration',seconds:30,toleranceSeconds:1}]})),'{"conditions":[{"type":"duration","seconds":30,"toleranceSeconds":1}]}');
 for(const value of [{minSeconds:0},{maxSeconds:30},{minSeconds:10,maxSeconds:30},{minSeconds:0,maxSeconds:0}]){
  const input={conditions:[{type:'duration',...value}]},before=structuredClone(input),normalized=normalizeAgentTaskGoals(input);
  assert.deepEqual(normalized,input);assert.deepEqual(input,before);assert.notEqual(normalized?.conditions,input.conditions);
  assert.deepEqual(normalizeAgentTaskGoals(normalized),normalized);assert.equal(agentTaskGoalsSchema.safeParse(normalized).success,true);
 }
 assert.equal(JSON.stringify(normalizeAgentTaskGoals({conditions:[{maxSeconds:30,type:'duration',minSeconds:10}]})),'{"conditions":[{"type":"duration","minSeconds":10,"maxSeconds":30}]}');
});
test('H4b duration bounds reject missing, mixed, reversed and nonfinite declarations without coercion',()=>{
 const invalid=[{},{toleranceSeconds:1},{seconds:30,minSeconds:1},{seconds:30,maxSeconds:31},{minSeconds:1,toleranceSeconds:0},{maxSeconds:30,toleranceSeconds:1},{minSeconds:31,maxSeconds:30},{minSeconds:-1},{maxSeconds:-1},{minSeconds:Infinity},{maxSeconds:NaN},{minSeconds:Number.MAX_SAFE_INTEGER+1},{maxSeconds:'30'},{minSeconds:null},{maxSeconds:30,approved:true}];
 for(const value of invalid)assert.equal(normalizeAgentTaskGoals({conditions:[{type:'duration',...value}]}),null,JSON.stringify(value));
 assert.ok(normalizeAgentTaskGoals({conditions:[{type:'duration',minSeconds:0,maxSeconds:Number.MAX_SAFE_INTEGER}]}));
});
test('H4b duration tool schema adds a separate closed range form without changing the legacy branch',()=>{
 const branches=AGENT_TASK_GOAL_SET_PARAMETERS.properties.conditions.items.anyOf;
 const legacy=branches[0],range=branches[1];
 assert.deepEqual(legacy,{type:'object',properties:{type:{type:'string',enum:['duration']},seconds:{type:'number',minimum:0,maximum:Number.MAX_SAFE_INTEGER},toleranceSeconds:{type:'number',minimum:0,maximum:Number.MAX_SAFE_INTEGER}},required:['type','seconds'],additionalProperties:false});
 assert.ok(range&&'anyOf' in range);assert.deepEqual(range.anyOf,[{required:['minSeconds']},{required:['maxSeconds']}]);
 assert.equal(range.additionalProperties,false);assert.ok(Object.hasOwn(range.properties,'minSeconds'));assert.ok(Object.hasOwn(range.properties,'maxSeconds'));
 assert.equal(Object.hasOwn(range.properties,'seconds'),false);assert.equal(Object.hasOwn(range.properties,'toleranceSeconds'),false);
});
test('H4b duration ranges compare inclusive lower and upper bounds in frames with half-frame quantization',()=>{
 for(const range of [{minSeconds:1.25},{maxSeconds:1.25},{minSeconds:1.25,maxSeconds:1.25}]){
  for(const frames of [37,38])assert.equal(evaluateAgentTaskGoals(goals({type:'duration',...range}),observation(frames))[0]?.status,'passed');
 }
 assert.equal(evaluateAgentTaskGoals(goals({type:'duration',minSeconds:1.25}),observation(36))[0]?.status,'failed');
 assert.equal(evaluateAgentTaskGoals(goals({type:'duration',maxSeconds:1.25}),observation(39))[0]?.status,'failed');
 for(const frames of [900,930])assert.equal(evaluateAgentTaskGoals(goals({type:'duration',minSeconds:30,maxSeconds:31}),observation(frames))[0]?.status,'passed');
 for(const frames of [899,931])assert.equal(evaluateAgentTaskGoals(goals({type:'duration',minSeconds:30,maxSeconds:31}),observation(frames))[0]?.status,'failed');
 assert.equal(evaluateAgentTaskGoals(goals({type:'duration',maxSeconds:30}),observation(942))[0]?.status,'failed');
 assert.equal(evaluateAgentTaskGoals(goals({type:'duration',minSeconds:0,maxSeconds:0}),observation(0))[0]?.status,'passed');
 assert.equal(evaluateAgentTaskGoals(goals({type:'duration',maxSeconds:0}),observation(1))[0]?.status,'failed');
});
test('H4b duration decimal bounds use only a tiny roundoff allowance beyond the half frame',()=>{
 const input=observation(123);
 for(const range of [{minSeconds:4.1},{maxSeconds:4.1},{minSeconds:4.1,maxSeconds:4.1}])assert.equal(evaluateAgentTaskGoals(goals({type:'duration',...range}),input)[0]?.status,'passed');
 assert.equal(evaluateAgentTaskGoals(goals({type:'duration',maxSeconds:4}),input)[0]?.status,'failed');
 assert.equal(evaluateAgentTaskGoals(goals({type:'duration',minSeconds:1.25+1e-6/30}),observation(37))[0]?.status,'failed');
 assert.equal(evaluateAgentTaskGoals(goals({type:'duration',maxSeconds:1.25-1e-6/30}),observation(38))[0]?.status,'failed');
});
test('H4b duration range expected values preserve provided bounds and unavailable current data stays pending',()=>{
 for(const range of [{minSeconds:10},{maxSeconds:30},{minSeconds:10,maxSeconds:30}]){
  const declared=goals({type:'duration',...range}),observed=observation(900),result=evaluateAgentTaskGoals(declared,observed)[0]!;
  assert.equal(result.status,'passed');assert.deepEqual(result.expected,range);assert.deepEqual(result.current,{durationFrames:900,fps:30,durationSeconds:30});
  observed.timeline.values={};const missing=evaluateAgentTaskGoals(declared,observed)[0]!;
  assert.equal(missing.status,'pending');assert.deepEqual(missing.expected,range);assert.deepEqual(missing.current,{});
 }
 const legacy=evaluateAgentTaskGoals(goals({type:'duration',seconds:30,toleranceSeconds:1}),observation(900))[0]!;
 assert.deepEqual(legacy.expected,{durationSeconds:30,toleranceSeconds:1});
});
test('H4b old and ranged saved goal receipts keep the same last-valid-call binding',()=>{
 const runId=randomUUID(),stamp='2026-10-29T00:00:00.000Z';
 const step=(position:number,input:AgentTaskJson,result:AgentTaskJson=input):AgentTaskStep=>({id:randomUUID(),runId,position,kind:'tool',status:'completed',createdAt:stamp,updatedAt:stamp,toolCall:{id:randomUUID(),name:'mioon_goal_set',arguments:input},result});
 const old=step(0,{conditions:[{type:'duration',seconds:30}]},{conditions:[{type:'duration',seconds:30,toleranceSeconds:0}]}),ranged=step(1,{conditions:[{type:'duration',maxSeconds:30}]});
 assert.equal(latestAgentTaskGoals([old])?.stepId,old.id);assert.deepEqual(latestAgentTaskGoals([old,ranged])?.conditions,[{type:'duration',maxSeconds:30}]);
 const mismatched=step(2,{conditions:[{type:'duration',maxSeconds:30}]},{conditions:[{type:'duration',maxSeconds:31}]});
 assert.equal(latestAgentTaskGoals([old,ranged,mismatched]),undefined);
});
test('H4b actual checks return duration bounds from the saved receipt without writes or a lazy timeline',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'mioon-duration-ranges-')),store=openStore(root),services=createServices(store,new Map()),tools=createAgentTaskTools({store,services}),projectId=randomUUID(),stamp='2026-10-29T00:00:00.000Z';
 t.after(async()=>{tools.dispose();await services.drain();store.close();await rm(root,{recursive:true,force:true});});
 store.put('projects',{id:projectId,name:'Synthetic range checks',revision:1,createdAt:stamp,updatedAt:stamp});
 const journal=createAgentTaskJournal(store),runId=journal.create({projectId,requestId:randomUUID(),text:'Duration limits',configuration:{}}).run.id;
 const args:AgentTaskJson={conditions:[{type:'duration',maxSeconds:30},{type:'duration',minSeconds:1}]};
 const prepared=tools.prepare({projectId,operation:'mioon_goal_set',input:args});assert.equal(prepared.risk,'read_only');assert.deepEqual(prepared.targets,[]);
 assert.equal(await tools.parameterFeedback({projectId,operation:'mioon_goal_set',input:args}),null);
 assert.ok(await tools.parameterFeedback({projectId,operation:'mioon_goal_set',input:{conditions:[{type:'duration',seconds:30,maxSeconds:30}]}}));
 assert.throws(()=>tools.prepare({projectId,operation:'mioon_goal_set',input:{conditions:[{type:'duration',minSeconds:31,maxSeconds:30}]}}),{code:'VALIDATION_ERROR'});
 const tool=journal.beginStep(runId,{kind:'tool',toolCall:{id:randomUUID(),name:'mioon_goal_set',arguments:args}});journal.markDispatch(runId,tool.id);
 const outcome=await tools.execute(prepared,{runId,stepId:tool.id,requestId:tool.id,beforeEffect:()=>{},recordInside:(result,changes)=>journal.completeStepInside(runId,tool.id,{result,changes})});
 assert.deepEqual(outcome.result,args);assert.deepEqual(outcome.changes,[]);assert.equal(outcome.recorded,false);journal.completeStep(runId,tool.id,{result:outcome.result});
 const before=store.db.prepare('SELECT total_changes() count').get()!.count,actual=await readAgentTaskChecks(store,journal.snapshot(runId));
 assert.deepEqual(actual.requirements?.map(value=>value.expected),[{maxSeconds:30},{minSeconds:1}]);
 assert.deepEqual(actual.requirements?.map(value=>value.status),['passed','failed']);assert.equal(actual.requirements?.[0]?.current.durationSeconds,0);
 assert.deepEqual(agentTaskChecksSchema.parse(actual),actual);assert.deepEqual(await readAgentTaskChecks(store,journal.snapshot(runId)),actual);
 assert.equal(store.db.prepare('SELECT total_changes() count').get()!.count,before);assert.equal(store.db.prepare('SELECT count(*) count FROM timelines WHERE projectId=?').get(projectId)!.count,0);
});
