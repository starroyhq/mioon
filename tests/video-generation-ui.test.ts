import { providerDisplayName } from '../apps/web/src/creation-i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultVideoModels, resolveVideoEndpoint, videoBindingCapabilities } from '../packages/contracts/src/video-providers.ts';
import type { VideoConnectionDescriptor, VideoExecutionBinding } from '../packages/contracts/src/video-providers.ts';
import { generationSelection, generationParameters, videoConnectionProviders, generationInputIssue, generationProfileSelection, findGenerationProvider } from '../apps/web/src/generation-settings.ts';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const idA = '00000000-0000-4000-8000-000000000011', idB = '00000000-0000-4000-8000-000000000012';
function descriptor(connectionId = idA): VideoConnectionDescriptor {
  const models = defaultVideoModels('wan').filter(model => model.templateId === 'wan27-t2v');
  models[0] = { ...models[0]!, durationResolutionMap: [{ duration: [5], resolution: ['720P'] }, { duration: [10], resolution: ['1080P'] }], modelId: 'manually-added-exact-model' };
  return { connectionId, providerId: 'wan', configurationRevision: 3, name: `Account ${connectionId.slice(-2)}`, region: 'cn-beijing', configured: true, enabled: true, archived: false,
    models: models.map(entry => { const binding: VideoExecutionBinding = { version: 1, connectionId, configurationRevision: 3, providerId: 'wan', region: 'cn-beijing', workspaceId: '', endpoint: resolveVideoEndpoint('wan', 'cn-beijing'), credentialRef: '00000000-0000-4000-8000-000000000099', model: entry, outputHosts: ['video.example.com'] }; return { entry, capabilities: videoBindingCapabilities(binding) }; }) };
}
const shot = { prompt: 'A quiet sunset', aspectRatio: '16:9', duration: 5, parameters: {}, referenceAssetIds: [] };

test('retired Runway choices never fall back to another connection while historical lookup remains available', () => {
  const environment = { id: 'runway', configured: true, status: 'available', models: ['gen4_turbo'] };
  const connection = { ...environment, connectionId: idA };
  const mock = { id: 'mock', mock: true, configured: true, status: 'available', models: ['mock-v1'] };
  const providers = [environment, connection, mock];
  assert.equal(generationSelection(providers, { providerId: 'runway', model: 'gen4_turbo' }, shot).provider, undefined);
  assert.equal(generationSelection(providers, { connectionId: idA, model: 'gen4_turbo' }, shot).provider, undefined);
  assert.equal(generationSelection([environment, connection], {}, shot).provider, undefined);
  assert.equal(findGenerationProvider(providers, 'runway'), environment);
  assert.equal(findGenerationProvider(providers, 'runway', idA), connection);
});

test('separate accounts of one provider keep their connection and model entry identities', () => {
  const a = descriptor(), b = descriptor(idB), providers = videoConnectionProviders([a, b]);
  const selected = generationSelection(providers, { providerId: 'wan', connectionId: idB, modelEntryId: b.models[0]!.entry.id }, shot);
  assert.equal(providerDisplayName(selected.provider, () => ''), b.name);
  assert.equal(selected.provider?.connectionId, idB); assert.equal(selected.modelEntryId, b.models[0]!.entry.id);
  assert.equal(selected.model, 'manually-added-exact-model');
  assert.equal(generationProfileSelection(selected.provider, selected.model).state, 'ready');
  const removed = generationSelection(videoConnectionProviders([a]), { providerId: 'wan', connectionId: idB, modelEntryId: b.models[0]!.entry.id }, shot);
  assert.equal(removed.provider, undefined);
  const defaulted = generationSelection(providers, {}, shot); assert.equal(defaulted.provider, undefined, 'No paid connection is selected implicitly');
});

test('a removed entry cannot reuse another entry even when raw model IDs match', () => {
  const d = descriptor(), providers = videoConnectionProviders([d]);
  const selected = generationSelection(providers, { connectionId: idA, model: d.models[0]!.entry.modelId, modelEntryId: idB }, shot);
  assert.equal(selected.capabilities, null); assert.equal(selected.provider?.videoModel, undefined);
  assert.notEqual(generationInputIssue(shot, selected.provider, selected.model, [], 'text'), '');
});

test('resolution defaults and overrides preserve exact duration-resolution pairs outside shot state', () => {
  const d = descriptor(), providers = videoConnectionProviders([d]);
  const selected = generationSelection(providers, { connectionId: idA }, shot);
  const parameters = generationParameters(shot, selected.provider);
  assert.equal(parameters.resolution, '720P'); assert.deepEqual(shot.parameters, {});
  assert.equal(generationInputIssue({ ...shot, parameters }, selected.provider, selected.model, [], 'text'), '');
  const unsupported = generationParameters(shot, selected.provider, { parameters: { resolution: '1080P' } });
  assert.notEqual(generationInputIssue({ ...shot, parameters: unsupported }, selected.provider, selected.model, [], 'text'), '');
  assert.deepEqual(generationParameters(shot, { id: 'mock' }, { parameters: { resolution: '1080P' } }), {});
});

