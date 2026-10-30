// Derives the static project-file schema from the format-72 workspace built by
// db.ts, and writes or checks the generated files.
//   node tests/helpers/project-file-schema-derivation.ts --write   regenerate the files
//   node tests/helpers/project-file-schema-derivation.ts --check   exit 1 when a file differs
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {SQLOutputValue} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {openStore} from '../../packages/business/src/db.ts';
import {buildDatabase, schemaStatements, SCHEMA_VERSION_TABLE_SQL, CACHE_SCHEMA_VERSION, HISTORY_SCHEMA_VERSION, PROJECT_FILE_SCHEMA_VERSION} from '../../packages/business/src/project-file/schema/databases.ts';
import type {DatabaseKind} from '../../packages/business/src/project-file/schema/databases.ts';
import {readSchemaManifest} from '../../packages/business/src/project-file/schema/manifest-check.ts';
import type {ManifestEntry} from '../../packages/business/src/project-file/schema/manifest-check.ts';
import {CACHE_TABLES, CONTENT_TABLES, HISTORY_TABLES, HISTORY_TABLES_BY_DOMAIN, databaseOf} from '../../packages/business/src/project-file/schema/tables.ts';
import type {TablePlacement} from '../../packages/business/src/project-file/schema/tables.ts';

export const REPOSITORY = fileURLToPath(new URL('../../', import.meta.url));
const COMMAND = 'node tests/helpers/project-file-schema-derivation.ts';
type Row = Record<string, SQLOutputValue>;

// ---------------------------------------------------------------------------
// Reading format 72

export interface Format72Object {
  readonly rowid: number;
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
}
export interface TableShape {
  readonly columns: readonly Row[];
  readonly foreignKeys: readonly Row[];
  readonly indexes: readonly Row[];
  readonly indexColumns: Readonly<Record<string, readonly Row[]>>;
}
export interface Format72 {
  readonly version: number;
  /** Every sqlite_master row, in rowid (creation) order. */
  readonly objects: readonly Format72Object[];
  readonly tables: ReadonlyMap<string, TableShape>;
}

/** PRAGMA table_xinfo, foreign_key_list, index_list and index_xinfo of one main-schema table. */
export function readTableShape(db: DatabaseSync, table: string): TableShape {
  const indexes = db.prepare('SELECT * FROM pragma_index_list(?)').all(table);
  return {
    columns: db.prepare('SELECT * FROM pragma_table_xinfo(?)').all(table),
    foreignKeys: db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(table),
    indexes,
    indexColumns: Object.fromEntries(indexes.map(index => [String(index.name), db.prepare('SELECT * FROM pragma_index_xinfo(?)').all(String(index.name))])),
  };
}

/** Builds an empty format-72 workspace with db.ts in a scratch directory and reads its schema. */
export function readFormat72(): Format72 {
  const scratch = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-k1-format72-'));
  try {
    const store = openStore(path.join(scratch, 'workspace'), {lock: false});
    try {
      const db = store.db;
      const objects = db.prepare('SELECT rowid,type,name,tbl_name,sql FROM sqlite_master ORDER BY rowid').all().map(row => ({
        rowid: Number(row.rowid), type: String(row.type), name: String(row.name), tbl_name: String(row.tbl_name),
        sql: typeof row.sql === 'string' ? row.sql : null,
      }));
      const version = Number(db.prepare('SELECT max(version) AS version FROM schema_version').get()?.version);
      const tables = new Map(objects.filter(object => object.type === 'table').map(object => [object.name, readTableShape(db, object.name)]));
      return {version, objects, tables};
    } finally {
      store.close();
    }
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------
// A small SQL tokenizer: strings, quoted identifiers, comments, words, punctuation.

export interface SqlToken {
  readonly kind: 'word' | 'quoted' | 'string' | 'number' | 'punct';
  readonly text: string;
  /** Identifier or string content without quotes; equals `text` for other kinds. */
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

const WORD_START = /[A-Za-z_\u0080-\uffff]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-\uffff]/;

export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (sql.startsWith('--', i)) { const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end + 1; continue; }
    if (sql.startsWith('/*', i)) { const end = sql.indexOf('*/', i + 2); i = end < 0 ? sql.length : end + 2; continue; }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1, value = '';
      for (;;) {
        const k = sql.indexOf(close, j);
        if (k < 0) throw new Error(`Unterminated ${c} at offset ${i}`);
        value += sql.slice(j, k);
        if (close !== ']' && sql[k + 1] === close) { value += close; j = k + 2; continue; }
        j = k + 1;
        break;
      }
      tokens.push({kind: c === "'" ? 'string' : 'quoted', text: sql.slice(i, j), value, start: i, end: j});
      i = j;
      continue;
    }
    if (WORD_START.test(c) || /[0-9]/.test(c)) {
      const word = WORD_START.test(c);
      let j = i + 1;
      while (j < sql.length && (word ? WORD_PART : /[0-9A-Za-z_.]/).test(sql[j]!)) j++;
      const text = sql.slice(i, j);
      tokens.push({kind: word ? 'word' : 'number', text, value: text, start: i, end: j});
      i = j;
      continue;
    }
    tokens.push({kind: 'punct', text: c, value: c, start: i, end: i + 1});
    i++;
  }
  return tokens;
}

