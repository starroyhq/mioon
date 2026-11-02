/** Test helpers over the same project kernel and server layout as production.
 * A project is opened only by the kernel, including recovery and TEMP guards. */
import {randomUUID} from 'node:crypto';
import {lstatSync, readdirSync, rmSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {isPromise} from 'node:util/types';
import {ensurePrivateDirectory} from '@mioon/contracts/private-storage';
import {DEFAULT_PROJECTS_DIRECTORY, isProjectId, PROJECT_DATABASE_NAMES, TEST_STORE_LAYOUT} from '../../packages/contracts/src/project-file.ts';
import type {ForeignKeyViolation} from '../../packages/contracts/src/project-file.ts';
import {openAppLibrary} from '../../packages/business/src/app-db/index.ts';
import {heldTestApplicationLibrary} from '../../packages/business/src/project-service-application.ts';
import {findHeldAppProjectFile} from '../../packages/business/src/app-db/connection.ts';
import {isProjectDatabase, openProjectConnection} from '../../packages/business/src/project-file/connection.ts';
import {projectFileError} from '../../packages/business/src/project-file/errors.ts';
import {foreignKeyCheck as kernelForeignKeyCheck} from '../../packages/business/src/project-file/cross-file/inspect.ts';
import {relationTriggerStatements} from '../../packages/business/src/project-file/cross-file/install.ts';
import {CROSS_FILE_RELATIONS} from '../../packages/business/src/project-file/cross-file/relations.ts';
import {openServerTestStore} from '../../packages/business/src/project-file/test-store.ts';
import type {ProjectStore} from '../../packages/business/src/project-file/store.ts';
import {projectLocation, serverAppDirectories} from '../../apps/server/src/project-host/directories.ts';
import type {AppDirectories} from '../../apps/server/src/project-host/directories.ts';
import {projectNotFound} from '../../apps/server/src/project-host/errors.ts';
import {createProjectFiles} from '../../apps/server/src/project-host/manager.ts';
import {ensureProjectRow} from '../../apps/server/src/project-host/project-initialization.ts';

export {schemaObjects} from '../../packages/business/src/project-file/cross-file/inspect.ts';

// lstat only: opening and closing a database file would drop SQLite's locks.
const exists = (file: string): boolean => lstatSync(file, {throwIfNoEntry: false}) !== undefined;
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Pure pathname lookup. Test stores use project.mioon; the server's named
 * file is the sole .mioon in its project directory. Never guesses its name or
 * opens a held file merely to find its path. */
export function projectDatabasePath(root: string): string {
  root = path.resolve(root);
  const files = exists(root) ? readdirSync(root).filter(name => !name.startsWith('.') && name.endsWith('.mioon')) : [];
  if (files.length > 1) throw new TypeError('Expected exactly one project file in the project directory');
  return path.join(root, ...(files.length ? [files[0]!] : TEST_STORE_LAYOUT.projectFile));
}

// Location context comes only from a real app registration, never a second
// registration or an ownership proof. The kernel still checks the file's ID.
const serverLocations = new Map<string, {readonly directories: AppDirectories; readonly projectId: string}>();
const registeredFile = (dataDir: string, projectId: string): string | null => {
  const held = findHeldAppProjectFile(dataDir, projectId);
  if (held !== undefined) return held;
  if (!exists(path.join(dataDir, 'app-library.db'))) return null;
  const library = openAppLibrary({dataDir});
  try { return library.registry.get(projectId)?.projectFile ?? null; }
  finally { library.close(); }
};

/** A complete kernel connection. Closing the returned native DB also closes
 * the owning connection, so all three held identities are released together. */
export function openProjectDatabase(root: string): DatabaseSync {
  root = path.resolve(root);
  const file = projectDatabasePath(root);
  const known = serverLocations.get(root);
  const connection = openProjectConnection({projectFile: file, locate: projectId => {
    if (known) {
      if (known.projectId !== projectId) throw projectFileError('PROJECT_INVALID', {database: 'project', reason: 'project-mismatch', projectId});
      return projectLocation(known.directories, projectId);
    }
    // Across processes a default server project can be resolved from its real
    // registration; arbitrary/moved paths first go through projectDirFor.
    const parent = path.dirname(root), dataDir = path.dirname(parent);
    if (path.basename(parent) === DEFAULT_PROJECTS_DIRECTORY && registeredFile(dataDir, projectId) === file) {
      const directories = serverAppDirectories(dataDir);
      serverLocations.set(root, {directories, projectId});
      return projectLocation(directories, projectId);
    }
    if (file !== path.join(root, ...TEST_STORE_LAYOUT.projectFile)) throw new TypeError('Resolve server projects through projectDirFor before opening their database');
    return {localDir: path.join(root, ...TEST_STORE_LAYOUT.localDir), cacheDir: path.join(root, ...TEST_STORE_LAYOUT.cacheDir), tempDir: path.join(root, ...TEST_STORE_LAYOUT.tempDir)};
  }});
  const db = connection.db, nativeClose = db.close.bind(db);
  let closing = false;
  Object.defineProperty(db, 'close', {value: (): void => {
    if (closing) { nativeClose(); return; }
    closing = true;
    try { connection.close(); }
    finally { closing = false; }
  }});
  return db;
}

/** The directory of a server project, the base of its media/ paths, for tests
 * that joined <dataDir>/media/ themselves. Reads the app registry, borrowing
 * the real held library when the server owns it; never opens the project. */
export function projectDirFor(dataDir: string, projectId: string): string {
  if (!isProjectId(projectId)) throw new TypeError('Invalid project ID');
  dataDir = path.resolve(dataDir);
  const file = registeredFile(dataDir, projectId);
  if (file === null) throw projectNotFound(projectId);
  const root = path.dirname(file);
  serverLocations.set(root, {directories: serverAppDirectories(dataDir), projectId});
  return root;
}

/** Reopen a registered server project on its real three-file layout. Unlike
 * openStore(projectDir), this never creates a second TEST-layout project. */
export function openServerProject(dataDir: string, projectId: string): ProjectStore {
  const root = projectDirFor(dataDir, projectId), known = serverLocations.get(root)!;
  return openServerTestStore({projectFile: projectDatabasePath(root), locate: id => {
    if (id !== projectId) throw projectFileError('PROJECT_INVALID', {database: 'project', reason: 'project-mismatch', projectId: id});
    return projectLocation(known.directories, id);
  }}, path.resolve(dataDir));
}

/** A new project where startServer({dataDir}) finds it, for tests that fill a
 * project before they start the server: write through `store`, call
 * store.close(), then start the server. Uses the same folder creation,
 * project-file creation, registration and row initialization as the server.
 * Give the project's name as `name`, not a later store.put: after the switch
 * the server lists the name in the registry, which the store does not update.
 * Fixed IDs are only for shared test seeds, never proof of server ID generation. */
export function createServerProject(dataDir: string, options?: {name?: string; projectId?: string}): {projectId: string; store: ProjectStore} {
  const suppliedId = options?.projectId;
  const projectId = suppliedId === undefined ? randomUUID() : suppliedId;
  if (!isProjectId(projectId)) throw new TypeError('Invalid project ID');
  const name = options?.name ?? 'Test project';
  const directories = serverAppDirectories(path.resolve(dataDir));
  const shared = heldTestApplicationLibrary(directories.dataDir);
  const library = shared ?? openAppLibrary({dataDir: directories.dataDir});
  let store: ProjectStore | undefined;
  try {
    if (library.registry.get(projectId)) throw new Error('Project ID already exists');
    const entry = createProjectFiles({name, projectId}, {directories, registry: library.registry, identity: library.projectFileIdentity});
    try {
      store = openServerTestStore({projectFile: entry.projectFile, locate: id => {
        if (id !== projectId) throw new TypeError('Created project ID does not match its registration');
        return projectLocation(directories, id);
      }, checkCopy: library.registry.checkCopy}, directories.dataDir);
      ensureProjectRow(store, {name});
      ensurePrivateDirectory(path.join(store.projectDir, 'media'), {create: true});
    } catch (error) {
      store?.close();
      library.registry.remove(projectId);
      rmSync(path.dirname(entry.projectFile), {recursive: true, force: true});
      throw error;
    }
    serverLocations.set(store.projectDir, {directories, projectId});
    return {projectId, store};
  } finally { if (!shared) library.close(); }
}

/** Every row whose parent row is missing, in every database on the
 * connection; an unqualified PRAGMA foreign_key_check checks main only.
 * Kernel projects include the emulated cross-file relations. Explicit memory
 * or legacy connections retain the native-only check. */
export function foreignKeyCheck(db: DatabaseSync): ForeignKeyViolation[] {
  const kernel = isProjectDatabase(db);
  const violations: ForeignKeyViolation[] = kernel ? kernelForeignKeyCheck(db) : [];
  const checked = new Set<string>(kernel ? Object.values(PROJECT_DATABASE_NAMES) : []);
  for (const database of db.prepare('PRAGMA database_list').all()) {
    const schema = String(database.name);
    if (checked.has(schema)) continue;
    for (const row of db.prepare(`PRAGMA ${quote(schema)}.foreign_key_check`).all()) {
      violations.push({schema, table: String(row.table), rowid: row.rowid === null ? null : Number(row.rowid), parent: String(row.parent), parentSchema: schema, constraint: `fk:${String(row.fkid)}`});
    }
  }
  return violations;
}

const foreignKeys = (db: DatabaseSync): number => Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys);
const relationTriggers = new Map(CROSS_FILE_RELATIONS.flatMap(relation => relationTriggerStatements(relation)).map(sql => {
  const name = /^CREATE TEMP TRIGGER (\w+) /.exec(sql)?.[1];
  if (!name) throw new Error('Invalid kernel relation trigger');
  return [name, sql.replace('CREATE TEMP TRIGGER ', 'CREATE TRIGGER ')] as const;
}));
const disablingForeignKeys = new WeakSet<DatabaseSync>();

