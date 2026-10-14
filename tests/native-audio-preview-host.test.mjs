import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createPublicKey,verify} from 'node:crypto';
import {createNativeAudioPreviewHost,createNativeAudioPreviewSigningIdentity} from '../apps/desktop/src/native-audio-preview-host.ts';
import {nativeAudioProofMaterial} from '../packages/contracts/src/native-audio-preview.ts';
import {createNativeAudioPreviewBroker} from '../apps/desktop/src/native-audio-preview-broker.ts';

const uuid=()=>randomUUID();
const hash='a'.repeat(64);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function destroyedContents(document){
  const calls={mainFrame:0,send:0,frameUrl:0};
  Object.defineProperty(document.contents,'mainFrame',{get(){calls.mainFrame++;throw Error('WebContents destroyed');}});
  document.contents.send=()=>{calls.send++;throw Error('WebContents destroyed');};
  Object.defineProperty(document.frame,'url',{get(){calls.frameUrl++;throw Error('Frame destroyed');}});
  return calls;
}
function fixture(){
  const backendId=uuid(),events=[],commands=[];
  const documents=new Map();let routingId=0;
  function owner(){const frame={url:'http://127.0.0.1:12345/?project=',isDestroyed:()=>false,detached:false,processId:1,routingId:++routingId,frameToken:uuid()};
    const contents={mainFrame:frame,send:(channel,event)=>events.push({contents,channel,event})};
    const document={backendId,windowId:uuid(),contextId:uuid(),projectId:uuid(),contents,frame,isCurrent:()=>documents.get(contents)===document};
    frame.url+=document.projectId;documents.set(contents,document);return document;}
  const identity=createNativeAudioPreviewSigningIdentity(backendId);
  let retire=()=>Promise.resolve(),reserve=()=>Promise.resolve(),freshSnapshots=false,backendExitConfirmed=false,admissionAllowed=true;
  const host=createNativeAudioPreviewHost({backendId,origin:'http://127.0.0.1:12345',signer:identity,
    isAdmissionAllowed:()=>admissionAllowed,
    isBackendExitConfirmed:()=>backendExitConfirmed,
    ownerForContents:contents=>{const value=documents.get(contents);return value?(freshSnapshots?{...value}:value):null;},request:async (command,onPending)=>{
      commands.push(command);if(command.type==='native-audio:retire')await retire(command,onPending);else await reserve(command,onPending);
      return {type:'native-audio:reply',version:1,requestId:command.requestId,backendId,leaseId:command.leaseId,
        ...(command.type==='native-audio:reserve'?{status:'reserved',planHash:hash,admittedBytes:2097152}:{status:'retired',code:'NONE'})};}});
  const request=(document,actionId=uuid())=>({action:'acquire',contextId:document.contextId,actionId,
    input:{projectId:document.projectId,timelineId:uuid(),expectedRevision:1,startFrame:0},planHash:hash});
  const dispatch=(document,request)=>host.dispatch({sender:document.contents,senderFrame:document.frame},request);
  return {backendId,identity,host,owner,request,dispatch,events,commands,documents,setRetire:fn=>{retire=fn;},setReserve:fn=>{reserve=fn;},freshSnapshots:()=>{freshSnapshots=true;},confirmBackendExit:()=>{backendExitConfirmed=true;},setAdmissionAllowed:value=>{admissionAllowed=value;}};
}

test('B waits for exact renderer AND backend retirement; stale A release cannot retire B',async()=>{
  const f=fixture(),a=f.owner(),b=f.owner(),ar=f.request(a),br=f.request(b);
  const grantedA=await f.dispatch(a,ar);assert.equal(grantedA.status,'granted');
  const backend=Promise.withResolvers();f.setRetire(()=>backend.promise);
  let grantedB=false;const pending=f.dispatch(b,br).then(value=>{grantedB=true;return value;});await tick();
  assert.equal(grantedB,false);assert.equal(f.commands.filter(c=>c.type==='native-audio:reserve').length,1);
  assert.equal(await f.dispatch(a,{action:'retired',contextId:a.contextId,actionId:ar.actionId,leaseId:grantedA.lease.leaseId,status:'retired'}),true);
  await tick();assert.equal(grantedB,false);backend.resolve();const next=await pending;assert.equal(next.status,'granted');
  assert.notEqual(next.lease.leaseId,grantedA.lease.leaseId);
  assert.equal(await f.dispatch(a,{action:'retired',contextId:a.contextId,actionId:ar.actionId,leaseId:grantedA.lease.leaseId,status:'retired'}),false);
  assert.equal((await f.dispatch(a,ar)).status,'cancelled','A completed action replay cannot stop B');
  assert.equal(f.commands.filter(c=>c.type==='native-audio:retire').length,1);
});

