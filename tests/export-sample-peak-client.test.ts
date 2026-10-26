import type {Failure} from './helpers/strict-timeline-audio-types.ts';
type NegativeSamplePeak = ReturnType<typeof readySamplePeak> & {path?: string};
import type {TypedClient} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@mioon/client';
import {samplePeakOperation as operation,samplePeakInput as input,samplePeakToken as token,readySamplePeak,incompleteSamplePeak} from './helpers/export-sample-peak-fixture.ts';
const env={MIOON_TOKEN:token};
const success=(data: unknown)=>({ok:true,status:200,json:async()=>({ok:true,data})} as unknown as Response);

test('only sample peak defaults to 125 seconds; explicit client and call deadlines always win',async t=>{
  const deadlines: number[]=[];t.mock.method(AbortSignal,'timeout',(ms: number)=>{deadlines.push(ms);return new AbortController().signal;});
  for(const [clientOptions,options,expected] of [[{},undefined,125000],[{requestTimeoutMs:8000},undefined,8000],[{},{timeoutMs:7000},7000],[{requestTimeoutMs:8000},{timeoutMs:7000},7000]] as const){
    const calls: {url: RequestInfo | URL; body: unknown; method?: string; redirect?: RequestRedirect}[]=[],report=readySamplePeak();
    const client=(createClient({env,...clientOptions,fetchImpl:(async(url: string,request: RequestInit | undefined)=>{calls.push({url,...request,body:JSON.parse(request!.body as string)});return success(report);}) as unknown as typeof fetch}) as TypedClient);
    assert.deepEqual(await client.rpc(operation,input,options),report);assert.equal(deadlines.at(-1),expected);
    assert.equal(calls.length,1);assert.deepEqual(calls[0].body,{operation,input});assert.equal(calls[0].method,'POST');
  }
  const client=(createClient({env,fetchImpl:(async(_url: string,request: RequestInit | undefined)=>{const {operation:op}=JSON.parse(request!.body as string);return success(op==='timeline.export.preflight'?{
    projectId:input.projectId,expectedRevision:1,timelineId:null,timelineRevision:null,snapshotHash:null,checkedAt:'2026-10-13T00:00:00.000Z',
    status:'blocked',summary:null,checks:{totalAssets:0,checkedAssets:0,bytesHashed:0,fullDecode:false},issues:[]}:null);}) as unknown as typeof fetch}) as TypedClient);
  await client.rpc('project.list',{});assert.equal(deadlines.at(-1),30000);
  await client.rpc('timeline.export.preflight',{projectId:input.projectId,expectedRevision:1});assert.equal(deadlines.at(-1),35000);
});
test('client carries workspace and caller cancellation outside strict input without new request ID',async()=>{
  const controller=new AbortController(),origin='44444444-4444-4444-8444-444444444444';let seen!: RequestInit;
  const client=(createClient({env,fetchImpl:(async(_url: string,request: RequestInit | undefined)=>{seen=request!;return success(readySamplePeak());}) as unknown as typeof fetch}) as TypedClient);
  await client.rpc(operation,input,{signal:controller.signal,expectedWorkspaceOrigin:origin});
  assert.deepEqual(JSON.parse(seen.body as string),{operation,input,expectedWorkspaceOrigin:origin});
  assert.equal(seen.signal!.aborted,false);controller.abort();assert.equal(seen.signal!.aborted,true);
});
test('strict invalid inputs and unknown operation reject before connection or dispatch',async()=>{
  let calls=0;const client=(createClient({env,fetchImpl:(async()=>{calls++;throw Error('No request allowed');}) as unknown as typeof fetch}) as TypedClient);
  for(const candidate of [null,{}, {...input,requestId:'forbidden'}, {...input,path:'/private'}, {...input,timeoutMs:1}, {...input,exportId:'bad'}])
    await assert.rejects(client.rpc(operation,candidate),{code:'VALIDATION_ERROR'});
  for(const op of ['timeline.export.samplePeak.unknown','__proto__','constructor'])await assert.rejects(client.rpc(op,input),{code:'UNKNOWN_OPERATION'});
  assert.equal(calls,0);
});
test('strict responses bind export identity, amplitude semantics and ephemeral failure shape without retry',async()=>{
  const edits=[(v: NegativeSamplePeak)=>v.projectId=input.exportId,(v: NegativeSamplePeak)=>v.exportId=input.projectId,(v: NegativeSamplePeak)=>v.measurement.peakLinear=0.75,(v: NegativeSamplePeak)=>v.measurement.peakDbfs=-6,
    (v: NegativeSamplePeak)=>v.measurement.channelPeaks.reverse(),(v: NegativeSamplePeak)=>v.checks.audioFullyDecoded=false,(v: NegativeSamplePeak)=>v.checks.bytesHashed=1024,(v: NegativeSamplePeak)=>v.path='/private'];
  for(const value of [null,{},[],...edits.map(edit=>{const v=readySamplePeak();edit(v);return v;})]){
    let calls=0;const client=(createClient({env,fetchImpl:(async()=>{calls++;return success(value);}) as unknown as typeof fetch}) as TypedClient);
    await assert.rejects(client.rpc(operation,input),error=>{assert.equal((error as Failure).code,'BACKEND_PROTOCOL_ERROR');assert.deepEqual((error as Failure).details,{});return true;});
    assert.equal(calls,1);
  }
  for(const code of ['BUSY','TIMEOUT','DECODE_FAILED'] as const)assert.deepEqual(await (createClient({env,fetchImpl:(async()=>success(incompleteSamplePeak(code))) as unknown as typeof fetch}) as TypedClient).rpc(operation,input),incompleteSamplePeak(code));
});
test('transport loss, malformed JSON and local cancellation do not create receipt uncertainty or retries',async()=>{
  for(const [fetcher,expected] of [[async()=>{throw Error('Synthetic loss');},'BACKEND_UNAVAILABLE'],[async()=>({ok:true,status:200,json:async()=>{throw Error('Bad JSON');}} as unknown as Response),'BACKEND_PROTOCOL_ERROR']] as const){
    let calls=0;await assert.rejects((createClient({env,fetchImpl:(async(...args: Parameters<typeof fetch>)=>{calls++;return (fetcher as typeof fetch)(...args);}) as unknown as typeof fetch}) as TypedClient).rpc(operation,input),error=>
      (error as Failure).code===expected&&!Object.hasOwn((error as Failure).details,'requestId')&&!Object.hasOwn((error as Failure).details,'submissionMayHaveSucceeded'));
    assert.equal(calls,1);
  }
  let calls=0;const controller=new AbortController();
  const client=(createClient({env,fetchImpl:(async(_url: RequestInfo | URL,{signal}: RequestInit)=>{calls++;controller.abort();signal!.throwIfAborted();}) as unknown as typeof fetch}) as TypedClient);
  await assert.rejects(client.rpc(operation,input,{signal:controller.signal}),error=>(error as Failure).code==='INTERRUPTED'&&!Object.hasOwn((error as Failure).details,'submissionMayHaveSucceeded'));
  assert.equal(calls,1);
  await assert.rejects(client.rpc(operation,input,{signal:controller.signal}),{code:'INTERRUPTED'});assert.equal(calls,1);
});
test('an explicit sample-peak deadline interrupts one request without automatic retry or mutation guidance',async()=>{
  for(const [clientOptions,options] of [[{requestTimeoutMs:1},undefined],[{},{timeoutMs:1}]] as const){
    let calls=0;const client=(createClient({env,...clientOptions,fetchImpl:(async(_url: RequestInfo | URL,{signal}: RequestInit)=>{
      calls++;await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,200);
        const aborted=()=>{clearTimeout(timer);reject(signal!.reason);};
        if(signal!.aborted)aborted();else signal!.addEventListener('abort',aborted,{once:true});
      });throw Error('Expected explicit deadline');
    }) as unknown as typeof fetch}) as TypedClient);
    await assert.rejects(client.rpc(operation,input,options),error=>(error as Failure).code==='TIMEOUT'&&(error as Failure).details.operation===operation&&
      !Object.hasOwn((error as Failure).details,'requestId')&&!Object.hasOwn((error as Failure).details,'submissionMayHaveSucceeded')&&!Object.hasOwn((error as Failure).details,'recovery'));
    assert.equal(calls,1);
  }
});
