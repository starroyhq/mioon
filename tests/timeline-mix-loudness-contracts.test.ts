type StrictIntersection<T> = (T extends unknown ? (value: T)=>void : never) extends ((value: infer I)=>void) ? I : never;
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
  for(const patch of ([{target:undefined},{expectedRevision:0},{mixProfile:'mp4_h264_v1'},{measurementProfile:'guess'},
    {target:{integratedLufs:-14}},{target:{integratedLufs:-61,truePeakCeilingDbtp:-1}},
    {target:{integratedLufs:-23,truePeakCeilingDbtp:1}},{path:'/private'},{requestId:'new-write'},{exportRange:{startFrame:0,endFrame:1}}] as const))
    assert.equal(timelineMixLoudnessInputSchema.safeParse({...input,...patch}).success,false);
});
test('complete actual candidate report remains readonly even when both targets pass',()=>{
  assert.equal(isTimelineMixLoudnessResponse(ready(),input),true);
  assert.equal(isTimelineMixLoudnessResponse(ready(),{...input,expectedRevision:5}),false);
  assert.equal(isTimelineMixLoudnessResponse(ready(),{...input,target:{...input.target,integratedLufs:-22}}),false);
});
const mutations=([['apply permission',(v: { applyAllowed: boolean; })=>v.applyAllowed=true],['candidate permission',(v: { candidate: { applyAllowed: boolean; }; })=>v.candidate.applyAllowed=true],
  ['AAC tolerance',(v: { original: { sampleFrames: number; decodedDurationSeconds: number; }; })=>{v.original.sampleFrames++;v.original.decodedDurationSeconds=v.original.sampleFrames/48000;}],
  ['candidate sample loss',(v: { candidate: { measurement: { sampleFrames: number; decodedDurationSeconds: number; }; }; })=>{v.candidate.measurement.sampleFrames--;v.candidate.measurement.decodedDurationSeconds=v.candidate.measurement.sampleFrames/48000;}],
  ['range',(v: { identity: { range: { startFrame: number; }; }; })=>v.identity.range.startFrame=1],['revision',(v: { identity: { timelineRevision: number; }; })=>v.identity.timelineRevision++],['hash',(v: { identity: { snapshotSha256: string; }; })=>v.identity.snapshotSha256='bad'],
  ['singlehash',(v: { checks: { bytesHashed: number; }; })=>v.checks.bytesHashed=10],['pcm',(v: { checks: { pcmBytes: number; }; })=>v.checks.pcmBytes--],['passes',(v: { checks: { passes: number; }; })=>v.checks.passes=1],
  ['partial',(v: { checks: { audioFullyDecoded: boolean; }; })=>v.checks.audioFullyDecoded=false],['worklimit',(v: { checks: { decodeWorkFrames: number; }; })=>v.checks.decodeWorkFrames=72001],
  ['duplicate sources',(v: { identity: { sources: unknown[]; }; })=>v.identity.sources.push({...(v.identity.sources[0] as Record<string, unknown>)})],
  ['duplicate gains',(v: { candidate: { gains: unknown[]; }; })=>v.candidate.gains.push({...(v.candidate.gains[0] as Record<string, unknown>)})],
  ['wrong source',(v: { candidate: { gains: { assetId: string; }[]; }; })=>v.candidate.gains[0].assetId=timelineId],['clamp',(v: { candidate: { gains: { afterGain: number; }[]; }; })=>v.candidate.gains[0].afterGain=.4],
  ['gain max',(v: { candidate: { gains: { afterGain: number; }[]; }; })=>v.candidate.gains[0].afterGain=2.1],['multiplier',(v: { candidate: { gainMultiplier: number; }; })=>v.candidate.gainMultiplier=2],
  ['arithmetic',(v: { candidate: { requiredGainDb: number; }; })=>v.candidate.requiredGainDb=1],['target flag',(v: { candidate: { meetsTarget: boolean; }; })=>v.candidate.meetsTarget=false],
  ['TP flag',(v: { candidate: { meetsTruePeak: boolean; }; })=>v.candidate.meetsTruePeak=false],['reserve',(v: { candidate: { marginDb: number; }; })=>v.candidate.marginDb=0],
  ['private path',(v: { identity: { sources: { path: string; }[]; }; })=>v.identity.sources[0].path='/private'],['NaN',(v: { original: { integratedLufs: number; }; })=>v.original.integratedLufs=NaN]] as const);
