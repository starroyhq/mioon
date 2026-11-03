import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';
import {ensurePrivateDirectory, writePrivateFileAtomic} from '../../packages/contracts/src/private-storage.ts';
import type {ProjectOutputOwner} from '../../packages/contracts/src/project-output-publication.ts';
import {publishProjectOutput, markProjectOutputRegistered} from '../../packages/business/src/project-output-publication.ts';
import type {PublishedProjectOutput} from '../../packages/business/src/project-output-publication.ts';
import {isProjectStore} from '../../packages/business/src/project-file/store.ts';
import type {ProjectStore} from '../../packages/business/src/project-file/store.ts';

/** Explicit completed-byte fixture. This runs the real stage/intent/exclusive
 * publisher; callers still register their real task/version/asset transaction
 * and mark that exact publication afterwards. It never invents provenance. */
export async function publishOutputFixture(store: ProjectStore, input: {assetId: string; owner: ProjectOutputOwner; bytes: Uint8Array;
  mimeType: 'image/png' | 'video/mp4'; targetKind?: 'generated' | 'exports'; displayName?: string}): Promise<Omit<PublishedProjectOutput, 'relativePath'>> {
  if (!isProjectStore(store)) throw new TypeError('A real project fixture owner is required');
  const bytes = Buffer.from(input.bytes);
  if (bytes.length === 0) throw new TypeError('A complete nonempty fixture is required');
  const directory = path.join(store.tempDir, 'fixture-publications'); ensurePrivateDirectory(directory, {create: true});
  const stageFile = path.join(directory, `${randomUUID()}.${input.mimeType === 'image/png' ? 'png' : 'mp4'}`);
  writePrivateFileAtomic(stageFile, bytes, {root: store.tempDir, maxBytes: bytes.length});
  const published = await publishProjectOutput(store, {owner: input.owner, assetId: input.assetId, targetKind: input.targetKind ?? 'generated', stageFile,
    mimeType: input.mimeType, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...(input.displayName ? {displayName: input.displayName} : {})});
  const {relativePath: _relativePath, ...assetFields} = published;
  return assetFields;
}
export {markProjectOutputRegistered};
