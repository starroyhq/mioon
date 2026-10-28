import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../packages/business/src/agent/task-runtime-v2.ts';
import type {TaskGateway,TaskModelOutput,TaskModelRequest} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {AgentTaskControlAction,AgentTaskSnapshot} from '../packages/contracts/src/agent-tasks-v2.ts';
import {createTestAuthorizations,authorizeTestScope} from './helpers/agent-authorizations.ts';

const beginning=Date.parse('2026-10-28T00:00:00.000Z');
type Protocol='chat_completions'|'responses'|'anthropic_messages';
function object(value:unknown):Record<string,unknown>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;}
function gate(){let resolve=()=>{};const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
function output(protocol:Protocol,text:string):TaskModelOutput {
 return {text,toolCalls:[],providerOutput:protocol==='chat_completions'?{role:'assistant',content:text}:protocol==='responses'?[{type:'message',id:'synthetic-stream-message',status:'completed',role:'assistant',content:[{type:'output_text',text,annotations:[]}]}]:{role:'assistant',content:[{type:'text',text}]}};
}
async function fixture(t:TestContext,protocol:Protocol='responses'){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-task-streaming-v2-')),store=openStore(root),services=createServices(store,new Map());
 const projectId=String(object(await services.call('project.create',{name:'Streaming test'})).id);
 const settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}}),initial=await settings.get();
 await settings.put({expectedRevision:0,configuration:{...initial.configuration,protocol},secret:{action:'replace',storage:'session',value:'SYNTHETIC_LOCAL_TEST_ONLY'}});
 const authorizations=createTestAuthorizations(()=>({...store}),settings);await authorizeTestScope(authorizations,'project_agent');
 const tools=createAgentTaskTools({store,services}),requests:TaskModelRequest[]=[];
 let script:TaskGateway=async function*(){yield {type:'done',output:output(protocol,'Complete')};};
 const gateway:TaskGateway=async function*(request){requests.push(request);yield*script(request);};
 let runtime=createAgentTaskRuntime({store,agentSettings:settings,authorizations,tools,gateway,selfPort:()=>4318});
 t.after(async()=>{runtime.close();await runtime.drain();tools.dispose();await settings.close();store.close();rmSync(root,{recursive:true,force:true});});
 return {projectId,requests,get runtime(){return runtime;},setScript(value:TaskGateway){script=value;},
  async send(text='Stream a response',requestId:string=randomUUID()){return runtime.send(projectId,{requestId,text,expectedSettingsRevision:(await settings.get()).revision});},
  textEvents(runId:string){return runtime.journal.events(runId).filter(event=>event.type==='text').map(event=>{const text=object(event.data).text;assert.equal(typeof text,'string');return String(text);});},
  action(snapshot:AgentTaskSnapshot,action:AgentTaskControlAction,extra:Record<string,unknown>={}){return runtime.action(projectId,snapshot.run.id,{requestId:randomUUID(),expectedRevision:snapshot.run.revision,action,...extra});},
  restart(){runtime.close();runtime=createAgentTaskRuntime({store,agentSettings:settings,authorizations,tools,gateway,selfPort:()=>4318});},
 };
}

for(const protocol of ['chat_completions','responses','anthropic_messages'] as const)test(`${protocol}: streaming flushes above 8 KiB and keeps its final remainder visible`,async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:beginning});
 const f=await fixture(t,protocol),observed:Array<{text:string|undefined;events:string[]}>=[],prefix='x'.repeat(8192),tail='remaining';let runId='';
 f.setScript(async function*(){
  for(const text of [prefix,'é',tail]){
   yield {type:'delta',text};
   observed.push({text:f.runtime.get(f.projectId,runId).steps[0]?.text,events:f.textEvents(runId)});
  }
  yield {type:'done',output:output(protocol,prefix+'é'+tail)};
 });
 const sent=await f.send();runId=sent.run.id;await f.runtime.drain();
 assert.deepEqual(observed,[{text:undefined,events:[]},{text:prefix+'é',events:[prefix+'é']},{text:prefix+'é',events:[prefix+'é']}]);
 const done=f.runtime.get(f.projectId,runId);assert.equal(done.run.status,'completed');assert.equal(done.steps[0]?.text,prefix+'é'+tail);
 assert.deepEqual(f.textEvents(runId),[prefix+'é',tail]);assert.equal(f.requests.length,1);
});

