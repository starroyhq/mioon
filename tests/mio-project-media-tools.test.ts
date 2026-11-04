import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {createAgentTaskTools,listAgentTaskTools,listDiagnosticAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../packages/business/src/agent/task-runtime-v2.ts';
import {buildTaskModelRequest} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskModelItem,TaskModelOutput,TaskModelRequest} from '../packages/business/src/agent/task-gateway-v2.ts';
import {selectTaskModelTools,sourceTaskModelToolNames} from '../packages/business/src/agent/task-context-v2.ts';
import {AGENT_TASK_TOOLS_LOAD_NAME,AGENT_TASK_LOADABLE_TOOL_GROUP_IDS,AGENT_TASK_LOADABLE_TOOL_NAMES,AGENT_TASK_LEGACY_LOADABLE_TOOL_NAMES,loadedAgentTaskToolNames} from '../packages/business/src/agent/task-tool-groups-v2.ts';
import {createMioRecords} from '../packages/business/src/agent/mio-records.ts';
import {createMioAssembly} from '../packages/business/src/agent/mio-assembly.ts';
import {MIO_PROJECT_MEDIA_LIST_TOOL,MIO_PROJECT_MEDIA_LIST_OPERATION} from '../packages/contracts/src/mio-project-media.ts';
import type {MioProjectMediaPort,MioProjectMediaListing} from '../packages/contracts/src/mio-project-media.ts';
import type {AgentProtocol} from '../packages/contracts/src/agent-protocol.ts';
import type {AgentTaskJson,AgentTaskToolCall,AgentTaskStep} from '../packages/contracts/src/agent-tasks-v2.ts';
import {createTestAuthorizations,authorizeTestScope} from './helpers/agent-authorizations.ts';

