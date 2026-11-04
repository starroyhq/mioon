import {DatabaseSync} from 'node:sqlite';
import type {SQLInputValue, SQLOutputValue} from 'node:sqlite';
import {AppError} from '../../../contracts/src/app-error.ts';
import {isProjectId} from '../../../contracts/src/project-file.ts';
import {isProjectStore} from '../project-file/store.ts';
import type {ProjectStore} from '../project-file/store.ts';
import {PROJECT_FILE_SCHEMA_VERSION, schemaStatements} from '../project-file/schema/databases.ts';
import {PROJECT_SNAPSHOT_MAX_RAW_BYTES} from './limits.ts';
import {FORMAT_2_SNAPSHOT_TABLE_SQL, FORMAT_1_COPY_TABLE_SQL} from './format-2.ts';

/** A closed, independently reviewed ledger. Adding a project table requires
 * classifying it here; CONTENT_TABLES is deliberately not used as this list. */
export const PROJECT_SNAPSHOT_TABLES = Object.freeze([
  'projects', 'assets', 'asset_annotations', 'asset_dispositions', 'asset_ranges', 'shots', 'nodes', 'edges', 'versions',
  'timelines', 'subjects', 'subject_versions', 'subject_bindings', 'image_groups', 'image_versions', 'scene_results', 'project_lut_resources',
] as const);
export type ProjectSnapshotTable = typeof PROJECT_SNAPSHOT_TABLES[number];
export const PROJECT_SNAPSHOT_EXCLUSIONS = Object.freeze({
  schema_version: 'Kernel format evidence; never restore an old format number.',
  project_file: 'Project identity and current content stamp; never rewind them.',
  agent_task_target_revisions_v2: 'Revision evidence; restoring must advance current revisions.',
});
export const PROJECT_SNAPSHOT_PROFILE = 1;
export type SnapshotCell = null | string | number | {readonly type: 'blob'; readonly base64: string} | {readonly type: 'integer'; readonly decimal: string};
export type SnapshotRow = Readonly<Record<string, SnapshotCell>>;
export interface ProjectDocument {
  readonly snapshotProfileVersion: 1;
  readonly projectId: string;
  readonly projectFormatVersion: number;
  readonly evidence: {readonly contentSequence: number; readonly targetRevisions: readonly SnapshotRow[]};
  readonly tables: Readonly<Record<ProjectSnapshotTable, readonly SnapshotRow[]>>;
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const snapshotInvalid = (reason: string): AppError => new AppError('PROJECT_VERSION_SNAPSHOT_INVALID', '版本快照无效或格式不受支持。', 422, {reason});

/** Canonical JSON preserves array order and user string bytes. It has no
 * toJSON hooks, locale collation or dependence on insertion order. */
export function canonicalJson(value: unknown): string {
  const visit = (input: unknown, depth: number): unknown => {
    if (depth > 64) throw snapshotInvalid('json-depth');
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return Object.is(input, -0) ? 0 : input;
    if (Array.isArray(input)) return input.map(item => visit(item, depth + 1));
    if (object(input)) return Object.fromEntries(Object.keys(input).sort(compare).map(key => [key, visit(input[key], depth + 1)]));
    throw snapshotInvalid('json-value');
  };
  return JSON.stringify(visit(value, 0));
}

interface Column {readonly name: string; readonly type: string; readonly notnull: number; readonly pk: number}
interface Shape {readonly columns: readonly Column[]; readonly primaryKeys: readonly string[]; readonly sql: string}
const tableNames = [...PROJECT_SNAPSHOT_TABLES, 'agent_task_target_revisions_v2'] as const;
const tableSql = schemaStatements('project').filter(sql => sql.startsWith('CREATE TABLE '));
const validatedDocuments = new WeakSet<object>();
let shapes: ReadonlyMap<string, Shape> | undefined;
let format2Shapes: ReadonlyMap<string, Shape> | undefined;
function createTableShapes(statements: readonly string[]): ReadonlyMap<string, Shape> {
  const db = new DatabaseSync(':memory:');
  try {
    for (const sql of statements) db.exec(sql);
    return new Map(tableNames.map(table => {
      const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => ({name: String(row.name), type: String(row.type), notnull: Number(row.notnull), pk: Number(row.pk)}));
      const sql = statements.find(statement => statement.startsWith(`CREATE TABLE ${table}(`));
      if (!sql || !columns.length) throw snapshotInvalid('unclassified-table-shape');
      return [table, {columns, primaryKeys: columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name), sql}];
    }));
  } finally {db.close();}
}
function tableShapes(): ReadonlyMap<string, Shape> {return shapes ??= createTableShapes(tableSql);}
export function tableColumns(table: ProjectSnapshotTable | 'agent_task_target_revisions_v2'): readonly string[] {
  const shape = tableShapes().get(table);
  if (!shape) throw snapshotInvalid('table');
  return shape.columns.map(column => column.name);
}
export function primaryKeys(table: ProjectSnapshotTable | 'agent_task_target_revisions_v2'): readonly string[] {
  const keys = tableShapes().get(table)?.primaryKeys;
  if (!keys?.length) throw snapshotInvalid('primary-key');
  return keys;
}
export function rowKey(table: ProjectSnapshotTable | 'agent_task_target_revisions_v2', row: SnapshotRow): string {
  return canonicalJson(primaryKeys(table).map(key => row[key]));
}

