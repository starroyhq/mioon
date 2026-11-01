import type {BigIntStats} from 'node:fs';
import nodePath from 'node:path';
import {mediaReferenceSchema} from '../../../contracts/src/media-reference.ts';
import type {MediaReference, MediaStatus} from '../../../contracts/src/media-reference.ts';
import type {ProjectFileIdentity} from '../../../contracts/src/project-registry.ts';
import {identityOfStats, sameProjectFileIdentity} from '../app-db/identity.ts';
import {mediaReferenceError} from './errors.ts';
import {NODE_MEDIA_FILE_SYSTEM} from './file-system.ts';
import type {MediaFileHandle, MediaFileSystem} from './file-system.ts';
import {hashSamples, hashWhole, isNotDownloaded, mediaMtimeMs, readHeader} from './fingerprint.ts';
import {detectMediaType, isProtectedName, mediaTypeOfName} from './media-type.ts';
import type {MediaType} from './media-type.ts';
import {isInsideDirectory, parseLocalPath, referencePathFor, resolveReferencePath} from './paths.ts';

// Reading media safely (plan 8.4). This process may have the project open,
// and closing any descriptor of its project file, the `-journal` beside it or
// another database it holds drops SQLite's POSIX locks on that file. So
// everything that can be decided without opening is decided first, with
// realpath and lstat only, in this order:
// 1. the reference passes the contract's schema and resolves against the real
//    project directory; an absolute path of the other platform is missing;
// 2. realpath: a file reached through a symbolic link is judged by where it
//    really is: inside or outside, its name and its identity;
// 3. it is a regular file;
// 4. neither the name it was reached by nor its real name is protected (a dot
//    file, `*.mioon-journal`, a super-journal, a `.mioon`), no name below the
//    project directory starts with `.` (the test layout's `.mioon-store/`), and
//    both extensions are media;
// 5. it is not the project file or its journal by file identity (hard links)
//    or real path, nor a file `isHeld` names;
// 6. it is downloaded: at least 4 KiB without a block is a cloud placeholder;
// 7. outside the project directory, `mayReadOutside` decides whether it may
//    be read; whatever needs only lstat is still reported.
// Only then is it opened (O_RDONLY | O_NOFOLLOW | O_NONBLOCK). The descriptor's
// fstat must match the lstat of step 3 (device, file ID, size, modification
// time) when it is opened and after every read, or the read fails with
// MEDIA_CHANGED_DURING_READ; and the first 1024 bytes must match the format of
// the extension before anything else is read. A same-user swap to a hard link
// of a protected file between the lstat and the open is not caught, as in
// managed-media.ts.

export interface MediaAccess {
  /** The folder of the `.mioon`, absolute. */
  readonly projectDir: string;
  /** The `.mioon`. Neither it nor its `-journal` is ever opened. */
  readonly projectFile: string;
  /** Files outside the project directory are read only where this holds for
   * their real path; e.g. insideAnyDirectory of the folders the user confirmed. */
  readonly mayReadOutside: (realFile: string) => boolean;
  /** Other files this process keeps open, such as the local records and the
   * cache of open projects: never opened either. */
  readonly isHeld?: (identity: ProjectFileIdentity) => boolean;
  readonly fileSystem?: MediaFileSystem;
}
export interface MediaFile {
  /** The real path. */
  readonly file: string;
  readonly type: MediaType;
  readonly reference: MediaReference;
}
/** Why a status is what it is. online: `same-stats` (size and modification
 * time match, nothing was read) or `same-content` (only the modification time
 * differs and the samples match). missing: `not-found`, `no-access`,
 * `not-a-file`, `not-downloaded` or `other-platform`. changed: `size`,
 * `content`, `not-media` (a protected file, another extension or a header of
 * another format), or `unverified` (only the modification time differs and
 * the file may not be read yet). */
export type MediaStatusReason = 'same-stats' | 'same-content' | 'not-found' | 'no-access' | 'not-downloaded' | 'other-platform'
  | 'not-a-file' | 'size' | 'content' | 'not-media' | 'unverified';
