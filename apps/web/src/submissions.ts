import { message as localizedMessage } from '../../../packages/i18n/src/index.ts';
import { workspacePendingKey, workspaceIntentDisposition, sameWorkspaceIntent, removeExactWorkspacePending } from './workspace-origin.ts';
import { migratePendingStorage } from './storage-migration.ts';
import { LOCAL_MUTATION_OPERATIONS, TIMELINE_MUTATION_OPERATIONS, isSubjectReference, isSubjectGenerationResponse, isSubjectGenerationRetryResponse, getSubjectGenerationSnapshotIssue } from '@mioon/contracts';
// A lost HTTP response is not proof that the server rejected a paid request.
// Preserve the exact operation and input until a verified response or matching
// durable job/export establishes the outcome. Never re-key it.
const PREFIX = 'mioon.pending.v1:';
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const isMutationOperation = operation => LOCAL_MUTATION_OPERATIONS.includes(operation);
function storageKey(projectId, key, options = {}) { return workspacePendingKey(projectId, key, options.expectedWorkspaceOrigin); }
export function readPending(projectId, key, options = {}) {
  migratePendingStorage();
  const raw = sessionStorage.getItem(storageKey(projectId, key, options));
  if (!raw) return null;
  const entry = JSON.parse(raw);
  if (!entry.input?.requestId || !(isMutationOperation(entry.operation) || ['generation.submit', 'job.retry', 'export.create', 'reference.attach', 'reference.detach'].includes(entry.operation) || TIMELINE_MUTATION_OPERATIONS.includes(entry.operation)) || entry.projectId !== projectId || entry.key !== key || entry.expectedWorkspaceOrigin !== options.expectedWorkspaceOrigin) throw Object.assign(new Error('待确认请求记录损坏。为防止重复提交，请先核实服务器任务。'), { displayMessage: localizedMessage('tasks.localError.pendingCorrupt') });
  return entry;
}
export function writePending(entry) {
  migratePendingStorage();
  try { sessionStorage.setItem(storageKey(entry.projectId, entry.key, entry), JSON.stringify(entry)); }
  catch { throw Object.assign(new Error('浏览器无法保存请求恢复记录。请允许此站点使用会话存储后再提交。'), { displayMessage: localizedMessage('tasks.localError.pendingStorage') }); }
}
export function prepareSubmission(entry, { replay = false } = {}) {
  const existing = readPending(entry.projectId, entry.key, entry);
  if (existing) {
    if (entry.expectedWorkspaceOrigin !== undefined && (!replay || existing.operation !== entry.operation || canonical(existing.input) !== canonical(entry.input)))
      throw Object.assign(new Error('当前恢复分支有原请求待确认，请在任务中心核对同一请求。'), { code: 'MUTATION_PENDING', displayMessage: localizedMessage('tasks.localError.restoredPending') });
    assertSubjectPending(existing); return existing;
  }
  assertSubjectPending(entry);
  writePending(entry);
  // Verify persistence before the caller is allowed to perform the side effect.
  const persisted = readPending(entry.projectId, entry.key, entry);
  if (!persisted) throw Object.assign(new Error('请求恢复记录未能保存，已阻止提交。'), { displayMessage: localizedMessage('tasks.localError.pendingNotSaved') });
  return persisted;
}
// This renderer-only pin is saved alongside, never added to the wire input.
// An immutable version ID selects the source on the server; the complete pin
// also proves an acknowledgement matches the exact image reviewed in this UI.
function assertSubjectPending(entry) {
  if (isSubjectRetryPending(entry)) {
    const reference = entry.expectedSubjectReference, snapshot = entry.expectedRetrySnapshot;
    if (entry.subjectRetry !== true || !isSubjectReference(reference) || reference.subjectVersion.projectId !== entry.projectId ||
      getSubjectGenerationSnapshotIssue(snapshot, { projectId: entry.projectId, requireProfilePin: true }) ||
      canonical(snapshot.subjectReference) !== canonical(reference))
      throw Object.assign(new Error('主体重试的原始快照记录不完整。请先核对原任务，不会重建请求或重新选择图片。'), { code: 'SUBJECT_SUBMISSION_MISMATCH', displayMessage: localizedMessage('tasks.localError.subjectRetryPin') });
    return;
  }
  if (entry.operation !== 'generation.submit' || !Object.hasOwn(entry.input ?? {}, 'subjectVersionId')) return;
  const reference = entry.expectedSubjectReference;
  if (!isSubjectReference(reference) || reference.subjectVersionId !== entry.input.subjectVersionId || reference.subjectVersion.projectId !== entry.projectId)
    throw Object.assign(new Error('主体参考的原始确认记录不完整。请先核对原任务，不会生成新的提交编号。'), { code: 'SUBJECT_SUBMISSION_MISMATCH', displayMessage: localizedMessage('tasks.localError.subjectPin') });
}
const subjectClaim = snapshot => snapshot && typeof snapshot === 'object' && (Object.hasOwn(snapshot, 'subjectReference') || Object.hasOwn(snapshot, 'subjectVersionId') ||
  ['referenceAssets', 'referenceBindings'].some(field => Array.isArray(snapshot[field]) && snapshot[field].some(item => item?.role === 'subject_reference')));
// Read data may show that proof is required, but must never reconstruct that
// proof or change the exact intent saved before the original request.
export const isSubjectRetryPending = (entry, jobs = []) => entry.operation === 'job.retry' && (entry.subjectRetry === true ||
  Object.hasOwn(entry, 'expectedSubjectReference') || Object.hasOwn(entry, 'expectedRetrySnapshot') || jobs.some(job => job?.projectId === entry.projectId &&
    (job.id === entry.input?.jobId || job.requestId === entry.input?.requestId && job.retryOfJobId === entry.input?.jobId) && subjectClaim(job.snapshot)));
