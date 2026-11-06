import {rpcPathFor} from '../../../packages/contracts/src/project-addressing.ts';
import {isProjectVersionResponse, projectVersionSchemas} from '../../../packages/contracts/src/project-version-operations.ts';
import type {ProjectVersionOperation, ProjectVersionListInput, ProjectVersionListResponse, ProjectVersionSaveInput, ProjectVersionSaveResponse,
  ProjectVersionPreviewInput, ProjectVersionPreviewResponse, ProjectVersionRestoreInput, ProjectVersionRestoreResponse} from '../../../packages/contracts/src/project-version-operations.ts';
import {isProjectBackupResponse, projectBackupSchemas} from '../../../packages/contracts/src/project-backups.ts';
import type {ProjectBackupOperation, ProjectBackupListInput, ProjectBackupSummary, ProjectBackupInspectInput, ProjectBackupInspection,
  ProjectBackupStatusInput, ProjectBackupStatus, ProjectBackupRestoreInput, ProjectBackupRestoreResponse} from '../../../packages/contracts/src/project-backups.ts';

export class ProjectHistoryError extends Error {
  readonly code: string; readonly definitive: boolean;
  constructor(code: string, definitive = false) {super(code); this.name = 'ProjectHistoryError'; this.code = code; this.definitive = definitive;}
}
type Operation = ProjectVersionOperation | ProjectBackupOperation;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Bounded metadata only. A failed acknowledgement never retries a mutation. */
export function createProjectHistoryClient(fetcher: typeof fetch = (...args) => fetch(...args)) {
  async function call(operation: Operation, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const backup = operation.startsWith('project.backup.');
    const schema = backup ? projectBackupSchemas[operation as ProjectBackupOperation] : projectVersionSchemas[operation as ProjectVersionOperation];
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new ProjectHistoryError('VALIDATION_ERROR', true);
    const lifetime = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
    try {
      const response = await fetcher(rpcPathFor(operation, parsed.data), {method: 'POST', credentials: 'same-origin',
        headers: {'content-type': 'application/json'}, body: JSON.stringify({operation, input: parsed.data}), signal: lifetime});
      const reader = response.body?.getReader(); if (!reader) throw new ProjectHistoryError('BACKEND_PROTOCOL_ERROR');
      let bytes = 0, content = ''; const decoder = new TextDecoder('utf-8', {fatal: true});
      try {for (;;) {const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength;
        if (bytes > 16 * 1024 * 1024) throw new ProjectHistoryError('BACKEND_PROTOCOL_ERROR'); content += decoder.decode(next.value, {stream: true});}
        content += decoder.decode();
      } catch (error) {await reader.cancel().catch(() => {}); throw error;} finally {reader.releaseLock();}
      const body: unknown = JSON.parse(content);
      if (record(body) && body.ok === false && record(body.error) && typeof body.error.code === 'string'
        && /^[A-Z][A-Z0-9_]{0,99}$/u.test(body.error.code)) throw new ProjectHistoryError(response.status === 401 ? 'UNAUTHORIZED' : body.error.code, response.status >= 400 && response.status < 500);
      if (!response.ok || !record(body) || body.ok !== true || !Object.hasOwn(body, 'data')
        || Object.keys(body).some(key => key !== 'ok' && key !== 'data')
        || !(backup ? isProjectBackupResponse(operation as ProjectBackupOperation, parsed.data, body.data)
          : isProjectVersionResponse(operation as ProjectVersionOperation, parsed.data, body.data))) throw new ProjectHistoryError('BACKEND_PROTOCOL_ERROR');
      return body.data;
    } catch (error) {throw error instanceof ProjectHistoryError ? error : new ProjectHistoryError('BACKEND_UNAVAILABLE');}
  }
  return Object.freeze({
    list: (input: ProjectVersionListInput, signal?: AbortSignal) => call('project.version.list', input, signal) as Promise<ProjectVersionListResponse>,
    save: (input: ProjectVersionSaveInput) => call('project.version.save', input) as Promise<ProjectVersionSaveResponse>,
    preview: (input: ProjectVersionPreviewInput, signal?: AbortSignal) => call('project.version.preview', input, signal) as Promise<ProjectVersionPreviewResponse>,
    restore: (input: ProjectVersionRestoreInput) => call('project.version.restore', input) as Promise<ProjectVersionRestoreResponse>,
    backups: (input: ProjectBackupListInput, signal?: AbortSignal) => call('project.backup.list', input, signal) as Promise<{projectId: string; backups: ProjectBackupSummary[]}>,
    status: (input: ProjectBackupStatusInput, signal?: AbortSignal) => call('project.backup.status', input, signal) as Promise<ProjectBackupStatus>,
    inspect: (input: ProjectBackupInspectInput, signal?: AbortSignal) => call('project.backup.inspect', input, signal) as Promise<ProjectBackupInspection>,
    restoreBackup: (input: ProjectBackupRestoreInput) => call('project.backup.restore', input) as Promise<ProjectBackupRestoreResponse>,
  });
}
export type ProjectHistoryClient = ReturnType<typeof createProjectHistoryClient>;
