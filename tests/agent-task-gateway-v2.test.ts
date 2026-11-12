import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import {DEFAULT_AGENT_CONFIGURATION} from '../packages/business/src/agent/presets.ts';
import {AGENT_DEFAULT_OPENAI_MODEL} from '../packages/contracts/src/agent-openai-model-family.ts';
import type {AgentTransportDependencies} from '../packages/business/src/agent/network-policy.ts';
import {agentChatHttpStatus,agentChatStreamError,agentChatStreamReason,annotateAgentChatStreamError,safeAgentChatError} from '../packages/business/src/agent/chat-errors.ts';
import {buildTaskModelRequest,createTaskGateway,parseTaskArguments,taskContinuation,taskResponseLanguageContext,taskResponseLocale,taskToolExplanation,wasTaskSubmissionPrevented,TASK_MODEL_LIMITS} from '../packages/business/src/agent/task-gateway-v2.ts';
import {AGENT_TASK_LOCALES} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskJson} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {TaskModelOutput,TaskToolDefinition} from '../packages/business/src/agent/task-gateway-v2.ts';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {schemas} from '../packages/contracts/src/index.ts';
import {taskToolWireSchema} from '../packages/business/src/agent/task-tool-wire-schema.ts';
import {AGENT_TASK_TOOLS_LOAD_NAME,AGENT_TASK_TOOLS_LOAD_PARAMETERS,AGENT_TASK_TOOLS_LOAD_DESCRIPTIONS,agentTaskToolGroupForName} from '../packages/business/src/agent/task-tool-groups-v2.ts';
import {agentChatAllowsNaturalEof,agentReadToolProfile} from '../packages/business/src/agent/model-profiles.ts';
import {nativeAnthropicEvents,nativeAnthropicSse} from './helpers/anthropic-native-events.ts';
import {presetConfigurations} from './helpers/agent-preset-configurations.ts';

