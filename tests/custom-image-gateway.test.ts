import type {RequestOptions} from 'node:https';
import type {Failure} from './helpers/strict-timeline-audio-types.ts';
interface TestNetwork {created:number;posts:number;lookups:number;hostname?:unknown;options?:RequestOptions&{hostname:string;path:string;headers:Record<string,string>};payload?:string;lookup:(hostname?:unknown,options?:unknown)=>unknown;httpsRequest:(options:RequestOptions&{hostname:string;path:string;headers:Record<string,string>},callback:(response:Readable)=>void)=>EventEmitter}
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createCompatibleImageGateway, createLiveImageGateway, type ReviewedImageGatewayOptions} from '../packages/business/src/images/gateway.ts';
import {createCustomImageSettings, createImageSettings, IMAGE_CREDENTIAL_ACQUIRE, IMAGE_SETTINGS_ASSERT_CURRENT} from '../packages/business/src/images/settings.ts';
import {DEFAULT_CUSTOM_IMAGE_CONFIGURATION, DEFAULT_IMAGE_CONFIGURATION, CUSTOM_IMAGE_SETTINGS_NAMESPACE} from '../packages/contracts/src/image-settings.ts';
import {IMAGE_FIXED_OPTIONS, IMAGE_MODELS} from '../packages/contracts/src/images.ts';
import {renderMockImagePng} from '../packages/business/src/images/png.ts';

const key = 'synthetic-custom-gateway-key', officialKey = 'synthetic-official-gateway-key';
const configuration = {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION, enabled: true, baseUrl: 'https://custom-images.example/proxy/v1', model: 'vendor/reviewed-image-EXACT-v1'};
const input = {providerId: 'openai-compatible', model: configuration.model, prompt: 'Exact reviewed prompt: 蓝色 sky.', options: {...IMAGE_FIXED_OPTIONS}};
const answers = [{address: '8.8.8.8', family: 4}];
const deferred = <T = unknown>() => { let resolve!: (value?: T | PromiseLike<T>) => void; const promise = new Promise<T>(done => { resolve = (done as (value?: T | PromiseLike<T>) => void); }); return {promise, resolve}; };
let pngBytes: Buffer<ArrayBufferLike>;
async function body() { pngBytes ??= await renderMockImagePng(); return Buffer.from(JSON.stringify({data: [{b64_json: pngBytes.toString('base64')}]})); }
async function settingsFixture(t: test.TestContext, {official = false, save}:{official?:boolean;save?:(value:unknown)=>unknown} = {}) {
  let stored: unknown = null;
  const settings = await (official ? createImageSettings : createCustomImageSettings)({persistence: {load: async () => stored, save: async value => { await save?.(value); stored = structuredClone(value); }}});
  t.after(() => settings.close());
  await settings.put({expectedRevision: 0, configuration: official ? {...DEFAULT_IMAGE_CONFIGURATION, enabled: true} : configuration,
    secret: {action: 'replace', storage: 'session', value: official ? officialKey : key}});
  return {settings, read: () => stored};
}
function network({responseBody = Buffer.from('{}'), onEnd, onConnect}:{responseBody?:Buffer;onEnd?:()=>unknown;onConnect?:()=>unknown} = {}) {
  const state = {created:0,posts:0,lookups:0} as TestNetwork;
  state.lookup = async (hostname: unknown) => { state.lookups++; state.hostname = hostname; return answers; };
  state.httpsRequest = (options:RequestOptions&{hostname:string;path:string;headers:Record<string,string>}, callback: (arg0: Readable) => void) => {
    state.created++; state.options = options;
    const request = new EventEmitter() as EventEmitter&{destroy:()=>void;end:(payload:string)=>void}; request.destroy = () => {};
    request.end = (payload: string) => {
      state.posts++; state.payload = payload; onEnd?.();
      const response = Readable.from([responseBody]);
      Object.assign(response, {statusCode: 200, headers: {'content-type': 'application/json'}, complete: true}); callback(response);
    };
    queueMicrotask(() => {
      const socket = new EventEmitter(); Object.assign(socket, {remoteAddress: '8.8.8.8', remotePort: 443, authorized: true, destroy() {}});
      request.emit('socket', socket); onConnect?.(); socket.emit('secureConnect');
    });
    return request;
  };
  return state;
}
const generate = (settings:unknown, state:TestNetwork, options:NonNullable<Parameters<ReturnType<typeof createCompatibleImageGateway>["generate"]>[1]> = {}, snapshot:unknown = input) => createCompatibleImageGateway({settings, ...state} as unknown as ReviewedImageGatewayOptions).generate(snapshot,
  {configuration, settingsRevision: 1, beforeDispatch: () => {}, ...options});

