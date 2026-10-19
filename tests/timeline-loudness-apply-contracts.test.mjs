import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isTimelineRecord} from '../packages/contracts/src/timeline-replacement.ts';
import {TIMELINE_LOUDNESS_CANDIDATE_VERSION, timelineLoudnessApplyInputSchema, isTimelineLoudnessApplyInput,
  canonicalTimelineLoudnessCandidate, timelineLoudnessCandidateDigest, isTimelineLoudnessApplicableReport,
  createTimelineLoudnessApplyContracts,hasTimelineLoudnessApplyNotAppliedProof} from '../packages/contracts/src/timeline-loudness-apply.ts';
import {readyMixLoudness, mixLoudnessInput, silentMixLoudness} from './fixtures/timeline-mix-loudness-fixtures.ts';
const {isTimelineLoudnessApplyResponse}=createTimelineLoudnessApplyContracts({isTimelineRecord});
const report=()=>readyMixLoudness({...mixLoudnessInput,target:{integratedLufs:-24,truePeakCeilingDbtp:-1}});
const inputFor=value=>({...mixLoudnessInput,target:value.target,requestId:'reviewed-fixed-gain-request',snapshotSha256:value.identity.snapshotSha256,
  candidateDigest:`${TIMELINE_LOUDNESS_CANDIDATE_VERSION}:${createHash('sha256').update(canonicalTimelineLoudnessCandidate(value)).digest('hex')}`});
function ack(){
  const value=report(),input=inputFor(value),trackId='55555555-5555-4555-8555-555555555555',gain=value.candidate.gains[0];
  const timeline={id:value.identity.timelineId,projectId:input.projectId,revision:input.expectedRevision+1,fps:30,width:1280,height:720,
    tracks:[{id:trackId,name:'Sound',kind:'audio',orderIndex:0,hidden:false,muted:false}],
    clips:[{id:gain.clipId,trackId,assetId:gain.assetId,name:'Sound',startFrame:0,durationFrames:30,sourceInFrame:0,
      rect:{x:0,y:0,width:1280,height:720},gain:gain.afterGain}],durationFrames:30,
    createdAt:'2026-10-14T00:00:00.000Z',updatedAt:'2026-10-14T01:00:00.000Z'};
  return {input,value:{operation:'timeline.loudness.apply',requestId:input.requestId,timeline,application:{
    candidateDigest:input.candidateDigest,snapshotSha256:input.snapshotSha256,mixProfile:input.mixProfile,measurementProfile:input.measurementProfile,
    target:input.target,beforeRevision:input.expectedRevision,afterRevision:input.expectedRevision+1,gainMultiplier:value.candidate.gainMultiplier,
    gains:value.candidate.gains,original:value.original,candidate:value.candidate.measurement,meetsTarget:true,meetsTruePeak:true,marginDb:.5}}};
}
test('apply input is exactly bounded scalar intent; gains, paths, timing and permission are not input',()=>{
  const input=inputFor(report());assert.deepEqual(timelineLoudnessApplyInputSchema.parse(input),input);assert.equal(isTimelineLoudnessApplyInput(input),true);
  for(const patch of [{gains:[]},{path:'/private/source'},{filter:'volume=0.1'},{approved:true},{checkedAt:'2026-10-14T00:00:00.000Z'},
    {expiresAt:1},{candidateDigest:'a'.repeat(64)},{candidateDigest:'timeline-loudness-candidate-v2:'+ 'a'.repeat(64)},
    {snapshotSha256:'wrong'},{target:{integratedLufs:-24,truePeakCeilingDbtp:-1,approved:true}},{requestId:'short'}])
    assert.equal(isTimelineLoudnessApplyInput({...input,...patch}),false);
  let reads=0;assert.equal(isTimelineLoudnessApplyInput({...input,get approved(){reads++;return true;}}),false);assert.equal(reads,0);
  const cyclic={...input};cyclic.target=cyclic;assert.equal(isTimelineLoudnessApplyInput(cyclic),false);
  const hidden={...input};Object.defineProperty(hidden,'approved',{value:true});assert.equal(isTimelineLoudnessApplyInput(hidden),false);
});
test('canonical versioned digest binds full report, excludes checkedAt and ignores object key order',async()=>{
  const first=report(),changed={...first,checkedAt:'2026-10-15T01:02:03.000Z'};
  const reverse=value=>Array.isArray(value)?value.map(reverse):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([key,value])=>[key,reverse(value)])):value;
  assert.equal(canonicalTimelineLoudnessCandidate(first),canonicalTimelineLoudnessCandidate(changed));
  assert.equal(await timelineLoudnessCandidateDigest(first),inputFor(first).candidateDigest);
  assert.equal(await timelineLoudnessCandidateDigest(reverse(changed)),inputFor(first).candidateDigest);
  for(const mutate of [v=>v.identity.snapshotSha256='c'.repeat(64),v=>v.identity.sources[0].sha256='d'.repeat(64),
    v=>{v.candidate.gains[0].beforeGain=.5;v.candidate.gains[0].afterGain=.5*v.candidate.gainMultiplier;},
    v=>v.checks.decodeWorkFrames+=2,v=>{v.original.samplePeakLinear=.4;v.original.samplePeakDbfs=20*Math.log10(.4);}]){
    const copy=structuredClone(first);mutate(copy);assert.notEqual(await timelineLoudnessCandidateDigest(copy),inputFor(first).candidateDigest);
  }
  assert.throws(()=>canonicalTimelineLoudnessCandidate({...first,applyAllowed:true}),TypeError);
});
test('read-only reports stay read-only; only separately measured passing actual changes are applicable',()=>{
  const ready=report();assert.equal(ready.applyAllowed,false);assert.equal(isTimelineLoudnessApplicableReport(ready),true);
  assert.equal(isTimelineLoudnessApplicableReport(silentMixLoudness()),false);
  assert.equal(isTimelineLoudnessApplicableReport(readyMixLoudness()),false); // actual TP fails
  const same=readyMixLoudness({...mixLoudnessInput,target:{integratedLufs:-20,truePeakCeilingDbtp:-1}});
  assert.equal(isTimelineLoudnessApplicableReport(same),false);
});
test('typed ACK binds full established timeline, reviewed intent and measured application proof',()=>{
  const {input,value}=ack();assert.equal(isTimelineLoudnessApplyResponse(value,input),true);
  assert.equal(isTimelineLoudnessApplyResponse(value.timeline,input),false);
  assert.equal(isTimelineLoudnessApplyResponse(value,{...input,requestId:'another-key'}),false);
  assert.equal(isTimelineLoudnessApplyResponse(value,{...input,projectId:'99999999-9999-4999-8999-999999999999'}),false);
  assert.equal(isTimelineLoudnessApplyResponse(value,{...input,candidateDigest:input.candidateDigest.replace(/.$/u,'f')}),false);
});
const badProofs=[['operation',v=>v.operation='timeline.clip.update'],['request',v=>v.requestId='other-request'],
  ['extra',v=>v.approved=true],['before revision',v=>v.application.beforeRevision++],['after revision',v=>v.application.afterRevision++],
  ['target',v=>v.application.target.integratedLufs++],['hash',v=>v.application.snapshotSha256='e'.repeat(64)],
  ['source',v=>v.application.gains[0].assetId='99999999-9999-4999-8999-999999999999'],
  ['gain',v=>v.timeline.clips[0].gain=.25],['gain order',v=>v.application.gains.push({...v.application.gains[0]})],
  ['target claim',v=>v.application.meetsTarget=false],['reserve',v=>v.application.marginDb=0],['muted',v=>v.timeline.tracks[0].muted=true],
  ['candidate duration',v=>{v.application.candidate.sampleFrames++;v.application.candidate.decodedDurationSeconds=v.application.candidate.sampleFrames/48000;}],
  ['current timeline extra',v=>v.timeline.approved=true],['clipping',v=>v.application.gains[0].afterGain=2.01]];
