import {lstatSync, readdirSync} from 'node:fs';
import path from 'node:path';
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

/** Remember identities as private files appear, including files subsequently
 * renamed outside the app directory. Metadata only: never open/close a live DB.
 * The default projects subtree is deliberately exempt. */
export function createApplicationFileGuard(directories: AppDirectories, {metadata: readMetadata = metadata}: ApplicationFileGuardOptions = {}): (file: string) => void {
  // A deleted private inode may be reused for a newly created project on ext4.
  // Birth time survives rename/hard links, unlike ctime, and distinguishes that
  // new generation when both observations provide it. Unknown time stays
  // conservative; it cannot erase a private file's retained identity.
  const identities = new Map<string, bigint>();
  const {dataDir, projectsDir, cacheDir, tempDir} = directories;
  const protectedRoots = [path.join(dataDir, 'records'), cacheDir, tempDir];
  const refresh = (): void => {
    let count = 0;
    const visit = (file: string, depth: number): void => {
      if (within(projectsDir, file) || depth > 32) return;
      if (++count > 100_000) throw new AppError('PROJECT_LOCATION_INVALID', '应用私有目录过大，无法验证项目位置。', 400);
      const info = readMetadata(file);
      if (!info || info.isSymbolicLink()) return;
      if (info.isFile()) {
        if (info.ino !== 0n) identities.set(`${info.dev}:${info.ino}`, generation(info));
      } else if (info.isDirectory()) for (const name of readdirSync(file)) visit(path.join(file, name), depth + 1);
    };
    visit(dataDir, 0);
    for (const root of protectedRoots) if (!within(dataDir, root)) visit(root, 0);
  };
  refresh();
  return (requested: string): void => {
    const file = path.resolve(requested);
    refresh();
    const privatePath = protectedRoots.some(root => within(root, file)) || within(dataDir, file) && !within(projectsDir, file);
    const info = readMetadata(file), previous = info?.isFile() && info.ino !== 0n ? identities.get(`${info.dev}:${info.ino}`) : undefined;
    const current = info?.isFile() ? generation(info) : undefined;
    const samePrivateFile = previous !== undefined && (previous === 0n || current === 0n || previous === current);
    if (privatePath || samePrivateFile) {
      throw new AppError('PROJECT_LOCATION_INVALID', '不能把应用私有文件作为项目打开。', 400);
    }
  };
}
