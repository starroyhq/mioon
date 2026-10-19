// Genuine historical workspace fixtures for image/colour backup, restore and
// reopen tests. The frozen schema is always constructed with its own reviewed
// initializer chain (never by deleting markers or stripping guards from a
// current workspace). Reviewed retained rows are materialized from an owned
// current-runtime seed database with SQL copies so rowids, storage classes and
// raw JSON/BLOB bytes are preserved. Media files referenced by those rows are
// byte-copied from the seeded workspace.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {classifyCurrentWorkspaceSchema} from '../../packages/business/src/db.ts';
import {initializeWorkspaceSchemaThrough24} from '../../packages/business/src/workspace-fixed-schema.ts';
import {initializeWorkspaceSchema26} from '../../packages/business/src/workspace-schema-v26.ts';
import {initializeWorkspaceSchema28} from '../../packages/business/src/workspace-schema-v28.ts';
import {initializeWorkspaceSchema30} from '../../packages/business/src/workspace-schema-v30.ts';
import {initializeWorkspaceSchema32} from '../../packages/business/src/workspace-schema-v32.ts';
import {initializeWorkspaceSchema34} from '../../packages/business/src/workspace-schema-v34.ts';
import {initializeWorkspaceSchema36} from '../../packages/business/src/workspace-schema-v36.ts';
import {initializeWorkspaceSchema38} from '../../packages/business/src/workspace-schema-v38.ts';
import {initializeWorkspaceSchema40} from '../../packages/business/src/workspace-schema-v40.ts';

const quote = (value: string): string => '"' + value.replaceAll('"', '""') + '"';
const frozenConstructors = Object.freeze([
  [26, initializeWorkspaceSchema26], [28, initializeWorkspaceSchema28],
  [30, initializeWorkspaceSchema30], [32, initializeWorkspaceSchema32],
  [34, initializeWorkspaceSchema34], [36, initializeWorkspaceSchema36],
  [38, initializeWorkspaceSchema38], [40, initializeWorkspaceSchema40],
] as const);
export const HISTORICAL_WORKSPACE_VERSIONS: readonly number[] = Object.freeze(frozenConstructors.map(([version]) => version));

/** Construct exactly one reviewed ordinary historical schema. */
export function initializeHistoricalWorkspaceSchema(db: DatabaseSync, version: number): void {
  assert.ok(HISTORICAL_WORKSPACE_VERSIONS.includes(version), `Unsupported historical workspace schema ${version}.`);
  assert.equal(db.prepare('SELECT 1 FROM main.sqlite_schema LIMIT 1').get(), undefined, 'historical constructor needs an empty database');
  db.exec('PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF;');
  initializeWorkspaceSchemaThrough24(db);
  for (const [schema, initialize] of frozenConstructors) if (schema <= version) initialize(db);
  assert.deepEqual(classifyCurrentWorkspaceSchema(db), {schemaVersion: version, profile: 'ordinary'});
}

export interface HistoricalWorkspaceOptions {
  /** Reviewed frozen ordinary schema to construct (26/28/30/32/34/36/38/40). */
  readonly version: number;
  /** Copy the seeded workspace media directory byte-identically. */
  readonly media?: boolean;
}

/** Materialize the frozen ordinary workspace in `destination` from the seed
 * store at `seeded.root`. The seed store may be open or closed; only committed
 * bytes are copied. Returns the new workspace root and database path. */
export function materializeHistoricalWorkspace(
  seeded: {readonly root: string},
  destination: string,
  {version, media = true}: HistoricalWorkspaceOptions,
): {root: string; dbPath: string} {
  fs.mkdirSync(destination, {recursive: true, mode: 0o700});
  const dbPath = path.join(destination, 'workbench.sqlite'), db = new DatabaseSync(dbPath);
  try {
    initializeHistoricalWorkspaceSchema(db, version);
    db.prepare('ATTACH DATABASE ? AS seeded').run(path.join(seeded.root, 'workbench.sqlite'));
    const tables = db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' ORDER BY name").all().map(value => value.name as string);
    db.exec('BEGIN IMMEDIATE;PRAGMA defer_foreign_keys=ON;');
    try {
      for (const table of tables) {
        if (table === 'schema_version' || table === 'sqlite_sequence') continue;
        const fields = db.prepare(`PRAGMA main.table_info(${quote(table)})`).all().map(value => value.name as string);
        const columns = ['rowid', ...fields.map(quote)].join(',');
        const read = (schema: 'main' | 'seeded') => {
          const statement = db.prepare(`SELECT ${columns} FROM ${schema}.${quote(table)} ORDER BY rowid`);
          statement.setReadBigInts(true);
          return statement.all();
        };
        // Frozen constructors seed fixed quota/default rows; they must already
        // match the untouched service defaults. Only then copy retained rows.
        if (read('main').length === 0) db.exec(`INSERT INTO main.${quote(table)}(${columns}) SELECT ${columns} FROM seeded.${quote(table)} ORDER BY rowid`);
        assert.deepEqual(read('main'), read('seeded'), `${table} retains every raw seeded cell`);
      }
      db.exec('DELETE FROM main.sqlite_sequence');
      db.prepare(`INSERT INTO main.sqlite_sequence(rowid,name,seq) SELECT rowid,name,seq FROM seeded.sqlite_sequence WHERE name IN (${tables.map(() => '?').join(',')}) ORDER BY rowid`).run(...tables);
      assert.deepEqual(db.prepare('PRAGMA main.foreign_key_check').all(), []);
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
    db.exec('DETACH DATABASE seeded');
    if (media) {
      const source = path.join(seeded.root, 'media');
      if (fs.existsSync(source)) fs.cpSync(source, path.join(destination, 'media'), {recursive: true, preserveTimestamps: true});
    }
    assert.deepEqual(classifyCurrentWorkspaceSchema(db), {schemaVersion: version, profile: 'ordinary'});
    return {root: destination, dbPath};
  } finally {
    if (db.isOpen) {
      try { db.exec('DETACH DATABASE seeded'); } catch { /* already detached */ }
      db.close();
    }
    fs.chmodSync(dbPath, 0o600);
  }
}
