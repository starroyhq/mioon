import { message as localizedMessage } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { isMutationOperation, pendingForProject, prepareSubmission, readPending } from './submissions.ts';
import type { PendingEntry } from './submissions.ts';
import { isLocalMutationResponse } from '@mioon/contracts';

export { isMutationOperation };
export interface MutationSnapshot {
  readonly project?: {readonly id?: unknown; readonly [key: string]: unknown}|null;
  readonly assets?: readonly {readonly id?: unknown; readonly projectId?: unknown; readonly [key: string]: unknown}[];
  readonly shots?: readonly {readonly id?: unknown; readonly projectId?: unknown; readonly [key: string]: unknown}[];
  readonly nodes?: readonly {readonly id?: unknown; readonly projectId?: unknown; readonly [key: string]: unknown}[];
  readonly [key: string]: unknown;
}
export interface MutationEntry extends PendingEntry {readonly input: PendingEntry['input'] & {readonly assetId?: unknown; readonly shotId?: unknown; readonly nodeId?: unknown; readonly requestId?: unknown}}
export interface PrepareMutationOptions {replay?: boolean; requestId?: ()=>string}
export interface MutationError extends Error {code: string; displayMessage?: DisplayMessage}
const failure=(code: string,message: string,displayMessage?: DisplayMessage): MutationError => Object.assign(new Error(message), { code, ...(displayMessage?{displayMessage}:{}) });
const isRecord=(value: unknown): value is Record<string, unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const property=(value: unknown,key: string): unknown=>isRecord(value)?value[key]:undefined;
const canonical=(value: unknown): string=>JSON.stringify(value, (_: string,item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item) as string;

export function assertMutationOwner(entry: MutationEntry,snapshot: MutationSnapshot|null|undefined): void {
  const projectId = entry.projectId;
  const assetMutation = ['asset.range.set', 'asset.disposition.set', 'asset.annotation.set'].includes(entry.operation);
  const target = assetMutation ? entry.input.assetId : entry.input.shotId || entry.input.nodeId;
  const records = assetMutation ? snapshot?.assets : entry.input.nodeId ? snapshot?.nodes : snapshot?.shots;
  if (!projectId || snapshot?.project?.id !== projectId || (assetMutation && !target) ||
    (entry.input.projectId !== undefined && entry.input.projectId !== projectId) ||
    (target && !records?.some(record => record.id === target && record.projectId === projectId)))
    throw failure('MUTATION_PROJECT_MISMATCH', '项目或编辑目标已变化，已阻止旧面板提交。请在当前项目重新选择目标。', localizedMessage('tasks.localError.targetChanged'));
}

// A new edit is never an implicit retry of a previous edit. In particular,
// returning an old save response to a new Inspector draft would discard text.
export function prepareMutation(entry: MutationEntry,{ replay = false, requestId = () => globalThis.crypto.randomUUID() }: PrepareMutationOptions = {}): PendingEntry {
  if (!isMutationOperation(entry.operation)) throw failure('INVALID_MUTATION', '此操作不支持编辑请求恢复。', localizedMessage('tasks.localError.unsupportedRecovery'));
  if (entry.input.projectId !== undefined && entry.input.projectId !== entry.projectId)
    throw failure('MUTATION_PROJECT_MISMATCH', '项目已变化，已阻止提交。', localizedMessage('tasks.localError.projectChanged'));
  if (replay) {
    const stored = readPending(entry.projectId, entry.key, entry);
    if (!stored || stored.operation !== entry.operation || canonical(stored.input) !== canonical(entry.input))
      throw failure('MUTATION_REPLAY_MISMATCH', '原请求记录已变化，已阻止提交。请重新打开任务面板核对。', localizedMessage('tasks.localError.replayChanged'));
    return stored;
  }
  if (pendingForProject(entry.projectId, { strict: true }).some(item => item.expectedWorkspaceOrigin === entry.expectedWorkspaceOrigin && (isMutationOperation(item.operation) || item.key === entry.key)))
    throw failure('MUTATION_PENDING', '此项目有编辑请求结果待确认。草稿仍保留；请先在任务面板恢复原请求，再提交新的修改。', localizedMessage('tasks.localError.mutationPending'));
  return prepareSubmission({ ...entry, input: { ...entry.input, requestId: entry.input.requestId || requestId() } });
}

export function mutationNotApplied(error: unknown,entry: MutationEntry|null|undefined): boolean {
  return Boolean(entry && property(error,'definitive') && property(property(error,'details'),'mutationOutcome') === 'not_applied' && property(property(error,'details'),'requestId') === entry.input.requestId);
}

// Replay acknowledges a historical response. App refreshes current project data
// separately and never installs that historical record into an Inspector draft.
export function validateMutationResponse(entry: MutationEntry,result: unknown): unknown {
  if (!isLocalMutationResponse(entry.operation, entry.input, result, { projectId: entry.projectId }))
    throw failure('BACKEND_PROTOCOL_ERROR', '未收到有效的编辑确认。原请求已保留，请在任务面板恢复同一请求。', localizedMessage('tasks.localError.mutationProtocol'));
  return result;
}
