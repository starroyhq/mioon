import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {lstatSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {startServer} from '../apps/server/src/index.ts';
import type {InspectProject} from '../apps/server/src/index.ts';
import {openStore} from '../packages/business/src/db.ts';
import {isProjectId} from '../packages/contracts/src/project-file.ts';
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
    const main = db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name').all()
      .map(row => ({schema: 'main', type: String(row.type), name: String(row.name), tbl_name: String(row.tbl_name), sql: typeof row.sql === 'string' ? row.sql : null}));
    assert.ok(main.some(object => object.type === 'table' && object.name === 'projects'));
    db.exec("ATTACH ':memory:' AS extra; CREATE TABLE extra.parent(id INTEGER PRIMARY KEY); CREATE TABLE extra.child(parentId INTEGER REFERENCES parent(id));");
    const orphan = randomUUID();
    db.exec('PRAGMA foreign_keys=OFF');
    db.prepare('INSERT INTO workspace_preferences VALUES(?,1,?)').run(orphan, '{}');
    db.exec('INSERT INTO extra.child VALUES(7); PRAGMA foreign_keys=ON;');
    const rowid = Number(db.prepare('SELECT rowid FROM workspace_preferences WHERE projectId=?').get(orphan)?.rowid);
    assert.deepEqual(foreignKeyCheck(db), [
      {schema: 'main', table: 'workspace_preferences', rowid, parent: 'projects', parentSchema: 'main', constraint: 'fk:0'},
      {schema: 'extra', table: 'child', rowid: 1, parent: 'parent', parentSchema: 'extra', constraint: 'fk:0'},
    ]);
    const objects = schemaObjects(db);
    assert.deepEqual(objects.filter(object => object.schema === 'main'), main);
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
    assert.throws(() => withoutForeignKeys(db, () => { assert.equal(foreignKeys(db), 0); throw new Error('synthetic write failure'); }), /^Error: synthetic write failure$/);
    assert.equal(foreignKeys(db), 1);
    const rejected = withoutForeignKeys(db, async () => { await Promise.resolve(); throw new Error('synthetic async failure'); });
    assert.equal(foreignKeys(db), 0);
    await assert.rejects(rejected, /^Error: synthetic async failure$/);
    assert.equal(foreignKeys(db), 1);
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
    assert.equal(db.isTransaction, true);
    db.exec('ROLLBACK; PRAGMA foreign_keys=ON;');
    assert.equal(foreignKeys(db), 1);
  } finally {
    store.close();
  }
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
    const response = await fetch(`${server.url}/api/rpc`, {method: 'POST', headers: {authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json'}, body: JSON.stringify({operation, input})});
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
