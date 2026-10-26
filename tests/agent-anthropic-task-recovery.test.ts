import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type {ServerResponse, IncomingHttpHeaders, OutgoingHttpHeaders} from 'node:http';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import type {Provider} from '../packages/business/src/provider-registry.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../packages/business/src/agent/task-runtime-v2.ts';
import {createTaskGateway, buildTaskModelRequest, taskContinuation, taskToolExplanation, taskResponseLanguageContext} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskModelOutput} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {AgentTransportDependencies} from '../packages/business/src/agent/network-policy.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import type {AgentTaskToolCall, AgentTaskControlAction, AgentTaskSnapshot} from '../packages/contracts/src/agent-tasks-v2.ts';
import {createTestAuthorizations, authorizeTestScope} from './helpers/agent-authorizations.ts';

const configuration:AgentConfiguration={presetId:'custom',platformId:'custom',protocol:'anthropic_messages',model:'synthetic-native-model',baseUrl:'https://anthropic.example.com/compat'};
const key='SYNTHETIC_ANTHROPIC_TASK_KEY';
function object(value:unknown):Record<string,unknown>{assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;}
const call=(name:string,args:AgentTaskToolCall['arguments']={},id=`toolu_${randomUUID()}`):AgentTaskToolCall=>({id,name,arguments:args});
const event=(value:Record<string,unknown>)=>`event: ${String(value.type)}\ndata: ${JSON.stringify(value)}\n\n`;
function startMessage(model=configuration.model){return event({type:'message_start',message:{id:'msg_local_task',type:'message',role:'assistant',content:[],model,stop_reason:null,stop_sequence:null,usage:{input_tokens:9,output_tokens:0}}});}
function frames(calls:AgentTaskToolCall[]=[],text='',{stopReason=calls.length?'tool_use':'end_turn',terminal=true,rawArguments,model}:{stopReason?:string;terminal?:boolean;rawArguments?:string;model?:string}={}):string{
  const values:Record<string,unknown>[]=[];let index=0;
  if(text){values.push({type:'content_block_start',index,content_block:{type:'text',text:''}},{type:'content_block_delta',index,delta:{type:'text_delta',text}},{type:'content_block_stop',index});index++;}
  for(const selected of calls){const args=rawArguments??JSON.stringify(selected.arguments);values.push(
    {type:'content_block_start',index,content_block:{type:'tool_use',id:selected.id,name:selected.name,input:{}}},
    {type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:args.slice(0,7)}},
    {type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:args.slice(7)}},
    {type:'content_block_stop',index},
  );index++;}
  values.push({type:'message_delta',delta:{stop_reason:stopReason,stop_sequence:null},usage:{output_tokens:21}});
  if(terminal)values.push({type:'message_stop'});
  return startMessage(model)+values.map(event).join('');
}
interface RecordedRequest {body:Record<string,unknown>;raw:string;headers:IncomingHttpHeaders;path:string|undefined}
type Script=(request:RecordedRequest,response:ServerResponse,index:number)=>void;

/** The real SDK and actual loopback HTTP carry every byte. Only DNS/TLS socket
 * identity is injected at the existing trusted transport seam; no product
 * address, authorization, approval or retry policy is bypassed. */
