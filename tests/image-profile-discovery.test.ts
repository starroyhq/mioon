interface DiscoverySnapshot{revision?:unknown;configuration:{enabled:boolean;model:string;[key:string]:unknown};secret?:{configured:boolean;storage?:string;value?:string};readiness?:{checked:boolean;checkedAt?:string};storage?:unknown}
import type {TypedStore, TypedServices, TypedClient} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp, rm, readdir, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createImageSettings, createCustomImageSettings, IMAGE_SETTINGS_READ_CURRENT,
  IMAGE_SETTINGS_ASSERT_CURRENT, IMAGE_CREDENTIAL_ACQUIRE} from '../packages/business/src/images/settings.ts';
import {createComfySettings, COMFY_SETTINGS_READ_CURRENT, COMFY_SETTINGS_ASSERT_CURRENT} from '../packages/business/src/comfy/settings.ts';
import {IMAGE_MODELS, IMAGE_FIXED_OPTIONS, imageSchemas, imageOptionsSchema,
  imageProfileResponseSchema, imageProfilesResponseSchema, isImageProfilesResponse} from '../packages/contracts/src/images.ts';
import {DEFAULT_IMAGE_CONFIGURATION, DEFAULT_CUSTOM_IMAGE_CONFIGURATION,
  customImageModelSchema} from '../packages/contracts/src/image-settings.ts';
import {DEFAULT_COMFY_IMAGE_CONFIGURATION, COMFY_IMAGE_OPTIONS, comfyCheckpointSchema,
  comfyImageOptionsSchema} from '../packages/contracts/src/comfy-images.ts';
import {createClient, operationDefinition} from '../packages/client/src/index.ts';
import {startServer} from '../apps/server/src/index.ts';
import {READ_TOOL_DEFINITIONS} from '../packages/business/src/agent/read-tool-policy.ts';
import {EDIT_TOOL_DEFINITIONS} from '../packages/business/src/agent/edit-tool-policy.ts';
import type { PathLike } from 'fs';

const {z} = createRequire(new URL('../packages/contracts/package.json', import.meta.url))('zod');
const repo = fileURLToPath(new URL('..', import.meta.url));
const operation = 'image.profile.list', optIn = {includeSettingsRevision: true};
const token = 'synthetic-image-profile-discovery-token';
const clone = <T>(value: T): T => structuredClone(value);
const customConfiguration = {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION, enabled: true,
  baseUrl: 'https://discovery.example.test/private-prefix', model: 'synthetic-image-model'};
const comfyConfiguration = {...DEFAULT_COMFY_IMAGE_CONFIGURATION, enabled: true,
  baseUrl: 'http://127.0.0.1:8188', model: 'synthetic-checkpoint.safetensors'};
const configurations = [{...DEFAULT_IMAGE_CONFIGURATION, enabled: true}, customConfiguration, comfyConfiguration];
const providerIds = ['openai', 'openai-compatible', 'comfy-local'];

// Frozen pre-discovery strict response contract from baseline 090a8e3. This is
// deliberately independent of the new optional field and still rejects it.
const oldLegacyProfile = z.object({providerId: z.enum(['mock','openai','openai-compatible']),
  model: customImageModelSchema, name: z.string().min(1).max(120), enabled: z.boolean(), isMock: z.boolean(),
  evidence: z.enum(['deterministic-mock','offline-tested-not-live']), options: imageOptionsSchema}).strict()
  .refine((v: { providerId: string; model: unknown; }) => v.providerId === 'openai-compatible' || IMAGE_MODELS[v.providerId as keyof typeof IMAGE_MODELS] === v.model)
  .refine((v: { isMock: boolean; providerId: string; enabled: unknown; evidence: string; }) => v.isMock === (v.providerId === 'mock') && (!v.isMock || v.enabled) &&
    v.evidence === (v.isMock ? 'deterministic-mock' : 'offline-tested-not-live'));
const oldProfile = z.union([oldLegacyProfile, z.object({providerId: z.literal('comfy-local'),
  model: comfyCheckpointSchema, name: z.string().min(1).max(120), enabled: z.boolean(), isMock: z.literal(false),
  evidence: z.literal('offline-tested-not-live'), options: comfyImageOptionsSchema}).strict()]);
const oldResponse = z.object({items: z.array(oldProfile).max(4), liveEnabled: z.boolean()}).strict()
  .refine((v: { items:{providerId:string;enabled:unknown}[];liveEnabled:unknown; }) => new Set(v.items.map((i: { providerId: unknown; }) => i.providerId)).size === v.items.length &&
    v.liveEnabled === v.items.some((i: { providerId: string; enabled: unknown; }) => i.providerId !== 'mock' && i.enabled));

function expectedProfiles({enabled = [true, true, true], models = configurations.map(v => v.model)} = {}) {
  return {items: [
    {providerId: 'mock', model: IMAGE_MODELS.mock, name: 'Mock 本地图像流程测试', enabled: true,
      isMock: true, evidence: 'deterministic-mock', options: {...IMAGE_FIXED_OPTIONS}},
    {providerId: 'openai', model: models[0], name: enabled[0] ? 'OpenAI Images · 需逐次确认' : 'OpenAI Images · 未启用',
      enabled: enabled[0], isMock: false, evidence: 'offline-tested-not-live', options: {...IMAGE_FIXED_OPTIONS}},
    {providerId: 'openai-compatible', model: models[1], name: enabled[1] ? '自定义 Images · 需逐次确认' : '自定义 Images · 未启用',
      enabled: enabled[1], isMock: false, evidence: 'offline-tested-not-live', options: {...IMAGE_FIXED_OPTIONS}},
    {providerId: 'comfy-local', model: models[2], name: enabled[2] ? 'ComfyUI 本机 · 逐次确认' : 'ComfyUI 本机 · 尚未检查',
      enabled: enabled[2], isMock: false, evidence: 'offline-tested-not-live', options: {...COMFY_IMAGE_OPTIONS}},
  ], liveEnabled: enabled.some(Boolean)};
}
const withRevisions = <T extends {items:object[];liveEnabled:boolean}>(value:T,revisions=[11,22,33]) => ({...clone(value),
  items: value.items.map((item:T["items"][number],index:number) => index ? {...clone(item), settingsRevision: revisions[index - 1]} : clone(item))});
