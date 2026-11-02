import type {ServerResponse} from 'node:http';
import type {DatabaseSync} from 'node:sqlite';
import {AppError} from '../../../packages/contracts/src/app-error.ts';
import {parseProjectApiPath} from '../../../packages/contracts/src/project-file.ts';
import type {ProjectAddressErrorCode} from '../../../packages/contracts/src/project-file.ts';
import {inputProjectId, isAppLevelOperation, isEntityAddressedOperation} from '../../../packages/contracts/src/project-addressing.ts';
import type {EntityAddressedOperation} from '../../../packages/contracts/src/project-addressing.ts';
/** Project-scoped addresses on today's single workspace store (K2). A request
 * under `/api/projects/<ID>/` is served by the existing handler of the path it
 * replaces, so every path-based policy and exact request check stays as it is.
 * S0's project host replaces this module; its errors keep the names and texts
 * of `project-host/errors.ts`. */
export interface ProjectAddress {readonly projectId: string}
export const PROJECT_ADDRESS_ERROR_STATUS: Readonly<Record<ProjectAddressErrorCode, number>> = Object.freeze({
  PROJECT_NOT_FOUND: 404, PROJECT_ID_MISMATCH: 400, PROJECT_UNAVAILABLE: 409,
});
/** Not registered on this computer. */
export function projectNotFound(projectId: string): AppError {
  return new AppError('PROJECT_NOT_FOUND', '这个项目没有登记', PROJECT_ADDRESS_ERROR_STATUS.PROJECT_NOT_FOUND, {projectId});
}
/** The input names another project than the URL; details carry the URL's ID. */
export function projectIdMismatch(projectId: string): AppError {
  return new AppError('PROJECT_ID_MISMATCH', '请求里的项目和地址不一致', PROJECT_ADDRESS_ERROR_STATUS.PROJECT_ID_MISMATCH, {projectId});
}
const legacy = (...segments: readonly string[]): string => `/${segments.map(encodeURIComponent).join('/')}`;
/** Families whose handlers match the whole prefix and answer unknown subpaths
 * themselves. */
const FAMILIES = new Set(['timeline-audio-preview', 'local-drafts', 'local-delivery', 'local-shot-text', 'tasks']);
/** The project and the existing path that serves a project-scoped pathname,
 * or null when the pathname is not one: app-level routes such as
 * `agent/tasks/v2/policy` or `images/settings`, `package-preview` (served
 * where it is) and anything `parseProjectApiPath` refuses. */
export function projectRouteTarget(pathname: string): {readonly projectId: string; readonly pathname: string} | null {
  const route = parseProjectApiPath(pathname);
  if (!route) return null;
  const {projectId} = route;
  if (route.kind === 'rpc') return {projectId, pathname: '/api/rpc'};
  if (route.kind === 'media') return {projectId, pathname: legacy('media', route.assetId)};
  const segments = route.segments, [first] = segments;
  const target = (...rest: readonly string[]) => ({projectId, pathname: legacy('api', ...rest)});
  if (FAMILIES.has(first)) return target(...segments);
  if (segments.length === 1 && first === 'export-files') return target(...segments);
  if (segments.length === 2 && first === 'version-comparison' && segments[1] === 'media') return target(...segments);
  if (segments.length === 3 && first === 'images' && segments[1] === 'reviews' && ['approve', 'reject'].includes(segments[2])) return target(...segments);
  if (first !== 'agent' || segments[1] !== 'tasks' || segments[2] !== 'v2') return null;
  const tail = segments.slice(3);
  if (tail.length === 1 && tail[0] === 'editing') return target(...segments);
  if (tail[0] === 'policy' || tail[0] === 'diagnostics' || tail[0] === 'editing') return null;
  return target('agent', 'tasks', 'v2', projectId, ...tail);
}
const ENTITY_ROWS: Readonly<Record<EntityAddressedOperation, readonly [table: string, field: string]>> = Object.freeze({
  'edge.delete': ['edges', 'edgeId'], 'export.get': ['exports', 'exportId'], 'generation.submit': ['shots', 'shotId'],
  'job.cancel': ['jobs', 'jobId'], 'job.get': ['jobs', 'jobId'], 'job.reconcile': ['jobs', 'jobId'], 'job.retry': ['jobs', 'jobId'],
  'node.update': ['nodes', 'nodeId'], 'shot.update': ['shots', 'shotId'], 'version.list': ['shots', 'shotId'], 'version.select': ['shots', 'shotId'],
});
/** RPC at a project's address. App-level operations belong at `/api/rpc`.
 * An entity of another project is NOT_FOUND exactly as a missing one is
 * (services' `required()`), so nothing tells it apart from absence; a
 * missing entity and a malformed input are left to the services. An input
 * that names its own project must name this one. */
export function assertProjectRpc(db: DatabaseSync, address: ProjectAddress, operation: string, input: unknown): void {
  if (isAppLevelOperation(operation)) throw new AppError('VALIDATION_ERROR', '这个操作不属于单个项目，请发到 /api/rpc', 400);
  if (isEntityAddressedOperation(operation)) {
    const [table, field] = ENTITY_ROWS[operation];
    const id = input !== null && typeof input === 'object' ? (input as Record<string, unknown>)[field] : undefined;
    if (typeof id !== 'string') return;
    const row = db.prepare(`SELECT projectId FROM ${table} WHERE id=?`).get(id) as {projectId?: unknown} | undefined;
    if (row && row.projectId !== address.projectId) throw new AppError('NOT_FOUND', '找不到记录', 404, {id});
    return;
  }
  const named = inputProjectId(operation, input);
  if (named !== undefined && named !== address.projectId) throw projectIdMismatch(address.projectId);
}
/** Writes PROJECT_ID_MISMATCH and returns true when a JSON request body names
 * another project than its address, before the route's own error mapping. A
 * body without `projectId` passes; its route validates it. */
export function rejectProjectMismatch(res: ServerResponse, address: ProjectAddress | undefined, input: unknown): boolean {
  if (!address || input === null || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(input, 'projectId') ||
      (input as {projectId?: unknown}).projectId === address.projectId) return false;
  const error = projectIdMismatch(address.projectId);
  if (res.destroyed || res.writableEnded) return true;
  if (res.headersSent) { res.destroy(); return true; }
  res.writeHead(error.status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify({ok: false, error: {code: error.code, message: error.message, details: error.details, retryable: false}}));
  return true;
}
