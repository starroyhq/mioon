import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@mioon/client';
import {schemas,operationEffect,TIMELINE_MUTATION_OPERATIONS,DURABLE_EDIT_OPERATIONS,isTimelineMutationResponse,hasRequestNotAppliedProof} from '@mioon/contracts';
import {readTimelineLoudnessApplyEnvelope,TIMELINE_LOUDNESS_APPLY_WIRE_BYTES} from '../packages/client/src/timeline-loudness-apply.ts';
import {readLoudnessApplyRpc} from '../apps/web/src/timeline-loudness-apply-rpc.ts';
import {loudnessApplyFixture} from './fixtures/timeline-loudness-apply.ts';
const op='timeline.loudness.apply',env={MIOON_TOKEN:'synthetic-loudness-apply-test-token'};
const success=data=>Response.json({ok:true,data});
test('shared discovery declares a durable local mutation without supplier or file effects',async()=>{
 const {input,response}=await loudnessApplyFixture();assert.deepEqual(schemas[op].parse(input),input);
 assert.ok(TIMELINE_MUTATION_OPERATIONS.includes(op));assert.ok(DURABLE_EDIT_OPERATIONS.includes(op));
 assert.equal(isTimelineMutationResponse(op,input,response),true);
 const effect=operationEffect(op);for(const key of ['databaseWrite','localProcess','idempotent'])assert.equal(effect[key],true,key);
 for(const key of ['readOnly','fileWrite','externalIO','paidGeneration','openWorld'])assert.equal(effect[key],false,key);
});
test('new RPC retains original request and125s default; overrides and old30s defaults remain',async t=>{
 const {input,response}=await loudnessApplyFixture();const timeouts=[];
 t.mock.method(AbortSignal,'timeout',ms=>{timeouts.push(ms);return new AbortController().signal;});
 for(const [opts,requestOptions,ms]of [[{},undefined,125000],[{requestTimeoutMs:5000},undefined,5000],[{},{timeoutMs:7000},7000]]){
  const requests=[],client=createClient({env,...opts,fetchImpl:async(url,request)=>{requests.push(JSON.parse(request.body));return success(response);}});
  assert.deepEqual(await client.rpc(op,input,requestOptions),response);assert.deepEqual(requests,[{operation:op,input}]);assert.equal(timeouts.at(-1),ms);
 }
 await createClient({env,fetchImpl:async()=>success([])}).rpc('project.list',{});assert.equal(timeouts.at(-1),30000);
});
test('wrong ACK, protocol loss and bounded overflow preserve unknown identity without second POST',async()=>{
 const {input,response}=await loudnessApplyFixture();
 for(const make of [()=>success({...response,requestId:'other-key'}),()=>new Response('{'),()=>new Response('x'.repeat(TIMELINE_LOUDNESS_APPLY_WIRE_BYTES+1)),()=>{throw Error('wire gone');}]){
  let calls=0;const client=createClient({env,fetchImpl:async()=>{calls++;return make();}});
  await assert.rejects(client.rpc(op,input),error=>['BACKEND_PROTOCOL_ERROR','BACKEND_UNAVAILABLE'].includes(error.code)&&error.details.requestId===input.requestId&&error.details.submissionMayHaveSucceeded===true);
  assert.equal(calls,1);
 }
});
test('only exact new operation/project/request proof can release new mutation identity',async()=>{
 const {input}=await loudnessApplyFixture();
 const error={code:'REVISION_CONFLICT',status:409,details:{mutationOutcome:'not_applied',operation:op,projectId:input.projectId,requestId:input.requestId}};
 assert.equal(hasRequestNotAppliedProof(error,input,{operation:op}),true);
 for(const field of ['operation','projectId','requestId']){
  const bad=structuredClone(error);delete bad.details[field];assert.equal(hasRequestNotAppliedProof(bad,input,{operation:op}),false);
 }
 assert.equal(hasRequestNotAppliedProof({...error,terminationUnconfirmed:true},input,{operation:op}),false);
 for(const code of ['TIMELINE_MIX_LOUDNESS_TIMEOUT','TIMELINE_MIX_LOUDNESS_STALE','BACKEND_PROTOCOL_ERROR','EDIT_TASK_OWNER_REQUIRED'])
  assert.equal(hasRequestNotAppliedProof({...error,code},input,{operation:op}),false);
});
test('336KiB reader rejects declared/body/error overflow and invalid UTF8 without response.json',async()=>{
 for(const response of [new Response('x'.repeat(TIMELINE_LOUDNESS_APPLY_WIRE_BYTES+1)),new Response('{}',{headers:{'content-length':String(TIMELINE_LOUDNESS_APPLY_WIRE_BYTES+1)}}),new Response(Uint8Array.of(0xff)),new Response(null)]){
  response.json=()=>assert.fail('unbounded json');await assert.rejects(readTimelineLoudnessApplyEnvelope(response));
 }
 const text=JSON.stringify({label:'固定增益响应'}),bytes=new TextEncoder().encode(text);
 const response=new Response(new ReadableStream({start(c){for(const byte of bytes)c.enqueue(Uint8Array.of(byte));c.close();}}));
 assert.deepEqual(await readTimelineLoudnessApplyEnvelope(response),JSON.parse(text));
});
test('renderer new-operation deadline and abort mean unknown, cancel read, never resend',async()=>{
 for(const mode of ['abort','timeout']){
  const abort=new AbortController();let calls=0,cancelled=0,entered,retired;const ready=new Promise(r=>entered=r),closed=new Promise(r=>retired=r);
  const promise=readLoudnessApplyRpc('/api/rpc',{operation:op,input:{}},{signal:abort.signal,timeoutMs:mode==='timeout'?10:1000,
   fetcher:async()=>{calls++;return new Response(new ReadableStream({start(){entered();},cancel(){cancelled++;retired();}}));}});
  await ready;if(mode==='abort')abort.abort();
  await assert.rejects(promise,{code:mode==='abort'?'OPERATION_CANCELLED':'TIMEOUT'});
  let timer;try{await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('owned response was not retired')),1000);})]);}finally{clearTimeout(timer);}
  assert.equal(calls,1);assert.equal(cancelled,1);
 }
});
test('deadline covers noncooperative fetch and cancels its late body',async()=>{
 let resolve,calls=0,cancelled=0;const delayed=new Promise(r=>resolve=r);
 const pending=readLoudnessApplyRpc('/api/tasks/prepare',{operation:op},{timeoutMs:10,fetcher:()=>{calls++;return delayed;}});
 await assert.rejects(pending,{code:'TIMEOUT'});resolve(new Response(new ReadableStream({cancel(){cancelled++;}})));
 await new Promise(r=>setImmediate(r));assert.equal(calls,1);assert.equal(cancelled,1);
});
test('new bounded transport refuses arbitrary endpoint and retains fixed authenticated task route',async()=>{
 for(const path of ['https://external.invalid/api/rpc','/api/assets','/api/rpc?secret=x','/api/tasks/../../rpc'])
  await assert.rejects(readLoudnessApplyRpc(path,{}),{code:'VALIDATION'});
 let observed;const path='/api/tasks/11111111-1111-4111-8111-111111111111?projectId=22222222-2222-4222-8222-222222222222';
 const result=await readLoudnessApplyRpc(path,undefined,{fetcher:async(url,options)=>{observed={url,options};return success({});}});
 assert.deepEqual(result.body,{ok:true,data:{}});assert.equal(observed.options.method,'GET');assert.equal(observed.options.credentials,'same-origin');assert.equal('body'in observed.options,false);
});
