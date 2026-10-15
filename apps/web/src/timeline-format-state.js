import { message, renderMessage } from '../../../packages/i18n/src/index.ts';
import { TIMELINE_OUTPUT_PRESETS, timelineOutputPreset, isTimelineMutationResponse, isTimelineFormatReadResponse } from '@mioon/contracts';

export { TIMELINE_OUTPUT_PRESETS };
const reasonKeys = Object.freeze({ CLIPS_PRESENT: 'timeline.format.clips', HISTORY_PRESENT: 'timeline.format.history', REQUEST_HISTORY: 'timeline.format.requests', EXPORT_HISTORY: 'timeline.format.exports', PENDING_EDIT: 'timeline.format.editPending' });
export const timelineFormatReasonMessage = code => message(reasonKeys[code] || 'timeline.format.blocked');
export const timelineFormatReason = code => renderMessage('zh-Hans', timelineFormatReasonMessage(code));
const protocolError = () => Object.assign(new Error('输出规格响应不完整，请重新核对。'), { code: 'BACKEND_PROTOCOL_ERROR' });
const sameVersion = (a, b) => a?.projectRevision === b?.projectRevision && a?.timelineId === b?.timelineId && a?.timelineRevision === b?.timelineRevision;
const initial = () => ({ scope: null, projectId: null, connected: false, pending: true, saved: null, base: null, draftPresetId: null, dirty: false, conflict: false, phase: 'idle', error: '', errorMessage: null, submitting: false, uncertain: null });
export const validTimelineFormat = (value, projectId) => isTimelineFormatReadResponse(value, { projectId });
export function timelineFormatAcknowledged(intent, timeline) {
  return Boolean(isTimelineMutationResponse('timeline.format.set', intent.input, timeline) &&
    timelineOutputPreset(timeline)?.id === intent.input.presetId && (!intent.timelineId || timeline.id === intent.timelineId));
}
export function timelineFormatCanSave(state) {
  return Boolean(state?.connected && !state.pending && state.phase === 'ready' && state.saved?.eligible && state.dirty && !state.conflict && !state.submitting && !state.uncertain);
}
export function timelineRectMessage(rect, timeline) {
  const { x, y, width, height } = Object.fromEntries(Object.entries(rect || {}).map(([key, value]) => [key, Number(value)]));
  if (![x, y, width, height].every(value => Number.isSafeInteger(value) && value % 2 === 0) || x < 0 || y < 0 || width < 2 || height < 2) return message('timeline.inspector.rectInvalid');
  if (x + width > timeline.width || y + height > timeline.height) return message('timeline.inspector.rectBounds');
  return null;
}

export function timelineRectIssue(rect, timeline) { return renderMessage('zh-Hans', timelineRectMessage(rect, timeline)); }

