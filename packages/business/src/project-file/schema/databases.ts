import type {DatabaseSync} from 'node:sqlite';
import {PROJECT_FILE_SINGLE_PROJECT} from '../../../../contracts/src/project-file.ts';
import type {PROJECT_DATABASE_NAMES} from '../../../../contracts/src/project-file.ts';
import {CACHE_SCHEMA} from './domains/cache.ts';
import {CONTENT_SCHEMA} from './domains/content.ts';
import {MIO_SCHEMA} from './domains/mio.ts';
import {RECEIPT_SCHEMA} from './domains/receipts.ts';
import {TASK_SCHEMA} from './domains/tasks.ts';
import {TIMELINE_HISTORY_SCHEMA} from './domains/timeline-history.ts';
import {CONTENT_TABLES} from './tables.ts';

/** The three SQLite databases of one project: the project file itself, the
 * local history database and the rebuildable cache database. Their file names
 * and schema names on the kernel connection are the contract's
 * PROJECT_HISTORY_FILE, PROJECT_CACHE_FILE and PROJECT_DATABASE_NAMES. */
export type DatabaseKind = keyof typeof PROJECT_DATABASE_NAMES;

/** Changing a database's DDL requires raising its version, regenerating
 * schema/manifest.ts (`node tests/helpers/project-file-schema-derivation.ts --write`)
 * and recording the new manifest digest in tests/project-file-schema.test.ts. */
export const PROJECT_FILE_SCHEMA_VERSION = 1;
export const HISTORY_SCHEMA_VERSION = 1;
export const CACHE_SCHEMA_VERSION = 1;

/** SQLite header `application_id` values: 'MioP', 'MioH' and 'MioC'. */
export const PROJECT_FILE_APPLICATION_ID = 0x4d696f50;
export const HISTORY_APPLICATION_ID = 0x4d696f48;
export const CACHE_APPLICATION_ID = 0x4d696f43;

/** The format-72 definition, kept by each of the three databases. */
export const SCHEMA_VERSION_TABLE_SQL = 'CREATE TABLE schema_version(version INTEGER PRIMARY KEY)';

const SCHEMA_VERSIONS: Readonly<Record<DatabaseKind, number>> = {
  project: PROJECT_FILE_SCHEMA_VERSION, history: HISTORY_SCHEMA_VERSION, cache: CACHE_SCHEMA_VERSION,
};
const APPLICATION_IDS: Readonly<Record<DatabaseKind, number>> = {
  project: PROJECT_FILE_APPLICATION_ID, history: HISTORY_APPLICATION_ID, cache: CACHE_APPLICATION_ID,
};

/** The single metadata row of a project file. `contentSequence` grows by at
 * least one in every commit that changes a content table and never decreases. */
const PROJECT_FILE_METADATA: readonly string[] = Object.freeze([
  "CREATE TABLE project_file(singleton INTEGER PRIMARY KEY CHECK(singleton=1),projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),contentSequence INTEGER NOT NULL CHECK(typeof(contentSequence)='integer' AND contentSequence BETWEEN 0 AND 9007199254740991))",
  // BEFORE INSERT also rejects INSERT OR REPLACE over the existing row.
  "CREATE TRIGGER project_file_guard_insert BEFORE INSERT ON project_file WHEN EXISTS(SELECT 1 FROM project_file) BEGIN SELECT RAISE(ABORT,'PROJECT_FILE_METADATA_EXISTS');END",
  "CREATE TRIGGER project_file_guard_delete BEFORE DELETE ON project_file BEGIN SELECT RAISE(ABORT,'PROJECT_FILE_METADATA_REQUIRED');END",
  "CREATE TRIGGER project_file_guard_identity BEFORE UPDATE OF singleton,projectId ON project_file WHEN NEW.singleton IS NOT OLD.singleton OR NEW.projectId IS NOT OLD.projectId BEGIN SELECT RAISE(ABORT,'PROJECT_FILE_IDENTITY_IMMUTABLE');END",
  "CREATE TRIGGER project_file_guard_sequence BEFORE UPDATE OF contentSequence ON project_file WHEN NEW.contentSequence<OLD.contentSequence BEGIN SELECT RAISE(ABORT,'PROJECT_FILE_SEQUENCE_DECREASED');END",
]);

/** A project file holds exactly the project named by its metadata row. The check
 * compares IDs instead of counting rows because an UPSERT fires BEFORE INSERT first. */
