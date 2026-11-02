import {lstatSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {isAsyncFunction} from 'node:util/types';
import {ensurePrivateDirectory} from '@mioon/contracts/private-storage';
import {validateWorkspaceStorage} from '@mioon/business/application-storage';
import {AppError} from '../../../../packages/contracts/src/app-error.ts';
import type {AppDirectories} from './directories.ts';

const within = (root: string, file: string) => file === root || file.startsWith(root + path.sep);

/** Application preflight, separate from the explicit legacy workspace opener.
 * An old workspace is refused before a new lock, database or token is created. */
export function validateApplicationStorage(directories: AppDirectories): void {
  const {dataDir, projectsDir, cacheDir, tempDir} = directories;
  if (within(projectsDir, dataDir) || [path.join(dataDir, 'records'), cacheDir, tempDir].some(root => within(root, projectsDir) || within(projectsDir, root))) throw new AppError('PROJECT_LOCATION_INVALID', '项目目录不能覆盖应用私有目录。', 400);
  validateWorkspaceStorage(dataDir, {cacheDir, tempDir});
  ensurePrivateDirectory(dataDir, {create: true});
}

interface ApplicationFileMetadata {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeNs?: bigint;
  readonly mtimeNs?: bigint;
  readonly ctimeNs?: bigint;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
interface ApplicationFileGuardOptions {
  /** Trusted metadata-only test seam for filesystems that reuse inode IDs.
   * Never supplied by HTTP or environment configuration; it opens no files. */
  readonly metadata?: (file: string) => ApplicationFileMetadata | undefined;
}
const metadata = (file: string): ApplicationFileMetadata | undefined => {
  try {return lstatSync(file, {bigint: true, throwIfNoEntry: false});}
  catch (error) {if ((error as {code?: unknown}).code === 'ENOTDIR') return undefined; throw error;}
};
const generation = (info: ApplicationFileMetadata): bigint => typeof info.birthtimeNs === 'bigint' && info.birthtimeNs > 0n ? info.birthtimeNs : 0n;

/** One synchronous recovery sweep; do not create/move private files in its
 * callback. A snapshot must never be retained across an await. */
export interface ApplicationFileGuard {
  (file: string): void;
  withSnapshot<T>(inspect: () => T): T;
}

// Both times are needed: directory mtime may be restored by a caller, while
// ctime still changes on entry creation/removal. Missing metadata never permits
// a cached negative lookup. File content writes do not change its identity.
const directoryStamp = (info: ApplicationFileMetadata): string | undefined =>
  info.ino !== 0n && typeof info.mtimeNs === 'bigint' && info.mtimeNs > 0n && typeof info.ctimeNs === 'bigint' && info.ctimeNs > 0n
    ? `${info.dev}:${info.ino}:${generation(info)}:${info.mtimeNs}:${info.ctimeNs}` : undefined;

/** Remember identities as private files appear, including files subsequently
 * renamed outside the app directory. Metadata only: never open/close a live DB.
 * The default projects subtree is deliberately exempt. */
export function createApplicationFileGuard(directories: AppDirectories, {metadata: readMetadata = metadata}: ApplicationFileGuardOptions = {}): ApplicationFileGuard {
  // A deleted private inode may be reused for a newly created project on ext4.
  // Birth time survives rename/hard links, unlike ctime, and distinguishes that
  // new generation when both observations provide it. Unknown time stays
  // conservative; it cannot erase a private file's retained identity.
  const identities = new Map<string, bigint>();
  const directoryEntries = new Map<string, {stamp: string | undefined; directories: readonly string[]}>();
  const {dataDir, projectsDir, cacheDir, tempDir} = directories;
  const protectedRoots = [path.join(dataDir, 'records'), cacheDir, tempDir];
  const refresh = (): void => {
    // Walk directories, not every unchanged file. There is no file-count or
    // depth cutoff: an oversized tree must neither reject all projects nor
    // silently leave some private identities unobserved.
    const pending = [dataDir, ...protectedRoots.filter(root => !within(dataDir, root))];
    const visited = new Set<string>();
    while (pending.length) {
      const file = pending.pop()!;
      if (visited.has(file) || within(projectsDir, file)) continue;
      visited.add(file);
      const info = readMetadata(file);
      if (!info || info.isSymbolicLink()) {directoryEntries.delete(file); continue;}
      if (info.isFile()) {
        if (info.ino !== 0n) identities.set(`${info.dev}:${info.ino}`, generation(info));
      } else if (info.isDirectory()) {
        const stamp = directoryStamp(info), previous = directoryEntries.get(file);
        if (stamp !== undefined && previous?.stamp === stamp) {
          for (const child of previous.directories) pending.push(child);
          continue;
        }
        const children: string[] = [];
        for (const name of readdirSync(file)) {
          const child = path.join(file, name);
          if (within(projectsDir, child)) continue;
          const found = readMetadata(child);
          if (!found || found.isSymbolicLink()) continue;
          if (found.isDirectory()) children.push(child);
          else if (found.isFile() && found.ino !== 0n) identities.set(`${found.dev}:${found.ino}`, generation(found));
        }
        // If an external writer changed entries during this scan, do not cache
        // it as an unchanged directory on the next check.
        const after = readMetadata(file);
        directoryEntries.set(file, {stamp: after?.isDirectory() && directoryStamp(after) === stamp ? stamp : undefined, directories: children});
        for (const child of children) pending.push(child);
      }
    }
  };
  refresh();
  let snapshotDepth = 0;
  const guard = (requested: string): void => {
    const file = path.resolve(requested);
    if (snapshotDepth === 0) refresh();
    const privatePath = protectedRoots.some(root => within(root, file)) || within(dataDir, file) && !within(projectsDir, file);
    const info = readMetadata(file), previous = info?.isFile() && info.ino !== 0n ? identities.get(`${info.dev}:${info.ino}`) : undefined;
    const current = info?.isFile() ? generation(info) : undefined;
    const samePrivateFile = previous !== undefined && (previous === 0n || current === 0n || previous === current);
    if (privatePath || samePrivateFile) {
      throw new AppError('PROJECT_LOCATION_INVALID', '不能把应用私有文件作为项目打开。', 400);
    }
  };
  guard.withSnapshot = <T>(inspect: () => T): T => {
    if (typeof inspect !== 'function' || isAsyncFunction(inspect)) throw new TypeError('Application file snapshots require a synchronous callback');
    if (snapshotDepth === 0) refresh();
    snapshotDepth++;
    try {
      const result = inspect();
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as {then?: unknown}).then === 'function') {
        // Observe rejection without allowing the snapshot to outlive this call.
        Promise.resolve(result).catch(() => {});
        throw new TypeError('Application file snapshots require a synchronous callback');
      }
      return result;
    } finally {snapshotDepth--;}
  };
  return guard;
}
