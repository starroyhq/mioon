import { isMutationOperation, pendingForProject, prepareSubmission, readPending } from './submissions.js';
import { isLocalMutationResponse } from '@mioon/contracts';

export { isMutationOperation };
const failure = (code, message) => Object.assign(new Error(message), { code });
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export function assertMutationOwner(entry, snapshot) {
  const projectId = entry.projectId;
  const assetMutation = ['asset.range.set', 'asset.disposition.set'].includes(entry.operation);
  const target = assetMutation ? entry.input.assetId : entry.input.shotId || entry.input.nodeId;
  const records = assetMutation ? snapshot?.assets : entry.input.nodeId ? snapshot?.nodes : snapshot?.shots;
  if (!projectId || snapshot?.project?.id !== projectId || (assetMutation && !target) ||
    (entry.input.projectId !== undefined && entry.input.projectId !== projectId) ||
    (target && !records?.some(record => record.id === target && record.projectId === projectId)))
    throw failure('MUTATION_PROJECT_MISMATCH', '项目或编辑目标已变化，已阻止旧面板提交。请在当前项目重新选择目标。');
}

// A new edit is never an implicit retry of a previous edit. In particular,
// returning an old save response to a new Inspector draft would discard text.
export function prepareMutation(entry, { replay = false, requestId = () => globalThis.crypto.randomUUID() } = {}) {
  if (!isMutationOperation(entry.operation)) throw failure('INVALID_MUTATION', '此操作不支持编辑请求恢复。');
  if (entry.input.projectId !== undefined && entry.input.projectId !== entry.projectId)
    throw failure('MUTATION_PROJECT_MISMATCH', '项目已变化，已阻止提交。');
  if (replay) {
    const stored = readPending(entry.projectId, entry.key);
    if (!stored || stored.operation !== entry.operation || canonical(stored.input) !== canonical(entry.input))
      throw failure('MUTATION_REPLAY_MISMATCH', '原请求记录已变化，已阻止提交。请重新打开任务面板核对。');
    return stored;
  }
  if (pendingForProject(entry.projectId, { strict: true }).some(item => isMutationOperation(item.operation) || item.key === entry.key))
    throw failure('MUTATION_PENDING', '此项目有编辑请求结果待确认。草稿仍保留；请先在任务面板恢复原请求，再提交新的修改。');
  return prepareSubmission({ ...entry, input: { ...entry.input, requestId: entry.input.requestId || requestId() } });
}

export function mutationNotApplied(error, entry) {
  return Boolean(entry && error?.definitive && error.details?.mutationOutcome === 'not_applied' && error.details.requestId === entry.input.requestId);
}

// Replay acknowledges a historical response. App refreshes current project data
// separately and never installs that historical record into an Inspector draft.
export function validateMutationResponse(entry, result) {
  if (!isLocalMutationResponse(entry.operation, entry.input, result, { projectId: entry.projectId }))
    throw failure('BACKEND_PROTOCOL_ERROR', '未收到有效的编辑确认。原请求已保留，请在任务面板恢复同一请求。');
  return result;
}