const jsonColumns = new Set(['data', 'tags', 'metadata', 'options', 'cuts']);
function cell(value: SQLOutputValue, column: string): SnapshotCell {
  if (value === null) return null;
  if (value instanceof Uint8Array) return {type: 'blob', base64: Buffer.from(value).toString('base64')};
  if (typeof value === 'bigint') return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(value) : {type: 'integer', decimal: String(value)};
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) throw snapshotInvalid('numeric-cell');
    return value;
  }
  if (jsonColumns.has(column)) {
    try {return canonicalJson(JSON.parse(value));} catch {throw snapshotInvalid('json-column');}
  }
  return value;
}
export function snapshotCellValue(value: SnapshotCell): SQLInputValue {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value;
  return value.type === 'blob' ? Buffer.from(value.base64, 'base64') : BigInt(value.decimal);
}

function readRows(store: ProjectStore, table: ProjectSnapshotTable | 'agent_task_target_revisions_v2', budget: {bytes: number}): SnapshotRow[] {
  const rowBytes = tableColumns(table).map(column => `COALESCE(length(CAST(${quote(column)} AS BLOB)),0)`).join('+');
  if (store.db.prepare(`SELECT 1 FROM project.${quote(table)} WHERE (${rowBytes})>? LIMIT 1`).get(PROJECT_SNAPSHOT_MAX_RAW_BYTES)) {
    // Bound an individual SQL cell before transferring it into JavaScript.
    throw new AppError('PROJECT_VERSION_SNAPSHOT_LIMIT', '项目内容超过版本快照容量上限，未保存版本。', 413);
  }
  const statement = store.db.prepare(`SELECT * FROM project.${quote(table)}`);
  statement.setReadBigInts(true);
  const duplicateJsonKey = store.db.prepare('SELECT 1 FROM json_tree(?) WHERE parent IS NOT NULL GROUP BY parent,key HAVING count(*)>1 LIMIT 1');
  const rows: SnapshotRow[] = [];
  for (const row of statement.iterate()) {
    const normalized = Object.fromEntries(Object.entries(row).map(([name, value]) => {
    if (jsonColumns.has(name) && typeof value === 'string') {
      // SQLite and JSON.parse do not choose the same duplicate key. Refuse
      // that ambiguous content rather than canonicalizing away one value.
      try {if (duplicateJsonKey.get(value)) throw snapshotInvalid('duplicate-json-key');}
      catch {throw snapshotInvalid('json-column');}
    }
    return [name, cell(value, name)];
    }));
    // Refuse while streaming, before materializing an arbitrarily large table.
    // Encoding checks the exact final envelope size as well.
    budget.bytes += Buffer.byteLength(canonicalJson(normalized)) + 1;
    if (budget.bytes > PROJECT_SNAPSHOT_MAX_RAW_BYTES) throw new AppError('PROJECT_VERSION_SNAPSHOT_LIMIT', '项目内容超过版本快照容量上限，未保存版本。', 413);
    rows.push(normalized);
  }
  return rows.sort((a, b) => compare(rowKey(table, a), rowKey(table, b)));
}

export function assertProjectSnapshotTableLedger(names: readonly string[]): void {
  const classified = [...PROJECT_SNAPSHOT_TABLES, ...Object.keys(PROJECT_SNAPSHOT_EXCLUSIONS)].sort(compare);
  if (canonicalJson([...names].sort(compare)) !== canonicalJson(classified)) throw snapshotInvalid('unclassified-project-table');
}

/** The caller owns one synchronous read transaction on the kernel's original
 * connection. No new project descriptor, history query or media read occurs. */
