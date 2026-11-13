// Current project-file schema declarations -> real SQLite -> manifest.
//   node tests/helpers/project-file-schema-derivation.ts --write|--check|--report
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {SQLOutputValue} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {buildDatabase, schemaStatements, PROJECT_FILE_SCHEMA_VERSION, HISTORY_SCHEMA_VERSION, CACHE_SCHEMA_VERSION, FORMAT4_PROJECT_SCHEMA_VERSION, FORMAT4_HISTORY_SCHEMA_VERSION} from '../../packages/business/src/project-file/schema/databases.ts';
import type {DatabaseKind} from '../../packages/business/src/project-file/schema/databases.ts';
import {readSchemaManifest} from '../../packages/business/src/project-file/schema/manifest-check.ts';
import type {ManifestEntry} from '../../packages/business/src/project-file/schema/manifest-check.ts';
import {CONTENT_TABLES, CACHE_TABLES, historyTablesForVersion} from '../../packages/business/src/project-file/schema/tables.ts';
import {CROSS_FILE_RELATIONS, FORMAT4_CROSS_FILE_RELATIONS} from '../../packages/business/src/project-file/cross-file/relations.ts';
import type {CrossFileRelation} from '../../packages/business/src/project-file/cross-file/relations.ts';
import {CONVERTED_TEMP_TRIGGERS} from '../../packages/business/src/project-file/cross-file/converted-triggers.ts';
import type {ConvertedTempTrigger} from '../../packages/business/src/project-file/cross-file/converted-triggers.ts';
import {relationTriggerStatements, SEEN_SEQUENCE_TRIGGER} from '../../packages/business/src/project-file/cross-file/install.ts';
import {tokenizeSql} from './sql-tokenizer.ts';
import {verifyTempGuardBehavior} from './project-file-temp-probes.ts';
import {installRestoreScopeFunction} from '../../packages/business/src/project-file/cross-file/restore-admission.ts';

export const REPOSITORY = fileURLToPath(new URL('../../', import.meta.url));
const COMMAND = 'node tests/helpers/project-file-schema-derivation.ts';
const KINDS = ['project', 'history', 'cache'] as const;
const SCHEMAS = {project: 'project', history: 'main', cache: 'cache'} as const;
const VERSIONS = {project: PROJECT_FILE_SCHEMA_VERSION, history: HISTORY_SCHEMA_VERSION, cache: CACHE_SCHEMA_VERSION};
const METADATA = {project: ['schema_version', 'project_file'], history: ['schema_version', 'history_state', 'project_history_resolution'], cache: ['schema_version']} as const;
const quote = (name: string): string => '"' + name.replaceAll('"', '""') + '"';
type Row = Record<string, SQLOutputValue>;

export interface TableShape {
  readonly columns: readonly Row[];
  readonly foreignKeys: readonly Row[];
  readonly indexes: readonly Row[];
  readonly indexColumns: Readonly<Record<string, readonly Row[]>>;
}
export function readTableShape(db: DatabaseSync, table: string, schema = 'main'): TableShape {
  const indexes = db.prepare(`PRAGMA ${quote(schema)}.index_list(${quote(table)})`).all();
  return {
    columns: db.prepare(`PRAGMA ${quote(schema)}.table_xinfo(${quote(table)})`).all(),
    foreignKeys: db.prepare(`PRAGMA ${quote(schema)}.foreign_key_list(${quote(table)})`).all(),
    indexes,
    indexColumns: Object.fromEntries(indexes.map(index => [String(index.name), db.prepare(`PRAGMA ${quote(schema)}.index_xinfo(${quote(String(index.name))})`).all()])),
  };
}

/** Inputs are source declarations. The generated manifest is deliberately not
 * imported here, and --write never rewrites a domain, relation or old version. */