// A format draft belongs to a project epoch, not a selected clip, workspace
// mode, dock tab, or inspector reset. No read, visibility change, or recovery
// can silently save it or replace it with a historical task's input.
export function createTimelineFormatController({ read, submit, createRequestId, getContext, onChange = () => {}, onUnauthorized = () => {} }) {
  let state = initial(), serial = 0, generation = 0, activeRead = null, visible = false;
  const resolved = new Map();
  const sameInput = (a, b) => Boolean(a && b && Object.keys(a).length === Object.keys(b).length && Object.keys(b).every(key => a[key] === b[key]));
  const emit = patch => { state = { ...state, ...patch }; onChange(state); };
  const invalidate = () => { generation++; activeRead?.abort(); activeRead = null; };
  const sync = () => { if (getContext) controller.setContext(getContext()); };
  const owned = captured => { sync(); return captured.scope === state.scope && captured.projectId === state.projectId; };
  const controller = {
    getState: () => state,
    hasUnsaved: () => state.dirty || state.submitting,
    setContext(context = {}) {
      const next = { scope: context.scope, projectId: context.projectId || null, connected: Boolean(context.connected), pending: Boolean(context.pending) };
      if (state.scope !== next.scope || state.projectId !== next.projectId) { invalidate(); serial++; resolved.clear(); state = initial(); emit(next); return; }
      if (state.connected !== next.connected) { invalidate(); emit({ ...next, phase: state.saved ? 'stale' : 'idle' }); }
      else if (state.pending !== next.pending) emit(next);
      if (state.saved && (context.projectRevision > state.saved.projectRevision || context.timelineRevision > state.saved.timelineRevision || context.timelineId && context.timelineId !== state.saved.timelineId) && state.phase === 'ready') emit({ phase: 'stale' });
    },
    setVisible(value) { visible = Boolean(value); },
    async load(expectedScope = state.scope) {
      sync();
      if (expectedScope !== state.scope || !state.projectId || !state.connected) return null;
      invalidate();
      const captured = { projectId: state.projectId, scope: state.scope, generation }, abort = new AbortController(); activeRead = abort;
      emit({ phase: 'loading', error: state.uncertain ? state.error : '', errorMessage: state.uncertain ? state.errorMessage : null });
      try {
        const value = await read({ projectId: captured.projectId }, { signal: abort.signal });
        if (!owned(captured) || captured.generation !== generation || !state.connected) return null;
        if (!validTimelineFormat(value, captured.projectId)) throw protocolError();
        const live = getContext?.();
        if (live && (live.projectRevision > value.projectRevision || live.timelineRevision > value.timelineRevision)) { emit({ phase: 'stale' }); return null; }
        const saved = structuredClone(value);
        emit({ saved, phase: 'ready', error: state.uncertain ? state.error : '', errorMessage: state.uncertain ? state.errorMessage : null, ...(state.dirty || state.submitting || state.uncertain
          ? { conflict: !sameVersion(state.base, saved) }
          : { base: saved, draftPresetId: saved.presetId, conflict: false }) });
        return saved;
      } catch (error) {
        if (!owned(captured) || captured.generation !== generation) return null;
        emit({ phase: 'error', errorMessage: message(error.code === 'UNAUTHORIZED' ? 'timeline.format.unauthorized' : 'timeline.format.readFailed'), error: error.code === 'UNAUTHORIZED' ? '会话已过期，请重新登录。' : '无法核对输出规格，请检查连接后重试。' });
        if (error.code === 'UNAUTHORIZED') onUnauthorized();
        return null;
      } finally { if (activeRead === abort) activeRead = null; }
    },
    choose(presetId, expectedScope = state.scope) {
      sync();
      if (expectedScope !== state.scope || !visible || !timelineOutputPreset(presetId) || !state.saved || !state.connected || !state.saved.eligible) return false;
      serial++;
      emit({ draftPresetId: presetId, dirty: presetId !== state.saved.presetId || state.submitting || Boolean(state.uncertain), base: state.base || state.saved });
      return true;
    },
    discardDraft(expectedScope = state.scope) {
      sync();
      if (expectedScope !== state.scope) return false;
      serial++;
      emit({ draftPresetId: state.saved?.presetId || null, base: state.saved, dirty: false, conflict: false });
      return true;
    },
    async save(expectedScope = state.scope) {
      sync();
      if (expectedScope !== state.scope || !visible || !timelineFormatCanSave(state)) return null;
      const intent = Object.freeze({ scope: state.scope, projectId: state.projectId, timelineId: state.base.timelineId, serial,
        input: Object.freeze({ projectId: state.projectId, expectedProjectRevision: state.base.projectRevision, expectedRevision: state.base.timelineRevision, requestId: createRequestId(), presetId: state.draftPresetId }) });
      emit({ submitting: true, error: '', errorMessage: null });
      let result;
      try {
        result = await submit(intent);
        if (!owned(intent)) return null;
        if (result?.status === 'applied') {
          if (!timelineFormatAcknowledged(intent, result.timeline)) throw protocolError();
          const preset = timelineOutputPreset(result.timeline), saved = { ...state.saved, timelineId: result.timeline.id, timelineRevision: result.timeline.revision, presetId: preset.id, fps: preset.fps, width: preset.width, height: preset.height };
          // A later edit, including an intentional return to the old preset,
          // survives this ACK. Historical recovery never uses this branch.
          emit({ submitting: false, uncertain: null, saved, base: saved, conflict: false,
            ...(serial === intent.serial ? { draftPresetId: preset.id, dirty: false } : { dirty: true }) });
          await controller.load();
          return result.timeline;
        }
      } catch (error) { result = { status: 'unknown', error }; }
      if (!owned(intent)) return null;
      const unknown = result?.status !== 'rejected' && !sameInput(resolved.get(intent.input.requestId), intent.input);
      emit({ submitting: false, uncertain: unknown ? intent : null, errorMessage: message(unknown ? 'timeline.format.unknown' : 'timeline.format.notApplied'), error: unknown ? '提交结果待确认。请在任务中心恢复同一请求，不能新建请求重试。' : '请求未应用，草稿仍保留。请重新核对已保存的规格。' });
      await controller.load();
      return null;
    },
    recovered(task) {
      if (task.operation !== 'timeline.format.set' || !['applied', 'not_applied'].includes(task.status) || task.projectId !== state.projectId) return;
      resolved.set(task.requestId, task.input);
      const intent = state.uncertain;
      if (intent && task.requestId === intent.input.requestId && sameInput(task.input, intent.input)) emit({ uncertain: null, error: '', errorMessage: null, conflict: !sameVersion(state.base, state.saved) });
      // Keep the current draft even when recovered history happens to match it.
      void controller.load();
    },
    dispose() { invalidate(); serial++; state = initial(); visible = false; resolved.clear(); },
  };
  return controller;
}
