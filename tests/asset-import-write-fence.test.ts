import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync, writeFileSync, readdirSync, lstatSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import type {AppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createProviderRegistry} from '../packages/business/src/provider-registry.ts';
import {createManagedAssetImportHandler} from '../packages/business/src/managed-asset-import.ts';
import {createAssetMediaServices} from '../packages/business/src/asset-media-services.ts';
import {registerStoreTransactionObserver} from '../packages/business/src/store-runtime.ts';
import {PROJECT_ASSETS_FOLDER} from '../packages/contracts/src/asset-media.ts';
import {readProjectState, changeMarks} from './helpers/project-state.ts';
import {databaseFiles} from './helpers/data-file-snapshot.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

function fixture(t: TestContext, withProject = true) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-import-write-fence-'));
  const library = openAppLibrary({dataDir: path.join(root, 'application')}), libraries = new Set<AppLibrary>([library]);
  const store = createProjectStore({projectFile: path.join(root, 'Project.mioon'), locate: () => ({
    localDir: path.join(root, 'local'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp'),
  })});
  if (withProject) store.tx(() => store.put('projects', {id: store.projectId, name: 'Import fence', revision: 1}));
  const owner = new AbortController(), ports = createProjectServiceApplication(library, owner.signal, {});
  const source = path.join(root, 'source.png'); writeFileSync(source, png());
  t.after(() => {store.close(); for (const item of libraries) item.close(); rmSync(root, {recursive: true, force: true});});
  let current = library;
  // Exclude the actual SQLite owners and their journals. This proof never opens
  // a held SQLite inode through fs and therefore cannot release its native lock.
  function ordinaryFiles(): Record<string, string> {
    const excluded = new Set([...databaseFiles(store.db), ...databaseFiles(current.db)].flatMap(file => [file, file + '-journal', file + '-wal', file + '-shm']));
    const result: Record<string, string> = {};
    function visit(directory: string) {
      for (const name of readdirSync(directory).sort()) {
        const file = path.join(directory, name), info = lstatSync(file), relative = path.relative(root, file);
        if (info.isDirectory()) {result[relative + '/'] = 'directory'; visit(file);}
        else if (!excluded.has(file)) {assert.ok(info.isFile() && !info.isSymbolicLink()); result[relative] = createHash('sha256').update(readFileSync(file)).digest('hex');}
      }
    }
    visit(root); return result;
  }
  const snapshot = () => ({project: readProjectState(store.db), projectChanges: changeMarks(store.db),
    application: readProjectState(current.db), applicationChanges: changeMarks(current.db), files: ordinaryFiles()});
  return {root, store, library, owner, ports, source, snapshot, reopenApplication() {
    library.close(); current = openAppLibrary({dataDir: library.dataDir}); libraries.add(current); return current;
  }};
}

for (const channel of ['upload', 'trusted-path'] as const) for (const revoke of ['abort', 'reopen'] as const) {
  test(`${channel} rechecks the real application owner after await (${revoke}) before any later effect`, async t => {
    const f = fixture(t), reason = Error('Synthetic application owner revoked'), requestId = randomUUID();
    let armed = false, observedAsync = false, calls = 0, before: ReturnType<typeof f.snapshot> | undefined;
    const beforeEffect = () => {
      calls++;
      if (armed && !observedAsync) {
        observedAsync = true;
        if (revoke === 'abort') f.owner.abort(reason); else f.reopenApplication();
        before = f.snapshot();
      }
      f.ports.assertMutationAllowed();
    };
    const handler = createManagedAssetImportHandler(f.store, {outsidePaths: f.library.outsidePaths, now: () => '2026-11-03T00:00:00.000Z',
      required: (_table, id) => f.store.get('projects', id), beforeEffect});
    const media = createAssetMediaServices(f.store, {outsidePaths: f.library.outsidePaths, beforeEffect});
    // execute runs synchronously to its first await; this microtask can only
    // arm the revocation once that asynchronous boundary has actually yielded.
    queueMicrotask(() => {armed = true;});
    const pending = channel === 'upload' ? handler({projectId: f.store.projectId, requestId, name: 'Image.png', mimeType: 'image/png', dataBase64: png().toString('base64')})
      : media.trustedCall('asset.import.path', {projectId: f.store.projectId, requestId, sourcePath: f.source});
    await assert.rejects(pending, error => revoke === 'abort' ? error === reason : error instanceof TypeError && error.message === 'Project services require a live application library owner');
    assert.equal(observedAsync, true); assert.ok(calls > 1); assert.ok(before);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM assets').get()!.n, 0);
  });
}

