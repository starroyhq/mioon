import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync, readFileSync} from 'node:fs';
import {createServer, IncomingMessage, ServerResponse} from 'node:http';
import {once} from 'node:events';
import {Socket} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import type {AppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectStore, openProjectStore} from '../packages/business/src/project-file/store.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {createServices, hash} from '../packages/business/src/services.ts';
import type {WorkspaceSettings} from '../packages/contracts/src/workspace-configuration.ts';
import {parseProjectApiPath, projectRpcPath} from '../packages/contracts/src/project-file.ts';
import type {ProjectVersionListResponse, ProjectVersionSaveResponse, ProjectVersionPreviewResponse} from '../packages/contracts/src/project-version-operations.ts';
import {composeApplicationRuntime} from '../apps/server/src/application-runtime.ts';
import {createProjectFiles} from '../apps/server/src/project-host/manager.ts';
import {projectLocation, serverAppDirectories} from '../apps/server/src/project-host/directories.ts';
import {composeHostedProject} from '../apps/server/src/project-host/runtime.ts';
import {saveBeforeBulkChangeInside} from '../packages/business/src/project-versions/capture.ts';
import {withTaskEffectOrigin} from '../packages/business/src/agent/task-effects-v2.ts';
import {createMioProjectJournal} from '../packages/business/src/agent/mio-journal-factory.ts';
import {mioFixtureConfiguration} from './helpers/mio-model-fixture.ts';
import {createAssetMediaHttp} from '../apps/server/src/asset-media-http.ts';
import {referenceForPublishedMedia} from '../packages/business/src/project-media-storage.ts';
import {createProjectAssetReferenceServices} from '../packages/business/src/project-asset-references.ts';
import {assetMediaPrepareResponseSchema} from '../packages/contracts/src/asset-media.ts';
import {mp4HeaderFixture} from './helpers/media-reference-fixtures.ts';
import {png} from './helpers/timeline-image-fixtures.ts';
import {readProjectState, changeMarks} from './helpers/project-state.ts';
import {dataFileSnapshot} from './helpers/data-file-snapshot.ts';

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
    } finally {res.emit('close'); socket.destroy();}
  };
  const empty = {project_versions: [], project_version_blobs: [], project_version_requests: [], project_version_capture_marks: []};
  assert.deepEqual(state().tables, empty);
  return {root, library, libraries, store, owner, runtime, rpc, state, empty};
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
async function mediaFixture(t: TestContext) {
  const f = fixture(t), projectId = f.store.projectId, assetId = randomUUID();
  const bytes = mp4HeaderFixture('Write admission hashes bytes without running a decoder');
  const source = path.join(f.root, 'source.mp4'), candidate = path.join(f.root, 'candidate.mp4');
  writeFileSync(source, bytes); writeFileSync(candidate, bytes);
  const prepared = await referenceForPublishedMedia(f.store, source);
  f.store.tx(() => f.store.put('assets', {id: assetId, projectId, name: 'Sampled video', mimeType: 'video/mp4',
    reference: {...prepared.reference, fullSha256: null}, referenceRevision: 1, sha256: null, sizeBytes: bytes.length}));
  // Real external references make the two permission requests independently
  // meaningful: confirm starts unconfirmed and revoke starts confirmed.
  const external = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-app-write-external-'));
  t.after(() => rmSync(external, {recursive: true, force: true}));
  const directories = ['confirm', 'revoke', 'import'].map(name => path.join(external, name));
  for (const directory of directories) {mkdirSync(directory); writeFileSync(path.join(directory, 'pixel.png'), png());}
  const references = createProjectAssetReferenceServices(f.store, {outsidePaths: f.library.outsidePaths});
  for (const directory of directories.slice(0, 2)) {
    f.library.outsidePaths.confirm({projectId, directory, confirmedAt: '2026-11-03T00:00:00.000Z'});
    const media = await references.referenceForImport(path.join(directory, 'pixel.png'));
    f.store.tx(() => f.store.put('assets', {id: randomUUID(), projectId, name: 'External image', mimeType: 'image/png',
      reference: media.reference, referenceRevision: 1, sha256: media.reference.fullSha256, sizeBytes: media.reference.sizeBytes}));
  }
  const adapter = createAssetMediaHttp({store: f.store, outsidePaths: f.library.outsidePaths,
    assertMutationAllowed: () => f.services.assertMutationAllowed()});
  const failures: unknown[] = [];
  // Bearer/origin boundaries have their own HTTP tests. This loopback listener
  // keeps real request/body/response handling while observing the exact guard error.
  const server = createServer((req, res) => {
    void (async () => {
      try {assert.equal(await adapter.handle(req, res, new URL(req.url!, 'http://127.0.0.1'),
        {kind: 'other', segments: ['asset-media', 'trusted']}), true);}
      catch (error) {failures.push(error); res.writeHead(503, {'content-type': 'application/json'}); res.end('{"rejected":true}');}
    })();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));});
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const trusted = async (operation: string, input: unknown) => {
    const previous = failures.length;
    const response = await fetch(`http://127.0.0.1:${address.port}/asset-media/trusted`, {method: 'POST',
      headers: {'content-type': 'application/json', 'x-mioon-user-action': 'asset-media'}, body: JSON.stringify({operation, input}),
      signal: AbortSignal.timeout(10_000)});
    const body: unknown = await response.json();
    return {status: response.status, body, error: failures.length > previous ? failures.at(-1) : undefined};
  };
  const locations = await trusted('asset.media.location.list', {projectId});
  assert.equal(locations.status, 200); assert.ok(record(locations.body) && record(locations.body.data));
  const entries: unknown = locations.body.data.locations; assert.ok(Array.isArray(entries));
  const locationToken = (directory: string) => {
    const entry: unknown = entries.find((value: unknown) => record(value) && value.directory === directory);
    assert.ok(record(entry) && typeof entry.locationToken === 'string'); return entry.locationToken;
  };
  const confirmToken = locationToken(directories[0]!), revokeToken = locationToken(directories[1]!);
  f.library.outsidePaths.revoke(projectId, directories[0]!);
  const ordinary = [
    {operation: 'asset.media.prepare', input: {projectId, assets: [{assetId, referenceRevision: 1}], purpose: 'timeline'}},
    {operation: 'asset.media.relink.preview', input: {projectId, assetId, sourcePath: candidate, expectedReferenceRevision: 1}},
  ];
  const mutations = [
    {operation: 'asset.import.path', input: {projectId, requestId: randomUUID(), sourcePath: path.join(directories[2]!, 'pixel.png')}},
    {operation: 'asset.media.outside.confirm', input: {projectId, requestId: randomUUID(), locationToken: confirmToken}},
    {operation: 'asset.media.outside.revoke', input: {projectId, requestId: randomUUID(), locationToken: revokeToken}},
  ];
  const databases = (library = f.library) => ({project: {state: readProjectState(f.store.db), marks: changeMarks(f.store.db)},
    application: {state: readProjectState(library.db), marks: changeMarks(library.db)}});
  const snapshot = async (library = f.library) => ({...databases(library), temp: await dataFileSnapshot(f.store.tempDir, [])});
  return {...f, assetId, fullHash: prepared.sha256, ordinary, mutations, trusted, databases, snapshot};
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

