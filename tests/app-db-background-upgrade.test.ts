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

const frozen = {
  3: readFileSync(new URL('./fixtures/app-library-previous-schema/v3.sql', import.meta.url), 'utf8'),
  4: readFileSync(new URL('./fixtures/app-library-previous-schema/v4.sql', import.meta.url), 'utf8'),
};
const at = '2026-11-04T00:00:00.000Z';
const digest = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
function inspect<T>(file: string, action: (db: DatabaseSync) => T): T {const db = new DatabaseSync(file); try {return action(db);} finally {db.close();}}
function seed(t: TestContext, version: 1 | 2 | 3 | 4 = 3) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-background-upgrade-')), dataDir = path.join(root, 'data');
  mkdirSync(dataDir, {mode: 0o700}); const file = path.join(dataDir, APP_LIBRARY_FILE);
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const projectId = randomUUID(), entry = {projectId, projectFile: path.join(root, 'Film.mioon'), kind: 'job' as const, taskId: randomUUID(), indexedAt: at};
  const archived = {sourceHistory: 'e'.repeat(64), phase: 'archived' as const, reason: 'PROJECT_HISTORY_DIVERGED', revision: 7, taskRevision: 3};
  const text = ' {"preserved":"规范\\r\\n🙂","revision":9} \n', index = JSON.stringify(version === 4 ? {...entry, ...archived} : entry, null, 2) + ' \n';
  inspect(file, db => {
    db.exec('BEGIN');
    if (version === 3 || version === 4) db.exec(frozen[version]); else for (const sql of appLibraryStatements(version)) db.exec(sql);
    db.exec(`PRAGMA application_id=${APP_LIBRARY_APPLICATION_ID}`); db.prepare('INSERT INTO schema_version VALUES(?)').run(version);
    db.prepare('INSERT INTO app_documents VALUES(?,?)').run('ui-preferences-v1.json', text);
    if (version === 4) db.prepare('INSERT INTO background_task_index(rowid,projectId,kind,taskId,sourceHistory,phase,reason,revision,taskRevision,data) VALUES(91,?,?,?,?,?,?,?,?,?)')
      .run(projectId, entry.kind, entry.taskId, archived.sourceHistory, archived.phase, archived.reason, archived.revision, archived.taskRevision, index);
    else db.prepare('INSERT INTO background_task_index(rowid,projectId,kind,taskId,data) VALUES(91,?,?,?,?)').run(projectId, entry.kind, entry.taskId, index);
    const project = {projectId, projectFile: entry.projectFile, fileIdentity: {dev: '1', ino: '2'}, name: 'Preserved', lastOpenedAt: null, summary: null};
    db.prepare('INSERT INTO recent_projects(position,projectId,data) VALUES(17,?,?)').run(projectId, JSON.stringify(project, null, 1));
    db.prepare('INSERT INTO app_operation_receipts VALUES(?,?,?,?,?)').run('project.create', 'kept-request', 'a'.repeat(64), ' {"retained":true} ', at);
    if (version === 3 || version === 4) db.prepare('INSERT INTO user_rules VALUES(1,?,7,?)').run('规范\r\n🙂', at);
    db.exec('COMMIT');
  });
  chmodSync(file, 0o600);
  return {root, dataDir, file, projectId, entry, text, index, archived};
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

test('frozen v4 preserves archived index and accepts the independent timeline processing kind after upgrade', t => {
  const f = seed(t, 4), before = inspect(f.file, retained);
  assert.equal(createHash('sha256').update(JSON.stringify(inspect(f.file, readAppSchema))).digest('hex'), '2ed1111e2e87865ef3f400f2615393b52040e6679d60632a30afa9d60baa37eb');
  assert.deepEqual(inspect(f.file, readAppSchema), expectedAppSchema(4));
  const indexed = inspect(f.file, db => db.prepare('SELECT rowid,* FROM background_task_index').all());
  const library = openAppLibrary({dataDir: f.dataDir});
  try {
    assert.deepEqual(readAppSchema(library.db), expectedAppSchema());
    assert.equal(library.db.prepare('SELECT version FROM schema_version').get()!.version, APP_LIBRARY_SCHEMA_VERSION);
    assert.deepEqual(retained(library.db), before);
    assert.deepEqual(library.db.prepare('SELECT rowid,* FROM background_task_index').all(), indexed);
    assert.deepEqual(library.taskIndex.listProject(f.projectId), [{...f.entry, ...f.archived}]);
    const processing = {...f.entry, kind: 'timeline-processing' as const, sourceHistory: f.archived.sourceHistory,
      phase: 'active' as const, reason: null, revision: 1, taskRevision: 1};
    library.taskIndex.upsert(processing);
    assert.deepEqual(library.taskIndex.listProject(f.projectId).find(task => task.kind === 'timeline-processing'), processing);
  } finally {library.close();}
});

