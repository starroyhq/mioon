import {randomBytes,randomUUID} from 'node:crypto';
import {closeSync, lstatSync, openSync, rmSync} from 'node:fs';
import path from 'node:path';
import {backup, DatabaseSync} from 'node:sqlite';
import type {SQLInputValue} from 'node:sqlite';
import {createPrivateTemporaryDirectory} from '@mioon/contracts/private-storage';
import {AppError} from '../../../contracts/src/app-error.ts';
import type {MediaReference} from '../../../contracts/src/media-reference.ts';
import {isProjectId, PROJECT_DATABASE_NAMES} from '../../../contracts/src/project-file.ts';
import {rewriteProjectCopyRow,relocateProjectCopyReference} from './copy-values.ts';
import {
  createProjectCopyStagingDirectory, isProjectBackupReader, openProjectBackup, PROJECT_BACKUP_APPLICATION_ID, publishCopiedFile, readCopiedProjectIdentity, syncCopiedFile,
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
  /** S5 stage references are relative to the final public folder. */
  readonly targetProjectDir?: string;
  readonly projectName?: string;
  /** Only isolated S5 targets clear local-process revision evidence. */
  readonly clearProcessRevisions?: true;
  /** Trusted template whitelist: every asset must map to a verified independent copy. */
  readonly referenceTargets?: ReadonlyMap<string, MediaReference>;
  /** Trusted S5 publication; omitted V2 callers retain their existing contract. */
  readonly publish?: (temporary:string,destination:string)=>void;
  /** Trusted recovery-intent ID, or a fresh UUID when S5 copies directly. */
  readonly projectId?: string;
  /** Durable restore intents allocate this once; direct copies allocate fresh. */
  readonly contentToken?: string;
  /** Bind a retry to the verified source, including same-sequence forks. */
  readonly expectedSource?: Pick<ProjectBackupIdentity,'projectId'|'contentSequence'|'contentToken'>;
}
export interface ProjectCopyResult extends ProjectBackupIdentity {readonly projectFile: string}
type Row = Record<string, SQLInputValue>;
const failed = (reason: string): AppError => new AppError('PROJECT_BACKUP_COPY_FAILED', '无法安全地复制项目内容', 409, {reason});

/** Creates the immutable owner-change copy in isolation. Existing target
 * content is never rewritten and source triggers/metadata are never changed.
 * S5 can reuse this for a live owner; V2 supplies its verified read-only copy. */
export async function copyProjectToNewFile(source: ProjectBackupReader | ProjectStore, options: CopyProjectOptions): Promise<ProjectCopyResult> {
  const live = isProjectStore(source), saved = isProjectBackupReader(source);
  if (!live && !saved) throw new TypeError('Copy requires a live project store or verified backup reader');
  if (source.db.isTransaction) throw new TypeError('Copy cannot start inside a transaction');
  const projectId = options.projectId ?? randomUUID();
  const contentToken=options.contentToken??randomBytes(16).toString('hex');
  if (!isProjectId(projectId)) throw new TypeError('Invalid project ID');
  if(!/^[a-f0-9]{32}$/u.test(contentToken))throw new TypeError('Invalid content token');
  const oldId = live ? source.projectId : source.identity.projectId;
  if (projectId === oldId) throw new TypeError('A project copy requires a new ID');
  const target = path.resolve(options.projectFile), parent = path.dirname(target), sourceProjectDir = path.resolve(options.sourceProjectDir);
  if (lstatSync(target, {throwIfNoEntry: false})) throw projectFileError('PROJECT_FILE_EXISTS', {database: 'project', reason: 'exists'});
  // This validates ordinary portable project-folder ancestors (0755 is fine)
  // before creating our own private staging directory below the target.
  const temporaryDir = (options.publish ? createProjectCopyStagingDirectory : createPrivateTemporaryDirectory)(parent, 'project-copy-'), temporary = path.join(temporaryDir, 'project.mioon');
  try {
    closeSync(openSync(temporary, 'wx', 0o600));
    await backup(source.db, temporary, {source: live ? PROJECT_DATABASE_NAMES.project : 'main'});
    const db = new DatabaseSync(temporary, {timeout: 0, defensive: true, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false});
    let identity: ProjectBackupIdentity;
    try {
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL');
      const actual=readCopiedProjectIdentity(db,live?PROJECT_FILE_APPLICATION_ID:PROJECT_BACKUP_APPLICATION_ID,Number(lstatSync(temporary).size));
      if(actual.projectId!==oldId || actual.contentToken===contentToken)throw failed('metadata');
      if(options.expectedSource && (actual.projectId!==options.expectedSource.projectId || actual.contentSequence!==options.expectedSource.contentSequence || actual.contentToken!==options.expectedSource.contentToken))throw failed('source-changed');
      const triggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY rowid").all();
      const rows = new Map(CONTENT_TABLES.map(table => [table, db.prepare(`SELECT * FROM "${table}"`).all() as Row[]]));
      let sequence = db.prepare('SELECT contentSequence FROM project_file').get()?.contentSequence;
      if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence)) throw failed('metadata');
      if(options.clearProcessRevisions){
        const kept=(rows.get('agent_task_target_revisions_v2')??[]).filter(row=>!['job','export','image_task','frame_task'].includes(String(row.kind)));
        if(kept.length!==(rows.get('agent_task_target_revisions_v2')??[]).length){
          if(sequence>=Number.MAX_SAFE_INTEGER)throw failed('metadata');
          sequence++;rows.set('agent_task_target_revisions_v2',kept);
        }
      }
      // Only the isolated destination loses its triggers, inside this atomic
      // transaction. Reinsert rather than UPDATE immutable retained rows.
      db.exec('PRAGMA foreign_keys=OFF; BEGIN');
      try {
        for (const trigger of triggers) db.exec(`DROP TRIGGER "${String(trigger.name).replaceAll('"', '""')}"`);
        for (const table of [...CONTENT_TABLES].reverse()) db.exec(`DELETE FROM "${table}"`);
        db.prepare('UPDATE project_file SET projectId=?,contentSequence=?,contentToken=?').run(projectId, sequence,contentToken);
        for (const table of CONTENT_TABLES) {
          for (const original of rows.get(table) ?? []) {
            const row = rewriteProjectCopyRow(table, original, oldId, projectId) as Row;
            if(table==='projects'&&options.projectName!==undefined&&typeof row.data==='string'){const data=JSON.parse(row.data) as Record<string,unknown>;data.name=options.projectName;row.data=JSON.stringify(data);}
            if (table === 'assets' && typeof row.data === 'string') {
              const data = JSON.parse(row.data) as Record<string, unknown>;
              relocateProjectCopyReference(data, sourceProjectDir, path.resolve(options.targetProjectDir ?? parent), options.referenceTargets);
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
    } finally { db.close(); }
    syncCopiedFile(temporary);
    (options.publish ?? publishCopiedFile)(temporary, target);
    return {...identity, projectFile: target};
  } finally {
    rmSync(temporaryDir, {recursive: true, force: true});

  }
}

export async function copyProjectBackup(options: CopyProjectOptions & {readonly backupFile: string}): Promise<ProjectCopyResult> {
  const source = openProjectBackup(options.backupFile);
  try { return await copyProjectToNewFile(source, options); } finally { source.close(); }
}