const protocols=['chat_completions','responses','anthropic_messages'] as const satisfies readonly AgentProtocol[];
const listing:MioProjectMediaListing={directory:'素材',entries:[{name:'片段.mp4',kind:'video',mimeType:'video/mp4',sizeBytes:2048,durationSeconds:3}],nextCursor:null,truncated:false};
const call=(name:string,input:AgentTaskJson={}):AgentTaskToolCall=>({id:randomUUID(),name,arguments:input});
function object(value:unknown):Record<string,unknown>{assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;}
function output(protocol:AgentProtocol,calls:AgentTaskToolCall[]=[]):TaskModelOutput{
  const text='Synthetic directory observation';
  const providerOutput:AgentTaskJson=protocol==='anthropic_messages'?{role:'assistant',content:[{type:'text',text},...calls.map(item=>({type:'tool_use',id:item.id,name:item.name,input:item.arguments}))]}
    :protocol==='responses'?[{type:'message',role:'assistant',content:[{type:'output_text',text}]},...calls.map(item=>({type:'function_call',call_id:item.id,name:item.name,arguments:JSON.stringify(item.arguments),status:'completed'}))]
    :{role:'assistant',content:text,...(calls.length?{tool_calls:calls.map(item=>({id:item.id,type:'function',function:{name:item.name,arguments:JSON.stringify(item.arguments)}}))}:{})};
  return {text,toolCalls:calls,providerOutput};
}
type Script=(index:number,request:TaskModelRequest)=>AsyncGenerator<TaskModelItem,void,undefined>;
async function fixture(t:TestContext,protocol:AgentProtocol='responses',options:{withoutPort?:boolean;invalidResult?:boolean;forgedLoad?:boolean;unknownLoad?:boolean}={}){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-project-media-tools-')),store=openStore(root),services=createServices(store,new Map());
  const project=object(await services.call('project.create',{name:'Mio directory tool test'})),projectId=String(project.id);
  const settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}});
  await settings.put({expectedRevision:0,configuration:{presetId:'ollama',platformId:'local',protocol,model:'qwen3:8b',baseUrl:'http://127.0.0.1:11434'+(protocol==='anthropic_messages'?'':'/v1')},secret:{action:'remove'}});
  const authorizations=createTestAuthorizations(store,settings);await authorizeTestScope(authorizations,'project_agent');
  const calls:Array<{projectId:string;input:Parameters<MioProjectMediaPort['list']>[1];signal:AbortSignal|undefined}>=[];
  const projectMedia:MioProjectMediaPort={async list(owner,input,context){
    context.beforeEffect();calls.push({projectId:owner,input,signal:context.signal});
    return options.invalidResult?{...listing,absolutePath:'/private/synthetic-hidden-source'}:structuredClone(listing);
  }};
  const base=createAgentTaskTools({store,services,...(options.withoutPort?{}:{projectMedia})}),prepared:string[]=[],executed:string[]=[],requests:TaskModelRequest[]=[];
  const tools={...base,prepare(input:Parameters<typeof base.prepare>[0]){prepared.push(input.operation);return base.prepare(input);},async execute(value:Parameters<typeof base.execute>[0],context:Parameters<typeof base.execute>[1]){
    executed.push(value.operation);
    if(value.operation==='tools.load'&&options.unknownLoad)throw Object.assign(Error('Synthetic interrupted load'),{code:'AGENT_TASK_UNKNOWN_RESULT'});
    if(value.operation==='tools.load'&&options.forgedLoad)return {result:{names:[MIO_PROJECT_MEDIA_LIST_TOOL]},changes:[],recorded:false};
    return base.execute(value,context);
  }};
  let script:Script=async function*(){yield {type:'done',output:output(protocol)};};
  const gateway=async function*(request:TaskModelRequest){request.beforeSubmit?.();requests.push(request);yield*script(requests.length,request);};
  let runtime=createAgentTaskRuntime({store,agentSettings:settings,authorizations,tools,gateway,selfPort:()=>4318}),closed=false;
  async function close(){if(closed)return;closed=true;runtime.close();base.dispose();await settings.close();store.close();}
  t.after(async()=>{await close();rmSync(root,{recursive:true,force:true});});
  function restart(){runtime.close();runtime=createAgentTaskRuntime({store,agentSettings:settings,authorizations,tools,gateway,selfPort:()=>4318});}
  return {root,store,projectId,base,tools,calls,prepared,executed,requests,get runtime(){return runtime;},close,restart,
    script(value:Script){script=value;},
    async send(){return runtime.send(projectId,{requestId:randomUUID(),text:'List the project media directory.',expectedSettingsRevision:(await settings.get()).revision});},
    async settle(runId:string){await runtime.drain();return runtime.get(projectId,runId);},
    async resume(runId:string){const current=runtime.get(projectId,runId);return runtime.action(projectId,runId,{requestId:randomUUID(),expectedRevision:current.run.revision,action:'resume'});},
    async frozen(mode:'groups'|'names'){
      const saved=await settings.get(),history:AgentTaskJson[]=[{role:'user',content:'Continue the frozen directory observation.'}],body=object(JSON.parse(buildTaskModelRequest(saved.configuration,history,selectTaskModelTools(base.list()),4318)));
      assert.ok(Array.isArray(body.tools));
      for(const entry of body.tools){
        const wire=object(entry),definition=protocol==='chat_completions'?object(wire.function):wire;if(definition.name!==AGENT_TASK_TOOLS_LOAD_NAME)continue;
        const schema=object(definition[protocol==='anthropic_messages'?'input_schema':'parameters']),properties=object(schema.properties);
        schema.properties={[mode]:{type:'array',items:{type:'string',enum:mode==='groups'?AGENT_TASK_LOADABLE_TOOL_GROUP_IDS:['mioon_asset_range_get']},minItems:1,maxItems:mode==='groups'?AGENT_TASK_LOADABLE_TOOL_GROUP_IDS.length:1},...(properties._mio_step?{_mio_step:properties._mio_step}:{})};schema.required=[mode];
      }
      const original=JSON.stringify(body),created=runtime.journal.create({projectId,requestId:randomUUID(),text:'Continue the frozen directory observation.',configuration:{...saved.configuration},settingsRevision:saved.revision,context:history});
      runtime.journal.beginModelStep(created.run.id,{request:{body:original,history},data:{baseline:runtime.journal.revisionSnapshot(projectId).map(({kind,id,revision})=>({kind,id,revision}))}},[]);
      restart();return {original,sent:await runtime.action(projectId,created.run.id,{requestId:randomUUID(),expectedRevision:runtime.get(projectId,created.run.id).run.revision,action:'resume'})};
    },
  };
}