async function fixture(t:TestContext,{authorize=true,providers=new Map<string,Provider>(),selectedConfiguration=configuration}:{authorize?:boolean;providers?:ReadonlyMap<string,Provider>;selectedConfiguration?:AgentConfiguration}={}){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-anthropic-tasks-')),store=openStore(root),services=createServices(store,providers);
  const project=object(await services.call('project.create',{name:'Anthropic offline fixture'})),projectId=String(project.id);
  const shot=object(await services.call('shot.create',{projectId,title:'Saved shot',prompt:'original prompt'}));
  const settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}});
  await settings.put({expectedRevision:0,configuration:selectedConfiguration,secret:{action:'replace',storage:'session',value:key}});
  const authorizations=createTestAuthorizations(()=>({...store}),settings);if(authorize)await authorizeTestScope(authorizations,'project_agent');
  const requests:RecordedRequest[]=[],effects:string[]=[];
  let script:Script=(_request,response)=>response.end(frames([],'离线任务完成',{model:selectedConfiguration.model}));
  const server=http.createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk as Uint8Array));
    const raw=Buffer.concat(chunks).toString('utf8'),request={raw,body:object(JSON.parse(raw)),headers:req.headers,path:req.url};
    requests.push(request);res.writeHead(200,{'content-type':'text/event-stream'});script(request,res,requests.length);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
  const request=(options:unknown,respond:(response:http.IncomingMessage)=>void)=>{
    const selected=object(options),proxy=new EventEmitter();
    const outgoing=http.request({hostname:'127.0.0.1',port:address.port,path:String(selected.path),method:'POST',headers:selected.headers as OutgoingHttpHeaders},respond);
    outgoing.on('error',error=>proxy.emit('error',error));
    Object.assign(proxy,{setTimeout:(milliseconds:number,callback:()=>void)=>{outgoing.setTimeout(milliseconds,callback);return proxy;},end:(body:string)=>{outgoing.end(body);return proxy;},destroy:()=>{outgoing.destroy();return proxy;}});
    queueMicrotask(()=>{const socket=Object.assign(new EventEmitter(),{remoteAddress:'8.8.8.8',remotePort:443,authorized:true,destroy:()=>outgoing.destroy()});proxy.emit('socket',socket);socket.emit('secureConnect');});
    return proxy;
  };
  const gateway=createTaskGateway({lookup:async()=>[{address:'8.8.8.8',family:4}],httpsRequest:request} as unknown as AgentTransportDependencies);
  const baseTools=createAgentTaskTools({store,services}),tools={...baseTools,execute:async(...args:Parameters<typeof baseTools.execute>)=>{
    effects.push(args[0].operation);return baseTools.execute(...args);
  }};
  let runtime=createAgentTaskRuntime({store,agentSettings:settings,authorizations,tools,gateway,selfPort:()=>4318});
  t.after(async()=>{runtime.close();await runtime.drain();baseTools.dispose();await services.drain();await settings.close();store.close();await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});rmSync(root,{recursive:true,force:true});});
  return {store,services,settings,authorizations,projectId,shot,requests,effects,get runtime(){return runtime;},
    script(next:Script){script=next;},
    plan(calls:AgentTaskToolCall[]){script=(_request,response,index)=>response.end(index===1?frames(calls,'准备处理',{model:selectedConfiguration.model}):frames([],'离线任务完成',{model:selectedConfiguration.model}));},
    async send(requestId:string=randomUUID()){return runtime.send(projectId,{requestId,text:'仅执行离线测试',expectedSettingsRevision:(await settings.get()).revision});},
    async settle(runId:string){await runtime.drain();return runtime.get(projectId,runId);},
    async wait(runId:string,status:string){const until=Date.now()+10000;for(;;){const value=runtime.get(projectId,runId);if(value.run.status===status)return value;if(Date.now()>until)throw Error(`Unexpected task state: ${value.run.status}/${value.run.pauseReason}`);await pause(5);}},
    async received(count:number){const until=Date.now()+10000;while(requests.length<count){if(Date.now()>until)throw Error('Local model request was not received');await pause(5);}},
    action(snapshot:AgentTaskSnapshot,action:AgentTaskControlAction,extra:Record<string,unknown>={}){return runtime.action(projectId,snapshot.run.id,{requestId:randomUUID(),expectedRevision:snapshot.run.revision,action,...extra});},
    restart(){runtime.close();runtime=createAgentTaskRuntime({store,agentSettings:settings,authorizations,tools,gateway,selfPort:()=>4318});},
    async revoke(){const current=await authorizations.list(),grant=current.authorizations.find(row=>row.scope==='project_agent');assert.ok(grant);await authorizations.revoke({requestId:randomUUID(),expectedRevision:current.revision,authorizationId:grant.id});},
  };
}

