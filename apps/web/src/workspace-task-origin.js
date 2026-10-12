import { workspaceRestoreTaskContextSchema, workspaceRestoreTaskListContextSchema } from '@mioon/contracts';
import { workspaceOriginScope, workspaceOriginOptions, WORKSPACE_ORIGIN_HELD_REASON, WORKSPACE_ORIGIN_UNVERIFIED_REASON } from './workspace-origin.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
const protocol = () => fail('BACKEND_PROTOCOL_ERROR', '任务工作区身份确认无效，原编号和参数仍保留。');
const freeze = value => Object.freeze(structuredClone(value));

// Restore metadata wraps a task; it never changes that task's domain input,
// origin ('new' / 'legacy_session'), digest, state or original acknowledgment.
export function taskWorkspaceBinding(envelope, workspace) {
  const scope = workspaceOriginScope(workspace);
  if (scope === null) throw fail('WORKSPACE_ORIGIN_UNVERIFIED', WORKSPACE_ORIGIN_UNVERIFIED_REASON);
  if (!workspace.restored) {
    if (Object.hasOwn(envelope, 'restore')) throw protocol();
    return null;
  }
  const context = envelope.restore;
  if (!workspaceRestoreTaskContextSchema.safeParse(context).success || context.workspaceOrigin !== workspace.workspaceOrigin) throw protocol();
  return freeze(context);
}

export function taskListWorkspaceBindings(envelope, workspace) {
  const scope = workspaceOriginScope(workspace);
  if (scope === null) throw fail('WORKSPACE_ORIGIN_UNVERIFIED', WORKSPACE_ORIGIN_UNVERIFIED_REASON);
  if (!workspace.restored) {
    if (Object.hasOwn(envelope, 'restore')) throw protocol();
    return new Map();
  }
  const context = envelope.restore;
  if (!workspaceRestoreTaskListContextSchema.safeParse(context).success || context.workspaceOrigin !== workspace.workspaceOrigin ||
    !Array.isArray(envelope.items) || context.tasks.length !== envelope.items.length ||
    context.tasks.some((entry, index) => entry.taskId !== envelope.items[index].id)) throw protocol();
  return new Map(context.tasks.map(({ taskId, ...entry }) => [taskId, freeze({ workspaceOrigin: context.workspaceOrigin, ...entry })]));
}

export function requireTaskWorkspace(binding, workspace) {
  const scope = workspaceOriginScope(workspace);
  if (scope === null) throw fail('WORKSPACE_ORIGIN_UNVERIFIED', WORKSPACE_ORIGIN_UNVERIFIED_REASON);
  if (!workspace.restored) {
    if (binding) throw fail('RESTORED_RECORD_HELD', WORKSPACE_ORIGIN_HELD_REASON);
    return {};
  }
  if (!workspaceRestoreTaskContextSchema.safeParse(binding).success || binding.workspaceOrigin !== workspace.workspaceOrigin || binding.held)
    throw fail('RESTORED_RECORD_HELD', WORKSPACE_ORIGIN_HELD_REASON);
  // Use only the validated persisted execution epoch, not the latest inspection.
  return workspaceOriginOptions(binding.executionEpoch);
}
