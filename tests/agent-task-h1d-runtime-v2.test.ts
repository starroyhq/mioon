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
import type {PreparedAgentTaskTool} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../packages/business/src/agent/task-runtime-v2.ts';
import {buildTaskModelRequest,TASK_MODEL_LIMITS,taskResponseLanguageContext} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskGateway,TaskModelItem,TaskModelOutput} from '../packages/business/src/agent/task-gateway-v2.ts';
import {TASK_PROJECT_OVERVIEW_KIND,TASK_STALE_TARGETS_KIND} from '../packages/business/src/agent/task-context-observations-v2.ts';
import {TASK_RUN_RECORD_KIND} from '../packages/business/src/agent/task-run-record-v2.ts';
import type {AgentProtocol} from '../packages/contracts/src/agent-protocol.ts';
import type {AgentTaskJson,AgentTaskSnapshot,AgentTaskToolCall,AgentTaskControlAction} from '../packages/contracts/src/agent-tasks-v2.ts';
import {createTestAuthorizations,authorizeTestScope} from './helpers/agent-authorizations.ts';

const protocols=['chat_completions','responses','anthropic_messages'] as const satisfies readonly AgentProtocol[];
function object(value:unknown):Record<string,unknown>{assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;}
const call=(name:string,args:AgentTaskToolCall['arguments']={}):AgentTaskToolCall=>({id:`synthetic_${randomUUID()}`,name,arguments:args});
function output(protocol:AgentProtocol,calls:AgentTaskToolCall[]=[],text='Offline completion'):TaskModelOutput{
  let providerOutput:AgentTaskJson;
  if(protocol==='chat_completions')providerOutput={role:'assistant',content:text,...(calls.length?{tool_calls:calls.map(item=>({id:item.id,type:'function',function:{name:item.name,arguments:JSON.stringify(item.arguments)}}))}:{})};
  else if(protocol==='responses')providerOutput=[{type:'message',role:'assistant',content:[{type:'output_text',text,annotations:[]}]},...calls.map(item=>({type:'function_call',call_id:item.id,name:item.name,arguments:JSON.stringify(item.arguments),status:'completed'}))];
  else providerOutput={role:'assistant',content:[{type:'text',text},...calls.map(item=>({type:'tool_use',id:item.id,name:item.name,input:item.arguments}))]};
  return {text,toolCalls:calls,providerOutput};
}
type Script=(index:number)=>AsyncGenerator<TaskModelItem,void,undefined>;
function host(history:unknown,kind:string):Record<string,unknown>[]{
  assert.ok(Array.isArray(history));
  return history.flatMap(value=>{
    const message=object(value);if(message.role!=='user'||typeof message.content!=='string')return [];
    const start=message.content.indexOf('\n');if(start<0)return [];
    let data:unknown;try{data=JSON.parse(message.content.slice(start+1));}catch{return [];}
    return object(data).kind===kind?[object(data)]:[];
  });
}
function models(snapshot:AgentTaskSnapshot){return snapshot.steps.filter(step=>step.kind==='model');}
function history(step:ReturnType<typeof models>[number]):unknown{return object(step.request).history;}
function markerCount(body:string,kind:string):number{return body.split(kind).length-1;}

/** Real services, grants, tools and durable journal; the gateway alone is
 * replaced, so these tests never submit a provider request. */
