import type {SceneDetectTaskResponse,SceneTaskResponse,SceneResultResponse} from '../../packages/contracts/src/scene-tasks.ts';
import type {OpacityRenderCandidatePlan} from '../../packages/contracts/src/timeline-opacity-render-candidate.ts';
import type {OrdinaryServices, ShotRecord} from '../../packages/business/src/services.ts';
import type {WorkspaceStore} from '../../packages/business/src/db.ts';
import type {TimelineRecord as TimelineBase, TimelineClipRecord as ClipBase} from '../../packages/business/src/timeline-inputs.ts';
import type {TimelineClipColour, TimelineColourPlan, TimelineColourSourceInspection, TimelineImageSourceInspection, TimelineJpegSourceInspection} from '../../packages/contracts/src/timeline-colour.ts';
import type {VolumeEnvelope} from '../../packages/contracts/src/timeline-volume-envelope.ts';
import type {OpacityEnvelope} from '../../packages/contracts/src/timeline-opacity-envelope.ts';
import type {ExportPreflightResponse} from '../../packages/contracts/src/export-preflight.ts';
import type {TimelineMixLoudnessResponse} from '../../packages/contracts/src/timeline-mix-loudness.ts';
import type {TimelineLoudnessApplyResponse} from '../../packages/contracts/src/timeline-loudness-apply.ts';
import type {TimelineSourceRefreshResponse, TimelineShotAppendResponse} from '../../packages/contracts/src/timeline-shot-sync.ts';
import type {TimelineSceneSplitResponse} from '../../packages/contracts/src/timeline-scene-split.ts';
import type {TimelineCrossfadeResponse} from '../../packages/contracts/src/timeline-crossfade.ts';
import type {TimelineClipGainsResponse} from '../../packages/contracts/src/timeline-clip-gains.ts';
import type {TimelineClipTransformResponse} from '../../packages/contracts/src/timeline-clip-transform-operation.ts';
import type {WaveformResponse} from '../../packages/contracts/src/waveforms.ts';
import type {WorkspaceRestoreInspection} from '../../packages/contracts/src/workspace-restore.ts';
import type {TimelineExportAudioCheck, TimelineExportEffectiveV2, TimelineExportSettings, TimelineExportDelivery} from '../../packages/contracts/src/timeline-export-float.ts';
import type {TimelineOutputGeometry} from '../../packages/contracts/src/timeline-output-geometry.ts';
import type {createClient} from '../../packages/client/src/index.ts';
export interface FixtureClip extends Omit<ClipBase,'colour'|'volumeEnvelope'|'opacityEnvelope'> {colour?: TimelineClipColour; volumeEnvelope?: VolumeEnvelope|null; opacityEnvelope?: OpacityEnvelope|null}
export interface FixtureTimeline extends Omit<TimelineBase,'clips'> {clips: FixtureClip[]}
export interface FixtureProject {id: string; name: string; description: string; revision: number; createdAt: string; updatedAt: string}
export interface FixtureAsset {id: string; projectId: string; name: string; mimeType: string; relativePath: string; url: string; sha256: string; sizeBytes: number; duration: number; width: number; height: number; hasAudio: boolean; hasVideo: boolean; createdAt: string; provenance?: string; sourceAssetId?: string; sourceTaskId?: string; videoStreamIndex?: number; audioStreamIndex?: number}
export interface FixtureShot extends ShotRecord {title: string; status: string; durationSeconds: number; orderIndex: number}
export interface FixtureVersion {id: string; projectId: string; shotId: string; jobId: string; number: number; assetId: string; sha256: string; url: string}
export interface FixtureJob {id: string; projectId: string; shotId: string; versionId: string; status: string; error: {code: string; message: string;retryable?:boolean}|null}
export interface FixtureSnapshotAsset {id:string;sha256:string;mimeType:string;duration?:number|null;width?:number|null;height?:number|null;hasAudio?:boolean|null;relativePath?:string}
export interface FixtureSnapshot {opacityPlan?:OpacityRenderCandidatePlan;timeline: FixtureTimeline; assets: FixtureSnapshotAsset[]; colourPlan?: TimelineColourPlan; exportRange?: {startFrame: number; endFrame: number}; volumeEnvelopeProfile?: string; delivery?: TimelineExportDelivery; deliveryName?: string; audioRoleProfile?: string}
export interface FixtureExport {id: string; projectId: string; requestId: string; mode: 'timeline'; purpose: string; status: string; timelineRevision: number; snapshot: FixtureSnapshot; assetId: string|null; url: string|null; error: {code: string; message: string; retryable?:boolean}|null; orderedVersionIds?:string[];audioCheck?: TimelineExportAudioCheck; renderAttemptId?: string; createdAt: string; updatedAt: string}
/** Legacy storyboard enqueue freezes version pointers rather than a timeline. */
export interface FixtureStoryboardExport {
 id:string;projectId:string;requestId:string;status:string;outputGeometry:TimelineOutputGeometry;
 orderedVersionIds:string[];snapshot:{versionId:string;assetId:string;sha256:string;shotId:string}[];
 mode?:undefined;purpose?:undefined;timelineRevision?:undefined;
 assetId:string|null;url:string|null;error:{code:string;message:string;retryable?:boolean}|null;
 createdAt:string;updatedAt:string;
}
export type FixtureExportRecord = FixtureExport | FixtureStoryboardExport;

