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
import {createAgentTaskRuntime,agentTaskFailure} from '../packages/business/src/agent/task-runtime-v2.ts';
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
 const gateway:TaskGateway=async function*(){
  modelRequests++;
  const calls=modelRequests===1?[{id:'load_canvas',name:'mioon_tools_load',arguments:{groups:['canvas']}}]:modelRequests===2?firstCalls:[];
  yield {type:'done',output:output(protocol,calls)};
 };
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
 assert.equal(done.run.status,'completed');assert.equal(f.modelRequests,3);
 assert.deepEqual(done.steps.filter(step=>step.kind==='tool').map(step=>step.status),['completed','completed','completed']);
 assert.equal(done.changes.length,1);assert.equal(record(f.store.get('shots',f.shotId)).prompt,'AI prompt');
 const noOp=f.runtime.journal.snapshot(done.run.id).steps.find(step=>step.toolCall?.name==='mioon_shot_update');assert.ok(noOp);
 const evidence=record(noOp.data).executedTargets;assert.ok(Array.isArray(evidence));assert.equal(record(evidence[0]).revision,2);
});

for(const conflict of ['aba','claim'] as const)test(`approval after target ${conflict} hands the saved value back and replans without a skip choice`,async t=>{
 const f=await fixture(t);f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,local_reversible:'confirm'}});
 f.calls([call({shotId:f.shotId,expectedRevision:1,patch:{prompt:'Old approved parameters'}}),call({shotId:f.shotId,expectedRevision:2,patch:{title:'Old second call'}})]);
 const waiting=await f.send(),approval=waiting.steps.find(step=>step.status==='awaiting_approval');assert.ok(approval);assert.equal(waiting.run.status,'awaiting_approval');
 const target={kind:'shot',id:f.shotId,revision:f.runtime.journal.targetRevision(f.projectId,'shot',f.shotId)},ownerId=randomUUID();
 if(conflict==='aba'){
  const changed=record(await f.services.call('shot.update',{shotId:f.shotId,expectedRevision:1,patch:{prompt:'Manual transient edit'}}));
  await f.services.call('shot.update',{shotId:f.shotId,expectedRevision:changed.revision,patch:{prompt:'Saved prompt'}});
 }else f.runtime.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId,generation:1,sequence:1,action:'claim',targets:[target]});
 // The approval itself is still rejected with a durable receipt; a new plan needs a new approval.
 const request={requestId:randomUUID(),expectedRevision:waiting.run.revision,action:'approve',stepId:approval.id};
 // The CLI prints this message: the step did not run and Mio replans, nothing paused.
 await assert.rejects(f.runtime.action(f.projectId,waiting.run.id,request),conflict==='aba'?{code:'AGENT_TASK_TARGET_CHANGED',message:'该目标已被手动修改，这一步没有执行，Mio 会按当前内容重新规划。',handedBack:true}:{code:'AGENT_TASK_TARGET_CLAIMED',message:'该目标正在手动编辑，这一步没有执行，Mio 会重新规划。',handedBack:true});
 assert.equal(record(f.runtime.journal.lookupControl(request.requestId)?.result).state,'rejected');
 await f.runtime.drain();const done=f.runtime.get(f.projectId,waiting.run.id);
 assert.equal(done.run.status,'completed');assert.equal(f.modelRequests,3);assert.equal(done.changes.length,0);assert.deepEqual(done.run.skippedTargets,[]);
 assert.equal(f.runtime.journal.events(waiting.run.id).some(event=>event.type==='run'&&record(event.data).status==='paused'),false);
 const handed=done.steps.find(step=>step.id===approval.id);assert.equal(handed?.status,'rejected');const error=record(record(handed?.result).error);
 assert.equal(error.code,conflict==='aba'?'TARGET_CHANGED':'TARGET_EDITING');assert.ok(Array.isArray(error.current));assert.equal(record(record(error.current[0]).value).prompt,'Saved prompt');
 assert.equal(done.steps.filter(step=>step.toolCall?.name==='mioon_shot_update').length,1);
 assert.equal(record(f.store.get('shots',f.shotId)).title,'Saved title');assert.equal(record(f.store.get('shots',f.shotId)).prompt,'Saved prompt');
});

test('a handed-back approval says the step did not run while paths that still pause keep their wording',()=>{
 for(const [code,paused,handed] of [['AGENT_TASK_TARGET_CHANGED','该目标已被手动修改，任务已暂停。','该目标已被手动修改，这一步没有执行，Mio 会按当前内容重新规划。'],['AGENT_TASK_TARGET_CLAIMED','该目标正在手动编辑，任务已暂停。','该目标正在手动编辑，这一步没有执行，Mio 会重新规划。']] as const){
  const kept=agentTaskFailure(code),back=agentTaskFailure(code,{handedBack:true});
  assert.equal(kept.message,paused);assert.equal(kept.status,409);assert.equal(Object.hasOwn(kept,'handedBack'),false);
  assert.equal(back.message,handed);assert.doesNotMatch(back.message,/暂停/u);assert.equal(back.code,code);assert.equal(back.status,409);assert.equal(back.handedBack,true);
 }
 // Only the two conflict codes have a hand-back wording.
 const other=agentTaskFailure('AGENT_TASK_PAUSED',{handedBack:true});assert.equal(other.message,'任务已暂停。');assert.equal(Object.hasOwn(other,'handedBack'),false);
});

test('a stale approval can be denied after target changes and authorization revocation',async t=>{
 const f=await fixture(t);f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,local_reversible:'confirm'}});
 f.calls([call({shotId:f.shotId,expectedRevision:1,patch:{prompt:'Rejected AI edit'}})]);
 const waiting=await f.send(),approval=waiting.steps.find(step=>step.status==='awaiting_approval');assert.ok(approval);
 await f.services.call('shot.update',{shotId:f.shotId,expectedRevision:1,patch:{prompt:'Saved manual edit'}});await f.revoke();
 const rejected=await f.action(waiting,'deny',{stepId:approval.id});assert.equal(rejected.steps.find(step=>step.id===approval.id)?.status,'rejected');
 await f.runtime.drain();const done=f.runtime.get(f.projectId,waiting.run.id);
 assert.equal(f.modelRequests,2);assert.equal(done.steps.find(step=>step.id===approval.id)?.status,'rejected');assert.equal(done.changes.length,0);assert.equal(record(f.store.get('shots',f.shotId)).prompt,'Saved manual edit');
});