const SINGLE_PROJECT_TRIGGERS: readonly string[] = Object.freeze([
  `CREATE TRIGGER project_file_single_project_insert BEFORE INSERT ON projects WHEN NEW.id IS NOT (SELECT projectId FROM project_file) BEGIN SELECT RAISE(ABORT,'${PROJECT_FILE_SINGLE_PROJECT}');END`,
  `CREATE TRIGGER project_file_single_project_update BEFORE UPDATE OF id ON projects WHEN NEW.id IS NOT (SELECT projectId FROM project_file) BEGIN SELECT RAISE(ABORT,'${PROJECT_FILE_SINGLE_PROJECT}');END`,
]);

/** Persistent row triggers, so every writer (autocommit statements, other
 * connections) advances the sequence. Created last, so they fire before the
 * format-72 triggers of the same table. */
const CONTENT_SEQUENCE_TRIGGERS: readonly string[] = Object.freeze(CONTENT_TABLES.flatMap(table =>
  (['insert', 'update', 'delete'] as const).map(operation =>
    `CREATE TRIGGER project_file_sequence_${table}_${operation} AFTER ${operation.toUpperCase()} ON ${table} BEGIN UPDATE project_file SET contentSequence=contentSequence+1;END`)));

/** The single state row of a local history database: which project it records
 * and the last project-file content sequence it has seen. */
const HISTORY_STATE_METADATA: readonly string[] = Object.freeze([
  "CREATE TABLE history_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36),seenContentSequence INTEGER NOT NULL CHECK(typeof(seenContentSequence)='integer' AND seenContentSequence BETWEEN 0 AND 9007199254740991))",
  "CREATE TRIGGER history_state_guard_insert BEFORE INSERT ON history_state WHEN EXISTS(SELECT 1 FROM history_state) BEGIN SELECT RAISE(ABORT,'HISTORY_STATE_EXISTS');END",
  "CREATE TRIGGER history_state_guard_delete BEFORE DELETE ON history_state BEGIN SELECT RAISE(ABORT,'HISTORY_STATE_REQUIRED');END",
  "CREATE TRIGGER history_state_guard_identity BEFORE UPDATE OF singleton,projectId ON history_state WHEN NEW.singleton IS NOT OLD.singleton OR NEW.projectId IS NOT OLD.projectId BEGIN SELECT RAISE(ABORT,'HISTORY_STATE_IDENTITY_IMMUTABLE');END",
]);

const DOMAIN_STATEMENTS: Readonly<Record<DatabaseKind, readonly string[]>> = {
  project: CONTENT_SCHEMA,
  history: [...RECEIPT_SCHEMA, ...TASK_SCHEMA, ...TIMELINE_HISTORY_SCHEMA, ...MIO_SCHEMA],
  cache: CACHE_SCHEMA,
};

/** Complete DDL of one database: `schema_version`, its metadata table, the domain
 * files in order and the triggers this kernel adds. `domainStatements` replaces
 * the committed domain files; only the schema derivation passes it. */
export function schemaStatements(kind: DatabaseKind, domainStatements: readonly string[] = DOMAIN_STATEMENTS[kind]): readonly string[] {
  if (kind === 'project') return [SCHEMA_VERSION_TABLE_SQL, ...PROJECT_FILE_METADATA, ...domainStatements, ...SINGLE_PROJECT_TRIGGERS, ...CONTENT_SEQUENCE_TRIGGERS];
  if (kind === 'history') return [SCHEMA_VERSION_TABLE_SQL, ...HISTORY_STATE_METADATA, ...domainStatements];
  return [SCHEMA_VERSION_TABLE_SQL, ...domainStatements];
}

const CREATE_PREFIX = /^CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER) /;

/** Creates one database inside the caller's open transaction, as `schema`
 * (`main` or an attached name), then writes its application_id and version. */
export function buildDatabase(db: DatabaseSync, kind: DatabaseKind, schema: string, statements: readonly string[] = schemaStatements(kind)): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new TypeError(`Invalid schema name: ${schema}`);
  if (!db.isTransaction) throw new Error('Building a database requires an open transaction');
  for (const sql of statements) {
    if (!CREATE_PREFIX.test(sql)) throw new Error(`Schema statement cannot be qualified: ${sql.slice(0, 60)}`);
    db.exec(sql.replace(CREATE_PREFIX, `CREATE $1 ${schema}.`));
  }
  db.exec(`PRAGMA ${schema}.application_id=${APPLICATION_IDS[kind]}`);
  db.prepare(`INSERT INTO ${schema}.schema_version VALUES(?)`).run(SCHEMA_VERSIONS[kind]);
}
