import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import type {SQLOutputValue} from 'node:sqlite';
import {
  buildManifest, deriveFromFormat72, foreignKeyClauses, readFormat72, readTableShape, renderDerivedFiles, rewriteMioQuota,
  staleDerivedFiles, stripCrossFileForeignKeys, stripDeletionExemption, toTempTrigger, POLICY_QUOTA_TERMS,
} from './helpers/project-file-schema-derivation.ts';
import type {Derivation, DerivedObject} from './helpers/project-file-schema-derivation.ts';
import {
  buildDatabase, schemaStatements, CACHE_APPLICATION_ID, CACHE_SCHEMA_VERSION, HISTORY_APPLICATION_ID, HISTORY_SCHEMA_VERSION,
  PROJECT_FILE_APPLICATION_ID, PROJECT_FILE_SCHEMA_VERSION,
} from '../packages/business/src/project-file/schema/databases.ts';
import type {DatabaseKind} from '../packages/business/src/project-file/schema/databases.ts';
import {compareManifest, readSchemaManifest} from '../packages/business/src/project-file/schema/manifest-check.ts';
import {SCHEMA_MANIFEST} from '../packages/business/src/project-file/schema/manifest.ts';
import {
  APP_DATABASE_TABLES, CACHE_TABLES, CONTENT_TABLES, HISTORY_TABLES, HISTORY_TABLES_BY_DOMAIN, REMOVED_TABLES, databaseOf,
} from '../packages/business/src/project-file/schema/tables.ts';
import {CROSS_FILE_RELATIONS, DROPPED_CONTENT_KEYS} from '../packages/business/src/project-file/cross-file/relations.ts';
import {CONVERTED_TEMP_TRIGGERS} from '../packages/business/src/project-file/cross-file/converted-triggers.ts';

type Row = Record<string, SQLOutputValue>;
const KINDS = ['project', 'history', 'cache'] as const;
const IDENTITY: Readonly<Record<DatabaseKind, {version: number; applicationId: number}>> = {
  project: {version: PROJECT_FILE_SCHEMA_VERSION, applicationId: PROJECT_FILE_APPLICATION_ID},
  history: {version: HISTORY_SCHEMA_VERSION, applicationId: HISTORY_APPLICATION_ID},
  cache: {version: CACHE_SCHEMA_VERSION, applicationId: CACHE_APPLICATION_ID},
};
let derived: Derivation | undefined;
const derivation = (): Derivation => derived ??= deriveFromFormat72(readFormat72());
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

function buildAlone(kind: DatabaseKind, schema = 'main'): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  if (schema !== 'main') db.exec(`ATTACH DATABASE ':memory:' AS ${schema}`);
  db.exec('BEGIN');
  buildDatabase(db, kind, schema);
  db.exec('COMMIT');
  return db;
}
function masterNames(db: DatabaseSync, type: string): string[] {
  return db.prepare('SELECT name FROM sqlite_master WHERE type=? ORDER BY name').all(type).map(row => String(row.name));
}
const count = (objects: readonly DerivedObject[], filter: (object: DerivedObject) => boolean): number => objects.filter(filter).length;

test('generated schema files equal a fresh derivation from the format-72 workspace', () => {
  const files = renderDerivedFiles(derivation());
  assert.deepEqual([...files.keys()].sort(), [
    'packages/business/src/project-file/cross-file/converted-triggers.ts',
    'packages/business/src/project-file/cross-file/relations.ts',
    ...['cache', 'content', 'mio', 'receipts', 'tasks', 'timeline-history'].map(file => `packages/business/src/project-file/schema/domains/${file}.ts`),
    'packages/business/src/project-file/schema/manifest.ts',
  ]);
  assert.deepEqual(staleDerivedFiles(files), [], 'run `node tests/helpers/project-file-schema-derivation.ts --write`');
});

