import {testEnv} from './helpers/test-env.ts';
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PROJECT_ASSETS_FOLDER} from '../packages/contracts/src/asset-media.ts';
import {projectMediaPath} from '../packages/contracts/src/project-file.ts';
import {ensurePrivateDirectory} from '../packages/contracts/src/private-storage.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createMioProjectMedia} from '../packages/business/src/agent/mio-project-media.ts';
import {createAssetMediaServices} from '../packages/business/src/asset-media-services.ts';
import {createManagedAssetImportHandler} from '../packages/business/src/managed-asset-import.ts';
import {createReferencedAssetProjectImport} from '../packages/business/src/referenced-asset-project-import.ts';
import {run} from '../packages/business/src/media.ts';
import {mediaMtimeMs} from '../packages/business/src/media-reference/fingerprint.ts';
import {registerProjectMediaStore} from '../packages/business/src/project-media-storage.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import {PROJECT_UNPUBLISHED_MEDIA_LIMITS as LIMITS, readProjectUnpublishedMediaSnapshot} from '../packages/business/src/referenced-asset-unpublished.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

const options = {beforeEffect() {}};
const invalid = {code: 'MEDIA_LIST_PATH_INVALID', status: 400, message: '无法安全读取项目素材列表', details: {}};
const changed = {code: 'MEDIA_CHANGED_DURING_READ', status: 409, message: '读取期间项目素材已变化', details: {}};
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-unpublished-'));
  const projectDir = path.join(root, 'project'); mkdirSync(projectDir);
  const store = createProjectStore({projectFile: path.join(projectDir, 'Film.mioon'), locate: () => ({
    localDir: path.join(root, 'local'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp'),
  })});
  store.put('projects', {id: store.projectId, name: 'Publication snapshot', createdAt: '2026-11-03T00:00:00.000Z'});
  const receipts = path.join(store.tempDir, 'asset-imports'), media = path.join(projectDir, PROJECT_ASSETS_FOLDER);
  const receipt = (value: Record<string, unknown>, name = `${randomUUID()}.json`, raw?: string) => {
    ensurePrivateDirectory(receipts, {create: true});
    const file = path.join(receipts, name); writeFileSync(file, raw ?? JSON.stringify(value), {mode: 0o600}); return file;
  };
  const intent = () => ({version: 1, projectId: store.projectId, assetId: randomUUID(), digest: 'a'.repeat(64), attempt: 0, phase: 'intent'});
  const published = (attempt = 1, phase = 'registered') => {
    mkdirSync(media, {recursive: true});
    const value = intent(), file = path.join(media, `${value.assetId}-${attempt}.png`);
    writeFileSync(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const info = lstatSync(file, {bigint: true});
    const asset = {id: value.assetId, projectId: store.projectId, name: 'Image', mimeType: 'image/png', sizeBytes: Number(info.size),
      sha256: null, referenceRevision: 1, reference: {pathForm: 'relative', path: `${PROJECT_ASSETS_FOLDER}/${path.basename(file)}`,
        volume: null, sizeBytes: Number(info.size), mtimeMs: mediaMtimeMs(info), sampledSha256: 'b'.repeat(64), fullSha256: null},
      url: projectMediaPath(store.projectId, value.assetId), provenance: 'user-import'};
    store.put('assets', asset);
    const saved = {...value, phase, attempt, file, asset};
    return {file, asset, value: saved, receipt: receipt(saved)};
  };
  const finalizers: (() => void)[] = [];
  t.after(() => {for (const close of finalizers) close(); store.close(); rmSync(root, {recursive: true, force: true});});
  return {root, store, projectDir, receipts, media, receipt, intent, published, onClose(close: () => void) {finalizers.push(close);}};
}

/** The real import/prepare/relink services and host fence exercise terminal
 * receipts produced by S1, not a hand-built approximation of its record. */
function runtime(f: ReturnType<typeof fixture>) {
  const app = openAppLibrary({dataDir: path.join(f.root, 'application')}), owner = new AbortController();
  const ports = createProjectServiceApplication(app, owner.signal, {});
  const beforeEffect = (): void => {owner.signal.throwIfAborted(); ports.assertMutationAllowed();};
  const release = registerProjectMediaStore(f.store, {outsidePaths: app.outsidePaths});
  f.onClose(() => {owner.abort(); release(); app.close();});
  const importer = createManagedAssetImportHandler(f.store, {outsidePaths: app.outsidePaths, signal: owner.signal, beforeEffect,
    now: () => '2026-11-04T00:00:00.000Z', required: (_table, id) => {const value = f.store.get('projects', id); assert.ok(value); return value;}});
  const services = createAssetMediaServices(f.store, {outsidePaths: app.outsidePaths, signal: owner.signal, beforeEffect});
  const host = createMioProjectMedia({store: f.store, signal: owner.signal, privateDirectories: [app.dataDir, f.store.cacheDir, f.store.tempDir]});
  const totals = () => ({project: f.store.db.prepare('SELECT total_changes() AS n').get()!.n,
    application: app.db.prepare('SELECT total_changes() AS n').get()!.n});
  const list = async (directory: string) => {
    const before = totals();
    const page = await host.list(f.store.projectId, {directory}, {beforeEffect, signal: owner.signal});
    assert.deepEqual(totals(), before, 'listing cannot write either real owner connection'); return page;
  };
  return {list, importer, services, beforeEffect};
}

test('a missing receipt directory is an empty stable read-only view and is never created', async t => {
  const f = fixture(t), changes = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  const before = readdirSync(f.store.tempDir);
  const snapshot = await readProjectUnpublishedMediaSnapshot(f.store, options);
  assert.match(snapshot.version, /^[a-f0-9]{64}$/u); assert.equal(Object.isFrozen(snapshot), true);
  snapshot.assertCurrent();
  assert.equal(snapshot.isExcluded(f.store.projectFile, lstatSync(f.store.projectFile, {bigint: true})), false);
  assert.equal((await readProjectUnpublishedMediaSnapshot(f.store, options)).version, snapshot.version);
  assert.equal(existsSync(f.receipts), false); assert.deepEqual(readdirSync(f.store.tempDir), before);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
  ensurePrivateDirectory(f.receipts, {create: true});
  assert.throws(() => snapshot.assertCurrent(), changed);
});

test('intent without a target and a private staged upload do not block or create exclusions', async t => {
  const f = fixture(t), value = f.intent(), file = f.receipt(value, 'a'.repeat(64) + '.json');
  const stage = path.join(f.receipts, `${value.assetId}.png`); writeFileSync(stage, 'private stage', {mode: 0o600});
  const before = readFileSync(file), stageBefore = readFileSync(stage), sqlBefore = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  const snapshot = await readProjectUnpublishedMediaSnapshot(f.store, options);
  assert.equal(snapshot.isExcluded(stage, lstatSync(stage, {bigint: true})), false);
  assert.deepEqual(readFileSync(file), before); assert.deepEqual(readFileSync(stage), stageBefore);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, sqlBefore);
  writeFileSync(stage, 'changed private stage');
  assert.throws(() => snapshot.assertCurrent(), changed);
});

