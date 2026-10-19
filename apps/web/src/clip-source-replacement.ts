import { message, renderMessage } from '../../../packages/i18n/src/index.ts';
import type { MessageDescriptor } from '../../../packages/i18n/src/index.ts';
import { sourceFrameCount } from '@mioon/contracts';
import { clipAudioIssue } from './clip-audio-state.ts';
import { clipVersionOf } from './timeline-source-freshness.ts';

type ReplacementKind = 'video' | 'audio' | 'image';
export interface ReplacementAsset {
  readonly id?: string;
  readonly projectId?: string;
  readonly name?: string;
  readonly mimeType?: string;
  readonly duration?: number;
  readonly hasAudio?: boolean;
  readonly hasVideo?: boolean;
  readonly [key: string]: unknown;
}
export interface ReplacementVersion {
  readonly id: string;
  readonly projectId?: string;
  readonly assetId?: string;
  readonly shotId?: string;
  readonly number?: number;
  readonly [key: string]: unknown;
}
export interface ReplacementShot {
  readonly id?: string;
  readonly projectId?: string;
  readonly title?: string;
  readonly selectedVersionId?: string | null;
  readonly [key: string]: unknown;
}
export interface ReplacementTimelineClip {
  readonly id: string;
  readonly assetId: string;
  readonly sourceInFrame: number;
  readonly durationFrames: number;
  readonly startFrame: number;
  readonly name?: string;
  readonly shotId?: string | null;
  readonly versionId?: string | null;
  readonly [key: string]: unknown;
}
export interface ReplacementTimeline {
  readonly id?: string;
  readonly projectId?: string;
  readonly revision?: number;
  readonly clips?: readonly ReplacementTimelineClip[];
  readonly [key: string]: unknown;
}
export interface ReplacementContext {
  scope?: string | null;
  projectId?: string | null;
  timeline?: ReplacementTimeline | null;
  clipId?: string | null;
  assets?: readonly ReplacementAsset[];
  versions?: readonly ReplacementVersion[];
  shots?: readonly ReplacementShot[];
  dirty?: boolean;
  busy?: boolean;
  pending?: boolean;
  connected?: boolean;
  visible?: boolean;
}
export interface ReplacementChoice {
  key: string;
  assetId: string;
  versionId?: string;
  source: Record<string, unknown>;
  label: string;
  version?: Record<string, unknown>;
}
export interface ReplacementReview {
  scope: string | null;
  projectId: string | null;
  timelineId: string | null;
  expectedRevision: number;
  clipId: string;
  clip: ReplacementTimelineClip;
  previous: Record<string, unknown>;
  candidate: ReplacementChoice;
  input: { clipId: string; assetId: string; versionId?: string };
}
export interface ClipReplacementState {
  phase: 'idle' | 'choosing' | 'review' | 'stale' | 'sending' | 'applied' | 'unknown' | 'error';
  selectedKey: string;
  review: ReplacementReview | null;
  error: string;
  errorMessage?: MessageDescriptor;
}
export interface ClipReplacementSubmitResult {
  status?: string;
  timeline?: unknown;
  error?: unknown;
}
export interface ClipReplacementControllerOptions {
  submit: (review: ReplacementReview) => Promise<ClipReplacementSubmitResult | null | undefined>;
  getContext?: () => ReplacementContext | null | undefined;
  onChange?: (state: ClipReplacementState) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const kind = (asset: ReplacementAsset | null | undefined): ReplacementKind | null => {
  const match = /^(video|audio|image)\//.exec(asset?.mimeType || '');
  return match ? match[1] as ReplacementKind : null;
};
const canonical = (value: unknown): string | undefined => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : item);
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
function freezeCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): unknown => { if (item && typeof item === 'object') { Object.values(item as Record<string, unknown>).forEach(freeze); Object.freeze(item); } return item; };
  return freeze(copy) as T;
}
const metadataKeys = ['id', 'projectId', 'name', 'mimeType', 'duration', 'hasAudio', 'hasVideo', 'width', 'height', 'sha256', 'sizeBytes', 'relativePath', 'url', 'provenance', 'revision', 'createdAt', 'updatedAt'];
const versionKeys = ['id', 'projectId', 'assetId', 'shotId', 'number', 'jobId', 'sha256', 'providerId', 'model', 'createdAt'];
const sourceSnapshot = (asset: ReplacementAsset): Record<string, unknown> => Object.fromEntries(metadataKeys.filter(key => Object.hasOwn(asset, key)).map(key => [key, asset[key]]));
const selectedClip = (context: ReplacementContext | null | undefined): ReplacementTimelineClip | undefined => {
  const clipId = context?.clipId;
  return context?.timeline?.clips?.find(clip => clip.id === clipId);
};

