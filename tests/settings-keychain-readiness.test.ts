import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import desktopIdentity from '../apps/desktop/identity.ts';
import {createAgentSettingsBroker, createAgentSettingsClient} from '../apps/desktop/src/secret-broker.ts';
import {createDesktopAgentSettings} from '../apps/desktop/src/secret-store.ts';
import type {DesktopSafeStorage} from '../apps/desktop/src/secret-store.ts';
import {createImageSecretBroker, createImageSecretClient} from '../apps/desktop/src/image-secret-broker.ts';
import {createDesktopImageSecretCodec} from '../apps/desktop/src/image-secret-store.ts';
import {createVideoSecretBroker, createVideoSecretClient} from '../apps/desktop/src/video-secret-broker.ts';
import {createDesktopVideoSecretCodec} from '../apps/desktop/src/video-secret-store.ts';
import {startServer} from './helpers/test-server.ts';
import {createAgentSettingsClient as createAgentSettingsHttpClient, createAgentSettingsSession} from '../apps/web/src/agent-settings.ts';
import {createGenerationImageServicesClient, createGenerationImageServicesOwner} from '../apps/web/src/generation-image-services-settings.ts';
import {createGenerationVideoServicesSession} from '../apps/web/src/generation-video-services.ts';
import {createVideoSettingsClient} from '../apps/web/src/video-settings.ts';
import {agentServiceInput} from '../packages/contracts/src/agent-connection-settings.ts';

class TestPort extends EventEmitter {
  send = (_message: unknown) => {};
  postMessage(message: unknown) {this.send(message);}
  reply = (data: unknown) => {this.emit('message', {data});};
}

