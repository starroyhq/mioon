import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {run,probe} from './media.mjs';
import {throwIfMediaAborted} from './media-processes.mjs';

const FPS=30,WIDTH=720,HEIGHT=1280,SAMPLES_PER_FRAME=1600;
const seconds=frames=>(frames/FPS).toFixed(9);
const integer=(value,min,max)=>Number.isInteger(value)&&value>=min&&value<=max;
function invalid(message){throw Object.assign(Error(message),{code:'INVALID_TIMELINE_SNAPSHOT'});}

// Defense in depth for recovered, persisted jobs. The service performs the same
// public validation, but the renderer must never interpret arbitrary effects.
function validateTimeline(timeline,assets){
 if(!timeline||timeline.fps!==FPS||timeline.width!==WIDTH||timeline.height!==HEIGHT)invalid('Timeline output must be 720×1280 at 30 fps');
 if(!Array.isArray(timeline.tracks)||timeline.tracks.length>12||!Array.isArray(timeline.clips)||!timeline.clips.length||timeline.clips.length>100)invalid('Timeline requires 1–100 clips and at most 12 tracks');
 const tracks=new Map();
 for(const t of timeline.tracks){if(!t.id||tracks.has(t.id)||!['video','audio'].includes(t.kind)||!Number.isInteger(t.orderIndex)||typeof t.hidden!=='boolean'||typeof t.muted!=='boolean'||(t.kind==='audio'&&t.hidden))invalid('Invalid timeline track');tracks.set(t.id,t);}
 let duration=0;const ids=new Set();
 for(const c of timeline.clips){
  const t=tracks.get(c.trackId),a=assets.get(c.assetId),r=c.rect;
  if(!c.id||ids.has(c.id)||!t||!a)invalid('Missing, duplicate, or unresolvable timeline clip');ids.add(c.id);
  if(!integer(c.startFrame,0,18000)||!integer(c.durationFrames,1,18000)||!integer(c.sourceInFrame,0,Number.MAX_SAFE_INTEGER-18000)||c.startFrame+c.durationFrames>18000)invalid('Invalid frame range');
  if(!r||!integer(r.x,0,WIDTH)||!integer(r.y,0,HEIGHT)||!integer(r.width,2,WIDTH)||!integer(r.height,2,HEIGHT)||[r.x,r.y,r.width,r.height].some(v=>v%2)||r.x+r.width>WIDTH||r.y+r.height>HEIGHT)invalid('Invalid clip rectangle');
  if(!Number.isFinite(c.gain)||c.gain<0||c.gain>2)invalid('Invalid clip gain');
  const isImage=a.mimeType?.startsWith('image/'),isVideo=a.mimeType?.startsWith('video/'),isAudio=['audio/wav','audio/mpeg','audio/mp4'].includes(a.mimeType);
  if(t.kind==='video'?(!isImage&&!isVideo):!isAudio)invalid('Asset is not supported on this track');
  if(t.kind==='video'&&!a.hasVideo||t.kind==='audio'&&!a.hasAudio)invalid('Asset has no required media stream');
  if(isImage?c.sourceInFrame!==0:(!Number.isFinite(a.duration)||c.sourceInFrame+c.durationFrames>Math.floor(a.duration*FPS+1e-6)))invalid('Clip exceeds source duration');
  for(const effect of ['transition','transitions','effects','speed','rate','opacity','blendMode'])if(c[effect]!==undefined)invalid(`Unsupported timeline effect: ${effect}`);
  duration=Math.max(duration,c.startFrame+c.durationFrames);
 }
 for(const t of tracks.values()){const clips=timeline.clips.filter(c=>c.trackId===t.id).sort((a,b)=>a.startFrame-b.startFrame);for(let i=1;i<clips.length;i++)if(clips[i].startFrame<clips[i-1].startFrame+clips[i-1].durationFrames)invalid('Clips overlap on one track');}
 if(timeline.durationFrames!==duration)invalid('Timeline duration does not match clips');
 return tracks;
}

