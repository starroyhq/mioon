import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient,errorEnvelope} from '@mioon/client';
import {EXPORT_LOUDNESS_LIMITS,isExportLoudnessResponse} from '@mioon/contracts/export-loudness';
import {loudnessOperation as operation,loudnessInput as input,loudnessToken as token,readyLoudness,incompleteLoudness,loudnessTarget as target} from './fixtures/export-loudness-fixtures.mjs';
const env={MIOON_TOKEN:token};
const success=data=>({ok:true,status:200,json:async()=>({ok:true,data})});

test('loudness defaults to 125 seconds; other defaults and explicit caller deadlines stay unchanged',async t=>{
  const deadlines=[];t.mock.method(AbortSignal,'timeout',ms=>{deadlines.push(ms);return new AbortController().signal;});
  for(const [clientOptions,options,expected] of [[{},undefined,125000],[{requestTimeoutMs:8000},undefined,8000],[{},{timeoutMs:7000},7000],[{requestTimeoutMs:8000},{timeoutMs:7000},7000]]){
    const calls=[],report=readyLoudness();
    const client=createClient({env,...clientOptions,fetchImpl:async(url,request)=>{calls.push({url,...request,body:JSON.parse(request.body)});return success(report);}});
    assert.deepEqual(await client.rpc(operation,input,options),report);assert.equal(deadlines.at(-1),expected);
    assert.equal(calls.length,1);assert.deepEqual(calls[0].body,{operation,input});assert.equal(calls[0].method,'POST');assert.equal(new URL(calls[0].url).pathname,'/api/rpc');
  }
  const client=createClient({env,fetchImpl:async(_url,request)=>{const {operation:op}=JSON.parse(request.body);return success(op==='timeline.export.preflight'?{
    projectId:input.projectId,expectedRevision:1,timelineId:null,timelineRevision:null,snapshotHash:null,checkedAt:'2026-10-13T00:00:00.000Z',
    status:'blocked',summary:null,checks:{totalAssets:0,checkedAssets:0,bytesHashed:0,fullDecode:false},issues:[]}:null);}});
  await client.rpc('project.list',{});assert.equal(deadlines.at(-1),30000);
  await client.rpc('timeline.export.preflight',{projectId:input.projectId,expectedRevision:1});assert.equal(deadlines.at(-1),35000);
});
test('client carries workspace and caller cancellation outside strict input without new request ID',async()=>{
  const controller=new AbortController(),origin='44444444-4444-4444-8444-444444444444';let seen;
  const client=createClient({env,fetchImpl:async(_url,request)=>{seen=request;return success(readyLoudness());}});
  await client.rpc(operation,input,{signal:controller.signal,expectedWorkspaceOrigin:origin});
  assert.deepEqual(JSON.parse(seen.body),{operation,input,expectedWorkspaceOrigin:origin});
  assert.equal(seen.signal.aborted,false);controller.abort();assert.equal(seen.signal.aborted,true);
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
  const edits=[v=>v.projectId=input.exportId,v=>v.exportId=input.projectId,v=>v.expectedArtifactSha256='c'.repeat(64),
    v=>v.artifact.sha256='c'.repeat(64),v=>v.artifact.snapshotSha256='not-a-hash',v=>v.measurementProfile='different-profile',
    v=>v.measurement.samplePeakLinear=0.75,v=>v.measurement.truePeakLinear=0.4,v=>v.measurement.integratedLufs=Infinity,
    v=>v.measurement.gatingBlockCount=8,v=>v.measurement.state='digital_silence',v=>v.measurement.sampleFrames=47999,
    v=>v.checks.audioFullyDecoded=false,v=>v.checks.bytesHashed=1024,v=>v.path='/private',v=>v.filename='arbitrary.mp4',
    v=>v.measurement.sourceHash='c'.repeat(64),v=>v.artifact.path='/private/file.mp4',v=>v.suggestion={applyAllowed:true}];
  for(const value of [null,{},[],...edits.map(edit=>{const v=readyLoudness();edit(v);return v;})]){
    let calls=0;const client=createClient({env,fetchImpl:async()=>{calls++;return success(value);}});
    await assert.rejects(client.rpc(operation,input),error=>{assert.equal(error.code,'BACKEND_PROTOCOL_ERROR');assert.deepEqual(error.details,{});return true;});
    assert.equal(calls,1);
  }
  for(const code of ['BUSY','TIMEOUT','DECODE_FAILED'])assert.deepEqual(await createClient({env,fetchImpl:async()=>success(incompleteLoudness(code))}).rpc(operation,input),incompleteLoudness(code));
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
test('an explicit loudness deadline interrupts one request without automatic retry or mutation guidance',async()=>{
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

test('optional custom target stays explicit and arithmetic-only suggestions must exactly match it',async()=>{
  for(const request of [input,{...input,target}]){
    const report=readyLoudness(request);let dispatched;
    assert.equal(isExportLoudnessResponse(report,request),true);
    const client=createClient({env,fetchImpl:async(_url,options)=>{dispatched=JSON.parse(options.body);return success(report);}});
    assert.deepEqual(await client.rpc(operation,request),report);assert.deepEqual(dispatched,{operation,input:request});
    assert.equal(Object.hasOwn(dispatched.input,'target'),Object.hasOwn(request,'target'));
    if(!request.target){assert.equal(report.suggestion,null);continue;}
    assert.equal(report.suggestion.purpose,'arithmetic-only');assert.equal(report.suggestion.applyAllowed,false);
    assert.equal(report.suggestion.currentTimelineValidated,false);assert.equal(report.suggestion.conflictsWithCeiling,true);
  }
  const request={...input,target};
  for(const edit of [v=>delete v.target,v=>v.target.integratedLufs=-17,v=>v.suggestion=null,
    v=>v.suggestion.requiredGainDb=3,v=>v.suggestion.gainMultiplier=2,v=>v.suggestion.marginDb=0,
    v=>v.suggestion.truePeakRoomDb+=1,v=>v.suggestion.projectedTruePeakDbtp=-1,v=>v.suggestion.conflictsWithCeiling=false,
    v=>v.suggestion.applyAllowed=true,v=>v.suggestion.currentTimelineValidated=true,v=>v.suggestion.requestId='gain-edit']){
    const report=readyLoudness(structuredClone(request));edit(report);
    await assert.rejects(createClient({env,fetchImpl:async()=>success(report)}).rpc(operation,request),{code:'BACKEND_PROTOCOL_ERROR'});
  }
});
test('8 KiB result guard rejects oversized and executable values without invoking accessors',async()=>{
  assert.equal(EXPORT_LOUDNESS_LIMITS.responseBytes,8192);
  let invoked=0;const getter=readyLoudness();Object.defineProperty(getter,'privateValue',{enumerable:true,get(){invoked++;throw Error('Never invoke');}});
  const toJSON=readyLoudness();Object.defineProperty(toJSON,'toJSON',{enumerable:true,value(){invoked++;return readyLoudness();}});
  const cyclic=readyLoudness();cyclic.artifact.loop=cyclic;
  for(const report of [getter,toJSON,cyclic,{...readyLoudness(),extra:'x'.repeat(8192)},
    {...readyLoudness(),extra:'声'.repeat(3000)},Object.assign(Object.create({privateValue:'hidden'}),readyLoudness())]){
    let calls=0;const client=createClient({env,fetchImpl:async()=>{calls++;return success(report);}});
    await assert.rejects(client.rpc(operation,input),error=>error.code==='BACKEND_PROTOCOL_ERROR'&&Object.keys(error.details).length===0);
    assert.equal(calls,1);
  }
  assert.equal(invoked,0);
});
test('backend, decoder and malformed-report errors expose no token or executable stderr',async()=>{
  const secret='sk-synthetic_loudness_secret',privatePath='/private/decoder/input.mp4';
  const rawError={code:'DECODER_UNAVAILABLE',message:`Failed with Bearer ${token} ${secret}`,details:{token,authorization:`Bearer ${token}`,password:secret,nested:{apiKey:secret,diagnostic:`${token} ${secret}`}}};
  const client=createClient({env,fetchImpl:async()=>({ok:false,status:503,json:async()=>({ok:false,error:rawError})})});
  await assert.rejects(client.rpc(operation,input),error=>{
    const serialized=JSON.stringify(errorEnvelope(error));
    for(const value of [token,secret,'authorization','password','apiKey'])assert.equal(serialized.includes(value),false);
    assert.equal(error.details.submissionMayHaveSucceeded,undefined);assert.equal(error.details.requestId,undefined);return true;
  });
  const malformed=incompleteLoudness('DECODE_FAILED');malformed.reason.message=`${token} ${secret} ${privatePath}`;
  await assert.rejects(createClient({env,fetchImpl:async()=>success(malformed)}).rpc(operation,input),error=>{
    const serialized=JSON.stringify(errorEnvelope(error));for(const value of [token,secret,privatePath])assert.equal(serialized.includes(value),false);return error.code==='BACKEND_PROTOCOL_ERROR';
  });
});
