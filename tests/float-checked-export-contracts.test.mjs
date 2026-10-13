import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parse,schemas,TIMELINE_OUTPUT_PRESETS,TIMELINE_EXPORT_DEFAULT_SETTINGS,resolveTimelineExportDelivery,isTimelineExportDelivery,isTimelineExportSnapshot,isTimelineRenderRecord,isTimelineMutationResponse,isTimelineExportCapabilitiesResponse} from '@mioon/contracts';
import {TIMELINE_EXPORT_FLOAT_PROFILE_ID,TIMELINE_EXPORT_FLOAT_POLICY_ID,TIMELINE_EXPORT_AUDIO_INCOMPLETE_CODES,isTimelineExportAudioMeasurement,isTimelineExportAudioCheck,isTimelineExportAudioOutcome,isTimelineExportFloatReadResponse} from '@mioon/contracts/timeline-export-float';

const clone=value=>JSON.parse(JSON.stringify(value));
const stamp='2026-10-13T07:00:00.000Z';
const settings=()=>({...clone(TIMELINE_EXPORT_DEFAULT_SETTINGS),profileId:TIMELINE_EXPORT_FLOAT_PROFILE_ID});
const input=()=>({projectId:randomUUID(),expectedRevision:1,requestId:randomUUID(),purpose:'export',exportSettings:settings()});
function record(i){
  const trackId=randomUUID(),assetId=randomUUID();
  const timeline={id:randomUUID(),projectId:i.projectId,revision:i.expectedRevision,fps:30,width:720,height:1280,
    tracks:[{id:trackId,name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false}],
    clips:[{id:randomUUID(),trackId,assetId,name:'Image',startFrame:0,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1}],
    durationFrames:30,createdAt:stamp,updatedAt:stamp};
  return {id:randomUUID(),projectId:i.projectId,requestId:i.requestId,mode:'timeline',purpose:i.purpose,timelineRevision:i.expectedRevision,
    snapshot:{timeline,assets:[{id:assetId,sha256:'a'.repeat(64),mimeType:'image/png',duration:0,width:720,height:1280,hasAudio:false}],
      ...(i.exportSettings?{delivery:resolveTimelineExportDelivery(timeline,i.exportSettings)}:{}),...(i.exportRange?{exportRange:i.exportRange}:{})},
    status:'queued',assetId:null,url:null,error:null,createdAt:stamp,updatedAt:stamp};
}
function measurement(peakLinear=0.5,outputFrames=30){
  const sampleFrames=outputFrames*1600,count=peakLinear>1?7:0;
  return {sampleRate:48000,channels:2,sampleFormat:'f32le',sampleFrames,sampleCount:sampleFrames*2,peakLinear,overRangeSampleCount:count,
    channelPeaks:[{channel:0,peakLinear,overRangeSampleCount:count},{channel:1,peakLinear:0,overRangeSampleCount:0}]};
}
function report(row,peakLinear=0.5){
  const outputFrames=row.snapshot.exportRange?row.snapshot.exportRange.endFrame-row.snapshot.exportRange.startFrame:30;
  return {schemaVersion:1,profileId:TIMELINE_EXPORT_FLOAT_PROFILE_ID,policyId:TIMELINE_EXPORT_FLOAT_POLICY_ID,stage:'preencode_float_mix',
    projectId:row.projectId,exportId:row.id,attemptId:row.renderAttemptId,snapshotSha256:'b'.repeat(64),outputFrames,checkedAt:stamp,
    status:'complete',code:peakLinear>1?'EXPORT_AUDIO_OVER_RANGE':'EXPORT_AUDIO_WITHIN_LIMIT',measurement:measurement(peakLinear,outputFrames),output:null};
}
function success(i=input()){
  const row={...record(i),status:'succeeded',renderAttemptId:randomUUID(),assetId:randomUUID()};
  row.url=`/media/${row.assetId}`;row.audioCheck={...report(row),output:{assetId:row.assetId,sha256:'c'.repeat(64)}};
  return {i,row};
}

test('v2 is strict, opt-in, export-only and grants no caller attempt/report authority',()=>{
  const i=input();assert.deepEqual(parse('timeline.render',i),i);
  for(const operation of ['timeline.render','timeline.export.preflight','timeline.export.capabilities']){
    const value=operation==='timeline.render'?i:{projectId:i.projectId,expectedRevision:i.expectedRevision,exportSettings:i.exportSettings};
    assert.ok(schemas[operation].safeParse(value).success);
    for(const extra of [{renderAttemptId:randomUUID()},{audioCheck:{}},{audioReport:{}},{measurement:{}},{approval:true}])assert.equal(schemas[operation].safeParse({...value,...extra}).success,false);
  }
  assert.throws(()=>parse('timeline.render',{...i,purpose:'preview'}));
  for(const patch of [{profileId:'mp4_h264_float_checked_v3'},{audioCodec:'pcm_f32le'},{limiter:true},{preencodeAudioPolicy:{}},{resolution:undefined},{rateControl:{mode:'crf',quality:'standard',crf:23}}])
    assert.throws(()=>parse('timeline.render',{...i,exportSettings:{...i.exportSettings,...patch}}));
  assert.equal(TIMELINE_EXPORT_DEFAULT_SETTINGS.profileId,'mp4_h264_v1');
});

