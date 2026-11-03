import {randomUUID} from 'node:crypto';
import {closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, rmSync} from 'node:fs';
import path from 'node:path';
import {backup, DatabaseSync} from 'node:sqlite';
import {createPrivateTemporaryDirectory, ensurePrivateDirectory, validateManagedFile} from '@mioon/contracts/private-storage';
import {AppError} from '../../../contracts/src/app-error.ts';
import {isProjectId, PROJECT_DATABASE_NAMES} from '../../../contracts/src/project-file.ts';
import {isProjectFileHeld} from './held-files.ts';
import {isAppLibraryHeld} from '../app-db/connection.ts';
import {projectFileError} from './errors.ts';
import {PROJECT_FILE_APPLICATION_ID, PROJECT_FILE_SCHEMA_VERSION, SCHEMA_VERSION_TABLE_SQL} from './schema/databases.ts';
import {SCHEMA_MANIFEST} from './schema/manifest.ts';
import {compareManifest, readSchemaManifest} from './schema/manifest-check.ts';
import {isProjectStore} from './store.ts';
import type {ProjectStore} from './store.ts';

/** 'MioB': copied project content, deliberately not an openable project. */
export const PROJECT_BACKUP_APPLICATION_ID = 0x4d696f42;

export interface ProjectBackupIdentity {
  readonly projectId: string;
  readonly contentSequence: number;
  readonly formatVersion: number;
  readonly name: string | null;
  readonly sizeBytes: number;
}

export interface ProjectBackupReader {
  /** A native read-only connection, with no history, cache or runtime. */
  readonly db: DatabaseSync;
  readonly identity: ProjectBackupIdentity;
  close(): void;
}

const readers = new WeakSet<object>();
const options = {readOnly: true, timeout: 0, defensive: true, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false} as const;
const pragma = (db: DatabaseSync, name: string): unknown => Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0];
const invalid = (reason: string, cause?: unknown): AppError => {
  const error = new AppError('PROJECT_BACKUP_INVALID', '项目备份无效或格式不受支持', 422, {reason});
  if (cause !== undefined) error.cause = cause;
  return error;
};

/** Refuse held SQLite inodes before opening a descriptor: closing an fs
 * descriptor of a live project file would drop this process's POSIX locks. */
function checkHeader(file: string, applicationId: number): number {
  const info = lstatSync(file, {bigint: true});
  if (!info.isFile() || info.nlink !== 1n) throw invalid('not-a-regular-single-link-file');
  const identity = {dev: String(info.dev), ino: String(info.ino)};
  if (isProjectFileHeld(identity) || isAppLibraryHeld(identity)) throw invalid('held-database');
  // Backups live in a private record folder; a published portable project
  // can live in a normal 0755 user directory, just like connection.ts accepts.
  if (applicationId === PROJECT_BACKUP_APPLICATION_ID) validateManagedFile(file, {private: true});
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = fstatSync(fd, {bigint: true});
    if (!actual.isFile() || actual.dev !== info.dev || actual.ino !== info.ino) throw invalid('file-changed');
    const header = Buffer.alloc(100);
    if (readSync(fd, header, 0, header.length, 0) !== 100 || header.toString('latin1', 0, 16) !== 'SQLite format 3\u0000'
      || header.readUInt32BE(68) !== applicationId || header[18] !== 1 || header[19] !== 1) throw invalid('header');
    return Number(actual.size);
  } finally { closeSync(fd); }
}

