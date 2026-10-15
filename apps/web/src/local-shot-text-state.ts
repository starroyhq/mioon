import { message as displayMessage } from '../../../packages/i18n/src/index.ts';
import type { MessageDescriptor } from '../../../packages/i18n/src/index.ts';
import { recoveryErrorMessage } from './recovery-display.ts';
import { useLayoutEffect, useRef, useState } from 'react';
import { createLocalShotTextSchemas, localShotTextDraftPutSchema, isLocalShotTextMutationResponse, LOCAL_SHOT_TEXT_LIMITS } from '@mioon/contracts/local-shot-text';
import type { LocalShotTextDraftPut, LocalShotTextDraftDelete, LocalShotTextDraftRaw, LocalShotTextDraftValue, LocalShotTextEnvelope, LocalShotTextIntent, LocalShotTextPrepare, LocalShotTextUpdateInput } from '@mioon/contracts/local-shot-text';
import { createLocalShotTextClient, LocalShotTextRequestError, localShotTextFailure, localShotTextProtocolError } from './local-shot-text-client.ts';
import type { LocalShotTextClient, LocalShotTextFailure } from './local-shot-text-client.ts';
import type { EditorCloseOwnerSnapshot } from './editor-window-close.ts';
import { readEditorRetentionIdentity } from './editor-window-close.ts';

export interface LocalShotTextContext {
  scope: string; projectId: string | null; shotId: string | null; revision: number | null;
  baseRevision: number | null; baseText: LocalShotTextDraftRaw; savedText: LocalShotTextDraftRaw;
  restored: boolean; connected: boolean; visible: boolean; busy: boolean;
  raw: LocalShotTextDraftRaw; textVersion: number; formSerial: number; textDirty: boolean; formDirty: boolean;
  executionEpoch?: string | number;
}
export interface LocalShotTextCapture {
  readonly scope: string; readonly projectId: string | null; readonly shotId: string | null; readonly revision: number | null;
  readonly baseRevision: number | null; readonly baseText: LocalShotTextDraftRaw; readonly raw: LocalShotTextDraftRaw;
  readonly textVersion: number; readonly formSerial: number; readonly serial: number; readonly generation: number; readonly executionEpoch?: string | number;
}
/** Read-only close identity. Reading it never synchronizes context, emits,
 * schedules autosave, or changes the existing draft/retention semantics. */
