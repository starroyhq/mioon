import { expectedWorkspaceOriginSchema, parseExpectedWorkspaceOrigin } from '@mioon/contracts';

// Workspace identity belongs to the invocation, never the immutable domain
// input or receipt. Callers pin only a newly requested action; existing pending
// intents are inspected as-is and are never upgraded after a reconnect.
export interface WorkspaceIdentity {
  readonly restored?: unknown;
  readonly workspaceOrigin?: unknown;
  readonly [key: string]: unknown;
}
export interface WorkspaceOriginOptions {readonly expectedWorkspaceOrigin?: unknown}
export interface WorkspaceIntent {readonly expectedWorkspaceOrigin?: unknown; readonly [key: string]: unknown}
export interface WorkspaceIntentHeld {readonly held: true; readonly code: string; readonly reason: string}
export interface WorkspaceIntentFree {readonly held: false}
export type WorkspaceIntentDisposition=WorkspaceIntentHeld|WorkspaceIntentFree;
export interface WorkspaceOriginState {
  generation: number;
  phase: string;
  workspace: WorkspaceIdentity | null;
  error: unknown;
}
export interface WorkspaceOriginReaderOptions {
  read: ()=>Promise<unknown>|unknown;
  validate: (value: unknown)=>boolean;
  onChange?: (state: WorkspaceOriginState)=>void;
}
export interface WorkspaceOriginReader {
  getState(): WorkspaceOriginState;
  invalidate(): void;
  inspect(): Promise<WorkspaceIdentity|null>;
  pin(intent: unknown): WorkspaceIdentity;
}
export interface WorkspaceOriginError extends Error {code: string}
const uuid=(value: unknown): boolean=>expectedWorkspaceOriginSchema.safeParse(value).success;
const isRecord=(value: unknown): value is Record<string, unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value: unknown,key: string): boolean=>isRecord(value) && Object.hasOwn(value, key);
const fail=(code: string,message: string): WorkspaceOriginError=>Object.assign(new Error(message), { code });
const canonical=(value: unknown): string=>JSON.stringify(value, (_key: string,item: unknown) => isRecord(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item) as string;
function frozenCopy<T>(value: T): T {
  const copy = structuredClone(value);
  function freeze(item: unknown): void { if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); } }
  freeze(copy);
  return copy;
}

export const WORKSPACE_ORIGIN_HELD_REASON = '此请求属于原工作区或另一个恢复分支，原编号和参数已保留；不能在当前分支恢复、确认或转存。';
export const WORKSPACE_ORIGIN_UNVERIFIED_REASON = '工作区身份尚未核对，已阻止提交。请重新载入后从当前分支明确发起新操作。';

export function workspaceOriginOptions(expectedWorkspaceOrigin: unknown): WorkspaceOriginOptions {
  if (expectedWorkspaceOrigin === undefined) return {};
  try { parseExpectedWorkspaceOrigin(expectedWorkspaceOrigin); }
  catch { throw fail('VALIDATION_ERROR', '工作区来源必须是完整 UUID，不能省略或替换已保存的来源。'); }
  return { expectedWorkspaceOrigin };
}

export function workspaceOriginScope(workspace: WorkspaceIdentity | null | undefined): string | null {
  if (workspace?.restored === false) return 'normal';
  if (workspace?.restored === true && uuid(workspace.workspaceOrigin)) return `restored:${String(workspace.workspaceOrigin)}`;
  return null;
}

// A renderer may inspect again after login/reconnect, but that observation
// cannot replace its established identity or silently enable another branch.
export function retainWorkspaceIdentity(current: WorkspaceIdentity | null | undefined, observed: unknown): WorkspaceIdentity {
  const observedScope = workspaceOriginScope(isRecord(observed)?observed as WorkspaceIdentity:null);
  if (observedScope === null) throw fail('WORKSPACE_ORIGIN_UNVERIFIED', WORKSPACE_ORIGIN_UNVERIFIED_REASON);
  if (current && workspaceOriginScope(current) !== observedScope)
    throw fail('RESTORE_WORKSPACE_ORIGIN_MISMATCH', '连接的工作区已变化，请重新载入页面。原请求和分支来源仍被保留。');
  return current || frozenCopy(observed as WorkspaceIdentity);
}

