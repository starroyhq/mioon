import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {AGENT_TASK_TOOL_GROUP_IDS,AGENT_TASK_LOADABLE_TOOL_GROUP_IDS,AGENT_TASK_TOOL_GROUPS,AGENT_TASK_TOOLS_LOAD_NAME,AGENT_TASK_TOOLS_LOAD_DESCRIPTIONS,agentTaskToolGroupForName,agentTaskToolNamesForGroup,assertAgentTaskToolGroupCoverage,loadedAgentTaskToolGroups,parseAgentTaskToolLoadInput} from '../packages/business/src/agent/task-tool-groups-v2.ts';
import type {AgentTaskJson,AgentTaskStep,AgentTaskStepStatus} from '../packages/contracts/src/agent-tasks-v2.ts';
import {schemas} from '../packages/contracts/src/index.ts';
import {mioPanelMessages} from '../packages/i18n/src/catalogs/mio-panel.ts';

const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function savedLoadStep(groups:string[],result:AgentTaskJson={groups,tools:[]},status:AgentTaskStepStatus='completed'):Pick<AgentTaskStep,'kind'|'status'|'toolCall'|'result'>{
  return {kind:'tool',status,toolCall:{id:'synthetic_load',name:AGENT_TASK_TOOLS_LOAD_NAME,arguments:{groups}},result};
}
async function fixture(t:TestContext){
  const root=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-tool-groups-')),store=openStore(root),services=createServices(store,new Map());
  const project=await services.call('project.create',{name:'Tool group fixture'});assert.ok(object(project)&&typeof project.id==='string');
  const projectId=project.id,journal=createAgentTaskJournal(store),tools=createAgentTaskTools({store,services});
  const run=journal.create({requestId:randomUUID(),projectId,text:'Offline tool loading',configuration:{}}).run;
  t.after(async()=>{tools.dispose();await services.drain();store.close();await rm(root,{recursive:true,force:true});});
  async function load(groups:string[],{runId=run.id,complete=true,beforeEffect=()=>{}}:{runId?:string;complete?:boolean;beforeEffect?:()=>void}={}){
    const input={groups},prepared=tools.prepare({projectId,operation:AGENT_TASK_TOOLS_LOAD_NAME,input});
    const step=journal.beginStep(runId,{kind:'tool',tier:prepared.risk,targets:prepared.targets,toolCall:{id:randomUUID(),name:AGENT_TASK_TOOLS_LOAD_NAME,arguments:input}});
    journal.markDispatch(runId,step.id);
    const outcome=await tools.execute(prepared,{runId,stepId:step.id,requestId:step.id,beforeEffect,recordInside:(result,changes)=>journal.completeStepInside(runId,step.id,{result,changes})});
    if(complete)journal.completeStep(runId,step.id,{result:outcome.result,changes:outcome.changes});
    return {outcome,stepId:step.id};
  }
  return {store,services,projectId,journal,tools,run,load};
}

test('every actual model tool, including host tools and imports, has exactly one explicit group',async t=>{
  const f=await fixture(t),catalog=f.tools.list();assertAgentTaskToolGroupCoverage(catalog);
  assert.equal(catalog.length,Object.values(AGENT_TASK_TOOL_GROUPS).reduce((sum,operations)=>sum+operations.length,0));
  for(const tool of catalog){
    const group=agentTaskToolGroupForName(tool.name);assert.ok(group);
    assert.equal(agentTaskToolNamesForGroup(group).filter(name=>name===tool.name).length,1);
    if(group==='core')assert.equal(tool.risk,'read_only');
  }
  assert.equal(AGENT_TASK_TOOL_GROUP_IDS.length,12);assert.equal(AGENT_TASK_LOADABLE_TOOL_GROUP_IDS.length,11);
  assert.equal(agentTaskToolGroupForName('mioon_asset_import_selected'),'assets');
  assert.equal(agentTaskToolGroupForName('mioon_lut_import_selected'),'colour');
  assert.equal(agentTaskToolGroupForName('mioon_node_inspect'),'core');
  assert.equal(agentTaskToolGroupForName('mioon_edge_inspect'),'core');
  assert.equal(agentTaskToolGroupForName('mioon_task_wait'),'core');
  assert.equal(agentTaskToolGroupForName('mioon_goal_set'),'core');
  assert.equal(agentTaskToolGroupForName(AGENT_TASK_TOOLS_LOAD_NAME),'core');
  assert.equal(agentTaskToolGroupForName('mioon_unreviewed_tool'),undefined);
  assert.throws(()=>assertAgentTaskToolGroupCoverage(catalog.filter(tool=>tool.name!=='mioon_node_inspect')));
  assert.throws(()=>assertAgentTaskToolGroupCoverage([...catalog,catalog[0]!]));
  assert.throws(()=>assertAgentTaskToolGroupCoverage([...catalog,{name:'mioon_unreviewed_tool',operation:'unreviewed.tool'}]));
});