for (const phase of ['prepared', 'registered']) test(`${phase} preserves its distinct current-versus-historical publication evidence`, async t => {
  const f = fixture(t), publication = f.published(1, phase), before = readFileSync(publication.receipt);
  const snapshot = await readProjectUnpublishedMediaSnapshot(f.store, options);
  assert.equal(snapshot.isExcluded(publication.file, lstatSync(publication.file, {bigint: true})), false);
  assert.deepEqual(readFileSync(publication.receipt), before);
  const second = await readProjectUnpublishedMediaSnapshot(f.store, options); assert.equal(snapshot.version, second.version);
  f.store.put('assets', {...publication.asset, name: 'Edited'});
  if (phase === 'prepared') {
    assert.throws(() => snapshot.assertCurrent(), changed);
    await assert.rejects(readProjectUnpublishedMediaSnapshot(f.store, options), invalid);
  } else {
    snapshot.assertCurrent();
    assert.equal((await readProjectUnpublishedMediaSnapshot(f.store, options)).version, snapshot.version);
  }
});

test('prepared reference-only path receipts do not claim a publication or block ordinary candidates after row removal', async t => {
  const f = fixture(t), publication = f.published(1, 'prepared');
  const value = {...publication.value, attempt: 0}; delete (value as Record<string, unknown>).file;
  f.receipt(value, path.basename(publication.receipt));
  await readProjectUnpublishedMediaSnapshot(f.store, options);
  f.store.db.prepare('DELETE FROM assets WHERE id=?').run(publication.asset.id);
  const view = await readProjectUnpublishedMediaSnapshot(f.store, options);
  assert.equal(view.isExcluded(publication.file, lstatSync(publication.file, {bigint: true})), false);
});

