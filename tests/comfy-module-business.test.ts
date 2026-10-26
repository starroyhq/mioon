import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createModuleFixture, configuration, imageRows, until, sha256} from './helpers/comfy-module-fixture.ts';

type ModuleFixture = Awaited<ReturnType<typeof createModuleFixture>>;
type ModuleOptions = Parameters<typeof createModuleFixture>[1];
const moduleOptions = (options: Record<string, unknown>): ModuleOptions => options as unknown as ModuleOptions;
const missingModule = (error: unknown) => {const failure = error as {code?: string; status?: number}; return failure.code === 'COMFY_MODULE_UNAVAILABLE' && failure.status === 503;};
const changes = (f: ModuleFixture) => (f.store.db.prepare('SELECT total_changes() AS n').get() as {n: number}).n;

test('unavailable Comfy module refuses new generation, preparation and pending approval without mutations', async t => {
  for (const state of ['not_provided', 'not_loaded']) await t.test(state, async t => {
    const f = await createModuleFixture(t);
    const pendingInput = f.input(), pendingReview = await f.prepare(pendingInput);
    await f.reopen(state);
    // Make settings otherwise ready: absence, not disabled/unverified config,
    // must be the reason fresh execution is refused.
    f.check();
    const before = imageRows(f.store), setting = await (f.settings)!.get(), total = changes(f);
    const fresh = f.input();
    await assert.rejects(f.call('image.generate', fresh), missingModule);
    await assert.rejects(f.prepare(fresh), missingModule);
    await assert.rejects(async () => f.approve(pendingReview), missingModule);
    assert.deepEqual(await f.prepare(pendingInput), pendingReview, 'pending exact review preparation is a historical read');
    await assert.rejects(f.prepare({...pendingInput, prompt: 'Changed payload'}), {code: 'IMAGE_REVIEW_CONFLICT'});
    assert.deepEqual(imageRows(f.store), before);
    assert.equal(changes(f), total, 'denial must precede even rolled-back SQL writes');
    assert.deepEqual(await (f.settings)!.get(), setting);
    assert.deepEqual(f.calls, {post: 0, get: 0});
    const profiles = await f.call('image.profile.list', {});
    assert.equal(profiles.items.find((item: {providerId: string; enabled: boolean}) => item.providerId === 'comfy-local')?.enabled, false);
  });
});

test('completed Comfy receipts, reviews, remote journals and PNG bytes survive unavailable-module restarts exactly', async t => {
  const f = await createModuleFixture(t), {input, review, ack} = await f.accepted();
  const observation = await f.observationInput(ack.id), observed = await f.call('image.task.observeRemote', observation);
  const finished = await until(() => f.task(ack.id), (task: {state: string}) => task.state === 'succeeded');
  await until(() => f.remote(ack.id), (result) => result.observation?.state === 'finished');
  const prepared = await f.prepare(input), remote = await f.remote(ack.id);
  const versions = await f.call('image.version.list', {projectId: f.project.id, groupId: ack.groupId});
  const group = await f.call('image.group.get', {projectId: f.project.id, groupId: ack.groupId});
  const before = imageRows(f.store), asset = versions.items[0], bytes = readFileSync(path.join(f.root, 'media', `${asset.assetId}.png`));
  assert.equal(sha256(bytes), asset.sha256);
  assert.equal(f.calls.post, 1);
  for (const state of ['not_provided', 'not_loaded']) {
    await f.reopen(state);
    assert.deepEqual(imageRows(f.store), before, `${state} must not rewrite completed records on startup`);
    const total = changes(f);
    assert.deepEqual(await f.call('image.generate', input), ack);
    assert.deepEqual(await f.prepare(input), prepared);
    assert.deepEqual(await f.approve(review), ack);
    assert.deepEqual(await f.call('image.task.observeRemote', observation), observed);
    assert.deepEqual(await f.call('image.request.get', {projectId: f.project.id, requestId: input.requestId}),
      {projectId: f.project.id, requestId: input.requestId, operation: 'image.generate', response: ack});
    assert.deepEqual(await f.task(ack.id), finished);
    assert.deepEqual(await f.remote(ack.id), remote);
    assert.deepEqual(await f.call('image.group.get', {projectId: f.project.id, groupId: ack.groupId}), group);
    assert.deepEqual(await f.call('image.version.list', {projectId: f.project.id, groupId: ack.groupId}), versions);
    assert.equal((await f.call('image.task.list', {projectId: f.project.id})).items[0].id, ack.id);
    assert.deepEqual(readFileSync(path.join(f.root, 'media', `${asset.assetId}.png`)), bytes);
    await assert.rejects(f.call('image.generate', {...input, prompt: 'Changed original request'}), {code: 'IMAGE_REQUEST_CONFLICT'});
    await assert.rejects(f.prepare({...input, prompt: 'Changed original review'}), {code: 'IMAGE_REVIEW_CONFLICT'});
    await assert.rejects(f.call('image.task.observeRemote', {...observation, expectedRevision: observation.expectedRevision + 1}), {code: 'COMFY_REMOTE_CONFLICT'});
    await assert.rejects(f.call('image.task.remote.get', {projectId: f.other.id, taskId: ack.id}));
    assert.deepEqual(imageRows(f.store), before);
    assert.equal(changes(f), total);
    assert.deepEqual(f.calls, {post: 1, get: 1});
  }
});

