import { projectRulesSaveInputSchema, projectRulesEnableInputSchema, rulesTextProblem } from '../../../packages/contracts/src/mio-rules.ts';
import type { ProjectRulesSnapshot, ProjectRulesSaveInput, ProjectRulesEnableInput, ProjectRulesRequestLookup } from '../../../packages/contracts/src/mio-rules.ts';
import { createWebProjectRulesClient, ProjectRulesRequestError } from './project-rules-client.ts';
import type { WebProjectRulesClient } from './project-rules-client.ts';

export type PendingRulesWrite = {readonly action: 'save'; readonly input: ProjectRulesSaveInput} | {readonly action: 'enable'; readonly input: ProjectRulesEnableInput};
export interface ProjectRulesStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export interface ProjectRulesState {
  readonly phase: 'loading' | 'ready' | 'error'; readonly snapshot: ProjectRulesSnapshot | null; readonly draft: string;
  readonly mutation: 'idle' | 'working' | 'unknown' | 'conflict' | 'error'; readonly action: 'save' | 'enable' | 'lookup' | 'reconcile' | null;
  readonly pending: PendingRulesWrite | null; readonly lookup: ProjectRulesRequestLookup | null; readonly error: string; readonly receiptBlocked: boolean;
}
export const projectRulesReceiptKey = (projectId: string): string => `mioon.project-rules.pending.v1:${projectId}`;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function pendingValue(value: string, projectId: string): PendingRulesWrite {
  const parsed: unknown = JSON.parse(value);
  if (!object(parsed) || Object.keys(parsed).length !== 3 || parsed.projectId !== projectId) throw new Error('Invalid local rules receipt');
  if (parsed.action === 'save') return {action: 'save', input: projectRulesSaveInputSchema.parse(parsed.input)};
  if (parsed.action === 'enable') return {action: 'enable', input: projectRulesEnableInputSchema.parse(parsed.input)};
  throw new Error('Invalid local rules receipt');
}
/** A single mounted project owns the read epoch. The durable local identity is
 * saved before dispatch and survives closing; reads never perform recovery. */
