// A lost HTTP response is not proof that the server rejected a paid request.
// Preserve the exact operation and input until a definite response or a durable
// job/export with the same request ID establishes the outcome. Never re-key it.
const PREFIX = 'frame.pending.v1:';
function storageKey(projectId, key) { return `${PREFIX}${projectId}:${key}`; }
export function readPending(projectId, key) {
  const raw = sessionStorage.getItem(storageKey(projectId, key));
  if (!raw) return null;
  const entry = JSON.parse(raw);
  if (!entry.input?.requestId || !(['generation.submit', 'job.retry', 'export.create'].includes(entry.operation) || /^timeline\.(track\.(add|update)|clip\.(add|update|remove)|seed|render)$/.test(entry.operation)) || entry.projectId !== projectId || entry.key !== key) throw new Error('待确认请求记录损坏。为防止重复提交，请先核实服务器任务。');
  return entry;
}
export function writePending(entry) {
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
export function clearPending(projectId, key) { sessionStorage.removeItem(storageKey(projectId, key)); }
export function pendingForProject(projectId) {
  const result = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (!key?.startsWith(`${PREFIX}${projectId}:`)) continue;
    try { const entry = JSON.parse(sessionStorage.getItem(key)); if (entry?.input?.requestId) result.push(entry); } catch { /* Do not discard corrupted records or replace their request IDs. */ }
  }
  return result;
}
export function reconcilePending(projectId, data) {
  const knownIds = new Set([...(data.jobs || []), ...(data.exports || [])].map(r => r.requestId));
  for (const entry of pendingForProject(projectId)) if (knownIds.has(entry.input.requestId)) clearPending(projectId, entry.key);
}
