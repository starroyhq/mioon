import { translate } from '../../../packages/i18n/src/index.ts';
import type { Locale } from '../../../packages/i18n/src/index.ts';
import { EXPORT_LOUDNESS_PROFILE } from '@mioon/contracts/export-loudness';
import type { ExportLoudnessTarget } from '@mioon/contracts/export-loudness';
import { TIMELINE_MIX_LOUDNESS_PROFILE, TIMELINE_MIX_LOUDNESS_LIMITS, isTimelineMixLoudnessResponse } from '@mioon/contracts/timeline-mix-loudness';
import type { TimelineMixLoudnessInput, TimelineMixLoudnessResponse } from '@mioon/contracts/timeline-mix-loudness';
import { parseExportLoudnessTarget } from './export-loudness-state.ts';
import type { ExportLoudnessDraft } from './export-loudness-state.ts';

export const TIMELINE_MIX_LOUDNESS_LABEL = '当前整片浮点混音与固定增益候选';
export const TIMELINE_MIX_LOUDNESS_LIMITATION = '仅测量当前已保存时间线的编码前浮点混音，不是已导出文件。准备测量不会修改音量或创建导出任务，应用须另行确认；不代表已实现逐段响度统一，也不保证 AAC 编码后的峰值。';
export interface TimelineMixLoudnessContext {
  readonly scope: string | null;
  readonly executionScope: string;
  readonly projectId: string | null;
  readonly timelineId: string | null;
  readonly revision: number | null;
  readonly durationFrames: number;
  /** Saved timeline and referenced public source metadata; bytes are server-verified. */
  readonly sourceIdentity: string;
  readonly connected: boolean;
  readonly visible: boolean;
  readonly restored: boolean;
  readonly hasUnsavedDrafts: boolean;
  readonly pending: boolean;
}
export type TimelineMixLoudnessPhase = 'idle' | 'preparing' | 'ready' | 'stale' | 'error' | 'cancelled';
export interface TimelineMixLoudnessState extends TimelineMixLoudnessContext {
  readonly draft: ExportLoudnessDraft;
  readonly version: number;
  readonly phase: TimelineMixLoudnessPhase;
  readonly report: TimelineMixLoudnessResponse | null;
  readonly error: string;
  readonly errorCode?: string;
}
export interface TimelineMixLoudnessReadOptions { readonly signal: AbortSignal; readonly expectedWorkspaceOrigin?: string }
export interface TimelineMixLoudnessControllerOptions {
  readonly read: (input: TimelineMixLoudnessInput, options: TimelineMixLoudnessReadOptions) => Promise<unknown>;
  readonly getContext?: () => TimelineMixLoudnessContext;
  readonly getInvocation?: () => Readonly<{ expectedWorkspaceOrigin?: string }>;
  readonly onChange?: (state: TimelineMixLoudnessState) => void;
  readonly onUnauthorized?: () => void;
}
const blank = (): ExportLoudnessDraft => Object.freeze({ integratedLufs: '', truePeakCeilingDbtp: '' });
const initial = (): TimelineMixLoudnessState => ({ scope: null, executionScope: '', projectId: null, timelineId: null,
  revision: null, durationFrames: 0, sourceIdentity: '', connected: false, visible: false, restored: false, hasUnsavedDrafts: false,
  pending: false, draft: blank(), version: 0, phase: 'idle', report: null, error: '' });
const contextKeys = ['scope', 'executionScope', 'projectId', 'timelineId', 'revision', 'durationFrames', 'sourceIdentity',
  'connected', 'visible', 'restored', 'hasUnsavedDrafts', 'pending'] as const;
