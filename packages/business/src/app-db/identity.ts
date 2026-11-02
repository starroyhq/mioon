import {lstatSync} from 'node:fs';
import type {BigIntStats, Dirent} from 'node:fs';
import {lstat, opendir} from 'node:fs/promises';
import nodePath from 'node:path';
import {PROJECT_EXPORTS_FOLDER, PROJECT_FILE_EXTENSION, PROJECT_GENERATED_FOLDER} from '../../../contracts/src/project-file.ts';
import type {ProjectFileIdentity} from '../../../contracts/src/project-registry.ts';

// Project file identity (PROJECT-FILE.md, "项目文件身份"): it finds moved
// projects and spots copies, and is never a security check. Project files are
// only ever lstat'ed here, never opened: this process may have the project
// open, and closing any other descriptor of the file would drop SQLite's POSIX
// locks on it.

/** The fields of a bigint lstat that make a file identity. */
export interface IdentityStats {
  readonly dev: bigint;
  readonly ino: bigint;
  isFile(): boolean;
}

/** Device and file ID as decimal strings, so 64-bit IDs (and 128-bit ones
 * later) survive; null for anything but a regular file. On Windows Node's
 * bigint lstat gives the volume serial number and the 64-bit file index. */
export function identityOfStats(info: IdentityStats | undefined): ProjectFileIdentity | null {
  return info?.isFile() ? {dev: info.dev.toString(10), ino: info.ino.toString(10)} : null;
}

const errorCode = (error: unknown): unknown => (error as {code?: unknown} | null | undefined)?.code;

/** `ProjectFileIdentityPort`: lstat only. Null when nothing is at the path,
 * a parent is not a directory, or the path is not a regular file (a symbolic
 * link included); other errors are thrown. */
export function projectFileIdentity(projectFile: string): ProjectFileIdentity | null {
  if (typeof projectFile !== 'string' || projectFile === '' || projectFile.includes('\u0000')) throw new TypeError('Invalid project file path');
  let info: BigIntStats | undefined;
  try {
    info = lstatSync(projectFile, {bigint: true, throwIfNoEntry: false});
  } catch (error) {
    if (errorCode(error) === 'ENOTDIR' || errorCode(error) === 'ENOENT') return null;
    throw error;
  }
  return identityOfStats(info);
}

/** Same device and file ID. A file ID of 0, which some file systems report
 * when they have none, never matches anything. */
export function sameProjectFileIdentity(a: ProjectFileIdentity | null | undefined, b: ProjectFileIdentity | null | undefined): boolean {
  return Boolean(a && b && a.ino !== '0' && b.ino !== '0' && a.dev === b.dev && a.ino === b.ino);
}

// ---------------------------------------------------------------------------
// Finding a moved project file (plan 8.2)

/** Levels of folders read below each search root: the root itself, its
 * subfolders and theirs, so a project folder moved into a sibling folder such
 * as an archive is found from the old parent. */
export const DEFAULT_FIND_MOVED_DEPTH = 2;
/** Directory entries a search looks at in total before giving up. */
export const DEFAULT_FIND_MOVED_LIMIT = 5_000;
/** Folders a project keeps its own output in; they hold no project files. */
const SKIPPED_FOLDERS: ReadonlySet<string> = new Set([PROJECT_GENERATED_FOLDER, PROJECT_EXPORTS_FOLDER]);
const PROJECT_JOURNAL_SUFFIX = `${PROJECT_FILE_EXTENSION}-journal`;

/** Entries every production listing of a project directory skips: names
 * starting with `.` (`.DS_Store`, the test layout's `.mioon-store`) and the
 * `-journal` SQLite keeps beside an open project file. Case is ignored, as
 * the default macOS and Windows file systems do. */
export const isSkippedEntry = (name: string): boolean => name.startsWith('.') || name.toLowerCase().endsWith(PROJECT_JOURNAL_SUFFIX);
export const isProjectFileName = (name: string): boolean => !isSkippedEntry(name) && name.toLowerCase().endsWith(PROJECT_FILE_EXTENSION);

export interface DirectoryEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'other';
}
/** What the search reads: directory listings and lstat'ed identities. */
export interface FindMovedFileSystem {
  /** At most `limit` entries of a directory, or null when it cannot be read. */
  readDirectory(directory: string, limit: number): Promise<readonly DirectoryEntry[] | null>;
  identity(file: string): Promise<ProjectFileIdentity | null>;
}
/** The path functions the search uses; `path.win32` in tests of Windows paths. */
export type FindMovedPath = Pick<typeof nodePath, 'dirname' | 'join' | 'normalize'>;

