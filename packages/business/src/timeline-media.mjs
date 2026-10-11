import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {run,probe} from './media.mjs';
import {validateTimeline} from './timeline-inputs.mjs';
import {throwIfMediaAborted} from './media-processes.mjs';
import {timelineAudioFadeFilters} from './timeline-audio.mjs';
import {prepareTimelineSubtitles,timelineSubtitleFilters} from './subtitle-media.mjs';
import {validateSubtitleSnapshotProfile} from './subtitle-resources.mjs';

const FPS=30,SAMPLES_PER_FRAME=1600;
const seconds=frames=>(frames/FPS).toFixed(9);
// Render both preview and export through this exact implementation. Segment at
// clip edges so even a 100-clip / 10-minute composition only opens <=12 media
// inputs at once. PCM intermediate audio avoids encoder delay at segment edges;
// the final AAC stream is encoded once. H264 video is concatenated losslessly.
export async function renderTimeline(snapshot,assets,destination,{signal}={}){
 throwIfMediaAborted(signal);
 const timeline=snapshot?.timeline,tracks=validateTimeline(timeline,assets);
 validateSubtitleSnapshotProfile(snapshot);
 // The validated frozen snapshot owns output geometry. Keep the editing and
 // audio timebase fixed while portrait, landscape and square share this path.
 const {width,height}=timeline;
 const edges=[...new Set([0,timeline.durationFrames,...timeline.clips.flatMap(c=>[c.startFrame,c.startFrame+c.durationFrames])])].sort((a,b)=>a-b);
 const work=await mkdtemp(path.join(path.dirname(destination),'.timeline-render-'));
 try{
  throwIfMediaAborted(signal);
  const subtitles=await prepareTimelineSubtitles(snapshot,work,{signal});
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
   const filters=[`color=c=black:s=${width}x${height}:r=${FPS},trim=end_frame=${frames},setpts=N/(${FPS}*TB),format=yuv420p[base]`,`anullsrc=r=48000:cl=stereo,atrim=end_sample=${samples},asetpts=N/SR/TB[silence]`];
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
     filters.push(`[${input}:${asset.audioStreamIndex??'a:0'}]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${clip.gain},apad,atrim=end_sample=${samples},${timelineAudioFadeFilters(clip,begin)}asetpts=N/SR/TB[${label}]`);sounds.push(label);
    }
   }
   filters.push(`${sounds.map(s=>`[${s}]`).join('')}amix=inputs=${sounds.length}:duration=first:dropout_transition=0:normalize=0,atrim=end_sample=${samples},asetpts=N/SR/TB[outa]`);
   const captioned=timelineSubtitleFilters(subtitles,begin,end,visual);filters.push(...captioned.filters);visual=captioned.visual;
   filters.push(`[${visual}]trim=end_frame=${frames},setpts=N/(${FPS}*TB),format=yuv420p[outv]`);
   const segmentFile=path.join(work,`segment-${String(segment).padStart(3,'0')}.mov`);
   const filterArgs=['-filter_complex',filters.join(';')];
   if(subtitles){const script=path.join(work,`segment-${segment}.filter`);await writeFile(script,filters.join(';'),{flag:'wx',mode:0o600});filterArgs.splice(0,2,'-filter_complex_script',script);}
   args.push(...filterArgs,'-map','[outv]','-map','[outa]','-c:v','libx264','-preset','veryfast','-crf','23','-threads','2','-bf','0','-g','60','-pix_fmt','yuv420p','-r',String(FPS),'-video_track_timescale','30000','-c:a','pcm_s16le','-ar','48000','-ac','2','-t',seconds(frames),segmentFile);
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
  if(result.width!==width||result.height!==height||v?.codec_name!=='h264'||v?.r_frame_rate!=='30/1'||v?.avg_frame_rate!=='30/1'||Number(v?.nb_frames)!==timeline.durationFrames||a?.codec_name!=='aac'||Number(a?.sample_rate)!==48000||a?.channels!==2||Math.abs(result.duration-timeline.durationFrames/FPS)>0.035)throw Error('Rendered timeline failed frame/duration/audio-format verification');
  return result;
 }finally{await rm(work,{recursive:true,force:true});}
}
