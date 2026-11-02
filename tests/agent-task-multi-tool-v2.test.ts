import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {createAgentTaskTools,type AgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime,agentTaskFailure} from '../packages/business/src/agent/task-runtime-v2.ts';
import type {TaskGateway,TaskModelOutput} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {AgentProtocol} from '../packages/contracts/src/agent-protocol.ts';
import type {AgentTaskJson,AgentTaskSnapshot,AgentTaskToolCall} from '../packages/contracts/src/agent-tasks-v2.ts';
import {authorizeTestScope,createTestAuthorizations} from './helpers/agent-authorizations.ts';

const protocols=['chat_completions','responses','anthropic_messages'] as const satisfies readonly AgentProtocol[];
function record(value:unknown):Record<string,unknown>{assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;}
const call=(id:string,name:string,args:AgentTaskJson={}):AgentTaskToolCall=>({id,name,arguments:args});
function output(protocol:AgentProtocol,calls:AgentTaskToolCall[]):TaskModelOutput{
  const text=calls.length?'':'Done.';
  const providerOutput:AgentTaskJson=protocol==='anthropic_messages'?{role:'assistant',content:[...(text?[{type:'text',text}]:[]),...calls.map(item=>({type:'tool_use',id:item.id,name:item.name,input:item.arguments}))]}:
    protocol==='responses'?[...(text?[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text}]}]:[]),...calls.map(item=>({type:'function_call',id:`item_${item.id}`,status:'completed',call_id:item.id,name:item.name,arguments:JSON.stringify(item.arguments)}))]:
    {role:'assistant',content:text||null,...(calls.length?{tool_calls:calls.map(item=>({id:item.id,type:'function',function:{name:item.name,arguments:JSON.stringify(item.arguments)}}))}:{})};
  return {text,toolCalls:calls,providerOutput};
}

async function fixture(t:TestContext,protocol:AgentProtocol,kind:'approve'|'deny'|'answer'){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-multi-tool-')),store=openStore(root),services=createServices(store,new Map());
  const project=record(await services.call('project.create',{name:'Multi-tool decisions'})),projectId=String(project.id);
  const first=record(await services.call('shot.create',{projectId,title:'First',prompt:'Original first'}));
  const second=record(await services.call('shot.create',{projectId,title:'Second',prompt:'Original second'}));
  const settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}});
  await settings.put({expectedRevision:0,configuration:{presetId:'ollama',platformId:'local',protocol,baseUrl:`http://127.0.0.1:11434${protocol==='anthropic_messages'?'':'/v1'}`,model:'qwen3:8b'},secret:{action:'remove'}});
  const authorizations=createTestAuthorizations(()=>({...store}),settings);await authorizeTestScope(authorizations,'project_agent');
  const tools=createAgentTaskTools({store,services}),executed:string[]=[],preparedUpdates:string[]=[],bodies:string[]=[];
  const observed:AgentTaskTools={...tools,prepare(input){if(input.operation==='mioon_shot_update')preparedUpdates.push(String(record(input.input).shotId));return tools.prepare(input);},async execute(prepared,context){executed.push(context.stepId);return tools.execute(prepared,context);}};
  const middle=kind==='answer'?call('middle','mioon_ask',{question:'Which option?',options:[{label:'First'},{label:'Second'}]}):call('middle','mioon_shot_update',{shotId:String(first.id),expectedRevision:1,patch:{prompt:'Approved first'}});
  const suffix=kind==='approve'?call('suffix','mioon_project_inspect'):call('suffix','mioon_shot_update',{shotId:String(second.id),expectedRevision:1,patch:{prompt:'Old suffix must not run'}});
  const batch=[call('prefix','mioon_project_inspect'),middle,suffix];
  const gateway:TaskGateway=async function*(request){
    bodies.push(request.body);
    yield {type:'done',output:output(protocol,bodies.length===1?[call('load','mioon_tools_load',{names:['mioon_shot_update']})]:bodies.length===2?batch:[])};
  };
  const create=()=>createAgentTaskRuntime({store,agentSettings:settings,authorizations,tools:observed,gateway,selfPort:()=>4318});
  let runtime=create();
  if(kind!=='answer'){const policy=runtime.policy();runtime.journal.updatePolicy({...policy,modes:{...policy.modes,local_reversible:'confirm'}});}
  t.after(async()=>{runtime.close();await runtime.drain();tools.dispose();await services.drain();await settings.close();store.close();rmSync(root,{recursive:true,force:true});});
  return {store,services,settings,projectId,firstId:String(first.id),secondId:String(second.id),executed,preparedUpdates,bodies,get runtime(){return runtime;},
    async send(){const sent=await runtime.send(projectId,{requestId:randomUUID(),text:'Independent short calls; ask last.',expectedSettingsRevision:(await settings.get()).revision});await runtime.drain();return runtime.get(projectId,sent.run.id);},
    async restart(snapshot:AgentTaskSnapshot){
      runtime.close();await runtime.drain();runtime=create();
      const current=runtime.get(projectId,snapshot.run.id);
      if(current.run.status==='interrupted'){
        await runtime.action(projectId,current.run.id,{requestId:randomUUID(),expectedRevision:current.run.revision,action:'resume'});
        await runtime.drain();
      }
    },
    current(snapshot:AgentTaskSnapshot){return runtime.get(projectId,snapshot.run.id);},
  };
}

