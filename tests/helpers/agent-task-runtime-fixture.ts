import {putTestAgentConfiguration,testAgentExecution} from './agent-settings-fixture.ts';
import {DEFAULT_AGENT_CONFIGURATION} from '../../packages/business/src/agent/presets.ts';
import {createMioRecords} from '../../packages/business/src/agent/mio-records.ts';
import {isProjectStore} from '../../packages/business/src/project-file/store.ts';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import type {IncomingMessage} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {openStore} from '../../packages/business/src/project-file/test-store.ts';
import {createServices} from '../../packages/business/src/services.ts';
import type {JobRecord} from '../../packages/business/src/services.ts';
import {createVideoSettingsV2} from '../../packages/business/src/video/settings-v2.ts';
import {createTestAgentSettings,createTestSecretCodec,testSecretStorage} from './secret-codec.ts';
import type {AgentSettingsService} from '../../packages/business/src/agent/settings.ts';
import {createAgentSettingsBroker,createAgentSettingsClient} from '../../apps/desktop/src/secret-broker.ts';
import {createAgentTaskTools} from '../../packages/business/src/agent/task-tools-v2.ts';
import type {PreparedAgentTaskTool,AgentTaskToolContext} from '../../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../../packages/business/src/agent/task-runtime-v2.ts';
import {createAgentTaskJournal} from '../../packages/business/src/agent/task-journal-v2.ts';
import {withAgentTaskJobOrigin} from '../../packages/business/src/agent/task-effects-v2.ts';
import type {Provider,ProviderContext} from '../../packages/business/src/provider-registry.ts';
import type {TaskModelItem,TaskModelRequest,TaskModelOutput} from '../../packages/business/src/agent/task-gateway-v2.ts';
import {createTaskGateway} from '../../packages/business/src/agent/task-gateway-v2.ts';
import {sourceTaskModelToolNames} from '../../packages/business/src/agent/task-context-v2.ts';
import {AGENT_TASK_TOOLS_LOAD_NAME,agentTaskToolNamesForGroup} from '../../packages/business/src/agent/task-tool-groups-v2.ts';
import type {AgentTaskLoadableToolGroupId} from '../../packages/business/src/agent/task-tool-groups-v2.ts';
import {AGENT_TASK_LOCALES} from '../../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTransportDependencies} from '../../packages/business/src/agent/network-policy.ts';
import type {AgentTaskJson,AgentTaskToolCall,AgentTaskStatus,AgentTaskSnapshot,AgentTaskControlAction} from '../../packages/contracts/src/agent-tasks-v2.ts';
import {createTestAuthorizations,authorizeTestScope} from './agent-authorizations.ts';
import {createMockProvider} from '../../packages/business/src/providers/mock.ts';