const rows = (db: DatabaseSync) => JSON.stringify(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
  .map(({name}) => [name, db.prepare(`SELECT * FROM "${(name as string).replaceAll('"', '""')}" ORDER BY rowid`).all()]));
const changes = (db: DatabaseSync) => db.prepare('SELECT total_changes() AS n').get()!.n;
function publicOnly(value: unknown, root = '') {
  const text = JSON.stringify(value);
  for (const privateValue of [token, root, customConfiguration.baseUrl, comfyConfiguration.baseUrl,
    'SYNTHETIC_PROFILE_SECRET', 'SYNTHETIC_PROFILE_CIPHERTEXT'].filter(Boolean)) assert.ok(!text.includes(privateValue));
  assert.ok(!/"(?:baseUrl|endpoint|destination|configuration|secret|storage|apiKey|authorization|credential|encrypted|rawGraph|workflow|execution)"\s*:/i.test(text));
}

async function serviceFixture(t: test.TestContext, imageOptions?:Record<string,unknown>) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-image-profile-discovery-'));
  const store = (openStore(root) as TypedStore), services = (createServices(store, new Map(), {env: {}, imageOptions: {autoRun: false, ...imageOptions}}) as TypedServices);
  t.after(async () => {await services.drain(); store.close(); await rm(root, {recursive: true, force: true});});
  return {root, store, services, call: (input = {}) => services.call(operation, input)};
}
async function snapshotFixture(t: test.TestContext) {
  const states:DiscoverySnapshot[] = configurations.map((configuration, index) => ({revision: [11, 22, 33][index], configuration: clone(configuration),
    ...(index === 2 ? {readiness: {checked: true, checkedAt: '2026-10-10T00:00:00.000Z'}} :
      {secret: {configured: true, storage: 'persistent', value: 'SYNTHETIC_PROFILE_SECRET'}, storage: {encrypted: 'SYNTHETIC_PROFILE_CIPHERTEXT'}})}));
  const reads = [0, 0, 0], forbidden: string[] = [], afterRead: (null|(()=>void))[] = [null,null,null];
  const deny = (name: string) => () => {forbidden.push(name); throw Error('Profile discovery invoked ' + name);};
  const engines = states.map((_, i) => ({
    [i === 2 ? COMFY_SETTINGS_READ_CURRENT : IMAGE_SETTINGS_READ_CURRENT]() {
      reads[i]++; const state = states[i]; if (state instanceof Error) throw state;
      const snapshot = clone(state); afterRead[i]?.(); return snapshot;
    },
    get: deny(`${i}.get`), put: deny(`${i}.put`), acquire: deny(`${i}.acquire`),
    [IMAGE_CREDENTIAL_ACQUIRE]: deny(`${i}.credential`), [IMAGE_SETTINGS_ASSERT_CURRENT]: deny(`${i}.assert`),
    [COMFY_SETTINGS_ASSERT_CURRENT]: deny(`${i}.comfyAssert`),
  }));
  const gateway = {generate: deny('generate')}, connector = {submit: deny('submit'), observe: deny('observe'), check: deny('check')};
  const f = await serviceFixture(t, {settings: engines[0], customSettings: engines[1], comfySettings: engines[2],
    liveGateway: gateway, customGateway: gateway, comfyConnector: connector});
  return {...f, states, reads, forbidden, afterRead};
}

test('profile discovery input is an explicit strict optional boolean, with no parsed default', () => {
  for (const input of [{}, {includeSettingsRevision: false}, optIn]) assert.deepEqual(imageSchemas[operation].parse(input), input);
  for (const input of [null, [], {includeSettingsRevision: 'true'}, {includeSettingsRevision: 1},
    {includeSettingsRevision: null}, {...optIn, settingsRevision: 1}, {...optIn, endpoint: 'https://example.test'},
    {...optIn, secret: 'synthetic'}, {...optIn, settings: {}}, {...optIn, providerId: 'openai'}]) {
    assert.equal(imageSchemas[operation].safeParse(input).success, false, JSON.stringify(input));
  }
});