/** Full current project profile; only the dedicated marker differs. */
export function readCopiedProjectIdentity(db: DatabaseSync, applicationId: number, sizeBytes: number): ProjectBackupIdentity {
  if (pragma(db, 'application_id') !== applicationId || pragma(db, 'encoding') !== 'UTF-8' || pragma(db, 'journal_mode') !== 'delete') throw invalid('profile');
  if (db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='schema_version'").get()?.sql !== SCHEMA_VERSION_TABLE_SQL) throw invalid('format');
  const versions = db.prepare('SELECT version FROM schema_version').all();
  if (versions.length !== 1 || versions[0].version !== PROJECT_FILE_SCHEMA_VERSION) throw invalid('format');
  const diff = compareManifest(readSchemaManifest(db, 'main'), SCHEMA_MANIFEST.project.entries);
  if (diff.changed.length || diff.missing.length || diff.unexpected.length) throw invalid('schema');
  const rows = db.prepare('SELECT singleton,projectId,contentSequence FROM project_file').all(), row = rows[0];
  if (rows.length !== 1 || row.singleton !== 1 || !isProjectId(row.projectId) || typeof row.contentSequence !== 'number'
    || !Number.isSafeInteger(row.contentSequence) || row.contentSequence < 0) throw invalid('metadata');
  const projects = db.prepare('SELECT id,data FROM projects LIMIT 2').all();
  if (projects.length > 1 || projects.length === 1 && projects[0].id !== row.projectId) throw invalid('project-row');
  if (pragma(db, 'quick_check') !== 'ok' || db.prepare('PRAGMA foreign_key_check').get() !== undefined) throw invalid('integrity');
  let name: string | null = null;
  if (projects.length) {
    try {
      const data: unknown = JSON.parse(String(projects[0].data));
      if (data !== null && typeof data === 'object' && 'name' in data && typeof data.name === 'string') name = data.name;
    } catch { throw invalid('project-data'); }
  }
  return Object.freeze({projectId: row.projectId, contentSequence: row.contentSequence, formatVersion: PROJECT_FILE_SCHEMA_VERSION, name, sizeBytes});
}

function openReadOnly(file: string, applicationId: number): ProjectBackupReader {
  let db: DatabaseSync | undefined;
  try {
    const size = checkHeader(file, applicationId);
    db = new DatabaseSync(file, options);
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA cell_size_check=ON');
    const identity = readCopiedProjectIdentity(db, applicationId, size), database = db;
    const reader: ProjectBackupReader = Object.freeze({db: database, identity, close: (): void => { if (database.isOpen) database.close(); }});
    readers.add(reader);
    return reader;
  } catch (error) {
    db?.close();
    if (error instanceof AppError) throw error;
    throw invalid('unreadable', error);
  }
}

export function openProjectBackup(file: string): ProjectBackupReader { return openReadOnly(path.resolve(file), PROJECT_BACKUP_APPLICATION_ID); }
export function isProjectBackupReader(value: unknown): value is ProjectBackupReader {
  return typeof value === 'object' && value !== null && readers.has(value) && (value as ProjectBackupReader).db.isOpen;
}
export function inspectProjectBackup(file: string): ProjectBackupIdentity {
  const reader = openProjectBackup(file);
  try { return reader.identity; } finally { reader.close(); }
}
/** For recovery of a trusted durable restore intent, never an open/register. */
export function inspectCopiedProjectFile(file: string): ProjectBackupIdentity {
  const reader = openReadOnly(path.resolve(file), PROJECT_FILE_APPLICATION_ID);
  try { return reader.identity; } finally { reader.close(); }
}

export function syncCopiedFile(file: string): void {
  const fd = openSync(file, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function syncCopiedDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** Hard-link publication is atomic and never replaces the destination. An
 * unsupported filesystem fails before publication; a non-atomic file-copy
 * fallback would leave a partial file masquerading as a complete restore. */
export function publishCopiedFile(temporary: string, destination: string, onPublished?: () => void): void {
  try { linkSync(temporary, destination); }
  catch (error) {
    const code = (error as {code?: unknown})?.code;
    if (code === 'EEXIST') throw projectFileError('PROJECT_FILE_EXISTS', {database: 'project', reason: 'exists'});
    throw error;
  }
  // Publication already happened even when the following durability sync
  // fails. Callers must retain all files needed by the published target.
  onPublished?.();
  syncCopiedDirectory(path.dirname(destination));
}

/** Native backup of the owner's attached project database. In particular this
 * never backs up `main` (history.db), nor opens the live source path again.
 * The destination is staged in a fresh private directory because SQLite's
 * backup API otherwise overwrites an existing destination. */
export async function createProjectBackup(store: ProjectStore, destination: string): Promise<ProjectBackupIdentity> {
  if (!isProjectStore(store)) throw new TypeError('Backup requires the exact live project store');
  if (store.db.isTransaction) throw new TypeError('Backup cannot start inside a transaction');
  const target = path.resolve(destination), parent = path.dirname(target);
  ensurePrivateDirectory(parent);
  if (lstatSync(target, {throwIfNoEntry: false})) throw projectFileError('PROJECT_FILE_EXISTS', {database: 'project', reason: 'exists'});
  const temporaryDir = createPrivateTemporaryDirectory(parent, 'copy-'), temporary = path.join(temporaryDir, `${randomUUID()}.sqlite`);
  try {
    closeSync(openSync(temporary, 'wx', 0o600));
    // Intentionally await native completion. There is no proven cancellation
    // contract; the lifecycle service reports slow progress instead.
    await backup(store.db, temporary, {source: PROJECT_DATABASE_NAMES.project});
    const db = new DatabaseSync(temporary, {...options, readOnly: false});
    let identity: ProjectBackupIdentity;
    try {
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL');
      db.exec(`PRAGMA application_id=${PROJECT_BACKUP_APPLICATION_ID}`);
      identity = readCopiedProjectIdentity(db, PROJECT_BACKUP_APPLICATION_ID, Number(lstatSync(temporary).size));
      if (identity.projectId !== store.projectId) throw invalid('project-mismatch');
    } finally { db.close(); }
    syncCopiedFile(temporary);
    publishCopiedFile(temporary, target);
    return identity;
  } finally { rmSync(temporaryDir, {recursive: true, force: true}); }
}
