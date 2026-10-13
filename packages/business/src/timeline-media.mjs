import {mkdtemp,writeFile,rm,open} from 'node:fs/promises';
import {constants,mkdtempSync,openSync,fstatSync,lstatSync,closeSync,unlinkSync,rmdirSync} from 'node:fs';
import path from 'node:path';
import {run,probe} from './media.mjs';
import {validateTimeline} from './timeline-inputs.mjs';
import {timelineAudioFadeFilters} from './timeline-audio.mjs';
import {prepareTimelineSubtitles,timelineSubtitleFilters} from './subtitle-media.mjs';
import {validateSubtitleSnapshotProfile} from './subtitle-resources.mjs';
import {isTimelineExportSnapshot} from '@mioon/contracts';
import {assertTimelineExportCapability,timelineExportVideoArgs} from './timeline-export-capabilities.mjs';
import {checkMediaEffect,runStreaming} from './media-runtime.mjs';
import {withProbePermit} from './media-probe.mjs';
import {waitForMediaProcesses,MEDIA_TERMINATION_POLICY} from './media-processes.mjs';
import {createTimelineFloatAudioChecker,assertTimelineFloatAudioAllowed,rememberTimelineFloatAudioFailure} from './timeline-float-audio-check.ts';
import {TIMELINE_EXPORT_FLOAT_PROFILE_ID} from '@mioon/contracts/timeline-export-float';
import {createPrivateTemporaryDirectory,validatePrivateDirectory} from '@mioon/contracts/private-storage';
import {createTimelineFloatStaging} from './timeline-float-staging.ts';
import {planTimelineExportRange,validateTimelineExportRangeOutputStart} from './timeline-export-range-plan.ts';

const FPS=30,SAMPLES_PER_FRAME=1600;
const checkFloatAudio=createTimelineFloatAudioChecker({run,runStreaming,withProbePermit,checkMediaEffect,terminationMs:MEDIA_TERMINATION_POLICY.graceMs+MEDIA_TERMINATION_POLICY.reapMs});
const seconds=frames=>(frames/FPS).toFixed(9);
const sameInode=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const changedWork=()=>Object.assign(Error('The local render staging files changed.'),{code:'INVALID_TIMELINE_SNAPSHOT'});