export interface MediaStatusResult {
  readonly status: MediaStatus;
  readonly reason: MediaStatusReason;
  /** The real path, when there is one. */
  readonly file: string | null;
  /** Outside the project directory. For a path that names no file here, read
   * from the stored form. */
  readonly outside: boolean;
  /** Whether the file may be read now: online or changed by its stats, and
   * inside the project directory or confirmed. */
  readonly readable: boolean;
  /** The reference; after `same-content` with the new `mtimeMs` and no
   * `fullSha256`, since bytes outside the samples may have changed. */
  readonly reference: MediaReference;
}

// ---------------------------------------------------------------------------
// Internals shared with relink.ts and listing.ts

export interface PreparedAccess {
  readonly fileSystem: MediaFileSystem;
  /** The real project directory. */
  readonly projectDir: string;
  readonly projectDev: bigint;
  /** The project file and its journal. */
  readonly protectedFiles: readonly {readonly identity: ProjectFileIdentity | null; readonly real: string | null}[];
  readonly mayReadOutside: (realFile: string) => boolean;
  readonly isHeld: (identity: ProjectFileIdentity) => boolean;
}
type MissingReason = 'not-found' | 'no-access' | 'not-a-file' | 'not-downloaded' | 'other-platform';
export interface MediaTarget {
  readonly kind: 'media';
  readonly file: string;
  readonly stats: BigIntStats;
  readonly type: MediaType;
  readonly outside: boolean;
  readonly readable: boolean;
}
export type Inspection = MediaTarget
  | {readonly kind: 'missing'; readonly reason: MissingReason; readonly file: string | null; readonly outside: boolean}
  | {readonly kind: 'not-media'; readonly reason: 'protected' | 'extension'; readonly file: string; readonly outside: boolean};
export interface MediaReadSession {
  readonly handle: MediaFileHandle;
  /** fstat again; MEDIA_CHANGED_DURING_READ unless the file is still the one inspected. */
  verify(): Promise<void>;
}

const errorCode = (error: unknown): unknown => (error as {code?: unknown} | null | undefined)?.code;
const isAccessError = (error: unknown): boolean => errorCode(error) === 'EACCES' || errorCode(error) === 'EPERM';
/** MEDIA_MISSING with `no-access`, as withMediaFile throws it when the open is refused. */
export const isNoAccess = (error: unknown): boolean =>
  errorCode(error) === 'MEDIA_MISSING' && (error as {details?: {reason?: unknown}}).details?.reason === 'no-access';
/** What inspection and reading throw for one file; the file is skipped or reported, never the whole call. */
export const isFileReadError = (error: unknown): boolean => isNoAccess(error) || errorCode(error) === 'MEDIA_CHANGED_DURING_READ';

