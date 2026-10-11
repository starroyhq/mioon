import {AppError,sourceFrameCount,getTimelineFadeIssue,timelineOutputPreset,getTimelineSubtitleIssue,TIMELINE_SUBTITLE_PROFILE_ID,TIMELINE_SUBTITLE_FONT_SHA256} from '@mioon/contracts';

const integer=(value,min,max)=>Number.isInteger(value)&&value>=min&&value<=max;
function invalid(message){throw Object.assign(Error(message),{code:'INVALID_TIMELINE_SNAPSHOT'});}

// Defense in depth for recovered, persisted jobs. The service performs the same
// public validation, but the renderer must never interpret arbitrary effects.
export function validateTimeline(timeline,assets,{structureOnly=false}={}){
 // Preserve the legacy rejection wording for malformed legacy inputs. The
 // accepted output set is still the closed shared preset list above.
 if(!timelineOutputPreset(timeline))invalid('Timeline output must be 720×1280 at 30 fps');
 const WIDTH=timeline.width,HEIGHT=timeline.height;
 if(!Array.isArray(timeline.tracks)||timeline.tracks.length>12||!Array.isArray(timeline.clips)||!timeline.clips.length||timeline.clips.length>100)invalid('Timeline requires 1–100 clips and at most 12 tracks');
 const tracks=new Map();
 for(const t of timeline.tracks){if(!t||!t.id||tracks.has(t.id)||!['video','audio'].includes(t.kind)||!Number.isInteger(t.orderIndex)||typeof t.hidden!=='boolean'||typeof t.muted!=='boolean'||(t.kind==='audio'&&t.hidden))invalid('Invalid timeline track');tracks.set(t.id,t);}
 let duration=0;const ids=new Set();
 for(const c of timeline.clips){
  if(!c||typeof c!=='object')invalid('Missing, duplicate, or unresolvable timeline clip');
  const t=tracks.get(c.trackId),a=assets.get(c.assetId),r=c.rect;
  if(!c.id||ids.has(c.id)||!t||!a)invalid('Missing, duplicate, or unresolvable timeline clip');ids.add(c.id);
  if(!integer(c.startFrame,0,18000)||!integer(c.durationFrames,1,18000)||!integer(c.sourceInFrame,0,Number.MAX_SAFE_INTEGER-18000)||c.startFrame+c.durationFrames>18000)invalid('Invalid frame range');
  if(!r||!integer(r.x,0,WIDTH)||!integer(r.y,0,HEIGHT)||!integer(r.width,2,WIDTH)||!integer(r.height,2,HEIGHT)||[r.x,r.y,r.width,r.height].some(v=>v%2)||r.x+r.width>WIDTH||r.y+r.height>HEIGHT)invalid('Invalid clip rectangle');
  if(!Number.isFinite(c.gain)||c.gain<0||c.gain>2)invalid('Invalid clip gain');
  const fadeIssue=getTimelineFadeIssue(c,structureOnly?{...a,hasAudio:true}:a);if(fadeIssue)invalid(fadeIssue.message);
  const isImage=a.mimeType?.startsWith('image/'),isVideo=a.mimeType?.startsWith('video/'),isAudio=['audio/wav','audio/mpeg','audio/mp4'].includes(a.mimeType);
  if(t.kind==='video'?(!isImage&&!isVideo):!isAudio)invalid('Asset is not supported on this track');
  if(!structureOnly&&(t.kind==='video'&&!a.hasVideo||t.kind==='audio'&&!a.hasAudio))invalid('Asset has no required media stream');
  if(isImage?c.sourceInFrame!==0:(!structureOnly&&c.sourceInFrame+c.durationFrames>(sourceFrameCount(a.duration)??0)))invalid('Clip exceeds source duration');
  for(const effect of ['transition','transitions','effects','speed','rate','opacity','blendMode'])if(c[effect]!==undefined)invalid(`Unsupported timeline effect: ${effect}`);
  duration=Math.max(duration,c.startFrame+c.durationFrames);
 }
 for(const t of tracks.values()){const clips=timeline.clips.filter(c=>c.trackId===t.id).sort((a,b)=>a.startFrame-b.startFrame);for(let i=1;i<clips.length;i++)if(clips[i].startFrame<clips[i-1].startFrame+clips[i-1].durationFrames)invalid('Clips overlap on one track');}
 if(timeline.durationFrames!==duration)invalid('Timeline duration does not match clips');
 if(Object.hasOwn(timeline,'subtitles')){const issue=getTimelineSubtitleIssue(timeline.subtitles,duration);if(issue)invalid(issue.message);}
 return tracks;
}


