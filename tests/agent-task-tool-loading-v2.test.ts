import {putTestAgentConfiguration,testAgentExecution} from './helpers/agent-settings-fixture.ts';
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import type {PreparedAgentTaskTool,AgentTaskToolContext} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../packages/business/src/agent/task-runtime-v2.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {buildTaskModelRequest} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskModelItem,TaskModelOutput,TaskModelRequest} from '../packages/business/src/agent/task-gateway-v2.ts';
import {selectTaskModelTools,sourceTaskModelToolNames,sourceTaskModelToolLoadMode,sourceTaskModelToolLoadInputAllowed} from '../packages/business/src/agent/task-context-v2.ts';
import {AGENT_TASK_ASK_TOOL,AGENT_TASK_TOOLS_LOAD_NAME,AGENT_TASK_LOADABLE_TOOL_GROUP_IDS,agentTaskToolGroupForName,AGENT_TASK_CONVERSATION_TOOLS} from '../packages/business/src/agent/task-tool-groups-v2.ts';
import type {AgentProtocol} from '../packages/contracts/src/agent-protocol.ts';
import type {AgentTaskJson,AgentTaskToolCall,AgentTaskSnapshot,AgentTaskStatus,AgentTaskControlAction} from '../packages/contracts/src/agent-tasks-v2.ts';
import {createTestAuthorizations,authorizeTestScope} from './helpers/agent-authorizations.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