test('proof is bound to actual frame/current document/lease and only fixed canonical PCM request',async()=>{
  const f=fixture(),a=f.owner(),b=f.owner(),request=f.request(a),grant=await f.dispatch(a,request);
  const input={...request.input,clipId:uuid(),sourceHash:hash,planHash:hash};
  const query=new URLSearchParams(input).toString();
  const details={id:1,url:'http://127.0.0.1:12345/api/timeline-audio-preview/pcm?'+query,method:'GET',resourceType:'xhr',
    webContents:a.contents,frame:a.frame,requestHeaders:{'X-Mioon-Audio-Lease':grant.lease.leaseId,'x-mioon-audio-signature':'forged'}};
  const signed=f.host.beforeSendHeaders(details);assert.equal(signed.cancel,false);
  const proof=JSON.parse(Buffer.from(signed.requestHeaders['X-Mioon-Audio-Proof'],'base64url').toString());
  assert.equal(verify(null,Buffer.from(nativeAudioProofMaterial(proof)),createPublicKey({key:Buffer.from(f.identity.config.publicKey,'hex'),format:'der',type:'spki'}),Buffer.from(signed.requestHeaders['X-Mioon-Audio-Signature'],'hex')),true);
  assert.deepEqual(f.host.beforeSendHeaders(details),signed,'Repeated callback for one real request keeps its exact sequence/proof');
  assert.equal(f.host.beforeSendHeaders({...details,webContents:b.contents,frame:b.frame}).cancel,true);
  assert.equal(f.host.beforeSendHeaders({...details,frame:null}).cancel,true);
  assert.equal(f.host.beforeSendHeaders({...details,method:'POST'}).cancel,true);
  assert.equal(f.host.beforeSendHeaders({...details,url:details.url+'&startFrame=0'}).cancel,true);
  f.documents.delete(a.contents);assert.equal(f.host.beforeSendHeaders(details).cancel,true);
});

test('cancelled B never receives a late grant after A retires',async()=>{
  const f=fixture(),a=f.owner(),b=f.owner(),ar=f.request(a),br=f.request(b),grant=await f.dispatch(a,ar);
  const pending=f.dispatch(b,br);await tick();await f.dispatch(b,{action:'cancel',contextId:b.contextId,actionId:br.actionId});
  await f.dispatch(a,{action:'retired',contextId:a.contextId,actionId:ar.actionId,leaseId:grant.lease.leaseId,status:'retired'});
  assert.equal((await pending).status,'cancelled');assert.equal(f.commands.filter(c=>c.type==='native-audio:reserve').length,1);
});

test('unknown renderer cleanup blocks B until actual destruction of exact A window',async()=>{
  const f=fixture(),a=f.owner(),b=f.owner(),ar=f.request(a),br=f.request(b),grant=await f.dispatch(a,ar);
  let finished=false;const pending=f.dispatch(b,br).then(value=>{finished=true;return value;});await tick();
  await f.dispatch(a,{action:'retired',contextId:a.contextId,actionId:ar.actionId,leaseId:grant.lease.leaseId,status:'unconfirmed'});await tick();
  assert.equal(finished,false);assert.ok(f.events.some(value=>value.contents===b.contents&&value.event.type==='blocked'));
  f.host.revokeWindowDestroyed(uuid());await tick();assert.equal(finished,false);
  f.host.revokeWindowDestroyed(a.windowId);assert.equal((await pending).status,'granted');
});

test('duplicate B acquire joins one exact handoff even when owner lookup returns new snapshots',async()=>{
  const f=fixture(),a=f.owner(),b=f.owner(),ar=f.request(a),br=f.request(b),grant=await f.dispatch(a,ar);
  f.freshSnapshots();const first=f.dispatch(b,br);await tick();const second=f.dispatch(b,br);await tick();
  assert.equal(f.commands.filter(c=>c.type==='native-audio:retire').length,1);
  await f.dispatch(a,{action:'retired',contextId:a.contextId,actionId:ar.actionId,leaseId:grant.lease.leaseId,status:'retired'});
  assert.deepEqual(await first,await second);assert.equal(f.commands.filter(c=>c.type==='native-audio:reserve').length,2);
});

