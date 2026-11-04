import {randomUUID} from 'node:crypto';
import {closeSync, constants, copyFileSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, renameSync, rmSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {ensurePrivateDirectory} from '@mioon/contracts/private-storage';
import {AppError} from '../../../contracts/src/app-error.ts';
import {isProjectId, PROJECT_CACHE_FILE, PROJECT_DATABASE_NAMES, PROJECT_FILE_EXISTS, PROJECT_HISTORY_FILE} from '../../../contracts/src/project-file.ts';
import type {ContentStamp, ProjectHistoryAdmission, ProjectHistoryState, ProjectInvalidReason, ProjectStore as ProjectStoreContract} from '../../../contracts/src/project-file.ts';
import type {ProjectFileIdentity} from '../../../contracts/src/project-registry.ts';
import {installCrossFileTriggers, installDivergedWriteGuards} from './cross-file/install.ts';
import {isSqliteBusy, isSqliteCorrupt, isSqliteReadOnly, projectFileError, projectFileMovedError} from './errors.ts';
import {copyIsolatedRecoveryJournal, isHotJournal, isSuperJournalInUse, superJournalsIn} from './journals.ts';
import type {ProjectFileErrorDetails, ProjectFileErrorReason} from './errors.ts';
import {
  buildDatabase, CACHE_APPLICATION_ID, CACHE_SCHEMA_VERSION, HISTORY_APPLICATION_ID, HISTORY_SCHEMA_VERSION,
  PROJECT_FILE_APPLICATION_ID, PROJECT_FILE_SCHEMA_VERSION, SCHEMA_VERSION_TABLE_SQL,
} from './schema/databases.ts';
import type {DatabaseKind} from './schema/databases.ts';
import {compareManifest, readSchemaManifest} from './schema/manifest-check.ts';
import type {SchemaManifest} from './schema/manifest-check.ts';
import {SCHEMA_MANIFEST} from './schema/manifest.ts';
import {clearProjectProcessRevisions, HISTORY_UPGRADES} from './schema/history-upgrades.ts';
import type {HistoryUpgrade} from './schema/history-upgrades.ts';
import {projectFileOwnerKind, registerProjectFiles, releaseProjectFiles} from './held-files.ts';
export {isProjectDatabase, isProjectFileHeld} from './held-files.ts';
import {classifyHistoryStamp, isContentToken, readProjectContentStamp, sameContentStamp} from './content-stamp.ts';
import {HISTORY_TABLES} from './schema/tables.ts';

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

/** Internal S5 reader capability. The caller validates both closed sources
 * before this call and performs all reads in one transaction. Registering
 * these native handles also blocks fs-based preflights during backup awaits:
 * closing an unrelated descriptor would otherwise release POSIX locks. */
export function openClosedProjectSnapshotConnection(options:{readonly projectFile:string;readonly historyFile?:string}):{readonly db:DatabaseSync;close():void} {
 const inputs:readonly (readonly [string,DatabaseKind])[]=[
  [path.resolve(options.projectFile),'project'],...(options.historyFile?[[path.resolve(options.historyFile),'history'] as const]:[]),
 ];
 const files:HeldFile[]=inputs.map(([file,kind])=>{
  const info=lstatSync(file,{bigint:true}),key=identityOf(info,file);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1n)throw invalid(kind,'not-a-regular-file');
  if(projectFileOwnerKind(key)!==undefined)throw projectFileError('PROJECT_LOCKED',describe(kind,'locked'));
  return [key,kind];
 });
 if(new Set(files.map(([key])=>key)).size!==files.length)throw invalid('history','project-mismatch');
 const db=new DatabaseSync(inputs[0]![0],{...DATABASE_OPTIONS,readOnly:true});
 try{
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA cell_size_check=ON');
  if(inputs[1])db.prepare('ATTACH DATABASE ? AS history').run(pathToFileURL(inputs[1][0]).href+'?mode=ro');
  for(let i=0;i<inputs.length;i++)if(identityOf(lstatSync(inputs[i]![0],{bigint:true}),inputs[i]![0])!==files[i]![0])throw invalid(inputs[i]![1],'unusable');
  registerProjectFiles(db,files);
  let closed=false;
  return {db,close():void{if(closed)return;closed=true;try{db.close();}finally{releaseProjectFiles(db,files);}}};
 }catch(error){db.close();throw error;}
}