const isWord = (token: SqlToken | undefined, word: string): boolean => token?.kind === 'word' && token.value.toUpperCase() === word;
const isPunct = (token: SqlToken | undefined, text: string): boolean => token?.kind === 'punct' && token.text === text;
function identifier(token: SqlToken | undefined): string {
  if (token?.kind !== 'word' && token?.kind !== 'quoted') throw new Error(`Expected an identifier at offset ${token?.start ?? 'end'}`);
  return token.value;
}
function nameList(tokens: readonly SqlToken[], open: number): {names: string[]; end: number} {
  if (!isPunct(tokens[open], '(')) throw new Error('Expected a parenthesised column list');
  const names: string[] = [];
  let i = open + 1;
  for (;;) {
    names.push(identifier(tokens[i]));
    i++;
    if (isPunct(tokens[i], ')')) return {names, end: i + 1};
    if (!isPunct(tokens[i], ',')) throw new Error('Unsupported column list');
    i++;
  }
}

// ---------------------------------------------------------------------------
// Rewrite rule (a): cross-file foreign keys

export interface ForeignKeyClause {
  readonly form: 'column' | 'table';
  readonly columns: readonly string[];
  readonly parent: string;
  /** Empty when the clause names only the parent table. */
  readonly parentColumns: readonly string[];
  /** `DEFERRABLE INITIALLY DEFERRED`. */
  readonly deferred: boolean;
  /** Source range removed when the clause is stripped. */
  readonly removeStart: number;
  readonly removeEnd: number;
}

/** ON DELETE|UPDATE action, MATCH name, [NOT] DEFERRABLE [INITIALLY DEFERRED|IMMEDIATE], in any order. */
function foreignKeySuffix(tokens: readonly SqlToken[], start: number): {end: number; deferred: boolean} {
  let i = start, deferred = false;
  for (;;) {
    if (isWord(tokens[i], 'ON') && (isWord(tokens[i + 1], 'DELETE') || isWord(tokens[i + 1], 'UPDATE'))) {
      i += 2;
      if (isWord(tokens[i], 'SET') && (isWord(tokens[i + 1], 'NULL') || isWord(tokens[i + 1], 'DEFAULT'))) i += 2;
      else if (isWord(tokens[i], 'NO') && isWord(tokens[i + 1], 'ACTION')) i += 2;
      else if (isWord(tokens[i], 'CASCADE') || isWord(tokens[i], 'RESTRICT')) i += 1;
      else throw new Error('Unsupported foreign-key action');
    } else if (isWord(tokens[i], 'MATCH')) {
      identifier(tokens[i + 1]);
      i += 2;
    } else if (isWord(tokens[i], 'DEFERRABLE') || (isWord(tokens[i], 'NOT') && isWord(tokens[i + 1], 'DEFERRABLE'))) {
      const negated = isWord(tokens[i], 'NOT');
      i += negated ? 2 : 1;
      let initiallyDeferred = false;
      if (isWord(tokens[i], 'INITIALLY') && (isWord(tokens[i + 1], 'DEFERRED') || isWord(tokens[i + 1], 'IMMEDIATE'))) {
        initiallyDeferred = isWord(tokens[i + 1], 'DEFERRED');
        i += 2;
      }
      deferred = !negated && initiallyDeferred;
    } else {
      return {end: i, deferred};
    }
  }
}