async function fixture(t:TestContext,protocol:AgentProtocol){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-h1d-runtime-')),store=openStore(root),services=createServices(store,new Map());
  const project=object(await services.call('project.create',{name:'Frozen overview'})),projectId=String(project.id);
  const first=object(await services.call('shot.create',{projectId,title:'Original shot',prompt:'Original prompt'})),shotId=String(first.id);
  const settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}});
  await settings.put({expectedRevision:0,configuration:{presetId:'custom',platformId:'custom',protocol,model:'synthetic-h1d-model',baseUrl:'https://harness.example.com'},secret:{action:'replace',storage:'session',value:'SYNTHETIC_LOCAL_TEST_ONLY'}});
  const authorizations=createTestAuthorizations(()=>({...store}),settings);await authorizeTestScope(authorizations,'project_agent');
  const baseTools=createAgentTaskTools({store,services}),requests:string[]=[];
  let script:Script=async function*(){yield {type:'done',output:output(protocol)};},index=0,afterRead:((prepared:PreparedAgentTaskTool)=>Promise<void>)|undefined;
  const tools={...baseTools,async execute(prepared:Parameters<typeof baseTools.execute>[0],context:Parameters<typeof baseTools.execute>[1]){
    const result=await baseTools.execute(prepared,context);
    // This deterministic gate runs after the actual business read but before
    // the runtime receives and persists its completed observation.
    await afterRead?.(prepared);return result;
  }};
  const gateway:TaskGateway=async function*(request){
    request.beforeSubmit?.();requests.push(request.body);yield*script(++index);
  };
  let runtime=createAgentTaskRuntime({store,agentSettings:settings,authorizations,tools,gateway,selfPort:()=>4318});
  t.after(async()=>{runtime.close();baseTools.dispose();await settings.close();store.close();rmSync(root,{recursive:true,force:true});});
  return {store,services,settings,tools,requests,projectId,shotId,get runtime(){return runtime;},
    setScript(next:Script){script=next;index=0;},afterRead(next?:typeof afterRead){afterRead=next;},
    async send(text='H1d offline test',extra:Record<string,unknown>={}){return runtime.send(projectId,{requestId:randomUUID(),text,expectedSettingsRevision:(await settings.get()).revision,locale:'en',...extra});},
    async settle(runId:string){await runtime.drain();return runtime.journal.snapshot(runId);},
    action(snapshot:AgentTaskSnapshot,action:AgentTaskControlAction,extra:Record<string,unknown>={}){return runtime.action(projectId,snapshot.run.id,{requestId:randomUUID(),expectedRevision:snapshot.run.revision,action,...extra});},
    restart(){runtime.close();runtime=createAgentTaskRuntime({store,agentSettings:settings,authorizations,tools,gateway,selfPort:()=>4318});},
  };
}

for(const protocol of protocols)test(`${protocol}: external revisions add one stale boundary and the send-time overview stays frozen`,async t=>{
  const f=await fixture(t,protocol);let changed=false,externalFailure:unknown;
  f.afterRead(async prepared=>{
    if(changed||prepared.operation!=='version.list')return;changed=true;
    try{
    assert.deepEqual(prepared.referencedTargets,[{kind:'shot',id:f.shotId,revision:1}]);
    await f.services.call('shot.update',{shotId:f.shotId,expectedRevision:1,patch:{prompt:'External edit'}});
    await f.services.call('project.rename',{projectId:f.projectId,requestId:randomUUID(),expectedRevision:Number(object(f.store.get('projects',f.projectId)).revision),name:'Renamed after send'});
    await f.services.call('shot.create',{projectId:f.projectId,title:'Added after send',prompt:'Later shot'});
    }catch(error){externalFailure=error;throw error;}
  });
  f.setScript(async function*(index){yield {type:'done',output:output(protocol,index===1?[call('mioon_version_list',{shotId:f.shotId})]:index===2?[call('mioon_project_inspect')]:[])};});
  const sent=await f.send(),done=await f.settle(sent.run.id),steps=models(done);
  if(externalFailure)throw externalFailure;
  assert.equal(done.run.status,'completed');assert.equal(changed,true);assert.equal(steps.length,3);
  const frozen=steps.map(step=>structuredClone(step.request));
  assert.deepEqual(f.requests.map(body=>markerCount(body,TASK_STALE_TARGETS_KIND)),[0,1,1]);
  const stale=host(history(steps[1]!),TASK_STALE_TARGETS_KIND);assert.equal(stale.length,1);
  assert.deepEqual(object(stale[0]!.data).targets,[{kind:'shot',id:f.shotId,previousRevision:1,revision:2}]);
  assert.deepEqual(host(history(steps[2]!),TASK_STALE_TARGETS_KIND),stale,'The next unchanged baseline retains the old notice without appending a duplicate');
  const initial=host(history(steps[0]!),TASK_PROJECT_OVERVIEW_KIND);assert.equal(initial.length,1);
  assert.equal(object(initial[0]!.data).name,'Frozen overview');assert.equal(object(object(initial[0]!.data).counts).shots,1);
  for(const step of steps)assert.deepEqual(host(history(step),TASK_PROJECT_OVERVIEW_KIND),initial);
  for(const body of f.requests)assert.equal(markerCount(body,TASK_PROJECT_OVERVIEW_KIND),1);
  // Subsequent DB changes and restart cannot alter any retained request.
  await f.services.call('shot.update',{shotId:f.shotId,expectedRevision:2,patch:{prompt:'External edit after completion'}});
  f.restart();assert.deepEqual(models(f.runtime.journal.snapshot(sent.run.id)).map(step=>step.request),frozen);
  assert.deepEqual(f.requests,frozen.map(request=>String(object(request).body)));
  f.afterRead();f.setScript(async function*(){yield {type:'done',output:output(protocol)};});
  const next=await f.send('Fresh send',{conversationId:done.run.conversationId}),nextDone=await f.settle(next.run.id);
  const refreshed=host(history(models(nextDone)[0]!),TASK_PROJECT_OVERVIEW_KIND);
  assert.equal(object(refreshed[0]!.data).name,'Renamed after send');assert.equal(object(object(refreshed[0]!.data).counts).shots,2);
});