/** Runs `write` with foreign keys off, so a test can write a damaged row the
 * way a corrupt file would hold it, e.g. a row that belongs to or points at a
 * project this store does not hold. Tests call this rather than switch the
 * pragma themselves: after the switch the relations from the local-records
 * tables to the project file are temporary triggers, which
 * PRAGMA foreign_keys=OFF does not reach, so S0 reimplements only this
 * function and callers do not change.
 * It must start outside a transaction, where SQLite ignores the pragma. When
 * `write` returns a promise, foreign keys stay off until it settles, so a test
 * can wrap a whole service call whose own transaction does the damage. The
 * previous foreign_keys value comes back whatever happened. */
export function withoutForeignKeys<T>(db: DatabaseSync, write: () => T): T {
  if (db.isTransaction) throw new Error('withoutForeignKeys must start outside a transaction: SQLite ignores PRAGMA foreign_keys inside one.');
  if (disablingForeignKeys.has(db)) throw new Error('withoutForeignKeys cannot overlap on the same connection');
  const previous = foreignKeys(db);
  const triggers = isProjectDatabase(db) ? db.prepare("SELECT name,sql FROM temp.sqlite_master WHERE type='trigger' ORDER BY rowid").all()
    .filter(row => relationTriggers.has(String(row.name))).map(row => ({name: String(row.name), sql: String(row.sql)})) : [];
  if (isProjectDatabase(db) && (triggers.length !== relationTriggers.size || triggers.some(trigger => relationTriggers.get(trigger.name) !== trigger.sql))) {
    throw new Error('withoutForeignKeys requires the exact kernel relation triggers');
  }
  let removed = false;
  disablingForeignKeys.add(db);
  const restore = (): void => {
    const errors: unknown[] = [];
    try {
      if (db.isTransaction) {
        db.exec('ROLLBACK');
        errors.push(new Error('withoutForeignKeys rolled back a write that left a transaction open.'));
      }
      if (removed) {
        db.exec('SAVEPOINT restore_test_foreign_keys');
        try {
          for (const trigger of triggers) db.exec(trigger.sql.replace(/^CREATE TRIGGER /, 'CREATE TEMP TRIGGER '));
          db.exec('RELEASE restore_test_foreign_keys');
        } catch (error) {
          if (db.isTransaction) db.exec('ROLLBACK TO restore_test_foreign_keys; RELEASE restore_test_foreign_keys');
          throw error;
        }
      }
    } catch (error) { errors.push(error); }
    try {
      db.exec(`PRAGMA foreign_keys=${previous}`);
      if (foreignKeys(db) !== previous) throw new Error('withoutForeignKeys could not restore foreign_keys');
    } catch (error) { errors.push(error); }
    disablingForeignKeys.delete(db);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'withoutForeignKeys could not restore its connection');
  };
  const failed = (error: unknown): never => {
    try { restore(); } catch (restoreError) { throw new AggregateError([error, restoreError], 'The write failed and foreign_keys was not restored.'); }
    throw error;
  };
  let result: T;
  try {
    db.exec('PRAGMA foreign_keys=OFF');
    if (foreignKeys(db) !== 0) throw new Error('withoutForeignKeys could not disable foreign_keys');
    if (triggers.length) {
      db.exec('SAVEPOINT disable_test_foreign_keys');
      try {
        for (const trigger of triggers) db.exec(`DROP TRIGGER temp.${quote(trigger.name)}`);
        db.exec('RELEASE disable_test_foreign_keys');
        removed = true;
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK TO disable_test_foreign_keys; RELEASE disable_test_foreign_keys');
        throw error;
      }
    }
    result = write();
  } catch (error) { return failed(error); }
  if (isPromise(result)) return result.then(value => { restore(); return value; }, failed) as T;
  restore();
  return result;
}