export interface SchemaDeclarations {
  readonly statements: Readonly<Record<DatabaseKind, readonly string[]>>;
  readonly tables: Readonly<Record<DatabaseKind, readonly string[]>>;
  readonly relations: readonly CrossFileRelation[];
  readonly tempTriggers: readonly ConvertedTempTrigger[];
}
export function declaredSchema(format4 = false): SchemaDeclarations {
  const project = format4 ? FORMAT4_PROJECT_SCHEMA_VERSION : PROJECT_FILE_SCHEMA_VERSION;
  const history = format4 ? FORMAT4_HISTORY_SCHEMA_VERSION : HISTORY_SCHEMA_VERSION;
  return {
    statements: {project: schemaStatements('project', undefined, project), history: schemaStatements('history', undefined, history), cache: schemaStatements('cache')},
    tables: {project: CONTENT_TABLES, history: historyTablesForVersion(history), cache: CACHE_TABLES},
    relations: format4 ? FORMAT4_CROSS_FILE_RELATIONS : CROSS_FILE_RELATIONS,
    tempTriggers: CONVERTED_TEMP_TRIGGERS,
  };
}
const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const sorted = (names: readonly string[]): string[] => [...names].sort();
const signature = (relation: CrossFileRelation): string => `${relation.child.schema}.${relation.child.table}(${relation.child.columns.join(',')})->${relation.parent.schema}.${relation.parent.table}(${relation.parent.columns.join(',')})`;

function triggerTarget(sql: string): {schema: string; table: string; name: string} {
  const tokens = tokenizeSql(sql);
  if (tokens[0]?.value.toUpperCase() !== 'CREATE' || tokens[1]?.value.toUpperCase() !== 'TEMP' || tokens[2]?.value.toUpperCase() !== 'TRIGGER') throw new Error('Expected a CREATE TEMP TRIGGER declaration');
  const on = tokens.findIndex(t => t.kind === 'word' && t.value.toUpperCase() === 'ON');
  if (on < 0 || tokens[on + 2]?.text !== '.' || !tokens[on + 3]) throw new Error('TEMP trigger needs a qualified target table');
  return {name: tokens[3]!.value, schema: tokens[on + 1]!.value, table: tokens[on + 3]!.value};
}

/** Validate logical declarations against native column/index/FK metadata and
 * compile every DML with the actual attached databases and TEMP guards. These
 * checks complement the versioned manifest and independent behavioral tests. */
