import type {DatabaseSync} from 'node:sqlite';
import {lstatSync, realpathSync} from 'node:fs';
import {AppError} from '../../contracts/src/app-error.ts';
import {parseVideoBinding} from '../../contracts/src/video-providers.ts';
import type {ProjectStore} from './project-file/store.ts';
import {assertProjectStore} from './store-runtime.ts';
import {agentTaskJobBinding} from './agent/task-effects-v2.ts';
import {mioTable} from './agent/mio-table-layout.ts';
import {isSqliteReadOnly, SQLITE_READONLY_DBMOVED} from './project-file/errors.ts';
import {subscribeBackgroundTaskChanges, subscribeBackgroundTaskAdmission, subscribeBackgroundTaskUncertainty} from './background-task-events.ts';
import type {BackgroundTaskKind, BackgroundTaskRef} from './background-task-events.ts';

export interface TaskProjection extends BackgroundTaskRef {
  readonly classification: 'running' | 'remote_unknown' | 'result_pending' | 'waiting_user' | 'terminal';
  readonly keepAlive: boolean;
  readonly reason: string | null;
  readonly taskRevision: number;
}
export interface ProjectBackgroundState {
  snapshot(): readonly TaskProjection[];
  /** Read-only capacity preview; never publishes uncommitted rows. */
  preview(refs: readonly BackgroundTaskRef[]): readonly TaskProjection[];
  /** With no argument, recheck only already managed identities. */
  refresh(refs?: readonly BackgroundTaskRef[]): void;
  subscribe(listener: (tasks: readonly TaskProjection[]) => void): () => void;
  dispose(): void;
}
type Row = Record<string, unknown>;
const PROJECT_LIMIT = 512;
const tables = {job: 'jobs', export: 'exports', edit_task: 'edit_tasks', image_task: 'image_tasks',
  frame_task: 'frame_tasks', scene_task: 'scene_tasks', subject_variant_batch: 'subject_variant_batches'} as const;
interface FileIdentity {readonly dev: bigint; readonly ino: bigint; readonly birthtimeNs: bigint}
const instances = new WeakMap<DatabaseSync, {store: ProjectStore; project: FileIdentity; directory: FileIdentity; state: ProjectBackgroundState; pause(ref: BackgroundTaskRef, reason: string): void}>();
const key = (ref: BackgroundTaskRef): string => `${ref.kind}:${ref.taskId}`;
const record = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const code = (value: unknown, fallback: string): string => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/u.test(value) ? value : fallback;
const revision = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const objectCode = (error: unknown): string | undefined => record(error) && typeof error.code === 'string' ? error.code : undefined;

/** Host/file loss pauses the original task. It is not a generation failure and
 * must be observed before an old catch path tries to update the lost owner. */
