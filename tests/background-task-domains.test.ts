import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {chmodSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {CreateServicesOptions} from '../packages/business/src/services.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';
import {setImageResultListener} from '../packages/business/src/images.ts';
import {createProjectBackgroundState,pauseUnavailableBackgroundTask} from '../packages/business/src/background-task-state.ts';
import {subscribeBackgroundTaskChanges,safeBackgroundTaskIndexError} from '../packages/business/src/background-task-events.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import type {Provider} from '../packages/business/src/provider-registry.ts';
import {IMAGE_FIXED_OPTIONS, IMAGE_MODELS} from '../packages/contracts/src/images.ts';
import {renderMockImagePng} from '../packages/business/src/images/png.ts';
import {mp4HeaderFixture} from './helpers/media-reference-fixtures.ts';
import {run} from '../packages/business/src/media-runtime.ts';
import {setProjectOutputPublicationTestHooks} from '../packages/business/src/project-output-publication.ts';
import {PROJECT_OUTPUT_FOLDERS} from '../packages/contracts/src/project-output-publication.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {beginFixtureToolStep} from './helpers/mio-model-fixture.ts';
import {createProviderRegistry,registerInputProfileWrapper} from '../packages/business/src/provider-registry.ts';

const object = (value: unknown): Record<string, unknown> => {assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;};
async function fixture(t: TestContext, providers: ReadonlyMap<string, Provider> = new Map(), options: CreateServicesOptions = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-background-domains-')); let store = openStore(root);
  let services = createServices(store, providers, {...options, imageOptions: {autoRun: false, ...options.imageOptions}, frameOptions: {autoRun: false, ...options.frameOptions}, sceneOptions: {autoRun: false, ...options.sceneOptions}});
  t.after(async () => {await services.drain(); store.close(); rmSync(root, {recursive: true, force: true});});
  const project = object(await services.call('project.create', {name: 'Background domain receipts'})), projectId = String(project.id);
  const state = () => createProjectBackgroundState(store);
  function asset() {
    const bytes = mp4HeaderFixture('Original source bytes'), id = randomUUID(), relativePath = `media/${id}.mp4`;
    writeFileSync(path.join(root, relativePath), bytes, {mode: 0o600});
    return store.put('assets', {id, projectId, name: 'Source.mp4', mimeType: 'video/mp4', sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length, relativePath, width: 4, height: 2, duration: 1, provenance: 'user-import'});
  }
  return {root, projectId, get store() {return store;}, get services() {return services;}, state, asset,
    async reopenDeferred() {await services.drain(); store.close(); store = openStore(root); services = createServices(store, providers, {deferBackgroundRecovery: true, imageOptions: {autoRun: false}, frameOptions: {autoRun: false}, sceneOptions: {autoRun: false}});},
  };
}

test('actual image, frame, scene and edit acceptance/terminal changes reach one state with the original receipts', async t => {
  const f = await fixture(t), source = f.asset(), seen: string[] = [], unsubscribe = f.state().subscribe(tasks => seen.push(...tasks.map(task => task.kind)));
  t.after(unsubscribe);
  const imageInput = {projectId: f.projectId, name: 'Draft image', providerId: 'mock', model: IMAGE_MODELS.mock, prompt: 'Synthetic', options: {...IMAGE_FIXED_OPTIONS}, requestId: randomUUID()};
  const image = object(await f.services.call('image.generate', imageInput));
  const frameInput = {projectId: f.projectId, sourceAssetId: source.id, sourceHash: source.sha256, sourceFrame: 0, requestId: randomUUID()};
  const frame = object(await f.services.call('frame.extract', frameInput));
  const sceneInput = {projectId: f.projectId, sourceAssetId: source.id, sourceHash: source.sha256, requestId: randomUUID()};
  const scene = object(await f.services.call('scene.detect', sceneInput));
  const timeline = object(await f.services.call('timeline.get', {projectId: f.projectId})), edits = createEditTasks({store: f.store, services: f.services});
  const edit = object(edits.prepare({projectId: f.projectId, operation: 'timeline.track.add', origin: 'new',
    input: {projectId: f.projectId, expectedRevision: timeline.revision, kind: 'video', name: 'Video', requestId: randomUUID()}}));
  const editTask = object(edit.task);
  for (const [kind, id, keepAlive] of [['image_task', image.id, true], ['frame_task', frame.id, true], ['scene_task', scene.id, true], ['edit_task', editTask.id, false]] as const) {
    const projected = f.state().snapshot().find(task => task.kind === kind && task.taskId === id);
    assert.ok(projected); assert.equal(projected.keepAlive, keepAlive); assert.ok(seen.includes(kind));
  }
  assert.equal(f.services.isBusy(), true);
  for (const [operation, value] of [['image.task.cancelQueued', image], ['frame.task.cancelQueued', frame], ['scene.task.cancel', scene]] as const)
    await f.services.call(operation, {projectId: f.projectId, taskId: value.id, expectedRevision: value.revision, requestId: randomUUID()});
  assert.equal(f.services.isBusy(), false, 'only a prepared edit remains, with no active continuation');
  assert.equal(f.state().snapshot().find(task => task.taskId === editTask.id)!.classification, 'waiting_user');
  assert.deepEqual(await f.services.call('image.generate', imageInput), image);
  assert.deepEqual(await f.services.call('frame.extract', frameInput), frame);
  assert.deepEqual(await f.services.call('scene.detect', sceneInput), scene);
  await edits.drain();
});

test('deferred construction performs no task recovery write; explicit activation runs it once and survives service drain snapshots', async t => {
  const f = await fixture(t), source = f.asset();
  const image = object(await f.services.call('image.generate', {projectId: f.projectId, name: 'Deferred', providerId: 'mock', model: IMAGE_MODELS.mock, prompt: 'Synthetic', options: {...IMAGE_FIXED_OPTIONS}, requestId: randomUUID()}));
  const frame = object(await f.services.call('frame.extract', {projectId: f.projectId, sourceAssetId: source.id, sourceHash: source.sha256, sourceFrame: 0, requestId: randomUUID()}));
  const scene = object(await f.services.call('scene.detect', {projectId: f.projectId, sourceAssetId: source.id, sourceHash: source.sha256, requestId: randomUUID()}));
  await f.reopenDeferred();
  assert.equal(f.store.db.prepare('SELECT state FROM image_tasks WHERE id=?').get(String(image.id))!.state, 'queued');
  assert.equal(f.store.db.prepare('SELECT state FROM frame_tasks WHERE id=?').get(String(frame.id))!.state, 'queued');
  assert.equal(f.store.db.prepare('SELECT state FROM scene_tasks WHERE id=?').get(String(scene.id))!.state, 'queued');
  const before = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  assert.equal(f.state().snapshot().find(task => task.taskId === image.id)!.keepAlive, true);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, before);
  f.services.activateBackground();
  assert.equal(f.store.db.prepare('SELECT state FROM image_tasks WHERE id=?').get(String(image.id))!.state, 'interrupted_before_dispatch');
  assert.equal(f.store.db.prepare('SELECT state FROM frame_tasks WHERE id=?').get(String(frame.id))!.state, 'interrupted');
  assert.equal(f.store.db.prepare('SELECT state FROM scene_tasks WHERE id=?').get(String(scene.id))!.state, 'interrupted');
  assert.equal(f.state().snapshot().find(task => task.taskId === image.id)!.keepAlive, false);
  assert.equal(f.state().snapshot().find(task => task.taskId === frame.id)!.keepAlive, false);
  assert.equal(f.state().snapshot().find(task => task.taskId === scene.id)!.keepAlive, false);
  const activated = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  f.services.activateBackground();
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, activated);
  await f.services.drain();
  assert.equal(f.state().snapshot().find(task => task.taskId === image.id)!.classification, 'waiting_user');
});

