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
import {createServerProject, foreignKeyCheck, openProjectDatabase, projectDatabasePath, projectDirFor, schemaObjects} from './helpers/project-database.ts';

const TOKEN = 'synthetic-project-database-token';
const PRAGMAS = ['trusted_schema', 'foreign_keys', 'journal_mode', 'synchronous', 'busy_timeout', 'locking_mode'];
const pragmas = (db: DatabaseSync): Record<string, unknown> =>
  Object.fromEntries(PRAGMAS.map(name => [name, Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0]]));
const projectName = (db: DatabaseSync, projectId: string): string =>
  (JSON.parse(String(db.prepare('SELECT data FROM projects WHERE id=?').get(projectId)?.data)) as {name: string}).name;

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

test('the server serves a project filled before it started, and inspectProject reads it on the server connection', {timeout: 120_000}, async t => {
  const dataDir = dataDirectory(t);
  const {projectId, store} = createServerProject(dataDir);
  store.put('projects', {...(store.get('projects', projectId) as object), name: 'Filled before start'});
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
