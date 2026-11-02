import test from 'node:test';
import {rpcPathFor} from '../packages/contracts/src/project-addressing.ts';
import {workspaceSettingsSchema} from '../packages/contracts/src/workspace-configuration.ts';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chmodSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {startServer} from '../apps/server/src/index.ts';
import type {InspectProject, InspectApplication} from '../apps/server/src/index.ts';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createProjectServiceApplication, testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {isProjectId} from '../packages/contracts/src/project-file.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {findHeldAppProjectFile} from '../packages/business/src/app-db/connection.ts';
import {isProjectDatabase, isProjectFileHeld} from '../packages/business/src/project-file/index.ts';
import {ensureProjectRow} from '../apps/server/src/project-host/project-initialization.ts';
import {mutateProjectRecord} from '../packages/business/src/project-record-mutations.ts';
import {testStoreForConnection} from '../packages/business/src/project-file/test-store.ts';
import {createServerProject, foreignKeyCheck, openProjectDatabase, projectDatabasePath, projectDirFor, schemaObjects, withoutForeignKeys} from './helpers/project-database.ts';

const TOKEN = 'synthetic-project-database-token';
const PRAGMAS = ['trusted_schema', 'foreign_keys', 'journal_mode', 'synchronous', 'busy_timeout', 'locking_mode'];
const pragmas = (db: DatabaseSync): Record<string, unknown> =>
  Object.fromEntries(PRAGMAS.map(name => [name, Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0]]));
const projectName = (db: DatabaseSync, projectId: string): string =>
  (JSON.parse(String(db.prepare('SELECT data FROM projects WHERE id=?').get(projectId)?.data)) as {name: string}).name;
const foreignKeys = (db: DatabaseSync): unknown => db.prepare('PRAGMA foreign_keys').get()?.foreign_keys;
// A shot of a project this store does not hold, as a corrupt file would hold it.
const insertForeignShot = (db: DatabaseSync) => {
  const shot = {id: randomUUID(), projectId: randomUUID(), title: 'Damaged shot'};
  return db.prepare('INSERT INTO shots(id,projectId,data) VALUES(?,?,?)').run(shot.id, shot.projectId, JSON.stringify(shot)).changes;
};

function dataDirectory(t: TestContext): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mioon-project-database-')));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}

test('createServerProject leaves an open store of one new project in the server layout', t => {
  const dataDir = dataDirectory(t);
  const {projectId, store} = createServerProject(dataDir);
  try {
    assert.ok(isProjectId(projectId));
    assert.equal(store.projectId, projectId);
    assert.equal(store.projectDir, projectDirFor(dataDir, projectId));
    assert.equal(store.root, store.projectDir);
    assert.equal(store.projectFile, projectDatabasePath(store.projectDir));
    assert.equal(store.historyState, 'fresh');
    assert.equal(projectName(store.db, projectId), 'Test project');
    assert.ok(lstatSync(path.join(projectDirFor(dataDir, projectId), 'media')).isDirectory());
    assert.throws(() => openProjectDatabase(store.projectDir), {code: 'PROJECT_LOCKED', status: 409, details: {database: 'project', reason: 'locked'}});
  } finally {
    store.close();
  }
});

test('createServerProject uses a fixed seed ID and still generates an ID when explicitly omitted', t => {
  const dataDir = dataDirectory(t), fixedId = '00000000-0000-4000-8000-0000000000aa';
  const {projectId, store} = createServerProject(dataDir, {projectId: fixedId, name: 'Fixed wire seed'});
  try {
    assert.equal(projectId, fixedId);
    assert.equal(store.projectId, fixedId);
    assert.equal(projectName(store.db, fixedId), 'Fixed wire seed');
    assert.deepEqual(store.db.prepare('SELECT id FROM projects ORDER BY id').all().map(row => row.id), [fixedId]);
  } finally { store.close(); }
  const generated = createServerProject(dataDir, {projectId: undefined});
  try {
    assert.ok(isProjectId(generated.projectId));
    assert.notEqual(generated.projectId, fixedId);
    assert.equal(projectName(generated.store.db, generated.projectId), 'Test project');
  } finally { generated.store.close(); }
  const reopened = openProjectDatabase(projectDirFor(dataDir, fixedId));
  try { assert.equal(projectName(reopened, fixedId), 'Fixed wire seed'); }
  finally { reopened.close(); }
});

