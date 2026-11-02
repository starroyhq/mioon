import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openStore,classifyCurrentWorkspaceSchema} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../packages/business/src/agent/task-runtime-v2.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {createWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import type {TaskGateway} from '../packages/business/src/agent/task-gateway-v2.ts';
import {AGENT_TASK_POLICY_PRESETS,DEFAULT_AGENT_TASK_POLICY,agentTaskPolicyPreset} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskControlAction,AgentTaskJson,AgentTaskPolicyModes,AgentTaskSnapshot,AgentTaskToolCall} from '../packages/contracts/src/agent-tasks-v2.ts';
import {createTestAuthorizations,authorizeTestScope} from './helpers/agent-authorizations.ts';
import {foreignKeyCheck} from './helpers/project-database.ts';
import {downgradeReviewedWorkspace} from './helpers/reviewed-schema-layers.ts';
import {CURRENT_RESTORE_PROFILE,CURRENT_RESTORED_SCHEMA,assertCurrentOrdinaryWorkspace} from './helpers/workspace-schema-current.ts';

const record=(value:unknown):Record<string,unknown>=>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;};
// Questions are model input: deliberately loose here so invalid ones can be sent too.
const ask=(args:object):AgentTaskToolCall=>({id:randomUUID(),name:'mioon_ask',arguments:args as AgentTaskJson});
const load=():AgentTaskToolCall=>({id:randomUUID(),name:'mioon_tools_load',arguments:{groups:['canvas']}});
const rename=(shotId:string,expectedRevision:number,title:string):AgentTaskToolCall=>({id:randomUUID(),name:'mioon_shot_update',arguments:{shotId,expectedRevision,patch:{title}}});
const opening={question:'Which opening should Mio use?',options:[{label:'Wide street',description:'Establish the city first'},{label:'Close-up'},{label:'Rooftop'}]};
const {step:STEP,default:DEFAULT,full:FULL}=AGENT_TASK_POLICY_PRESETS;

/** One runtime over a real workspace. Each model request answers with the
 * next queued batch of tool calls; an empty queue ends the round. */
async function fixture(t:TestContext){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-policy-answer-v2-')),store=openStore(root),services=createServices(store,new Map());
 const projectId=String(record(await services.call('project.create',{name:'Policy and answer test'})).id);
 const shotId=String(record(await services.call('shot.create',{projectId,title:'Saved title'})).id);
 const settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}}),initial=await settings.get();
 await settings.put({expectedRevision:0,configuration:{...initial.configuration,protocol:'chat_completions'},secret:{action:'replace',storage:'session',value:'SYNTHETIC_POLICY_ANSWER_TEST_ONLY'}});
 const authorizations=createTestAuthorizations(()=>({...store}),settings);await authorizeTestScope(authorizations,'project_agent');
 const tools=createAgentTaskTools({store,services}),bodies:string[]=[],queue:AgentTaskToolCall[][]=[];
 const gateway:TaskGateway=async function*(request){
  bodies.push(request.body);const calls=queue.shift()??[];
  yield {type:'done',output:{text:calls.length?'':'Done locally',toolCalls:calls,providerOutput:{role:'assistant',content:calls.length?null:'Done locally',...(calls.length?{tool_calls:calls.map(call=>({id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}))}:{})}}};
 };
 const create=()=>createAgentTaskRuntime({store,agentSettings:settings,authorizations,tools,gateway,selfPort:()=>4318});
 let runtime=create(),open=true;
 const shutdown=async()=>{if(!open)return;open=false;runtime.close();await runtime.drain();tools.dispose();await services.drain();await settings.close();store.close();};
 t.after(async()=>{await shutdown();rmSync(root,{recursive:true,force:true});});
 const f={root,store,services,projectId,shotId,bodies,shutdown,
  get runtime(){return runtime;},
  async settingsRevision(){return (await settings.get()).revision;},
  queue(...batches:AgentTaskToolCall[][]){queue.push(...batches);},
  async send(text:string,extra:Record<string,unknown>={}):Promise<AgentTaskSnapshot>{const sent=await runtime.send(projectId,{requestId:randomUUID(),text,expectedSettingsRevision:(await settings.get()).revision,...extra});await runtime.drain();return runtime.get(projectId,sent.run.id);},
  async submit(input:Record<string,unknown>):Promise<AgentTaskSnapshot>{const sent=await runtime.send(projectId,input);await runtime.drain();return runtime.get(projectId,sent.run.id);},
  get(runId:string){return runtime.get(projectId,runId);},
  async action(runId:string,action:AgentTaskControlAction,extra:Record<string,unknown>={}){const current=runtime.get(projectId,runId);const next=await runtime.action(projectId,runId,{requestId:randomUUID(),expectedRevision:current.run.revision,action,...extra});await runtime.drain();return {sent:next,settled:runtime.get(projectId,runId)};},
  setPolicy(conversationId:string,expectedRevision:number,modes:AgentTaskPolicyModes|null,extra:Record<string,unknown>={}){return runtime.setConversationPolicy(projectId,conversationId,{requestId:randomUUID(),expectedRevision,modes,...extra});},
  title(){return String(record(store.get('shots',shotId)).title);},
  restart(){runtime.close();runtime=create();},
 };
 return f;
}
const question=(snapshot:AgentTaskSnapshot)=>{const step=snapshot.steps.find(item=>item.toolCall?.name==='mioon_ask');assert.ok(step);return step;};

