import type {DatabaseSync} from 'node:sqlite';
import {FORMAT4_HISTORY_SCHEMA_VERSION, FORMAT4_PROJECT_SCHEMA_VERSION, FORMAT5_HISTORY_SCHEMA_VERSION, FORMAT5_PROJECT_SCHEMA_VERSION, HISTORY_SCHEMA_VERSION, PROJECT_FILE_SCHEMA_VERSION, schemaStatements} from './databases.ts';
import {addFormat4HistoryStructureInside, addFormat4ProjectStructureInside, addFormat4ReceiptExpiryInside} from './format4-upgrade.ts';
import {FORMAT4_INITIAL_HISTORY_SCHEMA_VERSION} from './domains/canvas.ts';
import {EDITOR_HISTORY_SCHEMA, initializeEditorStorageCounters} from './domains/sequence.ts';

function requireVersion(db: DatabaseSync, schema: 'main' | 'project', version: number): void {
  if (!db.isTransaction) throw new TypeError('Format 5 requires an opening transaction');
  const rows = db.prepare(`SELECT version FROM ${schema}.schema_version LIMIT 2`).all();
  if (rows.length !== 1 || rows[0]?.version !== version) throw new Error('Format 5 migration requires the reviewed source version');
}
const qualify = (schema: 'main' | 'project', sql: string): string =>
  sql.replace(/^CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER) /u, `CREATE $1 ${schema}.`);
const objectName = (sql: string): string => /^CREATE (?:(?:UNIQUE )?INDEX|TABLE|TRIGGER) (\w+)/u.exec(sql)![1]!;

/** Source manifests and all converted row data are checked by the caller on
 * this held connection. TEMP cross-file guards are removed before table DDL. */
export function addFormat5ProjectStructureInside(db: DatabaseSync, schema: 'main' | 'project', sourceVersion: number): void {
  requireVersion(db, schema, sourceVersion);
  if (sourceVersion !== PROJECT_FILE_SCHEMA_VERSION && sourceVersion !== FORMAT4_PROJECT_SCHEMA_VERSION) throw new TypeError('Unsupported format 5 source');
  // A 3 -> 5 caller may already have added these internal columns before
  // writing its conversion plan. The version is still 3 until final commit.
  if (sourceVersion === PROJECT_FILE_SCHEMA_VERSION && !db.prepare(`PRAGMA ${schema}.table_xinfo(shots)`).all().some(column => column.name === 'archivedAt')) {
    addFormat4ProjectStructureInside(db, schema);
  }
  const statements = schemaStatements('project', undefined, FORMAT5_PROJECT_SCHEMA_VERSION);
  for (const table of ['edges', 'subject_bindings'] as const) {
    const staging = `__format5_${table}`;
    const columns = db.prepare(`PRAGMA ${schema}.table_xinfo(${table})`).all().map(column => String(column.name));
    const names = columns.map(name => `"${name}"`).join(',');
    db.exec(`CREATE TABLE ${schema}.${staging} AS SELECT ${names} FROM ${schema}.${table}`);
    db.exec(`DROP TABLE ${schema}.${table}`);
    const definition = statements.find(sql => sql.startsWith(`CREATE TABLE ${table}(`))!;
    db.exec(qualify(schema, definition));
    if (table === 'subject_bindings') {
      db.exec(`INSERT INTO ${schema}.${table}(${names},bindingMode) SELECT ${names},CASE WHEN subjectVersionId IS NULL THEN 'detached' ELSE 'locked' END FROM ${schema}.${staging}`);
    } else db.exec(`INSERT INTO ${schema}.${table}(${names}) SELECT ${names} FROM ${schema}.${staging}`);
    db.exec(`DROP TABLE ${schema}.${staging}`);
    for (const sql of statements) {
      if (/^CREATE (?:(?:UNIQUE )?INDEX|TRIGGER) /u.test(sql) && new RegExp(`\\bON ${table}\\b`, 'u').test(sql)) db.exec(qualify(schema, sql));
    }
  }
  const existing = new Set(db.prepare(`SELECT name FROM ${schema}.sqlite_master`).all().map(row => String(row.name)));
  for (const sql of statements) if (!existing.has(objectName(sql))) db.exec(qualify(schema, sql));
}

/** Existing local history is retained; the unified stack starts with no entry. */
export function addFormat5HistoryStructureInside(db: DatabaseSync, sourceVersion: number): void {
  requireVersion(db, 'main', sourceVersion);
  if (![HISTORY_SCHEMA_VERSION, FORMAT4_INITIAL_HISTORY_SCHEMA_VERSION, FORMAT4_HISTORY_SCHEMA_VERSION].includes(sourceVersion)) throw new TypeError('Unsupported format 5 history source');
  if (sourceVersion !== FORMAT4_HISTORY_SCHEMA_VERSION) {
    if (sourceVersion === FORMAT4_INITIAL_HISTORY_SCHEMA_VERSION) addFormat4ReceiptExpiryInside(db);
    else {
      addFormat4HistoryStructureInside(db, sourceVersion);
    }
  }
  for (const sql of EDITOR_HISTORY_SCHEMA) db.exec(qualify('main', sql));
  initializeEditorStorageCounters(db, 'main');
}

export function writeFormat5ProjectVersionInside(db: DatabaseSync, schema: 'main' | 'project', sourceVersion: number): void {
  requireVersion(db, schema, sourceVersion);
  db.exec(`PRAGMA ${schema}.user_version=${FORMAT5_PROJECT_SCHEMA_VERSION}`);
  db.prepare(`UPDATE ${schema}.schema_version SET version=?`).run(FORMAT5_PROJECT_SCHEMA_VERSION);
}
export function writeFormat5HistoryVersionInside(db: DatabaseSync, sourceVersion: number): void {
  requireVersion(db, 'main', sourceVersion);
  db.prepare('UPDATE main.schema_version SET version=?').run(FORMAT5_HISTORY_SCHEMA_VERSION);
}
