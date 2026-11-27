import type {ClipTiming, SpeedProcessingReason} from '../../../contracts/src/timeline-speed.ts';

export const OPTICAL_PROXY_PROFILE = 'timeline-optical-output-v1' as const;
export const OPTICAL_FLOW_FILTER = 'minterpolate=fps=30:mi_mode=mci:mc_mode=obmc:me_mode=bilat:me=epzs:mb_size=16:search_param=32:vsbmc=0';
export const OPTICAL_FLOW_CUT_POLICY = 'scene-cut-adjacent-off-v1' as const;

export interface TimelineOpticalProxyRequest {
  readonly projectId: string;
  readonly timelineId: string;
  readonly clipId: string;
  readonly assetId: string;
  readonly sourceSha256: string;
  readonly mapHash: string;
  readonly timing: ClipTiming;
  readonly outputWindow: {readonly fromFrame: number; readonly toFrame: number};
}

export interface TimelineOpticalProxyProof {readonly taskId: string; readonly sha256: string}

export interface TimelineOpticalProxyLease {
  readonly proof: TimelineOpticalProxyProof;
  readonly video: {readonly file: string; readonly firstOutputFrame: number; readonly frameCount: number};
  verify(): boolean;
  release(): void;
}

export interface TimelineOpticalProxyPort {
  lookup(request: TimelineOpticalProxyRequest): {
    readonly taskId: string; readonly readySha256?: string; readonly reason?: SpeedProcessingReason;
  } | null;
  acquire(request: TimelineOpticalProxyRequest, proof: TimelineOpticalProxyProof,
    options?: {readonly signal?: AbortSignal; readonly beforeEffect?: () => void}): Promise<TimelineOpticalProxyLease | null>;
}