export function clipReplacementBlockedMessage(context: ReplacementContext | null | undefined): MessageDescriptor | null {
  if (!context?.projectId || !context.scope || context.timeline?.projectId !== context.projectId || !context.timeline?.id || !Number.isSafeInteger(context.timeline.revision) || (context.timeline?.revision ?? 0) < 1 || !selectedClip(context)) return message('timeline.replace.error.owner');
  if (context.dirty) return message('timeline.replace.error.dirty');
  if (!context.connected) return message('timeline.replace.error.offline');
  if (context.pending) return message('timeline.replace.error.pending');
  if (context.busy) return message('timeline.replace.error.busy');
  if (context.visible === false) return message('timeline.replace.error.hidden');
  return null;
}

export function clipReplacementBlockedReason(context: ReplacementContext | null | undefined): string { return renderMessage('zh-Hans', clipReplacementBlockedMessage(context)); }

export function clipReplacementCompatibility(clip: ReplacementTimelineClip | null | undefined, previous: ReplacementAsset | null | undefined, candidate: ReplacementAsset | null | undefined, projectId: string | null | undefined): string {
  if (!clip || !previous || !candidate || previous.id !== clip.assetId || previous.projectId !== projectId || candidate.projectId !== projectId) return '来源必须属于当前项目。';
  if (candidate.id === previous.id) return '不能替换为当前来源；不会生成重复历史。';
  if (!kind(previous) || kind(candidate) !== kind(previous)) return '新旧来源必须同为视频、音频或图片。';
  if (!Number.isSafeInteger(clip.sourceInFrame) || clip.sourceInFrame < 0 || !Number.isSafeInteger(clip.durationFrames) || clip.durationFrames < 1) return '片段范围无效，请先检查片段。';
  if (kind(candidate) === 'image') {
    if (clip.sourceInFrame !== 0) return '图片片段的素材入点必须为 0。';
  } else {
    const frames = sourceFrameCount(candidate.duration);
    if (frames === null) return '新来源时长尚未确认，无法保留片段范围。';
    if (clip.sourceInFrame + clip.durationFrames > frames) return '新来源不足以覆盖原入点与片段时长；不会自动裁短。';
  }
  return clipAudioIssue(clip, candidate);
}

// These are choices from the current project snapshot, not authorization or
// media verification. The shared business operation revalidates the source.
export function clipReplacementCandidates(context: ReplacementContext | null | undefined): ReplacementChoice[] {
  const clip = selectedClip(context), assets = context?.assets || [];
  const previous = assets.find(asset => asset.id === clip?.assetId);
  if (!clip || !context || context.timeline?.projectId !== context.projectId) return [];
  return assets.filter(asset => !clipReplacementCompatibility(clip, previous, asset, context.projectId)).flatMap(asset => {
    const source = sourceSnapshot(asset);
    const choices: ReplacementChoice[] = [{ key: `asset:${asset.id}`, assetId: asset.id ?? '', source, label: `${asset.name || asset.id} · 仅素材` }];
    for (const version of context.versions || []) {
      const shot = context.shots?.find(item => item.id === version.shotId && item.projectId === context.projectId);
      if (version.assetId !== asset.id || version.projectId !== context.projectId || !shot || !Number.isSafeInteger(version.number) || (version.number ?? 0) < 1) continue;
      choices.push({ key: `version:${version.id}`, assetId: asset.id ?? '', versionId: version.id,
        source,
        version: { ...Object.fromEntries(versionKeys.filter(key => Object.hasOwn(version, key)).map(key => [key, version[key]])), shotTitle: shot.title },
        label: `${asset.name || asset.id} · ${shot.title} · V${version.number}` });
    }
    return choices;
  });
}

export function createClipReplacementReview(context: ReplacementContext | null | undefined, candidateKey: string): ReplacementReview | null {
  if (clipReplacementBlockedReason(context)) return null;
  const clip = selectedClip(context), previous = (context?.assets || []).find(asset => asset.id === clip?.assetId);
  const candidate = clipReplacementCandidates(context).find(item => item.key === candidateKey);
  if (!context || !clip || !candidate) return null;
  // Asset-only selection deliberately does not infer a version or shot link.
  return freezeCopy({ scope: context.scope ?? null, projectId: context.projectId ?? null, timelineId: context.timeline?.id ?? null, expectedRevision: context.timeline?.revision ?? 0,
    clipId: clip.id, clip, previous: sourceSnapshot(previous as ReplacementAsset), candidate,
    input: { clipId: clip.id, assetId: candidate.assetId, ...(candidate.versionId ? { versionId: candidate.versionId } : {}) } });
}

