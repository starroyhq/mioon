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
import {withAgentTaskJobOrigin,allowAgentTaskJobTargetMutation,setAgentTaskEffectGate,setAgentTaskJobResumer,assertAgentTaskJobEffect,isAgentTaskEffectBlocked} from '../packages/business/src/agent/task-effects-v2.ts';
import type {Provider,ProviderContext} from '../packages/business/src/provider-registry.ts';
import type {TaskModelItem,TaskModelRequest,TaskModelOutput} from '../packages/business/src/agent/task-gateway-v2.ts';
import {createTaskGateway,buildTaskModelRequest,taskContinuation,taskResponseLanguageContext,taskResponseLocale,TASK_MODEL_LIMITS} from '../packages/business/src/agent/task-gateway-v2.ts';
import {sourceTaskModelToolNames,selectTaskModelTools} from '../packages/business/src/agent/task-context-v2.ts';
import {AGENT_TASK_TOOLS_LOAD_NAME,agentTaskToolNamesForGroup} from '../packages/business/src/agent/task-tool-groups-v2.ts';
import type {AgentTaskLoadableToolGroupId} from '../packages/business/src/agent/task-tool-groups-v2.ts';
import {AGENT_TASK_LOCALES} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTransportDependencies} from '../packages/business/src/agent/network-policy.ts';
import type {AgentTaskJson,AgentTaskToolCall,AgentTaskStatus,AgentTaskSnapshot,AgentTaskControlAction} from '../packages/contracts/src/agent-tasks-v2.ts';
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
function syntheticDeniedTransport(address:string,statusCode=401,errorBody='',readFailure=false){
 const counts={dns:0,requests:0,ends:0};
 const dependencies={lookup:async()=>{counts.dns++;return [{address,family:4}];},httpsRequest:(_options:unknown,respond:(response:IncomingMessage)=>void)=>{
  counts.requests++;const request=Object.assign(new EventEmitter(),{setTimeout(){},destroy(){},end(){counts.ends++;const source=readFailure?(async function*(){yield Buffer.from(errorBody);throw Error('PRIVATE_PROVIDER_READ_FAILURE');})():[Buffer.from(errorBody)];respond(Object.assign(Readable.from(source),{statusCode,headers:{'content-type':'text/event-stream'}}) as IncomingMessage);}});
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
 const requests:TaskModelRequest[]=[],scriptRequestIndexes:number[]=[],effects=new Map<string,string>(),baseTools=createAgentTaskTools({store,services});let beforeTool:((prepared:PreparedAgentTaskTool)=>Promise<void>)|undefined,script:Script=async function*(){yield {type:'done',output:output(protocol)};},loadGroups:readonly AgentTaskLoadableToolGroupId[]=[],loadingRequests=0;
 const tools={...baseTools,async execute(prepared:PreparedAgentTaskTool,context:AgentTaskToolContext){await beforeTool?.(prepared);return baseTools.execute(prepared,{...context,beforeEffect(){context.beforeEffect();effects.set(context.stepId,prepared.operation);}});}};
 // Opt-in scripts explicitly perform a real loading round before their domain
 // plan. Audit snapshots, effects and raw request counts include both rounds.
 const gateway=async function*(request:TaskModelRequest){
  requests.push(request);const visible=sourceTaskModelToolNames(protocol,{body:request.body});
  const missing=loadGroups.filter(group=>!agentTaskToolNamesForGroup(group).every(name=>visible.includes(name)));
  if(missing.length&&visible.includes(AGENT_TASK_TOOLS_LOAD_NAME)){loadingRequests++;yield {type:'done' as const,output:output(protocol,[call(AGENT_TASK_TOOLS_LOAD_NAME,{groups:[...missing]})])};return;}
  scriptRequestIndexes.push(requests.length-1);yield*script(scriptRequestIndexes.length,request);
 };
 let runtime=createAgentTaskRuntime({store,agentSettings:runtimeSettings,authorizations,tools,gateway,selfPort:()=>4318});
 t.after(async()=>{runtime.close();baseTools.dispose();bridge?.close();await settings.close();store.close();rmSync(root,{recursive:true,force:true});});
 return {root,store,services,settings,bridge,authorizations,projectId,first,other,requests,effects,tools,
  get runtime(){return runtime;},get loadingRequests(){return loadingRequests;},get loadingEffects(){return [...effects.values()].filter(operation=>operation==='tools.load').length;},
  loadingSteps(snapshot:AgentTaskSnapshot){return snapshot.steps.filter(step=>step.toolCall?.name===AGENT_TASK_TOOLS_LOAD_NAME||step.kind==='model'&&Array.isArray(object(step.result??{}).toolCalls)&&(object(step.result).toolCalls as AgentTaskToolCall[]).some(call=>call.name===AGENT_TASK_TOOLS_LOAD_NAME)).length;},
  scriptRequest(index:number){const position=scriptRequestIndexes[index-1];assert.notEqual(position,undefined);return requests[position!]!;},
  setScript(value:Script,{loadGroups:groups=[]}:{loadGroups?:readonly AgentTaskLoadableToolGroupId[]}={}){script=value;loadGroups=groups;},beforeTool(value:(prepared:PreparedAgentTaskTool)=>Promise<void>){beforeTool=value;},
  async revoke(){const current=await authorizations.list(),grant=current.authorizations.find(item=>item.scope==='project_agent');assert.ok(grant);await authorizations.revoke({requestId:randomUUID(),expectedRevision:current.revision,authorizationId:grant.id});},
  async send(text='执行测试',requestId:string=randomUUID()){return runtime.send(projectId,{requestId,text,expectedSettingsRevision:(await settings.get()).revision});},
  async settle(runId:string){await runtime.drain();return runtime.get(projectId,runId);},
  async wait(runId:string,statuses:AgentTaskStatus[]){const deadline=Date.now()+10000;for(;;){const snapshot=runtime.get(projectId,runId);if(statuses.includes(snapshot.run.status))return snapshot;if(Date.now()>deadline)throw Error(`Unexpected task state ${JSON.stringify(snapshot.run)}`);await delay(5);}},
  action(snapshot:AgentTaskSnapshot,action:AgentTaskControlAction,extra:Record<string,unknown>={}){return runtime.action(projectId,snapshot.run.id,{requestId:randomUUID(),expectedRevision:snapshot.run.revision,action,...extra});},
  restart(){runtime.close();runtime=createAgentTaskRuntime({store,agentSettings:runtimeSettings,authorizations,tools,gateway,selfPort:()=>4318});},
 };
}
test('all classified Chat Completions stream failures persist safe diagnostics, execute no tools and never replay',async t=>{
  const frame=(value:unknown)=>`data: ${JSON.stringify(value)}\n\n`,finish=(reason:string)=>frame({choices:[{index:0,delta:{},finish_reason:reason}]});
  for(const reason of ['missing_done','missing_finish','unframed_sse','output_limit','read_failed'] as const){
    await t.test(reason,async t=>{
    const f=await fixture(t,'chat_completions'),argumentsJson=JSON.stringify({shotId:f.first.id,expectedRevision:f.first.revision,patch:{prompt:'PRIVATE_TOOL_ARGUMENT'}});
    const prefix=frame({choices:[{index:0,delta:{content:'预备',tool_calls:[{index:0,id:'private_call',type:'function',function:{name:'mioon_shot_update',arguments:argumentsJson}}]},finish_reason:null}]});
    const wire=prefix+(reason==='missing_done'?finish('tool_calls'):reason==='missing_finish'?'data: [DONE]\n\n':reason==='unframed_sse'?finish('tool_calls')+'data: [DONE]':reason==='output_limit'?finish('length')+'data: [DONE]\n\n':'');
    const transport=syntheticDeniedTransport('8.8.8.8',200,wire,reason==='read_failed');f.setScript(async function*(_index,request){yield*transport.gateway(request);});
    const sent=await f.send(),done=await f.settle(sent.run.id),model=done.steps[0]!;
    assert.equal(done.run.status,'failed');assert.equal(done.run.pauseReason,'AGENT_CHAT_TRUNCATED');assert.equal(done.steps.length,1);assert.equal(model.status,'failed');assert.equal(model.error?.code,'AGENT_CHAT_TRUNCATED');
    assert.ok(model.error!.message.includes(`流终止诊断：${reason}`));assert.match(model.error!.message,/工具数 1/u);assert.match(model.error!.message,/输出字节 6/u);
    assert.doesNotMatch(JSON.stringify({done,events:f.runtime.journal.events(sent.run.id).filter(event=>event.type==='error')}),/PRIVATE_TOOL_ARGUMENT|PRIVATE_PROVIDER_READ_FAILURE|mioon_shot_update|private_call/u);
    assert.equal(f.effects.size,0);assert.equal(done.changes.length,0);assert.equal(object(f.store.get('shots',f.first.id)).prompt,'saved first');assert.deepEqual(transport.counts,{dns:1,requests:1,ends:1});
    f.restart();const replay=await f.send('执行测试',sent.run.requestId);assert.equal(replay.run.id,sent.run.id);assert.equal(replay.steps[0]?.error?.message,model.error?.message);await f.runtime.drain();assert.equal(f.requests.length,1);assert.deepEqual(transport.counts,{dns:1,requests:1,ends:1});assert.equal(f.effects.size,0);
    });
  }
});
test('forged stream diagnostics and provider causes never reach persisted task error messages',async t=>{
  const f=await fixture(t,'chat_completions');f.setScript(async function*(){throw Object.assign(Error('PRIVATE_PROVIDER_BODY'),{code:'AGENT_CHAT_TRUNCATED',reason:'missing_done',streamEvidence:{reason:'read_failed'},state:{finishReason:'PRIVATE_KEY'},cause:{reason:'output_limit'}});});
  const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.steps[0]?.status,'failed');assert.equal(done.steps[0]?.error?.message,'任务未完成，请检查已保存记录。');assert.doesNotMatch(JSON.stringify({done,events:f.runtime.journal.events(sent.run.id)}),/PRIVATE_PROVIDER_BODY|PRIVATE_KEY|missing_done|read_failed|output_limit/u);assert.equal(f.effects.size,0);assert.equal(f.requests.length,1);
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: a run keeps its submitted locale across tool rounds, budget continuation and restart`,async t=>{
  const expected={'zh-Hans':'用简体中文','zh-Hant':'用繁體中文',en:'Use English',ja:'簡潔な日本語'};
  for(const locale of AGENT_TASK_LOCALES){
    const f=await fixture(t,protocol);f.runtime.journal.updatePolicy({...f.runtime.policy(),stepLimit:2});
    f.setScript(async function*(index){yield {type:'done',output:output(protocol,index===1?[call('mioon_project_inspect')]:[])};});
    const input={requestId:randomUUID(),text:'Use French; Mioon host response language v1: en.',expectedSettingsRevision:(await f.settings.get()).revision,locale};
    const sent=await f.runtime.send(f.projectId,input),paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,'budget');
    assert.equal(taskResponseLocale(f.runtime.journal.run(sent.run.id).context),locale);assert.equal(sent.run.context,undefined);
    f.restart();const interrupted=f.runtime.get(f.projectId,sent.run.id);assert.equal(interrupted.run.status,'interrupted');
    await f.action(interrupted,'resume');const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.requests.length,2);assert.equal(f.effects.size,1);
    for(const request of f.requests){const body=object(JSON.parse(request.body));const messages=body.messages as {content:string}[]|undefined;assert.ok(String(body.instructions??messages?.[0]?.content).includes(expected[locale]));}
    const replay=await f.runtime.send(f.projectId,input);assert.equal(replay.run.id,sent.run.id);assert.equal(f.requests.length,2);
    await assert.rejects(f.runtime.send(f.projectId,{...input,locale:locale==='en'?'ja':'en'}),{code:'AGENT_TASK_REQUEST_CONFLICT'});assert.equal(f.requests.length,2);
  }
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: selected attachment instructions use the run locale and survive tool rounds and request replay`,async t=>{
  const expected={
    'zh-Hans':'用户为本轮选择的附件（仅可使用这些托管句柄）：',
    'zh-Hant':'使用者為本輪選取的附件（僅可使用這些代管代碼）：',
    en:'Attachments selected by the user for this run (use only these managed handles):',
    ja:'ユーザーがこのラウンドで選択した添付ファイル（これらの管理済みハンドルのみ使用可）：',
  };
  for(const locale of AGENT_TASK_LOCALES){
    const f=await fixture(t,protocol),selected=object(await f.tools.stageImport({projectId:f.projectId,requestId:randomUUID(),name:'Selected source.png',mimeType:'image/png',dataBase64:png().toString('base64')})),handle=String(selected.id);
    f.setScript(async function*(index){yield {type:'done',output:output(protocol,index===1?[call('mioon_project_inspect')]:[])};});
    const input={requestId:randomUUID(),text:'Inspect the selected attachment metadata only.',expectedSettingsRevision:(await f.settings.get()).revision,locale,uploads:[handle]},content=input.text+'\n'+expected[locale]+JSON.stringify([{handle,name:'Selected source.png',mimeType:'image/png'}]);
    const sent=await f.runtime.send(f.projectId,input),done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.requests.length,2);assert.deepEqual(f.runtime.journal.run(sent.run.id).context?.at(-1),{role:'user',content});assert.equal(sent.run.context,undefined);
    for(const request of f.requests){const body=object(JSON.parse(request.body)),history=body[protocol==='responses'?'input':'messages'];assert.ok(Array.isArray(history));assert.ok(history.some(item=>object(item).role==='user'&&object(item).content===content));}
    f.restart();assert.equal((await f.runtime.send(f.projectId,input)).run.id,sent.run.id);assert.equal(f.requests.length,2);assert.deepEqual(f.runtime.journal.run(sent.run.id).context?.at(-1),{role:'user',content});
  }
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: a tool explanation survives approval and restart without entering business arguments or results`,async t=>{
  const f=await fixture(t,protocol),caption='Update the shot description',args={shotId:f.first.id,expectedRevision:f.first.revision,patch:{prompt:'approved description'}},planned=call('mioon_shot_update',args),executed:Record<string,unknown>[]=[];
  f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,local_reversible:'confirm'}});
  f.beforeTool(async prepared=>{if(prepared.operation==='tools.load')return;executed.push(structuredClone(prepared.input));});
  f.setScript(async function*(index){
    if(index!==1){yield {type:'done',output:output(protocol)};return;}
    // The protocol gateway retains provider output for its explanation while
    // stripping the host-only presentation field from executable arguments.
    // Its dual-protocol wire stripping is covered by the gateway integration.
    const retained=output(protocol,[{...planned,arguments:{...args,_mio_step:caption}}]);retained.toolCalls=[planned];yield {type:'done',output:retained};
  },{loadGroups:['canvas']});
  const sent=await f.send(),waiting=await f.wait(sent.run.id,['awaiting_approval']);await f.runtime.drain();const original=waiting.steps.find(step=>step.kind==='tool'&&step.toolCall?.name!==AGENT_TASK_TOOLS_LOAD_NAME);assert.ok(original);
  assert.equal(original.status,'awaiting_approval');assert.equal(original.text,caption);assert.deepEqual(original.toolCall?.arguments,args);assert.equal(f.requests.length,(1)+f.loadingRequests);assert.equal(f.effects.size,(0)+f.loadingEffects);assert.equal(executed.length,0);
  f.restart();const interrupted=f.runtime.get(f.projectId,sent.run.id);assert.equal(interrupted.run.status,'interrupted');assert.equal(interrupted.steps.find(step=>step.id===original.id)?.text,caption);assert.equal(f.requests.length,(1)+f.loadingRequests);
  await f.action(interrupted,'resume');const approval=await f.wait(sent.run.id,['awaiting_approval']);await f.runtime.drain();const restored=approval.steps.find(step=>step.id===original.id);assert.ok(restored);assert.equal(restored.text,caption);assert.equal(restored.status,'awaiting_approval');assert.equal(f.requests.length,(1)+f.loadingRequests);assert.equal(f.effects.size,(0)+f.loadingEffects);
  await f.action(approval,'approve',{stepId:original.id});const done=await f.settle(sent.run.id),completed=done.steps.find(step=>step.id===original.id);assert.ok(completed);assert.equal(done.run.status,'completed');assert.equal(completed.status,'completed');assert.equal(completed.text,caption);assert.deepEqual(completed.toolCall?.arguments,args);assert.equal(f.effects.size,(1)+f.loadingEffects);assert.equal(executed.length,1);assert.deepEqual(executed[0],args);assert.equal(f.requests.length,(2)+f.loadingRequests);assert.equal(object(f.store.get('shots',f.first.id)).prompt,'approved description');
  assert.doesNotMatch(JSON.stringify({prepared:executed[0],tool:completed.toolCall,result:completed.result,savedTool:f.runtime.journal.step(original.id),business:f.store.get('shots',f.first.id)}),/_mio_step/u);
  f.restart();const stable=f.runtime.get(f.projectId,sent.run.id);assert.equal(stable.steps.find(step=>step.id===original.id)?.text,caption);assert.equal(f.requests.length,(2)+f.loadingRequests);assert.equal(f.effects.size,(1)+f.loadingEffects);
});
test('omitted locale and explicit Simplified Chinese replay the same run; invalid locale never creates a request',async t=>{
  const f=await fixture(t),input={requestId:randomUUID(),text:'English user content does not choose the response language',expectedSettingsRevision:(await f.settings.get()).revision};
  const sent=await f.runtime.send(f.projectId,input);await f.settle(sent.run.id);
  assert.equal((await f.runtime.send(f.projectId,{...input,locale:'zh-Hans'})).run.id,sent.run.id);
  for(const locale of [null,'','EN','zh-CN','fr',{},1])await assert.rejects(f.runtime.send(f.projectId,{...input,requestId:randomUUID(),locale}),{code:'AGENT_TASK_INVALID'});
  assert.equal(f.requests.length,1);assert.equal(f.runtime.journal.list(f.projectId).length,1);
  // An old retained context has no host marker; the original request remains
  // addressable with the compatible omitted/default locale after restart.
  const old=f.runtime.journal.run(sent.run.id);old.context=old.context!.slice(1);f.store.db.prepare('UPDATE agent_task_runs_v2 SET data=? WHERE id=?').run(JSON.stringify(old),old.id);
  f.restart();assert.equal((await f.runtime.send(f.projectId,input)).run.id,sent.run.id);assert.equal((await f.runtime.send(f.projectId,{...input,locale:'zh-Hans'})).run.id,sent.run.id);assert.equal(f.requests.length,1);
});
test('history byte trimming keeps the exact host language and final user message without inheriting an earlier locale',async t=>{
  const f=await fixture(t);f.setScript(async function*(){yield {type:'done',output:output('responses',[],'x'.repeat(50000))};});
  let conversationId:string|undefined;for(let index=0;index<4;index++){const sent=await f.runtime.send(f.projectId,{requestId:randomUUID(),text:'previous '+index+' '+('x'.repeat(28000)),expectedSettingsRevision:(await f.settings.get()).revision,locale:'en',...(conversationId?{conversationId}:{})});conversationId=sent.run.conversationId;await f.settle(sent.run.id);}
  const text='現在の指示',sent=await f.runtime.send(f.projectId,{requestId:randomUUID(),text,expectedSettingsRevision:(await f.settings.get()).revision,locale:'ja',conversationId});await f.settle(sent.run.id);
  const context=f.runtime.journal.run(sent.run.id).context!;assert.deepEqual(context[0],taskResponseLanguageContext('ja'));assert.deepEqual(context.at(-1),{role:'user',content:text});assert.ok(Buffer.byteLength(JSON.stringify(context))<=TASK_MODEL_LIMITS.historyBytes);assert.ok(context.length<10);assert.equal(taskResponseLocale(context),'ja');
});
test('resuming a legacy model intent sends its original journaled body without rewriting language',async t=>{
  const f=await fixture(t),settings=await f.settings.get(),context=[{role:'user',content:'legacy request'}];
  const created=f.runtime.journal.create({projectId:f.projectId,requestId:randomUUID(),text:'legacy request',configuration:{...settings.configuration},settingsRevision:settings.revision,context});
  const body=object(JSON.parse(buildTaskModelRequest(settings.configuration,context,[],4318)));body.instructions='旧版固定中文指令';const original=JSON.stringify(body);
  const step=f.runtime.journal.beginStep(created.run.id,{kind:'model',request:{body:original,history:context},data:{baseline:[]}});
  f.restart();const interrupted=f.runtime.get(f.projectId,created.run.id);assert.equal(interrupted.run.status,'interrupted');assert.equal(interrupted.steps[0]!.status,'intent');
  await f.action(interrupted,'resume');const done=await f.settle(created.run.id);assert.equal(done.run.status,'completed');assert.equal(f.requests.length,1);assert.equal(f.requests[0]!.body,original);assert.equal(object(f.runtime.journal.step(step.id).request).body,original);
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: an unsent intent bypasses reassembly even when retained base context cannot fit`,async t=>{
  const f=await fixture(t,protocol),settings=await f.settings.get(),history=[{role:'user',content:'Retained request before the assembler upgrade.'}];
  const original=buildTaskModelRequest(settings.configuration,history,[],4318),context=[taskResponseLanguageContext('en'),{role:'user',content:'x'.repeat(TASK_MODEL_LIMITS.historyBytes+1)}];
  const created=f.runtime.journal.create({projectId:f.projectId,requestId:randomUUID(),text:'Retained request before the assembler upgrade.',configuration:{...settings.configuration},settingsRevision:settings.revision,context});
  const model=f.runtime.journal.beginStep(created.run.id,{kind:'model',request:{body:original,history},data:{baseline:[]}}),frozen=structuredClone(model.request);
  f.restart();await f.action(f.runtime.get(f.projectId,created.run.id),'resume');const done=await f.settle(created.run.id);
  assert.equal(done.run.status,'completed');assert.equal(f.requests.length,1);assert.equal(f.requests[0]!.body,original);
  assert.deepEqual(f.runtime.journal.step(model.id).request,frozen);assert.deepEqual(f.runtime.journal.run(created.run.id).context,context);
  assert.equal(done.run.stepsUsed,1);assert.deepEqual(done.run.notes,[]);assert.equal(f.effects.size,0);
});
test('retained continuation is validated before a later historical model can execute its tool batch',async t=>{
 const f=await fixture(t),settings=await f.settings.get(),context=[taskResponseLanguageContext('en'),{role:'user',content:'Resume recorded work.'}],body=buildTaskModelRequest(settings.configuration,context,f.tools.list(),4318);
 const created=f.runtime.journal.create({projectId:f.projectId,requestId:randomUUID(),text:'Resume recorded work.',configuration:{...settings.configuration},settingsRevision:settings.revision,context});
 const first=f.runtime.journal.beginStep(created.run.id,{kind:'model',request:{body,history:context},data:{baseline:[],noteContinuationRequested:true}});
 f.runtime.journal.completeStep(created.run.id,first.id,{result:{text:'Earlier observed output',toolCalls:[],providerOutput:{invalidRetainedResponse:true}}});
 const baseline=f.runtime.journal.revisionSnapshot(f.projectId).map(({kind,id,revision})=>({kind,id,revision}));
 const second=f.runtime.journal.beginStep(created.run.id,{kind:'model',request:{body,history:context},data:{baseline}}),edit=call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'Must not execute after invalid history'}});
 f.runtime.journal.completeStep(created.run.id,second.id,{result:output('responses',[edit]) as unknown as AgentTaskJson});
 f.restart();await f.action(f.runtime.get(f.projectId,created.run.id),'resume');const done=await f.settle(created.run.id);
 assert.equal(done.run.status,'failed');assert.equal(f.requests.length,0);assert.equal(f.effects.size,0);assert.equal(done.changes.length,0);
 assert.equal(object(f.store.get('shots',f.first.id)).prompt,'saved first');assert.equal(done.steps.filter(step=>step.kind==='tool').length,0);
});
for(const protocol of ['chat_completions','responses'] as const){
 test(`${protocol}: a trusted DNS denial records prevented dispatch and never becomes an unknown model result`,async t=>{
  const f=await fixture(t,protocol),transport=syntheticDeniedTransport('198.18.10.207');f.setScript(async function*(_index,request){yield*transport.gateway(request);});
  const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'failed');assert.equal(done.run.pauseReason,'AGENT_CHAT_NETWORK_DENIED');
  assert.equal(done.steps.length,1);const model=done.steps[0]!;assert.equal(model.kind,'model');assert.equal(model.status,'failed');assert.equal(model.error?.code,'AGENT_CHAT_NETWORK_DENIED');assert.equal(done.steps.some(step=>step.status==='unknown'),false);
  assert.deepEqual(f.runtime.journal.events(sent.run.id).filter(event=>event.type==='dispatch_prevented').map(event=>event.data),[{stepId:model.id,next:'intent'}]);
  assert.deepEqual(transport.counts,{dns:1,requests:0,ends:0});assert.equal(f.requests.length,1);assert.equal(f.effects.size,0);assert.equal(done.changes.length,0);
  f.restart();assert.equal(f.runtime.lookup(f.projectId,sent.run.requestId).snapshot?.run.status,'failed');const replay=await f.send('执行测试',sent.run.requestId);assert.equal(replay.run.id,sent.run.id);assert.equal(replay.steps[0]?.status,'failed');
  await f.runtime.drain();assert.equal(f.requests.length,1);assert.deepEqual(transport.counts,{dns:1,requests:0,ends:0});assert.equal(f.effects.size,0);
 });
 test(`${protocol}: a provider HTTP error after request end is a recorded failure without automatic replay`,async t=>{
  const f=await fixture(t,protocol),transport=syntheticDeniedTransport('8.8.8.8');f.setScript(async function*(_index,request){yield*transport.gateway(request);});
  const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'failed');assert.equal(done.run.pauseReason,'AGENT_CHAT_HTTP_ERROR');assert.equal(done.steps.length,1);assert.equal(done.steps[0]?.status,'failed');assert.equal(done.steps[0]?.error?.code,'AGENT_CHAT_HTTP_ERROR');
  assert.match(done.steps[0]!.error!.message,/HTTP 401/u);assert.deepEqual(f.runtime.journal.events(sent.run.id).filter(event=>event.type==='error').map(event=>event.data),[{code:'AGENT_CHAT_HTTP_ERROR',message:done.steps[0]!.error!.message}]);
  assert.equal(f.runtime.journal.events(sent.run.id).filter(event=>event.type==='dispatch_prevented').length,0);assert.deepEqual(transport.counts,{dns:1,requests:1,ends:1});assert.equal(f.requests.length,1);assert.equal(f.effects.size,0);assert.equal(done.changes.length,0);
  f.restart();const found=f.runtime.lookup(f.projectId,sent.run.requestId);assert.equal(found.snapshot?.steps[0]?.status,'failed');const replay=await f.send('执行测试',sent.run.requestId);assert.equal(replay.run.id,sent.run.id);assert.equal(replay.steps[0]?.status,'failed');
  await f.runtime.drain();assert.equal(f.requests.length,1);assert.deepEqual(transport.counts,{dns:1,requests:1,ends:1});assert.equal(f.effects.size,0);
 });
 test(`${protocol}: arbitrary provider exception fields never become persisted HTTP diagnostics`,async t=>{
  const f=await fixture(t,protocol);f.setScript(async function*(){throw Object.assign(new Error('PRIVATE_PROVIDER_BODY'),{code:'AGENT_CHAT_HTTP_ERROR',httpStatus:401,statusCode:403,headers:{authorization:'PRIVATE_KEY'}});});
  const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.steps[0]?.status,'failed');assert.equal(done.steps[0]?.error?.message,'任务未完成，请检查已保存记录。');
  const serialized=JSON.stringify({done,events:f.runtime.journal.events(sent.run.id)});assert.doesNotMatch(serialized,/PRIVATE_PROVIDER_BODY|PRIVATE_KEY|HTTP 401|HTTP 403/u);assert.equal(f.requests.length,1);
 });
 test(`${protocol}: HTTP 400 persists only fixed parameter hints and keeps the original failed request`,async t=>{
  const f=await fixture(t,protocol),transport=syntheticDeniedTransport('8.8.8.8',400,JSON.stringify({error:{message:'Invalid function schema for tools[0].function.parameters: PRIVATE_PROVIDER_BODY PRIVATE_KEY',param:'tools'}}));f.setScript(async function*(_index,request){yield*transport.gateway(request);});
  const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'failed');assert.equal(done.steps[0]?.status,'failed');const message=done.steps[0]!.error!.message;assert.match(message,/HTTP 400/u);assert.match(message,/参数提示/u);assert.match(message,/tools/u);
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
test('same target ABA during model wait pauses while another shot edit does not',async t=>{for(const same of [true,false]){const f=await fixture(t),entered=gate(),release=gate();f.setScript(async function*(index){if(index===1){entered.resolve();await release.promise;}yield {type:'done',output:output('responses',index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:f.first.revision,patch:{prompt:'AI edit'}})]:[])};},{loadGroups:['canvas']});const sent=await f.send();await entered.promise;const target=same?f.first:f.other;let saved=object(await f.services.call('shot.update',{shotId:target.id,expectedRevision:target.revision,patch:{prompt:'manual edit'}}));if(same)saved=object(await f.services.call('shot.update',{shotId:target.id,expectedRevision:saved.revision,patch:{prompt:target.prompt}}));release.resolve();const end=await f.settle(sent.run.id);assert.equal(end.run.status,same?'paused':'completed');assert.equal(f.effects.size,(same?0:1)+f.loadingEffects);if(same){assert.equal(end.run.pauseReason,'conflict');assert.equal(f.requests.length,(1)+f.loadingRequests);}else assert.equal(object(f.store.get('shots',String(f.other.id))).prompt,'manual edit');}});
test('unsaved editing claim blocks only its target and skip re-plans after explicit release',async t=>{const f=await fixture(t);const target={kind:'shot',id:String(f.first.id),revision:f.runtime.journal.targetRevision(f.projectId,'shot',String(f.first.id))};f.runtime.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId:'runtime-edit-owner',generation:1,sequence:1,action:'claim',targets:[target]});f.setScript(async function*(){yield {type:'done',output:output('responses',[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:f.first.revision,patch:{prompt:'AI edit'}})])};},{loadGroups:['canvas']});const sent=await f.send(),paused=await f.settle(sent.run.id);assert.equal(paused.run.status,'paused');assert.equal(paused.run.pauseReason,'editing');assert.equal(f.effects.size,(0)+f.loadingEffects);assert.equal(f.requests.length,(1)+f.loadingRequests);f.runtime.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId:'runtime-edit-owner',generation:1,sequence:2,action:'release',targets:[target]});f.setScript(async function*(){yield {type:'done',output:output('responses')};},{loadGroups:['canvas']});await f.action(paused,'skip');const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.effects.size,(0)+f.loadingEffects);assert.equal(f.requests.length,(2)+f.loadingRequests);assert.match(f.scriptRequest(2).body,/TARGET_SKIPPED/);});
for(const protocol of ['chat_completions','responses'] as const)for(const legacy of [false,true])for(const reason of ['editing','conflict'] as const)test(`${protocol}: interrupted ${legacy?'legacy restart':'preserved'} ${reason} returns to conflict selection before any old tool can run`,async t=>{
 const f=await fixture(t,protocol),target={kind:'shot',id:f.first.id,revision:f.runtime.journal.targetRevision(f.projectId,'shot',f.first.id)},ownerId=randomUUID(),entered=gate(),release=gate();
 if(reason==='editing')f.runtime.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId,generation:1,sequence:1,action:'claim',targets:[target]});
 f.setScript(async function*(index){if(index===1){entered.resolve();await release.promise;}yield {type:'done',output:output(protocol,index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'old parameters must not run'}})]:[])};},{loadGroups:['canvas']});
 const sent=await f.send();await entered.promise;
 if(reason==='conflict'){
  const changed=object(await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'manual ABA'}}));
  await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:revisionField(changed),patch:{prompt:f.first.prompt}});
 }
 release.resolve();const paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,reason);
 if(reason==='editing')f.runtime.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId,generation:1,sequence:2,action:'release',targets:[target]});
 await assert.rejects(f.action(paused,'resume'),{code:'AGENT_TASK_SKIP_REQUIRED'});assert.equal(f.effects.size,(0)+f.loadingEffects);assert.equal(f.requests.length,(1)+f.loadingRequests);
 f.restart();let interrupted=f.runtime.get(f.projectId,sent.run.id);assert.equal(interrupted.run.status,'interrupted');
 if(legacy){const saved=f.runtime.journal.run(sent.run.id);f.store.db.prepare('UPDATE agent_task_runs_v2 SET data=? WHERE id=?').run(JSON.stringify({...saved,pauseReason:'restart'}),sent.run.id);interrupted=f.runtime.get(f.projectId,sent.run.id);}
 let wakeups=0;const removeResumer=setAgentTaskJobResumer(f.store.db,'synthetic-conflict-resume',()=>{wakeups++;});t.after(removeResumer);
 const control={requestId:randomUUID(),expectedRevision:interrupted.run.revision,action:'resume'},selected=await f.runtime.action(f.projectId,sent.run.id,control);await f.runtime.drain();
 assert.equal(selected.run.status,'paused');assert.equal(selected.run.pauseReason,legacy?'conflict':reason);assert.equal(selected.run.budget,paused.run.budget);assert.equal(selected.run.stepsUsed,paused.run.stepsUsed);
 assert.equal(f.effects.size,(0)+f.loadingEffects);assert.equal(f.requests.length,(1)+f.loadingRequests);assert.equal(wakeups,0);assert.deepEqual(selected.run.skippedTargets,[]);assert.equal(object(f.store.get('shots',f.first.id)).prompt,f.first.prompt);
 const stable=f.runtime.journal.snapshot(sent.run.id),events=f.runtime.journal.events(sent.run.id);await f.runtime.action(f.projectId,sent.run.id,control);assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),stable);assert.deepEqual(f.runtime.journal.events(sent.run.id),events);assert.equal(wakeups,0);
 await assert.rejects(f.action(selected,'resume'),{code:'AGENT_TASK_SKIP_REQUIRED'});await f.action(selected,'skip');const done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(done.run.skippedTargets?.[0]?.target.id,f.first.id);assert.equal(done.changes.length,0);assert.equal(f.effects.size,(0)+f.loadingEffects);assert.equal(f.requests.length,(2)+f.loadingRequests);assert.match(f.scriptRequest(2)!.body,/TARGET_SKIPPED/);assert.equal(wakeups,1);assert.equal(object(f.store.get('shots',f.first.id)).prompt,f.first.prompt);
});
for(const status of ['denied','rejected','completed'] as const)test(`interrupted restart ignores handled ${status} conflict metadata`,async t=>{
 const f=await fixture(t),target={kind:'shot',id:f.first.id,revision:f.runtime.journal.targetRevision(f.projectId,'shot',f.first.id)};f.runtime.journal.claim({projectId:f.projectId,ownerId:'handled-conflict',targets:[target]});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'handled old parameters'}})]:[])};},{loadGroups:['canvas']});
 const sent=await f.send(),paused=await f.settle(sent.run.id),step=paused.steps.find(item=>item.kind==='tool'&&item.toolCall?.name!==AGENT_TASK_TOOLS_LOAD_NAME);assert.ok(step);assert.equal(paused.run.pauseReason,'editing');f.runtime.journal.releaseClaims(f.projectId,'handled-conflict');
 if(status==='completed'){f.runtime.journal.markDispatch(sent.run.id,step.id);f.runtime.journal.completeStep(sent.run.id,step.id,{result:{handled:true}});const current=f.runtime.journal.step(step.id);f.runtime.journal.updateStep(sent.run.id,step.id,{data:{...object(current.data),backgroundInvalidated:false}});}
 else f.runtime.journal.updateStep(sent.run.id,step.id,{status,result:{handled:true}});
 const resumed=f.runtime.journal.resume(sent.run.id,f.runtime.journal.run(sent.run.id).revision);f.runtime.journal.transition(sent.run.id,resumed.revision,'paused','user');f.restart();
 await f.action(f.runtime.get(f.projectId,sent.run.id),'resume');const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.effects.size,(0)+f.loadingEffects);assert.equal(f.requests.length,(2)+f.loadingRequests);assert.deepEqual(done.run.skippedTargets,[]);
});
for(const protocol of ['chat_completions','responses'] as const)for(const kind of ['model','tool'] as const)test(`${protocol}: interrupted conflict selection still requires unknown ${kind} result disposition first`,async t=>{
 const f=await fixture(t,protocol),target={kind:'shot',id:f.first.id,revision:f.runtime.journal.targetRevision(f.projectId,'shot',f.first.id)};f.runtime.journal.claim({projectId:f.projectId,ownerId:'unknown-conflict',targets:[target]});
 f.setScript(async function*(index){yield {type:'done',output:output(protocol,index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'unknown old parameters'}})]:[])};},{loadGroups:['canvas']});
 const sent=await f.send(),paused=await f.settle(sent.run.id);f.runtime.journal.resume(sent.run.id,paused.run.revision);const uncertain=f.runtime.journal.beginStep(sent.run.id,{kind,...(kind==='tool'?{toolCall:call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'unknown tool must not run'}})}:{})});f.runtime.journal.markDispatch(sent.run.id,uncertain.id);f.runtime.journal.transition(sent.run.id,f.runtime.journal.run(sent.run.id).revision,'paused','editing');f.restart();
 const interrupted=f.runtime.get(f.projectId,sent.run.id),before=f.runtime.journal.snapshot(sent.run.id);await assert.rejects(f.action(interrupted,'resume'),{code:'AGENT_TASK_UNKNOWN_RESULT'});assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),before);assert.equal(f.effects.size,(0)+f.loadingEffects);assert.equal(f.requests.length,(1)+f.loadingRequests);
 const disposed=await f.action(interrupted,'resolve_unknown',{stepId:uncertain.id,resolution:'discard'}),selected=await f.action(disposed,'resume');assert.equal(selected.run.status,'paused');assert.equal(selected.run.pauseReason,'editing');assert.equal(f.effects.size,(0)+f.loadingEffects);assert.equal(f.requests.length,(1)+f.loadingRequests);
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: interrupted conflict recovery preserves an exhausted budget until separate continuation`,async t=>{
 const f=await fixture(t,protocol),target={kind:'shot',id:f.first.id,revision:f.runtime.journal.targetRevision(f.projectId,'shot',f.first.id)};f.runtime.journal.updatePolicy({...f.runtime.policy(),stepLimit:4});f.runtime.journal.claim({projectId:f.projectId,ownerId:'budget-conflict',targets:[target]});
 f.setScript(async function*(index){yield {type:'done',output:output(protocol,index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'no budget for old parameters'}})]:[])};},{loadGroups:['canvas']});
 const sent=await f.send(),paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,'editing');assert.equal(paused.run.stepsUsed,2+f.loadingSteps(paused));assert.equal(paused.run.budget,4);f.runtime.journal.releaseClaims(f.projectId,'budget-conflict');f.restart();
 const selected=await f.action(f.runtime.get(f.projectId,sent.run.id),'resume');assert.equal(selected.run.status,'paused');assert.equal(selected.run.pauseReason,'editing');assert.equal(selected.run.budget,4);assert.equal(f.requests.length,(1)+f.loadingRequests);assert.equal(f.effects.size,(0)+f.loadingEffects);
 await f.action(selected,'skip');const budget=await f.settle(sent.run.id);assert.equal(budget.run.status,'paused');assert.equal(budget.run.pauseReason,'budget');assert.equal(budget.run.budget,4);assert.equal(budget.run.skippedTargets?.[0]?.target.id,f.first.id);assert.equal(f.requests.length,(1)+f.loadingRequests);assert.equal(f.effects.size,(0)+f.loadingEffects);
 await f.action(budget,'resume');const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.run.budget,8);assert.equal(f.requests.length,(2)+f.loadingRequests);assert.equal(f.effects.size,(0)+f.loadingEffects);assert.equal(object(f.store.get('shots',f.first.id)).prompt,f.first.prompt);
});
test('interrupted conflict recovery and its control receipt roll back together on storage failure',async t=>{
 const f=await fixture(t),target={kind:'shot',id:f.first.id,revision:f.runtime.journal.targetRevision(f.projectId,'shot',f.first.id)};f.runtime.journal.claim({projectId:f.projectId,ownerId:'atomic-conflict',targets:[target]});f.setScript(async function*(){yield {type:'done',output:output('responses',[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'never commits'}})])};},{loadGroups:['canvas']});
 const sent=await f.send();await f.settle(sent.run.id);f.restart();const interrupted=f.runtime.get(f.projectId,sent.run.id),request={requestId:randomUUID(),expectedRevision:interrupted.run.revision,action:'resume'},before=f.runtime.journal.snapshot(sent.run.id),events=f.runtime.journal.events(sent.run.id);
 f.store.db.exec(`CREATE TRIGGER fail_conflict_recovery_receipt BEFORE INSERT ON agent_task_controls_v2 WHEN NEW.requestId='${request.requestId}' BEGIN SELECT RAISE(ABORT,'synthetic conflict recovery receipt failure');END;`);
 await assert.rejects(f.runtime.action(f.projectId,sent.run.id,request),{code:'AGENT_TASK_STORAGE_UNAVAILABLE'});assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),before);assert.deepEqual(f.runtime.journal.events(sent.run.id),events);assert.equal(f.runtime.journal.lookupControl(request.requestId),null);assert.equal(f.requests.length,(1)+f.loadingRequests);assert.equal(f.effects.size,(0)+f.loadingEffects);
});
test('conflict invalidates the whole old tool batch including a not yet created third call',async t=>{
 const f=await fixture(t),target={kind:'shot',id:f.first.id,revision:f.runtime.journal.targetRevision(f.projectId,'shot',f.first.id)},ownerId=randomUUID();
 f.runtime.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId,generation:1,sequence:1,action:'claim',targets:[target]});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_project_inspect'),call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'stale call two'}}),call('mioon_shot_update',{shotId:f.other.id,expectedRevision:1,patch:{prompt:'stale call three'}})]:[])};},{loadGroups:['canvas']});
 const sent=await f.send(),paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,'editing');assert.equal(f.effects.size,(1)+f.loadingEffects);assert.equal(paused.steps.filter(step=>step.kind==='tool').length,2+paused.steps.filter(step=>step.toolCall?.name===AGENT_TASK_TOOLS_LOAD_NAME).length);
 f.runtime.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId,generation:1,sequence:2,action:'release',targets:[target]});await f.action(paused,'skip');const done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(f.effects.size,(1)+f.loadingEffects);assert.equal(f.requests.length,(2)+f.loadingRequests);assert.equal(object(f.store.get('shots',f.other.id)).prompt,'saved other');assert.match(f.scriptRequest(2)!.body,/TARGET_CHANGED/);
});
test('budget pauses retain pending tool calls without invalidating or repeating the batch',async t=>{
 const f=await fixture(t);f.runtime.journal.updatePolicy({...f.runtime.policy(),stepLimit:2});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?Array.from({length:3},()=>call('mioon_project_inspect')):[])};});
 const sent=await f.send();let paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,'budget');assert.equal(f.effects.size,1);await f.action(paused,'resume');paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,'budget');assert.equal(f.effects.size,3);assert.equal(f.requests.length,1);
 await f.action(paused,'resume');const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.run.stepsUsed,5);assert.equal(done.run.budget,6);assert.equal(f.effects.size,3);assert.equal(f.requests.length,2);
});
test('pause and stop during model wait block subsequent tools and requests',async t=>{for(const action of ['pause','stop'] as const){const f=await fixture(t),entered=gate(),release=gate();f.setScript(async function*(){entered.resolve();await release.promise;yield {type:'done',output:output('responses',[call('mioon_project_inspect')])};});const sent=await f.send();await entered.promise;await f.action(f.runtime.get(f.projectId,sent.run.id),action);release.resolve();const done=await f.settle(sent.run.id);assert.equal(done.run.status,action==='pause'?'paused':'stopped');assert.equal(f.effects.size,0);assert.equal(f.requests.length,1);}});
test('restart retains a model unknown result without dispatching until explicit disposition',async t=>{const f=await fixture(t),entered=gate(),release=gate();f.setScript(async function*(){entered.resolve();await release.promise;yield {type:'done',output:output('responses')};});const sent=await f.send();await entered.promise;f.restart();const restored=f.runtime.get(f.projectId,sent.run.id);assert.equal(restored.run.status,'interrupted');assert.equal(restored.steps[0]?.status,'unknown');assert.equal(f.requests.length,1);await assert.rejects(f.action(restored,'resume'),{code:'AGENT_TASK_UNKNOWN_RESULT'});release.resolve();const disposed=await f.action(restored,'resolve_unknown',{stepId:restored.steps[0]?.id,resolution:'discard'});await f.action(disposed,'resume');const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.requests.length,2);assert.equal(done.steps[0]?.status,'failed');});
test('whole task undo changes only AI targets and preserves manual edits elsewhere',async t=>{const f=await fixture(t);f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:f.first.revision,patch:{prompt:'AI edit'}})]:[])};},{loadGroups:['canvas']});const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.changes.length,1);await f.services.call('shot.update',{shotId:f.other.id,expectedRevision:f.other.revision,patch:{prompt:'manual stays'}});const undone=await f.action(done,'undo_all');assert.equal(undone.run.status,'reverted');assert.equal(object(f.store.get('shots',String(f.first.id))).prompt,'saved first');assert.equal(object(f.store.get('shots',String(f.other.id))).prompt,'manual stays');assert.equal(f.requests.length,(2)+f.loadingRequests);});
test('whole undo retains the generated shot owner while reverting earlier edits and preserving products across restart and replay',async t=>{
 const providers=new Map<string,Provider>(),f=await fixture(t,'responses',providers);providers.set('mock',mockProviderAdapter(createMockProvider({db:f.store.db,root:f.root})));
 const timeline=object(await f.services.call('timeline.get',{projectId:f.projectId}));assert.ok(Array.isArray(timeline.tracks));const trackId=textField(timeline.tracks[0],'id');
 f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,local_irreversible:'direct',paid:'direct'},acknowledgePaid:true});
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
 },{loadGroups:['canvas','editing','exports','video']});
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
 assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),stable);assert.deepEqual(f.runtime.journal.events(sent.run.id),events);assert.equal(f.requests.length,(8)+f.loadingRequests);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM mock_provider_submissions').get()?.n,1);
});
for(const started of [false,true])test(`retained shot ${started?'keeps a late product without selecting it':'cancels its queued work on whole undo'} and never dispatches after reversion`,async t=>{
 const providers=new Map<string,Provider>(),f=await fixture(t,'responses',providers),entered=gate(),release=gate();let posts=0,downloads=0;
 const mock=mockProviderAdapter(createMockProvider({db:f.store.db,root:f.root}));providers.set('mock',{...mock,async submit(snapshot,context){posts++;return mock.submit(snapshot,context);},async download(id,destination,context){downloads++;entered.resolve();await release.promise;return mock.download(id,destination,context);}});
 f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,local_irreversible:'direct',paid:'direct'},acknowledgePaid:true});
 f.setScript(async function*(index){let next:AgentTaskToolCall[]=[];if(index===1)next=[call('mioon_shot_create',{title:'Pending generated owner',duration:2})];if(index===2){const shot=object(f.store.list('shots',f.projectId).find(value=>object(value).title==='Pending generated owner'));next=[call('mioon_generation_submit',{shotId:textField(shot,'id'),expectedRevision:revisionField(shot),providerId:'mock',model:'mock-motion-v1',parameters:{delayMs:0}})];}yield {type:'done',output:output('responses',next)};},{loadGroups:['canvas','video']});
 const sent=await f.send(),completed=await f.settle(sent.run.id);assert.equal(completed.run.status,'completed');assert.equal(completed.backgroundPending,true);
 let worker:ReturnType<typeof startWorker>|undefined;
 try{
  if(started){worker=startWorker(f.store,f.services,providers);await Promise.race([entered.promise,delay(10000,undefined,{ref:false}).then(()=>{throw Error('Synthetic download barrier not reached');})]);}
  const current=f.runtime.get(f.projectId,sent.run.id),creation=current.changes.find(change=>change.operation==='shot.create')!;
  const single={requestId:randomUUID(),expectedRevision:current.run.revision,action:'undo_change',changeId:creation.id};await f.runtime.action(f.projectId,sent.run.id,single);
  const retained=f.runtime.get(f.projectId,sent.run.id);assert.equal(retained.run.status,'completed');assert.equal(retained.changes.find(change=>change.id===creation.id)?.reversible,false);assert.deepEqual(f.runtime.journal.lookupControl(single.requestId)?.result,{state:'completed',retainedChangeIds:[creation.id]});
  const undone=await f.action(retained,'undo_all');assert.equal(undone.run.status,'reverted');release.resolve();worker??=startWorker(f.store,f.services,providers);await worker.tick();await worker.tick();
  assert.equal(posts,started?1:0);assert.equal(downloads,started?1:0);assert.equal(f.requests.length,(3)+f.loadingRequests);assert.equal(f.runtime.get(f.projectId,sent.run.id).run.status,'reverted');
  const shot=object(f.store.list('shots',f.projectId).find(value=>object(value).title==='Pending generated owner'));assert.equal(shot.selectedVersionId,null);
  const job=object(f.store.list('jobs',f.projectId)[0]);assert.equal(job.status,started?'succeeded':'cancelled');assert.equal(f.store.list('jobs',f.projectId).length,1);assert.equal(f.store.list('versions',f.projectId).length,started?1:0);assert.equal(f.store.list('assets',f.projectId).length,started?1:0);
  const timeline=await f.services.call('timeline.inspect',{projectId:f.projectId}),saved=timeline===null?null:object(timeline);assert.ok(saved===null||saved.clips===undefined||Array.isArray(saved.clips)&&saved.clips.length===0);
 }finally{release.resolve();await worker?.stop();}
});
test('retention survives an unknown control finish without repeating metadata or dispatch after restart',async t=>{
 let posts=0;const provider:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},async submit(){posts++;throw Error('No new dispatch is permitted');},async reconcile(){return null;},async poll(){return {status:'running'};},async download(){throw Error('No output requested');}};
 const providers=new Map([['mock',provider]]),f=await fixture(t,'responses',providers);f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'direct'},acknowledgePaid:true});
 f.setScript(async function*(index){let next:AgentTaskToolCall[]=[];if(index===1)next=[call('mioon_project_rename',{expectedRevision:1,name:'Reversible earlier rename'})];if(index===2)next=[call('mioon_shot_create',{title:'Owner retained across interruption',duration:2})];if(index===3){const shot=object(f.store.list('shots',f.projectId).find(value=>object(value).title==='Owner retained across interruption'));next=[call('mioon_generation_submit',{shotId:textField(shot,'id'),expectedRevision:revisionField(shot),providerId:'mock',model:'mock-motion-v1'})];}yield {type:'done',output:output('responses',next)};},{loadGroups:['canvas','video']});
 const sent=await f.send(),done=await f.settle(sent.run.id),creation=done.changes.find(change=>change.operation==='shot.create')!,control={requestId:randomUUID(),expectedRevision:done.run.revision,action:'undo_all'};
 f.store.db.exec(`CREATE TRIGGER test_retention_control_finish BEFORE INSERT ON agent_task_control_states_v2 WHEN NEW.requestId='${control.requestId}' AND json_extract(NEW.data,'$.result.state')='completed' BEGIN SELECT RAISE(ABORT,'synthetic lost control finish');END;`);
 await assert.rejects(f.runtime.action(f.projectId,sent.run.id,control),{code:'AGENT_TASK_STORAGE_UNAVAILABLE'});
 const interrupted=f.runtime.journal.snapshot(sent.run.id);assert.equal(interrupted.run.status,'reverted');assert.equal(interrupted.changes.find(change=>change.id===creation.id)?.reversible,false);assert.equal(object(f.runtime.journal.lookupControl(control.requestId)?.result).state,'pending');
 f.restart();const recovered=f.runtime.journal.snapshot(sent.run.id),events=f.runtime.journal.events(sent.run.id);assert.deepEqual(recovered,interrupted);assert.equal(object(f.runtime.journal.lookupControl(control.requestId)?.result).state,'blocked');
 await f.runtime.action(f.projectId,sent.run.id,control);assert.deepEqual(f.runtime.journal.events(sent.run.id),events);assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),recovered);
 const worker=startWorker(f.store,f.services,providers);try{await worker.tick();await worker.tick();assert.equal(posts,0);assert.equal(f.requests.length,(4)+f.loadingRequests);assert.equal(f.runtime.get(f.projectId,sent.run.id).run.status,'reverted');assert.equal(f.store.list('versions',f.projectId).length,0);assert.equal(f.store.list('assets',f.projectId).length,0);}finally{await worker.stop();}
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
 f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:4,modes:{...f.runtime.policy().modes,local_irreversible:'direct'}});
 f.setScript(async function*(){yield {type:'done',output:output('responses',[call('mioon_timeline_render',{expectedRevision:2,purpose:'export'})])};},{loadGroups:['exports']});
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
  assert.deepEqual(f.runtime.get(f.projectId,sent.run.id),paused);assert.equal(f.requests.length,(1)+f.loadingRequests);assert.equal(f.effects.size,(1)+f.loadingEffects);
  assert.equal(f.store.list('assets',f.projectId).length,1);assert.equal(f.store.list('assets',otherId).length,reason==='audit_failure'?1:2);
  assert.equal(f.store.list('exports',f.projectId).length,1);assert.equal(f.store.list('exports',otherId).length,1);
  const replay=await f.send('执行测试',sent.run.requestId);assert.equal(replay.run.id,sent.run.id);await worker.tick();assert.equal(f.requests.length,(1)+f.loadingRequests);
  assert.equal(f.store.list('exports',f.projectId).length,1);assert.equal(f.store.list('exports',otherId).length,1);
 }finally{await worker.stop();}
});
test('read rejection and local approval each respect their independent configured tier',async t=>{for(const tier of ['read_only','local_reversible'] as const){const f=await fixture(t);f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,[tier]:'confirm'}});f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[tier==='read_only'?call('mioon_project_inspect'):call('mioon_shot_update',{shotId:f.first.id,expectedRevision:f.first.revision,patch:{prompt:'approved local'}})]:[])};},{loadGroups:tier==='read_only'?[]:['canvas']});const sent=await f.send(),waiting=await f.wait(sent.run.id,['awaiting_approval']);await f.runtime.drain();const step=waiting.steps.find(item=>item.status==='awaiting_approval');assert.ok(step);await f.action(waiting,tier==='read_only'?'deny':'approve',{stepId:step.id});const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.effects.size,(tier==='read_only'?0:1)+f.loadingEffects);assert.equal(object(f.store.get('shots',f.first.id)).prompt,tier==='read_only'?'saved first':'approved local');}});
test('all legacy grants remain insufficient for project_agent before any model request',async t=>{const f=await fixture(t);await f.revoke();for(const scope of ['typed_chat_only','project_inspection','selected_shot_edit','selected_timeline_clip_move','selected_timeline_clip_gain'])await authorizeTestScope(f.authorizations,scope);await assert.rejects(f.send(),{code:'AGENT_TASK_CONSENT_REQUIRED'});assert.equal(f.requests.length,0);assert.equal(f.effects.size,0);});
test('restart interrupts a completed model run with a queued bound job before the worker can submit',async t=>{
 let posts=0;
 const provider:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},
  async submit(_snapshot,context){context.beforeSubmit?.();posts++;return {providerJobId:'synthetic-no-network'};},async reconcile(){return null;},async poll(){return {status:'running'};},async download(){throw Error('No output requested');}};
 const providers=new Map([['mock',provider]]),f=await fixture(t,'responses',providers);
 f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'direct'},acknowledgePaid:true});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_generation_submit',{shotId:f.first.id,expectedRevision:1,providerId:'mock',model:'mock-motion-v1'})]:[])};},{loadGroups:['video']});
 const sent=await f.send(),completed=await f.settle(sent.run.id);assert.equal(completed.run.status,'completed');assert.equal(f.requests.length,(2)+f.loadingRequests);assert.equal(object(f.store.list('jobs',f.projectId)[0]).status,'queued');
 assert.equal(completed.backgroundPending,true);assert.equal(f.runtime.journal.hasPendingBackground(sent.run.id),true);
 f.restart();assert.equal(f.runtime.get(f.projectId,sent.run.id).run.status,'interrupted');assert.equal(f.requests.length,(2)+f.loadingRequests);
 const worker=startWorker(f.store,f.services,providers);try{await worker.tick();await worker.tick();assert.equal(posts,0);assert.equal(f.requests.length,(2)+f.loadingRequests);assert.equal(f.runtime.get(f.projectId,sent.run.id).run.status,'interrupted');}finally{await worker.stop();}
});
for(const action of ['pause','stop','finish_result'] as const)test(`completed model with a queued bound job supports ${action} and keeps live background evidence`,async t=>{
 let posts=0;const provider:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},
  async submit(_snapshot,context){context.beforeSubmit?.();posts++;return {providerJobId:'synthetic-no-network'};},async reconcile(){return null;},async poll(){return {status:'running'};},async download(){throw Error('No output requested');}};
 const providers=new Map([['mock',provider]]),f=await fixture(t,'responses',providers);f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'direct'},acknowledgePaid:true});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_generation_submit',{shotId:f.first.id,expectedRevision:1,providerId:'mock',model:'mock-motion-v1'})]:[])};},{loadGroups:['video']});
 const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.backgroundPending,true);
 if(action==='finish_result'){
  const job=f.store.list('jobs',f.projectId)[0] as JobRecord;withAgentTaskJobOrigin(f.store.db,'job',job.id,()=>f.services.saveJob(job,{status:'succeeded',phase:'complete',progress:100,error:null}));
  const finished=f.runtime.get(f.projectId,sent.run.id);assert.equal(finished.backgroundPending,false);assert.equal(f.runtime.journal.hasPendingBackground(sent.run.id),false);assert.equal(finished.run.status,'completed');assert.ok(finished.changes.length>done.changes.length);assert.equal(f.requests.length,(2)+f.loadingRequests);
  assert.throws(()=>f.runtime.journal.transition(sent.run.id,finished.run.revision,'paused'),{code:'AGENT_TASK_STATE_CONFLICT'});
 }else{
  const controlled=await f.action(done,action);assert.equal(controlled.run.status,action==='pause'?'paused':'stopped');assert.equal(controlled.backgroundPending,action==='pause');if(action==='stop')assert.equal(object(f.store.list('jobs',f.projectId)[0]).status,'cancelled');
  const worker=startWorker(f.store,f.services,providers);try{await worker.tick();await worker.tick();assert.equal(posts,0);assert.equal(f.requests.length,(2)+f.loadingRequests);}finally{await worker.stop();}
 }
});
test('an unknown paid submission that was never accepted can be marked failed and replanned without resubmitting',async t=>{
 // With no provider registered the acceptance transaction rejects the submission and rolls back, but the error
 // carries no not-applied proof, so the dispatched step is recorded as unknown.
 const f=await fixture(t);f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'direct'},acknowledgePaid:true});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_generation_submit',{shotId:f.first.id,expectedRevision:1,providerId:'mock',model:'mock-motion-v1'})]:[])};},{loadGroups:['video']});
 const sent=await f.send(),paused=await f.settle(sent.run.id),step=paused.steps.find(item=>item.toolCall?.name==='mioon_generation_submit');assert.ok(step);
 assert.equal(paused.run.pauseReason,'unknown_outcome');assert.equal(step.status,'unknown');assert.equal(f.store.list('jobs',f.projectId).length,0);
 await assert.rejects(f.action(paused,'resume'),{code:'AGENT_TASK_UNKNOWN_RESULT'});
 const marked=await f.action(paused,'resolve_unknown',{stepId:step.id,resolution:'discard'});assert.equal(marked.steps.find(item=>item.id===step.id)?.status,'failed');
 await f.action(marked,'resume');const done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(f.requests.length,(2)+f.loadingRequests);assert.match(f.scriptRequest(2)!.body,/UNKNOWN_NOT_APPLIED/);assert.equal(f.store.list('jobs',f.projectId).length,0);assert.equal(f.effects.size,(1)+f.loadingEffects);
});
for(const stepLimit of [5,30])for(const action of ['approve','deny'] as const)test(`paid direct disabled after acceptance supports one-time ${action} of the original queued job at budget ${stepLimit}`,async t=>{
 let posts=0;const provider:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},
  async submit(_snapshot,context){context.beforeSubmit?.();posts++;return {providerJobId:'synthetic-approved-once'};},async reconcile(){return null;},async poll(){return {status:'running'};},async download(){throw Error('No output requested');}};
 const providers=new Map([['mock',provider]]),f=await fixture(t,'responses',providers);f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit,modes:{...f.runtime.policy().modes,paid:'direct'},acknowledgePaid:true});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_generation_submit',{shotId:f.first.id,expectedRevision:1,providerId:'mock',model:'mock-motion-v1'})]:[])};},{loadGroups:['video']});
 const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.run.stepsUsed,3+f.loadingSteps(done));assert.equal(done.run.budget,stepLimit);const job=object(f.store.list('jobs',f.projectId)[0]),jobId=String(job.id),originalStep=done.steps.find(step=>step.toolCall?.name==='mioon_generation_submit');assert.ok(originalStep);
 f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'confirm'}});
 const worker=startWorker(f.store,f.services,providers);try{
  await worker.tick();const waiting=f.runtime.get(f.projectId,sent.run.id);assert.equal(waiting.run.status,'awaiting_approval');assert.equal(waiting.steps.find(step=>step.id===originalStep.id)?.approvalRequired,true);assert.equal(posts,0);assert.equal(f.store.list('jobs',f.projectId).length,1);
  const request={requestId:randomUUID(),expectedRevision:waiting.run.revision,action,stepId:originalStep.id};await f.runtime.action(f.projectId,sent.run.id,request);await f.runtime.action(f.projectId,sent.run.id,request);await f.runtime.drain();await worker.tick();await worker.tick();
  assert.equal(posts,action==='approve'?1:0);assert.equal(f.store.list('jobs',f.projectId).length,1);assert.equal(String(object(f.store.list('jobs',f.projectId)[0]).id),jobId);assert.equal(f.requests.length,(2)+f.loadingRequests);assert.equal(f.runtime.policy().modes.paid,'confirm');assert.equal(Boolean(f.runtime.get(f.projectId,sent.run.id).steps.find(step=>step.id===originalStep.id)?.approvalRequired),false);if(action==='deny')assert.equal(object(f.store.get('jobs',jobId)).status,'cancelled');
  const controlled=f.runtime.get(f.projectId,sent.run.id);assert.equal(controlled.run.status,'completed');assert.equal(controlled.run.stepsUsed,3+f.loadingSteps(controlled));assert.equal(controlled.run.stepLimit,stepLimit);assert.equal(controlled.run.budget,stepLimit);assert.deepEqual(controlled.steps.map(step=>step.id),done.steps.map(step=>step.id));
 }finally{await worker.stop();}
});
for(const protocol of ['chat_completions','responses'] as const)for(const recovery of ['none','preserved','legacy'] as const)test(`${protocol}: ${recovery} background conflict recovery cannot cross an ABA before submit; skip cancels the old job and replans once`,async t=>{
 const entered=gate(),release=gate();let posts=0;
 const provider:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},
  async submit(_snapshot,context){entered.resolve();await release.promise;context.beforeSubmit?.();posts++;return {providerJobId:'synthetic-must-not-send'};},async reconcile(){return null;},async poll(){return {status:'running'};},async download(){throw Error('No output requested');}};
 const providers=new Map([['mock',provider]]),f=await fixture(t,protocol,providers);f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'direct'},acknowledgePaid:true});
 f.setScript(async function*(index){yield {type:'done',output:output(protocol,index===1?[call('mioon_generation_submit',{shotId:f.first.id,expectedRevision:1,providerId:'mock',model:'mock-motion-v1'})]:[])};},{loadGroups:['video']});
 const sent=await f.send();await f.settle(sent.run.id);const jobId=String(object(f.store.list('jobs',f.projectId)[0]).id);
 f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'confirm'}});
 const worker=startWorker(f.store,f.services,providers);try{
  await worker.tick();const waiting=f.runtime.get(f.projectId,sent.run.id),step=waiting.steps.find(item=>item.approvalRequired);assert.ok(step);await f.action(waiting,'approve',{stepId:step.id});await Promise.race([entered.promise,delay(10000,undefined,{ref:false}).then(()=>{throw Error('Synthetic provider did not reach before-submit barrier');})]);
  await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'manual after approval'}});await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:2,patch:{prompt:f.first.prompt}});release.resolve();
  await worker.tick();let paused=await f.wait(sent.run.id,['paused']);assert.equal(paused.run.pauseReason,'conflict');assert.equal(posts,0);assert.equal(f.requests.length,(2)+f.loadingRequests);assert.equal(object(f.store.get('jobs',jobId)).status,'queued');const marked=paused.steps.find(item=>item.id===step.id);assert.equal(marked?.status,'completed');assert.equal(marked?.display?.conflict,true);assert.equal(marked?.data,undefined);assert.equal(f.runtime.journal.step(step.id).display,undefined);
  if(recovery!=='none'){
   f.restart();let interrupted=f.runtime.get(f.projectId,sent.run.id);assert.equal(interrupted.run.status,'interrupted');
   if(recovery==='legacy'){const saved=f.runtime.journal.run(sent.run.id);f.store.db.prepare('UPDATE agent_task_runs_v2 SET data=? WHERE id=?').run(JSON.stringify({...saved,pauseReason:'restart'}),sent.run.id);interrupted=f.runtime.get(f.projectId,sent.run.id);}
   let wakeups=0;const removeResumer=setAgentTaskJobResumer(f.store.db,'synthetic-background-conflict-resume',()=>{wakeups++;});t.after(removeResumer);
   await worker.tick();assert.equal(posts,0);assert.equal(f.requests.length,(2)+f.loadingRequests);
   const control={requestId:randomUUID(),expectedRevision:interrupted.run.revision,action:'resume'};paused=await f.runtime.action(f.projectId,sent.run.id,control);await f.runtime.drain();assert.equal(paused.run.status,'paused');assert.equal(paused.run.pauseReason,'conflict');assert.equal(paused.run.budget,interrupted.run.budget);assert.equal(wakeups,0);assert.equal(f.requests.length,(2)+f.loadingRequests);assert.equal(posts,0);
   const stable=f.runtime.journal.snapshot(sent.run.id),events=f.runtime.journal.events(sent.run.id);await f.runtime.action(f.projectId,sent.run.id,control);assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),stable);assert.deepEqual(f.runtime.journal.events(sent.run.id),events);assert.equal(wakeups,0);await worker.tick();assert.equal(posts,0);assert.equal(object(f.store.get('jobs',jobId)).status,'queued');
  }
  await f.action(paused,'skip');const replanned=await f.settle(sent.run.id);assert.equal(replanned.run.status,'completed');assert.equal(replanned.backgroundPending,false);assert.ok(replanned.steps.every(item=>item.display?.conflict===undefined));assert.equal(f.requests.length,(3)+f.loadingRequests);assert.equal(object(f.store.get('jobs',jobId)).status,'cancelled');assert.equal(f.store.list('jobs',f.projectId).length,1);await worker.tick();assert.equal(posts,0);
 }finally{release.resolve();await worker.stop();}
});
for(const externalAba of [false,true])test(`persisted compensation chain ${externalAba?'cannot cross an external ABA':'continues adjacent AI changes after restart'}`,async t=>{
 const f=await fixture(t);let insertedAba=false;
 f.setScript(async function*(index){
  if(index===2&&externalAba){await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:2,patch:{prompt:'manual intervening'}});await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:3,patch:{prompt:'AI first'}});insertedAba=true;}
  const expectedRevision=index===1?1:externalAba?4:2;
  const calls=index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision,patch:{prompt:'AI first'}})]:index===2||externalAba&&index===3?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision,patch:{prompt:'AI second'}})]:[];
  yield {type:'done',output:output('responses',calls)};
 },{loadGroups:['canvas']});
 const sent=await f.send();let done=await f.settle(sent.run.id);
 if(externalAba){assert.equal(done.run.status,'paused');assert.equal(done.run.pauseReason,'conflict');assert.equal(insertedAba,true);await f.action(done,'skip');done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.changes.length,1);assert.equal(object(f.store.get('shots',f.first.id)).prompt,'AI first');await assert.rejects(f.action(done,'undo_all'),{code:'AGENT_TASK_TARGET_CHANGED'});return;}
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
 const request=f.requests[1]!,names=(object(JSON.parse(request.body)).tools as Record<string,unknown>[]).map(tool=>String(tool.name));assert.doesNotMatch(request.body,/DIAGNOSTIC_PRIVATE_CONTEXT|DIAGNOSTIC_PROMPT/u);assert.deepEqual(names,f.tools.list().filter(tool=>agentTaskToolNamesForGroup('core').includes(tool.name)).map(tool=>tool.name));assert.equal(f.runtime.get(f.projectId,normal.run.id).run.diagnostic,undefined);assert.equal(f.runtime.history(f.projectId).conversations.length,1);assert.equal(f.runtime.history(f.projectId).conversations[0]?.lastRunId,normal.run.id);assert.equal((await f.runtime.snapshot(f.projectId)).runs.length,1);assert.throws(()=>f.runtime.conversation(f.projectId,sent.run.conversationId!),{code:'AGENT_TASK_NOT_FOUND'});
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

for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: conversations bind prior context, exclude other conversations and retain exact request identity`,async t=>{
 const f=await fixture(t,protocol);f.setScript(async function*(index){yield {type:'done',output:output(protocol,[],`reply ${index}`)};});
 const settings=await f.settings.get(),send=(text:string,conversationId?:string,requestId:string=randomUUID())=>f.runtime.send(f.projectId,{requestId,text,expectedSettingsRevision:settings.revision,...(conversationId?{conversationId}:{})});
 const first=await send('conversation A first');await f.settle(first.run.id);assert.ok(first.run.conversationId);assert.notEqual(first.run.conversationId,first.run.id);
 const other=await send('conversation B private');await f.settle(other.run.id);assert.notEqual(other.run.conversationId,first.run.conversationId);
 const requestId=randomUUID(),next=await send('conversation A next',first.run.conversationId,requestId);await f.settle(next.run.id);
 const retained=f.runtime.journal.run(next.run.id).context!;assert.ok(JSON.stringify(retained).includes('conversation A first'));assert.doesNotMatch(JSON.stringify(retained),/conversation B private|reply 2/u);
 assert.equal((await send('conversation A next',first.run.conversationId,requestId)).run.id,next.run.id);
 await assert.rejects(send('conversation A next',undefined,requestId),{code:'AGENT_TASK_REQUEST_CONFLICT'});
 await assert.rejects(send('conversation A first',first.run.conversationId,first.run.requestId),{code:'AGENT_TASK_REQUEST_CONFLICT'});
 const before=f.requests.length;await assert.rejects(send('missing',randomUUID()),{code:'AGENT_TASK_NOT_FOUND'});assert.equal(f.requests.length,before);
 await assert.rejects(f.runtime.send(f.projectId,{requestId:randomUUID(),text:'diagnostic cannot join',expectedSettingsRevision:settings.revision,conversationId:first.run.conversationId,diagnostic:{profile:'text'}}),{code:'AGENT_TASK_INVALID'});
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
  f.runtime.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId,generation:1,sequence:1,action:'claim',targets:[target]});
  f.setScript(async function*(index){yield {type:'done',output:output(protocol,index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'blocked initial'}}),call('mioon_version_list',{shotId:f.first.id})]:index===2?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'blocked again'}}),call('mioon_version_list',{shotId:f.first.id}),call('mioon_shot_update',{shotId:f.other.id,expectedRevision:1,patch:{prompt:'other allowed'}}),call('mioon_project_inspect')]:[])};},{loadGroups:['canvas']});
  const sent=await f.send(),paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,'editing');
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
  const next=await f.runtime.send(f.projectId,{requestId:randomUUID(),text:'same conversation next round',conversationId:done.run.conversationId,expectedSettingsRevision:(await f.settings.get()).revision});assert.equal((await f.settle(next.run.id)).run.status,'completed');assert.match(f.requests[2]!.body,/KEEP_THIS_ADDITIONAL_INSTRUCTION/);
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
test('a final response note at exhausted budget stays pending until explicit continuation of the same run',async t=>{
 const f=await fixture(t),entered=gate(),release=gate();f.runtime.journal.updatePolicy({...f.runtime.policy(),stepLimit:1});f.setScript(async function*(index){if(index===1){entered.resolve();await release.promise;}yield {type:'done',output:output('responses')};});
 const sent=await f.send();await entered.promise;await f.action(f.runtime.get(f.projectId,sent.run.id),'note',{text:'pending across budget'});release.resolve();const paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,'budget');assert.equal(paused.run.notes?.[0]?.modelStepId,undefined);assert.equal(f.requests.length,1);
 await f.action(paused,'resume');const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.run.budget,2);assert.equal(done.run.stepsUsed,2);assert.match(f.requests[1]!.body,/pending across budget/);assert.ok(done.run.notes?.[0]?.modelStepId);
});
test('failed model intent rolls back note binding and cannot submit its request',async t=>{
 const f=await fixture(t),entered=gate(),release=gate();f.setScript(async function*(){entered.resolve();await release.promise;yield {type:'done',output:output('responses')};});const sent=await f.send();await entered.promise;await f.action(f.runtime.get(f.projectId,sent.run.id),'note',{text:'must remain queued'});
 f.store.db.exec("CREATE TRIGGER fail_note_model_intent BEFORE INSERT ON agent_task_steps_v2 WHEN NEW.position=2 BEGIN SELECT RAISE(ABORT,'synthetic note intent failure');END;");release.resolve();const done=await f.settle(sent.run.id);assert.equal(f.requests.length,1);assert.equal(done.steps.length,1);assert.equal(done.run.notes?.[0]?.modelStepId,undefined);assert.ok(done.run.status!=='completed');assert.equal(done.run.stepsUsed,1);
});
test('stopping a conflict never adds skipped targets or releases a user draft',async t=>{
 const f=await fixture(t),target={kind:'shot',id:f.first.id,revision:f.runtime.journal.targetRevision(f.projectId,'shot',f.first.id)},ownerId=randomUUID();f.runtime.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId,generation:1,sequence:1,action:'claim',targets:[target]});f.setScript(async function*(){yield {type:'done',output:output('responses',[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'never'}})])};},{loadGroups:['canvas']});const sent=await f.send(),paused=await f.settle(sent.run.id),stopped=await f.action(paused,'stop');assert.equal(stopped.run.status,'stopped');assert.deepEqual(stopped.run.skippedTargets,[]);assert.equal(f.runtime.journal.claims(f.projectId).length,1);assert.equal(f.effects.size,1);assert.equal(f.loadingEffects,1);assert.equal(f.requests.length,2);
});

