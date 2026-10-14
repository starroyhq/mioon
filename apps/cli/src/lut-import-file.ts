import {constants, lstatSync, openSync, fstatSync, readSync, closeSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import path from 'node:path';
import {LUT_RESOURCE_LIMITS} from '@mioon/contracts/lut-resources';

type ImportFileErrorCode = 'VALIDATION_ERROR' | 'FILE_TOO_LARGE' | 'FILE_READ_ERROR';

/** Kept independent of the legacy CLI/client entrypoints for strict checking and
 * isolated tests. The CLI translates this error to its public ClientError. */
export class LutImportFileError extends Error {
  readonly code: ImportFileErrorCode;
  constructor(code: ImportFileErrorCode, message: string) {
    super(message);
    this.name = 'LutImportFileError';
    this.code = code;
  }
}

function fail(message: string): never { throw new LutImportFileError('FILE_READ_ERROR', message); }
function tooLarge(): never { throw new LutImportFileError('FILE_TOO_LARGE', 'LUT import source exceeds 7 MiB (7340032 bytes). Choose a smaller .cube file.'); }
function changed(): never { return fail('LUT import source changed while reading. Stop other writers, check the file and retry.'); }
const sameIdentity = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a: BigIntStats, b: BigIntStats): boolean => sameIdentity(a, b)
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
  && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode && a.nlink === b.nlink;

function fileMetadata(info: BigIntStats, uid: bigint): BigIntStats {
  if (info.isSymbolicLink()) fail('LUT import source must not be a symbolic link. Select the original canonical .cube file.');
  if (!info.isFile()) fail('LUT import source must be a regular local .cube file.');
  if (info.uid !== uid) fail('LUT import source must be owned by your account. Select an owned copy.');
  if (info.nlink !== 1n) fail('LUT import source must have exactly one filesystem link. Select an independent copy.');
  if ((info.mode & 0o022n) !== 0n) fail('LUT import source must not be writable by other accounts. Review its permissions before retrying.');
  if (info.size < 0n) fail('Cannot determine the LUT import source size safely.');
  if (info.size > BigInt(LUT_RESOURCE_LIMITS.sourceBytes)) tooLarge();
  return info;
}

/** Match the private-storage POSIX ancestor policy without demanding a 0700
 * import-source parent: ordinary owner/root-owned 0755 Downloads directories
 * are safe. This reads only; it never repairs permissions, links or ownership. */
function ancestors(file: string, uid: bigint): Map<string, BigIntStats> {
  const parent = path.dirname(file), root = path.parse(parent).root;
  let current = root;
  const result = new Map<string, BigIntStats>();
  for (const part of ['', ...parent.slice(root.length).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const info = lstatSync(current, {bigint: true});
    if (info.isSymbolicLink()) fail('LUT import source ancestors must not be symbolic links. Select the original canonical path.');
    if (!info.isDirectory()) fail('LUT import source must be inside regular local directories.');
    if (info.uid !== 0n && info.uid !== uid) fail('LUT import source ancestors must be owned by your account or the system administrator.');
    if ((info.mode & 0o022n) !== 0n && (info.mode & 0o1000n) === 0n) {
      fail('A LUT import source ancestor is writable by other accounts. Choose a safe directory or review its permissions.');
    }
    result.set(current, info);
  }
  return result;
}

/** Read explicit local bytes without decoding or normalizing them. Bounded reads,
 * no-follow opens, and pre/post metadata fences reject observed changes. As in
 * private-storage, a same-user/root process can still race pathname operations;
 * this is not a sandbox against hostile processes running as the current user. */
export function importLutFile(input: Readonly<Record<string, unknown>>, file: string): Record<string, unknown> & {dataBase64: string} {
  if (Object.hasOwn(input, 'dataBase64')) {
    throw new LutImportFileError('VALIDATION_ERROR', 'Use --file or dataBase64, not both.');
  }
  if (typeof file !== 'string' || !file || file.includes('\0') || file.split(path.sep).includes('..')) {
    throw new LutImportFileError('VALIDATION_ERROR', 'Use an explicit canonical local .cube path without parent-directory (..) components.');
  }
  if (path.extname(file).toLowerCase() !== '.cube') {
    throw new LutImportFileError('VALIDATION_ERROR', 'LUT import --file requires a .cube file (extension is case-insensitive).');
  }
  if (!['linux', 'darwin', 'freebsd', 'openbsd', 'netbsd', 'aix', 'sunos'].includes(process.platform)
    || typeof process.getuid !== 'function' || !constants.O_NOFOLLOW || !constants.O_NONBLOCK) {
    fail('Safe local LUT file intake is unavailable on this platform. Use a supported POSIX local filesystem; Windows ACL intake is not implemented.');
  }
  const uid = BigInt(process.getuid()), target = path.resolve(file);
  let descriptor: number | undefined;
  try {
    const beforeAncestors = ancestors(target, uid);
    const before = fileMetadata(lstatSync(target, {bigint: true}), uid);
    // NONBLOCK also prevents a same-user FIFO substitution from hanging open.
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fileMetadata(fstatSync(descriptor, {bigint: true}), uid);
    if (!sameFile(before, opened)) changed();
    // Both observed sizes are checked BEFORE allocating. One probe byte detects
    // growth without a readFile-style unbounded allocation, even for tiny files.
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(descriptor, bytes, count, bytes.length - count, count);
      if (!read) break;
      count += read;
    }
    if (count > LUT_RESOURCE_LIMITS.sourceBytes) tooLarge();
    const afterRead = fileMetadata(fstatSync(descriptor, {bigint: true}), uid);
    if (!sameFile(opened, afterRead) || BigInt(count) !== opened.size) changed();
    const afterAncestors = ancestors(target, uid);
    for (const [directory, initial] of beforeAncestors) {
      const latest = afterAncestors.get(directory);
      if (!latest || !sameIdentity(initial, latest) || initial.uid !== latest.uid || initial.gid !== latest.gid || initial.mode !== latest.mode) changed();
    }
    const after = fileMetadata(lstatSync(target, {bigint: true}), uid);
    if (!sameFile(opened, after)) changed();
    return {...input, name: input.name === undefined ? path.basename(target) : input.name, dataBase64: bytes.subarray(0, count).toString('base64')};
  } catch (error: unknown) {
    if (error instanceof LutImportFileError) throw error;
    return fail('Cannot safely read the explicitly requested local LUT file. Check that the canonical .cube file exists and is readable by your account.');
  } finally {
    if (descriptor !== undefined) {
      // Preserve the actionable intake error if closing a rejected descriptor
      // also fails; the descriptor is never intentionally retained for reuse.
      try { closeSync(descriptor); } catch { /* No filesystem changes to undo. */ }
    }
  }
}