test('a question waits for the answer, dispatches nothing and returns the answer to the model as its tool result',async t=>{
 const f=await fixture(t);f.queue([ask(opening)]);
 const waiting=await f.send('Plan the opening shot');
 assert.equal(waiting.run.status,'awaiting_answer');assert.equal(f.bodies.length,1);
 const step=question(waiting);assert.equal(step.status,'awaiting_answer');assert.equal(step.tier,'read_only');assert.equal(step.result,undefined);
 // The question is answered, never resumed past; pausing it changes nothing.
 await assert.rejects(f.action(waiting.run.id,'resume'),{code:'AGENT_TASK_STATE_CONFLICT'});
 assert.equal((await f.action(waiting.run.id,'pause')).settled.run.status,'awaiting_answer');
 // Text typed while a question waits is its answer, not a note for later.
 await assert.rejects(f.action(waiting.run.id,'note',{text:'More context'}),{code:'AGENT_TASK_STATE_CONFLICT'});
 const used=f.get(waiting.run.id).run.stepsUsed;
 const {settled:done}=await f.action(waiting.run.id,'answer',{stepId:step.id,choices:[1]});
 assert.equal(done.run.status,'completed');assert.equal(f.bodies.length,2);
 const answered=done.steps.find(item=>item.id===step.id)!;assert.equal(answered.status,'completed');
 assert.deepEqual(answered.result,{answer:{choices:[1]},selected:['Close-up']});
 assert.equal(done.run.stepsUsed,used+1,'the answer itself is not a step; only the next model round is');
 const body=JSON.parse(f.bodies[1]!) as {messages:{role:string;tool_call_id?:string;content?:unknown}[]};
 const result=body.messages.find(item=>item.role==='tool'&&item.tool_call_id===step.toolCall!.id);assert.ok(result);assert.match(String(result.content),/Close-up/u);
 assert.equal(f.title(),'Saved title');
});

test('answers follow the question: one choice unless multiple, other text beside a choice only when allowed',async t=>{
 const f=await fixture(t);f.queue([ask(opening)]);
 const single=await f.send('Pick one opening'),step=question(single);
 for(const invalid of [{choices:[0,1]},{choices:[3]},{choices:[0],text:'And a drone shot'},{choices:[]},{choices:[0,0]},{choices:[],text:'   '},{choices:[0],extra:true}])
  await assert.rejects(f.action(single.run.id,'answer',{stepId:step.id,...invalid}),{code:'AGENT_TASK_INVALID'},JSON.stringify(invalid));
 assert.equal(f.get(single.run.id).run.status,'awaiting_answer');assert.equal(f.bodies.length,1);
 // Typed text alone answers any question, as when the user replies in the composer.
 const {settled:typed}=await f.action(single.run.id,'answer',{stepId:step.id,choices:[],text:'  Open on the harbour instead  '});
 assert.deepEqual(typed.steps.find(item=>item.id===step.id)?.result,{answer:{choices:[],text:'Open on the harbour instead'},selected:[],text:'Open on the harbour instead'});
 f.queue([ask({...opening,multiple:true,allowOther:true})]);
 const multiple=await f.send('Pick several openings',{conversationId:single.run.conversationId}),second=question(multiple);
 const {settled:done}=await f.action(multiple.run.id,'answer',{stepId:second.id,choices:[2,0],text:'Also a drone shot'});
 assert.equal(done.run.status,'completed');
 assert.deepEqual(done.steps.find(item=>item.id===second.id)?.result,{answer:{choices:[0,2],text:'Also a drone shot'},selected:['Wide street','Rooftop'],text:'Also a drone shot'});
});

