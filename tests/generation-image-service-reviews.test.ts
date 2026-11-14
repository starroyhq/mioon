import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import type {RequestOptions} from 'node:https';
import {setTimeout as pause} from 'node:timers/promises';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createCustomImageSettingsV2} from '../packages/business/src/images/custom-settings-v2.ts';
import {createCompatibleImageGatewayV2} from '../packages/business/src/images/gateway.ts';
import {renderMockImagePng} from '../packages/business/src/images/png.ts';
import {DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2} from '../packages/contracts/src/generation-image-settings.ts';
import type {CustomImageConfigurationV2, CustomImageConnectionV2} from '../packages/contracts/src/generation-image-settings.ts';
import {canonicalImageInput as canonical, imageSchemas, isImageTaskResponse} from '../packages/contracts/src/images.ts';
import {isImageReviewResponse} from '../packages/contracts/src/image-reviews.ts';
import type {OutputLocale} from '../packages/contracts/src/output-locale.ts';

type Settings = Awaited<ReturnType<typeof createCustomImageSettingsV2>>;
type Generation = ReturnType<typeof imageSchemas['image.generate']['parse']>;
type NetworkOptions = RequestOptions & {hostname: string; path: string; headers: Record<string, string>};
type Boundary = 'before-acquire' | 'after-acquire' | 'dns';
const KEY_A = 'SYNTHETIC_SERVICE_A_NOT_A_REAL_KEY', KEY_B = 'SYNTHETIC_SERVICE_B_NOT_A_REAL_KEY';
const configuration = (): CustomImageConfigurationV2 => ({...DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2, enabled: true,
  baseUrl: 'https://images.example.test/custom/v1', model: 'same-exact-model'});
const addresses = [{address: '8.8.8.8', family: 4}];
let png: Promise<Buffer> | undefined;
const realPng = () => png ??= renderMockImagePng();
const approval = (review: {projectId: string; id: string; revision: number}) => ({projectId: review.projectId, reviewId: review.id, expectedRevision: review.revision});
function taskResponse(value: unknown) {assert.ok(isImageTaskResponse(value)); return value;}
function serviceReview(value: unknown) {
  assert.ok(isImageReviewResponse(value)); assert.ok('connectionId' in value && 'configurationRevision' in value); return value;
}
const expectedBody = (input: Generation) => ({model: input.model, prompt: input.prompt, n: 1, quality: 'low', size: '1024x1024', output_format: 'png', background: 'opaque', moderation: 'auto'});

