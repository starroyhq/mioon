import {createHash, randomUUID} from 'node:crypto';
import {accessSync, chmodSync, constants, lstatSync, mkdirSync, openSync, closeSync, fsyncSync,
  readlinkSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, type BigIntStats} from 'node:fs';
import path from 'node:path';
import {ensurePrivateDirectory, readPrivateFile, removePrivateFile} from '@mioon/contracts/private-storage';
import {MAC_CLI_LAUNCHER_MAX_BYTES} from '../cli-launcher-binary.ts';

const namespacePattern = /^[a-f0-9-]{36}$/u;
const launcherLimit = MAC_CLI_LAUNCHER_MAX_BYTES - 1;
export const appVersionPattern = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u;
export interface FileIdentity {ino: string; born: string}
export const errorCode = (error: unknown): unknown => (error as {code?: unknown} | null)?.code;

export function pathIsAbsolute(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value)
    && path.normalize(value) === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function lstat(file: string): BigIntStats | undefined {
  try {return lstatSync(file, {bigint: true});}
  catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

export function fileIdentity(info: BigIntStats): FileIdentity {
  // A macOS mount may be assigned a different device number after reboot.
  // The inode and birth time stay with the entry and also fence inode reuse.
  return {ino: String(info.ino), born: String(info.birthtimeNs)};
}

export function inodeMatches(info: BigIntStats, identity: FileIdentity): boolean {
  return String(info.ino) === identity.ino && String(info.birthtimeNs) === identity.born;
}

export function isIdentity(value: unknown): value is FileIdentity {
  if (!value || typeof value !== 'object') return false;
  const info = value as Partial<FileIdentity>;
  return typeof info.ino === 'string' && /^\d{1,24}$/u.test(info.ino)
    && typeof info.born === 'string' && /^\d{1,28}$/u.test(info.born);
}

export function installDirectory(directory: string, create = false, writable = true): BigIntStats {
  const parent = path.dirname(directory);
  if (create && !lstat(directory)) {
    if (!lstat(parent)) {
      if (realpathSync(path.dirname(parent)) !== path.dirname(parent)) throw Object.assign(new Error(), {code: 'EACCES'});
      try {mkdirSync(parent, {mode: 0o700});}
      catch (error) {if (errorCode(error) !== 'EEXIST') throw error;}
    }
    if (realpathSync(parent) !== parent) throw Object.assign(new Error(), {code: 'EACCES'});
    try {mkdirSync(directory, {mode: 0o700});}
    catch (error) {if (errorCode(error) !== 'EEXIST') throw error;}
  }
  const info = lstat(directory);
  if (!info?.isDirectory() || realpathSync(directory) !== directory) {
    throw Object.assign(new Error(), {code: 'EACCES'});
  }
  if (writable) accessSync(directory, constants.W_OK | constants.X_OK);
  return info;
}

export function ownedLink(file: string, target: string, identity: FileIdentity): boolean {
  const before = lstat(file);
  if (!before?.isSymbolicLink() || before.uid !== BigInt(process.getuid!()) || !inodeMatches(before, identity)) return false;
  const text = readlinkSync(file);
  const after = lstat(file);
  return text === target && Boolean(after?.isSymbolicLink() && inodeMatches(after, identity));
}

export function pointsTo(file: string, target: string): boolean {
  try {return Boolean(lstat(file)?.isSymbolicLink() && readlinkSync(file) === target);}
  catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'EINVAL') return false;
    throw error;
  }
}

export function createLink(pathname: string, target: string): FileIdentity {
  symlinkSync(target, pathname);
  const info = lstat(pathname);
  if (!info?.isSymbolicLink() || !pointsTo(pathname, target)) throw Object.assign(new Error(), {code: 'EEXIST'});
  return fileIdentity(info);
}

export function removeLink(file: string, target: string, identity: FileIdentity): void {
  if (ownedLink(file, target, identity)) unlinkSync(file);
}

export function copyLocation(root: string, version: string, key: string, commandName: string): string {
  return path.join(root, 'cli', version, key, commandName);
}

export function newCopyLocation(root: string, version: string, commandName: string): {file: string; directoryId: FileIdentity} {
  const file = copyLocation(root, version, randomUUID(), commandName);
  const directory = path.dirname(file);
  ensurePrivateDirectory(path.dirname(directory), {create: true});
  mkdirSync(directory, {mode: 0o700});
  return {file, directoryId: fileIdentity(lstat(directory)!)};
}

export function isCopyLocation(file: string, root: string, version: string, commandName: string): boolean {
  const key = path.basename(path.dirname(file));
  return namespacePattern.test(key) && file === copyLocation(root, version, key, commandName);
}

export interface CopyProof {id: FileIdentity; sha256: string}
export function copyProof(file: string, root: string): CopyProof | undefined {
  const state = lstat(file);
  if (!state?.isFile() || (state.mode & 0o777n) !== 0o700n) return undefined;
  const bytes = readPrivateFile(file, {root, allowMissing: true, maxBytes: launcherLimit});
  if (!bytes) return undefined;
  const id = fileIdentity(state);
  const after = lstat(file);
  if (!after || !inodeMatches(after, id)) return undefined;
  return {id, sha256: createHash('sha256').update(bytes).digest('hex')};
}

export function finalizeCopy(file: string, root: string): CopyProof {
  const initial = lstat(file);
  if (!initial?.isFile() || initial.nlink !== 1n || initial.uid !== BigInt(process.getuid!())) {
    throw new Error('Untrusted launcher copy');
  }
  chmodSync(file, 0o700);
  const result = copyProof(file, root);
  if (!result) throw new Error('Invalid launcher copy');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {fsyncSync(fd);} finally {closeSync(fd);}
  return result;
}

export function copyMatches(file: string, root: string, proof: CopyProof): boolean {
  try {
    const current = copyProof(file, root);
    return current?.id.ino === proof.id.ino && current.id.born === proof.id.born && current.sha256 === proof.sha256;
  } catch {return false;}
}

export function removeCopy(file: string, root: string, proof: CopyProof): void {
  if (!copyMatches(file, root, proof)) return;
  removePrivateFile(file, {root, maxBytes: launcherLimit});
  removeCopyDirectories(file);
}

export function discardUnpublishedCopy(file: string, directoryId: FileIdentity): void {
  const directory = path.dirname(file);
  const parent = lstat(directory);
  if (!parent?.isDirectory() || !inodeMatches(parent, directoryId) || realpathSync(directory) !== directory) return;
  const info = lstat(file);
  if (info) {
    if (!info.isFile() || info.nlink !== 1n || info.uid !== BigInt(process.getuid!())) return;
    unlinkSync(file);
  }
  removeCopyDirectories(file);
}

function removeCopyDirectories(file: string): void {
  for (const directory of [path.dirname(file), path.dirname(path.dirname(file))]) {
    try {rmdirSync(directory);}
    catch (error) {if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(String(errorCode(error)))) throw error;}
  }
}