export interface FindMovedOptions {
  /** Searched after the old project folder and its parent, for example the
   * default projects directory. */
  readonly roots?: readonly string[];
  readonly depth?: number;
  readonly limit?: number;
  readonly fileSystem?: FindMovedFileSystem;
  readonly path?: FindMovedPath;
}

async function kindOf(directory: string, entry: Dirent): Promise<DirectoryEntry['kind']> {
  if (entry.isFile()) return 'file';
  if (entry.isDirectory()) return 'directory';
  if (entry.isSymbolicLink() || entry.isFIFO() || entry.isSocket() || entry.isBlockDevice() || entry.isCharacterDevice()) return 'other';
  // The file system reported no type; lstat never follows a link.
  try {
    const info = await lstat(nodePath.join(directory, entry.name));
    return info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other';
  } catch {
    return 'other';
  }
}

/** opendir and lstat only; unreadable directories count as empty. */
export const NODE_FIND_MOVED_FILE_SYSTEM: FindMovedFileSystem = Object.freeze({
  async readDirectory(directory: string, limit: number): Promise<readonly DirectoryEntry[] | null> {
    const entries: DirectoryEntry[] = [];
    try {
      const listing = await opendir(directory);
      // Leaving the loop early closes the directory.
      for await (const entry of listing) {
        entries.push({name: entry.name, kind: await kindOf(directory, entry)});
        if (entries.length >= limit) break;
      }
    } catch {
      return null;
    }
    return entries;
  },
  async identity(file: string): Promise<ProjectFileIdentity | null> {
    try {
      return identityOfStats(await lstat(file, {bigint: true}));
    } catch {
      return null;
    }
  },
});

/** Where a search looks, in order: the old project folder (the `.mioon`
 * renamed in place), its parent (the folder renamed or moved next to it), then
 * `roots`. Duplicates, such as the parent of a drive root, are dropped. */
export function findMovedSearchRoots(projectFile: string, roots: readonly string[] = [], path: FindMovedPath = nodePath): string[] {
  const folder = path.dirname(projectFile);
  return [...new Set([folder, path.dirname(folder), ...roots.map(root => path.normalize(root))])];
}

const byName = (a: DirectoryEntry, b: DirectoryEntry): number => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** `findMoved` of the registry: a `.mioon` with the given file identity in the
 * search roots, breadth first, each directory in name order so the result does
 * not depend on the order the file system lists entries in. Only directory
 * listings and lstat; entries starting with `.`, `*.mioon-journal`, symbolic
 * links and the project folders `生成` and `导出` are skipped. Null when
 * nothing matches within `limit` entries, or the identity has no file ID. */
export async function findMovedProjectFile(
  entry: {readonly projectFile: string; readonly fileIdentity: ProjectFileIdentity},
  {roots = [], depth = DEFAULT_FIND_MOVED_DEPTH, limit = DEFAULT_FIND_MOVED_LIMIT, fileSystem = NODE_FIND_MOVED_FILE_SYSTEM, path = nodePath}: FindMovedOptions = {},
): Promise<string | null> {
  const target = entry.fileIdentity;
  if (!sameProjectFileIdentity(target, target)) return null;
  let remaining = limit;
  const visited = new Set<string>();
  for (const root of findMovedSearchRoots(entry.projectFile, roots, path)) {
    let level = [root];
    for (let reached = 0; reached <= depth && level.length > 0; reached++) {
      const next: string[] = [];
      for (const directory of level) {
        if (visited.has(directory)) continue;
        visited.add(directory);
        const entries = await fileSystem.readDirectory(directory, remaining + 1);
        if (entries === null) continue;
        if (entries.length > remaining) return null;
        remaining -= entries.length;
        for (const child of [...entries].sort(byName)) {
          if (isSkippedEntry(child.name)) continue;
          const candidate = path.join(directory, child.name);
          if (child.kind === 'directory') {
            if (!SKIPPED_FOLDERS.has(child.name)) next.push(candidate);
          } else if (child.kind === 'file' && isProjectFileName(child.name)) {
            if (sameProjectFileIdentity(await fileSystem.identity(candidate), target)) return candidate;
          }
        }
      }
      level = next;
    }
  }
  return null;
}