/** Real PNG/adapter/transport, with only DNS and TLS supplied by a local peer. */
function network(bytes: Buffer, barrier: {boundary?: Boundary; entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>>}) {
  const state = {lookups: 0, created: 0, posts: [] as Array<{hostname: string; path: string; authorization: string; body: unknown}>};
  const lookup = async (hostname: string, options: unknown) => {
    state.lookups++; assert.equal(hostname, 'images.example.test'); assert.deepEqual(options, {all: true, verbatim: true});
    if (barrier.boundary === 'dns') {barrier.entered.resolve(); await barrier.release.promise;}
    return addresses;
  };
  const httpsRequest = (options: NetworkOptions, callback: (response: Readable) => void) => {
    state.created++; assert.equal(options.method, 'POST'); assert.equal(options.hostname, 'images.example.test');
    assert.equal(options.path, '/custom/v1/images/generations'); assert.equal(options.servername, options.hostname); assert.equal(options.rejectUnauthorized, true);
    const request = new EventEmitter() as EventEmitter & {destroy(error?: Error): void; end(payload: string | Buffer): void}; request.destroy = () => {};
    request.end = payload => {
      state.posts.push({hostname: options.hostname, path: options.path, authorization: options.headers.Authorization!, body: JSON.parse(String(payload))});
      const response = Readable.from([Buffer.from(JSON.stringify({data: [{b64_json: bytes.toString('base64')}]}))]);
      Object.assign(response, {statusCode: 200, headers: {'content-type': 'application/json'}, complete: true}); callback(response);
    };
    queueMicrotask(() => {
      const socket = new EventEmitter(); Object.assign(socket, {remoteAddress: '8.8.8.8', remotePort: 443, authorized: true, destroy() {}});
      request.emit('socket', socket); socket.emit('secureConnect');
    });
    return request;
  };
  return {state, lookup: lookup as unknown as NonNullable<Parameters<typeof createCompatibleImageGatewayV2>[0]['lookup']>,
    httpsRequest: httpsRequest as unknown as NonNullable<Parameters<typeof createCompatibleImageGatewayV2>[0]['httpsRequest']>};
}
async function fixture(t: test.TestContext, {withB = true, autoRun = true, boundary}: {withB?: boolean; autoRun?: boolean; boundary?: Boundary} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-image-service-reviews-')), store = openStore(root);
  let persisted: unknown = null;
  const settings = await createCustomImageSettingsV2({persistence: {load: () => structuredClone(persisted), save: value => {persisted = structuredClone(value);}}});
  const barrier = {boundary, entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>()};
  const acquisitions: Array<{connectionId: string; configurationRevision: number; configuration: CustomImageConfigurationV2}> = [];
  let acquisitionAttempts = 0;
  const guardedSettings: Settings = {...settings, acquire: async (expected, options) => {
    if (boundary === 'before-acquire') {barrier.entered.resolve(); await barrier.release.promise;}
    acquisitionAttempts++;
    const result = await settings.acquire(expected, options);
    acquisitions.push({connectionId: result.connectionId, configurationRevision: result.configurationRevision, configuration: structuredClone(result.configuration)});
    if (boundary === 'after-acquire') {barrier.entered.resolve(); await barrier.release.promise;}
    return result;
  }};
  const net = network(await realPng(), barrier), gateway = createCompatibleImageGatewayV2({settings: guardedSettings, lookup: net.lookup, httpsRequest: net.httpsRequest});
  const services = createServices(store, new Map(), {env: {}, imageOptions: {autoRun, customSettingsV2: settings, customGateway: gateway}});
  t.after(async () => {barrier.release.resolve(); await services.drain(); await settings.close(); store.close(); await rm(root, {recursive: true, force: true});});
  await services.call('project.create', {name: 'Explicit image service reviews'});
  const projectId = store.projectId, a = randomUUID(), b = randomUUID();
  const item = (id: string): CustomImageConnectionV2 => {const found = settings.readCurrent().connections.find(entry => entry.connectionId === id); assert.ok(found); return found;};
  async function add(id: string, key: string) {
    return settings.create({expectedRevision: (await settings.get()).revision, connectionId: id, name: 'Same service label', configuration: configuration(), secret: {action: 'replace', storage: 'session', value: key}});
  }
  await add(a, KEY_A); if (withB) await add(b, KEY_B);
  const input = (patch: Partial<Generation> = {}): Generation => imageSchemas['image.generate'].parse({projectId, requestId: randomUUID(), name: 'Exact service output', providerId: 'openai-compatible',
    model: configuration().model, prompt: 'A precise synthetic PNG. No live provider is contacted.', options: configuration().options, ...patch});
  return {root, store, services, settings, projectId, a, b, net: net.state, barrier, acquisitions, get acquisitionAttempts() {return acquisitionAttempts;}, input, item, add,
    async reachBoundary() {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {await Promise.race([barrier.entered.promise, new Promise<never>((_, reject) => {timeout = setTimeout(() => reject(new Error('Synthetic dispatch boundary was not reached')), 10000);})]);}
      finally {clearTimeout(timeout);}
    },
    prepare: async (connectionId: string, generation: Generation = input(), revision = item(connectionId).configurationRevision, outputLocale?: OutputLocale) => serviceReview(await services.generationImageServices('image.service.review.prepare', {input: generation, connectionId, configurationRevision: revision}, outputLocale)),
    legacyPrepare: async (generation: Generation) => serviceReview(await services.call('image.review.prepare', {input: generation, settingsRevision: 1})),
    approve: async (review: Parameters<typeof approval>[0]) => taskResponse(await services.imageApproval(approval(review))),
    async update(id: string, patch: Partial<CustomImageConfigurationV2>) {const current = item(id); return settings.put({expectedRevision: (await settings.get()).revision, connectionId: id, expectedConfigurationRevision: current.configurationRevision, name: current.name, configuration: {...current.configuration, ...patch}, secret: {action: 'keep'}});},
    async remove(id: string) {const current = item(id); return settings.remove({expectedRevision: (await settings.get()).revision, connectionId: id, expectedConfigurationRevision: current.configurationRevision});},
    async settled(id: string, expected: string) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const current = taskResponse(await services.call('image.task.get', {projectId, taskId: id}));
        if (current.state === expected) return current;
        if (['failed', 'outcome_unknown', 'local_result_error', 'succeeded'].includes(current.state)) assert.fail(`Unexpected terminal state: ${JSON.stringify(current)}`);
        await pause(5);
      }
      assert.fail('Synthetic image service task did not settle');
    },
    readReview: async (id: string) => serviceReview(await services.call('image.review.get', {projectId, reviewId: id})),
  };
}
function assertFrozen(f: Awaited<ReturnType<typeof fixture>>, review: Awaited<ReturnType<typeof serviceReview>>, input: Generation, connectionId = f.a) {
  assert.equal(review.connectionId, connectionId); assert.equal(review.configurationRevision, 1); assert.equal(review.settingsRevision, 1);
  assert.deepEqual(review.configuration, configuration()); assert.deepEqual(review.input, input); assert.equal(review.destination, `${configuration().baseUrl}/images/generations`);
  const row = f.store.db.prepare('SELECT canonicalInput,canonicalIntent,inputHash,intentHash FROM image_reviews WHERE id=?').get(review.id)!;
  const intent = JSON.parse(String(row.canonicalIntent)) as Record<string, unknown>;
  assert.equal(intent.schemaVersion, 6); assert.equal(intent.connectionId, connectionId); assert.equal(intent.configurationRevision, 1); assert.equal(intent.settingsRevision, 1);
  assert.deepEqual(intent.configuration, configuration()); assert.equal(row.canonicalInput, canonical(input)); assert.equal(row.inputHash, createHash('sha256').update(canonical(input)).digest('hex'));
  assert.equal(row.intentHash, createHash('sha256').update(String(row.canonicalIntent)).digest('hex'));
  assert.doesNotMatch(JSON.stringify(review), /SYNTHETIC_SERVICE_[AB]/);
}