test('createServerProject rejects every explicit invalid ID without opening a store', t => {
  const dataDir = dataDirectory(t);
  const invalidIds: unknown[] = ['', 'synthetic-project', '../media', '00000000-0000-4000-8000-0000000000AA', null, 17, [], {}];
  for (const projectId of invalidIds) {
    assert.throws(() => createServerProject(dataDir, {projectId: projectId as string}), {name: 'TypeError', message: 'Invalid project ID'});
    assert.equal(lstatSync(path.join(dataDir, 'server.lock'), {throwIfNoEntry: false}), undefined);
    assert.equal(lstatSync(projectDatabasePath(dataDir), {throwIfNoEntry: false}), undefined);
  }
  const created = createServerProject(dataDir);
  try { assert.ok(isProjectId(created.projectId)); }
  finally { created.store.close(); }
});

test('createServerProject refuses an existing ID without changing its stored bytes or retaining its lock', t => {
  const dataDir = dataDirectory(t), fixedId = '00000000-0000-4000-8000-0000000000bb';
  const original = createServerProject(dataDir, {projectId: fixedId, name: 'Original fixed project'});
  let before: unknown;
  try { before = original.store.db.prepare('SELECT id,data FROM projects ORDER BY id').all().map(row => ({...row})); }
  finally { original.store.close(); }
  assert.throws(() => createServerProject(dataDir, {projectId: fixedId, name: 'Must never overwrite'}), {message: 'Project ID already exists'});
  assert.equal(lstatSync(path.join(dataDir, 'server.lock'), {throwIfNoEntry: false}), undefined);
  const reopened = openProjectDatabase(projectDirFor(dataDir, fixedId));
  try {
    assert.deepEqual(reopened.prepare('SELECT id,data FROM projects ORDER BY id').all().map(row => ({...row})), before);
    assert.equal(projectName(reopened, fixedId), 'Original fixed project');
  } finally { reopened.close(); }
});

test('createServerProject rejects a failing name getter before opening storage', t => {
  const dataDir = dataDirectory(t), projectId = '00000000-0000-4000-8000-0000000000cc';
  const failure = new Error('Synthetic fixture name failure');
  assert.throws(() => createServerProject(dataDir, {projectId, get name(): string { throw failure; }}), error => error === failure);
  assert.equal(lstatSync(path.join(dataDir, 'server.lock'), {throwIfNoEntry: false}), undefined);
  const created = createServerProject(dataDir, {projectId, name: 'Recovered fixed project'});
  try {
    assert.equal(created.projectId, projectId);
    assert.equal(projectName(created.store.db, projectId), 'Recovered fixed project');
    assert.deepEqual(created.store.db.prepare('SELECT id FROM projects ORDER BY id').all().map(row => row.id), [projectId]);
  } finally { created.store.close(); }
});

test('createServerProject closes its opened kernel and removes registration after an initialization fault', t => {
  const dataDir = dataDirectory(t), projectId = '00000000-0000-4000-8000-0000000000cd';
  const failure = new Error('Synthetic post-open initialization failure');
  const nativePrepare = DatabaseSync.prototype.prepare;
  let opened: DatabaseSync | undefined, projectFile: string | undefined;
  const identities: {dev: string; ino: string}[] = [];
  const seam = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (sql === 'SELECT id FROM project.projects LIMIT 2' && isProjectDatabase(this)) {
      assert.equal(isProjectDatabase(this), true, 'the initialization fault occurs after the real kernel opened');
      opened = this;
      const registered = findHeldAppProjectFile(dataDir, projectId);
      assert.ok(typeof registered === 'string');
      projectFile = registered;
      for (const row of nativePrepare.call(this, 'PRAGMA database_list').all()) {
        if (typeof row.file !== 'string' || row.file === '') continue;
        const info = lstatSync(row.file, {bigint: true});
        identities.push({dev: String(info.dev), ino: String(info.ino)});
      }
      throw failure;
    }
    return nativePrepare.call(this, sql);
  });
  try {
    assert.throws(() => createServerProject(dataDir, {projectId, name: 'Initialization fault'}), error => error === failure);
  } finally { seam.mock.restore(); }
  assert.ok(opened);
  assert.equal(opened.isOpen, false);
  assert.equal(identities.length, 3);
  assert.ok(identities.every(identity => !isProjectFileHeld(identity)), 'all kernel file owners are released');
  assert.ok(projectFile);
  assert.equal(lstatSync(path.dirname(projectFile), {throwIfNoEntry: false}), undefined);
  const library = openAppLibrary({dataDir});
  try { assert.equal(library.registry.get(projectId), null); }
  finally { library.close(); }
  const recovered = createServerProject(dataDir, {projectId, name: 'Recovered initialization'});
  try { assert.equal(projectName(recovered.store.db, projectId), 'Recovered initialization'); }
  finally { recovered.store.close(); }
});

