import type {createInspectionServices} from '../../packages/business/src/inspection.ts';
import type {TimelineFormatResponse} from '../../packages/contracts/src/timeline-format.ts';
import type {WorkspaceSettings} from '../../packages/contracts/src/workspace-configuration.ts';
import type {ProviderCapabilities, normalizedCapabilities} from '../../packages/business/src/provider-registry.ts';
import type {OrdinaryServices, ServiceHandlerContext, JobRecord} from '../../packages/business/src/services.ts';
import type {WorkspaceStore} from '../../packages/business/src/db.ts';
import type {createClient} from '../../packages/client/src/index.ts';
import type {FixtureServiceResult, FixtureProject, FixtureAsset, FixtureTimeline, FixtureExport, FixtureExportRecord, FixtureHistory, FixtureVersion} from './strict-timeline-core-types.ts';
import type {ReferenceShotRecord, ReferenceEdgeRecord, ReferenceMutationResponse, ReferenceAttachResponse, ReferenceDetachResponse} from '../../packages/contracts/src/reference-acknowledgement.ts';
import type {SubjectResponse, SubjectVersionResponse, SubjectBindingResponse} from '../../packages/contracts/src/subjects.ts';
import type {SubjectReference} from '../../packages/contracts/src/subject-generation.ts';
import type {FrameTaskResponse, FrameRequestResponse} from '../../packages/contracts/src/frame-extraction.ts';
import type {ImageTaskResponse, ImageGroupResponse, ImageVersionResponse, ImageRequestResponse, ImageProfilesResponse} from '../../packages/contracts/src/images.ts';
import type {ImageReviewResponse} from '../../packages/contracts/src/image-reviews.ts';
import type {AssetDispositionResponse, AssetDispositionListResponse} from '../../packages/contracts/src/asset-disposition.ts';
import type {AssetAnnotation} from '../../packages/contracts/src/asset-annotations.ts';
import type {SourceRangeResponse} from '../../packages/contracts/src/source-range.ts';
import type {ExportActivity, ExportOutput} from '../../packages/contracts/src/export-controls.ts';
import type {ExportSamplePeakResponse} from '../../packages/contracts/src/export-sample-peak.ts';
import type {ExportLoudnessResponse} from '../../packages/contracts/src/export-loudness.ts';
import type {TimelineClipLoudnessResponse} from '../../packages/contracts/src/timeline-clip-loudness.ts';
import type {TimelineExportCapabilitiesResponse} from '../../packages/contracts/src/timeline-export-profile.ts';
import type {AudioPreviewPlan} from '../../packages/contracts/src/timeline-audio-preview.ts';
import type {ContinuousAudioPlan} from '../../packages/contracts/src/timeline-audio-continuous.ts';
import type {ProjectSummary} from '../../packages/contracts/src/project-home.ts';
import type {ComfyImageSettingsResult, ComfyImageCheckResult, ComfyRemoteResponse, ComfyObservationAcknowledgement} from '../../packages/contracts/src/comfy-images.ts';

// Positive fixture rows are read after their owning setup call. Negative payloads
// and operations without a reviewed response mapping continue to cross as unknown.
export interface FixturePage<T> {projectId: string; items: T[]; nextCursor: string | null}
export interface MediaShot extends ReferenceShotRecord {status?: string; durationSeconds?: number; [key: string]: unknown}
export interface MediaNode {id: string; projectId: string; type: string; assetId?: string | null; title?: string; text?: string; position: {x: number; y: number}; revision: number; createdAt?: string; updatedAt?: string}
export interface MediaEdge {id: string; projectId: string; source: string; target: string; kind: string; role?: string; sourceAssetId?: string; createdAt?: string}
export interface GenerationReferenceAsset {id: string; relativePath: string; mimeType: string; sha256: string; width?: number; height?: number; sizeBytes?: number; role?: string}
export interface GenerationSnapshot {
  shotId: string; shotRevision: number; title: string; prompt: string;
  referenceAssetIds: string[]; referenceAssets: GenerationReferenceAsset[]; referenceConnections: ReferenceEdgeRecord[];
  aspectRatio: string; duration: number; providerId: string; model: string; parameters: Record<string, unknown>;
  capabilities: Record<string, unknown>; lastFrameAssetId?: string | null; subjectReference?: SubjectReference;
  inputProfileId?: string; inputProfileVersion?: string; referenceBindings?: {role: string; assetId: string; sha256: string}[];
  [key: string]: unknown;
}
export interface MediaJob extends JobRecord {
  snapshot: GenerationSnapshot; versionId: string | null; progress: number;
  error: {code:string;message:string;retryable?:boolean}|null; createdAt: string; updatedAt: string;
  nextPollAt?: number; cancelScope?: string | null;
}
export interface ProjectState {project: FixtureProject; timeline: FixtureTimeline; timelineHistory: FixtureHistory; assets: FixtureAsset[]; shots: MediaShot[]; nodes: MediaNode[]; edges: MediaEdge[]; jobs: MediaJob[]; versions: FixtureVersion[]; exports: FixtureExportRecord[]}