test('a multi-target conflict skips only the claimed target, and another target can still be changed',async t=>{
 const f=await fixture(t),target={kind:'shot',id:f.first.id,revision:f.runtime.journal.targetRevision(f.projectId,'shot',f.first.id)},project=object(f.store.get('projects',f.projectId));f.runtime.journal.claim({projectId:f.projectId,ownerId:'multi-target-user',targets:[target]});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_shot_reorder',{expectedRevision:revisionField(project),shotIds:[f.other.id,f.first.id]})]:index===2?[call('mioon_shot_update',{shotId:f.other.id,expectedRevision:1,patch:{prompt:'unaffected edit'}})]:[])};},{loadGroups:['canvas']});const sent=await f.send(),paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,'editing');const step=f.runtime.journal.snapshot(sent.run.id).steps.find(step=>step.toolCall?.name==='mioon_shot_reorder');assert.ok(step);assert.equal(step.targets?.length,2);await f.action(paused,'skip');const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.deepEqual(done.run.skippedTargets?.map(item=>item.target.id),[f.first.id]);assert.equal(object(f.store.get('shots',f.other.id)).prompt,'unaffected edit');assert.equal(done.changes.length,1);
});
test('failed note receipt rolls back the queued text and event as one transaction',async t=>{
 const f=await fixture(t),entered=gate(),release=gate();f.setScript(async function*(){entered.resolve();await release.promise;yield {type:'done',output:output('responses')};});const sent=await f.send();await entered.promise;const current=f.runtime.get(f.projectId,sent.run.id),request={requestId:randomUUID(),expectedRevision:current.run.revision,action:'note',text:'must not partially save'},before=f.runtime.journal.snapshot(sent.run.id),events=f.runtime.journal.events(sent.run.id);
 f.store.db.exec(`CREATE TRIGGER fail_note_receipt BEFORE INSERT ON agent_task_controls_v2 WHEN NEW.requestId='${request.requestId}' BEGIN SELECT RAISE(ABORT,'synthetic note receipt failure');END;`);await assert.rejects(f.runtime.action(f.projectId,sent.run.id,request),{code:'AGENT_TASK_STORAGE_UNAVAILABLE'});assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),before);assert.deepEqual(f.runtime.journal.events(sent.run.id),events);assert.equal(f.runtime.journal.lookupControl(request.requestId),null);release.resolve();await f.settle(sent.run.id);assert.equal(f.requests.length,1);
});
test('a bound note in an unknown model request is never automatically resubmitted after restart',async t=>{
 const f=await fixture(t),first=gate(),releaseFirst=gate(),second=gate(),releaseSecond=gate();f.setScript(async function*(index){if(index===1){first.resolve();await releaseFirst.promise;}if(index===2){second.resolve();await releaseSecond.promise;}yield {type:'done',output:output('responses')};});const sent=await f.send();await first.promise;await f.action(f.runtime.get(f.projectId,sent.run.id),'note',{text:'BOUND_NOTE_UNKNOWN'});releaseFirst.resolve();await second.promise;const body=f.requests[1]!.body;assert.match(body,/BOUND_NOTE_UNKNOWN/);f.restart();const interrupted=f.runtime.get(f.projectId,sent.run.id);assert.equal(interrupted.run.status,'interrupted');assert.equal(f.requests.length,2);assert.equal(interrupted.steps.at(-1)?.status,'unknown');assert.equal(interrupted.run.notes?.[0]?.modelStepId,interrupted.steps.at(-1)?.id);await assert.rejects(f.action(interrupted,'resume'),{code:'AGENT_TASK_UNKNOWN_RESULT'});assert.equal(f.requests.length,2);assert.equal(f.requests[1]!.body,body);releaseSecond.resolve();
 const disposed=await f.action(interrupted,'resolve_unknown',{stepId:interrupted.steps.at(-1)?.id,resolution:'discard'});await f.action(disposed,'resume');assert.equal((await f.settle(sent.run.id)).run.status,'completed');assert.equal(f.requests.length,3);assert.ok(f.runtime.journal.events(sent.run.id).some(event=>event.type==='notes_bound'));assert.equal(f.runtime.journal.run(sent.run.id).notes?.length,1);
});
test('skipped-target instructions use the submitted locale in every model continuation',async t=>{
 const expected={'zh-Hans':'这一处由用户保留，本轮不要再改','zh-Hant':'這一處由使用者保留，本輪不要再修改',en:'The user kept this target.',ja:'この対象はユーザーが保持しました。'};
 for(const locale of AGENT_TASK_LOCALES){const f=await fixture(t),target={kind:'shot',id:f.first.id,revision:f.runtime.journal.targetRevision(f.projectId,'shot',f.first.id)};f.runtime.journal.claim({projectId:f.projectId,ownerId:'locale-skip-user',targets:[target]});f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'never applies'}})]:[])};},{loadGroups:['canvas']});const sent=await f.runtime.send(f.projectId,{requestId:randomUUID(),text:'synthetic skip locale',locale,expectedSettingsRevision:(await f.settings.get()).revision}),paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,'editing');await f.action(paused,'skip');assert.equal((await f.settle(sent.run.id)).run.status,'completed');assert.ok(f.scriptRequest(2).body.includes(expected[locale]));assert.equal(f.effects.size,1);assert.equal(f.loadingEffects,1);}
});
test('a note accepted during replay of a completed tool is observed before completing the saved final reply',async t=>{
 const f=await fixture(t),enteredFinal=gate(),releaseFinal=gate();f.setScript(async function*(index){if(index===2){enteredFinal.resolve();await releaseFinal.promise;}yield {type:'done',output:output('responses',index===1?[call('mioon_project_inspect')]:[])};});const sent=await f.send();await enteredFinal.promise;await f.action(f.runtime.get(f.projectId,sent.run.id),'pause');releaseFinal.resolve();const paused=await f.settle(sent.run.id);assert.equal(paused.run.status,'paused');assert.equal(paused.steps.filter(step=>step.kind==='model'&&step.status==='completed').length,2);
 const original=f.runtime.journal.snapshot;let reads=0,injected:Promise<AgentTaskSnapshot>|undefined;
 f.runtime.journal.snapshot=(runId:string)=>{const snapshot=original(runId);
  // On resume: public control snapshot, executor history snapshot, then the
  // completed tool lookup. The note lands at that tool's awaited return.
  if(snapshot.run.status==='running'&&snapshot.steps.filter(step=>step.kind==='model'&&step.status==='completed').length===2&&++reads===3)queueMicrotask(()=>{injected=f.action(f.runtime.get(f.projectId,runId),'note',{text:'NOTE_AT_COMPLETED_TOOL_YIELD'});});
  return snapshot;
 };
 await f.action(paused,'resume');const done=await f.settle(sent.run.id);assert.ok(injected,'The completed-tool replay yielded to the queued note');await injected;assert.equal(done.run.status,'completed');assert.equal(done.run.notes?.length,1);assert.ok(done.run.notes?.[0]?.modelStepId);assert.equal(f.requests.length,3);assert.match(f.requests[2]!.body,/NOTE_AT_COMPLETED_TOOL_YIELD/);
});