test('explicit A keeps its own frozen review and paid key after adding and editing same-model B', async t => {
  const f = await fixture(t, {withB: false}), input = f.input();
  const library=testProjectAppLibrary(f.store);assert.ok(library);
  library.documents.write('workspace-settings-v1.json', JSON.stringify({formatVersion:1, revision:4, liveGeneration:false}));
  assert.equal(f.services.generationAvailability.image(input.providerId,input.model),true);
  await assert.rejects(f.services.call('image.generate',input),{code:'IMAGE_REVIEW_REQUIRED'});
  assert.equal(f.net.lookups,0);assert.equal(f.net.posts.length,0);
  const review = await f.prepare(f.a, input, 1, 'ja'); assertFrozen(f, review, input);
  assert.equal(f.net.lookups,0);assert.equal(f.net.posts.length,0);
  assert.deepEqual(await f.prepare(f.a, input, 1, 'en'), review);
  const stored = String(f.store.db.prepare('SELECT canonicalIntent FROM image_reviews WHERE id=?').get(review.id)!.canonicalIntent);
  await f.add(f.b, KEY_B); assert.equal(f.item(f.a).configurationRevision, f.item(f.b).configurationRevision);
  await f.update(f.b, {model: 'updated-B-only'}); assert.equal(f.item(f.a).configurationRevision, 1);
  const accepted = await f.approve(review), completed = await f.settled(accepted.id, 'succeeded');
  assert.equal(completed.dispatched, true); assert.equal(f.net.posts.length, 1); assert.equal(f.net.posts[0]!.authorization, `Bearer ${KEY_A}`);
  const asset = f.store.db.prepare("SELECT json_extract(assets.data,'$.name') AS name FROM image_versions JOIN assets ON assets.id=image_versions.assetId WHERE image_versions.id=?").get(completed.versionId);
  assert.equal(asset?.name, 'Exact service output · 画像 1.png');
  assert.deepEqual(f.net.posts[0]!.body, expectedBody(input)); assert.doesNotMatch(JSON.stringify(f.net.posts[0]!.body), /connectionId|configurationRevision|settingsRevision/);
  assert.deepEqual(f.acquisitions, [{connectionId: f.a, configurationRevision: 1, configuration: configuration()}]);
  assert.equal(String(f.store.db.prepare('SELECT canonicalIntent FROM image_reviews WHERE id=?').get(review.id)!.canonicalIntent), stored);
  assert.equal((await f.readReview(review.id)).postAttempts, 1);
  assert.deepEqual(JSON.parse(library.documents.read('workspace-settings-v1.json')!), {formatVersion:1, revision:4, liveGeneration:false});
});