test('an unknown v4 structure is refused without a migration write', t => {
  const f = seed(t, 4);
  inspect(f.file, db => db.exec('DROP INDEX background_task_index_project_phase'));
  const before = digest(f.file);
  assert.throws(() => openAppLibrary({dataDir: f.dataDir}), {code: 'APP_LIBRARY_INVALID'});
  assert.equal(digest(f.file), before);
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
function isPoint(sql: string, point: typeof points[number], version: 3 | 4): boolean {
  return point === 'after-rename' ? sql.startsWith('ALTER TABLE background_task_index RENAME')
    : point === 'after-create' ? sql.startsWith('CREATE TABLE background_task_index(')
      : point === 'after-copy' ? sql.startsWith('INSERT INTO background_task_index(rowid,')
        : point === 'after-drop' ? sql === `DROP TABLE background_task_index_v${version}`
          : point === 'after-version' ? sql === `UPDATE schema_version SET version=${version + 1} WHERE version=${version}` : sql === 'COMMIT';
}
for (const version of [3, 4] as const) for (const point of points) test(`application v${version}→${version + 1} failure ${point} leaves a whole old or upgraded profile`, t => {
  const f = seed(t, version), before = inspect(f.file, retained), exec = DatabaseSync.prototype.exec;
  let upgrading = false, hit = false;
  const mock = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string): void {
    if (sql.startsWith('ALTER TABLE background_task_index RENAME')) upgrading = true;
    if (upgrading && point === 'before-commit' && sql === 'COMMIT') {hit = true; throw Error('upgrade injected');}
    exec.call(this, sql);
    if (upgrading && point !== 'before-commit' && isPoint(sql, point, version)) {hit = true; throw Error('upgrade injected');}
  });
  assert.throws(() => openAppLibrary({dataDir: f.dataDir}), {code: 'APP_LIBRARY_INVALID'}); mock.mock.restore(); assert.equal(hit, true);
  inspect(f.file, db => {
    const retainedVersion = point === 'after-commit' ? version === 3 ? 4 : APP_LIBRARY_SCHEMA_VERSION : version;
    assert.equal(db.prepare('SELECT version FROM schema_version').get()!.version, retainedVersion);
    assert.deepEqual(readAppSchema(db), expectedAppSchema(retainedVersion));
    assert.deepEqual(retained(db), before); assert.equal(db.prepare('SELECT data FROM background_task_index').get()!.data, f.index);
  });
  const next = openAppLibrary({dataDir: f.dataDir}); try {assert.deepEqual(readAppSchema(next.db), expectedAppSchema());} finally {next.close();}
});

for (const version of [3, 4] as const) for (const point of ['after-copy', 'after-version', 'before-commit', 'after-commit'] as const)
  test(`application v${version}→${version + 1} SIGKILL ${point} preserves source records and recovers exactly`, t => {
    const f = seed(t, version), before = inspect(f.file, retained), module = new URL('../packages/business/src/app-db/schema.ts', import.meta.url).href;
    const script = `import {DatabaseSync} from 'node:sqlite';
      import {upgradeAppLibraryV${version}} from ${JSON.stringify(module)};
      const db = new DatabaseSync(process.argv[1]);
      const point = process.argv[2];
      db.exec('PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA cache_size=1;PRAGMA cache_spill=ON');
      const exec = db.exec.bind(db);
      db.exec = sql => {
        if (point === 'before-commit' && sql === 'COMMIT') process.kill(process.pid, 'SIGKILL');
        exec(sql);
        if (point === 'after-copy' && sql.startsWith('INSERT INTO background_task_index(rowid,')
          || point === 'after-version' && sql === 'UPDATE schema_version SET version=${version + 1} WHERE version=${version}'
          || point === 'after-commit' && sql === 'COMMIT') process.kill(process.pid, 'SIGKILL');
      };
      upgradeAppLibraryV${version}(db);
      throw Error('missed barrier');`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.file, point], {env: testEnv(), stdio: 'ignore', timeout: 30_000});
    assert.equal(result.signal, 'SIGKILL');
    inspect(f.file, db => {
      const retainedVersion = point === 'after-commit' ? version === 3 ? 4 : APP_LIBRARY_SCHEMA_VERSION : version;
      assert.equal(db.prepare('SELECT version FROM schema_version').get()!.version, retainedVersion);
      assert.deepEqual(readAppSchema(db), expectedAppSchema(retainedVersion));
      assert.deepEqual(retained(db), before); assert.equal(db.prepare('SELECT data FROM background_task_index').get()!.data, f.index);
    });
    const next = openAppLibrary({dataDir: f.dataDir}); try {assert.equal(next.documents.read('ui-preferences-v1.json'), f.text);} finally {next.close();}
  });
