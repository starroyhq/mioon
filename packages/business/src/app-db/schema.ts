import {DatabaseSync} from 'node:sqlite';
import {LAST_PROJECT_LIMITS} from '../../../contracts/src/last-project.ts';
import {UI_PREFERENCES_LIMITS} from '../../../contracts/src/ui-preferences.ts';
import {BACKGROUND_TASK_INDEX_LIMITS, backgroundTaskIndexEntryV3Schema} from '../../../contracts/src/project-registry.ts';
import {PREVIOUS_APP_STATEMENTS} from './schema-previous.ts';

/** The app library: one SQLite file in the app data directory for what
 * belongs to this computer rather than to one project (PROJECT-FILE.md,
 * "登记与记录"). It is never attached to a project connection. */
export const APP_LIBRARY_FILE = 'app-library.db';
/** Raising it means changing the DDL below; the manifest digest in
 * tests/app-db-library.test.ts records the current structure. */
export const APP_LIBRARY_SCHEMA_VERSION = 4;
/** SQLite header `application_id`: 'MioA', next to the kernel's 'MioP', 'MioH'
 * and 'MioC', so the app library is never taken for a project file. */
export const APP_LIBRARY_APPLICATION_ID = 0x4d696f41;
/** The same definition as the three project databases keep. */
export const APP_SCHEMA_VERSION_TABLE_SQL = 'CREATE TABLE schema_version(version INTEGER PRIMARY KEY)';

/** Canonical application-owned policy and preference declarations. The legacy
 * constant name records their origin; the project schema checker no longer
 * reconstructs them from a workspace. `workspace_preferences` has no FK to `projects`
 * (the registry is checked in code instead), and the policy receipts retained
 * without the deletion-bookkeeping exemption. The four quota triggers on the
 * policy tables are not built: the app library has no Mio quota. */
export const FORMAT_72_APP_STATEMENTS: readonly string[] = Object.freeze([
  'CREATE TABLE agent_task_policy_v2(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB))<=65536))',
  'CREATE TABLE agent_task_policy_requests_v2(requestId TEXT PRIMARY KEY NOT NULL,digest TEXT NOT NULL CHECK(length(digest)=64),data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB))<=65536))',
  'CREATE TABLE workspace_preferences(\n projectId TEXT PRIMARY KEY,\n revision INTEGER NOT NULL CHECK(revision>0 AND revision<=9007199254740991),\n state TEXT NOT NULL CHECK(json_valid(state) AND length(CAST(state AS BLOB))<=16384))',
  "CREATE TRIGGER immutable_agent_task_policy_requests_v2 BEFORE UPDATE ON agent_task_policy_requests_v2 BEGIN SELECT RAISE(ABORT,'Agent task evidence is immutable');END",
  "CREATE TRIGGER retain_agent_task_policy_requests_v2 BEFORE DELETE ON agent_task_policy_requests_v2 BEGIN SELECT RAISE(ABORT,'Agent task evidence must be retained');END",
]);

/** The three JSON files of the app data directory the app library takes over,
 * by their file names, with the size limits the files had. */
export const APP_DOCUMENT_LIMITS_V1 = Object.freeze({
  'ui-preferences-v1.json': UI_PREFERENCES_LIMITS.fileBytes,
  // workspace-configuration.ts's MAX_BYTES.
  'workspace-settings-v1.json': 16 * 1024,
  'last-project-v1.json': LAST_PROJECT_LIMITS.fileBytes,
});
export const APP_DOCUMENT_LIMITS = Object.freeze({...APP_DOCUMENT_LIMITS_V1,
  // Five bounded fields only; never model input, output or credentials.
  'agent-diagnostic-summary-v1.json': 4096,
});
export type AppDocumentName = keyof typeof APP_DOCUMENT_LIMITS;
export const APP_DOCUMENT_NAMES = Object.freeze(Object.keys(APP_DOCUMENT_LIMITS) as AppDocumentName[]);

/** Upper bounds of the JSON stored per record. Records that pass their
 * project-registry.ts schema stay below them; the CHECKs are a backstop. */
