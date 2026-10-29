import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync,writeFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeAgentTaskGoals,latestAgentTaskGoals,evaluateAgentTaskGoals} from '../packages/business/src/agent/task-goals-v2.ts';
import type {TaskGoalObservation,TaskSavedGoals} from '../packages/business/src/agent/task-goals-v2.ts';
import {agentTaskGoalsSchema,agentTaskChecksSchema,agentTaskStepSchema} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskJson,AgentTaskStep,AgentTaskGoalCondition,AgentTaskCheck} from '../packages/contracts/src/agent-tasks-v2.ts';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {readAgentTaskChecks} from '../packages/business/src/agent/task-checks-v2.ts';
import {setAgentTaskEffectGate} from '../packages/business/src/agent/task-effects-v2.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

const record=(value:unknown):Record<string,unknown>=>{assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;};
const json=(value:unknown):AgentTaskJson=>JSON.parse(JSON.stringify(value));
const goals=(...conditions:AgentTaskGoalCondition[]):TaskSavedGoals=>({stepId:randomUUID(),conditions});
function step(position:number,result:AgentTaskJson,args:AgentTaskJson=result,status:AgentTaskStep['status']='completed'):AgentTaskStep{return {id:randomUUID(),runId:randomUUID(),position,kind:'tool',status,createdAt:'2026-10-29T00:00:00.000Z',updatedAt:'2026-10-29T00:00:00.000Z',toolCall:{id:randomUUID(),name:'mioon_goal_set',arguments:args},result};}
function observation():TaskGoalObservation{
 const owner=(kind:'timeline'|'project'|'run')=>{const id=randomUUID();return {target:{kind,id},basis:[{kind,id,revision:3}]};};
 return {timeline:{...owner('timeline'),values:{width:1920,height:1080,fps:30,durationFrames:942},clipCount:2,subtitleCount:1},project:{...owner('project'),shotCount:3},run:owner('run'),checks:[],steps:[],exports:[]};
}
function check(type:AgentTaskCheck['type'],status:AgentTaskCheck['status'],id=randomUUID(),kind:AgentTaskCheck['target']['kind']='job'):AgentTaskCheck{return {id:`${type}:${id}`,type,source:'host',status,target:{kind,id},basis:[{kind,id,revision:2}]};}