// Keep this projection and source order identical for both new exports and
// preflight digests. Omitted legacy fields stay omitted in frozen responses.
export function freezeTimelineSnapshot(timeline,assets){
 return JSON.parse(JSON.stringify({timeline,...(timeline.subtitles?.cues.length?{subtitleProfile:{profileId:TIMELINE_SUBTITLE_PROFILE_ID,fontSha256:TIMELINE_SUBTITLE_FONT_SHA256}}:{}),assets:[...new Set(timeline.clips.map(item=>item.assetId))].map(id=>{
  const source=assets.get(id);
  if(!source)throw Object.assign(Error('Timeline snapshot does not match managed asset'),{code:'TIMELINE_SOURCE_UNAVAILABLE'});
  return {id:source.id,sha256:source.sha256,mimeType:source.mimeType,duration:source.duration,width:source.width,height:source.height,
   hasAudio:typeof source.hasAudio==='boolean'?source.hasAudio:null,relativePath:source.relativePath};
 })}));
}

export const TIMELINE_LIMITS=Object.freeze({fps:30,width:720,height:1280,tracks:12,clips:100,durationFrames:18000});
const visualTypes=new Set(['image/png','image/jpeg','image/webp','video/mp4','video/webm']);
const audioTypes=new Set(['audio/mpeg','audio/wav','audio/mp4']);
export function validateSavedTimeline(timeline,{track,asset}){
  if(timeline.tracks.length>TIMELINE_LIMITS.tracks||timeline.clips.length>TIMELINE_LIMITS.clips)
   throw new AppError('TIMELINE_LIMIT','时间线最多支持12条轨道和100个片段',400,TIMELINE_LIMITS);
  let duration=0;
  for(const item of timeline.clips){
   const lane=track(timeline,item.trackId),source=asset(timeline.projectId,item.assetId);
   if(!(lane.kind==='audio'?audioTypes:visualTypes).has(source.mimeType))
    throw new AppError('INVALID_CLIP_TYPE','视频轨道只接收图片/视频，音频轨道只接收音频',400,{clipId:item.id,trackId:lane.id,assetId:source.id});
   const fadeIssue=getTimelineFadeIssue(item,source);
   if(fadeIssue)throw new AppError(fadeIssue.code,fadeIssue.message,400,fadeIssue.details);
   const end=item.startFrame+item.durationFrames;
   if(end>TIMELINE_LIMITS.durationFrames)
    throw new AppError('TIMELINE_LIMIT','时间线总时长不能超过18000帧（10分钟）',400,{maxDurationFrames:TIMELINE_LIMITS.durationFrames});
   if(source.mimeType.startsWith('image/')){
    if(item.sourceInFrame!==0)throw new AppError('SOURCE_BOUNDS','图片的素材入点必须为0',400,{clipId:item.id});
   }else{
    // A fractional final frame cannot supply a complete output frame. The tiny
    // tolerance only absorbs the binary representation of exact 30fps times.
    const sourceFrames=sourceFrameCount(source.duration)??0;
    if(sourceFrames<1||item.sourceInFrame+item.durationFrames>sourceFrames)
     throw new AppError('SOURCE_BOUNDS','素材入点和片段时长超出素材范围',400,{clipId:item.id,assetId:source.id,availableFrames:sourceFrames});
   }
   duration=Math.max(duration,end);
  }
  for(const lane of timeline.tracks){
   const clips=timeline.clips.filter(item=>item.trackId===lane.id).sort((a,b)=>a.startFrame-b.startFrame);
   for(let index=1;index<clips.length;index++){
    const previous=clips[index-1],current=clips[index];
    if(current.startFrame<previous.startFrame+previous.durationFrames)
     throw new AppError('CLIP_OVERLAP','同一轨道的片段不能重叠，可以首尾相接',409,{trackId:lane.id,clipIds:[previous.id,current.id]});
   }
  }
  if(Object.hasOwn(timeline,'subtitles')){const issue=getTimelineSubtitleIssue(timeline.subtitles,duration);if(issue)throw new AppError(issue.code,issue.message,400,issue.details);}
  timeline.durationFrames=duration;
  return timeline;
 }
