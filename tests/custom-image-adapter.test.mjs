import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompatibleImageAdapter, createOpenAIImageAdapter} from '../packages/business/src/images/adapter.ts';
import {createCompatibleImageGenerationBody, createImageGenerationBody, CUSTOM_IMAGE_JSON_PROFILE, IMAGE_GENERATION_ENDPOINT, IMAGE_PROFILES} from '../packages/business/src/images/profiles.ts';
import {IMAGE_FIXED_OPTIONS, IMAGE_MODELS} from '../packages/contracts/src/images.ts';
import {CUSTOM_IMAGE_PROFILE_ID} from '../packages/contracts/src/image-settings.ts';
import {renderMockImagePng} from '../packages/business/src/images/png.ts';

const input = {providerId: 'openai-compatible', model: 'vendor/model-EXACT_v1:2026.10', prompt: 'Original prompt: 蓝色 sky, with exact punctuation.', options: {...IMAGE_FIXED_OPTIONS}};
let bytes;
async function png() { return bytes ??= await renderMockImagePng(); }
async function validBody() { return Buffer.from(JSON.stringify({data: [{b64_json: (await png()).toString('base64')}]})); }
function responseTransport(body) {
  const state = {posts: 0};
  state.transport = async ({body: request, beforeDispatch}) => {
    beforeDispatch(); state.posts++; state.body = request;
    return {body, dispatched: true, providerRequestId: 'req_synthetic-custom'};
  };
  return state;
}

test('explicit custom profile sends exact model/prompt with fixed conservative JSON bytes', () => {
  const expected = JSON.stringify({model: input.model, prompt: input.prompt, n: 1, quality: 'low', size: '1024x1024', output_format: 'png', background: 'opaque', moderation: 'auto'});
  assert.equal(createCompatibleImageGenerationBody(input), expected);
  assert.equal(CUSTOM_IMAGE_JSON_PROFILE.profileId, CUSTOM_IMAGE_PROFILE_ID);
  assert.equal(CUSTOM_IMAGE_JSON_PROFILE.providerId, 'openai-compatible');
  assert.equal(CUSTOM_IMAGE_JSON_PROFILE.request.moderation, 'auto');
  assert.deepEqual(CUSTOM_IMAGE_JSON_PROFILE.response, {format: 'b64_json', mimeType: 'image/png', count: 1});
  assert.ok(Object.isFrozen(CUSTOM_IMAGE_JSON_PROFILE)); assert.ok(Object.isFrozen(CUSTOM_IMAGE_JSON_PROFILE.request));
  for (const value of [{...input, providerId: 'openai'}, {...input, model: ''}, {...input, model: 'm'.repeat(121)}, {...input, model: 'model with whitespace'},
    {...input, baseUrl: 'https://images.example/v1'}, {...input, apiKey: 'synthetic-forbidden'}, {...input, prompt: 'x'.repeat(2001)},
    {...input, options: {...IMAGE_FIXED_OPTIONS, n: 2}}, {...input, options: {...IMAGE_FIXED_OPTIONS, quality: 'high'}},
    {...input, options: {...IMAGE_FIXED_OPTIONS, outputFormat: 'jpeg'}}, {...input, options: {...IMAGE_FIXED_OPTIONS, size: '512x512'}},
    {...input, options: {...IMAGE_FIXED_OPTIONS, background: 'transparent'}}]) {
    assert.throws(() => createCompatibleImageGenerationBody(value), {code: 'IMAGE_INVALID_REQUEST', dispatched: false, outcomeUnknown: false});
  }
});

test('official body remains byte-identical and cannot inherit custom model or activation', () => {
  const official = {...input, providerId: 'openai', model: IMAGE_MODELS.openai};
  assert.equal(createImageGenerationBody(official), '{"model":"gpt-image-2.5-flare-2026-09-08","prompt":"Original prompt: 蓝色 sky, with exact punctuation.","n":1,"quality":"low","size":"1024x1024","output_format":"png","background":"opaque","moderation":"auto"}');
  assert.throws(() => createImageGenerationBody(input), {code: 'IMAGE_INVALID_REQUEST'});
  assert.throws(() => createImageGenerationBody({...official, model: input.model}), {code: 'IMAGE_INVALID_REQUEST'});
  assert.equal(IMAGE_GENERATION_ENDPOINT, 'https://api.openai.com/v1/images/generations');
  assert.equal(IMAGE_PROFILES.find(profile => profile.providerId === 'openai').enabled, false);
});

