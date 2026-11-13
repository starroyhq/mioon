import {createHash, randomUUID} from 'node:crypto';
import {constants, copyFileSync, lstatSync, mkdirSync, renameSync, rmdirSync, rmSync, unlinkSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import path from 'node:path';
import {readPrivateFile, removePrivateFile, validateManagedFile, validatePrivateDirectory, writePrivateFileAtomic} from '@mioon/contracts/private-storage';
import {AppError} from '../../../contracts/src/app-error.ts';
import {isProjectId, PROJECT_CACHE_FILE, PROJECT_HISTORY_FILE} from '../../../contracts/src/project-file.ts';
import type {ContentStamp} from '../../../contracts/src/project-file.ts';
import {isAppLibraryHeld} from '../app-db/connection.ts';
import {syncCopiedDirectory, syncCopiedFile, validateProjectCopyStagingDirectory} from './backup.ts';
import {clearLockedFormat4RestoreCache, inspectLockedFormat4RestoreSource, withFormat4RestoreLocks} from './connection.ts';
import type {Format4RestoreLockInput, ProjectLocation} from './connection.ts';
import {isContentToken, sameContentStamp} from './content-stamp.ts';
import {projectFileError} from './errors.ts';
import {copyFormat4File, FORMAT4_RESTORE_ACTIVE, FORMAT_UPGRADE_BACKUP_DIRECTORY, readFormat4BackupManifest, verifyFormat4Backup, verifyFormat4BackupFile} from './format4-backup.ts';
import type {Format4BackupManifest} from './format4-backup.ts';
import {isProjectFileHeld} from './held-files.ts';
import {isHotJournal} from './journals.ts';
import {FORMAT4_PROJECT_SCHEMA_VERSION, PROJECT_FILE_SCHEMA_VERSION} from './schema/databases.ts';
import type {DatabaseKind} from './schema/databases.ts';

export type Format4RestoreBoundary = 'ready' | 'history-published' | 'project-published';
export interface RestoreFormat4BackupOptions {
  readonly projectFile: string;
  readonly location: ProjectLocation;
  readonly projectId: string;
  readonly backupId: string;
  /** Content identity the trusted caller confirmed at the current path. */
  readonly expected: ContentStamp;
  readonly onBoundary?: (phase: Format4RestoreBoundary) => void;
}

type FileGeneration = readonly string[];
interface Intent {
  readonly version: 1;
  readonly request: string;
  readonly attempt: string;
  readonly backupDigest: string;
  readonly projectBefore: FileGeneration;
  readonly historyBefore: FileGeneration | null;
  readonly projectAfter: FileGeneration;
  readonly historyAfter: FileGeneration | null;
  readonly previousProject: FileGeneration;
  readonly previousHistory: FileGeneration | null;
}
interface Result {
  readonly projectId: string;
  readonly backupId: string;
  readonly projectVersion: typeof PROJECT_FILE_SCHEMA_VERSION;
  readonly historyVersion: number | null;
}

const failure = () => new AppError('PROJECT_FORMAT_RESTORE_CONFLICT', '项目或配对恢复记录已变化，已保留现有文件。', 409);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
const fileGeneration = (value: unknown): value is FileGeneration =>
  Array.isArray(value) && value.length === 5 && value.every(part => typeof part === 'string' && /^-?\d+$/u.test(part));
function parseIntent(value: unknown): Intent {
  if (!object(value) || Object.keys(value).length !== 10 || value.version !== 1 || !digest(value.request) || !isProjectId(value.attempt) ||
    !digest(value.backupDigest) || !fileGeneration(value.projectBefore) || !fileGeneration(value.projectAfter) ||
    value.historyBefore !== null && !fileGeneration(value.historyBefore) || value.historyAfter !== null && !fileGeneration(value.historyAfter) ||
    !fileGeneration(value.previousProject) || value.previousHistory !== null && !fileGeneration(value.previousHistory) ||
    (value.historyBefore === null) !== (value.previousHistory === null)) throw failure();
  return {version: 1, request: value.request, attempt: value.attempt, backupDigest: value.backupDigest,
    projectBefore: value.projectBefore, historyBefore: value.historyBefore, projectAfter: value.projectAfter, historyAfter: value.historyAfter,
    previousProject: value.previousProject, previousHistory: value.previousHistory};
}
function parseReceipt(value: unknown): Result {
  if (!object(value) || Object.keys(value).length !== 4 || !isProjectId(value.projectId) || !isProjectId(value.backupId) ||
    value.projectVersion !== PROJECT_FILE_SCHEMA_VERSION ||
    value.historyVersion !== null && (typeof value.historyVersion !== 'number' || !Number.isSafeInteger(value.historyVersion) || value.historyVersion < 1)) throw failure();
  return {projectId: value.projectId, backupId: value.backupId, projectVersion: value.projectVersion, historyVersion: value.historyVersion};
}
const generation = (info: BigIntStats): FileGeneration =>
  [String(info.dev), String(info.ino), String(info.birthtimeNs), String(info.size), String(info.mtimeNs)];
const sameFile = (info: BigIntStats | undefined, expected: FileGeneration | null): boolean =>
  info === undefined ? expected === null : info.isFile() && info.nlink === 1n && expected !== null &&
    generation(info).every((part, index) => part === expected[index]);

function metadata(file: string, database: DatabaseKind): BigIntStats | undefined {
  const info = lstatSync(file, {bigint: true, throwIfNoEntry: false});
  if (info) {
    const identity = {dev: String(info.dev), ino: String(info.ino)};
    if (isProjectFileHeld(identity) || isAppLibraryHeld(identity)) {
      throw projectFileError('PROJECT_LOCKED', {database, reason: 'locked'});
    }
    if (!info.isFile() || info.ino === 0n || info.nlink !== 1n) throw failure();
  }
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const sidecar = lstatSync(file + suffix, {bigint: true, throwIfNoEntry: false});
    if (!sidecar) continue;
    const id = {dev: String(sidecar.dev), ino: String(sidecar.ino)};
    if (!info || !sidecar.isFile() || sidecar.nlink !== 1n || isProjectFileHeld(id) || isAppLibraryHeld(id) ||
      suffix !== '-journal' || isHotJournal(file + suffix)) throw failure();
  }
  return info;
}

