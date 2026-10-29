import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtempSync,realpathSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {agentTaskSnapshotSchema} from '../packages/contracts/src/agent-tasks-v2.ts';
import {GOAL_PROTOCOLS,openGoalRepairFixture,setCountGoal,goalCall} from './helpers/agent-task-goal-repair-fixture.ts';
import type {GoalProtocol} from './helpers/agent-task-goal-repair-fixture.ts';
import type {AgentTaskStep} from '../packages/contracts/src/agent-tasks-v2.ts';
const record=(value:unknown):Record<string,unknown>=>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;};
const markers=(steps:AgentTaskStep[])=>steps.filter(step=>step.data&&record(step.data).goalRepair!==undefined);
async function fixture(t:TestContext,protocol:GoalProtocol){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-goal-repair-')),f=await openGoalRepairFixture(root,protocol);
 t.after(async()=>{await f.close();rmSync(root,{recursive:true,force:true});});return f;
}
for(const protocol of GOAL_PROTOCOLS){
 test(`${protocol}: an unmet goal adds exactly one model step and exposes only repair provenance`,async t=>{
  const f=await fixture(t,protocol);f.plan(index=>index===1?[setCountGoal(2)]:[]);
  const done=await f.send();assert.equal(done.run.status,'completed');assert.equal(done.run.stepsUsed,4);assert.equal(f.bodies.length,3);
  const raw=f.runtime.journal.snapshot(done.run.id),marked=markers(raw.steps);assert.equal(marked.length,1);
  const repair=done.steps.filter(step=>step.repair);assert.equal(repair.length,1);assert.equal(repair[0]!.kind,'model');assert.equal(repair[0]!.repair!.sourceModelStepId,marked[0]!.id);
  assert.equal(done.steps.some(step=>step.data!==undefined||step.request!==undefined),false);agentTaskSnapshotSchema.parse(done);
  assert.equal((f.bodies[2]!.match(/mio\.goal\.repair/gu)??[]).length,1);assert.match(f.bodies[2]!,/仅供参考|for reference only/u);
  const checks=await f.runtime.checks(f.projectId,done.run.id);assert.equal(checks.requirements?.[0]?.status,'failed');
 });
 test(`${protocol}: one repair can satisfy the declared goal through an ordinary reversible tool`,async t=>{
  const f=await fixture(t,protocol);f.plan(index=>index===1?[setCountGoal(2)]:index===3?[goalCall('mioon_tools_load',{groups:['canvas']})]:index===4?[goalCall('mioon_shot_create',{title:'Second shot from repair',duration:2,prompt:'Local repair only'})]:[]);
  const done=await f.send();assert.equal(done.run.status,'completed');assert.equal(done.run.stepsUsed,8);assert.equal(f.bodies.length,5);assert.equal(f.store.list('shots',f.projectId).length,2);
  assert.equal((await f.runtime.checks(f.projectId,done.run.id)).requirements?.[0]?.status,'passed');
  const edit=done.steps.find(step=>step.toolCall?.name==='mioon_shot_create')!;assert.equal(edit.status,'completed');assert.equal(edit.tier,'local_reversible');assert.ok(edit.repair);
  assert.ok(done.changes.some(change=>change.stepId===edit.id));assert.equal(done.steps.filter(step=>step.repair).length,5);assert.equal(markers(f.runtime.journal.snapshot(done.run.id).steps).length,1);
 });
 test(`${protocol}: satisfied, cleared and last-set goals do not request a repair`,async t=>{
  const f=await fixture(t,protocol);f.plan(index=>index===1?[setCountGoal(2),setCountGoal(1)]:[]);
  const done=await f.send();assert.equal(done.run.status,'completed');assert.equal(done.run.stepsUsed,4);assert.equal(f.bodies.length,2);
  assert.equal((await f.runtime.checks(f.projectId,done.run.id)).requirements?.[0]?.status,'passed');
  f.plan(index=>index===3?[setCountGoal(2),goalCall('mioon_goal_set',{conditions:[]})]:[]);
  const cleared=await f.send();assert.equal(cleared.run.status,'completed');assert.equal(f.bodies.length,4);assert.equal(markers(f.runtime.journal.snapshot(cleared.run.id).steps).length,0);
 });
 test(`${protocol}: three saved shots satisfy inclusive minimum, maximum and exact goals without an unnecessary repair`,async t=>{
  const f=await fixture(t,protocol);
  for(const title of ['Second saved shot','Third saved shot'])await f.services.call('shot.create',{projectId:f.projectId,title});
  assert.equal(f.store.list('shots',f.projectId).length,3);
  const cases:Array<{bounds:{min?:number;max?:number};status:'passed'|'failed'}>=[
   {bounds:{min:1},status:'passed'},
   {bounds:{max:3},status:'passed'},
   {bounds:{max:2},status:'failed'},
   {bounds:{min:3,max:3},status:'passed'},
   {bounds:{min:2,max:2},status:'failed'},
  ];
  for(const {bounds,status} of cases){
   const before=f.bodies.length;f.plan(index=>index===before+1?[goalCall('mioon_goal_set',{conditions:[{type:'shot_count',...bounds}]})]:[]);
   const done=await f.send(),requirement=(await f.runtime.checks(f.projectId,done.run.id)).requirements?.[0];
   assert.equal(done.run.status,'completed');assert.equal(requirement?.status,status);assert.deepEqual(requirement?.expected,bounds);assert.deepEqual(requirement?.current,{count:3});
   assert.equal(f.bodies.length-before,status==='passed'?2:3);assert.equal(done.run.stepsUsed,status==='passed'?3:4);
   assert.equal(markers(f.runtime.journal.snapshot(done.run.id).steps).length,status==='passed'?0:1);
   assert.equal(done.changes.length,0);assert.equal(f.store.list('shots',f.projectId).length,3);
  }
 });
 test(`${protocol}: invalid conditions use parameter correction and cannot replace a valid goal`,async t=>{
  const f=await fixture(t,protocol);f.plan(index=>index===1?[setCountGoal(2),goalCall('mioon_goal_set',{conditions:[{type:'arbitrary',sql:'select *'}]})]:[]);
  const done=await f.send();assert.equal(done.run.status,'completed');assert.equal(f.bodies.length,3);
  const rejected=done.steps.find(step=>step.status==='rejected');assert.equal(rejected?.error?.code,'VALIDATION_ERROR');
  assert.equal(markers(f.runtime.journal.snapshot(done.run.id).steps).length,1);assert.match(f.bodies[1]!,/VALIDATION_ERROR/u);
 });
 test(`${protocol}: budget exhaustion and a new conversation round cannot start a repair`,async t=>{
  const f=await fixture(t,protocol);f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:3,modes:f.runtime.policy().modes});
  f.plan(index=>index===1?[setCountGoal(2)]:[]);const done=await f.send();assert.equal(done.run.status,'completed');assert.equal(done.run.stepsUsed,3);assert.equal(f.bodies.length,2);assert.equal(markers(f.runtime.journal.snapshot(done.run.id).steps).length,0);
  const next=await f.send({conversationId:done.run.conversationId});assert.equal(next.run.status,'completed');assert.equal(next.run.stepsUsed,1);assert.equal(f.bodies.length,3);assert.equal(markers(f.runtime.journal.snapshot(next.run.id).steps).length,0);
 });
 for(const mixed of [false,true])test(`${protocol}: ${mixed?'an unmet requirement beside pending generation repairs once':'pending generation alone does not trigger a repair'}`,async t=>{
  const f=await fixture(t,protocol),policy=f.runtime.policy();f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:policy.revision,stepLimit:30,modes:{...policy.modes,paid:'direct'},acknowledgePaid:true});
  const shot=record(f.store.list('shots',f.projectId)[0]);
  f.plan(index=>index===1?[goalCall('mioon_goal_set',{conditions:[{type:'generation_completed'},...(mixed?[{type:'shot_count',min:2,max:2}]:[])]}),goalCall('mioon_tools_load',{groups:['video']})]:index===2?[goalCall('mioon_generation_submit',{shotId:String(shot.id),expectedRevision:Number(shot.revision),providerId:'mock',model:'mock-motion-v1'})]:[]);
  const done=await f.send();assert.equal(done.run.status,'completed');assert.equal(f.bodies.length,mixed?4:3);
  const checks=await f.runtime.checks(f.projectId,done.run.id);assert.equal(checks.requirements?.[0]?.status,'pending');assert.equal(markers(f.runtime.journal.snapshot(done.run.id).steps).length,mixed?1:0);
  const job=record(f.store.list('jobs',f.projectId)[0]);assert.equal(job.status,'queued','no worker or provider is dispatched by host checks');
 });
 test(`${protocol}: an unanswered question blocks repair; an answer stays in the repair context`,async t=>{
  const f=await fixture(t,protocol);f.plan(index=>index===1?[setCountGoal(2),goalCall('mioon_ask',{question:'Which opening?',options:[{label:'Wide'},{label:'Close'}]})]:[]);
  const waiting=await f.send();assert.equal(waiting.run.status,'awaiting_answer');assert.equal(f.bodies.length,1);assert.equal(markers(f.runtime.journal.snapshot(waiting.run.id).steps).length,0);
  const ask=waiting.steps.find(step=>step.status==='awaiting_answer')!;const done=await f.action(waiting.run.id,'answer',{stepId:ask.id,choices:[1]});
  assert.equal(done.run.status,'completed');assert.equal(f.bodies.length,3);assert.match(f.bodies[2]!,/Which opening\?/u);assert.match(f.bodies[2]!,/Close/u);assert.equal(markers(f.runtime.journal.snapshot(done.run.id).steps).length,1);
 });
 test(`${protocol}: a note accepted during the final reply is handled before one repair`,async t=>{
  const f=await fixture(t,protocol);let runId='';
  f.plan(async index=>{
   if(index===1){runId=f.runtime.journal.list(f.projectId)[0]!.id;return [setCountGoal(2)];}
   if(index===2){const run=f.runtime.get(f.projectId,runId).run;await f.runtime.action(f.projectId,runId,{requestId:randomUUID(),expectedRevision:run.revision,action:'note',text:'Keep the opening line exactly.'});}
   return [];
  });
  const done=await f.send();assert.equal(done.run.status,'completed');assert.equal(f.bodies.length,4);
  assert.doesNotMatch(f.bodies[2]!,/mio\.goal\.repair/u);assert.match(f.bodies[2]!,/Keep the opening line exactly/u);assert.match(f.bodies[3]!,/Keep the opening line exactly/u);
  assert.equal(markers(f.runtime.journal.snapshot(done.run.id).steps).length,1);
 });
 test(`${protocol}: tools in the repair retain their provenance and paid work still requires confirmation`,async t=>{
  const f=await fixture(t,protocol);f.plan(index=>index===1?[setCountGoal(2)]:index===3?[goalCall('mioon_tools_load',{groups:['images']})]:index===4?[goalCall('mioon_image_generate',{name:'Needs confirmation',prompt:'Synthetic approval test',providerId:'mock',model:'mock-image-v1',options:{size:'1024x1024',quality:'low',background:'opaque',outputFormat:'png',n:1}})]:[]);
  const waiting=await f.send();assert.equal(waiting.run.status,'awaiting_approval');assert.equal(f.bodies.length,4);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_tasks').get()!.n,0);
  const paid=waiting.steps.find(step=>step.status==='awaiting_approval')!;assert.equal(paid.tier,'paid');assert.ok(paid.repair);assert.ok(waiting.steps.find(step=>step.toolCall?.name==='mioon_tools_load')?.repair);
  const done=await f.action(waiting.run.id,'deny',{stepId:paid.id});assert.equal(done.run.status,'completed');assert.equal(markers(f.runtime.journal.snapshot(done.run.id).steps).length,1);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_tasks').get()!.n,0);
 });
 for(const boundary of ['marker','intent','marker_replan'] as const)test(`${protocol}: SIGKILL after repair ${boundary} resumes once with the frozen gap and request`,{timeout:30000},async t=>{
  const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-goal-sigkill-'));
  const child=spawn(process.execPath,[fileURLToPath(new URL('./helpers/agent-task-goal-repair-crash.ts',import.meta.url))],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{...process.env,FIXTURE_ROOT:root,FIXTURE_PROTOCOL:protocol,FIXTURE_BOUNDARY:boundary==='marker_replan'?'marker':boundary},stdio:['ignore','ignore','pipe']});
  let stderr='';child.stderr.setEncoding('utf8').on('data',(chunk:string)=>{stderr+=chunk;});
  let restored:Awaited<ReturnType<typeof openGoalRepairFixture>>|undefined;
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await restored?.close();rmSync(root,{recursive:true,force:true});});
  const result=await new Promise<NodeJS.Signals|null>((resolve,reject)=>{child.once('error',reject);child.once('close',(_code,signal)=>resolve(signal));});assert.equal(result,'SIGKILL',stderr);
  const saved=JSON.parse(readFileSync(join(root,'fixture.json'),'utf8')) as {projectId:string;requestId:string};
  const f=restored=await openGoalRepairFixture(root,protocol,saved.projectId);
  const found=f.runtime.lookup(f.projectId,saved.requestId).snapshot!;assert.equal(found.run.status,'interrupted');assert.equal(f.bodies.length,0);
  const before=f.runtime.journal.snapshot(found.run.id),marked=markers(before.steps);assert.equal(marked.length,1);
  const message=String(record(record(marked[0]!.data).goalRepair).message),intent=before.steps.find(step=>step.status==='intent');
  const frozen=intent?.request&&record(intent.request).body;
  if(boundary==='marker_replan'){
   f.runtime.journal.updateStep(found.run.id,marked[0]!.id,{data:{...record(marked[0]!.data),replanRequested:true} as AgentTaskStep['data']});
  }
  await f.services.call('shot.create',{projectId:f.projectId,title:'Manual completion after crash'});
  // Expose the resumed, not-yet-launched state to a note's capacity probe.
  // The original interrupted state deliberately does not accept notes.
  if(boundary==='marker_replan'){const run=f.runtime.journal.run(found.run.id);f.runtime.journal.resume(run.id,run.revision);}
  const done=boundary==='marker_replan'?await f.action(found.run.id,'note',{text:'Keep this late instruction verbatim.'}):await f.action(found.run.id,'resume');assert.equal(done.run.status,'completed');assert.equal(f.bodies.length,1);assert.equal(done.run.stepsUsed,4);
  const messages=f.bodies[0]!;assert.ok(messages.includes(JSON.stringify(message).slice(1,-1)));if(frozen!==undefined)assert.equal(messages,frozen);
  assert.equal(markers(f.runtime.journal.snapshot(done.run.id).steps).length,1);assert.equal((messages.match(/mio\.goal\.repair/gu)??[]).length,1);
  if(boundary==='marker_replan'){
   assert.match(messages,/原排队操作因目标冲突已取消/u);assert.ok(messages.indexOf('原排队操作因目标冲突已取消')<messages.indexOf('宿主检查发现'));
   assert.equal((messages.match(/Keep this late instruction verbatim\./gu)??[]).length,1);
  }
 });
}
