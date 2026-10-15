import { translate } from '../../../packages/i18n/src/index.ts';
import type { Locale } from '../../../packages/i18n/src/index.ts';
import { EXPORT_LOUDNESS_PROFILE } from '@mioon/contracts/export-loudness';
import { TIMELINE_CLIP_LOUDNESS_LIMITS, isTimelineClipLoudnessResponse } from '@mioon/contracts/timeline-clip-loudness';
import type { TimelineClipLoudnessInput, TimelineClipLoudnessResponse } from '@mioon/contracts/timeline-clip-loudness';

export interface TimelineClipLoudnessContext {
  readonly scope: string | null;
  readonly executionScope: string;
  readonly projectId: string | null;
  readonly timelineId: string | null;
  readonly revision: number | null;
  readonly clipId: string | null;
  readonly assetId: string | null;
  readonly assetSha256: string;
  readonly trackId: string | null;
  readonly startFrame: number;
  readonly sourceInFrame: number;
  readonly durationFrames: number;
  readonly gain: number;
  readonly fadeInFrames: number;
  readonly fadeOutFrames: number;
  readonly muted: boolean;
  readonly audioSupported: boolean;
  /** Saved timeline and referenced public source metadata; bytes are server-verified. */
  readonly sourceIdentity: string;
  readonly connected: boolean;
  readonly visible: boolean;
  readonly restored: boolean;
  readonly hasUnsavedDrafts: boolean;
  readonly pending: boolean;
}
export type TimelineClipLoudnessPhase = 'idle' | 'preparing' | 'ready' | 'stale' | 'error' | 'cancelled';
export interface TimelineClipLoudnessState extends TimelineClipLoudnessContext {
  readonly version: number;
  readonly phase: TimelineClipLoudnessPhase;
  readonly report: TimelineClipLoudnessResponse | null;
  readonly error: string;
  readonly errorCode?: string;
}
export interface TimelineClipLoudnessReadOptions { readonly signal: AbortSignal; readonly expectedWorkspaceOrigin?: string }
export interface TimelineClipLoudnessControllerOptions {
  readonly read: (input: TimelineClipLoudnessInput, options: TimelineClipLoudnessReadOptions) => Promise<unknown>;
  readonly getContext?: () => TimelineClipLoudnessContext;
  readonly getInvocation?: () => Readonly<{ expectedWorkspaceOrigin?: string }>;
  readonly onChange?: (state: TimelineClipLoudnessState) => void;
  readonly onUnauthorized?: () => void;
}
const initial = (): TimelineClipLoudnessState => ({ scope: null, executionScope: '', projectId: null, timelineId: null,
  revision: null, clipId: null, assetId: null, assetSha256: '', trackId: null, startFrame: 0, sourceInFrame: 0, durationFrames: 0, gain: 0, fadeInFrames: 0, fadeOutFrames: 0, muted: true, audioSupported: false, sourceIdentity: '', connected: false, visible: false, restored: false, hasUnsavedDrafts: false,
  pending: false, version: 0, phase: 'idle', report: null, error: '' });
const contextKeys = ['scope', 'executionScope', 'projectId', 'timelineId', 'revision', 'clipId', 'assetId', 'assetSha256', 'trackId', 'startFrame', 'sourceInFrame', 'durationFrames', 'gain', 'fadeInFrames', 'fadeOutFrames', 'muted', 'audioSupported', 'sourceIdentity',
  'connected', 'visible', 'restored', 'hasUnsavedDrafts', 'pending'] as const;
