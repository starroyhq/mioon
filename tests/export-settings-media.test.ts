import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {lstatSync,readdirSync,renameSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {TIMELINE_OUTPUT_PRESETS,resolveTimelineExportDelivery,TIMELINE_SUBTITLE_PROFILE_ID,TIMELINE_SUBTITLE_FONT_SHA256} from '@mioon/contracts';
import {renderTimeline} from '../packages/business/src/timeline-media.ts';
import {run,runStreaming} from '../packages/business/src/media-runtime.ts';
import {probe} from '../packages/business/src/media.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {startWorker} from '../packages/business/src/jobs.ts';

// Synthetic local assets only. Production renderer, decoder and probe are all
// the existing installed tools; tests are deliberately serial and resource-capped.
type Json = Record<string, unknown>;
const profile={profileId:TIMELINE_SUBTITLE_PROFILE_ID,fontSha256:TIMELINE_SUBTITLE_FONT_SHA256};
type RateControl = {mode: 'crf'; quality: string} | {mode: 'bitrate'; targetKbps: number};
type Preset = {id: string; width: number; height: number; [key: string]: unknown};
type TimelineArg = Parameters<typeof renderTimeline>[0];
type AssetsArg = Parameters<typeof renderTimeline>[1];
type RenderOptions = Parameters<typeof renderTimeline>[3];
type DeliveryInput = Parameters<typeof resolveTimelineExportDelivery>[0];
type TimelineShape = {id: string; projectId: string; revision: number; fps: number; width: number; height: number; durationFrames: number; tracks: Array<{id: string; kind: string}>; clips: Array<Record<string, unknown>>; subtitles?: Record<string, unknown>};
type AssetShape = {id: string; relativePath: string; sha256: string};
type ProjectShape = {id: string};
interface LocalServices {call<T = Record<string, unknown>>(operation: string, input?: unknown): Promise<T>; drain(): Promise<unknown>}
interface LooseStore {
  get(table: string, id: string): Record<string, unknown>; put(table: string, value: unknown): void; list(table: string): Array<Record<string, unknown>>;
  db: {prepare(sql: string): {run(...values: unknown[]): unknown; get(...values: unknown[]): Record<string, unknown>; all(): Array<Record<string, unknown>>};
    exec(sql: string): void; isTransaction: boolean};
  close(): void; tx(body: () => unknown): unknown;
}
type MediaAsset = {id: string; mimeType: string; path: string; relativePath?: string; sha256?: string; width: number; height: number; duration: number; hasVideo: boolean; hasAudio: boolean; audioStreamIndex?: number; videoStreamIndex?: number};
const selected=(resolution: string,rateControl: RateControl = {mode:'crf',quality:'standard'}): {profileId: string; resolution: string; rateControl: RateControl} => ({profileId:'mp4_h264_v1',resolution,rateControl});
type ProcessEvent = Parameters<Parameters<typeof onMediaProcess>[0]>[0];
type MediaEvent = ProcessEvent;
const hash=(bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
async function sandbox(t: {after(fn: () => unknown): void}): Promise<string> {const root=await mkdtemp(path.join(tmpdir(),'mioon-export-media-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
function wave(): Buffer {
 const samples=3*48000,bytes=Buffer.alloc(44+samples*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
 bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);
 bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*4,40);
 for(let n=0;n<samples;n++)for(let channel=0;channel<2;channel++){
  const hz=n<24000?1700:channel?880:440;bytes.writeInt16LE(Math.round(7000*Math.sin(2*Math.PI*hz*n/48000)),44+n*4+channel*2);
 }
 return bytes;
}
async function binary(args: string[],maxStdoutBytes: number): Promise<Buffer> {const chunks: Buffer[]=[];const output=await runStreaming('ffmpeg',['-v','error','-threads','1',...args],{timeout:30000,maxStdoutBytes,maxStderrBytes:64*1024,onStdout:(chunk: Uint8Array)=>{chunks.push(Buffer.from(chunk));}});return Buffer.concat(chunks,output.stdoutBytes);}
const pcm=(file: string): Promise<Buffer> => binary(['-i',file,'-vn','-ac','2','-ar','48000','-c:a','pcm_s16le','-f','s16le','pipe:1'],1024*1024);
async function frames(file: string,width: number,height: number): Promise<Buffer> {return binary(['-i',file,'-vf',"select='eq(n,24)+eq(n,25)+eq(n,29)+eq(n,30)+eq(n,34)+eq(n,35)',format=gray",'-fps_mode','passthrough','-frames:v','6','-an','-threads','1','-f','rawvideo','pipe:1'],width*height*6);}
// Downscale the native render through the delivered scale filter so caption
// bounds are compared with an actual post-scale reference; thresholded glyph
// pixels do not scale perfectly linearly at small output sizes.
async function scaledFrames(file: string,width: number,height: number,flags: string): Promise<Buffer> {return binary(['-i',file,'-vf',"select='eq(n,24)+eq(n,25)+eq(n,29)+eq(n,30)+eq(n,34)+eq(n,35)',scale="+width+":"+height+":flags="+flags+',format=gray','-fps_mode','passthrough','-frames:v','6','-an','-threads','1','-f','rawvideo','pipe:1'],width*height*6);}
function whiteBounds(bytes: Buffer,width: number,height: number): {count: number; minX: number; minY: number; maxX: number; maxY: number} {
 let count=0,minX=width,minY=height,maxX=-1,maxY=-1;
 for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(bytes[y*width+x]>170){count++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
 return {count,minX,minY,maxX,maxY};
}
function rms(bytes: Buffer,from: number,to: number,channel=0): number {let sum=0;const first=Math.round(from*48000),last=Math.round(to*48000);for(let n=first;n<last;n++)sum+=(bytes.readInt16LE(n*4+channel*2)/32768)**2;return Math.sqrt(sum/(last-first));}
function tone(bytes: Buffer,from: number,to: number,hz: number,channel=0): number {let real=0,imaginary=0;const first=Math.round(from*48000),last=Math.round(to*48000);for(let n=first;n<last;n++){const value=bytes.readInt16LE(n*4+channel*2)/32768,angle=2*Math.PI*hz*n/48000;real+=value*Math.cos(angle);imaginary+=value*Math.sin(angle);}return 2*Math.hypot(real,imaginary)/(last-first);}
const withDelivery = (snapshot: unknown, delivery: unknown): TimelineArg => ({...snapshot as object, delivery} as TimelineArg);
const render = (snapshot: unknown, assets: unknown, file: string, options?: unknown) =>
  renderTimeline(snapshot as TimelineArg, assets as AssetsArg, file, options as RenderOptions);
const deliveryFor = (saved: unknown, control: {profileId: string; resolution: string; rateControl: RateControl}) =>
  resolveTimelineExportDelivery(saved as DeliveryInput, control as Parameters<typeof resolveTimelineExportDelivery>[1]);
function timeline(preset: Preset,audio: MediaAsset,image: MediaAsset): Record<string, unknown> {
 const tracks=[{id:randomUUID(),kind:'video',orderIndex:0,hidden:false,muted:false},{id:randomUUID(),kind:'audio',orderIndex:1,hidden:false,muted:false},{id:randomUUID(),kind:'audio',orderIndex:2,hidden:false,muted:true}];
 const rect={x:0,y:0,width:preset.width,height:preset.height},clip=(track: number, asset: MediaAsset, options: Record<string, unknown>) => ({id:randomUUID(),trackId:tracks[track].id,assetId:asset.id,name:'synthetic',startFrame:0,durationFrames:60,sourceInFrame:0,rect,gain:1,...options});
 return {id:randomUUID(),projectId:randomUUID(),revision:1,fps:30,width:preset.width,height:preset.height,durationFrames:60,tracks,
  clips:[clip(0,image,{rect:{x:preset.width/4,y:preset.height/4,width:preset.width/2,height:preset.height/2}}),
   clip(1,audio,{startFrame:6,durationFrames:42,sourceInFrame:15,gain:.75,fadeInFrames:12,fadeOutFrames:12}),
   // A muted clip creates a segment edge inside the cue, without contributing
   // sound. The tail extends duration to include genuine post-audio silence.
   clip(2,audio,{startFrame:30,durationFrames:30})],
  subtitles:{profileId:profile.profileId,cues:[{id:randomUUID(),text:'你好，字幕\nExport 100%',startFrame:25,durationFrames:10}]},
  createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'};
}
async function assetsAt(root: string): Promise<{audio: MediaAsset; image: MediaAsset; assets: Map<string, MediaAsset>}> {
 const audioFile=path.join(root,'source.wav'),imageFile=path.join(root,'source.png');await writeFile(audioFile,wave());
 await run('ffmpeg',['-hide_banner','-loglevel','error','-n','-f','lavfi','-i','color=c=red:s=64x64:r=30','-frames:v','1','-threads','1',imageFile],{timeout:30000,maxStdoutBytes:0,maxStderrBytes:64*1024});
 const audio={id:randomUUID(),mimeType:'audio/wav',path:audioFile,width:0,height:0,duration:3,hasVideo:false,hasAudio:true,audioStreamIndex:0};
 const image={id:randomUUID(),mimeType:'image/png',path:imageFile,width:64,height:64,duration:0,hasVideo:true,hasAudio:false,videoStreamIndex:0};
 return {audio,image,assets:new Map([[audio.id,audio],[image.id,image]] as Array<[string, MediaAsset]>)};
}
async function verifyOutput(file: string,width: number,height: number,frames=60): Promise<void> {
 const output=await probe(file) as {probe:{streams: Json[]}; duration: number}; const streams=output.probe.streams;
 const v=streams.find((stream: Json) => stream.codec_type==='video')!; const a=streams.find((stream: Json) => stream.codec_type==='audio')!;
 assert.equal(streams.length,2);assert.equal(v.codec_name,'h264');assert.equal(v.pix_fmt,'yuv420p');assert.equal(v.width,width);assert.equal(v.height,height);
 assert.equal(v.sample_aspect_ratio,'1:1');assert.equal(v.r_frame_rate,'30/1');assert.equal(v.avg_frame_rate,'30/1');assert.equal(v.time_base,'1/30000');assert.equal(v.has_b_frames,0);assert.equal(Number(v.nb_frames),frames);
 assert.equal(a.codec_name,'aac');assert.equal(a.sample_rate,'48000');assert.equal(a.channels,2);assert.equal(a.channel_layout,'stereo');assert.equal(a.time_base,'1/48000');
 assert.ok(Math.abs(Number(v.duration)-frames/30)<0.00001);assert.ok(Math.abs(Number(a.duration)-frames/30)<0.025);assert.ok(Math.abs(output.duration-frames/30)<.035);
 await run('ffmpeg',['-v','error','-threads','1','-i',file,'-map','0:v:0','-map','0:a:0','-f','null','-'],{timeout:30000,maxStdoutBytes:0,maxStderrBytes:64*1024});
 const counted=JSON.parse(await run('ffprobe',['-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=nb_read_frames','-of','json',file],{timeout:30000,maxStdoutBytes:64*1024,maxStderrBytes:64*1024})) as {streams: Array<{nb_read_frames: string}>};assert.equal(Number(counted.streams[0]!.nb_read_frames),frames);
}

test('all three timeline aspects deliver native/360/1080 with post-caption scale, exact frame boundaries and identical audio', {timeout:240000},async t=>{
 const root=await sandbox(t),{audio,image,assets}=await assetsAt(root),sourceHashes=[hash(await readFile(audio.path)),hash(await readFile(image.path))];
 let audioReference: Buffer | undefined;
 for(const preset of TIMELINE_OUTPUT_PRESETS){
  const saved=timeline(preset,audio,image),snapshot={timeline:saved,subtitleProfile:profile},frozen=structuredClone(snapshot),legacy=path.join(root,`${preset.id}-legacy.mp4`);
  let nativeFile: string | null = null;
  const events: MediaEvent[]=[],off=onMediaProcess((event: ProcessEvent)=>events.push(event));
  try{await render(snapshot,assets,legacy);}finally{off();}
  assert.equal(events.filter(event=>event.type==='started'&&event.kind==='ffmpeg').length,6,'legacy has one subtitle measurement, four original segments, one final concat, and no capability probe');
  const legacyBytes=await readFile(legacy),legacyPcm=await pcm(legacy);
  if(audioReference)assert.deepEqual(legacyPcm,audioReference);else audioReference=legacyPcm;
  let nativeBounds: {count:number;minX:number;minY:number;maxX:number;maxY:number} | undefined;
  for(const [resolution,rateControl] of ([['native',{mode:'crf',quality:'standard'}],['short_360',{mode:'crf',quality:'compact'}],['short_1080',{mode:'bitrate',targetKbps:4000}]] as Array<[string, RateControl]>)){
   const delivery=deliveryFor(saved,selected(resolution,rateControl)),file=path.join(root,`${preset.id}-${resolution}.mp4`),explicit={...snapshot,delivery};
   await render(explicit,assets,file);const {width,height}=delivery.effective;
   if(resolution==='native')nativeFile=file;
   await verifyOutput(file,width,height);
   assert.deepEqual(await pcm(file),legacyPcm,'delivery settings cannot change source trim, timeline clock, fades, gain, silence, stereo PCM or AAC');
   if(resolution==='native')assert.equal(hash(await readFile(file)),hash(legacyBytes),'explicit native/standard settings retain byte-identical default rendering');
   const pixels=await frames(file,width,height);assert.equal(pixels.length,width*height*6);
   const bounds=[];
   for(let frame=0;frame<6;frame++){
    const buffer=pixels.subarray(frame*width*height,(frame+1)*width*height),box=whiteBounds(buffer,width,height);bounds.push(box);
    if(frame===0||frame===5)assert.equal(box.count,0,'half-open global cue must be absent at frames 24 and 35');else assert.ok(box.count>30,'cue must be present at 25,29,30,34 across the segment edge');
    assert.ok(buffer[Math.floor(height/2)*width+Math.floor(width/2)]>40,'original composition rectangle remains in the scaled center');
    assert.ok(buffer[Math.floor(height/8)*width+Math.floor(width/8)]<8,'outside composition remains black');
   }
   if(resolution==='native')nativeBounds=bounds[1];
   else{
    const reference=await scaledFrames(nativeFile!,width,height,delivery.effective.scaling);
    const referenceBox=whiteBounds(reference.subarray(width*height,2*width*height),width,height);
    for(const key of ['minX','minY','maxX','maxY'] as const)assert.ok(Math.abs((bounds[1] as Record<typeof key, number>)[key]-(referenceBox as Record<typeof key, number>)[key])<=3,`${preset.id} ${resolution}: caption geometry must scale after composition (${key})`);
   }
   assert.deepEqual(snapshot,frozen);assert.deepEqual(explicit.delivery,delivery);
  }
 }
 // Independently verify the unchanged decoded envelope and source trim, rather
 // than relying solely on equality between outputs sharing an audio graph.
 assert.ok(rms(audioReference!,.02,.15)<.002);assert.ok(rms(audioReference!,1.75,1.95)<.002);
 const plateau=tone(audioReference!,.7,.9,440),early=tone(audioReference!,.25,.3,440),late=tone(audioReference!,1.5,1.55,440);
 assert.ok(plateau>.13&&plateau<.19);assert.ok(early/plateau>.08&&early/plateau<.3);assert.ok(late/plateau>.08&&late/plateau<.3);
 assert.ok(tone(audioReference!,.7,.9,1700)<.002,'nonzero sourceInFrame removes the source preamble');
 assert.ok(tone(audioReference!,.7,.9,880,1)>.13);assert.ok(tone(audioReference!,.7,.9,880,0)<.002);
 assert.deepEqual([hash(await readFile(audio.path)),hash(await readFile(image.path))],sourceHashes);
 assert.equal((await readdir(root)).some(name=>name.startsWith('.timeline-render-')),false);
});

test('remaining fixed quality/bitrate selections encode and malformed frozen delivery fails before media I/O', {timeout:90000},async t=>{
 const root=await sandbox(t),{audio,image,assets}=await assetsAt(root),saved=timeline(TIMELINE_OUTPUT_PRESETS[2],audio,image);
 delete saved.subtitles;const snapshot={timeline:saved};
 for(const [index,rateControl] of ([{mode:'crf',quality:'high'},{mode:'bitrate',targetKbps:2000},{mode:'bitrate',targetKbps:8000}] as RateControl[]).entries()){
  const delivery=deliveryFor(saved,selected('short_360',rateControl as RateControl)),file=path.join(root,`rate-${index}.mp4`);
  await render(withDelivery(snapshot,delivery),assets,file);await verifyOutput(file,360,360);
 }
 // A target bitrate controls encoder intent; short synthetic clips are not
 // expected to attain an exact average bitrate and no such claim is asserted.
 const good=deliveryFor(saved,selected('native')),events: ProcessEvent[]=[],off=onMediaProcess((event: ProcessEvent)=>events.push(event));
 try{
  for(const delivery of [null,undefined,{...good,effective:{...good.effective,width:good.effective.width+2}},{...good,effective:{...good.effective,rateControl:{mode:'crf',crf:0}}},{...good,effective:{...good.effective,extra:'-filter_complex'}}])
   await assert.rejects(render(withDelivery(snapshot,delivery),assets,path.join(root,'invalid.mp4')),{code:'INVALID_TIMELINE_SNAPSHOT'});
  assert.deepEqual(events,[]);assert.equal((await readdir(root)).includes('invalid.mp4'),false);
 }finally{off();}
});

test('cancellation during a selected-profile worker capability leaves no render scratch or destination',async t=>{
 const root=await sandbox(t),{audio,image,assets}=await assetsAt(root),saved=timeline(TIMELINE_OUTPUT_PRESETS[0],audio,image),delivery=deliveryFor(saved,selected('short_1080'));
 const controller=new AbortController(),events: ProcessEvent[]=[],off=onMediaProcess((event: ProcessEvent)=>{events.push(event);if(event.type==='started')controller.abort();});
 try{await assert.rejects(render(withDelivery({timeline:saved,subtitleProfile:profile},delivery),assets,path.join(root,'cancelled.mp4'),{signal:controller.signal}),{code:'MEDIA_CANCELLED'});}finally{off();}
 assert.equal(events.filter(event=>event.type==='started').length,1);assert.equal(events.filter(event=>event.type==='exited').length,1);
 assert.equal((await readdir(root)).some(name=>name.startsWith('.timeline-render-')||name==='cancelled.mp4'),false);
});

test('fresh worker capability is followed by the owner fence before any subtitle work, scratch or encoding',async t=>{
 const root=await sandbox(t),{audio,image,assets}=await assetsAt(root),saved=timeline(TIMELINE_OUTPUT_PRESETS[0],audio,image),delivery=deliveryFor(saved,selected('short_360'));
 const events: MediaEvent[]=[],off=onMediaProcess((event: ProcessEvent)=>events.push(event));let fenced=false;
 try{
  await assert.rejects(render(withDelivery({timeline:saved,subtitleProfile:profile},delivery),assets,path.join(root,'stale.mp4'),{beforeEncode(){
   fenced=true;assert.equal(events.filter(event=>event.type==='started').length,2);assert.equal(events.filter(event=>event.type==='exited').length,2);
   throw Object.assign(Error('Saved export changed while capability was checked.'),{code:'INVALID_TIMELINE_SNAPSHOT'});
  }}),{code:'INVALID_TIMELINE_SNAPSHOT'});
 }finally{off();}
 assert.equal(fenced,true);assert.equal(events.filter(event=>event.type==='started').length,2);
 assert.equal((await readdir(root)).some(name=>name.startsWith('.timeline-render-')||name==='stale.mp4'),false);
});

test('worker capability await cannot encode or overwrite a hostile replacement of the accepted delivery record',{timeout:30000},async t=>{
 const root=await sandbox(t),workspace=path.join(root,'workspace'),store=openStore(workspace) as unknown as LooseStore,services=createServices(store as unknown as Parameters<typeof createServices>[0],new Map()) as unknown as LocalServices;let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
 try{
  const project=await services.call<ProjectShape>('project.create',{name:'Synthetic worker capability race'});
  let timeline=await services.call<TimelineShape>('timeline.get',{projectId:project.id});
  const asset=await services.call<AssetShape>('asset.import',{projectId:project.id,name:'tone.wav',mimeType:'audio/wav',dataBase64:wave().toString('base64')});
  timeline=await services.call<TimelineShape>('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),trackId:timeline.tracks.find((track: {kind: string; id: string}) => track.kind==='audio')!.id,assetId:asset.id,startFrame:0,durationFrames:30});
  const input={projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export',exportSettings:selected('native')};
  const accepted=await services.call<ProjectShape>('timeline.render',input),receipt=store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response;
  // The production trigger prevents this write. Dropping only this trigger is
  // a hostile-corruption simulation to test the independent asynchronous fence.
  store.db.exec('DROP TRIGGER immutable_timeline_render_snapshot');
  const mediaDirectory=path.join(workspace,'media'),filesBefore=(await readdir(mediaDirectory)).sort();
  let ffmpegStarts=0; let replacement: {snapshot: {delivery: unknown; timeline?: unknown}; [key: string]: unknown} | undefined; let ownedPart: {name: string; dev: number; ino: number} | undefined; let observerFailure: unknown; const events: ProcessEvent[]=[];
  const off=onMediaProcess((event: ProcessEvent)=>{
   events.push(event);
   if(event.type==='started'&&event.kind==='ffmpeg'&&++ffmpegStarts===2){
    try{
     const parts=readdirSync(mediaDirectory).filter(name=>new RegExp(`^export-${accepted.id}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.mp4\\.part\\.mp4$`).test(name));
     assert.equal(parts.length,1);const identity=lstatSync(path.join(mediaDirectory,parts[0]));assert.equal(identity.isFile(),true);assert.equal(identity.size,0);
     ownedPart={name:parts[0],dev:identity.dev,ino:identity.ino};
     replacement=store.get('exports',accepted.id) as unknown as {snapshot: {delivery: unknown; timeline?: unknown}; [key: string]: unknown};replacement.snapshot.delivery=deliveryFor(replacement.snapshot.timeline as unknown,selected('short_360'));store.put('exports',replacement as unknown as Parameters<typeof store.put>[1]);
    }
    catch(error){observerFailure=error;}
   }
  });
  try{worker=startWorker(store as unknown as Parameters<typeof startWorker>[0],services as unknown as Parameters<typeof startWorker>[1],new Map());await worker.tick();}finally{off();}
  assert.equal(observerFailure,undefined);assert.ok(replacement,'record was replaced during the real selected-profile encode proof');
  assert.equal(ffmpegStarts,2,'worker stopped after listing + synthetic proof, before rendering');
  assert.deepEqual(store.get('exports',accepted.id),replacement,'failed owner fence cannot overwrite the newer persisted record');
  assert.equal(store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response,receipt);
  // 01a83cb acquires the part before capability checking and preserves it when
  // the accepted record's identity is lost; this never permits deleting a newer record's output.
  assert.ok(ownedPart);assert.deepEqual((await readdir(mediaDirectory)).sort(),[...filesBefore,ownedPart.name].sort(),'only this attempt\'s known empty part may remain; no final output or render scratch');
  const preservedPart=lstatSync(path.join(mediaDirectory,ownedPart.name));assert.equal(preservedPart.isFile(),true);assert.equal(preservedPart.size,0);assert.equal(preservedPart.nlink,1);
  assert.deepEqual({dev:preservedPart.dev,ino:preservedPart.ino},{dev:ownedPart.dev,ino:ownedPart.ino},'conservative cleanup preserves the exact original staging inode');
  assert.equal(events.filter(event=>event.type==='started').length,events.filter(event=>event.type==='exited').length);
 }finally{await worker?.stop();await services.drain();store.close();}
});

async function sourceOwnershipRace(t: {mock: {method(target: object, name: string, fn: (...args: unknown[]) => unknown): void}; after(fn: () => unknown): void}, {mutation, phase='capability'}: {mutation: string; phase?: string}): Promise<void> {
 const root=await sandbox(t),workspace=path.join(root,'workspace'),store=openStore(workspace) as unknown as LooseStore,services=createServices(store as unknown as Parameters<typeof createServices>[0],new Map()) as unknown as LocalServices;let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
 const state=(): Record<string, Record<string, unknown>[]>=>Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='exports' ORDER BY name").all().map(({name})=>[name,store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
 try{
  const project=await services.call<ProjectShape>('project.create',{name:'Synthetic frozen-source race'}),other=await services.call<ProjectShape>('project.create',{name:'Private foreign fixture'});
  const imported=await services.call<AssetShape>('asset.import',{projectId:project.id,name:'tone.wav',mimeType:'audio/wav',dataBase64:wave().toString('base64')});
  const asset: AssetShape & Record<string, unknown> = {...store.get('assets',imported.id),provenance:'generated'} as unknown as AssetShape & Record<string, unknown>;store.put('assets',asset);
  const shot=await services.call<ProjectShape>('shot.create',{projectId:project.id,title:'Synthetic retained lineage'}),foreignShot=await services.call<ProjectShape>('shot.create',{projectId:other.id,title:'Untouched foreign shot'});
  const jobId=randomUUID(),versionId=randomUUID(),sourceSnapshot={projectId:project.id,shotId:shot.id,referenceAssetIds:[],referenceAssets:[]};
  store.put('jobs',{id:jobId,projectId:project.id,shotId:shot.id,versionId,assetId:asset.id,status:'succeeded',providerId:'mock',requestId:randomUUID(),snapshot:sourceSnapshot});
  store.put('versions',{id:versionId,projectId:project.id,shotId:shot.id,jobId,assetId:asset.id,sha256:asset.sha256,number:1,snapshot:sourceSnapshot});
  store.put('shots',{...shot,selectedVersionId:versionId});
  let timeline=await services.call<TimelineShape>('timeline.get',{projectId:project.id});
  timeline=await services.call<TimelineShape>('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),trackId:timeline.tracks.find((track: {kind: string; id: string}) => track.kind==='audio')!.id,assetId:asset.id,startFrame:0,durationFrames:3});
  // Retained historical lineage is validated independently of the asset's
  // provenance label, including every version/job/shot reverse relation.
  Object.assign(timeline.clips[0],{versionId,jobId,shotId:shot.id});store.put('timelines', timeline as unknown as Parameters<typeof store.put>[1]);
  const input={projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export',exportSettings:selected('short_360')};
  const accepted=await services.call<ProjectShape>('timeline.render',input),receipt=store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response;
  const acceptedSnapshot=store.get('exports',accepted.id).snapshot;
  const sourceFile=path.join(workspace,asset.relativePath),sourceHash=hash(await readFile(sourceFile)),files=(await readdir(path.join(workspace,'media'))).sort();
  // The normal version trigger rejects this corruption; remove only that
  // fixture-local protection when testing the independent retained-graph fence.
  if(mutation==='version-sql-owner')store.db.exec('DROP TRIGGER immutable_versions');
  let moved=false; let afterMutation: ReturnType<typeof state> | undefined; let observerFailure: unknown; let ffmpegStarts=0,probeExits=0; let publicationArmed=false,linkedBeforeTx=false; let replacementFile: string | undefined,preservedFile: string | undefined; let replacementIdentity: {dev: number; ino: number} | undefined; let readUncertain=false,readFailureObserved=false; const events: MediaEvent[]=[];
  const replacementBytes=Buffer.from('Different fixture-owned inode must be preserved.');
  const prepare=store.db.prepare;
  if(phase==='publication-read-unknown')t.mock.method(store.db,'prepare',(function(this: unknown, sql: string, ...args: unknown[]){
   if(readUncertain&&!store.db.isTransaction&&sql.includes('FROM exports WHERE id=?')){
    readUncertain=false;readFailureObserved=true;throw Error('Synthetic private cleanup-read failure.');
   }
   return (prepare.call as (thisArg: unknown, sql: string, ...values: unknown[]) => unknown)(this, sql, ...args) as never;
  }) as (...args: unknown[]) => unknown);
  const patch=(table: string, id: string, values: Record<string, unknown>)=>store.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify({...store.get(table,id),...values}),id);
  const move=(): void => {
   if(moved)return;moved=true;
   try{
    if(mutation==='asset-sql-owner')store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(other.id,asset.id);
    else if(mutation==='asset-json-owner')patch('assets',asset.id,{projectId:other.id});
    else if(mutation==='version-sql-owner')store.db.prepare('UPDATE versions SET projectId=? WHERE id=?').run(other.id,versionId);
    else if(mutation==='job-lineage')patch('jobs',jobId,{shotId:foreignShot.id});
    else if(mutation==='shot-sql-owner')store.db.prepare('UPDATE shots SET projectId=? WHERE id=?').run(other.id,shot.id);
    else if(mutation==='asset-hash')patch('assets',asset.id,{sha256:'b'.repeat(64)});
    else if(mutation==='asset-mime')patch('assets',asset.id,{mimeType:'audio/mp4'});
    else if(mutation==='asset-path')patch('assets',asset.id,{relativePath:'media/foreign-owned-unread.wav'});
    else throw Error('Unknown synthetic source race');
    afterMutation=state();
   }catch(error){observerFailure=error;}
  };
  const originalTx=store.tx;
  const publicationPhase=['publication-tx','publication-replacement','publication-read-unknown'].includes(phase);
  if(publicationPhase)store.tx=body=>{if(publicationArmed){
   publicationArmed=false;
   const linked=readdirSync(path.join(workspace,'media')).find(name=>name.startsWith(`export-${accepted.id}-`)&&name.endsWith('.mp4')&&!name.endsWith('.part.mp4'));
   linkedBeforeTx=Boolean(linked);
   if(linked&&phase==='publication-replacement'){
    replacementFile=path.join(workspace,'media',linked);
    const originalIdentity=lstatSync(replacementFile);
    // Create while the original inode is still live, then atomically replace
    // the name; this avoids accidental same-inode reuse in the fixture.
    const fresh=replacementFile+'.replacement';writeFileSync(fresh,replacementBytes,{flag:'wx',mode:0o600});renameSync(fresh,replacementFile);
    const replaced=lstatSync(replacementFile);replacementIdentity={dev:replaced.dev,ino:replaced.ino};assert.notDeepEqual(replacementIdentity,{dev:originalIdentity.dev,ino:originalIdentity.ino});
   }
   if(linked&&phase==='publication-read-unknown')preservedFile=path.join(workspace,'media',linked);
   move();
   if(phase==='publication-read-unknown')readUncertain=true;
  }return originalTx(body);};
  const off=onMediaProcess((event: ProcessEvent)=>{
   events.push(event);
   if(event.type==='started'&&event.kind==='ffmpeg'&&++ffmpegStarts===2&&phase==='capability')move();
   // Source probe, renderer verification, then final fileInfo probe. The third
   // observed close happens before the await resumes at publication admission.
   if(event.type==='exited'&&event.kind==='ffprobe'&&++probeExits===3){
    if(phase==='prepublication')move();
    if(publicationPhase)publicationArmed=true;
   }
  });
  try{worker=startWorker(store as unknown as Parameters<typeof startWorker>[0],services as unknown as Parameters<typeof startWorker>[1],new Map());await worker.tick();}finally{off();}
  assert.equal(observerFailure,undefined);assert.equal(moved,true,`${mutation} raced at ${phase}`);
  if(publicationPhase)assert.equal(linkedBeforeTx,true,'ownership changed after this task linked its output and immediately before the real publication transaction');
  assert.ok(afterMutation);
  const isAcceptedExport=(row: Record<string, unknown>)=>row.projectId===project.id&&row.kind==='export'&&row.targetId===accepted.id;
  assert.equal(afterMutation.agent_task_target_revisions_v2.filter(isAcceptedExport).length,1);
  // Failing this accepted export persists one terminal status transition. Its
  // exact target advances once; every source, foreign target and receipt stays fixed.
  const expectedState={...afterMutation,agent_task_target_revisions_v2:afterMutation.agent_task_target_revisions_v2.map(row=>
   isAcceptedExport(row)?Object.assign(Object.create(Object.getPrototypeOf(row)),row,{revision:Number(row.revision)+1}):row)};
  assert.deepEqual(state(),expectedState,'worker cannot change source, lineage, foreign records, or receipts after ownership drift');
  // 01a83cb applies the owned-output inode fence to every export. A replaced
  // output is refused before the subsequent frozen-source ownership check.
  const rejected=store.get('exports',accepted.id);assert.equal(rejected.status,'failed');assert.equal((rejected.error as {code?: string}).code,phase==='publication-replacement'?'INVALID_TIMELINE_SNAPSHOT':'TIMELINE_SOURCE_UNAVAILABLE');
  assert.equal(rejected.assetId,null);assert.equal(rejected.url,null);assert.deepEqual(rejected.snapshot,acceptedSnapshot);
  assert.equal(JSON.stringify(rejected.error).includes(other.id),false);assert.equal(JSON.stringify(rejected.error).includes(foreignShot.id),false);assert.equal(JSON.stringify(rejected.error).includes(workspace),false);
  assert.equal(store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response,receipt);
  assert.equal(ffmpegStarts,phase==='capability'?2:4,phase==='capability'?'no timeline encode after capability source drift':'render completed before publication source drift');
  if(phase==='publication-replacement'){
   assert.ok(replacementFile);assert.deepEqual(await readFile(replacementFile),replacementBytes,'cleanup must refuse a replacement inode after the output identity fence rejects publication');
   const preserved=lstatSync(replacementFile);assert.deepEqual({dev:preserved.dev,ino:preserved.ino},replacementIdentity,'cleanup must preserve the replacement inode itself');
   assert.deepEqual((await readdir(path.join(workspace,'media'))).sort(),[...files,path.basename(replacementFile)].sort());
  }else if(phase==='publication-read-unknown'){
   assert.equal(readFailureObserved,true);assert.ok(preservedFile);
   await verifyOutput(preservedFile,360,640,3);
   assert.deepEqual((await readdir(path.join(workspace,'media'))).sort(),[...files,path.basename(preservedFile)].sort(),'uncertain publication ownership must preserve the linked output');
  }else assert.deepEqual((await readdir(path.join(workspace,'media'))).sort(),files,'no render scratch, partial file, orphan publication, or output asset may remain');
  assert.equal(hash(await readFile(sourceFile)),sourceHash);
  assert.equal(events.filter(event=>event.type==='started').length,events.filter(event=>event.type==='exited').length);
 }finally{await worker?.stop();await services.drain();store.close();}
}

test('worker rechecks frozen source ownership, retained lineage and identity after the actual capability await',{timeout:45000},async t=>{
 for(const mutation of ['asset-sql-owner','asset-json-owner','version-sql-owner','job-lineage','shot-sql-owner','asset-hash','asset-mime','asset-path'])
  await t.test(mutation,t=>sourceOwnershipRace(t,{mutation}));
});

test('worker publication guards remove only known unpublished output and preserve replaced or uncertain files',{timeout:20000},async t=>{
 for(const phase of ['prepublication','publication-tx','publication-replacement','publication-read-unknown'])await t.test(phase,t=>sourceOwnershipRace(t,{mutation:'asset-sql-owner',phase}));
});

test('postcommit publication exception preserves the successful custom export and its exact owned output',{timeout:20000},async t=>{
 const root=await sandbox(t),workspace=path.join(root,'workspace'),store=openStore(workspace) as unknown as LooseStore,services=createServices(store as unknown as Parameters<typeof createServices>[0],new Map()) as unknown as LocalServices;let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
 try{
  const project=await services.call<ProjectShape>('project.create',{name:'Synthetic committed publication'});
  const asset=await services.call<AssetShape>('asset.import',{projectId:project.id,name:'tone.wav',mimeType:'audio/wav',dataBase64:wave().toString('base64')});
  let timeline=await services.call<TimelineShape>('timeline.get',{projectId:project.id});
  timeline=await services.call<TimelineShape>('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),trackId:timeline.tracks.find((track: {kind: string; id: string}) => track.kind==='audio')!.id,assetId:asset.id,startFrame:0,durationFrames:3});
  const input={projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export',exportSettings:selected('short_360')};
  const accepted=await services.call<ProjectShape>('timeline.render',input),receipt=store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response;
  const originalTx=store.tx;let probeExits=0,armed=false,injected=false; let committed: Record<string, unknown> | undefined; let committedAsset: Record<string, unknown> | undefined;
  store.tx=body=>{
   if(!armed)return originalTx(body);
   armed=false;const result=originalTx(body);committed=store.get('exports',accepted.id);committedAsset=store.get('assets',String(committed.assetId));injected=true;
   throw Object.assign(Error('Synthetic acknowledgement failure after successful commit.'),{code:'SYNTHETIC_POSTCOMMIT_FAILURE'});
  };
  const events: ProcessEvent[]=[],off=onMediaProcess((event: ProcessEvent)=>{events.push(event);if(event.type==='exited'&&event.kind==='ffprobe'&&++probeExits===3)armed=true;});
  try{worker=startWorker(store as unknown as Parameters<typeof startWorker>[0],services as unknown as Parameters<typeof startWorker>[1],new Map());await worker.tick();}finally{off();}
  assert.equal(injected,true);assert.equal(committed!.status,'succeeded');assert.equal(committed!.error,null);
  assert.deepEqual(store.get('exports',accepted.id),committed,'postcommit exception cannot downgrade an already published success');
  assert.deepEqual(store.get('assets',String(committed!.assetId)),committedAsset);assert.equal(store.list('assets').length,2);
  assert.equal(store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response,receipt);
  const file=path.join(workspace,String(committedAsset!.relativePath));assert.equal(hash(await readFile(file)),committedAsset!.sha256);await verifyOutput(file,360,640,3);
  assert.equal((await readdir(path.join(workspace,'media'))).some(name=>name.startsWith('.timeline-render-')||name.endsWith('.part.mp4')),false);
  assert.equal(events.filter(event=>event.type==='started').length,events.filter(event=>event.type==='exited').length);
 }finally{await worker?.stop();await services.drain();store.close();}
});