// Fenced attempts retain exact inode ownership, including failed/partial writes.
// This fixed flat set is bounded by <=200 segments, <=200 segment scripts,
// <=102 subtitle files and one concat list. Never scan or recursively remove
// children: replacements and files created by someone else must survive.
function ownedTimelineWork(destination,beforeEffect,signal){
 checkMediaEffect(beforeEffect,signal);
 const work=mkdtempSync(path.join(path.dirname(destination),'.timeline-render-'));
 const directoryFd=openSync(work,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 const directory=fstatSync(directoryFd),files=new Map();
 const ownsDirectory=()=>{try{const current=lstatSync(work);return current.isDirectory()&&!current.isSymbolicLink()&&sameInode(directory,current);}catch{return false;}};
 const ownsFile=(file,entry)=>{try{const current=lstatSync(file);return current.isFile()&&!current.isSymbolicLink()&&current.nlink===1&&sameInode(entry.identity,current);}catch{return false;}};
 const effect=()=>{
  checkMediaEffect(beforeEffect,signal);
  if(!ownsDirectory())throw changedWork();
  for(const [file,entry] of files)if(!ownsFile(file,entry))throw changedWork();
 };
 const reserve=file=>{
  effect();
  if(path.dirname(file)!==work||files.has(file)||files.size>=512)throw changedWork();
  const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
  const entry={fd,identity:fstatSync(fd)};files.set(file,entry);return entry;
 };
 const openOwnedFile=async file=>{
  const entry=reserve(file);let handle;
  try{
   handle=await open(file,constants.O_WRONLY|(constants.O_NOFOLLOW??0));effect();
   const current=await handle.stat();effect();
   if(!current.isFile()||!sameInode(entry.identity,current))throw changedWork();
   return handle;
  }catch(error){await handle?.close().catch(()=>{});throw error;}
 };
 const writeOwnedFile=async(file,bytes)=>{
  const handle=await openOwnedFile(file);let failure;
  try{effect();await handle.writeFile(bytes);effect();}
  catch(error){failure=error;throw error;}
  finally{await handle.close().catch(error=>{if(!failure)throw error;});}
 };
 const cleanup=()=>{
  try{
   for(const [file,entry] of files){if(!ownsDirectory())break;if(ownsFile(file,entry))try{unlinkSync(file);}catch{/* Preserve unknown/failed cleanup. */}}
   if(ownsDirectory())try{rmdirSync(work);}catch{/* Unknown children keep the directory. */}
  }finally{
   for(const entry of files.values())try{closeSync(entry.fd);}catch{/* Best effort exact descriptor close. */}
   try{closeSync(directoryFd);}catch{/* Best effort exact descriptor close. */}
  }
 };
 return {work,effect,reserve,openOwnedFile,writeOwnedFile,cleanup};
}
// Render both preview and export through this exact implementation. Segment at
// clip edges so even a 100-clip / 10-minute composition only opens <=12 media
// inputs at once. PCM intermediate audio avoids encoder delay at segment edges;
// the final AAC stream is encoded once. H264 video is concatenated losslessly.
export async function renderTimeline(snapshot,assets,destination,{signal,beforeEncode,beforeEffect}={}){
 checkMediaEffect(beforeEffect,signal);
 const timeline=snapshot?.timeline,tracks=validateTimeline(timeline,assets);
 validateSubtitleSnapshotProfile(snapshot);
 if(!isTimelineExportSnapshot(snapshot))throw Object.assign(Error('The saved export delivery profile is invalid.'),{code:'INVALID_TIMELINE_SNAPSHOT'});
 const delivery=snapshot.delivery,plan=planTimelineExportRange(snapshot),floatChecked=delivery?.effective.profileId===TIMELINE_EXPORT_FLOAT_PROFILE_ID;
 // Never trust an earlier capability report as an admission token. Legacy and
 // omitted-settings snapshots keep their original no-probe rendering path.
 if(delivery){await assertTimelineExportCapability(delivery,{signal,beforeEffect,...(floatChecked?{capabilityWorkRoot:path.dirname(destination)}:{})});checkMediaEffect(beforeEffect,signal);}
 if(delivery||plan.selected)beforeEncode?.();
 checkMediaEffect(beforeEffect,signal);
 // The validated frozen snapshot owns output geometry. Keep the editing and
 // audio timebase fixed while portrait, landscape and square share this path.
 const {width,height}=timeline;
 const owned=floatChecked?createTimelineFloatStaging(destination,{signal,beforeEffect},{checkMediaEffect,createPrivateTemporaryDirectory,validatePrivateDirectory})
  :beforeEffect===undefined?null:ownedTimelineWork(destination,beforeEffect,signal);
 const work=owned?.work??await mkdtemp(path.join(path.dirname(destination),'.timeline-render-'));
 const effect=owned?.effect??beforeEffect;
 let unconfirmed=false,audioCheck,primaryFailure;
 try{
  checkMediaEffect(effect,signal);
  const subtitles=await prepareTimelineSubtitles(snapshot,work,{signal,beforeEffect:effect,...(owned?{openOwnedFile:owned.openOwnedFile,writeOwnedFile:owned.writeOwnedFile}:{})});checkMediaEffect(effect,signal);
  const entries=[],ownedSegments=[];
  for(let segment=0;segment<plan.segments.length;segment++){
   checkMediaEffect(effect,signal);
   const selected=plan.segments[segment],begin=selected.beginFrame,end=selected.endFrame,frames=end-begin,samples=frames*SAMPLES_PER_FRAME;
   const clips=timeline.clips.filter(c=>c.startFrame<=begin&&c.startFrame+c.durationFrames>=end).sort((a,b)=>tracks.get(a.trackId).orderIndex-tracks.get(b.trackId).orderIndex||a.id.localeCompare(b.id));
   const args=['-hide_banner','-loglevel','error',owned?'-y':'-n','-filter_complex_threads','1'];
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
   filters.push(`${sounds.map(s=>`[${s}]`).join('')}amix=inputs=${sounds.length}:duration=first:dropout_transition=0:normalize=0,atrim=end_sample=${samples},${selected.audioOutputTrim}asetpts=N/SR/TB[outa]`);
   const captioned=timelineSubtitleFilters(subtitles,begin,end,visual);filters.push(...captioned.filters);visual=captioned.visual;
   // Scale the completed editing-canvas composition, including captions. Clip
   // rectangles, subtitle layout/cues, source sampling and audio stay untouched.
   // 1080 short edge is a 1.5x upscale of the fixed 720-short-edge composition.
   const scale=delivery&&(delivery.effective.width!==width||delivery.effective.height!==height)
    ?`scale=${delivery.effective.width}:${delivery.effective.height}:flags=${delivery.effective.scaling},setsar=1,`:'';
   filters.push(`[${visual}]${scale}trim=end_frame=${frames},${selected.videoOutputTrim}setpts=N/(${FPS}*TB),format=yuv420p[outv]`);
   const segmentFile=path.join(work,`segment-${String(segment).padStart(3,'0')}.mov`);
   const filterArgs=['-filter_complex',filters.join(';')];
   if(subtitles){const script=path.join(work,`segment-${segment}.filter`);checkMediaEffect(effect,signal);await (owned?owned.writeOwnedFile(script,filters.join(';')):writeFile(script,filters.join(';'),{flag:'wx',mode:0o600}));checkMediaEffect(effect,signal);filterArgs.splice(0,2,'-filter_complex_script',script);}
   const videoArgs=delivery?timelineExportVideoArgs(delivery):['-c:v','libx264','-preset','veryfast','-crf','23','-threads','2','-bf','0','-g','60','-pix_fmt','yuv420p','-r',String(FPS),'-video_track_timescale','30000'];
   args.push(...filterArgs,'-map','[outv]','-map','[outa]',...videoArgs,'-c:a',floatChecked?'pcm_f32le':'pcm_s16le','-ar','48000','-ac','2','-t',seconds(selected.outputFrames),segmentFile);
   owned?.reserve(segmentFile);
   await run('ffmpeg',args,{timeout:Math.max(120000,frames/FPS*5000),signal,beforeEffect:effect});
   checkMediaEffect(effect,signal);
   if(floatChecked)ownedSegments.push({file:segmentFile,outputFrames:selected.outputFrames});
   entries.push(`file '${segmentFile.replaceAll("'","'\\''")}'\nduration ${seconds(selected.outputFrames)}`);
  }
  checkMediaEffect(effect,signal);
  const list=path.join(work,'segments.txt');await (owned?owned.writeOwnedFile(list,entries.join('\n')+'\n'):writeFile(list,entries.join('\n')+'\n'));
  checkMediaEffect(effect,signal);
  if(floatChecked){audioCheck=await checkFloatAudio(list,plan.outputFrames,{signal,beforeEffect:effect,ownedSegments});checkMediaEffect(effect,signal);assertTimelineFloatAudioAllowed(audioCheck);}
  // The fenced worker reserves and retains the destination inode and checks
  // it in beforeEffect. Only that owned empty output may be overwritten.
  await run('ffmpeg',['-hide_banner','-loglevel','error',owned?'-y':'-n','-f','concat','-safe','0','-i',list,'-map','0:v:0','-map','0:a:0','-c:v','copy','-video_track_timescale','30000','-af',floatChecked?'asetpts=N/SR/TB':`apad,atrim=end_sample=${plan.outputFrames*SAMPLES_PER_FRAME},asetpts=N/SR/TB`,'-c:a','aac','-b:a','128k','-ar','48000','-ac','2','-t',seconds(plan.outputFrames),'-movflags','+faststart',destination],{timeout:300000,signal,beforeEffect:effect});
  checkMediaEffect(effect,signal);
  const result=await probe(destination,{signal,beforeEffect:effect}),v=result.probe.streams.find(s=>s.codec_type==='video'),a=result.probe.streams.find(s=>s.codec_type==='audio');
  checkMediaEffect(effect,signal);
  const output=delivery?.effective||{width,height};
  if(result.width!==output.width||result.height!==output.height||v?.codec_name!=='h264'||v?.r_frame_rate!=='30/1'||v?.avg_frame_rate!=='30/1'||Number(v?.nb_frames)!==plan.outputFrames||a?.codec_name!=='aac'||Number(a?.sample_rate)!==48000||a?.channels!==2||Math.abs(result.duration-plan.outputFrames/FPS)>0.035)throw Error('Rendered timeline failed frame/duration/audio-format verification');
  if((delivery||plan.selected)&&(result.probe.streams.length!==2||v?.sample_aspect_ratio!=='1:1'||v?.pix_fmt!=='yuv420p'||v?.has_b_frames!==0||v?.time_base!=='1/30000'||a?.time_base!=='1/48000'||a?.channel_layout!=='stereo'
   ||!Number.isFinite(Number(v?.duration))||Math.abs(Number(v.duration)-plan.outputFrames/FPS)>0.00001
   ||!Number.isFinite(Number(a?.duration))||Math.abs(Number(a.duration)-plan.outputFrames/FPS)>0.025
   ||!String(result.probe.format?.format_name).split(',').includes('mp4')))throw Error('Rendered timeline failed delivery-profile verification');
  validateTimelineExportRangeOutputStart(plan,result.probe);
  return floatChecked?{...result,audioCheck}:result;
 }catch(error){primaryFailure=error;unconfirmed=floatChecked&&error?.terminationUnconfirmed===true;if(floatChecked&&audioCheck&&!signal?.aborted)rememberTimelineFloatAudioFailure(error,audioCheck);throw error;}
 finally{
  if(unconfirmed&&owned)void waitForMediaProcesses({signal}).then(()=>owned.cleanup());
  else if(owned){const cleaned=owned.cleanup();if(floatChecked&&!cleaned&&!primaryFailure){const failure=Object.assign(Error('The float export staging cleanup could not be confirmed.'),{code:'EXPORT_AUDIO_STAGING_CHANGED'});if(!signal?.aborted)rememberTimelineFloatAudioFailure(failure,audioCheck??null);throw failure;}}
  else await rm(work,{recursive:true,force:true});
 }
}
