import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import type {IncomingMessage} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {JobRecord} from '../packages/business/src/services.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import type {AgentSettingsService} from '../packages/business/src/agent/settings.ts';
import {createAgentSettingsBroker,createAgentSettingsClient} from '../apps/desktop/src/secret-broker.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import type {PreparedAgentTaskTool,AgentTaskToolContext} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../packages/business/src/agent/task-runtime-v2.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {withAgentTaskJobOrigin,setAgentTaskEffectGate,assertAgentTaskJobEffect,isAgentTaskEffectBlocked} from '../packages/business/src/agent/task-effects-v2.ts';
import type {Provider,ProviderContext} from '../packages/business/src/provider-registry.ts';
import type {TaskModelItem,TaskModelRequest,TaskModelOutput} from '../packages/business/src/agent/task-gateway-v2.ts';
import {createTaskGateway} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {AgentTransportDependencies} from '../packages/business/src/agent/network-policy.ts';
import type {AgentTaskToolCall,AgentTaskStatus,AgentTaskSnapshot,AgentTaskControlAction} from '../packages/contracts/src/agent-tasks-v2.ts';
import {createTestAuthorizations,authorizeTestScope} from './helpers/agent-authorizations.ts';
import {png} from './helpers/timeline-image-fixtures.ts';
import {createMockProvider} from '../packages/business/src/providers/mock.ts';
function object(value:unknown):Record<string,unknown>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;}
function textField(value:unknown,field:string):string{const result=object(value)[field];assert.ok(typeof result==='string'&&result.length>0,`Expected ${field} to be a nonempty string`);return result;}
function revisionField(value:unknown):number{const result=object(value).revision;assert.ok(typeof result==='number'&&Number.isSafeInteger(result)&&result>0,'Expected a positive revision');return result;}
function mockContext(context:ProviderContext){return {signal:context.signal??undefined,beforeSubmit:context.beforeSubmit,requestId:context.requestId,jobId:context.jobId,...(typeof context.providerRegion==='string'?{providerRegion:context.providerRegion}:{})};}
function mockProviderAdapter(mock:ReturnType<typeof createMockProvider>):Provider{return {...mock,
 submit:(snapshot,context)=>mock.submit(snapshot,mockContext(context)),reconcile:(id,context)=>mock.reconcile(id,mockContext(context)),poll:(id,context)=>mock.poll(id,mockContext(context)),
 download:(id,destination,context)=>mock.download(id,destination,mockContext(context)),cancel:(id,context)=>mock.cancel(id,mockContext(context)),
};}
function shot(value:unknown){const row=object(value);return {id:String(row.id),revision:Number(row.revision),prompt:String(row.prompt)};}
function gate(){let resolve=()=>{};const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
type Script=(index:number,request:TaskModelRequest)=>AsyncGenerator<TaskModelItem,void,undefined>;
function output(protocol:'chat_completions'|'responses',calls:AgentTaskToolCall[]=[],text='完成'):TaskModelOutput{return {text,toolCalls:calls,providerOutput:protocol==='responses'?calls.map(call=>({type:'function_call',call_id:call.id,name:call.name,arguments:JSON.stringify(call.arguments),status:'completed'})):{role:'assistant',content:text,tool_calls:calls.map(call=>({id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}))}};}
const call=(name:string,args:AgentTaskToolCall['arguments']={},id=randomUUID()):AgentTaskToolCall=>({id,name,arguments:args});
function desktopSettingsBridge(settings:AgentSettingsService,selfPort:number){
 const requests:Array<{operation:string;selfPort:unknown}>=[];
 const port=Object.assign(new EventEmitter(),{postMessage(message:unknown){const value=object(message);if(value.type==='agent-settings-request')requests.push({operation:String(value.operation),selfPort:value.selfPort});queueMicrotask(()=>broker.handle(message));}});
 const broker=createAgentSettingsBroker({agentSettings:settings,getSelfPort:()=>selfPort,send:data=>queueMicrotask(()=>port.emit('message',{data}))});
 const client=createAgentSettingsClient({port});
 // Production supplies this same validated transport at the settings boundary.
 return {settings:client as unknown as AgentSettingsService,requests,close(){client.close();broker.close();}};
}
function syntheticDeniedTransport(address:string,statusCode=401,errorBody=''){
 const counts={dns:0,requests:0,ends:0};
 const dependencies={lookup:async()=>{counts.dns++;return [{address,family:4}];},httpsRequest:(_options:unknown,respond:(response:IncomingMessage)=>void)=>{
  counts.requests++;const request=Object.assign(new EventEmitter(),{setTimeout(){},destroy(){},end(){counts.ends++;respond(Object.assign(Readable.from([Buffer.from(errorBody)]),{statusCode,headers:{'content-type':'text/event-stream'}}) as IncomingMessage);}});
  queueMicrotask(()=>{const socket=Object.assign(new EventEmitter(),{remoteAddress:address,remotePort:443,authorized:true,destroy(){}});request.emit('socket',socket);socket.emit('secureConnect');});return request;
 }} as unknown as AgentTransportDependencies;
 return {counts,gateway:createTaskGateway(dependencies)};
}
async function fixture(t:TestContext,protocol:'chat_completions'|'responses'='responses',providers:ReadonlyMap<string,Provider>=new Map(),{desktopBridge=false}:{desktopBridge?:boolean}={}){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-task-runtime-v2-')),store=openStore(root),services=createServices(store,providers);
 const project=object(await services.call('project.create',{name:'Runtime project'})),projectId=String(project.id);
 const first=shot(await services.call('shot.create',{projectId,title:'First',prompt:'saved first'})),other=shot(await services.call('shot.create',{projectId,title:'Other',prompt:'saved other'}));
 const settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}}),initial=await settings.get();await settings.put({expectedRevision:0,configuration:{...initial.configuration,protocol},secret:{action:'replace',storage:'session',value:'SYNTHETIC_LOCAL_TEST_ONLY'}});
 const bridge=desktopBridge?desktopSettingsBridge(settings,4318):null,runtimeSettings=bridge?.settings??settings;
 const authorizations=createTestAuthorizations(()=>({...store}),settings);await authorizeTestScope(authorizations,'project_agent');
 const requests:TaskModelRequest[]=[],effects=new Map<string,string>(),baseTools=createAgentTaskTools({store,services});let beforeTool:((prepared:PreparedAgentTaskTool)=>Promise<void>)|undefined,script:Script=async function*(){yield {type:'done',output:output(protocol)};};
 const tools={...baseTools,async execute(prepared:PreparedAgentTaskTool,context:AgentTaskToolContext){await beforeTool?.(prepared);return baseTools.execute(prepared,{...context,beforeEffect(){context.beforeEffect();effects.set(context.stepId,prepared.operation);}});}};
 const gateway=async function*(request:TaskModelRequest){requests.push(request);yield*script(requests.length,request);};
 let runtime=createAgentTaskRuntime({store,agentSettings:runtimeSettings,authorizations,tools,gateway,selfPort:()=>4318});
 t.after(async()=>{runtime.close();baseTools.dispose();bridge?.close();await settings.close();store.close();rmSync(root,{recursive:true,force:true});});
 return {root,store,services,settings,bridge,authorizations,projectId,first,other,requests,effects,tools,
  get runtime(){return runtime;},setScript(value:Script){script=value;},beforeTool(value:(prepared:PreparedAgentTaskTool)=>Promise<void>){beforeTool=value;},
  async revoke(){const current=await authorizations.list(),grant=current.authorizations.find(item=>item.scope==='project_agent');assert.ok(grant);await authorizations.revoke({requestId:randomUUID(),expectedRevision:current.revision,authorizationId:grant.id});},
  async send(text='执行测试',requestId:string=randomUUID()){return runtime.send(projectId,{requestId,text,expectedSettingsRevision:(await settings.get()).revision});},
  async settle(runId:string){await runtime.drain();return runtime.get(projectId,runId);},
  async wait(runId:string,statuses:AgentTaskStatus[]){const deadline=Date.now()+10000;for(;;){const snapshot=runtime.get(projectId,runId);if(statuses.includes(snapshot.run.status))return snapshot;if(Date.now()>deadline)throw Error(`Unexpected task state ${JSON.stringify(snapshot.run)}`);await delay(5);}},
  action(snapshot:AgentTaskSnapshot,action:AgentTaskControlAction,extra:Record<string,unknown>={}){return runtime.action(projectId,snapshot.run.id,{requestId:randomUUID(),expectedRevision:snapshot.run.revision,action,...extra});},
  restart(){runtime.close();runtime=createAgentTaskRuntime({store,agentSettings:runtimeSettings,authorizations,tools,gateway,selfPort:()=>4318});},
 };
}
for(const protocol of ['chat_completions','responses'] as const){
 test(`${protocol}: a trusted DNS denial records prevented dispatch and never becomes an unknown model result`,async t=>{
  const f=await fixture(t,protocol),transport=syntheticDeniedTransport('198.18.10.207');f.setScript(async function*(_index,request){yield*transport.gateway(request);});
  const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'failed');assert.equal(done.run.pauseReason,'AGENT_CHAT_NETWORK_DENIED');
  assert.equal(done.steps.length,1);const model=done.steps[0]!;assert.equal(model.kind,'model');assert.equal(model.status,'intent');assert.equal(done.steps.some(step=>step.status==='unknown'),false);
  assert.deepEqual(f.runtime.journal.events(sent.run.id).filter(event=>event.type==='dispatch_prevented').map(event=>event.data),[{stepId:model.id,next:'intent'}]);
  assert.deepEqual(transport.counts,{dns:1,requests:0,ends:0});assert.equal(f.requests.length,1);assert.equal(f.effects.size,0);assert.equal(done.changes.length,0);
  f.restart();assert.equal(f.runtime.lookup(f.projectId,sent.run.requestId).snapshot?.run.status,'failed');const replay=await f.send('执行测试',sent.run.requestId);assert.equal(replay.run.id,sent.run.id);assert.equal(replay.steps[0]?.status,'intent');
  await f.runtime.drain();assert.equal(f.requests.length,1);assert.deepEqual(transport.counts,{dns:1,requests:0,ends:0});assert.equal(f.effects.size,0);
 });
 test(`${protocol}: a provider HTTP error after request end retains an unknown result without automatic replay`,async t=>{
  const f=await fixture(t,protocol),transport=syntheticDeniedTransport('8.8.8.8');f.setScript(async function*(_index,request){yield*transport.gateway(request);});
  const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'failed');assert.equal(done.run.pauseReason,'AGENT_CHAT_HTTP_ERROR');assert.equal(done.steps.length,1);assert.equal(done.steps[0]?.status,'unknown');
  assert.match(done.steps[0]!.error!.message,/HTTP 401/u);assert.deepEqual(f.runtime.journal.events(sent.run.id).filter(event=>event.type==='error').map(event=>event.data),[{code:'AGENT_CHAT_HTTP_ERROR',message:done.steps[0]!.error!.message}]);
  assert.equal(f.runtime.journal.events(sent.run.id).filter(event=>event.type==='dispatch_prevented').length,0);assert.deepEqual(transport.counts,{dns:1,requests:1,ends:1});assert.equal(f.requests.length,1);assert.equal(f.effects.size,0);assert.equal(done.changes.length,0);
  f.restart();const found=f.runtime.lookup(f.projectId,sent.run.requestId);assert.equal(found.snapshot?.steps[0]?.status,'unknown');const replay=await f.send('执行测试',sent.run.requestId);assert.equal(replay.run.id,sent.run.id);assert.equal(replay.steps[0]?.status,'unknown');
  await f.runtime.drain();assert.equal(f.requests.length,1);assert.deepEqual(transport.counts,{dns:1,requests:1,ends:1});assert.equal(f.effects.size,0);
 });
 test(`${protocol}: arbitrary provider exception fields never become persisted HTTP diagnostics`,async t=>{
  const f=await fixture(t,protocol);f.setScript(async function*(){throw Object.assign(new Error('PRIVATE_PROVIDER_BODY'),{code:'AGENT_CHAT_HTTP_ERROR',httpStatus:401,statusCode:403,headers:{authorization:'PRIVATE_KEY'}});});
  const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.steps[0]?.status,'unknown');assert.equal(done.steps[0]?.error?.message,'任务未完成，请检查已保存记录。');
  const serialized=JSON.stringify({done,events:f.runtime.journal.events(sent.run.id)});assert.doesNotMatch(serialized,/PRIVATE_PROVIDER_BODY|PRIVATE_KEY|HTTP 401|HTTP 403/u);assert.equal(f.requests.length,1);
 });
 test(`${protocol}: HTTP 400 persists only fixed parameter hints and retains the original unknown request`,async t=>{
  const f=await fixture(t,protocol),transport=syntheticDeniedTransport('8.8.8.8',400,JSON.stringify({error:{message:'Invalid function schema for tools[0].function.parameters: PRIVATE_PROVIDER_BODY PRIVATE_KEY',param:'tools'}}));f.setScript(async function*(_index,request){yield*transport.gateway(request);});
  const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'failed');assert.equal(done.steps[0]?.status,'unknown');const message=done.steps[0]!.error!.message;assert.match(message,/HTTP 400/u);assert.match(message,/参数提示/u);assert.match(message,/tools/u);
  assert.doesNotMatch(JSON.stringify({done,events:f.runtime.journal.events(sent.run.id)}),/PRIVATE_PROVIDER_BODY|PRIVATE_KEY/u);assert.deepEqual(transport.counts,{dns:1,requests:1,ends:1});
  f.restart();const replay=await f.send('执行测试',sent.run.requestId);assert.equal(replay.run.id,sent.run.id);assert.equal(replay.steps[0]?.error?.message,message);await f.runtime.drain();assert.deepEqual(transport.counts,{dns:1,requests:1,ends:1});assert.equal(f.requests.length,1);assert.equal(f.effects.size,0);
 });
 test(`${protocol}: desktop broker pins snapshot, send and credential acquisition to the live backend port`,async t=>{
  const f=await fixture(t,protocol,new Map(),{desktopBridge:true});assert.ok(f.bridge);
  const project=await f.runtime.snapshot(f.projectId);assert.equal(project.projectId,f.projectId);assert.equal(project.settings.secret.configured,true);assert.deepEqual(project.runs,[]);
  assert.ok(!JSON.stringify(project).includes('SYNTHETIC_LOCAL_TEST_ONLY'));
  const sent=await f.send('仅回复连接正常'),done=await f.settle(sent.run.id);
  assert.equal(done.run.status,'completed');assert.equal(done.steps.length,1);assert.equal(done.steps[0]?.kind,'model');assert.equal(done.steps[0]?.status,'completed');assert.equal(done.changes.length,0);assert.equal(f.effects.size,0);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0]?.apiKey,'SYNTHETIC_LOCAL_TEST_ONLY');assert.equal(f.requests[0]?.selfPort,4318);
  assert.deepEqual(f.bridge.requests,[{operation:'get',selfPort:4318},{operation:'get',selfPort:4318},{operation:'acquire',selfPort:4318}]);
 });
 test(`${protocol}: multiple tools and model rounds execute sequentially and replay never repeats`,async t=>{const f=await fixture(t,protocol);f.setScript(async function*(index){yield {type:'done',output:output(protocol,index===1?[call('mioon_project_inspect'),call('mioon_shot_inspect',{limit:2})]:index===2?[call('mioon_timeline_inspect')]:[])};});const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.requests.length,3);assert.equal(f.effects.size,3);assert.equal(done.steps.length,6);const replay=await f.send('执行测试',sent.run.requestId);assert.equal(replay.run.id,sent.run.id);assert.equal(f.effects.size,3);assert.match(f.requests[1].body,protocol==='responses'?/function_call_output/:/tool_call_id/);f.restart();assert.equal(f.requests.length,3);assert.equal(f.effects.size,3);});
 test(`${protocol}: revocation after first done prevents every tool and continuation`,async t=>{const f=await fixture(t,protocol);f.setScript(async function*(){yield {type:'done',output:output(protocol,[call('mioon_project_inspect')])};await f.revoke();});const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'failed');assert.equal(done.run.pauseReason,'AGENT_TASK_CONSENT_REQUIRED');assert.equal(f.effects.size,0);assert.equal(f.requests.length,1);});
 test(`${protocol}: revocation after durable tool intent prevents actual read and continuation`,async t=>{const f=await fixture(t,protocol);f.setScript(async function*(){yield {type:'done',output:output(protocol,[call('mioon_project_inspect')])};});f.beforeTool(async()=>{const intent=f.store.db.prepare("SELECT status FROM agent_task_steps_v2 WHERE json_extract(data,'$.kind')='tool'").get();assert.equal(intent?.status,'dispatch_started');await f.revoke();});const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'failed');assert.equal(done.run.pauseReason,'AGENT_TASK_CONSENT_REQUIRED');assert.equal(f.effects.size,0);assert.equal(f.requests.length,1);assert.ok(done.steps.some(step=>step.kind==='tool'));});
}
test('small step budget pauses and resumes with a fresh round; completed tools stay completed',async t=>{const f=await fixture(t);f.runtime.journal.updatePolicy({...f.runtime.policy(),stepLimit:2});f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_project_inspect')]:[])};});const sent=await f.send(),paused=await f.settle(sent.run.id);assert.equal(paused.run.status,'paused');assert.equal(paused.run.pauseReason,'budget');assert.equal(paused.run.stepsUsed,2);assert.equal(f.effects.size,1);await f.action(paused,'resume');const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.run.budget,4);assert.equal(done.run.stepsUsed,3);assert.equal(f.effects.size,1);assert.equal(f.requests.length,2);});
for(const protocol of ['chat_completions','responses'] as const)for(const action of ['approve','deny'] as const)test(`${protocol}: ${action} at the budget boundary cannot grant another round`,async t=>{
 const f=await fixture(t,protocol);f.runtime.journal.updatePolicy({...f.runtime.policy(),stepLimit:2,modes:{...f.runtime.policy().modes,read_only:'confirm'}});
 let toolExecutions=0;f.beforeTool(async()=>{toolExecutions++;});
 f.setScript(async function*(index){yield {type:'done',output:output(protocol,index===1?[call('mioon_project_inspect')]:[])};});
 const sent=await f.send(),waiting=await f.wait(sent.run.id,['awaiting_approval']);await f.runtime.drain();const step=waiting.steps.find(item=>item.status==='awaiting_approval');assert.ok(step);
 assert.equal(waiting.run.stepsUsed,2);assert.equal(waiting.run.budget,2);assert.equal(f.effects.size,0);assert.equal(toolExecutions,0);assert.equal(f.requests.length,1);
 const approval={requestId:randomUUID(),expectedRevision:waiting.run.revision,action,stepId:step.id};
 await f.runtime.action(f.projectId,sent.run.id,approval);const paused=await f.settle(sent.run.id);
 assert.equal(paused.run.status,'paused');assert.equal(paused.run.pauseReason,'budget');assert.equal(paused.run.budget,2);assert.equal(paused.run.stepsUsed,2);
 assert.equal(f.effects.size,action==='approve'?1:0);assert.equal(toolExecutions,action==='approve'?1:0);assert.equal(f.requests.length,1);assert.equal(paused.steps.find(item=>item.id===step.id)?.status,action==='approve'?'completed':'rejected');
 const beforeReplay=f.runtime.journal.snapshot(sent.run.id);await f.runtime.action(f.projectId,sent.run.id,approval);await f.runtime.drain();assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),beforeReplay);
 await assert.rejects(f.runtime.action(f.projectId,sent.run.id,{...approval,requestId:randomUUID()}),{code:'AGENT_TASK_REVISION_CONFLICT'});assert.equal(f.runtime.journal.run(sent.run.id).budget,2);
 const continuation={requestId:randomUUID(),expectedRevision:paused.run.revision,action:'resume'};
 await f.runtime.action(f.projectId,sent.run.id,continuation);await f.runtime.action(f.projectId,sent.run.id,continuation);const done=await f.settle(sent.run.id);
 assert.equal(done.run.id,sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.run.budget,4);assert.equal(done.run.stepsUsed,3);assert.equal(f.effects.size,action==='approve'?1:0);assert.equal(toolExecutions,action==='approve'?1:0);assert.equal(f.requests.length,2);
 await f.runtime.action(f.projectId,sent.run.id,continuation);await f.runtime.action(f.projectId,sent.run.id,approval);await f.runtime.drain();assert.equal(f.runtime.journal.run(sent.run.id).budget,4);assert.equal(f.requests.length,2);assert.equal(f.effects.size,action==='approve'?1:0);assert.equal(toolExecutions,action==='approve'?1:0);
});
for(const action of ['approve','deny'] as const)test(`${action} receipt failure rolls back exhausted approval and state together`,async t=>{
 const f=await fixture(t);f.runtime.journal.updatePolicy({...f.runtime.policy(),stepLimit:2,modes:{...f.runtime.policy().modes,read_only:'confirm'}});
 f.setScript(async function*(){yield {type:'done',output:output('responses',[call('mioon_project_inspect')])};});
 const sent=await f.send(),waiting=await f.wait(sent.run.id,['awaiting_approval']);await f.runtime.drain();const step=waiting.steps.find(item=>item.status==='awaiting_approval');assert.ok(step);
 const request={requestId:randomUUID(),expectedRevision:waiting.run.revision,action,stepId:step.id},before=f.runtime.journal.snapshot(sent.run.id),events=f.runtime.journal.events(sent.run.id);
 f.store.db.exec(`CREATE TRIGGER fail_approval_receipt BEFORE INSERT ON agent_task_controls_v2 WHEN NEW.requestId='${request.requestId}' BEGIN SELECT RAISE(ABORT,'synthetic approval receipt failure');END;`);
 await assert.rejects(f.runtime.action(f.projectId,sent.run.id,request),{code:'AGENT_TASK_STORAGE_UNAVAILABLE'});await f.runtime.drain();
 assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),before);assert.deepEqual(f.runtime.journal.events(sent.run.id),events);assert.equal(f.runtime.journal.lookupControl(request.requestId),null);assert.equal(f.effects.size,0);assert.equal(f.requests.length,1);
});
test('read and reversible tiers independently require approval and exact duplicate controls do not repeat',async t=>{const f=await fixture(t);f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,read_only:'confirm',local_reversible:'confirm'}});f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_project_inspect'),call('mioon_shot_update',{shotId:f.first.id,expectedRevision:f.first.revision,patch:{prompt:'AI edit'}})]:[])};});const sent=await f.send();let waiting=await f.wait(sent.run.id,['awaiting_approval']);await f.runtime.drain();assert.equal(f.effects.size,0);const first=waiting.steps.find(step=>step.status==='awaiting_approval');assert.ok(first);const control={requestId:randomUUID(),action:'approve',expectedRevision:waiting.run.revision,stepId:first.id};await f.runtime.action(f.projectId,sent.run.id,control);await f.runtime.action(f.projectId,sent.run.id,control);waiting=await f.wait(sent.run.id,['awaiting_approval']);await f.runtime.drain();const second=waiting.steps.find(step=>step.status==='awaiting_approval');assert.ok(second);assert.equal(second.tier,'local_reversible');assert.equal(f.effects.size,1);await f.action(waiting,'deny',{stepId:second.id});const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.effects.size,1);assert.equal(object(f.store.get('shots',String(f.first.id))).prompt,'saved first');});
test('same target ABA during model wait pauses while another shot edit does not',async t=>{for(const same of [true,false]){const f=await fixture(t),entered=gate(),release=gate();f.setScript(async function*(index){if(index===1){entered.resolve();await release.promise;}yield {type:'done',output:output('responses',index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:f.first.revision,patch:{prompt:'AI edit'}})]:[])};});const sent=await f.send();await entered.promise;const target=same?f.first:f.other;let saved=object(await f.services.call('shot.update',{shotId:target.id,expectedRevision:target.revision,patch:{prompt:'manual edit'}}));if(same)saved=object(await f.services.call('shot.update',{shotId:target.id,expectedRevision:saved.revision,patch:{prompt:target.prompt}}));release.resolve();const end=await f.settle(sent.run.id);assert.equal(end.run.status,same?'paused':'completed');assert.equal(f.effects.size,same?0:1);if(same){assert.equal(end.run.pauseReason,'conflict');assert.equal(f.requests.length,1);}else assert.equal(object(f.store.get('shots',String(f.other.id))).prompt,'manual edit');}});
test('unsaved editing claim blocks only its target and resume re-plans after explicit release',async t=>{const f=await fixture(t);const target={kind:'shot',id:String(f.first.id),revision:f.runtime.journal.targetRevision(f.projectId,'shot',String(f.first.id))};f.runtime.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId:'runtime-edit-owner',generation:1,sequence:1,action:'claim',targets:[target]});f.setScript(async function*(){yield {type:'done',output:output('responses',[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:f.first.revision,patch:{prompt:'AI edit'}})])};});const sent=await f.send(),paused=await f.settle(sent.run.id);assert.equal(paused.run.status,'paused');assert.equal(paused.run.pauseReason,'editing');assert.equal(f.effects.size,0);assert.equal(f.requests.length,1);f.runtime.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId:'runtime-edit-owner',generation:1,sequence:2,action:'release',targets:[target]});f.setScript(async function*(){yield {type:'done',output:output('responses')};});await f.action(paused,'resume');const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.effects.size,0);assert.equal(f.requests.length,2);assert.match(f.requests[1].body,/TARGET_CHANGED/);});
test('conflict invalidates the whole old tool batch including a not yet created third call',async t=>{
 const f=await fixture(t),target={kind:'shot',id:f.first.id,revision:f.runtime.journal.targetRevision(f.projectId,'shot',f.first.id)},ownerId=randomUUID();
 f.runtime.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId,generation:1,sequence:1,action:'claim',targets:[target]});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_project_inspect'),call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'stale call two'}}),call('mioon_shot_update',{shotId:f.other.id,expectedRevision:1,patch:{prompt:'stale call three'}})]:[])};});
 const sent=await f.send(),paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,'editing');assert.equal(f.effects.size,1);assert.equal(paused.steps.filter(step=>step.kind==='tool').length,2);
 f.runtime.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId,generation:1,sequence:2,action:'release',targets:[target]});await f.action(paused,'resume');const done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(f.effects.size,1);assert.equal(f.requests.length,2);assert.equal(object(f.store.get('shots',f.other.id)).prompt,'saved other');assert.match(f.requests[1]!.body,/TARGET_CHANGED/);
});
test('budget pauses retain pending tool calls without invalidating or repeating the batch',async t=>{
 const f=await fixture(t);f.runtime.journal.updatePolicy({...f.runtime.policy(),stepLimit:2});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?Array.from({length:3},()=>call('mioon_project_inspect')):[])};});
 const sent=await f.send();let paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,'budget');assert.equal(f.effects.size,1);await f.action(paused,'resume');paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,'budget');assert.equal(f.effects.size,3);assert.equal(f.requests.length,1);
 await f.action(paused,'resume');const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.run.stepsUsed,5);assert.equal(done.run.budget,6);assert.equal(f.effects.size,3);assert.equal(f.requests.length,2);
});
test('pause and stop during model wait block subsequent tools and requests',async t=>{for(const action of ['pause','stop'] as const){const f=await fixture(t),entered=gate(),release=gate();f.setScript(async function*(){entered.resolve();await release.promise;yield {type:'done',output:output('responses',[call('mioon_project_inspect')])};});const sent=await f.send();await entered.promise;await f.action(f.runtime.get(f.projectId,sent.run.id),action);release.resolve();const done=await f.settle(sent.run.id);assert.equal(done.run.status,action==='pause'?'paused':'stopped');assert.equal(f.effects.size,0);assert.equal(f.requests.length,1);}});
test('restart retains a model unknown result without dispatching until explicit disposition',async t=>{const f=await fixture(t),entered=gate(),release=gate();f.setScript(async function*(){entered.resolve();await release.promise;yield {type:'done',output:output('responses')};});const sent=await f.send();await entered.promise;f.restart();const restored=f.runtime.get(f.projectId,sent.run.id);assert.equal(restored.run.status,'interrupted');assert.equal(restored.steps[0]?.status,'unknown');assert.equal(f.requests.length,1);await assert.rejects(f.action(restored,'resume'),{code:'AGENT_TASK_UNKNOWN_RESULT'});release.resolve();const disposed=await f.action(restored,'resolve_unknown',{stepId:restored.steps[0]?.id,resolution:'discard'});await f.action(disposed,'resume');const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.requests.length,2);assert.equal(done.steps[0]?.status,'failed');});
test('whole task undo changes only AI targets and preserves manual edits elsewhere',async t=>{const f=await fixture(t);f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:f.first.revision,patch:{prompt:'AI edit'}})]:[])};});const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.changes.length,1);await f.services.call('shot.update',{shotId:f.other.id,expectedRevision:f.other.revision,patch:{prompt:'manual stays'}});const undone=await f.action(done,'undo_all');assert.equal(undone.run.status,'reverted');assert.equal(object(f.store.get('shots',String(f.first.id))).prompt,'saved first');assert.equal(object(f.store.get('shots',String(f.other.id))).prompt,'manual stays');assert.equal(f.requests.length,2);});
test('whole undo retains the generated shot owner while reverting earlier edits and preserving products across restart and replay',async t=>{
 const providers=new Map<string,Provider>(),f=await fixture(t,'responses',providers);providers.set('mock',mockProviderAdapter(createMockProvider({db:f.store.db,root:f.root})));
 const timeline=object(await f.services.call('timeline.get',{projectId:f.projectId}));assert.ok(Array.isArray(timeline.tracks));const trackId=textField(timeline.tracks[0],'id');
 f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'direct'},acknowledgePaid:true});
 const created=()=>object(f.store.list('shots',f.projectId).find(value=>object(value).title==='Created generated owner'));
 f.setScript(async function*(index){
  let next:AgentTaskToolCall[]=[];
  if(index===1)next=[call('mioon_project_rename',{expectedRevision:1,name:'AI project rename'})];
  if(index===2)next=[call('mioon_shot_create',{title:'Created generated owner',prompt:'Synthetic local motion',duration:2})];
  if(index===3){const shot=created();next=[call('mioon_generation_submit',{shotId:textField(shot,'id'),expectedRevision:revisionField(shot),providerId:'mock',model:'mock-motion-v1',parameters:{delayMs:0}})];}
  if(index===4)next=[call('mioon_task_wait',{kind:'job',id:textField(f.store.list('jobs',f.projectId)[0],'id')})];
  if(index===5)next=[call('mioon_timeline_clip_add',{expectedRevision:1,assetId:textField(f.store.list('versions',f.projectId)[0],'assetId'),trackId,startFrame:0,durationFrames:6})];
  if(index===6)next=[call('mioon_timeline_render',{expectedRevision:2,purpose:'export',exportSettings:{profileId:'mp4_h264_v1',resolution:'short_360',rateControl:{mode:'crf',quality:'standard'}}})];
  if(index===7)next=[call('mioon_task_wait',{kind:'export',id:textField(f.store.list('exports',f.projectId)[0],'id')})];
  yield {type:'done',output:output('responses',next)};
 });
 const sent=await f.send(),worker=startWorker(f.store,f.services,providers);let done:AgentTaskSnapshot;
 try{done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.backgroundPending,false);}finally{await worker.stop();}
 const before=f.runtime.journal.snapshot(sent.run.id),creation=before.changes.find(change=>change.operation==='shot.create')!;assert.ok(creation);const shotId=String(created().id);
 const products=Object.fromEntries(['jobs','versions','assets','exports'].map(table=>[table,structuredClone(f.store.list(table,f.projectId))]));
 const hashes=()=>f.store.list('assets',f.projectId).map(value=>{const asset=object(value);return createHash('sha256').update(readFileSync(join(f.root,String(asset.relativePath)))).digest('hex');}),beforeHashes=hashes();
 const control={requestId:randomUUID(),expectedRevision:done.run.revision,action:'undo_all'},undone=await f.runtime.action(f.projectId,sent.run.id,control),retained=f.runtime.journal.snapshot(sent.run.id).changes.find(change=>change.id===creation.id)!;
 assert.equal(undone.run.status,'reverted');assert.equal(object(f.store.get('projects',f.projectId)).name,'Runtime project');assert.equal(object(f.store.get('shots',shotId)).selectedVersionId,null);
 const savedTimeline=object(await f.services.call('timeline.inspect',{projectId:f.projectId}));assert.deepEqual(savedTimeline.clips,[]);
 assert.equal(retained.reversible,false);assert.equal(retained.status,'applied');assert.match(retained.summary??'',/保留生成记录及产物所需镜头/);assert.equal(retained.revertedAt,undefined);assert.equal(retained.revertedTargets,undefined);
 assert.deepEqual(retained.before,creation.before);assert.deepEqual(retained.after,creation.after);assert.deepEqual(retained.undo,creation.undo);
 for(const [table,records] of Object.entries(products))assert.deepEqual(f.store.list(table,f.projectId),records);assert.deepEqual(hashes(),beforeHashes);
 assert.deepEqual(undone.steps.map(step=>[step.id,step.cost]),done.steps.map(step=>[step.id,step.cost]));assert.deepEqual(f.runtime.journal.lookupControl(control.requestId)?.result,{state:'completed',retainedChangeIds:[creation.id]});
 const stable=f.runtime.journal.snapshot(sent.run.id),events=f.runtime.journal.events(sent.run.id);await f.runtime.action(f.projectId,sent.run.id,control);f.restart();await f.runtime.action(f.projectId,sent.run.id,control);
 assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),stable);assert.deepEqual(f.runtime.journal.events(sent.run.id),events);assert.equal(f.requests.length,8);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM mock_provider_submissions').get()?.n,1);
});
for(const started of [false,true])test(`retained shot ${started?'keeps a late product without selecting it':'cancels its queued work on whole undo'} and never dispatches after reversion`,async t=>{
 const providers=new Map<string,Provider>(),f=await fixture(t,'responses',providers),entered=gate(),release=gate();let posts=0,downloads=0;
 const mock=mockProviderAdapter(createMockProvider({db:f.store.db,root:f.root}));providers.set('mock',{...mock,async submit(snapshot,context){posts++;return mock.submit(snapshot,context);},async download(id,destination,context){downloads++;entered.resolve();await release.promise;return mock.download(id,destination,context);}});
 f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'direct'},acknowledgePaid:true});
 f.setScript(async function*(index){let next:AgentTaskToolCall[]=[];if(index===1)next=[call('mioon_shot_create',{title:'Pending generated owner',duration:2})];if(index===2){const shot=object(f.store.list('shots',f.projectId).find(value=>object(value).title==='Pending generated owner'));next=[call('mioon_generation_submit',{shotId:textField(shot,'id'),expectedRevision:revisionField(shot),providerId:'mock',model:'mock-motion-v1',parameters:{delayMs:0}})];}yield {type:'done',output:output('responses',next)};});
 const sent=await f.send(),completed=await f.settle(sent.run.id);assert.equal(completed.run.status,'completed');assert.equal(completed.backgroundPending,true);
 let worker:ReturnType<typeof startWorker>|undefined;
 try{
  if(started){worker=startWorker(f.store,f.services,providers);await Promise.race([entered.promise,delay(10000,undefined,{ref:false}).then(()=>{throw Error('Synthetic download barrier not reached');})]);}
  const current=f.runtime.get(f.projectId,sent.run.id),creation=current.changes.find(change=>change.operation==='shot.create')!;
  const single={requestId:randomUUID(),expectedRevision:current.run.revision,action:'undo_change',changeId:creation.id};await f.runtime.action(f.projectId,sent.run.id,single);
  const retained=f.runtime.get(f.projectId,sent.run.id);assert.equal(retained.run.status,'completed');assert.equal(retained.changes.find(change=>change.id===creation.id)?.reversible,false);assert.deepEqual(f.runtime.journal.lookupControl(single.requestId)?.result,{state:'completed',retainedChangeIds:[creation.id]});
  const undone=await f.action(retained,'undo_all');assert.equal(undone.run.status,'reverted');release.resolve();worker??=startWorker(f.store,f.services,providers);await worker.tick();await worker.tick();
  assert.equal(posts,started?1:0);assert.equal(downloads,started?1:0);assert.equal(f.requests.length,3);assert.equal(f.runtime.get(f.projectId,sent.run.id).run.status,'reverted');
  const shot=object(f.store.list('shots',f.projectId).find(value=>object(value).title==='Pending generated owner'));assert.equal(shot.selectedVersionId,null);
  const job=object(f.store.list('jobs',f.projectId)[0]);assert.equal(job.status,started?'succeeded':'cancelled');assert.equal(f.store.list('jobs',f.projectId).length,1);assert.equal(f.store.list('versions',f.projectId).length,started?1:0);assert.equal(f.store.list('assets',f.projectId).length,started?1:0);
  const timeline=await f.services.call('timeline.inspect',{projectId:f.projectId}),saved=timeline===null?null:object(timeline);assert.ok(saved===null||saved.clips===undefined||Array.isArray(saved.clips)&&saved.clips.length===0);
 }finally{release.resolve();await worker?.stop();}
});
test('retention survives an unknown control finish without repeating metadata or dispatch after restart',async t=>{
 let posts=0;const provider:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},async submit(){posts++;throw Error('No new dispatch is permitted');},async reconcile(){return null;},async poll(){return {status:'running'};},async download(){throw Error('No output requested');}};
 const providers=new Map([['mock',provider]]),f=await fixture(t,'responses',providers);f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'direct'},acknowledgePaid:true});
 f.setScript(async function*(index){let next:AgentTaskToolCall[]=[];if(index===1)next=[call('mioon_project_rename',{expectedRevision:1,name:'Reversible earlier rename'})];if(index===2)next=[call('mioon_shot_create',{title:'Owner retained across interruption',duration:2})];if(index===3){const shot=object(f.store.list('shots',f.projectId).find(value=>object(value).title==='Owner retained across interruption'));next=[call('mioon_generation_submit',{shotId:textField(shot,'id'),expectedRevision:revisionField(shot),providerId:'mock',model:'mock-motion-v1'})];}yield {type:'done',output:output('responses',next)};});
 const sent=await f.send(),done=await f.settle(sent.run.id),creation=done.changes.find(change=>change.operation==='shot.create')!,control={requestId:randomUUID(),expectedRevision:done.run.revision,action:'undo_all'};
 f.store.db.exec(`CREATE TRIGGER test_retention_control_finish BEFORE INSERT ON agent_task_control_states_v2 WHEN NEW.requestId='${control.requestId}' AND json_extract(NEW.data,'$.result.state')='completed' BEGIN SELECT RAISE(ABORT,'synthetic lost control finish');END;`);
 await assert.rejects(f.runtime.action(f.projectId,sent.run.id,control),{code:'AGENT_TASK_STORAGE_UNAVAILABLE'});
 const interrupted=f.runtime.journal.snapshot(sent.run.id);assert.equal(interrupted.run.status,'reverted');assert.equal(interrupted.changes.find(change=>change.id===creation.id)?.reversible,false);assert.equal(object(f.runtime.journal.lookupControl(control.requestId)?.result).state,'pending');
 f.restart();const recovered=f.runtime.journal.snapshot(sent.run.id),events=f.runtime.journal.events(sent.run.id);assert.deepEqual(recovered,interrupted);assert.equal(object(f.runtime.journal.lookupControl(control.requestId)?.result).state,'blocked');
 await f.runtime.action(f.projectId,sent.run.id,control);assert.deepEqual(f.runtime.journal.events(sent.run.id),events);assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),recovered);
 const worker=startWorker(f.store,f.services,providers);try{await worker.tick();await worker.tick();assert.equal(posts,0);assert.equal(f.requests.length,4);assert.equal(f.runtime.get(f.projectId,sent.run.id).run.status,'reverted');assert.equal(f.store.list('versions',f.projectId).length,0);assert.equal(f.store.list('assets',f.projectId).length,0);}finally{await worker.stop();}
});

