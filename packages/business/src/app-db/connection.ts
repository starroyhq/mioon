import {closeSync, constants, lstatSync, openSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {StatementSync} from 'node:sqlite';
import {isAsyncFunction, isPromise} from 'node:util/types';
import {ensurePrivateDirectory, PrivateStorageError, validateManagedFile} from '@mioon/contracts/private-storage';
import {AppError} from '../../../contracts/src/app-error.ts';
import {appLibraryError, appLibraryInvalid, isSqliteBusy, isSqliteCorrupt, isSqliteReadOnly} from './errors.ts';
import {
  APP_LIBRARY_APPLICATION_ID, APP_LIBRARY_FILE, APP_LIBRARY_SCHEMA_VERSION, APP_SCHEMA_VERSION_TABLE_SQL, buildAppLibrary, compareAppSchema,
  readAppSchema,
} from './schema.ts';

/** As the project-file kernel opens its files: a busy timeout of 0 makes an
 * open of a library held elsewhere fail at once. */
const DATABASE_OPTIONS = {timeout: 0, defensive: true, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false} as const;
/** The files SQLite may put beside the library; each must be a managed file. */
const COMPANIONS = ['', '-journal', '-wal', '-shm'] as const;

/** App library files this process has open, by file identity. A second open
 * fails before SQLite touches the file. */
const heldLibraries = new Map<string, DatabaseSync>();
const identityKey = (info: BigIntStats, file: string): string => info.ino ? `${info.dev}:${info.ino}` : `path:${file}`;

/** The app library's one connection. */
export interface AppDatabase {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  readonly file: string;
  /** A prepared statement, cached per SQL text; APP_LIBRARY_CLOSED once closed. */
  statement(sql: string): StatementSync;
  /** Runs `write` in its own transaction, or in a savepoint when a transaction
   * is already open, so the stores' writes compose with a caller's tx. */
  atomically<T>(write: () => T): T;
  /** A transaction for callers, with the rules of the project store's tx:
   * a synchronous callback and result, no nesting. */
  tx<T>(callback: () => T): T;
  readonly closed: boolean;
  close(): void;
}

const pragma = (db: DatabaseSync, name: string): unknown => {
  const row = db.prepare(`PRAGMA ${name}`).get();
  return row === undefined ? undefined : Object.values(row)[0];
};
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as {then?: unknown}).then === 'function';

function openFailure(error: unknown): unknown {
  if (error instanceof AppError || error instanceof PrivateStorageError) return error;
  const failure = isSqliteBusy(error) ? appLibraryError('APP_LIBRARY_LOCKED')
    : appLibraryInvalid(isSqliteCorrupt(error) ? 'corrupt' : isSqliteReadOnly(error) ? 'read-only' : 'unusable');
  failure.cause = error;
  return failure;
}

/** Rollback journal, full sync, journals cut to 0 bytes, and exclusive
 * locking: the lock taken at the open is kept until close(), so no other
 * process reads or writes the library meanwhile. */
function configure(db: DatabaseSync): void {
  db.exec('PRAGMA trusted_schema=OFF');
  if (pragma(db, 'trusted_schema') !== 0) throw new Error('Trusted schema must be disabled');
  if (pragma(db, 'foreign_keys') !== 1) throw new Error('Foreign-key enforcement must be enabled');
  db.exec('PRAGMA cell_size_check=ON');
  db.exec('PRAGMA locking_mode=EXCLUSIVE');
  if (pragma(db, 'main.journal_mode=DELETE') !== 'delete') throw appLibraryInvalid('journal-mode');
  db.exec('PRAGMA main.synchronous=FULL');
  if (pragma(db, 'main.synchronous') !== 2) throw new Error('The app library must sync fully');
  if (pragma(db, 'main.journal_size_limit=0') !== 0) throw new Error('The app library must limit its journal');
  // Takes the write lock now and keeps it (exclusive locking mode).
  db.exec('BEGIN EXCLUSIVE; COMMIT');
}

/** Version, identity, encoding and the exact structure of a library that is
 * not empty. A newer version is reported before any other mismatch. */
