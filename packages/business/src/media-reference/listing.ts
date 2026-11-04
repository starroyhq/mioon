import nodePath from 'node:path';
import type {BigIntStats} from 'node:fs';
import {createHash} from 'node:crypto';
import {isPortableRelativePath} from '../../../contracts/src/media-reference.ts';
import {assetUploadImportSchema} from '../../../contracts/src/asset-media.ts';
import {isProjectId} from '../../../contracts/src/project-file.ts';
import {isMioProjectMediaRelativePath, MIO_PROJECT_MEDIA_LIMITS, mioProjectMediaListingSchema} from '../../../contracts/src/mio-project-media.ts';
import type {MioProjectMediaEntry, MioProjectMediaListing} from '../../../contracts/src/mio-project-media.ts';
import {probe} from '../media.ts';
import {hasMediaHeader, inspectTarget, isFileReadError, isHiddenInside, prepareAccess, quietly, withMediaFile} from './access.ts';
import type {MediaAccess, MediaTarget, PreparedAccess} from './access.ts';
import {mediaReferenceError} from './errors.ts';
import type {MediaDirectoryEntry} from './file-system.ts';
import {NODE_MEDIA_FILE_SYSTEM} from './file-system.ts';
import type {MediaFileSystem} from './file-system.ts';
import {isProtectedName, mediaTypeOfName} from './media-type.ts';
import type {MediaKind} from './media-type.ts';
import {compareCodePoints, isInsideRealDirectory} from './paths.ts';

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
export interface ProbeDurationOptions {readonly beforeEffect?: () => void}
export type ProbeDuration = (file: string, signal?: AbortSignal, options?: ProbeDurationOptions) => Promise<number | null>;
export const DEFAULT_LIST_LIMIT = 200;
/** Entries of one folder looked at, at most. */
export const MAX_LIST_SCAN = 5_000;
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_CONCURRENCY = 4;

const positiveDuration = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

/** Seconds of a video or audio file from ffprobe (media.ts' probe, at most 4
 * at a time in this process); null when it has none or ffprobe fails. Only
 * an abort is thrown. */
export async function probeMediaDuration(file: string, signal?: AbortSignal, {beforeEffect}: ProbeDurationOptions = {}): Promise<number | null> {
  let failedFence = false, fenceFailure: unknown;
  const fence = beforeEffect === undefined ? undefined : (): void => {
    try {beforeEffect();}
    catch (error) {failedFence = true; fenceFailure = error; throw error;}
  };
  try {
    return positiveDuration((await probe(file, {signal, timeout: PROBE_TIMEOUT_MS, beforeSpawn: fence, beforeEffect: fence})).duration);
  } catch (error) {
    if (failedFence) throw fenceFailure;
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
  if (!isInsideRealDirectory(prepared.projectDir, real)) throw invalidPath('outside');
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
async function mapLimited<T, R>(items: readonly T[], concurrency: number, map: (item: T) => Promise<R>, signal?: AbortSignal, drain = false): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      signal?.throwIfAborted();
      const index = next++;
      results[index] = await map(items[index]);
    }
  };
  const workers = Array.from({length: Math.min(concurrency, items.length)}, worker);
  if (drain) {
    const settled = await Promise.allSettled(workers);
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  } else await Promise.all(workers);
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

export interface ProjectMediaPageOptions {
  readonly projectId: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
  readonly beforeEffect?: () => void;
  /** Trusted private-scope/publication reader for files and directories;
   * never supplied by a model. */
  readonly isExcluded?: (file: string, stats: BigIntStats) => boolean;
  /** Only the host can prove this is still the registered physical file. */
  readonly registeredDuration?: (file: string, stats: BigIntStats) => {readonly durationSeconds: number | null} | undefined;
  readonly scopeVersion?: string;
  readonly probeDuration?: ProbeDuration;
}

const hashListing = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameIdentity = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino;
const sameListedFile = (a: BigIntStats, b: BigIntStats): boolean => sameIdentity(a, b) && a.size === b.size &&
  a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const listingChanged = (reason: 'directory' | 'file' | 'cursor') => mediaReferenceError('MEDIA_CHANGED_DURING_READ', {reason});
type PageCursor = readonly [1, string, string, string, string, number];
const encodeCursor = (cursor: PageCursor): string => Buffer.from(JSON.stringify(cursor)).toString('base64url');