/** Every column-level and table-level foreign-key clause of a CREATE TABLE statement. */
export function foreignKeyClauses(createTableSql: string): ForeignKeyClause[] {
  const tokens = tokenizeSql(createTableSql);
  if (!isWord(tokens[0], 'CREATE')) throw new Error('Expected a CREATE TABLE statement');
  const open = tokens.findIndex(token => isPunct(token, '('));
  if (open < 0) throw new Error('CREATE TABLE has no column list');
  let depth = 0, close = -1;
  for (let i = open; i < tokens.length && close < 0; i++) {
    if (isPunct(tokens[i], '(')) depth++;
    else if (isPunct(tokens[i], ')') && --depth === 0) close = i;
  }
  if (close < 0) throw new Error('CREATE TABLE column list is not closed');
  const items: {tokens: SqlToken[]; before?: SqlToken; after?: SqlToken}[] = [{tokens: []}];
  depth = 0;
  for (let i = open + 1; i < close; i++) {
    const token = tokens[i]!;
    if (isPunct(token, '(')) depth++;
    else if (isPunct(token, ')')) depth--;
    if (depth === 0 && isPunct(token, ',')) {
      items[items.length - 1]!.after = token;
      items.push({tokens: [], before: token});
    } else {
      items[items.length - 1]!.tokens.push(token);
    }
  }
  const clauses: ForeignKeyClause[] = [];
  for (const item of items) {
    const t = item.tokens;
    if (t.length === 0) throw new Error('Empty item in CREATE TABLE');
    const k = isWord(t[0], 'CONSTRAINT') ? 2 : 0;
    if (isWord(t[k], 'FOREIGN') && isWord(t[k + 1], 'KEY')) {
      const child = nameList(t, k + 2);
      if (!isWord(t[child.end], 'REFERENCES')) throw new Error('FOREIGN KEY without REFERENCES');
      const parent = identifier(t[child.end + 1]);
      let i = child.end + 2, parentColumns: string[] = [];
      if (isPunct(t[i], '(')) ({names: parentColumns, end: i} = nameList(t, i));
      const suffix = foreignKeySuffix(t, i);
      if (suffix.end !== t.length) throw new Error('Unexpected text after a FOREIGN KEY clause');
      if (!item.before && !item.after) throw new Error('A table cannot consist of a foreign key only');
      clauses.push({form: 'table', columns: child.names, parent, parentColumns, deferred: suffix.deferred,
        removeStart: item.before ? item.before.start : t[0]!.start,
        removeEnd: item.before ? t[t.length - 1]!.end : item.after!.end});
    } else if (!isWord(t[k], 'PRIMARY') && !isWord(t[k], 'UNIQUE') && !isWord(t[k], 'CHECK')) {
      const column = identifier(t[0]);
      let level = 0;
      for (let i = 1; i < t.length; i++) {
        if (isPunct(t[i], '(')) level++;
        else if (isPunct(t[i], ')')) level--;
        else if (level === 0 && isWord(t[i], 'REFERENCES')) {
          const start = i >= 3 && isWord(t[i - 2], 'CONSTRAINT') ? i - 2 : i;
          const parent = identifier(t[i + 1]);
          let j = i + 2, parentColumns: string[] = [];
          if (isPunct(t[j], '(')) ({names: parentColumns, end: j} = nameList(t, j));
          const suffix = foreignKeySuffix(t, j);
          clauses.push({form: 'column', columns: [column], parent, parentColumns, deferred: suffix.deferred,
            removeStart: t[start - 1]!.end, removeEnd: t[suffix.end - 1]!.end});
          i = suffix.end - 1;
        }
      }
    }
  }
  return clauses;
}

/** Removes every foreign key whose parent table `isForeign` reports as living in
 * another database: a table constraint goes with its preceding comma, a column
 * constraint goes with its suffix clauses while the rest of the column stays. */
export function stripCrossFileForeignKeys(createTableSql: string, isForeign: (parentTable: string) => boolean): string {
  const ranges = foreignKeyClauses(createTableSql).filter(clause => isForeign(clause.parent))
    .map(clause => [clause.removeStart, clause.removeEnd] as const).sort((a, b) => b[0] - a[0]);
  let sql = createTableSql;
  for (const [start, end] of ranges) sql = sql.slice(0, start) + sql.slice(end);
  return sql;
}

// ---------------------------------------------------------------------------
// Rewrite rule (b): the project-deletion exemption

const EXEMPTION = String.raw`NOT EXISTS\(SELECT 1 FROM project_deletion_scope WHERE tableName='[^']*'(?: AND rowId=OLD\.rowid)?\)`;
/** `WHEN X BEGIN`; `WHEN X AND <rest>` (covers `AND (`, `AND NOT (` and `AND json_array(`); `WHEN cond AND X BEGIN`. */
const EXEMPTION_SHAPES: readonly {readonly pattern: RegExp; readonly replacement: string}[] = [
  {pattern: new RegExp(String.raw`\s+WHEN\s+${EXEMPTION}(?=\s+BEGIN\b)`, 'g'), replacement: ''},
  {pattern: new RegExp(String.raw`(\bWHEN\s+)${EXEMPTION}\s+AND\s+`, 'g'), replacement: '$1'},
  {pattern: new RegExp(String.raw`\s+AND\s+${EXEMPTION}(?=\s+BEGIN\b)`, 'g'), replacement: ''},
];