/** One connection with the local records as `main` and the project file and
 * the cache attached, all three locked until close(). */
export interface ProjectConnection extends Omit<ProjectStoreContract<DatabaseSync>, 'root'> {
  /** Throws PROJECT_FILE_MOVED once the project file alone was renamed or
   * moved since the open (see movedAlone). The store calls it before every
   * write it starts. */
  throwIfMoved(): void;
}

export interface CreateProjectFileOptions {
  readonly projectId?: string;
  readonly contentToken?: string;
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
    : invalid(database, isSqliteCorrupt(error) ? 'corrupt' : isSqliteReadOnly(error) ? 'read-only' : 'unusable', projectId);
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
const identityOf = (info: BigIntStats, file: string): string => info.ino ? `${info.dev}:${info.ino}` : `path:${file}`;
type HeldFile = readonly [key: string, kind: DatabaseKind];

// ---------------------------------------------------------------------------
// Creating

/** Creates a complete project file without ever replacing one: the database is
 * built under a temporary name in the same directory, then hard-linked into
 * place (or renamed where the file system has no hard links). */
export function createProjectFile(projectFile: string, {projectId = randomUUID(), contentToken}: CreateProjectFileOptions = {}): string {
  if (!isProjectId(projectId)) throw new TypeError('Invalid project ID');
  if (contentToken !== undefined && !isContentToken(contentToken)) throw new TypeError('Invalid content token');
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
        db.prepare('INSERT INTO main.project_file VALUES(1,?,0,COALESCE(?,lower(hex(randomblob(16)))))').run(projectId,contentToken ?? null);
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
function checkStructure(db: DatabaseSync, schema: string, kind: DatabaseKind, projectId?: string, expected: SchemaManifest = SCHEMA_MANIFEST[kind]): void {
  if (pragmaValue(db, `${schema}.application_id`) !== APPLICATION_IDS[kind]) throw invalid(kind, 'application-id', projectId);
  const definition = db.prepare(`SELECT sql FROM ${schema}.sqlite_master WHERE type='table' AND name='schema_version'`).get();
  if (definition?.sql !== SCHEMA_VERSION_TABLE_SQL) throw invalid(kind, 'schema-version', projectId);
  const versions = db.prepare(`SELECT max(version) AS version,count(*) AS count FROM ${schema}.schema_version`).get();
  if (typeof versions?.version === 'number' && versions.version > SUPPORTED_VERSIONS[kind]) {
    throw projectFileError('PROJECT_FORMAT_NEWER', {...describe(kind, 'format-newer', projectId), formatVersion: versions.version, supportedFormatVersion: SUPPORTED_VERSIONS[kind]});
  }
  if (versions?.count !== 1 || versions.version !== expected.version) throw invalid(kind, 'schema-version', projectId);
  if (pragmaValue(db, `${schema}.journal_mode`) !== 'delete') throw invalid(kind, 'journal-mode', projectId);
  const {missing, unexpected, changed} = compareManifest(readSchemaManifest(db, schema), expected.entries);
  const differences = [...missing.map(name => `missing ${name}`), ...unexpected.map(name => `unexpected ${name}`), ...changed.map(name => `changed ${name}`)];
  if (differences.length) throw projectFileError('PROJECT_INVALID', {...describe(kind, 'schema', projectId), differences});
}

/** An older history is accepted only for one reviewed version/manifest pair.
 * This merely identifies the transition: no table is changed before the
 * project is attached, locked and checked for external content changes. */
function checkHistoryStructure(db: DatabaseSync, projectId: string): HistoryUpgrade | undefined {
  const definition = db.prepare(`SELECT sql FROM ${HISTORY}.sqlite_master WHERE type='table' AND name='schema_version'`).get();
  const version = definition?.sql === SCHEMA_VERSION_TABLE_SQL
    ? db.prepare(`SELECT max(version) AS version,count(*) AS count FROM ${HISTORY}.schema_version`).get()
    : undefined;
  const upgrade = version?.count === 1 ? HISTORY_UPGRADES.find(candidate => candidate.from.version === version.version && candidate.toVersion === HISTORY_SCHEMA_VERSION) : undefined;
  checkStructure(db, HISTORY, 'history', projectId, upgrade?.from);
  return upgrade;
}

export interface ProjectIdentity extends ContentStamp {
  readonly projectId: string;
}

/** The project file's metadata row and its at most one project row. */
function readProjectIdentity(db: DatabaseSync, schema: string): ProjectIdentity {
  const rows = db.prepare(`SELECT projectId,contentSequence,contentToken FROM ${schema}.project_file`).all();
  const row = rows.length === 1 ? rows[0] : undefined;
  if (!row || !isProjectId(row.projectId) || typeof row.contentSequence !== 'number') throw invalid('project', 'metadata');
  const projectId = row.projectId;
  const projects = db.prepare(`SELECT id FROM ${schema}.projects LIMIT 2`).all();
  if (projects.length > 1 || (projects.length === 1 && projects[0].id !== projectId)) throw invalid('project', 'project-row', projectId);
  return {projectId, ...readProjectContentStamp(db,schema)};
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
    const format = header.readUInt32BE(60);
    if (format > PROJECT_FILE_SCHEMA_VERSION) throw projectFileError('PROJECT_FORMAT_NEWER', {...describe('project','format-newer'),formatVersion:format,supportedFormatVersion:PROJECT_FILE_SCHEMA_VERSION});
    if (format !== PROJECT_FILE_SCHEMA_VERSION) throw invalid('project','schema-version');
    // The file format versions at offsets 18 and 19 are 2 in WAL mode.
    if (header[18] !== 1 || header[19] !== 1) throw invalid('project', 'journal-mode');
  } finally {
    closeSync(fd);
  }
}

/** Full preflight without a writable SQLite descriptor. A current header is
 * only a gate: the exact manifest, metadata and native keys still have to pass. */
export function inspectProjectFileReadOnly(requested: string): ProjectIdentity {
  const projectFile = path.resolve(requested);
  let db: DatabaseSync | undefined;
  try {
    const before = lstatSync(projectFile,{bigint:true});
    const held = projectFileOwnerKind(identityOf(before,projectFile));
    if (held !== undefined) throw held === 'project' ? projectFileError('PROJECT_LOCKED',describe('project','locked')) : invalid('project','not-a-project-file');
    checkHeader(projectFile);
    if (isHotJournal(`${projectFile}-journal`)) throw invalid('project','hot-journal');
    db = new DatabaseSync(`${pathToFileURL(projectFile).href}?mode=ro`,{...DATABASE_OPTIONS,readOnly:true});
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA cell_size_check=ON');
    if (pragmaValue(db,'encoding') !== 'UTF-8') throw invalid('project','encoding');
    checkStructure(db,'main','project');
    if (pragmaValue(db,'user_version') !== PROJECT_FILE_SCHEMA_VERSION) throw invalid('project','schema-version');
    const identity = readProjectIdentity(db,'main');
    if (db.prepare('PRAGMA main.foreign_key_check').get() !== undefined) throw invalid('project','foreign-key',identity.projectId);
    const after = lstatSync(projectFile,{bigint:true});
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw invalid('project','unusable',identity.projectId);
    return identity;
  } catch (error) {throw openFailure(error,'project');}
  finally {db?.close();}
}
const inspectProjectFile = inspectProjectFileReadOnly;

/** Validate recovery on a disconnected clone. Its journal never names a source
 * super-journal, so SQLite cannot delete or write any original companion. */
function validateRecoveryInIsolation(projectFile: string): ProjectIdentity {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-recovery-preflight-'));
  const file = path.join(directory,'project.mioon');
  let db: DatabaseSync | undefined;
  try {
    copyFileSync(projectFile,file);
    copyIsolatedRecoveryJournal(`${projectFile}-journal`,`${file}-journal`);
    db = openDatabase(existingFile(file));
    lock(db);
    checkStructure(db,'main','project');
    if (pragmaValue(db,'user_version') !== PROJECT_FILE_SCHEMA_VERSION) throw invalid('project','schema-version');
    const identity = readProjectIdentity(db,'main');
    if (db.prepare('PRAGMA main.foreign_key_check').get() !== undefined) throw invalid('project','foreign-key');
    return identity;
  } finally {db?.close();rmSync(directory,{recursive:true,force:true});}
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

/** The last step of an open: page 1 of the project file is changed in a
 * transaction that is rolled back, so the change reaches only the page cache
 * and the file keeps its bytes and modification time. SQLite opens a
 * database's rollback journal for its first write and refuses it with
 * SQLITE_READONLY_DBMOVED once the file has been renamed; in exclusive locking
 * mode it keeps the journal open from then on (cut to 0 bytes after each
 * transaction) and does not check again. So the project folder can be moved
 * while the project is open. A location without write permission fails here
 * with SQLITE_READONLY, at the open instead of at the first write. */
function openProjectJournal(db: DatabaseSync): void {
  const version = pragmaValue(db, `${PROJECT}.user_version`);
  if (typeof version !== 'number' || !Number.isSafeInteger(version)) throw new Error('The project file user version is unreadable');
  db.exec('BEGIN');
  try {
    db.exec(`PRAGMA ${PROJECT}.user_version=${version}`);
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
  }
}

/** Deletes the super-journals beside the local records that SQLite no longer
 * needs (isSuperJournalInUse), such as one left by a process killed while it
 * wrote the super-journal: it is never read again but would keep the local
 * records folder from being deleted. Runs once the connection holds all three
 * files, so no other process commits to them meanwhile. A super-journal still
 * in use, or one that cannot be read, stays. */
function removeUnusedSuperJournals(localDir: string): void {
  let superJournals: string[];
  try {
    superJournals = superJournalsIn(localDir);
  } catch {
    return;
  }
  for (const superJournal of superJournals) {
    try {
      if (lstatSync(superJournal).isFile() && !isSuperJournalInUse(superJournal)) rmSync(superJournal, {force: true});
    } catch {
      // Kept: it may still be needed.
    }
  }
}

/** Only the kernel-owned staged location may hold a new execution history.
 * Ordinary opening never accepts a history path override or a writable mode. */
export interface StagedProjectConnectionOptions {
  readonly projectFile: string;
  readonly location: ProjectLocation;
  readonly historyFile: string;
  readonly expectedStamp: ContentStamp;
  readonly resolution?: {readonly requestId: string; readonly digest: string};
}
function validateStagedHistory(db: DatabaseSync, options: StagedProjectConnectionOptions, current: ProjectIdentity): void {
  const records = db.prepare('SELECT requestId,digest,result FROM main.project_history_resolution').all();
  if (records.length > 1) throw invalid('history','metadata',current.projectId);
  const committed = records[0];
  if (committed) {
    if (!options.resolution || committed.requestId !== options.resolution.requestId || committed.digest !== options.resolution.digest || typeof committed.result !== 'string') throw invalid('history','metadata',current.projectId);
    const result: unknown = JSON.parse(committed.result);
    const content = result !== null && typeof result === 'object' ? (result as {content?: unknown}).content : undefined;
    if (!content || typeof content !== 'object' || !sameContentStamp(content as ContentStamp,current)) throw invalid('history','metadata',current.projectId);
  } else if (!sameContentStamp(options.expectedStamp,current)) {
    throw new AppError('PROJECT_VERSION_PREVIEW_STALE','项目内容身份已变化，未执行处置。',409,{projectId:current.projectId});
  }
  const versions = new Set(['project_version_blobs','project_versions','project_version_requests','project_version_capture_marks','mio_storage_counters']);
  for (const table of HISTORY_TABLES) if (!versions.has(table) && db.prepare(`SELECT 1 FROM main."${table}" LIMIT 1`).get()) throw invalid('history','metadata',current.projectId);
  const counter = db.prepare('SELECT bytes,rows FROM main.mio_storage_counters').all();
  if (counter.length !== 1 || counter[0].bytes !== 0 || counter[0].rows !== 1) throw invalid('history','metadata',current.projectId);
}
export function openStagedProjectConnection(options: StagedProjectConnectionOptions): ProjectConnection {
  const historyFile = path.resolve(options.historyFile), localDir = path.resolve(options.location.localDir);
  if (path.dirname(historyFile) !== localDir || !/^history\.staged-[a-f0-9-]{36}\.db$/u.test(path.basename(historyFile))
    || !Number.isSafeInteger(options.expectedStamp.contentSequence) || options.expectedStamp.contentSequence < 0 || !isContentToken(options.expectedStamp.contentToken)
    || options.resolution && (!isProjectId(options.resolution.requestId) || !/^[a-f0-9]{64}$/u.test(options.resolution.digest))) throw new TypeError('Invalid staged history identity');
  return openConnection({projectFile:options.projectFile,locate:()=>options.location},{...options,historyFile});
}

interface AttachedDatabases {
  readonly db: DatabaseSync;
  readonly historyState: ProjectHistoryState;
  readonly historyAdmission: ProjectHistoryAdmission;
  readonly held: readonly HeldFile[];
}

/** Steps 2 and 3: the local records as main (locked, checked or found empty),
 * then the project file and the cache attached, locked and checked; the local
 * records of a new project are built only after that, then the connection's
 * temporary triggers. */
function attachDatabases(projectFile: string, projectKey: string, identity: ProjectIdentity, historyFile: string, cacheFile: string, staged?: StagedProjectConnectionOptions): AttachedDatabases {
  const {projectId} = identity;
  let database: DatabaseKind = 'history';
  let opened: DatabaseSync | undefined;
  try {
    if (!isRegularFileOrMissing(historyFile)) throw invalid('history', 'not-a-regular-file', projectId);
    const db = openDatabase(historyFile);
    opened = db;
    lock(db);
    const fresh = isEmpty(db, HISTORY);
    let upgrade: HistoryUpgrade | undefined;
    if (!fresh) {
      if (pragmaValue(db, 'encoding') !== 'UTF-8') throw invalid('history', 'encoding', projectId);
      upgrade = checkHistoryStructure(db, projectId);
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
    database = 'cache';
    attachCache(db, cacheFile);
    for (const [schema, kind] of [[HISTORY, 'history'], [PROJECT, 'project'], [CACHE, 'cache']] as const) {
      database = kind;
      configure(db, schema);
    }
    // Mio accounting needs DELETE triggers for REPLACE's implicit old row.
    // The kernel's trigger writes are acyclic; legacy workspace/app openers
    // do not share this connection setting.
    db.exec('PRAGMA recursive_triggers=ON');
    database = 'history';
    if (upgrade) {
      const transition = upgrade;
      inTransaction(db, () => {
        transition.apply(db);
        db.exec(`UPDATE ${HISTORY}.schema_version SET version=${transition.toVersion}`);
        checkStructure(db, HISTORY, 'history', projectId);
        checkStructure(db, PROJECT, 'project', projectId);
      });
    } else if (fresh) {
      inTransaction(db, () => {
        buildDatabase(db, 'history', HISTORY);
        db.prepare(`INSERT INTO ${HISTORY}.history_state VALUES(1,?,?,?)`).run(projectId, current.contentSequence,current.contentToken);
        if (!staged) clearProjectProcessRevisions(db, projectId);
        checkStructure(db, HISTORY, 'history', projectId);
        checkStructure(db, PROJECT, 'project', projectId);
      });
    }
    database = 'project';
    if (pragmaValue(db, 'busy_timeout') !== 0) throw new Error('The busy timeout must be 0');
    if (staged) validateStagedHistory(db,staged,current);
    const historyAdmission = classifyHistoryStamp(db,fresh);
    if (staged && historyAdmission.state === 'diverged') throw invalid('history','metadata',projectId);
    // Confirmation changes the execution history. Rebuildable references from
    // the old cache must not constrain the empty-domain restore preview.
    if (staged) inTransaction(db,()=>db.exec('DELETE FROM cache.previs_thumbnails; DELETE FROM cache.waveform_cache'));
    installCrossFileTriggers(db);
    if (historyAdmission.state === 'diverged') installDivergedWriteGuards(db);
    else openProjectJournal(db);
    const held: readonly HeldFile[] = [
      [projectKey, 'project'],
      [identityOf(lstatSync(historyFile, {bigint: true}), historyFile), 'history'],
      [identityOf(lstatSync(cacheFile, {bigint: true}), cacheFile), 'cache'],
    ];
    // Native open() would reopen only main, losing the attached databases,
    // exclusive locks and TEMP constraints while reviving this DB identity.
    Object.defineProperty(db, 'open', {value: (): never => {
      throw new TypeError('Reopen project databases through openProjectConnection or openProjectStore, not db.open().');
    }});
    return {db, held, historyState:historyAdmission.state, historyAdmission};
  } catch (error) {
    try { opened?.close(); } catch {}
    throw openFailure(error, database, projectId);
  }
}

/** lstat that takes any failure for no entry: the moved check does not refuse
 * a write because it cannot see a path. */
function lstatOrNothing(file: string): BigIntStats | undefined {
  try {
    return lstatSync(file, {bigint: true, throwIfNoEntry: false});
  } catch {
    return undefined;
  }
}

/** Whether the project file alone was renamed or moved after the open: the
 * path it was opened at no longer holds that file (by file identity), while
 * the journal SQLite keeps under that path from the open on
 * (openProjectJournal) is still there. SQLite looks for the journal beside the
 * name a database is opened with, so a commit that crashes after such a move
 * leaves half a transaction in the file at its new path. A folder moved with
 * the file takes the journal along and SQLite writes on through its open
 * descriptors, so that is not a move here. At most two lstat calls, which
 * open neither file; one while the file is in place. */
function movedAlone(projectFile: string, projectKey: string): boolean {
  const info = lstatOrNothing(projectFile);
  if (info && identityOf(info, projectFile) === projectKey) return false;
  return lstatOrNothing(`${projectFile}-journal`) !== undefined;
}

/** Opens a project file on one connection: read-only format/structure/identity
 * preflight first (hot journals require explicit current-format recovery),
 * then the copy check, then the local records
 * from `locate` as main with the project file and the cache attached, and
 * last the project file's journal kept open (openProjectJournal). Every
 * failure closes what was opened and leaves no lock behind. Once open, unused
 * super-journals beside the local records are deleted. Opening does not
 * acknowledge mismatched seen evidence. Only an admitted fresh history may
 * perform its one-time cleanup of local-process project revision rows. */
export function openProjectConnection(options: OpenProjectConnectionOptions): ProjectConnection {
  return openConnection(options);
}
function openConnection({projectFile: requested, locate, checkCopy}: OpenProjectConnectionOptions, staged?: StagedProjectConnectionOptions): ProjectConnection {
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
  const held = projectFileOwnerKind(projectKey);
  if (held !== undefined) throw held === 'project' ? projectFileError('PROJECT_LOCKED', describe('project', 'locked')) : invalid('project', 'not-a-project-file');
  if (staged) {
    const recovery = recoverProjectFile(projectFile);
    if (recovery.state === 'invalid') throw invalid('project',recovery.reason);
    if (recovery.state === 'locked') throw projectFileError('PROJECT_LOCKED',describe('project','locked'));
  }
  const identity = inspectProjectFile(projectFile);
  checkCopy?.({projectId: identity.projectId, projectFile});
  const location = locate(identity.projectId);
  const localDir = path.resolve(location.localDir), cacheDir = path.resolve(location.cacheDir), tempDir = path.resolve(location.tempDir);
  if (!staged && lstatSync(path.join(localDir,'history-switch-active.json'),{throwIfNoEntry:false})) throw new AppError('PROJECT_HISTORY_SWITCH_PENDING','本机记录切换尚未完成。',409,{projectId:identity.projectId});
  for (const directory of [localDir, cacheDir, tempDir]) ensurePrivateDirectory(directory, {create: true});
  const historyFile = staged?.historyFile ?? path.join(localDir,PROJECT_HISTORY_FILE);
  const {db, held: files, historyState, historyAdmission} = attachDatabases(projectFile, projectKey, identity, historyFile, path.join(cacheDir, PROJECT_CACHE_FILE),staged);
  registerProjectFiles(db, files);
  removeUnusedSuperJournals(localDir);
  let closed = false;
  return {
    db, projectId: identity.projectId, projectFile, projectDir: path.dirname(projectFile), localDir, cacheDir, tempDir, historyState, historyAdmission,
    throwIfMoved(): void {
      if (movedAlone(projectFile, projectKey)) throw projectFileMovedError(identity.projectId);
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } finally {
        releaseProjectFiles(db, files);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Recovering without opening

/** What recoverProjectFile found:
 * - `clean`: no hot journal beside the project file; the project file itself
 *   was not read, not even its header;
 * - `recovered`: SQLite rolled the hot journal back;
 * - `locked`: another process holds the project file, for example while it
 *   writes; nothing to do here;
 * - `open-here`: this process has the project open; no file was touched;
 * - `missing`: no project file at this path;
 * - `invalid`: not something to recover, with the PROJECT_INVALID reason the
 *   open would report, such as `not-a-project-file` or `read-only`. Only a
 *   path that is not a regular file, or a file with a hot journal beside it,
 *   is found invalid here; any other file is `clean` until it is opened. */
export type ProjectFileRecovery =
  | {readonly state: 'clean' | 'recovered' | 'locked' | 'open-here' | 'missing'}
  | {readonly state: 'invalid'; readonly reason: ProjectInvalidReason};

const recoveryOf = (error: unknown): ProjectFileRecovery => {
  const failure = openFailure(error, 'project');
  if (failure.code === 'PROJECT_LOCKED') return {state: 'locked'};
  if (failure.code === 'PROJECT_MISSING') return {state: 'missing'};
  const {reason} = failure.details as ProjectFileErrorDetails;
  return {state: 'invalid', reason: reason === 'missing' || reason === 'locked' || reason === 'format-newer' || reason === 'exists' ? 'unusable' : reason};
};

/** Step 1 of the opening order and nothing else: when the project file has a
 * hot journal beside it, checks its current header and validates the exact
 * recovered structure on an isolated copy before taking the source write lock
 * and letting SQLite recover it. The local records are not
 * opened. A commit that crashed in the middle can leave half a transaction in
 * the project file with a hot journal that names a super-journal beside the
 * local records; copied to another computer without being opened here first,
 * the file would be taken as committed there. Call it for projects that are
 * not open, for example at startup and when listing recent projects. A project
 * this process has open is recognised by file identity before any file is read.
 * The journal is looked at before the project file: without a hot journal
 * (none, 0 bytes, or a zero first byte) nothing of the project file is read.
 * Every listing of recent projects calls this, and a first read of a file that
 * iCloud has moved off this computer downloads all of it. */
export function recoverProjectFile(requested: string): ProjectFileRecovery {
  const projectFile = path.resolve(requested);
  let info: BigIntStats | undefined;
  try {
    info = lstatSync(projectFile, {bigint: true, throwIfNoEntry: false});
  } catch (error) {
    return recoveryOf(error);
  }
  if (!info) return {state: 'missing'};
  if (!info.isFile()) return {state: 'invalid', reason: 'not-a-regular-file'};
  const held = projectFileOwnerKind(identityOf(info, projectFile));
  if (held !== undefined) return held === 'project' ? {state: 'open-here'} : {state: 'invalid', reason: 'not-a-project-file'};
  let db: DatabaseSync | undefined;
  try {
    if (!isHotJournal(`${projectFile}-journal`)) return {state: 'clean'};
    checkHeader(projectFile);
    const before = lstatSync(projectFile,{bigint:true});
    const recovered = validateRecoveryInIsolation(projectFile);
    const after = lstatSync(projectFile,{bigint:true});
    if (before.dev!==after.dev || before.ino!==after.ino || before.size!==after.size || before.mtimeNs!==after.mtimeNs) throw invalid('project','unusable');
    db = openDatabase(existingFile(projectFile));
    lock(db);
    checkStructure(db,'main','project');
    if (!sameContentStamp(readProjectIdentity(db,'main'),recovered)) throw invalid('project','metadata');
    return {state: 'recovered'};
  } catch (error) {
    return recoveryOf(error);
  } finally {
    db?.close();
  }
}
