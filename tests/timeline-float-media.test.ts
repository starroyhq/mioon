import type {FixtureTimeline} from './helpers/strict-timeline-core-types.ts';
import type {FloatRenderResult,ProbeJson} from './helpers/strict-timeline-media-result-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,readdir,stat,mkdir} from 'node:fs/promises';
import {readdirSync,readFileSync,statSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {resolveTimelineExportDelivery,TIMELINE_SUBTITLE_PROFILE_ID,TIMELINE_SUBTITLE_FONT_SHA256} from '@mioon/contracts';
import {renderTimeline} from '../packages/business/src/timeline-media.ts';
import {run,runStreaming} from '../packages/business/src/media-runtime.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {readTimelineFloatAudioCheckFailure,isOwnedTimelineFloatAudioMeasurement} from '../packages/business/src/timeline-float-audio-check.ts';
import type { BinaryLike } from 'crypto';
import type { PathLike } from 'fs';

const floatSettings={profileId:'mp4_h264_float_checked_v2',resolution:'short_360',rateControl:{mode:'crf',quality:'standard'}};
const hash=(bytes: Buffer<ArrayBuffer>|BinaryLike)=>createHash('sha256').update(bytes).digest('hex');
const wave=(amplitude: number,sampleRate: number=48000,channels: number=2,tone: boolean=false)=>{
 const frames=sampleRate/2,bytes=Buffer.alloc(44+frames*channels*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(3,20);bytes.writeUInt16LE(channels,22);bytes.writeUInt32LE(sampleRate,24);bytes.writeUInt32LE(sampleRate*channels*4,28);bytes.writeUInt16LE(channels*4,32);bytes.writeUInt16LE(32,34);bytes.write('data',36);bytes.writeUInt32LE(frames*channels*4,40);
 for(let n=0;n<frames;n++)for(let ch=0;ch<channels;ch++)bytes.writeFloatLE(amplitude*(ch?-1:1)*(tone?Math.sin(2*Math.PI*440*n/sampleRate):1),44+(n*channels+ch)*4);return bytes;
};
async function sandbox(t: test.TestContext){const root=await mkdtemp(path.join(tmpdir(),'mioon-float-media-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function fixture(root: string,{amplitude=.7,gain=2,overlap=false,edges=false,sampleRate=48000,channels=2,fades=false,tone=false}={}){
 const file=path.join(root,`${randomUUID()}.wav`),bytes=wave(amplitude,sampleRate,channels,tone);await writeFile(file,bytes);
 const asset={id:randomUUID(),mimeType:'audio/wav',path:file,width:0,height:0,duration:.5,hasVideo:false,hasAudio:true,audioStreamIndex:0};
 const tracks=[{id:randomUUID(),kind:'video',orderIndex:0,hidden:false,muted:false},{id:randomUUID(),kind:'audio',orderIndex:1,hidden:false,muted:false},{id:randomUUID(),kind:'audio',orderIndex:2,hidden:false,muted:false},{id:randomUUID(),kind:'audio',orderIndex:3,hidden:false,muted:true}];
 const clip=(track: number,options: {fadeInFrames?: number | undefined; fadeOutFrames?: number | undefined;}={})=>({id:randomUUID(),trackId:tracks[track].id,assetId:asset.id,name:'Synthetic float',startFrame:0,durationFrames:12,sourceInFrame:0,rect:{x:0,y:0,width:720,height:720},gain,...options});
 const timeline={id:randomUUID(),projectId:randomUUID(),revision:1,fps:30,width:720,height:720,durationFrames:12,tracks,clips:[clip(1,fades?{fadeInFrames:3,fadeOutFrames:3}:{})],createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'};
 if(overlap)timeline.clips.push(clip(2));if(edges)timeline.clips.push(clip(3,(({startFrame:3,durationFrames:6}) as unknown as Parameters<NonNullable<typeof clip>>[1])));
 return {timeline,asset,assets:new Map([[asset.id,asset]]),sourceHash:hash(bytes)};
}
async function decode(file: string){await run('ffmpeg',['-hide_banner','-loglevel','error','-xerror','-threads','1','-i',file,'-map','0:v:0','-map','0:a:0','-f','null','-'],{timeout:30000,maxStdoutBytes:0,maxStderrBytes:64*1024});}
const snapshot=(timeline: FixtureTimeline,extras: string|number|{ exportRange?: undefined; }|{ exportRange: { startFrame: number; endFrame: number; }; }|undefined={})=>({timeline,delivery:resolveTimelineExportDelivery(timeline,floatSettings),...(extras as Record<string, unknown>)});

test('actual v2 retains 1.4/1.6 float headroom and rejects before creating final AAC artifact',{timeout:60000},async t=>{
 const root=await sandbox(t);
 for(const [name,config,expected] of ([['single',{amplitude:.7,gain:2},1.4],['overlap',{amplitude:.4,gain:2,overlap:true},1.6]] as const)){
  const f=await fixture(root,((config) as unknown as Parameters<typeof fixture>[1])),saved=snapshot(f.timeline),frozen=JSON.stringify(saved),destination=path.join(root,`${name}.mp4`);let report:ReturnType<typeof readTimelineFloatAudioCheckFailure>;
  await assert.rejects(renderTimeline(((saved) as unknown as Parameters<typeof renderTimeline>[0]),f.assets,destination),error=>{assert.equal((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code,'EXPORT_AUDIO_OVER_RANGE');report=readTimelineFloatAudioCheckFailure(error);return true;});
  assert.ok(report?.measurement);assert.ok(Math.abs((report.measurement.peakLinear as number)-expected)<1e-6);assert.equal(report.measurement.sampleFrames,19200);assert.equal(report.measurement.overRangeSampleCount,38400);
  await assert.rejects(stat(destination),{code:'ENOENT'});assert.equal(JSON.stringify(saved),frozen);assert.equal(hash(await readFile(f.asset.path)),f.sourceHash);
 }
 assert.equal((await readdir(root)).some(name=>name.startsWith('.timeline-')),false);
});

test('actual quiet v2 whole/range uses exact sample counts across muted segment edges, global fades and mono44.1k conversion',{timeout:60000},async t=>{
 const root=await sandbox(t),f=await fixture(root,{amplitude:.7,gain:.5,edges:true,sampleRate:44100,channels:1,fades:true});
 for(const [name,extra,frames] of ([['whole',{},12],['range',{exportRange:{startFrame:2,endFrame:10}},8]] as const)){
  const destination=path.join(root,`${name}.mp4`),result=(await renderTimeline(((snapshot(f.timeline,extra)) as unknown as Parameters<typeof renderTimeline>[0]),f.assets,destination) as FloatRenderResult);
  assert.equal(result.width,360);assert.equal(result.height,360);assert.equal(isOwnedTimelineFloatAudioMeasurement(result.audioCheck),true);assert.equal(result.audioCheck.sampleFrames,frames*1600);assert.equal(result.audioCheck.overRangeSampleCount,0);assert.ok(result.audioCheck.peakLinear>.24&&result.audioCheck.peakLinear<.26);await decode(destination);
 }
 assert.equal(hash(await readFile(f.asset.path)),f.sourceHash);assert.equal((await readdir(root)).some(name=>name.startsWith('.timeline-')),false);
});

test('omitted and explicit v1 preserve byte-identical integer rendering with no audioCheck field',{timeout:30000},async t=>{
 const root=await sandbox(t),f=await fixture(root,{amplitude:.7,gain:2}),omitted=path.join(root,'omitted.mp4'),v1=path.join(root,'v1.mp4');
 const a=(await renderTimeline((({timeline:f.timeline}) as unknown as Parameters<typeof renderTimeline>[0]),f.assets,omitted) as FloatRenderResult),b=(await renderTimeline((({timeline:f.timeline,delivery:resolveTimelineExportDelivery(f.timeline,{profileId:'mp4_h264_v1',resolution:'native',rateControl:{mode:'crf',quality:'standard'}})}) as unknown as Parameters<typeof renderTimeline>[0]),f.assets,v1) as FloatRenderResult);
 assert.equal('audioCheck' in a,false);assert.equal('audioCheck' in b,false);assert.deepEqual(await readFile(v1),await readFile(omitted));
});

test('actual complete within-limit check survives a subsequent AAC spawn failure as owned evidence',{timeout:30000},async t=>{
 const root=await sandbox(t),f=await fixture(root,{amplitude:.7,gain:.5}),original=process.env.MIOON_FFMPEG_PATH;let exits=0;
 const off=onMediaProcess(event=>{
  // The fixed capability has listing + 2 MOVs + float read + AAC proof; this
  // one-segment render then completes one MOV and its exact float read.
  if(event.type==='exited'&&event.kind==='ffmpeg'&&++exits===7)process.env.MIOON_FFMPEG_PATH=path.join(root,'missing-final-encoder');
 });
 try{
  await assert.rejects(renderTimeline(((snapshot(f.timeline)) as unknown as Parameters<typeof renderTimeline>[0]),f.assets,path.join(root,'failed.mp4')),error=>{assert.equal((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code,'MEDIA_SPAWN_FAILED');const report=readTimelineFloatAudioCheckFailure(error);assert.equal(report?.code,'EXPORT_AUDIO_WITHIN_LIMIT');assert.equal((report.measurement)!.sampleFrames,19200);assert.ok((report.measurement)!.peakLinear<1);return true;});assert.equal(exits,7);
 }finally{off();if(original===undefined)delete process.env.MIOON_FFMPEG_PATH;else process.env.MIOON_FFMPEG_PATH=original;}
 assert.equal((await readdir(root)).some(name=>name.startsWith('.timeline-')),false);
});


// Independent media evidence from the renderer's already-produced, owned
// intermediates. Copies are test-only and read after observed direct-child close;
// production staging ownership/cleanup is never changed or bypassed.
async function captureRenderedSegments(root: PathLike,label: string,operation: { (): Promise<unknown>; (): Promise<unknown>; (): Promise<unknown>; (): Promise<unknown>; (): unknown; }){
 const captured=new Map();
 const off=onMediaProcess(event=>{
  if(event.type!=='exited'||event.kind!=='ffmpeg')return;
  for(const directory of readdirSync(root).filter(name=>name.startsWith('.timeline-render-'))){
   const work=path.join(((root) as unknown as Parameters<typeof path.join>[0]),directory);
   for(const leaf of readdirSync(work).filter(name=>/^segment-\d+\.mov$/.test(name))){
    if(captured.has(leaf))continue;const file=path.join(work,leaf);if(statSync(file).size)captured.set(leaf,readFileSync(file));
   }
  }
 });
 let result,error;try{result=await operation();}catch(failure){error=failure;}finally{off();}
 const segments=[];
 for(const [leaf,bytes] of [...captured].sort(([a],[b])=>a.localeCompare(b))){const file=path.join(((root) as unknown as Parameters<typeof path.join>[0]),`${label}-${leaf}`);await writeFile(file,bytes);segments.push({file,containerBytes:bytes.length,sha256:hash(bytes)});}
 return {result,error,segments};
}
async function decodedBytes(file: string,{video=false,pcm='f32le'}={}){
 const chunks: (Buffer<ArrayBuffer>)[]=[],output=await runStreaming('ffmpeg',['-hide_banner','-loglevel','error','-xerror','-threads','1','-i',file,
  ...(video?['-map','0:v:0','-an','-pix_fmt','gray','-f','rawvideo']:['-map','0:a:0','-vn','-c:a',pcm==='f32le'?'pcm_f32le':'pcm_s16le','-f',pcm]),'pipe:1'],
  {timeout:30000,maxStdoutBytes:2*1024*1024,maxStderrBytes:64*1024,onStdout:chunk=>chunks.push(Buffer.from(chunk))});
 return Buffer.concat(chunks,output.stdoutBytes);
}
const rmsWindow=(bytes: Buffer<ArrayBuffer>,from: number,to: number)=>{let sum=0;for(let frame=from;frame<to;frame++)sum+=bytes.readFloatLE(frame*8)**2;return Math.sqrt(sum/(to-from));};
const peakOf=(bytes: Buffer<ArrayBuffer>)=>{let peak=0;for(let at=0;at<bytes.length;at+=4)peak=Math.max(peak,Math.abs(bytes.readFloatLE(at)));return peak;};

test('actual selected v2 preserves global subtitle timing and exact float envelope, with observed intermediate storage tradeoff',{timeout:90000},async t=>{
 const root=await sandbox(t),f=await fixture(root,{amplitude:.7,gain:.5,edges:true,fades:true,tone:true});
 // Muted edges at global6 and9 cut through the caption and fade-out start.
 Object.assign(f.timeline.clips[1],{startFrame:6,durationFrames:3});
 (f.timeline as unknown as {subtitles:({ profileId: string; cues: { id: `${string}-${string}-${string}-${string}-${string}`; text: string; startFrame: number; durationFrames: number; }[]; })}).subtitles={profileId:TIMELINE_SUBTITLE_PROFILE_ID,cues:[{id:randomUUID(),text:'Float check 100%',startFrame:4,durationFrames:6}]};
 const subtitleProfile={profileId:TIMELINE_SUBTITLE_PROFILE_ID,fontSha256:TIMELINE_SUBTITLE_FONT_SHA256};
 const wholeSnapshot=snapshot(f.timeline,(({subtitleProfile}) as unknown as Parameters<typeof snapshot>[1])),rangeSnapshot=snapshot(f.timeline,(({subtitleProfile,exportRange:{startFrame:2,endFrame:11}}) as unknown as Parameters<typeof snapshot>[1])),
  originalWhole=JSON.stringify(wholeSnapshot),originalRange=JSON.stringify(rangeSnapshot),wholeFile=path.join(root,'caption-whole.mp4'),rangeFile=path.join(root,'caption-range.mp4');
 const whole=await captureRenderedSegments(root,'whole',()=>renderTimeline(((wholeSnapshot) as unknown as Parameters<typeof renderTimeline>[0]),f.assets,wholeFile));assert.ifError(whole.error);
 const selected=await captureRenderedSegments(root,'range',()=>renderTimeline(((rangeSnapshot) as unknown as Parameters<typeof renderTimeline>[0]),f.assets,rangeFile));assert.ifError(selected.error);
 assert.equal(whole.segments.length,3);assert.equal(selected.segments.length,3);
 const describe=async(captured:Awaited<ReturnType<typeof captureRenderedSegments>>,pcm: string|undefined='f32le')=>{const raw: (Buffer<ArrayBuffer>)[]=[];const segments=[];for(const segment of captured.segments){const bytes=await decodedBytes(segment.file,{pcm});raw.push(bytes);segments.push({containerBytes:segment.containerBytes,containerSha256:segment.sha256,pcmBytes:bytes.length,sampleFrames:bytes.length/(pcm==='f32le'?8:4),...(pcm==='f32le'?{peakLinear:peakOf(bytes)}:{})});}return {raw:Buffer.concat(raw),segments};};
 const wholePcm=await describe(whole),selectedPcm=await describe(selected);
 assert.equal(wholePcm.raw.length,12*1600*8);assert.equal(selectedPcm.raw.length,9*1600*8);
 assert.deepEqual(selectedPcm.raw,wholePcm.raw.subarray(2*1600*8,11*1600*8),'Already-rendered selected float PCM exactly matches the global whole interval, including fades at every segment edge');
 const wholeDecoded=await decodedBytes(wholeFile),rangeDecoded=await decodedBytes(rangeFile),audioWindows: ({ fromSeconds: number; toSeconds: number; wholeRms: number; selectedRms: number; })[]=[];
 // Same-alignment AAC reference: the selected float PCM is already proven exact
 // against the whole timeline above, so encode that exact PCM through the same
 // final AAC settings and compare envelope windows like-for-like. Comparing the
 // whole stream directly would mix in the range stream's unavoidable AAC onset
 // (the range encoder starts at global frame 2, mid-fade).
 const referenceRaw=path.join(root,`float-reference-${randomUUID()}.f32le`),referenceFile=path.join(root,`float-reference-${randomUUID()}.mp4`);
 await writeFile(referenceRaw,selectedPcm.raw);
 await run('ffmpeg',['-hide_banner','-loglevel','error','-n','-threads','1','-f','f32le','-ar','48000','-ac','2','-i',referenceRaw,'-af','asetpts=N/SR/TB','-c:a','aac','-b:a','128k','-ar','48000','-ac','2','-t',(9/30).toFixed(9),'-movflags','+faststart',referenceFile],{timeout:30000,maxStdoutBytes:0,maxStderrBytes:64*1024});
 const referenceDecoded=await decodedBytes(referenceFile);
 for(const [fromSeconds,toSeconds] of ([[.012,.025],[.05,.065],[.12,.13],[.145,.16],[.24,.255],[.275,.29]] as const)){
  const from=Math.round(fromSeconds*48000),to=Math.round(toSeconds*48000),reference=rmsWindow(referenceDecoded,from,to),actual=rmsWindow(rangeDecoded,from,to);
  assert.ok(Math.abs(actual-reference)<.012,`AAC envelope window ${fromSeconds} follows global time: ${actual} versus ${reference}`);audioWindows.push({fromSeconds,toSeconds,wholeRms:reference,selectedRms:actual});
 }
 assert.ok(audioWindows[0].selectedRms>(audioWindows.at(-1))!.selectedRms*1.4,'Selection does not restart the saved fade-in or delay fade-out');
 const fullVideo=await decodedBytes(wholeFile,{video:true}),rangeVideo=await decodedBytes(rangeFile,{video:true}),frameBytes=360*360,captionFrames: ({ relativeFrame: number; globalFrame: number; visible: boolean; wholeInk: number; selectedInk: number; })[]=[];
 assert.equal(fullVideo.length,12*frameBytes);assert.equal(rangeVideo.length,9*frameBytes);
 const ink=(bytes: Buffer<ArrayBuffer>|number[],frame: number)=>{let count=0;const start=frame*frameBytes;for(let n=start;n<start+frameBytes;n++)if(bytes[n]>180)count++;return count;};
 for(let relative=0;relative<9;relative++){const global=relative+2,fullInk=ink(fullVideo,global),rangeInk=ink(rangeVideo,relative),visible=global>=4&&global<10;assert.equal(fullInk>30,visible);assert.equal(rangeInk>30,visible);assert.ok(Math.abs(fullInk-rangeInk)<15,'Caption ink remains at the same global cue across segment cuts');captionFrames.push({relativeFrame:relative,globalFrame:global,visible,wholeInk:fullInk,selectedInk:rangeInk});}
 const highSnapshot=structuredClone(wholeSnapshot);highSnapshot.timeline.clips[0].gain=2;
 const high=await captureRenderedSegments(root,'overrange',()=>renderTimeline(((highSnapshot) as unknown as Parameters<typeof renderTimeline>[0]),f.assets,path.join(root,'caption-high.mp4')));assert.equal((high.error as {code?:string}|undefined)?.code,'EXPORT_AUDIO_OVER_RANGE');const highPcm=await describe(high);assert.ok(Math.abs(peakOf(highPcm.raw)-1.4)<1e-6);
 const oldSnapshot={timeline:f.timeline,subtitleProfile,delivery:resolveTimelineExportDelivery(f.timeline,{...floatSettings,profileId:'mp4_h264_v1'})};
 const legacy=await captureRenderedSegments(root,'legacy',()=>renderTimeline(((oldSnapshot) as unknown as Parameters<typeof renderTimeline>[0]),f.assets,path.join(root,'caption-v1.mp4')));assert.ifError(legacy.error);const legacyPcm=await describe(legacy,'s16le');
 assert.equal(wholePcm.raw.length,2*legacyPcm.raw.length,'The fixed float32 stereo raw audio is exactly twice the integer16 stereo payload');
 assert.equal(hash(await readFile(f.asset.path)),f.sourceHash);assert.equal(JSON.stringify(wholeSnapshot),originalWhole);assert.equal(JSON.stringify(rangeSnapshot),originalRange);
 const evidence=path.resolve('evidence/float-checked-export');await mkdir(evidence,{recursive:true});await writeFile(path.join(evidence,'media-global-range-and-storage.json'),JSON.stringify({
  fixture:'Local 440Hz float WAV; fixed bundled subtitle font; no source mutation or second source render during precheck',sourceSha256:f.sourceHash,
  wholeSnapshotSha256:hash(Buffer.from(originalWhole)),rangeSnapshotSha256:hash(Buffer.from(originalRange)),wholeSnapshotUnchanged:true,rangeSnapshotUnchanged:true,
  exactSelectedFloatWindowEqual:true,aacComparison:{absoluteRmsTolerance:.012,windows:audioWindows},captionFrames,
  wholeFloat:wholePcm.segments,selectedFloat:selectedPcm.segments,overrangeFloat:highPcm.segments,legacyInteger:legacyPcm.segments,
  rawAudioBytes:{wholeFloat:wholePcm.raw.length,legacyInteger:legacyPcm.raw.length,ratio:2},
  storageNote:'Observed MOV sizes include video and mux overhead; raw PCM doubling is not a total temporary disk cap.',
 },null,2)+'\n');
});
