import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
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
import {logicalTables} from './opacity-backup-fixture.ts';

const quote = (value: string): string => '"' + value.replaceAll('"', '""') + '"';

/** Frozen constructors only; the current runtime is never an old-schema seed. */
export function initializeFrozenUpgradeFixtureSchema(db: DatabaseSync, version = 40): void {
  assert.ok(version === 38 || version === 40);
  assert.equal(db.prepare('SELECT 1 FROM main.sqlite_schema LIMIT 1').get(), undefined);
  db.exec('PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF;');
  initializeWorkspaceSchemaThrough24(db);
  for (const [index, initialize] of [initializeWorkspaceSchema26, initializeWorkspaceSchema28, initializeWorkspaceSchema30,
    initializeWorkspaceSchema32, initializeWorkspaceSchema34, initializeWorkspaceSchema36, initializeWorkspaceSchema38,
    initializeWorkspaceSchema40].entries()) if (26 + index * 2 <= version) initialize(db);
  assert.deepEqual(classifyCurrentWorkspaceSchema(db), {schemaVersion: version, profile: 'ordinary'});
}

/** Real services produce ACK/receipt evidence in an owned current runtime.
 * Materialize only the frozen40 tables/columns in a separate fresh database:
 * never relabel, downgrade, or remove guards from a current workspace. SQL
 * copies preserve rowids, storage classes and raw JSON/BLOB bytes. */
export function copyFrozenUpgradeFixtureDatabase(source: string, seeded: {readonly root: string}, {version = 40}: {version?: number} = {}): Record<string, unknown> {
  fs.mkdirSync(source, {mode: 0o700});
  const file = path.join(source, 'workbench.sqlite'), db = new DatabaseSync(file);
  try {
    initializeFrozenUpgradeFixtureSchema(db, version);
    db.prepare('ATTACH DATABASE ? AS seeded').run(path.join(seeded.root, 'workbench.sqlite'));
    const names = (db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' ORDER BY name").all() as {name: string}[]).map((row: {name: string}) => row.name);
    db.exec('BEGIN IMMEDIATE;PRAGMA defer_foreign_keys=ON;');
    try {
      for (const table of names) {
        if (table === 'schema_version' || table === 'sqlite_sequence') continue;
        const fields = (db.prepare(`PRAGMA main.table_info(${quote(table)})`).all() as {name: string}[]).map((row: {name: string}) => row.name);
        const columns = ['rowid', ...fields.map(quote)].join(',');
        const read = (schema: string): unknown[] => { const statement = db.prepare(`SELECT ${columns} FROM ${schema}.${quote(table)} ORDER BY rowid`); statement.setReadBigInts(true); return statement.all(); };
        // Frozen constructors seed quota rows. They must already match the
        // untouched service defaults; do not delete or bypass their guards.
        if (read('main').length === 0) db.exec(`INSERT INTO main.${quote(table)}(${columns}) SELECT ${columns} FROM seeded.${quote(table)} ORDER BY rowid`);
        assert.deepEqual(read('main'), read('seeded'), `${table} retains every raw legacy cell`);
      }
      db.exec('DELETE FROM main.sqlite_sequence');
      db.prepare(`INSERT INTO main.sqlite_sequence(rowid,name,seq) SELECT rowid,name,seq FROM seeded.sqlite_sequence WHERE name IN (${names.map(() => '?').join(',')}) ORDER BY rowid`).run(...names);
      assert.deepEqual(db.prepare('PRAGMA main.foreign_key_check').all(), []);
      db.exec('COMMIT');
    } catch (error) {if (db.isTransaction) db.exec('ROLLBACK'); throw error;}
    db.exec('DETACH DATABASE seeded');
    assert.deepEqual(classifyCurrentWorkspaceSchema(db), {schemaVersion: version, profile: 'ordinary'});
    return logicalTables(db);
  } finally {db.close(); fs.chmodSync(file, 0o600);}
}