test('Anthropic task body and continuation preserve native tool input and reject mismatched results',()=>{
  const definitions=[{name:'mioon_project_inspect',description:'Read project',parameters:{type:'object',properties:{},additionalProperties:false}}];
  const input={_mio_step:'读取当前项目'},planned=call(definitions[0]!.name,{}),output:TaskModelOutput={text:'准备',toolCalls:[planned],providerOutput:{role:'assistant',content:[{type:'text',text:'准备'},{type:'tool_use',id:planned.id,name:planned.name,input}]}};
  assert.equal(taskToolExplanation(output,planned.id),'读取当前项目');
  const continuation=taskContinuation('anthropic_messages',output,[{callId:planned.id,result:{name:'saved'}}]);
  assert.deepEqual(continuation,[output.providerOutput,{role:'user',content:[{type:'tool_result',tool_use_id:planned.id,content:'{"name":"saved"}'}]}]);
  const before=structuredClone(output),body=object(JSON.parse(buildTaskModelRequest(configuration,[taskResponseLanguageContext('en'),{role:'user',content:'Read project'},...continuation],definitions)));
  assert.match(String(body.system),/Use English/u);assert.equal(body.max_tokens,4096);assert.deepEqual(body.thinking,{type:'disabled'});assert.equal(Object.hasOwn(body,'input'),false);assert.equal(Object.hasOwn(body,'instructions'),false);
  const tools=body.tools as {input_schema:{properties:Record<string,unknown>}}[];assert.ok(tools[0]!.input_schema.properties._mio_step);assert.deepEqual(body.tool_choice,{type:'auto',disable_parallel_tool_use:true});
  assert.deepEqual(output,before);assert.throws(()=>taskContinuation('anthropic_messages',output,[{callId:'other',result:{}}]));
  const forged=structuredClone(output);object((object(forged.providerOutput).content as unknown[])[1]).input={approved:true};assert.throws(()=>taskContinuation('anthropic_messages',forged,[{callId:planned.id,result:{}}]));
});

test('Anthropic SDK executes a real local two-round multi-tool flow in host order',async t=>{
  const f=await fixture(t),calls=[call('mioon_project_inspect',{_mio_step:'读取当前项目'}),call('mioon_project_inspect',{_mio_step:'再次检查项目'})];f.plan(calls);
  const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.requests.length,2);assert.deepEqual(f.effects,['project.inspect','project.inspect']);
  const first=f.requests[0]!,second=f.requests[1]!;assert.equal(first.path,'/compat/v1/messages');assert.equal(first.headers['x-api-key'],key);assert.equal(first.headers['anthropic-version'],'2023-06-01');assert.equal(first.headers.authorization,undefined);
  const history=second.body.messages as {role:string;content:unknown}[],result=history.at(-1)!;assert.equal(result.role,'user');assert.deepEqual((result.content as {tool_use_id:string}[]).map(item=>item.tool_use_id),calls.map(item=>item.id));
  const model=f.runtime.journal.snapshot(sent.run.id).steps.find(item=>item.kind==='model')!;assert.equal(object(model.request).body,first.raw);
  for(const step of done.steps.filter(item=>item.kind==='tool'))assert.equal(Object.hasOwn(object(step.toolCall?.arguments),'_mio_step'),false);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM jobs').get()?.n,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM image_tasks').get()?.n,0);
  f.restart();assert.equal((await f.send(sent.run.requestId)).run.id,sent.run.id);await f.runtime.drain();assert.equal(f.requests.length,2);
});

test('Anthropic approved edit resumes the original tool after restart without another planning POST',async t=>{
  const f=await fixture(t),planned=call('mioon_shot_update',{shotId:String(f.shot.id),expectedRevision:Number(f.shot.revision),patch:{prompt:'approved native edit'},_mio_step:'调整镜头提示词'});f.plan([planned]);
  f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,local_reversible:'confirm'}});
  const sent=await f.send(),waiting=await f.wait(sent.run.id,'awaiting_approval');await f.runtime.drain();const step=waiting.steps.find(item=>item.status==='awaiting_approval')!;
  assert.equal(step.text,'调整镜头提示词');assert.equal(f.requests.length,1);assert.equal(f.effects.length,0);const frozen=JSON.stringify(f.runtime.journal.snapshot(sent.run.id).steps[0]!.request);
  f.restart();let restored=f.runtime.get(f.projectId,sent.run.id);assert.equal(restored.run.status,'interrupted');assert.equal(JSON.stringify(f.runtime.journal.snapshot(sent.run.id).steps[0]!.request),frozen);
  await f.action(restored,'resume');restored=await f.wait(sent.run.id,'awaiting_approval');assert.equal(f.requests.length,1);
  const approval={requestId:randomUUID(),expectedRevision:restored.run.revision,action:'approve',stepId:step.id};await f.runtime.action(f.projectId,sent.run.id,approval);await f.runtime.action(f.projectId,sent.run.id,approval);
  const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.requests.length,2);assert.deepEqual(f.effects,['shot.update']);
  const shot=object(f.store.get('shots',String(f.shot.id)));assert.equal(shot.prompt,'approved native edit');assert.equal(shot.revision,Number(f.shot.revision)+1);assert.equal(done.changes.length,1);
  assert.equal(JSON.stringify(f.runtime.journal.snapshot(sent.run.id).steps[0]!.request),frozen);
});