export function object(value:unknown):Record<string,unknown>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;}
export function textField(value:unknown,field:string):string{const result=object(value)[field];assert.ok(typeof result==='string'&&result.length>0,`Expected ${field} to be a nonempty string`);return result;}
export function revisionField(value:unknown):number{const result=object(value).revision;assert.ok(typeof result==='number'&&Number.isSafeInteger(result)&&result>0,'Expected a positive revision');return result;}
export function mockContext(context:ProviderContext){return {signal:context.signal??undefined,beforeSubmit:context.beforeSubmit,requestId:context.requestId,jobId:context.jobId,...(typeof context.providerRegion==='string'?{providerRegion:context.providerRegion}:{})};}
export function mockProviderAdapter(mock:ReturnType<typeof createMockProvider>):Provider{return {...mock,
 submit:(snapshot,context)=>mock.submit(snapshot,mockContext(context)),reconcile:(id,context)=>mock.reconcile(id,mockContext(context)),poll:(id,context)=>mock.poll(id,mockContext(context)),
 download:(id,destination,context)=>mock.download(id,destination,mockContext(context)),cancel:(id,context)=>mock.cancel(id,mockContext(context)),
};}
export function shot(value:unknown){const row=object(value);return {id:String(row.id),revision:Number(row.revision),prompt:String(row.prompt)};}
export function gate(){let resolve=()=>{};const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
export type Script=(index:number,request:TaskModelRequest)=>AsyncGenerator<TaskModelItem,void,undefined>;
export function output(protocol:'chat_completions'|'responses',calls:AgentTaskToolCall[]=[],text='完成'):TaskModelOutput{return {text,toolCalls:calls,providerOutput:protocol==='responses'?calls.map(call=>({type:'function_call',call_id:call.id,name:call.name,arguments:JSON.stringify(call.arguments),status:'completed'})):{role:'assistant',content:text,tool_calls:calls.map(call=>({id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}))}};}
export const call=(name:string,args:AgentTaskToolCall['arguments']={},id:AgentTaskToolCall['id']=randomUUID()):AgentTaskToolCall=>({id,name,arguments:args});
export function desktopSettingsBridge(settings:AgentSettingsService,selfPort:number){
 const requests:Array<{operation:string;selfPort:unknown}>=[];
 const port=Object.assign(new EventEmitter(),{postMessage(message:unknown){const value=object(message);if(value.type==='agent-settings-request')requests.push({operation:String(value.operation),selfPort:value.selfPort});queueMicrotask(()=>broker.handle(message));}});
 const broker=createAgentSettingsBroker({agentSettings:settings,getSelfPort:()=>selfPort,send:data=>queueMicrotask(()=>port.emit('message',{data}))});
 const client=createAgentSettingsClient({port});
 // Production supplies this same validated transport at the settings boundary.
 return {settings:client as unknown as AgentSettingsService,requests,close(){client.close();broker.close();}};
}
export function syntheticDeniedTransport(address:string,statusCode=401,errorBody='',readFailure=false){
 const counts={dns:0,requests:0,ends:0};
 const dependencies={lookup:async()=>{counts.dns++;return [{address,family:4}];},httpsRequest:(_options:unknown,respond:(response:IncomingMessage)=>void)=>{
  counts.requests++;const request=Object.assign(new EventEmitter(),{setTimeout(){},destroy(){},end(){counts.ends++;const source=readFailure?(async function*(){yield Buffer.from(errorBody);throw Error('PRIVATE_PROVIDER_READ_FAILURE');})():[Buffer.from(errorBody)];respond(Object.assign(Readable.from(source),{statusCode,headers:{'content-type':'text/event-stream'}}) as IncomingMessage);}});
  queueMicrotask(()=>{const socket=Object.assign(new EventEmitter(),{remoteAddress:address,remotePort:443,authorized:true,destroy(){}});request.emit('socket',socket);socket.emit('secureConnect');});return request;
 }} as unknown as AgentTransportDependencies;
 return {counts,gateway:createTaskGateway(dependencies)};
}
export async function fixture(t:TestContext,protocol:'chat_completions'|'responses'='responses',providers:ReadonlyMap<string,Provider>=new Map(),{desktopBridge=false,withVideoSettings=false,safetyStepLimit,mockAllowed=true,imageOptions}:{desktopBridge?:boolean;withVideoSettings?:boolean;safetyStepLimit?:number;mockAllowed?:boolean;imageOptions?:NonNullable<Parameters<typeof createServices>[2]>['imageOptions']}={}){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-task-runtime-v2-')),store=openStore(root);
 const videoSettings=withVideoSettings?await createVideoSettingsV2({directory:join(root,'video-settings'),privateRoot:root,secretCodec:createTestSecretCodec(),storage:testSecretStorage}):undefined;
 const services=createServices(store,providers,{mockAllowed,imageOptions,...(videoSettings?{videoSettings,profileNow:()=>Date.UTC(2026,9,20),videoFetch:async()=>assert.fail('Offline runtime fixture unexpectedly contacted a video provider')}:{})});
 const project=object(await services.call('project.create',{name:'Runtime project'})),projectId=String(project.id);
 const first=shot(await services.call('shot.create',{projectId,title:'First',prompt:'saved first'})),other=shot(await services.call('shot.create',{projectId,title:'Other',prompt:'saved other'}));
 const settings=await createTestAgentSettings({persistence:{load:async()=>null,save:async()=>{}}}),initial=await settings.get();await putTestAgentConfiguration(settings,{expectedRevision:initial.revision,configuration:{...DEFAULT_AGENT_CONFIGURATION,protocol,...(protocol==='chat_completions'?{model:'gpt-5.4-mini'}:{})},secret:{action:'replace',storage:'persistent',value:'SYNTHETIC_LOCAL_TEST_ONLY'}});
 const bridge=desktopBridge?desktopSettingsBridge(settings,4318):null,runtimeSettings=bridge?.settings??settings;
 const authorizations=createTestAuthorizations(()=>store,settings);await authorizeTestScope(authorizations,'project_agent');
 const requests:TaskModelRequest[]=[],scriptRequestIndexes:number[]=[],effects=new Map<string,string>(),baseTools=createAgentTaskTools({store,services});let beforeTool:((prepared:PreparedAgentTaskTool)=>Promise<void>)|undefined,script:Script=async function*(){yield {type:'done',output:output(protocol)};},loadGroups:readonly AgentTaskLoadableToolGroupId[]=[],loadingRequests=0;
 const tools={...baseTools,async execute(prepared:PreparedAgentTaskTool,context:AgentTaskToolContext){await beforeTool?.(prepared);return baseTools.execute(prepared,{...context,beforeEffect(){context.beforeEffect();effects.set(context.stepId,prepared.operation);}});}};
 // Opt-in scripts explicitly perform a real loading round before their domain
 // plan. Audit snapshots, effects and raw request counts include both rounds.
 const gateway=async function*(request:TaskModelRequest){
  requests.push(request);const visible=sourceTaskModelToolNames(protocol,{body:request.body});
  const missing=loadGroups.filter(group=>!agentTaskToolNamesForGroup(group).every(name=>visible.includes(name)));
  if(missing.length&&visible.includes(AGENT_TASK_TOOLS_LOAD_NAME)){loadingRequests++;yield {type:'done' as const,output:output(protocol,[call(AGENT_TASK_TOOLS_LOAD_NAME,{names:missing.flatMap(group=>agentTaskToolNamesForGroup(group))})])};return;}
  scriptRequestIndexes.push(requests.length-1);yield*script(scriptRequestIndexes.length,request);
 };
 const openRuntime=()=>createAgentTaskRuntime({store,agentSettings:runtimeSettings,authorizations,tools,gateway,selfPort:()=>4318,...(safetyStepLimit===undefined?{}:{journal:createAgentTaskJournal(store,{safetyStepLimit})})});
 let runtime=openRuntime();
 t.after(async()=>{runtime.close();baseTools.dispose();bridge?.close();await settings.close();await videoSettings?.close();store.close();rmSync(root,{recursive:true,force:true});});
 return {root,store,services,settings,videoSettings,bridge,authorizations,projectId,first,other,requests,effects,tools,
  get runtime(){return runtime;},get loadingRequests(){return loadingRequests;},get loadingEffects(){return [...effects.values()].filter(operation=>operation==='tools.load').length;},
  loadingSteps(snapshot:AgentTaskSnapshot){return snapshot.steps.filter(step=>step.toolCall?.name===AGENT_TASK_TOOLS_LOAD_NAME||step.kind==='model'&&Array.isArray(object(step.result??{}).toolCalls)&&(object(step.result).toolCalls as AgentTaskToolCall[]).some(call=>call.name===AGENT_TASK_TOOLS_LOAD_NAME)).length;},
  scriptRequest(index:number){const position=scriptRequestIndexes[index-1];assert.notEqual(position,undefined);return requests[position!]!;},
  setScript(value:Script,{loadGroups:groups=[]}:{loadGroups?:readonly AgentTaskLoadableToolGroupId[]}={}){script=value;loadGroups=groups;},beforeTool(value:(prepared:PreparedAgentTaskTool)=>Promise<void>){beforeTool=value;},
  async revoke(){const current=await authorizations.list(),grant=current.authorizations.find(item=>item.scope==='project_agent');assert.ok(grant);await authorizations.revoke({requestId:randomUUID(),expectedRevision:current.revision,authorizationId:grant.id});},
  async send(text='执行测试',requestId:string=randomUUID()){return runtime.send(projectId,{requestId,text,expectedSettingsRevision:testAgentExecution(await settings.get()).revision});},
  async settle(runId:string){await runtime.drain();return runtime.get(projectId,runId);},
  async wait(runId:string,statuses:AgentTaskStatus[]){const deadline=Date.now()+10000;for(;;){const snapshot=runtime.get(projectId,runId);if(statuses.includes(snapshot.run.status))return snapshot;if(Date.now()>deadline)throw Error(`Unexpected task state ${JSON.stringify(snapshot.run)}`);await delay(5);}},
  action(snapshot:AgentTaskSnapshot,action:AgentTaskControlAction,extra:Record<string,unknown>={}){return runtime.action(projectId,snapshot.run.id,{requestId:randomUUID(),expectedRevision:snapshot.run.revision,action,...extra});},
  restart(){runtime.close();runtime=openRuntime();},
 };
}
export type RuntimeFixture=Awaited<ReturnType<typeof fixture>>;
// Events are payload-free invalidations; semantic audit evidence lives in entries.
export function recordedHints(f:RuntimeFixture,runId:string,type:string):Record<string,unknown>[] {
 assert.ok(isProjectStore(f.store));const records=createMioRecords(f.store);
 return records.entries(runId).filter(entry=>entry.kind==='host_hint'||entry.kind==='host_state').flatMap(entry=>{const value=object(records.payload(entry));if(value.type!==type)return [];const {type:_,...data}=value;return [data];});
}
export function setRestartReason(f:RuntimeFixture,runId:string):void {
 const store=f.store;assert.ok(isProjectStore(store));const value=f.runtime.journal.run(runId);
 store.tx(()=>createMioRecords(store).appendEntry({id:randomUUID(),runId,kind:'host_state',createdAt:new Date().toISOString(),payload:{json:{type:'run_state',status:value.status,updatedAt:value.updatedAt,reason:'restart'}}}));
}
/** M4's foreground conflict pause, built with public journal operations. X4
 * hands such conflicts back to the model, but background work and older
 * versions still leave this state. The run must await approval and the claim
 * or saved change must already exist. */
export function m4PauseFromApproval(f:RuntimeFixture,runId:string,reason:'conflict'|'editing'):AgentTaskSnapshot{
 const journal=f.runtime.journal,step=journal.snapshot(runId).steps.find(item=>item.kind==='tool'&&item.status==='awaiting_approval');assert.ok(step);
 journal.updateStep(runId,step.id,{status:'intent',data:{...object(step.data),conflictTargets:JSON.parse(JSON.stringify(journal.conflictingTargets(f.projectId,step.targets??[]))) as AgentTaskJson}});
 journal.transition(runId,journal.run(runId).revision,'paused',reason);
 return f.runtime.get(f.projectId,runId);
}
/** The first script request returns `calls`; its first call waits for
 * approval. Then the conflict appears and the run pauses as M4 paused it.
 * Later script requests return `script(index)`. */
export async function m4ConflictPause(f:RuntimeFixture,{reason,target,calls,script,protocol='responses',locale,text='执行测试',conflict,ownerId,loadGroups=['canvas']}:{reason:'conflict'|'editing';target:{kind:string;id:string};calls:AgentTaskToolCall[];script?:(index:number)=>AgentTaskToolCall[];protocol?:'chat_completions'|'responses';locale?:typeof AGENT_TASK_LOCALES[number];text?:string;conflict?:()=>Promise<unknown>;ownerId?:string;loadGroups?:readonly AgentTaskLoadableToolGroupId[]}){
 const modes=f.runtime.policy().modes;f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...modes,local_reversible:'confirm'}});
 f.setScript(async function*(index){yield {type:'done',output:output(protocol,index===1?calls:script?.(index)??[])};},{loadGroups});
 const sent=await f.runtime.send(f.projectId,{requestId:randomUUID(),text,...(locale?{locale}:{}),expectedSettingsRevision:testAgentExecution(await f.settings.get()).revision});
 const waiting=await f.settle(sent.run.id);assert.equal(waiting.run.status,'awaiting_approval');const stepId=waiting.steps.find(item=>item.status==='awaiting_approval')?.id;assert.ok(stepId);
 f.runtime.journal.updatePolicy({...f.runtime.policy(),modes});
 let owner:string|undefined;
 if(reason==='editing'){owner=ownerId??randomUUID();f.runtime.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId:owner,generation:1,sequence:1,action:'claim',targets:[{kind:target.kind,id:target.id,revision:f.runtime.journal.targetRevision(f.projectId,target.kind,target.id)}]});}
 else if(conflict)await conflict();
 else await f.services.call('shot.update',{shotId:target.id,expectedRevision:revisionField(f.store.get('shots',target.id)),patch:{prompt:'manual conflict'}});
 return {sent,paused:m4PauseFromApproval(f,sent.run.id,reason),stepId,...(owner?{ownerId:owner}:{})};
}