test('shutdown fences acquisition but still accepts the exact renderer cleanup and waits for backend',async()=>{
  const f=fixture(),a=f.owner(),b=f.owner(),ar=f.request(a),grant=await f.dispatch(a,ar),backend=Promise.withResolvers();
  f.setRetire(()=>backend.promise);let complete=false;const shutting=f.host.shutdown().then(()=>{complete=true;});await tick();
  assert.equal((await f.dispatch(b,f.request(b))).status,'unavailable');
  assert.equal(await f.dispatch(a,{action:'retired',contextId:a.contextId,actionId:ar.actionId,leaseId:grant.lease.leaseId,status:'retired'}),true);
  await tick();assert.equal(complete,false);backend.resolve();await shutting;assert.equal(complete,true);
  assert.equal(f.commands.filter(c=>c.type==='native-audio:reserve').length,1);
});

test('shutdown observation timeout never treats window closure as destruction or frees old capacity',async t=>{
  const f=fixture(),a=f.owner(),ar=f.request(a);await f.dispatch(a,ar);
  const backend=Promise.withResolvers();f.setRetire(()=>backend.promise);
  t.mock.timers.enable({apis:['setTimeout']});
  const rejected=assert.rejects(f.host.shutdown({timeoutMs:5}),{code:'NATIVE_AUDIO_UNCONFIRMED'});
  // No actual WebContents destruction has occurred. A close event elsewhere
  // cannot manufacture renderer proof or authorize a new backend epoch.
  t.mock.timers.tick(5);await rejected;
  assert.equal((await f.dispatch(a,f.request(a))).status,'unavailable');
  f.host.revokeWindowDestroyed(a.windowId);backend.resolve();await tick();
  await f.host.shutdown({timeoutMs:5});
  assert.equal(f.commands.filter(c=>c.type==='native-audio:retire').length,1,'Late proof joins original drain without replaying stop');
});

test('shutdown during provisional reserve retires its original lease and never grants the late result',async()=>{
  const f=fixture(),a=f.owner(),gate=Promise.withResolvers();f.setReserve(()=>gate.promise);
  const acquiring=f.dispatch(a,f.request(a));await tick();let complete=false;
  const shutting=f.host.shutdown().then(()=>{complete=true;});await tick();assert.equal(complete,false);
  gate.resolve();assert.equal((await acquiring).status,'cancelled');await shutting;
  assert.equal(f.commands.filter(c=>c.type==='native-audio:reserve').length,1);
  assert.equal(f.commands.filter(c=>c.type==='native-audio:retire').length,1);
});

test('broker timeout is only an uncertainty observation; exact late reply settles the original request',async t=>{
  const backendId=uuid(),sent=[];let notices=0,settled=false;
  t.mock.timers.enable({apis:['setTimeout']});
  const broker=createNativeAudioPreviewBroker({backendId,send:command=>sent.push(command),isCurrent:()=>true,timeoutMs:5});
  const command={type:'native-audio:retire',version:1,requestId:uuid(),owner:{backendId,windowId:uuid(),contextId:uuid(),projectId:uuid()},actionId:uuid(),leaseId:uuid()};
  const work=broker.request(command,()=>{notices++;}).then(value=>{settled=true;return value;});
  t.mock.timers.tick(5);await tick();assert.equal(notices,1);assert.equal(settled,false);assert.equal(sent.length,1);
  broker.handle({type:'native-audio:reply',version:1,requestId:uuid(),backendId,leaseId:command.leaseId,status:'retired',code:'NONE'});
  await tick();assert.equal(settled,false,'A different request cannot clear the original uncertainty');
  const reply={type:'native-audio:reply',version:1,requestId:command.requestId,backendId,leaseId:command.leaseId,status:'retired',code:'NONE'};
  broker.handle(reply);assert.deepEqual(await work,reply);assert.equal(settled,true);broker.close();
});