test('the second of two identical services dispatches its explicitly selected key through the complete review lifecycle', async t => {
  const f = await fixture(t), input = f.input(), review = await f.prepare(f.b, input); assertFrozen(f, review, input, f.b);
  assert.deepEqual(f.item(f.a).configuration, f.item(f.b).configuration); assert.equal(f.item(f.a).configurationRevision, f.item(f.b).configurationRevision);
  const accepted = await f.approve(review), completed = await f.settled(accepted.id, 'succeeded');
  assert.equal(completed.dispatched, true); assert.equal(f.net.posts.length, 1); assert.equal(f.net.posts[0]!.authorization, `Bearer ${KEY_B}`);
  assert.deepEqual(f.net.posts[0]!.body, expectedBody(input)); assert.doesNotMatch(JSON.stringify(f.net.posts[0]!.body), /connectionId|configurationRevision|settingsRevision/);
  assert.deepEqual(f.acquisitions, [{connectionId: f.b, configurationRevision: 1, configuration: configuration()}]);
  assert.equal((await f.readReview(review.id)).postAttempts, 1);
});

test('changing A model at the same address retains its key but invalidates the earlier approval', async t => {
  const f = await fixture(t), input = f.input(), review = await f.prepare(f.a, input); assertFrozen(f, review, input);
  await f.update(f.a, {model: 'new-A-model'}); assert.equal(f.item(f.a).secret.configured, true); assert.equal(f.item(f.b).configurationRevision, 1);
  const current = f.item(f.a), retainedKey = await f.settings.acquire({connectionId: f.a, configurationRevision: current.configurationRevision, configuration: current.configuration});
  assert.equal(retainedKey.apiKey, KEY_A);
  await assert.rejects(f.approve(review), {code: 'IMAGE_REVIEW_SETTINGS_CHANGED'});
  assert.equal(f.acquisitionAttempts, 0); assert.equal(f.net.posts.length, 0); assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_tasks').get()!.n, 0);
  assert.equal((await f.readReview(review.id)).postAttempts, 0);
});

test('the same request ID cannot change its explicit service even when model and per-service revision match', async t => {
  const f = await fixture(t, {autoRun: false}), input = f.input(), review = await f.prepare(f.a, input); assertFrozen(f, review, input);
  const before = String(f.store.db.prepare('SELECT canonicalIntent FROM image_reviews WHERE id=?').get(review.id)!.canonicalIntent);
  await assert.rejects(f.prepare(f.b, input), {code: 'IMAGE_REVIEW_CONFLICT'});
  assert.deepEqual(await f.prepare(f.a, input), review); assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_reviews').get()!.n, 1);
  assert.equal(String(f.store.db.prepare('SELECT canonicalIntent FROM image_reviews WHERE id=?').get(review.id)!.canonicalIntent), before);
  assert.equal(f.acquisitionAttempts, 0); assert.equal(f.net.posts.length, 0);
});

test('explicit service reviews cannot cross project stores or borrow another project service identity', async t => {
  const f = await fixture(t, {autoRun: false}), other = await fixture(t, {autoRun: false}), input = f.input(), review = await f.prepare(f.a, input);
  const rows = (owner: typeof f) => JSON.stringify(owner.store.db.prepare('SELECT * FROM image_reviews ORDER BY id').all());
  const changes = (owner: typeof f) => owner.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  const retained = rows(f), otherRetained = rows(other), before = changes(f), otherBefore = changes(other);
  await assert.rejects(f.prepare(f.a, {...input, projectId: other.projectId}), {code: 'IMAGE_REVIEW_NOT_FOUND'});
  await assert.rejects(f.prepare(other.a, f.input(), 1), {code: 'IMAGE_SETTINGS_NOT_FOUND'});
  await assert.rejects(async () => f.services.imageApproval({...approval(review), projectId: other.projectId}), {code: 'IMAGE_REVIEW_NOT_FOUND'});
  await assert.rejects(async () => other.services.imageApproval({projectId: other.projectId, reviewId: review.id, expectedRevision: review.revision}), {code: 'IMAGE_REVIEW_NOT_FOUND'});
  await assert.rejects(async () => other.services.call('image.review.get', {projectId: other.projectId, reviewId: review.id}), {code: 'IMAGE_REVIEW_NOT_FOUND'});
  assert.equal(rows(f), retained); assert.equal(rows(other), otherRetained); assert.equal(changes(f), before); assert.equal(changes(other), otherBefore);
  for (const owner of [f, other]) {
    assert.equal(owner.store.db.prepare('SELECT count(*) AS n FROM image_tasks').get()!.n, 0);
    assert.equal(owner.store.db.prepare('SELECT count(*) AS n FROM image_requests').get()!.n, 0);
    assert.equal(owner.acquisitionAttempts, 0); assert.equal(owner.net.lookups, 0); assert.equal(owner.net.posts.length, 0);
  }
});