export function createProjectRulesState({projectId, client = createWebProjectRulesClient(), storage = () => localStorage, newRequestId = () => crypto.randomUUID()}: {
  readonly projectId: string; readonly client?: WebProjectRulesClient; readonly storage?: () => ProjectRulesStorage; readonly newRequestId?: () => string;
}) {
  let active = true, epoch = 0, busy = false, storageBlocked = false;
  const listeners = new Set<() => void>(), key = projectRulesReceiptKey(projectId); let controller = new AbortController();
  let pending: PendingRulesWrite | null = null;
  try { const raw = storage().getItem(key); if (raw !== null) pending = pendingValue(raw, projectId); } catch { storageBlocked = true; }
  let state: ProjectRulesState = {phase: 'loading', snapshot: null, draft: pending?.action === 'save' ? pending.input.text : '', mutation: pending ? 'unknown' : storageBlocked ? 'error' : 'idle', action: null, pending, lookup: null, error: storageBlocked ? 'LOCAL_RECEIPT_UNAVAILABLE' : '', receiptBlocked: storageBlocked};
  const publish = (patch: Partial<ProjectRulesState>): void => { if (active) { state = {...state, ...patch}; for (const listener of listeners) listener(); } };
  function clear(original: PendingRulesWrite): void {
    const raw = storage().getItem(key);
    if (raw !== null) { const saved = pendingValue(raw, projectId); if (saved.input.requestId !== original.input.requestId) throw new Error('Rules receipt owner changed'); storage().removeItem(key); }
  }
  async function load(replaceDraft = false): Promise<void> {
    if (!active || busy) return;
    const owner = ++epoch; publish({phase: 'loading'});
    try {
      const snapshot = await client.read(projectId, {signal: controller.signal});
      if (!active || owner !== epoch) return;
      const draft = state.pending?.action === 'save' ? state.pending.input.text : replaceDraft || state.snapshot === null ? snapshot.text ?? '' : state.draft;
      publish({phase: 'ready', snapshot, draft, ...(replaceDraft && !state.pending && !storageBlocked ? {mutation: 'idle', error: '', lookup: null} : {})});
    } catch (error) { if (active && owner === epoch) publish({phase: 'error', error: error instanceof ProjectRulesRequestError ? error.code : 'BACKEND_UNAVAILABLE'}); }
  }
  const writable = (): boolean => active && !busy && !storageBlocked && !state.pending && state.phase === 'ready' && state.snapshot !== null && state.snapshot.readError === null && !state.snapshot.pendingWrites && !['unavailable', 'pending'].includes(state.snapshot.trust) && state.mutation !== 'conflict';
  async function write(action: 'save' | 'enable'): Promise<boolean> {
    if (!writable() || rulesTextProblem(state.draft) !== null) return false;
    const snapshot = state.snapshot!;
    if (action === 'enable' && state.draft !== (snapshot.text ?? '')) action = 'save';
    if (action === 'enable' && (snapshot.hash === null || snapshot.trust !== 'untrusted')) return false;
    const original: PendingRulesWrite = action === 'save'
      ? {action, input: {requestId: newRequestId(), expectedHash: snapshot.hash, text: state.draft}}
      : {action, input: {requestId: newRequestId(), expectedHash: snapshot.hash!}};
    try {
      const prior = storage().getItem(key);
      if (prior !== null) { const existing = pendingValue(prior, projectId); publish({pending: existing, mutation: 'unknown', action: null, error: '', ...(existing.action === 'save' ? {draft: existing.input.text} : {})}); return false; }
      storage().setItem(key, JSON.stringify({projectId, ...original}));
    } catch { storageBlocked = true; publish({mutation: 'error', error: 'LOCAL_RECEIPT_UNAVAILABLE', receiptBlocked: true}); return false; }
    ++epoch; busy = true; publish({mutation: 'working', action, pending: original, lookup: null, error: ''});
    try {
      const next = original.action === 'save' ? await client.save(projectId, original.input, {signal: controller.signal}) : await client.enable(projectId, original.input, {signal: controller.signal});
      clear(original); publish({snapshot: next, draft: next.text ?? '', pending: null, mutation: 'idle', action: null}); return true;
    } catch (error) {
      const code = error instanceof ProjectRulesRequestError ? error.code : 'BACKEND_UNAVAILABLE';
      if (error instanceof ProjectRulesRequestError && !error.outcomeUnknown) {
        try { clear(original); publish({pending: null, mutation: code === 'MIO_RULES_CONFLICT' ? 'conflict' : 'error', action, error: code}); }
        catch { storageBlocked = true; publish({mutation: 'unknown', action, error: 'LOCAL_RECEIPT_UNAVAILABLE', receiptBlocked: true}); }
      } else publish({mutation: 'unknown', action, error: code});
      return false;
    } finally { busy = false; }
  }
  async function observe(reconcile: boolean): Promise<void> {
    const original = state.pending;
    if (!active || busy || !original || storageBlocked) return;
    ++epoch; busy = true; publish({mutation: 'working', action: reconcile ? 'reconcile' : 'lookup', error: ''});
    try {
      const lookup = await client[reconcile ? 'reconcile' : 'lookup'](projectId, original.input.requestId, {signal: controller.signal});
      if (!active) return;
      if (lookup.status === 'uncertain') publish({lookup, mutation: 'unknown', action: null});
      else {
        try {clear(original);} catch {storageBlocked = true; publish({mutation: 'unknown', action: null, error: 'LOCAL_RECEIPT_UNAVAILABLE', receiptBlocked: true}); return;}
        publish({pending: null, lookup, mutation: 'idle', action: null, ...(lookup.status === 'applied' ? {snapshot: lookup.result, draft: original.action === 'save' ? original.input.text : state.draft} : {})});
        // Refresh observation only; an applied receipt may describe a file that
        // was externally edited again. A retained draft is never auto-published.
        busy = false; await load();
      }
    } catch (error) { publish({mutation: 'unknown', action: null, error: error instanceof ProjectRulesRequestError ? error.code : 'BACKEND_UNAVAILABLE'}); }
    finally { busy = false; }
  }
  return {
    getSnapshot: () => state,
    connect() { if (!active) { active = true; controller = new AbortController(); ++epoch; } },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load: () => load(), loadLatest: () => load(true),
    setDraft(draft: string) { if (active && !busy && !state.pending) publish({draft}); },
    save: () => write('save'), enable: () => write('enable'), lookup: () => observe(false), reconcile: () => observe(true),
    dispose() { active = false; ++epoch; controller.abort(); listeners.clear(); },
  };
}