const miniMaxNative:AgentConfiguration={presetId:'minimax',platformId:'china',protocol:'anthropic_messages',model:'MiniMax-M3',baseUrl:'https://minimax-compatible.example.com/anthropic'};
test('MiniMax preset keeps Messages, bound credentials and one approved edit across native task recovery',async t=>{
  const f=await fixture(t,{selectedConfiguration:miniMaxNative});f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,local_reversible:'confirm'}});
  f.plan([call('mioon_shot_update',{shotId:String(f.shot.id),expectedRevision:Number(f.shot.revision),patch:{prompt:'MiniMax native edit'},_mio_step:'调整测试镜头'})]);
  const sent=await f.send(),waiting=await f.wait(sent.run.id,'awaiting_approval');await f.runtime.drain();
  assert.deepEqual(waiting.run.configuration,miniMaxNative);assert.equal(f.requests.length,1);assert.equal(f.effects.length,0);
  const first=f.requests[0]!,frozen=JSON.stringify(f.runtime.journal.snapshot(sent.run.id).steps[0]!.request),step=waiting.steps.find(item=>item.status==='awaiting_approval')!;
  assert.equal(first.path,'/anthropic/v1/messages');assert.equal(first.headers['x-api-key'],key);assert.equal(first.headers.authorization,undefined);assert.equal(first.body.model,miniMaxNative.model);assert.equal(first.body.max_tokens,4096);assert.deepEqual(first.body.thinking,{type:'disabled'});
  for(const field of ['max_completion_tokens','max_output_tokens','parallel_tool_calls','store','input'])assert.equal(Object.hasOwn(first.body,field),false,field);
  f.restart();await f.action(f.runtime.get(f.projectId,sent.run.id),'resume');const restored=await f.wait(sent.run.id,'awaiting_approval');assert.equal(f.requests.length,1);assert.deepEqual(restored.run.configuration,miniMaxNative);
  const approval={requestId:randomUUID(),expectedRevision:restored.run.revision,stepId:step.id,action:'approve'};await f.runtime.action(f.projectId,sent.run.id,approval);await f.runtime.action(f.projectId,sent.run.id,approval);
  const completed=await f.settle(sent.run.id);assert.equal(completed.run.status,'completed');assert.equal(f.requests.length,2);assert.deepEqual(f.effects,['shot.update']);assert.equal(completed.changes.length,1);assert.equal(object(f.store.get('shots',String(f.shot.id))).prompt,'MiniMax native edit');
  assert.equal(JSON.stringify(f.runtime.journal.snapshot(sent.run.id).steps[0]!.request),frozen);assert.deepEqual(completed.run.configuration,miniMaxNative);
});

test('changing the current MiniMax protocol cannot rewrite or replay an already frozen native task',async t=>{
  const f=await fixture(t,{selectedConfiguration:miniMaxNative});f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,local_reversible:'confirm'}});
  f.plan([call('mioon_shot_update',{shotId:String(f.shot.id),expectedRevision:Number(f.shot.revision),patch:{prompt:'must remain unapplied'}})]);
  const sent=await f.send();await f.wait(sent.run.id,'awaiting_approval');await f.runtime.drain();const frozen=JSON.stringify(f.runtime.journal.snapshot(sent.run.id).steps[0]!.request),settings=await f.settings.get();
  await f.settings.put({expectedRevision:settings.revision,configuration:{...miniMaxNative,protocol:'chat_completions'},secret:{action:'keep'}});
  f.restart();await f.action(f.runtime.get(f.projectId,sent.run.id),'resume');const failed=await f.settle(sent.run.id);
  assert.equal(failed.run.status,'failed');assert.equal(failed.run.pauseReason,'AGENT_SETTINGS_CONFLICT');assert.equal(f.requests.length,1);assert.equal(f.effects.length,0);
  assert.deepEqual(failed.run.configuration,miniMaxNative);assert.equal(JSON.stringify(f.runtime.journal.snapshot(sent.run.id).steps[0]!.request),frozen);assert.equal(object(f.store.get('shots',String(f.shot.id))).prompt,'original prompt');
});

