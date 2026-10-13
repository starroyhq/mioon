import {isTimelineExportFloatReadResponse} from '@mioon/contracts/timeline-export-float';
import {isTimelineRenderRecord} from '@mioon/contracts';
import {parseExpectedWorkspaceOrigin, isWorkspaceRestoreInspection} from '@mioon/contracts';
import {isWorkspaceBackupInspection} from '@mioon/contracts';
import {isImageReviewResponse,isImageReviewPreparationResponse,isImageReviewListResponse} from '@mioon/contracts';
import {setTimeout as pause} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {zodToJsonSchema} from 'zod-to-json-schema';
import applicationPackage from '../../../package.json' with {type: 'json'};
import {schemas, descriptions, parse, operationEffect, effectAnnotations, LOCAL_MUTATION_OPERATIONS, isLocalMutationResponse, isExportPreflightResponse, isTimelineFormatReadResponse, TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, SUBJECT_MUTATION_OPERATIONS, isSubjectMutationResponse, hasRequestNotAppliedProof} from '@mioon/contracts';
import {resolveConnection, connectionSource, ConnectionError} from './connection.mjs';
import {IMAGE_MUTATION_OPERATIONS,isImageMutationResponse,isImageTaskResponse,isImageGroupResponse,isImageRequestResponse,isImageProfilesResponse,isImageListResponse} from '@mioon/contracts';
import {canonicalImageInput,isComfyObserveResponse,isComfyRemoteResponse} from '@mioon/contracts';
import {FRAME_MUTATION_OPERATIONS,frameSchemas,canonicalFrameInput,isFrameMutationResponse,isFrameTaskResponse,isFrameRequestResponse,isFrameListResponse} from '@mioon/contracts';
import {isTimelineExportCapabilitiesResponse} from '@mioon/contracts';
import {isExportSamplePeakResponse, EXPORT_SAMPLE_PEAK_LIMITS} from '@mioon/contracts/export-sample-peak';
import {isSubjectGenerationResponse,isSubjectGenerationRetryResponse} from '@mioon/contracts';

export {schemas, descriptions, resolveConnection, effectAnnotations};
export const VERSION = applicationPackage.version;
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
// Explicit invocation-only identity. Undefined preserves the v24 wire shape;
// there is no backend discovery, client default, credential-file or reconnect
// fallback. CLI/MCP also use this parser before dispatching any request.
export function workspaceOriginOptions(value) {
  let origin;
  try { origin = parseExpectedWorkspaceOrigin(value); }
  catch { throw new ClientError('VALIDATION_ERROR', 'Workspace origin must be an explicit UUID. Preserve the origin saved with an existing request.'); }
  return origin === undefined ? {} : {expectedWorkspaceOrigin: origin};
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
  // Drop sensitive field names rather than renaming them into colliding keys.
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !privateKeys.test(key) && safeValue(key, secrets) === key).map(([key, item]) => [key, safeValue(item, secrets)]));
  return value;
}
export function errorEnvelope(error) {
  const known = error instanceof ClientError || error instanceof ConnectionError || (typeof error.code === 'string' && Number.isInteger(error.status));
  return {ok: false, error: {code: known ? error.code : 'INTERNAL_ERROR', message: known ? safeValue(error.message) : 'The client could not complete the operation.', details: known ? safeValue(error.details || {}) : {}, retryable: false}};
}
export const successEnvelope = data => ({ok: true, data});
const objectBranches = schema => schema?.type === 'object' || ['anyOf','oneOf'].some(key=>
  Array.isArray(schema?.[key])&&schema[key].length>0&&schema[key].every(objectBranches));
export function jsonSchema(schema) {
  const result=zodToJsonSchema(schema, {strictUnions: true, pipeStrategy: 'input'});
  // MCP requires object input at the root. Retain each exact discriminated
  // branch rather than flattening properties or weakening strictness.
  return result.type===undefined&&objectBranches(result)?{...result,type:'object'}:result;
}
const requiresField = (schema,field) => schema.required?.includes(field) || ['anyOf','oneOf'].some(key=>
  Array.isArray(schema[key])&&schema[key].length>0&&schema[key].every(branch=>requiresField(branch,field)));
