import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createChainWorld} from './helpers/sequence-edit-double.ts';
import {dialogueGenerationCapability, composeDialoguePrompt} from '../packages/contracts/src/dialogue-generation.ts';
import type {DialoguePromptLine} from '../packages/contracts/src/dialogue-generation.ts';
import {defaultVideoModels, VIDEO_REGIONS} from '../packages/contracts/src/video-providers.ts';
import type {VideoExecutionBinding, VideoModelEntry} from '../packages/contracts/src/video-providers.ts';
import {
  assertFormat5DialogueSubmittable, format5DialogueView, freezeFormat5Dialogue, planDialogueGeneration,
  planFormat5DialogueGeneration, readFrozenFormat5Dialogue, FORMAT5_DIALOGUE_REASONS,
} from '../packages/business/src/format5-dialogue-generation.ts';
import {readFormat5GenerationInputView} from '../packages/business/src/format5-reference-inputs.ts';
import {LOCALES, translate} from '../packages/i18n/src/index.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const projectId = '90000000-0000-4000-8000-000000000001';
const shotId = '90000000-0000-4000-8000-000000000010';
const assetId = '90000000-0000-4000-8000-000000000050';
const at = '2026-01-01T00:00:00.000Z';
const uuid = (): string => crypto.randomUUID();

let serial = 0;
function bindingFor(providerId: string, patch: Partial<VideoModelEntry> = {}): VideoExecutionBinding {
  const defaults = defaultVideoModels(providerId as never);
  const fallback: VideoModelEntry = {id: uuid(), name: 'custom', modelId: 'custom-video', templateId: 'openai-video-v1',
    enabled: true, archived: false, inputModes: ['text'], aspectRatios: ['9:16'],
    durationResolutionMap: [{duration: [4], resolution: ['720p']}], audio: 'default', seed: false};
  const model = {...(defaults[0] ?? fallback), ...patch};
  serial++;
  return {version: 1, connectionId: uuid(), configurationRevision: 1, providerId, region: VIDEO_REGIONS[providerId as never][0]!,
    workspaceId: '', endpoint: 'https://example.com', credentialRef: uuid(), model: {...model, id: uuid()},
    outputHosts: []} as unknown as VideoExecutionBinding;
}

const lines: readonly DialoguePromptLine[] = Object.freeze([
  {lineId: 'line-1', text: '你好，我们走吧。', speakerName: '张三'},
  {lineId: 'line-2', text: '好，走吧。', speakerName: '李四'},
  {lineId: 'line-3', text: '外面风很大。'},
]);
const base = '两个人在海边散步。';

const speaking = (): {name: string; binding: () => VideoExecutionBinding; style: string; audioMode: string}[] => [
  {name: 'seedance optional', binding: () => bindingFor('ark'), style: 'seedance-braces', audioMode: 'request-switch'},
  {name: 'seedance on', binding: () => bindingFor('ark', {audio: 'on'}), style: 'seedance-braces', audioMode: 'always-on'},
  {name: 'wan 3.0 optional', binding: () => bindingFor('wan', {templateId: 'wan30-v1', modelId: 'wan3.0-video', audio: 'optional'}), style: 'wan-quotes', audioMode: 'request-switch'},
  {name: 'wan 2.7 default', binding: () => bindingFor('wan', {templateId: 'wan27-t2v', modelId: 'wan2.7-t2v'}), style: 'wan-quotes', audioMode: 'model-default'},
  {name: 'minimax H3 default', binding: () => bindingFor('minimax'), style: 'minimax-d-tags', audioMode: 'model-default'},
  {name: 'kling optional', binding: () => bindingFor('kling', {audio: 'optional'}), style: 'kling-speaker', audioMode: 'request-switch'},
  {name: 'kling on', binding: () => bindingFor('kling', {audio: 'on'}), style: 'kling-speaker', audioMode: 'always-on'},
  {name: 'veo omni always-on', binding: () => bindingFor('veo'), style: 'veo-speaker', audioMode: 'always-on'},
];

test('each speaking service writes the reviewed prompt style and audio mode', () => {
  for (const entry of speaking()) {
    const capability = dialogueGenerationCapability(entry.binding());
    assert.ok(capability, entry.name);
    assert.equal(capability!.style, entry.style, entry.name);
    assert.equal(capability!.audioMode, entry.audioMode, entry.name);
    assert.ok(capability!.docs.length > 0, `${entry.name} cites official docs`);
    assert.ok(capability!.docs.every(doc => doc.startsWith('https://')), entry.name);
  }
});

