import {DatabaseSync} from 'node:sqlite';
import {LAST_PROJECT_LIMITS} from '../../../contracts/src/last-project.ts';
import {UI_PREFERENCES_LIMITS} from '../../../contracts/src/ui-preferences.ts';

/** The app library: one SQLite file in the app data directory for what
 * belongs to this computer rather than to one project (PROJECT-FILE.md,
 * "登记与记录"). It is never attached to a project connection. */
export const APP_LIBRARY_FILE = 'app-library.db';
/** Raising it means changing the DDL below; the manifest digest in
 * tests/app-db-library.test.ts records the current structure. */
export const APP_LIBRARY_SCHEMA_VERSION = 3;
/** SQLite header `application_id`: 'MioA', next to the kernel's 'MioP', 'MioH'
 * and 'MioC', so the app library is never taken for a project file. */
export const APP_LIBRARY_APPLICATION_ID = 0x4d696f41;
/** The same definition as the three project databases keep. */
export const APP_SCHEMA_VERSION_TABLE_SQL = 'CREATE TABLE schema_version(version INTEGER PRIMARY KEY)';

/** The three format-72 tables and two triggers the project-file layout hands
 * to the app library, exactly as `node tests/helpers/project-file-schema-derivation.ts --report`
 * prints them: `workspace_preferences` without its foreign key to `projects`
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
  `CREATE TABLE background_task_index(${projectIdColumn},kind TEXT NOT NULL,taskId TEXT NOT NULL,data TEXT NOT NULL CHECK(${json('data', APP_RECORD_LIMITS.taskIndex)} AND json_extract(data,'$.projectId') IS projectId AND json_extract(data,'$.kind') IS kind AND json_extract(data,'$.taskId') IS taskId),PRIMARY KEY(projectId,kind,taskId))`,
  `CREATE TABLE project_inbox(${projectIdColumn},itemId TEXT NOT NULL,data TEXT NOT NULL CHECK(${json('data', APP_RECORD_LIMITS.inboxItem)} AND json_extract(data,'$.projectId') IS projectId AND json_extract(data,'$.id') IS itemId),PRIMARY KEY(projectId,itemId))`,
  // Replays of app-level operations such as creating, packing or copying a project.
  `CREATE TABLE app_operation_receipts(operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 100),requestId TEXT NOT NULL CHECK(length(requestId) BETWEEN 1 AND 200),digest TEXT NOT NULL CHECK(length(digest)=64),response TEXT NOT NULL CHECK(${json('response', APP_RECORD_LIMITS.receiptResponse)}),createdAt TEXT NOT NULL,PRIMARY KEY(operation,requestId))`,
  "CREATE TRIGGER immutable_app_operation_receipts BEFORE UPDATE ON app_operation_receipts BEGIN SELECT RAISE(ABORT,'App operation receipts are immutable');END",
  USER_RULES_TABLE_SQL,
]);

/** The complete DDL in order: `schema_version`, the format-72 objects, then
 * the app library's own. */
export const appLibraryStatements = (version: 1 | 2 | 3 = 3): readonly string[] =>
  [APP_SCHEMA_VERSION_TABLE_SQL, ...FORMAT_72_APP_STATEMENTS, ...APP_LIBRARY_STATEMENTS.filter(sql => version === 3 || sql !== USER_RULES_TABLE_SQL).map(sql => version === 1 && sql.startsWith('CREATE TABLE app_documents(') ? documentTable(APP_DOCUMENT_LIMITS_V1) : sql)];

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
export function expectedAppSchema(version: 1 | 2 | 3 = 3): readonly AppSchemaObject[] {
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
    if (compareAppSchema(readAppSchema(db)).length) throw new Error('The upgraded app library v3 schema does not match');
    db.prepare('UPDATE schema_version SET version=3 WHERE version=2').run();
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
