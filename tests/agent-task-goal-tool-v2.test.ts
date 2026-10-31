import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {createAgentTaskTools,AGENT_TASK_OPERATION_ADMISSION} from '../packages/business/src/agent/task-tools-v2.ts';
import {AGENT_TASK_GOAL_SET_TOOL,AGENT_TASK_GOAL_SET_OPERATION,agentTaskToolGroupForName} from '../packages/business/src/agent/task-tool-groups-v2.ts';
import {AGENT_TASK_GOAL_SET_PARAMETERS,latestAgentTaskGoals} from '../packages/business/src/agent/task-goals-v2.ts';
import {AGENT_TASK_TOOL_SCHEMAS} from '../packages/business/src/agent/task-tool-schemas-v2.ts';
import {selectTaskModelTools} from '../packages/business/src/agent/task-context-v2.ts';
import {buildTaskModelRequest,taskResponseLanguageContext} from '../packages/business/src/agent/task-gateway-v2.ts';
import {DEFAULT_AGENT_CONFIGURATION} from '../packages/business/src/agent/presets.ts';
import {schemas} from '../packages/contracts/src/index.ts';
import {AGENT_TASK_LOCALES} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskDiagnostic,AgentTaskJson} from '../packages/contracts/src/agent-tasks-v2.ts';
import {VERSION,EXIT_CODES,discoverSchema,operationDefinition} from '../packages/client/src/index.ts';
import {help} from '../apps/cli/src/help.ts';

const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const repository=fileURLToPath(new URL('..',import.meta.url));
const protocols=['chat_completions','responses','anthropic_messages'] as const;
async function fixture(t:TestContext){
  const directory=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-goal-tool-')),store=openStore(directory),services=createServices(store,new Map());
  const project=await services.call('project.create',{name:'Offline host goal fixture'});assert.ok(object(project)&&typeof project.id==='string');
  const projectId=project.id,journal=createAgentTaskJournal(store),tools=createAgentTaskTools({store,services});
  const run=journal.create({requestId:randomUUID(),projectId,text:'Declare local checkable requirements',configuration:{}}).run;
  t.after(async()=>{tools.dispose();await services.drain();store.close();await rm(directory,{recursive:true,force:true});});
  async function set(input:AgentTaskJson,{beforeEffect=()=>{}}:{beforeEffect?:()=>void}={}){
    const prepared=tools.prepare({projectId,operation:AGENT_TASK_GOAL_SET_TOOL,input});
    const step=journal.beginStep(run.id,{kind:'tool',tier:prepared.risk,targets:prepared.targets,toolCall:{id:randomUUID(),name:AGENT_TASK_GOAL_SET_TOOL,arguments:input}});
    journal.markDispatch(run.id,step.id);
    const outcome=await tools.execute(prepared,{runId:run.id,stepId:step.id,requestId:step.id,beforeEffect,recordInside:(result,changes)=>journal.completeStepInside(run.id,step.id,{result,changes})});
    journal.completeStep(run.id,step.id,{result:outcome.result,changes:outcome.changes});
    return {prepared,step:journal.step(step.id),outcome};
  }
  return {store,services,projectId,journal,tools,run,set};
}