for(const [name,mutate]of badProofs)test(`typed ACK rejects ${name}`,()=>{const {input,value}=ack();mutate(value);assert.equal(isTimelineLoudnessApplyResponse(value,input),false);});
test('hostile ACK getters cannot run through legacy DTO validation',()=>{
  const {input,value}=ack();let reads=0;Object.defineProperty(value.timeline,'clips',{enumerable:true,get(){reads++;return [];}});
  assert.equal(isTimelineLoudnessApplyResponse(value,input),false);assert.equal(reads,0);
});
test('new envelope retains existing timeline DTO string and optional-field semantics',()=>{
  const {input,value}=ack();value.timeline.clips[0].name='legacy \ud800';
  assert.equal(isTimelineRecord(value.timeline),true);assert.equal(isTimelineLoudnessApplyResponse(value,input),true);
  value.timeline.clips[0].fadeInFrames=0;assert.equal(isTimelineLoudnessApplyResponse(value,input),true);
});

test('not-applied proof never inherits legacy optional owner fields or generic media errors',()=>{
  const input=inputFor(report()),details={mutationOutcome:'not_applied',operation:'timeline.loudness.apply',projectId:input.projectId,requestId:input.requestId};
  for(const code of ['TIMELINE_LOUDNESS_APPLY_STALE','TIMELINE_LOUDNESS_APPLY_UNSAFE','TIMELINE_LOUDNESS_APPLY_UNCHANGED','REVISION_CONFLICT','TIMELINE_REVISION_LIMIT'])
    assert.equal(hasTimelineLoudnessApplyNotAppliedProof({code,status:409,details},input),true);
  for(const field of ['operation','projectId','requestId']){const missing={...details};delete missing[field];
    assert.equal(hasTimelineLoudnessApplyNotAppliedProof({code:'REVISION_CONFLICT',status:409,details:missing},input),false);}
  for(const patch of [{status:503},{status:403},{code:'TIMELINE_MIX_LOUDNESS_DECODE_FAILED'},{terminationUnconfirmed:true},
    {details:{...details,projectId:'99999999-9999-4999-8999-999999999999'}},{details:{...details,operation:'timeline.clip.update'}}])
    assert.equal(hasTimelineLoudnessApplyNotAppliedProof({code:'REVISION_CONFLICT',status:409,details,...patch},input),false);
  assert.equal(hasTimelineLoudnessApplyNotAppliedProof({code:'REVISION_CONFLICT',status:409,details},{...input,approved:true}),false);
  let getters=0;assert.equal(hasTimelineLoudnessApplyNotAppliedProof({get code(){getters++;return 'REVISION_CONFLICT';},status:409,details},input),false);assert.equal(getters,0);
});
