import { preferenceCacheIdentity } from './last-project-navigation.ts';
import { workspaceOriginScope, assertWorkspaceIntent } from './workspace-origin.ts';
import { defaultWorkspaceState, normalizeWorkspaceState, readStoredWorkspaceState, writeWorkspaceState } from './workspace-state.ts';
import type { WorkspaceState, WorkspaceStorage } from './workspace-state.ts';

export type WorkspacePreferencesError=Error&{code: string; transient?: boolean}
export interface WorkspaceServerState {projectId: string; revision: number; state: WorkspaceState|null}
export interface WorkspacePreferencesWorkspace {readonly restored?: unknown; readonly workspaceOrigin?: unknown; readonly [key: string]: unknown}
export interface WorkspacePreferencesStatus {
  readonly phase: string;
  readonly revision: number|null;
  readonly pending: boolean;
  readonly canRetry: boolean;
  readonly error: WorkspacePreferencesErrorInfo|null;
}
export interface WorkspacePreferencesErrorInfo {readonly code: string; readonly message: string}
export interface WorkspacePreferencesOptions {
  fetchImpl?: typeof fetch;
  storage?: WorkspaceStorage;
  getWorkspace?: ()=>WorkspacePreferencesWorkspace;
  getStorageScope?: ()=>string|undefined;
  onState?: (projectId: string,state: WorkspaceState)=>void;
  onStatus?: (projectId: string,status: WorkspacePreferencesStatus)=>void;
  delayMs?: number;
  maxWaitMs?: number;
  retryDelays?: readonly number[];
  requestTimeoutMs?: number;
  now?: ()=>number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}
export interface WorkspacePreferencesUpdateOptions {immediate?: boolean; expectedWorkspaceOrigin?: unknown; workspaceOrigin?: unknown; [key: string]: unknown}
export interface WorkspacePreferencesFlushOptions {projectId?: string; keepalive?: boolean}
export interface WorkspacePreferencesLoadOptions {reload?: boolean}
export interface WorkspacePreferencesEntry {
  projectId: string;
  workspace: WorkspacePreferencesWorkspace;
  key: string;
  cacheId: string|null;
  state: WorkspaceState;
  revision: number|null;
  ready: boolean;
  retired: boolean;
  desired: WorkspaceState|null;
  desiredKey: string|null;
  desiredInvocation?: Readonly<Record<string, unknown>>;
  savedKey: string|null;
  request: WorkspacePreferencesRequest|null;
  inFlight: Promise<WorkspacePreferencesStatus>|null;
  loadPromise: Promise<void>|null;
  timer: ReturnType<typeof setTimeout>|null;
  burstStart: number|null;
  due: boolean;
  force: boolean;
  failures: number;
  blocked: boolean;
  phase: string;
  error: WorkspacePreferencesErrorInfo|null;
}
interface WorkspacePreferencesRequest {expectedRevision: number; state: WorkspaceState; key: string; invocation: Readonly<Record<string, unknown>>}
export interface WorkspacePreferences {
  load(projectId: string, options?: WorkspacePreferencesLoadOptions): Promise<WorkspaceState|null>;
  update(projectId: string, state: unknown, options?: WorkspacePreferencesUpdateOptions): boolean;
  flush(options?: WorkspacePreferencesFlushOptions): Promise<unknown[]>;
  dispose(options?: {flush?: boolean}): Promise<unknown>;
  hasUnsaved(): boolean;
  getStatus(projectId: string): WorkspacePreferencesStatus|null;
  getSnapshot(projectId: string): WorkspaceState|null;
}
interface Envelope {ok?: unknown; data?: unknown; error?: unknown}

const isRecord=(value: unknown): value is Record<string, unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const property=(value: unknown,key: string): unknown=>isRecord(value)?value[key]:undefined;
const errorCode=(error: unknown): string|undefined=>typeof property(error,'code')==='string'?property(error,'code') as string:undefined;
const errorMessage=(error: unknown): string|undefined=>typeof property(error,'message')==='string'?property(error,'message') as string:undefined;
const uuid = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
export function durableWorkspaceState(value: unknown): WorkspaceState {
  const state = normalizeWorkspaceState(value);
  for (const key of ['selectedId', 'selectedEdgeId', 'highlightedVersionId'] as const) {
    const canvas=state.canvas as unknown as Record<string,string|null>;
    if (!uuid.test(canvas[key] || '')) canvas[key] = null;
  }
  for (const key of ['selectedClipId', 'quickAssetId'] as const) {
    const editing=state.editing as unknown as Record<string,string|null>;
    if (!uuid.test(editing[key] || '')) editing[key] = null;
  }
  delete (state.shared as unknown as Record<string, unknown>).assetSearch;
  return state;
}

