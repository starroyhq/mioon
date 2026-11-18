import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {TASK_MODEL_LIMITS} from '../packages/business/src/agent/task-gateway-v2.ts';
import {AGENT_TASK_TOOLS_LOAD_NAME} from '../packages/business/src/agent/task-tool-groups-v2.ts';
import {authorizeTestScope} from './helpers/agent-authorizations.ts';
import {object,gate,output,call,syntheticDeniedTransport,fixture,m4ConflictPause,longReadOutput} from './helpers/agent-task-runtime-fixture.ts';

test('a small safety window pauses and resumes; completed tools stay completed',async t=>{const f=await fixture(t,'responses',new Map(),{safetyStepLimit:2});f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_project_inspect')]:[])};});const sent=await f.send(),paused=await f.settle(sent.run.id);assert.equal(paused.run.status,'paused');assert.equal(paused.run.pauseReason,'safety_limit');assert.equal(paused.run.stepsUsed,2);assert.equal(f.effects.size,1);await f.action(paused,'resume');const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.deepEqual(f.runtime.journal.safetyWindow(sent.run.id),{startStepsUsed:2,afterPosition:2,remaining:1});assert.equal(done.run.stepsUsed,3);assert.equal(f.effects.size,1);assert.equal(f.requests.length,2);});
for(const protocol of ['chat_completions','responses'] as const)for(const action of ['approve','deny'] as const)test(`${protocol}: ${action} at the safety boundary cannot start a new window`,async t=>{
 const f=await fixture(t,protocol,new Map(),{safetyStepLimit:2});f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,read_only:'confirm'}});
 let toolExecutions=0;f.beforeTool(async()=>{toolExecutions++;});
 f.setScript(async function*(index){yield {type:'done',output:output(protocol,index===1?[call('mioon_project_inspect')]:[])};});
 const sent=await f.send(),waiting=await f.wait(sent.run.id,['awaiting_approval']);await f.runtime.drain();const step=waiting.steps.find(item=>item.status==='awaiting_approval');assert.ok(step);
 assert.equal(waiting.run.stepsUsed,2);assert.equal(f.runtime.journal.safetyWindow(sent.run.id).remaining,0);assert.equal(f.effects.size,0);assert.equal(toolExecutions,0);assert.equal(f.requests.length,1);
 const approval={requestId:randomUUID(),expectedRevision:waiting.run.revision,action,stepId:step.id};
 await f.runtime.action(f.projectId,sent.run.id,approval);const paused=await f.settle(sent.run.id);
 assert.equal(paused.run.status,'paused');assert.equal(paused.run.pauseReason,'safety_limit');assert.equal(f.runtime.journal.safetyWindow(sent.run.id).remaining,0);assert.equal(paused.run.stepsUsed,2);
 assert.equal(f.effects.size,action==='approve'?1:0);assert.equal(toolExecutions,action==='approve'?1:0);assert.equal(f.requests.length,1);assert.equal(paused.steps.find(item=>item.id===step.id)?.status,action==='approve'?'completed':'rejected');
 const beforeReplay=f.runtime.journal.snapshot(sent.run.id);await f.runtime.action(f.projectId,sent.run.id,approval);await f.runtime.drain();assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),beforeReplay);
 await assert.rejects(f.runtime.action(f.projectId,sent.run.id,{...approval,requestId:randomUUID()}),{code:'AGENT_TASK_REVISION_CONFLICT'});assert.equal(f.runtime.journal.safetyWindow(sent.run.id).remaining,0);
 const continuation={requestId:randomUUID(),expectedRevision:paused.run.revision,action:'resume'};
 await f.runtime.action(f.projectId,sent.run.id,continuation);await f.runtime.action(f.projectId,sent.run.id,continuation);const done=await f.settle(sent.run.id);
 assert.equal(done.run.id,sent.run.id);assert.equal(done.run.status,'completed');assert.deepEqual(f.runtime.journal.safetyWindow(sent.run.id),{startStepsUsed:2,afterPosition:2,remaining:1});assert.equal(done.run.stepsUsed,3);assert.equal(f.effects.size,action==='approve'?1:0);assert.equal(toolExecutions,action==='approve'?1:0);assert.equal(f.requests.length,2);
 await f.runtime.action(f.projectId,sent.run.id,continuation);await f.runtime.action(f.projectId,sent.run.id,approval);await f.runtime.drain();assert.deepEqual(f.runtime.journal.safetyWindow(sent.run.id),{startStepsUsed:2,afterPosition:2,remaining:1});assert.equal(f.requests.length,2);assert.equal(f.effects.size,action==='approve'?1:0);assert.equal(toolExecutions,action==='approve'?1:0);
});
for(const action of ['approve','deny'] as const)test(`${action} receipt failure rolls back exhausted approval and state together`,async t=>{
 const f=await fixture(t,'responses',new Map(),{safetyStepLimit:2});f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,read_only:'confirm'}});
 f.setScript(async function*(){yield {type:'done',output:output('responses',[call('mioon_project_inspect')])};});
 const sent=await f.send(),waiting=await f.wait(sent.run.id,['awaiting_approval']);await f.runtime.drain();const step=waiting.steps.find(item=>item.status==='awaiting_approval');assert.ok(step);
 const request={requestId:randomUUID(),expectedRevision:waiting.run.revision,action,stepId:step.id},before=f.runtime.journal.snapshot(sent.run.id),events=f.runtime.journal.events(sent.run.id);
 f.store.db.exec(`CREATE TEMP TRIGGER fail_approval_receipt BEFORE INSERT ON mio_controls WHEN NEW.requestId='${request.requestId}' BEGIN SELECT RAISE(ABORT,'synthetic approval receipt failure');END;`);
 await assert.rejects(f.runtime.action(f.projectId,sent.run.id,request),{code:'AGENT_TASK_STORAGE_UNAVAILABLE'});await f.runtime.drain();
 assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),before);assert.deepEqual(f.runtime.journal.events(sent.run.id),events);assert.equal(f.runtime.journal.lookupControl(request.requestId),null);assert.equal(f.effects.size,0);assert.equal(f.requests.length,1);
});
test('read and reversible tiers independently require approval and exact duplicate controls do not repeat',async t=>{
 const f=await fixture(t);f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,read_only:'confirm',local_reversible:'confirm'}});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_project_inspect'),call('mioon_shot_update',{shotId:f.first.id,expectedRevision:f.first.revision,patch:{prompt:'AI edit'}})]:[])};},{loadGroups:['canvas']});
 const sent=await f.send();let waiting=await f.wait(sent.run.id,['awaiting_approval']);await f.runtime.drain();
 const loading=waiting.steps.find(step=>step.status==='awaiting_approval');assert.equal(loading?.toolCall?.name,AGENT_TASK_TOOLS_LOAD_NAME);assert.equal(f.effects.size,0);
 await f.action(waiting,'approve',{stepId:loading!.id});await f.runtime.drain();waiting=f.runtime.get(f.projectId,sent.run.id);
 assert.equal(f.loadingEffects,1);assert.equal(f.effects.size,0+f.loadingEffects);
 const first=waiting.steps.find(step=>step.status==='awaiting_approval');assert.equal(first?.toolCall?.name,'mioon_project_inspect');assert.ok(first);
 const control={requestId:randomUUID(),action:'approve',expectedRevision:waiting.run.revision,stepId:first.id};await f.runtime.action(f.projectId,sent.run.id,control);await f.runtime.action(f.projectId,sent.run.id,control);
 waiting=await f.wait(sent.run.id,['awaiting_approval']);await f.runtime.drain();const second=waiting.steps.find(step=>step.status==='awaiting_approval');assert.ok(second);assert.equal(second.tier,'local_reversible');assert.equal(f.effects.size,1+f.loadingEffects);
 await f.action(waiting,'deny',{stepId:second.id});const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.effects.size,1+f.loadingEffects);assert.equal(object(f.store.get('shots',String(f.first.id))).prompt,'saved first');
});
test('budget pauses retain pending tool calls without invalidating or repeating the batch',async t=>{
 const f=await fixture(t,'responses',new Map(),{safetyStepLimit:2});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?Array.from({length:3},()=>call('mioon_project_inspect')):[])};});
 const sent=await f.send();let paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,'safety_limit');assert.equal(f.effects.size,1);await f.action(paused,'resume');paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,'safety_limit');assert.equal(f.effects.size,3);assert.equal(f.requests.length,1);
 await f.action(paused,'resume');const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.run.stepsUsed,5);assert.deepEqual(f.runtime.journal.safetyWindow(sent.run.id),{startStepsUsed:4,afterPosition:4,remaining:1});assert.equal(f.effects.size,3);assert.equal(f.requests.length,2);
});
test('pause and stop during model wait block subsequent tools and requests',async t=>{for(const action of ['pause','stop'] as const){const f=await fixture(t),entered=gate(),release=gate();f.setScript(async function*(){entered.resolve();await release.promise;yield {type:'done',output:output('responses',[call('mioon_project_inspect')])};});const sent=await f.send();await entered.promise;await f.action(f.runtime.get(f.projectId,sent.run.id),action);release.resolve();const done=await f.settle(sent.run.id);assert.equal(done.run.status,action==='pause'?'paused':'stopped');assert.equal(f.effects.size,0);assert.equal(f.requests.length,1);}});
test('restart retains a model unknown result without dispatching until explicit disposition',async t=>{const f=await fixture(t),entered=gate(),release=gate();f.setScript(async function*(){entered.resolve();await release.promise;yield {type:'done',output:output('responses')};});const sent=await f.send();await entered.promise;f.restart();const restored=f.runtime.get(f.projectId,sent.run.id);assert.equal(restored.run.status,'interrupted');assert.equal(restored.steps[0]?.status,'unknown');assert.equal(f.requests.length,1);await assert.rejects(f.action(restored,'resume'),{code:'AGENT_TASK_UNKNOWN_RESULT'});release.resolve();const disposed=await f.action(restored,'resolve_unknown',{stepId:restored.steps[0]?.id,resolution:'discard'});await f.action(disposed,'resume');const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.requests.length,2);assert.equal(done.steps[0]?.status,'failed');});

