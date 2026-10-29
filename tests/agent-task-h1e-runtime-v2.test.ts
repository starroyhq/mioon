import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../packages/business/src/agent/task-runtime-v2.ts';
import {buildTaskModelRequest,taskResponseLanguageContext} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskGateway,TaskModelItem,TaskModelOutput} from '../packages/business/src/agent/task-gateway-v2.ts';
import {validateAgentTaskRowsV2} from '../packages/business/src/agent/task-schema-v2.ts';
import {createAgentTaskHttp} from '../apps/server/src/agent-task-http-v2.ts';
import type {AgentProtocol} from '../packages/contracts/src/agent-protocol.ts';
import type {AgentTaskJson,AgentTaskSnapshot,AgentTaskToolCall,AgentTaskControlAction} from '../packages/contracts/src/agent-tasks-v2.ts';
import {agentTaskSnapshotSchema} from '../packages/contracts/src/agent-tasks-v2.ts';
import {createTestAuthorizations,authorizeTestScope} from './helpers/agent-authorizations.ts';

const protocols=['chat_completions','responses','anthropic_messages'] as const;
function object(value:unknown):Record<string,unknown>{assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;}
function output(protocol:AgentProtocol,calls:AgentTaskToolCall[]=[],text='Offline completion'):TaskModelOutput {
  const providerOutput:AgentTaskJson=protocol==='responses'?[{type:'message',role:'assistant',content:[{type:'output_text',text,annotations:[]}]},...calls.map(call=>({type:'function_call',call_id:call.id,name:call.name,arguments:JSON.stringify(call.arguments),status:'completed'}))]:protocol==='anthropic_messages'?{role:'assistant',content:[{type:'text',text},...calls.map(call=>({type:'tool_use',id:call.id,name:call.name,input:call.arguments}))]}:{role:'assistant',content:text,...(calls.length?{tool_calls:calls.map(call=>({id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}))}:{})};
  return {text,toolCalls:calls,providerOutput};
}
type Script=(index:number)=>AsyncGenerator<TaskModelItem,void,undefined>;
const modelSteps=(snapshot:AgentTaskSnapshot)=>snapshot.steps.filter(step=>step.kind==='model');
function assertPublic(value:unknown):void {assert.doesNotMatch(JSON.stringify(value),/"(?:usage|inputTokens|outputTokens|cacheReadTokens|cacheWriteTokens|providerOutput|request)"\s*:/u);}

/** Only the model exchange is scripted. Grants, services, tool execution,
 * SQLite receipts, recovery and public projections are the real runtime. */
async function fixture(t:TestContext,protocol:AgentProtocol){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-h1e-runtime-')),store=openStore(root),services=createServices(store,new Map());
  const project=object(await services.call('project.create',{name:'Usage fixture'})),projectId=String(project.id);
  const settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}});
  await settings.put({expectedRevision:0,configuration:{presetId:'custom',platformId:'custom',protocol,model:'synthetic-usage-model',baseUrl:'https://harness.example.com'},secret:{action:'replace',storage:'session',value:randomUUID()}});
  const authorizations=createTestAuthorizations(()=>({...store}),settings);await authorizeTestScope(authorizations,'project_agent');
  const tools=createAgentTaskTools({store,services}),requests:string[]=[];let index=0,script:Script=async function*(){yield {type:'done',output:output(protocol)};};
  const gateway:TaskGateway=async function*(request){request.beforeSubmit?.();requests.push(request.body);yield*script(++index);};
  let runtime=createAgentTaskRuntime({store,agentSettings:settings,authorizations,tools,gateway,selfPort:()=>4318});
  t.after(async()=>{runtime.close();tools.dispose();await settings.close();store.close();rmSync(root,{recursive:true,force:true});});
  return {store,settings,projectId,requests,get runtime(){return runtime;},
    setScript(value:Script){script=value;index=0;},
    async send(){return runtime.send(projectId,{requestId:randomUUID(),text:'Offline usage request',expectedSettingsRevision:(await settings.get()).revision,locale:'en'});},
    async settle(runId:string){await runtime.drain();return runtime.journal.snapshot(runId);},
    action(snapshot:AgentTaskSnapshot,action:AgentTaskControlAction,extra:Record<string,unknown>={}){return runtime.action(projectId,snapshot.run.id,{requestId:randomUUID(),expectedRevision:snapshot.run.revision,action,...extra});},
    restart(readOnly=false){runtime.close();runtime=createAgentTaskRuntime({store,agentSettings:settings,authorizations,tools,gateway,selfPort:()=>4318,readOnly});},
  };
}

