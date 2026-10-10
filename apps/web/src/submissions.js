import { migratePendingStorage } from './storage-migration.js';
import { LOCAL_MUTATION_OPERATIONS, TIMELINE_MUTATION_OPERATIONS } from '@mioon/contracts';
// A lost HTTP response is not proof that the server rejected a paid request.
// Preserve the exact operation and input until a verified response or matching
// durable job/export establishes the outcome. Never re-key it.
const PREFIX = 'mioon.pending.v1:';
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const isMutationOperation = operation => LOCAL_MUTATION_OPERATIONS.includes(operation);
function storageKey(projectId, key) { return `${PREFIX}${projectId}:${key}`; }
export function readPending(projectId, key) {
  migratePendingStorage();
  const raw = sessionStorage.getItem(storageKey(projectId, key));
  if (!raw) return null;
  const entry = JSON.parse(raw);
  if (!entry.input?.requestId || !(isMutationOperation(entry.operation) || ['generation.submit', 'job.retry', 'export.create', 'reference.attach', 'reference.detach'].includes(entry.operation) || TIMELINE_MUTATION_OPERATIONS.includes(entry.operation)) || entry.projectId !== projectId || entry.key !== key) throw new Error('待确认请求记录损坏。为防止重复提交，请先核实服务器任务。');
  return entry;
}
export function writePending(entry) {
  migratePendingStorage();
  try { sessionStorage.setItem(storageKey(entry.projectId, entry.key), JSON.stringify(entry)); }
  catch { throw new Error('浏览器无法保存请求恢复记录。请允许此站点使用会话存储后再提交。'); }
}
export function prepareSubmission(entry) {
  const existing = readPending(entry.projectId, entry.key);
  if (existing) return existing;
  writePending(entry);
  // Verify persistence before the caller is allowed to perform the side effect.
  const persisted = readPending(entry.projectId, entry.key);
  if (!persisted) throw new Error('请求恢复记录未能保存，已阻止提交。');
  return persisted;
}
// Tasks recovery is read-only until the original receipt is found and matched.
// An obsolete callback must never create a replacement receipt or change owners.
export function prepareRequestReplay(entry) {
  const stored = readPending(entry.projectId, entry.key);
  if (!stored || stored.operation !== entry.operation || stored.input.projectId !== entry.projectId ||
    entry.input.projectId !== entry.projectId || canonical(stored.input) !== canonical(entry.input))
    throw Object.assign(new Error('原请求记录已变化或不再可用，已阻止恢复。请重新打开原项目的任务面板核对。'), { code: 'MUTATION_REPLAY_MISMATCH' });
  return stored;
}
export function clearPending(projectId, key) { migratePendingStorage(); sessionStorage.removeItem(storageKey(projectId, key)); }
export function pendingForProject(projectId, { strict = false } = {}) {
  migratePendingStorage();
  const result = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (!key?.startsWith(`${PREFIX}${projectId}:`)) continue;
    try {
      const entry = strict ? readPending(projectId, key.slice(`${PREFIX}${projectId}:`.length)) : JSON.parse(sessionStorage.getItem(key));
      if (entry?.input?.requestId) result.push(entry);
    } catch (error) { if (strict) throw error; /* Do not discard corrupted records or replace their request IDs. */ }
  }
  return result;
}
export function reconcilePending(projectId, data) {
  const jobIds = new Set((data.jobs || []).map(record => record.requestId));
  const exportIds = new Set((data.exports || []).map(record => record.requestId));
  for (const entry of pendingForProject(projectId)) {
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
    if (knownIds?.has(entry.input.requestId)) clearPending(projectId, entry.key);
  }
}
