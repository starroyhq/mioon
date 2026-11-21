import test from 'node:test';
import assert from 'node:assert/strict';
import {createChainWorld} from './helpers/sequence-edit-double.ts';
import {
  dialogueGenerationCapability, composeDialoguePrompt, formatDialoguePromptLine,
} from '../packages/contracts/src/dialogue-generation.ts';
import type {DialoguePromptLine} from '../packages/contracts/src/dialogue-generation.ts';
import {defaultVideoModels, VIDEO_REGIONS} from '../packages/contracts/src/video-providers.ts';
import type {VideoExecutionBinding, VideoModelEntry} from '../packages/contracts/src/video-providers.ts';
import {
  assertFormat5DialogueSubmittable, format5DialogueView, freezeFormat5Dialogue, planDialogueGeneration,
  planFormat5DialogueGeneration, readFrozenFormat5Dialogue, FORMAT5_DIALOGUE_REASONS,
} from '../packages/business/src/format5-dialogue-generation.ts';
import {readFormat5GenerationInputView} from '../packages/business/src/format5-reference-inputs.ts';
import {defaultGenerateAudio, shotHasDialogue} from '../apps/web/src/generation-settings.ts';

const shotId = '90000000-0000-4000-8000-000000000010';

function bindingFor(providerId: string, patch: Partial<VideoModelEntry> = {}): VideoExecutionBinding {
  const defaults = defaultVideoModels(providerId as never);
  const fallback: VideoModelEntry = {id: crypto.randomUUID(), name: 'custom', modelId: 'custom-video', templateId: 'openai-video-v1',
    enabled: true, archived: false, inputModes: ['text'], aspectRatios: ['9:16'],
    durationResolutionMap: [{duration: [4], resolution: ['720p']}], audio: 'default', seed: false};
  const model = {...(defaults[0] ?? fallback), ...patch};
  return {version: 1, connectionId: crypto.randomUUID(), configurationRevision: 1, providerId,
    region: VIDEO_REGIONS[providerId as never][0]!, workspaceId: '', endpoint: 'https://example.com',
    credentialRef: crypto.randomUUID(), model: {...model, id: crypto.randomUUID()},
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

test('a line or speaker name cannot break its own style markup (raw lines stay frozen)', () => {
  const markers: Record<string, {text: string; speaker: string; prompt: string}> = {
    'seedance-braces': {text: '{台词}', speaker: '张{三}',
      prompt: '{张（三）：“（台词）”}'},
    'wan-quotes': {text: '“台词”', speaker: '张“三”',
      prompt: '张「三」：“「台词」”'},
    'minimax-d-tags': {text: '<d>台词</d>', speaker: '张<三>',
      prompt: '张＜三＞：<d>台词</d>'},
    'kling-speaker': {text: '台词：内容', speaker: '张：三',
      prompt: '张:三：台词：内容'},
    'veo-speaker': {text: '“台词”', speaker: '张“三”',
      prompt: '张「三」说：“「台词」”'},
  };
  for (const [style, marker] of Object.entries(markers)) {
    const line = {lineId: 'line-1', text: marker.text, speakerName: marker.speaker};
    assert.equal(formatDialoguePromptLine(style as never, line), marker.prompt, style);
  }
  // The freeze keeps the user's original text; only the prompt is sanitized.
  const plan = planDialogueGeneration({shotId, shotRevision: 1,
    lines: [{lineId: 'line-1', text: '{台词}', speakerName: '张{三}'}], basePrompt: base, binding: bindingFor('ark')});
  assert.equal(plan.lines[0]!.text, '{台词}');
  assert.equal(plan.lines[0]!.speakerName, '张{三}');
  assert.equal(plan.prompt, `${base}\n{张（三）：“（台词）”}`);
});

test('the optional sound switch follows the request, then the dialogue default', () => {
  const seedance = bindingFor('ark');
  const defaulted = planDialogueGeneration({shotId, shotRevision: 1, lines, basePrompt: base, binding: seedance});
  assert.equal(defaulted.status, 'used', 'a shot with dialogue defaults native sound on');
  assert.equal(defaulted.generateAudio, true);
  assert.deepEqual(defaulted.audioRequest, {generateAudio: true});
  assert.equal(freezeFormat5Dialogue(defaulted).generateAudio, true);

  const manualOff = planDialogueGeneration({shotId, shotRevision: 1, lines, basePrompt: base,
    binding: seedance, generateAudio: false});
  assert.equal(manualOff.status, 'unsupported');
  assert.equal(manualOff.reason, FORMAT5_DIALOGUE_REASONS.audioOff);
  assert.equal(manualOff.prompt, base, 'a manually muted generation sends no dialogue');
  assert.equal(manualOff.audioRequest, null);
  assert.equal(manualOff.generateAudio, false);
  assert.equal(freezeFormat5Dialogue(manualOff).generateAudio, false);
  assert.equal(format5DialogueView(manualOff).reason, 'AUDIO_OFF');
  assert.doesNotThrow(() => assertFormat5DialogueSubmittable(manualOff), 'muted dialogue still generates without sound');

  const manualOn = planDialogueGeneration({shotId, shotRevision: 1, lines, basePrompt: base,
    binding: seedance, generateAudio: true});
  assert.equal(manualOn.status, 'used');
  assert.equal(manualOn.generateAudio, true);
  assert.deepEqual(manualOn.audioRequest, {generateAudio: true});

  // Mio does not send the switch: the same dialogue default applies.
  const mio = planDialogueGeneration({shotId, shotRevision: 1, lines, basePrompt: base, binding: seedance});
  assert.equal(mio.generateAudio, true);
  assert.match(mio.prompt, /\{张三：“你好，我们走吧。”\}/u);

  // No dialogue: an absent switch stays at the model default (seedance off).
  const empty = planDialogueGeneration({shotId, shotRevision: 1, lines: [], basePrompt: base, binding: seedance});
  assert.equal(empty.status, 'used');
  assert.equal(empty.generateAudio, false);
  assert.equal(empty.audioRequest, null);
});

test('the shared UI default opens "生成声音" for an optional model with dialogue', () => {
  const withDialogue = {id: 'shot', dialogue: [{id: 'line-1', text: '你好。'}]};
  assert.equal(shotHasDialogue(withDialogue), true);
  assert.equal(shotHasDialogue({id: 'shot'}), false);
  assert.deepEqual(defaultGenerateAudio(withDialogue as never, {audio: 'optional'}, {}), {generateAudio: true},
    'the checkbox and the request share this default');
  assert.deepEqual(defaultGenerateAudio(withDialogue as never, {audio: 'optional'}, {generateAudio: false}),
    {generateAudio: false}, 'an explicit user choice wins');
  assert.deepEqual(defaultGenerateAudio({id: 'shot'} as never, {audio: 'optional'}, {}), {},
    'a shot without dialogue keeps the model default');
  assert.deepEqual(defaultGenerateAudio(withDialogue as never, {audio: 'off'}, {}), {},
    'a silent model entry never defaults sound on');
});

test('a service without a reviewed speaking capability or no service sends no dialogue', () => {
  for (const providerId of ['vidu', 'runway', 'compatible']) {
    assert.equal(dialogueGenerationCapability(bindingFor(providerId)), null, providerId);
  }
  assert.equal(dialogueGenerationCapability({...bindingFor('ark'), model: {...bindingFor('ark').model, audio: 'off'}}), null,
    'a saved silent model entry does not speak');
  const silent = planDialogueGeneration({shotId, shotRevision: 1, lines, basePrompt: base, binding: bindingFor('vidu')});
  assert.equal(silent.status, 'unsupported');
  assert.equal(silent.reason, FORMAT5_DIALOGUE_REASONS.serviceDoesNotSpeak);
  assert.equal(silent.prompt, base);
  const noService = planDialogueGeneration({shotId, shotRevision: 1, lines, basePrompt: base});
  assert.equal(noService.status, 'unsupported');
  assert.equal(noService.reason, FORMAT5_DIALOGUE_REASONS.serviceNotSelected);
  assert.equal(noService.prompt, base);
  const klingOff = bindingFor('kling');
  assert.equal(dialogueGenerationCapability(klingOff), null);
});

test('only dialogue-caused overflow is a dialogue rejection', () => {
  const longLines = [{lineId: 'line-1', text: '台词很长。'.repeat(3)}];
  // MiniMax-H3 reports a 1000 UTF-16 code-unit prompt limit in the input profile.
  const dialogueCaused = planDialogueGeneration({shotId, shotRevision: 1, lines: longLines, basePrompt: '海'.repeat(980),
    binding: bindingFor('minimax')});
  assert.equal(dialogueCaused.status, 'rejected');
  assert.equal(dialogueCaused.reason, FORMAT5_DIALOGUE_REASONS.promptTooLong);
  assert.ok(dialogueCaused.promptCodeUnits > dialogueCaused.maxPromptCodeUnits);
  assert.equal(dialogueCaused.maxPromptCodeUnits, 1000);
  assert.ok(dialogueCaused.prompt.endsWith('<d>台词很长。台词很长。台词很长。</d>'),
    'the dialogue is kept whole in the rejected plan text');
  assert.equal(dialogueCaused.audioRequest, null);
  assert.throws(() => assertFormat5DialogueSubmittable(dialogueCaused),
    (error: {code?: string}) => error.code === 'DIALOGUE_PROMPT_TOO_LONG');
  assert.equal(format5DialogueView(dialogueCaused).reason, 'PROMPT_TOO_LONG');

  // The original prompt is already too long: the existing prompt validation owns
  // that error, not the dialogue plan.
  const baseTooLong = planDialogueGeneration({shotId, shotRevision: 1, lines: longLines, basePrompt: '海'.repeat(1005),
    binding: bindingFor('minimax')});
  assert.notEqual(baseTooLong.status, 'rejected');
  assert.equal(baseTooLong.prompt, '海'.repeat(1005), 'no dialogue is appended when the original prompt is invalid');
  assert.equal(assertFormat5DialogueSubmittable(baseTooLong), undefined);

  // No dialogue at all never produces a dialogue rejection.
  const noLines = planDialogueGeneration({shotId, shotRevision: 1, lines: [], basePrompt: '海'.repeat(1005),
    binding: bindingFor('minimax')});
  assert.equal(noLines.status, 'used');
  assert.equal(noLines.promptCodeUnits, 1005);
});

test('the store wrapper and read-only projection use the same plan', (t) => {
  const versionId = crypto.randomUUID(), assetA = crypto.randomUUID(), rootId = crypto.randomUUID();
  const world = createChainWorld(t, {rootId, shots: [{id: shotId, title: 'A', versionId}],
    versions: [{versionId, assetId: assetA, sha256: 'a'.repeat(64), durationSeconds: 2}],
    edges: [{id: crypto.randomUUID(), fromId: rootId, toId: shotId}],
    clips: [{nodeId: shotId, clipId: crypto.randomUUID(), startFrame: 0, durationFrames: 60, versionId}]} as never);
  const empty = planFormat5DialogueGeneration(world.store, shotId, {binding: bindingFor('ark'), basePrompt: base});
  assert.equal(empty.status, 'used');
  assert.equal(empty.lines.length, 0);
  assert.equal(empty.prompt, base);
  const readView = readFormat5GenerationInputView(world.store, shotId, {binding: bindingFor('ark')});
  assert.equal(readView.dialogue.status, 'used');
  assert.equal(readView.dialogue.lineCount, 0);
});

test('a selected legacy Mock service reports the unsupported-service reason, not "no service"', () => {
  const mock = planDialogueGeneration({shotId, shotRevision: 1, lines: [], basePrompt: base,
    legacyService: {providerId: 'mock'}});
  assert.equal(mock.status, 'unsupported');
  assert.equal(mock.reason, FORMAT5_DIALOGUE_REASONS.serviceDoesNotSpeak);
  assert.equal(mock.prompt, base);
  assert.equal(format5DialogueView(mock).reason, 'SERVICE_DOES_NOT_SPEAK');
  const noService = planDialogueGeneration({shotId, shotRevision: 1, lines: [], basePrompt: base});
  assert.equal(noService.reason, FORMAT5_DIALOGUE_REASONS.serviceNotSelected);
});