for(const protocol of protocols)test(`${protocol}: own writes stay fresh and subsequent runs retain completed, reverted, failed and stopped records`,async t=>{
  const f=await fixture(t,protocol);
  f.setScript(async function*(){yield {type:'done',output:output(protocol,[],'Completed final answer')};});
  const completed=await f.send('Completed request'),complete=await f.settle(completed.run.id),conversationId=complete.run.conversationId;
  f.setScript(async function*(index){yield {type:'done',output:output(protocol,index===1?[call('mioon_tools_load',{groups:['canvas']})]:index===2?[call('mioon_shot_update',{shotId:f.shotId,expectedRevision:1,patch:{prompt:'Own edit'}})]:[],'Reverted answer must not become an assistant answer')};});
  const edited=await f.send('Reverted request',{conversationId}),own=await f.settle(edited.run.id);
  assert.equal(own.run.status,'completed');assert.equal(own.changes.length,1);assert.equal(object(f.store.get('shots',f.shotId)).prompt,'Own edit');
  assert.ok(models(own).every(step=>host(history(step),TASK_STALE_TARGETS_KIND).length===0));
  const reverted=await f.action(own,'undo_all');assert.equal(reverted.run.status,'reverted');assert.equal(object(f.store.get('shots',f.shotId)).prompt,'Original prompt');
  f.setScript(async function*(){throw Object.assign(Error('Synthetic failure'),{code:'AGENT_CHAT_LIMIT'});});
  const failed=await f.send('Failed request',{conversationId}),failure=await f.settle(failed.run.id);assert.equal(failure.run.status,'failed');
  let stoppedId:string|undefined;
  f.setScript(async function*(){const active=f.runtime.journal.list(f.projectId).find(run=>run.status==='running');assert.ok(active);stoppedId=active.id;await f.action(f.runtime.get(f.projectId,active.id),'stop');yield {type:'done',output:output(protocol,[],'Stopped answer must not become an assistant answer')};});
  const stopped=await f.send('Stopped request',{conversationId}),stop=await f.settle(stopped.run.id);assert.equal(stop.run.status,'stopped');assert.equal(stoppedId,stopped.run.id);
  f.setScript(async function*(){yield {type:'done',output:output(protocol)};});
  const next=await f.send('Inspect saved history',{conversationId}),done=await f.settle(next.run.id),first=models(done)[0]!,records=host(history(first),TASK_RUN_RECORD_KIND);
  assert.equal(done.run.status,'completed');assert.equal(records.length,4);
  const messages=history(first),previousTexts=['Completed request','Reverted request','Failed request','Stopped request'];assert.ok(Array.isArray(messages));
  assert.deepEqual(messages.filter(value=>object(value).role==='user'&&previousTexts.includes(String(object(value).content))).map(value=>object(value).content),previousTexts);
  assert.deepEqual(records.map(row=>object(row.data).status),['completed','reverted','failed','stopped']);
  assert.equal(object(records[2]!.data).failureCode,'AGENT_CHAT_LIMIT');
  const raw=JSON.stringify(history(first));assert.ok(raw.includes('Completed final answer'));assert.ok(!raw.includes('Reverted answer must not become an assistant answer'));assert.ok(!raw.includes('Stopped answer must not become an assistant answer'));assert.ok(!raw.includes('Synthetic failure'));
});