test('custom adapter has no transport, environment or official fallback by default', async () => {
  const snapshot = new Proxy({}, {get() { assert.fail('Disabled adapter must not inspect input'); }});
  await assert.rejects(createCompatibleImageAdapter().generate(snapshot), {code: 'IMAGE_LIVE_DISABLED', dispatched: false, outcomeUnknown: false});
  await assert.rejects(createOpenAIImageAdapter().generate(snapshot), {code: 'IMAGE_LIVE_DISABLED', dispatched: false, outcomeUnknown: false});
});

test('custom adapter fences exactly once and uses the shared validated single-PNG response decoder', async () => {
  const state = responseTransport(await validBody()); let fences = 0;
  const result = await createCompatibleImageAdapter(state).generate(input, {beforeDispatch: () => { fences++; }});
  assert.equal(state.posts, 1); assert.equal(fences, 1); assert.equal(state.body, createCompatibleImageGenerationBody(input));
  assert.deepEqual(result.bytes, await png()); assert.equal(result.metadata.isMock, false);
  assert.equal(result.metadata.providerRequestId, 'req_synthetic-custom'); assert.equal(result.metadata.width, 1024); assert.equal(result.metadata.height, 1024);
});

test('URL/multiple results, extra fields, duplicate keys and malformed PNG fail once after dispatch without download/fallback', async () => {
  const b64 = (await png()).toString('base64');
  const cases = [
    [{data: [{url: 'https://other.example/image.png'}]}, 'IMAGE_RESPONSE_INVALID'],
    [{data: [{b64_json: b64, url: 'https://other.example/image.png'}]}, 'IMAGE_RESPONSE_INVALID'],
    [{data: [{b64_json: b64}, {b64_json: b64}]}, 'IMAGE_RESPONSE_INVALID'],
    [{data: []}, 'IMAGE_RESPONSE_INVALID'],
    [{data: [{b64_json: b64}], size: '512x512'}, 'IMAGE_RESPONSE_INVALID'],
    [{data: [{b64_json: b64}], revised_prompt: 'Silently revised'}, 'IMAGE_RESPONSE_INVALID'],
    [{data: [{b64_json: `${b64}\n`}]}, 'IMAGE_RESPONSE_INVALID'],
    [{data: [{b64_json: Buffer.from('not PNG').toString('base64')}]}, 'IMAGE_PNG_INVALID'],
  ];
  for (const [value, code] of cases) {
    const state = responseTransport(Buffer.from(JSON.stringify(value)));
    await assert.rejects(createCompatibleImageAdapter(state).generate(input, {beforeDispatch: () => {}}), {code, dispatched: true, outcomeUnknown: true});
    assert.equal(state.posts, 1);
  }
  const duplicate = responseTransport(Buffer.from('{"data":[],"d\\u0061ta":[]}'));
  await assert.rejects(createCompatibleImageAdapter(duplicate).generate(input, {beforeDispatch: () => {}}), {code: 'IMAGE_RESPONSE_INVALID', dispatched: true, outcomeUnknown: true});
  assert.equal(duplicate.posts, 1);
});

test('custom validation and cancellation before transport do not pass a fence or send', async () => {
  const state = responseTransport(await validBody()), adapter = createCompatibleImageAdapter(state);
  await assert.rejects(adapter.generate({...input, providerId: 'mock'}, {beforeDispatch: () => assert.fail('No fence')}), {code: 'IMAGE_INVALID_REQUEST', dispatched: false});
  const controller = new AbortController(); controller.abort();
  await assert.rejects(adapter.generate(input, {signal: controller.signal, beforeDispatch: () => assert.fail('No fence')}), {code: 'IMAGE_CANCELLED', dispatched: false});
  await assert.rejects(adapter.generate(input), {code: 'IMAGE_DISPATCH_BLOCKED', dispatched: false});
  assert.equal(state.posts, 0);
});

test('custom unknown transport errors and malformed responses stay dispatched and never cause retries', async () => {
  for (const response of ['throw', 'malformed']) {
    let attempts = 0;
    const transport = async ({beforeDispatch}) => { attempts++; beforeDispatch(); if (response === 'throw') throw Error('synthetic private upstream message'); return {}; };
    await assert.rejects(createCompatibleImageAdapter({transport}).generate(input, {beforeDispatch: () => {}}), {code: 'IMAGE_RESPONSE_INVALID', dispatched: true, outcomeUnknown: true});
    assert.equal(attempts, 1);
  }
});
