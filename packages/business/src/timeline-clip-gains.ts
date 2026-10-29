import {AppError} from '@mioon/contracts';
import type {TimelineClipGainChange} from '@mioon/contracts';
import type {TimelineRecord} from './timeline-inputs.ts';
import type {TimelineRecoveryBoundary} from './timeline-recovery.ts';

// Runs inside the ordinary timeline edit transaction, on the copy it validates
// and saves; every rejection happens before the first write, so its rollback
// is provable. All listed gains change together and are recorded as one edit.
export function setTimelineClipGains(timeline: TimelineRecord,boundary: TimelineRecoveryBoundary,gains: readonly {clipId: string;gain: number}[]): {gains: TimelineClipGainChange[]}{
 const listed=gains.map(({clipId,gain})=>{
  const clip=timeline.clips.find(item=>item.id===clipId);
  if(!clip)throw new AppError('CLIP_NOT_FOUND','片段不属于此时间线',404,{clipId});
  const source=boundary.clipSource(clip);
  if(source.mimeType.startsWith('image/')||source.hasAudio!==true)throw new AppError('CLIP_GAINS_AUDIO_UNSUPPORTED','只能调整有声音的片段的增益',400,{clipId});
  return {clip,change:{clipId,previousGain:clip.gain,gain}};
 });
 if(listed.every(({change})=>change.previousGain===change.gain))
  throw new AppError('CLIP_GAINS_UNCHANGED','所列片段的增益都没有变化',409,{clipIds:gains.map(item=>item.clipId)});
 for(const {clip,change} of listed)clip.gain=change.gain;
 return {gains:listed.map(({change})=>change)};
}
