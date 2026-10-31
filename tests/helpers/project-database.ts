/** Project database helpers for tests (docs/PROJECT-FILE.md, “测试”). This is
 * the implementation over today's workspace store, where one workbench.sqlite
 * in the data directory holds every project. S0 swaps in the project-file
 * kernel behind the same signatures, so callers do not change.
 * schemaObjects is the kernel's already: it reads every database on a
 * connection, whichever store opened it. */
import {randomUUID} from 'node:crypto';
import {lstatSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {isProjectId} from '../../packages/contracts/src/project-file.ts';
import type {ForeignKeyViolation} from '../../packages/contracts/src/project-file.ts';
import {openStore} from '../../packages/business/src/db.ts';
import {projectFileError} from '../../packages/business/src/project-file/errors.ts';
import type {ProjectStore} from '../../packages/business/src/project-file/store.ts';

export {schemaObjects} from '../../packages/business/src/project-file/cross-file/inspect.ts';

// lstat only: opening and closing a database file would drop SQLite's locks.
const exists = (file: string): boolean => lstatSync(file, {throwIfNoEntry: false}) !== undefined;
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** The file that holds the project's content, for tests that joined
 * workbench.sqlite themselves. */
export function projectDatabasePath(root: string): string {
  return path.join(path.resolve(root), 'workbench.sqlite');
}

/** The test's own connection to a project nobody holds, with the pragmas
 * openStore sets; that store creates no temporary triggers to copy. A
 * server.lock means a server or a locking store still holds the project, and
 * the answer is PROJECT_LOCKED, as the kernel answers a second connection.
 * A store opened with {lock: false} leaves no lock to find. */
export function openProjectDatabase(root: string): DatabaseSync {
  const file = projectDatabasePath(root);
  if (!exists(file)) throw projectFileError('PROJECT_MISSING', {database: 'project', reason: 'missing'});
  if (exists(path.join(path.dirname(file), 'server.lock'))) throw projectFileError('PROJECT_LOCKED', {database: 'project', reason: 'locked'});
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** The directory of a server project, the base of its media/ paths, for tests
 * that joined <dataDir>/media/ themselves. Today every project shares the
 * data directory. */
export function projectDirFor(dataDir: string, projectId: string): string {
  if (!isProjectId(projectId)) throw new TypeError('Invalid project ID');
  return path.resolve(dataDir);
}

/** A new project where startServer({dataDir}) finds it, for tests that fill a
 * project before they start the server: write through `store`, call
 * store.close(), then start the server. Today that is the row project.create
 * writes, in the data directory's workspace. The open store holds the
 * workspace lock, so close it before the next call or the server starts.
 * Give the project's name as `name`, not a later store.put: after the switch
 * the server lists the name in the registry, which the store does not update. */
export function createServerProject(dataDir: string, options?: {name?: string}): {projectId: string; store: ProjectStore} {
  const root = path.resolve(dataDir);
  const workspace = openStore(root);
  try {
    const projectId = randomUUID(), stamp = new Date().toISOString();
    workspace.tx(() => workspace.put('projects', {id: projectId, name: options?.name ?? 'Test project', description: '', revision: 1, createdAt: stamp, updatedAt: stamp}));
    // Today's workspace keeps all four directories in one.
    const store: ProjectStore = Object.assign(workspace, {
      projectId, projectFile: projectDatabasePath(root), projectDir: root, localDir: root, cacheDir: root, tempDir: root, historyState: 'fresh' as const,
    });
    return {projectId, store};
  } catch (error) {
    workspace.close();
    throw error;
  }
}

/** Every row whose parent row is missing, in every database on the
 * connection; an unqualified PRAGMA foreign_key_check checks main only.
 * Today's store has no cross-file relations to scan. */
export function foreignKeyCheck(db: DatabaseSync): ForeignKeyViolation[] {
  const violations: ForeignKeyViolation[] = [];
  for (const database of db.prepare('PRAGMA database_list').all()) {
    const schema = String(database.name);
    for (const row of db.prepare(`PRAGMA ${quote(schema)}.foreign_key_check`).all()) {
      violations.push({schema, table: String(row.table), rowid: row.rowid === null ? null : Number(row.rowid), parent: String(row.parent), parentSchema: schema, constraint: `fk:${String(row.fkid)}`});
    }
  }
  return violations;
}