for (const kind of ['frame', 'scene'] as const) test(`a ${kind} source disappearing after its durable acceptance pauses without decoder execution or failed state`, async t => {
  let sourcePath = '', decoders = 0;
  const fault = (point: string) => {if (point === 'after_acceptance') rmSync(sourcePath);};
  const f = await fixture(t, new Map(), kind === 'frame' ? {frameOptions: {autoRun: true, fault, decode: async () => {decoders++; throw Error('must not decode');}}}
    : {sceneOptions: {autoRun: true, fault, detect: async () => {decoders++; throw Error('must not decode');}}});
  const source = f.asset(); sourcePath = path.join(f.root, 'media', source.id + '.mp4');
  const input = {projectId: f.projectId, sourceAssetId: source.id, sourceHash: source.sha256, ...(kind === 'frame' ? {sourceFrame: 0} : {}), requestId: randomUUID()};
  const task = object(await f.services.call(kind === 'frame' ? 'frame.extract' : 'scene.detect', input));
  for (let attempt = 0; attempt < 100 && f.state().snapshot().find(item => item.taskId === task.id)?.reason !== 'SOURCE_UNAVAILABLE'; attempt++) await pause(5);
  const projected = f.state().snapshot().find(item => item.taskId === task.id)!;
  assert.equal(projected.reason, 'SOURCE_UNAVAILABLE'); assert.equal(projected.keepAlive, false); assert.equal(decoders, 0);
  assert.equal(f.store.db.prepare(`SELECT state FROM ${kind === 'frame' ? 'frame_tasks' : 'scene_tasks'} WHERE id=?`).get(String(task.id))!.state, 'queued');
  const receipt = object(await f.services.call(kind === 'frame' ? 'frame.request.get' : 'scene.request.get', {projectId: f.projectId, requestId: input.requestId}));
  assert.deepEqual(receipt.response, task); assert.equal(f.store.list('assets').length, 1);
  assert.equal(f.services.isBusy(), false);
});

