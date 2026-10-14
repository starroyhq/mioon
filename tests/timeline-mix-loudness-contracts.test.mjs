import test from 'node:test';
import assert from 'node:assert/strict';
import {TIMELINE_MIX_LOUDNESS_PROFILE,timelineMixLoudnessInputSchema,isTimelineMixLoudnessResponse} from '../packages/contracts/src/timeline-mix-loudness.ts';
import {EXPORT_LOUDNESS_PROFILE} from '../packages/contracts/src/export-loudness.ts';
const projectId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', timelineId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  assetId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',clipId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const input={projectId,expectedRevision:4,mixProfile:TIMELINE_MIX_LOUDNESS_PROFILE,measurementProfile:EXPORT_LOUDNESS_PROFILE,
  target:{integratedLufs:-23,truePeakCeilingDbtp:-1}};
function measurement(){return{sampleRate:48000,channels:2,sampleFrames:48000,decodedDurationSeconds:1,state:'valid',integratedLufs:-23,
  samplePeakLinear:.1,samplePeakDbfs:-20,truePeakLinear:.2,truePeakDbtp:20*Math.log10(.2),gatingBlockCount:7,
  absoluteGatedBlockCount:7,relativeGatedBlockCount:7,relativeGateLufs:-33};}
function ready(){return{...input,status:'ready',checkedAt:'2026-10-14T00:00:00.000Z',stage:'preencode_float_mix',applyAllowed:false,
  identity:{timelineId,timelineRevision:4,snapshotSha256:'a'.repeat(64),range:{startFrame:0,endFrame:30,sampleFrames:48000},
    sources:[{assetId,sha256:'b'.repeat(64),sizeBytes:10}]},original:measurement(),
  candidate:{status:'measured',reason:null,requiredGainDb:0,gainMultiplier:1,gains:[{clipId,assetId,beforeGain:.5,afterGain:.5}],
    measurement:measurement(),meetsTarget:true,meetsTruePeak:true,marginDb:.5,applyAllowed:false},
  checks:{bytesHashed:20,pcmBytes:768000,decodeWorkFrames:62,segmentCount:1,passes:2,audioFullyDecoded:true}};}
test('full mix requires explicit target, profiles and current revision; no path or edit request',()=>{
  assert.deepEqual(timelineMixLoudnessInputSchema.parse(input),input);
  for(const patch of [{target:undefined},{expectedRevision:0},{mixProfile:'mp4_h264_v1'},{measurementProfile:'guess'},
    {target:{integratedLufs:-14}},{target:{integratedLufs:-61,truePeakCeilingDbtp:-1}},
    {target:{integratedLufs:-23,truePeakCeilingDbtp:1}},{path:'/private'},{requestId:'new-write'},{exportRange:{startFrame:0,endFrame:1}}])
    assert.equal(timelineMixLoudnessInputSchema.safeParse({...input,...patch}).success,false);
});
test('complete actual candidate report remains readonly even when both targets pass',()=>{
  assert.equal(isTimelineMixLoudnessResponse(ready(),input),true);
  assert.equal(isTimelineMixLoudnessResponse(ready(),{...input,expectedRevision:5}),false);
  assert.equal(isTimelineMixLoudnessResponse(ready(),{...input,target:{...input.target,integratedLufs:-22}}),false);
});
const mutations=[['apply permission',v=>v.applyAllowed=true],['candidate permission',v=>v.candidate.applyAllowed=true],
  ['AAC tolerance',v=>{v.original.sampleFrames++;v.original.decodedDurationSeconds=v.original.sampleFrames/48000;}],
  ['candidate sample loss',v=>{v.candidate.measurement.sampleFrames--;v.candidate.measurement.decodedDurationSeconds=v.candidate.measurement.sampleFrames/48000;}],
  ['range',v=>v.identity.range.startFrame=1],['revision',v=>v.identity.timelineRevision++],['hash',v=>v.identity.snapshotSha256='bad'],
  ['singlehash',v=>v.checks.bytesHashed=10],['pcm',v=>v.checks.pcmBytes--],['passes',v=>v.checks.passes=1],
  ['partial',v=>v.checks.audioFullyDecoded=false],['worklimit',v=>v.checks.decodeWorkFrames=72001],
  ['duplicate sources',v=>v.identity.sources.push({...v.identity.sources[0]})],
  ['duplicate gains',v=>v.candidate.gains.push({...v.candidate.gains[0]})],
  ['wrong source',v=>v.candidate.gains[0].assetId=timelineId],['clamp',v=>v.candidate.gains[0].afterGain=.4],
  ['gain max',v=>v.candidate.gains[0].afterGain=2.1],['multiplier',v=>v.candidate.gainMultiplier=2],
  ['arithmetic',v=>v.candidate.requiredGainDb=1],['target flag',v=>v.candidate.meetsTarget=false],
  ['TP flag',v=>v.candidate.meetsTruePeak=false],['reserve',v=>v.candidate.marginDb=0],
  ['private path',v=>v.identity.sources[0].path='/private'],['NaN',v=>v.original.integratedLufs=NaN]];
