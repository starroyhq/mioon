import nodePath from 'node:path';
import {isPortableRelativePath} from '../../../contracts/src/media-reference.ts';
import {probe} from '../media.ts';
import {hasMediaHeader, inspectTarget, isFileReadError, isHiddenInside, prepareAccess, quietly, withMediaFile} from './access.ts';
import type {MediaAccess, MediaTarget, PreparedAccess} from './access.ts';
import {mediaReferenceError} from './errors.ts';
import type {MediaDirectoryEntry} from './file-system.ts';
import {isProtectedName, mediaTypeOfName} from './media-type.ts';
import type {MediaKind} from './media-type.ts';
import {compareCodePoints, isInsideDirectory} from './paths.ts';

// Listing the project directory for Mio (plan 10.3): Mio's working directory
// is the project directory. One folder at a time, named by a relative path
// without `..` and without names starting with `.`; only folders and media
// files, each with its name, kind, MIME type, size and duration, never its
// content. A file is listed only after the checks of access.ts and a header
// that matches its extension, so the project file, its journal, links to
// them, super-journals and the test store's folder are skipped unopened.
// Durations come from ffprobe in a child process, which cannot drop this
// process's SQLite locks.

export interface ProjectMediaEntry {
  readonly name: string;
  readonly kind: 'folder' | MediaKind;
  /** null for folders. */
  readonly mimeType: string | null;
  /** null for folders. */
  readonly sizeBytes: number | null;
  /** Seconds; null for folders, images and files ffprobe cannot time. */
  readonly durationSeconds: number | null;
}
export interface ProjectMediaListing {
  /** The folder listed, as it was asked for: relative to the project directory, '' for the directory itself. */
  readonly directory: string;
  /** Folders first, then files, each in code point order of their names. */
  readonly entries: readonly ProjectMediaEntry[];
  /** There is more: another entry beyond the limit, or more than MAX_LIST_SCAN entries in the folder. */
  readonly truncated: boolean;
}
export type ProbeDuration = (file: string, signal?: AbortSignal) => Promise<number | null>;
export const DEFAULT_LIST_LIMIT = 200;
/** Entries of one folder looked at, at most. */
export const MAX_LIST_SCAN = 5_000;
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_CONCURRENCY = 4;

const positiveDuration = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

/** Seconds of a video or audio file from ffprobe (media.ts' probe, at most 4
 * at a time in this process); null when it has none or ffprobe fails. Only
 * an abort is thrown. */