test('an active subject batch derives its child image work and becomes quiet after cancelled children', async t => {
  const f = await fixture(t), bytes = await renderMockImagePng({width: 768, height: 1024}), id = randomUUID(), relativePath = `media/${id}.png`;
  writeFileSync(path.join(f.root, relativePath), bytes, {mode: 0o600});
  f.store.put('assets', {id, projectId: f.projectId, name: 'Actor.png', mimeType: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex'), width: 768, height: 1024, sizeBytes: bytes.length, relativePath, provenance: 'user-import'});
  const subject = object(await f.services.call('subject.create', {projectId: f.projectId, kind: 'character', name: 'Actor', assetId: id, requestId: randomUUID()}));
  const batch = object(await f.services.call('subject.variants.create', {projectId: f.projectId, subjectId: subject.id, sourceVersionId: subject.headVersionId, kind: 'angle',
    items: [{kind: 'angle', position: 'front-left', focal: 'standard'}], providerId: 'mock', model: IMAGE_MODELS.mock, requestId: randomUUID()}));
  assert.equal(f.state().snapshot().find(task => task.taskId === batch.id)!.classification, 'waiting_user');
  const item = object((batch.items as unknown[])[0]), image = object(await f.services.call('image.generate', item.imageInput));
  assert.equal(f.state().snapshot().find(task => task.taskId === batch.id)!.keepAlive, true);
  const beforePause = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  assert.equal(pauseUnavailableBackgroundTask(f.store.db, {kind: 'image_task', taskId: String(image.id)}, {code: 'MEDIA_MISSING'}), true);
  assert.equal(f.state().snapshot().find(task => task.taskId === batch.id)!.keepAlive, false);
  assert.equal(f.state().snapshot().find(task => task.taskId === batch.id)!.reason, 'SOURCE_UNAVAILABLE');
  f.state().refresh(); assert.equal(f.state().snapshot().find(task => task.taskId === batch.id)!.keepAlive, false);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, beforePause);
  await f.services.call('image.task.cancelQueued', {projectId: f.projectId, taskId: image.id, expectedRevision: image.revision, requestId: randomUUID()});
  assert.equal(f.state().snapshot().find(task => task.taskId === batch.id)!.classification, 'terminal');
  assert.equal(f.services.isBusy(), false);
  assert.equal(f.store.db.prepare('SELECT state FROM subject_variant_batches WHERE id=?').get(String(batch.id))!.state, 'active', 'business batch history is not rewritten to manufacture terminal');
});

test('an already succeeded image with a refused startup subject link remains pending without holding the project forever', async t => {
  const f = await fixture(t, new Map(), {imageOptions: {autoRun: true}}), bytes = await renderMockImagePng({width: 768, height: 1024}), id = randomUUID(), relativePath = `media/${id}.png`;
  writeFileSync(path.join(f.root, relativePath), bytes, {mode: 0o600});
  f.store.put('assets', {id, projectId: f.projectId, name: 'Actor.png', mimeType: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex'), width: 768, height: 1024, sizeBytes: bytes.length, relativePath, provenance: 'user-import'});
  const subject = object(await f.services.call('subject.create', {projectId: f.projectId, kind: 'character', name: 'Actor', assetId: id, requestId: randomUUID()}));
  const batch = object(await f.services.call('subject.variants.create', {projectId: f.projectId, subjectId: subject.id, sourceVersionId: subject.headVersionId, kind: 'angle',
    items: [{kind: 'angle', position: 'front-left', focal: 'standard'}], providerId: 'mock', model: IMAGE_MODELS.mock, requestId: randomUUID()}));
  // Simulate the documented historical case: image publication ran while its
  // subject result listener was not registered. Keep the real image receipt.
  const removeListener = setImageResultListener(f.store.db, () => {});
  const item = object((batch.items as unknown[])[0]), image = object(await f.services.call('image.generate', item.imageInput));
  for (let attempt = 0; attempt < 1000 && f.store.db.prepare('SELECT state FROM image_tasks WHERE id=?').get(String(image.id))!.state !== 'succeeded'; attempt++) await pause(10);
  assert.equal(f.store.db.prepare('SELECT state FROM image_tasks WHERE id=?').get(String(image.id))!.state, 'succeeded');
  assert.equal(f.store.db.prepare('SELECT versionId FROM subject_variant_items WHERE batchId=?').get(String(batch.id))!.versionId, null);
  removeListener(); await f.reopenDeferred();
  // A concrete failed link must not create an imaginary automatic executor.
  f.store.db.exec("CREATE TRIGGER project.injected_subject_link_failure BEFORE INSERT ON subject_versions BEGIN SELECT RAISE(ABORT,'Injected link refusal'); END;");
  try {f.services.activateBackground();} finally {f.store.db.exec('DROP TRIGGER project.injected_subject_link_failure');}
  const pending = f.state().snapshot().find(task => task.taskId === batch.id)!;
  assert.equal(pending.classification, 'result_pending'); assert.equal(pending.reason, 'SUBJECT_VARIANT_LINK_PENDING'); assert.equal(pending.keepAlive, false);
  assert.equal(f.services.isBusy(), false);
  const changes = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  f.state().refresh(); f.services.activateBackground();
  assert.equal(f.services.isBusy(), false); assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
  assert.equal(f.store.db.prepare('SELECT versionId FROM subject_variant_items WHERE batchId=?').get(String(batch.id))!.versionId, null);
  assert.equal(f.store.db.prepare('SELECT state FROM image_tasks WHERE id=?').get(String(image.id))!.state, 'succeeded');
  const receipt = object(await f.services.call('image.request.get', {projectId: f.projectId, requestId: object(item.imageInput).requestId}));
  assert.deepEqual(receipt.response, image);
});

test('a project lost during an accepted provider download pauses the original job without another submit', async t => {
  const calls = {submit: 0, poll: 0, download: 0}; let move: (() => void) | undefined;
  const provider: Provider = {id: 'ark', capabilities: {models: ['fixture'], inputModes: ['text'], aspectRatios: ['9:16'], durations: [4], configured: true, enabled: true},
    submit: async () => {calls.submit++; return {providerJobId: 'accepted-before-loss'};}, reconcile: async () => null,
    poll: async () => {calls.poll++; return {status: 'succeeded'};}, download: async () => {calls.download++; move!(); throw Object.assign(Error('project removed'), {code: 'ENOENT'});}};
  const providers = new Map([['ark', provider]]), f = await fixture(t, providers);
  const shot = object(await f.services.call('shot.create', {projectId: f.projectId, title: 'Frozen', prompt: 'Synthetic', duration: 4}));
  const job = object(await f.services.call('generation.submit', {shotId: shot.id, expectedRevision: shot.revision, providerId: 'ark', requestId: randomUUID()}));
  const originalFile = f.store.projectFile; move = () => renameSync(originalFile, originalFile + '.moved');
  const worker = startWorker(f.store, f.services, providers);
  try {
    await worker.tick(); await worker.tick();
    for (let attempt = 0; attempt < 20 && calls.download === 0; attempt++) {await pause(5); await worker.tick();}
    const stored = object(f.store.get('jobs', String(job.id)));
    assert.equal(stored.status, 'downloading'); assert.equal(stored.requestId, job.requestId); assert.equal(stored.submissionCount, 1);
    assert.deepEqual(calls, {submit: 1, poll: 1, download: 1});
    assert.equal(f.state().snapshot().find(task => task.taskId === job.id)!.keepAlive, false);
    assert.equal(f.state().snapshot().find(task => task.taskId === job.id)!.reason, 'PROJECT_MISSING');
    await worker.tick(); assert.deepEqual(calls, {submit: 1, poll: 1, download: 1});
    assert.equal(f.store.list('assets').length, 0); assert.equal(f.store.list('versions').length, 0);
  } finally {await worker.stop(); renameSync(originalFile + '.moved', originalFile);}
});

for (const kind of ['image', 'frame', 'scene', 'edit'] as const) test(`${kind} acceptance preserves its committed row and original receipt when the app index reports an unknown outcome`, async t => {
  const f = await fixture(t), source = f.asset(); f.state();
  const input = kind === 'image' ? {projectId: f.projectId, name: 'Index uncertain', providerId: 'mock', model: IMAGE_MODELS.mock, prompt: 'Synthetic', options: {...IMAGE_FIXED_OPTIONS}, requestId: randomUUID()}
    : kind === 'edit' ? {projectId: f.projectId, operation: 'timeline.track.add', origin: 'new', input: {projectId: f.projectId, expectedRevision: object(await f.services.call('timeline.get', {projectId: f.projectId})).revision, kind: 'video', name: 'Video', requestId: randomUUID()}}
      : {projectId: f.projectId, sourceAssetId: source.id, sourceHash: source.sha256, ...(kind === 'frame' ? {sourceFrame: 0} : {}), requestId: randomUUID()};
  const edits = kind === 'edit' ? createEditTasks({store: f.store, services: f.services}) : null;
  const invoke = () => edits ? edits.prepare(input) : f.services.call(kind === 'image' ? 'image.generate' : kind === 'frame' ? 'frame.extract' : 'scene.detect', input);
  const unsubscribe = subscribeBackgroundTaskChanges(f.store.db, () => {throw Error('Synthetic app-index failure after real COMMIT');});
  try {
    await assert.rejects(Promise.resolve().then(invoke), error => {
      const safe = safeBackgroundTaskIndexError(error); assert.ok(safe);
      assert.equal(safe.code, 'BACKGROUND_TASK_INDEX_UNCERTAIN'); assert.equal(safe.status, 503);
      assert.deepEqual(safe.details, {mutationOutcome: 'unknown', projectId: f.projectId});
      assert.equal(safe.message.includes('Synthetic'), false); return true;
    });
  } finally {unsubscribe();}
  const table = kind === 'edit' ? 'edit_tasks' : `${kind}_tasks`;
  const row = f.store.db.prepare(`SELECT * FROM ${table}`).get()!;
  assert.equal(f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 1);
  assert.equal(kind === 'edit' ? row.status : row.state, kind === 'edit' ? 'prepared' : 'queued');
  assert.equal(row.errorCode, null);
  assert.equal(f.state().snapshot().find(task => task.taskId === row.id)!.reason, 'BACKGROUND_TASK_INDEX_UNCERTAIN');
  assert.equal(f.services.isBusy(), false, 'a committed row without a queued executor cannot hold a continuation lease');
  const replay = object(await invoke()), replayTask = kind === 'edit' ? object(replay.task) : replay;
  assert.equal(replayTask.id, row.id);
  if (kind !== 'edit') {
    const receipt = f.store.db.prepare(`SELECT response FROM ${kind}_requests WHERE requestId=?`).get(String(object(input).requestId))!;
    assert.deepEqual(JSON.parse(String(receipt.response)), replay);
  }
  assert.equal(f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 1);
  await edits?.drain();
});

test('an image dispatch-fence COMMIT whose index fails never changes the accepted task to failed or repeats dispatch', async t => {
  let dispatched = 0;
  const f = await fixture(t, new Map(), {imageOptions: {autoRun: true, generate: async (_snapshot, context) => {
    assert.equal(typeof context.beforeDispatch, 'function'); (context.beforeDispatch as () => void)(); dispatched++; throw Error('must not cross uncertain fence');
  }}}); f.state();
  let indexFailed = false;
  const unsubscribe = subscribeBackgroundTaskChanges(f.store.db, refs => {
    for (const ref of refs) if (ref.kind === 'image_task' && f.store.db.prepare('SELECT state FROM image_tasks WHERE id=?').get(ref.taskId)?.state === 'dispatching') {
      indexFailed = true; throw Error('Synthetic app-index dispatch failure');
    }
  }); t.after(unsubscribe);
  const input = {projectId: f.projectId, name: 'Index fence', providerId: 'mock', model: IMAGE_MODELS.mock, prompt: 'Synthetic', options: {...IMAGE_FIXED_OPTIONS}, requestId: randomUUID()};
  const accepted = object(await f.services.call('image.generate', input));
  for (let attempt = 0; attempt < 100 && !indexFailed; attempt++) await pause(5);
  assert.equal(indexFailed, true); await pause(10);
  const row = f.store.db.prepare('SELECT state,errorCode,dispatched FROM image_tasks WHERE id=?').get(String(accepted.id))!;
  assert.deepEqual({...row}, {state: 'dispatching', errorCode: null, dispatched: 1}); assert.equal(dispatched, 0);
  assert.equal(f.state().snapshot().find(task => task.taskId === accepted.id)!.reason, 'BACKGROUND_TASK_INDEX_UNCERTAIN');
  assert.equal(f.services.isBusy(), false);
  assert.deepEqual(await f.services.call('image.generate', input), accepted); assert.equal(dispatched, 0);
  assert.equal(f.store.list('assets').length, 0);
});

test('a committed provider receipt survives app-index failure without failed rewrite or another submit', async t => {
  const calls = {submit: 0, poll: 0};
  const provider: Provider = {id: 'ark', capabilities: {models: ['fixture'], inputModes: ['text'], aspectRatios: ['9:16'], durations: [4], configured: true, enabled: true},
    submit: async () => {calls.submit++; return {providerJobId: 'accepted-once'};}, reconcile: async () => null,
    poll: async () => {calls.poll++; return {status: 'running'};}, download: async () => {throw Error('must not download');}};
  const providers = new Map([['ark', provider]]), f = await fixture(t, providers);
  const shot = object(await f.services.call('shot.create', {projectId: f.projectId, title: 'Index receipt', prompt: 'Synthetic', duration: 4}));
  const input = {shotId: shot.id, expectedRevision: shot.revision, providerId: 'ark', requestId: randomUUID()};
  const job = object(await f.services.call('generation.submit', input)); f.state();
  let failures = 0;
  const unsubscribe = subscribeBackgroundTaskChanges(f.store.db, refs => {
    if (refs.some(ref => ref.kind === 'job' && object(f.store.get('jobs', ref.taskId)).providerJobId === 'accepted-once')) {failures++; throw Error('Synthetic receipt-index failure');}
  });
  const worker = startWorker(f.store, f.services, providers);
  try {
    await worker.tick(); const committed = object(f.store.get('jobs', String(job.id)));
    assert.equal(failures, 1); assert.equal(committed.status, 'running'); assert.equal(committed.providerJobId, 'accepted-once');
    assert.equal(committed.error, null); assert.equal(committed.submissionCount, 1); assert.equal(calls.submit, 1);
    assert.equal(f.state().snapshot().find(task => task.taskId === job.id)!.reason, 'BACKGROUND_TASK_INDEX_UNCERTAIN'); assert.equal(f.services.isBusy(), false);
    assert.equal(object(await f.services.call('generation.submit', input)).id, job.id);
    await worker.tick(); assert.equal(calls.submit, 1);
    assert.equal(object(f.store.get('jobs', String(job.id))).status, 'running');
    assert.equal(f.store.list('versions').length, 0);
  } finally {unsubscribe(); await worker.stop();}
});

test('an uncertain committed job claim has no surviving executor and cannot auto-submit', async t => {
  let submits = 0;
  const provider: Provider = {id: 'ark', capabilities: {models: ['fixture'], inputModes: ['text'], aspectRatios: ['9:16'], durations: [4], configured: true, enabled: true},
    submit: async () => {submits++; return {providerJobId: 'must-not-submit'};}, reconcile: async () => null,
    poll: async () => {throw Error('must not poll');}, download: async () => {throw Error('must not download');}};
  const providers = new Map([['ark', provider]]), f = await fixture(t, providers);
  const shot = object(await f.services.call('shot.create', {projectId: f.projectId, title: 'Uncertain claim', prompt: 'Synthetic', duration: 4}));
  const job = object(await f.services.call('generation.submit', {shotId: shot.id, expectedRevision: shot.revision, providerId: 'ark', requestId: randomUUID()}));
  const unsubscribe = subscribeBackgroundTaskChanges(f.store.db, refs => {
    if (refs.some(ref => ref.kind === 'job' && object(f.store.get('jobs', ref.taskId)).status === 'submitting')) throw Error('Synthetic claim-index failure');
  });
  const worker = startWorker(f.store, f.services, providers);
  try {
    await worker.tick(); const original = object(f.store.get('jobs', String(job.id)));
    assert.equal(original.status, 'submitting'); assert.equal(original.submissionCount, 1); assert.equal(original.providerJobId, null);
    assert.equal(f.state().snapshot().find(task => task.taskId === job.id)!.keepAlive, false);
    assert.equal(f.state().snapshot().find(task => task.taskId === job.id)!.reason, 'BACKGROUND_TASK_INDEX_UNCERTAIN');
    assert.equal(f.services.isBusy(), false); await worker.tick(); assert.equal(submits, 0);
    assert.deepEqual(f.store.get('jobs', String(job.id)), original);
  } finally {unsubscribe(); await worker.stop();}
});

test('a missing frozen export source pauses the real worker without failed rewrite or receipt changes', async t => {
  const f = await fixture(t), source = f.asset();
  let timeline = object(await f.services.call('timeline.get', {projectId: f.projectId}));
  timeline = object(await f.services.call('timeline.clip.add', {projectId: f.projectId, expectedRevision: timeline.revision, requestId: randomUUID(), assetId: source.id,
    trackId: object((timeline.tracks as unknown[])[0]).id, startFrame: 0, durationFrames: 6}));
  const input = {projectId: f.projectId, expectedRevision: timeline.revision, requestId: randomUUID(), purpose: 'export'};
  const accepted = object(await f.services.call('timeline.render', input));
  const storedBeforeLoss = object(f.store.get('exports', String(accepted.id)));
  const receipt = f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId);
  rmSync(path.join(f.root, 'media', source.id + '.mp4'));
  const worker = startWorker(f.store, f.services, new Map());
  try {
    await worker.tick(); const original = object(f.store.get('exports', String(accepted.id)));
    assert.equal(original.status, 'running'); assert.equal(original.error, null); assert.deepEqual(original.snapshot, storedBeforeLoss.snapshot);
    assert.equal(f.state().snapshot().find(task => task.taskId === accepted.id)!.reason, 'SOURCE_UNAVAILABLE');
    assert.equal(f.services.isBusy(), false); await worker.tick(); assert.deepEqual(f.store.get('exports', String(accepted.id)), original);
    assert.deepEqual(f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId), receipt);
    assert.equal(f.store.list('assets').length, 1); assert.equal(f.store.list('versions').length, 0);
  } finally {await worker.stop();}
});

test('a missing frozen paid-generation reference pauses the original queued job without any submit', async t => {
  let submits = 0;
  const provider: Provider = {id: 'ark', capabilities: {models: ['fixture'], inputModes: ['text','image'], aspectRatios: ['9:16'], durations: [4], configured: true, enabled: true},
    submit: async () => {submits++; return {providerJobId: 'must-not-submit'};}, reconcile: async () => null,
    poll: async () => {throw Error('must not poll');}, download: async () => {throw Error('must not download');}};
  const providers = new Map([['ark', provider]]), f = await fixture(t, providers), bytes = await renderMockImagePng({width: 360, height: 640}), id = randomUUID(), relativePath = `media/${id}.png`;
  writeFileSync(path.join(f.root, relativePath), bytes, {mode: 0o600});
  f.store.put('assets', {id, projectId: f.projectId, name: 'Reference.png', mimeType: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex'), width: 360, height: 640, sizeBytes: bytes.length, relativePath, provenance: 'user-import'});
  const shot = object(await f.services.call('shot.create', {projectId: f.projectId, title: 'Missing reference', prompt: 'Synthetic', duration: 4, referenceAssetIds: [id]}));
  const accepted = object(await f.services.call('generation.submit', {shotId: shot.id, expectedRevision: shot.revision, providerId: 'ark', requestId: randomUUID()}));
  const storedBeforeLoss = object(f.store.get('jobs', String(accepted.id)));
  rmSync(path.join(f.root, relativePath)); const worker = startWorker(f.store, f.services, providers);
  try {
    await worker.tick(); const original = object(f.store.get('jobs', String(accepted.id)));
    assert.equal(original.status, 'queued'); assert.equal(original.submissionCount, 0); assert.equal(original.error, null); assert.deepEqual(original.snapshot, storedBeforeLoss.snapshot);
    assert.deepEqual(original, storedBeforeLoss);
    assert.equal(f.state().snapshot().find(task => task.taskId === accepted.id)!.reason, 'SOURCE_UNAVAILABLE'); assert.equal(f.services.isBusy(), false);
    await worker.tick(); assert.equal(submits, 0); assert.deepEqual(f.store.get('jobs', String(accepted.id)), original);
    assert.equal(f.store.list('versions').length, 0); assert.equal(f.store.list('assets').length, 1);
  } finally {await worker.stop();}
});

test('a real missing media executable retains MEDIA_SPAWN_FAILED and cannot masquerade as a missing source', async t => {
  const f = await fixture(t), job = {id: randomUUID(), projectId: f.projectId, revision: 1, status: 'queued', phase: 'waiting', providerId: 'mock', providerJobId: null, submissionCount: 0, error: null};
  f.store.put('jobs', job); const state = f.state(), originalExecutable = process.env.MIOON_FFMPEG_PATH;
  process.env.MIOON_FFMPEG_PATH = path.join(f.root, 'missing-ffmpeg');
  try {
    await assert.rejects(run('ffmpeg', ['-version']), error => {
      const failure = object(error); assert.equal(failure.code, 'MEDIA_SPAWN_FAILED');
      assert.equal(Object.hasOwn(failure, 'path'), false); assert.equal(Object.hasOwn(failure, 'cause'), false);
      assert.equal(pauseUnavailableBackgroundTask(f.store.db, {kind: 'job', taskId: job.id}, error), false); return true;
    });
  } finally {if (originalExecutable === undefined) delete process.env.MIOON_FFMPEG_PATH; else process.env.MIOON_FFMPEG_PATH = originalExecutable;}
  assert.deepEqual(f.store.get('jobs', job.id), job); assert.equal(state.snapshot().find(task => task.taskId === job.id)!.reason, null);
});

test('a real cross-volume publication EACCES keeps the ordinary export failed outcome while its project and sources remain available', async t => {
  const f = await fixture(t), sourceFile = path.join(f.store.tempDir, 'publication-source.mp4');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i', 'color=c=red:s=64x48:r=30:d=1', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', sourceFile], {timeout: 30000, maxStdoutBytes: 0});
  const source = object(await f.services.call('asset.import', {projectId: f.projectId, name: 'Publication source.mp4', mimeType: 'video/mp4', dataBase64: readFileSync(sourceFile).toString('base64')}));
  let timeline = object(await f.services.call('timeline.get', {projectId: f.projectId}));
  timeline = object(await f.services.call('timeline.clip.add', {projectId: f.projectId, expectedRevision: timeline.revision, requestId: randomUUID(), assetId: source.id,
    trackId: object((timeline.tracks as unknown[])[0]).id, startFrame: 0, durationFrames: 6}));
  const input = {projectId: f.projectId, expectedRevision: timeline.revision, requestId: randomUUID(), purpose: 'export'};
  const accepted = object(await f.services.call('timeline.render', input)), before = object(f.store.get('exports', String(accepted.id)));
  const receipt = f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId);
  const outputDirectory = path.join(f.root, PROJECT_OUTPUT_FOLDERS.exports); mkdirSync(outputDirectory, {mode: 0o755}); chmodSync(outputDirectory, 0o500);
  const removeHook = setProjectOutputPublicationTestHooks(f.store, {forceCopy: true});
  const worker = startWorker(f.store, f.services, new Map());
  try {
    await worker.tick(); const failed = object(f.store.get('exports', String(accepted.id)));
    assert.equal(failed.status, 'failed'); assert.equal(object(failed.error).code, 'INVALID_MEDIA');
    assert.deepEqual(failed.snapshot, before.snapshot); assert.equal(failed.assetId, null);
    const projected = f.state().snapshot().find(task => task.taskId === accepted.id)!;
    assert.equal(projected.classification, 'terminal'); assert.equal(projected.keepAlive, false); assert.equal(projected.reason, null);
    assert.equal((lstatSync(f.store.projectFile).mode & 0o222) !== 0, true); assert.equal((lstatSync(f.root).mode & 0o222) !== 0, true);
    assert.deepEqual(f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId), receipt);
    assert.equal(f.store.list('assets').length, 1); assert.equal(f.store.list('versions').length, 0); assert.equal(f.services.isBusy(), false);
  } finally {removeHook(); chmodSync(outputDirectory, 0o700); await worker.stop();}
});