test('H4a goal declaration is a host-only core tool with its independent closed schema',async t=>{
  const f=await fixture(t),tool=f.tools.list().find(value=>value.name===AGENT_TASK_GOAL_SET_TOOL);assert.ok(tool);
  assert.equal(tool.operation,AGENT_TASK_GOAL_SET_OPERATION);assert.equal(tool.risk,'read_only');assert.equal(agentTaskToolGroupForName(tool.name),'core');
  assert.deepEqual(tool.parameters,AGENT_TASK_GOAL_SET_PARAMETERS);
  // The merged transform operation remains public for the editor and is
  // explicitly forbidden to Mio; the run-local goal tool stays core-only.
  assert.equal(Object.hasOwn(schemas,'timeline.clip.setTransform'),true);
  assert.equal(AGENT_TASK_OPERATION_ADMISSION['timeline.clip.setTransform']?.allowed,false);
  assert.equal(f.tools.list().some(value=>value.operation==='timeline.clip.setTransform'),false);
  assert.throws(()=>f.tools.prepare({projectId:f.projectId,operation:'timeline.clip.setTransform',input:{}}),{code:'AGENT_TASK_TOOL_FORBIDDEN'});
  assert.equal(Object.hasOwn(schemas,AGENT_TASK_GOAL_SET_OPERATION),false);
  assert.equal(Object.hasOwn(schemas,AGENT_TASK_GOAL_SET_TOOL),false);
  assert.equal(Object.hasOwn(AGENT_TASK_OPERATION_ADMISSION,AGENT_TASK_GOAL_SET_OPERATION),false);
  assert.equal(Object.hasOwn(AGENT_TASK_TOOL_SCHEMAS,AGENT_TASK_GOAL_SET_OPERATION),false);
  assert.throws(()=>operationDefinition(AGENT_TASK_GOAL_SET_OPERATION),{code:'UNKNOWN_OPERATION'});
  const discovery=discoverSchema();assert.ok('operations' in discovery);
  assert.ok(discovery.operations.every(operation=>operation.operation!==AGENT_TASK_GOAL_SET_OPERATION&&operation.toolName!=='goal_set'));
  const cli:unknown=help(undefined,{VERSION,EXIT_CODES,schemas,discoverSchema});assert.ok(object(cli)&&Array.isArray(cli.operations));
  assert.ok(!cli.operations.includes(AGENT_TASK_GOAL_SET_OPERATION));
  await assert.rejects(f.services.call(AGENT_TASK_GOAL_SET_OPERATION,{conditions:[]}),{code:'UNKNOWN_OPERATION'});
});

test('H4a public MCP discovery and invocation do not expose the host goal tool',{timeout:30_000},async t=>{
  const client=new Client({name:'h4a-host-discovery',version:'1.0.0'},{capabilities:{}});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(repository,'apps/mcp/src/index.ts')],cwd:repository,env:{PATH:process.env.PATH??'',TZ:'UTC',TMPDIR:tmpdir(),MIOON_ENABLE_LIVE_PROVIDER:'0'},stderr:'pipe'});
  t.after(()=>client.close());await client.connect(transport);
  const listing=await client.listTools();assert.ok(listing.tools.some(tool=>tool.name==='project_inspect'));
  for(const name of [AGENT_TASK_GOAL_SET_TOOL,'goal_set']){
    assert.ok(!listing.tools.some(tool=>tool.name===name));
    const response=await client.callTool({name,arguments:{conditions:[]}});
    assert.equal(response.isError,true);const content=response.content;assert.ok(Array.isArray(content));
    const text=content.find(value=>object(value)&&value.type==='text');assert.ok(object(text)&&typeof text.text==='string');
    const envelope:unknown=JSON.parse(text.text);assert.ok(object(envelope)&&object(envelope.error));assert.equal(envelope.error.code,'UNKNOWN_OPERATION');
  }
});

test('H4a host preparation normalizes goals without reading targets or modifying caller input',async t=>{
  const f=await fixture(t),input={conditions:[{type:'duration',seconds:12},{type:'shot_count',min:3,max:3}]},before=structuredClone(input);
  const prepared=f.tools.prepare({projectId:f.projectId,operation:AGENT_TASK_GOAL_SET_TOOL,input,beforeTargetRead:()=>assert.fail('Goals have no project targets')});
  assert.equal(prepared.operation,AGENT_TASK_GOAL_SET_OPERATION);assert.equal(prepared.risk,'read_only');
  assert.deepEqual(prepared.input,{conditions:[{type:'duration',seconds:12,toleranceSeconds:0},{type:'shot_count',min:3,max:3}]});
  assert.deepEqual(prepared.targets,[]);assert.deepEqual(prepared.referencedTargets,[]);assert.deepEqual(prepared.before,{});assert.deepEqual(input,before);
  assert.equal(await f.tools.parameterFeedback({projectId:f.projectId,operation:AGENT_TASK_GOAL_SET_TOOL,input}),null);
  assert.deepEqual(f.tools.prepare({projectId:f.projectId,operation:AGENT_TASK_GOAL_SET_OPERATION,input:{conditions:[]}}).input,{conditions:[]});
  assert.throws(()=>f.tools.prepare({projectId:randomUUID(),operation:AGENT_TASK_GOAL_SET_TOOL,input:{conditions:[]}}),{code:'AGENT_TASK_INVALID_TARGET'});
});