test('strict profile response permits only opt-in positive safe revisions on non-Mock profiles', () => {
  const legacy = expectedProfiles(), expanded = withRevisions(legacy);
  assert.ok(oldResponse.safeParse(legacy).success);
  assert.equal(oldResponse.safeParse(expanded).success, false);
  assert.ok(imageProfilesResponseSchema.safeParse(expanded).success);
  assert.ok(isImageProfilesResponse(expanded, optIn));
  for (const input of [undefined, {}, {includeSettingsRevision: false}]) assert.equal(isImageProfilesResponse(expanded, input), false);
  for (const input of [{}, {includeSettingsRevision: false}, optIn]) assert.ok(isImageProfilesResponse(legacy, input));
  for (const provider of expanded.items.slice(1)) {
    for (const settingsRevision of [1, Number.MAX_SAFE_INTEGER]) assert.ok(imageProfileResponseSchema.safeParse({...provider, settingsRevision}).success);
    for (const settingsRevision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '11', null]) {
      assert.equal(imageProfileResponseSchema.safeParse({...provider, settingsRevision}).success, false);
    }
    for (const extra of [{extra: true}, {secret: {}}, {configuration: {}}, {endpoint: 'https://example.test'}, {revision: 1}]) {
      assert.equal(imageProfileResponseSchema.safeParse({...provider, ...extra}).success, false);
    }
  }
  for (const settingsRevision of [undefined, 1]) assert.equal(imageProfileResponseSchema.safeParse({...legacy.items[0], settingsRevision}).success, false);
  assert.equal(imageProfilesResponseSchema.safeParse({...expanded, settingsRevision: 1}).success, false);
  assert.equal(imageProfilesResponseSchema.safeParse({...expanded, items: [...expanded.items, expanded.items[1]]}).success, false);
});

test('default and explicit false preserve old strict response bytes, property order and provider order exactly', async (t: test.TestContext) => {
  const f = await snapshotFixture(t), expected = expectedProfiles(), before = rows(f.store.db), count = changes(f.store.db);
  for (const input of [{}, {includeSettingsRevision: false}, {}]) {
    const value = await f.call(input);
    assert.equal(JSON.stringify(value), JSON.stringify(expected));
    assert.ok(oldResponse.safeParse(value).success); publicOnly(value, f.root);
  }
  assert.deepEqual(f.reads, [3, 3, 3]); assert.deepEqual((f.forbidden as unknown), []);
  assert.equal(rows(f.store.db), before); assert.equal(changes(f.store.db), count);
});

test('each opt-in revision and metadata come from exactly one isolated safe snapshot, with zero mutations or probes', async (t: test.TestContext) => {
  const f = await snapshotFixture(t), before = rows(f.store.db), count = changes(f.store.db);
  f.afterRead.forEach((_, i) => {f.afterRead[i] = () => {
    (f.states[i] as {revision:number}).revision += 100; f.states[i].configuration.enabled = false;
    if (i) f.states[i].configuration.model = i === 1 ? 'changed-model' : 'changed-checkpoint.safetensors';
  };});
  const value = await f.call(optIn);
  assert.equal(JSON.stringify(value), JSON.stringify(withRevisions(expectedProfiles())));
  assert.ok(isImageProfilesResponse(value, optIn)); publicOnly(value, f.root);
  assert.deepEqual(f.reads, [1, 1, 1]); assert.deepEqual((f.forbidden as unknown), []);
  assert.equal(rows(f.store.db), before); assert.equal(changes(f.store.db), count);
  const next = await f.call(optIn);
  assert.deepEqual(next.items.slice(1).map(v => v.settingsRevision), [111, 122, 133]);
  assert.deepEqual(next.items.slice(1).map(v => v.model), [IMAGE_MODELS.openai, 'changed-model', 'changed-checkpoint.safetensors']);
  assert.ok(next.items.slice(1).every(v => !v.enabled)); assert.equal(next.liveEnabled, false);
  assert.deepEqual(f.reads, [2, 2, 2]); assert.equal(rows(f.store.db), before); assert.equal(changes(f.store.db), count);
});

test('missing, zero, noninteger and unsafe revisions are omitted without guessing or borrowing another slot', async (t: test.TestContext) => {
  const f = await snapshotFixture(t);
  for (const invalid of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '22', null]) {
    for (let i = 0; i < 3; i++) {
      f.states.forEach((state, index) => {state.revision = [11, 22, 33][index];});
      if (invalid === undefined) delete f.states[i].revision; else f.states[i].revision = invalid;
      const value = await f.call(optIn);
      value.items.slice(1).forEach((item: {settingsRevision?:number}, index: number) => {
        if (index === i) assert.equal(Object.hasOwn(item, 'settingsRevision'), false);
        else assert.equal(item.settingsRevision, [11, 22, 33][index]);
      });
      assert.ok(isImageProfilesResponse(value, optIn)); assert.equal(Object.hasOwn(value.items[0], 'settingsRevision'), false);
    }
  }
  assert.deepEqual((f.forbidden as unknown), []);
});

test('disabled and unready configured profiles can expose revision independently of generation readiness', async (t: test.TestContext) => {
  const f = await snapshotFixture(t);
  f.states[0].configuration.enabled = false;
  f.states[1].secret!.configured = false;
  f.states[2].readiness!.checked = false;
  const value = await f.call(optIn);
  assert.deepEqual(value, withRevisions(expectedProfiles({enabled: [false, false, false]})));
  assert.ok(isImageProfilesResponse(value, optIn)); assert.deepEqual((f.forbidden as unknown), []);
});