for (const runStatus of ['paused', 'interrupted'] as const) test(`a ${runStatus} Mio run blocks a new queued dispatch without blocking an accepted task's read-only observation`, async t => {
  const f = await fixture(t), journal = createAgentTaskJournal(f.store);
  const run = journal.create({projectId: f.projectId, requestId: randomUUID(), text: 'Observe the original task', configuration: {protocol: 'responses'}}).run;
  const step = beginFixtureToolStep(journal, run.id, {tier: 'paid', toolCall: {id: randomUUID(), name: 'mioon_generation_submit', arguments: {}}});
  journal.transition(run.id, journal.run(run.id).revision, runStatus, 'user');
  const jobs = ['queued', 'running', 'downloading', 'submission_unknown'].map(status => ({id: randomUUID(), projectId: f.projectId, revision: 1, status, phase: 'waiting',
    providerId: 'ark', providerJobId: ['running', 'downloading'].includes(status) ? 'original-provider-task' : null, submissionCount: status === 'queued' ? 0 : 1, requestId: randomUUID(), nextPollAt: 0, error: null}));
  f.store.tx(() => {
    for (const job of jobs) {
      f.store.put('jobs', job);
      f.store.db.prepare('INSERT INTO mio_job_origins(kind,jobId,runId,stepId,projectId,requestId,operation) VALUES(?,?,?,?,?,?,?)')
        .run('job', job.id, run.id, step.id, f.projectId, job.requestId, 'generation.submit');
    }
  });
  const changes = f.store.db.prepare('SELECT total_changes() AS n').get()!.n; f.state().refresh();
  for (const job of jobs) {
    const projected = f.state().snapshot().find(task => task.taskId === job.id)!;
    assert.equal(projected.keepAlive, job.status !== 'queued'); assert.equal(projected.reason, job.status === 'queued' ? 'AGENT_TASK_PAUSED' : job.status === 'submission_unknown' ? 'SUBMISSION_UNKNOWN' : null);
    assert.deepEqual(f.store.get('jobs', job.id), job);
  }
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, changes, 'classification never writes approval, run, task or receipt state');
});