export interface FixtureHistoryEntry {createdAt:string;id: string; operation: string; requestId: string; beforeRevision: number; afterRevision: number}
export interface FixtureHistory {projectId: string; timelineId: string|null; revision: number|null; cursor: number; length: number; canUndo: boolean; canRedo: boolean; undoEntry: FixtureHistoryEntry|null; redoEntry: FixtureHistoryEntry|null}
export interface FixtureLut {id: string; projectId: string; sha256: string; profile: string; relativePath: string; name: string}
export interface FixtureProjectDetail {project: FixtureProject; timeline: FixtureTimeline; assets: FixtureAsset[]; shots: FixtureShot[]; versions: FixtureVersion[]; jobs: FixtureJob[]}
export type TimelineMutation = 'timeline.get'|'timeline.track.add'|'timeline.track.update'|'timeline.clip.add'|'timeline.clip.update'|'timeline.clip.remove'|'timeline.clip.replaceSource'|'timeline.clip.split'|'timeline.clip.rippleRemove'|'timeline.undo'|'timeline.redo'|'timeline.seed'|'timeline.subtitle.add'|'timeline.subtitle.update'|'timeline.subtitle.remove';
export type FixtureServiceResult<O extends string> = O extends 'scene.detect' ? SceneDetectTaskResponse : O extends 'scene.task.get' ? SceneTaskResponse : O extends 'scene.result.get' ? SceneResultResponse : O extends TimelineMutation ? FixtureTimeline : O extends 'project.create' ? FixtureProject : O extends 'project.get' ? FixtureProjectDetail : O extends 'project.list' ? FixtureProject[] : O extends 'shot.create' ? FixtureShot : O extends 'asset.import' ? FixtureAsset : O extends 'version.select' ? FixtureShot : O extends 'generation.submit'|'job.get' ? FixtureJob : O extends 'timeline.render' ? FixtureExport : O extends 'export.create' ? FixtureStoryboardExport : O extends 'export.get' ? FixtureExportRecord : O extends 'timeline.history.get' ? FixtureHistory : O extends 'lut.import'|'lut.inspect' ? {resource: FixtureLut} : O extends 'timeline.colour.source.inspect' ? TimelineColourSourceInspection : O extends 'timeline.colour.image.inspect' ? TimelineImageSourceInspection : O extends 'timeline.colour.jpeg.inspect' ? TimelineJpegSourceInspection : O extends 'timeline.export.preflight' ? ExportPreflightResponse : O extends 'timeline.loudness.prepare' ? TimelineMixLoudnessResponse : O extends 'timeline.loudness.apply' ? TimelineLoudnessApplyResponse : O extends 'timeline.clip.refreshSources' ? Omit<TimelineSourceRefreshResponse,'timeline'> & {timeline:FixtureTimeline} : O extends 'timeline.shots.append' ? Omit<TimelineShotAppendResponse,'timeline'> & {timeline:FixtureTimeline} : O extends 'timeline.clip.splitAtScenes' ? Omit<TimelineSceneSplitResponse,'timeline'> & {timeline:FixtureTimeline} : O extends 'timeline.clip.crossfade' ? Omit<TimelineCrossfadeResponse,'timeline'> & {timeline:FixtureTimeline} : O extends 'timeline.clip.setGains' ? Omit<TimelineClipGainsResponse,'timeline'> & {timeline:FixtureTimeline} : O extends 'timeline.clip.setTransform' ? Omit<TimelineClipTransformResponse,'timeline'> & {timeline:FixtureTimeline} : O extends 'asset.waveform.get'|'asset.waveform.request' ? WaveformResponse : O extends 'workspace.restore.inspect' ? WorkspaceRestoreInspection : O extends 'timeline.format.set' ? FixtureTimeline : unknown;
export type FixtureCall = <O extends string>(operation: O,input: unknown,context?: Parameters<OrdinaryServices['call']>[2])=>Promise<FixtureServiceResult<O>>;
export type FixtureServices = Omit<OrdinaryServices,'call'> & {call: FixtureCall};
interface FixtureTables {timelines: FixtureTimeline; projects: FixtureProject; assets: FixtureAsset; shots: FixtureShot; versions: FixtureVersion; jobs: FixtureJob; exports: FixtureExportRecord}
export type FixtureStore = Omit<WorkspaceStore,'get'|'list'> & {get<T extends keyof FixtureTables>(table:T,id:string): FixtureTables[T]|null;get(table:string,id:string):unknown;list<T extends keyof FixtureTables>(table:T,projectId?:string):FixtureTables[T][];list(table:string,projectId?:string):unknown[]};
export type FixtureClient = Omit<ReturnType<typeof createClient>,'rpc'> & {rpc<O extends string>(operation:O,input:unknown,options?:Parameters<ReturnType<typeof createClient>['rpc']>[2]):Promise<FixtureServiceResult<O>>};