function readPageCursor(value: string): PageCursor {
  if (typeof value !== 'string' || value.length > MIO_PROJECT_MEDIA_LIMITS.cursorBytes || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw mediaReferenceError('MEDIA_LIST_PATH_INVALID', {reason: 'cursor'});
  }
  let decoded: unknown;
  try {decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));}
  catch {throw mediaReferenceError('MEDIA_LIST_PATH_INVALID', {reason: 'cursor'});}
  if (!Array.isArray(decoded) || decoded.length !== 6 || decoded[0] !== 1 || !isProjectId(decoded[1]) ||
    !decoded.slice(2, 5).every(part => typeof part === 'string' && /^[a-f0-9]{64}$/u.test(part)) ||
    !Number.isSafeInteger(decoded[5]) || decoded[5] < 1 || decoded[5] > MIO_PROJECT_MEDIA_LIMITS.scanEntries) {
    throw mediaReferenceError('MEDIA_LIST_PATH_INVALID', {reason: 'cursor'});
  }
  const cursor: PageCursor = [1, decoded[1], decoded[2], decoded[3], decoded[4], decoded[5]];
  if (encodeCursor(cursor) !== value) throw mediaReferenceError('MEDIA_LIST_PATH_INVALID', {reason: 'cursor'});
  return cursor;
}

/** A bounded, read-only page for the host-owned Mio working directory. The
 * cursor is a position in a revalidated snapshot, never an access grant. */
