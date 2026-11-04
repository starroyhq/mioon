import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import type {RequestOptions} from 'node:https';
import {createCompatibleImageGatewayV2} from '../packages/business/src/images/gateway.ts';
import {createCustomImageSettingsV2} from '../packages/business/src/images/custom-settings-v2.ts';
import type {AcquiredCustomImageCredentialV2} from '../packages/business/src/images/custom-settings-v2.ts';
import {CUSTOM_IMAGE_SETTINGS_V2_NAMESPACE, DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2, customImageCredentialRequestV2Schema} from '../packages/contracts/src/generation-image-settings.ts';
import type {CustomImageConfigurationV2, CustomImageCredentialRequestV2} from '../packages/contracts/src/generation-image-settings.ts';
import {IMAGE_FIXED_OPTIONS} from '../packages/contracts/src/images.ts';
import {renderMockImagePng} from '../packages/business/src/images/png.ts';

type Settings = Awaited<ReturnType<typeof createCustomImageSettingsV2>>;
type GatewayOptions = Parameters<typeof createCompatibleImageGatewayV2>[0];
type Context = NonNullable<Parameters<ReturnType<typeof createCompatibleImageGatewayV2>['generate']>[1]>;
type MockOptions = RequestOptions & {hostname: string; path: string; headers: Record<string, string>};
const KEY_A = 'synthetic-image-service-key-A', KEY_B = 'synthetic-image-service-key-B';
const configuration: CustomImageConfigurationV2 = {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2, enabled: true, baseUrl: 'https://custom-images.example/proxy/v1', model: 'vendor/reviewed-image-v1', options: {...IMAGE_FIXED_OPTIONS}};
const input = {providerId: 'openai-compatible', model: configuration.model, prompt: 'Frozen service prompt: 蓝色 sky.', options: {...IMAGE_FIXED_OPTIONS}};
const answers = [{address: '8.8.8.8', family: 4}];
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
let png: Promise<Buffer> | undefined;
async function responseBody() {
  const bytes = await (png ??= renderMockImagePng());
  return {bytes, body: Buffer.from(JSON.stringify({data: [{b64_json: bytes.toString('base64')}]}))};
}
async function fixture(t: TestContext, save?: () => Promise<void>) {
  let stored: unknown = null;
  const settings = await createCustomImageSettingsV2({persistence: {load: async () => stored, save: async value => {await save?.(); stored = structuredClone(value);}}});
  t.after(() => settings.close());
  const a = randomUUID(), b = randomUUID();
  await settings.batch({expectedRevision: 0, operations: [a, b].map((connectionId, index) => ({action: 'create', connectionId, name: index ? 'Service B' : 'Service A', configuration, secret: {action: 'replace', storage: 'session', value: index ? KEY_B : KEY_A}}))});
  return {settings, a, b, read: () => stored};
}
function network(body: Buffer = Buffer.from('{}'), onPost?: () => void) {
  const state: {created: number; posts: number; lookups: number; hostname?: string; options?: MockOptions; payload?: string} = {created: 0, posts: 0, lookups: 0};
  const lookup = async (hostname: string) => {state.lookups++; state.hostname = hostname; return answers;};
  const httpsRequest = (options: MockOptions, callback: (response: Readable) => void) => {
    state.created++; state.options = options;
    const request = Object.assign(new EventEmitter(), {destroy() {}, end(payload: string) {
      state.posts++; state.payload = payload; onPost?.();
      const response = Object.assign(Readable.from([body]), {statusCode: 200, headers: {'content-type': 'application/json'}, complete: true});
      callback(response);
    }});
    queueMicrotask(() => {
      const socket = Object.assign(new EventEmitter(), {remoteAddress: '8.8.8.8', remotePort: 443, authorized: true, destroy() {}});
      request.emit('socket', socket); socket.emit('secureConnect');
    });
    return request;
  };
  return {state, lookup: lookup as unknown as GatewayOptions['lookup'], httpsRequest: httpsRequest as unknown as GatewayOptions['httpsRequest']};
}
function generate(settings: Settings, net: ReturnType<typeof network>, connectionId: string, context: Context = {}, snapshot: unknown = input) {
  return createCompatibleImageGatewayV2({settings, lookup: net.lookup, httpsRequest: net.httpsRequest}).generate(snapshot, {connectionId, configurationRevision: 1, settingsRevision: 1, configuration, beforeDispatch() {}, ...context});
}
function assertFrozenExpected(value: unknown): asserts value is CustomImageCredentialRequestV2 {
  customImageCredentialRequestV2Schema.parse(value);
  assert.ok(value && typeof value === 'object' && 'configuration' in value);
  assert.ok(value.configuration && typeof value.configuration === 'object' && 'options' in value.configuration);
  assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.configuration)); assert.ok(Object.isFrozen(value.configuration.options));
}

