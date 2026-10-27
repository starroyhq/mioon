import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createMockImageAdapter, createOpenAIImageAdapter, createCompatibleImageAdapter} from '../packages/business/src/images/adapter.ts';
import {createLiveImageGateway, createCompatibleImageGateway} from '../packages/business/src/images/gateway.ts';
import {createImageEditParameters, createImageGenerationParameters, IMAGE_EDIT_NETWORK_LIMITS, IMAGE_NETWORK_LIMITS} from '../packages/business/src/images/profiles.ts';
import {createImageSettings, createCustomImageSettings, IMAGE_CREDENTIAL_ACQUIRE, IMAGE_SETTINGS_ASSERT_CURRENT} from '../packages/business/src/images/settings.ts';
import {DEFAULT_IMAGE_CONFIGURATION, DEFAULT_CUSTOM_IMAGE_CONFIGURATION} from '../packages/contracts/src/image-settings.ts';
import {IMAGE_EDIT_LIMITS, IMAGE_FIXED_OPTIONS, IMAGE_MODELS, IMAGE_LIMITS} from '../packages/contracts/src/images.ts';
import {renderMockImagePng} from '../packages/business/src/images/png.ts';
import {errorView} from './helpers/test-error.ts';

interface EditSource {assetId: string; sha256: string; mimeType: string; byteLength: number; width: number; height: number; name: string; origin: Record<string, unknown>}
interface EditAdapterInput {providerId: string; model: string; prompt: string; options: Record<string, unknown>; purpose: string | undefined;
  inputImage: {assetId: string; sha256: string}; sourceImage: EditSource; [key: string]: unknown}
interface TransportState {calls: number; body?: unknown; transport?: (context: {body: unknown; beforeDispatch: () => void}) => Promise<{body: Buffer; dispatched: boolean}>}
interface MockHttpsOptions {hostname: string; servername: string; path: string; port: number; method?: string; agent: boolean;
  autoSelectFamily: boolean; rejectUnauthorized: boolean; headers: Record<string, string>;
  checkServerIdentity(name: string, cert: unknown): Error | undefined;
  lookup(host: string, options: {all: boolean}, callback: (error: Error | null, value?: {address: string; family: number}[]) => void): void}
interface NetworkState {calls: number; posts: number; lookups: number; options?: MockHttpsOptions; payload?: Buffer; lookup?: (hostname: string) => Promise<{address: string; family: number}[]>; httpsRequest?: (options: MockHttpsOptions, callback: (response: {statusCode: number; headers: Record<string, string>; complete: boolean}) => void) => void}
interface NetworkOptions {body?: Buffer; onEnd?: () => void; onConnect?: () => void}
type Deferred = {promise: Promise<unknown>; resolve: (value?: unknown) => void};