test('openProjectDatabase opens a closed project with the store pragmas and structure', t => {
  const dataDir = dataDirectory(t);
  const {projectId, store} = createServerProject(dataDir);
  const expected = {pragmas: pragmas(store.db), structure: schemaObjects(store.db)};
  store.close();
  const db = openProjectDatabase(projectDirFor(dataDir, projectId));
  try {
    assert.deepEqual(pragmas(db), expected.pragmas);
    assert.equal(expected.pragmas.foreign_keys, 1);
    assert.equal(expected.pragmas.trusted_schema, 0);
    assert.deepEqual(schemaObjects(db), expected.structure);
    assert.equal(projectName(db, projectId), 'Test project');
  } finally {
    db.close();
  }
});

test('openProjectDatabase refuses a missing project database without creating one', t => {
  const root = dataDirectory(t);
  assert.throws(() => openProjectDatabase(root), {code: 'PROJECT_MISSING', status: 404, details: {database: 'project', reason: 'missing'}});
  assert.equal(lstatSync(projectDatabasePath(root), {throwIfNoEntry: false}), undefined);
});

test('test connection lookup accepts only its exact live owner and releases closed identities', t => {
  const root = dataDirectory(t), store = openStore(root), db = store.db;
  try {
    assert.equal(testStoreForConnection(db, root), store);
    assert.equal(testStoreForConnection(db, path.join(root, 'foreign')), null);
    assert.equal(testStoreForConnection({...db}, root), null);
  } finally { store.close(); }
  assert.equal(testStoreForConnection(db, root), null);
  const reopened = openStore(root);
  try {
    assert.equal(testStoreForConnection(reopened.db, root), reopened);
    store.close();
    assert.equal(testStoreForConnection(db, root), null);
    assert.equal(testStoreForConnection(reopened.db, root), reopened);
  } finally { reopened.close(); }
});

test('projectDirFor takes only lowercase UUID project IDs', () => {
  const projectId = randomUUID();
  for (const invalid of ['synthetic-project', projectId.toUpperCase(), '', '../media']) {
    assert.throws(() => projectDirFor(tmpdir(), invalid), TypeError, invalid);
  }
});

test('schemaObjects and foreignKeyCheck cover every database on the connection', t => {
  const store = openStore(dataDirectory(t));
  try {
    const {db} = store;
    assert.deepEqual(foreignKeyCheck(db), []);
    const content = db.prepare('SELECT type,name,tbl_name,sql FROM project.sqlite_master ORDER BY type,name').all()
      .map(row => ({schema: 'project', type: String(row.type), name: String(row.name), tbl_name: String(row.tbl_name), sql: typeof row.sql === 'string' ? row.sql : null}));
    assert.ok(content.some(object => object.type === 'table' && object.name === 'projects'));
    db.exec("ATTACH ':memory:' AS extra; CREATE TABLE extra.parent(id INTEGER PRIMARY KEY); CREATE TABLE extra.child(parentId INTEGER REFERENCES parent(id));");
    const orphan = randomUUID();
    withoutForeignKeys(db, () => {
      db.prepare('INSERT INTO shots(id,projectId,data) VALUES(?,?,?)').run(orphan, randomUUID(), JSON.stringify({id: orphan}));
      db.exec('INSERT INTO extra.child VALUES(7)');
    });
    const rowid = Number(db.prepare('SELECT rowid FROM shots WHERE id=?').get(orphan)?.rowid);
    const revisionRowid = Number(db.prepare("SELECT rowid FROM agent_task_target_revisions_v2 WHERE kind='shot' AND targetId=?").get(orphan)?.rowid);
    const orderViolation = (a: {schema: string; table: string}, b: {schema: string; table: string}) => a.schema.localeCompare(b.schema) || a.table.localeCompare(b.table);
    assert.deepEqual(foreignKeyCheck(db).sort(orderViolation), [
      {schema: 'project', table: 'shots', rowid, parent: 'projects', parentSchema: 'project', constraint: 'fk:0'},
      {schema: 'project', table: 'agent_task_target_revisions_v2', rowid: revisionRowid, parent: 'projects', parentSchema: 'project', constraint: 'fk:0'},
      {schema: 'extra', table: 'child', rowid: 1, parent: 'parent', parentSchema: 'extra', constraint: 'fk:0'},
    ].sort(orderViolation));
    const objects = schemaObjects(db);
    assert.deepEqual(objects.filter(object => object.schema === 'project'), content);
    assert.ok(objects.some(object => object.schema === 'main' && object.name === 'jobs'));
    assert.ok(objects.some(object => object.schema === 'cache' && object.name === 'waveform_cache'));
    assert.ok(objects.some(object => object.schema === 'temp' && object.name === 'project_file_seen_sequence'));
    assert.deepEqual(objects.filter(object => object.schema === 'extra').map(object => object.name), ['child', 'parent']);
  } finally {
    store.close();
  }
});

