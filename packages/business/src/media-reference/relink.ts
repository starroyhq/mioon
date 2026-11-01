import {mediaReferenceSchema, outsideProjectLocationSchema} from '../../../contracts/src/media-reference.ts';
import type {MediaReference, OutsideProjectLocation} from '../../../contracts/src/media-reference.ts';
import {freshMediaFile, inspectTarget, isFileReadError, parseReference, prepareAccess, quietly, readSampledSha256, withMediaFile} from './access.ts';
import type {MediaAccess, MediaTarget, PreparedAccess} from './access.ts';
import {mediaReferenceError} from './errors.ts';
import {mediaMtimeMs} from './fingerprint.ts';
import {
  isInsideDirectory, outsideDirectoryGroups, parseLocalPath, referencePathFor, relinkBases, relinkTarget, resolveReferencePath, volumeNameOf,
} from './paths.ts';
import type {RelinkBases} from './paths.ts';

// Relinking missing media (plan 10.1, 12-05) and the folders outside the
// project directory that references point into (plan 8.4, 12-06).

export interface MediaAsset {
  readonly id: string;
  readonly reference: MediaReference;
}
export interface RelinkedMedia {
  readonly assetId: string;
  /** The real path. */
  readonly file: string;
  readonly reference: MediaReference;
}
export interface RelinkResult {
  /** The file the user chose. `matches`: its size and samples are the ones
   * recorded; otherwise its reference carries its own new fingerprint. */
  readonly chosen: RelinkedMedia & {readonly matches: boolean};
  /** Other missing assets found at the same place below the new folder. */
  readonly found: readonly RelinkedMedia[];
  /** A file is there, but its size or samples differ; never relinked by itself. */
  readonly mismatched: readonly {readonly assetId: string; readonly file: string}[];
  /** Only the modification time differs, and the file may not be read yet. */
  readonly unverified: readonly {readonly assetId: string; readonly file: string}[];
}
export const MAX_RELINK_ASSETS = 20_000;

/** Where a reference pointed: resolved against the project directory, or the
 * absolute path as stored, of either platform. */
const originalPath = (prepared: PreparedAccess, reference: MediaReference): string | null =>
  reference.pathForm === 'absolute' ? reference.path : resolveReferencePath(prepared.projectDir, reference);

/** The recorded fingerprint at its new place: the new path form and
 * modification time, the full hash only while that time is unchanged. Null
 * when the path cannot be stored. */
function relocated(prepared: PreparedAccess, target: MediaTarget, recorded: MediaReference): MediaReference | null {
  const mtimeMs = mediaMtimeMs(target.stats);
  let location;
  try {
    location = referencePathFor(prepared.projectDir, target.file, target.stats.dev === prepared.projectDev);
  } catch {
    return null;
  }
  const parsed = mediaReferenceSchema.safeParse({...location, sizeBytes: recorded.sizeBytes, mtimeMs, sampledSha256: recorded.sampledSha256,
    fullSha256: mtimeMs === recorded.mtimeMs ? recorded.fullSha256 : null});
  return parsed.success ? parsed.data : null;
}

/** The user chose `chosen.file` for a missing asset. The longest common tail
 * of the old and the new folder gives an old and a new base (relinkBases);
 * every other missing asset below the old base is looked for at the same
 * place below the new one. Matching size and modification time is enough,
 * and nothing is read; when only the time differs the samples are compared if
 * the file may be read, and it is `unverified` otherwise. A different size or
 * samples is `mismatched`. The chosen file itself must be readable: outside
 * the project directory the caller records the confirmation first. */
