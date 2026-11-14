import {testEnv} from './helpers/test-env.ts';
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {APP_LIBRARY_APPLICATION_ID, APP_LIBRARY_FILE, APP_LIBRARY_SCHEMA_VERSION, openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {appLibraryStatements, expectedAppSchema, readAppSchema} from '../packages/business/src/app-db/schema.ts';
import {BACKGROUND_TASK_INDEX_LIMITS} from '../packages/contracts/src/project-registry.ts';

const frozen = readFileSync(new URL('./fixtures/app-library-previous-schema/v3.sql', import.meta.url), 'utf8');
const at = '2026-11-04T00:00:00.000Z';
const digest = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
function inspect<T>(file: string, action: (db: DatabaseSync) => T): T {const db = new DatabaseSync(file); try {return action(db);} finally {db.close();}}
function seed(t: TestContext, version: 1 | 2 | 3 = 3) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-background-upgrade-')), dataDir = path.join(root, 'data');
  mkdirSync(dataDir, {mode: 0o700}); const file = path.join(dataDir, APP_LIBRARY_FILE);
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const projectId = randomUUID(), entry = {projectId, projectFile: path.join(root, 'Film.mioon'), kind: 'job', taskId: randomUUID(), indexedAt: at};
  const text = ' {"preserved":"规范\\r\\n🙂","revision":9} \n', index = JSON.stringify(entry, null, 2) + ' \n';
  inspect(file, db => {
    db.exec('BEGIN');
    if (version === 3) db.exec(frozen); else for (const sql of appLibraryStatements(version)) db.exec(sql);
    db.exec(`PRAGMA application_id=${APP_LIBRARY_APPLICATION_ID}`); db.prepare('INSERT INTO schema_version VALUES(?)').run(version);
    db.prepare('INSERT INTO app_documents VALUES(?,?)').run('ui-preferences-v1.json', text);
    db.prepare('INSERT INTO background_task_index(rowid,projectId,kind,taskId,data) VALUES(91,?,?,?,?)').run(projectId, entry.kind, entry.taskId, index);
    const project = {projectId, projectFile: entry.projectFile, fileIdentity: {dev: '1', ino: '2'}, name: 'Preserved', lastOpenedAt: null, summary: null};
    db.prepare('INSERT INTO recent_projects(position,projectId,data) VALUES(17,?,?)').run(projectId, JSON.stringify(project, null, 1));
    db.prepare('INSERT INTO app_operation_receipts VALUES(?,?,?,?,?)').run('project.create', 'kept-request', 'a'.repeat(64), ' {"retained":true} ', at);
    if (version === 3) db.prepare('INSERT INTO user_rules VALUES(1,?,7,?)').run('规范\r\n🙂', at);
    db.exec('COMMIT');
  });
  chmodSync(file, 0o600);
  return {root, dataDir, file, projectId, entry, text, index};
}
function retained(db: DatabaseSync): unknown {
  const tables = readAppSchema(db).filter(row => row.type === 'table' && !['schema_version', 'background_task_index'].includes(row.name));
  return tables.map(row => ({table: row.name, rows: db.prepare(`SELECT rowid,* FROM "${row.name}" ORDER BY rowid`).all()}));
}

test('real frozen v3 DDL has its retained independent digest and upgrades only the task index', t => {
  const f = seed(t), before = inspect(f.file, retained);
  assert.equal(createHash('sha256').update(JSON.stringify(inspect(f.file, readAppSchema))).digest('hex'), '8a037a9700be47380961f35fa2fae5c3880766f6d8349d80888e169708c9433c');
  assert.deepEqual(inspect(f.file, readAppSchema), expectedAppSchema(3));
  const library = openAppLibrary({dataDir: f.dataDir});
  try {
    assert.deepEqual(readAppSchema(library.db), expectedAppSchema());
    assert.equal(library.db.prepare('SELECT version FROM schema_version').get()!.version, APP_LIBRARY_SCHEMA_VERSION);
    assert.deepEqual(retained(library.db), before);
    const row = library.db.prepare('SELECT rowid,data,phase,reason,sourceHistory,revision,taskRevision FROM background_task_index').get()!;
    assert.deepEqual({...row}, {rowid: 91, data: f.index, phase: 'prepared', reason: 'INDEX_UNVERIFIED', sourceHistory: '', revision: 1, taskRevision: 0});
    assert.equal(library.documents.read('ui-preferences-v1.json'), f.text);
    const entry = library.taskIndex.listProject(f.projectId)[0]!;
    assert.deepEqual(entry, {...f.entry, phase: 'prepared', reason: 'INDEX_UNVERIFIED', sourceHistory: null, revision: 1, taskRevision: 0});
    const changes = library.db.prepare('SELECT total_changes() n').get()!.n;
    library.taskIndex.upsert(entry);
    assert.equal(library.db.prepare('SELECT total_changes() n').get()!.n, changes);
    assert.equal(library.db.prepare('SELECT data FROM background_task_index').get()!.data, f.index);
  } finally {library.close();}
});

