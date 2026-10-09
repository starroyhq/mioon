import { defaultWorkspaceState, normalizeWorkspaceState, readStoredWorkspaceState, writeWorkspaceState } from './workspace-state.js';

// This projection is deliberately independent of project data and request recovery.
// Search text belongs only to the live renderer, never to durable preferences.
const uuid = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
export function durableWorkspaceState(value) {
  const state = normalizeWorkspaceState(value);
  for (const key of ['selectedId', 'selectedEdgeId', 'highlightedVersionId']) {
    if (!uuid.test(state.canvas[key] || '')) state.canvas[key] = null;
  }
  for (const key of ['selectedClipId', 'quickAssetId']) {
    if (!uuid.test(state.editing[key] || '')) state.editing[key] = null;
  }
  delete state.shared.assetSearch;
  return state;
}

const keyOf = state => JSON.stringify(state);
// Compare the complete whitelist independent of JSON property order. A partial
// or malformed successful response must not be normalized into writable defaults.
const sameShape = (expected, received) => {
  if (expected === received) return true;
  if (!expected || !received || typeof expected !== 'object' || typeof received !== 'object' || Array.isArray(received)) return false;
  const keys = Object.keys(expected);
  return keys.length === Object.keys(received).length && keys.every(key => Object.hasOwn(received, key) && sameShape(expected[key], received[key]));
};
const validRemoteState = (state, allowLegacy) => {
  const expected = durableWorkspaceState(state);
  // A legacy v1 GET may omit this one additive field. Do not generalize this
  // exception to partial states or PUT acknowledgements of the submitted body.
  if (allowLegacy && state?.editing && !Object.hasOwn(state.editing, 'snappingEnabled')) delete expected.editing.snappingEnabled;
  return sameShape(expected, state);
};
const errorInfo = error => ({ code: error?.code || 'NETWORK', message: error?.message || 'Workspace preferences are unavailable.' });
const failure = (message, code = 'NETWORK', transient = true) => Object.assign(new Error(message), { code, transient });

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
  fetchImpl = (...args) => globalThis.fetch(...args), storage,
  onState = () => {}, onStatus = () => {},
  delayMs = 250, maxWaitMs = 1000, retryDelays = [500, 1500, 4000],
  requestTimeoutMs = 8000, now = () => Date.now(),
  setTimeout: schedule = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout,
} = {}) {
  const entries = new Map();
  let activeId = null, activation = 0, disposed = false, disposePromise;

  function live(entry) { return entries.get(entry.projectId) === entry && !entry.retired; }
  function pending(entry) { return Boolean(entry.request) || entry.desiredKey !== entry.savedKey; }
  function snapshotStatus(entry) {
    return { phase: entry.phase, revision: entry.revision, pending: entry.ready && pending(entry),
      canRetry: !entry.blocked && entry.revision !== null, error: entry.error ? { ...entry.error } : null };
  }
  function emit(entry, phase = entry.phase, error = entry.error) {
    entry.phase = phase; entry.error = error;
    if (!disposed && live(entry)) {
      try { onStatus(entry.projectId, snapshotStatus(entry)); } catch { /* UI callbacks cannot break a save. */ }
    }
  }
  function publish(entry, token) {
    if (!disposed && live(entry) && activeId === entry.projectId && activation === token) {
      try { onState(entry.projectId, normalizeWorkspaceState(entry.state)); } catch { /* Same isolation as status callbacks. */ }
      return normalizeWorkspaceState(entry.state);
    }
    return null;
  }
  function clearTimer(entry) {
    if (entry.timer !== null) cancel(entry.timer);
    entry.timer = null;
  }
  function cache(entry) {
    // Keep an offline fallback without search text, unknown fields or credentials.
    writeWorkspaceState(entry.projectId, durableWorkspaceState(entry.state), storage);
  }
  function plan(entry, delay, retry = false) {
    clearTimer(entry);
    if (disposed || !live(entry)) return;
    entry.timer = schedule(() => {
      entry.timer = null; entry.due = true;
      if (!retry) entry.burstStart = null;
      void drain(entry);
    }, Math.max(0, delay));
  }
  async function request(entry, method, body) {
    const controller = new AbortController();
    let timeout;
    try {
      const transport = (async () => {
        const response = await fetchImpl(`/api/workspace-preferences/${encodeURIComponent(entry.projectId)}`, {
          method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
          ...(method === 'PUT' ? { keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
        });
        let envelope;
        try { envelope = await response.json(); } catch { throw failure('Workspace preferences returned invalid data.'); }
        if (!response.ok || envelope?.ok !== true) {
          const code = envelope?.error?.code || (response.status === 401 ? 'UNAUTHORIZED' : 'NETWORK');
          throw failure(envelope?.error?.message || 'Workspace preferences could not be saved.', code,
            response.status >= 500 || [408, 425, 429].includes(response.status));
        }
        const data = envelope.data;
        if (!data || data.projectId !== entry.projectId || !Number.isSafeInteger(data.revision) || data.revision < 0 ||
          (data.state === null ? data.revision !== 0 : data.revision === 0 || data.state?.version !== 1 ||
            !validRemoteState(data.state, method === 'GET'))) {
          throw failure('Workspace preferences returned an invalid revision or state.');
        }
        if (method === 'PUT' && (data.revision !== body.expectedRevision + 1 || keyOf(durableWorkspaceState(data.state)) !== keyOf(body.state))) {
          throw failure('Workspace preferences did not acknowledge the saved state.');
        }
        return data;
      })();
      if (!(requestTimeoutMs > 0)) return await transport;
      return await Promise.race([transport, new Promise((_, reject) => {
        timeout = schedule(() => { controller.abort(); reject(failure('Workspace preferences timed out.')); }, requestTimeoutMs);
      })]);
    } finally { if (timeout !== undefined) cancel(timeout); }
  }

  function drain(entry) {
    if (entry.inFlight) return entry.inFlight;
    if (!live(entry) || !entry.ready || entry.revision === null || entry.blocked || !pending(entry) || !entry.due) {
      return Promise.resolve(snapshotStatus(entry));
    }
    clearTimer(entry);
    // The microtask ensures inFlight is assigned even when a supplied transport throws.
    entry.inFlight = Promise.resolve().then(async () => {
      while (live(entry) && !entry.blocked && entry.due && pending(entry)) {
        entry.due = false; entry.burstStart = null;
        // Preserve this exact revision/body after ambiguous failures, even if the UI
        // has changed again. The server can acknowledge an exact replay safely.
        entry.request ||= { expectedRevision: entry.revision, state: entry.desired, key: entry.desiredKey };
        const sent = entry.request;
        emit(entry, 'saving', null);
        try {
          const data = await request(entry, 'PUT', { expectedRevision: sent.expectedRevision, state: sent.state });
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
          } else if (error?.transient === false) {
            entry.blocked = true; clearTimer(entry); emit(entry, 'error', info);
          } else if (!disposed && entry.failures <= retryDelays.length) {
            emit(entry, 'pending', info); plan(entry, retryDelays[entry.failures - 1], true);
          } else { clearTimer(entry); emit(entry, 'error', info); }
          entry.force = false; entry.due = false;
          break;
        }
      }
      return snapshotStatus(entry);
    }).finally(() => { entry.inFlight = null; });
    return entry.inFlight;
  }

  function flushEntry(entry) {
    if (!entry || !live(entry)) return Promise.resolve(null);
    clearTimer(entry); entry.burstStart = null; entry.force = true; entry.due = true;
    // A fresh explicit flush may retry an exhausted transient failure. It never
    // clears a conflict, changes the saved CAS body, or loops on a failed attempt.
    if (entry.phase === 'error' && !entry.blocked) entry.failures = 0;
    return drain(entry);
  }
  function makeEntry(projectId) {
    return { projectId, state: defaultWorkspaceState(), revision: null, ready: false, retired: false,
      desired: null, desiredKey: null, savedKey: null, request: null, inFlight: null,
      loadPromise: null, timer: null, burstStart: null, due: false, force: false,
      failures: 0, blocked: false, phase: 'loading', error: null };
  }

  async function load(projectId, { reload = false } = {}) {
    if (disposed || !projectId) return null;
    if (activeId && activeId !== projectId) void flushEntry(entries.get(activeId));
    activeId = projectId;
    const token = ++activation;
    let entry = entries.get(projectId);
    let previousRequest;
    if (entry && reload) {
      entry.retired = true; clearTimer(entry); previousRequest = entry.inFlight;
      entry = null;
    }
    if (!entry) {
      entry = makeEntry(projectId); entries.set(projectId, entry);
      emit(entry, 'loading', null);
      entry.loadPromise = (async () => {
        // A reload cannot race an older request from this same controller.
        if (previousRequest) await previousRequest;
        if (disposed || !live(entry)) return;
        const legacy = readStoredWorkspaceState(projectId, storage);
        try {
          const data = await request(entry, 'GET');
          if (disposed || !live(entry)) return;
          entry.revision = data.revision;
          entry.state = normalizeWorkspaceState(data.state || legacy || defaultWorkspaceState());
          entry.desired = durableWorkspaceState(entry.state); entry.desiredKey = keyOf(entry.desired);
          // Existing server preferences always win. Legacy import is allowed only
          // after an authenticated GET positively establishes absence.
          entry.savedKey = data.state ? keyOf(durableWorkspaceState(data.state)) : (legacy ? null : entry.desiredKey);
          entry.ready = true; cache(entry);
          emit(entry, pending(entry) ? 'pending' : 'saved', null);
          if (pending(entry)) { entry.burstStart = now(); plan(entry, delayMs); }
        } catch (error) {
          if (disposed || !live(entry)) return;
          entry.state = normalizeWorkspaceState(legacy || defaultWorkspaceState());
          entry.desired = durableWorkspaceState(entry.state); entry.desiredKey = keyOf(entry.desired);
          entry.savedKey = entry.desiredKey; entry.ready = true;
          // Unknown remote state must never be treated as an empty record.
          emit(entry, 'local', errorInfo(error));
        }
      })();
    }
    await entry.loadPromise;
    if (!entry.ready) return null;
    emit(entry);
    return publish(entry, token);
  }

  function update(projectId, state, { immediate = false } = {}) {
    const entry = entries.get(projectId);
    if (disposed || !entry?.ready || !live(entry)) return false;
    entry.state = normalizeWorkspaceState(state); cache(entry);
    const desired = durableWorkspaceState(entry.state), desiredKey = keyOf(desired);
    if (desiredKey === entry.desiredKey) return true;
    entry.desired = desired; entry.desiredKey = desiredKey;
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

  function flush({ projectId, keepalive = false } = {}) {
    // PUT always starts with keepalive; an in-flight fetch cannot be upgraded later.
    void keepalive;
    return Promise.all((projectId ? [entries.get(projectId)] : [...entries.values()]).map(flushEntry));
  }
  function dispose({ flush: shouldFlush = true } = {}) {
    if (disposePromise) return disposePromise;
    disposed = true; activation += 1;
    for (const entry of entries.values()) clearTimer(entry);
    disposePromise = shouldFlush ? flush({ keepalive: true }) : Promise.resolve([]);
    return disposePromise;
  }
  return { load, update, flush, dispose,
    hasUnsaved: () => [...entries.values()].some(entry => entry.ready && pending(entry)),
    getStatus: projectId => entries.has(projectId) ? snapshotStatus(entries.get(projectId)) : null,
    getSnapshot: projectId => entries.get(projectId)?.ready ? normalizeWorkspaceState(entries.get(projectId).state) : null,
  };
}