/** Removes the `NOT EXISTS(SELECT 1 FROM project_deletion_scope …)` term and its connective. */
export function stripDeletionExemption(triggerSql: string): string {
  const found = triggerSql.match(new RegExp(EXEMPTION, 'g'))?.length ?? 0;
  if (found !== 1) throw new Error(`Expected exactly one deletion exemption, found ${found}`);
  const shapes = EXEMPTION_SHAPES.filter(shape => (triggerSql.match(shape.pattern)?.length ?? 0) > 0);
  if (shapes.length !== 1) throw new Error('Deletion exemption is not in a supported position');
  const sql = triggerSql.replace(shapes[0]!.pattern, shapes[0]!.replacement);
  if (sql.includes('project_deletion_')) throw new Error('Deletion scope is still referenced');
  return sql;
}

// ---------------------------------------------------------------------------
// Rewrite rule (c): Mio storage quota without the application policy tables

export const POLICY_QUOTA_TERMS: readonly string[] = Object.freeze([
  '+(SELECT count(*) FROM agent_task_policy_v2)',
  '+(SELECT count(*) FROM agent_task_policy_requests_v2)',
  '+(SELECT COALESCE(sum(length(CAST(data AS BLOB))),0) FROM agent_task_policy_v2)',
  '+(SELECT COALESCE(sum(length(CAST(data AS BLOB))),0) FROM agent_task_policy_requests_v2)',
]);

/** Removes the two row-count and two byte-count terms of the policy tables; the limits stay. */
export function rewriteMioQuota(triggerSql: string): string {
  let sql = triggerSql;
  for (const term of POLICY_QUOTA_TERMS) {
    const found = sql.split(term).length - 1;
    if (found !== 1) throw new Error(`Expected the quota term ${term} exactly once, found ${found}`);
    sql = sql.replace(term, '');
  }
  if (/\bagent_task_policy(?:_requests)?_v2\b/.test(sql)) throw new Error('Quota trigger still reads a policy table');
  return sql;
}

// ---------------------------------------------------------------------------
// Rewrite rule (d): cross-file triggers become connection-level TEMP triggers

/** `CREATE TRIGGER` becomes `CREATE TEMP TRIGGER`; the ON table and every table
 * read after FROM/JOIN get their schema; INSERT INTO, UPDATE and DELETE FROM
 * targets stay unqualified. Any other use of a known table name is rejected. */
export function toTempTrigger(triggerSql: string, schemaOf: (table: string) => string | undefined): string {
  if (!triggerSql.startsWith('CREATE TRIGGER ')) throw new Error('Expected a CREATE TRIGGER statement');
  const tokens = tokenizeSql(triggerSql);
  const on = tokens.findIndex((token, i) => i > 2 && isWord(token, 'ON'));
  if (on < 0) throw new Error('Trigger has no ON clause');
  if (schemaOf(identifier(tokens[on + 1])) === undefined) throw new Error('Trigger table has no schema');
  const inserts: {at: number; text: string}[] = [];
  tokens.forEach((token, i) => {
    if (token.kind !== 'word' && token.kind !== 'quoted') return;
    const schema = schemaOf(token.value);
    if (schema === undefined) return;
    const previous = tokens[i - 1], beforePrevious = tokens[i - 2];
    if (isPunct(tokens[i + 1], '.')) return;
    if (isPunct(previous, '.')) throw new Error(`Table ${token.value} is already qualified`);
    if (i === on + 1 || ((isWord(previous, 'FROM') && !isWord(beforePrevious, 'DELETE')) || isWord(previous, 'JOIN'))) {
      inserts.push({at: token.start, text: `${schema}.`});
    } else if (!isWord(previous, 'INTO') && !isWord(previous, 'UPDATE') && !isWord(previous, 'FROM')) {
      throw new Error(`Unsupported reference to table ${token.value}`);
    }
  });
  let sql = triggerSql;
  for (const insert of inserts.reverse()) sql = sql.slice(0, insert.at) + insert.text + sql.slice(insert.at);
  return sql.replace(/^CREATE TRIGGER /, 'CREATE TEMP TRIGGER ');
}

/** Known tables a trigger reads or writes (table-qualified column names excluded). */
export function referencedTables(sql: string, known: ReadonlySet<string>): Set<string> {
  const tokens = tokenizeSql(sql), found = new Set<string>();
  tokens.forEach((token, i) => {
    if ((token.kind === 'word' || token.kind === 'quoted') && known.has(token.value.toLowerCase()) && !isPunct(tokens[i + 1], '.')) found.add(token.value.toLowerCase());
  });
  return found;
}

// ---------------------------------------------------------------------------
// Derivation

/** Where a format-72 object goes: built into one of the three databases, a TEMP
 * trigger, handed to the application database, dropped, present in every
 * database (`schema_version`) or created by SQLite (`sqlite_sequence`). */
export type ObjectFate = 'project' | 'history' | 'cache' | 'temp' | 'app' | 'dropped' | 'every-database' | 'automatic';
export type RewriteRule = 'foreign-keys' | 'exemption' | 'quota' | 'temp';

