/** DL-b: speak-capable video models and how one shot's dialogue lines are
 * written into their prompt.
 *
 * Vendors expose no separate dialogue field: the lines go into the prompt, and
 * each official guide shows a different marking style. This module owns the
 * reviewed style per implemented adapter/model plus the native-audio switch the
 * adapter already understands. A model with no reviewed capability stays silent
 * (no dialogue is sent) instead of guessing a style.
 *
 * Everything here is pure: the business layer resolves shot rows and speaker
 * names, plans the exact final prompt, and freezes that raw text into the job
 * snapshot. A retry reuses the snapshot and never re-composes this text.
 */
import type {VideoExecutionBinding} from './video-providers.ts';

export const DIALOGUE_GENERATION_PROFILE_VERSION = 'mioon-dialogue-generation/1';

/** Reviewed prompt marking for dialogue lines. */
export const DIALOGUE_DELIVERY_STYLES = Object.freeze([
  'seedance-braces', 'wan-quotes', 'minimax-d-tags', 'kling-speaker', 'veo-speaker',
] as const);
export type DialogueDeliveryStyle = typeof DIALOGUE_DELIVERY_STYLES[number];

/** What the implemented adapter does with native audio for this exact model. */
export const DIALOGUE_AUDIO_MODES = Object.freeze(['always-on', 'request-switch', 'model-default'] as const);
export type DialogueAudioMode = typeof DIALOGUE_AUDIO_MODES[number];

export interface DialogueGenerationCapability {
  readonly profileVersion: typeof DIALOGUE_GENERATION_PROFILE_VERSION;
  readonly providerId: string;
  readonly templateId: string;
  readonly style: DialogueDeliveryStyle;
  readonly audioMode: DialogueAudioMode;
  /** Official documentation each rule is based on (README/report cross-check). */
  readonly docs: readonly string[];
}

/** One shot dialogue line with the speaker name already resolved. */
export interface DialoguePromptLine {
  readonly lineId: string;
  readonly text: string;
  /** Display name of a resolved `speakerSubjectId`; omitted when the line has no speaker. */
  readonly speakerName?: string;
}

const SEEDANCE_DOCS = Object.freeze([
  'https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh',
  'https://docs.volcengine.com/docs/ark/seedance-2-5-prompt-guide?lang=zh',
  'https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh',
]);
const WAN30_DOCS = Object.freeze([
  'https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference',
  'https://docs.modelstudio.console.alibabacloud.com/en/model-studio/wan3-video-generation-api-reference',
]);
const WAN27_DOCS = Object.freeze([
  'https://help.aliyun.com/zh/model-studio/text-to-video-api-reference',
  'https://help.aliyun.com/zh/model-studio/image-to-video-general-api-reference',
]);
const MINIMAX_DOCS = Object.freeze([
  'https://platform.minimax.io/docs/api-reference/video-generation-v2-create',
  'https://platform.minimax.cn/docs/api-reference/video-generation-v2-create',
]);
const KLING_DOCS = Object.freeze([
  'https://kling.ai/quickstart/klingai-video-3-model-user-guide',
  'https://kling.ai/document-api/apiReference/updateNotice',
]);
const VEO_DOCS = Object.freeze([
  'https://ai.google.dev/gemini-api/docs/omni',
  'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/video-gen-prompt-guide',
]);

/** The reviewed capability for one exact execution binding, or null when the
 * current adapter has no documented way to put dialogue into sound.
 *
 * The native-audio mode is read from the saved model entry (`on`/`optional`/
 * `off`/`default`): an entry saved silent never speaks, and `optional` is the
 * one mode the adapters expose as `parameters.generateAudio`. */
export function dialogueGenerationCapability(binding: Pick<VideoExecutionBinding, 'providerId' | 'model'>): DialogueGenerationCapability | null {
  const {providerId, model} = binding;
  const audio = model.audio;
  const capability = (templateId: string, style: DialogueDeliveryStyle, audioMode: DialogueAudioMode,
    docs: readonly string[]): DialogueGenerationCapability => ({profileVersion: DIALOGUE_GENERATION_PROFILE_VERSION,
      providerId, templateId, style, audioMode, docs});
  if (providerId === 'ark' && model.templateId === 'ark-v3' && audio !== 'off') {
    return capability('ark-v3', 'seedance-braces', audio === 'optional' ? 'request-switch' : 'always-on', SEEDANCE_DOCS);
  }
  if (providerId === 'kling' && model.templateId === 'kling-v1' && audio !== 'off') {
    return capability('kling-v1', 'kling-speaker', audio === 'optional' ? 'request-switch' : 'always-on', KLING_DOCS);
  }
  if (providerId === 'wan' && model.templateId === 'wan30-v1' && audio !== 'off') {
    return capability('wan30-v1', 'wan-quotes', audio === 'optional' ? 'request-switch' : 'always-on', WAN30_DOCS);
  }
  if (providerId === 'wan' && (model.templateId === 'wan27-t2v' || model.templateId === 'wan27-i2v')) {
    return capability(model.templateId, 'wan-quotes', 'model-default', WAN27_DOCS);
  }
  if (providerId === 'minimax' && model.templateId === 'minimax-v2') {
    return capability('minimax-v2', 'minimax-d-tags', 'model-default', MINIMAX_DOCS);
  }
  if (providerId === 'veo' && audio === 'on' && (model.templateId === 'gemini-omni-v1' || model.templateId === 'veo-v1')) {
    return capability(model.templateId, 'veo-speaker', 'always-on', VEO_DOCS);
  }
  return null;
}

/** One line exactly as the reviewed style writes it. A speaker name only comes
 * from a resolved subject; a line without one never invents a name. */
export function formatDialoguePromptLine(style: DialogueDeliveryStyle, line: DialoguePromptLine): string {
  const speaker = line.speakerName;
  switch (style) {
    case 'seedance-braces': return `{${speaker ? `${speaker}：` : ''}“${line.text}”}`;
    case 'wan-quotes': return speaker ? `${speaker}：“${line.text}”` : `“${line.text}”`;
    case 'minimax-d-tags': return speaker ? `${speaker}：<d>${line.text}</d>` : `<d>${line.text}</d>`;
    case 'kling-speaker': return speaker ? `${speaker}：${line.text}` : line.text;
    case 'veo-speaker': return speaker ? `${speaker}说：“${line.text}”` : `“${line.text}”`;
  }
}
/** The marked lines in order, one per dialogue row. */
export function formatDialoguePromptLines(style: DialogueDeliveryStyle, lines: readonly DialoguePromptLine[]): readonly string[] {
  return lines.map(line => formatDialoguePromptLine(style, line));
}
/** Final outgoing prompt: the saved shot prompt plus the marked lines. The exact
 * string is frozen into the job snapshot. */
export function composeDialoguePrompt(basePrompt: string, lines: readonly DialoguePromptLine[],
  style: DialogueDeliveryStyle): string {
  if (lines.length === 0) return basePrompt;
  const body = formatDialoguePromptLines(style, lines).join('\n');
  const head = basePrompt.trimEnd();
  return head.length === 0 ? body : `${head}\n${body}`;
}
/** Native-audio request field the implemented adapters understand. */
export function dialogueAudioRequest(capability: DialogueGenerationCapability): {readonly generateAudio: true} | null {
  return capability.audioMode === 'request-switch' ? {generateAudio: true} : null;
}
