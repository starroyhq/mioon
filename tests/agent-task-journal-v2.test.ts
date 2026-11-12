










import {isProjectStore} from '../packages/business/src/project-file/store.ts';


import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';



import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {beginFixtureModelStep,beginFixtureToolStep} from './helpers/mio-model-fixture.ts';
function fixture(safetyStepLimit?:number){const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-task-v2-')),store=openStore(root),projectId=store.projectId;store.put('projects',{id:projectId,name:'Task fixture',revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});return {root,store,projectId,journal:createAgentTaskJournal(store,{safetyStepLimit}),close(){store.close();rmSync(root,{recursive:true,force:true});}};}
function start(f:ReturnType<typeof fixture>){return f.journal.create({requestId:randomUUID(),projectId:f.projectId,text:'测试',configuration:{protocol:'responses'}});}
function reversibleChange(f:ReturnType<typeof fixture>,runId:string){const step=beginFixtureToolStep(f.journal,runId,{});f.journal.markDispatch(runId,step.id);f.journal.completeStep(runId,step.id,{change:{projectId:f.projectId,operation:'shot.update',targets:[],before:null,after:null,reversible:true}});return f.journal.snapshot(runId).changes[0]!;}

for(const status of ['completed','failed','stopped'] as const)test(`${status} execution end survives later undo, reverted state and restart`,t=>{
 const beginning=Date.parse('2026-10-23T00:00:00.000Z');t.mock.timers.enable({apis:['Date'],now:beginning});
 const f=fixture();try{
  const run=start(f).run,change=reversibleChange(f,run.id);assert.equal(f.journal.snapshot(run.id).executionEndedAt,undefined);
  t.mock.timers.setTime(beginning+2000);const ended=f.journal.transition(run.id,f.journal.run(run.id).revision,status);
  assert.equal(f.journal.snapshot(run.id).executionEndedAt,ended.updatedAt);
  t.mock.timers.setTime(beginning+3602000);f.store.tx(()=>f.journal.markChangeRevertedInside(change.id));
  const undone=f.journal.snapshot(run.id);assert.equal(undone.run.status,status);assert.equal(undone.changes[0]?.status,'reverted');assert.notEqual(undone.run.updatedAt,ended.updatedAt);assert.equal(undone.executionEndedAt,ended.updatedAt);
  f.journal.transition(run.id,undone.run.revision,'reverted');assert.equal(f.journal.snapshot(run.id).executionEndedAt,ended.updatedAt);
  f.store.close();const reopened=openStore(f.root);try{const journal=createAgentTaskJournal(reopened);journal.recover();assert.equal(journal.snapshot(run.id).executionEndedAt,ended.updatedAt);}finally{reopened.close();}
 }finally{f.close();}
});
test('execution end reads the durable run timestamp after clock rollback and more than 2000 events',t=>{
 const beginning=Date.parse('2026-10-23T00:00:00.000Z');t.mock.timers.enable({apis:['Date'],now:beginning});
 const f=fixture();try{
  const run=start(f).run;t.mock.timers.setTime(beginning+10000);const model=beginFixtureModelStep(f.journal,run.id),step=model.step;model.complete();
  f.store.tx(()=>{for(let index=0;index<2001;index++)f.journal.appendEvent(run.id,'text',{stepId:step.id,text:'saved'});});
  t.mock.timers.setTime(beginning+2000);const ended=f.journal.transition(run.id,f.journal.run(run.id).revision,'completed');
  assert.equal(f.journal.events(run.id).length,2000);assert.equal(ended.updatedAt,new Date(beginning+10000).toISOString());
  const last=f.store.db.prepare("SELECT createdAt FROM mio_entries WHERE runId=? AND kind='host_state' AND json_extract(payloadJson,'$.type')='run_state' ORDER BY sequence DESC LIMIT 1").get(run.id)!;
  assert.equal(last.createdAt,new Date(beginning+2000).toISOString());assert.equal(f.journal.snapshot(run.id).executionEndedAt,ended.updatedAt);
 }finally{f.close();}
});
test('execution end follows the last execution segment and does not reuse earlier terminal evidence',t=>{
 const beginning=Date.parse('2026-10-23T00:00:00.000Z');t.mock.timers.enable({apis:['Date'],now:beginning});
 const f=fixture();try{
  const run=start(f).run,change=reversibleChange(f,run.id),stepId=change.stepId;
  f.store.db.prepare('INSERT INTO mio_job_origins(kind,jobId,runId,stepId,projectId,requestId,operation) VALUES(?,?,?,?,?,?,?)').run('image',randomUUID(),run.id,stepId,f.projectId,stepId,'image.generate');
  t.mock.timers.setTime(beginning+2000);const first=f.journal.transition(run.id,f.journal.run(run.id).revision,'completed');assert.equal(f.journal.snapshot(run.id).executionEndedAt,first.updatedAt);
  t.mock.timers.setTime(beginning+4000);f.journal.transition(run.id,first.revision,'paused','user');f.journal.resume(run.id,f.journal.run(run.id).revision);assert.equal(f.journal.snapshot(run.id).executionEndedAt,undefined);
  t.mock.timers.setTime(beginning+6000);const last=f.journal.transition(run.id,f.journal.run(run.id).revision,'completed');assert.notEqual(last.updatedAt,first.updatedAt);assert.equal(f.journal.snapshot(run.id).executionEndedAt,last.updatedAt);
  f.journal.transition(run.id,last.revision,'paused','user');f.journal.resume(run.id,f.journal.run(run.id).revision);
  // A scalar terminal status and an untrusted hint cannot replace the
  // canonical terminal evidence of the current native execution segment.
  f.store.db.prepare("UPDATE mio_runs SET status='completed' WHERE id=?").run(run.id);
  f.journal.appendEvent(run.id,'run',{id:run.id,projectId:f.projectId,status:'completed'});assert.equal(f.journal.snapshot(run.id).executionEndedAt,undefined);
 }finally{f.close();}
});
test('native terminal runs without canonical execution timestamps do not invent an end from current metadata',()=>{
 const f=fixture();try{
  const run=start(f).run;f.store.db.prepare("UPDATE mio_runs SET status='completed' WHERE id=?").run(run.id);
  assert.equal(f.journal.snapshot(run.id).executionEndedAt,undefined);
  f.journal.appendEvent(run.id,'run',{id:run.id,projectId:f.projectId,status:'completed',updatedAt:'invalid'});assert.equal(f.journal.snapshot(run.id).executionEndedAt,undefined);
 }finally{f.close();}
});
test('v2 requests and controls replay original receipt without repeating state changes',()=>{const f=fixture();try{const first=start(f),input={requestId:randomUUID(),runId:first.run.id,expectedRevision:first.run.revision,action:'pause'};let calls=0;const result=f.journal.performControl(input,()=>{calls++;return {status:f.journal.transition(first.run.id,first.run.revision,'paused').status};});assert.equal(result.revision,first.run.revision+1);assert.deepEqual(f.journal.performControl(input,()=>{calls++;return null;}),result);assert.equal(calls,1);assert.throws(()=>f.journal.performControl({...input,action:'stop'},()=>null),{code:'AGENT_TASK_REQUEST_CONFLICT'});assert.equal(f.journal.lookupRequest(f.projectId,first.run.requestId)?.run.id,first.run.id);}finally{f.close();}});
test('explicit continuation durably resets the safety window once without repeating completed steps',()=>{
 const f=fixture(2);try{
  const run=start(f).run;
  for(let i=0;i<2;i++)beginFixtureModelStep(f.journal,run.id).complete(String(i));
  assert.throws(()=>f.journal.beginStep(run.id,{kind:'model'}),{code:'AGENT_TASK_BUDGET_EXHAUSTED'});
  const paused=f.journal.transition(run.id,f.journal.run(run.id).revision,'paused','safety_limit');
  const input={requestId:randomUUID(),runId:run.id,expectedRevision:paused.revision,action:'resume'};
  const receipt=f.journal.performControl(input,()=>{f.journal.resume(run.id,paused.revision,{resetSafetyWindow:true});return null;});
  assert.equal(receipt.revision,paused.revision+1);
  assert.deepEqual(f.journal.performControl(input,()=>assert.fail('replay cannot reset the window')),receipt);
  assert.deepEqual(f.journal.safetyWindow(run.id),{startStepsUsed:2,afterPosition:2,remaining:2});
  assert.equal(f.journal.run(run.id).stepsUsed,2);assert.equal(f.journal.snapshot(run.id).steps.length,2);
  f.store.close();const reopened=openStore(f.root);try{
   const journal=createAgentTaskJournal(reopened,{safetyStepLimit:2});journal.recover();
   assert.deepEqual(journal.lookupControl(input.requestId),receipt);
   assert.deepEqual(journal.safetyWindow(run.id),{startStepsUsed:2,afterPosition:2,remaining:2});
  }finally{reopened.close();}
 }finally{f.close();}
});
test('approval resume preserves an exhausted safety window and finishes only the existing counted intent',()=>{
 const f=fixture(2);try{
  const run=start(f).run,tool=beginFixtureToolStep(f.journal,run.id,{});f.journal.updateStep(run.id,tool.id,{status:'awaiting_approval'});let current=f.journal.run(run.id);f.journal.transition(run.id,current.revision,'awaiting_approval');
  f.journal.updateStep(run.id,tool.id,{status:'intent'});current=f.journal.resume(run.id,f.journal.run(run.id).revision);
  assert.equal(current.stepsUsed,2);assert.equal(current.budget,30);assert.equal(f.journal.safetyWindow(run.id).remaining,0);f.journal.markDispatch(run.id,tool.id);f.journal.completeStep(run.id,tool.id,{result:{approved:true}});
  assert.equal(f.journal.snapshot(run.id).steps.length,2);assert.equal(f.journal.step(tool.id).status,'completed');assert.throws(()=>f.journal.beginStep(run.id,{kind:'model'}),{code:'AGENT_TASK_BUDGET_EXHAUSTED'});
 }finally{f.close();}
});
for(const reason of ['user','budget','interrupted'] as const)for(const full of [false,true])test(`explicit continuation ${reason} ${full?'at':'below'} the safety limit preserves CAS and starts a fresh window`,()=>{
 const f=fixture(2);try{
  const run=start(f).run,stepsUsed=full?2:1;for(let index=0;index<stepsUsed;index++){const model=beginFixtureModelStep(f.journal,run.id);model.complete(String(index));}
  const before=f.journal.run(run.id),paused=f.journal.transition(run.id,before.revision,reason==='interrupted'?'interrupted':'paused',reason);
  f.journal.updatePolicy({...f.journal.policy(),stepLimit:7});const saved=f.journal.snapshot(run.id);
  assert.throws(()=>f.journal.resume(run.id,paused.revision-1,{resetSafetyWindow:true}),{code:'AGENT_TASK_REVISION_CONFLICT'});assert.deepEqual(f.journal.snapshot(run.id),saved);
  const current=f.journal.resume(run.id,paused.revision,{resetSafetyWindow:true});assert.equal(current.stepLimit,30);assert.equal(current.budget,30);assert.equal(current.stepsUsed,stepsUsed);
  const window={startStepsUsed:stepsUsed,afterPosition:stepsUsed,remaining:2};assert.deepEqual(f.journal.safetyWindow(run.id),window);
  assert.throws(()=>f.journal.resume(run.id,paused.revision,{resetSafetyWindow:true}),{code:'AGENT_TASK_REVISION_CONFLICT'});assert.deepEqual(f.journal.safetyWindow(run.id),window);
 }finally{f.close();}
});
test('safety continuation refuses counter overflow atomically while approval resume preserves the current window',()=>{
 const f=fixture(2);try{
  const run=start(f).run,paused=f.journal.transition(run.id,run.revision,'awaiting_approval'),limit=Number.MAX_SAFE_INTEGER;
  f.store.db.prepare('UPDATE mio_runs SET budget=?,stepsUsed=? WHERE id=?').run(limit,limit,run.id);const before=f.journal.snapshot(run.id);
  assert.throws(()=>f.journal.resume(run.id,paused.revision,{resetSafetyWindow:true}),{code:'AGENT_TASK_BUDGET_LIMIT'});assert.deepEqual(f.journal.snapshot(run.id),before);
  const approved=f.journal.resume(run.id,paused.revision);assert.equal(approved.budget,limit);assert.equal(approved.stepsUsed,limit);
 }finally{f.close();}
});
test('approval and explicit continuation both preserve unknown-result fencing before resetting the window',()=>{
 const f=fixture(1);try{
  const run=start(f).run,step=beginFixtureModelStep(f.journal,run.id).step;f.journal.markDispatch(run.id,step.id);f.journal.recover();const saved=f.journal.snapshot(run.id);
  for(const resetSafetyWindow of [false,true]){assert.throws(()=>f.journal.resume(run.id,saved.run.revision,{resetSafetyWindow}),{code:'AGENT_TASK_UNKNOWN_RESULT'});assert.deepEqual(f.journal.snapshot(run.id),saved);}
 }finally{f.close();}
});
for(const reason of ['editing','conflict','user','budget'] as const)test(`restart preserves unresolved ${reason} selection without resuming the run`,()=>{
 const f=fixture(2);try{
  const run=start(f).run,step=beginFixtureToolStep(f.journal,run.id,{});
  f.journal.transition(run.id,f.journal.run(run.id).revision,'paused',reason);
  assert.equal(f.journal.recover(),1);const saved=f.journal.snapshot(run.id);
  assert.equal(saved.run.status,'interrupted');assert.equal(saved.run.pauseReason,reason==='editing'||reason==='conflict'?reason:'restart');
  assert.equal(saved.steps[1]?.id,step.id);assert.equal(saved.steps[1]?.status,'intent');assert.equal(saved.run.budget,30);assert.equal(saved.run.stepsUsed,2);assert.equal(f.journal.safetyWindow(run.id).remaining,0);
  assert.equal(f.journal.recover(),0);assert.deepEqual(f.journal.snapshot(run.id),saved);
 }finally{f.close();}
});
test('v2 dispatch result and changes share domain transaction, failure rolls back both',()=>{const f=fixture();try{const run=start(f).run,step=beginFixtureToolStep(f.journal,run.id,{});f.journal.markDispatch(run.id,step.id);const nodeId=randomUUID();assert.throws(()=>f.store.tx(()=>{f.store.put('nodes',{id:nodeId,projectId:f.projectId,type:'text',text:'side effect'});f.journal.completeStepInside(run.id,step.id,{result:{ok:true}});throw new Error('disk fault');}),/disk fault/);assert.equal(f.store.get('nodes',nodeId),null);assert.equal(f.journal.step(step.id).status,'dispatch_started');assert.equal(f.journal.recover(),1);assert.equal(f.journal.run(run.id).status,'interrupted');assert.equal(f.journal.step(step.id).status,'unknown');assert.throws(()=>f.journal.resume(run.id,f.journal.run(run.id).revision),{code:'AGENT_TASK_UNKNOWN_RESULT'});}finally{f.close();}});
test('target revisions preserve ABA and separate timeline clip conflicts',()=>{const f=fixture();try{const a=randomUUID(),b=randomUUID(),timelineId=randomUUID();const timeline={id:timelineId,projectId:f.projectId,revision:1,width:720,height:1280,fps:30,tracks:[],clips:[{id:a,name:'A'},{id:b,name:'B'}]};f.store.put('timelines',timeline);const before=f.journal.targetRevision(f.projectId,'timeline_clip',a),other=f.journal.targetRevision(f.projectId,'timeline_clip',b);f.store.put('timelines',{...timeline,revision:2,clips:[{id:a,name:'changed'},{id:b,name:'B'}]});f.store.put('timelines',{...timeline,revision:3});assert.equal(f.journal.targetRevision(f.projectId,'timeline_clip',a),before+2);assert.equal(f.journal.targetRevision(f.projectId,'timeline_clip',b),other);assert.throws(()=>f.journal.assertTargets(f.projectId,[{kind:'timeline_clip',id:a,revision:before}]),{code:'AGENT_TASK_TARGET_CHANGED'});f.journal.assertTargets(f.projectId,[{kind:'timeline_clip',id:b,revision:other}]);}finally{f.close();}});
test('multiple editing owners block AI until all release; stale release cannot unlock new generation',()=>{const f=fixture();try{const target={kind:'shot',id:randomUUID(),revision:0},ownerA=randomUUID(),ownerB=randomUUID();const edit=(ownerId:string,sequence:number,action:'claim'|'release',generation=1)=>f.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId,generation,sequence,action,targets:[target]});edit(ownerA,1,'claim');edit(ownerB,1,'claim');assert.equal(f.journal.claims(f.projectId).length,2);edit(ownerA,2,'release');assert.throws(()=>f.journal.assertTargets(f.projectId,[target]),{code:'AGENT_TASK_TARGET_CLAIMED'});edit(ownerB,2,'release');f.journal.assertTargets(f.projectId,[target]);edit(ownerA,3,'claim');assert.throws(()=>edit(ownerA,2,'release'),{code:'AGENT_TASK_EDIT_OWNER_STALE'});f.journal.recover();assert.equal(f.journal.claims(f.projectId)[0]?.state,'uncertain');assert.throws(()=>edit(ownerA,4,'claim',2),{code:'AGENT_TASK_EDIT_OWNER_UNCERTAIN'});}finally{f.close();}});
test('explicit same-owner restore retains claim identity, checks original target revisions and fences old releases',()=>{const f=fixture();try{
 const id=randomUUID(),ownerId=randomUUID();f.store.put('shots',{id,projectId:f.projectId,title:'Original',revision:1});const target={kind:'shot',id,revision:f.journal.targetRevision(f.projectId,'shot',id)},input={requestId:randomUUID(),projectId:f.projectId,ownerId,generation:1,sequence:1,action:'claim' as const,targets:[target]};
 const original=f.journal.edit(input).claims[0]!;f.journal.recover();assert.equal(f.journal.claims(f.projectId,ownerId)[0]?.state,'uncertain');
 assert.throws(()=>f.journal.edit({...input,requestId:randomUUID(),generation:2,action:'restore',targets:[{...target,id:randomUUID()}]}),{code:'AGENT_TASK_TARGET_CHANGED'});
 const restored=f.journal.edit({...input,requestId:randomUUID(),generation:2,action:'restore'});assert.equal(restored.claims[0]?.id,original.id);assert.equal(restored.claims[0]?.state,'active');assert.throws(()=>f.journal.assertTargets(f.projectId,[target]),{code:'AGENT_TASK_TARGET_CLAIMED'});
 assert.throws(()=>f.journal.edit({...input,requestId:randomUUID(),sequence:2,action:'release'}),{code:'AGENT_TASK_EDIT_OWNER_STALE'});
 f.store.put('shots',{id,projectId:f.projectId,title:'External',revision:2});f.store.put('shots',{id,projectId:f.projectId,title:'Original',revision:3});
 assert.throws(()=>f.journal.edit({...input,requestId:randomUUID(),generation:2,sequence:2,targets:[{...target,revision:f.journal.targetRevision(f.projectId,'shot',id)}]}),{code:'AGENT_TASK_TARGET_CHANGED'});assert.equal(f.journal.claims(f.projectId,ownerId)[0]?.target.revision,target.revision);f.journal.recover();
 assert.equal(f.journal.claims(f.projectId,ownerId)[0]?.target.revision,target.revision);assert.throws(()=>f.journal.edit({...input,requestId:randomUUID(),generation:3,action:'restore'}),{code:'AGENT_TASK_TARGET_CHANGED'});
 assert.throws(()=>f.journal.edit({...input,requestId:randomUUID(),generation:3,action:'restore',targets:[{...target,revision:f.journal.targetRevision(f.projectId,'shot',id)}]}),{code:'AGENT_TASK_TARGET_CHANGED'});assert.equal(f.journal.claims(f.projectId,ownerId)[0]?.state,'uncertain');
 f.journal.edit({...input,requestId:randomUUID(),generation:3,action:'resolve'});assert.equal(f.journal.claims(f.projectId,ownerId).length,0);
}finally{f.close();}});




