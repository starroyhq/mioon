import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createImageSdkFetch, requestImageWithSdk} from '../packages/business/src/images/sdk.ts';
import type {ImageSdkParameters, ImageSdkPost} from '../packages/business/src/images/sdk.ts';
import {createImageGenerationParameters, createImageEditParameters, createCompatibleImageGenerationParameters, IMAGE_GENERATION_ENDPOINT, IMAGE_EDIT_ENDPOINT, IMAGE_EDIT_NETWORK_LIMITS, imageAdapterError} from '../packages/business/src/images/profiles.ts';
import {IMAGE_FIXED_OPTIONS, IMAGE_MODELS, IMAGE_EDIT_LIMITS} from '../packages/contracts/src/images.ts';
import {renderMockImagePng} from '../packages/business/src/images/png.ts';
import type {ImageTransportRequest} from '../packages/business/src/images/network.ts';

const snapshot = {providerId: 'openai', model: IMAGE_MODELS.openai, prompt: 'SDK boundary: 蓝色 sky.', options: {...IMAGE_FIXED_OPTIONS}};
const call = (): ImageSdkParameters => ({kind: 'generate', parameters: createImageGenerationParameters(snapshot)});
const response = () => ({body: Buffer.from('{}'), providerRequestId: 'req_sdk', dispatched: true});
const init = (request = call()) => ({method: 'POST', body: JSON.stringify(request.parameters), headers: {'content-type': 'application/json'}});
async function edit() {
  const bytes = await renderMockImagePng(), sha256 = createHash('sha256').update(bytes).digest('hex'), assetId = '11111111-1111-4111-8111-111111111111';
  const parameters = await createImageEditParameters({...snapshot, purpose: 'edit', inputImage: {assetId, sha256}, sourceImage: {assetId, sha256, byteLength: bytes.length, width: 1024, height: 1024, mimeType: 'image/png', name: '/private/not-sent.png', origin: {kind: 'user-import'}}}, bytes);
  return {bytes, call: {kind: 'edit', parameters} satisfies ImageSdkParameters};
}
const form = (request: ImageTransportRequest): Promise<FormData> => {
  assert.ok(Buffer.isBuffer(request.body)); assert.equal(typeof request.contentType, 'string');
  return new Response(new Uint8Array(request.body), {headers: {'content-type': request.contentType as string}}).formData();
};

test('real SDK generation preserves JSON fields and ignores ambient credentials, URLs and logging', async t => {
  const names = ['OPENAI_API_KEY', 'OPENAI_ADMIN_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'OPENAI_LOG', 'OPENAI_CUSTOM_HEADERS'] as const;
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; for (const name of names) { if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name]; } });
  for (const name of names) process.env[name] = name === 'OPENAI_LOG' ? 'debug' : 'synthetic-ambient-must-not-send';
  process.env.OPENAI_CUSTOM_HEADERS = 'X-Ambient: synthetic-ambient-must-not-send\nAuthorization: Bearer synthetic-ambient-must-not-send';
  globalThis.fetch = async () => assert.fail('SDK cannot use ambient network or FormData probe');
  let calls = 0, fences = 0;
  const received = await requestImageWithSdk(call(), {post: async request => {
    calls++; assert.equal(request.body, JSON.stringify(call().parameters)); assert.equal(request.contentType, 'application/json');
    assert.deepEqual(Object.keys(request).sort(), ['beforeDispatch', 'body', 'contentType', 'signal']);
    assert.equal(String(request.body).includes('synthetic-ambient'), false);
    (request.beforeDispatch as () => void)(); return response();
  }, beforeDispatch: () => { fences++; }, baseUrl: 'https://ignored.invalid/override'});
  assert.equal(calls, 1); assert.equal(fences, 1); assert.equal(received.providerRequestId, 'req_sdk');
});

test('real SDK native edit yields one multipart local File, fixed parameters and no JSON/moderation fallback or data probe', async t => {
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => assert.fail('No ambient fetch, including data:, probe');
  const prepared = await edit(); let attempts = 0, fences = 0;
  await requestImageWithSdk(prepared.call, {post: async request => {
    attempts++; const body = await form(request), image = body.get('image');
    assert.ok(image instanceof File); assert.equal(image.name, 'source.png'); assert.equal(image.type, 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), prepared.bytes);
    assert.deepEqual([...body.keys()].sort(), ['background', 'image', 'model', 'n', 'output_format', 'prompt', 'quality', 'size']);
    assert.equal(body.get('model'), snapshot.model); assert.equal(body.get('prompt'), snapshot.prompt); assert.equal(body.get('n'), '1');
    assert.equal(body.get('quality'), 'low'); assert.equal(body.get('size'), '1024x1024'); assert.equal(body.get('output_format'), 'png'); assert.equal(body.get('background'), 'opaque');
    assert.ok(Buffer.isBuffer(request.body)); assert.ok(request.body.length <= IMAGE_EDIT_NETWORK_LIMITS.maxRequestBytes);
    (request.beforeDispatch as () => void)(); return response();
  }, beforeDispatch: () => { fences++; }});
  assert.equal(attempts, 1); assert.equal(fences, 1);
});

