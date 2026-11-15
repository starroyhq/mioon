import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createQaProject, ensureQaProject, closeQaProject, auditQaDatabases, readQaFixture} from './helpers/kernel-qa-fixture.mjs';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {startServer} from './helpers/test-server.ts';
import type {InspectProject} from '../apps/server/src/project-host/host.ts';
import type {DatabaseSync} from 'node:sqlite';

test('QA projects have separate real files, share the app registry, and reopen without shadow workspaces', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-kernel-qa-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const first = await createQaProject(root, {name: 'First', media: false});
  const second = await createQaProject(root, {name: 'Second', media: false});
  const firstId: string = first.store.projectId, secondId: string = second.store.projectId;
  try {
    assert.notEqual(firstId, secondId);
    assert.notEqual(first.store.projectFile, second.store.projectFile);
    assert.equal(first.store.db.prepare('SELECT count(*) AS n FROM project.projects').get()?.n, 1);
    assert.equal(second.store.db.prepare('SELECT count(*) AS n FROM project.projects').get()?.n, 1);
    assert.equal(first.store.get('projects', secondId), null);
    assert.equal(second.store.get('projects', firstId), null);
    assert.deepEqual(Object.keys(auditQaDatabases(first.store.db).databases), ['main', 'project', 'cache']);
    assert.equal(existsSync(path.join(root, 'workbench.sqlite')), false);
  } finally { await closeQaProject(second); await closeQaProject(first); }
  const reopened = await ensureQaProject(root, {name: 'First', media: false});
  try { assert.equal(reopened.store.projectId, firstId); }
  finally { await closeQaProject(reopened); }
  const library = openAppLibrary({dataDir: root});
  try { assert.deepEqual(library.registry.list().map(entry => entry.projectId).sort(), [firstId, secondId].sort()); }
  finally { library.close(); }
});

test('QA refuses historical and invalid cached data without replacing its source', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-qa-legacy-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const file = path.join(root, 'workbench.sqlite'), before = Buffer.from('preserve historical fixture');
  writeFileSync(file, before);
  await assert.rejects(createQaProject(root, {media: false}), /must be preserved/u);
  await assert.rejects(ensureQaProject(root, {media: false}), /must be preserved/u);
  assert.deepEqual(readFileSync(file), before);
  assert.equal(existsSync(path.join(root, 'app-library.db')), false);
  const cached = path.join(root, 'fixture.json');
  writeFileSync(cached, JSON.stringify({workspace: root, project: {id: 'historical'}}));
  assert.throws(() => readQaFixture(cached, root), /must be preserved/u);
  assert.equal(readQaFixture(path.join(root, 'absent.json'), root), null);
  assert.deepEqual(readFileSync(file), before);
});

test('live QA audits use the actual manager and application inspect capabilities without extra connections', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-qa-inspect-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const prepared = await createQaProject(root, {media: false}), id: string = prepared.store.projectId;
  await closeQaProject(prepared);
  let inspectProject: InspectProject | undefined;
  let inspectApplication: (<T>(read: (db: DatabaseSync) => T) => T) | undefined;
  const backend = await startServer({dataDir: root, port: 0, token: 'kernel-qa-synthetic-inspect-token',
    inspectProject: inspect => {inspectProject = inspect;}, inspectApplication: inspect => {inspectApplication = inspect;}});
  try {
    assert.ok(inspectProject); assert.ok(inspectApplication);
    const response = await fetch(`${backend.url}/api/projects/${id}/rpc`, {method: 'POST', headers: {
      authorization: 'Bearer kernel-qa-synthetic-inspect-token', 'content-type': 'application/json'},
    body: JSON.stringify({operation: 'project.get', input: {projectId: id}})});
    assert.equal(response.status, 200);
    const first = inspectProject(id, auditQaDatabases), second = inspectProject(id, auditQaDatabases);
    assert.deepEqual(second, first);
    assert.deepEqual(Object.keys(first.databases), ['main', 'project', 'cache']);
    const app = inspectApplication(auditQaDatabases);
    assert.deepEqual(Object.keys(app.databases), ['main']);
    assert.ok(app.databases.main.schema.length > 0);
    assert.equal(existsSync(path.join(root, 'workbench.sqlite')), false);
  } finally {await backend.close();}
});