test('custom gateway sends only custom slot key to immutable reviewed destination and model with synchronous assertion→durable fence→POST', async t => {
  const {settings, read} = await settingsFixture(t), order: ("post" | "settings" | "later-turn" | "durable")[] = [];
  const state = network({responseBody: await body(), onEnd: () => order.push('post')});
  const wrapped = {...settings, get: () => assert.fail('Never derive reviewed configuration from a current getter'),
    [IMAGE_CREDENTIAL_ACQUIRE]: (expected:{expectedRevision:number;configuration:typeof configuration}) => { assert.equal(expected.configuration.baseUrl, configuration.baseUrl); return settings[IMAGE_CREDENTIAL_ACQUIRE](expected); },
    [IMAGE_SETTINGS_ASSERT_CURRENT]: (expected:{expectedRevision:number;configuration:typeof configuration}) => { order.push('settings'); queueMicrotask(() => order.push('later-turn')); return settings[IMAGE_SETTINGS_ASSERT_CURRENT](expected); }};
  const result = await generate(wrapped, state, {beforeDispatch: () => order.push('durable')});
  assert.deepEqual(order, ['settings', 'durable', 'post', 'later-turn']);
  assert.equal(state.posts, 1); assert.equal(state.lookups, 1); assert.equal(state.hostname, 'custom-images.example');
  assert.equal(state.options!.hostname, 'custom-images.example'); assert.equal(state.options!.path, '/proxy/v1/images/generations');
  assert.equal(state.options!.headers.Authorization, `Bearer ${key}`); assert.notEqual(state.options!.headers.Authorization, `Bearer ${officialKey}`);
  assert.equal(JSON.parse(state.payload!).model, configuration.model); assert.equal(JSON.parse(state.payload!).prompt, input.prompt);
  assert.equal(JSON.parse(state.payload!).moderation, 'auto'); assert.deepEqual(result.bytes, pngBytes); assert.equal(result.metadata.isMock, false);
  assert.equal(JSON.stringify(read()).includes(key), false);
});

test('caller mutations during credential acquisition cannot change reviewed config, model, prompt or options', async t => {
  const {settings} = await settingsFixture(t), entered = deferred(), release = deferred(), state = network({responseBody: await body()});
  const reviewed = structuredClone(configuration) as Omit<typeof configuration,"options">&{options:Record<string,unknown>}, snapshot = structuredClone(input) as Omit<typeof input,"options">&{options:Record<string,unknown>};
  const wrapped = {...settings, [IMAGE_CREDENTIAL_ACQUIRE]: async (expected:{expectedRevision:number;configuration:typeof configuration}) => {
    assert.ok(Object.isFrozen(expected)); assert.ok(Object.isFrozen(expected.configuration)); assert.ok(Object.isFrozen(expected.configuration.options));
    entered.resolve!(); await release.promise; return settings[IMAGE_CREDENTIAL_ACQUIRE](expected);
  }};
  const pending = generate(wrapped, state, {configuration: reviewed}, snapshot);
  await entered.promise;
  reviewed.baseUrl = 'https://other.example/v1'; reviewed.model = 'changed-model'; reviewed.options.n = 2;
  snapshot.model = 'changed-model'; snapshot.prompt = 'Changed prompt'; snapshot.options.quality = 'high';
  release.resolve!(); await pending;
  assert.equal(state.options!.hostname, 'custom-images.example'); assert.equal(JSON.parse(state.payload!).model, input.model);
  assert.equal(JSON.parse(state.payload!).prompt, input.prompt); assert.equal(JSON.parse(state.payload!).quality, 'low'); assert.equal(state.posts, 1);
});