test('real SDK custom generation accepts canonical custom prefix and exact vendor model without provider fallback', async () => {
  const parameters = createCompatibleImageGenerationParameters({...snapshot, providerId: 'openai-compatible', model: 'vendor/exact-model:1'});
  let attempts = 0;
  await requestImageWithSdk({kind: 'generate', parameters}, {compatible: true, baseUrl: 'https://images.example/prefix/v1', beforeDispatch() {}, post: async request => { attempts++; assert.deepEqual(JSON.parse(String(request.body)), parameters); (request.beforeDispatch as () => void)(); return response(); }});
  assert.equal(attempts, 1);
});

test('single fetch guard rejects changed URL/method/body and never permits a later valid request', async () => {
  for (const [url, options] of [[IMAGE_EDIT_ENDPOINT, init()], [IMAGE_GENERATION_ENDPOINT, {...init(), method: 'GET'}], [IMAGE_GENERATION_ENDPOINT, {...init(), body: '{}'}]] as const) {
    let posts = 0;
    const bridge = createImageSdkFetch(call(), {post: async () => { posts++; return response(); }, beforeDispatch() {}});
    await assert.rejects(bridge.fetch(url, options), {code: 'IMAGE_INVALID_REQUEST', dispatched: false});
    await assert.rejects(bridge.fetch(IMAGE_GENERATION_ENDPOINT, init()), {code: 'IMAGE_INVALID_REQUEST', dispatched: false});
    assert.equal(posts, 0);
  }
});

test('a repeated SDK fetch preserves prior dispatch evidence and the first trusted transport failure', async () => {
  for (const fail of [false, true]) {
    let posts = 0;
    const original = imageAdapterError('IMAGE_TIMEOUT', {dispatched: true});
    const post: ImageSdkPost = async request => { posts++; (request.beforeDispatch as () => void)(); if (fail) throw original; return response(); };
    const bridge = createImageSdkFetch(call(), {post, beforeDispatch() {}});
    if (fail) await assert.rejects(bridge.fetch(IMAGE_GENERATION_ENDPOINT, init()), error => error === original);
    else await bridge.fetch(IMAGE_GENERATION_ENDPOINT, init());
    await assert.rejects(bridge.fetch(IMAGE_GENERATION_ENDPOINT, init()), {code: 'IMAGE_INVALID_REQUEST', dispatched: true, outcomeUnknown: true});
    assert.equal(posts, 1);
    if (fail) assert.equal(bridge.failure(), original);
  }
});

test('multipart boundary rejects missing/duplicate/changed fields, changed bytes and metadata before host transport', async () => {
  const prepared = await edit(); assert.ok(prepared.call.parameters.image instanceof File);
  for (const mutate of [(body: FormData) => body.delete('image'), (body: FormData) => body.append('prompt', snapshot.prompt), (body: FormData) => body.set('moderation', 'auto'), (body: FormData) => body.set('prompt', 'Changed'), (body: FormData) => body.set('image', new File([new Uint8Array(prepared.bytes)], '/private/secret.png', {type: 'image/png'})), (body: FormData) => body.set('image', new File([new Uint8Array(Buffer.from(prepared.bytes).fill(1))], 'source.png', {type: 'image/png'}))]) {
    const body = new FormData(); for (const [key, value] of Object.entries(prepared.call.parameters)) body.append(key, value instanceof File ? value : String(value)); mutate(body);
    let posts = 0; const bridge = createImageSdkFetch(prepared.call, {post: async () => { posts++; return response(); }, beforeDispatch() {}});
    await assert.rejects(bridge.fetch(IMAGE_EDIT_ENDPOINT, {method: 'POST', body}), {code: 'IMAGE_INVALID_REQUEST', dispatched: false}); assert.equal(posts, 0);
  }
});

test('multipart file size is rejected before serialization or host transport', async () => {
  const prepared = await edit(); prepared.call.parameters.image = new File([new Uint8Array(IMAGE_EDIT_LIMITS.sourceBytes + 1)], 'source.png', {type: 'image/png'});
  const body = new FormData(); for (const [key, value] of Object.entries(prepared.call.parameters)) body.append(key, value instanceof File ? value : String(value));
  let posts = 0; const bridge = createImageSdkFetch(prepared.call, {post: async () => { posts++; return response(); }, beforeDispatch() {}});
  await assert.rejects(bridge.fetch(IMAGE_EDIT_ENDPOINT, {method: 'POST', body}), {code: 'IMAGE_INVALID_REQUEST', dispatched: false}); assert.equal(posts, 0);
});

test('real SDK failure after dispatch never retries and preserves trusted safe error identity', async () => {
  for (const kind of ['generate', 'edit'] as const) {
    const request = kind === 'edit' ? (await edit()).call : call(); let attempts = 0;
    const failure = imageAdapterError('IMAGE_TIMEOUT', {dispatched: true});
    await assert.rejects(requestImageWithSdk(request, {post: async context => { attempts++; (context.beforeDispatch as () => void)(); throw failure; }, beforeDispatch() {}}), error => error === failure);
    assert.equal(attempts, 1);
  }
});