test('withoutForeignKeys writes a damaged row that foreign keys refuse outside it, also inside a transaction of its promised write', async t => {
  const {store} = createServerProject(dataDirectory(t));
  try {
    const {db} = store;
    assert.throws(() => insertForeignShot(db), /FOREIGN KEY constraint failed/);
    assert.deepEqual(foreignKeyCheck(db), []);
    assert.equal(withoutForeignKeys(db, () => { assert.equal(foreignKeys(db), 0); return insertForeignShot(db); }), 1);
    assert.equal(foreignKeys(db), 1);
    // A service call awaits before its own transaction does the damage.
    const pending = withoutForeignKeys(db, async () => { await Promise.resolve(); return store.tx(() => insertForeignShot(db)); });
    assert.equal(foreignKeys(db), 0, 'foreign keys stay off until the promise settles');
    assert.equal(await pending, 1);
    assert.equal(foreignKeys(db), 1);
    // Both shots are there; triggers may add rows of their own that point at the same missing project.
    const damaged = foreignKeyCheck(db);
    assert.deepEqual(damaged.filter(({table}) => table === 'shots').map(({parent}) => parent), ['projects', 'projects']);
    assert.ok(damaged.every(({parent}) => parent === 'projects'), JSON.stringify(damaged));
    assert.throws(() => insertForeignShot(db), /FOREIGN KEY constraint failed/);
  } finally {
    store.close();
  }
});

test('withoutForeignKeys restores the previous foreign_keys value after a throw and after an async rejection', async t => {
  const store = openStore(dataDirectory(t));
  try {
    const {db} = store;
    const before = schemaObjects(db);
    assert.throws(() => withoutForeignKeys(db, () => { assert.equal(foreignKeys(db), 0); throw new Error('synthetic write failure'); }), /^Error: synthetic write failure$/);
    assert.equal(foreignKeys(db), 1);
    assert.deepEqual(schemaObjects(db), before);
    const rejected = withoutForeignKeys(db, async () => { await Promise.resolve(); throw new Error('synthetic async failure'); });
    assert.equal(foreignKeys(db), 0);
    await assert.rejects(rejected, /^Error: synthetic async failure$/);
    assert.equal(foreignKeys(db), 1);
    assert.deepEqual(schemaObjects(db), before);
    db.exec('PRAGMA foreign_keys=OFF');
    assert.equal(withoutForeignKeys(db, () => 'unchanged'), 'unchanged');
    assert.equal(foreignKeys(db), 0, 'the previous value comes back, not always ON');
    db.exec('PRAGMA foreign_keys=ON');
  } finally {
    store.close();
  }
});

test('withoutForeignKeys refuses to start inside a transaction and reports a transaction its write leaves open', t => {
  const store = openStore(dataDirectory(t));
  try {
    const {db} = store;
    let called = false;
    db.exec('BEGIN');
    try {
      assert.throws(() => withoutForeignKeys(db, () => { called = true; }), {message: /must start outside a transaction/});
    } finally {
      db.exec('ROLLBACK');
    }
    assert.equal(called, false, 'the write never runs');
    assert.equal(foreignKeys(db), 1);
    // SQLite ignores the restoring pragma inside the open transaction: fail loudly instead.
    assert.throws(() => withoutForeignKeys(db, () => db.exec('BEGIN')), {message: /left a transaction open/});
    assert.equal(db.isTransaction, false);
    assert.equal(foreignKeys(db), 1);
  } finally {
    store.close();
  }
});

test('openProjectDatabase close releases all kernel owners, rejects native reopen and leaves a new owner intact', t => {
  const root = dataDirectory(t), store = openStore(root);
  const files = [store.projectFile, path.join(store.localDir, 'history.db'), path.join(store.cacheDir, 'cache.db')];
  store.close();
  const db = openProjectDatabase(root);
  const identities = files.map(file => {
    const info = lstatSync(file, {bigint: true});
    return {dev: String(info.dev), ino: String(info.ino)};
  });
  assert.equal(isProjectDatabase(db), true);
  assert.ok(identities.every(identity => isProjectFileHeld(identity)));
  db.close();
  assert.equal(isProjectDatabase(db), false);
  assert.ok(identities.every(identity => !isProjectFileHeld(identity)));
  assert.throws(() => db.open(), /Reopen project databases through/);
  const reopened = openProjectDatabase(root);
  try {
    db.close();
    assert.equal(isProjectDatabase(reopened), true);
    assert.ok(identities.every(identity => isProjectFileHeld(identity)));
    assert.throws(() => openProjectDatabase(root), {code: 'PROJECT_LOCKED'});
  } finally { reopened.close(); }
  assert.ok(identities.every(identity => !isProjectFileHeld(identity)));
});

