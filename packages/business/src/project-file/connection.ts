import {randomBytes, randomUUID} from 'node:crypto';
import {closeSync, constants, copyFileSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, renameSync, rmSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {ensurePrivateDirectory, validatePrivateDirectory, validateManagedFile, privateStorageIdentity} from '@mioon/contracts/private-storage';
import type {Stats} from 'node:fs';
import {AppError} from '../../../contracts/src/app-error.ts';
import {isProjectId, PROJECT_CACHE_FILE, PROJECT_DATABASE_NAMES, PROJECT_FILE_EXISTS, PROJECT_HISTORY_FILE} from '../../../contracts/src/project-file.ts';
import type {ContentStamp, ProjectHistoryAdmission, ProjectHistoryState, ProjectInvalidReason, ProjectStore as ProjectStoreContract} from '../../../contracts/src/project-file.ts';
import type {ProjectFileIdentity} from '../../../contracts/src/project-registry.ts';
import {installCrossFileTriggers, installDivergedWriteGuards} from './cross-file/install.ts';
import {foreignKeyCheck} from './cross-file/inspect.ts';
import {isSqliteBusy, isSqliteCorrupt, isSqliteReadOnly, projectFileError, projectFileMovedError} from './errors.ts';
import {copyIsolatedRecoveryJournal, isHotJournal, isSuperJournalInUse, superJournalsIn} from './journals.ts';
import type {ProjectFileErrorDetails, ProjectFileErrorReason} from './errors.ts';
import {
  buildDatabase, CACHE_APPLICATION_ID, CACHE_SCHEMA_VERSION, HISTORY_APPLICATION_ID, HISTORY_SCHEMA_VERSION,
  PROJECT_FILE_APPLICATION_ID, PROJECT_FILE_SCHEMA_VERSION, SCHEMA_VERSION_TABLE_SQL,
  FORMAT4_PROJECT_SCHEMA_VERSION, FORMAT4_HISTORY_SCHEMA_VERSION,
} from './schema/databases.ts';
import type {DatabaseKind, ProjectFileFormat} from './schema/databases.ts';
import {compareManifest, readSchemaManifest} from './schema/manifest-check.ts';
import type {SchemaManifest} from './schema/manifest-check.ts';
import {SCHEMA_MANIFEST} from './schema/manifest.ts';
import {historyManifestForVersion, projectManifestForVersion} from './schema/format-manifests.ts';
import {addFormat4HistoryStructureInside, addFormat4ProjectStructureInside, addFormat4ReceiptExpiryInside, writeFormat4HistoryVersionInside, writeFormat4ProjectVersionInside} from './schema/format4-upgrade.ts';
import {FORMAT4_INITIAL_HISTORY_MANIFEST} from './schema/history-v11-manifest.ts';
import {createFormat4UpgradeBackup, FORMAT4_RESTORE_ACTIVE} from './format4-backup.ts';
import {isAppLibraryHeld} from '../app-db/connection.ts';
import {assertProjectTimelineGeometryProfile} from './schema/format4-geometry.ts';
import {clearProjectProcessRevisions, HISTORY_UPGRADES} from './schema/history-upgrades.ts';
import type {HistoryUpgrade} from './schema/history-upgrades.ts';
import {projectFileOwnerKind, registerProjectFiles, releaseProjectFiles} from './held-files.ts';
export {isProjectDatabase, isProjectFileHeld} from './held-files.ts';
import {classifyHistoryStamp, isContentToken, readProjectContentStamp, sameContentStamp} from './content-stamp.ts';
import {historyTablesForVersion} from './schema/tables.ts';

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
  readonly format4?: Format4Options;
}

export interface Format4UpgradePreview extends ProjectIdentity {
  readonly projectVersion: typeof PROJECT_FILE_SCHEMA_VERSION;
  readonly historyVersion: number | null;
}

export type Format4UpgradeBoundary = 'before-version-write' | 'before-commit' | 'after-commit';
export interface Format4Options {
  /** Trusted caller's approval for the exact preflight identity. Existing
   * v4 projects and new private destinations do not need this callback. */
  readonly approveUpgrade?: (preview: Format4UpgradePreview) => boolean;
  readonly onUpgradeBoundary?: (phase: Format4UpgradeBoundary, observed: Readonly<{projectVersion: number; historyVersion: number | null}>) => void;
}

export function assertNoFormat4Restore(localDir: string, projectId: string): void {
  if (lstatSync(path.join(localDir, FORMAT4_RESTORE_ACTIVE), {throwIfNoEntry: false})) {
    throw new AppError('PROJECT_FORMAT_RESTORE_PENDING', '旧格式配对恢复尚未完成。', 409, {projectId});
  }
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

/** S5's copy-adoption capability. A reserved write transaction excludes
 * SQLite writers while a second, read-only handle feeds native backup. The
 * backup API cannot read from the same handle's write transaction. Both
 * handles stay open until the replacement and its caller's bookkeeping end:
 * closing either descriptor earlier would release this process's POSIX locks. */
export function openProjectCopyReplacementConnections(projectFile:string):{readonly reader:DatabaseSync;close():void} {
 const file=path.resolve(projectFile),before=lstatSync(file,{bigint:true}),key=identityOf(before,file);
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n)throw invalid('project','not-a-regular-file');
 if(projectFileOwnerKind(key)!==undefined)throw projectFileError('PROJECT_LOCKED',describe('project','locked'));
 const files:HeldFile[]=[[key,'project']];
 let writer:DatabaseSync|undefined,reader:DatabaseSync|undefined,registered=false;
 const close=():void=>{
  try{if(reader?.isOpen){if(reader.isTransaction)reader.exec('ROLLBACK');reader.close();}}
  finally{try{if(writer?.isOpen){if(writer.isTransaction)writer.exec('ROLLBACK');writer.close();}}finally{if(registered&&writer)releaseProjectFiles(writer,files);}}
 };
 try{
  writer=new DatabaseSync(file,DATABASE_OPTIONS);
  writer.exec('PRAGMA trusted_schema=OFF; PRAGMA cell_size_check=ON; BEGIN IMMEDIATE');
  if(identityOf(lstatSync(file,{bigint:true}),file)!==key)throw invalid('project','unusable');
  registerProjectFiles(writer,files);registered=true;
  reader=new DatabaseSync(file,{...DATABASE_OPTIONS,readOnly:true});
  reader.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA cell_size_check=ON; BEGIN');
  if(identityOf(lstatSync(file,{bigint:true}),file)!==key)throw invalid('project','unusable');
  let closed=false;
  return {reader,close():void{if(closed)return;closed=true;close();}};
 }catch(error){close();throw error;}
}

