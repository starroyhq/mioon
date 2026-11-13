import {closeSync, lstatSync, openSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {validateManagedFile, ensurePrivateDirectory} from '../../../contracts/src/private-storage.ts';
import type {ContentStamp} from '../../../contracts/src/project-file.ts';
import {isProjectId} from '../../../contracts/src/project-file.ts';
import {isAppLibraryHeld} from '../app-db/connection.ts';
import {isProjectFileHeld} from './held-files.ts';
import {buildDatabase, FORMAT4_HISTORY_SCHEMA_VERSION, FORMAT4_PROJECT_SCHEMA_VERSION, HISTORY_SCHEMA_VERSION} from './schema/databases.ts';
import type {ProjectFileFormat} from './schema/databases.ts';
import {projectFileError} from './errors.ts';

/** Initialize only an isolated new target. No ordinary opener or source
 * migration runs before the target's actual copied content pair is known. */
export function initializeProjectCopyHistory(file: string, projectId: string, stamp: ContentStamp & {readonly formatVersion: ProjectFileFormat}): void {
  if (!path.isAbsolute(file) || !isProjectId(projectId)) throw new TypeError('Invalid isolated copy history');
  ensurePrivateDirectory(path.dirname(file));
  closeSync(openSync(file, 'wx', 0o600));
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys=ON; BEGIN');
    const version = stamp.formatVersion === FORMAT4_PROJECT_SCHEMA_VERSION ? FORMAT4_HISTORY_SCHEMA_VERSION : HISTORY_SCHEMA_VERSION;
    buildDatabase(db, 'history', 'main', undefined, version);
    db.prepare('INSERT INTO history_state(singleton,projectId,seenContentSequence,seenContentToken) VALUES(1,?,?,?)')
      .run(projectId, stamp.contentSequence, stamp.contentToken);
    db.exec('COMMIT');
  } finally { db.close(); }
}

/** The capture step already verified this request-owned history snapshot.
 * Keep its read-only handle inside the kernel and close it synchronously. */
export function readProjectCopyHistory<T>(file: string, read: (db: DatabaseSync) => T): T {
  const info = lstatSync(file, {bigint: true});
  const identity = {dev: String(info.dev), ino: String(info.ino)};
  if (isProjectFileHeld(identity) || isAppLibraryHeld(identity)) throw projectFileError('PROJECT_LOCKED', {database: 'history', reason: 'locked'});
  validateManagedFile(file, {root: path.dirname(file), private: true});
  const db = new DatabaseSync(file, {readOnly: true, timeout: 0, defensive: true});
  try { return read(db); } finally { db.close(); }
}