test('the native non-core list tool keeps its read-only tier while directory tools stay out of diagnostics',()=>{
  const native=listAgentTaskTools(),diagnostic=listDiagnosticAgentTaskTools(),tool=native.find(tool=>tool.name===MIO_PROJECT_MEDIA_LIST_TOOL);
  assert.equal(tool?.operation,MIO_PROJECT_MEDIA_LIST_OPERATION);assert.equal(tool?.risk,'read_only');
  assert.ok(AGENT_TASK_LOADABLE_TOOL_NAMES.includes(MIO_PROJECT_MEDIA_LIST_TOOL));assert.ok(!AGENT_TASK_LEGACY_LOADABLE_TOOL_NAMES.includes(MIO_PROJECT_MEDIA_LIST_TOOL));
  assert.ok(!selectTaskModelTools(native).some(tool=>tool.name===MIO_PROJECT_MEDIA_LIST_TOOL));
  assert.ok(!diagnostic.some(tool=>tool.name===MIO_PROJECT_MEDIA_LIST_TOOL));
  for(const profile of ['text','read_only','catalog'] as const)assert.ok(!selectTaskModelTools(diagnostic,{profile}).some(tool=>tool.name===MIO_PROJECT_MEDIA_LIST_TOOL));
  assert.ok(native.some(tool=>tool.name==='mioon_asset_import_project_file'));
  assert.ok(!diagnostic.some(tool=>tool.name==='mioon_asset_import_project_file'));
  assert.ok(!AGENT_TASK_LEGACY_LOADABLE_TOOL_NAMES.includes('mioon_asset_import_project_file'));
});

test('a host port is mandatory and strict model input cannot provide owner or path authority',async t=>{
  const missing=await fixture(t,'responses',{withoutPort:true});
  assert.throws(()=>missing.base.prepare({projectId:missing.projectId,operation:MIO_PROJECT_MEDIA_LIST_TOOL,input:{}}),{code:'AGENT_TASK_TOOL_FORBIDDEN'});
  const f=await fixture(t);
  assert.throws(()=>f.base.prepare({projectId:randomUUID(),operation:MIO_PROJECT_MEDIA_LIST_TOOL,input:{}}),{code:'AGENT_TASK_TOOL_FORBIDDEN'});
  for(const input of [{filePath:'/tmp/source'},{directory:'../outside'},{directory:'/absolute'},{directory:'a/../b'},{directory:'.hidden'},{limit:101},{cursor:'../bad'},{path:'movie.mp4'},{directory:'',unknown:true}])assert.throws(()=>f.base.prepare({projectId:f.projectId,operation:MIO_PROJECT_MEDIA_LIST_TOOL,input}));
  assert.equal(f.calls.length,0);assert.equal(missing.calls.length,0);
});

for(const protocol of protocols)test(protocol+': an exact-name load exposes listing only on the next response and replays solely from records',async t=>{
  const f=await fixture(t,protocol),observe=call(MIO_PROJECT_MEDIA_LIST_TOOL,{directory:'素材',limit:1});
  f.script(async function*(index){yield {type:'done',output:output(protocol,index===1?[call(AGENT_TASK_TOOLS_LOAD_NAME,{names:[MIO_PROJECT_MEDIA_LIST_TOOL]})]:index===2?[observe]:[])};});
  const done=await f.settle((await f.send()).run.id);assert.equal(done.run.status,'completed');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0]?.projectId,f.projectId);assert.deepEqual(f.calls[0]?.input,{directory:'素材',limit:1});assert.ok(f.calls[0]?.signal instanceof AbortSignal);
  assert.ok(!sourceTaskModelToolNames(protocol,{body:f.requests[0]!.body}).includes(MIO_PROJECT_MEDIA_LIST_TOOL));assert.ok(sourceTaskModelToolNames(protocol,{body:f.requests[1]!.body}).includes(MIO_PROJECT_MEDIA_LIST_TOOL));
  const observed=done.steps.find(step=>step.toolCall?.id===observe.id);assert.equal(observed?.status,'completed');assert.deepEqual(observed?.result,listing);assert.deepEqual(observed?.targets,[]);assert.equal(done.changes.length,0);
  const models=done.steps.filter(step=>step.kind==='model').map(step=>step.id),sent=f.requests.map(request=>request.body);await f.close();
  const store=openStore(f.root);try{
    const records=createMioRecords(store),assembly=createMioAssembly(records),before=store.db.prepare('SELECT total_changes() AS n').get()!.n;
    for(const [index,id]of models.entries()){const request=records.request(records.step(id).currentRequestId!);assert.equal(request.originalBody,null);assert.equal(object(assembly.hydrate(request)).body,sent[index]);}
    assert.equal(store.db.prepare('SELECT total_changes() AS n').get()!.n,before);assert.equal(f.calls.length,1);
  }finally{store.close();}
});

