import {createHash, randomUUID} from 'node:crypto';
import {closeSync, constants, copyFileSync, lstatSync, mkdirSync, openSync, rmdirSync, rmSync} from 'node:fs';
import {open} from 'node:fs/promises';
import path from 'node:path';
import {backup, DatabaseSync} from 'node:sqlite';
import type {SQLInputValue} from 'node:sqlite';
import {createPrivateTemporaryDirectory, ensurePrivateDirectory, validateManagedFile} from '@mioon/contracts/private-storage';
import {AppError} from '../../../contracts/src/app-error.ts';
import {isProjectId, PROJECT_DATABASE_NAMES} from '../../../contracts/src/project-file.ts';
import {isAppLibraryHeld} from '../app-db/connection.ts';
import {isProjectFileHeld} from './held-files.ts';
import {referencePathFor, resolveReferencePath} from '../media-reference/paths.ts';
import {mediaReferenceSchema} from '../../../contracts/src/media-reference.ts';
import {
  isProjectBackupReader, openProjectBackup, publishCopiedFile, readCopiedProjectIdentity, syncCopiedDirectory, syncCopiedFile,
} from './backup.ts';
import type {ProjectBackupIdentity, ProjectBackupReader} from './backup.ts';
import {projectFileError} from './errors.ts';
import {PROJECT_FILE_APPLICATION_ID} from './schema/databases.ts';
import {CONTENT_TABLES} from './schema/tables.ts';
import {isProjectStore} from './store.ts';
import type {ProjectStore} from './store.ts';

export interface CopyProjectOptions {
  readonly projectFile: string;
  /** Trusted source directory recorded when the backup was made. */
  readonly sourceProjectDir: string;
  /** Trusted recovery-intent ID, or a fresh UUID when S5 copies directly. */
  readonly projectId?: string;
}
export interface ProjectCopyResult extends ProjectBackupIdentity {readonly projectFile: string}
type Row = Record<string, SQLInputValue>;
const failed = (reason: string): AppError => new AppError('PROJECT_BACKUP_COPY_FAILED', '无法安全地复制项目内容', 409, {reason});

async function managedHash(projectDir: string, asset: Record<string, unknown>): Promise<{file: string; sizeBytes: number; sha256: string}> {
  const relative = asset.relativePath;
  if (typeof relative !== 'string' || !relative.startsWith('media/') || relative.length > 4096 || /[\\\u0000]/u.test(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..')) throw failed('media-path');
  const file = path.join(projectDir, relative), media = path.join(projectDir, 'media');
  const before = validateManagedFile(file, {root: media});
  if (!before) throw failed('media-missing');
  const info = lstatSync(file, {bigint: true}), identity = {dev: String(info.dev), ino: String(info.ino)};
  if (isProjectFileHeld(identity) || isAppLibraryHeld(identity)) throw failed('held-media-database');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const first = await handle.stat();
    const same = (a: typeof first, b: typeof first): boolean => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key as keyof typeof a] === b[key as keyof typeof b]);
    if (!first.isFile() || !same(first, before)) throw failed('media-changed');
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
    let sizeBytes = 0;
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      sizeBytes += read.bytesRead;
      if (sizeBytes > first.size) throw failed('media-changed');
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat(), current = validateManagedFile(file, {root: media});
    const sha256 = hash.digest('hex');
    if (!current || !same(first, after) || !same(first, current) || sizeBytes !== first.size || sha256 !== asset.sha256
      || typeof asset.sizeBytes === 'number' && sizeBytes !== asset.sizeBytes) throw failed('media-changed');
    return {file, sizeBytes, sha256};
  } finally { await handle.close(); }
}

/** Only project ownership fields are rewritten; entity IDs and provenance
 * IDs remain real. A string equal to an ID in a user's note stays untouched. */
function rewriteJson(value: unknown, oldId: string, newId: string, projectRow: boolean): unknown {
  if (Array.isArray(value)) return value.map(item => rewriteJson(item, oldId, newId, false));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    (key === 'projectId' || projectRow && key === 'id') && item === oldId ? newId : rewriteJson(item, oldId, newId, false)]));
}

