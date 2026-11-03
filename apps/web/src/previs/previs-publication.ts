import {isPrevisPublicationResponse, previsPublicationIdentity, previsPublicationInputSchema} from '../../../../packages/contracts/src/previs-publication.ts';
import type {PrevisImportOutcome, PrevisImportRequest} from './previs-output.ts';

/** An uncertain publication is resolved only by its exact durable request.
 * A library image with equal bytes says nothing about this node or render. */
export async function publishPrevisOutput(input: PrevisImportRequest, rpc: (operation: string, input: Record<string, unknown>) => Promise<unknown>): Promise<PrevisImportOutcome> {
  if (!previsPublicationInputSchema.safeParse(input).success) return {status: 'failed', code: 'VALIDATION_ERROR'};
  try {
    const value = await rpc('previs.output.publish', input);
    if (!isPrevisPublicationResponse('previs.output.publish', input, value) || value === null)
      throw Object.assign(new Error('Invalid previs publication acknowledgement'), {code: 'BACKEND_PROTOCOL_ERROR'});
    return {status: 'imported', assetId: value.asset.id};
  } catch (error) {
    const failure = error as {definitive?: boolean; status?: number; code?: string};
    if (failure.definitive === true && failure.code !== 'BACKEND_PROTOCOL_ERROR' && (failure.status ?? 0) >= 400 && (failure.status ?? 0) < 500)
      return {status: 'failed', code: failure.code ?? 'PREVIS_EXPORT_INVALID'};
  }
  try {
    const identity = previsPublicationIdentity(input), value = await rpc('previs.output.lookup', identity);
    if (value !== null && isPrevisPublicationResponse('previs.output.lookup', identity, value)) return {status: 'imported', assetId: value.asset.id};
  } catch { /* Keep the original uncertainty until this exact request is found. */ }
  return {status: 'unknown'};
}
