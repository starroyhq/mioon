import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {AGENT_PRESETS,DEFAULT_AGENT_CONFIGURATION} from '../packages/business/src/agent/presets.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import type {AgentTransportDependencies} from '../packages/business/src/agent/network-policy.ts';
import {buildTaskModelRequest,createTaskGateway,taskContinuation} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskModelOutput} from '../packages/business/src/agent/task-gateway-v2.ts';
import {streamAnthropicMessages} from '../packages/business/src/agent/anthropic-stream.ts';
import type {AnthropicStreamItem,AnthropicStreamOptions} from '../packages/business/src/agent/anthropic-stream.ts';

const protocols=['chat_completions','responses','anthropic_messages'] as const;
const json=(value:unknown):string=>`data: ${JSON.stringify(value)}\n\n`;
const native=(type:string,value:Record<string,unknown>={}):string=>`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`;
const text='用量只是宿主测量 🙂';
function chatFrames({usage,earlyUsage,usageOnly=true}:{usage?:unknown;earlyUsage?:unknown;usageOnly?:boolean}={}):string {
  return json({choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}],usage:earlyUsage})+
    json({choices:[{index:0,delta:{},finish_reason:'stop'}],...(!usageOnly?{usage}:{})})+
    (usageOnly&&usage!==undefined?json({choices:[],usage}):'')+'data: [DONE]\n\n';
}
function responseFrames(usage?:unknown):string {
  const id='response_usage',item={id:'message_usage',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
  return [
    {type:'response.created',response:{id,status:'in_progress',output:[]}},
    {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},
    {type:'response.output_text.delta',output_index:0,item_id:item.id,content_index:0,delta:text},
    {type:'response.output_item.done',output_index:0,item},
    {type:'response.completed',response:{id,status:'completed',output:[item],usage}},
  ].map(json).join('');
}
function anthropicFrames({startUsage,finalUsage,middleUsage}:{startUsage?:unknown;finalUsage?:unknown;middleUsage?:unknown}={}):string {
  return native('message_start',{message:{id:'message_usage',type:'message',role:'assistant',model:'fixture-model',content:[],stop_reason:null,stop_sequence:null,usage:startUsage}})+
    native('content_block_start',{index:0,content_block:{type:'text',text:''}})+
    native('content_block_delta',{index:0,delta:{type:'text_delta',text}})+native('content_block_stop',{index:0})+
    (middleUsage===undefined?'':native('message_delta',{delta:{stop_reason:null,stop_sequence:null},usage:middleUsage}))+
    native('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:finalUsage})+native('message_stop');
}
function configuration(protocol:AgentConfiguration['protocol']):AgentConfiguration {
  return protocol==='anthropic_messages'?{presetId:'anthropic',platformId:'global',baseUrl:'https://api.anthropic.com',model:'claude-haiku-4-5',protocol}:{...DEFAULT_AGENT_CONFIGURATION,protocol};
}
// The real SDK and pinned transport run against this in-memory TLS facade.
// Nothing opens a provider socket, resolves DNS, or uses a real credential.
function network(frames:string) {
  const bodies:string[]=[];
  const request=(_options:unknown,callback:(incoming:unknown)=>void)=>{
    const outgoing=Object.assign(new EventEmitter(),{setTimeout(){},destroy(){},end(body:string){
      bodies.push(body);
      const bytes=Buffer.from(frames),chunks:Buffer[]=[];
      for(let position=0;position<bytes.length;position+=13)chunks.push(bytes.subarray(position,position+13));
      callback(Object.assign(Readable.from(chunks),{statusCode:200,headers:{'content-type':'text/event-stream'}}));
    }});
    queueMicrotask(()=>{
      const socket=Object.assign(new EventEmitter(),{remoteAddress:'8.8.8.8',remotePort:443,authorized:true,destroy(){}});
      outgoing.emit('socket',socket);socket.emit('secureConnect');
    });
    return outgoing;
  };
  return {bodies,dependencies:{lookup:async()=>[{address:'8.8.8.8',family:4}],httpsRequest:request} as unknown as AgentTransportDependencies};
}
async function exchange(protocol:AgentConfiguration['protocol'],frames:string,body?:string) {
  const config=configuration(protocol),wire=body??buildTaskModelRequest(config,[{role:'user',content:'仅合成响应'}],[]),connection=network(frames);
  let output:TaskModelOutput|undefined;
  for await(const item of createTaskGateway(connection.dependencies)({configuration:config,body:wire,apiKey:'SYNTHETIC_H1E_GATEWAY_ONLY'}))if(item.type==='done')output=item.output;
  assert.ok(output);assert.deepEqual(connection.bodies,[wire]);
  assert.equal(output.text,text);assert.deepEqual(output.toolCalls,[]);
  assert.doesNotMatch(JSON.stringify(output.providerOutput),/"(?:usage|cached_tokens|cache_read_input_tokens)"|PRIVATE_USAGE_METADATA/u);
  assert.doesNotMatch(JSON.stringify(taskContinuation(protocol,output,[])),/"(?:usage|cached_tokens|cache_read_input_tokens)"|PRIVATE_USAGE_METADATA/u);
  return output;
}

test('H1e Chat Completions requests ask for usage only on documentation-backed presets',()=>{
  const supported=new Set(['openai','qwen','deepseek']);
  for(const preset of AGENT_PRESETS){
    const platform=preset.platforms.find(item=>item.baseUrl)||preset.platforms[0]!;
    const config:AgentConfiguration={presetId:preset.id,platformId:platform.id,baseUrl:platform.baseUrl||'https://compatible.example.com/v1',model:platform.model||'fixture-model',protocol:'chat_completions'};
    const body=JSON.parse(buildTaskModelRequest(config,[{role:'user',content:'合成编译'}],[])) as Record<string,unknown>;
    assert.deepEqual(body.stream_options,supported.has(preset.id)?{include_usage:true}:undefined,preset.id);
    assert.equal(body.max_tokens??body.max_completion_tokens,4096);
  }
  for(const protocol of ['responses','anthropic_messages'] as const){
    const body=JSON.parse(buildTaskModelRequest(configuration(protocol),[{role:'user',content:'合成编译'}],[])) as Record<string,unknown>;
    assert.equal(body.stream_options,undefined);
    assert.equal(body.max_tokens??body.max_output_tokens,4096);
  }
});
test('H1e Chat Completions usage requests require the documented official origin and base path',()=>{
  const official:AgentConfiguration[]=[
    {...DEFAULT_AGENT_CONFIGURATION,baseUrl:'https://api.openai.com/v1/'},
    {presetId:'deepseek',platformId:'global',protocol:'chat_completions',model:'deepseek-flash',baseUrl:'https://api.deepseek.com'},
    {presetId:'deepseek',platformId:'global',protocol:'chat_completions',model:'deepseek-flash',baseUrl:'https://api.deepseek.com/v1'},
    {presetId:'qwen',platformId:'beijing',protocol:'chat_completions',model:'qwen-plus',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1'},
    {presetId:'qwen',platformId:'singapore',protocol:'chat_completions',model:'qwen-plus',baseUrl:'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'},
  ];
  for(const config of official){
    const build=(value:AgentConfiguration)=>JSON.parse(buildTaskModelRequest(value,[{role:'user',content:'端点编译'}],[])) as Record<string,unknown>;
    assert.deepEqual(build(config).stream_options,{include_usage:true},config.baseUrl);
    const url=new URL(config.baseUrl);
    for(const baseUrl of [`https://compatible.example.com${url.pathname}`,`${url.origin}:444${url.pathname}`,`${url.origin}/proxy${url.pathname}`,`https://${url.hostname}.example.com${url.pathname}`]){
      assert.equal(build({...config,baseUrl}).stream_options,undefined,baseUrl);
    }
    assert.equal(build({...config,presetId:'custom',platformId:'custom'}).stream_options,undefined);
  }
});
test('H1e unverified Qwen workspace endpoints remain passive without changing configuration admission',()=>{
  for(const region of ['cn-beijing','ap-southeast-1','us-east-1','cn-hongkong','ap-northeast-1','eu-central-1']){
    const config:AgentConfiguration={presetId:'qwen',platformId:`workspace-${region}`,protocol:'chat_completions',model:'qwen-plus',baseUrl:`https://workspace.${region}.maas.aliyuncs.com/compatible-mode/v1`};
    const body=JSON.parse(buildTaskModelRequest(config,[{role:'user',content:'工作空间编译'}],[])) as Record<string,unknown>;
    assert.equal(body.stream_options,undefined);assert.equal(body.model,config.model);
  }
});

test('H1e Chat Completions captures the final empty choices usage frame before continuing',async()=>{
  const output=await exchange('chat_completions',chatFrames({usage:{prompt_tokens:120,completion_tokens:8,prompt_tokens_details:{cached_tokens:70},private:'PRIVATE_USAGE_METADATA'}}));
  assert.deepEqual(output.usage,{inputTokens:120,outputTokens:8,cacheReadTokens:70});
});
test('H1e Chat Completions also captures usage in the finish chunk and DeepSeek cache hits',async()=>{
  const output=await exchange('chat_completions',chatFrames({usageOnly:false,usage:{prompt_tokens:120,completion_tokens:8,prompt_cache_hit_tokens:90,prompt_cache_miss_tokens:30}}));
  assert.deepEqual(output.usage,{inputTokens:120,outputTokens:8,cacheReadTokens:90});
  assert.equal(Object.hasOwn(output.usage,'cacheWriteTokens'),false);
});
test('H1e Chat Completions cumulative or malformed later measurements do not erase valid counters',async()=>{
  const output=await exchange('chat_completions',chatFrames({earlyUsage:{prompt_tokens:120,completion_tokens:8,prompt_tokens_details:{cached_tokens:70}},usage:{prompt_tokens:110,completion_tokens:'bad',prompt_tokens_details:{cached_tokens:-1}}}));
  assert.deepEqual(output.usage,{inputTokens:120,outputTokens:8,cacheReadTokens:70});
});
test('H1e Responses reads cache counters from the validated completed response',async()=>{
  const output=await exchange('responses',responseFrames({input_tokens:120,output_tokens:8,input_tokens_details:{cached_tokens:70,cache_write_tokens:25},private:'PRIVATE_USAGE_METADATA'}));
  assert.deepEqual(output.usage,{inputTokens:120,outputTokens:8,cacheReadTokens:70,cacheWriteTokens:25});
});
test('H1e Anthropic merges cumulative start and delta input components without adding snapshots',async()=>{
  const output=await exchange('anthropic_messages',anthropicFrames({
    startUsage:{input_tokens:10,output_tokens:1,cache_read_input_tokens:50,cache_creation_input_tokens:20},
    middleUsage:{input_tokens:12,output_tokens:3,cache_read_input_tokens:55,cache_creation_input_tokens:25},
    finalUsage:{input_tokens:12,output_tokens:8,cache_read_input_tokens:55,cache_creation_input_tokens:25,private:'PRIVATE_USAGE_METADATA'},
  }));
  assert.deepEqual(output.usage,{inputTokens:92,outputTokens:8,cacheReadTokens:55,cacheWriteTokens:25});
});
test('H1e Anthropic missing cache components stay unknown while reported zeros remain zero',async()=>{
  const partial=await exchange('anthropic_messages',anthropicFrames({startUsage:{input_tokens:10,output_tokens:0},finalUsage:{output_tokens:8}}));
  assert.deepEqual(partial.usage,{outputTokens:8});
  const zero=await exchange('anthropic_messages',anthropicFrames({startUsage:{input_tokens:10,cache_read_input_tokens:0,cache_creation_input_tokens:0},finalUsage:{output_tokens:0}}));
  assert.deepEqual(zero.usage,{inputTokens:10,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0});
});
test('H1e Anthropic start-only and final-only usage retain independently known measurements',async()=>{
  const startOnly=await exchange('anthropic_messages',anthropicFrames({startUsage:{input_tokens:10,output_tokens:1,cache_read_input_tokens:50,cache_creation_input_tokens:20}}));
  assert.deepEqual(startOnly.usage,{inputTokens:80,outputTokens:1,cacheReadTokens:50,cacheWriteTokens:20});
  const finalOnly=await exchange('anthropic_messages',anthropicFrames({finalUsage:{input_tokens:10,output_tokens:8,cache_read_input_tokens:50,cache_creation_input_tokens:20}}));
  assert.deepEqual(finalOnly.usage,{inputTokens:80,outputTokens:8,cacheReadTokens:50,cacheWriteTokens:20});
});
for(const protocol of protocols){
  test(`H1e ${protocol}: missing usage completes without inventing measurements`,async()=>{
    const frames=protocol==='chat_completions'?chatFrames():protocol==='responses'?responseFrames():anthropicFrames();
    assert.equal(Object.hasOwn(await exchange(protocol,frames),'usage'),false);
  });
  test(`H1e ${protocol}: invalid passive usage cannot fail an otherwise valid reply`,async()=>{
    const malformed={prompt_tokens:-1,completion_tokens:'bad',input_tokens:'bad',output_tokens:-1,cache_read_input_tokens:1.5,cache_creation_input_tokens:-2,unknown:'PRIVATE_USAGE_METADATA'};
    const frames=protocol==='chat_completions'?chatFrames({usage:malformed}):protocol==='responses'?responseFrames(malformed):anthropicFrames({startUsage:malformed,finalUsage:malformed});
    assert.equal(Object.hasOwn(await exchange(protocol,frames),'usage'),false);
  });
  test(`H1e ${protocol}: previously saved request bodies pass through the real SDK unchanged`,async()=>{
    const parsed=JSON.parse(buildTaskModelRequest(configuration(protocol),[{role:'user',content:'历史 intent'}],[])) as Record<string,unknown>;
    delete parsed.stream_options;
    // Reproduce a pre-H1e Anthropic system string and unmarked content.
    if(protocol==='anthropic_messages'){
      if(Array.isArray(parsed.system))parsed.system=parsed.system.map(value=>(value as {text:string}).text).join('\n\n');
      parsed.messages=[{role:'user',content:[{type:'text',text:'历史 intent'}]}];
    }
    // Saved intents use the builder's compact JSON; SDK exact-body admission
    // already rejects arbitrary alternative serializations before H1e.
    const wire=JSON.stringify(parsed),frames=protocol==='chat_completions'?chatFrames():protocol==='responses'?responseFrames():anthropicFrames();
    await exchange(protocol,frames,wire);
  });
}

async function collectNative(source:string,patch:Partial<AnthropicStreamOptions>={}) {
  const result:AnthropicStreamItem[]=[];
  for await(const item of streamAnthropicMessages((async function*(){yield Buffer.from(source);})(),{maxOutputBytes:128*1024,maxArgumentBytes:32*1024,maxToolCalls:30,...patch}))result.push(item);
  return result;
}
test('H1e optional Anthropic usage mode leaves the legacy default strict and never synthesizes legacy totals',async()=>{
  await assert.rejects(collectNative(anthropicFrames()),{code:'AGENT_CHAT_PROTOCOL_ERROR'});
  const required=anthropicFrames({startUsage:{input_tokens:10,output_tokens:1},finalUsage:{output_tokens:8}});
  const legacy=(await collectNative(required)).at(-1)!;
  assert.equal(legacy.type,'done');if(legacy.type!=='done')assert.fail();
  assert.deepEqual(legacy.completion.usage,{prompt_tokens:10,completion_tokens:8,total_tokens:18});
  const optional=(await collectNative(required,{usageMode:'optional'})).at(-1)!;
  assert.equal(optional.type,'done');if(optional.type!=='done')assert.fail();
  assert.equal(Object.hasOwn(optional.completion,'usage'),false);
});
test('H1e Anthropic missing usage still seals a complete client tool call before exposing it',async()=>{
  const config=configuration('anthropic_messages'),tool={name:'mioon_shot_create',description:'Create a saved shot',parameters:{type:'object',properties:{title:{type:'string'}},required:['title'],additionalProperties:false}};
  const body=buildTaskModelRequest(config,[{role:'user',content:'合成工具回复'}],[tool]);
  const frames=native('message_start',{message:{id:'tool_message',type:'message',role:'assistant',model:'fixture-model',content:[],stop_reason:null,stop_sequence:null}})+
    native('content_block_start',{index:0,content_block:{type:'tool_use',id:'tool_synthetic',name:tool.name,input:{}}})+
    native('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:'{"title":"合成镜头"}'}})+native('content_block_stop',{index:0})+
    native('message_delta',{delta:{stop_reason:'tool_use',stop_sequence:null}})+native('message_stop');
  const connection=network(frames);let output:TaskModelOutput|undefined;
  for await(const item of createTaskGateway(connection.dependencies)({configuration:config,body,apiKey:'SYNTHETIC_H1E_GATEWAY_ONLY'}))if(item.type==='done')output=item.output;
  assert.ok(output);assert.deepEqual(output.toolCalls,[{id:'tool_synthetic',name:tool.name,arguments:{title:'合成镜头'}}]);
  assert.equal(Object.hasOwn(output,'usage'),false);assert.deepEqual(connection.bodies,[body]);
});
test('H1e optional Anthropic usage does not relax stop, framing, reasoning or server-tool checks',async()=>{
  const valid=anthropicFrames(),patch={usageMode:'optional'} as const;
  await assert.rejects(collectNative(valid.replace(native('message_stop'),''),patch),{code:'AGENT_CHAT_TRUNCATED'});
  await assert.rejects(collectNative(valid+native('message_stop'),patch),{code:'AGENT_CHAT_PROTOCOL_ERROR'});
  await assert.rejects(collectNative(valid.replace('"stop_reason":"end_turn"','"stop_reason":"tool_use"'),patch),{code:'AGENT_CHAT_PROTOCOL_ERROR'});
  for(const [usage,code] of [
    [{output_tokens_details:{thinking_tokens:1}},'AGENT_CHAT_REASONING_UNSUPPORTED'],
    [{server_tool_use:{web_fetch_requests:1,web_search_requests:0}},'AGENT_CHAT_TOOLS_UNSUPPORTED'],
  ] as const)await assert.rejects(collectNative(anthropicFrames({startUsage:usage}),patch),{code});
});
