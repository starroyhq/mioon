import {randomUUID} from 'node:crypto';
import {AppError} from '../../../contracts/src/app-error.ts';
import {lstatSync, readdirSync, renameSync} from 'node:fs';
import type {Dirent} from 'node:fs';
import {lstat, readdir, rm} from 'node:fs/promises';
import path from 'node:path';
import {validatePrivateDirectory} from '@mioon/contracts/private-storage';
import {isProjectId, PROJECT_RECORDS_DIRECTORY} from '../../../contracts/src/project-file.ts';
import {localRecordsEntrySchema} from '../../../contracts/src/project-registry.ts';
import type {LocalRecordsEntry, ProjectFileIdentity, RecentProject} from '../../../contracts/src/project-registry.ts';
import {isSuperJournalInUse, superJournalsIn} from '../project-file/index.ts';
import {FORMAT4_RESTORE_ACTIVE} from '../project-file/format4-backup.ts';
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
  readonly hasUnfinishedTasks: boolean;
  /** Physical automatic copies, including unindexed ones, that deletion will
   * remove. File metadata only; this does not claim a backup is restorable. */
  readonly automaticBackups: {readonly count: number; readonly sizeBytes: number};
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
   * use. The host's synchronous open/work observers are checked again in the
   * final, non-awaiting section before rename (including opening hosts). */
  delete(projectId: string): Promise<void>;
}