test('late retirement after a blocked notification cannot revive cancelled B',async()=>{
  const f=fixture(),a=f.owner(),b=f.owner(),ar=f.request(a),br=f.request(b),grant=await f.dispatch(a,ar),backend=Promise.withResolvers();let notice;
  f.setRetire((_command,onPending)=>{notice=onPending;return backend.promise;});
  const waiting=f.dispatch(b,br);await tick();notice();
  assert.ok(f.events.some(value=>value.contents===b.contents&&value.event.type==='blocked'));
  await f.dispatch(b,{action:'cancel',contextId:b.contextId,actionId:br.actionId});
  await f.dispatch(a,{action:'retired',contextId:a.contextId,actionId:ar.actionId,leaseId:grant.lease.leaseId,status:'retired'});
  backend.resolve();assert.equal((await waiting).status,'cancelled');assert.equal(f.commands.filter(c=>c.type==='native-audio:reserve').length,1);
  assert.equal((await f.dispatch(b,f.request(b))).status,'granted','A new explicit action can use the now-proven clean capacity');
});

test('exact supervisor exit repairs only backend proof after broker loss; renderer still must retire',async()=>{
  const f=fixture(),a=f.owner(),ar=f.request(a),grant=await f.dispatch(a,ar);
  f.setRetire(()=>Promise.reject(Error('Exact utility transport closed')));
  let complete=false;const shutting=f.host.shutdown().then(()=>{complete=true;});await tick();
  assert.equal(f.host.notifyBackendExit(),false,'An unconfirmed exit or live/unknown media cannot establish cleanup');
  await tick();assert.equal(complete,false);
  f.confirmBackendExit();assert.equal(f.host.notifyBackendExit(),true);await tick();assert.equal(complete,false,'Utility exit cannot release WebAudio');
  assert.equal(await f.dispatch(a,{action:'retired',contextId:a.contextId,actionId:ar.actionId,leaseId:grant.lease.leaseId,status:'retired'}),true);
  await shutting;assert.equal(complete,true);assert.equal(f.commands.filter(c=>c.type==='native-audio:retire').length,1);
});

test('renderer destruction alone cannot substitute for unconfirmed backend media exit',async t=>{
  const f=fixture(),a=f.owner();await f.dispatch(a,f.request(a));f.setRetire(()=>Promise.reject(Error('utility lost')));
  t.mock.timers.enable({apis:['setTimeout']});const blocked=assert.rejects(f.host.shutdown({timeoutMs:5}),{code:'NATIVE_AUDIO_UNCONFIRMED'});
  f.host.revokeWindowDestroyed(a.windowId);assert.equal(f.host.notifyBackendExit(),false);t.mock.timers.tick(5);await blocked;
  f.confirmBackendExit();assert.equal(f.host.notifyBackendExit(),true);await f.host.shutdown({timeoutMs:5});
});

test('requesting revokes audition without revoking cleanup identity; same editor cannot acquire until cancellation',async()=>{
  const f=fixture(),a=f.owner(),ar=f.request(a),grant=await f.dispatch(a,ar),backend=Promise.withResolvers();
  f.setRetire(()=>backend.promise);f.setAdmissionAllowed(false);f.host.revokeOwner(a);
  const denied=f.request(a);assert.deepEqual(await f.dispatch(a,denied),{status:'unavailable'});
  assert.equal(f.commands.filter(c=>c.type==='native-audio:reserve').length,1);
  assert.deepEqual(await f.dispatch(a,{action:'describe'}),grant.lease.owner,'The exact document remains trusted for cleanup');
  assert.equal(await f.dispatch(a,{action:'retired',contextId:a.contextId,actionId:ar.actionId,leaseId:grant.lease.leaseId,status:'retired'}),true);
  backend.resolve();await tick();f.setAdmissionAllowed(true);
  assert.deepEqual(await f.dispatch(a,ar),{status:'cancelled'},'The retired action cannot revive after Quit is cancelled');
  assert.deepEqual(await f.dispatch(a,denied),{status:'cancelled'},'An action rejected during requesting is not a fresh gesture after recovery');
  assert.equal((await f.dispatch(a,f.request(a))).status,'granted','Only a new action may acquire after interaction resumes');
});

test('late reservation cannot publish while admission is disallowed, even with the same trusted document',async()=>{
  const f=fixture(),a=f.owner(),ar=f.request(a),reservation=Promise.withResolvers();f.setReserve(()=>reservation.promise);
  const pending=f.dispatch(a,ar);await tick();f.setAdmissionAllowed(false);reservation.resolve();
  assert.deepEqual(await pending,{status:'cancelled'});
  assert.equal(f.commands.filter(c=>c.type==='native-audio:retire').length,1,'Original provisional reservation is retired before completion');
  f.setAdmissionAllowed(true);assert.deepEqual(await f.dispatch(a,ar),{status:'cancelled'});
});

