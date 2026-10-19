import {isTimelineClipLoudnessResponse, TIMELINE_CLIP_LOUDNESS_LIMITS} from '@mioon/contracts/timeline-clip-loudness';
import {readTimelineClipLoudnessEnvelope} from './timeline-clip-loudness.ts';
export {measureTimelineClipLoudness} from './timeline-clip-loudness.ts';
import {isTimelineImageSourceInspection,isTimelineJpegSourceInspection} from '../../contracts/src/timeline-colour.ts';
import {isProxy} from 'node:util/types';
import {isLookPackInspectInput,isLookPackInspectResponse} from '@mioon/contracts';
import {isTimelineColourSourceInspection} from '@mioon/contracts/timeline-colour';
import {isLutRpcResponse} from './lut-resources.ts';
import {readTimelineLoudnessApplyEnvelope,TIMELINE_LOUDNESS_APPLY_CLIENT_MS} from './timeline-loudness-apply.ts';
import {isAudioPreviewPlan} from '@mioon/contracts/timeline-audio-preview';
import {isContinuousAudioPlan} from '@mioon/contracts/timeline-audio-continuous';
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
import type {OperationName} from '@mioon/contracts';
import {schemas, descriptions, parse, operationEffect, effectAnnotations, LOCAL_MUTATION_OPERATIONS, isLocalMutationResponse, isExportPreflightResponse, isTimelineFormatReadResponse, TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, SUBJECT_MUTATION_OPERATIONS, isSubjectMutationResponse, hasRequestNotAppliedProof} from '@mioon/contracts';
import {resolveConnection, connectionSource, ConnectionError, type ConnectionSource, type LocalConnection} from './connection.ts';
import {IMAGE_MUTATION_OPERATIONS,isImageMutationResponse,isImageTaskResponse,isImageGroupResponse,isImageRequestResponse,isImageProfilesResponse,isImageListResponse} from '@mioon/contracts';
import {canonicalImageInput,isComfyObserveResponse,isComfyRemoteResponse} from '@mioon/contracts';
import {FRAME_MUTATION_OPERATIONS,frameSchemas,canonicalFrameInput,isFrameMutationResponse,isFrameTaskResponse,isFrameRequestResponse,isFrameListResponse} from '@mioon/contracts';
import {isTimelineExportCapabilitiesResponse} from '@mioon/contracts';
import {isExportSamplePeakResponse, EXPORT_SAMPLE_PEAK_LIMITS} from '@mioon/contracts/export-sample-peak';
import {isExportLoudnessResponse, EXPORT_LOUDNESS_LIMITS} from '@mioon/contracts/export-loudness';
import {isTimelineMixLoudnessResponse, TIMELINE_MIX_LOUDNESS_LIMITS} from '@mioon/contracts/timeline-mix-loudness';
import {readTimelineMixLoudnessEnvelope} from './timeline-mix-loudness.ts';
export {prepareTimelineMixLoudness} from './timeline-mix-loudness.ts';
import {isSubjectGenerationResponse,isSubjectGenerationRetryResponse} from '@mioon/contracts';