const protocols=['chat_completions','responses','anthropic_messages'] as const satisfies readonly AgentProtocol[];
function object(value:unknown):Record<string,unknown>{assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;}
function gate(){let resolve=()=>{};const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
const call=(name:string,args:AgentTaskJson={}):AgentTaskToolCall=>({id:randomUUID(),name,arguments:args});
function output(protocol:AgentProtocol,calls:AgentTaskToolCall[]=[],text='Complete.'):TaskModelOutput{
 const providerOutput:AgentTaskJson=protocol==='anthropic_messages'?{role:'assistant',content:[{type:'text',text},...calls.map(item=>({type:'tool_use',id:item.id,name:item.name,input:item.arguments}))]}
  :protocol==='responses'?[{type:'message',role:'assistant',content:[{type:'output_text',text}]},...calls.map(item=>({type:'function_call',call_id:item.id,name:item.name,arguments:JSON.stringify(item.arguments),status:'completed'}))]
  :{role:'assistant',content:text,...(calls.length?{tool_calls:calls.map(item=>({id:item.id,type:'function',function:{name:item.name,arguments:JSON.stringify(item.arguments)}}))}:{})};
 return {text,toolCalls:calls,providerOutput};
}
function visible(request:TaskModelRequest):string[]{return sourceTaskModelToolNames(request.configuration.protocol,{body:request.body});}
function legacyLoaderRequest(configuration:AgentConfiguration,history:AgentTaskJson[],tools:Parameters<typeof buildTaskModelRequest>[2]):string{
 const body=object(JSON.parse(buildTaskModelRequest(configuration,history,tools,4318))),entries=body.tools;assert.ok(Array.isArray(entries));
 for(const entry of entries){const wire=object(entry),definition=configuration.protocol==='chat_completions'?object(wire.function):wire;if(definition.name!==AGENT_TASK_TOOLS_LOAD_NAME)continue;
  const key=configuration.protocol==='anthropic_messages'?'input_schema':'parameters',schema=object(definition[key]),properties=object(schema.properties);
  schema.properties={groups:{type:'array',items:{type:'string',enum:AGENT_TASK_LOADABLE_TOOL_GROUP_IDS},minItems:1,maxItems:AGENT_TASK_LOADABLE_TOOL_GROUP_IDS.length},...(properties._mio_step?{_mio_step:properties._mio_step}:{})};schema.required=['groups'];
 }
 return JSON.stringify(body);
}
type Script=(index:number,request:TaskModelRequest)=>AsyncGenerator<TaskModelItem,void,undefined>;
async function fixture(t:TestContext,protocol:AgentProtocol='responses',safetyStepLimit?:number){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-tool-loading-v2-')),store=openStore(root),services=createServices(store,new Map());
 const project=object(await services.call('project.create',{name:'Tool loading test'})),projectId=String(project.id);
 const shot=object(await services.call('shot.create',{projectId,title:'Original',prompt:'Keep this until actually executed.'}));
 const settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}});
 await putTestAgentConfiguration(settings,{expectedRevision:0,configuration:{presetId:'ollama',platformId:'local',protocol,model:'qwen3:8b',baseUrl:`http://127.0.0.1:11434${protocol==='anthropic_messages'?'':'/v1'}`},secret:{action:'remove'}});
 const authorizations=createTestAuthorizations(()=>({...store}),settings);await authorizeTestScope(authorizations,'project_agent');
 const base=createAgentTaskTools({store,services}),prepared:string[]=[],executed:string[]=[],requests:TaskModelRequest[]=[];
 let script:Script=async function*(){yield {type:'done',output:output(protocol)};},beforeExecute:((prepared:PreparedAgentTaskTool)=>void)|undefined;
 const tools={...base,prepare(input:Parameters<typeof base.prepare>[0]){prepared.push(input.operation);return base.prepare(input);},async execute(value:PreparedAgentTaskTool,context:AgentTaskToolContext){executed.push(value.operation);beforeExecute?.(value);return base.execute(value,context);}};
 const gateway=async function*(request:TaskModelRequest){request.beforeSubmit?.();requests.push(request);yield*script(requests.length,request);};
 const openRuntime=()=>createAgentTaskRuntime({store,agentSettings:settings,authorizations,tools,gateway,selfPort:()=>4318,...(safetyStepLimit===undefined?{}:{journal:createAgentTaskJournal(store,{safetyStepLimit})})});
 let runtime=openRuntime();
 t.after(async()=>{runtime.close();base.dispose();await settings.close();store.close();rmSync(root,{recursive:true,force:true});});
 return {store,services,projectId,shot,settings,tools,prepared,executed,requests,get runtime(){return runtime;},
  script(value:Script){script=value;},beforeExecute(value:(prepared:PreparedAgentTaskTool)=>void){beforeExecute=value;},
  async send(extra:Record<string,unknown>={}){return runtime.send(projectId,{requestId:randomUUID(),text:'Run the synthetic tool plan.',expectedSettingsRevision:testAgentExecution(await settings.get()).revision,...extra});},
  async sendLegacy(){
   const saved=await settings.get(),context:AgentTaskJson[]=[{role:'user',content:'Continue the frozen group-loader intent.'}],body=legacyLoaderRequest(testAgentExecution(saved).configuration,context,selectTaskModelTools(base.list()));
   const created=runtime.journal.create({projectId,requestId:randomUUID(),text:'Continue the frozen group-loader intent.',configuration:{...testAgentExecution(saved).configuration},settingsRevision:testAgentExecution(saved).revision,settingsBinding:testAgentExecution(saved).binding,context});
   runtime.journal.beginModelStep(created.run.id,{request:{body,history:context},data:{baseline:runtime.journal.revisionSnapshot(projectId).map(({kind,id,revision})=>({kind,id,revision}))}},[]);
   runtime.close();runtime=openRuntime();
   return runtime.action(projectId,created.run.id,{requestId:randomUUID(),expectedRevision:runtime.get(projectId,created.run.id).run.revision,action:'resume'});
  },
  async sendFrozenNames(names:string[]){
   const saved=await settings.get(),context:AgentTaskJson[]=[{role:'user',content:'Continue the frozen name-loader intent.'}];
   const body=object(JSON.parse(buildTaskModelRequest(testAgentExecution(saved).configuration,context,selectTaskModelTools(base.list()),4318)));
   assert.ok(Array.isArray(body.tools));
   for(const entry of body.tools){
    const wire=object(entry),definition=protocol==='chat_completions'?object(wire.function):wire;
    if(definition.name!==AGENT_TASK_TOOLS_LOAD_NAME)continue;
    const schema=object(definition[protocol==='anthropic_messages'?'input_schema':'parameters']),selection=object(object(schema.properties).names);
    object(selection.items).enum=names;selection.maxItems=names.length;
   }
   const original=JSON.stringify(body),created=runtime.journal.create({projectId,requestId:randomUUID(),text:'Continue the frozen name-loader intent.',configuration:{...testAgentExecution(saved).configuration},settingsRevision:testAgentExecution(saved).revision,settingsBinding:testAgentExecution(saved).binding,context});
   runtime.journal.beginModelStep(created.run.id,{request:{body:original,history:context},data:{baseline:runtime.journal.revisionSnapshot(projectId).map(({kind,id,revision})=>({kind,id,revision}))}},[]);
   runtime.close();runtime=openRuntime();
   const sent=await runtime.action(projectId,created.run.id,{requestId:randomUUID(),expectedRevision:runtime.get(projectId,created.run.id).run.revision,action:'resume'});
   return {sent,original};
  },
  async settle(runId:string){await runtime.drain();return runtime.get(projectId,runId);},
  async wait(runId:string,statuses:AgentTaskStatus[]){const end=Date.now()+10000;for(;;){const current=runtime.get(projectId,runId);if(statuses.includes(current.run.status))return current;if(Date.now()>end)throw Error(`Unexpected task status ${current.run.status}`);await delay(2);}},
  action(snapshot:AgentTaskSnapshot,action:AgentTaskControlAction,extra:Record<string,unknown>={}){return runtime.action(projectId,snapshot.run.id,{requestId:randomUUID(),expectedRevision:snapshot.run.revision,action,...extra});},
  restart(){runtime.close();runtime=openRuntime();},
 };
}

