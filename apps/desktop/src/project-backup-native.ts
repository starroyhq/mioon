import path from 'node:path';
import {lstatSync, realpathSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import type {ProjectBackupInspection, ProjectBackupRestoreResponse} from '../../../packages/contracts/src/project-backups.ts';
import type {ProjectEntryResponse} from '../../../packages/contracts/src/project-entry.ts';
import {inspectCopiedProjectFile} from '../../../packages/business/src/project-file/backup.ts';
import {isProjectFileHeld} from '../../../packages/business/src/project-file/held-files.ts';
import {isAppLibraryHeld} from '../../../packages/business/src/app-db/connection.ts';
import {backupNativeError,backupNativeFailureCode} from './project-backup-native-result.ts';

const unavailable = () => Object.assign(new Error('Native backup action is unavailable.'), {code: 'WORKSPACE_NATIVE_UNAVAILABLE'});
/** The backup date uses this computer's calendar, like the OS save panel. A
 * project name cannot insert a directory, even if imported content contains it. */
export function backupRestoreDefaultPath(backup: ProjectBackupInspection, format: (name: string | null, date: string) => string): string {
  const created = new Date(backup.createdAt), date = `${String(created.getMonth() + 1).padStart(2, '0')}-${String(created.getDate()).padStart(2, '0')}`;
  const name = format(backup.projectName, date).replace(/[\x00-\x1f\x7f/\\:*?"<>|]/gu, '_').replace(/[. ]+$/u, '').slice(0, 180);
  if (!name) throw unavailable();
  return path.join(backup.sourceProjectDir, `${name}.mioon`);
}
const same = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.birthtimeNs === b.birthtimeNs;
function verificationFailure(error: unknown): Error {
  const code = backupNativeFailureCode(error);
  // Keep owner loss and unknown I/O distinct from a provably missing/changed
  // target, and never forward the filesystem's message or path.
  if (code !== 'WORKSPACE_NATIVE_UNAVAILABLE') return backupNativeError(code);
  const actual = (error as {code?:unknown} | null)?.code;
  if(actual==='PROJECT_LOCKED')return backupNativeError('PROJECT_BACKUP_RESTORE_BUSY');
  return backupNativeError(typeof actual === 'string' && ['ENOENT','ENOTDIR','PROJECT_INVALID','PROJECT_FORMAT_NEWER','PROJECT_MISSING'].includes(actual)
    ? 'PROJECT_BACKUP_RESTORE_CHANGED' : 'WORKSPACE_NATIVE_UNAVAILABLE');
}
/** Read only the copied project format, never an ordinary host or local history.
 * A registered dev/ino locates the file; its contents and full generation prove
 * what the shell may reveal. The final synchronous fence follows the last RPC. */
export function verifyRestoredBackupFile(result: ProjectBackupRestoreResponse, entry: ProjectEntryResponse, check: () => void): () => void {
  try {
    check();
    const project = entry.entry.project, wanted = result.project, file = wanted.projectFile, directory = path.dirname(file);
    if (project.projectId !== wanted.projectId || project.projectFile !== file ||
        project.fileIdentity.dev !== wanted.fileIdentity.dev || project.fileIdentity.ino !== wanted.fileIdentity.ino ||
        !path.isAbsolute(file) || path.resolve(file) !== file || realpathSync(file) !== file || realpathSync(directory) !== directory) throw backupNativeError('PROJECT_BACKUP_RESTORE_CHANGED');
    if(['open','busy','locked'].includes(entry.entry.availability.state))throw backupNativeError('PROJECT_BACKUP_RESTORE_BUSY');
    if(entry.entry.availability.state!=='available')throw backupNativeError('PROJECT_BACKUP_RESTORE_CHANGED');
    const before = lstatSync(file, {bigint: true}), parent = lstatSync(directory, {bigint: true});
    const held = (info: BigIntStats): boolean => isProjectFileHeld({dev: String(info.dev), ino: String(info.ino)}) || isAppLibraryHeld({dev: String(info.dev), ino: String(info.ino)});
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || !parent.isDirectory() || parent.isSymbolicLink() ||
        String(before.dev) !== wanted.fileIdentity.dev || String(before.ino) !== wanted.fileIdentity.ino) throw backupNativeError('PROJECT_BACKUP_RESTORE_CHANGED');
    if(held(before))throw backupNativeError('PROJECT_BACKUP_RESTORE_BUSY');
    if (inspectCopiedProjectFile(file).projectId !== wanted.projectId) throw backupNativeError('PROJECT_BACKUP_RESTORE_CHANGED');
    const current = (): void => {
      try {
        check();
        const actual = lstatSync(file, {bigint: true}), actualParent = lstatSync(directory, {bigint: true});
        if (realpathSync(file) !== file || realpathSync(directory) !== directory || !actual.isFile() || actual.isSymbolicLink() || actual.nlink !== 1n ||
            !same(before, actual) || !actualParent.isDirectory() || actualParent.isSymbolicLink() || actualParent.dev !== parent.dev || actualParent.ino !== parent.ino || actualParent.birthtimeNs !== parent.birthtimeNs) throw backupNativeError('PROJECT_BACKUP_RESTORE_CHANGED');
        if(held(actual))throw backupNativeError('PROJECT_BACKUP_RESTORE_BUSY');
      } catch(error) {throw verificationFailure(error);}
    };
    current(); return current;
  } catch(error) {throw verificationFailure(error);}
}
