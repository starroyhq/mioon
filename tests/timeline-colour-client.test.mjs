import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient,discoverSchema} from '../packages/client/src/index.ts';
const input={projectId:'11111111-1111-4111-8111-111111111111',assetId:'22222222-2222-4222-8222-222222222222'};
const response={...input,assetSha256:'a'.repeat(64),streamIndex:0,evidence:{primaries:'bt709',transfer:'bt709',matrix:'bt709',range:'limited',pixelFormat:'yuv420p',bitDepth:8,hdrMetadata:false},status:'compatible',reason:null};
function fixture(value){let calls=0;const requests=[];return {client:createClient({env:{MIOON_BASE_URL:'http://127.0.0.1:9999',MIOON_TOKEN:'a'.repeat(64)},fetchImpl:async(url,options)=>{
 calls++;requests.push(JSON.parse(options.body));return new Response(JSON.stringify({ok:true,data:value}),{status:200});
 }}),calls:()=>calls,requests};}
test('shared source inspection client sends one read, preserves returned evidence and discovers bounded effects',async()=>{
 const f=fixture(response);assert.deepEqual(await f.client.rpc('timeline.colour.source.inspect',input),response);assert.equal(f.calls(),1);
 assert.deepEqual(f.requests,[{operation:'timeline.colour.source.inspect',input}]);const schema=discoverSchema({operation:'timeline.colour.source.inspect'});
 assert.equal(schema.requiresRequestId,false);assert.equal(schema.effects.readOnly,true);assert.equal(schema.effects.localProcess,true);assert.equal(schema.effects.databaseWrite,false);assert.equal(schema.effects.externalIO,false);
});
test('shared source inspection rejects cross-project, wrong-asset, contradictory or excessive DTOs without retry or mutation uncertainty',async()=>{
 for(const value of [{...response,projectId:input.assetId},{...response,assetId:input.projectId},{...response,evidence:{...response.evidence,transfer:'smpte2084'}},{...response,evidence:{...response.evidence,hdrMetadata:true}},{...response,evidence:{...response.evidence,path:'/private/source'}},{...response,reason:'a'.repeat(241)},{...response,streamIndex:null},{...response,colourPlan:{}},null]){
  const f=fixture(value);await assert.rejects(f.client.rpc('timeline.colour.source.inspect',input),error=>error.code==='BACKEND_PROTOCOL_ERROR'&&error.details.operation==='timeline.colour.source.inspect'&&!Object.hasOwn(error.details,'submissionMayHaveSucceeded')&&!Object.hasOwn(error.details,'requestId'));
  assert.equal(f.calls(),1);
 }
});
test('source inspection malformed input fails before transport and does not invent a request identity',async()=>{
 const f=fixture(response);for(const extra of [{path:'/tmp/source'},{requestId:'invented-request'},{expectedRevision:1}])await assert.rejects(f.client.rpc('timeline.colour.source.inspect',{...input,...extra}),{code:'VALIDATION_ERROR'});
 assert.equal(f.calls(),0);
});