test('streaming measures its size threshold in UTF-8 bytes rather than characters',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:beginning});
 const f=await fixture(t),prefix='界'.repeat(2730)+'ab',observed:Array<string|undefined>=[];let runId='';
 assert.equal(Buffer.byteLength(prefix),8192);assert.ok(prefix.length<8192);
 f.setScript(async function*(){
  yield {type:'delta',text:prefix};observed.push(f.runtime.get(f.projectId,runId).steps[0]?.text);
  yield {type:'delta',text:'🙂'};observed.push(f.runtime.get(f.projectId,runId).steps[0]?.text);
  yield {type:'done',output:output('responses',prefix+'🙂')};
 });
 const sent=await f.send();runId=sent.run.id;await f.runtime.drain();
 assert.deepEqual(observed,[undefined,prefix+'🙂']);assert.deepEqual(f.textEvents(runId),[prefix+'🙂']);
 assert.equal(f.runtime.get(f.projectId,runId).run.status,'completed');
});

test('streaming exposes a paused reply at 250 ms with one timer that later deltas do not postpone',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:beginning});
 const f=await fixture(t),first=gate(),second=gate(),third=gate(),next=gate(),last=gate(),finish=gate(),scheduled=t.mock.method(globalThis,'setTimeout');
 const text='a'.repeat(300)+'b'.repeat(300)+'c'.repeat(300);
 f.setScript(async function*(){
  yield {type:'delta',text:'a'.repeat(300)};first.resolve();await next.promise;
  yield {type:'delta',text:'b'.repeat(300)};second.resolve();await last.promise;
  yield {type:'delta',text:'c'.repeat(300)};third.resolve();await finish.promise;
  yield {type:'done',output:output('responses',text)};
 });
 const sent=await f.send();await first.promise;
 try{
  assert.equal(scheduled.mock.callCount(),1);t.mock.timers.tick(100);next.resolve();await second.promise;
  assert.equal(scheduled.mock.callCount(),1);t.mock.timers.tick(100);last.resolve();await third.promise;
  assert.equal(scheduled.mock.callCount(),1);t.mock.timers.tick(49);
  assert.equal(f.runtime.get(f.projectId,sent.run.id).steps[0]?.text,undefined);assert.deepEqual(f.textEvents(sent.run.id),[]);
  t.mock.timers.tick(1);
  const visible=f.runtime.get(f.projectId,sent.run.id);assert.equal(visible.run.status,'running');assert.equal(visible.steps[0]?.status,'dispatch_started');assert.equal(visible.steps[0]?.text,text);assert.deepEqual(f.textEvents(sent.run.id),[text]);
  t.mock.timers.tick(1000);assert.deepEqual(f.textEvents(sent.run.id),[text]);assert.equal(scheduled.mock.callCount(),1);
 }finally{next.resolve();last.resolve();finish.resolve();await f.runtime.drain();}
 const done=f.runtime.get(f.projectId,sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.steps[0]?.text,text);
});

test('streaming measures its tail deadline from the last flush and flushes immediately after an idle interval',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:beginning});
 const f=await fixture(t),entered=gate(),continued=gate(),next=gate(),finish=gate(),scheduled=t.mock.method(globalThis,'setTimeout');
 f.setScript(async function*(){
  t.mock.timers.tick(200);yield {type:'delta',text:'first'};entered.resolve();await next.promise;
  yield {type:'delta',text:'second'};continued.resolve();await finish.promise;
  yield {type:'done',output:output('responses','firstsecond')};
 });
 const sent=await f.send();await entered.promise;
 try{
  assert.equal(scheduled.mock.callCount(),1);t.mock.timers.tick(49);assert.deepEqual(f.textEvents(sent.run.id),[]);
  t.mock.timers.tick(1);assert.deepEqual(f.textEvents(sent.run.id),['first']);
  t.mock.timers.tick(1000);next.resolve();await continued.promise;
  assert.deepEqual(f.textEvents(sent.run.id),['first','second']);assert.equal(scheduled.mock.callCount(),1);
 }finally{next.resolve();finish.resolve();await f.runtime.drain();}
 assert.equal(f.runtime.get(f.projectId,sent.run.id).run.status,'completed');
});

