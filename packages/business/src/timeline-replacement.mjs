import {AppError} from '@mioon/contracts';
import {createTimelineRecoveryBoundary,TIMELINE_REPLACEMENT_RESPONSE_BYTES} from './timeline-recovery.mjs';

export const REPLACEMENT_RESPONSE_BYTES=TIMELINE_REPLACEMENT_RESPONSE_BYTES;
const category=value=>typeof value==='string'?value.split('/')[0]:null;
const provenance=['versionId','shotId','jobId'];

// Source replacement shares the common receipt/ownership boundary with every
// other keyed timeline write. Its only distinct behavior is the source edit.
export function createTimelineReplacementBoundary(db,input){
 const boundary=createTimelineRecoveryBoundary(db,input);
 function read(){
  const timeline=boundary.read();
  if(!timeline)throw new AppError('CLIP_NOT_FOUND','片段不属于此时间线',404);
  return timeline;
 }
 function apply(timeline){
  const clip=timeline.clips.find(clip=>clip.id===input.clipId);
  if(!clip)throw new AppError('CLIP_NOT_FOUND','片段不属于此时间线',404);
  const previous=boundary.clipSource(clip),source=boundary.asset(input.assetId);
  if(previous.id===source.id)throw new AppError('SOURCE_UNCHANGED','片段已使用此素材，无需替换',409);
  if(!['video','audio','image'].includes(category(source.mimeType))||category(previous.mimeType)!==category(source.mimeType))
   throw new AppError('INVALID_CLIP_TYPE','替换素材必须与原素材同为视频、音频或图片',400);
  const version=input.versionId===undefined?null:boundary.version(input.versionId,undefined,source.id);
  for(const key of provenance)delete clip[key];
  clip.assetId=source.id;
  if(version){clip.versionId=version.id;clip.shotId=version.shotId;}
 }
 return {...boundary,read,apply};
}