test('admission gate denies fresh and repeated source signatures while cancellation and retirement still work',async()=>{
  const f=fixture(),a=f.owner(),ar=f.request(a),grant=await f.dispatch(a,ar);
  const input={...ar.input,clipId:uuid(),sourceHash:hash,planHash:hash};
  const details={id:1,url:'http://127.0.0.1:12345/api/timeline-audio-preview/pcm?'+new URLSearchParams(input),method:'GET',resourceType:'xhr',
    webContents:a.contents,frame:a.frame,requestHeaders:{'X-Mioon-Audio-Lease':grant.lease.leaseId}};
  assert.equal(f.host.beforeSendHeaders(details).cancel,false);f.setAdmissionAllowed(false);
  const repeated=f.host.beforeSendHeaders(details),fresh=f.host.beforeSendHeaders({...details,id:2});
  assert.equal(repeated.cancel,true,'Cached proof does not bypass the lifecycle gate');
  assert.equal(Object.hasOwn(repeated,'requestHeaders'),false,'Rejected requests contain no signed headers');
  assert.equal(fresh.cancel,true,'No new proof is signed during requesting');
  assert.equal(Object.hasOwn(fresh,'requestHeaders'),false,'Fresh rejected requests contain no signed headers');
  assert.equal(await f.dispatch(a,{action:'cancel',contextId:a.contextId,actionId:ar.actionId}),true);
  assert.equal(await f.dispatch(a,{action:'retired',contextId:a.contextId,actionId:ar.actionId,leaseId:grant.lease.leaseId,status:'retired'}),true);
  await f.host.shutdown();
});

test('cancelled interaction fence never revives a waiting B action after A finally retires',async()=>{
  const f=fixture(),a=f.owner(),b=f.owner(),ar=f.request(a),br=f.request(b),grant=await f.dispatch(a,ar),backend=Promise.withResolvers();
  f.setRetire(()=>backend.promise);const pending=f.dispatch(b,br);await tick();
  f.setAdmissionAllowed(false);f.host.revokeOwner(a);f.host.revokeOwner(b);f.setAdmissionAllowed(true);
  assert.equal(await f.dispatch(a,{action:'retired',contextId:a.contextId,actionId:ar.actionId,leaseId:grant.lease.leaseId,status:'retired'}),true);
  backend.resolve();assert.deepEqual(await pending,{status:'cancelled'});
  assert.equal(f.commands.filter(c=>c.type==='native-audio:reserve').length,1);
  assert.equal((await f.dispatch(b,f.request(b))).status,'granted');
});

test('actual destroyed A retires without calling dead contents and still waits for exact backend proof',async()=>{
  const f=fixture(),a=f.owner(),b=f.owner(),ar=f.request(a);await f.dispatch(a,ar);
  const backend=Promise.withResolvers();f.setRetire(()=>backend.promise);
  const calls=destroyedContents(a);f.host.revokeWindowDestroyed(a.windowId);
  let granted=false;const pending=f.dispatch(b,f.request(b)).then(result=>{granted=true;return result;});await tick();
  assert.equal(granted,false,'Actual renderer destruction proves only one retirement half');
  assert.equal(await f.dispatch(a,{action:'describe'}),null,'A queued old dispatch cannot inspect the destroyed contents');
  assert.deepEqual(calls,{mainFrame:0,send:0,frameUrl:0});
  backend.resolve();assert.equal((await pending).status,'granted');
  f.host.revokeWindowDestroyed(a.windowId);
  assert.equal(f.commands.filter(c=>c.type==='native-audio:retire').length,1,'Late A destruction cannot retire B');
  assert.deepEqual(calls,{mainFrame:0,send:0,frameUrl:0});
});