export const APP_RECORD_LIMITS = Object.freeze({
  recentProject: 65536, rulesTrust: 4096, outsidePath: 32768, taskIndex: 32768, inboxItem: 262144, receiptResponse: 65536,
});

function documentTable(limits: Readonly<Record<string, number>>): string {
  const names = Object.keys(limits).map(name => `'${name}'`).join(',');
  const sizes = Object.entries(limits).map(([name, bytes]) => `WHEN '${name}' THEN ${bytes}`).join(' ');
  return `CREATE TABLE app_documents(name TEXT PRIMARY KEY NOT NULL CHECK(name IN (${names})),data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB))<=CASE name ${sizes} ELSE 0 END))`;
}
const json = (column: string, bytes: number): string => `json_valid(${column}) AND length(CAST(${column} AS BLOB))<=${bytes}`;
const projectIdColumn = 'projectId TEXT NOT NULL CHECK(length(CAST(projectId AS BLOB))=36)';
export const USER_RULES_TABLE_SQL = "CREATE TABLE user_rules(singleton INTEGER PRIMARY KEY CHECK(singleton=1),text TEXT NOT NULL CHECK(typeof(text)='text' AND length(CAST(text AS BLOB))<=8192),revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),updatedAt TEXT NOT NULL)";

const TASK_PHASES = "'prepared','active','blocked','archived','done'";
const projection = (field: string, type: string, absent: string): string =>
  `((json_type(data,'$.${field}') IS NULL AND ${field} IS ${absent}) OR (json_type(data,'$.${field}') IS '${type}' AND ${field} IS json_extract(data,'$.${field}')))`;
/** Empty sourceHistory is the SQL-only spelling of a missing legacy source.
 * It makes NULL generations unique without changing their public meaning. */