function rewriteRow(table: string, input: Row, oldId: string, newId: string): Row {
  const row = {...input};
  if (row.projectId === oldId) row.projectId = newId;
  if (table === 'projects' && row.id === oldId) row.id = newId;
  if (table === 'agent_task_target_revisions_v2' && (row.kind === 'project' || row.kind === 'timeline') && row.targetId === oldId) row.targetId = newId;
  if (typeof row.data === 'string') row.data = JSON.stringify(rewriteJson(JSON.parse(row.data), oldId, newId, table === 'projects'));
  return row;
}

/** Keep reference assets at the same real location after a copy. No media is
 * read merely to rewrite a reference; missing assets stay missing. */
function relocateReference(data: Record<string, unknown>, from: string, to: string): void {
  const parsed = mediaReferenceSchema.safeParse(data.mediaReference);
  if (!parsed.success || parsed.data.pathForm === 'absolute') return;
  const file = resolveReferencePath(from, parsed.data);
  if (file === null) throw failed('media-reference');
  // A missing referenced file is still a valid reference. Use volume metadata
  // of its directories when available, otherwise an absolute path is safe.
  let sameVolume = false;
  try { sameVolume = lstatSync(from).dev === lstatSync(to).dev; } catch {}
  data.mediaReference = {...parsed.data, ...referencePathFor(to, file, sameVolume)};
}

/** Creates the immutable owner-change copy in isolation. Existing target
 * content is never rewritten and source triggers/metadata are never changed.
 * S5 can reuse this for a live owner; V2 supplies its verified read-only copy. */