test('destroyed waiting B never receives late blocked notifications and never acquires after A retirement',async()=>{
  const f=fixture(),a=f.owner(),b=f.owner(),ar=f.request(a),grant=await f.dispatch(a,ar),backend=Promise.withResolvers();let pendingNotice;
  f.setRetire((_command,onPending)=>{pendingNotice=onPending;return backend.promise;});
  const pending=f.dispatch(b,f.request(b));await tick();const calls=destroyedContents(b);
  f.host.revokeWindowDestroyed(b.windowId);pendingNotice();
  assert.equal(await f.dispatch(a,{action:'retired',contextId:a.contextId,actionId:ar.actionId,leaseId:grant.lease.leaseId,status:'unconfirmed'}),true);
  assert.deepEqual(calls,{mainFrame:0,send:0,frameUrl:0});
  f.host.revokeWindowDestroyed(a.windowId);backend.resolve();assert.deepEqual(await pending,{status:'cancelled'});
  assert.equal(f.commands.filter(c=>c.type==='native-audio:reserve').length,1);
  assert.deepEqual(calls,{mainFrame:0,send:0,frameUrl:0});
});

test('incidental navigation cannot use a stale document ACK as renderer retirement proof',async()=>{
  const f=fixture(),a=f.owner(),b=f.owner(),ar=f.request(a),grant=await f.dispatch(a,ar),backend=Promise.withResolvers();
  f.setRetire(()=>backend.promise);f.host.revokeOwner(a);
  const oldSenderFrame={...a.frame,detached:true};
  const nextFrame={...a.frame,routingId:a.frame.routingId+100,frameToken:uuid()},next={...a,contextId:uuid(),frame:nextFrame,
    isCurrent:()=>f.documents.get(a.contents)===next};
  a.contents.mainFrame=nextFrame;f.documents.set(a.contents,next);
  const retired={action:'retired',contextId:a.contextId,actionId:ar.actionId,leaseId:grant.lease.leaseId,status:'retired'};
  assert.equal(await f.host.dispatch({sender:a.contents,senderFrame:nextFrame},retired),false,'New frame cannot acknowledge the old frame resources');
  assert.deepEqual(await f.dispatch(a,ar),{status:'unavailable'},'Old document cannot acquire again');
  const source={...ar.input,clipId:uuid(),sourceHash:hash,planHash:hash};
  assert.equal(f.host.beforeSendHeaders({id:100,url:'http://127.0.0.1:12345/api/timeline-audio-preview/pcm?'+new URLSearchParams(source),
    method:'GET',resourceType:'xhr',webContents:a.contents,frame:oldSenderFrame,requestHeaders:{'X-Mioon-Audio-Lease':grant.lease.leaseId}}).cancel,true);
  let complete=false;const waiting=f.dispatch(b,f.request(b)).then(value=>{complete=true;return value;});await tick();
  assert.equal(await f.host.dispatch({sender:a.contents,senderFrame:null},retired),false);
  assert.equal(await f.host.dispatch({sender:a.contents,senderFrame:oldSenderFrame},{...retired,leaseId:uuid()}),false);
  assert.equal(await f.host.dispatch({sender:a.contents,senderFrame:oldSenderFrame},retired),false,'Normal reload must retire before navigation; stale ACK authority stays closed');
  backend.resolve();await tick();assert.equal(complete,false,'Backend proof cannot substitute for unknown old renderer cleanup');
  f.host.revokeWindowDestroyed(a.windowId);
  backend.resolve();assert.equal((await waiting).status,'granted');
  assert.equal(await f.host.dispatch({sender:a.contents,senderFrame:oldSenderFrame},retired),false,'Late ACK cannot clear the replacement lease');
});

test('normal reload retirement waits both exact halves and fences new audio through the later P0 decision',async()=>{
  const f=fixture(),a=f.owner(),ar=f.request(a),grant=await f.dispatch(a,ar),backend=Promise.withResolvers(),reload=new AbortController();
  f.setRetire(()=>backend.promise);let complete=false;
  const ready=f.host.retireOwnerForReload(a,reload.signal).then(value=>{complete=true;return value;});await tick();
  const denied=f.request(a);assert.deepEqual(await f.dispatch(a,denied),{status:'unavailable'});
  assert.equal(await f.dispatch(a,{action:'retired',contextId:a.contextId,actionId:ar.actionId,leaseId:grant.lease.leaseId,status:'retired'}),true);
  await tick();assert.equal(complete,false);backend.resolve();assert.equal(await ready,true);
  assert.deepEqual(await f.dispatch(a,f.request(a)),{status:'unavailable'},'Fresh P0 capture and confirmation still hold this document fence');
  reload.abort();assert.deepEqual(await f.dispatch(a,ar),{status:'cancelled'});assert.deepEqual(await f.dispatch(a,denied),{status:'cancelled'});
  assert.equal((await f.dispatch(a,f.request(a))).status,'granted','Cancelling reload permits only a fresh explicit prepare, without resuming the old lease');
});