test('equal-config services acquire only their own key and provider wire contains no service identity or revision', async t => {
  const f = await fixture(t), response = await responseBody(), a = network(response.body), b = network(response.body);
  const results = [await generate(f.settings, a, f.a), await generate(f.settings, b, f.b)];
  assert.equal(a.state.options!.headers.Authorization, `Bearer ${KEY_A}`); assert.equal(b.state.options!.headers.Authorization, `Bearer ${KEY_B}`);
  for (const net of [a, b]) {
    assert.equal(net.state.posts, 1); assert.equal(net.state.lookups, 1); assert.equal(net.state.hostname, 'custom-images.example');
    assert.equal(net.state.options!.hostname, 'custom-images.example'); assert.equal(net.state.options!.path, '/proxy/v1/images/generations');
    const wire = JSON.parse(net.state.payload!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(wire).sort(), ['background', 'model', 'moderation', 'n', 'output_format', 'prompt', 'quality', 'size']);
    assert.equal(wire.model, configuration.model); assert.equal(wire.prompt, input.prompt); assert.equal(wire.moderation, 'auto');
    assert.equal(net.state.payload!.includes(f.a), false); assert.equal(net.state.payload!.includes(f.b), false);
  }
  for (const result of results) {assert.deepEqual(result.bytes, response.bytes); assert.equal(result.metadata.isMock, false);}
  assert.doesNotMatch(JSON.stringify(f.read()), /synthetic-image-service-key/);
});

test('caller mutation during acquire cannot change the frozen recipient, service, model, prompt or options', async t => {
  const f = await fixture(t), entered = deferred<void>(), release = deferred<void>(), net = network((await responseBody()).body);
  const reviewed: Omit<CustomImageConfigurationV2, 'options'> & {options: Record<string, unknown>} = structuredClone(configuration);
  const snapshot: Omit<typeof input, 'options'> & {options: Record<string, unknown>} = structuredClone(input);
  const context: Context = {connectionId: f.a, configurationRevision: 1, settingsRevision: 1, configuration: reviewed, beforeDispatch() {}};
  const wrapped: Settings = {...f.settings, acquire: async (expected, options) => {
    assertFrozenExpected(expected); assert.equal(expected.connectionId, f.a); entered.resolve(); await release.promise; return f.settings.acquire(expected, options);
  }};
  const gateway = createCompatibleImageGatewayV2({settings: wrapped, lookup: net.lookup, httpsRequest: net.httpsRequest});
  const pending = gateway.generate(snapshot, context); await entered.promise;
  reviewed.baseUrl = 'https://other.example/v1'; reviewed.model = 'changed-model'; reviewed.options.n = 2;
  snapshot.model = 'changed-model'; snapshot.prompt = 'Changed prompt'; snapshot.options.quality = 'high'; context.connectionId = f.b; context.configurationRevision = 2;
  release.resolve(); await pending;
  const wire = JSON.parse(net.state.payload!) as Record<string, unknown>;
  assert.equal(net.state.options!.hostname, 'custom-images.example'); assert.equal(net.state.options!.headers.Authorization, `Bearer ${KEY_A}`);
  assert.equal(wire.model, input.model); assert.equal(wire.prompt, input.prompt); assert.equal(wire.quality, 'low'); assert.equal(wire.n, 1); assert.equal(net.state.posts, 1);
});

test('credential namespace, service ID, revision and full configuration are rechecked before DNS', async t => {
  const f = await fixture(t), credential = await f.settings.acquire({connectionId: f.a, configurationRevision: 1, configuration});
  assert.equal(credential.namespace, CUSTOM_IMAGE_SETTINGS_V2_NAMESPACE);
  const invalid: unknown[] = [null, undefined,
    {...credential, namespace: 'mioon.images.openai-compatible.v1'}, {...credential, connectionId: f.b}, {...credential, configurationRevision: 2},
    {...credential, configuration: {...configuration, baseUrl: 'https://other.example/v1'}}, {...credential, configuration: {...configuration, model: 'different'}}, {...credential, configuration: {...configuration, enabled: false}},
  ];
  for (const returned of invalid) {
    const net = network(), wrapped: Settings = {...f.settings, acquire: async () => returned as AcquiredCustomImageCredentialV2};
    await assert.rejects(generate(wrapped, net, f.a), {code: 'IMAGE_SETTINGS_CONFLICT'});
    assert.equal(net.state.lookups, 0); assert.equal(net.state.created, 0); assert.equal(net.state.posts, 0);
  }
});

test('editing service B during DNS leaves the frozen service A credential and dispatch available', async t => {
  const f = await fixture(t), entered = deferred<void>(), release = deferred<typeof answers>(), net = network((await responseBody()).body); let fences = 0;
  const pending = generate(f.settings, {...net, lookup: (() => {entered.resolve(); return release.promise;}) as unknown as GatewayOptions['lookup']}, f.a, {beforeDispatch: () => {fences++;}});
  await entered.promise;
  await f.settings.put({expectedRevision: 1, connectionId: f.b, expectedConfigurationRevision: 1, name: 'B changed', configuration: {...configuration, model: 'different-model'}, secret: {action: 'keep'}});
  release.resolve(answers); await pending;
  assert.equal(net.state.posts, 1); assert.equal(fences, 1); assert.equal(net.state.options!.headers.Authorization, `Bearer ${KEY_A}`);
});