const keyOf = (state: unknown): string => JSON.stringify(state);
// Compare the complete whitelist independent of JSON property order. A partial
// or malformed successful response must not be normalized into writable defaults.
const sameShape = (expected: unknown,received: unknown): boolean => {
  if (expected === received) return true;
  if (!expected || !received || typeof expected !== 'object' || typeof received !== 'object' || Array.isArray(received)) return false;
  const keys = Object.keys(expected);
  return keys.length === Object.keys(received).length && keys.every(key => Object.hasOwn(received, key) && sameShape((expected as Record<string, unknown>)[key], (received as Record<string, unknown>)[key]));
};
const validRemoteState = (state: unknown,allowLegacy: boolean): boolean => {
  const expected = durableWorkspaceState(state);
  // A legacy v1 GET may omit these entire additive fields. Do not generalize this
  // exception to partial states or PUT acknowledgements of the submitted body.
  if (allowLegacy && isRecord(property(state,'editing')) && !Object.hasOwn(property(state,'editing') as object, 'snappingEnabled')) delete (expected.editing as unknown as Record<string, unknown>).snappingEnabled;
  if (allowLegacy && isRecord(state) && !Object.hasOwn(state, 'layout')) delete (expected as unknown as Record<string, unknown>).layout;
  return sameShape(expected, state);
};
const errorInfo=(error: unknown): WorkspacePreferencesErrorInfo => ({ code: errorCode(error) || 'NETWORK', message: errorMessage(error) || 'Workspace preferences are unavailable.' });
const failure=(message: string,code = 'NETWORK',transient = true): WorkspacePreferencesError => Object.assign(new Error(message), { code, transient });

/**
 * One serial CAS queue per project. load() is the activation boundary; callers must
 * await it before rendering/editing that project's preferences. A stale load returns
 * null and never calls onState. Updates received during loading are intentionally
 * ignored, so a renderer's initial defaults cannot overwrite an existing workspace.
 *
 * load(id, {reload:true}) explicitly discards an unsaved/conflicted local session and
 * reads the server again. Ordinary navigation reuses the project's existing session.
 * flush() waits through the current request and its queued latest state, but resolves
 * after a failed attempt (background retries remain bounded). dispose() suppresses UI
 * callbacks immediately while allowing that same final keepalive chain to finish.
 */
