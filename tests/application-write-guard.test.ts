import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import type {AppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {WorkspaceSettings} from '../packages/contracts/src/workspace-configuration.ts';

function patch(settings: WorkspaceSettings) {
  return {expectedRevision: settings.revision, liveGeneration: !settings.liveGeneration, automaticBackup: settings.automaticBackup,
    backupIntervalHours: settings.backupIntervalHours, backupLocation: settings.backupLocation};
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

test('project and configuration writes use application admission independently of the legacy backup port', async t => {
  const f = fixture(t), before = f.ports.configuration.get();
  let backupGuardCalls = 0;
  f.ports.backups.assertMutationAllowed = () => {backupGuardCalls++; throw new Error('Legacy backup admission must not own application writes');};
  assert.doesNotThrow(() => f.services.assertMutationAllowed());
  const shot = await f.services.call('shot.create', f.shot()) as {id: string};
  assert.ok(f.store.get('shots', shot.id));
  const settings = await f.services.call('workspace.settings.set', patch(before)) as WorkspaceSettings;
  assert.equal(settings.revision, before.revision + 1);
  assert.equal(settings.liveGeneration, !before.liveGeneration);
  assert.ok(f.library.documents.read('workspace-settings-v1.json'));
  assert.equal(backupGuardCalls, 0);
  await assert.rejects(f.services.call('workspace.backup.create', {requestId: randomUUID()}), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
});

test('a kernel cannot substitute a backup port for missing application write admission', t => {
  const f = fixture(t), before = f.changes();
  assert.equal(Reflect.deleteProperty(f.ports, 'assertMutationAllowed'), true);
  assert.throws(() => createServices(f.store, new Map(), {application: f.ports}), /explicit application configuration, write admission/u);
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