for(const protocol of protocols)test(`${protocol}: diagnostics omit H1d observations and a saved intent resumes its original request`,async t=>{
  const f=await fixture(t,protocol);let changed=false;
  f.afterRead(async prepared=>{if(!changed&&prepared.operation==='version.list'){changed=true;await f.services.call('shot.update',{shotId:f.shotId,expectedRevision:1,patch:{prompt:'External diagnostic edit'}});}});
  f.setScript(async function*(index){yield {type:'done',output:output(protocol,index===1?[call('mioon_version_list',{shotId:f.shotId})]:[])};});
  const sent=await f.send('Diagnostic',{diagnostic:{profile:'read_only'}}),done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(changed,true);
  for(const body of f.requests){assert.equal(markerCount(body,TASK_PROJECT_OVERVIEW_KIND),0);assert.equal(markerCount(body,TASK_STALE_TARGETS_KIND),0);assert.equal(markerCount(body,TASK_RUN_RECORD_KIND),0);}
  const settings=await f.settings.get(),originalHistory=[{role:'user',content:'Original intent before H1d'}],original=buildTaskModelRequest(settings.configuration,originalHistory,[],4318),context=[taskResponseLanguageContext('en'),{role:'user',content:'x'.repeat(TASK_MODEL_LIMITS.historyBytes+1)}];
  const retained=f.runtime.journal.create({projectId:f.projectId,requestId:randomUUID(),text:'Original intent before H1d',configuration:{...settings.configuration},settingsRevision:settings.revision,context});
  const model=f.runtime.journal.beginStep(retained.run.id,{kind:'model',request:{body:original,history:originalHistory},data:{baseline:[]}}),saved=structuredClone(model.request),requestsBefore=f.requests.length;
  f.afterRead();f.setScript(async function*(){yield {type:'done',output:output(protocol)};});f.restart();
  const interrupted=f.runtime.get(f.projectId,retained.run.id);assert.equal(interrupted.run.status,'interrupted');await f.action(interrupted,'resume');const resumed=await f.settle(retained.run.id);
  assert.equal(resumed.run.status,'completed');assert.equal(f.requests.length,requestsBefore+1);assert.equal(f.requests.at(-1),original);assert.deepEqual(f.runtime.journal.step(model.id).request,saved);assert.deepEqual(f.runtime.journal.run(retained.run.id).context,context);
  assert.equal(markerCount(f.requests.at(-1)!,TASK_PROJECT_OVERVIEW_KIND),0);assert.equal(markerCount(f.requests.at(-1)!,TASK_STALE_TARGETS_KIND),0);
});