test('Anthropic paid tool remains unsubmitted across restart until host approval, and denial makes no job',async t=>{
  const f=await fixture(t);f.plan([call('mioon_generation_submit',{shotId:String(f.shot.id),expectedRevision:Number(f.shot.revision),providerId:'mock',model:'mock-motion-v1',_mio_step:'生成镜头视频'})]);
  const sent=await f.send(),waiting=await f.wait(sent.run.id,'awaiting_approval');await f.runtime.drain();const step=waiting.steps.find(item=>item.status==='awaiting_approval')!;assert.equal(step.tier,'paid');assert.equal(f.requests.length,1);assert.equal(f.effects.length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM jobs').get()?.n,0);
  f.restart();const interrupted=f.runtime.get(f.projectId,sent.run.id);await f.action(interrupted,'resume');const again=await f.wait(sent.run.id,'awaiting_approval');assert.equal(f.requests.length,1);await f.action(again,'deny',{stepId:step.id});
  const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.requests.length,2);assert.equal(f.effects.length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM jobs').get()?.n,0);
});

test('Anthropic paid approval creates one bound job and recovery cannot submit it in the background',async t=>{
  let submissions=0;
  const provider:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},
    async submit(_snapshot,context){context.beforeSubmit?.();submissions++;return {providerJobId:'synthetic-only'};},
    async reconcile(){return null;},async poll(){return {status:'running'};},async download(){throw Error('No render requested');}};
  const providers=new Map([['mock',provider]]),f=await fixture(t,{providers});
  await f.services.call('shot.update',{shotId:String(f.shot.id),expectedRevision:Number(f.shot.revision),patch:{duration:2}});
  const shot=object(f.store.get('shots',String(f.shot.id)));f.plan([call('mioon_generation_submit',{shotId:String(shot.id),expectedRevision:Number(shot.revision),providerId:'mock',model:'mock-motion-v1'})]);
  const sent=await f.send(),waiting=await f.wait(sent.run.id,'awaiting_approval');await f.runtime.drain();
  const step=waiting.steps.find(item=>item.status==='awaiting_approval')!,request={requestId:randomUUID(),expectedRevision:waiting.run.revision,action:'approve',stepId:step.id};
  assert.equal(f.store.list('jobs',f.projectId).length,0);assert.equal(submissions,0);
  await f.runtime.action(f.projectId,sent.run.id,request);await f.runtime.action(f.projectId,sent.run.id,request);
  const completed=await f.settle(sent.run.id);assert.equal(completed.run.status,'completed');assert.equal(f.store.list('jobs',f.projectId).length,1);assert.equal(f.requests.length,2);assert.deepEqual(f.effects,['generation.submit']);
  const originalJob=object(f.store.list('jobs',f.projectId)[0]);assert.equal(originalJob.status,'queued');f.restart();assert.equal(f.runtime.get(f.projectId,sent.run.id).run.status,'interrupted');
  const worker=startWorker(f.store,f.services,providers);try{await worker.tick();await worker.tick();}finally{await worker.stop();}
  assert.equal(submissions,0);assert.equal(f.requests.length,2);assert.equal(f.store.list('jobs',f.projectId).length,1);assert.equal(object(f.store.list('jobs',f.projectId)[0]).id,originalJob.id);
});

test('Anthropic interrupted model outcome remains UNKNOWN and passive recovery never POSTs again',async t=>{
  const f=await fixture(t);f.script((_request,response)=>{response.write(startMessage());});const sent=await f.send();
  await f.received(1);const frozen=JSON.stringify(f.runtime.journal.snapshot(sent.run.id).steps[0]!.request);f.restart();
  const restored=f.runtime.get(f.projectId,sent.run.id);assert.equal(restored.run.status,'interrupted');assert.equal(restored.steps[0]?.status,'unknown');assert.equal(JSON.stringify(f.runtime.journal.snapshot(sent.run.id).steps[0]!.request),frozen);
  await assert.rejects(f.action(restored,'resume'),{code:'AGENT_TASK_UNKNOWN_RESULT'});assert.equal((await f.send(sent.run.requestId)).run.id,sent.run.id);await pause(30);assert.equal(f.requests.length,1);assert.equal(f.effects.length,0);
});

