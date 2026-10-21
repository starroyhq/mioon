import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import {DEFAULT_AGENT_CONFIGURATION} from '../packages/business/src/agent/presets.ts';
import type {AgentTransportDependencies} from '../packages/business/src/agent/network-policy.ts';
import {agentChatHttpStatus,safeAgentChatError} from '../packages/business/src/agent/chat-errors.ts';
import {buildTaskModelRequest,createTaskGateway,parseTaskArguments,taskContinuation,wasTaskSubmissionPrevented} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskModelOutput} from '../packages/business/src/agent/task-gateway-v2.ts';

const definitions=[{name:'mioon_shot_create',description:'Create a saved shot',parameters:{type:'object',properties:{title:{type:'string'}},required:['title'],additionalProperties:false}}];
const json=(value:unknown):string=>`data: ${JSON.stringify(value)}\n\n`;
function responseFrames(options:{mismatch?:boolean;incomplete?:boolean;duplicate?:boolean}={}):string {
  const id='resp_local',items=[0,1].map(index=>({id:`item_${index}`,type:'function_call',call_id:`call|${index}`,name:'mioon_shot_create',arguments:options.duplicate?' {"title":"a","title":"b"}':JSON.stringify({title:`Shot ${index}`}),status:'completed'}));
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
function textFrames(protocol:AgentConfiguration['protocol'],text='已完成只读往返'):string {
  if(protocol==='chat_completions')return json({choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]})+json({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n';
  const id='resp_text',part={type:'output_text',text,annotations:[]},item={id:'message_text',type:'message',role:'assistant',status:'completed',content:[part]};
  return [
    {type:'response.created',response:{id,status:'in_progress',output:[]}},
    {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},
    {type:'response.content_part.added',output_index:0,item_id:item.id,content_index:0,part:{...part,text:''}},
    {type:'response.output_text.delta',output_index:0,item_id:item.id,content_index:0,delta:text},
    {type:'response.output_text.done',output_index:0,item_id:item.id,content_index:0,text},
    {type:'response.content_part.done',output_index:0,item_id:item.id,content_index:0,part},
    {type:'response.output_item.done',output_index:0,item},
    {type:'response.completed',response:{id,status:'completed',output:[item]}},
  ].map(json).join('');
}
async function fixture(t:TestContext,protocol:AgentConfiguration['protocol'],frames:string|Buffer|((response:http.ServerResponse,index:number)=>void)){
  const requests:{body:Record<string,unknown>;authorization:string|undefined;method:string|undefined;path:string|undefined}[]=[];
  const server=http.createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk as Uint8Array));
    requests.push({body:JSON.parse(Buffer.concat(chunks).toString()) as Record<string,unknown>,authorization:req.headers.authorization,method:req.method,path:req.url});
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    if(typeof frames==='function'){frames(res,requests.length);return;}
    // Deliberately split framing and multibyte UTF-8 across transport chunks.
    const bytes=Buffer.from(frames);for(let index=0;index<bytes.length;index+=17)res.write(bytes.subarray(index,index+17));res.end();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();}));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const configuration:AgentConfiguration={presetId:'ollama',platformId:'local',protocol,model:'qwen3:8b',baseUrl:`http://127.0.0.1:${address.port}/v1`};
  const body=buildTaskModelRequest(configuration,[{role:'user',content:'创建两个镜头'}],definitions,4318);
  const stream=({requestBody=body,beforeSubmit,signal}:{requestBody?:string;beforeSubmit?:()=>void;signal?:AbortSignal}={})=>createTaskGateway()({configuration,body:requestBody,apiKey:null,selfPort:4318,beforeSubmit,signal});
  async function output(beforeSubmit?:()=>void,requestBody=body):Promise<TaskModelOutput>{let result:TaskModelOutput|undefined;
    for await(const item of stream({beforeSubmit,requestBody}))if(item.type==='done')result=item.output;
    assert.ok(result);return result;
  }
  return {configuration,body,requests,output,stream};
}
function syntheticNetwork({peer='8.8.8.8',authorized=true,status=200,body='',connectionError,endError}: {peer?:string;authorized?:boolean;status?:number;body?:string;connectionError?:Error;endError?:Error}={}){
  const state={calls:0,ends:0,destroyed:false};
  const request=(_options:unknown,callback:(incoming:unknown)=>void)=>{
    state.calls++;
    const outgoing=Object.assign(new EventEmitter(),{setTimeout(){},destroy(){state.destroyed=true;},end(){
      state.ends++;if(endError)throw endError;
      callback(Object.assign(Readable.from([Buffer.from(body)]),{statusCode:status,headers:{'content-type':'text/event-stream'}}));
    }});
    queueMicrotask(()=>{
      if(connectionError){outgoing.emit('error',connectionError);return;}
      const socket=Object.assign(new EventEmitter(),{remoteAddress:peer,remotePort:443,authorized,destroy(){state.destroyed=true;}});
      outgoing.emit('socket',socket);socket.emit('secureConnect');
    });
    return outgoing;
  };
  return {...state,get calls(){return state.calls;},get ends(){return state.ends;},get destroyed(){return state.destroyed;},request};
}
function syntheticOutput(protocol:AgentConfiguration['protocol'],network:ReturnType<typeof syntheticNetwork>,{answers=[{address:'8.8.8.8',family:4}],lookupError,beforeSubmit}: {answers?:Array<{address:string;family:number}>;lookupError?:Error;beforeSubmit?:()=>void}={}){
  const configuration={...DEFAULT_AGENT_CONFIGURATION,protocol},body=buildTaskModelRequest(configuration,[{role:'user',content:'synthetic local test'}],definitions,4318);
  const dependencies={lookup:async()=>{if(lookupError)throw lookupError;return answers;},httpsRequest:network.request} as unknown as AgentTransportDependencies;
  return (async()=>{for await(const _item of createTaskGateway(dependencies)({configuration,body,apiKey:'SYNTHETIC_TASK_GATEWAY_ONLY',selfPort:4318,beforeSubmit})){};})();
}
for(const protocol of ['chat_completions','responses'] as const){
  test(`${protocol}: trusted pre-send transport failures prove no model HTTP request was sent`,async()=>{
    const cases=[
      {options:{},input:{answers:[{address:'198.18.10.207',family:4}]},code:'AGENT_CHAT_NETWORK_DENIED',calls:0},
      {options:{},input:{answers:[{address:'8.8.8.8',family:4},{address:'198.18.10.207',family:4}]},code:'AGENT_CHAT_NETWORK_DENIED',calls:0},
      {options:{},input:{lookupError:Error('synthetic DNS failure')},code:'AGENT_CHAT_CONNECT_FAILED',calls:0},
      {options:{peer:'127.0.0.1'},input:{},code:'AGENT_CHAT_NETWORK_DENIED',calls:1},
      {options:{authorized:false},input:{},code:'AGENT_CHAT_CONNECT_FAILED',calls:1},
      {options:{connectionError:Object.assign(Error('synthetic connect failure'),{code:'ECONNRESET'})},input:{},code:'AGENT_CHAT_CONNECT_FAILED',calls:1},
    ];
    for(const item of cases){
      const network=syntheticNetwork(item.options);let failure:unknown;
      await assert.rejects(syntheticOutput(protocol,network,item.input),error=>{failure=error;return (error as {code?:string}).code===item.code;});
      assert.equal(network.calls,item.calls);assert.equal(network.ends,0);
      assert.equal(wasTaskSubmissionPrevented(failure),true,item.code);
      assert.equal(wasTaskSubmissionPrevented({...failure as Record<string,unknown>}),false,'copying the safe error cannot copy its trusted identity');
    }
  });
  test(`${protocol}: the final authorization fence after TLS still prevents request.end`,async()=>{
    const network=syntheticNetwork(),revoked=Object.assign(Error('synthetic revocation'),{code:'AGENT_TASK_CONSENT_REQUIRED'});let fences=0;
    await assert.rejects(syntheticOutput(protocol,network,{beforeSubmit(){if(++fences===3)throw revoked;}}),error=>error===revoked);
    assert.equal(fences,3);assert.equal(network.calls,1);assert.equal(network.ends,0);assert.equal(wasTaskSubmissionPrevented(revoked),true);
  });
  test(`${protocol}: HTTP rejection, truncated streams and synchronous end failure keep the sent outcome uncertain`,async()=>{
    const forged=Object.assign(Error('synthetic external marker'),{code:'AGENT_CHAT_NETWORK_DENIED',dispatched:false,outcomeUnknown:false,details:{dispatchPrevented:true}});
    assert.equal(wasTaskSubmissionPrevented(forged),false);assert.equal(wasTaskSubmissionPrevented({...forged}),false);
    for(const options of [{status:401},{body:protocol==='responses'?responseFrames({incomplete:true}):chatFrames({incomplete:true})},{endError:forged},{body:json({error:{code:'AGENT_CHAT_NETWORK_DENIED',dispatched:false,details:{dispatchPrevented:true}}})}]){
      const network=syntheticNetwork(options);let failure:unknown;
      await assert.rejects(syntheticOutput(protocol,network),error=>{failure=error;return true;});
      assert.equal(network.ends,1);assert.equal(wasTaskSubmissionPrevented(failure),false);assert.equal(wasTaskSubmissionPrevented(forged),false);
    }
  });
  test(`${protocol}: task gateway retains only trusted HTTP status without changing dispatch evidence`,async()=>{
    const network=syntheticNetwork({status:429,body:'synthetic-provider-body-marker'});let failure:unknown;
    await assert.rejects(syntheticOutput(protocol,network),error=>{failure=error;return safeAgentChatError(error).code==='AGENT_CHAT_HTTP_ERROR';});
    assert.deepEqual(safeAgentChatError(failure),{code:'AGENT_CHAT_HTTP_ERROR',status:502,message:'模型服务拒绝了请求（HTTP 429），请检查账户、模型和配置后手动重试。'});
    assert.equal(agentChatHttpStatus(failure),429);assert.equal(network.calls,1);assert.equal(network.ends,1);assert.equal(wasTaskSubmissionPrevented(failure),false);
    assert.equal(agentChatHttpStatus({...failure as Record<string,unknown>}),undefined);
  });
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
  test(`${protocol}: retryable HTTP statuses and connection failure never dispatch an implicit second request`,async()=>{
    for(const status of [408,429,500,503]){
      const network=syntheticNetwork({status});let failure:unknown;
      await assert.rejects(syntheticOutput(protocol,network),error=>{failure=error;return safeAgentChatError(error).code==='AGENT_CHAT_HTTP_ERROR';});
      assert.equal(agentChatHttpStatus(failure),status);assert.equal(network.calls,1);assert.equal(network.ends,1);assert.equal(wasTaskSubmissionPrevented(failure),false);
    }
    const network=syntheticNetwork({connectionError:Error('SYNTHETIC_CONNECTION_FAILURE')});let failure:unknown;
    await assert.rejects(syntheticOutput(protocol,network),error=>{failure=error;return safeAgentChatError(error).code==='AGENT_CHAT_CONNECT_FAILED';});
    assert.equal(network.calls,1);assert.equal(network.ends,0);assert.equal(wasTaskSubmissionPrevented(failure),true);
  });
  test(`${protocol}: SDK transport stays on the injected Mioon network rather than global fetch`,async()=>{
    const original=globalThis.fetch;let bypasses=0;
    globalThis.fetch=async()=>{bypasses++;throw Error('Global fetch must never send a Mioon model request');};
    try{
      const network=syntheticNetwork({body:protocol==='responses'?responseFrames():chatFrames()});
      await syntheticOutput(protocol,network);assert.equal(network.calls,1);assert.equal(network.ends,1);assert.equal(bypasses,0);
    }finally{globalThis.fetch=original;}
  });
  test(`${protocol}: SDK integration cannot inherit an environment credential or substitute an environment destination`,async t=>{
    const f=await fixture(t,protocol,textFrames(protocol)),gatewayModule=new URL('../packages/business/src/agent/task-gateway-v2.ts',import.meta.url).href;
    const script=`
      const {createTaskGateway,buildTaskModelRequest}=await import(${JSON.stringify(gatewayModule)});
      let bypasses=0;globalThis.fetch=async()=>{bypasses++;throw Error('Unowned fetch is forbidden');};
      const configuration=${JSON.stringify(f.configuration)},body=buildTaskModelRequest(configuration,[{role:'user',content:'synthetic'}],[],4318);
      let completed=false;for await(const item of createTaskGateway()({configuration,body,apiKey:null,selfPort:4318}))completed ||= item.type==='done';
      process.stdout.write(JSON.stringify({completed,bypasses}));
    `;
    const environment={OPENAI_API_KEY:'SYNTHETIC_ENV_ONLY_KEY',OPENAI_BASE_URL:'https://untrusted.invalid/v1',OPENAI_ORG_ID:'SYNTHETIC_ORG',OPENAI_PROJECT_ID:'SYNTHETIC_PROJECT',...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})};
    const {stdout,stderr}=await promisify(execFile)(process.execPath,['--input-type=module','--eval',script],{env:environment,timeout:10000,maxBuffer:64*1024});
    assert.deepEqual(JSON.parse(stdout),{completed:true,bypasses:0});assert.equal(stderr.includes('SYNTHETIC_ENV_ONLY_KEY'),false);
    assert.equal(f.requests.length,1);assert.equal(f.requests[0]!.authorization,undefined);assert.equal(f.requests[0]!.path,protocol==='responses'?'/v1/responses':'/v1/chat/completions');
  });
  test(`${protocol}: two actual HTTP rounds retain the journaled request semantics and tool result identities`,async t=>{
    const f=await fixture(t,protocol,(res,index)=>res.end(index===1?(protocol==='responses'?responseFrames():chatFrames()):textFrames(protocol,'你好，工具往返已完成 🙂')));
    const first=await f.output(),results=first.toolCalls.map(call=>({callId:call.id,result:{title:String((call.arguments as {title:string}).title),success:true}}));
    const nextBody=buildTaskModelRequest(f.configuration,[{role:'user',content:'创建两个镜头'},...taskContinuation(protocol,first,results)],definitions,4318);
    const final=await f.output(undefined,nextBody);assert.equal(final.text,'你好，工具往返已完成 🙂');assert.deepEqual(final.toolCalls,[]);
    assert.equal(f.requests.length,2);
    for(const [index,request] of f.requests.entries()){
      assert.equal(request.method,'POST');assert.equal(request.path,protocol==='responses'?'/v1/responses':'/v1/chat/completions');
      assert.equal(request.authorization,undefined,'A keyless local configuration must not transmit an SDK placeholder credential');
      assert.deepEqual(request.body,JSON.parse(index===0?f.body:nextBody));
    }
    const sent=f.requests[1]!.body;
    if(protocol==='responses')assert.deepEqual((sent.input as {type?:string;call_id?:string}[]).filter(item=>item.type==='function_call_output').map(item=>item.call_id),['call|0','call|1']);
    else assert.deepEqual((sent.messages as {role?:string;tool_call_id?:string}[]).filter(item=>item.role==='tool').map(item=>item.tool_call_id),['call|0','call|1']);
  });
  test(`${protocol}: abort and consumer return close a partial stream without retry or fabricated completion`,async t=>{
    for(const mode of ['abort','return'] as const){
      let closed:()=>void=()=>{};const disconnected=new Promise<void>(resolve=>{closed=resolve;});
      const partial=protocol==='chat_completions'?json({choices:[{index:0,delta:{content:'部分输出'},finish_reason:null}]}):textFrames(protocol,'部分输出').split('\n\n').slice(0,4).join('\n\n')+'\n\n';
      const f=await fixture(t,protocol,res=>{res.once('close',closed);res.write(partial);}),controller=new AbortController(),iterator=f.stream({signal:controller.signal});
      const first=await iterator.next();assert.equal(first.value?.type,'delta');
      if(mode==='abort'){controller.abort();await assert.rejects(iterator.next(),{code:'AGENT_CHAT_ABORTED'});}else await iterator.return();
      await Promise.race([disconnected,delay(1000).then(()=>assert.fail('The owned synthetic model socket remained open'))]);
      assert.equal(f.requests.length,1);
    }
  });
  test(`${protocol}: SDK integration does not admit unlisted tools, duplicate JSON keys or reasoning payloads`,async t=>{
    const toolFrames=protocol==='responses'?responseFrames():chatFrames();
    const reasoning=protocol==='responses'?toolFrames.replace('"type":"response.created"','"type":"response.created","reasoning_content":"SYNTHETIC_PRIVATE_REASONING"'):json({choices:[{index:0,delta:{reasoning_content:'SYNTHETIC_PRIVATE_REASONING'},finish_reason:null}]})+toolFrames;
    for(const [source,expected] of [
      [toolFrames.replaceAll('mioon_shot_create','mioon_unadmitted_tool'),'AGENT_CHAT_TOOLS_UNSUPPORTED'],
      [protocol==='responses'?responseFrames({duplicate:true}):chatFrames({duplicate:true}),'AGENT_CHAT_PROTOCOL_ERROR'],
      [reasoning,'AGENT_CHAT_REASONING_UNSUPPORTED'],
    ] as const){const f=await fixture(t,protocol,source);await assert.rejects(f.output(),{code:expected});assert.equal(f.requests.length,1);}
  });
  test(`${protocol}: invalid UTF-8, oversized events and post-terminal data never produce a completed model result`,async t=>{
    const parts=textFrames(protocol,'INVALID_UTF8').split('INVALID_UTF8'),invalid=Buffer.concat(parts.flatMap((part,index)=>index?[Buffer.from([0xc3,0x28]),Buffer.from(part)]:[Buffer.from(part)]));
    for(const [source,expected] of [
      [invalid,'AGENT_CHAT_PROTOCOL_ERROR'],
      [textFrames(protocol,'x'.repeat(70*1024)),'AGENT_CHAT_LIMIT'],
      [textFrames(protocol)+json({SYNTHETIC_TRAILING_DATA:true}),'AGENT_CHAT_PROTOCOL_ERROR'],
    ] as const){const f=await fixture(t,protocol,source);await assert.rejects(f.output(),{code:expected});assert.equal(f.requests.length,1);}
  });
}
test('Responses SDK integration preserves explicit event-name agreement and rejects server-side tool modalities',async t=>{
  for(const [source,expected] of [
    ['event: response.audio.delta\n'+responseFrames(),'AGENT_CHAT_PROTOCOL_ERROR'],
    [responseFrames().replaceAll('"type":"function_call"','"type":"web_search_call"'),'AGENT_CHAT_TOOLS_UNSUPPORTED'],
    [responseFrames().replace('"type":"response.function_call_arguments.delta"','"type":"response.audio.delta"'),'AGENT_CHAT_PROTOCOL_ERROR'],
  ] as const){const f=await fixture(t,'responses',source);await assert.rejects(f.output(),{code:expected});assert.equal(f.requests.length,1);}
});
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
