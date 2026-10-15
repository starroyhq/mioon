import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID,sign,generateKeyPairSync} from 'node:crypto';
import {createNativeAudioPreviewHost,createNativeAudioPreviewSigningIdentity} from '../apps/desktop/src/native-audio-preview-host.ts';
import {createNativeAudioPreviewAuthority} from '../packages/business/src/native-audio-preview.ts';
import {createNativeAudioPreviewBridge} from '../apps/desktop/src/native-audio-preview-preload.ts';
import {createNativeAudioPreviewAdmission} from '../apps/web/src/native-audio-preview-adapter.ts';
import {nativeAudioProofMaterial,NATIVE_AUDIO_LEASE_HEADER,NATIVE_AUDIO_PROOF_HEADER,NATIVE_AUDIO_SIGNATURE_HEADER} from '../packages/contracts/src/native-audio-preview.ts';
import {continuousAudioQuery,CONTINUOUS_AUDIO_ENDPOINT,CONTINUOUS_AUDIO_PROFILE,CONTINUOUS_AUDIO_LIMITS} from '../packages/contracts/src/timeline-audio-continuous.ts';

const uuid=()=>randomUUID(),hash='a'.repeat(64),tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>Promise.withResolvers();
class Response extends EventEmitter {
  destroyed=false;
  destroyCalls=0;
  destroy(){this.destroyed=true;this.destroyCalls++;return this;}
  close(){this.destroyed=true;this.emit('close');}
}
function fixture({retire=async()=>{},planning}={}){
  const backendId=uuid(),identity=createNativeAudioPreviewSigningIdentity(backendId),documents=new Map(),events=[],commands=[],retireCalls=[];
  const authority=createNativeAudioPreviewAuthority(identity.config);
  let plan;
  authority.bind({handlers:{'timeline.audioPreview.plan':async()=>{throw Error('V2 cannot fall back to V1');},
    'timeline.audioPreview.continuousPlan':async input=>{
      if(planning)await planning;
      return plan={schemaVersion:2,status:'planned',profileId:CONTINUOUS_AUDIO_PROFILE,projectId:input.projectId,timelineId:input.timelineId,
        timelineRevision:input.expectedRevision,startFrame:input.startFrame,durationFrames:18000,blockFrames:60,sampleRate:48000,channels:2,
        admittedBytes:CONTINUOUS_AUDIO_LIMITS.memoryBytes,snapshotHash:hash,planHash:hash};
    }},retireSessionById:async sessionId=>{retireCalls.push(sessionId);await retire(sessionId);}});
  function owner(){
    const projectId=uuid(),frame={url:`http://127.0.0.1:12345/?project=${projectId}`,isDestroyed:()=>false,detached:false};
    const contents={mainFrame:frame,send:(channel,event)=>events.push({contents,channel,event})};
    const document={backendId,windowId:uuid(),contextId:uuid(),projectId,contents,frame,isCurrent:()=>documents.get(contents)===document};
    documents.set(contents,document);return document;
  }
  const host=createNativeAudioPreviewHost({backendId,origin:'http://127.0.0.1:12345',signer:identity,isAdmissionAllowed:()=>true,
    ownerForContents:contents=>documents.get(contents)??null,request:command=>{commands.push(command);return authority.command(command);}});
  const request=document=>({action:'acquireContinuous',contextId:document.contextId,actionId:uuid(),sessionId:uuid(),
    input:{projectId:document.projectId,timelineId:uuid(),expectedRevision:1,startFrame:0},planHash:hash});
  const dispatch=(document,value)=>host.dispatch({sender:document.contents,senderFrame:document.frame},value);
  const block=(request,changes={})=>({...request.input,planHash:request.planHash,sessionId:request.sessionId,generation:1,sequence:1,blockStartFrame:0,...changes});
  let requestId=0;
  function signed(document,lease,input,{method='GET',id=++requestId,url=`http://127.0.0.1:12345${CONTINUOUS_AUDIO_ENDPOINT}?${continuousAudioQuery(input)}`}={}){
    const details={id,url,method,resourceType:'xhr',webContents:document.contents,frame:document.frame,requestHeaders:{[NATIVE_AUDIO_LEASE_HEADER]:lease.leaseId}};
    const result=host.beforeSendHeaders(details);
    return {result,details,request:result.cancel?null:{method,url:new URL(url).pathname+new URL(url).search,
      headers:Object.fromEntries(Object.entries(result.requestHeaders).map(([key,value])=>[key.toLowerCase(),value]))},url:new URL(url)};
  }
  function accept(call,input,response=new Response()){
    assert.equal(call.result.cancel,false);return {admission:authority.acceptContinuous(call.request,response,call.url,input),response};
  }
  const acknowledge=(document,request,lease)=>dispatch(document,{action:'retired',contextId:document.contextId,actionId:request.actionId,leaseId:lease.leaseId,status:'retired'});
  return {identity,authority,host,owner,request,dispatch,block,signed,accept,acknowledge,events,commands,retireCalls,get plan(){return plan;}};
}

