import type {FixtureTimeline, FixtureSnapshot} from './helpers/strict-timeline-core-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {volumeEnvelopeReadSnapshot,volumeEnvelopeField,volumeEnvelopeSnapshotFields,isVolumeEnvelopeProcessingSnapshot,VOLUME_ENVELOPE_PROCESSING_PROFILE as profile} from '../packages/contracts/src/timeline-volume-envelope-processing.ts';
import {timelineClipAudioFilter} from '../packages/business/src/timeline-audio-filter-graph.ts';
import {freezeTimelineSnapshot} from '../packages/business/src/timeline-inputs.ts';
import {prepareTimelineInputs} from '../packages/business/src/timeline-sources.ts';
import {createTimelineAudioPreviewServices} from '../packages/business/src/timeline-audio-preview.ts';
const envelope=():import('../packages/contracts/src/timeline-volume-envelope.ts').VolumeEnvelope=>({profileId:profile,points:[{frame:0,multiplier:0},{frame:6,multiplier:1}]});
const clip=<P extends object = {}>(patch: P = {} as P)=>({durationFrames:6,startFrame:3,sourceInFrame:2,gain:.75,fadeInFrames:2,fadeOutFrames:2,...patch});
test('processing projection preserves exact absence/null/value, detached points and strict dispatch',()=>{
 for(const fields of ([{},{volumeEnvelope:null},{volumeEnvelope:envelope()}] as const)){
  const c=clip(fields),copy=volumeEnvelopeField(c);assert.deepEqual(copy,fields);
  const snapshot={timeline:{clips:[c]},...volumeEnvelopeSnapshotFields({clips:[c]})};
  assert.equal(isVolumeEnvelopeProcessingSnapshot(snapshot),true);
  assert.equal(Object.hasOwn(snapshot,'volumeEnvelopeProfile'),fields.volumeEnvelope!=null);
  assert.equal(isVolumeEnvelopeProcessingSnapshot({...snapshot,volumeEnvelopeProfile:'unknown'}),false);
  if(fields.volumeEnvelope){assert.notEqual(copy.volumeEnvelope,c.volumeEnvelope);delete snapshot.volumeEnvelopeProfile;assert.equal(isVolumeEnvelopeProcessingSnapshot(snapshot),false);}
 }
 assert.equal(isVolumeEnvelopeProcessingSnapshot({timeline:{clips:[clip({volumeEnvelope:undefined})]}}),false);
});
test('envelope-bearing wrapper enforces exact unchanged 256 KiB boundary including null',()=>{
 for(const field of ([null,envelope()] as const)){
  const snapshot={timeline:{clips:[clip({volumeEnvelope:field})]},...volumeEnvelopeSnapshotFields({clips:[clip({volumeEnvelope:field})]}),padding:''};
  const base=Buffer.byteLength(JSON.stringify(snapshot));snapshot.padding='x'.repeat(262144-base);assert.equal(isVolumeEnvelopeProcessingSnapshot(snapshot),true);
  snapshot.padding+='x';assert.equal(isVolumeEnvelopeProcessingSnapshot(snapshot),false);
 }
});
test('graph preserves exact absent/null bytes and inserts sample-aware fenced stage after fades',()=>{
 const c=clip(),legacy=timelineClipAudioFilter(c,4,1600,1,2);
 assert.equal(timelineClipAudioFilter({...c,volumeEnvelope:null},4,1600,1,2),legacy);
 const graph=timelineClipAudioFilter({...c,volumeEnvelope:envelope()},4,1600,1,2);
 assert.match(graph,/afade=t=out:ss=6400:ns=3200:curve=tri,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aformat=sample_fmts=dblp:sample_rates=48000:channel_layouts=stereo,aeval=/);
 assert.match(graph,/\(n\+1600\)/);assert.match(graph,/:c=same,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=N\/SR\/TB\[a1\]$/);
 assert.throws(()=>timelineClipAudioFilter({...c,volumeEnvelope:envelope()},2,1600,1,2));
 assert.throws(()=>timelineClipAudioFilter({...c,volumeEnvelope:undefined},4,1600,1,2));
});
async function sourceFixture(t: test.TestContext,field?: {}|undefined,muted: unknown=true,gain: number|boolean=0){
 const root=await mkdtemp(path.join(tmpdir(),'envelope-processing-'));await mkdir(path.join(root,'media'),{mode:0o700});t.after(()=>rm(root,{recursive:true,force:true}));
 const bytes=Buffer.alloc(1024,7),asset={id:randomUUID(),projectId:randomUUID(),sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length,mimeType:'video/mp4',duration:10,hasAudio:false,hasVideo:true,width:16,height:16,relativePath:'media/source.mp4'};
 await writeFile(path.join(root,asset.relativePath),bytes,{mode:0o600});const track={id:randomUUID(),kind:'video',orderIndex:0,hidden:false,muted};
 const timeline={id:randomUUID(),projectId:asset.projectId,revision:1,width:720,height:1280,fps:30,durationFrames:9,tracks:[track],clips:[{...clip(field),gain,id:randomUUID(),trackId:track.id,assetId:asset.id,rect:{x:0,y:0,width:720,height:1280}}]};
 return {root,asset,timeline,snapshot:(freezeTimelineSnapshot as (...args:Partial<Parameters<typeof freezeTimelineSnapshot>>)=>FixtureSnapshot)(((timeline) as unknown as Parameters<NonNullable<(...args:Partial<Parameters<typeof freezeTimelineSnapshot>>)=>FixtureSnapshot>>[0]),new Map([[asset.id,asset]]))};
}
test('render required verification includes muted/zero/cached-no-audio and all-zero curves',async t=>{
 for(const [muted,gain] of ([[true,1],[false,0],[true,0]] as const)){
  const field=envelope();field.points.forEach(p=>p.multiplier=0);const f=await sourceFixture(t,{volumeEnvelope:field},((muted) as unknown as Parameters<typeof sourceFixture>[2]),gain);let probes=0;
  const options={root:f.root,projectId:f.asset.projectId,readAsset:()=>f.asset,probe:async()=>{probes++;return {hasVideo:true,hasAudio:false,duration:10,width:16,height:16,probe:{streams:[{index:0,codec_type:'video',codec_name:'h264'}],format:{format_name:'mov,mp4,m4a,3gp,3g2,mj2',duration:'10',size:'1024'}}};}};
  await assert.rejects(prepareTimelineInputs(((f.snapshot) as unknown as Parameters<NonNullable<typeof prepareTimelineInputs>>[0]),((options) as unknown as Parameters<typeof prepareTimelineInputs>[1])));assert.equal(probes,1);
  options.probe=async()=>({hasVideo:true,hasAudio:true,duration:10,width:16,height:16,audioStreamIndex:1,probe:{streams:[{index:1,codec_type:'audio',codec_name:'aac',sample_rate:'48000',channels:2,channel_layout:'stereo'}],format:{format_name:'mov,mp4,m4a,3gp,3g2,mj2',duration:'10',size:'1024'}}});
  const prepared=await prepareTimelineInputs(((f.snapshot) as unknown as Parameters<NonNullable<typeof prepareTimelineInputs>>[0]),((options) as unknown as Parameters<typeof prepareTimelineInputs>[1]));assert.equal((prepared.get(f.asset.id))!.hasAudio,true);
 }
});
test('legacy audition rejects non-null before projection even muted or zero gain',async()=>{
 for(const muted of ([false,true] as const))for(const gain of ([0,1] as const)){
  const raw={timeline:{tracks:[{muted}],clips:[clip({gain,volumeEnvelope:envelope()})]},assets:[]};
  const service=createTimelineAudioPreviewServices({db:(({}) as unknown as import("node:sqlite").DatabaseSync),root:'/unused'},{runtime:({assertOrdinaryWorkspace(){},ownsLock:()=>true,readSavedTimeline:()=>raw} as unknown as NonNullable<Parameters<typeof createTimelineAudioPreviewServices>[1]>['runtime'])});
  await assert.rejects(service.handlers['timeline.audioPreview.plan']({projectId:randomUUID(),timelineId:randomUUID(),expectedRevision:1,startFrame:0}),{code:'AUDIO_PREVIEW_VOLUME_ENVELOPE_UNSUPPORTED'});
 }
});

test('reader profile derivation never erases explicit conflicting evidence',()=>{
 for(const field of ([{},{volumeEnvelope:null},{volumeEnvelope:envelope()}] as const)){
  const raw={timeline:{clips:[clip(field)]}};const inferred=volumeEnvelopeReadSnapshot(raw);
  assert.equal(inferred.volumeEnvelopeProfile,field.volumeEnvelope?profile:undefined);
  for(const value of ([undefined,null,'unknown'] as const))assert.throws(()=>volumeEnvelopeReadSnapshot({...raw,volumeEnvelopeProfile:value}));
  if(field.volumeEnvelope)assert.equal(volumeEnvelopeReadSnapshot({...raw,volumeEnvelopeProfile:profile}).volumeEnvelopeProfile,profile);
  else assert.throws(()=>volumeEnvelopeReadSnapshot({...raw,volumeEnvelopeProfile:profile}));
 }
});
