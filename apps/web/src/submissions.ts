import { isLocale, message as localizedMessage } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage, Locale } from '../../../packages/i18n/src/index.ts';
import { pendingStorageKey, samePendingIntent, removeExactPending } from './pending-request.ts';
import { migratePendingStorage } from './storage-migration.ts';
import { isGenerationAspectResponse } from '../../../packages/contracts/src/generation-aspect.ts';
import { DURABLE_EDIT_OPERATIONS, LOCAL_MUTATION_OPERATIONS, TIMELINE_MUTATION_OPERATIONS, isSubjectReference, isSubjectGenerationResponse, isSubjectGenerationRetryResponse, getSubjectGenerationSnapshotIssue } from '@mioon/contracts';
// A lost HTTP response is not proof that the server rejected a paid request.
// Preserve the exact operation and input until a verified response or matching
// durable job/export establishes the outcome. Never re-key it.
const PREFIX = 'mioon.pending.v1:';
export interface PendingInput {
  requestId?: unknown;
  projectId?: unknown;
  subjectVersionId?: unknown;
  jobId?: unknown;
  [key: string]: unknown;
}
export interface PendingEntry extends Record<string, unknown> {
  projectId: string;
  key: string;
  operation: string;
  input: PendingInput;
  outputLocale?: Locale;
  subjectRetry?: unknown;
  expectedSubjectReference?: unknown;
  expectedRetrySnapshot?: unknown;
}
export interface PendingForProjectOptions {strict?: boolean}
export interface PendingData {
  readonly jobs?: unknown;
  readonly exports?: unknown;
  readonly [key: string]: unknown;
}
/** Immutable server evidence a lost response may still be matched against.
 * `editTasks` only carries the project's not-yet-acknowledged edit tasks
 * (pending-only pages include applied/not_applied tasks); `requestOutcomes` is
 * keyed by the retained request ID and comes from the read-only receipt route. */