test('unconfigured or unreadable slots stay isolated and never create revision-only profiles', async (t: test.TestContext) => {
  const absent = await serviceFixture(t);
  const minimal = expectedProfiles({enabled: [false, false, false]}); minimal.items.length = 2;
  assert.equal(JSON.stringify(await absent.call(optIn)), JSON.stringify(minimal));
  const f = await snapshotFixture(t), originals = clone(f.states);
  f.states[0].revision = 0;
  f.states[1] = {revision: 22, configuration: clone(DEFAULT_CUSTOM_IMAGE_CONFIGURATION), secret: {configured: false}};
  f.states[2] = {revision: 33, configuration: clone(DEFAULT_COMFY_IMAGE_CONFIGURATION), readiness: {checked: false}};
  assert.deepEqual((await f.call(optIn)).items.map(v => v.providerId), ['mock', 'openai']);
  for (let i = 0; i < 3; i++) {
    for (const unavailable of [undefined, new Error('SYNTHETIC_PROFILE_SECRET')]) {
      originals.forEach((state: unknown, index: string|number) => {f.states[(index as number)] = clone(state) as DiscoverySnapshot;}); f.states[i] = unavailable as unknown as DiscoverySnapshot;
      const value = await f.call(optIn); publicOnly(value, f.root);
      const selected = value.items.find((v: { providerId: string; }) => v.providerId === providerIds[i]);
      if (i === 0) {assert.equal(selected!.enabled, false); assert.equal(Object.hasOwn(selected!, 'settingsRevision'), false);}
      else assert.equal(selected, undefined);
      providerIds.filter((_, index) => index !== i).forEach(id => assert.equal(value.items.find((v: { providerId: string; }) => v.providerId === id)!.settingsRevision, [11, 22, 33][providerIds.indexOf(id)]));
    }
  }
  assert.deepEqual((f.forbidden as unknown), []);
});

function memoryPersistence(counters: {loads:number;saves:number}) {
  let value:unknown = null;
  return {load: async () => {counters.loads++; return clone(value);},
    save: async (next: unknown) => {counters.saves++; value = clone(next);}};
}
async function realSettingsFixture(t: test.TestContext) {
  const counters = {loads: 0, saves: 0, encrypts: 0, decrypts: 0, refreshes: 0, calls: 0};
  const secretCodec = {encrypt() {counters.encrypts++; return Buffer.from('SYNTHETIC_PROFILE_CIPHERTEXT').toString('base64');},
    decrypt() {counters.decrypts++; throw Error('Discovery must not decrypt');},
    refreshStorage() {counters.refreshes++;}};
  const settingsOptions = () => ({persistence: memoryPersistence(counters), secretCodec,
    storage: {persistentAvailable: true, sessionScope: 'server', reasonCode: null}});
  const engines:[Awaited<ReturnType<typeof createImageSettings>>,Awaited<ReturnType<typeof createCustomImageSettings>>,Awaited<ReturnType<typeof createComfySettings>>] = [await createImageSettings(settingsOptions()), await createCustomImageSettings(settingsOptions()),
    await createComfySettings({persistence: memoryPersistence(counters), reservedPorts: () => [4318]})];
  const deny = () => {counters.calls++; throw Error('No provider I/O');};
  const f = await serviceFixture(t, {settings: engines[0], customSettings: engines[1], comfySettings: engines[2],
    liveGateway: {generate: deny}, customGateway: {generate: deny}, comfyConnector: {submit: deny, observe: deny, check: deny}});
  t.after(async () => {for (const engine of engines) await engine.close();});
  return {...f, engines, counters};
}

test('real disabled, incomplete, zero-revision, closed and corrupt settings never refresh or decrypt on discovery', async (t: test.TestContext) => {
  const f = await realSettingsFixture(t);
  let count = clone(f.counters), before = rows(f.store.db);
  const initial = await f.call(optIn);
  assert.deepEqual(initial.items.map(v => v.providerId), ['mock', 'openai']);
  assert.ok(initial.items.every((v: object) => !Object.hasOwn(v, 'settingsRevision')));
  assert.deepEqual(f.counters, count); assert.equal(rows(f.store.db), before);
  for (let i = 0; i < 3; i++) await f.engines[i].put({expectedRevision: 0,
    configuration: {...configurations[i], enabled: false}, ...(i === 2 ? {} :
      {secret: {action: 'replace', storage: 'persistent', value: 'SYNTHETIC_PROFILE_SECRET'}})});
  count = clone(f.counters); before = rows(f.store.db);
  const value = await f.call(optIn);
  assert.deepEqual(value, withRevisions(expectedProfiles({enabled: [false, false, false]}), [1, 1, 1]));
  assert.deepEqual(f.counters, count); assert.equal(rows(f.store.db), before);
  for (const engine of f.engines) await engine.close();
  const closed = await f.call(optIn);
  assert.deepEqual(closed.items.map(v => v.providerId), ['mock', 'openai']);
  assert.ok(closed.items.every((v: object) => !Object.hasOwn(v, 'settingsRevision'))); assert.equal(closed.liveEnabled, false);
  assert.equal(f.counters.decrypts, 0); assert.equal(f.counters.calls, 0);
  const broken = {load: async () => {throw Error('SYNTHETIC_PROFILE_SECRET');}, save: async () => assert.fail('No repairs')};
  const corrupt = [await createImageSettings({persistence: broken}), await createCustomImageSettings({persistence: broken}), await createComfySettings({persistence: broken})];
  const bad = await serviceFixture(t, {settings: corrupt[0], customSettings: corrupt[1], comfySettings: corrupt[2]});
  t.after(async () => {for (const engine of corrupt) await engine.close();});
  assert.deepEqual(await bad.call(optIn), closed);
});