export async function probeMediaDuration(file: string, signal?: AbortSignal): Promise<number | null> {
  try {
    return positiveDuration((await probe(file, {signal, timeout: PROBE_TIMEOUT_MS})).duration);
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

const invalidPath = (reason: 'path' | 'outside' | 'missing' | 'not-a-directory') => mediaReferenceError('MEDIA_LIST_PATH_INVALID', {reason});

/** The names of the folder to list: none for '', otherwise a portable
 * relative path without `..` and without protected names, which include every
 * name starting with `.`. */
function folderSegments(directory: string): readonly string[] {
  if (directory === '') return [];
  if (typeof directory !== 'string' || !isPortableRelativePath(directory)) throw invalidPath('path');
  const segments = directory.split('/');
  if (segments.some(name => name === '..' || isProtectedName(name))) throw invalidPath('path');
  return segments;
}

/** The real folder, which must still be in the project directory and not below a hidden folder. */
async function realFolder(prepared: PreparedAccess, segments: readonly string[]): Promise<string> {
  if (segments.length === 0) return prepared.projectDir;
  const real = await quietly(() => prepared.fileSystem.realpath(nodePath.join(prepared.projectDir, ...segments)));
  if (real === null) throw invalidPath('missing');
  if (!isInsideDirectory(prepared.projectDir, real)) throw invalidPath('outside');
  if (isHiddenInside(prepared, real)) throw invalidPath('path');
  const info = await quietly(() => prepared.fileSystem.lstat(real));
  if (info === null) throw invalidPath('missing');
  if (!info.isDirectory()) throw invalidPath('not-a-directory');
  return real;
}

/** Folders and files with a media extension whose names can be listed; links and anything else are skipped. */
const isCandidate = (entry: MediaDirectoryEntry): boolean =>
  (entry.kind === 'directory' || entry.kind === 'file' && mediaTypeOfName(entry.name) !== null) && !isProtectedName(entry.name) &&
  isPortableRelativePath(entry.name);
const folderRank = (entry: MediaDirectoryEntry): number => entry.kind === 'directory' ? 0 : 1;
const byListing = (a: MediaDirectoryEntry, b: MediaDirectoryEntry): number => folderRank(a) - folderRank(b) || compareCodePoints(a.name, b.name);

/** The file, when it passes the checks of access.ts and its header is media. */
async function listedFile(prepared: PreparedAccess, file: string, signal?: AbortSignal): Promise<MediaTarget | null> {
  const target = await inspectTarget(prepared, file);
  if (target.kind !== 'media' || target.outside) return null;
  try {
    return await withMediaFile(prepared, target, session => hasMediaHeader(session, target, signal)) ? target : null;
  } catch (error) {
    if (isFileReadError(error)) return null;
    throw error;
  }
}

async function durationOf(probeDuration: ProbeDuration, target: MediaTarget, signal?: AbortSignal): Promise<number | null> {
  if (target.type.kind === 'image') return null;
  try {
    return positiveDuration(await probeDuration(target.file, signal));
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

/** `map` over `items`, at most `concurrency` at a time, in order. */
async function mapLimited<T, R>(items: readonly T[], concurrency: number, map: (item: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      signal?.throwIfAborted();
      const index = next++;
      results[index] = await map(items[index]);
    }
  };
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, worker));
  return results;
}

/** One folder of the project directory for Mio (`''`: the directory itself).
 * MEDIA_LIST_PATH_INVALID: `path` for a path that is not relative, holds
 * `..` or a name starting with `.`; `outside` when it really is outside the
 * project directory (a link); `missing`; `not-a-directory`. At most `limit`
 * entries (default 200); durations by `probeDuration`, ffprobe by default. */
export async function listProjectMedia(access: MediaAccess, directory = '',
  {limit = DEFAULT_LIST_LIMIT, probeDuration = probeMediaDuration, signal}: {limit?: number; probeDuration?: ProbeDuration; signal?: AbortSignal} = {},
): Promise<ProjectMediaListing> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_SCAN) throw new TypeError('Invalid listing limit');
  const segments = folderSegments(directory);
  signal?.throwIfAborted();
  const prepared = await prepareAccess(access);
  const folder = await realFolder(prepared, segments);
  const scanned = await prepared.fileSystem.readDirectory(folder, MAX_LIST_SCAN + 1);
  if (scanned === null) throw invalidPath('missing');
  let truncated = scanned.length > MAX_LIST_SCAN;
  const listed: {readonly name: string; readonly target: MediaTarget | null}[] = [];
  for (const entry of scanned.slice(0, MAX_LIST_SCAN).filter(isCandidate).sort(byListing)) {
    signal?.throwIfAborted();
    const target = entry.kind === 'file' ? await listedFile(prepared, nodePath.join(folder, entry.name), signal) : null;
    if (entry.kind === 'file' && target === null) continue;
    // One more entry that would be listed: the listing is cut short.
    if (listed.length === limit) {
      truncated = true;
      break;
    }
    listed.push({name: entry.name, target});
  }
  const durations = await mapLimited(listed, PROBE_CONCURRENCY, async ({target}) => target === null ? null : durationOf(probeDuration, target, signal), signal);
  const entries = listed.map(({name, target}, index): ProjectMediaEntry => target === null
    ? {name, kind: 'folder', mimeType: null, sizeBytes: null, durationSeconds: null}
    : {name, kind: target.type.kind, mimeType: target.type.mimeType, sizeBytes: Number(target.stats.size), durationSeconds: durations[index]});
  return {directory, entries, truncated};
}
