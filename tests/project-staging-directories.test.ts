import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {createProjectFile, openProjectStore} from '../packages/business/src/project-file/index.ts';
import {createImageStorage, type ImageStorageTask} from '../packages/business/src/image-storage.ts';
import {createFrameStorage, type FrameStorageTask} from '../packages/business/src/frame-storage.ts';
import {createSceneShotsStorage} from '../packages/business/src/scene-shots-storage.ts';
import {createTimelineExportAdmissionServices} from '../packages/business/src/timeline-export-admission.ts';
import {renderMockImagePng, validatePng} from '../packages/business/src/images/png.ts';
import {FRAME_PROFILE_ID, FRAME_SELECTION_RULE} from '../packages/contracts/src/frame-extraction.ts';

let pngPromise: Promise<Buffer> | undefined;
const png = () => pngPromise ??= renderMockImagePng();
const check = () => {};

function fixture(t: TestContext, kernel = true) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-staging-directories-'));
  const projectDir = path.join(root, 'project');
  mkdirSync(projectDir, {mode: 0o700});
  let store, projectId: string;
  const tempDir = path.join(root, 'tmp');
  if (kernel) {
    const projectFile = path.join(projectDir, 'project.mioon');
    projectId = createProjectFile(projectFile);
    store = openProjectStore({projectFile, locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir})});
    mkdirSync(path.join(projectDir, 'media'), {mode: 0o700});
  } else {
    store = openStore(projectDir);
    projectId = randomUUID();
  }
  t.after(() => { store.close(); rmSync(root, {recursive: true, force: true}); });
  return {root, projectDir, tempDir, store, projectId, stagingRoot: kernel ? tempDir : projectDir};
}

async function stagedResults(f: ReturnType<typeof fixture>) {
  const bytes = await png();
  const image = createImageStorage(f.store, {validatePng});
  const imageTask: ImageStorageTask = {id: randomUUID(), projectId: f.projectId, groupId: randomUUID(), inputHash: 'a'.repeat(64), input: '{}', snapshot: {providerId: 'mock'}};
  const imageReceipt = await image.stage(imageTask, {bytes}, check);
  const frame = createFrameStorage(f.store, {validatePng});
  const source = {assetId: randomUUID(), sha256: 'b'.repeat(64), mimeType: 'video/mp4', sizeBytes: 100, relativePath: `media/${randomUUID()}.mp4`, duration: 1, width: 1024, height: 1024};
  const frameTask: FrameStorageTask = {id: randomUUID(), projectId: f.projectId, inputHash: 'c'.repeat(64), snapshot: {source, requested: {sourceFrame: 0, fps: 30}}};
  const provenance = {profileId: FRAME_PROFILE_ID, selectionRule: FRAME_SELECTION_RULE, sourceFrame: 0, fps: 30, sourceHash: source.sha256,
    probe: {streamIndex: 0, timeBaseNumerator: 1, timeBaseDenominator: 15360, width: 1024, height: 1024, rotation: 0, sarNumerator: 1, sarDenominator: 1}};
  const frameReceipt = await frame.stage(frameTask, {bytes, provenance}, check);
  const scene = createSceneShotsStorage(f.store), sceneTaskId = randomUUID(), sceneAssetId = randomUUID();
  scene.stage(sceneTaskId, 0, bytes);
  const stagedPaths = [path.join(f.stagingRoot, 'image-staging', `${imageTask.id}.png`), path.join(f.stagingRoot, 'frame-staging', `${frameTask.id}.png`), path.join(f.stagingRoot, 'scene-staging', `${sceneTaskId}-0.png`)];
  const assertStaged = () => {
    for (const file of stagedPaths) assert.deepEqual(readFileSync(file), bytes);
    assert.deepEqual(image.readReceipt(imageTask), imageReceipt);
    assert.deepEqual(frame.readReceipt(frameTask), frameReceipt);
    assert.deepEqual(scene.staged(sceneTaskId, 0), bytes);
  };
  return {bytes, image, imageTask, imageReceipt, frame, frameTask, frameReceipt, scene, sceneTaskId, sceneAssetId, stagedPaths, assertStaged};
}

