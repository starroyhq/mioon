import type {DatabaseSync} from 'node:sqlite';
import {AppError,TIMELINE_RESPONSE_BYTES,sourceFrameCount} from '@mioon/contracts';
import {CLIP_TRANSITION_LIMITS,canonicalClipTransition,clipTransitionFits,clipTransitionPredecessor,clipTransitionRoom,
 savedClipTransition,staleClipTransitions,validateClipTransition,type ClipTransition,type TransitionSources} from '../../contracts/src/timeline-clip-transition.ts';
import {readCurrentWorkspaceRole,isWorkspaceRoleSince} from './workspace-schema-dispatch.ts';
import type {TimelineRecord} from './timeline-inputs.ts';
import type {TimelineRecoveryBoundary} from './timeline-recovery.ts';

// The shared clip record type predates transitions; the field is optional.
type TransitionClipRecord=TimelineRecord['clips'][number]&{transitionIn?: unknown};

/** Persisted transitions exist from schema72 on. Every opened ordinary workspace
 * is upgraded first; anything else (an opacity candidate store, a restored copy
 * whose policy did not already refuse the write) fails before the first write. */
export function assertClipTransitionWorkspace(db: DatabaseSync): void {
 let allowed=false;
 try{allowed=isWorkspaceRoleSince(readCurrentWorkspaceRole(db),72,'ordinary');}catch{allowed=false;}
 if(!allowed)throw new AppError('CLIP_TRANSITION_WORKSPACE_REQUIRED','当前工作区不支持片段转场',409);
}
/** Source handles as the transition rules read them: a still repeats, a video
 * offers its whole frame count. Each lookup opens the media graph, so assets
 * are read once per edit. */
export function timelineTransitionSources(boundary: TimelineRecoveryBoundary): TransitionSources {
 const read=new Map<string, ReturnType<TransitionSources>>();
 return assetId=>{
  if(!read.has(assetId)){
   try{const source=boundary.asset(assetId),image=source.mimeType.startsWith('image/');read.set(assetId,{image,frames:image?0:sourceFrameCount(source.duration)??0});}
   catch{read.set(assetId,null);}
  }
  return read.get(assetId)!;
 };
}
// Runs inside the ordinary timeline edit transaction, on the copy it validates
// and saves; every rejection happens before the first write, so its rollback
// is provable. A cleared transition is removed from the clip, never saved as null.
export function setTimelineClipTransition(timeline: TimelineRecord,boundary: TimelineRecoveryBoundary,clipId: string,transition: ClipTransition|null): {clipId: string;previousTransition: ClipTransition|null;transition: ClipTransition|null}{
 const clip=timeline.clips.find(item=>item.id===clipId) as TransitionClipRecord|undefined;
 if(!clip)throw new AppError('CLIP_NOT_FOUND','片段不属于此时间线',404,{clipId});
 const track=timeline.tracks.find(item=>item.id===clip.trackId),source=boundary.clipSource(clip);
 if(track?.kind!=='video'||!(source.mimeType.startsWith('video/')||source.mimeType.startsWith('image/')))
  throw new AppError('CLIP_TRANSITION_UNSUPPORTED','只有视频轨上的视频或图片片段可以设置转场',400,{clipId});
 if(transition!==null){
  try{validateClipTransition(transition);}
  catch{throw new AppError('CLIP_TRANSITION_INVALID','转场的种类或时长无效',400,{clipId});}
 }
 const previous=canonicalClipTransition(savedClipTransition(clip)),next=canonicalClipTransition(transition);
 if(JSON.stringify(previous)===JSON.stringify(next))throw new AppError('CLIP_TRANSITION_UNCHANGED','这个切点已经是这个转场',409,{clipId});
 const sources=timelineTransitionSources(boundary);
 if(next!==null){
  if(!clipTransitionPredecessor(timeline.clips,clip))throw new AppError('CLIP_TRANSITION_NO_CUT','同一轨道上没有在此片段开始处结束的片段，不能设置转场',409,{clipId});
  if(!clipTransitionFits(timeline.clips,clip,next.durationFrames,sources))
   throw new AppError('CLIP_TRANSITION_ROOM','两段的素材余量或片段长度不够这个转场',409,{clipId,durationFrames:next.durationFrames,maxFrames:clipTransitionRoom(timeline.clips,clip,sources)});
 }
 const restore=()=>{if(previous===null)delete clip.transitionIn;else clip.transitionIn=previous;};
 if(next===null)delete clip.transitionIn;else clip.transitionIn=next;
 // The saved transitions all hold and this one fits beside them, so only the
 // segment bound can leave one without room now.
 if(next!==null&&staleClipTransitions(timeline as never,sources).length){
  restore();throw new AppError('CLIP_TRANSITION_LIMIT','转场过多，时间线的合成分段会超过上限',409,{clipId,maxSegments:CLIP_TRANSITION_LIMITS.segments});
 }
 // The saved record also gains a revision and a timestamp; keep a small margin.
 const actualBytes=Buffer.byteLength(JSON.stringify(timeline),'utf8');
 if(actualBytes>TIMELINE_RESPONSE_BYTES-64){
  restore();
  throw new AppError('CLIP_TRANSITION_LIMIT','时间线加上这个转场会超过保存上限',409,{clipId,maxBytes:TIMELINE_RESPONSE_BYTES,actualBytes});
 }
 return {clipId,previousTransition:previous,transition:next};
}
/** After any other edit, transitions without room left are removed, as the user
 * chose: the edit itself stands. Returns the incoming clips that lost one. */
export function pruneTimelineClipTransitions(timeline: TimelineRecord,boundary: TimelineRecoveryBoundary): string[]{
 if(!timeline.clips.some(clip=>Object.hasOwn(clip,'transitionIn')))return [];
 const stale=staleClipTransitions(timeline as never,timelineTransitionSources(boundary));
 for(const clip of timeline.clips as TransitionClipRecord[])if(stale.includes(clip.id))delete clip.transitionIn;
 return stale;
}