export function captureProjectDocumentInside(store: ProjectStore): ProjectDocument {
  if (!isProjectStore(store) || !store.db.isTransaction) throw new TypeError('Snapshot capture requires the exact live store inside a transaction');
  const names = store.db.prepare("SELECT name FROM project.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => String(row.name));
  assertProjectSnapshotTableLedger(names);
  for (const table of tableNames) {
    const actual = store.db.prepare(`PRAGMA project.table_info(${quote(table)})`).all().map(row => String(row.name));
    if (canonicalJson(actual) !== canonicalJson(tableColumns(table))) throw snapshotInvalid('table-columns');
  }
  const metadata = store.db.prepare('SELECT singleton,projectId,contentSequence FROM project.project_file').all();
  const format = store.db.prepare('SELECT version FROM project.schema_version').all();
  if (metadata.length !== 1 || metadata[0].singleton !== 1 || metadata[0].projectId !== store.projectId || format.length !== 1 || format[0].version !== PROJECT_FILE_SCHEMA_VERSION) throw snapshotInvalid('project-metadata');
  const budget = {bytes: 0};
  const document: ProjectDocument = {
    snapshotProfileVersion: 1, projectId: store.projectId, projectFormatVersion: PROJECT_FILE_SCHEMA_VERSION,
    evidence: {contentSequence: Number(metadata[0].contentSequence), targetRevisions: readRows(store, 'agent_task_target_revisions_v2', budget)},
    tables: Object.fromEntries(PROJECT_SNAPSHOT_TABLES.map(table => [table, readRows(store, table, budget)])) as Record<ProjectSnapshotTable, SnapshotRow[]>,
  };
  return validateProjectDocument(document);
}

function validateCell(value: unknown, column: Column): value is SnapshotCell {
  if (value === null) return column.notnull === 0 && column.pk === 0;
  if (column.type === 'TEXT') return typeof value === 'string' && (!column.pk || value.length > 0);
  if (column.type === 'INTEGER') return typeof value === 'number' && Number.isSafeInteger(value)
    || object(value) && exact(value, ['type', 'decimal']) && value.type === 'integer' && typeof value.decimal === 'string'
      && /^-?[1-9][0-9]*$/u.test(value.decimal) && BigInt(value.decimal) >= -9223372036854775808n && BigInt(value.decimal) <= 9223372036854775807n
      && (BigInt(value.decimal) < BigInt(Number.MIN_SAFE_INTEGER) || BigInt(value.decimal) > BigInt(Number.MAX_SAFE_INTEGER));
  if (column.type === 'BLOB') return object(value) && exact(value, ['type', 'base64']) && value.type === 'blob' && typeof value.base64 === 'string'
    && value.base64.length % 4 === 0 && !/[^A-Za-z0-9+/=]/u.test(value.base64)
    && Buffer.from(value.base64, 'base64').toString('base64') === value.base64;
  if (column.type === 'REAL') return typeof value === 'number' && Number.isFinite(value);
  return false;
}
function validateRows(table: ProjectSnapshotTable | 'agent_task_target_revisions_v2', rows: unknown, projectId: string, definitions: ReadonlyMap<string, Shape>): asserts rows is readonly SnapshotRow[] {
  if (!Array.isArray(rows)) throw snapshotInvalid('rows');
  const shape = definitions.get(table)!;
  let previous: string | undefined;
  for (const row of rows) {
    if (!object(row) || !exact(row, shape.columns.map(column => column.name)) || !shape.columns.every(column => validateCell(row[column.name], column))) throw snapshotInvalid('row-columns');
    if (table === 'projects' ? row.id !== projectId : row.projectId !== projectId) throw snapshotInvalid('row-owner');
    for (const column of shape.columns) {
      const value = row[column.name];
      if (jsonColumns.has(column.name) && typeof value === 'string') {
        try {
          const parsed: unknown = JSON.parse(value);
          if (canonicalJson(parsed) !== value || column.name === 'data' && (!object(parsed) || (table !== 'projects' && parsed.projectId !== projectId)
            || Object.hasOwn(row, 'id') && object(parsed) && parsed.id !== row.id)) throw snapshotInvalid('json-owner');
        } catch {throw snapshotInvalid('json-column');}
      }
    }
    const key = canonicalJson(shape.primaryKeys.map(column => row[column]));
    if (previous !== undefined && compare(previous, key) >= 0) throw snapshotInvalid('row-order-or-duplicate');
    previous = key;
  }
}

/** Validate untrusted decoded rows against the current SQL table constraints
 * and native FK graph in an isolated in-memory database. No live trigger is
 * disabled; retained-row triggers are not needed to validate a static value. */
function validateDocument(input: unknown, format: number, statements: readonly string[], definitions: ReadonlyMap<string, Shape>): ProjectDocument {
  if (!object(input) || !exact(input, ['snapshotProfileVersion', 'projectId', 'projectFormatVersion', 'evidence', 'tables'])
    || input.snapshotProfileVersion !== PROJECT_SNAPSHOT_PROFILE || input.projectFormatVersion !== format || !isProjectId(input.projectId)
    || !object(input.evidence) || !exact(input.evidence, ['contentSequence', 'targetRevisions']) || typeof input.evidence.contentSequence !== 'number'
    || !Number.isSafeInteger(input.evidence.contentSequence) || input.evidence.contentSequence < 0 || !object(input.tables)
    || !exact(input.tables, PROJECT_SNAPSHOT_TABLES)) throw snapshotInvalid('document');
  for (const table of PROJECT_SNAPSHOT_TABLES) validateRows(table, input.tables[table], input.projectId, definitions);
  validateRows('agent_task_target_revisions_v2', input.evidence.targetRevisions, input.projectId, definitions);
  if ((input.tables.projects as readonly unknown[]).length !== 1) throw snapshotInvalid('project-row');
  const db = new DatabaseSync(':memory:', {enableForeignKeyConstraints: false, enableDoubleQuotedStringLiterals: false});
  try {
    for (const sql of statements) db.exec(sql);
    for (const table of tableNames) {
      const columns = definitions.get(table)!.columns.map(column => column.name);
      const insert = db.prepare(`INSERT INTO ${quote(table)}(${columns.map(quote).join(',')}) VALUES(${columns.map(() => '?').join(',')})`);
      const rows = table === 'agent_task_target_revisions_v2' ? input.evidence.targetRevisions : input.tables[table];
      for (const row of rows as readonly SnapshotRow[]) insert.run(...columns.map(column => snapshotCellValue(row[column])));
    }
    if (db.prepare('PRAGMA foreign_key_check').get()) throw snapshotInvalid('foreign-key');
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw snapshotInvalid('row-constraint');
  } finally {db.close();}
  // Documents are values. Deeply freeze the cell/row/container layers before
  // memoizing validation, so capture -> encode does not reinsert large LUTs in
  // a second scratch database and callers cannot change a verified payload.
  for (const rows of [...Object.values(input.tables), input.evidence.targetRevisions] as readonly (readonly SnapshotRow[])[]) {
    for (const row of rows) {
      for (const value of Object.values(row)) if (value !== null && typeof value === 'object') Object.freeze(value);
      Object.freeze(row);
    }
    Object.freeze(rows);
  }
  Object.freeze(input.tables); Object.freeze(input.evidence); Object.freeze(input);
  return input as unknown as ProjectDocument;
}

export function validateProjectDocument(input: unknown): ProjectDocument {
  if (object(input) && validatedDocuments.has(input)) return input as unknown as ProjectDocument;
  const result = validateDocument(input, PROJECT_FILE_SCHEMA_VERSION, tableSql, tableShapes());
  validatedDocuments.add(result);
  return result;
}

/** A logical format-2 snapshot is validated against its frozen content DDL
 * before the metadata-only 2→3 adaptation. No captured token is invented and
 * no original envelope, digest or compressed bytes are rewritten. */
export function decodeSupportedProjectDocument(input: unknown): ProjectDocument {
  if (object(input) && input.projectFormatVersion === 1) {
    validateDocument(input, 1, FORMAT_1_COPY_TABLE_SQL, format2Shapes ??= createTableShapes(FORMAT_1_COPY_TABLE_SQL));
    throw new AppError('PROJECT_VERSION_SNAPSHOT_UNSUPPORTED', '此版本使用不支持恢复的旧项目业务格式；正文仍保留。', 422,
      {projectFormatVersion: 1, snapshotProfileVersion: 1});
  }
  if (object(input) && input.projectFormatVersion === 2 && Number(PROJECT_FILE_SCHEMA_VERSION) === 3) {
    const old = validateDocument(input, 2, FORMAT_2_SNAPSHOT_TABLE_SQL, format2Shapes ??= createTableShapes(FORMAT_2_SNAPSHOT_TABLE_SQL));
    return validateProjectDocument({...old, projectFormatVersion: PROJECT_FILE_SCHEMA_VERSION});
  }
  return validateProjectDocument(input);
}

/** Structural preservation is deliberately separate from business restore.
 * Known format 1 may be carried byte-for-byte, never adapted to current data. */
export function validateProjectDocumentForCopy(input: unknown): ProjectDocument {
  if (object(input) && input.projectFormatVersion === 1)
    return validateDocument(input, 1, FORMAT_1_COPY_TABLE_SQL, format2Shapes ??= createTableShapes(FORMAT_1_COPY_TABLE_SQL));
  return decodeSupportedProjectDocument(input);
}
