import {z} from 'zod';
import {
  MIO_RULES_ERROR_STATUS, projectRulesSaveInputSchema, projectRulesEnableInputSchema,
  projectRulesSnapshotSchema, projectRulesRequestLookupSchema, rulesRequestIdSchema,
  userRulesSaveInputSchema, userRulesSnapshotSchema, userRulesRequestLookupSchema,
} from '../../contracts/src/mio-rules.ts';
import {projectApiPath} from '../../contracts/src/project-file.ts';
import {resolveConnection} from './connection.ts';
import {ClientError, EXIT_CODES} from './index.ts';
import type {ClientOptions} from './index.ts';

export interface ProjectRulesRequestOptions {readonly signal?: AbortSignal; readonly timeoutMs?: number}
const location = z.object({projectId: z.string().uuid()}).strict();
const lookupLocation = location.extend({requestId: rulesRequestIdSchema}).strict();
const projectSave = projectRulesSaveInputSchema.extend(location.shape).strict();
const projectEnable = projectRulesEnableInputSchema.extend(location.shape).strict();
const userLookup = z.object({requestId: rulesRequestIdSchema}).strict();
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function parse<T>(schema: z.ZodType<T>, value: unknown, code = 'VALIDATION_ERROR'): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ClientError(code, code === 'VALIDATION_ERROR' ? 'Invalid rules request.' : 'Invalid local rules response.');
  return parsed.data;
}
async function responseJson(response: Response): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '') || !response.body) throw new ClientError('BACKEND_PROTOCOL_ERROR', 'Invalid local rules response.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.length; if (size > 64 * 1024) throw new ClientError('BACKEND_PROTOCOL_ERROR', 'Rules response exceeds its safe size limit.');
      chunks.push(value);
    }
  } finally {await reader.cancel().catch(() => {});}
  try {return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks))) as unknown;}
  catch {throw new ClientError('BACKEND_PROTOCOL_ERROR', 'Unreadable local rules response.');}
}
interface WriteIdentity {requestId: string; lookup: string}
/** A separate Node management client. Neither a proposal nor a lost HTTP
 * response authorizes a retry, new replay key or automatic reconciliation. */
