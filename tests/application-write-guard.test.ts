import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {IncomingMessage, ServerResponse} from 'node:http';
import {Socket} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import type {AppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectStore, openProjectStore} from '../packages/business/src/project-file/store.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {WorkspaceSettings} from '../packages/contracts/src/workspace-configuration.ts';
import {parseProjectApiPath, projectRpcPath} from '../packages/contracts/src/project-file.ts';
import type {ProjectVersionListResponse, ProjectVersionSaveResponse, ProjectVersionPreviewResponse} from '../packages/contracts/src/project-version-operations.ts';
import {composeApplicationRuntime} from '../apps/server/src/application-runtime.ts';
import {createProjectFiles} from '../apps/server/src/project-host/manager.ts';
import {projectLocation, serverAppDirectories} from '../apps/server/src/project-host/directories.ts';
import {composeHostedProject} from '../apps/server/src/project-host/runtime.ts';

function patch(settings: WorkspaceSettings) {
  return {expectedRevision: settings.revision, liveGeneration: !settings.liveGeneration};
}
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-app-write-'));
  const library = openAppLibrary({dataDir: path.join(root, 'app')}), libraries = new Set<AppLibrary>([library]);
  const store = createProjectStore({projectFile: path.join(root, 'Project.mioon'), locate: () => ({
    localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'tmp'),
  })});
  store.tx(() => store.put('projects', {id: store.projectId, name: 'Write guard', description: '', revision: 1,
    createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z'}));
  const owner = new AbortController(), ports = createProjectServiceApplication(library, owner.signal, {});
  const services = createServices(store, new Map(), {application: ports, env: {}, imageOptions: {autoRun: false}, frameOptions: {autoRun: false}, sceneOptions: {autoRun: false}});
  t.after(async () => {
    try {await services.drain();} finally {
      store.close(); for (const value of libraries) value.close(); rmSync(root, {recursive: true, force: true});
    }
  });
  const changes = () => ({project: store.db.prepare('SELECT total_changes() AS n').get()!.n, app: library.db.prepare('SELECT total_changes() AS n').get()!.n});
  const shot = () => ({projectId: store.projectId, title: 'Guarded shot', prompt: '', requestId: randomUUID()});
  return {root, library, libraries, store, owner, ports, services, changes, shot};
}

async function versionFixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-version-write-'));
  const directories = serverAppDirectories(root), library = openAppLibrary({dataDir: root}), libraries = new Set<AppLibrary>([library]);
  const entry = createProjectFiles({name: 'Version write guard'}, {directories, registry: library.registry, identity: library.projectFileIdentity});
  const store = openProjectStore({projectFile: entry.projectFile, locate: id => projectLocation(directories, id)});
  const owner = new AbortController(), options = {port: 0, comfyModule: 'skip' as const};
  const app = await composeApplicationRuntime(library, options, owner.signal, () => undefined);
  const runtime = await composeHostedProject({projectId: entry.projectId, store, directories, signal: owner.signal, relocate() {}},
    library, app, options, () => undefined, () => 4318);
  t.after(async () => {
    runtime.interrupt();
    try {await runtime.drain();} finally {
      runtime.dispose(); await app.close(); store.close();
      for (const value of libraries) value.close();
      rmSync(root, {recursive: true, force: true});
    }
  });
  const state = () => ({
    changes: store.db.prepare('SELECT total_changes() AS n').get()!.n,
    tables: Object.fromEntries(['project_versions', 'project_version_blobs', 'project_version_requests', 'project_version_capture_marks']
      .map(table => [table, store.db.prepare(`SELECT * FROM main.${table} ORDER BY rowid`).all()])),
  });
  const rpc = async <T>(operation: string, input: unknown): Promise<T> => {
    const pathname = projectRpcPath(store.projectId), route = parseProjectApiPath(pathname);
    assert.ok(route);
    const socket = new Socket(), req = new IncomingMessage(socket), res = new ServerResponse(req);
    req.method = 'POST'; req.url = pathname;
    req.push(Buffer.from(JSON.stringify({operation, input}))); req.push(null);
    const end = t.mock.method(res, 'end');
    try {
      assert.equal(await runtime.handle({req, res, url: new URL(pathname, 'http://127.0.0.1:4318'), route,
        signal: new AbortController().signal}), true);
      assert.equal(res.statusCode, 200);
      assert.equal(end.mock.callCount(), 1);
      const response = JSON.parse(String(end.mock.calls[0]!.arguments[0])) as {ok: boolean; data: T};
      assert.equal(response.ok, true);
      return response.data;
    } finally {socket.destroy();}
  };
  const empty = {project_versions: [], project_version_blobs: [], project_version_requests: [], project_version_capture_marks: []};
  assert.deepEqual(state().tables, empty);
  return {root, library, libraries, store, owner, runtime, rpc, state, empty};
}

test('project and configuration writes use application admission independently of the legacy backup port', async t => {
  const f = fixture(t), before = f.ports.configuration.get();
  assert.equal(Object.hasOwn(f.ports, 'backups'), false, 'application admission exposes no retired backup port');
  assert.doesNotThrow(() => f.services.assertMutationAllowed());
  const shot = await f.services.call('shot.create', f.shot()) as {id: string};
  assert.ok(f.store.get('shots', shot.id));
  const settings = await f.services.call('workspace.settings.set', patch(before)) as WorkspaceSettings;
  assert.equal(settings.revision, before.revision + 1);
  assert.equal(settings.liveGeneration, !before.liveGeneration);
  assert.ok(f.library.documents.read('workspace-settings-v1.json'));
  assert.equal(Object.hasOwn(f.services, 'backups'), false);
  await assert.rejects(f.services.call('workspace.backup.create', {requestId: randomUUID()}), {code: 'UNKNOWN_OPERATION'});
});

test('a kernel cannot substitute a backup port for missing application write admission', t => {
  const f = fixture(t), before = f.changes();
  assert.equal(Reflect.deleteProperty(f.ports, 'assertMutationAllowed'), true);
  assert.throws(() => createServices(f.store, new Map(), {application: f.ports}), /explicit application configuration and write admission/u);
  assert.deepEqual(f.changes(), before);
  assert.equal(f.library.documents.read('workspace-settings-v1.json'), null);
  assert.deepEqual(f.store.list('shots'), []);
});

test('an aborted application owner rejects project/settings writes before any database effect', async t => {
  const f = fixture(t), input = patch(f.ports.configuration.get()), before = f.changes(), reason = new Error('application owner stopped');
  f.owner.abort(reason);
  assert.throws(() => f.ports.assertMutationAllowed(), error => error === reason);
  assert.throws(() => f.services.assertMutationAllowed(), error => error === reason);
  await assert.rejects(f.services.call('shot.create', f.shot()), error => error === reason);
  await assert.rejects(f.services.call('workspace.settings.set', input), error => error === reason);
  assert.deepEqual(f.changes(), before);
  assert.equal(f.library.documents.read('workspace-settings-v1.json'), null);
  assert.deepEqual(f.store.list('shots'), []);
});

test('a closed application capability cannot revive when a new owner opens the same library', async t => {
  const f = fixture(t), input = patch(f.ports.configuration.get()), before = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  f.library.close();
  const replacement = openAppLibrary({dataDir: path.join(f.root, 'app')}); f.libraries.add(replacement);
  const current = createProjectServiceApplication(replacement);
  assert.doesNotThrow(() => current.assertMutationAllowed());
  const invalid = {name: 'TypeError', message: 'Project services require a live application library owner'};
  assert.throws(() => f.ports.assertMutationAllowed(), invalid);
  assert.throws(() => f.services.assertMutationAllowed(), invalid);
  await assert.rejects(f.services.call('shot.create', f.shot()), invalid);
  await assert.rejects(f.services.call('workspace.settings.set', input), invalid);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, before);
  assert.equal(replacement.documents.read('workspace-settings-v1.json'), null);
  assert.deepEqual(f.store.list('shots'), []);
});