export async function listProjectMediaPage(access: MediaAccess, directory = '', options: ProjectMediaPageOptions): Promise<MioProjectMediaListing> {
  const {projectId, cursor, limit = MIO_PROJECT_MEDIA_LIMITS.defaultLimit, signal, beforeEffect,
    isExcluded, registeredDuration, scopeVersion = '', probeDuration = probeMediaDuration} = options;
  if (!isProjectId(projectId) || !Number.isSafeInteger(limit) || limit < 1 || limit > MIO_PROJECT_MEDIA_LIMITS.maxLimit) {
    throw new TypeError('Invalid project media page options');
  }
  if (!isMioProjectMediaRelativePath(directory, true)) throw invalidPath('path');
  const segments = folderSegments(directory), directoryHash = hashListing(directory), scopeHash = hashListing(scopeVersion);
  const previous = cursor === undefined ? undefined : readPageCursor(cursor);
  if (previous && (previous[1] !== projectId || previous[2] !== directoryHash || previous[3] !== scopeHash)) {
    throw mediaReferenceError('MEDIA_LIST_PATH_INVALID', {reason: 'cursor'});
  }
  signal?.throwIfAborted(); beforeEffect?.();
  const base = access.fileSystem ?? NODE_MEDIA_FILE_SYSTEM;
  if (!base.lstatSync || !base.realpathSync) throw new TypeError('Paged media discovery requires synchronous filesystem admission checks');
  const stat = (file: string): BigIntStats | null => {
    try {return base.lstatSync!(file);} catch {throw invalidPath('missing');}
  };
  const realpath = (file: string): string | null => {
    try {return base.realpathSync!(file);} catch {throw invalidPath('missing');}
  };
  const resolvedRoot = realpath(access.projectDir), rootInfo = resolvedRoot === null ? null : stat(resolvedRoot);
  if (resolvedRoot === null || rootInfo === null || !rootInfo.isDirectory()) throw invalidPath('missing');
  const root: string = resolvedRoot;
  const requestedFolder = nodePath.join(root, ...segments), folder = realpath(requestedFolder);
  if (folder === null) throw invalidPath('missing');
  if (!isInsideRealDirectory(root, folder)) throw invalidPath('outside');
  if (nodePath.relative(root, folder).split(nodePath.sep).some(name => isProtectedName(name))) throw invalidPath('path');
  const folderInfo = stat(folder);
  if (folderInfo === null) throw invalidPath('missing');
  if (!folderInfo.isDirectory()) throw invalidPath('not-a-directory');
  if (isExcluded?.(folder, folderInfo)) throw invalidPath('path');
  let fenceFailed = false, fenceFailure: unknown;
  const fence = (): void => {
    if (fenceFailed) throw fenceFailure;
    try {
      signal?.throwIfAborted(); beforeEffect?.(); signal?.throwIfAborted();
      const exclusionInfo = stat(folder);
      if (exclusionInfo && isExcluded?.(folder, exclusionInfo)) throw invalidPath('path');
      // The trusted exclusion reader can run owner callbacks. Read directory
      // identities again afterwards, before any asynchronous filesystem work.
      const currentRoot = realpath(access.projectDir), currentFolder = realpath(requestedFolder);
      const rootNow = currentRoot === null ? null : stat(currentRoot), folderNow = currentFolder === null ? null : stat(currentFolder);
      if (currentRoot !== root || currentFolder !== folder || !rootNow?.isDirectory() || !sameIdentity(rootNow, rootInfo) ||
        !folderNow?.isDirectory() || !sameIdentity(folderNow, folderInfo) || folderNow.mtimeNs !== folderInfo.mtimeNs ||
        folderNow.ctimeNs !== folderInfo.ctimeNs) throw listingChanged('directory');
    } catch (error) {
      fenceFailed = true; fenceFailure = error; throw error;
    }
  };
  async function guarded<T>(read: () => Promise<T>): Promise<T> {
    fence();
    try {const result = await read(); fence(); return result;}
    catch (error) {fence(); throw error;}
  }
  // Keep all async filesystem calls inside the same owner/directory fence,
  // including reads through the descriptor returned to L1's header checker.
  const opening = new Map<string, () => void>();
  const fileSystem: MediaFileSystem = {
    ...base,
    lstat: file => guarded(() => base.lstat(file)),
    realpath: file => guarded(() => base.realpath(file)),
    readDirectory: (file, count) => guarded(() => base.readDirectory(file, count)),
    async open(file) {
      const verify = opening.get(file);
      if (!verify) throw listingChanged('file');
      // Owner/publication callbacks can change admission. Recheck the physical
      // target after the final callback, immediately before opening its path.
      verify(); const handle = await base.open(file);
      try {verify();} catch (error) {await handle.close(); throw error;}
      return {stat: () => guarded(() => handle.stat()), read: (bytes, position) => guarded(() => handle.read(bytes, position)), close: () => handle.close()};
    },
  };
  const prepared = await guarded(() => prepareAccess({...access, mayReadOutside: () => false, fileSystem}));
  const scanned = await fileSystem.readDirectory(folder, MIO_PROJECT_MEDIA_LIMITS.scanEntries + 1);
  if (scanned === null) throw invalidPath('missing');
  const scanTruncated = scanned.length > MIO_PROJECT_MEDIA_LIMITS.scanEntries;
  const snapshot = scanned.slice(0, MIO_PROJECT_MEDIA_LIMITS.scanEntries).filter(entry =>
    isCandidate(entry) && isMioProjectMediaRelativePath(entry.name) && (entry.kind === 'directory' ||
      assetUploadImportSchema.shape.mimeType.safeParse(mediaTypeOfName(entry.name)?.mimeType).success)).sort(byListing);
  const snapshotVersion = hashListing([root, String(rootInfo.dev), String(rootInfo.ino), folder,
    String(folderInfo.dev), String(folderInfo.ino), String(folderInfo.mtimeNs), String(folderInfo.ctimeNs),
    scanTruncated, snapshot.map(entry => [entry.name, entry.kind])]);
  if (previous && (previous[4] !== snapshotVersion || previous[5] > snapshot.length)) throw listingChanged('cursor');
  const pageCursor = (position: number): string => encodeCursor([1, projectId, directoryHash, scopeHash, snapshotVersion, position]);
  const reservedCursor = pageCursor(MIO_PROJECT_MEDIA_LIMITS.scanEntries);
  type Selected = {readonly entry: MioProjectMediaEntry; readonly target: MediaTarget | null; readonly verify: () => void};
  const selected: Selected[] = [];
  let position = previous?.[5] ?? 0;
  function fits(entry: MioProjectMediaEntry): boolean {
    // A finite JSON number is shorter than this placeholder. Reserve the full
    // cursor and outer object before probing, so no probed item is discarded.
    const entries = [...selected.map(item => item.entry), entry].map(item => ({...item,
      durationSeconds: item.kind === 'audio' || item.kind === 'video' ? '0'.repeat(32) : null}));
    return Buffer.byteLength(JSON.stringify({directory, entries, nextCursor: reservedCursor, truncated: true})) <= MIO_PROJECT_MEDIA_LIMITS.resultBytes;
  }
  function targetFence(file: string, target: MediaTarget): () => void {
    let failed = false, failure: unknown;
    return (): void => {
      if (failed) throw failure;
      try {
        fence();
        const reached = realpath(file), now = stat(file), realNow = reached === null ? null : stat(reached);
        if (reached === null || reached !== target.file || !now?.isFile() || !realNow?.isFile() || !sameListedFile(now, target.stats) ||
          !sameListedFile(realNow, target.stats) || !isInsideRealDirectory(root, reached) || isExcluded?.(reached, now)) throw listingChanged('file');
        const admitted = stat(file), admittedReal = realpath(file);
        if (admittedReal !== reached || !admitted?.isFile() || !sameListedFile(admitted, target.stats) ||
          prepared.isHeld({dev: String(admitted.dev), ino: String(admitted.ino)})) throw listingChanged('file');
      } catch (error) {failed = true; failure = error; throw error;}
    };
  }
  while (position < snapshot.length && selected.length < limit) {
    fence(); const candidate = snapshot[position]!, file = nodePath.join(folder, candidate.name);
    if (candidate.kind === 'directory') {
      const reached = realpath(file), info = stat(file);
      if (reached === null || !info?.isDirectory() || !isInsideRealDirectory(root, reached) || isHiddenInside(prepared, reached)) {position++; continue;}
      if (isExcluded?.(reached, info)) {position++; continue;}
      const entry: MioProjectMediaEntry = {name: candidate.name, kind: 'folder', mimeType: null, sizeBytes: null, durationSeconds: null};
      if (!fits(entry)) break;
      const verify = (): void => {
        fence(); const now = stat(file);
        if (realpath(file) !== reached || !now?.isDirectory() || !sameIdentity(now, info)) throw listingChanged('file');
        if (isExcluded?.(reached, now)) throw listingChanged('file');
        const admitted = stat(file);
        if (realpath(file) !== reached || !admitted?.isDirectory() || !sameIdentity(admitted, info)) throw listingChanged('file');
      };
      verify(); selected.push({entry, target: null, verify});
    } else {
      const target = await guarded(() => inspectTarget(prepared, file));
      if (target.kind !== 'media' || target.outside || isExcluded?.(target.file, target.stats) ||
        !Number.isSafeInteger(Number(target.stats.size))) {position++; continue;}
      const mimeType = assetUploadImportSchema.shape.mimeType.safeParse(target.type.mimeType);
      if (!mimeType.success) {position++; continue;}
      const entry: MioProjectMediaEntry = {name: candidate.name, kind: target.type.kind, mimeType: mimeType.data,
        sizeBytes: Number(target.stats.size), durationSeconds: null};
      if (!fits(entry)) break;
      const verify = targetFence(file, target); verify();
      opening.set(target.file, verify);
      try {
        if (!await withMediaFile(prepared, target, session => hasMediaHeader(session, target, signal), {signal, beforeEffect: verify})) {position++; continue;}
      } catch (error) {
        fence();
        // A changed target must invalidate the page rather than silently drop
        // a selected entry after its header or metadata was observed.
        verify();
        if (isFileReadError(error)) {position++; continue;}
        throw error;
      } finally {opening.delete(target.file);}
      verify(); selected.push({entry, target, verify});
    }
    position++;
  }
  const entries = await mapLimited(selected, PROBE_CONCURRENCY, async ({entry, target, verify}): Promise<MioProjectMediaEntry> => {
    verify();
    if (!target || target.type.kind === 'image') return entry;
    const registered = registeredDuration?.(target.file, target.stats); verify();
    if (registered !== undefined) return {...entry, durationSeconds: typeof registered.durationSeconds === 'number' &&
      Number.isFinite(registered.durationSeconds) && registered.durationSeconds >= 0 ? registered.durationSeconds : null};
    let durationSeconds: number | null;
    try {durationSeconds = positiveDuration(await probeDuration(target.file, signal, {beforeEffect: verify}));}
    catch (error) {verify(); if (signal?.aborted) throw error; durationSeconds = null;}
    verify(); return {...entry, durationSeconds};
  }, signal, true);
  fence(); for (const item of selected) item.verify();
  const hasNext = position < snapshot.length;
  return mioProjectMediaListingSchema.parse({directory, entries, nextCursor: hasNext && entries.length > 0 ? pageCursor(position) : null,
    truncated: scanTruncated || hasNext});
}
