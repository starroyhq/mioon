import test from 'node:test';
import assert from 'node:assert/strict';
import {createMioUsageClient} from '../apps/web/src/mio-usage-client.ts';
import {usageFixture,USAGE_PROJECT_ID as projectId,USAGE_RUN_ID as runId} from './helpers/mio-usage-fixture.ts';
const response=(data:unknown)=>Response.json({ok:true,data});

test('usage client makes only a fixed canonical passive GET and validates the exact run',async()=>{
  const seen:Array<{url:string;init?:RequestInit}>=[];
  const client=createMioUsageClient({fetcher:async(input,init)=>{seen.push({url:String(input),init});return response(usageFixture());}});
  assert.deepEqual(await client.read(projectId,runId),usageFixture());
  assert.equal(seen.length,1);assert.equal(seen[0]!.url,`/api/projects/${projectId}/agent/tasks/v2/${runId}/usage`);
  assert.deepEqual(Object.keys(seen[0]!.init!).sort(),['cache','credentials','method','redirect','signal']);
  assert.equal(seen[0]!.init!.method,'GET');assert.equal(seen[0]!.init!.credentials,'same-origin');assert.equal(seen[0]!.init!.cache,'no-store');assert.equal(seen[0]!.init!.redirect,'error');
  for(const [project,run]of [['../other',runId],[projectId,'run'],[projectId,runId+'?x=1']])await assert.rejects(client.read(project!,run!),{code:'VALIDATION_ERROR'});
  assert.equal(seen.length,1);
});

test('usage rejects foreign/private/inconsistent snapshots and malformed envelopes without accepting partial totals',async()=>{
  const original=usageFixture();
  for(const body of [{ok:true,data:{...original,runId:projectId}},{ok:true,data:{...original,rawUsage:{secret:'PRIVATE'}}},{ok:true,data:{...original,modelOutcomes:{...original.modelOutcomes,failed:1}}},{ok:true,data:{...original,cacheReadRate:0.5}},{ok:true,data:original,private:'PRIVATE'},{ok:true,data:{...original,coverage:{fields:{...original.coverage.fields,inputTokens:{reportedSteps:1,missingSteps:1,complete:true,overflow:false}}}}}]){
    const client=createMioUsageClient({fetcher:async()=>Response.json(body)});
    await assert.rejects(client.read(projectId,runId),{code:'BACKEND_PROTOCOL_ERROR'});
  }
});

test('usage bounded reader refuses invalid JSON, UTF8, media types and oversized metadata',async()=>{
  let cancelled=0;
  const large=new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(17000));},cancel(){cancelled++;}}),{headers:{'content-type':'application/json'}});
  for(const value of [new Response('{',{headers:{'content-type':'application/json'}}),new Response(new Uint8Array([0xff]),{headers:{'content-type':'application/json'}}),new Response('{}',{headers:{'content-type':'text/plain'}}),new Response('{}',{headers:{'content-type':'application/json','content-length':'20000'}}),large]){
    await assert.rejects(createMioUsageClient({fetcher:async()=>value}).read(projectId,runId),{code:'BACKEND_PROTOCOL_ERROR'});
  }
  assert.equal(cancelled,1);
});

test('usage deadlines and aborts settle ignored-signal fetches and body reads without retry',async()=>{
  let requests=0,signal:AbortSignal|null|undefined;
  const timeout=createMioUsageClient({timeoutMs:5,fetcher:async(_input,init)=>{requests++;signal=init?.signal;return await new Promise<Response>(()=>{});}});
  await assert.rejects(timeout.read(projectId,runId),{code:'TIMEOUT'});assert.equal(signal?.aborted,true);assert.equal(requests,1);
  const abort=new AbortController();abort.abort();await assert.rejects(timeout.read(projectId,runId,{signal:abort.signal}),{code:'INTERRUPTED'});assert.equal(requests,1);
  let cancel=0;const bodyAbort=new AbortController();
  const pending=createMioUsageClient({fetcher:async()=>new Response(new ReadableStream({cancel(){cancel++;}}),{headers:{'content-type':'application/json'}})}).read(projectId,runId,{signal:bodyAbort.signal});
  await new Promise(resolve=>setImmediate(resolve));bodyAbort.abort();await assert.rejects(pending,{code:'INTERRUPTED'});assert.equal(cancel,1);
});

test('usage errors disclose only safe codes and matching status, never provider diagnostics',async()=>{
  const client=createMioUsageClient({fetcher:async()=>Response.json({ok:false,error:{code:'UNAUTHORIZED',message:'PRIVATE',details:{key:'PRIVATE'}}},{status:401})});
  await assert.rejects(client.read(projectId,runId),(error:unknown)=>{assert.ok(error instanceof Error);assert.equal('code'in error&&error.code,'UNAUTHORIZED');assert.doesNotMatch(error.message+JSON.stringify(error),/PRIVATE/);return true;});
  await assert.rejects(createMioUsageClient({fetcher:async()=>Response.json({ok:false,error:{code:'UNAUTHORIZED'}},{status:500})}).read(projectId,runId),{code:'BACKEND_PROTOCOL_ERROR'});
});