test('streaming clears pending timers after its size flush and final remainder',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:beginning});
 const f=await fixture(t),scheduled=t.mock.method(globalThis,'setTimeout'),cleared=t.mock.method(globalThis,'clearTimeout'),prefix='x'.repeat(8192);
 f.setScript(async function*(){yield {type:'delta',text:prefix};yield {type:'delta',text:'é'};yield {type:'delta',text:'tail'};yield {type:'done',output:output('responses',prefix+'étail')};});
 const sent=await f.send();await f.runtime.drain();assert.equal(f.runtime.get(f.projectId,sent.run.id).run.status,'completed');
 assert.equal(scheduled.mock.callCount(),2);
 for(const call of scheduled.mock.calls)assert.ok(cleared.mock.calls.some(clear=>clear.arguments[0]===call.result),'Each unexpired timer is cancelled by the write');
 const before=f.runtime.journal.snapshot(sent.run.id),events=f.textEvents(sent.run.id);t.mock.timers.tick(1000);
 assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),before);assert.deepEqual(f.textEvents(sent.run.id),events);
});

for(const failure of ['AGENT_CHAT_TIMEOUT','AGENT_TASK_UNKNOWN_RESULT'] as const)test(`streaming preserves a small reply when ${failure} arrives before its timer`,async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:beginning});
 const f=await fixture(t),text='partial '.repeat(100),entered=gate(),release=gate();
 f.setScript(async function*(){yield {type:'delta',text};entered.resolve();await release.promise;throw Object.assign(Error('Synthetic stream failure'),{code:failure});});
 const sent=await f.send();await entered.promise;
 try{
  t.mock.timers.tick(100);assert.deepEqual(f.textEvents(sent.run.id),[]);assert.equal(f.runtime.get(f.projectId,sent.run.id).steps[0]?.text,undefined);
 }finally{release.resolve();await f.runtime.drain();}
 const done=f.runtime.get(f.projectId,sent.run.id),step=done.steps[0];assert.ok(step);assert.equal(step.text,text);assert.deepEqual(f.textEvents(sent.run.id),[text]);
 assert.equal(step.status,failure==='AGENT_CHAT_TIMEOUT'?'failed':'unknown');assert.equal(done.run.status,failure==='AGENT_CHAT_TIMEOUT'?'failed':'paused');
 const before=f.runtime.journal.snapshot(sent.run.id);t.mock.timers.tick(1000);assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),before);assert.deepEqual(f.textEvents(sent.run.id),[text]);
 if(failure==='AGENT_TASK_UNKNOWN_RESULT')await assert.rejects(f.action(done,'resume'),{code:'AGENT_TASK_UNKNOWN_RESULT'});
 const replay=await f.send(sent.run.text,sent.run.requestId);assert.equal(replay.run.id,sent.run.id);assert.equal(f.requests.length,1);
});

test('streaming retains a paused 900-byte reply before a later timeout without receiving another delta',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:beginning});
 const f=await fixture(t),text='x'.repeat(900),entered=gate(),release=gate();
 f.setScript(async function*(){yield {type:'delta',text};entered.resolve();await release.promise;throw Object.assign(Error('Synthetic timeout'),{code:'AGENT_CHAT_TIMEOUT'});});
 const sent=await f.send();await entered.promise;
 try{
  t.mock.timers.tick(249);assert.equal(f.runtime.get(f.projectId,sent.run.id).steps[0]?.text,undefined);
  t.mock.timers.tick(1);assert.equal(f.runtime.get(f.projectId,sent.run.id).steps[0]?.text,text);assert.deepEqual(f.textEvents(sent.run.id),[text]);
 }finally{release.resolve();await f.runtime.drain();}
 const failed=f.runtime.get(f.projectId,sent.run.id);assert.equal(failed.run.status,'failed');assert.equal(failed.steps[0]?.status,'failed');assert.equal(failed.steps[0]?.text,text);
 assert.equal(failed.steps[0]?.error?.code,'AGENT_CHAT_TIMEOUT');assert.deepEqual(f.textEvents(sent.run.id),[text]);
});