test('table placement lists every kept, application and removed table once', () => {
  // The task domain holds the Mock provider's two ledger tables as well.
  assert.deepEqual([CONTENT_TABLES.length, HISTORY_TABLES.length, CACHE_TABLES.length, APP_DATABASE_TABLES.length, REMOVED_TABLES.length], [18, 45 + 2, 2, 3, 10]);
  assert.deepEqual(Object.entries(HISTORY_TABLES_BY_DOMAIN).map(([domain, tables]) => [domain, tables.length]),
    [['receipts', 17], ['tasks', 13 + 2], ['timelineHistory', 2], ['mio', 13]]);
  const all = [...CONTENT_TABLES, ...HISTORY_TABLES, ...CACHE_TABLES, ...APP_DATABASE_TABLES, ...REMOVED_TABLES];
  assert.equal(new Set(all).size, 78 + 2);
  assert.equal(databaseOf('jobs'), 'history');
  assert.deepEqual(['mock_provider_tasks', 'mock_provider_submissions'].map(table => [databaseOf(table), HISTORY_TABLES_BY_DOMAIN.tasks.includes(table)]), [['history', true], ['history', true]]);
  assert.equal(databaseOf('workspace_preferences'), 'app');
  assert.throws(() => databaseOf('schema_version'), /Unknown project-file table/);
  assert.throws(() => databaseOf('no_such_table'), /Unknown project-file table/);
});

