import {createHash, randomUUID} from 'node:crypto';
import {closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, rmSync, writeFileSync, writeSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createPrivateTemporaryDirectory, ensurePrivateDirectory, validateManagedFile} from '@mioon/contracts/private-storage';
import {AppError} from '../../../contracts/src/app-error.ts';
import type {ContentStamp} from '../../../contracts/src/project-file.ts';
import {sameContentStamp, readProjectContentStamp} from './content-stamp.ts';
import {HISTORY_APPLICATION_ID, PROJECT_FILE_APPLICATION_ID} from './schema/databases.ts';
import {FORMAT3_RELEASE_MANIFEST} from './schema/format3-manifest.ts';
import {compareManifest, readSchemaManifest} from './schema/manifest-check.ts';

export const FORMAT_UPGRADE_BACKUP_DIRECTORY = 'format-upgrade-backups';

interface BackupIdentity extends ContentStamp {
  readonly projectId: string;
  readonly historyPresent: boolean;
}

const invalid = (): AppError => new AppError('PROJECT_FORMAT_BACKUP_FAILED', '无法保留已校验的旧格式备份。', 409);
const value = (db: DatabaseSync, sql: string): unknown => Object.values(db.prepare(sql).get() ?? {})[0];

function verify(file: string, kind: 'project' | 'history', expected: BackupIdentity): void {
  validateManagedFile(file, {private: true});
  const db = new DatabaseSync(file, {readOnly: true, defensive: true, enableDoubleQuotedStringLiterals: false});
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA cell_size_check=ON');
    const manifest = FORMAT3_RELEASE_MANIFEST[kind];
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

function copyLockedFile(source: number, file: string) {
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
  return {name: path.basename(file), sizeBytes: Number(sizeBytes), sha256: hash.digest('hex')};
}

/** The caller owns both native locks and the descriptors for those same
 * inodes. Byte copies preserve implicit rowids used by retained version
 * evidence. Publish the pair before either source enters the migration. */
export function createFormat4UpgradeBackup(db: DatabaseSync, localDir: string, expected: BackupIdentity,
  source: Readonly<{project: number; history?: number}>): void {
  if (db.isTransaction) throw new TypeError('An upgrade backup requires the locked opening connection outside a transaction');
  const root = path.join(localDir, FORMAT_UPGRADE_BACKUP_DIRECTORY);
  let pending: string | undefined;
  try {
    ensurePrivateDirectory(root, {create: true});
    pending = createPrivateTemporaryDirectory(root, '.pending-');
    const project = path.join(pending, 'project.mioon'), history = path.join(pending, 'history.db');
    const files = [copyLockedFile(source.project, project)];
    verify(project, 'project', expected);
    if (expected.historyPresent) {
      if (source.history === undefined) throw invalid();
      files.push(copyLockedFile(source.history, history));
      verify(history, 'history', expected);
    }
    const manifest = path.join(pending, 'manifest.json');
    writeFileSync(manifest, JSON.stringify({version: 1, ...expected, projectVersion: 3, historyVersion: expected.historyPresent ? 10 : null,
      files}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    syncFile(manifest);
    syncDirectory(pending);
    const destination = path.join(root, randomUUID());
    if (lstatSync(destination, {throwIfNoEntry: false})) throw invalid();
    renameSync(pending, destination);
    pending = undefined;
    syncDirectory(root);
    syncDirectory(localDir);
  } catch (error) {
    const failure = invalid();
    failure.cause = error;
    throw failure;
  } finally {
    if (pending) rmSync(pending, {recursive: true, force: true});
  }
}
