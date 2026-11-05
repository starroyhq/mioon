import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync, unlinkSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {startServer, type InspectApplication} from '../apps/server/src/index.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {backgroundTaskQueryResponseSchema} from '../packages/contracts/src/background-task-query.ts';
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