function row(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}
function stringField(value: Record<string, unknown>, key: string): string {const result = value[key]; assert.ok(typeof result === 'string'); return result;}
function revision(value: Record<string, unknown>): number {assert.ok(typeof value.revision === 'number'); return value.revision;}
for (const operation of ['generation.submit', 'timeline.render'] as const) for (const revoke of ['abort', 'reopen'] as const) {
  test(`${operation} rechecks application admission after reference preparation (${revoke}) with no later writes`, async t => {
    const f = fixture(t), providers = createProviderRegistry({db: f.store.db, root: f.store.projectDir, env: {}});
    const services = createServices(f.store, providers, {application: f.ports, signal: f.owner.signal, env: {},
      imageOptions: {autoRun: false}, frameOptions: {autoRun: false}, sceneOptions: {autoRun: false}});
    t.after(async () => {await services.drain();});
    const asset = row(await services.call('asset.import', {projectId: f.store.projectId, name: 'Reference.png', mimeType: 'image/png', dataBase64: png({width: 360, height: 640}).toString('base64')}));
    let input: Record<string, unknown>;
    if (operation === 'generation.submit') {
      const shot = row(await services.call('shot.create', {projectId: f.store.projectId, title: 'Queued reference', prompt: '', duration: 2, referenceAssetIds: [stringField(asset, 'id')]}));
      input = {shotId: stringField(shot, 'id'), expectedRevision: revision(shot), requestId: randomUUID(), providerId: 'mock'};
    } else {
      const timeline = row(await services.call('timeline.get', {projectId: f.store.projectId}));
      assert.ok(Array.isArray(timeline.tracks)); const track = row(timeline.tracks[0]);
      const saved = row(await services.call('timeline.clip.add', {projectId: f.store.projectId, expectedRevision: revision(timeline), requestId: randomUUID(),
        assetId: stringField(asset, 'id'), trackId: stringField(track, 'id'), startFrame: 0, durationFrames: 2}));
      input = {projectId: f.store.projectId, expectedRevision: revision(saved), requestId: randomUUID(), purpose: 'export'};
    }
    const reason = Error('Synthetic application revoked during reference preparation');
    let before: ReturnType<typeof f.snapshot> | undefined;
    queueMicrotask(() => {
      if (revoke === 'abort') f.owner.abort(reason); else f.reopenApplication();
      before = f.snapshot();
    });
    await assert.rejects(services.call(operation, input), error => revoke === 'abort' ? error === reason
      : error instanceof TypeError && error.message === 'Project services require a live application library owner');
    assert.ok(before, 'the operation yielded to actual asynchronous reference preparation');
    assert.deepEqual(f.snapshot(), before);
    for (const table of ['jobs', 'exports', 'mock_provider_submissions', 'mock_provider_tasks']) {
      assert.equal(f.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0);
    }
  });
}