test('legacy unknown snapshots receive one read-only startup probe, become quiet on null and only observe the original task on explicit recovery', async t => {
  const calls = {submit: 0, reconcile: 0, poll: 0}, reconcileIds: string[] = []; let found = false;
  const provider: Provider = {id: 'ark', capabilities: {models: ['fixture'], inputModes: ['text'], aspectRatios: ['9:16'], durations: [4], configured: true, enabled: true},
    submit: async () => {calls.submit++; throw Object.assign(Error('Synthetic response lost'), {uncertain: true});},
    reconcile: async requestId => {calls.reconcile++; reconcileIds.push(requestId); return found ? {providerJobId: 'original-provider-task'} : null;},
    poll: async taskId => {calls.poll++; assert.equal(taskId, 'original-provider-task'); return {status: 'failed', error: {code: 'SYNTHETIC_TERMINAL', message: 'Original task finished without media'}};},
    download: async () => {throw Error('must not download');}};
  const providers = new Map([['ark', provider]]), f = await fixture(t, providers);
  const shot = object(await f.services.call('shot.create', {projectId: f.projectId, title: 'Legacy observation', prompt: 'Synthetic', duration: 4}));
  const input = {shotId: shot.id, expectedRevision: shot.revision, providerId: 'ark', requestId: randomUUID()};
  const accepted = object(await f.services.call('generation.submit', input));
  let worker = startWorker(f.store, f.services, providers);
  try {
    await worker.tick(); await worker.stop(); assert.equal(calls.submit, 1);
    const unknown = object(f.store.get('jobs', String(accepted.id))); assert.equal(unknown.status, 'submission_unknown');
    assert.equal(f.state().snapshot().find(task => task.taskId === accepted.id)!.keepAlive, false);
    worker = startWorker(f.store, f.services, providers); await worker.tick();
    assert.equal(calls.reconcile, 1); assert.equal(f.state().snapshot().find(task => task.taskId === accepted.id)!.keepAlive, false);
    await worker.tick(); assert.equal(calls.reconcile, 1); assert.equal(calls.submit, 1);
    found = true; f.services.saveJob(object(f.store.get('jobs', String(accepted.id))) as Parameters<typeof f.services.saveJob>[0], {nextPollAt: 0});
    await worker.tick(); assert.equal(object(f.store.get('jobs', String(accepted.id))).status, 'running');
    await worker.tick(); const finished = object(f.store.get('jobs', String(accepted.id)));
    assert.equal(finished.status, 'failed'); assert.equal(object(finished.error).code, 'SYNTHETIC_TERMINAL');
    assert.deepEqual(calls, {submit: 1, reconcile: 2, poll: 1}); assert.deepEqual(reconcileIds, [input.requestId, input.requestId]);
    assert.deepEqual(finished.snapshot, unknown.snapshot); assert.equal(finished.requestId, input.requestId); assert.equal(finished.submissionCount, 1);
  } finally {await worker.stop();}
});