function staleCanvasReceipt(f:Awaited<ReturnType<typeof fixture>>,runId:string){
 const load=f.runtime.get(f.projectId,runId).steps.find(step=>step.toolCall?.name===AGENT_TASK_TOOLS_LOAD_NAME&&step.status==='completed');assert.ok(load);
 const result=object(load.result);assert.ok(Array.isArray(result.tools));
 // Model a saved catalog from before a tool was added, with a retired name as
 // well. The receipt's group identity survives both kinds of catalog change.
 const stale={groups:result.groups as AgentTaskJson,tools:[...result.tools.filter(name=>name!=='mioon_shot_update'),'mioon_retired_canvas_tool']};
 f.runtime.journal.updateStep(runId,load.id,{result:stale});return {id:load.id,result:stale};
}

for(const protocol of protocols)test(`${protocol}: a stale load receipt survives restart and exposes current group members`,async t=>{
 const f=await fixture(t,protocol,1);
 f.script(async function*(index){yield {type:'done',output:output(protocol,index===1?[call(AGENT_TASK_TOOLS_LOAD_NAME,{groups:['canvas']})]:[])};});
 const sent=await f.sendLegacy(),paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,'safety_limit');
 const stale=staleCanvasReceipt(f,sent.run.id);f.restart();await f.action(f.runtime.get(f.projectId,sent.run.id),'resume');
 const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.requests.length,2);
 assert.deepEqual(visible(f.requests[1]!),f.tools.list().filter(tool=>['core','canvas'].includes(agentTaskToolGroupForName(tool.name)??'')).map(tool=>tool.name));
 assert.ok(visible(f.requests[1]!).includes('mioon_shot_update'));assert.ok(!visible(f.requests[1]!).includes('mioon_retired_canvas_tool'));
 assert.deepEqual(done.steps.find(step=>step.id===stale.id)?.result,stale.result);
});

for(const protocol of protocols)test(`${protocol}: a note with a stale load receipt succeeds without faulting later work`,async t=>{
 const f=await fixture(t,protocol),entered=gate(),release=gate(),note='Keep the colours after upgrading.';
 f.script(async function*(index){
  if(index===1)yield {type:'done',output:output(protocol,[call(AGENT_TASK_TOOLS_LOAD_NAME,{groups:['canvas']})])};
  else if(index===2){entered.resolve();await release.promise;yield {type:'done',output:output(protocol,[call('mioon_project_inspect')])};}
  else yield {type:'done',output:output(protocol)};
 });
 const sent=await f.sendLegacy();await entered.promise;const stale=staleCanvasReceipt(f,sent.run.id);
 try{const noted=await f.action(f.runtime.get(f.projectId,sent.run.id),'note',{text:note});assert.equal(noted.run.notes?.[0]?.text,note);}
 finally{release.resolve();}
 const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.requests.length,3);
 assert.ok(f.requests[2]!.body.includes(note));assert.ok(done.run.notes?.[0]?.modelStepId);
 assert.deepEqual(visible(f.requests[2]!),f.tools.list().filter(tool=>['core','canvas'].includes(agentTaskToolGroupForName(tool.name)??'')).map(tool=>tool.name));
 assert.deepEqual(done.steps.find(step=>step.id===stale.id)?.result,stale.result);
 // A store holds one project, so another project never shares this runtime;
 // the runtime that read the stale receipt still runs later unrelated work.
 const next=await f.runtime.send(f.projectId,{requestId:randomUUID(),text:'Continue unrelated work.',expectedSettingsRevision:testAgentExecution(await f.settings.get()).revision});
 await f.runtime.drain();assert.equal(f.runtime.get(f.projectId,next.run.id).run.status,'completed');
});