export async function copyProjectToNewFile(source: ProjectBackupReader | ProjectStore, options: CopyProjectOptions): Promise<ProjectCopyResult> {
  const live = isProjectStore(source), saved = isProjectBackupReader(source);
  if (!live && !saved) throw new TypeError('Copy requires a live project store or verified backup reader');
  if (source.db.isTransaction) throw new TypeError('Copy cannot start inside a transaction');
  const projectId = options.projectId ?? randomUUID();
  if (!isProjectId(projectId)) throw new TypeError('Invalid project ID');
  const oldId = live ? source.projectId : source.identity.projectId;
  if (projectId === oldId) throw new TypeError('A project copy requires a new ID');
  const target = path.resolve(options.projectFile), parent = path.dirname(target), sourceProjectDir = path.resolve(options.sourceProjectDir);
  if (lstatSync(target, {throwIfNoEntry: false})) throw projectFileError('PROJECT_FILE_EXISTS', {database: 'project', reason: 'exists'});
  // This validates ordinary portable project-folder ancestors (0755 is fine)
  // before creating our own private staging directory below the target.
  const temporaryDir = createPrivateTemporaryDirectory(parent, 'project-copy-'), temporary = path.join(temporaryDir, 'project.mioon');
  const placedMedia: string[] = [], madeDirectories: string[] = [], usedMediaDirectories = new Set<string>();
  let published = false;
  try {
    closeSync(openSync(temporary, 'wx', 0o600));
    await backup(source.db, temporary, {source: live ? PROJECT_DATABASE_NAMES.project : 'main'});
    const db = new DatabaseSync(temporary, {timeout: 0, defensive: true, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false});
    let identity: ProjectBackupIdentity;
    try {
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL');
      const triggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY rowid").all();
      const rows = new Map(CONTENT_TABLES.map(table => [table, db.prepare(`SELECT * FROM "${table}"`).all() as Row[]]));
      const sequence = db.prepare('SELECT contentSequence FROM project_file').get()?.contentSequence;
      if (typeof sequence !== 'number') throw failed('metadata');
      // Only the isolated destination loses its triggers, inside this atomic
      // transaction. Reinsert rather than UPDATE immutable retained rows.
      db.exec('PRAGMA foreign_keys=OFF; BEGIN');
      try {
        for (const trigger of triggers) db.exec(`DROP TRIGGER "${String(trigger.name).replaceAll('"', '""')}"`);
        for (const table of [...CONTENT_TABLES].reverse()) db.exec(`DELETE FROM "${table}"`);
        db.prepare('UPDATE project_file SET projectId=?,contentSequence=?').run(projectId, sequence);
        for (const table of CONTENT_TABLES) {
          for (const original of rows.get(table) ?? []) {
            const row = rewriteRow(table, original, oldId, projectId);
            if (table === 'assets' && typeof row.data === 'string') {
              const data = JSON.parse(row.data) as Record<string, unknown>;
              relocateReference(data, sourceProjectDir, parent);
              row.data = JSON.stringify(data);
            }
            const columns = Object.keys(row);
            db.prepare(`INSERT INTO "${table}"(${columns.map(column => `"${column}"`).join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(column => row[column]));
          }
        }
        // Build back the exact current DDL in its original creation order,
        // preserving SQLite's trigger execution order as well as the manifest.
        for (const trigger of triggers) db.exec(String(trigger.sql));
        db.exec(`PRAGMA application_id=${PROJECT_FILE_APPLICATION_ID}`);
        if (db.prepare('PRAGMA foreign_key_check').get() !== undefined) throw failed('foreign-key');
        db.exec('COMMIT; PRAGMA foreign_keys=ON');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
      identity = readCopiedProjectIdentity(db, PROJECT_FILE_APPLICATION_ID, Number(lstatSync(temporary).size));
      // Until S1 converts managed assets to references, preserve the current
      // media/ contract by copying verified bytes without replacing any file.
      const managed = (rows.get('assets') ?? []).flatMap(row => {
        const asset = JSON.parse(String(row.data)) as Record<string, unknown>;
        return typeof asset.relativePath === 'string' && !mediaReferenceSchema.safeParse(asset.mediaReference).success ? [asset] : [];
      });
      const copied = new Map<string, {sha256: string; sizeBytes: number}>();
      for (const asset of managed) {
        const relativePath = String(asset.relativePath);
        const prior = copied.get(relativePath);
        if (prior) {
          if (prior.sha256 !== asset.sha256 || typeof asset.sizeBytes === 'number' && prior.sizeBytes !== asset.sizeBytes) throw failed('media-reference-conflict');
          continue;
        }
        const verified = await managedHash(sourceProjectDir, asset);
        if (typeof asset.sizeBytes === 'number' && asset.sizeBytes !== verified.sizeBytes) throw failed('media-size');
        let directory = parent;
        for (const part of relativePath.split('/').slice(0, -1)) {
          directory = path.join(directory, part);
          if (!lstatSync(directory, {throwIfNoEntry: false})) { mkdirSync(directory, {mode: 0o700}); madeDirectories.push(directory); }
          ensurePrivateDirectory(directory);
          usedMediaDirectories.add(directory);
        }
        const file = path.join(parent, relativePath);
        const copiedAsset = {...asset, relativePath};
        let destination: Awaited<ReturnType<typeof managedHash>>;
        try {
          copyFileSync(verified.file, file, constants.COPYFILE_EXCL);
          placedMedia.push(file);
          destination = await managedHash(parent, copiedAsset);
        } catch (error) {
          if ((error as {code?: unknown})?.code !== 'EEXIST') throw error;
          // A process can die after the media publication but before the
          // project file. Reuse only an independently verified exact match;
          // never overwrite it or treat it as this attempt's cleanup owner.
          try { destination = await managedHash(parent, copiedAsset); }
          catch { throw error; }
        }
        if (destination.sha256 !== verified.sha256 || destination.sizeBytes !== verified.sizeBytes) throw failed('media-changed');
        syncCopiedFile(file);
        copied.set(relativePath, {sha256: destination.sha256, sizeBytes: destination.sizeBytes});
      }
      for (const directory of new Set([...usedMediaDirectories, ...madeDirectories].reverse())) syncCopiedDirectory(directory);
    } finally { db.close(); }
    syncCopiedFile(temporary);
    publishCopiedFile(temporary, target, () => { published = true; });
    return {...identity, projectFile: target};
  } finally {
    rmSync(temporaryDir, {recursive: true, force: true});
    // A directory-fsync failure can follow successful atomic publication.
    // Keep its media: a durable intent can inspect and reconcile that target.
    if (!published) {
      for (const file of placedMedia.reverse()) rmSync(file, {force: true});
      for (const directory of madeDirectories.reverse()) { try { rmdirSync(directory); } catch {} }
    }
  }
}

export async function copyProjectBackup(options: CopyProjectOptions & {readonly backupFile: string}): Promise<ProjectCopyResult> {
  const source = openProjectBackup(options.backupFile);
  try { return await copyProjectToNewFile(source, options); } finally { source.close(); }
}