for(const protocol of protocols)test(protocol+': loading and listing in one reply rejects the early call without invoking the host',async t=>{
  const f=await fixture(t,protocol),early=call(MIO_PROJECT_MEDIA_LIST_TOOL),later=call(MIO_PROJECT_MEDIA_LIST_TOOL,{directory:'素材'});
  f.script(async function*(index){yield {type:'done',output:output(protocol,index===1?[call(AGENT_TASK_TOOLS_LOAD_NAME,{names:[MIO_PROJECT_MEDIA_LIST_TOOL]}),early]:index===2?[later]:[])};});
  const done=await f.settle((await f.send()).run.id),rejected=done.steps.find(step=>step.toolCall?.id===early.id);
  assert.equal(done.run.status,'completed');assert.ok(rejected);assert.equal(rejected.status,'rejected');assert.equal(rejected.error?.code,'TOOL_NOT_LOADED');assert.equal(object(object(rejected.result).error).group,'assets');
  assert.equal(done.steps.find(step=>step.toolCall?.id===later.id)?.status,'completed');assert.equal(f.calls.length,1);assert.equal(f.prepared.filter(name=>name===MIO_PROJECT_MEDIA_LIST_TOOL).length,1);assert.equal(done.changes.length,0);
});

for(const protocol of protocols)test(protocol+': legacy assets group receipts survive restart without discovering or authorizing directory reads',async t=>{
  const f=await fixture(t,protocol);f.runtime.journal.updatePolicy({...f.runtime.policy(),stepLimit:2});
  f.script(async function*(index){yield {type:'done',output:output(protocol,index===1?[call(AGENT_TASK_TOOLS_LOAD_NAME,{groups:['assets']})]:index===2?[call(MIO_PROJECT_MEDIA_LIST_TOOL)]:[])};});
  const {sent,original}=await f.frozen('groups'),paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,'budget');assert.equal(f.requests[0]?.body,original);
  const load=paused.steps.find(step=>step.toolCall?.name===AGENT_TASK_TOOLS_LOAD_NAME);assert.ok(load);assert.equal(load.status,'completed');
  const receipt=object(load.result);assert.deepEqual(receipt.groups,['assets']);assert.ok(Array.isArray(receipt.tools));assert.ok(!receipt.tools.includes(MIO_PROJECT_MEDIA_LIST_TOOL));
  f.restart();await f.resume(sent.run.id);const done=await f.settle(sent.run.id);
  assert.equal(done.steps.find(step=>step.toolCall?.name===MIO_PROJECT_MEDIA_LIST_TOOL)?.error?.code,'TOOL_NOT_LOADED');
  assert.equal(f.calls.length,0);assert.ok(!f.prepared.includes(MIO_PROJECT_MEDIA_LIST_TOOL));
  assert.ok(sourceTaskModelToolNames(protocol,{body:f.requests[1]!.body}).includes('mioon_asset_range_get'));assert.ok(!sourceTaskModelToolNames(protocol,{body:f.requests[1]!.body}).includes(MIO_PROJECT_MEDIA_LIST_TOOL));
  assert.deepEqual(done.steps.find(step=>step.id===load.id)?.result,receipt);
});

for(const protocol of protocols)test(protocol+': a frozen older names enum rejects loading the new name before preparation',async t=>{
  const f=await fixture(t,protocol);
  f.script(async function*(index){yield {type:'done',output:output(protocol,index===1?[call(AGENT_TASK_TOOLS_LOAD_NAME,{names:[MIO_PROJECT_MEDIA_LIST_TOOL]})]:index===2?[call(MIO_PROJECT_MEDIA_LIST_TOOL)]:[])};});
  const {sent,original}=await f.frozen('names'),done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.requests[0]?.body,original);
  const load=done.steps.find(step=>step.toolCall?.name===AGENT_TASK_TOOLS_LOAD_NAME);assert.ok(load);assert.equal(load.status,'rejected');assert.equal(load.error?.code,'VALIDATION_ERROR');
  assert.equal(done.steps.find(step=>step.toolCall?.name===MIO_PROJECT_MEDIA_LIST_TOOL)?.error?.code,'TOOL_NOT_LOADED');assert.deepEqual(f.prepared,[]);assert.deepEqual(f.executed,[]);assert.equal(f.calls.length,0);
});