// This accepts only a fresh caller-owned intent. Supplying a pre-existing pin is
// an error, including the same pin: reuse goes through the retained-intent path.
export function pinNewWorkspaceIntent(intent: WorkspaceIntent,workspace: WorkspaceIdentity | null | undefined): WorkspaceIdentity {
  if (!isRecord(intent) || own(intent, 'expectedWorkspaceOrigin')) throw fail('WORKSPACE_INTENT_ALREADY_PINNED', '已有请求不能重新指定工作区来源。');
  const scope = workspaceOriginScope(workspace);
  if (scope === null || !workspace) throw fail('WORKSPACE_ORIGIN_UNVERIFIED', WORKSPACE_ORIGIN_UNVERIFIED_REASON);
  return frozenCopy({ ...intent, ...(workspace.restored === true ? workspaceOriginOptions(workspace.workspaceOrigin) : {}) }) as WorkspaceIdentity;
}

export function workspaceIntentDisposition(intent: unknown,workspace: WorkspaceIdentity | null | undefined): WorkspaceIntentDisposition {
  const scope = workspaceOriginScope(workspace);
  if (!isRecord(intent) || scope === null || !workspace) return { held: true, code: 'WORKSPACE_ORIGIN_UNVERIFIED', reason: WORKSPACE_ORIGIN_UNVERIFIED_REASON };
  const pinned = own(intent, 'expectedWorkspaceOrigin');
  const matches = workspace.restored === true
    ? pinned && uuid(intent.expectedWorkspaceOrigin) && intent.expectedWorkspaceOrigin === workspace.workspaceOrigin
    : !pinned;
  return matches ? { held: false } : { held: true, code: 'RESTORED_RECORD_HELD', reason: WORKSPACE_ORIGIN_HELD_REASON };
}

export function assertWorkspaceIntent(intent: unknown,workspace: WorkspaceIdentity | null | undefined): WorkspaceOriginOptions {
  const disposition = workspaceIntentDisposition(intent, workspace);
  if (disposition.held) throw fail(disposition.code, disposition.reason);
  return workspaceOriginOptions(isRecord(intent)?intent.expectedWorkspaceOrigin:undefined);
}

export function sameWorkspaceIntent(left: unknown,right: unknown): boolean {
  // Compare the complete retained intent, including original operation, input,
  // key and optional source metadata. Missing and explicit null are different.
  return isRecord(left) && isRecord(right) && canonical(left) === canonical(right);
}

// The legacy slot is never renamed, deleted or reused to make a new restored
// intent. Each branch gets a distinct slot while original entry fields survive.
export function workspacePendingKey(projectId: string,key: string,expectedWorkspaceOrigin?: unknown): string {
  const base = `mioon.pending.v1:${projectId}:${key}`;
  if (expectedWorkspaceOrigin === undefined) return base;
  workspaceOriginOptions(expectedWorkspaceOrigin);
  return `mioon.pending.restore.v1:${String(expectedWorkspaceOrigin)}:${projectId}:${key}`;
}

// A delayed/reordered success cannot remove a new record, or an old record from
// another origin. The caller must retain the exact original serialized value.
export function removeExactWorkspacePending(storage: {getItem(key: string): string|null; removeItem(key: string): void},storageKey: string,expectedRaw: unknown): boolean {
  if (typeof expectedRaw !== 'string' || storage.getItem(storageKey) !== expectedRaw) return false;
  storage.removeItem(storageKey);
  return storage.getItem(storageKey) === null;
}

// Read responses may update what the user sees, but never any existing action
// pin. The sequence fence ignores older replies after a new inspection begins.
export function createWorkspaceOriginReader({ read, validate, onChange = (): void => {} }: WorkspaceOriginReaderOptions): WorkspaceOriginReader {
  let generation = 0, workspace: WorkspaceIdentity | null = null, phase = 'idle', error: unknown = null;
  const state = (): WorkspaceOriginState => ({ generation, phase, workspace, error });
  const publish = (): void => onChange(state());
  return {
    getState: state,
    invalidate(): void { generation++; phase = 'idle'; workspace = null; error = null; publish(); },
    async inspect(): Promise<WorkspaceIdentity|null> {
      const captured = ++generation;
      phase = 'checking'; workspace = null; error = null; publish();
      try {
        const value = await read();
        if (captured !== generation) return null;
        if (!validate(value) || workspaceOriginScope(isRecord(value)?value as WorkspaceIdentity:null) === null) throw fail('BACKEND_PROTOCOL_ERROR', '工作区身份核对返回了无效数据。');
        workspace = frozenCopy(value as WorkspaceIdentity); phase = 'ready'; publish(); return workspace;
      } catch (reason) {
        if (captured !== generation) return null;
        error = reason; phase = 'error'; workspace = null; publish(); return null;
      }
    },
    pin(intent: unknown): WorkspaceIdentity { return pinNewWorkspaceIntent(intent as WorkspaceIntent, workspace); },
  };
}
