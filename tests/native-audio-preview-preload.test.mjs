import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createNativeAudioPreviewBridge} from '../apps/desktop/src/native-audio-preview-preload.ts';
import {NATIVE_AUDIO_CHANNEL,NATIVE_AUDIO_EVENT} from '../packages/contracts/src/native-audio-preview.ts';
const uuid=()=>randomUUID(),hash='a'.repeat(64);
function fixture(){
  const owner={backendId:uuid(),windowId:uuid(),contextId:uuid(),projectId:uuid()},input={projectId:owner.projectId,timelineId:uuid(),expectedRevision:1,startFrame:0};
  let current=owner,receive,reply;const calls=[];
  const bridge=createNativeAudioPreviewBridge({invoke:async(channel,request)=>{assert.equal(channel,NATIVE_AUDIO_CHANNEL);calls.push(request);
    if(request.action==='describe')return current;if(request.action==='acquire')return reply??{status:'granted',lease:{owner:current,input,actionId:request.actionId,leaseId:uuid(),planHash:hash,admittedBytes:2097152}};return true;},
    on:(channel,listener)=>{assert.equal(channel,NATIVE_AUDIO_EVENT);receive=listener;},removeListener(){}});
  return {bridge,owner,input,calls,setOwner:value=>{current=value;},setReply:value=>{reply=value;},emit:value=>receive({sender:'must not escape'},value)};
}
test('native audio preload locks first exact owner and cannot borrow replacement generation',async()=>{
  const f=fixture();await f.bridge.context();const seen=[];f.bridge.subscribe(event=>seen.push(event));
  const replacement={...f.owner,contextId:uuid()};f.setOwner(replacement);
  f.emit({type:'waiting',owner:replacement,actionId:uuid(),waitingForWindowId:uuid()});
  await assert.rejects(f.bridge.acquire(f.input,hash,uuid()));
  assert.equal(f.calls.filter(c=>c.action==='acquire').length,0);assert.equal(seen.length,0);
});
test('late acquire result from a different owner is refused, including same project',async()=>{
  const f=fixture(),actionId=uuid();await f.bridge.context();
  f.setReply({status:'granted',lease:{owner:{...f.owner,windowId:uuid()},input:f.input,actionId,leaseId:uuid(),planHash:hash,admittedBytes:2097152}});
  await assert.rejects(f.bridge.acquire(f.input,hash,actionId));
});
test('retirement keeps original own generation and cannot acknowledge another lease owner',async()=>{
  const f=fixture(),action=uuid(),result=await f.bridge.acquire(f.input,hash,action);
  await assert.rejects(f.bridge.retired({...result.lease,owner:{...f.owner,contextId:uuid()}},'retired'));
  assert.equal(await f.bridge.retired(result.lease,'retired'),true);
  assert.deepEqual(f.calls.at(-1),{action:'retired',contextId:f.owner.contextId,actionId:action,leaseId:result.lease.leaseId,status:'retired'});
});
test('cancel before describe settles fences that original action without sending an acquire or stopping A',async()=>{
  const owner={backendId:uuid(),windowId:uuid(),contextId:uuid(),projectId:uuid()},describe=Promise.withResolvers(),calls=[];
  const bridge=createNativeAudioPreviewBridge({invoke:async(_channel,request)=>{calls.push(request);if(request.action==='describe')return describe.promise;throw Error('Cancelled B must never reach main admission');},on(){},removeListener(){}});
  const input={projectId:owner.projectId,timelineId:uuid(),expectedRevision:1,startFrame:0},actionId=uuid();
  const pending=bridge.acquire(input,hash,actionId);
  assert.equal(await bridge.cancel(actionId),true,'The original action is already registered before describe returns');
  describe.resolve(owner);assert.deepEqual(await pending,{status:'cancelled'});
  assert.deepEqual(calls,[{action:'describe'}],'No acquire or handoff is sent after cancellation');
  assert.equal(await bridge.cancel(actionId),false,'The unsent action is released after its original describe settles');
});
test('pending describes consume the same bounded admission slots as granted actions',async()=>{
  const owner={backendId:uuid(),windowId:uuid(),contextId:uuid(),projectId:uuid()},describe=Promise.withResolvers(),calls=[];
  const bridge=createNativeAudioPreviewBridge({invoke:async(_channel,request)=>{calls.push(request);return describe.promise;},on(){},removeListener(){}});
  const input={projectId:owner.projectId,timelineId:uuid(),expectedRevision:1,startFrame:0},actions=Array.from({length:8},()=>uuid());
  const pending=actions.map(actionId=>bridge.acquire(input,hash,actionId));
  assert.deepEqual(await bridge.acquire(input,hash,uuid()),{status:'busy'});assert.equal(calls.length,8);
  await Promise.all(actions.map(actionId=>bridge.cancel(actionId)));describe.resolve(owner);
  assert.deepEqual(await Promise.all(pending),actions.map(()=>({status:'cancelled'})));
  assert.equal(calls.length,8,'Cancelled pending describes cannot later become main acquisitions');
});