test('discovered revision follows configuration changes while stale preparation, approval and settings CAS stay closed', async (t: test.TestContext) => {
  const f = await realSettingsFixture(t), project = await f.services.call('project.create', {name: 'Profile revision fixture'});
  await f.services.call('workspace.settings.set', {expectedRevision: 0, liveGeneration: true});
  const nodeClasses = ['CheckpointLoaderSimple','EmptyLatentImage','CLIPTextEncode','KSampler','VAEDecode','SaveImage'];
  const check = f.engines[2].clearCheck(comfyConfiguration.baseUrl);
  f.engines[2].recordCheck({ok: true, baseUrl: comfyConfiguration.baseUrl, comfyVersion: comfyConfiguration.comfyVersion,
    checkpoints: [comfyConfiguration.model], selectedCheckpointAvailable: true, nodeClasses}, check);
  for (let i = 0; i < 3; i++) await f.engines[i].put({expectedRevision: 0, configuration: configurations[i],
    ...(i === 2 ? {} : {secret: {action: 'replace', storage: 'session', value: 'SYNTHETIC_PROFILE_SECRET'}})});
  const discovered = await f.call(optIn), reviews: ({ input: { projectId: string; requestId: `${string}-${string}-${string}-${string}-${string}`; name: string; providerId: "comfy-local" | "mock" | "openai" | "openai-compatible"; model: string; prompt: string; options: { size: "1024x1024"; n: 1; quality: "low"; outputFormat: "png"; background: "opaque"; } | { size: "512x512"; steps: 20; cfg: 8; sampler: "euler"; scheduler: "normal"; denoise: 1; n: 1; }; }; review: { input: { name: string; model: string; projectId: string; options: { size: "1024x1024"; n: 1; quality: "low"; outputFormat: "png"; background: "opaque"; }; providerId: "mock" | "openai" | "openai-compatible"; requestId: string; prompt: string; expectedRevision?: number | undefined; groupId?: string | undefined; } | { name: string; model: string; projectId: string; options: { size: "512x512"; steps: 20; cfg: 8; sampler: "euler"; scheduler: "normal"; denoise: 1; n: 1; }; providerId: "comfy-local"; requestId: string; prompt: string; expectedRevision?: number | undefined; groupId?: string | undefined; } | { name: string; model: string; projectId: string; options: { size: "1024x1024"; n: 1; quality: "low"; outputFormat: "png"; background: "opaque"; }; providerId: "mock" | "openai"; requestId: string; prompt: string; purpose: "edit"; inputImage: { sha256: string; assetId: string; }; expectedRevision?: number | undefined; groupId?: string | undefined; }; taskId: string | null; createdAt: string; id: string; projectId: string; state: "rejected" | "dispatched" | "pending" | "approved"; revision: number; updatedAt: string; requestId: string; destination: "https://api.openai.com/v1/images/generations"; settingsRevision: number; inputHash: string; policy: { maxPostAttempts: 1; automaticRetry: false; price: "usage-based-unknown"; promptStorage: "local-plaintext"; }; postAttempts: number; approvedAt: string | null; rejectedAt: string | null; dispatchedAt: string | null; } | { input: { name: string; model: string; projectId: string; options: { size: "1024x1024"; n: 1; quality: "low"; outputFormat: "png"; background: "opaque"; }; providerId: "mock" | "openai" | "openai-compatible"; requestId: string; prompt: string; expectedRevision?: number | undefined; groupId?: string | undefined; } | { name: string; model: string; projectId: string; options: { size: "512x512"; steps: 20; cfg: 8; sampler: "euler"; scheduler: "normal"; denoise: 1; n: 1; }; providerId: "comfy-local"; requestId: string; prompt: string; expectedRevision?: number | undefined; groupId?: string | undefined; } | { name: string; model: string; projectId: string; options: { size: "1024x1024"; n: 1; quality: "low"; outputFormat: "png"; background: "opaque"; }; providerId: "mock" | "openai"; requestId: string; prompt: string; purpose: "edit"; inputImage: { sha256: string; assetId: string; }; expectedRevision?: number | undefined; groupId?: string | undefined; }; taskId: string | null; createdAt: string; id: string; projectId: string; state: "rejected" | "dispatched" | "pending" | "approved"; revision: number; updatedAt: string; requestId: string; destination: string; settingsRevision: number; configuration: { model: string; options: { size: "1024x1024"; n: 1; quality: "low"; outputFormat: "png"; background: "opaque"; }; enabled: boolean; providerId: "openai-compatible"; connectionId: "custom"; profileId: "openai-images-json-png-v1"; baseUrl: string; }; inputHash: string; policy: { maxPostAttempts: 1; automaticRetry: false; price: "usage-based-unknown"; promptStorage: "local-plaintext"; }; postAttempts: number; approvedAt: string | null; rejectedAt: string | null; dispatchedAt: string | null; } | { input: { name: string; model: string; projectId: string; options: { size: "512x512"; steps: 20; cfg: 8; sampler: "euler"; scheduler: "normal"; denoise: 1; n: 1; }; providerId: "comfy-local"; requestId: string; prompt: string; expectedRevision?: number | undefined; groupId?: string | undefined; }; taskId: string | null; createdAt: string; id: string; projectId: string; state: "rejected" | "dispatched" | "pending" | "approved"; revision: number; updatedAt: string; requestId: string; destination: string; settingsRevision: number; configuration: { model: string; options: { size: "512x512"; steps: 20; cfg: 8; sampler: "euler"; scheduler: "normal"; denoise: 1; n: 1; }; enabled: boolean; providerId: "comfy-local"; connectionId: "comfy-local"; profileId: "comfy-t2i-png-v1"; baseUrl: string; comfyVersion: "0.39.0"; }; inputHash: string; policy: { maxPostAttempts: 1; automaticRetry: false; price: "local-compute-unknown"; promptStorage: "local-plaintext"; }; postAttempts: number; approvedAt: string | null; rejectedAt: string | null; dispatchedAt: string | null; execution: { comfyVersion: "0.39.0"; workflowId: "comfy-t2i-png-v1"; workflowVersion: 1; seed: number; promptId: string; clientId: string; outputNonce: string; filenamePrefix: string; graphHash: string; graph: { '1': { class_type: string; inputs: { [x: string]: unknown; }; }; '2': { class_type: string; inputs: { [x: string]: unknown; }; }; '3': { class_type: string; inputs: { [x: string]: unknown; }; }; '4': { class_type: string; inputs: { [x: string]: unknown; }; }; '5': { class_type: string; inputs: { [x: string]: unknown; }; }; '6': { class_type: string; inputs: { [x: string]: unknown; }; }; '7': { class_type: string; inputs: { [x: string]: unknown; }; }; }; }; } | { input: { name: string; model: string; projectId: string; options: { size: "1024x1024"; n: 1; quality: "low"; outputFormat: "png"; background: "opaque"; }; providerId: "mock" | "openai" | "openai-compatible"; requestId: string; prompt: string; expectedRevision?: number | undefined; groupId?: string | undefined; } | { name: string; model: string; projectId: string; options: { size: "512x512"; steps: 20; cfg: 8; sampler: "euler"; scheduler: "normal"; denoise: 1; n: 1; }; providerId: "comfy-local"; requestId: string; prompt: string; expectedRevision?: number | undefined; groupId?: string | undefined; } | { name: string; model: string; projectId: string; options: { size: "1024x1024"; n: 1; quality: "low"; outputFormat: "png"; background: "opaque"; }; providerId: "mock" | "openai"; requestId: string; prompt: string; purpose: "edit"; inputImage: { sha256: string; assetId: string; }; expectedRevision?: number | undefined; groupId?: string | undefined; }; taskId: string | null; createdAt: string; id: string; projectId: string; state: "rejected" | "dispatched" | "pending" | "approved"; revision: number; updatedAt: string; requestId: string; destination: "https://api.openai.com/v1/images/edits"; settingsRevision: number; sourceImage: { origin: { kind: "user-import"; } | { kind: "generated" | "synthetic-mock"; imageSource: { imageGroupId: string; imageTaskId: string; imageVersionId: string; }; } | { kind: "extracted-frame"; frameSource: { profileId: "local-png-1024-v1"; fps: 30; sourceAssetId: string; sourceHash: string; sourceFrame: number; frameTaskId: string; selectionRule: "first-pts-at-or-after-v1"; }; }; name: string; mimeType: "image/png"; sha256: string; width: number; height: number; assetId: string; byteLength: number; }; inputHash: string; policy: { maxPostAttempts: 1; automaticRetry: false; price: "usage-based-unknown"; promptStorage: "local-plaintext"; }; postAttempts: number; approvedAt: string | null; rejectedAt: string | null; dispatchedAt: string | null; }; })[] = [];
  for (const item of discovered.items.slice(1)) {
    const input = {projectId: project.id, requestId: randomUUID(), name: 'Revision binding', providerId: item.providerId,
      model: item.model, prompt: 'Local synthetic discovery contract.', options: item.options};
    const review = await f.services.call('image.review.prepare', {input, settingsRevision: item.settingsRevision});
    assert.equal(review.state, 'pending'); assert.equal(review.postAttempts, 0); reviews.push({input, review});
  }
  for (let i = 0; i < 3; i++) await f.engines[i].put({expectedRevision: 1,
    configuration: i === 0 ? {...configurations[i], enabled: false} : {...configurations[i], model: i === 1 ? 'new-custom-model' : 'new-checkpoint.safetensors'},
    ...(i === 2 ? {} : {secret: {action: 'remove'}})});
  const before = rows(f.store.db), count = changes(f.store.db), counters = clone(f.counters), current = await f.call(optIn);
  assert.deepEqual(current.items.slice(1).map(v => v.settingsRevision), [2, 2, 2]);
  assert.deepEqual(current.items.slice(1).map(v => v.model), [IMAGE_MODELS.openai, 'new-custom-model', 'new-checkpoint.safetensors']);
  assert.deepEqual(f.counters, counters); assert.equal(rows(f.store.db), before); assert.equal(changes(f.store.db), count);
  for (let i = 0; i < reviews.length; i++) {
    const {input, review} = reviews[i];
    await assert.rejects(f.services.call('image.review.prepare', {input: {...input, requestId: randomUUID()}, settingsRevision: 1}), {code: 'IMAGE_REVIEW_SETTINGS_CHANGED'});
    assert.deepEqual(await f.services.call('image.review.prepare', {input, settingsRevision: 1}), review, 'historical exact preparation remains unchanged');
    assert.throws(() => f.services.imageApproval({projectId: project.id, reviewId: review.id, expectedRevision: 1}), {code: 'IMAGE_REVIEW_SETTINGS_CHANGED'});
    await assert.rejects(f.engines[i].put({expectedRevision: 1, configuration: configurations[i], ...(i === 2 ? {} : {secret: {action: 'remove'}})}),
      {code: i === 2 ? 'COMFY_SETTINGS_CONFLICT' : 'IMAGE_SETTINGS_CONFLICT'});
  }
  assert.equal(rows(f.store.db), before, 'rejected approval rolls its existing acceptance transaction back');
  assert.equal(f.counters.calls, 0); assert.equal(f.counters.decrypts, 0);
  for (const table of ['image_tasks','image_groups','image_requests','image_versions','image_remote_runs','image_remote_observations']) assert.equal(f.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0);
});

