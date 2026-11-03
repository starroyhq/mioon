import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {DEFAULT_AGENT_CONFIGURATION} from '../packages/business/src/agent/presets.ts';
import {chatUsageRequest} from '../packages/business/src/agent/chat-usage-profile.ts';
import {buildTaskModelRequest,createTaskGateway,taskContinuation} from '../packages/business/src/agent/task-gateway-v2.ts';
import {createTaskUsageCollector} from '../packages/business/src/agent/task-usage-v2.ts';
import type {TaskModelOutput} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskModelUsage} from '../packages/business/src/agent/task-usage-v2.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import type {AgentTransportDependencies} from '../packages/business/src/agent/network-policy.ts';

const protocols=['chat_completions','responses','anthropic_messages'] as const;
type Protocol=typeof protocols[number];
const text='合成用量回复 🙂';
const json=(value:unknown):string=>`data: ${JSON.stringify(value)}\n\n`;
const native=(type:string,value:Record<string,unknown>={}):string=>`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`;
function configuration(protocol:Protocol):AgentConfiguration {
  return protocol==='responses'?{...DEFAULT_AGENT_CONFIGURATION,protocol}:{presetId:'minimax',platformId:'china',baseUrl:protocol==='chat_completions'?'https://api.minimax.cn/v1':'https://api.minimax.cn/anthropic',model:'MiniMax-M3',protocol};
}
function frames(protocol:Protocol,usage?:unknown,startUsage?:unknown,middleUsage?:unknown):string {
  if(protocol==='chat_completions')return json({choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]})+
    json({choices:[{index:0,delta:{},finish_reason:'stop'}]})+
    (usage===undefined?'':json({choices:[],usage}))+'data: [DONE]\n\n';
  if(protocol==='responses'){
    const id='x5_response',item={id:'x5_message',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
    return [
      {type:'response.created',response:{id,status:'in_progress',output:[]}},
      {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},
      {type:'response.output_text.delta',output_index:0,item_id:item.id,content_index:0,delta:text},
      {type:'response.output_item.done',output_index:0,item},
      {type:'response.completed',response:{id,status:'completed',output:[item],usage}},
    ].map(json).join('');
  }
  return native('message_start',{message:{id:'x5_message',type:'message',role:'assistant',model:'MiniMax-M3',content:[],stop_reason:null,stop_sequence:null,usage:startUsage}})+
    native('content_block_start',{index:0,content_block:{type:'text',text:''}})+
    native('content_block_delta',{index:0,delta:{type:'text_delta',text}})+native('content_block_stop',{index:0})+
    (middleUsage===undefined?'':native('message_delta',{delta:{stop_reason:null,stop_sequence:null},usage:middleUsage}))+
    native('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage})+native('message_stop');
}
/** The actual SDK and pinned transport consume fragmented SSE through an
 * in-memory TLS facade. No provider socket, DNS request or real key is used. */
async function exchange(protocol:Protocol,source:string,configurationOverride?:AgentConfiguration,bodyOverride?:string):Promise<TaskModelOutput> {
  const config=configurationOverride??configuration(protocol),body=bodyOverride??buildTaskModelRequest(config,[{role:'user',content:'离线用量验证'}],[]),bodies:string[]=[];
  const request=(_options:unknown,callback:(incoming:unknown)=>void)=>{
    const outgoing=Object.assign(new EventEmitter(),{setTimeout(){},destroy(){},end(value:string){
      bodies.push(value);const bytes=Buffer.from(source),chunks:Buffer[]=[];
      for(let position=0;position<bytes.length;position+=7)chunks.push(bytes.subarray(position,position+7));
      callback(Object.assign(Readable.from(chunks),{statusCode:200,headers:{'content-type':'text/event-stream'}}));
    }});
    queueMicrotask(()=>{
      const socket=Object.assign(new EventEmitter(),{remoteAddress:'8.8.8.8',remotePort:443,authorized:true,destroy(){}});
      outgoing.emit('socket',socket);socket.emit('secureConnect');
    });
    return outgoing;
  };
  const dependencies={lookup:async()=>[{address:'8.8.8.8',family:4}],httpsRequest:request} as unknown as AgentTransportDependencies;
  let output:TaskModelOutput|undefined;
  for await(const item of createTaskGateway(dependencies)({configuration:config,body,apiKey:'SYNTHETIC_X5_USAGE_ONLY'}))if(item.type==='done')output=item.output;
  assert.ok(output);assert.equal(output.text,text);assert.deepEqual(output.toolCalls,[]);assert.deepEqual(bodies,[body]);
  assert.doesNotMatch(JSON.stringify({provider:output.providerOutput,continuation:taskContinuation(protocol,output,[])}),/"(?:usage|cache_write_tokens|cache_read_input_tokens)"|PRIVATE_X5_USAGE/u);
  return output;
}

for(const platform of [
  {platformId:'china',baseUrl:'https://api.minimax.cn/v1'},
  {platformId:'international',baseUrl:'https://api.minimax.io/v1'},
])test(`MiniMax ${platform.platformId} requests usage only for its documented M3 endpoint`,()=>{
  const config={...configuration('chat_completions'),...platform};
  for(const baseUrl of [config.baseUrl,config.baseUrl+'/']){
    assert.equal(chatUsageRequest({...config,baseUrl}),true);
    const body=JSON.parse(buildTaskModelRequest({...config,baseUrl},[{role:'user',content:'合成请求'}],[])) as Record<string,unknown>;
    assert.deepEqual(body.stream_options,{include_usage:true});
  }
  const url=new URL(config.baseUrl);
  for(const patch of [
    {baseUrl:`https://compatible.example.com${url.pathname}`},
    {baseUrl:`${url.origin}:444${url.pathname}`},
    {baseUrl:`${url.origin}/proxy${url.pathname}`},
    {baseUrl:`https://${url.hostname}.example.com${url.pathname}`},
    {baseUrl:config.platformId==='china'?'https://api.minimax.io/v1':'https://api.minimax.cn/v1'},
    {presetId:'custom',platformId:'custom'},
    {platformId:'global'},
    {model:'unreviewed-next-model'},
    {protocol:'responses' as const},
    {protocol:'anthropic_messages' as const},
  ])assert.equal(chatUsageRequest({...config,...patch}),false,JSON.stringify(patch));
});

const full:Record<Protocol,unknown>={
  chat_completions:{prompt_tokens:120,completion_tokens:8,prompt_tokens_details:{cached_tokens:70,cache_write_tokens:20},private:'PRIVATE_X5_USAGE'},
  responses:{input_tokens:120,output_tokens:8,input_tokens_details:{cached_tokens:70,cache_write_tokens:20},private:'PRIVATE_X5_USAGE'},
  anthropic_messages:{input_tokens:30,output_tokens:8,cache_read_input_tokens:70,cache_creation_input_tokens:20,private:'PRIVATE_X5_USAGE'},
};
for(const protocol of protocols){
  test(`${protocol}: complete reported usage survives its real stream carrier`,async()=>{
    const output=await exchange(protocol,frames(protocol,full[protocol]));
    assert.deepEqual(output.usage,{inputTokens:120,outputTokens:8,cacheReadTokens:70,cacheWriteTokens:20});
  });
  test(`${protocol}: missing counters remain unknown without invalidating a completed reply`,async()=>{
    const usage=protocol==='chat_completions'?{prompt_tokens:120,completion_tokens:8}:protocol==='responses'?{input_tokens:120,output_tokens:8}:{input_tokens:30,output_tokens:8,cache_read_input_tokens:70};
    const output=await exchange(protocol,frames(protocol,usage));
    const expected:TaskModelUsage=protocol==='anthropic_messages'?{outputTokens:8,cacheReadTokens:70}:{inputTokens:120,outputTokens:8};
    assert.deepEqual(output.usage,expected);assert.equal(Object.hasOwn(output.usage,'cacheWriteTokens'),false);
  });
  test(`${protocol}: a complete stream without a usage event stays entirely unknown`,async()=>{
    const output=await exchange(protocol,frames(protocol));
    assert.equal(Object.hasOwn(output,'usage'),false);
  });
}

test('Messages combines reported start and delta components without dropping the start input',async()=>{
  const output=await exchange('anthropic_messages',frames('anthropic_messages',{cache_creation_input_tokens:30,output_tokens:8},{input_tokens:10,output_tokens:0},{cache_read_input_tokens:20,output_tokens:1}));
  assert.deepEqual(output.usage,{inputTokens:60,outputTokens:8,cacheReadTokens:20,cacheWriteTokens:30});
});
test('Messages missing cache writes cannot turn reported uncached input into a total; an explicit zero can',async()=>{
  const start={input_tokens:10,cache_read_input_tokens:20,output_tokens:0};
  const missing=await exchange('anthropic_messages',frames('anthropic_messages',{output_tokens:8},start));
  assert.deepEqual(missing.usage,{outputTokens:8,cacheReadTokens:20});
  const reported=await exchange('anthropic_messages',frames('anthropic_messages',{cache_creation_input_tokens:0,output_tokens:8},start));
  assert.deepEqual(reported.usage,{inputTokens:30,outputTokens:8,cacheReadTokens:20,cacheWriteTokens:0});
});
test('Chat Completions cache writes keep explicit zero, ignore malformed values and never use cache misses',()=>{
  for(const bad of [-1,0.5,Infinity,Number.MAX_SAFE_INTEGER+1,'0',null,undefined]){
    const collector=createTaskUsageCollector('chat_completions');
    collector.observe({prompt_tokens:100,completion_tokens:8,prompt_tokens_details:{cached_tokens:70,cache_write_tokens:bad},prompt_cache_miss_tokens:30});
    assert.deepEqual(collector.usage(),{inputTokens:100,outputTokens:8,cacheReadTokens:70});
  }
  const collector=createTaskUsageCollector('chat_completions');
  collector.observe({prompt_tokens:100,prompt_tokens_details:{cache_write_tokens:0}});
  assert.deepEqual(collector.usage(),{inputTokens:100,cacheWriteTokens:0});
  collector.observe({prompt_tokens:100,prompt_tokens_details:{cache_write_tokens:20}});
  collector.observe({prompt_tokens:100,prompt_tokens_details:{cache_write_tokens:0}});
  assert.deepEqual(collector.usage(),{inputTokens:100,cacheWriteTokens:20});
});
test('a frozen MiniMax request without include_usage is sent unchanged and does not fabricate usage',async()=>{
  const config=configuration('chat_completions'),current=JSON.parse(buildTaskModelRequest(config,[{role:'user',content:'离线用量验证'}],[])) as Record<string,unknown>;
  assert.deepEqual(current.stream_options,{include_usage:true});
  const frozen=JSON.stringify(Object.fromEntries(Object.entries(current).filter(([key])=>key!=='stream_options')));
  assert.equal(Buffer.byteLength(JSON.stringify(current))-Buffer.byteLength(frozen),40);
  const output=await exchange('chat_completions',frames('chat_completions'),config,frozen);
  assert.equal(Object.hasOwn(output,'usage'),false);
});
