import test from 'node:test';
import assert from 'node:assert/strict';
import {applyTaskAnthropicCaching} from '../packages/business/src/agent/task-cache-v2.ts';
import {buildTaskModelRequest} from '../packages/business/src/agent/task-gateway-v2.ts';
import {DEFAULT_AGENT_CONFIGURATION} from '../packages/business/src/agent/presets.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';

const config:AgentConfiguration={presetId:'anthropic',platformId:'global',protocol:'anthropic_messages',baseUrl:'https://api.anthropic.com',model:'claude-haiku-4-5'};
const marker={type:'ephemeral'};
const tool=(name:string)=>({name,description:name,input_schema:{type:'object',properties:{},additionalProperties:false}});
const body=()=>({model:config.model,stream:true,system:'静态指令',tools:[tool('mioon_project_inspect'),tool('mioon_tools_load'),tool('mioon_ask')],messages:[{role:'user',content:[{type:'text',text:'仅合成请求'}]}]});
const count=(value:unknown):number=>{
  const wire=value as ReturnType<typeof body>;
  return wire.tools.filter(item=>Object.hasOwn(item,'cache_control')).length+
    (Array.isArray(wire.system)?wire.system.filter(item=>Object.hasOwn(item,'cache_control')).length:0)+
    wire.messages.flatMap(item=>Array.isArray(item.content)?item.content:[]).filter(item=>Object.hasOwn(item,'cache_control')).length;
};
function deepFreeze<T>(value:T):T{
  if(value!==null&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))deepFreeze(child);}
  return value;
}

test('H1e cache policy only changes the official Anthropic preset and protocol',()=>{
  const input=body(),original=JSON.stringify(input);
  for(const presetId of ['minimax','custom','ollama','openai'])assert.equal(applyTaskAnthropicCaching({...config,presetId},input),input,presetId);
  for(const protocol of ['chat_completions','responses'] as const)assert.equal(applyTaskAnthropicCaching({...config,protocol},input),input,protocol);
  for(const baseUrl of ['https://api.minimax.io/anthropic','https://compatible.example.com','https://api.anthropic.com/proxy','https://api.anthropic.com:8443'])assert.equal(applyTaskAnthropicCaching({...config,baseUrl},input),input,baseUrl);
  assert.equal(JSON.stringify(input),original);
});

test('H1e core-only requests deduplicate tool boundaries and remain immutable and deterministic',()=>{
  const input=deepFreeze(body()),original=JSON.stringify(input),cached=applyTaskAnthropicCaching(config,input);
  assert.equal(JSON.stringify(input),original);assert.equal(count(cached),3);
  assert.deepEqual(cached,applyTaskAnthropicCaching(config,input));
  assert.deepEqual(cached,applyTaskAnthropicCaching(config,cached));
  assert.deepEqual((cached.tools as Record<string,unknown>[]).at(-1)?.cache_control,marker);
  assert.deepEqual(cached.system,[{type:'text',text:'静态指令',cache_control:marker}]);
});

test('H1e loaded tools follow the core prefix in stable group order with at most four boundaries',()=>{
  const original=body(),loaded={...original,tools:[tool('mioon_image_generate'),original.tools[0]!,tool('mioon_timeline_clip_add'),original.tools[1]!,tool('mioon_shot_create'),original.tools[2]!]};
  const before=applyTaskAnthropicCaching(config,original),after=applyTaskAnthropicCaching(config,loaded);
  const tools=after.tools as Record<string,unknown>[];
  assert.deepEqual(tools.map(item=>item.name),['mioon_project_inspect','mioon_tools_load','mioon_ask','mioon_shot_create','mioon_timeline_clip_add','mioon_image_generate']);
  assert.equal(count(after),4);assert.deepEqual(tools.slice(0,3),before.tools);
  assert.deepEqual(tools[2]!.cache_control,marker);assert.deepEqual(tools[5]!.cache_control,marker);
  assert.equal(tools[3]!.cache_control,undefined);
});

test('H1e cache policy cleans only wire metadata and preserves schema and tool payload fields',()=>{
  const input={...body(),cache_control:{type:'ephemeral',ttl:'1h'},tools:[{...tool('mioon_project_inspect'),cache_control:{type:'ephemeral'},input_schema:{type:'object',properties:{cache_control:{type:'string'}}}}],system:[{type:'text',text:'一',cache_control:marker},{type:'text',text:'二',cache_control:marker}],messages:[{role:'assistant',content:[{type:'tool_use',id:'a',name:'mioon_project_inspect',input:{cache_control:'业务数据'},cache_control:marker}]},{role:'user',content:[{type:'tool_result',tool_use_id:'a',content:'{"cache_control":"业务数据"}',cache_control:marker},{type:'text',text:'继续',cache_control:marker}]}]};
  const cached=applyTaskAnthropicCaching(config,deepFreeze(input));
  assert.equal(count(cached),3);assert.equal(cached.cache_control,undefined);
  const tools=cached.tools as typeof input.tools;assert.deepEqual(tools[0]!.input_schema,input.tools[0]!.input_schema);
  const messages=cached.messages as {content:Record<string,unknown>[]}[];
  assert.deepEqual(messages[0]!.content[0]!.input,{cache_control:'业务数据'});
  assert.equal(messages[0]!.content[0]!.cache_control,undefined);
  assert.equal(messages[1]!.content[0]!.content,'{"cache_control":"业务数据"}');
  assert.equal(messages[1]!.content[0]!.cache_control,undefined);
  assert.deepEqual(messages[1]!.content[1]!.cache_control,marker);
});

test('H1e cache boundaries handle tool-free and string-content requests without adding empty blocks',()=>{
  const empty=applyTaskAnthropicCaching(config,{tools:[],system:'',messages:[]});assert.equal(count(empty),0);
  const result=applyTaskAnthropicCaching(config,{system:'指令',messages:[{role:'user',content:'原文'}]});
  assert.deepEqual(result,{system:[{type:'text',text:'指令',cache_control:marker}],messages:[{role:'user',content:[{type:'text',text:'原文',cache_control:marker}]}]});
});

test('H1e request builder freezes the official cache policy into the serialized original',()=>{
  const definition={name:'mioon_project_inspect',description:'inspect',parameters:{type:'object',properties:{},additionalProperties:false}};
  const wire=buildTaskModelRequest(config,[{role:'user',content:'离线'}],[definition]);
  assert.equal(count(JSON.parse(wire)),3);assert.equal(JSON.parse(wire).max_tokens,4096);
  const compatible=buildTaskModelRequest({...DEFAULT_AGENT_CONFIGURATION,presetId:'minimax',platformId:'international',baseUrl:'https://api.minimax.io/v1',protocol:'anthropic_messages',model:'MiniMax-M3'},[{role:'user',content:'离线'}],[definition]);
  assert.equal(compatible.includes('cache_control'),false);
});