for(const protocol of protocols)test(`${protocol}: a load in the same response cannot make an undisclosed edit prepare or request approval`,async t=>{
 const f=await fixture(t,protocol),entered=gate(),release=gate(),edit=call('mioon_shot_update',{shotId:String(f.shot.id),expectedRevision:1,patch:{title:'Only the later request may edit'}});
 f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,local_reversible:'confirm'}});
 f.script(async function*(index){
  if(index===1)yield {type:'done',output:output(protocol,[call(AGENT_TASK_TOOLS_LOAD_NAME,{names:[edit.name]}),edit])};
  else if(index===2){entered.resolve();await release.promise;yield {type:'done',output:output(protocol,[{...edit,id:randomUUID()}])};}
  else yield {type:'done',output:output(protocol)};
 });
 const sent=await f.send();await entered.promise;
 try{
  const between=f.runtime.get(f.projectId,sent.run.id),rejected=between.steps.find(step=>step.toolCall?.id===edit.id);
  assert.equal(rejected?.status,'rejected');assert.equal(object(object(rejected?.result).error).code,'TOOL_NOT_LOADED');assert.equal(object(object(rejected?.result).error).group,'canvas');
  assert.equal(between.run.status,'running');assert.ok(between.steps.every(step=>step.status!=='awaiting_approval'));
  assert.deepEqual(f.prepared,[AGENT_TASK_TOOLS_LOAD_NAME]);assert.deepEqual(f.executed,['tools.load']);
  assert.equal(object(f.store.get('shots',String(f.shot.id))).title,'Original');
  assert.ok(!visible(f.requests[0]!).includes(edit.name));assert.ok(visible(f.requests[1]!).includes(edit.name));
  assert.ok(f.requests[0]!.knownTools?.some(tool=>tool.name===edit.name),'Trusted parsing catalog includes known hidden names');
 }finally{release.resolve();}
 const waiting=await f.wait(sent.run.id,['awaiting_approval']);await f.runtime.drain();
 assert.equal(f.prepared.filter(name=>name===edit.name).length,1);assert.equal(f.executed.filter(name=>name==='shot.update').length,0);
 await f.action(waiting,'approve',{stepId:waiting.steps.at(-1)!.id});const done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(done.steps.length,6);assert.equal(done.changes.length,1);assert.equal(f.executed.filter(name=>name==='shot.update').length,1);
 assert.equal(object(f.store.get('shots',String(f.shot.id))).title,'Only the later request may edit');
});

test('loaded names accumulate only in this run, retain catalog order and reset for a later conversation round',async t=>{
 const f=await fixture(t);f.script(async function*(index){yield {type:'done',output:output('responses',index===1?[call(AGENT_TASK_TOOLS_LOAD_NAME,{names:['mioon_shot_update']})]:index===2?[call(AGENT_TASK_TOOLS_LOAD_NAME,{names:['mioon_asset_range_set']})]:index===3?[call(AGENT_TASK_TOOLS_LOAD_NAME,{names:['mioon_shot_update']})]:[])};});
 const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');
 const catalog=f.tools.list();
 assert.deepEqual(visible(f.requests[0]!),catalog.filter(tool=>agentTaskToolGroupForName(tool.name)==='core').map(tool=>tool.name));
 assert.deepEqual(visible(f.requests[1]!),catalog.filter(tool=>agentTaskToolGroupForName(tool.name)==='core'||tool.name==='mioon_shot_update').map(tool=>tool.name));
 assert.deepEqual(visible(f.requests[2]!),catalog.filter(tool=>agentTaskToolGroupForName(tool.name)==='core'||['mioon_shot_update','mioon_asset_range_set'].includes(tool.name)).map(tool=>tool.name));
 assert.deepEqual(visible(f.requests[3]!),visible(f.requests[2]!));
 assert.deepEqual(done.steps.filter(step=>step.toolCall?.name===AGENT_TASK_TOOLS_LOAD_NAME).at(-1)?.result,{names:[]});
 await f.settle((await f.send({conversationId:done.run.conversationId})).run.id);
 assert.deepEqual(visible(f.requests[4]!),visible(f.requests[0]!));
});

test('selected attachments expose both scoped import tools without loading their groups',async t=>{
 const f=await fixture(t),selected=object(await f.tools.stageImport({projectId:f.projectId,requestId:randomUUID(),name:'Selected source.png',mimeType:'image/png',dataBase64:png().toString('base64')}));
 const sent=await f.send({uploads:[String(selected.id)]});assert.equal((await f.settle(sent.run.id)).run.status,'completed');
 for(const name of ['mioon_asset_import_selected','mioon_lut_import_selected'])assert.ok(visible(f.requests[0]!).includes(name));
 assert.ok(!visible(f.requests[0]!).includes('mioon_asset_range_set'));assert.ok(!visible(f.requests[0]!).includes('mioon_lut_list'));
 const empty=await f.send();await f.settle(empty.run.id);assert.ok(!visible(f.requests[1]!).includes('mioon_asset_import_selected'));assert.ok(!visible(f.requests[1]!).includes('mioon_lut_import_selected'));
});