for(const protocol of protocols)test(`${protocol}: an actual answered question retains its saved words after compression and external revision notices`,async t=>{
  const f=await fixture(t,protocol),question='Which opening should Mio use? "Keep the choice" \\ exactly',options=[{label:'Wide street'},{label:'Close-up'},{label:'Rooftop'}];
  const planned=call('mioon_ask',{question,options,multiple:true,allowOther:true}),rawAnswer='  Open on the harbour 🌄, "as discussed"\nthen use the street \\ entrance  ',savedText=rawAnswer.trim();
  let advanced=false,externalFailure:unknown;
  f.afterRead(async prepared=>{
    if(advanced||prepared.operation!=='version.list')return;advanced=true;
    try{assert.deepEqual(prepared.referencedTargets,[{kind:'shot',id:f.shotId,revision:1}]);await f.services.call('shot.update',{shotId:f.shotId,expectedRevision:1,patch:{prompt:'External update before the question'}});}
    catch(error){externalFailure=error;throw error;}
  });
  f.setScript(async function*(index){
    const calls=index===1?[call('mioon_version_list',{shotId:f.shotId})]:index===2?[planned]:index<=8?[call('mioon_project_inspect')]:[];
    yield {type:'done',output:output(protocol,calls,index<=8?`ANSWER_COMBO_REPLY_${index}_`+'r'.repeat(30*1024):'The answer and saved project have been checked.')};
  });
  const sent=await f.send('ANSWER_COMBO_CURRENT_'+'u'.repeat(31000)),waiting=await f.settle(sent.run.id);
  if(externalFailure)throw externalFailure;
  assert.equal(waiting.run.status,'awaiting_answer');assert.equal(f.requests.length,2);assert.equal(advanced,true);
  const ask=waiting.steps.find(step=>step.toolCall?.id===planned.id);assert.ok(ask);assert.equal(ask.status,'awaiting_answer');assert.equal(ask.result,undefined);
  const initialRequests=models(waiting).map(step=>({id:step.id,request:structuredClone(step.request)})),initialOverview=host(history(models(waiting)[0]!),TASK_PROJECT_OVERVIEW_KIND);
  assert.deepEqual(object(host(history(models(waiting)[1]!),TASK_STALE_TARGETS_KIND)[0]!.data).targets,[{kind:'shot',id:f.shotId,previousRevision:1,revision:2}]);
  // The project can advance while the run awaits input. No model request is
  // dispatched until the real C13a answer control durably completes its step.
  await f.services.call('shot.update',{shotId:f.shotId,expectedRevision:2,patch:{prompt:'External update while waiting for the answer'}});
  assert.equal(f.requests.length,2);const control=await f.action(waiting,'answer',{stepId:ask.id,choices:[2,0],text:rawAnswer}),done=await f.settle(sent.run.id);
  assert.equal(control.steps.find(step=>step.id===ask.id)?.status,'completed');assert.equal(done.run.status,'completed');assert.equal(f.requests.length,9);
  const savedAnswer={answer:{choices:[0,2],text:savedText},selected:[options[0]!.label,options[2]!.label],text:savedText};
  assert.deepEqual(f.runtime.journal.step(ask.id).result,savedAnswer);assert.equal(object(f.store.get('shots',f.shotId)).prompt,'External update while waiting for the answer');
  const steps=models(done),afterAnswer=history(steps[2]!);assert.ok(Array.isArray(afterAnswer));
  const updates=host(afterAnswer,TASK_STALE_TARGETS_KIND);assert.equal(updates.length,2);
  assert.deepEqual(updates.map(row=>object(row.data).targets),[[{kind:'shot',id:f.shotId,previousRevision:1,revision:2}],[{kind:'shot',id:f.shotId,previousRevision:2,revision:3}]]);
  assert.deepEqual(host([afterAnswer.at(-1)!],TASK_STALE_TARGETS_KIND),[updates[1]!]);
  const finalHistory=history(steps.at(-1)!);assert.ok(Array.isArray(finalHistory));assert.ok(Buffer.byteLength(JSON.stringify(finalHistory))<=TASK_MODEL_LIMITS.historyBytes);
  const constraints=host(finalHistory,'mio.context.constraints');assert.equal(constraints.length,1);
  assert.deepEqual(object(constraints[0]!.data).answers,[{stepId:ask.id,question,selected:savedAnswer.selected,text:savedText}]);
  assert.equal(host(finalHistory,'mio.context.journal').length,1);assert.equal(host(finalHistory,TASK_STALE_TARGETS_KIND).length,0,'Old notices leave with their removed model rounds, without a new notice for the unchanged revision');
  for(const step of steps)assert.deepEqual(host(history(step),TASK_PROJECT_OVERVIEW_KIND),initialOverview);
  for(const saved of initialRequests)assert.deepEqual(f.runtime.journal.step(saved.id).request,saved.request);
  assert.deepEqual(f.requests,steps.map(step=>String(object(step.request).body)));
  for(const source of f.requests){
    const body=object(JSON.parse(source)),rows=body[protocol==='responses'?'input':'messages'];assert.ok(Array.isArray(rows));const calls:string[]=[],results:string[]=[];
    for(const entry of rows){const row=object(entry);
      if(protocol==='chat_completions'){
        if(Array.isArray(row.tool_calls))for(const item of row.tool_calls)calls.push(String(object(item).id));
        if(row.role==='tool')results.push(String(row.tool_call_id));
      }else if(protocol==='responses'){
        if(row.type==='function_call')calls.push(String(row.call_id));if(row.type==='function_call_output')results.push(String(row.call_id));
      }else if(Array.isArray(row.content))for(const item of row.content){const block=object(item);if(block.type==='tool_use')calls.push(String(block.id));if(block.type==='tool_result')results.push(String(block.tool_use_id));}
    }
    assert.deepEqual(calls,results);
    if(source===f.requests.at(-1))assert.ok(!calls.includes(planned.id),'The question answer remains exact even after its original tool exchange was removed');
  }
});
