import {projectOutputPublicationProofSchema} from '../../contracts/src/project-output-publication.ts';

/** A managed upload can retain a full publication hash even when the media
 * reference records only sampled bytes. Copies rebind ownership and relocate
 * the reference independently of the historical publication path. */
export function freezeSourceSha256(asset: {
  sha256?: unknown; publication?: unknown; id?: unknown; projectId?: unknown; mimeType?: unknown; sizeBytes?: unknown;
}): string | null {
  if (typeof asset.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(asset.sha256)) return asset.sha256;
  const proof = projectOutputPublicationProofSchema.safeParse(asset.publication);
  if (!proof.success || proof.data.assetId !== asset.id || proof.data.projectId !== asset.projectId ||
      proof.data.mimeType !== asset.mimeType || proof.data.sizeBytes !== asset.sizeBytes) return null;
  return proof.data.sha256;
}