test('a legacy 30-step policy permits 109 real offline steps while compacting model requests', {timeout:900000}, async t=>{
 const f=await fixture(t),before=f.store.list('shots',f.projectId),longRounds=2,shortRounds=4,toolsPerShortRound=25;
 assert.equal(f.runtime.policy().stepLimit,30);
 f.setScript(async function*(index){
  // Keep the large replies at the end. The run still compacts its own
  // history, without rehydrating the long text for every earlier tool read.
  const long=index>shortRounds&&index<=shortRounds+longRounds;
  const toolCount=long?1:index<=shortRounds?toolsPerShortRound:0;
  const calls=Array.from({length:toolCount},()=>call('mioon_project_inspect'));
  const text=long?`OFFLINE_LONG_ROUND_${index}:`+'m'.repeat(64*1024):`Offline round ${index} completed.`;
  yield {type:'done',output:longReadOutput('responses',text,calls)};
 });
 const sent=await f.send('Retain the original request across compaction.'),done=await f.settle(sent.run.id);
 assert.equal(sent.run.stepLimit,30);assert.equal(done.run.status,'completed');assert.equal(done.run.stepsUsed,109);
 assert.equal(f.requests.length,longRounds+shortRounds+1);assert.equal(f.effects.size,longRounds+shortRounds*toolsPerShortRound);
 assert.deepEqual(f.runtime.journal.safetyWindow(sent.run.id),{startStepsUsed:0,afterPosition:0,remaining:91});
 const historySizes=f.requests.map(request=>{
  assert.ok(Buffer.byteLength(request.body)<=TASK_MODEL_LIMITS.requestBytes);
  const history=object(JSON.parse(request.body)).input;assert.ok(Array.isArray(history));
  const bytes=Buffer.byteLength(JSON.stringify(history));assert.ok(bytes<=TASK_MODEL_LIMITS.historyBytes);return bytes;
 });
 const firstLongMarker=`OFFLINE_LONG_ROUND_${shortRounds+1}:`;
 const lastLongMarker=`OFFLINE_LONG_ROUND_${shortRounds+2}:`;
 const finalBody=f.requests.at(-1)!.body;
 assert.match(f.requests.at(-2)!.body,new RegExp(firstLongMarker,'u'));
 assert.doesNotMatch(finalBody,new RegExp(firstLongMarker,'u'));
 assert.match(finalBody,new RegExp(lastLongMarker,'u'));
 const readSteps=done.steps.filter(step=>step.kind==='tool');
 const outputs=(body:string)=>{
  const history=object(JSON.parse(body)).input;assert.ok(Array.isArray(history));
  return history.filter(item=>object(item).type==='function_call_output').map(item=>object(item).call_id);
 };
 const lastShortBatch=readSteps.slice(-toolsPerShortRound-longRounds,-longRounds);
 assert.deepEqual(outputs(f.requests[shortRounds]!.body).slice(-toolsPerShortRound),lastShortBatch.map(step=>step.toolCall?.id));
 assert.equal(outputs(finalBody).at(-1),readSteps.at(-1)?.toolCall?.id);
 assert.equal(done.changes.length,0);assert.deepEqual(f.store.list('shots',f.projectId),before);
 t.diagnostic(`Largest offline request: ${Math.max(...f.requests.map(request=>Buffer.byteLength(request.body)))} bytes. Largest history: ${Math.max(...historySizes)} bytes.`);
});