// Render both preview and export through this exact implementation. Segment at
// clip edges so even a 100-clip / 10-minute composition only opens <=12 media
// inputs at once. PCM intermediate audio avoids encoder delay at segment edges;
// the final AAC stream is encoded once. H264 video is concatenated losslessly.
export async function renderTimeline(snapshot,assets,destination,{signal}={}){
 throwIfMediaAborted(signal);
 const timeline=snapshot?.timeline,tracks=validateTimeline(timeline,assets);
 const edges=[...new Set([0,timeline.durationFrames,...timeline.clips.flatMap(c=>[c.startFrame,c.startFrame+c.durationFrames])])].sort((a,b)=>a-b);
 const work=await mkdtemp(path.join(path.dirname(destination),'.timeline-render-'));
 try{
  throwIfMediaAborted(signal);
  const entries=[];
  for(let segment=0;segment<edges.length-1;segment++){
   throwIfMediaAborted(signal);
   const begin=edges[segment],end=edges[segment+1],frames=end-begin,samples=frames*SAMPLES_PER_FRAME;
   const clips=timeline.clips.filter(c=>c.startFrame<=begin&&c.startFrame+c.durationFrames>=end).sort((a,b)=>tracks.get(a.trackId).orderIndex-tracks.get(b.trackId).orderIndex||a.id.localeCompare(b.id));
   const args=['-hide_banner','-loglevel','error','-n','-filter_complex_threads','1'];
   const inputs=[];
   for(const clip of clips){
    const asset=assets.get(clip.assetId),track=tracks.get(clip.trackId),visual=track.kind==='video'&&!track.hidden,audio=asset.hasAudio&&!track.muted&&clip.gain>0;
    if(!visual&&!audio)continue;
    const input=inputs.length,isImage=asset.mimeType.startsWith('image/');
    args.push('-threads','1');
    if(isImage)args.push('-loop','1','-framerate',String(FPS));
    else args.push('-ss',seconds(clip.sourceInFrame+begin-clip.startFrame));
    args.push('-t',seconds(frames+1),'-i',asset.path);
    inputs.push({clip,asset,visual,audio,input});
   }
   const filters=[`color=c=black:s=${WIDTH}x${HEIGHT}:r=${FPS},trim=end_frame=${frames},setpts=N/(${FPS}*TB),format=yuv420p[base]`,`anullsrc=r=48000:cl=stereo,atrim=end_sample=${samples},asetpts=N/SR/TB[silence]`];
   let visual='base';const sounds=['silence'];
   for(const {clip,asset,input,visual:show,audio} of inputs){
    if(show){
     const {x,y,width,height}=clip.rect,label=`v${input}`,next=`layer${input}`;
     // rgba padding preserves the lower layers in the letterbox/pillarbox area.
     filters.push(`[${input}:${asset.videoStreamIndex??'v:0'}]setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=${FPS},format=rgba,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,tpad=stop_mode=clone:stop_duration=${seconds(frames)},trim=end_frame=${frames},setpts=N/(${FPS}*TB)[${label}]`);
     filters.push(`[${visual}][${label}]overlay=x=${x}:y=${y}:eof_action=pass:repeatlast=0:shortest=0[${next}]`);visual=next;
    }
    if(audio){
     const label=`a${input}`;
     filters.push(`[${input}:${asset.audioStreamIndex??'a:0'}]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${clip.gain},apad,atrim=end_sample=${samples},asetpts=N/SR/TB[${label}]`);sounds.push(label);
    }
   }
   filters.push(`${sounds.map(s=>`[${s}]`).join('')}amix=inputs=${sounds.length}:duration=first:dropout_transition=0:normalize=0,atrim=end_sample=${samples},asetpts=N/SR/TB[outa]`);
   filters.push(`[${visual}]trim=end_frame=${frames},setpts=N/(${FPS}*TB),format=yuv420p[outv]`);
   const segmentFile=path.join(work,`segment-${String(segment).padStart(3,'0')}.mov`);
   args.push('-filter_complex',filters.join(';'),'-map','[outv]','-map','[outa]','-c:v','libx264','-preset','veryfast','-crf','23','-threads','2','-bf','0','-g','60','-pix_fmt','yuv420p','-r',String(FPS),'-video_track_timescale','30000','-c:a','pcm_s16le','-ar','48000','-ac','2','-t',seconds(frames),segmentFile);
   await run('ffmpeg',args,{timeout:Math.max(120000,frames/FPS*5000),signal});
   throwIfMediaAborted(signal);
   entries.push(`file '${segmentFile.replaceAll("'","'\\''")}'\nduration ${seconds(frames)}`);
  }
  throwIfMediaAborted(signal);
  const list=path.join(work,'segments.txt');await writeFile(list,entries.join('\n')+'\n');
  throwIfMediaAborted(signal);
  await run('ffmpeg',['-hide_banner','-loglevel','error','-n','-f','concat','-safe','0','-i',list,'-map','0:v:0','-map','0:a:0','-c:v','copy','-video_track_timescale','30000','-af',`apad,atrim=end_sample=${timeline.durationFrames*SAMPLES_PER_FRAME},asetpts=N/SR/TB`,'-c:a','aac','-b:a','128k','-ar','48000','-ac','2','-t',seconds(timeline.durationFrames),'-movflags','+faststart',destination],{timeout:300000,signal});
  throwIfMediaAborted(signal);
  const result=await probe(destination,{signal}),v=result.probe.streams.find(s=>s.codec_type==='video'),a=result.probe.streams.find(s=>s.codec_type==='audio');
  throwIfMediaAborted(signal);
  if(result.width!==WIDTH||result.height!==HEIGHT||v?.codec_name!=='h264'||v?.r_frame_rate!=='30/1'||v?.avg_frame_rate!=='30/1'||Number(v?.nb_frames)!==timeline.durationFrames||a?.codec_name!=='aac'||Number(a?.sample_rate)!==48000||a?.channels!==2||Math.abs(result.duration-timeline.durationFrames/FPS)>0.035)throw Error('Rendered timeline failed frame/duration/audio-format verification');
  return result;
 }finally{await rm(work,{recursive:true,force:true});}
}