test('pending undo control keeps immutable intent and exposes finished persisted progress',()=>{const f=fixture();try{const run=start(f).run,input={requestId:randomUUID(),runId:run.id,expectedRevision:run.revision,action:'undo_all'};assert.deepEqual(f.journal.beginControl(input).result,{state:'pending'});f.journal.finishControl(input.requestId,{state:'blocked',revertedIds:[],error:'target changed'});assert.deepEqual(f.journal.lookupControl(input.requestId)?.result,{state:'blocked',revertedIds:[],error:'target changed'});assert.deepEqual(f.journal.beginControl(input).result,{state:'blocked',revertedIds:[],error:'target changed'});assert.throws(()=>f.journal.beginControl({...input,action:'undo_change'}),{code:'AGENT_TASK_REQUEST_CONFLICT'});}finally{f.close();}});

test('only proven prevented dispatch can return to approval; unknown stays non-retryable',()=>{const f=fixture();try{const run=start(f).run,step=beginFixtureToolStep(f.journal,run.id,{});f.journal.markDispatch(run.id,step.id);assert.equal(f.journal.dispatchPrevented(run.id,step.id,'awaiting_approval').status,'awaiting_approval');f.journal.updateStep(run.id,step.id,{status:'intent'});f.journal.markDispatch(run.id,step.id);f.journal.updateStep(run.id,step.id,{status:'unknown'});assert.throws(()=>f.journal.dispatchPrevented(run.id,step.id,'intent'),{code:'AGENT_TASK_STATE_CONFLICT'});assert.throws(()=>f.journal.markDispatch(run.id,step.id),{code:'AGENT_TASK_STATE_CONFLICT'});}finally{f.close();}});
test('restart marks pending undo control on completed run blocked without replay',()=>{const f=fixture();try{const run=start(f).run;const completed=f.journal.transition(run.id,run.revision,'completed'),input={requestId:randomUUID(),runId:run.id,expectedRevision:completed.revision,action:'undo_all'};f.journal.beginControl(input);assert.equal(f.journal.recover(),0);assert.equal(f.journal.run(run.id).status,'completed');assert.deepEqual(f.journal.lookupControl(input.requestId)?.result,{state:'blocked',error:{code:'AGENT_TASK_INTERRUPTED',message:'控制操作因进程重启而中断；已完成的变更回退保持不变。'},revertedIds:[]});}finally{f.close();}});