test('an answer replays under its request id, conflicts when changed, and answers only the waiting question of its run',async t=>{
 const f=await fixture(t);f.queue([ask(opening)]);
 const waiting=await f.send('Plan the opening'),step=question(waiting);
 await assert.rejects(f.action(waiting.run.id,'answer',{stepId:randomUUID(),choices:[0]}),{code:'AGENT_TASK_NOT_FOUND'});
 const modelStep=waiting.steps.find(item=>item.kind==='model')!;
 await assert.rejects(f.action(waiting.run.id,'answer',{stepId:modelStep.id,choices:[0]}),{code:'AGENT_TASK_INVALID'});
 const input={requestId:randomUUID(),expectedRevision:waiting.run.revision,action:'answer',stepId:step.id,choices:[2]};
 await f.runtime.action(f.projectId,waiting.run.id,input);await f.runtime.drain();
 const replay=await f.runtime.action(f.projectId,waiting.run.id,input);assert.equal(replay.run.status,'completed');
 await assert.rejects(f.runtime.action(f.projectId,waiting.run.id,{...input,choices:[1]}),{code:'AGENT_TASK_REQUEST_CONFLICT'});
 assert.equal(f.runtime.journal.lookupControl(input.requestId)?.action,'answer');
 await assert.rejects(f.action(waiting.run.id,'answer',{stepId:step.id,choices:[0]}),{code:'AGENT_TASK_STATE_CONFLICT'});
 assert.equal(f.bodies.length,2);
});

test('stopping leaves the question unanswered and a restart keeps it waiting after resume',async t=>{
 const f=await fixture(t);f.queue([ask(opening)]);
 const waiting=await f.send('Plan the opening'),step=question(waiting);
 f.restart();
 const interrupted=f.get(waiting.run.id);assert.equal(interrupted.run.status,'interrupted');assert.equal(question(interrupted).status,'awaiting_answer');
 await assert.rejects(f.action(waiting.run.id,'answer',{stepId:step.id,choices:[0]}),{code:'AGENT_TASK_STATE_CONFLICT'});
 const {settled:again}=await f.action(waiting.run.id,'resume');
 assert.equal(again.run.status,'awaiting_answer');assert.equal(question(again).id,step.id);assert.equal(f.bodies.length,1,'resuming never asks the model again');
 const {settled:stopped}=await f.action(waiting.run.id,'stop');
 assert.equal(stopped.run.status,'stopped');assert.equal(question(stopped).status,'awaiting_answer');assert.equal(question(stopped).result,undefined);
 await assert.rejects(f.action(waiting.run.id,'answer',{stepId:step.id,choices:[0]}),{code:'AGENT_TASK_STATE_CONFLICT'});
 assert.equal(f.bodies.length,1);
});

test('an answer is never an approval: a later confirmation still waits for its own decision',async t=>{
 const f=await fixture(t);f.queue([ask({question:'Rename the shot?',options:[{label:'Yes'},{label:'No'}]})],[load()],[rename(f.shotId,1,'Approved title')]);
 const waiting=await f.send('Rename after asking',{policy:{modes:STEP}}),step=question(waiting);
 const {settled:confirm}=await f.action(waiting.run.id,'answer',{stepId:step.id,choices:[0]});
 assert.equal(confirm.run.status,'awaiting_approval');assert.equal(f.title(),'Saved title');
 const pending=confirm.steps.find(item=>item.status==='awaiting_approval');assert.ok(pending);assert.equal(pending.toolCall?.name,'mioon_shot_update');
 const {settled:done}=await f.action(waiting.run.id,'approve',{stepId:pending.id});
 assert.equal(done.run.status,'completed');assert.equal(f.title(),'Approved title');
});