function checkStructure(db: DatabaseSync): void {
  if (pragma(db, 'main.application_id') !== APP_LIBRARY_APPLICATION_ID) throw appLibraryInvalid('application-id');
  if (pragma(db, 'encoding') !== 'UTF-8') throw appLibraryInvalid('encoding');
  const definition = db.prepare("SELECT sql FROM main.sqlite_master WHERE type='table' AND name='schema_version'").get();
  if (definition?.sql !== APP_SCHEMA_VERSION_TABLE_SQL) throw appLibraryInvalid('schema-version');
  const versions = db.prepare('SELECT max(version) AS version,count(*) AS count FROM main.schema_version').get();
  if (typeof versions?.version === 'number' && versions.version > APP_LIBRARY_SCHEMA_VERSION) {
    throw appLibraryError('APP_LIBRARY_FORMAT_NEWER', {formatVersion: versions.version, supportedFormatVersion: APP_LIBRARY_SCHEMA_VERSION});
  }
  if (versions?.count !== 1 || versions.version !== APP_LIBRARY_SCHEMA_VERSION) throw appLibraryInvalid('schema-version');
  const differences = compareAppSchema(readAppSchema(db));
  if (differences.length > 0) throw appLibraryInvalid('schema', differences);
}

function managedFiles(dataDir: string, file: string): void {
  for (const suffix of COMPANIONS) validateManagedFile(`${file}${suffix}`, {root: dataDir, allowMissing: true});
}

/** Opens `<dataDir>/app-library.db` under the private storage rules: the data
 * directory is a private directory (created when missing), the library and its
 * journal are managed files. A missing library is created 0600 and built; an
 * existing one must match the current structure exactly. Outside SQLite the
 * file is only lstat'ed, apart from creating it empty before SQLite first opens
 * it: closing any other descriptor of an open library would drop SQLite's
 * POSIX locks on it. */
export function openAppDatabase(requestedDataDir: string): AppDatabase {
  if (typeof requestedDataDir !== 'string' || requestedDataDir === '') throw new TypeError('The app data directory is required');
  const dataDir = path.resolve(requestedDataDir);
  ensurePrivateDirectory(dataDir, {create: true});
  const file = path.join(dataDir, APP_LIBRARY_FILE);
  managedFiles(dataDir, file);
  const existing = lstatSync(file, {bigint: true, throwIfNoEntry: false});
  if (existing && heldLibraries.get(identityKey(existing, file))?.isOpen) throw appLibraryError('APP_LIBRARY_LOCKED');
  if (!existing) {
    try {
      // An empty file is an empty database; SQLite gives its journal the same mode.
      closeSync(openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600));
    } catch (error) {
      // Created meanwhile by another opener: SQLite's lock decides below.
      if ((error as {code?: unknown}).code !== 'EEXIST') throw openFailure(error);
    }
  }
  managedFiles(dataDir, file);
  let db: DatabaseSync | undefined;
  let key: string;
  try {
    db = new DatabaseSync(file, DATABASE_OPTIONS);
    configure(db);
    if (db.prepare('SELECT count(*) AS n FROM main.sqlite_master').get()?.n === 0) {
      db.exec('BEGIN');
      try {
        buildAppLibrary(db);
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    } else {
      checkStructure(db);
    }
    key = identityKey(lstatSync(file, {bigint: true}), file);
  } catch (error) {
    try { db?.close(); } catch {}
    throw openFailure(error);
  }
  const connection = db;
  heldLibraries.set(key, connection);

  const statements = new Map<string, StatementSync>();
  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw appLibraryError('APP_LIBRARY_CLOSED');
  };
  const statement = (sql: string): StatementSync => {
    assertOpen();
    let prepared = statements.get(sql);
    if (!prepared) {
      prepared = connection.prepare(sql);
      statements.set(sql, prepared);
    }
    return prepared;
  };
  // A transaction owns its complete synchronous callback, as in the project store.
  const tx = <T>(callback: () => T): T => {
    if (typeof callback !== 'function' || isAsyncFunction(callback)) throw new TypeError('Transactions require a synchronous callback');
    assertOpen();
    if (connection.isTransaction) throw new Error('Nested transactions are not supported');
    connection.exec('BEGIN');
    try {
      const result = callback();
      if (isThenable(result)) {
        if (isPromise(result)) Promise.resolve(result).catch(() => {});
        throw new TypeError('Transactions require a synchronous result');
      }
      connection.exec('COMMIT');
      return result;
    } catch (error) {
      if (connection.isTransaction) connection.exec('ROLLBACK');
      throw error;
    }
  };
  let savepoints = 0;
  const atomically = <T>(write: () => T): T => {
    assertOpen();
    if (!connection.isTransaction) return tx(write);
    const name = `app_library_${++savepoints}`;
    connection.exec(`SAVEPOINT ${name}`);
    try {
      const result = write();
      connection.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      if (connection.isTransaction) connection.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw error;
    }
  };
  return {
    db: connection, dataDir, file, statement, atomically, tx,
    get closed() { return closed; },
    close(): void {
      if (closed) return;
      closed = true;
      statements.clear();
      try {
        connection.close();
      } finally {
        if (heldLibraries.get(key) === connection) heldLibraries.delete(key);
      }
    },
  };
}