export interface PendingEvidence {
  readonly editTasks?: readonly unknown[];
  readonly requestOutcomes?: ReadonlyMap<string,{readonly applied: boolean;readonly operation: string|null}>;
}
export type PendingVerdict = 'applied'|'not_applied'|'unknown';
export type PendingError=Error&{code?: string; displayMessage?: DisplayMessage};
const isRecord=(value: unknown): value is Record<string, unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const property=(value: unknown,key: string): unknown=>isRecord(value)?value[key]:undefined;
const canonical=(value: unknown): string=>JSON.stringify(value, (_, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item) as string;
const includesString=(list: readonly string[],value: unknown): boolean=>typeof value==='string'&&(list as readonly string[]).includes(value);
const rows=(value: unknown): unknown[]=>Array.isArray(value)?value:[];
const pendingError=(message: string,displayMessage: DisplayMessage,code?: string): PendingError=>Object.assign(new Error(message), { displayMessage, ...(code?{code}:{}) });
const parseEntry=(raw: string|null): unknown=>{ try { return raw===null?null:JSON.parse(raw) as unknown; } catch { return undefined; } };
export const isMutationOperation=(operation: unknown): boolean=>includesString(LOCAL_MUTATION_OPERATIONS,operation);
function storageKey(projectId: string,key: string): string { return pendingStorageKey(projectId, key); }
export function readPending(projectId: string,key: string): PendingEntry | null {
  migratePendingStorage();
  const raw = sessionStorage.getItem(storageKey(projectId, key));
  if (!raw) return null;
  const entry: unknown = JSON.parse(raw);
  if (!isRecord(entry) || !isRecord(entry.input) || !entry.input.requestId || !(isMutationOperation(entry.operation) || ['generation.submit', 'job.retry', 'export.create', 'reference.attach', 'reference.detach'].includes(String(entry.operation)) || includesString(TIMELINE_MUTATION_OPERATIONS,entry.operation)) || entry.projectId !== projectId || entry.key !== key || entry.outputLocale !== undefined && !isLocale(entry.outputLocale)) throw pendingError('待确认请求记录损坏。为防止重复提交，请先核实服务器任务。', localizedMessage('tasks.localError.pendingCorrupt'));
  return entry as unknown as PendingEntry;
}
export function writePending(entry: PendingEntry): void {
  migratePendingStorage();
  try { sessionStorage.setItem(storageKey(entry.projectId, entry.key), JSON.stringify(entry)); }
  catch { throw pendingError('浏览器无法保存请求恢复记录。请允许此站点使用会话存储后再提交。', localizedMessage('tasks.localError.pendingStorage')); }
}
export function prepareSubmission(entry: PendingEntry): PendingEntry {
  const existing = readPending(entry.projectId, entry.key);
  if (existing) {
    assertSubjectPending(existing); return existing;
  }
  assertSubjectPending(entry);
  writePending(entry);
  // Verify persistence before the caller is allowed to perform the side effect.
  const persisted = readPending(entry.projectId, entry.key);
  if (!persisted) throw pendingError('请求恢复记录未能保存，已阻止提交。', localizedMessage('tasks.localError.pendingNotSaved'));
  return persisted;
}
// This renderer-only pin is saved alongside, never added to the wire input.
// An immutable version ID selects the source on the server; the complete pin
// also proves an acknowledgement matches the exact image reviewed in this UI.
function assertSubjectPending(entry: PendingEntry): void {
  if (isSubjectRetryPending(entry)) {
    const reference = entry.expectedSubjectReference, snapshot = entry.expectedRetrySnapshot;
    if (entry.subjectRetry !== true || !isSubjectReference(reference) || reference.subjectVersion.projectId !== entry.projectId ||
      getSubjectGenerationSnapshotIssue(snapshot, { projectId: entry.projectId, requireProfilePin: true }) ||
      canonical(property(snapshot,'subjectReference')) !== canonical(reference))
      throw pendingError('主体重试的原始快照记录不完整。请先核对原任务，不会重建请求或重新选择图片。', localizedMessage('tasks.localError.subjectRetryPin'), 'SUBJECT_SUBMISSION_MISMATCH');
    return;
  }
  if (entry.operation !== 'generation.submit' || !Object.hasOwn(entry.input ?? {}, 'subjectVersionId')) return;
  const reference = entry.expectedSubjectReference;
  if (!isSubjectReference(reference) || reference.subjectVersionId !== entry.input.subjectVersionId || reference.subjectVersion.projectId !== entry.projectId)
    throw pendingError('主体参考的原始确认记录不完整。请先核对原任务，不会生成新的提交编号。', localizedMessage('tasks.localError.subjectPin'), 'SUBJECT_SUBMISSION_MISMATCH');
}
const subjectClaim=(snapshot: unknown): boolean=>Boolean(snapshot && typeof snapshot === 'object' && (Object.hasOwn(snapshot, 'subjectReference') || Object.hasOwn(snapshot, 'subjectVersionId') ||
  ['referenceAssets', 'referenceBindings'].some(field => Array.isArray(property(snapshot,field)) && (property(snapshot,field) as unknown[]).some(item => property(item,'role') === 'subject_reference'))));
// Read data may show that proof is required, but must never reconstruct that
// proof or change the exact intent saved before the original request.
export const isSubjectRetryPending=(entry: PendingEntry,jobs: readonly unknown[] = []): boolean=>entry.operation === 'job.retry' && (entry.subjectRetry === true ||
  Object.hasOwn(entry, 'expectedSubjectReference') || Object.hasOwn(entry, 'expectedRetrySnapshot') || jobs.some(job => property(job,'projectId') === entry.projectId &&
    (property(job,'id') === entry.input?.jobId || property(job,'requestId') === entry.input?.requestId && property(job,'retryOfJobId') === entry.input?.jobId) && subjectClaim(property(job,'snapshot'))));
// Tasks recovery is read-only until the original receipt is found and matched.
// An obsolete callback must never create a replacement receipt or change owners.
export function prepareRequestReplay(entry: PendingEntry): PendingEntry {
  const stored = readPending(entry.projectId, entry.key);
  const aspectGeneration = entry.operation === 'generation.submit' && Object.hasOwn(entry.input, 'aspectSource');
  if (!stored || stored.operation !== entry.operation || canonical(stored.input) !== canonical(entry.input) ||
    (entry.input.projectId !== entry.projectId && !(aspectGeneration && !Object.hasOwn(entry.input, 'projectId'))))
    throw pendingError('原请求记录已变化或不再可用，已阻止恢复。请重新打开原项目的任务面板核对。', localizedMessage('tasks.localError.replayUnavailable'), 'MUTATION_REPLAY_MISMATCH');
  if (aspectGeneration) assertSubjectPending(stored);
  return stored;
}
export function clearPending(projectId: string,key: string,expected?: PendingEntry|null): boolean {
  migratePendingStorage();
  const selected = storageKey(projectId, key);
  if (expected) {
    if (expected.projectId !== projectId || expected.key !== key ||
        !['projectId', 'key', 'operation', 'input'].every(field => Object.hasOwn(expected, field))) return false;
    const raw = sessionStorage.getItem(selected);
    if (raw === null) return false;
    const current: unknown = (()=>{ try { return JSON.parse(raw); } catch { return null; } })();
    // Migration preserves legacy JSON whitespace and property order. Compare
    // the complete retained intent, then CAS the exact bytes just observed;
    // never rewrite storage or let a stale ACK remove a replacement request.
    if (!isRecord(current) || !isRecord(current.input) ||
        typeof current.input.requestId !== 'string' || !current.input.requestId ||
        !(isMutationOperation(current.operation) || ['generation.submit', 'job.retry', 'export.create', 'reference.attach', 'reference.detach'].includes(String(current.operation)) || includesString(TIMELINE_MUTATION_OPERATIONS,current.operation))) return false;
    try { if (!samePendingIntent(current, expected)) return false; } catch { return false; }
    return removeExactPending(sessionStorage, selected, raw);
  }
  sessionStorage.removeItem(selected); return true;
}
export function pendingForProject(projectId: string,{ strict = false }: PendingForProjectOptions = {}): PendingEntry[] {
  migratePendingStorage();
  const result: PendingEntry[] = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if(key===null)continue;
    if (!key.startsWith(`${PREFIX}${projectId}:`)) continue;
    try {
      const raw: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
      // Validate the enumerated slot before following entry.key. Corrupted
      // metadata must not redirect a strict scan to another (possibly empty) slot.
      if (!isRecord(raw) || raw.projectId !== projectId || storageKey(projectId, String(raw.key)) !== key)
        throw pendingError('待确认请求记录损坏。为防止重复提交，请先核实服务器任务。', localizedMessage('tasks.localError.pendingCorrupt'));
      const entry: PendingEntry|null = strict ? readPending(projectId, String(raw.key)) : raw as unknown as PendingEntry;
      if (entry?.input?.requestId && storageKey(projectId, entry.key) === key) result.push(entry);
    } catch (error) { if (strict) throw error; /* Original bytes and request IDs remain untouched. */ }
  }
  return result;
}
/** Exact durable-task evidence. A status is only accepted when the task was
 * prepared from the identical operation and canonical input, so a coincident
 * request ID cannot answer for a different retained intent. */
