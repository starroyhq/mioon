import type {createClient} from '../../packages/client/src/index.ts';
import type {readTimelinePreflightSnapshot} from '../../packages/business/src/timeline-sources.ts';
import type {freezeTimelineSnapshot} from '../../packages/business/src/timeline-inputs.ts';
import type {OrdinaryServices} from '../../packages/business/src/services.ts';
import type {TimelineRecord} from '../../packages/contracts/src/timeline-replacement.ts';
import type {TimelineClipLoudnessInput, TimelineClipLoudnessResponse} from '../../packages/contracts/src/timeline-clip-loudness.ts';
import type {WorkspaceRestoreInspection} from '../../packages/contracts/src/workspace-restore.ts';
import type {AudioPreviewPlan} from '../../packages/contracts/src/timeline-audio-preview.ts';
import type {TimelineClipLoudnessControllerOptions, TimelineClipLoudnessReadOptions, TimelineClipLoudnessView} from '../../apps/web/src/timeline-clip-loudness-state.ts';
import {fixture as originalFixture} from './timeline-clip-loudness-ui-fixture.ts';

export type Mutable<T> = {-readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? Mutable<U>[] : T[K] extends object ? Mutable<T[K]> : T[K]};
export interface Failure extends Error {code: string; status?: number; details: Record<string, unknown>; terminationUnconfirmed?: boolean}
export interface Project {id: string; revision: number; name: string; [key: string]: unknown}
export interface Asset {id: string; projectId: string; relativePath: string; sha256: string; sizeBytes: number; mimeType: string; duration: number | null; hasAudio: boolean; [key: string]: unknown}
type ServiceResult<O extends string> = O extends 'project.create' ? Project : O extends 'asset.import' ? Asset : O extends 'timeline.clip.loudness' ? TimelineClipLoudnessResponse : O extends 'workspace.restore.inspect' ? WorkspaceRestoreInspection : O extends 'timeline.audioPreview.plan' ? AudioPreviewPlan : O extends 'timeline.get' | 'timeline.clip.add' | 'timeline.clip.update' | 'timeline.clip.remove' | 'timeline.clip.replaceSource' | 'timeline.clip.split' | 'timeline.track.add' | 'timeline.track.update' | 'timeline.undo' | 'timeline.redo' ? TimelineRecord : unknown;
export type TypedServices = Omit<OrdinaryServices, 'call'> & {call<O extends string>(operation: O, input: unknown, context?: Parameters<OrdinaryServices['call']>[2]): Promise<ServiceResult<O>>};
type OriginalFixture = ReturnType<typeof originalFixture>;
export type LoudnessFixture = Omit<OriginalFixture, 'calls'> & {calls: {input: TimelineClipLoudnessInput; options: TimelineClipLoudnessReadOptions; context: unknown}[]};
// Reuse the exact existing fixture function; only its captured call records are narrowed.
export const fixture = originalFixture as unknown as (patch?: Record<string, unknown>, overrides?: Partial<TimelineClipLoudnessControllerOptions>) => LoudnessFixture;
export interface TestElement {
  type: unknown;
  props: {
    children: unknown[];
    [key: string]: unknown;
    value: string;
    disabled: boolean;
    onClick(): void;
    onValueChange(values: number[]): void;
    onChange(event: {target: {value: string}}): void;
    onKeyDown(event: {key: string; nativeEvent: {isComposing: boolean}; stopPropagation(): void; preventDefault(): void}): void;
  };
}
export type LoudnessComponent = (props: {loudness: TimelineClipLoudnessView}) => TestElement;
export type NegativePreviewPlan = Omit<AudioPreviewPlan, 'profileId' | 'status' | 'sources' | 'voices' | 'memory' | 'work'> & {
  profileId: string; status: string; path?: string;
  sources: (Omit<AudioPreviewPlan['sources'][number], 'profileId' | 'decodeSegments'> & {profileId: string; url?: string; decodeSegments: (AudioPreviewPlan['sources'][number]['decodeSegments'][number] & {path?: string; sampleRate?: number})[]})[];
  voices: (AudioPreviewPlan['voices'][number] & {extra?: boolean})[];
  memory: AudioPreviewPlan['memory'] & {extra?: boolean};
  work: AudioPreviewPlan['work'] & {rate?: number};
};
export interface SchemaNode {
  $ref?: string; properties: Record<string, SchemaNode>; required?: string[];
  additionalProperties?: boolean; type?: string; const?: unknown; minimum?: number;
  [key: string]: unknown;
}
export interface RpcEnvelope<T = unknown> {ok: boolean; data: T; error: Failure}

export type TypedClient = Omit<ReturnType<typeof createClient>, 'rpc'> & {rpc<O extends string>(operation: O, input: unknown, options?: Parameters<ReturnType<typeof createClient>['rpc']>[2]): Promise<ServiceResult<O>>};

// Legacy test seams intentionally omit the export settings argument.
export type SavedAudioSnapshotReader = (store: Parameters<typeof readTimelinePreflightSnapshot>[0], projectId: string) => ReturnType<typeof readTimelinePreflightSnapshot>;
export type AudioSnapshotFreezer = (timeline: Parameters<typeof freezeTimelineSnapshot>[0], assets: Parameters<typeof freezeTimelineSnapshot>[1]) => ReturnType<typeof freezeTimelineSnapshot>;