test('the same provider call ID in separate model replies keeps each tool receipt bound to its own reply',async t=>{
 const f=await fixture(t),shared=call('mioon_project_inspect',{},'reused_provider_call_id');
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index<=2?[shared]:[])};});
 const sent=await f.send(),done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(f.requests.length,3);assert.equal(f.effects.size,2);
 const saved=f.runtime.journal.snapshot(sent.run.id).steps.filter(step=>step.toolCall?.id===shared.id);
 assert.deepEqual(saved.map(step=>step.status),['completed','completed']);
 assert.equal(new Set(saved.map(step=>object(step.data).sourceModelStepId)).size,2);
});

test('three same-batch rejections ignore caption changes and fence a later mutation before and after restart',async t=>{
 const f=await fixture(t),rejections=[1,2,3].map(index=>call(AGENT_TASK_TOOLS_LOAD_NAME,{names:['mioon_unsupported'],_mio_step:`Try ${index}`}));
 const suffix=call('mioon_shot_update',{shotId:f.first.id,expectedRevision:f.first.revision,patch:{prompt:'The old batch must stay unexecuted'}});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[...rejections,suffix]:[])};},{loadGroups:['canvas']});
 const sent=await f.send(),paused=await f.settle(sent.run.id);
 assert.equal(paused.run.status,'paused');assert.equal(paused.run.pauseReason,'repeated_tool_failure');
 assert.deepEqual(paused.steps.filter(step=>step.toolCall&&rejections.some(call=>call.id===step.toolCall?.id)).map(step=>step.status),['rejected','rejected','rejected']);
 assert.equal(paused.steps.some(step=>step.toolCall?.id===suffix.id),false);assert.equal(f.effects.size,f.loadingEffects);
 assert.equal(f.requests.length,1+f.loadingRequests);assert.equal(object(f.store.get('shots',f.first.id)).prompt,f.first.prompt);
 const window=f.runtime.journal.safetyWindow(sent.run.id);f.restart();assert.deepEqual(f.runtime.journal.safetyWindow(sent.run.id),window);
 const interrupted=f.runtime.get(f.projectId,sent.run.id);assert.equal(interrupted.run.status,'interrupted');
 await f.action(interrupted,'resume');const done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(f.effects.size,f.loadingEffects);assert.equal(done.changes.length,0);
 const input=object(JSON.parse(f.scriptRequest(2).body)).input;assert.ok(Array.isArray(input));
 const results=input.filter(item=>object(item).type==='function_call_output').map(object);
 for(const rejected of rejections)assert.ok(results.some(item=>item.call_id===rejected.id&&String(item.output).includes('VALIDATION_ERROR')));
 assert.ok(results.some(item=>item.call_id===suffix.id&&String(item.output).includes('AGENT_TASK_REPEATED_TOOL_FAILURE')));
 assert.equal(object(f.store.get('shots',f.first.id)).prompt,f.first.prompt);
});