for (const version of [1, 2] as const) test(`the production opener refuses application ${version} without composing historical upgrades`, t => {
  const f = seed(t, version), before = digest(f.file), schema = inspect(f.file, readAppSchema);
  assert.throws(() => openAppLibrary({dataDir: f.dataDir}), {code: 'APP_LIBRARY_INVALID'});
  assert.equal(digest(f.file), before);
  assert.deepEqual(inspect(f.file, readAppSchema), schema);
  assert.equal(inspect(f.file, db => db.prepare('SELECT version FROM schema_version').get()!.version), version);
});

for (const damage of ['extra', 'missing', 'changed', 'future', 'zero', 'wrong-application', 'mislabeled-current', 'invalid-row', 'duplicate-key'] as const)
  test(`a ${damage} v3 profile is refused before any source mutation`, t => {
    const f = seed(t);
    inspect(f.file, db => {
      if (damage === 'extra') db.exec('CREATE TABLE future_background_evidence(value)');
      else if (damage === 'missing') db.exec('DROP TABLE user_rules');
      else if (damage === 'changed') db.exec('DROP TRIGGER immutable_app_operation_receipts;CREATE TRIGGER immutable_app_operation_receipts BEFORE UPDATE ON app_operation_receipts BEGIN SELECT 1;END');
      else if (damage === 'wrong-application') db.exec('PRAGMA application_id=1');
      else if (damage === 'invalid-row') db.prepare('UPDATE background_task_index SET kind=?,data=?').run('future_task', JSON.stringify({...f.entry, kind: 'future_task'}));
      else if (damage === 'duplicate-key') db.prepare('UPDATE background_task_index SET data=?').run(JSON.stringify(f.entry).replace('"indexedAt":', '"indexedAt":"2026-10-01T00:00:00.000Z","indexedAt":'));
      else db.prepare('UPDATE schema_version SET version=?').run(damage === 'future' ? APP_LIBRARY_SCHEMA_VERSION + 1 : damage === 'zero' ? 0 : APP_LIBRARY_SCHEMA_VERSION);
    });
    const before = digest(f.file), rows = inspect(f.file, retained), schema = inspect(f.file, readAppSchema);
    assert.throws(() => openAppLibrary({dataDir: f.dataDir}), {code: damage === 'future' ? 'APP_LIBRARY_FORMAT_NEWER' : 'APP_LIBRARY_INVALID'});
    assert.equal(digest(f.file), before); assert.deepEqual(inspect(f.file, retained), rows); assert.deepEqual(inspect(f.file, readAppSchema), schema);
  });

for (const scope of ['project', 'application'] as const) test(`legacy task rows over the ${scope} limit are retained and refused`, t => {
  const f = seed(t);
  inspect(f.file, db => {
    db.exec('BEGIN');
    const insert = db.prepare('INSERT INTO background_task_index(projectId,kind,taskId,data) VALUES(?,?,?,?)');
    const count = scope === 'project' ? BACKGROUND_TASK_INDEX_LIMITS.project : BACKGROUND_TASK_INDEX_LIMITS.application;
    for (let index = 0; index < count; index++) {
      const entry = {...f.entry, projectId: scope === 'project' ? f.projectId : randomUUID(), taskId: randomUUID()};
      insert.run(entry.projectId, entry.kind, entry.taskId, JSON.stringify(entry));
    }
    db.exec('COMMIT');
  });
  const before = digest(f.file);
  assert.throws(() => openAppLibrary({dataDir: f.dataDir}), {code: 'APP_LIBRARY_INVALID'});
  assert.equal(digest(f.file), before);
  assert.deepEqual(inspect(f.file, readAppSchema), expectedAppSchema(3));
});

