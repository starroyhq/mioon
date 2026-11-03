/** Explicit test-layout fixture conversion. Production stores never import
 * this helper or perform filesystem I/O from put(). Invalid/missing fixtures
 * remain invalid/missing; this does not manufacture a decodable media file. */
import {constants, closeSync, fstatSync, lstatSync, openSync, readSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {mediaMtimeMs, sampleRanges} from '../media-reference/fingerprint.ts';
import {referencePathForRealFile} from '../media-reference/paths.ts';
import {isProjectFileHeld} from './held-files.ts';
import {isAppLibraryHeld} from '../app-db/connection.ts';

type Fixture = Readonly<Record<string, unknown>>;
const fullHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

export function referenceTestAsset(root: string, value: Fixture): Record<string, unknown> {
  if (value.reference !== undefined || typeof value.relativePath !== 'string') return {...value};
  const file = path.resolve(root, value.relativePath), fullSha256 = fullHash(value.sha256) ? value.sha256 : null;
  // Zero is an explicitly unavailable fixture fingerprint, never a purported
  // sample of nonexistent bytes. Preserve declared wrong sizes/hashes so
  // existing corruption tests still exercise the production rejection.
  let sizeBytes = Number.isSafeInteger(value.sizeBytes) && Number(value.sizeBytes) >= 0 ? Number(value.sizeBytes) : 0;
  let mtimeMs = 0, sampledSha256 = '0'.repeat(64), sameVolume = true;
  let fd: number | undefined;
  try {
    const info = lstatSync(file, {bigint: true}), identity = {dev: String(info.dev), ino: String(info.ino)};
    if (!info.isFile() || isProjectFileHeld(identity) || isAppLibraryHeld(identity) ||
      /(?:^|[/\\])(?:\.mioon-store|project\.mioon(?:-.*)?|history\.db(?:-.*)?|cache\.db(?:-.*)?|app\.sqlite(?:-.*)?)(?:$|[/\\])/u.test(file)) {
      throw new Error('Unavailable fixture');
    }
    sameVolume = lstatSync(root, {bigint: true}).dev === info.dev;
    if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Oversized fixture');
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd, {bigint: true});
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size || opened.mtimeNs !== info.mtimeNs || opened.ctimeNs !== info.ctimeNs) throw new Error('Changed fixture');
    const hash = createHash('sha256');
    for (const range of sampleRanges(Number(info.size))) {
      const buffer = Buffer.allocUnsafe(Math.min(range.length, 65536));
      for (let offset = 0; offset < range.length;) {
        const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, range.length - offset), range.start + offset);
        if (!bytes) throw new Error('Changed fixture');
        hash.update(buffer.subarray(0, bytes)); offset += bytes;
      }
    }
    const after = fstatSync(fd, {bigint: true}), current = lstatSync(file, {bigint: true});
    if ([after, current].some(actual => actual.dev !== info.dev || actual.ino !== info.ino || actual.size !== info.size || actual.mtimeNs !== info.mtimeNs || actual.ctimeNs !== info.ctimeNs)) throw new Error('Changed fixture');
    sizeBytes = Number.isSafeInteger(value.sizeBytes) && Number(value.sizeBytes) >= 0 ? Number(value.sizeBytes) : Number(info.size);
    mtimeMs = mediaMtimeMs(info); sampledSha256 = hash.digest('hex');
  } catch {
    // Tests deliberately seed missing/corrupt/held sources. Keep the negative
    // fixture rather than opening an alias or making it readable.
  } finally {if (fd !== undefined) closeSync(fd);}
  const {relativePath: _relativePath, ...record} = value;
  return {...record, sizeBytes: value.sizeBytes === undefined ? sizeBytes : value.sizeBytes, sha256: value.sha256 === undefined ? null : value.sha256, referenceRevision: value.referenceRevision ?? 1,
    reference: {...referencePathForRealFile(root, file, sameVolume), sizeBytes, mtimeMs, sampledSha256, fullSha256}};
}