export function clipReplacementReviewMessage(review: ReplacementReview | null | undefined, context: ReplacementContext | null | undefined, { contentOnly = false }: { contentOnly?: boolean } = {}): MessageDescriptor | null {
  if (!review || !context || review.scope !== context.scope || review.projectId !== context.projectId || review.clipId !== context.clipId || review.timelineId !== context.timeline?.id || context.timeline?.projectId !== review.projectId) return message('timeline.replace.error.reviewOwner');
  if (review.expectedRevision !== context.timeline.revision || !same(review.clip, selectedClip(context))) return message('timeline.replace.error.reviewStale');
  const previous = context.assets?.find(asset => asset.id === review.clip.assetId);
  const candidate = clipReplacementCandidates(context).find(item => item.key === review.candidate?.key);
  if (!previous || !same(review.previous, sourceSnapshot(previous)) || !candidate || !same(review.candidate, candidate)) return message('timeline.replace.error.candidateStale');
  const input = { clipId: review.clipId, assetId: candidate.assetId, ...(candidate.versionId ? { versionId: candidate.versionId } : {}) };
  if (!same(review.input, input)) return message('timeline.replace.error.inputMismatch');
  return contentOnly ? null : clipReplacementBlockedMessage(context);
}

export function clipReplacementReviewIssue(review: ReplacementReview | null | undefined, context: ReplacementContext | null | undefined, options: { contentOnly?: boolean } = {}): string { return renderMessage('zh-Hans', clipReplacementReviewMessage(review, context, options)); }

export function clipReplacementErrorDescriptor(error: unknown): MessageDescriptor {
  const code = isRecord(error) ? error.code : undefined;
  if (code === 'UNAUTHORIZED') return message('timeline.replace.error.unauthorized');
  if (typeof code === 'string' && ['CONFLICT', 'REVISION_CONFLICT'].includes(code)) return message('timeline.replace.error.conflict');
  if (code === 'SOURCE_UNCHANGED') return message('timeline.replace.error.unchanged');
  if (code === 'INVALID_CLIP_TYPE') return message('timeline.replace.error.invalidKind');
  if (typeof code === 'string' && ['INVALID_VERSION', 'NOT_FOUND', 'INVALID_ASSET', 'ASSET_NOT_FOUND', 'SOURCE_UNAVAILABLE', 'TIMELINE_SOURCE_UNAVAILABLE'].includes(code)) return message('timeline.replace.error.unavailable');
  if (typeof code === 'string' && ['SOURCE_BOUNDS', 'SOURCE_TOO_SHORT', 'SOURCE_RANGE_EXCEEDED', 'INVALID_SOURCE_RANGE'].includes(code)) return message('timeline.replace.error.bounds');
  if (typeof code === 'string' && ['INVALID_AUDIO_FADE', 'INVALID_FADE', 'AUDIO_UNAVAILABLE', 'FADE_AUDIO_UNSUPPORTED'].includes(code)) return message('timeline.replace.error.fades');
  return message('timeline.replace.error.failed');
}

export function clipReplacementErrorMessage(error: unknown): string { return renderMessage('zh-Hans', clipReplacementErrorDescriptor(error)); }

export function clipReplacementAcknowledged(review: ReplacementReview | null | undefined, timeline: unknown): boolean {
  if (!review || !isRecord(timeline) || timeline.id !== review.timelineId || timeline.projectId !== review.projectId || timeline.revision !== review.expectedRevision + 1 || !Array.isArray(timeline.clips)) return false;
  const saved = timeline.clips.find((clip): clip is ReplacementTimelineClip => isRecord(clip) && clip.id === review.clipId);
  if (!saved || saved.assetId !== review.candidate.assetId || Object.hasOwn(saved, 'jobId')) return false;
  if (review.candidate.versionId) {
    if (saved.versionId !== review.candidate.versionId || saved.shotId !== review.candidate.version?.shotId) return false;
  } else if (Object.hasOwn(saved, 'versionId') || Object.hasOwn(saved, 'shotId')) return false;
  const retained = (clip: unknown): Record<string, unknown> => Object.fromEntries(Object.entries(isRecord(clip) ? clip : {}).filter(([key]) => !['assetId', 'versionId', 'shotId', 'jobId'].includes(key)));
  const expected = retained(review.clip);
  if (isRecord(expected.colour)) expected.colour = { ...expected.colour, source: null };
  return same(retained(saved), expected);
}