test('three identical failed tools across explicit retries pause and can replan on resume',async t=>{
 const f=await fixture(t);let attempts=0;
 f.beforeTool(async prepared=>{if(prepared.operation==='project.inspect'){attempts++;throw new Error('Synthetic read failed');}});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index<=3?[call('mioon_project_inspect')]:[])};});
 const sent=await f.send();let current=await f.settle(sent.run.id);
 for(let index=1;index<=2;index++){
  assert.equal(current.run.status,'failed');assert.equal(attempts,index);
  await f.action(current,'retry');current=await f.settle(sent.run.id);
 }
 assert.equal(current.run.status,'paused');assert.equal(current.run.pauseReason,'repeated_tool_failure');assert.equal(attempts,3);
 await f.action(current,'resume');const done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(f.requests.length,4);assert.equal(attempts,3);
 assert.equal(done.steps.filter(step=>step.kind==='tool'&&step.status==='failed').length,3);
});

test('three explicit denials pause without consuming a fourth approval or retrying the tool',async t=>{
 const f=await fixture(t);
 f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,read_only:'confirm'}});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index<=3?[call('mioon_project_inspect')]:[])};});
 const sent=await f.send();let current=await f.settle(sent.run.id);
 for(let index=1;index<=3;index++){
  assert.equal(current.run.status,'awaiting_approval');assert.equal(f.requests.length,index);
  const waiting=current.steps.at(-1);assert.equal(waiting?.status,'awaiting_approval');
  await f.action(current,'deny',{stepId:waiting!.id});current=await f.settle(sent.run.id);
 }
 assert.equal(current.run.status,'paused');assert.equal(current.run.pauseReason,'repeated_tool_failure');
 assert.equal(f.requests.length,3);assert.equal(f.effects.size,0);
 await f.action(current,'resume');const done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(f.requests.length,4);assert.equal(f.effects.size,0);
});