test('aggregate project revision changes do not invalidate a project text target',()=>{const f=fixture();try{const before=f.journal.targetRevision(f.projectId,'project',f.projectId),project=f.store.get('projects',f.projectId) as Record<string,unknown>;f.store.put('projects',{...project,revision:2,updatedAt:new Date(Date.now()+1000).toISOString()});assert.equal(f.journal.targetRevision(f.projectId,'project',f.projectId),before);f.store.put('projects',{...project,revision:3,name:'Updated project title'});assert.equal(f.journal.targetRevision(f.projectId,'project',f.projectId),before+1);}finally{f.close();}});

test('history keyset pages discover every run without overlap and reject a foreign project cursor',()=>{const f=fixture();try{const ids:string[]=[];for(let i=0;i<4;i++){const run=start(f).run;ids.push(run.id);f.journal.transition(run.id,run.revision,'completed');}const first=f.journal.history(f.projectId,{limit:2});assert.equal(first.conversations.length,2);assert.ok(first.nextCursor);const second=f.journal.history(f.projectId,{limit:2,cursor:first.nextCursor});assert.equal(second.nextCursor,null);assert.deepEqual([...first.conversations,...second.conversations].map(conversation=>conversation.lastRunId).sort(),ids.sort());const cursor=JSON.parse(Buffer.from(first.nextCursor!,'base64url').toString('utf8')) as unknown[],foreignCursor=Buffer.from(JSON.stringify([randomUUID(),...cursor.slice(1)])).toString('base64url');assert.throws(()=>f.journal.history(f.projectId,{cursor:foreignCursor}),{code:'AGENT_TASK_INVALID'});assert.throws(()=>f.journal.history(randomUUID(),{cursor:first.nextCursor!}),{code:'AGENT_TASK_NOT_FOUND'});}finally{f.close();}});

test('stale control rejection has a retained receipt and exact replay never performs the action',()=>{const f=fixture();try{const run=start(f).run;f.journal.transition(run.id,run.revision,'paused');const input={requestId:randomUUID(),runId:run.id,expectedRevision:run.revision,action:'resume'};let calls=0;assert.throws(()=>f.journal.performControl(input,()=>{calls++;return null;}),{code:'AGENT_TASK_REVISION_CONFLICT'});const rejected=f.journal.rejectControl(input,'AGENT_TASK_REVISION_CONFLICT');assert.equal(rejected.revision,f.journal.run(run.id).revision);assert.deepEqual(rejected.result,{state:'rejected',code:'AGENT_TASK_REVISION_CONFLICT'});assert.deepEqual(f.journal.lookupControl(input.requestId),rejected);assert.deepEqual(f.journal.performControl(input,()=>{calls++;return null;}),rejected);assert.equal(calls,0);assert.throws(()=>f.journal.rejectControl({...input,action:'stop'},'AGENT_TASK_REVISION_CONFLICT'),{code:'AGENT_TASK_REQUEST_CONFLICT'});}finally{f.close();}});
