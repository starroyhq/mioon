import {createHash, randomUUID} from 'node:crypto';
import {closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readSync, renameSync, rmdirSync, unlinkSync, writeFileSync, writeSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createPrivateTemporaryDirectory, ensurePrivateDirectory, readPrivateFile, validateManagedFile, validatePrivateDirectory} from '@mioon/contracts/private-storage';
import {AppError} from '../../../contracts/src/app-error.ts';
import {isProjectId} from '../../../contracts/src/project-file.ts';
import type {ContentStamp} from '../../../contracts/src/project-file.ts';
import {isAppLibraryHeld} from '../app-db/connection.ts';
import {isContentToken, sameContentStamp, readProjectContentStamp} from './content-stamp.ts';
import {isProjectFileHeld} from './held-files.ts';
import {HISTORY_APPLICATION_ID, PROJECT_FILE_APPLICATION_ID} from './schema/databases.ts';
import {FORMAT3_RELEASE_MANIFEST} from './schema/format3-manifest.ts';
import {HISTORY_UPGRADES} from './schema/history-upgrades.ts';
import {compareManifest, readSchemaManifest} from './schema/manifest-check.ts';
import type {SchemaManifest} from './schema/manifest-check.ts';

export const FORMAT_UPGRADE_BACKUP_DIRECTORY = 'format-upgrade-backups';
export const FORMAT_UPGRADE_BACKUP_LIMIT = 3;
const MANIFEST_FILE = 'manifest.json';
const PROJECT_FILE = 'project.mioon';
const HISTORY_FILE = 'history.db';
const PENDING_DIRECTORY = /^\.pending-[a-z0-9]{6}$/iu;
const RETIRED_PREFIX = '.pending-prune-';
export const FORMAT4_RESTORE_ACTIVE = 'format4-restore-active.json';

interface BackupIdentity extends ContentStamp {
  readonly projectId: string;
}

export interface Format4BackupFile {
  readonly name: typeof PROJECT_FILE | typeof HISTORY_FILE;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface Format4BackupManifest extends BackupIdentity {
  readonly version: 1;
  readonly projectVersion: number;
  readonly historyPresent: boolean;
  readonly historyVersion: number | null;
  readonly files: readonly Format4BackupFile[];
}

const invalid = (): AppError => new AppError('PROJECT_FORMAT_BACKUP_FAILED', '无法保留已校验的旧格式备份。', 409);
const value = (db: DatabaseSync, sql: string): unknown => Object.values(db.prepare(sql).get() ?? {})[0];
const historySchema = (version: unknown): SchemaManifest | undefined => version === FORMAT3_RELEASE_MANIFEST.history.version
  ? FORMAT3_RELEASE_MANIFEST.history
  : HISTORY_UPGRADES.find(upgrade => upgrade.from.version >= 8 && upgrade.from.version === version)?.from;

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, minimum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;

function backupFile(value: unknown, name: Format4BackupFile['name']): Format4BackupFile {
  if (!object(value) || Object.keys(value).length !== 3 || value.name !== name || !integer(value.sizeBytes, 100) ||
      typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.sha256)) throw invalid();
  return {name, sizeBytes: value.sizeBytes, sha256: value.sha256};
}

/** Reject a hard link or an inode already held by SQLite before opening it. */
function backupFileInfo(file: string, portable = false): BigIntStats {
  if (!portable) validateManagedFile(file, {private: true});
  const info = lstatSync(file, {bigint: true});
  const identity = {dev: String(info.dev), ino: String(info.ino)};
  if (!info.isFile() || info.nlink !== 1n || isProjectFileHeld(identity) || isAppLibraryHeld(identity)) throw invalid();
  return info;
}