test('a real rolled-back S1 path preparation remains not_applied without poisoning later read-only listing', async t => {
  const f = fixture(t), rt = runtime(f), source = path.join(f.projectDir, 'ordinary.png'), bytes = png();
  writeFileSync(source, bytes);
  const input = {projectId: f.store.projectId, requestId: randomUUID(), sourcePath: source};
  const importer = createReferencedAssetProjectImport(f.store, {importPath: (value, context) => rt.importer(value, context)});
  const proof = await importer.prepare(input, {beforeEffect: rt.beforeEffect});
  const stop = new Error('rollback asset and its task recording');
  await assert.rejects(importer.execute(proof, {beforeEffect: rt.beforeEffect, recordCreatedInside() {throw stop;}}), error => error === stop);
  assert.equal(f.store.list('assets', f.store.projectId).length, 0);
  assert.equal((await importer.lookup(input, {beforeEffect: rt.beforeEffect})).outcome, 'not_applied');
  const saved = readdirSync(f.receipts).filter(name => name.endsWith('.json')).map(name => path.join(f.receipts, name));
  assert.equal(saved.length, 1);
  const receipt = readFileSync(saved[0]!), value = JSON.parse(receipt.toString('utf8')) as Record<string, unknown>;
  assert.equal(value.phase, 'prepared'); assert.equal(value.attempt, 0); assert.equal(Object.hasOwn(value, 'file'), false);
  assert.deepEqual((await rt.list('')).entries.map(entry => entry.name), ['ordinary.png']);
  assert.deepEqual(readFileSync(saved[0]!), receipt); assert.deepEqual(readFileSync(source), bytes);
});

test('missing unpublished attempts pass, but any surviving current or historical target refuses the whole list', async t => {
  const f = fixture(t), value = f.intent(); mkdirSync(f.media);
  const target = path.join(f.media, `${value.assetId}-3.png`);
  const receipt = f.receipt({...value, phase: 'unpublished', attempt: 3, file: target});
  await readProjectUnpublishedMediaSnapshot(f.store, options);
  for (const attempt of [1, 2, 3]) {
    const file = path.join(f.media, `${value.assetId}-${attempt}.png`); writeFileSync(file, 'a user replacement is not proof');
    await assert.rejects(readProjectUnpublishedMediaSnapshot(f.store, options), invalid);
    assert.equal(readFileSync(file, 'utf8'), 'a user replacement is not proof'); unlinkSync(file);
  }
  assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).attempt, 3);
});

test('registered latest attempt does not make a surviving historical attempt safe', async t => {
  const f = fixture(t), publication = f.published(3);
  await readProjectUnpublishedMediaSnapshot(f.store, options);
  const old = path.join(f.media, `${publication.asset.id}-1.png`); writeFileSync(old, 'old partial');
  await assert.rejects(readProjectUnpublishedMediaSnapshot(f.store, options), invalid);
  assert.equal(readFileSync(old, 'utf8'), 'old partial');
  unlinkSync(old); writeFileSync(publication.file, 'changed');
  await readProjectUnpublishedMediaSnapshot(f.store, options);
});