test('load parameters use a strict non-core closed set and normalize duplicate selections in catalog order',async t=>{
  const f=await fixture(t),input={groups:['images','canvas','images']};
  assert.deepEqual(parseAgentTaskToolLoadInput(input),['canvas','images']);assert.deepEqual(input.groups,['images','canvas','images']);
  const prepared=f.tools.prepare({projectId:f.projectId,operation:AGENT_TASK_TOOLS_LOAD_NAME,input});
  assert.deepEqual(prepared.input,{groups:['canvas','images']});assert.equal(prepared.operation,'tools.load');assert.equal(prepared.risk,'read_only');
  assert.deepEqual(prepared.targets,[]);assert.deepEqual(prepared.referencedTargets,[]);assert.deepEqual(prepared.before,{});
  for(const bad of [{},{groups:[]},{groups:['core']},{groups:['unreviewed']},{groups:[false]},{groups:['assets'],extra:true},{groups:Array(12).fill('canvas')}]){
    assert.equal(parseAgentTaskToolLoadInput(bad),null);
    assert.throws(()=>f.tools.prepare({projectId:f.projectId,operation:AGENT_TASK_TOOLS_LOAD_NAME,input:bad}),{code:'AGENT_TASK_INVALID_TOOL'});
  }
  assert.throws(()=>f.tools.prepare({projectId:f.projectId,operation:AGENT_TASK_TOOLS_LOAD_NAME,input:{groups:['assets'],projectId:f.projectId}}),{code:'AGENT_TASK_INVALID_TOOL'});
});

test('loading adds only newly completed groups without domain changes and remains local to one run',async t=>{
  const f=await fixture(t),projectBefore=f.store.get('projects',f.projectId);let fences=0;
  const first=await f.load(['images','canvas','images'],{complete:false,beforeEffect:()=>{fences++;}});
  assert.equal(fences,1);assert.equal(first.outcome.recorded,false);assert.deepEqual(first.outcome.changes,[]);
  const selected=new Set(['canvas','images']);
  const expectedTools=f.tools.list().filter(tool=>selected.has(agentTaskToolGroupForName(tool.name)??'')).map(tool=>tool.name);
  assert.deepEqual(first.outcome.result,{groups:['canvas','images'],tools:expectedTools});
  assert.deepEqual(loadedAgentTaskToolGroups(f.journal.snapshot(f.run.id).steps),[],'an unsaved outcome must not load tools');
  f.journal.completeStep(f.run.id,first.stepId,{result:first.outcome.result});
  assert.deepEqual(loadedAgentTaskToolGroups(f.journal.snapshot(f.run.id).steps),['canvas','images']);
  assert.deepEqual((await f.load(['canvas','images'])).outcome.result,{groups:[],tools:[]});
  const additional=await f.load(['video','canvas']);assert.ok(object(additional.outcome.result));assert.deepEqual(additional.outcome.result.groups,['video']);
  assert.deepEqual(loadedAgentTaskToolGroups(f.journal.snapshot(f.run.id).steps),['canvas','video','images']);
  assert.equal(f.journal.snapshot(f.run.id).changes.length,0);assert.equal(f.journal.run(f.run.id).stepsUsed,3);
  assert.deepEqual(f.store.get('projects',f.projectId),projectBefore);
  f.journal.transition(f.run.id,f.journal.run(f.run.id).revision,'completed');
  const next=f.journal.create({requestId:randomUUID(),projectId:f.projectId,text:'New run',configuration:{}}).run;
  assert.deepEqual((await f.load(['canvas'],{runId:next.id})).outcome.result,{groups:['canvas'],tools:f.tools.list().filter(tool=>agentTaskToolGroupForName(tool.name)==='canvas').map(tool=>tool.name)});
});

test('only completed host loading steps can add known groups',()=>{
  const step=savedLoadStep(['images']);
  for(const status of ['intent','awaiting_approval','dispatch_started','denied','rejected','failed','unknown'] as const)assert.deepEqual(loadedAgentTaskToolGroups([{...step,status}]),[]);
  assert.deepEqual(loadedAgentTaskToolGroups([{...step,kind:'model'}]),[]);
  assert.deepEqual(loadedAgentTaskToolGroups([{...step,toolCall:{id:'model_echo',name:'mioon_project_inspect',arguments:{}}}]),[]);
  assert.deepEqual(loadedAgentTaskToolGroups([savedLoadStep(['canvas']),step]),['canvas','images']);
});

