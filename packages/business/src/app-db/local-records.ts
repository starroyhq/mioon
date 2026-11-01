import {randomUUID} from 'node:crypto';
import {lstatSync, readdirSync, renameSync, rmSync} from 'node:fs';
import type {Dirent} from 'node:fs';
import {lstat, readdir} from 'node:fs/promises';
import path from 'node:path';
import {validatePrivateDirectory} from '@mioon/contracts/private-storage';
import {isProjectId, PROJECT_RECORDS_DIRECTORY} from '../../../contracts/src/project-file.ts';
import {localRecordsEntrySchema} from '../../../contracts/src/project-registry.ts';
import type {LocalRecordsEntry, ProjectFileIdentity, RecentProject} from '../../../contracts/src/project-registry.ts';
import {isSuperJournalInUse, superJournalsIn} from '../project-file/index.ts';
import {appLibraryError} from './errors.ts';
import {sameProjectFileIdentity} from './identity.ts';
import {fileAtRegisteredPlace} from './registry.ts';
import type {AppProjectRegistry} from './registry.ts';

/** One local records folder whose project file can no longer be found. The
 * name and the last location come from the registry and are null for a
 * project it does not know; the design adds them to the contract later as
 * nullable fields. */
export interface LocalRecordsItem extends LocalRecordsEntry {
  readonly name: string | null;
  readonly projectFile: string | null;
}

/** The local records list (PROJECT-FILE.md, "本机记录的文件夹"). It never opens
 * history.db: sizes come from lstat, super-journals from the kernel's rules. */
export interface LocalRecordsStore {
  /** `<app data>/records/<project ID>/` folders whose project file is not at
   * its registered place, cannot be found by file identity, or is not
   * registered, and whose project is not open. By project ID. */
  list(): Promise<LocalRecordsItem[]>;
  /** Deletes such a folder after checking again that its project file cannot
   * be found, its project is not open, and it holds no super-journal still in
   * use. A registered project is deleted inside the host's exclusive operation
   * (S0's withExclusive), so it cannot be opened meanwhile. */
  delete(projectId: string): Promise<void>;
}

export interface LocalRecordsOptions {
  readonly dataDir: string;
  readonly registry: AppProjectRegistry;
  readonly identity: (projectFile: string) => ProjectFileIdentity | null;
  /** Whether this process has the project open (the project host). */
  readonly isProjectOpen: (projectId: string) => boolean;
}

/** Folders left by a delete that stopped between the rename and the removal. */
const TOMBSTONE = /^\.deleting-[0-9a-f-]{36}-[0-9a-f-]{36}$/u;
/** Nested folders counted at most (backups/ and imports/ are one level down). */
const MAX_SIZE_DEPTH = 16;

/** Whether a super-journal beside the local records may still be needed to roll
 * back an interrupted commit (the kernel's isSuperJournalInUse). One that
 * cannot be read counts as needed. Only meaningful while the project is not
 * open anywhere, which holds for records whose project file cannot be found. */
export function hasSuperJournalInUse(localDir: string): boolean {
  let superJournals: string[];
  try {
    superJournals = superJournalsIn(localDir);
  } catch {
    return true;
  }
  for (const superJournal of superJournals) {
    try {
      if (lstatSync(superJournal).isFile() && isSuperJournalInUse(superJournal)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** Bytes of the regular files in a folder and its subfolders, from lstat;
 * symbolic links are not followed or counted. */
async function folderSize(folder: string, depth = 0): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(folder, {withFileTypes: true});
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_SIZE_DEPTH) total += await folderSize(full, depth + 1);
    } else if (!entry.isSymbolicLink()) {
      try {
        const info = await lstat(full);
        if (info.isFile()) total += info.size;
      } catch {
        // Gone meanwhile.
      }
    }
  }
  return total;
}

export function createLocalRecords({dataDir, registry, identity, isProjectOpen}: LocalRecordsOptions): LocalRecordsStore {
  const recordsDir = path.join(dataDir, PROJECT_RECORDS_DIRECTORY);
  /** The registered file is still at its place (lstat only). */
  const atRegisteredPlace = (entry: RecentProject): boolean =>
    fileAtRegisteredPlace(entry, identity, found => registry.list().some(other =>
      other.projectId !== entry.projectId && other.projectFile === entry.projectFile && sameProjectFileIdentity(other.fileIdentity, found))) !== null;
  /** Whether the project file can still be found, or the project is open. */
  const projectFound = async (projectId: string): Promise<boolean> => {
    if (isProjectOpen(projectId)) return true;
    const entry = registry.get(projectId);
    if (!entry) return false;
    if (atRegisteredPlace(entry)) return true;
    return await registry.findMoved(entry) !== null;
  };
  const sweepTombstones = (): void => {
    let names: string[];
    try {
      names = readdirSync(recordsDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (TOMBSTONE.test(name)) {
        try { rmSync(path.join(recordsDir, name), {recursive: true, force: true}); } catch {}
      }
    }
  };
  const folderOf = (projectId: string): string | null => {
    const folder = path.join(recordsDir, projectId);
    const info = lstatSync(folder, {throwIfNoEntry: false});
    return info?.isDirectory() ? folder : null;
  };

  return {
    async list(): Promise<LocalRecordsItem[]> {
      sweepTombstones();
      let entries: Dirent[];
      try {
        entries = await readdir(recordsDir, {withFileTypes: true});
      } catch (error) {
        if ((error as {code?: unknown}).code === 'ENOENT') return [];
        throw error;
      }
      const items: LocalRecordsItem[] = [];
      for (const projectId of entries.filter(entry => entry.isDirectory() && isProjectId(entry.name)).map(entry => entry.name).sort()) {
        if (await projectFound(projectId)) continue;
        const folder = path.join(recordsDir, projectId);
        const entry = localRecordsEntrySchema.parse({projectId, sizeBytes: await folderSize(folder), hasSuperJournal: hasSuperJournalInUse(folder)});
        const registered = registry.get(projectId);
        items.push({...entry, name: registered?.name ?? null, projectFile: registered?.projectFile ?? null});
      }
      return items;
    },
    async delete(projectId: string): Promise<void> {
      if (!isProjectId(projectId)) throw new TypeError('Invalid project ID');
      sweepTombstones();
      if (folderOf(projectId) === null) throw appLibraryError('LOCAL_RECORDS_NOT_FOUND', {projectId});
      if (await projectFound(projectId)) throw appLibraryError('LOCAL_RECORDS_IN_USE', {projectId});
      // Checked again without awaiting from here to the rename.
      const folder = folderOf(projectId);
      if (folder === null) throw appLibraryError('LOCAL_RECORDS_NOT_FOUND', {projectId});
      const entry = registry.get(projectId);
      if (isProjectOpen(projectId) || (entry !== null && atRegisteredPlace(entry))) throw appLibraryError('LOCAL_RECORDS_IN_USE', {projectId});
      if (hasSuperJournalInUse(folder)) throw appLibraryError('LOCAL_RECORDS_SUPER_JOURNAL', {projectId});
      validatePrivateDirectory(folder);
      // Renamed first, so a removal that stops halfway never leaves a records
      // folder the kernel would open again; list() and delete() sweep the rest.
      const tombstone = path.join(recordsDir, `.deleting-${projectId}-${randomUUID()}`);
      renameSync(folder, tombstone);
      rmSync(tombstone, {recursive: true, force: true});
    },
  };
}
