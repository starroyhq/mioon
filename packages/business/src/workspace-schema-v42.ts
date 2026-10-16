/** Dormant fixed ordinary42. Only an empty application-owned database can be
 * constructed; existing historical stores are never migrated by this entry. */
import {DatabaseSync} from 'node:sqlite';
import {initializeOpacityLegacyThrough40} from './workspace-opacity-legacy.ts';
import {validateOpacityWorkspaceRows} from './workspace-opacity-validation.ts';

export const WORKSPACE_OPACITY_SCHEMA_VERSION = 42;
export interface WorkspaceClassificationV42 {readonly schemaVersion: 42; readonly profile: 'ordinary'}
type CatalogEntry = Readonly<{type: string; name: string; table: string; sql: string | null}>;
type Catalog = Map<string, CatalogEntry>;
const sourceMarkers = [...Array.from({length: 24}, (_, index) => index + 1), 26, 28, 30, 32, 34, 36, 38, 40, 42];
function fail(message: string): never {throw Object.assign(new Error(message), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});}
function safety(db: DatabaseSync): void {
  db.exec('PRAGMA trusted_schema=OFF;');
  if (db.prepare('PRAGMA trusted_schema').get()?.trusted_schema !== 0) fail('Unsafe opacity workspace connection.');
}
// Same closed token grammar as the fixed41 catalog. String literals and all
// constraints remain exact; only harmless keyword/comment spelling can vary.
function normalize(sql: string | null): string | null {
  if (sql === null) return null;
  const tokens: string[] = [];
  const lexer = /\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|\d+(?:\.\d+)?|<>|!=|<=|>=|==|\|\||[-+*/%=<>().,;?]/gy;
  let at = 0;
  while (at < sql.length) {
    lexer.lastIndex = at;
    const match = lexer.exec(sql);
    if (!match) fail('Unsupported opacity workspace SQL.');
    let token = match[0]; at = lexer.lastIndex;
    if (/^\s|^--|^\/\*/u.test(token)) continue;
    if (token.startsWith("'")) {tokens.push(token); continue;}
    if (/^["`\[]/u.test(token)) {
      const identifier = token.slice(1, -1).toLowerCase(), previous = tokens.at(-1);
      if (['edit_tasks', 'image_reviews', 'agent_edit_proposals'].includes(identifier) && ['table', 'references'].includes(previous ?? '')) token = identifier;
      else {tokens.push('quoted:' + token); continue;}
    }
    tokens.push(token.toLowerCase());
  }
  return JSON.stringify(tokens.filter((_, index) =>
    !(tokens[index] === 'if' && tokens[index + 1] === 'not' && tokens[index + 2] === 'exists') &&
    !(tokens[index - 1] === 'if' && tokens[index] === 'not' && tokens[index + 1] === 'exists') &&
    !(tokens[index - 2] === 'if' && tokens[index - 1] === 'not' && tokens[index] === 'exists')));
}
function catalog(db: DatabaseSync): Catalog {
  const result: Catalog = new Map(); let bytes = 0;
  for (const row of db.prepare("SELECT type,CASE WHEN length(CAST(name AS BLOB))<=128 THEN name END AS name,CASE WHEN length(CAST(tbl_name AS BLOB))<=128 THEN tbl_name END AS tbl_name,CASE WHEN length(CAST(sql AS BLOB))<=131072 THEN sql END AS sql,length(CAST(sql AS BLOB)) AS bytes FROM main.sqlite_schema ORDER BY type,name LIMIT 1025").iterate()) {
    if (result.size >= 1024 || typeof row.type !== 'string' || typeof row.name !== 'string' || typeof row.tbl_name !== 'string' ||
        Buffer.byteLength(row.name) > 128 || row.sql !== null && typeof row.sql !== 'string' || Number(row.bytes) > 131072 ||
        (bytes += Number(row.bytes) || 0) > 1048576) fail('Opacity workspace catalog limit.');
    result.set(row.name, {type: row.type, name: row.name, table: row.tbl_name, sql: normalize(row.sql)});
  }
  return result;
}
const MOCK_SCHEMA_SQL = `
 CREATE TABLE IF NOT EXISTS mock_provider_tasks (
  provider_job_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
  snapshot_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL, scenario TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL, ready_at_ms INTEGER NOT NULL,
  poll_count INTEGER NOT NULL DEFAULT 0, download_attempts INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0
 );
 CREATE TABLE IF NOT EXISTS mock_provider_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL,
  job_id TEXT, provider_job_id TEXT, created_at_ms INTEGER NOT NULL, outcome TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS mock_provider_submissions_request ON mock_provider_submissions(request_id);
`;
let fixed: Readonly<{ordinary: Catalog; mock: Catalog}> | undefined;
function reference(): Readonly<{ordinary: Catalog; mock: Catalog}> {
  if (fixed) return fixed;
  const db = new DatabaseSync(':memory:');
  try {
    safety(db); db.exec('PRAGMA foreign_keys=ON;');
    initializeOpacityLegacyThrough40(db);
    db.exec('INSERT INTO main.schema_version(version) VALUES(42);');
    const ordinary = catalog(db);
    db.exec(MOCK_SCHEMA_SQL);
    fixed = Object.freeze({ordinary, mock: catalog(db)});
    return fixed;
  } finally {db.close();}
}
function same(actual: Catalog, expected: Catalog): boolean {
  return actual.size === expected.size && [...expected].every(([name, value]) => JSON.stringify(actual.get(name)) === JSON.stringify(value));
}

/** Exact42 catalog/markers and complete raw row evidence. This is independent
 * admission, not a facade that asks an old classifier to accept42 as40. */
export function classifyWorkspaceSchema42(db: DatabaseSync): WorkspaceClassificationV42 {
  safety(db);
  if (db.prepare('SELECT 1 FROM temp.sqlite_schema LIMIT 1').get()) fail('Temporary opacity workspace objects.');
  const actual = catalog(db), expected = reference();
  if (!same(actual, expected.ordinary) && !same(actual, expected.mock)) fail('Unsupported opacity workspace catalog.');
  const markers = db.prepare('SELECT version,typeof(version) AS type FROM main.schema_version ORDER BY version LIMIT 35').all();
  if (markers.length !== sourceMarkers.length || markers.some((row, index) => row.type !== 'integer' || row.version !== sourceMarkers[index])) fail('Unsupported opacity workspace markers.');
  validateOpacityWorkspaceRows(db, {schemaVersion: 42});
  return Object.freeze({schemaVersion: 42, profile: 'ordinary'});
}
export function validateWorkspaceSchema42(db: DatabaseSync): void {classifyWorkspaceSchema42(db);}

/** New empty construction or exact42 reopen only. Default production startup
 * does not call this entry, and a historical40 database is refused intact. */
export function initializeWorkspaceSchema42(db: DatabaseSync): void {
  if (db.isTransaction) fail('Nested opacity workspace construction.');
  safety(db);
  if (db.prepare('SELECT 1 FROM temp.sqlite_schema LIMIT 1').get()) fail('Temporary opacity workspace objects.');
  if (db.prepare('SELECT 1 FROM main.sqlite_schema LIMIT 1').get()) {validateWorkspaceSchema42(db); return;}
  db.exec('PRAGMA foreign_keys=ON;');
  initializeOpacityLegacyThrough40(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('INSERT INTO main.schema_version(version) VALUES(42);');
    validateWorkspaceSchema42(db);
    db.exec('COMMIT');
  } catch (error) {if (db.isTransaction) db.exec('ROLLBACK'); throw error;}
}