test('each saved loading result is a subset of its own request independently of other receipts',()=>{
  const partial=savedLoadStep(['canvas','images'],{groups:['images'],tools:[]});
  assert.deepEqual(loadedAgentTaskToolGroups([partial]),['images']);
  assert.deepEqual(loadedAgentTaskToolGroups([savedLoadStep(['canvas','images'],{groups:[],tools:[]})]),[]);
  const repeated=savedLoadStep(['canvas'],{groups:['canvas'],tools:[]});
  assert.deepEqual(loadedAgentTaskToolGroups([repeated,repeated]),['canvas']);
  assert.deepEqual(loadedAgentTaskToolGroups([partial,savedLoadStep(['images','canvas'],{groups:['images','canvas','canvas'],tools:[]})]),['canvas','images']);
});

test('unknown saved group IDs are ignored only after the whole result satisfies its request subset',()=>{
  assert.deepEqual(loadedAgentTaskToolGroups([savedLoadStep(['future-group','canvas'],{groups:['future-group','canvas'],tools:[]})]),['canvas']);
  assert.deepEqual(loadedAgentTaskToolGroups([savedLoadStep(['future-group'],{groups:['future-group'],tools:[]})]),[]);
  assert.deepEqual(loadedAgentTaskToolGroups([savedLoadStep(['canvas'],{groups:['canvas','future-group'],tools:[]})]),[]);
  assert.deepEqual(loadedAgentTaskToolGroups([savedLoadStep(['future-group'],{groups:['future-group','canvas'],tools:[]})]),[]);
  assert.deepEqual(loadedAgentTaskToolGroups([savedLoadStep(['core'],{groups:['core'],tools:[]})]),[]);
});

test('invalid loading receipts are ignored without granting groups or invalidating later valid receipts',()=>{
  const invalidResults:AgentTaskJson[]=[null,{},true,[],{groups:null},{groups:'canvas'},{groups:[1]},{groups:['canvas','images']}];
  const invalidArguments:AgentTaskJson[]=[null,{},[],{groups:null},{groups:'canvas'},{groups:['canvas',null]}];
  const invalid=[...invalidResults.map(result=>savedLoadStep(['canvas'],result)),...invalidArguments.map(argumentsValue=>({...savedLoadStep(['canvas']),toolCall:{id:'invalid_arguments',name:AGENT_TASK_TOOLS_LOAD_NAME,arguments:argumentsValue}}))];
  for(const step of invalid)assert.deepEqual(loadedAgentTaskToolGroups([step]),[]);
  assert.deepEqual(loadedAgentTaskToolGroups(invalid),[]);
  assert.deepEqual(loadedAgentTaskToolGroups([...invalid,savedLoadStep(['images']),...invalid]),['images']);
});

test('saved tool names remain historical metadata rather than current catalog membership evidence',()=>{
  const results:AgentTaskJson[]=[
    {groups:['subjects']},
    {groups:['subjects'],tools:[]},
    {groups:['subjects'],tools:['mioon_subject_list']},
    {groups:['subjects'],tools:['mioon_retired_subject_tool','mioon_generation_submit']},
    {groups:['subjects'],tools:null,extra:{historical:true}},
    {groups:['subjects'],tools:{historical:'different metadata shape'}},
  ];
  for(const result of results){
    const step=savedLoadStep(['subjects'],result),before=structuredClone(step);
    assert.deepEqual(loadedAgentTaskToolGroups([step]),['subjects']);
    assert.deepEqual(step,before);
  }
});

test('the host loader retains the execution fence and only adds four-language presentation metadata',async t=>{
  const f=await fixture(t),blocked=Object.assign(Error('Synthetic revoked execution'),{code:'AGENT_TASK_CONSENT_REQUIRED'});
  await assert.rejects(f.load(['video'],{beforeEffect:()=>{throw blocked;}}),error=>error===blocked);
  assert.deepEqual(loadedAgentTaskToolGroups(f.journal.snapshot(f.run.id).steps),[]);
  assert.equal(Object.hasOwn(schemas,'tools.load'),false);assert.equal(Object.hasOwn(schemas,AGENT_TASK_TOOLS_LOAD_NAME),false);
  const loader=f.tools.list().find(tool=>tool.name===AGENT_TASK_TOOLS_LOAD_NAME);assert.ok(loader);assert.equal(loader.risk,'read_only');
  for(const group of AGENT_TASK_LOADABLE_TOOL_GROUP_IDS)assert.ok(loader.description.includes(group));
  assert.deepEqual(Object.keys(AGENT_TASK_TOOLS_LOAD_DESCRIPTIONS).sort(),['en','ja','zh-Hans','zh-Hant']);
  for(const description of Object.values(AGENT_TASK_TOOLS_LOAD_DESCRIPTIONS))for(const group of AGENT_TASK_LOADABLE_TOOL_GROUP_IDS)assert.ok(description.includes(group));
  assert.deepEqual(Object.keys(mioPanelMessages['agent.display.operation.tools.load']).sort(),['en','ja','zh-Hans','zh-Hant']);
  for(const translation of Object.values(mioPanelMessages['agent.display.operation.tools.load']))assert.ok(translation.length>0);
});