const sourceId = '11111111-1111-4111-8111-111111111111', key = 'synthetic-official-edit-key', answers = [{address: '8.8.8.8', family: 4}];
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function chunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8);
  let crc = 0xffffffff; for (const byte of bytes.subarray(4, -4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4); return bytes;
}
function sourcePng({alpha = false, before = []}: {alpha?: boolean; before?: Buffer[]} = {}): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), ...before, chunk('IDAT', deflateSync(Buffer.alloc(alpha ? 18 : 14))), chunk('IEND')]);
}
// A minimal baseline JPEG container: SOI, an 8-bit three-component SOF0 frame,
// a scan header, one entropy byte and EOI. Its bytes are sent unchanged.
function sourceJpeg(width: number, height: number): Buffer {
  const frame = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  const scan = Buffer.from([0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), frame, scan, Buffer.from([0x00, 0xff, 0xd9])]);
}
const generation = (providerId: string) => ({providerId, model: (IMAGE_MODELS as Record<string, string>)[providerId], prompt: 'Synthetic exact edit instruction: 蓝色 sky.', options: {...IMAGE_FIXED_OPTIONS}});
function input(bytes: Buffer = sourcePng(), providerId: string|undefined = 'openai'): EditAdapterInput {
  return {...generation(providerId), purpose: 'edit', inputImage: {assetId: sourceId, sha256: hash(bytes)},
    sourceImage: {assetId: sourceId, sha256: hash(bytes), mimeType: 'image/png', byteLength: bytes.length, width: 2, height: 2, name: 'Synthetic source.png', origin: {kind: 'user-import'}}};
}
let output: Buffer | undefined;
async function responseBody() { output ??= await renderMockImagePng(); return Buffer.from(JSON.stringify({data: [{b64_json: output.toString('base64')}]})); }
function transport(body: Buffer): TransportState {
  const state = {calls: 0} as unknown as TransportState;
  state.transport = async ({body: requestBody, beforeDispatch}: {body: unknown; beforeDispatch: () => void}) => { beforeDispatch(); state.calls++; state.body = requestBody; return {body, dispatched: true}; };
  return state;
}
const deferred = (): Deferred => { let resolve: Deferred['resolve'] = () => {}; const promise = new Promise<unknown>(done => { resolve = done; }); return {promise, resolve}; };
function network({body = Buffer.from('{}'), onEnd, onConnect}: NetworkOptions = {}): NetworkState {
  const state = {calls: 0, posts: 0, lookups: 0} as unknown as NetworkState;
  state.lookup = async (hostname: string) => { state.lookups++; assert.equal(hostname, 'api.openai.com'); return answers; };
  state.httpsRequest = (options, callback) => {
    state.calls++; state.options = options; const request = new EventEmitter() as EventEmitter & {destroy: () => void; end: (payload?: Buffer) => void}; request.destroy = () => {};
    request.end = (payload?: Buffer) => { state.posts++; state.payload = payload; onEnd?.(); const response = Readable.from([body]) as Readable & {statusCode: number; headers: Record<string, string>; complete: boolean}; Object.assign(response, {statusCode: 200, headers: {'content-type': 'application/json'}, complete: true}); callback(response); };
    queueMicrotask(() => { const socket = new EventEmitter(); Object.assign(socket, {remoteAddress: '8.8.8.8', remotePort: 443, authorized: true, destroy() {}}); request.emit('socket', socket); onConnect?.(); socket.emit('secureConnect'); });
    return request;
  };
  return state;
}
async function settingsFixture(t: import('node:test').TestContext) {
  let stored: Record<string, unknown> | null = null; const settings = await createImageSettings({persistence: {load: async () => stored, save: async (value: Record<string, unknown>) => { stored = structuredClone(value); }}} as never);
  t.after(() => settings.close()); await settings.put({expectedRevision: 0, configuration: {...DEFAULT_IMAGE_CONFIGURATION, enabled: true}, secret: {action: 'replace', storage: 'session', value: key}});
  return {settings, persisted: () => stored};
}

test('edit SDK parameters contain one local PNG File and fixed options without unsupported moderation or metadata', async () => {
  const bytes = sourcePng(), snapshot = input(bytes), parameters = await createImageEditParameters(snapshot, bytes);
  assert.ok(parameters.image instanceof File); assert.equal(parameters.image.name, 'source.png'); assert.equal(parameters.image.type, 'image/png');
  assert.deepEqual(Buffer.from(await parameters.image.arrayBuffer()), bytes);
  assert.deepEqual({...parameters, image: undefined}, {model: IMAGE_MODELS.openai, prompt: snapshot.prompt, image: undefined, n: 1, quality: 'low', size: '1024x1024', output_format: 'png', background: 'opaque'});
  for (const value of [sourceId, 'Synthetic source.png', 'sourceImage', 'inputImage', 'input_fidelity', 'mask', 'response_format', 'moderation']) assert.equal(JSON.stringify(parameters).includes(value), false);
  const original = generation('openai');
  assert.deepEqual(createImageGenerationParameters(original), {model: original.model, prompt: original.prompt, n: 1, quality: 'low', size: '1024x1024', output_format: 'png', background: 'opaque', moderation: 'auto'});
  assert.throws(() => createImageGenerationParameters(snapshot), {code: 'IMAGE_INVALID_REQUEST'});
  assert.equal(IMAGE_NETWORK_LIMITS.maxRequestBytes, 16384);
  assert.equal(IMAGE_EDIT_NETWORK_LIMITS.maxRequestBytes, IMAGE_EDIT_LIMITS.sourceBytes + 6 * IMAGE_LIMITS.promptCharacters + IMAGE_NETWORK_LIMITS.maxRequestBytes);
  const escaped = await createImageEditParameters({...snapshot, prompt: '\ud800'.repeat(IMAGE_LIMITS.promptCharacters)}, bytes);
  assert.equal(escaped.prompt, '\ud800'.repeat(IMAGE_LIMITS.promptCharacters));
});

