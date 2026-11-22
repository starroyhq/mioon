import {projectIdSchema} from '../../../packages/contracts/src/project-file.ts';
import {
  projectHistoryResolveResultSchema, projectHistoryStatusSchema,
} from '../../../packages/contracts/src/project-history-recovery.ts';
import type {ProjectHistoryResolveInput, ProjectHistoryResolveResult, ProjectHistoryStatus} from '../../../packages/contracts/src/project-history-recovery.ts';
import {
  projectVersionListResponseSchema, projectVersionPreviewResponseSchema,
} from '../../../packages/contracts/src/project-version-operations.ts';
import type {ProjectVersionListResponse, ProjectVersionPreviewResponse} from '../../../packages/contracts/src/project-version-operations.ts';

/** Host-only V5 recovery endpoints. These are deliberately not business RPCs:
 * a diverged project has no runtime that could answer a normal operation. */
export class ProjectHistoryRecoveryError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {super(code); this.name = 'ProjectHistoryRecoveryError'; this.code = code; this.status = status;}
}
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProjectHistoryRecoveryError('BACKEND_PROTOCOL_ERROR', response.status);
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let bytes = 0, text = '';
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new ProjectHistoryRecoveryError('BACKEND_PROTOCOL_ERROR', response.status);
      text += decoder.decode(next.value, {stream: true});
    }
    text += decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {reader.releaseLock();}
  try {return JSON.parse(text);} catch {throw new ProjectHistoryRecoveryError('BACKEND_PROTOCOL_ERROR', response.status);}
}
export interface ProjectHistoryRecoveryClient {
  status(projectId: string): Promise<ProjectHistoryStatus>;
  versions(projectId: string): Promise<ProjectVersionListResponse>;
  preview(projectId: string, versionId: string): Promise<ProjectVersionPreviewResponse>;
  resolve(input: ProjectHistoryResolveInput): Promise<ProjectHistoryResolveResult>;
}
export function createProjectHistoryRecoveryClient(fetcher: typeof fetch = (...args) => fetch(...args)): ProjectHistoryRecoveryClient {
  async function call(projectId: string, suffix: string, method: 'GET' | 'POST', body?: unknown, maxBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
    const id = projectIdSchema.parse(projectId);
    const response = await fetcher(`/api/projects/${encodeURIComponent(id)}/history/${suffix}`, {
      method, credentials: 'same-origin',
      ...(body === undefined ? {} : {headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}),
    });
    const payload = await boundedJson(response);
    if (response.ok && record(payload) && payload.ok === true && 'data' in payload) return payload.data;
    const error = record(payload) && record(payload.error) ? payload.error : null;
    const code = error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/u.test(error.code) ? error.code : 'BACKEND_PROTOCOL_ERROR';
    throw new ProjectHistoryRecoveryError(response.status === 401 ? 'UNAUTHORIZED' : code, response.status);
  }
  return Object.freeze({
    status: async (projectId: string) => projectHistoryStatusSchema.parse(await call(projectId, 'status', 'GET')),
    versions: async (projectId: string) => projectVersionListResponseSchema.parse(await call(projectId, 'versions?limit=100', 'GET')),
    preview: async (projectId: string, versionId: string) => projectVersionPreviewResponseSchema.parse(await call(projectId,
      `preview?versionId=${encodeURIComponent(projectIdSchema.parse(versionId))}&limit=100`, 'GET')),
    resolve: async (input: ProjectHistoryResolveInput) => projectHistoryResolveResultSchema.parse(await call(input.projectId, 'resolve', 'POST', input)),
  });
}
export const projectHistoryRecoveryClient = createProjectHistoryRecoveryClient();