test('H4a invalid goal declarations use bounded parameter feedback and cannot become steps',async t=>{
  const f=await fixture(t),marker='private-untrusted-marker';
  for(const input of [null,[],{}, {conditions:[{type:marker}]},{conditions:[{type:'shot_count',min:-1}]},{conditions:[{type:'shot_count',count:1}]},{conditions:[{type:'shot_count'}]},{conditions:[{type:'shot_count',min:4,max:3}]},{conditions:[{type:'duration',seconds:Infinity}]},{conditions:[{type:'export_parameters'}]},{conditions:Array.from({length:21},()=>({type:'generation_completed'}))},{conditions:[],[marker]:marker}]){
    const feedback=await f.tools.parameterFeedback({projectId:f.projectId,operation:AGENT_TASK_GOAL_SET_TOOL,input});assert.ok(feedback);
    assert.deepEqual(feedback.issues,[{field:'conditions',reason:'invalid_value'}]);assert.ok(!JSON.stringify(feedback).includes(marker));
    if(object(input))assert.throws(()=>f.tools.prepare({projectId:f.projectId,operation:AGENT_TASK_GOAL_SET_TOOL,input}),{code:'VALIDATION_ERROR'});
  }
  assert.equal(f.journal.run(f.run.id).stepsUsed,0);assert.equal(f.journal.snapshot(f.run.id).changes.length,0);
});

test('H4a host goal execution consumes one read-only step and later declarations replace or clear goals',async t=>{
  const f=await fixture(t),projectBefore=f.store.get('projects',f.projectId);let fences=0;
  const first=await f.set({conditions:[{type:'duration',seconds:8}]},{beforeEffect:()=>{fences++;}});
  assert.equal(fences,1);assert.equal(first.outcome.recorded,false);assert.deepEqual(first.outcome.changes,[]);
  assert.deepEqual(first.outcome.result,{conditions:[{type:'duration',seconds:8,toleranceSeconds:0}]});assert.equal(first.step.tier,'read_only');assert.equal(first.step.status,'completed');
  assert.equal(f.journal.run(f.run.id).stepsUsed,1);assert.deepEqual(f.store.get('projects',f.projectId),projectBefore);
  const next=await f.set({conditions:[{type:'shot_count',min:2,max:2}]});
  assert.deepEqual(latestAgentTaskGoals(f.journal.snapshot(f.run.id).steps),{stepId:next.step.id,conditions:[{type:'shot_count',min:2,max:2}]});
  const clear=await f.set({conditions:[]});assert.deepEqual(latestAgentTaskGoals(f.journal.snapshot(f.run.id).steps),{stepId:clear.step.id,conditions:[]});
  assert.equal(f.journal.run(f.run.id).stepsUsed,3);assert.equal(f.journal.snapshot(f.run.id).changes.length,0);assert.deepEqual(f.store.get('projects',f.projectId),projectBefore);
});

