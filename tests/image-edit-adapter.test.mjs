import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createMockImageAdapter, createOpenAIImageAdapter, createCompatibleImageAdapter} from '../packages/business/src/images/adapter.mjs';
import {createLiveImageGateway, createCompatibleImageGateway} from '../packages/business/src/images/gateway.mjs';
import {createImageEditBody, createImageGenerationBody, IMAGE_EDIT_NETWORK_LIMITS, IMAGE_NETWORK_LIMITS} from '../packages/business/src/images/profiles.mjs';
import {createImageSettings, createCustomImageSettings, IMAGE_CREDENTIAL_ACQUIRE, IMAGE_SETTINGS_ASSERT_CURRENT} from '../packages/business/src/images/settings.mjs';
import {DEFAULT_IMAGE_CONFIGURATION, DEFAULT_CUSTOM_IMAGE_CONFIGURATION} from '../packages/contracts/src/image-settings.mjs';
import {IMAGE_EDIT_LIMITS, IMAGE_FIXED_OPTIONS, IMAGE_MODELS, IMAGE_LIMITS} from '../packages/contracts/src/images.mjs';
import {renderMockImagePng} from '../packages/business/src/images/png.mjs';

const sourceId = '11111111-1111-4111-8111-111111111111', key = 'synthetic-official-edit-key', answers = [{address: '8.8.8.8', family: 4}];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function chunk(type, data = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8);
  let crc = 0xffffffff; for (const byte of bytes.subarray(4, -4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4); return bytes;
}
function sourcePng({alpha = false, before = []} = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), ...before, chunk('IDAT', deflateSync(Buffer.alloc(alpha ? 18 : 14))), chunk('IEND')]);
}
const generation = providerId => ({providerId, model: IMAGE_MODELS[providerId], prompt: 'Synthetic exact edit instruction: 蓝色 sky.', options: {...IMAGE_FIXED_OPTIONS}});
function input(bytes = sourcePng(), providerId = 'openai') {
  return {...generation(providerId), purpose: 'edit', inputImage: {assetId: sourceId, sha256: hash(bytes)},
    sourceImage: {assetId: sourceId, sha256: hash(bytes), mimeType: 'image/png', byteLength: bytes.length, width: 2, height: 2, name: 'Synthetic source.png', origin: {kind: 'user-import'}}};
}
let output;
async function responseBody() { output ??= await renderMockImagePng(); return Buffer.from(JSON.stringify({data: [{b64_json: output.toString('base64')}]})); }
function transport(body) {
  const state = {calls: 0};
  state.transport = async ({body: requestBody, beforeDispatch}) => { beforeDispatch(); state.calls++; state.body = requestBody; return {body, dispatched: true}; };
  return state;
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
function network({body = Buffer.from('{}'), onEnd, onConnect} = {}) {
  const state = {calls: 0, posts: 0, lookups: 0};
  state.lookup = async hostname => { state.lookups++; assert.equal(hostname, 'api.openai.com'); return answers; };
  state.httpsRequest = (options, callback) => {
    state.calls++; state.options = options; const request = new EventEmitter(); request.destroy = () => {};
    request.end = payload => { state.posts++; state.payload = payload; onEnd?.(); const response = Readable.from([body]); Object.assign(response, {statusCode: 200, headers: {'content-type': 'application/json'}, complete: true}); callback(response); };
    queueMicrotask(() => { const socket = new EventEmitter(); Object.assign(socket, {remoteAddress: '8.8.8.8', remotePort: 443, authorized: true, destroy() {}}); request.emit('socket', socket); onConnect?.(); socket.emit('secureConnect'); });
    return request;
  };
  return state;
}
async function settingsFixture(t) {
  let stored = null; const settings = await createImageSettings({persistence: {load: async () => stored, save: async value => { stored = structuredClone(value); }}});
  t.after(() => settings.close()); await settings.put({expectedRevision: 0, configuration: {...DEFAULT_IMAGE_CONFIGURATION, enabled: true}, secret: {action: 'replace', storage: 'session', value: key}});
  return {settings, persisted: () => stored};
}

test('edit wire is one exact inline PNG with fixed model/options and no source metadata or unsupported parameters', async () => {
  const bytes = sourcePng(), snapshot = input(bytes), body = await createImageEditBody(snapshot, bytes);
  assert.deepEqual(JSON.parse(body), {model: IMAGE_MODELS.openai, prompt: snapshot.prompt, images: [{image_url: `data:image/png;base64,${bytes.toString('base64')}`}], n: 1, quality: 'low', size: '1024x1024', output_format: 'png', background: 'opaque', moderation: 'auto'});
  for (const value of [sourceId, 'Synthetic source.png', 'sourceImage', 'inputImage', 'input_fidelity', 'mask', 'response_format']) assert.equal(body.includes(value), false);
  const original = generation('openai');
  assert.equal(createImageGenerationBody(original), JSON.stringify({model: original.model, prompt: original.prompt, n: 1, quality: 'low', size: '1024x1024', output_format: 'png', background: 'opaque', moderation: 'auto'}));
  assert.throws(() => createImageGenerationBody(snapshot), {code: 'IMAGE_INVALID_REQUEST'});
  assert.equal(IMAGE_NETWORK_LIMITS.maxRequestBytes, 16384);
  const emptyShape = JSON.stringify({model: IMAGE_MODELS.openai, prompt: '', images: [{image_url: 'data:image/png;base64,'}], n: 1, quality: 'low', size: '1024x1024', output_format: 'png', background: 'opaque', moderation: 'auto'});
  assert.equal(IMAGE_EDIT_NETWORK_LIMITS.maxRequestBytes, Buffer.byteLength(emptyShape) + 4 * Math.ceil(IMAGE_EDIT_LIMITS.sourceBytes / 3) + 6 * IMAGE_LIMITS.promptCharacters);
  const escaped = await createImageEditBody({...snapshot, prompt: '\ud800'.repeat(IMAGE_LIMITS.promptCharacters)}, bytes);
  assert.equal(Buffer.byteLength(escaped), Buffer.byteLength(emptyShape) + 4 * Math.ceil(bytes.length / 3) + 6 * IMAGE_LIMITS.promptCharacters);
});

test('malformed trusted source arguments fail before transport: exact Buffer, bounded bytes, paired hash/length and descriptor', async () => {
  const bytes = sourcePng(), snapshot = input(bytes), state = transport(await responseBody()), adapter = createOpenAIImageAdapter(state);
  const badInputs = [{...snapshot, inputImage: {...snapshot.inputImage, sha256: 'f'.repeat(64)}}, {...snapshot, sourceImage: {...snapshot.sourceImage, byteLength: bytes.length + 1}},
    {...snapshot, sourceImage: {...snapshot.sourceImage, width: 1025}}, {...snapshot, sourceImage: {...snapshot.sourceImage, mimeType: 'image/jpeg'}},
    {...snapshot, sourceImage: {...snapshot.sourceImage, path: '/private/source.png'}}, {...snapshot, sourceBytes: bytes.toString('base64')},
    {...snapshot, images: [{image_url: 'https://example.invalid/private.png'}]}, {...snapshot, purpose: undefined}, {...snapshot, inputImage: undefined}, {...snapshot, sourceImage: undefined}];
  for (const value of badInputs) await assert.rejects(adapter.generate(value, {sourceBytes: bytes, beforeDispatch: () => assert.fail('No fence')}), {code: 'IMAGE_INVALID_REQUEST', dispatched: false, outcomeUnknown: false});
  for (const value of [undefined, new Uint8Array(bytes), bytes.toString('base64'), Buffer.alloc(0), Buffer.alloc(IMAGE_EDIT_LIMITS.sourceBytes + 1), Buffer.from(bytes).fill(1)]) await assert.rejects(adapter.generate(snapshot, {sourceBytes: value, beforeDispatch: () => assert.fail('No fence')}), {code: 'IMAGE_INVALID_REQUEST', dispatched: false});
  assert.equal(state.calls, 0);
});

test('source actual PNG content is independently checked, including corruption, dimension mismatch, animation and transparency', async () => {
  const damaged = sourcePng(); damaged[damaged.length - 1] ^= 1;
  for (const [bytes, code] of [[damaged, 'IMAGE_PNG_INVALID'], [sourcePng({alpha: true}), 'IMAGE_PNG_UNSUPPORTED'], [sourcePng({before: [chunk('acTL', Buffer.alloc(8))]}), 'IMAGE_PNG_UNSUPPORTED']]) await assert.rejects(createImageEditBody(input(bytes), bytes), {code, dispatched: false});
  const bytes = sourcePng(); await assert.rejects(createImageEditBody({...input(bytes), sourceImage: {...input(bytes).sourceImage, width: 3}}, bytes), {code: 'IMAGE_PNG_INVALID', dispatched: false});
});

test('edit adapters take a private byte/snapshot copy before validation awaits', async () => {
  const bytes = sourcePng(), expected = Buffer.from(bytes), snapshot = input(bytes), prompt = snapshot.prompt;
  const pending = createImageEditBody(snapshot, bytes); bytes.fill(0); snapshot.prompt = 'Mutated instruction'; snapshot.sourceImage.sha256 = 'a'.repeat(64);
  const body = JSON.parse(await pending); assert.equal(body.images[0].image_url, `data:image/png;base64,${expected.toString('base64')}`); assert.equal(body.prompt, prompt);
});

test('mock edit validates source, fences once and retains the clearly labeled prompt-independent synthetic test card', async () => {
  const bytes = sourcePng(), adapter = createMockImageAdapter(); let fences = 0;
  const edited = await adapter.generate(input(bytes, 'mock'), {sourceBytes: bytes, beforeDispatch: () => { fences++; }});
  const generated = await adapter.generate(generation('mock'), {beforeDispatch: () => { fences++; }});
  assert.deepEqual(edited.bytes, generated.bytes); assert.equal(edited.metadata.isMock, true); assert.equal(edited.metadata.providerRequestId, null); assert.equal(fences, 2);
  await assert.rejects(adapter.generate(input(bytes, 'mock'), {sourceBytes: Buffer.from(bytes).fill(1), beforeDispatch: () => { fences++; }}), {code: 'IMAGE_INVALID_REQUEST', dispatched: false}); assert.equal(fences, 2);
});

test('edit adapter denies custom providers, public byte fields, disabled transport and source bytes on generation', async () => {
  const bytes = sourcePng(), state = transport(await responseBody());
  await assert.rejects(createOpenAIImageAdapter().generate(input(bytes), {sourceBytes: bytes}), {code: 'IMAGE_LIVE_DISABLED', dispatched: false});
  await assert.rejects(createCompatibleImageAdapter(state).generate({...input(bytes), providerId: 'openai-compatible', model: 'custom-model'}, {sourceBytes: bytes, beforeDispatch: () => assert.fail('No fence')}), {code: 'IMAGE_INVALID_REQUEST', dispatched: false});
  await assert.rejects(createOpenAIImageAdapter(state).generate(generation('openai'), {sourceBytes: bytes, beforeDispatch: () => assert.fail('No fence')}), {code: 'IMAGE_INVALID_REQUEST', dispatched: false});
  assert.equal(state.calls, 0);
});

test('edit output decoder and post-fence uncertainty remain unchanged without automatic retry', async () => {
  const bytes = sourcePng();
  for (const body of [Buffer.from(JSON.stringify({data: [{url: 'https://example.invalid/output.png'}]})), Buffer.from('{"data":[],"d\\u0061ta":[]}'), Buffer.from(JSON.stringify({data: [{b64_json: bytes.toString('base64')}]}))]) {
    const state = transport(body); await assert.rejects(createOpenAIImageAdapter(state).generate(input(bytes), {sourceBytes: bytes, beforeDispatch: () => {}}), error => error.dispatched === true && error.outcomeUnknown === true); assert.equal(state.calls, 1);
  }
  const state = transport(await responseBody()), result = await createOpenAIImageAdapter(state).generate(input(bytes), {sourceBytes: bytes, beforeDispatch: () => {}});
  assert.equal(result.metadata.isMock, false); assert.equal(result.metadata.width, 1024); assert.deepEqual(result.bytes, output); assert.equal(state.calls, 1);
});

test('official edit gateway uses dedicated settings key, immutable review, fixed endpoint and synchronous settings→source/task fence→POST', async t => {
  const {settings, persisted} = await settingsFixture(t), bytes = sourcePng(), snapshot = input(bytes), order = [];
  const state = network({body: await responseBody(), onEnd: () => order.push('post')});
  const wrapped = {...settings, [IMAGE_SETTINGS_ASSERT_CURRENT]: expected => { order.push('settings'); queueMicrotask(() => order.push('later')); return settings[IMAGE_SETTINGS_ASSERT_CURRENT](expected); }};
  const result = await createLiveImageGateway({settings: wrapped, ...state, baseUrl: 'https://ignored.example'}).generate(snapshot, {sourceBytes: bytes, settingsRevision: 1, beforeDispatch: () => order.push('source-and-durable')});
  assert.deepEqual(order, ['settings', 'source-and-durable', 'post', 'later']); assert.equal(state.posts, 1); assert.equal(state.options.path, '/v1/images/edits'); assert.equal(state.options.headers.Authorization, `Bearer ${key}`);
  assert.equal(JSON.parse(state.payload).images[0].image_url, `data:image/png;base64,${bytes.toString('base64')}`); assert.equal(result.metadata.isMock, false); assert.equal(JSON.stringify(persisted()).includes(key), false);
});

test('edit gateway snapshots source and public input before credential wait, then rejects changed settings at actual fence', async t => {
  const {settings} = await settingsFixture(t), entered = deferred(), release = deferred(), bytes = sourcePng(), original = Buffer.from(bytes), snapshot = input(bytes), originalPrompt = snapshot.prompt;
  const state = network({body: await responseBody()});
  const wrapped = {...settings, [IMAGE_CREDENTIAL_ACQUIRE]: async expected => { entered.resolve(); await release.promise; return settings[IMAGE_CREDENTIAL_ACQUIRE](expected); }};
  const pending = createLiveImageGateway({settings: wrapped, ...state}).generate(snapshot, {sourceBytes: bytes, settingsRevision: 1, beforeDispatch: () => {}});
  await entered.promise; bytes.fill(0); snapshot.purpose = undefined; snapshot.prompt = 'Changed after review'; snapshot.sourceImage.sha256 = 'a'.repeat(64); release.resolve(); await pending;
  const body = JSON.parse(state.payload); assert.equal(body.prompt, originalPrompt); assert.equal(body.images[0].image_url, `data:image/png;base64,${original.toString('base64')}`); assert.equal(state.options.path, '/v1/images/edits');
  const dnsEntered = deferred(), dnsRelease = deferred(), second = network(); let fences = 0;
  const waiting = createLiveImageGateway({settings, ...second, lookup: () => { dnsEntered.resolve(); return dnsRelease.promise; }}).generate(input(original), {sourceBytes: original, settingsRevision: 1, beforeDispatch: () => { fences++; }});
  await dnsEntered.promise; await settings.put({expectedRevision: 1, configuration: {...DEFAULT_IMAGE_CONFIGURATION, enabled: false}, secret: {action: 'keep'}}); dnsRelease.resolve(answers);
  await assert.rejects(waiting, {code: 'IMAGE_DISPATCH_BLOCKED', dispatched: false, outcomeUnknown: false}); assert.equal(fences, 0); assert.equal(second.posts, 0);
});

test('source/task fence failure after DNS or TLS blocks edits without durable dispatch or POST', async t => {
  const {settings} = await settingsFixture(t), bytes = sourcePng(); let current = true, fences = 0;
  const state = network({onConnect: () => { current = false; }});
  await assert.rejects(createLiveImageGateway({settings, ...state}).generate(input(bytes), {sourceBytes: bytes, settingsRevision: 1, beforeDispatch: () => { fences++; if (!current) throw Error('Synthetic source changed'); }}), {code: 'IMAGE_DISPATCH_BLOCKED', dispatched: false, outcomeUnknown: false});
  assert.equal(fences, 1); assert.equal(state.posts, 0);
});

test('official edit gateway revalidates credential namespace/revision/configuration and never borrows custom or Agent credentials', async t => {
  const {settings} = await settingsFixture(t), bytes = sourcePng();
  const expected = {expectedRevision: 1, configuration: {...DEFAULT_IMAGE_CONFIGURATION, enabled: true}}, valid = await settings[IMAGE_CREDENTIAL_ACQUIRE](expected);
  for (const value of [{...valid, namespace: 'agent'}, {...valid, revision: 2}, {...valid, configuration: {...valid.configuration, model: 'other'}}, {...valid, apiKey: 'private\nheader'}]) {
    const state = network(), wrapped = {...settings, [IMAGE_CREDENTIAL_ACQUIRE]: async () => value};
    await assert.rejects(createLiveImageGateway({settings: wrapped, ...state}).generate(input(bytes), {sourceBytes: bytes, settingsRevision: 1, beforeDispatch: () => assert.fail('No fence')})); assert.equal(state.lookups, 0); assert.equal(state.posts, 0);
  }
  let stored = null; const custom = await createCustomImageSettings({persistence: {load: async () => stored, save: async value => { stored = value; }}}); t.after(() => custom.close());
  const configuration = {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION, enabled: true, baseUrl: 'https://custom.example/v1', model: 'custom-model'};
  await custom.put({expectedRevision: 0, configuration, secret: {action: 'replace', storage: 'session', value: 'synthetic-custom-key'}});
  const state = network(); await assert.rejects(createLiveImageGateway({settings: custom, ...state}).generate(input(bytes), {sourceBytes: bytes, settingsRevision: 1, beforeDispatch: () => assert.fail('No fence')}));
  await assert.rejects(createCompatibleImageGateway({settings: custom, ...state}).generate({...input(bytes), providerId: 'openai-compatible', model: 'custom-model'}, {sourceBytes: bytes, configuration, settingsRevision: 1, beforeDispatch: () => assert.fail('No fence')}));
  assert.equal(state.lookups, 0);
});

test('edit source validation cancellation never fences and post-fence abort keeps existing uncertainty', async () => {
  const bytes = sourcePng(), snapshot = input(bytes), state = transport(await responseBody()), before = new AbortController(); before.abort();
  await assert.rejects(createOpenAIImageAdapter(state).generate(snapshot, {sourceBytes: bytes, signal: before.signal, beforeDispatch: () => assert.fail('No fence')}), {code: 'IMAGE_CANCELLED', dispatched: false, outcomeUnknown: false});
  const during = new AbortController(), pending = createOpenAIImageAdapter(state).generate(snapshot, {sourceBytes: bytes, signal: during.signal, beforeDispatch: () => assert.fail('No fence')}); during.abort();
  await assert.rejects(pending, {code: 'IMAGE_CANCELLED', dispatched: false, outcomeUnknown: false}); assert.equal(state.calls, 0);
  const post = new AbortController(); let attempts = 0;
  const adapter = createOpenAIImageAdapter({transport: async ({beforeDispatch}) => { beforeDispatch(); attempts++; post.abort(); return {body: await responseBody(), dispatched: true}; }});
  await assert.rejects(adapter.generate(snapshot, {sourceBytes: bytes, signal: post.signal, beforeDispatch: () => {}}), {code: 'IMAGE_CANCELLED', dispatched: true, outcomeUnknown: true}); assert.equal(attempts, 1);
});
