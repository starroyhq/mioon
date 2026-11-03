import path from 'node:path';
import {mediaReferenceSchema} from '../../packages/contracts/src/media-reference.ts';
import {resolveReferencePath} from '../../packages/business/src/media-reference/paths.ts';
import type {MediaReference} from '../../packages/contracts/src/media-reference.ts';
/** A closed metadata-only fixture for pure ownership/contract tests. Filesystem
 * tests use the real L1 sampler instead. */
export function mediaReferenceFixture(path: string, sizeBytes: number, sha256: string): MediaReference {
 return {pathForm: 'relative', path, volume: null, sizeBytes, mtimeMs: 0, sampledSha256: sha256, fullSha256: sha256};
}
/** Header-valid input for tests whose decoder is explicitly stubbed. It is not
 * represented as a decodable MP4 in an integration test. */
export function mp4HeaderFixture(text: string): Buffer {
 return Buffer.concat([Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109,109,112,52,50]), Buffer.from(text)]);
}

export function mediaFixturePath(root: string, asset: unknown): string {
 if (!asset || typeof asset !== 'object') throw new TypeError('Missing fixture asset');
 if ('reference' in asset) {const file = resolveReferencePath(root, mediaReferenceSchema.parse(asset.reference)); if (!file) throw new TypeError('Non-local fixture asset'); return file;}
 if ('relativePath' in asset && typeof asset.relativePath === 'string') return path.join(root,asset.relativePath);
 throw new TypeError('Missing fixture locator');
}