test('hosted manual versions use application admission while list and preview remain read-only', async t => {
  const f = await versionFixture(t), projectId = f.store.projectId;
  const guard = t.mock.method(f.runtime.project.services, 'assertMutationAllowed');
  const input = {projectId, requestId: randomUUID(), name: 'Admitted version'};
  const saved = await f.rpc<ProjectVersionSaveResponse>('project.version.save', input);
  assert.equal(guard.mock.callCount(), 1);
  assert.equal(saved.requestId, input.requestId);
  assert.equal(saved.version.name, input.name);
  assert.deepEqual(Object.fromEntries(Object.entries(f.state().tables).map(([table, rows]) => [table, rows.length])),
    {project_versions: 1, project_version_blobs: 1, project_version_requests: 1, project_version_capture_marks: 0});
  const before = f.state(), reason = new Error('Read operations must not ask for mutation admission');
  guard.mock.mockImplementation(() => {throw reason;});
  const listed = await f.rpc<ProjectVersionListResponse>('project.version.list', {projectId});
  assert.deepEqual(listed.versions, [saved.version]);
  const preview = await f.rpc<ProjectVersionPreviewResponse>('project.version.preview', {projectId, versionId: saved.version.id});
  assert.equal(preview.restoreAvailable, false);
  assert.deepEqual(preview.changes, []);
  assert.equal(guard.mock.callCount(), 1);
  assert.deepEqual(f.state(), before);
});

