import {randomUUID} from 'node:crypto';
import {AppError,TIMELINE_SUBTITLE_PROFILE_ID} from '@mioon/contracts';
import type {TimelineSubtitleCueRecord,TimelineSubtitlesRecord} from './timeline-inputs.ts';

type SubtitleTimeline={subtitles?: TimelineSubtitlesRecord};
type SubtitleMutationInput={
 projectId: string;requestId: string;expectedRevision: number;
 text: string;startFrame: number;durationFrames: number;cueId: string;
 patch: {text?: string;startFrame?: number;durationFrames?: number};
};
type SubtitleMutate=(operation: string,input: SubtitleMutationInput,apply: (timeline: SubtitleTimeline)=>void)=>unknown;

// These callbacks run only inside the existing timeline transaction. All
// ownership, CAS, aggregate validation, history and receipts remain shared.
export function createSubtitleMutations(mutate: SubtitleMutate){
 const cue=(timeline: SubtitleTimeline,id: string): TimelineSubtitleCueRecord=>{
  const value=timeline.subtitles?.cues.find(item=>item.id===id);
  if(!value)throw new AppError('SUBTITLE_NOT_FOUND','字幕不属于此时间线',404,{cueId:id});
  return value;
 };
 return {
  'timeline.subtitle.add':(input: SubtitleMutationInput)=>mutate('timeline.subtitle.add',input,timeline=>{
   if(!Object.hasOwn(timeline,'subtitles'))timeline.subtitles={profileId:TIMELINE_SUBTITLE_PROFILE_ID,cues:[]};
   timeline.subtitles!.cues.push({id:randomUUID(),text:input.text,startFrame:input.startFrame,durationFrames:input.durationFrames});
  }),
  'timeline.subtitle.update':(input: SubtitleMutationInput)=>mutate('timeline.subtitle.update',input,timeline=>{Object.assign(cue(timeline,input.cueId),input.patch);}),
  'timeline.subtitle.remove':(input: SubtitleMutationInput)=>mutate('timeline.subtitle.remove',input,timeline=>{
   cue(timeline,input.cueId);timeline.subtitles!.cues=timeline.subtitles!.cues.filter(item=>item.id!==input.cueId);
  }),
 };
}
