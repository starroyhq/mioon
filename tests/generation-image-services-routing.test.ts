import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createImageServices, listImageProfiles} from '../packages/business/src/images.ts';
import {createCustomImageSettingsV2} from '../packages/business/src/images/custom-settings-v2.ts';
import {DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2} from '../packages/contracts/src/generation-image-settings.ts';
import {IMAGE_FIXED_OPTIONS, imageProfilesResponseSchema} from '../packages/contracts/src/images.ts';
import {COMFY_IMAGE_OPTIONS} from '../packages/contracts/src/comfy-images.ts';

test('ambiguous no-ID discovery never selects a connection and preparation refuses before any database write', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-g1-routing-')), store = openStore(root);
  const projectId = String(store.db.prepare('SELECT projectId FROM project.project_file').get()!.projectId);
  store.put('projects', {id: projectId, name: 'Synthetic routing fixture'});
  const settings = await createCustomImageSettingsV2({persistence: {load: async () => null, save: async () => {}}});
  let services: ReturnType<typeof createImageServices> | undefined;
  t.after(async () => {await services?.drain(); await settings.close(); store.close(); rmSync(root, {recursive: true, force: true});});
  const configuration = {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2, enabled: true, baseUrl: 'https://images.example.com/v1', model: 'same-model'};
  const [a, b] = [randomUUID(), randomUUID()];
  await settings.batch({expectedRevision: 0, operations: [
    {action: 'create', connectionId: a, name: 'A', configuration, secret: {action: 'replace', storage: 'session', value: 'synthetic-key-A'}},
    {action: 'create', connectionId: b, name: 'B', configuration, secret: {action: 'replace', storage: 'session', value: 'synthetic-key-B'}},
  ]});
  const profiles = listImageProfiles({customSettingsV2: settings}, {includeSettingsRevision: true});
  const custom = profiles.items.filter(item => item.providerId === 'openai-compatible');
  assert.equal(custom.length, 1); assert.equal(custom[0].model, configuration.model); assert.equal(custom[0].enabled, false);
  assert.match(custom[0].name, /有多个自定义图片服务/);
  assert.equal('connectionId' in custom[0], false); assert.equal(JSON.stringify(custom).includes(a), false);
  services = createImageServices(store, {customSettingsV2: settings, autoRun: false});
  // total_changes is connection-wide; capture all retained rows as well.
  const before = store.db.prepare('SELECT total_changes() AS n').get()!.n;
  const reviews = JSON.stringify(store.db.prepare('SELECT * FROM image_reviews').all());
  const input = {projectId, requestId: randomUUID(), providerId: 'openai-compatible', model: configuration.model,
    name: 'Synthetic image', prompt: 'No provider call', options: {...IMAGE_FIXED_OPTIONS}};
  assert.throws(() => services!.handlers['image.review.prepare']({input, settingsRevision: custom[0].settingsRevision}), {code: 'IMAGE_SETTINGS_SELECTION_REQUIRED'});
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get()!.n, before);
  assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM image_reviews').all()), reviews);
  const listed = services.generationServices('image.service.list', {projectId}) as {items: {connectionId: string}[]};
  assert.deepEqual(listed.items.map(item => item.connectionId), [a, b]);
  assert.equal(JSON.stringify(listed).includes('synthetic-key'), false);
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get()!.n, before);
});

test('a maximum-length service name remains intact while the legacy status label stays valid UTF-16 and bounded', async t => {
  const settings = await createCustomImageSettingsV2({persistence: {load: async () => null, save: async () => {}}});
  t.after(() => settings.close());
  const suffix = ' · 需逐次确认', boundary = 120 - suffix.length;
  const name = 'x'.repeat(boundary - 1) + '🙂' + 'y'.repeat(suffix.length - 1);
  assert.equal(name.length, 120);
  await settings.create({expectedRevision: 0, connectionId: randomUUID(), name,
    configuration: {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2, enabled: true, baseUrl: 'https://images.example.com/v1', model: 'single-model'},
    secret: {action: 'replace', storage: 'session', value: 'synthetic-key'}});
  const profiles = imageProfilesResponseSchema.parse(listImageProfiles({customSettingsV2: settings}, {includeSettingsRevision: true}));
  const profile = profiles.items.find(item => item.providerId === 'openai-compatible')!;
  assert.equal(profile.enabled, true); assert.ok(profile.name.length <= 120);
  assert.equal(profile.name.endsWith(suffix), true); assert.equal(profile.name.includes('\uD83D'), false);
  assert.equal(settings.readCurrent().connections[0].name, name);
});