export const BACKGROUND_TASK_INDEX_TABLE_SQL = `CREATE TABLE background_task_index(${projectIdColumn},kind TEXT NOT NULL CHECK(kind IN ('job','export','edit_task','image_task','frame_task','scene_task','subject_variant_batch')),taskId TEXT NOT NULL CHECK(typeof(taskId)='text' AND length(CAST(taskId AS BLOB))=36),sourceHistory TEXT NOT NULL CHECK(typeof(sourceHistory)='text' AND (sourceHistory='' OR (length(sourceHistory)=64 AND length(CAST(sourceHistory AS BLOB))=64 AND sourceHistory NOT GLOB '*[^0-9a-f]*'))),phase TEXT NOT NULL CHECK(phase IN (${TASK_PHASES})),reason TEXT CHECK(reason IS NULL OR (typeof(reason)='text' AND length(CAST(reason AS BLOB)) BETWEEN 1 AND 800)),revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),taskRevision INTEGER NOT NULL CHECK(typeof(taskRevision)='integer' AND taskRevision BETWEEN 0 AND 9007199254740991),data TEXT NOT NULL CHECK(typeof(data)='text' AND ${json('data', APP_RECORD_LIMITS.taskIndex)} AND json_type(data) IS 'object' AND json_extract(data,'$.projectId') IS projectId AND json_extract(data,'$.kind') IS kind AND json_extract(data,'$.taskId') IS taskId AND ${projection('phase', 'text', "'prepared'")} AND ${projection('revision', 'integer', '1')} AND ${projection('taskRevision', 'integer', '0')} AND ((json_type(data,'$.sourceHistory') IS NULL OR json_type(data,'$.sourceHistory') IS 'null') AND sourceHistory='' OR json_type(data,'$.sourceHistory') IS 'text' AND sourceHistory<>'' AND sourceHistory IS json_extract(data,'$.sourceHistory')) AND ((json_type(data,'$.reason') IS NULL AND reason IS 'INDEX_UNVERIFIED') OR (json_type(data,'$.reason') IS 'null' AND reason IS NULL) OR (json_type(data,'$.reason') IS 'text' AND reason IS json_extract(data,'$.reason')))),PRIMARY KEY(projectId,kind,taskId,sourceHistory))`;
export const BACKGROUND_TASK_INDEX_SQL: readonly string[] = Object.freeze([
  BACKGROUND_TASK_INDEX_TABLE_SQL,
  'CREATE INDEX background_task_index_project_phase ON background_task_index(projectId,phase)',
  `CREATE TRIGGER background_task_index_guard_insert BEFORE INSERT ON background_task_index BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM background_task_index WHERE (projectId IS NEW.projectId AND kind IS NEW.kind AND taskId IS NEW.taskId AND sourceHistory IS NEW.sourceHistory) OR rowid IS NEW.rowid) THEN RAISE(ABORT,'BACKGROUND_TASK_INDEX_CONFLICT') END;SELECT CASE WHEN (SELECT count(*) FROM background_task_index)>=${BACKGROUND_TASK_INDEX_LIMITS.application} OR (SELECT count(*) FROM background_task_index WHERE projectId IS NEW.projectId)>=${BACKGROUND_TASK_INDEX_LIMITS.project} THEN RAISE(ABORT,'BACKGROUND_TASK_INDEX_LIMIT') END;END`,
  "CREATE TRIGGER background_task_index_guard_update BEFORE UPDATE ON background_task_index WHEN OLD.phase='archived' OR NEW.projectId IS NOT OLD.projectId OR NEW.kind IS NOT OLD.kind OR NEW.taskId IS NOT OLD.taskId OR NEW.sourceHistory IS NOT OLD.sourceHistory OR NEW.rowid IS NOT OLD.rowid OR NEW.revision<=OLD.revision OR NEW.taskRevision<OLD.taskRevision BEGIN SELECT RAISE(ABORT,'BACKGROUND_TASK_INDEX_CONFLICT');END",
  "CREATE TRIGGER retain_background_task_archive BEFORE DELETE ON background_task_index WHEN OLD.phase='archived' BEGIN SELECT RAISE(ABORT,'BACKGROUND_TASK_INDEX_CONFLICT');END",
  "CREATE TRIGGER background_task_index_positive_rowid AFTER INSERT ON background_task_index WHEN NEW.rowid<=0 BEGIN SELECT RAISE(ABORT,'BACKGROUND_TASK_INDEX_CONFLICT');END",
]);

/** What the app library adds. Every record is the JSON of its
 * project-registry.ts schema, checked on every write and read; the key columns
 * repeat fields of that JSON, and the CHECKs keep the two equal. */
export const APP_LIBRARY_STATEMENTS: readonly string[] = Object.freeze([
  // ui-preferences-v1.json, workspace-settings-v1.json and last-project-v1.json, as they were written.
  documentTable(APP_DOCUMENT_LIMITS),
  // Recent projects in the order they were first registered.
  `CREATE TABLE recent_projects(position INTEGER PRIMARY KEY,projectId TEXT NOT NULL UNIQUE CHECK(length(CAST(projectId AS BLOB))=36),data TEXT NOT NULL CHECK(${json('data', APP_RECORD_LIMITS.recentProject)} AND json_extract(data,'$.projectId') IS projectId))`,
  `CREATE TABLE project_rules_trust(${projectIdColumn} PRIMARY KEY,data TEXT NOT NULL CHECK(${json('data', APP_RECORD_LIMITS.rulesTrust)} AND json_extract(data,'$.projectId') IS projectId))`,
  `CREATE TABLE outside_path_confirmations(${projectIdColumn},directory TEXT NOT NULL,data TEXT NOT NULL CHECK(${json('data', APP_RECORD_LIMITS.outsidePath)} AND json_extract(data,'$.projectId') IS projectId AND json_extract(data,'$.directory') IS directory),PRIMARY KEY(projectId,directory))`,
  ...BACKGROUND_TASK_INDEX_SQL,
  `CREATE TABLE project_inbox(${projectIdColumn},itemId TEXT NOT NULL,data TEXT NOT NULL CHECK(${json('data', APP_RECORD_LIMITS.inboxItem)} AND json_extract(data,'$.projectId') IS projectId AND json_extract(data,'$.id') IS itemId),PRIMARY KEY(projectId,itemId))`,
  // Replays of app-level operations such as creating, packing or copying a project.
  `CREATE TABLE app_operation_receipts(operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 100),requestId TEXT NOT NULL CHECK(length(requestId) BETWEEN 1 AND 200),digest TEXT NOT NULL CHECK(length(digest)=64),response TEXT NOT NULL CHECK(${json('response', APP_RECORD_LIMITS.receiptResponse)}),createdAt TEXT NOT NULL,PRIMARY KEY(operation,requestId))`,
  "CREATE TRIGGER immutable_app_operation_receipts BEFORE UPDATE ON app_operation_receipts BEGIN SELECT RAISE(ABORT,'App operation receipts are immutable');END",
  USER_RULES_TABLE_SQL,
]);

