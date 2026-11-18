import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {TaskModelOutput} from '../packages/business/src/agent/task-gateway-v2.ts';
import {taskContinuation,TASK_MODEL_LIMITS} from '../packages/business/src/agent/task-gateway-v2.ts';
import {taskBaseModelHistory} from '../packages/business/src/agent/task-context-base-v2.ts';
import {object,gate,output,call,fixture,replyOutput,longReadOutput,noteHistoryFixture} from './helpers/agent-task-runtime-fixture.ts';


for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: note combinations exceeding known request capacity are durably rejected without failing the run`,async t=>{
 const f=await fixture(t,protocol),entered=gate(),release=gate();
 f.setScript(async function*(index){if(index===1){entered.resolve();await release.promise;}yield {type:'done',output:output(protocol,[],`response ${index}`)};});
 const sent=await f.send('initial message');await entered.promise;
 let current=f.runtime.get(f.projectId,sent.run.id);
 for(let index=0;index<3;index++)current=await f.action(current,'note',{text:String(index).repeat(32*1024)});
 const before=f.runtime.journal.snapshot(sent.run.id),body=f.requests[0]!.body,request={requestId:randomUUID(),expectedRevision:current.run.revision,action:'note',text:'x'.repeat(32*1024)};
 let rejected:unknown;try{await f.runtime.action(f.projectId,sent.run.id,request);}catch(error){rejected=error;}
 const after=f.runtime.journal.snapshot(sent.run.id),receipt=f.runtime.journal.lookupControl(request.requestId);
 await f.runtime.action(f.projectId,sent.run.id,request);
 release.resolve();const done=await f.settle(sent.run.id);
 assert.equal(object(rejected).code,'AGENT_TASK_NOTE_CAPACITY');assert.deepEqual(after,before);assert.deepEqual(receipt?.result,{state:'rejected',code:'AGENT_TASK_NOTE_CAPACITY'});
 assert.equal(done.run.status,'completed');assert.equal(done.run.notes?.length,3);assert.ok(done.run.notes?.every(note=>note.modelStepId!==undefined));assert.equal(f.requests.length,2);assert.equal(f.requests[0]!.body,body);
 for(const request of f.requests)assert.ok(Buffer.byteLength(request.body)<=TASK_MODEL_LIMITS.requestBytes);
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: note capacity accounts for serialized text and retains the run on rejection`,async t=>{
 const f=await fixture(t,protocol),entered=gate(),release=gate();f.setScript(async function*(index){if(index===1){entered.resolve();await release.promise;}yield {type:'done',output:output(protocol)};});
 const sent=await f.send();await entered.promise;const before=f.runtime.journal.snapshot(sent.run.id);
 let rejected:unknown;try{await f.action(f.runtime.get(f.projectId,sent.run.id),'note',{text:'\u0000'.repeat(32*1024)});}catch(error){rejected=error;}
 const after=f.runtime.journal.snapshot(sent.run.id);release.resolve();const done=await f.settle(sent.run.id);
 assert.equal(object(rejected).code,'AGENT_TASK_NOTE_CAPACITY');assert.deepEqual(after,before);assert.equal(done.run.status,'completed');assert.equal(done.run.notes?.length,0);assert.equal(f.requests.length,1);
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: note capacity counts the execution fallback for a retained terminal null result`,async t=>{
 const f=await fixture(t,protocol,new Map(),{safetyStepLimit:2});
 const execute=f.tools.execute;f.tools.execute=async(prepared,context)=>({...await execute(prepared,context),result:null});
 const prepare=f.tools.prepare;let preparations=0;f.tools.prepare=input=>{preparations++;return prepare(input);};
 f.setScript(async function*(index){yield {type:'done',output:longReadOutput(protocol,index===1?'r'.repeat(97000):'Complete.',index===1?[call('mioon_project_inspect')]:[])};});
 const sent=await f.send('u'.repeat(32000)),paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,'safety_limit');assert.equal(preparations,1);
 const before=f.runtime.journal.snapshot(sent.run.id),model=before.steps.find(step=>step.kind==='model'),tool=before.steps.find(step=>step.kind==='tool');assert.ok(model&&tool?.toolCall);assert.equal(tool.status,'completed');assert.equal(tool.result,null);
 const retained=object(model.result) as unknown as TaskModelOutput,history=taskBaseModelHistory(before.run.context??[]),withoutFallback=taskContinuation(protocol,retained,[{callId:tool.toolCall.id,result:null}]);
 const emptyNote={role:'user',content:''},length=TASK_MODEL_LIMITS.historyBytes-Buffer.byteLength(JSON.stringify([...history,...withoutFallback,emptyNote]));assert.ok(length>0&&length<=32*1024);
 const note='n'.repeat(length),withNote=[...history,...withoutFallback,{...emptyNote,content:note}];assert.equal(Buffer.byteLength(JSON.stringify(withNote)),TASK_MODEL_LIMITS.historyBytes);
 const executionRound=taskContinuation(protocol,retained,[{callId:tool.toolCall.id,result:{error:{code:'completed'}}}]);assert.ok(Buffer.byteLength(JSON.stringify([...history,...executionRound,{...emptyNote,content:note}]))>TASK_MODEL_LIMITS.historyBytes);
 const request={requestId:randomUUID(),expectedRevision:paused.run.revision,action:'note',text:note};
 await assert.rejects(f.runtime.action(f.projectId,sent.run.id,request),{code:'AGENT_TASK_NOTE_CAPACITY'});assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),before);assert.equal(preparations,1);assert.equal(f.effects.size,1);
 assert.deepEqual(f.runtime.journal.lookupControl(request.requestId)?.result,{state:'rejected',code:'AGENT_TASK_NOTE_CAPACITY'});
 await f.runtime.action(f.projectId,sent.run.id,request);assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),before);assert.equal(preparations,1);
 await f.action(f.runtime.get(f.projectId,sent.run.id),'resume');const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.deepEqual(done.run.notes,[]);assert.equal(f.requests.length,2);assert.equal(preparations,1);assert.equal(f.effects.size,1);
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: a thirty-step run retains full large results while compacting model views and accepting a later note`,{timeout:30000},async t=>{
 const f=await fixture(t,protocol),entered=gate(),release=gate(),current='Preserve this current production request.',note='KEEP_THE_ORIGINAL_COLOURS_AFTER_COMPACTION',candidateDigest='SYNTHETIC_BINDING_REQUIRES_REPREPARATION';
 const execute=f.tools.execute;f.tools.execute=async(prepared,context)=>{
  const outcome=await execute(prepared,context);
  return {...outcome,result:{payload:'result '.repeat(3000),candidateDigest}};
 };
 f.setScript(async function*(index){
  const text=`Reply ${index}: `+'m'.repeat(30*1024),calls=index===15?[]:Array.from({length:index===1?2:1},()=>call('mioon_project_inspect'));
  if(index===6){yield {type:'delta',text:text.slice(0,8193)};entered.resolve();await release.promise;yield {type:'delta',text:text.slice(8193)};}
  else yield {type:'delta',text};
  yield {type:'done',output:longReadOutput(protocol,text,calls)};
 });
 const sent=await f.send(current);await entered.promise;
 const before=f.runtime.journal.snapshot(sent.run.id),inflight=before.steps.filter(step=>step.kind==='model').at(-1);assert.ok(inflight);assert.equal(inflight.status,'dispatch_started');
 const frozen=structuredClone(inflight.request),frozenBody=f.requests[5]!.body;
 try{const accepted=await f.action(f.runtime.get(f.projectId,sent.run.id),'note',{text:note});assert.equal(accepted.run.notes?.[0]?.text,note);assert.deepEqual(f.runtime.journal.step(inflight.id).request,frozen);assert.equal(f.requests[5]!.body,frozenBody);}
 finally{release.resolve();await f.runtime.drain();}
 const done=f.runtime.get(f.projectId,sent.run.id),saved=f.runtime.journal.snapshot(sent.run.id),models=saved.steps.filter(step=>step.kind==='model'),toolSteps=saved.steps.filter(step=>step.kind==='tool');
 assert.equal(done.run.status,'completed');assert.equal(done.run.stepsUsed,30);assert.equal(done.run.budget,30);assert.equal(models.length,15);assert.equal(toolSteps.length,15);assert.equal(f.requests.length,15);assert.equal(f.effects.size,15);assert.equal(done.changes.length,0);
 for(const step of toolSteps){const result=object(step.result);assert.equal(result.payload,'result '.repeat(3000));assert.equal(result.candidateDigest,candidateDigest);}
 const histories=models.map(step=>{const value=object(step.request).history;assert.ok(Array.isArray(value));return value;});
 for(const [index,history]of histories.entries()){
  assert.ok(Buffer.byteLength(JSON.stringify(history))<=TASK_MODEL_LIMITS.historyBytes);assert.ok(history.some(value=>object(value).role==='user'&&object(value).content===current));
  assert.ok(!f.requests[index]!.body.includes(candidateDigest));
  if(index>=6)assert.equal(history.filter(value=>object(value).role==='user'&&object(value).content===note).length,1);
 }
 const firstCompaction=histories.findIndex((history,index)=>index>0&&Buffer.byteLength(JSON.stringify(history))<Buffer.byteLength(JSON.stringify(histories[index-1])));
 assert.ok(firstCompaction>0&&firstCompaction+1<models.length);assert.deepEqual(histories[firstCompaction+1]!.slice(0,histories[firstCompaction]!.length),histories[firstCompaction]);
 assert.deepEqual(f.runtime.journal.step(inflight.id).request,frozen);assert.equal(done.run.notes?.[0]?.modelStepId,models[6]?.id);
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: note capacity rejects an already persisted streamed reply atomically and replays its rejection`,async t=>{
 // No earlier conversation is available to drop: the current user message,
 // persisted latest reply and new note are all protected content.
 const f=await fixture(t,protocol),entered=gate(),release=gate(),reply='r'.repeat(98500),note='n'.repeat(1024);
 f.setScript(async function*(){yield {type:'delta',text:reply};entered.resolve();await release.promise;yield {type:'done',output:replyOutput(protocol,reply)};});
 const sent=await f.send('u'.repeat(32000));await entered.promise;
 try{
  const before=f.runtime.journal.snapshot(sent.run.id),events=f.runtime.journal.events(sent.run.id),model=before.steps.find(step=>step.kind==='model');assert.ok(model);assert.equal(model.status,'dispatch_started');assert.equal(model.text,reply);
  const historyBytes=Buffer.byteLength(JSON.stringify(taskBaseModelHistory(before.run.context??[])));assert.ok(historyBytes+Buffer.byteLength(note)+200<TASK_MODEL_LIMITS.historyBytes);assert.ok(historyBytes+Buffer.byteLength(model.text)+Buffer.byteLength(note)>TASK_MODEL_LIMITS.historyBytes);
  const body=f.requests.at(-1)!.body,request={requestId:randomUUID(),expectedRevision:before.run.revision,action:'note',text:note};
  await assert.rejects(f.runtime.action(f.projectId,sent.run.id,request),{code:'AGENT_TASK_NOTE_CAPACITY'});
  const rejectedEvents=f.runtime.journal.events(sent.run.id),receipt=f.runtime.journal.lookupControl(request.requestId);assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),before);assert.deepEqual(rejectedEvents.slice(0,-1),events);assert.equal(rejectedEvents.at(-1)?.type,'invalidate');assert.equal(rejectedEvents.at(-1)?.data,null);assert.deepEqual(f.store.db.prepare('SELECT data FROM mio_controls WHERE requestId=?').get(request.requestId)?.data,JSON.stringify(receipt));assert.deepEqual(receipt,{requestId:request.requestId,runId:sent.run.id,action:'note',revision:before.run.revision,result:{state:'rejected',code:'AGENT_TASK_NOTE_CAPACITY'}});
  await f.runtime.action(f.projectId,sent.run.id,request);assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),before);assert.deepEqual(f.runtime.journal.events(sent.run.id),rejectedEvents);
  await assert.rejects(f.runtime.action(f.projectId,sent.run.id,{...request,text:'changed text'}),{code:'AGENT_TASK_REQUEST_CONFLICT'});
  assert.equal(f.requests.at(-1)!.body,body);
 }finally{release.resolve();await f.runtime.drain();}
 const done=f.runtime.get(f.projectId,sent.run.id);assert.equal(done.run.status,'completed');assert.deepEqual(done.run.notes,[]);assert.equal(f.requests.length,1);assert.equal(done.steps.filter(step=>step.kind==='model').length,1);
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: note capacity compacts earlier conversation rounds while preserving persisted output and its intent`,async t=>{
 const f=await noteHistoryFixture(t,protocol),entered=gate(),release=gate(),reply='r'.repeat(8193),note='ADDITIONAL_COLOUR_CONSTRAINT_'+'n'.repeat(1024);let count=0;
 f.setScript(async function*(){if(++count===1){yield {type:'delta',text:reply};entered.resolve();await release.promise;yield {type:'done',output:replyOutput(protocol,reply)};}else yield {type:'done',output:replyOutput(protocol,'Compacted follow-up complete')};});
 const sent=await f.sendNext();await entered.promise;
 const before=f.runtime.journal.snapshot(sent.run.id),model=before.steps.find(step=>step.kind==='model');assert.ok(model);assert.equal(model.text,reply);
 const frozen=model.request,initialBody=f.requests.at(-1)!.body,context=structuredClone(before.run.context);
 assert.ok(Buffer.byteLength(JSON.stringify(taskBaseModelHistory(before.run.context??[])))+Buffer.byteLength(reply)+Buffer.byteLength(note)>TASK_MODEL_LIMITS.historyBytes);
 try{
  const accepted=await f.action(f.runtime.get(f.projectId,sent.run.id),'note',{text:note});assert.equal(accepted.run.notes?.[0]?.text,note);
  assert.deepEqual(f.runtime.journal.step(model.id).request,frozen);assert.equal(f.requests.at(-1)!.body,initialBody);assert.deepEqual(f.runtime.journal.run(sent.run.id).context,context);
 }finally{release.resolve();await f.runtime.drain();}
 const done=f.runtime.get(f.projectId,sent.run.id),latest=f.runtime.journal.snapshot(sent.run.id).steps.filter(step=>step.kind==='model').at(-1);assert.ok(latest);
 assert.equal(done.run.status,'completed');assert.equal(f.requests.length,5);assert.ok(done.run.notes?.[0]?.modelStepId);
 const history=object(latest.request).history;assert.ok(Array.isArray(history));assert.ok(Buffer.byteLength(JSON.stringify(history))<=TASK_MODEL_LIMITS.historyBytes);
 assert.ok(f.requests.at(-1)!.body.includes(reply));assert.ok(f.requests.at(-1)!.body.includes(note));
 const oldReply='a'.repeat(2000),remaining=history.filter(value=>object(value).role==='assistant'&&object(value).content===oldReply).length;
 assert.ok(remaining<taskBaseModelHistory(context??[]).filter(value=>object(value).role==='assistant'&&object(value).content===oldReply).length);
 assert.deepEqual(f.runtime.journal.step(model.id).request,frozen);
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: note capacity accepts a persisted streamed reply below the limit without rewriting its intent`,async t=>{
 const f=await noteHistoryFixture(t,protocol,28000),entered=gate(),release=gate(),reply='r'.repeat(8193),note='n'.repeat(1024);let count=0;
 f.setScript(async function*(){if(++count===1){yield {type:'delta',text:reply};entered.resolve();await release.promise;yield {type:'done',output:replyOutput(protocol,reply)};}else yield {type:'done',output:replyOutput(protocol,'Follow-up complete')};});
 const sent=await f.sendNext();await entered.promise;
 try{
  const before=f.runtime.journal.snapshot(sent.run.id),model=before.steps.find(step=>step.kind==='model');assert.equal(model?.text,reply);const request=model?.request;
  assert.ok(Buffer.byteLength(JSON.stringify(taskBaseModelHistory(before.run.context??[])))+Buffer.byteLength(reply)+Buffer.byteLength(note)+1000<TASK_MODEL_LIMITS.historyBytes);
  const accepted=await f.action(before,'note',{text:note});assert.equal(accepted.run.notes?.[0]?.text,note);assert.deepEqual(f.runtime.journal.snapshot(sent.run.id).steps.find(step=>step.id===model?.id)?.request,request);
 }finally{release.resolve();await f.runtime.drain();}
 const done=f.runtime.get(f.projectId,sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.run.notes?.length,1);assert.ok(done.run.notes?.[0]?.modelStepId);assert.equal(f.requests.length,5);
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: note capacity does not invent unpersisted delta bytes`,async t=>{
 // Freeze the flush clock so this small delta is deterministically still in
 // the executor buffer, rather than relying on the test finishing within 250ms.
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-10-23T00:00:00.000Z')});
 const f=await noteHistoryFixture(t,protocol),entered=gate(),release=gate(),reply='r'.repeat(1024);let count=0;
 f.setScript(async function*(){if(++count===1){yield {type:'delta',text:reply};entered.resolve();await release.promise;yield {type:'done',output:replyOutput(protocol,reply)};}else yield {type:'done',output:replyOutput(protocol,'Short response')};});
 const sent=await f.sendNext();await entered.promise;
 try{const before=f.runtime.journal.snapshot(sent.run.id);assert.equal(before.steps.find(step=>step.kind==='model')?.text,undefined);assert.ok(f.runtime.journal.events(sent.run.id).every(event=>event.type!=='text'));await f.action(before,'note',{text:'n'.repeat(1024)});}
 finally{release.resolve();await f.runtime.drain();}
 const done=f.runtime.get(f.projectId,sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.run.notes?.length,1);assert.ok(done.run.notes?.[0]?.modelStepId);assert.equal(f.requests.length,5);
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: note capacity excludes an unknown reply that is explicitly discarded before continuing`,async t=>{
 const f=await noteHistoryFixture(t,protocol),reply='r'.repeat(8193);let count=0;
 f.setScript(async function*(){if(++count===1){yield {type:'delta',text:reply};throw Object.assign(Error('Synthetic unknown reply'),{code:'AGENT_TASK_UNKNOWN_RESULT'});}yield {type:'done',output:replyOutput(protocol,'Known replacement')};});
 const sent=await f.sendNext(),paused=await f.settle(sent.run.id),unknown=paused.steps.find(step=>step.kind==='model');assert.ok(unknown);assert.equal(unknown.status,'unknown');assert.equal(unknown.text,reply);
 const noted=await f.action(paused,'note',{text:'n'.repeat(1024)});await assert.rejects(f.action(noted,'resume'),{code:'AGENT_TASK_UNKNOWN_RESULT'});assert.equal(f.requests.length,4);
 await f.action(f.runtime.get(f.projectId,sent.run.id),'resolve_unknown',{stepId:unknown.id,resolution:'discard'});await f.action(f.runtime.get(f.projectId,sent.run.id),'resume');
 const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.run.notes?.length,1);assert.ok(done.run.notes?.[0]?.modelStepId);assert.equal(f.requests.length,5);assert.equal(f.requests.at(-1)!.body.includes(reply),false);
});