for(const end of ['close','stop'] as const)test(`streaming cancels its buffered write after ${end}`,async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:beginning});
 const f=await fixture(t),entered=gate(),release=gate(),text='Buffered before cancellation',scheduled=t.mock.method(globalThis,'setTimeout'),cleared=t.mock.method(globalThis,'clearTimeout');
 f.setScript(async function*(){yield {type:'delta',text};entered.resolve();await release.promise;yield {type:'done',output:output('responses',text)};});
 const sent=await f.send();await entered.promise;const original=f.runtime;
 try{
  assert.equal(scheduled.mock.callCount(),1);
  if(end==='close')original.close();else await f.action(f.runtime.get(f.projectId,sent.run.id),'stop');
  assert.ok(cleared.mock.calls.some(call=>call.arguments[0]===scheduled.mock.calls[0]?.result),'Cancellation clears the live timer immediately');
  const before=original.journal.snapshot(sent.run.id),events=original.journal.events(sent.run.id);
  t.mock.timers.tick(1000);assert.deepEqual(original.journal.snapshot(sent.run.id),before);assert.deepEqual(original.journal.events(sent.run.id),events);assert.equal(before.steps[0]?.text,undefined);
  release.resolve();await original.drain();assert.deepEqual(original.journal.snapshot(sent.run.id),before);assert.deepEqual(original.journal.events(sent.run.id),events);
 }finally{release.resolve();await original.drain();}
});

for(const end of ['close','stop'] as const)test(`streaming does not write after ${end} while the completed iterator is still ending`,async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:beginning});
 const f=await fixture(t),entered=gate(),release=gate(),text='x'.repeat(900);
 f.setScript(async function*(){
  yield {type:'delta',text};yield {type:'done',output:output('responses',text)};
  entered.resolve();await release.promise;
 });
 const sent=await f.send();await entered.promise;const original=f.runtime;
 try{
  t.mock.timers.tick(100);assert.equal(original.journal.snapshot(sent.run.id).steps[0]?.text,undefined);
  if(end==='close')original.close();else await f.action(f.runtime.get(f.projectId,sent.run.id),'stop');
  const before=original.journal.snapshot(sent.run.id),events=original.journal.events(sent.run.id);
  t.mock.timers.tick(1000);assert.deepEqual(original.journal.snapshot(sent.run.id),before);assert.deepEqual(original.journal.events(sent.run.id),events);
  release.resolve();await original.drain();
  assert.deepEqual(original.journal.snapshot(sent.run.id),before);assert.deepEqual(original.journal.events(sent.run.id),events);
 }finally{original.close();release.resolve();await original.drain();}
});

test('a storage failure in the streaming timer fences dispatch without escaping or retrying the write',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:beginning});
 const f=await fixture(t),entered=gate(),release=gate();let attempts=0;
 f.runtime.journal.appendText=()=>{attempts++;throw Object.assign(Error('Synthetic append failure'),{code:'SQLITE_IOERR'});};
 f.setScript(async function*(){yield {type:'delta',text:'Timed partial reply'};entered.resolve();await release.promise;yield {type:'done',output:output('responses','Timed partial reply')};});
 const sent=await f.send();await entered.promise;const request=f.runtime.journal.snapshot(sent.run.id).steps[0]?.request;
 try{
  assert.doesNotThrow(()=>t.mock.timers.tick(250));assert.equal(attempts,1);
  await assert.rejects(f.send('Must remain fenced'),{code:'AGENT_TASK_STORAGE_UNAVAILABLE'});
  t.mock.timers.tick(1000);assert.equal(attempts,1);
 }finally{release.resolve();await f.runtime.drain();}
 assert.equal(attempts,1);assert.equal(f.requests.length,1);assert.deepEqual(f.runtime.journal.snapshot(sent.run.id).steps[0]?.request,request);
});

