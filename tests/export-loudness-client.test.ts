import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createClient,errorEnvelope} from '@mioon/client';
import {EXPORT_LOUDNESS_LIMITS,isExportLoudnessResponse} from '@mioon/contracts/export-loudness';
import {loudnessOperation as operation,loudnessInput as input,loudnessToken as token,readyLoudness,incompleteLoudness,loudnessTarget as target} from './fixtures/export-loudness-fixtures.ts';
const env={MIOON_TOKEN:token};
type FetchHandler=(url: string, init?: {body?: string; signal?: AbortSignal; method?: string})=>Promise<unknown>;
type AsFetch=typeof fetch;
const asFetch=(handler: FetchHandler): AsFetch=>handler as unknown as AsFetch;
const success=(data: unknown): Response=>({ok:true,status:200,json:async()=>({ok:true,data})} as unknown as Response);
interface ClientFailure {code?: string; details?: Record<string, unknown>}
const failureOf=(error: unknown): ClientFailure=>error as ClientFailure;
interface MutableSuggestion {[key:string]: unknown; purpose?: string; applyAllowed?: boolean; currentTimelineValidated?: boolean; conflictsWithCeiling?: boolean; requiredGainDb?: number; gainMultiplier?: number; marginDb?: number; truePeakRoomDb?: number; projectedTruePeakDbtp?: number; requestId?: string}
interface MutableLoudness {[key:string]: unknown; projectId: string; exportId: string; expectedArtifactSha256: string; measurementProfile: string; target?: {integratedLufs: number; truePeakCeilingDbtp: number}; artifact: Record<string, unknown> & {sha256: string; snapshotSha256: string}; measurement: Record<string, unknown> & {samplePeakLinear: number; truePeakLinear: number; integratedLufs: number; gatingBlockCount: number; state: string; sampleFrames: number; sourceHash?: string}; checks: Record<string, unknown> & {audioFullyDecoded: boolean; bytesHashed: number}; suggestion: MutableSuggestion | null; reason: {message: string}; path?: string; filename?: string}