test('an invalid question returns field feedback to the model instead of waiting or failing the round',async t=>{
 const f=await fixture(t);
 f.queue([ask({question:'Line one\nline two',options:[{label:'A'},{label:'B'}]})],[ask({question:'Pick',options:[{label:'Same'},{label:'Same'}],note:'x'})],[ask({question:'Pick',options:[{label:'Only'}]})]);
 const done=await f.send('Ask badly');
 assert.equal(done.run.status,'completed');assert.equal(f.bodies.length,4);
 const asked=done.steps.filter(item=>item.toolCall?.name==='mioon_ask');assert.equal(asked.length,3);
 const issues=(item:typeof asked[number])=>(record(record(item.result).error).issues as {field:string;reason:string}[]).map(issue=>`${issue.field}:${issue.reason}`).sort();
 assert.deepEqual(asked.map(issues),[['question:invalid_value'],['input:unknown_field','options:invalid_value'],['options:invalid_value']]);
 for(const [index,item] of asked.entries()){
  assert.equal(item.status,'rejected');assert.equal(item.error?.code,'VALIDATION_ERROR');assert.match(item.error?.message??'',/提问参数未通过本地校验/u);
  assert.match(f.bodies[index+1]!,/提问参数未通过本地校验/u);
 }
 assert.doesNotMatch(JSON.stringify(asked.map(item=>item.result)),/Line one|Same|Only/u,'feedback names fields, never the asked values');
});

test('a conversation policy saves, replays and clears its own modes under its revision',async t=>{
 const f=await fixture(t),first=await f.send('First round'),conversationId=first.run.conversationId!;
 const global=f.runtime.policy();
 assert.deepEqual(f.runtime.conversationPolicy(f.projectId,conversationId),{projectId:f.projectId,conversationId,revision:0,override:null,global,effective:global.modes});
 const input={requestId:randomUUID(),expectedRevision:0,modes:STEP};
 const saved=f.runtime.setConversationPolicy(f.projectId,conversationId,input);
 assert.equal(saved.revision,1);assert.deepEqual(saved.override,STEP);assert.deepEqual(saved.effective,STEP);
 assert.deepEqual(f.runtime.setConversationPolicy(f.projectId,conversationId,input),saved);
 assert.throws(()=>f.runtime.setConversationPolicy(f.projectId,conversationId,{...input,modes:DEFAULT}),{code:'AGENT_TASK_REQUEST_CONFLICT'});
 assert.throws(()=>f.setPolicy(conversationId,0,null),{code:'AGENT_TASK_REVISION_CONFLICT'});
 const cleared=f.setPolicy(conversationId,1,null);
 assert.equal(cleared.revision,2);assert.equal(cleared.override,null);assert.deepEqual(cleared.effective,global.modes);
 const row=f.store.db.prepare('SELECT revision,data FROM agent_task_conversation_policies_v2 WHERE conversationId=?').get(conversationId)!;
 assert.equal(row.revision,2);assert.equal(JSON.parse(String(row.data)).modes,null,'a cleared override keeps its row so the revision keeps counting');
 assert.throws(()=>f.runtime.conversationPolicy(f.projectId,randomUUID()),{code:'AGENT_TASK_NOT_FOUND'});
 assert.throws(()=>f.setPolicy(randomUUID(),0,STEP),{code:'AGENT_TASK_NOT_FOUND'});
 assert.throws(()=>f.runtime.setConversationPolicy(f.projectId,conversationId,{requestId:randomUUID(),expectedRevision:2,modes:{...STEP,read_only:'sometimes'}}),{code:'AGENT_TASK_INVALID'});
 assert.throws(()=>f.store.db.prepare('UPDATE agent_task_conversation_policies_v2 SET revision=1,data=json_set(data,\'$.revision\',1) WHERE conversationId=?').run(conversationId),/revisions only advance/u);
 assert.throws(()=>f.store.db.prepare('DELETE FROM agent_task_conversation_policies_v2').run(),/must be retained/u);
 assert.throws(()=>f.store.db.prepare("UPDATE agent_task_conversation_policy_requests_v2 SET inputHash=inputHash").run(),/immutable/u);
 assert.throws(()=>f.store.db.prepare('DELETE FROM agent_task_conversation_policy_requests_v2').run(),/must be retained/u);
});