test('every format-72 object has exactly one destination and the planned counts', () => {
  const {format72, objects, relations, droppedContentKeys, convertedTriggers} = derivation();
  assert.equal(format72.version, 72);
  assert.equal(objects.length, format72.objects.length);
  assert.equal(new Set(objects.map(object => `${object.type}:${object.name}`)).size, objects.length);
  const of = (type: string) => objects.filter(object => object.type === type);
  const fates = (type: string) => Object.fromEntries([...new Set(of(type).map(object => object.fate))].sort().map(fate => [fate, count(of(type), object => object.fate === fate)]));
  // Format 72: 79 tables plus sqlite_sequence, 187 indexes (59 explicit), 302 triggers, no views. The
  // Mock provider's ledger adds 2 tables and 3 indexes (1 explicit), all kept as they are in the local records.
  assert.deepEqual([of('table').length, of('index').length, of('trigger').length, objects.length], [80 + 2, 187 + 3, 302, 569 + 5]);
  assert.equal(count(of('index'), object => object.original !== null), 59 + 1);
  assert.deepEqual(objects.filter(object => object.table.startsWith('mock_provider_')).map(object => `${object.type}:${object.name}:${object.fate}:${object.rules.join('+') || 'unchanged'}`).sort(), [
    'index:mock_provider_submissions_request:history:unchanged', 'index:sqlite_autoindex_mock_provider_tasks_1:history:unchanged',
    'index:sqlite_autoindex_mock_provider_tasks_2:history:unchanged', 'table:mock_provider_submissions:history:unchanged', 'table:mock_provider_tasks:history:unchanged']);
  assert.deepEqual(fates('table'), {app: 3, automatic: 1, cache: 2, dropped: 10, 'every-database': 1, history: 45 + 2, project: 18});
  assert.deepEqual(fates('index'), {app: 2, cache: 6, dropped: 19, history: 106 + 3, project: 54});
  const explicit = (fate: string) => count(of('index'), object => object.fate === fate && object.original !== null);
  assert.deepEqual(KINDS.map(explicit), [19, 33 + 1, 3]);
  // scene_task_state_transitions names shots only in the string literal OLD.kind='shots' and
  // reads no other table, so it stays a persistent history trigger.
  assert.deepEqual(fates('trigger'), {app: 2, cache: 1, dropped: 20, history: 162, project: 91, temp: 26});
  const triggers = of('trigger');
  const rules = (object: DerivedObject) => object.rules.join('+') || 'unchanged';
  const split = (fate: string) => Object.fromEntries([...new Set(triggers.filter(object => object.fate === fate).map(rules))].sort()
    .map(rule => [rule, count(triggers, object => object.fate === fate && rules(object) === rule)]));
  assert.deepEqual(split('project'), {exemption: 63, unchanged: 28});
  assert.equal(count(triggers, object => object.fate === 'project' && object.rules.includes('exemption') && object.name.startsWith('agent_target_')), 56);
  assert.deepEqual(split('history'), {exemption: 32, quota: 16, unchanged: 114});
  assert.ok(triggers.find(object => object.name === 'agent_task_model_request_delete_v60')?.rules.includes('exemption'));
  assert.ok(triggers.find(object => object.name === 'scene_task_state_transitions')?.fate === 'history');
  assert.deepEqual(split('cache'), {unchanged: 1});
  assert.deepEqual(split('temp'), {'exemption+temp': 12, temp: 14});
  assert.ok(triggers.filter(object => object.rules.join('+') === 'exemption+temp').every(object => /^agent_target_(jobs|exports|image_tasks|frame_tasks)_/.test(object.name)));
  const tempOn = (placement: string) => triggers.filter(object => object.fate === 'temp' && object.rules.length === 1 && databaseOf(object.table) === placement).map(object => object.name).sort();
  assert.deepEqual(tempOn('project'), ['reject_image_frame_asset_owner', 'reject_legacy_frame_asset_owner', 'scene_result_identity', 'subject_variant_version_binding']);
  assert.deepEqual(tempOn('history'), ['frame_asset_project', 'previs_request_identity', 'reject_frame_mixed_asset_owner', 'scene_request_identity',
    'scene_task_insert_identity', 'scene_task_result_binding', 'subject_variant_batch_insert_identity', 'subject_variant_item_version']);
  assert.deepEqual(tempOn('cache'), ['previs_thumbnail_insert_identity', 'previs_thumbnail_update_identity']);
  assert.deepEqual(split('app'), {exemption: 1, unchanged: 1});
  assert.deepEqual(triggers.filter(object => object.fate === 'app').map(object => object.name).sort(), ['immutable_agent_task_policy_requests_v2', 'retain_agent_task_policy_requests_v2']);
  assert.equal(count(triggers, object => object.fate === 'dropped' && databaseOf(object.table) === 'removed'), 16);
  assert.equal(count(triggers, object => object.fate === 'dropped' && databaseOf(object.table) === 'app' && object.name.startsWith('agent_quota_')), 4);
  assert.equal(count(triggers, object => object.rules.includes('exemption')), 108);
  assert.equal(count(triggers, object => object.original?.includes('project_deletion_scope') === true && databaseOf(object.table) !== 'removed'), 108);
  assert.equal(count(triggers, object => object.name.startsWith('agent_quota_')), 20);

  // Cross-file foreign keys: 55 constraints over 65 columns, 7 nullable, 2 originally deferred.
  const columns = (filter: (row: Row, table: string) => boolean) => [...format72.tables].reduce((sum, [table, shape]) => sum + shape.foreignKeys.filter(row => filter(row, table)).length, 0);
  assert.equal(columns(() => true), 160);
  assert.deepEqual([relations.length, relations.reduce((sum, relation) => sum + relation.child.columns.length, 0)], [55, 65]);
  const inSchema = (schema: string) => relations.filter(relation => relation.child.schema === schema);
  assert.deepEqual([inSchema('main').length, inSchema('main').reduce((sum, relation) => sum + relation.child.columns.length, 0)], [52, 62]);
  assert.deepEqual([inSchema('cache').length, inSchema('cache').reduce((sum, relation) => sum + relation.child.columns.length, 0)], [3, 3]);
  assert.deepEqual(relations.flatMap(relation => relation.child.columns.filter((_, i) => relation.child.nullable[i]).map(column => `${relation.child.table}.${column}`)).sort(), [
    'agent_task_events_v2.projectId', 'agent_task_imports_v2.assetId', 'frame_tasks.assetId', 'image_tasks.versionId',
    'scene_requests.resultId', 'scene_tasks.resultId', 'subject_variant_items.versionId']);
  assert.deepEqual(relations.filter(relation => relation.originallyDeferred).map(relation => `${relation.child.table}->${relation.parent.table}`), ['image_tasks->image_versions', 'scene_tasks->scene_results']);
  assert.deepEqual(relations.map(relation => relation.index), Array.from({length: 55}, (_, i) => i + 1));
  assert.ok(relations.every(relation => databaseOf(relation.parent.table) === 'project'));
  assert.deepEqual([droppedContentKeys.length, droppedContentKeys.reduce((sum, key) => sum + key.child.columns.length, 0)], [5, 10]);
  assert.deepEqual(droppedContentKeys.filter(key => key.originallyDeferred).map(key => `${key.child.table}(${key.child.columns.join(',')})`), ['image_groups(activeTaskId,id,projectId)', 'scene_results(requestId)']);
  assert.equal(columns((row, table) => databaseOf(table) === 'app' && databaseOf(String(row.table)) === 'project'), 1);
  assert.equal(CROSS_FILE_RELATIONS.length, 55);
  assert.equal(DROPPED_CONTENT_KEYS.length, 5);
  assert.deepEqual(convertedTriggers.map(trigger => trigger.name), CONVERTED_TEMP_TRIGGERS.map(trigger => trigger.name));
  assert.ok(CONVERTED_TEMP_TRIGGERS.every(trigger => trigger.sql.startsWith(`CREATE TEMP TRIGGER ${trigger.name} `)));
});