for(const protocol of protocols)for(const kind of ['approve','deny','answer'] as const)test(`${protocol}: ${kind} in the middle keeps the completed prefix and applies the suffix decision across restart`,async t=>{
  const f=await fixture(t,protocol,kind);let waiting=await f.send();
  assert.equal(waiting.run.status,kind==='answer'?'awaiting_answer':'awaiting_approval');
  assert.equal(f.bodies.length,2);
  const prefix=waiting.steps.find(step=>step.toolCall?.id==='prefix'),middle=waiting.steps.find(step=>step.toolCall?.id==='middle');assert.ok(prefix);assert.ok(middle);
  assert.equal(prefix.status,'completed');assert.equal(f.executed.filter(id=>id===prefix.id).length,1);
  assert.equal(waiting.steps.some(step=>step.toolCall?.id==='suffix'),false);
  await f.restart(waiting);waiting=f.current(waiting);
  const request={requestId:randomUUID(),expectedRevision:waiting.run.revision,action:kind,stepId:middle.id,...(kind==='answer'?{choices:[1]}:{})};
  await f.runtime.action(f.projectId,waiting.run.id,request);await f.runtime.drain();
  const done=f.current(waiting);
  assert.equal(done.run.status,'completed',JSON.stringify({run:done.run,steps:done.steps.map(step=>({status:step.status,error:step.error}))}));assert.equal(f.bodies.length,3);
  assert.equal(f.executed.filter(id=>id===prefix.id).length,1,'completed prefix never runs twice');
  assert.equal(record(f.store.get('shots',f.secondId)).prompt,'Original second');
  if(kind==='approve'){
    assert.equal(record(f.store.get('shots',f.firstId)).prompt,'Approved first');
    assert.equal(done.steps.find(step=>step.toolCall?.id==='middle')?.status,'completed');
    assert.equal(done.steps.find(step=>step.toolCall?.id==='suffix')?.status,'completed');
    assert.equal(done.changes.length,1);
  }else{
    assert.equal(record(f.store.get('shots',f.firstId)).prompt,'Original first');
    assert.equal(done.steps.some(step=>step.toolCall?.id==='suffix'),false,'the invalidated suffix never reaches preparation or dispatch');
    assert.equal(done.changes.length,0);
    const source=f.runtime.journal.snapshot(done.run.id).steps.filter(step=>step.kind==='model')[1];assert.ok(source);
    assert.equal(record(source.data).toolsInvalidated,true);
    assert.equal(record(source.data).toolsInvalidatedReason,kind==='deny'?'user_rejected':'user_answered');
    assert.ok(f.bodies[2]!.includes(kind==='deny'?'USER_REJECTED':'USER_ANSWERED'),'the next request tells Mio why the suffix did not run');
    if(kind==='answer')assert.deepEqual(record(record(done.steps.find(step=>step.id===middle.id)?.result).answer).choices,[1]);
    assert.equal(f.preparedUpdates.includes(f.secondId),false,'no invalidated suffix target is prepared');
  }
  const count=f.executed.length;
  await f.runtime.action(f.projectId,waiting.run.id,request);await f.runtime.drain();
  assert.equal(f.executed.length,count,'replayed control receipt does not rerun the prefix or suffix');
});

test('undo conflict wording does not claim a terminal run paused or handed back',()=>{
  for(const code of ['AGENT_TASK_TARGET_CHANGED','AGENT_TASK_TARGET_CLAIMED']){
    const failure=agentTaskFailure(code,{undo:true});
    assert.equal(failure.code,code);assert.equal(failure.status,409);assert.match(failure.message,/本次撤销没有完成/u);
    assert.doesNotMatch(failure.message,/暂停/u);assert.equal(Object.hasOwn(failure,'handedBack'),false);
    assert.match(agentTaskFailure(code).message,/暂停/u,'background pause wording stays unchanged');
  }
});

for(const action of ['undo_change','undo_all'] as const)test(`${action}: conflicting terminal undo retains its status, code and durable receipt`,async t=>{
  const f=await fixture(t,'chat_completions','approve'),waiting=await f.send(),middle=waiting.steps.find(step=>step.toolCall?.id==='middle');assert.ok(middle);
  await f.runtime.action(f.projectId,waiting.run.id,{requestId:randomUUID(),expectedRevision:waiting.run.revision,action:'approve',stepId:middle.id});await f.runtime.drain();
  const done=f.current(waiting);assert.equal(done.run.status,'completed',JSON.stringify({run:done.run,steps:done.steps.map(step=>({status:step.status,error:step.error}))}));const change=done.changes[0];assert.ok(change);
  await f.services.call('shot.update',{shotId:f.firstId,expectedRevision:2,patch:{prompt:'External edit'}});
  const request={requestId:randomUUID(),expectedRevision:done.run.revision,action,...(action==='undo_change'?{changeId:change.id}:{undoChangeIds:[randomUUID()]})};
  // A terminal run can still own background work. An undo conflict must not
  // enter that background pause path or change its terminal state.
  f.runtime.journal.hasPendingBackground=()=>true;
  await assert.rejects(f.runtime.action(f.projectId,done.run.id,request),{code:'AGENT_TASK_TARGET_CHANGED',status:409,message:'目标已被修改，本次撤销没有完成。请检查当前保存状态。'});
  assert.equal(f.current(done).run.status,'completed');assert.equal(record(f.store.get('shots',f.firstId)).prompt,'External edit');
  assert.ok(f.runtime.journal.lookupControl(request.requestId));
});
