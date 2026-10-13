import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@mioon/client';
import {samplePeakOperation as operation,samplePeakInput as input,samplePeakToken as token,readySamplePeak,incompleteSamplePeak} from './helpers/export-sample-peak-fixture.mjs';
const env={MIOON_TOKEN:token};
const success=data=>({ok:true,status:200,json:async()=>({ok:true,data})});

test('only sample peak defaults to 125 seconds; explicit client and call deadlines always win',async t=>{
  const deadlines=[];t.mock.method(AbortSignal,'timeout',ms=>{deadlines.push(ms);return new AbortController().signal;});
  for(const [clientOptions,options,expected] of [[{},undefined,125000],[{requestTimeoutMs:8000},undefined,8000],[{},{timeoutMs:7000},7000],[{requestTimeoutMs:8000},{timeoutMs:7000},7000]]){
    const calls=[],report=readySamplePeak();
    const client=createClient({env,...clientOptions,fetchImpl:async(url,request)=>{calls.push({url,...request,body:JSON.parse(request.body)});return success(report);}});
    assert.deepEqual(await client.rpc(operation,input,options),report);assert.equal(deadlines.at(-1),expected);
    assert.equal(calls.length,1);assert.deepEqual(calls[0].body,{operation,input});assert.equal(calls[0].method,'POST');
  }
  const client=createClient({env,fetchImpl:async(_url,request)=>{const {operation:op}=JSON.parse(request.body);return success(op==='timeline.export.preflight'?{
    projectId:input.projectId,expectedRevision:1,timelineId:null,timelineRevision:null,snapshotHash:null,checkedAt:'2026-10-13T00:00:00.000Z',
    status:'blocked',summary:null,checks:{totalAssets:0,checkedAssets:0,bytesHashed:0,fullDecode:false},issues:[]}:null);}});
  await client.rpc('project.list',{});assert.equal(deadlines.at(-1),30000);
  await client.rpc('timeline.export.preflight',{projectId:input.projectId,expectedRevision:1});assert.equal(deadlines.at(-1),35000);
});
test('client carries workspace and caller cancellation outside strict input without new request ID',async()=>{
  const controller=new AbortController(),origin='44444444-4444-4444-8444-444444444444';let seen;
  const client=createClient({env,fetchImpl:async(_url,request)=>{seen=request;return success(readySamplePeak());}});
  await client.rpc(operation,input,{signal:controller.signal,expectedWorkspaceOrigin:origin});
  assert.deepEqual(JSON.parse(seen.body),{operation,input,expectedWorkspaceOrigin:origin});
  assert.equal(seen.signal.aborted,false);controller.abort();assert.equal(seen.signal.aborted,true);
});
test('strict invalid inputs and unknown operation reject before connection or dispatch',async()=>{
  let calls=0;const client=createClient({env,fetchImpl:async()=>{calls++;throw Error('No request allowed');}});
  for(const candidate of [null,{}, {...input,requestId:'forbidden'}, {...input,path:'/private'}, {...input,timeoutMs:1}, {...input,exportId:'bad'}])
    await assert.rejects(client.rpc(operation,candidate),{code:'VALIDATION_ERROR'});
  for(const op of ['timeline.export.samplePeak.unknown','__proto__','constructor'])await assert.rejects(client.rpc(op,input),{code:'UNKNOWN_OPERATION'});
  assert.equal(calls,0);
});
test('strict responses bind export identity, amplitude semantics and ephemeral failure shape without retry',async()=>{
  const edits=[v=>v.projectId=input.exportId,v=>v.exportId=input.projectId,v=>v.measurement.peakLinear=0.75,v=>v.measurement.peakDbfs=-6,
    v=>v.measurement.channelPeaks.reverse(),v=>v.checks.audioFullyDecoded=false,v=>v.checks.bytesHashed=1024,v=>v.path='/private'];
  for(const value of [null,{},[],...edits.map(edit=>{const v=readySamplePeak();edit(v);return v;})]){
    let calls=0;const client=createClient({env,fetchImpl:async()=>{calls++;return success(value);}});
    await assert.rejects(client.rpc(operation,input),error=>{assert.equal(error.code,'BACKEND_PROTOCOL_ERROR');assert.deepEqual(error.details,{});return true;});
    assert.equal(calls,1);
  }
  for(const code of ['BUSY','TIMEOUT','DECODE_FAILED'])assert.deepEqual(await createClient({env,fetchImpl:async()=>success(incompleteSamplePeak(code))}).rpc(operation,input),incompleteSamplePeak(code));
});
test('transport loss, malformed JSON and local cancellation do not create receipt uncertainty or retries',async()=>{
  for(const [fetcher,expected] of [[async()=>{throw Error('Synthetic loss');},'BACKEND_UNAVAILABLE'],[async()=>({ok:true,status:200,json:async()=>{throw Error('Bad JSON');}}),'BACKEND_PROTOCOL_ERROR']]){
    let calls=0;await assert.rejects(createClient({env,fetchImpl:async(...args)=>{calls++;return fetcher(...args);}}).rpc(operation,input),error=>
      error.code===expected&&!Object.hasOwn(error.details,'requestId')&&!Object.hasOwn(error.details,'submissionMayHaveSucceeded'));
    assert.equal(calls,1);
  }
  let calls=0;const controller=new AbortController();
  const client=createClient({env,fetchImpl:async(_url,{signal})=>{calls++;controller.abort();signal.throwIfAborted();}});
  await assert.rejects(client.rpc(operation,input,{signal:controller.signal}),error=>error.code==='INTERRUPTED'&&!Object.hasOwn(error.details,'submissionMayHaveSucceeded'));
  assert.equal(calls,1);
  await assert.rejects(client.rpc(operation,input,{signal:controller.signal}),{code:'INTERRUPTED'});assert.equal(calls,1);
});
test('an explicit sample-peak deadline interrupts one request without automatic retry or mutation guidance',async()=>{
  for(const [clientOptions,options] of [[{requestTimeoutMs:1},undefined],[{},{timeoutMs:1}]]){
    let calls=0;const client=createClient({env,...clientOptions,fetchImpl:async(_url,{signal})=>{
      calls++;await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,200);
        const aborted=()=>{clearTimeout(timer);reject(signal.reason);};
        if(signal.aborted)aborted();else signal.addEventListener('abort',aborted,{once:true});
      });throw Error('Expected explicit deadline');
    }});
    await assert.rejects(client.rpc(operation,input,options),error=>error.code==='TIMEOUT'&&error.details.operation===operation&&
      !Object.hasOwn(error.details,'requestId')&&!Object.hasOwn(error.details,'submissionMayHaveSucceeded')&&!Object.hasOwn(error.details,'recovery'));
    assert.equal(calls,1);
  }
});