test('models page SSR renders safe inactive controls without provider calls', () => {
  const script = `import {build} from 'esbuild';
    const {outputFiles}=await build({stdin:{contents:${JSON.stringify("import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server.browser'; import VideoProviderSettings from './VideoProviderSettings.tsx'; import { ConfirmationProvider } from '@mioon/ui/components/workbench-confirm'; export const html=renderToStaticMarkup(<ConfirmationProvider><VideoProviderSettings active={false}/></ConfirmationProvider>);")},loader:'tsx',resolveDir:${JSON.stringify(resolve('apps/web/src'))}},bundle:true,format:'esm',platform:'browser',write:false,loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
    try { const {html}=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));process.stdout.write(html);process.exit(0); } catch(error) { process.stderr.write(error.message); process.exit(1); }`;
  const html = execFileSync(process.execPath, ['--input-type=module'], { input: script, encoding: 'utf8', timeout: 30000 });
  assert.ok(html.includes('Seedance')); assert.doesNotMatch(html, /Runway|官方供应商/); assert.ok(html.includes('供应商')); assert.ok(html.includes('video-add-connection')); assert.ok(html.includes('disabled'));
  assert.ok(html.includes('video-provider-settings')); assert.doesNotMatch(html, /value="sk-|Bearer /);
});

test('duplicate exact Ark models select their own entry profile instead of an ambiguous merged profile', () => {
  const first = defaultVideoModels('ark')[0]!, second = { ...structuredClone(first), id: idB, name: 'Second exact model entry' };
  const d: VideoConnectionDescriptor = { connectionId: idA, providerId: 'ark', configurationRevision: 3, name: 'Ark account', region: 'cn-beijing', configured: true, enabled: true, archived: false,
    models: [first, second].map(entry => ({ entry, capabilities: videoBindingCapabilities({ version: 1, connectionId: idA, configurationRevision: 3, providerId: 'ark', region: 'cn-beijing', workspaceId: '', endpoint: resolveVideoEndpoint('ark', 'cn-beijing'), credentialRef: '00000000-0000-4000-8000-000000000099', model: entry, outputHosts: [] }) })) };
  const selected = generationSelection(videoConnectionProviders([d]), { connectionId: idA, modelEntryId: second.id }, shot);
  assert.equal(selected.modelEntryId, second.id);
  assert.equal((selected.provider?.inputProfiles as unknown[]).length, 1);
  assert.equal(generationProfileSelection(selected.provider, selected.model).state, 'ready');
});

test('actual App prepare and submit keep reviewed account, configuration revision and effective parameters on wire', async () => {
  const { readFileSync } = await import('node:fs');
  const { lenientFunction } = await import('./helpers/eval-source.ts');
  const settings = await import('../apps/web/src/generation-settings.ts');
  const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const d = descriptor(idB), providers = videoConnectionProviders([descriptor(), d]);
  const options = { connectionId: idB, providerId: 'wan', modelEntryId: d.models[0]!.entry.id, parameters: { resolution: '1080P' } };
  const currentShot = { ...shot, id: 'shot-a', projectId: 'project-a', revision: 7, duration: 10 };
  const reviews: Array<Record<string, unknown>> = [], calls: unknown[][] = [];
  const scope = { ...settings, providers, generationOptionsRef: { current: { 'shot-a': options } }, currentProject: { current: 'project-a' }, dataRef: { current: { shots: [currentShot] } }, subjectVideoIdentity: () => '', checkGeneration: () => true,
    captureTaskWorkspaceIntent: () => () => false, readTaskRevealContext: () => ({}), run: (...args: unknown[]) => { calls.push(args); return Promise.resolve({ status: 'queued' }); }, requestId: () => 'synthetic-request', notify: () => {}, openTasks: () => {}, msg: () => '',
    reviewGeneration: (value: Record<string, unknown>) => reviews.push(structuredClone(value)) };
  const extracted = app.slice(app.indexOf('  const submitGeneration ='), app.indexOf('  function retryGeneration('));
  const methods = lenientFunction(...Object.keys(scope), `${extracted}; return { generate, submitGeneration };`)(...Object.values(scope)) as { generate: (value: unknown, options?: unknown) => void; submitGeneration: (value: unknown) => Promise<unknown> };
  methods.generate(currentShot, options);
  assert.equal(reviews.length, 1); const review = reviews[0]!;
  assert.equal(review.connectionId, idB); assert.equal(review.configurationRevision, 3); assert.equal(review.modelEntryId, d.models[0]!.entry.id);
  assert.deepEqual((review.shot as typeof currentShot).parameters, { resolution: '1080P' });
  await methods.submitGeneration(review);
  const wire = calls[0]![2] as Record<string, unknown>;
  assert.equal(wire.connectionId, idB); assert.equal(wire.configurationRevision, 3); assert.equal(wire.modelEntryId, d.models[0]!.entry.id); assert.equal(wire.providerId, 'wan');
  assert.deepEqual(wire.parameters, { resolution: '1080P' });
  const count = calls.length;
  await methods.submitGeneration({ ...review, configurationRevision: 2 }); assert.equal(calls.length, count, 'A changed revision cannot submit');
});