test('different custom models remain valid neutral discovery groups and every old no-ID prepare refuses without writes', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-g1-model-groups-')), store = openStore(root);
  const projectId = store.projectId; store.put('projects', {id: projectId, name: 'Synthetic model groups'});
  const settings = await createCustomImageSettingsV2({persistence: {load: async () => null, save: async () => {}}});
  let services: ReturnType<typeof createImageServices> | undefined;
  t.after(async () => {await services?.drain(); await settings.close(); store.close(); rmSync(root, {recursive: true, force: true});});
  const ids = Array.from({length: 10}, () => randomUUID());
  await settings.batch({expectedRevision: 0, operations: ids.map((connectionId, index) => ({action: 'create', connectionId,
    name: `Custom ${index}`, configuration: {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2, enabled: true,
      baseUrl: 'https://images.example.com/v1', model: `different-model-${index}`},
    secret: {action: 'replace', storage: 'session', value: `synthetic-key-${index}`}}))});
  services = createImageServices(store, {customSettingsV2: settings, autoRun: false});
  const profiles = services.handlers['image.profile.list']({includeSettingsRevision: true});
  const parsed = imageProfilesResponseSchema.parse(profiles), custom = parsed.items.filter(item => item.providerId === 'openai-compatible');
  assert.equal(custom.length, 10); assert.equal(parsed.items.length, 12); assert.equal(parsed.liveEnabled, false);
  assert.deepEqual(custom.map(item => item.model), ids.map((_, index) => `different-model-${index}`));
  assert.ok(custom.every(item => !item.enabled && item.settingsRevision === 1 && !Object.hasOwn(item, 'connectionId')));
  assert.ok(ids.every(id => !JSON.stringify(profiles).includes(id)));
  const before = store.db.prepare('SELECT total_changes() AS n').get()!.n;
  for (const profile of custom) assert.throws(() => services!.handlers['image.review.prepare']({input: {projectId,
    requestId: randomUUID(), providerId: 'openai-compatible', model: profile.model, name: 'No ID', prompt: 'Never dispatched',
    options: {...IMAGE_FIXED_OPTIONS}}, settingsRevision: profile.settingsRevision}), {code: 'IMAGE_SETTINGS_SELECTION_REQUIRED'});
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get()!.n, before);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM image_reviews').get()!.n, 0);

  // Three singleton providers plus ten custom model groups is the exact cap.
  const full = {...parsed, items: [...parsed.items, {providerId: 'comfy-local', model: 'model.safetensors', name: 'Comfy',
    enabled: false, isMock: false, evidence: 'offline-tested-not-live', options: {...COMFY_IMAGE_OPTIONS}}]};
  assert.equal(imageProfilesResponseSchema.safeParse(full).success, true);
  assert.equal(imageProfilesResponseSchema.safeParse({...parsed, items: [...parsed.items, parsed.items[0]]}).success, false);
  assert.equal(imageProfilesResponseSchema.safeParse({...parsed, items: [...parsed.items, {...custom[0], model: 'eleventh-model'}]}).success, false);
  assert.equal(imageProfilesResponseSchema.safeParse({...parsed, items: [...parsed.items, custom[0]]}).success, false);
  assert.equal(imageProfilesResponseSchema.safeParse({...parsed, liveEnabled: true,
    items: parsed.items.map(item => item === custom[0] ? {...item, enabled: true} : item)}).success, false);
  assert.equal(imageProfilesResponseSchema.safeParse({...parsed,
    items: parsed.items.map(item => item === custom[0] ? {...item, settingsRevision: 2} : item)}).success, false);
});
