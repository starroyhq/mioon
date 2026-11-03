import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {buildManifest, declaredSchema, readTableShape, renderDerivedFiles, staleDerivedFiles, validateDeclaredSchema} from './helpers/project-file-schema-derivation.ts';
import type {SchemaDeclarations} from './helpers/project-file-schema-derivation.ts';
import {buildDatabase, schemaStatements, PROJECT_FILE_APPLICATION_ID, PROJECT_FILE_SCHEMA_VERSION, HISTORY_APPLICATION_ID, HISTORY_SCHEMA_VERSION, CACHE_APPLICATION_ID, CACHE_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import type {DatabaseKind} from '../packages/business/src/project-file/schema/databases.ts';
import {readSchemaManifest, compareManifest} from '../packages/business/src/project-file/schema/manifest-check.ts';
import {SCHEMA_MANIFEST} from '../packages/business/src/project-file/schema/manifest.ts';
import {CONTENT_TABLES, HISTORY_TABLES, HISTORY_TABLES_BY_DOMAIN, CACHE_TABLES, APP_DATABASE_TABLES, REMOVED_TABLES, LEGACY_MIO_TABLES, databaseOf} from '../packages/business/src/project-file/schema/tables.ts';
import {CROSS_FILE_RELATIONS, DROPPED_CONTENT_KEYS} from '../packages/business/src/project-file/cross-file/relations.ts';
import {CONVERTED_TEMP_TRIGGERS} from '../packages/business/src/project-file/cross-file/converted-triggers.ts';
import {installCrossFileTriggers} from '../packages/business/src/project-file/cross-file/install.ts';

const KINDS = ['project', 'history', 'cache'] as const;
const MANIFEST_FILE = 'packages/business/src/project-file/schema/manifest.ts';
const IDENTITY = {
  project: {version: PROJECT_FILE_SCHEMA_VERSION, applicationId: PROJECT_FILE_APPLICATION_ID},
  history: {version: HISTORY_SCHEMA_VERSION, applicationId: HISTORY_APPLICATION_ID},
  cache: {version: CACHE_SCHEMA_VERSION, applicationId: CACHE_APPLICATION_ID},
};
const quote = (name: string): string => '"' + name.replaceAll('"', '""') + '"';
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const sorted = (values: readonly string[]): string[] => [...values].sort();
function buildAlone(kind: DatabaseKind, schema = 'main', statements = schemaStatements(kind)): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  if (schema !== 'main') db.exec(`ATTACH DATABASE ':memory:' AS ${quote(schema)}`);
  db.exec('BEGIN'); buildDatabase(db, kind, schema, statements); db.exec('COMMIT');
  return db;
}
function names(db: DatabaseSync, type: string): string[] {
  return db.prepare('SELECT name FROM sqlite_master WHERE type=? ORDER BY name').all(type).map(row => String(row.name));
}
function changedStatements(kind: DatabaseKind, change: (sql: string) => string): readonly string[] {
  return schemaStatements(kind).map(change);
}
function cloneStatements(kind: DatabaseKind, statements: readonly string[]): SchemaDeclarations {
  const input = declaredSchema(); return {...input, statements: {...input.statements, [kind]: statements}};
}

