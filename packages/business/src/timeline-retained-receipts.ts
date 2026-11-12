import {isTimelineRecord} from '../../contracts/src/timeline-replacement.ts';
import {isTimelineMutationResponse} from '../../contracts/src/timeline-acknowledgement.ts';
import {TIMELINE_SHOT_SYNC_OPERATIONS,TIMELINE_SOURCE_REFRESH_OPERATION,TIMELINE_SHOT_APPEND_OPERATION} from '../../contracts/src/timeline-shot-sync.ts';
import {TIMELINE_LOUDNESS_APPLY_OPERATION} from '../../contracts/src/timeline-loudness-apply.ts';
import {createTimelineSceneSplitContracts,TIMELINE_SCENE_SPLIT_OPERATION} from '../../contracts/src/timeline-scene-split.ts';
import {TIMELINE_CROSSFADE_OPERATION} from '../../contracts/src/timeline-crossfade.ts';
import {TIMELINE_CLIP_GAINS_OPERATION} from '../../contracts/src/timeline-clip-gains.ts';
import {TIMELINE_CLIP_TRANSFORM_OPERATION} from '../../contracts/src/timeline-clip-transform-operation.ts';
import {TIMELINE_CLIP_TRANSITION_OPERATION} from '../../contracts/src/timeline-clip-transition-operation.ts';

/** Operations whose receipt is {operation, requestId, timeline, ...outcomes}. */
export const WRAPPED_TIMELINE_OPERATIONS: readonly string[] = Object.freeze([...TIMELINE_SHOT_SYNC_OPERATIONS, TIMELINE_SCENE_SPLIT_OPERATION, TIMELINE_CROSSFADE_OPERATION, TIMELINE_CLIP_GAINS_OPERATION, TIMELINE_CLIP_TRANSFORM_OPERATION, TIMELINE_CLIP_TRANSITION_OPERATION]);

const JSON_BYTES = 4 * 1024 * 1024;
// Keys the scanners read as audio-role or colour evidence, and the keys their
// receipt adapter reads as a render receipt.
const evidenceKeys = new Set(['audioRole', 'audioRoleProfile', 'colour', 'colourPlan', 'profileId', 'timeline', 'snapshot', 'assets']);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function carriesEvidence(root: unknown): boolean {
  const pending = [{value: root, depth: 0}]; let nodes = 0;
  while (pending.length) {
    const {value, depth} = pending.pop()!;
    if (++nodes > 200000 || depth > 128) return true;
    if (value === null || typeof value !== 'object') continue;
    if (!Array.isArray(value) && Object.keys(value).some(key => evidenceKeys.has(key))) return true;
    for (const child of Object.values(value)) pending.push({value: child, depth: depth + 1});
  }
  return false;
}

/** Only a bound, complete wrapper without evidence hidden in outcomes can be
 * inspected as its saved timeline. The original object is never mutated. */
export function projectRetainedTimelineReceipt(root:unknown,requestId:unknown):unknown {
 if(!object(root)||!WRAPPED_TIMELINE_OPERATIONS.includes(root.operation as string)||Buffer.byteLength(JSON.stringify(root))>JSON_BYTES)return root;
 const {timeline,...outcomes}=root;
 return root.requestId===requestId&&object(timeline)&&isTimelineRecord(timeline,{projectId:timeline.projectId})&&!carriesEvidence(outcomes)?timeline:root;
}

/** Wrappers that carry their owner on the timeline rather than the response. */
export const TIMELINE_RECEIPT_WRAPPER_OPERATIONS: readonly string[] =
 Object.freeze([...WRAPPED_TIMELINE_OPERATIONS,TIMELINE_LOUDNESS_APPLY_OPERATION]);

const sceneSplitContracts=createTimelineSceneSplitContracts({isTimelineRecord});

/** The original input of a legacy receipt is not always retained. Validate the
 * envelope and the outcomes against its own timeline. Exact replay still uses
 * the original input and retained request digest. */
export function readWrappedTimelineReceipt(root: unknown, projectId: string, requestId: string) {
 if(!object(root)||!TIMELINE_RECEIPT_WRAPPER_OPERATIONS.includes(root.operation as string)||
  root.requestId!==requestId||!isTimelineRecord(root.timeline,{projectId}))return;
 const {operation,timeline}=root;
 const input={projectId,requestId,expectedRevision:timeline.revision-1};
 switch(operation){
  case TIMELINE_SOURCE_REFRESH_OPERATION:{
   if(!Array.isArray(root.refreshed)||!Array.isArray(root.skipped))return;
   // The lists retain order within each outcome class. Their interleaving in
   // the original request does not participate in this structural check.
   const clipIds=[...root.refreshed,...root.skipped].map(row=>object(row)?row.clipId:undefined);
   return isTimelineMutationResponse(operation,{...input,clipIds},root)?timeline:undefined;
  }
  case TIMELINE_SCENE_SPLIT_OPERATION:
   return sceneSplitContracts.isRetainedTimelineSceneSplitResponse(root,{projectId,requestId})?timeline:undefined;
  case TIMELINE_SHOT_APPEND_OPERATION:
   return isTimelineMutationResponse(operation,input,root)?timeline:undefined;
  case TIMELINE_CROSSFADE_OPERATION:{
   const summary=root.crossfade;
   if(!object(summary))return;
   const {outgoingClipId,incomingClipId}=summary;
   return isTimelineMutationResponse(operation,{...input,outgoingClipId,incomingClipId},root)?timeline:undefined;
  }
  case TIMELINE_CLIP_GAINS_OPERATION:{
   if(!Array.isArray(root.gains))return;
   const gains=root.gains.map(row=>object(row)?{clipId:row.clipId,gain:row.gain}:null);
   return isTimelineMutationResponse(operation,{...input,gains},root)?timeline:undefined;
  }
  case TIMELINE_CLIP_TRANSFORM_OPERATION:
   return isTimelineMutationResponse(operation,{...input,clipId:root.clipId,transform:root.transform},root)?timeline:undefined;
  case TIMELINE_CLIP_TRANSITION_OPERATION:
   return isTimelineMutationResponse(operation,{...input,clipId:root.clipId,transition:root.transition},root)?timeline:undefined;
  case TIMELINE_LOUDNESS_APPLY_OPERATION:{
   const application=root.application;
   if(!object(application))return;
   const {candidateDigest,snapshotSha256,mixProfile,measurementProfile,target}=application;
   return isTimelineMutationResponse(operation,{...input,candidateDigest,snapshotSha256,mixProfile,measurementProfile,target},root)?timeline:undefined;
  }
 }
}