test('custom gateway rejects missing, disabled, incomplete or nonmatching reviewed configuration before credential/DNS', async () => {
  let acquisitions = 0; const settings = {[IMAGE_CREDENTIAL_ACQUIRE]: () => { acquisitions++; assert.fail('No credential access'); }};
  for (const reviewed of [undefined, DEFAULT_CUSTOM_IMAGE_CONFIGURATION, {...configuration, enabled: false}, {...configuration, model: 'different'},
    {...configuration, baseUrl: 'https://127.0.0.1/v1'}, {...configuration, connectionId: 'other'}, {...configuration, unknown: true}]) {
    const state = network(); await assert.rejects(generate(settings, state, {configuration: reviewed}));
    assert.equal(state.lookups, 0); assert.equal(state.created, 0); assert.equal(state.posts, 0);
  }
  assert.equal(acquisitions, 0);
});

test('an official engine/key cannot be used by custom gateway and custom engine cannot be used by official gateway', async t => {
  const custom = await settingsFixture(t), official = await settingsFixture(t, {official: true});
  const a = network(), b = network();
  await assert.rejects(generate(official.settings, a), {code: 'IMAGE_SETTINGS_VALIDATION'});
  await assert.rejects(createLiveImageGateway({settings: custom.settings, ...b} as unknown as ReviewedImageGatewayOptions).generate({...input, providerId: 'openai', model: IMAGE_MODELS.openai}, {settingsRevision: 1, beforeDispatch: () => assert.fail('No dispatch')}), {code: 'IMAGE_SETTINGS_VALIDATION'});
  assert.equal(a.lookups + b.lookups, 0); assert.equal(a.posts + b.posts, 0);
});

test('credential result namespace, revision and full binding are revalidated before any DNS', async t => {
  const {settings} = await settingsFixture(t);
  const expected = {expectedRevision: 1, configuration};
  const credential = await settings[IMAGE_CREDENTIAL_ACQUIRE](expected);
  assert.equal(credential.namespace, CUSTOM_IMAGE_SETTINGS_NAMESPACE);
  for (const value of [{...credential, namespace: 'mioon.images.openai.v1'}, {...credential, revision: 2},
    {...credential, configuration: {...configuration, baseUrl: 'https://other.example/v1'}}, {...credential, configuration: {...configuration, model: 'different'}}]) {
    const state = network(), wrapped = {...settings, [IMAGE_CREDENTIAL_ACQUIRE]: async () => value};
    await assert.rejects(generate(wrapped, state), {code: 'IMAGE_SETTINGS_CONFLICT'});
    assert.equal(state.lookups, 0); assert.equal(state.posts, 0);
  }
});

test('config/revision changed while DNS resolves blocks final durable fence and POST without redirecting to new config', async t => {
  const {settings} = await settingsFixture(t), entered = deferred(), release = deferred(), state = network(); let fences = 0;
  const pending = generate(settings, {...state, lookup: (hostname: unknown) => { assert.equal(hostname, 'custom-images.example'); entered.resolve!(); return release.promise; }}, {beforeDispatch: () => fences++});
  await entered.promise;
  await settings.put({expectedRevision: 1, configuration: {...configuration, baseUrl: 'https://changed.example/v1', model: 'changed-model'}, secret: {action: 'replace', storage: 'session', value: 'synthetic-replacement-key'}});
  release.resolve!(answers);
  await assert.rejects(pending, {code: 'IMAGE_DISPATCH_BLOCKED', dispatched: false, outcomeUnknown: false});
  assert.equal(state.options!.hostname, 'custom-images.example'); assert.equal(state.posts, 0); assert.equal(fences, 0);
});