test('all settings forms can edit committed configuration while one native Keychain operation remains held', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-settings-keychain-')));
  const availability = Promise.withResolvers<boolean>();
  const writeEntered = Promise.withResolvers<void>(), writeRelease = Promise.withResolvers<void>();
  let checks = 0, holdEncryption = false;
  const safeStorage = {
    isEncryptionAvailable: () => assert.fail('macOS must not probe synchronously'),
    getSelectedStorageBackend: () => assert.fail('macOS must not probe synchronously'),
    encryptString: () => assert.fail('macOS must not encrypt synchronously'),
    decryptString: () => assert.fail('macOS must not decrypt synchronously'),
    isAsyncEncryptionAvailable: () => {checks++; return availability.promise;},
    async encryptStringAsync(value: string) {
      if (holdEncryption) {writeEntered.resolve(); await writeRelease.promise;}
      return Buffer.from(value);
    },
    decryptStringAsync: async (value: Buffer) => ({result: value.toString(), shouldReEncrypt: false}),
  } satisfies DesktopSafeStorage;
  const options = {safeStorage, appId: desktopIdentity.identityForChannel('development').appId, platform: 'darwin' as const};
  t.after(() => {availability.resolve(false); writeRelease.resolve();});
  const agentSettings = await createDesktopAgentSettings({...options, userData: directory});
  const agentPort = new TestPort(), imagePort = new TestPort(), videoPort = new TestPort();
  const agentBroker = createAgentSettingsBroker({agentSettings, send: agentPort.reply});
  const imageBroker = createImageSecretBroker({imageSecretCodec: createDesktopImageSecretCodec(options), send: imagePort.reply});
  const videoBroker = createVideoSecretBroker({videoSecretCodec: createDesktopVideoSecretCodec(options), send: videoPort.reply});
  agentPort.send = agentBroker.handle; imagePort.send = imageBroker.handle; videoPort.send = videoBroker.handle;
  const agent = createAgentSettingsClient({port: agentPort}), image = createImageSecretClient({port: imagePort}), video = createVideoSecretClient({port: videoPort});
  const server = await startServer({dataDir: directory, port: 0, agentSettings: agent, imageSecretCodec: image, videoSecretCodec: video});
  const fetchLocal: typeof fetch = (input, init) => fetch(new URL(String(input), server.url), {...init, headers: {authorization: `Bearer ${server.token}`}});
  const agentHttp = createAgentSettingsHttpClient({fetchImpl: fetchLocal});
  const agentPage = createAgentSettingsSession({client: agentHttp});
  const videoPage = createGenerationVideoServicesSession({client: createVideoSettingsClient({fetchImpl: fetchLocal})});
  const imagePage = (kind: 'official' | 'custom' | 'comfy') => createGenerationImageServicesOwner(kind, {client: createGenerationImageServicesClient(kind, fetchLocal)});
  const official = imagePage('official'), custom = imagePage('custom'), comfy = imagePage('comfy');
  const imagePages = [official, custom, comfy];
  t.after(async () => {
    agentPage.dispose(); videoPage.dispose(); for (const page of imagePages) page.dispose();
    await server.close();
    agent.close(); image.close(); video.close(); agentBroker.close(); imageBroker.close(); videoBroker.close(); await agentSettings.close();
    await rm(directory, {recursive: true, force: true});
  });
  const loaded = await Promise.all([agentPage.load(), videoPage.load(), ...imagePages.map(page => page.load())]);
  assert.deepEqual(loaded, [true, true, true, true, true]);
  const pending = 'OS_SECRET_STORE_PENDING';
  assert.equal(agentPage.getState().snapshot?.storage.reasonCode, pending);
  assert.equal(videoPage.getState().snapshot?.storage.reasonCode, pending);
  for (const page of [official, custom]) {
    const snapshot = page.getState().snapshot;
    assert.ok(snapshot && 'storage' in snapshot);
    assert.equal(snapshot.storage.reasonCode, pending);
    assert.equal(snapshot.storage.persistentAvailable, false);
  }
  const service = agentPage.addCustom('Editable Agent draft');
  assert.ok(service);
  assert.equal(agentPage.setStorage(service, 'persistent'), false);
  const videoDraft = videoPage.getState().drafts[0]!;
  assert.equal(videoPage.update(videoDraft.key, {enabled: true}), true);
  assert.equal(videoPage.setStorage(videoDraft.key, 'persistent'), false);
  assert.equal(official.edit('image:official', {}, {enabled: true}), true);
  const customId = custom.add('Editable custom image draft');
  assert.ok(customId);
  assert.equal(comfy.edit('image:comfy', {}, {baseUrl: 'http://127.0.0.1:8188'}), true);
  assert.equal(checks, 1, 'all domains share one held native authorization');

  availability.resolve(true);
  const resolved = () => [agentPage.getState().snapshot, videoPage.getState().snapshot, official.getState().snapshot, custom.getState().snapshot]
    .every(snapshot => snapshot && 'storage' in snapshot && snapshot.storage.persistentAvailable);
  const deadline = performance.now() + 6000;
  while (!resolved() && performance.now() < deadline) await delay(25);
  assert.equal(resolved(), true, 'each visible settings form updates its storage after approval');
  assert.equal(checks, 1);
  assert.equal(agentPage.getState().draft?.services.find(entry => entry.serviceKey === service)?.name, 'Editable Agent draft');
  assert.equal(videoPage.getState().drafts[0]?.configuration.enabled, true);
  assert.equal(official.getState().drafts[0]?.configuration.enabled, true);
  assert.equal(custom.getState().drafts.find(entry => entry.id === customId)?.name, 'Editable custom image draft');

  // Hold a real write at the native boundary. Every GET must still see the
  // committed revision, even though the Agent write owns the cache queue.
  const before = await agentHttp.read();
  holdEncryption = true;
  const writing = agentHttp.write({expectedRevision: before.revision, services: before.services.map(agentServiceInput),
    mioSelection: before.mioSelection, secretActions: [{serviceKey: 'openai', action: 'replace', storage: 'persistent', value: 'synthetic-queued-key'}]});
  const entered = await Promise.race([writeEntered.promise.then(() => true), writing.then(() => false)]);
  assert.equal(entered, true);
  try {
    const [during, videoDuring, imageDuring, customDuring] = await Promise.all([
      agentHttp.read(), createVideoSettingsClient({fetchImpl: fetchLocal}).read(),
      createGenerationImageServicesClient('official', fetchLocal).read(), createGenerationImageServicesClient('custom', fetchLocal).read(),
    ]);
    assert.equal(during.revision, before.revision);
    assert.deepEqual(during.services, before.services);
    for (const snapshot of [during, videoDuring, imageDuring, customDuring]) {
      assert.ok(snapshot && typeof snapshot === 'object' && 'storage' in snapshot);
      assert.equal((snapshot.storage as {reasonCode: string}).reasonCode, pending);
    }
  } finally {writeRelease.resolve();}
  const committed = await writing;
  assert.equal(committed.revision, before.revision + 1);
  assert.deepEqual(await agentHttp.read(), committed);
  assert.equal(checks, 1);
});
