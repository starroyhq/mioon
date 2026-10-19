import { message, renderMessage } from '../../../packages/i18n/src/index.ts';
import { TIMELINE_SUBTITLE_LIMITS, TIMELINE_SUBTITLE_PROFILE_ID, getTimelineSubtitleIssue, isTimelineMutationResponse } from '@mioon/contracts';
import { taskInputKey } from './edit-task-client.ts';

export { TIMELINE_SUBTITLE_LIMITS };
const fields = cue => cue ? { text: cue.text, startFrame: cue.startFrame, durationFrames: cue.durationFrames } : null;
const cues = timeline => timeline?.subtitles?.cues || [];
const initial = () => ({ scope: null, projectId: null, timeline: null, cueId: null, selection: 0, draft: null, baseRevision: null, dirty: false, conflict: false, submitting: false, uncertain: null, connected: false, pending: true, error: '', errorMessage: null });
const protocolError = () => Object.assign(new Error('字幕确认与原请求不一致；草稿仍保留，请在任务中心核对。'), { code: 'BACKEND_PROTOCOL_ERROR' });
function subtitleDraftValidation(state) {
  if (!state?.draft || !state.timeline) return { message: '请先选择字幕或在播放头处新增。', displayMessage: message('subtitles.error.select') };
  const draft = state.draft;
  if (draft.startFrame === '' || draft.durationFrames === '') return { message: '开始帧与持续帧数必须填写整数。', displayMessage: message('subtitles.error.integer') };
  // The placeholder exists only for shared draft validation, never in an RPC.
  const ids = new Set(cues(state.timeline).map(cue => cue.id));
  let placeholder = 0, draftId;
  do { draftId = `00000000-0000-4000-8000-${String(placeholder++).padStart(12, '0')}`; } while (ids.has(draftId));
  const candidate = { id: state.cueId || draftId, ...fields(draft), startFrame: Number(draft.startFrame), durationFrames: Number(draft.durationFrames) };
  return getTimelineSubtitleIssue({ profileId: TIMELINE_SUBTITLE_PROFILE_ID, cues: [...cues(state.timeline).filter(cue => cue.id !== state.cueId), candidate] }, state.timeline.durationFrames);
}

export const subtitleDraftIssue = state => subtitleDraftValidation(state)?.message || '';
export function subtitleDraftMessage(state) {
  const issue = subtitleDraftValidation(state);
  if (!issue) return null;
  if (issue.displayMessage) return issue.displayMessage;
  if (issue.code === 'SUBTITLE_TEXT_INVALID') {
    const { line, column, codePoint } = issue.details || {};
    return Number.isSafeInteger(line) && line > 0 && Number.isSafeInteger(column) && column > 0 && /^U\+[A-F0-9]{4,6}$/.test(codePoint || '')
      ? message('subtitles.error.character', { line, column, codePoint }) : message('subtitles.error.text');
  }
  const key = { INVALID_SUBTITLES: 'subtitles.error.invalid', SUBTITLE_LIMIT: 'subtitles.error.limit', SUBTITLE_BOUNDS: 'subtitles.error.bounds', SUBTITLE_OVERLAP: 'subtitles.error.overlap' }[issue.code] || 'subtitles.error.invalid';
  return message(key);
}

export const subtitleCanSave = state => Boolean(state?.draft && state.dirty && state.connected && !state.pending && !state.conflict && !state.submitting && !state.uncertain && !subtitleDraftIssue(state));
export function subtitleAddMessage(timeline, frame, blocked = false) {
  if (blocked) return message('subtitles.error.pending');
  if (!timeline || timeline.durationFrames < 1) return message('subtitles.error.mediaFirst');
  if (cues(timeline).length >= TIMELINE_SUBTITLE_LIMITS.cues) return message('subtitles.error.limit');
  if (!Number.isSafeInteger(frame) || frame < 0 || frame >= timeline.durationFrames) return message('subtitles.error.playhead');
  return null;
}
export const subtitleAddReason = (timeline, frame, blocked = false) => renderMessage('zh-Hans', subtitleAddMessage(timeline, frame, blocked));
export function subtitleAcknowledged(intent, timeline) {
  if (!intent || timeline?.id !== intent.timelineId || !isTimelineMutationResponse(intent.operation, intent.input, timeline)) return false;
  if (intent.operation !== 'timeline.subtitle.add') return true;
  const added = cues(timeline).filter(cue => !intent.previousIds.includes(cue.id));
  return added.length === 1 && ['text', 'startFrame', 'durationFrames'].every(key => added[0][key] === intent.input[key]);
}