test('default budget is thirty steps and continuation adds exactly another thirty',async t=>{const f=await fixture(t);f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?Array.from({length:29},()=>call('mioon_project_inspect')):[])};});const sent=await f.send(),paused=await f.settle(sent.run.id);assert.equal(paused.run.status,'paused');assert.equal(paused.run.stepLimit,30);assert.equal(paused.run.stepsUsed,30);assert.equal(f.effects.size,29);await f.action(paused,'resume');const done=await f.settle(sent.run.id);assert.equal(done.run.budget,60);assert.equal(done.run.stepsUsed,31);assert.equal(f.effects.size,29);assert.equal(f.requests.length,2);});
for(const reason of ['budget','revocation','audit_failure'] as const)test(reason==='audit_failure'?'an agent audit write failure still stops the worker before unrelated exports':`a queued agent export blocked by ${reason} cannot starve a manual export in another project`,async t=>{
 const f=await fixture(t),source=png({width:16,height:16,rgba:false,pixel:()=>[255,0,0]});
 async function prepareTimeline(projectId:string){
  const asset=object(await f.services.call('asset.import',{projectId,name:'Synthetic source.png',mimeType:'image/png',dataBase64:source.toString('base64')}));
  const timeline=object(await f.services.call('timeline.get',{projectId}));assert.ok(Array.isArray(timeline.tracks));
  await f.services.call('timeline.clip.add',{projectId,requestId:randomUUID(),expectedRevision:timeline.revision,assetId:asset.id,trackId:object(timeline.tracks[0]).id,startFrame:0,durationFrames:6});
 }
 await prepareTimeline(f.projectId);
 f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:2,modes:f.runtime.policy().modes});
 f.setScript(async function*(){yield {type:'done',output:output('responses',[call('mioon_timeline_render',{expectedRevision:2,purpose:'export'})])};});
 const sent=await f.send(),paused=await f.settle(sent.run.id);assert.equal(paused.run.status,'paused');assert.equal(paused.run.pauseReason,'budget');assert.equal(paused.backgroundPending,true);
 const blocked=object(f.store.list('exports',f.projectId)[0]);assert.equal(blocked.status,'queued');
 const other=object(await f.services.call('project.create',{name:'Independent manual export',timelinePresetId:'landscape_1080'})),otherId=String(other.id);await prepareTimeline(otherId);
 const accepted=object(await f.services.call('timeline.render',{projectId:otherId,expectedRevision:2,requestId:randomUUID(),purpose:'export'}));
 assert.equal(f.store.db.prepare('SELECT id FROM exports ORDER BY rowid LIMIT 1').get()?.id,blocked.id,'the paused export is the first worker candidate');
 if(reason==='revocation')await f.revoke();
 if(reason==='audit_failure'){
  f.store.db.exec("CREATE TRIGGER test_block_worker_audit BEFORE INSERT ON agent_task_events_v2 BEGIN SELECT RAISE(ABORT,'synthetic agent audit failure');END;");
  const remove=setAgentTaskEffectGate(f.store.db,()=>{f.store.db.prepare('INSERT INTO agent_task_events_v2(runId,projectId,sequence,type,data) VALUES(?,?,?,?,?)').run(sent.run.id,f.projectId,1000000,'synthetic','{}');});t.after(remove);
  assert.throws(()=>assertAgentTaskJobEffect(f.store.db,'export',String(blocked.id)),error=>isAgentTaskEffectBlocked(error)&&/synthetic agent audit failure/.test(String(error)));
 }
 const worker=startWorker(f.store,f.services,new Map());
 try{
  await worker.tick();assert.equal(object(f.store.get('exports',String(accepted.id))).status,reason==='audit_failure'?'queued':'succeeded');
  await worker.tick();assert.deepEqual(f.store.get('exports',String(blocked.id)),blocked,'the paused export was never claimed or started');
  assert.deepEqual(f.runtime.get(f.projectId,sent.run.id),paused);assert.equal(f.requests.length,1);assert.equal(f.effects.size,1);
  assert.equal(f.store.list('assets',f.projectId).length,1);assert.equal(f.store.list('assets',otherId).length,reason==='audit_failure'?1:2);
  assert.equal(f.store.list('exports',f.projectId).length,1);assert.equal(f.store.list('exports',otherId).length,1);
  const replay=await f.send('执行测试',sent.run.requestId);assert.equal(replay.run.id,sent.run.id);await worker.tick();assert.equal(f.requests.length,1);
  assert.equal(f.store.list('exports',f.projectId).length,1);assert.equal(f.store.list('exports',otherId).length,1);
 }finally{await worker.stop();}
});
test('read rejection and local approval each respect their independent configured tier',async t=>{for(const tier of ['read_only','local_reversible'] as const){const f=await fixture(t);f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,[tier]:'confirm'}});f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[tier==='read_only'?call('mioon_project_inspect'):call('mioon_shot_update',{shotId:f.first.id,expectedRevision:f.first.revision,patch:{prompt:'approved local'}})]:[])};});const sent=await f.send(),waiting=await f.wait(sent.run.id,['awaiting_approval']);await f.runtime.drain();const step=waiting.steps.find(item=>item.status==='awaiting_approval');assert.ok(step);await f.action(waiting,tier==='read_only'?'deny':'approve',{stepId:step.id});const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.effects.size,tier==='read_only'?0:1);assert.equal(object(f.store.get('shots',f.first.id)).prompt,tier==='read_only'?'saved first':'approved local');}});
test('all legacy grants remain insufficient for project_agent before any model request',async t=>{const f=await fixture(t);await f.revoke();for(const scope of ['typed_chat_only','project_inspection','selected_shot_edit','selected_timeline_clip_move','selected_timeline_clip_gain'])await authorizeTestScope(f.authorizations,scope);await assert.rejects(f.send(),{code:'AGENT_TASK_CONSENT_REQUIRED'});assert.equal(f.requests.length,0);assert.equal(f.effects.size,0);});
test('restart interrupts a completed model run with a queued bound job before the worker can submit',async t=>{
 let posts=0;
 const provider:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},
  async submit(_snapshot,context){context.beforeSubmit?.();posts++;return {providerJobId:'synthetic-no-network'};},async reconcile(){return null;},async poll(){return {status:'running'};},async download(){throw Error('No output requested');}};
 const providers=new Map([['mock',provider]]),f=await fixture(t,'responses',providers);
 f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'direct'},acknowledgePaid:true});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_generation_submit',{shotId:f.first.id,expectedRevision:1,providerId:'mock',model:'mock-motion-v1'})]:[])};});
 const sent=await f.send(),completed=await f.settle(sent.run.id);assert.equal(completed.run.status,'completed');assert.equal(f.requests.length,2);assert.equal(object(f.store.list('jobs',f.projectId)[0]).status,'queued');
 assert.equal(completed.backgroundPending,true);assert.equal(f.runtime.journal.hasPendingBackground(sent.run.id),true);
 f.restart();assert.equal(f.runtime.get(f.projectId,sent.run.id).run.status,'interrupted');assert.equal(f.requests.length,2);
 const worker=startWorker(f.store,f.services,providers);try{await worker.tick();await worker.tick();assert.equal(posts,0);assert.equal(f.requests.length,2);assert.equal(f.runtime.get(f.projectId,sent.run.id).run.status,'interrupted');}finally{await worker.stop();}
});
for(const action of ['pause','stop','finish_result'] as const)test(`completed model with a queued bound job supports ${action} and keeps live background evidence`,async t=>{
 let posts=0;const provider:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},
  async submit(_snapshot,context){context.beforeSubmit?.();posts++;return {providerJobId:'synthetic-no-network'};},async reconcile(){return null;},async poll(){return {status:'running'};},async download(){throw Error('No output requested');}};
 const providers=new Map([['mock',provider]]),f=await fixture(t,'responses',providers);f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'direct'},acknowledgePaid:true});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_generation_submit',{shotId:f.first.id,expectedRevision:1,providerId:'mock',model:'mock-motion-v1'})]:[])};});
 const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.backgroundPending,true);
 if(action==='finish_result'){
  const job=f.store.list('jobs',f.projectId)[0] as JobRecord;withAgentTaskJobOrigin(f.store.db,'job',job.id,()=>f.services.saveJob(job,{status:'succeeded',phase:'complete',progress:100,error:null}));
  const finished=f.runtime.get(f.projectId,sent.run.id);assert.equal(finished.backgroundPending,false);assert.equal(f.runtime.journal.hasPendingBackground(sent.run.id),false);assert.equal(finished.run.status,'completed');assert.ok(finished.changes.length>done.changes.length);assert.equal(f.requests.length,2);
  assert.throws(()=>f.runtime.journal.transition(sent.run.id,finished.run.revision,'paused'),{code:'AGENT_TASK_STATE_CONFLICT'});
 }else{
  const controlled=await f.action(done,action);assert.equal(controlled.run.status,action==='pause'?'paused':'stopped');assert.equal(controlled.backgroundPending,action==='pause');if(action==='stop')assert.equal(object(f.store.list('jobs',f.projectId)[0]).status,'cancelled');
  const worker=startWorker(f.store,f.services,providers);try{await worker.tick();await worker.tick();assert.equal(posts,0);assert.equal(f.requests.length,2);}finally{await worker.stop();}
 }
});
for(const stepLimit of [3,30])for(const action of ['approve','deny'] as const)test(`paid direct disabled after acceptance supports one-time ${action} of the original queued job at budget ${stepLimit}`,async t=>{
 let posts=0;const provider:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},
  async submit(_snapshot,context){context.beforeSubmit?.();posts++;return {providerJobId:'synthetic-approved-once'};},async reconcile(){return null;},async poll(){return {status:'running'};},async download(){throw Error('No output requested');}};
 const providers=new Map([['mock',provider]]),f=await fixture(t,'responses',providers);f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit,modes:{...f.runtime.policy().modes,paid:'direct'},acknowledgePaid:true});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_generation_submit',{shotId:f.first.id,expectedRevision:1,providerId:'mock',model:'mock-motion-v1'})]:[])};});
 const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.run.stepsUsed,3);assert.equal(done.run.budget,stepLimit);const job=object(f.store.list('jobs',f.projectId)[0]),jobId=String(job.id),originalStep=done.steps.find(step=>step.toolCall?.name==='mioon_generation_submit');assert.ok(originalStep);
 f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'confirm'}});
 const worker=startWorker(f.store,f.services,providers);try{
  await worker.tick();const waiting=f.runtime.get(f.projectId,sent.run.id);assert.equal(waiting.run.status,'awaiting_approval');assert.equal(waiting.steps.find(step=>step.id===originalStep.id)?.approvalRequired,true);assert.equal(posts,0);assert.equal(f.store.list('jobs',f.projectId).length,1);
  const request={requestId:randomUUID(),expectedRevision:waiting.run.revision,action,stepId:originalStep.id};await f.runtime.action(f.projectId,sent.run.id,request);await f.runtime.action(f.projectId,sent.run.id,request);await f.runtime.drain();await worker.tick();await worker.tick();
  assert.equal(posts,action==='approve'?1:0);assert.equal(f.store.list('jobs',f.projectId).length,1);assert.equal(String(object(f.store.list('jobs',f.projectId)[0]).id),jobId);assert.equal(f.requests.length,2);assert.equal(f.runtime.policy().modes.paid,'confirm');assert.equal(Boolean(f.runtime.get(f.projectId,sent.run.id).steps.find(step=>step.id===originalStep.id)?.approvalRequired),false);if(action==='deny')assert.equal(object(f.store.get('jobs',jobId)).status,'cancelled');
  const controlled=f.runtime.get(f.projectId,sent.run.id);assert.equal(controlled.run.status,'completed');assert.equal(controlled.run.stepsUsed,3);assert.equal(controlled.run.stepLimit,stepLimit);assert.equal(controlled.run.budget,stepLimit);assert.deepEqual(controlled.steps.map(step=>step.id),done.steps.map(step=>step.id));
 }finally{await worker.stop();}
});
test('a background approval cannot cross an ABA before submit; resume cancels the old job and replans once',async t=>{
 const entered=gate(),release=gate();let posts=0;
 const provider:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},
  async submit(_snapshot,context){entered.resolve();await release.promise;context.beforeSubmit?.();posts++;return {providerJobId:'synthetic-must-not-send'};},async reconcile(){return null;},async poll(){return {status:'running'};},async download(){throw Error('No output requested');}};
 const providers=new Map([['mock',provider]]),f=await fixture(t,'responses',providers);f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'direct'},acknowledgePaid:true});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_generation_submit',{shotId:f.first.id,expectedRevision:1,providerId:'mock',model:'mock-motion-v1'})]:[])};});
 const sent=await f.send();await f.settle(sent.run.id);const jobId=String(object(f.store.list('jobs',f.projectId)[0]).id);
 f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'confirm'}});
 const worker=startWorker(f.store,f.services,providers);try{
  await worker.tick();const waiting=f.runtime.get(f.projectId,sent.run.id),step=waiting.steps.find(item=>item.approvalRequired);assert.ok(step);await f.action(waiting,'approve',{stepId:step.id});await Promise.race([entered.promise,delay(10000,undefined,{ref:false}).then(()=>{throw Error('Synthetic provider did not reach before-submit barrier');})]);
  await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'manual after approval'}});await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:2,patch:{prompt:f.first.prompt}});release.resolve();
  await worker.tick();const paused=await f.wait(sent.run.id,['paused']);assert.equal(paused.run.pauseReason,'conflict');assert.equal(posts,0);assert.equal(f.requests.length,2);assert.equal(object(f.store.get('jobs',jobId)).status,'queued');
  await f.action(paused,'resume');const replanned=await f.settle(sent.run.id);assert.equal(replanned.run.status,'completed');assert.equal(replanned.backgroundPending,false);assert.equal(f.requests.length,3);assert.equal(object(f.store.get('jobs',jobId)).status,'cancelled');assert.equal(f.store.list('jobs',f.projectId).length,1);await worker.tick();assert.equal(posts,0);
 }finally{release.resolve();await worker.stop();}
});
for(const externalAba of [false,true])test(`persisted compensation chain ${externalAba?'cannot cross an external ABA':'continues adjacent AI changes after restart'}`,async t=>{
 const f=await fixture(t);let insertedAba=false;
 f.setScript(async function*(index){
  if(index===2&&externalAba){await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:2,patch:{prompt:'manual intervening'}});await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:3,patch:{prompt:'AI first'}});insertedAba=true;}
  const expectedRevision=index===1?1:externalAba?4:2;
  const calls=index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision,patch:{prompt:'AI first'}})]:index===2||externalAba&&index===3?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision,patch:{prompt:'AI second'}})]:[];
  yield {type:'done',output:output('responses',calls)};
 });
 const sent=await f.send();let done=await f.settle(sent.run.id);
 if(externalAba){assert.equal(done.run.status,'paused');assert.equal(done.run.pauseReason,'conflict');assert.equal(insertedAba,true);await f.action(done,'resume');done=await f.settle(sent.run.id);}
 assert.equal(done.run.status,'completed');assert.equal(done.changes.length,2);const latest=done.changes[1]!;
 await f.action(done,'undo_change',{changeId:latest.id});const reverted=f.runtime.journal.snapshot(sent.run.id).changes[1]!;
 assert.equal(reverted.status,'reverted');assert.ok(reverted.revertedTargets?.length);assert.equal(reverted.revertedTargets[0]?.revisionBefore,latest.targets[0]?.revisionBefore);assert.equal(reverted.revertedTargets[0]?.revisionAfter,latest.targets[0]?.revisionAfter);
 f.restart();done=f.runtime.get(f.projectId,sent.run.id);const request={requestId:randomUUID(),expectedRevision:done.run.revision,action:'undo_all'};
 if(externalAba){await assert.rejects(f.runtime.action(f.projectId,sent.run.id,request),{code:'AGENT_TASK_TARGET_CHANGED'});assert.equal(object(f.store.get('shots',f.first.id)).prompt,'AI first');assert.equal(f.runtime.journal.snapshot(sent.run.id).changes[0]?.status,'applied');assert.equal(object(f.runtime.journal.lookupControl(request.requestId)?.result).state,'blocked');}
 else {const undone=await f.runtime.action(f.projectId,sent.run.id,request);assert.equal(undone.run.status,'reverted');assert.equal(object(f.store.get('shots',f.first.id)).prompt,'saved first');assert.ok(undone.changes.every(change=>change.status==='reverted'));}
});
for(const protocol of ['chat_completions','responses'] as const){
 test(`${protocol}: text diagnostics omit tools and replay cannot widen the persisted profile`,async t=>{
  const f=await fixture(t,protocol),input={requestId:randomUUID(),text:'仅检查文本连接',expectedSettingsRevision:(await f.settings.get()).revision,diagnostic:{profile:'text'}};
  const sent=await f.runtime.send(f.projectId,input),done=await f.settle(sent.run.id);
  assert.equal(done.run.status,'completed');assert.deepEqual(done.run.diagnostic,{profile:'text'});assert.equal(f.effects.size,0);
  const body=object(JSON.parse(f.requests[0]!.body));for(const field of ['tools','tool_choice','parallel_tool_calls'])assert.equal(Object.hasOwn(body,field),false);
  assert.equal((await f.runtime.send(f.projectId,input)).run.id,sent.run.id);
  await assert.rejects(f.runtime.send(f.projectId,{...input,diagnostic:{profile:'catalog'}}),{code:'AGENT_TASK_REQUEST_CONFLICT'});
  f.restart();assert.deepEqual(f.runtime.get(f.projectId,sent.run.id).run.diagnostic,{profile:'text'});assert.equal(f.requests.length,1);
 });
 test(`${protocol}: read-only diagnostics roundtrip a tool and reject a write response before reading targets`,async t=>{
  const f=await fixture(t,protocol);f.setScript(async function*(index){yield {type:'done',output:output(protocol,index===1?[call('mioon_project_inspect')]:[])};});
  const sent=await f.runtime.send(f.projectId,{requestId:randomUUID(),text:'读取项目名称',expectedSettingsRevision:(await f.settings.get()).revision,diagnostic:{profile:'read_only'}}),done=await f.settle(sent.run.id);
  assert.equal(done.run.status,'completed');assert.equal(f.requests.length,2);assert.equal(f.effects.size,1);assert.equal(done.changes.length,0);
  const names=(object(JSON.parse(f.requests[0]!.body)).tools as Record<string,unknown>[]).map(tool=>protocol==='chat_completions'?String(object(tool.function).name):String(tool.name));
  assert.ok(names.includes('mioon_project_inspect'));assert.ok(!names.includes('mioon_shot_update'));
  f.setScript(async function*(){yield {type:'done',output:output(protocol,[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:f.first.revision,patch:{prompt:'forbidden'}})])};});
  const denied=await f.runtime.send(f.projectId,{requestId:randomUUID(),text:'拒绝诊断写入',expectedSettingsRevision:(await f.settings.get()).revision,diagnostic:{profile:'read_only'}}),failed=await f.settle(denied.run.id);
  assert.equal(failed.run.status,'failed');assert.equal(failed.run.pauseReason,'AGENT_TASK_DIAGNOSTIC_TOOL_FORBIDDEN');assert.equal(f.effects.size,1);assert.equal(failed.steps.filter(step=>step.kind==='tool').length,0);assert.equal(object(f.store.get('shots',f.first.id)).prompt,'saved first');
 });
 test(`${protocol}: catalog probes describe an admitted subset without executing returned tools`,async t=>{
  const f=await fixture(t,protocol);f.setScript(async function*(){yield {type:'done',output:output(protocol,[call('mioon_shot_create',{title:'Never created',prompt:'probe'})])};});
  const diagnostic={profile:'catalog',toolNames:['mioon_shot_create']},input={requestId:randomUUID(),text:'检查工具schema',expectedSettingsRevision:(await f.settings.get()).revision,diagnostic};
  const sent=await f.runtime.send(f.projectId,input),done=await f.settle(sent.run.id);
  assert.equal(done.run.status,'completed');assert.deepEqual(done.run.diagnostic,diagnostic);assert.equal(done.steps.length,1);assert.equal(f.effects.size,0);assert.equal(done.changes.length,0);assert.equal(f.requests.length,1);
  assert.equal((object(JSON.parse(f.requests[0]!.body)).tools as unknown[]).length,1);
  f.restart();assert.deepEqual(f.runtime.get(f.projectId,sent.run.id).run.diagnostic,diagnostic);
  await assert.rejects(f.runtime.send(f.projectId,{...input,requestId:randomUUID(),diagnostic:{profile:'catalog',toolNames:['mioon_agent_authorization_grant']}}),{code:'AGENT_TASK_INVALID'});assert.equal(f.requests.length,1);
 });
}
test('diagnostics cannot enter ordinary conversation history or narrow normal tool discovery',async t=>{
 const f=await fixture(t);f.setScript(async function*(){yield {type:'done',output:output('responses',[],'DIAGNOSTIC_PRIVATE_CONTEXT')};});
 const sent=await f.runtime.send(f.projectId,{requestId:randomUUID(),text:'DIAGNOSTIC_PROMPT',expectedSettingsRevision:(await f.settings.get()).revision,diagnostic:{profile:'text'}});await f.settle(sent.run.id);
 f.setScript(async function*(){yield {type:'done',output:output('responses')};});const normal=await f.send('普通任务');await f.settle(normal.run.id);
 const request=f.requests[1]!;assert.doesNotMatch(request.body,/DIAGNOSTIC_PRIVATE_CONTEXT|DIAGNOSTIC_PROMPT/u);assert.equal((object(JSON.parse(request.body)).tools as unknown[]).length,f.tools.list().length);assert.equal(f.runtime.get(f.projectId,normal.run.id).run.diagnostic,undefined);
});
for(const point of [
 {name:'model intent',event:'INSERT',kind:'model',status:'intent',requests:0,effects:0},
 {name:'model dispatch',event:'UPDATE',kind:'model',status:'dispatch_started',requests:0,effects:0},
 {name:'model result',event:'UPDATE',kind:'model',status:'completed',requests:1,effects:0},
 {name:'tool intent',event:'INSERT',kind:'tool',status:'intent',requests:1,effects:0},
 {name:'tool dispatch',event:'UPDATE',kind:'tool',status:'dispatch_started',requests:1,effects:0},
 {name:'tool result',event:'UPDATE',kind:'tool',status:'completed',requests:1,effects:1},
] as const)test(`${point.name} journal write failure blocks every later effect and continuation`,async t=>{
 const f=await fixture(t);f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_project_inspect')]:[])};});
 f.store.db.exec(`CREATE TRIGGER test_block_journal BEFORE ${point.event} ON agent_task_steps_v2 WHEN json_extract(NEW.data,'$.kind')='${point.kind}' AND NEW.status='${point.status}' BEGIN SELECT RAISE(ABORT,'synthetic disk write failed');END;`);
 const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(f.effects.size,point.effects);assert.equal(f.requests.length,point.requests);assert.equal(done.run.status,'failed');
});
