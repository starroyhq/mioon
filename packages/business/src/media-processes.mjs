import { spawn } from 'node:child_process';
import { mediaEnvironment } from './media-environment.mjs';

const active = new Map(), records = new WeakMap(), observers = new Set();
export const MEDIA_TERMINATION_POLICY = Object.freeze({ graceMs: 2000, reapMs: 1000 });
const notify = event => { for (const observer of observers) { try { observer(event); } catch { /* telemetry must not alter rendering */ } } };

export function interruptedMediaError() {
  return Object.assign(new Error('Local media operation was cancelled.'), { name: 'AbortError', code: 'MEDIA_CANCELLED' });
}
export function throwIfMediaAborted(signal) { if (signal?.aborted) throw interruptedMediaError(); }

/** Only trusted executable paths and generated argv arrays reach this module. */
export function spawnMedia(command, args, options = {}, { kind, signal } = {}) {
  throwIfMediaAborted(signal);
  if (hasUnconfirmedMediaProcesses()) throw Object.assign(new Error('A previous local media tool has not confirmed its close.'), { code: 'MEDIA_TERMINATION_UNCONFIRMED', terminationUnconfirmed: true });
  // Never accept an environment overlay. Even direct callers receive exactly
  // the same reduced environment as the shared runner.
  const { env: _env, signal: _signal, ...safeOptions } = options;
  const child = spawn(command, args, { ...safeOptions, env: mediaEnvironment(), shell: false, windowsHide: true, detached: false });
  const record = { child, kind, signal, started: false, exited: false, closed: false, terminationUnconfirmed: false, stop: null, onClose: new Set(), onInterrupt: new Set() };
  active.set(child, record); records.set(child, record);
  const closed = () => {
    if (record.closed) return;
    record.closed = true;
    active.delete(child);
    signal?.removeEventListener('abort', aborted);
    if (record.started) notify({ type: 'exited', pid: child.pid, kind });
    for (const done of record.onClose) done();
    record.onClose.clear();
  };
  const aborted = () => { void terminateMediaProcess(child); };
  child.once('spawn', () => {
    record.started = true;
    notify({ type: 'started', pid: child.pid, kind });
  });
  child.once('exit', () => { record.exited = true; });
  child.once('close', closed);
  child.on('error', () => { if (!child.pid) closed(); });
  signal?.addEventListener('abort', aborted, { once: true });
  // Also covers an abort triggered synchronously during spawn instrumentation.
  if (signal?.aborted) aborted();
  return child;
}

export function onMediaProcess(observer) { observers.add(observer); return () => observers.delete(observer); }
export function mediaInterrupted(child) { return Boolean(child.workbenchInterrupted); }
// This exact owned-record state is authoritative for both new-start fencing
// and shutdown observers. Exit alone cannot release pending stdio ownership.
export function hasUnconfirmedMediaProcesses({ signal } = {}) {
  return [...active.values()].some(record => record.terminationUnconfirmed && (signal === undefined || record.signal === signal));
}
export function onMediaInterruption(child, observer) {
  const record = records.get(child);
  record?.onInterrupt.add(observer);
  if (mediaInterrupted(child)) observer();
  return () => record?.onInterrupt.delete(observer);
}

/** Stop only an owned direct child; this deliberately makes no tree-kill claim. */
export function terminateMediaProcess(child, { interrupted = true } = {}) {
  const record = records.get(child);
  if (!record) return Promise.resolve({ status: 'unowned', forced: false });
  const newlyInterrupted = interrupted && !mediaInterrupted(child);
  if (interrupted) child.workbenchInterrupted = true;
  if (!record.stop) record.stop = record.closed ? Promise.resolve({ status: 'exited', forced: false }) : new Promise(resolve => {
    let finished = false, forced = false, hardTimer, reapTimer;
    const finish = status => {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer); clearTimeout(reapTimer);
      record.onClose.delete(onClose);
      resolve({ status, forced });
    };
    const onClose = () => finish('exited');
    record.onClose.add(onClose);
    const kill = signal => { if (record.exited || record.closed) return; try { child.kill(signal); } catch { /* result is determined by observed close, not kill's return */ } };
    hardTimer = setTimeout(() => {
      if (record.closed) { finish('exited'); return; }
      if (!record.exited) { forced = true; kill('SIGKILL'); }
    }, MEDIA_TERMINATION_POLICY.graceMs);
    // Schedule the final deadline from stop start. A delayed grace callback
    // must not grant another fresh reap interval after the total budget.
    reapTimer = setTimeout(() => {
      if (record.closed) { finish('exited'); return; }
      // Keep it tracked until actual close; never report a successful reap or
      // guess another PID. Release local handles so shutdown remains bounded.
      record.terminationUnconfirmed = true;
      child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
      finish('unconfirmed');
    }, MEDIA_TERMINATION_POLICY.graceMs + MEDIA_TERMINATION_POLICY.reapMs);
    kill('SIGTERM');
  });
  // Announce only after caching the stop promise, so a runner that receives a
  // legacy/scoped shutdown can join the same bounded reap without recursion.
  if (newlyInterrupted) for (const observer of record.onInterrupt) { try { observer(); } catch { /* lifecycle observers cannot block stopping */ } }
  return record.stop;
}

// No arguments preserves the legacy all-owned behavior. A signal scopes a
// worker shutdown so another backend in the same process is not interrupted.
export async function terminateMediaProcesses({ signal } = {}) {
  return Promise.all([...active.values()].filter(record => signal === undefined || record.signal === signal).map(record => terminateMediaProcess(record.child)));
}

// Used after an unconfirmed stop when the owner must stay alive until actual
// close. This observes current owned children only and sends no further signal.
export async function waitForMediaProcesses({ signal } = {}) {
  return Promise.all([...active.values()].filter(record => signal === undefined || record.signal === signal).map(record => new Promise(resolve => {
    if (record.closed) { resolve({ status: 'exited' }); return; }
    record.child.ref();
    const closed = () => { record.onClose.delete(closed); resolve({ status: 'exited' }); };
    record.onClose.add(closed);
  })));
}