test('moving paid work to direct needs acknowledgement, also when clearing to a direct global policy',async t=>{
 const f=await fixture(t),first=await f.send('First round'),conversationId=first.run.conversationId!;
 assert.throws(()=>f.setPolicy(conversationId,0,FULL),{code:'AGENT_TASK_APPROVAL_REQUIRED'});
 assert.equal(f.setPolicy(conversationId,0,FULL,{acknowledgePaid:true}).revision,1);
 assert.equal(f.setPolicy(conversationId,1,DEFAULT).revision,2,'tightening never needs acknowledgement');
 const global=f.runtime.policy();f.runtime.journal.updatePolicy({...global,modes:{...global.modes,paid:'direct'}});
 assert.throws(()=>f.setPolicy(conversationId,2,null),{code:'AGENT_TASK_APPROVAL_REQUIRED'});
 const cleared=f.setPolicy(conversationId,2,null,{acknowledgePaid:true});assert.equal(cleared.effective.paid,'direct');
});

test('each step follows its own conversation, and loosening never approves a confirmation already shown',async t=>{
 const f=await fixture(t);
 f.queue([load()],[rename(f.shotId,1,'Direct title')]);
 const direct=await f.send('Rename directly');
 assert.equal(direct.run.status,'completed');assert.equal(f.title(),'Direct title');
 f.queue([load()],[rename(f.shotId,2,'Confirmed title')]);
 const careful=await f.send('Rename carefully',{policy:{modes:STEP}}),conversationId=careful.run.conversationId!;
 assert.notEqual(conversationId,direct.run.conversationId);
 assert.equal(careful.run.status,'awaiting_approval');assert.equal(f.title(),'Direct title');
 assert.deepEqual(f.runtime.conversationPolicy(f.projectId,conversationId).override,STEP);
 assert.deepEqual(f.runtime.conversationPolicy(f.projectId,direct.run.conversationId!).effective,f.runtime.policy().modes);
 const pending=careful.steps.find(item=>item.status==='awaiting_approval')!;
 f.setPolicy(conversationId,1,FULL,{acknowledgePaid:true});
 const {settled:still}=await f.action(careful.run.id,'resume');
 assert.equal(still.run.status,'awaiting_approval');assert.equal(still.steps.find(item=>item.id===pending.id)?.status,'awaiting_approval');assert.equal(f.title(),'Direct title');
 const {settled:done}=await f.action(careful.run.id,'approve',{stepId:pending.id});
 assert.equal(done.run.status,'completed');assert.equal(f.title(),'Confirmed title');
 // Later rounds of the loosened conversation run directly.
 f.queue([load()],[rename(f.shotId,3,'Loose title')]);
 const loose=await f.send('Rename again',{conversationId});assert.equal(loose.run.status,'completed');assert.equal(f.title(),'Loose title');
});

