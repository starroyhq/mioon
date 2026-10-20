import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import {buildTaskModelRequest,createTaskGateway,parseTaskArguments,taskContinuation,wasTaskSubmissionPrevented} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskModelOutput} from '../packages/business/src/agent/task-gateway-v2.ts';

const definitions=[{name:'mioon_shot_create',description:'Create a saved shot',parameters:{type:'object',properties:{title:{type:'string'}},required:['title'],additionalProperties:false}}];
const json=(value:unknown):string=>`data: ${JSON.stringify(value)}\n\n`;
function responseFrames(options:{mismatch?:boolean;incomplete?:boolean}={}):string {
  const id='resp_local',items=[0,1].map(index=>({id:`item_${index}`,type:'function_call',call_id:`call|${index}`,name:'mioon_shot_create',arguments:JSON.stringify({title:`Shot ${index}`}),status:'completed'}));
  const frames:unknown[]=[{type:'response.created',response:{id,status:'in_progress',output:[]}}];
  for(const [index,item] of items.entries())frames.push(
    {type:'response.output_item.added',output_index:index,item:{...item,arguments:'',status:'in_progress'}},
    {type:'response.function_call_arguments.delta',output_index:index,item_id:item.id,delta:item.arguments.slice(0,5)},
    {type:'response.function_call_arguments.delta',output_index:index,item_id:item.id,delta:item.arguments.slice(5)},
    {type:'response.function_call_arguments.done',output_index:index,item_id:item.id,name:item.name,arguments:item.arguments},
    {type:'response.output_item.done',output_index:index,item},
  );
  if(!options.incomplete)frames.push({type:'response.completed',response:{id,status:'completed',output:options.mismatch?[{...items[0],arguments:'{}'},items[1]]:items}});
  return frames.map(json).join('');
}
function chatFrames(options:{incomplete?:boolean;duplicate?:boolean;filtered?:boolean}={}):string {
  const calls=[0,1].map(index=>({index,id:`call|${index}`,type:'function',function:{name:'mioon_shot_create',arguments:options.duplicate?' {"title":"a","title":"b"}':JSON.stringify({title:`Shot ${index}`})}}));
  return json({choices:[{index:0,delta:{role:'assistant',tool_calls:calls},finish_reason:null}]})+
    json({choices:[{index:0,delta:{},finish_reason:options.filtered?'content_filter':'tool_calls'}]})+(options.incomplete?'':'data: [DONE]\n\n');
}
async function fixture(t:TestContext,protocol:AgentConfiguration['protocol'],frames:string){
  const requests:{body:Record<string,unknown>;authorization:string|undefined}[]=[];
  const server=http.createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk as Uint8Array));
    requests.push({body:JSON.parse(Buffer.concat(chunks).toString()) as Record<string,unknown>,authorization:req.headers.authorization});
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    // Deliberately split framing and multibyte UTF-8 across transport chunks.
    const bytes=Buffer.from(frames);for(let index=0;index<bytes.length;index+=17)res.write(bytes.subarray(index,index+17));res.end();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();}));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const configuration:AgentConfiguration={presetId:'ollama',platformId:'local',protocol,model:'qwen3:8b',baseUrl:`http://127.0.0.1:${address.port}/v1`};
  const body=buildTaskModelRequest(configuration,[{role:'user',content:'创建两个镜头'}],definitions,4318);
  async function output(beforeSubmit?:()=>void):Promise<TaskModelOutput>{let result:TaskModelOutput|undefined;
    for await(const item of createTaskGateway()({configuration,body,apiKey:null,selfPort:4318,beforeSubmit}))if(item.type==='done')result=item.output;
    assert.ok(result);return result;
  }
  return {configuration,body,requests,output};
}
for(const protocol of ['chat_completions','responses'] as const){
  test(`${protocol}: real fragmented local SSE preserves multiple calls and exact continuation IDs`,async t=>{
    const f=await fixture(t,protocol,protocol==='responses'?responseFrames():chatFrames()),output=await f.output();
    assert.equal(f.requests.length,1);assert.equal(f.requests[0]!.authorization,undefined);assert.equal(output.toolCalls.length,2);
    assert.deepEqual(output.toolCalls.map(call=>call.id),['call|0','call|1']);
    const continuation=taskContinuation(protocol,output,output.toolCalls.map(call=>({callId:call.id,result:{created:true}})));
    const next=JSON.parse(buildTaskModelRequest(f.configuration,[{role:'user',content:'创建两个镜头'},...continuation],definitions,4318)) as Record<string,unknown>;
    if(protocol==='responses'){assert.equal(next.store,false);const input=next.input as {type?:string;call_id?:string}[];assert.deepEqual(input.filter(item=>item.type==='function_call_output').map(item=>item.call_id),['call|0','call|1']);}
    else {const messages=next.messages as {role:string;tool_call_id?:string}[];assert.deepEqual(messages.filter(item=>item.role==='tool').map(item=>item.tool_call_id),['call|0','call|1']);}
  });
  test(`${protocol}: a persisted authorization fence can prevent the actual HTTP POST`,async t=>{
    const f=await fixture(t,protocol,protocol==='responses'?responseFrames():chatFrames());
    const revoked=Object.assign(Error('revoked'),{code:'AGENT_CHAT_CONSENT_REQUIRED'});assert.equal(wasTaskSubmissionPrevented(revoked),false);
    await assert.rejects(f.output(()=>{throw revoked;}),{code:'AGENT_CHAT_CONSENT_REQUIRED'});assert.equal(wasTaskSubmissionPrevented(revoked),true);
    assert.equal(f.requests.length,0);
  });
  test(`${protocol}: missing stream terminal never admits tool output`,async t=>{
    const f=await fixture(t,protocol,protocol==='responses'?responseFrames({incomplete:true}):chatFrames({incomplete:true}));
    await assert.rejects(f.output(),{code:'AGENT_CHAT_TRUNCATED'});
  });
}
test('Responses final snapshot must agree with all streamed argument and item evidence',async t=>{
  const f=await fixture(t,'responses',responseFrames({mismatch:true}));await assert.rejects(f.output(),{code:'AGENT_CHAT_PROTOCOL_ERROR'});
});
test('Chat Completions duplicate argument keys and filtered tool output never execute',async t=>{
  for(const options of [{duplicate:true},{filtered:true}]){const f=await fixture(t,'chat_completions',chatFrames(options));await assert.rejects(f.output(),{code:options.filtered?'AGENT_CHAT_PROVIDER_ERROR':'AGENT_CHAT_PROTOCOL_ERROR'});}
});
test('task arguments reject nested duplicate authority-shaped keys and accept escaped JSON strings',()=>{
  assert.deepEqual(parseTaskArguments('{"title":"a\\\"b","nested":{"safe":true}}'),{title:'a"b',nested:{safe:true}});
  for(const value of ['{"patch":{"title":"a","title":"b"}}','{"x":1,"\\u0078":2}','[]','null','{} trailing'])assert.throws(()=>parseTaskArguments(value));
});