export function pauseUnavailableBackgroundTask(db: DatabaseSync, ref: BackgroundTaskRef, error: unknown): boolean {
  const errorCode = objectCode(error);
  let moved = false, readonly = false, cause: unknown = error;
  const visited = new Set<unknown>();
  const causes: Row[] = [];
  for (let depth = 0; record(cause) && !visited.has(cause) && depth < 8; depth++) {
    visited.add(cause); causes.push(cause); moved ||= cause.errcode === SQLITE_READONLY_DBMOVED; readonly ||= isSqliteReadOnly(cause); cause = cause.cause;
  }
  let reason = moved || errorCode === 'PROJECT_FILE_MOVED' ? 'PROJECT_FILE_MOVED'
    : readonly ? 'PROJECT_READONLY'
      : ['PROJECT_UNAVAILABLE', 'PROJECT_MISSING', 'PROJECT_READONLY', 'APP_LIBRARY_CLOSED', 'APP_LIBRARY_LOCKED'].includes(errorCode ?? '') ? errorCode! : null;
  const instance = instances.get(db), filesystemCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'ENOTDIR', 'ENODEV', 'ESTALE']);
  const unavailableSource = causes.some(item => ['MEDIA_MISSING', 'MEDIA_OUTSIDE_NOT_CONFIRMED'].includes(String(item.code)));
  if (!reason && instance && (unavailableSource || causes.some(item => filesystemCodes.has(String(item.code))))) {
    const same = (a: FileIdentity, b: FileIdentity): boolean => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
    try {
      // Metadata only: never open another descriptor for any held SQLite file.
      const project = lstatSync(instance.store.projectFile, {bigint: true}), directory = lstatSync(instance.store.projectDir, {bigint: true});
      if (!project.isFile() || project.isSymbolicLink() || !directory.isDirectory() || directory.isSymbolicLink()
        || realpathSync(instance.store.projectDir) !== instance.store.projectDir || !same(project, instance.project) || !same(directory, instance.directory)) reason = 'PROJECT_FILE_MOVED';
      else if ((project.mode & 0o222n) === 0n || (directory.mode & 0o222n) === 0n) reason = 'PROJECT_READONLY';
    } catch (failure) {reason = ['EACCES', 'EPERM', 'EROFS'].includes(objectCode(failure) ?? '') ? 'PROJECT_READONLY' : 'PROJECT_MISSING';}
    if (!reason && unavailableSource) reason = 'SOURCE_UNAVAILABLE';
    // A filesystem path alone does not prove source ownership: publication,
    // tools and credentials can fail too. Only the source boundary above can
    // identify unavailable media while the project itself remains usable.
  }
  if (!reason) return false;
  instance?.pause(ref, reason);
  return true;
}

/** A single read-only projection per exact project owner. The initial bounded
 * admission scan is separate from normal ID-only updates and due checks. */