test('malformed trusted source arguments fail before transport: exact Buffer, bounded bytes, paired hash/length and descriptor', async () => {
  const bytes = sourcePng(), snapshot = input(bytes), state = transport(await responseBody()), adapter = createOpenAIImageAdapter(state);
  const badInputs = [{...snapshot, inputImage: {...snapshot.inputImage, sha256: 'f'.repeat(64)}}, {...snapshot, sourceImage: {...snapshot.sourceImage, byteLength: bytes.length + 1}},
    {...snapshot, sourceImage: {...snapshot.sourceImage, width: IMAGE_EDIT_LIMITS.sourceMaxEdge + 1}}, {...snapshot, sourceImage: {...snapshot.sourceImage, mimeType: 'image/gif'}},
    {...snapshot, sourceImage: {...snapshot.sourceImage, path: '/private/source.png'}}, {...snapshot, sourceBytes: bytes.toString('base64')},
    {...snapshot, images: [{image_url: 'https://example.invalid/private.png'}]}, {...snapshot, purpose: undefined}, {...snapshot, inputImage: undefined}, {...snapshot, sourceImage: undefined}];
  for (const value of badInputs) await assert.rejects(adapter.generate(value, {sourceBytes: bytes, beforeDispatch: () => assert.fail('No fence')}), {code: 'IMAGE_INVALID_REQUEST', dispatched: false, outcomeUnknown: false});
  // A declared format that the bytes do not match is refused by the format check.
  for (const [mimeType, code] of [['image/jpeg', 'IMAGE_SOURCE_INVALID'], ['image/webp', 'IMAGE_SOURCE_INVALID']] as const) await assert.rejects(adapter.generate({...snapshot, sourceImage: {...snapshot.sourceImage, mimeType}}, {sourceBytes: bytes, beforeDispatch: () => assert.fail('No fence')}), {code, dispatched: false, outcomeUnknown: false});
  for (const value of [undefined, new Uint8Array(bytes), bytes.toString('base64'), Buffer.alloc(0), Buffer.alloc(IMAGE_EDIT_LIMITS.sourceBytes + 1), Buffer.from(bytes).fill(1)]) await assert.rejects(adapter.generate(snapshot, {sourceBytes: value, beforeDispatch: () => assert.fail('No fence')}), {code: 'IMAGE_INVALID_REQUEST', dispatched: false});
  assert.equal(state.calls, 0);
});

test('source actual PNG content is independently checked, including corruption, dimension mismatch, animation and transparency', async () => {
  const damaged = sourcePng(); damaged[damaged.length - 1] ^= 1;
  for (const [bytes, code] of [[damaged, 'IMAGE_PNG_INVALID'], [sourcePng({alpha: true}), 'IMAGE_PNG_UNSUPPORTED'], [sourcePng({before: [chunk('acTL', Buffer.alloc(8))]}), 'IMAGE_PNG_UNSUPPORTED']] as const) await assert.rejects(createImageEditParameters(input(bytes), bytes), {code, dispatched: false});
  const bytes = sourcePng(); await assert.rejects(createImageEditParameters({...input(bytes), sourceImage: {...input(bytes).sourceImage, width: 3}}, bytes), {code: 'IMAGE_PNG_INVALID', dispatched: false});
});

