import test from 'node:test';
import assert from 'node:assert/strict';
import {schemas,parse,operationEffect,effectAnnotations,descriptions} from '@mioon/contracts';
import {discoverSchema} from '@mioon/client';
import {EXPORT_SAMPLE_PEAK_ALGORITHM,EXPORT_SAMPLE_PEAK_LIMITS,exportSamplePeakSchemas,exportSamplePeakInputSchema,
  exportSamplePeakResponseSchema,isExportSamplePeakResponse,exportSamplePeakReason} from '@mioon/contracts/export-sample-peak';
import {isExportSamplePeakFrameCountCompatible} from '@mioon/contracts/export-sample-peak';
import {samplePeakOperation as operation,samplePeakInput as input,readySamplePeak,incompleteSamplePeak} from './helpers/export-sample-peak-fixture.mjs';
import {READ_TOOL_DEFINITIONS} from '../packages/business/src/agent/read-tool-policy.ts';

const changed = change => {const report=readySamplePeak();change(report);return report;};
test('已导出文件解码样本峰值 has exact shared input, bounds, truthful effects and no Agent read authority',()=>{
  assert.equal(schemas[operation],exportSamplePeakSchemas[operation]);
  assert.equal(schemas[operation],exportSamplePeakInputSchema);
  assert.deepEqual(parse(operation,input),input);
  assert.equal(EXPORT_SAMPLE_PEAK_ALGORITHM,'export-sample-peak-f32le-48k-stereo-v1');
  assert.deepEqual(EXPORT_SAMPLE_PEAK_LIMITS,{inputBytes:536870912,totalHashedBytes:1073741824,timeoutMs:120000,clientTimeoutMs:125000,
    durationSeconds:600,pcmBytes:230400000,sampleFrames:28800000,responseBytes:8192,durationToleranceSeconds:0.1});
  const definition=discoverSchema({operation});
  assert.deepEqual(definition.inputSchema.required,['projectId','exportId']);
  assert.deepEqual(Object.keys(definition.inputSchema.properties),['projectId','exportId']);
  assert.equal(definition.inputSchema.additionalProperties,false);assert.equal(definition.requiresRequestId,false);
  assert.match(descriptions[operation],/^已导出文件解码样本峰值/);
  assert.deepEqual(effectAnnotations(operationEffect(operation)),{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});
  assert.equal(operationEffect(operation).localProcess,true);
  for(const key of ['databaseWrite','fileWrite','externalIO','paidGeneration'])assert.equal(operationEffect(operation)[key],false);
  assert.deepEqual(READ_TOOL_DEFINITIONS.map(tool=>tool.name),['mioon_project_inspect','mioon_asset_inspect','mioon_shot_inspect','mioon_timeline_inspect']);
});
for(const candidate of [null,{},[],{projectId:input.projectId}, {...input,projectId:'wrong'},...['requestId','path','url','dataBase64','assetId','sha256','timeoutMs','exportSettings','extraArgs','expectedWorkspaceOrigin'].map(key=>({...input,[key]:'forbidden'}))])
  test(`strict input rejects ${JSON.stringify(candidate)}`,()=>assert.equal(exportSamplePeakInputSchema.safeParse(candidate).success,false));

for(const [left,right] of [[0,0],[-0,0],[0,0.25],[1,1],[1.25,0.5],[3.4028234663852886e38,1],[2**-149,0]])
  test(`complete sample peak accepts exact finite stereo maximum ${left}/${right}`,()=>{
    const value=readySamplePeak({left,right});assert.equal(isExportSamplePeakResponse(value,input),true);assert.equal(exportSamplePeakResponseSchema.safeParse(value).success,true);
    assert.equal(Buffer.byteLength(JSON.stringify(value))<=8192,true);
  });
