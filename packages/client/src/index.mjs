import {isImageReviewResponse,isImageReviewPreparationResponse,isImageReviewListResponse} from '@mioon/contracts';
import {setTimeout as pause} from 'node:timers/promises';
import {z} from 'zod';
import {zodToJsonSchema} from 'zod-to-json-schema';
import {schemas, descriptions, parse, operationEffect, effectAnnotations, LOCAL_MUTATION_OPERATIONS, isLocalMutationResponse, isExportPreflightResponse, TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, SUBJECT_MUTATION_OPERATIONS, isSubjectMutationResponse, hasRequestNotAppliedProof} from '@mioon/contracts';
import {resolveConnection, connectionSource, ConnectionError} from './connection.mjs';
import {IMAGE_MUTATION_OPERATIONS,isImageMutationResponse,isImageTaskResponse,isImageGroupResponse,isImageRequestResponse,isImageProfilesResponse,isImageListResponse} from '@mioon/contracts';

export {schemas, descriptions, resolveConnection, effectAnnotations};
export const VERSION = '0.4.0';
export const EXIT_CODES = Object.freeze({success: 0, unexpected: 1, validation: 2, conflict: 3, unavailable: 4, timeout: 5, operationFailed: 6, interrupted: 130});
export const discoverySchemas = {
  doctor: z.object({}).strict(),
  capabilities: z.object({}).strict(),
  schema: z.object({operation: z.enum(Object.keys(schemas)).optional()}).strict(),
};
export const discoveryEffects = Object.freeze({
  doctor: Object.freeze({...operationEffect('provider.list'), notes:'Reads authenticated local health and current provider capabilities; no external provider call or mutation.'}),
  capabilities: operationEffect('provider.list'),
  schema: Object.freeze({...operationEffect('provider.list'), notes:'Reads static schemas and advisory effect metadata in this process; no backend, credentials or network required.'}),
});
export class ClientError extends Error {
  constructor(code, message, {status, details = {}, exitCode} = {}) {
    super(message); this.name = 'ClientError'; this.code = code; this.status = status; this.details = details;
    this.exitCode = exitCode ?? errorExitCode(this);
  }
}
export function errorExitCode(error) {
  if (Number.isInteger(error.exitCode)) return error.exitCode;
  if (error.code === 'INTERRUPTED' || error.name === 'AbortError') return EXIT_CODES.interrupted;
  if (['TIMEOUT', 'WATCH_TIMEOUT'].includes(error.code)) return EXIT_CODES.timeout;
  if (error.status === 409 || /CONFLICT/.test(error.code || '')) return EXIT_CODES.conflict;
  if (['CONNECTION_CONFIG_ERROR', 'BACKEND_UNAVAILABLE', 'BACKEND_PROTOCOL_ERROR', 'UNAUTHORIZED', 'ORIGIN_REJECTED'].includes(error.code) || error.status === 401 || error.status === 503) return EXIT_CODES.unavailable;
  if (['VALIDATION_ERROR', 'UNKNOWN_OPERATION', 'FILE_READ_ERROR', 'FILE_TOO_LARGE', 'INVALID_JSON'].includes(error.code)) return EXIT_CODES.validation;
  if (error.code && error.code !== 'INTERNAL_ERROR') return EXIT_CODES.operationFailed;
  return EXIT_CODES.unexpected;
}
const privateKeys = /^(?:token|accessToken|access_token|apiKey|api_key|secret|password|authorization|cookie|tokenFile|connectionFile)$/i;
function safeValue(value, secrets = []) {
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
    return text.replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]');
  }
  if (Array.isArray(value)) return value.map(item => safeValue(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !privateKeys.test(key)).map(([key, item]) => [key, safeValue(item, secrets)]));
  return value;
}
export function errorEnvelope(error) {
  const known = error instanceof ClientError || error instanceof ConnectionError || (typeof error.code === 'string' && Number.isInteger(error.status));
  return {ok: false, error: {code: known ? error.code : 'INTERNAL_ERROR', message: known ? safeValue(error.message) : 'The client could not complete the operation.', details: known ? safeValue(error.details || {}) : {}, retryable: false}};
}
export const successEnvelope = data => ({ok: true, data});
export function jsonSchema(schema) { return zodToJsonSchema(schema, {strictUnions: true, pipeStrategy: 'input'}); }
export function operationDefinition(operation) {
  if (!Object.hasOwn(schemas, operation)) throw new ClientError('UNKNOWN_OPERATION', 'Unknown operation. Run schema to list available operations.');
  const inputSchema = jsonSchema(schemas[operation]);
  return {operation, toolName: operation.replaceAll('.', '_'), command: operation.replaceAll('.', ' '), description: descriptions[operation] || operation, inputSchema, requiresRequestId: inputSchema.required?.includes('requestId') || false, effects: operationEffect(operation)};
}
export function discoverSchema(input = {}) {
  const parsed = validateDiscovery('schema', input);
  return parsed.operation ? operationDefinition(parsed.operation) : {version: VERSION, operations: Object.keys(schemas).map(operationDefinition), validation: 'Shared runtime Zod schemas are authoritative, including refinements that JSON Schema cannot express.'};
}
export function validateDiscovery(name, input) {
  const result = discoverySchemas[name].safeParse(input);
  if (!result.success) throw new ClientError('VALIDATION_ERROR', 'Invalid discovery arguments.', {details: {issues: result.error.issues.map(issue => ({path: issue.path, message: issue.message}))}});
  return result.data;
}
function interrupted() { return new ClientError('INTERRUPTED', 'Stopped waiting locally. No remote job was cancelled.'); }
function checkSignal(signal) { if (signal?.aborted) throw interrupted(); }
function uncertainRequestDetails(body) {
  return body ? {operation: body.operation, ...(body.input?.requestId ? {requestId: body.input.requestId, submissionMayHaveSucceeded: true, recovery: 'Replay the exact original input with the same requestId; do not invent a replacement ID.'} : {})} : {};
}

