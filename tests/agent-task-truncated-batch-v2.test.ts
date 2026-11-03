import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../packages/business/src/agent/task-runtime-v2.ts';
import {createTaskGateway} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {AgentProtocol} from '../packages/contracts/src/agent-protocol.ts';
import type {AnthropicNativeStreamEvent} from '../packages/business/src/agent/anthropic-sdk-transport.ts';
import {createTestAuthorizations,authorizeTestScope} from './helpers/agent-authorizations.ts';
import {nativeAnthropicEvents,nativeAnthropicSse} from './helpers/anthropic-native-events.ts';

const data=(value:unknown):string=>`data: ${JSON.stringify(value)}\n\n`;
function toolFrames(protocol:AgentProtocol,truncated:boolean):string{
  const name='mioon_project_inspect',args='{}',id='complete_before_output_limit';
  if(protocol==='chat_completions')return data({choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id,type:'function',function:{name,arguments:args}}]},finish_reason:null}]})+
    data({choices:[{index:0,delta:{},finish_reason:truncated?'length':'tool_calls'}]})+'data: [DONE]\n\n';
  if(protocol==='anthropic_messages'){
    const frames=nativeAnthropicEvents({model:'qwen3:8b',toolName:name,argumentsJson:args});
    const finish=frames[4] as Extract<AnthropicNativeStreamEvent,{type:'message_delta'}>;
    if(truncated)frames[4]={...finish,delta:{...finish.delta,stop_reason:'max_tokens'}};
    return nativeAnthropicSse(frames);
  }
  const responseId='response_output_limit',item={id:'item_complete_call',type:'function_call',call_id:id,name,arguments:args,status:'completed'};
  return [
    {type:'response.created',response:{id:responseId,status:'in_progress',output:[]}},
    {type:'response.output_item.added',output_index:0,item:{...item,arguments:'',status:'in_progress'}},
    {type:'response.function_call_arguments.delta',output_index:0,item_id:item.id,delta:args},
    {type:'response.function_call_arguments.done',output_index:0,item_id:item.id,name,arguments:args},
    {type:'response.output_item.done',output_index:0,item},
    truncated?{type:'response.incomplete',response:{id:responseId,status:'incomplete',output:[item],incomplete_details:{reason:'max_output_tokens'}}}
      :{type:'response.completed',response:{id:responseId,status:'completed',output:[item]}},
  ].map(data).join('');
}
function textFrames(protocol:AgentProtocol):string{
  const text='The complete tool result was received.';
  if(protocol==='chat_completions')return data({choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]})+data({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n';
  if(protocol==='anthropic_messages')return nativeAnthropicSse(nativeAnthropicEvents({model:'qwen3:8b',text}));
  const id='response_final',item={id:'message_final',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
  return [
    {type:'response.created',response:{id,status:'in_progress',output:[]}},
    {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},
    {type:'response.output_text.delta',output_index:0,item_id:item.id,content_index:0,delta:text},
    {type:'response.output_item.done',output_index:0,item},
    {type:'response.completed',response:{id,status:'completed',output:[item]}},
  ].map(data).join('');
}
async function fixture(t:TestContext,protocol:AgentProtocol,truncated:boolean){
  let requests=0,executions=0;
  const server=http.createServer(async(request,response)=>{
    for await(const _chunk of request){/* Consume the synthetic request before responding. */}
    requests++;response.writeHead(200,{'Content-Type':'text/event-stream'});response.end(requests===1?toolFrames(protocol,truncated):textFrames(protocol));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-truncated-batch-')),store=openStore(root),services=createServices(store,new Map());
  const project=await services.call('project.create',{name:'Output limit batch'});assert.ok(project&&typeof project==='object'&&'id' in project);
  const projectId=String(project.id),settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}});
  await settings.put({expectedRevision:0,configuration:{presetId:'ollama',platformId:'local',protocol,model:'qwen3:8b',baseUrl:`http://127.0.0.1:${address.port}${protocol==='anthropic_messages'?'':'/v1'}`},secret:{action:'remove'}});
  const authorizations=createTestAuthorizations(()=>({...store}),settings);await authorizeTestScope(authorizations,'project_agent');
  const sourceTools=createAgentTaskTools({store,services}),tools={...sourceTools,execute:(...args:Parameters<typeof sourceTools.execute>)=>{executions++;return sourceTools.execute(...args);}};
  const runtime=createAgentTaskRuntime({store,agentSettings:settings,authorizations,tools,gateway:createTaskGateway(),selfPort:()=>4318});
  t.after(async()=>{runtime.close();await runtime.drain();sourceTools.dispose();await services.drain();await settings.close();store.close();rmSync(root,{recursive:true,force:true});await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});});
  return {runtime,projectId,settings,get requests(){return requests;},get executions(){return executions;}};
}

for(const protocol of ['chat_completions','responses','anthropic_messages'] as const){
  test(`${protocol}: output-limit truncation rejects even the complete leading call before any tool execution`,async t=>{
    const f=await fixture(t,protocol,true),sent=await f.runtime.send(f.projectId,{requestId:randomUUID(),text:'Only an offline output-limit test',expectedSettingsRevision:(await f.settings.get()).revision});
    await f.runtime.drain();const done=f.runtime.get(f.projectId,sent.run.id);
    assert.equal(done.run.status,'failed');assert.equal(f.requests,1);assert.equal(f.executions,0);
    assert.equal(done.steps.filter(step=>step.kind==='tool').length,0);assert.equal(done.changes.length,0);
    assert.equal(done.steps[0]?.status,'failed');
    assert.equal(done.steps[0]?.error?.code,protocol==='responses'?'AGENT_CHAT_PROVIDER_ERROR':'AGENT_CHAT_TRUNCATED');
  });
  test(`${protocol}: the same eligible leading call executes exactly once when the reply completes`,async t=>{
    const f=await fixture(t,protocol,false),sent=await f.runtime.send(f.projectId,{requestId:randomUUID(),text:'Only an offline complete-call control',expectedSettingsRevision:(await f.settings.get()).revision});
    await f.runtime.drain();const done=f.runtime.get(f.projectId,sent.run.id);
    assert.equal(done.run.status,'completed');assert.equal(f.requests,2);assert.equal(f.executions,1);
    assert.deepEqual(done.steps.filter(step=>step.kind==='tool').map(step=>[step.toolCall?.name,step.status]),[['mioon_project_inspect','completed']]);
  });
}
