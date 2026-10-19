import {getTimelineOpacityRenderBinding} from './timeline-opacity-render-binding.ts';
import {prepareTimelineImageLayers} from './timeline-image-staging.ts';
import {validateTimelineImageSourceInterpretation} from './timeline-image-source.ts';
import {mkdtemp,writeFile,rm,open} from 'node:fs/promises';
import {constants,mkdtempSync,openSync,fstatSync,lstatSync,closeSync,unlinkSync,rmdirSync} from 'node:fs';
import path from 'node:path';
import {run,probe} from './media.ts';
import {validateTimeline} from './timeline-inputs.ts';
import {timelineAudioSilenceFilter,timelineClipAudioFilter,timelineMixedAudioFilter} from './timeline-audio-filter-graph.ts';
import {prepareTimelineSubtitles,timelineSubtitleFilters} from './subtitle-media.ts';
import {validateSubtitleSnapshotProfile} from './subtitle-resources.ts';
import {isTimelineExportSnapshot} from '@mioon/contracts';
import {assertTimelineExportCapability,timelineExportVideoArgs} from './timeline-export-capabilities.ts';
import {checkMediaEffect,runStreaming} from './media-runtime.ts';
import {withProbePermit} from './media-probe.ts';
import {waitForMediaProcesses,MEDIA_TERMINATION_POLICY} from './media-processes.ts';
import {createTimelineFloatAudioChecker,assertTimelineFloatAudioAllowed,rememberTimelineFloatAudioFailure} from './timeline-float-audio-check.ts';
import {TIMELINE_EXPORT_FLOAT_PROFILE_ID} from '@mioon/contracts/timeline-export-float';
import {createPrivateTemporaryDirectory,validatePrivateDirectory} from '@mioon/contracts/private-storage';
import {createTimelineFloatStaging} from './timeline-float-staging.ts';
import {planTimelineExportRange,validateTimelineExportRangeOutputStart} from './timeline-export-range-plan.ts';
import {isTimelineColourSnapshot,projectTimelineColourPlan,assertTimelineImageCompositorInputCount,TIMELINE_MIXED_COLOUR_RENDER_PROFILE,TIMELINE_JPEG_MIXED_COLOUR_RENDER_PROFILE} from '../../contracts/src/timeline-colour.ts';
import {prepareTimelineColourLuts,timelineColourInputFilter,TIMELINE_COLOUR_OUTPUT_FILTER,TIMELINE_COLOUR_OUTPUT_ARGS} from './timeline-colour-lut.ts';
import {validateTimelineColourSourceInterpretation} from './timeline-colour-source.ts';
import type {Stats} from 'node:fs';
import type {FileHandle} from 'node:fs/promises';
import type {ManagedAssetRecord,TimelineClipRecord,TimelineRecord} from './timeline-inputs.ts';

interface RenderColourPlanClip {clipId: string;assetId: string;kind: string;assetSha256?: string;evidence: {width: number;height: number};sourceProfileId?: string;look?: unknown;range?: unknown}
interface RenderColourPlan {profileId: string;clips: RenderColourPlanClip[]}
interface RenderDelivery {effective: {profileId?: string;width: number;height: number;scaling?: string}}
interface TimelineSnapshotLike {
 timeline: TimelineRecord;assets: ManagedAssetRecord[];
 colourPlan?: RenderColourPlan;delivery?: RenderDelivery;subtitleProfile?: unknown;
}
interface RenderAsset extends ManagedAssetRecord {path?: string;videoStreamIndex?: number|string|null;audioStreamIndex?: number|string|null;colourProbe?: unknown;colourImageEvidence?: unknown}
interface RenderTimelineOptions {signal?: AbortSignal;beforeEncode?: ()=>void;beforeEffect?: ()=>void;readLut?: (value: unknown)=>unknown}
interface InodeIdentity {dev: number|bigint;ino: number|bigint;size: number;mtimeMs: number;ctimeMs: number}
interface ReservedEntry {fd: number;identity: Stats}
interface OwnedTimelineWork {
 work: string;effect: ()=>void;
 reserve: (file: string)=>ReservedEntry;
 openOwnedFile: (file: string)=>Promise<FileHandle>;
 writeOwnedFile: (file: string,bytes: string|Uint8Array)=>Promise<void>;
 cleanup: ()=>void;
}