test('each built database holds exactly its derived objects plus the kernel metadata', () => {
  const {objects} = derivation();
  const sequence = CONTENT_TABLES.flatMap(table => ['insert', 'update', 'delete'].map(operation => `project_file_sequence_${table}_${operation}`));
  const added: Record<DatabaseKind, {tables: string[]; triggers: string[]}> = {
    project: {tables: ['project_file', 'schema_version'], triggers: ['project_file_guard_delete', 'project_file_guard_identity', 'project_file_guard_insert',
      'project_file_guard_sequence', 'project_file_single_project_insert', 'project_file_single_project_update', ...sequence]},
    history: {tables: ['history_state', 'schema_version', 'sqlite_sequence'], triggers: ['history_state_guard_delete', 'history_state_guard_identity', 'history_state_guard_insert']},
    cache: {tables: ['schema_version', 'sqlite_sequence'], triggers: []},
  };
  assert.equal(sequence.length, 54);
  for (const kind of KINDS) {
    const db = buildAlone(kind);
    try {
      for (const type of ['table', 'index', 'trigger'] as const) {
        const expected = objects.filter(object => object.type === type && object.fate === kind).map(object => object.name);
        if (type !== 'index') expected.push(...added[kind][type === 'table' ? 'tables' : 'triggers']);
        assert.deepEqual(masterNames(db, type), expected.sort(), `${kind} ${type}s`);
      }
      assert.deepEqual(db.prepare('SELECT version FROM schema_version').all().map(row => row.version), [IDENTITY[kind].version]);
      assert.equal(db.prepare('PRAGMA application_id').get()?.application_id, IDENTITY[kind].applicationId);
    } finally {
      db.close();
    }
  }
  assert.deepEqual(KINDS.map(kind => SCHEMA_MANIFEST[kind].entries.length), [225, 319 + 5, 11]);
});

test('kept tables keep format-72 columns and indexes; only cross-file foreign keys are gone', () => {
  const {format72, relations, droppedContentKeys} = derivation();
  const removedKey = new Set([...relations.map(relation => `${relation.child.table}:${relation.child.columns.join(',')}->${relation.parent.table}`),
    ...droppedContentKeys.map(key => `${key.child.table}:${key.child.columns.join(',')}->${key.parent.table}`)]);
  const groups = (table: string, rows: readonly Row[]) => {
    const byId = new Map<number, Row[]>();
    for (const row of rows) byId.set(Number(row.id), [...byId.get(Number(row.id)) ?? [], row]);
    return [...byId].sort((a, b) => a[0] - b[0]).map(([, list]) => list.sort((a, b) => Number(a.seq) - Number(b.seq)))
      .map(list => ({key: `${table}:${list.map(row => row.from).join(',')}->${String(list[0]!.table)}`, rows: list.map(({id: _id, ...rest}) => rest)}));
  };
  let compared = 0;
  for (const kind of KINDS) {
    const db = buildAlone(kind);
    try {
      for (const table of kind === 'project' ? CONTENT_TABLES : kind === 'history' ? HISTORY_TABLES : CACHE_TABLES) {
        const before = format72.tables.get(table)!, after = readTableShape(db, table);
        assert.deepEqual(after.columns, before.columns, `${table} table_xinfo`);
        assert.deepEqual(after.indexes, before.indexes, `${table} index_list`);
        assert.deepEqual(after.indexColumns, before.indexColumns, `${table} index_xinfo`);
        assert.deepEqual(groups(table, after.foreignKeys), groups(table, before.foreignKeys).filter(group => !removedKey.has(group.key)), `${table} foreign_key_list`);
        compared++;
      }
    } finally {
      db.close();
    }
  }
  assert.equal(compared, 65 + 2);
});

/** True when removing the deletion exemption with exactly one connective
 * (`WHEN X`, `X AND` or `AND X`) from `original` gives `rewritten`. */