for(const[name,mutate]of mutations)test(`full mix rejects ${name}`,()=>{const v=ready();mutate(((v) as unknown as StrictIntersection<Parameters<NonNullable<typeof mutate>>[0]>));assert.equal(isTimelineMixLoudnessResponse(v,input),false);});
test('silent original has explicit absent candidate and only one complete PCM pass',()=>{
  const v=ready();v.original={...measurement(),state:'digital_silence',samplePeakLinear:0,samplePeakDbfs:((null) as unknown as number),truePeakLinear:0,truePeakDbtp:((null) as unknown as number),
    integratedLufs:((null) as unknown as number),absoluteGatedBlockCount:0,relativeGatedBlockCount:0,relativeGateLufs:((null) as unknown as number)};
  v.candidate={status:'unavailable',reason:(('NO_VALID_LOUDNESS') as unknown as null),requiredGainDb:((null) as unknown as number),gainMultiplier:((null) as unknown as number),gains:[],measurement:((null) as unknown as { sampleRate: number; channels: number; sampleFrames: number; decodedDurationSeconds: number; state: string; integratedLufs: number; samplePeakLinear: number; samplePeakDbfs: number; truePeakLinear: number; truePeakDbtp: number; gatingBlockCount: number; absoluteGatedBlockCount: number; relativeGatedBlockCount: number; relativeGateLufs: number; }),
    meetsTarget:false,meetsTruePeak:false,marginDb:.5,applyAllowed:false};
  v.checks={...v.checks,passes:1,pcmBytes:384000,decodeWorkFrames:31};
  assert.equal(isTimelineMixLoudnessResponse(v,input),true);
  v.candidate.reason=('GAIN_OUT_OF_RANGE' as unknown as ((typeof v)["candidate"])["reason"]);assert.equal(isTimelineMixLoudnessResponse(v,input),false);
});
test('gain constraint unavailability is explicit, never a clamped measured result',()=>{
  const v=ready();v.target={integratedLufs:-5,truePeakCeilingDbtp:-1};
  v.candidate={status:'unavailable',reason:(('GAIN_OUT_OF_RANGE') as unknown as null),requiredGainDb:18,gainMultiplier:10**(18/20),gains:[],measurement:((null) as unknown as { sampleRate: number; channels: number; sampleFrames: number; decodedDurationSeconds: number; state: string; integratedLufs: number; samplePeakLinear: number; samplePeakDbfs: number; truePeakLinear: number; truePeakDbtp: number; gatingBlockCount: number; absoluteGatedBlockCount: number; relativeGatedBlockCount: number; relativeGateLufs: number; }),
    meetsTarget:false,meetsTruePeak:false,marginDb:.5,applyAllowed:false};
  v.checks={...v.checks,passes:1,pcmBytes:384000,decodeWorkFrames:31};
  assert.equal(isTimelineMixLoudnessResponse(v),true);
  v.candidate.requiredGainDb=0;assert.equal(isTimelineMixLoudnessResponse(v),false);
});
test('guard rejects accessors, sparse arrays, cycles and toJSON without invoking them',()=>{
  let calls=0;const a=ready();Object.defineProperty(a,'candidate',{enumerable:true,get(){calls++;return ready().candidate;}});
  assert.equal(isTimelineMixLoudnessResponse(a,input),false);assert.equal(calls,0);
  const b=ready();(b as typeof b & {toJSON:(() => { status: string; checkedAt: string; stage: string; applyAllowed: boolean; identity: { timelineId: string; timelineRevision: number; snapshotSha256: string; range: { startFrame: number; endFrame: number; sampleFrames: number; }; sources: { assetId: string; sha256: string; sizeBytes: number; }[]; }; original: { sampleRate: number; channels: number; sampleFrames: number; decodedDurationSeconds: number; state: string; integratedLufs: number; samplePeakLinear: number; samplePeakDbfs: number; truePeakLinear: number; truePeakDbtp: number; gatingBlockCount: number; absoluteGatedBlockCount: number; relativeGatedBlockCount: number; relativeGateLufs: number; }; candidate: { status: string; reason: null; requiredGainDb: number; gainMultiplier: number; gains: { clipId: string; assetId: string; beforeGain: number; afterGain: number; }[]; measurement: { sampleRate: number; channels: number; sampleFrames: number; decodedDurationSeconds: number; state: string; integratedLufs: number; samplePeakLinear: number; samplePeakDbfs: number; truePeakLinear: number; truePeakDbtp: number; gatingBlockCount: number; absoluteGatedBlockCount: number; relativeGatedBlockCount: number; relativeGateLufs: number; }; meetsTarget: boolean; meetsTruePeak: boolean; marginDb: number; applyAllowed: boolean; }; checks: { bytesHashed: number; pcmBytes: number; decodeWorkFrames: number; segmentCount: number; passes: number; audioFullyDecoded: boolean; }; projectId: string; expectedRevision: number; mixProfile: string; measurementProfile: string; target: { integratedLufs: number; truePeakCeilingDbtp: number; }; })}).toJSON=()=>{calls++;return ready();};assert.equal(isTimelineMixLoudnessResponse(b,input),false);assert.equal(calls,0);
  const c=ready();c.identity.sources.length=2;assert.equal(isTimelineMixLoudnessResponse(c,input),false);
  const d=ready();(d as typeof d & {extra:({ status: string; checkedAt: string; stage: string; applyAllowed: boolean; identity: { timelineId: string; timelineRevision: number; snapshotSha256: string; range: { startFrame: number; endFrame: number; sampleFrames: number; }; sources: { assetId: string; sha256: string; sizeBytes: number; }[]; }; original: { sampleRate: number; channels: number; sampleFrames: number; decodedDurationSeconds: number; state: string; integratedLufs: number; samplePeakLinear: number; samplePeakDbfs: number; truePeakLinear: number; truePeakDbtp: number; gatingBlockCount: number; absoluteGatedBlockCount: number; relativeGatedBlockCount: number; relativeGateLufs: number; }; candidate: { status: string; reason: null; requiredGainDb: number; gainMultiplier: number; gains: { clipId: string; assetId: string; beforeGain: number; afterGain: number; }[]; measurement: { sampleRate: number; channels: number; sampleFrames: number; decodedDurationSeconds: number; state: string; integratedLufs: number; samplePeakLinear: number; samplePeakDbfs: number; truePeakLinear: number; truePeakDbtp: number; gatingBlockCount: number; absoluteGatedBlockCount: number; relativeGatedBlockCount: number; relativeGateLufs: number; }; meetsTarget: boolean; meetsTruePeak: boolean; marginDb: number; applyAllowed: boolean; }; checks: { bytesHashed: number; pcmBytes: number; decodeWorkFrames: number; segmentCount: number; passes: number; audioFullyDecoded: boolean; }; projectId: string; expectedRevision: number; mixProfile: string; measurementProfile: string; target: { integratedLufs: number; truePeakCeilingDbtp: number; }; })|(string)}).extra=d;assert.equal(isTimelineMixLoudnessResponse(d,input),false);
  const e=ready();(e as typeof e & {extra:({ status: string; checkedAt: string; stage: string; applyAllowed: boolean; identity: { timelineId: string; timelineRevision: number; snapshotSha256: string; range: { startFrame: number; endFrame: number; sampleFrames: number; }; sources: { assetId: string; sha256: string; sizeBytes: number; }[]; }; original: { sampleRate: number; channels: number; sampleFrames: number; decodedDurationSeconds: number; state: string; integratedLufs: number; samplePeakLinear: number; samplePeakDbfs: number; truePeakLinear: number; truePeakDbtp: number; gatingBlockCount: number; absoluteGatedBlockCount: number; relativeGatedBlockCount: number; relativeGateLufs: number; }; candidate: { status: string; reason: null; requiredGainDb: number; gainMultiplier: number; gains: { clipId: string; assetId: string; beforeGain: number; afterGain: number; }[]; measurement: { sampleRate: number; channels: number; sampleFrames: number; decodedDurationSeconds: number; state: string; integratedLufs: number; samplePeakLinear: number; samplePeakDbfs: number; truePeakLinear: number; truePeakDbtp: number; gatingBlockCount: number; absoluteGatedBlockCount: number; relativeGatedBlockCount: number; relativeGateLufs: number; }; meetsTarget: boolean; meetsTruePeak: boolean; marginDb: number; applyAllowed: boolean; }; checks: { bytesHashed: number; pcmBytes: number; decodeWorkFrames: number; segmentCount: number; passes: number; audioFullyDecoded: boolean; }; projectId: string; expectedRevision: number; mixProfile: string; measurementProfile: string; target: { integratedLufs: number; truePeakCeilingDbtp: number; }; })|(string)}).extra='x'.repeat(65537);assert.equal(isTimelineMixLoudnessResponse(e,input),false);
});