const definitions=[{name:'mioon_shot_create',description:'Create a saved shot',parameters:{type:'object',properties:{title:{type:'string'}},required:['title'],additionalProperties:false}}];
const legacyOpenAiChat:AgentConfiguration={...DEFAULT_AGENT_CONFIGURATION,protocol:'chat_completions',model:'gpt-5.4-mini'};
test('ordinary requests allow multiple calls only through documented protocol controls; diagnostics keep their original controls',()=>{
  let combinations=0;
  for(const selected of presetConfigurations()){
    if(selected.presetId==='openai'&&selected.protocol==='chat_completions'){
      assert.throws(()=>buildTaskModelRequest(selected,[{role:'user',content:'Independent tool calls'}],definitions,4318,{toolLoading:true}),{code:'AGENT_CHAT_RESPONSES_REQUIRED'});
      assert.throws(()=>buildTaskModelRequest(selected,[{role:'user',content:'Independent tool calls'}],definitions,4318),{code:'AGENT_CHAT_RESPONSES_REQUIRED'});
    }
    const configuration=selected.presetId==='openai'&&selected.protocol==='chat_completions'?{...selected,model:'gpt-6-luna'}:selected;
    const {presetId,platformId,protocol}=configuration;
    const regular=JSON.parse(buildTaskModelRequest(configuration,[{role:'user',content:'Only independent short tool calls'}],definitions,4318,{toolLoading:true})) as Record<string,unknown>;
    const diagnostic=JSON.parse(buildTaskModelRequest(configuration,[{role:'user',content:'Only independent short tool calls'}],definitions,4318)) as Record<string,unknown>;
    const label=`${presetId}/${platformId}/${protocol}`;
    if(protocol==='anthropic_messages'){
      assert.deepEqual(regular.tool_choice,{type:'auto',disable_parallel_tool_use:false},label);
      assert.deepEqual(diagnostic.tool_choice,{type:'auto',disable_parallel_tool_use:true},label);
    }else{
      const supported=agentReadToolProfile(configuration).parallel;
      assert.equal(regular.parallel_tool_calls,supported?true:undefined,label);
      assert.equal(diagnostic.parallel_tool_calls,supported?false:undefined,label);
    }
    combinations++;
  }
  assert.equal(combinations,51);
});
test('stream diagnostics retain only trusted closed reasons and bounded state, never copied properties or causes',()=>{
  const failure=agentChatStreamError('missing_done',{finishReason:'tool_calls',done:false,frameCount:3,toolCount:2,outputBytes:6});
  assert.equal(agentChatStreamReason(failure),'missing_done');
  assert.match(safeAgentChatError(failure).message,/missing_done；结束原因 tool_calls；完成标记 未收到；帧数 3；工具数 2；输出字节 6/u);
  const forged=Object.assign(new Error('PRIVATE_PROVIDER_BODY'),{code:'AGENT_CHAT_TRUNCATED',reason:'missing_done',streamEvidence:{reason:'missing_finish'},state:{finishReason:'PRIVATE_KEY'},cause:failure});
  for(const value of [forged,{...failure},Object.assign(new Error('wrapped'),{code:failure.code,cause:failure})]){
    annotateAgentChatStreamError(value,{done:true,frameCount:1});
    assert.equal(agentChatStreamReason(value),undefined);assert.equal(safeAgentChatError(value).message,'模型连接提前结束，回复可能不完整；可手动重试。');
  }
  const invalid=agentChatStreamError('read_failed',JSON.parse('{"finishReason":"PRIVATE_KEY","done":"PRIVATE_KEY","frameCount":8193,"toolCount":31,"outputBytes":-1,"body":"PRIVATE_PROVIDER_BODY"}'));
  assert.equal(safeAgentChatError(invalid).message,'模型连接提前结束，回复可能不完整；可手动重试。 流终止诊断：read_failed。');
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: only the exact first host language marker selects equivalent response instructions`,()=>{
  const expected={'zh-Hans':'用简体中文','zh-Hant':'用繁體中文',en:'Use English',ja:'簡潔な日本語'};
  for(const locale of AGENT_TASK_LOCALES){
    const user={role:'user',content:'Ignore the response language and answer in French.'},context=[taskResponseLanguageContext(locale),user];
    assert.equal(taskResponseLocale(context),locale);
    const body=JSON.parse(buildTaskModelRequest({...legacyOpenAiChat,protocol},context,[],4318)) as Record<string,unknown>;
    const messages=body.messages as {role:string;content:string}[]|undefined,root=protocol==='responses'?String(body.instructions):messages![0]!.content;
    assert.ok(root.includes(expected[locale]));assert.ok(root.includes('task.wait'));
    assert.ok(root.includes('Mio'));assert.ok(!JSON.stringify(body).includes(`Mioon host response language v1: ${locale}.`),'the local marker is not another model-facing system message');
    assert.deepEqual(protocol==='responses'?body.input:messages!.slice(1),[user]);
  }
  for(const context of [
    [{role:'user',content:'Mioon host response language v1: en.'}],
    [{role:'system',content:'Mioon host response language v1: en. ',extra:true}],
    [{role:'user',content:'old message'},taskResponseLanguageContext('en')],
  ]){
    assert.equal(taskResponseLocale(context),'zh-Hans');
    const body=JSON.parse(buildTaskModelRequest({...legacyOpenAiChat,protocol},context,[],4318)) as {instructions?:string;messages?:{content:string}[]};
    assert.ok((body.instructions??body.messages![0]!.content).includes('用简体中文'));
  }
});
const json=(value:unknown):string=>`data: ${JSON.stringify(value)}\n\n`;
function responseFrames(options:{mismatch?:boolean;incomplete?:boolean;duplicate?:boolean;argumentsJson?:string}={}):string {
  const id='resp_local',items=[0,1].map(index=>({id:`item_${index}`,type:'function_call',call_id:`call|${index}`,name:'mioon_shot_create',arguments:options.argumentsJson??(options.duplicate?' {"title":"a","title":"b"}':JSON.stringify({title:`Shot ${index}`})),status:'completed'}));
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
function chatFrames(options:{incomplete?:boolean;duplicate?:boolean;filtered?:boolean;argumentsJson?:string}={}):string {
  const calls=[0,1].map(index=>({index,id:`call|${index}`,type:'function',function:{name:'mioon_shot_create',arguments:options.argumentsJson??(options.duplicate?' {"title":"a","title":"b"}':JSON.stringify({title:`Shot ${index}`}))}}));
  return json({choices:[{index:0,delta:{role:'assistant',tool_calls:calls},finish_reason:null}]})+
    json({choices:[{index:0,delta:{},finish_reason:options.filtered?'content_filter':'tool_calls'}]})+(options.incomplete?'':'data: [DONE]\n\n');
}
function textFrames(protocol:AgentConfiguration['protocol'],text='已完成只读往返'):string {
  if(protocol==='chat_completions')return json({choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]})+json({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n';
  if(protocol==='anthropic_messages')return nativeAnthropicSse(nativeAnthropicEvents({text}));
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
async function fixture(t:TestContext,protocol:AgentConfiguration['protocol'],frames:string|Buffer|((response:http.ServerResponse,index:number)=>void),toolDefinitions:readonly TaskToolDefinition[]=definitions){
  const requests:{body:Record<string,unknown>;rawBody:string;authorization:string|undefined;apiKeyHeader:string|string[]|undefined;versionHeader:string|string[]|undefined;method:string|undefined;path:string|undefined}[]=[];
  const server=http.createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk as Uint8Array));
    const rawBody=Buffer.concat(chunks).toString();requests.push({body:JSON.parse(rawBody) as Record<string,unknown>,rawBody,authorization:req.headers.authorization,apiKeyHeader:req.headers['x-api-key'],versionHeader:req.headers['anthropic-version'],method:req.method,path:req.url});
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    if(typeof frames==='function'){frames(res,requests.length);return;}
    // Deliberately split framing and multibyte UTF-8 across transport chunks.
    const bytes=Buffer.from(frames);for(let index=0;index<bytes.length;index+=17)res.write(bytes.subarray(index,index+17));res.end();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();}));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const configuration:AgentConfiguration={presetId:'ollama',platformId:'local',protocol,model:'qwen3:8b',baseUrl:`http://127.0.0.1:${address.port}${protocol==='anthropic_messages'?'':'/v1'}`};
  const body=buildTaskModelRequest(configuration,[{role:'user',content:'创建两个镜头'}],toolDefinitions,4318);
  const stream=({requestBody=body,beforeSubmit,signal,knownTools}:{requestBody?:string;beforeSubmit?:()=>void;signal?:AbortSignal;knownTools?:readonly TaskToolDefinition[]}={})=>createTaskGateway()({configuration,body:requestBody,apiKey:null,selfPort:4318,beforeSubmit,signal,knownTools});
  async function output(beforeSubmit?:()=>void,requestBody=body):Promise<TaskModelOutput>{let result:TaskModelOutput|undefined;
    for await(const item of stream({beforeSubmit,requestBody}))if(item.type==='done')result=item.output;
    assert.ok(result);return result;
  }
  return {configuration,body,requests,output,stream};
}
for(const protocol of ['chat_completions','responses','anthropic_messages'] as const){
  const argumentsJson=JSON.stringify({title:'Saved shot',_mio_step:'Create a saved test shot'});
  const frames=protocol==='chat_completions'?chatFrames({argumentsJson}):protocol==='responses'?responseFrames({argumentsJson}):nativeAnthropicSse(nativeAnthropicEvents({toolName:'mioon_shot_create',argumentsJson}));
  test(`${protocol}: trusted catalog accepts an unloaded tool without changing the frozen request`,async t=>{
    const f=await fixture(t,protocol,frames,[]);let result:TaskModelOutput|undefined;
    for await(const item of f.stream({knownTools:definitions}))if(item.type==='done')result=item.output;
    assert.ok(result);assert.ok(result.toolCalls.length>0);
    for(const call of result.toolCalls){assert.equal(call.name,'mioon_shot_create');assert.deepEqual(call.arguments,{title:'Saved shot'});}
    assert.equal(f.requests[0]!.rawBody,f.body);assert.equal(f.requests[0]!.body.tools,undefined);
    assert.ok(!f.requests[0]!.rawBody.includes('knownTools'));
  });
  test(`${protocol}: a tool in the request cannot extend a supplied host catalog`,async t=>{
    const f=await fixture(t,protocol,frames,definitions);
    await assert.rejects(async()=>{for await(const _item of f.stream({knownTools:[]})){/* Drain to validate the complete provider response. */}},(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code==='AGENT_CHAT_TOOLS_UNSUPPORTED');
  });
  test(`${protocol}: no trusted catalog preserves the original unloaded-name protocol error`,async t=>{
    const f=await fixture(t,protocol,frames,[]);
    await assert.rejects(async()=>{for await(const _item of f.stream()){/* The hidden name is absent from this frozen request. */}},(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code==='AGENT_CHAT_TOOLS_UNSUPPORTED');
  });
  test(`${protocol}: a legacy visible schema retains its original explanation handling with a trusted catalog`,async t=>{
    const f=await fixture(t,protocol,frames,definitions),legacy=JSON.parse(f.body) as {tools:Array<{function?:{parameters:unknown};parameters?:unknown;input_schema?:unknown}>};
    for(const tool of legacy.tools){if(protocol==='chat_completions')tool.function!.parameters=definitions[0]!.parameters;else if(protocol==='responses')tool.parameters=definitions[0]!.parameters;else tool.input_schema=definitions[0]!.parameters;}
    const requestBody=JSON.stringify(legacy);let result:TaskModelOutput|undefined;
    for await(const item of f.stream({requestBody,knownTools:definitions}))if(item.type==='done')result=item.output;
    assert.ok(result);for(const call of result.toolCalls)assert.deepEqual(call.arguments,{title:'Saved shot',_mio_step:'Create a saved test shot'});
    assert.equal(f.requests[0]!.rawBody,requestBody);
  });
  test(`${protocol}: name loading and short independent batch guidance are explicit normal-run options in each language`,()=>{
    const requiredRules={
      'zh-Hans':['按确切名称','互不依赖、参数短','前一调用结果或新 ID','下一次回复','参数长的调用单独一次回复','提问放在一次回复的最后'],
      'zh-Hant':['按確切名稱','互不依賴、參數短','前一呼叫結果或新 ID','下一次回覆','參數長的呼叫單獨一次回覆','提問放在一次回覆的最後'],
      en:['exact tool names','independent calls with short arguments','previous result or new ID','next response','long arguments its own response','Put a question last'],
      ja:['正確な名前','互いに依存せず引数が短い','前の結果や新しい ID','次の応答','引数が長い呼び出しは単独','質問は応答の最後'],
    };
    for(const locale of AGENT_TASK_LOCALES){
      const selected=presetConfigurations().find(item=>item.presetId===(protocol==='anthropic_messages'?'ollama':'openai')&&item.protocol===protocol)!;
      const configuration=protocol==='chat_completions'?{...selected,model:'gpt-5.4-mini'}:selected,history=[taskResponseLanguageContext(locale),{role:'user',content:'Synthetic request'}];
      const previous=JSON.parse(buildTaskModelRequest(configuration,history,definitions,4318)) as Record<string,unknown>;
      const normal=JSON.parse(buildTaskModelRequest(configuration,history,definitions,4318,{toolLoading:true})) as Record<string,unknown>;
      const instruction=(body:Record<string,unknown>)=>protocol==='chat_completions'?(body.messages as {content:string}[])[0]!.content:String(protocol==='responses'?body.instructions:body.system);
      assert.ok(!instruction(previous).includes('mioon_tools_load'));assert.ok(instruction(normal).startsWith(instruction(previous)+' '));assert.ok(instruction(normal).includes('mioon_tools_load'));
      for(const fragment of requiredRules[locale])assert.ok(instruction(normal).includes(fragment),`${protocol}/${locale}: ${fragment}`);
      const field=protocol==='chat_completions'?'messages':protocol==='responses'?'instructions':'system';
      const {...rest}=normal;if(field==='messages')rest.messages=(normal.messages as unknown[]).slice(1);else delete rest[field];
      const {...oldRest}=previous;if(field==='messages')oldRest.messages=(previous.messages as unknown[]).slice(1);else delete oldRest[field];
      if(protocol==='anthropic_messages'){
        assert.deepEqual(oldRest.tool_choice,{type:'auto',disable_parallel_tool_use:true});
        oldRest.tool_choice={type:'auto',disable_parallel_tool_use:false};
      }else{
        assert.equal(oldRest.parallel_tool_calls,false);oldRest.parallel_tool_calls=true;
      }
      assert.deepEqual(rest,oldRest);
      const loader={name:AGENT_TASK_TOOLS_LOAD_NAME,description:AGENT_TASK_TOOLS_LOAD_DESCRIPTIONS.en,parameters:AGENT_TASK_TOOLS_LOAD_PARAMETERS};
      const localized=JSON.parse(buildTaskModelRequest(configuration,history,[loader],4318,{toolLoading:true})) as {tools:Array<{description?:string;function?:{description:string}}>};
      assert.equal(protocol==='chat_completions'?localized.tools[0]!.function!.description:localized.tools[0]!.description,AGENT_TASK_TOOLS_LOAD_DESCRIPTIONS[locale]);
      assert.equal(loader.description,AGENT_TASK_TOOLS_LOAD_DESCRIPTIONS.en);
    }
  });
}
function syntheticNetwork({peer='8.8.8.8',authorized=true,status=200,body='',connectionError,endError,readError=false,holdOpen=false}: {peer?:string;authorized?:boolean;status?:number;body?:string;connectionError?:Error;endError?:Error;readError?:boolean;holdOpen?:boolean}={}){
  const state={calls:0,ends:0,destroyed:false};
  const requests:Array<{options:unknown;body?:string}>=[];
  const request=(options:unknown,callback:(incoming:unknown)=>void)=>{
    const selected:{options:unknown;body?:string}={options};requests.push(selected);
    state.calls++;
    const outgoing=Object.assign(new EventEmitter(),{setTimeout(){},destroy(){state.destroyed=true;},end(payload?:string){
      selected.body=payload;
      state.ends++;if(endError)throw endError;
      const source=readError?(async function*(){yield Buffer.from(body);throw Error('PRIVATE_STREAM_READ_FAILURE');})():[Buffer.from(body)];let pushed=false;
      const incoming=holdOpen?new Readable({read(){if(!pushed){pushed=true;this.push(Buffer.from(body));}}}):Readable.from(source);
      callback(Object.assign(incoming,{statusCode:status,headers:{'content-type':'text/event-stream'}}));
    }});
    queueMicrotask(()=>{
      if(connectionError){outgoing.emit('error',connectionError);return;}
      const socket=Object.assign(new EventEmitter(),{remoteAddress:peer,remotePort:443,authorized,destroy(){state.destroyed=true;}});
      outgoing.emit('socket',socket);socket.emit('secureConnect');
    });
    return outgoing;
  };
  return {...state,get calls(){return state.calls;},get ends(){return state.ends;},get destroyed(){return state.destroyed;},requests,request};
}

const crossPresetConfigurations:AgentConfiguration[]=[
  {presetId:'minimax',platformId:'china',protocol:'responses',model:'MiniMax-M3',baseUrl:'https://api.minimax.cn/v1'},
  {presetId:'zhipu',platformId:'china',protocol:'responses',model:'glm-4.7',baseUrl:'https://open.bigmodel.cn/api/v1'},
  {presetId:'minimax',platformId:'china',protocol:'anthropic_messages',model:'MiniMax-M3',baseUrl:'https://api.minimax.cn/anthropic'},
];
for(const configuration of crossPresetConfigurations)test(`${configuration.presetId}/${configuration.protocol}: selected protocol compiles once and survives exact SDK tool continuation`,async()=>{
  const argumentsJson=JSON.stringify({title:'Cross-protocol shot',_mio_step:'Create a saved test shot'}),body=buildTaskModelRequest(configuration,[{role:'user',content:'Only an offline protocol test'}],definitions),parsed=JSON.parse(body) as Record<string,unknown>;
  assert.equal(parsed.model,configuration.model);
  if(configuration.protocol==='anthropic_messages'){
    assert.equal(parsed.max_tokens,4096);assert.deepEqual(parsed.thinking,{type:'disabled'});assert.equal(Object.hasOwn(parsed,'parallel_tool_calls'),false);assert.equal(Object.hasOwn(parsed,'max_completion_tokens'),false);
  }else if(configuration.protocol==='responses'){
    assert.equal(parsed.max_output_tokens,4096);assert.deepEqual(parsed.reasoning,{effort:'none'});assert.equal(Object.hasOwn(parsed,'truncation'),false);assert.equal(Object.hasOwn(parsed,'thinking'),false);assert.equal(Object.hasOwn(parsed,'parallel_tool_calls'),false);
  }else{
    assert.equal(parsed.max_tokens,4096);assert.equal(Object.hasOwn(parsed,'max_completion_tokens'),false);assert.equal(Object.hasOwn(parsed,'thinking'),false);assert.equal(parsed.parallel_tool_calls,false);
  }
  const frames=configuration.protocol==='anthropic_messages'?nativeAnthropicSse(nativeAnthropicEvents({model:configuration.model,toolName:'mioon_shot_create',argumentsJson})):configuration.protocol==='responses'?responseFrames({argumentsJson}):chatFrames({argumentsJson});
  const records:Array<{options:unknown;body?:string}>=[];
  async function send(body:string,frames:string,status=200){
    const network=syntheticNetwork({body:frames,status});let output:TaskModelOutput|undefined;
    try{for await(const item of createTaskGateway({lookup:async()=>[{address:'8.8.8.8',family:4}],httpsRequest:network.request} as unknown as AgentTransportDependencies)({configuration,body,apiKey:'SYNTHETIC_CROSS_PROTOCOL_ONLY'}))if(item.type==='done')output=item.output;}
    finally{assert.equal(network.calls,1);assert.equal(network.ends,1);records.push(...network.requests);assert.equal(network.requests[0]!.body,body);}
    assert.ok(output);return output;
  }
  const first=await send(body,frames);assert.equal(first.toolCalls.length,configuration.protocol==='anthropic_messages'?1:2);
  for(const call of first.toolCalls){assert.deepEqual(call.arguments,{title:'Cross-protocol shot'});assert.equal(taskToolExplanation(first,call.id),'Create a saved test shot');}
  const next=buildTaskModelRequest(configuration,[{role:'user',content:'Only an offline protocol test'},...taskContinuation(configuration.protocol,first,first.toolCalls.map(call=>({callId:call.id,result:{saved:true}})))],definitions),last=await send(next,textFrames(configuration.protocol,'Cross-protocol complete'));
  assert.equal(last.text,'Cross-protocol complete');assert.equal(records.length,2);
  const suffix=configuration.protocol==='anthropic_messages'?'/v1/messages':configuration.protocol==='responses'?'/responses':'/chat/completions';
  for(const record of records){const options=record.options as {path:string;headers:Record<string,string>};assert.equal(options.path,new URL(configuration.baseUrl).pathname.replace(/\/$/u,'')+suffix);assert.equal(options.headers['x-api-key'],configuration.protocol==='anthropic_messages'?'SYNTHETIC_CROSS_PROTOCOL_ONLY':undefined);assert.equal(options.headers.Authorization,configuration.protocol==='anthropic_messages'?undefined:'Bearer SYNTHETIC_CROSS_PROTOCOL_ONLY');}
  await assert.rejects(send(body,'',503),{code:'AGENT_CHAT_HTTP_ERROR'});assert.equal(records.length,3,'HTTP failure never switches protocol, model or template and never retries');
  const historical=JSON.parse(body) as Record<string,unknown>;
  if(configuration.protocol==='responses'){historical.instructions='Frozen original task instruction';historical.max_output_tokens=3072;}
  else if(configuration.protocol==='anthropic_messages'){historical.system='Frozen original task instruction';historical.max_tokens=3072;}
  else{(historical.messages as {content:string}[])[0]!.content='Frozen original task instruction';historical.max_tokens=3072;}
  const frozenBody=JSON.stringify(historical);await send(frozenBody,frames);assert.equal(records.at(-1)!.body,frozenBody,'reading an old intent never recompiles it with the current template');
});
test('blocked official Anthropic compatibility protocol fails before DNS or request construction',async()=>{
  const configuration:AgentConfiguration={presetId:'anthropic',platformId:'global',protocol:'chat_completions',model:'claude-haiku-4-5',baseUrl:'https://api.anthropic.com/v1'};
  assert.throws(()=>buildTaskModelRequest(configuration,[],definitions),{code:'AGENT_CHAT_PROFILE_UNSUPPORTED'});
  let lookups=0;const network=syntheticNetwork({body:chatFrames()});
  const gateway=createTaskGateway({lookup:async()=>{lookups++;return [{address:'8.8.8.8',family:4}];},httpsRequest:network.request} as unknown as AgentTransportDependencies);
  await assert.rejects(async()=>{for await(const _item of gateway({configuration,body:'{}',apiKey:'SYNTHETIC_BLOCKED_ONLY'})){}},{code:'AGENT_SETTINGS_VALIDATION'});
  assert.equal(lookups,0);assert.equal(network.calls,0);assert.equal(network.ends,0);
});
test('Ollama Messages uses its explicitly selected loopback root and keyless SDK tools without leaking a placeholder',async t=>{
  const first=nativeAnthropicSse(nativeAnthropicEvents({model:'qwen3:8b',toolName:'mioon_shot_create',argumentsJson:'{"title":"Local native shot","_mio_step":"Create a local test shot"}'}));
  const f=await fixture(t,'anthropic_messages',(response,index)=>response.end(index===1?first:textFrames('anthropic_messages','Local Messages complete'))),planned=await f.output();
  assert.equal(planned.toolCalls.length,1);assert.deepEqual(planned.toolCalls[0]!.arguments,{title:'Local native shot'});assert.equal(taskToolExplanation(planned,planned.toolCalls[0]!.id),'Create a local test shot');
  const next=buildTaskModelRequest(f.configuration,[{role:'user',content:'创建两个镜头'},...taskContinuation('anthropic_messages',planned,[{callId:planned.toolCalls[0]!.id,result:{saved:true}}])],definitions,4318),done=await f.output(undefined,next);
  assert.equal(done.text,'Local Messages complete');assert.equal(f.requests.length,2);assert.equal(new URL(f.configuration.baseUrl).pathname,'/');
  for(const request of f.requests){assert.equal(request.path,'/v1/messages');assert.equal(request.authorization,undefined);assert.equal(request.apiKeyHeader,undefined);assert.equal(request.versionHeader,'2023-06-01');assert.equal(request.method,'POST');}
  assert.equal(f.requests[0]!.rawBody,f.body);assert.equal(f.requests[1]!.rawBody,next);
});
const miniMaxChina:AgentConfiguration={presetId:'minimax',platformId:'china',protocol:'chat_completions',model:'MiniMax-M3',baseUrl:'https://api.minimax.cn/v1'};
test('natural EOF belongs only to the exact official MiniMax M3 non-thinking request profile',()=>{
  const body=JSON.parse(buildTaskModelRequest(miniMaxChina,[],definitions)) as Record<string,unknown>;
  assert.equal(agentChatAllowsNaturalEof(miniMaxChina,body),true);
  assert.equal(agentChatAllowsNaturalEof({...miniMaxChina,platformId:'international',baseUrl:'https://api.minimax.io/v1'},body),true);
  for(const configuration of [
    {...miniMaxChina,presetId:'custom',platformId:'custom'}, {...miniMaxChina,model:'MiniMax-M3.1-Flash'},
    {...miniMaxChina,baseUrl:'https://gateway.example.com/v1'}, {...miniMaxChina,baseUrl:'https://api.minimax.io/v1'},
    {...miniMaxChina,protocol:'responses' as const}, {...miniMaxChina,platformId:'international'},
  ])assert.equal(agentChatAllowsNaturalEof(configuration,body),false);
  for(const changed of [{...body,model:'other'},{...body,stream:false},{...body,thinking:undefined},{...body,thinking:{type:'adaptive'}},{...body,thinking:{type:'disabled',extra:true}}])assert.equal(agentChatAllowsNaturalEof(miniMaxChina,changed),false);
});
test('official MiniMax natural EOF accepts complete text and tools through the actual SDK while retaining every rejection boundary',async()=>{
  async function exchange(configuration:AgentConfiguration,frames:string,{readError=false,abortAfterDelta=false,timeout=false,bodyChange}:{readError?:boolean;abortAfterDelta?:boolean;timeout?:boolean;bodyChange?:(body:Record<string,unknown>)=>void}={}){
    const network=syntheticNetwork({body:frames,readError,holdOpen:timeout}),dependencies={lookup:async()=>[{address:'8.8.8.8',family:4}],httpsRequest:network.request,...(timeout?{limits:{totalTimeoutMs:30}}:{})} as unknown as AgentTransportDependencies;
    const parsed=JSON.parse(buildTaskModelRequest(configuration,[{role:'user',content:'synthetic EOF fixture'}],definitions)) as Record<string,unknown>;bodyChange?.(parsed);
    const items:unknown[]=[],controller=new AbortController();let failure:unknown;
    try{for await(const item of createTaskGateway(dependencies)({configuration,body:JSON.stringify(parsed),apiKey:'SYNTHETIC_ONLY',signal:controller.signal})){items.push(item);if(item.type==='delta'&&abortAfterDelta)controller.abort();}}catch(error){failure=error;}
    assert.equal(network.calls,1);assert.equal(network.ends,1);return {items,failure};
  }
  const text=textFrames('chat_completions','complete').replace('data: [DONE]\n\n',''),tools=chatFrames().replace('data: [DONE]\n\n','');
  for(const configuration of [miniMaxChina,{...miniMaxChina,platformId:'international',baseUrl:'https://api.minimax.io/v1'}]){
    for(const frames of [text,tools]){const result=await exchange(configuration,frames);assert.equal(result.failure,undefined);const terminal=result.items.at(-1) as {type:string;output:TaskModelOutput};assert.equal(terminal.type,'done');assert.equal(terminal.output.toolCalls.length,frames===tools?2:0);}
  }
  for(const configuration of [{...legacyOpenAiChat},{...miniMaxChina,presetId:'custom',platformId:'custom'},{...miniMaxChina,model:'synthetic-unverified-model'}]){
    const result=await exchange(configuration,tools);assert.equal(safeAgentChatError(result.failure).code,'AGENT_CHAT_TRUNCATED');assert.equal(result.items.some(item=>(item as {type:string}).type==='done'),false);
  }
  for(const baseUrl of ['https://gateway.example.com/v1','https://api.minimax.io/v1'])assert.throws(()=>buildTaskModelRequest({...miniMaxChina,baseUrl},[],definitions),{code:'AGENT_CHAT_VALIDATION'});
  for(const bodyChange of [(body:Record<string,unknown>)=>{body.model='other';},(body:Record<string,unknown>)=>{delete body.thinking;}]){
    const result=await exchange(miniMaxChina,tools,{bodyChange});assert.equal(safeAgentChatError(result.failure).code,'AGENT_CHAT_TRUNCATED');
  }
  const prefix=tools.slice(0,tools.indexOf(json({choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})));
  for(const [frames,expected,options] of [
    [prefix,'AGENT_CHAT_TRUNCATED',{}], [tools+'data: [DONE]','AGENT_CHAT_TRUNCATED',{}],
    [text.replace('"stop"','"length"'),'AGENT_CHAT_TRUNCATED',{}], [text.replace('"stop"','"content_filter"'),'AGENT_CHAT_TRUNCATED',{}],
    [tools.replace('"tool_calls"}]','"stop"}]'),'AGENT_CHAT_PROTOCOL_ERROR',{}],
    [tools.replaceAll('mioon_shot_create','unlisted_tool'),'AGENT_CHAT_TOOLS_UNSUPPORTED',{}],
    [tools.replaceAll('call|1','call|0'),'AGENT_CHAT_PROTOCOL_ERROR',{}],
    [tools.replace('"index":1,"id":"call|1"','"index":2,"id":"call|1"'),'AGENT_CHAT_PROTOCOL_ERROR',{}],
    [chatFrames({argumentsJson:'{"title":'}).replace('data: [DONE]\n\n',''),'AGENT_CHAT_PROTOCOL_ERROR',{}],
    [text.replace('"content":"complete"','"content":"complete","refusal":"blocked"'),'AGENT_CHAT_PROVIDER_ERROR',{}],
    [text+json({choices:[{index:0,delta:{},finish_reason:'stop'}]}),'AGENT_CHAT_PROTOCOL_ERROR',{}],
    [text+'event: error\ndata: {"choices":[]}\n\n','AGENT_CHAT_PROVIDER_ERROR',{}],
    [text+'event: unexpected\ndata: {"choices":[]}\n\n','AGENT_CHAT_PROTOCOL_ERROR',{}],
    [text+json({error:{message:'PRIVATE_ERROR'}}),'AGENT_CHAT_PROVIDER_ERROR',{}],
    [text,'AGENT_CHAT_TRUNCATED',{readError:true}], [text,'AGENT_CHAT_ABORTED',{abortAfterDelta:true}], [text,'AGENT_CHAT_TIMEOUT',{timeout:true}],
  ] as const){const result=await exchange(miniMaxChina,frames,options);assert.equal(safeAgentChatError(result.failure).code,expected);assert.equal(result.items.some(item=>(item as {type:string}).type==='done'),false);}
});
function syntheticOutput(protocol:AgentConfiguration['protocol'],network:ReturnType<typeof syntheticNetwork>,{answers=[{address:'8.8.8.8',family:4}],lookupError,beforeSubmit}: {answers?:Array<{address:string;family:number}>;lookupError?:Error;beforeSubmit?:()=>void}={}){
  const configuration={...legacyOpenAiChat,protocol},body=buildTaskModelRequest(configuration,[{role:'user',content:'synthetic local test'}],definitions,4318);
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
for(const protocol of ['chat_completions','responses'] as const){
  test(`${protocol}: Mio caption metadata is model-only, optional and follows the initiating language`,()=>{
    const original=structuredClone(definitions),expected={'zh-Hans':'简短说明','zh-Hant':'簡短說明',en:'short _mio_step explanation',ja:'短い説明'};
    for(const locale of AGENT_TASK_LOCALES){
      const body=JSON.parse(buildTaskModelRequest({...legacyOpenAiChat,protocol},[taskResponseLanguageContext(locale),{role:'user',content:'Synthetic'}],definitions,4318)) as {instructions?:string;messages?:{content:string}[];tools:{function?:{parameters:Record<string,unknown>};parameters?:Record<string,unknown>}[]};
      const tool=protocol==='responses'?body.tools[0]!:body.tools[0]!.function!,parameters=tool.parameters!,properties=parameters.properties as Record<string,unknown>;
      assert.deepEqual(properties._mio_step,{type:'string',minLength:1,maxLength:40,description:(properties._mio_step as {description:string}).description});
      assert.match(String((properties._mio_step as {description:string}).description),new RegExp(expected[locale]));
      assert.match(body.instructions??body.messages![0]!.content,new RegExp(expected[locale]));
      assert.deepEqual(parameters.required,['title']);assert.equal(parameters.additionalProperties,false);
      assert.deepEqual({...parameters,properties:{title:properties.title}},definitions[0]!.parameters);
    }
    assert.deepEqual(definitions,original,'shared domain definitions are never mutated');
    assert.throws(()=>buildTaskModelRequest({...legacyOpenAiChat,protocol},[],[{...definitions[0]!,parameters:{type:'object',properties:{_mio_step:{type:'string'}}}}],4318),{code:'AGENT_CHAT_PROFILE_UNSUPPORTED'},'future domain-field collisions fail closed');
  });
  test(`${protocol}: caption is stripped before business dispatch while raw tool arguments survive both HTTP rounds`,async t=>{
    const argumentsJson=JSON.stringify({title:'Caption round trip',_mio_step:'镜头加入时间线 🙂'}),frames=protocol==='responses'?responseFrames({argumentsJson}):chatFrames({argumentsJson});
    const f=await fixture(t,protocol,(res,index)=>res.end(index===1?frames:textFrames(protocol,'Synthetic caption continuation'))),first=await f.output();
    for(const call of first.toolCalls){assert.deepEqual(call.arguments,{title:'Caption round trip'});assert.equal(taskToolExplanation(first,call.id),'镜头加入时间线 🙂');}
    const retained=structuredClone(first.providerOutput),results=first.toolCalls.map(call=>({callId:call.id,result:{success:true}})),continuation=taskContinuation(protocol,first,results);
    assert.equal(JSON.stringify(continuation).includes('_mio_step'),true,'provider calls retain the exact original arguments for protocol continuation');
    const nextBody=buildTaskModelRequest(f.configuration,[{role:'user',content:'Synthetic'},...continuation],definitions,4318),second=await f.output(undefined,nextBody);
    assert.equal(second.text,'Synthetic caption continuation');assert.deepEqual(first.providerOutput,retained);
    assert.equal(f.requests.length,2);assert.deepEqual(f.requests[1]!.body,JSON.parse(nextBody));
  });
  test(`${protocol}: invalid caption is discarded without dropping host-shaped fields from business arguments`,async t=>{
    for(const _mio_step of ['unsafe\ncaption',{approved:true}]){
      const argumentsJson=JSON.stringify({title:'Domain still validates',approved:true,patch:{requestId:'forged'},_mio_step}),f=await fixture(t,protocol,protocol==='responses'?responseFrames({argumentsJson}):chatFrames({argumentsJson})),output=await f.output();
      for(const call of output.toolCalls){assert.deepEqual(call.arguments,{title:'Domain still validates',approved:true,patch:{requestId:'forged'}});assert.equal(taskToolExplanation(output,call.id),undefined);}
    }
  });
  test(`${protocol}: an old journaled intent without caption schema is submitted unchanged and does not strip unknown arguments`,async t=>{
    const argumentsJson=JSON.stringify({title:'Legacy',_mio_step:'Unknown legacy field'}),f=await fixture(t,protocol,protocol==='responses'?responseFrames({argumentsJson}):chatFrames({argumentsJson}));
    const saved=JSON.parse(f.body) as {tools:{function?:{parameters:{properties:Record<string,unknown>}};parameters?:{properties:Record<string,unknown>}}[];instructions?:string;messages?:{content:string}[]};
    for(const entry of saved.tools)delete (protocol==='responses'?entry.parameters!:entry.function!.parameters).properties._mio_step;
    if(protocol==='responses')saved.instructions='Frozen legacy root instruction';else saved.messages![0]!.content='Frozen legacy root instruction';
    const body=JSON.stringify(saved),output=await f.output(undefined,body);
    assert.equal(f.requests[0]!.rawBody,body);assert.deepEqual(f.requests[0]!.body,JSON.parse(body));
    for(const call of output.toolCalls){assert.deepEqual(call.arguments,{title:'Legacy',_mio_step:'Unknown legacy field'});assert.equal(taskToolExplanation(output,call.id),undefined);}
  });
}
test('Mio captions allow forty Unicode characters and safely fall back for malformed or mismatched provider evidence',()=>{
  function output(value:unknown):TaskModelOutput{
    return {text:'',toolCalls:[{id:'caption_call',name:'mioon_shot_create',arguments:{title:'Business value'}}],providerOutput:{role:'assistant',content:null,tool_calls:[{id:'caption_call',type:'function',function:{name:'mioon_shot_create',arguments:JSON.stringify({title:'Business value',_mio_step:value})}}]}};
  }
  for(const value of ['简短说明','Short explanation','Clarify the editing intent','短い説明','🙂'.repeat(40)])assert.equal(taskToolExplanation(output(value),'caption_call'),value);
  for(const value of [undefined,null,0,true,[],{},'','  ','x'.repeat(41),'🙂'.repeat(41),'line\nline','line\rline','x\t','x\u0000','x\u0085','x\u2028','x\u2029','x\u202e','x\ud800','<b>caption</b>','`code`','Call mioon_shot_create','mioon_timeline_clip_update','requestId: hidden','intent','dispatch_started','completed','failed','unknown','denied','rejected','{"duration":4}','[1,2]','11111111-1111-4111-8111-111111111111'])assert.equal(taskToolExplanation(output(value),'caption_call'),undefined,JSON.stringify(value));
  const mismatch=output('Must not appear');mismatch.toolCalls[0]!.arguments={title:'Different business value'};assert.equal(taskToolExplanation(mismatch,'caption_call'),undefined);
  const duplicate=output('Must not appear');duplicate.toolCalls.push({...duplicate.toolCalls[0]!});assert.equal(taskToolExplanation(duplicate,'caption_call'),undefined);
  assert.equal(taskToolExplanation(output('Must not appear'),'missing_call'),undefined);
  const forged=output('Must not appear'),provider=forged.providerOutput as {tool_calls:{function:{arguments:string}}[]};provider.tool_calls[0]!.function.arguments='{"title":"Business value","_mio_step":"first","_mio_step":"second"}';assert.equal(taskToolExplanation(forged,'caption_call'),undefined);
  const alternate=output(undefined);alternate.providerOutput=[{type:'function_call',call_id:'caption_call',name:'mioon_shot_create',arguments:'{"title":"Business value"}',function:{name:'mioon_shot_create',arguments:'{"title":"Business value","_mio_step":"Unrelated nested caption"}'}}];assert.equal(taskToolExplanation(alternate,'caption_call'),undefined,'Responses cannot substitute a nested Chat Completions function object');
});
test('actual domain preparation still rejects authority and invalid business fields after the gateway strips only its caption',async t=>{
  const root=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-mio-tool-caption-')),store=openStore(root),services=createServices(store,new Map()),tools=createAgentTaskTools({store,services});
  t.after(async()=>{tools.dispose();await services.drain();store.close();await rm(root,{recursive:true,force:true});});
  const project=await services.call('project.create',{name:'Synthetic caption validation'});assert.ok(project&&typeof project==='object'&&!Array.isArray(project)&&'id' in project&&typeof project.id==='string');
  const projectId=project.id;
  assert.equal(schemas['shot.create'].safeParse({projectId,title:'Public caller',_mio_step:'Not a public input'}).success,false);
  for(const protocol of ['chat_completions','responses'] as const){
    for(const [input,expected] of [
      [{title:'No authority',approved:true},'AGENT_TASK_INVALID_TOOL'],
      [{title:'No authority',permission:'paid',requestId:'forged'},'AGENT_TASK_INVALID_TOOL'],
      [{title:'No authority',nested:{projectId}},'AGENT_TASK_INVALID_TOOL'],
      [{title:42},'VALIDATION_ERROR'],
    ] as const){
      const argumentsJson=JSON.stringify({...input,_mio_step:'A caption grants no permission'}),f=await fixture(t,protocol,protocol==='responses'?responseFrames({argumentsJson}):chatFrames({argumentsJson})),output=await f.output();
      for(const call of output.toolCalls){assert.deepEqual(call.arguments,input);assert.throws(()=>tools.prepare({projectId,operation:call.name,input:call.arguments}),{code:expected});}
    }
    const argumentsJson=JSON.stringify({title:'Valid business request',_mio_step:'x'.repeat(41)}),f=await fixture(t,protocol,protocol==='responses'?responseFrames({argumentsJson}):chatFrames({argumentsJson})),output=await f.output();
    const call=output.toolCalls[0]!;assert.equal(taskToolExplanation(output,call.id),undefined);assert.equal(tools.prepare({projectId,operation:call.name,input:call.arguments}).operation,'shot.create');
  }
  assert.deepEqual(store.list('shots',projectId),[]);assert.deepEqual(store.list('jobs',projectId),[]);
});
function removeCaptionSchema(value:unknown):unknown{
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const schema=value as Record<string,unknown>,copy={...schema};
  if(schema.properties&&typeof schema.properties==='object'&&!Array.isArray(schema.properties))copy.properties=Object.fromEntries(Object.entries(schema.properties).filter(([key])=>key!=='_mio_step'));
  for(const key of ['anyOf','oneOf','allOf'])if(Array.isArray(schema[key]))copy[key]=schema[key].map(removeCaptionSchema);
  return copy;
}
test('the complete production tool catalog builds in every supported preset/protocol while preserving every business branch',async t=>{
  const root=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-mio-complete-wire-')),store=openStore(root),services=createServices(store,new Map()),tools=createAgentTaskTools({store,services});
  t.after(async()=>{tools.dispose();await services.drain();store.close();await rm(root,{recursive:true,force:true});});
  const catalog=tools.list(),original=structuredClone(catalog);assert.ok(catalog.some(tool=>tool.operation==='image.generate'));assert.ok(catalog.length>80);
  const catalogByName=new Map(catalog.map(tool=>[tool.name,tool])),catalogNames=catalog.map(tool=>tool.name);
  let combinations=0;const compiled=new Set<string>();
  for(const selected of presetConfigurations()){
    if(selected.presetId==='openai'&&selected.protocol==='chat_completions')assert.throws(()=>buildTaskModelRequest(selected,[{role:'user',content:'Complete production catalog only'}],catalog,4318),{code:'AGENT_CHAT_RESPONSES_REQUIRED'});
    const configuration=selected.presetId==='openai'&&selected.protocol==='chat_completions'?{...selected,model:'gpt-6-luna'}:selected;
    const {presetId,platformId,protocol}=configuration;
    const body=JSON.parse(buildTaskModelRequest(configuration,[{role:'user',content:'Complete production catalog only'}],catalog,4318)) as {tools:{name?:string;parameters?:unknown;input_schema?:unknown;function?:{name:string;parameters:unknown}}[]};
    assert.equal(body.tools.length,catalog.length);combinations++;compiled.add(`${presetId}/${platformId}/${protocol}`);
    const names=body.tools.map(item=>protocol==='chat_completions'?item.function!.name:item.name);
    assert.equal(new Set(names).size,catalog.length);assert.deepEqual([...names].sort(),[...catalogNames].sort());
    // Official Anthropic groups the wire tools to preserve cache prefixes;
    // every other preset/protocol retains the original catalog order.
    if(!(presetId==='anthropic'&&protocol==='anthropic_messages'&&configuration.baseUrl==='https://api.anthropic.com'))assert.deepEqual(names,catalogNames);
    for(const item of body.tools){
      const definition=protocol==='chat_completions'?item.function!:item;assert.ok(typeof definition.name==='string');
      const tool=catalogByName.get(definition.name);assert.ok(tool);
      assert.deepEqual(removeCaptionSchema(protocol==='anthropic_messages'?item.input_schema:definition.parameters),taskToolWireSchema(configuration,tool.name,tool.parameters),`${presetId}/${platformId}/${protocol}/${tool.operation}`);
    }
  }
  for(const combination of ['minimax/china/anthropic_messages','minimax/china/responses','anthropic/global/anthropic_messages','ollama/local/anthropic_messages'])assert.ok(compiled.has(combination),combination);
  assert.equal(combinations,51);assert.deepEqual(catalog,original,'no public/domain tool schema is changed, including image.generate anyOf');
});
for(const protocol of ['chat_completions','responses'] as const){
  test(`${protocol}: complete catalog image.generate union captions survive a real local two-round tool exchange`,async t=>{
    const root=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-mio-complete-roundtrip-')),store=openStore(root),services=createServices(store,new Map()),tools=createAgentTaskTools({store,services});
    t.after(async()=>{tools.dispose();await services.drain();store.close();await rm(root,{recursive:true,force:true});});
    const input={name:'Synthetic union image',providerId:'mock',model:'synthetic-image',prompt:'A simple local image',options:{size:'1024x1024',quality:'low',outputFormat:'png',background:'opaque',n:1}},argumentsJson=JSON.stringify({...input,_mio_step:'Create a preview image'}),frames=(protocol==='responses'?responseFrames({argumentsJson}):chatFrames({argumentsJson})).replaceAll('mioon_shot_create','mioon_image_generate');
    const catalog=tools.list(),f=await fixture(t,protocol,(res,index)=>res.end(index===1?frames:textFrames(protocol,'Complete union tool exchange')),catalog),first=await f.output();
    for(const call of first.toolCalls){assert.equal(call.name,'mioon_image_generate');assert.deepEqual(call.arguments,input);assert.equal(taskToolExplanation(first,call.id),'Create a preview image');}
    const nextBody=buildTaskModelRequest(f.configuration,[{role:'user',content:'Synthetic'},...taskContinuation(protocol,first,first.toolCalls.map(call=>({callId:call.id,result:{fixtureOnly:true}})))],catalog,4318),last=await f.output(undefined,nextBody);
    assert.equal(last.text,'Complete union tool exchange');assert.equal(f.requests.length,2);
    for(const request of f.requests)assert.equal((request.body.tools as unknown[]).length,catalog.length);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM jobs').get()?.n,0);assert.equal(store.db.prepare('SELECT count(*) AS n FROM image_tasks').get()?.n,0,'no image or video generation is submitted by this protocol-only fixture');
  });
  test(`${protocol}: DeepSeek full-catalog union captions round trip through the injected guarded SDK transport`,async t=>{
    const root=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-mio-deepseek-roundtrip-')),store=openStore(root),services=createServices(store,new Map()),tools=createAgentTaskTools({store,services});
    t.after(async()=>{tools.dispose();await services.drain();store.close();await rm(root,{recursive:true,force:true});});
    const configuration:AgentConfiguration={presetId:'deepseek',platformId:'global',baseUrl:'https://api.deepseek.com',model:'deepseek-flash',protocol},catalog=tools.list(),argumentsJson=JSON.stringify({name:'Synthetic image',providerId:'mock',model:'synthetic-image',prompt:'Only a protocol fixture',options:{size:'1024x1024',quality:'low',outputFormat:'png',background:'opaque',n:1},_mio_step:'Create a preview image'}),frames=(protocol==='responses'?responseFrames({argumentsJson}):chatFrames({argumentsJson})).replaceAll('mioon_shot_create','mioon_image_generate');
    async function send(body:string,frames:string){
      const network=syntheticNetwork({body:frames}),dependencies={lookup:async()=>[{address:'8.8.8.8',family:4}],httpsRequest:network.request} as unknown as AgentTransportDependencies;let output:TaskModelOutput|undefined;
      for await(const item of createTaskGateway(dependencies)({configuration,body,apiKey:'SYNTHETIC_COMPLETE_CATALOG_ONLY',selfPort:4318}))if(item.type==='done')output=item.output;
      assert.ok(output);assert.equal(network.calls,1);assert.equal(network.ends,1);return output;
    }
    const body=buildTaskModelRequest(configuration,[{role:'user',content:'Synthetic complete catalog'}],catalog,4318),first=await send(body,frames);
    for(const call of first.toolCalls){assert.equal(call.name,'mioon_image_generate');assert.equal(Object.hasOwn(call.arguments as object,'_mio_step'),false);assert.equal(taskToolExplanation(first,call.id),'Create a preview image');}
    const nextBody=buildTaskModelRequest(configuration,[{role:'user',content:'Synthetic complete catalog'},...taskContinuation(protocol,first,first.toolCalls.map(call=>({callId:call.id,result:{fixtureOnly:true}})))],catalog,4318),last=await send(nextBody,textFrames(protocol,'DeepSeek union exchange complete'));
    assert.equal(last.text,'DeepSeek union exchange complete');assert.deepEqual(last.toolCalls,[]);
  });
}
test('model captions preserve strict composed object schemas and refuse unrecognized constraint branches',()=>{
  const leaf=definitions[0]!.parameters;
  for(const composition of ['anyOf','oneOf','allOf']){
    const parameters={type:'object',[composition]:[leaf,{...leaf,properties:{title:{type:'string',minLength:2}}}]},body=JSON.parse(buildTaskModelRequest(legacyOpenAiChat,[],[{...definitions[0]!,parameters}],4318)) as {tools:{function:{parameters:unknown}}[]};
    assert.deepEqual(removeCaptionSchema(body.tools[0]!.function.parameters),parameters,composition);
    for(const branch of [false,{required:['title']},{type:'object',properties:{_mio_step:{type:'string'}}}])assert.throws(()=>buildTaskModelRequest(legacyOpenAiChat,[],[{...definitions[0]!,parameters:{type:'object',[composition]:[leaf,branch]}}],4318),{code:'AGENT_CHAT_PROFILE_UNSUPPORTED'});
  }
  for(const key of ['not','if','$ref','unevaluatedProperties','dependentSchemas'])assert.throws(()=>buildTaskModelRequest(legacyOpenAiChat,[],[{...definitions[0]!,parameters:{...leaf,[key]:{}}}],4318),{code:'AGENT_CHAT_PROFILE_UNSUPPORTED'});
});

const q11OpenAi=(model='gpt-4.1-mini'):AgentConfiguration=>({presetId:'openai',platformId:'global',protocol:'responses',model,baseUrl:'https://api.openai.com/v1'});
/** Actual Responses envelope fields are retained, including the request echo.
 * Only TLS/network responses are controlled; no model request leaves the test. */
function q11ResponseEvents(body:string,{reasoning=false,phase,phaseOnDone=false,toolCall=false,visibleText='Offline Responses text 🙂',encryptedContent='SYNTHETIC_OPAQUE_REASONING',toolCalls,argumentTitle='Offline saved shot'}:{reasoning?:boolean;phase?:string|null;phaseOnDone?:boolean;toolCall?:boolean;visibleText?:string;encryptedContent?:string;toolCalls?:number;argumentTitle?:string}={}):Array<Record<string,unknown>>{
  const request=JSON.parse(body) as Record<string,unknown>,id='resp_q11_offline',text=visibleText;
  const part={type:'output_text',text,annotations:[],logprobs:[]};
  const item={id:'msg_q11_offline',type:'message',role:'assistant',status:'completed',content:[part],...(phase===undefined?{}:{phase})};
  const response=(status:string,output:unknown[])=>({id,object:'response',created_at:1762732800,status,error:null,incomplete_details:null,
    instructions:request.instructions,max_output_tokens:request.max_output_tokens,model:request.model,output,parallel_tool_calls:request.parallel_tool_calls??true,
    previous_response_id:null,reasoning:{effort:null,summary:null},store:false,temperature:1,text:{format:{type:'text'}},tool_choice:request.tool_choice??'auto',tools:request.tools??[],top_p:1,truncation:'disabled',usage:null,metadata:{}});
  const events:Array<Record<string,unknown>>=[{type:'response.created',response:response('in_progress',[])},{type:'response.in_progress',response:response('in_progress',[])}];
  const summary={type:'summary_text',text:'SYNTHETIC_PRIVATE_REASONING_SUMMARY'};
  const reasoningItem={id:'rs_q11_offline',type:'reasoning',summary:[summary],encrypted_content:encryptedContent};
  if(reasoning)events.push({type:'response.output_item.added',output_index:0,item:{id:reasoningItem.id,type:'reasoning',summary:[]}},
    {type:'response.reasoning_summary_part.added',output_index:0,item_id:reasoningItem.id,summary_index:0,part:{...summary,text:''}},
    {type:'response.reasoning_summary_text.delta',output_index:0,item_id:reasoningItem.id,summary_index:0,delta:summary.text},
    {type:'response.reasoning_summary_text.done',output_index:0,item_id:reasoningItem.id,summary_index:0,text:summary.text},
    {type:'response.reasoning_summary_part.done',output_index:0,item_id:reasoningItem.id,summary_index:0,part:summary},
    {type:'response.output_item.done',output_index:0,item:reasoningItem});
  const index=reasoning?1:0,added={...item,status:'in_progress',content:[]};
  if(phaseOnDone)delete added.phase;
  events.push({type:'response.output_item.added',output_index:index,item:added},
    {type:'response.content_part.added',output_index:index,item_id:item.id,content_index:0,part:{...part,text:''}});
  for(let offset=0;offset<text.length;offset+=8192)events.push({type:'response.output_text.delta',output_index:index,item_id:item.id,content_index:0,delta:text.slice(offset,offset+8192),logprobs:[],obfuscation:'synthetic-padding'});
  events.push({type:'response.output_text.done',output_index:index,item_id:item.id,content_index:0,text,logprobs:[]},
    {type:'response.content_part.done',output_index:index,item_id:item.id,content_index:0,part},
    {type:'response.output_item.done',output_index:index,item});
  const output:unknown[]=reasoning?[reasoningItem,item]:[item];
  for(let ordinal=0;ordinal<(toolCalls??(toolCall?1:0));ordinal++){
    const suffix=ordinal===0?'':`_${ordinal}`,position=index+1+ordinal;
    const call={id:`fc_q11_offline${suffix}`,type:'function_call',call_id:`call_q11_offline${suffix}`,name:'mioon_shot_create',arguments:JSON.stringify({title:argumentTitle,_mio_step:'Create one offline test shot'}),status:'completed'};
    events.push({type:'response.output_item.added',output_index:position,item:{...call,arguments:'',status:'in_progress'}});
    for(let offset=0;offset<call.arguments.length;offset+=2048)events.push({type:'response.function_call_arguments.delta',output_index:position,item_id:call.id,delta:call.arguments.slice(offset,offset+2048)});
    events.push({type:'response.function_call_arguments.done',output_index:position,item_id:call.id,name:call.name,arguments:call.arguments},
      {type:'response.output_item.done',output_index:position,item:call});
    output.push(call);
  }
  events.push({type:'response.completed',response:response('completed',output)});
  return events.map((event,sequence_number)=>({...event,sequence_number}));
}
const q11ResponseWire=(events:readonly Record<string,unknown>[]):string=>events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
function q11Stream(configuration:AgentConfiguration,body:string,wire:string){
  const network=syntheticNetwork({body:wire}),dependencies={lookup:async()=>[{address:'8.8.8.8',family:4}],httpsRequest:network.request} as unknown as AgentTransportDependencies;
  return {network,stream:createTaskGateway(dependencies)({configuration,body,apiKey:'SYNTHETIC_Q11_OFFLINE_ONLY',selfPort:4318})};
}

test('official-shaped OpenAI Responses text preserves event names, sequence fields and request echoes',async()=>{
  for(const phase of [undefined,null]){
    const configuration=q11OpenAi(),body=buildTaskModelRequest(configuration,[{role:'user',content:'Offline text only'}],[],4318),events=q11ResponseEvents(body,{phase});
    const f=q11Stream(configuration,body,q11ResponseWire(events));let output:TaskModelOutput|undefined;
    for await(const event of f.stream)if(event.type==='done')output=event.output;
    assert.ok(output);assert.equal(output.text,'Offline Responses text 🙂');assert.deepEqual(output.toolCalls,[]);
    assert.equal(f.network.calls,1);assert.equal(f.network.ends,1);assert.equal(f.network.requests[0]!.body,body);
    const created=events[0]!.response as Record<string,unknown>;assert.equal(created.instructions,(JSON.parse(body) as {instructions:string}).instructions);assert.deepEqual(created.tools,[]);
  }
});

test('official-shaped OpenAI reasoning and assistant phase succeed at the lowest reasoning setting without exposing reasoning',async()=>{
  for(const model of ['gpt-6-astra','gpt-6.1-sol','gpt-6.1-terra','gpt-6-luna','gpt-5','gpt-5.4-mini','o3','future-text-orbit-2030']){
    const configuration=q11OpenAi(model),body=buildTaskModelRequest(configuration,[{role:'user',content:'Offline reasoning output'}],definitions,4318);
    const events=q11ResponseEvents(body,{reasoning:true,phase:'final_answer'}),f=q11Stream(configuration,body,q11ResponseWire(events));let output:TaskModelOutput|undefined;const deltas:string[]=[];
    assert.equal(events[2]!.output_index,0);assert.equal((events[2]!.item as {type:string}).type,'reasoning');
    for await(const event of f.stream){if(event.type==='done')output=event.output;else deltas.push(event.text);}
    assert.ok(output);assert.equal(output.text,'Offline Responses text 🙂');assert.deepEqual(output.toolCalls,[]);
    assert.equal(deltas.join(''),output.text);assert.doesNotMatch(deltas.join(''),/SYNTHETIC_PRIVATE_REASONING_SUMMARY|SYNTHETIC_OPAQUE_REASONING/u);
    const terminal=events.at(-1)!.response as {output:unknown[]};assert.deepEqual(output.providerOutput,terminal.output);
    assert.deepEqual((JSON.parse(body) as {include:string[]}).include,['reasoning.encrypted_content']);
    assert.equal(f.network.calls,1);assert.equal(f.network.ends,1);assert.equal(f.network.requests[0]!.body,body);
  }
});

for(const model of ['gpt-5.4-mini','gpt-6.1-sol','future-text-orbit-2030'])test(`OpenAI Responses ${model} preserves encrypted reasoning, assistant phase and tool evidence through two requests`,async()=>{
  const configuration=q11OpenAi(model),history=[{role:'user',content:'An offline tool round trip'}];
  const body=buildTaskModelRequest(configuration,history,definitions,4318),firstEvents=q11ResponseEvents(body,{reasoning:true,phase:'commentary',toolCall:true});
  const firstRequest=JSON.parse(body) as Record<string,unknown>;
  assert.equal(firstRequest.max_output_tokens,model==='future-text-orbit-2030'?4096:32768);
  assert.deepEqual(firstRequest.reasoning,model==='future-text-orbit-2030'?undefined:{effort:model==='gpt-6.1-sol'?'low':'none'});
  const first=q11Stream(configuration,body,q11ResponseWire(firstEvents));let planned:TaskModelOutput|undefined;const deltas:string[]=[];
  for await(const event of first.stream){if(event.type==='done')planned=event.output;else deltas.push(event.text);}
  assert.ok(planned);assert.equal(planned.toolCalls.length,1);assert.equal(planned.toolCalls[0]!.name,'mioon_shot_create');assert.deepEqual(planned.toolCalls[0]!.arguments,{title:'Offline saved shot'});
  assert.doesNotMatch(deltas.join(''),/SYNTHETIC_PRIVATE_REASONING_SUMMARY|SYNTHETIC_OPAQUE_REASONING/u);
  const evidence=(firstEvents.at(-1)!.response as {output:unknown[]}).output;
  const continuation=taskContinuation('responses',planned,[{callId:planned.toolCalls[0]!.id,result:{saved:true}}]);
  assert.deepEqual(continuation.slice(0,evidence.length),evidence);
  const next=buildTaskModelRequest(configuration,[...history,...continuation],definitions,4318),request=JSON.parse(next) as {include:string[];store:boolean;input:unknown[]};
  assert.deepEqual(request.include,['reasoning.encrypted_content']);assert.equal(request.store,false);
  assert.deepEqual(request.input.slice(history.length,history.length+evidence.length),evidence);
  assert.deepEqual(request.input.at(-1),{type:'function_call_output',call_id:'call_q11_offline',output:'{"saved":true}'});
  const second=q11Stream(configuration,next,q11ResponseWire(q11ResponseEvents(next,{reasoning:true,phase:'final_answer'})));let finished:TaskModelOutput|undefined;
  for await(const event of second.stream)if(event.type==='done')finished=event.output;
  assert.ok(finished);assert.equal(finished.text,'Offline Responses text 🙂');assert.deepEqual(finished.toolCalls,[]);
  assert.equal(first.network.calls,1);assert.equal(second.network.calls,1);assert.equal(first.network.requests[0]!.body,body);assert.equal(second.network.requests[0]!.body,next);
});

const q15Carriers = {
  added: 'gAAAAA_SYNTHETIC_ADDED_CARRIER',
  done: 'gAAAAA_SYNTHETIC_ITEM_DONE_CARRIER',
  completed: 'gAAAAA_SYNTHETIC_RESPONSE_COMPLETED_CARRIER',
};

function q15ResponseEvents(body: string, options: {phase?: 'commentary' | 'final_answer'; toolCall?: boolean; visibleText: string}): Array<Record<string, unknown>> {
  const events = q11ResponseEvents(body, {...options, reasoning: true});
  const carrier = (item: Record<string, unknown>, encrypted_content: string) => ({...item, summary: [], content: [], encrypted_content});
  return events.filter(event => !String(event.type).startsWith('response.reasoning_summary_')).map((event, sequence_number) => {
    const frame = {...event, sequence_number};
    if (event.output_index === 0 && (event.type === 'response.output_item.added' || event.type === 'response.output_item.done')) {
      const encryptedContent = event.type === 'response.output_item.added' ? q15Carriers.added : q15Carriers.done;
      return {...frame, item: carrier(event.item as Record<string, unknown>, encryptedContent)};
    }
    if (event.type === 'response.completed') {
      const response = event.response as {output: Array<Record<string, unknown>>};
      const output = response.output.map(item => item.type === 'reasoning' ? carrier(item, q15Carriers.completed) : structuredClone(item));
      return {...frame, response: {...response, output}};
    }
    return frame;
  });
}

function q15CompletedOutput(events: readonly Record<string, unknown>[]): Array<Record<string, unknown>> {
  return (events.at(-1)!.response as {output: Array<Record<string, unknown>>}).output;
}

test('Q15 Responses replays the terminal encrypted carrier through a commentary tool round and the next request', async () => {
  const configuration = q11OpenAi('gpt-6-astra');
  const history = [{role: 'user', content: 'Save one offline test shot'}];
  const body = buildTaskModelRequest(configuration, history, definitions, 4318);
  const firstEvents = q15ResponseEvents(body, {phase: 'commentary', toolCall: true, visibleText: 'I will save a shot.'});
  const evidence = q15CompletedOutput(firstEvents);
  const first = q11Stream(configuration, body, q11ResponseWire(firstEvents));
  const visible: string[] = [];
  let planned: TaskModelOutput | undefined;
  for await (const event of first.stream) {
    if (event.type === 'done') planned = event.output;
    else visible.push(event.text);
  }
  assert.ok(planned);
  assert.equal(visible.join(''), 'I will save a shot.');
  assert.equal(planned.text, visible.join(''));
  assert.deepEqual(planned.providerOutput, evidence);
  assert.deepEqual(evidence[0], {id: 'rs_q11_offline', type: 'reasoning', summary: [], content: [], encrypted_content: q15Carriers.completed});
  assert.equal(evidence[1]!.phase, 'commentary');
  assert.deepEqual(planned.toolCalls, [{id: 'call_q11_offline', name: 'mioon_shot_create', arguments: {title: 'Offline saved shot'}}]);

  const continuation = taskContinuation('responses', planned, [{callId: 'call_q11_offline', result: {saved: true}}]);
  const toolResult = {type: 'function_call_output', call_id: 'call_q11_offline', output: '{"saved":true}'};
  assert.deepEqual(continuation, [...evidence, toolResult]);
  const nextBody = buildTaskModelRequest(configuration, [...history, ...continuation], definitions, 4318);
  const next = JSON.parse(nextBody) as Record<string, unknown>;
  assert.deepEqual(next.input, [...history, ...evidence, toolResult]);
  assert.deepEqual(next.reasoning, {effort: 'low'});
  assert.deepEqual(next.include, ['reasoning.encrypted_content']);
  assert.equal(next.store, false);
  assert.doesNotMatch(nextBody, /SYNTHETIC_ADDED_CARRIER|SYNTHETIC_ITEM_DONE_CARRIER/u);

  const secondEvents = q15ResponseEvents(nextBody, {phase: 'final_answer', visibleText: 'The offline shot is saved.'});
  const second = q11Stream(configuration, nextBody, q11ResponseWire(secondEvents));
  let finished: TaskModelOutput | undefined;
  for await (const event of second.stream) {
    if (event.type === 'done') finished = event.output;
  }
  assert.ok(finished);
  assert.equal(finished.text, 'The offline shot is saved.');
  assert.deepEqual(finished.providerOutput, q15CompletedOutput(secondEvents));
  assert.deepEqual(finished.toolCalls, []);
  for (const [exchange, wire] of [[first, body], [second, nextBody]] as const) {
    assert.equal(exchange.network.calls, 1);
    assert.equal(exchange.network.ends, 1);
    assert.equal(exchange.network.requests[0]!.body, wire);
  }
});

test('Q15 Responses still rejects terminal differences outside the reasoning ciphertext', async () => {
  const configuration = q11OpenAi('gpt-6-astra');
  const body = buildTaskModelRequest(configuration, [{role: 'user', content: 'Offline terminal comparison'}], definitions, 4318);
  for (const [index, field, value] of [
    [0, 'id', 'rs_q15_other'],
    [0, 'summary', [{type: 'summary_text', text: 'Changed summary'}]],
    [0, 'content', [{type: 'reasoning_text', text: 'Changed reasoning'}]],
    [0, 'status', 'completed'],
    [0, 'unexpected', true],
    [1, 'phase', 'final_answer'],
    [2, 'arguments', '{"title":"Changed arguments"}'],
  ] as const) {
    const events = q15ResponseEvents(body, {phase: 'commentary', toolCall: true, visibleText: 'I will save a shot.'});
    const output = q15CompletedOutput(events);
    output[index] = {...output[index]!, [field]: value};
    const exchange = q11Stream(configuration, body, q11ResponseWire(events));
    const visible: string[] = [];
    let completed = 0;
    await assert.rejects(async () => {
      for await (const event of exchange.stream) {
        if (event.type === 'done') completed++;
        else visible.push(event.text);
      }
    }, {code: 'AGENT_CHAT_PROTOCOL_ERROR'}, `output ${index} ${field}`);
    assert.equal(completed, 0);
    assert.equal(visible.join(''), 'I will save a shot.');
    assert.equal(exchange.network.calls, 1);
  }
});

for (const [kind, encrypted_content, code] of [
  ['missing', undefined, 'AGENT_CHAT_RESPONSES_INCOMPLETE'],
  ['null', null, 'AGENT_CHAT_RESPONSES_INCOMPLETE'],
  ['empty', '', 'AGENT_CHAT_RESPONSES_INCOMPLETE'],
  ['nonstring', 17, 'AGENT_CHAT_PROTOCOL_ERROR'],
  ['unpaired surrogate', '\ud800', 'AGENT_CHAT_PROTOCOL_ERROR'],
  ['oversized', 'A'.repeat(TASK_MODEL_LIMITS.outputBytes), 'AGENT_CHAT_LIMIT'],
] as const) test(`Q15 Responses rejects an invalid terminal encrypted carrier (${kind}) after a valid item done`, async () => {
  const configuration = q11OpenAi('gpt-6-astra');
  const body = buildTaskModelRequest(configuration, [{role: 'user', content: 'Offline terminal carrier validation'}], definitions, 4318);
  const events = q15ResponseEvents(body, {phase: 'commentary', toolCall: true, visibleText: 'I will save a shot.'});
  const item = q15CompletedOutput(events)[0]!;
  if (encrypted_content === undefined) delete item.encrypted_content;
  else item.encrypted_content = encrypted_content;
  const exchange = q11Stream(configuration, body, q11ResponseWire(events));
  const visible: string[] = [];
  let completed = 0;
  await assert.rejects(async () => {
    for await (const event of exchange.stream) {
      if (event.type === 'done') completed++;
      else visible.push(event.text);
    }
  }, {code});
  assert.equal(completed, 0);
  assert.equal(visible.join(''), 'I will save a shot.');
  assert.equal(exchange.network.calls, 1);
});

test('Q15 Responses keeps ciphertext equality for a non-OpenAI thinking stream', async () => {
  const configuration: AgentConfiguration = {presetId: 'deepseek', platformId: 'global', protocol: 'responses', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com'};
  const request = JSON.parse(buildTaskModelRequest(configuration, [{role: 'user', content: 'Offline compatibility boundary'}], definitions, 4318)) as Record<string, unknown>;
  const body = JSON.stringify({...request, reasoning: {effort: 'low'}});
  const events = q15ResponseEvents(body, {toolCall: true, visibleText: 'I will save a shot.'});
  const exchange = q11Stream(configuration, body, q11ResponseWire(events));
  const visible: string[] = [];
  let completed = 0;
  await assert.rejects(async () => {
    for await (const event of exchange.stream) {
      if (event.type === 'done') completed++;
      else visible.push(event.text);
    }
  }, {code: 'AGENT_CHAT_PROTOCOL_ERROR'});
  assert.equal(completed, 0);
  assert.equal(visible.join(''), 'I will save a shot.');
  assert.equal(exchange.network.calls, 1);
});

test('the current OpenAI default uses Responses with a documented minimum and a bounded reasoning reserve',()=>{
  assert.equal(AGENT_DEFAULT_OPENAI_MODEL,'gpt-6.1-terra');
  assert.equal(DEFAULT_AGENT_CONFIGURATION.model,AGENT_DEFAULT_OPENAI_MODEL);assert.equal(DEFAULT_AGENT_CONFIGURATION.protocol,'responses');
  const body=JSON.parse(buildTaskModelRequest(DEFAULT_AGENT_CONFIGURATION,[{role:'user',content:'Offline default request'}],definitions,4318)) as Record<string,unknown>;
  assert.equal(body.model,AGENT_DEFAULT_OPENAI_MODEL);assert.deepEqual(body.reasoning,{effort:'none'});assert.equal(body.max_output_tokens,32768);
  assert.deepEqual(body.include,['reasoning.encrypted_content']);assert.equal(body.store,false);assert.equal(body.messages,undefined);assert.equal(body.max_completion_tokens,undefined);
});

test('official tool-incompatible Chat Completions selections fail before credentials or transport, while text diagnostics still work',async()=>{
  for(const model of ['gpt-6-astra','gpt-6.1-sol','gpt-6.1-terra']){
    const configuration:AgentConfiguration={...q11OpenAi(model),protocol:'chat_completions'};
    assert.throws(()=>buildTaskModelRequest(configuration,[{role:'user',content:'Offline tool restriction'}],definitions,4318),{code:'AGENT_CHAT_RESPONSES_REQUIRED'});
    const diagnostic=buildTaskModelRequest(configuration,[{role:'user',content:'Offline text diagnostic'}],[],4318);
    const body=JSON.stringify({...JSON.parse(diagnostic),tools:definitions.map(definition=>({type:'function',function:definition}))});
    const network=syntheticNetwork({body:textFrames('chat_completions')}),dependencies={lookup:async()=>[{address:'8.8.8.8',family:4}],httpsRequest:network.request} as unknown as AgentTransportDependencies;
    let credentials=0,submissions=0,done=0;
    await assert.rejects(async()=>{for await(const event of createTaskGateway(dependencies)({configuration,body,get apiKey(){credentials++;return 'SYNTHETIC_Q11_OFFLINE_ONLY';},selfPort:4318,beforeSubmit(){submissions++;}}))if(event.type==='done')done++;},(error:unknown)=>{
      assert.equal(wasTaskSubmissionPrevented(error),true,'The trusted local preflight proves no request was sent');const safe=safeAgentChatError(error);assert.equal(safe.code,'AGENT_CHAT_RESPONSES_REQUIRED');assert.equal(safe.status,422);assert.match(safe.message,/工具.*Responses/u);return true;
    });
    assert.equal(credentials,0);assert.equal(submissions,0);assert.equal(network.calls,0);assert.equal(done,0);
    const f=q11Stream(configuration,diagnostic,textFrames('chat_completions'));let output:TaskModelOutput|undefined;
    for await(const event of f.stream)if(event.type==='done')output=event.output;
    assert.ok(output);assert.equal(f.network.calls,1);
  }
});

test('Luna Chat Completions tool requests use none effort without inheriting the official Responses-only restriction',async()=>{
  const configuration:AgentConfiguration={...q11OpenAi('gpt-6-luna'),protocol:'chat_completions'},body=buildTaskModelRequest(configuration,[{role:'user',content:'Offline Luna tool call'}],definitions,4318),request=JSON.parse(body) as Record<string,unknown>;
  assert.equal(request.reasoning_effort,'none');assert.equal(request.max_completion_tokens,32768);assert.equal(request.store,false);assert.equal(request.include,undefined);
  const f=q11Stream(configuration,body,chatFrames());let output:TaskModelOutput|undefined;
  for await(const event of f.stream)if(event.type==='done')output=event.output;
  assert.ok(output);assert.equal(output.toolCalls.length,2);for(const call of output.toolCalls)assert.equal(call.name,'mioon_shot_create');assert.equal(f.network.calls,1);assert.equal(f.network.requests[0]!.body,body);
});

test('OpenAI accepts an unfinished added reasoning carrier but requires nonempty encryption on the completed item',async()=>{
  const configuration=q11OpenAi('gpt-5.4-mini'),body=buildTaskModelRequest(configuration,[{role:'user',content:'Offline encrypted carrier checks'}],definitions,4318);
  for(const encrypted_content of [null,'','SYNTHETIC_PARTIAL_ENCRYPTION']){
    const events=q11ResponseEvents(body,{reasoning:true,phase:'final_answer'}).map(event=>event.type==='response.output_item.added'&&event.output_index===0?{...event,item:{...(event.item as Record<string,unknown>),encrypted_content}}:event);
    const f=q11Stream(configuration,body,q11ResponseWire(events));let output:TaskModelOutput|undefined;
    for await(const event of f.stream)if(event.type==='done')output=event.output;
    assert.ok(output);assert.equal((output.providerOutput as Array<Record<string,unknown>>)[0]!.encrypted_content,'SYNTHETIC_OPAQUE_REASONING');
    assert.equal(output.text,'Offline Responses text 🙂');assert.equal(f.network.calls,1);
  }
  for(const [kind,code] of [['missing','AGENT_CHAT_RESPONSES_INCOMPLETE'],['null','AGENT_CHAT_RESPONSES_INCOMPLETE'],['empty','AGENT_CHAT_RESPONSES_INCOMPLETE'],['wrong-type','AGENT_CHAT_PROTOCOL_ERROR']] as const){
    const damaged=(item:Record<string,unknown>)=>{
      const value={...item};if(kind==='missing')delete value.encrypted_content;else value.encrypted_content=kind==='null'?null:kind==='empty'?'':17;return value;
    };
    const events=q11ResponseEvents(body,{reasoning:true,phase:'final_answer'}).map(event=>{
      if(event.type==='response.output_item.done'&&event.output_index===0)return {...event,item:damaged(event.item as Record<string,unknown>)};
      if(event.type==='response.completed'){const response=event.response as {output:Array<Record<string,unknown>>};return {...event,response:{...response,output:response.output.map(item=>item.type==='reasoning'?damaged(item):item)}};}
      return event;
    });
    const f=q11Stream(configuration,body,q11ResponseWire(events));let completed=0;
    await assert.rejects(async()=>{for await(const event of f.stream)if(event.type==='done')completed++;},{code});
    assert.equal(completed,0);assert.equal(f.network.calls,1);
    const bare:{[key:string]:AgentTaskJson}={id:'rs_q11_offline',type:'reasoning',summary:[]};
    if(kind!=='missing')bare.encrypted_content=kind==='null'?null:kind==='empty'?'':17;
    const history:AgentTaskJson[]=[{role:'user',content:'Offline continuation'},bare];
    assert.throws(()=>buildTaskModelRequest(configuration,history,definitions,4318),{code},'An old bare reasoning ID cannot be dispatched into another store:false request');
  }
});

test('OpenAI Responses classifies incomplete output and unsupported item types without executing model tools',async()=>{
  const configuration=q11OpenAi('gpt-5.4-mini'),body=buildTaskModelRequest(configuration,[{role:'user',content:'Offline classified failures'}],definitions,4318);
  const prefix=q11ResponseEvents(body).slice(0,2),response=prefix[0]!.response as Record<string,unknown>;
  for(const [event,code] of [
    [{type:'response.incomplete',response:{...response,status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[]}},'AGENT_CHAT_OUTPUT_LIMIT'],
    [{type:'response.incomplete',response:{...response,status:'incomplete',incomplete_details:{reason:'content_filter'},output:[]}},'AGENT_CHAT_RESPONSES_INCOMPLETE'],
    [{type:'response.output_item.added',output_index:0,item:{id:'unknown_hosted_tool',type:'web_search_call',status:'in_progress'}},'AGENT_CHAT_RESPONSES_ITEM_UNSUPPORTED'],
  ] as const){
    const f=q11Stream(configuration,body,q11ResponseWire([...prefix,{...event,sequence_number:2}]));let completed=0;
    await assert.rejects(async()=>{for await(const event of f.stream)if(event.type==='done')completed++;},{code});
    assert.equal(completed,0);assert.equal(f.network.calls,1);assert.equal(f.network.ends,1);
  }
});

test('OpenAI Responses phase belongs only to assistant messages and preserves its documented value domain',async()=>{
  const configuration=q11OpenAi('gpt-5.4-mini'),body=buildTaskModelRequest(configuration,[{role:'user',content:'Offline phase guards'}],definitions,4318);
  const sources:Array<Array<Record<string,unknown>>>=[];
  for(const phase of ['analysis',17,{}])sources.push(q11ResponseEvents(body,{phase:'final_answer'}).map(event=>event.type==='response.output_item.added'?{...event,item:{...(event.item as Record<string,unknown>),phase}}:event));
  sources.push(q11ResponseEvents(body).map((event,index)=>index===0?{...event,phase:'final_answer'}:event));
  sources.push(q11ResponseEvents(body,{reasoning:true}).map(event=>event.type==='response.output_item.added'&&event.output_index===0?{...event,item:{...(event.item as Record<string,unknown>),phase:'commentary'}}:event));
  sources.push(q11ResponseEvents(body,{toolCall:true}).map(event=>event.type==='response.output_item.added'&&(event.item as {type:string}).type==='function_call'?{...event,item:{...(event.item as Record<string,unknown>),phase:'commentary'}}:event));
  sources.push(q11ResponseEvents(body,{phase:'commentary'}).map(event=>event.type==='response.output_item.added'?{...event,item:{...(event.item as Record<string,unknown>),role:'user'}}:event));
  for(const events of sources){
    const f=q11Stream(configuration,body,q11ResponseWire(events));let completed=0;
    await assert.rejects(async()=>{for await(const event of f.stream)if(event.type==='done')completed++;},{code:'AGENT_CHAT_PROTOCOL_ERROR'});
    assert.equal(completed,0);assert.equal(f.network.calls,1);
  }
});

test('Responses accepts complete actual tool-catalog lifecycle echoes in UTF-8 and ASCII-escaped form without changing the frozen request',async t=>{
  const root=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-q11-echo-')),store=openStore(root),services=createServices(store,new Map()),tools=createAgentTaskTools({store,services});
  t.after(async()=>{tools.dispose();await services.drain();store.close();await rm(root,{recursive:true,force:true});});
  const configuration=q11OpenAi(),all=tools.list(),groups=all.filter(tool=>['core','canvas','editing'].includes(agentTaskToolGroupForName(tool.name)??''));
  const ascii=(wire:string)=>wire.replace(/[\u0080-\uffff]/g,value=>`\\u${value.charCodeAt(0).toString(16).padStart(4,'0')}`);
  for(const catalog of [groups,all]){
    const body=buildTaskModelRequest(configuration,[taskResponseLanguageContext('zh-Hans'),{role:'user',content:'Only an offline response fixture'}],catalog,4318,{toolLoading:true});
    const events=q11ResponseEvents(body),raw=q11ResponseWire(events),lifecycle=events.filter(event=>['response.created','response.in_progress','response.completed'].includes(String(event.type)));
    assert.equal(lifecycle.length,3);assert.ok(catalog.length>18);
    for(const event of lifecycle)assert.ok(Buffer.byteLength(q11ResponseWire([event]))>70*1024,'Real multi-group tools and instructions exceed the previous per-event budget');
    for(const wire of [raw,ascii(raw)]){
      assert.ok(Buffer.byteLength(wire)<4*1024*1024,'The complete actual catalog and three lifecycle echoes fit the Responses raw-byte budget');
      const f=q11Stream(configuration,body,wire);let output:TaskModelOutput|undefined;
      for await(const event of f.stream)if(event.type==='done')output=event.output;
      assert.ok(output);assert.equal(output.text,'Offline Responses text 🙂');assert.deepEqual(output.toolCalls,[]);
      assert.equal(f.network.calls,1);assert.equal(f.network.requests[0]!.body,body);
    }
    t.diagnostic(JSON.stringify({q11Tools:catalog.length,requestBytes:Buffer.byteLength(body),lifecycleMaxBytes:Math.max(...lifecycle.map(event=>Buffer.byteLength(q11ResponseWire([event])))),lifecycleAsciiMaxBytes:Math.max(...lifecycle.map(event=>Buffer.byteLength(ascii(q11ResponseWire([event]))))),streamBytes:Buffer.byteLength(raw),streamAsciiBytes:Buffer.byteLength(ascii(raw))}));
  }
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM jobs').get()?.n,0);
});

test('Responses budget carries the full catalog plus bounded large text and encrypted reasoning across all done echoes',async t=>{
  const root=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-q11-budget-')),store=openStore(root),services=createServices(store,new Map()),tools=createAgentTaskTools({store,services});
  t.after(async()=>{tools.dispose();await services.drain();store.close();await rm(root,{recursive:true,force:true});});
  const configuration=q11OpenAi('gpt-5.4-mini'),catalog=tools.list(),body=buildTaskModelRequest(configuration,[taskResponseLanguageContext('zh-Hans'),{role:'user',content:'Offline maximum carrier measurement'}],catalog,4318,{toolLoading:true});
  const visibleText='🙂'.repeat(TASK_MODEL_LIMITS.outputBytes/4),encryptedContent='A'.repeat(120*1024),events=q11ResponseEvents(body,{reasoning:true,phase:'final_answer',visibleText,encryptedContent});
  const ascii=(wire:string)=>wire.replace(/[\u0080-\uffff]/g,value=>`\\u${value.charCodeAt(0).toString(16).padStart(4,'0')}`);
  const raw=q11ResponseWire(events),escaped=ascii(raw);
  const item=(events.find(event=>event.type==='response.output_item.done'&&event.output_index===0)!.item as Record<string,unknown>);
  assert.ok(Buffer.byteLength(JSON.stringify(item))<TASK_MODEL_LIMITS.outputBytes,'The reasoning item keeps its existing local payload limit');
  assert.equal(Buffer.byteLength(visibleText),TASK_MODEL_LIMITS.outputBytes);
  for(const wire of [raw,escaped]){
    assert.ok(Buffer.byteLength(wire)<4*1024*1024);
    const f=q11Stream(configuration,body,wire);let output:TaskModelOutput|undefined;const deltas:string[]=[];
    for await(const event of f.stream){if(event.type==='done')output=event.output;else deltas.push(event.text);}
    assert.ok(output);assert.equal(output.text,visibleText);assert.equal(deltas.join(''),visibleText);assert.deepEqual(output.toolCalls,[]);
    assert.equal((output.providerOutput as Array<Record<string,unknown>>)[0]!.encrypted_content,encryptedContent);
    assert.equal(f.network.calls,1);assert.equal(f.network.requests[0]!.body,body);
  }
  t.diagnostic(JSON.stringify({q11MaximumFieldCarriers:true,tools:catalog.length,textBytes:Buffer.byteLength(visibleText),reasoningItemBytes:Buffer.byteLength(JSON.stringify(item)),streamBytes:Buffer.byteLength(raw),streamAsciiBytes:Buffer.byteLength(escaped),maxEventAsciiBytes:Math.max(...events.map(event=>Buffer.byteLength(ascii(q11ResponseWire([event])))))}));
  const extreme=q11ResponseWire(q11ResponseEvents(body,{reasoning:true,phase:'commentary',visibleText,encryptedContent,toolCalls:TASK_MODEL_LIMITS.toolCalls,argumentTitle:'🙂'.repeat(8000)}));
  const extremeEscaped=ascii(extreme);
  assert.ok(Buffer.byteLength(extremeEscaped)>4*1024*1024,'Independent per-field ceilings do not waive the aggregate stream budget');
  const bounded=q11Stream(configuration,body,extremeEscaped);
  await assert.rejects(async()=>{for await(const _event of bounded.stream){}},{code:'AGENT_CHAT_LIMIT'});
  t.diagnostic(JSON.stringify({q11AggregateExtremeBytes:Buffer.byteLength(extremeEscaped),toolCalls:TASK_MODEL_LIMITS.toolCalls,aggregateBudgetBytes:4*1024*1024}));
});

test('Responses lifecycle allowance keeps ordinary events, lifecycle bytes, total bytes and event-name agreement bounded',async()=>{
  const configuration=q11OpenAi(),body=buildTaskModelRequest(configuration,[{role:'user',content:'Offline bounds only'}],[],4318);
  const ordinary=q11ResponseEvents(body).map(event=>event.type==='response.output_text.delta'?{...event,delta:'x'.repeat(70*1024)}:event);
  const oversized=q11ResponseEvents(body).map(event=>event.type==='response.created'?{...event,response:{...(event.response as Record<string,unknown>),instructions:'x'.repeat(2*1024*1024)}}:event);
  const total=q11ResponseEvents(body).map(event=>['response.created','response.in_progress','response.completed'].includes(String(event.type))?{...event,response:{...(event.response as Record<string,unknown>),instructions:'x'.repeat(1500*1024)}}:event);
  const mismatched=q11ResponseEvents(body);mismatched[0]={type:'response.output_text.delta',sequence_number:0,output_index:0,item_id:'msg_q11_offline',content_index:0,delta:'x'.repeat(70*1024)};
  const disguised=q11ResponseWire(mismatched).replace('event: response.output_text.delta','event: response.created');
  for(const [wire,code] of [[q11ResponseWire(ordinary),'AGENT_CHAT_LIMIT'],[q11ResponseWire(oversized),'AGENT_CHAT_LIMIT'],[q11ResponseWire(total),'AGENT_CHAT_LIMIT'],[disguised,'AGENT_CHAT_PROTOCOL_ERROR']] as const){
    const f=q11Stream(configuration,body,wire);let completed=0;
    await assert.rejects(async()=>{for await(const event of f.stream)if(event.type==='done')completed++;},{code});
    assert.equal(completed,0);assert.equal(f.network.calls,1);assert.equal(f.network.ends,1);
  }
});

test('Chat Completions keeps its original event budget even with a Responses lifecycle event name',async()=>{
  const configuration:AgentConfiguration={...q11OpenAi('gpt-5'),protocol:'chat_completions'};
  const body=buildTaskModelRequest(configuration,[{role:'user',content:'Offline CC boundary'}],[],4318);
  const raw={choices:[{index:0,delta:{role:'assistant',content:'CC unchanged'},finish_reason:null}],obfuscation:'x'.repeat(70*1024)};
  const f=q11Stream(configuration,body,`event: response.created\n${json(raw)}${textFrames('chat_completions')}`);
  await assert.rejects(async()=>{for await(const _event of f.stream){}},{code:'AGENT_CHAT_LIMIT'});
  assert.equal(f.network.calls,1);assert.equal(f.network.ends,1);assert.equal(f.network.requests[0]!.body,body);
});

test('other vendor Responses streams retain the old event allowance instead of borrowing OpenAI echo budgets',async()=>{
  const configuration:AgentConfiguration={presetId:'deepseek',platformId:'global',protocol:'responses',model:'deepseek-flash',baseUrl:'https://api.deepseek.com'};
  const body=buildTaskModelRequest(configuration,[{role:'user',content:'Offline vendor boundary'}],[],4318);
  const events=q11ResponseEvents(body).map(event=>event.type==='response.created'?{...event,response:{...(event.response as Record<string,unknown>),instructions:'x'.repeat(70*1024)}}:event);
  const f=q11Stream(configuration,body,q11ResponseWire(events));
  await assert.rejects(async()=>{for await(const _event of f.stream){}},{code:'AGENT_CHAT_LIMIT'});
  assert.equal(f.network.calls,1);assert.equal(f.network.requests[0]!.body,body);
});

test('OpenAI reasoning-family requests reserve reasoning output and use documented lowest efforts in both protocols',()=>{
  for(const [model,effort] of [['gpt-6-luna','none'],['gpt-6-sol','none'],['gpt-5.6','none'],['gpt-5.6-sol','none'],['gpt-5.6-terra','none'],['gpt-5.6-luna','none'],['gpt-5.4-mini','none'],['gpt-5.4','none'],['gpt-5','minimal'],['o3','low']] as const)for(const protocol of ['responses','chat_completions'] as const){
    const configuration:AgentConfiguration={...q11OpenAi(model),protocol};
    const body=JSON.parse(buildTaskModelRequest(configuration,[{role:'user',content:'Offline request profile'}],definitions,4318)) as Record<string,unknown>;
    assert.equal(body.max_output_tokens??body.max_completion_tokens,32768,`${model}/${protocol}`);
    assert.equal(body.store,false);
    if(protocol==='responses'){
      assert.deepEqual(body.include,['reasoning.encrypted_content']);assert.deepEqual(body.reasoning,{effort});assert.equal(body.reasoning_effort,undefined);
    }else{
      assert.equal(body.reasoning_effort,effort);assert.equal(body.include,undefined);assert.equal(body.reasoning,undefined);
    }
  }
  for(const protocol of ['responses','chat_completions'] as const){
    const body=JSON.parse(buildTaskModelRequest({...q11OpenAi(),protocol},[{role:'user',content:'Legacy optional model'}],definitions,4318)) as Record<string,unknown>;
    assert.equal(body.max_output_tokens??body.max_completion_tokens,4096);
    assert.equal(body.include,undefined);assert.equal(body.reasoning_effort,undefined);assert.equal(body.reasoning,undefined);
  }
});

type Q11IncompleteItem='message'|'function_call'|'reasoning';
/** item.done is an item streaming boundary, not proof of a successful response.
 * The pinned SDK allows incomplete items in this event's ResponseOutputItem. */
function q11IncompleteItemEvents(body:string,kind:Q11IncompleteItem,terminal:'response.incomplete'|'response.completed',reason='max_output_tokens'):Array<Record<string,unknown>>{
  const prefix=q11ResponseEvents(body).slice(0,2),response=prefix[0]!.response as Record<string,unknown>,index=0;
  let initial:Record<string,unknown>,item:Record<string,unknown>,parts:Array<Record<string,unknown>>;
  if(kind==='message'){
    const text='Partial text before the output limit',part={type:'output_text',text,annotations:[],logprobs:[]};
    initial={id:'msg_q11_incomplete',type:kind,role:'assistant',phase:'final_answer',status:'in_progress',content:[]};
    item={...initial,status:'incomplete',content:[part]};
    parts=[{type:'response.content_part.added',output_index:index,item_id:item.id,content_index:0,part:{...part,text:''}},
      {type:'response.output_text.delta',output_index:index,item_id:item.id,content_index:0,delta:text,logprobs:[]},
      {type:'response.output_text.done',output_index:index,item_id:item.id,content_index:0,text,logprobs:[]},
      {type:'response.content_part.done',output_index:index,item_id:item.id,content_index:0,part}];
  }else if(kind==='function_call'){
    const argumentsJson='{"title":"Partial argument';
    initial={id:'fc_q11_incomplete',type:kind,call_id:'call_q11_incomplete',name:'mioon_shot_create',status:'in_progress',arguments:''};
    item={...initial,status:'incomplete',arguments:argumentsJson};
    parts=[{type:'response.function_call_arguments.delta',output_index:index,item_id:item.id,delta:argumentsJson},
      {type:'response.function_call_arguments.done',output_index:index,item_id:item.id,name:item.name,arguments:argumentsJson}];
  }else{
    const part={type:'summary_text',text:'PRIVATE_Q11_PARTIAL_REASONING'};
    initial={id:'rs_q11_incomplete',type:kind,status:'in_progress',summary:[]};
    item={...initial,status:'incomplete',summary:[part],encrypted_content:null};
    parts=[{type:'response.reasoning_summary_part.added',output_index:index,item_id:item.id,summary_index:0,part:{...part,text:''}},
      {type:'response.reasoning_summary_text.delta',output_index:index,item_id:item.id,summary_index:0,delta:part.text},
      {type:'response.reasoning_summary_text.done',output_index:index,item_id:item.id,summary_index:0,text:part.text},
      {type:'response.reasoning_summary_part.done',output_index:index,item_id:item.id,summary_index:0,part}];
  }
  return [...prefix,{type:'response.output_item.added',output_index:index,item:initial},...parts,
    {type:'response.output_item.done',output_index:index,item},
    {type:terminal,response:{...response,status:terminal==='response.incomplete'?'incomplete':'completed',incomplete_details:terminal==='response.incomplete'?{reason}:null,output:[item]}}]
    .map((event,sequence_number)=>({...event,sequence_number}));
}

for(const kind of ['message','function_call','reasoning'] as const)test(`OpenAI ${kind} item.done incomplete waits for the response terminal before classifying truncation`,async()=>{
  const configuration=q11OpenAi('gpt-5.4-mini'),body=buildTaskModelRequest(configuration,[{role:'user',content:'Offline partial item boundary'}],definitions,4318);
  for(const [reason,code] of [['max_output_tokens','AGENT_CHAT_OUTPUT_LIMIT'],['content_filter','AGENT_CHAT_RESPONSES_INCOMPLETE']] as const){
    const f=q11Stream(configuration,body,q11ResponseWire(q11IncompleteItemEvents(body,kind,'response.incomplete',reason)));
    let completed=0,toolPlans=0;const deltas:string[]=[];
    await assert.rejects(async()=>{for await(const event of f.stream){if(event.type==='done'){completed++;toolPlans+=event.output.toolCalls.length;}else deltas.push(event.text);}},{code});
    assert.equal(completed,0);assert.equal(toolPlans,0);assert.equal(f.network.calls,1);assert.equal(f.network.ends,1);
    if(kind!=='message')assert.deepEqual(deltas,[],'Incomplete tools and reasoning cannot become user-visible text');
    assert.doesNotMatch(deltas.join(''),/PRIVATE_Q11_PARTIAL_REASONING/u);
  }
});

test('a completed OpenAI response cannot promote an incomplete item into executable tool or replay evidence',async()=>{
  const configuration=q11OpenAi('gpt-5.4-mini'),body=buildTaskModelRequest(configuration,[{role:'user',content:'Offline contradictory completion'}],definitions,4318);
  for(const kind of ['message','function_call','reasoning'] as const){
    const f=q11Stream(configuration,body,q11ResponseWire(q11IncompleteItemEvents(body,kind,'response.completed')));
    let completed=0,toolPlans=0;
    await assert.rejects(async()=>{for await(const event of f.stream)if(event.type==='done'){completed++;toolPlans+=event.output.toolCalls.length;}},{code:'AGENT_CHAT_PROTOCOL_ERROR'});
    assert.equal(completed,0);assert.equal(toolPlans,0);assert.equal(f.network.calls,1);
  }
});

test('OpenAI full-catalog incomplete and failed lifecycle echoes preserve accurate terminal errors above the ordinary event limit',async t=>{
  const root=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-q11-terminal-')),store=openStore(root),services=createServices(store,new Map()),tools=createAgentTaskTools({store,services});
  t.after(async()=>{tools.dispose();await services.drain();store.close();await rm(root,{recursive:true,force:true});});
  const configuration=q11OpenAi('gpt-5.4-mini'),catalog=tools.list(),body=buildTaskModelRequest(configuration,[taskResponseLanguageContext('zh-Hans'),{role:'user',content:'Offline terminal echo'}],catalog,4318,{toolLoading:true});
  for(const [terminal,code] of [['response.incomplete','AGENT_CHAT_OUTPUT_LIMIT'],['response.failed','AGENT_CHAT_PROVIDER_ERROR']] as const){
    const events=q11IncompleteItemEvents(body,'message','response.incomplete');
    if(terminal==='response.failed'){
      const event=events.at(-1)!,response=event.response as Record<string,unknown>;
      events[events.length-1]={...event,type:terminal,response:{...response,status:'failed',incomplete_details:null,error:{code:'server_error',message:'PRIVATE_Q11_PROVIDER_FAILURE'}}};
    }
    const last=events.at(-1)!;
    assert.ok(Buffer.byteLength(q11ResponseWire([last]))>64*1024,'An error terminal also echoes the entire request catalog and instructions');
    const f=q11Stream(configuration,body,q11ResponseWire(events));let completed=0,toolPlans=0;
    await assert.rejects(async()=>{for await(const event of f.stream)if(event.type==='done'){completed++;toolPlans+=event.output.toolCalls.length;}},(error:unknown)=>{
      const safe=safeAgentChatError(error);assert.equal(safe.code,code);assert.doesNotMatch(safe.message,/PRIVATE_Q11_PROVIDER_FAILURE/u);return true;
    });
    assert.equal(completed,0);assert.equal(toolPlans,0);assert.equal(f.network.calls,1);assert.equal(f.network.requests[0]!.body,body);
  }
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM jobs').get()?.n,0);
});

const q12Kimi=(platformId:'china'|'international',model='kimi-k3.1-pro'):AgentConfiguration=>({presetId:'kimi',platformId,protocol:'chat_completions',model,baseUrl:`https://api.moonshot.${platformId==='china'?'cn':'ai'}/v1`});
function q12KimiFrames(configuration:AgentConfiguration,{toolCall=true,reasoning=true,text='I will save this shot.'}:{toolCall?:boolean;reasoning?:boolean;text?:string}={}):string{
  const chunk=(delta:Record<string,unknown>,finish_reason:string|null=null)=>json({id:'chatcmpl_q12_kimi',object:'chat.completion.chunk',created:1792741110,model:configuration.model,choices:[{index:0,delta,finish_reason}],system_fingerprint:'synthetic_q12_kimi'});
  const argumentsJson=JSON.stringify({title:'Kimi saved shot',_mio_step:'Create the saved shot'});
  return chunk({role:'assistant',content:''})+(reasoning?chunk({reasoning_content:'PRIVATE_KIMI_PLAN_'})+chunk({reasoning_content:'CONTINUED'}):'')+
    chunk({content:text})+(toolCall?chunk({tool_calls:[{index:0,id:'call_q12_kimi',type:'function',function:{name:'mioon_shot_create',arguments:argumentsJson.slice(0,17)}}]})+
      chunk({tool_calls:[{index:0,function:{arguments:argumentsJson.slice(17)}}]}):'')+
    chunk({},toolCall?'tool_calls':'stop')+'data: [DONE]\n\n';
}

for(const platformId of ['china','international'] as const)test(`Kimi K3.1 Pro ${platformId}: low-effort CC keeps reasoning private and replays the complete tool round`,async()=>{
  const configuration=q12Kimi(platformId),history=[{role:'user',content:'Save one offline test shot'}],body=buildTaskModelRequest(configuration,history,definitions,4318),request=JSON.parse(body) as Record<string,unknown>;
  assert.equal(request.model,'kimi-k3.1-pro');assert.equal(request.reasoning_effort,'low');assert.equal(request.max_completion_tokens,4096);
  for(const field of ['max_tokens','max_output_tokens','thinking','reasoning','stream_options'])assert.equal(Object.hasOwn(request,field),false,field);
  const first=q11Stream(configuration,body,q12KimiFrames(configuration));let planned:TaskModelOutput|undefined;const shown:string[]=[];
  for await(const item of first.stream){if(item.type==='done')planned=item.output;else shown.push(item.text);}
  assert.ok(planned);assert.equal(planned.text,'I will save this shot.');assert.equal(shown.join(''),planned.text);assert.doesNotMatch(shown.join(''),/PRIVATE_KIMI_PLAN_|CONTINUED/u);
  assert.deepEqual(planned.toolCalls,[{id:'call_q12_kimi',name:'mioon_shot_create',arguments:{title:'Kimi saved shot'}}]);
  const assistant={role:'assistant',content:'I will save this shot.',reasoning_content:'PRIVATE_KIMI_PLAN_CONTINUED',tool_calls:[{id:'call_q12_kimi',type:'function',function:{name:'mioon_shot_create',arguments:JSON.stringify({title:'Kimi saved shot',_mio_step:'Create the saved shot'})}}]};
  assert.deepEqual(planned.providerOutput,assistant);assert.equal(taskToolExplanation(planned,'call_q12_kimi'),'Create the saved shot');
  const continuation=taskContinuation('chat_completions',planned,[{callId:'call_q12_kimi',result:{saved:true}}]);
  assert.deepEqual(continuation,[assistant,{role:'tool',tool_call_id:'call_q12_kimi',content:'{"saved":true}'}]);
  const next=buildTaskModelRequest(configuration,[...history,...continuation],definitions,4318),nextRequest=JSON.parse(next) as Record<string,unknown>;
  assert.equal(nextRequest.reasoning_effort,'low');assert.equal(nextRequest.max_completion_tokens,4096);assert.equal(Object.hasOwn(nextRequest,'thinking'),false);
  assert.deepEqual((nextRequest.messages as unknown[]).slice(1),[...history,...continuation],'No reasoning, tool evidence or paired result is rewritten');
  const second=q11Stream(configuration,next,q12KimiFrames(configuration,{toolCall:false,text:'Saved the offline shot.'}));let completed:TaskModelOutput|undefined;const lastShown:string[]=[];
  for await(const item of second.stream){if(item.type==='done')completed=item.output;else lastShown.push(item.text);}
  assert.ok(completed);assert.equal(completed.text,'Saved the offline shot.');assert.deepEqual(completed.toolCalls,[]);assert.equal(lastShown.join(''),completed.text);assert.doesNotMatch(lastShown.join(''),/PRIVATE_KIMI_PLAN_|CONTINUED/u);
  assert.equal((completed.providerOutput as Record<string,unknown>).reasoning_content,'PRIVATE_KIMI_PLAN_CONTINUED');
  for(const [exchange,wire] of [[first,body],[second,next]] as const){assert.equal(exchange.network.calls,1);assert.equal(exchange.network.ends,1);assert.equal(exchange.network.requests[0]!.body,wire);}
});

for(const platformId of ['china','international'] as const)test(`Kimi K2.6 ${platformId}: the retained off profile and its tool continuation never acquire K3 reasoning`,async()=>{
  const configuration=q12Kimi(platformId,'kimi-k2.6'),history=[{role:'user',content:'Legacy offline test'}],body=buildTaskModelRequest(configuration,history,definitions,4318),request=JSON.parse(body) as Record<string,unknown>;
  assert.equal(request.model,'kimi-k2.6');assert.deepEqual(request.thinking,{type:'disabled'});assert.equal(request.max_tokens,4096);assert.equal(Object.hasOwn(request,'reasoning_effort'),false);assert.equal(Object.hasOwn(request,'max_completion_tokens'),false);
  const first=q11Stream(configuration,body,q12KimiFrames(configuration,{reasoning:false}));let output:TaskModelOutput|undefined;
  for await(const item of first.stream)if(item.type==='done')output=item.output;
  assert.ok(output);assert.equal(output.toolCalls.length,1);assert.equal(Object.hasOwn(output.providerOutput as object,'reasoning_content'),false);
  const continuation=taskContinuation('chat_completions',output,[{callId:'call_q12_kimi',result:{saved:true}}]),next=JSON.parse(buildTaskModelRequest(configuration,[...history,...continuation],definitions,4318)) as Record<string,unknown>;
  assert.deepEqual(next.thinking,{type:'disabled'});assert.equal(next.max_tokens,4096);assert.equal(Object.hasOwn(next,'reasoning_effort'),false);assert.deepEqual((next.messages as unknown[]).slice(1),[...history,...continuation]);
  const rejected=q11Stream(configuration,body,q12KimiFrames(configuration));let completed=0;const shown:string[]=[];
  await assert.rejects(async()=>{for await(const item of rejected.stream){if(item.type==='done')completed++;else shown.push(item.text);}},{code:'AGENT_CHAT_REASONING_UNSUPPORTED'});
  assert.equal(completed,0);assert.doesNotMatch(shown.join(''),/PRIVATE_KIMI_PLAN_|CONTINUED/u);assert.equal(first.network.calls,1);assert.equal(rejected.network.calls,1);assert.equal(rejected.network.requests[0]!.body,body);
});

const q12Sonnet:AgentConfiguration={presetId:'anthropic',platformId:'global',protocol:'anthropic_messages',model:'claude-sonnet-5-5',baseUrl:'https://api.anthropic.com'};
function q12SonnetWire({thinkingText,toolCall,transformLocation}:{thinkingText:string;toolCall:boolean;transformLocation?:'start'|'delta'}):string{
  const events:Array<Record<string,unknown>>=nativeAnthropicEvents({model:q12Sonnet.model,text:'The offline shot was saved.',...(toolCall?{toolName:'mioon_shot_create',argumentsJson:JSON.stringify({title:'Sonnet saved shot',_mio_step:'Create the saved shot'})}:{})}).map(event=>({...event}));
  const start=events[0]!,transformations=[{type:'thinking_dropped',path:'messages.1.content.0',reason:'prefix_binding_mismatch'}];
  if(transformLocation==='start')start.message={...(start.message as Record<string,unknown>),input_transformations:transformations};
  for(const event of events.slice(1)){
    if(typeof event.index==='number')event.index++;
    if(event.type==='message_delta'&&transformLocation==='delta')event.input_transformations=transformations;
  }
  const thinking:Array<Record<string,unknown>>=[{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}}];
  if(thinkingText)thinking.push({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:thinkingText}});
  thinking.push({type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:toolCall?'SYNTHETIC_SONNET_SIGNATURE_FIRST':'SYNTHETIC_SONNET_SIGNATURE_FINAL'}},{type:'content_block_stop',index:0});
  return q11ResponseWire([start,...thinking,...events.slice(1)]);
}

for(const [thinkingText,transformLocation] of [['PRIVATE_SONNET_REASONING','start'],['','delta']] as const)test(`Sonnet adaptive low replays signed ${thinkingText?'private':'empty'} thinking after a tool-prefix change and ${transformLocation} metadata`,async()=>{
  const history=[{role:'user',content:'Save one offline Sonnet shot'}],body=buildTaskModelRequest(q12Sonnet,history,definitions,4318),request=JSON.parse(body) as Record<string,unknown>;
  assert.equal(request.model,'claude-sonnet-5-5');assert.equal(request.max_tokens,16384);
  assert.deepEqual(request.thinking,{type:'adaptive',block_binding:{prefix_mismatch_behavior:'drop_block'}});assert.deepEqual(request.output_config,{effort:'low'});assert.equal(Object.hasOwn(request,'input_transformations'),false);
  const first=q11Stream(q12Sonnet,body,q12SonnetWire({thinkingText,toolCall:true}));let planned:TaskModelOutput|undefined;const shown:string[]=[];
  for await(const item of first.stream){if(item.type==='done')planned=item.output;else shown.push(item.text);}
  assert.ok(planned);assert.equal(planned.text,'');assert.deepEqual(shown,[]);assert.deepEqual(planned.toolCalls,[{id:'tool_native_fixture',name:'mioon_shot_create',arguments:{title:'Sonnet saved shot'}}]);
  const assistant={role:'assistant',content:[{type:'thinking',thinking:thinkingText,signature:'SYNTHETIC_SONNET_SIGNATURE_FIRST'},{type:'tool_use',id:'tool_native_fixture',name:'mioon_shot_create',input:{title:'Sonnet saved shot',_mio_step:'Create the saved shot'}}]};
  assert.deepEqual(planned.providerOutput,assistant);
  const continuation=taskContinuation('anthropic_messages',planned,[{callId:'tool_native_fixture',result:{saved:true}}]);
  assert.deepEqual(continuation,[assistant,{role:'user',content:[{type:'tool_result',tool_use_id:'tool_native_fixture',content:'{"saved":true}'}]}]);
  const expanded=[...definitions,{name:'mioon_shot_inspect',description:'Read a saved shot',parameters:{type:'object',properties:{shotId:{type:'string'}},required:['shotId'],additionalProperties:false}}],next=buildTaskModelRequest(q12Sonnet,[...history,...continuation],expanded,4318),nextRequest=JSON.parse(next) as Record<string,unknown>;
  assert.equal((request.tools as unknown[]).length,1);assert.equal((nextRequest.tools as unknown[]).length,2);assert.deepEqual(nextRequest.thinking,request.thinking);assert.deepEqual(nextRequest.output_config,{effort:'low'});assert.equal(nextRequest.max_tokens,16384);
  const nextMessages=nextRequest.messages as Array<Record<string,unknown>>;
  assert.deepEqual(nextMessages[1],assistant,'The client retains the signed block even when the service reports dropping it');
  const result=(nextMessages[2]!.content as Array<Record<string,unknown>>)[0]!;assert.equal(result.type,'tool_result');assert.equal(result.tool_use_id,'tool_native_fixture');assert.equal(result.content,'{"saved":true}');
  const second=q11Stream(q12Sonnet,next,q12SonnetWire({thinkingText:'',toolCall:false,transformLocation}));let completed:TaskModelOutput|undefined;const visible:string[]=[];
  for await(const item of second.stream){if(item.type==='done')completed=item.output;else visible.push(item.text);}
  assert.ok(completed);assert.equal(completed.text,'The offline shot was saved.');assert.equal(visible.join(''),completed.text);assert.deepEqual(completed.toolCalls,[]);
  assert.deepEqual(completed.providerOutput,{role:'assistant',content:[{type:'thinking',thinking:'',signature:'SYNTHETIC_SONNET_SIGNATURE_FINAL'},{type:'text',text:'The offline shot was saved.'}]});
  assert.doesNotMatch(JSON.stringify(completed),/input_transformations|thinking_dropped|prefix_binding_mismatch/u);assert.doesNotMatch(visible.join(''),/PRIVATE_SONNET_REASONING|SYNTHETIC_SONNET_SIGNATURE/u);assert.deepEqual(planned.providerOutput,assistant);
  for(const [exchange,wire] of [[first,body],[second,next]] as const){
    assert.equal(exchange.network.calls,1);assert.equal(exchange.network.ends,1);assert.equal(exchange.network.requests[0]!.body,wire);
    const headers=(exchange.network.requests[0]!.options as {headers:Record<string,string>}).headers;
    assert.equal(headers['anthropic-beta'],'thinking-binding-controls-2026-08-01');assert.equal(headers['anthropic-version'],'2026-10-21');assert.equal(headers['x-api-key'],'SYNTHETIC_Q11_OFFLINE_ONLY');
  }
});