const initialState = (): ClipReplacementState => ({ phase: 'idle', selectedKey: '', review: null, error: '' });
// The candidate that moves a clip to the version its shot currently selects, when that version can replace the clip's
// source. Offering it only pre-fills the usual choose -> review -> approve flow; nothing is applied without approval.
export function clipSelectedVersionCandidate(context: ReplacementContext | null | undefined): ReplacementChoice | null {
  const clip = selectedClip(context), origin = clip && clipVersionOf(clip, context?.versions || []);
  if (!origin || !context) return null;
  const shot = context.shots?.find(item => item.id === origin.shotId);
  if (!shot?.selectedVersionId || shot.selectedVersionId === origin.versionId) return null;
  return clipReplacementCandidates(context).find(candidate => candidate.key === `version:${shot.selectedVersionId}`) ?? null;
}

export function createClipReplacementController({ submit, getContext, onChange = () => {} }: ClipReplacementControllerOptions) {
  let state = initialState(), context: ReplacementContext | null = null, epoch = 0, disposed = false;
  const emit = (patch: Partial<ClipReplacementState>): ClipReplacementState => { state = { ...state, ...patch }; onChange(state); return state; };
  const sync = (): void => { const next = getContext?.(); if (next && !disposed) controller.setContext(next); };
  const owns = (owner: number): boolean => { sync(); return !disposed && owner === epoch; };
  const controller = {
    getState: (): ClipReplacementState => state,
    activate(): void {
      // React's development StrictMode may clean up and reattach effects.
      if (disposed) { disposed = false; epoch++; context = null; state = initialState(); }
    },
    setContext(next: ReplacementContext): void {
      if (disposed) return;
      const changedOwner = context?.scope !== next?.scope || context?.projectId !== next?.projectId || context?.clipId !== next?.clipId;
      context = next;
      if (changedOwner) { epoch++; state = initialState(); onChange(state); return; }
      if (state.phase === 'review') {
        const issue = clipReplacementReviewIssue(state.review, context, { contentOnly: true });
        if (issue) emit({ phase: 'stale', error: issue, errorMessage: clipReplacementReviewMessage(state.review, context, { contentOnly: true }) ?? undefined });
      }
    },
    begin(expected: ClipReplacementState = state): boolean {
      sync();
      if (disposed || expected !== state || !['idle', 'stale', 'error'].includes(state.phase) || clipReplacementBlockedReason(context)) return false;
      epoch++; emit({ ...initialState(), phase: 'choosing' }); return true;
    },
    choose(key: string, expected: ClipReplacementState = state): boolean {
      sync();
      if (disposed || expected !== state || state.phase !== 'choosing' || clipReplacementBlockedReason(context)) return false;
      if (!clipReplacementCandidates(context).some(candidate => candidate.key === key)) return false;
      emit({ selectedKey: key, error: '' }); return true;
    },
    review(expected: ClipReplacementState = state): ReplacementReview | null {
      sync();
      if (disposed || expected !== state || state.phase !== 'choosing') return null;
      const review = createClipReplacementReview(context, state.selectedKey);
      if (!review) return null;
      emit({ phase: 'review', review, error: '' }); return review;
    },
    cancel(expected: ClipReplacementState = state): boolean {
      sync();
      if (disposed || expected !== state || state.phase === 'sending') return false;
      epoch++; emit(initialState()); return true;
    },
    async approve(review: ReplacementReview): Promise<ClipReplacementSubmitResult | null> {
      sync();
      if (disposed || state.phase !== 'review' || review !== state.review || clipReplacementReviewIssue(review, context)) return null;
      const owner = epoch;
      emit({ phase: 'sending', error: '' });
      try {
        const result = await submit(review);
        if (!owns(owner)) return null;
        if (result?.status === 'applied' && clipReplacementAcknowledged(review, result.timeline)) {
          emit({ phase: 'applied', error: '' }); return result;
        }
        if (result?.status === 'rejected') emit({ phase: 'error', error: clipReplacementErrorMessage(result.error), errorMessage: clipReplacementErrorDescriptor(result.error) });
        else emit({ phase: 'unknown', error: '替换结果尚未确认。请在任务面板恢复同一请求，不要重复替换。', errorMessage: message('timeline.replace.error.unknown') });
      } catch {
        // Only App can verify a request-bound non-application proof. A thrown
        // transport error, including a definitive 4xx, is not that proof.
        if (owns(owner)) emit({ phase: 'unknown', error: '替换结果尚未确认。请在任务面板恢复同一请求，不要重复替换。', errorMessage: message('timeline.replace.error.unknown') });
      }
      return null;
    },
    dispose(): void { disposed = true; epoch++; context = null; },
  };
  return controller;
}
