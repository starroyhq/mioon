import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../packages/business/src/agent/task-runtime-v2.ts';
import type {TaskGateway,TaskModelOutput} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {AgentTaskControlAction,AgentTaskJson,AgentTaskSnapshot,AgentTaskToolCall} from '../packages/contracts/src/agent-tasks-v2.ts';
import {createTestAuthorizations,authorizeTestScope} from './helpers/agent-authorizations.ts';

function record(value:unknown):Record<string,unknown>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;}
const call=(argumentsValue:AgentTaskJson):AgentTaskToolCall=>({id:randomUUID(),name:'mioon_shot_update',arguments:argumentsValue});
function output(protocol:'chat_completions'|'responses',calls:AgentTaskToolCall[]):TaskModelOutput{
 const providerOutput:AgentTaskJson=protocol==='responses'
  ?calls.map(item=>({type:'function_call',id:`fc_${item.id}`,call_id:item.id,name:item.name,arguments:JSON.stringify(item.arguments),status:'completed'}))
  :{role:'assistant',content:'Local synthetic result',...(calls.length?{tool_calls:calls.map(item=>({id:item.id,type:'function',function:{name:item.name,arguments:JSON.stringify(item.arguments)}}))}:{})};
 return {text:'Local synthetic result',toolCalls:calls,providerOutput};
}
async function fixture(t:TestContext,protocol:'chat_completions'|'responses'='responses'){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-task-boundaries-v2-')),store=openStore(root),services=createServices(store,new Map());
 const project=record(await services.call('project.create',{name:'Boundary test'})),projectId=String(project.id);
 const shot=record(await services.call('shot.create',{projectId,title:'Saved title',prompt:'Saved prompt'})),shotId=String(shot.id);
 const settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}}),initial=await settings.get();
 await settings.put({expectedRevision:0,configuration:{...initial.configuration,protocol},secret:{action:'replace',storage:'session',value:'SYNTHETIC_BOUNDARY_TEST_ONLY'}});
 const authorizations=createTestAuthorizations(()=>({...store}),settings);await authorizeTestScope(authorizations,'project_agent');
 const tools=createAgentTaskTools({store,services});let modelRequests=0,firstCalls:AgentTaskToolCall[]=[];
 const gateway:TaskGateway=async function*(){yield {type:'done',output:output(protocol,++modelRequests===1?firstCalls:[])};};
 const runtime=createAgentTaskRuntime({store,agentSettings:settings,authorizations,tools,gateway,selfPort:()=>4318});
 t.after(async()=>{runtime.close();await runtime.drain();tools.dispose();await services.drain();await settings.close();store.close();rmSync(root,{recursive:true,force:true});});
 return {store,services,runtime,projectId,shotId,authorizations,
  get modelRequests(){return modelRequests;},calls(value:AgentTaskToolCall[]){firstCalls=value;},
  async send(){const sent=await runtime.send(projectId,{requestId:randomUUID(),text:'Synthetic boundary test',expectedSettingsRevision:(await settings.get()).revision});await runtime.drain();return runtime.get(projectId,sent.run.id);},
  action(snapshot:AgentTaskSnapshot,action:AgentTaskControlAction,extra:Record<string,unknown>={}){return runtime.action(projectId,snapshot.run.id,{requestId:randomUUID(),expectedRevision:snapshot.run.revision,action,...extra});},
  async revoke(){const current=await authorizations.list(),grant=current.authorizations.find(item=>item.scope==='project_agent');assert.ok(grant);await authorizations.revoke({requestId:randomUUID(),expectedRevision:current.revision,authorizationId:grant.id});},
 };
}