test('loudness defaults to 125 seconds; other defaults and explicit caller deadlines stay unchanged',async (t: TestContext)=>{
  const deadlines: number[]=[];t.mock.method(AbortSignal,'timeout',(ms: number)=>{deadlines.push(ms);return new AbortController().signal;});
  const deadlineCases: Array<[Record<string, unknown>, Record<string, unknown> | undefined, number]> = [[{},undefined,125000],[{requestTimeoutMs:8000},undefined,8000],[{},{timeoutMs:7000},7000],[{requestTimeoutMs:8000},{timeoutMs:7000},7000]];
  for(const [clientOptions,options,expected] of deadlineCases){
    const calls: Array<Record<string, unknown>>=[],report=readyLoudness() as unknown as MutableLoudness;
    const client=createClient({env,...clientOptions,fetchImpl:asFetch(async (url: string, request?: {body?: string})=>{calls.push({url,...request,body:JSON.parse(request?.body ?? '{}')});return success(report);})});
    assert.deepEqual(await client.rpc(operation,input,options as never),report);assert.equal(deadlines.at(-1),expected);
    assert.equal(calls.length,1);assert.deepEqual(calls[0].body,{operation,input});assert.equal(calls[0].method,'POST');assert.equal(new URL(calls[0].url as string).pathname,'/api/rpc');
  }
  const client=createClient({env,fetchImpl:asFetch(async (_url: string, request?: {body?: string})=>{const {operation:op}=JSON.parse(request?.body ?? '{}') as {operation: string};return success(op==='timeline.export.preflight'?{
    projectId:input.projectId,expectedRevision:1,timelineId:null,timelineRevision:null,snapshotHash:null,checkedAt:'2026-10-13T00:00:00.000Z',
    status:'blocked',summary:null,checks:{totalAssets:0,checkedAssets:0,bytesHashed:0,fullDecode:false},issues:[]}:null);})});
  await client.rpc('project.list',{});assert.equal(deadlines.at(-1),30000);
  await client.rpc('timeline.export.preflight',{projectId:input.projectId,expectedRevision:1});assert.equal(deadlines.at(-1),35000);
});
test('client carries workspace and caller cancellation outside strict input without new request ID',async()=>{
  const controller=new AbortController(),origin='44444444-4444-4444-8444-444444444444';let seen: {body: string; signal: AbortSignal} | undefined;
  const client=createClient({env,fetchImpl:asFetch(async (_url: string, request?: {body?: string; signal?: AbortSignal})=>{seen=request as {body: string; signal: AbortSignal};return success(readyLoudness());})});
  await client.rpc(operation,input,{signal:controller.signal,expectedWorkspaceOrigin:origin});
  assert.deepEqual(JSON.parse(seen!.body),{operation,input,expectedWorkspaceOrigin:origin});
  assert.equal(seen!.signal.aborted,false);controller.abort();assert.equal(seen!.signal.aborted,true);
});
test('strict invalid inputs and unknown operation reject before connection or dispatch',async()=>{
  let calls=0;const client=createClient({env,fetchImpl:async()=>{calls++;throw Error('No request allowed');}});
  for(const candidate of [null,{}, {...input,requestId:'forbidden'}, {...input,path:'/private'}, {...input,filename:'arbitrary.mp4'},
    {...input,url:'https://invalid.example/media.mp4'}, {...input,timeoutMs:1}, {...input,exportId:'bad'},
    {...input,expectedArtifactSha256:'A'.repeat(64)}, {...input,measurementProfile:'arbitrary'},
    {...input,target:undefined}, {...input,target:{}}, {...input,target:{...target,standard:'broadcast'}},
    {...input,target:{...target,integratedLufs:-4}}, {...input,target:{...target,truePeakCeilingDbtp:1}}])
    await assert.rejects(client.rpc(operation,candidate),{code:'VALIDATION_ERROR'});
  for(const op of ['timeline.export.loudness.unknown','__proto__','constructor'])await assert.rejects(client.rpc(op,input),{code:'UNKNOWN_OPERATION'});
  assert.equal(calls,0);
});
test('strict bounded responses bind hashes, profile, amplitude and gate semantics without retry',async()=>{
  const edits: Array<(v: MutableLoudness)=>void>=[v=>v.projectId=input.exportId,v=>v.exportId=input.projectId,v=>v.expectedArtifactSha256='c'.repeat(64),
    v=>v.artifact.sha256='c'.repeat(64),v=>v.artifact.snapshotSha256='not-a-hash',v=>v.measurementProfile='different-profile',
    v=>v.measurement.samplePeakLinear=0.75,v=>v.measurement.truePeakLinear=0.4,v=>v.measurement.integratedLufs=Infinity,
    v=>v.measurement.gatingBlockCount=8,v=>v.measurement.state='digital_silence',v=>v.measurement.sampleFrames=47999,
    v=>v.checks.audioFullyDecoded=false,v=>v.checks.bytesHashed=1024,v=>v.path='/private',v=>v.filename='arbitrary.mp4',
    v=>v.measurement.sourceHash='c'.repeat(64),v=>v.artifact.path='/private/file.mp4',v=>v.suggestion={applyAllowed:true}];
  for(const value of [null,{},[],...edits.map(edit=>{const v=readyLoudness() as unknown as MutableLoudness;edit(v);return v;})]){
    let calls=0;const client=createClient({env,fetchImpl:asFetch(async()=>{calls++;return success(value);})});
    await assert.rejects(client.rpc(operation,input),(error: unknown)=>{const failure=failureOf(error);assert.equal(failure.code,'BACKEND_PROTOCOL_ERROR');assert.deepEqual(failure.details,{});return true;});
    assert.equal(calls,1);
  }
  const codes = ['BUSY','TIMEOUT','DECODE_FAILED'] as const;
  for(const code of codes)assert.deepEqual(await createClient({env,fetchImpl:asFetch(async()=>success(incompleteLoudness(code)))}).rpc(operation,input),incompleteLoudness(code));
});
test('transport loss, malformed JSON and local cancellation do not create receipt uncertainty or retries',async()=>{
  const transportCases: Array<[() => Promise<unknown>, string]> = [[async()=>{throw Error('Synthetic loss');},'BACKEND_UNAVAILABLE'],[async()=>({ok:true,status:200,json:async()=>{throw Error('Bad JSON');}}),'BACKEND_PROTOCOL_ERROR']];
  for(const [fetcher,expected] of transportCases){
    let calls=0;await assert.rejects(createClient({env,fetchImpl:asFetch(async()=>{calls++;return fetcher();})}).rpc(operation,input),(error: unknown)=>{const failure=failureOf(error);return failure.code===expected&&!Object.hasOwn(failure.details ?? {},'requestId')&&!Object.hasOwn(failure.details ?? {},'submissionMayHaveSucceeded');});
    assert.equal(calls,1);
  }
  let calls=0;const controller=new AbortController();
  const client=createClient({env,fetchImpl:asFetch(async (_url: string, request?: {signal?: AbortSignal})=>{calls++;controller.abort();request?.signal?.throwIfAborted();})});
  await assert.rejects(client.rpc(operation,input,{signal:controller.signal}),(error: unknown)=>{const failure=failureOf(error);return failure.code==='INTERRUPTED'&&!Object.hasOwn(failure.details ?? {},'submissionMayHaveSucceeded');});
  assert.equal(calls,1);
  await assert.rejects(client.rpc(operation,input,{signal:controller.signal}),{code:'INTERRUPTED'});assert.equal(calls,1);
});
test('an explicit loudness deadline interrupts one request without automatic retry or mutation guidance',async()=>{
  const timeoutCases: Array<[Record<string, unknown>, Record<string, unknown> | undefined]> = [[{requestTimeoutMs:1},undefined],[{},{timeoutMs:1}]];
  for(const [clientOptions,options] of timeoutCases){
    let calls=0;const client=createClient({env,...clientOptions,fetchImpl:asFetch(async (_url: string, request?: {signal?: AbortSignal})=>{
      const signal=request?.signal as AbortSignal;
      calls++;await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,200);
        const aborted=()=>{clearTimeout(timer);reject(signal.reason);};
        if(signal.aborted)aborted();else signal.addEventListener('abort',()=>aborted(),{once:true});
      });throw Error('Expected explicit deadline');
    })});
    await assert.rejects(client.rpc(operation,input,options as never),(error: unknown)=>{const failure=failureOf(error);return failure.code==='TIMEOUT'&&failure.details?.operation===operation&&
      !Object.hasOwn(failure.details ?? {},'requestId')&&!Object.hasOwn(failure.details ?? {},'submissionMayHaveSucceeded')&&!Object.hasOwn(failure.details ?? {},'recovery');});
    assert.equal(calls,1);
  }
});