test('continuous native ownership retains one 96 MiB lease across blocks and seek generations',async()=>{
  const f=fixture(),a=f.owner(),request=f.request(a),grant=await f.dispatch(a,request);
  assert.equal(grant.status,'granted');assert.equal(grant.lease.version,2);assert.equal(grant.lease.sessionId,request.sessionId);
  assert.equal(grant.lease.admittedBytes,CONTINUOUS_AUDIO_LIMITS.memoryBytes);
  for(const changes of [{},{sequence:2,blockStartFrame:60},{generation:2,sequence:3,blockStartFrame:1234}]){
    const input=f.block(request,changes),call=f.signed(a,grant.lease,input),{admission,response}=f.accept(call,input);
    assert.deepEqual(f.host.beforeSendHeaders(call.details),call.result,'Repeated callback reuses the exact signed proof');
    admission.onResourceSettlement(Promise.resolve());admission.finish();response.close();await tick();
  }
  assert.equal(f.commands.filter(command=>command.type==='native-audio:reserve').length,1);
  assert.equal(f.events.filter(event=>event.event.type==='revoke').length,0);
  assert.equal(f.signed(a,grant.lease,f.block(request,{generation:1,sequence:4,blockStartFrame:120})).result.cancel,true,'Old seek generation cannot consume the next request');
  await f.dispatch(a,{action:'cancel',contextId:a.contextId,actionId:request.actionId});
  await f.acknowledge(a,request,grant.lease);await f.host.shutdown();
  assert.deepEqual(f.retireCalls,[request.sessionId]);
});

test('continuous proofs reject forged identity, method, query, replays and a second active consumer',async()=>{
  const f=fixture(),a=f.owner(),b=f.owner(),request=f.request(a),grant=await f.dispatch(a,request),input=f.block(request);
  for(const changes of [{sessionId:uuid()},{planHash:'b'.repeat(64)},{projectId:b.projectId}])
    assert.equal(f.signed(a,grant.lease,{...input,...changes}).result.cancel,true);
  for(const changes of [{generation:257},{sequence:10001}]){
    const malformed={...input,...changes},url=`http://127.0.0.1:12345${CONTINUOUS_AUDIO_ENDPOINT}?${new URLSearchParams(malformed)}`;
    assert.equal(f.signed(a,grant.lease,malformed,{url}).result.cancel,true);
  }
  const call=f.signed(a,grant.lease,input);
  assert.equal(f.host.beforeSendHeaders({...call.details,webContents:b.contents,frame:b.frame}).cancel,true);
  assert.equal(f.host.beforeSendHeaders({...call.details,method:'DELETE'}).cancel,true,'One native request id cannot change HTTP method');
  for(const selected of [{...call.request,method:'DELETE'},{...call.request,headers:{...call.request.headers,[NATIVE_AUDIO_SIGNATURE_HEADER.toLowerCase()]:'0'.repeat(128)}},
    {...call.request,url:call.request.url+'&extra=1'}])assert.throws(()=>f.authority.acceptContinuous(selected,new Response(),call.url,input));
  const {admission,response}=f.accept(call,input),pending=deferred();admission.onResourceSettlement(pending.promise);
  assert.throws(()=>f.authority.acceptContinuous(call.request,new Response(),call.url,input),'Signed GET is one use');
  const second=f.signed(a,grant.lease,f.block(request,{sequence:2,blockStartFrame:60}));
  assert.throws(()=>f.authority.acceptContinuous(second.request,new Response(),second.url,f.block(request,{sequence:2,blockStartFrame:60})),'Concurrent source never enters');
  pending.resolve();admission.finish();response.close();await tick();
  // The server did not consume rejected sequence two; its exact proof remains
  // usable only after the previous resource, response and invocation settle.
  const accepted=f.accept(second,f.block(request,{sequence:2,blockStartFrame:60}));
  accepted.admission.finish();accepted.response.close();await tick();
  await f.dispatch(a,{action:'cancel',contextId:a.contextId,actionId:request.actionId});await f.acknowledge(a,request,grant.lease);await f.host.shutdown();
});

