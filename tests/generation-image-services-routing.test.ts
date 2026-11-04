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
import {IMAGE_FIXED_OPTIONS} from '../packages/contracts/src/images.ts';

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
