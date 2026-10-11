// A reference acknowledgement is the original complete shot and typed edge.
// It is not necessarily current: an old edge may already have been detached or
// replaced. These guards only check caller-verifiable identity and shape;
// project ownership and immutable receipt integrity remain backend checks.
export const REFERENCE_MUTATION_OPERATIONS = Object.freeze(['reference.attach', 'reference.detach']);
// The 5,000-character prompt and 150-character title need at most 30,900
// JSON-escaped bytes. The remaining fixed fields, UUIDs, three timestamps and
// bounded parameters need under 4 KiB, so 64 KiB includes every valid legacy
// record while placing a conservative limit on retained receipt bytes.
export const REFERENCE_RESPONSE_BYTES = 64 * 1024;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const integer = (value, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const text = (value, min, max) => typeof value === 'string' && value.length >= min && value.length <= max;
const fields = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const timestamp = value => text(value, 1, 64) && Number.isFinite(Date.parse(value));
const encoder = new TextEncoder();
const withinBound = value => encoder.encode(JSON.stringify(value)).byteLength <= REFERENCE_RESPONSE_BYTES;
const scenarios = ['success', 'failure', 'delay', 'timeout', 'unknown', 'reject', 'download_fail_once', 'rejected_before_accept', 'accepted_then_response_lost', 'poll_timeout_then_recover', 'terminal_failure'];
const shotFields = ['id', 'projectId', 'title', 'prompt', 'referenceAssetIds', 'aspectRatio', 'duration', 'parameters', 'position', 'orderIndex', 'revision', 'selectedVersionId', 'createdAt', 'updatedAt'];
const edgeFields = ['id', 'projectId', 'source', 'target', 'kind', 'role', 'sourceAssetId', 'createdAt'];

export function isReferenceShotRecord(value, {projectId} = {}) {
  if (!fields(value, shotFields, ['lastFrameAssetId']) || !uuid(value.id) || !uuid(value.projectId) ||
      (projectId !== undefined && value.projectId !== projectId) ||
      (Object.hasOwn(value, 'lastFrameAssetId') && value.lastFrameAssetId !== null && !uuid(value.lastFrameAssetId)) ||
      !text(value.title, 1, 150) || !text(value.prompt, 0, 5000) ||
      !Array.isArray(value.referenceAssetIds) || value.referenceAssetIds.length > 8 || !value.referenceAssetIds.every(uuid) ||
      !['9:16', '16:9', '1:1', '3:4', '4:3', '21:9'].includes(value.aspectRatio) || !integer(value.duration, 1, 20) ||
      !integer(value.orderIndex, 0) || !integer(value.revision, 1) || !(value.selectedVersionId === null || uuid(value.selectedVersionId)) ||
      !timestamp(value.createdAt) || !timestamp(value.updatedAt) ||
      !fields(value.position, ['x', 'y']) || !Number.isFinite(value.position.x) || !Number.isFinite(value.position.y) ||
      !fields(value.parameters, [], ['scenario', 'delayMs', 'seed'])) return false;
  const parameters = value.parameters;
  if (Object.hasOwn(parameters, 'scenario') && !scenarios.includes(parameters.scenario) ||
      Object.hasOwn(parameters, 'delayMs') && !integer(parameters.delayMs, 0, 120000) ||
      // The original shot schema accepts integer seeds without a safe-integer
      // constraint. Preserve those stored values rather than silently clamp.
      Object.hasOwn(parameters, 'seed') && !Number.isInteger(parameters.seed)) return false;
  return withinBound(value);
}

export function isReferenceEdgeRecord(value, {projectId} = {}) {
  return fields(value, edgeFields) && uuid(value.id) && uuid(value.projectId) &&
    (projectId === undefined || value.projectId === projectId) && uuid(value.source) && uuid(value.target) && uuid(value.sourceAssetId) &&
    value.kind === 'reference' && value.role === 'first_frame' && timestamp(value.createdAt) && withinBound(value);
}

export function isReferenceMutationResponse(operation, input, value) {
  if (!REFERENCE_MUTATION_OPERATIONS.includes(operation) || !object(input) || !uuid(input.projectId) ||
      !text(input.requestId, 8, 200) || !integer(input.expectedShotRevision, 1)) return false;
  const attach = operation === 'reference.attach';
  const inputFields = ['projectId', 'requestId', 'expectedShotRevision', ...(attach ? ['sourceNodeId', 'targetShotId', 'expectedSourceRevision', 'role'] : ['edgeId'])];
  if (!fields(input, inputFields) ||
      (attach ? !uuid(input.sourceNodeId) || !uuid(input.targetShotId) || !integer(input.expectedSourceRevision, 1) || input.role !== 'first_frame' : !uuid(input.edgeId)) ||
      !fields(value, ['edge', 'shot', ...(attach ? [] : ['detached'])]) ||
      !isReferenceShotRecord(value.shot, {projectId: input.projectId}) || !isReferenceEdgeRecord(value.edge, {projectId: input.projectId}) ||
      value.edge.target !== value.shot.id) return false;
  const {edge, shot} = value;
  if (attach) {
    if (edge.source !== input.sourceNodeId || edge.target !== input.targetShotId || edge.role !== input.role ||
        (shot.revision !== input.expectedShotRevision && shot.revision !== input.expectedShotRevision + 1) ||
        shot.referenceAssetIds.length !== 1 || shot.referenceAssetIds[0] !== edge.sourceAssetId) return false;
  } else if (value.detached !== true || edge.id !== input.edgeId || shot.revision !== input.expectedShotRevision + 1 || shot.referenceAssetIds.length !== 0) return false;
  return withinBound(value);
}
