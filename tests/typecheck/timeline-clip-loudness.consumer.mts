import {timelineClipLoudnessInputSchema, isTimelineClipLoudnessResponse, TIMELINE_CLIP_LOUDNESS_OPERATION} from '@mioon/contracts/timeline-clip-loudness';
import type {TimelineClipLoudnessInput, TimelineClipLoudnessResponse} from '@mioon/contracts/timeline-clip-loudness';
import {measureTimelineClipLoudness} from '@mioon/client/timeline-clip-loudness';
import type {TimelineClipLoudnessRpcClient} from '@mioon/client/timeline-clip-loudness';
declare const input: TimelineClipLoudnessInput;
declare const client: TimelineClipLoudnessRpcClient;
const operation: 'timeline.clip.loudness' = TIMELINE_CLIP_LOUDNESS_OPERATION;
const report: Promise<TimelineClipLoudnessResponse> = measureTimelineClipLoudness(client, input);
timelineClipLoudnessInputSchema.parse(input); isTimelineClipLoudnessResponse(await report, input);
// @ts-expect-error There is no target/candidate/apply authority on independent measurement.
input.target;
// @ts-expect-error Exact selection is mandatory.
const missing: TimelineClipLoudnessInput = {projectId: input.projectId, expectedRevision: 1, measurementProfile: input.measurementProfile};
// @ts-expect-error A full mix operation is not the clip observer.
client.rpc('timeline.loudness.prepare', input);
void operation; void missing;