test('new no-ID requests reject multiple services while exact historical preparation and acceptance still replay', async t => {
  const f = await fixture(t, {withB: false, autoRun: false}), input = f.input(), review = await f.legacyPrepare(input); assertFrozen(f, review, input);
  const accepted = await f.approve(review), receipt = String(f.store.db.prepare('SELECT response FROM image_requests WHERE requestId=?').get(input.requestId)!.response);
  await f.add(f.b, KEY_B);
  await assert.rejects(f.legacyPrepare(f.input()), {code: 'IMAGE_SETTINGS_SELECTION_REQUIRED'});
  await assert.rejects(f.services.call('image.generate', f.input()), {code: 'IMAGE_SETTINGS_SELECTION_REQUIRED'});
  assert.deepEqual(await f.legacyPrepare(input), await f.readReview(review.id)); assert.deepEqual(await f.approve(review), accepted);
  assert.deepEqual(await f.services.call('image.generate', input), accepted);
  assert.equal(String(f.store.db.prepare('SELECT response FROM image_requests WHERE requestId=?').get(input.requestId)!.response), receipt);
  assert.equal(f.acquisitionAttempts, 0); assert.equal(f.net.posts.length, 0);
});

test('deleting A before approval refuses its frozen review before acquiring credentials or accepting a task', async t => {
  const f = await fixture(t), review = await f.prepare(f.a); await f.remove(f.a);
  await assert.rejects(f.approve(review), {code: 'IMAGE_SETTINGS_NOT_FOUND'});
  assert.equal(f.item(f.b).secret.configured, true); assert.equal(f.acquisitionAttempts, 0); assert.equal(f.net.lookups, 0); assert.equal(f.net.posts.length, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_tasks').get()!.n, 0); assert.equal((await f.readReview(review.id)).postAttempts, 0);
});

test('deleting A after acceptance but before key acquisition prevents dispatch without adopting B', async t => {
  const f = await fixture(t, {boundary: 'before-acquire'}), review = await f.prepare(f.a), accepted = await f.approve(review); await f.reachBoundary();
  await f.remove(f.a); assert.equal(f.acquisitionAttempts, 0); f.barrier.release.resolve();
  const failed = await f.settled(accepted.id, 'failed'); assert.equal(failed.dispatched, false); assert.equal(f.acquisitions.length, 0);
  assert.equal(f.net.lookups, 0); assert.equal(f.net.posts.length, 0); assert.equal((await f.readReview(review.id)).postAttempts, 0);
});

for (const boundary of ['after-acquire', 'dns'] as const) test(`changing A at the ${boundary} boundary blocks the final POST after asynchronous work`, async t => {
  const f = await fixture(t, {boundary}), review = await f.prepare(f.a), accepted = await f.approve(review); await f.reachBoundary();
  assert.deepEqual(f.acquisitions, [{connectionId: f.a, configurationRevision: 1, configuration: configuration()}]);
  await f.update(f.a, {model: 'changed-after-acquisition'}); assert.equal(f.item(f.a).secret.configured, true); f.barrier.release.resolve();
  const failed = await f.settled(accepted.id, 'failed'); assert.equal(failed.dispatched, false); assert.equal(f.net.posts.length, 0);
  const retained = await f.readReview(review.id); assert.equal(retained.state, 'approved'); assert.equal(retained.postAttempts, 0); assert.equal(retained.connectionId, f.a);
});