test('optional custom target stays explicit and arithmetic-only suggestions must exactly match it',async()=>{
  const targetCases: Array<Record<string, unknown> & {target?: {integratedLufs: number; truePeakCeilingDbtp: number}}> = [input,{...input,target}];
  for(const request of targetCases){
    const report=readyLoudness(request as never);let dispatched: {operation?: string; input?: Record<string, unknown>} | undefined;
    assert.equal(isExportLoudnessResponse(report,request),true);
    const client=createClient({env,fetchImpl:asFetch(async (_url: string, options?: {body?: string})=>{dispatched=JSON.parse(options?.body ?? '{}') as {operation?: string; input?: Record<string, unknown>};return success(report);})});
    assert.deepEqual(await client.rpc(operation,request),report);assert.deepEqual(dispatched,{operation,input:request});
    assert.equal(Object.hasOwn(dispatched.input,'target'),Object.hasOwn(request,'target'));
    const suggestion=report.suggestion as MutableSuggestion;
    if(!request.target){assert.equal(report.suggestion,null);continue;}
    assert.equal(suggestion.purpose,'arithmetic-only');assert.equal(suggestion.applyAllowed,false);
    assert.equal(suggestion.currentTimelineValidated,false);assert.equal(suggestion.conflictsWithCeiling,true);
  }
  const request={...input,target};
  const targetEdits: Array<(v: MutableLoudness)=>void> = [v=>delete v.target,v=>{(v.target as {integratedLufs: number}).integratedLufs=-17;},v=>v.suggestion=null,
    v=>{(v.suggestion as MutableSuggestion).requiredGainDb=3;},v=>{(v.suggestion as MutableSuggestion).gainMultiplier=2;},v=>{(v.suggestion as MutableSuggestion).marginDb=0;},
    v=>{(v.suggestion as MutableSuggestion).truePeakRoomDb=(v.suggestion as MutableSuggestion).truePeakRoomDb!+1;},v=>{(v.suggestion as MutableSuggestion).projectedTruePeakDbtp=-1;},v=>{(v.suggestion as MutableSuggestion).conflictsWithCeiling=false;},
    v=>{(v.suggestion as MutableSuggestion).applyAllowed=true;},v=>{(v.suggestion as MutableSuggestion).currentTimelineValidated=true;},v=>{(v.suggestion as MutableSuggestion).requestId='gain-edit';}];
  for(const edit of targetEdits){
    const report=readyLoudness(structuredClone(request));edit(report as unknown as MutableLoudness);
    await assert.rejects(createClient({env,fetchImpl:asFetch(async()=>success(report))}).rpc(operation,request),{code:'BACKEND_PROTOCOL_ERROR'});
  }
});
test('8 KiB result guard rejects oversized and executable values without invoking accessors',async()=>{
  assert.equal(EXPORT_LOUDNESS_LIMITS.responseBytes,8192);
  let invoked=0;const getter=readyLoudness();Object.defineProperty(getter,'privateValue',{enumerable:true,get(){invoked++;throw Error('Never invoke');}});
  const toJSON=readyLoudness();Object.defineProperty(toJSON,'toJSON',{enumerable:true,value(){invoked++;return readyLoudness();}});
  const cyclic=readyLoudness() as unknown as MutableLoudness;cyclic.artifact.loop=cyclic;
  for(const report of [getter,toJSON,cyclic,{...readyLoudness(),extra:'x'.repeat(8192)},
    {...readyLoudness(),extra:'声'.repeat(3000)},Object.assign(Object.create({privateValue:'hidden'}),readyLoudness())]){
    let calls=0;const client=createClient({env,fetchImpl:asFetch(async()=>{calls++;return success(report);})});
    await assert.rejects(client.rpc(operation,input),(error: unknown)=>{const failure=failureOf(error);return failure.code==='BACKEND_PROTOCOL_ERROR'&&Object.keys(failure.details ?? {}).length===0;});
    assert.equal(calls,1);
  }
  assert.equal(invoked,0);
});
test('backend, decoder and malformed-report errors expose no token or executable stderr',async()=>{
  const secret='sk-synthetic_loudness_secret',privatePath='/private/decoder/input.mp4';
  const rawError={code:'DECODER_UNAVAILABLE',message:`Failed with Bearer ${token} ${secret}`,details:{token,authorization:`Bearer ${token}`,password:secret,nested:{apiKey:secret,diagnostic:`${token} ${secret}`}}};
  const client=createClient({env,fetchImpl:asFetch(async()=>({ok:false,status:503,json:async()=>({ok:false,error:rawError})}))});
  await assert.rejects(client.rpc(operation,input),(error: unknown)=>{const failure=failureOf(error);
    const serialized=JSON.stringify(errorEnvelope(error));
    for(const value of [token,secret,'authorization','password','apiKey'])assert.equal(serialized.includes(value),false);
    assert.equal(failure.details?.submissionMayHaveSucceeded,undefined);assert.equal(failure.details?.requestId,undefined);return true;
  });
  const malformed=incompleteLoudness('DECODE_FAILED');(malformed as {reason: {message: string}}).reason.message=`${token} ${secret} ${privatePath}`;
  await assert.rejects(createClient({env,fetchImpl:asFetch(async()=>success(malformed))}).rpc(operation,input),(error: unknown)=>{
    const serialized=JSON.stringify(errorEnvelope(error as never));for(const value of [token,secret,privatePath])assert.equal(serialized.includes(value),false);return failureOf(error).code==='BACKEND_PROTOCOL_ERROR';
  });
});
