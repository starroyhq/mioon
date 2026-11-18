import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createVideoSettingsV2} from '../packages/business/src/video/settings-v2.ts';
import {createConfiguredVideoProvider} from '../packages/business/src/video/runtime.ts';
import {createTestSecretCodec, testSecretStorage} from './helpers/secret-codec.ts';

test('an accepted 0.2.0 Veo binding still queries and downloads its original operation after Omni migration', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-omni-history-')));
  const envelope = JSON.parse(await readFile(new URL('./fixtures/google-omni-v020/settings.json', import.meta.url), 'utf8'));
  const binding = JSON.parse(await readFile(new URL('./fixtures/google-omni-v020/veo-task-binding.json', import.meta.url), 'utf8'));
  const owner = await createVideoSettingsV2({directory: path.join(root, 'settings'), privateRoot: root,
    secretCodec: createTestSecretCodec(), storage: testSecretStorage,
    persistence: {load: async () => ({envelope,notice:null}), save: async () => assert.fail('Read-only migration must not write settings')}});
  t.after(async () => {await owner.close(); await rm(root, {recursive: true, force: true});});
  const view = (await owner.get()).connections.find(entry => entry.configuration.providerId === 'veo')!;
  assert.equal(view.configuration.models[0]!.modelId, 'gemini-omni-1.2-flash');
  const id = 'models/veo-3.1-generate-preview/operations/accepted_legacy';
  const bytes = Buffer.from([0,0,0,20,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109]);
  const calls: string[] = [];
  const provider = createConfiguredVideoProvider({root, binding, acquireCredential: () => owner.acquire(binding),
    fetchImpl: async (url, init) => {
      assert.equal(init?.method, 'GET');
      assert.equal(new Headers(init.headers).get('x-goog-api-key'), 'mioon-go-synthetic-gemini-key');
      calls.push(String(url));
      if(String(url).endsWith('/' + id)) return new Response(JSON.stringify({name: id, done: true,
        response: {generateVideoResponse: {generatedSamples: [{video: {uri: 'https://generativelanguage.googleapis.com/v1beta/files/legacy-output:download'}}]}}}));
      assert.equal(String(url), 'https://generativelanguage.googleapis.com/v1beta/files/legacy-output:download?alt=media');
      return new Response(new Uint8Array(bytes));
    }});
  assert.equal((await provider.poll(id,{})).status, 'succeeded');
  const destination = path.join(root, 'legacy.mp4');
  await provider.download(id, destination,{});
  assert.deepEqual(await readFile(destination), bytes);
  assert.equal(calls.length, 2);
  await assert.rejects(provider.submit({providerId: 'veo', model: binding.model.modelId, prompt: 'Historical task',
    duration: 4, aspectRatio: '9:16', parameters: {resolution: '720p'}, referenceAssets: []},{}),
    {code: 'MODEL_LIFECYCLE_REVALIDATION_REQUIRED'});
  assert.equal(calls.length, 2);
});
