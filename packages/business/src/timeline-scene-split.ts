import {AppError} from '@mioon/contracts';
import type {TimelineSceneSplitRow,TimelineSceneSplitSkipped} from '@mioon/contracts';
import type {TimelineClipRecord,TimelineRecord} from './timeline-inputs.ts';

export interface TimelineSceneSplitPlan {split: TimelineSceneSplitRow[];skipped: TimelineSceneSplitSkipped[]}

/** Splits every clip of the asset at each cut strictly inside its source range,
 * left to right, with the single-split edit supplied by the caller. A cut
 * inside an audio fade-in or fade-out is left out, as a single split would
 * refuse it there. Runs inside the ordinary timeline edit transaction; with
 * nothing to split it throws before anything is written. */
export function splitTimelineAtScenes(timeline: TimelineRecord,assetId: string,cuts: readonly number[],split: (clip: TimelineClipRecord,atFrame: number)=>TimelineClipRecord): TimelineSceneSplitPlan{
 const rows: TimelineSceneSplitRow[]=[],skipped: TimelineSceneSplitSkipped[]=[];
 for(const clip of timeline.clips.filter(item=>item.assetId===assetId)){
  const start=clip.sourceInFrame,inside=cuts.filter(frame=>frame>start&&frame<start+clip.durationFrames);
  if(!inside.length){skipped.push({clipId:clip.id,reason:'NO_CUT_IN_RANGE'});continue;}
  const fadeIn=clip.fadeInFrames??0,fadeOut=clip.fadeOutFrames??0;
  const cutFrames=inside.filter(frame=>frame-start>=fadeIn&&frame-start<=clip.durationFrames-fadeOut),fadeCutFrames=inside.filter(frame=>!cutFrames.includes(frame));
  if(!cutFrames.length){skipped.push({clipId:clip.id,reason:'FADE_BOUNDS',cutFrames:fadeCutFrames});continue;}
  // Each split shortens the current piece and inserts the next one after it.
  const clipIds=[clip.id];let piece=clip;
  for(const frame of cutFrames){piece=split(piece,clip.startFrame+frame-start);clipIds.push(piece.id);}
  rows.push({clipId:clip.id,clipIds,cutFrames,fadeCutFrames});
 }
 if(!rows.length)throw new AppError('NOTHING_TO_SPLIT','没有可以按切点分割的片段',409,{skipped});
 return {split:rows,skipped};
}