for(const persisted of [false,true])test(`note capacity ${persisted?'counts written':'excludes buffered'} streaming text without changing the saved request`,async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:beginning});
 const f=await fixture(t),entered=gate(),release=gate(),reply='r'.repeat(persisted?8193:8192);
 f.setScript(async function*(){yield {type:'delta',text:reply};entered.resolve();await release.promise;yield {type:'done',output:output('responses',reply)};});
 const sent=await f.send('u'.repeat(32000));await entered.promise;
 try{
  let current=f.runtime.get(f.projectId,sent.run.id);const request=f.runtime.journal.snapshot(sent.run.id).steps[0]?.request;
  assert.equal(current.steps[0]?.text,persisted?reply:undefined);assert.deepEqual(f.textEvents(sent.run.id),persisted?[reply]:[]);
  for(let index=0;index<2;index++)current=await f.action(current,'note',{text:String(index).repeat(32768)});
  const third={requestId:randomUUID(),expectedRevision:current.run.revision,action:'note',text:'n'.repeat(32000)};
  if(persisted){
   const before=f.runtime.journal.snapshot(sent.run.id);
   await assert.rejects(f.runtime.action(f.projectId,sent.run.id,third),{code:'AGENT_TASK_NOTE_CAPACITY'});
   assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),before);assert.deepEqual(f.runtime.journal.lookupControl(third.requestId)?.result,{state:'rejected',code:'AGENT_TASK_NOTE_CAPACITY'});
  }else{
   current=await f.runtime.action(f.projectId,sent.run.id,third);assert.equal(current.run.notes?.length,3);
  }
  assert.deepEqual(f.runtime.journal.snapshot(sent.run.id).steps[0]?.request,request);
  await f.action(f.runtime.get(f.projectId,sent.run.id),'stop');
 }finally{release.resolve();await f.runtime.drain();}
 assert.equal(f.requests.length,1);assert.equal(f.runtime.get(f.projectId,sent.run.id).run.status,'stopped');
});

test('restart loses only unwritten streaming text and requires explicit unknown-result handling',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:beginning});
 const f=await fixture(t),entered=gate(),release=gate(),saved='SAVED_PREFIX_'+'s'.repeat(8193),buffered='UNWRITTEN_BUFFER';
 f.setScript(async function*(){yield {type:'delta',text:saved};yield {type:'delta',text:buffered};entered.resolve();await release.promise;yield {type:'done',output:output('responses',saved+buffered)};});
 const sent=await f.send();await entered.promise;
 const original=f.runtime;
 try{
  const before=f.runtime.journal.snapshot(sent.run.id),model=before.steps[0];assert.ok(model);assert.equal(model.status,'dispatch_started');assert.equal(model.text,saved);assert.deepEqual(f.textEvents(sent.run.id),[saved]);
  original.close();release.resolve();await original.drain();f.restart();
  const interrupted=f.runtime.get(f.projectId,sent.run.id);assert.equal(interrupted.run.status,'interrupted');assert.equal(interrupted.steps[0]?.status,'unknown');assert.equal(interrupted.steps[0]?.text,saved);
  assert.deepEqual(f.runtime.journal.step(model.id).request,model.request);assert.deepEqual(f.textEvents(sent.run.id),[saved]);
  assert.doesNotMatch(JSON.stringify(f.runtime.journal.snapshot(sent.run.id)),/UNWRITTEN_BUFFER/u);
  await assert.rejects(f.action(interrupted,'resume'),{code:'AGENT_TASK_UNKNOWN_RESULT'});
  const replay=await f.send(sent.run.text,sent.run.requestId);assert.equal(replay.run.id,sent.run.id);await f.runtime.drain();assert.equal(f.requests.length,1);
 }finally{original.close();release.resolve();await original.drain();}
});