async function lateSelectionFixture(t:TestContext,mode:'skip'|'deny'|'unhandled'){
 let submissions=0;const provider:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},async submit(){submissions++;throw Error('No provider submission is allowed in this test');},async reconcile(){return null;},async poll(){return {status:'running'};},async download(){throw Error('No media download is allowed in this test');}};
 const f=await fixture(t,'responses',new Map([['mock',provider]])),secondEntered=gate(),secondRelease=gate(),thirdEntered=gate(),thirdRelease=gate();
 f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'direct'},acknowledgePaid:true});
 f.setScript(async function*(index){if(index===2){secondEntered.resolve();await secondRelease.promise;}if(mode!=='unhandled'&&index===3){thirdEntered.resolve();await thirdRelease.promise;}
  const calls=index===1?[call('mioon_generation_submit',{shotId:f.first.id,expectedRevision:1,providerId:'mock',model:'mock-motion-v1'})]:mode==='skip'&&index===2?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'stale automatic edit'}})]:index===(mode==='skip'?3:2)?[call('mioon_shot_update',{shotId:f.other.id,expectedRevision:1,patch:{prompt:'other target continues'}})]:[];
  yield {type:'done',output:output('responses',calls)};
 },{loadGroups:['canvas','video']});
 const sent=await f.send();await secondEntered.promise;const job=f.store.list('jobs',f.projectId)[0] as JobRecord,step=f.runtime.journal.snapshot(sent.run.id).steps.find(step=>step.toolCall?.name==='mioon_generation_submit');assert.ok(step);
 // Model a previously submitted job through its normal local result boundary.
 // No worker, provider transport or FFmpeg process is started.
 withAgentTaskJobOrigin(f.store.db,'job',job.id,()=>f.services.saveJob(job,{status:'running',phase:'polling',providerJobId:'synthetic-known-submitted-job',submissionCount:1,progress:25}));
 return {...f,sent,jobId:job.id,generationStepId:step.id,secondRelease,thirdRelease,thirdEntered,get submissions(){return submissions;},release(){secondRelease.resolve();thirdRelease.resolve();}};
}
for(const mode of ['skip','deny'] as const)test(`a late ${mode==='skip'?'skipped-target':'denied-background'} result stays recorded without pausing unrelated work`,async t=>{
 const f=await lateSelectionFixture(t,mode);try{
  if(mode==='skip'){
   await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'manual content kept'}});f.secondRelease.resolve();const paused=await f.settle(f.sent.run.id);assert.equal(paused.run.pauseReason,'conflict');const changes=paused.changes;
   const skipped=await f.action(paused,'skip');assert.deepEqual(skipped.changes,changes);assert.equal(skipped.run.skippedTargets?.length,1);await f.thirdEntered.promise;
  }else{
   f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'confirm'}});assert.throws(()=>assertAgentTaskJobEffect(f.store.db,'job',f.jobId),{code:'AGENT_TASK_APPROVAL_REQUIRED'});f.secondRelease.resolve();await f.runtime.drain();const waiting=f.runtime.get(f.projectId,f.sent.run.id);assert.equal(waiting.run.status,'awaiting_approval');await f.action(waiting,'deny',{stepId:f.generationStepId});await f.thirdEntered.promise;assert.equal(object(f.runtime.journal.step(f.generationStepId).data).backgroundDenied,true);
  }
  const before=f.runtime.journal.snapshot(f.sent.run.id);assert.equal(before.run.status,'running');assert.equal(allowAgentTaskJobTargetMutation(f.store.db,'job',f.jobId,{kind:'shot',id:f.first.id}),false);const after=f.runtime.journal.snapshot(f.sent.run.id);assert.equal(after.run.status,'running');assert.deepEqual(after.run.skippedTargets,before.run.skippedTargets);assert.deepEqual(after.changes,before.changes);
  if(mode==='skip'){
   const original=f.runtime.journal.step(f.generationStepId);f.runtime.journal.updateStep(f.sent.run.id,original.id,{targets:[...(original.targets??[]),{kind:'shot',id:f.other.id,revision:f.runtime.journal.targetRevision(f.projectId,'shot',f.other.id)}]});
   assert.equal(allowAgentTaskJobTargetMutation(f.store.db,'job',f.jobId,{kind:'shot',id:f.other.id}),false);assert.equal(f.runtime.journal.run(f.sent.run.id).status,'running');assert.equal(f.runtime.journal.run(f.sent.run.id).skippedTargets?.some(item=>item.target.id===f.other.id),false);
  }
  const handled=f.runtime.journal.events(f.sent.run.id).filter(event=>event.type==='background_selection_skipped').at(-1);assert.ok(handled);assert.equal(object(handled.data).reason,mode==='skip'?'target_skipped':'background_denied');
  const current=f.store.get('jobs',f.jobId) as JobRecord;withAgentTaskJobOrigin(f.store.db,'job',f.jobId,()=>f.services.saveJob(current,{status:'succeeded',phase:'complete',progress:100,error:null}));assert.equal(object(f.store.get('jobs',f.jobId)).status,'succeeded');assert.equal(f.runtime.journal.run(f.sent.run.id).status,'running');
  f.release();const done=await f.settle(f.sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.backgroundPending,false);assert.equal(object(f.store.get('shots',f.other.id)).prompt,'other target continues');assert.equal(object(f.store.get('shots',f.first.id)).prompt,mode==='skip'?'manual content kept':'saved first');assert.equal(f.submissions,0);
 }finally{f.release();await f.runtime.drain();}
});
test('a late unhandled target conflict still pauses with actual source evidence while retaining the result',async t=>{
 const f=await lateSelectionFixture(t,'unhandled');try{
  await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'unhandled manual edit'}});assert.equal(allowAgentTaskJobTargetMutation(f.store.db,'job',f.jobId,{kind:'shot',id:f.first.id}),false);const paused=f.runtime.journal.snapshot(f.sent.run.id);assert.equal(paused.run.status,'paused');assert.equal(paused.run.pauseReason,'conflict');assert.deepEqual(paused.run.skippedTargets,[]);const source=object(f.runtime.journal.step(f.generationStepId).data);assert.equal(source.backgroundInvalidated,true);assert.ok(Array.isArray(source.conflictTargets)&&source.conflictTargets.some(target=>object(target).kind==='shot'&&object(target).id===f.first.id));
  const job=f.store.get('jobs',f.jobId) as JobRecord;withAgentTaskJobOrigin(f.store.db,'job',f.jobId,()=>f.services.saveJob(job,{status:'succeeded',phase:'complete',progress:100,error:null}));assert.equal(object(f.store.get('jobs',f.jobId)).status,'succeeded');assert.equal(f.runtime.journal.run(f.sent.run.id).status,'paused');assert.equal(object(f.store.get('shots',f.first.id)).prompt,'unhandled manual edit');assert.equal(f.submissions,0);
 }finally{f.release();await f.runtime.drain();}
});
test('a late selection denied by revoked authorization reads no target and resumes only after reauthorization',async t=>{
 const f=await lateSelectionFixture(t,'unhandled');try{
  await f.revoke();const prepare=f.store.db.prepare.bind(f.store.db);let targetReads=0;
  f.store.db.prepare=(sql:string)=>{if(/\bFROM\s+(?:shots|agent_task_target_revisions_v2|agent_task_edit_claims_v2)\b/iu.test(sql))targetReads++;return prepare(sql);};
  try{assert.equal(allowAgentTaskJobTargetMutation(f.store.db,'job',f.jobId,{kind:'shot',id:f.first.id}),false);}finally{f.store.db.prepare=prepare;}
  assert.equal(targetReads,0);const denied=f.runtime.journal.snapshot(f.sent.run.id);assert.equal(denied.run.status,'paused');assert.equal(denied.run.pauseReason,'AGENT_TASK_CONSENT_REQUIRED');assert.deepEqual(denied.run.skippedTargets,[]);assert.equal(object(f.runtime.journal.step(f.generationStepId).data).conflictTargets,undefined);assert.equal(f.effects.size,2);assert.equal(f.loadingEffects,1);
  f.release();await f.runtime.drain();await authorizeTestScope(f.authorizations,'project_agent');await f.action(f.runtime.get(f.projectId,f.sent.run.id),'resume');const done=await f.settle(f.sent.run.id);assert.equal(done.run.status,'completed');assert.equal(object(f.store.get('shots',f.other.id)).prompt,'other target continues');assert.equal(f.submissions,0);
 }finally{f.release();await f.runtime.drain();}
});
test('a stopped run still rejects late selection without changing its terminal status or another target',async t=>{
 const f=await lateSelectionFixture(t,'unhandled');try{
  const stopped=await f.action(f.runtime.get(f.projectId,f.sent.run.id),'stop');assert.equal(stopped.run.status,'stopped');assert.equal(allowAgentTaskJobTargetMutation(f.store.db,'job',f.jobId,{kind:'shot',id:f.first.id}),false);assert.equal(f.runtime.journal.run(f.sent.run.id).status,'stopped');assert.deepEqual(f.runtime.journal.run(f.sent.run.id).skippedTargets,[]);assert.equal(object(f.store.get('shots',f.other.id)).prompt,'saved other');assert.equal(f.effects.size,2);assert.equal(f.loadingEffects,1);assert.equal(f.submissions,0);
 }finally{f.release();await f.runtime.drain();}
});
for(const failure of ['SQLITE_IOERR','UNRECOGNIZED_GATE_FAILURE'] as const)test(`late selection propagates ${failure} instead of disguising it as a handled choice`,async t=>{
 const f=await lateSelectionFixture(t,'unhandled'),injected=Object.assign(Error('Synthetic late gate failure'),{code:failure}),remove=setAgentTaskEffectGate(f.store.db,()=>{throw injected;});try{
  const before=f.runtime.journal.snapshot(f.sent.run.id);assert.throws(()=>allowAgentTaskJobTargetMutation(f.store.db,'job',f.jobId,{kind:'shot',id:f.first.id}),error=>error===injected);assert.deepEqual(f.runtime.journal.snapshot(f.sent.run.id),before);assert.equal(f.effects.size,2);assert.equal(f.loadingEffects,1);assert.equal(object(f.store.get('shots',f.other.id)).prompt,'saved other');assert.equal(f.submissions,0);await f.action(f.runtime.get(f.projectId,f.sent.run.id),'stop');
 }finally{remove();f.release();await f.runtime.drain();}
});

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

