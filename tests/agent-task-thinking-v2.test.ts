import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import {AGENT_PRESETS} from '../packages/business/src/agent/presets.ts';
import {AGENT_CHAT_PROFILES,AGENT_RESPONSES_PROFILES,agentAnthropicThinkingFields,agentChatProfile,agentModelThinkingTier,agentRequestThinks,agentResponsesProfile} from '../packages/business/src/agent/model-profiles.ts';
import {ANTHROPIC_MESSAGES_FIELDS,ANTHROPIC_THINKING_FIELDS} from '../packages/business/src/agent/anthropic-protocol.ts';
import {anthropicMessages} from '../packages/business/src/agent/anthropic-wire.ts';
import {buildTaskModelRequest,createTaskGateway,taskContinuation,TASK_MODEL_LIMITS} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskModelItem,TaskModelOutput} from '../packages/business/src/agent/task-gateway-v2.ts';
import {assembleModelInput,assembleRunContext} from '../packages/business/src/agent/task-context-v2.ts';
import type {TaskModelContextFragment} from '../packages/business/src/agent/task-context-v2.ts';
import type {AgentTaskJson} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AnthropicNativeStreamEvent} from '../packages/business/src/agent/anthropic-sdk-transport.ts';
import {nativeAnthropicEvents,nativeAnthropicSse} from './helpers/anthropic-native-events.ts';

type Protocol=AgentConfiguration['protocol'];
const definitions=[{name:'mioon_shot_create',description:'Create a saved shot',parameters:{type:'object',properties:{title:{type:'string'}},required:['title'],additionalProperties:false}}];
const history:AgentTaskJson[]=[{role:'user',content:'创建一个镜头'}];
const argumentsJson=JSON.stringify({title:'Thought shot'});
const call={id:'call_thought',name:'mioon_shot_create',arguments:{title:'Thought shot'}};
const json=(value:unknown):string=>`data: ${JSON.stringify(value)}\n\n`;
const optionalPresets:Record<Exclude<Protocol,'anthropic_messages'>,string[]>={chat_completions:['deepseek','qwen','zhipu','kimi','minimax','ollama'],responses:['deepseek','qwen','ollama']};

function presetConfiguration(presetId:string,protocol:Protocol):AgentConfiguration{
  const preset=AGENT_PRESETS.find(item=>item.id===presetId)!,platform=preset.platforms.find(item=>item.baseUrl)??preset.platforms[0]!;
  return {presetId:preset.id as AgentConfiguration['presetId'],platformId:platform.id,protocol,
    baseUrl:protocol==='anthropic_messages'&&preset.id==='ollama'?new URL(platform.baseUrl).origin:platform.baseUrl||'https://example.com/v1',
    model:(protocol==='responses'?preset.supportedModelHints?.responses?.[0]:undefined)||platform.model||'synthetic-mio'};
}
function offSwitch(configuration:AgentConfiguration):Readonly<Record<string,unknown>>{
  return configuration.protocol==='chat_completions'?agentChatProfile(configuration).fields:configuration.protocol==='responses'?agentResponsesProfile(configuration).fields:ANTHROPIC_MESSAGES_FIELDS;
}
/** Ollama's qwen3:8b is optional in every protocol. Without its off switch the
 * request may think, which is the request a required model would send. */