// Drafts live above the dock. A request owns one project and selection epoch;
// hiding/remounting its view cannot dispatch, clear, or replay that request.
export function createSubtitleController({ submit, createRequestId, getContext, onChange = () => {} }) {
  let state = initial(), serial = 0, sequence = 0, active = true, visible = false;
  const resolved = new Map();
  const emit = patch => { state = { ...state, ...patch }; onChange(state); return state; };
  const sync = () => { if (active && getContext) controller.setContext(getContext()); };
  const owns = intent => { sync(); return active && intent.scope === state.scope && intent.projectId === state.projectId && intent.selection === state.selection; };
  const admits = expected => { sync(); return active && visible && expected?.scope === state.scope && expected?.selection === state.selection; };
  async function send(operation, expected) {
    if (!admits(expected) || state.pending || state.submitting || state.uncertain || !state.connected || state.conflict) return null;
    const removing = operation === 'timeline.subtitle.remove';
    if (removing ? !state.cueId || state.dirty : !subtitleCanSave(state)) return null;
    const input = { projectId: state.projectId, expectedRevision: state.baseRevision, requestId: createRequestId(), ...(removing ? { cueId: state.cueId } : state.cueId ? { cueId: state.cueId, patch: { ...fields(state.draft), startFrame: Number(state.draft.startFrame), durationFrames: Number(state.draft.durationFrames) } } : { ...fields(state.draft), startFrame: Number(state.draft.startFrame), durationFrames: Number(state.draft.durationFrames) }) };
    if (input.patch) Object.freeze(input.patch);
    const intent = Object.freeze({ scope: state.scope, projectId: state.projectId, timelineId: state.timeline.id, selection: state.selection, serial, operation, input: Object.freeze(input), previousIds: Object.freeze(cues(state.timeline).map(cue => cue.id)) });
    emit({ submitting: true, error: '', errorMessage: null });
    let result;
    try {
      result = await submit(intent);
      if (!owns(intent)) return null;
      if (result?.status === 'applied') {
        if (!subtitleAcknowledged(intent, result.timeline)) throw protocolError();
        if (state.timeline.revision > result.timeline.revision) { emit({ submitting: false, conflict: true, error: '时间线已有更新版本；请核对后放弃草稿并载入最新字幕。', errorMessage: message('subtitles.error.newer') }); return result.timeline; }
        const cue = removing ? null : cues(result.timeline).find(cue => intent.input.cueId ? cue.id === intent.input.cueId : !intent.previousIds.includes(cue.id));
        emit({ timeline: result.timeline, cueId: cue?.id || null, baseRevision: result.timeline.revision, submitting: false, uncertain: null, conflict: false, error: '', errorMessage: null, ...(serial === intent.serial ? { draft: fields(cue), dirty: false } : { dirty: true }) });
        return result.timeline;
      }
    } catch (error) { result = { status: 'unknown', error }; }
    if (!owns(intent)) return null;
    const known = resolved.get(intent.input.requestId);
    const unknown = result?.status !== 'rejected' && !(known && taskInputKey(known) === taskInputKey(intent.input));
    emit({ submitting: false, uncertain: unknown ? intent : null, errorMessage: message(unknown ? 'subtitles.error.unknown' : 'subtitles.error.notApplied'), error: unknown ? '结果待确认。草稿仍保留，请到任务中心恢复同一请求；不要重新提交。' : result?.error?.message || '请求未应用，草稿仍保留。' });
    return null;
  }
  const controller = {
    getState: () => state,
    isVisible: () => active && visible,
    hasUnsaved: () => state.dirty || state.submitting,
    setContext(context = {}) {
      if (!active) return;
      const next = { scope: context.scope, projectId: context.projectId || null, connected: Boolean(context.connected), pending: Boolean(context.pending) };
      const timeline = context.timeline?.projectId === next.projectId ? context.timeline : null;
      if (next.scope !== state.scope || next.projectId !== state.projectId) { serial++; resolved.clear(); state = initial(); emit({ ...next, timeline, selection: ++sequence }); return; }
      if (timeline && state.timeline && timeline.id === state.timeline.id && timeline.revision < state.timeline.revision) {
        if (next.connected !== state.connected || next.pending !== state.pending) emit(next);
        return;
      }
      const changed = timeline?.id !== state.timeline?.id || timeline?.revision !== state.timeline?.revision;
      if (!changed && next.connected === state.connected && next.pending === state.pending) return;
      const retained = state.dirty || state.submitting || state.uncertain;
      const saved = cues(timeline).find(cue => cue.id === state.cueId);
      emit({ ...next, timeline, ...(changed ? retained ? { conflict: true } : { draft: fields(saved), cueId: saved?.id || null, baseRevision: timeline?.revision ?? null, conflict: false } : {}) });
    },
    setVisible(value) { visible = Boolean(value); },
    select(cueId, expectedScope = state.scope) {
      sync();
      if (!active || expectedScope !== state.scope || state.dirty || state.submitting || state.uncertain) return false;
      const cue = cues(state.timeline).find(cue => cue.id === cueId);
      if (!cue) return false;
      serial++; emit({ cueId, selection: ++sequence, draft: fields(cue), baseRevision: state.timeline.revision, dirty: false, conflict: false, error: '', errorMessage: null }); return true;
    },
    begin(frame, expectedScope = state.scope) {
      sync();
      if (!active || expectedScope !== state.scope || state.dirty || state.submitting || state.uncertain || subtitleAddReason(state.timeline, frame, state.pending || !state.connected)) return false;
      const nextStart = Math.min(state.timeline.durationFrames, ...cues(state.timeline).filter(cue => cue.startFrame > frame).map(cue => cue.startFrame));
      serial++; emit({ cueId: null, selection: ++sequence, draft: { text: '', startFrame: frame, durationFrames: Math.min(90, nextStart - frame) }, baseRevision: state.timeline.revision, dirty: true, conflict: false, error: '', errorMessage: null }); return true;
    },
    edit(key, value, expected = state) {
      if (!admits(expected) || !state.draft || !['text', 'startFrame', 'durationFrames'].includes(key)) return false;
      serial++; emit({ draft: { ...state.draft, [key]: value }, dirty: true }); return true;
    },
    discardDraft(expectedScope = state.scope) {
      sync(); if (!active || expectedScope !== state.scope || state.submitting) return false;
      serial++; const saved = cues(state.timeline).find(cue => cue.id === state.cueId);
      emit({ selection: ++sequence, cueId: saved?.id || null, draft: fields(saved), baseRevision: state.timeline?.revision ?? null, dirty: false, conflict: false, error: state.uncertain ? state.error : '', errorMessage: state.uncertain ? state.errorMessage : null }); return true;
    },
    save(expected = state) { return send(state.cueId ? 'timeline.subtitle.update' : 'timeline.subtitle.add', expected); },
    remove(expected = state) { return send('timeline.subtitle.remove', expected); },
    recovered(task) {
      sync();
      if (!active || !task.operation?.startsWith('timeline.subtitle.') || !['applied', 'not_applied'].includes(task.status) || task.projectId !== state.projectId) return;
      resolved.set(task.requestId, structuredClone(task.input));
      const intent = state.uncertain;
      if (intent && intent.operation === task.operation && intent.input.requestId === task.requestId && taskInputKey(intent.input) === taskInputKey(task.input)) emit({ uncertain: null, conflict: state.dirty && task.status === 'applied' || state.conflict, errorMessage: message(task.status === 'applied' ? 'subtitles.error.recoveredApplied' : 'subtitles.error.recoveredNotApplied'), error: task.status === 'applied' ? '原请求已应用。草稿仍保留；放弃草稿后可选择时间线上的已保存字幕。' : '原请求已确认未应用，可核对草稿后保存。' });
    },
    activate() { active = true; },
    dispose() { active = false; visible = false; serial++; state = initial(); sequence++; resolved.clear(); },
  };
  return controller;
}
