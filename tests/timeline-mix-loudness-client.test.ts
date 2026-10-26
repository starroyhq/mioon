type StrictIntersection<T> = (T extends unknown ? (value: T)=>void : never) extends ((value: infer I)=>void) ? I : never;
import type {TypedClient as FixtureClient} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient,prepareTimelineMixLoudness,errorEnvelope} from '@mioon/client';
import {TIMELINE_MIX_LOUDNESS_LIMITS,isTimelineMixLoudnessResponse} from '@mioon/contracts/timeline-mix-loudness';
import {readTimelineMixLoudnessEnvelope} from '../packages/client/src/timeline-mix-loudness.ts';
import {mixLoudnessOperation as operation,mixLoudnessInput as input,mixLoudnessToken as token,readyMixLoudness,silentMixLoudness} from './fixtures/timeline-mix-loudness-fixtures.ts';
const env={MIOON_TOKEN:token};
const success=(data: {}|null)=>Response.json({ok:true,data});
const clientFor=(report: {}|null)=>(createClient({env,fetchImpl:async()=>success(report)}) as FixtureClient);

test('full-mix default is125s; explicit timeouts and unrelated30s defaults stay intact',async t=>{
  const deadlines: unknown[]=[];t.mock.method(AbortSignal,'timeout',(ms?: unknown)=>{deadlines.push(ms);return new AbortController().signal;});
  for(const [clientOptions,options,expected] of ([[{},undefined,125000],[{requestTimeoutMs:8000},undefined,8000],[{},{timeoutMs:7000},7000],[{requestTimeoutMs:8000},{timeoutMs:7000},7000]] as const)){
    const calls: ({url:RequestInfo|URL;body:unknown;method?:string;redirect?:RequestRedirect})[]=[],report=readyMixLoudness();
    const client=(createClient({env,...(clientOptions as Record<string, unknown>),fetchImpl:async(url,request)=>{calls.push((((({url,...request,body:JSON.parse((((request)!.body) as unknown as Parameters<typeof JSON.parse>[0]))}) as unknown as Parameters<typeof calls.push>[0])) as unknown as StrictIntersection<Parameters<NonNullable<(typeof calls)["push"]>>[0]>));return success(report);}}) as FixtureClient);
    assert.deepEqual(await client.rpc(operation,input,options),report);assert.equal(deadlines.at(-1),expected);
    assert.equal(calls.length,1);assert.deepEqual(calls[0].body,{operation,input});assert.equal(calls[0].method,'POST');
    assert.equal(new URL(calls[0].url as string).pathname,'/api/rpc');assert.equal(calls[0].redirect,'error');
  }
  const client=(createClient({env,fetchImpl:async()=>success([])}) as FixtureClient);
  await client.rpc('project.list',{});assert.equal(deadlines.at(-1),30000);
});
test('typed helper and shared RPC preserve explicit target and transport-only workspace/cancellation',async()=>{
  const controller=new AbortController(),origin='55555555-5555-4555-8555-555555555555';let seen!:RequestInit;
  const client=(createClient({env,fetchImpl:async(_url,request)=>{seen=request!;return success(readyMixLoudness());}}) as FixtureClient);
  const report=await prepareTimelineMixLoudness(client,((input) as unknown as Parameters<typeof prepareTimelineMixLoudness>[1]),{signal:controller.signal,expectedWorkspaceOrigin:origin});
  assert.deepEqual(report,readyMixLoudness());assert.equal(isTimelineMixLoudnessResponse(report,input),true);
  assert.deepEqual(JSON.parse((seen.body as string)),{operation,input,expectedWorkspaceOrigin:origin});
  assert.equal(seen.signal!.aborted,false);controller.abort();assert.equal(seen.signal!.aborted,true);
  await assert.rejects(prepareTimelineMixLoudness({rpc:async()=>({...report,applyAllowed:true})},((input) as unknown as Parameters<typeof prepareTimelineMixLoudness>[1])),{code:'BACKEND_PROTOCOL_ERROR'});
});
test('missing explicit profiles/target and authority/path/URL fields reject before any dispatch',async()=>{
  let calls=0;const client=(createClient({env,fetchImpl:async()=>{calls++;throw Error('No request allowed');}}) as FixtureClient);
  for(const candidate of ([null,{},...['projectId','expectedRevision','mixProfile','measurementProfile','target'].map(key=>({...input,[key]:undefined})),
    {...input,requestId:'forbidden'}, {...input,path:'/private'}, {...input,filename:'arbitrary.mp4'},
    {...input,url:'https://invalid.example/media.mp4'}, {...input,timeoutMs:1}, {...input,applyAllowed:true},
    {...input,expectedRevision:0}, {...input,mixProfile:'arbitrary'}, {...input,measurementProfile:'arbitrary'},
    {...input,target:{}}, {...input,target:{...input.target,standard:'broadcast'}},
    {...input,target:{...input.target,integratedLufs:-4}}, {...input,target:{...input.target,truePeakCeilingDbtp:1}}] as const))
    await assert.rejects(client.rpc(operation,candidate),{code:'VALIDATION_ERROR'});
  for(const op of (['timeline.loudness.prepare.unknown','__proto__','constructor'] as const))await assert.rejects(client.rpc(op,input),{code:'UNKNOWN_OPERATION'});
  assert.equal(calls,0);
});
test('reports bind request/revision/profiles/target and actual candidate/gain/work evidence without retry',async()=>{
  const edits=[(v: { projectId: unknown; identity: { timelineId: unknown; }; })=>v.projectId=v.identity.timelineId,(v: { expectedRevision: number; })=>v.expectedRevision++,(v: { identity: { timelineRevision: number; }; })=>v.identity.timelineRevision++,
(    v: { mixProfile: string; })=>v.mixProfile='changed',(v: { measurementProfile: string; })=>v.measurementProfile='changed',(v: { target: { integratedLufs: number; }; })=>v.target.integratedLufs--,(v: { target: { truePeakCeilingDbtp: number; }; })=>v.target.truePeakCeilingDbtp--,
(    v: { identity: { snapshotSha256: string; }; })=>v.identity.snapshotSha256='not-a-hash',(v: { identity: { range: { sampleFrames: number; }; }; })=>v.identity.range.sampleFrames--,(v: { identity: { sources: unknown[]; }; })=>v.identity.sources.reverse().push(v.identity.sources[0]),
(    v: { original: { sampleFrames: number; }; })=>v.original.sampleFrames--,(v: { original: { samplePeakLinear: number; }; })=>v.original.samplePeakLinear=0.75,(v: { original: { state: string; }; })=>v.original.state='digital_silence',
(    v: { candidate: { gainMultiplier: number; }; })=>v.candidate.gainMultiplier=2,(v: { candidate: { requiredGainDb: number; }; })=>v.candidate.requiredGainDb++,(v: { candidate: { gains: { afterGain: number; }[]; }; })=>v.candidate.gains[0].afterGain=1,
(    v: { candidate: { gains: { assetId: string; }[]; }; })=>v.candidate.gains[0].assetId=input.projectId,(v: { candidate: { measurement: { sampleFrames: number; }; }; })=>v.candidate.measurement.sampleFrames--,(v: { candidate: { meetsTarget: boolean; }; })=>v.candidate.meetsTarget=false,
(    v: { candidate: { meetsTruePeak: boolean; }; })=>v.candidate.meetsTruePeak=true,(v: { candidate: { applyAllowed: boolean; }; })=>v.candidate.applyAllowed=true,(v: { applyAllowed: boolean; })=>v.applyAllowed=true,
(    v: { checks: { passes: number; }; })=>v.checks.passes=1,(v: { checks: { pcmBytes: number; }; })=>v.checks.pcmBytes--,(v: { checks: { bytesHashed: number; }; })=>v.checks.bytesHashed--,(v: { checks: { audioFullyDecoded: boolean; }; })=>v.checks.audioFullyDecoded=false,
(    v: { path: string; })=>v.path='/private',(v: { requestId: string; })=>v.requestId='unexpected-authority'];
  for(const report of ([null,{},[],...edits.map(edit=>{const value=readyMixLoudness();edit(((((value) as unknown as Parameters<typeof edit>[0])) as unknown as StrictIntersection<Parameters<NonNullable<typeof edit>>[0]>));return value;})] as const)){
    let calls=0;const client=(createClient({env,fetchImpl:async()=>{calls++;return success(report);}}) as FixtureClient);
    await assert.rejects(client.rpc(operation,input),error=>(error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code==='BACKEND_PROTOCOL_ERROR'&&Object.keys((((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).details) as unknown as Parameters<typeof Object.keys>[0])).length===0);
    assert.equal(calls,1);
  }
  assert.deepEqual(await clientFor(silentMixLoudness()).rpc(operation,input),silentMixLoudness());
});
test('64KiB reader rejects declared, streamed and error-body overflow before unbounded JSON decoding',async()=>{
  assert.equal(TIMELINE_MIX_LOUDNESS_LIMITS.reportBytes,65536);
  for(const headers of ([{},{'content-length':'1'},{'content-length':'65537'},{'content-length':'invalid'}] as const)){
    let cancelled=0,pulls=0,calls=0;
    const response=new Response(new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(32769));},cancel(){cancelled++;}}),(({headers}) as unknown as ConstructorParameters<typeof Response>[1]));
    response.json=()=>{assert.fail('Unbounded json() is forbidden');};
    const client=(createClient({env,fetchImpl:async()=>{calls++;return response;}}) as FixtureClient);
    await assert.rejects(client.rpc(operation,input),{code:'BACKEND_PROTOCOL_ERROR'});
    assert.equal(calls,1);assert.equal(cancelled,1);assert.ok(pulls<=3);
  }
  await assert.rejects((createClient({env,fetchImpl:async()=>Response.json({ok:false,error:{code:'TEST',message:'x'.repeat(65536)}},{status:400})}) as FixtureClient).rpc(operation,input),{code:'BACKEND_PROTOCOL_ERROR'});
});
test('bounded reader handles split UTF8, exact envelope limit and rejects invalid bytes/JSON or absent streams',async()=>{
  const json=JSON.stringify({ok:true,data:{label:'完整混音'}}),encoded=new TextEncoder().encode(json);
  const body=new ReadableStream({start(controller){for(const byte of encoded)controller.enqueue(Uint8Array.of(byte));controller.close();}});
  assert.deepEqual(await readTimelineMixLoudnessEnvelope(new Response(body)),JSON.parse(json));
  const exact=' '.repeat(65534)+'{}';assert.deepEqual(await readTimelineMixLoudnessEnvelope(new Response(exact)),{});
  for(const response of ([new Response(exact+' '),new Response(Uint8Array.of(0xff)),new Response('{'),new Response(null)] as const))
    await assert.rejects(readTimelineMixLoudnessEnvelope(response));
});
test('pending streamed response cancels on caller abort or deadline; owned body is retired without retry',async()=>{
  for(const mode of (['abort','timeout'] as const)){
    const controller=new AbortController();let cancellations=0,calls=0,entered!: (value?: unknown) => void;
    const ready=new Promise(resolve=>{entered=resolve;});
    const client=(createClient({env,fetchImpl:async()=>{calls++;return new Response(new ReadableStream({start(){entered();},cancel(){cancellations++;}}));}}) as FixtureClient);
    const request=client.rpc(operation,input,{signal:controller.signal,...(mode==='timeout'?{timeoutMs:20}:{})});
    await ready;if(mode==='abort')controller.abort();
    const keepAlive=setTimeout(()=>controller.abort(),1000);
    try{await assert.rejects(request,error=>(error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code===(mode==='abort'?'INTERRUPTED':'TIMEOUT')&&!Object.hasOwn((((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).details) as unknown as Parameters<typeof Object.hasOwn>[0]),'submissionMayHaveSucceeded'));}
    finally{clearTimeout(keepAlive);}
    assert.equal(calls,1);assert.equal(cancellations,1);
  }
});
test('transport loss and safe backend errors carry no mutation receipt/retry authority or credentials',async()=>{
  for(const [fetchImpl,code] of ([[async()=>{throw Error('Synthetic loss');},'BACKEND_UNAVAILABLE'],[async()=>new Response('{'),'BACKEND_PROTOCOL_ERROR']] as const)){
    await assert.rejects((createClient((({env,fetchImpl}) as unknown as Parameters<typeof createClient>[0])) as FixtureClient).rpc(operation,input),error=>(error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code===code&&
      !Object.hasOwn((((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).details) as unknown as Parameters<typeof Object.hasOwn>[0]),'requestId')&&!Object.hasOwn((((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).details) as unknown as Parameters<typeof Object.hasOwn>[0]),'submissionMayHaveSucceeded')&&!Object.hasOwn((((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).details) as unknown as Parameters<typeof Object.hasOwn>[0]),'recovery'));
  }
  const client=(createClient({env,fetchImpl:async()=>Response.json({ok:false,error:{code:'TIMELINE_MIX_LOUDNESS_BUSY',message:`Busy Bearer ${token}`,
    details:{token,authorization:`Bearer ${token}`},retryable:false}},{status:409})}) as FixtureClient);
  await assert.rejects(client.rpc(operation,input),error=>(error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code==='TIMELINE_MIX_LOUDNESS_BUSY'&&!JSON.stringify(errorEnvelope(error)).includes(token));
});