test('a new conversation saves its modes with the first run and replays bind them exactly',async t=>{
 const f=await fixture(t),expectedSettingsRevision=await f.settingsRevision();
 const base={requestId:randomUUID(),text:'Start carefully',expectedSettingsRevision};
 const sent=await f.submit({...base,policy:{modes:STEP}});
 const saved=f.runtime.conversationPolicy(f.projectId,sent.run.conversationId!);assert.equal(saved.revision,1);assert.deepEqual(saved.override,STEP);
 assert.equal((await f.submit({...base,policy:{modes:STEP}})).run.id,sent.run.id);
 await assert.rejects(f.runtime.send(f.projectId,{...base,policy:{modes:DEFAULT}}),{code:'AGENT_TASK_REQUEST_CONFLICT'});
 await assert.rejects(f.runtime.send(f.projectId,base),{code:'AGENT_TASK_REQUEST_CONFLICT'});
 // A later change of the conversation's modes does not change what the first send carried.
 f.setPolicy(sent.run.conversationId!,1,DEFAULT);
 assert.equal((await f.submit({...base,policy:{modes:STEP}})).run.id,sent.run.id);
 await assert.rejects(f.runtime.send(f.projectId,{...base,policy:{modes:DEFAULT}}),{code:'AGENT_TASK_REQUEST_CONFLICT'});
 const plain={requestId:randomUUID(),text:'Start plainly',expectedSettingsRevision};
 const unpoliced=await f.submit(plain);
 await assert.rejects(f.runtime.send(f.projectId,{...plain,policy:{modes:STEP}}),{code:'AGENT_TASK_REQUEST_CONFLICT'});
 assert.equal(f.runtime.conversationPolicy(f.projectId,unpoliced.run.conversationId!).revision,0);
 // Only a new conversation chooses modes when sending; later changes use its policy.
 await assert.rejects(f.runtime.send(f.projectId,{requestId:randomUUID(),text:'Continue',expectedSettingsRevision,conversationId:sent.run.conversationId,policy:{modes:FULL,acknowledgePaid:true}}),{code:'AGENT_TASK_INVALID'});
 await assert.rejects(f.runtime.send(f.projectId,{requestId:randomUUID(),text:'Start loosely',expectedSettingsRevision,policy:{modes:FULL}}),{code:'AGENT_TASK_APPROVAL_REQUIRED'});
 await assert.rejects(f.runtime.send(f.projectId,{requestId:randomUUID(),text:'Start oddly',expectedSettingsRevision,policy:{modes:STEP,extra:true}}),{code:'AGENT_TASK_INVALID'});
 await assert.rejects(f.runtime.send(f.projectId,{requestId:randomUUID(),text:'Start oddly',expectedSettingsRevision,policy:{modes:STEP,acknowledgePaid:false}}),{code:'AGENT_TASK_INVALID'});
 const loose=await f.submit({requestId:randomUUID(),text:'Start loosely',expectedSettingsRevision,policy:{modes:FULL,acknowledgePaid:true}});
 assert.deepEqual(f.runtime.conversationPolicy(f.projectId,loose.run.conversationId!).effective,FULL);
 assert.equal(f.runtime.journal.list(f.projectId).length,3,'refused sends create no run');
});

test('the default policy confirms irreversible work, saved policies keep their modes, and presets name the composer choices',async t=>{
 assert.deepEqual(DEFAULT_AGENT_TASK_POLICY.modes,{read_only:'direct',local_reversible:'direct',local_irreversible:'confirm',paid:'confirm'});
 assert.equal(agentTaskPolicyPreset(DEFAULT_AGENT_TASK_POLICY.modes),'default');
 assert.equal(agentTaskPolicyPreset(STEP),'step');assert.equal(agentTaskPolicyPreset(FULL),'full');
 assert.equal(agentTaskPolicyPreset({...FULL,paid:'confirm'}),'custom');assert.equal(agentTaskPolicyPreset({...STEP,read_only:'confirm'}),'custom');
 const f=await fixture(t);assert.equal(f.runtime.policy().modes.local_irreversible,'confirm');
 const global=f.runtime.policy();f.runtime.journal.updatePolicy({...global,modes:{...global.modes,local_irreversible:'direct'}});
 f.restart();assert.equal(f.runtime.policy().modes.local_irreversible,'direct');
});