test('each speaking style has an exact frozen snapshot (two speakers, one unnamed)', () => {
  const expected: Record<string, string> = {
    'seedance-braces': `${base}\n{张三：“你好，我们走吧。”}\n{李四：“好，走吧。”}\n{“外面风很大。”}`,
    'wan-quotes': `${base}\n张三：“你好，我们走吧。”\n李四：“好，走吧。”\n“外面风很大。”`,
    'minimax-d-tags': `${base}\n张三：<d>你好，我们走吧。</d>\n李四：<d>好，走吧。</d>\n<d>外面风很大。</d>`,
    'kling-speaker': `${base}\n张三：你好，我们走吧。\n李四：好，走吧。\n外面风很大。`,
    'veo-speaker': `${base}\n张三说：“你好，我们走吧。”\n李四说：“好，走吧。”\n“外面风很大。”`,
  };
  for (const entry of speaking()) {
    const capability = dialogueGenerationCapability(entry.binding())!;
    assert.equal(composeDialoguePrompt(base, lines, capability.style), expected[capability.style], entry.name);
  }
});

test('services without a reviewed speaking capability never receive dialogue', () => {
  for (const providerId of ['vidu', 'runway', 'compatible']) {
    assert.equal(dialogueGenerationCapability(bindingFor(providerId)), null, providerId);
  }
  assert.equal(dialogueGenerationCapability({...bindingFor('ark'), model: {...bindingFor('ark').model, audio: 'off'}}), null,
    'a saved silent model entry does not speak');
});


test('the planner freezes the exact prompt and keeps a silent service unchanged', (t) => {
  const promptLines = lines;
  const used = planDialogueGeneration({shotId, shotRevision: 3, lines: promptLines, basePrompt: base,
    binding: bindingFor('ark')});
  assert.equal(used.status, 'used');
  assert.equal(used.prompt, `${base}\n{张三：“你好，我们走吧。”}\n{李四：“好，走吧。”}\n{“外面风很大。”}`);
  assert.deepEqual(used.audioRequest, {generateAudio: true});
  const frozen = freezeFormat5Dialogue(used);
  assert.deepEqual(readFrozenFormat5Dialogue({format5Dialogue: frozen}), frozen);
  assert.equal(readFrozenFormat5Dialogue({}), null, 'format 3/4 snapshots carry no dialogue freeze');
  const view = format5DialogueView(used);
  assert.equal(view.status, 'used');
  assert.equal(view.lineCount, 3);
  assert.equal(view.promptCodeUnits, used.prompt.length);
  assert.equal(view.style, 'seedance-braces');
  assert.ok(view.docs && view.docs.length > 0);
  assert.equal(assertFormat5DialogueSubmittable(used), undefined, 'a used plan is submittable');

  const silent = planDialogueGeneration({shotId, shotRevision: 3, lines: promptLines, basePrompt: base,
    binding: bindingFor('vidu')});
  assert.equal(silent.status, 'unsupported');
  assert.equal(silent.reason, FORMAT5_DIALOGUE_REASONS.serviceDoesNotSpeak);
  assert.equal(silent.prompt, base, 'unsupported services send the original prompt unchanged');
  assert.equal(silent.audioRequest, null);
  assert.equal(format5DialogueView(silent).reason, 'SERVICE_DOES_NOT_SPEAK');
  assert.equal(assertFormat5DialogueSubmittable(silent), undefined, 'an unsupported service still generates without dialogue');

  const noService = planDialogueGeneration({shotId, shotRevision: 3, lines: promptLines, basePrompt: base});
  assert.equal(noService.status, 'unsupported');
  assert.equal(noService.reason, FORMAT5_DIALOGUE_REASONS.serviceNotSelected);
  assert.equal(noService.prompt, base);

  // The store wrapper reads the live shot row; a shot without lines contributes nothing.
  const versionId = uuid(), assetA = uuid(), rootId = uuid();
  const world = createChainWorld(t, {rootId, shots: [{id: shotId, title: 'A', versionId}],
    versions: [{versionId, assetId: assetA, sha256: 'a'.repeat(64), durationSeconds: 2}],
    edges: [{id: uuid(), fromId: rootId, toId: shotId}],
    clips: [{nodeId: shotId, clipId: uuid(), startFrame: 0, durationFrames: 60, versionId}]} as never);
  const empty = planFormat5DialogueGeneration(world.store, shotId, {binding: bindingFor('ark'), basePrompt: base});
  assert.equal(empty.status, 'used');
  assert.equal(empty.lines.length, 0);
  assert.equal(empty.prompt, base, 'no dialogue lines means no prompt change');
  assert.equal(empty.audioRequest, null, 'no dialogue lines means no native-audio switch');
  const readView = readFormat5GenerationInputView(world.store, shotId, {binding: bindingFor('ark')});
  assert.equal(readView.dialogue.status, 'used');
  assert.equal(readView.dialogue.lineCount, 0);
});