for(const protocol of protocols)test(`${protocol}: measured usage is private and never changes tool continuation or public receipts`,async t=>{
  const f=await fixture(t,protocol),call:AgentTaskToolCall={id:'usage_read',name:'mioon_project_inspect',arguments:{}},usage={inputTokens:120,outputTokens:9,cacheReadTokens:80,cacheWriteTokens:0};
  f.setScript(async function*(index){yield {type:'delta',text:'Offline completion'};yield {type:'done',output:{...output(protocol,index===1?[call]:[]),usage:Object.assign({...usage},{rawProviderMetadata:'PRIVATE_PASSIVE_USAGE'})}};});
  const sent=await f.send(),done=await f.settle(sent.run.id),models=modelSteps(done);
  assert.equal(done.run.status,'completed');assert.equal(models.length,2);assert.equal(done.steps.filter(step=>step.kind==='tool'&&step.status==='completed').length,1);
  for(const model of models){assert.deepEqual(object(model.result).usage,usage);assert.equal(Object.hasOwn(object(object(model.result).usage),'rawProviderMetadata'),false);}
  const completed=f.runtime.journal.events(sent.run.id).filter(event=>event.type==='step'&&object(event.data).kind==='model'&&object(event.data).status==='completed');
  assert.equal(completed.length,2);for(const event of completed)assert.deepEqual(object(object(event.data).result).usage,usage);
  const frozen=models.map(model=>structuredClone(model.request));
  for(const body of f.requests)assert.doesNotMatch(body,/inputTokens|cacheReadTokens|PRIVATE_PASSIVE_USAGE/u);
  const safe=f.runtime.get(f.projectId,sent.run.id);assertPublic(safe);assert.equal(safe.run.context,undefined);assert.ok(safe.steps.every(step=>step.request===undefined&&step.data===undefined));assertPublic(f.runtime.lookup(f.projectId,sent.run.requestId));
  const events=f.runtime.events(f.projectId,sent.run.id);assertPublic(events);assert.ok(events.sequence>0);
  const actionId=randomUUID(),action=await f.runtime.action(f.projectId,sent.run.id,{requestId:actionId,expectedRevision:done.run.revision,action:'stop'});
  assertPublic(action);assertPublic(f.runtime.lookupAction(f.projectId,sent.run.id,actionId));
  validateAgentTaskRowsV2(f.store.db,{allowConversations:true,allowInteractions:true,allowRequestReferences:true,allowAnswers:true});
  f.restart(true);const before=f.store.db.prepare('SELECT total_changes() n').get()!.n;
  assertPublic(f.runtime.get(f.projectId,sent.run.id));assert.deepEqual(modelSteps(f.runtime.journal.snapshot(sent.run.id)).map(model=>model.request),frozen);
  assert.deepEqual(modelSteps(f.runtime.journal.snapshot(sent.run.id)).map(model=>object(model.result).usage),[usage,usage]);
  assert.equal(f.store.db.prepare('SELECT total_changes() n').get()!.n,before,'A read-only restored view cannot normalize or rewrite private rows');
});

for(const protocol of protocols)test(`${protocol}: missing and malformed optional usage preserve normal completion and legacy replay`,async t=>{
  const f=await fixture(t,protocol),call:AgentTaskToolCall={id:'legacy_read',name:'mioon_project_inspect',arguments:{}};
  f.setScript(async function*(index){
    const reply=output(protocol,index===1?[call]:[]);
    if(index===2){const active=f.runtime.journal.list(f.projectId).find(run=>run.status==='running');assert.ok(active);await f.action(f.runtime.get(f.projectId,active.id),'pause');}
    yield {type:'done',output:index===1?reply:{...reply,usage:{inputTokens:-1,outputTokens:4,cacheReadTokens:NaN,cacheWriteTokens:Infinity}}};
  });
  const sent=await f.send(),done=await f.settle(sent.run.id),models=modelSteps(done);
  assert.equal(done.run.status,'paused');assert.equal(Object.hasOwn(object(models[0]!.result),'usage'),false);assert.deepEqual(object(models[1]!.result).usage,{outputTokens:4});
  // Generic persisted JSON extensions were historically accepted. Optional
  // malformed metadata must not tighten restore validation or continuation.
  const retained={...object(models[0]!.result),usage:{inputTokens:'old-provider-field',outputTokens:-1,extension:true}};
  f.runtime.journal.updateStep(sent.run.id,models[0]!.id,{result:JSON.parse(JSON.stringify(retained)) as AgentTaskJson});
  validateAgentTaskRowsV2(f.store.db,{allowConversations:true,allowInteractions:true,allowRequestReferences:true,allowAnswers:true});
  f.restart();const interrupted=f.runtime.get(f.projectId,sent.run.id);assertPublic(interrupted);assert.equal(interrupted.run.status,'interrupted');
  await f.action(interrupted,'resume');const replayed=await f.settle(sent.run.id);assert.equal(replayed.run.status,'completed');assert.equal(f.requests.length,2,'Completed tool/model receipts are replayed without another provider request');
  // A fresh run also exercises the same runtime after legacy continuation.
  f.setScript(async function*(){yield {type:'done',output:output(protocol)};});
  const next=await f.send(),finished=await f.settle(next.run.id);assert.equal(finished.run.status,'completed');assert.equal(Object.hasOwn(object(modelSteps(finished)[0]!.result),'usage'),false);
});