for (const target of ['generation snapshot', 'export owner', 'export ACK range'] as const) test(`a deeply invalid ${target} retains raw bytes but cannot hold a task lease without an executor`, async t => {
  const providers = new Map<string, Provider>(), env = {MIOON_ENABLE_LIVE_PROVIDER: '1', GEMINI_API_KEY: 'synthetic-audit-only'};
  const f = await fixture(t, providers, {env, profileNow: () => Date.parse('2026-10-10T12:00:00Z')});
  let id: string, original: Record<string, unknown>, originalReceipt: string | undefined, requestId: string | undefined, dispatches = 0;
  const kind = target === 'generation snapshot' ? 'job' : 'export', table = kind === 'job' ? 'jobs' : 'exports';
  if (kind === 'job') {
    const registry = createProviderRegistry({db: f.store.db, root: f.root, env}), provider = registry.get('veo')!;
    providers.set('veo', registerInputProfileWrapper({...provider, submit: async () => {dispatches++; throw Error('must not dispatch an invalid snapshot');}}, provider));
    const shot = object(await f.services.call('shot.create', {projectId: f.projectId, title: 'Deep snapshot', prompt: 'Synthetic', duration: 4}));
    const accepted = object(await f.services.call('generation.submit', {shotId: shot.id, expectedRevision: shot.revision, requestId: randomUUID(), providerId: 'veo'})); id = String(accepted.id);
    original = object(f.store.get('jobs', id)); f.store.put('jobs', {...original, snapshot: {...object(original.snapshot), shotId: randomUUID()}});
  } else {
    const source = f.asset(); let timeline = object(await f.services.call('timeline.get', {projectId: f.projectId}));
    timeline = object(await f.services.call('timeline.clip.add', {projectId: f.projectId, expectedRevision: timeline.revision, requestId: randomUUID(), assetId: source.id,
      trackId: object((timeline.tracks as unknown[])[0]).id, startFrame: 0, durationFrames: 12}));
    requestId = randomUUID(); const accepted = object(await f.services.call('timeline.render', {projectId: f.projectId, expectedRevision: timeline.revision, requestId, purpose: 'export', exportRange: {startFrame: 1, endFrame: 8}})); id = String(accepted.id);
    original = object(f.store.get('exports', id)); originalReceipt = String(f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(requestId)!.response);
    if (target === 'export owner') {
      f.store.db.exec('DROP TRIGGER immutable_timeline_render_snapshot'); const snapshot = object(original.snapshot);
      f.store.put('exports', {...original, snapshot: {...snapshot, timeline: {...object(snapshot.timeline), projectId: randomUUID()}}});
    } else {
      f.store.db.exec('DROP TRIGGER immutable_timeline_responses'); const receipt = object(JSON.parse(originalReceipt));
      object(object(receipt.snapshot).exportRange).endFrame = 7;
      f.store.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify(receipt), requestId);
    }
  }
  const state = f.state(), log = t.mock.method(console, 'error', () => {});
  const raw = () => JSON.stringify(Object.fromEntries(['jobs', 'exports', 'job_events', 'timeline_requests', 'idempotency'].map(name => [name, f.store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()])));
  const before = raw(), changes = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  assert.equal(state.snapshot().find(task => task.taskId === id)!.keepAlive, true, 'shallow metadata alone cannot prove the bad frozen content');
  const worker = startWorker(f.store, f.services, providers);
  try {
    await worker.tick(); await worker.tick(); const projected = state.snapshot().find(task => task.taskId === id)!;
    assert.equal(projected.classification, 'waiting_user'); assert.equal(projected.reason, 'BACKGROUND_TASK_INVALID'); assert.equal(projected.keepAlive, false);
    assert.equal(f.services.isBusy(), false); assert.equal(worker.isBusy(), false); assert.equal(dispatches, 0);
    assert.equal(object(f.store.get(table, id)).status, 'queued'); assert.equal(raw(), before); assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
    assert.deepEqual(log.mock.calls.map(call => call.arguments), target === 'generation snapshot' ? [['Skipped invalid local generation record.']] : target === 'export owner' ? [['Skipped invalid local export record.']] : []);
    state.refresh(); assert.equal(state.snapshot().find(task => task.taskId === id)!.keepAlive, false); assert.equal(raw(), before);
  } finally {await worker.stop();}
  // A real committed recovery, rather than an ordinary due read, retires the
  // memory block. This fixture restores the exact original immutable evidence.
  f.store.tx(() => {
    if (target === 'export ACK range') f.store.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(originalReceipt!, requestId!);
    f.store.put(table, original);
  });
  assert.equal(state.snapshot().find(task => task.taskId === id)!.keepAlive, true); assert.equal(state.snapshot().find(task => task.taskId === id)!.reason, null);
});

