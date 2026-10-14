import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createNativeAudioPreviewAdmission} from '../apps/web/src/native-audio-preview-adapter.ts';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const uuid=()=>randomUUID();
function fixture(){
  const events=new Set(),grant=Promise.withResolvers(),calls={cancel:[],retired:[]};
  const owner={backendId:uuid(),windowId:uuid(),contextId:uuid(),projectId:uuid()};
  const input={projectId:owner.projectId,timelineId:uuid(),expectedRevision:1,startFrame:0};
  const plan={planHash:'a'.repeat(64),projectId:owner.projectId,timelineId:input.timelineId,timelineRevision:1,range:{startFrame:0},memory:{admittedBytes:2097152}};
  let actionId;
  const bridge={context:async()=>owner,acquire:(_input,_hash,action)=>{actionId=action;return grant.promise;},
    cancel:async id=>{calls.cancel.push(id);return true;},retired:async(lease,status)=>{calls.retired.push({lease,status});return true;},
    subscribe:listener=>{events.add(listener);return()=>events.delete(listener);}};
  const lease=()=>({owner,input,actionId,leaseId:uuid(),planHash:plan.planHash,admittedBytes:2097152});
  return {bridge,owner,input,plan,grant,calls,lease,emit:event=>{for(const fn of events)fn(event);}};
}
test('cancelled waiter cannot allocate after late grant and acknowledges only after local retirement',async()=>{
  const f=fixture(),abort=new AbortController(),local=Promise.withResolvers();
  const attempt=createNativeAudioPreviewAdmission(f.bridge).begin({onRevoke(){},onWaiting(){}});
  const work=attempt.acquire(f.plan,abort.signal);abort.abort();attempt.retire(local.promise);
  await assert.rejects(work,{code:'AUDIO_PREVIEW_CANCELLED'});
  f.grant.resolve({status:'granted',lease:f.lease()});await tick();assert.equal(f.calls.retired.length,0);
  local.resolve();await tick();assert.equal(f.calls.retired.length,1);assert.equal(f.calls.retired[0].status,'retired');
});
test('revoke targets only exact action and lease; failed resource proof stays unconfirmed',async()=>{
  const f=fixture();let revokes=0;const attempt=createNativeAudioPreviewAdmission(f.bridge).begin({onRevoke(){revokes++;},onWaiting(){}});
  const work=attempt.acquire(f.plan,new AbortController().signal),lease=f.lease();f.grant.resolve({status:'granted',lease});await work;
  f.emit({type:'revoke',lease:{...lease,actionId:uuid()},reason:'handoff'});assert.equal(revokes,0);
  f.emit({type:'revoke',lease,reason:'handoff'});assert.equal(revokes,1);
  attempt.retire(Promise.reject(Error('Body cancellation unknown')));await tick();
  assert.equal(f.calls.retired.length,1);assert.equal(f.calls.retired[0].status,'unconfirmed');
});
