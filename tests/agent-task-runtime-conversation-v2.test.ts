import {testAgentExecution} from './helpers/agent-settings-fixture.ts';
import {beginFixtureModelStep} from './helpers/mio-model-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {agentTaskToolNamesForGroup} from '../packages/business/src/agent/task-tool-groups-v2.ts';
import {AGENT_TASK_LOCALES} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskSnapshot} from '../packages/contracts/src/agent-tasks-v2.ts';
import {object,revisionField,gate,output,call,fixture,recordedHints,m4ConflictPause} from './helpers/agent-task-runtime-fixture.ts';

for(const protocol of ['chat_completions','responses'] as const){
 test(`${protocol}: text diagnostics omit tools and replay cannot widen the persisted profile`,async t=>{
  const f=await fixture(t,protocol),input={requestId:randomUUID(),text:'仅检查文本连接',expectedSettingsRevision:testAgentExecution(await f.settings.get()).revision,diagnostic:{profile:'text'}};
  const sent=await f.runtime.send(f.projectId,input),done=await f.settle(sent.run.id);
  assert.equal(done.run.status,'completed');assert.deepEqual(done.run.diagnostic,{profile:'text'});assert.equal(f.effects.size,0);
  const body=object(JSON.parse(f.requests[0]!.body));for(const field of ['tools','tool_choice','parallel_tool_calls'])assert.equal(Object.hasOwn(body,field),false);
  assert.equal((await f.runtime.send(f.projectId,input)).run.id,sent.run.id);
  await assert.rejects(f.runtime.send(f.projectId,{...input,diagnostic:{profile:'catalog'}}),{code:'AGENT_TASK_REQUEST_CONFLICT'});
  f.restart();assert.deepEqual(f.runtime.get(f.projectId,sent.run.id).run.diagnostic,{profile:'text'});assert.equal(f.requests.length,1);
 });
 test(`${protocol}: read-only diagnostics roundtrip a tool and reject a write response before reading targets`,async t=>{
  const f=await fixture(t,protocol);f.setScript(async function*(index){yield {type:'done',output:output(protocol,index===1?[call('mioon_project_inspect')]:[])};});
  const sent=await f.runtime.send(f.projectId,{requestId:randomUUID(),text:'读取项目名称',expectedSettingsRevision:testAgentExecution(await f.settings.get()).revision,diagnostic:{profile:'read_only'}}),done=await f.settle(sent.run.id);
  assert.equal(done.run.status,'completed');assert.equal(f.requests.length,2);assert.equal(f.effects.size,1);assert.equal(done.changes.length,0);
  const names=(object(JSON.parse(f.requests[0]!.body)).tools as Record<string,unknown>[]).map(tool=>protocol==='chat_completions'?String(object(tool.function).name):String(tool.name));
  assert.ok(names.includes('mioon_project_inspect'));assert.ok(!names.includes('mioon_shot_update'));
  f.setScript(async function*(){yield {type:'done',output:output(protocol,[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:f.first.revision,patch:{prompt:'forbidden'}})])};});
  const denied=await f.runtime.send(f.projectId,{requestId:randomUUID(),text:'拒绝诊断写入',expectedSettingsRevision:testAgentExecution(await f.settings.get()).revision,diagnostic:{profile:'read_only'}}),failed=await f.settle(denied.run.id);
  assert.equal(failed.run.status,'failed');assert.equal(failed.run.pauseReason,'AGENT_TASK_DIAGNOSTIC_TOOL_FORBIDDEN');assert.equal(f.effects.size,1);assert.equal(failed.steps.filter(step=>step.kind==='tool').length,0);assert.equal(object(f.store.get('shots',f.first.id)).prompt,'saved first');
 });
 test(`${protocol}: catalog probes describe an admitted subset without executing returned tools`,async t=>{
  const f=await fixture(t,protocol);f.setScript(async function*(){yield {type:'done',output:output(protocol,[call('mioon_shot_create',{title:'Never created',prompt:'probe'})])};});
  const diagnostic={profile:'catalog',toolNames:['mioon_shot_create']},input={requestId:randomUUID(),text:'检查工具schema',expectedSettingsRevision:testAgentExecution(await f.settings.get()).revision,diagnostic};
  const sent=await f.runtime.send(f.projectId,input),done=await f.settle(sent.run.id);
  assert.equal(done.run.status,'completed');assert.deepEqual(done.run.diagnostic,diagnostic);assert.equal(done.steps.length,1);assert.equal(f.effects.size,0);assert.equal(done.changes.length,0);assert.equal(f.requests.length,1);
  assert.equal((object(JSON.parse(f.requests[0]!.body)).tools as unknown[]).length,1);
  f.restart();assert.deepEqual(f.runtime.get(f.projectId,sent.run.id).run.diagnostic,diagnostic);
  await assert.rejects(f.runtime.send(f.projectId,{...input,requestId:randomUUID(),diagnostic:{profile:'catalog',toolNames:['mioon_agent_authorization_grant']}}),{code:'AGENT_TASK_INVALID'});assert.equal(f.requests.length,1);
 });
}
test('diagnostics cannot enter ordinary conversation history or narrow normal tool discovery',async t=>{
 const f=await fixture(t);f.setScript(async function*(){yield {type:'done',output:output('responses',[],'DIAGNOSTIC_PRIVATE_CONTEXT')};});
 const sent=await f.runtime.send(f.projectId,{requestId:randomUUID(),text:'DIAGNOSTIC_PROMPT',expectedSettingsRevision:testAgentExecution(await f.settings.get()).revision,diagnostic:{profile:'text'}});await f.settle(sent.run.id);
 f.setScript(async function*(){yield {type:'done',output:output('responses')};});const normal=await f.send('普通任务');await f.settle(normal.run.id);
 const request=f.requests[1]!,names=(object(JSON.parse(request.body)).tools as Record<string,unknown>[]).map(tool=>String(tool.name));assert.doesNotMatch(request.body,/DIAGNOSTIC_PRIVATE_CONTEXT|DIAGNOSTIC_PROMPT/u);assert.deepEqual(names,f.tools.list().filter(tool=>agentTaskToolNamesForGroup('core').includes(tool.name)).map(tool=>tool.name));assert.equal(f.runtime.get(f.projectId,normal.run.id).run.diagnostic,undefined);assert.equal(f.runtime.history(f.projectId).conversations.length,1);assert.equal(f.runtime.history(f.projectId).conversations[0]?.lastRunId,normal.run.id);assert.equal((await f.runtime.snapshot(f.projectId)).runs.length,1);assert.throws(()=>f.runtime.conversation(f.projectId,sent.run.conversationId!),{code:'AGENT_TASK_NOT_FOUND'});
});