for(const progress of [false,true])test(`ten model calls with ${progress?'a successful last-batch tool continue':'no successful tools pause and retain a note'}`,async t=>{
 const f=await fixture(t);
 f.setScript(async function*(index){
  const calls=index<=10?[call(AGENT_TASK_TOOLS_LOAD_NAME,{names:[`mioon_invalid_${index}`]}),...(progress&&index===10?[call('mioon_project_inspect')]:[])]:[];
  yield {type:'done',output:output('responses',calls)};
 });
 const sent=await f.send(),current=await f.settle(sent.run.id);
 assert.equal(current.steps.filter(step=>step.toolCall?.name===AGENT_TASK_TOOLS_LOAD_NAME&&step.status==='rejected').length,10);
 if(progress){assert.equal(current.run.status,'completed');assert.equal(f.requests.length,11);assert.equal(f.effects.size,1);return;}
 assert.equal(current.run.status,'paused');assert.equal(current.run.pauseReason,'no_tool_progress');assert.equal(f.requests.length,10);assert.equal(f.effects.size,0);
 const note='Read the project summary before trying another operation.';
 const noted=await f.action(current,'note',{text:note});assert.equal(noted.run.notes?.[0]?.modelStepId,undefined);assert.equal(f.requests.length,10);
 await f.action(noted,'resume');const done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(f.requests.length,11);assert.match(f.requests[10]!.body,/Read the project summary/);
 assert.ok(done.run.notes?.[0]?.modelStepId);assert.equal(f.runtime.journal.safetyWindow(sent.run.id).startStepsUsed,20);
});
test('read rejection and local approval each respect their independent configured tier',async t=>{for(const tier of ['read_only','local_reversible'] as const){const f=await fixture(t);f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,[tier]:'confirm'}});f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[tier==='read_only'?call('mioon_project_inspect'):call('mioon_shot_update',{shotId:f.first.id,expectedRevision:f.first.revision,patch:{prompt:'approved local'}})]:[])};},{loadGroups:tier==='read_only'?[]:['canvas']});const sent=await f.send(),waiting=await f.wait(sent.run.id,['awaiting_approval']);await f.runtime.drain();const step=waiting.steps.find(item=>item.status==='awaiting_approval');assert.ok(step);await f.action(waiting,tier==='read_only'?'deny':'approve',{stepId:step.id});const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.effects.size,(tier==='read_only'?0:1)+f.loadingEffects);assert.equal(object(f.store.get('shots',f.first.id)).prompt,tier==='read_only'?'saved first':'approved local');}});
test('all legacy grants remain insufficient for project_agent before any model request',async t=>{const f=await fixture(t);await f.revoke();for(const scope of ['typed_chat_only','project_inspection','selected_shot_edit','selected_timeline_clip_move','selected_timeline_clip_gain'])await authorizeTestScope(f.authorizations,scope);await assert.rejects(f.send(),{code:'AGENT_TASK_CONSENT_REQUIRED'});assert.equal(f.requests.length,0);assert.equal(f.effects.size,0);});
for(const point of [
 {name:'model intent',event:'INSERT',kind:'model',status:'intent',requests:0,effects:0},
 {name:'model dispatch',event:'UPDATE',kind:'model',status:'dispatch_started',requests:0,effects:0},
 {name:'model result',event:'UPDATE',kind:'model',status:'completed',requests:1,effects:0},
 {name:'tool intent',event:'INSERT',kind:'tool',status:'intent',requests:1,effects:0},
 {name:'tool dispatch',event:'UPDATE',kind:'tool',status:'dispatch_started',requests:1,effects:0},
 {name:'tool result',event:'UPDATE',kind:'tool',status:'completed',requests:1,effects:1},
] as const)test(`${point.name} journal write failure blocks every later effect and continuation`,async t=>{
 const f=await fixture(t);f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_project_inspect')]:[])};});
 f.store.db.exec(`CREATE TEMP TRIGGER test_block_journal BEFORE ${point.event} ON mio_steps WHEN NEW.kind='${point.kind}' AND NEW.status='${point.status}' BEGIN SELECT RAISE(ABORT,'synthetic disk write failed');END;`);
 const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(f.effects.size,point.effects);assert.equal(f.requests.length,point.requests);assert.equal(done.run.status,'failed');
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: failed tool stops its batch; retry supplies the failure and replans without old parameters`,async t=>{
 const f=await fixture(t,protocol),invalid=call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{duration:-1}}),stale=call('mioon_shot_update',{shotId:f.other.id,expectedRevision:1,patch:{prompt:'MUST NOT EXECUTE OLD BATCH'}});
 f.setScript(async function*(index,request){if(index===2){assert.match(request.body,/VALIDATION_ERROR/);assert.match(request.body,/TARGET_CHANGED/);}yield {type:'done',output:output(protocol,index===1?[invalid,stale]:index===2?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:2,patch:{prompt:'Fresh retry plan'}})]:[])};},{loadGroups:['canvas']});
 const sent=await f.send(),failed=await f.settle(sent.run.id);assert.equal(failed.run.status,'failed');assert.equal(failed.steps.at(-1)?.status,'failed');assert.equal(f.requests.length,2);assert.equal(f.effects.size,1);assert.equal(f.loadingEffects,1);assert.equal(failed.steps.length,4);
 await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'New manual baseline'}});
 await f.action(failed,'retry',{stepId:failed.steps.at(-1)!.id});const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.run.stepsUsed,7);assert.equal(done.run.budget,30);assert.equal(f.effects.size,2);assert.equal(f.loadingEffects,1);assert.equal(f.requests.length,4);assert.equal(object(f.store.get('shots',f.first.id)).prompt,'Fresh retry plan');assert.equal(object(f.store.get('shots',f.other.id)).prompt,'saved other');assert.equal(done.steps.filter(step=>step.toolCall?.id===invalid.id).length,1);assert.equal(done.steps.some(step=>step.toolCall?.id===stale.id),false);
});
for(const scenario of ['unknown','last_completed','revoked','busy','safety_limit','receipt_failure'] as const)test(`retry gate preserves safety for ${scenario}`,async t=>{
 const f=await fixture(t,'responses',new Map(),{safetyStepLimit:scenario==='safety_limit'?1:undefined}),transport=syntheticDeniedTransport(scenario==='unknown'?'93.184.216.34':'198.18.10.207');
 // An observed HTTP error is now a plain failure; an unclassified exception
 // during the request is what still leaves an unknown model result.
 f.setScript(async function*(index,request){if(scenario==='last_completed'){yield {type:'done',output:output('responses')};await f.revoke();return;}if(index===1){if(scenario==='unknown')throw new Error('unclassified gateway failure');yield*transport.gateway(request);return;}yield {type:'done',output:output('responses')};});const sent=await f.send(),failed=await f.settle(sent.run.id);assert.equal(failed.run.status,'failed');
 if(scenario==='revoked')await f.revoke();
 if(scenario==='busy'){const entered=gate(),release=gate();f.setScript(async function*(){entered.resolve();await release.promise;yield {type:'done',output:output('responses')};});const other=await f.send('New active run');await entered.promise;t.after(()=>release.resolve());assert.equal(f.runtime.get(f.projectId,other.run.id).run.status,'running');}
 const request={requestId:randomUUID(),expectedRevision:failed.run.revision,action:'retry',stepId:failed.steps.at(-1)!.id},before=f.runtime.journal.snapshot(sent.run.id),requests=f.requests.length;
 if(scenario==='receipt_failure')f.store.db.exec(`CREATE TEMP TRIGGER fail_retry_receipt BEFORE INSERT ON mio_controls WHEN NEW.requestId='${request.requestId}' BEGIN SELECT RAISE(ABORT,'synthetic retry receipt failure');END;`);
 if(scenario==='safety_limit'){
  const paused=await f.runtime.action(f.projectId,sent.run.id,request);assert.equal(paused.run.status,'paused');assert.equal(paused.run.pauseReason,'safety_limit');assert.equal(f.runtime.journal.safetyWindow(sent.run.id).remaining,0);assert.equal(paused.run.stepsUsed,1);assert.equal(f.requests.length,1);await f.action(paused,'resume');const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.deepEqual(f.runtime.journal.safetyWindow(sent.run.id),{startStepsUsed:1,afterPosition:1,remaining:0});assert.equal(f.requests.length,2);
 }else{
  const codes={unknown:'AGENT_TASK_UNKNOWN_RESULT',last_completed:'AGENT_TASK_STATE_CONFLICT',revoked:'AGENT_TASK_CONSENT_REQUIRED',busy:'AGENT_TASK_BUSY',receipt_failure:'AGENT_TASK_STORAGE_UNAVAILABLE'};
  await assert.rejects(f.runtime.action(f.projectId,sent.run.id,request),{code:codes[scenario]});assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),before);assert.equal(f.requests.length,requests);if(scenario==='receipt_failure')assert.equal(f.runtime.journal.lookupControl(request.requestId),null);
 }
});
test('retry replan still requires paid approval and never submits a generation on its own',async t=>{
 const f=await fixture(t);f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{duration:-1}})]:index===2?[call('mioon_generation_submit',{shotId:f.first.id,expectedRevision:1,providerId:'mock',model:'mock-motion-v1',parameters:{delayMs:0}})]:[])};},{loadGroups:['canvas','video']});
 const sent=await f.send(),failed=await f.settle(sent.run.id);assert.equal(failed.run.status,'failed');await f.action(failed,'retry');const waiting=await f.settle(sent.run.id);assert.equal(waiting.run.status,'awaiting_approval');assert.equal(waiting.run.budget,30);assert.equal(waiting.steps.at(-1)?.tier,'paid');assert.equal(f.store.list('jobs',f.projectId).length,0);assert.equal(f.requests.length,3);assert.equal(f.loadingRequests,1);await f.action(waiting,'deny',{stepId:waiting.steps.at(-1)!.id});assert.equal((await f.settle(sent.run.id)).run.status,'completed');assert.equal(f.store.list('jobs',f.projectId).length,0);
});

test('retry retains the same run skipped targets and replans only allowed tools',async t=>{
 const f=await fixture(t);
 const {sent,paused}=await m4ConflictPause(f,{reason:'conflict',target:{kind:'shot',id:f.first.id},calls:[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'Old conflicting plan'}})],
  script:index=>index===2?[call('mioon_shot_update',{shotId:f.other.id,expectedRevision:1,patch:{duration:-1}})]:index===3?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:2,patch:{prompt:'Must stay skipped after retry'}}),call('mioon_project_inspect')]:[],
  conflict:()=>f.services.call('shot.update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'Manual protected content'}})});
 assert.equal(paused.run.pauseReason,'conflict');await f.action(paused,'skip');const failed=await f.settle(sent.run.id);assert.equal(failed.run.status,'failed');assert.equal(failed.run.skippedTargets?.length,1);
 await f.action(failed,'retry');const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.run.skippedTargets?.length,1);assert.ok(done.steps.some(step=>step.status==='denied'&&step.error?.code==='TARGET_SKIPPED'));assert.equal(object(f.store.get('shots',f.first.id)).prompt,'Manual protected content');assert.equal(object(f.store.get('shots',f.other.id)).prompt,'saved other');assert.equal(f.effects.size,2);assert.equal(f.loadingEffects,1);assert.equal(f.requests.length,5);assert.match(f.scriptRequest(4).body,/TARGET_SKIPPED/);
});
test('retry authorization revoked after its intent blocks actual model submission',async t=>{
 const f=await fixture(t),transport=syntheticDeniedTransport('198.18.10.207');let submitted=0;f.setScript(async function*(index,request){if(index===1){yield*transport.gateway(request);return;}await f.revoke();assert.ok(request.beforeSubmit);request.beforeSubmit();submitted++;yield {type:'done',output:output('responses')};});
 const sent=await f.send(),failed=await f.settle(sent.run.id);await f.action(failed,'retry');const blocked=await f.settle(sent.run.id);assert.equal(submitted,0);assert.equal(f.effects.size,0);assert.equal(blocked.run.status,'failed');assert.equal(blocked.run.pauseReason,'AGENT_TASK_CONSENT_REQUIRED');assert.equal(blocked.run.budget,30);assert.equal(blocked.run.stepsUsed,2);
});