for (const kernel of [false, true]) test(`${kernel ? 'kernel' : 'legacy'} staging retains its owned directory and publishes only into project media`, async t => {
  const f = fixture(t, kernel), s = await stagedResults(f);
  s.assertStaged();
  const otherRoot = kernel ? f.projectDir : f.tempDir;
  for (const family of ['image-staging', 'frame-staging', 'scene-staging']) assert.equal(existsSync(path.join(otherRoot, family)), false);
  const image = await s.image.publish(s.imageTask, s.imageReceipt, check);
  const frame = await s.frame.publish(s.frameTask, s.frameReceipt, check);
  const scene = s.scene.publish(s.sceneAssetId, s.bytes);
  for (const relativePath of [image.relativePath, frame.relativePath, scene]) {
    assert.match(relativePath, /^media\/[a-f0-9-]+\.png$/);
    assert.deepEqual(readFileSync(path.join(f.projectDir, relativePath)), s.bytes);
    if (kernel) assert.equal(existsSync(path.join(f.tempDir, relativePath)), false);
  }
  s.assertStaged(); // Publication copies bounded bytes; only the committed caller discards staging.
  assert.deepEqual(await s.image.publish(s.imageTask, s.imageReceipt, check), image);
  assert.deepEqual(await s.frame.publish(s.frameTask, s.frameReceipt, check), frame);
  assert.equal(s.scene.publish(s.sceneAssetId, s.bytes), scene);
  s.image.discardStagedPng(s.imageTask, check);
  s.frame.discardStagedPng(s.frameTask, check);
  s.scene.discard(s.sceneTaskId, 1);
  for (const file of s.stagedPaths) assert.equal(existsSync(file), false);
  assert.deepEqual(s.image.readReceipt(s.imageTask), s.imageReceipt);
  assert.deepEqual(s.frame.readReceipt(s.frameTask), s.frameReceipt);
  await s.frame.verify(s.frameTask, s.frameReceipt, check);
  await s.image.publish(s.imageTask, s.imageReceipt, check);
});

test('publication collision preserves all staged PNGs and immutable receipts', async t => {
  const f = fixture(t), s = await stagedResults(f), other = Buffer.from('Existing different media');
  const paths = [s.imageReceipt.assetId, s.frameReceipt.assetId, s.sceneAssetId].map(id => path.join(f.projectDir, 'media', `${id}.png`));
  for (const file of paths) writeFileSync(file, other, {mode: 0o600});
  await assert.rejects(s.image.publish(s.imageTask, s.imageReceipt, check), {code: 'IMAGE_RESULT_INVALID'});
  await assert.rejects(s.frame.publish(s.frameTask, s.frameReceipt, check), {code: 'FRAME_RESULT_INVALID'});
  assert.throws(() => s.scene.publish(s.sceneAssetId, s.bytes), {code: 'SCENE_STORAGE_FAILED'});
  s.assertStaged();
  for (const file of paths) assert.deepEqual(readFileSync(file), other);
});

test('ordinary project directory permissions stay rejected without losing kernel staging', async t => {
  const f = fixture(t), s = await stagedResults(f);
  chmodSync(f.projectDir, 0o755);
  const error = {code: 'STORAGE_PRIVATE_REQUIRED', reason: 'DIRECTORY_PERMISSIONS'};
  await assert.rejects(s.image.publish(s.imageTask, s.imageReceipt, check), error);
  await assert.rejects(s.frame.publish(s.frameTask, s.frameReceipt, check), error);
  assert.throws(() => s.scene.publish(s.sceneAssetId, s.bytes), error);
  s.assertStaged();
  for (const id of [s.imageReceipt.assetId, s.frameReceipt.assetId, s.sceneAssetId]) assert.equal(existsSync(path.join(f.projectDir, 'media', `${id}.png`)), false);
});

test('copied kernel fields cannot redirect staging outside the legacy root', async t => {
  const f = fixture(t), bytes = await png(), copied = {...f.store};
  const image = createImageStorage(copied, {validatePng});
  const task: ImageStorageTask = {id: randomUUID(), projectId: f.projectId, groupId: randomUUID(), inputHash: 'a'.repeat(64), input: '{}', snapshot: {providerId: 'mock'}};
  await image.stage(task, {bytes}, check);
  const scene = createSceneShotsStorage(copied), taskId = randomUUID();
  scene.stage(taskId, 0, bytes);
  assert.deepEqual(readFileSync(path.join(f.projectDir, 'image-staging', `${task.id}.png`)), bytes);
  assert.deepEqual(readFileSync(path.join(f.projectDir, 'scene-staging', `${taskId}-0.png`)), bytes);
  assert.equal(existsSync(path.join(f.tempDir, 'image-staging')), false);
  assert.equal(existsSync(path.join(f.tempDir, 'scene-staging')), false);
});

test('export capability inspection receives kernel tempDir and retains legacy and absent-root defaults', async t => {
  const kernel = fixture(t), legacy = fixture(t, false), observed: (string | undefined)[] = [];
  for (const store of [kernel.store, legacy.store, {db: legacy.store.db}]) {
    const service = createTimelineExportAdmissionServices(store, {inspect: async (_delivery, {capabilityWorkRoot}) => {
      observed.push(capabilityWorkRoot); return {status: 'available', code: 'EXPORT_CAPABILITY_AVAILABLE'};
    }});
    try { assert.deepEqual(await service.inspect({}), {status: 'available', code: 'EXPORT_CAPABILITY_AVAILABLE'}); }
    finally { await service.drain(); }
  }
  const forged = createTimelineExportAdmissionServices({...kernel.store}, {inspect: async () => { throw Error('An unverified kernel wrapper must never inspect'); }});
  try { await assert.rejects(forged.inspect({}), {code: 'RESTORE_STORE_UNVERIFIED'}); }
  finally { await forged.drain(); }
  assert.deepEqual(observed, [kernel.tempDir, legacy.projectDir, undefined]);
});