export function readFormat4BackupManifest(root: string, backupId: string): Format4BackupManifest {
  if (!isProjectId(backupId)) throw invalid();
  validatePrivateDirectory(root);
  const directory = path.join(root, backupId);
  validatePrivateDirectory(directory);
  const file = path.join(directory, MANIFEST_FILE);
  backupFileInfo(file);
  const text = readPrivateFile(file, {encoding: 'utf8'});
  let raw: unknown;
  try { raw = JSON.parse(String(text)); }
  catch { throw invalid(); }
  if (!object(raw) || Object.keys(raw).length !== 8 || raw.version !== 1 ||
      raw.projectVersion !== FORMAT3_RELEASE_MANIFEST.project.version || !isProjectId(raw.projectId) ||
      !integer(raw.contentSequence, 0) || !isContentToken(raw.contentToken) || typeof raw.historyPresent !== 'boolean' ||
      !Array.isArray(raw.files) || raw.files.length !== (raw.historyPresent ? 2 : 1)) throw invalid();
  const historyVersion = historySchema(raw.historyVersion)?.version;
  if (raw.historyPresent ? historyVersion === undefined : raw.historyVersion !== null) throw invalid();
  const files = [backupFile(raw.files[0], PROJECT_FILE)];
  if (raw.historyPresent) files.push(backupFile(raw.files[1], HISTORY_FILE));
  return {version: 1, projectId: raw.projectId, contentSequence: raw.contentSequence, contentToken: raw.contentToken,
    projectVersion: raw.projectVersion, historyPresent: raw.historyPresent, historyVersion: historyVersion ?? null, files};
}

function verify(file: string, kind: 'project' | 'history', expected: BackupIdentity, manifest: SchemaManifest, portable = false): void {
  backupFileInfo(file, portable);
  const db = new DatabaseSync(file, {readOnly: true, defensive: true, enableDoubleQuotedStringLiterals: false});
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA cell_size_check=ON');
    const applicationId = kind === 'project' ? PROJECT_FILE_APPLICATION_ID : HISTORY_APPLICATION_ID;
    const versions = db.prepare('SELECT version FROM schema_version LIMIT 2').all();
    const delta = compareManifest(readSchemaManifest(db, 'main'), manifest.entries);
    if (value(db, 'PRAGMA application_id') !== applicationId || value(db, 'PRAGMA encoding') !== 'UTF-8' ||
        value(db, 'PRAGMA journal_mode') !== 'delete' || versions.length !== 1 || versions[0]?.version !== manifest.version ||
        delta.missing.length || delta.unexpected.length || delta.changed.length ||
        value(db, 'PRAGMA quick_check') !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) throw invalid();
    if (kind === 'project') {
      if (value(db, 'PRAGMA user_version') !== manifest.version || value(db, 'SELECT projectId FROM project_file') !== expected.projectId ||
          !sameContentStamp(readProjectContentStamp(db, 'main'), expected)) throw invalid();
    } else {
      const rows = db.prepare('SELECT projectId,seenContentSequence,seenContentToken FROM history_state LIMIT 2').all();
      if (rows.length !== 1 || rows[0]?.projectId !== expected.projectId || rows[0]?.seenContentSequence !== expected.contentSequence ||
          rows[0]?.seenContentToken !== expected.contentToken) throw invalid();
    }
  } finally { db.close(); }
}

