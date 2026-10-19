import {isAssetAnnotationResponse} from './asset-annotations.ts';
import {SUBJECT_MUTATION_OPERATIONS,isSubjectMutationResponse} from './subjects.ts';
import {isSourceRangeResponse} from './source-range.ts';
import {isAssetDispositionResponse} from './asset-disposition.ts';

// The original six operations support optional keys and retain keyless behavior.
// Additive asset metadata and subject operations require a durable replay key.
export const LOCAL_MUTATION_OPERATIONS = Object.freeze([
  'shot.create', 'shot.update', 'shot.reorder', 'node.create', 'node.update', 'version.select', 'asset.range.set', 'asset.disposition.set', 'asset.annotation.set', ...SUBJECT_MUTATION_OPERATIONS,
]);
export interface LocalMutationOptions {projectId?: string}

// Minimum acknowledgement identity, shared by first-party clients. This does not
// assert freshness: a keyed replay deliberately returns its historical response.
// UI callers can additionally bind implicit shot/node scope to a trusted project.
export function isLocalMutationResponse(operation: unknown, input: unknown, result: unknown, {projectId}: LocalMutationOptions = {}): boolean {
  const request = input as Record<string, unknown>;
  const response = result as Record<string, unknown> | null | undefined;
  if (typeof operation !== 'string' || !(LOCAL_MUTATION_OPERATIONS as readonly string[]).includes(operation) || !response || typeof response !== 'object' || Array.isArray(response) ||
      typeof response.id !== 'string' || !response.id || !Number.isSafeInteger(response.revision) || (response.revision as number) < 1) return false;
  if ((SUBJECT_MUTATION_OPERATIONS as readonly string[]).includes(operation)) return isSubjectMutationResponse(operation,input,result) && (!projectId || response.projectId===projectId);
  if (operation === 'asset.annotation.set') return isAssetAnnotationResponse(result) && response.assetId===request.assetId && response.projectId===request.projectId && (!projectId || response.projectId===projectId) && Number.isSafeInteger(request.expectedRevision) && response.revision===(request.expectedRevision as number)+1 && JSON.stringify(response.tags)===JSON.stringify(request.tags) && response.note===request.note;
  if (operation === 'asset.disposition.set') return isAssetDispositionResponse(result) &&
    response.assetId === request.assetId && response.projectId === request.projectId && (!projectId || response.projectId === projectId) &&
    Number.isSafeInteger(request.expectedRevision) && (request.expectedRevision as number) >= 0 && response.revision === (request.expectedRevision as number) + 1 &&
    response.disposition === request.disposition;
  if (operation === 'asset.range.set') {
    if (!isSourceRangeResponse(result)) return false;
    const range = result.range;
    return response.assetId === request.assetId && response.projectId === request.projectId && (!projectId || response.projectId === projectId) &&
      Number.isSafeInteger(request.expectedRevision) && response.revision === (request.expectedRevision as number) + 1 &&
      range !== null && range.inFrame === request.inFrame && range.outFrame === request.outFrame;
  }
  const target = operation === 'shot.reorder' ? request.projectId : request.shotId || request.nodeId;
  if (target && response.id !== target) return false;
  if (operation === 'shot.reorder') return !projectId || response.id === projectId;
  if (typeof response.projectId !== 'string' || !response.projectId ||
      (request.projectId && response.projectId !== request.projectId) || (projectId && response.projectId !== projectId)) return false;
  if (operation === 'version.select' && response.selectedVersionId !== request.versionId) return false;
  // New explicit tail writes need an exact acknowledgement. Do not strengthen
  // old callers or compare against today's shot: keyed receipts are historical.
  const tailInput = (operation === 'shot.create' ? request : operation === 'shot.update' ? request.patch : null) as Record<string, unknown> | null;
  if (tailInput && Object.hasOwn(tailInput, 'lastFrameAssetId')) {
    const expected = tailInput.lastFrameAssetId;
    if (!(expected === null || typeof expected === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(expected)) ||
        !Object.hasOwn(response, 'lastFrameAssetId') || response.lastFrameAssetId !== expected) return false;
  }
  return true;
}