export {schemas, descriptions, resolveConnection, effectAnnotations};
export const VERSION = applicationPackage.version;
export const EXIT_CODES = Object.freeze({success: 0, unexpected: 1, validation: 2, conflict: 3, unavailable: 4, timeout: 5, operationFailed: 6, interrupted: 130});
export const discoverySchemas = {
  doctor: z.object({}).strict(),
  capabilities: z.object({}).strict(),
  schema: z.object({operation: z.enum(Object.keys(schemas) as [string, ...string[]]).optional()}).strict(),
};
export const discoveryEffects = Object.freeze({
  doctor: Object.freeze({...operationEffect('provider.list'), notes:'Reads authenticated local health and current provider capabilities; no external provider call or mutation.'}),
  capabilities: operationEffect('provider.list'),
  schema: Object.freeze({...operationEffect('provider.list'), notes:'Reads static schemas and advisory effect metadata in this process; no backend, credentials or network required.'}),
});
export interface ClientErrorOptions {status?: number; details?: unknown; exitCode?: number}
export class ClientError extends Error {
  declare code: string;
  declare status: number | undefined;
  declare details: unknown;
  declare exitCode: number;
  constructor(code: string, message: string, {status, details = {}, exitCode}: ClientErrorOptions = {}) {
    super(message); this.name = 'ClientError'; this.code = code; this.status = status; this.details = details;
    this.exitCode = exitCode ?? errorExitCode(this);
  }
}
// Explicit invocation-only identity. Undefined preserves the v24 wire shape;
// there is no backend discovery, client default, credential-file or reconnect
// fallback. CLI/MCP also use this parser before dispatching any request.
export function workspaceOriginOptions(value: unknown): {expectedWorkspaceOrigin?: string} {
  let origin: string | undefined;
  try { origin = parseExpectedWorkspaceOrigin(value); }
  catch { throw new ClientError('VALIDATION_ERROR', 'Workspace origin must be an explicit UUID. Preserve the origin saved with an existing request.'); }
  return origin === undefined ? {} : {expectedWorkspaceOrigin: origin};
}
export function errorExitCode(error: unknown): number {
  const failure = error as {exitCode?: unknown; code?: unknown; name?: unknown; status?: unknown};
  if (Number.isInteger(failure.exitCode)) return failure.exitCode as number;
  if (failure.code === 'INTERRUPTED' || failure.name === 'AbortError') return EXIT_CODES.interrupted;
  if (typeof failure.code === 'string' && ['TIMEOUT', 'WATCH_TIMEOUT'].includes(failure.code)) return EXIT_CODES.timeout;
  if (failure.status === 409 || typeof failure.code === 'string' && /CONFLICT/.test(failure.code)) return EXIT_CODES.conflict;
  if (typeof failure.code === 'string' && ['CONNECTION_CONFIG_ERROR', 'BACKEND_UNAVAILABLE', 'BACKEND_PROTOCOL_ERROR', 'UNAUTHORIZED', 'ORIGIN_REJECTED'].includes(failure.code) || failure.status === 401 || failure.status === 503) return EXIT_CODES.unavailable;
  if (typeof failure.code === 'string' && ['VALIDATION_ERROR', 'UNKNOWN_OPERATION', 'FILE_READ_ERROR', 'FILE_TOO_LARGE', 'INVALID_JSON'].includes(failure.code)) return EXIT_CODES.validation;
  if (failure.code && failure.code !== 'INTERNAL_ERROR') return EXIT_CODES.operationFailed;
  return EXIT_CODES.unexpected;
}
const privateKeys = /^(?:token|accessToken|access_token|apiKey|api_key|secret|password|authorization|cookie|tokenFile|connectionFile)$/i;
export function safeValue(value: string, secrets?: string[]): string;
export function safeValue(value: unknown, secrets?: string[]): unknown;
export function safeValue(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
    return text.replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]');
  }
  if (Array.isArray(value)) return (value as unknown[]).map((item: unknown) => safeValue(item, secrets));
  // Drop sensitive field names rather than renaming them into colliding keys.
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !privateKeys.test(key) && safeValue(key, secrets) === key).map(([key, item]) => [key, safeValue(item, secrets)]));
  return value;
}
export interface ClientErrorEnvelope {ok: false; error: {code: string; message: unknown; details: unknown; retryable: false}}
export function errorEnvelope(error: unknown): ClientErrorEnvelope {
  const failure = error as {code?: unknown; status?: unknown; message?: unknown; details?: unknown};
  const known = error instanceof ClientError || error instanceof ConnectionError || (typeof failure.code === 'string' && Number.isInteger(failure.status));
  return {ok: false, error: {code: known ? failure.code as string : 'INTERNAL_ERROR', message: known ? safeValue(failure.message) : 'The client could not complete the operation.', details: known ? safeValue(failure.details || {}) : {}, retryable: false}};
}
export function successEnvelope<T>(data: T): {ok: true; data: T} { return {ok: true, data}; }
const objectBranches = (schema: unknown): boolean => {
  if (!schema || typeof schema !== 'object') return false;
  const candidate = schema as Record<string, unknown>;
  if (candidate.type === 'object') return true;
  return ['anyOf','oneOf'].some(key => {
    const child = candidate[key];
    return Array.isArray(child) && child.length>0 && child.every(objectBranches);
  });
};
export type JsonSchema = Record<string, unknown>;
export function jsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const result = zodToJsonSchema(schema, {strictUnions: true, pipeStrategy: 'input'}) as unknown as JsonSchema;
  // MCP requires object input at the root. Retain each exact discriminated
  // branch rather than flattening properties or weakening strictness.
  return result.type===undefined&&objectBranches(result)?{...result,type:'object'}:result;
}
const requiresField = (schema: unknown, field: string): boolean => {
  if (!schema || typeof schema !== 'object') return false;
  const candidate = schema as Record<string, unknown>;
  if (Array.isArray(candidate.required) && candidate.required.includes(field)) return true;
  return ['anyOf','oneOf'].some(key => {
    const child = candidate[key];
    return Array.isArray(child) && child.length>0 && child.every(branch=>requiresField(branch,field));
  });
};
const operationSchemas = schemas as Record<string, z.ZodTypeAny>;
const operationDescriptions = descriptions as Record<string, string>;
export interface OperationDefinition {
  operation: string;
  toolName: string;
  command: string;
  description: string;
  inputSchema: JsonSchema;
  requiresRequestId: boolean;
  effects: ReturnType<typeof operationEffect>;
}
export function operationDefinition(operation: string): OperationDefinition {
  if (!Object.hasOwn(schemas, operation)) throw new ClientError('UNKNOWN_OPERATION', 'Unknown operation. Run schema to list available operations.');
  const inputSchema = jsonSchema(operationSchemas[operation]);
  return {operation, toolName: operation.replaceAll('.', '_'), command: operation.replaceAll('.', ' '), description: operationDescriptions[operation] || operation, inputSchema, requiresRequestId: requiresField(inputSchema,'requestId'), effects: operationEffect(operation)};
}
export interface DiscoverySchemaResult {version: string; operations: OperationDefinition[]; validation: string}
export function discoverSchema(input: unknown = {}): OperationDefinition | DiscoverySchemaResult {
  const parsed = validateDiscovery('schema', input);
  return parsed.operation ? operationDefinition(parsed.operation) : {version: VERSION, operations: Object.keys(schemas).map(operation => operationDefinition(operation)), validation: 'Shared runtime Zod schemas are authoritative, including refinements that JSON Schema cannot express.'};
}
export function validateDiscovery(name: string, input: unknown): {operation?: string} {
  const discoverySchema = (discoverySchemas as Record<string, z.ZodTypeAny>)[name];
  const result = discoverySchema.safeParse(input);
  if (!result.success) throw new ClientError('VALIDATION_ERROR', 'Invalid discovery arguments.', {details: {issues: result.error.issues.map(issue => ({path: issue.path, message: issue.message}))}});
  return result.data as {operation?: string};
}
function interrupted(): ClientError { return new ClientError('INTERRUPTED', 'Stopped waiting locally. No remote job was cancelled.'); }
function checkSignal(signal: AbortSignal | undefined): void { if (signal?.aborted) throw interrupted(); }
const keyedMutationOperations = new Set<string>([
  ...LOCAL_MUTATION_OPERATIONS, ...TIMELINE_MUTATION_OPERATIONS, ...REFERENCE_MUTATION_OPERATIONS, ...IMAGE_MUTATION_OPERATIONS, ...FRAME_MUTATION_OPERATIONS,
  'generation.submit', 'job.retry', 'export.create', 'image.task.observeRemote', 'image.review.prepare', 'lut.import',
]);
interface RpcBody {operation: string; input: Record<string, unknown>; expectedWorkspaceOrigin?: string}
function uncertainRequestDetails(body: unknown): Record<string, unknown> {
  if (!body) return {};
  const request = body as {operation?: unknown; input?: {requestId?: unknown; input?: {requestId?: unknown}}};
  // Receipt reads also carry requestId. Only a known keyed write can have an
  // uncertain submission; review preparation keeps its key in the exact intent.
  const requestId = request.operation === 'image.review.prepare' ? request.input?.input?.requestId : request.input?.requestId;
  return {operation: request.operation, ...(Object.hasOwn(request, 'expectedWorkspaceOrigin') ? {expectedWorkspaceOrigin: (request as {expectedWorkspaceOrigin?: unknown}).expectedWorkspaceOrigin} : {}), ...(typeof request.operation === 'string' && keyedMutationOperations.has(request.operation) && requestId ? {requestId, submissionMayHaveSucceeded: true, recovery: 'Replay the exact original input with the same requestId; do not invent a replacement ID.'} : {})};
}
function comfyObservationNotAccepted(error: unknown, status: number, input: unknown): boolean {
  const statuses: Record<string, number> = {COMFY_MODULE_UNAVAILABLE:503,COMFY_REMOTE_STATE:409,COMFY_REMOTE_REVISION_CONFLICT:409,COMFY_REMOTE_BUSY:409,COMFY_REMOTE_CAPACITY:507};
  const failure = error as {code?: unknown; details?: {observation?: Record<string, unknown>}};
  const proof = failure?.details?.observation;
  const request = input as {projectId?: unknown; taskId?: unknown; requestId?: unknown};
  const code = failure?.code;
  return typeof code === 'string' && Object.hasOwn(statuses, code) && status===statuses[code] && proof?.outcome==='not_accepted'&&
    proof.operation==='image.task.observeRemote'&&proof.projectId===request.projectId&&proof.taskId===request.taskId&&proof.requestId===request.requestId&&
    proof.inputHash===createHash('sha256').update(canonicalImageInput(input)).digest('hex');
}