test('a confirmed read-only load reaches the safety limit and survives restart before the next model request',async t=>{
 const f=await fixture(t,'responses',2);f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,read_only:'confirm'}});
 f.script(async function*(index){yield {type:'done',output:output('responses',index===1?[call(AGENT_TASK_TOOLS_LOAD_NAME,{names:['mioon_shot_update']})]:[])};});
 const sent=await f.send(),waiting=await f.wait(sent.run.id,['awaiting_approval']);await f.runtime.drain();
 assert.equal(waiting.run.stepsUsed,2);assert.ok(!selectTaskModelTools(f.tools.list(),undefined,{steps:waiting.steps}).some(tool=>tool.name==='mioon_shot_update'));
 await f.action(waiting,'approve',{stepId:waiting.steps.at(-1)!.id});const limited=await f.settle(sent.run.id);
 assert.equal(limited.run.pauseReason,'safety_limit');assert.equal(f.requests.length,1);assert.equal(limited.steps.at(-1)?.status,'completed');
 f.restart();const interrupted=f.runtime.get(f.projectId,sent.run.id);await f.action(interrupted,'resume');const done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(done.run.stepsUsed,3);assert.deepEqual(f.runtime.journal.safetyWindow(sent.run.id),{startStepsUsed:2,afterPosition:2,remaining:1});assert.ok(visible(f.requests[1]!).includes('mioon_shot_update'));
});

for(const outcome of ['rejected','unknown'] as const)test(`${outcome} load evidence does not expand visibility`,async t=>{
 const f=await fixture(t);f.script(async function*(index){yield {type:'done',output:output('responses',index===1?[call(AGENT_TASK_TOOLS_LOAD_NAME,{names:outcome==='rejected'?['not-a-tool']:['mioon_shot_update']})]:[])};});
 if(outcome==='unknown')f.beforeExecute(prepared=>{if(prepared.operation==='tools.load')throw Object.assign(Error('Synthetic unknown load'),{code:'AGENT_TASK_UNKNOWN_RESULT'});});
 const sent=await f.send(),done=await f.settle(sent.run.id),step=done.steps.find(step=>step.toolCall?.name===AGENT_TASK_TOOLS_LOAD_NAME);
 assert.equal(step?.status,outcome);assert.ok(!selectTaskModelTools(f.tools.list(),undefined,{steps:done.steps}).some(tool=>tool.name==='mioon_shot_update'));assert.equal(done.changes.length,0);assert.equal(f.requests.length,outcome==='unknown'?1:2);
 if(outcome==='rejected'){assert.equal(step.error?.code,'VALIDATION_ERROR');assert.deepEqual(f.prepared,[]);}
});

for(const protocol of protocols)test(`${protocol}: a legacy full-catalog unsent intent keeps its original body and may execute its disclosed edit`,async t=>{
 const f=await fixture(t,protocol),settings=await f.settings.get(),context:AgentTaskJson[]=[{role:'user',content:'Legacy full-catalog request.'}];
 const original=buildTaskModelRequest(testAgentExecution(settings).configuration,context,f.tools.list().filter(tool=>tool.name!==AGENT_TASK_TOOLS_LOAD_NAME),4318);
 const created=f.runtime.journal.create({projectId:f.projectId,requestId:randomUUID(),text:'Legacy full-catalog request.',configuration:{...testAgentExecution(settings).configuration},settingsRevision:testAgentExecution(settings).revision,settingsBinding:testAgentExecution(settings).binding,context});
 const model=f.runtime.journal.beginModelStep(created.run.id,{request:{body:original,history:context},data:{baseline:f.runtime.journal.revisionSnapshot(f.projectId).map(({kind,id,revision})=>({kind,id,revision}))}},[]);
 f.script(async function*(index){yield {type:'done',output:output(protocol,index===1?[call('mioon_shot_update',{shotId:String(f.shot.id),expectedRevision:1,patch:{title:'Legacy disclosed edit'}})]:[])};});
 f.restart();await f.action(f.runtime.get(f.projectId,created.run.id),'resume');const done=await f.settle(created.run.id);
 assert.equal(done.run.status,'completed');assert.equal(f.requests[0]!.body,original);assert.equal(object(f.runtime.journal.step(model.id).request).body,original);
 assert.equal(object(f.store.get('shots',String(f.shot.id))).title,'Legacy disclosed edit');assert.equal(done.changes.length,1);assert.ok(done.steps.every(step=>step.toolCall?.name!==AGENT_TASK_TOOLS_LOAD_NAME));
 assert.ok(!visible(f.requests[1]!).includes('mioon_shot_update'),'An old catalog does not persist as a loaded group');
});

