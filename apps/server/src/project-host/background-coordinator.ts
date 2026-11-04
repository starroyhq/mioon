import {lstatSync} from 'node:fs';
import {AppError} from '../../../../packages/contracts/src/app-error.ts';
import {isProjectId} from '../../../../packages/contracts/src/project-file.ts';
import type {BackgroundTaskIndexEntry} from '../../../../packages/contracts/src/project-registry.ts';
import type {TaskProjection} from '../../../../packages/business/src/background-task-state.ts';
import {subscribeBackgroundTaskAdmission} from '../../../../packages/business/src/background-task-events.ts';
import type {ProjectHost, ProjectHostReadiness, ProjectHostRuntime, ProjectLease} from './host.ts';
import type {BackgroundTaskIndexPort, ProjectFileIdentityPort, ProjectInboxPort, ProjectLifecycleHooks} from './ports.ts';
import type {ProjectHostManager, RestoreResult, ManagerClock} from './manager.ts';
import {SYSTEM_CLOCK} from './manager.ts';
import type {ProjectHostEvent} from './types.ts';
import {backgroundHistorySource} from './background-history.ts';
import {sameProjectFileIdentity, statProjectFileIdentity} from './stand-ins.ts';

export interface ProjectWorkInspection {
  readonly projectId: string;
  readonly revision: number;
  readonly sourceEpochs: readonly string[];
  readonly certainty: 'known' | 'unknown';
  readonly runningRequests: number;
  readonly runningTasks: number;
  readonly remoteUnknown: number;
  readonly reconciling: number;
  readonly pendingResults: number;
  readonly pendingInbox: number;
  readonly blockedResults: number;
  readonly mayWriteBack: boolean;
  readonly reasons: readonly string[];
}

interface LiveProject {
  readonly host: ProjectHost;
  readonly source: string;
  readonly identity: NonNullable<ReturnType<ProjectFileIdentityPort>>;
  readonly retainOpening: ProjectHostReadiness['retainTask'];
  lease: ProjectLease | null;
  unsubscribe: () => void;
  unsubscribeAdmission: () => void;
  dueAt: number;
  refreshing: boolean;
  projectionDigest: string;
}

const unavailableReasons = new Set(['PROJECT_MISSING', 'PROJECT_FILE_MOVED', 'PROJECT_READ_ONLY', 'PROJECT_READONLY', 'PROJECT_LOCKED',
  'PROJECT_UNAVAILABLE', 'PROJECT_INVALID', 'PROJECT_HISTORY_DIVERGED', 'PROJECT_HISTORY_IDENTITY_CHANGED']);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function failureReason(error: unknown): string {
  const code = record(error) ? error.code : null, details = record(error) && record(error.details) ? error.details : null;
  const reason = details?.reason;
  if (reason === 'read-only' || details?.invalidReason === 'read-only') return 'PROJECT_READ_ONLY';
  if (typeof reason === 'string' && unavailableReasons.has(reason)) return reason;
  return typeof code === 'string' && unavailableReasons.has(code) ? code : 'PROJECT_UNAVAILABLE';
}
const currentEntry = (entry: BackgroundTaskIndexEntry): boolean => entry.phase !== 'archived' && entry.phase !== 'done';
const phaseOf = (task: TaskProjection): 'active' | 'blocked' | 'done' => task.classification === 'terminal' ? 'done' : task.keepAlive ? 'active' : 'blocked';

/** S3 owns one task lease per live project. It never opens a project merely
 * for a query/due check, never submits a provider request and never reads a
 * closed history.db. The domain projection is the status authority. */