const sameContext = (a: TimelineMixLoudnessContext, b: TimelineMixLoudnessContext): boolean => contextKeys.every(key => a[key] === b[key]);
export function timelineMixLoudnessAvailable(context: TimelineMixLoudnessContext): boolean {
  return Boolean(context.scope && context.projectId && context.timelineId && Number.isSafeInteger(context.revision) && (context.revision ?? 0) > 0 &&
    Number.isSafeInteger(context.durationFrames) && context.durationFrames > 0 && context.durationFrames <= TIMELINE_MIX_LOUDNESS_LIMITS.timelineFrames &&
    context.sourceIdentity && context.connected && context.visible && !context.restored && !context.hasUnsavedDrafts && !context.pending);
}
/** Both targets are required. There is deliberately no measurement-only/default-target path. */
export function parseTimelineMixLoudnessTarget(draft: ExportLoudnessDraft, locale: Locale = 'zh-Hans'): Readonly<{ target?: ExportLoudnessTarget; error: string }> {
  if (!draft.integratedLufs.trim() || !draft.truePeakCeilingDbtp.trim()) return { error: translate(locale, 'audio.loudness.mix.required') };
  const parsed = parseExportLoudnessTarget(draft, locale);
  return parsed.target ? parsed : { error: parsed.error || translate(locale, 'audio.loudness.mix.required') };
}
/** Suppress a prior report during the render before its context effect runs. */
export function timelineMixLoudnessViewState(state: TimelineMixLoudnessState, context: TimelineMixLoudnessContext): TimelineMixLoudnessState {
  if (sameContext(state, context)) return state;
  const ownerChanged = state.scope !== context.scope || state.projectId !== context.projectId || state.timelineId !== context.timelineId;
  return Object.freeze({ ...state, ...context, version: state.version + 1, draft: ownerChanged ? blank() : state.draft,
    phase: state.phase === 'idle' ? 'idle' : state.phase === 'preparing' ? 'cancelled' : 'stale', report: null, error: '' });
}
const codeOf = (error: unknown): string => error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
export function timelineMixLoudnessErrorMessage(error: unknown, locale: Locale = 'zh-Hans'): string {
  const code = codeOf(error);
  if (code === 'UNAUTHORIZED') return translate(locale, 'audio.loudness.mix.unauthorized');
  if (code.startsWith('RESTORE_')) return translate(locale, 'audio.loudness.mix.restored');
  if (code === 'TIMELINE_MIX_LOUDNESS_REVISION_CONFLICT' || code === 'TIMELINE_MIX_LOUDNESS_STALE') return translate(locale, 'audio.loudness.mix.changed');
  if (code === 'TIMELINE_MIX_LOUDNESS_BUSY') return translate(locale, 'audio.loudness.mix.busy');
  if (code === 'TIMELINE_MIX_LOUDNESS_TIMEOUT') return translate(locale, 'audio.loudness.mix.timeout');
  if (['TIMELINE_MIX_LOUDNESS_SOURCE_LIMIT', 'TIMELINE_MIX_LOUDNESS_RESOURCE_LIMIT', 'TIMELINE_MIX_LOUDNESS_BUDGET'].includes(code)) return translate(locale, 'audio.loudness.mix.resource');
  if (code === 'TIMELINE_MIX_LOUDNESS_UNSUPPORTED_FORMAT') return translate(locale, 'audio.loudness.mix.format');
  if (code === 'TIMELINE_MIX_LOUDNESS_SOURCE_BOUNDS') return translate(locale, 'audio.loudness.mix.bounds');
  if (['TIMELINE_MIX_LOUDNESS_INVALID_PCM', 'TIMELINE_MIX_LOUDNESS_SAMPLE_COUNT_MISMATCH', 'TIMELINE_MIX_LOUDNESS_DECODE_FAILED'].includes(code)) return translate(locale, 'audio.loudness.mix.decode');
  if (code === 'TIMELINE_MIX_LOUDNESS_OWNER_REQUIRED') return translate(locale, 'audio.loudness.mix.owner');
  if (code === 'TIMELINE_MIX_LOUDNESS_UNAVAILABLE') return translate(locale, 'audio.loudness.mix.failed');
  if (code === 'BACKEND_PROTOCOL_ERROR') return translate(locale, 'audio.loudness.mix.protocol');
  if (code === 'OPERATION_CANCELLED') return translate(locale, 'audio.loudness.mix.stopped');
  if (code === 'MEDIA_TERMINATION_UNCONFIRMED' || /(?:SHUTDOWN_FAILED|STOP_TIMEOUT)$/u.test(code)) return translate(locale, 'audio.loudness.mix.cleanup');
  return translate(locale, 'audio.loudness.mix.incomplete');
}
export function timelineMixLoudnessStatusMessage(state: TimelineMixLoudnessState, locale: Locale = 'zh-Hans'): string {
  if (state.phase === 'preparing') return translate(locale, 'audio.loudness.mix.preparing');
  if (state.error) return timelineMixLoudnessErrorMessage({ code: state.errorCode }, locale);
  if (state.phase === 'cancelled') return translate(locale, 'audio.loudness.mix.cancelled');
  if (state.phase === 'stale') return translate(locale, 'audio.loudness.mix.stale');
  return '';
}
function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
}
const protocolError = (): Error => Object.assign(new Error('Invalid full timeline loudness response'), { code: 'BACKEND_PROTOCOL_ERROR' });