for(const protocol of protocols)test(`${protocol}: a real zero-tool legacy intent rejects a known hidden call without preparing it`,async t=>{
 const f=await fixture(t,protocol),settings=await f.settings.get(),context:AgentTaskJson[]=[{role:'user',content:'Legacy text-only request.'}];
 const original=buildTaskModelRequest(testAgentExecution(settings).configuration,context,[],4318);assert.deepEqual(sourceTaskModelToolNames(protocol,{body:original}),[]);
 const created=f.runtime.journal.create({projectId:f.projectId,requestId:randomUUID(),text:'Legacy text-only request.',configuration:{...testAgentExecution(settings).configuration},settingsRevision:testAgentExecution(settings).revision,settingsBinding:testAgentExecution(settings).binding,context});
 const model=f.runtime.journal.beginModelStep(created.run.id,{request:{body:original,history:context},data:{baseline:[]}},[]);
 f.script(async function*(index){yield {type:'done',output:output(protocol,index===1?[call('mioon_shot_update',{shotId:String(f.shot.id),expectedRevision:1,patch:{title:'Never prepared'}})]:[])};});
 f.restart();await f.action(f.runtime.get(f.projectId,created.run.id),'resume');const done=await f.settle(created.run.id);
 assert.equal(done.run.status,'completed');assert.equal(f.requests[0]!.body,original);assert.equal(object(f.runtime.journal.step(model.id).request).body,original);
 assert.equal(done.steps.find(step=>step.kind==='tool')?.error?.code,'TOOL_NOT_LOADED');assert.equal(done.changes.length,0);
 assert.deepEqual(f.prepared,[]);assert.deepEqual(f.executed,[]);assert.equal(object(f.store.get('shots',String(f.shot.id))).title,'Original');
});

test('diagnostics retain their old catalog and cannot select or execute the new loader',async t=>{
 // No conversation-only host tool joins a diagnostic: the loader is new, a diagnostic has no conversation to
 // answer a question in, and it neither reads methods nor reports a review (C6).
 const f=await fixture(t),oldCatalog=f.tools.diagnosticList().filter(tool=>!AGENT_TASK_CONVERSATION_TOOLS.includes(tool.name));
 // Frozen from main 9f5fd08b: preserve every diagnostic name, its order and risk
 // independently of the native conversation catalog introduced by R2.
 assert.equal(oldCatalog.length,104);
 assert.equal(createHash('sha256').update(JSON.stringify(oldCatalog.map(({name,risk})=>({name,risk})))).digest('hex'),'966a29331ba3b88284cbc08346c75a5620faf2ff6f502a397567cfa3dfe3906c');
 assert.ok(oldCatalog.some(tool=>tool.name==='mioon_project_notes_set'));
 assert.ok(!oldCatalog.some(tool=>tool.name==='mioon_project_rules_set'));
 assert.ok(f.tools.list().some(tool=>tool.name==='mioon_project_rules_set'));
 assert.ok(!f.tools.list().some(tool=>tool.name==='mioon_project_notes_set'));
 for(const profile of ['text','read_only','catalog'] as const){
  const before=f.requests.length,sent=await f.send({diagnostic:{profile}});assert.equal((await f.settle(sent.run.id)).run.status,'completed');
  const body=object(JSON.parse(f.requests[before]!.body));
  const names=Array.isArray(body.tools)?visible(f.requests[before]!):[];
  assert.deepEqual(names,profile==='text'?[]:oldCatalog.filter(tool=>profile!=='read_only'||tool.risk==='read_only').map(tool=>tool.name));
  assert.equal(f.requests[before]!.knownTools,undefined);assert.ok(!f.requests[before]!.body.includes(AGENT_TASK_TOOLS_LOAD_NAME));
 }
 await assert.rejects(f.send({diagnostic:{profile:'catalog',toolNames:[AGENT_TASK_TOOLS_LOAD_NAME]}}),{code:'AGENT_TASK_INVALID'});
 await assert.rejects(f.send({diagnostic:{profile:'catalog',toolNames:[AGENT_TASK_ASK_TOOL]}}),{code:'AGENT_TASK_INVALID'});
 await assert.rejects(f.send({diagnostic:{profile:'catalog',toolNames:['mioon_project_rules_set']}}),{code:'AGENT_TASK_INVALID'});
 assert.deepEqual(f.prepared,[]);assert.deepEqual(f.executed,[]);
});

for(const protocol of protocols)test(`${protocol}: missing or malformed source catalogs fail closed`,()=>{
 for(const request of [undefined,{body:'{'},{body:'{"tools":null}'},{body:'{"tools":[{}]}'},{body:JSON.stringify({tools:[{type:'function',name:'mioon_project_inspect',function:{name:'mioon_project_inspect'}},{type:'function',name:'mioon_project_inspect',function:{name:'mioon_project_inspect'}}]})}])assert.throws(()=>sourceTaskModelToolNames(protocol,request),{code:'AGENT_TASK_STORAGE_UNAVAILABLE'});
});

