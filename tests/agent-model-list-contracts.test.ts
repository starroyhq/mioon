import test from 'node:test';
import assert from 'node:assert/strict';
import {agentModelListRequestSchema,agentModelListCacheRequestSchema,agentModelListResultSchema,agentModelListCacheResultSchema} from '../packages/contracts/src/agent-model-list.ts';
const selection={presetId:'openai',platformId:'global',baseUrl:'https://api.openai.com/v1',protocol:'chat_completions'} as const;
const input={serviceKey:'openai',expectedSettingsRevision:0,selection,credential:{source:'input',value:'synthetic-key'}};
test('model discovery accepts only its exact local input and credential union',()=>{
 assert.equal(agentModelListRequestSchema.safeParse(input).success,true);
 for(const credential of [{source:'saved'},{source:'none'},{source:'input',value:'<>synthetic-key'}])assert.equal(agentModelListRequestSchema.safeParse({...input,credential}).success,true);
 for(const credential of [{source:'saved',value:'secret'},{source:'none',value:'secret'},{source:'input'},{source:'input',value:''},{source:'input',value:'\ud800'},{source:'input',value:'key\nmarker'},{source:'input',value:'é'.repeat(4096)+'a'}])assert.equal(agentModelListRequestSchema.safeParse({...input,credential}).success,false);
 assert.equal(agentModelListRequestSchema.safeParse({...input,credential:{source:'input',value:'é'.repeat(4096)}}).success,true);
 for(const field of ['url','headers','method','model','apiKey'])assert.equal(agentModelListRequestSchema.safeParse({...input,[field]:'untrusted'}).success,false);
 assert.equal(agentModelListRequestSchema.safeParse({...input,selection:{...selection,model:'untrusted'}}).success,false);
 assert.equal(agentModelListCacheRequestSchema.safeParse({serviceKey:'openai',expectedSettingsRevision:0,selection}).success,true);
 assert.equal(agentModelListCacheRequestSchema.safeParse(input).success,false);
});
const success={outcome:'success',models:[{id:'gpt-4.1-mini',adaptation:'adapted'}],complete:true,source:'current_protocol',fetchedAt:'2026-11-04T00:00:00.000Z'};
test('model discovery projects only bounded safe model fields and five fixed outcomes',()=>{
 for(const value of [success,{outcome:'invalid_key',reason:'rejected'},{outcome:'unavailable',reason:'not_provided'},{outcome:'unreachable',reason:'timeout'},{outcome:'network_denied',reason:'policy'}])assert.equal(agentModelListResultSchema.safeParse(value).success,true);
 for(const model of [{id:'x',adaptation:'adapted',contextTokens:1000000},{id:'<script>',adaptation:'unverified'},{id:'x',displayName:'<img src=x>',adaptation:'unverified'},{id:'x',displayName:'\ud800',adaptation:'unverified'},{id:'x',displayName:'x'.repeat(257),adaptation:'unverified'}])assert.equal(agentModelListResultSchema.safeParse({...success,models:[model]}).success,false);
 assert.equal(agentModelListResultSchema.safeParse({...success,models:[...success.models,...success.models]}).success,false);
 for(const value of [{...success,next:'https://private.invalid'},{outcome:'unreachable',reason:'synthetic-key'},{outcome:'invalid_key',reason:'rejected',message:'raw error'}])assert.equal(agentModelListResultSchema.safeParse(value).success,false);
 assert.equal(agentModelListCacheResultSchema.safeParse({status:'hit',result:success}).success,true);
 assert.equal(agentModelListCacheResultSchema.safeParse({status:'miss'}).success,true);
 assert.equal(agentModelListCacheResultSchema.safeParse({status:'hit',result:{outcome:'invalid_key',reason:'rejected'}}).success,false);
 const models=Array.from({length:1000},(_,index)=>({id:`${index}${'界'.repeat(65)}`,displayName:'界'.repeat(256),adaptation:'unverified'}));
 assert.equal(agentModelListResultSchema.safeParse({...success,models}).success,false,'combined UTF-8 DTO budget applies even when every individual field is in range');
});