export interface DerivedObject {
  readonly type: string;
  readonly name: string;
  readonly table: string;
  readonly fate: ObjectFate;
  readonly rules: readonly RewriteRule[];
  readonly original: string | null;
  /** The DDL as built or handed over; null for dropped and automatic objects. */
  readonly sql: string | null;
}
export interface RelationData {
  readonly index: number;
  readonly child: {readonly schema: 'main' | 'cache'; readonly table: string; readonly columns: readonly string[]; readonly nullable: readonly boolean[]};
  readonly parent: {readonly schema: 'project'; readonly table: string; readonly columns: readonly string[]};
  readonly originallyDeferred: boolean;
}
export interface DroppedKeyData {
  readonly child: {readonly table: string; readonly columns: readonly string[]};
  readonly parent: {readonly table: string; readonly columns: readonly string[]};
  readonly originallyDeferred: boolean;
}
export interface ConvertedTriggerData {
  readonly name: string;
  readonly table: string;
  readonly schema: SchemaName;
  readonly sql: string;
}
export const DOMAIN_FILES = Object.freeze([
  {file: 'content', constant: 'CONTENT_SCHEMA', database: 'project', owner: '丙', tables: CONTENT_TABLES, about: 'content tables stored in the project file'},
  {file: 'receipts', constant: 'RECEIPT_SCHEMA', database: 'history', owner: '丙', tables: HISTORY_TABLES_BY_DOMAIN.receipts, about: 'request receipts in the local history database'},
  {file: 'tasks', constant: 'TASK_SCHEMA', database: 'history', owner: '丙', tables: HISTORY_TABLES_BY_DOMAIN.tasks, about: 'jobs and tasks in the local history database'},
  {file: 'timeline-history', constant: 'TIMELINE_HISTORY_SCHEMA', database: 'history', owner: '丙', tables: HISTORY_TABLES_BY_DOMAIN.timelineHistory, about: 'timeline undo history in the local history database'},
  {file: 'mio', constant: 'MIO_SCHEMA', database: 'history', owner: '己', tables: HISTORY_TABLES_BY_DOMAIN.mio, about: 'Mio task records in the local history database'},
  {file: 'cache', constant: 'CACHE_SCHEMA', database: 'cache', owner: '丁', tables: CACHE_TABLES, about: 'rebuildable data in the cache database'},
] as const);
export type DomainFile = (typeof DOMAIN_FILES)[number]['file'];

export interface Derivation {
  readonly format72: Format72;
  /** One entry per format-72 sqlite_master row, in rowid order. */
  readonly objects: readonly DerivedObject[];
  readonly domains: Readonly<Record<DomainFile, readonly string[]>>;
  readonly relations: readonly RelationData[];
  readonly droppedContentKeys: readonly DroppedKeyData[];
  readonly convertedTriggers: readonly ConvertedTriggerData[];
}

/** Schema names on the kernel connection: history.db is `main` (SQLite puts the
 * super-journal beside the main database, and the records directory does not
 * move), the project file is attached as `project` and cache.db as `cache`. */
export type SchemaName = 'project' | 'main' | 'cache';
export const SCHEMA_NAMES: Readonly<Record<'project' | 'history' | 'cache', SchemaName>> = Object.freeze({project: 'project', history: 'main', cache: 'cache'});
const SCHEMA_OF = SCHEMA_NAMES;
const kept = (placement: TablePlacement): placement is 'project' | 'history' | 'cache' => placement === 'project' || placement === 'history' || placement === 'cache';