function readState<T>(file: string, parse: (value: unknown) => T): T | null {
  const info = lstatSync(file, {bigint: true, throwIfNoEntry: false});
  if (!info) return null;
  const id = {dev: String(info.dev), ino: String(info.ino)};
  if (isProjectFileHeld(id) || isAppLibraryHeld(id)) throw failure();
  try { return parse(JSON.parse(String(readPrivateFile(file, {encoding: 'utf8'})))); }
  catch { throw failure(); }
}

function requireFile(file: string, database: DatabaseKind): BigIntStats {
  const result = metadata(file, database);
  if (!result) throw failure();
  return result;
}

function stagePaths(projectFile: string, localDir: string, attempt: string) {
  const projectStage = path.join(path.dirname(projectFile), `.format4-restore-${attempt}`);
  const recordsStage = path.join(localDir, `format4-restore-${attempt}`);
  return {projectStage, recordsStage, project: path.join(projectStage, 'project.mioon'),
    history: path.join(recordsStage, 'restore-history.db'),
    previousProject: path.join(recordsStage, 'previous-project.mioon'), previousHistory: path.join(recordsStage, 'previous-history.db')};
}

function checkCurrent(file: string, expected: FileGeneration | null): void {
  if (!sameFile(lstatSync(file, {bigint: true, throwIfNoEntry: false}), expected)) throw failure();
}

function clearColdJournal(file: string): void {
  for (const suffix of ['-wal', '-shm']) if (lstatSync(file + suffix, {throwIfNoEntry: false})) throw failure();
  const journal = file + '-journal';
  const info = lstatSync(journal, {bigint: true, throwIfNoEntry: false});
  if (!info) return;
  const id = {dev: String(info.dev), ino: String(info.ino)};
  if (!info.isFile() || info.nlink !== 1n || isProjectFileHeld(id) || isAppLibraryHeld(id) || isHotJournal(journal)) throw failure();
  unlinkSync(journal);
}

function stageBackupFile(source: string, target: string, manifest: Format4BackupManifest, index: number): BigIntStats {
  const entry = manifest.files[index]!;
  const before = requireFile(source, index === 0 ? 'project' : 'history');
  validateManagedFile(source, {private: true});
  copyFileSync(source, target, constants.COPYFILE_EXCL);
  checkCurrent(source, generation(before));
  verifyFormat4BackupFile(target, manifest, entry);
  syncCopiedFile(target);
  return requireFile(target, index === 0 ? 'project' : 'history');
}

/** Trusted, synchronous kernel entry. The caller closes the host first and
 * owns the registered path. Both rename stages live on their destination
 * volumes. The old project name stays present throughout publication. */
