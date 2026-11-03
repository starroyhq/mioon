import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {chmodSync, cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as pause} from 'node:timers/promises';
import {openStore} from '../packages/business/src/project-file/index.ts';
import {testStoreApplicationDirectory, testStoreForConnection} from '../packages/business/src/project-file/test-store.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createImageHistoryReaders} from '../packages/business/src/images/history.ts';
import {createSceneHistoryReaders} from '../packages/business/src/scene-history.ts';
import {createSceneShotsStorage} from '../packages/business/src/scene-shots-storage.ts';
import {resolveProjectMediaFile, projectMediaDirectory} from '../packages/business/src/project-media-storage.ts';
import {validateManagedSource} from '../packages/business/src/managed-media.ts';
import {IMAGE_FIXED_OPTIONS, IMAGE_MODELS} from '../packages/contracts/src/images.ts';
import {sceneDetectionOptionsSchema} from '../packages/contracts/src/scene-tasks.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {collectProject, createProjectFromDocument} from '../packages/business/src/project-package/document.ts';
import {mp4HeaderFixture} from './helpers/media-reference-fixtures.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

function scratch(t: TestContext): string {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-portable-business-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

test('real project notes survive reopening while legacy package imports and workspace backups are refused exactly', async t => {
  const root = scratch(t), store = openStore(root), services = createServices(store, new Map());
  const notes = '真实项目备注\n保留换行和标点。';
  const created = await services.call('project.create', {name: 'Persistent notes'}); assert.ok(object(created));
  await services.call('project.notes.set', {projectId: store.projectId, requestId: randomUUID(), expectedRevision: created.revision, notes});
  const projectId = store.projectId;
  await services.drain(); store.close();
  const reopened = openStore(root), current = createServices(reopened, new Map());
  t.after(async () => {await current.drain(); reopened.close();});
  const project = reopened.get('projects', projectId); assert.ok(object(project)); assert.equal(project.notes, notes);
  const collected = collectProject(reopened, projectId, {media: 'used', includeExports: false});
  assert.equal(collected.document.project.notes, notes);
  const before = reopened.db.prepare('SELECT total_changes() AS n').get()!.n;
  assert.throws(() => createProjectFromDocument(reopened, {document: collected.document, files: new Map(), name: 'Refused copy', move: false}), {
    name: 'TypeError', message: 'Legacy project package imports cannot run on project databases.',
  });
  await assert.rejects(current.call('workspace.backup.create', {requestId: randomUUID()}), {code: 'RESTORE_OPERATION_UNAVAILABLE', status: 409});
  assert.equal(reopened.db.prepare('SELECT total_changes() AS n').get()!.n, before);
  assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM projects').get()!.n, 1);
  assert.deepEqual(reopened.get('projects', projectId), project);
});

test('the exact test opener owns one real B1 application and releases it with its project', async t => {
  const root = scratch(t), store = openStore(root), app = testStoreApplicationDirectory(store);
  assert.ok(app); assert.equal(testStoreApplicationDirectory({...store}), null);
  assert.equal(testStoreForConnection(store.db, store.root), store);
  assert.equal(testStoreForConnection(store.db, `${store.root}/other`), null);
  assert.equal(testStoreForConnection({}, store.root), null);
  const one = createServices(store, new Map(), {env: {}}), two = createServices(store, new Map(), {env: {}});
  assert.equal(one.configuration.root, app); assert.equal(two.configuration.root, app);
  assert.ok(existsSync(path.join(app, 'app-library.db')));
  assert.equal(existsSync(path.join(root, 'workbench.sqlite')), false);
  await assert.rejects(one.call('workspace.backup.create', {requestId: randomUUID()}), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
  await one.drain(); await two.drain(); store.close();
  assert.equal(testStoreForConnection(store.db, root), null);
  const reopened = openAppLibrary({dataDir: app}); reopened.close();
});

test('portable image versions remain readable without a local task or acceptance receipt', async t => {
  const root = scratch(t), original = openStore(path.join(root, 'original')), services = createServices(original, new Map(), {env: {}});
  await services.call('project.create', {name: 'Portable image'});
  const ack = await services.call('image.generate', {projectId: original.projectId, requestId: randomUUID(), name: 'Portable', providerId: 'mock', model: IMAGE_MODELS.mock, prompt: 'Synthetic portable content', options: {...IMAGE_FIXED_OPTIONS}});
  assert.ok(object(ack));
  let task: unknown;
  for (let n = 0; n < 100; n++) {task = await services.call('image.task.get', {projectId: original.projectId, taskId: ack.id}); if (object(task) && task.state === 'succeeded') break; await pause(10);}
  assert.ok(object(task)); assert.equal(task.state, 'succeeded'); assert.equal(typeof task.versionId, 'string');
  const expected = createImageHistoryReaders(original).reader(original.projectId).version(String(task.versionId));
  await services.drain(); original.close();
  cpSync(path.join(root, 'original', 'project.mioon'), path.join(root, 'portable.mioon'));
  mkdirSync(path.join(root, 'received'), {mode: 0o700});
  cpSync(path.join(root, 'portable.mioon'), path.join(root, 'received', 'project.mioon'));
  const moved = openStore(path.join(root, 'received')); t.after(() => moved.close());
  assert.equal(moved.db.prepare('SELECT count(*) AS n FROM image_tasks').get()?.n, 0);
  const reader = createImageHistoryReaders(moved);
  assert.deepEqual(reader.reader(moved.projectId).version(String(task.versionId)), expected);
  assert.equal(reader.group(moved.projectId, String(ack.groupId)).headVersionId, task.versionId);
  assert.throws(() => reader.task(moved.projectId, String(ack.id)), {code: 'IMAGE_NOT_FOUND'});
  assert.equal(moved.db.prepare('SELECT count(*) AS n FROM image_tasks').get()?.n, 0);
});

test('portable detected and manually refined scene results do not require local task or save receipts', async t => {
  const root = scratch(t), store = openStore(path.join(root, 'original'));
  const services = createServices(store, new Map(), {env: {}, sceneOptions: {detect: async input => {
    input.beforeSpawn?.(input.signal!);
    return {profileId: 'scene-cuts-v1', fps: 30, frameCount: 90, options: sceneDetectionOptionsSchema.parse(input.options), cuts: [{frame: 30, score: 0.3}], segments: [],
      sourceHash: String((input.asset as {sha256: string}).sha256), analysis: {width: 256, height: 144, decodedFrames: 90}};
  }}});
  await services.call('project.create', {name: 'Portable cuts'});
  const projectId = store.projectId, assetId = randomUUID(), bytes = mp4HeaderFixture('local synthetic source; detector is explicitly injected');
  const hash = createHash('sha256').update(bytes).digest('hex'), relativePath = `media/${assetId}.mp4`;
  writeFileSync(path.join(store.projectDir, relativePath), bytes, {mode: 0o600});
  store.put('assets', {id: assetId, projectId, name: 'Synthetic.mp4', mimeType: 'video/mp4', sha256: hash, sizeBytes: bytes.length, relativePath, width: 320, height: 180, duration: 3, provenance: 'user-import'});
  const ack = await services.call('scene.detect', {projectId, sourceAssetId: assetId, sourceHash: hash, requestId: randomUUID()}); assert.ok(object(ack));
  let task: unknown;
  for (let n = 0; n < 100; n++) {task = await services.call('scene.task.get', {projectId, taskId: ack.id}); if (object(task) && task.state === 'succeeded') break; await pause(10);}
  assert.ok(object(task)); assert.equal(task.state, 'succeeded'); assert.ok(object(task.result));
  const detected = String(task.result.id);
  const saved = await services.call('scene.cuts.save', {projectId, assetId, sourceHash: hash, expectedResultId: detected, cuts: [], requestId: randomUUID()}); assert.ok(object(saved));
  const expectedDetected = createSceneHistoryReaders(store).result(projectId, detected), expectedManual = createSceneHistoryReaders(store).result(projectId, String(saved.id));
  await services.drain(); store.close();
  mkdirSync(path.join(root, 'received'), {mode: 0o700}); cpSync(path.join(root, 'original', 'project.mioon'), path.join(root, 'received', 'project.mioon'));
  const received = openStore(path.join(root, 'received')); t.after(() => received.close()); const reader = createSceneHistoryReaders(received);
  assert.deepEqual(reader.result(projectId, detected), expectedDetected);
  assert.deepEqual(reader.result(projectId, String(saved.id)), expectedManual);
  assert.equal(received.db.prepare('SELECT count(*) AS n FROM scene_tasks').get()?.n, 0);
  assert.equal(received.db.prepare('SELECT count(*) AS n FROM scene_requests').get()?.n, 0);
});

test('0755 project media writes retain private app roots, link rejection and held database protection', async t => {
  const store = openStore(scratch(t)), services = createServices(store, new Map(), {env: {}});
  t.after(async () => {await services.drain(); store.close();});
  chmodSync(store.projectDir, 0o755);
  store.put('projects',{id:store.projectId,name:'Ordinary project output'});
  const bytes=png(),storage = createSceneShotsStorage(store), id = randomUUID(), relative = storage.publish(id, bytes);
  store.put('assets',{id,projectId:store.projectId,name:'Published.png',mimeType:'image/png',relativePath:relative,sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length,width:16,height:16,provenance:'generated'});
  assert.deepEqual(readFileSync(resolveProjectMediaFile(store, relative).file), bytes);
  assert.equal(validateManagedSource(store.projectDir, store.get('assets',id)!).info.size, bytes.length);
  assert.equal(statSync(store.projectDir).mode & 0o777, 0o755);
  assert.equal(statSync(projectMediaDirectory(store)).mode & 0o777, 0o700);
  assert.equal(statSync(testStoreApplicationDirectory(store)!).mode & 0o777, 0o700);
  assert.throws(() => resolveProjectMediaFile({...store}, relative), TypeError);
  assert.throws(() => resolveProjectMediaFile(store, '../app-library.db'), {reason: 'OUTSIDE_ROOT'});
  const linked = path.join(projectMediaDirectory(store), 'linked.bin'); symlinkSync(resolveProjectMediaFile(store, relative).file, linked);
  assert.throws(() => resolveProjectMediaFile(store, 'media/linked.bin'), {reason: 'SYMBOLIC_LINK'});
  const held = path.join(projectMediaDirectory(store), 'held.db'); renameSync(store.projectFile, held);
  assert.throws(() => resolveProjectMediaFile(store, 'media/held.db'), {reason: 'HELD_DATABASE'});
  renameSync(held, store.projectFile);
  assert.ok(lstatSync(store.projectFile).isFile());
});

test('0755 image publication recovers only from its retained private manifest and busy state spans the attempt', async t => {
  const store = openStore(scratch(t)); let injected = false;
  const services = createServices(store, new Map(), {env: {}, imageOptions: {fault: point => {
    if (!injected && point === 'after_result_receipt') {injected = true; throw Error('synthetic publication interruption');}
  }}});
  t.after(async () => {await services.drain(); store.close();});
  await services.call('project.create', {name: 'Ordinary folder'}); chmodSync(store.projectDir, 0o755);
  assert.equal(services.isBusy(), false);
  const ack = await services.call('image.generate', {projectId: store.projectId, requestId: randomUUID(), name: 'Private manifest', providerId: 'mock', model: IMAGE_MODELS.mock, prompt: 'Local only', options: {...IMAGE_FIXED_OPTIONS}});
  assert.ok(object(ack)); assert.equal(services.isBusy(), true);
  let current: unknown;
  for (let n = 0; n < 200; n++) {current = await services.call('image.task.get', {projectId: store.projectId, taskId: ack.id}); if (object(current) && current.state === 'local_result_error') break; await pause(10);}
  assert.ok(object(current)); assert.equal(current.state, 'local_result_error');
  const manifest = path.join(store.tempDir, 'image-staging', `${ack.id}.json`);
  assert.ok(existsSync(manifest)); assert.ok(existsSync(path.join(store.tempDir, 'image-staging', `${ack.id}.png`)));
  await services.call('image.task.recoverResult', {projectId: store.projectId, taskId: ack.id, expectedRevision: current.revision, requestId: randomUUID()});
  for (let n = 0; n < 200; n++) {current = await services.call('image.task.get', {projectId: store.projectId, taskId: ack.id}); if (object(current) && current.state === 'succeeded') break; await pause(10);}
  assert.ok(object(current)); assert.equal(current.state, 'succeeded'); assert.ok(existsSync(manifest));
  const receipt: unknown = JSON.parse(readFileSync(manifest, 'utf8')); assert.ok(object(receipt));
  assert.ok(resolveProjectMediaFile(store, `media/${receipt.assetId}.png`).info);
  await pause(0); assert.equal(services.isBusy(), false);
});
