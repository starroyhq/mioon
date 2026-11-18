import {mediaReferenceSchema} from '../../contracts/src/media-reference.ts';
import {projectOutputPublicationProofSchema} from '../../contracts/src/project-output-publication.ts';
import type {ProjectOutputOwner, ProjectOutputPublicationProof} from '../../contracts/src/project-output-publication.ts';

/** Portable metadata checks do not depend on the filesystem publisher or store. */
export interface PublishedProjectOutputExpectation {
  readonly projectId: string; readonly assetId?: string;
  readonly owner: Pick<ProjectOutputOwner, 'kind' | 'id'> & Partial<Pick<ProjectOutputOwner, 'requestId' | 'inputHash'>>;
  readonly targetKind: ProjectOutputPublicationProof['targetKind']; readonly sha256?: string; readonly sizeBytes?: number; readonly mimeType?: string;
  readonly requireOriginalLocation?:boolean;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function isPublishedProjectOutput(asset: unknown, expected: PublishedProjectOutputExpectation): boolean {
  if (!record(asset)) return false;
  const parsed = projectOutputPublicationProofSchema.safeParse(asset.publication), reference = mediaReferenceSchema.safeParse(asset.reference);
  if (!parsed.success || !reference.success) return false;
  const proof = parsed.data, owner = expected.owner;
  // Upload publication verifies complete bytes privately. Imported videos keep
  // S1's sampled public reference until revision-checked strong preparation.
  const hashMatches = proof.sha256 === asset.sha256 && proof.sha256 === reference.data.fullSha256 ||
    proof.owner.kind === 'import' && proof.targetKind === 'assets' && proof.mimeType.startsWith('video/') &&
    asset.sha256 === null && reference.data.fullSha256 === null;
  return asset.id === proof.assetId && asset.projectId === proof.projectId && proof.projectId === expected.projectId &&
    (expected.assetId === undefined || proof.assetId === expected.assetId) && proof.owner.kind === owner.kind && proof.owner.id === owner.id &&
    (owner.requestId === undefined || proof.owner.requestId === owner.requestId) && (owner.inputHash === undefined || proof.owner.inputHash === owner.inputHash) &&
    proof.targetKind === expected.targetKind && hashMatches &&
    proof.sizeBytes === asset.sizeBytes && proof.sizeBytes === reference.data.sizeBytes && proof.mimeType === asset.mimeType &&
    (!(expected.requireOriginalLocation??expected.targetKind==='exports')||reference.data.pathForm==='relative'&&reference.data.path===proof.relativePath&&reference.data.volume===null) &&
    (expected.sha256 === undefined || proof.sha256 === expected.sha256) && (expected.sizeBytes === undefined || proof.sizeBytes === expected.sizeBytes) &&
    (expected.mimeType === undefined || proof.mimeType === expected.mimeType);
}
