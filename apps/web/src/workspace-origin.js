import { expectedWorkspaceOriginSchema, parseExpectedWorkspaceOrigin } from '@mioon/contracts';

// Workspace identity belongs to the invocation, never the immutable domain
// input or receipt. Callers pin only a newly requested action; existing pending
// intents are inspected as-is and are never upgraded after a reconnect.
const uuid = value => expectedWorkspaceOriginSchema.safeParse(value).success;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key);
const fail = (code, message) => Object.assign(new Error(message), { code });
const canonical = value => JSON.stringify(value, (_, item) => object(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
function frozenCopy(value) {
  const copy = structuredClone(value);
  function freeze(item) { if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); } return item; }
  return freeze(copy);
}

export const WORKSPACE_ORIGIN_HELD_REASON = '此请求属于原工作区或另一个恢复分支，原编号和参数已保留；不能在当前分支恢复、确认或转存。';
export const WORKSPACE_ORIGIN_UNVERIFIED_REASON = '工作区身份尚未核对，已阻止提交。请重新载入后从当前分支明确发起新操作。';

export function workspaceOriginOptions(expectedWorkspaceOrigin) {
  if (expectedWorkspaceOrigin === undefined) return {};
  try { parseExpectedWorkspaceOrigin(expectedWorkspaceOrigin); }
  catch { throw fail('VALIDATION_ERROR', '工作区来源必须是完整 UUID，不能省略或替换已保存的来源。'); }
  return { expectedWorkspaceOrigin };
}

export function workspaceOriginScope(workspace) {
  if (workspace?.restored === false) return 'normal';
  if (workspace?.restored === true && uuid(workspace.workspaceOrigin)) return `restored:${workspace.workspaceOrigin}`;
  return null;
}

// A renderer may inspect again after login/reconnect, but that observation
// cannot replace its established identity or silently enable another branch.
export function retainWorkspaceIdentity(current, observed) {
  const observedScope = workspaceOriginScope(observed);
  if (observedScope === null) throw fail('WORKSPACE_ORIGIN_UNVERIFIED', WORKSPACE_ORIGIN_UNVERIFIED_REASON);
  if (current && workspaceOriginScope(current) !== observedScope)
    throw fail('RESTORE_WORKSPACE_ORIGIN_MISMATCH', '连接的工作区已变化，请重新载入页面。原请求和分支来源仍被保留。');
  return current || frozenCopy(observed);
}

// This accepts only a fresh caller-owned intent. Supplying a pre-existing pin is
// an error, including the same pin: reuse goes through the retained-intent path.
export function pinNewWorkspaceIntent(intent, workspace) {
  if (!object(intent) || own(intent, 'expectedWorkspaceOrigin')) throw fail('WORKSPACE_INTENT_ALREADY_PINNED', '已有请求不能重新指定工作区来源。');
  const scope = workspaceOriginScope(workspace);
  if (scope === null) throw fail('WORKSPACE_ORIGIN_UNVERIFIED', WORKSPACE_ORIGIN_UNVERIFIED_REASON);
  return frozenCopy({ ...intent, ...(workspace.restored ? workspaceOriginOptions(workspace.workspaceOrigin) : {}) });
}

export function workspaceIntentDisposition(intent, workspace) {
  const scope = workspaceOriginScope(workspace);
  if (!object(intent) || scope === null) return { held: true, code: 'WORKSPACE_ORIGIN_UNVERIFIED', reason: WORKSPACE_ORIGIN_UNVERIFIED_REASON };
  const pinned = own(intent, 'expectedWorkspaceOrigin');
  const matches = workspace.restored
    ? pinned && uuid(intent.expectedWorkspaceOrigin) && intent.expectedWorkspaceOrigin === workspace.workspaceOrigin
    : !pinned;
  return matches ? { held: false } : { held: true, code: 'RESTORED_RECORD_HELD', reason: WORKSPACE_ORIGIN_HELD_REASON };
}

export function assertWorkspaceIntent(intent, workspace) {
  const disposition = workspaceIntentDisposition(intent, workspace);
  if (disposition.held) throw fail(disposition.code, disposition.reason);
  return workspaceOriginOptions(intent.expectedWorkspaceOrigin);
}

export function sameWorkspaceIntent(left, right) {
  // Compare the complete retained intent, including original operation, input,
  // key and optional source metadata. Missing and explicit null are different.
  return object(left) && object(right) && canonical(left) === canonical(right);
}

// The legacy slot is never renamed, deleted or reused to make a new restored
// intent. Each branch gets a distinct slot while original entry fields survive.
export function workspacePendingKey(projectId, key, expectedWorkspaceOrigin) {
  const base = `mioon.pending.v1:${projectId}:${key}`;
  if (expectedWorkspaceOrigin === undefined) return base;
  workspaceOriginOptions(expectedWorkspaceOrigin);
  return `mioon.pending.restore.v1:${expectedWorkspaceOrigin}:${projectId}:${key}`;
}

// A delayed/reordered success cannot remove a new record, or an old record from
// another origin. The caller must retain the exact original serialized value.
export function removeExactWorkspacePending(storage, storageKey, expectedRaw) {
  if (typeof expectedRaw !== 'string' || storage.getItem(storageKey) !== expectedRaw) return false;
  storage.removeItem(storageKey);
  return storage.getItem(storageKey) === null;
}

// Read responses may update what the user sees, but never any existing action
// pin. The sequence fence ignores older replies after a new inspection begins.
export function createWorkspaceOriginReader({ read, validate, onChange = () => {} }) {
  let generation = 0, workspace = null, phase = 'idle', error = null;
  const state = () => ({ generation, phase, workspace, error });
  const publish = () => onChange(state());
  return {
    getState: state,
    invalidate() { generation++; phase = 'idle'; workspace = null; error = null; publish(); },
    async inspect() {
      const captured = ++generation;
      phase = 'checking'; workspace = null; error = null; publish();
      try {
        const value = await read();
        if (captured !== generation) return null;
        if (!validate(value) || workspaceOriginScope(value) === null) throw fail('BACKEND_PROTOCOL_ERROR', '工作区身份核对返回了无效数据。');
        workspace = frozenCopy(value); phase = 'ready'; publish(); return workspace;
      } catch (reason) {
        if (captured !== generation) return null;
        error = reason; phase = 'error'; workspace = null; publish(); return null;
      }
    },
    pin(intent) { return pinNewWorkspaceIntent(intent, workspace); },
  };
}