for(const[name,mutate]of mutations)test(`full mix rejects ${name}`,()=>{const v=ready();mutate(v);assert.equal(isTimelineMixLoudnessResponse(v,input),false);});
test('silent original has explicit absent candidate and only one complete PCM pass',()=>{
  const v=ready();v.original={...measurement(),state:'digital_silence',samplePeakLinear:0,samplePeakDbfs:null,truePeakLinear:0,truePeakDbtp:null,
    integratedLufs:null,absoluteGatedBlockCount:0,relativeGatedBlockCount:0,relativeGateLufs:null};
  v.candidate={status:'unavailable',reason:'NO_VALID_LOUDNESS',requiredGainDb:null,gainMultiplier:null,gains:[],measurement:null,
    meetsTarget:false,meetsTruePeak:false,marginDb:.5,applyAllowed:false};
  v.checks={...v.checks,passes:1,pcmBytes:384000,decodeWorkFrames:31};
  assert.equal(isTimelineMixLoudnessResponse(v,input),true);
  v.candidate.reason='GAIN_OUT_OF_RANGE';assert.equal(isTimelineMixLoudnessResponse(v,input),false);
});
test('gain constraint unavailability is explicit, never a clamped measured result',()=>{
  const v=ready();v.target={integratedLufs:-5,truePeakCeilingDbtp:-1};
  v.candidate={status:'unavailable',reason:'GAIN_OUT_OF_RANGE',requiredGainDb:18,gainMultiplier:10**(18/20),gains:[],measurement:null,
    meetsTarget:false,meetsTruePeak:false,marginDb:.5,applyAllowed:false};
  v.checks={...v.checks,passes:1,pcmBytes:384000,decodeWorkFrames:31};
  assert.equal(isTimelineMixLoudnessResponse(v),true);
  v.candidate.requiredGainDb=0;assert.equal(isTimelineMixLoudnessResponse(v),false);
});
test('guard rejects accessors, sparse arrays, cycles and toJSON without invoking them',()=>{
  let calls=0;const a=ready();Object.defineProperty(a,'candidate',{enumerable:true,get(){calls++;return ready().candidate;}});
  assert.equal(isTimelineMixLoudnessResponse(a,input),false);assert.equal(calls,0);
  const b=ready();b.toJSON=()=>{calls++;return ready();};assert.equal(isTimelineMixLoudnessResponse(b,input),false);assert.equal(calls,0);
  const c=ready();c.identity.sources.length=2;assert.equal(isTimelineMixLoudnessResponse(c,input),false);
  const d=ready();d.extra=d;assert.equal(isTimelineMixLoudnessResponse(d,input),false);
  const e=ready();e.extra='x'.repeat(65537);assert.equal(isTimelineMixLoudnessResponse(e,input),false);
});
