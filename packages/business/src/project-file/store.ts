import type {DatabaseSync, SQLInputValue} from 'node:sqlite';
import {isAsyncFunction, isPromise} from 'node:util/types';
import type {ProjectStore as ProjectStoreContract} from '../../../contracts/src/project-file.ts';
// Types only: db.ts is going to open its stores through this kernel.
import type {WorkspaceStore} from '../db.ts';
import {createProjectFile, openProjectConnection} from './connection.ts';
import type {CreateProjectFileOptions, OpenProjectConnectionOptions} from './connection.ts';

/** The contract's project store with the read and write surface of today's
 * WorkspaceStore (same tables, columns, errors and transaction rules). */
export interface ProjectStore extends WorkspaceStore, ProjectStoreContract<DatabaseSync> {}

/** Backend-owned transaction fences run first inside every store transaction,
 * observers last before its commit; an observer failure rolls back both domain
 * rows and its own writes. The same rules as db.ts's workspace registrations,
 * kept per connection. */
const transactionFences = new WeakMap<DatabaseSync, Set<() => void>>();
export function registerProjectTransactionFence(db: DatabaseSync, fence: () => void): () => void {
  let fences = transactionFences.get(db);
  if (!fences) {
    fences = new Set();
    transactionFences.set(db, fences);
  }
  fences.add(fence);
  return () => { fences?.delete(fence); };
}
const transactionObservers = new WeakMap<DatabaseSync, Set<(result: unknown) => void>>();
export function registerProjectTransactionObserver(db: DatabaseSync, observer: (result: unknown) => void): () => void {
  let observers = transactionObservers.get(db);
  if (!observers) {
    observers = new Set();
    transactionObservers.set(db, observers);
  }
  observers.add(observer);
  return () => { observers?.delete(observer); };
}

const TABLES = new Set(['projects', 'assets', 'shots', 'nodes', 'edges', 'jobs', 'versions', 'exports', 'timelines']);
const parseRowData = (data: unknown): unknown => JSON.parse(typeof data === 'string' ? data : String(data));
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as {then?: unknown}).then === 'function';
const sqlValue = (value: unknown): SQLInputValue => {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || value instanceof Uint8Array) return value;
  throw new TypeError('Workspace row values must be SQLite primitives');
};

/** Opens a project file (openProjectConnection) as a store. `root` is the
 * project directory. */
export function openProjectStore(options: OpenProjectConnectionOptions): ProjectStore {
  const connection = openProjectConnection(options);
  const database = connection.db;
  const table = (t: string): string => {
    if (!TABLES.has(t)) throw Error('Unknown table');
    return t;
  };
  const get = (t: string, id: string): unknown => {
    const row = database.prepare(`SELECT data FROM ${table(t)} WHERE id=?`).get(id);
    return row ? parseRowData(row.data) : null;
  };
  const list = (t: string, projectId?: string): unknown[] => {
    const rows = projectId ? database.prepare(`SELECT data FROM ${table(t)} WHERE projectId=?`).all(projectId) : database.prepare(`SELECT data FROM ${table(t)}`).all();
    return rows.map(row => parseRowData(row.data));
  };
  const put = <T extends object>(t: string, value: T): T => {
    table(t);
    const columns = t === 'projects' ? ['id', 'data'] : t === 'versions' ? ['id', 'projectId', 'jobId', 'data'] : ['id', 'projectId', 'data'];
    const record = value as Readonly<Record<string, unknown>>;
    const values = columns.map(column => column === 'data' ? JSON.stringify(value) : sqlValue(record[column]));
    database.prepare(`INSERT INTO ${t}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(...values);
    return value;
  };
  // A transaction owns its complete synchronous callback. Never commit before
  // asynchronous work, or let a nested caller roll back an outer transaction.
  const tx = <T>(callback: () => T): T => {
    if (typeof callback !== 'function' || isAsyncFunction(callback)) throw new TypeError('Transactions require a synchronous callback');
    if (database.isTransaction) throw new Error('Nested transactions are not supported');
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const fence of transactionFences.get(database) ?? []) fence();
      const result = callback();
      if (isThenable(result)) {
        if (isPromise(result)) Promise.resolve(result).catch(() => {});
        throw new TypeError('Transactions require a synchronous result');
      }
      for (const observer of transactionObservers.get(database) ?? []) observer(result);
      database.exec('COMMIT');
      return result;
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    }
  };
  let closed = false;
  const close = (): void => {
    if (closed) return;
    connection.close();
    closed = true;
  };
  return {
    db: database, root: connection.projectDir,
    projectId: connection.projectId, projectFile: connection.projectFile, projectDir: connection.projectDir,
    localDir: connection.localDir, cacheDir: connection.cacheDir, tempDir: connection.tempDir, historyState: connection.historyState,
    get, list, put, tx, close,
  };
}

/** Creates the project file (never replacing one), then opens it. */
export function createProjectStore(options: OpenProjectConnectionOptions & CreateProjectFileOptions): ProjectStore {
  createProjectFile(options.projectFile, options.projectId === undefined ? {} : {projectId: options.projectId});
  return openProjectStore(options);
}
