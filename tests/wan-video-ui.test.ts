import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultVideoModels, resolveVideoEndpoint, videoBindingCapabilities } from '../packages/contracts/src/video-providers.ts';
import type { VideoExecutionBinding } from '../packages/contracts/src/video-providers.ts';
import { generationSelection, generationParameters, generationVideoInput, generationInputIssueDescriptor, generationReferenceIdentity, generationReferences, videoConnectionProviders, wanGenerationCapabilities } from '../apps/web/src/generation-settings.ts';
import type { GenerationVideoInput, GenerationAsset, GenerationProvider } from '../apps/web/src/generation-settings.ts';
import { newVideoConnection } from '../apps/web/src/video-settings.ts';
import { lenientFunction } from './helpers/eval-source.ts';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), connectionId = id(2);
function provider(narrow = false): GenerationProvider {
  const model = defaultVideoModels('wan').find(model => model.modelId === 'wan3.0-video')!;
  if (narrow) { model.durationResolutionMap = [{ duration: [10], resolution: ['1080P'] }]; model.aspectRatios = ['16:9']; }
  const binding: VideoExecutionBinding = { version: 1, providerId: 'wan', connectionId, configurationRevision: 3, region: 'cn-beijing', workspaceId: '', endpoint: resolveVideoEndpoint('wan', 'cn-beijing'), credentialRef: id(3), model, outputHosts: ['video.example.com'] };
  return videoConnectionProviders([{ connectionId, configurationRevision: 3, providerId: 'wan', name: 'Wan account', enabled: true, configured: true, archived: false, models: [{ entry: model, capabilities: videoBindingCapabilities(binding) }] }])[0]!;
}
const shot = { id: id(4), projectId, prompt: 'A quiet scene', duration: 4, aspectRatio: '9:16', revision: 1, referenceAssetIds: [], parameters: {} };
const assets: GenerationAsset[] = Array.from({ length: 11 }, (_, index) => ({ id: id(10 + index), projectId, name: `Image ${index + 1}`, sha256: index.toString(16).repeat(64), mimeType: 'image/png', width: 640, height: 640, relativePath: `assets/${id(10 + index)}.png`, sizeBytes: 100 }));
const input = (count = 10): GenerationVideoInput => ({ version: 1, mode: 'reference_images', images: assets.slice(0, count).map(asset => ({ role: 'reference_image', assetId: asset.id! })), prompt: '图1 is the landscape' });

test('new Wan connections use only both Wan 3.0 models and narrowed catalogs control defaults', () => {
  assert.deepEqual(newVideoConnection('wan').models.map(model => model.modelId), ['wan3.0-video', 'wan3.0-video-prime']);
  const p = provider(true), selected = generationSelection([p], { connectionId }, shot);
  assert.ok(wanGenerationCapabilities(selected.provider));
  assert.deepEqual(generationParameters(shot, selected.provider), { durationSeconds: 10, aspectRatio: '16:9', resolution: '1080P', generateAudio: true, promptExtend: true, watermark: false });
  assert.equal(shot.duration, 4); assert.equal(shot.aspectRatio, '9:16');
  assert.equal(generationVideoInput(shot, { videoInput: input() }, { id: 'mock' }), undefined);
  assert.equal(generationSelection([{ id: 'mock', models: ['mock-v1'], modelCapabilities: [{ id: 'mock-v1', inputModes: ['text'] }] }], { providerId: 'mock', videoInput: input() }, shot).inputMode, 'text');
});

test('Wan advisory checks 10 ordered images, explicit input roles, cross-project assets and frozen hashes', () => {
  const p = provider(), selected = generationSelection([p], { connectionId }, shot), parameters = generationParameters(shot, selected.provider);
  const videoInput = input(), current = { ...shot, videoInput, parameters };
  assert.equal(generationInputIssueDescriptor(current, selected.provider, selected.model, assets, 'reference'), '');
  assert.equal(generationReferences(current).references.length, 10);
  const changedOrder = { ...current, videoInput: { ...videoInput, images: [...videoInput.images].reverse() } };
  assert.notEqual(generationReferenceIdentity(current, assets), generationReferenceIdentity(changedOrder, assets));
  for (const invalid of [input(11), { ...videoInput, images: [videoInput.images[0]!, videoInput.images[0]!] }, { ...videoInput, mode: 'first_last_frame' as const }]) assert.notEqual(generationInputIssueDescriptor({ ...current, videoInput: invalid }, selected.provider, selected.model, assets, 'reference'), '');
  assert.notEqual(generationInputIssueDescriptor(current, selected.provider, selected.model, assets.map((asset, index) => index ? asset : { ...asset, projectId: id(99) }), 'reference'), '');
  const frozen = { ...current, referenceAssets: assets.slice(0, 10).map(asset => ({ ...asset, role: 'reference_image' })) };
  assert.equal(generationInputIssueDescriptor(frozen, selected.provider, selected.model, assets, 'reference', { frozen: true }), '');
  assert.notEqual(generationInputIssueDescriptor(frozen, selected.provider, selected.model, assets.map((asset, index) => index ? asset : { ...asset, sha256: 'f'.repeat(64) }), 'reference', { frozen: true }), '');
});

