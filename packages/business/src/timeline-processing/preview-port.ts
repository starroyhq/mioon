import type {CompiledTimeMap} from '../../../contracts/src/timeline-time-map.ts';
import type {SpeedInterpolation, SpeedProcessingItem} from '../../../contracts/src/timeline-speed.ts';
import type {ReverseProxyMediaOptions} from './reverse-io.ts';

export const TIMELINE_PREVIEW_CACHE_PROFILE = 'timeline-preview-output-v1';

export interface PreviewProcessingInput {
  readonly source: {readonly path: string; readonly videoStreamIndex?: number | string | null};
  readonly sourceSha256: string;
  readonly plan: CompiledTimeMap;
  readonly interpolation: SpeedInterpolation;
}

export interface PreparedPreviewProcessing {
  readonly profile: {
    readonly profileId: typeof TIMELINE_PREVIEW_CACHE_PROFILE;
    readonly mapHash: string;
    readonly sourceSha256: string;
    readonly sourceStream: string;
    readonly buildSha256: string;
    readonly width: number;
    readonly height: number;
    readonly fps: number;
    readonly effectiveInterpolation: 'off';
  };
  readonly reservationBytes: number;
}

export interface PreviewProcessingRenderer {
  prepare(input: PreviewProcessingInput, options: ReverseProxyMediaOptions): Promise<PreparedPreviewProcessing>;
  render(input: PreviewProcessingInput, prepared: PreparedPreviewProcessing, options: ReverseProxyMediaOptions & {
    readonly stagingDirectory: string;
    readonly onProgress?: (percent: number) => void;
  }): Promise<unknown>;
}

export interface PreviewProcessingRequest {
  readonly projectId: string;
  readonly clipId: string;
}

export interface PreviewProcessingProof extends PreviewProcessingRequest {
  readonly taskId: string;
  readonly sha256: string;
}

export interface PreviewProcessingLookup {
  readonly item: SpeedProcessingItem;
  readonly ready?: {readonly proof: PreviewProcessingProof; readonly durationFrames: number};
}

export interface PreviewProcessingLease {
  readonly proof: PreviewProcessingProof;
  readonly file: string;
  readonly durationFrames: number;
  verify(): boolean;
  release(): void;
}

/** The authenticated project media owner acquires again on a URL request.
 * The proof by itself does not authorize reading an artifact. */
export interface PreviewProcessingPort {
  lookup(input: PreviewProcessingRequest): PreviewProcessingLookup | null;
  acquire(input: PreviewProcessingProof, options?: {signal?: AbortSignal; beforeEffect?: () => void}): Promise<PreviewProcessingLease | null>;
}