export interface LocalRecordsOptions {
  readonly dataDir: string;
  readonly registry: AppProjectRegistry;
  readonly identity: (projectFile: string) => ProjectFileIdentity | null;
  /** Whether this process has the project open (the project host). */
  readonly isProjectOpen: (projectId: string) => boolean;
  /** Durable index plus live requests; must be rechecked before rename. */
  readonly isProjectBackgroundBusy: (projectId: string) => boolean;
  /** A real live application owner, checked before every removal effect. */
  readonly assertMutationAllowed: () => void;
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
async function folderMetadata(folder: string, projectId: string, depth = 0, relative: readonly string[] = []): Promise<{sizeBytes: number; automaticBackups: {count: number; sizeBytes: number}}> {
  const result = {sizeBytes: 0, automaticBackups: {count: 0, sizeBytes: 0}};
  const scanFailed = (): never => {throw new AppError('LOCAL_RECORDS_SCAN_FAILED', '本机记录的自动备份暂时无法统计，请重新读取后确认。', 503, {projectId});};
  let entries: Dirent[];
  try {
    entries = await readdir(folder, {withFileTypes: true});
  } catch (error) {
    if (relative[0] === 'backups' && (error as {code?: unknown}).code !== 'ENOENT') scanFailed();
    return result;
  }
  for (const entry of entries) {
    const full = path.join(folder, entry.name), parts = [...relative, entry.name];
    if (entry.isDirectory()) {
      if (depth < MAX_SIZE_DEPTH) {
        const child = await folderMetadata(full, projectId, depth + 1, parts);
        result.sizeBytes += child.sizeBytes;
        result.automaticBackups.count += child.automaticBackups.count;
        result.automaticBackups.sizeBytes += child.automaticBackups.sizeBytes;
      }
    } else if (!entry.isSymbolicLink()) {
      try {
        const info = await lstat(full);
        if (info.isFile()) {
          result.sizeBytes += info.size;
          if (parts.length === 3 && parts[0] === 'backups' && isProjectId(parts[1]) && parts[2] === 'project.mioon') {
            if (!Number.isSafeInteger(info.size) || info.size < 0) scanFailed();
            result.automaticBackups.count++;
            result.automaticBackups.sizeBytes += info.size;
            if (!Number.isSafeInteger(result.automaticBackups.sizeBytes)) scanFailed();
          }
        }
      } catch (error) {
        if (parts[0] === 'backups' && (error as {code?: unknown}).code !== 'ENOENT') scanFailed();
        // Gone meanwhile.
      }
    }
  }
  return result;
}

export function createLocalRecords({dataDir, registry, identity, isProjectOpen, isProjectBackgroundBusy, assertMutationAllowed}: LocalRecordsOptions): LocalRecordsStore {
  if (typeof assertMutationAllowed !== 'function') throw new TypeError('Local records require a live application owner guard');
  const recordsDir = path.join(dataDir, PROJECT_RECORDS_DIRECTORY);
  const removing = new Set<string>();
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
  const sweepTombstones = async (): Promise<void> => {
    assertMutationAllowed();
    let names: string[];
    try {
      names = readdirSync(recordsDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (TOMBSTONE.test(name) && !removing.has(path.join(recordsDir, name))) {
        // Keep this outside the best-effort rm catch: a retired application
        // owner must stop the whole operation, never continue its sweep.
        assertMutationAllowed();
        try { await rm(path.join(recordsDir, name), {recursive: true, force: true}); } catch {}
        assertMutationAllowed();
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
      await sweepTombstones();
      let entries: Dirent[];
      try {
        entries = await readdir(recordsDir, {withFileTypes: true});
      } catch (error) {
        if ((error as {code?: unknown}).code === 'ENOENT') {assertMutationAllowed(); return [];}
        throw error;
      }
      const items: LocalRecordsItem[] = [];
      for (const projectId of entries.filter(entry => entry.isDirectory() && isProjectId(entry.name)).map(entry => entry.name).sort()) {
        if (await projectFound(projectId)) continue;
        assertMutationAllowed();
        const folder = path.join(recordsDir, projectId);
        const metadata = await folderMetadata(folder, projectId);
        const entry = localRecordsEntrySchema.parse({projectId, sizeBytes: metadata.sizeBytes, hasSuperJournal: hasSuperJournalInUse(folder)});
        const registered = registry.get(projectId);
        items.push({...entry, name: registered?.name ?? null, projectFile: registered?.projectFile ?? null,
          hasUnfinishedTasks: isProjectBackgroundBusy(projectId), automaticBackups: metadata.automaticBackups});
      }
      assertMutationAllowed();
      return items;
    },
    async delete(projectId: string): Promise<void> {
      if (!isProjectId(projectId)) throw new TypeError('Invalid project ID');
      await sweepTombstones();
      if (folderOf(projectId) === null) throw appLibraryError('LOCAL_RECORDS_NOT_FOUND', {projectId});
      if (await projectFound(projectId)) throw appLibraryError('LOCAL_RECORDS_IN_USE', {projectId});
      if (isProjectBackgroundBusy(projectId)) throw appLibraryError('LOCAL_RECORDS_IN_USE', {projectId});
      // Checked again without awaiting from here to the rename.
      const folder = folderOf(projectId);
      if (folder === null) throw appLibraryError('LOCAL_RECORDS_NOT_FOUND', {projectId});
      const entry = registry.get(projectId);
      if (isProjectOpen(projectId) || (entry !== null && atRegisteredPlace(entry)) || isProjectBackgroundBusy(projectId)) throw appLibraryError('LOCAL_RECORDS_IN_USE', {projectId});
      if (lstatSync(path.join(folder, FORMAT4_RESTORE_ACTIVE), {throwIfNoEntry: false})) throw appLibraryError('LOCAL_RECORDS_IN_USE', {projectId});
      if (hasSuperJournalInUse(folder)) throw appLibraryError('LOCAL_RECORDS_SUPER_JOURNAL', {projectId});
      validatePrivateDirectory(folder);
      // Renamed first, so a removal that stops halfway never leaves a records
      // folder the kernel would open again; list() and delete() sweep the rest.
      const tombstone = path.join(recordsDir, `.deleting-${projectId}-${randomUUID()}`);
      assertMutationAllowed();
      renameSync(folder, tombstone);
      assertMutationAllowed();
      // Keep the namespace transition synchronous, but not potentially GBs of
      // recursive I/O. A concurrent list must not take over this active removal
      // with a concurrent crash-recovery sweep.
      removing.add(tombstone);
      try {await rm(tombstone, {recursive: true, force: true});}
      finally {removing.delete(tombstone);}
    },
  };
}
