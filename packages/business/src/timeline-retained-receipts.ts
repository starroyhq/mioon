import {isTimelineRecord} from '../../contracts/src/timeline-replacement.ts';
import {TIMELINE_SHOT_SYNC_OPERATIONS} from '../../contracts/src/timeline-shot-sync.ts';
import {TIMELINE_SCENE_SPLIT_OPERATION} from '../../contracts/src/timeline-scene-split.ts';
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