/** Ephemeral read-only observation. No edit, persistence, queue, automatic retry or apply operation. */
export function createTimelineMixLoudnessController(options: TimelineMixLoudnessControllerOptions) {
  let state = initial(), generation = 0, version = 0, disposed = false;
  let active: AbortController | null = null;
  const emit = (patch: Partial<TimelineMixLoudnessState>): void => { state = Object.freeze({ ...state, ...patch }); options.onChange?.(state); };
  const invalidate = (): void => { generation++; const previous = active; active = null; previous?.abort(); };
  const sync = (): void => { if (!disposed && options.getContext) controller.setContext(options.getContext()); };
  const allowed = (expected: TimelineMixLoudnessState): boolean => {
    sync();
    return !disposed && expected.version === state.version && sameContext(expected, state) && timelineMixLoudnessAvailable(state);
  };
  const current = (attempt: number, captured: TimelineMixLoudnessState, abort: AbortController): boolean => {
    sync();
    return !disposed && generation === attempt && active === abort && !abort.signal.aborted && captured.version === state.version &&
      sameContext(captured, state) && timelineMixLoudnessAvailable(state);
  };
  const controller = {
    getState: (): TimelineMixLoudnessState => state,
    attach(context: TimelineMixLoudnessContext): void { disposed = false; controller.setContext(context); },
    setContext(context: TimelineMixLoudnessContext): void {
      if (disposed || sameContext(state, context)) return;
      invalidate();
      const next = timelineMixLoudnessViewState(state, context);
      emit({ ...next, version: ++version });
    },
    setDraft(draft: ExportLoudnessDraft, expected: TimelineMixLoudnessState): boolean {
      if (!allowed(expected) || typeof draft.integratedLufs !== 'string' || typeof draft.truePeakCeilingDbtp !== 'string' ||
        draft.integratedLufs.length > 32 || draft.truePeakCeilingDbtp.length > 32) return false;
      if (draft.integratedLufs === state.draft.integratedLufs && draft.truePeakCeilingDbtp === state.draft.truePeakCeilingDbtp) return true;
      invalidate(); emit({ draft: Object.freeze({ integratedLufs: draft.integratedLufs, truePeakCeilingDbtp: draft.truePeakCeilingDbtp }),
        version: ++version, phase: 'idle', report: null, error: '' }); return true;
    },
    async prepare(expected: TimelineMixLoudnessState): Promise<TimelineMixLoudnessResponse | null> {
      if (!allowed(expected) || active) return null;
      const parsed = parseTimelineMixLoudnessTarget(state.draft);
      if (!parsed.target || !state.projectId || !state.revision) return null;
      const input: TimelineMixLoudnessInput = Object.freeze({ projectId: state.projectId, expectedRevision: state.revision,
        mixProfile: TIMELINE_MIX_LOUDNESS_PROFILE, measurementProfile: EXPORT_LOUDNESS_PROFILE, target: parsed.target });
      const attempt = ++generation, abort = new AbortController(); active = abort;
      emit({ version: ++version, phase: 'preparing', report: null, error: '' });
      const captured = state;
      try {
        const invocation = options.getInvocation?.() ?? {};
        if (!current(attempt, captured, abort)) return null;
        const result = await options.read(input, { ...invocation, signal: abort.signal });
        if (!current(attempt, captured, abort)) return null;
        if (!isTimelineMixLoudnessResponse(result, input) || result.identity.timelineId !== captured.timelineId ||
          result.identity.range.endFrame !== captured.durationFrames) throw protocolError();
        // Server verifies source bytes and the saved snapshot. The renderer binds
        // their current public identity and rejects every late/out-of-scope reply.
        const report = structuredClone(result); freeze(report);
        emit({ phase: 'ready', report, error: '' }); return report;
      } catch (error: unknown) {
        if (!current(attempt, captured, abort)) return null;
        emit({ phase: 'error', report: null, error: timelineMixLoudnessErrorMessage(error), errorCode: codeOf(error) });
        if (codeOf(error) === 'UNAUTHORIZED') options.onUnauthorized?.();
        return null;
      } finally { if (active === abort) active = null; }
    },
    cancel(expected: TimelineMixLoudnessState): void {
      if (!allowed(expected) || !active) return;
      invalidate(); emit({ version: ++version, phase: 'cancelled', report: null, error: '' });
    },
    revoke(expected?: TimelineMixLoudnessState): void {
      if (disposed || expected && !allowed(expected)) return;
      invalidate(); emit({ version: ++version, phase: state.phase === 'idle' ? 'idle' : 'cancelled', report: null, error: '' });
    },
    dispose(): void { invalidate(); disposed = true; state = { ...initial(), version: ++version }; },
  };
  return controller;
}
export type TimelineMixLoudnessController = ReturnType<typeof createTimelineMixLoudnessController>;
export interface TimelineMixLoudnessView { readonly state: TimelineMixLoudnessState; readonly controller: TimelineMixLoudnessController }