export function createClient(clientOptions = {}) {
  const {env = process.env, fetchImpl = fetch, requestTimeoutMs = 30_000} = clientOptions;
  // Only the new bounded read needs transport grace after its 30s analysis
  // budget. Every old default and explicit caller timeout remains unchanged.
  const preflightTimeoutMs = Object.hasOwn(clientOptions, 'requestTimeoutMs') ? requestTimeoutMs : 35_000;
  async function request(resource, {body, signal, timeoutMs = requestTimeoutMs} = {}) {
    checkSignal(signal);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new ClientError('VALIDATION_ERROR', 'Request timeout must be positive.');
    const {base, token} = await resolveConnection(env);
    checkSignal(signal);
    const timer = AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)));
    const combined = signal ? AbortSignal.any([signal, timer]) : timer;
    const recoveryDetails = uncertainRequestDetails(body);
    let response;
    try {
      response = await fetchImpl(base + resource, {method: body ? 'POST' : 'GET', headers: {authorization: `Bearer ${token}`, ...(body ? {'content-type': 'application/json'} : {})}, ...(body ? {body: JSON.stringify(body)} : {}), signal: combined, redirect: 'error'});
      const result = await response.json();
      if (!result || typeof result.ok !== 'boolean' ||
          (result.ok ? (body && !Object.hasOwn(result, 'data')) || !response.ok : typeof result.error?.code !== 'string' || typeof result.error?.message !== 'string'))
        throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid response.', {details: recoveryDetails});
      if (!result.ok || !response.ok) {
        const error = result.error || {};
        let details = safeValue(error.details || {}, [token]);
        if (body && (TIMELINE_MUTATION_OPERATIONS.includes(body.operation) || REFERENCE_MUTATION_OPERATIONS.includes(body.operation) || SUBJECT_MUTATION_OPERATIONS.includes(body.operation))) {
          const proven = hasRequestNotAppliedProof({...error, status: response.status}, body.input, {operation: body.operation});
          details = {...(details && typeof details === 'object' && !Array.isArray(details) ? details : {}),
            ...(proven ? {operation: body.operation, requestId: body.input.requestId, submissionMayHaveSucceeded: false} : recoveryDetails)};
          // Never rebind an unverified marker to the original request ID while
          // adding recovery guidance: downstream clients could mistake it for proof.
          if (!proven) delete details.mutationOutcome;
        }
        throw new ClientError(typeof error.code === 'string' ? error.code : 'BACKEND_UNAVAILABLE', typeof error.message === 'string' ? safeValue(error.message, [token]) : 'The backend rejected the request.', {status: response.status, details});
      }
      return result;
    } catch (error) {
      if (error instanceof ClientError) throw error;
      const details = recoveryDetails;
      if (signal?.aborted) throw new ClientError('INTERRUPTED', 'Stopped locally. No remote job was cancelled; an in-flight request may still have completed.', {details});
      if (timer.aborted) throw new ClientError('TIMEOUT', 'The local backend request timed out.', {details});
      throw new ClientError(response ? 'BACKEND_PROTOCOL_ERROR' : 'BACKEND_UNAVAILABLE', response ? 'The backend returned an unreadable response.' : 'The local backend is unavailable. Start or reopen Mioon, then retry safely.', {details});
    }
  }
  async function rpc(operation, input = {}, options) {
    // Parse the exact shared contracts before sending. Required and opt-in request
    // IDs stay caller-owned; this client never creates them and never resubmits.
    if (!Object.hasOwn(schemas, operation)) throw new ClientError('UNKNOWN_OPERATION', 'Unknown operation. Run schema to list available operations.');
    const parsed = parse(operation, input);
    const body = {operation, input: parsed};
    const result = (await request('/api/rpc', {body, ...(operation === 'timeline.export.preflight' ? {timeoutMs: preflightTimeoutMs} : {}), ...options})).data;
    if (LOCAL_MUTATION_OPERATIONS.includes(operation) && !isLocalMutationResponse(operation, parsed, result))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid mutation acknowledgement.', {details: {...uncertainRequestDetails(body), submissionMayHaveSucceeded: true}});
    if (TIMELINE_MUTATION_OPERATIONS.includes(operation) && !isTimelineMutationResponse(operation, parsed, result))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid timeline acknowledgement.', {details: {...uncertainRequestDetails(body), submissionMayHaveSucceeded: true}});
    if (REFERENCE_MUTATION_OPERATIONS.includes(operation) && !isReferenceMutationResponse(operation, parsed, result))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid reference acknowledgement.', {details: {...uncertainRequestDetails(body), submissionMayHaveSucceeded: true}});
    if (SUBJECT_MUTATION_OPERATIONS.includes(operation) && !isSubjectMutationResponse(operation, parsed, result))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid subject acknowledgement.', {details: {...uncertainRequestDetails(body), submissionMayHaveSucceeded: true}});
    if (IMAGE_MUTATION_OPERATIONS.includes(operation) && !isImageMutationResponse(operation, parsed, result))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid image acknowledgement.', {details: {...uncertainRequestDetails(body), submissionMayHaveSucceeded: true}});
    const reviewValid=operation==='image.review.prepare'?isImageReviewPreparationResponse(parsed,result):operation==='image.review.get'?isImageReviewResponse(result)&&result.projectId===parsed.projectId&&result.id===parsed.reviewId:operation==='image.review.list'?isImageReviewListResponse(parsed,result):true;
    if(!reviewValid)throw new ClientError('BACKEND_PROTOCOL_ERROR','Invalid image review response',{details:{submissionMayHaveSucceeded:operation==='image.review.prepare',operation,...(parsed.input?.requestId?{requestId:parsed.input.requestId}:{})}});
    const imageReadValid=operation==='image.profile.list'?isImageProfilesResponse(result)
      :operation==='image.task.get'?isImageTaskResponse(result)&&result.projectId===parsed.projectId&&result.id===parsed.taskId
      :operation==='image.group.get'?isImageGroupResponse(result)&&result.projectId===parsed.projectId&&result.id===parsed.groupId
      :operation==='image.request.get'?isImageRequestResponse(result)&&(result===null||result.projectId===parsed.projectId&&result.requestId===parsed.requestId)
      :['image.task.list','image.group.list','image.version.list'].includes(operation)?isImageListResponse(operation,parsed,result):true;
    if(!imageReadValid)throw new ClientError('BACKEND_PROTOCOL_ERROR','The backend returned an invalid image record.');
    if (operation === 'timeline.export.preflight' && !isExportPreflightResponse(result, parsed))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid export preflight report.');
    return result;
  }
  async function capabilities(options) { return rpc('provider.list', {}, options); }
  async function doctor(options) {
    const health = await request('/health', options);
    const providers = await capabilities(options);
    return {ready: true, clientVersion: VERSION, backend: {service: health.service, version: health.version, sqlite: health.sqlite}, connection: {source: connectionSource(env), localOnly: true, credentialsReloadedPerRequest: true}, providers};
  }
  async function watch(kind, input, {timeoutMs = 60_000, intervalMs = 500, signal, onProgress} = {}) {
    if (!['job', 'export'].includes(kind)) throw new ClientError('VALIDATION_ERROR', 'Watch supports job or export.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000 || !Number.isSafeInteger(intervalMs) || intervalMs < 20 || intervalMs > 60_000) throw new ClientError('VALIDATION_ERROR', 'Watch timeout must be 1–86400000 ms and interval 20–60000 ms.');
    parse(`${kind}.get`, input);
    const deadline = Date.now() + timeoutMs;
    let last;
    while (true) {
      checkSignal(signal);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ClientError('WATCH_TIMEOUT', 'Stopped waiting at the deadline. No remote job was cancelled.', {details: {kind, id: input[`${kind}Id`], status: last?.status || null}});
      try { last = await rpc(`${kind}.get`, input, {signal, timeoutMs: Math.min(requestTimeoutMs, remaining)}); }
      catch (error) {
        if (error.code === 'TIMEOUT' && Date.now() >= deadline) throw new ClientError('WATCH_TIMEOUT', 'Stopped waiting at the deadline. No remote job was cancelled.', {details: {kind, id: input[`${kind}Id`], status: last?.status || null}});
        throw error;
      }
      onProgress?.({kind, id: last.id, status: last.status, progress: last.progress ?? null});
      if (last.status === 'succeeded') return last;
      if (['failed', 'cancelled'].includes(last.status)) throw new ClientError(last.status === 'failed' ? 'OPERATION_FAILED' : 'OPERATION_CANCELLED', `${kind === 'job' ? 'Generation' : 'Export'} ${last.status}.`, {details: {kind, id: last.id, status: last.status, error: last.error || null, allowedActions: last.allowedActions || []}});
      try { await pause(Math.min(intervalMs, Math.max(0, deadline - Date.now())), undefined, {signal}); }
      catch { throw interrupted(); }
    }
  }
  return {rpc, capabilities, doctor, watch};
}