/** Groups the format-72 schema by destination and applies rewrite rules (a)–(d). */
export function deriveFromFormat72(format72: Format72 = readFormat72()): Derivation {
  if (format72.version !== 72) throw new Error(`Expected the format-72 workspace, db.ts built format ${format72.version}`);
  const tableObjects = format72.objects.filter(object => object.type === 'table');
  const known = new Set(tableObjects.map(object => object.name).filter(name => name !== 'schema_version' && name !== 'sqlite_sequence'));
  for (const table of [...CONTENT_TABLES, ...HISTORY_TABLES, ...CACHE_TABLES]) if (!known.has(table)) throw new Error(`Format 72 has no table ${table}`);
  const placementOf = (table: string): TablePlacement => databaseOf(table);
  const schemaOf = (table: string): string | undefined => {
    const lower = table.toLowerCase();
    if (!known.has(lower)) return undefined;
    const placement = placementOf(lower);
    if (!kept(placement)) throw new Error(`Rewritten trigger still uses ${placement} table ${lower}`);
    return SCHEMA_OF[placement];
  };
  const objects = format72.objects.map((object): DerivedObject => {
    const base = {type: object.type, name: object.name, table: object.tbl_name, original: object.sql};
    if (object.type === 'table') {
      if (object.name === 'sqlite_sequence') return {...base, fate: 'automatic', rules: [], sql: null};
      if (object.name === 'schema_version') {
        if (object.sql !== SCHEMA_VERSION_TABLE_SQL) throw new Error('schema_version no longer matches databases.ts');
        return {...base, fate: 'every-database', rules: [], sql: object.sql};
      }
      const placement = placementOf(object.name);
      if (placement === 'removed') return {...base, fate: 'dropped', rules: [], sql: null};
      const sql = stripCrossFileForeignKeys(object.sql!, parent => placementOf(parent.toLowerCase()) !== placement);
      return {...base, fate: placement, rules: sql === object.sql ? [] : ['foreign-keys'], sql};
    }
    if (object.type === 'index') {
      const placement = placementOf(object.tbl_name);
      if (placement === 'removed') return {...base, fate: 'dropped', rules: [], sql: null};
      return {...base, fate: placement, rules: [], sql: object.sql};
    }
    if (object.type !== 'trigger') throw new Error(`Unsupported format-72 object ${object.type} ${object.name}`);
    const placement = placementOf(object.tbl_name);
    if (placement === 'removed') return {...base, fate: 'dropped', rules: [], sql: null};
    const rules: RewriteRule[] = [];
    let sql = object.sql!;
    if (sql.includes('project_deletion_')) { sql = stripDeletionExemption(sql); rules.push('exemption'); }
    let references = referencedTables(sql, known);
    if (placement === 'app') {
      const appOnly = [...references].every(table => placementOf(table) === 'app');
      return appOnly ? {...base, fate: 'app', rules, sql} : {...base, fate: 'dropped', rules: [], sql: null};
    }
    if ([...references].some(table => placementOf(table) === 'app')) {
      sql = rewriteMioQuota(sql);
      rules.push('quota');
      references = referencedTables(sql, known);
    }
    if ([...references].every(table => placementOf(table) === placement)) return {...base, fate: placement, rules, sql};
    rules.push('temp');
    return {...base, fate: 'temp', rules, sql: toTempTrigger(sql, schemaOf)};
  });

  const byTable = new Map<string, DerivedObject[]>();
  for (const object of objects) byTable.set(object.table, [...byTable.get(object.table) ?? [], object]);
  const tableStatements = (table: string): string[] => {
    const own = byTable.get(table) ?? [], placement = placementOf(table);
    const create = own.find(object => object.type === 'table')!;
    return [create.sql!,
      ...own.filter(object => object.type === 'index' && object.sql !== null).map(object => object.sql!),
      ...own.filter(object => object.type === 'trigger' && object.fate === placement).map(object => object.sql!)];
  };
  const domains = Object.fromEntries(DOMAIN_FILES.map(domain => [domain.file, domain.tables.flatMap(tableStatements)])) as Record<DomainFile, string[]>;

  const relations: RelationData[] = [], droppedContentKeys: DroppedKeyData[] = [];
  const keptTables = [...known].filter(table => kept(placementOf(table))).sort();
  for (const table of keptTables) {
    const placement = placementOf(table), shape = format72.tables.get(table)!;
    const clauses = foreignKeyClauses(tableObjects.find(object => object.name === table)!.sql!);
    const groups = new Map<number, Row[]>();
    for (const row of shape.foreignKeys) groups.set(Number(row.id), [...groups.get(Number(row.id)) ?? [], row]);
    for (const id of [...groups.keys()].sort((a, b) => a - b)) {
      const rows = groups.get(id)!.sort((a, b) => Number(a.seq) - Number(b.seq));
      const parent = String(rows[0]!.table).toLowerCase(), parentPlacement = placementOf(parent);
      if (parentPlacement === placement) continue;
      const columns = rows.map(row => String(row.from));
      if (rows.some(row => row.to === null)) throw new Error(`Foreign key ${table}#${id} has no parent columns`);
      const parentColumns = rows.map(row => String(row.to));
      const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, i) => value.toLowerCase() === b[i]!.toLowerCase());
      const matches = clauses.filter(clause => clause.parent.toLowerCase() === parent && same(clause.columns, columns) && same(clause.parentColumns, parentColumns));
      if (matches.length !== 1) throw new Error(`Cannot match foreign key ${table}#${id} to its SQL`);
      const originallyDeferred = matches[0]!.deferred;
      if ((placement === 'history' || placement === 'cache') && parentPlacement === 'project') {
        const info = new Map(shape.columns.map(column => [String(column.name), column]));
        relations.push({index: 0, child: {schema: placement === 'history' ? 'main' : 'cache', table, columns,
          nullable: columns.map(column => Number(info.get(column)!.notnull) === 0 && Number(info.get(column)!.pk) === 0)},
        parent: {schema: 'project', table: parent, columns: parentColumns}, originallyDeferred});
      } else if (placement === 'project' && parentPlacement === 'history') {
        droppedContentKeys.push({child: {table, columns}, parent: {table: parent, columns: parentColumns}, originallyDeferred});
      } else {
        throw new Error(`Unplanned cross-file foreign key ${table}#${id} -> ${parent}`);
      }
    }
  }
  const numbered = relations.map((relation, i) => ({...relation, index: i + 1}));

  const order = [...CONTENT_TABLES, ...HISTORY_TABLES, ...CACHE_TABLES];
  const convertedTriggers = order.flatMap(table => (byTable.get(table) ?? []).filter(object => object.fate === 'temp').map(object => {
    const placement = placementOf(table) as 'project' | 'history' | 'cache';
    return {name: object.name, table, schema: SCHEMA_OF[placement], sql: object.sql!};
  }));
  return {format72, objects, domains, relations: numbered, droppedContentKeys, convertedTriggers};
}