for (const effect of ['edit', 'delete', 'close'] as const) test(`${effect} of service A during DNS blocks its durable fence and sends zero POSTs`, async t => {
  const f = await fixture(t), entered = deferred<void>(), release = deferred<typeof answers>(), net = network(); let fences = 0;
  const pending = generate(f.settings, {...net, lookup: (() => {entered.resolve(); return release.promise;}) as unknown as GatewayOptions['lookup']}, f.a, {beforeDispatch: () => {fences++;}});
  const rejected = assert.rejects(pending, {code: 'IMAGE_DISPATCH_BLOCKED', dispatched: false, outcomeUnknown: false}); await entered.promise;
  if (effect === 'edit') await f.settings.put({expectedRevision: 1, connectionId: f.a, expectedConfigurationRevision: 1, name: 'A changed', configuration: {...configuration, baseUrl: 'https://changed.example/v1'}, secret: {action: 'replace', storage: 'session', value: 'synthetic-replacement-A'}});
  if (effect === 'delete') await f.settings.remove({expectedRevision: 1, connectionId: f.a, expectedConfigurationRevision: 1});
  if (effect === 'close') await f.settings.close();
  release.resolve(answers); await rejected;
  assert.equal(net.state.options!.hostname, 'custom-images.example'); assert.equal(net.state.posts, 0); assert.equal(fences, 0);
});

test('a pending B save cannot block A, while a pending A save blocks before either durable fence or POST', async t => {
  for (const target of ['a', 'b'] as const) await t.test(target, async child => {
    let hold = false; const writeEntered = deferred<void>(), writeRelease = deferred<void>(), dnsEntered = deferred<void>(), dnsRelease = deferred<typeof answers>();
    const f = await fixture(child, async () => {if (hold) {writeEntered.resolve(); await writeRelease.promise;}}), net = network((await responseBody()).body); let fences = 0;
    const pending = generate(f.settings, {...net, lookup: (() => {dnsEntered.resolve(); return dnsRelease.promise;}) as unknown as GatewayOptions['lookup']}, f.a, {beforeDispatch: () => {fences++;}});
    await dnsEntered.promise; hold = true;
    const write = f.settings.put({expectedRevision: 1, connectionId: f[target], expectedConfigurationRevision: 1, name: 'Pending change', configuration: {...configuration, model: 'pending-model'}, secret: {action: 'keep'}}); await writeEntered.promise;
    const completed = target === 'a' ? assert.rejects(pending, {code: 'IMAGE_DISPATCH_BLOCKED', dispatched: false}) : pending;
    dnsRelease.resolve(answers);
    try {await completed; assert.equal(net.state.posts, target === 'a' ? 0 : 1); assert.equal(fences, target === 'a' ? 0 : 1);}
    finally {writeRelease.resolve(); await write;}
  });
});

test('assertCurrent, durable beforeDispatch and POST run synchronously in that order in one turn', async t => {
  const f = await fixture(t), order: string[] = [], net = network((await responseBody()).body, () => {order.push('POST');});
  const wrapped: Settings = {...f.settings, assertCurrent: expected => {assertFrozenExpected(expected); order.push('assertCurrent'); queueMicrotask(() => {order.push('later turn');}); return f.settings.assertCurrent(expected);}};
  await generate(wrapped, net, f.a, {beforeDispatch: () => {order.push('durable');}});
  assert.deepEqual(order, ['assertCurrent', 'durable', 'POST', 'later turn']); assert.equal(net.state.posts, 1);
});

test('non-true and asynchronous final assertions cannot authorize a durable fence or POST', async t => {
  const f = await fixture(t);
  for (const assertion of [() => false, () => undefined, () => 1, async () => true, () => Promise.reject(Error('Synthetic late final assertion rejection'))]) {
    const net = network(); let fences = 0;
    const wrapped: Settings = {...f.settings, assertCurrent: assertion as unknown as Settings['assertCurrent']};
    await assert.rejects(generate(wrapped, net, f.a, {beforeDispatch: () => {fences++;}}), {code: 'IMAGE_DISPATCH_BLOCKED', dispatched: false, outcomeUnknown: false});
    assert.equal(net.state.posts, 0); assert.equal(fences, 0);
  }
  const net = network();
  await assert.rejects(generate(f.settings, net, f.a, {beforeDispatch: async () => {}}), {code: 'IMAGE_DISPATCH_BLOCKED', dispatched: false, outcomeUnknown: false});
  assert.equal(net.state.posts, 0);
  await new Promise(resolve => setImmediate(resolve));
});
