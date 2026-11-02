/** Internal canonical-path adapter retained for frozen handler fixtures.
 * This module installs no HTTP routes. Production dispatch authenticates and
 * acquires a host before calling project-host/request.ts directly. */
import {parseProjectApiPath} from '../../../packages/contracts/src/project-file.ts';
import {projectHandlerTarget} from './project-host/request.ts';
export {assertProjectRpc, rejectProjectMismatch} from './project-host/request.ts';
export type {ProjectAddress} from './project-host/request.ts';
export {PROJECT_ADDRESS_ERROR_STATUS, projectNotFound, projectIdMismatch} from './project-host/errors.ts';
export function projectRouteTarget(pathname: string): ReturnType<typeof projectHandlerTarget> {
  const route = parseProjectApiPath(pathname);
  return route ? projectHandlerTarget(route) : null;
}