const sameContext = (a: TimelineClipLoudnessContext, b: TimelineClipLoudnessContext): boolean => contextKeys.every(key => a[key] === b[key]);
export function timelineClipLoudnessAvailable(context: TimelineClipLoudnessContext): boolean {
  return Boolean(context.scope && context.projectId && context.timelineId && Number.isSafeInteger(context.revision) && (context.revision ?? 0) > 0 &&
    Number.isSafeInteger(context.durationFrames) && context.durationFrames > 0 && context.durationFrames <= TIMELINE_CLIP_LOUDNESS_LIMITS.clipFrames &&
    Number.isSafeInteger(context.startFrame) && context.startFrame >= 0 && context.startFrame + context.durationFrames <= TIMELINE_CLIP_LOUDNESS_LIMITS.timelineFrames &&
    Number.isSafeInteger(context.sourceInFrame) && context.sourceInFrame >= 0 &&
    Number.isSafeInteger(context.fadeInFrames) && context.fadeInFrames >= 0 && Number.isSafeInteger(context.fadeOutFrames) && context.fadeOutFrames >= 0 && context.fadeInFrames + context.fadeOutFrames <= context.durationFrames &&
    context.clipId && context.assetId && context.trackId && /^[a-f0-9]{64}$/u.test(context.assetSha256) && context.audioSupported && !context.muted && context.gain > 0 && context.gain <= 2 && context.sourceIdentity && context.connected && context.visible && !context.restored && !context.hasUnsavedDrafts && !context.pending);
}
/** Suppress a prior report during the render before its context effect runs. */
export function timelineClipLoudnessViewState(state: TimelineClipLoudnessState, context: TimelineClipLoudnessContext): TimelineClipLoudnessState {
  if (sameContext(state, context)) return state;
  return Object.freeze({ ...state, ...context, version: state.version + 1,
    phase: state.phase === 'idle' ? 'idle' : state.phase === 'preparing' ? 'cancelled' : 'stale', report: null, error: '' });
}
const codeOf = (error: unknown): string => error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
export function timelineClipLoudnessErrorMessage(error: unknown, locale: Locale = 'zh-Hans'): string {
  const code = codeOf(error);
  if (code === 'TIMELINE_CLIP_LOUDNESS_SOURCE_METADATA_MISMATCH') return translate(locale, 'audio.loudness.clip.metadataMismatch');
  if (code === 'TIMELINE_CLIP_LOUDNESS_NO_AUDIO') return translate(locale, 'audio.loudness.clip.noAudio');
  if (['TIMELINE_CLIP_LOUDNESS_MUTED', 'TIMELINE_CLIP_LOUDNESS_ZERO_GAIN'].includes(code)) return translate(locale, 'audio.loudness.clip.inaudible');
  if (code === 'TIMELINE_CLIP_LOUDNESS_DURATION_LIMIT') return translate(locale, 'audio.loudness.clip.durationLimit', { seconds: TIMELINE_CLIP_LOUDNESS_LIMITS.clipSeconds });
  if (code === 'UNAUTHORIZED') return translate(locale, 'audio.loudness.clip.unauthorized');
  if (code.startsWith('RESTORE_')) return translate(locale, 'audio.loudness.clip.restored');
  if (code === 'TIMELINE_CLIP_LOUDNESS_REVISION_CONFLICT' || code === 'TIMELINE_CLIP_LOUDNESS_STALE') return translate(locale, 'audio.loudness.clip.changed');
  if (code === 'TIMELINE_CLIP_LOUDNESS_BUSY') return translate(locale, 'audio.loudness.clip.busy');
  if (code === 'TIMELINE_CLIP_LOUDNESS_TIMEOUT') return translate(locale, 'audio.loudness.clip.timeout');
  if (['TIMELINE_CLIP_LOUDNESS_SOURCE_LIMIT', 'TIMELINE_CLIP_LOUDNESS_RESOURCE_LIMIT', 'TIMELINE_CLIP_LOUDNESS_BUDGET'].includes(code)) return translate(locale, 'audio.loudness.clip.resource');
  if (code === 'TIMELINE_CLIP_LOUDNESS_UNSUPPORTED_FORMAT') return translate(locale, 'audio.loudness.clip.format');
  if (code === 'TIMELINE_CLIP_LOUDNESS_SOURCE_BOUNDS') return translate(locale, 'audio.loudness.clip.bounds');
  if (['TIMELINE_CLIP_LOUDNESS_INVALID_PCM', 'TIMELINE_CLIP_LOUDNESS_SAMPLE_COUNT_MISMATCH', 'TIMELINE_CLIP_LOUDNESS_DECODE_FAILED'].includes(code)) return translate(locale, 'audio.loudness.clip.decode');
  if (code === 'TIMELINE_CLIP_LOUDNESS_OWNER_REQUIRED') return translate(locale, 'audio.loudness.clip.owner');
  if (code === 'TIMELINE_CLIP_LOUDNESS_UNAVAILABLE') return translate(locale, 'audio.loudness.clip.failed');
  if (code === 'BACKEND_PROTOCOL_ERROR') return translate(locale, 'audio.loudness.clip.protocol');
  if (code === 'OPERATION_CANCELLED') return translate(locale, 'audio.loudness.clip.stopped');
  if (code === 'MEDIA_TERMINATION_UNCONFIRMED' || /(?:SHUTDOWN_FAILED|STOP_TIMEOUT)$/u.test(code)) return translate(locale, 'audio.loudness.clip.cleanup');
  return translate(locale, 'audio.loudness.clip.incomplete');
}
export function timelineClipLoudnessStatusMessage(state: TimelineClipLoudnessState, locale: Locale = 'zh-Hans'): string {
  if (state.phase === 'preparing') return translate(locale, 'audio.loudness.clip.preparing');
  if (state.error) return timelineClipLoudnessErrorMessage({ code: state.errorCode }, locale);
  if (state.phase === 'cancelled') return translate(locale, 'audio.loudness.clip.cancelled');
  if (state.phase === 'stale') return translate(locale, 'audio.loudness.clip.stale');
  return '';
}
function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
}
const protocolError = (): Error => Object.assign(new Error('Invalid saved clip loudness response'), { code: 'BACKEND_PROTOCOL_ERROR' });

