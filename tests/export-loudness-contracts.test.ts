import test from 'node:test';
import assert from 'node:assert/strict';
import {EXPORT_LOUDNESS_PROFILE, exportLoudnessInputSchema, exportLoudnessMeasurementSchema,
  exportLoudnessSuggestion, exportLoudnessReason, isExportLoudnessResponse} from '../packages/contracts/src/export-loudness.ts';

const input = {projectId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',exportId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  expectedArtifactSha256:'a'.repeat(64),measurementProfile:EXPORT_LOUDNESS_PROFILE};
function measurement() {return {sampleRate:48000,channels:2,sampleFrames:48000,decodedDurationSeconds:1,
  state:'valid',integratedLufs:-23,samplePeakLinear:0.1,samplePeakDbfs:-20,truePeakLinear:0.2,truePeakDbtp:20*Math.log10(0.2),
  gatingBlockCount:7,absoluteGatedBlockCount:7,relativeGatedBlockCount:7,relativeGateLufs:-33};}
function ready(target) {const m=measurement();return {...input,...(target?{target}:{}),checkedAt:'2026-10-14T00:00:00.000Z',stage:'decoded-export-file',status:'ready',
  artifact:{assetId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',sha256:input.expectedArtifactSha256,sizeBytes:123,timelineRevision:4,snapshotSha256:'b'.repeat(64)},
  measurement:m,suggestion:exportLoudnessSuggestion(m,target),reason:null,checks:{bytesHashed:246,audioFullyDecoded:true}};}
test('input requires explicit selected file/profile, target is optional and never defaulted',()=>{
  assert.deepEqual(exportLoudnessInputSchema.parse(input),input);
  const target={integratedLufs:-23,truePeakCeilingDbtp:-1};
  assert.deepEqual(exportLoudnessInputSchema.parse({...input,target}),{...input,target});
  for(const patch of [{expectedArtifactSha256:undefined},{measurementProfile:undefined},{target:undefined},
    {target:{integratedLufs:-14}},{target:{integratedLufs:-61,truePeakCeilingDbtp:-1}},
    {target:{integratedLufs:-23,truePeakCeilingDbtp:1}}, {path:'/tmp/private'}, {requestId:'mutation'},
    {target:{integratedLufs:-23,truePeakCeilingDbtp:-1,limiter:true}}])
    assert.equal(exportLoudnessInputSchema.safeParse({...input,...patch}).success,false,JSON.stringify(patch));
});
test('complete response bound to artifact and explicit arithmetic target',()=>{
  assert.equal(isExportLoudnessResponse(ready(),input),true);
  assert.equal(ready().suggestion,null);
  for(const target of [{integratedLufs:-23,truePeakCeilingDbtp:-1},{integratedLufs:-5,truePeakCeilingDbtp:-1}]){
    const report=ready(target);assert.equal(isExportLoudnessResponse(report,{...input,target}),true);
    assert.equal(report.suggestion.applyAllowed,false);assert.equal(report.suggestion.currentTimelineValidated,false);
    assert.equal(report.suggestion.requiredGainDb,target.integratedLufs+23);
    assert.equal(report.suggestion.conflictsWithCeiling,report.suggestion.requiredGainDb>report.suggestion.truePeakRoomDb);
    assert.equal(isExportLoudnessResponse(report,input),false);
  }
});
const mutations=[['expected hash',v=>v.expectedArtifactSha256='c'.repeat(64)],['actual hash',v=>v.artifact.sha256='c'.repeat(64)],
  ['snapshot hash',v=>v.artifact.snapshotSha256='bad'],['one hash',v=>v.checks.bytesHashed=123],['partial decode',v=>v.checks.audioFullyDecoded=false],
  ['frame duration',v=>v.measurement.sampleFrames++],['gate blocks',v=>v.measurement.gatingBlockCount--],
  ['unqualified sentinel',v=>v.measurement.integratedLufs=-70],['missing gate',v=>v.measurement.relativeGatedBlockCount=0],
  ['impossible mean',v=>v.measurement.integratedLufs=-28],['same members different mean',v=>v.measurement.integratedLufs=-20],
  ['impossible nesting',v=>v.measurement.relativeGatedBlockCount=8],['peak logarithm',v=>v.measurement.truePeakDbtp=-10],
  ['lower truepeak',v=>{v.measurement.truePeakLinear=0.05;v.measurement.truePeakDbtp=20*Math.log10(.05);}],
  ['not stereo',v=>v.measurement.channels=1],['not48k',v=>v.measurement.sampleRate=44100],
  ['private path',v=>v.artifact.path='/tmp/private'],['NaN',v=>v.measurement.integratedLufs=NaN],
  ['Infinity',v=>v.measurement.truePeakLinear=Infinity],['oversized',v=>v.extra='x'.repeat(9000)],
  ['extra execution permission',v=>v.applyAllowed=true],['arbitraryreason',v=>v.reason={code:'DECODE_FAILED',message:'/private'}],
  ['undefined optional',v=>v.artifact.deliveryName=undefined],['bad range',v=>v.artifact.exportRange={startFrame:0,endFrame:100}]];
for(const [name,mutate]of mutations)test(`response rejects ${name}`,()=>{const v=ready();mutate(v);assert.equal(isExportLoudnessResponse(v,input),false);});
test('advice cannot be fabricated, clamped, or turned into application authority',()=>{
  const target={integratedLufs:-5,truePeakCeilingDbtp:-1};
  for(const mutate of [v=>v.suggestion.applyAllowed=true,v=>v.suggestion.currentTimelineValidated=true,
    v=>v.suggestion.requiredGainDb=v.suggestion.truePeakRoomDb,v=>v.suggestion.conflictsWithCeiling=false,
    v=>v.suggestion.marginDb=0,v=>v.suggestion.gainMultiplier=1,v=>v.suggestion=null]){
    const v=ready(target);mutate(v);assert.equal(isExportLoudnessResponse(v,{...input,target}),false);
  }
});
test('digital silence, too-short and below-gate are distinct and never produce gain advice',()=>{
  const base=measurement();
  const variants=[
    {...base,state:'digital_silence',samplePeakLinear:0,samplePeakDbfs:null,truePeakLinear:0,truePeakDbtp:null},
    {...base,state:'too_short',sampleFrames:19199,decodedDurationSeconds:19199/48000,gatingBlockCount:0},
    {...base,state:'below_gate'},
  ].map(v=>({...v,integratedLufs:null,relativeGateLufs:null,absoluteGatedBlockCount:0,relativeGatedBlockCount:0}));
  for(const v of variants){assert.equal(exportLoudnessMeasurementSchema.safeParse(v).success,true,v.state);
    assert.equal(exportLoudnessSuggestion(v,{integratedLufs:-23,truePeakCeilingDbtp:-1}),null);}
  for(const patch of [{truePeakLinear:.1,truePeakDbtp:-20},{absoluteGatedBlockCount:1,relativeGateLufs:-80}])
    assert.equal(exportLoudnessMeasurementSchema.safeParse({...variants[0],...patch}).success,false);
  assert.equal(exportLoudnessMeasurementSchema.safeParse({...base,samplePeakLinear:1e40,samplePeakDbfs:800,truePeakLinear:1e40,truePeakDbtp:800}).success,false);
});
for(const [status,codes]of [['unsupported',['NO_AUDIO','UNSUPPORTED_FORMAT','INPUT_TOO_LARGE','DURATION_LIMIT']],
  ['incomplete',['BUSY','TIMEOUT','RESOURCE_LIMIT','DECODER_UNAVAILABLE','INVALID_PCM','DECODE_FAILED','CANCELLED','SHUTDOWN']],
  ['stale',['ARTIFACT_CHANGED']]])for(const code of codes)test(`unmeasured ${status}/${code} has no numeric result`,()=>{
  const v={...ready(),status,artifact:null,measurement:null,suggestion:null,reason:exportLoudnessReason(code),checks:{bytesHashed:123,audioFullyDecoded:false}};
  assert.equal(isExportLoudnessResponse(v,input),true);
  assert.equal(isExportLoudnessResponse({...v,measurement:measurement()},input),false);
  assert.equal(isExportLoudnessResponse({...v,reason:{...v.reason,message:'stderr secret'}},input),false);
});
test('direct response rejects accessors, cycles, inherited objects without invoking user code',()=>{
  let calls=0;const a=ready();Object.defineProperty(a,'status',{enumerable:true,get(){calls++;return'ready';}});
  assert.equal(isExportLoudnessResponse(a,input),false);assert.equal(calls,0);
  const b=ready();b.toJSON=()=>{calls++;return ready();};assert.equal(isExportLoudnessResponse(b,input),false);assert.equal(calls,0);
  const c=ready();c.loop=c;assert.equal(isExportLoudnessResponse(c,input),false);
  assert.equal(isExportLoudnessResponse(Object.create(ready()),input),false);
});