test('a storage read failure in an export guard is not proof of an invalid task', async t => {
  const f = await fixture(t), source = f.asset(); let timeline = object(await f.services.call('timeline.get', {projectId: f.projectId}));
  timeline = object(await f.services.call('timeline.clip.add', {projectId: f.projectId, expectedRevision: timeline.revision, requestId: randomUUID(), assetId: source.id,
    trackId: object((timeline.tracks as unknown[])[0]).id, startFrame: 0, durationFrames: 6}));
  const accepted = object(await f.services.call('timeline.render', {projectId: f.projectId, expectedRevision: timeline.revision, requestId: randomUUID(), purpose: 'export'}));
  const state = f.state(), before = f.store.get('exports', String(accepted.id)), changes = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  const failure = Object.assign(Error('Synthetic storage read failed'), {code: 'ERR_SQLITE_ERROR'}), prepare = f.store.db.prepare;
  f.store.db.prepare = sql => {if (/FROM timeline_requests/u.test(sql)) throw failure; return prepare.call(f.store.db, sql);};
  try {assert.throws(() => startWorker(f.store, f.services, new Map()), error => error === failure);} finally {f.store.db.prepare = prepare;}
  assert.deepEqual(f.store.get('exports', String(accepted.id)), before); assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
  assert.equal(state.snapshot().find(task => task.taskId === accepted.id)!.keepAlive, true); assert.equal(state.snapshot().find(task => task.taskId === accepted.id)!.reason, null);
});