test('actual App freezes all Wan input, sends it once and rejects review changes to prompt, order and parameters', async () => {
  const p = provider(), selected = generationSelection([p], { connectionId }, shot), videoInput = input(2), options = { connectionId, modelEntryId: selected.modelEntryId, videoInput, parameters: { durationSeconds: -1, aspectRatio: 'adaptive' } };
  const current = { ...shot, parameters: generationParameters(shot, selected.provider, options), videoInput };
  const source = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  for (const change of ['none', 'prompt', 'order', 'parameters', 'asset']) {
    const state = { review: null as Record<string, unknown> | null, sent: [] as unknown[] };
    const scope = { generationSelection, generationParameters, generationVideoInput, generationReferences, generationReferenceIdentity, generationProviderIdentity: (provider: GenerationProvider) => provider.connectionId || provider.id, generationProviderForModel: (provider: GenerationProvider) => provider, findGenerationProvider: () => selected.provider,
      providers: [p], dataRef: { current: { shots: [shot], assets: structuredClone(assets), jobs: [] } }, generationOptionsRef: { current: { [shot.id]: structuredClone(options) } }, realConfirmRef: { current: null }, generationReviewScope: { current: {} }, context: () => ({}), isCurrent: () => true,
      setRealConfirm: (value: Record<string, unknown>) => { state.review = value; }, notify() {}, msg: () => '', submitGeneration: (value: unknown) => state.sent.push(value) };
    const funcs = source.slice(source.indexOf('  function reviewGeneration('), source.indexOf('  async function createProject('));
    const api = lenientFunction(...Object.keys(scope), `${funcs}; return { reviewGeneration, confirmGeneration };`)(...Object.values(scope)) as { reviewGeneration(value: unknown): void; confirmGeneration(value: unknown): void };
    api.reviewGeneration({ shot: current, providerId: 'wan', connectionId, configurationRevision: 3, modelEntryId: selected.modelEntryId, model: selected.model, inputMode: 'reference' });
    if (change === 'prompt') scope.generationOptionsRef.current[shot.id]!.videoInput.prompt = 'Changed prompt';
    if (change === 'order') scope.generationOptionsRef.current[shot.id]!.videoInput.images.reverse();
    if (change === 'parameters') scope.generationOptionsRef.current[shot.id]!.parameters.durationSeconds = 5;
    if (change === 'asset') scope.dataRef.current.assets[0]!.sha256 = 'f'.repeat(64);
    const review = state.review; api.confirmGeneration(review); api.confirmGeneration(review);
    assert.equal(state.sent.length, change === 'none' ? 1 : 0, change);
  }
  const wires: Record<string, unknown>[] = [];
  const scope = { providers: [p], generationProviderForModel: () => selected.provider, findGenerationProvider: () => selected.provider, checkGeneration: () => true, captureTaskWorkspaceIntent: () => () => false, readTaskRevealContext: () => ({}), run: (_key: string, _operation: string, value: Record<string, unknown>) => { wires.push(value); return Promise.resolve(null); }, requestId: () => id(90) };
  const funcs = source.slice(source.indexOf('  const submitGeneration ='), source.indexOf('  function generate('));
  const submit = lenientFunction(...Object.keys(scope), `${funcs}; return submitGeneration;`)(...Object.values(scope)) as (value: unknown) => Promise<unknown>;
  await submit({ shot: current, providerId: 'wan', connectionId, configurationRevision: 3, modelEntryId: selected.modelEntryId, model: selected.model, inputMode: 'reference' });
  assert.deepEqual(wires[0]!.videoInput, videoInput); assert.deepEqual(wires[0]!.parameters, current.parameters);
});
