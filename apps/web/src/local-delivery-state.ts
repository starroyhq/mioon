import { useLayoutEffect, useRef, useState } from 'react';
import { createLocalDeliverySchemas, localDeliveryDraftPutSchema, LOCAL_DELIVERY_LIMITS } from '@mioon/contracts/local-delivery';
import type { LocalDeliveryDraftPut, LocalDeliveryDraftValue, LocalDeliveryEnvelope, LocalDeliveryIntent, LocalDeliveryPrepare, LocalDeliveryRenderInput } from '@mioon/contracts/local-delivery';
import { createLocalDeliveryClient, LocalDeliveryRequestError, localDeliveryFailure, localDeliveryProtocolError } from './local-delivery-client.ts';
import type { LocalDeliveryClient, LocalDeliveryFailure } from './local-delivery-client.ts';

export interface LocalDeliveryContext {
  scope: string; projectId: string | null; timelineId: string | null; timelineRevision: number | null;
  restored: boolean; connected: boolean; visible: boolean; busy: boolean;
  deliveryName: string; nameVersion: number; dirty: boolean; executionEpoch?: string | number;
}
export interface LocalDeliveryCapture {
  readonly scope: string; readonly projectId: string | null; readonly timelineId: string | null; readonly baseRevision: number | null;
  readonly deliveryName: string; readonly nameVersion: number; readonly serial: number; readonly generation: number; readonly executionEpoch?: string | number;
}
export type LocalDeliverySupported = Extract<LocalDeliveryEnvelope, { supported: true }>;
export interface LocalDeliveryState {
  scope: string; projectId: string | null; phase: 'loading' | 'ready' | 'saving' | 'saved' | 'error' | 'unsupported';
  deliveryName: string; dirty: boolean; baseline: { timelineId: string; baseRevision: number } | null; baselineConflict: boolean;
  candidate: LocalDeliveryDraftValue | null; savedAt: string | null; draftFailure: LocalDeliveryFailure | null; draftError: string;
  autosavePaused: boolean; leaveWithoutSaving: boolean; draftRetry: 'same' | 'current' | null; retainedDraftWrite: LocalDeliveryDraftPut | null;
  retainedPreparation: LocalDeliveryPrepare | null; intent: LocalDeliveryIntent | null; intentPhase: 'idle' | 'preparing' | 'pending' | 'executing' | 'accepted' | 'not_applied' | 'error';
  intentUncertain: boolean; intentFailure: LocalDeliveryFailure | null; intentError: string; busy: boolean; pending: boolean;
}
export interface LocalDeliveryAccepted {
  response: unknown; intent: LocalDeliveryIntent; capture: LocalDeliveryCapture; nameCapture: unknown; recovered: boolean;
}
interface Options {
  context: LocalDeliveryContext; getContext?: () => LocalDeliveryContext; client?: LocalDeliveryClient;
  isRenderInput: (value: unknown) => boolean; validateResponse: (input: LocalDeliveryRenderInput, response: unknown) => boolean;
  validateNotApplied?: (input: LocalDeliveryRenderInput, code: string) => boolean;
  onRestore?: (draft: LocalDeliveryDraftValue, capture: LocalDeliveryCapture) => boolean;
  onAccepted?: (result: LocalDeliveryAccepted) => void | Promise<void>; onChange?: (state: LocalDeliveryState) => void;
  delay?: number; createId?: () => string;
}
const copy = <T,>(value: T): T => structuredClone(value);
export const sameLocalDeliveryValue = (left: unknown, right: unknown): boolean => JSON.stringify(left, (_, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value) === JSON.stringify(right, (_, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const message = (error: unknown) => error instanceof Error ? error.message : '本地交付状态尚未确认，当前名称与原请求仍保留。';
const authority = (envelope: LocalDeliverySupported) => ({ workspaceScope: envelope.workspaceScope, instanceId: envelope.instanceId, projectId: envelope.projectId });
const pendingIntent = (intent: LocalDeliveryIntent | null) => intent?.outcome.status === 'pending';
const revealsTerminalOutcome = (previous: LocalDeliveryIntent | null, next: LocalDeliveryIntent | null) => Boolean(previous && next && pendingIntent(previous) && !pendingIntent(next) && sameLocalDeliveryValue({ ...previous, outcome: null }, { ...next, outcome: null }));

/** Names are unsent form drafts. Intents are separately reserved business
 * requests. Read, mount, tab changes and reconnect never execute an intent. */
export function createLocalDeliveryController({ context: initial, getContext, client, isRenderInput, validateResponse, validateNotApplied = () => false, onRestore, onAccepted, onChange = () => {}, delay = 250, createId = () => crypto.randomUUID() }: Options) {
  const transport = client ?? createLocalDeliveryClient({ isRenderInput }), schemas = createLocalDeliverySchemas(isRenderInput);
  let context = copy(initial), generation = 1, serial = 0, readSerial = 0, active = true, loaded = false;
  let envelope: LocalDeliverySupported | null = null, timer: ReturnType<typeof setTimeout> | undefined, saving: Promise<boolean> | null = null;
  let operation: object | null = null, draftRetryFlight: object | null = null, restoring = false, suppressNextNameChange = false;
  const uncertain = new Map<string, LocalDeliveryPrepare>();
  // Only an unresolved title PUT is retained, with its original CAS and owner.
  const uncertainDraftWrites = new Map<string, LocalDeliveryDraftPut>();
  const captures = new WeakSet<LocalDeliveryCapture>();
  const initialState = (): LocalDeliveryState => ({ scope: context.scope, projectId: context.projectId, phase: context.restored ? 'unsupported' : 'loading',
    deliveryName: context.deliveryName, dirty: context.dirty, baseline: context.dirty && context.timelineId && context.timelineRevision ? { timelineId: context.timelineId, baseRevision: context.timelineRevision } : null,
    baselineConflict: false, candidate: null, savedAt: null, draftFailure: null, draftError: '', autosavePaused: Boolean(context.projectId && uncertainDraftWrites.has(context.projectId)), leaveWithoutSaving: false,
    draftRetry: context.projectId && uncertainDraftWrites.has(context.projectId) ? 'same' : null, retainedDraftWrite: context.projectId ? copy(uncertainDraftWrites.get(context.projectId) ?? null) : null,
    retainedPreparation: context.projectId ? copy(uncertain.get(context.projectId) ?? null) : null, intent: null, intentPhase: 'idle', intentUncertain: Boolean(context.projectId && uncertain.has(context.projectId)), intentFailure: null, intentError: '', busy: false, pending: Boolean(context.projectId && uncertain.has(context.projectId)) });
  let state = initialState();
  function emit(patch: Partial<LocalDeliveryState>) {
    state = { ...state, ...patch, retainedDraftWrite: context.projectId ? copy(uncertainDraftWrites.get(context.projectId) ?? null) : null, retainedPreparation: context.projectId ? copy(uncertain.get(context.projectId) ?? null) : null }; state.pending = state.intentUncertain || pendingIntent(state.intent) || state.intentPhase === 'preparing' || state.intentPhase === 'executing';
    state.baselineConflict = Boolean(state.baseline && (state.baseline.timelineId !== context.timelineId || state.baseline.baseRevision !== context.timelineRevision));
    if (active) onChange(state);
  }
  const belongs = (owner: number) => active && generation === owner;
  const sync = () => { if (getContext) controller.setContext(getContext()); };
  function draftFailure(error: unknown, retry: 'same' | 'current' | null = context.projectId && uncertainDraftWrites.has(context.projectId) ? 'same' : state.draftFailure ? state.draftRetry : 'current') {
    const observed = localDeliveryFailure(error);
    emit({ phase: 'error', autosavePaused: true, draftRetry: retry, draftFailure: state.draftFailure?.kind === 'unknown' ? state.draftFailure : observed, draftError: message(error) });
  }
  function intentFailure(error: unknown, unknown = false) {
    emit({ intentPhase: 'error', intentFailure: localDeliveryFailure(error), intentError: message(error), intentUncertain: unknown });
  }
  function validateEnvelope(value: LocalDeliveryEnvelope, projectId: string): LocalDeliverySupported {
    const parsed = schemas.envelope.safeParse(value);
    if (!parsed.success || !parsed.data.supported || parsed.data.projectId !== projectId) throw localDeliveryProtocolError();
    if (parsed.data.intent?.outcome.status === 'not_applied' && !validateNotApplied(parsed.data.intent.input, parsed.data.intent.outcome.code)) throw localDeliveryProtocolError();
    return parsed.data;
  }
  function receive(next: LocalDeliverySupported, previous: LocalDeliverySupported | null, field?: 'draft' | 'intent') {
    if (previous && (next.workspaceScope !== previous.workspaceScope || next.instanceId !== previous.instanceId ||
        next.draftRevision < previous.draftRevision || next.intentRevision < previous.intentRevision ||
        field === 'draft' && next.draftRevision !== previous.draftRevision + 1 || field === 'intent' && next.intentRevision <= previous.intentRevision)) throw localDeliveryProtocolError();
    if (envelope && (next.draftRevision < envelope.draftRevision || next.intentRevision < envelope.intentRevision ||
        next.draftRevision === envelope.draftRevision && !sameLocalDeliveryValue(next.draft, envelope.draft) ||
        next.intentRevision === envelope.intentRevision && !sameLocalDeliveryValue(next.intent, envelope.intent) && !revealsTerminalOutcome(envelope.intent, next.intent))) throw localDeliveryProtocolError();
    const retained = uncertain.get(next.projectId);
    if (retained && retained.workspaceScope !== next.workspaceScope || uncertainDraftWrites.has(next.projectId) && uncertainDraftWrites.get(next.projectId)!.workspaceScope !== next.workspaceScope) throw localDeliveryProtocolError();
    envelope = copy(next); loaded = true;
    // Only the exact retained request, observed terminal, can settle an unknown
    // preparation. An empty GET or a different intent cannot erase that fence.
    if (retained && next.intent?.intentId === retained.intentId && sameLocalDeliveryValue(next.intent.input, retained.input) && !pendingIntent(next.intent)) uncertain.delete(next.projectId);
    emit({ intent: copy(next.intent), intentUncertain: uncertain.has(next.projectId), intentPhase: next.intent?.outcome.status ?? 'idle' });
  }
  const draftMatches = (draft: LocalDeliveryDraftValue | null, raw = state.deliveryName, baseline = state.baseline) => Boolean(draft && baseline && draft.timelineId === baseline.timelineId && draft.baseRevision === baseline.baseRevision && draft.raw.deliveryName === raw);
  const preparationUnconfirmed = () => {
    const retained = context.projectId ? uncertain.get(context.projectId) : null;
    return Boolean(retained && (!envelope?.intent || envelope.intent.intentId !== retained.intentId || !sameLocalDeliveryValue(envelope.intent.input, retained.input)));
  };
  const readyToSave = () => active && loaded && envelope && context.connected && !context.restored && context.projectId && state.dirty && !state.candidate && !state.autosavePaused && !operation && !preparationUnconfirmed();
  function schedule() { if (timer) clearTimeout(timer); timer = undefined; if (readyToSave() && !saving) timer = setTimeout(() => { timer = undefined; void flush(); }, delay); }
  function capture(): LocalDeliveryCapture {
    sync(); const token = Object.freeze({ scope: context.scope, projectId: context.projectId, timelineId: context.timelineId, baseRevision: context.timelineRevision, deliveryName: context.deliveryName, nameVersion: context.nameVersion, serial, generation, executionEpoch: context.executionEpoch });
    captures.add(token); return token;
  }
  function isCurrent(token: LocalDeliveryCapture): boolean {
    sync(); return captures.has(token) && belongs(token.generation) && token.serial === serial && token.scope === context.scope && token.projectId === context.projectId && token.nameVersion === context.nameVersion && token.deliveryName === context.deliveryName && token.executionEpoch === context.executionEpoch;
  }
  async function load(): Promise<void> {
    sync(); if (!active || !context.projectId || context.restored || saving || operation) return;
    const owner = generation, reading = ++readSerial, projectId = context.projectId, previous = envelope;
    emit({ phase: 'loading' });
    try {
      const result = await transport.get(projectId); sync();
      if (!belongs(owner) || reading !== readSerial) return;
      if (!result.supported) { loaded = false; emit({ phase: 'unsupported' }); return; }
      const next = validateEnvelope(result, projectId);
      if (previous && next.workspaceScope !== previous.workspaceScope) throw new Error('工作区身份已变化；当前输入与原请求仍保留，请重新打开原工作区核对。');
      // A read may adopt a restarted server nonce; it never executes anything.
      receive(next, previous ? { ...previous, instanceId: next.instanceId } : null);
      const matches = draftMatches(next.draft);
      emit({ phase: matches ? 'saved' : 'ready', candidate: next.draft && !matches ? copy(next.draft) : null, savedAt: next.draft?.updatedAt ?? null });
      // Reads do not release paused writes or launch a saved request.
      if (!state.autosavePaused) schedule();
    } catch (error) { if (belongs(owner) && reading === readSerial) { loaded = false; draftFailure(error); } }
  }
  async function flush(force = false, explicitRetry = false): Promise<boolean> {
    sync(); if (timer) clearTimeout(timer); timer = undefined;
    if (saving) { const owner = generation; await saving; sync(); if (!belongs(owner)) return false; }
    if (!loaded || !envelope || !context.projectId || context.restored || !context.connected || state.candidate || state.autosavePaused || operation || preparationUnconfirmed()) return false;
    if (!state.dirty && !force) return true;
    const baseline = state.baseline ?? (context.timelineId && context.timelineRevision ? { timelineId: context.timelineId, baseRevision: context.timelineRevision } : null);
    if (!baseline) return false;
    if (draftMatches(envelope.draft, state.deliveryName, baseline)) { emit({ phase: 'saved', baseline, savedAt: envelope.draft!.updatedAt }); return true; }
    const owner = generation, savedSerial = serial, previous = copy(envelope), raw = { deliveryName: state.deliveryName };
    const input = { ...authority(previous), expectedDraftRevision: previous.draftRevision, draftId: previous.draft?.draftId ?? createId(), ...baseline, raw };
    if (!localDeliveryDraftPutSchema.safeParse(input).success) { draftFailure(new LocalDeliveryRequestError('名称超过本地草稿的 512 字符上限或包含无效 Unicode；未发送保存请求，原输入保留，不会截断。', 'LOCAL_DELIVERY_LOCAL_VALIDATION', 400), 'current'); return false; }
    if (!uncertainDraftWrites.has(previous.projectId) && uncertainDraftWrites.size >= LOCAL_DELIVERY_LIMITS.slots) {
      draftFailure(new LocalDeliveryRequestError('当前会话已有 128 个项目的名称保存待确认；请先恢复原名称。未发送本次新保存请求。', 'LOCAL_DELIVERY_LOCAL_RETRY_LIMIT', 400), 'current'); return false;
    }
    uncertainDraftWrites.set(previous.projectId, copy(input));
    readSerial++; emit({ phase: 'saving', baseline, draftError: '' });
    const work = (async () => {
      try {
        const result = await transport.put(input); sync(); if (!belongs(owner)) return false;
        const next = validateEnvelope(result, previous.projectId);
        if (!next.draft || next.draft.draftId !== input.draftId || !draftMatches(next.draft, raw.deliveryName, baseline)) throw localDeliveryProtocolError();
        receive(next, previous, 'draft'); uncertainDraftWrites.delete(previous.projectId);
        emit({ phase: serial === savedSerial ? 'saved' : 'ready', savedAt: next.draft.updatedAt,
          ...(explicitRetry && serial !== savedSerial ? { autosavePaused: true, draftRetry: 'current' as const, draftError: '本次名称已确认保存。较新的输入仍保留，请明确保存当前名称。' } : {}) }); return serial === savedSerial;
      } catch (error) {
        sync(); const refused = localDeliveryFailure(error).kind === 'refused';
        if (refused && belongs(owner)) uncertainDraftWrites.delete(previous.projectId);
        if (belongs(owner)) draftFailure(error, refused ? 'current' : 'same'); return false;
      }
    })();
    saving = work; try { return await work; } finally { if (saving === work) saving = null; if (belongs(owner) && serial !== savedSerial && !explicitRetry) schedule(); }
  }
  function canPrepare(): boolean {
    sync(); return Boolean(active && loaded && envelope && context.projectId && context.timelineId && context.timelineRevision && context.connected && context.visible && !context.busy && !context.restored && !operation && !saving && !draftRetryFlight && !state.candidate && !state.autosavePaused && !state.baselineConflict && !state.pending);
  }
  async function executeOriginal(next: LocalDeliverySupported, token: LocalDeliveryCapture, recovered: boolean, nameCapture: unknown): Promise<unknown | null> {
    const intent = next.intent; if (!intent) throw localDeliveryProtocolError();
    const owner = generation;
    emit({ intentPhase: 'executing' });
    const input = { ...authority(next), intentId: intent.intentId, expectedIntentRevision: next.intentRevision };
    const result = await (recovered ? transport.recover(input) : transport.execute(input)); sync();
    if (!belongs(owner)) return null;
    const settled = validateEnvelope(result.envelope, next.projectId);
    if (!settled.intent || settled.intent.intentId !== intent.intentId || !sameLocalDeliveryValue(settled.intent.input, intent.input) || settled.intent.timelineId !== intent.timelineId || settled.intent.baseRevision !== intent.baseRevision) throw localDeliveryProtocolError();
    if (settled.intent.outcome.status === 'accepted') {
      if (!validateResponse(intent.input, result.response) || !object(result.response) || result.response.id !== settled.intent.outcome.exportId || !object(result.response.snapshot) || !object(result.response.snapshot.timeline) || result.response.snapshot.timeline.id !== intent.timelineId) throw localDeliveryProtocolError();
    } else if (result.response !== null) throw localDeliveryProtocolError();
    receive(settled, next); // Execution may keep a pending revision unchanged.
    if (settled.intent.outcome.status === 'accepted') {
      if (!recovered && isCurrent(token)) emit({ dirty: false, baseline: null, savedAt: settled.draft?.updatedAt ?? null, phase: settled.draft ? 'saved' : 'ready' });
      emit({ intentFailure: null, intentError: '' });
      await onAccepted?.({ response: result.response, intent: copy(settled.intent), capture: token, nameCapture, recovered });
      return result.response;
    }
    emit({ intentError: settled.intent.outcome.status === 'not_applied' ? `服务器已确认原请求未应用（${settled.intent.outcome.code}）。名称仍保留，请核对后重新检查。` : '原请求结果仍待确认；不会自动重试。' });
    return null;
  }
  const controller = {
    getState: () => state, capture, isCurrent, load, flush, canPrepare,
    hasUnsaved: () => { sync(); return ((state.dirty || state.retainedDraftWrite !== null) && !state.leaveWithoutSaving && (state.retainedDraftWrite !== null || !draftMatches(envelope?.draft ?? null))) || draftRetryFlight !== null || state.phase === 'saving' || state.intentPhase === 'preparing' || state.intentPhase === 'executing'; },
    setContext(next: LocalDeliveryContext) {
      if (!active || sameLocalDeliveryValue(context, next)) return;
      const ownerChanged = next.scope !== context.scope || next.projectId !== context.projectId;
      if (ownerChanged) {
        if (timer) clearTimeout(timer); timer = undefined; generation++; serial++; readSerial++; context = copy(next); envelope = null; loaded = false; saving = null; operation = null; draftRetryFlight = null; suppressNextNameChange = false;
        state = initialState(); emit({}); return;
      }
      const changed = next.nameVersion !== context.nameVersion || next.deliveryName !== context.deliveryName;
      const acknowledged = context.dirty && !next.dirty;
      context = copy(next);
      if (changed) {
        serial++;
        if (suppressNextNameChange) { suppressNextNameChange = false; emit({ deliveryName: next.deliveryName, dirty: false, baseline: null }); }
        // Name-controller initialization and reset also advance its version.
        // Only an actual dirty edit or explicit restore creates unsent input.
        else if (next.dirty || restoring) emit({ deliveryName: next.deliveryName, dirty: true, leaveWithoutSaving: false, baseline: restoring ? state.baseline : state.baseline ?? (next.timelineId && next.timelineRevision ? { timelineId: next.timelineId, baseRevision: next.timelineRevision } : null) });
        else emit({ deliveryName: next.deliveryName, dirty: false, baseline: null });
      } else if (acknowledged && !restoring) emit({ dirty: false, baseline: null });
      else emit({});
      if (!restoring) schedule();
    },
    restore(token = capture()): boolean {
      if (!isCurrent(token) || !state.candidate || !context.visible || operation || !onRestore) return false;
      const candidate = copy(state.candidate), before = state.baseline;
      restoring = true; emit({ baseline: { timelineId: candidate.timelineId, baseRevision: candidate.baseRevision } });
      let accepted = false;
      try { accepted = onRestore(candidate, token); sync(); } finally { restoring = false; }
      if (!accepted || !belongs(token.generation)) { if (belongs(token.generation)) emit({ baseline: before }); return false; }
      serial++; emit({ deliveryName: candidate.raw.deliveryName, dirty: true, candidate: null, baseline: { timelineId: candidate.timelineId, baseRevision: candidate.baseRevision }, phase: 'saved', savedAt: candidate.updatedAt }); return true;
    },
    async retryDraftSave(token = capture()): Promise<boolean> {
      if (!isCurrent(token) || !context.visible || !context.connected || context.restored || operation || saving || draftRetryFlight || !state.autosavePaused || !state.draftRetry || preparationUnconfirmed()) return false;
      const owner = generation, mode = state.draftRetry, beforeRead = envelope ? copy(envelope) : null, previousCandidate = state.candidate, retryLock = {};
      draftRetryFlight = retryLock; emit({ busy: true });
      try {
      // This explicit action first verifies ownership and obtains the current
      // server nonce. A read alone never discards an unresolved PUT or its CAS.
      await load();
      if (!isCurrent(token) || !loaded || !envelope || !context.visible || !context.connected || operation || saving || preparationUnconfirmed()) return false;
      const previous = copy(envelope), retained = uncertainDraftWrites.get(previous.projectId);
      if (mode === 'current' && !retained) {
        // A known refusal sent no successful write. The user explicitly chose
        // to save today's raw input, but never to replace another candidate or
        // adopt a different baseline silently.
        emit({ autosavePaused: false, draftFailure: null, draftRetry: null, leaveWithoutSaving: false, draftError: '' });
        if (state.candidate && previousCandidate === null && beforeRead && beforeRead.workspaceScope === previous.workspaceScope && beforeRead.draftRevision === previous.draftRevision && sameLocalDeliveryValue(beforeRead.draft, previous.draft)) emit({ candidate: null });
        if (state.candidate) { emit({ draftError: '已重新核对记录；请选择恢复已保存名称或明确保留当前名称。' }); return false; }
        return await flush(true, true);
      }
      if (!retained || previous.workspaceScope !== retained.workspaceScope) { draftFailure(localDeliveryProtocolError(), 'same'); return false; }
      const original = { ...copy(retained), instanceId: previous.instanceId }, savedSerial = serial;
      const baseline = { timelineId: retained.timelineId, baseRevision: retained.baseRevision };
      readSerial++; emit({ phase: 'saving', busy: true, draftError: '' });
      const work = (async () => {
        try {
          const result = await transport.put(original); sync(); if (!belongs(owner)) return false;
          const next = validateEnvelope(result, original.projectId);
          if (next.workspaceScope !== original.workspaceScope || next.instanceId !== original.instanceId || next.draftRevision !== original.expectedDraftRevision + 1 || !next.draft || next.draft.draftId !== original.draftId || !draftMatches(next.draft, original.raw.deliveryName, baseline)) throw localDeliveryProtocolError();
          // Idempotent retry can confirm a row already observed by the GET.
          receive(next, previous); uncertainDraftWrites.delete(original.projectId);
          const current = savedSerial === serial && draftMatches(next.draft);
          emit({ phase: current ? 'saved' : 'ready', candidate: null, savedAt: next.draft.updatedAt, autosavePaused: !current,
            draftFailure: null, draftRetry: current ? null : 'current', leaveWithoutSaving: false,
            draftError: current ? '' : '原名称已确认保存。较新的当前输入仍未保存；请明确保存当前名称，不会自动覆盖。' });
          return current;
        } catch (error) {
          // A later refusal cannot disprove the earlier uncertain write.
          if (belongs(owner)) draftFailure(error, 'same'); return false;
        }
      })();
      saving = work;
      try { return await work; }
      finally { if (saving === work) saving = null; }
      } finally { if (draftRetryFlight === retryLock) draftRetryFlight = null; if (belongs(owner)) emit({ busy: false }); }
    },
    async keepCurrent(token = capture()): Promise<boolean> {
      if (!isCurrent(token) || !loaded || !envelope || !context.visible || !context.connected || operation || saving || state.autosavePaused || preparationUnconfirmed() || !context.timelineId || !context.timelineRevision) return false;
      const baseline = { timelineId: context.timelineId, baseRevision: context.timelineRevision };
      // A draft identity's original baseline is immutable. Explicit replacement
      // first deletes its exact CAS row, then allocates a new identity. A failed
      // or late delete cannot authorize rebasing or overwriting newer input.
      if (envelope.draft && (envelope.draft.timelineId !== baseline.timelineId || envelope.draft.baseRevision !== baseline.baseRevision)) {
        if (!await controller.discardStored(token) || !isCurrent(token) || context.timelineId !== baseline.timelineId || context.timelineRevision !== baseline.baseRevision) return false;
      }
      serial++; emit({ candidate: null, baseline, dirty: true, phase: 'ready' });
      return flush(true);
    },
    async discardStored(token = capture()): Promise<boolean> {
      if (!isCurrent(token) || !loaded || !envelope?.draft || !context.visible || !context.connected || operation || saving || state.autosavePaused || preparationUnconfirmed()) return false;
      const previous = copy(envelope), owner = generation, lock = {}; operation = lock; readSerial++; emit({ busy: true });
      try {
        const result = await transport.discard({ ...authority(previous), expectedDraftRevision: previous.draftRevision, draftId: previous.draft!.draftId }); sync();
        if (!belongs(owner)) return false;
        const next = validateEnvelope(result, previous.projectId); if (next.draft !== null) throw localDeliveryProtocolError();
        receive(next, previous, 'draft'); emit({ candidate: null, savedAt: null, phase: 'ready' }); return true;
      } catch (error) { if (belongs(owner)) draftFailure(error, null); return false; }
      finally { if (operation === lock) operation = null; if (belongs(owner)) { emit({ busy: false }); schedule(); } }
    },
    allowLeaveWithoutSaving(token = capture()): boolean {
      if (!isCurrent(token) || operation || saving || !state.draftFailure || state.draftFailure.kind !== 'refused') return false;
      if (timer) clearTimeout(timer); timer = undefined;
      emit({ leaveWithoutSaving: true, autosavePaused: true, draftError: '已选择保留当前输入但不保存到本地；离开或关闭后，这些输入可能丢失。原导出请求不会因此取消。' }); return true;
    },
    abandonCurrentInput(token = capture()): boolean {
      if (!isCurrent(token) || operation || saving) return false;
      if (timer) clearTimeout(timer); timer = undefined;
      serial++; suppressNextNameChange = true; emit({ dirty: false, autosavePaused: true, leaveWithoutSaving: true }); return true;
    },
    async submit(input: LocalDeliveryRenderInput, options: { canExecute?: () => boolean; nameCapture?: unknown } = {}): Promise<unknown | null> {
      if (!canPrepare() || !context.projectId || !context.timelineId || !context.timelineRevision || !isRenderInput(input) || input.projectId !== context.projectId || input.expectedRevision !== context.timelineRevision || input.purpose !== 'export' ||
          (context.deliveryName === '' ? Object.hasOwn(input, 'deliveryName') : input.deliveryName !== context.deliveryName)) return null;
      const token = capture(), owner = generation;
      if (!await flush(context.deliveryName !== '' || state.dirty) || !isCurrent(token) || !canPrepare() || !envelope) return null;
      const previous = copy(envelope), intentId = createId(), exact = copy(input);
      const draft = draftMatches(previous.draft) ? { draftId: previous.draft!.draftId, revision: previous.draftRevision, raw: copy(previous.draft!.raw) } : null;
      const preparedInput: LocalDeliveryPrepare = { ...authority(previous), expectedIntentRevision: previous.intentRevision, expectedIntentId: previous.intent?.intentId ?? null, intentId,
        timelineId: context.timelineId!, baseRevision: context.timelineRevision!, draft, input: exact };
      if (!schemas.prepare.safeParse(preparedInput).success) { intentFailure(localDeliveryProtocolError()); return null; }
      const lock = {}; operation = lock; readSerial++; uncertain.set(previous.projectId, copy(preparedInput)); emit({ busy: true, intentPhase: 'preparing', intentUncertain: true, intentError: '', intentFailure: null });
      try {
        let result: LocalDeliveryEnvelope;
        try { result = await transport.prepare(preparedInput); }
        catch (error) {
          sync(); if (belongs(owner) && localDeliveryFailure(error).kind === 'refused') uncertain.delete(previous.projectId);
          if (belongs(owner)) intentFailure(error, uncertain.has(previous.projectId)); return null;
        }
        sync(); if (!belongs(owner)) return null;
        const next = validateEnvelope(result, previous.projectId);
        if (!next.intent || next.intent.intentId !== intentId || !sameLocalDeliveryValue(next.intent.input, exact) || next.intent.timelineId !== preparedInput.timelineId || next.intent.baseRevision !== preparedInput.baseRevision || !sameLocalDeliveryValue(next.intent.draft, preparedInput.draft)) throw localDeliveryProtocolError();
        receive(next, previous, 'intent'); uncertain.delete(previous.projectId); emit({ intentUncertain: false });
        if (!isCurrent(token) || !context.visible || !context.connected || context.busy || context.timelineId !== token.timelineId || context.timelineRevision !== token.baseRevision || options.canExecute?.() === false) return null;
        return await executeOriginal(next, token, false, options.nameCapture ?? null);
      } catch (error) { sync(); if (belongs(owner)) intentFailure(error, uncertain.has(previous.projectId)); return null; }
      finally { if (operation === lock) operation = null; if (belongs(owner)) { emit({ busy: false }); schedule(); } }
    },
    async recover(token = capture()): Promise<unknown | null> {
      if (!isCurrent(token) || !context.visible || !context.connected || context.restored || context.busy || !loaded || !envelope || operation || saving || draftRetryFlight) return null;
      let previous = copy(envelope);
      const retained = uncertain.get(previous.projectId);
      if (!previous.intent && !retained) return null;
      if (retained && previous.workspaceScope !== retained.workspaceScope) { intentFailure(localDeliveryProtocolError(), true); return null; }
      const owner = generation, lock = {}; operation = lock; readSerial++; emit({ busy: true, intentError: '' });
      try {
        if (retained && previous.intent?.intentId !== retained.intentId) {
          if (previous.workspaceScope !== retained.workspaceScope || previous.intentRevision !== retained.expectedIntentRevision || (previous.intent?.intentId ?? null) !== retained.expectedIntentId) throw localDeliveryProtocolError();
          // Explicit recovery may finish an unacknowledged preparation. Keep
          // every original business/CAS field; only a verified same-workspace
          // GET may supply a restarted server's current nonce.
          const originalPrepare = { ...copy(retained), instanceId: previous.instanceId };
          const result = await transport.prepare(originalPrepare); sync();
          if (!belongs(owner)) return null;
          const next = validateEnvelope(result, previous.projectId);
          if (!next.intent || next.intent.intentId !== retained.intentId || !sameLocalDeliveryValue(next.intent.input, retained.input) || !sameLocalDeliveryValue(next.intent.draft, retained.draft) || next.intent.timelineId !== retained.timelineId || next.intent.baseRevision !== retained.baseRevision) throw localDeliveryProtocolError();
          receive(next, previous, 'intent'); previous = copy(next);
        }
        if (!previous.intent || retained && (previous.intent.intentId !== retained.intentId || !sameLocalDeliveryValue(previous.intent.input, retained.input))) throw localDeliveryProtocolError();
        if (!isCurrent(token) || !context.visible || !context.connected || context.busy || context.timelineId !== token.timelineId || context.timelineRevision !== token.baseRevision) return null;
        return await executeOriginal(previous, token, true, null);
      } catch (error) { sync(); if (belongs(owner)) intentFailure(error, state.intentUncertain); return null; }
      finally { if (operation === lock) operation = null; if (belongs(owner)) { emit({ busy: false }); schedule(); } }
    },
    activate() { active = true; },
    dispose() { active = false; generation++; readSerial++; if (timer) clearTimeout(timer); timer = undefined; saving = null; operation = null; draftRetryFlight = null; loaded = false; },
  };
  return controller;
}
export type LocalDeliveryController = ReturnType<typeof createLocalDeliveryController>;

export function useLocalDelivery(options: Omit<Options, 'onChange'>) {
  const callbacks = useRef(options); callbacks.current = options;
  const [state, setState] = useState<LocalDeliveryState | null>(null);
  const ref = useRef<LocalDeliveryController | null>(null);
  if (!ref.current) ref.current = createLocalDeliveryController({ ...options, getContext: () => callbacks.current.getContext?.() ?? callbacks.current.context,
    onRestore: (draft, capture) => callbacks.current.onRestore?.(draft, capture) ?? false,
    onAccepted: result => callbacks.current.onAccepted?.(result), onChange: setState });
  const controller = ref.current, contextKey = JSON.stringify(options.context);
  useLayoutEffect(() => { controller.setContext(options.context); }, [controller, contextKey]);
  useLayoutEffect(() => { controller.activate(); return () => controller.dispose(); }, [controller]);
  useLayoutEffect(() => { void controller.load(); }, [controller, options.context.scope, options.context.projectId]);
  return { state: state?.scope === options.context.scope && state.projectId === options.context.projectId ? state : controller.getState(), controller };
}
