import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {mkdtempSync, readFileSync, rmSync, unlinkSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {startServer, type InspectApplication} from './helpers/test-server.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {backgroundTaskQueryResponseSchema} from '../packages/contracts/src/background-task-query.ts';
import {PROJECT_FILE_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {createServerProject} from './helpers/project-database.ts';

test('authenticated background metadata lists offline tasks without acquiring projects or exposing private evidence', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 's3-background-http-')), token = 'synthetic-s3-http-token';
  const projects = Array.from({length: 2}, () => {const created = createServerProject(root, {name: 'Private project name'});
    const result = {projectId: created.projectId, projectFile: created.store.projectFile}; created.store.close(); return result;});
  const ids = projects.map(project => project.projectId).sort(), app = openAppLibrary({dataDir: root});
  for (const {projectId, projectFile} of projects) {
    app.taskIndex.upsert({projectId, projectFile, kind: 'job', taskId: randomUUID(), indexedAt: new Date().toISOString()});
    unlinkSync(projectFile);
  }
  app.close();
  let inspect!: InspectApplication;
  const server = await startServer({dataDir: root, port: 0, token, inspectApplication: read => {inspect = read;}});
  t.after(async () => {await server.close(); rmSync(root, {recursive: true, force: true});});
  const owned = (url: string, options: RequestInit = {}) => fetch(server.url + url, {...options, headers: {authorization: `Bearer ${token}`, ...options.headers}});
  const changes = inspect(db => db.prepare('SELECT total_changes() AS n').get()!.n);
  const denied = await fetch(server.url + '/api/background-tasks'); assert.equal(denied.status, 401);
  const first = await owned('/api/background-tasks?limit=1'), raw = await first.text();
  assert.equal(first.status, 200); assert.equal(first.headers.get('cache-control'), 'no-store');
  const one = backgroundTaskQueryResponseSchema.parse(JSON.parse(raw).data);
  assert.equal(one.projects.length, 1); assert.equal(one.projects[0]!.projectId, ids[0]); assert.equal(one.projects[0]!.taskCount, 1);
  assert.deepEqual(one.projects[0]!.reasonCodes, ['PROJECT_MISSING']); assert.equal(one.nextCursor, ids[0]);
  assert.equal(raw.includes(root), false); assert.equal(raw.includes('Private project name'), false); assert.equal(raw.includes('taskId'), false);
  const second = await owned('/api/background-tasks?after=' + one.nextCursor + '&limit=1');
  const two = backgroundTaskQueryResponseSchema.parse((await second.json()).data);
  assert.equal(two.projects[0]!.projectId, ids[1]); assert.equal(two.nextCursor, null);
  assert.equal(inspect(db => db.prepare('SELECT total_changes() AS n').get()!.n), changes, 'metadata GETs do not write the application library');
  assert.equal((await owned('/api/background-tasks', {method: 'POST'})).status, 405);
  for (const query of ['?limit=0', '?limit=101', '?limit=1&limit=2', '?after=../private', '?projectFile=/private'])
    assert.equal((await owned('/api/background-tasks' + query)).status, 400);
});

test('closed projects from a newer format retain their exact unavailable reason in homepage metadata', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'u2-newer-background-')), token = 'synthetic-u2-http-token';
  const project = createServerProject(root, {name: 'Newer format'}), projectFile = project.store.projectFile;
  project.store.close();
  const future = new DatabaseSync(projectFile);
  try {future.exec(`PRAGMA user_version=${PROJECT_FILE_SCHEMA_VERSION + 1}`);} finally {future.close();}
  const original = readFileSync(projectFile), app = openAppLibrary({dataDir: root});
  app.taskIndex.upsert({projectId: project.projectId, projectFile, kind: 'job', taskId: randomUUID(), indexedAt: new Date().toISOString()});
  app.close();
  let inspect!: InspectApplication;
  const server = await startServer({dataDir: root, port: 0, token, inspectApplication: read => {inspect = read;}});
  t.after(async () => {await server.close(); rmSync(root, {recursive: true, force: true});});
  const changes = inspect(db => db.prepare('SELECT total_changes() AS n').get()!.n);
  for (let repeat = 0; repeat < 2; repeat++) {
    const response = await fetch(server.url + '/api/background-tasks', {headers: {authorization: `Bearer ${token}`}});
    assert.equal(response.status, 200);
    const data = backgroundTaskQueryResponseSchema.parse((await response.json()).data);
    assert.deepEqual(data.projects, [{projectId: project.projectId, taskCount: 1, reasonCodes: ['PROJECT_FORMAT_NEWER']}]);
    assert.equal(data.nextCursor, null);
  }
  assert.equal(inspect(db => db.prepare('SELECT total_changes() AS n').get()!.n), changes, 'metadata queries cannot retry opening or rewrite the index');
  assert.deepEqual(readFileSync(projectFile), original, 'a newer project file remains byte for byte unchanged');
});

for (const code of ['EACCES', 'EPERM']) test(`a closed project denied by ${code} keeps its independent access-denied reason in homepage background metadata`, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 's3-background-permission-')), token = 'synthetic-s3-permission-token';
  const created = createServerProject(root, {name: 'Private permission project'});
  const projectId = created.projectId, projectFile = created.store.projectFile;
  created.store.close();
  const before = fs.readFileSync(projectFile), app = openAppLibrary({dataDir: root});
  const taskId = randomUUID();
  app.taskIndex.upsert({projectId, projectFile, kind: 'job', taskId, indexedAt: new Date().toISOString()});
  app.close();
  const original = fs.lstatSync;
  let deniedInspections = 0;
  const replacement = (...args: unknown[]) => {
    if (String(args[0]) === projectFile) {
      deniedInspections++;
      throw Object.assign(new Error('SYNTHETIC_PRIVATE_OS_DIAGNOSTIC'), {code});
    }
    return Reflect.apply(original, fs, args);
  };
  const mocked = t.mock.method(fs, 'lstatSync', replacement as typeof original);
  syncBuiltinESMExports();
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    let inspect!: InspectApplication;
    server = await startServer({dataDir: root, port: 0, token, inspectApplication: read => {inspect = read;}});
    assert.ok(deniedInspections > 0, 'startup actually inspected the selected closed project');
    assert.deepEqual(server.projectEntries.listRecent().registered.find(entry => entry.project.projectId === projectId)!.availability,
      {state: 'access-denied'}, 'the permission failure did not compose a project runtime');
    const changes = inspect(db => db.prepare('SELECT total_changes() AS n').get()!.n);
    for (let read = 0; read < 2; read++) {
      const response: Response = await fetch(server.url + '/api/background-tasks', {headers: {authorization: `Bearer ${token}`}});
      const raw = await response.text();
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const data = backgroundTaskQueryResponseSchema.parse(JSON.parse(raw).data);
      assert.deepEqual(data.projects, [{projectId, taskCount: 1, reasonCodes: ['PROJECT_ACCESS_DENIED']}]);
      assert.equal(data.nextCursor, null);
      for (const privateText of [root, projectFile, taskId, 'Private permission project', 'SYNTHETIC_PRIVATE_OS_DIAGNOSTIC']) {
        assert.equal(raw.includes(privateText), false, 'the homepage response exposes only bounded public metadata');
      }
    }
    assert.equal(inspect(db => db.prepare('SELECT total_changes() AS n').get()!.n), changes, 'homepage reads do not rewrite the blocked index');
  } finally {
    try {await server?.close();}
    finally {
      mocked.mock.restore(); syncBuiltinESMExports();
      assert.deepEqual(fs.readFileSync(projectFile), before);
      rmSync(root, {recursive: true, force: true});
    }
  }
});
