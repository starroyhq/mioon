import {createHash} from 'node:crypto';
import {AppError} from '../../contracts/src/app-error.ts';
import {canonicalPrevisValue} from '../../contracts/src/previs.ts';
import {previsOutputIdentitySchema} from '../../contracts/src/previs-output.ts';
import type {PrevisOutputIdentity} from '../../contracts/src/previs-output.ts';
import {projectOutputPublicationProofSchema} from '../../contracts/src/project-output-publication.ts';
import {isPublishedProjectOutput} from './project-output-publication.ts';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const previsOutputInputHash = (identity: PrevisOutputIdentity): string => createHash('sha256')
  .update(canonicalPrevisValue({operation: 'previs.output.publish', input: identity})).digest('hex');
const invalid = (): never => {throw new AppError('PREVIS_EXPORT_INVALID', '预演图像的完整发布来源无法核验', 409);};

/** Null means this is not a previs output. A previs marker with incomplete or
 * conflicting facts is invalid, even when relabelled as an ordinary import.
 * Completed provenance survives deleted nodes and absent local temp/history.
 * Its original publication path is a source fact; same-content relink keeps
 * that proof while L1 separately authorizes and checks the current locator. */
export function readPrevisOutputSource(asset: unknown, projectId: string): PrevisOutputIdentity | null {
  if (!object(asset)) return null;
  const publication = object(asset.publication) ? asset.publication : null, owner = publication && object(publication.owner) ? publication.owner : null;
  if (!Object.hasOwn(asset, 'previsOutput') && owner?.kind !== 'previs') return null;
  const parsed = previsOutputIdentitySchema.safeParse(asset.previsOutput), proof = projectOutputPublicationProofSchema.safeParse(publication);
  if (!parsed.success || !proof.success) return invalid();
  const source = parsed.data;
  if (asset.provenance !== 'generated' || source.projectId !== projectId || source.projectId !== asset.projectId || source.name !== asset.name ||
    source.sha256 !== asset.sha256 || source.width !== asset.width || source.height !== asset.height ||
    !isPublishedProjectOutput(asset, {projectId, owner: {kind: 'previs', id: source.nodeId, requestId: source.requestId, inputHash: previsOutputInputHash(source)},
      targetKind: 'generated', sha256: source.sha256, mimeType: 'image/png'})) invalid();
  return source;
}