function removesOneExemption(original: string, rewritten: string): boolean {
  const term = String.raw`NOT EXISTS\(SELECT 1 FROM project_deletion_scope WHERE tableName='[^']*'(?: AND rowId=OLD\.rowid)?\)`;
  return [String.raw`\s+WHEN\s+${term}`, String.raw`${term}\s+AND\s+`, String.raw`\s+AND\s+${term}`].some(piece =>
    [...original.matchAll(new RegExp(piece, 'g'))].some(match => original.slice(0, match.index) + original.slice(match.index + match[0].length) === rewritten));
}
const undoTemp = (sql: string): string => sql.replace(/^CREATE TEMP TRIGGER /, 'CREATE TRIGGER ').replace(/\b(?:project|main|cache)\./g, '');

test('kept triggers equal format 72 or its documented rewrite; no removed, application or deletion-scope names remain', () => {
  const {objects} = derivation();
  for (const object of objects.filter(item => item.type === 'trigger' && item.sql !== null)) {
    const original = object.original!, rules = object.rules.join('+');
    const sql = object.rules.includes('temp') ? undoTemp(object.sql!) : object.sql!;
    if (object.rules.includes('temp')) assert.ok(object.sql!.startsWith(`CREATE TEMP TRIGGER ${object.name} `), object.name);
    if (rules === '' || rules === 'temp') assert.equal(sql, original, object.name);
    else if (rules === 'exemption' || rules === 'exemption+temp') assert.ok(removesOneExemption(original, sql), object.name);
    else if (rules === 'quota') {
      assert.equal(sql, POLICY_QUOTA_TERMS.reduce((text, term) => text.replace(term, ''), original), object.name);
      assert.match(sql, />20000 OR /);
      assert.match(sql, />268435456 THEN RAISE\(ABORT,'AGENT_TASK_STORAGE_LIMIT'\)/);
    } else assert.fail(`${object.name}: unexpected rules ${rules}`);
  }
  const forbidden = new RegExp(`project_deletion_|\\b(?:${[...APP_DATABASE_TABLES, ...REMOVED_TABLES].join('|')})\\b`);
  const ddl = [...KINDS.map(kind => schemaStatements(kind)), CONVERTED_TEMP_TRIGGERS.map(trigger => trigger.sql)];
  assert.deepEqual(ddl.map(statements => statements.filter(sql => forbidden.test(sql))), [[], [], [], []]);
  assert.deepEqual(ddl.map(statements => statements.length - new Set(statements).size), [0, 0, 0, 0]);
});

test('each database built alone compiles every insert, update and delete of every table', () => {
  let tables = 0;
  for (const kind of KINDS) {
    const db = buildAlone(kind);
    try {
      for (const name of masterNames(db, 'table').filter(table => !table.startsWith('sqlite_'))) {
        const columns = db.prepare('SELECT name FROM pragma_table_xinfo(?) WHERE hidden=0').all(name).map(row => quote(String(row.name)));
        for (const sql of [`EXPLAIN INSERT INTO ${quote(name)} DEFAULT VALUES`, `EXPLAIN UPDATE ${quote(name)} SET ${columns.map(column => `${column}=${column}`).join(',')}`, `EXPLAIN DELETE FROM ${quote(name)}`]) {
          assert.doesNotThrow(() => db.prepare(sql).all(), `${kind}: ${sql}`);
        }
        tables++;
      }
    } finally {
      db.close();
    }
  }
  assert.equal(tables, 20 + 49 + 3);
});

