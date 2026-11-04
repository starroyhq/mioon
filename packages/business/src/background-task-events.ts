import type {DatabaseSync} from 'node:sqlite';
import {AppError} from '../../contracts/src/app-error.ts';

/** A real COMMIT already happened. Never translate this into domain failure or
 * nonacceptance, and never use it as permission to repeat a remote submission. */
export function isBackgroundTaskIndexUncertain(error: unknown): error is AppError {
  return error instanceof AppError && error.code === 'BACKGROUND_TASK_INDEX_UNCERTAIN' && error.status === 503
    && error.details !== null && typeof error.details === 'object'
    && (error.details as {mutationOutcome?: unknown}).mutationOutcome === 'unknown';
}
export function safeBackgroundTaskIndexError(error: unknown): {code: string; message: string; status: number; details: Record<string, unknown>} | null {
  if (!isBackgroundTaskIndexUncertain(error)) return null;
  const projectId = (error.details as {projectId?: unknown}).projectId;
  return {code: error.code, message: '任务已经记录，但后台索引尚未确认。请重新打开项目检查，不要重复提交生成。', status: 503,
    details: {mutationOutcome: 'unknown', ...(typeof projectId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(projectId) ? {projectId} : {})}};
}

export type BackgroundTaskKind = 'job' | 'export' | 'edit_task' | 'image_task' | 'frame_task' | 'scene_task' | 'subject_variant_batch';
export interface BackgroundTaskRef {readonly kind: BackgroundTaskKind; readonly taskId: string}
type Listener = (changes: readonly BackgroundTaskRef[]) => void;
interface Events {readonly pending: Map<string, BackgroundTaskRef>; readonly listeners: Set<Listener>; readonly admissions: Set<Listener>; readonly uncertainties: Set<Listener>; flushing: boolean}
const registrations = new WeakMap<DatabaseSync, Events>();
const registration = (db: DatabaseSync): Events => {
  let value = registrations.get(db);
  if (!value) {value = {pending: new Map(), listeners: new Set(), admissions: new Set(), uncertainties: new Set(), flushing: false}; registrations.set(db, value);}
  return value;
};

/** Successful task writes only mark fixed identities. A store transaction
 * flushes these after its real COMMIT, or discards them after rollback. */
export function markBackgroundTaskChanged(db: DatabaseSync, kind: BackgroundTaskKind, taskId: string): void {
  registration(db).pending.set(`${kind}:${taskId}`, Object.freeze({kind, taskId}));
  if (!db.isTransaction) flushBackgroundTaskChanges(db);
}
export function subscribeBackgroundTaskChanges(db: DatabaseSync, listener: Listener): () => void {
  const events = registration(db); events.listeners.add(listener);
  return () => {events.listeners.delete(listener);};
}
/** The source COMMIT succeeded but synchronous discovery did not. An owner
 * can stop imaginary continuation leases without rewriting the source row. */
export function subscribeBackgroundTaskUncertainty(db: DatabaseSync, listener: Listener): () => void {
  const events = registration(db); events.uncertainties.add(listener);
  return () => {events.uncertainties.delete(listener);};
}
/** Read-only capacity admission, separate from durable discovery. A rejected
 * project transaction still rolls back normally and publishes no notification. */
export function subscribeBackgroundTaskAdmission(db: DatabaseSync, validator: Listener): () => void {
  const events = registration(db); events.admissions.add(validator);
  return () => {events.admissions.delete(validator);};
}
export function validateBackgroundTaskAdmission(db: DatabaseSync, refs: readonly BackgroundTaskRef[]): void {
  for (const validate of registrations.get(db)?.admissions ?? []) validate(refs);
}
export function validateBackgroundTaskChanges(db: DatabaseSync): void {
  const events = registrations.get(db);
  if (events?.pending.size) validateBackgroundTaskAdmission(db, [...events.pending.values()]);
}
export function flushBackgroundTaskChanges(db: DatabaseSync): void {
  if (db.isTransaction) throw new TypeError('Background notifications require a committed transaction');
  const events = registrations.get(db);
  if (!events || events.flushing || events.pending.size === 0) return;
  events.flushing = true;
  const errors: unknown[] = [], affected = new Map<string, BackgroundTaskRef>();
  try {
    while (events.pending.size) {
      const changes = Object.freeze([...events.pending.values()]); events.pending.clear();
      for (const ref of changes) affected.set(`${ref.kind}:${ref.taskId}`, ref);
      for (const listener of [...events.listeners]) try {listener(changes);} catch (error) {errors.push(error);}
    }
    if (errors.length) for (const listener of [...events.uncertainties]) try {listener(Object.freeze([...affected.values()]));} catch (error) {errors.push(error);}
  } finally {events.flushing = false;}
  if (errors.length) throw new AggregateError(errors, 'Committed background task notification failed');
}
export function discardBackgroundTaskChanges(db: DatabaseSync): void {registrations.get(db)?.pending.clear();}
export function closeBackgroundTaskEvents(db: DatabaseSync): void {registrations.delete(db);}