function syncFile(file: string): void {
  const fd = openSync(file, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function sameFileGeneration(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.birthtimeNs === b.birthtimeNs &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function hasExpectedFiles(directory: string, manifest: Format4BackupManifest, withManifest: boolean): boolean {
  const expected = new Set<string>(manifest.files.map(entry => entry.name));
  if (withManifest) expected.add(MANIFEST_FILE);
  const names = readdirSync(directory);
  return names.length === expected.size && names.every(name => expected.has(name));
}

function verifyFileDigest(file: string, entry: Format4BackupFile, portable: boolean): BigIntStats {
  const info = backupFileInfo(file, portable);
  if (info.size !== BigInt(entry.sizeBytes)) throw invalid();
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!sameFileGeneration(info, fstatSync(fd, {bigint: true}))) throw invalid();
    const buffer = Buffer.alloc(1024 * 1024);
    const hash = createHash('sha256');
    let offset = 0n;
    while (offset < info.size) {
      const length = readSync(fd, buffer, 0, Math.min(buffer.length, Number(info.size - offset)), offset);
      if (length === 0) throw invalid();
      hash.update(buffer.subarray(0, length));
      offset += BigInt(length);
    }
    if (hash.digest('hex') !== entry.sha256 || !sameFileGeneration(info, fstatSync(fd, {bigint: true}))) throw invalid();
    return info;
  } finally { closeSync(fd); }
}

export function verifyFormat4BackupFile(file: string, manifest: Format4BackupManifest, entry: Format4BackupFile, portable = false): void {
  const kind = entry.name === PROJECT_FILE ? 'project' : 'history';
  const schema = kind === 'project' ? FORMAT3_RELEASE_MANIFEST.project : historySchema(manifest.historyVersion);
  if (!schema) throw invalid();
  const info = verifyFileDigest(file, entry, portable);
  verify(file, kind, manifest, schema, portable);
  if (!sameFileGeneration(info, backupFileInfo(file, portable))) throw invalid();
}

/** The recovery stage can omit the already-read manifest; neither the backup
 * nor the staged pair can have extra database files or rollback sidecars. */
export function verifyFormat4Backup(directory: string, manifest: Format4BackupManifest): void {
  validatePrivateDirectory(directory);
  const withManifest = lstatSync(path.join(directory, MANIFEST_FILE), {throwIfNoEntry: false}) !== undefined;
  if (!hasExpectedFiles(directory, manifest, withManifest)) throw invalid();
  if (withManifest) backupFileInfo(path.join(directory, MANIFEST_FILE));
  for (const entry of manifest.files) verifyFormat4BackupFile(path.join(directory, entry.name), manifest, entry);
  if (!hasExpectedFiles(directory, manifest, withManifest)) throw invalid();
}

export function copyFormat4File(source: number, file: string, name: Format4BackupFile['name']): Format4BackupFile {
  const before = fstatSync(source, {bigint: true});
  const fd = openSync(file, 'wx', 0o600), buffer = Buffer.alloc(1024 * 1024), hash = createHash('sha256');
  let sizeBytes = 0n;
  try {
    while (sizeBytes < before.size) {
      const capacity = Number(before.size - sizeBytes > BigInt(buffer.length) ? BigInt(buffer.length) : before.size - sizeBytes);
      const length = readSync(source, buffer, 0, capacity, sizeBytes);
      if (length === 0) throw invalid();
      for (let offset = 0; offset < length;) {
        const written = writeSync(fd, buffer, offset, length - offset);
        if (written === 0) throw invalid();
        offset += written;
      }
      hash.update(buffer.subarray(0, length));
      sizeBytes += BigInt(length);
    }
    const after = fstatSync(source, {bigint: true});
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw invalid();
    fsyncSync(fd);
  } finally { closeSync(fd); }
  return {name, sizeBytes: Number(sizeBytes), sha256: hash.digest('hex')};
}

function ownedFiles(directory: string): readonly string[] | null {
  try {
    validatePrivateDirectory(directory);
    const names = readdirSync(directory);
    if (names.some(name => name !== PROJECT_FILE && name !== HISTORY_FILE && name !== MANIFEST_FILE)) return null;
    return names.map(name => {
      const file = path.join(directory, name);
      backupFileInfo(file);
      return file;
    });
  } catch { return null; }
}

/** Validate the complete shape before deleting any child. Never recurse into
 * unrecognized content, and never open database files just to remove them. */
function removeOwnedBackup(directory: string): void {
  const files = ownedFiles(directory);
  if (files === null) return;
  for (const file of files) unlinkSync(file);
  rmdirSync(directory);
}

function cleanupPendingBackups(root: string): void {
  for (const name of readdirSync(root)) {
    if (PENDING_DIRECTORY.test(name) || name.startsWith(RETIRED_PREFIX) && isProjectId(name.slice(RETIRED_PREFIX.length))) {
      removeOwnedBackup(path.join(root, name));
    }
  }
  syncDirectory(root);
}

function reserveBackupSlot(root: string, projectId: string): void {
  const published: {id: string; time: bigint}[] = [];
  for (const id of readdirSync(root)) {
    if (!isProjectId(id)) continue;
    const directory = path.join(root, id);
    try {
      const manifest = readFormat4BackupManifest(root, id);
      if (manifest.projectId !== projectId || !hasExpectedFiles(directory, manifest, true) || !ownedFiles(directory)) continue;
      if (manifest.files.some(entry => backupFileInfo(path.join(directory, entry.name)).size !== BigInt(entry.sizeBytes))) continue;
      published.push({id, time: lstatSync(directory, {bigint: true}).mtimeNs});
    } catch { /* Unrecognized backups belong outside the managed rotation. */ }
  }
  published.sort((a, b) => a.time === b.time ? a.id.localeCompare(b.id, 'en') : a.time < b.time ? -1 : 1);
  for (const {id} of published.slice(0, Math.max(0, published.length - FORMAT_UPGRADE_BACKUP_LIMIT + 1))) {
    const retired = path.join(root, RETIRED_PREFIX + id);
    if (lstatSync(retired, {throwIfNoEntry: false})) throw invalid();
    renameSync(path.join(root, id), retired);
    syncDirectory(root);
    removeOwnedBackup(retired);
  }
}

/** The caller owns both native locks and the descriptors for those same
 * inodes. Byte copies preserve implicit rowids used by retained version
 * evidence. Publish the pair before either source enters the migration. */
export function createFormat4UpgradeBackup(db: DatabaseSync, localDir: string, expected: BackupIdentity,
  source: Readonly<{project: number; history?: number}>, historyManifest: SchemaManifest | undefined): void {
  if (db.isTransaction) throw new TypeError('An upgrade backup requires the locked opening connection outside a transaction');
  const root = path.join(localDir, FORMAT_UPGRADE_BACKUP_DIRECTORY);
  let pending: string | undefined;
  try {
    if (lstatSync(path.join(localDir, FORMAT4_RESTORE_ACTIVE), {throwIfNoEntry: false})) throw invalid();
    ensurePrivateDirectory(root, {create: true});
    cleanupPendingBackups(root);
    pending = createPrivateTemporaryDirectory(root, '.pending-');
    const project = path.join(pending, PROJECT_FILE), history = path.join(pending, HISTORY_FILE);
    const files = [copyFormat4File(source.project, project, PROJECT_FILE)];
    verify(project, 'project', expected, FORMAT3_RELEASE_MANIFEST.project);
    if (historyManifest) {
      if (source.history === undefined) throw invalid();
      files.push(copyFormat4File(source.history, history, HISTORY_FILE));
      verify(history, 'history', expected, historyManifest);
    }
    const manifest = path.join(pending, MANIFEST_FILE);
    writeFileSync(manifest, JSON.stringify({version: 1, ...expected, historyPresent: historyManifest !== undefined,
      projectVersion: FORMAT3_RELEASE_MANIFEST.project.version, historyVersion: historyManifest?.version ?? null, files}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    syncFile(manifest);
    syncDirectory(pending);
    const destination = path.join(root, randomUUID());
    if (lstatSync(destination, {throwIfNoEntry: false})) throw invalid();
    // The replacement is already verified and durable. Leave space before
    // publication so a crash cannot expose more than the retained limit.
    reserveBackupSlot(root, expected.projectId);
    renameSync(pending, destination);
    pending = undefined;
    syncDirectory(root);
    syncDirectory(localDir);
  } catch (error) {
    const failure = invalid();
    failure.cause = error;
    throw failure;
  } finally {
    if (pending) removeOwnedBackup(pending);
  }
}
