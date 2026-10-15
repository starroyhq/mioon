import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createTimelineAudioContinuousServices} from '../packages/business/src/timeline-audio-continuous.ts';
import {continuousAudioSnapshotSchema, continuousAudioPlanSchema} from '../packages/contracts/src/timeline-audio-continuous.ts';
import {VOLUME_ENVELOPE_PROCESSING_PROFILE as profileId} from '../packages/contracts/src/timeline-volume-envelope-processing.ts';
const envelope = points => ({profileId, points: points.map(([frame,multiplier]) => ({frame,multiplier}))});
function fixture(t) {
  const db = new DatabaseSync(':memory:'), projectId=randomUUID(), timelineId=randomUUID(), trackId=randomUUID(), assetId=randomUUID();
  const clip={id:randomUUID(),trackId,assetId,startFrame:0,durationFrames:120,sourceInFrame:0,gain:1};
  const asset={id:assetId,projectId,sha256:'a'.repeat(64),sizeBytes:32,duration:4,mimeType:'audio/wav',hasAudio:true,relativePath:'media/source.wav'};
  const snapshot={timeline:{id:timelineId,projectId,revision:1,fps:30,durationFrames:120,tracks:[{id:trackId,kind:'audio',orderIndex:0,hidden:false,muted:false}],clips:[clip]},assets:[asset]};
  const info={dev:1,ino:2,size:32,mtimeMs:1,ctimeMs:1}, calls={hash:0,probe:0,open:0};
  const probe={sizeBytes:32,durationSeconds:4,audioDurationSeconds:4,streamIndex:0,codecName:'pcm_f32le',sampleRate:48000,channels:2,channelLayout:'stereo',layoutOrigin:'declared',container:'wav'};
  const service=createTimelineAudioContinuousServices({db,root:'/owned'},{runtime:{
    assertOrdinaryWorkspace(){},ownsLock:()=>true,readSavedTimeline:()=>snapshot,
    validateSource:()=>({file:'/owned/media/source.wav',info:{...info}}),
    async hash(_root,source,options){calls.hash++;options.beforeEffect();options.onBytes(source.sizeBytes);return {file:'/owned/media/source.wav',info:{...info},sha256:source.sha256,sizeBytes:source.sizeBytes};},
    decoder:{async probe(){calls.probe++;return probe;},open(){calls.open++;return {done:Promise.resolve(),async read(samples){const pcm=Buffer.alloc(samples*8);for(let i=0;i<samples*2;i++)pcm.writeFloatLE(1,i*4);return pcm;},async close(){}};}},
    boundedShutdown:async work=>work,
  }});
  t.after(async()=>{await service.drain();db.close();});
  const input={projectId,timelineId,expectedRevision:1,startFrame:0};
  const plan=()=>service.handlers['timeline.audioPreview.continuousPlan'](input);
  const consume=async(p,extra={})=>service.consumeBlock({...input,planHash:p.planHash,sessionId:randomUUID(),generation:1,sequence:1,blockStartFrame:0,...extra},{consume:async({pcm})=>pcm});
  return {clip,asset,snapshot,probe,calls,service,plan,consume};
}
test('continuous automation multiplies independently evaluated fade and local envelope at every sample',async t=>{
  const f=fixture(t);f.clip.fadeInFrames=120;f.clip.volumeEnvelope=envelope([[0,0],[120,1]]);
  const plan=await f.plan();assert.equal(plan.volumeEnvelopeProfile,profileId);
  const pcm=await f.consume(plan);for(const sample of [1,1599,1600,24001,95999])assert.equal(pcm.readFloatLE(sample*8),Math.fround((sample/(120*1600))**2));
  assert.deepEqual(f.calls,{hash:2,probe:1,open:1});
});
test('absent and null retain identical PCM but distinct snapshot identity and unchanged legacy response keys',async t=>{
  const a=fixture(t),b=fixture(t);a.clip.fadeInFrames=60;b.clip.fadeInFrames=60;
  const absent=await a.plan();a.clip.volumeEnvelope=null;const nul=await a.plan();
  assert.notEqual(absent.snapshotHash,nul.snapshotHash);assert.equal(Object.hasOwn(nul,'volumeEnvelopeProfile'),false);
  const pcmA=await a.consume(nul),pcmB=await b.consume(await b.plan());assert.deepEqual(pcmA,pcmB);
});
test('muted, zero scalar, cached-no-audio and all-zero envelope each still require actual source verification',async t=>{
  for(const mode of ['muted','gain','cached','zero']){
    const f=fixture(t);f.clip.volumeEnvelope=envelope([[0,mode==='zero'?0:1]]);
    if(mode==='muted')f.snapshot.timeline.tracks[0].muted=true;
    if(mode==='gain')f.clip.gain=0;if(mode==='cached')f.asset.hasAudio=false;
    f.probe.streamIndex=-1;
    await assert.rejects(f.consume(await f.plan()),{code:'VOLUME_ENVELOPE_SOURCE_UNSUPPORTED'});
    assert.equal(f.calls.probe,1);assert.equal(f.calls.open,0);
  }
});
test('silent automated sources complete both hashes without opening a cursor',async t=>{
  const f=fixture(t);f.clip.volumeEnvelope=envelope([[0,1]]);f.snapshot.timeline.tracks[0].muted=true;
  assert.ok((await f.consume(await f.plan())).every(value=>value===0));assert.deepEqual(f.calls,{hash:2,probe:1,open:0});
});
test('automation source budget is independent of silent voice selection',async t=>{
  const f=fixture(t);f.clip.volumeEnvelope=envelope([[0,0]]);f.clip.gain=0;f.asset.sizeBytes=512*1024*1024+1;
  await assert.rejects(f.plan(),{code:'AUDIO_PREVIEW_SOURCE_LIMIT'});assert.deepEqual(f.calls,{hash:0,probe:0,open:0});
});
test('snapshot and plan use exact profile dispatch and reject malformed envelope data',async t=>{
  const f=fixture(t);delete f.asset.relativePath;f.clip.volumeEnvelope=envelope([[0,1]]);
  assert.equal(continuousAudioSnapshotSchema.safeParse(f.snapshot).success,false);
  const projected={...f.snapshot,volumeEnvelopeProfile:profileId};assert.equal(continuousAudioSnapshotSchema.safeParse(projected).success,true);
  projected.volumeEnvelopeProfile='wrong';assert.equal(continuousAudioSnapshotSchema.safeParse(projected).success,false);
  projected.volumeEnvelopeProfile=profileId;f.clip.volumeEnvelope.points[0].frame=-0;assert.equal(continuousAudioSnapshotSchema.safeParse(projected).success,false);
  const g=fixture(t),plan=await g.plan();assert.equal(continuousAudioPlanSchema.safeParse({...plan,volumeEnvelopeProfile:'wrong'}).success,false);
});
test('cached no-audio is rejected only after actual verification and never silently emitted',async t=>{
  const f=fixture(t);f.clip.volumeEnvelope=envelope([[0,1]]);f.asset.hasAudio=false;
  await assert.rejects(f.consume(await f.plan()),{code:'AUDIO_PREVIEW_STALE'});assert.equal(f.calls.probe,1);assert.equal(f.calls.open,0);
});
test('all-zero automation still decodes its verified audible source and emits exact silence',async t=>{
  const f=fixture(t);f.clip.volumeEnvelope=envelope([[0,0]]);
  assert.ok((await f.consume(await f.plan())).every(value=>value===0));assert.deepEqual(f.calls,{hash:2,probe:1,open:1});
});
test('block boundaries and initial seeks use clip-local envelope time, with held anchors',async t=>{
  const f=fixture(t);f.clip.volumeEnvelope=envelope([[30,0.25],[90,0.75]]);f.clip.sourceInFrame=15;f.asset.duration=5;f.probe.durationSeconds=5;
  const plan=await f.plan(),sessionId=randomUUID();
  const first=await f.consume(plan,{sessionId});assert.equal(first.readFloatLE(0),0.25);assert.equal(first.readFloatLE(45*1600*8),0.375);
  const second=await f.consume(plan,{sessionId,sequence:2,blockStartFrame:60});assert.equal(second.readFloatLE(0),0.5);assert.equal(second.readFloatLE(45*1600*8),0.75);
  const seek=await f.consume(plan,{sessionId,sequence:3,generation:2,blockStartFrame:90});assert.equal(seek.readFloatLE(0),0.75);
  assert.equal(f.calls.hash,2);
});
test('malformed saved automation fails bounded admission before any source effect',async t=>{
  for(const value of [undefined,{profileId,points:[]},envelope([[121,0.5]]),envelope([[0,1],[0,0]])]){
    const f=fixture(t);f.clip.volumeEnvelope=value;
    await assert.rejects(f.plan(),error=>['AUDIO_PREVIEW_INVALID_SNAPSHOT','AUDIO_PREVIEW_UNAVAILABLE'].includes(error.code));assert.deepEqual(f.calls,{hash:0,probe:0,open:0});
  }
});
test('hash reservation includes silent automated assets, separately from PCM voices',async t=>{
  const f=fixture(t);f.clip.volumeEnvelope=envelope([[0,1]]);f.clip.gain=0;
  f.asset.sizeBytes=512*1024*1024;
  for(let index=0;index<5;index++){
    const id=randomUUID();f.snapshot.assets.push({...f.asset,id});
    f.snapshot.timeline.clips.push({...f.clip,id:randomUUID(),assetId:id,startFrame:(index+1)*120});
  }
  f.snapshot.timeline.durationFrames=720;
  await assert.rejects(f.plan(),{code:'AUDIO_PREVIEW_HASH_LIMIT'});assert.deepEqual(f.calls,{hash:0,probe:0,open:0});
});
test('envelope edits stale an existing plan even when revision and scalar gain are unchanged',async t=>{
  const f=fixture(t);f.clip.volumeEnvelope=envelope([[0,1]]);const plan=await f.plan();
  f.clip.volumeEnvelope.points[0].multiplier=0.5;
  await assert.rejects(f.consume(plan),{code:'AUDIO_PREVIEW_STALE'});assert.deepEqual(f.calls,{hash:0,probe:0,open:0});
});
test('complete source wrapper budget counts metadata discarded by projection without changing absent admission',async t=>{
  const f=fixture(t);f.asset.padding=Array.from({length:40},()=> 'x'.repeat(8000));
  await f.plan();
  for(const value of [null,envelope([[0,1]])]){
    f.clip.volumeEnvelope=value;
    await assert.rejects(f.plan(),{code:'AUDIO_PREVIEW_INVALID_SNAPSHOT'});
  }
  assert.deepEqual(f.calls,{hash:0,probe:0,open:0});
});
test('reader profiles are derived only when absent, never normalized from conflicting evidence',async t=>{
  for(const active of [false,true])for(const marker of ['wrong',undefined,profileId]){
    const f=fixture(t);if(active)f.clip.volumeEnvelope=envelope([[0,1]]);f.snapshot.volumeEnvelopeProfile=marker;
    if(active&&marker===profileId)assert.equal((await f.plan()).volumeEnvelopeProfile,profileId);
    else await assert.rejects(f.plan(),error=>['AUDIO_PREVIEW_INVALID_SNAPSHOT','AUDIO_PREVIEW_UNAVAILABLE'].includes(error.code));
    assert.deepEqual(f.calls,{hash:0,probe:0,open:0});
  }
});
test('cached-no-audio with fades still reaches actual verification in non-null branch',async t=>{
 const f=fixture(t);f.clip.volumeEnvelope=envelope([[0,1]]);f.clip.fadeInFrames=30;f.asset.hasAudio=false;
 await assert.rejects(f.consume(await f.plan()),{code:'AUDIO_PREVIEW_STALE'});assert.equal(f.calls.probe,1);assert.equal(f.calls.open,0);
});
