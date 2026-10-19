// A reference acknowledgement is the original complete shot and typed edge.
// It is not necessarily current: an old edge may already have been detached or
// replaced. These guards only check caller-verifiable identity and shape;
// project ownership and immutable receipt integrity remain backend checks.
export const REFERENCE_MUTATION_OPERATIONS = Object.freeze(['reference.attach', 'reference.detach'] as const);
export type ReferenceMutationOperation = (typeof REFERENCE_MUTATION_OPERATIONS)[number];
// The 5,000-character prompt and 150-character title need at most 30,900
// JSON-escaped bytes. The remaining fixed fields, UUIDs, three timestamps and
// bounded parameters need under 4 KiB, so 64 KiB includes every valid legacy
// record while placing a conservative limit on retained receipt bytes.
export const REFERENCE_RESPONSE_BYTES = 64 * 1024;

export interface ReferenceShotParameters {scenario?: string; delayMs?: number; seed?: number}
export interface ReferenceShotRecord {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  referenceAssetIds: string[];
  aspectRatio: string;
  duration: number;
  parameters: ReferenceShotParameters;
  position: {x: number; y: number};
  orderIndex: number;
  revision: number;
  selectedVersionId: string | null;
  createdAt: string;
  updatedAt: string;
  lastFrameAssetId?: string | null;
}
export interface ReferenceEdgeRecord {
  id: string;
  projectId: string;
  source: string;
  target: string;
  kind: 'reference';
  role: 'first_frame';
  sourceAssetId: string;
  createdAt: string;
}
export interface ReferenceAttachInput {
  projectId: string;
  requestId: string;
  expectedShotRevision: number;
  sourceNodeId: string;
  targetShotId: string;
  expectedSourceRevision: number;
  role: 'first_frame';
}
export interface ReferenceDetachInput {projectId: string; requestId: string; expectedShotRevision: number; edgeId: string}
export interface ReferenceMutationInput {projectId: string; requestId: string; expectedShotRevision: number}
export interface ReferenceAttachResponse {edge: ReferenceEdgeRecord; shot: ReferenceShotRecord}
export interface ReferenceDetachResponse extends ReferenceAttachResponse {detached: true}
export type ReferenceMutationResponse = ReferenceAttachResponse | ReferenceDetachResponse;

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const text = (value: unknown, min: number, max: number): value is string => typeof value === 'string' && value.length >= min && value.length <= max;
const fields = (value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> => object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const timestamp = (value: unknown): value is string => text(value, 1, 64) && Number.isFinite(Date.parse(value));
const encoder = new TextEncoder();
const withinBound = (value: unknown): boolean => encoder.encode(JSON.stringify(value)).byteLength <= REFERENCE_RESPONSE_BYTES;
const scenarios = ['success', 'failure', 'delay', 'timeout', 'unknown', 'reject', 'download_fail_once', 'rejected_before_accept', 'accepted_then_response_lost', 'poll_timeout_then_recover', 'terminal_failure'];
const oneOf = (value: unknown, allowed: readonly string[]): value is string => typeof value === 'string' && allowed.includes(value);
const aspectRatios = ['9:16', '16:9', '1:1', '3:4', '4:3', '21:9'];
const shotFields = ['id', 'projectId', 'title', 'prompt', 'referenceAssetIds', 'aspectRatio', 'duration', 'parameters', 'position', 'orderIndex', 'revision', 'selectedVersionId', 'createdAt', 'updatedAt'];
const edgeFields = ['id', 'projectId', 'source', 'target', 'kind', 'role', 'sourceAssetId', 'createdAt'];

export function isReferenceShotRecord(value: unknown, {projectId}: {projectId?: string} = {}): value is ReferenceShotRecord {
  if (!fields(value, shotFields, ['lastFrameAssetId']) || !uuid(value.id) || !uuid(value.projectId) ||
      (projectId !== undefined && value.projectId !== projectId) ||
      (Object.hasOwn(value, 'lastFrameAssetId') && value.lastFrameAssetId !== null && !uuid(value.lastFrameAssetId)) ||
      !text(value.title, 1, 150) || !text(value.prompt, 0, 5000) ||
      !Array.isArray(value.referenceAssetIds) || value.referenceAssetIds.length > 8 || !value.referenceAssetIds.every(uuid) ||
      !oneOf(value.aspectRatio, aspectRatios) || !integer(value.duration, 1, 20) ||
      !integer(value.orderIndex, 0) || !integer(value.revision, 1) || !(value.selectedVersionId === null || uuid(value.selectedVersionId)) ||
      !timestamp(value.createdAt) || !timestamp(value.updatedAt) ||
      !fields(value.position, ['x', 'y']) || !Number.isFinite(value.position.x) || !Number.isFinite(value.position.y) ||
      !fields(value.parameters, [], ['scenario', 'delayMs', 'seed'])) return false;
  const parameters = value.parameters;
  if (Object.hasOwn(parameters, 'scenario') && !oneOf(parameters.scenario, scenarios) ||
      Object.hasOwn(parameters, 'delayMs') && !integer(parameters.delayMs, 0, 120000) ||
      // The original shot schema accepts integer seeds without a safe-integer
      // constraint. Preserve those stored values rather than silently clamp.
      Object.hasOwn(parameters, 'seed') && !Number.isInteger(parameters.seed)) return false;
  return withinBound(value);
}

export function isReferenceEdgeRecord(value: unknown, {projectId}: {projectId?: string} = {}): value is ReferenceEdgeRecord {
  return fields(value, edgeFields) && uuid(value.id) && uuid(value.projectId) &&
    (projectId === undefined || value.projectId === projectId) && uuid(value.source) && uuid(value.target) && uuid(value.sourceAssetId) &&
    value.kind === 'reference' && value.role === 'first_frame' && timestamp(value.createdAt) && withinBound(value);
}

export function isReferenceMutationResponse(operation: string, input: unknown, value: unknown): value is ReferenceMutationResponse {
  if (!(REFERENCE_MUTATION_OPERATIONS as readonly string[]).includes(operation) || !object(input) || !uuid(input.projectId) ||
      !text(input.requestId, 8, 200) || !integer(input.expectedShotRevision, 1)) return false;
  const attach = operation === 'reference.attach';
  const attachInput = input as Record<string, unknown> & Partial<ReferenceAttachInput>;
  const inputFields = ['projectId', 'requestId', 'expectedShotRevision', ...(attach ? ['sourceNodeId', 'targetShotId', 'expectedSourceRevision', 'role'] : ['edgeId'])];
  if (!fields(input, inputFields) ||
      (attach ? !uuid(attachInput.sourceNodeId) || !uuid(attachInput.targetShotId) || !integer(attachInput.expectedSourceRevision, 1) || attachInput.role !== 'first_frame' : !uuid(attachInput.edgeId)) ||
      !fields(value, ['edge', 'shot', ...(attach ? [] : ['detached'])]) ||
      !isReferenceShotRecord(value.shot, {projectId: input.projectId}) || !isReferenceEdgeRecord(value.edge, {projectId: input.projectId}) ||
      value.edge.target !== value.shot.id) return false;
  const {edge, shot} = value;
  if (attach) {
    if (edge.source !== attachInput.sourceNodeId || edge.target !== attachInput.targetShotId || edge.role !== attachInput.role ||
        (shot.revision !== input.expectedShotRevision && shot.revision !== input.expectedShotRevision + 1) ||
        shot.referenceAssetIds.length !== 1 || shot.referenceAssetIds[0] !== edge.sourceAssetId) return false;
  } else if (value.detached !== true || edge.id !== attachInput.edgeId || shot.revision !== input.expectedShotRevision + 1 || shot.referenceAssetIds.length !== 0) return false;
  return withinBound(value);
}