test('unknown original task retains its identities and exact observation replay while missing module blocks a fresh query', async t => {
  const f = await createModuleFixture(t, moduleOptions({
    submit: (args: {beforeSubmit(): void}) => { args.beforeSubmit(); throw Error('Synthetic lost acknowledgment'); },
    observe: () => ({state: 'running' as const, contentVerified: false}),
  }));
  const {input, review, ack} = await f.accepted();
  const observation = await f.observationInput(ack.id), observed = await f.call('image.task.observeRemote', observation);
  await until(() => f.remote(ack.id), (result) => result.observation?.state === 'finished');
  const before = imageRows(f.store), remote = await f.remote(ack.id);
  for (const state of ['not_provided', 'not_loaded']) {
    await f.reopen(state);
    assert.deepEqual(imageRows(f.store), before);
    const total = changes(f);
    assert.equal((await f.task(ack.id)).state, 'outcome_unknown');
    assert.deepEqual(await f.call('image.generate', input), ack);
    assert.deepEqual(await f.approve(review), ack);
    assert.deepEqual(await f.call('image.task.observeRemote', observation), observed);
    assert.deepEqual(await f.remote(ack.id), remote);
    await assert.rejects(f.call('image.task.observeRemote', await f.observationInput(ack.id)), missingModule);
    assert.deepEqual(imageRows(f.store), before);
    assert.equal(changes(f), total);
    assert.deepEqual(f.calls, {post: 1, get: 1});
  }
});

test('local-result recovery remains explicitly usable without the Comfy network module', async t => {
  let stop = true;
  const f = await createModuleFixture(t, moduleOptions({fault: (phase: string) => {
    if (phase === 'after_result_manifest' && stop) { stop = false; throw Error('Synthetic stop after durable local manifest'); }
  }}));
  const {ack} = await f.accepted();
  await f.call('image.task.observeRemote', await f.observationInput(ack.id));
  const failed = await until(() => f.task(ack.id), (task: {state: string}) => task.state === 'local_result_error');
  await until(() => f.remote(ack.id), (result) => result.observation?.state === 'finished');
  const journal = imageRows(f.store, ['image_reviews', 'image_requests', 'image_remote_runs', 'image_remote_observations']);
  const manifest = readFileSync(path.join(f.root, 'image-staging', `${ack.id}.json`));
  await f.reopen('not_provided');
  assert.deepEqual(imageRows(f.store, Object.keys(journal)), journal);
  assert.deepEqual(readFileSync(path.join(f.root, 'image-staging', `${ack.id}.json`)), manifest);
  assert.deepEqual(await f.task(ack.id), failed, 'module absence must not auto-recover local results');
  const recovery = {projectId: f.project.id, taskId: ack.id, requestId: randomUUID(), expectedRevision: failed.revision};
  const recovered = await f.call('image.task.recoverResult', recovery);
  await until(() => f.task(ack.id), (task: {state: string}) => task.state === 'succeeded');
  assert.deepEqual(await f.call('image.task.recoverResult', recovery), recovered);
  const version = (await f.call('image.version.list', {projectId: f.project.id, groupId: ack.groupId})).items[0];
  assert.deepEqual(readFileSync(path.join(f.root, 'media', `${version.assetId}.png`)), f.png);
  assert.deepEqual(f.calls, {post: 1, get: 1});
});

test('loaded connector still observes original frozen task when current settings disable generation or point elsewhere', async t => {
  let seen: {config?: unknown; execution?: unknown} | undefined;
  const f = await createModuleFixture(t, moduleOptions({observe: (args: {config?: unknown; execution?: unknown}) => { seen = args; return {state: 'running' as const, contentVerified: false}; }}));
  const {ack, review} = await f.accepted();
  const changed = {...configuration, enabled: false, baseUrl: 'http://127.0.0.1:8190', model: 'different.safetensors'};
  await (f.settings)!.put({expectedRevision: 1, configuration: changed});
  await f.reopen('available');
  await f.call('image.task.observeRemote', await f.observationInput(ack.id));
  await until(() => f.remote(ack.id), (result) => result.observation?.state === 'finished');
  assert.equal((await (f.settings)!.get()).configuration.enabled, false);
  assert.deepEqual(seen!.config, review.configuration);
  assert.deepEqual(seen!.execution, review.execution);
  assert.deepEqual(f.calls, {post: 1, get: 1});
  await assert.rejects(f.call('image.review.prepare', {input: f.input({model: changed.model}), settingsRevision: 2}), {code: 'IMAGE_LIVE_DISABLED'});
});

test('lost observation acknowledgment replays under module omission without resuming its interrupted query', async t => {
  let lost = true;
  const f = await createModuleFixture(t, moduleOptions({fault: (phase: string) => {
    if (phase === 'after_remote_observation_accept' && lost) { lost = false; throw Error('Synthetic lost observation ACK'); }
  }}));
  const {ack} = await f.accepted(), observation = await f.observationInput(ack.id);
  await assert.rejects(f.call('image.task.observeRemote', observation), /Synthetic lost observation ACK/);
  assert.deepEqual(f.calls, {post: 1, get: 0});
  const original = f.store.db.prepare('SELECT canonicalInput,inputHash,response FROM image_remote_observations WHERE requestId=?').get(observation.requestId) as {canonicalInput: string; inputHash: string; response: string};
  await f.reopen('not_loaded');
  const interrupted = await f.remote(ack.id);
  assert.equal((interrupted as {observation: {state: string}}).observation.state, 'interrupted');
  assert.equal((await f.task(ack.id)).state, 'outcome_unknown');
  const before = imageRows(f.store), total = changes(f);
  assert.deepEqual(await f.call('image.task.observeRemote', observation), JSON.parse(original.response));
  assert.deepEqual(f.store.db.prepare('SELECT canonicalInput,inputHash,response FROM image_remote_observations WHERE requestId=?').get(observation.requestId), original);
  await assert.rejects(f.call('image.task.observeRemote', await f.observationInput(ack.id)), missingModule);
  assert.deepEqual(imageRows(f.store), before);
  assert.equal(changes(f), total);
  assert.deepEqual(f.calls, {post: 1, get: 0});
});