// Independently reviewed current relationship obligations, not a generator
// output. --write cannot update these expectations or renumber constraints.
const CURRENT_RELATION_CONTRACT: readonly string[] = [
  "15 main.asset_annotation_requests(projectId!)->project.projects(id)",
  "16 main.asset_disposition_requests(projectId!)->project.projects(id)",
  "17 main.asset_range_requests(projectId!)->project.projects(id)",
  "18 main.edit_tasks(projectId!)->project.projects(id)",
  "19 main.exports(projectId!)->project.projects(id)",
  "20 main.frame_requests(projectId!)->project.projects(id)",
  "21 main.frame_tasks(assetId?)->project.assets(id)",
  "22 main.frame_tasks(projectId!)->project.projects(id)",
  "23 main.image_remote_observations(projectId!)->project.projects(id)",
  "24 main.image_remote_runs(projectId!)->project.projects(id)",
  "25 main.image_requests(projectId!)->project.projects(id)",
  "26 main.image_reviews(projectId!)->project.projects(id)",
  "27 main.image_tasks(versionId?,id!,groupId!,projectId!)->project.image_versions(id,taskId,groupId,projectId) deferred",
  "28 main.image_tasks(groupId!,projectId!)->project.image_groups(id,projectId)",
  "29 main.image_tasks(projectId!)->project.projects(id)",
  "30 main.jobs(projectId!)->project.projects(id)",
  "31 main.lut_import_requests(resourceId!,projectId!)->project.project_lut_resources(id,projectId)",
  "32 main.lut_import_requests(projectId!)->project.projects(id)",
  "33 main.mutation_requests(projectId!)->project.projects(id)",
  "34 main.previs_requests(nodeId!)->project.nodes(id)",
  "35 main.previs_requests(projectId!)->project.projects(id)",
  "36 cache.previs_thumbnails(projectId!)->project.projects(id)",
  "37 cache.previs_thumbnails(nodeId!)->project.nodes(id)",
  "38 main.project_mutation_requests(projectId!)->project.projects(id)",
  "39 main.scene_requests(resultId?,projectId!)->project.scene_results(id,projectId)",
  "40 main.scene_requests(projectId!)->project.projects(id)",
  "41 main.scene_tasks(resultId?,projectId!)->project.scene_results(id,projectId) deferred",
  "42 main.scene_tasks(sourceAssetId!)->project.assets(id)",
  "43 main.scene_tasks(projectId!)->project.projects(id)",
  "44 main.subject_requests(projectId!)->project.projects(id)",
  "45 main.subject_variant_batches(sourceVersionId!,subjectId!,projectId!)->project.subject_versions(id,subjectId,projectId)",
  "46 main.subject_variant_batches(subjectId!,projectId!)->project.subjects(id,projectId)",
  "47 main.subject_variant_batches(projectId!)->project.projects(id)",
  "48 main.subject_variant_items(versionId?)->project.subject_versions(id)",
  "49 main.subject_variant_requests(projectId!)->project.projects(id)",
  "50 main.task_disposition_requests(projectId!)->project.projects(id)",
  "51 main.task_dispositions(projectId!)->project.projects(id)",
  "52 main.timeline_format_requests(projectId!)->project.projects(id)",
  "53 main.timeline_history(projectId!)->project.projects(id)",
  "54 main.timeline_history_cursors(projectId!)->project.projects(id)",
  "55 cache.waveform_cache(projectId!)->project.projects(id)",
  "56 main.mio_conversations(projectId!)->project.projects(id)",
  "57 main.mio_runs(projectId!)->project.projects(id)",
  "58 main.mio_entries(projectId!)->project.projects(id)",
  "59 main.mio_steps(projectId!)->project.projects(id)",
  "60 main.mio_changes(projectId!)->project.projects(id)",
  "61 main.mio_controls(projectId!)->project.projects(id)",
  "62 main.mio_control_states(projectId!)->project.projects(id)",
  "63 main.mio_imports(projectId!)->project.projects(id)",
  "64 main.mio_job_origins(projectId!)->project.projects(id)",
  "65 main.mio_edit_claims(projectId!)->project.projects(id)",
  "66 main.mio_edit_owners(projectId!)->project.projects(id)",
  "67 main.mio_edit_receipts(projectId!)->project.projects(id)",
  "68 main.mio_conversation_policies(projectId!)->project.projects(id)",
  "69 main.mio_conversation_policy_requests(projectId!)->project.projects(id)",
  "70 main.mio_process_target_revisions(projectId!)->project.projects(id)",
  "71 main.mio_rule_writes(projectId!)->project.projects(id)",
  "72 main.project_versions(projectId!)->project.projects(id)",
  "73 main.project_version_requests(projectId!)->project.projects(id)",
  "74 main.project_version_capture_marks(projectId!)->project.projects(id)",
  "75 main.mio_imports(assetId?)->project.assets(id)"
];
const relationKey = (relation: (typeof CROSS_FILE_RELATIONS)[number]): string => `${relation.index} ${relation.child.schema}.${relation.child.table}(${relation.child.columns.map((column,i)=>column+(relation.child.nullable[i]?'?':'!')).join(',')})->${relation.parent.schema}.${relation.parent.table}(${relation.parent.columns.join(',')})${relation.originallyDeferred?' deferred':''}`;

test('the current manifest is generated from canonical declarations without rewriting its sources', () => {
  const inputs = [
    ...['content', 'receipts', 'tasks', 'timeline-history', 'cache', 'mio', 'versions'].map(name => `../packages/business/src/project-file/schema/domains/${name}.ts`),
    '../packages/business/src/project-file/cross-file/relations.ts', '../packages/business/src/project-file/cross-file/converted-triggers.ts',
  ].map(file => new URL(file, import.meta.url));
  const before = inputs.map(file => readFileSync(file, 'utf8'));
  const files = renderDerivedFiles();
  assert.deepEqual([...files.keys()], [MANIFEST_FILE]);
  assert.deepEqual(staleDerivedFiles(files), []);
  assert.deepEqual(inputs.map(file => readFileSync(file, 'utf8')), before);
  assert.match(files.get(MANIFEST_FILE)!, /Generated by .*project-file-schema-derivation/);
  assert.equal(files.get(MANIFEST_FILE), readFileSync(new URL('../' + MANIFEST_FILE, import.meta.url), 'utf8'));
  assert.deepEqual(KINDS.map(kind => buildManifest(kind)), KINDS.map(kind => SCHEMA_MANIFEST[kind].entries));
});

