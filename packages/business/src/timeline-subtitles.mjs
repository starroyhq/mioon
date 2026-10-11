import {randomUUID} from 'node:crypto';
import {AppError,TIMELINE_SUBTITLE_PROFILE_ID} from '@mioon/contracts';

// These callbacks run only inside the existing timeline transaction. All
// ownership, CAS, aggregate validation, history and receipts remain shared.
export function createSubtitleMutations(mutate){
 const cue=(timeline,id)=>{
  const value=timeline.subtitles?.cues.find(item=>item.id===id);
  if(!value)throw new AppError('SUBTITLE_NOT_FOUND','字幕不属于此时间线',404,{cueId:id});
  return value;
 };
 return {
  'timeline.subtitle.add':input=>mutate('timeline.subtitle.add',input,timeline=>{
   if(!Object.hasOwn(timeline,'subtitles'))timeline.subtitles={profileId:TIMELINE_SUBTITLE_PROFILE_ID,cues:[]};
   timeline.subtitles.cues.push({id:randomUUID(),text:input.text,startFrame:input.startFrame,durationFrames:input.durationFrames});
  }),
  'timeline.subtitle.update':input=>mutate('timeline.subtitle.update',input,timeline=>{Object.assign(cue(timeline,input.cueId),input.patch);}),
  'timeline.subtitle.remove':input=>mutate('timeline.subtitle.remove',input,timeline=>{
   cue(timeline,input.cueId);timeline.subtitles.cues=timeline.subtitles.cues.filter(item=>item.id!==input.cueId);
  }),
 };
}