test('actual client keeps omitted request bytes and validates opt-in response against the exact call', async () => {
  const legacy = expectedProfiles(), expanded = withRevisions(legacy), requests: (BodyInit | null | undefined)[] = [];
  let returned:unknown = legacy;
  const client = (createClient({env: {MIOON_BASE_URL: 'http://127.0.0.1:4318', MIOON_TOKEN: token},
    fetchImpl: (async (_: string, options: RequestInit | undefined) => {requests.push(options!.body); return {status: 200, ok: true, json: async () => ({ok: true, data: returned})};}) as unknown as typeof fetch}) as TypedClient);
  assert.deepEqual(await client.rpc(operation), legacy);
  assert.equal(requests.at(-1), JSON.stringify({operation, input: {}}));
  for (const input of [{}, {includeSettingsRevision: false}, optIn]) {
    returned = legacy; assert.deepEqual(await client.rpc(operation, input), legacy);
    returned = expanded;
    if ((input as {includeSettingsRevision?:boolean}).includeSettingsRevision === true) assert.deepEqual(await client.rpc(operation, input), expanded);
    else await assert.rejects(client.rpc(operation, input), {code: 'BACKEND_PROTOCOL_ERROR'});
    assert.equal(requests.at(-1), JSON.stringify({operation, input}));
  }
  for (const bad of [withRevisions(legacy, [0, 22, 33]), {...expanded, secret: 'hidden'},
    {...expanded, items: [{...expanded.items[0], settingsRevision: 1}, ...expanded.items.slice(1)]}]) {
    returned = bad; await assert.rejects(client.rpc(operation, optIn), {code: 'BACKEND_PROTOCOL_ERROR'});
  }
  const count = requests.length;
  for (const input of [{includeSettingsRevision: 'true'}, {...optIn, credentials: {}}]) await assert.rejects(client.rpc(operation, input));
  assert.equal(requests.length, count, 'invalid input never reaches HTTP');
});