test('a waiting question keeps its project from deletion; a finished conversation policy is deleted with its project',async t=>{
 const f=await fixture(t);f.queue([ask(opening)]);
 const waiting=await f.send('Plan the opening',{policy:{modes:STEP}}),step=question(waiting);
 f.services.setProjectDeletionCompanions({assertDeletable(){},removeProject(){}});
 const remove=()=>f.services.call('project.delete',{requestId:randomUUID(),projectId:f.projectId,expectedRevision:Number(record(f.store.get('projects',f.projectId)).revision),confirmPermanentDeletion:true});
 await assert.rejects(remove());
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM agent_task_conversation_policies_v2').get()!.n,1);
 await f.action(waiting.run.id,'answer',{stepId:step.id,choices:[0]});
 assert.equal(f.get(waiting.run.id).run.status,'completed');
 assert.equal((record(await remove())).deleted,true);
 for(const table of ['agent_task_conversation_policies_v2','agent_task_conversation_policy_requests_v2','agent_task_runs_v2','project_deletion_scope'])assert.equal(f.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,0,table);
 assert.deepEqual(foreignKeyCheck(f.store.db),[]);
});
test('schema64 upgrades to schema66 intact, and the schema64 profile refuses runs waiting for an answer',async()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-policy-answer-v64-'));
 try{
  let store=openStore(root);const services=createServices(store,new Map()),journal=createAgentTaskJournal(store);
  const projectId=String(record(await services.call('project.create',{name:'Historical'})).id);
  const created=journal.create({requestId:randomUUID(),projectId,text:'Historical round',configuration:{}});
  await services.drain();store.close();
  let db=new DatabaseSync(join(root,'workbench.sqlite'));
  try{downgradeReviewedWorkspace(db,64);assert.equal(db.prepare('SELECT 1 FROM schema_version WHERE version=66').get(),undefined);}finally{db.close();}
  db=new DatabaseSync(join(root,'workbench.sqlite'));const before=db.prepare('SELECT id,digest,status,data FROM agent_task_runs_v2 ORDER BY id').all();db.close();
  store=openStore(root);
  try{assertCurrentOrdinaryWorkspace(store.db);assert.deepEqual(store.db.prepare('SELECT id,digest,status,data FROM agent_task_runs_v2 ORDER BY id').all(),before);assert.equal(store.db.prepare('SELECT count(*) AS n FROM agent_task_conversation_policies_v2').get()!.n,0);}finally{store.close();}
  db=new DatabaseSync(join(root,'workbench.sqlite'));
  try{downgradeReviewedWorkspace(db,64);db.prepare("UPDATE agent_task_runs_v2 SET status='awaiting_answer',data=json_set(data,'$.status','awaiting_answer') WHERE id=?").run(created.run.id);}finally{db.close();}
  assert.throws(()=>openStore(root),/RESTORE_SCHEMA_UNSUPPORTED|unsupported|Invalid/iu);
  db=new DatabaseSync(join(root,'workbench.sqlite'));
  try{assert.equal(db.prepare('SELECT 1 FROM schema_version WHERE version=66').get(),undefined,'a refused upgrade leaves the historical workspace untouched');}finally{db.close();}
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('a current backup restores conversation policies and waiting questions as read-only evidence',async t=>{
 const f=await fixture(t);f.queue([ask(opening)]);
 const waiting=await f.send('Plan the opening',{policy:{modes:STEP}}),conversationId=waiting.run.conversationId!;
 f.setPolicy(conversationId,1,DEFAULT);
 await f.shutdown();
 const backup=f.root+'-backup',restored=f.root+'-restored';
 t.after(()=>{rmSync(backup,{recursive:true,force:true});rmSync(restored,{recursive:true,force:true});});
 await createWorkspaceBackup({source:f.root,destination:backup});
 const result=await restoreWorkspaceBackup({directory:backup,destination:restored});assert.equal(result.databaseSchemaVersion,CURRENT_RESTORED_SCHEMA);
 const store=openStore(restored);
 try{
  assert.deepEqual(classifyCurrentWorkspaceSchema(store.db),{schemaVersion:CURRENT_RESTORED_SCHEMA,profile:CURRENT_RESTORE_PROFILE});
  const journal=createAgentTaskJournal(store),policy=journal.conversationPolicy(f.projectId,conversationId);
  assert.equal(policy.revision,2);assert.deepEqual(policy.override,DEFAULT);
  const snapshot=journal.snapshot(waiting.run.id);assert.equal(snapshot.run.status,'awaiting_answer');assert.equal(question(snapshot).status,'awaiting_answer');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM agent_task_conversation_policy_requests_v2').get()!.n,2);
  assert.throws(()=>journal.setConversationPolicy(f.projectId,conversationId,{requestId:randomUUID(),expectedRevision:2,modes:FULL,acknowledgePaid:true}));
  assert.equal(journal.conversationPolicy(f.projectId,conversationId).revision,2);
 }finally{store.close();}
});