const frameRefusalStatuses: Record<string, number> = Object.freeze({FRAME_CAPACITY:507,FRAME_QUEUE_FULL:409,FRAME_REVISION_CONFLICT:409,
  FRAME_STATE_CONFLICT:409,FRAME_SOURCE_INVALID:409,FRAME_SOURCE_CHANGED:409,FRAME_RESULT_INVALID:409});
function frameNotAccepted(error: unknown, status: number, operation: string, input: unknown): boolean {
  const failure = error as {code?: unknown; details?: {frameOutcome?: Record<string, unknown>}};
  const proof = failure?.details?.frameOutcome;
  const request = input as {projectId?: unknown; requestId?: unknown};
  const code = failure?.code;
  // Status/message alone never settle an unknown write. Match the same bounded
  // proof as the renderer against the exact operation and canonical input.
  return (FRAME_MUTATION_OPERATIONS as readonly string[]).includes(operation) && typeof code === 'string' && Object.hasOwn(frameRefusalStatuses, code) &&
    status === frameRefusalStatuses[code] && (frameSchemas as Record<string, z.ZodTypeAny>)[operation].safeParse(input).success &&
    Boolean(proof) && typeof proof === 'object' && !Array.isArray(proof) &&
    Object.keys(proof).sort().join(',') === 'inputHash,operation,projectId,requestId,status' &&
    proof.status === 'not_accepted' && proof.operation === operation && proof.projectId === request.projectId &&
    proof.requestId === request.requestId && typeof proof.inputHash === 'string' && /^[a-f0-9]{64}$/.test(proof.inputHash) &&
    proof.inputHash === createHash('sha256').update(canonicalFrameInput(input)).digest('hex');
}

