import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import type {BinaryLike} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {openStore} from '../packages/business/src/db.ts';
import {createSceneServices} from '../packages/business/src/scene-tasks.ts';
import type {SceneServicesOptions} from '../packages/business/src/scene-tasks.ts';
import type {DecodeSceneKeyframesOptions} from '../packages/business/src/scene-keyframe-decoder.ts';
import {createImageServices} from '../packages/business/src/images.ts';
import type {ImageServicesOptions} from '../packages/business/src/images.ts';
import {createImageEditSourceResolver} from '../packages/business/src/images/edit-source.ts';
import {createOwnedMediaGraphReader} from '../packages/business/src/inspection.ts';
import {IMAGE_FIXED_OPTIONS,IMAGE_MODELS,imageEditSourceSchema} from '../packages/contracts/src/images.ts';
import {imageEditOutputSize,imageEditProfile} from '../packages/contracts/src/image-edit-profiles.ts';
import {IMAGE_SETTINGS_READ_CURRENT,IMAGE_SETTINGS_ASSERT_CURRENT} from '../packages/business/src/images/settings.ts';
import {DEFAULT_IMAGE_CONFIGURATION} from '../packages/contracts/src/image-settings.ts';
import {renderMockImagePng} from '../packages/business/src/images/png.ts';
import {readCurrentWorkspaceRole} from '../packages/business/src/workspace-schema-dispatch.ts';
import {createWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {downgradeReviewedWorkspace} from './helpers/reviewed-schema-layers.ts';
import {CURRENT_ORDINARY_ROLE,CURRENT_ORDINARY_SCHEMA,CURRENT_RESTORED_ROLE,CURRENT_RESTORED_SCHEMA,CURRENT_RESTORE_PROFILE} from './helpers/workspace-schema-current.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

type Rec = Record<string, unknown>;
type Handlers = Record<string, (input: unknown) => Promise<Rec>>;
interface Store {db: DatabaseSync; put(table: string, value: Rec): Rec; get(table: string, id: string): Rec | undefined; close(): void}
const W = 320, H = 180;
const sha = (bytes: BinaryLike) => createHash('sha256').update(bytes).digest('hex');
const still = (index: number) => png({width: W, height: H, rgba: false, tagged: false, pixel: () => [(index * 60) % 256, 120, 200]});
const probe = {streamIndex: 0, timeBaseNumerator: 1, timeBaseDenominator: 15360, width: W, height: H, rotation: 0, sarNumerator: 1, sarDenominator: 1};
let resultPng: ReturnType<typeof renderMockImagePng> | undefined;
const result = () => resultPng ??= renderMockImagePng();
const refused = (code: string) => (error: {code?: string}) => error.code === code;
// The size the image studio picks for a 16:9 keyframe: the source's ratio, long edge 1536.
const editOptions = {...IMAGE_FIXED_OPTIONS, size: imageEditOutputSize(imageEditProfile('openai', IMAGE_MODELS.openai)!, W, H)};
const reviewRows = (db: DatabaseSync) => db.prepare('SELECT rowid AS retainedRowid,* FROM image_reviews ORDER BY rowid').all().map(row => ({...row}));
/** A decoder stand-in: one storyboard keyframe per requested segment. */
function keyframes(input: DecodeSceneKeyframesOptions) {
  input.beforeSpawn!(input.signal!);
  const groups = input.marks!.map((_, index) => [index]);
  groups.forEach((marks, index) => input.onFrame!({index, marks, bytes: still(index)}));
  return {profileId: 'local-png-1024-v1', selectionRule: 'first-pts-at-or-after-v1', sourceHash: (input.asset as {sha256: string}).sha256, width: W, height: H, probe,
    frameOf: groups.flatMap((marks, index) => marks.map(() => index))};
}
async function until<T>(read: () => T | false | Promise<T | false>, label: string): Promise<T> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await pause(10); }
  return assert.fail(`Timed out waiting for ${label}`);
}