// Frozen per schema version: a DDL change that regenerates the manifest without
// raising the database's version fails here.
const MANIFEST_DIGESTS: Readonly<Record<DatabaseKind, Readonly<Record<number, string>>>> = {
  project: {1: '6e96c3872a938817b65e71750d1e68bd8fa84c7f3f8d92490de22a0e34d649ce'},
  // 2: the Mock provider's ledger in the task domain.
  history: {1: 'e0445f02d867f3aeedc283708f58d30efa7b0465e8987f7f739e8f5580791243', 2: '34ad833f0a676602490ce69b0f8804f79f1b30750b76a9f58d41abeb14dfd7a0'},
  cache: {1: 'be43585ad9045d7ed844c609b9af13829372efb83741b55f4f4f8e7b2f2fd61c'},
};
test('building as main or as an attached schema gives the committed manifest', () => {
  for (const kind of KINDS) {
    // At run time history.db is main and the other two are attached; build each kind both ways.
    const schema = kind, asMain = buildAlone(kind), attached = buildAlone(kind, schema);
    try {
      const main = readSchemaManifest(asMain, 'main'), other = readSchemaManifest(attached, schema);
      assert.deepEqual(other, main, kind);
      assert.deepEqual(main, SCHEMA_MANIFEST[kind].entries, kind);
      assert.deepEqual(compareManifest(main, SCHEMA_MANIFEST[kind].entries), {missing: [], unexpected: [], changed: []});
      assert.deepEqual(main, buildManifest(kind));
      assert.equal(SCHEMA_MANIFEST[kind].version, IDENTITY[kind].version);
      assert.equal(attached.prepare(`PRAGMA ${schema}.application_id`).get()?.application_id, IDENTITY[kind].applicationId);
      assert.deepEqual(attached.prepare(`SELECT version FROM ${schema}.schema_version`).all().map(row => row.version), [IDENTITY[kind].version]);
      assert.equal(readSchemaManifest(attached, 'main').length, 0);
      const digest = createHash('sha256').update(JSON.stringify(SCHEMA_MANIFEST[kind].entries)).digest('hex');
      assert.equal(digest, MANIFEST_DIGESTS[kind][SCHEMA_MANIFEST[kind].version], `${kind} schema changed: raise its version and record the new digest`);
    } finally {
      asMain.close();
      attached.close();
    }
  }
  const sample = SCHEMA_MANIFEST.cache.entries, first = `${sample[0]!.type}:${sample[0]!.name}`;
  const extra = {type: 'view', name: 'extra', tbl_name: 'extra', sha256: ''};
  assert.deepEqual(compareManifest([...sample.slice(1), extra], sample), {missing: [first], unexpected: ['view:extra'], changed: []});
  assert.deepEqual(compareManifest(sample.map((entry, i) => i === 0 ? {...entry, sha256: '0'.repeat(64)} : entry), sample), {missing: [], unexpected: [], changed: [first]});
  assert.deepEqual(compareManifest(sample.map((entry, i) => i === 0 ? {...entry, tbl_name: 'other'} : entry), sample), {missing: [], unexpected: [], changed: [first]});
});

test('buildDatabase requires a transaction and a plain schema name', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.throws(() => buildDatabase(db, 'cache', 'main'), /open transaction/);
    db.exec('BEGIN');
    assert.throws(() => buildDatabase(db, 'cache', 'main; DROP'), /Invalid schema name/);
    assert.throws(() => buildDatabase(db, 'cache', 'main', ['DROP TABLE x']), /cannot be qualified/);
    db.exec('ROLLBACK');
  } finally {
    db.close();
  }
});

