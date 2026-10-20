import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createVideoSettings} from '../packages/business/src/video/settings.ts';
import {listVideoConnections} from '../packages/business/src/video/generation.ts';
import {newVideoConnection} from '../apps/web/src/video-settings.ts';
import {readGenerationProviderDirectory} from '../apps/web/src/video-provider-directory.ts';
import {findGenerationProvider, generationSelection} from '../apps/web/src/generation-settings.ts';
import type {GenerationProvider} from '../apps/web/src/generation-settings.ts';

const legacy: GenerationProvider[] = [
  {id: 'mock', mock: true, configured: true, enabled: true, status: 'available', models: ['mock-v1']},
  {id: 'minimax', mock: false, configured: true, enabled: true, status: 'available', models: ['MiniMax-H3']},
];
const asOf = '2026-10-20';

test('a corrupt private video file degrades only its directory and a repaired service restores discovery', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-video-directory-')));
  const options = {directory: path.join(root, 'video-settings'), privateRoot: root};
  let settings = await createVideoSettings(options);
  t.after(async () => {await settings.close(); await rm(root, {recursive: true, force: true});});
  const configuration = newVideoConnection('minimax'); configuration.enabled = true;
  await settings.put({action: 'save', expectedRevision: 0, configuration, secret: {action: 'replace', storage: 'session', value: 'synthetic-video-directory-key'}});
  const original = await readFile(path.join(options.directory, 'settings.json'));
  const calls: string[] = [];
  const call = async (operation: string): Promise<unknown> => {
    calls.push(operation);
    if (operation === 'provider.list') return structuredClone(legacy);
    assert.equal(operation, 'video.connection.list');
    return listVideoConnections(settings, asOf);
  };
  const healthy = await readGenerationProviderDirectory(call);
  assert.equal(healthy.videoUnavailable, false);
  assert.deepEqual(healthy.providers.filter(provider => !provider.connectionId), legacy);
  assert.equal(findGenerationProvider(healthy.providers, 'minimax', configuration.id)?.connectionId, configuration.id);
  await settings.close();
  await writeFile(path.join(options.directory, 'settings.json'), '{corrupt-private-video-file', {mode: 0o600});
  settings = await createVideoSettings(options);
  await assert.rejects(settings.get(), {code: 'VIDEO_SETTINGS_CORRUPT'});
  const degraded = await readGenerationProviderDirectory(call);
  assert.equal(degraded.videoUnavailable, true);
  assert.deepEqual(degraded.providers, legacy);
  assert.equal(findGenerationProvider(degraded.providers, 'minimax', configuration.id), undefined);
  const selected = generationSelection(degraded.providers, {providerId: 'minimax', connectionId: configuration.id, modelEntryId: configuration.models[0]!.id, model: configuration.models[0]!.modelId});
  assert.equal(selected.provider, undefined, 'A failed directory must not borrow the environment account or another connection');
  assert.ok(!degraded.providers.some(provider => provider.connectionId), 'Previously discovered connections must not survive a directory failure');
  await settings.close();
  await writeFile(path.join(options.directory, 'settings.json'), original, {mode: 0o600});
  settings = await createVideoSettings(options);
  const repaired = await readGenerationProviderDirectory(call);
  assert.equal(repaired.videoUnavailable, false);
  assert.equal(findGenerationProvider(repaired.providers, 'minimax', configuration.id)?.connectionId, configuration.id);
  assert.deepEqual(repaired.providers.filter(provider => !provider.connectionId), legacy);
  assert.equal(calls.filter(operation => operation === 'provider.list').length, 3);
  assert.equal(calls.filter(operation => operation === 'video.connection.list').length, 3);
});

for (const value of [undefined, null, {}, [{connectionId: 'invalid', models: null}]]) test('malformed video directory data does not remove legacy providers: '+JSON.stringify(value), async () => {
  const result = await readGenerationProviderDirectory(async operation => operation === 'provider.list' ? structuredClone(legacy) : value);
  assert.deepEqual(result.providers, legacy);
  assert.equal(result.videoUnavailable, true);
});

test('an empty valid video directory is available and does not add connections', async () => {
  const result = await readGenerationProviderDirectory(async operation => operation === 'provider.list' ? structuredClone(legacy) : []);
  assert.deepEqual(result.providers, legacy);
  assert.equal(result.videoUnavailable, false);
});

test('a non-auth video RPC failure remains isolated without retrying discovery', async () => {
  const calls: string[] = [];
  const result = await readGenerationProviderDirectory(async operation => {
    calls.push(operation);
    if (operation === 'provider.list') return structuredClone(legacy);
    throw Object.assign(new Error('Synthetic connection directory unavailable'), {code: 'VIDEO_SETTINGS_SAVE_FAILED'});
  });
  assert.deepEqual(result.providers, legacy); assert.equal(result.videoUnavailable, true);
  assert.equal(calls.filter(operation => operation === 'video.connection.list').length, 1);
});

for (const identity of [{code: 'UNAUTHORIZED'}, {status: 401}, {code: 'UNAUTHORIZED', status: 401}]) test('video authentication failures are propagated: '+JSON.stringify(identity), async () => {
  const denied = Object.assign(new Error('Synthetic authentication rejection'), identity);
  await assert.rejects(readGenerationProviderDirectory(async operation => {
    if (operation === 'provider.list') return structuredClone(legacy);
    throw denied;
  }), error => error === denied);
});

test('the original legacy provider failure is propagated unchanged', async () => {
  const failed = Object.assign(new Error('Original provider discovery failed'), {code: 'LEGACY_PROVIDER_FAILURE'});
  await assert.rejects(readGenerationProviderDirectory(async operation => {
    if (operation === 'provider.list') throw failed;
    return [];
  }), error => error === failed);
});