test('projectDirFor borrows the real held app registry and follows its registered path without opening the project', t => {
  const dataDir = dataDirectory(t), created = createServerProject(dataDir, {name: 'Named layout'});
  const {projectId, store} = created, root = store.projectDir;
  store.close();
  assert.equal(findHeldAppProjectFile(dataDir, projectId), undefined);
  const library = openAppLibrary({dataDir});
  try {
    assert.equal(findHeldAppProjectFile(dataDir, projectId), store.projectFile);
    assert.equal(findHeldAppProjectFile(dataDir, randomUUID()), null);
    assert.equal(projectDirFor(dataDir, projectId), root);
    assert.throws(() => projectDirFor(dataDir, randomUUID()), {code: 'PROJECT_NOT_FOUND'});
    const db = openProjectDatabase(root);
    db.close();
    assert.equal(library.db.isOpen, true, 'lookup never closes the borrowed library');
  } finally { library.close(); }
  assert.equal(findHeldAppProjectFile(dataDir, projectId), undefined);
});

test('project row initialization proves the real store and never replaces existing content', t => {
  const store = openStore(dataDirectory(t));
  try {
    ensureProjectRow(store, {name: 'Original'});
    const before = store.get('projects', store.projectId);
    ensureProjectRow(store, {name: 'Must not overwrite'});
    assert.deepEqual(store.get('projects', store.projectId), before);
    assert.throws(() => ensureProjectRow({...store}, {name: 'Copied capability'}), /live kernel store/);
  } finally { store.close(); }
  assert.throws(() => ensureProjectRow(store, {name: 'Closed capability'}), /live kernel store/);
});

test('project initialization commits its description and preset atomically and rolls back either failure', t => {
  const store = openStore(dataDirectory(t)), now = () => new Date('2026-11-02T00:00:00.000Z');
  try {
    assert.throws(() => ensureProjectRow(store, {name: 'Invalid preset', description: 'Must roll back', timelinePresetId: 'invalid', now}), {code: 'VALIDATION_ERROR'});
    assert.deepEqual(store.list('projects'), []);
    assert.deepEqual(store.list('timelines'), []);
    store.db.exec("CREATE TEMP TRIGGER fixture_init_fail BEFORE INSERT ON project.timelines BEGIN SELECT RAISE(ABORT,'synthetic timeline initialization failure');END");
    assert.throws(() => ensureProjectRow(store, {name: 'Fault', timelinePresetId: 'square_1080', now}), /synthetic timeline initialization failure/);
    assert.deepEqual(store.list('projects'), []);
    assert.deepEqual(store.list('timelines'), []);
    store.db.exec('DROP TRIGGER temp.fixture_init_fail');
    ensureProjectRow(store, {name: 'Atomic project', description: 'Initial notes', timelinePresetId: 'square_1080', now});
    assert.deepEqual(store.get('projects', store.projectId), {id: store.projectId, name: 'Atomic project', description: 'Initial notes', revision: 1, createdAt: now().toISOString(), updatedAt: now().toISOString()});
    const timeline = store.list('timelines')[0] as {projectId: string; width: number; height: number; tracks: unknown[]};
    assert.equal(timeline.projectId, store.projectId);
    assert.equal(timeline.width, 1080);
    assert.equal(timeline.height, 1080);
    assert.equal(timeline.tracks.length, 3);
    assert.deepEqual(foreignKeyCheck(store.db), []);
  } finally { store.close(); }
});