export async function relinkMedia(access: MediaAccess, assets: readonly MediaAsset[], chosen: {readonly assetId: string; readonly file: string},
  {signal}: {signal?: AbortSignal} = {}): Promise<RelinkResult> {
  if (!Array.isArray(assets) || assets.length > MAX_RELINK_ASSETS) throw mediaReferenceError('MEDIA_REFERENCE_INVALID', {reason: 'asset'});
  const recorded = assets.map(asset => ({id: asset.id, reference: parseReference(asset.reference)}));
  const old = recorded.find(asset => asset.id === chosen.assetId);
  if (old === undefined) throw mediaReferenceError('MEDIA_REFERENCE_INVALID', {reason: 'asset'});
  if (parseLocalPath(chosen.file) === null) throw new TypeError('The chosen file must be an absolute path');
  signal?.throwIfAborted();
  const prepared = await prepareAccess(access);
  const picked = await freshMediaFile(prepared, await inspectTarget(prepared, chosen.file), signal);
  const matches = picked.reference.sizeBytes === old.reference.sizeBytes && picked.reference.sampledSha256 === old.reference.sampledSha256;
  const reference = matches && picked.reference.mtimeMs === old.reference.mtimeMs ? {...picked.reference, fullSha256: old.reference.fullSha256} : picked.reference;
  const found: RelinkedMedia[] = [], mismatched: RelinkEntry[] = [], unverified: RelinkEntry[] = [];
  const from = originalPath(prepared, old.reference);
  const bases = from === null ? null : relinkBases(from, picked.file);
  if (bases !== null) {
    for (const asset of recorded) {
      if (asset.id === old.id) continue;
      signal?.throwIfAborted();
      const located = await locate(prepared, bases, asset, signal);
      if (located?.kind === 'found') found.push(located.media);
      else if (located) (located.kind === 'mismatched' ? mismatched : unverified).push(located.entry);
    }
  }
  return {chosen: {assetId: old.id, file: picked.file, reference, matches}, found, mismatched, unverified};
}

interface RelinkEntry {
  readonly assetId: string;
  readonly file: string;
}
type Located = {readonly kind: 'found'; readonly media: RelinkedMedia} | {readonly kind: 'mismatched' | 'unverified'; readonly entry: RelinkEntry};
/** Where another asset is after the move, if it is missing and a file is at its new place. */
async function locate(prepared: PreparedAccess, bases: RelinkBases, asset: MediaAsset, signal?: AbortSignal): Promise<Located | null> {
  const local = resolveReferencePath(prepared.projectDir, asset.reference);
  if (local !== null && (await inspectTarget(prepared, local)).kind !== 'missing') return null;
  const before = originalPath(prepared, asset.reference);
  const candidate = before === null ? null : relinkTarget(bases, before);
  if (candidate === null || parseLocalPath(candidate) === null) return null;
  const target = await inspectTarget(prepared, candidate);
  if (target.kind !== 'media') return null;
  const entry = {assetId: asset.id, file: target.file};
  if (Number(target.stats.size) !== asset.reference.sizeBytes) return {kind: 'mismatched', entry};
  if (mediaMtimeMs(target.stats) !== asset.reference.mtimeMs) {
    if (!target.readable) return {kind: 'unverified', entry};
    let sampled: string | null;
    try {
      sampled = await withMediaFile(prepared, target, session => readSampledSha256(session, target, signal));
    } catch (error) {
      if (!isFileReadError(error)) throw error;
      return {kind: 'unverified', entry};
    }
    if (sampled !== asset.reference.sampledSha256) return {kind: 'mismatched', entry};
  }
  const reference = relocated(prepared, target, asset.reference);
  return reference === null ? null : {kind: 'found', media: {...entry, reference}};
}

/** The folders outside the project directory that references point into,
 * for the confirmation of 12-06; nothing is opened. A file that exists is
 * placed where it really is, also when a link inside the project directory
 * points out of it, since that is where reading it is judged; a missing one
 * where its path says. Nested folders count with the outer one. `available`:
 * the folder exists here, never for a path of the other platform. Confirming
 * a `directory` lets insideAnyDirectory read below it. */
export async function outsideProjectLocations(access: MediaAccess, assets: readonly MediaAsset[]): Promise<OutsideProjectLocation[]> {
  const prepared = await prepareAccess(access);
  const files: string[] = [];
  for (const asset of assets) {
    const reference = parseReference(asset.reference);
    const local = resolveReferencePath(prepared.projectDir, reference);
    if (local === null) {
      if (reference.pathForm === 'absolute') files.push(reference.path);
      continue;
    }
    const location = await quietly(() => prepared.fileSystem.realpath(local)) ?? local;
    if (!isInsideDirectory(prepared.projectDir, location)) files.push(location);
  }
  const locations: OutsideProjectLocation[] = [];
  for (const {directory, count} of outsideDirectoryGroups(files)) {
    const info = parseLocalPath(directory) === null ? null : await quietly(() => prepared.fileSystem.lstat(directory));
    const parsed = outsideProjectLocationSchema.safeParse({directory, volume: volumeNameOf(directory), assetCount: count, available: info?.isDirectory() ?? false});
    if (parsed.success) locations.push(parsed.data);
  }
  return locations;
}