function thinkingBody(configuration:AgentConfiguration,messages:readonly AgentTaskJson[]):string{
  const body=JSON.parse(buildTaskModelRequest(configuration,[...messages],definitions,4318)) as Record<string,unknown>;
  if(configuration.protocol==='chat_completions')body.reasoning_effort='medium';
  else if(configuration.protocol==='responses')body.reasoning={effort:'medium'};
  else Object.assign(body,ANTHROPIC_THINKING_FIELDS);
  assert.equal(agentRequestThinks(configuration,body),true);
  return JSON.stringify(body);
}
async function loopback(t:TestContext,protocol:Protocol,responses:string[]){
  const requests:string[]=[];
  const server=http.createServer(async(request,response)=>{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk as Uint8Array));
    requests.push(Buffer.concat(chunks).toString());
    response.writeHead(200,{'Content-Type':'text/event-stream'});response.end(responses.shift()??'');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();}));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const configuration:AgentConfiguration={presetId:'ollama',platformId:'local',protocol,model:'qwen3:8b',baseUrl:`http://127.0.0.1:${address.port}${protocol==='anthropic_messages'?'':'/v1'}`};
  async function send(body:string):Promise<{items:TaskModelItem[];output:TaskModelOutput}>{
    const items:TaskModelItem[]=[];
    for await(const item of createTaskGateway()({configuration,body,apiKey:null,selfPort:4318}))items.push(item);
    const last=items.at(-1);assert.ok(last?.type==='done');
    return {items,output:last.output};
  }
  return {configuration,requests,send};
}
const deltas=(items:readonly TaskModelItem[]):TaskModelItem[]=>items.filter(item=>item.type==='delta');

test('thinking tiers follow each preset profile, and every task request keeps thinking off',()=>{
  for(const profile of [...Object.values(AGENT_CHAT_PROFILES),...Object.values(AGENT_RESPONSES_PROFILES)])assert.notEqual(profile.thinkingTier,'required','no catalog model requires thinking yet');
  let combinations=0;
  for(const preset of AGENT_PRESETS)for(const protocol of preset.availableProtocols){
    const configuration=presetConfiguration(preset.id,protocol),tier=agentModelThinkingTier(configuration),label=`${preset.id}/${protocol}`;
    assert.equal(tier,protocol==='anthropic_messages'||optionalPresets[protocol].includes(preset.id)?'optional':'unsupported',label);
    const body=JSON.parse(buildTaskModelRequest(configuration,history,definitions,4318)) as Record<string,unknown>;
    assert.equal(agentRequestThinks(configuration,body),false,`${label} sends its documented off switch`);
    if(protocol==='anthropic_messages')assert.deepEqual(body.thinking,{type:'disabled'});
    // Only an optional model's off switch can be lifted; an unsupported or
    // unverified model never admits thinking, whatever the request contains.
    const off=offSwitch(configuration),lifted=Object.fromEntries(Object.entries(body).filter(([key])=>!Object.hasOwn(off,key)));
    assert.equal(agentRequestThinks(configuration,lifted),tier==='optional',label);
    combinations++;
  }
  assert.ok(combinations>=30);
});
test('Messages turns thinking on only for a required model, with the smallest manual budget below max_tokens',()=>{
  for(const tier of ['unsupported','optional'] as const)assert.equal(agentAnthropicThinkingFields(tier),ANTHROPIC_MESSAGES_FIELDS);
  assert.equal(agentAnthropicThinkingFields('required'),ANTHROPIC_THINKING_FIELDS);
  assert.deepEqual(ANTHROPIC_THINKING_FIELDS,{thinking:{type:'enabled',budget_tokens:1024}});
  const configuration=presetConfiguration('anthropic','anthropic_messages'),body=JSON.parse(buildTaskModelRequest(configuration,history,definitions,4318)) as Record<string,unknown>;
  assert.ok(ANTHROPIC_THINKING_FIELDS.thinking.budget_tokens<(body.max_tokens as number),'thinking tokens count toward max_tokens');
  assert.deepEqual(body.tool_choice,{type:'auto',disable_parallel_tool_use:true},'thinking accepts only automatic tool choice');
  assert.equal(agentRequestThinks(configuration,{...body,...ANTHROPIC_THINKING_FIELDS}),true);
});