test('stripCrossFileForeignKeys removes only foreign parents, at column and table level', () => {
  const plain = `CREATE TABLE child(
 id TEXT PRIMARY KEY,
 projectId TEXT NOT NULL REFERENCES projects(id) CHECK(length(projectId)=36),
 ownerId TEXT REFERENCES owners(id),
 versionId TEXT,
 UNIQUE(id,projectId),FOREIGN KEY(versionId,id) REFERENCES versions(id,taskId) DEFERRABLE INITIALLY DEFERRED,
 CHECK(versionId IS NULL OR versionId IN ('a,b','c)')))`;
  const foreign = (parent: string) => parent === 'projects' || parent === 'versions' || parent === 'jobs';
  const stripped = stripCrossFileForeignKeys(plain, foreign);
  assert.equal(stripped, `CREATE TABLE child(
 id TEXT PRIMARY KEY,
 projectId TEXT NOT NULL CHECK(length(projectId)=36),
 ownerId TEXT REFERENCES owners(id),
 versionId TEXT,
 UNIQUE(id,projectId),
 CHECK(versionId IS NULL OR versionId IN ('a,b','c)')))`);
  assert.deepEqual(foreignKeyClauses(plain).map(clause => [clause.form, clause.columns.join(','), clause.parent, clause.parentColumns.join(','), clause.deferred]), [
    ['column', 'projectId', 'projects', 'id', false], ['column', 'ownerId', 'owners', 'id', false], ['table', 'versionId,id', 'versions', 'id,taskId', true]]);
  const quoted = `CREATE TABLE "odd table"(
 "id, part" TEXT PRIMARY KEY, -- a comment, with REFERENCES projects(id)
 [bracket col] TEXT CONSTRAINT fk_project REFERENCES "projects"("id") ON DELETE CASCADE MATCH SIMPLE NOT DEFERRABLE NOT NULL,
 \`tick\` TEXT /* , REFERENCES jobs(id) */ REFERENCES local_parent(\`id\`) ON UPDATE SET NULL,
 CONSTRAINT fk_job FOREIGN KEY("id, part") REFERENCES jobs(id) DEFERRABLE INITIALLY IMMEDIATE
)`;
  const strippedQuoted = stripCrossFileForeignKeys(quoted, foreign);
  assert.equal(strippedQuoted, `CREATE TABLE "odd table"(
 "id, part" TEXT PRIMARY KEY, -- a comment, with REFERENCES projects(id)
 [bracket col] TEXT NOT NULL,
 \`tick\` TEXT /* , REFERENCES jobs(id) */ REFERENCES local_parent(\`id\`) ON UPDATE SET NULL
)`);
  assert.deepEqual(foreignKeyClauses(quoted).map(clause => [clause.parent, clause.columns.join(','), clause.deferred]), [['projects', 'bracket col', false], ['local_parent', 'tick', false], ['jobs', 'id, part', false]]);
  assert.equal(stripCrossFileForeignKeys(plain, () => false), plain);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(stripped);
    db.exec(strippedQuoted);
    assert.deepEqual(db.prepare('SELECT "table" AS parent FROM pragma_foreign_key_list(?)').all('child').map(row => row.parent), ['owners']);
    assert.deepEqual(db.prepare('SELECT "table" AS parent FROM pragma_foreign_key_list(?)').all('odd table').map(row => row.parent), ['local_parent']);
    assert.equal(db.prepare('SELECT "notnull" AS required FROM pragma_table_xinfo(?) WHERE name=?').get('odd table', 'bracket col')?.required, 1);
  } finally {
    db.close();
  }
});

test('stripDeletionExemption handles each format-72 shape exactly once', () => {
  const x = "NOT EXISTS(SELECT 1 FROM project_deletion_scope WHERE tableName='projects')";
  const row = "NOT EXISTS(SELECT 1 FROM project_deletion_scope WHERE tableName='s' AND rowId=OLD.rowid)";
  const body = 'BEGIN INSERT INTO r(a) VALUES(NEW.id);END';
  assert.equal(stripDeletionExemption(`CREATE TRIGGER a AFTER INSERT ON shots WHEN ${x} ${body}`), `CREATE TRIGGER a AFTER INSERT ON shots ${body}`);
  assert.equal(stripDeletionExemption(`CREATE TRIGGER b AFTER UPDATE ON shots WHEN ${x} AND (NEW."id" IS NOT OLD."id") ${body}`), `CREATE TRIGGER b AFTER UPDATE ON shots WHEN (NEW."id" IS NOT OLD."id") ${body}`);
  assert.equal(stripDeletionExemption(`CREATE TRIGGER c AFTER UPDATE ON t WHEN ${x} AND json_array(NEW.w) IS NOT json_array(OLD.w) ${body}`), `CREATE TRIGGER c AFTER UPDATE ON t WHEN json_array(NEW.w) IS NOT json_array(OLD.w) ${body}`);
  assert.equal(stripDeletionExemption(`CREATE TRIGGER d BEFORE DELETE ON s\n WHEN json_extract(OLD.data,'$.kind')='model' AND ${row}\n BEGIN SELECT RAISE(ABORT,'kept');END`),
    "CREATE TRIGGER d BEFORE DELETE ON s\n WHEN json_extract(OLD.data,'$.kind')='model'\n BEGIN SELECT RAISE(ABORT,'kept');END");
  assert.equal(stripDeletionExemption(`CREATE TRIGGER e BEFORE DELETE ON s\n WHEN ${row}\n AND NOT (OLD.op='x' AND (SELECT count(*) FROM s r)>=3)\n BEGIN SELECT RAISE(ABORT,'kept');END`),
    "CREATE TRIGGER e BEFORE DELETE ON s\n WHEN NOT (OLD.op='x' AND (SELECT count(*) FROM s r)>=3)\n BEGIN SELECT RAISE(ABORT,'kept');END");
  assert.throws(() => stripDeletionExemption(`CREATE TRIGGER f AFTER INSERT ON shots ${body}`), /exactly one deletion exemption, found 0/);
  assert.throws(() => stripDeletionExemption(`CREATE TRIGGER g AFTER INSERT ON shots WHEN ${x} AND ${x} ${body}`), /found 2/);
  assert.throws(() => stripDeletionExemption(`CREATE TRIGGER h AFTER INSERT ON shots WHEN NEW.a AND ${x} AND NEW.b ${body}`), /supported position/);
  assert.throws(() => stripDeletionExemption(`CREATE TRIGGER i AFTER INSERT ON shots WHEN ${x} ${body.replace('r(a)', 'project_deletion_receipts(a)')}`), /still referenced/);
});