for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: a saved no-op revision advances only its own model batch`,async t=>{
 const f=await fixture(t,protocol);
 f.calls([call({shotId:f.shotId,expectedRevision:1,patch:{title:'Saved title'}}),call({shotId:f.shotId,expectedRevision:2,patch:{prompt:'AI prompt'}})]);
 const done=await f.send();
 assert.equal(done.run.status,'completed');assert.equal(f.modelRequests,2);
 assert.deepEqual(done.steps.filter(step=>step.kind==='tool').map(step=>step.status),['completed','completed']);
 assert.equal(done.changes.length,1);assert.equal(record(f.store.get('shots',f.shotId)).prompt,'AI prompt');
 const noOp=f.runtime.journal.snapshot(done.run.id).steps.find(step=>step.kind==='tool');assert.ok(noOp);
 const evidence=record(noOp.data).executedTargets;assert.ok(Array.isArray(evidence));assert.equal(record(evidence[0]).revision,2);
});

for(const conflict of ['aba','claim'] as const)test(`approval after target ${conflict} pauses until explicit skip invalidates the old batch before replanning`,async t=>{
 const f=await fixture(t);f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,local_reversible:'confirm'}});
 f.calls([call({shotId:f.shotId,expectedRevision:1,patch:{prompt:'Old approved parameters'}}),call({shotId:f.shotId,expectedRevision:2,patch:{title:'Old second call'}})]);
 const waiting=await f.send(),approval=waiting.steps.find(step=>step.status==='awaiting_approval');assert.ok(approval);assert.equal(waiting.run.status,'awaiting_approval');
 const target={kind:'shot',id:f.shotId,revision:f.runtime.journal.targetRevision(f.projectId,'shot',f.shotId)},ownerId=randomUUID();
 if(conflict==='aba'){
  const changed=record(await f.services.call('shot.update',{shotId:f.shotId,expectedRevision:1,patch:{prompt:'Manual transient edit'}}));
  await f.services.call('shot.update',{shotId:f.shotId,expectedRevision:changed.revision,patch:{prompt:'Saved prompt'}});
 }else f.runtime.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId,generation:1,sequence:1,action:'claim',targets:[target]});
 await assert.rejects(f.action(waiting,'approve',{stepId:approval.id}),{code:conflict==='aba'?'AGENT_TASK_TARGET_CHANGED':'AGENT_TASK_TARGET_CLAIMED'});
 const paused=f.runtime.get(f.projectId,waiting.run.id);assert.equal(paused.run.status,'paused');assert.equal(paused.run.pauseReason,conflict==='aba'?'conflict':'editing');assert.equal(f.modelRequests,1);
 assert.equal(record(f.store.get('shots',f.shotId)).prompt,'Saved prompt');
 if(conflict==='claim')f.runtime.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId,generation:1,sequence:2,action:'release',targets:[target]});
 await assert.rejects(f.action(paused,'resume'),{code:'AGENT_TASK_SKIP_REQUIRED'});assert.equal(f.modelRequests,1);assert.deepEqual(f.runtime.get(f.projectId,waiting.run.id).run.skippedTargets,[]);
 await f.action(paused,'skip');await f.runtime.drain();const done=f.runtime.get(f.projectId,waiting.run.id);
 assert.equal(done.run.status,'completed');assert.equal(f.modelRequests,2);assert.equal(done.changes.length,0);
 assert.deepEqual(done.run.skippedTargets?.map(item=>({kind:item.target.kind,id:item.target.id,stepId:item.stepId})),[{kind:'shot',id:f.shotId,stepId:approval.id}]);const skipped=done.steps.find(step=>step.id===approval.id);assert.equal(skipped?.status,'denied');assert.equal(record(record(skipped?.result).error).code,'TARGET_SKIPPED');
 assert.equal(record(f.store.get('shots',f.shotId)).title,'Saved title');assert.equal(record(f.store.get('shots',f.shotId)).prompt,'Saved prompt');
});

test('a stale approval can be denied after target changes and authorization revocation',async t=>{
 const f=await fixture(t);f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,local_reversible:'confirm'}});
 f.calls([call({shotId:f.shotId,expectedRevision:1,patch:{prompt:'Rejected AI edit'}})]);
 const waiting=await f.send(),approval=waiting.steps.find(step=>step.status==='awaiting_approval');assert.ok(approval);
 await f.services.call('shot.update',{shotId:f.shotId,expectedRevision:1,patch:{prompt:'Saved manual edit'}});await f.revoke();
 const rejected=await f.action(waiting,'deny',{stepId:approval.id});assert.equal(rejected.steps.find(step=>step.id===approval.id)?.status,'rejected');
 await f.runtime.drain();const done=f.runtime.get(f.projectId,waiting.run.id);
 assert.equal(f.modelRequests,1);assert.equal(done.steps.find(step=>step.id===approval.id)?.status,'rejected');assert.equal(done.changes.length,0);assert.equal(record(f.store.get('shots',f.shotId)).prompt,'Saved manual edit');
});
