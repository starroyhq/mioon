import type {createTimelineMixLoudnessServices} from '../../packages/business/src/timeline-mix-loudness.ts';
import type {createTimelinePreflightServices} from '../../packages/business/src/timeline-preflight.ts';
import type {createTimelineServices} from '../../packages/business/src/timeline.ts';
import type {createEditTasks} from '../../packages/business/src/edit-tasks.ts';
import type {EditTask} from '../../packages/contracts/src/edit-tasks.ts';
import type {VolumeEnvelope} from '../../packages/contracts/src/timeline-volume-envelope.ts';
import type {FixtureTimeline, TimelineMutation} from './strict-timeline-core-types.ts';
import type {ServiceResponse} from './strict-service-responses.ts';
type Mix = ReturnType<typeof createTimelineMixLoudnessServices>;
type Preflight = ReturnType<typeof createTimelinePreflightServices>;
type Timeline = ReturnType<typeof createTimelineServices>;
export type StrictMixService = Omit<Mix,'handlers'> & {handlers:{'timeline.loudness.prepare':(...args: Parameters<Mix['handlers']['timeline.loudness.prepare']>)=>Promise<ServiceResponse<'timeline.loudness.prepare'>>}};
export type StrictPreflightService = Omit<Preflight,'handlers'> & {handlers:{'timeline.export.preflight':(...args: Parameters<Preflight['handlers']['timeline.export.preflight']>)=>Promise<ServiceResponse<'timeline.export.preflight'>>}};
export type StrictTimelineOperation = TimelineMutation|'timeline.render'|'timeline.format.set'|'timeline.clip.refreshSources'|'timeline.shots.append'|'timeline.clip.splitAtScenes'|'timeline.clip.crossfade';
export type StrictTimelineService = Omit<Timeline,'handlers'> & {handlers:{[O in StrictTimelineOperation]:(...args:Parameters<Timeline['handlers'][string]>)=>ServiceResponse<O>}};
export interface TimelineTaskEnvelope {instanceId: string; task: Omit<EditTask,'input'> & {input: Record<string,unknown> & {volumeEnvelope?:VolumeEnvelope|null;patch?:{volumeEnvelope?:VolumeEnvelope|null}}}; result?: FixtureTimeline; restore?:{workspaceOrigin:string; executionEpoch:string; held:boolean}}
type Tasks = ReturnType<typeof createEditTasks>;
export type StrictTimelineTasks = Omit<Tasks,'prepare'|'execute'|'get'|'reconcile'|'acknowledge'> & {
 prepare(...args:Parameters<Tasks['prepare']>):TimelineTaskEnvelope;
 execute(...args:Parameters<Tasks['execute']>):Promise<TimelineTaskEnvelope>;
 get(...args:Parameters<Tasks['get']>):TimelineTaskEnvelope;
 reconcile(...args:Parameters<Tasks['reconcile']>):TimelineTaskEnvelope;
 acknowledge(...args:Parameters<Tasks['acknowledge']>):TimelineTaskEnvelope;
};
