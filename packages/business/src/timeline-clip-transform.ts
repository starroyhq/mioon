import type {DatabaseSync} from 'node:sqlite';
import {AppError,TIMELINE_RESPONSE_BYTES} from '@mioon/contracts';
import {canonicalClipTransform,validateClipTransform,type ClipTransform} from '../../contracts/src/timeline-clip-transform.ts';
import {readCurrentWorkspaceRole,isWorkspaceRoleSince} from './workspace-schema-dispatch.ts';
import type {TimelineRecord} from './timeline-inputs.ts';
import type {TimelineRecoveryBoundary} from './timeline-recovery.ts';

/** Persisted transforms exist from schema70 on. Every opened ordinary workspace
 * is upgraded first; anything else (an opacity candidate store, a restored copy
 * whose policy did not already refuse the write) fails before the first write. */
export function assertClipTransformWorkspace(db: DatabaseSync): void {
 let allowed=false;
 try{allowed=isWorkspaceRoleSince(readCurrentWorkspaceRole(db),70,'ordinary');}catch{allowed=false;}
 if(!allowed)throw new AppError('CLIP_TRANSFORM_WORKSPACE_REQUIRED','当前工作区不支持片段变换',409);
}
// Runs inside the ordinary timeline edit transaction, on the copy it validates
// and saves; every rejection happens before the first write, so its rollback
// is provable. A cleared transform is removed from the clip, never saved as null.
export function setTimelineClipTransform(timeline: TimelineRecord,boundary: TimelineRecoveryBoundary,clipId: string,transform: ClipTransform|null): {clipId: string;previousTransform: ClipTransform|null;transform: ClipTransform|null}{
 // The shared clip record type predates transforms; the field is optional.
 const clip=timeline.clips.find(item=>item.id===clipId) as (TimelineRecord['clips'][number]&{transform?: unknown})|undefined;
 if(!clip)throw new AppError('CLIP_NOT_FOUND','片段不属于此时间线',404,{clipId});
 const track=timeline.tracks.find(item=>item.id===clip.trackId),source=boundary.clipSource(clip);
 if(track?.kind!=='video'||!(source.mimeType.startsWith('video/')||source.mimeType.startsWith('image/')))
  throw new AppError('CLIP_TRANSFORM_UNSUPPORTED','只有视频轨上的视频或图片片段可以设置变换',400,{clipId});
 if(transform!==null){
  try{validateClipTransform(transform,clip.durationFrames);}
  catch{throw new AppError('CLIP_TRANSFORM_INVALID','关键帧不能超出片段时长',400,{clipId,durationFrames:clip.durationFrames});}
 }
 const previous=canonicalClipTransform((clip.transform??null) as ClipTransform|null),next=canonicalClipTransform(transform);
 if(JSON.stringify(previous)===JSON.stringify(next))throw new AppError('CLIP_TRANSFORM_UNCHANGED','片段已经是这个变换',409,{clipId});
 if(next===null)delete clip.transform;else clip.transform=next;
 // The saved record also gains a revision and a timestamp; keep a small margin.
 const actualBytes=Buffer.byteLength(JSON.stringify(timeline),'utf8');
 if(actualBytes>TIMELINE_RESPONSE_BYTES-64){
  if(previous===null)delete clip.transform;else clip.transform=previous;
  throw new AppError('CLIP_TRANSFORM_LIMIT','时间线加上这个变换会超过保存上限',409,{clipId,maxBytes:TIMELINE_RESPONSE_BYTES,actualBytes});
 }
 return {clipId,previousTransform:previous,transform:next};
}