export function createProjectRulesClient({env = process.env, fetchImpl = fetch, requestTimeoutMs = 30_000}: ClientOptions = {}) {
  async function request<T>(route: string, schema: z.ZodType<T>, options: ProjectRulesRequestOptions = {}, write?: WriteIdentity, method: 'GET' | 'PUT' | 'POST' = 'GET', input?: unknown, validate?: (value: T) => boolean): Promise<T> {
    const timeoutMs = options.timeoutMs ?? requestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) throw new ClientError('VALIDATION_ERROR', 'Invalid rules timeout.');
    const interrupted = (): void => {if (options.signal?.aborted) throw new ClientError('INTERRUPTED', 'Stopped locally before dispatch.', {exitCode: EXIT_CODES.interrupted});};
    interrupted(); const {base, token} = await resolveConnection(env); interrupted();
    const timer = AbortSignal.timeout(timeoutMs), signal = options.signal ? AbortSignal.any([options.signal, timer]) : timer;
    let dispatched = false;
    try {
      dispatched = true;
      const response = await fetchImpl(base + route, {method, headers: {authorization: `Bearer ${token}`, ...(input === undefined ? {} : {'content-type': 'application/json'})},
        ...(input === undefined ? {} : {body: JSON.stringify(input)}), redirect: 'error', signal});
      const value = await responseJson(response);
      if (!object(value) || typeof value.ok !== 'boolean' || value.ok !== response.ok) throw new ClientError('BACKEND_PROTOCOL_ERROR', 'Invalid local rules envelope.');
      if (!value.ok) {
        const raw = object(value.error) ? value.error.code : undefined;
        if (typeof raw !== 'string' || !(Object.hasOwn(MIO_RULES_ERROR_STATUS, raw) || ['UNAUTHORIZED', 'ORIGIN_REJECTED', 'METHOD_NOT_ALLOWED', 'PROJECT_NOT_FOUND', 'NOT_FOUND', 'PROJECT_FILE_COPY', 'PROJECT_FILE_MOVED', 'PROJECT_IN_USE'].includes(raw))) throw new ClientError('BACKEND_PROTOCOL_ERROR', 'Invalid local rules failure.');
        const code = raw;
        throw new ClientError(code, 'The local backend rejected the rules operation.', {status: response.status, details: write ? {...write, ...(code === 'MIO_RULES_WRITE_UNCERTAIN' ? {outcomeUnknown: true} : {})} : {}});
      }
      if (Object.keys(value).some(key => key !== 'ok' && key !== 'data') || !Object.hasOwn(value, 'data')) throw new ClientError('BACKEND_PROTOCOL_ERROR', 'Invalid local rules envelope.');
      const data = parse(schema, value.data, 'BACKEND_PROTOCOL_ERROR');
      if (validate && !validate(data)) throw new ClientError('BACKEND_PROTOCOL_ERROR', 'Rules response belongs to a different request or project.');
      return data;
    } catch (error) {
      const details = write && dispatched ? {...write, outcomeUnknown: true} : {};
      if (options.signal?.aborted) throw new ClientError('INTERRUPTED', 'Stopped locally; the dispatched rules operation was not cancelled.', {details, exitCode: EXIT_CODES.interrupted});
      if (timer.aborted) throw new ClientError('TIMEOUT', 'The rules request timed out.', {details, exitCode: EXIT_CODES.timeout});
      if (error instanceof ClientError && error.status !== undefined) throw error;
      if (write && dispatched) throw new ClientError('MIO_RULES_WRITE_UNCERTAIN', 'Read the original request before any further action.', {details, exitCode: EXIT_CODES.conflict});
      if (error instanceof ClientError) throw error;
      throw new ClientError('BACKEND_UNAVAILABLE', 'The local rules backend is unavailable.');
    }
  }
  const projectRoute = (projectId: string): string => {
    try {return projectApiPath(projectId, 'rules');} catch {throw new ClientError('VALIDATION_ERROR', 'Invalid project identity.');}
  };
  return {
    async get(value: unknown, options?: ProjectRulesRequestOptions) {
      const input = parse(location, value);
      return request(projectRoute(input.projectId), projectRulesSnapshotSchema, options, undefined, 'GET', undefined, result => result.projectId === input.projectId);
    },
    async save(value: unknown, options?: ProjectRulesRequestOptions) {
      const {projectId, ...input} = parse(projectSave, value), route = projectRoute(projectId);
      return request(route, projectRulesSnapshotSchema, options, {requestId: input.requestId, lookup: `${route}/requests/${encodeURIComponent(input.requestId)}`}, 'PUT', input, result => result.projectId === projectId);
    },
    async enable(value: unknown, options?: ProjectRulesRequestOptions) {
      const {projectId, ...input} = parse(projectEnable, value), route = projectRoute(projectId);
      return request(route + '/enable', projectRulesSnapshotSchema, options, {requestId: input.requestId, lookup: `${route}/requests/${encodeURIComponent(input.requestId)}`}, 'POST', input, result => result.projectId === projectId);
    },
    async lookup(value: unknown, options?: ProjectRulesRequestOptions) {
      const input = parse(lookupLocation, value), route = `${projectRoute(input.projectId)}/requests/${encodeURIComponent(input.requestId)}`;
      return request(route, projectRulesRequestLookupSchema, options, undefined, 'GET', undefined, result => result.projectId === input.projectId && result.requestId === input.requestId);
    },
    async reconcile(value: unknown, options?: ProjectRulesRequestOptions) {
      const input = parse(lookupLocation, value), lookup = `${projectRoute(input.projectId)}/requests/${encodeURIComponent(input.requestId)}`;
      return request(lookup + '/reconcile', projectRulesRequestLookupSchema, options, {requestId: input.requestId, lookup}, 'POST', {}, result => result.projectId === input.projectId && result.requestId === input.requestId);
    },
    getUser(options?: ProjectRulesRequestOptions) {return request('/api/user-rules', userRulesSnapshotSchema, options);},
    async saveUser(value: unknown, options?: ProjectRulesRequestOptions) {
      const input = parse(userRulesSaveInputSchema, value);
      return request('/api/user-rules', userRulesSnapshotSchema, options, {requestId: input.requestId, lookup: `/api/user-rules/requests/${encodeURIComponent(input.requestId)}`}, 'PUT', input);
    },
    async lookupUser(value: unknown, options?: ProjectRulesRequestOptions) {
      const input = parse(userLookup, value);
      return request(`/api/user-rules/requests/${encodeURIComponent(input.requestId)}`, userRulesRequestLookupSchema, options, undefined, 'GET', undefined, result => result.requestId === input.requestId);
    },
  };
}
export type ProjectRulesClient = ReturnType<typeof createProjectRulesClient>;
