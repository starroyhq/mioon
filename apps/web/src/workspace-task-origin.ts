import { message } from '../../../packages/i18n/src/index.ts';
import { workspaceRestoreTaskContextSchema, workspaceRestoreTaskListContextSchema } from '@mioon/contracts';
import { workspaceOriginScope, workspaceOriginOptions, WORKSPACE_ORIGIN_HELD_REASON, WORKSPACE_ORIGIN_UNVERIFIED_REASON } from './workspace-origin.ts';
import type { WorkspaceIdentity, WorkspaceOriginOptions } from './workspace-origin.ts';

export interface TaskWorkspace extends WorkspaceIdentity {}
export interface TaskWorkspaceBinding {
  readonly workspaceOrigin: string;
  readonly held?: unknown;
  readonly executionEpoch?: unknown;
  readonly [key: string]: unknown;
}
export interface TaskWorkspaceContext extends TaskWorkspaceBinding {readonly taskId?: string}
export interface TaskEnvelope {readonly task?: unknown; readonly restore?: unknown; readonly instanceId?: string; readonly [key: string]: unknown}
export interface TaskListEnvelope {readonly items?: unknown; readonly restore?: unknown; readonly [key: string]: unknown}
export interface TaskWorkspaceError extends Error {code: string; displayMessage?: unknown}
const isRecord=(value: unknown): value is Record<string, unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const property=(value: unknown,key: string): unknown=>isRecord(value)?value[key]:undefined;
const fail=(code: string,message: string): TaskWorkspaceError => Object.assign(new Error(message), { code });
const protocol=(): TaskWorkspaceError => Object.assign(fail('BACKEND_PROTOCOL_ERROR', '任务工作区身份确认无效，原编号和参数仍保留。'), { displayMessage: message('recovery.workspace.taskProtocol') });
const freeze=<T>(value: T): Readonly<T>=>Object.freeze(structuredClone(value));

// Restore metadata wraps a task; it never changes that task's domain input,
// origin ('new' / 'legacy_session'), digest, state or original acknowledgment.
export function taskWorkspaceBinding(envelope: TaskEnvelope,workspace: TaskWorkspace|null|undefined): TaskWorkspaceBinding|null {
  const scope = workspaceOriginScope(workspace);
  if (scope === null) throw fail('WORKSPACE_ORIGIN_UNVERIFIED', WORKSPACE_ORIGIN_UNVERIFIED_REASON);
  if (workspace?.restored !== true) {
    if (Object.hasOwn(envelope, 'restore')) throw protocol();
    return null;
  }
  const context = envelope.restore;
  if (!workspaceRestoreTaskContextSchema.safeParse(context).success || property(context,'workspaceOrigin') !== workspace.workspaceOrigin) throw protocol();
  return freeze(context as TaskWorkspaceBinding);
}

export function taskListWorkspaceBindings(envelope: TaskListEnvelope,workspace: TaskWorkspace|null|undefined): Map<string,TaskWorkspaceBinding> {
  const scope = workspaceOriginScope(workspace);
  if (scope === null) throw fail('WORKSPACE_ORIGIN_UNVERIFIED', WORKSPACE_ORIGIN_UNVERIFIED_REASON);
  if (workspace?.restored !== true) {
    if (Object.hasOwn(envelope, 'restore')) throw protocol();
    return new Map();
  }
  const context = envelope.restore, contextTasks = property(context,'tasks');
  if (!workspaceRestoreTaskListContextSchema.safeParse(context).success || property(context,'workspaceOrigin') !== workspace.workspaceOrigin ||
    !Array.isArray(envelope.items) || !Array.isArray(contextTasks) || contextTasks.length !== envelope.items.length ||
    contextTasks.some((entry, index) => property(entry,'taskId') !== property((envelope.items as unknown[])[index],'id'))) throw protocol();
  return new Map((contextTasks as unknown[]).map(entry => {
    const record=isRecord(entry)?entry:{}, taskId=property(record,'taskId');
    const rest=Object.fromEntries(Object.entries(record).filter(([key])=>key!=='taskId'));
    return [String(taskId), freeze({ workspaceOrigin: property(context,'workspaceOrigin') as string, ...rest })] as [string,TaskWorkspaceBinding];
  }));
}

export function requireTaskWorkspace(binding: unknown,workspace: TaskWorkspace|null|undefined): WorkspaceOriginOptions {
  const scope = workspaceOriginScope(workspace);
  if (scope === null) throw fail('WORKSPACE_ORIGIN_UNVERIFIED', WORKSPACE_ORIGIN_UNVERIFIED_REASON);
  if (workspace?.restored !== true) {
    if (binding) throw fail('RESTORED_RECORD_HELD', WORKSPACE_ORIGIN_HELD_REASON);
    return {};
  }
  if (!workspaceRestoreTaskContextSchema.safeParse(binding).success || property(binding,'workspaceOrigin') !== workspace.workspaceOrigin || property(binding,'held')) throw fail('RESTORED_RECORD_HELD', WORKSPACE_ORIGIN_HELD_REASON);
  // Use only the validated persisted execution epoch, not the latest inspection.
  return workspaceOriginOptions(property(binding,'executionEpoch'));
}
