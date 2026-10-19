import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {renderTimeline} from '../packages/business/src/timeline-media.ts';
import {run,runStreaming} from '../packages/business/src/media-runtime.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {timelineAudioFadeFilters} from '../packages/business/src/timeline-audio.ts';
import {planTimelineExportRange} from '../packages/business/src/timeline-export-range-plan.ts';
import {TIMELINE_OUTPUT_PRESETS,resolveTimelineExportDelivery,TIMELINE_SUBTITLE_PROFILE_ID,TIMELINE_SUBTITLE_FONT_SHA256} from '@mioon/contracts';

// Synthetic local sources only. These tests use the production renderer and
// serialize real media work; no provider, GPU or platform application is used.
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const ffmpeg=args=>run('ffmpeg',['-hide_banner','-loglevel','error','-n','-threads','1','-filter_complex_threads','1','-filter_threads','1',...args],{timeout:90000,maxStdoutBytes:0,maxStderrBytes:64*1024});
async function sandbox(t){const root=await mkdtemp(path.join(tmpdir(),'mioon-range-media-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function binary(args,maximum=2*1024*1024){const chunks=[];const result=await runStreaming('ffmpeg',['-v','error','-threads','1','-filter_threads','1','-filter_complex_threads','1',...args],{timeout:30000,maxStdoutBytes:maximum,maxStderrBytes:64*1024,onStdout:chunk=>chunks.push(Buffer.from(chunk))});return Buffer.concat(chunks,result.stdoutBytes);}
const video=(file,scale=1)=>binary(['-i',file,'-an','-vf',`crop=${128*scale}:${96*scale}:${40*scale}:${40*scale},scale=32:24,format=rgb24`,'-fps_mode','passthrough','-threads','1','-f','rawvideo','pipe:1']);
const audio=file=>binary(['-i',file,'-vn','-ac','2','-ar','48000','-c:a','pcm_f32le','-f','f32le','pipe:1']);
function wave(rate=44100,seconds=4){
 const samples=rate*seconds,bytes=Buffer.alloc(44+samples*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
 bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);
 bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*2,40);
 for(let n=0;n<samples;n++)bytes.writeInt16LE(Math.round((.12+.02*n/rate)*Math.sin(2*Math.PI*697*n/rate)*32767),44+n*2);
 return bytes;
}
async function phaseSources(root,rate='24',extra=[]){
 const raw=path.join(root,`frames-${rate.replace('/','-')}.rgb`),file=path.join(root,`video-${rate.replace('/','-')}.mp4`),wav=path.join(root,'tone.wav');
 const bytes=Buffer.alloc(96*64*48*3);
 for(let n=0;n<96;n++)for(let at=n*64*48*3;at<(n+1)*64*48*3;at+=3)bytes.set([(n*67)%200+30,(n*97)%200+30,(n*43)%200+30],at);
 await writeFile(raw,bytes);await writeFile(wav,wave());
 await ffmpeg(['-f','rawvideo','-pixel_format','rgb24','-video_size','64x48','-framerate',rate,'-i',raw,'-an','-c:v','libx264','-preset','ultrafast','-crf','12','-threads','1','-pix_fmt','yuv420p',...extra,file]);
 const visual={id:randomUUID(),path:file,mimeType:'video/mp4',duration:3,width:64,height:48,hasVideo:true,hasAudio:false,videoStreamIndex:0};
 const sound={id:randomUUID(),path:wav,mimeType:'audio/wav',duration:4,width:0,height:0,hasVideo:false,hasAudio:true,audioStreamIndex:0};
 return {visual,sound,assets:new Map([[visual.id,visual],[sound.id,sound]])};
}
function snapshotFor({visual,sound},width=720,height=720){
 const tracks=[{id:randomUUID(),kind:'video',orderIndex:0,hidden:false,muted:false},{id:randomUUID(),kind:'audio',orderIndex:1,hidden:false,muted:false}];
 const clip=(index,asset,patch={})=>({id:randomUUID(),trackId:tracks[index].id,assetId:asset.id,name:'Synthetic phase fixture',startFrame:0,durationFrames:75,sourceInFrame:7,rect:{x:40,y:40,width:128,height:96},gain:.75,...patch});
 return {timeline:{id:randomUUID(),projectId:randomUUID(),revision:1,fps:30,width,height,durationFrames:75,tracks,
  clips:[clip(0,visual),clip(1,sound,{fadeInFrames:30,fadeOutFrames:30})],createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'}};
}
async function verify(file,count,width=720,height=720){
 const data=JSON.parse(await run('ffprobe',['-v','error','-count_frames','-show_streams','-show_format','-of','json',file],{timeout:30000,maxStdoutBytes:128*1024,maxStderrBytes:64*1024}));
 const v=data.streams.find(stream=>stream.codec_type==='video'),a=data.streams.find(stream=>stream.codec_type==='audio');
 assert.equal(data.streams.length,2);assert.equal(v.codec_name,'h264');assert.equal(v.width,width);assert.equal(v.height,height);assert.equal(v.r_frame_rate,'30/1');assert.equal(v.avg_frame_rate,'30/1');
 assert.equal(Number(v.nb_frames),count);assert.equal(Number(v.nb_read_frames),count);assert.equal(v.start_pts,0);assert.equal(Number(v.start_time),0);assert.ok(Math.abs(Number(v.duration)-count/30)<.00001);
 assert.equal(a.codec_name,'aac');assert.equal(a.sample_rate,'48000');assert.equal(a.channels,2);assert.equal(a.start_pts,0);assert.equal(Number(a.start_time),0);assert.ok(Math.abs(Number(a.duration)-count/30)<.025);assert.ok(Math.abs(Number(data.format.duration)-count/30)<.035);
 const timestamps=JSON.parse(await run('ffprobe',['-v','error','-select_streams','v:0','-show_entries','frame=pts','-of','json',file],{timeout:30000,maxStdoutBytes:128*1024,maxStderrBytes:64*1024}));
 assert.deepEqual(timestamps.frames.map(frame=>frame.pts),Array.from({length:count},(_,index)=>index*1000));
 await run('ffmpeg',['-v','error','-threads','1','-i',file,'-f','null','-'],{timeout:30000,maxStdoutBytes:0,maxStderrBytes:64*1024});
 return data;
}
function compareVideo(reference,selected,start,end){
 const frameBytes=32*24*3;assert.equal(selected.length,(end-start)*frameBytes);let worst=0,total=0;
 for(let n=0;n<end-start;n++){
  let error=0;for(let at=0;at<frameBytes;at++)error+=Math.abs(reference[(start+n)*frameBytes+at]-selected[n*frameBytes+at]);
  const mae=error/frameBytes;worst=Math.max(worst,mae);total+=mae;assert.ok(mae<3,`Frame ${start+n}: RGB MAE ${mae} exceeds lossy tolerance`);
 }
 assert.ok(total/(end-start)<1,`Mean RGB error ${total/(end-start)}`);return {worst,mean:total/(end-start)};
}
/** A one-frame range render is an independent IDR encode of the same canvas
 * frame the full stream codes as a predicted frame, so decoded pixels cannot be
 * byte-equal. Measure the codec's own single-frame round-trip error for this
 * exact frame and require the range frame to stay within that intrinsic bound;
 * the per-frame RGB bound above still rejects timing/layout mistakes. */
async function compareSingleFrame(reference,selected,frame,root){
 const size=32*24*3,expected=reference.subarray(frame*size,(frame+1)*size),raw=path.join(root,`single-reference-${randomUUID()}.rgb`),file=path.join(root,`single-reference-${randomUUID()}.mp4`);
 await writeFile(raw,expected);
 await ffmpeg(['-f','rawvideo','-pixel_format','rgb24','-video_size','32x24','-framerate','30','-i',raw,'-frames:v','1','-c:v','libx264','-preset','veryfast','-crf','23','-threads','2','-bf','0','-g','60','-pix_fmt','yuv420p','-r','30',file]);
 const roundTrip=await binary(['-i',file,'-an','-vf','format=rgb24','-fps_mode','passthrough','-f','rawvideo','pipe:1'],size);let noise=0;for(let at=0;at<size;at++)noise+=Math.abs(expected[at]-roundTrip[at]);
 const bound=noise/size;assert.ok(selected.length>=size);
 let total=0;for(let at=0;at<size;at++)total+=Math.abs(expected[at]-selected[at]);
 const mean=total/size;assert.ok(mean<=bound,`Single-frame range error ${mean} exceeds the measured single-frame codec round-trip ${bound}`);
 return {mean,bound};
}
function markerColors(bytes,frame){
 return [[4,4],[16,12],[28,20]].map(([x,y])=>{
  const color=[0,0,0];for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)for(let channel=0;channel<3;channel++)
   color[channel]+=bytes[frame*32*24*3+((y+dy)*32+x+dx)*3+channel]/9;
  return color.map(value=>Math.round(value*100)/100);
 });
}
function frameMae(reference,selected,referenceFrame,selectedFrame=0){
 const size=32*24*3;let sum=0;for(let at=0;at<size;at++)sum+=Math.abs(reference[referenceFrame*size+at]-selected[selectedFrame*size+at]);return sum/size;
}
function compareSourceMarkers(reference,selected,expectedFrames,palette){
 let worstSourceError=0,worstMaskMismatch=0,worstMae=0,nearestWrongFrameMargin=Infinity;
 const closest=color=>palette.reduce((best,entry,index)=>{
  const error=entry.reduce((sum,value,channel)=>sum+(value-color[channel])**2,0);return error<best.error?{index,error}:best;
 },{index:-1,error:Infinity}).index;
 for(let frame=0;frame<expectedFrames.length;frame++){
  for(const [pixels,at] of [[reference,frame+24],[selected,frame]]){
   const markers=markerColors(pixels,at);
   for(let marker=0;marker<3;marker++)for(let channel=0;channel<3;channel++){
    const error=Math.abs(markers[marker][channel]-expectedFrames[frame][marker][channel]);worstSourceError=Math.max(worstSourceError,error);
    assert.ok(error<20,`Frame ${frame+24}, marker ${marker}: source color differs by ${error}`);
   }
  }
  let mismatches=0;
  for(let pixel=0;pixel<32*24;pixel++){
   const a=(frame+24)*32*24*3+pixel*3,b=frame*32*24*3+pixel*3;
   if(closest(reference.subarray(a,a+3))!==closest(selected.subarray(b,b+3)))mismatches++;
  }
  const mismatch=mismatches/(32*24);worstMaskMismatch=Math.max(worstMaskMismatch,mismatch);
  assert.ok(mismatch<.03,`Frame ${frame+24}: source-color composition masks differ over ${mismatch*100}% of pixels`);
  worstMae=Math.max(worstMae,frameMae(reference,selected,frame+24,frame));
  for(const neighbor of [frame-1,frame+1])if(neighbor>=0&&neighbor<expectedFrames.length&&JSON.stringify(expectedFrames[neighbor])!==JSON.stringify(expectedFrames[frame])){
   const wrong=markerColors(reference,neighbor+24);let error=0;
   for(let marker=0;marker<3;marker++)for(let channel=0;channel<3;channel++)error=Math.max(error,Math.abs(wrong[marker][channel]-expectedFrames[frame][marker][channel]));
   nearestWrongFrameMargin=Math.min(nearestWrongFrameMargin,error-20);
  }
 }
 assert.ok(nearestWrongFrameMargin>20,'a neighboring distinct source frame must miss the marker bound by more than 20 color levels');
 return {worstSourceError,worstMaskMismatch,worstMae,nearestWrongFrameMargin};
}
async function sourceMarker(file,anchorFrame,localFrame){
 const bytes=await binary(['-ss',(anchorFrame/30).toFixed(9),'-i',file,'-an','-vf',`setpts=PTS-STARTPTS,fps=30,select='eq(n,${localFrame})',scale=1:1,format=rgb24`,'-frames:v','1','-threads','1','-f','rawvideo','pipe:1']);
 assert.equal(bytes.length,3);return [...bytes];
}
/** Independently encode the exact reference slice with the same final AAC settings
 * and alignment as the range render before comparing. A range stream starts its
 * encoder at the selected first sample, while the full render's corresponding
 * samples sit mid-stream; comparing those decoded streams directly measures AAC
 * onset alignment rather than renderer parity. Encoding the reference slice
 * through the identical path keeps this a strict (unchanged RMSE budget) parity
 * check of the selected PCM. */
async function compareAudio(reference,selected,start,end,root){
 const count=(end-start)*1600,offset=start*1600;assert.ok(selected.length>=count*8);assert.ok(reference.length>=(offset+count)*8);
 const raw=path.join(root,`reference-${randomUUID()}.f32le`),file=path.join(root,`reference-${randomUUID()}.mp4`);
 await writeFile(raw,reference.subarray(offset*8,(offset+count)*8));
 await ffmpeg(['-f','f32le','-ar','48000','-ac','2','-i',raw,'-af',`apad,atrim=end_sample=${count},asetpts=N/SR/TB`,'-c:a','aac','-b:a','128k','-ar','48000','-ac','2','-t',((end-start)/30).toFixed(9),'-movflags','+faststart',file]);
 const expected=await audio(file);
 let sum=0,peak=0;for(let n=0;n<count;n++)for(let c=0;c<2;c++){
  const delta=expected.readFloatLE(n*8+c*4)-selected.readFloatLE(n*8+c*4);sum+=delta*delta;peak=Math.max(peak,Math.abs(delta));
 }
 const rmse=Math.sqrt(sum/(count*2));assert.ok(rmse<.004,`AAC cropped-reference RMSE ${rmse}, peak ${peak}`);return {rmse,peak};
}

test('phase fixture: selected 24fps video and resampled faded audio match a decoded full-reference crop',{timeout:120000},async t=>{
 const root=await sandbox(t),sources=await phaseSources(root),snapshot=snapshotFor(sources),frozen=structuredClone(snapshot);
 const hashes=await Promise.all([sources.visual.path,sources.sound.path].map(async file=>sha(await readFile(file))));
 const full=path.join(root,'full.mp4'),part=path.join(root,'selected.mp4'),events=[],off=onMediaProcess(event=>events.push(event));
 try{await renderTimeline(snapshot,sources.assets,full);await renderTimeline({...snapshot,exportRange:{startFrame:11,endFrame:64}},sources.assets,part);}finally{off();}
 assert.equal(events.filter(event=>event.type==='started'&&event.kind==='ffmpeg').length,4,'one original segment and concat per render; range adds no capability process');
 await verify(part,53);const referenceVideo=await video(full),referenceAudio=await audio(full);
 t.diagnostic(JSON.stringify({video:compareVideo(referenceVideo,await video(part),11,64),audio:await compareAudio(referenceAudio,await audio(part),11,64,root)}));
 const single=path.join(root,'single.mp4');await renderTimeline({...snapshot,exportRange:{startFrame:74,endFrame:75}},sources.assets,single);await verify(single,1);await compareSingleFrame(referenceVideo,await video(single),74,root);
 const whole=path.join(root,'explicit-whole.mp4');await renderTimeline({...snapshot,exportRange:{startFrame:0,endFrame:75}},sources.assets,whole);
 assert.equal(sha(await readFile(whole)),sha(await readFile(full)),'explicit full span retains the exact legacy encoding arguments and bytes');
 assert.deepEqual(snapshot,frozen);assert.deepEqual(await Promise.all([sources.visual.path,sources.sound.path].map(async file=>sha(await readFile(file)))),hashes);
 assert.equal((await readdir(root)).some(name=>name.startsWith('.timeline-render-')),false);
});

test('fractional CFR and VFR B-frame sources retain original presentation phase for interior cuts',{timeout:120000},async t=>{
 const root=await sandbox(t);
 for(const [name,rate,extra] of [
  ['cfr30','30',[]],
  ['fractional','30000/1001',['-video_track_timescale','30000']],
  ['vfr','30',['-vf','settb=1/90000,setpts=(N+floor(N/3))*3000','-enc_time_base','1:90000','-video_track_timescale','90000','-fps_mode','vfr','-bf','2','-g','30']],
 ]){
  const folder=path.join(root,name);await mkdir(folder);const sources=await phaseSources(folder,rate,extra),snapshot=snapshotFor(sources);
  const sourceProbe=JSON.parse(await run('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=r_frame_rate,has_b_frames:frame=pts_time','-of','json',sources.visual.path],{timeout:30000,maxStdoutBytes:128*1024,maxStderrBytes:64*1024}));
  if(name==='fractional')assert.equal(sourceProbe.streams[0].r_frame_rate,'30000/1001');
  if(name==='vfr'){
   assert.ok(sourceProbe.streams[0].has_b_frames>0);
   const intervals=new Set(sourceProbe.frames.slice(1).map((frame,index)=>Math.round((Number(frame.pts_time)-Number(sourceProbe.frames[index].pts_time))*90000)));
   assert.ok(intervals.size>1,'the VFR fixture really contains uneven presentation intervals');
  }
  const full=path.join(folder,'full.mp4'),part=path.join(folder,'range.mp4');
  await renderTimeline(snapshot,sources.assets,full);await renderTimeline({...snapshot,exportRange:{startFrame:13,endFrame:62}},sources.assets,part);
  await verify(part,49);t.diagnostic(`${name}: ${JSON.stringify(compareVideo(await video(full),await video(part),13,62))}`);
 }
});

async function exactPcm(snapshot,clip,rate){
 const plan=planTimelineExportRange(snapshot),audible=plan.segments.filter(segment=>segment.beginFrame>=clip.startFrame),filters=[];
 filters.push(`[0:a]asplit=${audible.length}${audible.map((_,index)=>`[source${index}]`).join('')}`);
 let input=0;
 for(const [index,segment] of plan.segments.entries()){
  const frames=segment.endFrame-segment.beginFrame,samples=frames*1600;
  filters.push(`anullsrc=r=48000:cl=stereo,atrim=end_sample=${samples},asetpts=N/SR/TB[z${index}]`);
  let sounds=`[z${index}]`,count=1;
  if(segment.beginFrame>=clip.startFrame){
   const first=(clip.sourceInFrame+segment.beginFrame-clip.startFrame)*rate/30,last=first+(frames+1)*rate/30;
   filters.push(`[source${input++}]atrim=start_sample=${first}:end_sample=${last},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${clip.gain},apad,atrim=end_sample=${samples},${timelineAudioFadeFilters(clip,segment.beginFrame)}asetpts=N/SR/TB[a${index}]`);
   sounds+=`[a${index}]`;count++;
  }
  filters.push(`${sounds}amix=inputs=${count}:duration=first:dropout_transition=0:normalize=0,atrim=end_sample=${samples},${segment.audioOutputTrim}asetpts=N/SR/TB[o${index}]`);
 }
 filters.push(`${plan.segments.map((_,index)=>`[o${index}]`).join('')}concat=n=${plan.segments.length}:v=0:a=1[out]`);
 return binary(['-f','lavfi','-i',`aevalsrc=0.25|0.125:s=${rate}:d=6`,'-filter_complex',filters.join(';'),'-map','[out]','-c:a','pcm_f32le','-f','f32le','pipe:1']);
}
test('selected final-output trims preserve every float-PCM fade sample across original segment seams',{timeout:60000},async t=>{
 const clip={startFrame:21,durationFrames:120,sourceInFrame:15,gain:.5,fadeInFrames:30,fadeOutFrames:30};
 const snapshot={timeline:{fps:30,durationFrames:141,clips:[clip,{startFrame:36,durationFrames:90}]}};
 const start=28,end=134;
 for(const rate of [48000,44100]){
  const full=await exactPcm(snapshot,clip,rate),part=await exactPcm({...snapshot,exportRange:{startFrame:start,endFrame:end}},clip,rate);
  const dry=await exactPcm(snapshot,{...clip,fadeInFrames:0,fadeOutFrames:0},rate);
  assert.equal(full.length,141*1600*8);assert.equal(part.length,(end-start)*1600*8);
  let worstReference=0,worstEnvelope=0,worstDryRipple=0;
  for(let n=0;n<(end-start)*1600;n++)for(let channel=0;channel<2;channel++){
   const actual=part.readFloatLE(n*8+channel*4),reference=full.readFloatLE((n+start*1600)*8+channel*4),local=n+(start-clip.startFrame)*1600;
   const envelope=Math.min(1,local/(clip.fadeInFrames*1600))*Math.min(1,(clip.durationFrames*1600-local)/(clip.fadeOutFrames*1600));
   // Resampling can introduce tiny ripple even on constant input. The dry
   // original-segment graph independently supplies its exact sample amplitude.
   const drySample=dry.readFloatLE((n+start*1600)*8+channel*4),expected=drySample*envelope;
   worstDryRipple=Math.max(worstDryRipple,Math.abs(drySample-(channel ? .125 : .25)*clip.gain));
   worstReference=Math.max(worstReference,Math.abs(actual-reference));worstEnvelope=Math.max(worstEnvelope,Math.abs(actual-expected));
  }
  assert.equal(worstReference,0,'selected samples are the exact full-reference slice');assert.ok(worstEnvelope<2e-7,`${rate}: envelope error ${worstEnvelope}`);
  if(rate===44100)assert.ok(worstDryRipple>2e-7&&worstDryRipple<1e-5,'dry resampler ripple explains why an ideal-constant oracle is insufficient');
  else assert.equal(worstDryRipple,0);
  t.diagnostic(JSON.stringify({rate,worstReference,worstEnvelope,worstDryRipple,seams:[36,126].map(frame=>(frame-start)*1600)}));
 }
});

function captionSnapshot(sources,preset){
 const snapshot=snapshotFor(sources,preset.width,preset.height),timeline=snapshot.timeline;
 timeline.durationFrames=60;
 for(const clip of timeline.clips){clip.startFrame=15;clip.durationFrames=15;if(clip.fadeInFrames){clip.fadeInFrames=6;clip.fadeOutFrames=6;}}
 const overlay={id:randomUUID(),kind:'video',orderIndex:2,hidden:false,muted:true},muted={id:randomUUID(),kind:'audio',orderIndex:3,hidden:false,muted:true};
 timeline.tracks.push(overlay,muted);
 timeline.clips.push({...timeline.clips[0],id:randomUUID(),trackId:overlay.id,startFrame:20,durationFrames:5,sourceInFrame:30,rect:{x:72,y:64,width:64,height:48}},
  {...timeline.clips[1],id:randomUUID(),trackId:muted.id,startFrame:40,durationFrames:20,sourceInFrame:7,fadeInFrames:0,fadeOutFrames:0});
 timeline.subtitles={profileId:TIMELINE_SUBTITLE_PROFILE_ID,cues:[{id:randomUUID(),text:'你好，字幕\nRange 100%',startFrame:25,durationFrames:10}]};
 snapshot.subtitleProfile={profileId:TIMELINE_SUBTITLE_PROFILE_ID,fontSha256:TIMELINE_SUBTITLE_FONT_SHA256};
 return snapshot;
}
async function inkFrames(file,width,height,scale,start,end){
 const x=Math.round(48*scale),top=height-Math.round(168*scale),w=width-2*x,h=Math.round(120*scale);
 const bytes=await binary(['-i',file,'-an','-vf',`select='gte(n,${start})*lt(n,${end})',crop=${w}:${h}:${x}:${top},format=gray`,'-fps_mode','passthrough','-threads','1','-f','rawvideo','pipe:1'],w*h*(end-start));
 assert.equal(bytes.length,w*h*(end-start));return Array.from({length:end-start},(_,index)=>{
  let count=0;for(const value of bytes.subarray(index*w*h,(index+1)*w*h))if(value>170)count++;return count;
 });
}
test('three canvas presets preserve subtitle exclusive edges, overlapping layers, gaps and existing delivery scales',{timeout:180000},async t=>{
 const root=await sandbox(t),sources=await phaseSources(root);let selectedAudio;
 const expectedMarkers={lower:await sourceMarker(sources.visual.path,12,4),upper:await sourceMarker(sources.visual.path,30,4)};
 const expectedFrames=[[expectedMarkers.lower,expectedMarkers.upper,expectedMarkers.lower]];
 for(let frame=25;frame<30;frame++){const lower=await sourceMarker(sources.visual.path,17,frame-25);expectedFrames.push([lower,lower,lower]);}
 for(let frame=30;frame<36;frame++)expectedFrames.push([[0,0,0],[0,0,0],[0,0,0]]);
 const palette=[...new Map(expectedFrames.flat().map(color=>[color.join(','),color])).values()];let minimumSeparation=Infinity;
 for(let first=0;first<palette.length;first++)for(let second=first+1;second<palette.length;second++)minimumSeparation=Math.min(minimumSeparation,Math.max(...palette[first].map((value,channel)=>Math.abs(value-palette[second][channel]))));
 assert.ok(minimumSeparation>40,'different source-frame colors cannot both pass a 20-level per-channel marker bound');
 for(const [index,preset] of TIMELINE_OUTPUT_PRESETS.entries()){
  const snapshot=captionSnapshot(sources,preset),frozen=structuredClone(snapshot);
  // TIMELINE_OUTPUT_PRESETS now covers more than the original three canvases;
  // cycle the three delivery resolutions so every canvas keeps a real profile.
  const resolution=['native','short_360','short_1080'][index%3],settings={profileId:'mp4_h264_v1',resolution,rateControl:{mode:'crf',quality:'standard'}};
  snapshot.delivery=resolveTimelineExportDelivery(snapshot.timeline,settings);const {width,height}=snapshot.delivery.effective,scale=width/preset.width;
  const full=path.join(root,`${preset.id}-full.mp4`),part=path.join(root,`${preset.id}-range.mp4`);
  await renderTimeline(snapshot,sources.assets,full);
  const events=[],off=onMediaProcess(event=>events.push(event));
  try{await renderTimeline({...snapshot,exportRange:{startFrame:24,endFrame:36}},sources.assets,part);}finally{off();}
  assert.equal(events.filter(event=>event.type==='started'&&event.kind==='ffmpeg').length,7,'existing two capability processes + subtitle measure + only three intersecting segment encodes + concat');
  await verify(part,12,width,height);
  const fullPixels=await video(full,scale),selectedPixels=await video(part,scale);
  t.diagnostic(JSON.stringify({preset:preset.id,resolution,expectedFrame24SourceMarkers:expectedMarkers,reference23:markerColors(fullPixels,23),reference24:markerColors(fullPixels,24),reference25:markerColors(fullPixels,25),selected0:markerColors(selectedPixels,0)}));
  // At 360, 16-pixel encoder blocks cover a substantial part of this tiny
  // composition. Independent source-frame color identities and their masks
  // detect timing/layer mistakes without treating GOP quantization as a shift.
  // The native moving-source phase fixtures retain their strict pixel bounds.
  const sourceIdentity=compareSourceMarkers(fullPixels,selectedPixels,expectedFrames,palette);
  if(resolution==='native')compareVideo(fullPixels,selectedPixels,24,36);
  t.diagnostic(JSON.stringify({sourceIdentity,minimumSourceColorSeparation:minimumSeparation}));
  const reference=await inkFrames(full,width,height,scale,24,36),selected=await inkFrames(part,width,height,scale,0,12);
  assert.equal(selected[0],0);assert.equal(selected[11],0);assert.equal(reference[0],0);assert.equal(reference[11],0);
  for(let frame=1;frame<11;frame++){assert.ok(selected[frame]>30);assert.ok(reference[frame]>30);assert.ok(Math.abs(selected[frame]-reference[frame])/reference[frame]<.12,'caption ink bounds survive independent lossy segment encoding');}
  const pcm=await audio(part);if(selectedAudio)assert.deepEqual(pcm,selectedAudio,'canvas and post-caption scaling do not change selected audio');else selectedAudio=pcm;
  await compareAudio(await audio(full),pcm,24,36,root);
  const gap=path.join(root,`${preset.id}-gap.mp4`);await renderTimeline({...snapshot,exportRange:{startFrame:35,endFrame:40}},sources.assets,gap);await verify(gap,5,width,height);
  const black=await binary(['-i',gap,'-an','-vf','scale=1:1,format=rgb24','-fps_mode','passthrough','-threads','1','-f','rawvideo','pipe:1']);assert.equal(black.length,15);assert.ok([...black].every(value=>value<4));
  const silence=await audio(gap);for(let at=0;at<5*1600*8;at+=4)assert.ok(Math.abs(silence.readFloatLE(at))<1e-5);
  if(index===0)for(const [startFrame,endFrame,present] of [[25,26,true],[35,36,false],[26,34,true]]){
   const edge=path.join(root,`caption-${startFrame}-${endFrame}.mp4`);
   await renderTimeline({...snapshot,exportRange:{startFrame,endFrame}},sources.assets,edge);await verify(edge,endFrame-startFrame,width,height);
   const ink=await inkFrames(edge,width,height,scale,0,endFrame-startFrame);
   assert.ok(ink.every(count=>present?count>30:count===0),'one-frame cue boundaries and wholly-inside-cue ranges use original half-open times');
  }
  assert.deepEqual(snapshot.timeline,frozen.timeline);assert.deepEqual(snapshot.subtitleProfile,frozen.subtitleProfile);
  t.diagnostic(`${preset.id}/${resolution}: ${JSON.stringify({referenceInk:reference,selectedInk:selected})}`);
 }
 assert.equal((await readdir(root)).some(name=>name.startsWith('.timeline-render-')),false);
});

test('malformed range and range-only owner fence fail before scratch or media work',async t=>{
 const root=await sandbox(t),sources={visual:{id:randomUUID(),path:path.join(root,'never-open-video.mp4'),mimeType:'video/mp4',duration:3,hasVideo:true,hasAudio:false},sound:{id:randomUUID(),path:path.join(root,'never-open-audio.wav'),mimeType:'audio/wav',duration:4,hasVideo:false,hasAudio:true}};
 const assets=new Map([[sources.visual.id,sources.visual],[sources.sound.id,sources.sound]]),snapshot=snapshotFor(sources),events=[],off=onMediaProcess(event=>events.push(event));let fenced=0;
 try{
  for(const exportRange of [undefined,null,{startFrame:0,endFrame:0},{startFrame:0,endFrame:76},{startFrame:1.5,endFrame:2}])
   await assert.rejects(renderTimeline({...snapshot,exportRange},assets,path.join(root,'bad.mp4')),{code:'INVALID_TIMELINE_SNAPSHOT'});
  await assert.rejects(renderTimeline({...snapshot,exportRange:{startFrame:70,endFrame:75}},assets,path.join(root,'fenced.mp4'),{beforeEncode(){fenced++;throw Object.assign(Error('Synthetic stale owner'),{code:'INVALID_TIMELINE_SNAPSHOT'});}}),{code:'INVALID_TIMELINE_SNAPSHOT'});
 }finally{off();}
 assert.equal(fenced,1);assert.deepEqual(events,[]);assert.deepEqual(await readdir(root),[]);
});

test('cancelling a range at original-segment preroll startup joins the child and cleans staging',{timeout:30000},async t=>{
 const root=await sandbox(t),sources=await phaseSources(root),snapshot=snapshotFor(sources),controller=new AbortController(),events=[];
 const off=onMediaProcess(event=>{events.push(event);if(event.type==='started'&&event.kind==='ffmpeg')controller.abort();});
 const destination=path.join(root,'cancelled.mp4');
 try{await assert.rejects(renderTimeline({...snapshot,exportRange:{startFrame:74,endFrame:75}},sources.assets,destination,{signal:controller.signal}),{code:'MEDIA_CANCELLED'});}finally{off();}
 assert.equal(events.filter(event=>event.type==='started').length,1);assert.equal(events.filter(event=>event.type==='exited').length,1);
 assert.equal((await readdir(root)).some(name=>name.startsWith('.timeline-render-')||name==='cancelled.mp4'),false);
});