export function validateDeclaredSchema(input: SchemaDeclarations = declaredSchema()): void {
  const db = new DatabaseSync(':memory:');
  try {
    installRestoreScopeFunction(db);
    db.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; ATTACH DATABASE ':memory:' AS project; ATTACH DATABASE ':memory:' AS cache; BEGIN");
    for (const kind of KINDS) buildDatabase(db, kind, SCHEMAS[kind], input.statements[kind]);
    db.exec('COMMIT');
    const owners = new Map<string, string>();
    for (const kind of KINDS) {
      const schema = SCHEMAS[kind], listed = input.tables[kind];
      if (new Set(listed).size !== listed.length) throw new Error(`Duplicate ${kind} table declaration`);
      const actual = db.prepare(`SELECT name FROM ${quote(schema)}.sqlite_master WHERE type='table'`).all().map(row => String(row.name))
        .filter(name => !name.startsWith('sqlite_') && !(METADATA[kind] as readonly string[]).includes(name));
      if (!same(sorted(actual), sorted(listed))) throw new Error(`Declared ${kind} tables do not match SQLite: expected ${sorted(listed).join(',')}; found ${sorted(actual).join(',')}`);
      for (const table of [...listed, ...METADATA[kind]]) {
        if (table !== 'schema_version') {
          if (owners.has(table)) throw new Error(`Table ${table} has multiple database owners`);
          owners.set(table, schema);
        }
      }
      for (const table of listed) {
        const shape = readTableShape(db, table, schema);
        for (const fk of shape.foreignKeys) {
          if (![...listed, ...METADATA[kind]].includes(String(fk.table))) throw new Error(`Persistent foreign key ${schema}.${table} crosses databases`);
        }
      }
    }
    const indexes = new Set<number>(), signatures = new Set<string>();
    for (const relation of input.relations) {
      const key = signature(relation);
      if (!Number.isSafeInteger(relation.index) || relation.index < 1 || indexes.has(relation.index)) throw new Error(`Invalid or duplicate relation index ${relation.index}`);
      indexes.add(relation.index);
      if (signatures.has(key)) throw new Error(`Duplicate cross-file relation ${key}`);
      signatures.add(key);
      const child = relation.child, parent = relation.parent;
      if (!['main', 'cache'].includes(child.schema) || parent.schema !== 'project' || owners.get(child.table) !== child.schema || owners.get(parent.table) !== parent.schema) throw new Error(`Cross-file relation ${key} has an invalid database owner`);
      if (!child.columns.length || child.columns.length !== parent.columns.length || child.columns.length !== child.nullable.length) throw new Error(`Cross-file relation ${key} has mismatched key columns`);
      const childShape = readTableShape(db, child.table, child.schema), parentShape = readTableShape(db, parent.table, parent.schema);
      const childColumns = new Map(childShape.columns.map(column => [String(column.name), column]));
      for (let i = 0; i < child.columns.length; i++) {
        const name = child.columns[i]!, column = childColumns.get(name);
        if (!column) throw new Error(`Cross-file relation ${key} has no child column ${name}`);
        const nullable = Number(column.notnull) === 0 && Number(column.pk) === 0;
        if (nullable !== child.nullable[i]) throw new Error(`Cross-file relation ${key} has incorrect nullability for ${name}`);
      }
      if (parent.columns.some(name => !parentShape.columns.some(column => column.name === name))) throw new Error(`Cross-file relation ${key} has a missing parent column`);
      const primary = parentShape.columns.filter(column => Number(column.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map(column => String(column.name));
      const uniqueKeys = [primary, ...parentShape.indexes.filter(index => Number(index.unique) === 1 && Number(index.partial) === 0)
        .map(index => parentShape.indexColumns[String(index.name)]!.filter(column => Number(column.key) === 1).map(column => String(column.name)))];
      if (!uniqueKeys.some(columns => same(columns, parent.columns))) throw new Error(`Cross-file relation ${key} has no ordered unique parent key`);
    }
    // A local projectId may bind directly or through an existing composite FK
    // (for example subject_variant_items -> subject_variant_batches).
    const projectBound = (schema: string, table: string, column: string, visited = new Set<string>()): boolean => {
      if (schema === 'project' && table === 'projects' && column === 'id') return true;
      const key = `${schema}.${table}.${column}`;
      if (visited.has(key)) return false;
      const next = new Set([...visited, key]);
      for (const relation of input.relations) {
        if (relation.child.schema !== schema || relation.child.table !== table) continue;
        const at = relation.child.columns.indexOf(column);
        if (at >= 0 && projectBound(relation.parent.schema, relation.parent.table, relation.parent.columns[at]!, next)) return true;
      }
      return readTableShape(db, table, schema).foreignKeys.some(fk => fk.from === column && typeof fk.to === 'string' && projectBound(schema, String(fk.table), fk.to, next));
    };
    // These local UI records deliberately outlive missing content targets.
    // Prove their native history_state guard instead of adding a content FK.
    const draftProjectBound = (kind: DatabaseKind, table: string): boolean => {
      const kinds: Record<string, string> = {local_clip_drafts: 'clip', local_delivery_drafts: 'delivery', local_shot_text_drafts: 'shot-text'};
      if (kind !== 'history' || !Object.hasOwn(kinds, table)) return false;
      const projectId = '11111111-1111-4111-8111-111111111111', foreign = '22222222-2222-4222-8222-222222222222';
      db.exec('SAVEPOINT draft_project_guard_probe');
      try {
        db.prepare('INSERT INTO main.history_state(singleton,projectId,seenContentSequence) VALUES(1,?,0)').run(projectId);
        db.prepare('INSERT INTO main.local_draft_states VALUES(?,?)').run(kinds[table]!, '0'.repeat(64));
        const row: Record<string, unknown> = table === 'local_clip_drafts'
          ? {projectId: foreign, timelineId: projectId, clipId: projectId, revision: 1, draft: null}
          : {projectId: foreign, ...(table === 'local_shot_text_drafts' ? {shotId: projectId} : {}), draftRevision: 1, draft: null, intentRevision: 0, intent: null};
        const columns = Object.keys(row).filter(key => !['draft', 'intent'].includes(key));
        const values = columns.map(key => row[key] as string | number);
        const insert = db.prepare(`INSERT INTO main.${table}(${columns.join(',')},ordinal,data) VALUES(${columns.map(() => '?').join(',')},1,?)`);
        let rejected = false;
        try {insert.run(...values, JSON.stringify(row));}
        catch (error) {rejected = error instanceof Error && error.message === 'LOCAL_DRAFT_SQL_PROJECT';}
        if (!rejected) throw new Error(`Missing native history project guard for ${table}`);
        row.projectId = projectId;
        insert.run(...columns.map(key => row[key] as string | number), JSON.stringify(row));
        return true;
      } finally {db.exec('ROLLBACK TO draft_project_guard_probe; RELEASE draft_project_guard_probe');}
    };
    for (const kind of ['history', 'cache'] as const) for (const table of input.tables[kind]) {
      if (readTableShape(db, table, SCHEMAS[kind]).columns.some(column => column.name === 'projectId') &&
          !projectBound(SCHEMAS[kind], table, 'projectId') && !draftProjectBound(kind, table)) {
        throw new Error(`Missing project relation for ${SCHEMAS[kind]}.${table}`);
      }
    }
    const required = new Set(CONVERTED_TEMP_TRIGGERS.map(trigger => trigger.name)), found = new Set<string>();
    for (const trigger of input.tempTriggers) {
      if (found.has(trigger.name)) throw new Error(`Duplicate TEMP trigger ${trigger.name}`);
      found.add(trigger.name);
      if (!required.has(trigger.name)) throw new Error(`Unexpected TEMP trigger ${trigger.name}`);
      const target = triggerTarget(trigger.sql);
      if (target.name !== trigger.name) throw new Error(`TEMP trigger ${trigger.name} has mismatched SQL name`);
      if (target.schema !== trigger.schema) throw new Error(`TEMP trigger ${trigger.name} has mismatched target schema`);
      if (target.table !== trigger.table || owners.get(trigger.table) !== trigger.schema) throw new Error(`TEMP trigger ${trigger.name} has mismatched target table`);
    }
    for (const name of required) if (!found.has(name)) throw new Error(`Missing TEMP trigger ${name}`);
    for (const trigger of input.tempTriggers) db.exec(trigger.sql);
    for (const relation of input.relations) for (const sql of relationTriggerStatements(relation)) db.exec(sql);
    db.exec(SEEN_SEQUENCE_TRIGGER);
    for (const kind of KINDS) for (const table of [...input.tables[kind], ...METADATA[kind]]) {
      const schema = SCHEMAS[kind], target = `${quote(schema)}.${quote(table)}`;
      const columns = readTableShape(db, table, schema).columns.filter(column => Number(column.hidden) === 0).map(column => quote(String(column.name)));
      for (const sql of [`EXPLAIN INSERT INTO ${target} DEFAULT VALUES`, `EXPLAIN UPDATE ${target} SET ${columns.map(column => `${column}=${column}`).join(',')}`, `EXPLAIN DELETE FROM ${target}`]) db.prepare(sql).all();
    }
    verifyTempGuardBehavior(input.tempTriggers, KINDS.flatMap(kind => [...input.tables[kind], ...METADATA[kind]].map(name => ({
      schema: SCHEMAS[kind], name,
      columns: readTableShape(db, name, SCHEMAS[kind]).columns.map(column => ({name:String(column.name), type:String(column.type)})),
    }))));
  } finally { db.close(); }
}

/** Build an independent SQLite catalog, not the generated expected manifest. */
export function buildManifest(kind: DatabaseKind, statements: readonly string[] = schemaStatements(kind)): ManifestEntry[] {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('BEGIN'); buildDatabase(db, kind, 'main', statements); db.exec('COMMIT');
    return readSchemaManifest(db, 'main');
  } finally { db.close(); }
}
const MANIFEST = 'packages/business/src/project-file/schema/manifest.ts';
export function renderDerivedFiles(input: SchemaDeclarations = declaredSchema()): Map<string, string> {
  validateDeclaredSchema(input);
  const candidate = declaredSchema(true);
  validateDeclaredSchema(candidate);
  const render = (entry: ManifestEntry) => `    {type: ${JSON.stringify(entry.type)}, name: ${JSON.stringify(entry.name)}, tbl_name: ${JSON.stringify(entry.tbl_name)}, sha256: ${JSON.stringify(entry.sha256)}},`;
  const lines = [`// Generated by \`${COMMAND} --write\`: every sqlite_master row of each database`,
    '// as built by buildDatabase(), with the SHA-256 of its stored SQL.',
    "import type {DatabaseKind} from './databases.ts';", "import type {SchemaManifest} from './manifest-check.ts';",
    'export const SCHEMA_MANIFEST: Readonly<Record<DatabaseKind, SchemaManifest>> = Object.freeze({'];
  for (const kind of KINDS) {
    lines.push(`  ${kind}: {version: ${VERSIONS[kind]}, entries: Object.freeze([`,
      ...buildManifest(kind, input.statements[kind]).map(render),
      '  ])},');
  }
  lines.push('});', '', 'export const FORMAT4_MANIFEST_CHANGES: Readonly<Record<"project" | "history", SchemaManifest>> = Object.freeze({');
  for (const [kind, version] of [['project', FORMAT4_PROJECT_SCHEMA_VERSION], ['history', FORMAT4_HISTORY_SCHEMA_VERSION]] as const) {
    const before = new Map(buildManifest(kind, input.statements[kind]).map(entry => [entry.name, entry]));
    const after = buildManifest(kind, candidate.statements[kind]);
    const afterNames = new Set(after.map(entry => entry.name));
    if ([...before.keys()].some(name => !afterNames.has(name))) throw new Error(`The format 4 profile removes a ${kind} schema object`);
    const changed = after.filter(entry => JSON.stringify(before.get(entry.name)) !== JSON.stringify(entry));
    lines.push(`  ${kind}: {version: ${version}, entries: Object.freeze([`, ...changed.map(render), '  ])},');
  }
  lines.push('});', '');
  return new Map([[MANIFEST, lines.join('\n')]]);
}
export function staleDerivedFiles(files: ReadonlyMap<string, string>): string[] {
  return [...files].filter(([file, contents]) => {
    try { return readFileSync(path.join(REPOSITORY, file), 'utf8') !== contents; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
  }).map(([file]) => file);
}
export function renderReport(): string {
  const input = declaredSchema(); validateDeclaredSchema(input);
  return ['# Current project-file schema', '',
    ...KINDS.map(kind => `- ${kind}: version ${VERSIONS[kind]}, ${input.tables[kind].length} business tables, ${buildManifest(kind).length} manifest entries`),
    '', '## Cross-file NO ACTION relations', '', '| Index | Child | Parent |', '|---|---|---|',
    ...input.relations.map(relation => `| ${relation.index} | ${relation.child.schema}.${relation.child.table}(${relation.child.columns.join(',')}) | ${relation.parent.schema}.${relation.parent.table}(${relation.parent.columns.join(',')}) |`),
    '', '## Connection TEMP triggers', '', ...input.tempTriggers.map(trigger => `- ${trigger.name}: ${trigger.schema}.${trigger.table}`), ''].join('\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--write', '--check', '--report'].includes(args[0]!)) {
    process.stderr.write(`Usage: ${COMMAND} --write|--check|--report\n`); process.exitCode = 2;
  } else if (args[0] === '--report') process.stdout.write(renderReport());
  else {
    const files = renderDerivedFiles();
    if (args[0] === '--write') {
      for (const [file, contents] of files) writeFileSync(path.join(REPOSITORY, file), contents);
      process.stdout.write('Wrote the current schema manifest from canonical declarations and real SQLite.\n');
    } else {
      const stale = staleDerivedFiles(files);
      if (stale.length) { process.stderr.write(`Generated schema manifest differs from canonical declarations:\n${stale.map(file => `  ${file}\n`).join('')}Run \`${COMMAND} --write\`.\n`); process.exitCode = 1; }
      else process.stdout.write('Current schema manifest matches canonical declarations and real SQLite.\n');
    }
  }
}