test('Anthropic Stop aborts the original stream and restart cannot replay it',async t=>{
  const f=await fixture(t);f.script((_request,response)=>{response.write(startMessage());});const sent=await f.send();await f.received(1);
  const stopped=await f.action(f.runtime.get(f.projectId,sent.run.id),'stop');assert.equal(stopped.run.status,'stopped');await f.runtime.drain();f.restart();assert.equal((await f.send(sent.run.requestId)).run.status,'stopped');await pause(30);assert.equal(f.requests.length,1);assert.equal(f.effects.length,0);
});

test('Anthropic streamed note capacity preserves the frozen request and binds accepted text only to the next round',async t=>{
  const f=await fixture(t),reply='r'.repeat(8192),wire=frames([],reply),split=wire.indexOf('event: content_block_stop');let finish=()=>{};
  f.script((_request,response,index)=>{if(index===1){response.write(wire.slice(0,split));finish=()=>response.end(wire.slice(split));}else response.end(frames([],'follow-up'));});
  const sent=await f.send();await f.received(1);
  const deadline=Date.now()+10000;while(f.runtime.journal.snapshot(sent.run.id).steps[0]?.text!==reply){if(Date.now()>deadline)assert.fail('Streamed text was not persisted');await pause(5);}
  try{
    const before=f.runtime.journal.snapshot(sent.run.id),frozen=JSON.stringify(before.steps[0]!.request);
    await assert.rejects(f.action(f.runtime.get(f.projectId,sent.run.id),'note',{text:'\u0000'.repeat(32*1024)}),{code:'AGENT_TASK_NOTE_CAPACITY'});
    assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),before);
    await f.action(f.runtime.get(f.projectId,sent.run.id),'note',{text:'Keep the next answer brief'});
    assert.equal(JSON.stringify(f.runtime.journal.snapshot(sent.run.id).steps[0]!.request),frozen);assert.equal(f.requests.length,1);
  }finally{finish();}
  const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.requests.length,2);assert.equal(done.run.notes?.length,1);assert.ok(done.run.notes?.[0]?.modelStepId);
  const messages=f.requests[1]!.body.messages as Array<{role:string;content:unknown}>;assert.deepEqual(messages.at(-2),{role:'assistant',content:[{type:'text',text:reply}]});assert.deepEqual(messages.at(-1),{role:'user',content:'Keep the next answer brief'});
});

test('Anthropic missing or revoked project authority blocks inference and saved tool approval',async t=>{
  const denied=await fixture(t,{authorize:false});await assert.rejects(denied.send(),{code:'AGENT_TASK_CONSENT_REQUIRED'});assert.equal(denied.requests.length,0);
  const f=await fixture(t);f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,local_reversible:'confirm'}});f.plan([call('mioon_shot_update',{shotId:String(f.shot.id),expectedRevision:Number(f.shot.revision),patch:{prompt:'must remain unapplied'}})]);
  const sent=await f.send(),waiting=await f.wait(sent.run.id,'awaiting_approval');await f.runtime.drain();const step=waiting.steps.find(item=>item.status==='awaiting_approval')!;await f.revoke();
  await assert.rejects(f.action(waiting,'approve',{stepId:step.id}),{code:'AGENT_TASK_CONSENT_REQUIRED'});assert.equal(f.requests.length,1);assert.equal(f.effects.length,0);assert.equal(object(f.store.get('shots',String(f.shot.id))).prompt,'original prompt');
});

for(const reason of ['missing_stop','max_tokens','duplicate_arguments','unknown_tool'] as const)test(`Anthropic ${reason} never dispatches partial tools or silently retries`,async t=>{
  const f=await fixture(t),planned=call(reason==='unknown_tool'?'mioon_unlisted':'mioon_project_inspect',{});
  f.script((_request,response)=>response.end(frames([planned],'',{terminal:reason!=='missing_stop',stopReason:reason==='max_tokens'?'max_tokens':'tool_use',...(reason==='duplicate_arguments'?{rawArguments:'{"PRIVATE_MARKER":1,"PRIVATE_MARKER":2}'}:{})})));
  const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'failed');assert.equal(f.requests.length,1);assert.equal(f.effects.length,0);assert.doesNotMatch(JSON.stringify(done),/PRIVATE_MARKER/u);
  f.restart();assert.equal((await f.send(sent.run.requestId)).run.id,sent.run.id);await f.runtime.drain();assert.equal(f.requests.length,1);assert.equal(f.effects.length,0);
});