test('edit adapters take a private byte/snapshot copy before validation awaits', async () => {
  const bytes = sourcePng(), expected = Buffer.from(bytes), snapshot = input(bytes), prompt = snapshot.prompt;
  const pending = createImageEditParameters(snapshot, bytes); bytes.fill(0); snapshot.prompt = 'Mutated instruction'; snapshot.sourceImage.sha256 = 'a'.repeat(64);
  const parameters = await pending; assert.ok(parameters.image instanceof File); assert.deepEqual(Buffer.from(await parameters.image.arrayBuffer()), expected); assert.equal(parameters.prompt, prompt);
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
    const state = transport(body); await assert.rejects(createOpenAIImageAdapter(state).generate(input(bytes), {sourceBytes: bytes, beforeDispatch: () => {}}), (error: unknown) => {const failure = errorView(error); return failure.dispatched === true && failure.outcomeUnknown === true;}); assert.equal(state.calls, 1);
  }
  const state = transport(await responseBody()), result = await createOpenAIImageAdapter(state).generate(input(bytes), {sourceBytes: bytes, beforeDispatch: () => {}});
  assert.equal(result.metadata.isMock, false); assert.equal(result.metadata.width, 1024); assert.deepEqual(result.bytes, output); assert.equal(state.calls, 1);
});

test('official edit gateway uses dedicated settings key, immutable review, fixed endpoint and synchronous settings→source/task fence→POST', async t => {
  const {settings, persisted} = await settingsFixture(t), bytes = sourcePng(), snapshot = input(bytes), order: unknown[] = [];
  const state = network({body: await responseBody(), onEnd: () => order.push('post')});
  const wrapped = {...settings, [IMAGE_SETTINGS_ASSERT_CURRENT]: (expected: unknown) => { order.push('settings'); queueMicrotask(() => order.push('later')); return settings[IMAGE_SETTINGS_ASSERT_CURRENT](expected); }};
  const result = await createLiveImageGateway({settings: wrapped, ...state, baseUrl: 'https://ignored.example'} as never).generate(snapshot, {sourceBytes: bytes, settingsRevision: 1, beforeDispatch: () => order.push('source-and-durable')});
  assert.deepEqual(order, ['settings', 'source-and-durable', 'post', 'later']); assert.equal(state.posts, 1); assert.equal(state.options!.path, '/v1/images/edits'); assert.equal(state.options!.headers.Authorization, `Bearer ${key}`);
  const body = await new Response(new Uint8Array(state.payload!), {headers: {'content-type': state.options!.headers['Content-Type']!}}).formData();
  const image = body.get('image'); assert.ok(image instanceof File); assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes); assert.equal(body.has('images'), false); assert.equal(body.has('moderation'), false); assert.equal(result.metadata.isMock, false); assert.equal(JSON.stringify(persisted()).includes(key), false);
});