test('cross-window handoff awaits cursor retirement plus exact resource, response, invocation and renderer proof',async()=>{
  const cursor=deferred(),f=fixture({retire:()=>cursor.promise}),a=f.owner(),b=f.owner(),ar=f.request(a),br=f.request(b),grant=await f.dispatch(a,ar);
  const input=f.block(ar),{admission,response}=f.accept(f.signed(a,grant.lease,input),input),resource=deferred();admission.onResourceSettlement(resource.promise);
  let done=false;const waiting=f.dispatch(b,br).then(value=>{done=true;return value;});await tick();
  assert.equal(admission.signal.aborted,true);assert.ok(response.destroyCalls>0);assert.equal(done,false);
  await f.acknowledge(a,ar,grant.lease);resource.resolve();admission.finish();await tick();assert.equal(done,false,'destroy return is not HTTP close');
  response.close();await tick();assert.equal(done,false,'Cursor child retirement remains independent');
  cursor.resolve();const next=await waiting;assert.equal(next.status,'granted');assert.notEqual(next.lease.leaseId,grant.lease.leaseId);
  assert.equal(await f.acknowledge(a,ar,grant.lease),false,'Late old document acknowledgment cannot release B');
  await f.dispatch(b,{action:'cancel',contextId:b.contextId,actionId:br.actionId});await f.acknowledge(b,br,next.lease);await f.host.shutdown();
});

test('DELETE is method-bound, single-use cleanup and cannot admit more PCM even before main retirement',async()=>{
  const f=fixture(),a=f.owner(),request=f.request(a),grant=await f.dispatch(a,request),input=f.block(request);
  const active=f.accept(f.signed(a,grant.lease,input),input),resource=deferred();active.admission.onResourceSettlement(resource.promise);
  const cleanup=f.signed(a,grant.lease,input,{method:'DELETE'}),deleted=f.accept(cleanup,input);
  assert.equal(active.admission.signal.aborted,true);assert.ok(active.response.destroyCalls>0);
  assert.equal(f.signed(a,grant.lease,f.block(request,{sequence:2,blockStartFrame:60})).result.cancel,true);
  assert.throws(()=>f.authority.acceptContinuous(cleanup.request,new Response(),cleanup.url,input));
  resource.resolve();active.admission.finish();active.response.close();deleted.admission.finish();deleted.response.close();await tick();
  await f.dispatch(a,{action:'cancel',contextId:a.contextId,actionId:request.actionId});await f.acknowledge(a,request,grant.lease);await f.host.shutdown();
});

test('cancelled requests may leave bounded sequence and generation gaps, including before the first network admission',async()=>{
  const f=fixture(),a=f.owner(),request=f.request(a),grant=await f.dispatch(a,request);
  for(const changes of [{sequence:4,generation:3,blockStartFrame:650},{sequence:7,generation:5,blockStartFrame:1200}]){
    const input=f.block(request,changes),accepted=f.accept(f.signed(a,grant.lease,input),input);
    accepted.admission.finish();accepted.response.close();await tick();
  }
  assert.equal(f.signed(a,grant.lease,f.block(request,{sequence:7,generation:5,blockStartFrame:1200})).result.cancel,true,'A new native request cannot replay an already signed sequence');
  assert.equal(f.signed(a,grant.lease,f.block(request,{sequence:8,generation:4,blockStartFrame:1260})).result.cancel,true,'Generation cannot move backwards');
  const cleanupInput=f.block(request,{sequence:11,generation:8,blockStartFrame:1337}),cleanup=f.accept(f.signed(a,grant.lease,cleanupInput,{method:'DELETE'}),cleanupInput);
  cleanup.admission.finish();cleanup.response.close();await tick();
  await f.dispatch(a,{action:'cancel',contextId:a.contextId,actionId:request.actionId});await f.acknowledge(a,request,grant.lease);await f.host.shutdown();
});

test('a newer signed seek fences the old consumer before its delayed network close without releasing its resource proof',async()=>{
  const f=fixture(),a=f.owner(),request=f.request(a),grant=await f.dispatch(a,request),firstInput=f.block(request);
  const first=f.accept(f.signed(a,grant.lease,firstInput),firstInput),resource=deferred();first.admission.onResourceSettlement(resource.promise);
  const nextInput=f.block(request,{generation:3,sequence:5,blockStartFrame:650}),next=f.accept(f.signed(a,grant.lease,nextInput),nextInput);
  assert.equal(first.admission.signal.aborted,true);assert.ok(first.response.destroyCalls>0);
  next.admission.finish();next.response.close();first.admission.finish();
  await f.dispatch(a,{action:'cancel',contextId:a.contextId,actionId:request.actionId});await f.acknowledge(a,request,grant.lease);
  let retired=false;const retirement=f.host.shutdown().then(()=>{retired=true;});await tick();assert.equal(retired,false);
  first.response.close();await tick();assert.equal(retired,false,'Network close cannot release noncooperative original resource work');
  resource.resolve();await retirement;
});

