type StrictIntersection<T> = (T extends unknown ? (value: T)=>void : never) extends ((value: infer I)=>void) ? I : never;
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parse,schemas,TIMELINE_OUTPUT_PRESETS,TIMELINE_EXPORT_DEFAULT_SETTINGS,resolveTimelineExportDelivery,isTimelineExportDelivery,isTimelineExportSnapshot,isTimelineRenderRecord,isTimelineMutationResponse,isTimelineExportCapabilitiesResponse} from '@mioon/contracts';
import {TIMELINE_EXPORT_FLOAT_PROFILE_ID,TIMELINE_EXPORT_FLOAT_POLICY_ID,TIMELINE_EXPORT_AUDIO_INCOMPLETE_CODES,isTimelineExportAudioMeasurement,isTimelineExportAudioCheck,isTimelineExportAudioOutcome,isTimelineExportFloatReadResponse} from '@mioon/contracts/timeline-export-float';

const clone=<T>(value: T): T => JSON.parse(JSON.stringify(value));
const stamp='2026-10-13T07:00:00.000Z';
const settings=()=>({...clone(TIMELINE_EXPORT_DEFAULT_SETTINGS),profileId:TIMELINE_EXPORT_FLOAT_PROFILE_ID});
const input=()=>({projectId:randomUUID(),expectedRevision:1,requestId:randomUUID(),purpose:'export',exportSettings:settings()});
function record(i: { projectId: unknown; expectedRevision: unknown; requestId: unknown; purpose: unknown; exportSettings: unknown; deliveryName?: string; exportRange?: {startFrame:number;endFrame:number}; }){
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
function measurement(peakLinear: number|undefined=0.5,outputFrames: number|undefined=30){
  const sampleFrames=outputFrames*1600,count=peakLinear>1?7:0;
  return {sampleRate:48000,channels:2,sampleFormat:'f32le',sampleFrames,sampleCount:sampleFrames*2,peakLinear,overRangeSampleCount:count,
    channelPeaks:[{channel:0,peakLinear,overRangeSampleCount:count},{channel:1,peakLinear:0,overRangeSampleCount:0}]};
}
function report(row: { status?: string; renderAttemptId?: unknown; assetId?: `${string}-${string}-${string}-${string}-${string}`|null; id: unknown; projectId: unknown; requestId?: unknown; mode?: string; purpose?: unknown; timelineRevision?: unknown; snapshot: {exportRange?:{startFrame:number;endFrame:number}}; url?: null; error?: { code: string; message: string; }|{ code: string; message: string; }|null; createdAt?: string; updatedAt?: string; },peakLinear: number|undefined=0.5){
  const outputFrames=row.snapshot.exportRange?row.snapshot.exportRange.endFrame-row.snapshot.exportRange.startFrame:30;
  return {schemaVersion:1,profileId:TIMELINE_EXPORT_FLOAT_PROFILE_ID,policyId:TIMELINE_EXPORT_FLOAT_POLICY_ID,stage:'preencode_float_mix',
    projectId:row.projectId,exportId:row.id,attemptId:row.renderAttemptId,snapshotSha256:'b'.repeat(64),outputFrames,checkedAt:stamp,
    status:'complete',code:peakLinear>1?'EXPORT_AUDIO_OVER_RANGE':'EXPORT_AUDIO_WITHIN_LIMIT',measurement:measurement(peakLinear,outputFrames),output:null};
}
function success(i: {projectId?: unknown; expectedRevision?: unknown; requestId?: unknown; purpose?: unknown; exportSettings?: unknown; exportRange?: {startFrame:number;endFrame:number}; deliveryName?: string|undefined;}=input()){
  const row={...record(((i) as unknown as Parameters<typeof record>[0])),status:'succeeded',renderAttemptId:randomUUID(),assetId:randomUUID()};
  row.url=(`/media/${row.assetId}` as unknown as (typeof row)["url"]);(row as typeof row & {audioCheck:({ output: { assetId: `${string}-${string}-${string}-${string}-${string}`; sha256: string; }; schemaVersion: number; profileId: string; policyId: string; stage: string; projectId: unknown; exportId: unknown; attemptId: unknown; snapshotSha256: string; outputFrames: number; checkedAt: string; status: string; code: string; measurement: { sampleRate: number; channels: number; sampleFormat: string; sampleFrames: number; sampleCount: number; peakLinear: number; overRangeSampleCount: number; channelPeaks: { channel: number; peakLinear: number; overRangeSampleCount: number; }[]; }; })}).audioCheck={...report(row),output:{assetId:row.assetId,sha256:'c'.repeat(64)}};
  return {i,row};
}

test('v2 is strict, opt-in, export-only and grants no caller attempt/report authority',()=>{
  const i=input();assert.deepEqual(parse('timeline.render',i),i);
  for(const operation of (['timeline.render','timeline.export.preflight','timeline.export.capabilities'] as const)){
    const value=operation==='timeline.render'?i:{projectId:i.projectId,expectedRevision:i.expectedRevision,exportSettings:i.exportSettings};
    assert.ok(schemas[operation].safeParse(value).success);
    for(const extra of ([{renderAttemptId:randomUUID()},{audioCheck:{}},{audioReport:{}},{measurement:{}},{approval:true}] as const))assert.equal(schemas[operation].safeParse({...value,...extra}).success,false);
  }
  assert.throws(()=>parse('timeline.render',{...i,purpose:'preview'}));
  for(const patch of ([{profileId:'mp4_h264_float_checked_v3'},{audioCodec:'pcm_f32le'},{limiter:true},{preencodeAudioPolicy:{}},{resolution:undefined},{rateControl:{mode:'crf',quality:'standard',crf:23}}] as const))
    assert.throws(()=>parse('timeline.render',{...i,exportSettings:{...i.exportSettings,...patch}}));
  assert.equal(TIMELINE_EXPORT_DEFAULT_SETTINGS.profileId,'mp4_h264_v1');
});

test('v2 resolver retains fixed video choices and rejects crossed or altered profiles',()=>{
  for(const timeline of TIMELINE_OUTPUT_PRESETS)for(const resolution of (['native','short_360','short_1080'] as const))for(const rateControl of ([{mode:'crf',quality:'compact'},{mode:'crf',quality:'standard'},{mode:'crf',quality:'high'},...([2000,4000,8000].map(targetKbps=>({mode:'bitrate',targetKbps})))] as const)){
    const v2={...settings(),resolution,rateControl},v1={...v2,profileId:'mp4_h264_v1'},old=resolveTimelineExportDelivery(timeline,v1),fresh=resolveTimelineExportDelivery(timeline,v2),before=JSON.stringify([timeline,v2]);
    assert.ok(isTimelineExportDelivery(fresh,timeline,v2));
    const {intermediateAudio,preencodeAudioPolicy,...effective}=(fresh.effective as Extract<typeof fresh.effective,{profileId:"mp4_h264_float_checked_v2"}>);
    assert.deepEqual({...effective,profileId:'mp4_h264_v1'},old.effective);
    assert.deepEqual(intermediateAudio,{container:'mov',codec:'pcm_f32le',sampleFormat:'flt',sampleRate:48000,channels:2});
    assert.deepEqual(preencodeAudioPolicy,{policyId:TIMELINE_EXPORT_FLOAT_POLICY_ID,maxPeakLinear:1,overRange:'reject'});
    assert.equal(JSON.stringify([timeline,v2]),before);
    for(const mutate of ([(r: { effective: { profileId: string; }; })=>{r.effective.profileId='mp4_h264_v1';},(r: { exportSettings: { profileId: string; }; })=>{r.exportSettings.profileId='mp4_h264_v1';},(r: { effective: { intermediateAudio: { codec: string; }; }; })=>{r.effective.intermediateAudio.codec='pcm_s16le';},(r: { effective: { preencodeAudioPolicy: { overRange: string; }; }; })=>{r.effective.preencodeAudioPolicy.overRange='warn';},(r: { effective: { preencodeAudioPolicy: { maxPeakLinear: number; }; }; })=>{r.effective.preencodeAudioPolicy.maxPeakLinear=2;},(r: { effective: { intermediateAudio: { path: string; }; }; })=>{r.effective.intermediateAudio.path='/tmp/source.mov';}] as const)){const bad=clone(fresh);mutate(((((bad) as unknown as Parameters<typeof mutate>[0])) as unknown as StrictIntersection<Parameters<NonNullable<typeof mutate>>[0]>));assert.equal(isTimelineExportDelivery(bad,timeline,v2),false);}
  }
});

test('omitted/v1 record bytes, defaults and frozen effective object remain unchanged',()=>{
  const expected='{"exportSettings":{"profileId":"mp4_h264_v1","resolution":"native","rateControl":{"mode":"crf","quality":"standard"}},"effective":{"profileId":"mp4_h264_v1","container":"mp4","width":720,"height":1280,"fps":30,"videoCodec":"libx264","pixelFormat":"yuv420p","preset":"veryfast","rateControl":{"mode":"crf","crf":23},"bFrames":0,"gopFrames":60,"videoTrackTimescale":30000,"scaling":"lanczos","audioCodec":"aac","audioKbps":128,"audioSampleRate":48000,"audioChannels":2,"movflags":"faststart"}}';
  assert.equal(JSON.stringify(resolveTimelineExportDelivery({fps:30,width:720,height:1280},clone(TIMELINE_EXPORT_DEFAULT_SETTINGS))),expected);
  for(const oldSettings of ([undefined,clone(TIMELINE_EXPORT_DEFAULT_SETTINGS)] as const)){
    const i=input();if(oldSettings===undefined)delete (i as {exportSettings?: unknown}).exportSettings;else i.exportSettings=oldSettings;
    const row=record(i),before=JSON.stringify([i,row]);
    assert.ok(isTimelineRenderRecord(row,i));assert.ok(isTimelineMutationResponse('timeline.render',i,row));
    assert.equal(JSON.stringify([parse('timeline.render',i),row]),before);
    for(const patch of ([{renderAttemptId:randomUUID()},{audioCheck:null},{audioCheck:undefined}] as const))assert.equal(isTimelineRenderRecord({...row,...patch},i),false);
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
  for(const value of ([0,0.5,1,1.0000001192092896,1.4] as const))assert.ok(isTimelineExportAudioMeasurement(measurement(value),30));
  assert.ok(isTimelineExportAudioMeasurement(measurement(0.5,18000),18000));
  for(const mutate of ([(m: { peakLinear: number; })=>{m.peakLinear=NaN;},(m: { channelPeaks: { peakLinear: number; }[]; })=>{m.channelPeaks[0].peakLinear=Infinity;},(m: { sampleFrames: number; })=>{m.sampleFrames--;},(m: { sampleCount: number; })=>{m.sampleCount++;},(m: { overRangeSampleCount: number; })=>{m.overRangeSampleCount=1;},(m: { channelPeaks: { overRangeSampleCount: number; }[]; })=>{m.channelPeaks[0].overRangeSampleCount=1;},(m: { channelPeaks: { channel: number; }[]; })=>{m.channelPeaks[0].channel=1;},(m: { sampleFormat: string; })=>{m.sampleFormat='s16le';},(m: { path: string; })=>{m.path='/private';}] as const)){const bad=measurement();mutate(((((bad) as unknown as Parameters<typeof mutate>[0])) as unknown as StrictIntersection<Parameters<NonNullable<typeof mutate>>[0]>));assert.equal(isTimelineExportAudioMeasurement(bad,30),false);}
  assert.equal(isTimelineExportAudioMeasurement(measurement(0.5,18001)),false);
  assert.equal(isTimelineExportAudioMeasurement(measurement(),31),false);
  assert.equal(isTimelineExportAudioMeasurement(measurement(),0),false);
});

test('v2 success requires a complete same-attempt within-limit report and owned output binding',()=>{
  const {i,row}=success();assert.ok(isTimelineRenderRecord(row,i));
  assert.ok(isTimelineExportAudioOutcome(row,{snapshotSha256:'b'.repeat(64),assetSha256:'c'.repeat(64)}));
  assert.equal(isTimelineExportAudioOutcome(row,{snapshotSha256:'d'.repeat(64)}),false);
  assert.equal(isTimelineExportAudioOutcome(row,{assetSha256:'d'.repeat(64)}),false);
  for(const mutate of ([(r: { audioCheck: unknown; })=>{delete r.audioCheck;},(r: { renderAttemptId: unknown; })=>{delete r.renderAttemptId;},(r: { renderAttemptId: string; })=>{r.renderAttemptId=randomUUID();},(r: { audioCheck: { projectId: string; }; })=>{r.audioCheck.projectId=randomUUID();},(r: { audioCheck: { exportId: string; }; })=>{r.audioCheck.exportId=randomUUID();},(r: { audioCheck: { output: { assetId: string; }; }; })=>{r.audioCheck.output.assetId=randomUUID();},(r: { audioCheck: { output: null; }; })=>{r.audioCheck.output=null;},(r: { audioCheck: { outputFrames: number; }; })=>{r.audioCheck.outputFrames=29;},(r: { audioCheck: { snapshotSha256: string; }; })=>{r.audioCheck.snapshotSha256='wrong';},(r: { audioCheck: { measurement: { peakLinear: number; }; }; })=>{r.audioCheck.measurement.peakLinear=2;},(r: { snapshot: { delivery: { exportSettings: { profileId: string; }; }; }; })=>{r.snapshot.delivery.exportSettings.profileId='mp4_h264_v1';}] as const)){const bad=clone(row);mutate(((((bad) as unknown as Parameters<typeof mutate>[0])) as unknown as StrictIntersection<Parameters<NonNullable<typeof mutate>>[0]>));assert.equal(isTimelineRenderRecord(bad,i),false);}
});

test('premeasurement failure retains its attempt without invented measurement; over-range failure is terminal',()=>{
  const i=input(),failed={...record(i),status:'failed',error:{code:'EXPORT_FAILED',message:'Failed before measurement'}};
  assert.equal(isTimelineRenderRecord(failed,i),false,'a terminal row cannot lose its claimed attempt identity');
  (failed as typeof failed & {renderAttemptId:(`${string}-${string}-${string}-${string}-${string}`)}).renderAttemptId=randomUUID();assert.ok(isTimelineRenderRecord(failed,i));
  const over={...failed,error:{code:'EXPORT_AUDIO_OVER_RANGE',message:'Lower saved gains and request a new export.',retryable:false},audioCheck:report(failed,1.4)};
  assert.ok(isTimelineRenderRecord(over,i));
  for(const mutate of ([(r: { audioCheck: unknown; })=>{delete r.audioCheck;},(r: { renderAttemptId: unknown; })=>{delete r.renderAttemptId;},(r: { error: { retryable: boolean; }; })=>{r.error.retryable=true;},(r: { error: { code: string; }; })=>{r.error.code='EXPORT_FAILED';},(r: { audioCheck: { code: string; }; })=>{r.audioCheck.code='EXPORT_AUDIO_WITHIN_LIMIT';},(r: { audioCheck: { output: { assetId: `${string}-${string}-${string}-${string}-${string}`; sha256: string; }; }; })=>{r.audioCheck.output={assetId:randomUUID(),sha256:'a'.repeat(64)};}] as const)){const bad=clone(over);mutate(((((bad) as unknown as Parameters<typeof mutate>[0])) as unknown as StrictIntersection<Parameters<NonNullable<typeof mutate>>[0]>));assert.equal(isTimelineRenderRecord(bad,i),false);}
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
  const {row}=success(),good=(row as typeof row & {audioCheck:({ output: { assetId: `${string}-${string}-${string}-${string}-${string}`; sha256: string; }; schemaVersion: number; profileId: string; policyId: string; stage: string; projectId: unknown; exportId: unknown; attemptId: unknown; snapshotSha256: string; outputFrames: number; checkedAt: string; status: string; code: string; measurement: { sampleRate: number; channels: number; sampleFormat: string; sampleFrames: number; sampleCount: number; peakLinear: number; overRangeSampleCount: number; channelPeaks: { channel: number; peakLinear: number; overRangeSampleCount: number; }[]; }; })}).audioCheck;let invoked=0;
  const getter={...good};Object.defineProperty(getter,'measurement',{enumerable:true,get(){invoked++;return measurement();}});
  assert.equal(isTimelineExportAudioCheck(getter),false);assert.equal(invoked,0);
  for(const extra of ([{path:'/tmp/file'},{rawSamples:[]},{message:'x'.repeat(9000)},{audioFullyDecoded:true},{toJSON(){throw Error('should not be invoked');}}] as const))assert.equal(isTimelineExportAudioCheck({...good,...extra}),false);
  const cycle={...good};(cycle as unknown as {extra:({ output: { assetId: `${string}-${string}-${string}-${string}-${string}`; sha256: string; }; schemaVersion: number; profileId: string; policyId: string; stage: string; projectId: unknown; exportId: unknown; attemptId: unknown; snapshotSha256: string; outputFrames: number; checkedAt: string; status: string; code: string; measurement: { sampleRate: number; channels: number; sampleFormat: string; sampleFrames: number; sampleCount: number; peakLinear: number; overRangeSampleCount: number; channelPeaks: { channel: number; peakLinear: number; overRangeSampleCount: number; }[]; }; })}).extra=cycle;assert.equal(isTimelineExportAudioCheck(cycle),false);
  const sparse=clone(good);delete sparse.measurement.channelPeaks[0];assert.equal(isTimelineExportAudioCheck(sparse),false);
});

test('selected range and capability response bind the frozen profile without audio claims',()=>{
  const i={...input(),exportRange:{startFrame:4,endFrame:10}},row=success(i).row;
  assert.equal((row as typeof row & {audioCheck:({ output: { assetId: `${string}-${string}-${string}-${string}-${string}`; sha256: string; }; schemaVersion: number; profileId: string; policyId: string; stage: string; projectId: unknown; exportId: unknown; attemptId: unknown; snapshotSha256: string; outputFrames: number; checkedAt: string; status: string; code: string; measurement: { sampleRate: number; channels: number; sampleFormat: string; sampleFrames: number; sampleCount: number; peakLinear: number; overRangeSampleCount: number; channelPeaks: { channel: number; peakLinear: number; overRangeSampleCount: number; }[]; }; })}).audioCheck.measurement.sampleFrames,9600);assert.ok(isTimelineRenderRecord(row,i));
  const bad=clone(row);(bad as typeof bad & {audioCheck:({ output: { assetId: `${string}-${string}-${string}-${string}-${string}`; sha256: string; }; schemaVersion: number; profileId: string; policyId: string; stage: string; projectId: unknown; exportId: unknown; attemptId: unknown; snapshotSha256: string; outputFrames: number; checkedAt: string; status: string; code: string; measurement: { sampleRate: number; channels: number; sampleFormat: string; sampleFrames: number; sampleCount: number; peakLinear: number; overRangeSampleCount: number; channelPeaks: { channel: number; peakLinear: number; overRangeSampleCount: number; }[]; }; })}).audioCheck.outputFrames=30;(bad as typeof bad & {audioCheck:({ output: { assetId: `${string}-${string}-${string}-${string}-${string}`; sha256: string; }; schemaVersion: number; profileId: string; policyId: string; stage: string; projectId: unknown; exportId: unknown; attemptId: unknown; snapshotSha256: string; outputFrames: number; checkedAt: string; status: string; code: string; measurement: { sampleRate: number; channels: number; sampleFormat: string; sampleFrames: number; sampleCount: number; peakLinear: number; overRangeSampleCount: number; channelPeaks: { channel: number; peakLinear: number; overRangeSampleCount: number; }[]; }; })}).audioCheck.measurement=measurement();assert.equal(isTimelineRenderRecord(bad,i),false);
  const capability={projectId:i.projectId,timelineId:row.snapshot.timeline.id,timelineRevision:1,expectedRevision:1,exportSettings:i.exportSettings,delivery:row.snapshot.delivery,checkedAt:stamp,status:'available',issues:[]};
  assert.ok(isTimelineExportCapabilitiesResponse(capability,i));
  assert.equal(isTimelineExportCapabilitiesResponse({...capability,audioCheck:(row as typeof row & {audioCheck:({ output: { assetId: `${string}-${string}-${string}-${string}-${string}`; sha256: string; }; schemaVersion: number; profileId: string; policyId: string; stage: string; projectId: unknown; exportId: unknown; attemptId: unknown; snapshotSha256: string; outputFrames: number; checkedAt: string; status: string; code: string; measurement: { sampleRate: number; channels: number; sampleFormat: string; sampleFrames: number; sampleCount: number; peakLinear: number; overRangeSampleCount: number; channelPeaks: { channel: number; peakLinear: number; overRangeSampleCount: number; }[]; }; })}).audioCheck},i),false);
  assert.equal(isTimelineExportSnapshot(row.snapshot,{purpose:'preview'}),false);
  assert.equal(isTimelineRenderRecord(row,{...i,exportSettings:{...i.exportSettings,profileId:'mp4_h264_v1'}}),false);
});

test('export.get v2 read guard validates exact identity and frozen input without changing legacy reads',()=>{
  const untouched={id:'legacy-id',orderedVersionIds:[],status:'completed'};let calls=0;
  assert.ok(isTimelineExportFloatReadResponse(untouched,'other',()=>{calls++;return false;}));assert.equal(calls,0);
  for(const extra of ([{renderAttemptId:randomUUID()},{audioCheck:null},{audioCheck:undefined}] as const))
    assert.equal(isTimelineExportFloatReadResponse({...untouched,...extra},'legacy-id',isTimelineRenderRecord),false);
  const i={...input(),deliveryName:'A frozen title',exportRange:{startFrame:3,endFrame:17}};
  const queued=record(i);(queued.snapshot as typeof queued.snapshot & {deliveryName?:string}).deliveryName=i.deliveryName;
  const before=JSON.stringify(queued);
  assert.ok(isTimelineExportFloatReadResponse(queued,queued.id,(value,frozen)=>{
    calls++;assert.deepEqual(frozen,{...i,exportId:queued.id});return isTimelineRenderRecord(value,frozen);
  }));
  assert.equal(JSON.stringify(queued),before);assert.equal(calls,1);
  const {row}=success();assert.ok(isTimelineExportFloatReadResponse(row,row.id,isTimelineRenderRecord));
  assert.equal(isTimelineExportFloatReadResponse(row,randomUUID(),isTimelineRenderRecord),false);
  assert.equal(isTimelineExportFloatReadResponse(row,row.id,()=>{throw Error('Invalid reader');}),false);
  for(const mutate of ([(r: { audioCheck: unknown; })=>{delete r.audioCheck;},(r: { snapshot: { delivery: { exportSettings: { profileId: string; }; }; }; })=>{r.snapshot.delivery.exportSettings.profileId='mp4_h264_v1';},(r: { snapshot: { delivery: { effective: { profileId: string; }; }; }; })=>{r.snapshot.delivery.effective.profileId='mp4_h264_v1';},(r: { snapshot: { delivery: unknown; }; })=>{delete r.snapshot.delivery;},(r: { snapshot: { assets: never[]; }; })=>{r.snapshot.assets=[];},(r: { purpose: string; })=>{r.purpose='preview';}] as const)){
    const bad=clone(row);mutate(((((bad) as unknown as Parameters<typeof mutate>[0])) as unknown as StrictIntersection<Parameters<NonNullable<typeof mutate>>[0]>));assert.equal(isTimelineExportFloatReadResponse(bad,row.id,isTimelineRenderRecord),false);
  }
});