/** The domain statements that make up each database's share of the derivation. */
export function derivedDomainStatements(derivation: Derivation, kind: DatabaseKind): string[] {
  return DOMAIN_FILES.filter(domain => domain.database === kind).flatMap(domain => derivation.domains[domain.file]);
}

/** Builds `kind` in a fresh in-memory database as `main` and reads its manifest. */
export function buildManifest(kind: DatabaseKind, statements: readonly string[] = schemaStatements(kind)): ManifestEntry[] {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('BEGIN');
    buildDatabase(db, kind, 'main', statements);
    db.exec('COMMIT');
    return readSchemaManifest(db, 'main');
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Rendering

const VERSION_CONSTANTS: Readonly<Record<DatabaseKind, string>> = {project: 'PROJECT_FILE_SCHEMA_VERSION', history: 'HISTORY_SCHEMA_VERSION', cache: 'CACHE_SCHEMA_VERSION'};
const VERSIONS: Readonly<Record<DatabaseKind, number>> = {project: PROJECT_FILE_SCHEMA_VERSION, history: HISTORY_SCHEMA_VERSION, cache: CACHE_SCHEMA_VERSION};
const DERIVED = `// Derived from the format-72 workspace schema by \`${COMMAND} --write\`.`;
const json = (value: unknown): string => JSON.stringify(value);

function renderDomain(domain: (typeof DOMAIN_FILES)[number], statements: readonly string[], derivation: Derivation): string {
  const lines = [DERIVED, `// Owner: ${domain.owner} (${domain.about}).`,
    `// Changing this schema requires raising ${VERSION_CONSTANTS[domain.database]} in ../databases.ts and regenerating ../manifest.ts.`,
    `export const ${domain.constant}: readonly string[] = Object.freeze([`];
  let at = 0;
  for (const table of domain.tables) {
    const count = 1 + (derivation.objects.filter(object => object.table === table && object.type !== 'table' && object.fate === databaseOf(table) && object.sql !== null).length);
    lines.push(`  // ${table}`, ...statements.slice(at, at + count).map(sql => `  ${json(sql)},`));
    at += count;
  }
  if (at !== statements.length) throw new Error(`Domain ${domain.file} statements do not match its tables`);
  lines.push(']);', '');
  return lines.join('\n');
}

function renderRelations(derivation: Derivation): string {
  return [DERIVED,
    '// Foreign keys from tables in the local history or cache database to content tables in the project file.',
    '// SQLite cannot enforce them across files; the kernel emulates each one with connection-level TEMP triggers.',
    '// Schemas are the names on the kernel connection: history.db is main, the project file is attached as',
    '// project and cache.db as cache. Columns are in key order; `nullable` is per child column (PRIMARY KEY',
    '// columns count as NOT NULL).',
    'export interface CrossFileRelation {',
    '  readonly index: number;',
    "  readonly child: {readonly schema: 'main' | 'cache'; readonly table: string; readonly columns: readonly string[]; readonly nullable: readonly boolean[]};",
    "  readonly parent: {readonly schema: 'project'; readonly table: string; readonly columns: readonly string[]};",
    '  /** Declared DEFERRABLE INITIALLY DEFERRED in format 72; the emulation checks immediately. */',
    '  readonly originallyDeferred: boolean;',
    '}',
    '/** A format-72 foreign key from a content table to a process table in the local history database. Not enforced. */',
    'export interface DroppedContentKey {',
    '  readonly child: {readonly table: string; readonly columns: readonly string[]};',
    '  readonly parent: {readonly table: string; readonly columns: readonly string[]};',
    '  readonly originallyDeferred: boolean;',
    '}',
    'export const CROSS_FILE_RELATIONS: readonly CrossFileRelation[] = Object.freeze([',
    ...derivation.relations.map(relation => `  {index: ${relation.index}, child: {schema: ${json(relation.child.schema)}, table: ${json(relation.child.table)}, columns: ${json(relation.child.columns)}, nullable: ${json(relation.child.nullable)}}, parent: {schema: ${json(relation.parent.schema)}, table: ${json(relation.parent.table)}, columns: ${json(relation.parent.columns)}}, originallyDeferred: ${relation.originallyDeferred}},`),
    ']);',
    'export const DROPPED_CONTENT_KEYS: readonly DroppedContentKey[] = Object.freeze([',
    ...derivation.droppedContentKeys.map(key => `  {child: {table: ${json(key.child.table)}, columns: ${json(key.child.columns)}}, parent: {table: ${json(key.parent.table)}, columns: ${json(key.parent.columns)}}, originallyDeferred: ${key.originallyDeferred}},`),
    ']);',
    ''].join('\n');
}

function renderConvertedTriggers(derivation: Derivation): string {
  return [DERIVED,
    '// Format-72 triggers that read or write a table in another database of the project, as connection-level',
    '// TEMP triggers. The ON table and tables read after FROM/JOIN carry their schema on the kernel connection',
    '// (content tables project., history tables main., cache tables cache.); write targets stay unqualified.',
    '// Target-revision triggers on process tables also lost the project-deletion exemption.',
    'export interface ConvertedTempTrigger {',
    '  readonly name: string;',
    '  readonly table: string;',
    "  readonly schema: 'project' | 'main' | 'cache';",
    '  readonly sql: string;',
    '}',
    'export const CONVERTED_TEMP_TRIGGERS: readonly ConvertedTempTrigger[] = Object.freeze([',
    ...derivation.convertedTriggers.map(trigger => `  {name: ${json(trigger.name)}, table: ${json(trigger.table)}, schema: ${json(trigger.schema)}, sql: ${json(trigger.sql)}},`),
    ']);',
    ''].join('\n');
}

function renderManifest(derivation: Derivation): string {
  const lines = [`// Generated by \`${COMMAND} --write\`: every sqlite_master row of each database`,
    '// as built by buildDatabase(), with the SHA-256 of its stored SQL.',
    "import type {DatabaseKind} from './databases.ts';",
    "import type {SchemaManifest} from './manifest-check.ts';",
    'export const SCHEMA_MANIFEST: Readonly<Record<DatabaseKind, SchemaManifest>> = Object.freeze({'];
  for (const kind of ['project', 'history', 'cache'] as const) {
    const entries = buildManifest(kind, schemaStatements(kind, derivedDomainStatements(derivation, kind)));
    lines.push(`  ${kind}: {version: ${VERSIONS[kind]}, entries: Object.freeze([`,
      ...entries.map(entry => `    {type: ${json(entry.type)}, name: ${json(entry.name)}, tbl_name: ${json(entry.tbl_name)}, sha256: ${json(entry.sha256)}},`),
      '  ])},');
  }
  lines.push('});', '');
  return lines.join('\n');
}

const KERNEL = 'packages/business/src/project-file';
/** Repository-relative path -> exact file text of every generated file. */
export function renderDerivedFiles(derivation: Derivation = deriveFromFormat72()): Map<string, string> {
  const files = new Map<string, string>();
  for (const domain of DOMAIN_FILES) files.set(`${KERNEL}/schema/domains/${domain.file}.ts`, renderDomain(domain, derivation.domains[domain.file], derivation));
  files.set(`${KERNEL}/cross-file/relations.ts`, renderRelations(derivation));
  files.set(`${KERNEL}/cross-file/converted-triggers.ts`, renderConvertedTriggers(derivation));
  files.set(`${KERNEL}/schema/manifest.ts`, renderManifest(derivation));
  return files;
}

/** Generated files whose committed text differs from `files`. */
export function staleDerivedFiles(files: ReadonlyMap<string, string>): string[] {
  const read = (file: string): string | null => { try { return readFileSync(path.join(REPOSITORY, file), 'utf8'); } catch { return null; } };
  return [...files].filter(([file, text]) => read(file) !== text).map(([file]) => file);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || (args[0] !== '--write' && args[0] !== '--check')) {
    process.stderr.write(`Usage: ${COMMAND} --write|--check\n`);
    process.exitCode = 2;
  } else {
    const files = renderDerivedFiles();
    if (args[0] === '--write') {
      for (const [file, text] of files) {
        mkdirSync(path.dirname(path.join(REPOSITORY, file)), {recursive: true});
        writeFileSync(path.join(REPOSITORY, file), text);
      }
      process.stdout.write(`Wrote ${files.size} derived files.\n`);
    } else {
      const stale = staleDerivedFiles(files);
      if (stale.length) {
        process.stderr.write(`Derived project-file schema files differ from a fresh format-72 derivation:\n${stale.map(file => `  ${file}\n`).join('')}Run \`${COMMAND} --write\`.\n`);
        process.exitCode = 1;
      } else {
        process.stdout.write(`All ${files.size} derived files match format 72.\n`);
      }
    }
  }
}