test('ordinary media hash and file-only preview writes use application admission without the backup guard', async t => {
  const f = await mediaFixture(t);
  let backupGuardCalls = 0;
  f.ports.backups.assertMutationAllowed = () => {backupGuardCalls++; throw new Error('Legacy backup admission must not own media writes');};
  const prepare = f.ordinary[0]!;
  const response = assetMediaPrepareResponseSchema.parse(await f.services.call(prepare.operation, prepare.input));
  assert.equal(response.assets[0]!.sha256, f.fullHash);
  assert.equal(response.assets[0]!.referenceRevision, 1);
  const preview = f.ordinary[1]!, result = await f.services.call(preview.operation, preview.input);
  assert.ok(record(result) && typeof result.previewToken === 'string' && record(result.chosen));
  assert.equal(result.chosen.matches, true);
  const token: unknown = JSON.parse(readFileSync(path.join(f.store.tempDir, 'asset-media', `${result.previewToken}.json`), 'utf8'));
  assert.ok(record(token)); assert.equal(token.kind, 'relink');
  assert.equal(backupGuardCalls, 0);
});

test('an aborted application owner refuses ordinary and trusted media writes without changing either library or temp files', async t => {
  const f = await mediaFixture(t), before = await f.snapshot(), reason = new Error('application media owner stopped');
  f.owner.abort(reason);
  for (const {operation, input} of f.ordinary) {
    await assert.rejects(f.services.call(operation, input), error => error === reason, operation);
    assert.deepEqual(await f.snapshot(), before, `${operation} has no database or temp-file effect`);
  }
  for (const {operation, input} of f.mutations) {
    const response = await f.trusted(operation, input);
    assert.equal(response.status, 503, operation); assert.equal(response.error, reason, operation);
    assert.deepEqual(await f.snapshot(), before, `${operation} has no database or temp-file effect`);
  }
  // The B1 connection is still live. Reading locations must not ask this
  // stopped application owner for write admission; its display tokens are private.
  const databases = f.databases(), response = await f.trusted('asset.media.location.list', {projectId: f.store.projectId});
  assert.equal(response.status, 200); assert.equal(response.error, undefined);
  assert.ok(record(response.body) && response.body.ok === true);
  assert.deepEqual(f.databases(), databases, 'location observation changes neither project nor application rows or write marks');
});

