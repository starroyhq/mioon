import {projectIdSchema} from '../../../packages/contracts/src/project-file.ts';
import {
  PROJECT_FORMAT_READ_ONLY_LIMITS, projectFormatReadOnlyViewSchema, projectFormatUpgradeInputSchema,
  projectFormatUpgradeFromError, projectFormatUpgradeResultSchema,
} from '../../../packages/contracts/src/project-format-upgrade.ts';
import type {ProjectFormatUpgradePreview} from '../../../packages/contracts/src/project-format-upgrade.ts';
import {readBoundedJsonResponse} from './project-entry-directory-client.ts';

export type ProjectFormatChoice = 'read-only' | 'upgrade';
export type ProjectFormatNotice = 'backupFailed' | 'changed' | 'failed';

/** A backend refusal is definite when the host returned a bounded 4xx result.
 * Timeouts, lost ACKs and generic bridge failures stay unknown and must keep
 * the exact retry state; a definite refusal must release the dialog instead. */
export function formatUpgradeRejectionIsDefinite(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = 'code' in error ? error.code : undefined;
  if (code === 'PROJECT_ENTRY_OUTCOME_UNKNOWN' || code === 'PROJECT_ENTRY_UNAVAILABLE') return false;
  if (['PROJECT_FILE_COPY', 'PROJECT_FILE_MOVED', 'PROJECT_FORMAT_BACKUP_FAILED', 'PROJECT_FORMAT_UPGRADE_REQUIRED',
    'PROJECT_ENTRY_TICKET_EXPIRED', 'PROJECT_COPY_SOURCE_CHANGED'].includes(String(code))) return true;
  const status = 'status' in error ? error.status : undefined;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 500;
}
export function formatUpgradeNotice(error: unknown): ProjectFormatNotice {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'PROJECT_FORMAT_BACKUP_FAILED') return 'backupFailed';
  if (code === 'PROJECT_FORMAT_UPGRADE_REQUIRED' || code === 'PROJECT_ENTRY_TICKET_EXPIRED' ||
      code === 'PROJECT_COPY_SOURCE_CHANGED' || code === 'PROJECT_FILE_MOVED') return 'changed';
  return 'failed';
}

export function readProjectFormatUpgrade(error: unknown, projectId: string): ProjectFormatUpgradePreview | null {
  const preview = projectFormatUpgradeFromError(error);
  return preview?.projectId === projectId ? preview : null;
}

async function request<T extends {projectId: string}>(projectId: string, parser: {parse(value: unknown): T}, preview?: ProjectFormatUpgradePreview): Promise<T> {
  const id = projectIdSchema.parse(projectId);
  const path = `/api/projects/${encodeURIComponent(id)}/format-upgrade${preview ? '' : '/read-only'}`;
  const response = await fetch(path, {method: preview ? 'POST' : 'GET', credentials: 'same-origin',
    ...(preview ? {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(projectFormatUpgradeInputSchema.parse({preview}))} : {})});
  const body = await readBoundedJsonResponse(response, {maxBytes: PROJECT_FORMAT_READ_ONLY_LIMITS.bytes});
  if (response.ok && body && typeof body === 'object' && 'ok' in body && body.ok === true && 'data' in body) {
    const parsed = parser.parse(body.data);
    if (parsed.projectId === id) return parsed;
  }
  const error = body && typeof body === 'object' && 'error' in body ? body.error : null;
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'BACKEND_PROTOCOL_ERROR';
  throw Object.assign(new Error(code), {code, status: response.status});
}

export function openProjectReadOnly(projectId: string) {
  return request(projectId, projectFormatReadOnlyViewSchema);
}

export function upgradeProjectFormat(preview: ProjectFormatUpgradePreview) {
  return request(preview.projectId, projectFormatUpgradeResultSchema, preview);
}