test('v2 resolver retains fixed video choices and rejects crossed or altered profiles',()=>{
  for(const timeline of TIMELINE_OUTPUT_PRESETS)for(const resolution of ['native','short_360','short_1080'])for(const rateControl of [{mode:'crf',quality:'compact'},{mode:'crf',quality:'standard'},{mode:'crf',quality:'high'},...([2000,4000,8000].map(targetKbps=>({mode:'bitrate',targetKbps})))]){
    const v2={...settings(),resolution,rateControl},v1={...v2,profileId:'mp4_h264_v1'},old=resolveTimelineExportDelivery(timeline,v1),fresh=resolveTimelineExportDelivery(timeline,v2),before=JSON.stringify([timeline,v2]);
    assert.ok(isTimelineExportDelivery(fresh,timeline,v2));
    const {intermediateAudio,preencodeAudioPolicy,...effective}=fresh.effective;
    assert.deepEqual({...effective,profileId:'mp4_h264_v1'},old.effective);
    assert.deepEqual(intermediateAudio,{container:'mov',codec:'pcm_f32le',sampleFormat:'flt',sampleRate:48000,channels:2});
    assert.deepEqual(preencodeAudioPolicy,{policyId:TIMELINE_EXPORT_FLOAT_POLICY_ID,maxPeakLinear:1,overRange:'reject'});
    assert.equal(JSON.stringify([timeline,v2]),before);
    for(const mutate of [r=>{r.effective.profileId='mp4_h264_v1';},r=>{r.exportSettings.profileId='mp4_h264_v1';},r=>{r.effective.intermediateAudio.codec='pcm_s16le';},r=>{r.effective.preencodeAudioPolicy.overRange='warn';},r=>{r.effective.preencodeAudioPolicy.maxPeakLinear=2;},r=>{r.effective.intermediateAudio.path='/tmp/source.mov';}]){const bad=clone(fresh);mutate(bad);assert.equal(isTimelineExportDelivery(bad,timeline,v2),false);}
  }
});

test('omitted/v1 record bytes, defaults and frozen effective object remain unchanged',()=>{
  const expected='{"exportSettings":{"profileId":"mp4_h264_v1","resolution":"native","rateControl":{"mode":"crf","quality":"standard"}},"effective":{"profileId":"mp4_h264_v1","container":"mp4","width":720,"height":1280,"fps":30,"videoCodec":"libx264","pixelFormat":"yuv420p","preset":"veryfast","rateControl":{"mode":"crf","crf":23},"bFrames":0,"gopFrames":60,"videoTrackTimescale":30000,"scaling":"lanczos","audioCodec":"aac","audioKbps":128,"audioSampleRate":48000,"audioChannels":2,"movflags":"faststart"}}';
  assert.equal(JSON.stringify(resolveTimelineExportDelivery({fps:30,width:720,height:1280},clone(TIMELINE_EXPORT_DEFAULT_SETTINGS))),expected);
  for(const oldSettings of [undefined,clone(TIMELINE_EXPORT_DEFAULT_SETTINGS)]){
    const i=input();if(oldSettings===undefined)delete i.exportSettings;else i.exportSettings=oldSettings;
    const row=record(i),before=JSON.stringify([i,row]);
    assert.ok(isTimelineRenderRecord(row,i));assert.ok(isTimelineMutationResponse('timeline.render',i,row));
    assert.equal(JSON.stringify([parse('timeline.render',i),row]),before);
    for(const patch of [{renderAttemptId:randomUUID()},{audioCheck:null},{audioCheck:undefined}])assert.equal(isTimelineRenderRecord({...row,...patch},i),false);
  }
});

test('queued receipt is unchanged and running requires only a fresh attempt token',()=>{
  const i=input(),queued=record(i),before=JSON.stringify(queued);
  assert.ok(isTimelineRenderRecord(queued,i));
  assert.equal(isTimelineRenderRecord({...queued,renderAttemptId:randomUUID()},i),false);
  assert.equal(isTimelineRenderRecord({...queued,audioCheck:null},i),false);
  assert.equal(isTimelineRenderRecord({...queued,status:'running'},i),false);
  const running={...queued,status:'running',renderAttemptId:randomUUID()};assert.ok(isTimelineRenderRecord(running,i));
  assert.equal(isTimelineRenderRecord({...running,audioCheck:report(running)},i),false);
  assert.equal(JSON.stringify(queued),before);
});