for(const protocol of protocols)test(protocol+': an unrequested name in a completed loader result does not authorize listing',async t=>{
  const f=await fixture(t,protocol,{forgedLoad:true});
  f.script(async function*(index){yield {type:'done',output:output(protocol,index===1?[call(AGENT_TASK_TOOLS_LOAD_NAME,{names:['mioon_asset_range_get']})]:index===2?[call(MIO_PROJECT_MEDIA_LIST_TOOL)]:[])};});
  const done=await f.settle((await f.send()).run.id);assert.equal(done.run.status,'completed');assert.equal(done.steps.find(step=>step.toolCall?.name===MIO_PROJECT_MEDIA_LIST_TOOL)?.error?.code,'TOOL_NOT_LOADED');assert.equal(f.calls.length,0);assert.ok(!f.prepared.includes(MIO_PROJECT_MEDIA_LIST_TOOL));
});

for(const protocol of protocols)test(protocol+': an unknown loader result cannot expand visibility',async t=>{
  const f=await fixture(t,protocol,{unknownLoad:true});f.script(async function*(){yield {type:'done',output:output(protocol,[call(AGENT_TASK_TOOLS_LOAD_NAME,{names:[MIO_PROJECT_MEDIA_LIST_TOOL]})])};});
  const done=await f.settle((await f.send()).run.id);assert.equal(done.steps.find(step=>step.toolCall?.name===AGENT_TASK_TOOLS_LOAD_NAME)?.status,'unknown');
  assert.ok(!selectTaskModelTools(f.base.list(),undefined,{steps:done.steps}).some(tool=>tool.name===MIO_PROJECT_MEDIA_LIST_TOOL));assert.equal(f.calls.length,0);assert.equal(f.requests.length,1);
});

test('non-completed, malformed and non-host loading evidence cannot grant the directory tool',()=>{
  type Evidence=Pick<AgentTaskStep,'kind'|'status'|'toolCall'|'result'>;
  const valid:Evidence={kind:'tool',status:'completed',toolCall:call(AGENT_TASK_TOOLS_LOAD_NAME,{names:[MIO_PROJECT_MEDIA_LIST_TOOL]}),result:{names:[MIO_PROJECT_MEDIA_LIST_TOOL]}};
  assert.deepEqual(loadedAgentTaskToolNames([valid]),[MIO_PROJECT_MEDIA_LIST_TOOL]);
  for(const status of ['intent','awaiting_approval','dispatch_started','unknown','rejected','denied','failed'] as const)assert.deepEqual(loadedAgentTaskToolNames([{...valid,status}]),[]);
  const invalid:Evidence[]=[{...valid,kind:'model'},{...valid,toolCall:call('mioon_other_tool',{names:[MIO_PROJECT_MEDIA_LIST_TOOL]})},{...valid,toolCall:call(AGENT_TASK_TOOLS_LOAD_NAME,{names:['mioon_asset_range_get']})},{...valid,result:{names:[MIO_PROJECT_MEDIA_LIST_TOOL],extra:true}},{...valid,toolCall:call(AGENT_TASK_TOOLS_LOAD_NAME,{groups:['assets']}),result:{groups:['assets'],tools:[MIO_PROJECT_MEDIA_LIST_TOOL]}}];
  for(const evidence of invalid)assert.ok(!loadedAgentTaskToolNames([evidence]).includes(MIO_PROJECT_MEDIA_LIST_TOOL));
});

test('an invalid host result is rejected without forwarding hidden fields to a model',async t=>{
  const f=await fixture(t,'responses',{invalidResult:true});
  f.script(async function*(index){yield {type:'done',output:output('responses',index===1?[call(AGENT_TASK_TOOLS_LOAD_NAME,{names:[MIO_PROJECT_MEDIA_LIST_TOOL]})]:index===2?[call(MIO_PROJECT_MEDIA_LIST_TOOL)]:[])};});
  const done=await f.settle((await f.send()).run.id),step=done.steps.find(step=>step.toolCall?.name===MIO_PROJECT_MEDIA_LIST_TOOL);
  assert.ok(step);assert.equal(step.status,'failed');assert.equal(step.error?.code,'AGENT_TASK_TOOL_RESULT_INVALID');assert.equal(f.calls.length,1);assert.equal(done.changes.length,0);
  assert.ok(!JSON.stringify(done).includes('/private/synthetic-hidden-source'));assert.ok(f.requests.every(request=>!request.body.includes('/private/synthetic-hidden-source')));
});