function replyOutput(protocol:'chat_completions'|'responses',text:string):TaskModelOutput {
 return {text,toolCalls:[],providerOutput:protocol==='chat_completions'?{role:'assistant',content:text}:[{type:'message',id:'synthetic-output-message',status:'completed',role:'assistant',content:[{type:'output_text',text,annotations:[]}]}]};
}
function longReadOutput(protocol:'chat_completions'|'responses',text:string,calls:AgentTaskToolCall[]):TaskModelOutput {
 const reply=replyOutput(protocol,text);reply.toolCalls=calls;
 reply.providerOutput=protocol==='chat_completions'
  ?{role:'assistant',content:text,...(calls.length?{tool_calls:calls.map(item=>({id:item.id,type:'function',function:{name:item.name,arguments:JSON.stringify(item.arguments)}}))}:{})}
  :[...(reply.providerOutput as AgentTaskJson[]),...calls.map(item=>({type:'function_call',call_id:item.id,name:item.name,arguments:JSON.stringify(item.arguments),status:'completed'}))];
 return reply;
}
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: note capacity counts the execution fallback for a retained terminal null result`,async t=>{
 const f=await fixture(t,protocol);f.runtime.journal.updatePolicy({...f.runtime.policy(),stepLimit:2});
 const execute=f.tools.execute;f.tools.execute=async(prepared,context)=>({...await execute(prepared,context),result:null});
 const prepare=f.tools.prepare;let preparations=0;f.tools.prepare=input=>{preparations++;return prepare(input);};
 f.setScript(async function*(index){yield {type:'done',output:longReadOutput(protocol,index===1?'r'.repeat(97000):'Complete.',index===1?[call('mioon_project_inspect')]:[])};});
 const sent=await f.send('u'.repeat(32000)),paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,'budget');assert.equal(preparations,1);
 const before=f.runtime.journal.snapshot(sent.run.id),model=before.steps.find(step=>step.kind==='model'),tool=before.steps.find(step=>step.kind==='tool');assert.ok(model&&tool?.toolCall);assert.equal(tool.status,'completed');assert.equal(tool.result,null);
 const retained=object(model.result) as unknown as TaskModelOutput,history=before.run.context??[],withoutFallback=taskContinuation(protocol,retained,[{callId:tool.toolCall.id,result:null}]);
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
async function noteHistoryFixture(t:TestContext,protocol:'chat_completions'|'responses',messageLength=30000){
 const f=await fixture(t,protocol);let conversationId:string|undefined;
 f.setScript(async function*(){yield {type:'done',output:replyOutput(protocol,'a'.repeat(2000))};});
 for(let index=0;index<3;index++){
  const sent=await f.runtime.send(f.projectId,{requestId:randomUUID(),text:'u'.repeat(messageLength),expectedSettingsRevision:(await f.settings.get()).revision,...(conversationId?{conversationId}:{})});
  const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');conversationId=done.run.conversationId;
 }
 return {...f,sendNext:async()=>f.runtime.send(f.projectId,{requestId:randomUUID(),text:'u'.repeat(messageLength),expectedSettingsRevision:(await f.settings.get()).revision,conversationId})};
}
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: note capacity rejects an already persisted streamed reply atomically and replays its rejection`,async t=>{
 // No earlier conversation is available to drop: the current user message,
 // persisted latest reply and new note are all protected content.
 const f=await fixture(t,protocol),entered=gate(),release=gate(),reply='r'.repeat(98500),note='n'.repeat(1024);
 f.setScript(async function*(){yield {type:'delta',text:reply};entered.resolve();await release.promise;yield {type:'done',output:replyOutput(protocol,reply)};});
 const sent=await f.send('u'.repeat(32000));await entered.promise;
 try{
  const before=f.runtime.journal.snapshot(sent.run.id),events=f.runtime.journal.events(sent.run.id),model=before.steps.find(step=>step.kind==='model');assert.ok(model);assert.equal(model.status,'dispatch_started');assert.equal(model.text,reply);
  const historyBytes=Buffer.byteLength(JSON.stringify(before.run.context));assert.ok(historyBytes+Buffer.byteLength(note)+200<TASK_MODEL_LIMITS.historyBytes);assert.ok(historyBytes+Buffer.byteLength(model.text)+Buffer.byteLength(note)>TASK_MODEL_LIMITS.historyBytes);
  const body=f.requests.at(-1)!.body,request={requestId:randomUUID(),expectedRevision:before.run.revision,action:'note',text:note};
  await assert.rejects(f.runtime.action(f.projectId,sent.run.id,request),{code:'AGENT_TASK_NOTE_CAPACITY'});
  const rejectedEvents=f.runtime.journal.events(sent.run.id),receipt=f.runtime.journal.lookupControl(request.requestId);assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),before);assert.deepEqual(rejectedEvents.slice(0,-1),events);assert.equal(rejectedEvents.at(-1)?.type,'control');assert.deepEqual(rejectedEvents.at(-1)?.data,receipt);assert.deepEqual(receipt,{requestId:request.requestId,runId:sent.run.id,action:'note',revision:before.run.revision,result:{state:'rejected',code:'AGENT_TASK_NOTE_CAPACITY'}});
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
 assert.ok(Buffer.byteLength(JSON.stringify(before.run.context))+Buffer.byteLength(reply)+Buffer.byteLength(note)>TASK_MODEL_LIMITS.historyBytes);
 try{
  const accepted=await f.action(f.runtime.get(f.projectId,sent.run.id),'note',{text:note});assert.equal(accepted.run.notes?.[0]?.text,note);
  assert.deepEqual(f.runtime.journal.step(model.id).request,frozen);assert.equal(f.requests.at(-1)!.body,initialBody);assert.deepEqual(f.runtime.journal.run(sent.run.id).context,context);
 }finally{release.resolve();await f.runtime.drain();}
 const done=f.runtime.get(f.projectId,sent.run.id),latest=f.runtime.journal.snapshot(sent.run.id).steps.filter(step=>step.kind==='model').at(-1);assert.ok(latest);
 assert.equal(done.run.status,'completed');assert.equal(f.requests.length,5);assert.ok(done.run.notes?.[0]?.modelStepId);
 const history=object(latest.request).history;assert.ok(Array.isArray(history));assert.ok(Buffer.byteLength(JSON.stringify(history))<=TASK_MODEL_LIMITS.historyBytes);
 assert.ok(f.requests.at(-1)!.body.includes(reply));assert.ok(f.requests.at(-1)!.body.includes(note));
 const oldReply='a'.repeat(2000),remaining=history.filter(value=>object(value).role==='assistant'&&object(value).content===oldReply).length;
 assert.ok(remaining<(context??[]).filter(value=>object(value).role==='assistant'&&object(value).content===oldReply).length);
 assert.deepEqual(f.runtime.journal.step(model.id).request,frozen);
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: note capacity accepts a persisted streamed reply below the limit without rewriting its intent`,async t=>{
 const f=await noteHistoryFixture(t,protocol,28000),entered=gate(),release=gate(),reply='r'.repeat(8193),note='n'.repeat(1024);let count=0;
 f.setScript(async function*(){if(++count===1){yield {type:'delta',text:reply};entered.resolve();await release.promise;yield {type:'done',output:replyOutput(protocol,reply)};}else yield {type:'done',output:replyOutput(protocol,'Follow-up complete')};});
 const sent=await f.sendNext();await entered.promise;
 try{
  const before=f.runtime.journal.snapshot(sent.run.id),model=before.steps.find(step=>step.kind==='model');assert.equal(model?.text,reply);const request=model?.request;
  assert.ok(Buffer.byteLength(JSON.stringify(before.run.context))+Buffer.byteLength(reply)+Buffer.byteLength(note)+1000<TASK_MODEL_LIMITS.historyBytes);
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

for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: skipping a track also denies later nested clip references without blocking another target`,async t=>{
 const f=await fixture(t,protocol),assetId=randomUUID();
 f.store.put('assets',{id:assetId,projectId:f.projectId,name:'Synthetic image',mimeType:'image/png',width:720,height:1280,duration:0,hasVideo:true,hasAudio:false,sha256:'a'.repeat(64),relativePath:'media/fixture.png',provenance:'user-import',createdAt:new Date().toISOString()});
 const readTimeline=()=>object(JSON.parse(String(f.store.db.prepare('SELECT data FROM timelines WHERE projectId=?').get(f.projectId)!.data)));
 const initial=object(await f.services.call('timeline.get',{projectId:f.projectId}));assert.ok(Array.isArray(initial.tracks));const sourceTrack=String(object(initial.tracks[0]).id);
 await f.services.call('timeline.track.add',{projectId:f.projectId,requestId:randomUUID(),kind:'video',name:'Kept track',expectedRevision:revisionField(initial)});
 await f.services.call('timeline.clip.add',{projectId:f.projectId,requestId:randomUUID(),assetId,trackId:sourceTrack,expectedRevision:revisionField(readTimeline()),startFrame:0,durationFrames:30});
 const saved=readTimeline();assert.ok(Array.isArray(saved.tracks)&&Array.isArray(saved.clips));const clipId=String(object(saved.clips[0]).id),targetTrack=String(object(saved.tracks.find(value=>object(value).name==='Kept track')).id),timelineRevision=revisionField(saved);
 const target={kind:'timeline_track',id:targetTrack,revision:f.runtime.journal.targetRevision(f.projectId,'timeline_track',targetTrack)};
 f.runtime.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId:'kept-track-draft',generation:1,sequence:1,action:'claim',targets:[target]});
 f.setScript(async function*(index){yield {type:'done',output:output(protocol,index===1?[call('mioon_timeline_track_update',{trackId:targetTrack,expectedRevision:timelineRevision,patch:{name:'Never rename'}})]:index===2?[call('mioon_timeline_clip_update',{clipId,expectedRevision:timelineRevision,patch:{trackId:targetTrack}}),call('mioon_shot_update',{shotId:f.other.id,expectedRevision:f.other.revision,patch:{prompt:'unrelated target still works'}})]:[])};},{loadGroups:['canvas','editing']});
 const sent=await f.send(),paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,'editing');await f.action(paused,'skip');const done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(done.run.skippedTargets?.length,1);assert.equal(done.run.skippedTargets?.[0]?.target.id,targetTrack);assert.equal(done.changes.length,1);assert.equal(done.changes[0]?.operation,'shot.update');
 const rejected=done.steps.find(step=>step.toolCall?.name==='mioon_timeline_clip_update');assert.equal(rejected?.status,'denied');assert.equal(rejected?.error?.code,'TARGET_SKIPPED');const final=readTimeline();assert.ok(Array.isArray(final.clips));assert.equal(object(final.clips.find(value=>object(value).id===clipId)).trackId,sourceTrack);assert.equal(f.runtime.journal.claims(f.projectId).length,1);assert.equal(f.requests.length,4);assert.equal(f.loadingRequests,1);
});