test('an aborted hosted owner refuses manual versions before all four history tables can change', async t => {
  const f = await versionFixture(t), projectId = f.store.projectId, before = f.state();
  f.owner.abort();
  let reason: unknown;
  assert.throws(() => f.runtime.project.services.assertMutationAllowed(), error => {
    assert.ok(error instanceof DOMException);
    assert.equal(error.name, 'AbortError');
    assert.equal(error.message, 'This operation was aborted');
    reason = error; return true;
  });
  await assert.rejects(f.rpc('project.version.save', {projectId, requestId: randomUUID()}), error => error === reason);
  assert.deepEqual((await f.rpc<ProjectVersionListResponse>('project.version.list', {projectId})).versions, []);
  await assert.rejects(f.rpc('project.version.preview', {projectId, versionId: randomUUID()}), {code: 'PROJECT_VERSION_NOT_FOUND', status: 404});
  assert.deepEqual(f.state(), before);
  assert.deepEqual(f.state().tables, f.empty);
});

test('a reopened B1 owner cannot authorize manual versions from the old hosted capability', async t => {
  const f = await versionFixture(t), projectId = f.store.projectId, before = f.state();
  f.library.close();
  const replacement = openAppLibrary({dataDir: f.root}); f.libraries.add(replacement);
  assert.doesNotThrow(() => createProjectServiceApplication(replacement).assertMutationAllowed());
  const invalid = {name: 'TypeError', message: 'Project services require a live application library owner'};
  assert.throws(() => f.runtime.project.services.assertMutationAllowed(), invalid);
  await assert.rejects(f.rpc('project.version.save', {projectId, requestId: randomUUID()}), invalid);
  assert.deepEqual((await f.rpc<ProjectVersionListResponse>('project.version.list', {projectId})).versions, []);
  await assert.rejects(f.rpc('project.version.preview', {projectId, versionId: randomUUID()}), {code: 'PROJECT_VERSION_NOT_FOUND', status: 404});
  assert.deepEqual(f.state(), before);
  assert.deepEqual(f.state().tables, f.empty);
  assert.equal(replacement.documents.read('workspace-settings-v1.json'), null);
});

test('configuration ACK follows its own real B1 commit and failed/nested transactions retain the previous document', t => {
  const f = fixture(t), before = f.ports.configuration.get(), input = patch(before);
  let notifications = 0;
  f.ports.configuration.subscribe(() => notifications++);
  assert.throws(() => f.library.tx(() => f.ports.configuration.set(input)), {message: 'Nested transactions are not supported'});
  assert.equal(f.library.documents.read('workspace-settings-v1.json'), null);
  assert.equal(f.library.db.isTransaction, false);
  const exec = f.library.db.exec;
  const injected = t.mock.method(f.library.db, 'exec', function(this: typeof f.library.db, sql: string): void {
    if (sql === 'COMMIT') throw new Error('injected application commit failure');
    exec.call(this, sql);
  });
  assert.throws(() => f.ports.configuration.set(input), {message: 'injected application commit failure'});
  injected.mock.restore();
  assert.equal(f.library.db.isTransaction, false);
  assert.equal(f.library.documents.read('workspace-settings-v1.json'), null);
  assert.deepEqual(f.ports.configuration.get(), before);
  assert.equal(notifications, 0);
  const saved = f.ports.configuration.set(input);
  assert.equal(saved.revision, before.revision + 1);
  assert.equal(notifications, 1);
  const persisted = JSON.parse(f.library.documents.read('workspace-settings-v1.json')!);
  assert.equal(persisted.revision, saved.revision);
  assert.equal(persisted.liveGeneration, saved.liveGeneration);
  assert.equal(f.library.db.isTransaction, false);
});
