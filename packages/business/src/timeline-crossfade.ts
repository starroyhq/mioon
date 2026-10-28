import {AppError,timelineCrossfadeEnvelopes} from '@mioon/contracts';
import type {TimelineCrossfadeSummary} from '@mioon/contracts';
import type {TimelineRecord} from './timeline-inputs.ts';
import type {TimelineRecoveryBoundary} from './timeline-recovery.ts';

// Runs inside the ordinary timeline edit transaction, on the copy it validates
// and saves; every rejection happens before the first write, so its rollback
// is provable. Both curves change together and are recorded as one edit.
export function crossfadeTimelineClips(timeline: TimelineRecord,boundary: TimelineRecoveryBoundary,outgoingClipId: string,incomingClipId: string): {crossfade: TimelineCrossfadeSummary}{
 if(outgoingClipId===incomingClipId)throw new AppError('CROSSFADE_SAME_CLIP','交叉淡化需要两个不同的片段',400,{clipId:outgoingClipId});
 const find=(clipId: string)=>{
  const clip=timeline.clips.find(item=>item.id===clipId);
  if(!clip)throw new AppError('CLIP_NOT_FOUND','片段不属于此时间线',404,{clipId});
  return clip;
 };
 const outgoing=find(outgoingClipId),incoming=find(incomingClipId);
 const curves=timelineCrossfadeEnvelopes(outgoing,incoming);
 if(!curves)throw new AppError('CROSSFADE_GEOMETRY','两段需要在不同轨道上，后一段从前一段之内开始，且不早于前一段结束',400,
  {outgoingClipId,incomingClipId,outgoing:{trackId:outgoing.trackId,startFrame:outgoing.startFrame,durationFrames:outgoing.durationFrames},
   incoming:{trackId:incoming.trackId,startFrame:incoming.startFrame,durationFrames:incoming.durationFrames}});
 for(const clip of [outgoing,incoming]){
  const source=boundary.clipSource(clip);
  if(source.mimeType.startsWith('image/')||source.hasAudio!==true)throw new AppError('CROSSFADE_AUDIO_UNSUPPORTED','两个片段都需要有声音',400,{clipId:clip.id});
 }
 // The first version never merges into or replaces an existing user curve;
 // gain and fades stay and multiply the new curves.
 const enveloped=[outgoing,incoming].filter(clip=>clip.volumeEnvelope!=null).map(clip=>clip.id);
 if(enveloped.length)throw new AppError('CROSSFADE_ENVELOPE_EXISTS','片段已有音量包络，请先清除后再交叉淡化',409,{clipIds:enveloped});
 outgoing.volumeEnvelope=curves.outgoing;
 incoming.volumeEnvelope=curves.incoming;
 return {crossfade:{outgoingClipId,incomingClipId,startFrame:incoming.startFrame,durationFrames:curves.incoming.points[1].frame}};
}
