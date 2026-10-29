import type { AgentTaskCheck, AgentTaskChecks } from '../../../packages/contracts/src/agent-task-checks-v2.ts';
import { readAgentTaskChecks } from './agent-tasks-v2.ts';

export type AgentTaskChecksReader = typeof readAgentTaskChecks;
export interface AgentTaskChecksRound {
  runId: string;
  runRevision: number;
  completed: boolean;
  latest: boolean;
  backgroundPending: boolean;
  visible: boolean;
  attached?: boolean;
}
export interface AgentTaskChecksViewState {
  report: AgentTaskChecks | null;
  loading: boolean;
  preflighting: boolean;
  error: boolean;
  justChecked: boolean;
}

const timelineBasis = (item: AgentTaskCheck): string => JSON.stringify(item.basis
  .filter(value => value.kind === 'timeline')
  .map(value => [value.id, value.revision])
  .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
const identity = (scope: string, projectId: string, runId: string): string => JSON.stringify([scope, projectId, runId]);
const abortError = (): DOMException => new DOMException('Checks read cancelled', 'AbortError');

/** App-lifetime, memory-only cache. It never becomes an execution or permission source. */
export function createAgentTaskChecksCache() {
  const reports = new Map<string, AgentTaskChecks>();
  const preflights = new Map<string, Map<string, { basis: string; item: AgentTaskCheck }>>();
  const automatic = new Set<string>();
  const automaticInFlight = new Map<string, symbol>();
  const queue: (() => void)[] = [];
  let active = 0;
  function schedule<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        const index = queue.indexOf(start);
        if (index >= 0) queue.splice(index, 1);
        reject(abortError());
      };
      const start = () => {
        signal.removeEventListener('abort', cancel);
        if (signal.aborted) { reject(abortError()); return; }
        active++;
        void Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(resolve, reject).finally(() => { active--; queue.shift()?.(); });
      };
      if (signal.aborted) { reject(abortError()); return; }
      signal.addEventListener('abort', cancel, { once: true });
      if (active < 2) start(); else queue.push(start);
    });
  }
  function merge(key: string, report: AgentTaskChecks, full: boolean): AgentTaskChecks {
    const saved = preflights.get(key) ?? new Map<string, { basis: string; item: AgentTaskCheck }>();
    const seen = new Set<string>();
    const groups = report.groups.map(group => ({ ...group, items: group.items.map(item => {
      if (item.type !== 'timeline_preflight') return item;
      seen.add(item.id);
      const basis = timelineBasis(item), previous = saved.get(item.id);
      if (previous && previous.basis !== basis) saved.delete(item.id);
      if (full && item.reason?.code !== 'PREFLIGHT_NOT_REQUESTED') saved.set(item.id, { basis, item });
      return item.reason?.code === 'PREFLIGHT_NOT_REQUESTED' && saved.get(item.id)?.basis === basis
        ? saved.get(item.id)!.item : item;
    }) }));
    for (const id of saved.keys()) if (!seen.has(id)) saved.delete(id);
    if (saved.size) preflights.set(key, saved); else preflights.delete(key);
    return { ...report, groups };
  }
  return {
    schedule,
    claimAutomatic(key: string): symbol | undefined {
      if (automatic.has(key) || automaticInFlight.has(key)) return;
      const token = Symbol('automatic preflight');
      automaticInFlight.set(key, token);
      return token;
    },
    finishAutomatic(key: string, token: symbol, completed: boolean) {
      if (automaticInFlight.get(key) !== token) return;
      automaticInFlight.delete(key);
      if (completed) automatic.add(key);
    },
    read(key: string, revision: number): AgentTaskChecks | undefined {
      const value = reports.get(key);
      return value?.runRevision === revision ? value : undefined;
    },
    save(key: string, report: AgentTaskChecks, full: boolean): AgentTaskChecks {
      const value = merge(key, report, full);
      reports.delete(key); reports.set(key, value);
      // Bound retained report count without forgetting which rounds
      // already consumed their single automatic preflight this app session.
      if (reports.size > 100) {
        const oldest = reports.keys().next().value;
        if (oldest !== undefined) { reports.delete(oldest); preflights.delete(oldest); }
      }
      return value;
    },
  };
}

export const agentTaskChecksCache = createAgentTaskChecksCache();
export function visibleAgentTaskChecks(report: AgentTaskChecks | null, preflighting = false) {
  return (report?.groups ?? []).map(group => ({ ...group, items: group.items
    .filter(item => item.status !== 'not_applicable' && (item.reason?.code !== 'PREFLIGHT_NOT_REQUESTED' || preflighting))
    .sort((a, b) => Number(b.status === 'failed') - Number(a.status === 'failed')),
  })).filter(group => group.items.length > 0);
}

/** One visible round owns its reads. Snapshot events are primary; a visible
 * pending result also needs a 5s fallback because scene/progress updates need
 * not append a run event. No historical round is read merely for being loaded. */