export function operationDefinition(operation) {
  if (!Object.hasOwn(schemas, operation)) throw new ClientError('UNKNOWN_OPERATION', 'Unknown operation. Run schema to list available operations.');
  const inputSchema = jsonSchema(schemas[operation]);
  return {operation, toolName: operation.replaceAll('.', '_'), command: operation.replaceAll('.', ' '), description: descriptions[operation] || operation, inputSchema, requiresRequestId: requiresField(inputSchema,'requestId'), effects: operationEffect(operation)};
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
const keyedMutationOperations = new Set([
  ...LOCAL_MUTATION_OPERATIONS, ...TIMELINE_MUTATION_OPERATIONS, ...REFERENCE_MUTATION_OPERATIONS, ...IMAGE_MUTATION_OPERATIONS, ...FRAME_MUTATION_OPERATIONS,
  'generation.submit', 'job.retry', 'export.create', 'image.task.observeRemote', 'image.review.prepare',
]);
function uncertainRequestDetails(body) {
  if (!body) return {};
  // Receipt reads also carry requestId. Only a known keyed write can have an
  // uncertain submission; review preparation keeps its key in the exact intent.
  const requestId = body.operation === 'image.review.prepare' ? body.input?.input?.requestId : body.input?.requestId;
  return {operation: body.operation, ...(Object.hasOwn(body, 'expectedWorkspaceOrigin') ? {expectedWorkspaceOrigin: body.expectedWorkspaceOrigin} : {}), ...(keyedMutationOperations.has(body.operation) && requestId ? {requestId, submissionMayHaveSucceeded: true, recovery: 'Replay the exact original input with the same requestId; do not invent a replacement ID.'} : {})};
}
function comfyObservationNotAccepted(error,status,input) {
  const statuses={COMFY_REMOTE_STATE:409,COMFY_REMOTE_REVISION_CONFLICT:409,COMFY_REMOTE_BUSY:409,COMFY_REMOTE_CAPACITY:507};
  const proof=error?.details?.observation;
  return Object.hasOwn(statuses,error?.code)&&status===statuses[error.code]&&proof?.outcome==='not_accepted'&&
    proof.operation==='image.task.observeRemote'&&proof.projectId===input.projectId&&proof.taskId===input.taskId&&proof.requestId===input.requestId&&
    proof.inputHash===createHash('sha256').update(canonicalImageInput(input)).digest('hex');
}


const frameRefusalStatuses = Object.freeze({FRAME_CAPACITY:507,FRAME_QUEUE_FULL:409,FRAME_REVISION_CONFLICT:409,
  FRAME_STATE_CONFLICT:409,FRAME_SOURCE_INVALID:409,FRAME_SOURCE_CHANGED:409,FRAME_RESULT_INVALID:409});
function frameNotAccepted(error, status, operation, input) {
  const proof = error?.details?.frameOutcome;
  // Status/message alone never settle an unknown write. Match the same bounded
  // proof as the renderer against the exact operation and canonical input.
  return FRAME_MUTATION_OPERATIONS.includes(operation) && Object.hasOwn(frameRefusalStatuses, error?.code) &&
    status === frameRefusalStatuses[error.code] && frameSchemas[operation].safeParse(input).success &&
    proof && typeof proof === 'object' && !Array.isArray(proof) &&
    Object.keys(proof).sort().join(',') === 'inputHash,operation,projectId,requestId,status' &&
    proof.status === 'not_accepted' && proof.operation === operation && proof.projectId === input.projectId &&
    proof.requestId === input.requestId && /^[a-f0-9]{64}$/.test(proof.inputHash || '') &&
    proof.inputHash === createHash('sha256').update(canonicalFrameInput(input)).digest('hex');
}

export function createClient(clientOptions = {}) {
  const {env = process.env, fetchImpl = fetch, requestTimeoutMs = 30_000} = clientOptions;
  // Only the new bounded read needs transport grace after its 30s analysis
  // budget. Every old default and explicit caller timeout remains unchanged.
  const preflightTimeoutMs = Object.hasOwn(clientOptions, 'requestTimeoutMs') ? requestTimeoutMs : 35_000;
  const samplePeakTimeoutMs = Object.hasOwn(clientOptions, 'requestTimeoutMs') ? requestTimeoutMs : EXPORT_SAMPLE_PEAK_LIMITS.clientTimeoutMs;
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
        if (body && Object.hasOwn(frameSchemas, body.operation)) {
          const mutation = FRAME_MUTATION_OPERATIONS.includes(body.operation);
          const proven = mutation && frameNotAccepted(error, response.status, body.operation, body.input);
          details = {...(details && typeof details === 'object' && !Array.isArray(details) ? details : {}),
            ...(mutation ? proven ? {operation:body.operation,requestId:body.input.requestId,submissionMayHaveSucceeded:false} : recoveryDetails : {})};
          if (!proven) delete details.frameOutcome;
          else delete details.recovery;
        }
        if(body?.operation==='image.task.observeRemote'){
          const proven=comfyObservationNotAccepted(error,response.status,body.input);
          details={...(details&&typeof details==='object'&&!Array.isArray(details)?details:{}),
            ...(proven?{operation:body.operation,requestId:body.input.requestId,submissionMayHaveSucceeded:false}:recoveryDetails)};
          if(!proven)delete details.observation;
        }
        if (body && ['RESTORE_OPERATION_UNAVAILABLE', 'RESTORED_RECORD_HELD', 'RESTORE_WORKSPACE_ORIGIN_REQUIRED', 'RESTORE_WORKSPACE_ORIGIN_MISMATCH', 'RESTORE_BACKUP_UNAVAILABLE'].includes(error.code)) {
          details = {...(details && typeof details === 'object' && !Array.isArray(details) ? details : {}), ...recoveryDetails};
          delete details.mutationOutcome; delete details.frameOutcome; delete details.observation;
        }
        throw new ClientError(typeof error.code === 'string' ? safeValue(error.code, [token]) : 'BACKEND_UNAVAILABLE', typeof error.message === 'string' ? safeValue(error.message, [token]) : 'The backend rejected the request.', {status: response.status, details});
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
  async function rpc(operation, input = {}, options = {}) {
    // Parse the exact shared contracts before sending. Required and opt-in request
    // IDs stay caller-owned; this client never creates them and never resubmits.
    if (!Object.hasOwn(schemas, operation)) throw new ClientError('UNKNOWN_OPERATION', 'Unknown operation. Run schema to list available operations.');
    const parsed = parse(operation, input);
    const {expectedWorkspaceOrigin, ...transportOptions} = options ?? {};
    const body = {operation, input: parsed, ...workspaceOriginOptions(expectedWorkspaceOrigin)};
    const result = (await request('/api/rpc', {...(operation === 'timeline.export.preflight' ? {timeoutMs: preflightTimeoutMs} : operation === 'timeline.export.samplePeak' ? {timeoutMs: samplePeakTimeoutMs} : {}), ...transportOptions, body})).data;
    if (operation === 'generation.submit' && Object.hasOwn(parsed, 'subjectVersionId') && !isSubjectGenerationResponse(operation, parsed, result))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid subject-generation acknowledgement.', {details: {...uncertainRequestDetails(body), submissionMayHaveSucceeded: true}});
    if (operation === 'job.retry' && result?.snapshot && (Object.hasOwn(result.snapshot, 'subjectReference') || Object.hasOwn(result.snapshot, 'subjectVersionId') ||
      [result.snapshot.referenceBindings,result.snapshot.referenceAssets].some(items => Array.isArray(items) && items.some(item => item?.role === 'subject_reference'))) && !isSubjectGenerationRetryResponse(parsed, result))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid subject-generation retry acknowledgement.', {details: {...uncertainRequestDetails(body), submissionMayHaveSucceeded: true}});
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
    if (FRAME_MUTATION_OPERATIONS.includes(operation) && !isFrameMutationResponse(operation, parsed, result))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid frame acknowledgement.', {details: uncertainRequestDetails(body)});
    const frameReadValid = operation === 'frame.task.get' ? isFrameTaskResponse(result) && result.projectId === parsed.projectId && result.id === parsed.taskId
      : operation === 'frame.request.get' ? isFrameRequestResponse(result) && (result === null || result.projectId === parsed.projectId && result.requestId === parsed.requestId)
      : operation === 'frame.task.list' ? isFrameListResponse(operation, parsed, result) : true;
    if (!frameReadValid) throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid frame record.');
    if(operation==='image.task.observeRemote'&&!isComfyObserveResponse(parsed,result))
      throw new ClientError('BACKEND_PROTOCOL_ERROR','The backend returned an invalid ComfyUI observation acknowledgement.',{details:{...uncertainRequestDetails(body),submissionMayHaveSucceeded:true}});
    if(operation==='image.task.remote.get'&&(!isComfyRemoteResponse(result)||result.projectId!==parsed.projectId||result.taskId!==parsed.taskId))
      throw new ClientError('BACKEND_PROTOCOL_ERROR','The backend returned an invalid ComfyUI remote record.');
    const reviewValid=operation==='image.review.prepare'?isImageReviewPreparationResponse(parsed,result):operation==='image.review.get'?isImageReviewResponse(result)&&result.projectId===parsed.projectId&&result.id===parsed.reviewId:operation==='image.review.list'?isImageReviewListResponse(parsed,result):true;
    if(!reviewValid)throw new ClientError('BACKEND_PROTOCOL_ERROR','Invalid image review response',{details:operation==='image.review.prepare'?uncertainRequestDetails(body):{submissionMayHaveSucceeded:false,operation}});
    const imageReadValid=operation==='image.profile.list'?isImageProfilesResponse(result,parsed)
      :operation==='image.task.get'?isImageTaskResponse(result)&&result.projectId===parsed.projectId&&result.id===parsed.taskId
      :operation==='image.group.get'?isImageGroupResponse(result)&&result.projectId===parsed.projectId&&result.id===parsed.groupId
      :operation==='image.request.get'?isImageRequestResponse(result)&&(result===null||result.projectId===parsed.projectId&&result.requestId===parsed.requestId)
      :['image.task.list','image.group.list','image.version.list'].includes(operation)?isImageListResponse(operation,parsed,result):true;
    if(!imageReadValid)throw new ClientError('BACKEND_PROTOCOL_ERROR','The backend returned an invalid image record.');
    if (operation === 'export.get' && !isTimelineExportFloatReadResponse(result, parsed.exportId, isTimelineRenderRecord))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid float export report.');
    if (operation === 'timeline.format.get' && !isTimelineFormatReadResponse(result, parsed))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid timeline format record.');
    if (operation === 'timeline.export.preflight' && !isExportPreflightResponse(result, parsed))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid export preflight report.');
    if (operation === 'workspace.restore.inspect' && !isWorkspaceRestoreInspection(result))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid restored workspace summary.');
    if (operation === 'workspace.backup.inspect' && !isWorkspaceBackupInspection(result))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid workspace backup summary.');
    if (operation === 'timeline.export.capabilities' && !isTimelineExportCapabilitiesResponse(result, parsed))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid export capability report.');
    if (operation === 'timeline.export.samplePeak' && !isExportSamplePeakResponse(result, parsed))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid 已导出文件解码样本峰值 report.');
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