// Tasks recovery is read-only until the original receipt is found and matched.
// An obsolete callback must never create a replacement receipt or change owners.
export function prepareRequestReplay(entry) {
  const stored = readPending(entry.projectId, entry.key, entry);
  if (!stored || stored.operation !== entry.operation || stored.input.projectId !== entry.projectId ||
    entry.input.projectId !== entry.projectId || canonical(stored.input) !== canonical(entry.input))
    throw Object.assign(new Error('原请求记录已变化或不再可用，已阻止恢复。请重新打开原项目的任务面板核对。'), { code: 'MUTATION_REPLAY_MISMATCH', displayMessage: localizedMessage('tasks.localError.replayUnavailable') });
  return stored;
}
export function clearPending(projectId, key, expected) {
  migratePendingStorage();
  const selected = storageKey(projectId, key, expected);
  if (expected) {
    if (expected.projectId !== projectId || expected.key !== key ||
        !['projectId', 'key', 'operation', 'input'].every(field => Object.hasOwn(expected, field))) return false;
    const raw = sessionStorage.getItem(selected);
    if (raw === null) return false;
    let current;
    try { current = JSON.parse(raw); } catch { return false; }
    // Migration preserves legacy JSON whitespace and property order. Compare
    // the complete retained intent, then CAS the exact bytes just observed;
    // never rewrite storage or let a stale ACK remove a replacement request.
    if (!current || typeof current !== 'object' || Array.isArray(current) ||
        !current.input || typeof current.input !== 'object' || Array.isArray(current.input) ||
        typeof current.input.requestId !== 'string' || !current.input.requestId ||
        !(isMutationOperation(current.operation) || ['generation.submit', 'job.retry', 'export.create', 'reference.attach', 'reference.detach'].includes(current.operation) || TIMELINE_MUTATION_OPERATIONS.includes(current.operation)) ||
        Object.hasOwn(current, 'expectedWorkspaceOrigin') !== Object.hasOwn(expected, 'expectedWorkspaceOrigin') ||
        Object.hasOwn(expected, 'expectedWorkspaceOrigin') && expected.expectedWorkspaceOrigin === undefined) return false;
    try { if (!sameWorkspaceIntent(current, expected)) return false; } catch { return false; }
    return removeExactWorkspacePending(sessionStorage, selected, raw);
  }
  sessionStorage.removeItem(selected); return true;
}
export function pendingForProject(projectId, { strict = false, workspace, activeOnly = false } = {}) {
  migratePendingStorage();
  const result = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    const restoredPrefix = 'mioon.pending.restore.v1:';
    const restoredSuffix = key?.startsWith(restoredPrefix) ? key.slice(restoredPrefix.length) : '';
    const restoredOwner = restoredSuffix.slice(restoredSuffix.indexOf(':') + 1);
    if (!key?.startsWith(`${PREFIX}${projectId}:`) && !restoredOwner.startsWith(`${projectId}:`)) continue;
    try {
      const raw = JSON.parse(sessionStorage.getItem(key));
      // Validate the enumerated slot before following entry.key. Corrupted
      // metadata must not redirect a strict scan to another (possibly empty) slot.
      if (raw?.projectId !== projectId || storageKey(projectId, raw?.key, raw || {}) !== key)
        throw Object.assign(new Error('待确认请求记录损坏。为防止重复提交，请先核实服务器任务。'), { displayMessage: localizedMessage('tasks.localError.pendingCorrupt') });
      const entry = strict ? readPending(projectId, raw.key, raw) : raw;
      if (entry?.input?.requestId && storageKey(projectId, entry.key, entry) === key &&
        (!activeOnly || !workspaceIntentDisposition(entry, workspace).held)) result.push(entry);
    } catch (error) { if (strict) throw error; /* Original bytes and request IDs remain untouched. */ }
  }
  return result;
}
export function reconcilePending(projectId, data, { workspace } = {}) {
  const jobIds = new Set((data.jobs || []).map(record => record.requestId));
  const exportIds = new Set((data.exports || []).map(record => record.requestId));
  for (const entry of pendingForProject(projectId)) {
    if (workspace && workspaceIntentDisposition(entry, workspace).held) continue;
    if (workspace?.restored && data.restore?.workspaceOrigin !== workspace.workspaceOrigin) continue;
    if (isSubjectRetryPending(entry, data.jobs || [])) {
      const matches = (data.jobs || []).filter(record => record?.requestId === entry.input.requestId);
      if (entry.subjectRetry === true && matches.length === 1 && isSubjectReference(entry.expectedSubjectReference) && entry.expectedRetrySnapshot &&
        isSubjectGenerationRetryResponse(entry.input, matches[0], { projectId, subjectReference: entry.expectedSubjectReference, snapshot: entry.expectedRetrySnapshot }))
        clearPending(projectId, entry.key, entry);
      continue;
    }
    if (entry.operation === 'generation.submit' && Object.hasOwn(entry.input ?? {}, 'subjectVersionId')) {
      const matches = (data.jobs || []).filter(record => record?.requestId === entry.input.requestId);
      // A coincident ID, partial record, changed source or duplicate observation
      // cannot clear the original key. Never infer its pin from current heads.
      if (matches.length === 1 && isSubjectReference(entry.expectedSubjectReference) &&
        isSubjectGenerationResponse(entry.operation, entry.input, matches[0], { projectId, subjectReference: entry.expectedSubjectReference }))
        clearPending(projectId, entry.key, entry);
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
    const knownIds = ['generation.submit', 'job.retry'].includes(entry.operation) ? jobIds : entry.operation === 'export.create' ? exportIds : null;
    if (knownIds?.has(entry.input.requestId)) clearPending(projectId, entry.key, entry);
  }
}