const FPS=30,SAMPLES_PER_FRAME=1600;
const checkFloatAudio=createTimelineFloatAudioChecker({run,runStreaming,withProbePermit,checkMediaEffect,terminationMs:MEDIA_TERMINATION_POLICY.graceMs+MEDIA_TERMINATION_POLICY.reapMs});
const seconds=(frames: number): string=>(frames/FPS).toFixed(9);
const sameInode=(a: InodeIdentity,b: InodeIdentity): boolean=>a.dev===b.dev&&a.ino===b.ino;
const changedWork=(): Error=>Object.assign(Error('The local render staging files changed.'),{code:'INVALID_TIMELINE_SNAPSHOT'});

// Fenced attempts retain exact inode ownership, including failed/partial writes.
// This fixed flat set is bounded by <=200 segments, <=200 segment scripts,
// <=102 subtitle files and one concat list. Never scan or recursively remove
// children: replacements and files created by someone else must survive.
function ownedTimelineWork(destination: string,beforeEffect: (()=>void)|undefined,signal: AbortSignal|undefined): OwnedTimelineWork{
 checkMediaEffect(beforeEffect,signal);
 const work=mkdtempSync(path.join(path.dirname(destination),'.timeline-render-'));
 const directoryFd=openSync(work,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 const directory=fstatSync(directoryFd),files=new Map<string, ReservedEntry>();
 const ownsDirectory=()=>{try{const current=lstatSync(work);return current.isDirectory()&&!current.isSymbolicLink()&&sameInode(directory,current);}catch{return false;}};
 const ownsFile=(file: string,entry: ReservedEntry): boolean=>{try{const current=lstatSync(file);return current.isFile()&&!current.isSymbolicLink()&&current.nlink===1&&sameInode(entry.identity,current);}catch{return false;}};
 const effect=()=>{
  checkMediaEffect(beforeEffect,signal);
  if(!ownsDirectory())throw changedWork();
  for(const [file,entry] of files)if(!ownsFile(file,entry))throw changedWork();
 };
 const reserve=(file: string): ReservedEntry=>{
  effect();
  if(path.dirname(file)!==work||files.has(file)||files.size>=512)throw changedWork();
  const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
  const entry={fd,identity:fstatSync(fd)};files.set(file,entry);return entry;
 };
 const openOwnedFile=async(file: string): Promise<FileHandle>=>{
  const entry=reserve(file);let handle: FileHandle|undefined;
  try{
   handle=await open(file,constants.O_WRONLY|(constants.O_NOFOLLOW??0));effect();
   const current=await handle.stat();effect();
   if(!current.isFile()||!sameInode(entry.identity,current))throw changedWork();
   return handle;
  }catch(error){await handle?.close().catch(()=>{});throw error;}
 };
 const writeOwnedFile=async(file: string,bytes: string|Uint8Array): Promise<void>=>{
  const handle=await openOwnedFile(file);let failure: unknown;
  try{effect();await handle.writeFile(bytes);effect();}
  catch(error){failure=error;throw error;}
  finally{await handle.close().catch(error=>{if(!failure)throw error;});}
 };
 const cleanup=(): void=>{
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
export async function renderTimeline(snapshot: TimelineSnapshotLike,assets: Map<string, RenderAsset>,destination: string,{signal,beforeEncode,beforeEffect,readLut}: RenderTimelineOptions={}): Promise<unknown>{
 const opacity=getTimelineOpacityRenderBinding(snapshot as never,assets as never);
 if(opacity){snapshot=opacity.validationSnapshot as unknown as TimelineSnapshotLike;beforeEffect=opacity.effectFence(beforeEffect) as (()=>void)|undefined;readLut=opacity.readLut as ((value: unknown)=>unknown)|undefined;signal=opacity.signal&&signal&&opacity.signal!==signal?AbortSignal.any([opacity.signal,signal]):opacity.signal??signal;}
 checkMediaEffect(beforeEffect,signal);
 const timeline=snapshot.timeline,tracks=validateTimeline(timeline,assets);
 validateSubtitleSnapshotProfile(snapshot);
 if(snapshot.colourPlan&&([TIMELINE_MIXED_COLOUR_RENDER_PROFILE,TIMELINE_JPEG_MIXED_COLOUR_RENDER_PROFILE] as readonly string[]).includes(snapshot.colourPlan.profileId))projectTimelineColourPlan(snapshot as never);
 if(!isTimelineExportSnapshot(snapshot)||!isTimelineColourSnapshot(snapshot))throw Object.assign(Error('The saved export delivery profile is invalid.'),{code:'INVALID_TIMELINE_SNAPSHOT'});
 const colour=snapshot.colourPlan,colourClips=new Map<string, RenderColourPlanClip>((colour?.clips??[]).map(item=>[item.clipId,item]));
 if(colour)for(const item of colour.clips){const clip=timeline.clips.find(value=>value.id===item.clipId),asset=assets.get(item.assetId);
  if(item.kind==='image')validateTimelineImageSourceInterpretation({source:clip?.colour?.source,evidence:asset?.colourImageEvidence,probe:asset?.colourProbe,assetSha256:asset?.sha256,streamIndex:asset?.videoStreamIndex} as never);
  else validateTimelineColourSourceInterpretation({source:clip?.colour?.source,probe:asset?.colourProbe,assetSha256:asset?.sha256,streamIndex:asset?.videoStreamIndex} as never);}
 const delivery=snapshot.delivery,plan=planTimelineExportRange(snapshot),floatChecked=delivery?.effective.profileId===TIMELINE_EXPORT_FLOAT_PROFILE_ID;
 // Never trust an earlier capability report as an admission token. Legacy and
 // omitted-settings snapshots keep their original no-probe rendering path.
 if(delivery){await assertTimelineExportCapability(delivery as never,{signal,beforeEffect,...(floatChecked?{capabilityWorkRoot:path.dirname(destination)}:{})} as never);checkMediaEffect(beforeEffect,signal);}
 if(delivery||plan.selected)beforeEncode?.();
 checkMediaEffect(beforeEffect,signal);
 // The validated frozen snapshot owns output geometry. Keep the editing and
 // audio timebase fixed while portrait, landscape and square share this path.
 const {width,height}=timeline;
 const owned=floatChecked||colour?createTimelineFloatStaging(destination as never,{signal,beforeEffect} as never,{checkMediaEffect,createPrivateTemporaryDirectory,validatePrivateDirectory} as never)
  :beforeEffect===undefined?null:ownedTimelineWork(destination,beforeEffect,signal);
 const work=owned?.work??await mkdtemp(path.join(path.dirname(destination),'.timeline-render-'));
 let effect=owned?.effect??beforeEffect;
 let unconfirmed=false,audioCheck: Awaited<ReturnType<typeof checkFloatAudio>>|undefined,primaryFailure: unknown,colourStage: Awaited<ReturnType<typeof prepareTimelineColourLuts>>|undefined,imageStage: Awaited<ReturnType<typeof prepareTimelineImageLayers>>|undefined;
 try{
  checkMediaEffect(effect,signal);
  if(colour){
   colourStage=await prepareTimelineColourLuts(colour as never,destination,{signal,beforeEffect:effect,readLut} as never,{checkMediaEffect,createPrivateTemporaryDirectory,validatePrivateDirectory} as never);
   effect=colourStage.effect;
   const images=colour.clips.filter(item=>item.kind==='image').map(item=>{
    const clip=timeline.clips.find(value=>value.id===item.clipId),asset=assets.get(item.assetId),creativeLutPath=colourStage!.path(item.clipId);
    return {clipId:item.clipId,assetSha256:item.assetSha256,sourcePath:asset?.path,sourceWidth:item.evidence.width as number,sourceHeight:item.evidence.height as number,...(item.sourceProfileId==='jfif-ycbcr8-srgb-v1'?{jpegEvidence:item.evidence}:{}),
     width:clip!.rect.width,height:clip!.rect.height,creativeLutPath,lookCacheKey:creativeLutPath?JSON.stringify(item.look):null};
   });
   if(images.length){imageStage=await prepareTimelineImageLayers(images as never,destination,{signal,beforeEffect:effect},{checkMediaEffect,createPrivateTemporaryDirectory,validatePrivateDirectory,run,waitForMediaProcesses} as never);effect=imageStage.effect;}
   // An actual bounded float/colour conversion and LUT invocation, rather than
   // merely trusting the advertised filter names. No source media is consumed.
   const first=colour.clips[0],look=first?colourStage!.filter(first.clipId):'';
   await run('ffmpeg',['-hide_banner','-loglevel','error','-threads','1','-filter_threads','1','-f','lavfi','-i','color=c=black:s=16x16:r=30',
    '-vf',`${timelineColourInputFilter('limited')},${look}${TIMELINE_COLOUR_OUTPUT_FILTER}`,'-frames:v','1','-an','-f','null','-'],{timeout:15000,maxStdoutBytes:65536,maxStderrBytes:65536,signal,beforeEffect:effect});
   checkMediaEffect(effect,signal);colourStage!.verifyBytes();imageStage?.verifyBytes();beforeEncode?.();checkMediaEffect(effect,signal);
  }
  const subtitles=await prepareTimelineSubtitles(snapshot as never,work,{signal,beforeEffect:effect,...(owned?{openOwnedFile:owned.openOwnedFile,writeOwnedFile:owned.writeOwnedFile}:{})} as never);checkMediaEffect(effect,signal);
  const entries: string[]=[],ownedSegments: {file: string;outputFrames: number}[]=[];
  for(let segment=0;segment<plan.segments.length;segment++){
   checkMediaEffect(effect,signal);
   const selected=plan.segments[segment],begin=selected.beginFrame,end=selected.endFrame,frames=end-begin,samples=frames*SAMPLES_PER_FRAME;
   const clips=timeline.clips.filter(c=>c.startFrame<=begin&&c.startFrame+c.durationFrames>=end).sort((a,b)=>tracks.get(a.trackId)!.orderIndex-tracks.get(b.trackId)!.orderIndex||a.id.localeCompare(b.id));
   // This independently fences the exact PNG inputs opened by this segment,
   // not merely a nominal track count or a hidden-source descriptor.
   assertTimelineImageCompositorInputCount(clips.filter(clip=>colourClips.get(clip.id)?.kind==='image'&&!tracks.get(clip.trackId)!.hidden).length);
   const args: string[]=['-hide_banner','-loglevel','error',owned?'-y':'-n','-filter_complex_threads','1'];
   const inputs: {clip: TimelineClipRecord;asset: RenderAsset;visual: boolean;audio: boolean;input: number}[]=[];
   for(const clip of clips){
    const asset=assets.get(clip.assetId)!,track=tracks.get(clip.trackId)!,visual=track.kind==='video'&&!track.hidden,audio=!!asset.hasAudio&&!track.muted&&clip.gain>0;
    if(!visual&&!audio)continue;
    const input=inputs.length,isImage=asset.mimeType.startsWith('image/');
    args.push('-threads','1');
    if(isImage)args.push('-loop','1','-framerate',String(FPS));
    else args.push('-ss',seconds(clip.sourceInFrame+begin-clip.startFrame));
    // Managed images are already exact premultiplied RGBA8 at this clip's
    // rectangle. Decode/loop the private attempt-owned layer without repeating
    // float transfer, creative LUT or resize work for every timeline frame.
    const managedImage=colourClips.get(clip.id)?.kind==='image',imagePath=managedImage?imageStage?.path(clip.id):undefined;
    if(managedImage&&!imagePath)throw changedWork();
    args.push('-t',seconds(frames+1),'-i',(imagePath??asset.path) as string);
    inputs.push({clip,asset,visual,audio,input});
   }
   const filters=[`color=c=black:s=${width}x${height}:r=${FPS},trim=end_frame=${frames},setpts=N/(${FPS}*TB),format=${colour?'rgba':'yuv420p'}[base]`,timelineAudioSilenceFilter(samples)];
   let visual='base';const sounds=['silence'];
   for(const {clip,asset,input,visual:show,audio} of inputs){
    if(show){
     const {x,y,width,height}=clip.rect,label=`v${input}`,next=`layer${input}`;
     // rgba padding preserves the lower layers in the letterbox/pillarbox area.
     const planned=colourClips.get(clip.id),image=planned?.kind==='image';
     const opacityStage=opacity?.filterForSegment(clip.id,begin,frames,image?'premultiplied':'straight')??'';
     if(image){
      filters.push(`[${input}:v:0]format=rgba,setsar=1,fps=${FPS},tpad=stop_mode=clone:stop_duration=${seconds(frames)},trim=end_frame=${frames},setpts=N/(${FPS}*TB)${opacityStage?`,${opacityStage}`:''}[${label}]`);
     }else{
      const colourInput=colour?`${timelineColourInputFilter(planned!.range as never)},${colourStage!.filter(clip.id)}`:'';
      filters.push(`[${input}:${asset.videoStreamIndex??'v:0'}]setpts=PTS-STARTPTS,${colourInput}scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=${FPS},format=rgba,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,tpad=stop_mode=clone:stop_duration=${seconds(frames)},trim=end_frame=${frames},setpts=N/(${FPS}*TB)${opacityStage?`,${opacityStage}`:''}[${label}]`);
     }
     filters.push(`[${visual}][${label}]overlay=x=${x}:y=${y}:eof_action=pass:repeatlast=0:shortest=0${colour?':format=rgb':''}${image?':alpha=premultiplied':''}[${next}]`);visual=next;
    }
    if(audio){
     const label=`a${input}`;
     filters.push(timelineClipAudioFilter(clip as never,begin,samples,input,asset.audioStreamIndex as never));sounds.push(label);
    }
   }
   filters.push(timelineMixedAudioFilter(sounds,samples,selected.audioOutputTrim as never));
   const captioned=timelineSubtitleFilters(subtitles,begin,end,visual);filters.push(...captioned.filters);visual=captioned.visual;
   // Scale the completed editing-canvas composition, including captions. Clip
   // rectangles, subtitle layout/cues, source sampling and audio stay untouched.
   // Delivery scaling is independent of the project's native composition size.
   const scale=delivery&&(delivery.effective.width!==width||delivery.effective.height!==height)
    ?`scale=${delivery.effective.width}:${delivery.effective.height}:flags=${delivery.effective.scaling},setsar=1,`:'';
   filters.push(`[${visual}]${scale}trim=end_frame=${frames},${selected.videoOutputTrim}setpts=N/(${FPS}*TB),${colour?TIMELINE_COLOUR_OUTPUT_FILTER:'format=yuv420p'}[outv]`);
   const segmentFile=path.join(work,`segment-${String(segment).padStart(3,'0')}.mov`);
   const filterArgs=['-filter_complex',filters.join(';')];
   if(subtitles||colour){const script=path.join(work,`segment-${segment}.filter`);checkMediaEffect(effect,signal);await (owned?owned.writeOwnedFile(script,filters.join(';')):writeFile(script,filters.join(';'),{flag:'wx',mode:0o600}));checkMediaEffect(effect,signal);filterArgs.splice(0,2,'-/filter_complex',script);}
   const videoArgs=delivery?timelineExportVideoArgs(delivery as never):['-c:v','libx264','-preset','veryfast','-crf','23','-threads','2','-bf','0','-g','60','-pix_fmt','yuv420p','-r',String(FPS),'-video_track_timescale','30000'];
   args.push(...filterArgs,'-map','[outv]','-map','[outa]',...videoArgs,...(colour?TIMELINE_COLOUR_OUTPUT_ARGS:[]),'-c:a',floatChecked?'pcm_f32le':'pcm_s16le','-ar','48000','-ac','2','-t',seconds(selected.outputFrames),segmentFile);
   owned?.reserve(segmentFile);
   await run('ffmpeg',args,{timeout:Math.max(120000,frames/FPS*5000),signal,beforeEffect:effect});
   checkMediaEffect(effect,signal);
   if(floatChecked)ownedSegments.push({file:segmentFile,outputFrames:selected.outputFrames});
   entries.push(`file '${segmentFile.replaceAll("'","'\\''")}'\nduration ${seconds(selected.outputFrames)}`);
  }
  checkMediaEffect(effect,signal);
  const list=path.join(work,'segments.txt');await (owned?owned.writeOwnedFile(list,entries.join('\n')+'\n'):writeFile(list,entries.join('\n')+'\n'));
  checkMediaEffect(effect,signal);
  if(floatChecked){audioCheck=await checkFloatAudio(list,plan.outputFrames,{signal,beforeEffect:effect as never,ownedSegments});checkMediaEffect(effect,signal);assertTimelineFloatAudioAllowed(audioCheck as never);}
  // The fenced worker reserves and retains the destination inode and checks
  // it in beforeEffect. Only that owned empty output may be overwritten.
  await run('ffmpeg',['-hide_banner','-loglevel','error',owned?'-y':'-n','-f','concat','-safe','0','-i',list,'-map','0:v:0','-map','0:a:0','-c:v','copy',...(colour?TIMELINE_COLOUR_OUTPUT_ARGS:[]),'-video_track_timescale','30000','-af',floatChecked?'asetpts=N/SR/TB':`apad,atrim=end_sample=${plan.outputFrames*SAMPLES_PER_FRAME},asetpts=N/SR/TB`,'-c:a','aac','-b:a','128k','-ar','48000','-ac','2','-t',seconds(plan.outputFrames),'-movflags','+faststart',destination],{timeout:300000,signal,beforeEffect:effect});
  checkMediaEffect(effect,signal);
  const result=await probe(destination,{signal,beforeEffect:effect}),v=result.probe.streams.find(s=>s.codec_type==='video'),a=result.probe.streams.find(s=>s.codec_type==='audio');
  checkMediaEffect(effect,signal);
  const output=delivery?.effective||{width,height};
  if(result.width!==output.width||result.height!==output.height||v?.codec_name!=='h264'||v?.r_frame_rate!=='30/1'||v?.avg_frame_rate!=='30/1'||Number(v?.nb_frames)!==plan.outputFrames||a?.codec_name!=='aac'||Number(a?.sample_rate)!==48000||a?.channels!==2||Math.abs(result.duration-plan.outputFrames/FPS)>0.035)throw Error('Rendered timeline failed frame/duration/audio-format verification');
  if((delivery||plan.selected)&&(result.probe.streams.length!==2||v?.sample_aspect_ratio!=='1:1'||v?.pix_fmt!=='yuv420p'||v?.has_b_frames!==0||v?.time_base!=='1/30000'||a?.time_base!=='1/48000'||a?.channel_layout!=='stereo'
   ||!Number.isFinite(Number(v?.duration))||Math.abs(Number(v.duration)-plan.outputFrames/FPS)>0.00001
   ||!Number.isFinite(Number(a?.duration))||Math.abs(Number(a.duration)-plan.outputFrames/FPS)>0.025
   ||!String(result.probe.format?.format_name).split(',').includes('mp4')))throw Error('Rendered timeline failed delivery-profile verification');
  validateTimelineExportRangeOutputStart(plan as never,result.probe as never);
  if(colour){
   if(v?.color_primaries!=='bt709'||v?.color_transfer!=='bt709'||v?.color_space!=='bt709'||v?.color_range!=='tv')throw Object.assign(Error('The rendered SDR colour metadata does not match its frozen plan.'),{code:'TIMELINE_COLOUR_OUTPUT_INVALID'});
   colourStage!.verifyBytes();imageStage?.verifyBytes();checkMediaEffect(effect,signal);
  }
  return floatChecked?{...result,audioCheck}:result;
 }catch(error){const failure=error as {terminationUnconfirmed?: boolean};primaryFailure=error;unconfirmed=Boolean((floatChecked||colour)&&failure.terminationUnconfirmed===true);if(floatChecked&&audioCheck&&!signal?.aborted)rememberTimelineFloatAudioFailure(error,audioCheck as never);throw error;}
 finally{
  if(unconfirmed&&owned)void waitForMediaProcesses({signal}).then(()=>{imageStage?.cleanup();colourStage?.cleanup();owned.cleanup();});
  else if(owned){const imageCleaned=imageStage?.cleanup()??true,colourCleaned=colourStage?.cleanup()??true,cleaned=owned.cleanup();if((floatChecked||colour)&&(!cleaned||!colourCleaned||!imageCleaned)&&!primaryFailure){const failure=Object.assign(Error('The export staging cleanup could not be confirmed.'),{code:floatChecked?'EXPORT_AUDIO_STAGING_CHANGED':'TIMELINE_COLOUR_RESOURCE_CHANGED'});if(floatChecked&&!signal?.aborted)rememberTimelineFloatAudioFailure(failure,audioCheck??null);throw failure;}}
  else await rm(work,{recursive:true,force:true});
 }
}
