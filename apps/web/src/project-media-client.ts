import {assetMediaSchemas, trustedAssetMediaLocationSchemas, assetMediaStatusListResponseSchema, assetMediaPrepareResponseSchema, assetMediaDtoSchema} from '../../../packages/contracts/src/asset-media.ts';
import {mediaLocationPageSchema, mediaRelinkPreviewSchema, mediaChangedResponseSchema, mediaAppliedResponseSchema, mediaPermissionResponseSchema} from '../../../packages/contracts/src/project-media-ui.ts';
export {mediaLocationPageSchema, mediaRelinkPreviewSchema} from '../../../packages/contracts/src/project-media-ui.ts';
export type {MediaLocationPage, MediaRelinkPreview} from '../../../packages/contracts/src/project-media-ui.ts';
interface Parser<T> {safeParse(value: unknown): {success: true; data: T} | {success: false}}
import {projectRulesSnapshotSchema} from '../../../packages/contracts/src/mio-rules.ts';
import {projectApiPath, projectIdSchema, projectRpcPath} from '../../../packages/contracts/src/project-file.ts';
import {readBoundedJsonResponse, ProjectEntryDirectoryError} from './project-entry-directory-client.ts';

export const MEDIA_BROWSER_LIMITS = Object.freeze({statusBytes: 256 * 1024, locationBytes: 4 * 1024 * 1024, mutationBytes: 4 * 1024 * 1024, rulesBytes: 64 * 1024});
const statuses: Readonly<Record<string, readonly number[]>> = {
  UNAUTHORIZED: [401], ORIGIN_REJECTED: [403], FORBIDDEN: [403], VALIDATION_ERROR: [400], UNKNOWN_OPERATION: [404], NOT_FOUND: [404],
  METHOD_NOT_ALLOWED: [405], REVISION_CONFLICT: [409], IDEMPOTENCY_CONFLICT: [409], INSPECTION_BUDGET_EXCEEDED: [409, 429],
  MEDIA_REFERENCE_INVALID: [400, 409], MEDIA_MISSING: [404], MEDIA_CHANGED: [409], MEDIA_NOT_MEDIA: [415],
  MEDIA_OUTSIDE_NOT_CONFIRMED: [403], MEDIA_CHANGED_DURING_READ: [409], PREFLIGHT_BUDGET: [409],
  PROJECT_UNAVAILABLE: [409, 503], PROJECT_NOT_FOUND: [404], PROJECT_MISSING: [404, 409], PROJECT_LOCKED: [409], PROJECT_INVALID: [422],
  PROJECT_FILE_COPY: [409], PROJECT_FILE_MOVED: [409], PROJECT_IN_USE: [409], PROJECT_HOST_STOPPED: [503], INTERNAL_ERROR: [500],
  MIO_RULES_INVALID: [400], MIO_RULES_TOO_LARGE: [413], MIO_RULES_CONFLICT: [409], MIO_RULES_PENDING: [409], MIO_RULES_NOT_FOUND: [404], MIO_RULES_UNAVAILABLE: [503],
};
export class ProjectMediaError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly outcomeUnknown: boolean;
  constructor(code: string, {status, outcomeUnknown = false}: {status?: number; outcomeUnknown?: boolean} = {}) {
    super('The media operation could not be verified.'); this.name = 'ProjectMediaError'; this.code = code; this.outcomeUnknown = outcomeUnknown;
    if (status !== undefined) this.status = status;
  }
}
export interface ProjectMediaRequestOptions {readonly signal?: AbortSignal}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const protocol = (): ProjectMediaError => new ProjectMediaError('BACKEND_PROTOCOL_ERROR');

/** Fixed browser routes for the existing S1 and R2 capabilities. This adapter
 * has no filesystem API, arbitrary resource, import or rule-enabling action. */