export function createBackgroundCoordinator({index, inbox, identity = statProjectFileIdentity, clock = SYSTEM_CLOCK,
  assertMutationAllowed, checkIntervalMs = 30_000}: {
  readonly index: BackgroundTaskIndexPort;
  readonly inbox?: ProjectInboxPort;
  readonly identity?: ProjectFileIdentityPort;
  readonly clock?: ManagerClock;
  readonly assertMutationAllowed: () => void;
  readonly checkIntervalMs?: number;
}) {
  if (!Number.isFinite(checkIntervalMs) || checkIntervalMs < 1) throw new TypeError('Invalid background due interval');
  const live = new Map<string, LiveProject>(), failures = new Map<string, string>(), uncertainSources = new Map<string, string>();
  let manager: Pick<ProjectHostManager, 'status' | 'tryAcquireOpen' | 'close'> | undefined;
  let stopped = false, timer: unknown = null, queryRevision = 0;
  const entries = (id: string): readonly BackgroundTaskIndexEntry[] => index.listProject?.(id) ?? index.list().filter(item => item.projectId === id);
  function markBlocked(projectId: string, reason: string): void {
    failures.set(projectId, reason); queryRevision++;
    assertMutationAllowed();
    if (index.markProject) index.markProject(projectId, 'blocked', reason);
    else index.replace(projectId, entries(projectId).map(item => currentEntry(item)
      ? {...item, phase: 'blocked', reason, revision: (item.revision ?? 0) + 1} : item));
  }
  function detach(projectId: string): void {
    const item = live.get(projectId);
    if (!item) return;
    live.delete(projectId);
    item.unsubscribe(); item.unsubscribeAdmission(); item.host.signal.removeEventListener('abort', itemAborted);
    item.lease?.release(); item.lease = null;
    schedule();
  }
  function itemAborted(): void {
    for (const [id, item] of live) if (item.host.signal.aborted) detach(id);
  }
  function checkAvailable(item: LiveProject): void {
    let found: ReturnType<ProjectFileIdentityPort>;
    try { found = identity(item.host.projectFile); } catch { found = null; }
    if (!found) throw new AppError('PROJECT_MISSING', '项目暂时不可用', 409);
    if (!sameProjectFileIdentity(item.identity, found)) throw new AppError('PROJECT_FILE_MOVED', '项目文件身份已变化', 409);
    const info = lstatSync(item.host.projectFile);
    if ((info.mode & 0o222) === 0) throw new AppError('PROJECT_READ_ONLY', '项目目前只读', 409);
  }
  function persist(item: LiveProject, snapshot: readonly TaskProjection[]): void {
    const previous = entries(item.host.projectId);
    // Reconcile stale hints before admitting newly discovered identities. A
    // full old index must not prevent initial admission of its actual history.
    for (const old of previous) if (currentEntry(old) && (!old.sourceHistory || old.sourceHistory === item.source)
      && !snapshot.some(task => task.kind === old.kind && task.taskId === old.taskId)) {
      const done = {...old, phase: 'done' as const, reason: null, revision: (old.revision ?? 0) + 1};
      assertMutationAllowed();
      if (index.upsert) index.upsert(done);
      else index.replace(item.host.projectId, entries(item.host.projectId).map(entry => entry.kind === old.kind
        && entry.taskId === old.taskId && entry.sourceHistory === old.sourceHistory ? done : entry));
      queryRevision++;
    }
    for (const task of [...snapshot.filter(task => task.classification === 'terminal'), ...snapshot.filter(task => task.classification !== 'terminal')]) {
      const matching = previous.filter(entry => entry.kind === task.kind && entry.taskId === task.taskId);
      const old = matching.find(entry => entry.sourceHistory === item.source)
        ?? matching.find(entry => entry.sourceHistory == null && entry.phase !== 'archived');
      if (old?.phase === 'archived') continue;
      if (!old && matching.some(entry => entry.sourceHistory !== item.source && entry.phase !== 'archived' && entry.phase !== 'done')) {
        markBlocked(item.host.projectId, 'PROJECT_HISTORY_IDENTITY_CHANGED');
        throw new AppError('PROJECT_HISTORY_IDENTITY_CHANGED', '任务属于另一份本机记录', 409);
      }
      const phase = phaseOf(task), reason = task.reason ?? (phase === 'blocked' ? 'WAITING_USER' : null);
      if (phase === 'done' && !old) continue;
      if (old && old.phase === phase && old.reason === reason && old.sourceHistory === item.source
        && old.taskRevision === task.taskRevision && old.projectFile === item.host.projectFile) continue;
      assertMutationAllowed();
      const next: BackgroundTaskIndexEntry = {projectId: item.host.projectId, projectFile: item.host.projectFile,
        kind: task.kind, taskId: task.taskId, indexedAt: old?.indexedAt ?? new Date(clock.now()).toISOString(),
        phase, reason, sourceHistory: item.source, revision: (old?.revision ?? 0) + 1, taskRevision: task.taskRevision};
      if (index.upsert) index.upsert(next);
      else index.replace(item.host.projectId, [...entries(item.host.projectId).filter(entry => entry.kind !== next.kind
        || entry.taskId !== next.taskId || entry.phase === 'archived' || entry.sourceHistory != null && entry.sourceHistory !== next.sourceHistory), next]);
      queryRevision++;
    }
  }
  function update(item: LiveProject, snapshot: readonly TaskProjection[]): void {
    if (stopped || item.host.signal.aborted || live.get(item.host.projectId) !== item) return;
    let failed = false, persistenceError: unknown;
    try {persist(item, snapshot);} catch (error) {
      markUncertain(item);
      failed = true; persistenceError = error;
    }
    const digest = JSON.stringify(snapshot);
    if (digest !== item.projectionDigest) {item.projectionDigest = digest; queryRevision++;}
    const lost = snapshot.find(task => !task.keepAlive && task.reason !== null && unavailableReasons.has(task.reason));
    if (lost) {
      try {unavailable(item, new AppError(lost.reason!, '项目暂时不可用', 409));}
      catch (error) {if (failed) throw persistenceError; throw error;}
      if (failed) throw persistenceError;
      return;
    }
    if (snapshot.some(task => task.classification !== 'terminal' && task.reason === 'BACKGROUND_TASK_INDEX_UNCERTAIN')) markUncertain(item);
    else if (!failed) {uncertainSources.delete(item.host.projectId); failures.delete(item.host.projectId);}
    // A failed post-COMMIT index write cannot skip the executor's lease tail.
    // Domain uncertainty pauses are memory-only, so this must also work while
    // every later attempt to persist their blocked projection still fails.
    reconcileLease(item, snapshot, !failed);
    if (failed) throw persistenceError;
  }
  function markUncertain(item: LiveProject): void {
    if (uncertainSources.get(item.host.projectId) !== item.source || failures.get(item.host.projectId) !== 'BACKGROUND_TASK_INDEX_UNCERTAIN') queryRevision++;
    uncertainSources.set(item.host.projectId, item.source);
    failures.set(item.host.projectId, 'BACKGROUND_TASK_INDEX_UNCERTAIN');
  }
  function reconcileLease(item: LiveProject, snapshot: readonly TaskProjection[], canAcquire: boolean): void {
    if (stopped || item.host.signal.aborted || live.get(item.host.projectId) !== item) return;
    const active = snapshot.some(task => task.classification !== 'terminal' && task.keepAlive);
    // A terminal COMMIT can precede the operation's finally. Keep our lease
    // through that tail; the fast due check below reads only cached state.
    const finishing = !active && item.lease !== null && item.host.runtime.isBusy();
    if (active || finishing) {
      if (!item.lease && canAcquire) item.lease = manager?.status(item.host.projectId)?.state === 'opening'
        ? item.retainOpening() : manager?.tryAcquireOpen(item.host.projectId, 'task') ?? null;
    } else { item.lease?.release(); item.lease = null; }
    item.dueAt = clock.now() + (finishing ? 100 : checkIntervalMs);
    schedule();
  }
  function unavailable(item: LiveProject, error: unknown): void {
    const reason = failureReason(error);
    try { markBlocked(item.host.projectId, reason); } finally {
      // Existing relocation closes through interrupt/drain and fences late SQL.
      // It does not create a replacement file or reopen in a background loop.
      item.host.relocate(); detach(item.host.projectId);
    }
  }
  function schedule(): void {
    if (timer !== null) {clock.clearTimeout(timer); timer = null;}
    if (stopped || live.size === 0) return;
    let next = Infinity;
    for (const item of live.values()) next = Math.min(next, item.dueAt);
    timer = clock.setTimeout(runDue, Math.max(1, next - clock.now()));
  }
  function runDue(): void {
    timer = null;
    let handled = 0;
    for (const item of live.values()) {
      if (item.dueAt > clock.now() || ++handled > 32) continue;
      try {checkAvailable(item);} catch (error) {
        try {unavailable(item, error);} catch { /* Memory failure remains unknown if its app write also failed. */ }
        continue;
      }
      try {
        const state = item.host.runtime.backgroundTasks;
        const snapshot = state?.snapshot() ?? [];
        const finishing = item.lease !== null && !snapshot.some(task => task.keepAlive && task.classification !== 'terminal');
        if (!finishing) { item.refreshing = true; try {state?.refresh();} finally {item.refreshing = false;} }
        update(item, state?.snapshot() ?? []);
      } catch {
        // Index/projection confirmation is not evidence that the project file
        // disappeared. Keep the positive guard without relocating/reopening it.
        markUncertain(item);
        reconcileLease(item, item.host.runtime.backgroundTasks?.snapshot() ?? [], false);
      }
    }
    schedule();
  }
  const hooks: ProjectLifecycleHooks = {afterOpen(_context, ready) {
    if (!ready) throw new TypeError('S3 opening requires the fixed readiness scope');
    if (stopped) throw new AppError('PROJECT_HOST_STOPPED', '后台任务服务已关闭', 503);
    const {host} = ready;
    if (!host.runtime.backgroundTasks) {host.runtime.activateBackground?.(); return;}
    detach(host.projectId);
    const found = identity(host.projectFile);
    if (!found) throw new AppError('PROJECT_MISSING', '项目暂时不可用', 409);
    const item: LiveProject = {host, source: backgroundHistorySource(host.store), identity: found, retainOpening: ready.retainTask,
      lease: null, unsubscribe: () => {}, unsubscribeAdmission: () => {}, dueAt: clock.now() + checkIntervalMs, refreshing: false, projectionDigest: ''};
    live.set(host.projectId, item);
    host.signal.addEventListener('abort', itemAborted, {once: true});
    try {
      checkAvailable(item);
      update(item, host.runtime.backgroundTasks.snapshot());
      item.unsubscribe = host.runtime.backgroundTasks.subscribe(snapshot => {if (!item.refreshing) update(item, snapshot);});
      const state = host.runtime.backgroundTasks;
      if (index.assertCanUpsert && state.preview) item.unsubscribeAdmission = subscribeBackgroundTaskAdmission(host.store.db, refs => {
        if (stopped || live.get(host.projectId) !== item) return;
        const admitted = state.preview!(refs).map(task => ({
          projectId: host.projectId, projectFile: host.projectFile, kind: task.kind, taskId: task.taskId,
          indexedAt: new Date(clock.now()).toISOString(), sourceHistory: item.source, phase: phaseOf(task),
          reason: task.reason, taskRevision: task.taskRevision, revision: 1,
        }));
        // Pure application reads; no prepared row or second project fd. The
        // ordinary project COMMIT and postcommit discovery remain separate.
        index.assertCanUpsert!(admitted);
      });
      host.runtime.activateBackground?.();
    } catch (error) {detach(host.projectId); throw error;}
  }};

  function inspectProjectWork(projectId: string): ProjectWorkInspection {
    if (stopped) throw new AppError('PROJECT_HOST_STOPPED', '后台任务服务已关闭', 503);
    assertMutationAllowed();
    if (!isProjectId(projectId)) throw new TypeError('Invalid project ID');
    const allIndexed = entries(projectId), indexed = allIndexed.filter(currentEntry), item = live.get(projectId), status = manager?.status(projectId);
    const snapshot = item?.host.runtime.backgroundTasks?.snapshot() ?? [];
    const pendingInbox = inbox?.list(projectId).length ?? 0;
    const unindexed = snapshot.some(task => task.classification !== 'terminal'
      && !indexed.some(entry => entry.kind === task.kind && entry.taskId === task.taskId));
    const failedCurrent = failures.has(projectId) && (indexed.length > 0 || item !== undefined);
    const uncertain = uncertainSources.get(projectId);
    const uncertainCurrent = uncertain !== undefined && !allIndexed.some(entry => entry.phase === 'archived' && entry.sourceHistory === uncertain);
    const transitioning = status !== undefined && status !== null && status.state !== 'open';
    const unknown = transitioning || failedCurrent || uncertainCurrent || unindexed || indexed.some(entry => entry.sourceHistory == null || entry.phase == null || entry.phase === 'prepared');
    const counts = {runningTasks: item ? snapshot.filter(task => task.classification === 'running').length : indexed.filter(entry => entry.phase === 'active').length,
      remoteUnknown: snapshot.filter(task => task.classification === 'remote_unknown').length,
      pendingResults: snapshot.filter(task => task.classification === 'result_pending').length};
    const runningRequests = status?.leases.request ?? 0;
    const reasons = [...new Set([...indexed.flatMap(entry => entry.reason ? [entry.reason] : []),
      ...(failedCurrent ? [failures.get(projectId)!] : []), ...(uncertainCurrent ? ['BACKGROUND_TASK_INDEX_UNCERTAIN'] : []),
      ...(pendingInbox ? ['INBOX_PENDING'] : [])])].sort();
    return {projectId, revision: queryRevision + indexed.reduce((sum, entry) => sum + (entry.revision ?? 0), 0),
      sourceEpochs: [...new Set(indexed.flatMap(entry => entry.sourceHistory ? [entry.sourceHistory] : []))].sort(),
      certainty: unknown ? 'unknown' : 'known', runningRequests, ...counts, reconciling: 0, pendingInbox,
      blockedResults: indexed.filter(entry => entry.phase === 'blocked').length,
      mayWriteBack: unknown || indexed.length > 0 || snapshot.some(task => task.classification !== 'terminal')
        || pendingInbox > 0 || runningRequests > 0 || Boolean(item?.host.runtime.isBusy()), reasons};
  }
  return Object.freeze({hooks, inspectProjectWork,
    bindManager(value: Pick<ProjectHostManager, 'status' | 'tryAcquireOpen' | 'close'>): void {if (manager) throw new TypeError('S3 manager already bound'); manager = value;},
    acceptRestore(result: RestoreResult<ProjectHostRuntime>): void {
      for (const lease of result.leases) {
        // The fixed ready hook already retained our lease before activation.
        // Release only restore()'s separate handoff, never another subsystem's.
        lease.release();
      }
      for (const failure of result.failures) markBlocked(failure.projectId, failureReason(failure.error));
    },
    onHostEvent(event: ProjectHostEvent): void {
      if (event.type === 'closing') detach(event.projectId);
      else if (event.type === 'closed') {
        detach(event.projectId);
        const reason = failures.get(event.projectId);
        if (reason && unavailableReasons.has(reason)) markBlocked(event.projectId, reason);
      } else if (event.type === 'open-failed' && event.projectId !== null) markBlocked(event.projectId, failureReason(event.error));
    },
    listUnavailableProjects(): readonly {projectId: string; taskCount: number; reasonCodes: readonly string[]}[] {
      if (stopped) throw new AppError('PROJECT_HOST_STOPPED', '后台任务服务已关闭', 503);
      assertMutationAllowed();
      const byProject = new Map<string, BackgroundTaskIndexEntry[]>();
      for (const entry of index.list()) if (currentEntry(entry) && entry.phase === 'blocked' && entry.reason && unavailableReasons.has(entry.reason)) {
        const group = byProject.get(entry.projectId) ?? []; group.push(entry); byProject.set(entry.projectId, group);
      }
      return [...byProject].map(([projectId, tasks]) => ({projectId, taskCount: tasks.length,
        reasonCodes: [...new Set(tasks.flatMap(task => task.reason ? [task.reason] : []))].sort()})).sort((a, b) => a.projectId.localeCompare(b.projectId));
    },
    stop(): void {stopped = true; if (timer !== null) clock.clearTimeout(timer); timer = null; for (const id of [...live.keys()]) detach(id);},
  });
}