test('H4a goal receipts retain host execution fences, cancellation and project ownership',async t=>{
  const f=await fixture(t),prepared=f.tools.prepare({projectId:f.projectId,operation:AGENT_TASK_GOAL_SET_TOOL,input:{conditions:[]}});
  const context={runId:f.run.id,stepId:randomUUID(),requestId:randomUUID(),recordInside:()=>assert.fail('The outer journal persists the receipt')};
  const blocked=Object.assign(Error('Synthetic denied execution'),{code:'AGENT_TASK_CONSENT_REQUIRED'});
  await assert.rejects(f.tools.execute(prepared,{...context,beforeEffect:()=>{throw blocked;}}),error=>error===blocked);
  await assert.rejects(f.tools.execute(prepared,{...context,beforeEffect:()=>{},signal:AbortSignal.abort()}),{code:'AGENT_TASK_ABORTED'});
  // Another project's run lives in that project's own store: this project has no such run.
  const other=await fixture(t);
  await assert.rejects(f.tools.execute(prepared,{...context,runId:other.run.id,beforeEffect:()=>{}}),{code:'AGENT_TASK_NOT_FOUND'});
  await assert.rejects(f.tools.execute({...prepared,input:{conditions:[{type:'unreviewed'}]}},{...context,beforeEffect:()=>{}}),{code:'VALIDATION_ERROR'});
  assert.equal(f.journal.run(f.run.id).stepsUsed,0);assert.equal(f.journal.snapshot(f.run.id).changes.length,0);
});

test('H4a four-language goal instructions and schemas accompany only non-diagnostic model catalogs',async t=>{
  const f=await fixture(t),catalog=f.tools.list(),withoutGoal=catalog.filter(tool=>tool.name!==AGENT_TASK_GOAL_SET_TOOL),core=selectTaskModelTools(catalog);
  assert.ok(core.some(tool=>tool.name===AGENT_TASK_GOAL_SET_TOOL));assert.equal(core.at(-1)?.name,'mioon_tools_load');
  const diagnostics:AgentTaskDiagnostic[]=[{profile:'text'},{profile:'read_only'},{profile:'catalog'},{profile:'catalog',toolNames:[AGENT_TASK_GOAL_SET_TOOL,'mioon_project_inspect']}];
  const permissionNotice={'zh-Hans':'不授予权限，也不是用户确认','zh-Hant':'不授予權限，也不是使用者確認',en:'they grant no permission and are not user confirmation',ja:'権限の付与やユーザーの承認ではありません'};
  for(const locale of AGENT_TASK_LOCALES)for(const protocol of protocols){
    const history=[taskResponseLanguageContext(locale),{role:'user',content:'Offline goal instruction verification'}],configuration={...DEFAULT_AGENT_CONFIGURATION,protocol};
    const body:unknown=JSON.parse(buildTaskModelRequest(configuration,history,core,4318,{toolLoading:true}));assert.ok(object(body));
    const instruction=protocol==='chat_completions'&&Array.isArray(body.messages)&&object(body.messages[0])?body.messages[0].content:protocol==='responses'?body.instructions:body.system;
    assert.ok(JSON.stringify(instruction).includes(AGENT_TASK_GOAL_SET_TOOL));
    assert.ok(JSON.stringify(instruction).includes(permissionNotice[locale]));
    const definition=Array.isArray(body.tools)?body.tools.find(tool=>object(tool)&&(tool.name===AGENT_TASK_GOAL_SET_TOOL||object(tool.function)&&tool.function.name===AGENT_TASK_GOAL_SET_TOOL)):undefined;assert.ok(object(definition));
    const schema=object(definition.function)?definition.function.parameters:protocol==='responses'?definition.parameters:definition.input_schema;assert.ok(object(schema)&&object(schema.properties));
    assert.deepEqual(schema.properties.conditions,AGENT_TASK_GOAL_SET_PARAMETERS.properties.conditions);
    assert.equal(schema.additionalProperties,false);assert.deepEqual(schema.required,['conditions']);
    for(const diagnostic of diagnostics){
      const selected=selectTaskModelTools(catalog,diagnostic),previous=selectTaskModelTools(withoutGoal,diagnostic);
      assert.ok(!selected.some(tool=>tool.name===AGENT_TASK_GOAL_SET_TOOL));
      const actual=buildTaskModelRequest(configuration,history,selected,4318),control=buildTaskModelRequest(configuration,history,previous,4318);
      assert.equal(actual,control);assert.ok(!actual.includes(AGENT_TASK_GOAL_SET_TOOL));
    }
  }
});