test('rewriteMioQuota removes exactly the four policy-table terms', () => {
  const [countPolicy, countRequests, bytesPolicy, bytesRequests] = POLICY_QUOTA_TERMS as [string, string, string, string];
  const quota = (rows: string, bytes: string) => `CREATE TRIGGER q AFTER INSERT ON a BEGIN SELECT CASE WHEN (SELECT count(*) FROM a)${rows}>20000 OR (SELECT COALESCE(sum(length(CAST(data AS BLOB))),0) FROM a)${bytes}>268435456 THEN RAISE(ABORT,'AGENT_TASK_STORAGE_LIMIT') END;END`;
  assert.equal(rewriteMioQuota(quota(`${countPolicy}${countRequests}+(SELECT count(*) FROM b)`, `${bytesPolicy}${bytesRequests}`)), quota('+(SELECT count(*) FROM b)', ''));
  assert.throws(() => rewriteMioQuota(quota(countPolicy, `${bytesPolicy}${bytesRequests}`)), /exactly once, found 0/);
  assert.throws(() => rewriteMioQuota(quota(`${countPolicy}${countPolicy}${countRequests}`, `${bytesPolicy}${bytesRequests}`)), /exactly once, found 2/);
  assert.throws(() => rewriteMioQuota(quota(`${countPolicy}${countRequests}+(SELECT 1 FROM agent_task_policy_v2)`, `${bytesPolicy}${bytesRequests}`)), /still reads a policy table/);
});

test('toTempTrigger qualifies the trigger table and read tables but not write targets', () => {
  const schemas: Record<string, string> = {items: 'main', versions: 'project', batches: 'main', revisions: 'project'};
  const schemaOf = (table: string) => schemas[table];
  const sql = `CREATE TRIGGER t BEFORE UPDATE OF versionId ON items
 WHEN NEW.versionId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM versions v JOIN "batches" b ON b.id=NEW.batchId WHERE v.id=NEW.versionId AND v.note IS NOT 'FROM items')
 BEGIN INSERT INTO revisions(a) SELECT id FROM items WHERE items.id=NEW.id;UPDATE revisions SET a=1;DELETE FROM revisions WHERE a IN (SELECT value FROM json_each('[]'));SELECT RAISE(ABORT,'JOIN versions');END`;
  assert.equal(toTempTrigger(sql, schemaOf), `CREATE TEMP TRIGGER t BEFORE UPDATE OF versionId ON main.items
 WHEN NEW.versionId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM project.versions v JOIN main."batches" b ON b.id=NEW.batchId WHERE v.id=NEW.versionId AND v.note IS NOT 'FROM items')
 BEGIN INSERT INTO revisions(a) SELECT id FROM main.items WHERE items.id=NEW.id;UPDATE revisions SET a=1;DELETE FROM revisions WHERE a IN (SELECT value FROM json_each('[]'));SELECT RAISE(ABORT,'JOIN versions');END`);
  assert.throws(() => toTempTrigger('CREATE TRIGGER t AFTER INSERT ON items BEGIN SELECT 1 FROM versions, batches;END', schemaOf), /Unsupported reference to table batches/);
  assert.throws(() => toTempTrigger('CREATE TRIGGER t AFTER INSERT ON items BEGIN SELECT 1 FROM project.versions;END', schemaOf), /already qualified/);
  assert.throws(() => toTempTrigger('CREATE TEMP TRIGGER t AFTER INSERT ON items BEGIN SELECT 1;END', schemaOf), /CREATE TRIGGER statement/);
  assert.throws(() => toTempTrigger('CREATE TRIGGER t AFTER INSERT ON other BEGIN SELECT 1;END', schemaOf), /no schema/);
});