test('a reopened B1 owner cannot authorize old ordinary or trusted media mutations', async t => {
  const f = await mediaFixture(t);
  f.library.close();
  const replacement = openAppLibrary({dataDir: path.join(f.root, 'app')}); f.libraries.add(replacement);
  assert.doesNotThrow(() => createProjectServiceApplication(replacement).assertMutationAllowed());
  const invalid = {name: 'TypeError', message: 'Project services require a live application library owner'};
  assert.throws(() => f.services.assertMutationAllowed(), invalid);
  const before = await f.snapshot(replacement);
  for (const {operation, input} of f.ordinary) {
    await assert.rejects(f.services.call(operation, input), invalid, operation);
    assert.deepEqual(await f.snapshot(replacement), before, `${operation} cannot borrow the new B1 owner`);
  }
  for (const {operation, input} of f.mutations) {
    const response = await f.trusted(operation, input);
    assert.equal(response.status, 503, operation); assert.ok(response.error instanceof TypeError, operation);
    assert.equal(response.error.message, invalid.message, operation);
    assert.deepEqual(await f.snapshot(replacement), before, `${operation} cannot write either real library or temp files`);
  }
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
  assert.equal(preview.restoreAvailable, true);
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

test('hosted restore, daily, Mio and bulk captures cannot write after application admission is lost', async t => {
  for (const mode of ['aborted', 'replaced'] as const) await t.test(mode, async child => {
    const f = await versionFixture(child), projectId = f.store.projectId;
    const saved = await f.rpc<ProjectVersionSaveResponse>('project.version.save', {projectId, requestId: randomUUID(), name: 'Before guarded restore'});
    const shot = await f.runtime.project.services.call('shot.create', {projectId, title: 'Keep the current edit', requestId: randomUUID()});
    const preview = await f.rpc<ProjectVersionPreviewResponse>('project.version.preview', {projectId, versionId: saved.version.id});
    assert.equal(preview.restoreAvailable, true); assert.ok(preview.totalChanges > 0);
    const journal = createMioProjectJournal(f.store, f.library.agentPolicy);
    const run = journal.create({requestId: randomUUID(), projectId, text: 'A guarded content edit', configuration: mioFixtureConfiguration}).run;
    const before = f.state(), content = f.store.list('shots');
    if (mode === 'aborted') f.owner.abort();
    else {
      f.library.close();
      const replacement = openAppLibrary({dataDir: f.root}); f.libraries.add(replacement);
      assert.doesNotThrow(() => createProjectServiceApplication(replacement).assertMutationAllowed());
    }
    let abortReason: unknown;
    const denied = (error: unknown): boolean => {
      if (mode === 'aborted') {
        assert.ok(error instanceof DOMException); assert.equal(error.name, 'AbortError'); assert.equal(error.message, 'This operation was aborted');
        if (abortReason === undefined) abortReason = error;
        assert.equal(error, abortReason);
      } else {assert.ok(error instanceof TypeError); assert.equal(error.message, 'Project services require a live application library owner');}
      return true;
    };
    await assert.rejects(f.rpc('project.version.restore', {projectId, versionId: saved.version.id, requestId: randomUUID(),
      expectedContentSequence: preview.contentSequence, previewDigest: preview.previewDigest}), denied);
    assert.throws(() => f.runtime.captureDailyVersion(), denied);
    assert.throws(() => f.store.tx(() => saveBeforeBulkChangeInside(f.store, {trigger: 'bulk-change', requestId: randomUUID(),
      assertMutationAllowed: () => f.runtime.project.services.assertMutationAllowed()})), denied);
    assert.throws(() => withTaskEffectOrigin({runId: run.id, stepId: randomUUID(), projectId, requestId: randomUUID(), operation: 'shot.update',
      recorded: false, beforeEffect() {}, recordInside() {assert.fail('A refused write cannot record a task acknowledgement');}}, () => f.store.tx(() => {
        f.store.db.exec('UPDATE main.history_state SET seenContentSequence=seenContentSequence');
        f.store.put('shots', {id: randomUUID(), projectId, title: 'Must not be inserted'});
      })), denied);
    assert.deepEqual(f.state(), before);
    assert.deepEqual(f.store.list('shots'), content); assert.ok(shot);
    assert.deepEqual((await f.rpc<ProjectVersionListResponse>('project.version.list', {projectId})).versions, [saved.version]);
    assert.equal((await f.rpc<ProjectVersionPreviewResponse>('project.version.preview', {projectId, versionId: saved.version.id})).previewDigest, preview.previewDigest);
    assert.deepEqual(f.state(), before);
  });
});

test('hosted restore refuses retained prepared or unknown edit effects without changing their records or content', async t => {
  for (const status of ['unknown', 'prepared'] as const) await t.test(status, async child => {
    const f = await versionFixture(child), projectId = f.store.projectId;
    const saved = await f.rpc<ProjectVersionSaveResponse>('project.version.save', {projectId, requestId: randomUUID()});
    const clean = await f.rpc<ProjectVersionPreviewResponse>('project.version.preview', {projectId, versionId: saved.version.id});
    const admitted = await f.rpc<{versionId: string}>('project.version.restore', {projectId, versionId: saved.version.id, requestId: randomUUID(),
      expectedContentSequence: clean.contentSequence, previewDigest: clean.previewDigest});
    assert.equal(admitted.versionId, saved.version.id, 'the quiet real host admits restoration before any retained effect exists');
    await f.runtime.project.services.call('shot.create', {projectId, title: 'Current content must survive busy restore', requestId: randomUUID()});
    const preview = await f.rpc<ProjectVersionPreviewResponse>('project.version.preview', {projectId, versionId: saved.version.id});
    assert.ok(preview.totalChanges > 0);
    assert.deepEqual(f.runtime.unfinishedTasks!(), []);
    const taskId = randomUUID(), requestId = randomUUID(), input = {projectId, requestId, expectedRevision: 1}, at = '2026-11-03T00:00:00.000Z';
    f.store.tx(() => f.store.db.prepare("INSERT INTO main.edit_tasks(id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,createdAt,updatedAt,bytes) VALUES(?,?,'timeline.undo',?,?,?,'timeline:mutation','new',?,1,0,?,?,16384)")
      .run(taskId, projectId, JSON.stringify(input), requestId, hash({operation: 'timeline.undo', input}), status, at, at));
    assert.ok(f.runtime.unfinishedTasks!().some(task => task.kind === 'edit_task' && task.taskId === taskId));
    const before = f.state(), content = f.store.list('shots'), tasks = f.store.db.prepare('SELECT * FROM main.edit_tasks ORDER BY position').all();
    await assert.rejects(f.rpc('project.version.restore', {projectId, versionId: saved.version.id, requestId: randomUUID(),
      expectedContentSequence: preview.contentSequence, previewDigest: preview.previewDigest}), {code: 'PROJECT_HOST_BUSY', status: 409});
    assert.deepEqual(f.state(), before);
    assert.deepEqual(f.store.list('shots'), content);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM main.edit_tasks ORDER BY position').all(), tasks);
    assert.equal(f.store.db.prepare('SELECT status FROM main.edit_tasks WHERE id=?').get(taskId)!.status, status);
  });
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