test('kernel project record edits share the original revision and exact receipt contract without old lifecycle DDL', t => {
  const store = openStore(dataDirectory(t)), other = openStore(dataDirectory(t));
  try {
    ensureProjectRow(store, {name: 'Original'});
    ensureProjectRow(other, {name: 'Other'});
    const structure = schemaObjects(store.db), rename = {projectId: store.projectId, requestId: randomUUID(), expectedRevision: 1, name: 'Renamed'};
    const renamed = mutateProjectRecord(store, 'project.rename', rename);
    const notes = {projectId: store.projectId, requestId: randomUUID(), expectedRevision: 2, notes: 'Saved notes'};
    const saved = mutateProjectRecord(store, 'project.notes.set', notes);
    assert.equal(saved.revision, 3);
    assert.equal(saved.notes, notes.notes);
    assert.deepEqual(mutateProjectRecord(store, 'project.rename', rename), renamed);
    assert.deepEqual(mutateProjectRecord(store, 'project.notes.set', notes), saved);
    assert.throws(() => mutateProjectRecord(store, 'project.notes.set', {...notes, notes: 'Changed input'}), {code: 'IDEMPOTENCY_CONFLICT'});
    assert.throws(() => mutateProjectRecord(store, 'project.notes.set', {...notes, requestId: randomUUID()}), {code: 'REVISION_CONFLICT'});
    assert.throws(() => mutateProjectRecord(store, 'project.rename', {...rename, projectId: other.projectId}), {code: 'NOT_FOUND'});
    assert.equal(other.db.prepare('SELECT count(*) AS n FROM project_mutation_requests').get()?.n, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM project_mutation_requests').get()?.n, 2);
    store.db.exec("CREATE TEMP TRIGGER fixture_mutation_fail BEFORE INSERT ON main.project_mutation_requests BEGIN SELECT RAISE(ABORT,'synthetic project receipt failure');END");
    assert.throws(() => mutateProjectRecord(store, 'project.notes.set', {...notes, requestId: randomUUID(), expectedRevision: 3, notes: 'Must roll back'}), /synthetic project receipt failure/);
    assert.deepEqual(store.get('projects', store.projectId), saved);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM project_mutation_requests').get()?.n, 2);
    store.db.exec('DROP TRIGGER temp.fixture_mutation_fail');
    const cleared = mutateProjectRecord(store, 'project.notes.set', {...notes, requestId: randomUUID(), expectedRevision: 3, notes: ' \n\t'});
    assert.equal(cleared.revision, 4);
    assert.equal(Object.hasOwn(cleared, 'notes'), false);
    assert.deepEqual(schemaObjects(store.db), structure);
    assert.throws(() => mutateProjectRecord({...store}, 'project.rename', rename), /live kernel store/);
  } finally { store.close(); other.close(); }
});

test('withoutForeignKeys preserves fault, target revision and seen-sequence triggers and restores exact TEMP definitions', t => {
  const {store, projectId} = createServerProject(dataDirectory(t));
  try {
    const {db} = store, id = randomUUID();
    db.exec("CREATE TEMP TRIGGER fixture_shot_fault BEFORE UPDATE ON project.shots BEGIN SELECT RAISE(ABORT,'synthetic shot fault');END");
    const before = schemaObjects(db);
    withoutForeignKeys(db, () => {
      assert.equal(db.prepare("SELECT count(*) AS n FROM temp.sqlite_master WHERE name LIKE 'project_file_fk_%'").get()?.n, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM temp.sqlite_master WHERE name='fixture_shot_fault'").get()?.n, 1);
      db.prepare('INSERT INTO shots(id,projectId,data) VALUES(?,?,?)').run(id, projectId, JSON.stringify({id, projectId, title: 'Real shot'}));
      assert.equal(db.prepare("SELECT revision FROM agent_task_target_revisions_v2 WHERE projectId=? AND kind='shot' AND targetId=?").get(projectId, id)?.revision, 1);
      assert.equal(db.prepare('SELECT seenContentSequence AS n FROM history_state').get()?.n, db.prepare('SELECT contentSequence AS n FROM project.project_file').get()?.n);
      assert.throws(() => withoutForeignKeys(db, () => 1), /cannot overlap/);
    });
    assert.deepEqual(schemaObjects(db), before);
    assert.throws(() => db.prepare('UPDATE shots SET data=data WHERE id=?').run(id), /synthetic shot fault/);
    assert.throws(() => insertForeignShot(db), /FOREIGN KEY constraint failed/);
    const beforeLeakedTransaction = schemaObjects(db);
    assert.throws(() => withoutForeignKeys(db, () => db.exec('BEGIN')), /left a transaction open/);
    assert.equal(db.isTransaction, false);
    assert.equal(foreignKeys(db), 1);
    assert.deepEqual(schemaObjects(db), beforeLeakedTransaction);
  } finally { store.close(); }
});

test('withoutForeignKeys reports both write and restore failures without hiding a conflicting TEMP trigger', t => {
  const store = openStore(dataDirectory(t)), failure = new Error('Synthetic write failure');
  try {
    assert.throws(() => withoutForeignKeys(store.db, () => {
      store.db.exec('CREATE TEMP TRIGGER project_file_fk_01_child_insert BEFORE INSERT ON project.shots BEGIN SELECT 1;END');
      throw failure;
    }), error => error instanceof AggregateError && error.errors[0] === failure && /already exists/.test(String(error.errors[1])));
    assert.equal(foreignKeys(store.db), 1);
    assert.equal(store.db.isTransaction, false);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM temp.sqlite_master WHERE name='project_file_fk_01_child_insert'").get()?.n, 1);
    assert.throws(() => withoutForeignKeys(store.db, () => 1), /exact kernel relation triggers/);
  } finally { store.close(); }
});

test('withoutForeignKeys temporarily suspends only cross-file FK enforcement and foreignKeyCheck reports its orphan', t => {
  const store = openStore(dataDirectory(t));
  try {
    const {db} = store, projectId = randomUUID(), requestId = randomUUID();
    const insert = (): void => { db.prepare('INSERT INTO mutation_requests(requestId,operation,projectId,canonicalInput,response) VALUES(?,?,?,?,?)').run(requestId, 'shot.update', projectId, '{}', '{}'); };
    assert.throws(insert, /FOREIGN KEY constraint failed/);
    withoutForeignKeys(db, insert);
    const rowid = Number(db.prepare('SELECT rowid FROM mutation_requests WHERE requestId=?').get(requestId)?.rowid);
    assert.deepEqual(foreignKeyCheck(db), [{schema: 'main', table: 'mutation_requests', rowid, parent: 'projects', parentSchema: 'project', constraint: 'project_file_fk_33'}]);
    assert.throws(() => db.prepare('UPDATE mutation_requests SET projectId=? WHERE requestId=?').run(randomUUID(), requestId), /FOREIGN KEY constraint failed/);
  } finally { store.close(); }
});

test('foreignKeyCheck retains native checks for an explicit non-project memory connection', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=OFF;CREATE TABLE parent(id INTEGER PRIMARY KEY);CREATE TABLE child(parentId INTEGER REFERENCES parent(id));INSERT INTO child VALUES(7);');
    assert.deepEqual(foreignKeyCheck(db), [{schema: 'main', table: 'child', rowid: 1, parent: 'parent', parentSchema: 'main', constraint: 'fk:0'}]);
  } finally { db.close(); }
});