test('frozen named and ranged fields preserve exact presence and measured interval',()=>{
  for(const fields of [{},{deliveryName:'交付  A'},{exportRange:{startFrame:30,endFrame:60}},{deliveryName:'交付  A',exportRange:{startFrame:30,endFrame:60}}]){
    const report=readySamplePeak({fields});assert.equal(isExportSamplePeakResponse(report,input),true);
    assert.deepEqual(exportSamplePeakResponseSchema.parse(report).artifact,report.artifact);
  }
  for(const fields of [{deliveryName:undefined},{exportRange:undefined},{deliveryName:''},{exportRange:{startFrame:0,endFrame:60}}])
    assert.equal(isExportSamplePeakResponse(readySamplePeak({fields}),input),false);
});
const malformed=[
  ['wrong project',v=>v.projectId=input.exportId],['wrong export',v=>v.exportId=input.projectId],['wrong algorithm',v=>v.algorithm='other'],
  ['wrong timestamp',v=>v.checkedAt='now'],['unexpected path',v=>v.path='/private/export.mp4'],['requestId',v=>v.requestId='forbidden'],
  ['missing verified artifact',v=>v.artifact=null],['bad digest',v=>v.artifact.sha256='A'.repeat(64)],['oversize input',v=>v.artifact.sizeBytes=536870913],
  ['missing measurement',v=>v.measurement=null],['half hash',v=>v.checks.bytesHashed=1024],['fractional hash',v=>v.checks.bytesHashed=2048.5],
  ['over hash cap',v=>v.checks.bytesHashed=1073741825],['incomplete decode',v=>v.checks.audioFullyDecoded=false],['empty PCM',v=>v.measurement.sampleFrames=0],
  ['frame cap',v=>v.measurement.sampleFrames=28800001],['fractional frame',v=>v.measurement.sampleFrames=1.5],['duration mismatch',v=>v.measurement.decodedDurationSeconds=2],
  ['rate mismatch',v=>v.measurement.sampleRate=44100],['channels mismatch',v=>v.measurement.channels=1],['summed peak',v=>v.measurement.peakLinear=0.75],
  ['average peak',v=>v.measurement.peakLinear=0.375],['wrong db',v=>v.measurement.peakDbfs=-6],['wrong silence',v=>v.measurement.silent=true],
  ['false null db',v=>v.measurement.peakDbfs=null],['false fullscale',v=>v.measurement.overFullScale=true],['NaN',v=>v.measurement.peakLinear=NaN],
  ['infinite',v=>v.measurement.peakDbfs=Infinity],['negative',v=>v.measurement.channelPeaks[0].peakLinear=-0.5],['wrong channel order',v=>v.measurement.channelPeaks.reverse()],
  ['extra channel',v=>v.measurement.channelPeaks.push(v.measurement.channelPeaks[0])],['wrong channel label',v=>v.measurement.channelPeaks[0].label='mono'],
  ['channel db mismatch',v=>v.measurement.channelPeaks[1].peakDbfs=-3],['channel silent mismatch',v=>v.measurement.channelPeaks[0].silent=true],
  ['false over advisory',v=>v.reason=exportSamplePeakReason('OVER_FULL_SCALE')],['arbitrary message',v=>v.reason={code:'DECODE_FAILED',message:'/private/path'}],
  ['private probe',v=>v.checks.probe={path:'/private/path'}],['overlarge response',v=>v.extra='x'.repeat(8192)],
];
for(const [name,change] of malformed)test(`response rejects ${name}`,()=>assert.equal(isExportSamplePeakResponse(changed(change),input),false));
test('silence, exact full scale and over-full-scale advice are mutually consistent',()=>{
  for(const value of [readySamplePeak({left:0,right:0}),readySamplePeak({left:1,right:1}),readySamplePeak({left:1.1,right:0})]){
    const bad=structuredClone(value);bad.reason=bad.reason===null?exportSamplePeakReason('OVER_FULL_SCALE'):null;
    assert.equal(isExportSamplePeakResponse(bad,input),false);
  }
  const silent=readySamplePeak({left:0,right:0});silent.measurement.peakDbfs=0;assert.equal(isExportSamplePeakResponse(silent,input),false);
});
for(const [status,codes] of [['unsupported',['UNSUPPORTED_FORMAT','INPUT_TOO_LARGE','DURATION_LIMIT']],['incomplete',['BUSY','TIMEOUT','RESOURCE_LIMIT','DECODER_UNAVAILABLE','INVALID_PCM','DECODE_FAILED','CANCELLED','SHUTDOWN']],['stale',['ARTIFACT_CHANGED']]])
  for(const code of codes)test(`safe unmeasured ${status}/${code} is closed and has no artifact`,()=>{
    const value={...incompleteSamplePeak(code),status};assert.equal(isExportSamplePeakResponse(value,input),true);
    for(const change of [v=>v.measurement=readySamplePeak().measurement,v=>v.artifact=readySamplePeak().artifact,v=>v.checks.audioFullyDecoded=true,
      v=>v.reason.message+=' /private/path',v=>v.reason=null,v=>v.reason.code='UNTRUSTED']){const bad=structuredClone(value);change(bad);assert.equal(isExportSamplePeakResponse(bad,input),false);}
  });