test('new client remains compatible by default with an old strict server and never retries or guesses an opt-in revision', async () => {
  const requests: (unknown)[] = [], legacy = expectedProfiles(), oldInput = z.object({}).strict();
  const client = (createClient({env: {MIOON_BASE_URL: 'http://127.0.0.1:4318', MIOON_TOKEN: token},
    fetchImpl: (async (_: string, options: RequestInit | undefined) => {
      const request = JSON.parse(options!.body as string); requests.push(request);
      const accepted = oldInput.safeParse(request.input).success;
      return {status: accepted ? 200 : 400, ok: accepted, json: async () => accepted ? {ok: true, data: legacy} :
        {ok: false, error: {code: 'VALIDATION_ERROR', message: 'Unrecognized includeSettingsRevision field'}}};
    }) as unknown as typeof fetch}) as TypedClient);
  assert.deepEqual(await client.rpc(operation), legacy);
  assert.deepEqual(requests, [{operation, input: {}}]);
  await assert.rejects(client.rpc(operation, optIn), {code: 'VALIDATION_ERROR'});
  assert.deepEqual(requests, [{operation, input: {}}, {operation, input: optIn}], 'no downgrade, retry or guessed revision');
});

function childEnvironment(extra: NodeJS.ProcessEnv = {}) {
  const clean = Object.fromEntries(['PATH','HOME','TMPDIR','TEMP','LANG','SYSTEMROOT','COMSPEC']
    .filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]));
  return {...clean, TZ: 'UTC', MIOON_ENABLE_LIVE_PROVIDER: '0', ...extra};
}
async function cli(input: {}, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [path.join(repo, 'apps/cli/src/index.ts'), 'rpc', operation, '--input', JSON.stringify(input)],
    {cwd: repo, env: childEnvironment(env), stdio: ['ignore','pipe','pipe']});
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => {stdout += chunk; if (stdout.length > 1024 * 1024) child.kill('SIGKILL');});
  child.stderr.setEncoding('utf8').on('data', chunk => {stderr = (stderr + chunk).slice(-20000);});
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  let code, signal; try {[code, signal] = await once(child, 'close');} finally {clearTimeout(timeout);}
  assert.equal(signal, null, stderr); assert.equal(code, 0, stdout + stderr);
  assert.ok(!stdout.includes(token) && !stderr.includes(token));
  const envelope = JSON.parse(stdout); assert.equal(envelope.ok, true); return envelope.data;
}
async function settingFiles(root: string) {
  const result:Record<string,string> = {};
  async function walk(directory:string) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filename); else result[path.relative(root, filename)] = (await readFile(filename)).toString('base64');
    }
  }
  for (const name of ['image-settings', 'comfy-settings']) await walk(path.join(root, name));
  return result;
}

