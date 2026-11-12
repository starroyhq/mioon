import {randomUUID} from 'node:crypto';
import {chmodSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, readSync, renameSync, rmSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import path from 'node:path';
import {backup, DatabaseSync} from 'node:sqlite';
import {createPrivateTemporaryDirectory, ensurePrivateDirectory, validateManagedFile} from '@mioon/contracts/private-storage';
import {AppError} from '../../../contracts/src/app-error.ts';
import {isProjectId, PROJECT_DATABASE_NAMES} from '../../../contracts/src/project-file.ts';
import {isProjectFileHeld} from './held-files.ts';
import {isAppLibraryHeld} from '../app-db/connection.ts';
import {projectFileError} from './errors.ts';
import {PROJECT_FILE_APPLICATION_ID, SCHEMA_VERSION_TABLE_SQL} from './schema/databases.ts';
import type {ProjectFileFormat} from './schema/databases.ts';
import {projectManifestForVersion} from './schema/format-manifests.ts';
import {assertProjectTimelineGeometryProfile} from './schema/format4-geometry.ts';
import {compareManifest, readSchemaManifest} from './schema/manifest-check.ts';
import {isProjectStore} from './store.ts';
import type {ProjectStore} from './store.ts';

/** 'MioB': copied project content, deliberately not an openable project. */
export const PROJECT_BACKUP_APPLICATION_ID = 0x4d696f42;

export interface ProjectBackupIdentity {
  readonly projectId: string;
  readonly contentSequence: number;
  readonly contentToken: string;
  readonly formatVersion: ProjectFileFormat;
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
function checkHeader(file: string, applicationId: number) {
  const info = lstatSync(file, {bigint: true});
  if (!info.isFile() || info.nlink !== 1n) throw invalid('not-a-regular-single-link-file');
  const identity = {dev: String(info.dev), ino: String(info.ino)};
  if (isProjectFileHeld(identity) || isAppLibraryHeld(identity)) throw invalid('held-database');
  // A read-only connection must not reinterpret uncertain journal pages or
  // create sidecars. Unknown formats are rejected before SQLite sees the file.
  for (const suffix of ['-journal','-wal','-shm']) {
    const sidecar=lstatSync(file+suffix,{throwIfNoEntry:false});
    if(sidecar && (sidecar.size>0 || !sidecar.isFile()))throw invalid('journal');
  }
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
    const formatVersion = header.readUInt32BE(60);
    if(!projectManifestForVersion(formatVersion))throw invalid('format');
    return {formatVersion,sizeBytes:Number(actual.size),generation:[actual.dev,actual.ino,actual.size,actual.mtimeNs,actual.ctimeNs].join(':')};
  } finally { closeSync(fd); }
}

/** Exact project profile for either known format; MioB differs only in its marker. */
export function readCopiedProjectIdentity(db: DatabaseSync, applicationId: number, sizeBytes: number, schema: 'main' | 'project' = 'main'): ProjectBackupIdentity {
  if (schema !== 'main' && schema !== 'project') throw new TypeError('A copied project requires a fixed schema name');
  const qualifier = schema === 'main' ? '' : 'project.';
  const profile = (name: string) => pragma(db, qualifier + name);
  if (profile('application_id') !== applicationId || profile('encoding') !== 'UTF-8' || profile('journal_mode') !== 'delete') throw invalid('profile');
  const formatVersion = profile('user_version');
  if (formatVersion !== 3 && formatVersion !== 4) throw invalid('format');
  const expected = projectManifestForVersion(formatVersion);
  if (!expected || db.prepare(`SELECT sql FROM ${schema}.sqlite_schema WHERE type='table' AND name='schema_version'`).get()?.sql !== SCHEMA_VERSION_TABLE_SQL) throw invalid('format');
  const versions = db.prepare(`SELECT version FROM ${schema}.schema_version`).all();
  if (versions.length !== 1 || versions[0].version !== formatVersion) throw invalid('format');
  const diff = compareManifest(readSchemaManifest(db, schema), expected.entries);
  if (diff.changed.length || diff.missing.length || diff.unexpected.length) throw invalid('schema');
  const rows = db.prepare(`SELECT singleton,projectId,contentSequence,contentToken FROM ${schema}.project_file`).all(), row = rows[0];
  if (rows.length !== 1 || row.singleton !== 1 || !isProjectId(row.projectId) || typeof row.contentSequence !== 'number'
    || !Number.isSafeInteger(row.contentSequence) || row.contentSequence < 0 || typeof row.contentToken!=='string' || !/^[a-f0-9]{32}$/u.test(row.contentToken)) throw invalid('metadata');
  const projects = db.prepare(`SELECT id,data FROM ${schema}.projects LIMIT 2`).all();
  if (projects.length > 1 || projects.length === 1 && projects[0].id !== row.projectId) throw invalid('project-row');
  if (profile('quick_check') !== 'ok' || db.prepare(`PRAGMA ${qualifier}foreign_key_check`).get() !== undefined) throw invalid('integrity');
  try { assertProjectTimelineGeometryProfile(db, schema, formatVersion); }
  catch (error) { throw invalid('geometry', error); }
  let name: string | null = null;
  if (projects.length) {
    try {
      const data: unknown = JSON.parse(String(projects[0].data));
      if (data !== null && typeof data === 'object' && 'name' in data && typeof data.name === 'string') name = data.name;
    } catch { throw invalid('project-data'); }
  }
  return Object.freeze({projectId: row.projectId, contentSequence: row.contentSequence, contentToken:row.contentToken, formatVersion, name, sizeBytes});
}

function openReadOnly(file: string, applicationId: number): ProjectBackupReader {
  let db: DatabaseSync | undefined;
  try {
    const before = checkHeader(file, applicationId);
    db = new DatabaseSync(file, options);
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA cell_size_check=ON');
    const identity = readCopiedProjectIdentity(db, applicationId, before.sizeBytes), database = db;
    if (identity.formatVersion !== before.formatVersion) throw invalid('file-changed');
    const after=lstatSync(file,{bigint:true});
    if(!after.isFile() || after.nlink!==1n || [after.dev,after.ino,after.size,after.mtimeNs,after.ctimeNs].join(':')!==before.generation)throw invalid('file-changed');
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

/** Portable project directories may be on exFAT. They must be real
 * directories, but are not application-private storage with mandatory 0700. */
export function validateProjectCopyStagingDirectory(directory:string):BigIntStats {
 const absolute=path.resolve(directory),root=path.parse(absolute).root;
 let current=root,info=lstatSync(root,{bigint:true});
 for(const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)){
  current=path.join(current,segment);info=lstatSync(current,{bigint:true});
  if(!info.isDirectory()||info.isSymbolicLink())throw new AppError('PROJECT_LOCATION_INVALID','项目位置不能经过符号链接或非目录。',400);
 }
 if(!info.isDirectory())throw new AppError('PROJECT_LOCATION_INVALID','项目位置不是目录。',400);
 return info;
}
export function createProjectCopyStagingDirectory(parent:string,prefix='project-copy-'):string {
 if(!/^\.?[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(prefix))throw new TypeError('Invalid project staging prefix');
 validateProjectCopyStagingDirectory(parent);
 const created=mkdtempSync(path.join(path.resolve(parent),prefix));
 try{
  try{chmodSync(created,0o700);}catch(error){if(!['EPERM','ENOTSUP','EOPNOTSUPP'].includes(String((error as {code?:unknown})?.code)))throw error;}
  validateProjectCopyStagingDirectory(created);return created;
 }catch(error){rmSync(created,{recursive:true,force:true});throw error;}
}
export interface ProjectCopyPlaceholder {readonly dev:string;readonly ino:string}
export interface PublishProjectCopyOptions {
 readonly onPlaceholder?:(identity:ProjectCopyPlaceholder)=>void;
 readonly onPublished?:()=>void;
}
/** S5 publication only. V2's established hard-link failure contract remains
 * in publishCopiedFile. The coordinator accepts the metadata-check/rename
 * gap on volumes without links; no stronger inode CAS is claimed here. */
export function publishProjectCopyFile(temporary:string,destination:string,options:PublishProjectCopyOptions={}):void {
 if(path.resolve(temporary)===path.resolve(destination))throw new TypeError('A project publication needs a distinct stage');
 validateProjectCopyStagingDirectory(path.dirname(destination));
 let placeholder:ProjectCopyPlaceholder|undefined,published=false;
 try{
  try{linkSync(temporary,destination);published=true;}
  catch(error){
   const code=(error as {code?:unknown})?.code;
   if(code==='EEXIST')throw projectFileError('PROJECT_FILE_EXISTS',{database:'project',reason:'exists'});
   if(!['EPERM','ENOTSUP','EOPNOTSUPP','ENOSYS','EXDEV'].includes(String(code)))throw error;
   let fd:number;
   try{fd=openSync(destination,'wx',0o600);}
   catch(failure){
    const why=(failure as {code?:unknown})?.code;
    if(why==='EEXIST')throw projectFileError('PROJECT_FILE_EXISTS',{database:'project',reason:'exists'});
    if(['ENOTSUP','EOPNOTSUPP','ENOSYS'].includes(String(why)))throw new AppError('PROJECT_COPY_UNSUPPORTED_FILESYSTEM','目标卷不能安全发布项目文件。',409);
    throw failure;
   }
   try{const info=fstatSync(fd,{bigint:true});placeholder={dev:String(info.dev),ino:String(info.ino)};fsyncSync(fd);}finally{closeSync(fd);}
   options.onPlaceholder?.(placeholder);
   syncCopiedDirectory(path.dirname(destination));
   const current=lstatSync(destination,{bigint:true,throwIfNoEntry:false});
   if(!current?.isFile()||current.isSymbolicLink()||String(current.dev)!==placeholder.dev||String(current.ino)!==placeholder.ino)
    throw projectFileError('PROJECT_FILE_EXISTS',{database:'project',reason:'exists'});
   renameSync(temporary,destination);published=true;
  }
  options.onPublished?.();syncCopiedDirectory(path.dirname(destination));
 }catch(error){
  if(placeholder&&!published){
   const current=lstatSync(destination,{bigint:true,throwIfNoEntry:false});
   if(current?.isFile()&&String(current.dev)===placeholder.dev&&String(current.ino)===placeholder.ino){rmSync(destination);syncCopiedDirectory(path.dirname(destination));}
  }
  throw error;
 }
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
