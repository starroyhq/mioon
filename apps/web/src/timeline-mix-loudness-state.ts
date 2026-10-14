import { EXPORT_LOUDNESS_PROFILE } from '@mioon/contracts/export-loudness';
import type { ExportLoudnessTarget } from '@mioon/contracts/export-loudness';
import { TIMELINE_MIX_LOUDNESS_PROFILE, TIMELINE_MIX_LOUDNESS_LIMITS, isTimelineMixLoudnessResponse } from '@mioon/contracts/timeline-mix-loudness';
import type { TimelineMixLoudnessInput, TimelineMixLoudnessResponse } from '@mioon/contracts/timeline-mix-loudness';
import { parseExportLoudnessTarget } from './export-loudness-state.ts';
import type { ExportLoudnessDraft } from './export-loudness-state.ts';

export const TIMELINE_MIX_LOUDNESS_LABEL = '当前整片浮点混音与固定增益候选';
export const TIMELINE_MIX_LOUDNESS_LIMITATION = '仅测量当前已保存时间线的编码前浮点混音，不是已导出文件。不会修改音量或创建导出任务；不代表已实现逐段响度统一，也不保证 AAC 编码后的峰值。';
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
export function parseTimelineMixLoudnessTarget(draft: ExportLoudnessDraft): Readonly<{ target?: ExportLoudnessTarget; error: string }> {
  if (!draft.integratedLufs.trim() || !draft.truePeakCeilingDbtp.trim()) return { error: '请明确填写目标响度和真峰值上限，再准备候选。' };
  const parsed = parseExportLoudnessTarget(draft);
  return parsed.target ? parsed : { error: parsed.error || '请明确填写目标响度和真峰值上限，再准备候选。' };
}
/** Suppress a prior report during the render before its context effect runs. */
export function timelineMixLoudnessViewState(state: TimelineMixLoudnessState, context: TimelineMixLoudnessContext): TimelineMixLoudnessState {
  if (sameContext(state, context)) return state;
  const ownerChanged = state.scope !== context.scope || state.projectId !== context.projectId || state.timelineId !== context.timelineId;
  return Object.freeze({ ...state, ...context, version: state.version + 1, draft: ownerChanged ? blank() : state.draft,
    phase: state.phase === 'idle' ? 'idle' : state.phase === 'preparing' ? 'cancelled' : 'stale', report: null, error: '' });
}
const codeOf = (error: unknown): string => error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
export function timelineMixLoudnessErrorMessage(error: unknown): string {
  const code = codeOf(error);
  if (code === 'UNAUTHORIZED') return '会话已过期，请重新登录后明确重新准备。';
  if (code.startsWith('RESTORE_')) return '恢复分支暂不支持当前整片浮点混音测量。';
  if (code === 'TIMELINE_MIX_LOUDNESS_REVISION_CONFLICT' || code === 'TIMELINE_MIX_LOUDNESS_STALE') return '已保存时间线或来源已变化，结果已丢弃，请重新准备。';
  if (code === 'TIMELINE_MIX_LOUDNESS_BUSY') return '另一个音频检查仍在运行或清理，本次未排队，请稍后明确重试。';
  if (code === 'TIMELINE_MIX_LOUDNESS_TIMEOUT') return '整片测量超过 120 秒预算，未保留部分结果。';
  if (['TIMELINE_MIX_LOUDNESS_SOURCE_LIMIT', 'TIMELINE_MIX_LOUDNESS_RESOURCE_LIMIT', 'TIMELINE_MIX_LOUDNESS_BUDGET'].includes(code)) return '整片测量达到来源或解码资源上限，未省略音轨或缩短范围。';
  if (code === 'TIMELINE_MIX_LOUDNESS_UNSUPPORTED_FORMAT') return '当前时间线含暂不支持的音频格式，未省略该音轨。';
  if (code === 'TIMELINE_MIX_LOUDNESS_SOURCE_BOUNDS') return '已保存片段超出来源音频范围，请核对来源后重新准备。';
  if (['TIMELINE_MIX_LOUDNESS_INVALID_PCM', 'TIMELINE_MIX_LOUDNESS_SAMPLE_COUNT_MISMATCH', 'TIMELINE_MIX_LOUDNESS_DECODE_FAILED'].includes(code)) return '声音未能完整解码或样本数量不符，未获得整片测量。';
  if (code === 'TIMELINE_MIX_LOUDNESS_OWNER_REQUIRED') return '当前连接不拥有工作区，暂时不能准备整片混音。';
  if (code === 'TIMELINE_MIX_LOUDNESS_UNAVAILABLE') return '当前已保存时间线暂时无法测量，请核对时间线和来源。';
  if (code === 'BACKEND_PROTOCOL_ERROR') return '测量响应不完整或与当前整片时间线、目标不匹配，请重新准备。';
  if (code === 'OPERATION_CANCELLED') return '本次整片测量已停止，需要时请明确重新准备。';
  if (code === 'MEDIA_TERMINATION_UNCONFIRMED' || /(?:SHUTDOWN_FAILED|STOP_TIMEOUT)$/u.test(code)) return '上一音频检查尚未确认结束，请等待资源释放后明确重试。';
  return '整片测量未完成，请确认连接后重新准备。';
}
export function timelineMixLoudnessStatusMessage(state: TimelineMixLoudnessState): string {
  if (state.phase === 'preparing') return '正在完整测量原混音，并重新渲染固定增益候选…';
  if (state.error) return state.error;
  if (state.phase === 'cancelled') return '本次只读观察已取消，未修改时间线；需要时请明确重新准备。';
  if (state.phase === 'stale') return '当前身份或显示范围已变化，原结果已清除，请重新准备。';
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
        emit({ phase: 'error', report: null, error: timelineMixLoudnessErrorMessage(error) });
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