for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: conversations bind prior context, exclude other conversations and retain exact request identity`,async t=>{
 const f=await fixture(t,protocol);f.setScript(async function*(index){yield {type:'done',output:output(protocol,[],`reply ${index}`)};});
 const settings=await f.settings.get(),send=(text:string,conversationId?:string,requestId:string=randomUUID())=>f.runtime.send(f.projectId,{requestId,text,expectedSettingsRevision:testAgentExecution(settings).revision,...(conversationId?{conversationId}:{})});
 const first=await send('conversation A first');await f.settle(first.run.id);assert.ok(first.run.conversationId);assert.notEqual(first.run.conversationId,first.run.id);
 const other=await send('conversation B private');await f.settle(other.run.id);assert.notEqual(other.run.conversationId,first.run.conversationId);
 const requestId=randomUUID(),next=await send('conversation A next',first.run.conversationId,requestId);await f.settle(next.run.id);
 const retained=f.runtime.journal.run(next.run.id).context!;assert.ok(JSON.stringify(retained).includes('conversation A first'));assert.doesNotMatch(JSON.stringify(retained),/conversation B private|reply 2/u);
 assert.equal((await send('conversation A next',first.run.conversationId,requestId)).run.id,next.run.id);
 await assert.rejects(send('conversation A next',undefined,requestId),{code:'AGENT_TASK_REQUEST_CONFLICT'});
 await assert.rejects(send('conversation A first',first.run.conversationId,first.run.requestId),{code:'AGENT_TASK_REQUEST_CONFLICT'});
 const before=f.requests.length;await assert.rejects(send('missing',randomUUID()),{code:'AGENT_TASK_NOT_FOUND'});assert.equal(f.requests.length,before);
 await assert.rejects(f.runtime.send(f.projectId,{requestId:randomUUID(),text:'diagnostic cannot join',expectedSettingsRevision:testAgentExecution(settings).revision,conversationId:first.run.conversationId,diagnostic:{profile:'text'}}),{code:'AGENT_TASK_INVALID'});
 const history=f.runtime.history(f.projectId);assert.equal(history.conversations.length,2);const group=history.conversations.find(item=>item.id===first.run.conversationId);assert.ok(group);assert.equal(group.title,'conversation A first');assert.equal(group.runCount,2);assert.equal(group.lastRunId,next.run.id);
 const page=f.runtime.conversation(f.projectId,first.run.conversationId!);assert.deepEqual(new Set(page.runs.map(run=>run.id)),new Set([first.run.id,next.run.id]));assert.ok(page.runs.every(run=>!Object.hasOwn(run,'context')));assert.equal(f.requests.length,before);
});

test('diagnostics cannot evict a normal conversation from the recent100 project snapshot',async t=>{
 const f=await fixture(t),journal=f.runtime.journal;
 const write=(text:string,diagnostic?:{profile:'text'})=>{const run=journal.create({requestId:randomUUID(),projectId:f.projectId,text,configuration:{},...(diagnostic?{diagnostic}:{})}).run;return journal.transition(run.id,run.revision,'completed');};
 const normal=write('Visible ordinary conversation');let diagnostic=normal;for(let index=0;index<102;index++)diagnostic=write(`Private diagnostic ${index}`,{profile:'text'});
 assert.equal(journal.list(f.projectId).length,100);assert.ok(journal.list(f.projectId).every(run=>run.diagnostic));const snapshot=await f.runtime.snapshot(f.projectId);assert.deepEqual(snapshot.runs.map(run=>run.id),[normal.id]);assert.equal(f.runtime.history(f.projectId).conversations.length,1);
 const receipt=f.runtime.lookup(f.projectId,diagnostic.requestId);assert.equal(receipt.found,true);assert.equal(receipt.snapshot?.run.id,diagnostic.id);assert.equal(f.requests.length,0);
});

for(const protocol of ['chat_completions','responses'] as const){
 test(`${protocol}: conflict skip retains the draft, rejects repeated explicit targets and lets another target and a new run proceed`,async t=>{
  const f=await fixture(t,protocol),target={kind:'shot',id:f.first.id,revision:f.runtime.journal.targetRevision(f.projectId,'shot',f.first.id)},ownerId=randomUUID();
  const {sent,paused}=await m4ConflictPause(f,{reason:'editing',target,protocol,ownerId,calls:[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'blocked initial'}}),call('mioon_version_list',{shotId:f.first.id})],script:index=>index===2?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'blocked again'}}),call('mioon_version_list',{shotId:f.first.id}),call('mioon_shot_update',{shotId:f.other.id,expectedRevision:1,patch:{prompt:'other allowed'}}),call('mioon_project_inspect')]:[]});assert.equal(paused.run.pauseReason,'editing');
  await assert.rejects(f.action(paused,'resume'),{code:'AGENT_TASK_SKIP_REQUIRED'});assert.deepEqual(f.runtime.journal.run(sent.run.id).skippedTargets,[]);
  const request={requestId:randomUUID(),expectedRevision:paused.run.revision,action:'skip'};await f.runtime.action(f.projectId,sent.run.id,request);const done=await f.settle(sent.run.id);
  assert.equal(done.run.status,'completed');assert.equal(done.run.skippedTargets?.length,1);assert.equal(done.run.skippedTargets?.[0]?.target.id,f.first.id);assert.equal(done.changes.length,1);assert.equal(done.changes[0]?.operation,'shot.update');assert.equal(f.effects.size,3);assert.equal(f.loadingEffects,1);assert.equal(f.loadingRequests,1);
  assert.equal(object(f.store.get('shots',f.first.id)).prompt,'saved first');assert.equal(object(f.store.get('shots',f.other.id)).prompt,'other allowed');assert.equal(f.runtime.journal.claims(f.projectId).length,1);
  assert.equal(done.steps.filter(step=>step.status==='denied'&&step.error?.code==='TARGET_SKIPPED').length,2);assert.match(f.scriptRequest(2).body,/TARGET_SKIPPED/);assert.match(f.scriptRequest(3).body,/这一处由用户保留，本轮不要再改/u);
  const stable=f.runtime.journal.snapshot(sent.run.id);await f.runtime.action(f.projectId,sent.run.id,request);assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),stable);
  f.runtime.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId,generation:1,sequence:2,action:'release',targets:[target]});
  let round=0;f.setScript(async function*(){yield {type:'done',output:output(protocol,round++===0?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'new run allowed'}})]:[])};},{loadGroups:['canvas']});
  const next=await f.send('new run');assert.deepEqual(next.run.skippedTargets,[]);assert.equal((await f.settle(next.run.id)).run.status,'completed');assert.equal(object(f.store.get('shots',f.first.id)).prompt,'new run allowed');
 });
 test(`${protocol}: notes arriving during a final model response join only the next request and survive same-conversation context`,async t=>{
  const f=await fixture(t,protocol),entered=gate(),release=gate();f.setScript(async function*(index){if(index===1){entered.resolve();await release.promise;}yield {type:'done',output:output(protocol,[],index===1?'first response':'noted response')};});
  const sent=await f.send('initial message');await entered.promise;const initialBody=f.requests[0]!.body,current=f.runtime.get(f.projectId,sent.run.id),request={requestId:randomUUID(),expectedRevision:current.run.revision,action:'note',text:'KEEP_THIS_ADDITIONAL_INSTRUCTION'};
  const noted=await f.runtime.action(f.projectId,sent.run.id,request);assert.equal(noted.run.notes?.length,1);assert.equal(noted.run.notes?.[0]?.modelStepId,undefined);await f.runtime.action(f.projectId,sent.run.id,request);assert.equal(f.runtime.journal.run(sent.run.id).notes?.length,1);
  await assert.rejects(f.runtime.action(f.projectId,sent.run.id,{...request,text:'different text'}),{code:'AGENT_TASK_REQUEST_CONFLICT'});assert.equal(f.requests[0]!.body,initialBody);assert.doesNotMatch(initialBody,/KEEP_THIS_ADDITIONAL_INSTRUCTION/);
  release.resolve();const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.run.stepsUsed,2);assert.equal(f.requests.length,2);assert.match(f.requests[1]!.body,/KEEP_THIS_ADDITIONAL_INSTRUCTION/);assert.equal(done.run.notes?.[0]?.modelStepId,done.steps.filter(step=>step.kind==='model')[1]?.id);
  const next=await f.runtime.send(f.projectId,{requestId:randomUUID(),text:'same conversation next round',conversationId:done.run.conversationId,expectedSettingsRevision:testAgentExecution(await f.settings.get()).revision});assert.equal((await f.settle(next.run.id)).run.status,'completed');assert.match(f.requests[2]!.body,/KEEP_THIS_ADDITIONAL_INSTRUCTION/);
 });
}
for(const state of ['paused','awaiting_approval'] as const)test(`notes submitted while ${state} wait for a new model request, not the pending tool batch`,async t=>{
 const f=await fixture(t),entered=gate(),release=gate();if(state==='awaiting_approval')f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,read_only:'confirm'}});
 f.setScript(async function*(index){if(index===1){entered.resolve();await release.promise;}yield {type:'done',output:output('responses',index===1?[call('mioon_project_inspect')]:[])};});const sent=await f.send();await entered.promise;
 if(state==='paused')await f.action(f.runtime.get(f.projectId,sent.run.id),'pause');release.resolve();let waiting=await f.settle(sent.run.id);assert.equal(waiting.run.status,state);
 waiting=await f.action(waiting,'note',{text:`NOTE_IN_${state}`});assert.equal(waiting.run.status,state);assert.equal(waiting.run.notes?.[0]?.modelStepId,undefined);assert.equal(f.requests.length,1);
 if(state==='paused')await f.action(waiting,'resume');else await f.action(waiting,'approve',{stepId:waiting.steps.find(step=>step.status==='awaiting_approval')?.id});
 const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.effects.size,1);assert.equal(f.requests.length,2);assert.match(f.requests[1]!.body,new RegExp(`NOTE_IN_${state}`));assert.equal(done.run.stepsUsed,3);
});
test('queued notes have a five-item limit, durable rejected receipts, exact replay, and no notes after a stopped run',async t=>{
 const f=await fixture(t),entered=gate(),release=gate();f.setScript(async function*(){entered.resolve();await release.promise;yield {type:'done',output:output('responses')};});const sent=await f.send();await entered.promise;await f.action(f.runtime.get(f.projectId,sent.run.id),'pause');
 let current=f.runtime.get(f.projectId,sent.run.id);for(let index=0;index<5;index++)current=await f.action(current,'note',{text:`queued ${index}`});
 const rejected={requestId:randomUUID(),expectedRevision:current.run.revision,action:'note',text:'sixth note'};await assert.rejects(f.runtime.action(f.projectId,sent.run.id,rejected),{code:'AGENT_TASK_NOTE_LIMIT'});assert.deepEqual(f.runtime.journal.lookupControl(rejected.requestId)?.result,{state:'rejected',code:'AGENT_TASK_NOTE_LIMIT'});assert.equal(f.runtime.journal.run(sent.run.id).notes?.length,5);
 await f.runtime.action(f.projectId,sent.run.id,rejected);assert.equal(f.runtime.journal.run(sent.run.id).notes?.length,5);await assert.rejects(f.action(current,'note',{text:' '.repeat(10)}),{code:'AGENT_TASK_INVALID'});await assert.rejects(f.action(current,'note',{text:'汉'.repeat(11000)}),{code:'AGENT_TASK_INVALID'});
 const stopped=await f.action(current,'stop');assert.deepEqual(stopped.run.skippedTargets,[]);await assert.rejects(f.action(stopped,'note',{text:'after stop'}),{code:'AGENT_TASK_STATE_CONFLICT'});release.resolve();await f.settle(sent.run.id);assert.equal(f.requests.length,1);
});
test('a final response note at the safety limit stays pending until explicit continuation of the same run',async t=>{
 const f=await fixture(t,'responses',new Map(),{safetyStepLimit:1}),entered=gate(),release=gate();f.setScript(async function*(index){if(index===1){entered.resolve();await release.promise;}yield {type:'done',output:output('responses')};});
 const sent=await f.send();await entered.promise;await f.action(f.runtime.get(f.projectId,sent.run.id),'note',{text:'pending across budget'});release.resolve();const paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,'safety_limit');assert.equal(paused.run.notes?.[0]?.modelStepId,undefined);assert.equal(f.requests.length,1);
 await f.action(paused,'resume');const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.deepEqual(f.runtime.journal.safetyWindow(sent.run.id),{startStepsUsed:1,afterPosition:1,remaining:0});assert.equal(done.run.stepsUsed,2);assert.match(f.requests[1]!.body,/pending across budget/);assert.ok(done.run.notes?.[0]?.modelStepId);
});
test('failed model intent rolls back note binding and cannot submit its request',async t=>{
 const f=await fixture(t),entered=gate(),release=gate();f.setScript(async function*(){entered.resolve();await release.promise;yield {type:'done',output:output('responses')};});const sent=await f.send();await entered.promise;await f.action(f.runtime.get(f.projectId,sent.run.id),'note',{text:'must remain queued'});
 f.store.db.exec("CREATE TEMP TRIGGER fail_note_model_intent BEFORE INSERT ON mio_steps WHEN NEW.position=2 BEGIN SELECT RAISE(ABORT,'synthetic note intent failure');END;");release.resolve();const done=await f.settle(sent.run.id);assert.equal(f.requests.length,1);assert.equal(done.steps.length,1);assert.equal(done.run.notes?.[0]?.modelStepId,undefined);assert.ok(done.run.status!=='completed');assert.equal(done.run.stepsUsed,1);
});
test('stopping a conflict never adds skipped targets or releases a user draft',async t=>{
 const f=await fixture(t),{paused}=await m4ConflictPause(f,{reason:'editing',target:{kind:'shot',id:f.first.id},calls:[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'never'}})]}),stopped=await f.action(paused,'stop');assert.equal(stopped.run.status,'stopped');assert.deepEqual(stopped.run.skippedTargets,[]);assert.equal(f.runtime.journal.claims(f.projectId).length,1);assert.equal(f.effects.size,1);assert.equal(f.loadingEffects,1);assert.equal(f.requests.length,2);
});

test('a multi-target conflict hands back only the claimed target, and another target can still be changed',async t=>{
 const f=await fixture(t),target={kind:'shot',id:f.first.id,revision:f.runtime.journal.targetRevision(f.projectId,'shot',f.first.id)},project=object(f.store.get('projects',f.projectId));f.runtime.journal.claim({projectId:f.projectId,ownerId:'multi-target-user',targets:[target]});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_shot_reorder',{expectedRevision:revisionField(project),shotIds:[f.other.id,f.first.id]})]:index===2?[call('mioon_shot_update',{shotId:f.other.id,expectedRevision:1,patch:{prompt:'unaffected edit'}})]:[])};},{loadGroups:['canvas']});const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');const step=f.runtime.journal.snapshot(sent.run.id).steps.find(step=>step.toolCall?.name==='mioon_shot_reorder');assert.ok(step);assert.equal(step.targets?.length,2);assert.equal(step.status,'rejected');assert.equal(step.error?.code,'TARGET_EDITING');const current=object(object(step.result).error).current;assert.ok(Array.isArray(current));assert.deepEqual(current.map(entry=>[object(entry).kind,object(entry).id]),[['shot',f.first.id]]);assert.deepEqual(done.run.skippedTargets,[]);assert.equal(object(f.store.get('shots',f.other.id)).prompt,'unaffected edit');assert.equal(done.changes.length,1);
});
test('failed note receipt rolls back the queued text and event as one transaction',async t=>{
 const f=await fixture(t),entered=gate(),release=gate();f.setScript(async function*(){entered.resolve();await release.promise;yield {type:'done',output:output('responses')};});const sent=await f.send();await entered.promise;const current=f.runtime.get(f.projectId,sent.run.id),request={requestId:randomUUID(),expectedRevision:current.run.revision,action:'note',text:'must not partially save'},before=f.runtime.journal.snapshot(sent.run.id),events=f.runtime.journal.events(sent.run.id);
 f.store.db.exec(`CREATE TEMP TRIGGER fail_note_receipt BEFORE INSERT ON mio_controls WHEN NEW.requestId='${request.requestId}' BEGIN SELECT RAISE(ABORT,'synthetic note receipt failure');END;`);await assert.rejects(f.runtime.action(f.projectId,sent.run.id,request),{code:'AGENT_TASK_STORAGE_UNAVAILABLE'});assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),before);assert.deepEqual(f.runtime.journal.events(sent.run.id),events);assert.equal(f.runtime.journal.lookupControl(request.requestId),null);release.resolve();await f.settle(sent.run.id);assert.equal(f.requests.length,1);
});
test('a bound note in an unknown model request is never automatically resubmitted after restart',async t=>{
 const f=await fixture(t),first=gate(),releaseFirst=gate(),second=gate(),releaseSecond=gate();f.setScript(async function*(index){if(index===1){first.resolve();await releaseFirst.promise;}if(index===2){second.resolve();await releaseSecond.promise;}yield {type:'done',output:output('responses')};});const sent=await f.send();await first.promise;await f.action(f.runtime.get(f.projectId,sent.run.id),'note',{text:'BOUND_NOTE_UNKNOWN'});releaseFirst.resolve();await second.promise;const body=f.requests[1]!.body;assert.match(body,/BOUND_NOTE_UNKNOWN/);f.restart();const interrupted=f.runtime.get(f.projectId,sent.run.id);assert.equal(interrupted.run.status,'interrupted');assert.equal(f.requests.length,2);assert.equal(interrupted.steps.at(-1)?.status,'unknown');assert.equal(interrupted.run.notes?.[0]?.modelStepId,interrupted.steps.at(-1)?.id);await assert.rejects(f.action(interrupted,'resume'),{code:'AGENT_TASK_UNKNOWN_RESULT'});assert.equal(f.requests.length,2);assert.equal(f.requests[1]!.body,body);releaseSecond.resolve();
 const disposed=await f.action(interrupted,'resolve_unknown',{stepId:interrupted.steps.at(-1)?.id,resolution:'discard'});await f.action(disposed,'resume');assert.equal((await f.settle(sent.run.id)).run.status,'completed');assert.equal(f.requests.length,3);assert.ok(recordedHints(f,sent.run.id,'notes_bound').length>0);assert.equal(f.runtime.journal.run(sent.run.id).notes?.length,1);
});
test('skipped-target instructions use the submitted locale in every model continuation',async t=>{
 const expected={'zh-Hans':'这一处由用户保留，本轮不要再改','zh-Hant':'這一處由使用者保留，本輪不要再修改',en:'The user kept this target.',ja:'この対象はユーザーが保持しました。'};
 for(const locale of AGENT_TASK_LOCALES){const f=await fixture(t),{sent,paused}=await m4ConflictPause(f,{reason:'editing',target:{kind:'shot',id:f.first.id},locale,text:'synthetic skip locale',ownerId:'locale-skip-user',calls:[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'never applies'}})]});assert.equal(paused.run.pauseReason,'editing');await f.action(paused,'skip');assert.equal((await f.settle(sent.run.id)).run.status,'completed');assert.ok(f.scriptRequest(2).body.includes(expected[locale]));assert.equal(f.effects.size,1);assert.equal(f.loadingEffects,1);}
});
test('a note accepted during replay of a completed tool is observed before completing the saved final reply',async t=>{
 const f=await fixture(t),enteredFinal=gate(),releaseFinal=gate();f.setScript(async function*(index){if(index===2){enteredFinal.resolve();await releaseFinal.promise;}yield {type:'done',output:output('responses',index===1?[call('mioon_project_inspect')]:[])};});const sent=await f.send();await enteredFinal.promise;await f.action(f.runtime.get(f.projectId,sent.run.id),'pause');releaseFinal.resolve();const paused=await f.settle(sent.run.id);assert.equal(paused.run.status,'paused');assert.equal(paused.steps.filter(step=>step.kind==='model'&&step.status==='completed').length,2);
 const completedTool=paused.steps.find(step=>step.kind==='tool'&&step.status==='completed');assert.ok(completedTool);
 const original=f.runtime.journal.step;let scheduled=false,injected:Promise<AgentTaskSnapshot>|undefined;
 f.runtime.journal.step=(id:string)=>{
  const step=original(id);
  // Queue the note at the replay's durable read of the completed tool, before
  // the executor handles the already saved final model reply.
  if(id===completedTool.id&&!scheduled){
   scheduled=true;
   queueMicrotask(()=>{injected=f.action(f.runtime.get(f.projectId,step.runId),'note',{text:'NOTE_AT_COMPLETED_TOOL_YIELD'});});
  }
  return step;
 };
 await f.action(paused,'resume');const done=await f.settle(sent.run.id);assert.ok(injected,'The completed-tool replay yielded to the queued note');await injected;assert.equal(done.run.status,'completed');assert.equal(done.run.notes?.length,1);assert.ok(done.run.notes?.[0]?.modelStepId);assert.equal(f.requests.length,3);assert.match(f.requests[2]!.body,/NOTE_AT_COMPLETED_TOOL_YIELD/);
});
test('a text diagnostic cut off by a restart stops instead of blocking the project, and stays the latest connection test',async t=>{
  const f=await fixture(t),settings=await f.settings.get();assert.deepEqual(f.runtime.latestConnectionTest(),{test:null});
  const created=f.runtime.journal.create({projectId:f.projectId,requestId:randomUUID(),text:'PRIVATE_CONNECTION_TEST_TEXT',configuration:{...testAgentExecution(settings).configuration},settingsRevision:testAgentExecution(settings).revision,settingsBinding:testAgentExecution(settings).binding,diagnostic:{profile:'text'}});
  const step=beginFixtureModelStep(f.runtime.journal,created.run.id).step;f.runtime.journal.updateStep(created.run.id,step.id,{status:'dispatch_started'});
  f.restart();const stopped=f.runtime.get(f.projectId,created.run.id);
  assert.equal(stopped.run.status,'stopped');assert.equal(stopped.run.pauseReason,'restart');assert.equal(stopped.steps[0]!.status,'unknown');
  const latest=f.runtime.latestConnectionTest().test!;
  assert.deepEqual({...latest,createdAt:undefined,updatedAt:undefined},{runId:created.run.id,projectId:f.projectId,status:'stopped',protocol:testAgentExecution(settings).configuration.protocol,baseUrl:testAgentExecution(settings).configuration.baseUrl,model:testAgentExecution(settings).configuration.model,createdAt:undefined,updatedAt:undefined});
  assert.doesNotMatch(JSON.stringify(latest),/PRIVATE_CONNECTION_TEST_TEXT/u);
  const sent=await f.send();assert.equal((await f.settle(sent.run.id)).run.status,'completed','A stopped diagnostic leaves the project free for the next send');
});
test('the latest connection test is the newest text diagnostic and reports only a failed run\'s code',async t=>{
  const f=await fixture(t,'chat_completions'),revision=testAgentExecution(await f.settings.get()).revision;
  const diagnose=(profile:'text'|'read_only')=>f.runtime.send(f.projectId,{requestId:randomUUID(),text:'检查连接',expectedSettingsRevision:revision,diagnostic:{profile}});
  const passed=await diagnose('text');await f.settle(passed.run.id);
  assert.equal(f.runtime.latestConnectionTest().test?.runId,passed.run.id);assert.equal(f.runtime.latestConnectionTest().test?.status,'completed');assert.equal(Object.hasOwn(f.runtime.latestConnectionTest().test!,'failureCode'),false);
  f.setScript(async function*(){throw Object.assign(new Error('PRIVATE_PROVIDER_BODY'),{code:'AGENT_CHAT_HTTP_ERROR',httpStatus:401});});
  const failed=await diagnose('text');await f.settle(failed.run.id);
  assert.deepEqual([f.runtime.latestConnectionTest().test?.runId,f.runtime.latestConnectionTest().test?.status,f.runtime.latestConnectionTest().test?.failureCode],[failed.run.id,'failed','AGENT_CHAT_HTTP_ERROR']);
  assert.doesNotMatch(JSON.stringify(f.runtime.latestConnectionTest()),/PRIVATE_PROVIDER_BODY|HTTP 401/u);
  f.setScript(async function*(){yield {type:'done',output:output('chat_completions',[])};});
  const readOnly=await diagnose('read_only');await f.settle(readOnly.run.id);
  assert.equal(f.runtime.latestConnectionTest().test?.runId,failed.run.id,'Other diagnostic profiles are not connection tests');
  const ordinary=await f.send();await f.settle(ordinary.run.id);assert.equal(f.runtime.latestConnectionTest().test?.runId,failed.run.id);
});