export interface InspectionAsset {id: string; name: string; mimeType: string; width?: number; height?: number; duration?: number; hasAudio?: boolean; hasVideo?: boolean; provenance?: string; createdAt?: string}
export interface InspectionVersion {id: string; number: number; assetId: string; providerId?: string; model?: string; isMock?: boolean; createdAt?: string}
export interface InspectionShot {id: string; title: string; prompt: string; promptTruncated: boolean; referenceAssetIds: string[]; aspectRatio: string; duration: number; orderIndex: number; revision: number; selectedVersionId: string | null; selectedVersion: InspectionVersion | null}
export interface InspectionProject {id: string; name: string; description: string; revision: number; counts: Record<'assets' | 'shots' | 'nodes' | 'edges' | 'jobs' | 'versions' | 'exports' | 'timelines', number>}
export type InspectionTimeline = Pick<FixtureTimeline, 'id' | 'revision' | 'fps' | 'width' | 'height' | 'durationFrames' | 'tracks' | 'clips'>;
export type ListedProvider = ReturnType<typeof normalizedCapabilities> & Pick<ProviderCapabilities, 'models'> & {mock?: boolean};

export type FixtureImageTask = ImageTaskResponse & Partial<Pick<Extract<ImageTaskResponse, {purpose: 'edit'}>, 'purpose' | 'inputImage' | 'sourceImage'>>;
export type FixtureImageVersion = ImageVersionResponse & Partial<Pick<Extract<ImageVersionResponse, {purpose: 'edit'}>, 'purpose' | 'inputImage' | 'sourceImage'>>;
export type FixtureImageReview = ImageReviewResponse & Partial<Pick<Extract<ImageReviewResponse, {sourceImage: unknown}>, 'sourceImage'>> & Partial<Pick<Extract<ImageReviewResponse, {execution: unknown}>, 'execution'>> & Partial<Pick<Extract<ImageReviewResponse, {configuration: unknown}>, 'configuration'>>;
export interface ServiceResponseMap {
  'timeline.format.get': TimelineFormatResponse;
  'workspace.settings.set': WorkspaceSettings;
  'provider.list': ListedProvider[];
  'project.inspect': InspectionProject;
  'asset.inspect': {items: InspectionAsset[]; nextCursor: string | null};
  'shot.inspect': {items: InspectionShot[]; nextCursor: string | null};
  'timeline.inspect': InspectionTimeline | null;
  'project.get': ProjectState;
  'project.rename': FixtureProject;
  'project.delete': {requestId: string; projectId: string; deleted: true; cleanup: 'complete' | 'pending'};
  'project.summary.list': ProjectSummary[];
  'asset.list': FixtureAsset[];
  'asset.disposition.set': AssetDispositionResponse;
  'asset.disposition.list': AssetDispositionListResponse;
  'asset.annotation.set': AssetAnnotation;
  'asset.annotation.list': {projectId: string; items: AssetAnnotation[]};
  'asset.range.get': SourceRangeResponse;
  'asset.range.set': SourceRangeResponse;
  'shot.create': MediaShot;
  'shot.update': MediaShot;
  'shot.reorder': FixtureProject;
  'node.create': MediaNode;
  'node.update': MediaNode;
  'edge.create': MediaEdge;
  'edge.delete': {deleted: true};
  'reference.attach': ReferenceAttachResponse;
  'reference.detach': ReferenceDetachResponse;
  'generation.submit': MediaJob;
  'job.get': MediaJob;
  'job.list': MediaJob[];
  'job.retry': MediaJob;
  'job.reconcile': MediaJob;
  'job.cancel': MediaJob;
  'version.list': FixtureVersion[];
  'version.select': MediaShot;
  'subject.create': SubjectResponse;
  'subject.version.add': SubjectResponse;
  'subject.list': FixturePage<SubjectResponse>;
  'subject.version.list': FixturePage<SubjectVersionResponse>;
  'subject.binding.set': SubjectBindingResponse;
  'subject.binding.list': FixturePage<SubjectBindingResponse>;
  'frame.extract': FrameTaskResponse;
  'frame.task.recoverResult': FrameTaskResponse;
  'frame.task.cancelQueued': FrameTaskResponse;
  'frame.task.get': FrameTaskResponse;
  'frame.task.list': FixturePage<FrameTaskResponse>;
  'frame.request.get': FrameRequestResponse;
  'image.generate': FixtureImageTask;
  'image.task.get': FixtureImageTask;
  'image.task.recoverResult': FixtureImageTask;
  'image.task.cancelQueued': FixtureImageTask;
  'image.task.list': FixturePage<ImageTaskResponse>;
  'image.group.get': ImageGroupResponse;
  'image.group.list': FixturePage<ImageGroupResponse>;
  'image.version.list': FixturePage<FixtureImageVersion>;
  'image.request.get': ImageRequestResponse;
  'image.profile.list': ImageProfilesResponse;
  'image.review.prepare': FixtureImageReview;
  'image.review.get': FixtureImageReview;
  'image.review.list': FixturePage<ImageReviewResponse>;
  'image.task.remote.get': ComfyRemoteResponse;
  'image.task.observeRemote': ComfyObservationAcknowledgement;
  'export.activity.get': ExportActivity;
  'export.output.get': ExportOutput;
  'timeline.export.samplePeak': ExportSamplePeakResponse;
  'timeline.export.loudness': ExportLoudnessResponse;
  'timeline.clip.loudness': TimelineClipLoudnessResponse;
  'timeline.export.capabilities': TimelineExportCapabilitiesResponse;
  'timeline.audioPreview.plan': AudioPreviewPlan;
  'timeline.audioPreview.continuousPlan': ContinuousAudioPlan;
}
export type ServiceResponse<O extends string> = O extends keyof ServiceResponseMap ? ServiceResponseMap[O] : FixtureServiceResult<O>;
export type TypedCall = <O extends string>(operation: O, input: unknown, context?: ServiceHandlerContext) => Promise<ServiceResponse<O>>;
export type TypedServices = Omit<OrdinaryServices, 'call' | 'imageApproval' | 'inspection'> & {inspection:TypedInspection;call: TypedCall; imageApproval: (input:unknown) => FixtureImageTask | Promise<FixtureImageTask>};
export type TypedClient = Omit<ReturnType<typeof createClient>, 'rpc'> & {rpc<O extends string>(operation: O, input?: unknown, options?: Parameters<ReturnType<typeof createClient>['rpc']>[2]): Promise<ServiceResponse<O>>};
interface MediaTables {projects: FixtureProject; timelines: FixtureTimeline; shots: MediaShot; nodes: MediaNode; edges: MediaEdge; assets: FixtureAsset; jobs: MediaJob; versions: FixtureVersion; exports: FixtureExportRecord}
export type TypedStore = Omit<WorkspaceStore, 'get' | 'list'> & {
  get<T extends keyof MediaTables>(table: T, id: string): MediaTables[T]|null;
  get(table: string, id: string): unknown;
  list<T extends keyof MediaTables>(table: T, projectId?: string): MediaTables[T][];
  list(table: string, projectId?: string): unknown[];
};
export function typedCall<O extends string>(services: Pick<OrdinaryServices, 'call'>, operation: O, input: unknown, ...context: [context?: ServiceHandlerContext]): Promise<ServiceResponse<O>> {
  return services.call(operation, input, ...context) as Promise<ServiceResponse<O>>;
}

export type TypedInspection=Omit<ReturnType<typeof createInspectionServices>,'dispatch'|'createContext'>&{createContext(options:unknown):{projectId:string;capabilities:readonly string[]};dispatch<O extends string>(context:object,operation:O,args?:Record<string,unknown>):ServiceResponse<O>};