for(const protocol of protocols)for(const mode of ['names','groups'] as const)test(`${protocol}: a frozen ${mode} loader rejects the other parameter shape before prepare`,async t=>{
 const f=await fixture(t,protocol),input:AgentTaskJson=mode==='names'?{groups:['canvas']}:{names:['mioon_shot_update']};
 f.script(async function*(index){yield {type:'done',output:output(protocol,index===1?[call(AGENT_TASK_TOOLS_LOAD_NAME,input)]:[])};});
 const sent=mode==='groups'?await f.sendLegacy():await f.send(),done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(done.changes.length,0);
 const denied=done.steps.find(step=>step.toolCall?.name===AGENT_TASK_TOOLS_LOAD_NAME);assert.equal(denied?.status,'rejected');assert.equal(denied?.error?.code,'VALIDATION_ERROR');
 assert.deepEqual(f.prepared,[]);assert.deepEqual(f.executed,[]);assert.equal(f.requests.length,2);
 assert.ok(!visible(f.requests[1]!).includes('mioon_shot_update'));
 assert.equal(sourceTaskModelToolLoadMode(protocol,{body:f.requests[0]!.body}),mode);
});

for(const protocol of protocols)test(`${protocol}: frozen loader enums constrain later names and schema modes independently of metadata`,async t=>{
 const f=await fixture(t,protocol),configuration=testAgentExecution(await f.settings.get()).configuration,history:AgentTaskJson[]=[{role:'user',content:'Frozen loader limits.'}];
 const original=object(JSON.parse(buildTaskModelRequest(configuration,history,selectTaskModelTools(f.tools.list()),4318))),entries=original.tools;assert.ok(Array.isArray(entries));
 const wire=entries.map(object).find(entry=>object(protocol==='chat_completions'?entry.function:entry).name===AGENT_TASK_TOOLS_LOAD_NAME);assert.ok(wire);
 const definition=protocol==='chat_completions'?object(wire.function):wire,key=protocol==='anthropic_messages'?'input_schema':'parameters',schema=object(definition[key]),selection=object(object(schema.properties).names);
 object(selection.items).enum=['mioon_shot_update'];wire.cache_control={type:'ephemeral'};
 const request={body:JSON.stringify(original)};
 assert.equal(sourceTaskModelToolLoadMode(protocol,request),'names');
 assert.equal(sourceTaskModelToolLoadInputAllowed(protocol,request,{names:['mioon_shot_update']}),true);
 assert.equal(sourceTaskModelToolLoadInputAllowed(protocol,request,{names:['mioon_shot_create']}),false,'a name added after the intent cannot be guessed');
 assert.equal(sourceTaskModelToolLoadInputAllowed(protocol,request,{groups:['canvas']}),false);
 const legacy={body:legacyLoaderRequest(configuration,history,selectTaskModelTools(f.tools.list()))};
 assert.equal(sourceTaskModelToolLoadMode(protocol,legacy),'groups');assert.equal(sourceTaskModelToolLoadInputAllowed(protocol,legacy,{groups:['canvas']}),true);
 assert.equal(sourceTaskModelToolLoadInputAllowed(protocol,legacy,{names:['mioon_shot_update']}),false);
 const properties=object(schema.properties);properties.groups={type:'array'};
 assert.throws(()=>sourceTaskModelToolLoadMode(protocol,{body:JSON.stringify(original)}),{code:'AGENT_TASK_STORAGE_UNAVAILABLE'});
 delete properties.groups;schema.anyOf=[];
 assert.throws(()=>sourceTaskModelToolLoadMode(protocol,{body:JSON.stringify(original)}),{code:'AGENT_TASK_STORAGE_UNAVAILABLE'});
 delete schema.anyOf;object(selection.items).not={enum:['mioon_shot_update']};
 assert.throws(()=>sourceTaskModelToolLoadMode(protocol,{body:JSON.stringify(original)}),{code:'AGENT_TASK_STORAGE_UNAVAILABLE'},'unrecognized frozen item constraints cannot be ignored');
});