export function createAgentTaskChecksView({ scope, projectId, read = readAgentTaskChecks, cache = agentTaskChecksCache, onChange = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }: {
  scope: string;
  projectId: string;
  read?: AgentTaskChecksReader;
  cache?: ReturnType<typeof createAgentTaskChecksCache>;
  onChange?: (state: AgentTaskChecksViewState) => void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}) {
  let state: AgentTaskChecksViewState = { report: null, loading: false, preflighting: false, error: false, justChecked: false };
  let round: AgentTaskChecksRound | null = null, disposed = false, epoch = 0;
  let controller: AbortController | null = null, timer: ReturnType<typeof setTimeout> | null = null;
  let fullFlight = false, automaticAttempt: { key: string; token: symbol } | null = null;
  const publish = (patch: Partial<AgentTaskChecksViewState>) => { state = { ...state, ...patch }; if (!disposed) onChange(state); };
  const attached = () => !disposed && round?.completed === true && round.attached !== false;
  const readable = () => attached() && round?.visible === true;
  function cancel() {
    epoch++; controller?.abort(); controller = null;
    fullFlight = false;
    if (automaticAttempt) cache.finishAutomatic(automaticAttempt.key, automaticAttempt.token, false);
    automaticAttempt = null;
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function poll() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (!readable() || state.loading) return;
    if (!visibleAgentTaskChecks(state.report).some(group => group.items.some(item => item.status === 'pending'))) return;
    timer = setTimer(() => { timer = null; void load(false); }, 5000);
  }
  function automatic() {
    if (!readable() || fullFlight || !round?.latest || !state.report?.groups.some(group => group.items.some(item => item.reason?.code === 'PREFLIGHT_NOT_REQUESTED'))) return;
    const key = identity(scope, projectId, round.runId), token = cache.claimAutomatic(key);
    if (token) void load(true, false, { key, token });
  }
  async function load(full: boolean, manual = false, attempt?: { key: string; token: symbol }) {
    if (!readable() || !round || fullFlight) {
      if (attempt) cache.finishAutomatic(attempt.key, attempt.token, false);
      return;
    }
    cancel();
    const owner = epoch, current = round, key = identity(scope, projectId, current.runId), abort = new AbortController();
    controller = abort;
    fullFlight = full;
    automaticAttempt = attempt ?? null;
    publish({ loading: true, preflighting: full, error: false, justChecked: false });
    try {
      const report = await cache.schedule(abort.signal, () => read(projectId, current.runId, { preflight: full, signal: abort.signal }));
      if (disposed || owner !== epoch || abort.signal.aborted) return;
      if (attempt) { cache.finishAutomatic(attempt.key, attempt.token, true); automaticAttempt = null; }
      fullFlight = false;
      const merged = cache.save(key, report, full);
      publish({ report: merged, loading: false, preflighting: false, error: false, justChecked: full && manual });
      if (!full) automatic();
    } catch {
      if (!disposed && owner === epoch && !abort.signal.aborted) {
        if (attempt) { cache.finishAutomatic(attempt.key, attempt.token, true); automaticAttempt = null; }
        fullFlight = false;
        publish({ loading: false, preflighting: false, error: true });
      }
    } finally {
      if (owner === epoch) { controller = null; poll(); }
    }
  }
  return {
    getState: () => state,
    update(next: AgentTaskChecksRound) {
      if (disposed) return;
      const previous = round;
      const changed = previous?.runId !== next.runId || previous.runRevision !== next.runRevision || previous.backgroundPending !== next.backgroundPending || previous.completed !== next.completed || previous.attached !== next.attached;
      round = next;
      if (!attached() || previous && previous.runId !== next.runId) {
        cancel(); publish({ loading: false, preflighting: false });
        if (previous && previous.runId !== next.runId) publish({ report: null, error: false, justChecked: false });
        if (!attached()) return;
      }
      // A full local preflight has an explicit lifetime. Ignore intermediate
      // lightweight refreshes until it settles, including background completion
      // and viewport/window visibility changes. Detachment above still cancels.
      if (fullFlight) return;
      if (!readable()) { cancel(); publish({ loading: false, preflighting: false }); return; }
      if (!changed && previous?.visible) { automatic(); poll(); return; }
      cancel();
      const cached = cache.read(identity(scope, projectId, next.runId), next.runRevision);
      if (cached && (!changed || previous === null || previous.runId !== next.runId)) {
        publish({ report: cached, loading: false, preflighting: false, error: false }); automatic(); poll();
      } else {
        // A refresh failure retains this round's last successful result, but a
        // different round must never briefly show the preceding round's data.
        if (previous && previous.runId !== next.runId) publish({ report: null, error: false });
        void load(false);
      }
    },
    recheck() { return load(true, true); },
    dispose() { cancel(); disposed = true; },
  };
}