test('a sized JPEG edit posts one unchanged image/jpeg file with its requested size and accepts only that result size', async t => {
  const {settings} = await settingsFixture(t), bytes = sourceJpeg(4, 3), size = '1536x1152', base = input(bytes);
  const snapshot = {...base, options: {...IMAGE_FIXED_OPTIONS, size}, sourceImage: {...base.sourceImage, mimeType: 'image/jpeg', name: 'Synthetic source.jpg', width: 4, height: 3}};
  const parameters = await createImageEditParameters(snapshot, bytes);
  assert.ok(parameters.image instanceof File); assert.deepEqual([parameters.image.name, parameters.image.type, parameters.size], ['source.jpg', 'image/jpeg', size]);
  // A size outside the model's edit profile, or JPEG bytes labelled as PNG, never reach transport.
  await assert.rejects(createImageEditParameters({...snapshot, options: {...IMAGE_FIXED_OPTIONS, size: '1500x1100'}}, bytes), {code: 'IMAGE_INVALID_REQUEST'});
  await assert.rejects(createImageEditParameters({...snapshot, sourceImage: {...snapshot.sourceImage, mimeType: 'image/png'}}, bytes), {dispatched: false});
  const sized = await renderMockImagePng({width: 1536, height: 1152}), state = network({body: Buffer.from(JSON.stringify({data: [{b64_json: sized.toString('base64')}]}))});
  const result = await createLiveImageGateway({settings, ...state, baseUrl: 'https://ignored.example'} as never).generate(snapshot, {sourceBytes: bytes, settingsRevision: 1, beforeDispatch: () => {}});
  assert.equal(state.posts, 1); assert.equal(state.options!.path, '/v1/images/edits');
  const body = await new Response(new Uint8Array(state.payload!), {headers: {'content-type': state.options!.headers['Content-Type']!}}).formData();
  const image = body.get('image'); assert.ok(image instanceof File); assert.deepEqual([image.name, image.type], ['source.jpg', 'image/jpeg']); assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
  assert.equal(body.get('size'), size); assert.deepEqual([result.metadata.width, result.metadata.height], [1536, 1152]);
  // A square result after the POST is refused and stays an uncertain outcome.
  const square = network({body: await responseBody()});
  await assert.rejects(createLiveImageGateway({settings, ...square, baseUrl: 'https://ignored.example'} as never).generate(snapshot, {sourceBytes: bytes, settingsRevision: 1, beforeDispatch: () => {}}), {dispatched: true});
  assert.equal(square.posts, 1);
});

test('edit gateway snapshots source and public input before credential wait, then rejects changed settings at actual fence', async t => {
  const {settings} = await settingsFixture(t), entered = deferred(), release = deferred(), bytes = sourcePng(), original = Buffer.from(bytes), snapshot = input(bytes), originalPrompt = snapshot.prompt;
  const state = network({body: await responseBody()});
  const wrapped = {...settings, [IMAGE_CREDENTIAL_ACQUIRE]: async (expected: unknown) => { entered.resolve(); await release.promise; return settings[IMAGE_CREDENTIAL_ACQUIRE](expected); }};
  const pending = createLiveImageGateway({settings: wrapped, ...state} as never).generate(snapshot, {sourceBytes: bytes, settingsRevision: 1, beforeDispatch: () => {}});
  await entered.promise; bytes.fill(0); snapshot.purpose = undefined; snapshot.prompt = 'Changed after review'; snapshot.sourceImage.sha256 = 'a'.repeat(64); release.resolve(); await pending;
  const body = await new Response(new Uint8Array(state.payload!), {headers: {'content-type': state.options!.headers['Content-Type']!}}).formData();
  assert.equal(body.get('prompt'), originalPrompt); const image = body.get('image'); assert.ok(image instanceof File); assert.deepEqual(Buffer.from(await image.arrayBuffer()), original); assert.equal(state.options!.path, '/v1/images/edits');
  const dnsEntered = deferred(), dnsRelease = deferred(), second = network(); let fences = 0;
  const waiting = createLiveImageGateway({settings, ...second, lookup: () => { dnsEntered.resolve(); return dnsRelease.promise; }} as never).generate(input(original), {sourceBytes: original, settingsRevision: 1, beforeDispatch: () => { fences++; }});
  await dnsEntered.promise; await settings.put({expectedRevision: 1, configuration: {...DEFAULT_IMAGE_CONFIGURATION, enabled: false}, secret: {action: 'keep'}}); dnsRelease.resolve(answers);
  await assert.rejects(waiting, {code: 'IMAGE_DISPATCH_BLOCKED', dispatched: false, outcomeUnknown: false}); assert.equal(fences, 0); assert.equal(second.posts, 0);
});