function open(root: string) {
  const store = openStore(root) as unknown as Store;
  const scenes = createSceneServices(store as never, {autoRun: true,
    detect: async input => {
      input.beforeSpawn!(input.signal!);
      return {profileId: 'scene-cuts-v1', fps: 30, frameCount: 1800, options: input.options as never, cuts: [{frame: 30, score: 0.4}, {frame: 900, score: 0.41}], segments: [],
        sourceHash: (input.asset as {sha256: string}).sha256, analysis: {width: 256, height: 144, decodedFrames: 1800}};
    },
    decodeKeyframes: async input => keyframes(input) as never} as SceneServicesOptions) as unknown as {handlers: Handlers; drain(): Promise<void>};
  const settings = {
    [IMAGE_SETTINGS_READ_CURRENT]: () => ({revision: 1, configuration: {...DEFAULT_IMAGE_CONFIGURATION, enabled: true}, secret: {configured: true}}),
    [IMAGE_SETTINGS_ASSERT_CURRENT]: (expected: {expectedRevision: number}) => expected.expectedRevision === 1,
  };
  // Results have the requested size, as the real adapters' do.
  const generate = async (input: {options?: {size?: string}}, options: {beforeDispatch: () => void}) => {
    options.beforeDispatch();
    const [width, height] = (input.options?.size ?? '1024x1024').split('x').map(Number);
    return {bytes: await renderMockImagePng({width, height})};
  };
  const images = createImageServices(store as never, {autoRun: true, generate, settings, liveGateway: {generate}} as unknown as ImageServicesOptions) as unknown as {handlers: Handlers; drain(): Promise<void>};
  let closed = false;
  return {store, scenes, images, async close() { if (closed) return; closed = true; try { await scenes.drain(); await images.drain(); } finally { store.close(); } }};
}

async function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mioon-keyframe-edit-')));
  let opened = open(root);
  t.after(async () => { try { await opened.close(); } finally { rmSync(root, {recursive: true, force: true}); } });
  const projectId = opened.store.put('projects', {id: randomUUID(), name: 'Keyframe edits', revision: 1}).id as string;
  const film = Buffer.from(`Synthetic reference film ${randomUUID()}`), videoId = randomUUID(), relativePath = `media/${videoId}.mp4`;
  writeFileSync(path.join(root, relativePath), film, {mode: 0o600});
  const video = opened.store.put('assets', {id: videoId, projectId, name: 'Reference.mp4', mimeType: 'video/mp4', sha256: sha(film), sizeBytes: film.length, relativePath,
    width: W, height: H, duration: 60, provenance: 'user-import'});
  const scene = (operation: string, input: Rec) => opened.scenes.handlers[operation]!(input);
  const settled = (taskId: unknown, label: string) => until(async () => { const value = await scene('scene.task.get', {projectId, taskId}); return value.state === 'succeeded' && value; }, label);
  const f = {
    root, projectId, video,
    get store() { return opened.store; },
    scene,
    image: (operation: string, input: unknown) => opened.images.handlers[operation]!(input),
    /** Detects the film's cuts and builds a two-shot storyboard from segments 1 and 2. */
    async storyboard() {
      const detect = await scene('scene.detect', {projectId, sourceAssetId: videoId, sourceHash: video.sha256, requestId: randomUUID()});
      const resultId = ((await settled(detect.id, 'detection')).result as Rec).id;
      const shots = await scene('scene.shots.create', {projectId, sourceAssetId: videoId, sourceHash: video.sha256, resultId, segments: [1, 2], requestId: randomUUID()});
      const done = await settled(shots.id, 'storyboard');
      return {taskId: shots.id as string, revision: done.revision as number, shots: done.shots as {segment: number; assetId: string}[]};
    },
    asset: (id: string) => opened.store.get('assets', id)!,
    /** A keyframe's captured source frame as the storyboard receipt records it. */
    sourceFrame(taskId: string, assetId: string) {
      const row = opened.store.db.prepare('SELECT stagedReceipt FROM scene_tasks WHERE id=?').get(taskId) as {stagedReceipt: string};
      return (JSON.parse(row.stagedReceipt).keyframes as {assetId: string; sourceFrame: number}[]).find(item => item.assetId === assetId)!.sourceFrame;
    },
    put(name: string, bytes: Buffer, patch: Rec) {
      const id = randomUUID(), file = `media/${id}.png`;
      writeFileSync(path.join(root, file), bytes, {mode: 0o600});
      return opened.store.put('assets', {id, projectId, name, mimeType: 'image/png', sha256: sha(bytes), sizeBytes: bytes.length, relativePath: file, ...patch});
    },
    input: (asset: Rec, patch: Rec = {}) => ({projectId, requestId: randomUUID(), name: 'Keyframe edit', providerId: 'openai', model: IMAGE_MODELS.openai,
      prompt: 'Turn the keyframe into a painted backdrop.', options: editOptions, purpose: 'edit', inputImage: {assetId: asset.id, sha256: asset.sha256}, ...patch}),
    prepare: (input: Rec) => opened.images.handlers['image.review.prepare']!({input, settingsRevision: 1}),
    resolve: (asset: Rec) => createImageEditSourceResolver({db: opened.store.db, root}).verify({projectId, purpose: 'edit', providerId: 'openai', model: IMAGE_MODELS.openai,
      inputImage: {assetId: asset.id, sha256: asset.sha256}}),
    stop: () => opened.close(),
    async reopen() { await opened.close(); opened = open(root); },
  };
  return f;
}