/** The complete DDL in order: `schema_version`, the format-72 objects, then
 * the app library's own. */
export const appLibraryStatements = (version: 1 | 2 | 3 | 4 = APP_LIBRARY_SCHEMA_VERSION): readonly string[] =>
  version === 4 ? [APP_SCHEMA_VERSION_TABLE_SQL, ...FORMAT_72_APP_STATEMENTS, ...APP_LIBRARY_STATEMENTS] : PREVIOUS_APP_STATEMENTS[version];

/** One `sqlite_master` row; `sql` is null for automatic indexes. */
export interface AppSchemaObject {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
}

export function readAppSchema(db: DatabaseSync): AppSchemaObject[] {
  return db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name').all().map(row => ({
    type: String(row.type), name: String(row.name), tbl_name: String(row.tbl_name), sql: typeof row.sql === 'string' ? row.sql : null,
  }));
}

const expected = new Map<number, readonly AppSchemaObject[]>();
/** Every object the current DDL creates, as SQLite stores it, built once in a
 * memory database. */
export function expectedAppSchema(version: 1 | 2 | 3 | 4 = APP_LIBRARY_SCHEMA_VERSION): readonly AppSchemaObject[] {
  if (!expected.has(version)) {
    const db = new DatabaseSync(':memory:');
    try {
      for (const sql of appLibraryStatements(version)) db.exec(sql);
      expected.set(version, Object.freeze(readAppSchema(db).map(object => Object.freeze(object))));
    } finally {
      db.close();
    }
  }
  return expected.get(version)!;
}

/** Only the exact known v1 schema is eligible. Rebuild the one whitelist in
 * the same transaction; all existing documents and other tables keep bytes. */
