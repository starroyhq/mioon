import {isSourceRangeResponse} from './source-range.mjs';

// The original six operations support optional keys and retain keyless behavior.
// asset.range.set is additive and always requires a durable replay key.
export const LOCAL_MUTATION_OPERATIONS = Object.freeze([
  'shot.create', 'shot.update', 'shot.reorder', 'node.create', 'node.update', 'version.select', 'asset.range.set',
]);

// Minimum acknowledgement identity, shared by first-party clients. This does not
// assert freshness: a keyed replay deliberately returns its historical response.
// UI callers can additionally bind implicit shot/node scope to a trusted project.
export function isLocalMutationResponse(operation, input, result, {projectId} = {}) {
  if (!LOCAL_MUTATION_OPERATIONS.includes(operation) || !result || typeof result !== 'object' || Array.isArray(result) ||
      typeof result.id !== 'string' || !result.id || !Number.isSafeInteger(result.revision) || result.revision < 1) return false;
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
  return true;
}