test('source/task fence failure after DNS or TLS blocks edits without durable dispatch or POST', async t => {
  const {settings} = await settingsFixture(t), bytes = sourcePng(); let current = true, fences = 0;
  const state = network({onConnect: () => { current = false; }});
  await assert.rejects(createLiveImageGateway({settings, ...state} as never).generate(input(bytes), {sourceBytes: bytes, settingsRevision: 1, beforeDispatch: () => { fences++; if (!current) throw Error('Synthetic source changed'); }}), {code: 'IMAGE_DISPATCH_BLOCKED', dispatched: false, outcomeUnknown: false});
  assert.equal(fences, 1); assert.equal(state.posts, 0);
});

test('official edit gateway revalidates credential namespace/revision/configuration and never borrows custom or Agent credentials', async t => {
  const {settings} = await settingsFixture(t), bytes = sourcePng();
  const expected = {expectedRevision: 1, configuration: {...DEFAULT_IMAGE_CONFIGURATION, enabled: true}}, valid = await settings[IMAGE_CREDENTIAL_ACQUIRE](expected);
  for (const value of [{...valid, namespace: 'agent'}, {...valid, revision: 2}, {...valid, configuration: {...valid.configuration, model: 'other'}}, {...valid, apiKey: 'private\nheader'}]) {
    const state = network(), wrapped = {...settings, [IMAGE_CREDENTIAL_ACQUIRE]: async () => value};
    await assert.rejects(createLiveImageGateway({settings: wrapped, ...state} as never).generate(input(bytes), {sourceBytes: bytes, settingsRevision: 1, beforeDispatch: () => assert.fail('No fence')})); assert.equal(state.lookups, 0); assert.equal(state.posts, 0);
  }
  let stored: unknown = null; const custom = await createCustomImageSettings({persistence: {load: async () => stored, save: async value => { stored = value; }}}); t.after(() => custom.close());
  const configuration = {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION, enabled: true, baseUrl: 'https://custom.example/v1', model: 'custom-model'};
  await custom.put({expectedRevision: 0, configuration, secret: {action: 'replace', storage: 'session', value: 'synthetic-custom-key'}});
  const state = network(); await assert.rejects(createLiveImageGateway({settings: custom, ...state} as never).generate(input(bytes), {sourceBytes: bytes, settingsRevision: 1, beforeDispatch: () => assert.fail('No fence')}));
  await assert.rejects(createCompatibleImageGateway({settings: custom, ...state} as unknown as Parameters<typeof createCompatibleImageGateway>[0]).generate({...input(bytes), providerId: 'openai-compatible', model: 'custom-model'}, {sourceBytes: bytes, configuration, settingsRevision: 1, beforeDispatch: () => assert.fail('No fence')}));
  assert.equal(state.lookups, 0);
});

test('edit source validation cancellation never fences and post-fence abort keeps existing uncertainty', async () => {
  const bytes = sourcePng(), snapshot = input(bytes), state = transport(await responseBody()), before = new AbortController(); before.abort();
  await assert.rejects(createOpenAIImageAdapter(state).generate(snapshot, {sourceBytes: bytes, signal: before.signal, beforeDispatch: () => assert.fail('No fence')}), {code: 'IMAGE_CANCELLED', dispatched: false, outcomeUnknown: false});
  const during = new AbortController(), pending = createOpenAIImageAdapter(state).generate(snapshot, {sourceBytes: bytes, signal: during.signal, beforeDispatch: () => assert.fail('No fence')}); during.abort();
  await assert.rejects(pending, {code: 'IMAGE_CANCELLED', dispatched: false, outcomeUnknown: false}); assert.equal(state.calls, 0);
  const post = new AbortController(); let attempts = 0;
  const adapter = createOpenAIImageAdapter({transport: async ({beforeDispatch}: {beforeDispatch(): unknown}) => { beforeDispatch(); attempts++; post.abort(); return {body: await responseBody(), dispatched: true}; }});
  await assert.rejects(adapter.generate(snapshot, {sourceBytes: bytes, signal: post.signal, beforeDispatch: () => {}}), {code: 'IMAGE_CANCELLED', dispatched: true, outcomeUnknown: true}); assert.equal(attempts, 1);
});