test('direct guard rejects getters, toJSON, inherited data, cycles and mismatched input without throwing',()=>{
  let called=false;const getter=readySamplePeak();Object.defineProperty(getter,'status',{enumerable:true,get(){called=true;return 'ready';}});
  assert.equal(isExportSamplePeakResponse(getter,input),false);assert.equal(called,false);
  const toJSON=readySamplePeak();toJSON.toJSON=()=>{called=true;return readySamplePeak();};assert.equal(isExportSamplePeakResponse(toJSON,input),false);assert.equal(called,false);
  const cycle=readySamplePeak();cycle.loop=cycle;
  const extraArrayField=readySamplePeak();extraArrayField.measurement.channelPeaks.path='/private';
  assert.equal(isExportSamplePeakResponse(extraArrayField,input),false);
  const arraySubclass=readySamplePeak();Object.setPrototypeOf(arraySubclass.measurement.channelPeaks,Object.create(Array.prototype));
  assert.equal(isExportSamplePeakResponse(arraySubclass,input),false);
  for(const candidate of [cycle,Object.create(readySamplePeak()),undefined,0,'report',[],{...readySamplePeak(),[Symbol('hidden')]:true}])assert.equal(isExportSamplePeakResponse(candidate,input),false);
  assert.equal(isExportSamplePeakResponse(readySamplePeak(),{...input,requestId:'not allowed'}),false);
});
test('safe reason helper rejects unknown and prototype keys from JavaScript callers',()=>{
  for(const code of ['constructor','__proto__','TO_STRING',undefined,null])assert.throws(()=>exportSamplePeakReason(code),/reason code/);
});
test('frozen duration tolerance includes exactly 4800 PCM frames without floating-point widening',()=>{
  for(const [sampleFrames,outputFrames] of [[28795200,18000],[28800000,17997],[4800,6],[14400,6],[1,1]])
    assert.equal(isExportSamplePeakFrameCountCompatible(sampleFrames,outputFrames),true);
  for(const [sampleFrames,outputFrames] of [[28795199,18000],[28800000,17994],[4799,6],[14401,6],[0,3],[28800001,18000],[4800,NaN],[4800,3.000001]])
    assert.equal(isExportSamplePeakFrameCountCompatible(sampleFrames,outputFrames),false);
  for(const [sampleFrames,endFrame,valid] of [[28795200,18000,true],[28795199,18000,false],[28800000,17997,true],[28800000,17996,false]]){
    const report=readySamplePeak({fields:{exportRange:{startFrame:0,endFrame}}});report.measurement.sampleFrames=sampleFrames;
    report.measurement.decodedDurationSeconds=sampleFrames/48000;assert.equal(isExportSamplePeakResponse(report,input),valid);
  }
});
test('every supported 30fps interval recovers the exact integer PCM target from decoder seconds',()=>{
  for(let outputFrames=1;outputFrames<=18000;outputFrames++){
    const expectedSamples=outputFrames*1600;
    assert.equal(Math.round((outputFrames/30)*48000),expectedSamples);
    assert.equal(isExportSamplePeakFrameCountCompatible(expectedSamples,outputFrames),true);
    if(expectedSamples-4800>0){
      assert.equal(isExportSamplePeakFrameCountCompatible(expectedSamples-4800,outputFrames),true);
      assert.equal(isExportSamplePeakFrameCountCompatible(expectedSamples-4801,outputFrames),false);
    }
    if(expectedSamples+4800<=28800000){
      assert.equal(isExportSamplePeakFrameCountCompatible(expectedSamples+4800,outputFrames),true);
      assert.equal(isExportSamplePeakFrameCountCompatible(expectedSamples+4801,outputFrames),false);
    }
  }
});
test('direct guard rejects huge sparse and small sparse arrays before JSON serialization',t=>{
  const original=JSON.stringify;let serialized=false;
  t.mock.method(JSON,'stringify',(...args)=>{serialized=true;return original(...args);});
  for(const length of [2,1000000000]){
    const report=readySamplePeak();report.measurement.channelPeaks=[];report.measurement.channelPeaks.length=length;
    serialized=false;assert.equal(isExportSamplePeakResponse(report,input),false);assert.equal(serialized,false);
  }
});