test('a storyboard keyframe is described as a closed scene-keyframe edit source', async t => {
  const f = await fixture(t), {taskId, shots} = await f.storyboard();
  const keyframe = f.asset(shots[1]!.assetId), verified = await f.resolve(keyframe);
  assert.equal(shots[1]!.segment, 2);
  assert.ok(imageEditSourceSchema.safeParse(verified.descriptor).success);
  assert.deepEqual(verified.descriptor, {assetId: keyframe.id, sha256: keyframe.sha256, mimeType: 'image/png', byteLength: keyframe.sizeBytes, width: W, height: H, name: keyframe.name,
    origin: {kind: 'scene-keyframe', sceneKeyframe: {sceneTaskId: taskId, sourceAssetId: f.video.id, sourceHash: f.video.sha256, segment: 2, sourceFrame: f.sourceFrame(taskId, keyframe.id as string)}}});
  assert.deepEqual(verified.bytes, still(1), 'the keyframe bytes are read privately for the edit');
});

test('a keyframe edit is reviewed, run, and its task keeps the keyframe origin', async t => {
  const f = await fixture(t), {shots} = await f.storyboard(), keyframe = f.asset(shots[0]!.assetId);
  const input = f.input(keyframe), review = await f.prepare(input);
  assert.equal((review.sourceImage as {origin: {kind: string}}).origin.kind, 'scene-keyframe');
  const intent = JSON.parse((f.store.db.prepare('SELECT canonicalIntent FROM image_reviews WHERE id=?').get(review.id as string) as {canonicalIntent: string}).canonicalIntent);
  assert.equal(intent.schemaVersion, 5, 'every new edit intent is v5');
  assert.deepEqual(intent.sourceImage, review.sourceImage);
  assert.deepEqual(await f.image('image.review.get', {projectId: f.projectId, reviewId: review.id}), review, 'the stored review reads back exactly');
  assert.deepEqual(await f.prepare(input), review, 'preparing the same request replays the review');
  const ack = await f.image('image.generate', f.input(keyframe, {providerId: 'mock', model: IMAGE_MODELS.mock}));
  assert.deepEqual(ack.sourceImage, review.sourceImage);
  const task = await until(async () => { const value = await f.image('image.task.get', {projectId: f.projectId, taskId: ack.id}); return value.state === 'succeeded' && value; }, 'mock edit');
  assert.deepEqual(task.sourceImage, review.sourceImage);
  // The owned media graph derives the keyframe descriptor again when it reads the finished edit.
  assert.ok(createOwnedMediaGraphReader(f.store.db, f.projectId).imageTask(ack.id as string));
});