/** One connection with the local records as `main` and the project file and
 * the cache attached, all three locked until close(). */
export interface ProjectConnection extends Omit<ProjectStoreContract<DatabaseSync>, 'root'> {
  /** Throws PROJECT_FILE_MOVED once the project file alone was renamed or
   * moved since the open (see movedAlone). The store calls it before every
   * write it starts. */
  throwIfMoved(): void;
  /** Metadata only, tied to this held connection; never opens another DB fd. */
  historyIdentity(): {readonly directory: Stats; readonly db: Stats};
}

export interface CreateProjectFileOptions {
  readonly projectId?: string;
  readonly contentToken?: string;
  readonly format4?: Format4Options;
}

const describe = (database: DatabaseKind, reason: ProjectFileErrorReason, projectId?: string): ProjectFileErrorDetails =>
  projectId === undefined ? {database, reason} : {database, reason, projectId};
const invalid = (database: DatabaseKind, reason: ProjectFileErrorReason, projectId?: string): AppError =>
  projectFileError('PROJECT_INVALID', describe(database, reason, projectId));

/** Keep explicit OS access denial separate from absence, locks and damage.
 * A generic SQLITE_CANTOPEN carries no permission evidence. */
function openFailure(error: unknown, database: DatabaseKind, projectId?: string): AppError {
  if (error instanceof AppError) return error;
  const code = (error as {code?: unknown} | null | undefined)?.code;
  const failure = isSqliteBusy(error) ? projectFileError('PROJECT_LOCKED', describe(database, 'locked', projectId))
    : code === 'EACCES' || code === 'EPERM' ? projectFileError('PROJECT_ACCESS_DENIED', describe(database, 'access-denied', projectId))
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
export function createProjectFile(projectFile: string, {projectId = randomUUID(), contentToken, format4}: CreateProjectFileOptions = {}): string {
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
        buildDatabase(db, 'project', 'main', undefined, format4 ? FORMAT4_PROJECT_SCHEMA_VERSION : PROJECT_FILE_SCHEMA_VERSION);
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
function checkStructure(db: DatabaseSync, schema: string, kind: DatabaseKind, projectId?: string,
  expected: SchemaManifest = SCHEMA_MANIFEST[kind], storedVersion = expected.version): void {
  if (pragmaValue(db, `${schema}.application_id`) !== APPLICATION_IDS[kind]) throw invalid(kind, 'application-id', projectId);
  const definition = db.prepare(`SELECT sql FROM ${schema}.sqlite_master WHERE type='table' AND name='schema_version'`).get();
  if (definition?.sql !== SCHEMA_VERSION_TABLE_SQL) throw invalid(kind, 'schema-version', projectId);
  const versions = db.prepare(`SELECT max(version) AS version,count(*) AS count FROM ${schema}.schema_version`).get();
  const maximum = Math.max(SUPPORTED_VERSIONS[kind], expected.version);
  if (typeof versions?.version === 'number' && versions.version > maximum) {
    throw projectFileError('PROJECT_FORMAT_NEWER', {...describe(kind, 'format-newer', projectId), formatVersion: versions.version, supportedFormatVersion: maximum});
  }
  if (versions?.count !== 1 || versions.version !== storedVersion) throw invalid(kind, 'schema-version', projectId);
  if (pragmaValue(db, `${schema}.journal_mode`) !== 'delete') throw invalid(kind, 'journal-mode', projectId);
  const {missing, unexpected, changed} = compareManifest(readSchemaManifest(db, schema), expected.entries);
  const differences = [...missing.map(name => `missing ${name}`), ...unexpected.map(name => `unexpected ${name}`), ...changed.map(name => `changed ${name}`)];
  if (differences.length) throw projectFileError('PROJECT_INVALID', {...describe(kind, 'schema', projectId), differences});
}

/** An older history is accepted only for one reviewed version/manifest pair.
 * This merely identifies the transition: no table is changed before the
 * project is attached, locked and checked for external content changes. */
function checkHistoryStructure(db: DatabaseSync, projectId: string, candidate = false): HistoryUpgrade | undefined {
  const definition = db.prepare(`SELECT sql FROM ${HISTORY}.sqlite_master WHERE type='table' AND name='schema_version'`).get();
  const version = definition?.sql === SCHEMA_VERSION_TABLE_SQL
    ? db.prepare(`SELECT max(version) AS version,count(*) AS count FROM ${HISTORY}.schema_version`).get()
    : undefined;
  if (candidate) {
    const current = historyManifestForVersion(FORMAT4_HISTORY_SCHEMA_VERSION)!;
    if (version?.count === 1 && version.version === FORMAT4_INITIAL_HISTORY_MANIFEST.version) {
      const from = FORMAT4_INITIAL_HISTORY_MANIFEST;
      checkStructure(db, HISTORY, 'history', projectId, from);
      return {from, toVersion: current.version, apply: addFormat4ReceiptExpiryInside};
    }
    checkStructure(db, HISTORY, 'history', projectId, current);
    return;
  }
  const upgrade = version?.count === 1 ? HISTORY_UPGRADES.find(candidate => candidate.from.version === version.version && candidate.toVersion === HISTORY_SCHEMA_VERSION) : undefined;
  checkStructure(db, HISTORY, 'history', projectId, upgrade?.from);
  return upgrade;
}

export interface ProjectIdentity extends ContentStamp {
  readonly projectId: string;
}
export interface ProjectFormatIdentity extends ProjectIdentity {
  readonly formatVersion: ProjectFileFormat;
}

function checkProjectStructure(db: DatabaseSync, schema: string, format: ProjectFileFormat, projectId?: string): void {
  const manifest = projectManifestForVersion(format);
  if (!manifest || pragmaValue(db, `${schema}.user_version`) !== format) throw invalid('project', 'schema-version', projectId);
  checkStructure(db, schema, 'project', projectId, manifest);
  if (format === FORMAT4_PROJECT_SCHEMA_VERSION) {
    if (schema !== 'main' && schema !== 'project') throw new TypeError('Invalid project schema');
    assertProjectTimelineGeometryProfile(db, schema, format);
  }
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

function checkProjectVersion(format: unknown, maximum: ProjectFileFormat): ProjectFileFormat {
  if (typeof format === 'number' && format > maximum) {
    throw projectFileError('PROJECT_FORMAT_NEWER', {...describe('project','format-newer'),formatVersion:format,supportedFormatVersion:maximum});
  }
  if (format !== PROJECT_FILE_SCHEMA_VERSION && format !== FORMAT4_PROJECT_SCHEMA_VERSION) throw invalid('project','schema-version');
  return format;
}

const projectFormatMaximum = (format4?: Format4Options): ProjectFileFormat =>
  format4 ? FORMAT4_PROJECT_SCHEMA_VERSION : PROJECT_FILE_SCHEMA_VERSION;

/** Reads the 100-byte SQLite header without SQLite, so a file that is not a
 * project file (history.db and cache.db included) is never opened as one and
 * SQLite never rolls back a journal out of order. */
function checkHeader(projectFile: string, maximum: ProjectFileFormat): ProjectFileFormat {
  const fd = openSync(projectFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw invalid('project', 'not-a-regular-file');
    const header = Buffer.alloc(100);
    const length = readSync(fd, header, 0, header.length, 0);
    if (length < header.length || header.toString('latin1', 0, 16) !== SQLITE_MAGIC || header.readUInt32BE(68) !== PROJECT_FILE_APPLICATION_ID) {
      throw invalid('project', 'not-a-project-file');
    }
    const format = checkProjectVersion(header.readUInt32BE(60), maximum);
    // The file format versions at offsets 18 and 19 are 2 in WAL mode.
    if (header[18] !== 1 || header[19] !== 1) throw invalid('project', 'journal-mode');
    return format;
  } finally {
    closeSync(fd);
  }
}

/** Full preflight without a writable SQLite descriptor. A current header is
 * only a gate: the exact manifest, metadata and native keys still have to pass. */
export function inspectProjectFileReadOnly(requested: string, format4?: Format4Options): ProjectIdentity {
  const {formatVersion: _format, ...identity} = inspectProjectFormatReadOnly(requested, format4);
  return identity;
}

export function inspectProjectFormatReadOnly(requested: string, format4?: Format4Options): ProjectFormatIdentity {
  return inspectProjectFile(requested, projectFormatMaximum(format4));
}

function checkReadableProjectHeader(projectFile: string, before: BigIntStats, maximum: ProjectFileFormat): ProjectFileFormat {
  if (!before.isFile()) throw invalid('project','not-a-regular-file');
  const held = projectFileOwnerKind(identityOf(before,projectFile));
  if (held !== undefined) throw held === 'project' ? projectFileError('PROJECT_LOCKED',describe('project','locked')) : invalid('project','not-a-project-file');
  return checkHeader(projectFile, maximum);
}

/** A bounded hint for the recent-project list. Opening still checks the
 * manifest and content under the normal SQLite admission path. */
export function inspectProjectFormatHeader(requested: string, format4?: Format4Options): ProjectFileFormat {
  const projectFile = path.resolve(requested);
  try {
    return checkReadableProjectHeader(projectFile, lstatSync(projectFile,{bigint:true}), projectFormatMaximum(format4));
  } catch (error) {throw openFailure(error,'project');}
}

function inspectProjectFile(requested: string, maximum: ProjectFileFormat): ProjectFormatIdentity {
  const projectFile = path.resolve(requested);
  let db: DatabaseSync | undefined;
  try {
    const before = lstatSync(projectFile,{bigint:true});
    const formatVersion = checkReadableProjectHeader(projectFile, before, maximum);
    if (isHotJournal(`${projectFile}-journal`)) throw invalid('project','hot-journal');
    db = new DatabaseSync(`${pathToFileURL(projectFile).href}?mode=ro`,{...DATABASE_OPTIONS,readOnly:true});
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA cell_size_check=ON');
    if (pragmaValue(db,'encoding') !== 'UTF-8') throw invalid('project','encoding');
    checkProjectStructure(db, 'main', formatVersion);
    const identity = readProjectIdentity(db,'main');
    if (db.prepare('PRAGMA main.foreign_key_check').get() !== undefined) throw invalid('project','foreign-key',identity.projectId);
    const after = lstatSync(projectFile,{bigint:true});
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw invalid('project','unusable',identity.projectId);
    return {...identity, formatVersion};
  } catch (error) {throw openFailure(error,'project');}
  finally {db?.close();}
}

/** Validate recovery on a disconnected clone. Its journal never names a source
 * super-journal, so SQLite cannot delete or write any original companion. */
function validateRecoveryInIsolation(projectFile: string, maximum: ProjectFileFormat): ProjectFormatIdentity {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-recovery-preflight-'));
  const file = path.join(directory,'project.mioon');
  let db: DatabaseSync | undefined;
  try {
    copyFileSync(projectFile,file);
    copyIsolatedRecoveryJournal(`${projectFile}-journal`,`${file}-journal`);
    db = openDatabase(existingFile(file));
    lock(db);
    const formatVersion = checkProjectVersion(pragmaValue(db, 'user_version'), maximum);
    checkProjectStructure(db, 'main', formatVersion);
    const identity = readProjectIdentity(db,'main');
    if (db.prepare('PRAGMA main.foreign_key_check').get() !== undefined) throw invalid('project','foreign-key');
    return {...identity, formatVersion};
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
  readonly format4?: Format4Options;
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
  const historyVersion = db.prepare('SELECT version FROM main.schema_version').get()?.version;
  for (const table of historyTablesForVersion(Number(historyVersion))) if (!versions.has(table) && db.prepare(`SELECT 1 FROM main."${table}" LIMIT 1`).get()) throw invalid('history','metadata',current.projectId);
  const counter = db.prepare('SELECT bytes,rows FROM main.mio_storage_counters').all();
  if (counter.length !== 1 || counter[0].bytes !== 0 || counter[0].rows !== 1) throw invalid('history','metadata',current.projectId);
}
export function openStagedProjectConnection(options: StagedProjectConnectionOptions): ProjectConnection {
  const historyFile = path.resolve(options.historyFile), localDir = path.resolve(options.location.localDir);
  if (path.dirname(historyFile) !== localDir || !/^history\.staged-[a-f0-9-]{36}\.db$/u.test(path.basename(historyFile))
    || !Number.isSafeInteger(options.expectedStamp.contentSequence) || options.expectedStamp.contentSequence < 0 || !isContentToken(options.expectedStamp.contentToken)
    || options.resolution && (!isProjectId(options.resolution.requestId) || !/^[a-f0-9]{64}$/u.test(options.resolution.digest))) throw new TypeError('Invalid staged history identity');
  return openConnection({projectFile:options.projectFile,locate:()=>options.location,format4:options.format4},{...options,historyFile});
}

interface AttachedDatabases {
  readonly db: DatabaseSync;
  readonly historyState: ProjectHistoryState;
  readonly historyAdmission: ProjectHistoryAdmission;
  readonly held: readonly HeldFile[];
  readonly backupDescriptors: readonly number[];
  readonly historyIdentity: {readonly directory: string; readonly db: string; readonly birthtimeMs: number};
}

/** Steps 2 and 3: the local records as main (locked, checked or found empty),
 * then the project file and the cache attached, locked and checked; the local
 * records of a new project are built only after that, then the connection's
 * temporary triggers. */
function upgradeRequired(preview: Format4UpgradePreview): AppError {
  return new AppError('PROJECT_FORMAT_UPGRADE_REQUIRED', '请确认升级项目格式。升级前将保留旧格式备份。', 409, {
    ...preview, targetProjectVersion: FORMAT4_PROJECT_SCHEMA_VERSION, targetHistoryVersion: FORMAT4_HISTORY_SCHEMA_VERSION,
  });
}

function observeUpgrade(db: DatabaseSync, options: Format4Options, phase: Format4UpgradeBoundary): void {
  if (!options.onUpgradeBoundary) return;
  options.onUpgradeBoundary(phase, Object.freeze({
    projectVersion: Number(db.prepare('SELECT version FROM project.schema_version').get()?.version),
    historyVersion: Number(db.prepare('SELECT version FROM main.schema_version').get()?.version),
  }));
}

/** Open before SQLite takes the source lock. Closing an additional file
 * descriptor while the native handle is live can release POSIX locks. */
function pinBackupDescriptor(file: string, key: string, database: 'history' | 'project'): number {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd, {bigint: true});
    if (!stat.isFile() || identityOf(stat, file) !== key) throw invalid(database, 'unusable');
    return fd;
  } catch (error) {closeSync(fd); throw error;}
}

export interface Format4RestoreLockInput {
  readonly file: string;
  readonly database: DatabaseKind;
  readonly identity: BigIntStats;
}

/** Lock every admitted inode, including staged files that will be renamed
 * into service. Pin byte-copy descriptors before taking any native lock. */
export function withFormat4RestoreLocks<T>(inputs: readonly Format4RestoreLockInput[],
  run: (files: ReadonlyMap<string, {readonly db: DatabaseSync; readonly fd: number}>) => T): T {
  const keys = inputs.map(({file, identity}) => identityOf(identity, file));
  if (new Set(keys).size !== keys.length) throw invalid('project', 'unusable');
  const descriptors = new Map<string, number>();
  const handles = new Map<string, {db: DatabaseSync; fd: number}>();
  const registered: {db: DatabaseSync; files: readonly HeldFile[]}[] = [];
  let active: DatabaseKind = 'project';
  try {
    for (const [index, {file, database, identity}] of inputs.entries()) {
      active = database;
      if (projectFileOwnerKind(keys[index]!) !== undefined ||
        isAppLibraryHeld({dev: String(identity.dev), ino: String(identity.ino)})) throw projectFileError('PROJECT_LOCKED', describe(database, 'locked'));
      if (!identity.isFile() || identity.nlink !== 1n) throw invalid(database, 'not-a-regular-file');
      const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      descriptors.set(file, fd);
      const actual = fstatSync(fd, {bigint: true});
      if (!actual.isFile() || identityOf(actual, file) !== keys[index] || actual.nlink !== 1n ||
        actual.size !== identity.size || actual.mtimeNs !== identity.mtimeNs || actual.ctimeNs !== identity.ctimeNs ||
        actual.birthtimeNs !== identity.birthtimeNs) throw invalid(database, 'unusable');
    }
    for (const [index, {file, database, identity}] of inputs.entries()) {
      active = database;
      const db = openDatabase(existingFile(file));
      handles.set(file, {db, fd: descriptors.get(file)!});
      lock(db);
      const actual = lstatSync(file, {bigint: true});
      if (identityOf(actual, file) !== keys[index] || actual.size !== identity.size || actual.mtimeNs !== identity.mtimeNs || actual.ctimeNs !== identity.ctimeNs ||
        actual.birthtimeNs !== identity.birthtimeNs) throw invalid(database, 'unusable');
      const files = [[keys[index]!, database]] as const;
      registerProjectFiles(db, files, false);
      registered.push({db, files});
    }
  } catch (error) {
    try { close(); } finally { throw openFailure(error, active); }
  }
  try { return run(handles); } finally { close(); }

  function close(): void {
    try {
      for (const {db} of handles.values()) db.close();
    } finally {
      for (const {db, files} of registered) releaseProjectFiles(db, files);
      for (const fd of descriptors.values()) closeSync(fd);
    }
  }
}

/** Restore admits exact source profiles without opening the project as a
 * store. A manually restored v3 project may still have candidate local records. */
export function inspectLockedFormat4RestoreSource(db: DatabaseSync, database: 'project' | 'history', projectId: string): ProjectFormatIdentity | null {
  if (pragmaValue(db, 'encoding') !== 'UTF-8') throw invalid(database, 'encoding', projectId);
  if (database === 'project') {
    const formatVersion = checkProjectVersion(pragmaValue(db, 'user_version'), FORMAT4_PROJECT_SCHEMA_VERSION);
    checkProjectStructure(db, 'main', formatVersion, projectId);
    const identity = readProjectIdentity(db, 'main');
    if (identity.projectId !== projectId) throw invalid(database, 'project-mismatch', projectId);
    return {...identity, formatVersion};
  }
  checkHistoryStructure(db, projectId, true);
  const row = db.prepare('SELECT projectId FROM main.history_state WHERE singleton=1').get();
  if (row?.projectId !== projectId) throw invalid(database, 'project-mismatch', projectId);
  return null;
}

export function clearLockedFormat4RestoreCache(db: DatabaseSync): void {
  if (isEmpty(db, 'main')) return;
  checkStructure(db, 'main', 'cache');
  inTransaction(db, () => db.exec('DELETE FROM previs_thumbnails; DELETE FROM waveform_cache'));
}

function attachDatabases(
  projectFile: string, projectKey: string, identity: ProjectFormatIdentity, historyFile: string, cacheFile: string,
  staged?: StagedProjectConnectionOptions, format4?: Format4Options, approvedWithoutHistory?: Format4UpgradePreview,
): AttachedDatabases {
  const {projectId} = identity;
  let database: DatabaseKind = 'history';
  let opened: DatabaseSync | undefined;
  const opening: HeldFile[] = [];
  const backupDescriptors: number[] = [];
  const oldProject = identity.formatVersion === PROJECT_FILE_SCHEMA_VERSION;
  const mayUpgrade = Boolean(format4 && oldProject && !staged);
  try {
    if (!isRegularFileOrMissing(historyFile)) throw invalid('history', 'not-a-regular-file', projectId);
    const priorHistory = lstatSync(historyFile, {bigint: true, throwIfNoEntry: false});
    if (priorHistory && projectFileOwnerKind(identityOf(priorHistory, historyFile)) !== undefined) throw projectFileError('PROJECT_LOCKED', describe('history', 'locked', projectId));
    const historySource = mayUpgrade && priorHistory && priorHistory.size > 0n
      ? pinBackupDescriptor(historyFile, identityOf(priorHistory, historyFile), 'history') : undefined;
    if (historySource !== undefined) backupDescriptors.push(historySource);
    if (!staged) assertNoFormat4Restore(path.dirname(historyFile), projectId);
    const db = openDatabase(historyFile);
    opened = db;
    lock(db);
    const historyKey = identityOf(lstatSync(historyFile, {bigint: true}), historyFile);
    if (priorHistory && historyKey !== identityOf(priorHistory, historyFile)) throw invalid('history', 'unusable', projectId);
    const fresh = isEmpty(db, HISTORY);
    let upgrade: HistoryUpgrade | undefined;
    if (!fresh) {
      if (pragmaValue(db, 'encoding') !== 'UTF-8') throw invalid('history', 'encoding', projectId);
      upgrade = checkHistoryStructure(db, projectId, identity.formatVersion === FORMAT4_PROJECT_SCHEMA_VERSION);
      const states = db.prepare(`SELECT projectId,seenContentSequence FROM ${HISTORY}.history_state`).all();
      if (states.length !== 1 || typeof states[0].seenContentSequence !== 'number') throw invalid('history', 'metadata', projectId);
      if (states[0].projectId !== projectId) throw invalid('history', 'project-mismatch', projectId);
    }
    database = 'project';
    const projectSource = mayUpgrade ? pinBackupDescriptor(projectFile, projectKey, 'project') : undefined;
    if (projectSource !== undefined) backupDescriptors.push(projectSource);
    db.prepare(`ATTACH DATABASE ? AS ${PROJECT}`).run(existingFile(projectFile));
    lock(db);
    if (!staged) assertNoFormat4Restore(path.dirname(historyFile), projectId);
    if (identityOf(lstatSync(projectFile, {bigint: true}), projectFile) !== projectKey) throw projectFileMovedError(projectId);
    // Checked again under this connection's lock: the file was unlocked since step 1.
    checkProjectStructure(db, PROJECT, identity.formatVersion, projectId);
    const current = readProjectIdentity(db, PROJECT);
    if (current.projectId !== projectId) throw invalid('project', 'project-mismatch', projectId);
    // Token-bearing histories must pass admission before an upgrade (or cache
    // rebuild) can publish any change. Older profiles acquire a nullable token
    // inside their reviewed transition and are checked in that transaction.
    const admission = !fresh && (!upgrade || upgrade.from.version >= 8) ? classifyHistoryStamp(db, false) : undefined;
    // A legacy history without a token first takes the existing history-only
    // transition and stays diverged until the user resolves that admission.
    const changeFormat = mayUpgrade && (fresh || admission?.state === 'current');
    const historySourceManifest = fresh ? undefined : upgrade?.from ?? SCHEMA_MANIFEST.history;
    const historySourceVersion = historySourceManifest?.version ?? HISTORY_SCHEMA_VERSION;
    const verifySources = () => {
      if (identityOf(lstatSync(projectFile, {bigint: true}), projectFile) !== projectKey) throw projectFileMovedError(projectId);
      if (identityOf(lstatSync(historyFile, {bigint: true}), historyFile) !== historyKey) throw invalid('history', 'unusable', projectId);
    };
    if (changeFormat && format4) {
      if (projectSource === undefined) throw invalid('project', 'unusable', projectId);
      verifySources();
      if (!sameContentStamp(identity, current)) throw invalid('project', 'metadata', projectId);
      assertProjectTimelineGeometryProfile(db, PROJECT, PROJECT_FILE_SCHEMA_VERSION);
      const preview: Format4UpgradePreview = Object.freeze({...current, projectVersion: PROJECT_FILE_SCHEMA_VERSION, historyVersion: historySourceManifest?.version ?? null});
      // A callback may make a reentrant read. A second descriptor's close
      // would release the native locks on POSIX even before the store exists.
      opening.push([projectKey, 'project'], [historyKey, 'history']);
      registerProjectFiles(db, opening, false);
      if (approvedWithoutHistory) {
        if (!fresh || !sameContentStamp(preview, approvedWithoutHistory)) throw upgradeRequired(preview);
      } else if (format4.approveUpgrade?.(preview) !== true) throw upgradeRequired(preview);
      verifySources();
      configure(db, HISTORY);
      configure(db, PROJECT);
      // A previously absent companion must already be a complete empty v10
      // history when the migration begins. After a failed backup or a killed
      // upgrade, read-only copy must not mistake our empty SQLite file for a
      // corrupt user's history. The pre-upgrade backup records its absence.
      if (fresh) inTransaction(db, () => {
        buildDatabase(db, 'history', HISTORY);
        db.prepare('INSERT INTO main.history_state VALUES(1,?,?,?)').run(projectId, current.contentSequence, current.contentToken);
        checkStructure(db, HISTORY, 'history', projectId, historyManifestForVersion(HISTORY_SCHEMA_VERSION));
      });
      createFormat4UpgradeBackup(db, path.dirname(historyFile), current, {project: projectSource, history: historySource}, historySourceManifest);
      verifySources();
    }
    database = 'cache';
    attachCache(db, cacheFile);
    if (opening.length) {
      const cacheKey = identityOf(lstatSync(cacheFile, {bigint: true}), cacheFile);
      opening.push([cacheKey, 'cache']);
      registerProjectFiles(db, opening, false);
    }
    for (const [schema, kind] of [[HISTORY, 'history'], [PROJECT, 'project'], [CACHE, 'cache']] as const) {
      database = kind;
      configure(db, schema);
    }
    // Mio accounting needs DELETE triggers for REPLACE's implicit old row.
    // The kernel's trigger writes are acyclic; legacy workspace/app openers
    // do not share this connection setting.
    db.exec('PRAGMA recursive_triggers=ON');
    database = 'history';
    const useFormat4 = !oldProject || changeFormat;
    if (changeFormat && format4) {
      inTransaction(db, () => {
        verifySources();
        if (fresh) clearProjectProcessRevisions(db, projectId);
        if (upgrade) {
          upgrade.apply(db);
          checkStructure(db, HISTORY, 'history', projectId, historyManifestForVersion(HISTORY_SCHEMA_VERSION), historySourceVersion);
        }
        addFormat4ProjectStructureInside(db, PROJECT);
        addFormat4HistoryStructureInside(db, historySourceVersion);
        observeUpgrade(db, format4, 'before-version-write');
        writeFormat4ProjectVersionInside(db, PROJECT);
        writeFormat4HistoryVersionInside(db, historySourceVersion);
        checkProjectStructure(db, PROJECT, FORMAT4_PROJECT_SCHEMA_VERSION, projectId);
        checkHistoryStructure(db, projectId, true);
        if (foreignKeyCheck(db).length !== 0) throw invalid('history', 'foreign-key', projectId);
        if (classifyHistoryStamp(db, false).state !== 'current' || !sameContentStamp(readProjectContentStamp(db), current)) throw invalid('history', 'metadata', projectId);
        observeUpgrade(db, format4, 'before-commit');
        verifySources();
      });
      observeUpgrade(db, format4, 'after-commit');
      verifySources();
    } else if (upgrade && useFormat4) {
      if (!admission) throw invalid('history', 'metadata', projectId);
      inTransaction(db, () => {
        verifySources();
        const from = checkHistoryStructure(db, projectId, true);
        if (from?.from !== upgrade.from) throw invalid('history', 'schema-version', projectId);
        upgrade.apply(db);
        if (format4) observeUpgrade(db, format4, 'before-version-write');
        writeFormat4HistoryVersionInside(db, upgrade.from.version);
        checkStructure(db, HISTORY, 'history', projectId, historyManifestForVersion(FORMAT4_HISTORY_SCHEMA_VERSION));
        checkProjectStructure(db, PROJECT, identity.formatVersion, projectId);
        if (foreignKeyCheck(db).length !== 0) throw invalid('history', 'foreign-key', projectId);
        const nextAdmission = classifyHistoryStamp(db, false);
        if (nextAdmission.state !== admission.state || !sameContentStamp(nextAdmission.file, current) ||
          nextAdmission.seen.contentSequence !== admission.seen.contentSequence ||
          nextAdmission.seen.contentToken !== admission.seen.contentToken) throw invalid('history', 'metadata', projectId);
        if (format4) observeUpgrade(db, format4, 'before-commit');
        verifySources();
      });
      if (format4) observeUpgrade(db, format4, 'after-commit');
      verifySources();
    } else if (upgrade) {
      const transition = upgrade;
      inTransaction(db, () => {
        transition.apply(db);
        classifyHistoryStamp(db, false);
        db.exec(`UPDATE ${HISTORY}.schema_version SET version=${transition.toVersion}`);
        checkStructure(db, HISTORY, 'history', projectId);
        checkProjectStructure(db, PROJECT, identity.formatVersion, projectId);
      });
    } else if (fresh) {
      inTransaction(db, () => {
        const historyVersion = useFormat4 ? FORMAT4_HISTORY_SCHEMA_VERSION : HISTORY_SCHEMA_VERSION;
        buildDatabase(db, 'history', HISTORY, undefined, historyVersion);
        db.prepare(`INSERT INTO ${HISTORY}.history_state VALUES(1,?,?,?)`).run(projectId, current.contentSequence,current.contentToken);
        if (!staged) clearProjectProcessRevisions(db, projectId);
        checkStructure(db, HISTORY, 'history', projectId, historyManifestForVersion(historyVersion));
        checkProjectStructure(db, PROJECT, identity.formatVersion, projectId);
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
    installCrossFileTriggers(db, useFormat4);
    if (historyAdmission.state === 'diverged') installDivergedWriteGuards(db);
    else {
      openProjectJournal(db);
      // Persist the generation before any client can read it. A staged
      // replacement stays empty until its first ordinary writable open.
      if (useFormat4 && !staged && !db.prepare('SELECT 1 FROM main.canvas_receipt_window WHERE singleton=1').get()) {
        database = 'history';
        inTransaction(db, () => {
          verifySources();
          db.prepare('INSERT INTO main.canvas_receipt_window(singleton,epoch,floor) VALUES(1,?,0)')
            .run(randomBytes(16).toString('hex'));
          verifySources();
        });
      }
    }
    const held: readonly HeldFile[] = [
      [projectKey, 'project'],
      [historyKey, 'history'],
      [identityOf(lstatSync(cacheFile, {bigint: true}), cacheFile), 'cache'],
    ];
    // Native open() would reopen only main, losing the attached databases,
    // exclusive locks and TEMP constraints while reviving this DB identity.
    Object.defineProperty(db, 'open', {value: (): never => {
      throw new TypeError('Reopen project databases through openProjectConnection or openProjectStore, not db.open().');
    }});
    const directory = validatePrivateDirectory(path.dirname(historyFile));
    const history = validateManagedFile(historyFile, {root: path.dirname(historyFile)});
    if (!directory || !history) throw invalid('history', 'unusable', projectId);
    if (history.ino && `${history.dev}:${history.ino}` !== held[1]![0]) throw invalid('history', 'unusable', projectId);
    return {db, held, backupDescriptors, historyIdentity: {directory: privateStorageIdentity(directory), db: privateStorageIdentity(history), birthtimeMs: history.birthtimeMs}, historyState: historyAdmission.state, historyAdmission};
  } catch (error) {
    try { opened?.close(); } catch {}
    finally {
      for (const fd of backupDescriptors) closeSync(fd);
      if (opened && opening.length) releaseProjectFiles(opened, opening);
    }
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
function openConnection({projectFile: requested, locate, checkCopy, format4}: OpenProjectConnectionOptions, staged?: StagedProjectConnectionOptions): ProjectConnection {
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
    const recovery = recoverProjectFile(projectFile, format4);
    if (recovery.state === 'invalid') throw invalid('project',recovery.reason);
    if (recovery.state === 'locked') throw projectFileError('PROJECT_LOCKED',describe('project','locked'));
    if (recovery.state === 'access-denied') throw projectFileError('PROJECT_ACCESS_DENIED',describe('project','access-denied'));
  }
  const identity = inspectProjectFormatReadOnly(projectFile, format4);
  checkCopy?.({projectId: identity.projectId, projectFile});
  const location = locate(identity.projectId);
  const localDir = path.resolve(location.localDir), cacheDir = path.resolve(location.cacheDir), tempDir = path.resolve(location.tempDir);
  assertNoFormat4Restore(localDir, identity.projectId);
  if (!staged && lstatSync(path.join(localDir,'history-switch-active.json'),{throwIfNoEntry:false})) throw new AppError('PROJECT_HISTORY_SWITCH_PENDING','本机记录切换尚未完成。',409,{projectId:identity.projectId});
  const historyFile = staged?.historyFile ?? path.join(localDir, PROJECT_HISTORY_FILE);
  let approvedWithoutHistory: Format4UpgradePreview | undefined;
  if (format4 && !staged && identity.formatVersion === PROJECT_FILE_SCHEMA_VERSION && !lstatSync(historyFile, {throwIfNoEntry: false})) {
    const {formatVersion, ...project} = identity;
    const preview: Format4UpgradePreview = Object.freeze({...project, projectVersion: formatVersion, historyVersion: null});
    if (format4.approveUpgrade?.(preview) !== true) throw upgradeRequired(preview);
    approvedWithoutHistory = preview;
  }
  for (const directory of [localDir, cacheDir, tempDir]) ensurePrivateDirectory(directory, {create: true});
  const {db, held: files, backupDescriptors, historyState, historyAdmission, historyIdentity} = attachDatabases(projectFile, projectKey, identity, historyFile, path.join(cacheDir, PROJECT_CACHE_FILE), staged, format4, approvedWithoutHistory);
  const {directory: directoryIdentity, db: historyFileIdentity, birthtimeMs: historyBirthtime} = historyIdentity;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { db.close(); }
    finally {
      try { for (const fd of backupDescriptors) closeSync(fd); }
      finally { releaseProjectFiles(db, files); }
    }
  };
  registerProjectFiles(db, files);
  try { removeUnusedSuperJournals(localDir); }
  catch (error) { close(); throw error; }
  return {
    db, projectId: identity.projectId, projectFile, projectDir: path.dirname(projectFile), localDir, cacheDir, tempDir, historyState, historyAdmission,
    throwIfMoved(): void {
      if (movedAlone(projectFile, projectKey)) throw projectFileMovedError(identity.projectId);
    },
    historyIdentity() {
      if (closed || !db.isOpen) throw new TypeError('The project connection is closed');
      if (movedAlone(projectFile, projectKey)) throw projectFileMovedError(identity.projectId);
      const directory = validatePrivateDirectory(localDir);
      const history = validateManagedFile(historyFile, {root: localDir});
      if (!directory || !history || privateStorageIdentity(directory) !== directoryIdentity
        || privateStorageIdentity(history) !== historyFileIdentity || history.birthtimeMs !== historyBirthtime) {
        throw Object.assign(new Error('The held history identity changed'), {code: 'PROJECT_HISTORY_IDENTITY_CHANGED'});
      }
      return {directory, db: history};
    },
    close,
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
 * - `access-denied`: the OS refused access; not missing or damaged;
 * - `invalid`: not something to recover, with the PROJECT_INVALID reason the
 *   open would report, such as `not-a-project-file` or `read-only`. Only a
 *   path that is not a regular file, or a file with a hot journal beside it,
 *   is found invalid here; any other file is `clean` until it is opened. */
export type ProjectFileRecovery =
  | {readonly state: 'clean' | 'recovered' | 'locked' | 'open-here' | 'missing' | 'access-denied'}
  | {readonly state: 'invalid'; readonly reason: ProjectInvalidReason};

const recoveryOf = (error: unknown): ProjectFileRecovery => {
  const failure = openFailure(error, 'project');
  if (failure.code === 'PROJECT_LOCKED') return {state: 'locked'};
  if (failure.code === 'PROJECT_MISSING') return {state: 'missing'};
  if (failure.code === 'PROJECT_ACCESS_DENIED') return {state: 'access-denied'};
  const {reason} = failure.details as ProjectFileErrorDetails;
  return {state: 'invalid', reason: reason === 'missing' || reason === 'locked' || reason === 'format-newer' || reason === 'exists' || reason === 'access-denied' ? 'unusable' : reason};
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
 * (none, 0 bytes, or a zero first byte) nothing of the project file is read by
 * recovery. A newer header beside a hot journal raises PROJECT_FORMAT_NEWER
 * before replay. */
export function recoverProjectFile(requested: string, format4?: Format4Options): ProjectFileRecovery {
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
    const maximum = projectFormatMaximum(format4);
    checkHeader(projectFile, maximum);
    const before = lstatSync(projectFile,{bigint:true});
    const recovered = validateRecoveryInIsolation(projectFile, maximum);
    const after = lstatSync(projectFile,{bigint:true});
    if (before.dev!==after.dev || before.ino!==after.ino || before.size!==after.size || before.mtimeNs!==after.mtimeNs) throw invalid('project','unusable');
    db = openDatabase(existingFile(projectFile));
    lock(db);
    checkProjectStructure(db, 'main', recovered.formatVersion);
    if (!sameContentStamp(readProjectIdentity(db,'main'),recovered)) throw invalid('project','metadata');
    return {state: 'recovered'};
  } catch (error) {
    if (error instanceof AppError && error.code === 'PROJECT_FORMAT_NEWER') throw error;
    return recoveryOf(error);
  } finally {
    db?.close();
  }
}