for (const revoke of ['abort', 'project-created-at'] as const) test(`a synchronous import transaction observer ${revoke} commits the asset but cannot advance its prepared receipt`, async t => {
  const f = fixture(t), reason = Error('Synthetic import observer owner revoked');
  const receiptRoot = path.join(f.store.tempDir, 'asset-imports');
  const handler = createManagedAssetImportHandler(f.store, {outsidePaths: f.library.outsidePaths, signal: f.owner.signal,
    required: (_table, id) => f.store.get('projects', id), now: () => '2026-11-03T00:00:00.000Z', beforeEffect: () => f.ports.assertMutationAllowed()});
  // Observe only publication data, never any held SQLite inode or the native
  // journals which COMMIT must remove after the observer returns.
  const publicationFiles = () => {
    const result: Record<string, string> = {};
    const visit = (directory: string) => {
      for (const name of readdirSync(directory).sort()) {
        const file = path.join(directory, name), info = lstatSync(file), relative = path.relative(f.root, file);
        if (info.isDirectory()) {result[relative + '/'] = 'directory'; visit(file);}
        else {assert.ok(info.isFile() && !info.isSymbolicLink()); result[relative] = createHash('sha256').update(readFileSync(file)).digest('hex');}
      }
    };
    visit(receiptRoot); visit(path.join(f.store.projectDir, PROJECT_ASSETS_FOLDER)); return result;
  };
  let observed = 0, assetId: string | undefined, receiptFile: string | undefined,
    preparedBytes: Buffer | undefined, filesAtRevocation: Record<string, string> | undefined;
  const appBefore = readProjectState(f.library.db);
  const remove = registerStoreTransactionObserver(f.store.db, result => {
    const asset = row(result);
    if (asset.name !== 'Observer image') return;
    observed++; assetId = stringField(asset, 'id');
    assert.equal(f.store.db.isTransaction, true, 'the actual observer runs before native COMMIT');
    assert.deepEqual(f.store.get('assets', assetId), asset);
    const names = readdirSync(receiptRoot).filter(name => name.endsWith('.json')); assert.equal(names.length, 1);
    receiptFile = path.join(receiptRoot, names[0]!); preparedBytes = readFileSync(receiptFile);
    const receipt = row(JSON.parse(preparedBytes.toString('utf8')));
    assert.equal(receipt.phase, 'prepared'); assert.equal(row(receipt.asset).id, assetId);
    if (revoke === 'abort') f.owner.abort(reason);
    else {
      const project = row(f.store.get('projects', f.store.projectId));
      f.store.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify({...project, createdAt: '2026-11-04T00:00:00.000Z'}), f.store.projectId);
    }
    filesAtRevocation = publicationFiles();
  });
  t.after(remove);
  await assert.rejects(handler({projectId: f.store.projectId, requestId: randomUUID(), name: 'Observer image', mimeType: 'image/png', dataBase64: png().toString('base64')}),
    revoke === 'abort' ? {name: 'AbortError', code: 'OPERATION_CANCELLED', status: 503, message: 'Operation interrupted by shutdown'} : {code: 'INVALID_MEDIA', status: 409});
  assert.equal(observed, 1); assert.equal(f.store.db.isTransaction, false);
  assert.ok(assetId); assert.ok(receiptFile); assert.ok(preparedBytes); assert.ok(filesAtRevocation);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM assets').get()!.n, 1, 'the asset was already committed, so this is not a SQL-zero-write boundary');
  assert.equal(row(f.store.get('assets', assetId)).name, 'Observer image');
  assert.deepEqual(readFileSync(receiptFile), preparedBytes);
  assert.equal(row(JSON.parse(readFileSync(receiptFile, 'utf8'))).phase, 'prepared');
  assert.deepEqual(publicationFiles(), filesAtRevocation, 'no publication/receipt file effect follows synchronous owner revocation');
  assert.deepEqual(readProjectState(f.library.db), appBefore);
});

test('an initial empty kernel project retains NOT_FOUND before any import effect', async t => {
  const f = fixture(t, false), services = createServices(f.store, new Map(), {application: f.ports, env: {},
    imageOptions: {autoRun: false}, frameOptions: {autoRun: false}, sceneOptions: {autoRun: false}});
  t.after(async () => {await services.drain();});
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM projects').get()!.n, 0);
  const before = f.snapshot();
  await assert.rejects(services.call('asset.import', {projectId: f.store.projectId, name: 'Missing project image', mimeType: 'image/png', dataBase64: png().toString('base64')}),
    {code: 'NOT_FOUND', status: 404, details: {id: f.store.projectId}});
  assert.deepEqual(f.snapshot(), before);
});