test('a keyframe stays an edit source after its storyboard is undone', async t => {
  const f = await fixture(t), {taskId, revision, shots} = await f.storyboard(), keyframe = f.asset(shots[0]!.assetId);
  const undone = await f.scene('scene.shots.undo', {projectId: f.projectId, taskId, expectedRevision: revision, requestId: randomUUID()});
  assert.equal(undone.state, 'undone');
  // Undo removes the shots; the keyframe images stay in the library and keep their storyboard origin.
  const origin = (await f.resolve(keyframe)).descriptor.origin as {kind: string; sceneKeyframe: Rec};
  assert.deepEqual([origin.kind, origin.sceneKeyframe.sceneTaskId, origin.sceneKeyframe.segment], ['scene-keyframe', taskId, 1]);
  assert.equal(((await f.prepare(f.input(keyframe))).sourceImage as {origin: {kind: string}}).origin.kind, 'scene-keyframe');
});

test('an image only labelled as a keyframe, without its storyboard receipt, is refused', async t => {
  const f = await fixture(t), forged = f.put('Forged.png', still(5), {width: W, height: H, provenance: 'scene-keyframe'});
  await assert.rejects(f.resolve(forged), refused('IMAGE_SOURCE_INVALID'));
  await assert.rejects(f.prepare(f.input(forged)), refused('IMAGE_SOURCE_INVALID'));
  assert.equal(reviewRows(f.store.db).length, 0);
});

test('a schema66 workspace refuses keyframe sources, then upgrades keeping its edit reviews', async t => {
  const f = await fixture(t), {shots} = await f.storyboard(), keyframe = f.asset(shots[0]!.assetId);
  // An ordinary edit review of an imported image exists before the upgrade.
  await f.prepare(f.input(f.put('Imported.png', await result(), {width: 1024, height: 1024, provenance: 'user-import'}), {options: IMAGE_FIXED_OPTIONS}));
  const before = reviewRows(f.store.db);
  assert.equal(before.length, 1);
  downgradeReviewedWorkspace(f.store.db, 66);
  assert.equal(readCurrentWorkspaceRole(f.store.db), 'ordinary-66');
  await assert.rejects(f.resolve(keyframe), refused('IMAGE_SOURCE_INVALID'), 'schema66 reviews cannot hold a keyframe source');
  await f.reopen();
  assert.equal(readCurrentWorkspaceRole(f.store.db), CURRENT_ORDINARY_ROLE, 'opening the workspace upgrades it');
  assert.deepEqual(reviewRows(f.store.db), before, 'retained reviews keep their rowids and values');
  assert.equal((await f.resolve(keyframe)).descriptor.origin.kind, 'scene-keyframe');
});

test('keyframe edit reviews survive backup and restore', async t => {
  const f = await fixture(t), {shots} = await f.storyboard(), keyframe = f.asset(shots[0]!.assetId);
  const review = await f.prepare(f.input(keyframe)), before = reviewRows(f.store.db);
  await f.stop();
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'mioon-keyframe-edit-backup-'))), backup = path.join(base, 'backup'), restored = path.join(base, 'restored');
  t.after(() => rmSync(base, {recursive: true, force: true}));
  assert.equal((await createWorkspaceBackup({source: f.root, destination: backup})).databaseSchemaVersion, CURRENT_ORDINARY_SCHEMA);
  const restoreResult = await restoreWorkspaceBackup({directory: backup, destination: restored});
  assert.deepEqual([restoreResult.sourceSchema, restoreResult.databaseSchemaVersion, restoreResult.profile], [CURRENT_ORDINARY_SCHEMA, CURRENT_RESTORED_SCHEMA, CURRENT_RESTORE_PROFILE]);
  const store = openStore(restored) as unknown as Store;
  try {
    assert.equal(readCurrentWorkspaceRole(store.db), CURRENT_RESTORED_ROLE);
    assert.deepEqual(reviewRows(store.db), before, 'every review row is kept as it was');
    const intent = JSON.parse((store.db.prepare('SELECT canonicalIntent FROM image_reviews WHERE id=?').get(review.id as string) as {canonicalIntent: string}).canonicalIntent);
    assert.equal(intent.sourceImage.origin.kind, 'scene-keyframe');
  } finally { store.close(); }
});
