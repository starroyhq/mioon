import { message, renderMessage } from '../../../packages/i18n/src/index.ts';
import type { MessageDescriptor, MessageKey } from '../../../packages/i18n/src/index.ts';
import { TIMELINE_OUTPUT_PRESETS, timelineOutputPreset, isTimelineMutationResponse, isTimelineFormatReadResponse } from '@mioon/contracts';
import type { TimelineOutputPreset } from '../../../packages/contracts/src/timeline-output-geometry.ts';

export { TIMELINE_OUTPUT_PRESETS };
const reasonKeys = Object.freeze({ CLIPS_PRESENT: 'timeline.format.clips', HISTORY_PRESENT: 'timeline.format.history', REQUEST_HISTORY: 'timeline.format.requests', EXPORT_HISTORY: 'timeline.format.exports', PENDING_EDIT: 'timeline.format.editPending' });
export const timelineFormatReasonMessage = (code: string): MessageDescriptor => message(Object.hasOwn(reasonKeys, code) ? reasonKeys[code as keyof typeof reasonKeys] : 'timeline.format.blocked');
export const timelineFormatReason = (code: string): string => renderMessage('zh-Hans', timelineFormatReasonMessage(code));
const protocolError = (): Error => Object.assign(new Error('输出规格响应不完整，请重新核对。'), { code: 'BACKEND_PROTOCOL_ERROR' });

export interface TimelineFormatVersion {
  projectRevision: number;
  timelineId: string | null;
  timelineRevision: number;
}
const sameVersion = (a: TimelineFormatVersion | null | undefined, b: TimelineFormatVersion | null | undefined): boolean => a?.projectRevision === b?.projectRevision && a?.timelineId === b?.timelineId && a?.timelineRevision === b?.timelineRevision;

export interface TimelineFormatSaved extends TimelineFormatVersion {
  projectId: string;
  presetId: string;
  fps: 30;
  width: number;
  height: number;
  eligible: boolean;
  blockedReasons: string[];
}

export interface TimelineFormatInput {
  projectId: string | null;
  expectedProjectRevision: number;
  expectedRevision: number;
  requestId: string;
  presetId: string | null;
}
export interface TimelineFormatIntent {
  readonly scope: string | null;
  readonly projectId: string | null;
  readonly timelineId: string | null;
  readonly serial: number;
  readonly input: Readonly<TimelineFormatInput>;
}
export interface TimelineFormatState {
  scope: string | null;
  projectId: string | null;
  connected: boolean;
  pending: boolean;
  saved: TimelineFormatSaved | null;
  base: TimelineFormatSaved | null;
  draftPresetId: string | null;
  dirty: boolean;
  conflict: boolean;
  phase: 'idle' | 'loading' | 'ready' | 'stale' | 'error';
  error: string;
  errorMessage: MessageDescriptor | null;
  submitting: boolean;
  uncertain: TimelineFormatIntent | null;
}
export interface TimelineFormatContext {
  scope?: string | null;
  projectId?: string | null;
  projectRevision?: number;
  timelineId?: string | null;
  timelineRevision?: number;
  connected?: boolean;
  pending?: boolean;
}
export interface TimelineFormatReadOptions { signal: AbortSignal }
export interface TimelineFormatSubmitResult {
  status?: string;
  timeline?: unknown;
  error?: unknown;
}
export interface TimelineFormatRecoveredTask {
  operation: unknown;
  status: unknown;
  projectId: unknown;
  requestId: unknown;
  input: unknown;
}
export interface TimelineFormatControllerOptions {
  read: (input: { projectId: string }, options: TimelineFormatReadOptions) => Promise<unknown>;
  submit: (intent: TimelineFormatIntent) => Promise<TimelineFormatSubmitResult | null | undefined>;
  createRequestId: () => string;
  getContext?: () => TimelineFormatContext | null | undefined;
  onChange?: (state: TimelineFormatState) => void;
  onUnauthorized?: () => void;
}

const isRecoveryStatus = (value: unknown): value is 'applied' | 'not_applied' => value === 'applied' || value === 'not_applied';
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const errorCode = (error: unknown): string | undefined => isRecord(error) && typeof error.code === 'string' ? error.code : undefined;