export function createWorkspacePreferences({
  fetchImpl = (...args: Parameters<typeof fetch>): ReturnType<typeof fetch> => globalThis.fetch(...args), storage, getWorkspace = () => ({ restored: false }), getStorageScope = () => undefined,
  onState = () => {}, onStatus = () => {},
  delayMs = 250, maxWaitMs = 1000, retryDelays = [500, 1500, 4000],
  requestTimeoutMs = 8000, now = () => Date.now(),
  setTimeout: schedule = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout,
}: WorkspacePreferencesOptions = {}): WorkspacePreferences {
  const entries = new Map<string,WorkspacePreferencesEntry>();
  let activeId: string|null = null, activation = 0, disposed = false, disposePromise: Promise<unknown[]>|undefined;

  const cacheIdentity = (projectId: string) => preferenceCacheIdentity(workspaceOriginScope(getWorkspace()), projectId, getStorageScope());
  const entryKey = (projectId: string): string => JSON.stringify([cacheIdentity(projectId).entryScope, projectId]);
  function live(entry: WorkspacePreferencesEntry): boolean { return entries.get(entry.key) === entry && !entry.retired && entry.key === entryKey(entry.projectId); }
  function pending(entry: WorkspacePreferencesEntry): boolean { return Boolean(entry.request) || entry.desiredKey !== entry.savedKey; }
  function snapshotStatus(entry: WorkspacePreferencesEntry): WorkspacePreferencesStatus {
    return { phase: entry.phase, revision: entry.revision, pending: entry.ready && pending(entry),
      canRetry: !entry.blocked && entry.revision !== null, error: entry.error ? { ...entry.error } : null };
  }
  function emit(entry: WorkspacePreferencesEntry,phase = entry.phase,error: WorkspacePreferencesErrorInfo|null = entry.error): void {
    entry.phase = phase; entry.error = error;
    if (!disposed && live(entry) && entry.key === entryKey(entry.projectId)) {
      try { onStatus(entry.projectId, snapshotStatus(entry)); } catch { /* UI callbacks cannot break a save. */ }
    }
  }
  function publish(entry: WorkspacePreferencesEntry,token: number): WorkspaceState|null {
    if (!disposed && live(entry) && activeId === entry.key && activation === token) {
      try { onState(entry.projectId, normalizeWorkspaceState(entry.state)); } catch { /* Same isolation as status callbacks. */ }
      return normalizeWorkspaceState(entry.state);
    }
    return null;
  }
  function clearTimer(entry: WorkspacePreferencesEntry): void {
    if (entry.timer !== null) cancel(entry.timer);
    entry.timer = null;
  }
  function cache(entry: WorkspacePreferencesEntry): void {
    // Keep an offline fallback without search text, unknown fields or credentials.
    if (entry.cacheId !== null) writeWorkspaceState(entry.cacheId, durableWorkspaceState(entry.state), storage);
  }
  function plan(entry: WorkspacePreferencesEntry,delay: number,retry = false): void {
    clearTimer(entry);
    if (disposed || !live(entry)) return;
    entry.timer = schedule(() => {
      entry.timer = null; entry.due = true;
      if (!retry) entry.burstStart = null;
      void drain(entry);
    }, Math.max(0, delay));
  }
  async function request(entry: WorkspacePreferencesEntry,method: string,body?: WorkspacePreferencesRequest,invocation: Readonly<Record<string, unknown>> = {}): Promise<WorkspaceServerState> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>|undefined;
    try {
      const transport = (async () => {
        const response = await fetchImpl(`/api/workspace-preferences/${encodeURIComponent(entry.projectId)}`, {
          method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
          ...(method === 'PUT' ? { keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...invocation }) } : {}),
        });
        let envelope: unknown;
        try { envelope = await response.json(); } catch { throw failure('Workspace preferences returned invalid data.'); }
        if (!isRecord(envelope) || envelope.ok !== true) {
          const errorRecord=isRecord(envelope)?envelope.error:undefined;
          const code = (typeof property(errorRecord,'code')==='string'?property(errorRecord,'code') as string:undefined) || (response.status === 401 ? 'UNAUTHORIZED' : 'NETWORK');
          throw failure(typeof property(errorRecord,'message')==='string'?property(errorRecord,'message') as string:'Workspace preferences could not be saved.', code,
            response.status >= 500 || [408, 425, 429].includes(response.status));
        }
        const data = envelope.data;
        const dataRevision=property(data,'revision'), dataState=property(data,'state');
        if (!isRecord(data) || data.projectId !== entry.projectId || typeof dataRevision!=='number' || !Number.isSafeInteger(dataRevision) || dataRevision < 0 ||
          (dataState === null ? dataRevision !== 0 : dataRevision === 0 || property(dataState,'version') !== 1 ||
            !validRemoteState(dataState, method === 'GET'))) {
          throw failure('Workspace preferences returned an invalid revision or state.');
        }
        if (method === 'PUT' && body && (dataRevision !== body.expectedRevision + 1 || keyOf(durableWorkspaceState(dataState)) !== keyOf(body.state))) {
          throw failure('Workspace preferences did not acknowledge the saved state.');
        }
        return {projectId: entry.projectId, revision: dataRevision, state: dataState as WorkspaceState};
      })();
      if (!(requestTimeoutMs > 0)) return await transport;
      return await Promise.race([transport, new Promise<never>((_, reject) => {
        timeout = schedule(() => { controller.abort(); reject(failure('Workspace preferences timed out.')); }, requestTimeoutMs);
      })]);
    } finally { if (timeout !== undefined) cancel(timeout); }
  }

  function drain(entry: WorkspacePreferencesEntry): Promise<WorkspacePreferencesStatus> {
    if (entry.inFlight) return entry.inFlight;
    if (!live(entry) || !entry.ready || entry.revision === null || entry.blocked || !pending(entry) || !entry.due) {
      return Promise.resolve(snapshotStatus(entry));
    }
    clearTimer(entry);
    // The microtask ensures inFlight is assigned even when a supplied transport throws.
    entry.inFlight = Promise.resolve().then(async (): Promise<WorkspacePreferencesStatus> => {
      while (live(entry) && !entry.blocked && entry.due && pending(entry)) {
        entry.due = false; entry.burstStart = null;
        // Preserve this exact revision/body after ambiguous failures, even if the UI
        // has changed again. The server can acknowledge an exact replay safely.
        if(!entry.request&&entry.desired&&entry.desiredKey!==null&&entry.revision!==null)entry.request = { expectedRevision: entry.revision, state: entry.desired, key: entry.desiredKey, invocation: entry.desiredInvocation ?? {} };
        const sent = entry.request;
        if(!sent)break;
        emit(entry, 'saving', null);
        try {
          const data = await request(entry, 'PUT', sent, assertWorkspaceIntent(sent.invocation, entry.workspace) as unknown as Readonly<Record<string, unknown>>);
          if (!live(entry)) break;
          entry.revision = data.revision; entry.savedKey = sent.key; entry.request = null; entry.failures = 0;
          if (!pending(entry)) { clearTimer(entry); entry.force = false; emit(entry, 'saved', null); }
          else {
            emit(entry, 'pending', null);
            if (entry.force || entry.timer === null) { clearTimer(entry); entry.due = true; }
          }
        } catch (error) {
          if (!live(entry)) break;
          entry.failures += 1;
          const info = errorInfo(error);
          if (info.code === 'PREFERENCES_CONFLICT') {
            entry.blocked = true; clearTimer(entry); emit(entry, 'conflict', info);
          } else if (property(error,'transient') === false) {
            entry.blocked = true; clearTimer(entry); emit(entry, 'error', info);
          } else if (!disposed && entry.failures <= retryDelays.length) {
            emit(entry, 'pending', info); plan(entry, retryDelays[entry.failures - 1] ?? 500, true);
          } else { clearTimer(entry); emit(entry, 'error', info); }
          entry.force = false; entry.due = false;
          break;
        }
      }
      return snapshotStatus(entry);
    }).finally(() => { entry.inFlight = null; });
    return entry.inFlight;
  }

  function flushEntry(entry: WorkspacePreferencesEntry|undefined): Promise<WorkspacePreferencesStatus|null> {
    if (!entry || !live(entry)) return Promise.resolve(null);
    clearTimer(entry); entry.burstStart = null; entry.force = true; entry.due = true;
    // A fresh explicit flush may retry an exhausted transient failure. It never
    // clears a conflict, changes the saved CAS body, or loops on a failed attempt.
    if (entry.phase === 'error' && !entry.blocked) entry.failures = 0;
    return drain(entry);
  }
  function makeEntry(projectId: string): WorkspacePreferencesEntry {
    const workspace = structuredClone(getWorkspace()), key = entryKey(projectId);
    if (cacheIdentity(projectId).entryScope === null) throw failure('Workspace identity has not been verified.', 'WORKSPACE_ORIGIN_UNVERIFIED', false);
    return { projectId, workspace, key, cacheId: cacheIdentity(projectId).cacheId ?? null, state: defaultWorkspaceState(), revision: null, ready: false, retired: false,
      desired: null, desiredKey: null, savedKey: null, request: null, inFlight: null,
      loadPromise: null, timer: null, burstStart: null, due: false, force: false,
      failures: 0, blocked: false, phase: 'loading', error: null };
  }

  async function load(projectId: string,{ reload = false }: WorkspacePreferencesLoadOptions = {}): Promise<WorkspaceState|null> {
    if (disposed || !projectId) return null;
    if (activeId && activeId !== entryKey(projectId)) void flushEntry(entries.get(activeId));
    activeId = entryKey(projectId);
    const token = ++activation;
    let entry = entries.get(entryKey(projectId));
    let previousRequest: Promise<WorkspacePreferencesStatus>|null|undefined;
    if (entry && reload) {
      entry.retired = true; clearTimer(entry); previousRequest = entry.inFlight;
      entry = undefined;
    }
    if (!entry) {
      entry = makeEntry(projectId); entries.set(entry.key, entry);
      emit(entry, 'loading', null);
      entry.loadPromise = (async (): Promise<void> => {
        const activeEntry=entry as WorkspacePreferencesEntry;
        // A reload cannot race an older request from this same controller.
        if (previousRequest) await previousRequest;
        if (disposed || !live(activeEntry)) return;
        const legacy = activeEntry.cacheId === null ? null : readStoredWorkspaceState(activeEntry.cacheId, storage);
        try {
          const data = await request(activeEntry, 'GET');
          if (disposed || !live(activeEntry)) return;
          activeEntry.revision = data.revision;
          activeEntry.state = normalizeWorkspaceState(data.state || legacy || defaultWorkspaceState());
          activeEntry.desired = durableWorkspaceState(activeEntry.state); activeEntry.desiredKey = keyOf(activeEntry.desired);
          // Existing server preferences always win. Legacy import is allowed only
          // after an authenticated GET positively establishes absence.
          activeEntry.savedKey = data.state ? keyOf(durableWorkspaceState(data.state)) : (legacy && !property(activeEntry.workspace,'restored') ? null : activeEntry.desiredKey);
          activeEntry.ready = true; cache(activeEntry);
          emit(activeEntry, pending(activeEntry) ? 'pending' : 'saved', null);
          if (pending(activeEntry)) { activeEntry.burstStart = now(); plan(activeEntry, delayMs); }
        } catch (error) {
          if (disposed || !live(activeEntry)) return;
          activeEntry.state = normalizeWorkspaceState(legacy || defaultWorkspaceState());
          activeEntry.desired = durableWorkspaceState(activeEntry.state); activeEntry.desiredKey = keyOf(activeEntry.desired);
          activeEntry.savedKey = activeEntry.desiredKey; activeEntry.ready = true;
          // Unknown remote state must never be treated as an empty record.
          emit(activeEntry, 'local', errorInfo(error));
        }
      })();
    }
    await entry.loadPromise;
    if (!entry.ready) return null;
    emit(entry);
    return publish(entry, token);
  }

  function update(projectId: string,state: unknown,options: WorkspacePreferencesUpdateOptions = {}): boolean {
    const { immediate = false } = options;
    const entry = entries.get(entryKey(projectId));
    if (disposed || !entry?.ready || !live(entry)) return false;
    entry.state = normalizeWorkspaceState(state); cache(entry);
    // Passive reconciliation can adjust this window's view, but only a fresh
    // explicit update supplies the origin used by the deferred PUT/retry chain.
    if (property(entry.workspace,'restored') && options.expectedWorkspaceOrigin === undefined) return true;
    const invocation = Object.freeze(assertWorkspaceIntent(options, entry.workspace) as unknown as Readonly<Record<string, unknown>>);
    const desired = durableWorkspaceState(entry.state), desiredKey = keyOf(desired);
    if (desiredKey === entry.desiredKey) return true;
    entry.desired = desired; entry.desiredKey = desiredKey; entry.desiredInvocation = invocation;
    if (entry.revision === null || entry.blocked) { emit(entry); return true; }
    if (!pending(entry)) { clearTimer(entry); entry.burstStart = null; emit(entry, 'saved', null); return true; }
    emit(entry, 'pending');
    if (immediate) { void flushEntry(entry); return true; }
    // Do not replace a failed operation's backoff timer with a noisy UI timer.
    if (entry.failures) return true;
    entry.burstStart ??= now();
    plan(entry, Math.min(delayMs, Math.max(0, entry.burstStart + maxWaitMs - now())));
    return true;
  }

  function flush({ projectId, keepalive = false }: WorkspacePreferencesFlushOptions = {}): Promise<(WorkspacePreferencesStatus|null)[]> {
    // PUT always starts with keepalive; an in-flight fetch cannot be upgraded later.
    void keepalive;
    return Promise.all((projectId ? [entries.get(entryKey(projectId))] : [...entries.values()]).map(flushEntry));
  }
  function dispose({ flush: shouldFlush = true }: {flush?: boolean} = {}): Promise<unknown> {
    if (disposePromise) return disposePromise;
    disposed = true; activation += 1;
    for (const entry of entries.values()) clearTimer(entry);
    disposePromise = shouldFlush ? flush({ keepalive: true }) : Promise.resolve([]);
    return disposePromise;
  }
  return { load, update, flush, dispose,
    hasUnsaved: () => [...entries.values()].some(entry => entry.ready && pending(entry)),
    getStatus: (projectId: string): WorkspacePreferencesStatus|null => { const entry=entries.get(entryKey(projectId)); return entry ? snapshotStatus(entry) : null; },
    getSnapshot: (projectId: string): WorkspaceState|null => { const entry=entries.get(entryKey(projectId)); return entry?.ready ? normalizeWorkspaceState(entry.state) : null; },
  };
}
