import {randomUUID} from 'node:crypto';
import {closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, renameSync, rmSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {ensurePrivateDirectory} from '@mioon/contracts/private-storage';
import {AppError} from '../../../contracts/src/app-error.ts';
import {isProjectId, PROJECT_CACHE_FILE, PROJECT_DATABASE_NAMES, PROJECT_FILE_EXISTS, PROJECT_HISTORY_FILE} from '../../../contracts/src/project-file.ts';
import type {ProjectHistoryState, ProjectStore as ProjectStoreContract} from '../../../contracts/src/project-file.ts';
import {installCrossFileTriggers} from './cross-file/install.ts';
import {isSqliteBusy, isSqliteCorrupt, projectFileError} from './errors.ts';
import type {ProjectFileErrorDetails, ProjectFileErrorReason} from './errors.ts';
import {
  buildDatabase, CACHE_APPLICATION_ID, CACHE_SCHEMA_VERSION, HISTORY_APPLICATION_ID, HISTORY_SCHEMA_VERSION,
  PROJECT_FILE_APPLICATION_ID, PROJECT_FILE_SCHEMA_VERSION, SCHEMA_VERSION_TABLE_SQL,
} from './schema/databases.ts';
import type {DatabaseKind} from './schema/databases.ts';
import {compareManifest, readSchemaManifest} from './schema/manifest-check.ts';
import {SCHEMA_MANIFEST} from './schema/manifest.ts';

const HISTORY = PROJECT_DATABASE_NAMES.history;
const PROJECT = PROJECT_DATABASE_NAMES.project;
const CACHE = PROJECT_DATABASE_NAMES.cache;

const SUPPORTED_VERSIONS: Readonly<Record<DatabaseKind, number>> = {
  project: PROJECT_FILE_SCHEMA_VERSION, history: HISTORY_SCHEMA_VERSION, cache: CACHE_SCHEMA_VERSION,
};
const APPLICATION_IDS: Readonly<Record<DatabaseKind, number>> = {
  project: PROJECT_FILE_APPLICATION_ID, history: HISTORY_APPLICATION_ID, cache: CACHE_APPLICATION_ID,
};

/** Every database file of a project is opened like this. A busy timeout of 0
 * makes an open of a project held elsewhere fail at once. */
const DATABASE_OPTIONS = {timeout: 0, defensive: true, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false} as const;

/** Each journal is cut to 0 bytes after every commit, as SQLite already does
 * after a commit that spans files: old pages of the project do not stay in
 * project.mioon-journal while the project is open. */
export const PROJECT_JOURNAL_SIZE_LIMIT = 0;

/** This computer's directories for one project ID. */
export interface ProjectLocation {
  readonly localDir: string;
  readonly cacheDir: string;
  readonly tempDir: string;
}

/** Called once the project file has passed its checks and its project ID is
 * known, before `locate` and before any local directory or history.db exists.
 * The project file is not locked during the call. Throwing aborts the open and
 * the error reaches the caller unchanged. */
export type ProjectCopyCheck = (file: {readonly projectId: string; readonly projectFile: string}) => void;

export interface OpenProjectConnectionOptions {
  readonly projectFile: string;
  readonly locate: (projectId: string) => ProjectLocation;
  readonly checkCopy?: ProjectCopyCheck;
}

/** One connection with the local records as `main` and the project file and
 * the cache attached, all three locked until close(). */
export type ProjectConnection = Omit<ProjectStoreContract<DatabaseSync>, 'root'>;

export interface CreateProjectFileOptions {
  readonly projectId?: string;
}

const describe = (database: DatabaseKind, reason: ProjectFileErrorReason, projectId?: string): ProjectFileErrorDetails =>
  projectId === undefined ? {database, reason} : {database, reason, projectId};
const invalid = (database: DatabaseKind, reason: ProjectFileErrorReason, projectId?: string): AppError =>
  projectFileError('PROJECT_INVALID', describe(database, reason, projectId));

/** A failed open step: kernel errors pass through, SQLite's busy errors mean
 * another connection holds the file, and anything else makes it invalid. */
function openFailure(error: unknown, database: DatabaseKind, projectId?: string): AppError {
  if (error instanceof AppError) return error;
  const code = (error as {code?: unknown} | null | undefined)?.code;
  const failure = isSqliteBusy(error) ? projectFileError('PROJECT_LOCKED', describe(database, 'locked', projectId))
    : database === 'project' && (code === 'ENOENT' || code === 'ENOTDIR') ? projectFileError('PROJECT_MISSING', describe(database, 'missing', projectId))
    : invalid(database, isSqliteCorrupt(error) ? 'corrupt' : 'unusable', projectId);
  failure.cause = error;
  return failure;
}

const pragmaValue = (db: DatabaseSync, pragma: string): unknown => {
  const row = db.prepare(`PRAGMA ${pragma}`).get();
  return row === undefined ? undefined : Object.values(row)[0];
};
const isEmpty = (db: DatabaseSync, schema: string): boolean =>
  db.prepare(`SELECT count(*) AS n FROM ${schema}.sqlite_master`).get()?.n === 0;
/** The project file is opened as an URI with mode=rw, so a file that vanished
 * after the checks is reported instead of being created empty. */
const existingFile = (file: string): string => `${pathToFileURL(file).href}?mode=rw`;

// ---------------------------------------------------------------------------
// Files held by this process

/** Files of this process's open project connections, by file identity.
 * Closing any other descriptor of such a file drops this process's POSIX locks
 * on it (SQLite's own connections share them safely), so the kernel never
 * reads a held file with fs: a second open fails before touching it. */
const heldFiles = new Map<string, {readonly db: DatabaseSync; readonly kind: DatabaseKind}>();
const identityOf = (info: BigIntStats, file: string): string => info.ino ? `${info.dev}:${info.ino}` : `path:${file}`;
type HeldFile = readonly [key: string, kind: DatabaseKind];

// ---------------------------------------------------------------------------
// Creating

/** Creates a complete project file without ever replacing one: the database is
 * built under a temporary name in the same directory, then hard-linked into
 * place (or renamed where the file system has no hard links). */
export function createProjectFile(projectFile: string, {projectId = randomUUID()}: CreateProjectFileOptions = {}): string {
  if (!isProjectId(projectId)) throw new TypeError('Invalid project ID');
  const target = path.resolve(projectFile);
  const exists = (): AppError => projectFileError(PROJECT_FILE_EXISTS, {database: 'project', reason: 'exists'});
  if (lstatSync(target, {throwIfNoEntry: false})) throw exists();
  const temporary = `${target}.creating-${randomUUID()}`;
  try {
    const db = new DatabaseSync(temporary, DATABASE_OPTIONS);
    try {
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL');
      inTransaction(db, () => {
        buildDatabase(db, 'project', 'main');
        db.prepare('INSERT INTO main.project_file VALUES(1,?,0)').run(projectId);
      });
    } finally {
      db.close();
    }
    try {
      linkSync(temporary, target);
    } catch (error) {
      const code = (error as {code?: unknown} | null | undefined)?.code;
      if (code === 'EEXIST') throw exists();
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EXDEV') throw error;
      // No hard links here (exFAT and the like). The rename would replace a
      // file created after this check.
      if (lstatSync(target, {throwIfNoEntry: false})) throw exists();
      renameSync(temporary, target);
    }
  } finally {
    rmSync(temporary, {force: true});
    rmSync(`${temporary}-journal`, {force: true});
  }
  if (process.platform !== 'win32') {
    const directory = openSync(path.dirname(target), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  return projectId;
}

// ---------------------------------------------------------------------------
// Opening

/** Opens one database file with the kernel's connection settings. */
function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file, DATABASE_OPTIONS);
  try {
    db.exec('PRAGMA trusted_schema=OFF');
    if (pragmaValue(db, 'trusted_schema') !== 0) throw new Error('Trusted schema must be disabled');
    if (pragmaValue(db, 'foreign_keys') !== 1) throw new Error('Foreign-key enforcement must be enabled');
    db.exec('PRAGMA cell_size_check=ON');
    // Without a schema name this also applies to databases attached later.
    db.exec('PRAGMA locking_mode=EXCLUSIVE');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Takes the write lock of every database on the connection and, in exclusive
 * locking mode, keeps it until the connection closes. SQLite rolls back a hot
 * journal on the way. */
const lock = (db: DatabaseSync): void => { db.exec('BEGIN EXCLUSIVE; COMMIT'); };

function inTransaction(db: DatabaseSync, write: () => void): void {
  db.exec('BEGIN');
  try {
    write();
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/** Version, identity, journal mode and structure manifest of one database on
 * the connection. A newer version is reported before any other mismatch: a
 * newer Mioon may have changed the structure. */
function checkStructure(db: DatabaseSync, schema: string, kind: DatabaseKind, projectId?: string): void {
  if (pragmaValue(db, `${schema}.application_id`) !== APPLICATION_IDS[kind]) throw invalid(kind, 'application-id', projectId);
  const definition = db.prepare(`SELECT sql FROM ${schema}.sqlite_master WHERE type='table' AND name='schema_version'`).get();
  if (definition?.sql !== SCHEMA_VERSION_TABLE_SQL) throw invalid(kind, 'schema-version', projectId);
  const versions = db.prepare(`SELECT max(version) AS version,count(*) AS count FROM ${schema}.schema_version`).get();
  const supported = SUPPORTED_VERSIONS[kind];
  if (typeof versions?.version === 'number' && versions.version > supported) {
    throw projectFileError('PROJECT_FORMAT_NEWER', {...describe(kind, 'format-newer', projectId), formatVersion: versions.version, supportedFormatVersion: supported});
  }
  if (versions?.count !== 1 || versions.version !== supported) throw invalid(kind, 'schema-version', projectId);
  if (pragmaValue(db, `${schema}.journal_mode`) !== 'delete') throw invalid(kind, 'journal-mode', projectId);
  const {missing, unexpected, changed} = compareManifest(readSchemaManifest(db, schema), SCHEMA_MANIFEST[kind].entries);
  const differences = [...missing.map(name => `missing ${name}`), ...unexpected.map(name => `unexpected ${name}`), ...changed.map(name => `changed ${name}`)];
  if (differences.length) throw projectFileError('PROJECT_INVALID', {...describe(kind, 'schema', projectId), differences});
}

interface ProjectIdentity {
  readonly projectId: string;
  readonly contentSequence: number;
}

/** The project file's metadata row and its at most one project row. */
function readProjectIdentity(db: DatabaseSync, schema: string): ProjectIdentity {
  const rows = db.prepare(`SELECT projectId,contentSequence FROM ${schema}.project_file`).all();
  const row = rows.length === 1 ? rows[0] : undefined;
  if (!row || !isProjectId(row.projectId) || typeof row.contentSequence !== 'number') throw invalid('project', 'metadata');
  const projectId = row.projectId;
  const projects = db.prepare(`SELECT id FROM ${schema}.projects LIMIT 2`).all();
  if (projects.length > 1 || (projects.length === 1 && projects[0].id !== projectId)) throw invalid('project', 'project-row', projectId);
  return {projectId, contentSequence: row.contentSequence};
}

const SQLITE_MAGIC = 'SQLite format 3\u0000';

/** Reads the 100-byte SQLite header without SQLite, so a file that is not a
 * project file (history.db and cache.db included) is never opened as one and
 * SQLite never rolls back a journal out of order. */
function checkHeader(projectFile: string): void {
  const fd = openSync(projectFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw invalid('project', 'not-a-regular-file');
    const header = Buffer.alloc(100);
    const length = readSync(fd, header, 0, header.length, 0);
    if (length < header.length || header.toString('latin1', 0, 16) !== SQLITE_MAGIC || header.readUInt32BE(68) !== PROJECT_FILE_APPLICATION_ID) {
      throw invalid('project', 'not-a-project-file');
    }
    // The file format versions at offsets 18 and 19 are 2 in WAL mode.
    if (header[18] !== 1 || header[19] !== 1) throw invalid('project', 'journal-mode');
  } finally {
    closeSync(fd);
  }
}

/** Step 1: the project file alone. SQLite takes its lock and finishes any
 * recovery before the local records are opened; the file is checked, its
 * project ID read, and the connection closed again. */
function inspectProjectFile(projectFile: string): ProjectIdentity {
  let db: DatabaseSync | undefined;
  try {
    checkHeader(projectFile);
    db = openDatabase(existingFile(projectFile));
    lock(db);
    if (pragmaValue(db, 'encoding') !== 'UTF-8') throw invalid('project', 'encoding');
    checkStructure(db, 'main', 'project');
    const identity = readProjectIdentity(db, 'main');
    if (db.prepare('PRAGMA main.foreign_key_check').get() !== undefined) throw invalid('project', 'foreign-key', identity.projectId);
    return identity;
  } catch (error) {
    throw openFailure(error, 'project');
  } finally {
    db?.close();
  }
}

/** history.db and cache.db must be plain files where they exist. */
function isRegularFileOrMissing(file: string): boolean {
  const info = lstatSync(file, {throwIfNoEntry: false});
  return info === undefined || info.isFile();
}

function removeCache(cacheFile: string): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(`${cacheFile}${suffix}`, {force: true});
}

/** Attaches and locks cache.db. False when it cannot be used as it is; another
 * connection holding it is still an error. */
function attachUsableCache(db: DatabaseSync, cacheFile: string): boolean {
  try {
    db.prepare(`ATTACH DATABASE ? AS ${CACHE}`).run(cacheFile);
    lock(db);
    if (!isEmpty(db, CACHE)) checkStructure(db, CACHE, 'cache');
    return true;
  } catch (error) {
    if (isSqliteBusy(error)) throw error;
    return false;
  }
}

/** The cache never fails an open: whatever does not match is deleted and built anew. */
function attachCache(db: DatabaseSync, cacheFile: string): void {
  if (!isRegularFileOrMissing(cacheFile)) removeCache(cacheFile);
  if (!attachUsableCache(db, cacheFile)) {
    if (db.prepare('PRAGMA database_list').all().some(row => row.name === CACHE)) db.exec(`DETACH DATABASE ${CACHE}`);
    removeCache(cacheFile);
    db.prepare(`ATTACH DATABASE ? AS ${CACHE}`).run(cacheFile);
    lock(db);
  }
  if (isEmpty(db, CACHE)) inTransaction(db, () => buildDatabase(db, 'cache', CACHE));
}

/** Rollback journal, full sync and the journal size limit, read back. */
function configure(db: DatabaseSync, schema: string): void {
  if (pragmaValue(db, `${schema}.journal_mode=DELETE`) !== 'delete') throw new Error(`${schema} must use a rollback journal`);
  db.exec(`PRAGMA ${schema}.synchronous=FULL`);
  if (pragmaValue(db, `${schema}.synchronous`) !== 2) throw new Error(`${schema} must sync fully`);
  if (pragmaValue(db, `${schema}.journal_size_limit=${PROJECT_JOURNAL_SIZE_LIMIT}`) !== PROJECT_JOURNAL_SIZE_LIMIT) throw new Error(`${schema} must limit its journal`);
}

const sequenceOf = (db: DatabaseSync, sql: string): number => {
  const value = Object.values(db.prepare(sql).get() ?? {})[0];
  if (typeof value !== 'number') throw new Error('A content sequence is unreadable');
  return value;
};

interface AttachedDatabases {
  readonly db: DatabaseSync;
  readonly historyState: ProjectHistoryState;
  readonly held: readonly HeldFile[];
}

/** Steps 2 and 3: the local records as main (locked, checked or found empty),
 * then the project file and the cache attached, locked and checked; the local
 * records of a new project are built only after that, then the connection's
 * temporary triggers. */
function attachDatabases(projectFile: string, projectKey: string, identity: ProjectIdentity, historyFile: string, cacheFile: string): AttachedDatabases {
  const {projectId} = identity;
  let database: DatabaseKind = 'history';
  let opened: DatabaseSync | undefined;
  try {
    if (!isRegularFileOrMissing(historyFile)) throw invalid('history', 'not-a-regular-file', projectId);
    const db = openDatabase(historyFile);
    opened = db;
    lock(db);
    const fresh = isEmpty(db, HISTORY);
    if (!fresh) {
      if (pragmaValue(db, 'encoding') !== 'UTF-8') throw invalid('history', 'encoding', projectId);
      checkStructure(db, HISTORY, 'history', projectId);
      const states = db.prepare(`SELECT projectId,seenContentSequence FROM ${HISTORY}.history_state`).all();
      if (states.length !== 1 || typeof states[0].seenContentSequence !== 'number') throw invalid('history', 'metadata', projectId);
      if (states[0].projectId !== projectId) throw invalid('history', 'project-mismatch', projectId);
    }
    database = 'project';
    db.prepare(`ATTACH DATABASE ? AS ${PROJECT}`).run(existingFile(projectFile));
    lock(db);
    // Checked again under this connection's lock: the file was unlocked since step 1.
    checkStructure(db, PROJECT, 'project', projectId);
    const current = readProjectIdentity(db, PROJECT);
    if (current.projectId !== projectId) throw invalid('project', 'project-mismatch', projectId);
    if (fresh) {
      database = 'history';
      inTransaction(db, () => {
        buildDatabase(db, 'history', HISTORY);
        db.prepare(`INSERT INTO ${HISTORY}.history_state VALUES(1,?,?)`).run(projectId, current.contentSequence);
      });
    }
    database = 'cache';
    attachCache(db, cacheFile);
    for (const [schema, kind] of [[HISTORY, 'history'], [PROJECT, 'project'], [CACHE, 'cache']] as const) {
      database = kind;
      configure(db, schema);
    }
    database = 'project';
    if (pragmaValue(db, 'busy_timeout') !== 0) throw new Error('The busy timeout must be 0');
    installCrossFileTriggers(db);
    const file = sequenceOf(db, `SELECT contentSequence FROM ${PROJECT}.project_file`);
    const seen = sequenceOf(db, `SELECT seenContentSequence FROM ${HISTORY}.history_state`);
    const held: readonly HeldFile[] = [
      [projectKey, 'project'],
      [identityOf(lstatSync(historyFile, {bigint: true}), historyFile), 'history'],
      [identityOf(lstatSync(cacheFile, {bigint: true}), cacheFile), 'cache'],
    ];
    return {db, held, historyState: fresh ? 'fresh' : file === seen ? 'current' : file > seen ? 'file-newer' : 'file-older'};
  } catch (error) {
    try { opened?.close(); } catch {}
    throw openFailure(error, database, projectId);
  }
}

/** Opens a project file on one connection: the project file alone first (lock,
 * recovery, checks, project ID), then the copy check, then the local records
 * from `locate` as main with the project file and the cache attached. Every
 * failure closes what was opened and leaves no lock behind. Opening does not
 * change the seen content sequence. */
export function openProjectConnection({projectFile: requested, locate, checkCopy}: OpenProjectConnectionOptions): ProjectConnection {
  const projectFile = path.resolve(requested);
  let info: BigIntStats | undefined;
  try {
    info = lstatSync(projectFile, {bigint: true, throwIfNoEntry: false});
  } catch (error) {
    throw openFailure(error, 'project');
  }
  if (!info) throw projectFileError('PROJECT_MISSING', describe('project', 'missing'));
  if (!info.isFile()) throw invalid('project', 'not-a-regular-file');
  const projectKey = identityOf(info, projectFile);
  const held = heldFiles.get(projectKey);
  if (held?.db.isOpen) throw held.kind === 'project' ? projectFileError('PROJECT_LOCKED', describe('project', 'locked')) : invalid('project', 'not-a-project-file');
  const identity = inspectProjectFile(projectFile);
  checkCopy?.({projectId: identity.projectId, projectFile});
  const location = locate(identity.projectId);
  const localDir = path.resolve(location.localDir), cacheDir = path.resolve(location.cacheDir), tempDir = path.resolve(location.tempDir);
  for (const directory of [localDir, cacheDir, tempDir]) ensurePrivateDirectory(directory, {create: true});
  const {db, held: files, historyState} = attachDatabases(projectFile, projectKey, identity, path.join(localDir, PROJECT_HISTORY_FILE), path.join(cacheDir, PROJECT_CACHE_FILE));
  for (const [key, kind] of files) heldFiles.set(key, {db, kind});
  let closed = false;
  return {
    db, projectId: identity.projectId, projectFile, projectDir: path.dirname(projectFile), localDir, cacheDir, tempDir, historyState,
    close(): void {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } finally {
        for (const [key] of files) if (heldFiles.get(key)?.db === db) heldFiles.delete(key);
      }
    },
  };
}