test('schema generation in a fresh process cannot import legacy constructors, openers or its output manifest', () => {
  const helper = new URL('./helpers/project-file-schema-derivation.ts', import.meta.url).href;
  const probe = new URL('../packages/business/src/db.ts?schema-isolation-probe', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {registerHooks} from 'node:module';
    import {sep} from 'node:path';
    import {fileURLToPath} from 'node:url';
    let blocked = 0;
    registerHooks({resolve(specifier, context, next) {
      const result = next(specifier, context);
      if (result.url.startsWith('file:')) {
        const file = fileURLToPath(result.url).split(sep).join('/');
        if (/\\/(?:workspace-[^/]*|db)\\.ts$/.test(file) || /\\/(?:legacy-workspace-store|historical-workspace)\\.ts$/.test(file) || /\\/project-file\\/(?:store|connection)\\.ts$/.test(file) || /\\/providers\\/mock\\.ts$/.test(file) || /\\/schema\\/manifest\\.ts$/.test(file)) {
          blocked++; throw Object.assign(Error('Forbidden schema dependency'), {code:'SCHEMA_SOURCE_FORBIDDEN'});
        }
      }
      return result;
    }});
    try { await import(${JSON.stringify(probe)}); throw Error('probe was not blocked'); }
    catch (error) { if(error.code!=='SCHEMA_SOURCE_FORBIDDEN') throw error; }
    const source = await import(${JSON.stringify(helper)});
    const files = source.renderDerivedFiles();
    console.log(JSON.stringify({blocked, files:[...files], roles:Object.keys(source.declaredSchema().tables), manifests:['project','history','cache'].map(kind=>source.buildManifest(kind))}));
  `], {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr);
  assert.doesNotMatch(child.stderr, /Forbidden schema dependency/);
  const result = JSON.parse(child.stdout) as {blocked: number; files: [string, string][]; roles: string[]; manifests: unknown[]};
  assert.equal(result.blocked, 1);
  assert.deepEqual(result.files, [...renderDerivedFiles()]);
  assert.deepEqual(result.roles, [...KINDS]);
  assert.deepEqual(result.manifests, KINDS.map(kind => SCHEMA_MANIFEST[kind].entries));
  assert.deepEqual(result.files.map(([file]) => file), [MANIFEST_FILE]);
});

test('table placement lists every current domain once and keeps compatibility names separate', () => {
  const all = [...CONTENT_TABLES, ...HISTORY_TABLES, ...CACHE_TABLES, ...APP_DATABASE_TABLES, ...REMOVED_TABLES];
  assert.equal(new Set(all).size, all.length);
  assert.equal(CONTENT_TABLES.length, 18);
  assert.equal(HISTORY_TABLES.length, 58);
  assert.equal(CACHE_TABLES.length, 2);
  assert.equal(APP_DATABASE_TABLES.length, 3);
  assert.equal(REMOVED_TABLES.length, 10);
  assert.deepEqual(HISTORY_TABLES, Object.values(HISTORY_TABLES_BY_DOMAIN).flat());
  assert.deepEqual(HISTORY_TABLES_BY_DOMAIN.receipts.length, 17);
  assert.deepEqual(HISTORY_TABLES_BY_DOMAIN.tasks.length, 15);
  assert.deepEqual(HISTORY_TABLES_BY_DOMAIN.timelineHistory.length, 2);
  assert.equal(HISTORY_TABLES_BY_DOMAIN.mio.length, 20);
  assert.equal(HISTORY_TABLES_BY_DOMAIN.versions.length, 4);
  assert.equal(HISTORY_TABLES_BY_DOMAIN.mio.includes('mio_process_target_revisions'), true);
  assert.equal(HISTORY_TABLES_BY_DOMAIN.mio.includes('mio_storage_counters'), true);
  assert.equal(HISTORY_TABLES.includes('mock_provider_tasks'), true);
  for (const table of CONTENT_TABLES) assert.equal(databaseOf(table), 'project', table);
  for (const table of HISTORY_TABLES) assert.equal(databaseOf(table), 'history', table);
  for (const table of CACHE_TABLES) assert.equal(databaseOf(table), 'cache', table);
  for (const table of APP_DATABASE_TABLES) assert.equal(databaseOf(table), 'app', table);
  assert.throws(() => databaseOf('schema_version'), /Unknown project-file table/);
  for (const table of LEGACY_MIO_TABLES) assert.equal(databaseOf(table), 'history', table);
  assert.throws(() => databaseOf('no_such_table'), /Unknown project-file table/);
});

test('every native object belongs to its declared database and old workspace state is absent', () => {
  const input = declaredSchema();
  assert.doesNotThrow(() => validateDeclaredSchema(input));
  assert.deepEqual(input.tables.project, CONTENT_TABLES);
  assert.deepEqual(input.tables.history, HISTORY_TABLES);
  assert.deepEqual(input.tables.cache, CACHE_TABLES);
  const owners = new Map<string, string>();
  for (const kind of KINDS) {
    const db = buildAlone(kind);
    try {
      const metadata = kind === 'project' ? ['project_file', 'schema_version'] : kind === 'history' ? ['history_state', 'schema_version'] : ['schema_version'];
      const actual = names(db, 'table').filter(name => !name.startsWith('sqlite_'));
      assert.deepEqual(actual, sorted([...input.tables[kind], ...metadata]));
      assert.equal(new Set(names(db, 'index')).size, names(db, 'index').length);
      assert.equal(new Set(names(db, 'trigger')).size, names(db, 'trigger').length);
      assert.deepEqual(names(db, 'view'), []);
      for (const table of input.tables[kind]) {
        assert.equal(owners.has(table), false, table); owners.set(table, kind);
        assert.equal(databaseOf(table), kind, table);
      }
      for (const table of [...APP_DATABASE_TABLES, ...REMOVED_TABLES, ...LEGACY_MIO_TABLES]) assert.equal(actual.includes(table), false, table);
      const objects = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master').all();
      for (const object of objects.filter(row => row.type === 'trigger' || row.type === 'index')) assert.equal(names(db, 'table').includes(String(object.tbl_name)), true, String(object.name));
      assert.deepEqual(objects.filter(row => row.type === 'trigger' && String(row.sql).includes('project_deletion_')), []);
      assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check), ['ok']);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); }
  }
  assert.equal(owners.get('agent_task_target_revisions_v2'), 'project');
  assert.equal(owners.get('mio_process_target_revisions'), 'history');
  assert.equal(owners.get('mock_provider_tasks'), 'history');
  assert.equal(owners.get('mock_provider_submissions'), 'history');
});

test('the independent versions domain has four exact table shapes, indexes and native/cross-file ownership keys', () => {
  const expected = {
    project_version_blobs: {columns: ['hash','profile','codec','rawBytes','compressedBytes','payload'], primary: ['hash'], indexes: ['sqlite_autoindex_project_version_blobs_1']},
    project_versions: {columns: ['id','projectId','trigger','name','mioRunId','contentSequence','createdAt','blobHash','mioChangeRowid'], primary: ['id'], indexes: ['project_versions_page','project_versions_run','sqlite_autoindex_project_versions_1','sqlite_autoindex_project_versions_2']},
    project_version_requests: {columns: ['projectId','requestId','operation','inputDigest','response'], primary: ['projectId','requestId'], indexes: ['sqlite_autoindex_project_version_requests_1']},
    project_version_capture_marks: {columns: ['projectId','kind','key','createdAt'], primary: ['projectId','kind','key'], indexes: ['sqlite_autoindex_project_version_capture_marks_1']},
  };
  const db = buildAlone('history');
  try {
    assert.deepEqual([...HISTORY_TABLES_BY_DOMAIN.versions], Object.keys(expected));
    assert.equal(readSchemaManifest(db, 'main').length, 524);
    for (const [table, shape] of Object.entries(expected)) {
      const actual = readTableShape(db, table);
      assert.deepEqual(actual.columns.map(column => column.name), shape.columns, `${table}: all columns independently listed`);
      assert.deepEqual(actual.columns.filter(column => Number(column.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map(column => column.name), shape.primary, `${table}: exact primary key`);
      assert.deepEqual(actual.indexes.map(index => String(index.name)).sort(), [...shape.indexes].sort(), `${table}: complete index set`);
      assert.equal(databaseOf(table), 'history');
      assert.ok(actual.indexes.every(index => Array.isArray(actual.indexColumns[String(index.name)])), `${table}: every index has readable column metadata`);
    }
    assert.deepEqual(readTableShape(db, 'project_versions').foreignKeys.map(row => `${String(row.from)}->${String(row.table)}.${String(row.to)}`).sort(),
      ['blobHash->project_version_blobs.hash', 'mioRunId->mio_runs.id', 'projectId->mio_runs.projectId']);
    for (const table of ['project_version_blobs','project_version_requests','project_version_capture_marks']) assert.deepEqual(readTableShape(db, table).foreignKeys, []);
    assert.deepEqual(CROSS_FILE_RELATIONS.filter(relation => Object.hasOwn(expected, relation.child.table)).map(relation => ({
      table: relation.child.table, childSchema: relation.child.schema, columns: relation.child.columns, nullable: relation.child.nullable,
      parent: relation.parent.table, parentColumns: relation.parent.columns,
    })), ['project_versions','project_version_requests','project_version_capture_marks'].map(table => ({table, childSchema: 'main', columns: ['projectId'], nullable: [false], parent: 'projects', parentColumns: ['id']})));
  } finally {db.close();}
});

test('kernel metadata and immutable guards preserve project identity and monotonic sequences', () => {
  const db = buildAlone('project');
  const id = '00000000-0000-4000-8000-000000000001';
  try {
    db.prepare('INSERT INTO project_file VALUES(1,?,7)').run(id);
    assert.equal(db.prepare('SELECT projectId FROM project_file').get()?.projectId, id);
    assert.throws(() => db.exec('DELETE FROM project_file'), /PROJECT_FILE_METADATA_REQUIRED/);
    assert.throws(() => db.prepare('UPDATE project_file SET projectId=?').run('00000000-0000-4000-8000-000000000002'), /PROJECT_FILE_IDENTITY_IMMUTABLE/);
    assert.throws(() => db.exec('UPDATE project_file SET contentSequence=6'), /PROJECT_FILE_SEQUENCE_DECREASED/);
    assert.throws(() => db.prepare('INSERT OR REPLACE INTO project_file VALUES(1,?,9)').run(id), /PROJECT_FILE_METADATA_EXISTS/);
    assert.equal(db.prepare('SELECT contentSequence FROM project_file').get()?.contentSequence, 7);
    assert.throws(() => db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run('00000000-0000-4000-8000-000000000002', '{}'), /PROJECT_FILE_SINGLE_PROJECT/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM projects').get()?.n, 0);
    db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run(id, '{}');
    assert.equal(db.prepare('SELECT contentSequence FROM project_file').get()?.contentSequence, 9);
    assert.equal(db.prepare('SELECT count(*) AS n FROM projects').get()?.n, 1);
  } finally { db.close(); }
  const history = buildAlone('history');
  try {
    history.prepare('INSERT INTO history_state VALUES(1,?,7)').run(id);
    assert.throws(() => history.exec('DELETE FROM history_state'), /HISTORY_STATE_REQUIRED/);
    assert.throws(() => history.prepare('UPDATE history_state SET projectId=?').run('00000000-0000-4000-8000-000000000002'), /HISTORY_STATE_IDENTITY_IMMUTABLE/);
    assert.throws(() => history.prepare('INSERT OR REPLACE INTO history_state VALUES(1,?,9)').run(id), /HISTORY_STATE_EXISTS/);
    assert.deepEqual(plain(history.prepare('SELECT * FROM history_state').get()), {singleton:1,projectId:id,seenContentSequence:7});
  } finally { history.close(); }
});

test('native columns and ordered unique keys independently validate declared cross-file relations', () => {
  const input = declaredSchema(), relation = input.relations.find(value => value.child.table === 'image_tasks' && value.parent.table === 'image_versions')!;
  assert.equal(input.relations.length, 61);
  assert.deepEqual(input.relations.map(relationKey), CURRENT_RELATION_CONTRACT);
  assert.ok(relation);
  assert.deepEqual(relation.child.columns, ['versionId', 'id', 'groupId', 'projectId']);
  assert.deepEqual(relation.parent.columns, ['id', 'taskId', 'groupId', 'projectId']);
  assert.deepEqual(relation.child.nullable, [true,false,false,false]);
  assert.equal(relation.originallyDeferred, true);
  assert.equal(DROPPED_CONTENT_KEYS.length, 5);
  assert.deepEqual(DROPPED_CONTENT_KEYS.filter(key => key.originallyDeferred).map(key => key.child.table), ['image_groups','scene_results']);
  const replace = (patch: Partial<typeof relation>) => ({...input, relations:input.relations.map(value => value === relation ? {...relation,...patch} : value)});
  assert.throws(() => validateDeclaredSchema(replace({index: input.relations[0]!.index})), /duplicate relation index/);
  assert.throws(() => validateDeclaredSchema(replace({child:{...relation.child,columns:['missing',...relation.child.columns.slice(1)]}})), /no child column missing/);
  assert.throws(() => validateDeclaredSchema(replace({child:{...relation.child,nullable:[false,false,false,false]}})), /incorrect nullability for versionId/);
  assert.throws(() => validateDeclaredSchema(replace({parent:{...relation.parent,columns:['missing',...relation.parent.columns.slice(1)]}})), /missing parent column/);
  assert.throws(() => validateDeclaredSchema(replace({parent:{...relation.parent,columns:['id','groupId','taskId','projectId']}})), /no ordered unique parent key/);
  assert.throws(() => validateDeclaredSchema({...input, relations: input.relations.filter(value => value.child.table !== 'jobs')}), /Missing project relation for main.jobs/);
  assert.throws(() => validateDeclaredSchema({...input, relations: [...input.relations, {...relation,index:1000}]}), /Duplicate cross-file relation/);
});

test('persistent and TEMP triggers contain no retired app, deletion-scope or legacy Mio dependencies', () => {
  const retired = [...APP_DATABASE_TABLES,...REMOVED_TABLES,...LEGACY_MIO_TABLES];
  const forbidden = new RegExp(`project_deletion_|\\b(?:${retired.join('|')})\\b`);
  const ddl = [...KINDS.map(kind => schemaStatements(kind)), CONVERTED_TEMP_TRIGGERS.map(trigger => trigger.sql)];
  assert.deepEqual(ddl.map(statements => statements.filter(sql => forbidden.test(sql))), [[],[],[],[]]);
  assert.deepEqual(ddl.map(statements => statements.length-new Set(statements).size), [0,0,0,0]);
  assert.equal(CONVERTED_TEMP_TRIGGERS.length, 14);
  assert.equal(CONVERTED_TEMP_TRIGGERS.some(trigger => /^agent_target_(jobs|exports|image_tasks|frame_tasks)_/.test(trigger.name)), false);
  assert.equal(HISTORY_TABLES.includes('agent_task_target_revisions_v2'), false);
  assert.equal(CONTENT_TABLES.includes('mio_process_target_revisions'), false);
  assert.equal(CONTENT_TABLES.includes('agent_task_target_revisions_v2'), true);
  assert.equal(HISTORY_TABLES.includes('mio_process_target_revisions'), true);
  const histories = schemaStatements('history').join('\n');
  assert.doesNotMatch(histories, /CREATE TRIGGER agent_quota_/);
  assert.match(histories, /CREATE TABLE mio_storage_counters/);
  assert.match(histories, /AGENT_TASK_STORAGE_LIMIT/);
});

test('each database built alone compiles every insert, update and delete of every table', () => {
  let tables = 0;
  for (const kind of KINDS) {
    const db = buildAlone(kind);
    try {
      for (const name of names(db,'table').filter(table => !table.startsWith('sqlite_'))) {
        const columns = db.prepare('SELECT name FROM pragma_table_xinfo(?) WHERE hidden=0').all(name).map(row => quote(String(row.name)));
        for (const sql of [`EXPLAIN INSERT INTO ${quote(name)} DEFAULT VALUES`,`EXPLAIN UPDATE ${quote(name)} SET ${columns.map(column => `${column}=${column}`).join(',')}`,`EXPLAIN DELETE FROM ${quote(name)}`]) assert.doesNotThrow(() => db.prepare(sql).all(), `${kind}: ${sql}`);
        tables++;
      }
    } finally { db.close(); }
  }
  assert.equal(tables, 83);
  assert.equal(tables, CONTENT_TABLES.length+HISTORY_TABLES.length+CACHE_TABLES.length+5);
});

const MANIFEST_DIGESTS: Readonly<Record<DatabaseKind, Readonly<Record<number, string>>>> = {
  project: {1: '6e96c3872a938817b65e71750d1e68bd8fa84c7f3f8d92490de22a0e34d649ce', 2: 'f86a2d31c85aa42896bd7d93e8ececa66c039942a0e32d36cb22b7483ea9929f'},
  // 2: the Mock provider's ledger in the task domain.
  history: {1: 'e0445f02d867f3aeedc283708f58d30efa7b0465e8987f7f739e8f5580791243', 2: '34ad833f0a676602490ce69b0f8804f79f1b30750b76a9f58d41abeb14dfd7a0', 3: 'b9487064fb0fa4447f3eb3896121d648184007a2b675927222beea3518c91a3a', 4: '047b9b4d7c2aa2376f2a97c2d4b042b326d730b5ad79504e77d3f8df1ca8dc82', 5: '6d2615d8d96d70d8d5926d387f1709e13d74dacf9d77414592750ec3ee3848de', 6: '7c150a8de4736982f109c04f71d1965385fa9629bc1bd4f48ebeda141d48eeb9',7:'540f80d50bcd564e584cf1bf526ca7019d083f095932ba7d19c8b18c2356a1ca'},
  cache: {1: 'be43585ad9045d7ed844c609b9af13829372efb83741b55f4f4f8e7b2f2fd61c', 2: '21b8f4c33fcb2c2b20d87c8bfd8a51d15bb6fdef8a7ae081aba462a900048fa3'},
};

test('building as main or attached schema gives the independent versioned manifest', () => {
  for (const kind of KINDS) {
    const schema = kind, asMain = buildAlone(kind), attached = buildAlone(kind,schema);
    try {
      const main = readSchemaManifest(asMain,'main'), other=readSchemaManifest(attached,schema);
      assert.deepEqual(other,main,kind);
      assert.deepEqual(main,SCHEMA_MANIFEST[kind].entries,kind);
      assert.deepEqual(compareManifest(main,SCHEMA_MANIFEST[kind].entries),{missing:[],unexpected:[],changed:[]});
      assert.deepEqual(main,buildManifest(kind));
      assert.equal(SCHEMA_MANIFEST[kind].version,IDENTITY[kind].version);
      assert.equal(attached.prepare(`PRAGMA ${schema}.application_id`).get()?.application_id,IDENTITY[kind].applicationId);
      assert.deepEqual(attached.prepare(`SELECT version FROM ${schema}.schema_version`).all().map(row=>row.version),[IDENTITY[kind].version]);
      assert.equal(readSchemaManifest(attached,'main').length,0);
      const digest=createHash('sha256').update(JSON.stringify(SCHEMA_MANIFEST[kind].entries)).digest('hex');
      assert.equal(digest,MANIFEST_DIGESTS[kind][SCHEMA_MANIFEST[kind].version],`${kind} changed without a version bump`);
    } finally {asMain.close();attached.close();}
  }
  const sample=SCHEMA_MANIFEST.cache.entries,first=`${sample[0]!.type}:${sample[0]!.name}`,extra={type:'view',name:'extra',tbl_name:'extra',sha256:''};
  assert.deepEqual(compareManifest([...sample.slice(1),extra],sample),{missing:[first],unexpected:['view:extra'],changed:[]});
  assert.deepEqual(compareManifest(sample.map((entry,i)=>i===0?{...entry,sha256:'0'.repeat(64)}:entry),sample),{missing:[],unexpected:[],changed:[first]});
  assert.deepEqual(compareManifest(sample.map((entry,i)=>i===0?{...entry,tbl_name:'other'}:entry),sample),{missing:[],unexpected:[],changed:[first]});
});

test('buildDatabase requires a synchronous transaction and a plain schema name', () => {
  const db=new DatabaseSync(':memory:');
  try {
    assert.throws(()=>buildDatabase(db,'cache','main'),/open transaction/);
    db.exec('BEGIN');
    assert.throws(()=>buildDatabase(db,'cache','main; DROP'),/Invalid schema name/);
    assert.throws(()=>buildDatabase(db,'cache','main',['DROP TABLE x']),/cannot be qualified/);
    db.exec('ROLLBACK');
    assert.equal(db.isTransaction,false);
    assert.deepEqual(db.prepare('SELECT name FROM sqlite_master').all(),[]);
  } finally {db.close();}
});

test('relation declarations reject wrong owners, keys and ambiguous numbering before installation', () => {
  const input=declaredSchema(),relation=input.relations[0]!;
  const change=(patch:Partial<typeof relation>)=>({...input,relations:[{...relation,...patch},...input.relations.slice(1)]});
  assert.throws(()=>validateDeclaredSchema(change({index:0})),/Invalid or duplicate relation index/);
  assert.throws(()=>validateDeclaredSchema(change({index:1.5})),/Invalid or duplicate relation index/);
  assert.throws(()=>validateDeclaredSchema(change({child:{...relation.child,schema:'cache'}})),/invalid database owner/);
  assert.throws(()=>validateDeclaredSchema(change({parent:{...relation.parent,table:'jobs'}})),/invalid database owner/);
  assert.throws(()=>validateDeclaredSchema(change({child:{...relation.child,columns:[]}})),/mismatched key columns/);
  assert.throws(()=>validateDeclaredSchema(change({child:{...relation.child,nullable:[]}})),/mismatched key columns/);
  assert.throws(()=>validateDeclaredSchema({...input,tables:{...input.tables,history:[...input.tables.history,'bogus']}}),/Declared history tables do not match/);
  assert.throws(()=>validateDeclaredSchema({...input,tables:{...input.tables,project:[...input.tables.project,input.tables.project[0]!]}}),/Duplicate project table/);
  assert.throws(()=>validateDeclaredSchema({...input,tables:{...input.tables,cache:[]}}),/Declared cache tables do not match/);
  assert.doesNotThrow(()=>validateDeclaredSchema(input));
  assert.equal(new Set(CROSS_FILE_RELATIONS.map(value=>value.index)).size,CROSS_FILE_RELATIONS.length);
});

test('column, explicit-index and same-file-FK drift change the independent stored manifest', () => {
  const column=changedStatements('project',sql=>sql.startsWith('CREATE TABLE project_file(')?sql.replace('projectId TEXT','projectId BLOB'):sql);
  const columnDifference=compareManifest(buildManifest('project',column),SCHEMA_MANIFEST.project.entries);
  assert.deepEqual(columnDifference.changed,['table:project_file']);
  assert.deepEqual(columnDifference.missing,[]);
  assert.deepEqual(columnDifference.unexpected,[]);
  const index='mock_provider_submissions_request';
  const withoutIndex=schemaStatements('history').filter(sql=>!sql.startsWith(`CREATE INDEX ${index} `));
  assert.equal(withoutIndex.length,schemaStatements('history').length-1);
  const indexDifference=compareManifest(buildManifest('history',withoutIndex),SCHEMA_MANIFEST.history.entries);
  assert.deepEqual(indexDifference.missing,[`index:${index}`]);
  assert.deepEqual(indexDifference.changed,[]);
  const fk=changedStatements('history',sql=>sql.startsWith('CREATE TABLE timeline_format_requests(')?sql.replace(/ REFERENCES timeline_requests\(requestId\)/,''):sql);
  assert.notDeepEqual(fk,schemaStatements('history'));
  const fkDifference=compareManifest(buildManifest('history',fk),SCHEMA_MANIFEST.history.entries);
  assert.deepEqual(fkDifference.changed,['table:timeline_format_requests']);
  assert.deepEqual(fkDifference.missing,[]);
  assert.deepEqual(fkDifference.unexpected,[]);
  assert.notDeepEqual(renderDerivedFiles(cloneStatements('project',column)),renderDerivedFiles());
  assert.deepEqual(staleDerivedFiles(renderDerivedFiles(cloneStatements('project',column))),[MANIFEST_FILE]);
});

test('persistent metadata and Mio quota guards cannot drift behind an unchanged version', () => {
  const original=schemaStatements('project');
  const changed=changedStatements('project',sql=>sql.startsWith('CREATE TRIGGER project_file_guard_sequence ')?sql.replace('NEW.contentSequence<OLD.contentSequence','0'):sql);
  assert.notDeepEqual(changed,original);
  const diff=compareManifest(buildManifest('project',changed),SCHEMA_MANIFEST.project.entries);
  assert.deepEqual(diff.changed,['trigger:project_file_guard_sequence']);
  assert.deepEqual(diff.missing,[]);
  assert.deepEqual(diff.unexpected,[]);
  const db=buildAlone('project','main',changed);
  try {
    db.prepare('INSERT INTO project_file VALUES(1,?,7)').run('00000000-0000-4000-8000-000000000001');
    assert.doesNotThrow(()=>db.exec('UPDATE project_file SET contentSequence=6'));
    assert.equal(db.prepare('SELECT contentSequence FROM project_file').get()?.contentSequence,6);
    assert.throws(()=>db.exec('DELETE FROM project_file'),/PROJECT_FILE_METADATA_REQUIRED/);
  } finally {db.close();}
  const history=buildAlone('history');
  try {
    const quota=history.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'quota_%' ORDER BY name").all();
    assert.ok(quota.length>0);
    assert.equal(quota.some(row=>String(row.sql).includes('AGENT_TASK_STORAGE_LIMIT')),true);
    assert.equal(quota.every(row=>String(row.sql).includes('mio_storage_counters')),true);
    assert.equal(history.prepare('SELECT rows FROM mio_storage_counters').get()?.rows,1);
    assert.equal(history.prepare('SELECT bytes FROM mio_storage_counters').get()?.bytes,0);
    assert.equal(names(history,'table').includes('agent_chat_quota'),false);
    assert.equal(names(history,'table').includes('agent_task_policy_v2'),false);
    assert.equal(names(history,'trigger').some(name=>name.startsWith('agent_quota_')),false);
  } finally {history.close();}
});

test('TEMP guards are compiled in their declared schemas and cannot silently disappear or change scope', () => {
  const input=declaredSchema(),guard=input.tempTriggers[0]!;
  assert.equal(guard.schema,'project');
  assert.equal(guard.table,'versions');
  assert.match(guard.sql,/^CREATE TEMP TRIGGER reject_legacy_frame_asset_owner /);
  assert.throws(()=>validateDeclaredSchema({...input,tempTriggers:input.tempTriggers.slice(1)}),/Missing TEMP trigger reject_legacy_frame_asset_owner/);
  assert.throws(()=>validateDeclaredSchema({...input,tempTriggers:[guard,...input.tempTriggers]}),/Duplicate TEMP trigger/);
  assert.throws(()=>validateDeclaredSchema({...input,tempTriggers:[{...guard,name:'wrong'},...input.tempTriggers.slice(1)]}),/Unexpected TEMP trigger/);
  assert.throws(()=>validateDeclaredSchema({...input,tempTriggers:[{...guard,schema:'main'},...input.tempTriggers.slice(1)]}),/mismatched target schema/);
  assert.throws(()=>validateDeclaredSchema({...input,tempTriggers:[{...guard,table:'jobs'},...input.tempTriggers.slice(1)]}),/mismatched target table/);
  assert.throws(()=>validateDeclaredSchema({...input,tempTriggers:[{...guard,sql:guard.sql.replace('CREATE TEMP TRIGGER','CREATE TRIGGER')},...input.tempTriggers.slice(1)]}),/CREATE TEMP TRIGGER/);
  assert.throws(()=>validateDeclaredSchema({...input,tempTriggers:[{...guard,sql:guard.sql.replace(/ON project\.versions/,'ON cache.versions')},...input.tempTriggers.slice(1)]}),/mismatched target schema/);
  for (const trigger of input.tempTriggers) {
    const noop = trigger.sql.slice(0, trigger.sql.indexOf(' BEGIN ')) + ' BEGIN SELECT 1;END';
    assert.throws(()=>validateDeclaredSchema({...input,tempTriggers:input.tempTriggers.map(value=>value===trigger?{...value,sql:noop}:value)}),
      {message:`TEMP trigger ${trigger.name} accepted forbidden write`});
    assert.deepEqual(renderDerivedFiles(),renderDerivedFiles(input),'probe mutations must not mutate source declarations');
  }
  assert.doesNotThrow(()=>validateDeclaredSchema(input));
  const db=new DatabaseSync(':memory:');
  try {
    db.exec("ATTACH DATABASE ':memory:' AS project");
    assert.throws(()=>installCrossFileTriggers(db),/cache database attached/);
    assert.deepEqual(db.prepare('SELECT name FROM temp.sqlite_master').all(),[]);
  } finally {db.close();}
});