export interface ClientOptions {env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; requestTimeoutMs?: number}
export interface RequestOptions {body?: RpcBody; signal?: AbortSignal; timeoutMs?: number}
export interface RpcOptions {signal?: AbortSignal; timeoutMs?: number; expectedWorkspaceOrigin?: string}
export interface WatchOptions {timeoutMs?: number; intervalMs?: number; signal?: AbortSignal; onProgress?: (progress: WatchProgress) => void}
export interface WatchProgress {kind: string; id: string; status: string; progress: unknown}
export interface WatchRecord {id: string; status: string; progress?: unknown; error?: unknown; allowedActions?: unknown; [key: string]: unknown}
export interface DoctorReport {
  ready: true;
  clientVersion: string;
  backend: {service: unknown; version: unknown; sqlite: unknown};
  connection: {source: ConnectionSource; localOnly: true; credentialsReloadedPerRequest: true};
  providers: unknown;
}
export interface Client {
  rpc<T = unknown>(operation: string, input?: unknown, options?: RpcOptions): Promise<T>;
  capabilities<T = unknown>(options?: RpcOptions): Promise<T>;
  doctor(options?: RpcOptions): Promise<DoctorReport>;
  watch(kind: 'job' | 'export', input: Record<string, unknown>, options?: WatchOptions): Promise<WatchRecord>;
}
export function createClient(clientOptions: ClientOptions = {}): Client {
  const {env = process.env, fetchImpl = fetch, requestTimeoutMs = 30_000} = clientOptions;
  // These bounded advisory reads need transport grace after local analysis.
  // Every other default and explicit caller timeout remains unchanged.
  const preflightTimeoutMs = Object.hasOwn(clientOptions, 'requestTimeoutMs') ? requestTimeoutMs : 35_000;
  const samplePeakTimeoutMs = Object.hasOwn(clientOptions, 'requestTimeoutMs') ? requestTimeoutMs : EXPORT_SAMPLE_PEAK_LIMITS.clientTimeoutMs;
  const loudnessTimeoutMs = Object.hasOwn(clientOptions, 'requestTimeoutMs') ? requestTimeoutMs : EXPORT_LOUDNESS_LIMITS.clientTimeoutMs;
  const loudnessApplyTimeoutMs = Object.hasOwn(clientOptions, 'requestTimeoutMs') ? requestTimeoutMs : TIMELINE_LOUDNESS_APPLY_CLIENT_MS;
  const clipLoudnessTimeoutMs = Object.hasOwn(clientOptions, 'requestTimeoutMs') ? requestTimeoutMs : TIMELINE_CLIP_LOUDNESS_LIMITS.clientTimeoutMs;
  const mixLoudnessTimeoutMs = Object.hasOwn(clientOptions, 'requestTimeoutMs') ? requestTimeoutMs : TIMELINE_MIX_LOUDNESS_LIMITS.clientTimeoutMs;
  async function request(resource: string, {body, signal, timeoutMs = requestTimeoutMs}: RequestOptions = {}): Promise<unknown> {
    checkSignal(signal);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new ClientError('VALIDATION_ERROR', 'Request timeout must be positive.');
    const connection: LocalConnection = await resolveConnection(env);
    const {base, token} = connection;
    checkSignal(signal);
    const timer = AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)));
    const combined = signal ? AbortSignal.any([signal, timer]) : timer;
    const recoveryDetails = uncertainRequestDetails(body);
    let response: Response | undefined;
    try {
      response = await fetchImpl(base + resource, {method: body ? 'POST' : 'GET', headers: {authorization: `Bearer ${token}`, ...(body ? {'content-type': 'application/json'} : {})}, ...(body ? {body: JSON.stringify(body)} : {}), signal: combined, redirect: 'error'});
      const result = (body?.operation === 'timeline.clip.loudness' ? await readTimelineClipLoudnessEnvelope(response, combined) : body?.operation === 'timeline.loudness.apply' ? await readTimelineLoudnessApplyEnvelope(response, combined) : body?.operation === 'timeline.loudness.prepare' ? await readTimelineMixLoudnessEnvelope(response, combined) : await response.json()) as unknown;
      const envelope = result as {ok?: unknown; data?: unknown; error?: {code?: unknown; message?: unknown; details?: unknown}} | null | undefined;
      if (!envelope || typeof envelope.ok !== 'boolean' ||
          (envelope.ok ? (body && !Object.hasOwn(envelope, 'data')) || !response.ok : typeof envelope.error?.code !== 'string' || typeof envelope.error?.message !== 'string'))
        throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid response.', {details: recoveryDetails});
      if (!envelope.ok || !response.ok) {
        const failure = (envelope.error ?? {}) as {code?: unknown; message?: unknown; details?: unknown};
        let details = safeValue(failure.details || {}, [token]);
        if (body && ((TIMELINE_MUTATION_OPERATIONS as readonly string[]).includes(body.operation) || (REFERENCE_MUTATION_OPERATIONS as readonly string[]).includes(body.operation) || (SUBJECT_MUTATION_OPERATIONS as readonly string[]).includes(body.operation))) {
          const proven = hasRequestNotAppliedProof({...failure, status: response.status}, body.input, {operation: body.operation});
          details = {...(details && typeof details === 'object' && !Array.isArray(details) ? details : {}),
            ...(proven ? {operation: body.operation, requestId: body.input.requestId, submissionMayHaveSucceeded: false} : recoveryDetails)};
          // Never rebind an unverified marker to the original request ID while
          // adding recovery guidance: downstream clients could mistake it for proof.
          if (!proven) delete (details as Record<string, unknown>).mutationOutcome;
        }
        if (body && (FRAME_MUTATION_OPERATIONS as readonly string[]).includes(body.operation)) {
          const mutation = (FRAME_MUTATION_OPERATIONS as readonly string[]).includes(body.operation);
          const proven = mutation && frameNotAccepted(failure, response.status, body.operation, body.input);
          details = {...(details && typeof details === 'object' && !Array.isArray(details) ? details : {}),
            ...(mutation ? proven ? {operation:body.operation,requestId:body.input.requestId,submissionMayHaveSucceeded:false} : recoveryDetails : {})};
          if (!proven) delete (details as Record<string, unknown>).frameOutcome;
          else delete (details as Record<string, unknown>).recovery;
        }
        if(body?.operation==='image.task.observeRemote'){
          const proven=comfyObservationNotAccepted(failure,response.status,body.input);
          details={...(details&&typeof details==='object'&&!Array.isArray(details)?details:{}),
            ...(proven?{operation:body.operation,requestId:body.input.requestId,submissionMayHaveSucceeded:false}:recoveryDetails)};
          if(!proven)delete (details as Record<string, unknown>).observation;
        }
        if (body?.operation==='lut.import') details={...(details&&typeof details==='object'&&!Array.isArray(details)?details:{}),...recoveryDetails};
        if (body && ['RESTORE_OPERATION_UNAVAILABLE', 'RESTORED_RECORD_HELD', 'RESTORE_WORKSPACE_ORIGIN_REQUIRED', 'RESTORE_WORKSPACE_ORIGIN_MISMATCH', 'RESTORE_BACKUP_UNAVAILABLE'].includes(failure.code as string)) {
          details = {...(details && typeof details === 'object' && !Array.isArray(details) ? details : {}), ...recoveryDetails};
          delete (details as Record<string, unknown>).mutationOutcome; delete (details as Record<string, unknown>).frameOutcome; delete (details as Record<string, unknown>).observation;
        }
        throw new ClientError(typeof failure.code === 'string' ? safeValue(failure.code, [token]) : 'BACKEND_UNAVAILABLE', typeof failure.message === 'string' ? safeValue(failure.message, [token]) : 'The backend rejected the request.', {status: response.status, details});
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
  async function rpc<T = unknown>(operation: string, input: unknown = {}, options: RpcOptions = {}): Promise<T> {
    // Parse the exact shared contracts before sending. Required and opt-in request
    // IDs stay caller-owned; this client never creates them and never resubmits.
    if (!Object.hasOwn(schemas, operation)) throw new ClientError('UNKNOWN_OPERATION', 'Unknown operation. Run schema to list available operations.');
    if(operation==='lut.look.inspect'&&(isProxy(input)||!isLookPackInspectInput(input)))throw new ClientError('VALIDATION_ERROR','Expected only a project ID and LUT resource ID.');
    const parsed = parse(operation as OperationName, input) as Record<string, unknown>;
    const {expectedWorkspaceOrigin, ...transportOptions} = options ?? {};
    const body: RpcBody = {operation, input: parsed, ...workspaceOriginOptions(expectedWorkspaceOrigin)};
    const envelope = (await request('/api/rpc', {...(operation === 'timeline.export.preflight' ? {timeoutMs: preflightTimeoutMs} : operation === 'timeline.export.samplePeak' ? {timeoutMs: samplePeakTimeoutMs} : operation === 'timeline.export.loudness' ? {timeoutMs: loudnessTimeoutMs} : operation === 'timeline.clip.loudness' ? {timeoutMs: clipLoudnessTimeoutMs} : operation === 'timeline.loudness.prepare' ? {timeoutMs: mixLoudnessTimeoutMs} : operation === 'timeline.loudness.apply' ? {timeoutMs: loudnessApplyTimeoutMs} : {}), ...transportOptions, body})) as {data?: unknown};
    const result = envelope.data;
    const resultRecord = result as Record<string, unknown> | null | undefined;
    if (operation === 'generation.submit' && Object.hasOwn(parsed, 'subjectVersionId') && !isSubjectGenerationResponse(operation, parsed, result))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid subject-generation acknowledgement.', {details: {...uncertainRequestDetails(body), submissionMayHaveSucceeded: true}});
    const retry = result as {snapshot?: {subjectReference?: unknown; subjectVersionId?: unknown; referenceBindings?: unknown; referenceAssets?: unknown}} | null | undefined;
    if (operation === 'job.retry' && retry?.snapshot && (Object.hasOwn(retry.snapshot, 'subjectReference') || Object.hasOwn(retry.snapshot, 'subjectVersionId') ||
      [retry.snapshot.referenceBindings,retry.snapshot.referenceAssets].some(items => Array.isArray(items) && items.some((item: unknown) => ((item as {role?: unknown} | null | undefined)?.role) === 'subject_reference'))) && !isSubjectGenerationRetryResponse(parsed, result))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid subject-generation retry acknowledgement.', {details: {...uncertainRequestDetails(body), submissionMayHaveSucceeded: true}});
    if ((LOCAL_MUTATION_OPERATIONS as readonly string[]).includes(operation) && !isLocalMutationResponse(operation, parsed, result))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid mutation acknowledgement.', {details: {...uncertainRequestDetails(body), submissionMayHaveSucceeded: true}});
    if ((TIMELINE_MUTATION_OPERATIONS as readonly string[]).includes(operation) && !isTimelineMutationResponse(operation, parsed, result))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid timeline acknowledgement.', {details: {...uncertainRequestDetails(body), submissionMayHaveSucceeded: true}});
    if ((REFERENCE_MUTATION_OPERATIONS as readonly string[]).includes(operation) && !isReferenceMutationResponse(operation, parsed, result))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid reference acknowledgement.', {details: {...uncertainRequestDetails(body), submissionMayHaveSucceeded: true}});
    if ((SUBJECT_MUTATION_OPERATIONS as readonly string[]).includes(operation) && !isSubjectMutationResponse(operation, parsed, result))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid subject acknowledgement.', {details: {...uncertainRequestDetails(body), submissionMayHaveSucceeded: true}});
    if ((IMAGE_MUTATION_OPERATIONS as readonly string[]).includes(operation) && !isImageMutationResponse(operation, parsed, result))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid image acknowledgement.', {details: {...uncertainRequestDetails(body), submissionMayHaveSucceeded: true}});
    if ((FRAME_MUTATION_OPERATIONS as readonly string[]).includes(operation) && !isFrameMutationResponse(operation, parsed, result))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid frame acknowledgement.', {details: uncertainRequestDetails(body)});
    const frameReadValid = operation === 'frame.task.get' ? isFrameTaskResponse(result) && resultRecord?.projectId === parsed.projectId && resultRecord?.id === parsed.taskId
      : operation === 'frame.request.get' ? isFrameRequestResponse(result) && (result === null || resultRecord?.projectId === parsed.projectId && resultRecord?.requestId === parsed.requestId)
      : operation === 'frame.task.list' ? isFrameListResponse(operation, parsed, result) : true;
    if (!frameReadValid) throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid frame record.');
    if(operation==='image.task.observeRemote'&&!isComfyObserveResponse(parsed,result))
      throw new ClientError('BACKEND_PROTOCOL_ERROR','The backend returned an invalid ComfyUI observation acknowledgement.',{details:{...uncertainRequestDetails(body),submissionMayHaveSucceeded:true}});
    if(operation==='image.task.remote.get'&&(!isComfyRemoteResponse(result)||resultRecord?.projectId!==parsed.projectId||resultRecord?.taskId!==parsed.taskId))
      throw new ClientError('BACKEND_PROTOCOL_ERROR','The backend returned an invalid ComfyUI remote record.');
    const reviewValid=operation==='image.review.prepare'?isImageReviewPreparationResponse(parsed,result):operation==='image.review.get'?isImageReviewResponse(result)&&resultRecord?.projectId===parsed.projectId&&resultRecord?.id===parsed.reviewId:operation==='image.review.list'?isImageReviewListResponse(parsed,result):true;
    if(!reviewValid)throw new ClientError('BACKEND_PROTOCOL_ERROR','Invalid image review response',{details:operation==='image.review.prepare'?uncertainRequestDetails(body):{submissionMayHaveSucceeded:false,operation}});
    const imageReadValid=operation==='image.profile.list'?isImageProfilesResponse(result,parsed)
      :operation==='image.task.get'?isImageTaskResponse(result)&&resultRecord?.projectId===parsed.projectId&&resultRecord?.id===parsed.taskId
      :operation==='image.group.get'?isImageGroupResponse(result)&&resultRecord?.projectId===parsed.projectId&&resultRecord?.id===parsed.groupId
      :operation==='image.request.get'?isImageRequestResponse(result)&&(result===null||resultRecord?.projectId===parsed.projectId&&resultRecord?.requestId===parsed.requestId)
      :['image.task.list','image.group.list','image.version.list'].includes(operation)?isImageListResponse(operation,parsed,result):true;
    if(!imageReadValid)throw new ClientError('BACKEND_PROTOCOL_ERROR','The backend returned an invalid image record.');
    if (operation === 'export.get' && !isTimelineExportFloatReadResponse(result, parsed.exportId as string, isTimelineRenderRecord))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid float export report.');
    if (operation === 'timeline.colour.jpeg.inspect' && !isTimelineJpegSourceInspection(result, parsed))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The JPEG source inspection reply does not match the request.');
    if (operation === 'timeline.colour.image.inspect' && !isTimelineImageSourceInspection(result, parsed))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid image colour inspection.', {details:{operation}});
    if (operation === 'timeline.colour.source.inspect' && !isTimelineColourSourceInspection(result, parsed))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid source colour inspection.', {details:{operation}});
    if (operation === 'timeline.format.get' && !isTimelineFormatReadResponse(result, parsed))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid timeline format record.');
    if (operation === 'timeline.export.preflight' && !isExportPreflightResponse(result, parsed))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid export preflight report.');
    if(operation==='lut.look.inspect'&&!isLookPackInspectResponse(result,parsed))
      throw new ClientError('BACKEND_PROTOCOL_ERROR','The backend returned an invalid Look Pack inspection.',{details:{operation}});
    if (['lut.import','lut.list','lut.inspect'].includes(operation) && !isLutRpcResponse(operation,parsed,result))
      throw new ClientError('BACKEND_PROTOCOL_ERROR','The backend returned an invalid LUT resource response.',{details:operation==='lut.import'?uncertainRequestDetails(body):{operation}});
    if (operation === 'workspace.restore.inspect' && !isWorkspaceRestoreInspection(result))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid restored workspace summary.');
    if (operation === 'workspace.backup.inspect' && !isWorkspaceBackupInspection(result))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid workspace backup summary.');
    if (operation === 'timeline.export.capabilities' && !isTimelineExportCapabilitiesResponse(result, parsed))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid export capability report.');
    if (operation === 'timeline.audioPreview.plan' && !isAudioPreviewPlan(result, parsed as unknown as Parameters<typeof isAudioPreviewPlan>[1]))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'Backend returned an invalid sound-audition plan.');
    if (operation === 'timeline.audioPreview.continuousPlan' && !isContinuousAudioPlan(result, parsed as unknown as Parameters<typeof isContinuousAudioPlan>[1]))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'Backend returned an invalid continuous audio plan.');
    if (operation === 'timeline.export.samplePeak' && !isExportSamplePeakResponse(result, parsed))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid 已导出文件解码样本峰值 report.');
    if (operation === 'timeline.export.loudness' && !isExportLoudnessResponse(result, parsed))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid exported-file loudness report.');
    if (operation === 'timeline.clip.loudness' && !isTimelineClipLoudnessResponse(result, parsed))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'Invalid selected saved-clip loudness response.', {status: 502});
    if (operation === 'timeline.loudness.prepare' && !isTimelineMixLoudnessResponse(result, parsed))
      throw new ClientError('BACKEND_PROTOCOL_ERROR', 'The backend returned an invalid saved-timeline loudness report.');
    return result as T;
  }
  async function capabilities<T = unknown>(options?: RpcOptions): Promise<T> { return rpc<T>('provider.list', {}, options); }
  async function doctor(options?: RpcOptions): Promise<DoctorReport> {
    const health = await request('/health', options) as {service: unknown; version: unknown; sqlite: unknown};
    const providers = await capabilities(options);
    return {ready: true, clientVersion: VERSION, backend: {service: health.service, version: health.version, sqlite: health.sqlite}, connection: {source: connectionSource(env), localOnly: true, credentialsReloadedPerRequest: true}, providers};
  }
  async function watch(kind: 'job' | 'export', input: Record<string, unknown>, {timeoutMs = 60_000, intervalMs = 500, signal, onProgress}: WatchOptions = {}): Promise<WatchRecord> {
    if (!['job', 'export'].includes(kind)) throw new ClientError('VALIDATION_ERROR', 'Watch supports job or export.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000 || !Number.isSafeInteger(intervalMs) || intervalMs < 20 || intervalMs > 60_000) throw new ClientError('VALIDATION_ERROR', 'Watch timeout must be 1–86400000 ms and interval 20–60000 ms.');
    parse(`${kind}.get`, input);
    const deadline = Date.now() + timeoutMs;
    let last: WatchRecord | undefined;
    while (true) {
      checkSignal(signal);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ClientError('WATCH_TIMEOUT', 'Stopped waiting at the deadline. No remote job was cancelled.', {details: {kind, id: input[`${kind}Id`], status: last?.status || null}});
      try { last = await rpc<WatchRecord>(`${kind}.get`, input, {signal, timeoutMs: Math.min(requestTimeoutMs, remaining)}); }
      catch (error) {
        const failure = error as {code?: unknown};
        if (failure.code === 'TIMEOUT' && Date.now() >= deadline) throw new ClientError('WATCH_TIMEOUT', 'Stopped waiting at the deadline. No remote job was cancelled.', {details: {kind, id: input[`${kind}Id`], status: last?.status || null}});
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