test('reload observer cancellation never releases unknown cleanup or a newer reload fence',async()=>{
  const f=fixture(),a=f.owner(),ar=f.request(a),grant=await f.dispatch(a,ar),backend=Promise.withResolvers(),first=new AbortController(),second=new AbortController();
  f.setRetire(()=>backend.promise);
  const old=f.host.retireOwnerForReload(a,first.signal),current=f.host.retireOwnerForReload(a,second.signal);
  assert.equal(await old,false,'A newer attempt supersedes only the older observation');first.abort();
  assert.deepEqual(await f.dispatch(a,f.request(a)),{status:'unavailable'},'Old abort cannot release the newer attempt fence');
  second.abort();assert.equal(await current,false);let granted=false;
  const b=f.owner(),waiting=f.dispatch(b,f.request(b)).then(value=>{granted=true;return value;});await tick();assert.equal(granted,false);
  backend.resolve();await tick();assert.equal(granted,false,'Observer cancellation is not renderer cleanup proof');
  await f.dispatch(a,{action:'retired',contextId:a.contextId,actionId:ar.actionId,leaseId:grant.lease.leaseId,status:'retired'});
  assert.equal((await waiting).status,'granted');assert.equal(f.commands.filter(c=>c.type==='native-audio:retire').length,1);
});

test('idle reload fences only its exact document and an already aborted reload creates no fence',async()=>{
  const f=fixture(),a=f.owner(),b=f.owner(),reload=new AbortController();
  assert.equal(await f.host.retireOwnerForReload(a,reload.signal),true);assert.deepEqual(await f.dispatch(a,f.request(a)),{status:'unavailable'});
  assert.equal((await f.dispatch(b,f.request(b))).status,'granted','Unrelated editor admission remains independent');
  reload.abort();const cancelled=new AbortController();cancelled.abort();
  assert.equal(await f.host.retireOwnerForReload(a,cancelled.signal),false);
  assert.equal(f.commands.filter(c=>c.type==='native-audio:retire').length,0,'Reload without owned audio cannot stop B');
});

test('stale reload owner and late observer cannot retire a newer document lease',async()=>{
  const f=fixture(),old=f.owner(),oldReload=new AbortController();assert.equal(await f.host.retireOwnerForReload(old,oldReload.signal),true);
  const frame={...old.frame,routingId:old.frame.routingId+1,frameToken:uuid()},next={...old,contextId:uuid(),frame,isCurrent:()=>f.documents.get(old.contents)===next};
  old.contents.mainFrame=frame;f.documents.set(old.contents,next);
  const request=f.request(next),grant=await f.dispatch(next,request);assert.equal(grant.status,'granted');
  assert.equal(await f.host.retireOwnerForReload(old,new AbortController().signal),false);oldReload.abort();
  assert.equal(f.commands.filter(c=>c.type==='native-audio:retire').length,0);
  assert.equal((await f.dispatch(next,request)).lease.leaseId,grant.lease.leaseId);
});

test('reload cancels only its waiting action and cannot turn its late reservation into a grant',async()=>{
  const f=fixture(),a=f.owner(),ar=f.request(a),reserve=Promise.withResolvers(),reload=new AbortController();f.setReserve(()=>reserve.promise);
  const acquiring=f.dispatch(a,ar);await tick();const ready=f.host.retireOwnerForReload(a,reload.signal);
  reserve.resolve();assert.deepEqual(await acquiring,{status:'cancelled'});assert.equal(await ready,true);
  assert.equal(f.commands.filter(c=>c.type==='native-audio:retire').length,1);reload.abort();
});

test('disposed audio host refuses reload retirement without inspecting dead contents or issuing commands',async()=>{
  const f=fixture(),a=f.owner();await f.host.shutdown();const calls=destroyedContents(a);
  assert.equal(await f.host.retireOwnerForReload(a,new AbortController().signal),false);
  assert.deepEqual(calls,{mainFrame:0,send:0,frameUrl:0});assert.equal(f.commands.length,0);
});