function durableEditVerdict(entry: PendingEntry,tasks: readonly unknown[]): PendingVerdict {
  if (!includesString(DURABLE_EDIT_OPERATIONS,entry.operation)) return 'unknown';
  const requestId = entry.input.requestId;
  if (typeof requestId !== 'string') return 'unknown';
  const matches = tasks.filter(task => property(task,'projectId') === entry.projectId && property(task,'requestId') === requestId &&
    property(task,'operation') === entry.operation);
  if (matches.length !== 1) return 'unknown';
  const input = property(matches[0],'input');
  if (!isRecord(input) || canonical(input) !== canonical(entry.input)) return 'unknown';
  const status = property(matches[0],'status');
  return status === 'applied' ? 'applied' : status === 'not_applied' ? 'not_applied' : 'unknown';
}
function receiptVerdict(entry: PendingEntry,outcome: {readonly applied: boolean;readonly operation: string|null}|undefined): PendingVerdict {
  if (outcome?.applied !== true) return 'unknown';
  // An explicit operation from the receipt must name the retained operation;
  // receipts without an operation column still bind project and request ID.
  return outcome.operation === null || outcome.operation === entry.operation ? 'applied' : 'unknown';
}
/** Verdict from the new immutable evidence only. Existing jobs/exports
 * evidence keeps its own flow; this helper is for callers that need the
 * conclusion without clearing anything. */
