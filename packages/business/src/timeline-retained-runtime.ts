import {schemas} from '../../contracts/src/index.ts';
import {isTimelineRecord} from '../../contracts/src/timeline-replacement.ts';
import {isTimelineRenderRecord,TIMELINE_RENDER_RESPONSE_BYTES} from '../../contracts/src/timeline-acknowledgement.ts';

/** Static current predicates. No startup installer, old profile or mutable
 * registration can substitute the validators used by retained row admission. */
export const timelineRetainedRuntime=Object.freeze({
 isTimelineRecord,isTimelineRenderRecord,timelineRenderResponseBytes:TIMELINE_RENDER_RESPONSE_BYTES,
 validateClipIntent:(operation:'timeline.clip.add'|'timeline.clip.update',value:unknown):boolean=>schemas[operation].safeParse(value).success,
});