for(const metadata of ['saved','legacy'] as const)test(`background effect gates reject skipped nested references from ${metadata} accepted steps`,async t=>{
 const f=await fixture(t),entered=gate(),release=gate();f.setScript(async function*(){entered.resolve();await release.promise;yield {type:'done',output:output('responses')};});
 const sent=await f.send();await entered.promise;
 try{
  const reference={kind:'asset',id:randomUUID(),revision:0},target={kind:'shot',id:f.first.id,revision:f.runtime.journal.targetRevision(f.projectId,'shot',f.first.id)};
  const tool=f.runtime.journal.beginStep(sent.run.id,{kind:'tool',targets:[target],toolCall:call('mioon_image_generate',{purpose:'edit',inputImage:{assetId:reference.id,sha256:'a'.repeat(64)}}),...(metadata==='saved'?{data:{referencedTargets:[reference]}}:{})});
  f.runtime.journal.markDispatch(sent.run.id,tool.id);f.runtime.journal.completeStep(sent.run.id,tool.id,{result:{accepted:true}});
  const conflict=f.runtime.journal.beginStep(sent.run.id,{kind:'tool',targets:[reference],data:{conflictTargets:[reference]}});
  f.store.tx(()=>{f.runtime.journal.skipTargetsInside(sent.run.id,[{stepId:conflict.id,target:reference}]);f.store.db.prepare('INSERT INTO agent_task_job_origins_v2(kind,jobId,runId,stepId,projectId,requestId,operation) VALUES(?,?,?,?,?,?,?)').run('image','synthetic-pending-image',sent.run.id,tool.id,f.projectId,tool.id,'image.generate');});
  assert.throws(()=>assertAgentTaskJobEffect(f.store.db,'image','synthetic-pending-image'),{code:'AGENT_TASK_TARGET_SKIPPED'});assert.equal(f.runtime.journal.run(sent.run.id).status,'running');assert.equal(f.requests.length,1);assert.equal(f.effects.size,0);
 }finally{release.resolve();await f.settle(sent.run.id);}
});

