import {randomUUID} from 'node:crypto';
import {AppError,sourceFrameCount} from '@mioon/contracts';
import type {TimelineSourceRefreshed,TimelineSourceRefreshSkipped,TimelineShotAppended,TimelineShotAppendSkipped} from '@mioon/contracts';
import {replaceClipSource} from './timeline-replacement.ts';
import type {TimelineRecord} from './timeline-inputs.ts';
import type {TimelineRecoveryBoundary} from './timeline-recovery.ts';

export interface TimelineSourceRefreshPlan {refreshed: TimelineSourceRefreshed[];skipped: TimelineSourceRefreshSkipped[]}
export interface TimelineShotAppendPlan {appended: TimelineShotAppended[];skipped: TimelineShotAppendSkipped[]}
const category=(value: unknown): string|null=>typeof value==='string'?value.split('/')[0]:null;

// Both edits run inside the ordinary timeline edit transaction, on the copy it
// validates and saves. A clip's origin is the one generated version owning its
// asset, which also covers clips seeded from the storyboard without provenance.
function selectedVersion(timeline: TimelineRecord,boundary: TimelineRecoveryBoundary,shot: {id: string;selectedVersionId: string|null}){
 const version=boundary.version(shot.selectedVersionId as string,shot.id);
 if(version.projectId!==timeline.projectId||version.shotId!==shot.id)throw new AppError('INVALID_VERSION','版本不属于此镜头');
 const source=boundary.asset(version.assetId);
 if(source.sha256!==version.sha256)throw new AppError('ASSET_HASH_MISMATCH','镜头版本与素材哈希不一致',409);
 return {version,source};
}

/** Switches each listed clip to its shot's selected version with exactly the
 * replaceSource edit. A clip that is not generated, whose shot selects nothing,
 * that is already current, or whose new source cannot cover sourceInFrame +
 * durationFrames is skipped with its reason. Nothing to refresh writes nothing. */
export function refreshTimelineSources(timeline: TimelineRecord,boundary: TimelineRecoveryBoundary,clipIds: readonly string[]): TimelineSourceRefreshPlan{
 const shots=new Map(boundary.shots().map(shot=>[shot.id,shot] as const));
 const refreshed: TimelineSourceRefreshed[]=[],skipped: TimelineSourceRefreshSkipped[]=[];
 for(const clipId of clipIds){
  const clip=timeline.clips.find(item=>item.id===clipId);
  if(!clip)throw new AppError('CLIP_NOT_FOUND','片段不属于此时间线',404,{clipId});
  const from=boundary.legacySource(clip.assetId);
  if(!from){skipped.push({clipId,reason:'NOT_GENERATED'});continue;}
  const shot=shots.get(from.shotId);
  if(!shot?.selectedVersionId){skipped.push({clipId,reason:'NO_SELECTION',shotId:from.shotId,fromVersionId:from.id});continue;}
  if(shot.selectedVersionId===from.id){skipped.push({clipId,reason:'UP_TO_DATE',shotId:shot.id,fromVersionId:from.id});continue;}
  const {version:to,source}=selectedVersion(timeline,boundary,shot),previous=boundary.clipSource(clip);
  if(category(source.mimeType)!==category(previous.mimeType))throw new AppError('INVALID_CLIP_TYPE','替换素材必须与原素材同为视频、音频或图片',400);
  // A still has no source clock; moving media must cover the clip's range.
  if(category(source.mimeType)!=='image'){
   const available=sourceFrameCount(source.duration)??0,needed=clip.sourceInFrame+clip.durationFrames;
   if(available<needed){skipped.push({clipId,reason:'SOURCE_TOO_SHORT',shotId:shot.id,fromVersionId:from.id,toVersionId:to.id,shortByFrames:needed-available});continue;}
  }
  replaceClipSource(clip,source.id,to);
  refreshed.push({clipId,shotId:to.shotId,fromVersionId:from.id,toVersionId:to.id,assetId:source.id});
 }
 if(!refreshed.length)throw new AppError('NOTHING_TO_REFRESH','没有可以更新来源的片段',409,{skipped});
 return {refreshed,skipped};
}

/** Appends every shot that has no clip yet, in canvas order, as timeline.seed
 * would: its selected version at full length from frame 0, one after another
 * after the last clip on the first video track, pinned to that version like a
 * refreshed clip. Shots selecting nothing are skipped with a reason; existing
 * clips never move. */
export function appendTimelineShots(timeline: TimelineRecord,boundary: TimelineRecoveryBoundary): TimelineShotAppendPlan{
 const shots=boundary.shots();
 const lane=timeline.tracks.filter(item=>item.kind==='video').sort((a,b)=>a.orderIndex-b.orderIndex)[0];
 if(!lane)throw new AppError('TRACK_NOT_FOUND','时间线没有视频轨道',404);
 const present=new Set<string>();
 for(const clip of timeline.clips){const owner=boundary.legacySource(clip.assetId);if(owner)present.add(owner.shotId);}
 let startFrame=Math.max(0,...timeline.clips.filter(clip=>clip.trackId===lane.id).map(clip=>clip.startFrame+clip.durationFrames));
 const appended: TimelineShotAppended[]=[],skipped: TimelineShotAppendSkipped[]=[];
 for(const shot of shots){
  if(present.has(shot.id))continue;
  if(!shot.selectedVersionId){skipped.push({shotId:shot.id,reason:'NO_SELECTION'});continue;}
  const {version,source}=selectedVersion(timeline,boundary,shot);
  const durationFrames=sourceFrameCount(source.duration as number|null);
  if(durationFrames===null)throw new AppError('SOURCE_BOUNDS','所选版本没有有效时长');
  const clipId=randomUUID();
  timeline.clips.push({id:clipId,trackId:lane.id,assetId:source.id,name:shot.title as string,startFrame,durationFrames,sourceInFrame:0,
   rect:{x:0,y:0,width:timeline.width,height:timeline.height},gain:1,versionId:version.id,shotId:shot.id});
  appended.push({clipId,shotId:shot.id,versionId:version.id,startFrame,durationFrames});
  startFrame+=durationFrames;
 }
 if(!appended.length)throw new AppError('NOTHING_TO_APPEND','没有可以追加到时间线的镜头',409,{skipped});
 return {appended,skipped};
}