test('real HTTP, CLI and official MCP discover the same revisions without provider I/O, writes or added mutation authority', {timeout: 60000}, async (t: test.TestContext) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-image-profile-wire-'));
  let server:Awaited<ReturnType<typeof startServer>>,db:DatabaseSync, mcp: Client<{ method: string; params?: { [x: string]: unknown; _meta?: { [x: string]: unknown; progressToken?: string|number|undefined; "io.modelcontextprotocol/related-task"?: { taskId: string; }|undefined; }|undefined; }|undefined; },{ method: string; params?: { [x: string]: unknown; _meta?: { [x: string]: unknown; progressToken?: string|number|undefined; "io.modelcontextprotocol/related-task"?: { taskId: string; }|undefined; }|undefined; }|undefined; },{ [x: string]: unknown; _meta?: { [x: string]: unknown; progressToken?: string|number|undefined; "io.modelcontextprotocol/related-task"?: { taskId: string; }|undefined; }|undefined; }>;
  t.after(async () => {await mcp?.close(); db?.close(); await server?.close(); await rm(root, {recursive: true, force: true});});
  const calls = {dns: 0, https: 0, comfy: 0, decrypt: 0, encrypt: 0, refresh: 0};
  const deny = (key:keyof typeof calls) => () => {calls[key]++; throw Error('Discovery cannot access a provider');};
  server = await startServer(({dataDir: root, port: 0, token,
    imageNetwork: {lookup: deny('dns'), httpsRequest: deny('https')}, comfyNetwork: {httpRequest: deny('comfy')},
    imageSecretCodec: {storage: () => ({persistentAvailable: true, sessionScope: 'server', reasonCode: null}),
      refreshStorage() {calls.refresh++;}, encrypt() {calls.encrypt++; return Buffer.from('SYNTHETIC_PROFILE_CIPHERTEXT').toString('base64');}, decrypt: deny('decrypt')}} as unknown as Parameters<typeof startServer>[0]));
  const env = {MIOON_BASE_URL: server.url, MIOON_TOKEN: token}, client = (createClient({env}) as TypedClient);
  async function request(route: string, input: unknown) {
    const response = await fetch(server.url + route, {method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`}, body: JSON.stringify(input)});
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.ok, true); return body.data;
  }
  for (let i = 0; i < 3; i++) {
    for (let revision = 0; revision <= i; revision++) await request(['/api/images/settings','/api/images/custom-settings','/api/images/comfy-settings'][i],
      {expectedRevision: revision, configuration: configurations[i], ...(i === 2 ? {} : {secret: revision ? {action: 'keep'} :
        {action: 'replace', storage: 'persistent', value: 'SYNTHETIC_PROFILE_SECRET'}})});
  }
  db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true});
  const before = rows(db), version = db.prepare('PRAGMA data_version').get()!.data_version, files = await settingFiles(root), beforeCalls = clone(calls);
  mcp = new Client({name: 'image-profile-discovery-test', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath, args: [path.join(repo, 'apps/mcp/src/index.ts')],
    cwd: repo, env: childEnvironment(env), stderr: 'pipe'});
  let stderr = ''; (transport.stderr as import('node:stream').Readable|null)?.setEncoding('utf8').on('data', (chunk: string) => {stderr = (stderr + chunk).slice(-20000);});
  await mcp.connect(transport);
  const tools = (await mcp.listTools()).tools, definition = operationDefinition(operation);
  const tool = tools.find(value => value.name === 'image_profile_list');
  assert.deepEqual(tool!.inputSchema, definition.inputSchema);
  assert.equal(tool!.inputSchema.additionalProperties, false);
  assert.equal((tool!.inputSchema.properties!.includeSettingsRevision as {type:string}).type, 'boolean');
  assert.equal(Object.hasOwn(tool!.inputSchema.properties!.includeSettingsRevision, 'default'), false);
  assert.ok(!tool!.inputSchema.required?.includes('includeSettingsRevision'));
  assert.equal(definition.effects.readOnly, true);
  for (const effect of ['externalIO','localProcess','paidGeneration','openWorld','destructive']) assert.equal(definition.effects[effect as keyof typeof definition.effects], false);
  assert.equal(definition.requiresRequestId, false);
  assert.deepEqual(tool!.annotations, {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false});
  assert.ok(!tools.some(value => /image_review_approve|image.*settings|comfy.*check/i.test(value.name)));
  assert.deepEqual(READ_TOOL_DEFINITIONS.map(value => value.name), ['mioon_project_inspect','mioon_asset_inspect','mioon_shot_inspect','mioon_timeline_inspect']);
  assert.deepEqual(EDIT_TOOL_DEFINITIONS.map(value => value.name), ['mioon_propose_shot_update']);
  for (const input of [{}, {includeSettingsRevision: false}, optIn]) {
    const response:Response = await fetch(server.url + '/api/rpc', {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`}, body: JSON.stringify({operation, input})});
    assert.equal(response.status, 200); const envelope = await response.json(); assert.equal(envelope.ok, true);
    const expected = (input as {includeSettingsRevision?:boolean}).includeSettingsRevision === true ? withRevisions(expectedProfiles({enabled: [true, true, false]}), [1, 2, 3]) : expectedProfiles({enabled: [true, true, false]});
    assert.equal(JSON.stringify(envelope.data), JSON.stringify(expected));
    assert.deepEqual(await client.rpc(operation, input), envelope.data);
    assert.deepEqual(await cli(input, env), envelope.data);
    const result = await mcp.callTool({name:'image_profile_list',arguments:input}) as import('@modelcontextprotocol/sdk/types.js').CallToolResult;
    assert.equal(result.isError, false); assert.deepEqual(result.structuredContent, envelope);
    assert.deepEqual(JSON.parse((result.content.find(block=>block.type==='text') as {text:string}).text), envelope);
    publicOnly(envelope, root); publicOnly(result, root);
    if (!(input as {includeSettingsRevision?:boolean}).includeSettingsRevision) assert.ok(oldResponse.safeParse(envelope.data).success);
  }
  const bad = await fetch(server.url + '/api/rpc', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
    body: JSON.stringify({operation, input: {...optIn, settings: {}}}), signal: AbortSignal.timeout(10000)});
  assert.equal((await bad.json()).error.code, 'VALIDATION_ERROR');
  assert.equal(rows(db), before); assert.equal(db.prepare('PRAGMA data_version').get()!.data_version, version);
  assert.deepEqual(await settingFiles(root), files); assert.deepEqual(calls, beforeCalls);
  assert.equal(calls.dns + calls.https + calls.comfy + calls.decrypt, 0); assert.ok(!stderr.includes(token));
});