const initial = (): TimelineFormatState => ({ scope: null, projectId: null, connected: false, pending: true, saved: null, base: null, draftPresetId: null, dirty: false, conflict: false, phase: 'idle', error: '', errorMessage: null, submitting: false, uncertain: null });
export const validTimelineFormat = (value: unknown, projectId: string): boolean => isTimelineFormatReadResponse(value, { projectId });
export function timelineFormatAcknowledged(intent: TimelineFormatIntent, timeline: unknown): boolean {
  if (!isTimelineMutationResponse('timeline.format.set', intent.input, timeline)) return false;
  const preset = timelineOutputPreset(timeline);
  return Boolean(preset && preset.id === intent.input.presetId && (!intent.timelineId || timelineIdOf(timeline) === intent.timelineId));
}
export function timelineFormatCanSave(state: TimelineFormatState | null | undefined): boolean {
  return Boolean(state?.connected && !state.pending && state.phase === 'ready' && state.saved?.eligible && state.dirty && !state.conflict && !state.submitting && !state.uncertain);
}
export function timelineRectMessage(rect: unknown, timeline: { width: number; height: number }): MessageDescriptor | null {
  const entries = Object.entries(isRecord(rect) ? rect : {}).map(([key, value]) => [key, Number(value)] as const);
  const { x, y, width, height } = Object.fromEntries(entries);
  if (![x, y, width, height].every(value => Number.isSafeInteger(value) && value % 2 === 0) || x < 0 || y < 0 || width < 2 || height < 2) return message('timeline.inspector.rectInvalid');
  if (x + width > timeline.width || y + height > timeline.height) return message('timeline.inspector.rectBounds');
  return null;
}

export function timelineRectIssue(rect: unknown, timeline: { width: number; height: number }): string { return renderMessage('zh-Hans', timelineRectMessage(rect, timeline)); }

function timelineIdOf(value: unknown): unknown { return isRecord(value) ? value.id : undefined; }