export function upgradeAppLibraryV1(db: DatabaseSync): void {
  const differences = compareAppSchema(readAppSchema(db), expectedAppSchema(1));
  if (differences.length) throw new Error('The app library v1 schema does not match');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE app_documents RENAME TO app_documents_v1');
    db.exec(documentTable(APP_DOCUMENT_LIMITS));
    db.exec('INSERT INTO app_documents SELECT name,data FROM app_documents_v1');
    db.exec('DROP TABLE app_documents_v1');
    if (compareAppSchema(readAppSchema(db), expectedAppSchema(2)).length) throw new Error('The upgraded app library v2 schema does not match');
    db.prepare('UPDATE schema_version SET version=2 WHERE version=1').run();
    db.exec('COMMIT');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

/** Adds only the typed user-rules singleton to the exact P4 v2 profile. */
export function upgradeAppLibraryV2(db: DatabaseSync): void {
  if (compareAppSchema(readAppSchema(db), expectedAppSchema(2)).length) throw new Error('The app library v2 schema does not match');
  db.exec('BEGIN');
  try {
    db.exec(USER_RULES_TABLE_SQL);
    if (compareAppSchema(readAppSchema(db), expectedAppSchema(3)).length) throw new Error('The upgraded app library v3 schema does not match');
    db.prepare('UPDATE schema_version SET version=3 WHERE version=2').run();
    db.exec('COMMIT');
  } catch (error) {if (db.isTransaction) db.exec('ROLLBACK'); throw error;}
}

/** Only the real known v3 profile is eligible. Legacy index JSON stays byte
 * for byte; its new scalar fields are unverified defaults until an online
 * owner supplies a complete current record. No other table is rewritten. */
export function upgradeAppLibraryV3(db: DatabaseSync): void {
  if (compareAppSchema(readAppSchema(db), expectedAppSchema(3)).length) throw new Error('The app library v3 schema does not match');
  const entries = db.prepare(`SELECT rowid,projectId,kind,taskId,data FROM background_task_index LIMIT ${BACKGROUND_TASK_INDEX_LIMITS.application + 1}`).all();
  if (entries.length > BACKGROUND_TASK_INDEX_LIMITS.application) throw new Error('The app library task index exceeds its application limit');
  const counts = new Map<string, number>();
  for (const row of entries) {
    if (typeof row.data !== 'string' || typeof row.rowid !== 'number' || row.rowid < 1
      || db.prepare("SELECT 1 FROM json_tree(?) WHERE typeof(key)='text' GROUP BY parent,key HAVING count(*)>1 LIMIT 1").get(row.data)) throw new Error('Invalid legacy task index');
    const entry = backgroundTaskIndexEntryV3Schema.parse(JSON.parse(row.data));
    if (entry.projectId !== row.projectId || entry.kind !== row.kind || entry.taskId !== row.taskId) throw new Error('Invalid legacy task projection');
    const count = (counts.get(entry.projectId) ?? 0) + 1;
    if (count > BACKGROUND_TASK_INDEX_LIMITS.project) throw new Error('The app library task index exceeds its project limit');
    counts.set(entry.projectId, count);
  }
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE background_task_index RENAME TO background_task_index_v3');
    for (const sql of BACKGROUND_TASK_INDEX_SQL) db.exec(sql);
    db.exec("INSERT INTO background_task_index(rowid,projectId,kind,taskId,sourceHistory,phase,reason,revision,taskRevision,data) SELECT rowid,projectId,kind,taskId,'','prepared','INDEX_UNVERIFIED',1,0,data FROM background_task_index_v3 ORDER BY rowid");
    db.exec('DROP TABLE background_task_index_v3');
    if (compareAppSchema(readAppSchema(db)).length) throw new Error('The upgraded app library v4 schema does not match');
    db.exec('UPDATE schema_version SET version=4 WHERE version=3');
    db.exec('COMMIT');
  } catch (error) {if (db.isTransaction) db.exec('ROLLBACK'); throw error;}
}

/** Differences as `missing type:name`, `unexpected type:name` and
 * `changed type:name` (another table or other SQL), sorted. */
export function compareAppSchema(actual: readonly AppSchemaObject[], wanted: readonly AppSchemaObject[] = expectedAppSchema()): string[] {
  const key = (object: AppSchemaObject): string => `${object.type}:${object.name}`;
  const actualByKey = new Map(actual.map(object => [key(object), object]));
  const wantedKeys = new Set(wanted.map(key));
  const differences: string[] = [];
  for (const object of wanted) {
    const found = actualByKey.get(key(object));
    if (!found) differences.push(`missing ${key(object)}`);
    else if (found.tbl_name !== object.tbl_name || found.sql !== object.sql) differences.push(`changed ${key(object)}`);
  }
  for (const name of actualByKey.keys()) if (!wantedKeys.has(name)) differences.push(`unexpected ${name}`);
  return differences.sort();
}

/** Creates the app library inside the caller's open transaction. */
export function buildAppLibrary(db: DatabaseSync): void {
  if (!db.isTransaction) throw new Error('Building the app library requires an open transaction');
  for (const sql of appLibraryStatements()) db.exec(sql);
  db.exec(`PRAGMA main.application_id=${APP_LIBRARY_APPLICATION_ID}`);
  db.prepare('INSERT INTO main.schema_version VALUES(?)').run(APP_LIBRARY_SCHEMA_VERSION);
}