const coreNames=['mioon_timeline_inspect','mioon_timeline_format_get'];
const unknownNames=['mioon_missing_timeline_tool','mioon_other_missing_tool'];
for(const protocol of protocols)for(const selection of ['core_only','core_and_valid','core_unknown_and_valid','unknown_only'] as const)
test(`${protocol}: invalid ${selection} loading identifies each name without changing frozen admission`,async t=>{
 const f=await fixture(t,protocol),names=selection==='core_only'?coreNames:selection==='core_and_valid'?[coreNames[0]!,'mioon_shot_update']:selection==='unknown_only'?unknownNames:[coreNames[0]!,...unknownNames,'mioon_shot_update'];
 f.script(async function*(index){yield {type:'done',output:output(protocol,index===1?[call(AGENT_TASK_TOOLS_LOAD_NAME,{names})]:[])};});
 const done=await f.settle((await f.send({locale:'zh-Hans'})).run.id),step=done.steps.find(item=>item.toolCall?.name===AGENT_TASK_TOOLS_LOAD_NAME);
 assert.equal(done.run.status,'completed');assert.ok(step);assert.equal(step.status,'rejected');assert.ok(step.error);assert.equal(step.error.code,'VALIDATION_ERROR');
 const message=object(object(step.result).error).message;assert.equal(typeof message,'string');
 if(selection!=='unknown_only'){
  assert.match(String(message),/常驻工具，已可直接使用，不需要加载/u);
  for(const name of names.filter(name=>coreNames.includes(name)))assert.ok(String(message).includes(JSON.stringify(name)));
 }
 if(selection==='unknown_only'||selection==='core_unknown_and_valid'){
  assert.match(String(message),/工具名不存在/u);for(const name of unknownNames)assert.ok(String(message).includes(JSON.stringify(name)));
 }
 assert.ok(!String(message).includes('mioon_shot_update'),'A valid frozen name is not blamed for the invalid batch');
 assert.deepEqual(f.prepared,[]);assert.deepEqual(f.executed,[]);assert.equal(done.changes.length,0);
 assert.equal(f.requests.length,2);assert.ok(!visible(f.requests[1]!).includes('mioon_shot_update'));
 for(const name of coreNames)assert.ok(visible(f.requests[0]!).includes(name),'The source request really disclosed the resident tool');
});

for(const [locale,coreLabel,unknownLabel] of [['zh-Hant','常駐工具','工具名稱不存在'],['en','core tools are already available','tool names do not exist'],['ja','常駐ツール','ツール名は存在しません']] as const)
test(`${locale}: invalid loading explains resident and nonexistent names in the run language`,async t=>{
 const f=await fixture(t);f.script(async function*(index){yield {type:'done',output:output('responses',index===1?[call(AGENT_TASK_TOOLS_LOAD_NAME,{names:[coreNames[0]!,unknownNames[0]!]})]:[])};});
 const done=await f.settle((await f.send({locale})).run.id),message=done.steps.find(step=>step.kind==='tool')?.error?.message;
 assert.equal(typeof message,'string');assert.ok(message!.includes(coreLabel));assert.ok(message!.includes(unknownLabel));
 assert.ok(message!.includes(JSON.stringify(coreNames[0])));assert.ok(message!.includes(JSON.stringify(unknownNames[0])));
});

for(const names of [Array(129).fill('not_a_tool') as string[],['not_a_tool\nUntrusted text'],['x'.repeat(65)]])
test('malformed or excessive loading names retain bounded generic feedback without echoing arbitrary text',async t=>{
 const f=await fixture(t);f.script(async function*(index){yield {type:'done',output:output('responses',index===1?[call(AGENT_TASK_TOOLS_LOAD_NAME,{names})]:[])};});
 const done=await f.settle((await f.send()).run.id),step=done.steps.find(item=>item.kind==='tool');
 assert.equal(done.run.status,'completed');assert.ok(step);assert.equal(step.status,'rejected');assert.ok(step.error);assert.equal(step.error.code,'VALIDATION_ERROR');
 assert.ok(Buffer.byteLength(step.error.message)<1024);assert.ok(!step.error.message.includes('Untrusted text'));
 assert.deepEqual(f.prepared,[]);assert.deepEqual(f.executed,[]);
});

for(const protocol of protocols)test(`${protocol}: frozen smaller name enums identify known unavailable names and preserve their source bytes`,async t=>{
 const f=await fixture(t,protocol);f.script(async function*(index){yield {type:'done',output:output(protocol,index===1?[call(AGENT_TASK_TOOLS_LOAD_NAME,{names:[coreNames[0]!,'mioon_shot_create']})]:[])};});
 const {sent,original}=await f.sendFrozenNames(['mioon_shot_update']),done=await f.settle(sent.run.id),step=done.steps.find(item=>item.kind==='tool');
 assert.equal(done.run.status,'completed');assert.equal(f.requests[0]?.body,original);assert.ok(step);assert.equal(step.status,'rejected');
 assert.ok(step.error);assert.equal(step.error.code,'VALIDATION_ERROR');assert.match(step.error.message,/未列入产生该回复的请求的可加载名称/u);
 assert.ok(step.error.message.includes(JSON.stringify('mioon_shot_create')));assert.ok(step.error.message.includes(JSON.stringify(coreNames[0])));
 assert.ok(!step.error.message.includes('工具名不存在'),'A current tool outside the frozen enum is not nonexistent');
 assert.deepEqual(f.prepared,[]);assert.deepEqual(f.executed,[]);assert.ok(!visible(f.requests[1]!).includes('mioon_shot_create'));
});
