import type {DatabaseSync} from 'node:sqlite';
import {
  FORMAT4_ARCHIVE_SEQUENCE_TRIGGERS, FORMAT4_ARCHIVE_UPDATE_TRIGGERS,
  FORMAT4_HISTORY_SCHEMA_VERSION, FORMAT4_PROJECT_SCHEMA_VERSION, HISTORY_SCHEMA_VERSION, PROJECT_FILE_SCHEMA_VERSION,
} from './databases.ts';
import {CANVAS_ARCHIVE_INDEXES, CANVAS_ARCHIVE_TABLES, CANVAS_HISTORY_SCHEMA, canvasArchiveColumnDefinitions} from './domains/canvas.ts';

function requireVersion(db: DatabaseSync, schema: 'main' | 'project', version: number): void {
  if (!db.isTransaction) throw new TypeError('Format 4 requires an opening transaction');
  const rows = db.prepare(`SELECT version FROM ${schema}.schema_version LIMIT 2`).all();
  if (rows.length !== 1 || rows[0]?.version !== version) throw new Error('Format 4 migration requires the reviewed source version');
}

const qualify = (schema: 'main' | 'project', sql: string): string =>
  sql.replace(/^CREATE (TABLE|INDEX|TRIGGER) /u, `CREATE $1 ${schema}.`);

/** The caller has validated the old catalog on the same locked descriptor. */
export function addFormat4ProjectStructureInside(db: DatabaseSync, schema: 'main' | 'project'): void {
  requireVersion(db, schema, PROJECT_FILE_SCHEMA_VERSION);
  for (const table of CANVAS_ARCHIVE_TABLES) {
    for (const definition of canvasArchiveColumnDefinitions(table)) db.exec(`ALTER TABLE ${schema}.${table} ADD COLUMN ${definition}`);
    db.exec(`DROP TRIGGER ${schema}.agent_target_${table}_update_v2; DROP TRIGGER ${schema}.project_file_sequence_${table}_update`);
  }
  // SQLite fires the sequence trigger before the revision update, as in a
  // freshly built project. Both writes advance the current content stamp.
  for (const sql of [...CANVAS_ARCHIVE_INDEXES, ...FORMAT4_ARCHIVE_UPDATE_TRIGGERS, ...FORMAT4_ARCHIVE_SEQUENCE_TRIGGERS]) db.exec(qualify(schema, sql));
}

export function writeFormat4ProjectVersionInside(db: DatabaseSync, schema: 'main' | 'project'): void {
  requireVersion(db, schema, PROJECT_FILE_SCHEMA_VERSION);
  db.exec(`PRAGMA ${schema}.user_version=${FORMAT4_PROJECT_SCHEMA_VERSION}`);
  db.prepare(`UPDATE ${schema}.schema_version SET version=?`).run(FORMAT4_PROJECT_SCHEMA_VERSION);
}

/** A private copy target has no source history to migrate. */
export function upgradeProject3To4Inside(db: DatabaseSync, schema: 'main' | 'project'): void {
  addFormat4ProjectStructureInside(db, schema);
  writeFormat4ProjectVersionInside(db, schema);
}

export function addFormat4HistoryStructureInside(db: DatabaseSync): void {
  requireVersion(db, 'main', HISTORY_SCHEMA_VERSION);
  for (const sql of CANVAS_HISTORY_SCHEMA) db.exec(qualify('main', sql));
}

export function writeFormat4HistoryVersionInside(db: DatabaseSync): void {
  requireVersion(db, 'main', HISTORY_SCHEMA_VERSION);
  db.prepare('UPDATE main.schema_version SET version=?').run(FORMAT4_HISTORY_SCHEMA_VERSION);
}