test('a prompt that cannot fit the dialogue is rejected whole, never truncated', () => {
  const longLines = [{lineId: 'line-1', text: '台词很长。'.repeat(3)}];
  // MiniMax-H3 reports a 1000 UTF-16 code-unit prompt limit in the input profile.
  const plan = planDialogueGeneration({shotId, shotRevision: 1, lines: longLines, basePrompt: '海'.repeat(990),
    binding: bindingFor('minimax')});
  assert.equal(plan.status, 'rejected');
  assert.equal(plan.reason, FORMAT5_DIALOGUE_REASONS.promptTooLong);
  assert.ok(plan.promptCodeUnits > plan.maxPromptCodeUnits);
  assert.equal(plan.maxPromptCodeUnits, 1000);
  assert.ok(plan.prompt.endsWith('<d>台词很长。台词很长。台词很长。</d>'),
    'the dialogue is kept whole in the rejected plan text');
  assert.equal(plan.audioRequest, null);
  assert.throws(() => assertFormat5DialogueSubmittable(plan), (error: {code?: string}) => error.code === 'DIALOGUE_PROMPT_TOO_LONG');
  const view = format5DialogueView(plan);
  assert.equal(view.status, 'rejected');
  assert.equal(view.reason, 'PROMPT_TOO_LONG');
});

test('consecutive speaking providers keep the second unspoken silently', () => {
  // Kling's saved default entry is silent; it only speaks when the entry is on/optional.
  const klingOff = bindingFor('kling');
  assert.equal(dialogueGenerationCapability(klingOff), null);
  const capability = dialogueGenerationCapability(bindingFor('kling', {audio: 'on'}));
  assert.ok(capability);
  assert.equal(capability!.audioMode, 'always-on');
});

test('the read-only projection and the dialogue panel share the same status', () => {
  const app = readFileSync(path.join(root, 'apps/web/src/App.tsx'), 'utf8');
  const panel = readFileSync(path.join(root, 'apps/web/src/ShotDialogue.tsx'), 'utf8');
  assert.match(app, /dialogueStatus=\{format5Inputs && format5Inputs\.shotId === chosenShot\.id \? format5Inputs\.dialogue : null\}/);
  assert.match(panel, /shot-dialogue-generation-unsupported/);
  assert.match(panel, /shot-dialogue-generation-rejected/);
  assert.match(panel, /SERVICE_DOES_NOT_SPEAK/);
  assert.match(panel, /PROMPT_TOO_LONG/);
  for (const locale of LOCALES) {
    assert.ok(translate(locale, 'dialogue.ui.generationUnsupported' as never).length > 0);
    assert.ok(translate(locale, 'dialogue.ui.generationPromptTooLong' as never).length > 0);
  }
  assert.equal(translate('zh-Hans', 'dialogue.ui.generationUnsupported' as never), '当前服务不支持');
});

test('submit freezes the exact dialogue prompt in the job snapshot and rejects before writing', () => {
  const services = readFileSync(path.join(root, 'packages/business/src/services.ts'), 'utf8');
  assert.match(services, /format5Dialogue=planFormat5DialogueGeneration\(store,shot\.id/);
  assert.match(services, /assertFormat5DialogueSubmittable\(format5Dialogue\)/);
  assert.match(services, /format5Dialogue:freezeFormat5Dialogue\(format5Dialogue\)/);
  assert.match(services, /\{prompt:format5Dialogue\.prompt\}/, 'the frozen adapter prompt is the final text');
  assert.match(services, /parameters=\{\.\.\.recordValue\(parameters\),\.\.\.format5Dialogue\.audioRequest\}/);
  // A retry uses the stored snapshot as the source and never re-composes a prompt.
  assert.match(services, /retrySnapshot\?\?\{/);
  assert.doesNotMatch(services, /retrySnapshot\)\{[^}]*planFormat5DialogueGeneration/);
});