test('Chat Completions: a thinking request keeps reasoning_content out of text and returns it with its tool call in this round',async t=>{
  const planned=json({choices:[{index:0,delta:{role:'assistant',reasoning_content:'先确认项目，'},finish_reason:null}]})+json({choices:[{index:0,delta:{reasoning_content:'再创建镜头。'},finish_reason:null}]})+
    json({choices:[{index:0,delta:{tool_calls:[{index:0,id:call.id,type:'function',function:{name:call.name,arguments:argumentsJson}}]},finish_reason:null}]})+json({choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'data: [DONE]\n\n';
  const answer=json({choices:[{index:0,delta:{role:'assistant',reasoning_content:'镜头已创建。'},finish_reason:null}]})+json({choices:[{index:0,delta:{content:'完成'},finish_reason:null}]})+json({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n';
  const f=await loopback(t,'chat_completions',[planned,answer]),first=await f.send(thinkingBody(f.configuration,history));
  assert.deepEqual(deltas(first.items),[],'reasoning never streams as visible text');
  assert.equal(first.output.text,'');assert.deepEqual(first.output.toolCalls,[call]);
  assert.deepEqual(first.output.providerOutput,{role:'assistant',content:null,reasoning_content:'先确认项目，再创建镜头。',tool_calls:[{id:call.id,type:'function',function:{name:call.name,arguments:argumentsJson}}]});
  assert.doesNotThrow(()=>taskContinuation('chat_completions',first.output,[{callId:call.id,result:null}]),'the runtime retention probe accepts retained reasoning');
  const continuation=taskContinuation('chat_completions',first.output,[{callId:call.id,result:{created:true}}]);
  assert.deepEqual(continuation,[first.output.providerOutput,{role:'tool',tool_call_id:call.id,content:'{"created":true}'}]);
  const last=await f.send(thinkingBody(f.configuration,[...history,...continuation]));
  assert.equal(last.output.text,'完成');assert.deepEqual(deltas(last.items),[{type:'delta',text:'完成'}]);
  assert.equal((last.output.providerOutput as {reasoning_content?:string}).reasoning_content,'镜头已创建。');
  assert.deepEqual((JSON.parse(f.requests[1]!) as {messages:unknown[]}).messages.slice(2),continuation,'the next request in this round returns the reasoning');
});
test('Chat Completions: reasoning without a thinking request, or in another carrier, still fails closed',async t=>{
  const reply=(delta:Record<string,unknown>):string=>json({choices:[{index:0,delta:{role:'assistant',...delta},finish_reason:null}]})+json({choices:[{index:0,delta:{content:'完成'},finish_reason:null}]})+json({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n';
  const f=await loopback(t,'chat_completions',[reply({reasoning_content:'PRIVATE'}),reply({reasoning_details:[{type:'reasoning.text',text:'PRIVATE'}]}),reply({thinking:'PRIVATE'})]);
  await assert.rejects(f.send(buildTaskModelRequest(f.configuration,history,definitions,4318)),{code:'AGENT_CHAT_REASONING_UNSUPPORTED'});
  for(let index=0;index<2;index++)await assert.rejects(f.send(thinkingBody(f.configuration,history)),{code:'AGENT_CHAT_REASONING_UNSUPPORTED'});
  assert.equal(f.requests.length,3);
});

function responsesThinking(){
  const id='resp_thought',reasoning={id:'rs_thought',type:'reasoning',summary:[{type:'summary_text',text:'Plan one shot.'}],content:[{type:'reasoning_text',text:'Check, then create.'}],encrypted_content:'SYNTHETIC_ENCRYPTED_REASONING'};
  const item={id:'fc_thought',type:'function_call',call_id:call.id,name:call.name,arguments:argumentsJson,status:'completed'};
  const frames=[
    {type:'response.created',response:{id,status:'in_progress',output:[]}},
    {type:'response.output_item.added',output_index:0,item:{id:reasoning.id,type:'reasoning',summary:[]}},
    {type:'response.reasoning_summary_part.added',output_index:0,item_id:reasoning.id,summary_index:0,part:{type:'summary_text',text:''}},
    {type:'response.reasoning_summary_text.delta',output_index:0,item_id:reasoning.id,summary_index:0,delta:'Plan one shot.'},
    {type:'response.reasoning_summary_text.done',output_index:0,item_id:reasoning.id,summary_index:0,text:'Plan one shot.'},
    {type:'response.reasoning_summary_part.done',output_index:0,item_id:reasoning.id,summary_index:0,part:{type:'summary_text',text:'Plan one shot.'}},
    {type:'response.reasoning_text.delta',output_index:0,item_id:reasoning.id,content_index:0,delta:'Check, then create.'},
    {type:'response.reasoning_text.done',output_index:0,item_id:reasoning.id,content_index:0,text:'Check, then create.'},
    {type:'response.output_item.done',output_index:0,item:reasoning},
    {type:'response.output_item.added',output_index:1,item:{...item,arguments:'',status:'in_progress'}},
    {type:'response.function_call_arguments.delta',output_index:1,item_id:item.id,delta:argumentsJson},
    {type:'response.function_call_arguments.done',output_index:1,item_id:item.id,name:item.name,arguments:argumentsJson},
    {type:'response.output_item.done',output_index:1,item},
    {type:'response.completed',response:{id,status:'completed',output:[reasoning,item]}},
  ];
  return {reasoning,item,frames:frames.map(json).join('')};
}
function responsesText(text:string):string{
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
test('Responses: a thinking request keeps the exact reasoning item, encrypted reasoning included, for this round',async t=>{
  const {reasoning,item,frames}=responsesThinking();
  const f=await loopback(t,'responses',[frames,responsesText('完成')]),first=await f.send(thinkingBody(f.configuration,history));
  assert.deepEqual(deltas(first.items),[],'reasoning summaries and text never stream as visible text');
  assert.equal(first.output.text,'');assert.deepEqual(first.output.toolCalls,[call]);assert.deepEqual(first.output.providerOutput,[reasoning,item]);
  assert.doesNotThrow(()=>taskContinuation('responses',first.output,[{callId:call.id,result:null}]));
  const continuation=taskContinuation('responses',first.output,[{callId:call.id,result:{created:true}}]);
  assert.deepEqual(continuation,[reasoning,item,{type:'function_call_output',call_id:call.id,output:'{"created":true}'}]);
  const last=await f.send(thinkingBody(f.configuration,[...history,...continuation]));
  assert.equal(last.output.text,'完成');
  assert.deepEqual((JSON.parse(f.requests[1]!) as {input:unknown[]}).input.slice(1),continuation,'the next request in this round returns the reasoning item');
});
test('Responses: an unrequested reasoning item, or one with another reasoning carrier, never completes',async t=>{
  const {frames}=responsesThinking(),forged=frames.replace('"encrypted_content":"SYNTHETIC_ENCRYPTED_REASONING"','"encrypted_content":"SYNTHETIC_ENCRYPTED_REASONING","reasoning_content":"PRIVATE"');
  const f=await loopback(t,'responses',[frames,forged]);
  await assert.rejects(f.send(buildTaskModelRequest(f.configuration,history,definitions,4318)),{code:'AGENT_CHAT_TOOLS_UNSUPPORTED'});
  await assert.rejects(f.send(thinkingBody(f.configuration,history)),{code:'AGENT_CHAT_PROTOCOL_ERROR'});
  assert.equal(f.requests.length,2);
});

const signatureDelta:AnthropicNativeStreamEvent={type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'SYNTHETIC_SIGNATURE'}};
function messagesThinking({signature=true}:{signature?:boolean}={}):string{
  const base=nativeAnthropicEvents({model:'qwen3:8b',toolName:call.name,argumentsJson}),finish=base[4] as Extract<AnthropicNativeStreamEvent,{type:'message_delta'}>;
  return nativeAnthropicSse([base[0]!,
    {type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'',signature:''}},
    {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'先确认项目，'}},
    {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'再创建镜头。'}},
    ...(signature?[signatureDelta]:[]),
    {type:'content_block_stop',index:0},
    {type:'content_block_start',index:1,content_block:{type:'redacted_thinking',data:'SYNTHETIC_REDACTED_THINKING'}},
    {type:'content_block_stop',index:1},
    {type:'content_block_start',index:2,content_block:{type:'text',text:'',citations:null}},
    {type:'content_block_delta',index:2,delta:{type:'text_delta',text:'我先创建镜头。'}},
    {type:'content_block_stop',index:2},
    {type:'content_block_start',index:3,content_block:{type:'tool_use',id:call.id,name:call.name,input:{},caller:{type:'direct'},toolset_name:null}},
    {type:'content_block_delta',index:3,delta:{type:'input_json_delta',partial_json:argumentsJson}},
    {type:'content_block_stop',index:3},
    {...finish,usage:{...finish.usage,output_tokens_details:{thinking_tokens:12}}},
    base[5]!,
  ]);
}
test('Messages: a thinking request keeps signed and redacted thinking in order, out of text, and returns it unchanged in this round',async t=>{
  const thinking={type:'thinking',thinking:'先确认项目，再创建镜头。',signature:'SYNTHETIC_SIGNATURE'},redacted={type:'redacted_thinking',data:'SYNTHETIC_REDACTED_THINKING'};
  const f=await loopback(t,'anthropic_messages',[messagesThinking(),nativeAnthropicSse(nativeAnthropicEvents({model:'qwen3:8b',text:'完成'}))]);
  const first=await f.send(thinkingBody(f.configuration,history));
  assert.deepEqual(deltas(first.items),[{type:'delta',text:'我先创建镜头。'}]);assert.equal(first.output.text,'我先创建镜头。');assert.deepEqual(first.output.toolCalls,[call]);
  assert.deepEqual(first.output.providerOutput,{role:'assistant',content:[thinking,redacted,{type:'text',text:'我先创建镜头。'},{type:'tool_use',id:call.id,name:call.name,input:call.arguments}]});
  assert.doesNotThrow(()=>taskContinuation('anthropic_messages',first.output,[{callId:call.id,result:null}]));
  const continuation=taskContinuation('anthropic_messages',first.output,[{callId:call.id,result:{created:true}}]);
  assert.deepEqual(continuation,[first.output.providerOutput,{role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:'{"created":true}'}]}]);
  const last=await f.send(thinkingBody(f.configuration,[...history,...continuation]));
  assert.equal(last.output.text,'完成');
  assert.deepEqual((JSON.parse(f.requests[1]!) as {messages:unknown[]}).messages.slice(1),continuation);
  for(const block of [thinking,redacted])assert.ok(f.requests[1]!.includes(JSON.stringify(block)),`${block.type} returns byte-for-byte`);
});
test('Messages: thinking without a thinking request, or without its signature, never completes',async t=>{
  const f=await loopback(t,'anthropic_messages',[messagesThinking(),messagesThinking({signature:false})]);
  await assert.rejects(f.send(buildTaskModelRequest(f.configuration,history,definitions,4318)),{code:'AGENT_CHAT_REASONING_UNSUPPORTED'});
  await assert.rejects(f.send(thinkingBody(f.configuration,history)),{code:'AGENT_CHAT_PROTOCOL_ERROR'});
  assert.equal(f.requests.length,2);
});
test('Messages history admits retained thinking only as signed assistant blocks',()=>{
  const use={type:'tool_use',id:call.id,name:call.name,input:call.arguments},result={role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:'{}'}]};
  const thinking={type:'thinking',thinking:'',signature:'SYNTHETIC_SIGNATURE'},redacted={type:'redacted_thinking',data:'SYNTHETIC_REDACTED_THINKING'};
  assert.deepEqual(anthropicMessages([{role:'assistant',content:[thinking,redacted,use]},result]).messages[0],{role:'assistant',content:[thinking,redacted,use]});
  for(const content of [[{...thinking,signature:''},use],[{type:'thinking',thinking:'x'},use],[{...redacted,data:''},use],[{...thinking,cache_control:{type:'ephemeral'}},use]])
    assert.throws(()=>anthropicMessages([{role:'assistant',content},result]),{code:'AGENT_CHAT_VALIDATION'});
  assert.throws(()=>anthropicMessages([{role:'user',content:[thinking]}]),{code:'AGENT_CHAT_VALIDATION'});
});