/** realpath or lstat, null on any error. */
export async function quietly<T>(read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

export function parseReference(reference: MediaReference): MediaReference {
  const parsed = mediaReferenceSchema.safeParse(reference);
  if (!parsed.success) throw mediaReferenceError('MEDIA_REFERENCE_INVALID', {reason: 'schema'});
  return parsed.data;
}

/** The real project directory and the identities of the files never opened. */
export async function prepareAccess(access: MediaAccess): Promise<PreparedAccess> {
  if (parseLocalPath(access?.projectDir) === null || parseLocalPath(access.projectFile) === null || typeof access.mayReadOutside !== 'function') {
    throw new TypeError('Invalid media access');
  }
  const fileSystem = access.fileSystem ?? NODE_MEDIA_FILE_SYSTEM;
  const projectDir = await quietly(() => fileSystem.realpath(access.projectDir));
  const info = projectDir === null ? null : await quietly(() => fileSystem.lstat(projectDir));
  if (projectDir === null || info === null || !info.isDirectory()) throw mediaReferenceError('MEDIA_MISSING', {reason: 'project-directory'});
  const protectedFiles = await Promise.all([access.projectFile, `${access.projectFile}-journal`].map(async file => ({
    identity: identityOfStats(await quietly(() => fileSystem.lstat(file)) ?? undefined),
    real: await quietly(() => fileSystem.realpath(file)),
  })));
  return {fileSystem, projectDir, projectDev: info.dev, protectedFiles, mayReadOutside: access.mayReadOutside, isHeld: access.isHeld ?? (() => false)};
}

const isOutside = (prepared: PreparedAccess, file: string): boolean => !isInsideDirectory(prepared.projectDir, file);
/** Whether a name below the project directory starts with `.`. */
export function isHiddenInside(prepared: PreparedAccess, file: string): boolean {
  const directory = parseLocalPath(prepared.projectDir), target = parseLocalPath(file);
  return directory !== null && target !== null && isInsideDirectory(prepared.projectDir, file) &&
    target.segments.slice(directory.segments.length).some(name => name.startsWith('.'));
}
function isProtectedFile(prepared: PreparedAccess, real: string, stats: BigIntStats): boolean {
  const identity = identityOfStats(stats);
  return prepared.protectedFiles.some(entry => sameProjectFileIdentity(entry.identity, identity) || entry.real === real) ||
    identity !== null && prepared.isHeld(identity);
}

/** Steps 2 to 7 for a local absolute path; nothing is opened. */
export async function inspectTarget(prepared: PreparedAccess, file: string): Promise<Inspection> {
  let real: string | null, stats: BigIntStats | null;
  try {
    real = await prepared.fileSystem.realpath(file);
    stats = real === null ? null : await prepared.fileSystem.lstat(real);
  } catch (error) {
    return {kind: 'missing', reason: isAccessError(error) ? 'no-access' : 'not-found', file: null, outside: isOutside(prepared, file)};
  }
  if (real === null || stats === null) return {kind: 'missing', reason: 'not-found', file: null, outside: isOutside(prepared, file)};
  const outside = isOutside(prepared, real), name = nodePath.basename(file), realName = nodePath.basename(real);
  if (!stats.isFile()) return {kind: 'missing', reason: 'not-a-file', file: real, outside};
  if (isProtectedName(name) || isProtectedName(realName) || isHiddenInside(prepared, real)) return {kind: 'not-media', reason: 'protected', file: real, outside};
  const type = mediaTypeOfName(realName);
  if (type === null || mediaTypeOfName(name) === null) return {kind: 'not-media', reason: 'extension', file: real, outside};
  if (isProtectedFile(prepared, real, stats)) return {kind: 'not-media', reason: 'protected', file: real, outside};
  if (isNotDownloaded(stats)) return {kind: 'missing', reason: 'not-downloaded', file: real, outside};
  return {kind: 'media', file: real, stats, type, outside, readable: !outside || prepared.mayReadOutside(real)};
}

const sameFile = (now: BigIntStats, inspected: BigIntStats): boolean =>
  now.isFile() && now.dev === inspected.dev && now.ino === inspected.ino && now.size === inspected.size && now.mtimeNs === inspected.mtimeNs;

/** Opens an inspected file and runs `read` on it, checking the descriptor
 * against the inspection first. A refused open is MEDIA_MISSING (`no-access`);
 * any other failed open means the file changed since it was inspected. */
export async function withMediaFile<T>(prepared: PreparedAccess, target: MediaTarget, read: (session: MediaReadSession) => Promise<T>): Promise<T> {
  let handle: MediaFileHandle;
  try {
    handle = await prepared.fileSystem.open(target.file);
  } catch (error) {
    throw isAccessError(error) ? mediaReferenceError('MEDIA_MISSING', {reason: 'no-access'}) : mediaReferenceError('MEDIA_CHANGED_DURING_READ');
  }
  try {
    const verify = async (): Promise<void> => {
      if (!sameFile(await handle.stat(), target.stats)) throw mediaReferenceError('MEDIA_CHANGED_DURING_READ');
    };
    await verify();
    return await read({handle, verify});
  } finally {
    await handle.close();
  }
}

/** Whether the first bytes match the format of the extension. */
export async function hasMediaHeader(session: MediaReadSession, target: MediaTarget, signal?: AbortSignal): Promise<boolean> {
  const header = await readHeader(session.handle, Number(target.stats.size), signal);
  await session.verify();
  return detectMediaType(nodePath.basename(target.file), header) !== null;
}

/** `sampledSha256`, or null when the header is not media and nothing else was read. */
export async function readSampledSha256(session: MediaReadSession, target: MediaTarget, signal?: AbortSignal): Promise<string | null> {
  if (!await hasMediaHeader(session, target, signal)) return null;
  const sampled = await hashSamples(session.handle, Number(target.stats.size), signal);
  await session.verify();
  return sampled;
}

/** A reference to an inspected file as it is now, for referenceForFile and a
 * file chosen to relink. */
export async function freshMediaFile(prepared: PreparedAccess, target: Inspection, signal?: AbortSignal): Promise<MediaFile> {
  if (target.kind === 'missing') {
    throw target.reason === 'not-a-file' ? mediaReferenceError('MEDIA_NOT_MEDIA', {reason: 'not-a-file'}) : mediaReferenceError('MEDIA_MISSING', {reason: target.reason});
  }
  if (target.kind === 'not-media') throw mediaReferenceError('MEDIA_NOT_MEDIA', {reason: target.reason});
  if (!target.readable) throw mediaReferenceError('MEDIA_OUTSIDE_NOT_CONFIRMED');
  const sampledSha256 = await withMediaFile(prepared, target, session => readSampledSha256(session, target, signal));
  if (sampledSha256 === null) throw mediaReferenceError('MEDIA_NOT_MEDIA', {reason: 'content'});
  const location = referencePathFor(prepared.projectDir, target.file, target.stats.dev === prepared.projectDev);
  return {file: target.file, type: target.type, reference: parseReference({
    ...location, sizeBytes: Number(target.stats.size), mtimeMs: mediaMtimeMs(target.stats), sampledSha256, fullSha256: null,
  })};
}

export interface Evaluation {
  readonly result: MediaStatusResult;
  /** The inspected file unless the status is missing or `not-media`. */
  readonly target: MediaTarget | null;
  /** Whether its header was read and matched. */
  readonly probed: boolean;
}
/** The status of a parsed reference. */
export async function evaluateReference(prepared: PreparedAccess, reference: MediaReference, signal?: AbortSignal): Promise<Evaluation> {
  signal?.throwIfAborted();
  const local = resolveReferencePath(prepared.projectDir, reference);
  if (local === null) {
    const outside = reference.pathForm === 'absolute' || reference.path.startsWith('..');
    return {result: {status: 'missing', reason: 'other-platform', file: null, outside, readable: false, reference}, target: null, probed: false};
  }
  const target = await inspectTarget(prepared, local);
  if (target.kind !== 'media') {
    const missing = target.kind === 'missing';
    return {result: {status: missing ? 'missing' : 'changed', reason: missing ? target.reason : 'not-media', file: target.file, outside: target.outside,
      readable: false, reference}, target: null, probed: false};
  }
  const result = (status: MediaStatus, reason: MediaStatusReason, probed = false, next = reference): Evaluation =>
    ({result: {status, reason, file: target.file, outside: target.outside, readable: target.readable, reference: next}, target, probed});
  const mtimeMs = mediaMtimeMs(target.stats);
  if (Number(target.stats.size) !== reference.sizeBytes) return result('changed', 'size');
  if (mtimeMs === reference.mtimeMs) return result('online', 'same-stats');
  if (!target.readable) return result('changed', 'unverified');
  let sampled: string | null;
  try {
    sampled = await withMediaFile(prepared, target, session => readSampledSha256(session, target, signal));
  } catch (error) {
    if (!isNoAccess(error)) throw error;
    return {result: {status: 'missing', reason: 'no-access', file: target.file, outside: target.outside, readable: false, reference}, target: null, probed: false};
  }
  if (sampled === null) return {result: {status: 'changed', reason: 'not-media', file: target.file, outside: target.outside, readable: false, reference},
    target: null, probed: false};
  if (sampled !== reference.sampledSha256) return result('changed', 'content', true);
  return result('online', 'same-content', true, {...reference, mtimeMs, fullSha256: null});
}

/** The target of an online, readable reference; the error for any other status. */
function admittedTarget({result, target}: Evaluation): MediaTarget {
  if (result.status === 'missing') throw mediaReferenceError('MEDIA_MISSING', {reason: result.reason});
  if (target === null || result.reason === 'not-media') throw mediaReferenceError('MEDIA_CHANGED', {reason: 'not-media'});
  if (!result.readable) throw mediaReferenceError('MEDIA_OUTSIDE_NOT_CONFIRMED');
  if (result.status === 'changed') throw mediaReferenceError('MEDIA_CHANGED', {reason: result.reason});
  return target;
}

// ---------------------------------------------------------------------------
// Public functions

/** A new reference to `file`, an absolute path, e.g. when it is imported: the
 * real location, relative on the project's volume, with a fingerprint and no
 * full hash. MEDIA_MISSING, MEDIA_NOT_MEDIA (`protected`, `extension`,
 * `not-a-file`, `content`) or MEDIA_OUTSIDE_NOT_CONFIRMED when it may not be
 * used; nothing is opened before step 7 has passed. */
export async function referenceForFile(access: MediaAccess, file: string, {signal}: {signal?: AbortSignal} = {}): Promise<MediaFile> {
  if (parseLocalPath(file) === null) throw new TypeError('The file must be an absolute path');
  signal?.throwIfAborted();
  const prepared = await prepareAccess(access);
  return freshMediaFile(prepared, await inspectTarget(prepared, file), signal);
}

/** Online, missing or changed (contract), with the reason. Nothing is read
 * while size and modification time match; when only the time differs, the
 * samples of a readable file are compared. */
export async function checkMediaStatus(access: MediaAccess, reference: MediaReference, {signal}: {signal?: AbortSignal} = {}): Promise<MediaStatusResult> {
  const recorded = parseReference(reference);
  return (await evaluateReference(await prepareAccess(access), recorded, signal)).result;
}

/** The file of an online reference that may be read, with its header checked:
 * before it is previewed, exported or sent. MEDIA_MISSING, MEDIA_CHANGED
 * (`size`, `content`, `not-media`), MEDIA_OUTSIDE_NOT_CONFIRMED or
 * MEDIA_NOT_MEDIA (`content`) otherwise. */
export async function admitMedia(access: MediaAccess, reference: MediaReference, {signal}: {signal?: AbortSignal} = {}): Promise<MediaFile> {
  const recorded = parseReference(reference);
  const prepared = await prepareAccess(access);
  const evaluation = await evaluateReference(prepared, recorded, signal);
  const target = admittedTarget(evaluation);
  if (!evaluation.probed && !await withMediaFile(prepared, target, session => hasMediaHeader(session, target, signal))) {
    throw mediaReferenceError('MEDIA_NOT_MEDIA', {reason: 'content'});
  }
  return {file: target.file, type: target.type, reference: evaluation.result.reference};
}

/** SHA-256 of the whole admitted file, e.g. before a paid generation uses it,
 * and the reference with it as `fullSha256`. A reference that already holds a
 * different full hash is MEDIA_CHANGED (`content`): bytes outside the samples
 * changed while size and modification time stayed. */
export async function computeFullSha256(access: MediaAccess, reference: MediaReference,
  {signal, onBytes}: {signal?: AbortSignal; onBytes?: (bytes: number) => void} = {}): Promise<{sha256: string; reference: MediaReference}> {
  const recorded = parseReference(reference);
  const prepared = await prepareAccess(access);
  const evaluation = await evaluateReference(prepared, recorded, signal);
  const target = admittedTarget(evaluation);
  const sha256 = await withMediaFile(prepared, target, async session => {
    if (!await hasMediaHeader(session, target, signal)) throw mediaReferenceError('MEDIA_NOT_MEDIA', {reason: 'content'});
    const whole = await hashWhole(session.handle, Number(target.stats.size), {signal, onBytes});
    await session.verify();
    return whole;
  });
  if (recorded.fullSha256 !== null && recorded.fullSha256 !== sha256) throw mediaReferenceError('MEDIA_CHANGED', {reason: 'content'});
  return {sha256, reference: {...evaluation.result.reference, fullSha256: sha256}};
}