test('complete measurement has exact counts and strict >1 threshold',()=>{
  for(const value of [0,0.5,1,1.0000001192092896,1.4])assert.ok(isTimelineExportAudioMeasurement(measurement(value),30));
  assert.ok(isTimelineExportAudioMeasurement(measurement(0.5,18000),18000));
  for(const mutate of [m=>{m.peakLinear=NaN;},m=>{m.channelPeaks[0].peakLinear=Infinity;},m=>{m.sampleFrames--;},m=>{m.sampleCount++;},m=>{m.overRangeSampleCount=1;},m=>{m.channelPeaks[0].overRangeSampleCount=1;},m=>{m.channelPeaks[0].channel=1;},m=>{m.sampleFormat='s16le';},m=>{m.path='/private';}]){const bad=measurement();mutate(bad);assert.equal(isTimelineExportAudioMeasurement(bad,30),false);}
  assert.equal(isTimelineExportAudioMeasurement(measurement(0.5,18001)),false);
  assert.equal(isTimelineExportAudioMeasurement(measurement(),31),false);
  assert.equal(isTimelineExportAudioMeasurement(measurement(),0),false);
});

test('v2 success requires a complete same-attempt within-limit report and owned output binding',()=>{
  const {i,row}=success();assert.ok(isTimelineRenderRecord(row,i));
  assert.ok(isTimelineExportAudioOutcome(row,{snapshotSha256:'b'.repeat(64),assetSha256:'c'.repeat(64)}));
  assert.equal(isTimelineExportAudioOutcome(row,{snapshotSha256:'d'.repeat(64)}),false);
  assert.equal(isTimelineExportAudioOutcome(row,{assetSha256:'d'.repeat(64)}),false);
  for(const mutate of [r=>{delete r.audioCheck;},r=>{delete r.renderAttemptId;},r=>{r.renderAttemptId=randomUUID();},r=>{r.audioCheck.projectId=randomUUID();},r=>{r.audioCheck.exportId=randomUUID();},r=>{r.audioCheck.output.assetId=randomUUID();},r=>{r.audioCheck.output=null;},r=>{r.audioCheck.outputFrames=29;},r=>{r.audioCheck.snapshotSha256='wrong';},r=>{r.audioCheck.measurement.peakLinear=2;},r=>{r.snapshot.delivery.exportSettings.profileId='mp4_h264_v1';}]){const bad=clone(row);mutate(bad);assert.equal(isTimelineRenderRecord(bad,i),false);}
});

test('premeasurement failure retains its attempt without invented measurement; over-range failure is terminal',()=>{
  const i=input(),failed={...record(i),status:'failed',error:{code:'EXPORT_FAILED',message:'Failed before measurement'}};
  assert.equal(isTimelineRenderRecord(failed,i),false,'a terminal row cannot lose its claimed attempt identity');
  failed.renderAttemptId=randomUUID();assert.ok(isTimelineRenderRecord(failed,i));
  const over={...failed,error:{code:'EXPORT_AUDIO_OVER_RANGE',message:'Lower saved gains and request a new export.',retryable:false},audioCheck:report(failed,1.4)};
  assert.ok(isTimelineRenderRecord(over,i));
  for(const mutate of [r=>{delete r.audioCheck;},r=>{delete r.renderAttemptId;},r=>{r.error.retryable=true;},r=>{r.error.code='EXPORT_FAILED';},r=>{r.audioCheck.code='EXPORT_AUDIO_WITHIN_LIMIT';},r=>{r.audioCheck.output={assetId:randomUUID(),sha256:'a'.repeat(64)};}]){const bad=clone(over);mutate(bad);assert.equal(isTimelineRenderRecord(bad,i),false);}
  assert.ok(isTimelineRenderRecord({...failed,audioCheck:report(failed)},i),'AAC can fail after a complete within-limit check without publishing output');
});