test('real S1 terminal upload remains listable after legal relink changes its current asset row', async t => {
  const f = fixture(t), live = runtime(f), bytes = png();
  const imported = await live.importer({projectId: f.store.projectId, requestId: randomUUID(), name: 'Relink source', mimeType: 'image/png', dataBase64: bytes.toString('base64')}) as {id: string; reference: {path: string}};
  const before = readdirSync(f.receipts).filter(name => name.endsWith('.json')).map(name => readFileSync(path.join(f.receipts, name)));
  assert.equal((await live.list(PROJECT_ASSETS_FOLDER)).entries.length, 1);
  const selected = path.join(f.media, 'same-content.png'); writeFileSync(selected, bytes);
  const preview = await live.services.call('asset.media.relink.preview', {projectId: f.store.projectId, assetId: imported.id,
    expectedReferenceRevision: 1, sourcePath: selected}) as {previewToken: string; chosen: {matches: boolean}};
  assert.equal(preview.chosen.matches, true);
  await live.services.call('asset.media.relink.apply', {projectId: f.store.projectId, requestId: randomUUID(), previewToken: preview.previewToken});
  const current = f.store.get('assets', imported.id) as {referenceRevision: number; reference: {path: string}};
  assert.equal(current.referenceRevision, 2); assert.notEqual(current.reference.path, imported.reference.path);
  assert.equal((await live.list(PROJECT_ASSETS_FOLDER)).entries.length, 2);
  assert.deepEqual(readdirSync(f.receipts).filter(name => name.endsWith('.json')).map(name => readFileSync(path.join(f.receipts, name))), before);
});