export function pendingVerdict(entry: PendingEntry,evidence: PendingEvidence = {}): PendingVerdict {
  const durable = durableEditVerdict(entry,rows(evidence.editTasks));
  if (durable !== 'unknown') return durable;
  return receiptVerdict(entry,evidence.requestOutcomes?.get(String(entry.input.requestId)));
}
export function reconcilePending(projectId: string,data: PendingData & PendingEvidence): void {
  const jobIds = new Set(rows(data.jobs).map(record => property(record,'requestId')));
  const exportIds = new Set(rows(data.exports).map(record => property(record,'requestId')));
  const editTasks = rows(data.editTasks);
  for (const entry of pendingForProject(projectId)) {
    if (isSubjectRetryPending(entry, rows(data.jobs))) {
      const matches = rows(data.jobs).filter(record => property(record,'requestId') === entry.input.requestId);
      if (entry.subjectRetry === true && matches.length === 1 && isSubjectReference(entry.expectedSubjectReference) && entry.expectedRetrySnapshot &&
        isSubjectGenerationRetryResponse(entry.input, matches[0], { projectId, subjectReference: entry.expectedSubjectReference, snapshot: entry.expectedRetrySnapshot }))
        clearPending(projectId, entry.key, entry);
      continue;
    }
    if (entry.operation === 'generation.submit' && Object.hasOwn(entry.input ?? {}, 'subjectVersionId')) {
      const matches = rows(data.jobs).filter(record => property(record,'requestId') === entry.input.requestId);
      // A coincident ID, partial record, changed source or duplicate observation
      // cannot clear the original key. Never infer its pin from current heads.
      if (matches.length === 1 && isSubjectReference(entry.expectedSubjectReference) &&
        isSubjectGenerationResponse(entry.operation, entry.input, matches[0], { projectId, subjectReference: entry.expectedSubjectReference }))
        clearPending(projectId, entry.key, entry);
      continue;
    }
    if (entry.operation === 'generation.submit' && Object.hasOwn(entry.input, 'aspectSource')) {
      const matches = rows(data.jobs).filter(record => property(record,'requestId') === entry.input.requestId);
      if (matches.length === 1 && isGenerationAspectResponse(entry.input, matches[0], projectId)) clearPending(projectId, entry.key, entry);
      continue;
    }
    // Request IDs are scoped by operation on the server. A coincident job ID
    // cannot establish the outcome of a reference or timeline mutation.
    if (entry.operation === 'timeline.render') {
      // Even a structurally valid progressed public export cannot prove the
      // immutable receipt or current source ownership is valid. It also omits
      // private paths used by optional preflight digests. Only explicit exact
      // replay can establish this render's outcome and release its original key.
      continue;
    }
    // Durable edit tasks are the immutable acknowledgement of the dispatch:
    // an exact task prepared from this intent can conclude it, and a task that
    // reached prepared/dispatching/unknown keeps the original record.
    const durable = durableEditVerdict(entry,editTasks);
    if (durable !== 'unknown') { clearPending(projectId, entry.key, entry); continue; }
    // Older sessions may have no edit task; the immutable receipt still binds
    // the exact request ID inside this project.
    const receipt = data.requestOutcomes?.get(String(entry.input.requestId));
    if (receiptVerdict(entry,receipt) === 'applied') { clearPending(projectId, entry.key, entry); continue; }
    const knownIds: Set<unknown>|null = ['generation.submit', 'job.retry'].includes(entry.operation) ? jobIds : entry.operation === 'export.create' ? exportIds : null;
    if (knownIds?.has(entry.input.requestId)) clearPending(projectId, entry.key, entry);
  }
}