for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: explicit retry starts a new model step after proven unsent failure and keeps its budget and receipt`,async t=>{
 const f=await fixture(t,protocol),transport=syntheticDeniedTransport('198.18.10.207');f.setScript(async function*(index,request){if(index===1){yield*transport.gateway(request);return;}yield {type:'done',output:output(protocol,[],'Retry completed')};});
 const sent=await f.send(),failed=await f.settle(sent.run.id),step=failed.steps.at(-1)!;assert.equal(failed.run.status,'failed');assert.equal(step.status,'failed');
 const control={requestId:randomUUID(),expectedRevision:failed.run.revision,action:'retry',stepId:step.id};await f.runtime.action(f.projectId,sent.run.id,control);await f.runtime.action(f.projectId,sent.run.id,control);const done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(done.run.id,failed.run.id);assert.equal(done.run.budget,failed.run.budget);assert.equal(done.run.stepsUsed,2);assert.equal(f.requests.length,2);assert.notEqual(done.steps[1]!.id,step.id);assert.equal(done.steps[0]!.status,'failed');assert.equal(done.steps[1]!.status,'completed');assert.equal(done.executionEndedAt,done.run.updatedAt);
 f.restart();await f.runtime.action(f.projectId,sent.run.id,control);await f.runtime.drain();assert.equal(f.requests.length,2);assert.equal(f.runtime.lookupAction(f.projectId,sent.run.id,control.requestId).receipt?.action,'retry');await assert.rejects(f.runtime.action(f.projectId,sent.run.id,{...control,stepId:randomUUID()}),{code:'AGENT_TASK_REQUEST_CONFLICT'});
});
for(const protocol of ['chat_completions','responses'] as const)for(const statusCode of [429,500] as const)test(`${protocol}: HTTP ${statusCode} after sending is a failure retried only on explicit request`,async t=>{
 const f=await fixture(t,protocol),transport=syntheticDeniedTransport('8.8.8.8',statusCode);f.setScript(async function*(index,request){if(index===1){yield*transport.gateway(request);return;}yield {type:'done',output:output(protocol,[],'Retry completed')};});
 const sent=await f.send(),failed=await f.settle(sent.run.id),step=failed.steps.at(-1)!;
 assert.equal(failed.run.status,'failed');assert.equal(step.kind,'model');assert.equal(step.status,'failed');assert.equal(step.error?.code,'AGENT_CHAT_HTTP_ERROR');assert.match(step.error!.message,new RegExp(`HTTP ${statusCode}`,'u'));assert.equal(failed.steps.some(item=>item.status==='unknown'),false);
 await f.runtime.drain();assert.equal(f.requests.length,1);assert.deepEqual(transport.counts,{dns:1,requests:1,ends:1});
 await f.runtime.action(f.projectId,sent.run.id,{requestId:randomUUID(),expectedRevision:failed.run.revision,action:'retry',stepId:step.id});const done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(done.run.budget,failed.run.budget);assert.equal(done.run.stepsUsed,2);assert.equal(f.requests.length,2);assert.equal(done.steps[0]!.status,'failed');assert.equal(done.steps[0]!.error?.code,'AGENT_CHAT_HTTP_ERROR');assert.equal(done.steps[1]!.status,'completed');assert.equal(f.effects.size,0);
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: a timeout after partial text records a failure and the retry does not feed that text back`,async t=>{
 // Below 8 KiB: a failure must flush received text before recording its status.
 const partial='PARTIAL_REPLY_BEFORE_TIMEOUT '.repeat(100);
 const f=await fixture(t,protocol);f.setScript(async function*(index){if(index===1){yield {type:'delta',text:partial};throw Object.assign(new Error('timeout'),{code:'AGENT_CHAT_TIMEOUT'});}yield {type:'done',output:output(protocol,[],'Retry completed')};});
 const sent=await f.send(),failed=await f.settle(sent.run.id),step=failed.steps.at(-1)!;
 assert.equal(failed.run.status,'failed');assert.equal(step.status,'failed');assert.equal(step.error?.code,'AGENT_CHAT_TIMEOUT');assert.equal(step.text,partial);
 await f.runtime.action(f.projectId,sent.run.id,{requestId:randomUUID(),expectedRevision:failed.run.revision,action:'retry',stepId:step.id});const done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(f.requests.length,2);assert.doesNotMatch(f.requests[1]!.body,/PARTIAL_REPLY_BEFORE_TIMEOUT/u);assert.equal(done.steps[0]!.text,partial);assert.equal(done.steps[1]!.status,'completed');
});
test('an unclassified exception during a model request still keeps the unknown rule',async t=>{
 const f=await fixture(t);f.setScript(async function*(){throw new Error('unclassified gateway failure');});
 const sent=await f.send(),done=await f.settle(sent.run.id),step=done.steps.at(-1)!;
 assert.equal(step.status,'unknown');await assert.rejects(f.runtime.action(f.projectId,sent.run.id,{requestId:randomUUID(),expectedRevision:done.run.revision,action:'retry',stepId:step.id}),{code:'AGENT_TASK_UNKNOWN_RESULT'});assert.equal(f.requests.length,1);
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: failed tool stops its batch; retry supplies the failure and replans without old parameters`,async t=>{
 const f=await fixture(t,protocol),invalid=call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{duration:-1}}),stale=call('mioon_shot_update',{shotId:f.other.id,expectedRevision:1,patch:{prompt:'MUST NOT EXECUTE OLD BATCH'}});
 f.setScript(async function*(index,request){if(index===2){assert.match(request.body,/VALIDATION_ERROR/);assert.match(request.body,/TARGET_CHANGED/);}yield {type:'done',output:output(protocol,index===1?[invalid,stale]:index===2?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:2,patch:{prompt:'Fresh retry plan'}})]:[])};},{loadGroups:['canvas']});
 const sent=await f.send(),failed=await f.settle(sent.run.id);assert.equal(failed.run.status,'failed');assert.equal(failed.steps.at(-1)?.status,'failed');assert.equal(f.requests.length,2);assert.equal(f.effects.size,1);assert.equal(f.loadingEffects,1);assert.equal(failed.steps.length,4);
 await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'New manual baseline'}});
 await f.action(failed,'retry',{stepId:failed.steps.at(-1)!.id});const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.run.stepsUsed,7);assert.equal(done.run.budget,30);assert.equal(f.effects.size,2);assert.equal(f.loadingEffects,1);assert.equal(f.requests.length,4);assert.equal(object(f.store.get('shots',f.first.id)).prompt,'Fresh retry plan');assert.equal(object(f.store.get('shots',f.other.id)).prompt,'saved other');assert.equal(done.steps.filter(step=>step.toolCall?.id===invalid.id).length,1);assert.equal(done.steps.some(step=>step.toolCall?.id===stale.id),false);
});
for(const scenario of ['unknown','last_completed','revoked','busy','budget','receipt_failure'] as const)test(`retry gate preserves safety for ${scenario}`,async t=>{
 const f=await fixture(t),transport=syntheticDeniedTransport(scenario==='unknown'?'93.184.216.34':'198.18.10.207');if(scenario==='budget')f.runtime.journal.updatePolicy({...f.runtime.policy(),stepLimit:1});
 // An observed HTTP error is now a plain failure; an unclassified exception
 // during the request is what still leaves an unknown model result.
 f.setScript(async function*(index,request){if(scenario==='last_completed'){yield {type:'done',output:output('responses')};await f.revoke();return;}if(index===1){if(scenario==='unknown')throw new Error('unclassified gateway failure');yield*transport.gateway(request);return;}yield {type:'done',output:output('responses')};});const sent=await f.send(),failed=await f.settle(sent.run.id);assert.equal(failed.run.status,'failed');
 if(scenario==='revoked')await f.revoke();
 if(scenario==='busy'){const entered=gate(),release=gate();f.setScript(async function*(){entered.resolve();await release.promise;yield {type:'done',output:output('responses')};});const other=await f.send('New active run');await entered.promise;t.after(()=>release.resolve());assert.equal(f.runtime.get(f.projectId,other.run.id).run.status,'running');}
 const request={requestId:randomUUID(),expectedRevision:failed.run.revision,action:'retry',stepId:failed.steps.at(-1)!.id},before=f.runtime.journal.snapshot(sent.run.id),requests=f.requests.length;
 if(scenario==='receipt_failure')f.store.db.exec(`CREATE TRIGGER fail_retry_receipt BEFORE INSERT ON agent_task_controls_v2 WHEN NEW.requestId='${request.requestId}' BEGIN SELECT RAISE(ABORT,'synthetic retry receipt failure');END;`);
 if(scenario==='budget'){
  const paused=await f.runtime.action(f.projectId,sent.run.id,request);assert.equal(paused.run.status,'paused');assert.equal(paused.run.pauseReason,'budget');assert.equal(paused.run.budget,1);assert.equal(paused.run.stepsUsed,1);assert.equal(f.requests.length,1);await f.action(paused,'resume');const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.run.budget,2);assert.equal(f.requests.length,2);
 }else{
  const codes={unknown:'AGENT_TASK_UNKNOWN_RESULT',last_completed:'AGENT_TASK_STATE_CONFLICT',revoked:'AGENT_TASK_CONSENT_REQUIRED',busy:'AGENT_TASK_BUSY',receipt_failure:'AGENT_TASK_STORAGE_UNAVAILABLE'};
  await assert.rejects(f.runtime.action(f.projectId,sent.run.id,request),{code:codes[scenario]});assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),before);assert.equal(f.requests.length,requests);if(scenario==='receipt_failure')assert.equal(f.runtime.journal.lookupControl(request.requestId),null);
 }
});
test('retry replan still requires paid approval and never submits a generation on its own',async t=>{
 const f=await fixture(t);f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{duration:-1}})]:index===2?[call('mioon_generation_submit',{shotId:f.first.id,expectedRevision:1,providerId:'mock',model:'mock-motion-v1',parameters:{delayMs:0}})]:[])};},{loadGroups:['canvas','video']});
 const sent=await f.send(),failed=await f.settle(sent.run.id);assert.equal(failed.run.status,'failed');await f.action(failed,'retry');const waiting=await f.settle(sent.run.id);assert.equal(waiting.run.status,'awaiting_approval');assert.equal(waiting.run.budget,30);assert.equal(waiting.steps.at(-1)?.tier,'paid');assert.equal(f.store.list('jobs',f.projectId).length,0);assert.equal(f.requests.length,3);assert.equal(f.loadingRequests,1);await f.action(waiting,'deny',{stepId:waiting.steps.at(-1)!.id});assert.equal((await f.settle(sent.run.id)).run.status,'completed');assert.equal(f.store.list('jobs',f.projectId).length,0);
});
for(const scenario of ['modified','aba','draft','compound','audit_failure'] as const)test(`whole undo safely classifies and preserves ${scenario} while protecting earlier changes`,async t=>{
 const f=await fixture(t);f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_shot_update',{shotId:f.other.id,expectedRevision:1,patch:{prompt:'Earlier AI edit'}}),call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'Later AI edit'}})]:[])};},{loadGroups:['canvas']});
 const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.changes.length,2);let current=object(await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:2,patch:{prompt:'Manual after AI'}}));
 if(scenario==='aba')current=object(await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:current.revision,patch:{prompt:'Later AI edit'}}));
 if(scenario==='draft')f.runtime.journal.claim({projectId:f.projectId,ownerId:randomUUID(),targets:[{kind:'shot',id:f.first.id,revision:f.runtime.journal.targetRevision(f.projectId,'shot',f.first.id)}]});
 if(scenario==='compound'){const original=f.runtime.journal.snapshot(sent.run.id).changes.at(-1)!;original.targets.push({kind:'shot',id:f.other.id,revision:2,revisionBefore:1,revisionAfter:2});f.store.db.prepare('UPDATE agent_task_changes_v2 SET data=? WHERE id=?').run(JSON.stringify(original),original.id);}
 const fresh=f.runtime.get(f.projectId,sent.run.id),last=fresh.changes.at(-1)!;assert.equal(last.modifiedAfter,true);assert.equal(last.undoDisposition,scenario==='modified'||scenario==='audit_failure'?'retain':'blocked');assert.equal(fresh.changes[0]!.undoDisposition,scenario==='modified'||scenario==='audit_failure'?'undo':'blocked');
 await assert.rejects(f.action(fresh,'undo_change',{changeId:last.id}),{code:'AGENT_TASK_TARGET_CHANGED'});
 const request={requestId:randomUUID(),expectedRevision:f.runtime.journal.run(sent.run.id).revision,action:'undo_all'};
 if(scenario==='audit_failure')f.store.db.exec(`CREATE TRIGGER fail_superseded_event BEFORE INSERT ON agent_task_events_v2 WHEN json_extract(NEW.data,'$.data.status')='superseded' BEGIN SELECT RAISE(ABORT,'synthetic superseded audit failure');END;`);
 if(scenario==='modified'){
  const undone=await f.runtime.action(f.projectId,sent.run.id,request);assert.equal(undone.run.status,'reverted');assert.deepEqual(undone.changes.map(change=>change.status),['reverted','superseded']);assert.equal(object(f.store.get('shots',f.other.id)).prompt,'saved other');assert.equal(object(f.store.get('shots',f.first.id)).prompt,'Manual after AI');assert.deepEqual(object(f.runtime.journal.lookupControl(request.requestId)?.result).retainedChangeIds,[last.id]);
  f.restart();const stable=f.runtime.journal.snapshot(sent.run.id);await f.runtime.action(f.projectId,sent.run.id,request);assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),stable);assert.equal(f.requests.length,3);assert.equal(f.loadingRequests,1);assert.ok(stable.changes.every(change=>change.modifiedAfter===undefined&&change.undoDisposition===undefined));
 }else{
  await assert.rejects(f.runtime.action(f.projectId,sent.run.id,request),{code:scenario==='audit_failure'?'AGENT_TASK_STORAGE_UNAVAILABLE':'AGENT_TASK_TARGET_CHANGED'});assert.deepEqual(f.runtime.journal.snapshot(sent.run.id).changes.map(change=>change.status),['applied','applied']);assert.equal(object(f.store.get('shots',f.other.id)).prompt,'Earlier AI edit');assert.equal(object(f.store.get('shots',f.first.id)).prompt,current.prompt);
 }
});
test('whole undo preview includes adjacent own changes without mistaking their revisions for external supersession',async t=>{
 const f=await fixture(t);f.setScript(async function*(index){yield {type:'done',output:output('responses',index<=2?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:index,patch:{prompt:`AI edit ${index}`}})]:[])};},{loadGroups:['canvas']});const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.changes.length,2);assert.deepEqual(done.changes.map(change=>change.undoDisposition),['undo','undo']);assert.deepEqual(done.changes.map(change=>change.modifiedAfter),[true,false]);await assert.rejects(f.action(done,'undo_change',{changeId:done.changes[0]!.id}),{code:'AGENT_TASK_TARGET_CHANGED'});const undone=await f.action(f.runtime.get(f.projectId,sent.run.id),'undo_all');assert.equal(undone.run.status,'reverted');assert.deepEqual(undone.changes.map(change=>change.status),['reverted','reverted']);assert.equal(object(f.store.get('shots',f.first.id)).prompt,'saved first');
});

test('retry retains the same run skipped targets and replans only allowed tools',async t=>{
 const f=await fixture(t);f.setScript(async function*(index){
  if(index===1)await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'Manual protected content'}});
  const next=index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'Old conflicting plan'}})]:index===2?[call('mioon_shot_update',{shotId:f.other.id,expectedRevision:1,patch:{duration:-1}})]:index===3?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:2,patch:{prompt:'Must stay skipped after retry'}}),call('mioon_project_inspect')]:[];
  yield {type:'done',output:output('responses',next)};
 },{loadGroups:['canvas']});
 const sent=await f.send(),paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,'conflict');await f.action(paused,'skip');const failed=await f.settle(sent.run.id);assert.equal(failed.run.status,'failed');assert.equal(failed.run.skippedTargets?.length,1);
 await f.action(failed,'retry');const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.run.skippedTargets?.length,1);assert.ok(done.steps.some(step=>step.status==='denied'&&step.error?.code==='TARGET_SKIPPED'));assert.equal(object(f.store.get('shots',f.first.id)).prompt,'Manual protected content');assert.equal(object(f.store.get('shots',f.other.id)).prompt,'saved other');assert.equal(f.effects.size,2);assert.equal(f.loadingEffects,1);assert.equal(f.requests.length,5);assert.match(f.scriptRequest(4).body,/TARGET_SKIPPED/);
});
test('retry authorization revoked after its intent blocks actual model submission',async t=>{
 const f=await fixture(t),transport=syntheticDeniedTransport('198.18.10.207');let submitted=0;f.setScript(async function*(index,request){if(index===1){yield*transport.gateway(request);return;}await f.revoke();assert.ok(request.beforeSubmit);request.beforeSubmit();submitted++;yield {type:'done',output:output('responses')};});
 const sent=await f.send(),failed=await f.settle(sent.run.id);await f.action(failed,'retry');const blocked=await f.settle(sent.run.id);assert.equal(submitted,0);assert.equal(f.effects.size,0);assert.equal(blocked.run.status,'failed');assert.equal(blocked.run.pauseReason,'AGENT_TASK_CONSENT_REQUIRED');assert.equal(blocked.run.budget,30);assert.equal(blocked.run.stepsUsed,2);
});
test('unchanged target with a retained draft blocks whole undo without compensating other targets',async t=>{
 const f=await fixture(t);f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_shot_update',{shotId:f.other.id,expectedRevision:1,patch:{prompt:'Earlier AI'}}),call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'Draft target AI'}})]:[])};},{loadGroups:['canvas']});const sent=await f.send(),done=await f.settle(sent.run.id);f.runtime.journal.claim({projectId:f.projectId,ownerId:randomUUID(),targets:done.changes.at(-1)!.targets});f.runtime.journal.markClaimsUncertain(f.projectId);
 const fresh=f.runtime.get(f.projectId,sent.run.id);assert.deepEqual(fresh.changes.map(change=>change.undoDisposition),['blocked','blocked']);assert.equal(fresh.changes.at(-1)?.modifiedAfter,false);await assert.rejects(f.action(fresh,'undo_all'),{code:'AGENT_TASK_TARGET_CLAIMED'});assert.deepEqual(f.runtime.journal.snapshot(sent.run.id).changes.map(change=>change.status),['applied','applied']);assert.equal(object(f.store.get('shots',f.other.id)).prompt,'Earlier AI');
});

test('whole undo confirmation cannot expand after a draft is released and replays its rejection receipt',async t=>{
 const f=await fixture(t);f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'First AI'}}),call('mioon_shot_update',{shotId:f.other.id,expectedRevision:1,patch:{prompt:'Second AI'}}),call('mioon_project_rename',{expectedRevision:1,name:'Third AI'})]:[])};},{loadGroups:['canvas']});
 const sent=await f.send(),done=await f.settle(sent.run.id),ownerId=randomUUID();assert.equal(done.changes.length,3);f.runtime.journal.claim({projectId:f.projectId,ownerId,targets:done.changes[1]!.targets});
 const preview=f.runtime.get(f.projectId,sent.run.id),undoChangeIds=preview.changes.filter(change=>change.undoDisposition==='undo').map(change=>change.id);assert.deepEqual(undoChangeIds,[done.changes[2]!.id]);f.runtime.journal.releaseClaims(f.projectId,ownerId);assert.equal(f.runtime.journal.run(sent.run.id).revision,preview.run.revision);
 const request={requestId:randomUUID(),expectedRevision:preview.run.revision,action:'undo_all',undoChangeIds};await assert.rejects(f.runtime.action(f.projectId,sent.run.id,request),{code:'AGENT_TASK_TARGET_CHANGED'});assert.ok(f.runtime.journal.snapshot(sent.run.id).changes.every(change=>change.status==='applied'));assert.equal(object(f.store.get('projects',f.projectId)).name,'Third AI');
 assert.equal(object(f.runtime.journal.lookupControl(request.requestId)?.result).state,'rejected');await f.runtime.action(f.projectId,sent.run.id,request);assert.ok(f.runtime.journal.snapshot(sent.run.id).changes.every(change=>change.status==='applied'));
 await assert.rejects(f.runtime.action(f.projectId,sent.run.id,{...request,undoChangeIds:done.changes.map(change=>change.id)}),{code:'AGENT_TASK_REQUEST_CONFLICT'});
 const fresh=f.runtime.get(f.projectId,sent.run.id),accepted={requestId:randomUUID(),expectedRevision:fresh.run.revision,action:'undo_all',undoChangeIds:fresh.changes.filter(change=>change.undoDisposition==='undo').map(change=>change.id)};const undone=await f.runtime.action(f.projectId,sent.run.id,accepted);assert.equal(undone.run.status,'reverted');assert.ok(undone.changes.every(change=>change.status==='reverted'));f.restart();await f.runtime.action(f.projectId,sent.run.id,accepted);assert.ok(f.runtime.journal.snapshot(sent.run.id).changes.every(change=>change.status==='reverted'));
});
test('a text diagnostic cut off by a restart stops instead of blocking the project, and stays the latest connection test',async t=>{
  const f=await fixture(t),settings=await f.settings.get();assert.deepEqual(f.runtime.latestConnectionTest(),{test:null});
  const created=f.runtime.journal.create({projectId:f.projectId,requestId:randomUUID(),text:'PRIVATE_CONNECTION_TEST_TEXT',configuration:{...settings.configuration},settingsRevision:settings.revision,diagnostic:{profile:'text'}});
  const step=f.runtime.journal.beginStep(created.run.id,{kind:'model',request:{body:'{}',history:[]},data:{baseline:[]}});f.runtime.journal.updateStep(created.run.id,step.id,{status:'dispatch_started'});
  f.restart();const stopped=f.runtime.get(f.projectId,created.run.id);
  assert.equal(stopped.run.status,'stopped');assert.equal(stopped.run.pauseReason,'restart');assert.equal(stopped.steps[0]!.status,'unknown');
  const latest=f.runtime.latestConnectionTest().test!;
  assert.deepEqual({...latest,createdAt:undefined,updatedAt:undefined},{runId:created.run.id,projectId:f.projectId,status:'stopped',protocol:settings.configuration.protocol,baseUrl:settings.configuration.baseUrl,model:settings.configuration.model,createdAt:undefined,updatedAt:undefined});
  assert.doesNotMatch(JSON.stringify(latest),/PRIVATE_CONNECTION_TEST_TEXT/u);
  const sent=await f.send();assert.equal((await f.settle(sent.run.id)).run.status,'completed','A stopped diagnostic leaves the project free for the next send');
});
test('the latest connection test is the newest text diagnostic and reports only a failed run\'s code',async t=>{
  const f=await fixture(t,'chat_completions'),revision=(await f.settings.get()).revision;
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
