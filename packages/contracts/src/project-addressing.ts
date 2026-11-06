import {projectRpcPath} from './project-file.ts';
import {isProjectCopyActionOperation, isProjectCopyOperation} from './project-copies.ts';
import type {ProjectCopyActionOperation, ProjectCopyOperation} from './project-copies.ts';
import {isLocalRecordOperation} from './local-record-operations.ts';
import type {LocalRecordOperation} from './local-record-operations.ts';
/** Which RPC address each operation uses (docs/API.md, “按项目寻址”). No Node
 * imports: the server, the client package, CLI, MCP, the web app and the
 * desktop main process share this one table. Operations not listed here are
 * project-level and name their project in their input. */

/** Public discovery operations served at `/api/rpc`. They span projects, or, like deleting and
 * renaming, change the registry and so belong to the app even though their
 * input names a project. */
export const APP_LEVEL_OPERATIONS = Object.freeze([
  'agent.authorization.grant', 'agent.authorization.list', 'agent.authorization.revoke',
  'image.profile.list', 'project.create', 'project.delete', 'project.list', 'project.rename', 'project.summary.list',
  'project.backup.list', 'project.backup.inspect', 'project.backup.restore', 'project.backup.status',
  'provider.list', 'video.connection.list',
  'workspace.settings.get', 'workspace.settings.set',
] as const);
export type AppLevelOperation = typeof APP_LEVEL_OPERATIONS[number] | ProjectCopyOperation | ProjectCopyActionOperation | LocalRecordOperation;
/** Project-level operations whose input names only an entity, never its
 * project. Callers give the project beside the input; the server answers
 * NOT_FOUND when the entity belongs to another project. */
export const ENTITY_ADDRESSED_OPERATIONS = Object.freeze([
  'edge.delete', 'export.get', 'generation.submit', 'job.cancel', 'job.get', 'job.reconcile', 'job.retry',
  'node.update', 'shot.update', 'version.list', 'version.select',
] as const);
export type EntityAddressedOperation = typeof ENTITY_ADDRESSED_OPERATIONS[number];
export const isAppLevelOperation = (operation: unknown): operation is AppLevelOperation =>
  (APP_LEVEL_OPERATIONS as readonly unknown[]).includes(operation) || isProjectCopyOperation(operation) || isProjectCopyActionOperation(operation) || isLocalRecordOperation(operation);
export const isEntityAddressedOperation = (operation: unknown): operation is EntityAddressedOperation =>
  (ENTITY_ADDRESSED_OPERATIONS as readonly unknown[]).includes(operation);
const field = (value: unknown, name: string): unknown =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[name] : undefined;
/** The project an operation's own input names: `input.projectId`, and
 * `input.input.projectId` for image.review.prepare. Undefined for app-level
 * and entity-addressed operations, whose project is not in their input. */
export function inputProjectId(operation: string, input: unknown): unknown {
  if (isAppLevelOperation(operation) || isEntityAddressedOperation(operation)) return undefined;
  return operation === 'image.review.prepare' ? field(field(input, 'input'), 'projectId') : field(input, 'projectId');
}
/** `/api/rpc` for app-level operations, otherwise `/api/projects/<ID>/rpc`:
 * `entityProjectId` for the entity-addressed operations (every other
 * operation ignores it) and the input's own project for the rest. A missing
 * or non-canonical project ID is a TypeError. */
export function rpcPathFor(operation: string, input: unknown, entityProjectId?: string): string {
  if (isAppLevelOperation(operation)) return '/api/rpc';
  const projectId = isEntityAddressedOperation(operation) ? entityProjectId : inputProjectId(operation, input);
  return projectRpcPath(projectId as string);
}