export async function lateSelectionFixture(t:TestContext,mode:'skip'|'deny'|'unhandled',{holdAcceptedGeneration=false,sourceSuffix=false}:{holdAcceptedGeneration?:boolean;sourceSuffix?:boolean}={}){
 let submissions=0;const provider:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},async submit(){submissions++;throw Error('No provider submission is allowed in this test');},async reconcile(){return null;},async poll(){return {status:'running'};},async download(){throw Error('No media download is allowed in this test');}};
 const f=await fixture(t,'responses',new Map([['mock',provider]])),secondEntered=gate(),secondRelease=gate(),thirdEntered=gate(),thirdRelease=gate(),generationEntered=gate(),generationRelease=gate();
 // Hold only the return to the executor: the normal admission transaction has
 // already saved the completed generation step and its original job binding.
 if(holdAcceptedGeneration){const execute=f.tools.execute;f.tools.execute=async(prepared,context)=>{const result=await execute(prepared,context);if(prepared.operation==='generation.submit'){generationEntered.resolve();await generationRelease.promise;}return result;};}
 f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'direct'},acknowledgePaid:true});
 f.setScript(async function*(index){if(index===2){secondEntered.resolve();await secondRelease.promise;}if(mode!=='unhandled'&&index===3){thirdEntered.resolve();await thirdRelease.promise;}
  const calls=index===1?[call('mioon_generation_submit',{shotId:f.first.id,expectedRevision:1,providerId:'mock',model:'mock-motion-v1'}),...(sourceSuffix?[call('mioon_shot_update',{shotId:f.other.id,expectedRevision:1,patch:{prompt:'old batch suffix must not execute'}},'old-batch-suffix')]:[])]:mode==='skip'&&index===2?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'stale automatic edit'}})]:index===(mode==='skip'?3:2)?[call('mioon_shot_update',{shotId:f.other.id,expectedRevision:1,patch:{prompt:'other target continues'}})]:[];
  yield {type:'done',output:output('responses',calls)};
 },{loadGroups:['canvas','video']});
 const sent=await f.send();await (holdAcceptedGeneration?generationEntered.promise:secondEntered.promise);const job=f.store.list('jobs',f.projectId)[0] as JobRecord,step=f.runtime.journal.snapshot(sent.run.id).steps.find(step=>step.toolCall?.name==='mioon_generation_submit');assert.ok(step);
 // Model a previously submitted job through its normal local result boundary.
 // No worker, provider transport or FFmpeg process is started.
 withAgentTaskJobOrigin(f.store.db,'job',job.id,()=>f.services.saveJob(job,{status:'running',phase:'polling',providerJobId:'synthetic-known-submitted-job',submissionCount:1,progress:25}));
 return {...f,sent,jobId:job.id,generationStepId:step.id,secondEntered,secondRelease,thirdRelease,thirdEntered,generationRelease,get submissions(){return submissions;},release(){generationRelease.resolve();secondRelease.resolve();thirdRelease.resolve();}};
}