test('the server serves a project filled before it started, and inspectProject reads it on the server connection', {timeout: 120_000}, async t => {
  const dataDir = dataDirectory(t);
  const {projectId, store} = createServerProject(dataDir, {name: 'Filled before start'});
  store.close();
  let inspectProject!: InspectProject;
  const server = await startServer({dataDir, port: 0, token: TOKEN, inspectProject: inspect => { inspectProject = inspect; }});
  let running = true;
  t.after(async () => { if (running) await server.close(); });
  const rpc = async (operation: string, input: unknown): Promise<unknown> => {
    const response = await fetch(server.url + rpcPathFor(operation, input), {method: 'POST', headers: {authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json'}, body: JSON.stringify({operation, input})});

    const body = await response.json() as {ok: boolean; data: unknown};
    assert.equal(response.status, 200, JSON.stringify(body));
    return body.data;
  };

  const listed = await rpc('project.list', {}) as {id: string; name: string}[];
  assert.deepEqual(listed.map(({id, name}) => ({id, name})), [{id: projectId, name: 'Filled before start'}]);
  await rpc('shot.create', {requestId: randomUUID(), projectId, title: 'Written by the server'});

  const connections = new Set<DatabaseSync>();
  const shots = inspectProject(projectId, db => {
    connections.add(db);
    return db.prepare('SELECT count(*) AS n FROM shots WHERE projectId=?').get(projectId)?.n;
  });
  assert.equal(shots, 1);
  assert.equal(inspectProject(projectId, db => { connections.add(db); return projectName(db, projectId); }), 'Filled before start');
  assert.equal(connections.size, 1);
  assert.throws(() => openProjectDatabase(projectDirFor(dataDir, projectId)), {code: 'PROJECT_LOCKED'});
  assert.throws(() => inspectProject(randomUUID(), () => 1), {code: 'PROJECT_NOT_FOUND', status: 404});
  let called = false;
  assert.throws(() => inspectProject(projectId, async () => { called = true; }), TypeError);
  assert.equal(called, false, 'an async callback is refused before it runs');
  assert.throws(() => inspectProject(projectId, () => Promise.resolve(1)), TypeError);

  await server.close();
  running = false;
  const [connection] = connections;
  assert.equal(connection?.isOpen, false, 'the callbacks ran on the connection the server closed');
  assert.throws(() => inspectProject(projectId, () => 1));
  openProjectDatabase(projectDirFor(dataDir, projectId)).close();
});

test('server-layout TEST projects share the real application owner until their last store closes', async t => {
  const root = dataDirectory(t), a = createServerProject(root, {name: 'Shared A'}), first = createServices(a.store, new Map());
  const app = testProjectAppLibrary(a.store); assert.ok(app);
  const b = createServerProject(root, {name: 'Shared B'}), second = createServices(b.store, new Map());
  t.after(async () => {await first.drain(); await second.drain(); a.store.close(); b.store.close();});
  assert.equal(testProjectAppLibrary(b.store), app);
  assert.notEqual(a.store.db, b.store.db);
  await first.call('workspace.settings.set', {expectedRevision: 0, liveGeneration: true});
  assert.deepEqual(await second.call('workspace.settings.get', {}), await first.call('workspace.settings.get', {}));
  await first.drain(); a.store.close();
  assert.equal(app.db.isOpen, true);
  assert.equal(workspaceSettingsSchema.parse(await second.call('workspace.settings.get', {})).liveGeneration, true);
  assert.equal(b.store.db.prepare('SELECT id FROM projects WHERE id=?').get(b.projectId)?.id, b.projectId);
  await second.drain(); b.store.close();
  assert.equal(app.db.isOpen, false);
});

test('trusted application inspection borrows only the live owner and rejects asynchronous work and use after shutdown', async t => {
  const root = dataDirectory(t); let inspect!: InspectApplication, calls = 0;
  const server = await startServer({dataDir: root, port: 0, token: TOKEN, inspectApplication: received => {inspect = received;}});
  t.after(() => server.close());
  const db = inspect(held => held);
  assert.equal(inspect(held => held), db);
  assert.equal(db.isOpen, true);
  assert.equal(Number(inspect(held => held.prepare('SELECT count(*) AS n FROM recent_projects').get()!.n)), 0);
  assert.throws(() => inspect(async () => {calls++;}), /synchronous/);
  assert.equal(calls, 0, 'an async callback never runs');
  assert.throws(() => inspect(() => Promise.resolve()), /synchronous/);
  assert.equal((await fetch(server.url + '/api/inspectApplication', {headers: {authorization: `Bearer ${TOKEN}`}})).status, 404);
  await server.close();
  assert.equal(db.isOpen, false);
  assert.throws(() => inspect(held => held.isOpen), {name: 'AbortError'});
});

test('the TEST opener accepts a public project folder but rejects linked roots and ancestors before writing', t => {
  const root = dataDirectory(t), target = dataDirectory(t), link = path.join(root, 'linked');
  chmodSync(target, 0o755);
  symlinkSync(target, link, 'dir');
  for (const projectRoot of [link, path.join(link, 'uncreated')]) {
    assert.throws(() => openStore(projectRoot), {code: 'STORAGE_PRIVATE_REQUIRED', reason: 'SYMBOLIC_LINK'});
    assert.deepEqual(readdirSync(target), [], 'rejection leaves the linked target untouched');
  }
  const store = openStore(target);
  t.after(() => store.close());
  assert.equal(lstatSync(target).mode & 0o777, 0o755);
  assert.equal(lstatSync(store.localDir).mode & 0o777, 0o700);
  assert.equal(lstatSync(path.join(target, 'media')).mode & 0o777, 0o700);
});

test('the assembled application configuration acknowledges only its own committed transaction', t => {
  const root = dataDirectory(t), library = openAppLibrary({dataDir: root});
  t.after(() => library.close());
  const ports = createProjectServiceApplication(library, undefined, {MIOON_ENABLE_LIVE_PROVIDER: '0'});
  const before = ports.configuration.get(); let acknowledged = false;
  assert.throws(() => library.tx(() => {
    ports.configuration.set({expectedRevision: before.revision, liveGeneration: true});
    acknowledged = true;
  }), /transaction/iu);
  assert.equal(acknowledged, false);
  assert.deepEqual(ports.configuration.get(), before);
  assert.equal(library.documents.read('workspace-settings-v1.json'), null);
  const saved = ports.configuration.set({expectedRevision: before.revision, liveGeneration: true});
  assert.equal(saved.revision, before.revision + 1);
  assert.equal(saved.liveGeneration, true);
  assert.deepEqual(JSON.parse(library.documents.read('workspace-settings-v1.json')!), {
    formatVersion: 1, revision: saved.revision, liveGeneration: true,
    automaticBackup: before.automaticBackup, backupIntervalHours: before.backupIntervalHours, backupLocation: before.backupLocation,
  });
});
