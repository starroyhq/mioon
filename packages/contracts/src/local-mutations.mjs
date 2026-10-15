import {isAssetAnnotationResponse} from './asset-annotations.ts';
import {SUBJECT_MUTATION_OPERATIONS,isSubjectMutationResponse} from './subjects.mjs';
import {isSourceRangeResponse} from './source-range.mjs';
import {isAssetDispositionResponse} from './asset-disposition.mjs';

// The original six operations support optional keys and retain keyless behavior.
// Additive asset metadata and subject operations require a durable replay key.
export const LOCAL_MUTATION_OPERATIONS = Object.freeze([
  'shot.create', 'shot.update', 'shot.reorder', 'node.create', 'node.update', 'version.select', 'asset.range.set', 'asset.disposition.set', 'asset.annotation.set', ...SUBJECT_MUTATION_OPERATIONS,
]);

// Minimum acknowledgement identity, shared by first-party clients. This does not
// assert freshness: a keyed replay deliberately returns its historical response.
// UI callers can additionally bind implicit shot/node scope to a trusted project.
export function isLocalMutationResponse(operation, input, result, {projectId} = {}) {
  if (!LOCAL_MUTATION_OPERATIONS.includes(operation) || !result || typeof result !== 'object' || Array.isArray(result) ||
      typeof result.id !== 'string' || !result.id || !Number.isSafeInteger(result.revision) || result.revision < 1) return false;
  if (SUBJECT_MUTATION_OPERATIONS.includes(operation)) return isSubjectMutationResponse(operation,input,result) && (!projectId || result.projectId===projectId);
  if (operation === 'asset.annotation.set') return isAssetAnnotationResponse(result) && result.assetId===input.assetId && result.projectId===input.projectId && (!projectId || result.projectId===projectId) && Number.isSafeInteger(input.expectedRevision) && result.revision===input.expectedRevision+1 && JSON.stringify(result.tags)===JSON.stringify(input.tags) && result.note===input.note;
  if (operation === 'asset.disposition.set') return isAssetDispositionResponse(result) &&
    result.assetId === input.assetId && result.projectId === input.projectId && (!projectId || result.projectId === projectId) &&
    Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0 && result.revision === input.expectedRevision + 1 &&
    result.disposition === input.disposition;
  if (operation === 'asset.range.set') return isSourceRangeResponse(result) &&
    result.assetId === input.assetId && result.projectId === input.projectId && (!projectId || result.projectId === projectId) &&
    Number.isSafeInteger(input.expectedRevision) && result.revision === input.expectedRevision + 1 &&
    result.range.inFrame === input.inFrame && result.range.outFrame === input.outFrame;
  const target = operation === 'shot.reorder' ? input.projectId : input.shotId || input.nodeId;
  if (target && result.id !== target) return false;
  if (operation === 'shot.reorder') return !projectId || result.id === projectId;
  if (typeof result.projectId !== 'string' || !result.projectId ||
      (input.projectId && result.projectId !== input.projectId) || (projectId && result.projectId !== projectId)) return false;
  if (operation === 'version.select' && result.selectedVersionId !== input.versionId) return false;
  // New explicit tail writes need an exact acknowledgement. Do not strengthen
  // old callers or compare against today's shot: keyed receipts are historical.
  const tailInput = operation === 'shot.create' ? input : operation === 'shot.update' ? input.patch : null;
  if (tailInput && Object.hasOwn(tailInput, 'lastFrameAssetId')) {
    const expected = tailInput.lastFrameAssetId;
    if (!(expected === null || typeof expected === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(expected)) ||
        !Object.hasOwn(result, 'lastFrameAssetId') || result.lastFrameAssetId !== expected) return false;
  }
  return true;
}