test('an abandoned generation attempt with changed frozen input becomes quiet without rewriting its refused record', async t => {
  const providers = new Map<string, Provider>(), env = {MIOON_ENABLE_LIVE_PROVIDER: '1', GEMINI_API_KEY: 'synthetic-audit-only'};
  const f = await fixture(t, providers, {env, profileNow: () => Date.parse('2026-10-10T12:00:00Z')}), registry = createProviderRegistry({db: f.store.db, root: f.root, env}), provider = registry.get('veo')!;
  let posts = 0, afterTamper: string | undefined, changesAfterTamper: unknown;
  const raw = () => JSON.stringify({jobs: f.store.db.prepare('SELECT * FROM jobs ORDER BY rowid').all(), events: f.store.db.prepare('SELECT * FROM job_events ORDER BY rowid').all()});
  providers.set('veo', registerInputProfileWrapper({...provider, submit: async (_snapshot: unknown, context: Parameters<Provider['submit']>[1]) => {
    await Promise.resolve(); const job = object(f.store.list('jobs')[0]);
    f.store.put('jobs', {...job, snapshot: {...object(job.snapshot), prompt: 'Changed after the original claim'}});
    afterTamper = raw(); changesAfterTamper = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
    context.beforeSubmit!(); posts++; return {providerJobId: 'must-not-post'};
  }}, provider));
  const shot = object(await f.services.call('shot.create', {projectId: f.projectId, title: 'Stable original', prompt: 'Synthetic', duration: 4}));
  const accepted = object(await f.services.call('generation.submit', {shotId: shot.id, expectedRevision: shot.revision, requestId: randomUUID(), providerId: 'veo'}));
  const log = t.mock.method(console, 'error', () => {}), worker = startWorker(f.store, f.services, providers);
  try {
    await worker.tick(); await worker.tick(); assert.notEqual(afterTamper, undefined); assert.equal(raw(), afterTamper);
    assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, changesAfterTamper); assert.equal(posts, 0);
    assert.equal(object(f.store.get('jobs', String(accepted.id))).status, 'submitting');
    assert.equal(f.state().snapshot().find(task => task.taskId === accepted.id)!.reason, 'BACKGROUND_TASK_INVALID');
    assert.equal(f.services.isBusy(), false); assert.equal(worker.isBusy(), false);
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['Skipped invalid local generation record.']]);
  } finally {await worker.stop();}
});

test('normal queued revision and nextPollAt changes cannot publish a phantom frozen-input block', async t => {
  const providers = new Map<string, Provider>(), env = {MIOON_ENABLE_LIVE_PROVIDER: '1', GEMINI_API_KEY: 'synthetic-audit-only'};
  const f = await fixture(t, providers, {env, profileNow: () => Date.parse('2026-10-10T12:00:00Z')}), registry = createProviderRegistry({db: f.store.db, root: f.root, env}), provider = registry.get('veo')!;
  let posts = 0;
  providers.set('veo', registerInputProfileWrapper({...provider, submit: async (_snapshot: unknown, context: Parameters<Provider['submit']>[1]) => {context.beforeSubmit!(); posts++; return {providerJobId: 'accepted-once'};}, poll: async () => ({status: 'running'})}, provider));
  const shot = object(await f.services.call('shot.create', {projectId: f.projectId, title: 'Progress metadata', prompt: 'Synthetic', duration: 4}));
  const accepted = object(await f.services.call('generation.submit', {shotId: shot.id, expectedRevision: shot.revision, requestId: randomUUID(), providerId: 'veo'}));
  const originalGuard = f.services.saveGenerationGuarded; let changeOnce = true;
  f.services.saveGenerationGuarded = (job, patch) => {
    if (changeOnce && job.status === 'queued' && patch.status === 'submitting') {
      changeOnce = false; f.store.put('jobs', {...object(f.store.get('jobs', job.id)), revision: Number(job.revision) + 1, nextPollAt: Date.now() + 60000});
    }
    return originalGuard(job, patch);
  };
  const log = t.mock.method(console, 'error', () => {}), worker = startWorker(f.store, f.services, providers);
  try {
    await worker.tick(); const pending = object(f.store.get('jobs', String(accepted.id)));
    assert.equal(pending.status, 'queued'); assert.equal(posts, 0);
    assert.equal(f.state().snapshot().find(task => task.taskId === accepted.id)!.reason, null); assert.equal(f.state().snapshot().find(task => task.taskId === accepted.id)!.keepAlive, true);
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['Skipped invalid local generation record.']]);
    f.services.saveJob(pending as Parameters<typeof f.services.saveJob>[0], {nextPollAt: 0}); await worker.tick();
    assert.equal(posts, 1); assert.equal(object(f.store.get('jobs', String(accepted.id))).status, 'running');
    assert.equal(f.state().snapshot().find(task => task.taskId === accepted.id)!.reason, null);
  } finally {await worker.stop(); f.services.saveGenerationGuarded = originalGuard;}
});