test('pending persistence blocks custom dispatch even before revision changes', async t => {
  let hold = false; const writeEntered = deferred(), writeRelease = deferred(), dnsEntered = deferred(), dnsRelease = deferred();
  const {settings} = await settingsFixture(t, {save: async () => { if (hold) { writeEntered.resolve!(); await writeRelease.promise; } }});
  const state = network(); let fences = 0;
  const pending = generate(settings, {...state, lookup: () => { dnsEntered.resolve!(); return dnsRelease.promise; }}, {beforeDispatch: () => fences++});
  await dnsEntered.promise; hold = true;
  const write = settings.put({expectedRevision: 1, configuration: {...configuration, enabled: false}, secret: {action: 'keep'}});
  await writeEntered.promise; dnsRelease.resolve!(answers);
  try {
    await assert.rejects(pending, {code: 'IMAGE_DISPATCH_BLOCKED', dispatched: false, outcomeUnknown: false});
    assert.equal(state.posts, 0); assert.equal(fences, 0);
  } finally { writeRelease.resolve!(); await write; }
});

for (const phase of ['before-acquire', 'during-dns', 'after-post']) {
  test(`custom gateway abort ${phase} preserves unknown-after-POST and does not retry`, async t => {
    const {settings} = await settingsFixture(t), controller = new AbortController(), entered = deferred(), release = deferred(); let fences = 0;
    const state = network({onEnd: phase === 'after-post' ? () => controller.abort() : undefined});
    if (phase === 'before-acquire') controller.abort();
    const pending = generate(settings, {...state, ...(phase === 'during-dns' ? {lookup: () => { entered.resolve!(); return release.promise; }} : {})}, {signal: controller.signal, beforeDispatch: () => fences++});
    if (phase === 'during-dns') { await entered.promise; controller.abort(); release.resolve!(answers); }
    await assert.rejects(pending, error => {
      assert.equal((error as Failure & {dispatched?:boolean}).dispatched === true, phase === 'after-post'); assert.equal((error as Failure & {outcomeUnknown?:boolean}).outcomeUnknown === true, phase === 'after-post'); return true;
    });
    assert.equal(state.posts, phase === 'after-post' ? 1 : 0); assert.equal(fences, phase === 'after-post' ? 1 : 0);
  });
}

test('custom settings assertion must return synchronous true; caller durable fence must also be synchronous', async t => {
  const {settings} = await settingsFixture(t);
  for (const assertion of [() => false, () => undefined, () => 1, async () => true, () => Promise.reject(Error('synthetic reject'))]) {
    const state = network(); let fences = 0;
    await assert.rejects(generate({...settings, [IMAGE_SETTINGS_ASSERT_CURRENT]: assertion}, state, {beforeDispatch: () => fences++}), {code: 'IMAGE_DISPATCH_BLOCKED', dispatched: false});
    assert.equal(state.posts, 0); assert.equal(fences, 0);
  }
  const state = network();
  await assert.rejects(generate(settings, state, {beforeDispatch: async () => {}}), {code: 'IMAGE_DISPATCH_BLOCKED', dispatched: false});
  assert.equal(state.posts, 0);
});

test('removed or closed custom credentials cannot start DNS or adopt another slot/environment key', async t => {
  const {settings} = await settingsFixture(t);
  await settings.put({expectedRevision: 1, configuration, secret: {action: 'remove'}});
  const a = network(); await assert.rejects(generate(settings, a, {settingsRevision: 2}), {code: 'IMAGE_SETTINGS_NOT_CONFIGURED'}); assert.equal(a.lookups, 0);
  await settings.close(); const b = network(); await assert.rejects(generate(settings, b, {settingsRevision: 2}), {code: 'IMAGE_SETTINGS_CLOSED'}); assert.equal(b.lookups, 0);
});
