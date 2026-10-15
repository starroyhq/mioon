import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient,measureTimelineClipLoudness,errorEnvelope} from '@mioon/client';
import {TIMELINE_CLIP_LOUDNESS_LIMITS,isTimelineClipLoudnessResponse} from '@mioon/contracts/timeline-clip-loudness';
import {readTimelineClipLoudnessEnvelope} from '../packages/client/src/timeline-clip-loudness.ts';
import {clipLoudnessOperation as operation,clipLoudnessInput as input,clipLoudnessToken as token,readyClipLoudness,silentClipLoudness} from './fixtures/timeline-clip-loudness-fixtures.mjs';
const env={MIOON_TOKEN:token};
const success=data=>Response.json({ok:true,data});
const clientFor=report=>createClient({env,fetchImpl:async()=>success(report)});

test('selected clip default is125s; explicit timeouts and unrelated30s defaults stay intact',async t=>{
  const deadlines=[];t.mock.method(AbortSignal,'timeout',ms=>{deadlines.push(ms);return new AbortController().signal;});
  for(const [clientOptions,options,expected] of [[{},undefined,125000],[{requestTimeoutMs:8000},undefined,8000],[{},{timeoutMs:7000},7000],[{requestTimeoutMs:8000},{timeoutMs:7000},7000]]){
    const calls=[],report=readyClipLoudness();
    const client=createClient({env,...clientOptions,fetchImpl:async(url,request)=>{calls.push({url,...request,body:JSON.parse(request.body)});return success(report);}});
    assert.deepEqual(await client.rpc(operation,input,options),report);assert.equal(deadlines.at(-1),expected);
    assert.equal(calls.length,1);assert.deepEqual(calls[0].body,{operation,input});assert.equal(calls[0].method,'POST');
    assert.equal(new URL(calls[0].url).pathname,'/api/rpc');assert.equal(calls[0].redirect,'error');
  }
  const client=createClient({env,fetchImpl:async()=>success([])});
  await client.rpc('project.list',{});assert.equal(deadlines.at(-1),30000);
});
test('typed helper and shared RPC preserve explicit selection and transport-only workspace/cancellation',async()=>{
  const controller=new AbortController(),origin='55555555-5555-4555-8555-555555555555';let seen;
  const client=createClient({env,fetchImpl:async(_url,request)=>{seen=request;return success(readyClipLoudness());}});
  const report=await measureTimelineClipLoudness(client,input,{signal:controller.signal,expectedWorkspaceOrigin:origin});
  assert.deepEqual(report,readyClipLoudness());assert.equal(isTimelineClipLoudnessResponse(report,input),true);
  assert.deepEqual(JSON.parse(seen.body),{operation,input,expectedWorkspaceOrigin:origin});
  assert.equal(seen.signal.aborted,false);controller.abort();assert.equal(seen.signal.aborted,true);
  await assert.rejects(measureTimelineClipLoudness({rpc:async()=>({...report,applyAllowed:true})},input),{code:'BACKEND_PROTOCOL_ERROR'});
});
test('strict selection and fixed profile reject targets, candidates and authority before dispatch', async () => {
  let calls = 0; const client = createClient({env, fetchImpl: async () => {calls++; throw Error('No call');}});
  for (const value of [null, {}, ...Object.keys(input).map(key => ({...input, [key]: undefined})),
    ...[{target: {}}, {candidate: {}}, {gain: 1}, {requestId: 'forbidden'}, {path: '/private'}, {filter: 'volume=1'}, {applyAllowed: true},
      {clipId: input.clipId + '\n'}, {expectedAssetSha256: input.expectedAssetSha256 + '\n'}].map(extra => ({...input, ...extra}))])
    await assert.rejects(client.rpc(operation, value), {code: 'VALIDATION_ERROR'});
  assert.equal(calls, 0);
});
test('reports bind exact selected identity, scope, samples and counters without retry', async () => {
  const edits = [v => v.projectId = input.timelineId, v => v.timelineId = input.projectId, v => v.clipId = input.projectId,
    v => v.expectedRevision++, v => v.expectedAssetSha256 = 'c'.repeat(64), v => v.identity.assetSha256 = 'c'.repeat(64),
    v => v.processingProfile = 'wrong', v => v.stage = 'preencode_float_mix', v => v.identity.snapshotSha256 = 'invalid',
    v => v.identity.fadeInFrames = 31, v => v.identity.trackMuted = true, v => v.identity.gain = 0,
    v => v.identity.measurementEndFrame++, v => v.measurement.sampleFrames--, v => v.checks.pcmBytes--,
    v => v.checks.bytesHashed--, v => v.checks.decodeWorkFrames--, v => v.checks.segmentCount++,
    v => v.applyAllowed = true, v => v.target = {}, v => v.candidate = {}, v => v.path = '/private'];
  for (const report of [null, {}, [], ...edits.map(edit => {const value = readyClipLoudness(); edit(value); return value;})]) {
    let calls = 0; const client = createClient({env, fetchImpl: async () => {calls++; return success(report);}});
    await assert.rejects(client.rpc(operation, input), {code: 'BACKEND_PROTOCOL_ERROR'}); assert.equal(calls, 1);
  }
  assert.deepEqual(await clientFor(silentClipLoudness()).rpc(operation, input), silentClipLoudness());
  let getters = 0; const hostile = {get projectId() {getters++; throw Error('getter');}};
  assert.equal(isTimelineClipLoudnessResponse(hostile), false); assert.equal(getters, 0);
});
test('8KiB reader rejects declared, streamed and error-body overflow before unbounded JSON decoding',async()=>{
  assert.equal(TIMELINE_CLIP_LOUDNESS_LIMITS.reportBytes,8192);
  for(const headers of [{},{'content-length':'1'},{'content-length':'8193'},{'content-length':'invalid'}]){
    let cancelled=0,pulls=0,calls=0;
    const response=new Response(new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(4097));},cancel(){cancelled++;}}),{headers});
    response.json=()=>{assert.fail('Unbounded json() is forbidden');};
    const client=createClient({env,fetchImpl:async()=>{calls++;return response;}});
    await assert.rejects(client.rpc(operation,input),{code:'BACKEND_PROTOCOL_ERROR'});
    assert.equal(calls,1);assert.equal(cancelled,1);assert.ok(pulls<=3);
  }
  await assert.rejects(createClient({env,fetchImpl:async()=>Response.json({ok:false,error:{code:'TEST',message:'x'.repeat(8192)}},{status:400})}).rpc(operation,input),{code:'BACKEND_PROTOCOL_ERROR'});
});
test('bounded reader handles split UTF8, exact envelope limit and rejects invalid bytes/JSON or absent streams',async()=>{
  const json=JSON.stringify({ok:true,data:{label:'完整混音'}}),encoded=new TextEncoder().encode(json);
  const body=new ReadableStream({start(controller){for(const byte of encoded)controller.enqueue(Uint8Array.of(byte));controller.close();}});
  assert.deepEqual(await readTimelineClipLoudnessEnvelope(new Response(body)),JSON.parse(json));
  const exact=' '.repeat(8190)+'{}';assert.deepEqual(await readTimelineClipLoudnessEnvelope(new Response(exact)),{});
  for(const response of [new Response(exact+' '),new Response(Uint8Array.of(0xff)),new Response('{'),new Response(null)])
    await assert.rejects(readTimelineClipLoudnessEnvelope(response));
});
test('pending streamed response cancels on caller abort or deadline; owned body is retired without retry',async()=>{
  for(const mode of ['abort','timeout']){
    const controller=new AbortController();let cancellations=0,calls=0,entered;
    const ready=new Promise(resolve=>{entered=resolve;});
    const client=createClient({env,fetchImpl:async()=>{calls++;return new Response(new ReadableStream({start(){entered();},cancel(){cancellations++;}}));}});
    const request=client.rpc(operation,input,{signal:controller.signal,...(mode==='timeout'?{timeoutMs:20}:{})});
    await ready;if(mode==='abort')controller.abort();
    const keepAlive=setTimeout(()=>controller.abort(),1000);
    try{await assert.rejects(request,error=>error.code===(mode==='abort'?'INTERRUPTED':'TIMEOUT')&&!Object.hasOwn(error.details,'submissionMayHaveSucceeded'));}
    finally{clearTimeout(keepAlive);}
    assert.equal(calls,1);assert.equal(cancellations,1);
  }
});
test('transport loss and safe backend errors carry no mutation receipt/retry authority or credentials',async()=>{
  for(const [fetchImpl,code] of [[async()=>{throw Error('Synthetic loss');},'BACKEND_UNAVAILABLE'],[async()=>new Response('{'),'BACKEND_PROTOCOL_ERROR']]){
    await assert.rejects(createClient({env,fetchImpl}).rpc(operation,input),error=>error.code===code&&
      !Object.hasOwn(error.details,'requestId')&&!Object.hasOwn(error.details,'submissionMayHaveSucceeded')&&!Object.hasOwn(error.details,'recovery'));
  }
  const client=createClient({env,fetchImpl:async()=>Response.json({ok:false,error:{code:'TIMELINE_CLIP_LOUDNESS_BUSY',message:`Busy Bearer ${token}`,
    details:{token,authorization:`Bearer ${token}`},retryable:false}},{status:409})});
  await assert.rejects(client.rpc(operation,input),error=>error.code==='TIMELINE_CLIP_LOUDNESS_BUSY'&&!JSON.stringify(errorEnvelope(error)).includes(token));
});