export function clipReportMatchesContext(report: TimelineClipLoudnessResponse, captured: TimelineClipLoudnessContext): boolean {
  return report.identity.trackId === captured.trackId && report.identity.assetId === captured.assetId &&
    report.identity.assetSha256 === captured.assetSha256 && report.identity.startFrame === captured.startFrame &&
    report.identity.sourceInFrame === captured.sourceInFrame && report.identity.durationFrames === captured.durationFrames &&
    report.identity.gain === captured.gain && report.identity.fadeInFrames === captured.fadeInFrames &&
    report.identity.fadeOutFrames === captured.fadeOutFrames && report.identity.trackMuted === captured.muted;
}

/** Ephemeral read-only observation. No edit, persistence, queue, automatic retry or apply operation. */
export function createTimelineClipLoudnessController(options: TimelineClipLoudnessControllerOptions) {
  let state = initial(), generation = 0, version = 0, disposed = false;
  let active: AbortController | null = null;
  const emit = (patch: Partial<TimelineClipLoudnessState>): void => { state = Object.freeze({ ...state, ...patch }); options.onChange?.(state); };
  const invalidate = (): void => { generation++; const previous = active; active = null; previous?.abort(); };
  const sync = (): void => { if (!disposed && options.getContext) controller.setContext(options.getContext()); };
  const allowed = (expected: TimelineClipLoudnessState): boolean => {
    sync();
    return !disposed && expected.version === state.version && sameContext(expected, state) && timelineClipLoudnessAvailable(state);
  };
  const current = (attempt: number, captured: TimelineClipLoudnessState, abort: AbortController): boolean => {
    sync();
    return !disposed && generation === attempt && active === abort && !abort.signal.aborted && captured.version === state.version &&
      sameContext(captured, state) && timelineClipLoudnessAvailable(state);
  };
  const controller = {
    getState: (): TimelineClipLoudnessState => state,
    attach(context: TimelineClipLoudnessContext): void { disposed = false; controller.setContext(context); },
    setContext(context: TimelineClipLoudnessContext): void {
      if (disposed || sameContext(state, context)) return;
      invalidate();
      const next = timelineClipLoudnessViewState(state, context);
      emit({ ...next, version: ++version });
    },
    async prepare(expected: TimelineClipLoudnessState): Promise<TimelineClipLoudnessResponse | null> {
      if (!allowed(expected) || active) return null;
      if (!state.projectId || !state.timelineId || !state.revision || !state.clipId) return null;
      const input: TimelineClipLoudnessInput = Object.freeze({ projectId: state.projectId, timelineId: state.timelineId,
        expectedRevision: state.revision, clipId: state.clipId, expectedAssetSha256: state.assetSha256,
        measurementProfile: EXPORT_LOUDNESS_PROFILE });
      const attempt = ++generation, abort = new AbortController(); active = abort;
      emit({ version: ++version, phase: 'preparing', report: null, error: '' });
      const captured = state;
      try {
        const invocation = options.getInvocation?.() ?? {};
        if (!current(attempt, captured, abort)) return null;
        const result = await options.read(input, { ...invocation, signal: abort.signal });
        if (!current(attempt, captured, abort)) return null;
        if (!isTimelineClipLoudnessResponse(result, input) || !clipReportMatchesContext(result, captured)) throw protocolError();
        // Server verifies source bytes and the saved snapshot. The renderer binds
        // their current public identity and rejects every late/out-of-scope reply.
        const report = structuredClone(result); freeze(report);
        emit({ phase: 'ready', report, error: '' }); return report;
      } catch (error: unknown) {
        if (!current(attempt, captured, abort)) return null;
        emit({ phase: 'error', report: null, error: timelineClipLoudnessErrorMessage(error), errorCode: codeOf(error) });
        if (codeOf(error) === 'UNAUTHORIZED') options.onUnauthorized?.();
        return null;
      } finally { if (active === abort) active = null; }
    },
    cancel(expected: TimelineClipLoudnessState): void {
      if (!allowed(expected) || !active) return;
      invalidate(); emit({ version: ++version, phase: 'cancelled', report: null, error: '' });
    },
    revoke(expected?: TimelineClipLoudnessState): void {
      if (disposed || expected && !allowed(expected)) return;
      invalidate(); emit({ version: ++version, phase: state.phase === 'idle' ? 'idle' : 'cancelled', report: null, error: '' });
    },
    dispose(): void { invalidate(); disposed = true; state = { ...initial(), version: ++version }; },
  };
  return controller;
}
export type TimelineClipLoudnessController = ReturnType<typeof createTimelineClipLoudnessController>;
export interface TimelineClipLoudnessView { readonly state: TimelineClipLoudnessState; readonly controller: TimelineClipLoudnessController }
