type TimelineMixLoudnessTimeline = Parameters<typeof planTimelineMixLoudnessDecode>[0];
import type {StrictMixService} from './helpers/strict-timeline-handler-types.ts';

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createTimelineMixLoudnessDecoder, planTimelineMixLoudnessDecode, type TimelineMixLoudnessAsset} from '../packages/business/src/timeline-mix-loudness-decoder.ts';
import {createTimelineClipLoudnessDecoder} from '../packages/business/src/timeline-clip-loudness-decoder.ts';
import {createTimelineMixLoudnessServices} from '../packages/business/src/timeline-mix-loudness.ts';
import {createTimelineClipLoudnessServices} from '../packages/business/src/timeline-clip-loudness.ts';
import {isTimelineMixLoudnessResponse} from '../packages/contracts/src/timeline-mix-loudness.ts';
import {isTimelineClipLoudnessResponse} from '../packages/contracts/src/timeline-clip-loudness.ts';
import {readyMixLoudness, mixLoudnessInput} from './fixtures/timeline-mix-loudness-fixtures.ts';
import {readyClipLoudness, clipLoudnessInput} from './fixtures/timeline-clip-loudness-fixtures.ts';
const profile='mioon-clip-linear-attenuation-v1';
const envelope=()=>({profileId:profile,points:[{frame:0,multiplier:0},{frame:3,multiplier:1}]});
const id=(n: number)=>`${n}`.repeat(8)+'-'+`${n}`.repeat(4)+'-4'+`${n}`.repeat(3)+'-8'+`${n}`.repeat(3)+'-'+`${n}`.repeat(12);
const fixture=(patch: { volumeEnvelope?: { profileId: string; points: { frame: number; multiplier: number; }[]; }|{}|undefined; gain?: number; startFrame?: number; fadeInFrames?: number; })=>({fps:30,durationFrames:6,tracks:[{id:id(5),kind:'audio',orderIndex:0,hidden:false,muted:false}],clips:[{id:id(4),trackId:id(5),assetId:id(3),startFrame:0,durationFrames:6,sourceInFrame:3,gain:1,...patch}]});
const assets=()=>new Map([[id(3),{file:'/private/source.wav',mimeType:'audio/wav',duration:10,hasAudio:true}]]);
const probe=()=>JSON.stringify({streams:[{index:0,codec_type:'audio',codec_name:'pcm_s16le',sample_rate:'48000',channels:2,channel_layout:'stereo',duration:'10'}],format:{format_name:'wav',duration:'10',size:'1024'}});
const options=()=>({beforeEffect(){},remainingMs:()=>120000,onPcm(){}});
function runtime(){const calls: (unknown[])[]=[];return {calls,checkMediaEffect(f: () => void){f();},withProbePermit:(_s: unknown,fn: () => unknown)=>fn(),async run(_c?: unknown,args?: unknown){calls.push(['probe',args]);return probe();},async runStreaming(_c: unknown,args: string[],o: { onStdout: (arg0: Buffer<ArrayBuffer>) => void; maxStdoutBytes: number; }){calls.push(['decode',args]);o.onStdout(Buffer.alloc(o.maxStdoutBytes));return {stdoutBytes:o.maxStdoutBytes};}};}
test('analysis response dispatch is explicit, bounded and preserves old response shape',()=>{
 for(const [value,valid] of ([[readyMixLoudness(),isTimelineMixLoudnessResponse],[readyClipLoudness(),isTimelineClipLoudnessResponse]] as const)){
  assert.equal(valid(value),true);
  (value as unknown as {volumeEnvelopeProcessingProfile:("mioon-clip-linear-attenuation-v1")|("unknown")|(undefined)}).volumeEnvelopeProcessingProfile=profile;
  if('processingProfile' in value)(value.identity as unknown as {volumeEnvelopeSha256:(string)}).volumeEnvelopeSha256='c'.repeat(64);
  assert.equal(valid(value),true);
  (value as unknown as {volumeEnvelopeProcessingProfile:("mioon-clip-linear-attenuation-v1")|("unknown")|(undefined)}).volumeEnvelopeProcessingProfile='unknown';assert.equal(valid(value),false);
  (value as unknown as {volumeEnvelopeProcessingProfile:("mioon-clip-linear-attenuation-v1")|("unknown")|(undefined)}).volumeEnvelopeProcessingProfile=undefined;assert.equal(valid(value),false);
 }
 const value=readyClipLoudness();(value.identity as unknown as {volumeEnvelopeSha256:(string)}).volumeEnvelopeSha256='c'.repeat(64);assert.equal(isTimelineClipLoudnessResponse(value),false);
 (value as unknown as {volumeEnvelopeProcessingProfile:("mioon-clip-linear-attenuation-v1")|("unknown")|(undefined)}).volumeEnvelopeProcessingProfile=profile;(value.identity as unknown as {volumeEnvelope:({ profileId: string; points: { frame: number; multiplier: number; }[]; })}).volumeEnvelope=envelope();assert.equal(isTimelineClipLoudnessResponse(value),false);
});
test('full analysis verifies non-null muted and zero gain sources before silence output',async()=>{
 for(const mode of (['muted','zero'] as const)){const timeline=fixture({volumeEnvelope:envelope()});if(mode==='muted')timeline.tracks[0].muted=true;else timeline.clips[0].gain=0;
  const r=runtime();await createTimelineMixLoudnessDecoder(((r) as unknown as Parameters<typeof createTimelineMixLoudnessDecoder>[0]))(((timeline) as unknown as TimelineMixLoudnessTimeline),assets(),options());assert.equal(r.calls.filter(c=>c[0]==='probe').length,1);
  assert.equal(planTimelineMixLoudnessDecode(((timeline) as unknown as Parameters<typeof planTimelineMixLoudnessDecode>[0]),assets()).decodeWorkFrames,0);
 }
});
test('non-null cached no-audio sources cannot bypass actual audio eligibility',async()=>{
 const timeline=fixture({volumeEnvelope:envelope(),gain:0});timeline.tracks[0].kind='video';const a=assets();Object.assign(((a.get(id(3))) as unknown as Parameters<NonNullable<(typeof Object)["assign"]>>[0]),{mimeType:'video/mp4',hasAudio:false});
 const r=runtime();r.run=async()=>JSON.stringify({streams:[{index:0,codec_type:'video',codec_name:'h264',width:16,height:16,duration:'10'}],format:{format_name:'mov,mp4,m4a,3gp,3g2,mj2',duration:'10',size:'1024'}});
 await assert.rejects(createTimelineMixLoudnessDecoder(((r) as unknown as Parameters<typeof createTimelineMixLoudnessDecoder>[0]))(((timeline) as unknown as TimelineMixLoudnessTimeline),a,options()));assert.equal(r.calls.filter(c=>c[0]==='decode').length,0);
});
test('isolated analysis rebases clip origin but preserves points and source slip',async()=>{
 const timeline=fixture({startFrame:20,volumeEnvelope:envelope()});const r=runtime();await createTimelineClipLoudnessDecoder(((r) as unknown as Parameters<typeof createTimelineClipLoudnessDecoder>[0]))({clip:((timeline.clips[0]) as unknown as import("../packages/business/src/timeline-mix-loudness-decoder.ts").TimelineMixLoudnessClip),track:((timeline.tracks[0]) as unknown as import("../packages/business/src/timeline-mix-loudness-decoder.ts").TimelineMixLoudnessTrack),asset:((assets().get(id(3))) as unknown as TimelineMixLoudnessAsset)},options());
 const args=(r.calls.find(c=>c[0]==='decode'))![1] as string[];assert.equal(args[args.indexOf('-ss')+1],'0.100000000');assert.match(args[args.indexOf('-filter_complex')+1],/aeval=/);
});
function serviceFixture(patch: {volumeEnvelope?: undefined | null | { profileId: string; points: { frame: number; multiplier: number; }[]; };}={}){
 const timeline={...fixture(((patch) as unknown as Parameters<typeof fixture>[0])),id:id(2),projectId:id(1),revision:4};const asset={id:id(3),projectId:id(1),file:'',mimeType:'audio/wav',duration:10,hasAudio:true,relativePath:'media/source.wav',sha256:'a'.repeat(64),sizeBytes:1024};const raw={timeline,assets:[asset]},seen: unknown[]=[];
 const info={dev:1,ino:1,size:1024,mtimeMs:1,ctimeMs:1};const _strictRuntime={assertOrdinaryWorkspace(){},ownsLock:()=>true,readSavedTimeline:()=>raw,validateSource:()=>({file:'/private/source.wav',info}),async hash(_r: unknown,_a: unknown,o: { onBytes: (arg0: number) => void; }){o.onBytes(1024);return {file:'/private/source.wav',info,sha256:asset.sha256,sizeBytes:1024};},async terminate(){return [];},async waitForClose(){return [];},boundedShutdown:(p?: unknown)=>p};
 const r = _strictRuntime as Omit<typeof _strictRuntime,'hash'> & {hash:(...args:Parameters<typeof _strictRuntime.hash>)=>Promise<unknown>;decode?: ((...args:Parameters<import('../packages/business/src/timeline-mix-loudness.ts').TimelineMixLoudnessRuntime['decode']>)=>Promise<unknown>)|((...args:Parameters<import('../packages/business/src/timeline-clip-loudness.ts').TimelineClipLoudnessRuntime['decode']>)=>Promise<unknown>)};return {raw,seen,r,store:{db:{},root:'/private'}};
}
test('service projections preserve absent/null/value and report exact non-null identity',async()=>{
 for(const field of ([{},{volumeEnvelope:null},{volumeEnvelope:envelope()}] as const))for(const lane of (['mix','clip'] as const)){
  const f=serviceFixture(field);f.r.decode=async(signal?:unknown,a?:unknown,b?:unknown)=>{const timeline=lane==='mix'?signal as TimelineMixLoudnessTimeline:{fps:30,durationFrames:(signal as {clip:{durationFrames:number}}).clip.durationFrames,tracks:[(signal as {track:unknown}).track],clips:[{...(signal as {clip:Record<string,unknown>}).clip,startFrame:0}]};const o=(lane==='mix'?b:a) as {onPcm(chunk:Buffer):void};f.seen.push(((timeline.clips[0]) as unknown as Parameters<typeof f.seen.push>[0]));const plan=planTimelineMixLoudnessDecode(((timeline) as unknown as Parameters<typeof planTimelineMixLoudnessDecode>[0]),assets());o.onPcm(Buffer.alloc(plan.pcmBytes));return {...plan,sampleRate:48000,channels:2};};
  const service=lane==='mix'?(createTimelineMixLoudnessServices(((f.store) as unknown as Parameters<typeof createTimelineMixLoudnessServices>[0]),{runtime:((f.r) as unknown as import("../packages/business/src/timeline-mix-loudness.ts").TimelineMixLoudnessRuntime)}) as StrictMixService):createTimelineClipLoudnessServices(((f.store) as unknown as Parameters<typeof createTimelineClipLoudnessServices>[0]),{runtime:((f.r) as unknown as import("../packages/business/src/timeline-clip-loudness.ts").TimelineClipLoudnessRuntime)});
  const result=await (service.handlers as {'timeline.loudness.prepare':(input?:unknown)=>Promise<import('../packages/contracts/src/timeline-mix-loudness.ts').TimelineMixLoudnessResponse>;'timeline.clip.loudness':(input?:unknown)=>Promise<import('../packages/contracts/src/timeline-clip-loudness.ts').TimelineClipLoudnessResponse>})[lane==='mix'?'timeline.loudness.prepare':'timeline.clip.loudness'](lane==='mix'?mixLoudnessInput:clipLoudnessInput);
  assert.equal(Object.hasOwn(f.seen[0] as object,'volumeEnvelope'),Object.hasOwn(field,'volumeEnvelope'));assert.deepEqual((f.seen[0] as unknown as {volumeEnvelope:({ profileId: string; points: { frame: number; multiplier: number; }[]; })}).volumeEnvelope,field.volumeEnvelope);
  assert.equal(Object.hasOwn(result,'volumeEnvelopeProcessingProfile'),field.volumeEnvelope!=null);
  if(lane==='clip'&&field.volumeEnvelope)assert.equal((result.identity as {volumeEnvelopeSha256?:string}).volumeEnvelopeSha256,createHash('sha256').update(JSON.stringify(field.volumeEnvelope)).digest('hex'));
  await service.drain();
 }
});
test('muted and zero envelope verification bytes are charged before hash or decode',async()=>{
 for(const mode of (['muted','zero'] as const)){const f=serviceFixture({volumeEnvelope:envelope()});if(mode==='muted')f.raw.timeline.tracks[0].muted=true;else f.raw.timeline.clips[0].gain=0;
  f.raw.assets[0].sizeBytes=512*1024*1024+1;let effects=0;f.r.hash=async()=>{effects++;};f.r.decode=async()=>{effects++;};
  const service=(createTimelineMixLoudnessServices(((f.store) as unknown as Parameters<typeof createTimelineMixLoudnessServices>[0]),{runtime:((f.r) as unknown as import("../packages/business/src/timeline-mix-loudness.ts").TimelineMixLoudnessRuntime)}) as StrictMixService);await assert.rejects(service.handlers['timeline.loudness.prepare'](mixLoudnessInput),{code:'TIMELINE_MIX_LOUDNESS_SOURCE_LIMIT'});assert.equal(effects,0);await service.drain();
 }
});
test('scalar candidate keeps every envelope point unchanged for the second actual pass',async()=>{
 const f=serviceFixture({volumeEnvelope:envelope()});f.raw.timeline.durationFrames=f.raw.timeline.clips[0].durationFrames=15;
 f.r.decode=async(timeline: TimelineMixLoudnessTimeline,a: ReadonlyMap<string,TimelineMixLoudnessAsset>,o: { onPcm: (arg0: Buffer<ArrayBuffer>) => void; })=>{f.seen.push(((structuredClone(timeline.clips[0])) as unknown as Parameters<typeof f.seen.push>[0]));const plan=planTimelineMixLoudnessDecode(timeline,a);const pcm=Buffer.alloc(plan.pcmBytes);for(let i=0;i<plan.sampleFrames;i++){const v=.1*timeline.clips[0].gain*Math.sin(2*Math.PI*997*i/48000);pcm.writeFloatLE(v,i*8);pcm.writeFloatLE(-v,i*8+4);}o.onPcm(pcm);return {...plan,sampleRate:48000,channels:2};};
 const service=(createTimelineMixLoudnessServices(((f.store) as unknown as Parameters<typeof createTimelineMixLoudnessServices>[0]),{runtime:((f.r) as unknown as import("../packages/business/src/timeline-mix-loudness.ts").TimelineMixLoudnessRuntime)}) as StrictMixService);const report=await service.handlers['timeline.loudness.prepare']({...mixLoudnessInput,target:{integratedLufs:-30,truePeakCeilingDbtp:-1}});
 assert.equal(report.candidate.status,'measured');assert.equal(f.seen.length,2);assert.notEqual((f.seen[0] as unknown as {gain:(0)}).gain,(f.seen[1] as unknown as {gain:(0)}).gain);assert.deepEqual((f.seen[0] as unknown as {volumeEnvelope:({ profileId: string; points: { frame: number; multiplier: number; }[]; })}).volumeEnvelope,envelope());assert.deepEqual((f.seen[1] as unknown as {volumeEnvelope:({ profileId: string; points: { frame: number; multiplier: number; }[]; })}).volumeEnvelope,envelope());await service.drain();
});
test('invalid envelopes fail planning before any media effect',async()=>{
 for(const value of ([undefined,{}, {...envelope(),points:[{frame:7,multiplier:1}]},{...envelope(),points:[{frame:0,multiplier:2}]}] as const)){
  const r=runtime();await assert.rejects(createTimelineMixLoudnessDecoder(((r) as unknown as Parameters<typeof createTimelineMixLoudnessDecoder>[0]))(((fixture({volumeEnvelope:value})) as unknown as TimelineMixLoudnessTimeline),assets(),options()));assert.equal(r.calls.length,0);
 }
});
test('non-null source identities remain in silent muted/zero reports with two hashes',async()=>{
 for(const mode of (['muted','zero'] as const)){
  const f=serviceFixture({volumeEnvelope:envelope()});if(mode==='muted')f.raw.timeline.tracks[0].muted=true;else f.raw.timeline.clips[0].gain=0;
  f.r.decode=async(t: TimelineMixLoudnessTimeline,a: ReadonlyMap<string,TimelineMixLoudnessAsset>,o: { onPcm: (arg0: Buffer<ArrayBuffer>) => void; })=>{const plan=planTimelineMixLoudnessDecode(t,a);o.onPcm(Buffer.alloc(plan.pcmBytes));return {...plan,sampleRate:48000,channels:2};};
  const service=(createTimelineMixLoudnessServices(((f.store) as unknown as Parameters<typeof createTimelineMixLoudnessServices>[0]),{runtime:((f.r) as unknown as import("../packages/business/src/timeline-mix-loudness.ts").TimelineMixLoudnessRuntime)}) as StrictMixService);const report=await service.handlers['timeline.loudness.prepare'](mixLoudnessInput);assert.equal(report.identity.sources.length,1);assert.equal(report.checks.bytesHashed,2048);assert.equal(report.checks.decodeWorkFrames,0);await service.drain();
 }
});
test('decoder captures detached envelope points before asynchronous source verification',async()=>{
 const timeline=fixture({volumeEnvelope:envelope()});const r=runtime(),originalRun=r.run;r.run=async(...args)=>{(timeline.clips[0].volumeEnvelope as ReturnType<typeof envelope>).points[0].multiplier=.987654321;return originalRun(...args);};
 await createTimelineMixLoudnessDecoder(((r) as unknown as Parameters<typeof createTimelineMixLoudnessDecoder>[0]))(((timeline) as unknown as TimelineMixLoudnessTimeline),assets(),options());const args=(r.calls.find(c=>c[0]==='decode'))![1] as string[];assert.doesNotMatch(args[args.indexOf('-filter_complex')+1],/987654321/);
});
test('whole envelope processing snapshot includes original source metadata in the unchanged 256-KiB cap',async()=>{
 for(const lane of (['mix','clip'] as const))for(const field of ([{volumeEnvelope:null},{volumeEnvelope:envelope()}] as const)){
  const f=serviceFixture(field);(f.raw.assets[0] as unknown as {privateMetadata:(string)}).privateMetadata='x'.repeat(256*1024);let effects=0;f.r.decode=async()=>{effects++;};f.r.hash=async()=>{effects++;};
  const service=lane==='mix'?(createTimelineMixLoudnessServices(((f.store) as unknown as Parameters<typeof createTimelineMixLoudnessServices>[0]),{runtime:((f.r) as unknown as import("../packages/business/src/timeline-mix-loudness.ts").TimelineMixLoudnessRuntime)}) as StrictMixService):createTimelineClipLoudnessServices(((f.store) as unknown as Parameters<typeof createTimelineClipLoudnessServices>[0]),{runtime:((f.r) as unknown as import("../packages/business/src/timeline-clip-loudness.ts").TimelineClipLoudnessRuntime)});
  await assert.rejects((service.handlers as {'timeline.loudness.prepare':(input?:unknown)=>Promise<import('../packages/contracts/src/timeline-mix-loudness.ts').TimelineMixLoudnessResponse>;'timeline.clip.loudness':(input?:unknown)=>Promise<import('../packages/contracts/src/timeline-clip-loudness.ts').TimelineClipLoudnessResponse>})[lane==='mix'?'timeline.loudness.prepare':'timeline.clip.loudness'](lane==='mix'?mixLoudnessInput:clipLoudnessInput),{code:`TIMELINE_${lane.toUpperCase()}_LOUDNESS_RESOURCE_LIMIT`});assert.equal(effects,0);await service.drain();
 }
});
test('absent envelope retains historical raw snapshot budget and identity',async()=>{
 const f=serviceFixture();(f.raw.assets[0] as unknown as {privateMetadata:(string)}).privateMetadata='x'.repeat(256*1024);f.r.decode=async(t: TimelineMixLoudnessTimeline,a: ReadonlyMap<string,TimelineMixLoudnessAsset>,o: { onPcm: (arg0: Buffer<ArrayBuffer>) => void; })=>{const plan=planTimelineMixLoudnessDecode(t,a);o.onPcm(Buffer.alloc(plan.pcmBytes));return {...plan,sampleRate:48000,channels:2};};
 const service=(createTimelineMixLoudnessServices(((f.store) as unknown as Parameters<typeof createTimelineMixLoudnessServices>[0]),{runtime:((f.r) as unknown as import("../packages/business/src/timeline-mix-loudness.ts").TimelineMixLoudnessRuntime)}) as StrictMixService);const report=await service.handlers['timeline.loudness.prepare'](mixLoudnessInput);assert.equal(report.identity.snapshotSha256,createHash('sha256').update(JSON.stringify(f.raw)).digest('hex'));await service.drain();
});
test('analysis reader rejects explicit conflicting processing profile before media effects',async()=>{
 for(const lane of (['mix','clip'] as const))for(const field of ([{},{volumeEnvelope:null},{volumeEnvelope:envelope()}] as const))for(const profile of ([undefined,'unknown'] as const)){
  const f=serviceFixture(field);(f.raw as unknown as {volumeEnvelopeProfile:("unknown" | undefined)}).volumeEnvelopeProfile=profile;let effects=0;f.r.hash=async()=>{effects++;};f.r.decode=async()=>{effects++;};
  const service=lane==='mix'?(createTimelineMixLoudnessServices(((f.store) as unknown as Parameters<typeof createTimelineMixLoudnessServices>[0]),{runtime:((f.r) as unknown as import("../packages/business/src/timeline-mix-loudness.ts").TimelineMixLoudnessRuntime)}) as StrictMixService):createTimelineClipLoudnessServices(((f.store) as unknown as Parameters<typeof createTimelineClipLoudnessServices>[0]),{runtime:((f.r) as unknown as import("../packages/business/src/timeline-clip-loudness.ts").TimelineClipLoudnessRuntime)});
  await assert.rejects((service.handlers as {'timeline.loudness.prepare':(input?:unknown)=>Promise<import('../packages/contracts/src/timeline-mix-loudness.ts').TimelineMixLoudnessResponse>;'timeline.clip.loudness':(input?:unknown)=>Promise<import('../packages/contracts/src/timeline-clip-loudness.ts').TimelineClipLoudnessResponse>})[lane==='mix'?'timeline.loudness.prepare':'timeline.clip.loudness'](lane==='mix'?mixLoudnessInput:clipLoudnessInput));
  assert.equal(effects,0);await service.drain();
 }
});

test('cached false audio and faded sources still reach actual probe for non-null automation',async()=>{
 for(const kind of (['audio','video'] as const)){
  const timeline=fixture({volumeEnvelope:envelope(),gain:0,fadeInFrames:1});timeline.tracks[0].kind=kind;
  const a=assets();Object.assign(((a.get(id(3))) as unknown as Parameters<NonNullable<(typeof Object)["assign"]>>[0]),{mimeType:kind==='audio'?'audio/wav':'video/mp4',hasAudio:false});
  let probes=0,decoded=0;const r=runtime();r.run=async()=>{probes++;return probe();};r.runStreaming=async()=>{decoded++;throw Error('must not decode mismatched metadata');};
  await assert.rejects(createTimelineMixLoudnessDecoder(((r) as unknown as Parameters<typeof createTimelineMixLoudnessDecoder>[0]))(((timeline) as unknown as TimelineMixLoudnessTimeline),a,options()));assert.equal(probes,1);assert.equal(decoded,0);
 }
});
