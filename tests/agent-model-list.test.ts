import test from 'node:test';
import assert from 'node:assert/strict';
import {AGENT_MODEL_LIST_LIMITS,agentModelListResultSchema,agentModelListCacheResultSchema} from '../packages/contracts/src/agent-model-list.ts';
import type {AgentModelListSelection} from '../packages/contracts/src/agent-model-list.ts';
import {AGENT_PRESETS} from '../packages/business/src/agent/presets.ts';
import {resolveAgentPresetBaseUrl} from '../packages/contracts/src/agent-provider-catalog.ts';
import {resolveAgentModelListDescriptor,adaptAgentModelListModels} from '../packages/business/src/agent/model-list-descriptors.ts';
import {fetchAgentModelList} from '../packages/business/src/agent/model-list.ts';
import {AgentModelListTransportError} from '../packages/business/src/agent/model-list-transport.ts';
import type {AgentModelListPageRequest,AgentModelListPage} from '../packages/business/src/agent/model-list-transport.ts';
const openai:AgentModelListSelection={presetId:'openai',platformId:'global',baseUrl:'https://api.openai.com/v1',protocol:'chat_completions'};
const anthropic:AgentModelListSelection={presetId:'anthropic',platformId:'global',baseUrl:'https://api.anthropic.com',protocol:'anthropic_messages'};
const router:AgentModelListSelection={presetId:'openrouter',platformId:'global',baseUrl:'https://openrouter.ai/api/v1',protocol:'responses'};
const key='synthetic-key-marker';
const json=(value:unknown):AgentModelListPage=>({status:200,body:Buffer.from(JSON.stringify(value))});
const now=()=>new Date('2026-11-04T00:00:00.000Z');
test('every available catalog combination has its own conservative list descriptor',()=>{
 for(const preset of AGENT_PRESETS)for(const platform of preset.platforms)for(const protocol of platform.availableProtocols){
  const address=platform.addressMode==='workspace'?'workspace-a':platform.addressMode==='local'?'http://127.0.0.1:11434':platform.addressMode==='custom'?'https://custom.example.com/prefix':undefined;
  const selection={presetId:preset.id,platformId:platform.id,baseUrl:resolveAgentPresetBaseUrl(AGENT_PRESETS,preset.id,platform.id,protocol,address),protocol};
  const descriptor=resolveAgentModelListDescriptor(selection,{selfPort:41000});
  if(['qwen','zhipu'].includes(preset.id)){assert.equal(descriptor,null);continue;}
  assert.ok(descriptor);assert.equal(descriptor.allowNone,['openrouter','ollama'].includes(preset.id));
  assert.equal(descriptor.local,preset.id==='ollama');assert.equal(Object.isFrozen(descriptor),true);
  if(preset.id==='deepseek'){assert.equal(descriptor.url,'https://api.deepseek.com/models');assert.equal(descriptor.auth,'bearer');assert.equal(descriptor.source,protocol==='anthropic_messages'?'same_platform_compatible':'current_protocol');}
  else if(preset.id==='ollama')assert.equal(descriptor.url,'http://127.0.0.1:11434/v1/models');
  else assert.equal(descriptor.url,selection.baseUrl+(protocol==='anthropic_messages'?'/v1/models':'/models'));
 }
 for(const selection of [{...openai,baseUrl:'https://other.example.com/v1'},{...openai,protocol:'anthropic_messages'},{...openai,baseUrl:'https://api.openai.com/v1?secret=x'},{presetId:'ollama',platformId:'local',baseUrl:'http://127.0.0.1:41000/v1',protocol:'chat_completions'}])assert.throws(()=>resolveAgentModelListDescriptor(selection,{selfPort:41000}));
});
test('unknown lists do not fetch; all five outcomes remain fixed and raw provider diagnostics never escape',async()=>{
 let calls=0;const transport=async()=>{calls++;return json({data:[]});};
 const qwen={presetId:'qwen',platformId:'beijing',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',protocol:'chat_completions'} as const;
 assert.deepEqual(await fetchAgentModelList({selection:qwen,apiKey:null},{transport}),{outcome:'unavailable',reason:'not_provided'});
 assert.deepEqual(await fetchAgentModelList({selection:openai,apiKey:null},{transport}),{outcome:'invalid_key',reason:'required'});assert.equal(calls,0);
 const failures=[
  [401,{outcome:'invalid_key',reason:'rejected'}],
  [403,{outcome:'invalid_key',reason:'permission_denied'}],
  [404,{outcome:'unavailable',reason:'not_found'}],
  [405,{outcome:'unavailable',reason:'http_unavailable'}],
  [429,{outcome:'unreachable',reason:'rate_limited'}],
  [500,{outcome:'unreachable',reason:'server_error'}],
  [501,{outcome:'unreachable',reason:'server_error'}],
  [599,{outcome:'unreachable',reason:'server_error'}],
  [301,{outcome:'unreachable',reason:'http_error'}],
  [307,{outcome:'unreachable',reason:'http_error'}],
 ] as const;
 const privateBody=Buffer.from(JSON.stringify({error:{message:'Private user scene notes',type:'invalid_request_error',code:'sk-synthetic-key-marker'}}));
 for(const [status,expected] of failures){
  const result=await fetchAgentModelList({selection:openai,apiKey:key},{transport:async()=>({status,body:privateBody})});
  assert.deepEqual(result,expected,`HTTP ${status}`);
  assert.deepEqual(agentModelListResultSchema.parse(result),expected);
 }
 for(const reason of ['connection_failed','timeout'] as const){
  assert.deepEqual(await fetchAgentModelList({selection:openai,apiKey:key},{transport:async()=>{throw new AgentModelListTransportError(reason);}}),{outcome:'unreachable',reason});
 }
 assert.deepEqual(await fetchAgentModelList({selection:openai,apiKey:key},{transport:async()=>{throw new AgentModelListTransportError('policy');}}),{outcome:'network_denied',reason:'policy'});
 const result=await fetchAgentModelList({selection:openai,apiKey:key},{transport:async()=>json({data:[]}),now});assert.deepEqual(result,{outcome:'success',models:[],complete:true,source:'current_protocol',fetchedAt:now().toISOString()});
});
test('remote capabilities are ignored; static exact profiles and custom identities determine adaptation',async()=>{
 const result=await fetchAgentModelList({selection:openai,apiKey:key},{now,transport:async()=>json({data:[{id:'future-model',name:'Future',capabilities:{tools:true},context_length:10000000},{id:'gpt-4.1-mini',owned_by:'secret'},{id:'future-model'}],other:'ignored'})});
 assert.deepEqual(result,{outcome:'success',models:[{id:'future-model',displayName:'Future',adaptation:'unverified'},{id:'gpt-4.1-mini',adaptation:'adapted'}],complete:true,source:'current_protocol',fetchedAt:now().toISOString()});
 assert.equal(adaptAgentModelListModels({...openai,presetId:'custom',platformId:'custom'},[{id:'gpt-4.1-mini'}])[0]?.adaptation,'unverified');
});
test('cursor lists use a single shared budget, stable deduplication, and reject repeated or forged cursors',async()=>{
 const requests:AgentModelListPageRequest[]=[];
 const result=await fetchAgentModelList({selection:anthropic,apiKey:key},{now,transport:async request=>{requests.push(request);return requests.length===1?json({data:[{id:'a',display_name:'A'},{id:'b'}],has_more:true,last_id:'b'}):json({data:[{id:'b'},{id:'c'}],has_more:false,last_id:'c'});}});
 assert.equal(result.outcome,'success');if(result.outcome==='success'){assert.deepEqual(result.models.map(item=>item.id),['a','b','c']);assert.equal(result.complete,true);}
 assert.equal(requests[0]?.cursor,undefined);assert.equal(requests[1]?.cursor,'b');assert.ok(requests[1]!.maxBytes!<requests[0]!.maxBytes!);
 let count=0;assert.deepEqual(await fetchAgentModelList({selection:anthropic,apiKey:key},{transport:async()=>{count++;return json({data:[{id:'a'}],has_more:true,last_id:'a'});}}),{outcome:'unavailable',reason:'unsupported_shape'});assert.equal(count,2);
 assert.deepEqual(await fetchAgentModelList({selection:anthropic,apiKey:key},{transport:async()=>json({data:[{id:'a'}],has_more:true,last_id:'forged'})}),{outcome:'unavailable',reason:'unsupported_shape'});
});
test('offset pagination ignores malicious next URL and detects empty pages with claimed remaining data',async()=>{
 const requests:AgentModelListPageRequest[]=[];
 const result=await fetchAgentModelList({selection:router,apiKey:null},{transport:async request=>{requests.push(request);return requests.length===1?json({data:[{id:'a'}],total_count:2,links:{next:'https://127.0.0.1/private?key=secret'}}):json({data:[{id:'b'}],total_count:2,links:{next:null}});}});
 assert.equal(result.outcome,'success');assert.deepEqual(requests.map(item=>item.offset),[0,1]);assert.ok(requests.every(item=>item.selection.baseUrl===router.baseUrl));
 assert.deepEqual(await fetchAgentModelList({selection:router,apiKey:null},{transport:async()=>json({data:[],total_count:1,links:{next:'https://private'}})}),{outcome:'unavailable',reason:'unsupported_shape'});
});
test('ten page, thousand row and DTO budgets produce complete=false verified prefixes',async()=>{
 let calls=0;const pages=await fetchAgentModelList({selection:anthropic,apiKey:key},{transport:async()=>{calls++;return json({data:[{id:`id-${calls}`}],has_more:true,last_id:`id-${calls}`});}});
 assert.equal(calls,10);assert.equal(pages.outcome,'success');if(pages.outcome==='success'){assert.equal(pages.complete,false);assert.equal(pages.models.length,10);}
 const rows=await fetchAgentModelList({selection:openai,apiKey:key},{transport:async()=>json({data:Array.from({length:1001},(_,i)=>({id:`id-${i}`}))})});assert.equal(rows.outcome,'success');if(rows.outcome==='success'){assert.equal(rows.models.length,1000);assert.equal(rows.complete,false);}
 const bounded=await fetchAgentModelList({selection:openai,apiKey:key},{transport:async()=>json({data:Array.from({length:1000},(_,i)=>({id:`id-${i}`,name:'界'.repeat(256)}))})});assert.equal(bounded.outcome,'success');if(bounded.outcome==='success'){assert.ok(bounded.models.length>0&&bounded.models.length<1000);assert.equal(bounded.complete,false);assert.equal(agentModelListCacheResultSchema.safeParse({status:'hit',result:bounded}).success,true);}
});
test('raw one MiB 0/1 byte boundary, malformed JSON/UTF8, projection hazards and later-page failure never return partial success',async()=>{
 const base=Buffer.from('{"data":[]}'),exact=Buffer.concat([base,Buffer.alloc(AGENT_MODEL_LIST_LIMITS.rawBytes-base.length,32)]);
 assert.equal((await fetchAgentModelList({selection:openai,apiKey:key},{transport:async()=>({status:200,body:exact})})).outcome,'success');
 assert.deepEqual(await fetchAgentModelList({selection:openai,apiKey:key},{transport:async()=>({status:200,body:Buffer.concat([exact,Buffer.from(' ')])})}),{outcome:'unreachable',reason:'response_limit'});
 for(const body of [Buffer.from('{'),Buffer.from([255]),Buffer.from('{"data":[{"id":"synthetic-key-marker"}]}')])assert.deepEqual(await fetchAgentModelList({selection:openai,apiKey:key},{transport:async()=>({status:200,body})}),{outcome:'unreachable',reason:'invalid_response'});
 for(const data of [null,{},[{id:'x\n' }],[{id:'<script>'}],[{id:'x',name:'<b>x</b>'}],[{id:'x',name:'\ud800'}],[{id:'x',name:'界'.repeat(257)}]])assert.deepEqual(await fetchAgentModelList({selection:openai,apiKey:key},{transport:async()=>json({data})}),{outcome:'unavailable',reason:'unsupported_shape'});
 let calls=0;const badLater=await fetchAgentModelList({selection:anthropic,apiKey:key},{transport:async()=>++calls===1?json({data:[{id:'a'}],has_more:true,last_id:'a'}):{status:200,body:Buffer.from('{')}});assert.deepEqual(badLater,{outcome:'unreachable',reason:'invalid_response'});
});
test('total list deadline and external cancellation settle even a trusted transport that never returns',async()=>{
 const pending=()=>new Promise<AgentModelListPage>(()=>{});
 assert.deepEqual(await fetchAgentModelList({selection:openai,apiKey:key},{transport:pending,totalTimeoutMs:5}),{outcome:'unreachable',reason:'timeout'});
 const controller=new AbortController(),operation=fetchAgentModelList({selection:openai,apiKey:key,signal:controller.signal},{transport:pending});controller.abort();assert.deepEqual(await operation,{outcome:'unreachable',reason:'aborted'});
 assert.equal(agentModelListResultSchema.safeParse(await fetchAgentModelList({selection:openai,apiKey:key},{transport:async()=>{throw Error('synthetic-key-marker');}})).success,true);
});
