import test from 'node:test';
import assert from 'node:assert/strict';
import { generationSelection, generationInputIssue, providerAvailabilityIssue, providerStatus, providerStatusLabel, providerModels } from '../apps/web/src/generation-settings.ts';
import { getGenerationIssue } from '@mioon/contracts';

const image = { id: 'image-a', mimeType: 'image/png', width: 720, height: 1280 };
const imageModel = { id: 'image-model', name: 'Image Model', inputModes: ['image'], aspectRatios: ['9:16'], durations: [4], referenceImages: { min: 1, max: 1, mimeTypes: ['image/png'], matchAspectRatio: true }, promptRequired: true, maxPromptLength: 500, parameters: ['seed'], seed: { min: 0, max: 100 } };
const textModel = { id: 'text-model', name: 'Text Model', inputModes: ['text'], aspectRatios: ['16:9'], durations: [8], referenceImages: { min: 0, max: 0 }, parameters: [] };
const provider = { id: 'new-provider', name: 'Future provider', enabled: true, configured: true, status: 'available', models: ['image-model', 'text-model'], inputModes: ['image', 'text'], aspectRatios: ['9:16', '16:9'], durations: [4, 8], modelCapabilities: [imageModel, textModel] };
const shot = { prompt: 'A quiet sunrise', referenceAssetIds: [image.id], aspectRatio: '9:16', duration: 4, parameters: {} };

test('renderer uses selected model limits rather than union provider limits', () => {
  const selected = generationSelection([provider], { providerId: provider.id, model: 'image-model' }, shot);
  assert.equal(selected.capabilities, imageModel);
  const incompatible = { ...shot, duration: 8 };
  assert.equal(generationInputIssue(incompatible, provider, selected.model, [image], 'image'), getGenerationIssue({ ...incompatible, model: selected.model, referenceAssets: [image] }, provider).message);
  assert.equal(generationInputIssue(shot, provider, selected.model, [image], 'image'), '');
});

test('changing provider or model never silently discards an existing image', () => {
  const original = structuredClone(shot);
  const selected = generationSelection([provider], { providerId: provider.id, model: 'text-model', inputMode: 'text' }, shot);
  assert.equal(selected.inputMode, 'image');
  assert.deepEqual(shot, original);
  assert.match(generationInputIssue({ ...shot, aspectRatio: '16:9', duration: 8 }, provider, selected.model, [image], selected.inputMode), /不支持参考图/);
});

test('text mode is inferred from zero references, while explicit empty image mode blocks', () => {
  const dual = { ...provider, modelCapabilities: [{ ...textModel, inputModes: ['text', 'image'], referenceImages: { min: 0, max: 1 } }] };
  const text = { ...shot, referenceAssetIds: [], aspectRatio: '16:9', duration: 8 };
  assert.equal(generationSelection([dual], { model: 'text-model' }, text).inputMode, 'text');
  assert.equal(generationInputIssue(text, dual, 'text-model', [image], 'text'), '');
  assert.match(generationInputIssue(text, dual, 'text-model', [image], 'image'), /选择一张首帧参考图/);
});

test('missing references, image metadata, prompt and seed limits share backend checks', () => {
  assert.match(generationInputIssue(shot, provider, imageModel.id, [], 'image'), /已不存在/);
  for (const [draft, assets] of [
    [{ ...shot, prompt: '' }, [image]],
    [{ ...shot, parameters: { seed: 101 } }, [image]],
    [shot, [{ ...image, mimeType: 'image/webp' }]],
    [shot, [{ ...image, width: 360, height: 480 }]],
  ]) assert.equal(generationInputIssue(draft, provider, imageModel.id, assets, 'image'), getGenerationIssue({ ...draft, model: imageModel.id, referenceAssets: assets }, provider).message);
});

test('unknown selected provider/model blocks rather than falling back to another service', () => {
  const unknown = generationSelection([provider], { providerId: 'removed-provider' }, shot);
  assert.equal(unknown.provider, undefined);
  assert.match(providerAvailabilityIssue(unknown.provider), /未找到/);
  const stale = generationSelection([provider], { providerId: provider.id, model: 'removed-model' }, shot);
  assert.equal(stale.model, 'removed-model');
  assert.equal(stale.capabilities, null);
  assert.match(generationInputIssue(shot, provider, stale.model, [image], 'image'), /不支持所选模型/);
});

test('status reporting distinguishes disabled, incomplete, and available without secret values', () => {
  for (const [status, label] of [['available', '可用'], ['disabled', '未启用'], ['not_configured', '配置未完成']]) {
    const item = { ...provider, status };
    assert.equal(providerStatus(item), status);
    assert.equal(providerStatusLabel(item), label);
    assert.equal(Boolean(providerAvailabilityIssue(item)), status !== 'available');
  }
  assert.equal(providerModels(provider)[1].id, 'text-model');
});

test('capabilities and shot parameters stay separate from the scalar selection map', () => {
  const options = { providerId: provider.id, model: imageModel.id, scenario: 'success' };
  const before = structuredClone(options);
  generationSelection([provider], options, shot);
  assert.deepEqual(options, before);
  assert.deepEqual(shot.parameters, {});
});

test('output shape review is distinct from user cancellation and never suggests a retry', async () => {
  const { outputReviewRequired, jobStatusText, outputReviewMessage } = await import('../apps/web/src/api.ts');
  const job = { status: 'cancelled', phase: 'output_review_required', cancelScope: 'local_only', error: { code: 'OUTPUT_ASPECT_RATIO_MISMATCH' } };
  assert.equal(outputReviewRequired(job), true);
  assert.equal(jobStatusText(job), '输出待核验');
  assert.equal(jobStatusText({ status: 'cancelled', phase: 'cancelled' }), '已停止');
  assert.match(outputReviewMessage, /服务商已完成生成/);
  assert.match(outputReviewMessage, /核对并恢复同一任务/);
  assert.match(outputReviewMessage, /不会自动重新生成/);
});