export interface LocalShotTextCloseSnapshot {
  readonly dirty: boolean;
  readonly serial: number; readonly generation: number; readonly formSerial: number; readonly textVersion: number;
  readonly scope: string; readonly projectId: string | null; readonly shotId: string | null;
  readonly revision: number | null; readonly baseRevision: number | null; readonly executionEpoch?: string | number;
}
export type LocalShotTextSupported = Extract<LocalShotTextEnvelope, { supported: true }>;
export interface LocalShotTextState {
  scope: string; projectId: string | null; shotId: string | null; phase: 'loading' | 'ready' | 'saving' | 'saved' | 'error' | 'unsupported';
  raw: LocalShotTextDraftRaw; dirty: boolean; baseline: { baseRevision: number; baseText: LocalShotTextDraftRaw } | null; baselineConflict: boolean;
  candidate: LocalShotTextDraftValue | null; savedAt: string | null; draftFailure: LocalShotTextFailure | null; draftError: string; draftErrorDisplay?: MessageDescriptor;
  autosavePaused: boolean; leaveWithoutSaving: boolean; draftRetry: 'same' | 'current' | null; retainedDraftWrite: LocalShotTextDraftPut | null;
  retainedDeletion: LocalShotTextDraftDelete | null; retainedPreparation: LocalShotTextPrepare | null; intent: LocalShotTextIntent | null; intentPhase: 'idle' | 'preparing' | 'pending' | 'executing' | 'applied' | 'not_applied' | 'error';
  intentUncertain: boolean; intentFailure: LocalShotTextFailure | null; intentError: string; intentErrorDisplay?: MessageDescriptor; busy: boolean; pending: boolean;
  projectPendingIntent: { shotId: string; intentId: string } | null;
}
export interface LocalShotTextAccepted {
  response: unknown; intent: LocalShotTextIntent; capture: LocalShotTextCapture; recovered: boolean;
}
export function createLocalShotTextRetention() {
  return { preparations: new Map<string, LocalShotTextPrepare>(), writes: new Map<string, LocalShotTextDraftPut>(), deletions: new Map<string, LocalShotTextDraftDelete>() };
}
const inspectorSessionRetention = createLocalShotTextRetention();
interface Options {
  context: LocalShotTextContext; retention?: ReturnType<typeof createLocalShotTextRetention>; getContext?: () => LocalShotTextContext; client?: LocalShotTextClient;
  isShotUpdateInput: (value: unknown) => boolean;
  onRestore?: (draft: LocalShotTextDraftValue, capture: LocalShotTextCapture) => boolean;
  onRebase?: (capture: LocalShotTextCapture) => boolean;
  onAccepted?: (result: LocalShotTextAccepted) => boolean | void;
  onChange?: (state: LocalShotTextState) => void; delay?: number; createId?: () => string;
}
const copy = <T,>(value: T): T => structuredClone(value);
export const sameLocalShotTextValue = (left: unknown, right: unknown): boolean => JSON.stringify(left, (_, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value) === JSON.stringify(right, (_, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
const message = (error: unknown) => error instanceof Error ? error.message : '本地文字状态尚未确认，当前输入与原请求仍保留。';
const authority = (value: LocalShotTextSupported) => ({ workspaceScope: value.workspaceScope, instanceId: value.instanceId, projectId: value.projectId, shotId: value.shotId });
const pendingIntent = (intent: LocalShotTextIntent | null) => intent?.outcome.status === 'pending';
const terminalReveal = (previous: LocalShotTextIntent | null, next: LocalShotTextIntent | null) => Boolean(previous && next && pendingIntent(previous) && !pendingIntent(next) && sameLocalShotTextValue({ ...previous, outcome: null }, { ...next, outcome: null }));
const keyOf = (value: { workspaceScope?: string; projectId: string | null; shotId: string | null }) => `${value.workspaceScope ?? ''}:${value.projectId}:${value.shotId}`;

/** Passive reads discover recovery records only. Text edits are causal: a new
 * observed server value, mount or form hydration is never a local user edit. */
export function createLocalShotTextController({ context: initial, getContext, client, isShotUpdateInput, onRestore, onRebase, onAccepted, retention = createLocalShotTextRetention(), onChange = () => {}, delay = 250, createId = () => crypto.randomUUID() }: Options) {
  const transport = client ?? createLocalShotTextClient({ isShotUpdateInput }), schemas = createLocalShotTextSchemas(isShotUpdateInput);
  let context = copy(initial), generation = 1, serial = 0, readSerial = 0, active = true, loaded = false;
  let envelope: LocalShotTextSupported | null = null, timer: ReturnType<typeof setTimeout> | undefined, saving: Promise<boolean> | null = null;
  let operation: object | null = null, retrying: object | null = null, restoring = false, abandoned = false;
  const uncertain = retention.preparations, uncertainWrites = retention.writes, uncertainDeletions = retention.deletions;
  const captures = new WeakSet<LocalShotTextCapture>();
  const baselineOf = () => context.baseRevision ? { baseRevision: context.baseRevision, baseText: copy(context.baseText) } : null;
  const initialState = (): LocalShotTextState => ({ scope: context.scope, projectId: context.projectId, shotId: context.shotId,
    phase: context.restored ? 'unsupported' : 'loading', raw: copy(context.raw), dirty: context.textDirty, baseline: context.textDirty ? baselineOf() : null,
    baselineConflict: false, candidate: null, savedAt: null, draftFailure: null, draftError: '', draftErrorDisplay: undefined, autosavePaused: uncertainWrites.has(keyOf(envelope ?? context)) || uncertainDeletions.has(keyOf(envelope ?? context)), leaveWithoutSaving: false,
    draftRetry: uncertainWrites.has(keyOf(envelope ?? context)) ? 'same' : null, retainedDeletion: copy(uncertainDeletions.get(keyOf(envelope ?? context)) ?? null), retainedDraftWrite: copy(uncertainWrites.get(keyOf(envelope ?? context)) ?? null), retainedPreparation: copy(uncertain.get(keyOf(envelope ?? context)) ?? null),
    intent: null, intentPhase: 'idle', intentUncertain: uncertain.has(keyOf(envelope ?? context)), intentFailure: null, intentError: '', intentErrorDisplay: undefined, busy: false, pending: uncertain.has(keyOf(envelope ?? context)), projectPendingIntent: null });
  let state = initialState();
  function emit(patch: Partial<LocalShotTextState>) {
    state = { ...state, ...patch, retainedDraftWrite: copy(uncertainWrites.get(keyOf(envelope ?? context)) ?? null), retainedPreparation: copy(uncertain.get(keyOf(envelope ?? context)) ?? null), retainedDeletion: copy(uncertainDeletions.get(keyOf(envelope ?? context)) ?? null) };
    state.pending = state.intentUncertain || pendingIntent(state.intent) || state.intentPhase === 'preparing' || state.intentPhase === 'executing' || Boolean(state.projectPendingIntent);
    state.baselineConflict = Boolean(state.baseline && (state.baseline.baseRevision !== context.revision || !sameLocalShotTextValue(state.baseline.baseText, context.savedText)));
    if (active) onChange(state);
  }
  const belongs = (owner: number) => active && generation === owner;
  const sync = () => { if (getContext) controller.setContext(getContext()); };
  function draftFailure(error: unknown, retry: 'same' | 'current' | null = uncertainWrites.has(keyOf(envelope ?? context)) ? 'same' : state.draftFailure ? state.draftRetry : 'current') {
    const observed = localShotTextFailure(error);
    emit({ phase: 'error', autosavePaused: true, draftRetry: retry, draftFailure: state.draftFailure?.kind === 'unknown' ? state.draftFailure : observed, draftError: message(error), draftErrorDisplay: recoveryErrorMessage(error) });
  }
  function intentFailure(error: unknown, unknown = false) { emit({ intentPhase: 'error', intentFailure: localShotTextFailure(error), intentError: message(error), intentErrorDisplay: recoveryErrorMessage(error), intentUncertain: unknown }); }
  function validateEnvelope(value: LocalShotTextEnvelope, projectId: string, shotId: string): LocalShotTextSupported {
    const parsed = schemas.envelope.safeParse(value);
    if (!parsed.success || !parsed.data.supported || parsed.data.projectId !== projectId || parsed.data.shotId !== shotId) throw localShotTextProtocolError();
    if (parsed.data.intent?.outcome.status === 'not_applied' && parsed.data.intent.outcome.code !== 'REVISION_CONFLICT') throw localShotTextProtocolError();
    return parsed.data;
  }
  function receive(next: LocalShotTextSupported, previous: LocalShotTextSupported | null, field?: 'draft' | 'intent') {
    if (previous && (next.workspaceScope !== previous.workspaceScope || next.instanceId !== previous.instanceId || next.projectId !== previous.projectId || next.shotId !== previous.shotId ||
        next.draftRevision < previous.draftRevision || next.intentRevision < previous.intentRevision || field === 'draft' && next.draftRevision !== previous.draftRevision + 1 || field === 'intent' && next.intentRevision <= previous.intentRevision)) throw localShotTextProtocolError();
    if (envelope && (next.draftRevision < envelope.draftRevision || next.intentRevision < envelope.intentRevision ||
        next.draftRevision === envelope.draftRevision && !sameLocalShotTextValue(next.draft, envelope.draft) ||
        next.intentRevision === envelope.intentRevision && !sameLocalShotTextValue(next.intent, envelope.intent) && !terminalReveal(envelope.intent, next.intent))) throw localShotTextProtocolError();
    if (envelope?.intent && next.intent?.intentId === envelope.intent.intentId &&
        (!sameLocalShotTextValue({ ...next.intent, outcome: null }, { ...envelope.intent, outcome: null }) ||
          !pendingIntent(envelope.intent) && !sameLocalShotTextValue(next.intent.outcome, envelope.intent.outcome))) throw localShotTextProtocolError();
    const key = keyOf(next), retained = uncertain.get(key), write = uncertainWrites.get(key), deletion = uncertainDeletions.get(key);
    if (retained && retained.workspaceScope !== next.workspaceScope || write && write.workspaceScope !== next.workspaceScope || deletion && deletion.workspaceScope !== next.workspaceScope) throw localShotTextProtocolError();
    if (retained && next.intent?.intentId === retained.intentId && (next.intent.baseRevision !== retained.baseRevision || !sameLocalShotTextValue(next.intent.baseText, retained.baseText) || !sameLocalShotTextValue(next.intent.draft, retained.draft) || !sameLocalShotTextValue(next.intent.input, retained.input))) throw localShotTextProtocolError();
    envelope = copy(next); loaded = true;
    if (retained && next.intent?.intentId === retained.intentId && sameLocalShotTextValue(next.intent.input, retained.input) && !pendingIntent(next.intent)) uncertain.delete(key);
    emit({ intent: copy(next.intent), intentUncertain: uncertain.has(key), intentPhase: next.intent?.outcome.status ?? 'idle', projectPendingIntent: copy(next.projectPendingIntent) });
  }
  const draftMatches = (draft: LocalShotTextDraftValue | null, raw = state.raw, baseline = state.baseline) => Boolean(draft && baseline && draft.baseRevision === baseline.baseRevision && sameLocalShotTextValue(draft.baseText, baseline.baseText) && sameLocalShotTextValue(draft.raw, raw));
  const hasUnsavedInput = () => !abandoned && context.formDirty || state.retainedDeletion !== null || ((state.dirty || state.retainedDraftWrite !== null || state.retainedDeletion !== null) && !state.leaveWithoutSaving && (state.retainedDraftWrite !== null || state.retainedDeletion !== null || !draftMatches(envelope?.draft ?? null))) || retrying !== null || state.phase === 'saving' || state.intentPhase === 'preparing' || state.intentPhase === 'executing';
  const preparationUnconfirmed = () => { const retained = uncertain.get(keyOf(envelope ?? context)); return Boolean(retained && (!envelope?.intent || envelope.intent.intentId !== retained.intentId || !sameLocalShotTextValue(envelope.intent.input, retained.input))); };
  const readyToSave = () => active && loaded && envelope && context.connected && context.visible && !context.restored && context.projectId && context.shotId && state.dirty && !state.candidate && !state.autosavePaused && !operation && !preparationUnconfirmed();
  function schedule() { if (timer) clearTimeout(timer); timer = undefined; if (readyToSave() && !saving) timer = setTimeout(() => { timer = undefined; void flush(); }, delay); }
  function capture(): LocalShotTextCapture {
    sync(); const token = Object.freeze({ scope: context.scope, projectId: context.projectId, shotId: context.shotId, revision: context.revision, baseRevision: context.baseRevision,
      baseText: copy(context.baseText), raw: copy(context.raw), textVersion: context.textVersion, formSerial: context.formSerial, serial, generation, executionEpoch: context.executionEpoch }); captures.add(token); return token;
  }
  function isCurrent(token: LocalShotTextCapture): boolean {
    sync(); return captures.has(token) && belongs(token.generation) && token.serial === serial && token.scope === context.scope && token.projectId === context.projectId && token.shotId === context.shotId &&
      token.textVersion === context.textVersion && token.formSerial === context.formSerial && token.revision === context.revision && token.baseRevision === context.baseRevision &&
      sameLocalShotTextValue(token.baseText, context.baseText) && sameLocalShotTextValue(token.raw, context.raw) && token.executionEpoch === context.executionEpoch;
  }
  async function load(): Promise<void> {
    sync(); if (!active || !context.projectId || !context.shotId || context.restored || saving || operation) return;
    const owner = generation, reading = ++readSerial, projectId = context.projectId, shotId = context.shotId, previous = envelope;
    emit({ phase: 'loading' });
    try {
      const result = await transport.get(projectId, shotId); sync(); if (!belongs(owner) || reading !== readSerial) return;
      const parsed = schemas.envelope.safeParse(result); if (!parsed.success) throw localShotTextProtocolError();
      if (!parsed.data.supported) { loaded = false; envelope = null; state = initialState(); emit({ phase: 'unsupported' }); return; }
      const next = validateEnvelope(result, projectId, shotId);
      if (previous && next.workspaceScope !== previous.workspaceScope) throw localShotTextProtocolError();
      receive(next, previous ? { ...previous, instanceId: next.instanceId } : null);
      const matches = draftMatches(next.draft), retainedWrite = uncertainWrites.get(keyOf(next)), retainedDeletion = uncertainDeletions.get(keyOf(next));
      emit({ phase: matches ? 'saved' : 'ready', candidate: next.draft && !matches ? copy(next.draft) : null, savedAt: next.draft?.updatedAt ?? null,
        autosavePaused: state.autosavePaused || Boolean(retainedWrite || retainedDeletion), draftRetry: retainedWrite ? 'same' : retainedDeletion ? null : state.draftRetry });
      if (!state.autosavePaused) schedule();
    } catch (error) { if (belongs(owner) && reading === readSerial) { loaded = false; draftFailure(error); } }
  }
  async function flush(force = false, explicitRetry = false): Promise<boolean> {
    sync(); if (timer) clearTimeout(timer); timer = undefined;
    if (saving) { const owner = generation; await saving; sync(); if (!belongs(owner)) return false; }
    if (context.restored || state.phase === 'unsupported') return true;
    if (!state.dirty && !force && !uncertainWrites.has(keyOf(envelope ?? context))) return true;
    if (!loaded || !envelope || !context.projectId || !context.shotId || !context.connected || !context.visible || state.candidate || state.autosavePaused || operation || preparationUnconfirmed()) return false;
    const baseline = state.baseline ?? baselineOf(); if (!baseline) return false;
    if (draftMatches(envelope.draft, state.raw, baseline)) { emit({ phase: 'saved', baseline, savedAt: envelope.draft!.updatedAt }); return true; }
    const owner = generation, savedSerial = serial, previous = copy(envelope), raw = copy(state.raw), key = keyOf(previous);
    const input: LocalShotTextDraftPut = { ...authority(previous), expectedDraftRevision: previous.draftRevision, draftId: previous.draft?.draftId ?? createId(), ...baseline, raw };
    if (!localShotTextDraftPutSchema.safeParse(input).success) { draftFailure(new LocalShotTextRequestError('文字超过本地草稿上限或包含无效 Unicode；尚未发送保存请求，原输入保留，不会截断。', 'LOCAL_SHOT_TEXT_LOCAL_VALIDATION', 400), 'current'); return false; }
    if (!uncertainWrites.has(key) && uncertainWrites.size >= LOCAL_SHOT_TEXT_LIMITS.slots) { draftFailure(new LocalShotTextRequestError('当前会话的待确认草稿已达上限；尚未发送本次保存请求。', 'LOCAL_SHOT_TEXT_LOCAL_RETRY_LIMIT', 400), 'current'); return false; }
    uncertainWrites.set(key, copy(input)); readSerial++; emit({ phase: 'saving', baseline, draftError: '', draftErrorDisplay: undefined });
    const work = (async () => {
      try {
        const result = await transport.put(input); sync(); if (!belongs(owner)) return false;
        const next = validateEnvelope(result, previous.projectId, previous.shotId);
        if (!next.draft || next.draft.draftId !== input.draftId || !draftMatches(next.draft, raw, baseline)) throw localShotTextProtocolError();
        receive(next, previous, 'draft'); uncertainWrites.delete(key);
        emit({ phase: serial === savedSerial ? 'saved' : 'ready', savedAt: next.draft.updatedAt,
          ...(explicitRetry && serial !== savedSerial ? { autosavePaused: true, draftRetry: 'current' as const, draftError: '原文字已确认保存。较新的输入仍保留，请明确保存当前文字。', draftErrorDisplay: displayMessage('recovery.text.newerInput') } : {}) }); return serial === savedSerial;
      } catch (error) { sync(); const refused = localShotTextFailure(error).kind === 'refused'; if (refused && belongs(owner)) uncertainWrites.delete(key); if (belongs(owner)) draftFailure(error, refused ? 'current' : 'same'); return false; }
    })();
    saving = work; try { return await work; } finally { if (saving === work) saving = null; if (belongs(owner) && serial !== savedSerial && !explicitRetry) schedule(); }
  }
  function canPrepare(): boolean {
    sync();
    const base = state.baseline, patch = base ? { ...(state.raw.title !== base.baseText.title ? { title: state.raw.title } : {}), ...(state.raw.prompt !== base.baseText.prompt ? { prompt: state.raw.prompt } : {}) } : {};
    const validInput = Boolean(base && context.shotId && Object.keys(patch).length && isShotUpdateInput({ requestId: 'shot-text-input-validation', shotId: context.shotId, expectedRevision: base.baseRevision, patch }));
    return Boolean(validInput && active && loaded && envelope && context.projectId && context.shotId && context.revision && context.connected && context.visible && !context.busy && !context.restored && !operation && !saving && !retrying && state.dirty && !state.candidate && !state.autosavePaused && !state.baselineConflict && !state.pending);
  }
  async function executeOriginal(next: LocalShotTextSupported, token: LocalShotTextCapture, recovered: boolean): Promise<unknown | null> {
    const intent = next.intent; if (!intent) throw localShotTextProtocolError();
    const owner = generation; emit({ intentPhase: 'executing' });
    const input = { ...authority(next), intentId: intent.intentId, expectedIntentRevision: next.intentRevision };
    const result = await (recovered ? transport.recover(input) : transport.execute(input)); sync(); if (!belongs(owner)) return null;
    const settled = validateEnvelope(result.envelope, next.projectId, next.shotId);
    if (!settled.intent || settled.intent.intentId !== intent.intentId || !sameLocalShotTextValue({ ...settled.intent, outcome: null }, { ...intent, outcome: null })) throw localShotTextProtocolError();
    if (settled.intent.outcome.status === 'applied') {
      if (!isLocalShotTextMutationResponse(next.projectId, intent, result.response)) throw localShotTextProtocolError();
    } else if (result.response !== null) throw localShotTextProtocolError();
    receive(settled, next);
    if (settled.intent.outcome.status === 'applied') {
      const current = !recovered && isCurrent(token) && context.visible && !context.busy;
      const acknowledged = onAccepted?.({ response: result.response, intent: copy(settled.intent), capture: token, recovered }) === true;
      if (current && acknowledged) emit({ dirty: false, baseline: null, savedAt: settled.draft?.updatedAt ?? null, phase: settled.draft ? 'saved' : 'ready' });
      emit({ intentFailure: null, intentError: '', intentErrorDisplay: undefined }); return result.response;
    }
    emit({ intentError: settled.intent.outcome.status === 'not_applied' ? `服务器已确认原请求未应用（${settled.intent.outcome.code}）。当前文字仍保留，请核对后再保存。` : '原请求结果仍待确认；不会自动重试。', intentErrorDisplay: settled.intent.outcome.status === 'not_applied' ? displayMessage('recovery.text.notAppliedCode', { code: settled.intent.outcome.code }) : displayMessage('recovery.notice.pending') }); return null;
  }
  const controller = {
    getState: () => state, capture, isCurrent, load, flush, canPrepare,
    getEditorCloseSnapshot: (): EditorCloseOwnerSnapshot => Object.freeze({
      dirty: !abandoned && (context.formDirty || state.dirty && !state.leaveWithoutSaving),
      inflight: Boolean(saving || operation || retrying),
      unknown: uncertain.size > 0 || uncertainWrites.size > 0 || uncertainDeletions.size > 0 || state.intentUncertain ||
        pendingIntent(state.intent) || Boolean(state.projectPendingIntent),
      identity: Object.freeze([serial, generation, context.scope, context.projectId, context.shotId, context.revision,
        context.baseRevision, context.formSerial, context.textVersion, context.executionEpoch, abandoned,
        ...readEditorRetentionIdentity(uncertain, uncertainWrites, uncertainDeletions)]),
    }),
    blocksLegacy: (targetShotId?: string) => { sync(); return !context.restored && state.phase !== 'unsupported' && Boolean(!loaded || targetShotId && targetShotId !== context.shotId || state.dirty || state.candidate || state.baselineConflict || state.pending || state.retainedDraftWrite || state.retainedDeletion || state.busy); },
    hasUnsaved: () => { sync(); return hasUnsavedInput(); },
    getNativeCloseSnapshot: (): LocalShotTextCloseSnapshot => Object.freeze({ dirty: hasUnsavedInput(), serial, generation,
      formSerial: context.formSerial, textVersion: context.textVersion, scope: context.scope, projectId: context.projectId, shotId: context.shotId,
      revision: context.revision, baseRevision: context.baseRevision, executionEpoch: context.executionEpoch }),
    hasUnpersisted: () => { sync(); return !context.restored && state.phase !== 'unsupported' && ((state.dirty || state.retainedDraftWrite !== null || state.retainedDeletion !== null) && !state.leaveWithoutSaving && (state.retainedDraftWrite !== null || state.retainedDeletion !== null || !draftMatches(envelope?.draft ?? null)) || state.phase === 'saving' || state.busy); },
    setContext(next: LocalShotTextContext) {
      if (!active || sameLocalShotTextValue(context, next)) return;
      if (next.scope !== context.scope || next.projectId !== context.projectId || next.shotId !== context.shotId || next.restored !== context.restored) {
        if (timer) clearTimeout(timer); timer = undefined; generation++; serial++; readSerial++; context = copy(next); envelope = null; loaded = false; saving = null; operation = null; retrying = null;
        abandoned = false; state = initialState(); emit({}); return;
      }
      if (next.textVersion !== context.textVersion || next.formSerial !== context.formSerial) abandoned = false;
      const textEdit = next.textVersion !== context.textVersion, changed = !sameLocalShotTextValue(next.raw, context.raw);
      context = copy(next);
      if (textEdit) {
        serial++;
        if (next.textDirty || restoring) emit({ raw: copy(next.raw), dirty: true, leaveWithoutSaving: false, baseline: restoring ? state.baseline : state.baseline ?? baselineOf() });
        else emit({ raw: copy(next.raw), dirty: false, baseline: null });
      } else if (changed && !state.dirty && !restoring) emit({ raw: copy(next.raw) });
      else emit({});
      if (!restoring) schedule();
    },
    restore(token = capture()): boolean {
      if (!isCurrent(token) || !state.candidate || !context.visible || context.busy || operation || saving || state.pending || !onRestore) return false;
      const candidate = copy(state.candidate), before = state.baseline; restoring = true; emit({ baseline: { baseRevision: candidate.baseRevision, baseText: copy(candidate.baseText) } });
      let accepted = false; try { accepted = onRestore(candidate, token); sync(); } finally { restoring = false; }
      if (!accepted || !belongs(token.generation)) { if (belongs(token.generation)) emit({ baseline: before }); return false; }
      serial++; emit({ raw: copy(candidate.raw), dirty: true, candidate: null, baseline: { baseRevision: candidate.baseRevision, baseText: copy(candidate.baseText) }, phase: 'saved', savedAt: candidate.updatedAt }); return true;
    },
    async retryDraftSave(token = capture()): Promise<boolean> {
      if (!isCurrent(token) || !context.visible || !context.connected || context.restored || context.busy || operation || saving || retrying || !state.autosavePaused || !state.draftRetry || preparationUnconfirmed()) return false;
      const owner = generation, mode = state.draftRetry, beforeRead = envelope ? copy(envelope) : null, previousCandidate = state.candidate, lock = {}; retrying = lock; emit({ busy: true });
      try {
        await load(); if (!isCurrent(token) || !loaded || !envelope || !context.visible || !context.connected || context.busy || operation || saving || preparationUnconfirmed()) return false;
        const previous = copy(envelope), key = keyOf(previous), retained = uncertainWrites.get(key);
        if (mode === 'current' && !retained) {
          emit({ autosavePaused: false, draftFailure: null, draftRetry: null, leaveWithoutSaving: false, draftError: '', draftErrorDisplay: undefined });
          if (state.candidate && previousCandidate === null && beforeRead && beforeRead.workspaceScope === previous.workspaceScope && beforeRead.draftRevision === previous.draftRevision && sameLocalShotTextValue(beforeRead.draft, previous.draft)) emit({ candidate: null });
          if (state.candidate) { emit({ draftError: '已重新核对记录；请选择恢复已保存文字或明确保留当前文字。', draftErrorDisplay: displayMessage('recovery.text.chooseDraft') }); return false; }
          return await flush(true, true);
        }
        if (!retained || previous.workspaceScope !== retained.workspaceScope) { draftFailure(localShotTextProtocolError(), 'same'); return false; }
        const original = { ...copy(retained), instanceId: previous.instanceId }, savedSerial = serial, baseline = { baseRevision: retained.baseRevision, baseText: retained.baseText };
        readSerial++; emit({ phase: 'saving', draftError: '', draftErrorDisplay: undefined });
        const work = (async () => {
          try {
            const result = await transport.put(original); sync(); if (!belongs(owner)) return false;
            const next = validateEnvelope(result, original.projectId, original.shotId);
            if (next.workspaceScope !== original.workspaceScope || next.instanceId !== original.instanceId || next.draftRevision !== original.expectedDraftRevision + 1 || !next.draft || next.draft.draftId !== original.draftId || !draftMatches(next.draft, original.raw, baseline)) throw localShotTextProtocolError();
            receive(next, previous); uncertainWrites.delete(key); const current = savedSerial === serial && draftMatches(next.draft);
            emit({ phase: current ? 'saved' : 'ready', candidate: null, savedAt: next.draft.updatedAt, autosavePaused: !current, draftFailure: null, draftRetry: current ? null : 'current', leaveWithoutSaving: false,
              draftError: current ? '' : '原文字已确认保存。较新的当前输入仍未保存；请明确保存当前文字，不会自动覆盖。', draftErrorDisplay: current ? undefined : displayMessage('recovery.text.newerUnsaved') }); return current;
          } catch (error) { if (belongs(owner)) draftFailure(error, 'same'); return false; }
        })(); saving = work; try { return await work; } finally { if (saving === work) saving = null; }
      } finally { if (retrying === lock) retrying = null; if (belongs(owner)) emit({ busy: false }); }
    },
    async keepCurrent(token = capture()): Promise<boolean> {
      if (!isCurrent(token) || !loaded || !envelope || !context.visible || !context.connected || context.busy || operation || saving || state.pending || state.autosavePaused || preparationUnconfirmed() || !context.revision) return false;
      const baseline = { baseRevision: context.revision, baseText: copy(context.savedText) };
      if (envelope.draft && (envelope.draft.baseRevision !== baseline.baseRevision || !sameLocalShotTextValue(envelope.draft.baseText, baseline.baseText))) {
        if (!await controller.discardStored(token) || !isCurrent(token) || context.revision !== baseline.baseRevision || !sameLocalShotTextValue(context.savedText, baseline.baseText)) return false;
      }
      if (onRebase && !onRebase(token)) return false;
      sync(); serial++; const dirty = !sameLocalShotTextValue(state.raw, baseline.baseText);
      emit({ candidate: null, baseline: dirty ? baseline : null, dirty, phase: 'ready' }); return dirty ? flush(true) : true;
    },
    async discardStored(token = capture()): Promise<boolean> {
      if (!isCurrent(token) || !loaded || !envelope?.draft || !context.visible || !context.connected || context.busy || operation || saving || state.pending || state.autosavePaused || preparationUnconfirmed()) return false;
      const previous = copy(envelope), owner = generation, lock = {}, key = keyOf(previous); operation = lock; readSerial++;
      const deletion = { ...authority(previous), expectedDraftRevision: previous.draftRevision, draftId: previous.draft!.draftId }; uncertainDeletions.set(key, copy(deletion)); emit({ busy: true });
      try {
        const result = await transport.discard(deletion); sync(); if (!belongs(owner)) return false;
        const next = validateEnvelope(result, previous.projectId, previous.shotId); if (next.draft !== null) throw localShotTextProtocolError(); receive(next, previous, 'draft'); uncertainDeletions.delete(key); emit({ candidate: null, savedAt: null, phase: 'ready' }); return true;
      } catch (error) { if (belongs(owner)) { if (localShotTextFailure(error).kind === 'refused') uncertainDeletions.delete(key); draftFailure(error, null); } return false; }
      finally { if (operation === lock) operation = null; if (belongs(owner)) { emit({ busy: false }); schedule(); } }
    },
    async retryDraftDeletion(token = capture()): Promise<boolean> {
      if (!isCurrent(token) || !context.visible || !context.connected || context.busy || operation || saving || retrying || !state.retainedDeletion) return false;
      const retained = copy(state.retainedDeletion), owner = generation, lock = {}; retrying = lock; emit({ busy: true });
      try {
        await load();
        if (!isCurrent(token) || !loaded || !envelope || !context.visible || !context.connected || context.busy || envelope.workspaceScope !== retained.workspaceScope ||
            envelope.projectId !== retained.projectId || envelope.shotId !== retained.shotId || envelope.draftRevision !== retained.expectedDraftRevision || envelope.draft?.draftId !== retained.draftId) return false;
        const previous = copy(envelope), original = { ...retained, instanceId: previous.instanceId }; readSerial++;
        try {
          const result = await transport.discard(original); sync(); if (!belongs(owner)) return false;
          const next = validateEnvelope(result, original.projectId, original.shotId);
          if (next.draft !== null) throw localShotTextProtocolError(); receive(next, previous, 'draft'); uncertainDeletions.delete(keyOf(original));
          emit({ candidate: null, savedAt: null, phase: 'ready', autosavePaused: true, draftFailure: null, draftRetry: 'current', draftError: '同一草稿删除已确认。当前输入仍保留，请明确选择是否保存当前文字草稿。', draftErrorDisplay: displayMessage('recovery.text.deleted') }); return true;
        } catch (error) { if (belongs(owner)) draftFailure(error, null); return false; }
      } finally { if (retrying === lock) retrying = null; if (belongs(owner)) emit({ busy: false }); }
    },
    async acceptCurrentAfterDeletion(token = capture()): Promise<boolean> {
      if (!isCurrent(token) || !context.visible || !context.connected || context.busy || operation || saving || retrying || !state.retainedDeletion) return false;
      const retained = copy(state.retainedDeletion);
      await load();
      if (!isCurrent(token) || !loaded || !envelope || !context.visible || !context.connected || context.busy || envelope.workspaceScope !== retained.workspaceScope ||
          envelope.projectId !== retained.projectId || envelope.shotId !== retained.shotId || envelope.draftRevision <= retained.expectedDraftRevision) return false;
      uncertainDeletions.delete(keyOf(retained));
      // The user accepts the authoritative current state. This is not an ACK
      // of the old deletion and cannot erase a newer saved draft or launch PUT.
      emit({ autosavePaused: true, draftFailure: null, draftRetry: 'current', draftError: '已接受核对后的当前草稿状态，原删除结果仍不作成功确认。当前输入未自动写入，请明确选择下一步。', draftErrorDisplay: displayMessage('recovery.text.acceptedState') }); return true;
    },
    allowLeaveWithoutSaving(token = capture()): boolean {
      if (!isCurrent(token) || operation || saving || !state.draftFailure || state.draftFailure.kind !== 'refused') return false;
      if (timer) clearTimeout(timer); timer = undefined; emit({ leaveWithoutSaving: true, autosavePaused: true, draftError: '已选择不保存当前本地文字；离开或关闭后，这些输入可能丢失。原文字保存请求不会因此取消。', draftErrorDisplay: displayMessage('recovery.text.leaveNotice') }); return true;
    },
    abandonCurrentInput(token = capture()): boolean {
      if (!isCurrent(token) || operation || saving || retrying) return false;
      if (timer) clearTimeout(timer); timer = undefined;
      abandoned = true; serial++; emit({ dirty: false, baseline: null, candidate: null, leaveWithoutSaving: true, autosavePaused: true }); return true;
    },
    async submit(options: { canExecute?: () => boolean } = {}): Promise<unknown | null> {
      if (!canPrepare() || !context.projectId || !context.shotId || !context.revision || !state.baseline) return null;
      const token = capture(), owner = generation, baseline = copy(state.baseline), raw = copy(state.raw);
      const patch = { ...(raw.title !== baseline.baseText.title ? { title: raw.title } : {}), ...(raw.prompt !== baseline.baseText.prompt ? { prompt: raw.prompt } : {}) };
      const input: LocalShotTextUpdateInput = { requestId: createId(), shotId: context.shotId, expectedRevision: baseline.baseRevision, patch };
      if (!isShotUpdateInput(input) || Object.keys(patch).length === 0) { emit({ intentError: '请填写有效的镜头名称与提示词后，再保存标题和提示词。', intentErrorDisplay: displayMessage('recovery.text.invalidSave') }); return null; }
      if (!await flush(true) || !isCurrent(token) || !canPrepare() || !envelope) return null;
      const previous = copy(envelope), exact = copy(input), intentId = createId(); if (!previous.draft || !draftMatches(previous.draft, raw, baseline)) return null;
      const draft = { draftId: previous.draft.draftId, revision: previous.draftRevision, raw: copy(previous.draft.raw) };
      const preparedInput: LocalShotTextPrepare = { ...authority(previous), expectedIntentRevision: previous.intentRevision, expectedIntentId: previous.intent?.intentId ?? null, intentId, ...baseline, draft, input: exact };
      if (!schemas.prepare.safeParse(preparedInput).success) { intentFailure(localShotTextProtocolError()); return null; }
      const key = keyOf(previous), lock = {}; operation = lock; readSerial++; uncertain.set(key, copy(preparedInput)); emit({ busy: true, intentPhase: 'preparing', intentUncertain: true, intentError: '', intentErrorDisplay: undefined, intentFailure: null });
      try {
        let result: LocalShotTextEnvelope;
        try { result = await transport.prepare(preparedInput); }
        catch (error) { sync(); if (belongs(owner) && localShotTextFailure(error).kind === 'refused') uncertain.delete(key); if (belongs(owner)) intentFailure(error, uncertain.has(key)); return null; }
        sync(); if (!belongs(owner)) return null; const next = validateEnvelope(result, previous.projectId, previous.shotId);
        if (!next.intent || next.intent.intentId !== intentId || !sameLocalShotTextValue(next.intent.input, exact) || next.intent.baseRevision !== baseline.baseRevision || !sameLocalShotTextValue(next.intent.baseText, baseline.baseText) || !sameLocalShotTextValue(next.intent.draft, draft)) throw localShotTextProtocolError();
        receive(next, previous, 'intent'); uncertain.delete(key); emit({ intentUncertain: false });
        if (!isCurrent(token) || !context.visible || !context.connected || context.busy || options.canExecute?.() === false) return null;
        return await executeOriginal(next, token, false);
      } catch (error) { sync(); if (belongs(owner)) intentFailure(error, uncertain.has(key)); return null; }
      finally { if (operation === lock) operation = null; if (belongs(owner)) { emit({ busy: false }); schedule(); } }
    },
    async recover(token = capture()): Promise<unknown | null> {
      if (!isCurrent(token) || !context.visible || !context.connected || context.restored || context.busy || !loaded || !envelope || operation || saving || retrying) return null;
      let previous = copy(envelope); const retained = uncertain.get(keyOf(previous));
      if (!previous.intent && !retained || previous.intent && !pendingIntent(previous.intent) && !retained) return null;
      if (state.projectPendingIntent && state.projectPendingIntent.shotId !== context.shotId) return null;
      if (retained && previous.workspaceScope !== retained.workspaceScope) { intentFailure(localShotTextProtocolError(), true); return null; }
      const owner = generation, lock = {}; operation = lock; readSerial++; emit({ busy: true, intentError: '', intentErrorDisplay: undefined });
      try {
        if (retained && previous.intent?.intentId !== retained.intentId) {
          if (previous.workspaceScope !== retained.workspaceScope || previous.intentRevision !== retained.expectedIntentRevision || (previous.intent?.intentId ?? null) !== retained.expectedIntentId) throw localShotTextProtocolError();
          const result = await transport.prepare({ ...copy(retained), instanceId: previous.instanceId }); sync(); if (!belongs(owner)) return null;
          const next = validateEnvelope(result, previous.projectId, previous.shotId);
          if (!next.intent || next.intent.intentId !== retained.intentId || !sameLocalShotTextValue(next.intent.input, retained.input) || !sameLocalShotTextValue(next.intent.draft, retained.draft) || next.intent.baseRevision !== retained.baseRevision || !sameLocalShotTextValue(next.intent.baseText, retained.baseText)) throw localShotTextProtocolError();
          receive(next, previous, 'intent'); previous = copy(next);
        }
        if (!previous.intent || retained && (previous.intent.intentId !== retained.intentId || !sameLocalShotTextValue(previous.intent.input, retained.input))) throw localShotTextProtocolError();
        if (!isCurrent(token) || !context.visible || !context.connected || context.busy) return null;
        return await executeOriginal(previous, token, true);
      } catch (error) { sync(); if (belongs(owner)) intentFailure(error, state.intentUncertain); return null; }
      finally { if (operation === lock) operation = null; if (belongs(owner)) { emit({ busy: false }); schedule(); } }
    },
    activate() { active = true; },
    dispose() { active = false; generation++; readSerial++; if (timer) clearTimeout(timer); timer = undefined; saving = null; operation = null; retrying = null; loaded = false; },
  };
  return controller;
}
export type LocalShotTextController = ReturnType<typeof createLocalShotTextController>;
export function useLocalShotText(options: Omit<Options, 'onChange'>) {
  const callbacks = useRef(options); callbacks.current = options;
  const [state, setState] = useState<LocalShotTextState | null>(null), ref = useRef<LocalShotTextController | null>(null);
  if (!ref.current) ref.current = createLocalShotTextController({ ...options, retention: options.retention ?? inspectorSessionRetention, getContext: () => callbacks.current.getContext?.() ?? callbacks.current.context,
    onRestore: (draft, capture) => callbacks.current.onRestore?.(draft, capture) ?? false,
    onRebase: capture => callbacks.current.onRebase?.(capture) ?? true,
    onAccepted: result => callbacks.current.onAccepted?.(result), onChange: setState });
  const controller = ref.current, contextKey = JSON.stringify(options.context);
  useLayoutEffect(() => { controller.setContext(options.context); }, [controller, contextKey]);
  useLayoutEffect(() => { controller.activate(); return () => controller.dispose(); }, [controller]);
  useLayoutEffect(() => { void controller.load(); }, [controller, options.context.scope, options.context.projectId, options.context.shotId]);
  return { state: state?.scope === options.context.scope && state.projectId === options.context.projectId && state.shotId === options.context.shotId ? state : controller.getState(), controller };
}

export interface ShotTextForm {
  title: string; prompt: string; [key: string]: unknown;
}
/** A text ACK can only advance the shared form's own exact baseline. Every
 * unrelated input is retained. Historical recovery never acknowledges a form. */
export function mergeFreshShotTextAck<Form extends ShotTextForm>({ result, current, draft, baseline, currentCapture, visible, busy }: {
  result: LocalShotTextAccepted; current: LocalShotTextContext; draft: Form; baseline: Form;
  currentCapture: boolean; visible: boolean; busy: boolean;
}): { draft: Form; baseline: Form; baseRevision: number; dirty: boolean } | null {
  const token = result.capture;
  if (result.recovered || !currentCapture || !visible || busy || !current.projectId || !isLocalShotTextMutationResponse(current.projectId, result.intent, result.response) ||
      current.projectId !== token.projectId || current.shotId !== token.shotId || current.scope !== token.scope || current.formSerial !== token.formSerial || current.textVersion !== token.textVersion ||
      current.executionEpoch !== token.executionEpoch || current.revision !== token.revision || current.baseRevision !== token.baseRevision || current.baseRevision !== result.intent.baseRevision ||
      current.revision !== result.intent.baseRevision || !sameLocalShotTextValue(current.baseText, token.baseText) || !sameLocalShotTextValue(current.raw, token.raw) ||
      !sameLocalShotTextValue(result.intent.baseText, token.baseText)) return null;
  const nextBaseline = { ...baseline, title: result.response.title, prompt: result.response.prompt };
  const nextDraft = { ...draft, title: result.response.title, prompt: result.response.prompt };
  return { draft: nextDraft, baseline: nextBaseline, baseRevision: result.response.revision, dirty: !sameLocalShotTextValue(nextDraft, nextBaseline) };
}