test('real video lazy full-hash preparation does not turn its terminal import receipt into a bad receipt', async t => {
  const f = fixture(t), live = runtime(f), directory = path.join(f.projectDir, 'inbox'); mkdirSync(directory);
  const file = path.join(directory, 'clip.mp4');
  await run('ffmpeg', ['-f', 'lavfi', '-i', 'color=c=red:s=32x32:d=0.1', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', file]);
  const imported = await live.importer({projectId: f.store.projectId, requestId: randomUUID(), name: 'Sampled video', sourcePath: file}) as {id: string; sha256: string | null};
  assert.equal(imported.sha256, null); assert.equal((await live.list('inbox')).entries.length, 1);
  const before = readdirSync(f.receipts).filter(name => name.endsWith('.json')).map(name => readFileSync(path.join(f.receipts, name)));
  await live.services.call('asset.media.prepare', {projectId: f.store.projectId, assets: [{assetId: imported.id, referenceRevision: 1}], purpose: 'generation'});
  const current = f.store.get('assets', imported.id) as {sha256: string; referenceRevision: number};
  assert.match(current.sha256, /^[a-f0-9]{64}$/u); assert.equal(current.referenceRevision, 1);
  assert.equal((await live.list('inbox')).entries.length, 1);
  assert.deepEqual(readdirSync(f.receipts).filter(name => name.endsWith('.json')).map(name => readFileSync(path.join(f.receipts, name))), before);
});

test('a completed target with new size and mtime uses ordinary current media admission', async t => {
  const f = fixture(t), live = runtime(f), publication = f.published(), bytes = png({width: 32, height: 24});
  writeFileSync(publication.file, bytes); const future = new Date(Date.now() + 1000); utimesSync(publication.file, future, future);
  const page = await live.list(PROJECT_ASSETS_FOLDER);
  assert.deepEqual(page.entries, [{name: path.basename(publication.file), kind: 'image', mimeType: 'image/png', sizeBytes: bytes.length, durationSeconds: null}]);
  writeFileSync(publication.file, 'no media header');
  assert.deepEqual((await live.list(PROJECT_ASSETS_FOLDER)).entries, [], 'a bad current header is filtered by L1, not treated as an unpublished receipt');
});

test('removing a terminally registered row leaves its original file as an unregistered listing candidate', async t => {
  const f = fixture(t), live = runtime(f), bytes = png();
  const imported = await live.importer({projectId: f.store.projectId, requestId: randomUUID(), name: 'Removed row', mimeType: 'image/png', dataBase64: bytes.toString('base64')}) as {id: string};
  const before = readdirSync(f.receipts).filter(name => name.endsWith('.json')).map(name => readFileSync(path.join(f.receipts, name)));
  f.store.tx(() => f.store.db.prepare('DELETE FROM assets WHERE id=?').run(imported.id));
  assert.equal(f.store.get('assets', imported.id), null);
  const page = await live.list(PROJECT_ASSETS_FOLDER);
  assert.equal(page.entries.length, 1); assert.equal(page.entries[0]!.sizeBytes, bytes.length);
  assert.deepEqual(readdirSync(f.receipts).filter(name => name.endsWith('.json')).map(name => readFileSync(path.join(f.receipts, name))), before);
});

test('unregistered prepared receipts are not treated as complete even when their target is gone', async t => {
  const f = fixture(t), publication = f.published(1, 'prepared');
  f.store.db.prepare('DELETE FROM assets WHERE id=?').run(publication.asset.id); unlinkSync(publication.file);
  await assert.rejects(readProjectUnpublishedMediaSnapshot(f.store, options), invalid);
});

for (const mutation of [
  {version: 2}, {projectId: randomUUID()}, {assetId: '../outside'}, {digest: 'invalid'}, {attempt: 17}, {phase: 'unknown'},
  {surprise: true}, {file: '/private/secret'}, {asset: {}},
]) test(`invalid receipt ${Object.keys(mutation).join(',')} rejects without revealing a private path`, async t => {
  const f = fixture(t); f.receipt({...f.intent(), ...mutation});
  await assert.rejects(readProjectUnpublishedMediaSnapshot(f.store, options), error => {
    assert.ok(error instanceof Error); assert.equal((error as {code?: unknown}).code, invalid.code);
    assert.equal(error.message.includes(f.root), false); assert.deepEqual((error as {details?: unknown}).details, {}); return true;
  });
});

test('a forged publication pathname is refused without using it to find targets', async t => {
  const f = fixture(t), outside = path.join(f.root, 'private.txt'); writeFileSync(outside, 'unchanged');
  f.receipt({...f.intent(), phase: 'unpublished', attempt: 1, file: outside});
  await assert.rejects(readProjectUnpublishedMediaSnapshot(f.store, options), invalid);
  assert.equal(readFileSync(outside, 'utf8'), 'unchanged');
});

test('a committed asset does not make a non-string receipt phase valid', async t => {
  const f = fixture(t), publication = f.published();
  for (const phase of [['registered'], {toString: null}]) {
    f.receipt({...publication.value, phase}, path.basename(publication.receipt));
    await assert.rejects(readProjectUnpublishedMediaSnapshot(f.store, options), invalid);
  }
});

for (const malformed of ['{', '\ufeff{bad}', '[1]', 'null']) test(`malformed receipt ${JSON.stringify(malformed)} refuses the list`, async t => {
  const f = fixture(t); f.receipt({}, undefined, malformed);
  await assert.rejects(readProjectUnpublishedMediaSnapshot(f.store, options), invalid);
});

test('receipt and aggregate byte budgets are checked before unbounded reading', async t => {
  const f = fixture(t), value = f.intent();
  const body = JSON.stringify(value).padEnd(LIMITS.receiptBytes, ' '), file = f.receipt(value, undefined, body);
  await readProjectUnpublishedMediaSnapshot(f.store, options);
  writeFileSync(file, body + ' ');
  await assert.rejects(readProjectUnpublishedMediaSnapshot(f.store, options), invalid);
  unlinkSync(file);
  for (let index = 0; index < LIMITS.totalReceiptBytes / LIMITS.receiptBytes; index++) f.receipt(value, undefined, body);
  await readProjectUnpublishedMediaSnapshot(f.store, options);
  f.receipt(value);
  await assert.rejects(readProjectUnpublishedMediaSnapshot(f.store, options), invalid);
});

test('receipt count and total private-directory entries are both bounded', async t => {
  const f = fixture(t);
  for (let index = 0; index < LIMITS.receipts; index++) f.receipt(f.intent());
  await readProjectUnpublishedMediaSnapshot(f.store, options);
  const extra = f.receipt(f.intent());
  await assert.rejects(readProjectUnpublishedMediaSnapshot(f.store, options), invalid); unlinkSync(extra);
  for (let index = LIMITS.receipts; index < LIMITS.directoryEntries; index++) writeFileSync(path.join(f.receipts, `${randomUUID()}.png`), '', {mode: 0o600});
  await readProjectUnpublishedMediaSnapshot(f.store, options);
  writeFileSync(path.join(f.receipts, `${randomUUID()}.png`), '', {mode: 0o600});
  await assert.rejects(readProjectUnpublishedMediaSnapshot(f.store, options), invalid);
});

for (const kind of ['receipt-symlink', 'stage-symlink', 'directory-symlink', 'unknown-entry', 'public-directory', 'public-receipt'] as const) {
  test(`${kind} cannot bypass the private receipt boundary`, async t => {
    const f = fixture(t), value = f.intent(), file = f.receipt(value);
    if (kind === 'receipt-symlink') {renameSync(file, file + '.original'); symlinkSync(file + '.original', file);}
    if (kind === 'stage-symlink') symlinkSync(f.store.projectFile, path.join(f.receipts, `${value.assetId}.png`));
    if (kind === 'directory-symlink') {renameSync(f.receipts, f.receipts + '-original'); symlinkSync(f.receipts + '-original', f.receipts);}
    if (kind === 'unknown-entry') writeFileSync(path.join(f.receipts, 'unknown.json'), '{}', {mode: 0o600});
    if (kind === 'public-directory') chmodSync(f.receipts, 0o755);
    if (kind === 'public-receipt') chmodSync(file, 0o644);
    await assert.rejects(readProjectUnpublishedMediaSnapshot(f.store, options), invalid);
  });
}

test('snapshot detects receipt replacement, target creation and project-owner changes', async t => {
  const f = fixture(t), value = f.intent(), file = f.receipt(value);
  const first = await readProjectUnpublishedMediaSnapshot(f.store, options);
  const replacement = file + '.replacement'; writeFileSync(replacement, readFileSync(file), {mode: 0o600}); renameSync(replacement, file);
  assert.throws(() => first.assertCurrent(), changed);
  mkdirSync(f.media); const target = path.join(f.media, `${value.assetId}-1.png`);
  f.receipt({...value, phase: 'unpublished', attempt: 1, file: target}, path.basename(file));
  const second = await readProjectUnpublishedMediaSnapshot(f.store, options); writeFileSync(target, 'late partial');
  assert.throws(() => second.assertCurrent(), changed); unlinkSync(target);
  const third = await readProjectUnpublishedMediaSnapshot(f.store, options);
  f.store.put('projects', {id: f.store.projectId, name: 'Different owner data'});
  assert.throws(() => third.assertCurrent(), changed);
});

test('exact live owner and synchronous/asynchronous lifecycle fences are required', async t => {
  const f = fixture(t), reason = new Error('host revoked');
  await assert.rejects(readProjectUnpublishedMediaSnapshot({...f.store}, options), invalid);
  await assert.rejects(readProjectUnpublishedMediaSnapshot(f.store, {beforeEffect() {throw reason;}}), error => error === reason);
  const controller = new AbortController();
  const pending = readProjectUnpublishedMediaSnapshot(f.store, {signal: controller.signal, beforeEffect() {}});
  queueMicrotask(() => controller.abort());
  await assert.rejects(pending, {code: 'OPERATION_CANCELLED'});
  const pendingClose = readProjectUnpublishedMediaSnapshot(f.store, options); queueMicrotask(() => f.store.close());
  await assert.rejects(pendingClose, changed);
});

test('the host fence is retained after async admission and by a returned snapshot', async t => {
  const f = fixture(t), reason = new Error('host capability revoked'); let revoked = false;
  const scoped = {beforeEffect() {if (revoked) throw reason;}};
  const pending = readProjectUnpublishedMediaSnapshot(f.store, scoped); queueMicrotask(() => {revoked = true;});
  await assert.rejects(pending, error => error === reason);
  revoked = false; const snapshot = await readProjectUnpublishedMediaSnapshot(f.store, scoped); revoked = true;
  assert.throws(() => snapshot.assertCurrent(), error => error === reason);
  assert.throws(() => snapshot.isExcluded(f.store.projectFile, lstatSync(f.store.projectFile, {bigint: true})), error => error === reason);
});

test('a receipt changed before admission is read freshly, and later changes invalidate the view', async t => {
  const f = fixture(t), value = f.intent(), file = f.receipt(value);
  const pending = readProjectUnpublishedMediaSnapshot(f.store, options);
  queueMicrotask(() => writeFileSync(file, JSON.stringify({...value, digest: 'c'.repeat(64)})));
  // The initial receipt directory's identity is stable for an in-place write;
  // the actual receipt is admitted only after this yield, giving a fresh view.
  const snapshot = await pending;
  const current = await readProjectUnpublishedMediaSnapshot(f.store, options); assert.equal(snapshot.version, current.version);
  writeFileSync(file, JSON.stringify(value)); assert.throws(() => snapshot.assertCurrent(), changed);
});

test('a receipt changed after admission but before the next async fence invalidates the entire read', async t => {
  const f = fixture(t), value = f.intent(), file = f.receipt(value); let armed = false, scheduled = false;
  const pending = readProjectUnpublishedMediaSnapshot(f.store, {beforeEffect() {
    if (armed && !scheduled) {scheduled = true; queueMicrotask(() => writeFileSync(file, JSON.stringify({...value, digest: 'd'.repeat(64)})));}
  }});
  queueMicrotask(() => {armed = true;});
  await assert.rejects(pending, changed); assert.equal(scheduled, true);
});

function childWrite(file: string): unknown {
  const source = `import {DatabaseSync} from 'node:sqlite'; let db; try { db=new DatabaseSync(process.argv[1],{timeout:0}); db.exec('BEGIN IMMEDIATE; ROLLBACK'); console.log(JSON.stringify({ok:true})); } catch(error) {console.log(JSON.stringify({ok:false,message:error.message,errcode:error.errcode}));} finally {db?.close();}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, file], {env: testEnv(), encoding: 'utf8', timeout: 60_000});
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout.trim()) as unknown;
}
for (const kind of ['project', 'history', 'cache', 'application'] as const) test(`a receipt hard link to held ${kind} is refused without releasing the SQLite lock`, async t => {
  const f = fixture(t), library = openAppLibrary({dataDir: path.join(f.root, 'application')}); t.after(() => library.close());
  ensurePrivateDirectory(f.receipts, {create: true});
  const file = {project: f.store.projectFile, history: path.join(f.store.localDir, 'history.db'),
    cache: path.join(f.store.cacheDir, 'cache.db'), application: library.databaseFile}[kind];
  const target = path.join(f.receipts, randomUUID() + '.json'); linkSync(file, target);
  const locked = {ok: false, message: 'database is locked', errcode: 5};
  assert.deepEqual(childWrite(file), locked);
  await assert.rejects(readProjectUnpublishedMediaSnapshot(f.store, options), invalid);
  assert.deepEqual(childWrite(file), locked, 'no fs descriptor was opened and closed for the held inode');
  assert.equal(existsSync(target), true);
});