export function createProjectBackgroundState(input: unknown): ProjectBackgroundState {
  assertProjectStore(input);
  const store = input as ProjectStore, db = store.db, previous = instances.get(db);
  if (previous) {
    if (previous.store !== store) throw new TypeError('A background state requires its exact project store');
    return previous.state;
  }
  const cache = new Map<string, TaskProjection>(), paused = new Map<string, string>();
  const listeners = new Set<(tasks: readonly TaskProjection[]) => void>();
  let disposed = false;
  const projection = (ref: BackgroundTaskRef, classification: TaskProjection['classification'], keepAlive: boolean,
    reason: string | null, taskRevision: unknown): TaskProjection => Object.freeze({...ref, classification, keepAlive, reason, taskRevision: revision(taskRevision)});
  const jsonColumns = `id,projectId,
    CASE WHEN json_valid(data) THEN json_extract(data,'$.id') END AS jsonId,
    CASE WHEN json_valid(data) THEN json_extract(data,'$.projectId') END AS jsonProjectId,
    CASE WHEN json_valid(data) THEN json_extract(data,'$.status') END AS status,
    CASE WHEN json_valid(data) THEN json_extract(data,'$.revision') END AS revision,
    CASE WHEN json_valid(data) THEN json_extract(data,'$.phase') END AS phase,
    CASE WHEN json_valid(data) THEN json_extract(data,'$.error.code') END AS errorCode,
    CASE WHEN json_valid(data) THEN json_extract(data,'$.providerId') END AS providerId,
    CASE WHEN json_valid(data) THEN json_extract(data,'$.providerJobId') END AS providerJobId,
    CASE WHEN json_valid(data) THEN json_extract(data,'$.cancelScope') END AS cancelScope,
    CASE WHEN json_valid(data) THEN json_extract(data,'$.submissionCount') END AS submissionCount,
    CASE WHEN json_valid(data) THEN json_extract(data,'$.nextPollAt') END AS nextPollAt,
    CASE WHEN json_valid(data) THEN json_extract(data,'$.snapshot.capabilities.reconciliation') END AS reconciliation,
    CASE WHEN json_valid(data) AND length(CAST(json_extract(data,'$.snapshot.executionBinding') AS BLOB))<=16384
      THEN json_extract(data,'$.snapshot.executionBinding') END AS executionBinding`;
  const columns = (kind: BackgroundTaskKind): string => kind === 'job' || kind === 'export' ? jsonColumns
    : kind === 'subject_variant_batch' ? 'id,projectId,state,revision'
      : kind === 'edit_task' ? 'id,projectId,status,revision,errorCode'
        : kind === 'image_task' ? 'id,projectId,state,revision,errorCode,requestId,stagedReceipt IS NOT NULL AS receipt'
          : kind === 'frame_task' || kind === 'scene_task' ? 'id,projectId,state,revision,errorCode,stagedReceipt IS NOT NULL AS receipt' : '';
  function effectReason(ref: BackgroundTaskRef): string | null {
    const kind = ref.kind === 'job' ? 'job' : ref.kind === 'export' ? 'export' : ref.kind === 'image_task' ? 'image'
      : ref.kind === 'frame_task' ? 'frame' : ref.kind === 'scene_task' ? 'scene' : null;
    if (!kind) return null;
    try {
      const binding = agentTaskJobBinding(db, kind, ref.taskId);
      if (!binding) return null;
      // The actual effect gate may persist a new approval/conflict. Projection
      // only reads durable control state and never calls that mutating gate.
      const run = db.prepare(`SELECT status FROM ${mioTable(db, 'runs')} WHERE id=? AND projectId=?`).get(binding.runId, binding.projectId);
      const step = db.prepare(`SELECT CASE WHEN json_valid(data) THEN json_extract(data,'$.data.backgroundDenied') END AS denied,
        CASE WHEN json_valid(data) THEN json_extract(data,'$.data.backgroundApprovalRequired') END AS approval,
        CASE WHEN json_valid(data) THEN json_extract(data,'$.data.approvalDigest') END AS approvalDigest
        FROM ${mioTable(db, 'steps')} WHERE id=? AND runId=?`).get(binding.stepId, binding.runId);
      if (!run || !step) return 'AGENT_TASK_EFFECT_BLOCKED';
      if (step.denied === 1 || ['stopped', 'reverted', 'failed'].includes(String(run.status))) return 'AGENT_TASK_STOPPED';
      return ['running', 'awaiting_approval', 'awaiting_answer', 'completed'].includes(String(run.status))
        && (step.approval !== 1 || typeof step.approvalDigest === 'string') ? null : 'AGENT_TASK_PAUSED';
    } catch {return 'AGENT_TASK_EFFECT_BLOCKED';}
  }
  function classify(ref: BackgroundTaskRef, row: Row | undefined): TaskProjection {
    const result = (classification: TaskProjection['classification'], keepAlive: boolean, reason: string | null = null) => projection(ref, classification, keepAlive, reason, row?.revision);
    if (!row) return result('terminal', false, 'BACKGROUND_TASK_REMOVED');
    if (row.projectId !== store.projectId || (ref.kind === 'job' || ref.kind === 'export') && (row.jsonId !== row.id || row.jsonProjectId !== row.projectId))
      return result('waiting_user', false, 'BACKGROUND_TASK_INVALID');
    const state = String(row.status ?? row.state), errorCode = code(row.errorCode, 'BACKGROUND_TASK_REQUIRES_ATTENTION');
    let value: TaskProjection;
    if (ref.kind === 'job' || ref.kind === 'export') {
      if (state === 'succeeded' || state === 'failed') return result('terminal', false);
      if (state === 'cancelled') return ref.kind === 'job' && row.cancelScope === 'local_only' && (row.providerJobId || Number(row.submissionCount) > 0)
        ? result(row.phase === 'output_review_required' ? 'waiting_user' : 'remote_unknown', false, errorCode) : result('terminal', false);
      if (row.phase === 'connection_required' && row.nextPollAt !== 0) return result('waiting_user', false, errorCode);
      if (state === 'submission_unknown') {
        // Configured Kling already has an external_task_ids read-only lookup.
        // Derive this from its validated frozen binding, never a current setting
        // or a guessed replacement POST. Other adapters may not reconcile IDs.
        let externalLookup = false;
        if (row.providerId === 'kling' && typeof row.executionBinding === 'string') try {
          externalLookup = parseVideoBinding(JSON.parse(row.executionBinding)).providerId === 'kling';
        } catch {/* Malformed bindings remain blocked for explicit repair. */}
        // Explicit activation/recovery may request one read-only lookup even
        // for an older snapshot without a declared reconciliation capability.
        // A null lookup writes a future nextPollAt and becomes quiet again.
        return result('remote_unknown', Boolean(row.providerJobId) || row.providerId === 'mock' || row.reconciliation === 'request-id' || externalLookup || row.nextPollAt === 0, 'SUBMISSION_UNKNOWN');
      }
      value = ['queued', 'submitting', 'running', 'downloading'].includes(state) ? result('running', true) : result('waiting_user', false, 'BACKGROUND_TASK_INVALID');
    } else if (ref.kind === 'edit_task') {
      if (state === 'applied' || state === 'not_applied') return result('terminal', false);
      return state === 'dispatching' ? result('running', true) : state === 'unknown' ? result('remote_unknown', false, 'EDIT_TASK_OUTCOME_UNKNOWN')
        : result('waiting_user', false, state === 'prepared' ? 'EDIT_TASK_PREPARED' : 'BACKGROUND_TASK_INVALID');
    } else if (ref.kind === 'subject_variant_batch') {
      if (state === 'undone') return result('terminal', false);
      if (state !== 'active') return result('waiting_user', false, 'BACKGROUND_TASK_INVALID');
      const items = db.prepare(`SELECT i.versionId,t.id,t.projectId,t.state,t.revision,t.errorCode,t.requestId,t.stagedReceipt IS NOT NULL AS receipt
        FROM subject_variant_items i LEFT JOIN image_tasks t ON t.projectId=i.projectId AND t.requestId=i.imageRequestId
        WHERE i.batchId=? AND i.projectId=? ORDER BY i.position LIMIT 9`).all(ref.taskId, store.projectId);
      if (!items.length || items.length > 8) return result('waiting_user', false, 'BACKGROUND_TASK_INVALID');
      const remaining: TaskProjection[] = [];
      for (const item of items) {
        if (item.versionId) continue;
        // Normal publication links in the image transaction. A historical
        // unlinked result has no background retry loop; retain it for review
        // without inventing an executor that would hold the host forever.
        if (item.state === 'succeeded') remaining.push(result('result_pending', false, 'SUBJECT_VARIANT_LINK_PENDING'));
        else if (typeof item.id === 'string') {
          const child = {kind: 'image_task' as const, taskId: item.id}, blocked = paused.get(key(child));
          remaining.push(blocked ? projection(child, 'waiting_user', false, blocked, item.revision) : classify(child, item));
        }
        else remaining.push(result('waiting_user', false, 'SUBJECT_VARIANT_PENDING'));
      }
      const unresolved = remaining.filter(item => item.classification !== 'terminal');
      const current = unresolved.find(item => item.keepAlive) ?? unresolved[0];
      return current ? result(current.classification, current.keepAlive, current.reason) : result('terminal', false);
    } else {
      if (['succeeded', 'failed', 'cancelled', 'cancelled_before_start', 'cancelled_before_dispatch', 'undone'].includes(state)) return result('terminal', false);
      const observing = ref.kind === 'image_task' && Boolean(db.prepare("SELECT 1 FROM image_remote_observations WHERE taskId=? AND projectId=? AND state IN ('queued','running') LIMIT 1").get(ref.taskId, store.projectId));
      if (state === 'outcome_unknown' || state === 'receiving') return result('remote_unknown', observing, observing ? 'COMFY_REMOTE_OBSERVING' : 'IMAGE_OUTCOME_UNKNOWN');
      if (state === 'local_result_error' || state === 'interrupted' || state === 'interrupted_before_dispatch')
        return result(row.receipt ? 'result_pending' : 'waiting_user', false, errorCode);
      value = ['queued', 'dispatching', 'running', 'cancelling', 'persisting'].includes(state)
        ? result(state === 'persisting' ? 'result_pending' : 'running', true) : result('waiting_user', false, 'BACKGROUND_TASK_INVALID');
    }
    // A paused Mio run still observes an already accepted provider task. The
    // original worker keeps its queued/POST and target-write authorization;
    // projection must not reuse that dispatch gate to block poll or reconcile.
    const dispatchGated = ref.kind !== 'job' || state === 'queued';
    const denied = value.keepAlive && dispatchGated ? effectReason(ref) : null;
    return denied ? result('waiting_user', false, denied) : value;
  }
  function read(ref: BackgroundTaskRef): TaskProjection {
    const blocked = paused.get(key(ref));
    if (blocked) return projection(ref, 'waiting_user', false, blocked, cache.get(key(ref))?.taskRevision);
    return classify(ref, db.prepare(`SELECT ${columns(ref.kind)} FROM ${tables[ref.kind]} WHERE id=? LIMIT 1`).get(ref.taskId));
  }
  const snapshot = (): readonly TaskProjection[] => Object.freeze([...cache.values()]);
  const preview = (refs: readonly BackgroundTaskRef[]): readonly TaskProjection[] => {
    const candidates = new Map(cache);
    for (const ref of refs) {
      const row = db.prepare(`SELECT ${columns(ref.kind)} FROM ${tables[ref.kind]} WHERE id=? LIMIT 1`).get(ref.taskId);
      // The raw autocommit put has not inserted a new identity yet. Reserve a
      // possible pending identity, without pretending it was already accepted.
      const value = !row && !db.isTransaction ? projection(ref, 'waiting_user', false, 'BACKGROUND_TASK_ADMISSION_PENDING', 0) : classify(ref, row);
      candidates.set(key(ref), value);
    }
    return Object.freeze([...candidates.values()]);
  };
  function notify(): void {
    const value = snapshot(), errors: unknown[] = [];
    for (const listener of [...listeners]) try {listener(value);} catch (error) {errors.push(error);}
    if (errors.length) throw new AggregateError(errors, 'Background state listener failed');
  }
  function trim(): void {
    const terminal = [...cache].filter(([, value]) => value.classification === 'terminal');
    for (const [entry] of terminal.slice(0, Math.max(0, terminal.length - PROJECT_LIMIT))) cache.delete(entry);
  }
  const refresh = (refs: readonly BackgroundTaskRef[] = [...cache.values()]): void => {
    if (disposed) return;
    let changed = false;
    const targets = new Map(refs.map(ref => [key(ref), ref]));
    for (const ref of refs) if (ref.kind === 'image_task') {
      for (const row of db.prepare(`SELECT DISTINCT i.batchId FROM subject_variant_items i JOIN image_tasks t ON t.requestId=i.imageRequestId AND t.projectId=i.projectId
        WHERE t.id=? AND i.projectId=? LIMIT 2`).all(ref.taskId, store.projectId)) {
        if (typeof row.batchId === 'string') {const batch = {kind: 'subject_variant_batch' as const, taskId: row.batchId}; targets.set(key(batch), batch);}
      }
    }
    for (const ref of targets.values()) {
      const value = read(ref), old = cache.get(key(ref));
      if (!old || JSON.stringify(old) !== JSON.stringify(value)) {cache.set(key(ref), value); changed = true;}
    }
    trim();
    if (changed) notify();
  };
  for (const [kind, table] of Object.entries(tables) as [BackgroundTaskKind, string][]) {
    const unfinished = kind === 'job' ? `CASE WHEN json_valid(data) THEN
      COALESCE(json_extract(data,'$.status'),'invalid') NOT IN ('succeeded','failed','cancelled') OR
      (json_extract(data,'$.status')='cancelled' AND json_extract(data,'$.cancelScope')='local_only' AND
        (json_extract(data,'$.providerJobId') IS NOT NULL OR COALESCE(json_extract(data,'$.submissionCount'),0)>0)) ELSE 1 END`
      : kind === 'export' ? "COALESCE(CASE WHEN json_valid(data) THEN json_extract(data,'$.status') END,'invalid') NOT IN ('succeeded','failed','cancelled')"
        : kind === 'edit_task' ? "status NOT IN ('applied','not_applied')"
          : kind === 'subject_variant_batch' ? `state='active' AND EXISTS(SELECT 1 FROM subject_variant_items i LEFT JOIN image_tasks t
            ON t.requestId=i.imageRequestId AND t.projectId=i.projectId WHERE i.batchId=subject_variant_batches.id AND i.projectId=subject_variant_batches.projectId
            AND i.versionId IS NULL AND (t.id IS NULL OR t.state NOT IN ('failed','cancelled_before_dispatch')))`
            : "state NOT IN ('succeeded','failed','cancelled','cancelled_before_start','cancelled_before_dispatch','undone')";
    const rows = db.prepare(`SELECT ${columns(kind)} FROM ${table} WHERE ${unfinished} ORDER BY id LIMIT ${PROJECT_LIMIT + 1}`).all();
    // Do not let malformed candidates that classify as terminal consume this
    // bounded page and silently hide later genuine unfinished identities.
    if (rows.length > PROJECT_LIMIT) throw new AppError('BACKGROUND_TASK_INDEX_LIMIT', '项目未结束的后台任务超过索引容量，记录保持不变。', 507);
    for (const row of rows) {
      const ref = {kind, taskId: String(row.id)}, value = classify(ref, row);
      if (value.classification !== 'terminal') cache.set(key(ref), value);
    }
    if (cache.size > PROJECT_LIMIT) throw new AppError('BACKGROUND_TASK_INDEX_LIMIT', '项目未结束的后台任务超过索引容量，记录保持不变。', 507);
  }
  const unsubscribe = subscribeBackgroundTaskChanges(db, refs => {
    // A successful explicit recovery/terminal write can retire a pause. A due
    // metadata refresh alone cannot prove the unavailable owner recovered.
    for (const ref of refs) paused.delete(key(ref));
    refresh(refs);
  });
  const unbindAdmission = subscribeBackgroundTaskAdmission(db, refs => {
    const count = preview(refs).filter(task => task.classification !== 'terminal').length;
    if (count > PROJECT_LIMIT) throw new AppError('BACKGROUND_TASK_INDEX_LIMIT', '项目未结束的后台任务超过索引容量，记录保持不变。', 507);
  });
  const unbindUncertainty = subscribeBackgroundTaskUncertainty(db, refs => {
    const errors: unknown[] = [];
    for (const ref of refs) if (cache.get(key(ref))?.classification !== 'terminal') try {instances.get(db)?.pause(ref, 'BACKGROUND_TASK_INDEX_UNCERTAIN');} catch (error) {errors.push(error);}
    if (errors.length) throw new AggregateError(errors, 'Background task uncertainty notification failed');
  });
  const state: ProjectBackgroundState = {snapshot, preview, refresh,
    subscribe: listener => {listeners.add(listener); return () => {listeners.delete(listener);};},
    dispose: () => {if (disposed) return; disposed = true; unsubscribe(); unbindAdmission(); unbindUncertainty(); listeners.clear(); cache.clear(); paused.clear(); instances.delete(db);},
  };
  instances.set(db, {store, project: lstatSync(store.projectFile, {bigint: true}), directory: lstatSync(store.projectDir, {bigint: true}), state, pause: (ref, reason) => {
    if (paused.get(key(ref)) === reason || cache.get(key(ref))?.classification === 'terminal') return;
    paused.set(key(ref), reason); refresh([ref]);
  }});
  return state;
}
