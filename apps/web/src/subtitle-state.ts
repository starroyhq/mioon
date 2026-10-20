import type { AgentEditingProof } from './agent-editing-proof.ts';
import { message, renderMessage } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/types.ts';
import type { MessageKey } from '../../../packages/i18n/src/index.ts';
import { TIMELINE_SUBTITLE_LIMITS, TIMELINE_SUBTITLE_PROFILE_ID, getTimelineSubtitleIssue, isTimelineMutationResponse } from '@mioon/contracts';
import { taskInputKey } from './edit-task-client.ts';

export { TIMELINE_SUBTITLE_LIMITS };

export interface SubtitleCue { readonly id: string; readonly text: string; readonly startFrame: number; readonly durationFrames: number }
export interface SubtitleTimeline {
  readonly id: string;
  readonly projectId: string;
  readonly revision: number;
  readonly durationFrames: number;
  readonly subtitles?: { readonly cues?: readonly SubtitleCue[] } | null;
}
export interface SubtitleCueFields { text: string; startFrame: number | string; durationFrames: number | string }
export interface SubtitleDraft { text: string; startFrame: number | string; durationFrames: number | string }
export interface SubtitleIssue {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly displayMessage?: undefined;
}
interface SubtitleLocalIssue { readonly message: string; readonly displayMessage: DisplayMessage; readonly code?: undefined; readonly details?: undefined }
type SubtitleDraftValidation = SubtitleIssue | SubtitleLocalIssue;
export interface SubtitleState {
  scope: string | null;
  projectId: string | null;
  timeline: SubtitleTimeline | null;
  cueId: string | null;
  selection: number;
  draft: SubtitleDraft | null;
  baseRevision: number | null;
  dirty: boolean;
  conflict: boolean;
  submitting: boolean;
  uncertain: SubtitleIntent | null;
  connected: boolean;
  pending: boolean;
  error: string;
  errorMessage: DisplayMessage | null;
}
export interface SubtitleMutationInput {
  projectId: string | null;
  expectedRevision: number | null;
  requestId: string;
  cueId?: string | null;
  patch?: { text?: unknown; startFrame?: number; durationFrames?: number };
  text?: unknown;
  startFrame?: number;
  durationFrames?: number;
}
export interface SubtitleIntent {
  readonly scope: string | null;
  readonly projectId: string | null;
  readonly timelineId: string | null;
  readonly selection: number;
  readonly serial: number;
  readonly operation: string;
  readonly input: Readonly<SubtitleMutationInput>;
  readonly previousIds: readonly string[];
}
export interface SubtitleContext {
  collaboration?: AgentEditingProof | null;
  scope?: string | null;
  projectId?: string | null;
  timeline?: SubtitleTimeline | null;
  connected?: boolean;
  pending?: boolean;
}
export interface SubtitleSubmitResult { status?: string; timeline?: unknown; error?: unknown }
export interface SubtitleRecoveredTask {
  operation?: unknown;
  status?: unknown;
  projectId?: unknown;
  requestId?: unknown;
  input?: unknown;
}
export interface SubtitleControllerOptions {
  submit: (intent: SubtitleIntent) => Promise<SubtitleSubmitResult | null | undefined>;
  createRequestId: () => string;
  getContext?: () => SubtitleContext | null | undefined;
  onChange?: (state: SubtitleState) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fields = (cue: { readonly text?: unknown; readonly startFrame?: unknown; readonly durationFrames?: unknown } | null | undefined): { text?: unknown; startFrame?: unknown; durationFrames?: unknown } | null => cue ? { text: cue.text, startFrame: cue.startFrame, durationFrames: cue.durationFrames } : null;
const cues = (timeline: SubtitleTimeline | null | undefined): readonly SubtitleCue[] => timeline?.subtitles?.cues || [];
const initial = (): SubtitleState => ({ scope: null, projectId: null, timeline: null, cueId: null, selection: 0, draft: null, baseRevision: null, dirty: false, conflict: false, submitting: false, uncertain: null, connected: false, pending: true, error: '', errorMessage: null });
const protocolError = (): Error => Object.assign(new Error('字幕确认与原请求不一致；草稿仍保留，请在任务中心核对。'), { code: 'BACKEND_PROTOCOL_ERROR' });

function subtitleIssue(value: unknown): SubtitleIssue | null {
  if (!isRecord(value) || typeof value.code !== 'string') return null;
  return { code: value.code, message: typeof value.message === 'string' ? value.message : '', ...(isRecord(value.details) ? { details: value.details } : {}) };
}
function subtitleDraftValidation(state: SubtitleState | null | undefined): SubtitleDraftValidation | null {
  if (!state?.draft || !state.timeline) return { message: '请先选择字幕或在播放头处新增。', displayMessage: message('subtitles.error.select') };
  const draft = state.draft;
  if (draft.startFrame === '' || draft.durationFrames === '') return { message: '开始帧与持续帧数必须填写整数。', displayMessage: message('subtitles.error.integer') };
  // The placeholder exists only for shared draft validation, never in an RPC.
  const ids = new Set(cues(state.timeline).map(cue => cue.id));
  let placeholder = 0, draftId: string;
  do { draftId = `00000000-0000-4000-8000-${String(placeholder++).padStart(12, '0')}`; } while (ids.has(draftId));
  const candidate = { id: state.cueId || draftId, ...fields(draft), startFrame: Number(draft.startFrame), durationFrames: Number(draft.durationFrames) };
  return subtitleIssue(getTimelineSubtitleIssue({ profileId: TIMELINE_SUBTITLE_PROFILE_ID, cues: [...cues(state.timeline).filter(cue => cue.id !== state.cueId), candidate] }, state.timeline.durationFrames));
}

export const subtitleDraftIssue = (state: SubtitleState | null | undefined): string => subtitleDraftValidation(state)?.message || '';
export function subtitleDraftMessage(state: SubtitleState | null | undefined): DisplayMessage | null {
  const issue = subtitleDraftValidation(state);
  if (!issue) return null;
  if (issue.displayMessage) return issue.displayMessage;
  if (issue.code === 'SUBTITLE_TEXT_INVALID') {
    const details = issue.details || {};
    const line = details.line, column = details.column, codePoint = details.codePoint;
    return typeof line === 'number' && Number.isSafeInteger(line) && line > 0 && typeof column === 'number' && Number.isSafeInteger(column) && column > 0 && typeof codePoint === 'string' && /^U\+[A-F0-9]{4,6}$/.test(codePoint)
      ? message('subtitles.error.character', { line, column, codePoint }) : message('subtitles.error.text');
  }
  const issueKeys: Record<string, MessageKey> = { INVALID_SUBTITLES: 'subtitles.error.invalid', SUBTITLE_LIMIT: 'subtitles.error.limit', SUBTITLE_BOUNDS: 'subtitles.error.bounds', SUBTITLE_OVERLAP: 'subtitles.error.overlap' };
  const key = Object.hasOwn(issueKeys, issue.code) ? issueKeys[issue.code] : 'subtitles.error.invalid';
  return message(key);
}

export const subtitleCanSave = (state: SubtitleState | null | undefined): boolean => Boolean(state?.draft && state.dirty && state.connected && !state.pending && !state.conflict && !state.submitting && !state.uncertain && !subtitleDraftIssue(state));
export function subtitleAddMessage(timeline: SubtitleTimeline | null | undefined, frame: number, blocked = false): DisplayMessage | null {
  if (blocked) return message('subtitles.error.pending');
  if (!timeline || timeline.durationFrames < 1) return message('subtitles.error.mediaFirst');
  if (cues(timeline).length >= TIMELINE_SUBTITLE_LIMITS.cues) return message('subtitles.error.limit');
  if (!Number.isSafeInteger(frame) || frame < 0 || frame >= timeline.durationFrames) return message('subtitles.error.playhead');
  return null;
}
export const subtitleAddReason = (timeline: SubtitleTimeline | null | undefined, frame: number, blocked = false): string => renderMessage('zh-Hans', subtitleAddMessage(timeline, frame, blocked));
export function subtitleAcknowledged(intent: SubtitleIntent | null | undefined, timeline: SubtitleTimeline | null | undefined): boolean {
  if (!intent || timeline?.id !== intent.timelineId || !isTimelineMutationResponse(intent.operation, intent.input, timeline)) return false;
  if (intent.operation !== 'timeline.subtitle.add') return true;
  const added = cues(timeline).filter(cue => !intent.previousIds.includes(cue.id));
  if (added.length !== 1) return false;
  const cue = added[0];
  return cue.text === intent.input.text && cue.startFrame === intent.input.startFrame && cue.durationFrames === intent.input.durationFrames;
}

// Drafts live above the dock. A request owns one project and selection epoch;
// hiding/remounting its view cannot dispatch, clear, or replay that request.
export function createSubtitleController({ submit, createRequestId, getContext, onChange = () => {} }: SubtitleControllerOptions) {
  let state = initial(), serial = 0, sequence = 0, active = true, visible = false;
  let collaborationBaseline:{proof:AgentEditingProof;saved:unknown}|null=null,lastCollaboration:AgentEditingProof|null=null;
  const resolved = new Map<unknown, unknown>();
  const emit = (patch: Partial<SubtitleState>): SubtitleState => { state = { ...state, ...patch }; onChange(state); return state; };
  const sync = (): void => { const context = getContext?.(); if (active && context) controller.setContext(context); };
  const owns = (intent: SubtitleIntent): boolean => { sync(); return active && intent.scope === state.scope && intent.projectId === state.projectId && intent.selection === state.selection; };
  const admits = (expected: SubtitleState | null | undefined): boolean => { sync(); return active && visible && expected?.scope === state.scope && expected?.selection === state.selection; };
  async function send(operation: string, expected: SubtitleState | null | undefined): Promise<SubtitleTimeline | null> {
    if (!admits(expected) || state.pending || state.submitting || state.uncertain || !state.connected || state.conflict) return null;
    const removing = operation === 'timeline.subtitle.remove';
    if (removing ? !state.cueId || state.dirty : !subtitleCanSave(state)) return null;
    const timeline = state.timeline, draft = state.draft;
    if (!timeline || !draft) return null;
    const patchFields = { ...fields(draft), startFrame: Number(draft.startFrame), durationFrames: Number(draft.durationFrames) };
    const input: SubtitleMutationInput = { projectId: state.projectId, expectedRevision: state.baseRevision, requestId: createRequestId(), ...(removing ? { cueId: state.cueId } : state.cueId ? { cueId: state.cueId, patch: patchFields } : patchFields) };
    if (input.patch) Object.freeze(input.patch);
    const intent: SubtitleIntent = Object.freeze({ scope: state.scope, projectId: state.projectId, timelineId: timeline.id, selection: state.selection, serial, operation, input: Object.freeze(input), previousIds: Object.freeze(cues(timeline).map(cue => cue.id)) });
    emit({ submitting: true, error: '', errorMessage: null });
    let result: SubtitleSubmitResult | null | undefined;
    try {
      result = await submit(intent);
      if (!owns(intent)) return null;
      if (result?.status === 'applied') {
        const saved = result.timeline;
        if (!subtitleAcknowledged(intent, saved as SubtitleTimeline)) throw protocolError();
        const applied = saved as SubtitleTimeline, current = state.timeline;
        if (!current) return null;
        if (current.revision > applied.revision) { emit({ submitting: false, conflict: true, error: '时间线已有更新版本；请核对后放弃草稿并载入最新字幕。', errorMessage: message('subtitles.error.newer') }); return applied; }
        const cue = removing ? null : cues(applied).find(cue => intent.input.cueId ? cue.id === intent.input.cueId : !intent.previousIds.includes(cue.id));
        emit({ timeline: applied, cueId: cue?.id || null, baseRevision: applied.revision, submitting: false, uncertain: null, conflict: false, error: '', errorMessage: null, ...(serial === intent.serial ? { draft: fields(cue) as SubtitleDraft | null, dirty: false } : { dirty: true }) });
        return applied;
      }
    } catch (error) { result = { status: 'unknown', error }; }
    if (!owns(intent)) return null;
    const known = resolved.get(intent.input.requestId);
    const unknown = result?.status !== 'rejected' && !(known && taskInputKey(known) === taskInputKey(intent.input));
    const errorMessage = isRecord(result?.error) && typeof result.error.message === 'string' ? result.error.message : '请求未应用，草稿仍保留。';
    emit({ submitting: false, uncertain: unknown ? intent : null, errorMessage: message(unknown ? 'subtitles.error.unknown' : 'subtitles.error.notApplied'), error: unknown ? '结果待确认。草稿仍保留，请到任务中心恢复同一请求；不要重新提交。' : errorMessage });
    return null;
  }
  const controller = {
    getState: (): SubtitleState => state,
    isVisible: (): boolean => active && visible,
    hasUnsaved: (): boolean => state.dirty || state.submitting,
    setContext(context: SubtitleContext = {}): void {
      if (!active) return;
      const next = { scope: context.scope ?? null, projectId: context.projectId || null, connected: Boolean(context.connected), pending: Boolean(context.pending) };
      const timeline = context.timeline?.projectId === next.projectId ? context.timeline : null;
      if (next.scope !== state.scope || next.projectId !== state.projectId) { serial++; collaborationBaseline=null;lastCollaboration=null; resolved.clear(); state = initial(); emit({ ...next, timeline, selection: ++sequence }); return; }
      if (timeline && state.timeline && timeline.id === state.timeline.id && timeline.revision < state.timeline.revision) {
        if (next.connected !== state.connected || next.pending !== state.pending) emit(next);
        return;
      }
      const changed = timeline?.id !== state.timeline?.id || timeline?.revision !== state.timeline?.revision;
      const proof=context.collaboration??null,proofChanged=JSON.stringify(proof)!==JSON.stringify(lastCollaboration);lastCollaboration=proof?{...proof}:null;
      if (!changed && !proofChanged && next.connected === state.connected && next.pending === state.pending) return;
      const retained = state.dirty || state.submitting || state.uncertain;
      const saved = cues(timeline).find(cue => cue.id === state.cueId);
      const baseline=collaborationBaseline,canRebase=proof&&baseline&&proof.ownerId===baseline.proof.ownerId&&proof.kind===baseline.proof.kind&&proof.id===baseline.proof.id&&proof.revision===baseline.proof.revision&&proof.timelineRevision===timeline?.revision&&JSON.stringify(fields(saved))===JSON.stringify(baseline.saved);
      if(retained&&canRebase&&!state.submitting&&!state.uncertain){if(state.baseRevision!==timeline?.revision)serial++;emit({...next,timeline,baseRevision:timeline?.revision??null,conflict:false});}
      else {if(!retained)collaborationBaseline=proof?{proof:{...proof},saved:fields(saved)}:null;emit({ ...next, timeline, ...(changed ? retained ? { conflict: true } : { draft: fields(saved) as SubtitleDraft | null, cueId: saved?.id || null, baseRevision: timeline?.revision ?? null, conflict: false } : {}) });}
    },
    setVisible(value: boolean): void { visible = Boolean(value); },
    select(cueId: string, expectedScope: string | null = state.scope): boolean {
      sync();
      if (!active || expectedScope !== state.scope || state.dirty || state.submitting || state.uncertain) return false;
      const timeline = state.timeline, cue = cues(timeline).find(cue => cue.id === cueId);
      if (!timeline || !cue) return false;
      collaborationBaseline=null;lastCollaboration=null;serial++; emit({ cueId, selection: ++sequence, draft: fields(cue) as SubtitleDraft, baseRevision: timeline.revision, dirty: false, conflict: false, error: '', errorMessage: null }); return true;
    },
    begin(frame: number, expectedScope: string | null = state.scope): boolean {
      sync();
      if (!active || expectedScope !== state.scope || state.dirty || state.submitting || state.uncertain || subtitleAddReason(state.timeline, frame, state.pending || !state.connected)) return false;
      const timeline = state.timeline;
      if (!timeline) return false;
      const nextStart = Math.min(timeline.durationFrames, ...cues(timeline).filter(cue => cue.startFrame > frame).map(cue => cue.startFrame));
      serial++; emit({ cueId: null, selection: ++sequence, draft: { text: '', startFrame: frame, durationFrames: Math.min(90, nextStart - frame) }, baseRevision: timeline.revision, dirty: true, conflict: false, error: '', errorMessage: null }); return true;
    },
    edit(key: 'text' | 'startFrame' | 'durationFrames', value: string | number, expected: SubtitleState = state): boolean {
      const draft = state.draft;
      if (!admits(expected) || !draft || !['text', 'startFrame', 'durationFrames'].includes(key)) return false;
      serial++; emit({ draft: { ...draft, [key]: value } as SubtitleDraft, dirty: true }); return true;
    },
    discardDraft(expectedScope: string | null = state.scope): boolean {
      sync(); if (!active || expectedScope !== state.scope || state.submitting) return false;
      const timeline = state.timeline;
      serial++; const saved = cues(timeline).find(cue => cue.id === state.cueId);
      emit({ selection: ++sequence, cueId: saved?.id || null, draft: fields(saved) as SubtitleDraft | null, baseRevision: timeline?.revision ?? null, dirty: false, conflict: false, error: state.uncertain ? state.error : '', errorMessage: state.uncertain ? state.errorMessage : null }); return true;
    },
    save(expected: SubtitleState = state): Promise<SubtitleTimeline | null> { return send(state.cueId ? 'timeline.subtitle.update' : 'timeline.subtitle.add', expected); },
    remove(expected: SubtitleState = state): Promise<SubtitleTimeline | null> { return send('timeline.subtitle.remove', expected); },
    recovered(task: SubtitleRecoveredTask): void {
      sync();
      if (!active || typeof task.operation !== 'string' || !task.operation.startsWith('timeline.subtitle.') || !['applied', 'not_applied'].includes(typeof task.status === 'string' ? task.status : '') || task.projectId !== state.projectId) return;
      resolved.set(task.requestId, structuredClone(task.input));
      const intent = state.uncertain;
      if (intent && intent.operation === task.operation && intent.input.requestId === task.requestId && taskInputKey(intent.input) === taskInputKey(task.input)) emit({ uncertain: null, conflict: state.dirty && task.status === 'applied' || state.conflict, errorMessage: message(task.status === 'applied' ? 'subtitles.error.recoveredApplied' : 'subtitles.error.recoveredNotApplied'), error: task.status === 'applied' ? '原请求已应用。草稿仍保留；放弃草稿后可选择时间线上的已保存字幕。' : '原请求已确认未应用，可核对草稿后保存。' });
    },
    activate(): void { active = true; },
    dispose(): void { active = false; visible = false; serial++; state = initial(); sequence++; resolved.clear(); },
  };
  return controller;
}