export function replyOutput(protocol:'chat_completions'|'responses',text:string):TaskModelOutput {
 return {text,toolCalls:[],providerOutput:protocol==='chat_completions'?{role:'assistant',content:text}:[{type:'message',id:'synthetic-output-message',status:'completed',role:'assistant',content:[{type:'output_text',text,annotations:[]}]}]};
}
export function longReadOutput(protocol:'chat_completions'|'responses',text:string,calls:AgentTaskToolCall[]):TaskModelOutput {
 const reply=replyOutput(protocol,text);reply.toolCalls=calls;
 reply.providerOutput=protocol==='chat_completions'
  ?{role:'assistant',content:text,...(calls.length?{tool_calls:calls.map(item=>({id:item.id,type:'function',function:{name:item.name,arguments:JSON.stringify(item.arguments)}}))}:{})}
  :[...(reply.providerOutput as AgentTaskJson[]),...calls.map(item=>({type:'function_call',call_id:item.id,name:item.name,arguments:JSON.stringify(item.arguments),status:'completed'}))];
 return reply;
}
export async function noteHistoryFixture(t:TestContext,protocol:'chat_completions'|'responses',messageLength=30000){
 const f=await fixture(t,protocol);let conversationId:string|undefined;
 f.setScript(async function*(){yield {type:'done',output:replyOutput(protocol,'a'.repeat(2000))};});
 for(let index=0;index<3;index++){
  const sent=await f.runtime.send(f.projectId,{requestId:randomUUID(),text:'u'.repeat(messageLength),expectedSettingsRevision:testAgentExecution(await f.settings.get()).revision,...(conversationId?{conversationId}:{})});
  const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');conversationId=done.run.conversationId;
 }
 return {...f,sendNext:async()=>f.runtime.send(f.projectId,{requestId:randomUUID(),text:'u'.repeat(messageLength),expectedSettingsRevision:testAgentExecution(await f.settings.get()).revision,conversationId})};
}
export const runPaused=(f:RuntimeFixture,runId:string):boolean=>recordedHints(f,runId,'run_state').some(state=>state.status==='paused');
export const staleRevisionMessages:Record<typeof AGENT_TASK_LOCALES[number],string>={'zh-Hans':'参数里的修订号已过期，这一步没有执行，项目没有改动。请先重新读取目标的当前内容，再用新的修订号修改，不要重放旧参数。','zh-Hant':'參數裡的修訂號已過期，這一步沒有執行，專案沒有變更。請先重新讀取目標目前的內容，再用新的修訂號修改，不要重放舊參數。',en:'The revision in your arguments is out of date, so this step did not run and nothing changed. Read the target again first, then make the change with its current revision instead of replaying the old arguments.',ja:'引数のリビジョンが古いため、このステップは実行されず、何も変更されていません。まず対象を読み直し、現在のリビジョンで変更してください。古い引数を再利用しないでください。'};
export const projectRereadMessages:Record<typeof AGENT_TASK_LOCALES[number],string>={'zh-Hans':'目标在你读取后已变化，例如新增或删除了镜头，这一步没有执行。current 为空，没有可交回的值。请先重新读取项目，再按当前内容重新规划，不要重放旧参数。','zh-Hant':'目標在你讀取後已變化，例如新增或刪除了鏡頭，這一步沒有執行。current 為空，沒有可交回的值。請先重新讀取專案，再按目前的內容重新規劃，不要重放舊參數。',en:'The targets changed after you read them, for example a shot was added or deleted, so this step did not run. current is empty because there is no saved value to return. Read the project again first, then replan from its current state instead of replaying the old arguments.',ja:'読み取った後に対象が変わったため（ショットの追加や削除など）、このステップは実行されませんでした。返せる保存値がないため current は空です。まずプロジェクトを読み直し、現在の状態から計画し直してください。古い引数を再利用しないでください。'};
export const staleShotUpdate=(f:RuntimeFixture,id=randomUUID())=>call('mioon_shot_update',{shotId:f.first.id,expectedRevision:7,patch:{prompt:'stale revision'}},id);