for(const protocol of protocols)test(`${protocol}: recovery sends the frozen original intent and stores only its observed completion usage`,async t=>{
  const f=await fixture(t,protocol),settings=await f.settings.get(),history=[{role:'user',content:'Frozen pre-H1e request'}],body=buildTaskModelRequest(settings.configuration,history,[],4318);
  const created=f.runtime.journal.create({projectId:f.projectId,requestId:randomUUID(),text:'Frozen pre-H1e request',configuration:{...settings.configuration},settingsRevision:settings.revision,context:[taskResponseLanguageContext('en')]});
  const model=f.runtime.journal.beginStep(created.run.id,{kind:'model',request:{body,history},data:{baseline:[]}}),frozen=structuredClone(model.request);
  f.setScript(async function*(){yield {type:'done',output:{...output(protocol),usage:{inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0}}};});
  f.restart();const interrupted=f.runtime.get(f.projectId,created.run.id);assert.equal(interrupted.run.status,'interrupted');
  await f.action(interrupted,'resume');const done=await f.settle(created.run.id);
  assert.equal(done.run.status,'completed');assert.deepEqual(f.requests,[body]);assert.deepEqual(f.runtime.journal.step(model.id).request,frozen);
  assert.deepEqual(object(f.runtime.journal.step(model.id).result).usage,{inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0});assertPublic(f.runtime.get(f.projectId,created.run.id));
});

for(const protocol of protocols)test(`${protocol}: an interrupted dispatched request still has unknown outcome and no invented usage`,async t=>{
  const f=await fixture(t,protocol),settings=await f.settings.get(),history=[{role:'user',content:'Unknown exchange'}],body=buildTaskModelRequest(settings.configuration,history,[],4318);
  const created=f.runtime.journal.create({projectId:f.projectId,requestId:randomUUID(),text:'Unknown exchange',configuration:{...settings.configuration},settingsRevision:settings.revision,context:[]});
  const model=f.runtime.journal.beginStep(created.run.id,{kind:'model',request:{body,history}});f.runtime.journal.markDispatch(created.run.id,model.id);
  f.restart();const interrupted=f.runtime.get(f.projectId,created.run.id);assert.equal(interrupted.steps[0]?.status,'unknown');
  await assert.rejects(f.action(interrupted,'resume'),{code:'AGENT_TASK_UNKNOWN_RESULT'});assert.equal(f.requests.length,0);assert.equal(f.runtime.journal.step(model.id).result,undefined);assertPublic(f.runtime.get(f.projectId,created.run.id));
});

for(const protocol of protocols)test(`${protocol}: real HTTP, SSE and CLI status expose no private usage`,async t=>{
  const f=await fixture(t,protocol);f.setScript(async function*(){yield {type:'done',output:{...output(protocol),usage:{inputTokens:87654,outputTokens:7,cacheReadTokens:86400,cacheWriteTokens:0}}};});
  const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(object(modelSteps(done)[0]!.result).usage!==undefined,true);
  const route=createAgentTaskHttp({runtime:f.runtime}),token=randomUUID(),server=createServer((req,res)=>{
    if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401);res.end();return;}
    void route.handle(req,res,new URL(req.url??'/','http://127.0.0.1')).then(handled=>{if(!handled){res.writeHead(404);res.end();}}).catch(()=>{res.destroy();});
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`,path=`/api/agent/tasks/v2/${f.projectId}/${sent.run.id}`;
  try{
    const status=await fetch(base+path,{headers:{Authorization:`Bearer ${token}`}}),value:unknown=await status.json();assert.equal(status.status,200);assertPublic(object(value).data);
    const controller=new AbortController(),stream=await fetch(base+path+'/events?after=0',{headers:{Authorization:`Bearer ${token}`},signal:controller.signal});assert.equal(stream.status,200);const reader=stream.body!.getReader();
    try{const frame=await reader.read();assert.equal(frame.done,false);const wire=new TextDecoder().decode(frame.value);assert.match(wire,/event: changed/u);assert.doesNotMatch(wire,/usage|inputTokens|outputTokens|cacheReadTokens|cacheWriteTokens/u);}
    finally{controller.abort();await reader.cancel().catch(()=>{});}
    const entry=fileURLToPath(new URL('../apps/cli/src/index.ts',import.meta.url)),child=spawn(process.execPath,[entry,'agent','task','status','--input',JSON.stringify({projectId:f.projectId,runId:sent.run.id})],{env:{...process.env,MIOON_BASE_URL:base,MIOON_TOKEN:token,MIOON_ENABLE_LIVE_PROVIDER:'0'},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.setEncoding('utf8').on('data',(part:string)=>{stdout+=part;});child.stderr.setEncoding('utf8').on('data',(part:string)=>{stderr+=part;});
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Offline usage CLI timed out'));},15000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);if(code===0)resolve();else reject(Error('Offline usage CLI failed'));});});
    assert.equal(stdout.includes(token),false);assert.equal(stderr.includes(token),false);assert.doesNotMatch(stdout+stderr,/inputTokens|cacheReadTokens|cacheWriteTokens/u);
    const envelope=object(JSON.parse(stdout));assert.equal(envelope.ok,true);assertPublic(envelope.data);agentTaskSnapshotSchema.parse(envelope.data);
  }finally{route.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