test('H4a goals normalize the closed list into deterministic fresh values and explicit tolerance',()=>{
 const input={conditions:[{seconds:30,type:'duration'},{fps:30,type:'timeline_format',height:1080,width:1920},{height:1080,type:'export_parameters'},{min:2,max:2,type:'clip_count'},{type:'subtitle_count',min:1,max:1},{type:'shot_count',min:3,max:3},{type:'generation_completed'}]};
 const frozen=structuredClone(input),first=normalizeAgentTaskGoals(input);assert.ok(first);assert.deepEqual(input,frozen);
 assert.deepEqual(first.conditions[0],{type:'duration',seconds:30,toleranceSeconds:0});assert.deepEqual(normalizeAgentTaskGoals(first),first);
 assert.notEqual(first.conditions,input.conditions);assert.notEqual(first.conditions[0],input.conditions[0]);
 assert.equal(agentTaskGoalsSchema.safeParse(first).success,true);assert.deepEqual(normalizeAgentTaskGoals({conditions:[]}),{conditions:[]});
});
test('H4a rejects subjective, unknown, oversized and nonfinite conditions without coercion',()=>{
 const invalid=[{conditions:[{type:'pleasant_pacing'}]},{conditions:[{type:'duration',seconds:-1}]},{conditions:[{type:'duration',seconds:NaN}]},{conditions:[{type:'duration',seconds:Infinity}]},{conditions:[{type:'duration',seconds:30,toleranceSeconds:-1}]},{conditions:[{type:'clip_count',min:1.5,max:1.5}]},{conditions:[{type:'timeline_format',width:1920,height:1080,fps:0}]},{conditions:[{type:'export_parameters'}]},{conditions:[{type:'export_parameters',width:1920,codec:'h264'}]},{conditions:[{type:'generation_completed',approved:true}]},{conditions:[{type:'shot_count',count:'3'}]},{conditions:Array.from({length:21},()=>({type:'clip_count',min:1,max:1}))},{conditions:[],projectId:randomUUID()}];
 for(const input of invalid)assert.equal(normalizeAgentTaskGoals(input),null);
 assert.equal(normalizeAgentTaskGoals({conditions:Array.from({length:20},()=>({type:'clip_count',min:1,max:1}))})?.conditions.length,20);
});
test('H4a latest completed receipt wins by position, rejected declarations do not override, and corrupt receipts are withheld',()=>{
 const early=step(1,{conditions:[{type:'clip_count',min:1,max:1}]}),late=step(3,{conditions:[{type:'shot_count',min:2,max:2}]}),rejected=step(4,{conditions:[{type:'shot_count',min:9,max:9}]},undefined,'rejected');
 assert.equal(latestAgentTaskGoals([late,rejected,early])?.stepId,late.id);
 const empty=step(5,{conditions:[]});assert.deepEqual(latestAgentTaskGoals([early,empty]),{stepId:empty.id,conditions:[]});
 const mismatch=step(6,{conditions:[{type:'shot_count',min:8,max:8}]},{conditions:[{type:'shot_count',min:7,max:7}]});assert.equal(latestAgentTaskGoals([early,mismatch]),undefined);
 assert.equal(latestAgentTaskGoals([early,step(7,{conditions:[{type:'arbitrary'}]})]),undefined);
 const defaulted=step(8,{conditions:[{type:'duration',seconds:1,toleranceSeconds:0}]},{conditions:[{type:'duration',seconds:1}]});assert.equal(latestAgentTaskGoals([defaulted])?.conditions[0]?.type,'duration');
});
test('H4a duration, format and counts expose expected/current and inclusive frame-based tolerance',()=>{
 const input=observation(),declared=goals({type:'duration',seconds:30,toleranceSeconds:1},{type:'timeline_format',width:1920,height:1080,fps:30},{type:'clip_count',min:2,max:2},{type:'subtitle_count',min:2,max:2},{type:'shot_count',min:3,max:3});
 const results=evaluateAgentTaskGoals(declared,input);assert.deepEqual(results.map(item=>item.status),['failed','passed','passed','failed','passed']);
 assert.deepEqual(results[0]?.expected,{durationSeconds:30,toleranceSeconds:1});assert.equal(results[0]?.current.durationSeconds,31.4);assert.equal(results[3]?.current.count,1);
 input.timeline.values.durationFrames=933;assert.equal(evaluateAgentTaskGoals(goals({type:'duration',seconds:30,toleranceSeconds:1.1}),input)[0]?.status,'passed');
 input.timeline.values.durationFrames=934;assert.equal(evaluateAgentTaskGoals(goals({type:'duration',seconds:30,toleranceSeconds:1.1}),input)[0]?.status,'failed');
});
test('H4a duration permits half-frame quantization and refuses a whole extra frame',()=>{
 const input=observation();
 for(const [seconds,frames,status] of [[4.1,123,'passed'],[1.25,37,'passed'],[1.25,38,'passed'],[4.0,123,'failed'],[4.1,124,'failed'],[4.1,122,'failed'],[1.25,36,'failed'],[1.25,39,'failed']] as const){
  input.timeline.values.durationFrames=frames;
  assert.equal(evaluateAgentTaskGoals(goals({type:'duration',seconds}),input)[0]?.status,status,`${seconds}s/${frames}frames`);
 }
 input.timeline.values.durationFrames=124;
 assert.equal(evaluateAgentTaskGoals(goals({type:'duration',seconds:4.1,toleranceSeconds:0.01}),input)[0]?.status,'failed','0.3 user frames plus half a frame still excludes a full frame');
 assert.equal(evaluateAgentTaskGoals(goals({type:'duration',seconds:4.1,toleranceSeconds:0.02}),input)[0]?.status,'passed','the explicit 0.6 frames and implicit half-frame are added, not replaced by their maximum');
 input.timeline.values.durationFrames=123;
 assert.equal(evaluateAgentTaskGoals(goals({type:'duration',seconds:(123.5+1e-6)/30}),input)[0]?.status,'failed','epsilon must not extend the half-frame boundary materially');
});
test('H4a duration decimal sweep accepts all real integer-frame goals from 0.1 to 120 seconds',()=>{
 const input=observation(),failures:number[]=[];
 for(let tenth=1;tenth<=1200;tenth++){
  input.timeline.values.durationFrames=tenth*3;
  if(evaluateAgentTaskGoals(goals({type:'duration',seconds:tenth/10}),input)[0]?.status!=='passed')failures.push(tenth);
 }
 assert.deepEqual(failures,[]);
});
test('H4a count ranges normalize min and max and compare inclusive bounds',()=>{
 const input=observation();input.timeline.clipCount=2;input.timeline.subtitleCount=2;input.project.shotCount=2;
 for(const type of ['clip_count','subtitle_count','shot_count'] as const){
  for(const range of [{min:2},{max:2},{min:1,max:3},{min:2,max:2}]){
   const normalized=normalizeAgentTaskGoals({conditions:[{...range,type}]});assert.ok(normalized);
   assert.deepEqual(normalized.conditions,[{type,...range}]);
   const result=evaluateAgentTaskGoals({...normalized,stepId:randomUUID()},input)[0]!;
   assert.equal(result.status,'passed');assert.deepEqual(result.expected,range);assert.deepEqual(result.current,{count:2});
  }
  assert.equal(evaluateAgentTaskGoals(goals({type,min:3}),input)[0]?.status,'failed');
  assert.equal(evaluateAgentTaskGoals(goals({type,max:1}),input)[0]?.status,'failed');
 }
 assert.deepEqual(normalizeAgentTaskGoals({conditions:[{type:'clip_count',max:0,min:0}]}),{conditions:[{type:'clip_count',min:0,max:0}]});
});
test('H4a count ranges strictly reject old exact-count syntax and invalid bounds',()=>{
 for(const type of ['clip_count','subtitle_count','shot_count']){
  for(const fields of [{count:2},{},{min:3,max:2},{min:-1},{max:-1},{min:1.5},{max:Number.MAX_SAFE_INTEGER+1},{min:NaN},{max:Infinity},{min:null},{max:'2'},{min:0,approved:true}])assert.equal(normalizeAgentTaskGoals({conditions:[{type,...fields}]}),null);
  assert.ok(normalizeAgentTaskGoals({conditions:[{type,min:0,max:Number.MAX_SAFE_INTEGER}]}));
 }
});
test('H4a unavailable observations remain pending and never become invented zero measurements',()=>{
 const input=observation();input.timeline.values={};delete input.timeline.clipCount;delete input.timeline.subtitleCount;delete input.project.shotCount;
 const results=evaluateAgentTaskGoals(goals({type:'duration',seconds:0},{type:'timeline_format',width:1920,height:1080,fps:30},{type:'clip_count',min:0,max:0},{type:'subtitle_count',min:0,max:0},{type:'shot_count',min:0,max:0}),input);
 assert.ok(results.every(item=>item.status==='pending'&&Object.keys(item.current).length===0));
});
test('H4a generation completion shares H3 publication and pending/failure results while cost waits do not block it',()=>{
 const input=observation(),declared=goals({type:'generation_completed'}),id=randomUUID();
 assert.equal(evaluateAgentTaskGoals(declared,input)[0]?.status,'failed');
 input.checks=[check('generation_status','pending',id),check('generation_publication','pending',id)];assert.equal(evaluateAgentTaskGoals(declared,input)[0]?.status,'pending');
 input.checks=[check('generation_status','passed',id),check('generation_publication','failed',id)];assert.equal(evaluateAgentTaskGoals(declared,input)[0]?.status,'failed');
 input.checks=[check('generation_status','passed',id),check('generation_publication','passed',id),check('generation_cost','pending',id)];assert.equal(evaluateAgentTaskGoals(declared,input)[0]?.status,'passed');
 input.checks=[...input.checks,check('generation_status','failed'),check('generation_status','pending')];assert.equal(evaluateAgentTaskGoals(declared,input)[0]?.status,'failed');
});
test('H4a export geometry requires the latest exact H3 binding, artifact and receipt checks',()=>{
 const input=observation(),id=randomUUID(),render=step(1,{id});render.toolCall!.name='mioon_timeline_render';input.steps=[render];
 const status=check('export_status','pending',id,'export'),artifact=check('export_artifact','pending',id,'export'),parameters=check('export_parameters','pending',id,'export');parameters.expected={width:1920,height:1080,fps:30,durationFrames:900};
 input.exports=[{stepId:render.id,checks:[status,artifact,parameters]}];const declared=goals({type:'export_parameters',width:1920,fps:30});
 assert.equal(evaluateAgentTaskGoals(declared,input)[0]?.status,'pending');
 status.status=artifact.status=parameters.status='passed';assert.equal(evaluateAgentTaskGoals(declared,input)[0]?.status,'passed');
 parameters.current={width:1080};assert.equal(evaluateAgentTaskGoals(declared,input)[0]?.status,'failed');parameters.current={};
 artifact.status='failed';artifact.reason={code:'ARTIFACT_UNAVAILABLE'};assert.equal(evaluateAgentTaskGoals(declared,input)[0]?.reason?.code,'ARTIFACT_UNAVAILABLE');
 status.status='pending';assert.equal(evaluateAgentTaskGoals(declared,input)[0]?.status,'failed','a known H3 failure is not hidden by a pending status');
 const next=step(2,{id});next.toolCall!.name='mioon_timeline_render';input.steps=[...input.steps,next];assert.equal(evaluateAgentTaskGoals(declared,input)[0]?.status,'failed','an ACK cannot reuse older canonical checks');
});