test('cleanup uncertainty keeps a continuous session charged after all ordinary closures',async()=>{
  const f=fixture({retire:async()=>{throw Object.assign(Error('Unconfirmed cursor close'),{terminationUnconfirmed:true});}}),a=f.owner(),request=f.request(a),grant=await f.dispatch(a,request);
  await f.dispatch(a,{action:'cancel',contextId:a.contextId,actionId:request.actionId});await f.acknowledge(a,request,grant.lease);await tick();
  const command=f.commands.find(value=>value.type==='native-audio:retire');
  const reply=await f.authority.command({...command,requestId:uuid()});assert.equal(reply.status,'blocked');assert.equal(reply.code,'CLEANUP_UNCONFIRMED');
  assert.equal((await f.dispatch(a,request)).status,'blocked');
});

test('retiring a provisional continuous reserve cannot publish its late plan or omit session cleanup',async()=>{
  const planning=deferred(),f=fixture({planning:planning.promise}),a=f.owner(),request=f.request(a);
  const acquiring=f.dispatch(a,request);await tick();
  await f.dispatch(a,{action:'cancel',contextId:a.contextId,actionId:request.actionId});planning.resolve();
  assert.equal((await acquiring).status,'cancelled');assert.deepEqual(f.retireCalls,[request.sessionId]);await f.host.shutdown();
});

test('continuous preload and renderer adapter bind the exact session and retain late cleanup',async()=>{
  const owner={backendId:uuid(),windowId:uuid(),contextId:uuid(),projectId:uuid()},events=new Map(),calls=[],grant=deferred();
  const bridge=createNativeAudioPreviewBridge({invoke:async(_channel,request)=>{calls.push(request);if(request.action==='describe')return owner;
    if(request.action==='acquireContinuous')return grant.promise;return true;},on:(channel,listener)=>events.set(channel,listener),removeListener:channel=>events.delete(channel)});
  const input={projectId:owner.projectId,timelineId:uuid(),expectedRevision:1,startFrame:0};
  const plan={schemaVersion:2,status:'planned',profileId:CONTINUOUS_AUDIO_PROFILE,projectId:owner.projectId,timelineId:input.timelineId,
    timelineRevision:1,startFrame:0,durationFrames:18000,blockFrames:60,sampleRate:48000,channels:2,admittedBytes:CONTINUOUS_AUDIO_LIMITS.memoryBytes,snapshotHash:hash,planHash:hash};
  const attempt=createNativeAudioPreviewAdmission(bridge).beginContinuous({onRevoke(){},onWaiting(){}}),abort=new AbortController(),sessionId=uuid(),resources=deferred();
  const acquiring=attempt.acquireContinuous(plan,sessionId,abort.signal);await tick();abort.abort();await assert.rejects(acquiring,error=>error.code==='AUDIO_PREVIEW_CANCELLED');
  attempt.retire(resources.promise);
  const request=calls.find(value=>value.action==='acquireContinuous');assert.equal(request.sessionId,sessionId);
  grant.resolve({status:'granted',lease:{version:2,owner,actionId:request.actionId,leaseId:uuid(),input,planHash:hash,sessionId,admittedBytes:CONTINUOUS_AUDIO_LIMITS.memoryBytes}});
  await tick();assert.equal(calls.some(value=>value.action==='retired'),false);
  resources.resolve();await tick();assert.equal(calls.find(value=>value.action==='retired').status,'retired');assert.equal(events.size,0);
});

test('v2 signatures cannot be reused under another backend epoch or v1 protocol',async()=>{
  const f=fixture(),a=f.owner(),request=f.request(a),grant=await f.dispatch(a,request),input=f.block(request),call=f.signed(a,grant.lease,input);
  const original=JSON.parse(Buffer.from(call.request.headers[NATIVE_AUDIO_PROOF_HEADER.toLowerCase()],'base64url').toString());
  const keys=generateKeyPairSync('ed25519');
  for(const changed of [{...original,backendId:uuid()},{...original,leaseId:uuid()},{...original,version:1}]){
    const req={...call.request,headers:{...call.request.headers,[NATIVE_AUDIO_PROOF_HEADER.toLowerCase()]:Buffer.from(JSON.stringify(changed)).toString('base64url'),
      [NATIVE_AUDIO_SIGNATURE_HEADER.toLowerCase()]:sign(null,Buffer.from(nativeAudioProofMaterial(original)),keys.privateKey).toString('hex')}};
    assert.throws(()=>f.authority.acceptContinuous(req,new Response(),call.url,input));
  }
  await f.dispatch(a,{action:'cancel',contextId:a.contextId,actionId:request.actionId});await f.acknowledge(a,request,grant.lease);await f.host.shutdown();
});