test('incomplete reports never contain a partial measurement or authorize a published asset',()=>{
  const i=input(),row={...record(i),status:'failed',renderAttemptId:randomUUID(),error:{code:'EXPORT_AUDIO_INVALID_PCM',message:'Incomplete audio check'}};
  for(const code of TIMELINE_EXPORT_AUDIO_INCOMPLETE_CODES){
    const audioCheck={...report(row),status:'incomplete',code,measurement:null};
    assert.ok(isTimelineExportAudioCheck(audioCheck));assert.ok(isTimelineRenderRecord({...row,audioCheck},i));
    assert.equal(isTimelineExportAudioCheck({...audioCheck,measurement:measurement()}),false);
    assert.equal(isTimelineExportAudioCheck({...audioCheck,output:{assetId:randomUUID(),sha256:'a'.repeat(64)}}),false);
    const {row:completed}=success(i);assert.equal(isTimelineRenderRecord({...completed,audioCheck:{...audioCheck,attemptId:completed.renderAttemptId,exportId:completed.id}},i),false);
  }
});

test('report guard rejects hostile JSON and arbitrary fields without invoking getters',()=>{
  const {row}=success(),good=row.audioCheck;let invoked=0;
  const getter={...good};Object.defineProperty(getter,'measurement',{enumerable:true,get(){invoked++;return measurement();}});
  assert.equal(isTimelineExportAudioCheck(getter),false);assert.equal(invoked,0);
  for(const extra of [{path:'/tmp/file'},{rawSamples:[]},{message:'x'.repeat(9000)},{audioFullyDecoded:true},{toJSON(){throw Error('should not be invoked');}}])assert.equal(isTimelineExportAudioCheck({...good,...extra}),false);
  const cycle={...good};cycle.extra=cycle;assert.equal(isTimelineExportAudioCheck(cycle),false);
  const sparse=clone(good);delete sparse.measurement.channelPeaks[0];assert.equal(isTimelineExportAudioCheck(sparse),false);
});

test('selected range and capability response bind the frozen profile without audio claims',()=>{
  const i={...input(),exportRange:{startFrame:4,endFrame:10}},row=success(i).row;
  assert.equal(row.audioCheck.measurement.sampleFrames,9600);assert.ok(isTimelineRenderRecord(row,i));
  const bad=clone(row);bad.audioCheck.outputFrames=30;bad.audioCheck.measurement=measurement();assert.equal(isTimelineRenderRecord(bad,i),false);
  const capability={projectId:i.projectId,timelineId:row.snapshot.timeline.id,timelineRevision:1,expectedRevision:1,exportSettings:i.exportSettings,delivery:row.snapshot.delivery,checkedAt:stamp,status:'available',issues:[]};
  assert.ok(isTimelineExportCapabilitiesResponse(capability,i));
  assert.equal(isTimelineExportCapabilitiesResponse({...capability,audioCheck:row.audioCheck},i),false);
  assert.equal(isTimelineExportSnapshot(row.snapshot,{purpose:'preview'}),false);
  assert.equal(isTimelineRenderRecord(row,{...i,exportSettings:{...i.exportSettings,profileId:'mp4_h264_v1'}}),false);
});

test('export.get v2 read guard validates exact identity and frozen input without changing legacy reads',()=>{
  const untouched={id:'legacy-id',orderedVersionIds:[],status:'completed'};let calls=0;
  assert.ok(isTimelineExportFloatReadResponse(untouched,'other',()=>{calls++;return false;}));assert.equal(calls,0);
  for(const extra of [{renderAttemptId:randomUUID()},{audioCheck:null},{audioCheck:undefined}])
    assert.equal(isTimelineExportFloatReadResponse({...untouched,...extra},'legacy-id',isTimelineRenderRecord),false);
  const i={...input(),deliveryName:'A frozen title',exportRange:{startFrame:3,endFrame:17}};
  const queued=record(i);queued.snapshot.deliveryName=i.deliveryName;
  const before=JSON.stringify(queued);
  assert.ok(isTimelineExportFloatReadResponse(queued,queued.id,(value,frozen)=>{
    calls++;assert.deepEqual(frozen,{...i,exportId:queued.id});return isTimelineRenderRecord(value,frozen);
  }));
  assert.equal(JSON.stringify(queued),before);assert.equal(calls,1);
  const {row}=success();assert.ok(isTimelineExportFloatReadResponse(row,row.id,isTimelineRenderRecord));
  assert.equal(isTimelineExportFloatReadResponse(row,randomUUID(),isTimelineRenderRecord),false);
  assert.equal(isTimelineExportFloatReadResponse(row,row.id,()=>{throw Error('Invalid reader');}),false);
  for(const mutate of [r=>{delete r.audioCheck;},r=>{r.snapshot.delivery.exportSettings.profileId='mp4_h264_v1';},r=>{r.snapshot.delivery.effective.profileId='mp4_h264_v1';},r=>{delete r.snapshot.delivery;},r=>{r.snapshot.assets=[];},r=>{r.purpose='preview';}]){
    const bad=clone(row);mutate(bad);assert.equal(isTimelineExportFloatReadResponse(bad,row.id,isTimelineRenderRecord),false);
  }
});