async function fixture(t:TestContext){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-goal-checks-')),store=openStore(root),services=createServices(store,new Map()),gate=setAgentTaskEffectGate(store.db,()=>{});
 const projectId=String(record(await services.call('project.create',{name:'Goal observation'})).id),journal=createAgentTaskJournal(store),tools=createAgentTaskTools({store,services}),runId=journal.create({projectId,requestId:randomUUID(),text:'Goals',configuration:{}}).run.id;
 const declare=(conditions:AgentTaskGoalCondition[])=>{const args=json({conditions}),tool=journal.beginStep(runId,{kind:'tool',toolCall:{id:randomUUID(),name:'mioon_goal_set',arguments:args}});journal.markDispatch(runId,tool.id);journal.completeStep(runId,tool.id,{result:args});return journal.step(tool.id);};
 const execute=async(name:string,args:AgentTaskJson)=>{const tool=journal.beginStep(runId,{kind:'tool',toolCall:{id:randomUUID(),name,arguments:args}}),prepared=tools.prepare({projectId,operation:name,input:args});journal.markDispatch(runId,tool.id);const outcome=await tools.execute(prepared,{runId,stepId:tool.id,requestId:tool.id,beforeEffect:()=>{},recordInside:(result,changes)=>journal.completeStepInside(runId,tool.id,{result,changes}),appendChangesInside:changes=>journal.appendChangesInside(runId,tool.id,changes)});if(journal.step(tool.id).status!=='completed')journal.completeStep(runId,tool.id,{result:outcome.result,changes:outcome.changes});return journal.step(tool.id);};
 t.after(async()=>{await services.drain();gate();tools.dispose();store.close();rmSync(root,{recursive:true,force:true});});
 return {root,store,services,projectId,journal,runId,declare,execute,read:()=>readAgentTaskChecks(store,journal.snapshot(runId))};
}
test('H4a actual checks add requirements without changing H3 groups or writing/lazily creating a timeline',async t=>{
 const f=await fixture(t);f.declare([{type:'clip_count',min:0,max:0},{type:'duration',seconds:0},{type:'timeline_format',width:1080,height:1920,fps:30},{type:'shot_count',min:0,max:0}]);
 const snapshot=f.journal.snapshot(f.runId),before=f.store.db.prepare('SELECT total_changes() n').get()!.n;
 const legacy=await readAgentTaskChecks(f.store,{...snapshot,steps:snapshot.steps.filter(item=>item.toolCall?.name!=='mioon_goal_set')}),actual=await f.read();
 assert.deepEqual(actual.groups,legacy.groups);assert.equal(legacy.requirements,undefined);assert.ok(actual.requirements?.every(item=>item.status==='passed'));
 assert.equal(agentTaskChecksSchema.safeParse(actual).success,true);assert.deepEqual(await f.read(),actual);
 assert.equal(f.store.db.prepare('SELECT total_changes() n').get()!.n,before);assert.equal(f.store.db.prepare('SELECT count(*) n FROM timelines WHERE projectId=?').get(f.projectId)!.n,0);
 f.declare([]);assert.equal((await f.read()).requirements,undefined);
});
test('H4a actual timeline, subtitle and shot counts refresh from current saved project state',async t=>{
 const f=await fixture(t),assetId=randomUUID(),bytes=png({width:64,height:64}),relativePath=`media/${assetId}.png`;writeFileSync(join(f.root,relativePath),bytes);
 f.store.put('assets',{id:assetId,projectId:f.projectId,name:'Still',mimeType:'image/png',relativePath,sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),width:64,height:64,provenance:'user-import',createdAt:new Date().toISOString()});
 const timeline=record(await f.services.call('timeline.get',{projectId:f.projectId}));assert.ok(Array.isArray(timeline.tracks));
 await f.execute('mioon_timeline_clip_add',{expectedRevision:Number(timeline.revision),assetId,trackId:String(record(timeline.tracks[0]).id),startFrame:0,durationFrames:942});
 const saved=record(await f.services.call('timeline.get',{projectId:f.projectId}));
 await f.services.call('timeline.subtitle.add',{projectId:f.projectId,requestId:randomUUID(),expectedRevision:Number(saved.revision),startFrame:0,durationFrames:30,text:'Hello'});
 f.declare([{type:'duration',seconds:30,toleranceSeconds:1},{type:'clip_count',min:1,max:1},{type:'subtitle_count',min:1,max:1},{type:'shot_count',min:1,max:1}]);
 let actual=await f.read();assert.deepEqual(actual.requirements?.map(item=>item.status),['failed','passed','passed','failed']);assert.equal(actual.requirements?.[0]?.current.durationSeconds,31.4);
 await f.services.call('shot.create',{projectId:f.projectId,title:'One'});actual=await f.read();assert.equal(actual.requirements?.[3]?.status,'passed');
 for(const startFrame of [30,60]){
  const latest=record(await f.services.call('timeline.get',{projectId:f.projectId}));
  await f.services.call('timeline.subtitle.add',{projectId:f.projectId,requestId:randomUUID(),expectedRevision:Number(latest.revision),startFrame,durationFrames:30,text:'Next line'});
 }
 f.declare([{type:'subtitle_count',min:1},{type:'subtitle_count',max:3},{type:'subtitle_count',min:3,max:3},{type:'subtitle_count',max:2},{type:'subtitle_count',min:1,max:1}]);
 actual=await f.read();assert.deepEqual(actual.requirements?.map(item=>item.status),['passed','passed','passed','failed','failed']);
 assert.deepEqual(actual.requirements?.map(item=>item.expected),[{min:1},{max:3},{min:3,max:3},{max:2},{min:1,max:1}]);
 assert.deepEqual(actual.requirements?.map(item=>item.current),Array.from({length:5},()=>({count:3})));
 const before=f.store.db.prepare('SELECT total_changes() n').get()!.n;assert.deepEqual(await f.read(),actual);assert.equal(f.store.db.prepare('SELECT total_changes() n').get()!.n,before);
});
test('H4a malformed saved timeline stays pending and diagnostic reads expose no requirements',async t=>{
 const f=await fixture(t),saved=record(await f.services.call('timeline.get',{projectId:f.projectId}));
 f.store.put('timelines',{...saved,clips:null});f.declare([{type:'clip_count',min:0,max:0},{type:'duration',seconds:0}]);
 const before=f.store.db.prepare('SELECT total_changes() n').get()!.n,actual=await f.read();
 assert.deepEqual(actual.requirements?.map(item=>item.status),['pending','pending']);assert.ok(actual.requirements?.every(item=>Object.keys(item.current).length===0));
 const snapshot=f.journal.snapshot(f.runId);assert.equal((await readAgentTaskChecks(f.store,{...snapshot,run:{...snapshot.run,diagnostic:{profile:'text'}}})).requirements,undefined);
 assert.equal(f.store.db.prepare('SELECT total_changes() n').get()!.n,before);
});
test('H4a actual generation requirement follows host task and publication observations',async t=>{
 const f=await fixture(t),shot=record(await f.services.call('shot.create',{projectId:f.projectId,title:'One'})),jobId=randomUUID();
 const source=f.journal.beginStep(f.runId,{kind:'tool',toolCall:{id:randomUUID(),name:'mioon_generation_submit',arguments:{shotId:String(shot.id)}}});
 f.journal.markDispatch(f.runId,source.id);f.journal.completeStep(f.runId,source.id,{result:{id:jobId}});
 const saved={id:jobId,projectId:f.projectId,requestId:source.id,shotId:shot.id,status:'running',providerId:'mock',model:'mock-v1',progress:50,revision:1};f.store.put('jobs',saved);
 f.declare([{type:'generation_completed'}]);assert.equal((await f.read()).requirements?.[0]?.status,'pending');
 f.store.put('jobs',{...saved,status:'succeeded'});const unpublished=await f.read();assert.equal(unpublished.requirements?.[0]?.status,'failed');assert.equal(unpublished.requirements?.[0]?.reason?.code,'VERSION_UNPUBLISHED');
 f.store.put('jobs',{...saved,status:'failed'});assert.equal((await f.read()).requirements?.[0]?.status,'failed');
 const snapshot=f.journal.snapshot(f.runId),actual=await f.read(),legacy=await readAgentTaskChecks(f.store,{...snapshot,steps:snapshot.steps.filter(item=>item.toolCall?.name!=='mioon_goal_set')});assert.deepEqual(actual.groups,legacy.groups);
});
for(const ranged of [false,true])test(`H4a actual ${ranged?'ranged profile':'full native'} export checks cannot pass a missing managed artifact or mismatched saved request`,async t=>{
 const f=await fixture(t),sourceId=randomUUID(),bytes=png({width:64,height:64}),sourcePath=`media/${sourceId}.png`;writeFileSync(join(f.root,sourcePath),bytes);
 f.store.put('assets',{id:sourceId,projectId:f.projectId,name:'Still',mimeType:'image/png',relativePath:sourcePath,sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),width:64,height:64,provenance:'user-import',createdAt:new Date().toISOString()});
 const timeline=record(await f.services.call('timeline.get',{projectId:f.projectId}));assert.ok(Array.isArray(timeline.tracks));await f.execute('mioon_timeline_clip_add',{expectedRevision:Number(timeline.revision),assetId:sourceId,trackId:String(record(timeline.tracks[0]).id),startFrame:0,durationFrames:60});
 const saved=record(await f.services.call('timeline.get',{projectId:f.projectId})),renderInput={expectedRevision:Number(saved.revision),purpose:'export',...(ranged?{exportRange:{startFrame:10,endFrame:40},exportSettings:{profileId:'mp4_h264_v1',resolution:'native',rateControl:{mode:'crf',quality:'standard'}}}:{})},render=await f.execute('mioon_timeline_render',renderInput),id=String(record(render.result).id);
 f.declare([{type:'export_parameters',width:Number(saved.width),height:Number(saved.height),fps:30,durationFrames:ranged?30:60}]);assert.equal((await f.read()).requirements?.[0]?.status,'pending');
 const assetId=randomUUID(),output=Buffer.from('SYNTHETIC_EXPORT_ONLY'),relativePath=`media/export-${id}-${randomUUID()}.mp4`;writeFileSync(join(f.root,relativePath),output);
 f.store.put('assets',{id:assetId,projectId:f.projectId,name:'Export',mimeType:'video/mp4',relativePath,sizeBytes:output.length,sha256:createHash('sha256').update(output).digest('hex'),width:saved.width,height:saved.height,duration:1,provenance:'export',createdAt:new Date().toISOString()});
 f.store.put('exports',{...record(f.store.get('exports',id)),status:'succeeded',assetId,url:`/media/${assetId}`,updatedAt:new Date().toISOString()});
 const actual=await f.read();assert.equal(actual.requirements?.[0]?.status,'passed');assert.equal(actual.requirements?.[0]?.current.durationFrames,ranged?30:60);assert.equal(actual.requirements?.[0]?.current.status,'accepted_parameters');
 const snapshot=f.journal.snapshot(f.runId),legacy=await readAgentTaskChecks(f.store,{...snapshot,steps:snapshot.steps.filter(item=>item.toolCall?.name!=='mioon_goal_set')});assert.deepEqual(actual.groups,legacy.groups);
 unlinkSync(join(f.root,relativePath));assert.equal((await f.read()).requirements?.[0]?.status,'failed');writeFileSync(join(f.root,relativePath),output);
 const mismatched=f.journal.snapshot(f.runId),source=mismatched.steps.find(item=>item.id===render.id);assert.ok(source?.toolCall);
 source.toolCall.arguments={...renderInput,expectedRevision:Number(saved.revision)+1};
 assert.equal((await readAgentTaskChecks(f.store,mismatched)).requirements?.[0]?.status,'failed');
});
test('H4a public repair provenance is optional, strict and UUID bound',()=>{
 const original=step(1,{conditions:[]});assert.equal(agentTaskStepSchema.safeParse(original).success,true);
 assert.equal(agentTaskStepSchema.safeParse({...original,repair:{sourceModelStepId:randomUUID()}}).success,true);
 assert.equal(agentTaskStepSchema.safeParse({...original,repair:{sourceModelStepId:'not-an-id'}}).success,false);
 assert.equal(agentTaskStepSchema.safeParse({...original,repair:{sourceModelStepId:randomUUID(),approved:true}}).success,false);
});