export function restoreFormat4Backup(options: RestoreFormat4BackupOptions): Result {
  // The publication protocol requires rename while holding native SQLite
  // handles. Windows does not admit a moved open project file.
  if (process.platform === 'win32') throw new AppError('PROJECT_FORMAT_RESTORE_UNSUPPORTED', '此平台暂不支持旧格式配对恢复。', 409);
  const {projectFile, location, projectId, backupId, expected, onBoundary} = options;
  if (!path.isAbsolute(projectFile) || path.resolve(projectFile) !== projectFile || !isProjectId(projectId) || !isProjectId(backupId) ||
    !Number.isSafeInteger(expected.contentSequence) || expected.contentSequence < 0 || !isContentToken(expected.contentToken)) {
    throw new TypeError('Restore requires a trusted path, IDs and confirmed content identity');
  }
  const {localDir, cacheDir} = location;
  validateProjectCopyStagingDirectory(path.dirname(projectFile));
  validatePrivateDirectory(localDir);
  validatePrivateDirectory(cacheDir, {allowMissing: true});
  const history = path.join(localDir, PROJECT_HISTORY_FILE), cache = path.join(cacheDir, PROJECT_CACHE_FILE);
  const marker = path.join(localDir, FORMAT4_RESTORE_ACTIVE);
  const request = hash([projectFile, projectId, backupId, expected.contentSequence, expected.contentToken]);
  const receiptFile = path.join(localDir, `format4-restore-receipt-${request}.json`);
  const completed = () => {
    const receipt = readState(receiptFile, parseReceipt);
    if (receipt && (receipt.projectId !== projectId || receipt.backupId !== backupId)) throw failure();
    return receipt;
  };
  const active = readState(marker, parseIntent);
  if (active && active.request !== request) throw failure();
  const existing = completed();
  if (existing) {
    // A kill between saving the receipt and removing the marker leaves no
    // publication to repeat. In particular, a replay never rolls back edits.
    if (active) {
      removePrivateFile(marker);
      syncCopiedDirectory(localDir);
    }
    return existing;
  }
  if (lstatSync(path.join(localDir, 'history-switch-active.json'), {throwIfNoEntry: false})) throw failure();
  const root = path.join(localDir, FORMAT_UPGRADE_BACKUP_DIRECTORY), backup = path.join(root, backupId);
  const manifest = readFormat4BackupManifest(root, backupId);
  if (manifest.projectId !== projectId || active && active.backupDigest !== hash(manifest)) throw failure();
  verifyFormat4Backup(backup, manifest);
  const projectInfo = requireFile(projectFile, 'project'), historyInfo = metadata(history, 'history'), cacheInfo = metadata(cache, 'cache');
  if (historyInfo) validateManagedFile(history, {root: localDir});
  if (cacheInfo) validateManagedFile(cache, {root: cacheDir});
  const stage = stagePaths(projectFile, localDir, active?.attempt ?? randomUUID());
  const inputs: Format4RestoreLockInput[] = [{file: projectFile, database: 'project', identity: projectInfo}];
  if (historyInfo) inputs.push({file: history, database: 'history', identity: historyInfo});
  if (cacheInfo) inputs.push({file: cache, database: 'cache', identity: cacheInfo});

  function publish(intent: Intent, projectDone: boolean, historyDone: boolean): Result {
    validatePrivateDirectory(stage.recordsStage);
    validateManagedFile(stage.previousProject, {private: true});
    if (intent.previousHistory) validateManagedFile(stage.previousHistory, {private: true});
    checkCurrent(stage.previousProject, intent.previousProject);
    checkCurrent(stage.previousHistory, intent.previousHistory);
    if (!historyDone) {
      checkCurrent(history, intent.historyBefore);
      checkCurrent(stage.history, intent.historyAfter);
      clearColdJournal(history);
      if (intent.historyAfter) renameSync(stage.history, history);
      else if (intent.historyBefore) unlinkSync(history);
      syncCopiedDirectory(stage.recordsStage);
      syncCopiedDirectory(localDir);
      onBoundary?.('history-published');
    }
    if (!projectDone) {
      checkCurrent(history, intent.historyAfter);
      checkCurrent(projectFile, intent.projectBefore);
      checkCurrent(stage.project, intent.projectAfter);
      clearColdJournal(projectFile);
      renameSync(stage.project, projectFile);
      syncCopiedDirectory(stage.projectStage);
      syncCopiedDirectory(path.dirname(projectFile));
      onBoundary?.('project-published');
    }
    checkCurrent(history, intent.historyAfter);
    checkCurrent(projectFile, intent.projectAfter);
    const result: Result = {projectId, backupId, projectVersion: PROJECT_FILE_SCHEMA_VERSION, historyVersion: manifest.historyVersion};
    writePrivateFileAtomic(receiptFile, JSON.stringify(result));
    syncCopiedDirectory(localDir);
    removePrivateFile(marker);
    syncCopiedDirectory(localDir);
    // The displaced pair remains under the private local records directory.
    try { rmdirSync(stage.projectStage); } catch { /* Keep unexpected contents. */ }
    return result;
  }

  if (active) {
    validateProjectCopyStagingDirectory(stage.projectStage);
    validatePrivateDirectory(stage.recordsStage);
    const projectDone = sameFile(projectInfo, active.projectAfter);
    const historyDone = sameFile(historyInfo, active.historyAfter);
    if ((!projectDone && !sameFile(projectInfo, active.projectBefore)) ||
      (!historyDone && !sameFile(historyInfo, active.historyBefore)) || (projectDone && !historyDone)) throw failure();
    const projectSource = projectDone ? projectFile : stage.project;
    if (!projectDone) checkCurrent(stage.project, active.projectAfter);
    verifyFormat4BackupFile(projectSource, manifest, manifest.files[0]!, projectDone);
    if (!projectDone) inputs.push({file: stage.project, database: 'project', identity: requireFile(stage.project, 'project')});
    if (active.historyAfter) {
      if (!historyDone) checkCurrent(stage.history, active.historyAfter);
      verifyFormat4BackupFile(historyDone ? history : stage.history, manifest, manifest.files[1]!);
      if (!historyDone) inputs.push({file: stage.history, database: 'history', identity: requireFile(stage.history, 'history')});
    }
    return withFormat4RestoreLocks(inputs, files => {
      if (completed() || hash(readState(marker, parseIntent)) !== hash(active)) throw failure();
      if (cacheInfo) clearLockedFormat4RestoreCache(files.get(cache)!.db);
      return publish(active, projectDone, historyDone);
    });
  }

  return withFormat4RestoreLocks(inputs, files => {
    if (readState(marker, parseIntent) || completed()) throw failure();
    const current = inspectLockedFormat4RestoreSource(files.get(projectFile)!.db, 'project', projectId)!;
    if (!sameContentStamp(current, expected)) throw failure();
    if (historyInfo) inspectLockedFormat4RestoreSource(files.get(history)!.db, 'history', projectId);
    if (current.formatVersion !== FORMAT4_PROJECT_SCHEMA_VERSION &&
      (!historyInfo || !sameContentStamp(current, manifest))) throw failure();
    checkCurrent(history, historyInfo ? generation(historyInfo) : null);
    const attempt = path.basename(stage.recordsStage).slice('format4-restore-'.length);
    let projectCreated = false, recordsCreated = false, ready = false;
    try {
      mkdirSync(stage.projectStage, {mode: 0o700}); projectCreated = true;
      mkdirSync(stage.recordsStage, {mode: 0o700}); recordsCreated = true;
      const newProject = stageBackupFile(path.join(backup, 'project.mioon'), stage.project, manifest, 0);
      const newHistory = manifest.historyPresent
        ? stageBackupFile(path.join(backup, PROJECT_HISTORY_FILE), stage.history, manifest, 1) : undefined;
      copyFormat4File(files.get(projectFile)!.fd, stage.previousProject, 'project.mioon');
      if (historyInfo) copyFormat4File(files.get(history)!.fd, stage.previousHistory, 'history.db');
      syncCopiedDirectory(stage.projectStage); syncCopiedDirectory(path.dirname(projectFile));
      syncCopiedDirectory(stage.recordsStage); syncCopiedDirectory(localDir);
      const intent: Intent = {version: 1, request, attempt, backupDigest: hash(manifest),
        projectBefore: generation(projectInfo), historyBefore: historyInfo ? generation(historyInfo) : null,
        projectAfter: generation(newProject), historyAfter: newHistory ? generation(newHistory) : null,
        previousProject: generation(requireFile(stage.previousProject, 'project')),
        previousHistory: historyInfo ? generation(requireFile(stage.previousHistory, 'history')) : null};
      const staged: Format4RestoreLockInput[] = [{file: stage.project, database: 'project', identity: newProject}];
      if (newHistory) staged.push({file: stage.history, database: 'history', identity: newHistory});
      return withFormat4RestoreLocks(staged, () => {
        writePrivateFileAtomic(marker, JSON.stringify(intent));
        ready = true;
        syncCopiedDirectory(localDir);
        if (cacheInfo) clearLockedFormat4RestoreCache(files.get(cache)!.db);
        onBoundary?.('ready');
        return publish(intent, false, sameFile(historyInfo, intent.historyAfter));
      });
    } finally {
      if (!ready && !lstatSync(marker, {throwIfNoEntry: false})) {
        if (projectCreated) rmSync(stage.projectStage, {force: true, recursive: true});
        if (recordsCreated) rmSync(stage.recordsStage, {force: true, recursive: true});
      }
    }
  });
}