function thinkingOutput(protocol:Protocol,index:number):TaskModelOutput{
  const id=`call_${index}`,marker=`PRIVATE_THINKING_${index}`,toolCalls=[{id,name:call.name,arguments:{title:'x'}}];
  if(protocol==='chat_completions')return {text:'',toolCalls,providerOutput:{role:'assistant',content:null,reasoning_content:marker,tool_calls:[{id,type:'function',function:{name:call.name,arguments:'{"title":"x"}'}}]}};
  if(protocol==='responses')return {text:'',toolCalls,providerOutput:[{id:`rs_${index}`,type:'reasoning',summary:[],encrypted_content:marker},{id:`fc_${index}`,type:'function_call',call_id:id,name:call.name,arguments:'{"title":"x"}',status:'completed'}]};
  return {text:'',toolCalls,providerOutput:{role:'assistant',content:[{type:'thinking',thinking:marker,signature:'SYNTHETIC_SIGNATURE'},{type:'tool_use',id,name:call.name,input:{title:'x'}}]}};
}
const record=(value:AgentTaskJson|undefined):value is {[key:string]:AgentTaskJson}=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function toolResult(protocol:Protocol,messages:readonly AgentTaskJson[],id:string):string|undefined{
  for(const message of messages){
    if(!record(message))continue;
    if(protocol==='chat_completions'&&message.role==='tool'&&message.tool_call_id===id)return String(message.content);
    if(protocol==='responses'&&message.type==='function_call_output'&&message.call_id===id)return String(message.output);
    if(protocol==='anthropic_messages'&&Array.isArray(message.content))for(const block of message.content)if(record(block)&&block.type==='tool_result'&&block.tool_use_id===id)return String(block.content);
  }
  return undefined;
}
for(const protocol of ['chat_completions','responses','anthropic_messages'] as const)test(`${protocol}: in-round compaction keeps each retained call with its thinking`,()=>{
  const fragments:TaskModelContextFragment[]=Array.from({length:10},(_,index)=>({kind:'continuation',output:thinkingOutput(protocol,index),results:[{callId:`call_${index}`,result:{data:'x'.repeat(20*1024)}}]}));
  const {history:compacted}=assembleModelInput({context:history,text:'创建一个镜头',replay:{protocol,fragments}}),serialized=JSON.stringify(compacted);
  assert.ok(Buffer.byteLength(serialized)<=TASK_MODEL_LIMITS.historyBytes,'the 200 KiB of raw results were compacted');
  assert.ok(toolResult(protocol,compacted,'call_9')?.includes('x'.repeat(1024)),'the latest round keeps its result view');
  assert.equal(toolResult(protocol,compacted,'call_0')?.includes('x'.repeat(1024)),false,'an earlier round keeps only a stub');
  for(let index=0;index<10;index++)assert.ok(serialized.includes(`PRIVATE_THINKING_${index}`),`round ${index} keeps its thinking with its tool call`);
  if(protocol==='anthropic_messages')assert.doesNotThrow(()=>buildTaskModelRequest(presetConfiguration('ollama','anthropic_messages'),compacted,definitions,4318));
});
test('a new round carries only text history; thinking stays with the round that produced it',()=>{
  const outputs:TaskModelOutput[]=[
    {text:'完成',toolCalls:[],providerOutput:{role:'assistant',content:'完成',reasoning_content:'PRIVATE_CC_REASONING'}},
    {text:'完成',toolCalls:[],providerOutput:[{id:'rs_text',type:'reasoning',summary:[{type:'summary_text',text:'PRIVATE_RESPONSES_SUMMARY'}],encrypted_content:'PRIVATE_ENCRYPTED_REASONING'},{id:'message_text',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'完成',annotations:[]}]}]},
    {text:'完成',toolCalls:[],providerOutput:{role:'assistant',content:[{type:'thinking',thinking:'PRIVATE_MESSAGES_THINKING',signature:'PRIVATE_SIGNATURE'},{type:'text',text:'完成'}]}},
  ];
  const {context}=assembleRunContext({locale:'zh-Hans',text:'下一轮',previousRuns:outputs.map(output=>({text:'上一轮',steps:[{kind:'model',status:'completed',result:output as unknown as AgentTaskJson}]}))});
  assert.equal(JSON.stringify(context).includes('PRIVATE_'),false);
  assert.deepEqual(context.filter(message=>(message as {role?:string}).role==='assistant'),outputs.map(()=>({role:'assistant',content:'完成'})));
});