// A format draft belongs to a project epoch, not a selected clip, workspace
// mode, dock tab, or inspector reset. No read, visibility change, or recovery
// can silently save it or replace it with a historical task's input.
export function createTimelineFormatController({ read, submit, createRequestId, getContext, onChange = () => {}, onUnauthorized = () => {} }: TimelineFormatControllerOptions) {
  let state = initial(), serial = 0, generation = 0, activeRead: AbortController | null = null, visible = false;
  const resolved = new Map<unknown, unknown>();
  const sameInput = (a: unknown, b: unknown): boolean => Boolean(isRecord(a) && isRecord(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(b).every(key => a[key] === b[key]));
  const emit = (patch: Partial<TimelineFormatState>): void => { state = { ...state, ...patch }; onChange(state); };
  const invalidate = (): void => { generation++; activeRead?.abort(); activeRead = null; };
  const sync = (): void => { const context = getContext?.(); if (context) controller.setContext(context); };
  const owned = (captured: { scope: string | null; projectId: string | null }): boolean => { sync(); return captured.scope === state.scope && captured.projectId === state.projectId; };
  const controller = {
    getState: (): TimelineFormatState => state,
    hasUnsaved: (): boolean => state.dirty || state.submitting,
    setContext(context: TimelineFormatContext = {}): void {
      const next = { scope: context.scope ?? null, projectId: context.projectId || null, connected: Boolean(context.connected), pending: Boolean(context.pending) };
      if (state.scope !== next.scope || state.projectId !== next.projectId) { invalidate(); serial++; resolved.clear(); state = initial(); emit(next); return; }
      if (state.connected !== next.connected) { invalidate(); emit({ ...next, phase: state.saved ? 'stale' : 'idle' }); }
      else if (state.pending !== next.pending) emit(next);
      if (state.saved && ((context.projectRevision ?? 0) > state.saved.projectRevision || (context.timelineRevision ?? 0) > state.saved.timelineRevision || context.timelineId && context.timelineId !== state.saved.timelineId) && state.phase === 'ready') emit({ phase: 'stale' });
    },
    setVisible(value: boolean): void { visible = Boolean(value); },
    async load(expectedScope: string | null = state.scope): Promise<TimelineFormatSaved | null> {
      sync();
      const projectId = state.projectId;
      if (expectedScope !== state.scope || !projectId || !state.connected) return null;
      invalidate();
      const captured = { projectId, scope: state.scope, generation }, abort = new AbortController(); activeRead = abort;
      emit({ phase: 'loading', error: state.uncertain ? state.error : '', errorMessage: state.uncertain ? state.errorMessage : null });
      try {
        const value = await read({ projectId: captured.projectId }, { signal: abort.signal });
        if (!owned(captured) || captured.generation !== generation || !state.connected) return null;
        if (!validTimelineFormat(value, captured.projectId)) throw protocolError();
        const saved = structuredClone(value as TimelineFormatSaved);
        const live = getContext?.();
        if (live && ((live.projectRevision ?? 0) > saved.projectRevision || (live.timelineRevision ?? 0) > saved.timelineRevision)) { emit({ phase: 'stale' }); return null; }
        emit({ saved, phase: 'ready', error: state.uncertain ? state.error : '', errorMessage: state.uncertain ? state.errorMessage : null, ...(state.dirty || state.submitting || state.uncertain
          ? { conflict: !sameVersion(state.base, saved) }
          : { base: saved, draftPresetId: saved.presetId, conflict: false }) });
        return saved;
      } catch (error) {
        if (!owned(captured) || captured.generation !== generation) return null;
        const code = errorCode(error);
        emit({ phase: 'error', errorMessage: message(code === 'UNAUTHORIZED' ? 'timeline.format.unauthorized' : 'timeline.format.readFailed'), error: code === 'UNAUTHORIZED' ? '会话已过期，请重新登录。' : '无法核对输出规格，请检查连接后重试。' });
        if (code === 'UNAUTHORIZED') onUnauthorized();
        return null;
      } finally { if (activeRead === abort) activeRead = null; }
    },
    choose(presetId: string, expectedScope: string | null = state.scope): boolean {
      sync();
      const saved = state.saved;
      if (expectedScope !== state.scope || !visible || !timelineOutputPreset(presetId) || !saved || !state.connected || !saved.eligible) return false;
      serial++;
      emit({ draftPresetId: presetId, dirty: presetId !== saved.presetId || state.submitting || Boolean(state.uncertain), base: state.base || saved });
      return true;
    },
    discardDraft(expectedScope: string | null = state.scope): boolean {
      sync();
      if (expectedScope !== state.scope) return false;
      serial++;
      emit({ draftPresetId: state.saved?.presetId || null, base: state.saved, dirty: false, conflict: false });
      return true;
    },
    async save(expectedScope: string | null = state.scope): Promise<TimelineFormatSaved | unknown | null> {
      sync();
      const saved = state.saved, base = state.base, projectId = state.projectId, presetId = state.draftPresetId;
      if (expectedScope !== state.scope || !visible || !timelineFormatCanSave(state) || !saved || !base || !projectId || !presetId) return null;
      const intent: TimelineFormatIntent = Object.freeze({ scope: state.scope, projectId, timelineId: base.timelineId, serial,
        input: Object.freeze({ projectId, expectedProjectRevision: base.projectRevision, expectedRevision: base.timelineRevision, requestId: createRequestId(), presetId }) });
      emit({ submitting: true, error: '', errorMessage: null });
      let result: TimelineFormatSubmitResult | null | undefined;
      try {
        result = await submit(intent);
        if (!owned(intent)) return null;
        if (result?.status === 'applied') {
          const timeline = result.timeline;
          if (!timelineFormatAcknowledged(intent, timeline)) throw protocolError();
          const preset = timelineOutputPreset(timeline), acknowledgement = isRecord(timeline) && typeof timeline.id === 'string' && typeof timeline.revision === 'number' ? { id: timeline.id, revision: timeline.revision } : null;
          if (!preset || !acknowledgement) throw protocolError();
          const next: TimelineFormatSaved = { ...saved, timelineId: acknowledgement.id, timelineRevision: acknowledgement.revision, presetId: preset.id, fps: preset.fps, width: preset.width, height: preset.height };
          // A later edit, including an intentional return to the old preset,
          // survives this ACK. Historical recovery never uses this branch.
          emit({ submitting: false, uncertain: null, saved: next, base: next, conflict: false,
            ...(serial === intent.serial ? { draftPresetId: preset.id, dirty: false } : { dirty: true }) });
          await controller.load();
          return timeline;
        }
      } catch (error) { result = { status: 'unknown', error }; }
      if (!owned(intent)) return null;
      const uncertain = result?.status !== 'rejected' && !sameInput(resolved.get(intent.input.requestId), intent.input);
      emit({ submitting: false, uncertain: uncertain ? intent : null, errorMessage: message(uncertain ? 'timeline.format.unknown' : 'timeline.format.notApplied'), error: uncertain ? '提交结果待确认。请在任务中心恢复同一请求，不能新建请求重试。' : '请求未应用，草稿仍保留。请重新核对已保存的规格。' });
      await controller.load();
      return null;
    },
    recovered(task: TimelineFormatRecoveredTask): void {
      if (task.operation !== 'timeline.format.set' || !isRecoveryStatus(task.status) || task.projectId !== state.projectId) return;
      resolved.set(task.requestId, task.input);
      const intent = state.uncertain;
      if (intent && task.requestId === intent.input.requestId && sameInput(task.input, intent.input)) emit({ uncertain: null, error: '', errorMessage: null, conflict: !sameVersion(state.base, state.saved) });
      // Keep the current draft even when recovered history happens to match it.
      void controller.load();
    },
    dispose(): void { invalidate(); serial++; state = initial(); visible = false; resolved.clear(); },
  };
  return controller;
}