export function createProjectMediaClient({fetcher = (...args: Parameters<typeof fetch>) => fetch(...args), timeoutMs = 30_000}: {fetcher?: typeof fetch; timeoutMs?: number} = {}) {
  async function request<T>(resource: string, schema: Parser<T>, options: ProjectMediaRequestOptions, {body, trusted = false, write = false, maxBytes}: {body?: unknown; trusted?: boolean; write?: boolean; maxBytes: number}): Promise<T> {
    if (!record(options) || Object.keys(options).some(key => key !== 'signal') || options.signal !== undefined && !(options.signal instanceof AbortSignal) ||
      typeof fetcher !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) throw new ProjectMediaError('VALIDATION_ERROR');
    if (options.signal?.aborted) throw new ProjectMediaError('INTERRUPTED');
    const abort = new AbortController(); let timedOut = false, dispatched = false;
    const cancel = (): void => abort.abort(); options.signal?.addEventListener('abort', cancel, {once: true});
    let rejectAbort: (error: ProjectMediaError) => void = () => {};
    const stopped = new Promise<never>((_resolve, reject) => {rejectAbort = reject;});
    const stop = (): void => rejectAbort(new ProjectMediaError(timedOut ? 'TIMEOUT' : 'INTERRUPTED', {outcomeUnknown: write && dispatched}));
    abort.signal.addEventListener('abort', stop, {once: true});
    const timer = setTimeout(() => {timedOut = true; abort.abort();}, timeoutMs);
    try {
      return await Promise.race([(async () => {
        dispatched = true;
        const response = await fetcher(resource, {method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: abort.signal,
          ...(body === undefined ? {} : {headers: {'content-type': 'application/json', ...(trusted ? {'x-mioon-user-action': 'asset-media'} : {})}, body: JSON.stringify(body)})});
        const value = await readBoundedJsonResponse(response, {signal: abort.signal, maxBytes});
        if (!record(value) || typeof value.ok !== 'boolean' || value.ok !== response.ok || value.ok && response.status !== 200 || Object.keys(value).length !== 2) throw protocol();
        if (!value.ok) {
          if (!record(value.error) || Object.keys(value.error).some(key => !['code', 'message', 'details', 'retryable'].includes(key)) ||
            typeof value.error.code !== 'string' || !statuses[value.error.code]?.includes(response.status) || typeof value.error.message !== 'string' ||
            value.error.message.length < 1 || value.error.message.length > 1000 || value.error.details !== undefined && !record(value.error.details) ||
            value.error.retryable !== undefined && typeof value.error.retryable !== 'boolean') throw protocol();
          throw new ProjectMediaError(value.error.code, {status: response.status, outcomeUnknown: write && response.status >= 500});
        }
        if (!Object.hasOwn(value, 'data')) throw protocol();
        const parsed = schema.safeParse(value.data); if (!parsed.success) throw protocol();
        return parsed.data;
      })(), stopped]);
    } catch (error) {
      if (options.signal?.aborted) throw new ProjectMediaError('INTERRUPTED', {outcomeUnknown: write && dispatched});
      if (timedOut) throw new ProjectMediaError('TIMEOUT', {outcomeUnknown: write && dispatched});
      if (error instanceof ProjectMediaError && error.status !== undefined) throw error;
      const code = error instanceof ProjectMediaError || error instanceof ProjectEntryDirectoryError ? error.code : 'BACKEND_UNAVAILABLE';
      throw new ProjectMediaError(code, {outcomeUnknown: write && dispatched});
    } finally {clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); abort.signal.removeEventListener('abort', stop);}
  }
  function parse<T>(schema: Parser<T>, input: unknown): T {
    const result = schema.safeParse(input); if (!result.success) throw new ProjectMediaError('VALIDATION_ERROR'); return result.data;
  }
  async function ordinary<T>(operation: keyof typeof assetMediaSchemas, input: unknown, schema: Parser<T>, options: ProjectMediaRequestOptions, write = false, maxBytes = MEDIA_BROWSER_LIMITS.mutationBytes): Promise<T> {
    const parsed = assetMediaSchemas[operation].safeParse(input);
    if (!parsed.success) throw new ProjectMediaError('VALIDATION_ERROR');
    return request(projectRpcPath(parsed.data.projectId), schema, options, {body: {operation, input: parsed.data}, write, maxBytes});
  }
  return {
    status: (input: unknown, options: ProjectMediaRequestOptions = {}) => ordinary('asset.media.status.list', input, assetMediaStatusListResponseSchema, options, false, MEDIA_BROWSER_LIMITS.statusBytes),
    async locations(input: unknown, options: ProjectMediaRequestOptions = {}) {
      const parsed = parse(assetMediaSchemas['asset.media.location.list'], input);
      return request(projectApiPath(parsed.projectId, 'asset-media', 'trusted'), mediaLocationPageSchema, options, {body: {operation: 'asset.media.location.list', input: parsed}, trusted: true, maxBytes: MEDIA_BROWSER_LIMITS.locationBytes});
    },
    prepare: (input: unknown, options: ProjectMediaRequestOptions = {}) => ordinary('asset.media.prepare', input, assetMediaPrepareResponseSchema, options, true),
    preview: (input: unknown, options: ProjectMediaRequestOptions = {}) => ordinary('asset.media.relink.preview', input, mediaRelinkPreviewSchema, options),
    apply: (input: unknown, options: ProjectMediaRequestOptions = {}) => ordinary('asset.media.relink.apply', input, mediaAppliedResponseSchema, options, true),
    acceptChanged: (input: unknown, options: ProjectMediaRequestOptions = {}) => ordinary('asset.media.acceptChanged', input, mediaChangedResponseSchema, options, true),
    async confirm(input: unknown, options: ProjectMediaRequestOptions = {}) {
      const parsed = parse(trustedAssetMediaLocationSchemas['asset.media.outside.confirm'], input);
      return request(projectApiPath(parsed.projectId, 'asset-media', 'trusted'), mediaPermissionResponseSchema, options, {body: {operation: 'asset.media.outside.confirm', input: parsed}, trusted: true, write: true, maxBytes: MEDIA_BROWSER_LIMITS.statusBytes});
    },
    async rules(projectId: string, options: ProjectMediaRequestOptions = {}) {
      parse(projectIdSchema, projectId);
      const result = await request(projectApiPath(projectId, 'rules'), projectRulesSnapshotSchema, options, {maxBytes: MEDIA_BROWSER_LIMITS.rulesBytes});
      if (result.projectId !== projectId) throw protocol();
      return result;
    },
  };
}
export type ProjectMediaClient = ReturnType<typeof createProjectMediaClient>;