const points = ['after-rename', 'after-create', 'after-copy', 'after-drop', 'after-version', 'before-commit', 'after-commit'] as const;
function isPoint(sql: string, point: typeof points[number]): boolean {
  return point === 'after-rename' ? sql.startsWith('ALTER TABLE background_task_index RENAME')
    : point === 'after-create' ? sql.startsWith('CREATE TABLE background_task_index(')
      : point === 'after-copy' ? sql.startsWith('INSERT INTO background_task_index(rowid,')
        : point === 'after-drop' ? sql === 'DROP TABLE background_task_index_v3'
          : point === 'after-version' ? sql === 'UPDATE schema_version SET version=4 WHERE version=3' : sql === 'COMMIT';
}
for (const point of points) test(`application v3→4 failure ${point} leaves a whole old or committed current profile`, t => {
  const f = seed(t), before = inspect(f.file, retained), exec = DatabaseSync.prototype.exec;
  let upgrading = false, hit = false;
  const mock = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string): void {
    if (sql.startsWith('ALTER TABLE background_task_index RENAME')) upgrading = true;
    if (upgrading && point === 'before-commit' && sql === 'COMMIT') {hit = true; throw Error('upgrade injected');}
    exec.call(this, sql);
    if (upgrading && point !== 'before-commit' && isPoint(sql, point)) {hit = true; throw Error('upgrade injected');}
  });
  assert.throws(() => openAppLibrary({dataDir: f.dataDir}), {code: 'APP_LIBRARY_INVALID'}); mock.mock.restore(); assert.equal(hit, true);
  inspect(f.file, db => {
    assert.equal(db.prepare('SELECT version FROM schema_version').get()!.version, point === 'after-commit' ? APP_LIBRARY_SCHEMA_VERSION : 3);
    assert.deepEqual(readAppSchema(db), expectedAppSchema(point === 'after-commit' ? APP_LIBRARY_SCHEMA_VERSION : 3));
    assert.deepEqual(retained(db), before); assert.equal(db.prepare('SELECT data FROM background_task_index').get()!.data, f.index);
  });
  const next = openAppLibrary({dataDir: f.dataDir}); try {assert.deepEqual(readAppSchema(next.db), expectedAppSchema());} finally {next.close();}
});

for (const point of ['after-copy', 'after-version', 'before-commit', 'after-commit'] as const)
  test(`application v3→4 SIGKILL ${point} preserves source records and recovers exactly`, t => {
    const f = seed(t), before = inspect(f.file, retained), module = new URL('../packages/business/src/app-db/schema.ts', import.meta.url).href;
    const script = `import{DatabaseSync}from'node:sqlite';import{upgradeAppLibraryV3}from ${JSON.stringify(module)};const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA cache_size=1;PRAGMA cache_spill=ON');const exec=db.exec.bind(db);db.exec=sql=>{if(process.argv[2]==='before-commit'&&sql==='COMMIT')process.kill(process.pid,'SIGKILL');exec(sql);if(process.argv[2]==='after-copy'&&sql.startsWith('INSERT INTO background_task_index(rowid,')||process.argv[2]==='after-version'&&sql==='UPDATE schema_version SET version=4 WHERE version=3'||process.argv[2]==='after-commit'&&sql==='COMMIT')process.kill(process.pid,'SIGKILL');};upgradeAppLibraryV3(db);throw Error('missed barrier');`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.file, point], {env: testEnv(), stdio: 'ignore', timeout: 30_000});
    assert.equal(result.signal, 'SIGKILL');
    inspect(f.file, db => {
      assert.equal(db.prepare('SELECT version FROM schema_version').get()!.version, point === 'after-commit' ? APP_LIBRARY_SCHEMA_VERSION : 3);
      assert.deepEqual(readAppSchema(db), expectedAppSchema(point === 'after-commit' ? APP_LIBRARY_SCHEMA_VERSION : 3));
      assert.deepEqual(retained(db), before); assert.equal(db.prepare('SELECT data FROM background_task_index').get()!.data, f.index);
    });
    const next = openAppLibrary({dataDir: f.dataDir}); try {assert.equal(next.documents.read('ui-preferences-v1.json'), f.text);} finally {next.close();}
  });
